use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use dbx_plugin_sdk::{PluginEmitter, PluginError};
use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::{client::AgentClient, AgentIdentity};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, MethodKind};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
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
use crate::highlight_rules;
use crate::host_key::{HostKeyState, HostKeyVerifier};
use crate::local_downloads;
use crate::metrics;
use crate::metrics_history;
use crate::model::{
    normalize_remote_path, path_from_sftp_uri, sftp_uri, AuthenticationMethod, SftpEntry,
    StoredConnection, SudoSource, TerminalFrame, TerminalStream, MAX_TRANSFER_SIZE,
    TERMINAL_REPLAY_LIMIT, TRANSFER_CHUNK_SIZE,
};
use crate::quick_commands;
use crate::session_recording;
use crate::ssh_algorithms;
use crate::sudo_profiles;
use crate::transfer_history;
use crate::triggers;

/// Resolves the Quick Sudo / 2FA orchestration settings for a connection.
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
    auth
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

#[derive(Debug, Clone, Copy)]
pub struct PromptDecision {
    pub accept: bool,
    pub remember: bool,
}

#[derive(Clone, Default)]
pub struct PromptBroker {
    pending: Arc<AsyncMutex<HashMap<String, PendingPrompt>>>,
}

struct PendingPrompt {
    operation_id: String,
    sender: oneshot::Sender<PromptDecision>,
}

impl PromptBroker {
    // 参数就是 host-key 挑战事件的载荷字段，一一对应而非可归组的耦合。
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

#[derive(Default)]
struct ReplayBuffer {
    frames: VecDeque<TerminalFrame>,
    bytes: usize,
    sequence: u64,
}

impl ReplayBuffer {
    fn push(&mut self, stream: TerminalStream, data: Vec<u8>) -> TerminalFrame {
        self.sequence += 1;
        let frame = TerminalFrame {
            sequence: self.sequence,
            stream,
            data,
        };
        self.bytes += frame.data.len();
        self.frames.push_back(frame.clone());
        while self.bytes > TERMINAL_REPLAY_LIMIT {
            let Some(removed) = self.frames.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.data.len());
        }
        frame
    }

    fn after(&self, sequence: u64) -> Vec<TerminalFrame> {
        self.frames
            .iter()
            .filter(|frame| frame.sequence > sequence)
            .cloned()
            .collect()
    }

