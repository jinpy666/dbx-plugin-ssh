use super::*;

/// `workbench_id` is kept with the session so attach can only restore the
/// session that belongs to the same workbench. A different workbench must open
/// its own SSH session instead of stealing another tab's PTY.
pub(super) struct SessionEntry {
    pub(super) connection_id: String,
    pub(super) workbench_id: RwLock<String>,
    pub(super) read_only: bool,
    pub(super) connected: AtomicBool,
    /// Unix seconds when the session was opened (for `ssh/sessions/list`).
    pub(super) created_at_secs: u64,
    /// Monotonic per-runtime creation counter. created_at_secs has second
    /// granularity, so two workbenches opened in the same second would tie;
    /// the sequence gives `session_id_for_connection` a true creation order.
    pub(super) created_seq: u64,
    pub(super) handle: Arc<Handle<SshClient>>,
    /// Reference-counted lifetime for the authenticated transport's jump
    /// chain. Pending copied-session opens reserve a use before awaiting.
    pub(super) transport_lease: Arc<SharedTransportLease>,
    /// Live Quick Sudo / 2FA orchestration, updatable at runtime through
    /// `ssh/settings/set` and shared by the terminal and exec paths.
    pub(super) orchestration: Arc<RwLock<SudoAuth>>,
    /// In-terminal Quick Sudo watcher. Shared so `sync_auto_sudo` can attach
    /// or detach it at runtime (a password configured after the session was
    /// opened, or the Quick Sudo toggle, must apply without reconnecting);
    /// the read loop re-locks it on every output chunk.
    pub(super) auto_sudo: Arc<Mutex<Option<exec::TerminalAutoSudo>>>,
    /// Expect-style trigger engine (tssh parity). Attached when the
    /// connection carries a `triggers` configuration; the read loop feeds it
    /// BEFORE the auto-sudo watcher (contract D1: a chunk answered by one of
    /// the two must never be answered by both).
    pub(super) triggers: Arc<Mutex<Option<triggers::TriggerEngine>>>,
    pub(super) terminal_tx: mpsc::Sender<TerminalCommand>,
    pub(super) replay: Arc<AsyncMutex<ReplayBuffer>>,
    pub(super) sftp: AsyncMutex<Option<Arc<AsyncMutex<SftpSession>>>>,
    /// Output recorder installed while an agent command runs in this
    /// session's PTY (`exec_in_terminal`); `None` outside such a run. Fed
    /// by the read loop at the same point as the auto-sudo observer.
    pub(super) agent_recorder: Arc<Mutex<Option<TerminalRecorder>>>,
    /// Session recording (`ssh/recording/start`): captures the terminal
    /// output stream into an asciicast v2 file while active. Fed by the
    /// read loop at the same point as the agent recorder; auto-stopped
    /// when the session's read loop ends.
    pub(super) session_recorder: Arc<Mutex<Option<session_recording::SessionRecorder>>>,
    /// Serializes agent-terminal executions on this session: two concurrent
    /// MCP commands must not interleave keystrokes on the same PTY or
    /// overwrite each other's recorder. Deliberately per-session (runs on
    /// different connections stay parallel) and deliberately held across the
    /// approval wait too — the wait is part of the serialization so an
    /// un-approved command cannot be raced by a second one. `Arc`-wrapped so
    /// a run can hold an owned guard across awaits.
    pub(super) agent_exec_lock: Arc<AsyncMutex<()>>,
}

