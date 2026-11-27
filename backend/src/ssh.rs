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

mod approval;
mod auth;
mod auth_key;
mod download_chunk;
mod download_complete;
mod download_lzpack;
mod download_prep;
mod download_start;
mod download_sudo;
mod endpoint;
mod exec_methods;
mod keepalive;
mod leases;
mod monitor;
mod prompt;
mod settings;
mod sftp_helpers;
mod sftp_ops;
mod sftp_session;
mod ssh_client;
mod state;
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

use auth::{
    advertised_methods, auth_partial_success, authenticate_auto, authenticate_keyboard_interactive,
    authenticate_password_or_interactive, flow_mode_name, method_offered,
};
use auth_key::authenticate_private_key_result;
pub(crate) use auth_key::private_key_decode_failure;
use endpoint::*;
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
pub(crate) use transfer_paths::apply_preserved_permissions;
use transfer_paths::remote_transfer_paths;
pub use transport::RemoteForwardTable;
pub(crate) use transport::ReplayBuffer;
use tree_fs::{delete_directory_tree, publish_terminal, raw_delete_path};
use upload_meta::{copy_dir_recursive, remove_upload_meta, sweep_stale_transfer_temps};

/// 绑定的 OTP 库条目（经共享防重放缓存，同窗口码不重复发出）→ 既有
/// Quick Sudo 全局/自定义链（完全不动，见 `login_sudo_auth`/`apply_profile`）。
fn sudo_auth_for(connection: &StoredConnection) -> SudoAuth {
    let mut auth = SudoAuth::new(
        &connection.sudo_password,
        &connection.password,
        &connection.totp_secret,
        Hints {
            password: exec::sanitize_prompt_hint(&connection.password_prompt_hint),
            totp: exec::sanitize_prompt_hint(&connection.totp_prompt_hint),
            flow_mode: (!connection.auth_flow_mode.is_empty())
                .then(|| AuthFlowMode::parse(&connection.auth_flow_mode)),
        },
    );
    auth.otp_ledger_scope =
        exec::otp_ledger_scope_for(&connection.username, &connection.host, connection.port);
    if auth.totp_secrets.is_empty() && auth.flow_mode != Some(AuthFlowMode::Off) {
        // 本窗口码已被 otp/generate（或一次应答）发出时 take 返回 None：
        // 等下一周期，期间保持现状链（不追加、不报错）。
        if let Some(bound) = otp_store::data_dir()
            .and_then(|dir| otp_store::take_connection_totp_key(&dir, &connection.id))
        {
            auth.totp_secrets.push(otp_bound_as_totp_secret(bound));
        }
    }
    auth
}

/// 把绑定条目的解析结果映射为 exec 编排的 TOTP 密钥（算法/位数/周期原样）。
fn otp_bound_as_totp_secret(bound: otp_store::BoundTotp) -> exec::TotpSecret {
    exec::TotpSecret::Key {
        key: bound.key,
        digits: u32::from(bound.digits),
        period: bound.period,
        algorithm: match bound.algorithm {
            otp::OtpAlgorithm::Sha1 => exec::TotpAlgorithm::Sha1,
            otp::OtpAlgorithm::Sha256 => exec::TotpAlgorithm::Sha256,
            otp::OtpAlgorithm::Sha512 => exec::TotpAlgorithm::Sha512,
        },
    }
}

/// Builds the client negotiation config for one connection. The connection
/// form carries no algorithm selector: every connection offers the full
/// supported set (see `ssh_algorithms::preferred`). DH GEX group bounds
/// mirror ssh(1)'s 2048/3072/8192 because russh's 3072-bit default minimum
/// rejects appliances whose largest moduli are 2048 bits, and russh aborts
/// the handshake when the returned prime falls outside these bounds.
fn ssh_client_config(connection: &StoredConnection) -> client::Config {
    client::Config {
        nodelay: true,
        keepalive_interval: (connection.keepalive_interval_secs > 0)
            .then(|| Duration::from_secs(connection.keepalive_interval_secs)),
        keepalive_max: 3,
        preferred: ssh_algorithms::preferred(),
        gex: client::GexParams::new(2048, 3072, 8192).expect("static GEX bounds are valid"),
        ..Default::default()
    }
}

/// Translates the opaque handshake errors legacy appliances produce into a
/// hint that names the likely device gap, without pretending the cause is
/// certain (russh reports several KEX framing failures as `KexInit` too).
fn dial_error_message(error: russh::Error) -> String {
    let base = format!("SSH connection failed: {error}");
    match error {
        russh::Error::KexInit => format!(
            "{base}. The server aborted key exchange; on legacy appliances this \
             usually means its DH moduli are smaller than the requested group \
             size (2048-bit minimum) or it only offers algorithms this client \
             does not implement"
        ),
        _ => base,
    }
}

/// Resolved Quick Sudo source for one connection: the connection's own
/// credential pipeline, overridden wholesale by the globally bound profile
/// when one is bound ("select a global config or use this connection's own").
pub(crate) fn resolved_sudo_auth(
    connection: &StoredConnection,
    profile: Option<&sudo_profiles::SudoProfile>,
) -> SudoAuth {
    let mut auth = sudo_auth_for(connection);
    if let Some(profile) = profile {
        sudo_profiles::apply_profile(&mut auth, profile, &connection.password);
    }
    auth
}

/// Credentials for the *login* keyboard-interactive exchange. The flow mode,
/// TOTP secrets and prompt hints follow the same effective source as Quick
/// Sudo, with one distinction that mirrors the connection form:
///
/// * `global` — the form hides the 2FA four-piece set because the profile owns
///   those credentials, so the profile replaces the connection's values
///   wholesale (a fresh global connection still carries the `off` default).
/// * `custom` — the form shows the fields, so an explicitly configured
///   connection value wins and the bound profile (0.4.x legacy binding) only
///   fills what the connection leaves empty.
///
/// The password half is always the login password: a login prompt answered
/// with a separate sudo password can only fail authentication, and it would
/// hand a privileged credential to the host for nothing.
pub(crate) fn login_sudo_auth(
    connection: &StoredConnection,
    profile: Option<&sudo_profiles::SudoProfile>,
) -> SudoAuth {
    let mut auth = sudo_auth_for(connection);
    if let Some(profile) = profile {
        if connection.sudo_source == SudoSource::Global {
            sudo_profiles::apply_profile(&mut auth, profile, &connection.password);
        } else {
            if auth.totp_secrets.is_empty() {
                auth.totp_secrets = exec::parse_totp_secrets(&profile.totp_secret);
            }
            if auth.password_prompt_hint.is_empty() {
                auth.password_prompt_hint =
                    exec::sanitize_prompt_hint(&profile.password_prompt_hint);
            }
            if auth.totp_prompt_hint.is_empty() {
                auth.totp_prompt_hint = exec::sanitize_prompt_hint(&profile.totp_prompt_hint);
            }
            if auth.flow_mode.is_none() && !profile.auth_flow_mode.trim().is_empty() {
                auth.flow_mode = Some(AuthFlowMode::parse(&profile.auth_flow_mode));
            }
        }
    }
    auth.password = connection.password.clone();
    auth
}

/// Placeholder context for a connection's local credential commands
/// (`%h` host, `%u` username, `%p` port, `%n` connection name or id).
fn credential_placeholders(connection: &StoredConnection) -> triggers::CommandPlaceholders {
    triggers::CommandPlaceholders::new(
        &connection.host,
        &connection.username,
        connection.port,
        connection.name.as_deref().unwrap_or(&connection.id),
    )
}

/// D9: resolves `password_command` when the connection stores no explicit
/// login password (explicit credentials always win). The command runs once
/// per dial; the log records only execution success/failure — never the
/// command or its output. Failure falls back to the empty password so the
/// auth chain can proceed (and fail) normally.
async fn resolve_password_command(connection: &StoredConnection) -> StoredConnection {
    if !connection.password.is_empty() || connection.password_command.is_empty() {
        return connection.clone();
    }
    match triggers::run_credential_command(
        &connection.password_command,
        &credential_placeholders(connection),
    )
    .await
    {
        Ok(answer) => {
            eprintln!(
                "[ssh] password command executed for connection {}",
                connection.id
            );
            let mut resolved = connection.clone();
            resolved.password = answer.to_string();
            resolved
        }
        Err(error) => {
            eprintln!(
                "[ssh] password command failed for connection {}: {error}",
                connection.id
            );
            connection.clone()
        }
    }
}

/// D9: runs `passphrase_command` for an encrypted private key that could not
/// be decoded without a passphrase; `None` on failure (logged, output never).
async fn resolve_passphrase_command(connection: &StoredConnection) -> Option<String> {
    match triggers::run_credential_command(
        &connection.passphrase_command,
        &credential_placeholders(connection),
    )
    .await
    {
        Ok(answer) => {
            eprintln!(
                "[ssh] passphrase command executed for connection {}",
                connection.id
            );
            Some(answer.to_string())
        }
        Err(error) => {
            eprintln!(
                "[ssh] passphrase command failed for connection {}: {error}",
                connection.id
            );
            None
        }
    }
}

/// The Quick Sudo profile in effect under the connection's declared source
/// (form field `sudo_source`): "global" resolves the form profile reference
/// first (id or exact name) and falls back to the persisted workbench
/// binding; "custom" keeps only the binding overlay (legacy parity with
/// 0.4.x, where a workbench binding owned the source); "off" never promotes
/// a profile. Unresolvable references degrade to no profile instead of
/// failing the connection.
pub(crate) fn effective_sudo_profile(
    connection: &StoredConnection,
    store: &sudo_profiles::SudoProfileStore,
) -> Option<sudo_profiles::SudoProfile> {
    match connection.sudo_source {
        SudoSource::Off => None,
        SudoSource::Custom => sudo_profiles::bound_profile(store, &connection.id).cloned(),
        SudoSource::Global => sudo_profiles::find_by_ref(store, connection.sudo_profile_ref.trim())
            .or_else(|| sudo_profiles::bound_profile(store, &connection.id))
            .cloned(),
    }
}

/// How the next SSH hop is reached: a fresh TCP connection, a
/// direct-tcpip channel tunneled through an established jump-host handle,
/// or a pre-connected stream punched through an outbound proxy (#324).
enum DialTarget {
    Tcp((String, u16)),
    JumpStream(russh::ChannelStream<russh::client::Msg>),
    Proxied(Box<dyn crate::proxy::ProxyStream>),
}

impl DialTarget {
    async fn through_jump(jump: &Handle<SshClient>, host: &str, port: u16) -> Result<Self, String> {
        let channel = jump
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await
            .map_err(|error| format!("Failed to open tunnel to {host}:{port}: {error}"))?;
        Ok(Self::JumpStream(channel.into_stream()))
    }
}

const DIRECTORY_HANDSHAKE_LIMIT: usize = 64 * 1024;
const DIRECTORY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
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

/// Default wait for an agent approval decision, clamped to the 10-300
/// seconds band (the same shape as the exec timeout clamps).
const AGENT_APPROVAL_DEFAULT_SECS: u64 = 120;
const AGENT_APPROVAL_MIN_SECS: u64 = 10;
const AGENT_APPROVAL_MAX_SECS: u64 = 300;
/// Fixed wait for the MCP confirm permission gate (IMPL_PLAN §1.3: 120s,
/// clamped 10–300 by design for any future configurability).
const MCP_CONFIRM_TIMEOUT_SECS: u64 = 120;

/// Host-key challenges wait up to this long for a decision; the value also
/// caps how far the dial deadline may be pushed out while a challenge runs.
const HOST_KEY_CHALLENGE_WAIT: Duration = Duration::from_secs(300);

/// Response payload for `ssh/host-key/check`. Split from the probe path so
/// the state mapping is unit-testable without a server.
fn host_key_check_response(verdict: &HostKeyVerdict, key_type: &str, fingerprint: &str) -> Value {
    let state = match verdict {
        HostKeyVerdict::Trusted => "trusted",
        HostKeyVerdict::Unknown => "unknown",
        HostKeyVerdict::Changed(_) => "changed",
    };
    json!({
        "state": state,
        "keyType": key_type,
        "fingerprint": fingerprint,
    })
}

fn host_key_unreachable_response(error: String) -> Value {
    json!({ "state": "unreachable", "error": error })
}

/// Host-side RPC deadline fallback for `connection/test` when the stored
/// connection omits `connect_timeout_secs`: the host materializes 0/absent
/// via dbx-core `default_connect_timeout_secs()` = 10s
/// (crates/dbx-core/src/models/connection.rs:501) — NOT this plugin's
/// manifest default of 30s. Keep in sync with the host.
const HOST_FALLBACK_CONNECT_TIMEOUT_SECS: u64 = 10;