    fn first_sequence(&self) -> u64 {
        self.frames
            .front()
            .map(|frame| frame.sequence)
            .unwrap_or(self.sequence.saturating_add(1))
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
    handle: Arc<Handle<SshClient>>,
    /// Open jump-host connections that carry this session's target tunnel;
    /// kept alive alongside the target handle.
    jump_chain: Vec<Arc<Handle<SshClient>>>,
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
    remote_path: String,
    file_name: String,
    size: u64,
    next_offset: u64,
    sink: Option<Arc<DownloadSink>>,
}

struct FinishingUpload {
    session_id: String,
    remote_path: String,
    size: u64,
    transferred: Arc<AtomicU64>,
    cancelled: Arc<AtomicBool>,
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
    /// Trust-on-first-use for unknown host keys (MCP stdio mode).
    auto_trust: bool,
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
            sudo_keepalive: Arc::new(Mutex::new(HashMap::new())),
            metrics_cache: Mutex::new(HashMap::new()),
            exec_tasks: Mutex::new(HashMap::new()),
            agent_modes: Mutex::new(agent_terminal::load_modes(&data_dir)),
            agent_challenges: Mutex::new(HashMap::new()),
            auto_trust: false,
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
        connection_id: &str,
        workbench_id: &str,
        cols: u32,
        rows: u32,
        operation_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or("Connection is not active; reopen it from DBX")?;
        eprintln!(
            "[ssh-trace] open_session connection_id={connection_id} workbench_id={workbench_id} -> {}:{} auth={:?}",
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
        let handle = Arc::new(handle);
        let jump_chain = jump_chain.into_iter().map(Arc::new).collect::<Vec<_>>();
        let remote_shell = detect_remote_shell(&handle).await;
        let directory_tracking_supported = remote_shell.supports_directory_tracking();
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SSH terminal channel: {error}"))?;
        channel
            .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
            .await
            .map_err(|error| format!("Failed to request SSH PTY: {error}"))?;
        // Client-specified SetEnv rides on the interactive session too, in
        // ssh(1) order: PTY first, env next, shell/exec last. A refused
        // variable surfaces instead of half-configuring the session.
        exec::apply_connection_env(&mut channel, &connection.set_env).await?;
        if connection.remote_command.is_empty() {
            channel
                .request_shell(true)
                .await
                .map_err(|error| format!("Failed to start SSH shell: {error}"))?;
        } else {
            // `ssh RemoteCommand`: exec the configured command instead of a
            // shell, with the PTY still requested. Like ssh(1), every
            // (re)connect replays the same command - a dropped session that
            // the workbench reopens intentionally runs it again.
            channel
                .exec(true, connection.remote_command.as_bytes())
                .await
                .map_err(|error| format!("Failed to start remote command: {error}"))?;
        }

        let session_id = Uuid::new_v4().to_string();
        let (terminal_tx, mut terminal_rx) = mpsc::channel(256);
        let replay = Arc::new(AsyncMutex::new(ReplayBuffer::default()));
        let bound_profile = {
            let store = sudo_profiles::load_store(&self.data_dir);
            effective_sudo_profile(&connection, &store)
        };
        let orchestration = Arc::new(RwLock::new(resolved_sudo_auth(
            &connection,
            bound_profile.as_ref(),
        )));
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
            handle,
            jump_chain,
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

        let task_id = session_id.clone();
        let directory_marker_id = session_id.clone();
        let sessions = self.sessions.clone();
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
            sessions.write().await.remove(&task_id);
        });

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
        let (handle, jumps) = self
            .connect_authenticated(connection, operation_id, Some(emitter))
            .await?;
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
        let orchestration = sudo_auth_for(connection);