pub(super) struct UploadState {
    pub(super) session_id: String,
    pub(super) remote_path: String,
    pub(super) expected_size: u64,
    pub(super) received: u64,
    pub(super) local_path: PathBuf,
    pub(super) file: std::fs::File,
    /// Staging push（`sftp/upload/chunk`）每块一发的进度事件节流。
    pub(super) progress_throttle: crate::progress_throttle::ProgressThrottle,
    /// 压缩通道（M33）：start 时决策（偏好/阈值/黑名单/远端 gunzip 探测），
    /// finish 推送前对 spool 预压。latin-1 车道在决策处强制 None。
    pub(super) compression: CompressionMode,
    /// sudo 上传车道（UploadSudo）：finish 的推送目标从目标目录 `.part`
    /// 改为登录用户可写位置的暂存件（[`sudo_upload_staging_name`]），
    /// 最终提交走 exec `sudo mv`（让位→提交→回滚）。false = 普通
    /// SFTP 车道（目标目录内暂存 + 同目录 rename 原子提交）。
    pub(super) sudo_lane: bool,
    /// 显式压缩包模式（ST10）：用户勾选后 spool 预压 `.dbxz`，远端最终
    /// 交付 `<目标名>.dbxz`——原始目标路径永不落压缩字节，不做任何远端
    /// 还原（shell-less 服务器语义成立）。与 M33 gzip 通道互斥（start
    /// 处二选一：显式 lzpack 优先）。
    pub(super) lzpack_explicit: bool,
}

/// sudo 上传车道的暂存件名（登录用户 SFTP home 下）。独立前缀
/// `.dbx-sudo-ul-` 与下载车道的 `.dbx-sudo-dl-` 互不误伤。
pub(super) fn sudo_upload_staging_name(task_id: &str) -> String {
    format!(".dbx-sudo-ul-{task_id}.part")
}

/// sudo 上传车道的 exec 超时（exec 层钳到 5..300）：chmod 快路径 30s；
/// 提交 mv 走最大档——跨文件系统时 mv 退化为复制，要给足大文件时间。
pub(super) const SUDO_UPLOAD_QUICK_SECS: u64 = 30;
pub(super) const SUDO_UPLOAD_COMMIT_SECS: u64 = 300;

/// sudo 提交体（纯函数，供单测）：`target→backup` 让位 → 暂存件 `mv` 到
/// 位 → backup 清理；mv 失败把 backup 滚回 target 后以非零退出。路径一律
/// [`shell_quote`] 单引号转义；整体再经 exec 层 `sanitize_sudo_command`
/// 包进 `sh -c '…'`。跨文件系统时 `mv` 退化为复制+删除（非原子，登记边界）。
pub(super) fn sudo_commit_body(staging: &str, target: &str, backup: &str) -> String {
    let (staging, target, backup) = (
        exec::shell_quote(staging),
        exec::shell_quote(target),
        exec::shell_quote(backup),
    );
    format!(
        "if [ -e {target} ]; then mv -f -- {target} {backup}; fi; \
         if mv -f -- {staging} {target}; then rm -f -- {backup}; exit 0; fi; \
         if [ -e {backup} ]; then mv -f -- {backup} {target}; fi; exit 1"
    )
}

/// Local (client-machine) persistence target for a download started with
/// `saveToLocal`: chunks are appended to a staging `.part` file while they
/// stream through, and `complete_download` renames it into the user's
/// Downloads folder once every byte arrived.
pub(super) struct DownloadSink {
    pub(super) part_path: PathBuf,
    pub(super) final_dir: PathBuf,
    /// 冲突策略："overwrite" 直接覆盖同名文件，否则撞名让位（" (n)"）。
    pub(super) overwrite: bool,
    pub(super) file: AsyncMutex<tokio::fs::File>,
}