/// `connection/test` dial budget: the host kills the RPC at the effective
/// connect timeout, so the sidecar must answer one second earlier (the
/// margin covers stdio write→parse→dispatch latency), floored at 1s. An
/// explicit `connect_timeout_secs` is the deadline itself; an absent one
/// means the host falls back to its own 10s default.
fn test_dial_budget_secs(connect_timeout_secs: u64, explicit: bool) -> u64 {
    let deadline = if explicit {
        connect_timeout_secs.max(1)
    } else {
        HOST_FALLBACK_CONNECT_TIMEOUT_SECS
    };
    deadline.saturating_sub(1).max(1)
}

/// Re-arm decision for the `connection/test` budget once it elapsed: a host
/// dialog keeps the probe parked past the mirrored dial budget, so when the
/// dialog path is serving the challenge the budget extends once by the
/// challenge wait plus the connect timeout. Every other timeout (1.0 hosts,
/// workbench fallback, already-extended window) returns `None` and keeps the
/// readable error. Callers fold the already-extended state into
/// `dialog_used` so the extension can only arm a single time.
fn next_test_budget(connect_timeout_secs: u64, dialog_used: bool) -> Option<u64> {
    dialog_used.then(|| {
        HOST_KEY_CHALLENGE_WAIT
            .as_secs()
            .saturating_add(connect_timeout_secs)
    })
}

