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

mod endpoint;
mod leases;
mod monitor;
mod prompt;
mod settings;
mod sftp_helpers;
mod sftp_ops;
mod sftp_session;
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

use endpoint::*;
use leases::*;
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

/// Shared dial deadline. While a host-key challenge waits for the user, the
/// dial timeout budget is suspended so the SSH connect future is not killed
/// underneath the confirmation dialog.
#[derive(Default)]
struct DialDeadline {
    deadline_ms: AtomicU64,
    challenge_pending: AtomicBool,
}

impl DialDeadline {
    fn start(timeout: Duration) -> Arc<Self> {
        let state = Arc::new(Self::default());
        state.deadline_ms.store(
            Self::epoch_ms() + timeout.as_millis() as u64,
            Ordering::SeqCst,
        );
        state
    }

    fn epoch_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0)
    }

    fn enter_challenge(&self, extra: Duration) {
        self.challenge_pending.store(true, Ordering::SeqCst);
        self.deadline_ms.store(
            Self::epoch_ms() + extra.as_millis() as u64,
            Ordering::SeqCst,
        );
    }

    fn exit_challenge(&self, timeout: Duration) {
        self.challenge_pending.store(false, Ordering::SeqCst);
        self.deadline_ms.store(
            Self::epoch_ms() + timeout.as_millis() as u64,
            Ordering::SeqCst,
        );
    }

    fn remaining(&self) -> Option<Duration> {
        let now = Self::epoch_ms();
        let deadline = self.deadline_ms.load(Ordering::SeqCst);
        deadline.checked_sub(now).map(Duration::from_millis)
    }
}

/// Host-key challenges wait up to this long for a decision; the value also
/// caps how far the dial deadline may be pushed out while a challenge runs.
const HOST_KEY_CHALLENGE_WAIT: Duration = Duration::from_secs(300);

pub struct SshClient {
    verifier: Arc<HostKeyVerifier>,
    prompts: PromptBroker,
    /// Event emitter; `None` in MCP stdio mode where stdout belongs to the
    /// JSON-RPC protocol and unknown host keys are trusted on first use.
    emitter: Option<PluginEmitter>,
    auto_trust: bool,
    host: String,
    port: u16,
    connection_id: String,
    operation_id: String,
    dial_deadline: Arc<DialDeadline>,
    connect_timeout: Duration,
    /// Remote (-R) port mappings of this connection: `(listen_host,
    /// bound_port) -> local dial target`. Populated by `ssh/forward/start`
    /// and consulted by the forwarded-tcpip handler below; per-connection so
    /// two servers can forward the same port independently.
    remote_forwards: Arc<RemoteForwardTable>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match self
            .verifier
            .check(&self.host, self.port, server_public_key)
        {
            Ok(HostKeyState::Trusted) => {
                eprintln!(
                    "[ssh-trace] host-key trusted {}:{}, fingerprint ok",
                    self.host, self.port
                );
                Ok(true)
            }
            Ok(HostKeyState::Unknown) => {
                eprintln!(
                    "[ssh-trace] host-key unknown {}:{} (auto_trust={})",
                    self.host, self.port, self.auto_trust
                );
                if self.auto_trust {
                    // Trust-on-first-use for MCP mode: keys land in the same
                    // known_hosts store and changes are still rejected.
                    if let Err(error) =
                        self.verifier
                            .learn(&self.host, self.port, server_public_key)
                    {
                        eprintln!("[ssh-sftp-plugin] failed to record host key: {error}");
                    }
                    return Ok(true);
                }
                let Some(emitter) = self.emitter.as_ref() else {
                    eprintln!("[ssh-trace] host-key unknown and no emitter -> reject");
                    return Ok(false);
                };
                // The user may take arbitrarily long to confirm the
                // fingerprint; that wait must not consume the dial timeout.
                self.dial_deadline
                    .enter_challenge(HOST_KEY_CHALLENGE_WAIT + self.connect_timeout);
                eprintln!("[ssh-trace] host-key challenge raised, waiting for user decision");
                let decision = self
                    .prompts
                    .request(
                        &self.host,
                        self.port,
                        server_public_key.algorithm().to_string(),
                        server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                        &self.connection_id,
                        &self.operation_id,
                        emitter,
                    )
                    .await;
                self.dial_deadline.exit_challenge(self.connect_timeout);
                eprintln!(
                    "[ssh-trace] host-key challenge resolved: present={} accept={:?} remember={:?}",
                    decision.is_some(),
                    decision.as_ref().map(|d| d.accept),
                    decision.as_ref().map(|d| d.remember)
                );
                let Some(decision) = decision else {
                    return Ok(false);
                };
                if !decision.accept {
                    return Ok(false);
                }
                if decision.remember {
                    if let Err(error) =
                        self.verifier
                            .learn(&self.host, self.port, server_public_key)
                    {
                        let _ = emitter.event(
                            "ssh/host-key/notice",
                            json!({ "kind": "learn-failed", "message": error.to_string() }),
                        );
                    }
                }
                Ok(true)
            }
            Err(error) => {
                eprintln!(
                    "[ssh-trace] host-key CHANGED for {}:{}: {error}",
                    self.host, self.port
                );
                if let Some(emitter) = self.emitter.as_ref() {
                    let _ = emitter.event(
                        "ssh/host-key/notice",
                        json!({ "kind": "changed", "message": error.to_string() }),
                    );
                }
                Err(russh::Error::from(error))
            }
        }
    }

    /// Incoming `forwarded-tcpip` channel: the server accepted a connection
    /// on a port this side registered with `tcpip-forward` (remote -R
    /// mapping). The local dial target is looked up in this connection's
    /// remote-forward table; the relay runs detached so the handler returns
    /// immediately and the SSH reader is never blocked by user traffic.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = originator_address;
        let _ = originator_port;
        let _ = session;
        let target =
            forward::lookup_remote_target(&self.remote_forwards, connected_address, connected_port);
        let Some(target) = target else {
            eprintln!(
                "[ssh-forward] forwarded-tcpip {connected_address}:{connected_port} has no registered mapping; rejecting"
            );
            reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        // Dial from the client machine; on failure the channel is dropped,
        // which the server surfaces as a closed connection to its client.
        match TcpStream::connect((target.host.as_str(), target.port)).await {
            Ok(tcp) => {
                // 计数与句柄登记走 forward 侧统一入口：relay 进 entry.relays，
                // stop/会话关闭才能中止它（此前 detach 的 relay 会躲过 abort，
                // 挂死连接一直存活到通道自然终结）。
                forward::spawn_remote_relay(target.entry, channel, tcp);
            }
            Err(error) => {
                eprintln!(
                    "[ssh-forward] local dial {}:{} failed: {error}",
                    target.host, target.port
                );
            }
        }
        Ok(())
    }

    /// Incoming `x11` channel: the server accepted the `x11-req` sent when
    /// the shell opened and a remote X client connected. russh's default
    /// handler accepts unconditionally, so this override is the fail-closed
    /// boundary (docs/SPIKE_X11_FORWARDING.zh-CN.md §3.4): the armed-session
    /// gate must admit the channel and the X setup block must carry the
    /// issued fake cookie before a single byte is relayed to the local
    /// display. SSH delivers channel data only after the open is confirmed,
    /// so the channel is accepted first and then held (nothing relayed)
    /// until the setup block validates; a mismatch closes it immediately.
    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = (originator_address, originator_port, session);
        // Admission first: no armed gate (X11 off or the last session
        // closed) or the armed gate's bridge cap exhausted -> reject, never
        // accept.
        let Some((cookie, permit)) = crate::x11::try_admit_active() else {
            eprintln!("[x11] channel refused: no armed gate or the bridge cap is exhausted");
            reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        // The relay runs detached so the SSH reader is never blocked by X
        // traffic; the admission permit travels with the task and frees its
        // cap slot whenever the task ends.
        tokio::spawn(async move {
            // Keeping the admission permit alive for the bridge's lifetime
            // holds the cap slot; its Drop frees the slot whenever this
            // task ends (bridge finished, setup rejected, or channel gone).
            let _bridge_permit = permit;
            let mut channel = channel;
            let mut buffer = crate::x11::SetupBuffer::default();
            let verdict = loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => match buffer.push(&data, &cookie) {
                        crate::x11::SetupInspection::Incomplete => continue,
                        verdict => break verdict,
                    },
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        break crate::x11::SetupInspection::Reject(
                            "x11 channel closed before the X setup block arrived",
                        );
                    }
                    Some(_) => continue,
                }
            };
            match verdict {
                crate::x11::SetupInspection::Accept { cookie_offset } => {
                    let mut setup = buffer.into_bytes();
                    let target = crate::x11::current_display_target();
                    crate::x11::substitute_cookie(
                        &mut setup,
                        cookie_offset,
                        crate::x11::load_real_cookie(&target).as_deref(),
                    );
                    if let Err(error) = crate::x11::bridge_channel(channel, &target, setup).await {
                        eprintln!("[x11] {error}");
                    }
                }
                crate::x11::SetupInspection::Reject(reason) => {
                    eprintln!("[x11] x11 channel rejected: {reason}");
                    let _ = channel.close().await;
                }
                crate::x11::SetupInspection::Incomplete => {
                    unreachable!("the setup loop only breaks on a final verdict")
                }
            }
        });
        Ok(())
    }
}

/// Verdict of a key-exchange-only host-key probe against the known_hosts
/// stores.
#[derive(Debug, Clone, PartialEq)]
enum HostKeyVerdict {
    Trusted,
    Unknown,
    /// A recorded key differs from the presented one; carries the
    /// verifier's explanation (possible man-in-the-middle).
    Changed(String),
}

fn host_key_verdict(check: Result<HostKeyState, std::io::Error>) -> HostKeyVerdict {
    match check {
        Ok(HostKeyState::Trusted) => HostKeyVerdict::Trusted,
        Ok(HostKeyState::Unknown) => HostKeyVerdict::Unknown,
        Err(error) => HostKeyVerdict::Changed(error.to_string()),
    }
}

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

/// Key-exchange-only probe handler (tiny-rdm's CheckHostKey equivalent):
/// the server key is fingerprinted and compared against the known_hosts
/// stores, then the handshake is aborted with `Ok(false)` so no
/// authentication, challenge, or session ever happens. Deliberately not
/// `SshClient`, whose check_server_key would raise a host-key challenge.
struct HostKeyProbe {
    verifier: Arc<HostKeyVerifier>,
    host: String,
    port: u16,
    seen: Arc<Mutex<Option<(HostKeyVerdict, String, String)>>>,
}

impl client::Handler for HostKeyProbe {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let verdict = host_key_verdict(self.verifier.check(
            &self.host,
            self.port,
            server_public_key,
        ));
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some((
                verdict,
                server_public_key.algorithm().to_string(),
                server_public_key.fingerprint(HashAlg::Sha256).to_string(),
            ));
        }
        // Abort before authentication; russh surfaces this as
        // Error::UnknownKey and tears the transport down on drop.
        Ok(false)
    }
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

#[derive(Default)]
struct DirectoryHandshakeFilter {
    marker: Option<Vec<u8>>,
    buffered: Vec<u8>,
    started_at: Option<Instant>,
    failed: bool,
}

impl DirectoryHandshakeFilter {
    fn begin(&mut self, marker: Vec<u8>) {
        self.marker = Some(marker);
        self.buffered.clear();
        self.started_at = Some(Instant::now());
        self.failed = false;
    }

    fn filter(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        let Some(marker) = self.marker.as_ref() else {
            return Some(data.to_vec());
        };
        self.buffered.extend_from_slice(data);
        if self.buffered.len() > DIRECTORY_HANDSHAKE_LIMIT {
            return self.fail_open();
        }
        let index = find_bytes(&self.buffered, marker)?;
        let result = self.buffered[index + marker.len()..].to_vec();
        self.marker = None;
        self.buffered.clear();
        self.started_at = None;
        (!result.is_empty()).then_some(result)
    }

    fn flush_if_timed_out(&mut self) -> Option<Vec<u8>> {
        if self
            .started_at
            .is_some_and(|started| started.elapsed() >= DIRECTORY_HANDSHAKE_TIMEOUT)
        {
            return self.fail_open();
        }
        None
    }

    fn take_failed(&mut self) -> bool {
        std::mem::take(&mut self.failed)
    }

    fn fail_open(&mut self) -> Option<Vec<u8>> {
        self.marker = None;
        self.started_at = None;
        self.failed = true;
        let buffered = std::mem::take(&mut self.buffered);
        (!buffered.is_empty()).then_some(buffered)
    }
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

    /// `ssh/agent/mode/get`: connection-scoped agent terminal mode probe for
    /// the MCP bridge — the DBX app asks this before forwarding a stdio tool
    /// call so it can decide whether the workbench tab must exist for a
    /// terminal-routed exec. No sessionId by design: the caller holds only
    /// the connection id, and unknown ids degrade to `off` instead of
    /// erroring (an old/stale reference must never break the silent path).
    pub async fn agent_mode_get(&self, connection_id: &str) -> Result<Value, String> {
        let has_terminal_session = self.session_id_for_connection(connection_id).await.is_ok();
        Ok(json!({
            "agentTerminalMode": self.agent_terminal_mode(connection_id).name(),
            "hasTerminalSession": has_terminal_session,
        }))
    }

