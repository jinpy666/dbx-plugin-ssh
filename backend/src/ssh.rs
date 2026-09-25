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
use russh::{ChannelMsg, Disconnect, MethodKind};
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
use crate::sftp_name::{self, NameEncoding};
use crate::sftp_raw;
use crate::sftp_tree;
use crate::ssh_algorithms;
use crate::startup_commands;
use crate::sudo_download;
use crate::sudo_profiles;
use crate::transfer_history;
use crate::triggers;

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

/// How the next SSH hop is reached: a fresh TCP connection, or a
/// direct-tcpip channel tunneled through an established jump-host handle.
enum DialTarget {
    Tcp((String, u16)),
    JumpStream(russh::ChannelStream<russh::client::Msg>),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptDecision {
    pub accept: bool,
    pub remember: bool,
}

/// Whether the attached DBX host advertised the Host API 1.1 user-input
/// dialog. The host sends the dot form; the slash form appears in docs, so
/// accept both when gating.
fn host_supports_user_input() -> bool {
    host_client()
        .map(|client| {
            client.supports(HOST_REQUEST_USER_INPUT_FEATURE)
                || client.supports(HOST_REQUEST_USER_INPUT_METHOD)
        })
        .unwrap_or(false)
}

/// Seam between the broker and Host API 1.1; tests script it instead of a
/// live host process.
pub(crate) trait HostPromptGateway: Send + Sync {
    fn supports_request_user_input(&self) -> bool;
    fn request_user_input(&self, prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError>;
}

struct SdkHostPromptGateway;

impl HostPromptGateway for SdkHostPromptGateway {
    fn supports_request_user_input(&self) -> bool {
        host_supports_user_input()
    }

    fn request_user_input(&self, prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError> {
        match host_client() {
            Some(client) => client.request_user_input(prompt),
            None => Err(PluginError::new(
                -32000,
                "Host API is unavailable: the plugin server is not running",
            )),
        }
    }
}

#[derive(Clone)]
pub struct PromptBroker {
    pending: Arc<AsyncMutex<HashMap<String, PendingPrompt>>>,
    gateway: Arc<dyn HostPromptGateway>,
    /// Set whenever a confirmation was raised, whichever channel served it;
    /// `connection/test` reads it to make its timeout guidance truthful.
    pub(super) challenge_raised: Arc<AtomicBool>,
    /// Sticky mark that the Host API 1.1 dialog took (or is still taking)
    /// this challenge: `connection/test` extends its mirrored dial budget
    /// once while a dialog may still be open. Degradable failures clear it
    /// again before the workbench fallback, so hosts without a working
    /// dialog keep the short 1.0-style budget.
    pub(super) host_dialog_used: Arc<AtomicBool>,
}

impl Default for PromptBroker {
    fn default() -> Self {
        Self {
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            gateway: Arc::new(SdkHostPromptGateway),
            challenge_raised: Arc::new(AtomicBool::new(false)),
            host_dialog_used: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct PendingPrompt {
    operation_id: String,
    sender: oneshot::Sender<PromptDecision>,
}

impl PromptBroker {
    /// Test-only seam injection; production brokers use `Default`.
    #[cfg(test)]
    pub(crate) fn with_gateway(gateway: Arc<dyn HostPromptGateway>) -> Self {
        Self {
            gateway,
            ..Self::default()
        }
    }

    /// One clear entry for both sticky challenge marks so every new probe
    /// starts from a clean slate.
    pub(crate) fn clear_challenge_raised(&self) {
        self.challenge_raised.store(false, Ordering::Relaxed);
        self.host_dialog_used.store(false, Ordering::Relaxed);
    }

    pub(crate) fn challenge_was_raised(&self) -> bool {
        self.challenge_raised.load(Ordering::Relaxed)
    }

    pub(crate) fn host_dialog_was_used(&self) -> bool {
        self.host_dialog_used.load(Ordering::Relaxed)
    }

    #[allow(clippy::too_many_arguments)]
    async fn request(
        &self,
        host: &str,
        port: u16,
        key_type: String,
        fingerprint: String,
        connection_id: &str,
        operation_id: &str,
        emitter: &PluginEmitter,
    ) -> Option<PromptDecision> {
        if self.gateway.supports_request_user_input() {
            match self
                .request_via_host(host, port, &key_type, &fingerprint)
                .await
            {
                Ok(decision) => return decision,
                // Host predates the dialog (-32601), rejects the parameters
                // (-32602, e.g. an over-limit field) or no dialog surface is
                // mounted (-32001 without the SDK's own timeout wording): the
                // workbench event may still reach a UI.
                Err(error) if Self::host_prompt_unavailable(&error) => {}
                // Anything else — including the SDK's own -32001 "did not
                // answer" timeout — must fail closed instead of stacking
                // another 300s wait on top.
                Err(_) => return None,
            }
        }
        self.request_via_workbench(
            host,
            port,
            key_type,
            fingerprint,
            connection_id,
            operation_id,
            emitter,
        )
        .await
    }

    /// The gateway call blocks until the user answers, so it runs on the
    /// blocking pool: the dispatch worker stays free and the enclosing
    /// `connection/test` budget can observe the wait and re-arm while the
    /// dialog is open (the host pauses its own RPC deadline meanwhile).
    async fn request_via_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<Option<PromptDecision>, PluginError> {
        self.challenge_raised.store(true, Ordering::Relaxed);
        // The host caps the title at 200 and the prompt at 2000 chars; a
        // near-limit FQDN shrinks here instead of coming back as -32602
        // (which would only fall back to the workbench event anyway).
        let title: String = format!("SSH host key — {host}:{port}")
            .chars()
            .take(200)
            .collect();
        let prompt_text: String = format!(
            "The authenticity of host {host}:{port} can't be established.\n\
             Key type: {key_type}\n\
             SHA-256 fingerprint: {fingerprint}\n\
             Trust this host and continue connecting?"
        )
        .chars()
        .take(2000)
        .collect();
        let prompt = UserInputPrompt::choice(
            prompt_text,
            vec![
                UserInputOption {
                    value: "accept".to_string(),
                    label: "Trust once".to_string(),
                },
                UserInputOption {
                    value: "remember".to_string(),
                    label: "Trust and remember".to_string(),
                },
            ],
        )
        .with_title(title)
        .with_timeout_secs(HOST_KEY_CHALLENGE_WAIT.as_secs());
        // Mark before parking on the answer: `connection/test` re-arms its
        // budget on this flag while the dialog is still open. A degradable
        // failure clears it again below, so the workbench fallback keeps the
        // short 1.0-style budget.
        self.host_dialog_used.store(true, Ordering::Relaxed);
        let gateway = Arc::clone(&self.gateway);
        let answer =
            match tokio::task::spawn_blocking(move || gateway.request_user_input(&prompt)).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(error)) => {
                    if Self::host_prompt_unavailable(&error) {
                        self.host_dialog_used.store(false, Ordering::Relaxed);
                    }
                    return Err(error);
                }
                // The blocking task died without an answer; fail closed like any
                // other non-degradable gateway failure.
                Err(error) => {
                    return Err(PluginError::new(
                        -32000,
                        format!("host dialog task failed: {error}"),
                    ));
                }
            };
        Ok(Some(
            match (answer.action.as_str(), answer.value.as_deref()) {
                // Only an explicit accept/remember value grants trust; a missing
                // or unknown value (and any non-submit action) is a rejection:
                // never guess.
                ("submit", Some("accept")) => PromptDecision {
                    accept: true,
                    remember: false,
                },
                ("submit", Some("remember")) => PromptDecision {
                    accept: true,
                    remember: true,
                },
                _ => PromptDecision {
                    accept: false,
                    remember: false,
                },
            },
        ))
    }

    /// Errors that mean "no usable dialog surface" rather than "no answer":
    /// the workbench event may still reach a human. -32601 unknown method
    /// (host predates Host API 1.1), -32602 invalid params, and -32001 when
    /// it is not the SDK's own "did not answer" timeout.
    fn host_prompt_unavailable(error: &PluginError) -> bool {
        error.code == -32601
            || error.code == -32602
            || (error.code == -32001 && !error.message.contains("did not answer"))
    }

    /// Asks the user for one keyboard-interactive answer without persisting
    /// it. Automatic password/TOTP orchestration gets the first chance; this
    /// path is only used for an answer that stayed empty (hardware token,
    /// SMS code, custom MFA wording, and similar one-time challenges).
    async fn request_keyboard_interactive_answer(
        &self,
        host: &str,
        port: u16,
        username: &str,
        challenge: String,
    ) -> Result<Option<String>, String> {
        if !self.gateway.supports_request_user_input() {
            return Ok(None);
        }

        let title: String = format!("动态令牌验证 — {username}@{host}:{port}")
            .chars()
            .take(200)
            .collect();
        let challenge = if challenge.trim().is_empty() {
            "SSH 服务器要求补充身份验证信息。".to_string()
        } else {
            challenge
        };
        let prompt_text: String = format!(
            "请输入服务器要求的当前动态令牌。本次输入仅用于此次登录，不会保存。\n\n服务器提示：\n{challenge}"
        )
        .chars()
        .take(2000)
        .collect();
        let prompt = UserInputPrompt::secret(prompt_text)
            .with_title(title)
            .with_timeout_secs(HOST_KEY_CHALLENGE_WAIT.as_secs());

        // `connection/test` mirrors the host's short RPC deadline. Mark the
        // dialog before waiting so the outer probe can extend its budget just
        // as it already does for host-key confirmation.
        let dialog_was_already_used = self.host_dialog_used.swap(true, Ordering::Relaxed);
        let gateway = Arc::clone(&self.gateway);
        let answer =
            match tokio::task::spawn_blocking(move || gateway.request_user_input(&prompt)).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(error)) if Self::host_prompt_unavailable(&error) => {
                    if !dialog_was_already_used {
                        self.host_dialog_used.store(false, Ordering::Relaxed);
                    }
                    return Ok(None);
                }
                Ok(Err(error)) => {
                    return Err(format!(
                        "SSH keyboard-interactive prompt failed: {}",
                        error.message
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "SSH keyboard-interactive prompt task failed: {error}"
                    ));
                }
            };

        match answer.action.as_str() {
            "submit" => match answer.value.filter(|value| !value.is_empty()) {
                Some(value) => Ok(Some(value)),
                None => Err("SSH keyboard-interactive answer was empty".to_string()),
            },
            "cancel" => Err("SSH keyboard-interactive authentication was cancelled".to_string()),
            "timeout" => {
                Err("SSH keyboard-interactive authentication prompt timed out".to_string())
            }
            _ => Err("SSH keyboard-interactive authentication received no answer".to_string()),
        }
    }

    // 参数就是 host-key 挑战事件的载荷字段，一一对应而非可归组的耦合。
    #[allow(clippy::too_many_arguments)]
    async fn request_via_workbench(
        &self,
        host: &str,
        port: u16,
        key_type: String,
        fingerprint: String,
        connection_id: &str,
        operation_id: &str,
        emitter: &PluginEmitter,
    ) -> Option<PromptDecision> {
        self.challenge_raised.store(true, Ordering::Relaxed);
        let challenge_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            challenge_id.clone(),
            PendingPrompt {
                operation_id: operation_id.to_string(),
                sender,
            },
        );
        if emitter
            .event(
                "connection/challenge",
                json!({
                    "challengeId": challenge_id,
                    "operationId": operation_id,
                    "connectionId": connection_id,
                    "kind": "host-key",
                    "host": host,
                    "port": port,
                    "keyType": key_type,
                    "fingerprint": fingerprint
                }),
            )
            .is_err()
        {
            self.pending.lock().await.remove(&challenge_id);
            return None;
        }
        let result = tokio::time::timeout(Duration::from_secs(300), receiver)
            .await
            .ok()?
            .ok();
        self.pending.lock().await.remove(&challenge_id);
        result
    }

    pub async fn resolve(
        &self,
        challenge_id: &str,
        operation_id: &str,
        decision: PromptDecision,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .await
            .remove(challenge_id)
            .ok_or("Host-key challenge was not found or already resolved")?;
        if pending.operation_id != operation_id {
            return Err("Host-key challenge operation does not match".to_string());
        }
        pending
            .sender
            .send(decision)
            .map_err(|_| "Host-key challenge is no longer waiting".to_string())
    }
}

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
                tokio::spawn(forward::relay_remote(target.entry, channel, tcp));
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
    Resize { cols: u32, rows: u32 },
    DirectoryTracking { enabled: bool },
    Close,
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

/// Monotonic terminal output journal shared by the SSH and local-terminal
/// session loops: assigns each chunk a sequence, keeps a bounded tail for
/// `replay`, and survives transport gaps. The byte budget defaults to the
/// shared 2 MiB terminal limit; serial sessions build a smaller buffer via
/// [`ReplayBuffer::with_byte_limit`] (128 KiB, design doc §3).
pub(crate) struct ReplayBuffer {
    frames: VecDeque<TerminalFrame>,
    bytes: usize,
    sequence: u64,
    byte_limit: usize,
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::with_byte_limit(TERMINAL_REPLAY_LIMIT)
    }
}

impl ReplayBuffer {
    pub(crate) fn with_byte_limit(byte_limit: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            byte_limit,
        }
    }

    pub(crate) fn push(&mut self, stream: TerminalStream, data: Vec<u8>) -> TerminalFrame {
        self.sequence += 1;
        let frame = TerminalFrame {
            sequence: self.sequence,
            stream,
            data,
        };
        self.bytes += frame.data.len();
        self.frames.push_back(frame.clone());
        while self.bytes > self.byte_limit {
            let Some(removed) = self.frames.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.data.len());
        }
        frame
    }

    pub(crate) fn after(&self, sequence: u64) -> Vec<TerminalFrame> {
        self.frames
            .iter()
            .filter(|frame| frame.sequence > sequence)
            .cloned()
            .collect()
    }

    pub(crate) fn first_sequence(&self) -> u64 {
        self.frames
            .front()
            .map(|frame| frame.sequence)
            .unwrap_or(self.sequence.saturating_add(1))
    }

    /// Highest assigned sequence (0 until the first push).
    pub(crate) fn tail_sequence(&self) -> u64 {
        self.sequence
    }
}

/// Remote (-R) port mapping table for one connection, keyed by
/// `(listen_host, bound_port)` and consulted by the SSH client handler when
/// the server hands over a `forwarded-tcpip` channel.
pub type RemoteForwardTable = Mutex<HashMap<(String, u32), forward::RelayTarget>>;

/// Explicit users of one authenticated SSH transport: every registered
/// session owns one use, and a copied session reserves one before its first
/// await. That pending reservation closes the open/close race where the last
/// old session could otherwise tear down a jump chain while the new PTY was
/// still being created.
struct TransportLeaseCounter(AtomicUsize);

impl TransportLeaseCounter {
    fn new() -> Self {
        Self(AtomicUsize::new(1))
    }

    fn retain(&self) {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .expect("SSH transport lease count overflow");
    }

    /// Returns true when the released use was the final one.
    fn release(&self) -> bool {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_sub(1)
            })
            .expect("SSH transport lease released more than once")
            == 1
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
}

struct SharedTransportLease {
    uses: TransportLeaseCounter,
    jump_chain: Vec<Arc<Handle<SshClient>>>,
}

impl SharedTransportLease {
    fn new(jump_chain: Vec<Arc<Handle<SshClient>>>) -> Self {
        Self {
            uses: TransportLeaseCounter::new(),
            jump_chain,
        }
    }

    fn retain(&self) {
        self.uses.retain();
    }

    async fn release(&self) {
        if !self.uses.release() {
            return;
        }
        for jump in &self.jump_chain {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH session closed",
                    "English",
                )
                .await;
        }
    }
}

/// `workbench_id` is kept with the session so attach can only restore the
/// session that belongs to the same workbench. A different workbench must open
/// its own SSH session instead of stealing another tab's PTY.
struct SessionEntry {
    connection_id: String,
    workbench_id: RwLock<String>,
    read_only: bool,
    keepalive_interval_secs: u64,
    connected: AtomicBool,
    /// Unix seconds when the session was opened (for `ssh/sessions/list`).
    created_at_secs: u64,
    /// Monotonic per-runtime creation counter. created_at_secs has second
    /// granularity, so two workbenches opened in the same second would tie;
    /// the sequence gives `session_id_for_connection` a true creation order.
    created_seq: u64,
    handle: Arc<Handle<SshClient>>,
    /// Reference-counted lifetime for the authenticated transport's jump
    /// chain. Pending copied-session opens reserve a use before awaiting.
    transport_lease: Arc<SharedTransportLease>,
    /// Live Quick Sudo / 2FA orchestration, updatable at runtime through
    /// `ssh/settings/set` and shared by the terminal and exec paths.
    orchestration: Arc<RwLock<SudoAuth>>,
    /// In-terminal Quick Sudo watcher. Shared so `sync_auto_sudo` can attach
    /// or detach it at runtime (a password configured after the session was
    /// opened, or the Quick Sudo toggle, must apply without reconnecting);
    /// the read loop re-locks it on every output chunk.
    auto_sudo: Arc<Mutex<Option<exec::TerminalAutoSudo>>>,
    /// Expect-style trigger engine (tssh parity). Attached when the
    /// connection carries a `triggers` configuration; the read loop feeds it
    /// BEFORE the auto-sudo watcher (contract D1: a chunk answered by one of
    /// the two must never be answered by both).
    triggers: Arc<Mutex<Option<triggers::TriggerEngine>>>,
    terminal_tx: mpsc::Sender<TerminalCommand>,
    replay: Arc<AsyncMutex<ReplayBuffer>>,
    sftp: AsyncMutex<Option<Arc<AsyncMutex<SftpSession>>>>,
    /// Output recorder installed while an agent command runs in this
    /// session's PTY (`exec_in_terminal`); `None` outside such a run. Fed
    /// by the read loop at the same point as the auto-sudo observer.
    agent_recorder: Arc<Mutex<Option<TerminalRecorder>>>,
    /// Session recording (`ssh/recording/start`): captures the terminal
    /// output stream into an asciicast v2 file while active. Fed by the
    /// read loop at the same point as the agent recorder; auto-stopped
    /// when the session's read loop ends.
    session_recorder: Arc<Mutex<Option<session_recording::SessionRecorder>>>,
    /// Serializes agent-terminal executions on this session: two concurrent
    /// MCP commands must not interleave keystrokes on the same PTY or
    /// overwrite each other's recorder. Deliberately per-session (runs on
    /// different connections stay parallel) and deliberately held across the
    /// approval wait too — the wait is part of the serialization so an
    /// un-approved command cannot be raced by a second one. `Arc`-wrapped so
    /// a run can hold an owned guard across awaits.
    agent_exec_lock: Arc<AsyncMutex<()>>,
}

struct UploadState {
    session_id: String,
    remote_path: String,
    expected_size: u64,
    received: u64,
    local_path: PathBuf,
    file: std::fs::File,
}

/// Local (client-machine) persistence target for a download started with
/// `saveToLocal`: chunks are appended to a staging `.part` file while they
/// stream through, and `complete_download` renames it into the user's
/// Downloads folder once every byte arrived.
struct DownloadSink {
    part_path: PathBuf,
    final_dir: PathBuf,
    /// 冲突策略："overwrite" 直接覆盖同名文件，否则撞名让位（" (n)"）。
    overwrite: bool,
    file: AsyncMutex<tokio::fs::File>,
}

#[derive(Clone)]
struct DownloadState {
    session_id: String,
    /// Single-file download: the file itself. Folder download: the root
    /// directory (`tree` is `Some` in that case).
    remote_path: String,
    file_name: String,
    /// Single-file download: file size. Folder download: aggregate byte total
    /// across the tree (the progress denominator).
    size: u64,
    /// Single-file download: next chunk offset. Folder download: aggregate
    /// transferred bytes across finished files.
    next_offset: u64,
    sink: Option<Arc<DownloadSink>>,
    /// Present only for recursive folder downloads (`sftp/download/tree/start`);
    /// the chunk/finish/cancel paths branch on it while sharing the registry,
    /// progress events and cancel plumbing with plain file downloads.
    tree: Option<TreeDownloadState>,
    /// Present only for sudo-backed downloads (`sudo/download/start`): the
    /// remote staging temp file that must be removed on finish, cancel,
    /// error and session close (`sudo_download::discard_tmp`).
    sudo_tmp: Option<String>,
}

/// Live state of one recursive folder download. Files stream through the same
/// chunked pipeline one at a time: `current` is in flight into `sink`'s
/// staging `.part` file, which is renamed into place as soon as the file is
/// complete, so a mid-tree failure leaves no partial file behind.
#[derive(Clone)]
struct TreeDownloadState {
    /// Fresh, collision-free local root directory created by `start`; the
    /// whole tree is removed from disk when the task is cancelled.
    root_local: PathBuf,
    files: VecDeque<sftp_tree::TreeFile>,
    current: Option<sftp_tree::TreeFile>,
    current_offset: u64,
    sink: Option<Arc<DownloadSink>>,
    file_count: u64,
    files_done: u64,
    skipped: u64,
    failures: Vec<Value>,
}

struct FinishingUpload {
    session_id: String,
    remote_path: String,
    size: u64,
    transferred: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
    /// Cancel reason slug supplied by the workbench ("user", "ack-timeout",
    /// ...); read by the background push task so the surfaced error tells a
    /// user abort apart from an error-triggered cleanup.
    cancel_reason: Arc<Mutex<Option<String>>>,
}

/// Upload progress phase: `staging` = bytes buffered into the local spool
/// file, `uploading` = bytes actually pushed to the SFTP server. The two
/// counters restart independently, and the workbench needs the marker to keep
/// its progress bar and speed estimate honest (issue #60).
#[derive(Clone, Copy, PartialEq, Eq)]
enum UploadPhase {
    Staging,
    Uploading,
}

impl UploadPhase {
    fn as_str(self) -> &'static str {
        match self {
            UploadPhase::Staging => "staging",
            UploadPhase::Uploading => "uploading",
        }
    }
}

/// Shared shape of every upload progress event; `fileName` is only present on
/// task-start events (the workbench keeps the name it already displayed).
fn upload_progress_payload(
    task_id: &str,
    session_id: &str,
    file_name: Option<&str>,
    transferred: u64,
    size: u64,
    phase: UploadPhase,
    status: &str,
) -> Value {
    let mut payload = json!({
        "taskId": task_id,
        "sessionId": session_id,
        "direction": "upload",
        "transferred": transferred,
        "size": size,
        "phase": phase.as_str(),
        "status": status,
    });
    if let Some(file_name) = file_name {
        payload["fileName"] = json!(file_name);
    }
    payload
}

/// Error text for a cancelled upload. The optional reason slug comes from the
/// workbench so "Upload cancelled by user" reads differently from an
/// error-triggered cleanup ("Upload cancelled (ack-timeout)").
fn upload_cancel_error(reason: Option<&str>) -> String {
    match reason.map(str::trim).filter(|value| !value.is_empty()) {
        Some("user") => "Upload cancelled by user".to_string(),
        Some(reason) => format!("Upload cancelled ({reason})"),
        None => "Upload cancelled".to_string(),
    }
}

/// Background `sudo -nv` refresh loop keeping a connection's sudo timestamp
/// alive, ported from tiny-rdm's sudoExecService keepalive.
struct SudoKeepalive {
    #[allow(dead_code)]
    handle: Arc<Handle<SshClient>>,
    task: tokio::task::JoinHandle<()>,
}

/// Last collected metrics snapshot for one session, timestamped with the
/// collection moment. Mirrors tiny-rdm's `GetLastSnapshot`: the workbench can
/// render instantly from the previous sample before a fresh poll lands.
struct CachedMetrics {
    value: Value,
    collected_at: u64,
}

/// Unix seconds for the metrics cache timestamps.
fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Unix milliseconds for audit-ledger timestamps and approval durations.
fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Builds the response served from the snapshot cache: the stored fields plus
/// a `cachedAt` marker (Unix seconds) so callers can show the age of the data.
/// The stored snapshot itself is never mutated.
fn cached_metrics_payload(snapshot: &Value, collected_at: u64) -> Value {
    let mut payload = snapshot.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("cachedAt".to_string(), json!(collected_at));
    }
    payload
}

/// Read-only connection display info resolved from the connections registry
/// for a session row. Empty host/user means the connection is no longer
/// registered (sidecar restarted after the workbench attached).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
}

impl ConnectionEndpoint {
    pub fn fallback() -> Self {
        Self {
            host: String::new(),
            port: 22,
            username: String::new(),
        }
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
    sessions: Arc<AsyncRwLock<HashMap<String, Arc<SessionEntry>>>>,
    uploads: Mutex<HashMap<String, UploadState>>,
    finishing_uploads: Mutex<HashMap<String, FinishingUpload>>,
    downloads: Mutex<HashMap<String, DownloadState>>,
    transfer_history: Mutex<VecDeque<Value>>,
    sudo_keepalive: Arc<Mutex<HashMap<String, SudoKeepalive>>>,
    /// Last metrics snapshot per session, in-memory only (see `CachedMetrics`).
    metrics_cache: Mutex<HashMap<String, CachedMetrics>>,
    /// In-flight remote command executions, cancellable by exec id.
    exec_tasks: Mutex<HashMap<String, tokio::task::AbortHandle>>,
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
    forwards: forward::ForwardRegistry,
    /// Per-connection `(listen_host, bound_port) -> dial target` tables the
    /// forwarded-tcpip handler consults (see `SshClient::remote_forwards`).
    remote_tables: Mutex<HashMap<String, Arc<RemoteForwardTable>>>,
    /// Trust-on-first-use for unknown host keys (MCP stdio mode).
    auto_trust: bool,
    /// 会话维度的「建议开启兼容模式」一次性提示标记（M14-B）：SFTP 探测
    /// 失败时提示一次，之后同一会话静默。
    compat_hinted: Mutex<HashSet<String>>,
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
        Self {
            connections: RwLock::new(HashMap::new()),
            sessions: Arc::new(AsyncRwLock::new(HashMap::new())),
            uploads: Mutex::new(HashMap::new()),
            finishing_uploads: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            transfer_history: Mutex::new(VecDeque::new()),
            session_seq: AtomicU64::new(0),
            sudo_keepalive: Arc::new(Mutex::new(HashMap::new())),
            metrics_cache: Mutex::new(HashMap::new()),
            exec_tasks: Mutex::new(HashMap::new()),
            forwards: forward::ForwardRegistry::default(),
            remote_tables: Mutex::new(HashMap::new()),
            agent_modes: Mutex::new(agent_terminal::load_modes(&data_dir)),
            agent_challenges: Mutex::new(HashMap::new()),
            auto_trust: false,
            compat_hinted: Mutex::new(HashSet::new()),
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
        Ok(())
    }

    pub async fn disconnect_connection(&self, connection_id: &str) -> Result<(), String> {
        self.connections
            .write()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .remove(connection_id);
        let session_ids = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.close_session(&session_id).await;
        }
        self.stop_sudo_keepalive(connection_id).await;
        Ok(())
    }