/// Actionable `connection/test` timeout: the cryptic host RPC-timeout
/// message gave no remedy; this names the effective budget (flagged as the
/// host default when the field was absent) plus the user-side fix. When a
/// host-key confirmation was raised during the probe, the challenge note is
/// appended in addition to the timeout-setting remedy — and only when the
/// dialog path did not serve the challenge, so the "update DBX" advice stays
/// truthful for 1.0 hosts.
fn test_timeout_message(
    host: &str,
    port: u16,
    budget_secs: u64,
    host_default: bool,
    challenge_raised: bool,
) -> String {
    let source = if host_default { " (host default)" } else { "" };
    let mut message = format!(
        "SSH connection to {host}:{port} timed out after {budget_secs} seconds{source}. Increase 'SSH timeout' under Advanced options and retry."
    );
    if challenge_raised {
        message.push_str(
            " A host-key confirmation was raised but went unanswered; connect once from the SSH workbench to trust this host, or update DBX to 0.6.17+ so the confirmation can appear here.",
        );
    }
    message
}

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
    pub fn new(data_dir: PathBuf) -> Self {
        let transfer_dir = data_dir.join("transfers");
        let known_hosts_path = data_dir.join("known_hosts");
        let _ = std::fs::create_dir_all(&transfer_dir);
        sweep_stale_transfer_temps(&transfer_dir);
        Self {
            connections: RwLock::new(HashMap::new()),
            local_targets: RwLock::new(HashMap::new()),
            sessions: Arc::new(AsyncRwLock::new(HashMap::new())),
            uploads: Mutex::new(HashMap::new()),
            finishing_uploads: Mutex::new(HashMap::new()),
            download_preps: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            transfer_history: Mutex::new(VecDeque::new()),
            transfer_metrics: Mutex::new(crate::transfer_schedule::TransferMetrics::new()),
            session_seq: AtomicU64::new(0),
            sudo_keepalive: Arc::new(Mutex::new(HashMap::new())),
            metrics_cache: Mutex::new(HashMap::new()),
            exec_tasks: Mutex::new(HashMap::new()),
            forwards: Arc::new(forward::ForwardRegistry::default()),
            forward_transports: Arc::new(AsyncMutex::new(HashMap::new())),
            remote_tables: Arc::new(Mutex::new(HashMap::new())),
            agent_modes: Mutex::new(agent_terminal::load_modes(&data_dir)),
            agent_challenges: Mutex::new(HashMap::new()),
            auto_trust: false,
            compat_hinted: Mutex::new(HashSet::new()),
            compress_tool_probe: Mutex::new(HashMap::new()),
            prompts: PromptBroker::default(),
            data_dir,
            known_hosts_path,
            transfer_dir,
        }
    }

    /// Root directory holding plugin-owned state (known_hosts, transfers,
    /// mcp-settings.json).
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    /// Whether an SSH connection with this id is registered. `connection/protocol`
    /// uses it to answer `"ssh"` instead of an empty string: the host pushes
    /// `connection/connect` (which registers the connection here) before it creates
    /// the webview, so the first query already knows the protocol and the frontend
    /// stops burning its retry window on a question that never had an answer.
    pub fn has_connection(&self, connection_id: &str) -> bool {
        self.connections
            .read()
            .map(|connections| connections.contains_key(connection_id))
            .unwrap_or(false)
    }

    pub fn store_connection(&self, connection: StoredConnection) -> Result<(), String> {
        let connection_id = connection.id.clone();
        self.connections
            .write()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .insert(connection_id.clone(), connection);
        // `connection/connect` can refresh a saved connection while a session
        // is already live. Reconcile the trigger engine immediately so turning
        // the form switch off cannot leave the old engine armed.
        let live_sessions: Vec<Arc<SessionEntry>> = self
            .sessions
            .try_read()
            .map_err(|_| "Session registry is busy".to_string())?
            .values()
            .filter(|entry| entry.connection_id == connection_id)
            .cloned()
            .collect();
        if !live_sessions.is_empty() {
            let current = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?
                .get(&connection_id)
                .cloned()
                .ok_or_else(|| "Connection disappeared after update".to_string())?;
            for entry in live_sessions {
                Self::sync_triggers(&entry, &current);
                Self::sync_auto_sudo(&entry, &current);
            }
        }
        // #202: a replayed `connection/connect` (web 刷新后宿主重新下发凭据、
        // 连接表单保存后 reopen 等) must land the runtime in the exact state a
        // fresh registration would have: auxiliary state that only
        // `close_session` / `disconnect_connection` would otherwise clean is
        // swept here, so a stale entry can never degrade or wedge the next
        // connect.
        self.sweep_reconnect_residue(&connection_id);
        Ok(())
    }

    /// Best-effort sweep of stale per-connection / per-session auxiliary
    /// state after `connection/connect` re-registered `connection_id`
    /// (issue #202). Best-effort on purpose: a contended session registry
    /// must never fail the lifecycle push, and every swept entry has a
    /// normal owner (`close_session` / `disconnect_connection`) that would
    /// clean it anyway on the ordinary path.
    fn sweep_reconnect_residue(&self, connection_id: &str) {
        let Ok(sessions) = self.sessions.try_read() else {
            return;
        };
        let live_session_ids: std::collections::HashSet<String> =
            sessions.keys().cloned().collect();
        let connection_has_live_session = sessions
            .values()
            .any(|entry| entry.connection_id == connection_id);
        drop(sessions);
        // Sudo keepalive pinned to a session that no longer exists: the
        // stale loop keeps validating against a dead transport, and the old
        // `contains_key` early-return would mute the next session's own
        // keepalive until the stale one died off on its own.
        if let Ok(mut keepalive) = self.sudo_keepalive.lock() {
            let stale = match keepalive.get(connection_id) {
                Some(entry) => !live_session_ids.contains(&entry.session_id),
                None => false,
            };
            if stale {
                if let Some(entry) = keepalive.remove(connection_id) {
                    entry.task.abort();
                }
            }
        }
        // Per-connection forwarded-tcpip table without a live session can
        // never match again (same rule as close_session's backstop).
        if !connection_has_live_session {
            if let Ok(mut tables) = self.remote_tables.lock() {
                tables.remove(connection_id);
            }
        }
        // Per-session caches whose session id is no longer registered —
        // refresh-orphaned entries whose removal raced the transport death.
        // Keyed globally by session id, so prune against the full live set.
        if let Ok(mut cache) = self.metrics_cache.lock() {
            cache.retain(|session_id, _| live_session_ids.contains(session_id));
        }
        if let Ok(mut hinted) = self.compat_hinted.lock() {
            hinted.retain(|session_id| live_session_ids.contains(session_id));
        }
        if let Ok(mut probe) = self.compress_tool_probe.lock() {
            probe.retain(|session_id, _| live_session_ids.contains(session_id));
        }
    }

    pub async fn disconnect_connection(&self, connection_id: &str) -> Result<(), String> {
        // 性能档案随连接销毁（ST8/P3）：EMA/codec 观测是连接级的，重连后的
        // 链路可能完全不同，旧档案只会污染下一次顾问预测。容量封顶之外的
        // 主动清理面（任务书 §9「历史可清理」）。
        if let Ok(mut metrics) = self.transfer_metrics.lock() {
            metrics.forget(connection_id);
        }
        // Serialize against an independent forward being authenticated and
        // registered for this connection.
        let mut forward_guard = self.forward_transports.lock().await;
        self.connections
            .write()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .remove(connection_id);
        let old_transport = forward_guard.remove(connection_id);
        drop(forward_guard);
        let independent: Vec<_> = self
            .forwards
            .rows()
            .into_iter()
            .filter(|row| {
                row.connection_id == connection_id
                    && row.transport.as_ref().is_some_and(|transport| {
                        old_transport
                            .as_ref()
                            .is_some_and(|old| Arc::ptr_eq(transport, old))
                    })
            })
            .collect();
        for entry in independent {
            self.teardown_forward(&entry).await;
        }
        if let Some(transport) = old_transport {
            Self::close_forward_transport(&transport).await;
        }
        let session_ids = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self
                .close_session_with_reason(&session_id, Some("connection-disconnect"))
                .await;
        }
        self.stop_sudo_keepalive(connection_id).await;
        Ok(())
    }

    pub async fn open_session(
        self: &Arc<Self>,
        request: &SessionOpenRequest,
        operation_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        // WT-4 (WezTerm `spawn` parity): resolve the optional command-session
        // request BEFORE any dial or transport lease, so a malformed command
        // fails closed without touching the shared transport at all. The
        // normalized command is wrapped as `sh -c '<escaped>'` here so the
        // exec branch stays a single `Some`/`None` decision.
        let spawn_exec = normalized_spawn_command(request.spawn_command.as_deref())?
            .map(|command| spawn_exec_payload(&command));
        let connection_id = request.connection_id.as_str();
        let workbench_id = request.workbench_id.as_str();
        let reuse_authenticated_transport = request.reuse_authenticated_transport;
        let cols = request.cols;
        let rows = request.rows;
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or("Connection is not active; reopen it from DBX")?;
        // A copied workbench gets its own PTY channel, replay buffer and
        // terminal task, but deliberately shares the already authenticated
        // SSH transport. This avoids replaying an MFA challenge without ever
        // caching or reusing the OTP itself. A normal "new session" keeps the
        // old behavior and establishes a fully independent transport.
        let reuse_source = if reuse_authenticated_transport {
            let sessions = self.sessions.read().await;
            let source = if let Some(source_session_id) =
                request.reuse_authenticated_session_id.as_deref()
            {
                sessions
                    .get(source_session_id)
                    .filter(|entry| {
                        entry.connection_id == connection_id
                            && entry.connected.load(Ordering::Acquire)
                    })
                    .cloned()
            } else {
                // Compatibility for direct callers that know only the older
                // boolean contract: choose a deterministic live source.
                sessions
                    .values()
                    .filter(|entry| {
                        entry.connection_id == connection_id
                            && entry.connected.load(Ordering::Acquire)
                    })
                    .min_by_key(|entry| entry.created_seq)
                    .cloned()
            };
            source
                .map(|source| {
                    let orchestration = source
                        .orchestration
                        .read()
                        .map_err(|_| "SSH authentication state is unavailable".to_string())?
                        .clone();
                    // Reserve while the sessions read lock still prevents
                    // close_session from removing/releasing the source.
                    source.transport_lease.retain();
                    Ok::<_, String>((
                        Arc::clone(&source.handle),
                        Arc::clone(&source.transport_lease),
                        orchestration,
                    ))
                })
                .transpose()?
        } else {
            None
        };
        if reuse_authenticated_transport && reuse_source.is_none() {
            return Err(
                "No live authenticated SSH connection is available to duplicate; use New session to reconnect"
                    .to_string(),
            );
        }
        let (connection, handle, transport_lease, inherited_orchestration, reused_transport) =
            if let Some((handle, transport_lease, orchestration)) = reuse_source {
                eprintln!(
                    "[ssh-trace] open_session connection_id={connection_id} workbench_id={workbench_id} reuse_authenticated_transport=true"
                );
                (
                    connection,
                    handle,
                    transport_lease,
                    Some(orchestration),
                    true,
                )
            } else {
                eprintln!(
                    "[ssh-trace] open_session connection_id={connection_id} workbench_id={workbench_id} -> {}:{} auth={:?} reuse_authenticated_transport=false",
                    connection.host, connection.port, connection.authentication
                );
                // D9: 拨号前解析 password_command，使取回的凭据同时作用于登录链与
                // 本会话的 sudo 编排（下游 dial_and_authenticate 看到非空密码即不再
                // 重复执行——单次执行语义）。
                let connection = resolve_password_command(&connection).await;
                let (handle, jump_chain) = self
                    .connect_authenticated(&connection, operation_id, Some(emitter.clone()))
                    .await?;
                eprintln!("[ssh-trace] open_session dial+auth ok");
                (
                    connection,
                    Arc::new(handle),
                    Arc::new(SharedTransportLease::new(
                        jump_chain.into_iter().map(Arc::new).collect::<Vec<_>>(),
                    )),
                    None,
                    false,
                )
            };
        let terminal = async {
            let remote_shell = RemoteShell::Unknown;
            let directory_tracking_supported = true;
            let mut channel = handle.channel_open_session().await.map_err(|error| {
                if reused_transport {
                    format!("The authenticated SSH connection can no longer be reused; use New session to reconnect: {error}")
                } else {
                    format!("Failed to open terminal channel: {error}")
                }
            })?;
            channel
                .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
                .await
                .map_err(|error| format!("Failed to request SSH PTY: {error}"))?;
            // Client-specified SetEnv rides on the interactive session too,
            // in ssh(1) order: PTY first, env next, shell/exec last.
            exec::apply_connection_env(&mut channel, &connection.set_env).await?;
            // X11 forwarding (OpenSSH -X parity): gated on the connection-scoped
            // preference; a refused request only disables X11, never the shell.
            if crate::x11::enabled_from(&self.data_dir) {
                match crate::x11::arm_session() {
                    Ok(cookie_hex) => {
                        if let Err(error) = channel
                            .request_x11(true, false, crate::x11::X11_AUTH_PROTOCOL, cookie_hex, 0)
                            .await
                        {
                            eprintln!("[x11] x11-req refused by server: {error}");
                        }
                    }
                    Err(error) => eprintln!("[x11] cannot arm the forwarding gate: {error}"),
                }
            }
            if let Some(command) = spawn_exec.as_deref() {
                // WT-4 (command session): exec `sh -c '<escaped command>'`
                // instead of a shell — see docs/PROTOCOL.zh-CN.md「同
                // transport 命令会话」. Explicit per-open request wins over
                // the connection-level remote_command.
                channel
                    .exec(true, command.as_bytes())
                    .await
                    .map_err(|error| format!("Failed to start remote command: {error}"))?;
            } else if connection.remote_command.is_empty() {
                channel
                    .request_shell(true)
                    .await
                    .map_err(|error| format!("Failed to start SSH shell: {error}"))?;
            } else {
                channel
                    .exec(true, connection.remote_command.as_bytes())
                    .await
                    .map_err(|error| format!("Failed to start remote command: {error}"))?;
            }
            Ok::<_, String>((remote_shell, directory_tracking_supported, channel))
        }
        .await;
        let (mut remote_shell, directory_tracking_supported, mut channel) = match terminal {
            Ok(terminal) => terminal,
            Err(error) => {
                transport_lease.release().await;
                return Err(error);
            }
        };

        let mut session_id = request
            .requested_session_id
            .as_deref()
            .filter(|id| valid_requested_session_id(id))
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let (terminal_tx, mut terminal_rx) = mpsc::channel(256);
        let replay = Arc::new(AsyncMutex::new(ReplayBuffer::default()));
        let bound_profile = {
            let store = sudo_profiles::load_store(&self.data_dir);
            effective_sudo_profile(&connection, &store)
        };
        let orchestration =
            Arc::new(RwLock::new(inherited_orchestration.unwrap_or_else(|| {
                resolved_sudo_auth(&connection, bound_profile.as_ref())
            })));
        // In-terminal Quick Sudo: answers sudo password / 2FA prompts while
        // the user keeps typing normal commands (ported from tiny-rdm). The
        // watcher is attached here and re-synced on every runtime settings
        // update, so configuring Quick Sudo after connecting still arms it.
        let entry = Arc::new(SessionEntry {
            connection_id: connection.id.clone(),
            workbench_id: RwLock::new(workbench_id.to_string()),
            read_only: connection.read_only,
            connected: AtomicBool::new(true),
            created_at_secs: unix_now_secs(),
            created_seq: self.session_seq.fetch_add(1, Ordering::Relaxed),
            handle,
            transport_lease,
            orchestration: orchestration.clone(),
            auto_sudo: Arc::new(Mutex::new(None)),
            triggers: Arc::new(Mutex::new(None)),
            terminal_tx,
            replay: replay.clone(),
            sftp: AsyncMutex::new(None),
            agent_recorder: Arc::new(Mutex::new(None)),
            session_recorder: Arc::new(Mutex::new(None)),
            agent_exec_lock: Arc::new(AsyncMutex::new(())),
        });
        Self::sync_auto_sudo(&entry, &connection);
        Self::sync_triggers(&entry, &connection);
        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(&session_id) {
            session_id = Uuid::new_v4().to_string();
        }
        sessions.insert(session_id.clone(), entry.clone());

        // Terminal activity keepalive (opt-in per connection): resets
        // server-side idle policies that watch PTY input, which protocol
        // keepalives don't satisfy. Holds only the command sender, so the
        // loop ends as soon as the session's read loop drops its receiver.
        if connection.terminal_keepalive_secs > 0 {
            let terminal_tx = entry.terminal_tx.clone();
            let interval_secs = connection.terminal_keepalive_secs;
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                // The interval's first tick fires immediately; the session
                // just opened, so nothing needs resetting yet.
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    if terminal_tx
                        .send(TerminalCommand::Input(TERMINAL_KEEPALIVE_INPUT.to_vec()))
                        .await
                        .is_err()
                    {
                        // Read loop gone — the session is closed.
                        break;
                    }
                }
            });
        }

        // Prompt-hook arming (issue t8y2/dbx#10750): every interactive shell
        // session arms the per-prompt OSC 7 hook for its whole lifetime so the
        // frontend can keep the next prompt off the tail of un-newlined output
        // (FinalShell/WindTerm behavior); the SFTP directory-follow toggle
        // consumes the same frames. Detection runs off the read loop — probing
        // inside a select! arm can stall the loop for the detection timeout —
        // and the resolved shell rides the command queue into the loop, FIFO
        // with the startup-commands input lines below. Only real shell
        // sessions: spawn exec / remote_command replace the shell, so typing
        // the hook line there would feed the command's stdin.
        if interactive_shell_session(spawn_exec.as_deref(), &connection.remote_command) {
            let hook_handle = entry.handle.clone();
            let hook_tx = entry.terminal_tx.clone();
            tokio::spawn(async move {
                let shell = detect_remote_shell(&hook_handle).await;
                let _ = hook_tx
                    .send(TerminalCommand::InstallPromptHook { shell })
                    .await;
            });
        }

        // Startup commands (Tabby "Login scripts" parity, M7 P0-4): after the
        // shell is up, type the connection's pre-configured command sequence
        // through the same input channel the keepalive uses. Only for real
        // shell sessions — a RemoteCommand or WT-4 spawn exec replaces the
        // shell, so typing into it is a semantic conflict (documented in
        // PROTOCOL.zh-CN.md). The event reports only the count and completion:
        // command contents can carry secrets and never reach logs or events.
        if spawn_exec.is_none() && startup_commands::executes_for(&connection.remote_command) {
            let plan = startup_commands::load_plan(&self.data_dir, &connection.id);
            if !plan.is_empty() {
                let terminal_tx = entry.terminal_tx.clone();
                let startup_emitter = emitter.clone();
                let startup_session_id = session_id.clone();
                let startup_count = plan.len();
                tokio::spawn(async move {
                    let completed = startup_commands::inject_sequence(&plan, |payload| {
                        let terminal_tx = terminal_tx.clone();
                        async move {
                            terminal_tx
                                .send(TerminalCommand::Input(payload))
                                .await
                                .is_ok()
                        }
                    })
                    .await;
                    let _ = startup_emitter.event(
                        "ssh/startup",
                        json!({
                            "sessionId": startup_session_id,
                            "count": startup_count,
                            "completed": completed,
                        }),
                    );
                });
            }
        }

        let task_id = session_id.clone();
        let directory_marker_id = session_id.clone();
        let sessions = self.sessions.clone();
        // 自发断开收尾要清传输登记（'static spawn 拿不到 &self）：克隆运行时
        // 句柄进读循环任务。
        let runtime_for_cleanup = Arc::clone(self);
        // Auto-record 提示事件在 spawn 之后仍要用 emitter（主闭包已 move 走
        // 原值），提前留一个克隆；录制器槽同理（entry 已 move 进读循环任务）。
        let auto_record_emitter = emitter.clone();
        let auto_record_slot = Arc::clone(&entry.session_recorder);
        let auto_record_connection_id = entry.connection_id.clone();
        let defer_initial_prompt =
            interactive_shell_session(spawn_exec.as_deref(), &connection.remote_command);
        tokio::spawn(async move {
            let mut initial_output = defer_initial_prompt.then_some(Vec::new());
            let initial_output_started = defer_initial_prompt.then_some(Instant::now());
            let mut disconnect_reason = None;
            let mut directory_filter = DirectoryHandshakeFilter::default();
            let mut directory_tracking_enabled = false;
            // #287：shell 探测可能在登录 shell 读完 rc、把 tty 交给 readline
            // 之前就返回。此时写 hook 会被行规程原样回显、随后又被 readline
            // 重绘，屏幕上就出现两遍脚本文本。推迟到首个提示符可见（或用户
            // 先输入）后再写。
            let mut pending_prompt_hook: Option<RemoteShell> = None;
            // 提示符尾巴第一次出现的时刻。SSH 分片会让缓冲末尾「暂时」不带
            // 换行，只有静默一拍（见 ticker 的 PROMPT_TAIL_SETTLE）才说明那是
            // 真提示符而不是横幅被拆包。
            let mut prompt_tail_since: Option<Instant> = None;
            // #90：ZMODEM 触发检测（远端 sz 发起的 ZRQINIT）。字节全透传，
            // 检测器只产出事件边沿；事件窗口超时后自动复位（详见
            // zmodem_detect 模块注释）。
            let mut zmodem_detector = crate::zmodem_detect::Detector::new();
            let mut directory_timeout = tokio::time::interval(Duration::from_millis(250));
            directory_timeout.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // 跨帧 UTF-8 增量解码的尾部残留：多字节字符恰跨 SSH 包边界时，
            // 逐帧独立 lossy 解码会把字符劈成两个 U+FFFD，中文提示词的触发器/
            // auto-sudo 匹配稳定 miss（帧边界取决于远端写盘分片，非确定）。
            // 只有 stdout 进文本观察链（stderr 直喂 recorder 原始字节）。
            let mut stdout_utf8_carry: Vec<u8> = Vec::new();
            loop {
                tokio::select! {
                    _ = directory_timeout.tick() => {
                        // #287 主路径：尾巴静默一拍即视为提示符。ticker 250ms
                        // 一跳、数据到达会刷新 prompt_tail_since，所以这里只
                        // 会在「shell 停在提示符等输入」时命中；持续输出的横幅
                        // 永远刷得到新时刻，不会被误判成就绪。
                        let tail_settled = prompt_tail_since
                            .is_some_and(|at| at.elapsed() >= PROMPT_TAIL_SETTLE);
                        let flush_hook = initial_output.as_deref().is_some_and(|buffer| {
                            should_flush_pending_hook(pending_prompt_hook, buffer, tail_settled)
                        });
                        if flush_hook {
                            // 先取走缓冲再装 hook：后续 stdout 直接走正常发布
                            // 路径，脚本只写一次。
                            let held = initial_output.take().unwrap_or_default();
                            let shell = pending_prompt_hook.take().unwrap_or(remote_shell);
                            remote_shell = shell;
                            directory_tracking_enabled = true;
                            directory_filter.begin(directory_tracking_marker(&directory_marker_id));
                            let script = directory_tracking_script(&directory_marker_id, shell);
                            if channel.data(script.as_bytes()).await.is_err() { break; }
                            if let Some(data) = Some(strip_trailing_prompt(held))
                                .filter(|data| !data.is_empty())
                            {
                                publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                            }
                            prompt_tail_since = None;
                        }
                        if initial_output_started.is_some_and(|started| started.elapsed() >= REMOTE_SHELL_DETECTION_TIMEOUT + Duration::from_secs(1)) {
                            if let Some(data) = initial_output.take() {
                                // #287 兜底：一直没有识别出提示符（例如自定
                                // 义 shell 提示带换行），但又必须释放被扣住的
                                // 启动输出。此刻 shell 早已就绪，补装 hook，
                                // 避免用户不输入时目录跟踪永远不生效。
                                if let Some(shell) = pending_prompt_hook.take() {
                                    directory_tracking_enabled = true;
                                    directory_filter.begin(directory_tracking_marker(&directory_marker_id));
                                    let script = directory_tracking_script(&directory_marker_id, shell);
                                    if channel.data(script.as_bytes()).await.is_err() { break; }
                                }
                                if !data.is_empty() {
                                    publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                                }
                            }
                        }
                        if let Some(data) = directory_filter.flush_if_timed_out() {
                            // 与主数据路径同一检测器：握手窗口里冲刷的字节同样
                            // 参与 ZMODEM 触发检测（#90）。字节照常发布，检测器
                            // 只产出事件边沿。
                            if zmodem_detector.feed(&data, unix_now_ms()) {
                                let _ = emitter.event(
                                    "ssh/zmodem",
                                    json!({ "sessionId": task_id, "kind": "zrqinit" }),
                                );
                            }
                            if !data.is_empty() {
                                publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                            }
                        }
                        if directory_filter.take_failed() {
                            directory_tracking_enabled = false;
                            publish_terminal(
                                &task_id,
                                TerminalStream::State,
                                b"directory-tracking-unavailable".to_vec(),
                                &replay,
                                &emitter,
                            ).await;
                        }
                        // 推迟的 OTP 应答：TOTP 窗口滚动后自动补答（并发同靶
                        // sudo 提示撞重放保护时的排队语义）。先取值再写通道，
                        // 让互斥锁守卫在 .await 前释放。
                        let deferred_otp = entry
                            .auto_sudo
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .as_mut()
                            .and_then(|auto| auto.take_deferred_otp(unix_now_secs()));
                        if let Some((kind, answer)) = deferred_otp {
                            let mut payload = answer.into_bytes();
                            payload.push(b'\r');
                            if channel.data(&payload[..]).await.is_err() { break; }
                            let _ = emitter.event("ssh/auto-sudo", json!({
                                "sessionId": task_id,
                                "kind": if kind == exec::AutoSudoKind::Totp { "otp" } else { "password" },
                            }));
                        }
                    }
                    command = terminal_rx.recv() => match command {
                        Some(TerminalCommand::Input(data)) => {
                            // #287：用户在首个提示符出现前就输入。先补装
                            // hook，让脚本排在按键之前；否则脚本字节会在
                            // readline 就绪后重绘，插进用户正在输入的行里。
                            if let Some(shell) = pending_prompt_hook.take() {
                                if let Some(held) = initial_output.take() {
                                    if let Some(held) = Some(strip_trailing_prompt(held))
                                        .filter(|data| !data.is_empty())
                                    {
                                        publish_terminal(
                                            &task_id,
                                            TerminalStream::Stdout,
                                            held,
                                            &replay,
                                            &emitter,
                                        )
                                        .await;
                                    }
                                }
                                directory_tracking_enabled = true;
                                directory_filter
                                    .begin(directory_tracking_marker(&directory_marker_id));
                                let script =
                                    directory_tracking_script(&directory_marker_id, shell);
                                if channel.data(script.as_bytes()).await.is_err() { break; }
                            }
                            // Feed the keystrokes to the auto-sudo watcher before
                            // writing: it needs the submitted command line to tell
                            // sudo's bare `Password:` prompt from `docker login`'s
                            // identical one. Lock released before the await.
                            if let Ok(mut slot) = entry.auto_sudo.lock() {
                                if let Some(auto) = slot.as_mut() {
                                    auto.note_input(&data);
                                }
                            }
                            if channel.data(&data[..]).await.is_err() { break; }
                        }
                        Some(TerminalCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                        }
                        Some(TerminalCommand::DirectoryTracking { enabled }) => {
                            if !enabled {
                                // Session-open arming made the hook session
                                // infrastructure: turning SFTP directory-follow
                                // off stops only the frontend navigation, while
                                // the per-prompt hook (and the prompt-newline
                                // fix built on it) stays armed for the session's
                                // lifetime. Tearing it down here would silently
                                // regress #10750 for follow-off users.
                                continue;
                            }
                            if remote_shell == RemoteShell::Unknown {
                                remote_shell = detect_remote_shell(&entry.handle).await;
                            }
                            if remote_shell == RemoteShell::Other {
                                publish_terminal(
                                    &task_id,
                                    TerminalStream::State,
                                    b"directory-tracking-unavailable".to_vec(),
                                    &replay,
                                    &emitter,
                                ).await;
                                continue;
                            }
                            if directory_tracking_enabled {
                                continue;
                            }
                            // 显式开启目录跟踪会立刻安装 hook；取消 #287 的
                            // 延迟安装，避免 stdout 路径稍后再写一次同一脚本。
                            pending_prompt_hook = None;
                            let deferring_initial_prompt = initial_output.is_some();
                            if let Some(data) = initial_output.take().map(strip_trailing_prompt).filter(|data| !data.is_empty()) {
                                publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                            }
                            directory_tracking_enabled = true;
                            directory_filter.begin(directory_tracking_marker(&directory_marker_id));
                            if !deferring_initial_prompt {
                                publish_terminal(
                                    &task_id,
                                    TerminalStream::Stdout,
                                    b"\r\x1b[2K".to_vec(),
                                    &replay,
                                    &emitter,
                                ).await;
                            }
                            let script = directory_tracking_script(&directory_marker_id, remote_shell);
                            if channel.data(script.as_bytes()).await.is_err() { break; }
                        }
                        Some(TerminalCommand::InstallPromptHook { shell }) => {
                            // Detection normally finishes after the shell's first
                            // prompt. Hold that prompt off-screen and publish only
                            // the post-install one, instead of clearing an already
                            // visible line and causing a flash.
                            if matches!(shell, RemoteShell::Bash | RemoteShell::Zsh) && !directory_tracking_enabled {
                                // #287：探测可能先于登录 shell 的 rc/MOTD 完成。
                                // 只有缓冲区已经以“提示符尾巴”（非换行结尾）
                                // 收束时，才说明 readline 已经接管 tty、可以安全
                                // 写入；空缓冲或整行换行结尾说明 rc/MOTD 还在
                                // 跑，先记下 shell，等首个提示符（或用户输入）
                                // 再装，避免行规程回显 + readline 重绘两份。
                                let ready_now =
                                    initial_output.as_deref().is_some_and(ends_with_prompt_tail);
                                if initial_output.is_some() && !ready_now {
                                    remote_shell = shell;
                                    pending_prompt_hook = Some(shell);
                                } else {
                                    let buffered = initial_output.take();
                                    if let Some(data) = buffered.map(strip_trailing_prompt).filter(|data| !data.is_empty()) {
                                        publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                                    }
                                    remote_shell = shell;
                                    directory_tracking_enabled = true;
                                    directory_filter.begin(directory_tracking_marker(&directory_marker_id));
                                    let script = directory_tracking_script(&directory_marker_id, shell);
                                    if channel.data(script.as_bytes()).await.is_err() { break; }
                                }
                            } else {
                                if let Some(data) = initial_output.take().filter(|data| !data.is_empty()) {
                                    publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                                }
                            }
                        }
                        Some(TerminalCommand::Close { reason }) => {
                            disconnect_reason = reason;
                            let _ = channel.close().await;
                            break;
                        }
                        None => break,
                    },
                    message = channel.wait() => {
                        let (data, stream) = match message {
                            Some(ChannelMsg::Data { data }) => (data.to_vec(), TerminalStream::Stdout),
                            Some(ChannelMsg::ExtendedData { data, .. }) => (data.to_vec(), TerminalStream::Stderr),
                            // #108 堡垒机跟进取证：目标机 exit 后应回到堡垒机的
                            // 服务器列表（同一通道续用），通道不该关闭。区分
                            // 「远端主动 EOF/Close」与流自然结束，为下一轮定位
                            // 是哪一侧先收线留下凭据（DBX 插件日志可见）。
                            Some(msg @ (ChannelMsg::Eof | ChannelMsg::Close)) => {
                                if let Some(data) = initial_output.take().filter(|data| !data.is_empty()) {
                                    publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                                }
                                // exit-signal（强杀）先于 Eof/Close 到达时已写入
                                // disconnect_reason，这里不覆盖；否则按干净退出归档。
                                disconnect_reason = remote_channel_closed_reason(disconnect_reason);
                                eprintln!("[ssh] terminal session {task_id}: channel ended by remote ({msg:?})");
                                break;
                            }
                            // SSH RFC 4254：shell 被信号终止时服务端先发
                            // exit-signal 再关 channel。记下强杀档位，随后的
                            // Eof/Close 不得降级为 remote-exit，前端据此保留
                            // tab 并提示「会话被远端终止」而不是静默关闭。
                            Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                                disconnect_reason = Some(REMOTE_KILLED_REASON);
                                eprintln!("[ssh] terminal session {task_id}: remote process killed by {signal_name:?}");
                                continue;
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                // 干净退出先到：同样预置 reason，供后续
                                // Eof/Close 归档（exit_status 由终端输出自身呈现）。
                                if disconnect_reason.is_none() {
                                    disconnect_reason = remote_channel_exit_reason(Some(ChannelMsg::ExitStatus { exit_status }));
                                }
                                continue;
                            }
                            None => {
                                if let Some(data) = initial_output.take().filter(|data| !data.is_empty()) {
                                    publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                                }
                                eprintln!("[ssh] terminal session {task_id}: channel stream ended");
                                break;
                            }
                            _ => continue,
                        };
                        if stream == TerminalStream::Stdout {
                            let carry = &mut stdout_utf8_carry;
                            let chunk_text = decode_stream_text(carry, &data);
                            // Expect 式触发器先于终端 auto-sudo 观察（契约 D1
                            // 互斥防双答）：本 chunk 被触发器应答则跳过
                            // auto-sudo，反之亦然。锁在 .await 前释放。
                            let trigger_hit = {
                                let mut slot = entry
                                    .triggers
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner());
                                slot.as_mut().and_then(|engine| {
                                    engine.observe(&chunk_text, unix_now_ms()).map(|decision| {
                                        (
                                            decision,
                                            engine.placeholders().clone(),
                                            engine.pacing(),
                                        )
                                    })
                                })
                            };
                            let auto_answer = if trigger_hit.is_none() {
                                entry
                                    .auto_sudo
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner())
                                    .as_mut()
                                    .and_then(|auto| auto.observe(&chunk_text))
                            } else {
                                None
                            };
                            if let Some((decision, placeholders, (sleep_ms, pass_sleep))) =
                                trigger_hit
                            {
                                // command 应答在本地先执行（10s 超时、退出码
                                // 校验；日志只记失败原因，绝不落命令输出）。
                                let segments = match decision.kind {
                                    triggers::TriggerKind::Command => {
                                        match decision.command.as_deref().map(|command| {
                                            triggers::run_credential_command(
                                                command,
                                                &placeholders,
                                            )
                                        }) {
                                            Some(runner) => match runner.await {
                                                Ok(answer) => triggers::pass_sleep_segments(
                                                    &answer,
                                                    sleep_ms,
                                                    pass_sleep,
                                                ),
                                                Err(error) => {
                                                    eprintln!(
                                                        "[ssh] trigger stage {}: {error}",
                                                        decision.stage
                                                    );
                                                    Vec::new()
                                                }
                                            },
                                            None => Vec::new(),
                                        }
                                    }
                                    _ => decision.segments,
                                };
                                // 分段写回：段间按 sleepMs 停顿（契约 §2.1）。
                                // timeout 决策没有可发送段但视为已处理；命令
                                // 执行失败则什么都没发。
                                let mut answered =
                                    matches!(decision.kind, triggers::TriggerKind::Timeout);
                                let mut channel_dead = false;
                                for (payload, delay_ms) in &segments {
                                    if *delay_ms > 0 {
                                        tokio::time::sleep(Duration::from_millis(*delay_ms))
                                            .await;
                                    }
                                    if channel.data(&payload[..]).await.is_err() {
                                        channel_dead = true;
                                        break;
                                    }
                                    answered = true;
                                }
                                if channel_dead {
                                    break;
                                }
                                // D6：事件只带 {sessionId, stage, kind}，永不
                                // 携带应答内容。命令执行失败时不发事件（不能
                                // 让宿主提示一次不存在的应答）。
                                if answered {
                                    let _ = emitter.event(
                                        "ssh/trigger",
                                        json!({
                                            "sessionId": task_id,
                                            "stage": decision.stage,
                                            "kind": decision.kind.name(),
                                        }),
                                    );
                                }
                            } else if let Some((kind, answer)) = auto_answer {
                                let mut payload = answer.into_bytes();
                                payload.push(b'\r');
                                if channel.data(&payload[..]).await.is_err() { break; }
                                let _ = emitter.event("ssh/auto-sudo", json!({
                                    "sessionId": task_id,
                                    "kind": if kind == exec::AutoSudoKind::Totp { "otp" } else { "password" },
                                }));
                            }
                            // Agent terminal capture: feed the recorder
                            // installed by `exec_in_terminal` so the AI sees
                            // what the terminal shows.
                            if let Ok(mut slot) = entry.agent_recorder.lock() {
                                if let Some(recorder) = slot.as_mut() {
                                    recorder.observe(&chunk_text);
                                }
                            }
                        }
                        if stream == TerminalStream::Stdout {
                            if let Some(buffer) = initial_output.as_mut() {
                                buffer.extend_from_slice(&data);
                                // #287：启动输出一直被扣住到首个提示符。
                                // 提示符不带换行，但「缓冲区此刻不以换行收尾」
                                // 本身不足以证明 readline 已接管——SSH 会按包
                                // 拆分横幅的长行，任何一次分片都让缓冲末尾暂时
                                // 没有换行。据此立刻写 hook 会在 rc/MOTD 仍在
                                // 输出时把脚本回显出来，正是要修的症状。这里只
                                // 记「尾巴出现时刻」，真正的 flush 交给 250ms
                                // ticker：尾巴静默一拍（150ms 无新数据）才说明
                                // shell 停在提示符上等输入；持续输出的横幅每次
                                // 都会刷新该时刻，不会误判。
                                prompt_tail_since = if ends_with_prompt_tail(buffer) {
                                    Some(Instant::now())
                                } else {
                                    None
                                };
                                continue;
                            }
                        }
                        let Some(data) = directory_filter.filter(&data) else { continue; };
                        // #90 ZMODEM 触发检测：远端 `sz` 用 ZRQINIT 开启下载会
                        // 话。ZMODEM 下载接收已由前端 sentry（zmodem.js）承接，
                        // 字节一律原样透传给终端路径（sentry 会消费协议帧）；
                        // 检测器只产出事件边沿（40s 事件窗口内去重重试），供
                        // UX 提示/观测。只在 Stdout 上扫（sz 的协议帧走
                        // stdout；stderr 原样直通）。ZRINIT（rz 上传）不触发；
                        // 窗口超时后自动复位，后续 `sz` 会再次上报。
                        let zmodem_detected =
                            stream == TerminalStream::Stdout && zmodem_detector.feed(&data, unix_now_ms());
                        if zmodem_detected {
                            let _ = emitter.event(
                                "ssh/zmodem",
                                json!({ "sessionId": task_id, "kind": "zrqinit" }),
                            );
                        }
                        if !data.is_empty() {
                            // Session recording capture: everything the terminal
                            // shows (stdout + stderr, post-filter) lands in the
                            // cast file when a recording is active.
                            if stream != TerminalStream::State {
                                if let Ok(mut slot) = entry.session_recorder.lock() {
                                    if let Some(recorder) = slot.as_mut() {
                                        recorder.observe(&data);
                                    }
                                }
                            }
                            publish_terminal(&task_id, stream, data, &replay, &emitter).await;
                        }
                        if directory_filter.take_failed() {
                            directory_tracking_enabled = false;
                            publish_terminal(
                                &task_id,
                                TerminalStream::State,
                                b"directory-tracking-unavailable".to_vec(),
                                &replay,
                                &emitter,
                            ).await;
                        }
                    }
                }
            }
            entry.connected.store(false, Ordering::Release);
            // Auto-stop an active session recording: the file is finalized
            // even when the workbench never sent `ssh/recording/stop`.
            if let Ok(mut slot) = entry.session_recorder.lock() {
                if let Some(recorder) = slot.take() {
                    if let Err(error) = recorder.finish() {
                        eprintln!("[ssh-trace] recording auto-stop failed: {error}");
                    }
                }
            }
            publish_terminal(
                &task_id,
                TerminalStream::State,
                terminal_disconnect_state(disconnect_reason).to_vec(),
                &replay,
                &emitter,
            )
            .await;
            let _ = emitter.event(
                "ssh/session/state",
                session_disconnected_event(&task_id, &entry.connection_id, disconnect_reason),
            );
            let removed = sessions.write().await.remove(&task_id);
            if let Some(removed) = removed {
                removed.transport_lease.release().await;
            }
            // 会话消失也要清传输登记（upload/download 表项、.part/spool 暂存、
            // metrics 缓存等）：它们此前只在 close_session 清——网络自发断开
            // 路径漏掉，表项与暂存文件会一直挂到 sidecar 退出。
            if let Err(error) = runtime_for_cleanup
                .cleanup_session_transfers(&task_id)
                .await
            {
                eprintln!("[ssh-trace] transfer cleanup after disconnect failed: {error}");
            }
        });

        // Auto-record（M14）：偏好开启时对每个新会话自动挂录制器。只读连接
        // 不禁用（录制是被动输出捕获）；已有录制进行中则跳过——两种情形都
        // 经 `ssh/recording/auto` 事件提示一次，负载只带 id 不带内容。
        let emitter = auto_record_emitter;
        if session_recording::auto_record_enabled() {
            let mut slot = auto_record_slot
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if slot.is_some() {
                let _ = emitter.event(
                    "ssh/recording/auto",
                    json!({
                        "sessionId": session_id,
                        "skipped": true,
                    }),
                );
            } else {
                let recording_id = Uuid::new_v4().to_string();
                match session_recording::SessionRecorder::start(
                    &self.data_dir,
                    &recording_id,
                    &auto_record_connection_id,
                    &connection.host,
                    &session_id,
                    80,
                    24,
                ) {
                    Ok(recorder) => {
                        *slot = Some(recorder);
                        let _ = emitter.event(
                            "ssh/recording/auto",
                            json!({
                                "sessionId": session_id,
                                "recordingId": recording_id,
                            }),
                        );
                    }
                    Err(error) => {
                        eprintln!("[ssh-trace] auto-record start failed: {error}");
                    }
                }
            }
        }

        Ok(json!({
            "sessionId": session_id,
            "connectionId": connection.id,
            "connected": true,
            "sequence": 0,
            "chunkSize": TRANSFER_CHUNK_SIZE,
            "directoryTrackingSupported": directory_tracking_supported
        }))
    }

    pub async fn test_connection(
        &self,
        connection: &StoredConnection,
        operation_id: &str,
        emitter: PluginEmitter,
    ) -> Result<(), String> {
        self.prompts.clear_challenge_raised();
        // 宿主对 connection/test 有 RPC 截止（有效连接超时），截止一到直接
        // 杀掉请求、用户只看到费解的宿主超时文案——sidecar 必须在截止前
        // 作答，因此拨号预算按宿主截止对齐并留 1s 余量。
        let budget_secs = test_dial_budget_secs(
            connection.connect_timeout_secs,
            connection.connect_timeout_explicit,
        );
        let probe = self.connect_authenticated(connection, operation_id, Some(emitter));
        tokio::pin!(probe);
        let mut budget_secs = budget_secs;
        let mut extended = false;
        let connected = loop {
            match tokio::time::timeout(Duration::from_secs(budget_secs), probe.as_mut()).await {
                Ok(result) => break result,
                Err(_elapsed) => {
                    // 弹窗路径会把探针停在等待用户作答上:镜像拨号预算到期时
                    // 若弹窗已接管本次挑战,以"挑战等待 + 连接超时"重臂一次;
                    // 其余超时(1.0 宿主、工作台降级、扩展窗耗尽)保持现行可
                    // 读超时文案,行为不变。
                    let dialog_used = !extended && self.prompts.host_dialog_was_used();
                    match next_test_budget(connection.connect_timeout_secs, dialog_used) {
                        Some(next_budget) => {
                            budget_secs = next_budget;
                            extended = true;
                        }
                        None => {
                            // 挑战指引只在挑战已发出且未走弹窗路径时附加:
                            // "update DBX" 对 1.0 宿主是真的,对 1.1 弹窗路径
                            // 会误导。
                            let challenge_clause = self.prompts.challenge_was_raised()
                                && !self.prompts.host_dialog_was_used();
                            return Err(test_timeout_message(
                                &connection.runtime_host,
                                connection.runtime_port,
                                budget_secs,
                                !connection.connect_timeout_explicit,
                                challenge_clause,
                            ));
                        }
                    }
                }
            }
        };
        let (handle, jumps) = connected?;
        handle
            .disconnect(
                Disconnect::ByApplication,
                "DBX SSH connection test complete",
                "English",
            )
            .await
            .map_err(|error| format!("SSH test disconnect failed: {error}"))?;
        for jump in jumps {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH jump connection closed",
                    "English",
                )
                .await;
        }
        Ok(())
    }

    /// Preflight host-key check for a saved connection (tiny-rdm's
    /// CheckHostKey): dials only to key exchange, compares the presented
    /// server key against the known_hosts stores, and aborts the handshake
    /// before any authentication or challenge. Jump chains are not
    /// tunneled through (that would require full jump authentication), so
    /// jump-only targets report `unreachable`. TCP failures and timeouts
    /// are returned as `{state: "unreachable", error}` inside `Ok` so the
    /// frontend can render them; only internal errors (unknown connection,
    /// poisoned registry) are `Err`.
    pub async fn check_host_key(&self, connection_id: &str) -> Result<Value, String> {
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| {
                format!("Connection {connection_id} is not active; reopen it from DBX")
            })?;
        let config = Arc::new(ssh_client_config(&connection));
        let probe = HostKeyProbe {
            verifier: Arc::new(HostKeyVerifier::new(self.known_hosts_path.clone())),
            host: connection.host.clone(),
            port: connection.port,
            seen: Arc::new(Mutex::new(None)),
        };
        let seen = probe.seen.clone();
        let timeout = Duration::from_secs(connection.connect_timeout_secs.max(1));
        // #324：代理路径与正式拨号同源——代理握手失败直接按 unreachable
        // 上报（等价 TCP 拨不通的语义），流建立后再做密钥交换预检。
        // 两个分支的具体 future 类型不同，统一放进 async 块在 await 点
        // 收敛成同一 Output。
        let connect = async {
            match &connection.proxy {
                Some(proxy) => {
                    let stream = match proxy
                        .connect(&connection.runtime_host, connection.runtime_port, timeout)
                        .await
                    {
                        Ok(stream) => stream,
                        Err(error) => return Err(error),
                    };
                    client::connect_stream(config, stream, probe)
                        .await
                        .map_err(|error| error.to_string())
                }
                None => {
                    client::connect(
                        config,
                        (connection.runtime_host.as_str(), connection.runtime_port),
                        probe,
                    )
                    .await
                    .map_err(|error| error.to_string())
                }
            }
        };
        let failure = match tokio::time::timeout(timeout, connect).await {
            // The probe always rejects the key, so a handle here would be
            // unexpected; disconnect defensively anyway.
            Ok(Ok(handle)) => {
                let _ = handle
                    .disconnect(
                        Disconnect::ByApplication,
                        "DBX host-key check complete",
                        "English",
                    )
                    .await;
                None
            }
            // Key exchange ran and the probe aborted it: the stashed verdict
            // decides the response regardless of the resulting russh error.
            Ok(Err(error)) => {
                let probed = seen.lock().map(|slot| slot.is_some()).unwrap_or(false);
                (!probed).then(|| {
                    format!(
                        "SSH connection to {}:{} failed: {error}",
                        connection.runtime_host, connection.runtime_port
                    )
                })
            }
            Err(_elapsed) => Some(format!(
                "SSH connection to {}:{} timed out after {} seconds",
                connection.runtime_host,
                connection.runtime_port,
                timeout.as_secs()
            )),
        };
        let outcome = seen.lock().ok().and_then(|mut slot| slot.take());
        Ok(match (outcome, failure) {
            (Some((verdict, key_type, fingerprint)), _) => {
                host_key_check_response(&verdict, &key_type, &fingerprint)
            }
            (None, Some(error)) => host_key_unreachable_response(error),
            (None, None) => host_key_unreachable_response(
                "SSH handshake completed without presenting a host key".to_string(),
            ),
        })
    }

    /// Dials the ProxyJump chain (if any) and returns the authenticated
    /// target handle plus the jump-host handles that must stay alive for the
    /// target tunnel to keep working. Ported from tiny-rdm's dialThroughJump.
    pub(crate) async fn connect_authenticated(
        &self,
        connection: &StoredConnection,
        operation_id: &str,
        emitter: Option<PluginEmitter>,
    ) -> Result<(Handle<SshClient>, Vec<Handle<SshClient>>), String> {
        let mut jump_handles = Vec::new();
        // #324：代理挂在初始拨号上——无论是直接到目标还是先到第一跳跳板，
        // 出站的第一个 TCP 都要经代理摸出去；后续跳板链走已建立的隧道，
        // 不再涉及代理。
        let mut dial = match &connection.proxy {
            Some(proxy) => DialTarget::Proxied(
                proxy
                    .connect(
                        &connection.runtime_host,
                        connection.runtime_port,
                        Duration::from_secs(connection.connect_timeout_secs.max(1)),
                    )
                    .await?,
            ),
            None => DialTarget::Tcp((connection.runtime_host.clone(), connection.runtime_port)),
        };

        for (position, jump) in connection.jump_hosts.iter().enumerate() {
            let jump_connection = jump.to_connection(
                &format!("jump-{}-{}", position + 1, connection.id),
                connection.connect_timeout_secs,
                connection.keepalive_interval_secs,
            );
            let handle = self
                .dial_and_authenticate(&jump_connection, dial, operation_id, emitter.clone())
                .await
                .map_err(|error| {
                    format!(
                        "Jump host #{} ({}:{}) failed: {error}",
                        position + 1,
                        jump.host,
                        jump.port
                    )
                })?;
            // The next hop dials through a direct-tcpip channel on this jump.
            let next = if position + 1 < connection.jump_hosts.len() {
                let target = &connection.jump_hosts[position + 1];
                (target.host.clone(), target.port)
            } else {
                (connection.host.clone(), connection.port)
            };
            dial = DialTarget::through_jump(&handle, &next.0, next.1).await?;
            jump_handles.push(handle);
        }

        let target = self
            .dial_and_authenticate(connection, dial, operation_id, emitter)
            .await?;
        Ok((target, jump_handles))
    }

    async fn dial_and_authenticate(
        &self,
        connection: &StoredConnection,
        dial: DialTarget,
        operation_id: &str,
        emitter: Option<PluginEmitter>,
    ) -> Result<Handle<SshClient>, String> {
        // Match tiny-rdm: after 3 unanswered keepalive probes the connection
        // is declared dead so the workbench can reconnect.
        let config = Arc::new(ssh_client_config(connection));
        let verifier = Arc::new(HostKeyVerifier::new(self.known_hosts_path.clone()));
        let timeout = Duration::from_secs(connection.connect_timeout_secs);
        let dial_deadline = DialDeadline::start(timeout);
        // The forwarded-tcpip handler needs the mapping table at dial time;
        // remote forwards registered later on this connection insert into the
        // same Arc, and the table dies with the connection's last session.
        let remote_forwards = self.remote_table_for(&connection.id);
        // Auto 回退编排也要逐方式发日志事件：emitter 主体随 handler 移走，
        // 这里先留一份克隆给认证分派用（Option<PluginEmitter>，headless 为
        // None 时事件自然省略）。
        let auth_emitter = emitter.clone();
        let handler = SshClient {
            verifier,
            prompts: self.prompts.clone(),
            emitter,
            auto_trust: self.auto_trust,
            host: connection.host.clone(),
            port: connection.port,
            connection_id: connection.id.clone(),
            operation_id: operation_id.to_string(),
            dial_deadline: dial_deadline.clone(),
            connect_timeout: timeout,
            remote_forwards,
        };
        let timeout_message = || {
            format!(
                "SSH connection timed out after {} seconds",
                connection.connect_timeout_secs
            )
        };
        // The deadline is dynamic: a pending host-key challenge suspends the
        // dial timeout while the user studies the fingerprint dialog.
        let mut session = match dial {
            DialTarget::Tcp(address) => {
                let connect = client::connect(config, (address.0.as_str(), address.1), handler);
                tokio::pin!(connect);
                loop {
                    let remaining = dial_deadline.remaining().ok_or_else(timeout_message)?;
                    match tokio::time::timeout_at(
                        tokio::time::Instant::now() + remaining,
                        &mut connect,
                    )
                    .await
                    {
                        Ok(result) => break result.map_err(dial_error_message)?,
                        Err(_elapsed) => continue,
                    }
                }
            }
            DialTarget::JumpStream(stream) => {
                let connect = client::connect_stream(config, stream, handler);
                tokio::pin!(connect);
                loop {
                    let remaining = dial_deadline.remaining().ok_or_else(timeout_message)?;
                    match tokio::time::timeout_at(
                        tokio::time::Instant::now() + remaining,
                        &mut connect,
                    )
                    .await
                    {
                        Ok(result) => break result.map_err(dial_error_message)?,
                        Err(_elapsed) => continue,
                    }
                }
            }
            DialTarget::Proxied(stream) => {
                // 与 JumpStream 同形：预连流直接喂 russh，SSH 握手预算
                // 继续由 dial_deadline 管（代理握手已消耗独立超时）。
                let connect = client::connect_stream(config, stream, handler);
                tokio::pin!(connect);
                loop {
                    let remaining = dial_deadline.remaining().ok_or_else(timeout_message)?;
                    match tokio::time::timeout_at(
                        tokio::time::Instant::now() + remaining,
                        &mut connect,
                    )
                    .await
                    {
                        Ok(result) => break result.map_err(dial_error_message)?,
                        Err(_elapsed) => continue,
                    }
                }
            }
        };

        let none = tokio::time::timeout(timeout, session.authenticate_none(&connection.username))
            .await
            .map_err(|_| "SSH authentication probe timed out".to_string())?
            .map_err(|error| format!("SSH auth probe failed: {error}"))?;
        eprintln!(
            "[ssh-trace] tcp+banner ok, auth none success={}",
            none.success()
        );
        if none.success() {
            return Ok(session);
        }
        if connection.authentication == AuthenticationMethod::None {
            return Err("SSH server rejected unauthenticated access".to_string());
        }

        // D9: password_command 在 orchestration 构建前一次性解析——结果回填
        // 后供密码链（try_password / keyboard-interactive）与 sudo 编排共用，
        // 避免多处执行命令。既有显式密码优先（契约优先级）。
        let connection = &resolve_password_command(connection).await;
        let orchestration = {
            // 登录期 KI 与 sudo 共用同一套生效凭据来源（连接配置，或
            // sudo_source 解析出的全局 Quick Sudo 配置）：global 模式在表单上
            // 隐藏 2FA 四件套、契约写明"凭据来源整体由全局配置接管"，所以登录
            // 提问也必须能读到该配置的 TOTP/提示词/流程模式。
            let store = sudo_profiles::load_store(&self.data_dir);
            let profile = effective_sudo_profile(connection, &store);
            login_sudo_auth(connection, profile.as_ref())
        };

        // #6（none 广告集前置 reconcile，对抗评审第二期）：none 探测拿到的
        // 服务器广告集作为后续 password/KI 方法选择的初始门。广告集拿不到
        // （连接中断等异常形状）时为 None，方法选择回退为逐步广告判定，
        // 绝不 fail-closed 卡死登录。
        let advertised_none = advertised_methods(&none);

        match connection.authentication {
            AuthenticationMethod::Password => {
                authenticate_password_or_interactive(
                    &mut session,
                    connection,
                    &orchestration,
                    advertised_none,
                    &none,
                    &self.prompts,
                )
                .await?;
            }
            AuthenticationMethod::PrivateKey => {
                let key_result = authenticate_private_key_result(&mut session, connection).await?;
                if !key_result.success() {
                    // 公钥被接受、服务器还要求 MFA（koko 的私钥 + 二次认证）：
                    // 继续答 keyboard-interactive 的验证码提问；公钥被直接
                    // 拒绝（非 partial success）时仍按密钥认证失败报错，不
                    // 静默改用密码。
                    if auth_partial_success(&key_result)
                        && method_offered(&key_result, MethodKind::KeyboardInteractive)
                    {
                        eprintln!(
                            "[ssh-trace] auth: publickey partial success, continuing with keyboard-interactive"
                        );
                        authenticate_keyboard_interactive(
                            &mut session,
                            connection,
                            &orchestration,
                            true,
                            &self.prompts,
                        )
                        .await?;
                    } else {
                        return Err("SSH private-key authentication was rejected".to_string());
                    }
                }
            }
            AuthenticationMethod::PrivateKeyPassword => {
                let key_result = authenticate_private_key_result(&mut session, connection).await?;
                if !key_result.success() {
                    authenticate_password_or_interactive(
                        &mut session,
                        connection,
                        &orchestration,
                        advertised_none,
                        &key_result,
                        &self.prompts,
                    )
                    .await?;
                }
            }
            AuthenticationMethod::Agent => {
                match authenticate_agent(&mut session, connection).await? {
                    AgentAuthOutcome::Accepted => {}
                    // agent 身份被接受、服务器还要 MFA：与私钥路径同样续答
                    // keyboard-interactive 验证码提问。
                    AgentAuthOutcome::NeedsKeyboardInteractive => {
                        eprintln!(
                            "[ssh-trace] auth: agent partial success, continuing with keyboard-interactive"
                        );
                        authenticate_keyboard_interactive(
                            &mut session,
                            connection,
                            &orchestration,
                            true,
                            &self.prompts,
                        )
                        .await?;
                    }
                    AgentAuthOutcome::Rejected(reason) => {
                        return Err(reason);
                    }
                }
            }
            AuthenticationMethod::Auto => {
                authenticate_auto(
                    &mut session,
                    connection,
                    &orchestration,
                    &none,
                    &self.prompts,
                    auth_emitter.as_ref(),
                    operation_id,
                )
                .await?;
            }
            AuthenticationMethod::None => unreachable!(),
        }

        Ok(session)
    }

    /// Path of the plugin's own known_hosts store.
    pub fn known_hosts_path(&self) -> std::path::PathBuf {
        self.known_hosts_path.clone()
    }

    /// Enables trust-on-first-use for unknown host keys (MCP stdio mode).
    pub fn with_auto_trust_keys(mut self) -> Self {
        self.auto_trust = true;
        self
    }

    /// Connects and authenticates without a plugin emitter; used by the MCP
    /// stdio mode. Returns the target handle plus the jump chain that must be
    /// kept alive for the tunnel.
    pub async fn connect_headless(
        &self,
        connection: &StoredConnection,
    ) -> Result<(Arc<Handle<SshClient>>, Vec<Arc<Handle<SshClient>>>), String> {
        let (handle, jumps) = self.connect_authenticated(connection, "mcp", None).await?;
        Ok((Arc::new(handle), jumps.into_iter().map(Arc::new).collect()))
    }

    /// Per-connection remote-forward table, created on first use. The dial
    /// path hands the same Arc to the SSH client handler; remote forward
    /// start inserts the rows the handler later matches against.
    fn remote_table_for(&self, connection_id: &str) -> Arc<RemoteForwardTable> {
        let mut tables = self
            .remote_tables
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        tables
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(HashMap::new())))
            .clone()
    }

    /// `ssh/forward/list`: live mappings, optionally scoped to one connection
    /// or session. Read-only — liveness counters update as relays come and go.
    pub fn forward_list(&self, params: &Value) -> Value {
        let connection_id = params.get("connectionId").and_then(Value::as_str);
        let session_id = params.get("sessionId").and_then(Value::as_str);
        let mut rows: Vec<Value> = self
            .forwards
            .rows()
            .iter()
            .filter(|entry| connection_id.is_none_or(|id| entry.connection_id == id))
            .filter(|entry| session_id.is_none_or(|id| entry.session_id == id))
            .map(|entry| entry.payload())
            .collect();
        rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({ "forwards": rows })
    }

    /// `ssh/forward/start`: validate, register, then arm the direction —
    /// local binds the port before the mapping is reported active, remote
    /// asks the server to listen first (a refusal removes the mapping again).
    pub async fn forward_start(
        &self,
        params: &Value,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let session_id = params.get("sessionId").and_then(Value::as_str);
        let session = if let Some(id) = session_id {
            Some(self.session(id).await?)
        } else {
            None
        };
        let connection_id = if let Some(session) = &session {
            session.connection_id.clone()
        } else {
            params
                .get("connectionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("sessionId or connectionId is required")?
                .to_string()
        };
        let (kind, listen_host, listen_port, target_host, target_port) =
            forward::parse_spec(params)?;
        // Conflict pre-check ahead of bind/tcpip-forward, so a duplicate gets
        // a naming error instead of a raw "address already in use" (local) or
        // a server-side refusal (remote). Local endpoints collide on the one
        // client machine — every connection; remote endpoints collide per
        // server — same connection only.
        if listen_port != 0 {
            let conflicting = self.forwards.rows().into_iter().find(|row| {
                (kind == forward::ForwardKind::Remote
                    && row.kind == forward::ForwardKind::Remote
                    && row.connection_id == connection_id
                    || kind != forward::ForwardKind::Remote
                        && row.kind != forward::ForwardKind::Remote)
                    && forward::listen_endpoints_conflict(
                        &listen_host,
                        listen_port,
                        &row.listen_host,
                        row.listen_port,
                    )
            });
            if let Some(row) = conflicting {
                let endpoint = format!("{listen_host}:{listen_port}");
                let existing = forward::describe(
                    row.kind,
                    &row.listen_host,
                    row.listen_port,
                    &row.target_host,
                    row.target_port,
                );
                return Err(format!(
                    "Listen endpoint {endpoint} is already forwarded by mapping {} ({existing})",
                    row.id
                ));
            }
        }
        let mut created_transport = false;
        let mut transport_guard = if session.is_none() {
            Some(self.forward_transports.lock().await)
        } else {
            None
        };
        let transport = if let Some(guard) = transport_guard.as_mut() {
            // Disconnect removes the stored connection under this same lock.
            // Recheck even when a transport already exists so a concurrent
            // start cannot resurrect a mapping after disconnect.
            let connection = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?
                .get(&connection_id)
                .cloned()
                .ok_or("Connection is not active; reopen it from DBX")?;
            if let Some(existing) = guard.get(&connection_id) {
                Some(existing.clone())
            } else {
                let connection = resolve_password_command(&connection).await;
                let (handle, jumps) = self
                    .connect_authenticated(
                        &connection,
                        &Uuid::new_v4().to_string(),
                        Some(emitter.clone()),
                    )
                    .await?;
                let created = Arc::new(forward::ForwardTransport {
                    handle: Arc::new(handle),
                    jump_chain: jumps.into_iter().map(Arc::new).collect(),
                });
                guard.insert(connection_id.clone(), created.clone());
                created_transport = true;
                Some(created)
            }
        } else {
            None
        };
        let handle = session
            .as_ref()
            .map(|session| session.handle.clone())
            .or_else(|| transport.as_ref().map(|transport| transport.handle.clone()))
            .ok_or("No SSH transport available for forwarding")?;
        let entry = Arc::new(forward::ForwardEntry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.unwrap_or("").to_string(),
            connection_id: connection_id.clone(),
            kind,
            listen_host,
            listen_port,
            target_host,
            target_port,
            transport: transport.clone(),
            bound_port: AtomicU32::new(0),
            state: Mutex::new(forward::ForwardState::Starting),
            error: Mutex::new(None),
            connections_total: AtomicU64::new(0),
            connections_active: AtomicI64::new(0),
            bytes_up: AtomicU64::new(0),
            bytes_down: AtomicU64::new(0),
            listener_task: Mutex::new(None),
            relays: Mutex::new(Vec::new()),
            emitter: Some(emitter),
            stopping: AtomicBool::new(false),
        });
        self.forwards.insert(entry.clone());
        let started: Result<(), String> = match kind {
            forward::ForwardKind::Local | forward::ForwardKind::Dynamic => {
                forward::spawn_local_listener(entry.clone(), handle.clone()).await
            }
            forward::ForwardKind::Remote => {
                async {
                    let bound = handle
                        .tcpip_forward(&entry.listen_host, u32::from(entry.listen_port))
                        .await
                        .map_err(|error| {
                            format!(
                                "Server refused to listen on {}:{}: {error}",
                                entry.listen_host, entry.listen_port
                            )
                        })?;
                    let bound = u16::try_from(bound).unwrap_or(entry.listen_port.max(1));
                    entry.bound_port.store(u32::from(bound), Ordering::Relaxed);
                    let table = self.remote_table_for(&connection_id);
                    forward::register_remote_target(
                        &table,
                        &entry.listen_host,
                        bound,
                        &entry.target_host,
                        entry.target_port,
                        entry.clone(),
                    );
                    Ok(())
                }
                .await
            }
        };
        if let Err(error) = started {
            self.forwards.remove(&entry.id);
            if let (Some(mut guard), Some(transport)) = (transport_guard.take(), transport) {
                if !self
                    .forwards
                    .rows()
                    .iter()
                    .any(|row| row.connection_id == connection_id && row.transport.is_some())
                {
                    guard.remove(&connection_id);
                    drop(guard);
                    Self::close_forward_transport(&transport).await;
                }
            }
            return Err(error);
        }
        drop(transport_guard);
        if created_transport {
            if let Some(transport) = transport {
                self.monitor_forward_transport(connection_id, transport);
            }
        }
        forward::set_state(&entry, forward::ForwardState::Active, None);
        Ok(json!({ "forward": entry.payload() }))
    }

    /// A network loss does not send connection/disconnect from the host. Drop
    /// listeners and registry rows when the underlying SSH transport closes.
    fn monitor_forward_transport(
        &self,
        connection_id: String,
        transport: Arc<forward::ForwardTransport>,
    ) {
        let transports = self.forward_transports.clone();
        let forwards = self.forwards.clone();
        let remote_tables = self.remote_tables.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let mut guard = transports.lock().await;
                if !guard
                    .get(&connection_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &transport))
                {
                    break;
                }
                if !transport.handle.is_closed() {
                    continue;
                }
                guard.remove(&connection_id);
                drop(guard);
                for entry in forwards.rows().into_iter().filter(|entry| {
                    entry
                        .transport
                        .as_ref()
                        .is_some_and(|owner| Arc::ptr_eq(owner, &transport))
                }) {
                    forward::abort_tasks(&entry);
                    forwards.remove(&entry.id);
                    forward::set_state(
                        &entry,
                        forward::ForwardState::Stopped,
                        Some("SSH transport closed".to_string()),
                    );
                    if entry.kind == forward::ForwardKind::Remote {
                        if let Some(table) = remote_tables
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .get(&connection_id)
                        {
                            table
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .retain(|_, target| target.entry.id != entry.id);
                        }
                    }
                }
                for jump in &transport.jump_chain {
                    let _ = jump
                        .disconnect(Disconnect::ByApplication, "SSH transport closed", "English")
                        .await;
                }
                break;
            }
        });
    }

    /// `ssh/forward/stop`: tear the mapping down and report the final row.
    pub async fn forward_stop(&self, id: &str) -> Result<Value, String> {
        let entry = self
            .forwards
            .get(id)
            .ok_or("Port mapping was not found or already stopped")?;
        self.teardown_forward(&entry).await;
        Ok(json!({ "success": true, "forward": entry.payload() }))
    }

    /// Tears one mapping down: background tasks aborted, remote listener
    /// cancelled on the session's SSH handle (best effort — a dead session
    /// cannot cancel anything and does not need to), table row removed, and
    /// the registry drops the entry so a stopped id cannot be restarted into.
    async fn teardown_forward(&self, entry: &Arc<forward::ForwardEntry>) {
        forward::abort_tasks(entry);
        if entry.kind == forward::ForwardKind::Remote {
            let handle = if let Some(transport) = &entry.transport {
                Some(transport.handle.clone())
            } else {
                self.sessions
                    .read()
                    .await
                    .get(&entry.session_id)
                    .map(|session| session.handle.clone())
            };
            if let Some(handle) = handle {
                let port = entry.bound_port.load(Ordering::Relaxed);
                let port = if port == 0 {
                    u32::from(entry.listen_port)
                } else {
                    port
                };
                let _ = handle.cancel_tcpip_forward(&entry.listen_host, port).await;
            }
            if let Some(table) = self
                .remote_tables
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&entry.connection_id)
            {
                table
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .retain(|_, target| target.entry.id != entry.id);
            }
        }
        self.forwards.remove(&entry.id);
        forward::set_state(entry, forward::ForwardState::Stopped, None);
        if let Some(transport) = &entry.transport {
            let mut guard = self.forward_transports.lock().await;
            let has_other = self
                .forwards
                .rows()
                .iter()
                .any(|row| row.connection_id == entry.connection_id && row.transport.is_some());
            if !has_other
                && guard
                    .get(&entry.connection_id)
                    .is_some_and(|current| Arc::ptr_eq(current, transport))
            {
                guard.remove(&entry.connection_id);
                drop(guard);
                Self::close_forward_transport(transport).await;
            }
        }
    }

    async fn close_forward_transport(transport: &forward::ForwardTransport) {
        let _ = transport
            .handle
            .disconnect(
                Disconnect::ByApplication,
                "DBX SSH forwarding stopped",
                "English",
            )
            .await;
        for jump in &transport.jump_chain {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH forwarding stopped",
                    "English",
                )
                .await;
        }
    }

    /// Session teardown: every mapping of the session dies with it. Called
    /// from `close_session` while the session's SSH handle is still
    /// resolvable, so remote listeners are cancelled on the way out.
    pub async fn stop_session_forwards(&self, session_id: &str) {
        for entry in self
            .forwards
            .rows()
            .iter()
            .filter(|row| row.session_id == session_id)
        {
            self.teardown_forward(entry).await;
        }
    }

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.close_session_with_reason(session_id, None).await
    }

    async fn close_session_with_reason(
        &self,
        session_id: &str,
        reason: Option<&'static str>,
    ) -> Result<(), String> {
        // Teardown runs while the session is still registered so remote
        // listener cancellation can ride the (still open) SSH handle.
        self.stop_session_forwards(session_id).await;
        // sudo 下载远端临时件的会话级清理（finally 语义）：趁 SSH handle 还
        // 活着 best-effort 删除；失败只落提示——本地 .part 由
        // cleanup_session_transfers 删除，远端残留只能等下次同路径暂存或
        // 管理员清理（mktemp 名字带前缀，不会顶替任何现有文件）。
        let staged_tmps: Vec<(String, String)> = match self.downloads.lock() {
            Ok(downloads) => downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .filter_map(|(_, download)| {
                    download
                        .sudo_tmp
                        .clone()
                        .map(|tmp| (download.session_id.clone(), tmp))
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        for (owner_session, tmp) in staged_tmps {
            if let Err(error) = sudo_download::discard_tmp(self, &owner_session, &tmp).await {
                eprintln!("[sudo-download] session-close temp cleanup failed ({tmp}): {error}");
            }
        }
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("SSH session was not found")?;
        // 限时投递：读循环可能正阻塞在死 transport 的 channel.data() 上且
        // 输入队列（容量 256）已被灌满——无超时的 send 会无限期挂起，而
        // disconnect_connection 是逐会话串行 await，一个僵尸会话就能拖死
        // 整个断开 RPC。超时放弃即可：读循环随后会因 transport 死亡自行
        // 退出（spontaneous 路径有完整的会话收尾）。
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session.terminal_tx.send(TerminalCommand::Close { reason }),
        )
        .await;
        session.transport_lease.release().await;
        // 清理失败不得吞掉关闭结果：会话此刻已移出注册表、transport 已释放，
        // 对外就是「已关闭」——上抛只会让调用方重试并吃到 not found。
        if let Err(error) = self.cleanup_session_transfers(session_id).await {
            eprintln!("close_session: transfer cleanup for {session_id} failed: {error}");
        }
        if let Ok(mut cache) = self.metrics_cache.lock() {
            cache.remove(session_id);
        }
        // X11 gate lifecycle: the armed gate is the sidecar-wide slot (see
        // x11::ACTIVE_GATE) serving the most recently armed session. With
        // the last session gone no admission can be legitimate, so release
        // the cookie and fail closed until a session arms again.
        if self.sessions.read().await.is_empty() {
            crate::x11::disarm_active();
        }
        let connection_id = session.connection_id.clone();
        let connection_has_sessions = self
            .sessions
            .read()
            .await
            .values()
            .any(|session| session.connection_id == connection_id);
        if !connection_has_sessions {
            self.stop_sudo_keepalive(&connection_id).await;
            // No session left on the connection: the per-connection
            // forwarded-tcpip table can never match again.
            self.remote_tables
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&connection_id);
        }
        Ok(())
    }

    /// Read-only inventory of the sessions this sidecar currently tracks
    /// (tiny-rdm's `ListSessions`): connection/workbench identity, liveness,
    /// sudo-keepalive state and creation time. No SSH traffic is involved.
    pub async fn list_sessions(&self) -> Value {
        let sessions = self.sessions.read().await;
        let keepalives: std::collections::HashSet<String> = match self.sudo_keepalive.lock() {
            Ok(guard) => guard.keys().cloned().collect(),
            Err(_) => std::collections::HashSet::new(),
        };
        // Read-only auth method name per connection id for the info panel;
        // a poisoned store just means the panel shows the default method.
        let connections = self.connections.read().ok();
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, entry)| {
                let connection = connections
                    .as_deref()
                    .and_then(|store| store.get(&entry.connection_id));
                let auth_method = connection
                    .map(|connection| connection.authentication.method_name())
                    .unwrap_or("password");
                let endpoint = connection
                    .map(|connection| ConnectionEndpoint {
                        host: connection.host.clone(),
                        port: connection.port,
                        username: connection.username.clone(),
                    })
                    .unwrap_or_else(ConnectionEndpoint::fallback);
                let workbench_id = entry
                    .workbench_id
                    .read()
                    .map(|workbench| workbench.clone())
                    .unwrap_or_default();
                session_info_payload(
                    session_id,
                    &entry.connection_id,
                    &workbench_id,
                    entry.read_only,
                    entry.connected.load(Ordering::Acquire),
                    keepalives.contains(&entry.connection_id),
                    connection.map(|c| c.terminal_keepalive_secs).unwrap_or(0),
                    entry.created_at_secs,
                    auth_method,
                    &endpoint,
                    entry
                        .session_recorder
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .is_some(),
                )
            })
            .collect();
        drop(connections);
        drop(sessions);
        // Oldest first, stable by id — mirrors tiny-rdm's deterministic order.
        list.sort_by(|a, b| {
            a["createdAt"]
                .as_u64()
                .cmp(&b["createdAt"].as_u64())
                .then_with(|| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()))
        });
        json!({ "sessions": list })
    }

    pub async fn resize_terminal(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        self.session(session_id)
            .await?
            .terminal_tx
            .send(TerminalCommand::Resize { cols, rows })
            .await
            .map_err(|_| "Terminal is closed".to_string())
    }

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

    pub fn write_terminal(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        // Do not hold the session-map read guard while applying backpressure:
        // closing a dead session needs the write lock to drop the receiver so
        // a blocked sender can observe closure and return.
        let terminal_tx = {
            let sessions = self.sessions.blocking_read();
            sessions
                .get(session_id)
                .map(|session| session.terminal_tx.clone())
                // Same string as session() below — the workbench's dead-session
                // detection matches on this contract (App.vue input queue).
                .ok_or("SSH session was not found or expired")?
        };
        enqueue_terminal_input(&terminal_tx, data)
    }

    /// Normalizes one batch command into PTY key input: newlines become
    /// carriage returns (each an Enter for the remote shell), with a trailing
    /// Enter when `append_newline`. Bounded so a single batch write cannot
    /// flood a session's input queue. Pure for tests.
    fn batch_input_payload(command: &str, append_newline: bool) -> Vec<u8> {
        const MAX_BATCH_INPUT_BYTES: usize = 256 * 1024;
        let normalized = command.replace("\r\n", "\r").replace(['\n', '\r'], "\r");
        let mut payload = normalized.into_bytes();
        if payload.len() > MAX_BATCH_INPUT_BYTES {
            // Back off to a UTF-8 boundary: a raw byte cut would split a
            // multibyte character and send garbage to the remote shell.
            let mut end = MAX_BATCH_INPUT_BYTES;
            while end > 0 && (payload[end] & 0xC0) == 0x80 {
                end -= 1;
            }
            payload.truncate(end);
        }
        if append_newline {
            payload.push(b'\r');
        }
        payload
    }

    /// Deduplicates target ids while preserving call order. Pure for tests.
    fn dedupe_session_ids(session_ids: &[String]) -> Vec<String> {
        let mut seen = std::collections::HashSet::with_capacity(session_ids.len());
        session_ids
            .iter()
            .filter(|id| !id.is_empty() && seen.insert(id.as_str()))
            .cloned()
            .collect()
    }

    /// One per-target outcome row of `ssh/terminal/batchInput`. Pure for tests.
    fn batch_input_row(session_id: &str, error: Option<&str>) -> Value {
        match error {
            Some(error) => json!({ "sessionId": session_id, "success": false, "error": error }),
            None => json!({ "sessionId": session_id, "success": true }),
        }
    }

    /// Writes the same command into several open sessions' interactive shells
    /// (tiny-rdm batch send): per-target outcomes only, the command's output
    /// echoes in each session's own terminal. Unknown ids and full/closed
    /// input queues fail their target without failing the whole call.
    pub async fn batch_terminal_input(
        &self,
        session_ids: &[String],
        command: &str,
        append_newline: bool,
    ) -> Value {
        let payload = Self::batch_input_payload(command, append_newline);
        let targets = Self::dedupe_session_ids(session_ids);
        let sessions = self.sessions.read().await;
        let mut results = Vec::with_capacity(targets.len());
        let mut sent = 0u64;
        let mut failed = 0u64;
        for session_id in &targets {
            let outcome = match sessions.get(session_id.as_str()) {
                Some(session) => session
                    .terminal_tx
                    .try_send(TerminalCommand::Input(payload.clone()))
                    .map_err(|error| format!("SSH input queue is full or closed: {error}")),
                None => Err("SSH session was not found".to_string()),
            };
            match outcome {
                Ok(()) => {
                    sent += 1;
                    results.push(Self::batch_input_row(session_id, None));
                }
                Err(error) => {
                    failed += 1;
                    results.push(Self::batch_input_row(session_id, Some(&error)));
                }
            }
        }
        drop(sessions);
        json!({ "results": results, "sent": sent, "failed": failed })
    }

    pub async fn replay_terminal(
        &self,
        session_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let replay = session.replay.lock().await;
        let first_available_sequence = replay.first_sequence();
        let tail_sequence = replay.sequence;
        let frames = replay.after(after_sequence);
        drop(replay);
        for frame in &frames {
            emitter
                .binary(&format!("ssh/terminal/out/{session_id}"), &frame.encode())
                .map_err(plugin_error)?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": after_sequence.saturating_add(1) >= first_available_sequence
        }))
    }

    /// Picks the session to attach for a (re)opened workbench. Sessions are
    /// workbench-owned: never attach a different tab's live PTY, even when it
    /// uses the same saved connection.
    fn pick_attach_target(
        sessions: &[(String, String, String, bool)],
        connection_id: &str,
        workbench_id: &str,
    ) -> Option<String> {
        sessions
            .iter()
            .find(|(_, session_connection, session_workbench, connected)| {
                *connected
                    && session_connection.as_str() == connection_id
                    && session_workbench.as_str() == workbench_id
            })
            .map(|(session_id, _, _, _)| session_id.clone())
    }

    pub async fn attach_session(
        &self,
        connection_id: &str,
        workbench_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session_id = {
            let sessions = self.sessions.write().await;
            let snapshot: Vec<(String, String, String, bool)> = sessions
                .iter()
                .map(|(id, entry)| {
                    (
                        id.clone(),
                        entry.connection_id.clone(),
                        entry
                            .workbench_id
                            .read()
                            .map(|workbench| workbench.clone())
                            .unwrap_or_default(),
                        entry.connected.load(Ordering::Acquire),
                    )
                })
                .collect();
            Self::pick_attach_target(&snapshot, connection_id, workbench_id)
                .ok_or("No live SSH session is attached to this workbench")?
        };
        let replay = self
            .replay_terminal(&session_id, after_sequence, emitter)
            .await?;
        Ok(json!({
            "sessionId": session_id,
            "connectionId": connection_id,
            "workbenchId": workbench_id,
            "connected": true,
            "sequence": replay.get("tailSequence").and_then(Value::as_u64).unwrap_or(0),
            "replay": replay,
            "chunkSize": TRANSFER_CHUNK_SIZE
        }))
    }

    pub async fn close_workbench(&self, workbench_id: &str) -> Result<(), String> {
        let session_ids = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| {
                session
                    .workbench_id
                    .read()
                    .map(|workbench| workbench.as_str() == workbench_id)
                    .unwrap_or(false)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.close_session(&session_id).await;
        }
        Ok(())
    }

    async fn session(&self, session_id: &str) -> Result<Arc<SessionEntry>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or("SSH session was not found or expired".to_string())
    }

    pub(crate) async fn ensure_writable(&self, session_id: &str) -> Result<(), String> {
        if self.session(session_id).await?.read_only {
            Err("SFTP write operation is disabled by the read-only connection setting".to_string())
        } else {
            Ok(())
        }
    }

    /// Resolves one live transport handle for a connection — the resident
    /// monitor collectors open their own channels on an existing session's
    /// transport instead of dialing a second connection. Same registry scan
    /// as `attach_session`: entries are matched by connection id and must
    /// still be connected; any of the connection's workbench sessions
    /// qualifies (the transport is shared, the monitor never touches a
    /// terminal's PTY).
    pub async fn live_handle_for_connection(
        &self,
        connection_id: &str,
    ) -> Option<Arc<Handle<SshClient>>> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .find(|entry| {
                entry.connection_id == connection_id && entry.connected.load(Ordering::Acquire)
            })
            .map(|entry| Arc::clone(&entry.handle))
    }

    /// Completion-host read-only gate (FIG wave-1 lane B, decision D4):
    /// `completion/execute` must refuse SSH targets on read-only
    /// connections. Minimal read-only query only — no other behavior of
    /// this module changes.
    pub async fn completion_session_read_only(&self, session_id: &str) -> Result<bool, String> {
        Ok(self.session(session_id).await?.read_only)
    }
}