    /// Runs a command on the session's connection, optionally with Quick Sudo
    /// orchestration (password injection plus automatic 2FA/TOTP answers).
    pub async fn exec(
        &self,
        session_id: &str,
        exec_id: Option<&str>,
        command: &str,
        sudo: bool,
        timeout_secs: Option<u64>,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        if sudo && session.read_only {
            return Err(
                "Sudo execution is disabled by the read-only connection setting".to_string(),
            );
        }
        let timeout = Duration::from_secs(
            timeout_secs
                .unwrap_or(if sudo {
                    SUDO_EXEC_TIMEOUT.as_secs()
                } else {
                    PLAIN_EXEC_TIMEOUT.as_secs()
                })
                .clamp(5, 300),
        );
        // Connection config is needed on both paths now: Quick Sudo
        // orchestration for sudo, and the client-specified setEnv either way.
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .cloned()
            .ok_or("Connection is not active; reopen it from DBX".to_string())?;
        if sudo && !connection.sudo_enabled() {
            return Err("Quick Sudo is disabled for this connection".to_string());
        }
        let orchestration = session
            .orchestration
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let keepalive_handle = session.handle.clone();
        let connection_id = session.connection_id.clone();
        let keepalive_session_id = session_id.to_string();
        let handle = session.handle.clone();
        let command = command.to_string();

        let use_pty = if sudo {
            let store = sudo_profiles::load_store(&self.data_dir);
            sudo_profiles::effective_use_pty(
                connection.sudo_use_pty,
                effective_sudo_profile(&connection, &store).as_ref(),
            )
        } else {
            false
        };
        // cancel_exec 经 watch 发信号：exec 在下一个 await 点退出并经既有
        // Err 路径优雅关闭 channel。裸 abort 会在 await 点丢弃 russh
        // Channel——drop 不发 SSH_MSG_CHANNEL_CLOSE，远端进程残留，sudo 还
        // 会持有 timestamp 锁死锁后续 sudo（exec.rs abort_exec_channel 的
        // 自述场景）。
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        let run = async move {
            let outcome = if sudo {
                exec::exec_with_sudo_cancellable(
                    &handle,
                    &orchestration,
                    &command,
                    timeout,
                    use_pty,
                    &connection.set_env,
                    &mut cancel_rx,
                )
                .await?
            } else {
                exec::exec_plain_cancellable(
                    &handle,
                    &command,
                    timeout,
                    &connection.set_env,
                    &mut cancel_rx,
                )
                .await?
            };
            Ok(outcome)
        };

        let outcome = match exec_id.filter(|id| !id.is_empty()) {
            Some(exec_id) => {
                let exec_id = exec_id.to_string();
                let task = tokio::spawn(run);
                if let Ok(mut tasks) = self.exec_tasks.lock() {
                    tasks.insert(exec_id.clone(), cancel_tx);
                }
                let result = task
                    .await
                    .map_err(|join_error| {
                        if join_error.is_cancelled() {
                            "Remote command was cancelled".to_string()
                        } else {
                            "Remote command task failed".to_string()
                        }
                    })
                    .and_then(|inner| inner);
                if let Ok(mut tasks) = self.exec_tasks.lock() {
                    tasks.remove(&exec_id);
                }
                result?
            }
            None => run.await?,
        };
        if sudo {
            self.register_sudo_keepalive(&connection_id, &keepalive_session_id, keepalive_handle);
        }
        Ok(self.exec_response(&outcome))
    }

    /// Aborts an in-flight `ssh/exec`; ported from tiny-rdm's AbortCommand.
    /// Sends the cancellation signal instead of aborting the task: the exec
    /// future exits at its next await point and closes the channel through
    /// the regular error path (see [`exec::EXEC_CANCELLED_MESSAGE`]), so the
    /// remote process — and any sudo timestamp lock it holds — is reaped by
    /// sshd instead of leaking with the dropped future.
    pub fn cancel_exec(&self, exec_id: &str) -> Result<(), String> {
        let task = self
            .exec_tasks
            .lock()
            .map_err(|_| "Exec registry is poisoned".to_string())?
            .remove(exec_id);
        match task {
            // Send fails only when the receiver is gone (task already
            // finished; registry removal raced the finish) — nothing to do.
            Some(cancel) => {
                let _ = cancel.send(true);
                Ok(())
            }
            None => Err("Remote command was not found or already finished".to_string()),
        }
    }

    fn exec_response(&self, outcome: &ExecOutcome) -> Value {
        json!({
            "success": true,
            "output": outcome.output,
            "exitCode": outcome.exit_code,
        })
    }

    /// Per-connection AI terminal mode; unknown connections read `off`.
    pub fn agent_terminal_mode(&self, connection_id: &str) -> AgentTerminalMode {
        self.agent_modes
            .lock()
            .ok()
            .and_then(|modes| modes.get(connection_id).copied())
            .unwrap_or(AgentTerminalMode::Off)
    }

    fn set_agent_terminal_mode(
        &self,
        connection_id: &str,
        mode: AgentTerminalMode,
    ) -> Result<(), String> {
        let snapshot = {
            let mut modes = self
                .agent_modes
                .lock()
                .map_err(|_| "Agent mode registry is poisoned".to_string())?;
            if mode == AgentTerminalMode::Off {
                // Persisted off is the default: dropping the entry keeps the
                // file bounded by connections the user actually opted in.
                modes.remove(connection_id);
            } else {
                modes.insert(connection_id.to_string(), mode);
            }
            modes.clone()
        };
        agent_terminal::save_modes(&self.data_dir, &snapshot)
    }

    /// Acquires the session's agent-execution lock for the caller. The owned
    /// guard is returned so `ssh_exec_terminal_tool` can hold it across the
    /// approval wait and the whole run — holding across `await` is the
    /// deliberate serialization (a queued command must wait out an in-flight
    /// approval, not race it). Per-session by design: different connections
    /// keep running in parallel.
    pub(crate) async fn agent_exec_guard(
        &self,
        session_id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
        let session = self.session(session_id).await?;
        let lock = Arc::clone(&session.agent_exec_lock);
        Ok(lock.lock_owned().await)
    }

    /// Runs an AI/MCP command inside the session's interactive PTY: the
    /// command is typed into the user's terminal (visible, interruptible),
    /// the output is captured by a session-level recorder, and the captured
    /// text is returned once a fresh prompt settles. On timeout the partial
    /// output is returned with `incomplete: true` and the command keeps
    /// running in the terminal for the user to take over.
    pub async fn exec_in_terminal(
        &self,
        session_id: &str,
        tool: &str,
        command: &str,
        risk: CommandRisk,
        timeout_secs: Option<u64>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or(NO_TERMINAL_SESSION_MESSAGE.to_string())?;
        // Strip control characters so the injected text cannot drive the
        // terminal or the auto-sudo state machine (same trust domain as the
        // quick-command bar: raw keyboard input, no shell quoting surface).
        let command = agent_terminal::sanitize_command(command)?;
        let timeout = Duration::from_secs(
            timeout_secs
                .unwrap_or(PLAIN_EXEC_TIMEOUT.as_secs())
                .clamp(5, 300),
        );

        // Install the recorder before injecting so no output is lost. The
        // first line of the command gates settling: without its echo the
        // recorder would settle on the login-banner prompt before the shell
        // even processed the injection (boot-restore race).
        let echo_fragment = command
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        {
            let mut slot = session
                .agent_recorder
                .lock()
                .map_err(|_| "Terminal recorder is poisoned".to_string())?;
            let mut recorder = TerminalRecorder::default();
            recorder.arm(&echo_fragment);
            *slot = Some(recorder);
        }
        let _ = emitter.event(
            "ssh/agent/notice",
            json!({
                "sessionId": session_id,
                "tool": tool,
                "command": command,
                "risk": risk.name(),
            }),
        );

        // Inject like the quick-command bar: raw text plus a carriage
        // return on the session's PTY input queue. The send is bounded so a
        // zombie session (dead read loop, full queue) cannot park the agent
        // call forever.
        let payload = format!("{command}\r").into_bytes();
        let injected = tokio::time::timeout(
            Duration::from_secs(5),
            session.terminal_tx.send(TerminalCommand::Input(payload)),
        )
        .await;
        match injected {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                if let Ok(mut slot) = session.agent_recorder.lock() {
                    *slot = None;
                }
                return Err(format!("Terminal is closed: {error}"));
            }
            Err(_) => {
                if let Ok(mut slot) = session.agent_recorder.lock() {
                    *slot = None;
                }
                return Err("Terminal is not accepting input (session unresponsive)".to_string());
            }
        }