    pub async fn open_session(
        &self,
        request: &SessionOpenRequest,
        operation_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
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
            let remote_shell = detect_remote_shell(&handle).await;
            let directory_tracking_supported = remote_shell.supports_directory_tracking();
            let mut channel = handle.channel_open_session().await.map_err(|error| {
                if reused_transport {
                    format!("The authenticated SSH connection can no longer be reused; use New session to reconnect: {error}")
                } else {
                    format!("Failed to open SSH terminal channel: {error}")
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
            if connection.remote_command.is_empty() {
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
        let (remote_shell, directory_tracking_supported, mut channel) = match terminal {
            Ok(terminal) => terminal,
            Err(error) => {
                transport_lease.release().await;
                return Err(error);
            }
        };

        let session_id = Uuid::new_v4().to_string();
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
            keepalive_interval_secs: connection.keepalive_interval_secs,
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
        self.sessions
            .write()
            .await
            .insert(session_id.clone(), entry.clone());

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

        // Startup commands (Tabby "Login scripts" parity, M7 P0-4): after the
        // shell is up, type the connection's pre-configured command sequence
        // through the same input channel the keepalive uses. Only for real
        // shell sessions — a RemoteCommand exec replaces the shell, so typing
        // into it is a semantic conflict (documented in PROTOCOL.zh-CN.md).
        // The event reports only the count and completion: command contents
        // can carry secrets and never reach logs or events.
        if startup_commands::executes_for(&connection.remote_command) {
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
        // Auto-record 提示事件在 spawn 之后仍要用 emitter（主闭包已 move 走
        // 原值），提前留一个克隆；录制器槽同理（entry 已 move 进读循环任务）。
        let auto_record_emitter = emitter.clone();
        let auto_record_slot = Arc::clone(&entry.session_recorder);
        let auto_record_connection_id = entry.connection_id.clone();
        tokio::spawn(async move {
            let mut directory_filter = DirectoryHandshakeFilter::default();
            let mut directory_tracking_enabled = false;
            let mut directory_timeout = tokio::time::interval(Duration::from_millis(250));
            directory_timeout.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = directory_timeout.tick() => {
                        if let Some(data) = directory_filter.flush_if_timed_out() {
                            publish_terminal(&task_id, TerminalStream::Stdout, data, &replay, &emitter).await;
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
                            if channel.data(&data[..]).await.is_err() { break; }
                        }
                        Some(TerminalCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols.max(1), rows.max(1), 0, 0).await;
                        }
                        Some(TerminalCommand::DirectoryTracking { enabled }) => {
                            if remote_shell == RemoteShell::Other || directory_tracking_enabled == enabled {
                                continue;
                            }
                            directory_tracking_enabled = enabled;
                            directory_filter.begin(directory_tracking_marker(&directory_marker_id));
                            publish_terminal(
                                &task_id,
                                TerminalStream::Stdout,
                                b"\r\x1b[2K".to_vec(),
                                &replay,
                                &emitter,
                            ).await;
                            let script = directory_tracking_script(enabled, &directory_marker_id, remote_shell);
                            if channel.data(script.as_bytes()).await.is_err() { break; }
                        }
                        Some(TerminalCommand::Close) | None => {
                            let _ = channel.close().await;
                            break;
                        }
                    },
                    message = channel.wait() => {
                        let (data, stream) = match message {
                            Some(ChannelMsg::Data { data }) => (data.to_vec(), TerminalStream::Stdout),
                            Some(ChannelMsg::ExtendedData { data, .. }) => (data.to_vec(), TerminalStream::Stderr),
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
                            _ => continue,
                        };
                        if stream == TerminalStream::Stdout {
                            let chunk_text = String::from_utf8_lossy(&data).into_owned();
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
                        let Some(data) = directory_filter.filter(&data) else { continue; };
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
                b"ssh-transport-disconnected".to_vec(),
                &replay,
                &emitter,
            )
            .await;
            let _ = emitter.event(
                "ssh/session/state",
                json!({
                    "sessionId": task_id,
                    "connectionId": entry.connection_id,
                    "state": "disconnected"
                }),
            );
            let removed = sessions.write().await.remove(&task_id);
            if let Some(removed) = removed {
                removed.transport_lease.release().await;
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
        let connect = client::connect(
            config,
            (connection.runtime_host.as_str(), connection.runtime_port),
            probe,
        );
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
    async fn connect_authenticated(
        &self,
        connection: &StoredConnection,
        operation_id: &str,
        emitter: Option<PluginEmitter>,
    ) -> Result<(Handle<SshClient>, Vec<Handle<SshClient>>), String> {
        let mut jump_handles = Vec::new();
        let mut dial = DialTarget::Tcp((connection.runtime_host.clone(), connection.runtime_port));

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

        match connection.authentication {
            AuthenticationMethod::Password => {
                authenticate_password_or_interactive(
                    &mut session,
                    connection,
                    &orchestration,
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
                    AgentAuthOutcome::Rejected => {
                        return Err("No SSH Agent identity was accepted".to_string());
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
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("sessionId is required")?;
        let session = self.session(session_id).await?;
        let (kind, listen_host, listen_port, target_host, target_port) =
            forward::parse_spec(params)?;
        // Conflict pre-check ahead of bind/tcpip-forward, so a duplicate gets
        // a naming error instead of a raw "address already in use" (local) or
        // a server-side refusal (remote). Local endpoints collide on the one
        // client machine — every connection; remote endpoints collide per
        // server — same connection only.
        if listen_port != 0 {
            let conflicting = self.forwards.rows().into_iter().find(|row| {
                row.kind == kind
                    && (kind == forward::ForwardKind::Local
                        || row.connection_id == session.connection_id)
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
        let entry = Arc::new(forward::ForwardEntry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            connection_id: session.connection_id.clone(),
            kind,
            listen_host,
            listen_port,
            target_host,
            target_port,
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
        match kind {
            forward::ForwardKind::Local => {
                if let Err(error) =
                    forward::spawn_local_listener(entry.clone(), session.handle.clone()).await
                {
                    self.forwards.remove(&entry.id);
                    return Err(error);
                }
            }
            forward::ForwardKind::Remote => {
                let bound = session
                    .handle
                    .tcpip_forward(&entry.listen_host, u32::from(entry.listen_port))
                    .await;
                let bound = match bound {
                    Ok(port) => port,
                    Err(error) => {
                        self.forwards.remove(&entry.id);
                        return Err(format!(
                            "Server refused to listen on {}:{}: {error}",
                            entry.listen_host, entry.listen_port
                        ));
                    }
                };
                let bound = u16::try_from(bound).unwrap_or(entry.listen_port.max(1));
                entry.bound_port.store(u32::from(bound), Ordering::Relaxed);
                let table = self.remote_table_for(&session.connection_id);
                forward::register_remote_target(
                    &table,
                    &entry.listen_host,
                    bound,
                    &entry.target_host,
                    entry.target_port,
                    entry.clone(),
                );
            }
        }
        forward::set_state(&entry, forward::ForwardState::Active, None);
        Ok(json!({ "forward": entry.payload() }))
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
            let session = self.sessions.read().await.get(&entry.session_id).cloned();
            if let Some(session) = session {
                let port = entry.bound_port.load(Ordering::Relaxed);
                let port = if port == 0 {
                    u32::from(entry.listen_port)
                } else {
                    port
                };
                let _ = session
                    .handle
                    .cancel_tcpip_forward(&entry.listen_host, port)
                    .await;
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
        let _ = session.terminal_tx.send(TerminalCommand::Close).await;
        session.transport_lease.release().await;
        self.cleanup_session_transfers(session_id)?;
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
            .map_err(|_| "SSH terminal is closed".to_string())
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
            .map_err(|_| "SSH terminal session is closed".to_string())
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
            payload.truncate(MAX_BATCH_INPUT_BYTES);
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

    /// Connection-level sudoers-style allowlist for privileged commands
    /// (`sudo_whitelist` in the connection's external config). Empty config
    /// = gate off; otherwise the command (minus a leading `sudo` token) must
    /// match one entry. Mirrors the MCP gate on the workbench exec path;
    /// structured `sudo_fs` operations are user-driven and stay exempt.
    pub async fn ensure_sudo_allowed(&self, session_id: &str, command: &str) -> Result<(), String> {
        let session = self.session(session_id).await?;
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .cloned()
            .ok_or("Connection is not active; reopen it from DBX".to_string())?;
        if connection.sudo_whitelist.is_empty() {
            return Ok(());
        }
        let entries = crate::sudo_allowlist::entries_from_lines(&connection.sudo_whitelist);
        if crate::sudo_allowlist::is_allowed(&entries, command) {
            return Ok(());
        }
        Err(format!(
            "sudo command is not allowed by this connection's whitelist. \
             Allowed patterns: {}",
            crate::sudo_allowlist::render_entries(&entries)
        ))
    }

    pub(crate) async fn sftp(
        &self,
        session_id: &str,
    ) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        self.sftp_with_compat(session_id)
            .await
            .map_err(|error| self.compat_hint(session_id, error))
    }

    /// SFTP 会话建立。老旧服务器兼容模式（M14-B，偏好 `sftp_compat_mode`）
    /// 生效时：请求/响应不做流水线并发（读写各 1 路），并避免依赖服务器端
    /// 扩展协商的路径。偏好改动对尚未建立的 SFTP 会话即时生效；已缓存的
    /// 会话复用旧配置（重连后按新值建立）。
    async fn sftp_with_compat(
        &self,
        session_id: &str,
    ) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        let session = self.session(session_id).await?;
        let mut current = session.sftp.lock().await;
        if let Some(sftp) = current.as_ref() {
            return Ok(sftp.clone());
        }
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        let compat = crate::preferences::sftp_compat_mode(&self.data_dir);
        let sftp = Arc::new(AsyncMutex::new(if compat {
            SftpSession::new_with_config(
                channel.into_stream(),
                SftpConfig {
                    max_concurrent_reads: 1,
                    max_concurrent_writes: 1,
                    ..SftpConfig::default()
                },
            )
            .await
            .map_err(sftp_error)?
        } else {
            SftpSession::new(channel.into_stream())
                .await
                .map_err(sftp_error)?
        }));
        *current = Some(sftp.clone());
        Ok(sftp.clone())
    }

    /// 探测/建立失败的一次性兼容建议（M14-B）：每个会话只提示一次，避免
    /// 重复打扰；连接老旧 OpenSSH/嵌入式 sftp-server 的用户可按提示到
    /// 设置 → 传输里打开兼容模式。
    fn compat_hint(&self, session_id: &str, error: String) -> String {
        let fresh = self
            .compat_hinted
            .lock()
            .map(|mut hinted| hinted.insert(session_id.to_string()))
            .unwrap_or(false);
        if fresh {
            format!(
                "{error} (hint: if this server is legacy, enable legacy server compatibility in Settings → Transfer)"
            )
        } else {
            error
        }
    }

    pub async fn sftp_home(&self, session_id: &str) -> Result<String, String> {
        let sftp = self.sftp(session_id).await?;
        let home = sftp
            .lock()
            .await
            .canonicalize(".")
            .await
            .map_err(sftp_error)?;
        Ok(home)
    }

    /// sessionId → connectionId（M16 连接级 SFTP 文件名编码判定用）：只查
    /// 会话注册表，未知/已摘除的会话返回 None，由调用方按「未覆盖（跟随
    /// 全局）」兜底——编码判定绝不因会话状态未知而失败。
    pub async fn connection_id_for_session(&self, session_id: &str) -> Option<String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|entry| entry.connection_id.clone())
    }

    pub async fn session_id_for_connection(&self, connection_id: &str) -> Result<String, String> {
        // The caller holds only the connection id, so with several workbenches
        // on one connection this must pick deterministically: the oldest live
        // session (the connection's primary workbench). HashMap iteration
        // order is randomized per process — picking "whatever comes first"
        // sent terminal-routed execs and the workbench's ^C to different
        // PTYs on every other launch.
        let sessions = self.sessions.read().await;
        let candidates = sessions
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(id, session)| {
                (
                    id.clone(),
                    session.created_seq,
                    session.connected.load(Ordering::Acquire),
                )
            });
        select_primary_session(candidates)
            .ok_or_else(|| "No active SSH session exists for this connection".to_string())
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
        let keepalive_interval = session.keepalive_interval_secs;
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
        let run = async move {
            let outcome = if sudo {
                exec::exec_with_sudo(
                    &handle,
                    &orchestration,
                    &command,
                    timeout,
                    use_pty,
                    &connection.set_env,
                )
                .await?
            } else {
                exec::exec_plain(&handle, &command, timeout, &connection.set_env).await?
            };
            Ok(outcome)
        };

        let outcome = match exec_id.filter(|id| !id.is_empty()) {
            Some(exec_id) => {
                let exec_id = exec_id.to_string();
                let task = tokio::spawn(run);
                if let Ok(mut tasks) = self.exec_tasks.lock() {
                    tasks.insert(exec_id.clone(), task.abort_handle());
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
            self.register_sudo_keepalive(&connection_id, keepalive_handle, keepalive_interval);
        }
        Ok(self.exec_response(&outcome))
    }

    /// Aborts an in-flight `ssh/exec`; ported from tiny-rdm's AbortCommand.
    pub fn cancel_exec(&self, exec_id: &str) -> Result<(), String> {
        let task = self
            .exec_tasks
            .lock()
            .map_err(|_| "Exec registry is poisoned".to_string())?
            .remove(exec_id);
        match task {
            Some(task) => {
                task.abort();
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
                return Err(format!("SSH terminal is closed: {error}"));
            }
            Err(_) => {
                if let Ok(mut slot) = session.agent_recorder.lock() {
                    *slot = None;
                }
                return Err(
                    "SSH terminal is not accepting input (session unresponsive)".to_string()
                );
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
                return Err(
                    "SSH terminal session was closed while the command was running".to_string(),
                );
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
    fn register_sudo_keepalive(
        &self,
        connection_id: &str,
        handle: Arc<Handle<SshClient>>,
        _keepalive_interval_secs: u64,
    ) {
        let mut keepalive = match self.sudo_keepalive.lock() {
            Ok(keepalive) => keepalive,
            Err(_) => return,
        };
        if keepalive.contains_key(connection_id) {
            return;
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
        keepalive.insert(connection_id.to_string(), SudoKeepalive { handle, task });
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

    /// `sftp/list`：目录列表。编码偏好为 latin-1（M14-B）时改走裸包客户端
    /// 拿原始文件名字节（russh-sftp 的反序列化层对文件名做 lossy UTF-8 解码，
    /// 原始字节只能由 raw 路径取得），显示名按 latin-1 解码、传输路径用
    /// `%XX` 转义形式；raw 不可用时回退高层客户端。auto 模式保持原路径
    /// （字节往返无损），仅按 wire 名是否含 U+FFFD 标记 `lossy`。
    pub async fn sftp_list_path(
        &self,
        session_id: &str,
        path: &str,
        include_owner: bool,
        encoding: NameEncoding,
    ) -> Result<Vec<SftpEntry>, String> {
        let path = normalize_remote_path(path)?;
        let mut result = if encoding == NameEncoding::Latin1 {
            match self.raw_list_entries(session_id, &path, encoding).await {
                Ok(entries) => entries,
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte listing unavailable, falling back: {error}"
                    );
                    self.crate_list_entries(session_id, &path, include_owner)
                        .await?
                }
            }
        } else {
            self.crate_list_entries(session_id, &path, include_owner)
                .await?
        };
        if include_owner {
            // One extra read-only round trip upgrades numeric ids to names on
            // SFTPv3 servers (OpenSSH): `ls -l` puts owner/group in fields 3/4.
            // Any failure (no shell, no `ls`, timeout) keeps the numeric or
            // absent values, never the listing itself.
            enrich_owner_names(self, session_id, &path, &mut result).await;
        }
        result.sort_by(|left, right| {
            let left_dir = left.kind == "directory";
            let right_dir = right.kind == "directory";
            right_dir
                .cmp(&left_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(result)
    }

    /// 高层客户端（russh-sftp）路径：合法 UTF-8 服务器下字节往返无损。
    async fn crate_list_entries(
        &self,
        session_id: &str,
        path: &str,
        include_owner: bool,
    ) -> Result<Vec<SftpEntry>, String> {
        let sftp = self.sftp(session_id).await?;
        let entries = sftp
            .lock()
            .await
            .read_dir(path.to_string())
            .await
            .map_err(sftp_error)?;
        Ok(entries
            .map(|entry| {
                let metadata = entry.metadata();
                let kind = classify_entry_kind(entry.file_type());
                let (owner, group) = if include_owner {
                    // Names first (SFTPv4+), numeric ids as the v3 fallback —
                    // the same semantics `sftp/stat` already documents.
                    let owner = metadata
                        .user
                        .clone()
                        .or_else(|| metadata.uid.map(|uid| uid.to_string()));
                    let group = metadata
                        .group
                        .clone()
                        .or_else(|| metadata.gid.map(|gid| gid.to_string()));
                    (owner, group)
                } else {
                    (None, None)
                };
                let name = entry.file_name();
                SftpEntry {
                    lossy: sftp_name::is_lossy_wire(&name),
                    name,
                    uri: sftp_uri(&entry.path()),
                    kind,
                    size: metadata.size,
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions.map(format_permissions),
                    content_type: content_type_for_path(&entry.path()),
                    owner,
                    group,
                }
            })
            .collect())
    }

    /// latin-1 路径：裸包客户端取原始字节。显示名 = latin-1 解码（忠实）；
    /// 传输名 = `%XX` 转义的 wire 形式（合法 UTF-8 字节按字符透传，与高层
    /// 路径完全一致）。属主增强不做（exec 通道对转义名不可靠），保持空值。
    async fn raw_list_entries(
        &self,
        session_id: &str,
        path: &str,
        encoding: NameEncoding,
    ) -> Result<Vec<SftpEntry>, String> {
        let mut client = self.raw_sftp_client(session_id).await?;
        let raw_entries = client.readdir(path.as_bytes()).await?;
        Ok(raw_entries
            .into_iter()
            .filter(|entry| entry.name.as_slice() != b"." && entry.name.as_slice() != b"..")
            .map(|entry| {
                let display = sftp_name::decode_display_name(&entry.name, encoding);
                let wire_name = sftp_name::escape_wire(&entry.name);
                let wire_path = sftp_name::join_wire_name(path, &wire_name);
                SftpEntry {
                    lossy: display.lossy,
                    name: display.text,
                    uri: sftp_uri(&wire_path),
                    kind: classify_raw_kind(entry.attrs.permissions),
                    size: entry.attrs.size,
                    modified_at: entry.attrs.mtime.map(u64::from),
                    permissions: entry.attrs.permissions.map(format_permissions),
                    content_type: content_type_for_path(&wire_path),
                    owner: None,
                    group: None,
                }
            })
            .collect())
    }

    /// 打开一条独立 sftp 子系统通道并跑裸包客户端（严格串行请求/响应）。
    async fn raw_sftp_client(&self, session_id: &str) -> Result<RawSftpClient, String> {
        let session = self.session(session_id).await?;
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        sftp_raw::RawSftp::init(channel.into_stream()).await
    }

    /// 裸包读一个下载分片（转义路径专用）：`%XX` 转义的 wire 路径先还原为
    /// 服务器原始字节再交给 SFTP READ。requested=0 直接回空（EOF 语义）。
    async fn raw_read_chunk(
        &self,
        session_id: &str,
        remote_path: &str,
        offset: u64,
        requested: u32,
    ) -> Result<Vec<u8>, String> {
        if requested == 0 {
            return Ok(Vec::new());
        }
        let raw_path = sftp_name::unescape_wire(remote_path);
        let mut client = self.raw_sftp_client(session_id).await?;
        client.read_chunk(&raw_path, offset, requested).await
    }

    pub async fn sftp_read_path(
        &self,
        session_id: &str,
        path: &str,
        offset: u64,
        max_bytes: usize,
    ) -> Result<(Vec<u8>, bool), String> {
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
        let mut file = sftp.lock().await.open(path).await.map_err(sftp_error)?;
        if offset > 0 {
            use tokio::io::AsyncSeekExt;
            // `SeekFrom::Start` only moves the local read cursor (no fstat
            // round trip); an offset at/after EOF simply yields no data.
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| format!("SFTP seek failed: {error}"))?;
        }
        let mut data = Vec::new();
        file.take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut data)
            .await
            .map_err(|error| format!("SFTP read failed: {error}"))?;
        let truncated = data.len() > max_bytes;
        data.truncate(max_bytes);
        Ok((data, truncated))
    }

    pub async fn sftp_create_directory(
        &self,
        session_id: &str,
        path: &str,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let path = normalize_remote_path(path)?;
        if encoding == NameEncoding::Latin1 {
            // latin-1：目录前缀是列表回传的 wire 形式、最后一段是用户新输入
            // 的显示文本，write_path_bytes 组装出服务器字节后走裸包 MKDIR。
            // 客户端建立失败（尚未发出任何请求）回退高层路径；操作本身的
            // 错误原样上抛——写操作失败后回退可能重复执行，不做。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_path = sftp_name::write_path_bytes(&path);
                    return client.mkdir(&raw_path).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte mkdir unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let result = sftp.lock().await.create_dir(path).await.map_err(sftp_error);
        result
    }

    pub async fn sftp_write_path(
        &self,
        session_id: &str,
        path: &str,
        data: &[u8],
        create: bool,
        overwrite: bool,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        if data.len() > 1024 * 1024 {
            return Err(
                "Direct filesystem writes are limited to 1 MiB; use the streaming transfer API"
                    .to_string(),
            );
        }
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
        let exists = sftp.lock().await.metadata(path.clone()).await.is_ok();
        if exists && !overwrite {
            return Err("SFTP target already exists and overwrite is disabled".to_string());
        }
        if !exists && !create {
            return Err("SFTP target does not exist and create is disabled".to_string());
        }
        let task_id = Uuid::new_v4().to_string();
        let (temporary, backup) = remote_transfer_paths(&path, &task_id)?;
        let mut file = sftp
            .lock()
            .await
            .create(temporary.clone())
            .await
            .map_err(sftp_error)?;
        if let Err(error) = file.write_all(data).await {
            drop(file);
            let _ = sftp.lock().await.remove_file(temporary).await;
            return Err(format!("SFTP write failed: {error}"));
        }
        file.flush()
            .await
            .map_err(|error| format!("SFTP write flush failed: {error}"))?;
        drop(file);
        commit_remote_file(&sftp, &temporary, &path, &backup).await
    }

    pub async fn sftp_rename(
        &self,
        session_id: &str,
        source: &str,
        target: &str,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let source = normalize_remote_path(source)?;
        let target = normalize_remote_path(target)?;
        if encoding == NameEncoding::Latin1 {
            // latin-1：源是列表回传的 wire 路径（整条还原为原始字节）；目标
            // 最后一段是用户新输入的显示文本（write_path_bytes 按 latin-1 编
            // 码回字节）。裸包 RENAME 保证改名不破坏非 UTF-8 字节。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_source = sftp_name::unescape_wire(&source);
                    let raw_target = sftp_name::write_path_bytes(&target);
                    return client.rename(&raw_source, &raw_target).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte rename unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let result = sftp
            .lock()
            .await
            .rename(source, target)
            .await
            .map_err(sftp_error);
        result
    }

    pub async fn sftp_delete(
        &self,
        session_id: &str,
        path: &str,
        recursive: bool,
        encoding: NameEncoding,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let path = normalize_remote_path(path)?;
        if encoding == NameEncoding::Latin1 {
            // latin-1：wire 路径整条还原为原始字节后走裸包删除（LSTAT 判型
            // → REMOVE/RMDIR/递归树删，symlink 绝不跟随）。回退策略与
            // mkdir/rename 相同：仅客户端建立失败时回退高层路径。
            match self.raw_sftp_client(session_id).await {
                Ok(mut client) => {
                    let raw_path = sftp_name::unescape_wire(&path);
                    return raw_delete_path(&mut client, &raw_path, recursive).await;
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] raw byte delete unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = self.sftp(session_id).await?;
        let metadata = sftp
            .lock()
            .await
            .symlink_metadata(path.clone())
            .await
            .map_err(sftp_error)?;
        if metadata.is_symlink() {
            sftp.lock()
                .await
                .remove_file(path)
                .await
                .map_err(sftp_error)
        } else if metadata.is_dir() {
            if !recursive {
                return sftp.lock().await.remove_dir(path).await.map_err(sftp_error);
            }
            delete_directory_tree(&sftp, path).await
        } else {
            sftp.lock()
                .await
                .remove_file(path)
                .await
                .map_err(sftp_error)
        }
    }

    /// Changes the permission bits of a remote path (`sftp/chmod`).
    pub async fn sftp_chmod(&self, session_id: &str, path: &str, mode: u32) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let sftp = self.sftp(session_id).await?;
        let metadata = russh_sftp::protocol::FileAttributes {
            permissions: Some(mode),
            ..Default::default()
        };
        let result = sftp
            .lock()
            .await
            .set_metadata(normalize_remote_path(path)?, metadata)
            .await;
        result.map_err(sftp_error)
    }

    /// Reports filesystem usage for the mount containing `path` via `df -kP`.
    /// Read-only, so it stays available on read-only connections.
    pub async fn sftp_disk_usage(&self, session_id: &str, path: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let path = normalize_remote_path(path)?;
        let command = format!("df -kP {}", exec::shell_quote(&path));
        // Plugin-internal plumbing: no client setEnv, keeping the df output
        // parseable regardless of the connection's locale overrides.
        let outcome =
            exec::exec_plain(&session.handle, &command, Duration::from_secs(20), &[]).await?;
        exec::parse_disk_usage(&outcome.output)
            .ok_or_else(|| format!("Could not parse disk usage output: {}", outcome.output))
    }

    /// Collects server metrics (CPU, memory, load, disks, network rates, top
    /// processes) with read-only commands; available even on read-only
    /// connections. With `cached: true`, serves the session's last snapshot
    /// (marked with `cachedAt`) when one exists — fresh collection only runs
    /// on a cache miss; every fresh result backfills the cache.
    pub async fn metrics(&self, session_id: &str, cached: bool) -> Result<Value, String> {
        if cached {
            if let Some(payload) = self.cached_metrics_snapshot(session_id) {
                return Ok(payload);
            }
        }
        let session = self.session(session_id).await?;
        let snapshot = exec::collect_metrics(&session.handle).await?;
        self.store_metrics_snapshot(session_id, &snapshot);
        // Trend-history ring: one row per fresh collection, keyed by
        // connection. Best-effort — a failed append never fails metrics.
        let sample = metrics_history::sample_from_snapshot(&session.connection_id, &snapshot);
        if let Err(error) = metrics_history::append_sample(&self.data_dir, &sample) {
            eprintln!("[ssh-trace] failed to append metrics history: {error}");
        }
        Ok(snapshot)
    }

    /// `ssh/processes/list`: full sortable process table (CPU-sorted,
    /// server-capped). Read-only commands only.
    pub async fn processes_list(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        metrics::collect_process_list(&session.handle).await
    }

    /// `ssh/processes/kill`: signals one remote process (pid/signal are
    /// validated in `metrics::kill_command`; pid 0/1 refused).
    pub async fn kill_process(
        &self,
        session_id: &str,
        pid: u64,
        signal: u32,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        metrics::kill_process(&session.handle, pid, signal).await?;
        Ok(json!({ "success": true, "pid": pid }))
    }

    /// `ssh/metrics/history`: persisted trend samples for the session's
    /// connection, oldest first. Pure local data — answers without a
    /// live connection.
    pub async fn metrics_history(&self, session_id: &str, limit: usize) -> Result<Value, String> {
        let connection_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .map(|session| session.connection_id.clone())
                .ok_or("Session was not found")?
        };
        let samples = metrics_history::load_history(&self.data_dir, Some(&connection_id), limit);
        Ok(json!({ "connectionId": connection_id, "samples": samples }))
    }

    /// `ssh/recording/start`: attaches a cast recorder to the session's
    /// output stream. One recording per session at a time.
    pub async fn recording_start(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let host = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .map(|connection| connection.host.clone())
            .unwrap_or_default();
        let mut slot = session
            .session_recorder
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if slot.is_some() {
            return Err("This session is already being recorded".to_string());
        }
        let recording_id = Uuid::new_v4().to_string();
        let recorder = session_recording::SessionRecorder::start(
            &self.data_dir,
            &recording_id,
            &session.connection_id,
            &host,
            session_id,
            80,
            24,
        )?;
        *slot = Some(recorder);
        Ok(json!({ "recordingId": recording_id, "recording": true }))
    }

    /// `ssh/recording/stop`: finalizes the active recording (if any) and
    /// returns its summary.
    pub async fn recording_stop(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let recorder = session
            .session_recorder
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
            .ok_or("This session has no active recording")?;
        recorder.finish()
    }

    /// Returns the cached snapshot for a session with its `cachedAt` marker,
    /// or `None` when nothing was collected for it yet.
    fn cached_metrics_snapshot(&self, session_id: &str) -> Option<Value> {
        let cache = self
            .metrics_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache
            .get(session_id)
            .map(|entry| cached_metrics_payload(&entry.value, entry.collected_at))
    }

    /// Backfills the snapshot cache after a fresh collection.
    fn store_metrics_snapshot(&self, session_id: &str, snapshot: &Value) {
        let mut cache = self
            .metrics_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache.insert(
            session_id.to_string(),
            CachedMetrics {
                value: snapshot.clone(),
                collected_at: unix_now_secs(),
            },
        );
    }

    /// Reads the live Quick Sudo / 2FA settings for a session's connection.
    /// `ssh/settings/get`: workbench settings view. Secret presence is
    /// reported as boolean flags only; passing `revealSecrets: true` adds
    /// the raw `sudoPassword` / `totpSecret` configured on the connection
    /// so the settings dialog can prefill what the user stored (values
    /// never leave the user's own workbench; the MCP surface has no
    /// reveal parameter and keeps flag-only responses).
    pub async fn settings_get(&self, session_id: &str, params: &Value) -> Result<Value, String> {
        let reveal = params
            .get("revealSecrets")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let session = self.session(session_id).await?;
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .cloned();
        let auth = session
            .orchestration
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let store = sudo_profiles::load_store(&self.data_dir);
        let profile = connection
            .as_ref()
            .and_then(|connection| effective_sudo_profile(connection, &store));
        let mut view = json!({
            "quickSudo": connection.as_ref().map(|c| c.sudo_enabled()).unwrap_or(true),
            "sudoSource": connection
                .as_ref()
                .map(|c| c.sudo_source.name())
                .unwrap_or("custom"),
            "sudoUsePty": sudo_profiles::effective_use_pty(
                connection.as_ref().map(|c| c.sudo_use_pty).unwrap_or(false),
                profile.as_ref(),
            ),
            "sudoPasswordSet": !auth.password.is_empty(),
            "totpConfigured": auth.totp_configured(),
            "authFlowMode": auth.flow_mode.map(flow_mode_name).unwrap_or("password_then_otp"),
            "passwordPromptHint": auth.password_prompt_hint,
            "totpPromptHint": auth.totp_prompt_hint,
            "quickSudoProfileId": profile.as_ref().map(|p| p.id.clone()).unwrap_or_default(),
            "quickSudoProfileName": profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            "agentTerminalMode": self.agent_terminal_mode(&session.connection_id).name(),
            // Remembered approvals (IMPL_PLAN §2.2): raw pattern lines the
            // user saved from the approval dialog; editable/wildcard-able in
            // the settings panel, matched with the sudoers-style token rules.
            "rememberedCommands": agent_approvals::list_lines(
                &agent_approvals::load_store(&self.data_dir),
                &session.connection_id,
            ),
        });
        if reveal {
            if let Some(connection) = &connection {
                view["sudoPassword"] = Value::String(connection.sudo_password.clone());
                view["totpSecret"] = Value::String(connection.totp_secret.clone());
            }
        }
        Ok(view)
    }

    /// Updates Quick Sudo / 2FA settings at runtime: applies to the stored
    /// connection and every live session of that connection immediately
    /// (terminal auto-answer and exec re-read the shared orchestration).
    /// Values are sidecar-local; reopening the connection from DBX restores
    /// the host-provided configuration. `quickSudoProfileId` switches the
    /// credential source between this connection's own values ("") and a
    /// globally bound Quick Sudo profile; the binding is persisted in the
    /// plugin data directory, so it survives sidecar restarts. While a
    /// profile is bound it owns the credential source wholesale — per-field
    /// updates still land on the stored connection but live sessions follow
    /// the profile.
    pub async fn settings_set(&self, session_id: &str, updates: &Value) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let connection_id = session.connection_id.clone();
        let binding_update = updates
            .get("quickSudoProfileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(profile_id) = binding_update.clone() {
            // Validate and persist before touching anything else, so an
            // unknown profile leaves the request without side effects.
            let mut store = sudo_profiles::load_store(&self.data_dir);
            sudo_profiles::set_binding(
                &mut store,
                &connection_id,
                (!profile_id.is_empty()).then_some(profile_id.as_str()),
            )?;
            sudo_profiles::save_store(&self.data_dir, &store)?;
        }
        // AI terminal mode: validated strictly before anything else mutates,
        // so an unknown value leaves the request without side effects. The
        // set persists too — a failed write reports instead of silently
        // dropping the toggle on the next restart.
        if let Some(raw) = updates.get("agentTerminalMode") {
            let text = raw
                .as_str()
                .ok_or("agentTerminalMode must be a string (off|auto|strict)")?;
            let mode = AgentTerminalMode::parse_exact(text)?;
            self.set_agent_terminal_mode(&connection_id, mode)?;
        }
        // Remembered approvals: full-replacement list from the settings
        // panel. Validated (caps / destructive-line rejection with line
        // numbers) before anything else mutates, so a bad line leaves the
        // request without side effects.
        if let Some(raw) = updates.get("rememberedCommands") {
            let values = raw
                .as_array()
                .ok_or("rememberedCommands must be an array of strings")?;
            let lines: Vec<String> = values
                .iter()
                .map(|value| value.as_str().unwrap_or_default().trim().to_string())
                .collect();
            let mut store = agent_approvals::load_store(&self.data_dir);
            agent_approvals::set_lines(&mut store, &connection_id, &lines)?;
            agent_approvals::save_store(&self.data_dir, &store)?;
        }
        let login_password = {
            let connections = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?;
            connections
                .get(&connection_id)
                .map(|connection| connection.password.clone())
        };

        let optional_string = |key: &str| {
            updates
                .get(key)
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        };
        // Prompt hints are sanitized (control characters/ANSI stripped,
        // length capped) before they touch the stored connection or any
        // live session; malformed input degrades instead of poisoning the
        // prompt classifier. Flow modes and TOTP secrets keep the
        // connect-time parse fallbacks (AuthFlowMode::parse / parse_totp_secrets).
        let hint_string = |key: &str| {
            updates
                .get(key)
                .and_then(Value::as_str)
                .map(exec::sanitize_prompt_hint)
        };

        // Persist flags and secrets on the stored connection.
        {
            let mut connections = self
                .connections
                .write()
                .map_err(|_| "Connection registry is poisoned".to_string())?;
            if let Some(connection) = connections.get_mut(&connection_id) {
                if let Some(value) = updates.get("quickSudo").and_then(Value::as_bool) {
                    // Session toggle: off wins outright; re-enabling an off
                    // connection returns to this connection's own values.
                    connection.sudo_source = match (value, connection.sudo_source) {
                        (false, _) => SudoSource::Off,
                        (true, SudoSource::Off) => SudoSource::Custom,
                        (true, source) => source,
                    };
                }
                // A binding change doubles as a source change: picking a
                // profile switches the connection to "global"; clearing it
                // falls back to this connection's own values ("custom"),
                // while an explicit "off" stays off.
                if let Some(profile_id) = binding_update.clone() {
                    if profile_id.is_empty() {
                        if connection.sudo_source == SudoSource::Global {
                            connection.sudo_source = SudoSource::Custom;
                        }
                    } else {
                        connection.sudo_source = SudoSource::Global;
                    }
                }
                if let Some(value) = updates.get("sudoUsePty").and_then(Value::as_bool) {
                    connection.sudo_use_pty = value;
                }
                if let Some(value) = optional_string("sudoPassword") {
                    connection.sudo_password = value;
                }
                if let Some(value) = optional_string("totpSecret") {
                    connection.totp_secret = value;
                }
                if let Some(value) = hint_string("passwordPromptHint") {
                    connection.password_prompt_hint = value;
                }
                if let Some(value) = hint_string("totpPromptHint") {
                    connection.totp_prompt_hint = value;
                }
                if let Some(value) = optional_string("authFlowMode") {
                    connection.auth_flow_mode = value;
                }
            }
        }

        // Apply to every live session of the connection, field by field so
        // in-flight OTP usage bookkeeping survives unrelated updates.
        let session_entries: Vec<Arc<SessionEntry>> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|entry| entry.connection_id == connection_id)
            .cloned()
            .collect();
        for entry in &session_entries {
            let mut auth = entry
                .orchestration
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(value) = optional_string("sudoPassword") {
                auth.password = if value.is_empty() {
                    login_password.clone().unwrap_or_default()
                } else {
                    value
                };
            }
            if let Some(value) = optional_string("totpSecret") {
                auth.totp_secrets = exec::parse_totp_secrets(&value);
            }
            if let Some(value) = hint_string("passwordPromptHint") {
                auth.password_prompt_hint = value;
            }
            if let Some(value) = hint_string("totpPromptHint") {
                auth.totp_prompt_hint = value;
            }
            if let Some(value) = optional_string("authFlowMode") {
                auth.flow_mode = (!value.is_empty()).then(|| AuthFlowMode::parse(&value));
            }
        }
        // Credential/flag changes can arm or disarm the in-terminal watcher:
        // a password configured after connecting must start answering.
        if let Some(connection) = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&connection_id)
            .cloned()
        {
            for entry in &session_entries {
                Self::sync_auto_sudo(entry, &connection);
                Self::sync_triggers(entry, &connection);
            }
        }
        // A binding change owns the live sessions' credential source: rebuild
        // their orchestration from the now-effective source (the per-field
        // updates above still landed on the stored connection for later).
        // Clearing the binding rebuilds too, so sessions immediately fall
        // back to the connection's own values.
        if updates
            .get("quickSudoProfileId")
            .and_then(Value::as_str)
            .is_some()
        {
            self.refresh_bound_sessions(std::slice::from_ref(&connection_id))
                .await;
        }
        self.settings_get(session_id, updates).await
    }

    /// `sudo/profiles/list`: every global Quick Sudo profile as a
    /// secret-free view.
    pub fn profiles_list(&self) -> Value {
        let store = sudo_profiles::load_store(&self.data_dir);
        json!({ "profiles": sudo_profiles::list_views(&store) })
    }

    /// `sudo/profiles/reveal`: workbench-only view of one profile including
    /// its raw secrets, so the profile editor can prefill what the user
    /// stored. Deliberately not exposed as an MCP tool — agent contexts
    /// keep seeing flags only.
    pub fn profiles_reveal(&self, id: &str) -> Result<Value, String> {
        let store = sudo_profiles::load_store(&self.data_dir);
        sudo_profiles::reveal_profile(&store, id)
    }

    /// `ssh/quickCommands/list`: global quick commands shared by every
    /// connection and workbench.
    pub fn quick_commands_list(&self) -> Value {
        let store = quick_commands::load_store(&self.data_dir);
        json!({ "commands": quick_commands::list_views(&store) })
    }

    /// `ssh/quickCommands/save`: creates or updates one global quick command.
    /// Returns the saved entry, whether it was newly created, and the full
    /// list so the workbench can adopt the authoritative order in one call.
    pub fn quick_commands_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = quick_commands::load_store(&self.data_dir);
        let (entry, created) = quick_commands::save_entry(&mut store, params)?;
        quick_commands::save_store(&self.data_dir, &store)?;
        Ok(json!({
            "quickCommand": quick_commands::entry_view(&entry),
            "created": created,
            "commands": quick_commands::list_views(&store),
        }))
    }

    /// `ssh/quickCommands/delete`: removes one global quick command; unknown
    /// ids report `removed: false` instead of erroring. The store file is
    /// only rewritten when something was actually removed.
    pub fn quick_commands_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = quick_commands::load_store(&self.data_dir);
        let removed = quick_commands::delete_entry(&mut store, id);
        if removed {
            quick_commands::save_store(&self.data_dir, &store)?;
        }
        Ok(json!({
            "removed": removed,
            "commands": quick_commands::list_views(&store),
        }))
    }

    /// `ssh/highlightRules/list`: terminal keyword highlight rules shared by
    /// every workbench, `createdAt` ascending. A fresh data dir is seeded
    /// with the first-run default rules (see `highlight_rules::load_or_seed_store`).
    pub fn highlight_rules_list(&self) -> Value {
        let store = highlight_rules::load_or_seed_store(&self.data_dir);
        json!({ "rules": highlight_rules::list_views(&store) })
    }

    /// `ssh/highlightRules/save`: creates or updates one keyword rule.
    /// Returns the saved rule, whether it was newly created, and the full
    /// list so the workbench adopts the authoritative order in one call.
    /// Seeds the first-run defaults when the store file does not exist yet,
    /// so a first-save on a fresh install keeps them.
    pub fn highlight_rules_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = highlight_rules::load_or_seed_store(&self.data_dir);
        let (entry, created) = highlight_rules::save_entry(&mut store, params)?;
        highlight_rules::save_store(&self.data_dir, &store)?;
        Ok(json!({
            "rule": highlight_rules::entry_view(&entry),
            "created": created,
            "rules": highlight_rules::list_views(&store),
        }))
    }

    /// `ssh/highlightRules/delete`: removes one keyword rule; unknown ids
    /// report `removed: false` without rewriting the file.
    pub fn highlight_rules_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = highlight_rules::load_store(&self.data_dir);
        let removed = highlight_rules::delete_entry(&mut store, id);
        if removed {
            highlight_rules::save_store(&self.data_dir, &store)?;
        }
        Ok(json!({
            "removed": removed,
            "rules": highlight_rules::list_views(&store),
        }))
    }

    /// `sudo/profiles/options`: secret-free select options for the host
    /// connection form (`sudo_profile` field declares this as its
    /// `options_action`). Value is the profile id (what `sudo_profile_ref`
    /// stores); the label is the human-readable name. Hosts without
    /// `options_action` support never call this and keep the text fallback.
    pub fn profiles_options(&self) -> Value {
        let store = sudo_profiles::load_store(&self.data_dir);
        json!({
            "options": sudo_profiles::list_views(&store)
                .into_iter()
                .map(|view| {
                    json!({
                        "value": view["id"],
                        "label": view["name"],
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    /// `sudo/profiles/save`: create or update a global profile, then hot
    /// reload every live session bound to it.
    pub async fn profiles_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = sudo_profiles::load_store(&self.data_dir);
        let (profile, created) = sudo_profiles::save_profile(&mut store, params)?;
        sudo_profiles::save_store(&self.data_dir, &store)?;
        let bound: Vec<String> = store
            .bindings
            .iter()
            .filter(|(_, bound_id)| bound_id.as_str() == profile.id.as_str())
            .map(|(connection_id, _)| connection_id.clone())
            .collect();
        self.refresh_bound_sessions(&bound).await;
        Ok(json!({
            "profile": sudo_profiles::profile_view(&profile),
            "created": created,
        }))
    }

    /// `sudo/profiles/delete`: remove a global profile (bindings cascade)
    /// and drop the override from every live session that used it.
    pub async fn profiles_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = sudo_profiles::load_store(&self.data_dir);
        let bound: Vec<String> = store
            .bindings
            .iter()
            .filter(|(_, bound_id)| bound_id.as_str() == id)
            .map(|(connection_id, _)| connection_id.clone())
            .collect();
        let removed = sudo_profiles::delete_profile(&mut store, id);
        if removed {
            sudo_profiles::save_store(&self.data_dir, &store)?;
            self.refresh_bound_sessions(&bound).await;
        }
        Ok(json!({ "success": true, "removed": removed }))
    }

    /// `connection/action` with action `quick-sudo-profiles`: a plain-text
    /// summary rendered by the host on the connection form panel — the
    /// discoverable stub for global Quick Sudo management (the manager UI
    /// itself lives in the workbench, which the message points to).
    pub fn profiles_action_summary(&self, connection_id: Option<&str>) -> Value {
        let store = sudo_profiles::load_store(&self.data_dir);
        json!({
            "message": sudo_profiles::action_summary(&store, connection_id),
            "fieldValues": null,
        })
    }

    /// Re-arms or disarms a session's in-terminal Quick Sudo watcher from the
    /// connection's current state: Quick Sudo on, connection writable, and
    /// the resolved auth actually holding a credential (password or TOTP).
    /// Runs at session open and after every runtime settings/profile update,
    /// so a password configured after connecting still starts answering
    /// prompts without a reconnect. Re-arming starts from fresh prompt state,
    /// which matches the user having just changed the configuration.
    fn sync_auto_sudo(entry: &SessionEntry, connection: &StoredConnection) {
        let useful = entry
            .orchestration
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .useful();
        let attach = connection.sudo_enabled() && !connection.read_only && useful;
        let mut watcher = entry
            .auto_sudo
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if attach && watcher.is_none() {
            *watcher = Some(exec::TerminalAutoSudo::new(entry.orchestration.clone()));
        } else if !attach && watcher.is_some() {
            // Disarm transitions are logged so "why didn't the terminal
            // auto-answer" is diagnosable from the sidecar log alone.
            eprintln!(
                "[ssh] terminal auto-sudo disarmed: sudoSource={}, readOnly={}, credentials configured={}",
                connection.sudo_source.name(),
                connection.read_only,
                useful,
            );
            *watcher = None;
        }
    }

    /// Attaches or detaches a session's expect-style trigger engine from the
    /// connection's `triggers` configuration (contract §3.1: mirrors
    /// `sync_auto_sudo`). Runs at session open and after every runtime
    /// settings/profile update, so a configuration that lands on the
    /// connection later still arms without a reconnect.
    fn sync_triggers(entry: &SessionEntry, connection: &StoredConnection) {
        let mut engine = entry
            .triggers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match (
            (connection.triggers_enabled)
                .then_some(connection.triggers.as_ref())
                .flatten(),
            engine.is_some(),
        ) {
            (Some(config), false) => {
                *engine = Some(triggers::TriggerEngine::new(
                    config.clone(),
                    triggers::CommandPlaceholders::new(
                        &connection.host,
                        &connection.username,
                        connection.port,
                        connection.name.as_deref().unwrap_or(&connection.id),
                    ),
                ));
            }
            (None, true) => {
                *engine = None;
            }
            _ => {}
        }
    }

    /// Rebuilds the Quick Sudo auth of every live session of the given
    /// connections from the current registry state plus each connection's
    /// bound profile. Field-by-field assignment keeps each auth's OTP usage
    /// bookkeeping intact.
    async fn refresh_bound_sessions(&self, connection_ids: &[String]) {
        if connection_ids.is_empty() {
            return;
        }
        let store = sudo_profiles::load_store(&self.data_dir);
        let sessions = self.sessions.read().await;
        for entry in sessions.values() {
            if !connection_ids.iter().any(|id| id == &entry.connection_id) {
                continue;
            }
            let connection = self
                .connections
                .read()
                .ok()
                .and_then(|registry| registry.get(&entry.connection_id).cloned());
            let Some(connection) = connection else {
                continue;
            };
            let profile = effective_sudo_profile(&connection, &store);
            let auth = resolved_sudo_auth(&connection, profile.as_ref());
            {
                let mut orchestration = entry
                    .orchestration
                    .write()
                    .unwrap_or_else(|poison| poison.into_inner());
                orchestration.password = auth.password;
                orchestration.totp_secrets = auth.totp_secrets;
                orchestration.password_prompt_hint = auth.password_prompt_hint;
                orchestration.totp_prompt_hint = auth.totp_prompt_hint;
                orchestration.flow_mode = auth.flow_mode;
            }
            // A binding switch can arm or disarm the terminal watcher too.
            Self::sync_auto_sudo(entry, &connection);
            Self::sync_triggers(entry, &connection);
        }
    }

    pub async fn start_upload(
        &self,
        session_id: String,
        remote_path: String,
        size: u64,
        resume_task_id: Option<String>,
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
                json!({ "taskId": task_id, "chunkSize": TRANSFER_CHUNK_SIZE, "maxBytes": MAX_TRANSFER_SIZE, "resumeOffset": resume_offset }),
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
            json!({ "taskId": task_id, "chunkSize": TRANSFER_CHUNK_SIZE, "maxBytes": MAX_TRANSFER_SIZE, "resumeOffset": 0_u64 }),
        )
    }

    /// Reopens an interrupted upload's spool file for appending, validating
    /// the resume request against the persisted sidecar meta so a stale or
    /// mismatched resumeTaskId cannot splice the wrong file tail onto the
    /// spooled prefix.
    fn open_resume_spool(
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
                ),
            )
            .map_err(plugin_error)?;
        emitter
            .event(
                "sftp/upload/ack",
                json!({ "taskId": task_id, "offset": offset, "length": chunk.len(), "nextOffset": upload.received }),
            )
            .map_err(plugin_error)
    }

    /// `sftp/upload/finish`: the spool holds the complete file, so hand the
    /// remote push to a background task on the shared runtime and return at
    /// once. Holding this RPC open for the whole push used to expose every
    /// multi-GB upload to RPC deadlines anywhere on the bridge (host,
    /// workbench, sidecar): once the deadline fired the upload was cancelled
    /// mid-flight even though nothing was wrong (issue #60). The background
    /// task reports exclusively through `sftp/transfer/progress` events, which
    /// no deadline can kill; `phase: "uploading"` marks its events.
    pub async fn finish_upload(
        self: &Arc<Self>,
        task_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let upload = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .remove(task_id)
            .ok_or("Upload task was not found")?;
        if upload.received != upload.expected_size {
            // Keep the spool + meta: the received prefix stays resumable via
            // `sftp/upload/start` with `resumeTaskId`.
            let error = format!(
                "Upload is incomplete: expected {}, received {}",
                upload.expected_size, upload.received
            );
            // The task dies here without reaching the commit path, so the
            // failure is recorded explicitly (same ledger entry a failed
            // commit writes).
            self.record_transfer(json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.expected_size, "transferred": upload.received, "status": "failed", "error": error }));
            return Err(error);
        }
        let UploadState {
            session_id,
            remote_path,
            expected_size,
            received: _,
            local_path,
            file,
        } = upload;
        drop(file);
        let transferred_bytes = Arc::new(AtomicU64::new(0));
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel_reason = Arc::new(Mutex::new(None::<String>));
        self.finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .insert(
                task_id.to_string(),
                FinishingUpload {
                    session_id: session_id.clone(),
                    remote_path: remote_path.clone(),
                    size: expected_size,
                    transferred: transferred_bytes.clone(),
                    cancelled: cancelled.clone(),
                    cancel_reason: cancel_reason.clone(),
                },
            );
        let this = self.clone();
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        let response_task_id = task_id.clone();
        tokio::spawn(async move {
            let result: Result<(), String> = async {
                let sftp = this.sftp(&session_id).await?;
                let (temporary, backup) = remote_transfer_paths(&remote_path, &task_id)?;
                let mut source = tokio::fs::File::open(&local_path)
                    .await
                    .map_err(|error| format!("Failed to open upload spool file: {error}"))?;
                let mut target = sftp
                    .lock()
                    .await
                    .create(temporary.clone())
                    .await
                    .map_err(sftp_error)?;
                let mut transferred = 0_u64;
                let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
                loop {
                    if cancelled.load(Ordering::Acquire) {
                        let reason = cancel_reason
                            .lock()
                            .map(|reason| reason.clone())
                            .unwrap_or_default();
                        let error = upload_cancel_error(reason.as_deref());
                        eprintln!("[sftp] upload {task_id} aborted by cancel ({error})");
                        drop(target);
                        let _ = sftp.lock().await.remove_file(temporary.clone()).await;
                        return Err(error);
                    }
                    let read = source
                        .read(&mut buffer)
                        .await
                        .map_err(|error| format!("Failed to read upload spool file: {error}"))?;
                    if read == 0 {
                        break;
                    }
                    if let Err(error) = target.write_all(&buffer[..read]).await {
                        drop(target);
                        let _ = sftp.lock().await.remove_file(temporary.clone()).await;
                        return Err(format!("SFTP upload failed: {error}"));
                    }
                    transferred = transferred.saturating_add(read as u64);
                    transferred_bytes.store(transferred, Ordering::Release);
                    emitter
                        .event(
                            "sftp/transfer/progress",
                            upload_progress_payload(
                                &task_id,
                                &session_id,
                                None,
                                transferred,
                                expected_size,
                                UploadPhase::Uploading,
                                "running",
                            ),
                        )
                        .map_err(plugin_error)?;
                }
                target
                    .flush()
                    .await
                    .map_err(|error| format!("SFTP upload flush failed: {error}"))?;
                drop(target);
                commit_remote_file(&sftp, &temporary, &remote_path, &backup).await
            }
            .await;
            match this.finishing_uploads.lock() {
                Ok(mut finishing) => {
                    finishing.remove(&task_id);
                }
                Err(_) => eprintln!("[sftp] upload {task_id} finishing registry poisoned"),
            }
            let _ = tokio::fs::remove_file(&local_path).await;
            remove_upload_meta(&this.transfer_dir, &task_id);
            match result {
                Ok(()) => {
                    let task = upload_progress_payload(
                        &task_id,
                        &session_id,
                        Some(remote_path.rsplit('/').next().unwrap_or("upload")),
                        expected_size,
                        expected_size,
                        UploadPhase::Uploading,
                        "completed",
                    );
                    this.record_transfer(task.clone());
                    if let Err(error) = emitter.event("sftp/transfer/progress", task) {
                        eprintln!(
                            "[sftp] upload {task_id} completion event failed: {}",
                            error.message
                        );
                    }
                }
                Err(error) => {
                    eprintln!("[sftp] upload {task_id} push failed: {error}");
                    let status = if cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    let mut task = upload_progress_payload(
                        &task_id,
                        &session_id,
                        Some(remote_path.rsplit('/').next().unwrap_or("upload")),
                        transferred_bytes.load(Ordering::Acquire),
                        expected_size,
                        UploadPhase::Uploading,
                        status,
                    );
                    task["error"] = json!(error);
                    this.record_transfer(task.clone());
                    let _ = emitter.event("sftp/transfer/progress", task);
                }
            }
        });
        Ok(
            json!({ "success": true, "taskId": response_task_id, "phase": UploadPhase::Uploading.as_str(), "accepted": expected_size }),
        )
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
        if self.active_transfer_count(session_id)? >= 3 {
            return Err("This SSH session already has three active transfers".to_string());
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

    #[allow(clippy::too_many_arguments)]
    pub async fn start_download(
        &self,
        session_id: &str,
        remote_path: &str,
        offset: u64,
        save_to_local: bool,
        download_dir: Option<&str>,
        conflict: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let remote_path = normalize_remote_path(remote_path)?;
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
        // 传输路径含 `%XX` 转义（latin-1 列表产出的非 UTF-8 名字）时，走
        // 裸包 STAT 取真实字节数——高层客户端会把转义串按字面量发出去，
        // 命中不了远端文件（M14-B：传输用服务器原始字节）。
        let size = if sftp_name::has_wire_escapes(&remote_path) {
            let mut client = self.raw_sftp_client(session_id).await?;
            client
                .stat(remote_path.as_bytes())
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
        let file_name = remote_path
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("download")
            .to_string();
        let task_id = Uuid::new_v4().to_string();
        let sink = self
            .build_download_sink(&task_id, download_dir, conflict)
            .await?;
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
                },
            );
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
            json!({ "taskId": task_id, "fileName": file_name, "size": size, "chunkSize": TRANSFER_CHUNK_SIZE, "resumeOffset": offset, "saveToLocal": save_to_local }),
        )
    }

    /// `sftp/download/tree/start`: recursive folder download. Pure SFTP — the
    /// remote tree is walked with `read_dir` (no shell, no remote temp
    /// archive), regular files stream one at a time through the same chunked
    /// `sftp/download/next` pipeline as plain downloads, and the local layout
    /// mirrors the remote one under a fresh, collision-free folder (empty
    /// directories included). Symlinks are never followed (cycle protection);
    /// per-file problems are recorded and skipped so one bad file cannot sink
    /// the whole tree.
    pub async fn start_tree_download(
        &self,
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
        let root_local = local_downloads::final_download_path(&base_dir, &root_name, false);
        std::fs::create_dir_all(&root_local).map_err(|error| {
            format!(
                "Failed to create download folder '{}': {error}",
                root_local.display()
            )
        })?;
        // latin-1：远端遍历走裸包 READDIR（同一通道 LSTAT 预检 + 递归），
        // 整树路径字节保真；裸包通道建立失败回退高层遍历（只读，安全）。
        // auto 维持高层客户端（合法 UTF-8 服务器字节往返无损）。
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
            Err(error) => {
                let _ = std::fs::remove_dir_all(&root_local);
                return Err(error);
            }
        };
        // 本地目录骨架先行：空目录也保留。
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
        let total = scan.total_bytes();
        let file_count = scan.file_count();
        let dir_count = scan.dir_count();
        let skipped = scan.skipped;
        let file_name = root_local
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_name.to_string());
        let task_id = Uuid::new_v4().to_string();
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
                    }),
                    sudo_tmp: None,
                },
            );
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "fileName": file_name, "transferred": 0, "size": total, "status": "queued", "fileCount": file_count }),
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
            json!({ "taskId": task_id, "fileName": file_name, "size": total, "chunkSize": TRANSFER_CHUNK_SIZE, "fileCount": file_count, "dirCount": dir_count, "skippedCount": skipped }),
        )
    }

    /// Chunk pump for folder downloads. `next_offset` stays the aggregate byte
    /// position across the tree; when the in-flight file completes it is
    /// renamed into place and the next queued file opens within the same call,
    /// so the caller's chunk loop is identical to a plain download. A tree
    /// whose queue is drained answers with an empty eof chunk (this is also
    /// how a zero-byte tree completes — the frontend loop runs until eof, not
    /// until the byte total).
    async fn download_tree_chunk(
        &self,
        task_id: &str,
        offset: u64,
        download: DownloadState,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if offset != download.next_offset {
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let sftp = self.sftp(&download.session_id).await?;
        let Some(mut tree) = download.tree.clone() else {
            return Err("Download task is not a folder download".to_string());
        };
        loop {
            if tree.current.is_none() {
                let Some(file) = tree.files.pop_front() else {
                    // 队列耗尽：空树或全部走完。最后一批文件的改名/失败登记
                    // 就发生在本次调用里，先把状态写回，finish 才能看到完整
                    // 汇总；随后补发一个空 eof 块，让前端的分块等待器（只认
                    // 二进制帧）与单文件语义保持一致。
                    {
                        let mut downloads = self
                            .downloads
                            .lock()
                            .map_err(|_| "Download registry is poisoned".to_string())?;
                        if let Some(current) = downloads.get_mut(task_id) {
                            if let Some(tree_state) = current.tree.as_mut() {
                                *tree_state = tree.clone();
                            }
                        }
                    }
                    let mut payload = Vec::with_capacity(8);
                    payload.extend_from_slice(&offset.to_be_bytes());
                    emitter
                        .binary(&format!("sftp/download/{task_id}"), &payload)
                        .map_err(plugin_error)?;
                    return Ok(
                        json!({ "taskId": task_id, "offset": offset, "length": 0, "eof": true, "fileName": download.file_name }),
                    );
                };
                match open_tree_sink(&tree.root_local, &file.relative).await {
                    Ok(sink) => {
                        tree.sink = Some(Arc::new(sink));
                        tree.current = Some(file);
                        tree.current_offset = 0;
                    }
                    Err(error) => {
                        tree.failures
                            .push(json!({ "path": file.relative, "error": error }));
                        continue;
                    }
                }
            }
            let file = tree.current.clone().expect("current file is present");
            let remaining = file.size - tree.current_offset;
            if remaining == 0 {
                // 当前文件收尾：暂存 .part 改名落位（空文件也会在这一步真实
                // 落地），失败记入汇总且不中断整树。
                finalize_tree_current(self, &mut tree).await;
                continue;
            }
            let mut source = match sftp.lock().await.open(file.remote_path.clone()).await {
                Ok(source) => source,
                Err(error) => {
                    tree.failures
                        .push(json!({ "path": file.relative, "error": sftp_error(error) }));
                    discard_tree_current(&mut tree);
                    continue;
                }
            };
            if let Err(error) = source
                .seek(std::io::SeekFrom::Start(tree.current_offset))
                .await
            {
                tree.failures.push(json!({ "path": file.relative, "error": format!("SFTP download seek failed: {error}") }));
                discard_tree_current(&mut tree);
                continue;
            }
            let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
            let mut chunk = vec![0_u8; requested];
            let length = match source.read(&mut chunk).await {
                Ok(length) => length,
                Err(error) => {
                    tree.failures.push(json!({ "path": file.relative, "error": format!("SFTP download failed: {error}") }));
                    discard_tree_current(&mut tree);
                    continue;
                }
            };
            if length == 0 {
                // 远端文件比扫描时短：只记失败，不把半成品留在本地。
                tree.failures.push(
                    json!({ "path": file.relative, "error": "file shrank below its scanned size" }),
                );
                discard_tree_current(&mut tree);
                continue;
            }
            chunk.truncate(length);
            // 克隆 Arc 而非借用，写失败的清理路径需要 &mut tree。
            if let Some(sink) = tree.sink.clone() {
                if let Err(error) = sink.file.lock().await.write_all(&chunk).await {
                    tree.failures.push(json!({ "path": file.relative, "error": format!("Failed to write local download file: {error}") }));
                    discard_tree_current(&mut tree);
                    continue;
                }
            }
            tree.current_offset += length as u64;
            // 文件耗尽即在本调用内收尾（改名落位）：eof 与落位必须同帧，否则
            // eof 后调用方直接 finish，最后一个文件会被记成未传输。
            if tree.current_offset >= file.size {
                finalize_tree_current(self, &mut tree).await;
            }
            let next_offset = offset + length as u64;
            let mut payload = Vec::with_capacity(8 + length);
            payload.extend_from_slice(&offset.to_be_bytes());
            payload.extend_from_slice(&chunk);
            emitter
                .binary(&format!("sftp/download/{task_id}"), &payload)
                .map_err(plugin_error)?;
            {
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
                if let Some(tree_state) = current.tree.as_mut() {
                    *tree_state = tree.clone();
                }
            }
            let current_remaining = tree
                .current
                .as_ref()
                .map(|file| file.size - tree.current_offset)
                .unwrap_or(0);
            let eof = sftp_tree::tree_eof(tree.files.len(), current_remaining);
            emitter
                .event(
                    "sftp/transfer/progress",
                    json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running", "fileCount": tree.file_count, "fileIndex": tree.files_done + u64::from(tree.current.is_some()), "currentFile": tree.current.as_ref().map(|file| file.relative.clone()) }),
                )
                .map_err(plugin_error)?;
            return Ok(
                json!({ "taskId": task_id, "offset": offset, "length": length, "eof": eof, "fileName": download.file_name }),
            );
        }
    }

    pub async fn download_chunk(
        &self,
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
        if download.tree.is_some() {
            return self
                .download_tree_chunk(task_id, offset, download, emitter)
                .await;
        }
        if offset != download.next_offset {
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
        let remaining = download.size.saturating_sub(offset);
        let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
        // 转义路径走裸包 READ（raw 字节打开远端文件）；普通路径保持高层
        // 客户端的 seek+read。每 chunk 独立 open/close：转义名是极少数派，
        // 简单性优先。raw EOF 回空 chunk，与高层路径的 eof 语义一致。
        let chunk = if sftp_name::has_wire_escapes(&download.remote_path) {
            self.raw_read_chunk(
                &download.session_id,
                &download.remote_path,
                offset,
                requested as u32,
            )
            .await?
        } else {
            let sftp = self.sftp(&download.session_id).await?;
            let mut source = sftp
                .lock()
                .await
                .open(download.remote_path.clone())
                .await
                .map_err(sftp_error)?;
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
            chunk
        };
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
        if let Some(current) = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .get_mut(task_id)
        {
            if current.next_offset != offset {
                return Err("Download task changed while a chunk was in flight".to_string());
            }
            current.next_offset = next_offset;
        }
        emitter
            .event(
                "sftp/transfer/progress",
                json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "transferred": next_offset, "size": download.size, "status": "running" }),
            )
            .map_err(plugin_error)?;
        Ok(
            json!({ "taskId": task_id, "offset": offset, "length": length, "eof": next_offset >= download.size, "fileName": download.file_name }),
        )
    }

    /// `sftp/transfer/cancel`. `reason` is an optional workbench slug ("user",
    /// "ack-timeout", ...) recorded in the ledger event so a cancellation can
    /// be told apart from a server failure on the next bug report.
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
                );
                task["error"] = json!(upload_cancel_error(reason));
                (task, upload.session_id.clone(), upload.remote_path.clone())
            });
        if let Some(upload) = upload.as_ref() {
            let _ = std::fs::remove_file(&upload.local_path);
            remove_upload_meta(&self.transfer_dir, task_id);
        }
        if let Some(download) = download.as_ref() {
            if let Some(sink) = download.sink.as_ref() {
                let _ = std::fs::remove_file(&sink.part_path);
            }
            // 文件夹下载的取消语义：整棵半成品目录删除，不在下载目录里留
            // 部分内容（根目录是本任务创建的让位新目录，删除不伤及他物）。
            if let Some(tree) = download.tree.as_ref() {
                let _ = std::fs::remove_dir_all(&tree.root_local);
            }
            // sudo 下载取消：远端临时件同样属于本任务，best-effort 删除。
            if let Some(tmp) = download.sudo_tmp.as_ref() {
                if let Err(error) =
                    sudo_download::discard_tmp(self, &download.session_id, tmp).await
                {
                    eprintln!("[sudo-download] temp cleanup failed ({tmp}): {error}");
                }
            }
        }
        if upload.is_none() && download.is_none() && finishing.is_none() {
            return Err("Transfer task was not found".to_string());
        }
        // 推送阶段取消的远端收尾提前：推送循环要到下一个分块边界才观察到
        // cancelled 标志并自行删除远端临时文件，取消 RPC 返回后立刻列目录会
        // 看见最长一个分块周期的 .part 残留（#60 回归记录的竞窗）。这里
        // best-effort 提前删掉 .part。只删临时件，绝不碰 .backup——取消可能与
        // 提交链的 target→backup→target 往返并发，删 backup 会破坏回滚；
        // 与推送循环自身的 remove 并发安全（重复删除只是一次无害的 NoSuchFile）。
        if let Some((_, session_id, remote_path)) = finishing.as_ref() {
            if let Ok((temporary, _backup)) = remote_transfer_paths(remote_path, task_id) {
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
        let finishing = finishing.map(|(task, _, _)| task);
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
        let result = self
            .complete_single_file_download(download, task_id, emitter)
            .await;
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
        let local_path = match download.sink.as_ref() {
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
        let mut task = json!({
            "taskId": task_id, "sessionId": download.session_id, "direction": "download",
            "fileName": download.file_name, "size": download.size, "transferred": download.next_offset,
            "status": "completed",
            "fileCount": tree.file_count, "failedCount": failed_count, "skippedCount": tree.skipped,
        });
        task["localPath"] = json!(tree.root_local.to_string_lossy());
        self.record_transfer(task.clone());
        emitter
            .event("sftp/transfer/progress", task)
            .map_err(plugin_error)?;
        Ok(json!({
            "success": true,
            "taskId": task_id,
            "localPath": tree.root_local.to_string_lossy(),
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

    pub fn transfer_list(&self, session_id: &str) -> Result<Value, String> {
        let uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?;
        let downloads = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?;
        let finishing_uploads = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?;
        let history = self
            .transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?;
        let mut tasks = history
            .iter()
            .filter(|task| task.get("sessionId").and_then(Value::as_str) == Some(session_id))
            .cloned()
            .collect::<Vec<_>>();
        tasks.extend(
            uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, upload)| {
                    upload_progress_payload(
                        task_id,
                        session_id,
                        Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                        upload.received,
                        upload.expected_size,
                        UploadPhase::Staging,
                        "running",
                    )
                })
                .collect::<Vec<_>>(),
        );
        tasks.extend(
            finishing_uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, upload)| {
                    upload_progress_payload(
                        task_id,
                        session_id,
                        Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                        upload.transferred.load(Ordering::Acquire),
                        upload.size,
                        UploadPhase::Uploading,
                        if upload.cancelled.load(Ordering::Acquire) {
                            "cancelled"
                        } else {
                            "running"
                        },
                    )
                }),
        );
        tasks.extend(
            downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .map(|(task_id, download)| {
                    let mut row = json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "running" });
                    if let Some(tree) = download.tree.as_ref() {
                        row["fileCount"] = json!(tree.file_count);
                    }
                    row
                }),
        );
        Ok(json!({ "tasks": tasks }))
    }

    pub fn transfer_status(&self, task_id: &str) -> Result<Value, String> {
        if let Some(upload) = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .get(task_id)
        {
            return Ok(upload_progress_payload(
                task_id,
                &upload.session_id,
                Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                upload.received,
                upload.expected_size,
                UploadPhase::Staging,
                "running",
            ));
        }
        if let Some(upload) = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .get(task_id)
        {
            return Ok(upload_progress_payload(
                task_id,
                &upload.session_id,
                Some(upload.remote_path.rsplit('/').next().unwrap_or("upload")),
                upload.transferred.load(Ordering::Acquire),
                upload.size,
                UploadPhase::Uploading,
                if upload.cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "running"
                },
            ));
        }
        if let Some(download) = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .get(task_id)
        {
            let mut status = json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "size": download.size, "transferred": download.next_offset, "status": "running" });
            if let Some(tree) = download.tree.as_ref() {
                status["fileCount"] = json!(tree.file_count);
                status["filesRemaining"] =
                    json!(tree.files.len() + usize::from(tree.current.is_some()));
                status["currentFile"] =
                    json!(tree.current.as_ref().map(|file| file.relative.clone()));
            }
            return Ok(status);
        }
        if let Some(task) = self
            .transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?
            .iter()
            .find(|task| task.get("taskId").and_then(Value::as_str) == Some(task_id))
        {
            return Ok(task.clone());
        }
        Err("Transfer task was not found".to_string())
    }