/// Outcome of trying every identity the SSH Agent offers for one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentAuthOutcome {
    Accepted,
    /// The server accepted an identity but still demands keyboard-interactive
    /// (MFA), so the caller must continue the handshake instead of reporting
    /// "no identity was accepted".
    NeedsKeyboardInteractive,
    /// No identity was accepted; the payload is the rejection reason planned
    /// by [`plan_agent_identity_attempt`] (first transport error verbatim, or
    /// the MaxAuthTries budget message).
    Rejected(String),
}

/// Plans the next agent-identity attempt against the MaxAuthTries budget.
/// Budget derivation: OpenSSH MaxAuthTries defaults to 6 *total* failures
/// including the leading none probe (ssh.rs:2456), so identity attempts
/// get 5.
const AGENT_IDENTITY_MAX_ATTEMPTS: usize = 5;

/// Decision of [`plan_agent_identity_attempt`] for the next agent identity.
#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentPlan {
    /// Try the next identity in the queue.
    TryNext,
    /// Stop and reject with this message.
    StopRejection(String),
    /// Stop because an identity was accepted and the server still demands
    /// keyboard-interactive (MFA) — the caller must continue the handshake.
    StopPartialSuccess,
}

/// Pure planner for the agent-identity loop: decides what to do after one
/// identity attempt without touching the session or the agent. Drives the
/// runtime loop in `authenticate_agent`; the tests below fix the contract
/// (attempt budget, first transport error stops, partial success + KI
/// advertisement stops).
///
/// - A transport-level `last_error` is terminal for *every* identity: all of
///   them share the same agent handle, so the first failure leaves no
///   recoverable path and burning further identities just wastes the
///   MaxAuthTries budget.
/// - A partial success advertises keyboard-interactive is the koko/PAM 2FA
///   shape: the identity was accepted and only the second factor is owed, so
///   trying more identities can never improve the outcome.
/// - A full rejection just moves to the next identity while budget remains.
///   During per-identity attempts the server's advertised method set does not
///   change, so a publickey rejection never implies "publickey withdrawn".
/// - `AuthResult::Success` never reaches the planner (the caller returns).
fn plan_agent_identity_attempt(
    attempts_so_far: usize,
    last_result: Option<&AuthResult>,
    last_error: Option<&str>,
) -> AgentPlan {
    // The first transport error is final: every remaining identity would
    // re-dial the same dead agent handle.
    if let Some(error) = last_error {
        return AgentPlan::StopRejection(error.to_string());
    }
    if let Some(result) = last_result {
        if auth_partial_success(result) && method_offered(result, MethodKind::KeyboardInteractive) {
            return AgentPlan::StopPartialSuccess;
        }
    }
    if attempts_so_far >= AGENT_IDENTITY_MAX_ATTEMPTS {
        // MaxAuthTries is a *total* budget (the leading none probe already
        // spent one): once the identity budget is exhausted the server has
        // usually already dropped the connection, and further attempts would
        // only surface as confusing transport errors.
        return AgentPlan::StopRejection(
            "server may have disconnected after too many auth attempts (MaxAuthTries); \
             consider specifying a private key"
                .to_string(),
        );
    }
    AgentPlan::TryNext
}