#[derive(Clone)]
pub(super) struct DownloadState {
    pub(super) session_id: String,
    /// Single-file download: the file itself. Folder download: the root
    /// directory (`tree` is `Some` in that case).
    pub(super) remote_path: String,
    pub(super) file_name: String,
    /// Single-file download: file size. Folder download: aggregate byte total
    /// across the tree (the progress denominator).
    pub(super) size: u64,
    /// Single-file download: next chunk offset. Folder download: aggregate
    /// transferred bytes across finished files.
    pub(super) next_offset: u64,
    pub(super) sink: Option<Arc<DownloadSink>>,
    /// Present only for recursive folder downloads (`sftp/download/tree/start`);
    /// the chunk/finish/cancel paths branch on it while sharing the registry,
    /// progress events and cancel plumbing with plain file downloads.
    pub(super) tree: Option<TreeDownloadState>,
    /// Present only for sudo-backed downloads (`sudo/download/start`): the
    /// remote staging temp file that must be removed on finish, cancel,
    /// error and session close (`sudo_download::discard_tmp`).
    pub(super) sudo_tmp: Option<String>,
    /// 单文件下载生效编码为 latin-1（M28-B）：size 探测与分块读取按
    /// `has_wire_lane` 判裸包车道——latin-1 的 wire 域字面 `%` 已自转义，
    /// `%XX` 唯一解读是转义还原；auto 车道列表 uri 字面 `%` 未自转义
    /// （D-7），一律走高层客户端（字面量语义与列表一致）。树/sudo 任务
    /// 不经此字段分支（树按 `TreeDownloadState.latin1`，sudo 走独立车道）。
    pub(super) latin1: bool,
    /// 下载限速（issue #66）：start 时对偏好 `transfer_download_limit_kib`
    /// 的一次性快照（0=不限速）。整个任务沿用快照值——改动对下一个下载
    /// 任务生效，进行中的任务不受中途修改影响。sudo 下载车道本期不限速。
    pub(super) throttle: Throttle,
    /// `download_chunk` 每块一发的进度事件节流（clone 出来的快照不含此
    /// 字段的最新状态；决策只在 registry 锁内做）。
    pub(super) progress_throttle: crate::progress_throttle::ProgressThrottle,
    /// 压缩通道（M33）：start 时决策（偏好/阈值/黑名单/远端工具探测/只读/
    /// latin-1）。Gzip 时分块读取走本地解压后的 `staged_plain`，网络腿在
    /// prep 任务里按压缩流走；None 保持现状管线。
    pub(super) compression: CompressionMode,
    /// 压缩 prep 是否完成（ready 事件已发、分块可读）。回退（Fallback）
    /// 也置位——status 的 ready 标记是前端等待环的唯一出口。
    pub(super) ready: bool,
    /// prep 回退标记（M33）：true = 压缩决策曾判 Gzip 但 prep 失败/不划算，
    /// 分块供给走普通管线。`compression` 字段保持原决策值（status 的
    /// compression/ready 字段继续输出），分块泵按本标记分派。
    pub(super) serving_plain: bool,
    /// 压缩任务：本地解压后的 plain 暂存文件（`download-<taskId>.plain`）。
    /// 分块读取与 saveToLocal 落盘都以它为准；非压缩任务为 None。
    pub(super) staged_plain: Option<PathBuf>,
    /// 压缩任务：本地压缩流暂存（`download-<taskId>.part.gz`，树为
    /// `tree-<taskId>.tgz`），终态清理。
    pub(super) gz_staging: Option<PathBuf>,
    /// 压缩任务：远端临时压缩件（`<dir>/.dbx-download-<taskId>.gz`，树为
    /// `.dbx-tree-<taskId>.tgz`），终态 best-effort 删除。
    pub(super) remote_temp: Option<String>,
    /// 压缩任务（M33）saveToLocal 落盘目标与冲突策略——普通任务存于
    /// DownloadSink，压缩任务无 sink（解压直写 staged_plain），单独记录。
    pub(super) final_dir: Option<PathBuf>,
    pub(super) overwrite: bool,
    /// 高层车道复用的远端读句柄：逐片 OPEN+SEEK+READ+CLOSE 每片多付 2 个
    /// RTT，高延迟链路吞吐被 RTT 界死。File 的 Drop 发 close_nowait——槽位
    /// 置 None 即完成关闭，无需显式清理链。树下载不使用（逐文件换目标，
    /// 收益另计）；句柄错误时置 None 由下一片惰性重建。
    pub(super) read_handle: Arc<AsyncMutex<Option<russh_sftp::client::fs::File>>>,
    /// 裸包车道（latin-1 转义名）复用的裸包客户端：此前逐片新开一条 SFTP
    /// 子系统通道（open session + request_subsystem + INIT 握手，多付数个
    /// RTT），同一理由缓存在任务槽——单文件与树下载共用（客户端与路径
    /// 无关，逐文件的 open/close 仍按 read_chunk 语义进行）。RawSftp 的
    /// poisoned 语义本就是一次性报废：任何错误置 None 由下一片惰性重建，
    /// 重建只是多一次握手。
    pub(super) raw_client: Arc<AsyncMutex<Option<RawSftpClient>>>,
    /// 显式解压下载（ST10）：远端源是 `.dbxz`（自研格式），拉到本地暂存后
    /// 解压供给原始字节——交付物是原始文件，`.dbxz` 中间件在终态清理。与
    /// M33 gzip prep 共用「拉流 → 本地解压 → staged 分块」骨架，但不需要
    /// 远端任何工具。
    pub(super) expand_lzpack: bool,
    /// 下载预取槽（ST9）：`download_chunk` 返回第 N 块时后台预读第 N+1 块，
    /// 下一片命中直接回——消除每块一个整 RTT 的串行等待。仅普通单文件
    /// 下载启用（树/压缩/latin-1 车道维持原路径，预取收益另计）。槽值是
    /// (offset, chunk)；offset 与下一请求不一致即作废（续传跳片安全）。
    pub(super) prefetch: DownloadPrefetchSlot,
    /// 并发多流预读窗口（ST12，issue #237 二期）：大文件（≥
    /// `transfer_multistream_min_mib`，默认 256 MiB）普通单文件下载启用，
    /// 供给一块后后台并发预读未来 depth-1 块（硬上限 4 流）；Some 时
    /// `download_chunk` 走窗口车道（命中窗口直回，未命中同步读兜底），
    /// None 维持一期单步预取路径不变。树/压缩/lzpack/sudo/裸包转义/限速/
    /// 兼容模式一律 None（决策见 `transfer_multistream::window_depth`）。
    pub(super) multistream: Option<Arc<MultistreamState>>,
}