        // Poll the recorder: prompt-seen plus 300ms of silence, or deadline.
        // A closed session (workbench tab closed mid-run) ends the wait with
        // a dedicated error instead of masquerading as a timeout.
        let deadline = tokio::time::Instant::now() + timeout;
        let mut poll_cycles = 0usize;
        let timed_out = loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            poll_cycles += 1;
            let settled = session
                .agent_recorder
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().map(TerminalRecorder::is_settled))
                .unwrap_or(false);
            if settled {
                break false;
            }
            if poll_cycles.is_multiple_of(20)
                && !self.sessions.read().await.contains_key(session_id)
            {
                if let Ok(mut slot) = session.agent_recorder.lock() {
                    slot.take();
                }
                let _ = emitter.event(
                    "ssh/agent/finish",
                    json!({ "sessionId": session_id, "status": "timeout" }),
                );
                return Err("Terminal session was closed while the command was running".to_string());
            }
            if tokio::time::Instant::now() >= deadline {
                break true;
            }
        };

        // Always remove the recorder; the read loop skips the empty slot.
        let recorder = session
            .agent_recorder
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        let output = match recorder {
            Some(mut recorder) => {
                if timed_out {
                    // Force the capture closed; the command keeps running in
                    // the terminal and the AI gets the partial output.
                    recorder.finish();
                }
                recorder.take_output(&command)
            }
            None => String::new(),
        };

        let _ = emitter.event(
            "ssh/agent/finish",
            json!({
                "sessionId": session_id,
                "status": if timed_out { "timeout" } else { "done" },
            }),
        );

        // exitCode stays null without shell integration: the AI judges from
        // the output text. `interrupted` is reserved for the workbench
        // interrupt button and stays false on this path.
        Ok(json!({
            "output": output,
            "exitCode": null,
            "mode": "terminal",
            "incomplete": timed_out,
            "interrupted": false,
        }))
    }

    /// Pure builder for the MCP confirm challenge payload (IMPL_PLAN §1.3):
    /// the shared `ssh/agent/prompt` event with `kind: "mcp-confirm"` and
    /// `source: "mcp"` (legacy terminal approvals never carry `source`, so
    /// the workbench can tell the two apart; older frontends fall back to
    /// their existing rendering). Unit-tested shape.
    pub(crate) fn mcp_confirm_challenge_payload(
        challenge_id: &str,
        tool: &str,
        command: &str,
        connection_id: Option<&str>,
        timeout_secs: u64,
    ) -> Value {
        let mut payload = json!({
            "challengeId": challenge_id,
            "kind": "mcp-confirm",
            "source": "mcp",
            "tool": tool,
            "command": command,
            "requestedAt": unix_now_secs(),
            "timeoutSecs": timeout_secs,
        });
        if let Some(id) = connection_id.filter(|id| !id.is_empty()) {
            payload["connectionId"] = json!(id);
        }
        payload
    }

    /// MCP confirm permission gate (IMPL_PLAN §1.3): raises a
    /// `ssh/agent/prompt` approval challenge (kind `mcp-confirm`,
    /// source `mcp`) on the workbench and waits for `ssh/agent/resolve`.
    /// Returns the (possibly user-edited) command on approval; denial or
    /// the 120s timeout returns `Err`. One-shot challenge semantics are
    /// shared with the terminal approval path (`resolve_agent_challenge`).
    /// There is deliberately no session binding and no terminal follow-up
    /// events — an MCP confirm never types into a terminal.
    pub(crate) async fn request_mcp_confirm(
        &self,
        tool: &str,
        command: &str,
        connection_id: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<String, String> {
        let wait = Duration::from_secs(MCP_CONFIRM_TIMEOUT_SECS);
        let challenge_id = Uuid::new_v4().to_string();
        let connection_id = connection_id.unwrap_or_default().to_string();
        let raised_at_ms = unix_now_ms();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut challenges) = self.agent_challenges.lock() {
            challenges.insert(
                challenge_id.clone(),
                PendingChallenge {
                    sender,
                    connection_id: connection_id.clone(),
                    tool: tool.to_string(),
                    command: command.to_string(),
                    raised_at_ms,
                },
            );
        }
        let raised = emitter.event(
            "ssh/agent/prompt",
            Self::mcp_confirm_challenge_payload(
                &challenge_id,
                tool,
                command,
                Some(&connection_id),
                wait.as_secs(),
            ),
        );
        if let Err(error) = raised {
            // Nobody can approve without the prompt; fail fast instead of
            // letting the challenge run into its timeout.
            if let Ok(mut challenges) = self.agent_challenges.lock() {
                challenges.remove(&challenge_id);
            }
            return Err(format!(
                "Failed to raise the approval prompt: {}",
                error.message
            ));
        }
        let decision = match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(decision)) => Some(decision),
            // Timeout or dropped sender both mean "no user decision"; the
            // challenge is expired so a late resolve reports not found.
            Ok(Err(_)) | Err(_) => {
                if let Ok(mut challenges) = self.agent_challenges.lock() {
                    challenges.remove(&challenge_id);
                }
                None
            }
        };
        match decision {
            Some(AgentDecision::Approve { command: edited }) => {
                let edited = edited.filter(|text| !text.trim().is_empty());
                Ok(edited.unwrap_or_else(|| command.to_string()))
            }
            Some(AgentDecision::Deny) => {
                Err("Command not run: user denied the execution".to_string())
            }
            None => Err("Command not run: approval timed out waiting for the user".to_string()),
        }
    }

    /// Raises an approval challenge for a terminal-routed agent command:
    /// emits `ssh/agent/prompt`, then waits for `ssh/agent/resolve`.
    /// Returns the (possibly user-edited) command on approval; denial or
    /// timeout returns `Err` and emits `ssh/agent/finish{status:"denied"}`.
    pub(crate) async fn request_agent_approval(
        &self,
        session_id: &str,
        tool: &str,
        command: &str,
        risk: CommandRisk,
        timeout_secs: Option<u64>,
        emitter: &PluginEmitter,
    ) -> Result<String, String> {
        let wait = Duration::from_secs(
            timeout_secs
                .unwrap_or(AGENT_APPROVAL_DEFAULT_SECS)
                .clamp(AGENT_APPROVAL_MIN_SECS, AGENT_APPROVAL_MAX_SECS),
        );
        let challenge_id = Uuid::new_v4().to_string();
        let session = self.session(session_id).await?;
        let connection_id = session.connection_id.clone();
        let raised_at_ms = unix_now_ms();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut challenges) = self.agent_challenges.lock() {
            challenges.insert(
                challenge_id.clone(),
                PendingChallenge {
                    sender,
                    connection_id,
                    tool: tool.to_string(),
                    command: command.to_string(),
                    raised_at_ms,
                },
            );
        }
        let raised = emitter.event(
            "ssh/agent/prompt",
            json!({
                "challengeId": challenge_id,
                "sessionId": session_id,
                "tool": tool,
                "command": command,
                "risk": risk.name(),
                "requestedAt": unix_now_secs(),
                "timeoutSecs": wait.as_secs(),
            }),
        );
        if let Err(error) = raised {
            // Nobody can approve without the prompt; fail fast instead of
            // letting the challenge run into its timeout.
            if let Ok(mut challenges) = self.agent_challenges.lock() {
                challenges.remove(&challenge_id);
            }
            return Err(format!(
                "Failed to raise the approval prompt: {}",
                error.message
            ));
        }
        let decision = match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(decision)) => Some(decision),
            // Timeout or dropped sender both mean "no user decision".
            Ok(Err(_)) | Err(_) => {
                // Expire the challenge so a late resolve reports not found.
                if let Some(pending) = self
                    .agent_challenges
                    .lock()
                    .ok()
                    .and_then(|mut challenges| challenges.remove(&challenge_id))
                {
                    self.audit_approval(
                        &pending.tool,
                        &pending.connection_id,
                        Some(&pending.command),
                        audit_log::ApprovalTrail::Timeout,
                        audit_log::EntryOutcome::Error,
                        unix_now_ms().saturating_sub(pending.raised_at_ms),
                    );
                }
                None
            }
        };
        // Approved: the follow-up notice/finish pair comes from
        // exec_in_terminal — emitting "denied" here would flash the workbench
        // banner state for a command that is about to run.
        if let Some(AgentDecision::Approve { command: edited }) = decision {
            let edited = edited.filter(|text| !text.trim().is_empty());
            return Ok(edited.unwrap_or_else(|| command.to_string()));
        }
        let _ = emitter.event(
            "ssh/agent/finish",
            json!({ "sessionId": session_id, "status": "denied" }),
        );
        match decision {
            Some(AgentDecision::Deny) => {
                Err("Command not run: user denied the terminal execution".to_string())
            }
            None => Err("Command not run: approval timed out waiting for the user".to_string()),
            Some(AgentDecision::Approve { .. }) => unreachable!("handled above"),
        }
    }

    /// Resolves a pending agent approval challenge (`ssh/agent/resolve`).
    /// One-shot: the challenge is removed from the registry before the
    /// decision is delivered, so a repeat resolve reports not found.
    /// `decision` is "approve" or "deny"; `command` carries the edited
    /// command text from the approval dialog (approve only); `remember`
    /// (approve only) persists the approved command on the connection's
    /// remembered-approval list so later identical matches skip the prompt.
    pub fn resolve_agent_challenge(
        &self,
        challenge_id: &str,
        decision: &str,
        command: Option<&str>,
        remember: bool,
    ) -> Result<(), String> {
        let approved = match decision {
            "approve" => true,
            "deny" => false,
            other => {
                return Err(format!(
                    "agent decision must be \"approve\" or \"deny\"; got '{other}'"
                ))
            }
        };
        let pending = self
            .agent_challenges
            .lock()
            .map_err(|_| "Agent challenge registry is poisoned".to_string())?
            .remove(challenge_id)
            .ok_or("Agent challenge was not found or already resolved")?;
        let decision = if approved {
            AgentDecision::Approve {
                command: command.map(str::to_string),
            }
        } else {
            AgentDecision::Deny
        };
        let mut remembered = false;
        if approved && remember {
            // The remembered text is what the dialog showed the user — the
            // edited command when one was sent, otherwise the original.
            let text = command
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .unwrap_or(&pending.command);
            // A destructive command is never rememberable (IMPL_PLAN D2):
            // the flag is silently dropped and the approval stays one-shot.
            let mut store = agent_approvals::load_store(&self.data_dir);
            match agent_approvals::remember(&mut store, &pending.connection_id, text) {
                Ok(newly_added) if newly_added => {
                    match agent_approvals::save_store(&self.data_dir, &store) {
                        Ok(()) => remembered = true,
                        Err(error) => {
                            eprintln!("[ssh] failed to persist remembered approval: {error}")
                        }
                    }
                }
                Ok(_) => remembered = true,
                Err(error) => eprintln!("[ssh] approval not remembered: {error}"),
            }
        }
        self.audit_approval(
            &pending.tool,
            &pending.connection_id,
            Some(&pending.command),
            match (approved, remembered) {
                (true, true) => audit_log::ApprovalTrail::Remembered,
                (true, false) => audit_log::ApprovalTrail::Approved,
                (false, _) => audit_log::ApprovalTrail::Denied,
            },
            if approved {
                audit_log::EntryOutcome::Ok
            } else {
                audit_log::EntryOutcome::Error
            },
            unix_now_ms().saturating_sub(pending.raised_at_ms),
        );
        pending
            .sender
            .send(decision)
            .map_err(|_| "Agent challenge is no longer waiting".to_string())
    }

    /// Appends one approval-lifecycle line to the execution audit ledger.
    /// Execution itself is audited by the MCP layer; these lines carry the
    /// human-decision trail (`approval` field) for terminal-routed commands.
    fn audit_approval(
        &self,
        tool: &str,
        connection_id: &str,
        command: Option<&str>,
        approval: audit_log::ApprovalTrail,
        outcome: audit_log::EntryOutcome,
        duration_ms: u64,
    ) {
        let entry = audit_log::AuditEntry {
            ts_ms: unix_now_ms(),
            tool: tool.to_string(),
            connection_id: connection_id.to_string(),
            gate: audit_log::GateOutcome::Pass,
            approval,
            outcome,
            exit_code: None,
            duration_ms,
            mode: audit_log::ExecMode::Terminal,
            command: command.map(str::to_string),
            output: None,
            error: None,
        };
        if let Err(error) = audit_log::append(&self.data_dir, &entry) {
            eprintln!("[ssh] audit append failed: {error}");
        }
    }

    /// Starts a per-connection `sudo -nv` refresh loop after a successful
    /// sudo execution. The loop runs every [`exec::SUDO_KEEPALIVE_INTERVAL`]
    /// (4 minutes), stops itself after
    /// [`exec::SUDO_KEEPALIVE_MAX_FAILURES`] consecutive validation failures,
    /// and is aborted deterministically on disconnect / session cleanup via
    /// [`Self::stop_sudo_keepalive`]. Per connection single-instance: a
    /// repeat registration while one is live is a no-op.
    /// Registration decision for `register_sudo_keepalive` (pure for tests):
    /// an entry bound to the same live session is reused as-is; an entry bound
    /// to another (typically dead) session is replaced — the old early-return
    /// on any existing entry would silently drop the new session's keepalive
    /// after a reconnect (#202).
    fn keepalive_registration_plan(
        existing_session: Option<&str>,
        incoming_session: &str,
    ) -> KeepaliveRegistration {
        match existing_session {
            Some(existing) if existing == incoming_session => KeepaliveRegistration::ReuseExisting,
            Some(_) => KeepaliveRegistration::ReplaceStale,
            None => KeepaliveRegistration::InsertFresh,
        }
    }

    fn register_sudo_keepalive(
        &self,
        connection_id: &str,
        session_id: &str,
        handle: Arc<Handle<SshClient>>,
    ) {
        let mut keepalive = match self.sudo_keepalive.lock() {
            Ok(keepalive) => keepalive,
            Err(_) => return,
        };
        let existing_session = keepalive
            .get(connection_id)
            .map(|entry| entry.session_id.as_str());
        if matches!(
            Self::keepalive_registration_plan(existing_session, session_id),
            KeepaliveRegistration::ReuseExisting
        ) {
            return;
        }
        // Drop the stale entry and stop its loop before arming the new one.
        if let Some(existing) = keepalive.remove(connection_id) {
            existing.task.abort();
        }
        let interval = exec::SUDO_KEEPALIVE_INTERVAL;
        let registry = self.sudo_keepalive.clone();
        let id = connection_id.to_string();
        let task_handle = handle.clone();
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut failures = 0_u32;
            loop {
                ticker.tick().await;
                let succeeded = exec::validate_sudo_timestamp(&task_handle).await.is_ok();
                match exec::keepalive_failure_step(failures, succeeded) {
                    Some(next) => {
                        if next != 0 {
                            eprintln!(
                                "[ssh] sudo keepalive for {id}: timestamp validation failed ({next}/{})",
                                exec::SUDO_KEEPALIVE_MAX_FAILURES
                            );
                        }
                        failures = next;
                    }
                    None => {
                        eprintln!(
                            "[ssh] sudo keepalive for {id}: {} consecutive validation failures, stopping (sudo timestamp expired)",
                            exec::SUDO_KEEPALIVE_MAX_FAILURES
                        );
                        if let Ok(mut keepalive) = registry.lock() {
                            keepalive.remove(&id);
                        }
                        break;
                    }
                }
            }
        });
        keepalive.insert(
            connection_id.to_string(),
            SudoKeepalive {
                session_id: session_id.to_string(),
                task,
            },
        );
    }

    async fn stop_sudo_keepalive(&self, connection_id: &str) {
        let entry = self
            .sudo_keepalive
            .lock()
            .ok()
            .and_then(|mut keepalive| keepalive.remove(connection_id));
        if let Some(entry) = entry {
            entry.task.abort();
        }
    }

    /// Creates the optional local sink (staging `.part` file) shared by
    /// `sftp/download/start` and `sudo/download/start`.
    async fn build_download_sink(
        &self,
        task_id: &str,
        download_dir: Option<&str>,
        conflict: Option<&str>,
    ) -> Result<Option<Arc<DownloadSink>>, String> {
        let staging = self.transfer_dir.join("downloads");
        std::fs::create_dir_all(&staging)
            .map_err(|error| format!("Failed to create download staging directory: {error}"))?;
        let part_path = staging.join(format!("download-{task_id}.part"));
        let final_dir = download_dir
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                local_downloads::downloads_base_dir(|key| std::env::var_os(key), &self.data_dir)
            });
        if !final_dir.is_absolute() {
            return Err("Download directory must be an absolute path".to_string());
        }
        std::fs::create_dir_all(&final_dir).map_err(|error| {
            format!(
                "Failed to create download directory '{}': {error}",
                final_dir.display()
            )
        })?;
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part_path)
            .await
            .map_err(|error| {
                format!(
                    "Failed to create local download file '{}': {error}",
                    part_path.display()
                )
            })?;
        Ok(Some(Arc::new(DownloadSink {
            part_path,
            final_dir,
            overwrite: matches!(conflict, Some("overwrite")),
            file: AsyncMutex::new(file),
        })))
    }

    /// `sudo/download/start`: root-owned files streamed through the regular
    /// SFTP download pipeline (M14-C DownloadSudo). The source is staged into
    /// a same-directory sudo temp file (`sudo_download::stage_source`) which
    /// is registered as the task's read source; `sftp/download/next`,
    /// `sftp/download/finish` and the progress events are reused unchanged.
    /// The temp file is removed on finish, cancel, error and session close
    /// (finally semantics; cleanup failures surface as a non-fatal warning).
    #[allow(clippy::too_many_arguments)]
    pub async fn start_sudo_download(
        &self,
        session_id: &str,
        path: &str,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        // 与其余 start 路径同走 transfer_depth_limit（M14-B 偏好与 compat
        // 模式强制 1 都要约束 sudo 车道；此前字面 3 绕过了两者）。
        if self.active_transfer_count(session_id)? as u64 >= self.transfer_depth_limit() {
            return Err(format!(
                "This SSH session already has {} active transfers",
                self.transfer_depth_limit()
            ));
        }
        let staged = sudo_download::stage_source(self, session_id, path).await?;
        let outcome = self
            .start_sudo_download_staged(
                session_id,
                &staged,
                save_to_local,
                download_dir,
                conflict,
                emitter,
            )
            .await;
        if outcome.is_err() {
            // 注册失败也要把远端临时件收掉，不能等下载循环来清。
            if let Err(error) = sudo_download::discard_tmp(self, session_id, &staged.tmp_path).await
            {
                eprintln!(
                    "[sudo-download] staging temp cleanup failed ({}): {error}",
                    staged.tmp_path
                );
            }
        }
        outcome
    }

    async fn start_sudo_download_staged(
        &self,
        session_id: &str,
        staged: &sudo_download::StagedSource,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if staged.size > MAX_TRANSFER_SIZE {
            return Err(format!(
                "Transfers are limited to {MAX_TRANSFER_SIZE} bytes"
            ));
        }
        // SFTP 提前探测：源目录对登录用户不可穿越（如 /root 0700）时，普通
        // SFTP 读不到临时件——在这里给出明确错误，而不是第一块分块才失败。
        let sftp = self.sftp(session_id).await?;
        sftp.lock()
            .await
            .metadata(staged.tmp_path.clone())
            .await
            .map_err(sftp_error)?;
        let task_id = Uuid::new_v4().to_string();
        let sink = if save_to_local {
            self.build_download_sink(&task_id, download_dir, conflict)
                .await?
        } else {
            None
        };
        self.downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .insert(
                task_id.clone(),
                DownloadState {
                    session_id: session_id.to_string(),
                    remote_path: staged.tmp_path.clone(),
                    file_name: staged.file_name.clone(),
                    size: staged.size,
                    next_offset: 0,
                    sink,
                    tree: None,
                    sudo_tmp: Some(staged.tmp_path.clone()),
                    // sudo 下载走独立车道（sudo_download.rs），读侧不经
                    // has_wire_lane 判分支；字面 false 只做字段填充。
                    latin1: false,
                    // sudo 车道本期不在限速范围（issue #66 收敛在 SFTP
                    // 下载），字段照常填充但快照取 0（不限速）。
                    throttle: Throttle::new(0),
                    progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                    // sudo 车道不参与压缩通道（M33）：远端临时件机制独立。
                    compression: CompressionMode::None,
                    ready: false,
                    serving_plain: false,
                    staged_plain: None,
                    gz_staging: None,
                    remote_temp: None,
                    final_dir: None,
                    overwrite: false,
                    read_handle: Arc::new(AsyncMutex::new(None)),
                    raw_client: Arc::new(AsyncMutex::new(None)),
                    expand_lzpack: false,
                    prefetch: Arc::new(AsyncMutex::new(None)),
                    multistream: None,
                },
            );
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "transferred": 0, "size": staged.size, "status": "queued" }),
            )
            .map_err(plugin_error)?;
        let connection_id = self.session_connection_id(session_id).await;
        self.record_transfer_start(
            &task_id,
            session_id,
            &connection_id,
            "download",
            &staged.file_name,
            staged.size,
        );
        Ok(
            json!({ "taskId": task_id, "fileName": staged.file_name, "size": staged.size, "chunkSize": TRANSFER_CHUNK_SIZE, "resumeOffset": 0_u64, "saveToLocal": save_to_local, "sudo": true }),
        )
    }

    /// 显式解压下载（ST10）：远端源 `.dbxz` → 本地暂存拉流 → 自研解压 →
    /// staged 分块供给原始字节。注册表里 compression=None + expand_lzpack=
    /// true：分块供给走 staged 车道（download_staged_chunk），status/事件
    /// 的 compression 字段标 "lzpack"。原始体积从容器头读出——无法读出
    /// 即任务失败（不是回退：用户明确要还原 .dbxz，源不是 .dbxz 时静默
    /// 直传原始文件会暴露服务器上的压缩件语义混乱）。
    #[allow(clippy::too_many_arguments)]
    async fn start_lzpack_download(
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

    /// 压缩下载 prep 终态分发（M33）：Ready 就绪发 ready 事件；Fallback
    /// 静默回落普通管线（清理压缩产物，registry 改回 None 后发 compression
    /// 为 none 的 ready 事件，前端照旧直读远端）；Cancelled 是取消路径
    /// （cancel RPC 已发 cancelled 事件，这里只清理远端/本地临时件）。
    #[allow(clippy::too_many_arguments)]
    async fn run_download_prep(
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
    async fn pull_remote_gzip(
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
    async fn cleanup_compressed_download(
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
    async fn download_staged_chunk(
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

    pub async fn download_chunk(
        self: &Arc<Self>,
        task_id: &str,
        offset: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let download = {
            let downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download registry is poisoned".to_string())?;
            downloads
                .get(task_id)
                .cloned()
                .ok_or("Download task was not found")?
        };
        // 读侧快照对树任务仍是一次整树深拷贝（files 队列 + failures 随
        // chunk 数 O(n²) 增长）；彻底消除需要把 tree 改成 Arc<tokio::Mutex>
        // 并让 status/cancel/finish 全链路加锁——登记为后续项，当前网络腿
        // IO 仍占大头，先不动结构。
        if download.tree.is_some() {
            return self
                .download_tree_chunk(task_id, offset, download, emitter)
                .await;
        }
        // staged 车道分派（M33 gzip 与 ST10 lzpack 解压下载共用）：压缩任
        // 务的原始字节都来自本地 staged plain 文件。
        if download.expand_lzpack
            || (download.compression == CompressionMode::Gzip && !download.serving_plain)
        {
            return self
                .download_staged_chunk(task_id, offset, download, emitter)
                .await;
        }
        if offset != download.next_offset {
            // offset 失配（续传跳片/重试乱序）：并发预读窗口整窗作废（ST12，
            // 与一期预取槽「失配即作废」同语义），防止跨跳供给陈块。降级
            // 状态保留——降级是本任务生命周期事实，不因作废重置。
            if let Some(state) = download.multistream.as_ref() {
                state.window.lock().await.clear();
            }
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let remaining = download.size.saturating_sub(offset);
        let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
        // 限速节奏（issue #66）：块耗时从读开始计量（含网络/磁盘），读毕
        // 由 limiter 补足差额等待。限速关闭时 Throttle::pace 是纯即时调用，
        // 热路径零开销。
        let chunk_started = download.throttle.enabled().then(std::time::Instant::now);
        // 预取命中（ST9）：上一片返回时后台预读的本片已在槽里，直接取出，
        // 省一个整 RTT。仅普通单文件下载启用（树/压缩/latin-1 车道不预取）；
        // 槽 offset 与本片请求不一致即作废（续传/重试跳片安全）。
        // 并发预读窗口车道（ST12）启用时走窗口分支，一期单步预取不再叠加
        // （两套在途读会双倍打服务端并发，收益不增）。
        let prefetchable = download.multistream.is_none()
            && download.compression == CompressionMode::None
            && !(download.latin1 && sftp_name::has_wire_escapes(&download.remote_path));
        let mut served_from_prefetch = false;
        let chunk = if let Some(state) = download.multistream.as_ref() {
            // 窗口命中（(offset, len) 精确匹配，末块短读/跳片天然失配）直接
            // 回——后台并发读已把本片备好；未命中（预读未完成/已降级）同步
            // 读兜底。分块供给顺序与二进制帧形状不变，并发只发生在 sidecar
            // 内部的「预读未到来分块」上。
            let hit = state.window.lock().await.take(offset, requested);
            match hit {
                Some(hit) => hit,
                None => {
                    self.read_plain_download_chunk(&download, offset, requested)
                        .await?
                }
            }
        } else if prefetchable {
            let mut slot = download.prefetch.lock().await;
            match slot.take() {
                Some((hit_offset, hit_chunk))
                    if hit_offset == offset && hit_chunk.len() == requested =>
                {
                    served_from_prefetch = true;
                    hit_chunk
                }
                Some(_) | None => {
                    // 槽空/过期：正常同步读。
                    drop(slot);
                    self.read_plain_download_chunk(&download, offset, requested)
                        .await?
                }
            }
        } else {
            self.read_plain_download_chunk(&download, offset, requested)
                .await?
        };
        // 限速等待在读毕、本地落盘之前：等待本身计入下一块之前的墙钟，
        // 且不会推迟本地写完成的应答语义（前端循环按块等待）。
        if let (true, Some(started)) = (download.throttle.enabled(), chunk_started) {
            download.throttle.pace(chunk.len(), started.elapsed()).await;
        }
        let length = chunk.len();
        if let Some(sink) = download.sink.as_ref() {
            sink.file
                .lock()
                .await
                .write_all(&chunk)
                .await
                .map_err(|error| format!("Failed to write local download file: {error}"))?;
        }
        let next_offset = offset.saturating_add(length as u64);
        let mut payload = Vec::with_capacity(8 + length);
        payload.extend_from_slice(&offset.to_be_bytes());
        payload.extend_from_slice(&chunk);
        emitter
            .binary(&format!("sftp/download/{task_id}"), &payload)
            .map_err(plugin_error)?;
        // 进度事件时间窗节流（progress_throttle）：每块一条 IPC 事件在
        // 大文件下约 200 条/秒，直驱前端重渲染；终块必发保证进度条终值。
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
                    json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running" }),
                )
                .map_err(plugin_error)?;
        }
        // 窗口回填（ST12，issue #237 二期）：供给推进后按窗口目标补发并发
        // 预读。规划在窗口锁内完成（目标置在途，防重复发）；读任务用轮转
        // 槽位的独立句柄并发读远端，结果回窗，失败整窗降级单流（错误不打
        // 断任务，由同步车道按原语义浮出）。降级/EOF 后 plan 返回空，不再
        // 发起。取消/终态无需专门清理：窗口任务只写窗口（Arc 随任务回收），
        // 不触碰 sink/远端。
        if let Some(state) = download.multistream.as_ref() {
            let plan = {
                let mut window = state.window.lock().await;
                window.plan(next_offset, download.size, TRANSFER_CHUNK_SIZE as u64)
            };
            let spawn_task_id = task_id.to_string();
            for (read_offset, read_len) in plan {
                let this = self.clone_for_download_prefetch();
                let download = download.clone();
                let state = Arc::clone(state);
                let slot = state.pick_slot();
                let task_id = spawn_task_id.clone();
                tokio::spawn(async move {
                    match this
                        .read_window_chunk(&download, &state, slot, read_offset, read_len)
                        .await
                    {
                        Ok(data) => state.window.lock().await.complete(read_offset, data),
                        Err(error) => {
                            eprintln!(
                                "[sftp] multistream {task_id} read offset {read_offset} failed: {error}"
                            );
                            let degraded = state.window.lock().await.fail(read_offset);
                            if degraded {
                                eprintln!(
                                    "[sftp] multistream {task_id} degraded to single-stream (read-ahead aborted)"
                                );
                            }
                            if is_channel_level_sftp_error(&error) {
                                this.invalidate_sftp_cache(&download.session_id).await;
                            }
                        }
                    }
                });
            }
        }
        // 预取下一片（ST9）：仅当本片非 EOF、限速关闭（限速节奏下预取会
        // 打乱配速）且本次不是预取命中时发起；命中时后台任务通常还在跑，
        // 槽仍为空则补发一次。预读失败静默丢弃（槽保持空，下一片同步读）。
        if prefetchable
            && next_offset < download.size
            && !download.throttle.enabled()
            && !served_from_prefetch
        {
            let this = self.clone_for_download_prefetch();
            let download = download.clone();
            let prefetch_offset = next_offset;
            let prefetch_len = download
                .size
                .saturating_sub(prefetch_offset)
                .min(TRANSFER_CHUNK_SIZE as u64) as usize;
            tokio::spawn(async move {
                // 预取失败不打断主流程，下一片同步读兜底。
                if let Ok(prefetched) = this
                    .read_plain_download_chunk(&download, prefetch_offset, prefetch_len)
                    .await
                {
                    *download.prefetch.lock().await = Some((prefetch_offset, prefetched));
                }
            });
        }
        Ok(
            json!({ "taskId": task_id, "offset": offset, "length": length, "eof": next_offset >= download.size, "fileName": download.file_name }),
        )
    }

    /// download_chunk 的 Arc 派生入口（预取任务用）：download_chunk 本就
    /// 定义在 `Arc<Self>` 上（start_download 同款）。
    fn clone_for_download_prefetch(self: &Arc<Self>) -> Arc<Self> {
        Arc::clone(self)
    }

    /// 普通单文件下载的分片读取（原 download_chunk 内联逻辑抽取）：latin-1
    /// 转义名走裸包 READ，其余走高层句柄复用 seek+read。错误语义与抽取前
    /// 一致：句柄错误弃槽、通道级错误连带失效 SFTP 客户端缓存。
    async fn read_plain_download_chunk(
        &self,
        download: &DownloadState,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        if download.latin1 && sftp_name::has_wire_escapes(&download.remote_path) {
            return self
                .raw_read_chunk_cached(
                    &download.session_id,
                    &download.raw_client,
                    &download.remote_path,
                    offset,
                    requested as u32,
                )
                .await;
        }
        self.read_highlevel_chunk(
            &download.session_id,
            &download.remote_path,
            &download.read_handle,
            offset,
            requested,
        )
        .await
    }

    /// 并发预读窗口的分片读取（ST12）：恒走高层车道（窗口车道 start 时已
    /// 排除裸包转义名），使用轮转槽位的独立句柄——并发读共用 `read_handle`
    /// 会被槽锁串行化，分槽才能真并发。错误语义与同步车道一致。
    async fn read_window_chunk(
        &self,
        download: &DownloadState,
        state: &MultistreamState,
        slot: usize,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        let handle = state.stream_handle(slot);
        self.read_highlevel_chunk(
            &download.session_id,
            &download.remote_path,
            &handle,
            offset,
            requested,
        )
        .await
    }

    /// 高层车道分片读取（句柄复用）：首片 open 后缓存在句柄槽（File 的
    /// Drop 发 close_nowait，槽位置 None 即完成关闭），后续片直接 seek+read
    /// ——逐片 OPEN/READ/CLOSE 每片多付 2 个 RTT，高延迟链路吞吐被 RTT 界
    /// 死。seek 用绝对 offset，断点续传/重试跳片/并发多流各自持有句柄同样
    /// 成立。错误弃柄（下一片惰性重建）；通道级错误连带失效整个 SFTP 客户
    /// 端缓存——死通道被原样复用会把该会话 SFTP 打到永久报错（误判无害：
    /// 重建只是多一次握手）。
    async fn read_highlevel_chunk(
        &self,
        session_id: &str,
        remote_path: &str,
        handle_slot: &AsyncMutex<Option<russh_sftp::client::fs::File>>,
        offset: u64,
        requested: usize,
    ) -> Result<Vec<u8>, String> {
        let read_result: Result<Vec<u8>, String> = async {
            let sftp = self.sftp(session_id).await?;
            let mut handle_slot = handle_slot.lock().await;
            if handle_slot.is_none() {
                let opened = sftp
                    .lock()
                    .await
                    .open(remote_path.to_string())
                    .await
                    .map_err(sftp_error)?;
                *handle_slot = Some(opened);
            }
            let source = handle_slot.as_mut().expect("handle just ensured");
            source
                .seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| format!("SFTP download seek failed: {error}"))?;
            let mut chunk = vec![0_u8; requested];
            let length = source
                .read(&mut chunk)
                .await
                .map_err(|error| format!("SFTP download failed: {error}"))?;
            chunk.truncate(length);
            Ok(chunk)
        }
        .await;
        match read_result {
            Ok(chunk) => Ok(chunk),
            Err(error) => {
                // 读失败即弃句柄（下一片惰性重建）；通道级错误连带失效
                // 整个 SFTP 客户端缓存——死通道被原样复用会把该会话
                // SFTP 打到永久报错（误判无害：重建只是多一次握手）。
                *handle_slot.lock().await = None;
                if is_channel_level_sftp_error(&error) {
                    self.invalidate_sftp_cache(session_id).await;
                }
                Err(error)
            }
        }
    }

    /// `sftp/transfer/cancel`. `reason` is an optional workbench slug ("user",
    /// "ack-timeout", ...) recorded in the ledger event so a cancellation can
    /// be told apart from a server failure on the next bug report.
    /// 统一清理一个下载任务的全部临时资产（2026-09-30 收口，评审 H-2）：
    /// sink .part、树半成品根目录、sudo 远端暂存、压缩任务的 plain 解压
    /// 暂存/本地压缩流/远端 .gz。best-effort——路径可缺失，完成/取消/会话
    /// 关闭多路径穿过这里，重复删除只是一次无害的 NoSuchFile。远端删除
    /// 需要会话，会话已死时记 stderr（本地资产是会话关闭场景的主清理面）。
    async fn cleanup_download_assets(&self, session_id: &str, download: &DownloadState) {
        if let Some(sink) = download.sink.as_ref() {
            let _ = std::fs::remove_file(&sink.part_path);
        }
        // 文件夹下载：整棵半成品目录删除，不在下载目录里留部分内容（根
        // 目录是本任务创建的让位新目录，删除不伤及他物）。
        if let Some(tree) = download.tree.as_ref() {
            let _ = std::fs::remove_dir_all(&tree.root_local);
        }
        if let Some(tmp) = download.sudo_tmp.as_ref() {
            if let Err(error) = sudo_download::discard_tmp(self, session_id, tmp).await {
                eprintln!("[sudo-download] temp cleanup failed ({tmp}): {error}");
            }
        }
        if download.compression == CompressionMode::Gzip || download.expand_lzpack {
            if let Some(staged) = download.staged_plain.as_ref() {
                let _ = std::fs::remove_file(staged);
            }
            if let Some(gz) = download.gz_staging.as_ref() {
                let _ = std::fs::remove_file(gz);
            }
            if let Some(tmp) = download.remote_temp.as_ref() {
                match self.sftp(session_id).await {
                    Ok(sftp) => {
                        if let Err(error) = sftp.lock().await.remove_file(tmp.clone()).await {
                            eprintln!("[sftp] cleanup: remote temp not removed: {error}");
                        }
                    }
                    Err(error) => eprintln!("[sftp] cleanup: session unavailable: {error}"),
                }
            }
        }
    }

    pub async fn cancel_transfer(
        &self,
        task_id: &str,
        reason: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<(), String> {
        let upload = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .remove(task_id);
        let download = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .remove(task_id);
        let finishing = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .get(task_id)
            .map(|upload| {
                upload.cancelled.store(true, Ordering::Release);
                if let Ok(mut slot) = upload.cancel_reason.lock() {
                    if slot.is_none() {
                        *slot = reason.map(str::to_string);
                    }
                }
                let mut task = upload_progress_payload(
                    task_id,
                    &upload.session_id,
                    Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                    upload.transferred.load(Ordering::Acquire),
                    upload.size,
                    UploadPhase::Uploading,
                    "cancelled",
                    upload.compression,
                );
                task["error"] = json!(upload_cancel_error(reason));
                (
                    task,
                    upload.session_id.clone(),
                    upload.remote_path.clone(),
                    upload.sudo_staging.clone(),
                )
            });
        // 压缩下载 prep（M33）：置取消旗标让 prep 循环在块边界退出；prep
        // 独占（任务已不在 downloads registry 的竞窗）时由这里直接清理。
        let prep = self
            .download_preps
            .lock()
            .map_err(|_| "Download prep registry is poisoned".to_string())?
            .get(task_id)
            .map(|prep| {
                prep.cancelled.store(true, Ordering::Release);
                if let Ok(mut slot) = prep.cancel_reason.lock() {
                    if slot.is_none() {
                        *slot = reason.map(str::to_string);
                    }
                }
                (
                    prep.remote_temp.clone(),
                    prep.gz_staging.clone(),
                    prep.session_id.clone(),
                )
            });
        if let Some(upload) = upload.as_ref() {
            let _ = std::fs::remove_file(&upload.local_path);
            remove_upload_meta(&self.transfer_dir, task_id);
        }
        if let Some(download) = download.as_ref() {
            self.cleanup_download_assets(&download.session_id, download)
                .await;
        }
        // prep 独占的取消（任务条目已被先前的取消摘除）：直接清压缩产物。
        if let (true, Some((remote_temp, gz_staging, session_id))) =
            (download.is_none(), prep.as_ref())
        {
            if let Some(tmp) = remote_temp {
                if let Ok(sftp) = self.sftp(session_id).await {
                    let _ = sftp.lock().await.remove_file(tmp.clone()).await;
                }
            }
            let _ = std::fs::remove_file(gz_staging);
        }
        if upload.is_none() && download.is_none() && finishing.is_none() && prep.is_none() {
            return Err("Transfer task was not found".to_string());
        }
        // 推送阶段取消的远端收尾提前：推送循环要到下一个分块边界才观察到
        // cancelled 标志并自行删除远端临时文件，取消 RPC 返回后立刻列目录会
        // 看见最长一个分块周期的 .part 残留（#60 回归记录的竞窗）。这里
        // best-effort 提前删掉推送暂存件。只删暂存件，绝不碰 .backup——取消
        // 可能与提交链的 target→backup→target 往返并发，删 backup 会破坏回滚；
        // 与推送循环自身的 remove 并发安全（重复删除只是一次无害的 NoSuchFile）。
        // sudo 车道（UploadSudo）的推送暂存件在登录用户 home 下，按注册时
        // 定死的 sudo_staging 删，不落目标目录。
        if let Some((_, session_id, remote_path, sudo_staging)) = finishing.as_ref() {
            let temporary = match sudo_staging.as_ref() {
                Some(staging) => staging.clone(),
                None => match remote_transfer_paths(remote_path, task_id) {
                    Ok((temporary, _backup)) => temporary,
                    Err(_) => String::new(),
                },
            };
            if !temporary.is_empty() {
                match self.sftp(session_id).await {
                    Ok(sftp) => {
                        if let Err(error) = sftp.lock().await.remove_file(temporary).await {
                            eprintln!("[sftp] cancel cleanup: remote temp not removed: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("[sftp] cancel cleanup: session unavailable: {error}")
                    }
                }
            }
        }
        let finishing = finishing.map(|(task, _, _, _)| task);
        let task = upload
            .as_ref()
            .map(|upload| {
                let mut task = upload_progress_payload(
                    task_id,
                    &upload.session_id,
                    Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                    upload.received,
                    upload.expected_size,
                    UploadPhase::Staging,
                    "cancelled",
                    upload.compression,
                );
                task["error"] = json!(upload_cancel_error(reason));
                task
            })
            .or_else(|| download.as_ref().map(|download| json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "cancelled" })))
            .or(finishing)
            .expect("a transfer was present");
        eprintln!(
            "[sftp] transfer {task_id} cancelled (reason={})",
            reason.unwrap_or("unspecified")
        );
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)
    }

    pub async fn complete_download(
        &self,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let download = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .remove(task_id)
            .ok_or("Download task was not found".to_string())?;
        if download.tree.is_some() {
            return self
                .complete_tree_download(download, task_id, emitter)
                .await;
        }
        let sudo_tmp = download.sudo_tmp.clone();
        let session_id = download.session_id.clone();
        // 压缩任务终态清理条件（M33 gzip 与 ST10 lzpack 解压下载同骨架）：
        // lzpack 的 gz_staging 槽放的是 packed 暂存件（.part.dbxz），remote_temp
        // 恒为 None（无远端临时件）。
        let compressed_cleanup =
            (download.compression == CompressionMode::Gzip || download.expand_lzpack).then(|| {
                (
                    download.remote_temp.clone(),
                    download.gz_staging.clone(),
                    download.staged_plain.clone(),
                    download.final_dir.is_none(),
                )
            });
        let result = self
            .complete_single_file_download(download, task_id, emitter)
            .await;
        // 压缩任务终态（M33，finally 语义）：远端 .gz 与本地压缩流暂存在
        // 完成/失败两条路径都清；plain 解压暂存只在「浏览器模式且成功」时
        // 清（字节已在前端）——saveToLocal 失败保留，与普通 .part「字节不
        // 丢」语义一致。
        if let Some((remote_temp, gz_staging, staged_plain, browser_mode)) = compressed_cleanup {
            self.cleanup_compressed_download(
                &session_id,
                remote_temp.as_deref(),
                gz_staging.as_deref(),
                staged_plain
                    .as_deref()
                    .filter(|_| browser_mode && result.is_ok()),
            )
            .await;
        }
        // finally 语义：sudo 下载的远端临时件在完成/失败两条路径上都要清理；
        // 清理失败不吞掉原结果，只在成功响应上附加 warning 兜底提示。
        if let Some(tmp) = sudo_tmp {
            match sudo_download::discard_tmp(self, &session_id, &tmp).await {
                Ok(()) => {}
                Err(error) => {
                    eprintln!("[sudo-download] temp cleanup failed ({tmp}): {error}");
                    let mut result = result;
                    if let Ok(response) = result.as_mut() {
                        response["warning"] = json!(format!(
                            "Remote sudo temp file cleanup failed: {tmp} ({error})"
                        ));
                    }
                    return result;
                }
            }
        }
        result
    }

    /// Single-file half of `sftp/download/finish`, extracted so the sudo
    /// variant can run its remote temp cleanup around it.
    async fn complete_single_file_download(
        &self,
        download: DownloadState,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let record_failed = |error: &str| {
            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
        };
        if download.next_offset < download.size {
            let error = format!(
                "Download is incomplete: received {} of {} bytes",
                download.next_offset, download.size
            );
            // The task dies here without reaching the completed path, so
            // the failure is recorded explicitly.
            record_failed(&error);
            return Err(error);
        }
        let local_path = if let Some(staged) = download.staged_plain.as_ref() {
            // 压缩任务（M33）：saveToLocal 由解压暂存 rename 落位（浏览器
            // 模式字节在前端，暂存由 complete_download 包装层清理）。
            match download.final_dir.as_ref() {
                Some(dir) => {
                    match Self::finalize_staged_plain(
                        staged,
                        dir,
                        download.overwrite,
                        &download.file_name,
                    ) {
                        Ok(path) => Some(path),
                        Err(error) => {
                            record_failed(&error);
                            return Err(error);
                        }
                    }
                }
                None => None,
            }
        } else {
            match download.sink.as_ref() {
                None => None,
                Some(sink) => {
                    match Self::finalize_download_sink(self, sink, &download.file_name).await {
                        Ok(path) => Some(path),
                        Err(error) => {
                            record_failed(&error);
                            return Err(error);
                        }
                    }
                }
            }
        };
        let mut task = json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.size, "status": "completed" });
        if let Some(path) = local_path.as_ref() {
            task["localPath"] = json!(path.to_string_lossy());
        }
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)?;
        Ok(json!({
            "success": true,
            "taskId": task_id,
            "localPath": local_path.as_ref().map(|path| path.to_string_lossy()),
        }))
    }

    /// Tree flavor of `sftp/download/finish`: every queued file must be
    /// drained (eof), otherwise the whole folder is torn down — there is no
    /// tree resume, so a half-downloaded folder never lingers on disk. A
    /// drained tree completes even when individual files failed: the summary
    /// (`failedCount` + inline samples) is the contract for the workbench
    /// notice.
    async fn complete_tree_download(
        &self,
        download: DownloadState,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let Some(tree) = download.tree.clone() else {
            return Err("Download task is not a folder download".to_string());
        };
        // 压缩树（M33）终态清理：远端 .tgz 与本地压缩流暂存在此入口即清
        // （解包已在 prep 完成，完成/未完成两态都不再需要；finally 语义与
        // sudo 临时件同向，取消路径由 cancel_transfer 负责）。清理失败不
        // 吞掉原结果，只留 stderr 诊断。
        if download.compression == CompressionMode::Gzip {
            self.cleanup_compressed_download(
                &download.session_id,
                download.remote_temp.as_deref(),
                download.gz_staging.as_deref(),
                None,
            )
            .await;
        }
        let remaining = tree.files.len() + usize::from(tree.current.is_some());
        if remaining > 0 {
            // 未传完：整树拆除（无目录续传语义），失败入账。
            let _ = std::fs::remove_dir_all(&tree.root_local);
            let error =
                format!("Folder download is incomplete: {remaining} file(s) not transferred");
            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
            return Err(error);
        }
        if let Some(sink) = tree.sink.as_ref() {
            // 正常路径不会到达（current 已全部收尾）；防御性清理残留 .part。
            let _ = std::fs::remove_file(&sink.part_path);
        }
        let (failed_count, failed_files) = sftp_tree::failure_report(&tree.failures);
        // 压缩树（M33）：staging 树 rename 落到最终名（staging 是落点目录
        // 内的隐藏目录，同卷 rename 零拷贝；跨卷失败递归拷贝兜底）。落位
        // 失败保留 staging 并按失败入账（与 sink 的「字节不丢」同向）。
        let final_root = if download.compression == CompressionMode::Gzip {
            match download.final_dir.as_ref() {
                Some(dir) => {
                    match Self::finalize_tree_staging(&tree.root_local, dir, &download.file_name) {
                        Ok(path) => path,
                        Err(error) => {
                            let error =
                                format!("Failed to move the downloaded folder into place: {error}");
                            self.record_transfer(json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "failed", "error": error }));
                            return Err(error);
                        }
                    }
                }
                None => tree.root_local.clone(),
            }
        } else {
            tree.root_local.clone()
        };
        let mut task = json!({
            "taskId": task_id, "sessionId": download.session_id, "direction": "download",
            "fileName": download.file_name, "size": download.size, "transferred": download.next_offset,
            "status": "completed",
            "fileCount": tree.file_count, "failedCount": failed_count, "skippedCount": tree.skipped,
        });
        task["localPath"] = json!(final_root.to_string_lossy());
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)?;
        Ok(json!({
            "success": true,
            "taskId": task_id,
            "localPath": final_root.to_string_lossy(),
            "fileCount": tree.file_count,
            "failedCount": failed_count,
            "skippedCount": tree.skipped,
            "failedFiles": failed_files,
        }))
    }

    /// Flushes the staging file and moves it to its final non-colliding name
    /// in the user's Downloads folder. Rename first (same volume = cheap);
    /// staging and Downloads can live on different volumes, so a failed rename
    /// falls back to copy+delete. The staging file survives failures so the
    /// bytes are never lost silently.
    async fn finalize_download_sink(
        &self,
        sink: &DownloadSink,
        file_name: &str,
    ) -> Result<PathBuf, String> {
        {
            let file = sink.file.lock().await;
            file.sync_all()
                .await
                .map_err(|error| format!("Failed to flush local download file: {error}"))?;
        }
        let final_path =
            local_downloads::final_download_path(&sink.final_dir, file_name, sink.overwrite);
        if std::fs::rename(&sink.part_path, &final_path).is_ok() {
            return Ok(final_path);
        }
        std::fs::copy(&sink.part_path, &final_path)
            .and_then(|_| std::fs::remove_file(&sink.part_path))
            .map_err(|error| {
                format!(
                    "Failed to move the download into '{}': {error}",
                    final_path.display()
                )
            })?;
        Ok(final_path)
    }

    /// 压缩单文件任务 saveToLocal 落位（M33）：解压暂存 rename（同卷）→
    /// 跨卷回退 copy+delete，语义与 [`Self::finalize_download_sink`] 对齐。
    fn finalize_staged_plain(
        staged: &Path,
        final_dir: &Path,
        overwrite: bool,
        file_name: &str,
    ) -> Result<PathBuf, String> {
        let final_path = local_downloads::final_download_path(final_dir, file_name, overwrite);
        if std::fs::rename(staged, &final_path).is_ok() {
            return Ok(final_path);
        }
        std::fs::copy(staged, &final_path)
            .and_then(|_| std::fs::remove_file(staged))
            .map_err(|error| {
                format!(
                    "Failed to move the download into '{}': {error}",
                    final_path.display()
                )
            })?;
        Ok(final_path)
    }

    /// 压缩树任务落位（M33）：staging 树 rename 成最终根名（staging 是落
    /// 点目录内的隐藏目录，同卷 rename 几乎必成）；跨卷失败递归拷贝兜底。
    fn finalize_tree_staging(
        staging: &Path,
        final_dir: &Path,
        root_name: &str,
    ) -> Result<PathBuf, String> {
        let final_path = local_downloads::final_download_path(final_dir, root_name, false);
        if std::fs::rename(staging, &final_path).is_ok() {
            return Ok(final_path);
        }
        copy_dir_recursive(staging, &final_path).map_err(|error| {
            format!(
                "Failed to move the download into '{}': {error}",
                final_path.display()
            )
        })?;
        let _ = std::fs::remove_dir_all(staging);
        Ok(final_path)
    }
}