    /// `sftp/transfer/history`: merges the persisted history with the
    /// in-memory live tasks, deduplicated by taskId (the live snapshot wins
    /// because it carries fresh progress), newest first. Pure local data, so
    /// it answers without any active connection.
    pub async fn transfer_history_query(
        &self,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Value, String> {
        let sessions = self.sessions.read().await;
        let connection_id_for = |sid: &str| {
            sessions
                .get(sid)
                .map(|session| session.connection_id.clone())
                .unwrap_or_default()
        };
        self.build_transfer_history(session_id, limit, &connection_id_for)
    }

    pub fn clear_transfer_history(&self) -> Result<(), String> {
        self.transfer_history
            .lock()
            .map_err(|_| "Transfer history is poisoned".to_string())?
            .clear();
        transfer_history::clear_history(&self.data_dir)
    }

    /// Synchronous core of `transfer_history_query`; `connection_id_for`
    /// resolves the owning connection of a session (empty when unknown) so
    /// tests can inject the lookup without live sessions.
    fn build_transfer_history(
        &self,
        session_id: Option<&str>,
        limit: usize,
        connection_id_for: &impl Fn(&str) -> String,
    ) -> Result<Value, String> {
        // Stale running/queued rows from a dead sidecar surface as failed
        // here (they are never rewritten on disk, so another live process'
        // in-flight transfers stay untouched).
        let mut tasks = transfer_history::load_history(&self.data_dir);
        for row in self.live_transfer_rows(connection_id_for) {
            let task_id = row
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // The live snapshot has no start context of its own; keep the
            // persisted row's startedAt/connectionId when present.
            let mut merged = row;
            if let Some(persisted) = tasks
                .iter()
                .find(|task| task.get("taskId").and_then(Value::as_str) == Some(task_id.as_str()))
            {
                for key in ["startedAt", "connectionId"] {
                    if let Some(value) = persisted.get(key) {
                        merged[key] = value.clone();
                    }
                }
            }
            tasks.retain(|task| {
                task.get("taskId").and_then(Value::as_str) != Some(task_id.as_str())
            });
            tasks.push(merged);
        }
        if let Some(filter) = session_id {
            tasks.retain(|task| task.get("sessionId").and_then(Value::as_str) == Some(filter));
        }
        // Issue #18: the previous sort keyed on `startedAt` alone and left
        // rows without one (live rows whose start record never reached the
        // disk) stacked at the bottom in whatever order the in-memory
        // registries happened to iterate — so the same task jumped between
        // the top, middle and bottom of the panel between refreshes. A total
        // order with a taskId tiebreak keeps every poll deterministic.
        tasks.sort_by(compare_history_rows);
        tasks.truncate(limit);
        Ok(json!({ "tasks": tasks }))
    }

    /// Live snapshot rows from the in-memory transfer registries. These rows
    /// carry fresh progress but no start context; `build_transfer_history`
    /// merges them over the persisted rows. A poisoned registry is skipped:
    /// the history query stays answerable from the persisted store.
    fn live_transfer_rows(&self, connection_id_for: &impl Fn(&str) -> String) -> Vec<Value> {
        let mut rows = Vec::new();
        if let Ok(uploads) = self.uploads.lock() {
            for (task_id, upload) in uploads.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": upload.session_id,
                    "connectionId": connection_id_for(&upload.session_id),
                    "direction": "upload",
                    "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                    "size": upload.expected_size,
                    "transferred": upload.received,
                    "status": "running",
                }));
            }
        }
        if let Ok(finishing) = self.finishing_uploads.lock() {
            for (task_id, upload) in finishing.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": upload.session_id,
                    "connectionId": connection_id_for(&upload.session_id),
                    "direction": "upload",
                    "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                    "size": upload.size,
                    "transferred": upload.transferred.load(Ordering::Acquire),
                    "status": if upload.cancelled.load(Ordering::Acquire) { "cancelled" } else { "running" },
                }));
            }
        }
        if let Ok(downloads) = self.downloads.lock() {
            for (task_id, download) in downloads.iter() {
                rows.push(json!({
                    "taskId": task_id,
                    "sessionId": download.session_id,
                    "connectionId": connection_id_for(&download.session_id),
                    "direction": "download",
                    "fileName": download.file_name,
                    "size": download.size,
                    "transferred": download.next_offset,
                    "status": "running",
                }));
            }
        }
        rows
    }

    fn record_transfer(&self, task: Value) {
        let Some(task_id) = task.get("taskId").and_then(Value::as_str) else {
            return;
        };
        if let Ok(mut history) = self.transfer_history.lock() {
            history.retain(|entry| entry.get("taskId").and_then(Value::as_str) != Some(task_id));
            history.push_back(task.clone());
            while history.len() > 64 {
                history.pop_front();
            }
        }
        // Terminal transitions also land in <data_dir>/transfer-history.json
        // so the workbench keeps them across sidecar restarts. Cross-process
        // semantics are last-writer-wins (see transfer_history.rs).
        self.persist_transfer_record(&task);
    }

    /// Persists the start transition of a transfer job. Live tasks stay in
    /// the in-memory registries; the persisted history only sees status
    /// transitions, never per-chunk progress.
    fn record_transfer_start(
        &self,
        task_id: &str,
        session_id: &str,
        connection_id: &str,
        direction: &str,
        file_name: &str,
        size: u64,
    ) {
        self.persist_transfer_record(&json!({
            "taskId": task_id,
            "sessionId": session_id,
            "connectionId": connection_id,
            "direction": direction,
            "fileName": file_name,
            "size": size,
            "transferred": 0,
            "status": "running",
            "startedAt": unix_now_ms(),
            "finishedAt": Value::Null,
        }));
    }

    /// Best-effort persistence of one status transition; a failed write is
    /// logged but never fails the transfer itself (history is UX data, not
    /// an audit ledger).
    fn persist_transfer_record(&self, task: &Value) {
        if let Err(error) = transfer_history::record_transition(&self.data_dir, task) {
            eprintln!("[ssh-trace] failed to persist transfer history: {error}");
        }
    }

    /// Connection owning a session, or empty when the session is no longer
    /// registered (sidecar restarted after the workbench attached).
    async fn session_connection_id(&self, session_id: &str) -> String {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|session| session.connection_id.clone())
            .unwrap_or_default()
    }

    /// 会话级传输并发深度（M14-B）：偏好 `transfer_max_active` 可配
    /// （1..=8，缺省 3 = 历史硬编码值）；老旧服务器兼容模式下强制 1。
    /// 每次任务启动现读现用——改动即时生效，进行中的任务按原深度自然完成。
    fn transfer_depth_limit(&self) -> u64 {
        if crate::preferences::sftp_compat_mode(&self.data_dir) {
            return 1;
        }
        crate::preferences::transfer_max_active(&self.data_dir)
    }

    fn active_transfer_count(&self, session_id: &str) -> Result<usize, String> {
        let uploads = self
            .uploads
            .lock()
            .map_err(|_| "Upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
            .count();
        let downloads = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .values()
            .filter(|download| download.session_id == session_id)
            .count();
        let finishing_uploads = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
            .count();
        Ok(uploads + finishing_uploads + downloads)
    }

    fn cleanup_session_transfers(&self, session_id: &str) -> Result<(), String> {
        let removed_uploads = {
            let mut uploads = self
                .uploads
                .lock()
                .map_err(|_| "Upload registry is poisoned".to_string())?;
            let task_ids = uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>();
            task_ids
                .into_iter()
                .filter_map(|task_id| uploads.remove_entry(&task_id))
                .collect::<Vec<_>>()
        };
        for (task_id, upload) in removed_uploads {
            let _ = std::fs::remove_file(&upload.local_path);
            // A session close aborts its unfinished uploads; record them as
            // failed so the persisted history keeps no silent ghosts.
            self.persist_transfer_record(&json!({
                "taskId": task_id,
                "sessionId": upload.session_id,
                "direction": "upload",
                "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"),
                "size": upload.expected_size,
                "transferred": upload.received,
                "status": "failed",
                "error": "Transfer was aborted because the session closed",
            }));
        }
        {
            let mut downloads = self
                .downloads
                .lock()
                .map_err(|_| "Download registry is poisoned".to_string())?;
            let task_ids = downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>();
            for task_id in task_ids {
                let Some((task_id, download)) = downloads.remove_entry(&task_id) else {
                    continue;
                };
                if let Some(sink) = download.sink.as_ref() {
                    let _ = std::fs::remove_file(&sink.part_path);
                }
                self.persist_transfer_record(&json!({
                    "taskId": task_id,
                    "sessionId": download.session_id,
                    "direction": "download",
                    "fileName": download.file_name,
                    "size": download.size,
                    "transferred": download.next_offset,
                    "status": "failed",
                    "error": "Transfer was aborted because the session closed",
                }));
            }
        }
        for upload in self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .values()
            .filter(|upload| upload.session_id == session_id)
        {
            upload.cancelled.store(true, Ordering::Release);
        }
        if let Ok(mut history) = self.transfer_history.lock() {
            history
                .retain(|task| task.get("sessionId").and_then(Value::as_str) != Some(session_id));
        }
        Ok(())
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
        attempts.push(attempt);
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
        Ok(AgentAuthOutcome::Rejected) => record(auto_auth_attempt(
            "agent",
            "no SSH Agent identity was accepted".to_string(),
        )),
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
/// server still accepts. Keyboard-interactive rounds are auto-answered from
/// the Quick Sudo orchestration config, covering PAM 2FA/TOTP logins.
async fn authenticate_password_or_interactive(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
    offered: &AuthResult,
    prompts: &PromptBroker,
) -> Result<(), String> {
    if method_offered(offered, MethodKind::Password) {
        eprintln!("[ssh-trace] auth: password method offered, trying password");
        let result = try_password(session, connection).await?;
        eprintln!(
            "[ssh-trace] auth: password result success={}",
            result.success()
        );
        if result.success() {
            return Ok(());
        }
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
    if method_offered(offered, MethodKind::KeyboardInteractive) {
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
    Err("SSH server did not advertise password or keyboard-interactive authentication; refusing to send the password".to_string())
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
    let lower = filtered.to_lowercase();
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentAuthOutcome {
    Accepted,
    /// The server accepted an identity but still demands keyboard-interactive
    /// (MFA), so the caller must continue the handshake instead of reporting
    /// "no identity was accepted".
    NeedsKeyboardInteractive,
    Rejected,
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
            let mut needs_keyboard_interactive = false;
            for identity in identities {
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
                if let Ok(result) = result {
                    if result.success() {
                        return AgentAuthOutcome::Accepted;
                    }
                    if auth_partial_success(&result)
                        && method_offered(&result, MethodKind::KeyboardInteractive)
                    {
                        needs_keyboard_interactive = true;
                    }
                }
            }
            if needs_keyboard_interactive {
                AgentAuthOutcome::NeedsKeyboardInteractive
            } else {
                AgentAuthOutcome::Rejected
            }
        },
    )
    .await
    .map_err(|_| "SSH Agent authentication timed out".to_string())?;
    Ok(outcome)
}

async fn publish_terminal(
    session_id: &str,
    stream: TerminalStream,
    data: Vec<u8>,
    replay: &Arc<AsyncMutex<ReplayBuffer>>,
    emitter: &PluginEmitter,
) {
    let frame = replay.lock().await.push(stream, data);
    if let Err(error) = emitter.binary(&format!("ssh/terminal/out/{session_id}"), &frame.encode()) {
        eprintln!(
            "[ssh-sftp-plugin] terminal output failed: {}",
            error.message
        );
    }
}

async fn delete_directory_tree(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: String,
) -> Result<(), String> {
    let mut pending = vec![root];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        let entries = sftp
            .lock()
            .await
            .read_dir(directory)
            .await
            .map_err(sftp_error)?;
        for entry in entries {
            if entry.file_type() == FileType::Dir {
                pending.push(entry.path());
            } else {
                sftp.lock()
                    .await
                    .remove_file(entry.path())
                    .await
                    .map_err(sftp_error)?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        sftp.lock()
            .await
            .remove_dir(directory)
            .await
            .map_err(sftp_error)?;
    }
    Ok(())
}

/// Recursively walks a remote directory over SFTP and collects the folder
/// download plan (breadth-first, so parents are read before children):
/// regular files in download order, the directory layout, symlink/special
/// skips and per-path failures. The root itself is pre-checked first
/// (symlinks are refused, non-directories rejected). Only root-level
/// problems (not a readable directory) abort; a failing subdirectory is
/// recorded and the walk goes on.
/// Symlinks are never followed, so server-side cycles cannot loop the walk.
async fn scan_remote_tree(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let metadata = sftp
        .lock()
        .await
        .symlink_metadata(root.to_string())
        .await
        .map_err(sftp_error)?;
    if metadata.is_symlink() {
        return Err(
            "Refusing to download a symlink as a folder; download its target instead".to_string(),
        );
    }
    if !metadata.is_dir() {
        return Err("Folder download needs a remote directory".to_string());
    }
    scan_remote_tree_walk(sftp, root).await
}

/// 高层客户端的树遍历主体（根预检已由 [`scan_remote_tree`] 完成）。
async fn scan_remote_tree_walk(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    root: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let mut scan = sftp_tree::TreeScan::new();
    let mut pending: VecDeque<(String, String)> = VecDeque::new();
    pending.push_back((root.to_string(), String::new()));
    while let Some((dir_remote, dir_relative)) = pending.pop_front() {
        let entries = sftp.lock().await.read_dir(dir_remote.clone()).await;
        let entries = match entries {
            Ok(entries) => entries,
            Err(error) => {
                if dir_relative.is_empty() {
                    return Err(sftp_error(error));
                }
                scan.record_failure(
                    &dir_relative,
                    format!("directory is not readable: {}", sftp_error(error)),
                );
                continue;
            }
        };
        for entry in entries {
            let name = entry.file_name();
            let child_relative = if dir_relative.is_empty() {
                name.clone()
            } else {
                format!("{dir_relative}/{name}")
            };
            match entry.file_type() {
                FileType::Dir => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "directory name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    match scan.push_dir(&relative) {
                        Ok(true) => pending.push_back((format!("{dir_remote}/{name}"), relative)),
                        Ok(false) => {}
                        Err(capacity) => return Err(capacity.to_string()),
                    }
                }
                FileType::File => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "file name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    let remote_child = format!("{dir_remote}/{name}");
                    let size = match entry.metadata().size {
                        Some(size) => size,
                        None => {
                            scan.record_failure(
                                &child_relative,
                                "directory listing did not report the file size",
                            );
                            continue;
                        }
                    };
                    if let Err(capacity) = scan.push_file(relative, remote_child, size) {
                        return Err(capacity.to_string());
                    }
                }
                _ => scan.skip(),
            }
        }
    }
    Ok(scan)
}