/// 并发多流预读窗口的运行态（ST12）：窗口簿记在
/// [`transfer_multistream::ReadaheadWindow`]（纯逻辑，单测覆盖），这里挂上
/// 每条流独立的远端读句柄池。SFTP 单通道多请求交错是协议原生能力
/// （request id 多路复用），N 路并发读共享一条 SFTP 子系统通道即可扩吞吐。
pub(super) struct MultistreamState {
    pub(super) window: AsyncMutex<transfer_multistream::ReadaheadWindow>,
    /// 流句柄池：槽 i 供窗口读任务专用（懒开，错误弃柄惰性重建）；同步车道
    /// 沿用 `DownloadState.read_handle`（逻辑上的槽 0）。分槽互斥保证并发读
    /// 互不阻塞——共用一把句柄锁会把并发读串行化。
    pub(super) handles: Vec<Arc<AsyncMutex<Option<russh_sftp::client::fs::File>>>>,
    /// 槽位轮转计数：稳态每次供给只回填一个新 offset，若按规划序号取槽会
    /// 恒落槽 0 把在途读串行化；全局轮转让并发任务摊到各槽（偶发同槽由
    /// 分槽互斥天然串行，仅损失一路并发，正确性不受影响）。
    pub(super) next_slot: std::sync::atomic::AtomicUsize,
}