fn flow_mode_name(mode: AuthFlowMode) -> &'static str {
    mode.name()
}

fn method_offered(result: &AuthResult, kind: MethodKind) -> bool {
    match result {
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods.contains(&kind),
        _ => false,
    }
}

/// Extracts the server's method advertisement from a rejection. An empty set
/// carries no information — russh also produces one when the transport dies
/// mid-probe — and maps to `None` so callers fail open instead of gating on a
/// phantom restriction.
fn advertised_methods(result: &AuthResult) -> Option<&MethodSet> {
    match result {
        AuthResult::Failure {
            remaining_methods, ..
        } if !remaining_methods.is_empty() => Some(remaining_methods),
        _ => None,
    }
}

/// Merges the leading none probe's advertisement with the advertisement of
/// the immediately preceding auth step and decides whether `wanted` may still
/// be attempted (Tabby authMethodSelection parity, second phase of the
/// none-probe rollout): a method only stays on the menu while both
/// advertisements list it — the stricter of the two wins, so a server that
/// narrows its advertisement mid-negotiation can never be blind-tried into
/// MaxAuthTries. A missing none advertisement (abnormal shape, see
/// [`advertised_methods`]) fails open to the per-step gate.
fn reconcile_advertised(
    advertised_none: Option<&MethodSet>,
    step_offered: &AuthResult,
    wanted: MethodKind,
) -> bool {
    let none_still_offers = advertised_none.is_none_or(|set| set.contains(&wanted));
    none_still_offers && method_offered(step_offered, wanted)
}