/// 裸包树扫描（latin-1 模式）：同一通道内 LSTAT 根预检 + READDIR 递归，
/// 整树路径字节保真——远端路径用 wire 转义形式（分块下载按转义自动走
/// raw READ），本地落盘名用 latin-1 解码的显示名。symlink/特殊条目跳过
/// 不跟随（与高层路径同语义），根预检失败整个下载拒绝，子目录失败记录
/// 后继续走。
async fn scan_tree_with_raw(
    client: &mut RawSftpClient,
    root_wire: &str,
) -> Result<sftp_tree::TreeScan, String> {
    let root_raw = sftp_name::unescape_wire(root_wire);
    let attrs = client.lstat(&root_raw).await?;
    let kind = classify_raw_kind(attrs.permissions);
    if kind == "symlink" {
        return Err(
            "Refusing to download a symlink as a folder; download its target instead".to_string(),
        );
    }
    if kind != "directory" {
        return Err("Folder download needs a remote directory".to_string());
    }
    let mut scan = sftp_tree::TreeScan::new();
    // 队列元素：(远端目录原始字节, 远端目录 wire 形式, 本地相对显示路径)。
    let mut pending: VecDeque<(Vec<u8>, String, String)> = VecDeque::new();
    pending.push_back((root_raw, root_wire.to_string(), String::new()));
    while let Some((dir_raw, dir_wire, dir_relative)) = pending.pop_front() {
        let entries = match client.readdir(&dir_raw).await {
            Ok(entries) => entries,
            Err(error) => {
                if dir_relative.is_empty() {
                    return Err(error);
                }
                scan.record_failure(&dir_relative, format!("directory is not readable: {error}"));
                continue;
            }
        };
        for entry in entries {
            if entry.name.as_slice() == b"." || entry.name.as_slice() == b".." {
                continue;
            }
            // 显示相对路径（本地落盘布局）与 wire 远端路径严格分离。
            let display = sftp_name::decode_display_name(&entry.name, NameEncoding::Latin1);
            let child_relative = if dir_relative.is_empty() {
                display.text
            } else {
                format!("{dir_relative}/{}", display.text)
            };
            let child_wire =
                sftp_name::join_wire_name(&dir_wire, &sftp_name::escape_wire(&entry.name));
            match classify_raw_kind(entry.attrs.permissions) {
                "directory" => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "directory name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    match scan.push_dir(&relative) {
                        Ok(true) => pending.push_back((
                            sftp_name::join_raw_path(&dir_raw, &entry.name),
                            child_wire,
                            relative,
                        )),
                        Ok(false) => {}
                        Err(capacity) => return Err(capacity.to_string()),
                    }
                }
                "file" => {
                    let Some(relative) = sftp_tree::sanitize_relative(&child_relative) else {
                        scan.record_failure(
                            &child_relative,
                            "file name is not usable on the local filesystem",
                        );
                        continue;
                    };
                    let Some(size) = entry.attrs.size else {
                        scan.record_failure(
                            &child_relative,
                            "directory listing did not report the file size",
                        );
                        continue;
                    };
                    if let Err(capacity) = scan.push_file(relative, child_wire, size) {
                        return Err(capacity.to_string());
                    }
                }
                _ => scan.skip(),
            }
        }
    }
    Ok(scan)
}

/// 裸包删除单个路径：LSTAT 判型后分派 REMOVE/RMDIR/递归树删（分派语义与
/// 高层 `sftp_delete` 一致；READDIR attrs 是 lstat 语义，目录里的符号链接
/// 按 REMOVE 处理，绝不跟随）。
async fn raw_delete_path(
    client: &mut RawSftpClient,
    raw_path: &[u8],
    recursive: bool,
) -> Result<(), String> {
    let attrs = client.lstat(raw_path).await?;
    match classify_raw_kind(attrs.permissions) {
        "directory" if recursive => raw_delete_tree(client, raw_path).await,
        "directory" => client.rmdir(raw_path).await,
        _ => client.remove(raw_path).await,
    }
}

/// 裸包递归删除：后序遍历（先文件后目录），单通道串行，`.`/`..` 跳过。
async fn raw_delete_tree(client: &mut RawSftpClient, root: &[u8]) -> Result<(), String> {
    let mut pending = vec![root.to_vec()];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        for entry in client.readdir(&directory).await? {
            if entry.name.as_slice() == b"." || entry.name.as_slice() == b".." {
                continue;
            }
            let child = sftp_name::join_raw_path(&directory, &entry.name);
            match classify_raw_kind(entry.attrs.permissions) {
                "directory" => pending.push(child),
                _ => client.remove(&child).await?,
            }
        }
    }
    for directory in directories.into_iter().rev() {
        client.rmdir(&directory).await?;
    }
    Ok(())
}

/// Creates the parent directories for one queued tree file and opens its
/// staging `.part` file. The relative path is re-validated (sanitize +
/// containment) so nothing server-reported can place bytes outside the
/// download root. A stale `.part` from a crashed earlier attempt is replaced,
/// never appended to.
async fn open_tree_sink(root_local: &Path, relative: &str) -> Result<DownloadSink, String> {
    let Some(final_path) = sftp_tree::safe_tree_path(root_local, relative) else {
        return Err("path escapes the download folder".to_string());
    };
    let name = final_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());
    let final_dir = final_path.parent().unwrap_or(root_local).to_path_buf();
    std::fs::create_dir_all(&final_dir).map_err(|error| {
        format!(
            "Failed to create local folder '{}': {error}",
            final_dir.display()
        )
    })?;
    let part_path = final_dir.join(format!("{name}.part"));
    let _ = std::fs::remove_file(&part_path);
    let file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&part_path)
        .await
        .map_err(|error| {
            format!(
                "Failed to create local download file '{}': {error}",
                part_path.display()
            )
        })?;
    Ok(DownloadSink {
        part_path,
        final_dir,
        overwrite: false,
        file: AsyncMutex::new(file),
    })
}

/// Drops the in-flight tree file after a failure: the staging `.part` is
/// deleted so a failed file never leaves partial bytes behind.
fn discard_tree_current(tree: &mut TreeDownloadState) {
    if let Some(sink) = tree.sink.take() {
        let _ = std::fs::remove_file(&sink.part_path);
    }
    tree.current = None;
    tree.current_offset = 0;
}

