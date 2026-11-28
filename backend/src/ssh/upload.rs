use super::upload_meta::{read_upload_meta, resumable_uploads_from, write_upload_meta};
use super::*;

impl SshRuntime {
    #[allow(clippy::too_many_arguments)]
    pub async fn start_upload(
        &self,
        session_id: String,
        remote_path: String,
        size: u64,
        resume_task_id: Option<String>,
        encoding: NameEncoding,
        sudo_lane: bool,
        lzpack_explicit: bool,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        self.ensure_writable(&session_id).await?;
        if size > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        if self.active_transfer_count(&session_id)? as u64 >= self.transfer_depth_limit() {
            return Err(format!(
                "This SSH session already has {} active transfers",
                self.transfer_depth_limit()
            ));
        }
        let remote_path = normalize_remote_path(&remote_path)?;
        // 压缩通道决策（M33，W6 单入口）：偏好/阈值/黑名单 + 远端 gunzip
        // 探测一次，决策结果随任务存续，finish 推送前消费。latin-1 车道
        // 强制 None（远端 gunzip 的 shell 路径不做 latin-1 字节）；sudo 车道
        // 正常参与——gz 暂存与远端 gunzip 都落在登录用户 home 暂存件上
        // （finish 的 gz 分支按 push_target 分派），全程不触碰目标目录。
        // 只读对上传无意义（ensure_writable 已整体拦截）。
        // 显式压缩包模式（ST10）优先：用户勾选 lzpack 后不进 M33 决策，
        // 交付 `<目标名>.dbxz`，无需远端任何工具。P3 顾问：历史 EMA 带宽 +
        // codec 吞吐齐全时跑一次预测，负收益打日志（不拦截——交付语义由
        // 用户决定；首次使用无观测时静默）。
        if lzpack_explicit {
            let connection_id = self.session_connection_id(&session_id).await;
            if let Ok(metrics) = self.transfer_metrics.lock() {
                if let Some(profile) = metrics.profile(&connection_id) {
                    let advice = crate::transfer_schedule::advise_explicit_compression(
                        size,
                        crate::transfer_schedule::Direction::Upload,
                        profile,
                        0.6,
                        crate::transfer_schedule::DEFAULT_GAIN_THRESHOLD,
                    );
                    if advice == crate::transfer_schedule::Advice::RecommendDirect {
                        eprintln!(
                            "[sftp] upload {session_id} lzpack advisor: predicted gain negative on this link, plain transfer would likely be faster (explicit mode proceeds)"
                        );
                    }
                }
            }
        }
        let compression = if lzpack_explicit {
            CompressionMode::None
        } else {
            self.decide_transfer_compression(
                &session_id,
                size,
                Some(remote_path.rsplit('/').next().unwrap_or("")),
                false,
                false,
                encoding == NameEncoding::Latin1,
            )
            .await
        };
        // Resume path: re-register a previously interrupted upload job. The
        // spool file and its sidecar meta (written on the first start) hold
        // the received prefix; the caller re-streams only the missing tail.
        if let Some(task_id) = resume_task_id {
            let (local_path, resume_offset) =
                self.open_resume_spool(&task_id, &remote_path, size)?;
            let file = std::fs::OpenOptions::new()
                .append(true)
                .open(&local_path)
                .map_err(|error| format!("Failed to open upload spool file: {error}"))?;
            self.uploads
                .lock()
                .map_err(|_| "Upload registry is poisoned".to_string())?
                .insert(
                    task_id.clone(),
                    UploadState {
                        session_id: session_id.clone(),
                        remote_path: remote_path.clone(),
                        expected_size: size,
                        received: resume_offset,
                        local_path,
                        file,
                        progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                        compression,
                        sudo_lane,
                        lzpack_explicit,
                    },
                );
            let file_name = remote_path
                .rsplit('/')
                .next()
                .unwrap_or("upload")
                .to_string();
            emitter
                .event(
                    "sftp/transfer/progress",
                    upload_progress_payload(
                        &task_id,
                        &session_id,
                        Some(&file_name),
                        resume_offset,
                        size,
                        UploadPhase::Staging,
                        "running",
                        compression,
                    ),
                )
                .map_err(plugin_error)?;
            let connection_id = self.session_connection_id(&session_id).await;
            self.record_transfer_start(
                &task_id,
                &session_id,
                &connection_id,
                "upload",
                &file_name,
                size,
            );
            return Ok(
                json!({ "taskId": task_id, "chunkSize": TRANSFER_CHUNK_SIZE, "maxBytes": MAX_TRANSFER_SIZE, "resumeOffset": resume_offset, "compression": compression.as_str() }),
            );
        }
        let task_id = Uuid::new_v4().to_string();
        let local_path = self.transfer_dir.join(format!("upload-{task_id}.part"));
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&local_path)
            .map_err(|error| format!("Failed to create upload spool file: {error}"))?;
        // Sidecar meta: lets `sftp/transfer/resumable` and a later resume
        // validate the file identity (remote path + size) without trusting
        // caller-supplied values.
        write_upload_meta(
            &self.transfer_dir.join(format!("upload-{task_id}.json")),
            &json!({ "remotePath": remote_path, "size": size }),
        )?;
        self.uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                UploadState {
                    session_id: session_id.clone(),
                    remote_path: remote_path.clone(),
                    expected_size: size,
                    received: 0,
                    local_path,
                    file,
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    compression,
                    sudo_lane,
                    lzpack_explicit,
                },
            );
        let file_name = remote_path.rsplit('/').next().unwrap_or("upload");
        emitter
            .event(
                "sftp/transfer/progress",
                upload_progress_payload(
                    &task_id,
                    &session_id,
                    Some(file_name),
                    0,
                    size,
                    UploadPhase::Staging,
                    "queued",
                    compression,
                ),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(&session_id).await;
        self.record_transfer_start(
            &task_id,
            &session_id,
            &connection_id,
            "upload",
            file_name,
            size,
        );
        Ok(
            json!({ "taskId": task_id, "chunkSize": TRANSFER_CHUNK_SIZE, "maxBytes": MAX_TRANSFER_SIZE, "resumeOffset": 0_u64, "compression": compression.as_str() }),
        )
    }

    /// 压缩通道决策单入口（M33 引入，评审 W6 收敛 2026-09-30）：策略/阈值/
    /// 扩展名黑名单/只读/latin-1/弱 CPU 全部经 `transfer_compress::decide`
    /// 收敛，Gzip 判定再做远端 `gzip`/`gunzip`（树加 `tar`）探测（按会话
    /// 缓存）。上传/单文件下载/树下载三个 start 路径共用，车道差异只在
    /// 参数：上传的只读由 `ensure_writable` 前置拦截（恒 false）；树的
    /// 黑名单以 `name=None` 跳过、探测 needs_tar=true。探测失败/超时一律
    /// 静默回退普通传输，绝不因能力探测失败拒绝传输。
    pub(super) async fn decide_transfer_compression(
        &self,
        session_id: &str,
        size: u64,
        name: Option<&str>,
        needs_tar: bool,
        read_only: bool,
        latin1: bool,
    ) -> CompressionMode {
        let policy = crate::preferences::transfer_compress_mode(&self.data_dir);
        let threshold = crate::preferences::transfer_compress_threshold_mib(&self.data_dir);
        let parallelism = transfer_compress::local_parallelism();
        // 诊断日志（macOS 压缩通道排查）：打印决策全部入参——probe 未被
        // 调用说明 decide() 提前返回 None，从这行直接看是哪个门拦的。
        eprintln!(
            "[sftp] compress decide: policy={policy:?} size={size} threshold={threshold} name={name:?} needs_tar={needs_tar} read_only={read_only} latin1={latin1} parallelism={parallelism}"
        );
        let decided = transfer_compress::decide(
            policy,
            size,
            threshold,
            name,
            true,
            read_only,
            latin1,
            parallelism,
        );
        eprintln!("[sftp] compress decide -> {decided:?}");
        if decided != CompressionMode::Gzip {
            return decided;
        }
        if self
            .probe_remote_compress_tools(session_id, needs_tar)
            .await
        {
            CompressionMode::Gzip
        } else {
            CompressionMode::None
        }
    }

    /// 远端压缩工具探测（M33）：`command -v` 组合命令，退出码 0 且输出含
    /// 标记串即可用。exec 错误/超时/非零都按不可用处理。结果按会话缓存
    /// （工具存在性在连接生命周期内不变；目录批量上传逐文件 start 不再
    /// 重复 exec），探测失败也缓存——失败会话每任务重试只会放大延迟。
    async fn probe_remote_compress_tools(&self, session_id: &str, needs_tar: bool) -> bool {
        let cache_key = format!("{session_id}\u{0}{needs_tar}");
        if let Ok(cache) = self.compress_tool_probe.lock() {
            if let Some(cached) = cache.get(&cache_key) {
                return *cached;
            }
        }
        let command = transfer_compress::probe_command(needs_tar);
        let available = match self.exec(session_id, None, &command, false, Some(5)).await {
            Ok(outcome) => {
                let exit_code = outcome.get("exitCode").and_then(Value::as_i64);
                let output = outcome.get("output").and_then(Value::as_str);
                let ok = exit_code == Some(0)
                    && output.is_some_and(|output| output.contains("DBX_COMPRESS_OK"));
                // 诊断日志（macOS 压缩通道排查）：exec 成功但条件不满足时打印
                // 实际 exitCode/output——此前 false 分支静默，无法分辨是
                // exec 超时、非零退出还是输出缺标记。
                if !ok {
                    eprintln!(
                        "[sftp] compress tool probe negative: exit={exit_code:?} output={:?} cmd={command}",
                        output.map(|o| o.chars().take(200).collect::<String>())
                    );
                }
                ok
            }
            Err(error) => {
                eprintln!("[sftp] compress tool probe failed, plain transfer: {error}");
                false
            }
        };
        if let Ok(mut cache) = self.compress_tool_probe.lock() {
            cache.insert(cache_key, available);
        }
        available
    }

    /// Reopens an interrupted upload's spool file for appending, validating
    /// the resume request against the persisted sidecar meta so a stale or
    /// mismatched resumeTaskId cannot splice the wrong file tail onto the
    /// spooled prefix.
    pub(super) fn open_resume_spool(
        &self,
        task_id: &str,
        remote_path: &str,
        size: u64,
    ) -> Result<(PathBuf, u64), String> {
        let spool = self.transfer_dir.join(format!("upload-{task_id}.part"));
        let meta = read_upload_meta(&self.transfer_dir.join(format!("upload-{task_id}.json")))
            .ok_or("No resumable upload found for this task")?;
        if meta.get("remotePath").and_then(Value::as_str) != Some(remote_path) {
            return Err(
                "Resume target does not match the interrupted upload's remote path".to_string(),
            );
        }
        if meta.get("size").and_then(Value::as_u64) != Some(size) {
            return Err("Resume file size does not match the interrupted upload".to_string());
        }
        let spool_len = std::fs::metadata(&spool)
            .map_err(|error| format!("Upload spool file is gone: {error}"))?
            .len();
        if spool_len > size {
            return Err("Spooled data exceeds the declared file size".to_string());
        }
        Ok((spool, spool_len))
    }

    /// taskId → 所属 sessionId（连接级 SFTP 编码判定用，M16 集成）。
    /// 任务不存在返回 None，调用方按未覆盖（跟随全局）处理。
    pub fn upload_session_id(&self, task_id: &str) -> Option<String> {
        self.uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())
            .ok()?
            .get(task_id)
            .map(|upload| upload.session_id.clone())
    }

    /// `sftp/transfer/resumable`: interrupted uploads (spool + meta still on
    /// disk, job no longer live) the workbench can offer to resume. Pure
    /// scan over local state, so it answers without any active connection.
    pub fn resumable_uploads(&self) -> Result<Value, String> {
        let live: Vec<String> = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .keys()
            .cloned()
            .collect();
        let tasks = resumable_uploads_from(&self.transfer_dir, &live);
        Ok(json!({ "tasks": tasks }))
    }

    pub fn append_upload(
        &self,
        task_id: &str,
        payload: &[u8],
        emitter: &PluginEmitter,
    ) -> Result<(), String> {
        if payload.len() < 8 {
            return Err("Upload chunk is missing its offset".to_string());
        }
        let offset = u64::from_be_bytes(
            payload[..8]
                .try_into()
                .map_err(|_| "Invalid upload offset")?,
        );
        let chunk = &payload[8..];
        if chunk.len() > TRANSFER_CHUNK_SIZE {
            return Err("Upload chunk exceeds the negotiated chunk size".to_string());
        }
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?;
        let upload = uploads
            .get_mut(task_id)
            .ok_or("Upload task was not found")?;
        if upload.received != offset {
            return Err(format!(
                "Upload offset mismatch: expected {}, received {offset}",
                upload.received
            ));
        }
        if upload.received.saturating_add(chunk.len() as u64) > upload.expected_size {
            return Err("Upload exceeds the declared file size".to_string());
        }
        upload
            .file
            .write_all(chunk)
            .map_err(|error| format!("Failed to spool upload chunk: {error}"))?;
        upload.received = upload.received.saturating_add(chunk.len() as u64);
        // 进度事件时间窗节流（progress_throttle）：每块一条 IPC 事件在
        // 大文件下约 200 条/秒；末块（received 达到声明总量）必发，ack 与
        // 终态事件不节流。
        if upload
            .progress_throttle
            .should_emit(upload.expected_size > 0 && upload.received >= upload.expected_size)
        {
            emitter
                .event(
                    "sftp/transfer/progress",
                    upload_progress_payload(
                        task_id,
                        &upload.session_id,
                        None,
                        upload.received,
                        upload.expected_size,
                        UploadPhase::Staging,
                        "running",
                        upload.compression,
                    ),
                )
                .map_err(plugin_error)?;
        }
        emitter
            .event(
                "sftp/upload/ack",
                json!({ "taskId": task_id, "offset": offset, "length": chunk.len(), "nextOffset": upload.received }),
            )
            .map_err(plugin_error)
    }
}
