use super::state::{DownloadPrep, DownloadState, PrepOutcome};
use super::*;

impl SshRuntime {
    /// 显式解压下载（ST10）：远端源 `.dbxz` → 本地暂存拉流 → 自研解压 →
    /// staged 分块供给原始字节。注册表里 compression=None + expand_lzpack=
    /// true：分块供给走 staged 车道（download_staged_chunk），status/事件
    /// 的 compression 字段标 "lzpack"。原始体积从容器头读出——无法读出
    /// 即任务失败（不是回退：用户明确要还原 .dbxz，源不是 .dbxz 时静默
    /// 直传原始文件会暴露服务器上的压缩件语义混乱）。
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn start_lzpack_download(
        self: &Arc<Self>,
        session_id: &str,
        remote_path: &str,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        encoding: NameEncoding,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        // 只读连接不解压下载：读远端无副作用，但落盘本地是同一条链——本
        // 判定与 M33 prep 的 read_only 拦截口径一致（prep 需要远端写临时件，
        // lzpack 不需要远端写，因此这里不拦只读）。
        let latin1 = encoding == NameEncoding::Latin1;

        // 1) 实测压缩流体积（SFTP stat；latin-1 车道裸包 stat）。
        let packed_size = if latin1 && sftp_name::has_wire_lane(remote_path, encoding) {
            let mut client = self.raw_sftp_client(session_id).await?;
            client
                .stat(&sftp_name::unescape_wire(remote_path))
                .await
                .map_err(sftp_error)?
                .size
                .unwrap_or(0)
        } else {
            let size = self
                .sftp(session_id)
                .await?
                .lock()
                .await
                .metadata(remote_path.to_string())
                .await
                .map_err(sftp_error)?
                .size
                .unwrap_or(0);
            size
        };
        if packed_size > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        if packed_size == 0 {
            return Err("Remote .dbxz file is empty".to_string());
        }
        // 2) 容器头探测原始体积（首 16 字节，裸包/高层按车道读）。
        let head = if latin1 && sftp_name::has_wire_escapes(remote_path) {
            let mut client = self.raw_sftp_client(session_id).await?;
            client
                .read_chunk(
                    &sftp_name::unescape_wire(remote_path),
                    0,
                    crate::lzpack::HEADER_LEN as u32,
                )
                .await?
        } else {
            let sftp = self.sftp(session_id).await?;
            let mut handle_slot_file = sftp
                .lock()
                .await
                .open(remote_path.to_string())
                .await
                .map_err(sftp_error)?;
            use tokio::io::AsyncReadExt;
            let mut head = vec![0_u8; crate::lzpack::HEADER_LEN];
            handle_slot_file
                .read_exact(&mut head)
                .await
                .map_err(|error| format!("Failed to read .dbxz header: {error}"))?;
            head
        };
        let original_size = crate::lzpack::read_container_original_size(&head)
            .map_err(|error| format!("Not a valid .dbxz container: {error}"))?;
        if original_size as u64 > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        // P3 顾问：显式解压下载的负收益预警（带宽 EMA + codec 吞吐齐全才
        // 说话；不拦截——用户明确要还原 .dbxz）。
        {
            let connection_id = self.session_connection_id(session_id).await;
            if let Ok(metrics) = self.transfer_metrics.lock() {
                if let Some(profile) = metrics.profile(&connection_id) {
                    let advice = crate::transfer_schedule::advise_explicit_compression(
                        original_size as u64,
                        crate::transfer_schedule::Direction::Download,
                        profile,
                        0.6,
                        crate::transfer_schedule::DEFAULT_GAIN_THRESHOLD,
                    );
                    if advice == crate::transfer_schedule::Advice::RecommendDirect {
                        eprintln!(
                            "[sftp] download {session_id} lzpack advisor: predicted gain negative on this link, expand will cost extra CPU (explicit mode proceeds)"
                        );
                    }
                }
            }
        }
        // 3) 任务注册：sink 按普通下载同款（saveToLocal 落盘由 finish 阶段
        // 处理；浏览器模式字节直接给前端），分块供给 staged plain。
        let task_id = Uuid::new_v4().to_string();
        let file_name = remote_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("download")
            .strip_suffix(".dbxz")
            .filter(|value| !value.is_empty())
            .unwrap_or(remote_path.rsplit('/').next().unwrap_or("download"))
            .to_string();
        let staging_dir = self.transfer_dir.join("downloads");
        std::fs::create_dir_all(&staging_dir)
            .map_err(|error| format!("Failed to create download staging directory: {error}"))?;
        let packed_staging = staging_dir.join(format!("download-{task_id}.part.dbxz"));
        let staged_plain = staging_dir.join(format!("download-{task_id}.plain"));
        let final_dir = if save_to_local {
            let dir = download_dir
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    local_downloads::downloads_base_dir(|key| std::env::var_os(key), &self.data_dir)
                });
            if !dir.is_absolute() {
                return Err("Download directory must be an absolute path".to_string());
            }
            std::fs::create_dir_all(&dir).map_err(|error| {
                format!(
                    "Failed to create download directory '{}': {error}",
                    dir.display()
                )
            })?;
            Some(dir)
        } else {
            None
        };
        let throttle = Throttle::new(crate::preferences::transfer_download_limit_kib(
            &self.data_dir,
        ));
        self.downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadState {
                    session_id: session_id.to_string(),
                    remote_path: remote_path.to_string(),
                    file_name: file_name.clone(),
                    size: original_size as u64,
                    next_offset: 0,
                    sink: None,
                    tree: None,
                    sudo_tmp: None,
                    latin1,
                    throttle,
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    compression: CompressionMode::None,
                    ready: false,
                    serving_plain: false,
                    staged_plain: Some(staged_plain.clone()),
                    gz_staging: Some(packed_staging.clone()),
                    remote_temp: None,
                    final_dir,
                    overwrite: matches!(conflict, Some("overwrite")),
                    read_handle: Arc::new(AsyncMutex::new(None)),
                    raw_client: Arc::new(AsyncMutex::new(None)),
                    expand_lzpack: true,
                    prefetch: Arc::new(AsyncMutex::new(None)),
                    multistream: None,
                },
            );
        // 4) prep 后台任务：拉流（packed 车道进度）→ 解压 → ready。
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_reason = Arc::new(Mutex::new(None::<String>));
        let phase = Arc::new(std::sync::Mutex::new("fetching"));
        self.download_preps
            .lock()
            .map_err(|_| "Download prep registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadPrep {
                    session_id: session_id.to_string(),
                    cancelled: cancelled.clone(),
                    cancel_reason: cancel_reason.clone(),
                    phase: Arc::new(std::sync::Mutex::new("fetching")),
                    remote_temp: None,
                    gz_staging: packed_staging.clone(),
                },
            );
        let this = self.clone();
        let prep_task_id = task_id.clone();
        let prep_session_id = session_id.to_string();
        let prep_remote_path = remote_path.to_string();
        let prep_emitter = emitter.clone();
        tokio::spawn(async move {
            let outcome = this
                .prep_lzpack_download(
                    &prep_task_id,
                    &prep_session_id,
                    &prep_remote_path,
                    packed_size,
                    original_size as u64,
                    &packed_staging,
                    &staged_plain,
                    &throttle,
                    &cancelled,
                    &phase,
                    &prep_emitter,
                )
                .await;
            match outcome {
                PrepOutcome::Ready => {
                    {
                        let mut downloads = this
                            .downloads
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner());
                        if let Some(current) = downloads.get_mut(&prep_task_id) {
                            current.ready = true;
                        }
                    }
                    this.download_preps
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .remove(&prep_task_id);
                    let _ = prep_emitter.event(
                        "sftp/transfer/progress",
                        json!({ "taskId": prep_task_id, "sessionId": prep_session_id, "direction": "download", "transferred": 0, "size": original_size, "status": "running", "phase": "ready", "compression": "lzpack" }),
                    );
                }
                PrepOutcome::Fallback(reason) => {
                    // 解压下载无「回落直传」语义：源就是 .dbxz，直传只会把
                    // 压缩件交给用户——失败终态更诚实。
                    eprintln!("[sftp] download {prep_task_id} lzpack prep failed: {reason}");
                    let _ = tokio::fs::remove_file(&packed_staging).await;
                    let _ = tokio::fs::remove_file(&staged_plain).await;
                    let downloads = this
                        .downloads
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .remove(&prep_task_id);
                    this.download_preps
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .remove(&prep_task_id);
                    if let Some(download) = downloads {
                        let task = json!({ "taskId": prep_task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": 0, "status": "failed", "error": format!("lzpack expand failed: {reason}") });
                        this.record_transfer(task.clone());
                        let _ = prep_emitter.event("sftp/transfer/progress", task);
                    }
                }
                PrepOutcome::Cancelled => {
                    let _ = tokio::fs::remove_file(&packed_staging).await;
                    let _ = tokio::fs::remove_file(&staged_plain).await;
                    this.download_preps
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .remove(&prep_task_id);
                }
            }
        });
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": 0, "size": original_size, "status": "queued", "phase": "fetching", "compression": "lzpack" }),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(session_id).await;
        self.record_transfer_start(
            &task_id,
            session_id,
            &connection_id,
            "download",
            &file_name,
            original_size as u64,
        );
        Ok(
            json!({ "taskId": task_id, "fileName": file_name, "size": original_size, "chunkSize": TRANSFER_CHUNK_SIZE, "resumeOffset": 0_u64, "saveToLocal": save_to_local, "compression": "lzpack" }),
        )
    }

    /// lzpack 下载 prep 主体（ST10）：拉 `.dbxz` 到本地暂存（车道感知分块
    /// + 限速 + 取消检查）→ spawn_blocking 自研解压 → staged plain。
    ///
    /// 任何一步失败走 Fallback（终态失败），取消走 Cancelled。
    #[allow(clippy::too_many_arguments)]
    async fn prep_lzpack_download(
        self: &Arc<Self>,
        task_id: &str,
        session_id: &str,
        remote_path: &str,
        packed_size: u64,
        original_size: u64,
        packed_staging: &Path,
        staged_plain: &Path,
        throttle: &Throttle,
        cancelled: &Arc<AtomicBool>,
        _phase: &Arc<std::sync::Mutex<&'static str>>,
        emitter: &PluginEmitter,
    ) -> PrepOutcome {
        // 车道判定在 prep 内重算（注册表快照不携带编码）：与 start 处同
        // 口径——latin-1 且 wire 含转义才走裸包。
        let raw_lane = self
            .downloads
            .lock()
            .map(|downloads| {
                downloads
                    .get(task_id)
                    .map(|download| {
                        download.latin1 && sftp_name::has_wire_escapes(&download.remote_path)
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let is_cancelled = || {
            cancelled.load(Ordering::Acquire)
                || self
                    .downloads
                    .lock()
                    .map(|downloads| !downloads.contains_key(task_id))
                    .unwrap_or(false)
        };
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
        // 1) 拉流：latin-1 裸包车道按 32KiB READ；高层车道按 256KiB READ
        // （句柄复用语义与 pull_remote_gzip 相同的循环骨架）。
        if let Err(error) = emit_phase("fetching", 0, packed_size, "lzpack") {
            return PrepOutcome::Fallback(error);
        }
        let pulled = {
            let pull_result: Result<u64, String> = async {
                let mut target = tokio::fs::OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .open(packed_staging)
                    .await
                    .map_err(|error| format!("Failed to create packed staging file: {error}"))?;
                let mut pulled = 0_u64;
                let mut progress_throttle = crate::progress_throttle::ProgressThrottle::default();
                if raw_lane {
                    // 裸包车道：逐 32KiB READ（raw 客户端单请求上限）。
                    let mut raw_slot: Option<RawSftpClient> = None;
                    let raw_path = sftp_name::unescape_wire(remote_path);
                    while pulled < packed_size {
                        if cancelled.load(Ordering::Acquire) {
                            return Err(upload_cancel_error(None));
                        }
                        let want = ((packed_size - pulled).min(32 * 1024)) as u32;
                        if raw_slot.is_none() {
                            raw_slot = Some(self.raw_sftp_client(session_id).await?);
                        }
                        let chunk = match raw_slot
                            .as_mut()
                            .expect("raw just ensured")
                            .read_chunk(&raw_path, pulled, want)
                            .await
                        {
                            Ok(chunk) => chunk,
                            Err(error) => return Err(error),
                        };
                        if chunk.is_empty() {
                            return Err("remote .dbxz truncated".to_string());
                        }
                        target
                            .write_all(&chunk)
                            .await
                            .map_err(|error| format!("Failed to write packed staging: {error}"))?;
                        pulled += chunk.len() as u64;
                        if let (true, Some(started)) =
                            (throttle.enabled(), Some(std::time::Instant::now()))
                        {
                            throttle.pace(chunk.len(), started.elapsed()).await;
                        }
                        if progress_throttle.should_emit(pulled >= packed_size) {
                            let _ = emit_phase("fetching", pulled, packed_size, "lzpack");
                        }
                    }
                } else {
                    let mut source = self
                        .sftp(session_id)
                        .await?
                        .lock()
                        .await
                        .open(remote_path.to_string())
                        .await
                        .map_err(sftp_error)?;
                    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
                    loop {
                        if cancelled.load(Ordering::Acquire) {
                            return Err(upload_cancel_error(None));
                        }
                        let chunk_started = throttle.enabled().then(std::time::Instant::now);
                        let read = source
                            .read(&mut buffer)
                            .await
                            .map_err(|error| format!("SFTP dbxz fetch failed: {error}"))?;
                        if read == 0 {
                            break;
                        }
                        target
                            .write_all(&buffer[..read])
                            .await
                            .map_err(|error| format!("Failed to write packed staging: {error}"))?;
                        pulled += read as u64;
                        if let (true, Some(started)) = (throttle.enabled(), chunk_started) {
                            throttle.pace(read, started.elapsed()).await;
                        }
                        if progress_throttle.should_emit(pulled >= packed_size) {
                            let _ = emit_phase("fetching", pulled, packed_size, "lzpack");
                        }
                    }
                }
                target
                    .flush()
                    .await
                    .map_err(|error| format!("Failed to flush packed staging: {error}"))?;
                Ok(pulled)
            }
            .await;
            match pull_result {
                Ok(pulled) => pulled,
                Err(error) => {
                    if is_cancelled() {
                        return PrepOutcome::Cancelled;
                    }
                    return PrepOutcome::Fallback(format!("dbxz fetch failed: {error}"));
                }
            }
        };
        if pulled != packed_size {
            return PrepOutcome::Fallback(format!(
                "remote .dbxz size mismatch: pulled {pulled} of {packed_size}"
            ));
        }
        if is_cancelled() {
            return PrepOutcome::Cancelled;
        }
        // 2) 自研解压（spawn_blocking；输出上限按 stat 探测的原始体积钳制
        // 由容器头声明值承担）。解压吞吐回灌 codec 档案（ST8/P3）。
        if let Err(error) = emit_phase("decompressing", 0, original_size, "lzpack") {
            return PrepOutcome::Fallback(error);
        }
        let decompress_started = std::time::Instant::now();
        let decompressed = {
            let source = packed_staging.to_path_buf();
            let target = staged_plain.to_path_buf();
            let cancelled = cancelled.clone();
            let emitter = emitter.clone();
            let task_id = task_id.to_string();
            let session_id = session_id.to_string();
            let throttle = Arc::new(std::sync::Mutex::new(
                crate::progress_throttle::ProgressThrottle::default(),
            ));
            let progress: transfer_compress::ProgressSink = Arc::new(move |bytes: u64| {
                let emit = throttle
                    .lock()
                    .map(|mut throttle| {
                        throttle.should_emit(original_size > 0 && bytes >= original_size)
                    })
                    .unwrap_or(true);
                if !emit {
                    return;
                }
                let _ = emitter.event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": bytes, "size": original_size, "status": "running", "phase": "decompressing", "compression": "lzpack" }),
                );
            });
            tokio::task::spawn_blocking(move || {
                transfer_compress::lzpack_decompress_file_to(
                    &source, &target, &cancelled, &*progress,
                )
            })
            .await
        };
        match decompressed {
            Ok(Ok(bytes)) if bytes == original_size => {
                // 解压吞吐观测（P3）：吞吐 = 原始体积/耗时；比率沿用压缩侧
                // 档案（这里没有压缩流，packed_size/original_size 同值可用）。
                let elapsed = decompress_started.elapsed();
                if elapsed.as_secs_f64() > 0.0 && original_size > 0 {
                    let decompress_rate = original_size as f64 / elapsed.as_secs_f64();
                    let connection_id = self.session_connection_id(session_id).await;
                    if let Ok(mut metrics) = self.transfer_metrics.lock() {
                        let compress_rate = metrics
                            .profile(&connection_id)
                            .and_then(|profile| profile.compress_rate);
                        let ratio = if packed_size > 0 {
                            packed_size as f64 / original_size as f64
                        } else {
                            1.0
                        };
                        metrics.observe_codec(
                            &connection_id,
                            compress_rate.unwrap_or(0.0),
                            decompress_rate,
                            ratio,
                        );
                    }
                }
                PrepOutcome::Ready
            }
            Ok(Ok(bytes)) => PrepOutcome::Fallback(format!(
                "decompressed size mismatch: {bytes} of {original_size}"
            )),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                PrepOutcome::Cancelled
            }
            Ok(Err(error)) => PrepOutcome::Fallback(format!("decompress failed: {error}")),
            Err(join_error) => {
                PrepOutcome::Fallback(format!("decompress task failed: {join_error}"))
            }
        }
    }
}