/// Failure text for the "neither password nor keyboard-interactive" gate.
/// When the none probe's advertisement is known it is appended so the error
/// names what the server actually allows (publickey-only hosts, for one).
fn advertisement_rejection_message(advertised_none: Option<&MethodSet>) -> String {
    let message = "SSH server did not advertise password or keyboard-interactive authentication; refusing to send the password".to_string();
    match advertised_none {
        Some(set) if !set.is_empty() => {
            let names: Vec<&str> = set.iter().map(<&'static str>::from).collect();
            format!("{message} (server advertises: {})", names.join(", "))
        }
        _ => message,
    }
}

/// True when the server accepted the preceding step but demands another
/// authentication method before letting the session in — the shape koko (and
/// PAM 2FA stacks in general) uses for "password/publickey accepted, now send
/// the MFA code". It seeds the keyboard-interactive exchange whenever no
/// password was submitted first (publickey / agent / KI-only paths); the
/// password path seeds itself, since a submitted password already documents
/// that the server moved past the first factor.
fn auth_partial_success(result: &AuthResult) -> bool {
    match result {
        AuthResult::Failure {
            partial_success, ..
        } => *partial_success,
        _ => false,
    }
}

/// Fixed Auto try order — the public contract of the fallback chain. Method
/// names use the `external_config.authentication` spellings so log lines stay
/// greppable against connection configs.
const AUTO_AUTH_ORDER: [&str; 4] = ["password", "private-key", "keyboard-interactive", "agent"];

/// Pure stage gate for the Auto chain: `None` means "attempt the stage",
/// `Some(reason)` means "record a skipped attempt". Credential presence is
/// configuration (known before dialing); whether the server advertises the
/// password method is the runtime fact captured by the auth-none probe.
/// keyboard-interactive and agent have no local prerequisites — the user can
/// still answer prompts interactively and the agent socket comes from the
/// environment — so they are never skipped.
fn auto_stage_skip(
    method: &str,
    has_password: bool,
    password_offered: bool,
    has_key: bool,
) -> Option<String> {
    match method {
        "password" if !has_password => {
            Some("no password configured for this connection".to_string())
        }
        "password" if !password_offered => {
            Some("server does not advertise password authentication".to_string())
        }
        "private-key" if !has_key => {
            Some("no private key configured for this connection".to_string())
        }
        _ => None,
    }
}

/// One recorded Auto-fallback attempt: the method plus why it was skipped or
/// why it failed. The name must stay aligned with `AUTO_AUTH_ORDER`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AutoAuthAttempt {
    method: &'static str,
    skipped: bool,
    detail: String,
}