/// Completes the in-flight tree file: the staging `.part` is flushed and
/// renamed into place. Failures are recorded and the file simply vanishes
/// from the local tree (no partial bytes) while the walk continues.
async fn finalize_tree_current(runtime: &SshRuntime, tree: &mut TreeDownloadState) {
    if let Some(sink) = tree.sink.take() {
        if let Some(file) = tree.current.clone() {
            let name = file
                .relative
                .rsplit('/')
                .next()
                .unwrap_or(&file.relative)
                .to_string();
            match runtime.finalize_download_sink(&sink, &name).await {
                Ok(_) => tree.files_done += 1,
                Err(error) => {
                    let _ = std::fs::remove_file(&sink.part_path);
                    tree.failures
                        .push(json!({ "path": file.relative, "error": error }));
                }
            }
        }
    }
    tree.current = None;
    tree.current_offset = 0;
}

/// Reads an upload spool meta file (`upload-<taskId>.json`). Corrupt or
/// missing files yield `None` — a resume request against them is rejected.
fn read_upload_meta(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

/// Writes an upload spool meta file atomically (tmp + rename, 0600).
fn write_upload_meta(path: &Path, meta: &Value) -> Result<(), String> {
    let text = serde_json::to_string(meta)
        .map_err(|error| format!("Failed to encode upload meta: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// Removes the upload spool meta file when it is no longer resumable.
fn remove_upload_meta(transfer_dir: &Path, task_id: &str) {
    let _ = std::fs::remove_file(transfer_dir.join(format!("upload-{task_id}.json")));
}

/// Scans the transfer directory for interrupted uploads that can still be
/// resumed: a spool file plus its sidecar meta, whose task is not live and
/// whose persisted history row is not terminal-success/cancelled. Pure over
/// (transfer_dir, live task ids) so it is unit-testable without a runtime.
fn resumable_uploads_from(transfer_dir: &Path, live_task_ids: &[String]) -> Vec<Value> {
    let mut tasks = Vec::new();
    let Ok(entries) = std::fs::read_dir(transfer_dir) else {
        return tasks;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(task_id) = name
            .strip_prefix("upload-")
            .and_then(|rest| rest.strip_suffix(".json"))
        else {
            continue;
        };
        if live_task_ids.iter().any(|live| live == task_id) {
            continue;
        }
        let Some(meta) = read_upload_meta(&path) else {
            continue;
        };
        let (Some(remote_path), Some(size)) = (
            meta.get("remotePath").and_then(Value::as_str),
            meta.get("size").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let Ok(spool_len) = std::fs::metadata(transfer_dir.join(format!("upload-{task_id}.part")))
            .map(|meta| meta.len())
        else {
            continue;
        };
        if spool_len == 0 || spool_len > size {
            continue;
        }
        tasks.push(json!({
            "taskId": task_id,
            "direction": "upload",
            "remotePath": remote_path,
            "fileName": remote_path.rsplit('/').next().unwrap_or("upload"),
            "size": size,
            "resumableBytes": spool_len,
        }));
    }
    // Newest meta file first so the picker surfaces the freshest attempt.
    tasks.sort_by(|a, b| {
        b["taskId"]
            .as_str()
            .unwrap_or_default()
            .cmp(a["taskId"].as_str().unwrap_or_default())
    });
    tasks
}

fn remote_transfer_paths(target: &str, task_id: &str) -> Result<(String, String), String> {
    let (parent, _) = target
        .rsplit_once('/')
        .ok_or("Remote upload path has no parent")?;
    let parent = if parent.is_empty() { "/" } else { parent };
    Ok((
        format!(
            "{}/.dbx-upload-{task_id}.part",
            parent.trim_end_matches('/')
        ),
        format!(
            "{}/.dbx-upload-{task_id}.backup",
            parent.trim_end_matches('/')
        ),
    ))
}

/// Permission attributes carried over from an existing target to the staged
/// replacement file: the mode's permission bits (`0o7777`, so an executable
/// script keeps its `+x` across saves) and nothing else. Ownership (uid/gid)
/// is deliberately not preserved — SETSTAT on uid/gid needs elevated
/// privileges, so the replacement keeps the writing user's own ownership.
fn preserved_target_permissions(
    target: &russh_sftp::protocol::FileAttributes,
) -> Option<russh_sftp::protocol::FileAttributes> {
    let permissions = target.permissions?;
    Some(russh_sftp::protocol::FileAttributes {
        permissions: Some(permissions & 0o7777),
        ..Default::default()
    })
}

/// Applies [`preserved_target_permissions`] to the staged file before the
/// rename. A SETSTAT failure aborts the commit with the original target
/// untouched instead of silently saving a permission-downgraded copy (issue
/// #37: an executable script must not lose its `+x` on every save).
pub(crate) async fn apply_preserved_permissions(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: Option<&russh_sftp::protocol::FileAttributes>,
) -> Result<(), String> {
    if let Some(attributes) = target.and_then(preserved_target_permissions) {
        let mode = attributes.permissions.unwrap_or_default();
        if let Err(error) = sftp
            .lock()
            .await
            .set_metadata(temporary.to_string(), attributes)
            .await
        {
            let _ = sftp.lock().await.remove_file(temporary.to_string()).await;
            return Err(format!(
                "SFTP save failed while preserving permissions {}: {error}; original file left unchanged",
                format_permissions(mode),
            ));
        }
    }
    Ok(())
}

async fn commit_remote_file(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: &str,
    backup: &str,
) -> Result<(), String> {
    let target_attributes = sftp.lock().await.metadata(target.to_string()).await.ok();
    apply_preserved_permissions(sftp, temporary, target_attributes.as_ref()).await?;
    let target_exists = target_attributes.is_some();
    if target_exists {
        sftp.lock()
            .await
            .rename(target.to_string(), backup.to_string())
            .await
            .map_err(sftp_error)?;
    }
    if let Err(error) = sftp
        .lock()
        .await
        .rename(temporary.to_string(), target.to_string())
        .await
    {
        if target_exists {
            let _ = sftp
                .lock()
                .await
                .rename(backup.to_string(), target.to_string())
                .await;
        }
        let _ = sftp.lock().await.remove_file(temporary.to_string()).await;
        return Err(sftp_error(error));
    }
    if target_exists {
        let _ = sftp.lock().await.remove_file(backup.to_string()).await;
    }
    Ok(())
}

/// Classifies a READDIR entry into the wire `kind` vocabulary of `sftp/list`.
///
/// russh-sftp derives `FileType` solely from the POSIX type bits in the
/// server-supplied READDIR `permissions` field; a server that omits
/// PERMISSIONS (or sends permissions without type bits — seen on
/// virtual/disk-mount SFTP services) collapses every entry to
/// `FileType::Other`. Issue #36 family: such entries used to be reported as
/// `"other"`, which the UI rendered as a generic text-document icon instead
/// of a file icon.
///
/// Rules:
/// - `Dir` / `File` / `Symlink` pass the server declaration through;
/// - `Other` (missing/unusable type bits) degrades to `"file"`: nothing on
///   the wire distinguishes files from directories at that point, and
///   "unknown renders as a file" matches FileZilla's behaviour. Real
///   directories on conforming servers always carry the DIR type bit, so
///   they never reach this branch.
fn classify_entry_kind(file_type: FileType) -> &'static str {
    match file_type {
        FileType::File => "file",
        FileType::Dir => "directory",
        FileType::Symlink => "symlink",
        FileType::Other => "file",
    }
}

/// 裸包客户端具体类型：每次操作独占一条 sftp 子系统通道，发一收一。
type RawSftpClient = sftp_raw::RawSftp<russh::ChannelStream<russh::client::Msg>>;

/// 裸包客户端路径的 kind 判定：按 v3 permissions 的 POSIX 类型位归类；
/// attrs 缺 permissions（非标准服务器）时退回 file（与高层路径的 Other
/// 语义一致），避免把普通文件误渲染成目录。
fn classify_raw_kind(permissions: Option<u32>) -> &'static str {
    let Some(mode) = permissions else {
        return "file";
    };
    match mode & 0o170000 {
        0o040000 => "directory",
        0o120000 => "symlink",
        _ => "file",
    }
}

fn content_type_for_path(path: &str) -> Option<String> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "txt" | "log" | "md" | "rs" | "ts" | "js" | "json" | "yaml" | "yml" | "toml" | "conf" => {
            "text/plain"
        }
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return None,
    };
    Some(content_type.to_string())
}

fn format_permissions(value: u32) -> String {
    format!("{:04o}", value & 0o7777)
}

/// Budget for the one `ls -l` round trip that upgrades numeric owner ids to
/// names. Generous enough for slow links, still bounded so a wedged shell
/// cannot stall directory listings.
const OWNER_LOOKUP_TIMEOUT_SECS: u64 = 10;

/// Whether an owner/group value still benefits from the `ls -l` name lookup:
/// absent, or a numeric id string (SFTPv3 servers report `0`, `1000`, ...).
fn owner_needs_name(value: &Option<String>) -> bool {
    match value {
        None => true,
        Some(value) => !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
    }
}

/// Overwrites numeric/absent owner/group values on `entries` with names read
/// from one read-only `ls -l` round trip. Best effort by design: no shell,
/// no `ls`, a timeout or unparsable output all leave the listing untouched
/// (numeric ids or absent fields, which the UI renders as "-").
async fn enrich_owner_names(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    entries: &mut [SftpEntry],
) {
    if entries.is_empty() || !entries.iter().any(|entry| owner_needs_name(&entry.owner)) {
        return;
    }
    let session = match runtime.session(session_id).await {
        Ok(session) => session,
        Err(_) => return,
    };
    // GNU renders epoch mtimes with `--time-style=+%s` (same trick sudo_fs
    // uses); BusyBox/BSD reject that option, so a plain `ls -l` retry covers
    // the classic layout. Owner/group sit in fields 3/4 on both.
    let gnu = format!("ls -l --time-style=+%s -- {}", exec::shell_quote(path));
    let output = match exec::exec_plain(
        &session.handle,
        &gnu,
        Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
        &[],
    )
    .await
    {
        Ok(outcome) => outcome.output,
        Err(_) => {
            let plain = format!("ls -l -- {}", exec::shell_quote(path));
            match exec::exec_plain(
                &session.handle,
                &plain,
                Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
                &[],
            )
            .await
            {
                Ok(outcome) => outcome.output,
                Err(_) => return,
            }
        }
    };
    let names = parse_ls_owner_map(&output);
    if names.is_empty() {
        return;
    }
    for entry in entries.iter_mut() {
        if let Some((owner, group)) = names.get(&entry.name) {
            if owner_needs_name(&entry.owner) {
                entry.owner = Some(owner.clone());
            }
            if owner_needs_name(&entry.group) {
                entry.group = Some(group.clone());
            }
        }
    }
}

/// 远程 `stat -c '%U %G' path` 查单个文件的 owner/group 名字。
/// SFTP 协议默认只返回 uid/gid 数字，russh-sftp 的 `Metadata.user/group`
/// 在服务器未开 `username@hostname` 扩展时为 None。此函数作为 stat 的
/// fallback，失败/超时返回 (None, None)，调用方用数字兜底。
pub(crate) async fn lookup_owner_group_names(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
) -> (Option<String>, Option<String>) {
    let session = match runtime.session(session_id).await {
        Ok(s) => s,
        Err(_) => return (None, None),
    };
    let cmd = format!("stat -c '%U %G' -- {}", exec::shell_quote(path));
    let output = match exec::exec_plain(
        &session.handle,
        &cmd,
        Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
        &[],
    )
    .await
    {
        Ok(outcome) => outcome.output,
        Err(_) => return (None, None),
    };
    let mut parts = output.split_whitespace();
    let owner = parts
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let group = parts
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    (owner, group)
}

/// Parses `ls -l` output into `name -> (owner, group)`. Owner/group sit in
/// fields 3/4 of every layout; the name start depends on whether the date
/// collapsed into one epoch field (GNU `--time-style=+%s`, name from field 6)
/// or spread over three classic fields (name from field 8). Returns an empty
/// map for headers (`total`, `ls:` diagnostics) and unparsable rows.
fn parse_ls_owner_map(output: &str) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let line = line.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with("total") || line.starts_with("ls:") {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 7 || fields[0].len() < 10 {
            continue;
        }
        let name_start = if fields[5].parse::<u64>().is_ok() {
            6
        } else {
            8
        };
        if fields.len() <= name_start {
            continue;
        }
        let mut name = fields[name_start..].join(" ");
        // `ls -l` renders symlinks as "name -> target"; keep only the name.
        if let Some((head, _)) = name.split_once(" -> ") {
            name = head.to_string();
        }
        let name = unquote_ls_output_name(&name);
        if name.is_empty() {
            continue;
        }
        map.entry(name)
            .or_insert_with(|| (fields[2].to_string(), fields[3].to_string()));
    }
    map
}

/// Undoes the quoting `ls` applies to unusual names when its stdout is a
/// terminal (possible when `sudo_use_pty` is enabled): shell-escape style
/// renders `weird name's` as `'weird name'\''s'`.
fn unquote_ls_output_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("'\\''", "'");
    }
    trimmed.to_string()
}

fn directory_tracking_marker(session_id: &str) -> Vec<u8> {
    format!("\x1b]777;dbx-directory-ready-{session_id}\x07").into_bytes()
}

fn directory_tracking_script(enabled: bool, session_id: &str, shell: RemoteShell) -> String {
    let marker = format!("\\033]777;dbx-directory-ready-{session_id}\\007");
    let (body, history_flush) = match (shell, enabled) {
        (RemoteShell::Bash, true) => (
            r#"if [ -z "${__DBX_CWD_ACTIVE+x}" ]; then __DBX_CWD_ACTIVE=1; __DBX_OLD_HISTCONTROL_SET=${HISTCONTROL+x}; __DBX_OLD_HISTCONTROL=${HISTCONTROL-}; case ":${HISTCONTROL-}:" in *:ignorespace:*|*:ignoreboth:*) __DBX_HISTORY_NEEDS_DELETE=0 ;; *) __DBX_HISTORY_NEEDS_DELETE=1; HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace" ;; esac; __DBX_OLD_PROMPT_COMMAND=${PROMPT_COMMAND-}; __dbx_emit_cwd(){ printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"; }; PROMPT_COMMAND='__dbx_emit_cwd;'"$__DBX_OLD_PROMPT_COMMAND"; if [ "$__DBX_HISTORY_NEEDS_DELETE" = 1 ]; then history -d $((HISTCMD-1)) 2>/dev/null || true; fi; unset __DBX_HISTORY_NEEDS_DELETE; fi"#,
            "",
        ),
        (RemoteShell::Bash, false) => (
            r#"if [ -n "${__DBX_CWD_ACTIVE+x}" ]; then PROMPT_COMMAND=${__DBX_OLD_PROMPT_COMMAND-}; unset -f __dbx_emit_cwd 2>/dev/null || true; if [ "${__DBX_OLD_HISTCONTROL_SET-}" = x ]; then HISTCONTROL=${__DBX_OLD_HISTCONTROL-}; else unset HISTCONTROL; fi; unset __DBX_CWD_ACTIVE __DBX_OLD_PROMPT_COMMAND __DBX_OLD_HISTCONTROL_SET __DBX_OLD_HISTCONTROL; fi"#,
            "",
        ),
        (RemoteShell::Zsh, true) => (
            r#"if [ -z "${__DBX_CWD_ACTIVE+x}" ]; then __DBX_CWD_ACTIVE=1; if [[ -o HIST_IGNORE_SPACE ]]; then __DBX_OLD_HIST_IGNORE_SPACE=1; else __DBX_OLD_HIST_IGNORE_SPACE=0; setopt HIST_IGNORE_SPACE; fi; __dbx_emit_cwd(){ printf '\033]7;file://%s%s\007' "${HOST:-localhost}" "$PWD"; }; typeset -ga precmd_functions; precmd_functions=(__dbx_emit_cwd ${precmd_functions:#__dbx_emit_cwd}); fi"#,
            " \r",
        ),
        (RemoteShell::Zsh, false) => (
            r#"if [ -n "${__DBX_CWD_ACTIVE+x}" ]; then precmd_functions=(${precmd_functions:#__dbx_emit_cwd}); unfunction __dbx_emit_cwd 2>/dev/null || true; if [[ "${__DBX_OLD_HIST_IGNORE_SPACE-1}" = 0 ]]; then unsetopt HIST_IGNORE_SPACE; fi; unset __DBX_CWD_ACTIVE __DBX_OLD_HIST_IGNORE_SPACE; fi"#,
            " \r",
        ),
        (RemoteShell::Other, _) => ("", ""),
    };
    format!(" {body}; printf '{marker}'\r{history_flush}")
}

impl RemoteShell {
    fn supports_directory_tracking(self) -> bool {
        matches!(self, Self::Bash | Self::Zsh)
    }
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

pub fn filesystem_path(params: &Value) -> Result<String, String> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing filesystem URI".to_string())?;
    path_from_sftp_uri(uri)
}

pub fn connection_id_param(params: &Value) -> Result<&str, String> {
    params
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or("Missing connectionId".to_string())
}

fn sftp_error(error: impl std::fmt::Display) -> String {
    format!("SFTP operation failed: {error}")
}

fn plugin_error(error: PluginError) -> String {
    error.message
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{cipher, kex, mac};

    #[test]
    fn upload_progress_payload_marks_the_phase() {
        let staging = upload_progress_payload(
            "t1",
            "s1",
            Some("a.bin"),
            256,
            1024,
            UploadPhase::Staging,
            "running",
        );
        assert_eq!(staging["phase"], "staging");
        assert_eq!(staging["direction"], "upload");
        assert_eq!(staging["fileName"], "a.bin");
        assert_eq!(staging["transferred"], 256);
        assert_eq!(staging["size"], 1024);
        assert_eq!(staging["status"], "running");

        let pushing = upload_progress_payload(
            "t1",
            "s1",
            None,
            512,
            1024,
            UploadPhase::Uploading,
            "running",
        );
        assert_eq!(pushing["phase"], "uploading");
        // Non-start events carry no fileName; the workbench keeps its own.
        assert!(pushing.get("fileName").is_none());
    }

    #[test]
    fn upload_cancel_error_tells_abort_reasons_apart() {
        assert_eq!(
            upload_cancel_error(Some("user")),
            "Upload cancelled by user"
        );
        assert_eq!(
            upload_cancel_error(Some(" ack-timeout ")),
            "Upload cancelled (ack-timeout)"
        );
        assert_eq!(upload_cancel_error(None), "Upload cancelled");
        assert_eq!(upload_cancel_error(Some("   ")), "Upload cancelled");
    }

    #[test]
    fn numeric_or_absent_owner_values_ask_for_names() {
        assert!(owner_needs_name(&None));
        assert!(owner_needs_name(&Some("0".to_string())));
        assert!(owner_needs_name(&Some("1000".to_string())));
        // Already a name (SFTPv4+ attribute or a previous lookup): no work.
        assert!(!owner_needs_name(&Some("root".to_string())));
        // Defensive: an empty string would render as "-" either way.
        assert!(!owner_needs_name(&Some(String::new())));
    }

    #[test]
    fn parse_ls_owner_map_reads_gnu_epoch_layout() {
        let output = "\
total 20
drwxr-xr-x  3 root root 4096 1720000000 .
drwxr-xr-x  1 root wheel 4096 1720000001 ..
-rw-r--r--  1 alice docker  123 1720000002 notes.txt
drwxr-xr-x  2 root root 4096 1720000003 sub dir with spaces
lrwxrwxrwx  1 root root   11 1720000004 link -> notes.txt
";
        let map = parse_ls_owner_map(output);
        assert_eq!(
            map.get("notes.txt"),
            Some(&("alice".to_string(), "docker".to_string()))
        );
        assert_eq!(
            map.get("sub dir with spaces"),
            Some(&("root".to_string(), "root".to_string()))
        );
        // Symlink arrow is stripped from the name key.
        assert_eq!(
            map.get("link"),
            Some(&("root".to_string(), "root".to_string()))
        );
        // "." / ".." come along but harmless: they never match SftpEntry names.
        assert_eq!(
            map.get("."),
            Some(&("root".to_string(), "root".to_string()))
        );
    }

    #[test]
    fn parse_ls_owner_map_reads_classic_layout() {
        // BusyBox/BSD dates spread over three fields; owner/group stay in
        // fields 3/4 regardless.
        let output = "\
-rw-r--r--    1 root     root          4096 Jan 15 10:23 readme.md
-rw-r--r--    1 svc     deploy          123 Jan 15  2024 old.log
";
        let map = parse_ls_owner_map(output);
        assert_eq!(
            map.get("readme.md"),
            Some(&("root".to_string(), "root".to_string()))
        );
        assert_eq!(
            map.get("old.log"),
            Some(&("svc".to_string(), "deploy".to_string()))
        );
    }

    #[test]
    fn parse_ls_owner_map_ignores_headers_and_noise() {
        assert!(parse_ls_owner_map("").is_empty());
        assert!(parse_ls_owner_map("total 20\n").is_empty());
        assert!(parse_ls_owner_map("ls: cannot open '/x': Permission denied\n").is_empty());
        // A row too short to carry owner/group is dropped, not misparsed.
        assert!(parse_ls_owner_map("-rw-r--r-- 1 x\n").is_empty());
    }

    #[test]
    fn parse_ls_owner_map_keeps_first_row_for_duplicate_names() {
        let output = "\
-rw-r--r--  1 root root 1 1720000000 a.txt
-rw-r--r--  1 amy ops  2 1720000001 a.txt
";
        let map = parse_ls_owner_map(output);
        assert_eq!(
            map.get("a.txt"),
            Some(&("root".to_string(), "root".to_string()))
        );
    }

    #[test]
    fn test_connection_budget_aligns_with_host_deadline() {
        assert_eq!(test_dial_budget_secs(30, true), 29);
        assert_eq!(test_dial_budget_secs(30, false), 9);
        assert_eq!(test_dial_budget_secs(1, true), 1);
    }

    #[test]
    fn next_test_budget_extends_once_for_dialog_path() {
        // Without a host dialog in play the probe keeps the current readable
        // timeout error (1.0 hosts, workbench fallback, exhausted extension).
        assert_eq!(next_test_budget(9, false), None);
        assert_eq!(next_test_budget(29, false), None);
        // Dialog in flight: one extension by the challenge wait plus the
        // connect timeout.
        assert_eq!(
            next_test_budget(9, true),
            Some(HOST_KEY_CHALLENGE_WAIT.as_secs() + 9)
        );
        // A zero stored connect timeout must not shrink the window.
        assert_eq!(
            next_test_budget(0, true),
            Some(HOST_KEY_CHALLENGE_WAIT.as_secs())
        );
    }

    #[test]
    fn classify_entry_kind_maps_wire_types() {
        // Directories stay directories; only `kind === "directory"` renders a
        // folder icon in the UI.
        assert_eq!(classify_entry_kind(FileType::Dir), "directory");
        assert_eq!(classify_entry_kind(FileType::File), "file");
        assert_eq!(classify_entry_kind(FileType::Symlink), "symlink");
        // Missing/unusable type bits (no PERMISSIONS flag, or permissions
        // without S_IFMT bits) must degrade to a file icon, never a folder.
        assert_eq!(classify_entry_kind(FileType::Other), "file");
    }

    #[test]
    fn test_timeout_message_names_budget_source_and_remedy() {
        let explicit = test_timeout_message("dbx-ssh-test", 22, 29, false, false);
        assert_eq!(
            explicit,
            "SSH connection to dbx-ssh-test:22 timed out after 29 seconds. Increase 'SSH timeout' under Advanced options and retry."
        );
        let fallback = test_timeout_message("dbx-ssh-test", 22, 9, true, false);
        assert!(
            fallback.contains("timed out after 9 seconds (host default)"),
            "{fallback}"
        );
        assert!(
            fallback.contains("Increase 'SSH timeout' under Advanced options"),
            "{fallback}"
        );
    }

    #[test]
    fn test_timeout_message_names_pending_host_key_confirmation() {
        let base = test_timeout_message("h", 22, 9, true, false);
        assert!(base.contains("timed out after 9 seconds (host default)"));
        assert!(base.contains("Increase 'SSH timeout'"));

        let with_challenge = test_timeout_message("h", 22, 9, false, true);
        assert!(with_challenge.contains("host-key confirmation"));
        assert!(!with_challenge.contains("(host default)"));
    }

    #[test]
    fn replay_buffer_is_sequence_addressable() {
        let mut replay = ReplayBuffer::default();
        replay.push(TerminalStream::Stdout, b"one".to_vec());
        replay.push(TerminalStream::Stderr, b"two".to_vec());
        let frames = replay.after(1);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 2);
    }

    #[test]
    fn replay_buffer_honours_a_custom_byte_budget() {
        // 串口会话的 128 KiB 预算（设计稿 §3）：绕回后 first_sequence 前移，
        // after() 只回可得的尾部，complete 语义随 first_available 变化。
        let mut replay = ReplayBuffer::with_byte_limit(8);
        replay.push(TerminalStream::Stdout, b"12345".to_vec());
        replay.push(TerminalStream::Stdout, b"67890".to_vec());
        assert_eq!(replay.first_sequence(), 2, "frame 1 was evicted");
        assert_eq!(replay.tail_sequence(), 2);
        assert!(replay.after(0).iter().all(|frame| frame.sequence >= 2));
        // afterSequence+1 >= first_available → complete。
        assert!(
            replay.after(1).len() == 1,
            "replaying from 1 yields the surviving frame"
        );
        // 默认预算仍是共享的 2 MiB 上限。
        let replay = ReplayBuffer::default();
        let serialized = format!("{:?}", replay.byte_limit);
        assert_eq!(serialized, format!("{TERMINAL_REPLAY_LIMIT}"));
    }

    #[test]
    fn terminal_input_enqueue_applies_backpressure_instead_of_dropping() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender
            .try_send(TerminalCommand::Input(b"first".to_vec()))
            .expect("seed the bounded queue");

        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let blocked_sender = sender.clone();
        std::thread::spawn(move || {
            let result = enqueue_terminal_input(&blocked_sender, b"second".to_vec());
            done_sender.send(result).expect("report enqueue result");
        });

        assert!(done_receiver
            .recv_timeout(std::time::Duration::from_millis(25))
            .is_err());
        assert!(matches!(
            receiver.try_recv(),
            Ok(TerminalCommand::Input(data)) if data == b"first"
        ));
        assert_eq!(
            done_receiver
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap(),
            Ok(())
        );
        assert!(matches!(
            receiver.try_recv(),
            Ok(TerminalCommand::Input(data)) if data == b"second"
        ));
    }

    #[test]
    fn negotiated_algorithms_cover_legacy_without_weakening_secure_order() {
        // 存量连接可能还带着已下线的 ssh_algorithm_profile/policy 配置值；
        // 算法面已统一，任何旧值都不得改变协商集合。
        let connection = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "unified-algos",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret",
                "external_config": { "ssh_algorithm_profile": "legacy" }
            }
        }))
        .unwrap();
        let config = ssh_client_config(&connection);
        assert_eq!(config.preferred.mac.first(), Some(&mac::HMAC_SHA512_ETM));
        assert!(config.preferred.mac.contains(&mac::HMAC_SHA1));
        assert!(config.preferred.kex.contains(&kex::DH_G1_SHA1));
        assert!(config.preferred.cipher.contains(&cipher::AES_128_CBC));
        assert!(config.preferred.cipher.contains(&cipher::TRIPLE_DES_CBC));
        assert_eq!(config.gex.min_group_size(), 2048);
        assert_eq!(config.gex.preferred_group_size(), 3072);
        assert_eq!(config.gex.max_group_size(), 8192);
    }

    // —— 私钥来源解析：粘贴内容优先于路径（connection_secrets.private_key）———

    fn key_connection(path: &str, content: &str) -> StoredConnection {
        StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "key-resolve",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": {
                    "authentication": "private-key",
                    "private_key_path": path
                },
                "connection_secrets": { "private_key": content }
            }
        }))
        .unwrap()
    }

    #[test]
    fn private_key_text_normalizes_carriage_returns() {
        assert_eq!(
            normalize_private_key_text("a\r\nb\rc\nd"),
            "a\nb\nc\nd".to_string()
        );
        assert_eq!(normalize_private_key_text("plain\n"), "plain\n".to_string());
    }

    #[test]
    fn private_key_text_normalizes_windows_bom_and_leading_whitespace() {
        let key = "\u{feff} \r\n-----BEGIN PRIVATE KEY-----\r\n\
            MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\r\n\
            -----END PRIVATE KEY-----\r\n";
        let normalized = normalize_private_key_text(key);

        assert!(normalized.starts_with("-----BEGIN PRIVATE KEY-----\n"));
        assert!(!normalized.contains('\r'));
        assert!(decode_secret_key(&normalized, None).is_ok());
    }

    // —— #21: 私钥解码错误分类与粘贴污损修复 ————————————————————————————
    // 以下密钥全部为本仓库测试现场生成的废弃密钥或 ssh-key 上游公开测试
    // fixture,绝不包含真实凭据。口令仅为测试值。

    /// 废弃测试密钥(本机为编写测试生成,无对应主机)。
    const OPENSSH_ED25519_PLAIN: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDkhRLM2wxmY826/LvkQeMRNf9pptlryFMSddhmTmhSrwAAAJiaGi/pmhov
