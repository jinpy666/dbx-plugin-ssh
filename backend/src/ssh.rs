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
pub(crate) use transfer_paths::apply_preserved_permissions;
use transfer_paths::remote_transfer_paths;
pub use transport::RemoteForwardTable;
pub(crate) use transport::ReplayBuffer;
use tree_fs::{delete_directory_tree, publish_terminal, raw_delete_path};
use upload_meta::{copy_dir_recursive, remove_upload_meta, sweep_stale_transfer_temps};

const REMOTE_SHELL_DETECTION_TIMEOUT: Duration = Duration::from_secs(5);
/// #287：提示符尾巴必须静默这么久才当作就绪。ticker 250ms 一跳，取 150ms
/// 让「横幅分片之间的毫秒级间隔、流式输出」都不被误判，而真提示符在下一跳
/// 就会命中（用户感知上仍是即时安装）。
const PROMPT_TAIL_SETTLE: Duration = Duration::from_millis(150);
/// #287：未换行尾巴的长度上限。提示符远短于此；只有横幅长行被 SSH 拆包时
/// 才会出现更长的尾巴，那不算就绪。
const PROMPT_TAIL_LIMIT: usize = 512;

/// Error shown when a terminal-routed agent command finds no live workbench
/// PTY for its connection; the wording doubles as user guidance.
pub(crate) const NO_TERMINAL_SESSION_MESSAGE: &str =
    "No open terminal session for this connection; open the SSH workbench terminal first";

enum TerminalCommand {
    Input(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    DirectoryTracking {
        enabled: bool,
    },
    /// Session-open arming of the per-prompt hook (issue t8y2/dbx#10750): the
    /// shell type was probed off the read loop and is already resolved, so the
    /// handler never awaits the network. Non-bash/zsh shells are skipped
    /// silently — unlike the user-facing DirectoryTracking toggle there is no
    /// `directory-tracking-unavailable` event for shells that cannot host the
    /// hook (a fish/nushell user must not get a warning toast on every open).
    InstallPromptHook {
        shell: RemoteShell,
    },
    Close {
        reason: Option<&'static str>,
    },
}

/// Enqueue keyboard input with bounded backpressure instead of dropping it
/// when the PTY writer briefly falls behind. Binary input handlers run on the
/// SDK's blocking worker threads, so blocking here does not block the Tokio
/// runtime that drains the terminal channel.
fn enqueue_terminal_input(
    sender: &mpsc::Sender<TerminalCommand>,
    data: Vec<u8>,
) -> Result<(), String> {
    sender
        .blocking_send(TerminalCommand::Input(data))
        .map_err(|error| format!("SSH input queue is closed: {error}"))
}

/// Deterministic pick among a connection's live sessions: the oldest one (the
/// connection's primary workbench), by monotonic creation sequence.
/// Candidates are `(session_id, created_seq, connected)`; disconnected
/// sessions never win. Purity is the point — the caller feeds it from a
/// HashMap whose iteration order is randomized per process, and the chosen
/// session must not depend on that order (a created_at tie-break could not
/// save it: two workbenches often open within the same second).
fn select_primary_session<I>(candidates: I) -> Option<String>
where
    I: IntoIterator<Item = (String, u64, bool)>,
{
    candidates
        .into_iter()
        .filter(|(_, _, connected)| *connected)
        .min_by(|(a_id, a_created, _), (b_id, b_created, _)| {
            a_created.cmp(b_created).then_with(|| a_id.cmp(b_id))
        })
        .map(|(id, _, _)| id)
}

/// Terminal activity keepalive payload: space + backspace. Net-zero on a
/// shell prompt (an empty line never enters history), movement-only in
/// full-screen apps; protocol-level keepalives don't count as keyboard
/// activity, and idle policies that watch the PTY (TMOUT, bastion audits)
/// only real input resets.
const TERMINAL_KEEPALIVE_INPUT: &[u8] = b" \x7f";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteShell {
    Bash,
    Zsh,
    /// Shell capability has not been probed yet; keep the terminal usable.
    Unknown,
    Other,
}

/// One row of `ssh/sessions/list`. Pure so tests can exercise the payload
/// shape without a live SSH connection.
// 参数与 JSON 行字段一一对应，是纯载荷整形函数的自然形状。
#[allow(clippy::too_many_arguments)]
fn session_info_payload(
    session_id: &str,
    connection_id: &str,
    workbench_id: &str,
    read_only: bool,
    connected: bool,
    sudo_keepalive: bool,
    terminal_keepalive_secs: u64,
    created_at_secs: u64,
    auth_method: &str,
    endpoint: &ConnectionEndpoint,
    recording: bool,
) -> Value {
    json!({
        "sessionId": session_id,
        "connectionId": connection_id,
        "workbenchId": workbench_id,
        "readOnly": read_only,
        "connected": connected,
        "recording": recording,
        "sudoKeepalive": sudo_keepalive,
        "terminalKeepaliveSecs": terminal_keepalive_secs,
        "createdAt": created_at_secs,
        "authMethod": auth_method,
        "host": endpoint.host,
        "port": endpoint.port,
        "username": endpoint.username,
    })
}

/// Total order for `sftp/transfer/history` rows (issue #18). Newest first by
/// `startedAt`; rows without one — live snapshots whose start record never
/// landed on disk — count as the most recent activity and lead the list;
/// `taskId` breaks every tie so the order no longer depends on the HashMap
/// iteration order of the in-memory registries. Pure so tests can exercise
/// it without a runtime.
fn compare_history_rows(a: &Value, b: &Value) -> std::cmp::Ordering {
    fn started(task: &Value) -> Option<u64> {
        task.get("startedAt").and_then(Value::as_u64)
    }
    fn task_id(task: &Value) -> &str {
        task.get("taskId").and_then(Value::as_str).unwrap_or("")
    }
    match (started(a), started(b)) {
        (Some(left), Some(right)) => right.cmp(&left).then_with(|| task_id(a).cmp(task_id(b))),
        // Rows without a timestamp (live snapshots) lead the list as the
        // most recent activity; `Less`/`Greater` place a timestamped row
        // strictly after a timestamp-less one.
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => task_id(a).cmp(task_id(b)),
    }
}

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

fn directory_tracking_marker(session_id: &str) -> Vec<u8> {
    format!("\x1b]777;dbx-directory-ready-{session_id}\x07").into_bytes()
}

/// Decodes one terminal output frame for the text observers, carrying an
/// incomplete multi-byte UTF-8 tail over to the next call. Returns the lossy
/// decoding of the longest decodable prefix; the tail bytes wait in `carry`.
/// `error_len() == None` only happens with ≤3 bytes left, so the carry stays
/// bounded by construction; invalid sequences are flushed lossily right away
/// (one U+FFFD per maximal invalid subsequence, same output as a whole-buffer
/// `from_utf8_lossy`) so a non-UTF-8 stream keeps flowing instead of stalling.
/// 不设长度阈值：大帧（现实 SSH 数据帧普遍远超 8 字节）尾部残缺字符同样
/// 跨帧拼装，否则逐帧独立 lossy 会把字符劈成双 U+FFFD（见读循环处注释）。
fn decode_stream_text(carry: &mut Vec<u8>, data: &[u8]) -> String {
    carry.extend_from_slice(data);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(valid) => {
                text.push_str(valid);
                carry.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    text.push_str(std::str::from_utf8(&carry[..valid]).expect("validated prefix"));
                    carry.drain(..valid);
                    continue;
                }
                match error.error_len() {
                    // 残缺尾部：等下一帧拼字。
                    None => break,
                    // 非法序列：按最大子序列立即冲刷，残量不滞留。
                    Some(invalid_len) => {
                        text.push('\u{FFFD}');
                        carry.drain(..invalid_len);
                    }
                }
            }
        }
    }
    text
}