fn auto_auth_attempt(method: &'static str, detail: String) -> AutoAuthAttempt {
    AutoAuthAttempt {
        method,
        skipped: false,
        detail,
    }
}

fn auto_auth_skip(method: &'static str, detail: String) -> AutoAuthAttempt {
    AutoAuthAttempt {
        method,
        skipped: true,
        detail,
    }
}

/// Merges one recorded Auto-stage outcome into the attempt list. The same
/// method can legitimately be recorded more than once: the private-key /
/// agent partial-success KI continuations plus the dedicated KI stage each
/// record `keyboard-interactive`. Repeats merge their detail instead of
/// pushing a duplicate entry, keeping the "one entry per method, in
/// first-try order" invariant that the aggregated failure message and the
/// order assertion below rely on.
fn merge_auto_auth_attempt(attempts: &mut Vec<AutoAuthAttempt>, attempt: AutoAuthAttempt) {
    if let Some(existing) = attempts
        .iter_mut()
        .find(|recorded| recorded.method == attempt.method)
    {
        if !attempt.skipped {
            existing.skipped = false;
        }
        existing.detail.push_str("; ");
        existing.detail.push_str(&attempt.detail);
    } else {
        attempts.push(attempt);
    }
}

/// Aggregated failure message for the Auto chain: every attempted (or
/// skipped) method with its reason, in the fixed try order, so a total
/// failure explains itself instead of surfacing only the last error.
fn auto_auth_failure_message(attempts: &[AutoAuthAttempt]) -> String {
    if attempts.is_empty() {
        return "SSH authentication failed in Auto mode: no method could be attempted".to_string();
    }
    let summary = attempts
        .iter()
        .map(|attempt| {
            if attempt.skipped {
                format!("{} (skipped: {})", attempt.method, attempt.detail)
            } else {
                format!("{} ({})", attempt.method, attempt.detail)
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("SSH authentication failed in Auto mode, tried in order — {summary}")
}

/// Auto authentication, Tabby-style ordered fallback: password → private key
/// → interactive keyboard-interactive (incl. TOTP) → ssh-agent, in that fixed
/// order (`AUTO_AUTH_ORDER`), until one succeeds or every attempt failed.
///
/// Deliberately a thin orchestrator: every credential flow reuses the exact
/// helper of the explicit method it mirrors (`try_password`,
/// `authenticate_private_key_result`, `authenticate_keyboard_interactive`,
/// `authenticate_agent`), including the Quick Sudo OTP orchestration and the
/// host-key challenge path, which stay untouched under Auto. A private-key or
/// agent partial success continues into the same MFA keyboard-interactive
/// continuation as the explicit paths; that continuation counts as the KI
/// stage so a later failure does not ask the user the same questions twice.
///
/// Each non-successful stage is reported as a sidecar log event
/// (`ssh/auth/auto`, best-effort — skipped in MCP headless mode without an
/// emitter) and recorded for the aggregated failure message.
async fn authenticate_auto(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
    offered: &AuthResult,
    prompts: &PromptBroker,
    emitter: Option<&PluginEmitter>,
    operation_id: &str,
) -> Result<(), String> {
    let has_password = !connection.password.is_empty();
    let password_offered = method_offered(offered, MethodKind::Password);
    let has_key = !connection.private_key.is_empty() || !connection.private_key_path.is_empty();
    let mut attempts: Vec<AutoAuthAttempt> = Vec::new();
    // 私钥/agent 的 partial-success 续答就是 KI 阶段本身：再跑一轮全新 KI
    // 会把同样的提问（验证码）重复问一遍。
    let mut ki_attempted = false;
    let report = |attempt: &AutoAuthAttempt| {
        if let Some(emitter) = emitter {
            let _ = emitter.event(
                "ssh/auth/auto",
                json!({
                    "operationId": operation_id,
                    "connectionId": connection.id,
                    "method": attempt.method,
                    "status": if attempt.skipped { "skipped" } else { "failed" },
                    "detail": attempt.detail,
                }),
            );
        }
    };
    let mut record = |attempt: AutoAuthAttempt| {
        eprintln!(
            "[ssh-trace] auth auto: {} {} ({})",
            attempt.method,
            if attempt.skipped { "skipped" } else { "failed" },
            attempt.detail
        );
        report(&attempt);
        merge_auto_auth_attempt(&mut attempts, attempt);
    };

    // Stage 1: password.
    if let Some(reason) = auto_stage_skip("password", has_password, password_offered, has_key) {
        record(auto_auth_skip("password", reason));
    } else {
        match try_password(session, connection).await {
            Ok(result) if result.success() => return Ok(()),
            Ok(result) => record(auto_auth_attempt(
                "password",
                format!(
                    "rejected by the server (partial_success={})",
                    auth_partial_success(&result)
                ),
            )),
            Err(error) => record(auto_auth_attempt("password", error)),
        }
    }

    // Stage 2: private key.
    if let Some(reason) = auto_stage_skip("private-key", has_password, password_offered, has_key) {
        record(auto_auth_skip("private-key", reason));
    } else {
        match authenticate_private_key_result(session, connection).await {
            Ok(result) if result.success() => return Ok(()),
            Ok(result)
                if auth_partial_success(&result)
                    && method_offered(&result, MethodKind::KeyboardInteractive) =>
            {
                eprintln!(
                    "[ssh-trace] auth auto: publickey partial success, continuing with keyboard-interactive"
                );
                ki_attempted = true;
                match authenticate_keyboard_interactive(
                    session,
                    connection,
                    orchestration,
                    true,
                    prompts,
                )
                .await
                {
                    Ok(()) => return Ok(()),
                    Err(error) => record(auto_auth_attempt("keyboard-interactive", error)),
                }
            }
            Ok(_) => record(auto_auth_attempt(
                "private-key",
                "rejected by the server".to_string(),
            )),
            Err(error) => record(auto_auth_attempt("private-key", error)),
        }
    }

    // Stage 3: interactive keyboard-interactive (incl. TOTP).
    if ki_attempted {
        record(auto_auth_skip(
            "keyboard-interactive",
            "already answered as the MFA follow-up of an earlier stage".to_string(),
        ));
    } else {
        match authenticate_keyboard_interactive(session, connection, orchestration, false, prompts)
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) => record(auto_auth_attempt("keyboard-interactive", error)),
        }
    }

    // Stage 4: ssh-agent.
    match authenticate_agent(session, connection).await {
        Ok(AgentAuthOutcome::Accepted) => return Ok(()),
        Ok(AgentAuthOutcome::NeedsKeyboardInteractive) => {
            eprintln!(
                "[ssh-trace] auth auto: agent partial success, continuing with keyboard-interactive"
            );
            match authenticate_keyboard_interactive(
                session,
                connection,
                orchestration,
                true,
                prompts,
            )
            .await
            {
                Ok(()) => return Ok(()),
                Err(error) => record(auto_auth_attempt("keyboard-interactive", error)),
            }
        }
        Ok(AgentAuthOutcome::Rejected(reason)) => record(auto_auth_attempt("agent", reason)),
        Err(error) => record(auto_auth_attempt("agent", error)),
    }

    // Order invariant: attempts (skips included) must appear in the fixed try
    // order of `AUTO_AUTH_ORDER` — filtering the contract list by the methods
    // actually attempted must reproduce the record exactly.
    debug_assert_eq!(
        attempts
            .iter()
            .map(|attempt| attempt.method)
            .collect::<Vec<_>>(),
        AUTO_AUTH_ORDER
            .iter()
            .filter(|method| attempts.iter().any(|attempt| attempt.method == **method))
            .copied()
            .collect::<Vec<_>>(),
        "Auto authentication attempts must follow the fixed try order"
    );
    Err(auto_auth_failure_message(&attempts))
}

/// Tries password authentication first, then keyboard-interactive. The
/// `offered` result of the preceding auth attempt tells which methods the
/// server still accepts. The initial method choice is reconciled against the
/// leading none probe (`advertised_none` — see [`reconcile_advertised`]), but
/// a successful first factor may cause the server to advertise a new MFA
/// method that was absent from the initial list.
/// Keyboard-interactive rounds are auto-answered from
/// the Quick Sudo orchestration config, covering PAM 2FA/TOTP logins.
async fn authenticate_password_or_interactive(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
    advertised_none: Option<&MethodSet>,
    offered: &AuthResult,
    prompts: &PromptBroker,
) -> Result<(), String> {
    if reconcile_advertised(advertised_none, offered, MethodKind::Password) {
        eprintln!("[ssh-trace] auth: password method offered, trying password");
        let result = try_password(session, connection).await?;
        eprintln!(
            "[ssh-trace] auth: password result success={}",
            result.success()
        );
        if result.success() {
            return Ok(());
        }
        // A password accepted as the first factor can unlock keyboard-interactive
        // MFA. Trust the password step's current advertisement here: intersecting
        // it with the earlier none probe would reject newly advertised MFA.
        if method_offered(&result, MethodKind::KeyboardInteractive) {
            eprintln!(
                "[ssh-trace] auth: falling back to keyboard-interactive (partial_success={})",
                auth_partial_success(&result)
            );
            // 密码已经提交过一次：接下来的 keyboard-interactive 就是第二因子
            // （koko/JumpServer 用 partial success 通知 MFA，PAM 栈甚至不置该位），
            // 因此 OTP 提问必须能应答，而不是被判成"密码还没到"。
            return authenticate_keyboard_interactive(
                session,
                connection,
                orchestration,
                true,
                prompts,
            )
            .await;
        }
        return Err("SSH password authentication was rejected".to_string());
    }
    if reconcile_advertised(advertised_none, offered, MethodKind::KeyboardInteractive) {
        eprintln!("[ssh-trace] auth: keyboard-interactive only, starting");
        // Servers with PasswordAuthentication disabled still accept the
        // password through keyboard-interactive (PAM), including hosts that
        // ask a 2FA/TOTP follow-up question.
        return authenticate_keyboard_interactive(
            session,
            connection,
            orchestration,
            auth_partial_success(offered),
            prompts,
        )
        .await;
    }
    eprintln!("[ssh-trace] auth: neither password nor keyboard-interactive offered");
    Err(advertisement_rejection_message(advertised_none))
}

async fn try_password(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<AuthResult, String> {
    tokio::time::timeout(
        Duration::from_secs(connection.connect_timeout_secs),
        session.authenticate_password(&connection.username, &connection.password),
    )
    .await
    .map_err(|_| "SSH password authentication timed out".to_string())?
    .map_err(|error| format!("SSH password authentication failed: {error}"))
}

/// Rounds allowed for one keyboard-interactive exchange before the handshake
/// is given up (servers that keep re-asking see a deterministic failure).
const KEYBOARD_INTERACTIVE_MAX_ROUNDS: usize = 4;

/// Renders the server's challenge wording for an error message. Only the
/// prompt/instruction text is used (never an answer), stripped of control
/// characters and capped, so a hostile server cannot smuggle escape sequences
/// into the workbench error dialog.
fn challenge_display_text(text: &str, seen: &[String]) -> Option<String> {
    let sanitized = exec::sanitize_prompt_hint(text);
    if sanitized.is_empty() || seen.iter().any(|existing| existing == &sanitized) {
        return None;
    }
    Some(sanitized)
}

/// Explains an unanswered keyboard-interactive challenge: what the server
/// asked, and where the user has to put a credential for it to be answered.
/// `asked` holds the deduplicated prompt wording, `answered` says whether any
/// non-empty answer was sent in this exchange.
fn keyboard_interactive_guidance(asked: &[String], answered: bool) -> String {
    if asked.is_empty() {
        return String::new();
    }
    let quoted: Vec<String> = asked.iter().map(|text| format!("{text:?}")).collect();
    let mut message = format!("; the server asked for {}", quoted.join(", "));
    if answered {
        message.push_str(" and rejected the submitted answer");
    } else {
        message.push_str(
            " — nothing was answered. Configure the connection's TOTP secret or OTP prompt hint (Quick Sudo 2FA settings) so MFA prompts can be answered automatically",
        );
    }
    message
}

/// Builds the text shown in the one-time input dialog from server-controlled
/// keyboard-interactive fields. Every component is normalized and capped by
/// the same sanitizer used for diagnostics; duplicate lines are omitted.
fn keyboard_interactive_manual_challenge(context: &str, prompt: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for text in [context, prompt] {
        let text = exec::sanitize_prompt_hint(text);
        if text.is_empty() || parts.iter().any(|existing| existing == &text) {
            continue;
        }
        parts.push(text);
    }
    parts.join("\n")
}

/// Drives a keyboard-interactive handshake, answering each round from the
/// orchestration config (password plus optional TOTP follow-ups).
/// `first_factor_accepted` says whether the preceding auth step already
/// succeeded partially (koko: password/publickey accepted, MFA still owed) —
/// `password_then_otp` needs it to answer the MFA question.
async fn authenticate_keyboard_interactive(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
    first_factor_accepted: bool,
    prompt_broker: &PromptBroker,
) -> Result<(), String> {
    let timeout = Duration::from_secs(connection.connect_timeout_secs);
    let mut state = if first_factor_accepted {
        exec::KeyboardInteractiveState::first_factor_accepted()
    } else {
        exec::KeyboardInteractiveState::default()
    };
    let mut response = tokio::time::timeout(
        timeout,
        session.authenticate_keyboard_interactive_start(&connection.username, None),
    )
    .await
    .map_err(|_| "SSH keyboard-interactive authentication timed out".to_string())?
    .map_err(|error| format!("SSH keyboard-interactive authentication failed: {error}"))?;
    let mut asked: Vec<String> = Vec::new();
    let mut answered = false;
    for _ in 0..KEYBOARD_INTERACTIVE_MAX_ROUNDS {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(format!(
                    "SSH keyboard-interactive authentication was rejected{}",
                    keyboard_interactive_guidance(&asked, answered)
                ));
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // koko 把可读文案放在 instructions（"Please Enter MFA Code."），
                // 提问本身是 "[OTP Code]: "：两者都参与分类与错误说明。
                let context = exec::keyboard_interactive_challenge_context(&name, &instructions);
                for text in std::iter::once(&name)
                    .chain(std::iter::once(&instructions))
                    .chain(prompts.iter().map(|prompt| &prompt.prompt))
                {
                    if asked.len() >= 4 {
                        break;
                    }
                    if let Some(display) = challenge_display_text(text, &asked) {
                        asked.push(display);
                    }
                }
                let mut answers = exec::keyboard_interactive_answers(
                    orchestration,
                    &mut state,
                    &context,
                    &prompts,
                );
                // Values available from the connection (login password or a
                // configured TOTP seed) stay automatic. Any answer that is
                // still empty is a genuine keyboard-interactive question:
                // ask the user at connection time so rotating hardware/app
                // tokens never need to be stored as a fake static secret.
                for (answer, prompt) in answers.iter_mut().zip(prompts.iter()) {
                    if !answer.is_empty() {
                        continue;
                    }
                    let challenge = keyboard_interactive_manual_challenge(&context, &prompt.prompt);
                    if let Some(value) = prompt_broker
                        .request_keyboard_interactive_answer(
                            &connection.host,
                            connection.port,
                            &connection.username,
                            challenge,
                        )
                        .await?
                    {
                        *answer = value;
                    }
                }
                if answers.iter().any(|answer| !answer.is_empty()) {
                    answered = true;
                }
                response = tokio::time::timeout(
                    timeout,
                    session.authenticate_keyboard_interactive_respond(answers),
                )
                .await
                .map_err(|_| "SSH keyboard-interactive authentication timed out".to_string())?
                .map_err(|error| {
                    format!("SSH keyboard-interactive authentication failed: {error}")
                })?;
            }
        }
    }
    Err(format!(
        "SSH keyboard-interactive authentication did not finish after {KEYBOARD_INTERACTIVE_MAX_ROUNDS} rounds{}",
        keyboard_interactive_guidance(&asked, answered)
    ))
}

