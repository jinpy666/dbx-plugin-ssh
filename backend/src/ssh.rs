use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use dbx_plugin_sdk::{
    host_client, PluginEmitter, PluginError, UserInputAnswer, UserInputOption, UserInputPrompt,
    HOST_REQUEST_USER_INPUT_FEATURE, HOST_REQUEST_USER_INPUT_METHOD,
};
use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::{client::AgentClient, AgentIdentity};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use russh_sftp::protocol::FileType;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, RwLock as AsyncRwLock};
use tokio::time::Instant;
use uuid::Uuid;

use crate::agent_approvals;
use crate::agent_terminal::{
    self, AgentDecision, AgentTerminalMode, CommandRisk, TerminalRecorder,
};
use crate::audit_log;
use crate::exec::{
    self, AuthFlowMode, ExecOutcome, Hints, SudoAuth, PLAIN_EXEC_TIMEOUT, SUDO_EXEC_TIMEOUT,
};
use crate::forward;
use crate::highlight_rules;
use crate::host_key::{HostKeyState, HostKeyVerifier};
use crate::local_downloads;
use crate::metrics;
use crate::metrics_history;
use crate::model::{
    normalize_remote_path, path_from_sftp_uri, sftp_uri, AuthenticationMethod, SessionOpenRequest,
    SftpEntry, StoredConnection, SudoSource, TerminalFrame, TerminalStream, MAX_TRANSFER_SIZE,
    TERMINAL_REPLAY_LIMIT, TRANSFER_CHUNK_SIZE,
};
use crate::otp;
use crate::otp_store;
use crate::quick_commands;
use crate::session_recording;
use crate::sftp_ext;
use crate::sftp_name::{self, NameEncoding};
use crate::sftp_raw;
use crate::sftp_tree;
use crate::ssh_algorithms;
use crate::startup_commands;
use crate::sudo_download;
use crate::sudo_profiles;
use crate::transfer_compress::{self, CompressionMode};
use crate::transfer_history;
use crate::transfer_multistream;
use crate::transfer_throttle::Throttle;
use crate::triggers;

mod agent_auth;
mod approval;
mod auth;
mod auth_dial;
mod auth_key;
mod download_chunk;
mod download_complete;
mod download_lzpack;
mod download_prep;
mod download_start;
mod download_sudo;
mod endpoint;
mod exec_methods;
mod host_key_support;
mod keepalive;
mod leases;
mod lifecycle;
mod monitor;
mod open_session;
mod port_forward;
mod probe;
mod prompt;
mod settings;
mod sftp_helpers;
mod sftp_ops;
mod sftp_session;
mod ssh_client;
mod state;
mod sudo_support;
mod terminal;
mod terminal_stream;
mod transfer_paths;
mod transfer_registry;
mod transport;
mod tree_chunk;
mod tree_download;
mod tree_fs;
mod upload;
mod upload_compress;
mod upload_finish;
mod upload_meta;

use agent_auth::{authenticate_agent, AgentAuthOutcome};
#[cfg(test)]
use agent_auth::{plan_agent_identity_attempt, AgentPlan, AGENT_IDENTITY_MAX_ATTEMPTS};
use auth::{
    advertised_methods, auth_partial_success, authenticate_auto, authenticate_keyboard_interactive,
    authenticate_password_or_interactive, flow_mode_name, method_offered,
};
use auth_key::authenticate_private_key_result;
pub(crate) use auth_key::private_key_decode_failure;
use endpoint::*;
use host_key_support::{
    host_key_check_response, host_key_unreachable_response, next_test_budget,
    test_dial_budget_secs, test_timeout_message, HOST_KEY_CHALLENGE_WAIT,
};
use leases::*;
pub use ssh_client::SshClient;
use ssh_client::{DialDeadline, DirectoryHandshakeFilter, HostKeyProbe, HostKeyVerdict};

pub use prompt::PromptDecision;
use prompt::*;
use sftp_helpers::*;
pub(crate) use sftp_helpers::{
    classify_raw_kind, format_permissions, lookup_owner_group_names, sftp_client_config,
    RawSftpClient,
};
pub use sftp_helpers::{connection_id_param, filesystem_path};
pub(crate) use state::upload_cancel_error;
use state::*;
use sudo_support::{
    dial_error_message, resolve_passphrase_command, resolve_password_command, ssh_client_config,
    DialTarget,
};
pub(crate) use sudo_support::{effective_sudo_profile, login_sudo_auth, resolved_sudo_auth};
pub(crate) use terminal_stream::NO_TERMINAL_SESSION_MESSAGE;
use terminal_stream::{
    compare_history_rows, decode_stream_text, detect_remote_shell, directory_tracking_marker,
    directory_tracking_script, ends_with_prompt_tail, enqueue_terminal_input, find_bytes,
    interactive_shell_session, normalized_spawn_command, remote_channel_closed_reason,
    remote_channel_exit_reason, select_primary_session, session_disconnected_event,
    session_info_payload, should_flush_pending_hook, spawn_exec_payload, strip_trailing_prompt,
    terminal_disconnect_state, valid_requested_session_id, RemoteShell, TerminalCommand,
    PROMPT_TAIL_SETTLE, REMOTE_KILLED_REASON, REMOTE_SHELL_DETECTION_TIMEOUT,
    TERMINAL_KEEPALIVE_INPUT,
};
#[cfg(test)]
use terminal_stream::{prompt_tail_len, PROMPT_TAIL_LIMIT, SPAWN_COMMAND_MAX_BYTES};
pub(crate) use transfer_paths::apply_preserved_permissions;
use transfer_paths::remote_transfer_paths;
pub use transport::RemoteForwardTable;
pub(crate) use transport::ReplayBuffer;
use tree_fs::{delete_directory_tree, publish_terminal, raw_delete_path};
use upload_meta::{copy_dir_recursive, remove_upload_meta, sweep_stale_transfer_temps};

