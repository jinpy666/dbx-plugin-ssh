use super::state::{DownloadState, PrepOutcome};
use super::*;

impl SshRuntime {
    /// 压缩下载 prep 终态分发（M33）：Ready 就绪发 ready 事件；Fallback
    /// 静默回落普通管线（清理压缩产物，registry 改回 None 后发 compression
    /// 为 none 的 ready 事件，前端照旧直读远端）；Cancelled 是取消路径
    /// （cancel RPC 已发 cancelled 事件，这里只清理远端/本地临时件）。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_download_prep(
        self: &Arc<Self>,
        task_id: String,
        session_id: String,
        remote_path: String,
        size: u64,
        gz_staging: PathBuf,
        staged_plain: PathBuf,
        remote_temp: String,
        throttle: Throttle,
        cancelled: Arc<AtomicBool>,
        _cancel_reason: Arc<Mutex<Option<String>>>,
        phase: Arc<Mutex<&'static str>>,
        emitter: PluginEmitter,
    ) {
        let outcome = self
            .prep_download_staging(
                &task_id,
                &session_id,
                &remote_path,
                size,
                &gz_staging,
                &staged_plain,
                &remote_temp,
                &throttle,
                &cancelled,
                &phase,
                &emitter,
            )
            .await;
        match outcome {
            PrepOutcome::Ready => {
                {
                    let mut downloads = self
                        .downloads
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    if let Some(current) = downloads.get_mut(&task_id) {
                        current.ready = true;
                    }
                }
                self.download_preps
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&task_id);
                let _ = emitter.event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": 0, "size": size, "status": "running", "phase": "ready", "compression": "gzip" }),
                );
            }
            PrepOutcome::Fallback(reason) => {
                eprintln!("[sftp] download {task_id} compressed prep fallback: {reason}");
                self.cleanup_compressed_download(
                    &session_id,
                    Some(&remote_temp),
                    Some(&gz_staging),
                    None,
                )
                .await;
                {
                    // compression 保持原决策值（status 的 compression/ready
                    // 字段继续输出，前端等待环据此收口）；serving_plain 让
                    // 分块泵走普通管线（树/单文件同语义）。
                    let mut downloads = self
                        .downloads
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    if let Some(current) = downloads.get_mut(&task_id) {
                        current.serving_plain = true;
                        current.ready = true;
                    }
                }
                self.download_preps
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&task_id);
                let _ = emitter.event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": 0, "size": size, "status": "running", "phase": "ready", "compression": "none" }),
                );
            }
            PrepOutcome::Cancelled => {
                // 任务已被 cancel_transfer 摘除（并清理过临时件）；prep 自己
                // 的半成品（远端 .gz 可能在取消竞窗里刚出现）再兜底清一次。
                self.cleanup_compressed_download(
                    &session_id,
                    Some(&remote_temp),
                    Some(&gz_staging),
                    Some(&staged_plain),
                )
                .await;
                self.download_preps
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&task_id);
            }
        }
    }

    /// prep 主体（M33）：远端 gzip → stat 比率守卫 → 拉取 .gz → 本地解压。
    /// 任一步取消即中断；远端 gzip 失败/比率不划算/解压失败回落普通管线。
    #[allow(clippy::too_many_arguments)]
    async fn prep_download_staging(
        self: &Arc<Self>,
        task_id: &str,
        session_id: &str,
        remote_path: &str,
        size: u64,
        gz_staging: &Path,
        staged_plain: &Path,
        remote_temp: &str,
        throttle: &Throttle,
        cancelled: &Arc<AtomicBool>,
        phase: &Arc<Mutex<&'static str>>,
        emitter: &PluginEmitter,
    ) -> PrepOutcome {
        let emit_phase = |phase_name: &str,
                          transferred: u64,
                          denominator: u64,
                          compression: &str|
         -> Result<(), String> {
            emitter
                .event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": transferred, "size": denominator, "status": "running", "phase": phase_name, "compression": compression }),
                )
                .map_err(plugin_error)
        };
        let set_phase = |value: &'static str| {
            if let Ok(mut slot) = phase.lock() {
                *slot = value;
            }
        };
        // 取消判定：显式旗标或任务已从 registry 摘除（cancel RPC 的摘除
        // 与 prep 的旗标置位之间有竞窗，双条件都查）。
        let is_cancelled = || {
            cancelled.load(Ordering::Acquire)
                || self
                    .downloads
                    .lock()
                    .map(|downloads| !downloads.contains_key(task_id))
                    .unwrap_or(false)
        };
        // 1) 远端 gzip（exec 上限 300s；超时后命令仍在远端跑，下面的
        // 失败清理会把 .gz 从目录摘掉——gzip 继续写已断链的 inode，目录
        // 不残留）。失败一律回退普通管线。
        set_phase("compressing");
        if let Err(error) = emit_phase("compressing", 0, size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        let command = transfer_compress::remote_gzip_command(remote_path, remote_temp);
        let gzipped = match self
            .exec(session_id, None, &command, false, Some(300))
            .await
        {
            Ok(outcome) if outcome.get("exitCode").and_then(Value::as_i64) == Some(0) => true,
            Ok(outcome) => {
                let output = outcome
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(200)
                    .collect::<String>();
                return PrepOutcome::Fallback(format!("remote gzip failed: {output}"));
            }
            Err(error) => return PrepOutcome::Fallback(format!("remote gzip failed: {error}")),
        };
        let _ = gzipped;
        if is_cancelled() {
            return PrepOutcome::Cancelled;
        }
        // 2) 比率守卫：.gz 不明显小于原文件（已压缩内容）则回退。
        let gz_size = match self.sftp(session_id).await {
            Ok(sftp) => match sftp.lock().await.metadata(remote_temp.to_string()).await {
                Ok(attributes) => attributes.size.unwrap_or(0),
                Err(error) => {
                    return PrepOutcome::Fallback(format!("remote gz stat failed: {error}"))
                }
            },
            Err(error) => return PrepOutcome::Fallback(format!("session unavailable: {error}")),
        };
        if !transfer_compress::worthwhile(size, gz_size) {
            return PrepOutcome::Fallback("compression not worthwhile".to_string());
        }
        // 3) 拉取 .gz（网络腿，按压缩流计进度与限速）。
        set_phase("fetching");
        if let Err(error) = emit_phase("fetching", 0, gz_size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        let pulled = match self
            .pull_remote_gzip(
                session_id,
                remote_temp,
                gz_staging,
                gz_size,
                task_id,
                throttle,
                cancelled,
                phase,
                emitter,
            )
            .await
        {
            Ok(pulled) => pulled,
            Err(error) => {
                if is_cancelled() {
                    return PrepOutcome::Cancelled;
                }
                return PrepOutcome::Fallback(format!("gz fetch failed: {error}"));
            }
        };
        let _ = pulled;
        if is_cancelled() {
            return PrepOutcome::Cancelled;
        }
        // 4) 本地解压（spawn_blocking；解压体积与声明 size 不符视为损坏，
        // 回退普通管线）。
        set_phase("decompressing");
        if let Err(error) = emit_phase("decompressing", 0, size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        let decompressed = {
            let source = gz_staging.to_path_buf();
            let target = staged_plain.to_path_buf();
            let cancelled = cancelled.clone();
            let emitter = emitter.clone();
            let task_id = task_id.to_string();
            let session_id = session_id.to_string();
            let throttle = Arc::new(Mutex::new(
                crate::progress_throttle::ProgressThrottle::default(),
            ));
            let progress: transfer_compress::ProgressSink = Arc::new(move |bytes: u64| {
                let emit = throttle
                    .lock()
                    .map(|mut throttle| throttle.should_emit(size > 0 && bytes >= size))
                    .unwrap_or(true);
                if !emit {
                    return;
                }
                let _ = emitter.event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": bytes, "size": size, "status": "running", "phase": "decompressing", "compression": "gzip" }),
                );
            });
            tokio::task::spawn_blocking(move || {
                transfer_compress::decompress_file_to(&source, &target, &cancelled, &*progress)
            })
            .await
        };
        match decompressed {
            Ok(Ok(bytes)) if bytes == size || size == 0 => PrepOutcome::Ready,
            Ok(Ok(bytes)) => {
                PrepOutcome::Fallback(format!("decompressed size mismatch: {bytes} of {size}"))
            }
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                PrepOutcome::Cancelled
            }
            Ok(Err(error)) => PrepOutcome::Fallback(format!("decompress failed: {error}")),
            Err(join_error) => {
                PrepOutcome::Fallback(format!("decompress task failed: {join_error}"))
            }
        }
    }

    /// 拉取远端 .gz 到本地暂存（M33）：256KiB 分块 + 限速 + 逐块取消检查 +
    /// 节流进度事件（phase=fetching，分母=压缩流体积）。返回已拉取字节。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn pull_remote_gzip(
        &self,
        session_id: &str,
        remote_temp: &str,
        gz_staging: &Path,
        gz_size: u64,
        task_id: &str,
        throttle: &Throttle,
        cancelled: &Arc<AtomicBool>,
        _phase: &Arc<Mutex<&'static str>>,
        emitter: &PluginEmitter,
    ) -> Result<u64, String> {
        let sftp = self.sftp(session_id).await?;
        let mut source = sftp
            .lock()
            .await
            .open(remote_temp.to_string())
            .await
            .map_err(sftp_error)?;
        // staging 父目录（`transfers/downloads`）平时由 build_download_sink
        // 创建；压缩树任务在全新数据目录上先于任何 sink 运行，这里自建。
        if let Some(parent) = gz_staging.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create gz staging directory: {error}"))?;
        }
        let mut target = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(gz_staging)
            .await
            .map_err(|error| format!("Failed to create gz staging file: {error}"))?;
        let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
        let mut pulled = 0_u64;
        let mut progress_throttle = crate::progress_throttle::ProgressThrottle::default();
        loop {
            if cancelled.load(Ordering::Acquire) {
                return Err(upload_cancel_error(None));
            }
            let chunk_started = throttle.enabled().then(std::time::Instant::now);
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| format!("SFTP gz fetch failed: {error}"))?;
            if read == 0 {
                break;
            }
            target
                .write_all(&buffer[..read])
                .await
                .map_err(|error| format!("Failed to write gz staging file: {error}"))?;
            pulled += read as u64;
            if let (true, Some(started)) = (throttle.enabled(), chunk_started) {
                throttle.pace(read, started.elapsed()).await;
            }
            if progress_throttle.should_emit(gz_size > 0 && pulled >= gz_size) {
                emitter
                    .event(
                        "sftp/transfer/progress",
                        json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": pulled, "size": gz_size, "status": "running", "phase": "fetching", "compression": "gzip" }),
                    )
                    .map_err(plugin_error)?;
            }
        }
        target
            .flush()
            .await
            .map_err(|error| format!("Failed to flush gz staging file: {error}"))?;
        Ok(pulled)
    }

    /// 压缩下载临时件清理（M33）：远端 .gz（SFTP remove，best-effort）+
    /// 本地 gz 暂存 + 可选的 plain 半成品。任何一步失败只记日志。
    pub(super) async fn cleanup_compressed_download(
        &self,
        session_id: &str,
        remote_temp: Option<&str>,
        gz_staging: Option<&Path>,
        staged_plain: Option<&Path>,
    ) {
        if let Some(remote_temp) = remote_temp {
            match self.sftp(session_id).await {
                Ok(sftp) => {
                    if let Err(error) = sftp.lock().await.remove_file(remote_temp.to_string()).await
                    {
                        eprintln!(
                            "[sftp] compressed download cleanup: remote temp not removed: {error}"
                        );
                    }
                }
                Err(error) => {
                    eprintln!("[sftp] compressed download cleanup: session unavailable: {error}")
                }
            }
        }
        if let Some(path) = gz_staging {
            let _ = tokio::fs::remove_file(path).await;
        }
        if let Some(path) = staged_plain {
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    /// 压缩任务的单文件分块泵（M33）：从本地解压后的 `staged_plain` 按
    /// offset 读（普通任务远端 seek+read）。限速不适用——网络腿已在 prep
    /// 拉取段按压缩流限速；二进制帧/进度/offset 校验与普通路径同语义。
    pub(super) async fn download_staged_chunk(
        &self,
        task_id: &str,
        offset: u64,
        download: DownloadState,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let Some(staged) = download.staged_plain.as_ref() else {
            return Err("Compressed download staging is missing".to_string());
        };
        if !download.ready {
            return Err("Compressed download is still preparing".to_string());
        }
        if offset != download.next_offset {
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let remaining = download.size.saturating_sub(offset);
        let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
        let mut source = tokio::fs::File::open(staged)
            .await
            .map_err(|error| format!("Failed to open decompressed staging file: {error}"))?;
        source
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| format!("Staged file seek failed: {error}"))?;
        let mut chunk = vec![0_u8; requested];
        let length = source
            .read(&mut chunk)
            .await
            .map_err(|error| format!("Failed to read decompressed staging file: {error}"))?;
        chunk.truncate(length);
        let next_offset = offset.saturating_add(length as u64);
        let mut payload = Vec::with_capacity(8 + length);
        payload.extend_from_slice(&offset.to_be_bytes());
        payload.extend_from_slice(&chunk);
        emitter
            .binary(&format!("sftp/download/{task_id}"), &payload)
            .map_err(plugin_error)?;
        let emit_progress = {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download registry is poisoned".to_string())?;
            let current = downloads
                .get_mut(task_id)
                .ok_or("Download task was not found")?;
            if current.next_offset != offset {
                return Err("Download task changed while a chunk was in flight".to_string());
            }
            current.next_offset = next_offset;
            current
                .progress_throttle
                .should_emit(download.size > 0 && next_offset >= download.size)
        };
        if emit_progress {
            emitter
                .event(
                    "sftp/transfer/progress",
                    // phase=transferring（2026-09-30 补齐）：ready 之后从本地
                    // 解压暂存分块供给的真实网络外发段——前端归并器换阶段即
                    // 重置计数（分母=原始体积），进度条/速度不再卡在解压终值。
                    json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running", "phase": "transferring", "compression": "gzip" }),
                )
                .map_err(plugin_error)?;
        }
        Ok(
            json!({ "taskId": task_id, "offset": offset, "length": length, "eof": next_offset >= download.size, "fileName": download.file_name }),
        )
    }
}