async fn authenticate_private_key_result(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<AuthResult, String> {
    let key_text = resolve_private_key_text(connection).await?;
    // D9: passphrase_command 接入点——先用既有口令（或无口令）尝试解码；
    // 仅当密钥确实需要口令且命令已配置时，本地执行命令取回并重试一次。
    // 未加密密钥永远不会触发命令执行。
    let stored_passphrase = (!connection.private_key_passphrase.is_empty())
        .then_some(connection.private_key_passphrase.as_str());
    let decoded = match decode_secret_key(&key_text, stored_passphrase) {
        Ok(private_key) => Ok(private_key),
        Err(stored_error) => {
            if stored_passphrase.is_none() && !connection.passphrase_command.is_empty() {
                match resolve_passphrase_command(connection).await {
                    Some(passphrase) => decode_secret_key(&key_text, Some(&passphrase)),
                    // 命令失败：保留原始解码错误，认证链照常报错。
                    None => Err(stored_error),
                }
            } else {
                Err(stored_error)
            }
        }
    };
    let private_key = decoded.map_err(|error| {
        private_key_decode_failure(&key_text, &error, stored_passphrase.is_some())
    })?;
    let hash = session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    tokio::time::timeout(
        Duration::from_secs(connection.connect_timeout_secs),
        session.authenticate_publickey(
            &connection.username,
            PrivateKeyWithHashAlg::new(Arc::new(private_key), hash),
        ),
    )
    .await
    .map_err(|_| "SSH private-key authentication timed out".to_string())?
    .map_err(|error| format!("SSH private-key authentication failed: {error}"))
}

/// Private key source resolution for authentication: pasted key content
/// (`connection_secrets.private_key`) wins over the key path, mirroring the
/// form's either-or contract. Common Windows text artifacts (CRLF, UTF-8 BOM,
/// and leading whitespace) are normalized so keys pasted from Windows editors
/// or stored with Windows line endings still decode.
async fn resolve_private_key_text(connection: &StoredConnection) -> Result<String, String> {
    if !connection.private_key.is_empty() {
        return Ok(normalize_private_key_text(&connection.private_key));
    }
    let key_path = expand_private_key_path(&connection.private_key_path);
    let text = tokio::fs::read_to_string(&key_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to read SSH private key '{}': {error}",
                key_path.display()
            )
        })?;
    Ok(normalize_private_key_text(&text))
}