pub struct SshRuntime {
    connections: RwLock<HashMap<String, StoredConnection>>,
    /// Hydrated `io.dbx.ssh.local` targets (`src/local_target.rs`), keyed by
    /// connection id — the scheduler task provider's "is this connection a
    /// local shell target" source of truth. Same lifecycle as `connections`:
    /// stored on `connection/connect`, dropped on `connection/disconnect`,
    /// in-memory only (the host rehydrates by opening the connection before
    /// dispatching a task).
    local_targets: RwLock<HashMap<String, crate::local_target::LocalTarget>>,
    sessions: Arc<AsyncRwLock<HashMap<String, Arc<SessionEntry>>>>,
    uploads: Mutex<HashMap<String, UploadState>>,
    finishing_uploads: Mutex<HashMap<String, FinishingUpload>>,
    /// 压缩下载 prep 在途状态（M33）；任务进入 ready 或被取消时移除。
    download_preps: Mutex<HashMap<String, DownloadPrep>>,
    downloads: Mutex<HashMap<String, DownloadState>>,
    transfer_history: Mutex<VecDeque<Value>>,
    /// 每连接传输性能档案（ST8）：上传/下载 EMA 带宽 + codec 吞吐观测。
    /// 纯内存、按连接 LRU 容量封顶（transfer_schedule::MAX_TRACKED_CONNECTIONS），
    /// 键是 connection_id——不落任何会话凭据。
    transfer_metrics: Mutex<crate::transfer_schedule::TransferMetrics>,
    sudo_keepalive: Arc<Mutex<HashMap<String, SudoKeepalive>>>,
    /// Last metrics snapshot per session, in-memory only (see `CachedMetrics`).
    metrics_cache: Mutex<HashMap<String, CachedMetrics>>,
    /// In-flight remote command executions, cancellable by exec id.
    exec_tasks: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    /// Per-connection AI terminal mode (`agentTerminalMode`), persisted in
    /// `<data_dir>/agent-modes.json` so the toolbar toggle survives sidecar
    /// restarts (an app restart must not silently drop the user's choice
    /// back to `off`).
    agent_modes: Mutex<HashMap<String, AgentTerminalMode>>,
    /// One-shot approval challenges for terminal-routed agent commands;
    /// each entry is removed as soon as it is resolved. The payload carries
    /// the context the resolver needs for the remembered-approval store and
    /// the audit ledger (the resolver only knows the challenge id).
    agent_challenges: Mutex<HashMap<String, PendingChallenge>>,
    /// Monotonic session creation counter (see `SessionEntry::created_seq`).
    session_seq: AtomicU64,
    /// Live user-facing port mappings (Xshell-style 端口映射, -L/-R):
    /// forward id -> mapping row. Runtime-scoped on purpose; rows die with
    /// their session so a closed SSH session cannot leave phantom ports.
    forwards: Arc<forward::ForwardRegistry>,
    /// One authenticated, PTY-free transport per connection with independent
    /// mappings. Serialized creation prevents duplicate dials on concurrent starts.
    forward_transports: Arc<AsyncMutex<HashMap<String, Arc<forward::ForwardTransport>>>>,
    /// Per-connection `(listen_host, bound_port) -> dial target` tables the
    /// forwarded-tcpip handler consults (see `SshClient::remote_forwards`).
    remote_tables: Arc<Mutex<HashMap<String, Arc<RemoteForwardTable>>>>,
    /// Trust-on-first-use for unknown host keys (MCP stdio mode).
    auto_trust: bool,
    /// 会话维度的「建议开启兼容模式」一次性提示标记（M14-B）：SFTP 探测
    /// 失败时提示一次，之后同一会话静默。
    compat_hinted: Mutex<HashSet<String>>,
    /// 远端压缩工具探测结果（M33）按会话缓存：`command -v` 探测在任务
    /// start 时同步执行（5s 上限），目录批量上传逐文件 start 会放大成
    /// N 次 exec。工具存在性在一条连接的生命周期内不变，会话级缓存
    /// 一次即可；连接重建产生新 session id，天然失效。
    compress_tool_probe: Mutex<HashMap<String, bool>>,
    pub prompts: PromptBroker,
    data_dir: PathBuf,
    known_hosts_path: PathBuf,
    transfer_dir: PathBuf,
}

/// A raised approval challenge: the decision channel plus the command
/// context its resolution needs (remembered-approval persistence and the
/// audit ledger).
struct PendingChallenge {
    sender: oneshot::Sender<AgentDecision>,
    connection_id: String,
    tool: String,
    command: String,
    raised_at_ms: u64,
}

impl SshRuntime {
    pub async fn set_directory_tracking(
        &self,
        session_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.session(session_id)
            .await?
            .terminal_tx
            .send(TerminalCommand::DirectoryTracking { enabled })
            .await
            .map_err(|_| "Terminal session is closed".to_string())
    }
}

#[cfg(test)]
mod channel_error_tests;

fn plugin_error(error: PluginError) -> String {
    error.message
}

#[cfg(test)]
mod tests;
