use super::state::{DownloadPrep, DownloadState, MultistreamState};
use super::*;

impl SshRuntime {
    #[allow(clippy::too_many_arguments)]
    pub async fn start_download(
        self: &Arc<Self>,
        session_id: &str,
        remote_path: &str,
        offset: u64,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        encoding: NameEncoding,
        expand_lzpack: bool,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let remote_path = normalize_remote_path(remote_path)?;
        // 显式解压下载（ST10）：仅新任务可续传互斥与 M33 相同。压缩流体积
        // 用 SFTP stat 实测，原始体积从容器头 16 字节读出。
        if expand_lzpack {
            if offset > 0 {
                return Err("Lzpack downloads cannot resume from an offset".to_string());
            }
            return self
                .start_lzpack_download(
                    session_id,
                    &remote_path,
                    save_to_local,
                    download_dir,
                    conflict,
                    encoding,
                    emitter,
                )
                .await;
        }
        if self.active_transfer_count(session_id)? as u64 >= self.transfer_depth_limit() {
            return Err(format!(
                "This SSH session already has {} active transfers",
                self.transfer_depth_limit()
            ));
        }
        // Resume re-attaches with bytes the caller already holds locally, which
        // the staging file would be missing — only fresh downloads may sink.
        if save_to_local && offset > 0 {
            return Err("Local save downloads cannot resume from an offset".to_string());
        }
        // latin-1 生效且 wire 含 `%XX` 转义（latin-1 列表产出的非 UTF-8
        // 名字）时，走裸包 STAT 取真实字节数——高层客户端会把转义串按字
        // 面量发出去，命中不了远端文件（M14-B：传输用服务器原始字节）。
        // auto 一律走高层（M28-B 修 D-7）：auto 列表 uri 字面 `%` 未经
        // `%25` 自转义，wire 串里的 `%XX` 是文件名字面量而非转义，不能
        // 还原；车道判定统一收口在 `has_wire_lane`。
        let latin1 = encoding == NameEncoding::Latin1;
        let size = if sftp_name::has_wire_lane(&remote_path, encoding) {
            let mut client = self.raw_sftp_client(session_id).await?;
            // 整条 wire 还原为服务器字节再 LSTAT——探测点曾漏掉这一步（把
            // 字面 "%XX" 字节当路径，转义名单文件下载 start 即 NO_SUCH_FILE；
            // M21 smoke 的 latin-1 watcher 用例真机曝露）。
            client
                .stat(&sftp_name::unescape_wire(&remote_path))
                .await
                .map_err(sftp_error)?
                .size
                .unwrap_or(0)
        } else {
            let sftp = self.sftp(session_id).await?;
            let size = sftp
                .lock()
                .await
                .metadata(remote_path.clone())
                .await
                .map_err(sftp_error)?
                .size
                .unwrap_or(0);
            size
        };
        if size > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        // Resume support: the caller already holds the first `offset` bytes
        // locally and re-attaches mid-stream. Size-only identity check (a
        // changed file with the same size would splice mismatched content);
        // documented as best-effort.
        if offset > size {
            return Err(format!(
                "Resume offset {offset} is beyond the remote file size {size}"
            ));
        }
        // 压缩通道决策（M33，W6 单入口）：offset > 0（续传）与压缩互斥——
        // 压缩任务的分块读本地解压流，不支持断点拼接，续传一律回落普通管
        // 线（前端按响应 compression 字段走既有语义）。只读连接与 latin-1
        // 车道强制 None：前者远端 gzip 要写临时件，后者用户路径不进 shell。
        let compression = if offset > 0 {
            CompressionMode::None
        } else {
            let read_only = self
                .session(session_id)
                .await
                .map(|session| session.read_only)
                .unwrap_or(true);
            let decided_name = remote_path.rsplit('/').next().unwrap_or("");
            self.decide_transfer_compression(
                session_id,
                size,
                Some(decided_name),
                false,
                read_only,
                latin1,
            )
            .await
        };
        let file_name = remote_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("download")
            .to_string();
        let task_id = Uuid::new_v4().to_string();
        // 压缩任务不建 sink：解压直写独立 staged_plain，落盘目标单独记录
        // （saveToLocal 才有；浏览器模式字节在前端，终态直接删暂存）。
        let sink = if compression == CompressionMode::Gzip {
            None
        } else {
            self.build_download_sink(&task_id, download_dir, conflict)
                .await?
        };
        let final_dir = if compression == CompressionMode::Gzip && save_to_local {
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
        // 限速快照（issue #66）：偏好现值只在任务启动时读一次，整个任务
        // 沿用——设置改动对下一个下载任务生效，进行中任务节奏不抖动。
        let throttle = Throttle::new(crate::preferences::transfer_download_limit_kib(
            &self.data_dir,
        ));
        // 并发多流预读窗口（ST12，issue #237 二期）：普通单文件大下载（≥
        // `transfer_multistream_min_mib`，默认 256 MiB，0=关闭）启用并发
        // 预读（硬上限 4 流）；兼容模式/限速/裸包转义名/压缩车道回落既有
        // 单步预取。start 时现读现决——改动对下一个任务生效。
        let multistream_depth =
            transfer_multistream::window_depth(transfer_multistream::DepthInput {
                size,
                threshold_mib: crate::preferences::transfer_multistream_min_mib(&self.data_dir),
                throttle_enabled: throttle.enabled(),
                compat_mode: crate::preferences::sftp_compat_mode(&self.data_dir),
                eligible: compression == CompressionMode::None
                    && !(latin1 && sftp_name::has_wire_escapes(&remote_path)),
            });
        let multistream =
            (multistream_depth > 1).then(|| Arc::new(MultistreamState::new(multistream_depth)));
        let multistream_enabled = multistream.is_some();
        if multistream.is_some() {
            eprintln!(
                "[sftp] download {task_id} multistream read-ahead enabled (depth={multistream_depth}, size={size})"
            );
        }
        // 压缩任务的暂存/临时件路径（文件由 prep 任务创建）。
        let gz_staging = (compression == CompressionMode::Gzip).then(|| {
            self.transfer_dir
                .join("downloads")
                .join(format!("download-{task_id}.part.gz"))
        });
        let staged_plain = (compression == CompressionMode::Gzip).then(|| {
            self.transfer_dir
                .join("downloads")
                .join(format!("download-{task_id}.plain"))
        });
        let remote_temp = (compression == CompressionMode::Gzip).then(|| {
            let parent = remote_path
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .filter(|parent| !parent.is_empty())
                .unwrap_or("/");
            format!(
                "{}/.dbx-download-{task_id}.gz",
                parent.trim_end_matches('/')
            )
        });
        // prep 任务用的远端源路径（registry 插入会 move 原值，先克隆）。
        let prep_remote_path = remote_path.clone();
        self.downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadState {
                    session_id: session_id.to_string(),
                    remote_path,
                    file_name: file_name.clone(),
                    size,
                    next_offset: offset,
                    sink,
                    tree: None,
                    sudo_tmp: None,
                    latin1,
                    throttle,
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    compression,
                    ready: false,
                    serving_plain: false,
                    staged_plain: staged_plain.clone(),
                    gz_staging: gz_staging.clone(),
                    remote_temp: remote_temp.clone(),
                    final_dir,
                    overwrite: matches!(conflict, Some("overwrite")),
                    read_handle: Arc::new(AsyncMutex::new(None)),
                    raw_client: Arc::new(AsyncMutex::new(None)),
                    expand_lzpack: false,
                    prefetch: Arc::new(AsyncMutex::new(None)),
                    multistream,
                },
            );
        if compression == CompressionMode::Gzip {
            // prep 注册 + 后台任务（远端 gzip → 拉取 → 解压 → ready）。
            // 登记先于 spawn：取消 RPC 立即可见。
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_reason = Arc::new(Mutex::new(None::<String>));
            let phase = Arc::new(Mutex::new("compressing"));
            self.download_preps
                .lock()
                .map_err(|_| "Download prep registry is poisoned".to_string())?
                .insert(
                    task_id.clone(),
                    DownloadPrep {
                        session_id: session_id.to_string(),
                        cancelled: cancelled.clone(),
                        cancel_reason: cancel_reason.clone(),
                        phase: phase.clone(),
                        remote_temp: remote_temp.clone(),
                        gz_staging: gz_staging.clone().expect("gz staging path present"),
                    },
                );
            let this = self.clone();
            let prep_task_id = task_id.clone();
            let prep_session_id = session_id.to_string();
            let prep_emitter = emitter.clone();
            tokio::spawn(async move {
                this.run_download_prep(
                    prep_task_id,
                    prep_session_id,
                    prep_remote_path,
                    size,
                    gz_staging.expect("gz staging path present"),
                    staged_plain.expect("staged plain path present"),
                    remote_temp.expect("remote temp path present"),
                    throttle,
                    cancelled,
                    cancel_reason,
                    phase,
                    prep_emitter,
                )
                .await;
            });
        }
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": offset, "size": size, "status": if offset > 0 { "running" } else { "queued" } }),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(session_id).await;
        self.record_transfer_start(
            &task_id,
            session_id,
            &connection_id,
            "download",
            &file_name,
            size,
        );
        Ok(
            json!({ "taskId": task_id, "fileName": file_name, "size": size, "chunkSize": TRANSFER_CHUNK_SIZE, "resumeOffset": offset, "saveToLocal": save_to_local, "compression": compression.as_str(), "multistream": multistream_enabled }),
        )
    }
}