/// Normalizes text artifacts around a PEM/PPK key. `russh` matches PEM begin
/// markers exactly at the start of a line, so a UTF-8 BOM or indentation on
/// the first line otherwise becomes the opaque `Could not read key` error.
/// Beyond the original CRLF/BOM/indent handling this also strips paste-time
/// pollution that can never occur in a real key file: zero-width characters,
/// `<br>` tags from web-page copies, trailing whitespace on marker lines,
/// smart dashes, and whitespace inside base64 body lines (terminal copy that
/// re-wrapped the text). Marker lines are rebuilt into their canonical
/// `-----BEGIN … -----` form. No key semantics change: directive lines such
/// as `DEK-Info:` are preserved as-is.
fn normalize_private_key_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.strip_prefix('\u{feff}').unwrap_or(&normalized);
    let cleaned = strip_invisible_paste_artifacts(normalized);
    let mut rebuilt: Vec<String> = Vec::new();
    let mut in_pem_body = false;
    for line in cleaned.split('\n') {
        let trimmed = line.trim();
        // Drop leading blank/indent-only lines, like the previous whole-text
        // trim_start did.
        if rebuilt.is_empty() && trimmed.is_empty() {
            continue;
        }
        if looks_like_marker_line(trimmed) {
            rebuilt.push(normalize_pem_marker_line(trimmed));
            in_pem_body = trimmed.contains("BEGIN");
            continue;
        }
        if in_pem_body {
            let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
            if !compact.is_empty() && compact.chars().all(is_pem_base64_char) {
                rebuilt.push(compact);
                continue;
            }
        }
        rebuilt.push(trimmed.to_string());
    }
    // Trailing per-line whitespace is already gone; keep the original tail
    // (including its final newline) so the resolved text stays byte-identical
    // apart from the pollution fixes.
    rebuilt.join("\n")
}

/// Removes characters and tags that only arrive via rich-text or web-page
/// copying: zero-width space/joiners, stray mid-text BOMs, and `<br>` tags
/// in any letter case. A valid key file never contains any of them, so the
/// removal cannot alter real key content.
fn strip_invisible_paste_artifacts(text: &str) -> String {
    let filtered: String = text
        .chars()
        .filter(|c| !matches!(c, '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{feff}'))
        .collect();
    // ASCII folding only: Unicode lowercasing can change byte lengths (e.g.
    // `İ`), which would shift the mask offsets and corrupt the removals —
    // the tags themselves are pure ASCII.
    let lower = filtered.to_ascii_lowercase();
    let mut remove = vec![false; filtered.len()];
    for tag in ["<br />", "<br/>", "<br>"] {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(tag) {
            let start = from + offset;
            for byte in remove.iter_mut().skip(start).take(tag.len()) {
                *byte = true;
            }
            from = start + tag.len();
        }
    }
    let mut out = String::with_capacity(filtered.len());
    for (index, c) in filtered.char_indices() {
        if !remove[index] {
            out.push(c);
        }
    }
    out
}

/// ASCII base64 alphabet plus the padding sign, as PEM bodies use it.
fn is_pem_base64_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '/' || c == '+' || c == '='
}

/// Marker-line detection that also accepts smart dashes, which rich-text
/// editors substitute for the ASCII hyphens of `-----BEGIN … -----`.
fn looks_like_marker_line(line: &str) -> bool {
    let starts_with_dash = line
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '-' | '\u{2013}' | '\u{2014}' | '\u{2212}'));
    starts_with_dash && (line.contains("BEGIN") || line.contains("END"))
}

/// Rebuilds a PEM begin/end marker into the canonical five-dash form, fixing
/// smart dashes (— – −), doubled inner spaces, and trailing whitespace, all
/// of which make `russh`'s exact marker match fail with `Could not read key`.
fn normalize_pem_marker_line(line: &str) -> String {
    let ascii_dashes: String = line
        .chars()
        .map(|c| match c {
            '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            other => other,
        })
        .collect();
    let mut collapsed = String::with_capacity(ascii_dashes.len());
    let mut previous_was_space = false;
    for c in ascii_dashes.chars() {
        if c.is_whitespace() {
            if !previous_was_space {
                collapsed.push(' ');
                previous_was_space = true;
            }
        } else {
            collapsed.push(c);
            previous_was_space = false;
        }
    }
    let core = collapsed.trim().trim_matches('-').trim();
    if core.starts_with("BEGIN") || core.starts_with("END") {
        format!("-----{core}-----")
    } else {
        collapsed
    }
}

/// Detects the one-line authorized-keys form and PEM public/certificate
/// envelopes so a pasted public key is reported as such instead of as an
/// opaque decode failure.
fn looks_like_public_key(text: &str) -> bool {
    let trimmed = text.trim_start();
    for header in [
        "-----BEGIN PUBLIC KEY-----",
        "-----BEGIN OPENSSH PUBLIC KEY-----",
        "-----BEGIN SSH2 PUBLIC KEY-----",
        "-----BEGIN CERTIFICATE-----",
    ] {
        if trimmed.contains(header) {
            return true;
        }
    }
    let first = trimmed.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let (Some(kind), Some(blob)) = (parts.next(), parts.next()) else {
        return false;
    };
    let looks_like_algorithm = kind.starts_with("ssh-")
        || kind.starts_with("ecdsa-")
        || kind.starts_with("sk-ssh-")
        || kind.starts_with("sk-ecdsa-");
    looks_like_algorithm && blob.len() >= 40 && blob.chars().all(is_pem_base64_char)
}

fn has_html_escaped_entities(text: &str) -> bool {
    text.contains("&lt;")
        || text.contains("&gt;")
        || text.contains("&quot;")
        || text.contains("&amp;")
}

/// Turns a raw `decode_secret_key` failure into an actionable message while
/// always preserving the underlying decoder error verbatim (never swallow
/// detail). Classification is a pure function of the key text and the error,
/// so tests cover every branch without an SSH server. This only rewords the
/// failure — authentication flow, passphrase handling, and decoding itself
/// are untouched.
pub(crate) fn private_key_decode_failure(
    key_text: &str,
    error: &russh::keys::Error,
    passphrase_provided: bool,
) -> String {
    fn detailed(guidance: &str, error: &russh::keys::Error) -> String {
        format!("Failed to decode SSH private key: {guidance} (decoder error: {error})")
    }
    let raw = error.to_string();
    if key_text.contains("PuTTY-User-Key-File-") {
        if matches!(error, russh::keys::Error::KeyIsEncrypted) || raw.contains("encrypted") {
            return detailed(
                "this PuTTY PPK key is encrypted; fill in the private key passphrase field \
                 for this connection, then reconnect",
                error,
            );
        }
        if raw.contains("MAC") {
            return detailed(
                "the PuTTY PPK did not verify — the passphrase appears to be incorrect, or \
                 the file is damaged; check the private key passphrase field or re-export \
                 the key from PuTTYgen",
                error,
            );
        }
        return detailed(
            "this PuTTY PPK file could not be parsed; export it from PuTTYgen again \
             (Conversions → Export OpenSSH key) and paste the OpenSSH-format key",
            error,
        );
    }
    if looks_like_public_key(key_text) {
        return detailed(
            "the pasted text looks like a PUBLIC key or certificate, not a private key; \
             paste the matching private key file contents, including the \
             -----BEGIN … PRIVATE KEY----- and -----END … PRIVATE KEY----- lines",
            error,
        );
    }
    if matches!(error, russh::keys::Error::KeyIsEncrypted) {
        return detailed(
            "this private key is encrypted; fill in the private key passphrase field for \
             this connection, then reconnect",
            error,
        );
    }
    if raw.contains("PKCS#5 algorithm") && raw.contains("unsupported") {
        return detailed(
            "the encrypted PKCS#8 key uses a PBKDF2 variant this decoder does not \
             support; re-export the key in OpenSSH format (ssh-keygen -p -f <keyfile>) \
             or without a passphrase",
            error,
        );
    }
    if key_text.contains("-----BEGIN EC PRIVATE KEY-----") && raw.starts_with("Der:") {
        return detailed(
            "legacy 'EC PRIVATE KEY' (SEC1) PEM is not supported by this decoder; convert \
             the key once (ssh-keygen -p -f <keyfile>, or openssl pkcs8 -topk8 -nocrypt \
             -in <keyfile>) and paste the converted key",
            error,
        );
    }
    if passphrase_provided
        && (raw.contains("cryptographic error") || raw.contains("Unpad") || raw.contains("MAC"))
    {
        return detailed(
            "the key did not decrypt with the stored passphrase — check or update the \
             private key passphrase field, or the key file is damaged",
            error,
        );
    }
    if raw.contains("Base64 decoding error") {
        return detailed(
            "the key body is not valid base64 — the text was probably truncated or \
             mangled while copying; re-copy the complete key from the original file",
            error,
        );
    }
    if matches!(error, russh::keys::Error::CouldNotReadKey) {
        if has_html_escaped_entities(key_text) {
            return detailed(
                "the text looks HTML-escaped (&lt;, &quot;, …); copy the key from the \
                 original file as plain text, not from a web page or chat window",
                error,
            );
        }
        if key_text.contains("-----BEGIN") {
            return detailed(
                "a PEM header was found but not in a recognizable form — the key was \
                 probably mangled by rich-text copy (altered dashes or extra characters); \
                 re-copy the key from the original file as plain text",
                error,
            );
        }
        return detailed(
            "no PEM private-key header (-----BEGIN … PRIVATE KEY-----) was found; paste \
             the complete key file contents, including the BEGIN and END lines",
            error,
        );
    }
    detailed("the key could not be decoded", error)
}

fn expand_private_key_path(path: &str) -> PathBuf {
    let Some(remainder) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) else {
        return PathBuf::from(path);
    };
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(remainder)
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