6QAAAAtzc2gtZWQyNTUxOQAAACDkhRLM2wxmY826/LvkQeMRNf9pptlryFMSddhmTmhSrw
AAAEA41GJvRrU3mTnSyjUyLinDInc6VUNdHcvGr1te4YW7S+SFEszbDGZjzbr8u+RB4xE1
/2mm2WvIUxJ12GZOaFKvAAAADm1hdHJpeC1lZDI1NTE5AQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----";

    /// 同上,口令为 "test-phrase"。
    const OPENSSH_ED25519_ENCRYPTED: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAd8e+k64
ZPDgMURR64zer1AAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIMcQDHXhSWOHA0pR
VYE3X8bEgjf0QVAcOzZ+6mZKzIa/AAAAoLKviiOSbTqOH2s7O+Y2AxZzne4kYYb0uZhpHH
eGHpS7VjhQLlN/B1cgyfNWqdROswIXdPbDL1uC5nzv8MAvH4lEobnNgZWVaxKoIAyTP3v+
c/3nQJQxJ1klouO/ojHcFFumbY4C+lRMGRhPIvtDj1alq5lvefD/3VmtK/jbeA8zuXcdv9
1QXkLgYJ5A3wpFPs7x/jgDn/v3e6jAwfZoZLU=
-----END OPENSSH PRIVATE KEY-----";

    const ENCRYPTED_TEST_PASSPHRASE: &str = "test-phrase";

    /// ssh-key 上游公开测试 fixture(user@example.com,无口令)。
    const PPK3_ED25519_PLAIN: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Private-Lines: 1
AAAAILYGwiLRDBba4WxwpNRRc0cuxhfgXGVpINJuVsCPtZHt
Private-MAC: 94140d0344fad6aa1bf7b71e9c93db11ccac8a232f8a51e11c024869d608c82d";

    /// 同一上游 fixture,口令为 "123"。
    const PPK3_ED25519_ENCRYPTED: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 34
