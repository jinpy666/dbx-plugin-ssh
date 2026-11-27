use super::state::{DownloadPrep, DownloadState, PrepOutcome, TreeDownloadState};
use super::tree_fs::{scan_remote_tree, scan_tree_with_raw};
use super::*;

impl SshRuntime {
    /// `sftp/download/tree/start`: recursive folder download. Pure SFTP — the
    /// remote tree is walked with `read_dir` (no shell, no remote temp
    /// archive), regular files stream one at a time through the same chunked
    /// `sftp/download/next` pipeline as plain downloads, and the local layout
    /// mirrors the remote one under a fresh, collision-free folder (empty
    /// directories included). Symlinks are never followed (cycle protection);
    /// per-file problems are recorded and skipped so one bad file cannot sink
    /// the whole tree.
    pub async fn start_tree_download(
        self: &Arc<Self>,
        session_id: &str,
        remote_path: &str,
        download_dir: Option<&str>,
        encoding: NameEncoding,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if self.active_transfer_count(session_id)? as u64 >= self.transfer_depth_limit() {
            return Err(format!(
                "This SSH session already has {} active transfers",
                self.transfer_depth_limit()
            ));
        }
        let root_remote = normalize_remote_path(remote_path)?;
        let sftp = self.sftp(session_id).await?;
        // 本地根目录：与单文件下载共用目录语义（偏好下载目录 / 自定义绝对
        // 目录），根名撞车让位 " (n)"。落点在 start 时定死，任务取消或未完成
        // 时整树删除，所以提前占名不会留下悬空目录。
        let base_dir = download_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                local_downloads::downloads_base_dir(|key| std::env::var_os(key), &self.data_dir)
            });
        if !base_dir.is_absolute() {
            return Err("Download directory must be an absolute path".to_string());
        }
        std::fs::create_dir_all(&base_dir).map_err(|error| {
            format!(
                "Failed to create download directory '{}': {error}",
                base_dir.display()
            )
        })?;
        // latin-1：本地根名用原始字节的 latin-1 解码显示名（wire 转义名按
        // 字面量落盘会变成 "%E9" 这类乱名）；auto 维持 wire 字符串。
        let root_raw = sftp_name::unescape_wire(&root_remote);
        let root_name = if encoding == NameEncoding::Latin1 {
            root_raw
                .split(|&byte| byte == b'/')
                .rev()
                .find(|part| !part.is_empty())
                .map(|part| sftp_name::decode_display_name(part, encoding).text)
                .unwrap_or_else(|| "download".to_string())
        } else {
            root_remote
                .rsplit('/')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or("download")
                .to_string()
        };
        // latin-1：远端遍历走裸包 READDIR（同一通道 LSTAT 预检 + 递归），
        // 整树路径字节保真；裸包通道建立失败回退高层遍历（只读，安全）。
        // auto 维持高层客户端（合法 UTF-8 服务器字节往返无损）。扫描前置
        // （压缩决策要总字节），扫描只读远端，与本地落点创建无顺序耦合。
        let scan = if encoding == NameEncoding::Latin1 {
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => scan_tree_with_raw(&mut client, &root_remote).await,
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte tree scan unavailable, falling back: {error}"
                    );
                    scan_remote_tree(&sftp, &root_remote).await
                }
            }
        } else {
            scan_remote_tree(&sftp, &root_remote).await
        };
        let scan = match scan {
            Ok(scan) => scan,
            Err(error) => return Err(error),
        };
        let total = scan.total_bytes();
        let file_count = scan.file_count();
        let dir_count = scan.dir_count();
        let skipped = scan.skipped;
        let task_id = Uuid::new_v4().to_string();
        // 限速快照（issue #66）：树下载与单文件同口径——偏好现值只在启动
        // 时读一次，逐文件分块循环共用同一限速器。
        let throttle = Throttle::new(crate::preferences::transfer_download_limit_kib(
            &self.data_dir,
        ));
        // 压缩树通道决策（M33）：latin-1 裸包车道强制 None（路径不进
        // shell）；空树没有传输量可省。树不做比率守卫——归档对混合内容
        // 几乎必赚，tar 头开销可忽略。（W6 单入口：latin-1 作为决策参数
        // 传入，不再在外层重复挡一道。）
        let compression = if file_count == 0 {
            CompressionMode::None
        } else {
            let read_only = self
                .session(session_id)
                .await
                .map(|session| session.read_only)
                .unwrap_or(true);
            self.decide_transfer_compression(
                session_id,
                total,
                None,
                true,
                read_only,
                encoding == NameEncoding::Latin1,
            )
            .await
        };
        // 压缩树的 staging 根建在落点目录内的隐藏目录：与最终落点同卷，
        // 完成时 rename 零拷贝落位；取消/未完成整目录拆除（与普通树的
        // root_local 清理同路径）。普通树维持现状（start 时占名）。
        let root_local = if compression == CompressionMode::Gzip {
            base_dir.join(format!(".dbx-tree-{task_id}.staging"))
        } else {
            local_downloads::final_download_path(&base_dir, &root_name, false)
        };
        std::fs::create_dir_all(&root_local).map_err(|error| {
            format!(
                "Failed to create download folder '{}': {error}",
                root_local.display()
            )
        })?;
        // 本地目录骨架先行：空目录也保留（压缩树由解包建目录，跳过）。
        if compression != CompressionMode::Gzip {
            for relative in &scan.dirs {
                let Some(path) = sftp_tree::safe_tree_path(&root_local, relative) else {
                    continue;
                };
                if let Err(error) = std::fs::create_dir_all(&path) {
                    let _ = std::fs::remove_dir_all(&root_local);
                    return Err(format!(
                        "Failed to create local folder '{}': {error}",
                        path.display()
                    ));
                }
            }
        }
        let file_name = if compression == CompressionMode::Gzip {
            // staging 目录用任务 id 命名，显示名取根名；最终落点名在完成
            // 时经 final_download_path 让位 "(n)"。
            root_name.clone()
        } else {
            root_local
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_name.to_string())
        };
        // 压缩树的压缩流暂存与远端临时件路径（文件由 prep 任务创建）。
        let gz_staging = (compression == CompressionMode::Gzip).then(|| {
            self.transfer_dir
                .join("downloads")
                .join(format!("tree-{task_id}.tgz"))
        });
        let remote_temp = (compression == CompressionMode::Gzip).then(|| {
            let parent = root_remote
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .filter(|parent| !parent.is_empty())
                .unwrap_or("/");
            format!("{}/.dbx-tree-{task_id}.tgz", parent.trim_end_matches('/'))
        });
        self.downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadState {
                    session_id: session_id.to_string(),
                    remote_path: root_remote.clone(),
                    file_name: file_name.clone(),
                    size: total,
                    next_offset: 0,
                    sink: None,
                    tree: Some(TreeDownloadState {
                        root_local: root_local.clone(),
                        files: VecDeque::from(scan.files),
                        current: None,
                        current_offset: 0,
                        sink: None,
                        file_count,
                        files_done: 0,
                        skipped,
                        failures: scan.failures,
                        latin1: encoding == NameEncoding::Latin1,
                    }),
                    sudo_tmp: None,
                    // 树任务的逐文件读取按 TreeDownloadState.latin1 判分支。
                    latin1: false,
                    throttle,
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    compression,
                    ready: false,
                    serving_plain: false,
                    staged_plain: None,
                    gz_staging: gz_staging.clone(),
                    remote_temp: remote_temp.clone(),
                    final_dir: (compression == CompressionMode::Gzip).then(|| base_dir.clone()),
                    overwrite: false,
                    read_handle: Arc::new(AsyncMutex::new(None)),
                    raw_client: Arc::new(AsyncMutex::new(None)),
                    expand_lzpack: false,
                    prefetch: Arc::new(AsyncMutex::new(None)),
                    multistream: None,
                },
            );
        if compression == CompressionMode::Gzip {
            // prep 注册 + 后台任务（远端 tar.gz → 拉取 → 本地解包 → ready）。
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_reason = Arc::new(Mutex::new(None::<String>));
            let phase = Arc::new(Mutex::new("compressing"));
            // Fallback 补建空目录骨架用（评审 L-3）：普通树在 start 建骨架，
            // 压缩树由解包建目录、跳过空目录——回退普通管线后由 prep 补。
            let tree_dirs: Arc<[String]> = scan.dirs.clone().into();
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
            let prep_remote_root = root_remote.clone();
            let prep_emitter = emitter.clone();
            tokio::spawn(async move {
                this.run_tree_prep(
                    prep_task_id,
                    prep_session_id,
                    prep_remote_root,
                    total,
                    gz_staging.expect("gz staging path present"),
                    root_local,
                    remote_temp.expect("remote temp path present"),
                    throttle,
                    tree_dirs,
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
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "fileName": file_name, "transferred": 0, "size": total, "status": "queued", "fileCount": file_count, "compression": compression.as_str() }),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(session_id).await;
        self.record_transfer_start(
            &task_id,
            session_id,
            &connection_id,
            "download",
            &file_name,
            total,
        );
        Ok(
            json!({ "taskId": task_id, "fileName": file_name, "size": total, "chunkSize": TRANSFER_CHUNK_SIZE, "fileCount": file_count, "dirCount": dir_count, "skippedCount": skipped, "compression": compression.as_str() }),
        )
    }

    /// 压缩树 prep 终态分发（M33）：与单文件 run_download_prep 同构——
    /// Ready 发 ready(gzip)；Fallback 清压缩产物、registry 回普通管线并发
    /// ready(none)；Cancelled 走取消清理。staging 树（root_local）不属于
    /// 压缩产物：Fallback/Cancelled 的整树拆除由 cancel/complete 的既有
    /// root_local 语义负责，这里只清 .tgz 两侧临时件。
    #[allow(clippy::too_many_arguments)]
    async fn run_tree_prep(
        self: &Arc<Self>,
        task_id: String,
        session_id: String,
        remote_root: String,
        size: u64,
        gz_staging: PathBuf,
        staging_root: PathBuf,
        remote_temp: String,
        throttle: Throttle,
        dirs: Arc<[String]>,
        cancelled: Arc<AtomicBool>,
        _cancel_reason: Arc<Mutex<Option<String>>>,
        phase: Arc<Mutex<&'static str>>,
        emitter: PluginEmitter,
    ) {
        let outcome = self
            .prep_tree_staging(
                &task_id,
                &session_id,
                &remote_root,
                size,
                &gz_staging,
                &staging_root,
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
                eprintln!("[sftp] tree download {task_id} compressed prep fallback: {reason}");
                self.cleanup_compressed_download(
                    &session_id,
                    Some(&remote_temp),
                    Some(&gz_staging),
                    None,
                )
                .await;
                // 空目录也保留（与普通树同语义，评审 L-3）：压缩决策的骨架
                // 跳过在 Fallback 时补建——分块泵只为文件建父目录，空目录
                // 只能在这里补。失败不阻断（后续文件上传会按父目录建链）。
                for relative in dirs.iter() {
                    let Some(path) = sftp_tree::safe_tree_path(&staging_root, relative) else {
                        continue;
                    };
                    if let Err(error) = std::fs::create_dir_all(&path) {
                        eprintln!(
                            "[sftp] tree download {task_id} fallback skeleton failed: {error}"
                        );
                        break;
                    }
                }
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
                self.cleanup_compressed_download(
                    &session_id,
                    Some(&remote_temp),
                    Some(&gz_staging),
                    None,
                )
                .await;
                self.download_preps
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&task_id);
            }
        }
    }

    /// 压缩树 prep 主体（M33）：远端 `tar -czf`（相对根目录打包，成员名
    /// 不带绝对路径）→ 拉取 .tgz → 本地解包进 staging 根（跳过链接与特
    /// 殊文件，与普通树「不跟随 symlink」语义对齐）。不做比率守卫（归档
    /// 对混合内容几乎必赚）。任一步取消即中断；远端 tar 失败/解包失败回
    /// 落普通树管线。
    #[allow(clippy::too_many_arguments)]
    async fn prep_tree_staging(
        self: &Arc<Self>,
        task_id: &str,
        session_id: &str,
        remote_root: &str,
        size: u64,
        gz_staging: &Path,
        staging_root: &Path,
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
        let is_cancelled = || {
            cancelled.load(Ordering::Acquire)
                || self
                    .downloads
                    .lock()
                    .map(|downloads| !downloads.contains_key(task_id))
                    .unwrap_or(false)
        };
        set_phase("compressing");
        if let Err(error) = emit_phase("compressing", 0, size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        // 相对打包：`-C <root> .` 让成员名形如 `./relative/path`，解包后
        // 直接对齐扫描得到的相对路径（免 --strip-components 的兼容面）。
        let command = transfer_compress::remote_tar_command(remote_root, remote_temp);
        match self
            .exec(session_id, None, &command, false, Some(300))
            .await
        {
            Ok(outcome) if outcome.get("exitCode").and_then(Value::as_i64) == Some(0) => {}
            Ok(outcome) => {
                let output = outcome
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(200)
                    .collect::<String>();
                return PrepOutcome::Fallback(format!("remote tar failed: {output}"));
            }
            Err(error) => return PrepOutcome::Fallback(format!("remote tar failed: {error}")),
        }
        if is_cancelled() {
            return PrepOutcome::Cancelled;
        }
        let tgz_size = match self.sftp(session_id).await {
            Ok(sftp) => match sftp.lock().await.metadata(remote_temp.to_string()).await {
                Ok(attributes) => attributes.size.unwrap_or(0),
                Err(error) => {
                    return PrepOutcome::Fallback(format!("remote tgz stat failed: {error}"))
                }
            },
            Err(error) => return PrepOutcome::Fallback(format!("session unavailable: {error}")),
        };
        set_phase("fetching");
        if let Err(error) = emit_phase("fetching", 0, tgz_size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        if let Err(error) = self
            .pull_remote_gzip(
                session_id,
                remote_temp,
                gz_staging,
                tgz_size,
                task_id,
                throttle,
                cancelled,
                phase,
                emitter,
            )
            .await
        {
            if is_cancelled() {
                return PrepOutcome::Cancelled;
            }
            return PrepOutcome::Fallback(format!("tgz fetch failed: {error}"));
        }
        if is_cancelled() {
            return PrepOutcome::Cancelled;
        }
        set_phase("decompressing");
        if let Err(error) = emit_phase("decompressing", 0, size, "gzip") {
            return PrepOutcome::Fallback(error);
        }
        let extracted = {
            let archive = gz_staging.to_path_buf();
            let root = staging_root.to_path_buf();
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
                transfer_compress::extract_tar_gz(&archive, &root, &cancelled, &*progress)
            })
            .await
        };
        match extracted {
            Ok(Ok(_bytes)) => PrepOutcome::Ready,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {
                PrepOutcome::Cancelled
            }
            Ok(Err(error)) => PrepOutcome::Fallback(format!("tar extract failed: {error}")),
            Err(join_error) => PrepOutcome::Fallback(format!("extract task failed: {join_error}")),
        }
    }

    /// 把本地推进的树状态零拷贝转移回 registry（替代逐字段深拷贝）：动态容器
    /// （files/failures/current/sink）整体 swap O(1)，标量直接赋值。调用后本地
    /// `tree` 持有旧 registry 状态，调用方不得再读。每 chunk 深拷贝整树是
    /// review 定位的下载热路径分配/锁竞争热点（万文件树 × 每 256KiB 一次）。
    /// 入口处的 `download.tree.clone()`（每调用一次、从 registry 取初始状态）
    /// 保留；若要彻底消除，需 registry 改存 `Arc<Mutex<TreeDownloadState>>`，
    /// 字段访问面大，不在本切口内。
    pub(super) fn store_tree_state(
        tree_state: &mut TreeDownloadState,
        tree: &mut TreeDownloadState,
    ) {
        tree_state.current_offset = tree.current_offset;
        tree_state.files_done = tree.files_done;
        tree_state.skipped = tree.skipped;
        std::mem::swap(&mut tree_state.files, &mut tree.files);
        std::mem::swap(&mut tree_state.failures, &mut tree.failures);
        std::mem::swap(&mut tree_state.current, &mut tree.current);
        std::mem::swap(&mut tree_state.sink, &mut tree.sink);
    }
}
