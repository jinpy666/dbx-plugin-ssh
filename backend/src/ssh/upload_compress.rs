use super::*;

impl SshRuntime {
    /// sudo 上传车道提交（UploadSudo）：目标已存在时先把其权限位拷到暂存
    /// 件（对齐普通车道 apply_preserved_permissions 的「+x 保持」语义，
    /// best-effort 不阻断提交），再经一条 sudo `sh -c`（[`sudo_commit_body`]）
    /// 完成「target→backup 让位 → 暂存件 mv 到位 → backup 清理 / 失败回滚」。
    /// mv 跨文件系统时退化为复制+删除（非原子，登记边界）；会话死亡时的
    /// 暂存件残留与普通车道 `.part` 残留同类，不追加额外清理链。
    pub(super) async fn commit_sudo_upload(
        &self,
        session_id: &str,
        staging: &str,
        target: &str,
        backup: &str,
    ) -> Result<(), String> {
        if let Ok(stat) = crate::sudo_fs::stat(self, session_id, target).await {
            if stat.get("kind").and_then(Value::as_str) == Some("file") {
                if let Some(mode) = stat.get("mode").and_then(Value::as_str) {
                    let chmod = format!("chmod {mode} -- {}", exec::shell_quote(staging));
                    if let Err(error) =
                        crate::sudo_fs::sudo_exec(self, session_id, &chmod, SUDO_UPLOAD_QUICK_SECS)
                            .await
                    {
                        eprintln!("[sudo-upload] permission mirror failed: {error}");
                    }
                }
            }
        }
        crate::sudo_fs::sudo_exec(
            self,
            session_id,
            &sudo_commit_body(staging, target, backup),
            SUDO_UPLOAD_COMMIT_SECS,
        )
        .await
        .map(|_| ())
    }