Argon2-Parallelism: 1
Argon2-Salt: 63d1d43f7bf7700720496646a2f5ec17
Private-Lines: 1
DyWtExZ3dxFutnb12tIwXBC6kWdozrvP+r6faHKBGDb4+qEar9XBiC0BmGySMHUi
Private-MAC: 52fd00d4ef47ebc506e4e709486c0c6bc0606e24fe2c6cb1b3d168f4da238a66";

    /// 废弃测试密钥(SEC1 传统 EC PEM,russh 不支持此封装)。
    const EC_SEC1_PEM: &str = "\
-----BEGIN EC PRIVATE KEY-----
MIIBaAIBAQQgOtPbXkrREPIS68niEPbISV5VZmM4655BvEie7U9k/4CggfowgfcC
AQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////////
MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT57Pr
vVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEE
axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54W
K84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5ysL8
YyVRAgEBoUQDQgAERtRtbHHreGHq8c0a0GvFRsZ+3BfCcILOVeIpInh5O9ddBZQI
Q/TyBph+JFB6VjJb6neA04jwsdD13REn2e7/og==
-----END EC PRIVATE KEY-----";

    /// 废弃测试密钥(PKCS#8 + PBES2/hmacWithSHA256,口令 "test-phrase";
    /// russh 的 PKCS#5 解析不支持该 PRF)。
    const PKCS8_PBES2_ENCRYPTED: &str = "\
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIICzzBJBgkqhkiG9w0BBQ0wPDAbBgkqhkiG9w0BBQwwDgQIOcKjFZoZ/fsCAggA
MB0GCWCGSAFlAwQBAgQQTfxxn8bDf+3cTfXy9sHVtgSCAoBF4F4/74FYKIDBbFxE
BXPvQRgnRTL6FWGD983/u9CueKi26cAty4N75cDEPwbq4xk/DMGhQTiSymv4SOK3
MBgZ/hb8jHWIp8SrZ2IvP14uM/EsVAvLgmnlu8JH/Q4BfYLbo4tvY88Wwx93GXdW
Ik6S30w+iDo/BTZ7by9mFITWD3DcIYpsrCgmn/MhQ/cRy7Eoe4wkMruMsY4aG4Tb
K1gDN/dLL/jrafcwDx1sjA71BmVf0bNKR9CBk1sZ5i5d4D0YSFRI4t8TG15cjb/l
NQwi9ykch3t6ojtQvHT645Z8kiTYjfPEyqgEWtSZd+69QAJ0Gl1XEqb+kH7eyMOL
oyMOfoX+Z3cEHCNY5/FZvFUTLmVX+OjzYY34LvzoSICeCr7HE+cnkRBEdpbLgyw9
LPlnpp7RWOXr8pidnr7vg7tN6sWnqM8JwPubDgl2gE1jUiqKHSWXHq6kEVEVA9Y4
uRBKE24j+FrPYGRjoKVXyPX0gjhqp66GDGaBCWs7LzdFO10IPxDKM6GJ8AxKLk9X
UVXqyvDfC9lh6YAHmTKmNYnKkEijdKkP7Uw57n8aWr1tw5xLyhABLZEGhPLcyazN
z7fnjJ+3LAEqD5dlZaczncsdFmZh1naKswCmSrwZOEbAeGbaZvdsHqspYwXGBTna
Q+KW8/vygV6WQZLnVu36rIkJq56Hzo3JFo3p2GOY/Pk1o82xFTm/fS3Pm3FWoapa
SiK9nBQ20ok8efOFN535UDWrmOMKcZTF/ZgpjKPCPFwaDFlpgtbWbUW+1ABMYv4g
GkWbTKmDiaAreK3qjVWf20UuzxzSFk/QS1dxTHoNv8NsvWAJp7AZv2WV6Bj+k9Is
sfwQ
-----END ENCRYPTED PRIVATE KEY-----";

    /// 与 OPENSSH_ED25519_PLAIN 同钥的公钥单行形态(误粘场景)。
    const ED25519_PUBLIC_ONELINER: &str = "\
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOSFEszbDGZjzbr8u+RB4xE1/2mm2WvIUxJ12GZOaFKv \
matrix-ed25519";

    fn decode_error_of(text: &str, passphrase: Option<&str>) -> russh::keys::Error {
        decode_secret_key(text, passphrase).expect_err("sample must fail to decode")
    }

    fn assert_actionable(text: &str, error: &russh::keys::Error, provided: bool, guidance: &str) {
        let message = private_key_decode_failure(text, error, provided);
        assert!(
            message.starts_with("Failed to decode SSH private key: "),
            "{message}"
        );
        // 底层错误永远原样保留,不吞细节。
        assert!(
            message.contains(&format!("(decoder error: {error})")),
            "{message}"
        );
        assert!(message.contains(guidance), "{message}");
    }

    #[test]
    fn paste_artifacts_are_normalized_and_then_decode() {
        let cases: Vec<(&str, String)> = vec![
            (
                "marker trailing space",
                OPENSSH_ED25519_PLAIN.replace(
                    "-----BEGIN OPENSSH PRIVATE KEY-----",
                    "-----BEGIN OPENSSH PRIVATE KEY----- ",
                ),
            ),
            (
                "marker inner double space",
                OPENSSH_ED25519_PLAIN.replace(
                    "-----BEGIN OPENSSH PRIVATE KEY-----",
                    "-----BEGIN  OPENSSH  PRIVATE  KEY-----",
                ),
            ),
            (
                "smart dashes",
                OPENSSH_ED25519_PLAIN
                    .replace("-----BEGIN", "——–BEGIN")
                    .replace("-----END", "——–END"),
            ),
            ("zero-width characters", {
                let mut text = OPENSSH_ED25519_PLAIN
                    .replace("-----BEGIN OPENSSH", "-----\u{200b}BEGIN\u{200b} OPENSSH");
                text.insert(40, '\u{200b}');
                text
            }),
            (
                "web-page <br> tags",
                OPENSSH_ED25519_PLAIN
                    .replace('\n', "<br>\n")
                    .replacen("<br>", "<BR>", 1),
            ),
            ("re-wrapped body lines", {
                let mut lines: Vec<String> =
                    OPENSSH_ED25519_PLAIN.lines().map(str::to_string).collect();
                lines[1].insert_str(24, "  ");
                lines[2].insert(24, '\t');
                lines.join("\n")
            }),
            (
                "crlf plus bom plus indent",
                format!(
                    "\u{feff}   \r\n{}\r\n",
                    OPENSSH_ED25519_PLAIN.replace('\n', "\r\n")
                ),
            ),
        ];
        for (label, polluted) in &cases {
            let normalized = normalize_private_key_text(polluted);
            let decoded = decode_secret_key(&normalized, None);
            assert!(decoded.is_ok(), "{label}: {normalized:?}");
        }
    }

    #[test]
    fn paste_artifact_normalization_preserves_directive_lines() {
        // PKCS#5 传统加密 PEM 的 DEK-Info 指令行必须原样保留(含 IV 十六进制)。
        let text = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\
            DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF \n\nabc= \n\
            -----END RSA PRIVATE KEY-----\n";
        let normalized = normalize_private_key_text(text);
        assert!(normalized.contains("DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n"));
        assert!(normalized.contains("Proc-Type: 4,ENCRYPTED\n"));
        assert!(normalized.contains("\nabc=\n"));
    }

    #[test]
    fn decode_errors_are_classified_into_actionable_guidance() {
        // 加密 OpenSSH 密钥、未填口令。
        assert_actionable(
            OPENSSH_ED25519_ENCRYPTED,
            &decode_error_of(OPENSSH_ED25519_ENCRYPTED, None),
            false,
            "fill in the private key passphrase field",
        );
        // 加密 OpenSSH 密钥、口令错误。
        assert_actionable(
            OPENSSH_ED25519_ENCRYPTED,
            &decode_error_of(OPENSSH_ED25519_ENCRYPTED, Some("wrong-phrase")),
            true,
            "did not decrypt with the stored passphrase",
        );
        // 公钥单行形态被误当私钥。
        assert_actionable(
            ED25519_PUBLIC_ONELINER,
            &decode_error_of(ED25519_PUBLIC_ONELINER, None),
            false,
            "looks like a PUBLIC key or certificate",
        );
        assert_actionable(
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----",
            &decode_error_of(
                "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----",
                None,
            ),
            false,
            "looks like a PUBLIC key or certificate",
        );
        // 完全不是密钥文本。
        assert_actionable(
            "hello world, this is not a key",
            &decode_error_of("hello world, this is not a key", None),
            false,
            "no PEM private-key header",
        );
        // HTML 转义污染(无法自动修复,指引重新复制)。
        let html_escaped = "&lt;p&gt;-----BEGIN OPENSSH PRIVATE KEY-----&lt;/p&gt;";
        assert_actionable(
            html_escaped,
            &decode_error_of(html_escaped, None),
            false,
            "looks HTML-escaped",
        );
        // BEGIN 存在但标记无法修复(类型名内部断行)。
        let broken_marker =
            "-----BEGIN OPENSSH PRIVATE-KEY-----\nbody\n-----END OPENSSH PRIVATE-KEY-----";
        assert_actionable(
            broken_marker,
            &decode_error_of(broken_marker, None),
            false,
            "mangled by rich-text copy",
        );
        // SEC1 传统 EC PEM 自 russh 0.62 起已可直接解码，改归有效密钥用例。
        // PKCS#8 + 不支持的 PBKDF2 PRF。
        assert_actionable(
            PKCS8_PBES2_ENCRYPTED,
            &decode_error_of(PKCS8_PBES2_ENCRYPTED, Some(ENCRYPTED_TEST_PASSPHRASE)),
            true,
            "PBKDF2 variant",
        );
        // PuTTY PPK 加密、未填口令。
        assert_actionable(
            PPK3_ED25519_ENCRYPTED,
            &decode_error_of(PPK3_ED25519_ENCRYPTED, None),
            false,
            "this PuTTY PPK key is encrypted",
        );
        // PuTTY PPK 口令错误(MAC 校验失败)。
        assert_actionable(
            PPK3_ED25519_ENCRYPTED,
            &decode_error_of(PPK3_ED25519_ENCRYPTED, Some("wrong")),
            true,
            "the passphrase appears to be incorrect",
        );
        // PuTTY PPK 结构损坏。
        let corrupt_ppk = PPK3_ED25519_PLAIN.replace("Public-Lines: 2", "Public-Lines: 3");
        assert_actionable(
            &corrupt_ppk,
            &decode_error_of(&corrupt_ppk, None),
            false,
            "export it from PuTTYgen",
        );
        // base64 主体损坏(终端复制插空格、未走归一化的原始文本)。
        let mut lines: Vec<&str> = OPENSSH_ED25519_PLAIN.lines().collect();
        let mut second = lines[1].to_string();
        second.insert(20, ' ');
        lines[1] = &second;
        let spaced_body = lines.join("\n");
        assert_actionable(
            &spaced_body,
            &decode_error_of(&spaced_body, None),
            false,
            "not valid base64",
        );
        // 兜底:未知错误仍保留原文,只加一句说明。
        let junk_key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
        assert_actionable(
            junk_key,
            &decode_error_of(junk_key, None),
            false,
            "the key could not be decoded",
        );
    }

    #[test]
    fn valid_keys_still_decode_after_normalization() {
        assert!(
            decode_secret_key(&normalize_private_key_text(OPENSSH_ED25519_PLAIN), None).is_ok()
        );
        assert!(decode_secret_key(
            &normalize_private_key_text(OPENSSH_ED25519_ENCRYPTED),
            Some(ENCRYPTED_TEST_PASSPHRASE)
        )
        .is_ok());
        assert!(decode_secret_key(&normalize_private_key_text(PPK3_ED25519_PLAIN), None).is_ok());
        assert!(decode_secret_key(
            &normalize_private_key_text(PPK3_ED25519_ENCRYPTED),
            Some("123")
        )
        .is_ok());
        // russh 0.62 起支持 SEC1 传统 EC PEM，不再作为解码失败场景。
        assert!(decode_secret_key(&normalize_private_key_text(EC_SEC1_PEM), None).is_ok());
        assert!(!looks_like_public_key(OPENSSH_ED25519_PLAIN));
        assert!(looks_like_public_key(ED25519_PUBLIC_ONELINER));
    }

    #[tokio::test]
    async fn pasted_key_content_wins_over_key_path() {
        // 路径指向不存在的文件也能取到内容：content 非空时不碰文件系统。
        let connection = key_connection(
            "/definitely/missing/id_test",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        let text = resolve_private_key_text(&connection).await.unwrap();
        assert!(text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(text.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
    }

    #[tokio::test]
    async fn key_path_fallback_reads_and_normalizes_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf_key");
        std::fs::write(
            &path,
            "-----BEGIN OPENSSH PRIVATE KEY-----\r\nbody\r\n-----END OPENSSH PRIVATE KEY-----\r\n",
        )
        .unwrap();
        let connection = key_connection(&path.display().to_string(), "");
        let text = resolve_private_key_text(&connection).await.unwrap();
        assert!(text.contains("\nbody\n"));
        assert!(!text.contains('\r'));
    }

    #[tokio::test]
    async fn missing_key_without_content_reports_the_path() {
        let connection = key_connection("/definitely/missing/id_test", "");
        let error = resolve_private_key_text(&connection).await.unwrap_err();
        assert!(error.contains("Failed to read SSH private key"), "{error}");
    }

    // —— F1: 断点续传（spool meta / resume 校验 / resumable 扫描）———

    fn temp_transfer_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-ssh-resume-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spool_fixture(dir: &Path, task_id: &str, remote_path: &str, size: u64, received: u64) {
        std::fs::write(
            dir.join(format!("upload-{task_id}.part")),
            vec![b'x'; received as usize],
        )
        .unwrap();
        write_upload_meta(
            &dir.join(format!("upload-{task_id}.json")),
            &json!({ "remotePath": remote_path, "size": size }),
        )
        .unwrap();
    }

    #[test]
    fn upload_meta_roundtrips_and_rejects_corruption() {
        let dir = temp_transfer_dir();
        let path = dir.join("upload-t1.json");
        write_upload_meta(&path, &json!({ "remotePath": "/srv/a.bin", "size": 9 })).unwrap();
        let meta = read_upload_meta(&path).unwrap();
        assert_eq!(meta["remotePath"], "/srv/a.bin");
        assert_eq!(meta["size"], 9);
        std::fs::write(&path, "{broken").unwrap();
        assert!(read_upload_meta(&path).is_none());
        assert!(read_upload_meta(&dir.join("missing.json")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_spool_validation_matches_meta() {
        let dir = temp_transfer_dir();
        // SshRuntime's transfer spool lives under <data_dir>/transfers.
        let transfer_dir = dir.join("transfers");
        std::fs::create_dir_all(&transfer_dir).unwrap();
        let runtime = SshRuntime::new(dir.clone());
        spool_fixture(&transfer_dir, "t1", "/srv/a.bin", 100, 40);
        // Matching request resumes at the spooled length.
        let (path, offset) = runtime.open_resume_spool("t1", "/srv/a.bin", 100).unwrap();
        assert_eq!(offset, 40);
        assert!(path.ends_with("upload-t1.part"));
        // Mismatched size / remote path / missing meta are refused.
        assert!(runtime.open_resume_spool("t1", "/srv/a.bin", 99).is_err());
        assert!(runtime
            .open_resume_spool("t1", "/srv/other.bin", 100)
            .is_err());
        assert!(runtime
            .open_resume_spool("gone", "/srv/a.bin", 100)
            .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resumable_scan_lists_only_live_pending_uploads() {
        let dir = temp_transfer_dir();
        let transfer_dir = dir.join("transfers");
        std::fs::create_dir_all(&transfer_dir).unwrap();
        spool_fixture(&transfer_dir, "t-resume", "/srv/a.bin", 100, 40);
        spool_fixture(&transfer_dir, "t-live", "/srv/b.bin", 100, 10);
        // Empty spool, oversized spool, and meta-less files are skipped.
        spool_fixture(&transfer_dir, "t-empty", "/srv/c.bin", 100, 0);
        spool_fixture(&transfer_dir, "t-over", "/srv/d.bin", 10, 40);
        std::fs::write(transfer_dir.join("upload-t-nometa.part"), b"data").unwrap();
        std::fs::write(transfer_dir.join("upload-t-nospool.json"), "{}").unwrap();
        let tasks = resumable_uploads_from(&transfer_dir, &["t-live".to_string()]);
        assert_eq!(tasks.len(), 1, "only t-resume qualifies: {tasks:?}");
        assert_eq!(tasks[0]["taskId"], "t-resume");
        assert_eq!(tasks[0]["remotePath"], "/srv/a.bin");
        assert_eq!(tasks[0]["fileName"], "a.bin");
        assert_eq!(tasks[0]["size"], 100);
        assert_eq!(tasks[0]["resumableBytes"], 40);
        // A missing transfer dir yields an empty list, not an error.
        assert!(resumable_uploads_from(Path::new("/nonexistent-dbx-ssh"), &[]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 连接表单的 sudo_source 三选一决定生效的全局配置：off 从不提升；
    /// custom 只沿用工作台绑定（0.4.x 兼容）；global 先按表单引用解析，
    /// 再回落绑定；引用无法解析时退化为无配置而不是失败连接。
    #[test]
    fn effective_sudo_profile_follows_declared_source() {
        let parse = |external_config: Value| {
            StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "conn-src",
                    "host": "example.com",
                    "port": 22,
                    "username": "user",
                    "password": "login",
                    "external_config": external_config
                }
            }))
            .unwrap()
        };
        let mut store = sudo_profiles::SudoProfileStore::default();
        let (profile, _) = sudo_profiles::save_profile(
            &mut store,
            &serde_json::json!({ "name": "ops", "sudoPassword": "p" }),
        )
        .unwrap();
        store
            .bindings
            .insert("conn-src".to_string(), profile.id.clone());

        let off = parse(serde_json::json!({ "sudo_source": "off" }));
        assert!(effective_sudo_profile(&off, &store).is_none());

        let custom = parse(serde_json::json!({ "sudo_source": "custom" }));
        assert_eq!(
            effective_sudo_profile(&custom, &store).unwrap().id,
            profile.id
        );

        let global_ref =
            parse(serde_json::json!({ "sudo_source": "global", "sudo_profile": "ops" }));
        assert_eq!(
            effective_sudo_profile(&global_ref, &store).unwrap().id,
            profile.id
        );
        let global_empty = parse(serde_json::json!({ "sudo_source": "global" }));
        assert_eq!(
            effective_sudo_profile(&global_empty, &store).unwrap().id,
            profile.id
        );

        // 引用未知配置时回落绑定；绑定也移除后退化为无配置。
        let ghost = parse(serde_json::json!({ "sudo_source": "global", "sudo_profile": "ghost" }));
        assert_eq!(
            effective_sudo_profile(&ghost, &store).unwrap().id,
            profile.id
        );
        store.bindings.remove("conn-src");
        assert!(effective_sudo_profile(&ghost, &store).is_none());
    }

    /// Stress test: 5 MiB of continuous terminal output through the 2 MiB
    /// ring buffer. The buffer must stay pinned at the cap, keep sequence
    /// addressing contiguous (so replay `complete` stays exact), and hand
    /// back only the newest 2 MiB.
    #[test]
    fn replay_buffer_stress_keeps_five_megabytes_within_the_cap() {
        const CHUNK: usize = 64 * 1024;
        const TOTAL: usize = 5 * 1024 * 1024;
        let mut replay = ReplayBuffer::default();
        let pushes = TOTAL / CHUNK;
        for index in 0..pushes {
            let mut chunk = vec![b'x'; CHUNK];
            chunk[0] = b'a' + (index % 26) as u8;
            replay.push(TerminalStream::Stdout, chunk);
            assert!(
                replay.bytes <= TERMINAL_REPLAY_LIMIT,
                "buffer exceeded the cap at push {index}"
            );
        }
        // The buffer holds exactly the newest 2 MiB, not the full 5 MiB.
        assert_eq!(replay.bytes, TERMINAL_REPLAY_LIMIT);
        let first = replay.first_sequence();
        assert_eq!(first as usize, pushes - TERMINAL_REPLAY_LIMIT / CHUNK + 1);

        let frames = replay.after(0);
        let bytes: usize = frames.iter().map(|frame| frame.data.len()).sum();
        assert_eq!(bytes, TERMINAL_REPLAY_LIMIT);
        assert_eq!(frames.first().unwrap().sequence, first);
        // Sequence addressing stays contiguous after the eviction ramp.
        for pair in frames.windows(2) {
            assert_eq!(pair[1].sequence, pair[0].sequence + 1);
        }
        assert_eq!(frames.last().unwrap().sequence, replay.sequence);
        // after(first-1) returns the whole retained tail; older queries stay
        // empty, which is what drives replay `complete == false`.
        assert_eq!(replay.after(first - 1).len(), frames.len());
        assert!(replay.after(replay.sequence).is_empty());
    }

    #[test]
    fn transfer_paths_stay_next_to_target() {
        let (temporary, backup) = remote_transfer_paths("/home/user/file.txt", "task").unwrap();
        assert_eq!(temporary, "/home/user/.dbx-upload-task.part");
        assert_eq!(backup, "/home/user/.dbx-upload-task.backup");
    }

    /// `sudo/profiles/options` backs the connection form's dynamic dropdown:
    /// value = profile id (what `sudo_profile` stores), label = display name,
    /// sorted like the listings, and never any secret field.
    #[test]
    fn profile_options_expose_id_name_pairs_without_secrets() {
        let dir =
            std::env::temp_dir().join(format!("dbx-profile-options-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let runtime = SshRuntime::new(dir.clone());
        let mut store = sudo_profiles::SudoProfileStore::default();
        let (_, _) = sudo_profiles::save_profile(
            &mut store,
            &json!({ "name": "zeta", "sudoPassword": "secret-z" }),
        )
        .unwrap();
        let (alpha, _) = sudo_profiles::save_profile(
            &mut store,
            &json!({ "name": "alpha", "sudoPassword": "secret-a" }),
        )
        .unwrap();
        // Keyfile injection: the production save_store would probe the real
        // macOS keychain from a test; the envelope then resolves reads to the
        // same keyfile, so the runtime path below stays keychain-free too.
        sudo_profiles::save_store_with(
            &dir,
            &store,
            &crate::vault::KeyfileProvider::new(crate::vault::keyfile_path(&dir)),
        )
        .unwrap();

        let payload = runtime.profiles_options();
        let options = payload["options"].as_array().unwrap();
        assert_eq!(options.len(), 2);
        assert_eq!(options[0]["label"], json!("alpha"));
        assert_eq!(options[0]["value"], json!(alpha.id));
        assert_eq!(options[1]["label"], json!("zeta"));
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(!rendered.contains("secret-z") && !rendered.contains("secret-a"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cached_metrics_payload_marks_age_without_mutating_the_snapshot() {
        let snapshot = json!({ "loadAverage": 0.4, "network": [] });
        let payload = cached_metrics_payload(&snapshot, 1_700_000_123);
        assert_eq!(payload["loadAverage"], json!(0.4));
        assert_eq!(payload["cachedAt"], json!(1_700_000_123));
        // The stored snapshot stays clean of the marker.
        assert!(snapshot.get("cachedAt").is_none());
    }

    #[test]
    fn metrics_snapshot_cache_serves_and_cleans_per_session() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        let snapshot = json!({ "loadAverage": 1.25 });

        assert!(runtime.cached_metrics_snapshot("sess-1").is_none());

        runtime.store_metrics_snapshot("sess-1", &snapshot);
        runtime.store_metrics_snapshot("sess-2", &json!({ "loadAverage": 2.5 }));

        let served = runtime.cached_metrics_snapshot("sess-1").expect("cached");
        assert_eq!(served["loadAverage"], json!(1.25));
        assert!(served["cachedAt"].is_u64(), "cachedAt must be unix seconds");
        // Sessions are independent: the second session serves its own data.
        let other = runtime.cached_metrics_snapshot("sess-2").expect("cached");
        assert_eq!(other["loadAverage"], json!(2.5));

        // Session close semantics drop only that session's entry.
        if let Ok(mut cache) = runtime.metrics_cache.lock() {
            cache.remove("sess-1");
        }
        assert!(runtime.cached_metrics_snapshot("sess-1").is_none());
        assert!(runtime.cached_metrics_snapshot("sess-2").is_some());
    }

    #[test]
    fn session_info_payload_carries_identity_and_liveness() {
        let endpoint = ConnectionEndpoint {
            host: "prod-01".to_string(),
            port: 2222,
            username: "ops".to_string(),
        };
        let row = session_info_payload(
            "sess-1",
            "conn-1",
            "wb-1",
            true,
            true,
            true,
            90,
            1_700_000_123,
            "private-key",
            &endpoint,
            false,
        );
        assert_eq!(row["recording"], false);
        assert_eq!(row["sessionId"], json!("sess-1"));
        assert_eq!(row["connectionId"], json!("conn-1"));
        assert_eq!(row["workbenchId"], json!("wb-1"));
        assert_eq!(row["readOnly"], json!(true));
        assert_eq!(row["connected"], json!(true));
        assert_eq!(row["sudoKeepalive"], json!(true));
        assert_eq!(row["terminalKeepaliveSecs"], json!(90));
        assert_eq!(row["createdAt"], json!(1_700_000_123));
        assert_eq!(row["authMethod"], json!("private-key"));
        assert_eq!(row["host"], json!("prod-01"));
        assert_eq!(row["port"], json!(2222));
        assert_eq!(row["username"], json!("ops"));
        // No secrets leak through the inventory payload.
        let serialized = row.to_string();
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("passphrase"));
        assert!(!serialized.contains("privateKeyMaterial"));
    }

    #[test]
    fn batch_input_payload_normalizes_newlines_and_bounds_size() {
        assert_eq!(
            SshRuntime::batch_input_payload("df -h", true),
            b"df -h\r".to_vec()
        );
        assert_eq!(
            SshRuntime::batch_input_payload("df -h", false),
            b"df -h".to_vec()
        );
        // Every newline flavour becomes one Enter.
        assert_eq!(
            SshRuntime::batch_input_payload("a\nb\r\nc\rd", true),
            b"a\rb\rc\rd\r".to_vec()
        );
        // Oversized commands are truncated, never rejected: a batch send is
        // keyboard-level input, the shell copes with long lines.
        let huge = "x".repeat(300 * 1024);
        let payload = SshRuntime::batch_input_payload(&huge, true);
        assert_eq!(payload.len(), 256 * 1024 + 1);
        assert_eq!(*payload.last().unwrap(), b'\r');
    }

    #[test]
    fn batch_input_helpers_dedupe_and_shape_rows() {
        let targets = SshRuntime::dedupe_session_ids(&[
            "b".to_string(),
            "a".to_string(),
            "b".to_string(),
            String::new(),
            "a".to_string(),
        ]);
        assert_eq!(targets, vec!["b".to_string(), "a".to_string()]);

        let ok = SshRuntime::batch_input_row("s1", None);
        assert_eq!(ok["sessionId"], json!("s1"));
        assert_eq!(ok["success"], json!(true));
        assert!(ok.get("error").is_none());
        let bad = SshRuntime::batch_input_row("s2", Some("SSH session was not found"));
        assert_eq!(bad["success"], json!(false));
        assert_eq!(bad["error"], json!("SSH session was not found"));
    }

    #[tokio::test]
    async fn batch_terminal_input_reports_unknown_sessions_as_target_failures() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        let response = runtime
            .batch_terminal_input(
                &["ghost-1".to_string(), "ghost-2".to_string()],
                "echo hi",
                true,
            )
            .await;
        assert_eq!(response["sent"], json!(0));
        assert_eq!(response["failed"], json!(2));
        let results = response["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["sessionId"], json!("ghost-1"));
        assert_eq!(results[0]["error"], json!("SSH session was not found"));
        assert_eq!(results[1]["sessionId"], json!("ghost-2"));
    }

    #[test]
    fn sessions_list_reports_an_empty_inventory_without_sessions() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        let payload = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(runtime.list_sessions());
        assert_eq!(payload["sessions"].as_array().expect("array").len(), 0);
    }

    #[test]
    fn directory_tracking_scripts_are_session_local() {
        let bash = directory_tracking_script(true, "session-1", RemoteShell::Bash);
        let zsh = directory_tracking_script(true, "session-1", RemoteShell::Zsh);
        assert!(bash.contains("PROMPT_COMMAND"));
        assert!(bash.contains("dbx-directory-ready-session-1"));
        assert!(zsh.contains("precmd_functions"));
    }

    #[test]
    fn primary_session_pick_is_deterministic_not_iteration_order() {
        // HashMap iteration order is randomized per process; whichever entry
        // "comes first" must not decide where terminal-routed commands run.
        let older_first = select_primary_session(vec![
            ("1111".to_string(), 0, true),
            ("2222".to_string(), 1, true),
        ]);
        let newer_first = select_primary_session(vec![
            ("2222".to_string(), 1, true),
            ("1111".to_string(), 0, true),
        ]);
        assert_eq!(older_first.as_deref(), Some("1111"));
        assert_eq!(newer_first.as_deref(), Some("1111"));
    }

    #[test]
    fn primary_session_pick_skips_disconnected_and_tiebreaks_by_id() {
        assert_eq!(
            select_primary_session(vec![
                ("3333".to_string(), 0, false),
                ("2222".to_string(), 1, true),
            ])
            .as_deref(),
            Some("2222")
        );
        assert_eq!(select_primary_session(Vec::new()), None);
    }

    #[test]
    fn directory_handshake_filters_split_marker() {
        let marker = directory_tracking_marker("session-1");
        let mut filter = DirectoryHandshakeFilter::default();
        filter.begin(marker.clone());
        assert_eq!(filter.filter(b"echoed script"), None);
        let split = marker.len() / 2;
        assert_eq!(filter.filter(&marker[..split]), None);
        let mut final_frame = marker[split..].to_vec();
        final_frame.extend_from_slice(b"prompt$ ");
        assert_eq!(filter.filter(&final_frame), Some(b"prompt$ ".to_vec()));
    }

    #[test]
    fn host_key_verdicts_map_check_results() {
        assert_eq!(
            host_key_verdict(Ok(HostKeyState::Trusted)),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            host_key_verdict(Ok(HostKeyState::Unknown)),
            HostKeyVerdict::Unknown
        );
        let changed = host_key_verdict(Err(std::io::Error::other(
            "Host key for h:22 changed (recorded at known_hosts, line 3)",
        )));
        assert!(matches!(&changed, HostKeyVerdict::Changed(message) if message.contains("line 3")));
    }

    #[test]
    fn host_key_check_responses_carry_state_and_key_identity() {
        let trusted =
            host_key_check_response(&HostKeyVerdict::Trusted, "ssh-ed25519", "SHA256:abcdef");
        assert_eq!(trusted["state"], "trusted");
        assert_eq!(trusted["keyType"], "ssh-ed25519");
        assert_eq!(trusted["fingerprint"], "SHA256:abcdef");

        assert_eq!(
            host_key_check_response(&HostKeyVerdict::Unknown, "rsa", "f")["state"],
            "unknown"
        );
        // A changed key keeps the identity of the presented key so the UI
        // can show the new fingerprint next to the mismatch reason.
        let changed = host_key_check_response(
            &HostKeyVerdict::Changed("key mismatch".to_string()),
            "rsa",
            "f",
        );
        assert_eq!(changed["state"], "changed");
        assert!(
            changed.get("error").is_none(),
            "reason travels in the notice event, not the check response"
        );

        let unreachable =
            host_key_unreachable_response("SSH connection to h:22 timed out".to_string());
        assert_eq!(unreachable["state"], "unreachable");
        assert_eq!(unreachable["error"], "SSH connection to h:22 timed out");
    }

    #[test]
    fn agent_terminal_mode_store_round_trips_per_connection() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        // Unknown connections read the default off.
        assert_eq!(
            runtime.agent_terminal_mode("conn-1"),
            AgentTerminalMode::Off
        );
        runtime
            .set_agent_terminal_mode("conn-1", AgentTerminalMode::parse("auto"))
            .expect("mode");
        runtime
            .set_agent_terminal_mode("conn-2", AgentTerminalMode::Strict)
            .expect("mode");
        assert_eq!(
            runtime.agent_terminal_mode("conn-1"),
            AgentTerminalMode::Auto
        );
        assert_eq!(
            runtime.agent_terminal_mode("conn-2"),
            AgentTerminalMode::Strict
        );
        assert_eq!(
            runtime.agent_terminal_mode("conn-3"),
            AgentTerminalMode::Off
        );
    }

    #[tokio::test]
    async fn agent_mode_get_reports_mode_and_live_session_presence() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());

        // Unknown connection: degrades to off with no live session — the
        // bridge caller treats this as "stay on the silent path" instead of
        // erroring.
        let probe = runtime.agent_mode_get("conn-ghost").await.expect("probe");
        assert_eq!(probe["agentTerminalMode"], "off");
        assert_eq!(probe["hasTerminalSession"], false);

        // A mode set through the settings surface is reflected verbatim.
        runtime
            .set_agent_terminal_mode("conn-1", AgentTerminalMode::Strict)
            .expect("mode");
        let probe = runtime.agent_mode_get("conn-1").await.expect("probe");
        assert_eq!(probe["agentTerminalMode"], "strict");
        // No session was opened in this test, so presence stays false even
        // though the mode is on.
        assert_eq!(probe["hasTerminalSession"], false);
    }

    #[test]
    fn agent_challenges_resolve_once_and_report_unknown() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());

        // Unknown / already resolved challenges are refused.
        assert!(runtime
            .resolve_agent_challenge("ghost", "approve", None, false)
            .is_err());

        // Approve delivers the (possibly edited) command once, then the
        // challenge is gone. The registry guard is dropped before each
        // resolve so the std Mutex never re-enters on the same thread.
        let (sender, receiver) = oneshot::channel();
        runtime.agent_challenges.lock().expect("challenges").insert(
            "c-1".to_string(),
            PendingChallenge {
                sender,
                connection_id: "conn-1".to_string(),
                tool: "ssh_exec".to_string(),
                command: "echo edited".to_string(),
                raised_at_ms: 0,
            },
        );
        runtime
            .resolve_agent_challenge("c-1", "approve", Some("echo edited"), false)
            .expect("resolve");
        let decision = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(receiver)
            .expect("decision");
        assert_eq!(
            decision,
            AgentDecision::Approve {
                command: Some("echo edited".to_string())
            }
        );
        assert!(runtime
            .resolve_agent_challenge("c-1", "approve", None, false)
            .is_err());

        // Deny decisions and unknown decision names are handled too.
        let (sender, receiver) = oneshot::channel();
        runtime.agent_challenges.lock().expect("challenges").insert(
            "c-2".to_string(),
            PendingChallenge {
                sender,
                connection_id: "conn-1".to_string(),
                tool: "ssh_exec".to_string(),
                command: "echo hi".to_string(),
                raised_at_ms: 0,
            },
        );
        runtime
            .resolve_agent_challenge("c-2", "deny", None, false)
            .expect("resolve");
        let decision = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(receiver)
            .expect("decision");
        assert_eq!(decision, AgentDecision::Deny);
        assert!(runtime
            .resolve_agent_challenge("c-2", "maybe", None, false)
            .is_err());
    }

    /// Reliability round 5 (churn): 500 raise→resolve cycles must leave the
    /// challenge registry empty (no leak), every consumed id must stay
    /// unknown afterwards (one-shot semantics survive churn), and each
    /// decision must reach its waiter exactly once.
    #[test]
    fn agent_challenges_survive_high_volume_resolve_churn() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        const CYCLES: usize = 500;

        for index in 0..CYCLES {
            let id = format!("churn-{index}");
            let (sender, mut receiver) = oneshot::channel();
            runtime.agent_challenges.lock().expect("challenges").insert(
                id.clone(),
                PendingChallenge {
                    sender,
                    connection_id: "conn-1".to_string(),
                    tool: "ssh_exec".to_string(),
                    command: format!("echo {index}"),
                    raised_at_ms: 0,
                },
            );
            // The registry never grows beyond the live challenge: raising
            // one inserts one row, resolving consumes it.
            {
                let challenges = runtime.agent_challenges.lock().expect("challenges");
                assert_eq!(
                    challenges.len(),
                    1,
                    "challenge registry leaked at cycle {index}"
                );
            }
            let decision = if index % 3 == 0 {
                runtime
                    .resolve_agent_challenge(&id, "deny", None, false)
                    .expect("deny");
                AgentDecision::Deny
            } else {
                let edited = format!("echo edited-{index}");
                runtime
                    .resolve_agent_challenge(&id, "approve", Some(&edited), false)
                    .expect("approve");
                AgentDecision::Approve {
                    command: Some(edited),
                }
            };
            // One-shot: the consumed id is unknown, and a wrong decision
            // name is still refused.
            assert!(
                runtime
                    .resolve_agent_challenge(&id, "approve", None, false)
                    .is_err(),
                "consumed challenge came back at cycle {index}"
            );
            assert_eq!(
                receiver.try_recv().ok(),
                Some(decision),
                "decision must reach its waiter exactly once (cycle {index})"
            );
        }
        assert!(
            runtime
                .agent_challenges
                .lock()
                .expect("challenges")
                .is_empty(),
            "challenge registry must be empty after churn"
        );

        // The MCP confirm payload bakes its own timeout at issue time: two
        // challenges raised with different budgets each carry theirs (the
        // "不追溯" contract — later changes never rewrite live payloads).
        let short = SshRuntime::mcp_confirm_challenge_payload("s", "ssh_exec", "x", None, 10);
        let long = SshRuntime::mcp_confirm_challenge_payload("l", "ssh_exec", "x", None, 600);
        assert_eq!(short["timeoutSecs"], 10);
        assert_eq!(long["timeoutSecs"], 600);
    }

    #[test]
    fn mcp_confirm_challenge_payload_shape() {
        let payload = SshRuntime::mcp_confirm_challenge_payload(
            "ch-1",
            "ssh_exec",
            "echo hi",
            Some("conn-9"),
            120,
        );
        assert_eq!(payload["challengeId"], "ch-1");
        assert_eq!(payload["kind"], "mcp-confirm");
        assert_eq!(payload["source"], "mcp");
        assert_eq!(payload["tool"], "ssh_exec");
        assert_eq!(payload["command"], "echo hi");
        assert_eq!(payload["connectionId"], "conn-9");
        assert_eq!(payload["timeoutSecs"], 120);
        assert!(payload["requestedAt"].is_u64());

        // Without a connection reference the field is absent (optional —
        // not null) so legacy frontends keep their fallback rendering.
        let bare = SshRuntime::mcp_confirm_challenge_payload(
            "ch-2",
            "sftp_remove",
            "path=/tmp/x",
            None,
            120,
        );
        assert!(bare.get("connectionId").is_none());
        assert_eq!(bare["kind"], "mcp-confirm");
        assert_eq!(bare["source"], "mcp");
        // An empty reference is treated as absent too.
        let blank =
            SshRuntime::mcp_confirm_challenge_payload("ch-3", "ssh_exec", "ls", Some(""), 120);
        assert!(blank.get("connectionId").is_none());
    }

    #[test]
    fn agent_remember_persists_approved_and_skips_destructive() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());

        // approve + remember persists the approved command on the
        // connection's remembered list (IMPL_PLAN §2.1).
        let (sender, _receiver) = oneshot::channel();
        runtime.agent_challenges.lock().expect("challenges").insert(
            "r-1".to_string(),
            PendingChallenge {
                sender,
                connection_id: "conn-1".to_string(),
                tool: "ssh_exec".to_string(),
                command: "systemctl restart nginx".to_string(),
                raised_at_ms: 0,
            },
        );
        runtime
            .resolve_agent_challenge("r-1", "approve", Some("systemctl restart nginx"), true)
            .expect("resolve");
        assert_eq!(
            agent_approvals::list_lines(&agent_approvals::load_store(data_dir.path()), "conn-1"),
            ["systemctl restart nginx"]
        );

        // A destructive text is approved (the decision still delivers) but
        // never remembered — the D2 double lock, second half.
        let (sender, receiver) = oneshot::channel();
        runtime.agent_challenges.lock().expect("challenges").insert(
            "r-2".to_string(),
            PendingChallenge {
                sender,
                connection_id: "conn-1".to_string(),
                tool: "ssh_exec".to_string(),
                command: "rm -rf /".to_string(),
                raised_at_ms: 0,
            },
        );
        runtime
            .resolve_agent_challenge("r-2", "approve", Some("rm -rf /"), true)
            .expect("resolve");
        let decision = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(receiver)
            .expect("decision");
        assert_eq!(
            decision,
            AgentDecision::Approve {
                command: Some("rm -rf /".to_string())
            }
        );
        assert_eq!(
            agent_approvals::list_lines(&agent_approvals::load_store(data_dir.path()), "conn-1"),
            ["systemctl restart nginx"],
            "destructive command must not join the remembered list"
        );
    }

    #[test]
    fn agent_exec_lock_admits_one_holder_then_queues() {
        // Structural test for the per-session agent-execution lock: one
        // holder excludes a second contender and release lets it through.
        // The await-based acquisition itself (`agent_exec_guard`, held across
        // approval + run) is exercised by the container smoke's concurrent
        // pair, which needs a live PTY. `blocking_lock` is fine here — the
        // test runs outside any tokio runtime.
        let lock = Arc::new(AsyncMutex::new(()));
        let held = lock.clone();
        let guard = held.blocking_lock();
        assert!(
            lock.try_lock().is_err(),
            "a second agent command must queue behind the running one"
        );
        drop(guard);
        assert!(
            lock.try_lock().is_ok(),
            "release must admit the next agent command"
        );
    }

    #[test]
    fn attach_target_requires_exact_workbench() {
        let sessions: Vec<(String, String, String, bool)> = vec![
            ("s-old".into(), "conn-1".into(), "wb-old".into(), true),
            ("s-new".into(), "conn-1".into(), "wb-new".into(), true),
            ("s-other".into(), "conn-2".into(), "wb-other".into(), true),
        ];
        // Exact double match wins when the workbench id is stable.
        assert_eq!(
            SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-old").as_deref(),
            Some("s-old")
        );
        // A second workbench on the same saved connection gets its own exact
        // session rather than stealing the first tab's PTY.
        assert_eq!(
            SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-new").as_deref(),
            Some("s-new")
        );
        assert_eq!(
            SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-missing"),
            None
        );
        // Dead sessions never attach; other connections' sessions stay put.
        let dead: Vec<(String, String, String, bool)> =
            vec![("s-dead".into(), "conn-1".into(), "wb-old".into(), false)];
        assert_eq!(
            SshRuntime::pick_attach_target(&dead, "conn-1", "wb-new"),
            None
        );
        assert_eq!(
            SshRuntime::pick_attach_target(&sessions, "conn-3", "wb-new"),
            None
        );
    }

    #[tokio::test]
    async fn agent_exec_guard_reports_unknown_sessions() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        let error = runtime
            .agent_exec_guard("no-such-session")
            .await
            .expect_err("unknown session must be refused");
        assert!(
            error.contains("not found") || error.contains("expired"),
            "unexpected error: {error}"
        );
    }

    /// `sftp/transfer/history`: live registry rows win over the persisted
    /// rows of the same task (fresh progress, inherited start context),
    /// stale persisted `running` rows from a dead sidecar surface as
    /// failed, and the result is newest-first with limit/session filtering.
    #[test]
    fn transfer_history_merges_live_rows_over_persisted_ones() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let root = data_dir.path();
        transfer_history::record_transition(
            root,
            &json!({
                "taskId": "t-done", "sessionId": "s1", "connectionId": "c1",
                "direction": "download", "fileName": "done.bin", "size": 4,
                "transferred": 4, "status": "completed",
                "startedAt": 1_000, "finishedAt": 2_000,
            }),
        )
        .unwrap();
        transfer_history::record_transition(
            root,
            &json!({
                "taskId": "t-live", "sessionId": "s1", "connectionId": "c1",
                "direction": "download", "fileName": "live.bin", "size": 9,
                "transferred": 0, "status": "running",
                "startedAt": 3_000, "finishedAt": null,
            }),
        )
        .unwrap();
        transfer_history::record_transition(
            root,
            &json!({
                "taskId": "t-stale", "sessionId": "s1", "connectionId": "c1",
                "direction": "upload", "fileName": "stale.bin", "size": 2,
                "transferred": 0, "status": "running",
                "startedAt": 500, "finishedAt": null,
            }),
        )
        .unwrap();
        let runtime = SshRuntime::new(root.to_path_buf());
        runtime.downloads.lock().unwrap().insert(
            "t-live".to_string(),
            DownloadState {
                session_id: "s1".to_string(),
                remote_path: "/live.bin".to_string(),
                file_name: "live.bin".to_string(),
                size: 9,
                next_offset: 5,
                sink: None,
                tree: None,
                sudo_tmp: None,
            },
        );
        let no_connection = |_: &str| String::new();
        let tasks = runtime
            .build_transfer_history(Some("s1"), 50, &no_connection)
            .unwrap();
        let tasks = tasks.get("tasks").and_then(Value::as_array).unwrap();
        assert_eq!(tasks.len(), 3);
        // Newest first: the live task (startedAt 3000) leads.
        assert_eq!(tasks[0]["taskId"], "t-live");
        assert_eq!(tasks[0]["transferred"], 5, "live progress wins");
        assert_eq!(tasks[0]["status"], "running");
        assert_eq!(tasks[0]["startedAt"], 3_000, "start context is inherited");
        assert_eq!(tasks[1]["taskId"], "t-done");
        assert_eq!(tasks[1]["status"], "completed");
        // The stale row has no live counterpart: dead-sidecar downgrade (D7).
        assert_eq!(tasks[2]["taskId"], "t-stale");
        assert_eq!(tasks[2]["status"], "failed");
        assert!(
            tasks[2]["error"]
                .as_str()
                .unwrap()
                .contains("sidecar restart"),
            "unexpected error: {}",
            tasks[2]["error"]
        );
        // Limit caps the merged list after sorting.
        let limited = runtime
            .build_transfer_history(Some("s1"), 1, &no_connection)
            .unwrap();
        assert_eq!(limited["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(limited["tasks"][0]["taskId"], "t-live");
        // Unknown sessions yield an empty list.
        let other = runtime
            .build_transfer_history(Some("s2"), 50, &no_connection)
            .unwrap();
        assert!(other["tasks"].as_array().unwrap().is_empty());
    }

    /// Issue #18: the history order must be a total order — newest first by
    /// `startedAt`, ties broken by `taskId`, live rows without a start
    /// record on top — so repeated polls cannot reshuffle equal/missing
    /// keys into different positions.
    #[test]
    fn transfer_history_order_is_total_and_stable() {
        let rows = vec![
            json!({ "taskId": "b", "startedAt": 2_000 }),
            json!({ "taskId": "a", "startedAt": 2_000 }),
            json!({ "taskId": "z" }),
            json!({ "taskId": "c", "startedAt": 3_000 }),
            json!({ "taskId": "y" }),
            json!({ "taskId": "a-old", "startedAt": 1 }),
        ];
        let mut sorted = rows.clone();
        sorted.sort_by(compare_history_rows);
        let ids: Vec<&str> = sorted
            .iter()
            .map(|task| task["taskId"].as_str().unwrap())
            .collect();
        // Missing timestamps lead (live rows), taskId tiebreak; then newest
        // started first, again tie-broken by taskId.
        assert_eq!(ids, vec!["y", "z", "c", "a", "b", "a-old"]);
        // Any permutation of the same rows yields the identical order —
        // the property the previous `startedAt`-only sort lacked.
        for start in 0..rows.len() {
            let mut rotated = rows.clone();
            rotated.rotate_left(start);
            rotated.sort_by(compare_history_rows);
            let rotated_ids: Vec<&str> = rotated
                .iter()
                .map(|task| task["taskId"].as_str().unwrap())
                .collect();
            assert_eq!(rotated_ids, ids);
        }
    }

    /// Issue #18: two live downloads whose start records never reached the
    /// disk (lost cross-process write) used to render in HashMap iteration
    /// order — a different order on every sidecar restart. The taskId
    /// tiebreak makes the merged history deterministic.
    #[test]
    fn transfer_history_live_rows_without_start_context_sort_by_task_id() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let runtime = SshRuntime::new(data_dir.path().to_path_buf());
        for task_id in ["t-zulu", "t-alpha", "t-mike"] {
            runtime.downloads.lock().unwrap().insert(
                task_id.to_string(),
                DownloadState {
                    session_id: "s1".to_string(),
                    remote_path: format!("/{task_id}.bin"),
                    file_name: format!("{task_id}.bin"),
                    size: 8,
                    next_offset: 0,
                    sink: None,
                    tree: None,
                    sudo_tmp: None,
                },
            );
        }
        let no_connection = |_: &str| String::new();
        let tasks = runtime
            .build_transfer_history(Some("s1"), 50, &no_connection)
            .unwrap();
        let ids: Vec<String> = tasks["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["taskId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["t-alpha", "t-mike", "t-zulu"]);
    }

    /// Auto 按序回退的纯逻辑契约：固定顺序、阶段门控、全失败汇总。真实
    /// 凭据流（密码/私钥/KI/agent）复用既有 helper，端到端由既有认证测试
    /// 覆盖；这里只锁定编排器自身的决策面。
    mod auto_auth {
        use super::*;

        #[test]
        fn auto_order_contract_lists_methods_in_fallback_order() {
            // 对标 Tabby 的认证依序回退：密码 → 私钥 → 交互式 KI → agent。
            assert_eq!(
                AUTO_AUTH_ORDER,
                ["password", "private-key", "keyboard-interactive", "agent"]
            );
        }

        #[test]
        fn auto_stage_skip_gates_password_on_config_and_advertised_methods() {
            // 无密码配置：跳过，无论服务器是否广告 password 方法。
            assert_eq!(
                auto_stage_skip("password", false, true, true).as_deref(),
                Some("no password configured for this connection")
            );
            // 有密码但服务器未广告 password 方法：不发送密码，跳过。
            assert_eq!(
                auto_stage_skip("password", true, false, true).as_deref(),
                Some("server does not advertise password authentication")
            );
            // 有密码且已广告：尝试。
            assert_eq!(auto_stage_skip("password", true, true, true), None);
        }

        #[test]
        fn auto_stage_skip_gates_private_key_on_configured_material() {
            assert_eq!(
                auto_stage_skip("private-key", true, true, false).as_deref(),
                Some("no private key configured for this connection")
            );
            // 路径或粘贴内容任一存在即算已配置。
            assert_eq!(auto_stage_skip("private-key", false, false, true), None);
        }

        #[test]
        fn auto_stage_skip_never_gates_interactive_or_agent_stages() {
            // KI 与 agent 没有本地前置凭据：提问可交互作答，agent 套接字
            // 来自环境（挑战流中立——Auto 不改变 host key / 2FA 交互行为）。
            for method in ["keyboard-interactive", "agent"] {
                assert_eq!(
                    auto_stage_skip(method, false, false, false),
                    None,
                    "{method} must never be skipped by local prerequisites"
                );
            }
        }

        #[test]
        fn auto_auth_failure_message_aggregates_attempts_in_order() {
            let attempts = vec![
                auto_auth_skip(
                    "password",
                    "no password configured for this connection".to_string(),
                ),
                auto_auth_attempt("private-key", "rejected by the server".to_string()),
                auto_auth_attempt(
                    "keyboard-interactive",
                    "SSH keyboard-interactive authentication was rejected".to_string(),
                ),
                auto_auth_attempt("agent", "no SSH Agent identity was accepted".to_string()),
            ];
            // 汇总保持固定顺序，逐方式带原因；skipped 有显式标记。
            assert_eq!(
                auto_auth_failure_message(&attempts),
                "SSH authentication failed in Auto mode, tried in order — \
                 password (skipped: no password configured for this connection); \
                 private-key (rejected by the server); \
                 keyboard-interactive (SSH keyboard-interactive authentication was rejected); \
                 agent (no SSH Agent identity was accepted)"
            );
        }

        #[test]
        fn auto_auth_failure_message_without_attempts_names_the_chain() {
            assert_eq!(
                auto_auth_failure_message(&[]),
                "SSH authentication failed in Auto mode: no method could be attempted"
            );
        }

        #[test]
        fn auto_auth_attempt_helpers_mark_skip_state() {
            let skipped = auto_auth_skip("password", "reason".to_string());
            assert!(skipped.skipped);
            assert_eq!(skipped.method, "password");
            let attempted = auto_auth_attempt("agent", "detail".to_string());
            assert!(!attempted.skipped);
            assert_eq!(attempted.method, "agent");
        }
    }

    /// 登录期 2FA 的端到端回归（issue #17 / #30）：密码/公钥先被接受后服务器
    /// 用 keyboard-interactive 问 MFA（koko 形状）。mock 服务端按 `Shape`
    /// 参数化，覆盖"密码方法 + partial success"、"KI 里先密码再 MFA"、
    /// "只问 MFA"、"一个合并提问"四种提问形态。
    mod koko_login {
        use super::*;
        use dbx_plugin_sdk::PluginTransport;
        use russh::keys::ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};
        use russh::server::{Auth, ChannelOpenHandle, Msg, Response, Server as _, Session};
        use russh::{Channel, ChannelId, MethodKind, MethodSet, Pty};
        use std::net::SocketAddr;

        const LOGIN_PASSWORD: &str = "jump-pw";
        const SUDO_PASSWORD: &str = "asset-pw";
        const MFA_CODE: &str = "654321";
        // 逐字取自 koko pkg/auth/mfa_option.go（mfaOptionInstruction /
        // mfaOptionQuestion，MFA 类型 otp）。
        const MFA_INSTRUCTION: &str = "Please Enter MFA Code.";
        const MFA_QUESTION: &str = "[OTP Code]: ";

        /// mock 堡垒机的认证形态。
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum Shape {
            /// 开放 password 方法：密码通过后 partial success → KI 问 MFA（koko 默认）。
            PasswordThenMfa,
            /// 只开放 keyboard-interactive：KI 第一轮问密码，第二轮问 MFA（PAM 风格）。
            KiPasswordThenMfa,
            /// 只开放 keyboard-interactive：只问 MFA（反问顺序主机）。
            KiMfaOnly,
            /// 只开放 keyboard-interactive：一个提问同时要密码与验证码。
            KiCombined,
        }

        impl Shape {
            fn allows_password_method(self) -> bool {
                self == Shape::PasswordThenMfa
            }
        }

        /// 测试专用 Ed25519 密钥：由固定种子展开，不依赖 RNG 版本，也绝不
        /// 涉及真实私钥（仅供本机 mock 服务器与客户端握手）。
        fn test_key(seed: u8) -> russh::keys::PrivateKey {
            russh::keys::PrivateKey::from(Ed25519Keypair::from_seed(
                &[seed; Ed25519PrivateKey::BYTE_SIZE],
            ))
        }

        #[derive(Clone)]
        struct MockKoko {
            shape: Shape,
            instruction: &'static str,
            prompt: &'static str,
            answers: Arc<Mutex<Vec<String>>>,
        }

        impl MockKoko {
            fn new(shape: Shape, instruction: &'static str, prompt: &'static str) -> Self {
                Self {
                    shape,
                    instruction,
                    prompt,
                    answers: Arc::new(Mutex::new(Vec::new())),
                }
            }
        }

        struct MockKokoSession {
            shape: Shape,
            instruction: &'static str,
            prompt: &'static str,
            answers: Arc<Mutex<Vec<String>>>,
            ki_round: usize,
        }

        impl russh::server::Handler for MockKokoSession {
            type Error = russh::Error;

            async fn channel_open_session(
                &mut self,
                _channel: Channel<Msg>,
                reply: ChannelOpenHandle,
                _session: &mut Session,
            ) -> Result<(), Self::Error> {
                reply.accept().await;
                Ok(())
            }

            async fn exec_request(
                &mut self,
                channel: ChannelId,
                _data: &[u8],
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                session.data(channel, b"/bin/bash".to_vec())?;
                session.eof(channel)?;
                session.close(channel)?;
                Ok(())
            }

            #[allow(clippy::too_many_arguments)]
            async fn pty_request(
                &mut self,
                channel: ChannelId,
                _term: &str,
                _col_width: u32,
                _row_height: u32,
                _pix_width: u32,
                _pix_height: u32,
                _modes: &[(Pty, u32)],
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                Ok(())
            }

            async fn shell_request(
                &mut self,
                channel: ChannelId,
                session: &mut Session,
            ) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                Ok(())
            }

            async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
                Ok(Auth::reject())
            }

            async fn auth_password(
                &mut self,
                _user: &str,
                password: &str,
            ) -> Result<Auth, Self::Error> {
                if password != LOGIN_PASSWORD {
                    return Ok(Auth::reject());
                }
                // koko: 第一因子通过 → PartialSuccessError，下一步
                // keyboard-interactive 问 MFA。
                let mut methods = MethodSet::empty();
                methods.push(MethodKind::KeyboardInteractive);
                Ok(Auth::Reject {
                    proceed_with_methods: Some(methods),
                    partial_success: true,
                })
            }

            async fn auth_publickey(
                &mut self,
                _user: &str,
                _public_key: &russh::keys::PublicKey,
            ) -> Result<Auth, Self::Error> {
                // koko 的私钥 + MFA：公钥被接受后仍要二次认证。
                let mut methods = MethodSet::empty();
                methods.push(MethodKind::KeyboardInteractive);
                Ok(Auth::Reject {
                    proceed_with_methods: Some(methods),
                    partial_success: true,
                })
            }

            async fn auth_keyboard_interactive<'a>(
                &'a mut self,
                _user: &str,
                _submethods: &str,
                response: Option<Response<'a>>,
            ) -> Result<Auth, Self::Error> {
                let Some(mut response) = response else {
                    // 开局提问：PAM 形状先问密码；合并形状一个提问问两样。
                    let (instruction, prompt) = match self.shape {
                        Shape::KiPasswordThenMfa => ("Please enter your password.", "Password: "),
                        Shape::KiCombined => ("Password and MFA required", "Password: OTP Code: "),
                        _ => (self.instruction, self.prompt),
                    };
                    return Ok(Auth::Partial {
                        name: "jumper".into(),
                        instructions: instruction.into(),
                        prompts: vec![(prompt.into(), self.shape == Shape::KiPasswordThenMfa)]
                            .into(),
                    });
                };
                let answer = response
                    .next()
                    .map(|bytes| String::from_utf8_lossy(bytes.as_ref()).into_owned())
                    .unwrap_or_default();
                self.answers.lock().unwrap().push(answer.clone());
                self.ki_round += 1;
                match self.shape {
                    // 第一轮是密码：答对后继续问 MFA。
                    Shape::KiPasswordThenMfa if self.ki_round == 1 => {
                        if answer != LOGIN_PASSWORD {
                            return Ok(Auth::reject());
                        }
                        Ok(Auth::Partial {
                            name: "jumper".into(),
                            instructions: self.instruction.into(),
                            prompts: vec![(self.prompt.into(), true)].into(),
                        })
                    }
                    // 合并提问：一条应答里必须同时有密码与验证码。
                    Shape::KiCombined => Ok(if answer == format!("{LOGIN_PASSWORD}{MFA_CODE}") {
                        Auth::Accept
                    } else {
                        Auth::reject()
                    }),
                    _ => Ok(if answer == MFA_CODE {
                        Auth::Accept
                    } else {
                        Auth::reject()
                    }),
                }
            }

            async fn auth_succeeded(&mut self, _session: &mut Session) -> Result<(), Self::Error> {
                Ok(())
            }
        }

        impl russh::server::Server for MockKoko {
            type Handler = MockKokoSession;

            fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
                MockKokoSession {
                    shape: self.shape,
                    instruction: self.instruction,
                    prompt: self.prompt,
                    answers: self.answers.clone(),
                    ki_round: 0,
                }
            }
        }

        async fn spawn_mock_koko(
            shape: Shape,
            instruction: &'static str,
            prompt: &'static str,
        ) -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind mock koko");
            let port = listener.local_addr().expect("mock koko address").port();
            let mut methods = MethodSet::empty();
            if shape.allows_password_method() {
                methods.push(MethodKind::Password);
            }
            methods.push(MethodKind::KeyboardInteractive);
            let config = Arc::new(russh::server::Config {
                methods,
                keys: vec![test_key(1)],
                auth_rejection_time: Duration::from_millis(10),
                auth_rejection_time_initial: Some(Duration::from_millis(10)),
                ..Default::default()
            });
            let mut server = MockKoko::new(shape, instruction, prompt);
            let answers = server.answers.clone();
            let task = tokio::spawn(async move {
                let _ = server.run_on_socket(config, &listener).await;
            });
            (port, answers, task)
        }

        fn koko_connection(port: u16, secrets: Value, external: Value) -> StoredConnection {
            StoredConnection::from_lifecycle_params(&json!({
                "connection": {
                    "id": "koko-login",
                    "name": "koko",
                    "db_type": "ssh",
                    "host": "127.0.0.1",
                    "port": port,
                    "username": "jumper",
                    "password": LOGIN_PASSWORD,
                    "connection_secrets": secrets,
                    "external_config": external,
                }
            }))
            .expect("parse koko connection")
        }

        fn test_runtime() -> SshRuntime {
            let data_dir = std::env::temp_dir().join(format!("dbx-koko-e2e-{}", Uuid::new_v4()));
            SshRuntime::new(data_dir).with_auto_trust_keys()
        }

        fn test_emitter() -> PluginEmitter {
            let output: Arc<Mutex<Box<dyn std::io::Write + Send>>> =
                Arc::new(Mutex::new(Box::new(Vec::<u8>::new())));
            PluginEmitter::for_tests(output, PluginTransport::JsonLines)
        }

        struct ManualOtpGateway {
            answer: UserInputAnswer,
            prompts_seen: Mutex<Vec<Value>>,
        }

        impl ManualOtpGateway {
            fn submitting(code: &str) -> Self {
                Self {
                    answer: UserInputAnswer {
                        action: "submit".into(),
                        value: Some(code.into()),
                    },
                    prompts_seen: Mutex::new(Vec::new()),
                }
            }

            fn cancelling() -> Self {
                Self {
                    answer: UserInputAnswer {
                        action: "cancel".into(),
                        value: None,
                    },
                    prompts_seen: Mutex::new(Vec::new()),
                }
            }
        }

        impl HostPromptGateway for ManualOtpGateway {
            fn supports_request_user_input(&self) -> bool {
                true
            }

            fn request_user_input(
                &self,
                prompt: &UserInputPrompt,
            ) -> Result<UserInputAnswer, PluginError> {
                self.prompts_seen
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(prompt).unwrap());
                Ok(self.answer.clone())
            }
        }

        #[tokio::test]
        async fn unknown_chinese_mfa_prompt_requests_current_code_from_user() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, "请输入6位数字。", "[MFA认证]：").await;
            let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
            let mut runtime = test_runtime();
            runtime.prompts = PromptBroker::with_gateway(gateway.clone());
            let connection = koko_connection(
                port,
                json!({}),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "password_then_otp",
                }),
            );

            let result = runtime.connect_headless(&connection).await;
            server.abort();

            result.expect("unanswered MFA challenge must open a one-time secret prompt");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
            let prompts = gateway.prompts_seen.lock().unwrap();
            assert_eq!(prompts.len(), 1, "exactly one OTP dialog is expected");
            assert_eq!(prompts[0]["echo"], false, "the OTP input must be masked");
            assert!(prompts[0]["title"]
                .as_str()
                .unwrap()
                .starts_with("动态令牌验证"));
            assert!(prompts[0]["prompt"]
                .as_str()
                .unwrap()
                .contains("本次输入仅用于此次登录，不会保存"));
            assert!(prompts[0]["prompt"]
                .as_str()
                .unwrap()
                .contains("请输入6位数字。"));
            assert!(prompts[0]["prompt"]
                .as_str()
                .unwrap()
                .contains("[MFA认证]："));
        }

        #[tokio::test]
        async fn configured_totp_keeps_login_automatic_without_user_prompt() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
            let gateway = Arc::new(ManualOtpGateway::submitting("should-not-be-used"));
            let mut runtime = test_runtime();
            runtime.prompts = PromptBroker::with_gateway(gateway.clone());
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "password_then_otp",
                }),
            );

            let result = runtime.connect_headless(&connection).await;
            server.abort();

            result.expect("configured TOTP must keep the existing automatic login path");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
            assert!(
                gateway.prompts_seen.lock().unwrap().is_empty(),
                "automatic TOTP must not open a redundant dialog"
            );
        }

        #[tokio::test]
        async fn cancelling_manual_mfa_prompt_fails_closed() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, "请输入6位数字。", "[MFA认证]：").await;
            let gateway = Arc::new(ManualOtpGateway::cancelling());
            let mut runtime = test_runtime();
            runtime.prompts = PromptBroker::with_gateway(gateway.clone());
            let connection = koko_connection(
                port,
                json!({}),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "password_then_otp",
                }),
            );

            let result = runtime.connect_headless(&connection).await;
            server.abort();

            assert_eq!(
                result.err().as_deref(),
                Some("SSH keyboard-interactive authentication was cancelled")
            );
            assert!(
                answers.lock().unwrap().is_empty(),
                "cancelled prompts must not send an empty or guessed answer"
            );
            assert_eq!(gateway.prompts_seen.lock().unwrap().len(), 1);
        }

        #[tokio::test]
        async fn second_terminal_session_reuses_authenticated_transport() {
            let (port, answers, server) = spawn_mock_koko(
                Shape::PasswordThenMfa,
                "Please enter 6 digits.",
                "[MFA auth]:",
            )
            .await;
            let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
            let mut runtime = test_runtime();
            runtime.prompts = PromptBroker::with_gateway(gateway.clone());
            let connection = koko_connection(
                port,
                json!({}),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "off",
                }),
            );
            runtime.store_connection(connection).unwrap();

            let first = runtime
                .open_session(
                    &SessionOpenRequest {
                        connection_id: "koko-login".into(),
                        workbench_id: "workbench-1".into(),
                        reuse_authenticated_transport: false,
                        reuse_authenticated_session_id: None,
                        cols: 80,
                        rows: 24,
                    },
                    "open-1",
                    test_emitter(),
                )
                .await
                .expect("first terminal session");
            let second = runtime
                .open_session(
                    &SessionOpenRequest {
                        connection_id: "koko-login".into(),
                        workbench_id: "workbench-2".into(),
                        reuse_authenticated_transport: true,
                        reuse_authenticated_session_id: first["sessionId"]
                            .as_str()
                            .map(str::to_string),
                        cols: 80,
                        rows: 24,
                    },
                    "open-2",
                    test_emitter(),
                )
                .await
                .expect("second terminal session");

            assert_eq!(
                gateway.prompts_seen.lock().unwrap().len(),
                1,
                "a second PTY on the same live connection must not ask for MFA again"
            );
            assert_eq!(
                answers.lock().unwrap().as_slice(),
                [MFA_CODE.to_string()],
                "the bastion must authenticate only the first SSH transport"
            );

            for opened in [first, second] {
                let session_id = opened["sessionId"].as_str().unwrap();
                runtime.close_session(session_id).await.unwrap();
            }
            server.abort();
        }

        #[test]
        fn pending_copy_reservation_keeps_transport_alive_before_session_registration() {
            let uses = TransportLeaseCounter::new();
            uses.retain(); // pending copied-session open

            assert_eq!(uses.count(), 2);
            assert!(
                !uses.release(),
                "closing the source must not release a transport reserved by a pending copy"
            );
            assert_eq!(uses.count(), 1);
            assert!(
                uses.release(),
                "the final copied session owns the last transport lease"
            );
        }

        #[tokio::test]
        async fn copied_session_without_a_live_transport_does_not_reprompt_for_mfa() {
            let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
            let mut runtime = test_runtime();
            runtime.prompts = PromptBroker::with_gateway(gateway.clone());
            runtime
                .store_connection(koko_connection(
                    1,
                    json!({}),
                    json!({
                        "authentication": "password",
                        "auth_flow_mode": "off",
                    }),
                ))
                .unwrap();

            let error = runtime
                .open_session(
                    &SessionOpenRequest {
                        connection_id: "koko-login".into(),
                        workbench_id: "copied-workbench".into(),
                        reuse_authenticated_transport: true,
                        reuse_authenticated_session_id: Some("missing-session".into()),
                        cols: 80,
                        rows: 24,
                    },
                    "copy-without-source",
                    test_emitter(),
                )
                .await
                .expect_err("copying without a live source must fail before authentication");

            assert!(error.contains("use New session to reconnect"));
            assert!(gateway.prompts_seen.lock().unwrap().is_empty());
        }

        #[tokio::test]
        async fn mfa_code_is_answered_after_partial_success_password() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("koko MFA login must succeed");
            assert_eq!(
                answers.lock().unwrap().as_slice(),
                [MFA_CODE.to_string()],
                "the MFA question must be answered with the TOTP code"
            );
        }

        /// 提问文案认不出、但挑战指令行是 koko 的 "Please Enter MFA Code."：
        /// 用户照屏幕抄进 OTP 提示词的就是这句话（issue #17 的 martin-bian）。
        #[tokio::test]
        async fn mfa_is_answered_from_challenge_instructions() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, "Code: ").await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "password_then_otp",
                    "totp_prompt_hint": "Please Enter MFA Code.",
                }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("instructions-only MFA prompt must be answered");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        }

        /// 完全自定义的提问文案靠用户提示词命中（无内置模式可依赖）。
        #[tokio::test]
        async fn mfa_is_answered_from_user_hint() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, "", "Enter verification token: ").await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "password_then_otp",
                    "totp_prompt_hint": "verification token",
                }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("hint-matched MFA prompt must be answered");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        }

        /// 只开 keyboard-interactive、直接问 MFA（反问顺序主机）+ 先密码再 OTP：
        /// 保护仍然生效——不回码，且失败信息点名服务器提问与配置入口。
        #[tokio::test]
        async fn bare_mfa_prompt_stays_unanswered_before_the_password() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::KiMfaOnly, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            let error = result.err().expect("bare MFA prompt must not be answered");
            assert!(
                error.contains(MFA_QUESTION.trim()),
                "error must name the server prompt: {error}"
            );
            assert!(
                !answers
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|answer| answer == MFA_CODE),
                "the OTP code must not be submitted before the password step"
            );
        }

        /// 同一形态改配「密码 + OTP 合并」：反问顺序主机应能登录（表单选型指引）。
        #[tokio::test]
        async fn bare_mfa_prompt_is_answered_in_combined_mode() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::KiMfaOnly, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({ "authentication": "password", "auth_flow_mode": "password_plus_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("combined mode answers a bare MFA prompt");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        }

        /// PAM 风格主机在 KI 里问密码：登录提问必须收到**登录口令**，而不是
        /// 单独的 sudo 口令（凭据混用只会认证失败，还把特权口令送给主机）。
        #[tokio::test]
        async fn login_password_prompt_gets_the_login_password() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::KiPasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE, "sudo_password": SUDO_PASSWORD }),
                json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("PAM-style KI login must succeed");
            assert_eq!(
                answers.lock().unwrap().as_slice(),
                [LOGIN_PASSWORD.to_string(), MFA_CODE.to_string()],
                "the KI password question must get the login password, never the sudo password"
            );
        }

        /// 合并提问（一条应答同时要密码与验证码）：+合并模式拼接后通过。
        #[tokio::test]
        async fn combined_prompt_gets_password_and_code() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::KiCombined, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({ "authentication": "password", "auth_flow_mode": "password_plus_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("combined prompt must be answered with password + code");
            assert_eq!(
                answers.lock().unwrap().as_slice(),
                [format!("{LOGIN_PASSWORD}{MFA_CODE}")]
            );
        }

        /// 同一条合并提问在「先密码，再 OTP」下也要拼接：只回密码对真正的
        /// 合并提问必然失败（模式差异只影响"OTP 能不能单独先答"，不影响
        /// 合并提问的应答内容）。
        #[tokio::test]
        async fn combined_prompt_gets_password_and_code_in_password_then_otp() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::KiCombined, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE }),
                json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("merged prompt must be answered in the default mode too");
            assert_eq!(
                answers.lock().unwrap().as_slice(),
                [format!("{LOGIN_PASSWORD}{MFA_CODE}")]
            );
        }

        /// global（表单隐藏 2FA 四件套、契约写明凭据由全局配置接管）：登录期
        /// MFA 也必须能读到该配置的 TOTP 与流程模式。
        #[tokio::test]
        async fn global_profile_supplies_login_mfa_credentials() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let mut store = sudo_profiles::SudoProfileStore::default();
            let (profile, _) = sudo_profiles::save_profile(
                &mut store,
                &json!({
                    "name": "ops",
                    "sudoPassword": SUDO_PASSWORD,
                    "totpSecret": MFA_CODE,
                    "authFlowMode": "password_then_otp",
                }),
            )
            .expect("save global profile");
            sudo_profiles::save_store(&runtime.data_dir(), &store).expect("persist profile store");
            let connection = koko_connection(
                port,
                json!({}),
                json!({
                    "authentication": "password",
                    "sudo_source": "global",
                    "sudo_profile": profile.name,
                }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            result.expect("global-profile connection must answer login MFA");
            assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        }

        /// 私钥被接受、服务器还要 MFA：以前直接报 "private-key authentication
        /// was rejected"，现在继续答 keyboard-interactive 验证码（issue #30 的
        /// 私钥反馈）。
        ///
        /// 说明：russh 服务端（0.60/0.63 同）在处理 Auth::Reject 时会把
        /// `partial_success` 无条件清零后回包，mock 服务器因此无法向客户端
        /// 复现"公钥已通过、还差 MFA"这一步——该路径的端到端覆盖交给
        /// `scripts/smoke_login_mfa_test.py`（paramiko 会如实置位）。
        #[tokio::test]
        async fn publickey_partial_success_is_reported_by_russh_server_as_reject() {
            let (port, answers, server) =
                spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
            let runtime = test_runtime();
            let key_text = test_key(2)
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .expect("encode client key");
            let connection = koko_connection(
                port,
                json!({ "totp_secret": MFA_CODE, "private_key": key_text.to_string() }),
                json!({ "authentication": "private-key", "auth_flow_mode": "password_then_otp" }),
            );
            let result = runtime.connect_headless(&connection).await;
            server.abort();
            assert_eq!(
                result.err().as_deref(),
                Some("SSH private-key authentication was rejected"),
                "russh 服务端清零 partial success，客户端据此拒绝继续"
            );
            assert!(answers.lock().unwrap().is_empty());
        }

        #[test]
        fn preserved_permissions_keep_mode_bits_and_drop_everything_else() {
            // Issue #37: the mode's permission bits (including setuid/setgid/
            // sticky) must ride onto the staged file; the file-type bits of
            // st_mode and the uid/gid/size/timestamps must not.
            let target = russh_sftp::protocol::FileAttributes {
                size: Some(12),
                uid: Some(1000),
                gid: Some(1000),
                permissions: Some(0o100755),
                atime: Some(1),
                mtime: Some(2),
                ..Default::default()
            };
            let preserved = preserved_target_permissions(&target).expect("permissions present");
            assert_eq!(preserved.permissions, Some(0o755));
            // Only permission bits travel: the staged file already has its own
            // identity, and SETSTAT on uid/gid needs elevated privileges.
            assert_eq!(preserved.size, None);
            assert_eq!(preserved.uid, None);
            assert_eq!(preserved.user, None);
            assert_eq!(preserved.gid, None);
            assert_eq!(preserved.group, None);
            assert_eq!(preserved.atime, None);
            assert_eq!(preserved.mtime, None);
            let sticky = russh_sftp::protocol::FileAttributes {
                permissions: Some(0o101755),
                ..Default::default()
            };
            let preserved = preserved_target_permissions(&sticky).expect("permissions present");
            assert_eq!(preserved.permissions, Some(0o1755));
        }

        #[test]
        fn preserved_permissions_skip_targets_without_mode_information() {
            // Servers may omit permission attributes entirely; without a mode
            // to preserve there is nothing to SETSTAT.
            let target = russh_sftp::protocol::FileAttributes {
                size: Some(3),
                ..Default::default()
            };
            assert!(preserved_target_permissions(&target).is_none());
        }
    }

    mod host_key_prompt {
        use super::*;
        use dbx_plugin_sdk::{PluginTransport, UserInputAnswer, UserInputPrompt};
        use std::sync::atomic::Ordering;

        struct SharedSink(Arc<Mutex<Vec<u8>>>);

        impl std::io::Write for SharedSink {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        fn events(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<serde_json::Value> {
            String::from_utf8(sink.lock().unwrap().clone())
                .unwrap()
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect()
        }

        fn emitter_for_test() -> (PluginEmitter, Arc<Mutex<Vec<u8>>>) {
            let sink = Arc::new(Mutex::new(Vec::new()));
            (
                dbx_plugin_sdk::PluginEmitter::for_tests(
                    Arc::new(Mutex::new(Box::new(SharedSink(sink.clone())))),
                    PluginTransport::JsonLines,
                ),
                sink,
            )
        }

        struct ScriptedGateway {
            supports: bool,
            answer: Mutex<Result<UserInputAnswer, PluginError>>,
            prompts_seen: Mutex<Vec<serde_json::Value>>,
        }

        impl ScriptedGateway {
            fn supports() -> Self {
                Self {
                    supports: true,
                    answer: Mutex::new(Ok(UserInputAnswer {
                        action: "submit".into(),
                        value: Some("remember".into()),
                    })),
                    prompts_seen: Mutex::new(Vec::new()),
                }
            }
            fn without_feature() -> Self {
                Self {
                    supports: false,
                    answer: Mutex::new(Ok(UserInputAnswer {
                        action: "submit".into(),
                        value: None,
                    })),
                    prompts_seen: Mutex::new(Vec::new()),
                }
            }
            fn answering(answer: Result<UserInputAnswer, PluginError>) -> Self {
                Self {
                    supports: true,
                    answer: Mutex::new(answer),
                    prompts_seen: Mutex::new(Vec::new()),
                }
            }
        }

        impl HostPromptGateway for ScriptedGateway {
            fn supports_request_user_input(&self) -> bool {
                self.supports
            }
            fn request_user_input(
                &self,
                prompt: &UserInputPrompt,
            ) -> Result<UserInputAnswer, PluginError> {
                self.prompts_seen
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(prompt).unwrap());
                self.answer.lock().unwrap().clone()
            }
        }

        const HOST: &str = "server.example.com";
        const FINGERPRINT: &str = "SHA256:abcdefgh";

        async fn challenge_via(
            broker: &PromptBroker,
            emitter: &PluginEmitter,
        ) -> Option<PromptDecision> {
            broker
                .request(
                    HOST,
                    22,
                    "ssh-ed25519".into(),
                    FINGERPRINT.into(),
                    "conn-1",
                    "op-1",
                    emitter,
                )
                .await
        }

        #[tokio::test]
        async fn host_dialog_submit_remember_maps_to_accept_and_remember() {
            let gateway = Arc::new(ScriptedGateway::supports());
            let broker = PromptBroker::with_gateway(gateway.clone());
            let (emitter, sink) = emitter_for_test();

            let decision = challenge_via(&broker, &emitter).await;

            assert_eq!(
                decision,
                Some(PromptDecision {
                    accept: true,
                    remember: true
                })
            );
            assert!(events(&sink)
                .iter()
                .all(|event| event["method"] != "connection/challenge"));
            let prompt = gateway.prompts_seen.lock().unwrap()[0].clone();
            assert_eq!(prompt["options"][0]["value"], "accept");
            assert_eq!(prompt["options"][1]["value"], "remember");
            assert!(prompt["prompt"].as_str().unwrap().contains(FINGERPRINT));
            assert!(broker.challenge_was_raised());
            // The dialog took the challenge: connection/test may extend its
            // budget for exactly this probe.
            assert!(broker.host_dialog_was_used());
        }

        #[tokio::test]
        async fn host_dialog_accept_maps_to_accept_without_remember() {
            let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
                action: "submit".into(),
                value: Some("accept".into()),
            })));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, _sink) = emitter_for_test();
            assert_eq!(
                challenge_via(&broker, &emitter).await,
                Some(PromptDecision {
                    accept: true,
                    remember: false
                })
            );
        }

        #[tokio::test]
        async fn host_dialog_cancel_and_timeout_reject_fail_closed() {
            for action in ["cancel", "timeout"] {
                let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
                    action: action.into(),
                    value: None,
                })));
                let broker = PromptBroker::with_gateway(gateway);
                let (emitter, sink) = emitter_for_test();
                assert_eq!(
                    challenge_via(&broker, &emitter).await,
                    Some(PromptDecision {
                        accept: false,
                        remember: false
                    })
                );
                assert!(events(&sink)
                    .iter()
                    .all(|event| event["method"] != "connection/challenge"));
            }
        }

        #[tokio::test]
        async fn host_without_feature_falls_back_to_workbench_event() {
            let gateway = Arc::new(ScriptedGateway::without_feature());
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();

            let pending = tokio::spawn({
                let broker = broker.clone();
                let emitter = emitter.clone();
                async move {
                    broker
                        .request(
                            HOST,
                            22,
                            "ssh-ed25519".into(),
                            FINGERPRINT.into(),
                            "conn-1",
                            "op-1",
                            &emitter,
                        )
                        .await
                }
            });
            // 降级路径必须发出既有事件载荷(workbench 依赖 challengeId/kind 字段)。
            let mut challenge_id = None;
            for _ in 0..200 {
                if let Some(event) = events(&sink)
                    .into_iter()
                    .find(|event| event["method"] == "connection/challenge")
                {
                    challenge_id =
                        Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                    assert_eq!(event["params"]["kind"], "host-key");
                    assert_eq!(event["params"]["fingerprint"], FINGERPRINT);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            let challenge_id = challenge_id.expect("legacy challenge event must be emitted");
            broker
                .resolve(
                    &challenge_id,
                    "op-1",
                    PromptDecision {
                        accept: true,
                        remember: true,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                pending.await.unwrap(),
                Some(PromptDecision {
                    accept: true,
                    remember: true
                })
            );
        }

        #[tokio::test]
        async fn no_ui_error_falls_back_to_workbench_event() {
            let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
                -32001,
                "no user interface is attached",
            ))));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();
            let pending = tokio::spawn({
                let broker = broker.clone();
                let emitter = emitter.clone();
                async move {
                    broker
                        .request(
                            HOST,
                            22,
                            "ssh-ed25519".into(),
                            FINGERPRINT.into(),
                            "conn-1",
                            "op-1",
                            &emitter,
                        )
                        .await
                }
            });
            let mut challenge_id = None;
            for _ in 0..200 {
                if let Some(event) = events(&sink)
                    .into_iter()
                    .find(|event| event["method"] == "connection/challenge")
                {
                    challenge_id =
                        Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            broker
                .resolve(
                    &challenge_id.expect("fallback event"),
                    "op-1",
                    PromptDecision {
                        accept: false,
                        remember: false,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                pending.await.unwrap(),
                Some(PromptDecision {
                    accept: false,
                    remember: false
                })
            );
            // A degradable failure fell back to the workbench event: the
            // dialog must not keep the extended test budget armed.
            assert!(!broker.host_dialog_was_used());
        }

        #[tokio::test]
        async fn host_dialog_marks_used_and_degraded_fallback_does_not() {
            // 粘性标志的语义:弹窗真正接管挑战时置位(connection/test 据此重臂
            // 预算);可降级错误回落 legacy 前必须清零,1.0 宿主保持短预算。
            let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
                -32601,
                "method not found",
            ))));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();
            let pending = tokio::spawn({
                let broker = broker.clone();
                let emitter = emitter.clone();
                async move {
                    broker
                        .request(
                            HOST,
                            22,
                            "ssh-ed25519".into(),
                            FINGERPRINT.into(),
                            "conn-1",
                            "op-1",
                            &emitter,
                        )
                        .await
                }
            });
            let mut challenge_id = None;
            for _ in 0..200 {
                if let Some(event) = events(&sink)
                    .into_iter()
                    .find(|event| event["method"] == "connection/challenge")
                {
                    challenge_id =
                        Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            // Once the legacy event is out, the dialog flag must already be
            // cleared again.
            assert!(!broker.host_dialog_was_used());
            broker
                .resolve(
                    &challenge_id.expect("fallback event"),
                    "op-1",
                    PromptDecision {
                        accept: true,
                        remember: false,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                pending.await.unwrap(),
                Some(PromptDecision {
                    accept: true,
                    remember: false
                })
            );
            assert!(!broker.host_dialog_was_used());
        }

        #[tokio::test]
        async fn host_silence_fails_closed_without_fallback() {
            // SDK 本地超时的错误以 -32001 + "did not answer" 表达;此时再降级会
            // 把总等待拖到 630s,必须直接拒绝。
            let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
                -32001,
                "Host did not answer 'host/requestUserInput' in time",
            ))));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();
            assert_eq!(challenge_via(&broker, &emitter).await, None);
            assert!(events(&sink)
                .iter()
                .all(|event| event["method"] != "connection/challenge"));
        }

        #[tokio::test]
        async fn host_dialog_submit_without_known_value_rejects_fail_closed() {
            // Only an explicit accept/remember value grants trust: a missing
            // or unknown value (host sent action=submit with nothing usable)
            // must be a rejection, never a guess.
            for value in [None, Some("maybe".to_string())] {
                let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
                    action: "submit".into(),
                    value,
                })));
                let broker = PromptBroker::with_gateway(gateway);
                let (emitter, sink) = emitter_for_test();
                assert_eq!(
                    challenge_via(&broker, &emitter).await,
                    Some(PromptDecision {
                        accept: false,
                        remember: false
                    })
                );
                assert!(events(&sink)
                    .iter()
                    .all(|event| event["method"] != "connection/challenge"));
            }
        }

        #[tokio::test]
        async fn challenge_raised_flag_clears_between_probes() {
            let gateway = Arc::new(ScriptedGateway::supports());
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, _sink) = emitter_for_test();
            broker.challenge_raised.store(true, Ordering::Relaxed);
            broker.clear_challenge_raised();
            let _ = challenge_via(&broker, &emitter).await;
            assert!(broker.challenge_was_raised());
            assert!(broker.host_dialog_was_used());
            broker.clear_challenge_raised();
            // One clear entry resets both sticky challenge marks so the next
            // probe starts from a clean slate.
            assert!(!broker.challenge_was_raised());
            assert!(!broker.host_dialog_was_used());
        }

        #[test]
        fn challenge_flag_clears_between_probes() {
            let gateway = Arc::new(ScriptedGateway::without_feature());
            let broker = PromptBroker::with_gateway(gateway);
            broker
                .challenge_raised
                .store(true, std::sync::atomic::Ordering::Relaxed);
            broker.clear_challenge_raised();
            assert!(!broker.challenge_was_raised());
        }
    }
}