        match connection.authentication {
            AuthenticationMethod::Password => {
                authenticate_password_or_interactive(
                    &mut session,
                    connection,
                    &orchestration,
                    &none,
                )
                .await?;
            }
            AuthenticationMethod::PrivateKey => {
                authenticate_private_key(&mut session, connection).await?;
            }
            AuthenticationMethod::PrivateKeyPassword => {
                let key_result = authenticate_private_key_result(&mut session, connection).await?;
                if !key_result.success() {
                    authenticate_password_or_interactive(
                        &mut session,
                        connection,
                        &orchestration,
                        &key_result,
                    )
                    .await?;
                }
            }
            AuthenticationMethod::Agent => {
                authenticate_agent(&mut session, connection).await?;
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

    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("SSH session was not found")?;
        let _ = session.terminal_tx.send(TerminalCommand::Close).await;
        for jump in &session.jump_chain {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH session closed",
                    "English",
                )
                .await;
        }
        self.cleanup_session_transfers(session_id)?;
        if let Ok(mut cache) = self.metrics_cache.lock() {
            cache.remove(session_id);
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
                .ok_or("SSH session was not found")?
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
        let sftp = Arc::new(AsyncMutex::new(
            SftpSession::new(channel.into_stream())
                .await
                .map_err(sftp_error)?,
        ));
        *current = Some(sftp.clone());
        Ok(sftp)
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

    pub async fn session_id_for_connection(&self, connection_id: &str) -> Result<String, String> {
        self.sessions
            .read()
            .await
            .iter()
            .find(|(_, session)| {
                session.connection_id == connection_id && session.connected.load(Ordering::Acquire)
            })
            .map(|(id, _)| id.clone())
            .ok_or("No active SSH session exists for this connection".to_string())
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

    pub async fn sftp_list_path(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<Vec<SftpEntry>, String> {
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
        let entries = sftp.lock().await.read_dir(path).await.map_err(sftp_error)?;
        let mut result = entries
            .map(|entry| {
                let metadata = entry.metadata();
                let kind = match entry.file_type() {
                    FileType::File => "file",
                    FileType::Dir => "directory",
                    FileType::Symlink => "symlink",
                    FileType::Other => "other",
                };
                SftpEntry {
                    name: entry.file_name(),
                    uri: sftp_uri(&entry.path()),
                    kind,
                    size: metadata.size,
                    modified_at: metadata.mtime.map(u64::from),
                    permissions: metadata.permissions.map(format_permissions),
                    content_type: content_type_for_path(&entry.path()),
                }
            })
            .collect::<Vec<_>>();
        result.sort_by(|left, right| {
            let left_dir = left.kind == "directory";
            let right_dir = right.kind == "directory";
            right_dir
                .cmp(&left_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(result)
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

    pub async fn sftp_create_directory(&self, session_id: &str, path: &str) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let sftp = self.sftp(session_id).await?;
        let result = sftp
            .lock()
            .await
            .create_dir(normalize_remote_path(path)?)
            .await
            .map_err(sftp_error);
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
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let sftp = self.sftp(session_id).await?;
        let result = sftp
            .lock()
            .await
            .rename(
                normalize_remote_path(source)?,
                normalize_remote_path(target)?,
            )
            .await
            .map_err(sftp_error);
        result
    }

    pub async fn sftp_delete(
        &self,
        session_id: &str,
        path: &str,
        recursive: bool,
    ) -> Result<(), String> {
        self.ensure_writable(session_id).await?;
        let sftp = self.sftp(session_id).await?;
        let path = normalize_remote_path(path)?;
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
        if self.active_transfer_count(&session_id)? >= 3 {
            return Err("This SSH session already has three active transfers".to_string());
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
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": file_name, "transferred": resume_offset, "size": size, "status": "running" }),
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
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": file_name, "transferred": 0, "size": size, "status": "queued" }),
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
                json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "transferred": upload.received, "size": upload.expected_size, "status": "running" }),
            )
            .map_err(plugin_error)?;
        emitter
            .event(
                "sftp/upload/ack",
                json!({ "taskId": task_id, "offset": offset, "length": chunk.len(), "nextOffset": upload.received }),
            )
            .map_err(plugin_error)
    }

    pub async fn finish_upload(
        &self,
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
                },
            );
        let result: Result<(), String> = async {
            let sftp = self.sftp(&session_id).await?;
            let (temporary, backup) = remote_transfer_paths(&remote_path, task_id)?;
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
                    drop(target);
                    let _ = sftp.lock().await.remove_file(temporary.clone()).await;
                    return Err("Upload cancelled".to_string());
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
                        json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "transferred": transferred, "size": expected_size, "status": "running" }),
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
        self.finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .remove(task_id);
        let _ = tokio::fs::remove_file(&local_path).await;
        remove_upload_meta(&self.transfer_dir, task_id);
        match result {
            Ok(()) => {
                let task = json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": remote_path.rsplit('/').next().unwrap_or("upload"), "transferred": expected_size, "size": expected_size, "status": "completed" });
                self.record_transfer(task.clone());
                emitter
                    .event("sftp/transfer/progress", task)
                    .map_err(plugin_error)?;
                Ok(json!({ "success": true, "taskId": task_id, "transferred": expected_size }))
            }
            Err(error) => {
                let status = if cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "failed"
                };
                let task = json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": remote_path.rsplit('/').next().unwrap_or("upload"), "transferred": transferred_bytes.load(Ordering::Acquire), "size": expected_size, "status": status, "error": error });
                self.record_transfer(task.clone());
                let _ = emitter.event("sftp/transfer/progress", task);
                Err(error)
            }
        }
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
        if self.active_transfer_count(session_id)? >= 3 {
            return Err("This SSH session already has three active transfers".to_string());
        }
        // Resume re-attaches with bytes the caller already holds locally, which
        // the staging file would be missing — only fresh downloads may sink.
        if save_to_local && offset > 0 {
            return Err("Local save downloads cannot resume from an offset".to_string());
        }
        let sftp = self.sftp(session_id).await?;
        let size = sftp
            .lock()
            .await
            .metadata(remote_path.clone())
            .await
            .map_err(sftp_error)?
            .size
            .unwrap_or(0);
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
        let sink = if save_to_local {
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
            Some(Arc::new(DownloadSink {
                part_path,
                final_dir,
                overwrite: matches!(conflict, Some("overwrite")),
                file: AsyncMutex::new(file),
            }))
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
                    remote_path,
                    file_name: file_name.clone(),
                    size,
                    next_offset: offset,
                    sink,
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
        if offset != download.next_offset {
            return Err(format!(
                "Download offset mismatch: expected {}, received {offset}",
                download.next_offset
            ));
        }
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
        let remaining = download.size.saturating_sub(offset);
        let requested = remaining.min(TRANSFER_CHUNK_SIZE as u64) as usize;
        let mut chunk = vec![0_u8; requested];
        let length = source
            .read(&mut chunk)
            .await
            .map_err(|error| format!("SFTP download failed: {error}"))?;
        chunk.truncate(length);
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

    pub fn cancel_transfer(&self, task_id: &str, emitter: &PluginEmitter) -> Result<(), String> {
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
                json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.size, "transferred": upload.transferred.load(Ordering::Acquire), "status": "cancelled" })
            });
        if let Some(upload) = upload.as_ref() {
            let _ = std::fs::remove_file(&upload.local_path);
            remove_upload_meta(&self.transfer_dir, task_id);
        }
        if let Some(download) = download.as_ref() {
            if let Some(sink) = download.sink.as_ref() {
                let _ = std::fs::remove_file(&sink.part_path);
            }
        }
        if upload.is_none() && download.is_none() && finishing.is_none() {
            return Err("Transfer task was not found".to_string());
        }
        let task = upload
            .as_ref()
            .map(|upload| json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.expected_size, "transferred": upload.received, "status": "cancelled" }))
            .or_else(|| download.as_ref().map(|download| json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "cancelled" })))
            .or(finishing)
            .expect("a transfer was present");
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
        tasks.extend(uploads
            .iter()
            .filter(|(_, upload)| upload.session_id == session_id)
            .map(|(task_id, upload)| {
                json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.expected_size, "transferred": upload.received, "status": "running" })
            })
            .collect::<Vec<_>>());
        tasks.extend(
            finishing_uploads
                .iter()
                .filter(|(_, upload)| upload.session_id == session_id)
                .map(|(task_id, upload)| {
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "upload", "fileName": upload.remote_path.rsplit('/').next().unwrap_or("upload"), "size": upload.size, "transferred": upload.transferred.load(Ordering::Acquire), "status": if upload.cancelled.load(Ordering::Acquire) { "cancelled" } else { "running" } })
                }),
        );
        tasks.extend(
            downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .map(|(task_id, download)| {
                    json!({ "taskId": task_id, "sessionId": session_id, "direction": "download", "fileName": download.file_name, "size": download.size, "transferred": download.next_offset, "status": "running" })
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
            return Ok(
                json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "size": upload.expected_size, "transferred": upload.received, "status": "running" }),
            );
        }
        if let Some(upload) = self
            .finishing_uploads
            .lock()
            .map_err(|_| "Finishing upload registry is poisoned".to_string())?
            .get(task_id)
        {
            return Ok(
                json!({ "taskId": task_id, "sessionId": upload.session_id, "direction": "upload", "size": upload.size, "transferred": upload.transferred.load(Ordering::Acquire), "status": if upload.cancelled.load(Ordering::Acquire) { "cancelled" } else { "running" } }),
            );
        }
        if let Some(download) = self
            .downloads
            .lock()
            .map_err(|_| "Download registry is poisoned".to_string())?
            .get(task_id)
        {
            return Ok(
                json!({ "taskId": task_id, "sessionId": download.session_id, "direction": "download", "size": download.size, "transferred": download.next_offset, "status": "running" }),
            );
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
        // Newest first by startedAt; rows without one sort last (stable).
        tasks.sort_by(|a, b| {
            let started = |task: &Value| task.get("startedAt").and_then(Value::as_u64).unwrap_or(0);
            started(b).cmp(&started(a))
        });
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

/// Tries password authentication first, then keyboard-interactive. The
/// `offered` result of the preceding auth attempt tells which methods the
/// server still accepts. Keyboard-interactive rounds are auto-answered from
/// the Quick Sudo orchestration config, covering PAM 2FA/TOTP logins.
async fn authenticate_password_or_interactive(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
    offered: &AuthResult,
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
            eprintln!("[ssh-trace] auth: falling back to keyboard-interactive");
            return authenticate_keyboard_interactive(session, connection, orchestration).await;
        }
        return Err("SSH password authentication was rejected".to_string());
    }
    if method_offered(offered, MethodKind::KeyboardInteractive) {
        eprintln!("[ssh-trace] auth: keyboard-interactive only, starting");
        // Servers with PasswordAuthentication disabled still accept the
        // password through keyboard-interactive (PAM), including hosts that
        // ask a 2FA/TOTP follow-up question.
        return authenticate_keyboard_interactive(session, connection, orchestration).await;
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

/// Drives a keyboard-interactive handshake, answering each round from the
/// orchestration config (password plus optional TOTP follow-ups).
async fn authenticate_keyboard_interactive(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
    orchestration: &SudoAuth,
) -> Result<(), String> {
    let timeout = Duration::from_secs(connection.connect_timeout_secs);
    let mut state = exec::KeyboardInteractiveState::default();
    let mut response = tokio::time::timeout(
        timeout,
        session.authenticate_keyboard_interactive_start(&connection.username, None),
    )
    .await
    .map_err(|_| "SSH keyboard-interactive authentication timed out".to_string())?
    .map_err(|error| format!("SSH keyboard-interactive authentication failed: {error}"))?;
    for _ in 0..4 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("SSH keyboard-interactive authentication was rejected".to_string());
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers =
                    exec::keyboard_interactive_answers(orchestration, &mut state, &prompts);
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
    Err("SSH keyboard-interactive authentication did not finish".to_string())
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
    let private_key =
        decoded.map_err(|error| format!("Failed to decode SSH private key: {error}"))?;
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
fn normalize_private_key_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.strip_prefix('\u{feff}').unwrap_or(&normalized);
    normalized.trim_start().to_string()
}

async fn authenticate_private_key(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<(), String> {
    if authenticate_private_key_result(session, connection)
        .await?
        .success()
    {
        Ok(())
    } else {
        Err("SSH private-key authentication was rejected".to_string())
    }
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

async fn authenticate_agent(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<(), String> {
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
    let authenticated = tokio::time::timeout(
        Duration::from_secs(connection.connect_timeout_secs),
        async {
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
                if result.is_ok_and(|result| result.success()) {
                    return true;
                }
            }
            false
        },
    )
    .await
    .map_err(|_| "SSH Agent authentication timed out".to_string())?;
    authenticated
        .then_some(())
        .ok_or_else(|| "No SSH Agent identity was accepted".to_string())
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

async fn commit_remote_file(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: &str,
    backup: &str,
) -> Result<(), String> {
    let target_exists = sftp.lock().await.metadata(target.to_string()).await.is_ok();
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
    fn replay_buffer_is_sequence_addressable() {
        let mut replay = ReplayBuffer::default();
        replay.push(TerminalStream::Stdout, b"one".to_vec());
        replay.push(TerminalStream::Stderr, b"two".to_vec());
        let frames = replay.after(1);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 2);
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
}