impl MultistreamState {
    pub(super) fn new(depth: usize) -> Self {
        Self {
            window: AsyncMutex::new(transfer_multistream::ReadaheadWindow::new(depth)),
            // 窗口并发读 = depth-1 路（供给车道占 1 路同步读）；池非空保证
            // 轮转取槽恒有解。
            handles: (0..depth.saturating_sub(1).max(1))
                .map(|_| Arc::new(AsyncMutex::new(None)))
                .collect(),
            next_slot: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// 轮转取一个窗口读槽位。
    pub(super) fn pick_slot(&self) -> usize {
        self.next_slot
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            % self.handles.len()
    }

    /// 槽句柄取用（防御性取模对齐）。
    pub(super) fn stream_handle(
        &self,
        slot: usize,
    ) -> Arc<AsyncMutex<Option<russh_sftp::client::fs::File>>> {
        let slot = slot % self.handles.len();
        self.handles
            .get(slot)
            .cloned()
            .expect("multistream handle pool is non-empty")
    }
}

/// 下载预取槽类型（见 `DownloadState.prefetch`）。
pub(super) type DownloadPrefetchSlot = Arc<AsyncMutex<Option<(u64, Vec<u8>)>>>;

/// Live state of one recursive folder download. Files stream through the same
/// chunked pipeline one at a time: `current` is in flight into `sink`'s
/// staging `.part` file, which is renamed into place as soon as the file is
/// complete, so a mid-tree failure leaves no partial file behind.
#[derive(Clone)]
pub(super) struct TreeDownloadState {
    /// Fresh, collision-free local root directory created by `start`; the
    /// whole tree is removed from disk when the task is cancelled.
    pub(super) root_local: PathBuf,
    pub(super) files: VecDeque<sftp_tree::TreeFile>,
    pub(super) current: Option<sftp_tree::TreeFile>,
    pub(super) current_offset: u64,
    pub(super) sink: Option<Arc<DownloadSink>>,
    pub(super) file_count: u64,
    pub(super) files_done: u64,
    pub(super) skipped: u64,
    pub(super) failures: Vec<Value>,
    /// latin-1 连接标记：files 的 remote_path 是 wire 形式（raw 扫描），
    /// 逐文件读取必须走裸包车道——高层客户端按 UTF-8 open 字节名路径必
    /// NO_SUCH_FILE（真机 smoke 曝露的第四层 wire 缺口）。
    pub(super) latin1: bool,
}

pub(super) struct FinishingUpload {
    pub(super) session_id: String,
    pub(super) remote_path: String,
    pub(super) size: u64,
    pub(super) transferred: Arc<AtomicU64>,
    pub(super) cancelled: Arc<AtomicBool>,
    /// Cancel reason slug supplied by the workbench ("user", "ack-timeout",
    /// ...); read by the background push task so the surfaced error tells a
    /// user abort apart from an error-triggered cleanup.
    pub(super) cancel_reason: Arc<Mutex<Option<String>>>,
    /// 压缩通道（M33）：status/cancel 载荷标注（进度事件的 phase 分母以
    /// 事件自带字段为准）。
    pub(super) compression: CompressionMode,
    /// sudo 上传车道（UploadSudo）：推送暂存件路径（登录用户 home 下）。
    /// 取消收尾按它删远端暂存件，而不是目标目录的 `.dbx-upload-<task>.part`。
    pub(super) sudo_staging: Option<String>,
    /// 显式压缩包模式（ST10）：finish 推送前预压 `.dbxz`，远端交付
    /// `<推送目标>.dbxz`；原始目标路径永不触碰。
    pub(super) lzpack_explicit: bool,
}

/// 压缩下载 prep 的在途状态（M33）：`start_download`/`start_tree_download`
/// 决策压缩后 spawn 的后台任务（远端 gzip/tar → 拉取 → 本地解压/解包 →
/// ready）。`cancelled` 是取消 RPC 与 prep 循环之间的中断旗标；远端/本地
/// 临时件路径在取消与终态清理时消费。任务注册表条目消失（被取消移除）时
/// prep 循环自行收尾退出。
pub(super) struct DownloadPrep {
    pub(super) session_id: String,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) cancel_reason: Arc<Mutex<Option<String>>>,
    /// prep 当前阶段（"compressing" | "fetching" | "decompressing"），
    /// `transfer_status` 兜底轮询用。
    pub(super) phase: Arc<Mutex<&'static str>>,
    /// 远端临时压缩件（best-effort 删除）。
    pub(super) remote_temp: Option<String>,
    /// 本地压缩流暂存（删除）。
    pub(super) gz_staging: PathBuf,
}

/// 上传 spool 预压结果（M33）：Done(压缩件路径, 压缩后体积)；其余三态都
/// 回落普通推送（Cancelled 以取消错误终止任务）。
pub(super) enum SpoolCompression {
    Done(PathBuf, u64),
    Cancelled(String),
    NotWorthwhile,
    Failed(String),
}

/// 下载 prep 结果（M33）：Ready 发 ready(gzip) 事件进入分块；Fallback 清
/// 压缩产物后回普通管线并发 ready(none)；Cancelled 走取消清理（事件由
/// cancel RPC 负责）。
pub(super) enum PrepOutcome {
    Ready,
    Fallback(String),
    Cancelled,
}

/// Upload progress phase: `staging` = bytes buffered into the local spool
/// file, `compressing` = the spool is being gzip-encoded before the push
/// (compressed channel only), `uploading` = bytes actually pushed to the
/// SFTP server. The two counters restart independently, and the workbench
/// needs the marker to keep its progress bar and speed estimate honest
/// (issue #60; `compressing` added by M33).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum UploadPhase {
    Staging,
    Compressing,
    Uploading,
}