async fn authenticate_agent(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<AgentAuthOutcome, String> {
    #[cfg(unix)]
    let mut agent = if connection.agent_socket.is_empty() {
        AgentClient::connect_env()
            .await
            .map_err(|error| format!("SSH Agent is unavailable: {error}"))?
    } else {
        AgentClient::connect_uds(&connection.agent_socket)
            .await
            .map_err(|error| {
                format!(
                    "SSH Agent at '{}' is unavailable: {error}",
                    connection.agent_socket
                )
            })?
    };

    #[cfg(windows)]
    let mut agent = {
        let stream = pageant::PageantStream::new()
            .await
            .map_err(|error| format!("Windows Pageant is unavailable: {error}"))?;
        AgentClient::connect(stream)
    };

    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("Failed to list SSH Agent identities: {error}"))?;
    if identities.is_empty() {
        return Err("SSH Agent has no identities".to_string());
    }
    let hash = session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let outcome = tokio::time::timeout(
        Duration::from_secs(connection.connect_timeout_secs),
        async {
            // Planner-driven identity loop: every round consults
            // [`plan_agent_identity_attempt`] before spending another
            // MaxAuthTries slot, so a transport error or a partial success
            // advertising keyboard-interactive stops the queue immediately
            // instead of burning the remaining budget.
            let mut attempts: usize = 0;
            let mut last_result: Option<AuthResult> = None;
            let mut last_error: Option<String> = None;
            let mut identities = identities.into_iter();
            loop {
                match plan_agent_identity_attempt(
                    attempts,
                    last_result.as_ref(),
                    last_error.as_deref(),
                ) {
                    AgentPlan::TryNext => {}
                    AgentPlan::StopPartialSuccess => {
                        return AgentAuthOutcome::NeedsKeyboardInteractive;
                    }
                    AgentPlan::StopRejection(reason) => {
                        return AgentAuthOutcome::Rejected(reason);
                    }
                }
                let Some(identity) = identities.next() else {
                    // The identity queue drained while the planner still said
                    // TryNext (fewer identities than the budget): keep the
                    // historical generic rejection text for this shape.
                    return AgentAuthOutcome::Rejected(
                        "No SSH Agent identity was accepted".to_string(),
                    );
                };
                attempts += 1;
                let result = match &identity {
                    AgentIdentity::PublicKey { key, .. } => {
                        session
                            .authenticate_publickey_with(
                                &connection.username,
                                key.clone(),
                                hash,
                                &mut agent,
                            )
                            .await
                    }
                    AgentIdentity::Certificate { certificate, .. } => {
                        session
                            .authenticate_certificate_with(
                                &connection.username,
                                certificate.clone(),
                                hash,
                                &mut agent,
                            )
                            .await
                    }
                };
                match result {
                    Ok(result) if result.success() => return AgentAuthOutcome::Accepted,
                    Ok(result) => last_result = Some(result),
                    // Every identity shares one agent handle: the first
                    // transport error is terminal, and the planner surfaces
                    // its text verbatim on the next round.
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
        },
    )
    .await
    .map_err(|_| "SSH Agent authentication timed out".to_string())?;
    Ok(outcome)
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
