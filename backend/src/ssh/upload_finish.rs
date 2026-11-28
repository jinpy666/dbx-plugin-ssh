use super::transfer_paths::{commit_remote_file, remote_transfer_paths};
use super::upload_meta::remove_upload_meta;
use super::*;

impl SshRuntime {
    /// `sftp/upload/finish`: the spool holds the complete file, so hand the
    /// remote push to a background task on the shared runtime and return at
    /// once. Holding this RPC open for the whole push used to expose every
    /// multi-GB upload to RPC deadlines anywhere on the bridge (host,
    /// workbench, sidecar): once the deadline fired the upload was cancelled
    /// mid-flight even though nothing was wrong (issue #60). The background
    /// task reports exclusively through `sftp/transfer/progress` events, which
    /// no deadline can kill; `phase: "uploading"` marks its events.
    pub async fn finish_upload(
        self: &Arc<Self>,
        task_id: &str,
        encoding: NameEncoding,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let upload = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .remove(task_id)
            .ok_or("Upload task was not found")?;
        if upload.received != upload.expected_size {
            // Keep the spool + meta: the received prefix stays resumable via
            // `sftp/upload/start` with `resumeTaskId`.
            let error = format!(
                "Upload is incomplete: expected {}, received {}",
                upload.expected_size, upload.received
            );
            // The task dies here without reaching the commit path, so the
            // failure is recorded explicitly (same ledger entry a failed
            // commit writes).
            self.record_transfer(json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.expected_size, "transferred": upload.received, "status": "failed", "error": error }));
            return Err(error);
        }
        let UploadState {
            session_id,
            remote_path,
            expected_size,
            received: _,
            local_path,
            file,
            progress_throttle: _,
            compression,
            sudo_lane,
            lzpack_explicit,
        } = upload;
        drop(file);
        // sudo 车道（UploadSudo）：注册前先解析登录用户 home 并定死暂存
        // 路径——取消收尾也要用它。home 探测失败即整体失败，任务不进注册
        // 表，前端收到同步错误。
        let sudo_staging = if sudo_lane {
            let home = self.sftp_home(&session_id).await?;
            Some(format!(
                "{}/{}",
                home.trim_end_matches('/'),
                sudo_upload_staging_name(task_id)
            ))
        } else {
            None
        };
        let transferred_bytes = Arc::new(AtomicU64::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_reason = Arc::new(Mutex::new(None::<String>));
        self.finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .insert(
                task_id.to_string(),
                FinishingUpload {
                    session_id: session_id.clone(),
                    remote_path: remote_path.clone(),
                    size: expected_size,
                    transferred: transferred_bytes.clone(),
                    cancelled: cancelled.clone(),
                    cancel_reason: cancel_reason.clone(),
                    compression,
                    sudo_staging: sudo_staging.clone(),
                    lzpack_explicit,
                },
            );
        let this = self.clone();
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        let response_task_id = task_id.clone();
        // 实际送达通道（M33）：决策 gzip 但预压不划算/推送或远端解压失败回退
        // 时降级 none——终态与普通推送段的事件据此回传，前端徽标随之清除。
        let mut served_compression = compression;
        tokio::spawn(async move {
            // 网络腿观测起点（ST8）：压缩预压计入 CPU 段，不回灌带宽模型；
            // 推送完成时以 expected_size/耗时回灌该连接的上传 EMA。
            let network_started = std::time::Instant::now();
            let result: Result<(), String> = async {
                // 压缩通道预压（M33）：spool → `<spool>.gz`。取消即中止；
                // 压缩失败或比率不划算回落普通推送（原始 spool 语义不变）。
                // latin-1 裸包车道不参与——决策处已排除，此处双保险：raw
                // 推送永远推原始 spool 字节。
                let mut gz_local: Option<(PathBuf, u64)> = None;
                if compression == CompressionMode::Gzip && encoding != NameEncoding::Latin1 {
                    match Self::compress_upload_spool(
                        &local_path,
                        expected_size,
                        &task_id,
                        &session_id,
                        &cancelled,
                        &cancel_reason,
                        &emitter,
                    )
                    .await
                    {
                        SpoolCompression::Done(path, size) => gz_local = Some((path, size)),
                        SpoolCompression::Cancelled(error) => return Err(error),
                        SpoolCompression::NotWorthwhile => {
                            served_compression = CompressionMode::None;
                            eprintln!(
                                "[sftp] upload {task_id} compression not worthwhile, plain push"
                            );
                        }
                        SpoolCompression::Failed(error) => {
                            served_compression = CompressionMode::None;
                            eprintln!(
                                "[sftp] upload {task_id} compress failed, plain push: {error}"
                            );
                        }
                    }
                }
                // latin-1（M16）：上传族的远端路径是「wire 目录前缀 + 用户新
                // 输入的显示末段」，write_path_bytes 还原为服务器字节后走裸包
                // 暂存 + 原子提交。裸包客户端**建立**失败回退高层路径（此时
                // 远端尚无任何动作）；操作发出后的失败原样上抛，不回退。
                // sudo 车道不进裸包快路：暂存件落在登录用户 home（ASCII 路
                // 径，高层客户端无碍），最终提交本就要经 exec sudo mv。
                if encoding == NameEncoding::Latin1 && sudo_staging.is_none() {
                    match this.raw_sftp_client(&session_id).await {
                        Ok(mut client) => {
                            // 进度事件时间窗节流（progress_throttle）：每
                            // 256KiB 一条 IPC 事件在 1GB 上传时约 200 条/秒；
                            // 末块（bytes 达到声明总量）必发保证终值，终态
                            // 事件由循环外 completed 照常无条件发射。
                            let mut progress_throttle =
                                crate::progress_throttle::ProgressThrottle::default();
                            let progress = |bytes: u64| {
                                transferred_bytes.store(bytes, Ordering::Release);
                                if !progress_throttle
                                    .should_emit(expected_size > 0 && bytes >= expected_size)
                                {
                                    return Ok(());
                                }
                                emitter
                                    .event(
                                        "sftp/transfer/progress",
                                        upload_progress_payload(
                                            &task_id,
                                            &session_id,
                                            None,
                                            bytes,
                                            expected_size,
                                            UploadPhase::Uploading,
                                            "running",
                                            compression,
                                        ),
                                    )
                                    .map_err(plugin_error)
                            };
                            return sftp_ext::raw_push_upload_file(
                                &mut client,
                                &local_path,
                                &remote_path,
                                &task_id,
                                sftp_ext::RawUploadContext {
                                    cancelled: &cancelled,
                                    cancel_reason: &cancel_reason,
                                    progress: Box::new(progress),
                                },
                            )
                            .await;
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh-sftp-plugin] raw byte upload unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = this.sftp(&session_id).await?;
                let (temporary, backup) = remote_transfer_paths(&remote_path, &task_id)?;
                // sudo 车道（UploadSudo）：推送目标是登录用户 home 下的暂存
                // 件（该目录对登录用户必可写），最终提交经 exec `sudo mv`；
                // 普通车道保持目标目录内 `.part` + 同目录 rename 原子提交。
                let push_target = sudo_staging
                    .clone()
                    .unwrap_or_else(|| temporary.clone());
                // 显式压缩包交付（ST10）：spool 预压 `.dbxz` → 推送 → 提交为
                // `<目标名>.dbxz`。与 M33 gzip 通道的本质差异：交付物就是压
                // 缩文件本身，**不做任何远端还原**，原始目标路径（remote_path）
                // 全程不被触碰——shell-less 服务器语义成立。压缩失败是任务
                // 失败（不是回退直传）：用户明确选择压缩交付，静默改交付
                // 原始文件会违背意图。
                if lzpack_explicit {
                    let packed_target = format!("{push_target}.packed.dbxz");
                    // 最终交付名：普通车道 `<目标目录>/<名>.dbxz`（同目录
                    // rename 原子提交）；sudo 车道不支持（start 处已拒绝）。
                    let packed_final = format!("{}.dbxz", remote_path);
                    let packed_temporary = format!("{push_target}.dbxz");
                    let packed_backup = format!("{backup}.dbxz");
                    // 1) 预压（spawn_blocking；phase=compressing）。
                    emitter
                        .event(
                            "sftp/transfer/progress",
                            upload_progress_payload(
                                &task_id,
                                &session_id,
                                None,
                                0,
                                expected_size,
                                UploadPhase::Compressing,
                                "running",
                                CompressionMode::None,
                            ),
                        )
                        .ok();
                    let spool = local_path.clone();
                    let packed_path = PathBuf::from(format!("{}.dbxz", local_path.display()));
                    let compress_started = std::time::Instant::now();
                    let packed_local = {
                        let spool = spool.clone();
                        let packed_path = packed_path.clone();
                        let cancelled = cancelled.clone();
                        let expected = expected_size;
                        let emitter = emitter.clone();
                        let task_id = task_id.clone();
                        let session_id = session_id.clone();
                        tokio::task::spawn_blocking(move || {
                            let throttle = Arc::new(std::sync::Mutex::new(
                                crate::progress_throttle::ProgressThrottle::default(),
                            ));
                            let progress: transfer_compress::ProgressSink =
                                Arc::new(move |bytes: u64| {
                                    let emit = throttle
                                        .lock()
                                        .map(|mut throttle| {
                                            throttle
                                                .should_emit(expected > 0 && bytes >= expected)
                                        })
                                        .unwrap_or(true);
                                    if !emit {
                                        return;
                                    }
                                    let _ = emitter.event(
                                        "sftp/transfer/progress",
                                        upload_progress_payload(
                                            &task_id,
                                            &session_id,
                                            None,
                                            bytes,
                                            expected,
                                            UploadPhase::Compressing,
                                            "running",
                                            CompressionMode::None,
                                        ),
                                    );
                                });
                            transfer_compress::lzpack_compress_file_to(
                                &spool,
                                &packed_path,
                                &cancelled,
                                &*progress,
                            )
                        })
                        .await
                    };
                    let packed_size = match packed_local {
                        Ok(Ok(size)) => {
                            // codec 观测回灌（ST8/P3）：压缩吞吐 + 压缩率记入
                            // 该连接档案，供决策器 `decide()` 预测用。吞吐 =
                            // 原始体积/耗时；比率 = 压缩流/原始体积。
                            let elapsed = compress_started.elapsed();
                            if elapsed.as_secs_f64() > 0.0 && expected_size > 0 {
                                let compress_rate = expected_size as f64 / elapsed.as_secs_f64();
                                let ratio = size as f64 / expected_size as f64;
                                let connection_id =
                                    this.session_connection_id(&session_id).await;
                                if let Ok(mut metrics) = this.transfer_metrics.lock() {
                                    let decompress_rate = metrics
                                        .profile(&connection_id)
                                        .and_then(|profile| profile.decompress_rate);
                                    metrics.observe_codec(
                                        &connection_id,
                                        compress_rate,
                                        decompress_rate.unwrap_or(0.0),
                                        ratio,
                                    );
                                }
                            }
                            size
                        }
                        Ok(Err(error))
                            if error.kind() == std::io::ErrorKind::Interrupted =>
                        {
                            let reason = cancel_reason
                                .lock()
                                .map(|reason| reason.clone())
                                .unwrap_or_default();
                            return Err(upload_cancel_error(reason.as_deref()));
                        }
                        Ok(Err(error)) => {
                            let _ = tokio::fs::remove_file(&packed_path).await;
                            return Err(format!("lzpack compress failed: {error}"));
                        }
                        Err(join_error) => {
                            return Err(format!("lzpack compress task failed: {join_error}"));
                        }
                    };
                    if cancelled.load(Ordering::Acquire) {
                        let reason = cancel_reason
                            .lock()
                            .map(|reason| reason.clone())
                            .unwrap_or_default();
                        return Err(upload_cancel_error(reason.as_deref()));
                    }
                    // 2) 推送 .dbxz 到 `<推送暂存>.dbxz`（进度分母=压缩体积）。
                    Self::push_compressed_stream(
                        &sftp,
                        &packed_path,
                        &packed_temporary,
                        packed_size,
                        &task_id,
                        &session_id,
                        &transferred_bytes,
                        &cancelled,
                        &emitter,
                    )
                    .await?;
                    let _ = tokio::fs::remove_file(&packed_path).await;
                    if cancelled.load(Ordering::Acquire) {
                        let _ = sftp.lock().await.remove_file(packed_temporary.clone()).await;
                        let reason = cancel_reason
                            .lock()
                        .map(|reason| reason.clone())
                            .unwrap_or_default();
                        return Err(upload_cancel_error(reason.as_deref()));
                    }
                    // 3) 提交为 `<目标名>.dbxz`：普通车道同目录 rename 原子
                    // 提交（让位→落位→清备份，与 plain 提交同款）；压缩交付
                    // 不保留原始权限位（新文件）。
                    let target_attributes =
                        sftp.lock().await.metadata(packed_final.clone()).await.ok();
                    if let Some(permissions) = target_attributes
                        .as_ref()
                        .and_then(|attrs| attrs.permissions)
                    {
                        if let Err(error) = sftp
                            .lock()
                            .await
                            .set_metadata(
                                packed_temporary.clone(),
                                russh_sftp::protocol::FileAttributes {
                                    permissions: Some(permissions & 0o7777),
                                    ..Default::default()
                                },
                            )
                            .await
                        {
                            eprintln!("[sftp] upload {task_id} lzpack setstat failed: {error}");
                        }
                    }
                    if target_attributes.is_some() {
                        // 已有同名 `.dbxz`：按覆盖规则让位（backup → 回滚语义
                        // 与 commit_remote_file 一致）。
                        sftp
                            .lock()
                            .await
                            .rename(packed_final.clone(), packed_backup.clone())
                            .await
                            .map_err(sftp_error)?;
                    }
                    if let Err(error) = sftp
                        .lock()
                        .await
                        .rename(packed_temporary.clone(), packed_final.clone())
                        .await
                    {
                        // 回滚：让位的旧 .dbxz 还原。
                        if target_attributes.is_some() {
                            let _ = sftp
                                .lock()
                                .await
                                .rename(packed_backup.clone(), packed_final.clone())
                                .await;
                        }
                        let _ = sftp.lock().await.remove_file(packed_temporary.clone()).await;
                        return Err(format!("SFTP upload commit failed: {error}"));
                    }
                    let _ = sftp.lock().await.remove_file(packed_backup.clone()).await;
                    let _ = packed_target;
                    return Ok(());
                }
                // 压缩通道推送（M33）：.gz → 远端 `<推送暂存件>.gz` → 远端
                // gunzip 还原成推送暂存件 → 与普通路径合流走原子提交。
                // 普通车道的暂存件在目标目录、sudo 车道在登录用户 home
                // （push_target 分派）——gz 与 gunzip 都不触碰不可写目标。
                // 推送/解压任一步失败且非取消时，清理 .gz 临时件并回落普通
                // 推送（宁可多传一次原始字节，不让任务失败）；取消立即终止。
                if let Some((gz_path, gz_size)) = gz_local.take() {
                    let gz_temporary = format!("{push_target}.gz");
                    if let Err(error) = Self::push_compressed_stream(
                        &sftp,
                        &gz_path,
                        &gz_temporary,
                        gz_size,
                        &task_id,
                        &session_id,
                        &transferred_bytes,
                        &cancelled,
                        &emitter,
                    )
                    .await
                    {
                        served_compression = CompressionMode::None;
                        let _ = sftp.lock().await.remove_file(gz_temporary.clone()).await;
                        if cancelled.load(Ordering::Acquire) {
                            return Err(error);
                        }
                        eprintln!(
                            "[sftp] upload {task_id} compressed push failed, plain push: {error}"
                        );
                    } else {
                        // gunzip 是 plain exec（登录用户身份）：还原目标在
                        // push_target——普通车道在目标目录内、sudo 车道在其
                        // home 暂存件上，home 由登录用户可写，无需 sudo。
                        let command =
                            transfer_compress::remote_gunzip_command(&gz_temporary, &push_target);
                        let decompressed = match this
                            .exec(&session_id, None, &command, false, Some(300))
                            .await
                        {
                            Ok(outcome)
                                if outcome.get("exitCode").and_then(Value::as_i64) == Some(0) =>
                            {
                                Ok(())
                            }
                            Ok(outcome) => {
                                let output = outcome
                                    .get("output")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .trim()
                                    .chars()
                                    .take(200)
                                    .collect::<String>();
                                Err(format!("remote gunzip failed: {output}"))
                            }
                            Err(error) => Err(format!("remote gunzip failed: {error}")),
                        };
                        match decompressed {
                            Ok(()) => {
                                let _ =
                                    sftp.lock().await.remove_file(gz_temporary.clone()).await;
                                let _ = tokio::fs::remove_file(&gz_path).await;
                                // 取消竞窗收口：gunzip exec 期间到达的取消不再
                                // 提交（plain 路径的取消检查在推送循环内，压缩
                                // 路径的最后一个窗口在这里）。
                                if cancelled.load(Ordering::Acquire) {
                                    let _ = sftp
                                        .lock()
                                        .await
                                        .remove_file(push_target.clone())
                                        .await;
                                    return Err(upload_cancel_error(None));
                                }
                                served_compression = CompressionMode::Gzip;
                                // 提交分道：sudo 车道 exec `sudo mv`，普通车道
                                // SFTP 同目录 rename（与 plain 推送路径同款）。
                                return match sudo_staging.as_deref() {
                                    Some(staging) => {
                                        this.commit_sudo_upload(
                                            &session_id,
                                            staging,
                                            &remote_path,
                                            &backup,
                                        )
                                        .await
                                    }
                                    None => {
                                        commit_remote_file(
                                            &sftp,
                                            &temporary,
                                            &remote_path,
                                            &backup,
                                        )
                                        .await
                                    }
                                };
                            }
                            Err(error) => {
                                served_compression = CompressionMode::None;
                                let _ =
                                    sftp.lock().await.remove_file(gz_temporary.clone()).await;
                                // gunzip exec 超时≠远端进程死了（下载 prep 同款
                                // 假设）：断链它可能仍握着的 temporary——僵尸
                                // gunzip 的后续写入落在已断链的 inode 上，不会
                                // 与回退普通推送写同一文件交错。
                                let _ = sftp.lock().await.remove_file(push_target.clone()).await;
                                eprintln!(
                                    "[sftp] upload {task_id} remote gunzip failed, plain push: {error}"
                                );
                            }
                        }
                    }
                }
                let mut source = tokio::fs::File::open(&local_path)
                    .await
                    .map_err(|error| format!("Failed to open upload spool file: {error}"))?;
                let mut target = sftp
                    .lock()
                    .await
                    .create(push_target.clone())
                    .await
                    .map_err(sftp_error)?;
                let mut transferred = 0_u64;
                let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
                // 进度事件时间窗节流（progress_throttle）：终态事件由循环
                // 外 completed/failed 照常无条件发射，末块必发保证终值。
                let mut progress_throttle = crate::progress_throttle::ProgressThrottle::default();
                loop {
                    if cancelled.load(Ordering::Acquire) {
                        let reason = cancel_reason
                            .lock()
                            .map(|reason| reason.clone())
                            .unwrap_or_default();
                        let error = upload_cancel_error(reason.as_deref());
                        eprintln!("[sftp] upload {task_id} aborted by cancel ({error})");
                        drop(target);
                        let _ = sftp.lock().await.remove_file(push_target.clone()).await;
                        return Err(error);
                    }
                    let read = source
                        .read(&mut buffer)
                        .await
                        .map_err(|error| format!("Failed to read upload spool file: {error}"))?;
                    if read == 0 {
                        break;
                    }
                    if let Err(error) = target.write_all(&buffer[..read]).await {
                        drop(target);
                        let _ = sftp.lock().await.remove_file(push_target.clone()).await;
                        return Err(format!("SFTP upload failed: {error}"));
                    }
                    transferred = transferred.saturating_add(read as u64);
                    transferred_bytes.store(transferred, Ordering::Release);
                    if !progress_throttle
                        .should_emit(expected_size > 0 && transferred >= expected_size)
                    {
                        continue;
                    }
                    emitter
                        .event(
                            "sftp/transfer/progress",
                            upload_progress_payload(
                                &task_id,
                                &session_id,
                                None,
                                transferred,
                                expected_size,
                                UploadPhase::Uploading,
                                "running",
                                served_compression,
                            ),
                        )
                        .map_err(plugin_error)?;
                }
                target
                    .flush()
                    .await
                    .map_err(|error| format!("SFTP upload flush failed: {error}"))?;
                drop(target);
                // 提交分道：sudo 车道经 exec `sudo mv` 让位提交（含回滚）；
                // 普通车道走 SFTP 同目录 rename 原子提交。
                match sudo_staging.as_deref() {
                    Some(staging) => {
                        this.commit_sudo_upload(&session_id, staging, &remote_path, &backup)
                            .await
                    }
                    None => commit_remote_file(&sftp, &temporary, &remote_path, &backup).await,
                }
            }
            .await;
            match this.finishing_uploads.lock() {
                Ok(mut finishing) => {
                    finishing.remove(&task_id);
                }
                Err(_) => eprintln!("[sftp] upload {task_id} finishing registry poisoned"),
            }
            let _ = tokio::fs::remove_file(&local_path).await;
            // 压缩预压产物（M33）：所有终态路径都清（成功路径已在提交前
            // 删过，这里是取消/回退路径的兜底；重复删除无害）。
            let _ = tokio::fs::remove_file(format!("{}.gz", local_path.display())).await;
            let _ = tokio::fs::remove_file(format!("{}.dbxz", local_path.display())).await;
            remove_upload_meta(&this.transfer_dir, &task_id);
            match result {
                Ok(()) => {
                    // 带宽观测回灌（ST8）：以声明体积与网络腿耗时更新该
                    // 连接的上传 EMA；小体积观测被模型忽略。
                    let connection_id = this.session_connection_id(&session_id).await;
                    if let Ok(mut metrics) = this.transfer_metrics.lock() {
                        metrics.observe_network(
                            &connection_id,
                            crate::transfer_schedule::Direction::Upload,
                            expected_size,
                            network_started.elapsed(),
                        );
                    }
                    let task = upload_progress_payload(
                        &task_id,
                        &session_id,
                        Some(remote_path.rsplit('/').next().unwrap_or("upload")),
                        expected_size,
                        expected_size,
                        UploadPhase::Uploading,
                        "completed",
                        served_compression,
                    );
                    this.record_transfer(task.clone());
                    if let Err(error) = emitter.event("sftp/transfer/progress", task) {
                        eprintln!(
                            "[sftp] upload {task_id} completion event failed: {}",
                            error.message
                        );
                    }
                }
                Err(error) => {
                    eprintln!("[sftp] upload {task_id} push failed: {error}");
                    let status = if cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    let mut task = upload_progress_payload(
                        &task_id,
                        &session_id,
                        Some(remote_path.rsplit('/').next().unwrap_or("upload")),
                        transferred_bytes.load(Ordering::Acquire),
                        expected_size,
                        UploadPhase::Uploading,
                        status,
                        served_compression,
                    );
                    task["error"] = json!(error);
                    this.record_transfer(task.clone());
                    let _ = emitter.event("sftp/transfer/progress", task);
                }
            }
        });
        Ok(
            json!({ "success": true, "taskId": response_task_id, "phase": UploadPhase::Uploading.as_str(), "accepted": expected_size }),
        )
    }
}