impl UploadPhase {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            UploadPhase::Staging => "staging",
            UploadPhase::Compressing => "compressing",
            UploadPhase::Uploading => "uploading",
        }
    }
}

/// Shared shape of every upload progress event; `fileName` is only present on
/// task-start events (the workbench keeps the name it already displayed).
#[allow(clippy::too_many_arguments)]
pub(super) fn upload_progress_payload(
    task_id: &str,
    session_id: &str,
    file_name: Option<&str>,
    transferred: u64,
    size: u64,
    phase: UploadPhase,
    status: &str,
    compression: CompressionMode,
) -> Value {
    let mut payload = json!({
        "taskId": task_id,
        "sessionId": session_id,
        "direction": "upload",
        "transferred": transferred,
        "size": size,
        "phase": phase.as_str(),
        "status": status,
        // M33 压缩通道标记与下载事件同语义：gzip=压缩通道，none=普通管线
        // （含预压回退后的后续事件——前端据 none 清掉徽标）。
        "compression": compression.as_str(),
    });
    if let Some(file_name) = file_name {
        payload["fileName"] = json!(file_name);
    }
    payload
}

/// Error text for a cancelled upload. The optional reason slug comes from the
/// workbench so "Upload cancelled by user" reads differently from an
/// error-triggered cleanup ("Upload cancelled (ack-timeout)").
pub(crate) fn upload_cancel_error(reason: Option<&str>) -> String {
    match reason.map(str::trim).filter(|value| !value.is_empty()) {
        Some("user") => "Upload cancelled by user".to_string(),
        Some(reason) => format!("Upload cancelled ({reason})"),
        None => "Upload cancelled".to_string(),
    }
}

/// Background `sudo -nv` refresh loop keeping a connection's sudo timestamp
/// alive, ported from tiny-rdm's sudoExecService keepalive.
pub(super) struct SudoKeepalive {
    /// Session whose transport the timestamp validation rides. The entry is
    /// replaced when a different (fresh) session registers and swept when the
    /// bound session is gone, so a re-registered connection — e.g. the host
    /// replaying `connection/connect` after a web refresh (#202) — can never
    /// inherit a keepalive pinned to a dead transport.
    pub(super) session_id: String,
    pub(super) task: tokio::task::JoinHandle<()>,
}

/// What `register_sudo_keepalive` should do with the connection's existing
/// entry (see `SudoKeepalive::keepalive_registration_plan`).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum KeepaliveRegistration {
    ReuseExisting,
    ReplaceStale,
    InsertFresh,
}

/// Last collected metrics snapshot for one session, timestamped with the
/// collection moment. Mirrors tiny-rdm's `GetLastSnapshot`: the workbench can
/// render instantly from the previous sample before a fresh poll lands.
pub(super) struct CachedMetrics {
    pub(super) value: Value,
    pub(super) collected_at: u64,
}

/// Unix seconds for the metrics cache timestamps.
pub(super) fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Unix milliseconds for audit-ledger timestamps and approval durations.
pub(super) fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Builds the response served from the snapshot cache: the stored fields plus
/// a `cachedAt` marker (Unix seconds) so callers can show the age of the data.
/// The stored snapshot itself is never mutated.
pub(super) fn cached_metrics_payload(snapshot: &Value, collected_at: u64) -> Value {
    let mut payload = snapshot.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("cachedAt".to_string(), json!(collected_at));
    }
    payload
}