    /// 压缩上传的 spool 预压（M33）：`<spool>` → `<spool>.gz`，spawn_blocking
    /// 里跑 flate2（大文件 CPU 段不阻塞 runtime）。进度事件 phase=compressing、
    /// 分母=原始大小（事件字段自描述）。产出后做比率守卫：压缩后 ≥95% 原始
    /// 体积判不划算（删 .gz 回普通推送）。取消以 `Interrupted` 中止并清半成品。
    pub(super) async fn compress_upload_spool(
        spool: &Path,
        expected_size: u64,
        task_id: &str,
        session_id: &str,
        cancelled: &Arc<AtomicBool>,
        cancel_reason: &Arc<Mutex<Option<String>>>,
        emitter: &PluginEmitter,
    ) -> SpoolCompression {
        let gz_path = PathBuf::from(format!("{}.gz", spool.display()));
        emitter
            .event(
                "sftp/transfer/progress",
                upload_progress_payload(
                    task_id,
                    session_id,
                    None,
                    0,
                    expected_size,
                    UploadPhase::Compressing,
                    "running",
                    CompressionMode::Gzip,
                ),
            )
            .ok();
        let progress: transfer_compress::ProgressSink = {
            let emitter = emitter.clone();
            let task_id = task_id.to_string();
            let session_id = session_id.to_string();
            let throttle = Arc::new(Mutex::new(
                crate::progress_throttle::ProgressThrottle::default(),
            ));
            Arc::new(move |bytes: u64| {
                let emit = throttle
                    .lock()
                    .map(|mut throttle| {
                        throttle.should_emit(expected_size > 0 && bytes >= expected_size)
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
                        expected_size,
                        UploadPhase::Compressing,
                        "running",
                        CompressionMode::Gzip,
                    ),
                );
            })
        };
        let spool_owned = spool.to_path_buf();
        let target = gz_path.clone();
        let cancelled_for_task = cancelled.clone();
        let rate_guard = transfer_compress::RateGuard::default_floor();
        let joined = tokio::task::spawn_blocking(move || {
            transfer_compress::compress_file_to(
                &spool_owned,
                &target,
                &cancelled_for_task,
                &*progress,
                Some(&rate_guard),
            )
        })
        .await;
        match joined {
            Ok(Ok(compressed_size)) => {
                if transfer_compress::worthwhile(expected_size, compressed_size) {
                    SpoolCompression::Done(gz_path, compressed_size)
                } else {
                    let _ = tokio::fs::remove_file(&gz_path).await;
                    SpoolCompression::NotWorthwhile
                }
            }
            // 运行时吞吐守卫（M33 补充）：本机压缩速率低于下限 = CPU 不行，
            // 与比率守卫同归宿——回退普通推送，不算失败。
            Ok(Err(ref error)) if transfer_compress::is_rate_guard_error(error) => {
                let _ = tokio::fs::remove_file(&gz_path).await;
                eprintln!("[sftp] upload {task_id} compression rate below floor, plain push");
                SpoolCompression::NotWorthwhile
            }
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                let reason = cancel_reason
                    .lock()
                    .map(|reason| reason.clone())
                    .unwrap_or_default();
                SpoolCompression::Cancelled(upload_cancel_error(reason.as_deref()))
            }
            Ok(Err(error)) => SpoolCompression::Failed(error.to_string()),
            Err(join_error) => {
                SpoolCompression::Failed(format!("compress task failed: {join_error}"))
            }
        }
    }

    /// 压缩流推送（M33）：本地 .gz → 远端 `<temporary>.gz`。进度事件保持
    /// phase=uploading，但分母换成压缩后体积——事件字段自描述，前端的
    /// 速度/ETA 按真实网络字节算。取消逐块生效（由调用方负责清理远端
    /// 临时件并终止任务）。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn push_compressed_stream(
        sftp: &Arc<AsyncMutex<SftpSession>>,
        local_gz: &Path,
        remote_temporary_gz: &str,
        compressed_size: u64,
        task_id: &str,
        session_id: &str,
        transferred_bytes: &AtomicU64,
        cancelled: &AtomicBool,
        emitter: &PluginEmitter,
    ) -> Result<(), String> {
        let mut source = tokio::fs::File::open(local_gz)
            .await
            .map_err(|error| format!("Failed to open compressed spool: {error}"))?;
        let mut target = sftp
            .lock()
            .await
            .create(remote_temporary_gz.to_string())
            .await
            .map_err(sftp_error)?;
        let mut transferred = 0_u64;
        let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
        let mut progress_throttle = crate::progress_throttle::ProgressThrottle::default();
        loop {
            if cancelled.load(Ordering::Acquire) {
                let _ = target.flush().await;
                drop(target);
                let _ = sftp
                    .lock()
                    .await
                    .remove_file(remote_temporary_gz.to_string())
                    .await;
                return Err(upload_cancel_error(None));
            }
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| format!("Failed to read compressed spool: {error}"))?;
            if read == 0 {
                break;
            }
            if let Err(error) = target.write_all(&buffer[..read]).await {
                drop(target);
                let _ = sftp
                    .lock()
                    .await
                    .remove_file(remote_temporary_gz.to_string())
                    .await;
                return Err(format!("SFTP upload failed: {error}"));
            }
            transferred = transferred.saturating_add(read as u64);
            transferred_bytes.store(transferred, Ordering::Release);
            if !progress_throttle.should_emit(compressed_size > 0 && transferred >= compressed_size)
            {
                continue;
            }
            emitter
                .event(
                    "sftp/transfer/progress",
                    upload_progress_payload(
                        task_id,
                        session_id,
                        None,
                        transferred,
                        compressed_size,
                        UploadPhase::Uploading,
                        "running",
                        CompressionMode::Gzip,
                    ),
                )
                .map_err(plugin_error)?;
        }
        target
            .flush()
            .await
            .map_err(|error| format!("SFTP upload flush failed: {error}"))?;
        drop(target);
        Ok(())
    }
}