const REMOTE_EXIT_REASON: &str = "remote-exit";
const REMOTE_KILLED_REASON: &str = "remote-killed";

fn remote_channel_closed_reason(reason: Option<&'static str>) -> Option<&'static str> {
    reason.or(Some(REMOTE_EXIT_REASON))
}

/// channel 读循环结束时按 SSH 协议语义分档：shell 被信号杀死（sshd 先发
/// exit-signal，russh 映射为 `ChannelMsg::ExitSignal`）记为 `remote-killed`，
/// 干净退出（exit-status，或裸 Eof/Close 无先行状态）记为 `remote-exit`，
/// transport 自行死亡（`channel.wait()` 返回 `None`）不在此列、保持原值。
fn remote_channel_exit_reason(message: Option<ChannelMsg>) -> Option<&'static str> {
    match message {
        Some(ChannelMsg::ExitSignal { .. }) => Some(REMOTE_KILLED_REASON),
        Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
            Some(REMOTE_EXIT_REASON)
        }
        _ => None,
    }
}

fn terminal_disconnect_state(reason: Option<&'static str>) -> &'static [u8] {
    if reason == Some(REMOTE_EXIT_REASON) {
        b"ssh-session-exited"
    } else if reason == Some(REMOTE_KILLED_REASON) {
        b"ssh-session-killed"
    } else {
        b"ssh-transport-disconnected"
    }
}

fn session_disconnected_event(
    session_id: &str,
    connection_id: &str,
    reason: Option<&'static str>,
) -> Value {
    let mut payload = json!({
        "sessionId": session_id,
        "connectionId": connection_id,
        "state": "disconnected"
    });
    if let Some(reason) = reason {
        payload["reason"] = Value::from(reason);
    }
    payload
}

/// True when `output` ends on a prompt tail: non-empty and not terminated by
/// a newline. Prompts are drawn without a trailing newline, so this is the
/// signal that readline has taken over the tty (and that echoing the hook's
/// bytes is no longer possible). Mirrors the boundary judgment used by
/// [`strip_trailing_prompt`].
fn ends_with_prompt_tail(output: &[u8]) -> bool {
    !output.is_empty() && !output.ends_with(b"\n") && !output.ends_with(b"\r")
}

/// #287: decides whether the deferred shell-integration hook may be written
/// now. Only pending hooks flush, only once startup output shows a prompt
/// tail, only after that tail has been quiet for [`PROMPT_TAIL_SETTLE`], and
/// only when the tail is short enough to be a prompt rather than a banner line
/// that SSH happened to split across packets.
fn should_flush_pending_hook(pending: Option<RemoteShell>, output: &[u8], settled: bool) -> bool {
    pending.is_some()
        && settled
        && ends_with_prompt_tail(output)
        && prompt_tail_len(output) <= PROMPT_TAIL_LIMIT
}

/// Length of the unterminated trailing line in `output` (0 when it ends on a
/// line boundary). A prompt sits right after the last newline; a banner line
/// cut by packet framing is typically much longer.
fn prompt_tail_len(output: &[u8]) -> usize {
    if !ends_with_prompt_tail(output) {
        return 0;
    }
    output
        .iter()
        .rposition(|byte| matches!(byte, b'\n' | b'\r'))
        .map_or(output.len(), |index| output.len() - index - 1)
}

/// Drops the unterminated prompt line at the end of startup output. Earlier
/// banners keep their original bytes and trailing newline; a prompt-only
/// buffer becomes empty. Output already ending on a line boundary has no
/// trailing prompt to remove and passes through unchanged.
fn strip_trailing_prompt(mut data: Vec<u8>) -> Vec<u8> {
    if data.is_empty() || data.ends_with(b"\n") || data.ends_with(b"\r") {
        return data;
    }
    if let Some(index) = data.iter().rposition(|byte| matches!(byte, b'\n' | b'\r')) {
        data.truncate(index + 1);
        data
    } else {
        Vec::new()
    }
}

/// Installs the per-prompt OSC 7 hook for one interactive shell session
/// (issue t8y2/dbx#10750): bash gets a `PROMPT_COMMAND` prepend, zsh a
/// `precmd_functions` entry, each emitting `ESC]7;file://$HOST$PWD BEL`
/// immediately before every prompt draw. The frontend consumes these frames
/// twice — SFTP directory follow (as before) and the prompt-newline fix
/// (insert CRLF when the preceding output did not end on a line start). The
/// hook is session-local and idempotent (`__DBX_CWD_ACTIVE` guard), so
/// re-arming on an already-hooked shell is a no-op remotely. Arming is now
/// unconditional for the session's lifetime: there is no teardown script
/// anymore — the SFTP follow toggle turning off must not strip the frame
/// the newline fix depends on (frontend merely stops navigating).
fn directory_tracking_script(session_id: &str, shell: RemoteShell) -> String {
    let marker = format!("\\033]777;dbx-directory-ready-{session_id}\\007");
    // zsh's first `precmd_functions` run needs one extra line to trigger, so
    // the install line is followed by a blank Enter; bash's PROMPT_COMMAND
    // fires on the prompt that follows the install line by itself.
    let (body, history_flush) = match shell {
        RemoteShell::Bash => (
            r#"if [ -z "${__DBX_CWD_ACTIVE+x}" ]; then __DBX_CWD_ACTIVE=1; __DBX_OLD_HISTCONTROL_SET=${HISTCONTROL+x}; __DBX_OLD_HISTCONTROL=${HISTCONTROL-}; case ":${HISTCONTROL-}:" in *:ignorespace:*|*:ignoreboth:*) __DBX_HISTORY_NEEDS_DELETE=0 ;; *) __DBX_HISTORY_NEEDS_DELETE=1; HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;; esac; __DBX_OLD_PROMPT_COMMAND=${PROMPT_COMMAND-}; __dbx_emit_cwd(){ printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }; PROMPT_COMMAND='__dbx_emit_cwd;'"$__DBX_OLD_PROMPT_COMMAND"; if [ "$__DBX_HISTORY_NEEDS_DELETE" = 1 ]; then history -d $((HISTCMD-1)) 2>/dev/null || true; fi; unset __DBX_HISTORY_NEEDS_DELETE; fi"#,
            "",
        ),
        RemoteShell::Zsh => (
            r#"if [ -z "${__DBX_CWD_ACTIVE+x}" ]; then __DBX_CWD_ACTIVE=1; if [[ -o HIST_IGNORE_SPACE ]]; then __DBX_OLD_HIST_IGNORE_SPACE=1; else __DBX_OLD_HIST_IGNORE_SPACE=0; setopt HIST_IGNORE_SPACE; fi; __dbx_emit_cwd(){ printf '\033]7;file://%s%s\007' "${HOST:-localhost}" "$PWD"; }; typeset -ga precmd_functions; precmd_functions=(__dbx_emit_cwd ${precmd_functions:#__dbx_emit_cwd}); fi"#,
            " \r",
        ),
        // Callers only arm for bash/zsh; Unknown/Other degrade to a no-op line
        // so a stray invocation can never type garbage into a foreign shell.
        RemoteShell::Other | RemoteShell::Unknown => ("", ""),
    };
    format!(" {body}; printf '{marker}'\r{history_flush}")
}

/// Whether a terminal session opened as an interactive remote shell (and only
/// then): a spawn-exec command session or a connection-level `remote_command`
/// replaces the shell, so shell-syntax lines like the prompt hook must never
/// be typed into the channel — they would feed the command's stdin. Same
/// gating as the startup-commands injector (their input lines share the FIFO,
/// so relative order between the two is preserved whatever the send order).
fn interactive_shell_session(spawn_exec: Option<&str>, remote_command: &str) -> bool {
    spawn_exec.is_none() && remote_command.is_empty()
}

/// A caller-supplied session id is honoured only when it is safe as a registry
/// key, event-channel suffix, and shell literal: non-empty, bounded, and
/// restricted to `[A-Za-z0-9._-]`. The id is interpolated into the
/// single-quoted `printf` marker of [`directory_tracking_script`], so anything
/// shell-active (`'`, `` ` ``, `$`, …) must fall back to a server-generated
/// UUID rather than reach the remote shell.
fn valid_requested_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// WT-4 (command session) command size cap, same magnitude as the per-command
/// cap of startup commands (`startup_commands::MAX_COMMAND_BYTES`).
const SPAWN_COMMAND_MAX_BYTES: usize = 4 * 1024;

/// Normalizes the WT-4 `spawnCommand` request into the exec payload, or `None`
/// when the caller did not ask for a command session (absent or blank keeps
/// the ordinary shell / connection `remote_command` semantics). Fails closed
/// on NUL bytes (exec strings cannot carry them) and over-cap commands
/// instead of silently truncating. Pure so tests can exercise the contract
/// without a server.
fn normalized_spawn_command(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.contains('\0') {
        return Err("spawnCommand must not contain NUL bytes".to_string());
    }
    if trimmed.len() > SPAWN_COMMAND_MAX_BYTES {
        return Err(format!(
            "spawnCommand exceeds the {SPAWN_COMMAND_MAX_BYTES} byte limit"
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

/// Wraps a normalized command session command as the exec payload:
/// `sh -c '<single-quote escaped command>'` (repo hard rule: remote commands
/// are single-quote escaped). The outer login shell receives exactly one safe
/// argument so metacharacters cannot escape the quoting, while the inner
/// `sh -c` keeps full shell semantics (pipes/redirects work as typed).
/// Reuses the existing `exec::shell_quote` escaper.
fn spawn_exec_payload(command: &str) -> String {
    format!("sh -c {}", exec::shell_quote(command))
}

async fn detect_remote_shell(handle: &Handle<SshClient>) -> RemoteShell {
    remote_shell_or_timeout(
        detect_remote_shell_inner(handle),
        REMOTE_SHELL_DETECTION_TIMEOUT,
    )
    .await
}

async fn remote_shell_or_timeout<F>(future: F, timeout: Duration) -> RemoteShell
where
    F: Future<Output = RemoteShell>,
{
    tokio::time::timeout(timeout, future)
        .await
        .unwrap_or(RemoteShell::Other)
}

async fn detect_remote_shell_inner(handle: &Handle<SshClient>) -> RemoteShell {
    let Ok(mut channel) = handle.channel_open_session().await else {
        return RemoteShell::Other;
    };
    if channel.exec(true, "printf '%s' \"$SHELL\"").await.is_err() {
        return RemoteShell::Other;
    }
    let mut output = Vec::new();
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => output.extend_from_slice(&data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    classify_remote_shell(&String::from_utf8_lossy(&output))
}

fn classify_remote_shell(value: &str) -> RemoteShell {
    let shell = value.trim().replace('\\', "/");
    match shell.rsplit('/').next().unwrap_or_default() {
        "bash" => RemoteShell::Bash,
        "zsh" => RemoteShell::Zsh,
        _ => RemoteShell::Other,
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod channel_error_tests;

fn plugin_error(error: PluginError) -> String {
    error.message
}

#[cfg(test)]
mod tests;
