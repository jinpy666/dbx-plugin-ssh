//! Scheduler Task Provider (`io.dbx.ssh.tasks`) — the plugin side of the
//! frozen Scheduler / Task Center contract
//! (`integration/docs/adr/scheduler-task-contract.md` §6).
//!
//! Division of labor: the host Scheduler owns trigger / queue / retry /
//! timeout policy / cancel bookkeeping / run state persistence; this module
//! owns the SSH protocol side — dialing through the existing connection
//! lifecycle, streaming stdout/stderr, honoring cancel with a real remote
//! teardown, resident supervision with a bounded restart policy, and
//! heartbeats.
//!
//! Hard rules enforced here:
//! - Only the five fixed RPCs exist (`task/validate|execute|start|stop|
//!   status`); there is deliberately no `ssh/runScheduledCommand`-style
//!   provider-specific surface.
//! - Credentials never enter task config, params, logs or events: task
//!   config carries a `connectionId`, the command text and env only, and
//!   every emitted line goes through [`Redactor`] with the connection's
//!   secret material before it leaves the process.
//! - Cancel/timeout actually stop the remote process: the channel is
//!   closed (`EOF` + `CLOSE`) so sshd reaps the command instead of leaking
//!   it — same invariant as `exec::exec_plain_cancellable`.
//! - Resident restarts are bounded (`max_restarts` within
//!   `restart_window_seconds`); exceeding the bound degrades the session
//!   instead of crash-looping forever.
//!
//! Run-mode executes are synchronous on purpose: the request future resolves
//! with the final `{success, exitCode, message, artifacts}` payload, and the
//! host's own execution-policy timeout plus `task/stop` remain the external
//! cancel paths.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dbx_plugin_sdk::PluginEmitter;
use russh::client::Handle;
use russh::ChannelMsg;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::ssh::{SshClient, SshRuntime};

/// Machine-readable error codes prefixed onto RPC error strings. The host
/// maps these onto `TaskError` kinds / reserved `error_code` vocabulary
/// (ADR §5.4/§8.4): `invalid_config` / `connection_missing` /
/// `permission_denied` are non-retryable, `timeout` / `cancelled` map to
/// their run states, everything unprefixed stays a plain transport failure.
pub(crate) const CODE_INVALID_CONFIG: &str = "invalid_config";
pub(crate) const CODE_CONNECTION_MISSING: &str = "connection_missing";
pub(crate) const CODE_TIMEOUT: &str = "timeout";
pub(crate) const CODE_CANCELLED: &str = "cancelled";

const TRIGGERS: [&str; 2] = ["execute", "resident"];

/// Per-stream partial-line flush cap: a silent `tail -F` writing one giant
/// line must still produce visible log events instead of buffering forever.
const PARTIAL_LINE_LIMIT: usize = 8192;
/// Resident heartbeat cadence while the channel is alive: a quiet `tail -F`
/// produces no output chunks, so the ticker is what advances `heartbeatAt`
/// for the host supervisor.
const RESIDENT_HEARTBEAT_SECS: u64 = 20;
/// Config-independent restart ceiling: even a misconfigured task cannot ask
/// the supervisor for an unbounded loop.
const HARD_MAX_RESTARTS: u32 = 50;
/// Backoff floor: an immediate restart storm on a dead endpoint is worse
/// than a slightly slow one.
const MIN_RESTART_BACKOFF_SECS: u64 = 1;

fn task_error(code: &str, message: impl std::fmt::Display) -> String {
    format!("{code}: {message}")
}

// ---------------------------------------------------------------------------
// Task config
// ---------------------------------------------------------------------------

/// Provider-side snapshot of one task invocation's config. Keys follow the
/// manifest form-field keys (`snake_case`, `binding: "config"`); the host
/// forwards the form values verbatim inside `task.config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskConfig {
    pub command: String,
    pub working_directory: String,
    pub environment: Vec<(String, String)>,
    /// Run-mode only: plugin-side wall-clock deadline. Absent means the host
    /// execution policy owns the timeout (`timeout` is still reported when
    /// the host cancels for its own deadline).
    pub timeout_seconds: Option<u64>,
    /// Request a PTY: output becomes a single merged stream (PTY merges
    /// stderr into stdout by SSH protocol semantics), documented trade-off
    /// for commands that need a TTY.
    pub pty: bool,
    /// Resident-mode only: bounded restart policy (ADR §2.5 execution-side
    /// mirror). Clamped by [`RestartPolicy::parse`] into the hard bounds.
    pub restart: RestartPolicy,
}

/// Bounded restart policy for resident sessions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestartPolicy {
    pub max_restarts: u32,
    pub backoff_seconds: u64,
    /// Sliding window the restart count applies to; `None` counts over the
    /// sidecar process lifetime.
    pub window_seconds: Option<u64>,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: 5,
            backoff_seconds: 10,
            window_seconds: None,
        }
    }
}

impl RestartPolicy {
    fn parse(value: &Value, errors: &mut Vec<String>) -> Self {
        let mut policy = Self::default();
        if let Some(raw) = value.get("max_restarts") {
            match raw.as_u64().map(|n| u32::try_from(n).ok()) {
                Some(Some(n)) if n <= HARD_MAX_RESTARTS => policy.max_restarts = n,
                _ => errors.push(format!(
                    "max_restarts must be an integer between 0 and {HARD_MAX_RESTARTS}"
                )),
            }
        }
        if let Some(raw) = value.get("restart_backoff_seconds") {
            match raw.as_u64() {
                Some(n) if (MIN_RESTART_BACKOFF_SECS..=3600).contains(&n) => {
                    policy.backoff_seconds = n;
                }
                _ => errors.push(format!(
                    "restart_backoff_seconds must be between {MIN_RESTART_BACKOFF_SECS} and 3600"
                )),
            }
        }
        if let Some(raw) = value.get("restart_window_seconds") {
            match raw.as_u64() {
                Some(n) if (1..=86_400).contains(&n) => policy.window_seconds = Some(n),
                _ => errors.push("restart_window_seconds must be between 1 and 86400".to_string()),
            }
        }
        policy
    }

    /// Pure restart-budget decision: `history` holds the instants of past
    /// restarts. A restart is allowed only while the (window-pruned) history
    /// still has budget left; otherwise the caller degrades the session.
    fn restart_allowed(&self, history: &[Instant], now: Instant) -> bool {
        let recent = match self.window_seconds {
            Some(window) => {
                let cutoff = now.checked_sub(Duration::from_secs(window));
                history
                    .iter()
                    .copied()
                    .filter(|instant| cutoff.is_none_or(|cutoff| *instant >= cutoff))
                    .count()
            }
            None => history.len(),
        };
        recent < self.max_restarts as usize
    }
}

/// Parses one `KEY=VALUE` environment entry. Keys must be valid POSIX
/// variable names; values must not carry raw newlines (they would break the
/// `export` script framing).
fn parse_env_entry(entry: &str) -> Result<(String, String), String> {
    let Some((key, value)) = entry.split_once('=') else {
        return Err(format!("environment entry {entry:?} must be KEY=VALUE"));
    };
    let key = key.trim();
    let valid_key = !key.is_empty()
        && key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid_key {
        return Err(format!(
            "environment key {key:?} must match [A-Za-z_][A-Za-z0-9_]*"
        ));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(format!(
            "environment value for {key:?} must not contain line breaks"
        ));
    }
    Ok((key.to_string(), value.to_string()))
}

/// Collects (not first-fail) validation errors so the host form can show
/// every problem at once; `warnings` carries non-fatal observations.
fn validate_task_config(trigger_id: &str, config: &Value) -> (Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if !TRIGGERS.contains(&trigger_id) {
        errors.push(format!(
            "unknown trigger {trigger_id:?}; expected one of {TRIGGERS:?}"
        ));
    }
    let command = config
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if command.is_empty() {
        errors.push("command is required".to_string());
    }
    if let Some(environment) = config.get("environment").and_then(Value::as_str) {
        for line in environment.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Err(error) = parse_env_entry(line) {
                errors.push(error);
            }
        }
    } else if config.get("environment").is_some() {
        errors.push("environment must be a multi-line KEY=VALUE string".to_string());
    }
    if let Some(raw) = config.get("timeout_seconds") {
        match raw.as_u64() {
            Some(n) if (1..=86_400).contains(&n) => {}
            _ => errors.push("timeout_seconds must be an integer between 1 and 86400".to_string()),
        }
    }
    if let Some(raw) = config.get("pty") {
        if raw.as_bool().is_none() {
            errors.push("pty must be a boolean".to_string());
        } else if raw.as_bool() == Some(true) {
            warnings.push(
                "with pty enabled stdout and stderr arrive merged on the stdout stream".to_string(),
            );
        }
    }
    // Restart knobs are only meaningful for the resident trigger; unknown
    // keys elsewhere are a typo the form would silently swallow.
    if trigger_id != "resident" {
        for key in [
            "max_restarts",
            "restart_backoff_seconds",
            "restart_window_seconds",
        ] {
            if config.get(key).is_some() {
                warnings.push(format!("{key} only applies to the resident trigger"));
            }
        }
    }
    if trigger_id == "resident" {
        RestartPolicy::parse(config, &mut errors);
    }
    (errors, warnings)
}

impl TaskConfig {
    /// Strict parse for execution paths: any validation error fails the run
    /// up front (non-retryable `invalid_config`).
    fn parse(trigger_id: &str, config: &Value) -> Result<Self, String> {
        let (errors, _warnings) = validate_task_config(trigger_id, config);
        if let Some(error) = errors.first() {
            return Err(task_error(CODE_INVALID_CONFIG, error.clone()));
        }
        let command = config
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let environment = config
            .get("environment")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                (!line.is_empty())
                    .then(|| parse_env_entry(line).ok())
                    .flatten()
            })
            .collect();
        Ok(Self {
            command,
            working_directory: config
                .get("working_directory")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string(),
            environment,
            timeout_seconds: config
                .get("timeout_seconds")
                .and_then(Value::as_u64)
                .filter(|n| (1..=86_400).contains(n)),
            pty: config.get("pty").and_then(Value::as_bool).unwrap_or(false),
            restart: {
                let mut errors = Vec::new();
                RestartPolicy::parse(config, &mut errors)
            },
        })
    }
}

/// POSIX single-quoted shell literal (`'` → `'\''`).
fn shell_single_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Builds the remote script: exports first, then an optional guarded
/// `cd`, then the user command as the last line so the channel's exit
/// status is the command's own. Multi-line on purpose — `cd X && cmd`
/// would leak later statements out of the directory.
fn build_script(config: &TaskConfig) -> String {
    let mut lines = Vec::new();
    for (key, value) in &config.environment {
        lines.push(format!("export {}={}", key, shell_single_quote(value)));
    }
    if !config.working_directory.is_empty() {
        // 125: distinct from typical command failures so a bad directory is
        // recognizable in exit codes; the following lines never run.
        lines.push(format!(
            "cd {} || exit 125",
            shell_single_quote(&config.working_directory)
        ));
    }
    lines.push(config.command.clone());
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Secret redaction (ADR §10: logs/events never carry credential material)
// ---------------------------------------------------------------------------

/// Accumulates connection secret material and scrubs it from every emitted
/// message. Values shorter than 4 chars are ignored (redacting "a" would
/// mangle normal text while leaking nothing meaningful).
#[derive(Default)]
pub(crate) struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    fn add(&mut self, secret: &str) {
        let secret = secret.trim();
        if secret.chars().count() >= 4 && !self.secrets.iter().any(|s| s == secret) {
            self.secrets.push(secret.to_string());
        }
    }

    /// Collects every credential the connect pipeline holds for this
    /// connection, including jump-host secrets (their dial errors never
    /// embed them, but defense in depth is free here).
    pub(crate) fn from_connection(connection: &crate::model::StoredConnection) -> Self {
        let mut redactor = Self::default();
        redactor.add(&connection.password);
        redactor.add(&connection.sudo_password);
        redactor.add(&connection.totp_secret);
        redactor.add(&connection.private_key_passphrase);
        redactor.add(&connection.private_key);
        for jump in &connection.jump_hosts {
            redactor.add(&jump.password);
            redactor.add(&jump.private_key_passphrase);
            redactor.add(&jump.totp_secret);
        }
        redactor
    }

    pub(crate) fn scrub(&self, text: &str) -> String {
        let mut text = text.to_string();
        for secret in &self.secrets {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), "[redacted]");
            }
        }
        text
    }
}

// ---------------------------------------------------------------------------
// Log plumbing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LogStream {
    Stdout,
    Stderr,
    System,
}

impl LogStream {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
            Self::System => "system",
        }
    }

    /// Default level per the contract's `debug|info|warn|error` vocabulary:
    /// remote stderr is `warn` (frequent and benign for `tail -F`-style
    /// commands), not `error`.
    fn default_level(&self) -> &'static str {
        match self {
            Self::Stderr => "warn",
            _ => "info",
        }
    }
}

/// Formats a unix timestamp as RFC3339 UTC (`1970-01-01T00:00:00Z` style).
/// chrono is not a dependency of this crate, and the contract's event shape
/// wants a self-describing timestamp on every log line.
pub(crate) fn rfc3339(timestamp_secs: u64) -> String {
    let days = (timestamp_secs / 86_400) as i64;
    let secs_of_day = timestamp_secs % 86_400;
    // Howard Hinnant's civil_from_days: days since epoch → y/m/d (proleptic
    // Gregorian, valid for the whole u64 second range we can ever see).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

fn rfc3339_now() -> String {
    rfc3339(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    )
}

/// Line-oriented buffering for a channel stream: complete lines are emitted
/// as they complete; a partial line longer than [`PARTIAL_LINE_LIMIT`] is
/// flushed early so progress stays visible.
#[derive(Default)]
struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, data: &[u8], mut emit: impl FnMut(String)) {
        self.pending.extend_from_slice(data);
        while let Some(position) = self.pending.iter().position(|&byte| byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..position).collect();
            self.pending.remove(0); // the '\n'
            emit(String::from_utf8_lossy(&line).into_owned());
        }
        if self.pending.len() >= PARTIAL_LINE_LIMIT {
            let drained = std::mem::take(&mut self.pending);
            emit(String::from_utf8_lossy(&drained).into_owned());
        }
    }

    fn flush(&mut self, mut emit: impl FnMut(String)) {
        if !self.pending.is_empty() {
            let drained = std::mem::take(&mut self.pending);
            emit(String::from_utf8_lossy(&drained).into_owned());
        }
    }
}

async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        // Sender dropped = the run was deregistered (finished); treat as a
        // cancel signal so a supervisor never outlives its registry entry.
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Closes the channel so sshd reaps the remote command. Dropping a russh
/// `Channel` never sends SSH_MSG_CHANNEL_CLOSE — the explicit close is what
/// makes cancel/timeout a real teardown instead of a status flip.
async fn close_channel(channel: &mut russh::Channel<russh::client::Msg>) {
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

/// How one streamed run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunEnd {
    Completed(Option<i32>),
    Cancelled,
    TimedOut,
}

/// Opens a session channel, runs `script`, streams stdout/stderr lines
/// through `on_log`, and honors cancel plus an optional deadline. On cancel
/// or timeout the channel is closed before returning, so the remote process
/// is reaped by sshd. Runs with `pty` merge stderr into stdout (protocol
/// semantics); `on_tick` fires on the heartbeat cadence and is only passed
/// by resident supervision (its return keeps the loop alive — never cancel).
async fn run_streaming(
    handle: &Handle<SshClient>,
    script: &str,
    pty: bool,
    timeout: Option<Duration>,
    cancel: &mut watch::Receiver<bool>,
    mut on_log: impl FnMut(LogStream, String),
    mut on_tick: Option<&mut (dyn FnMut() + Send)>,
) -> Result<RunEnd, String> {
    let mut channel = tokio::select! {
        biased;
        _ = wait_cancelled(cancel) => return Ok(RunEnd::Cancelled),
        opened = handle.channel_open_session() =>
            opened.map_err(|error| format!("Failed to open exec channel: {error}"))?,
    };
    if pty {
        // Best-effort: PTY-less servers still run the command.
        let _ = channel
            .request_pty(true, "xterm-256color", 24, 80, 0, 0, &[])
            .await;
    }
    tokio::select! {
        biased;
        _ = wait_cancelled(cancel) => {
            close_channel(&mut channel).await;
            return Ok(RunEnd::Cancelled);
        }
        started = channel.exec(true, script.as_bytes()) =>
            started.map_err(|error| format!("Failed to start command: {error}"))?,
    }
    let deadline = timeout.map(|t| tokio::time::Instant::now() + t);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(RESIDENT_HEARTBEAT_SECS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stdout = LineBuffer::default();
    let mut stderr = LineBuffer::default();
    let mut exit_code: Option<i32> = None;
    // Macro (not a closure): each expansion's `on_log` borrows are temporary,
    // so the collect loop below can keep using `on_log` between flushes.
    macro_rules! flush_buffers {
        () => {{
            stdout.flush(&mut |line| on_log(LogStream::Stdout, line));
            stderr.flush(&mut |line| on_log(LogStream::Stderr, line));
        }};
    }
    loop {
        let message = tokio::select! {
            biased;
            _ = wait_cancelled(cancel) => {
                flush_buffers!();
                close_channel(&mut channel).await;
                return Ok(RunEnd::Cancelled);
            }
            _ = heartbeat.tick() => {
                if let Some(on_tick) = on_tick.as_deref_mut() {
                    on_tick();
                }
                continue;
            }
            waited = async {
                match deadline {
                    Some(deadline) => tokio::time::timeout_at(deadline, channel.wait())
                        .await
                        .map_err(|_| ()),
                    None => Ok(channel.wait().await),
                }
            } => match waited {
                Ok(message) => message,
                Err(()) => {
                    flush_buffers!();
                    close_channel(&mut channel).await;
                    return Ok(RunEnd::TimedOut);
                }
            },
        };
        match message {
            Some(ChannelMsg::Data { ref data }) => {
                stdout.push(data, |line| on_log(LogStream::Stdout, line));
            }
            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                stderr.push(data, |line| on_log(LogStream::Stderr, line));
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = Some(i32::try_from(exit_status).unwrap_or(-1));
            }
            Some(_) => {}
            None => break,
        }
    }
    flush_buffers!();
    Ok(RunEnd::Completed(exit_code))
}

// ---------------------------------------------------------------------------
// Request shape (ADR §6.2)
// ---------------------------------------------------------------------------

/// Parsed `task` envelope shared by execute/start.
#[derive(Debug, Clone)]
pub(crate) struct TaskRequest {
    pub task_id: String,
    pub run_id: String,
    pub trigger_id: String,
    pub connection_id: String,
    pub config: Value,
}

impl TaskRequest {
    fn parse(params: &Value) -> Result<Self, String> {
        let task = params
            .get("task")
            .ok_or_else(|| task_error(CODE_INVALID_CONFIG, "Missing task envelope"))?;
        let run_id = task
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                params
                    .get("run")
                    .and_then(|run| run.get("runId"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let connection_id = task
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| task_error(CODE_INVALID_CONFIG, "Missing task.connectionId"))?
            .to_string();
        Ok(Self {
            task_id: task
                .get("taskId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            run_id,
            trigger_id: task
                .get("triggerId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            connection_id,
            config: task.get("config").cloned().unwrap_or_else(|| json!({})),
        })
    }
}

// ---------------------------------------------------------------------------
// TaskProvider
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResidentState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Crashed,
    Degraded,
}

impl ResidentState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Crashed => "crashed",
            Self::Degraded => "degraded",
        }
    }
}

/// Registry entry for one resident session, keyed by `session_id` (the map
/// key is the session id, so it is not duplicated into the struct).
struct ResidentEntry {
    task_id: String,
    state: ResidentState,
    heartbeat_at: Option<SystemTime>,
    restart_count: u32,
    cancel: watch::Sender<bool>,
}

/// Provider state: one instance per sidecar process, shared by the fixed
/// `task/*` RPC arms. Nothing here persists — the host owns persistence and
/// reconciles resident sessions through `task/status` after a sidecar
/// restart (unknown session ids report `stopped`).
pub(crate) struct TaskProvider {
    /// run-mode cancel signals keyed by runId (`task/stop` target).
    runs: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// Per-run monotonic log sequence (contract: starts at 1).
    seqs: Mutex<HashMap<String, u64>>,
    /// Resident sessions keyed by sessionId.
    residents: Mutex<HashMap<String, ResidentEntry>>,
}

impl TaskProvider {
    pub(crate) fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            seqs: Mutex::new(HashMap::new()),
            residents: Mutex::new(HashMap::new()),
        }
    }

    fn next_seq(&self, run_id: &str) -> u64 {
        let mut seqs = self
            .seqs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let next = seqs.entry(run_id.to_string()).or_insert(0);
        *next += 1;
        *next
    }

    fn drop_seq(&self, run_id: &str) {
        self.seqs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(run_id);
    }

    fn register_run(&self, run_id: &str) -> watch::Receiver<bool> {
        let (sender, receiver) = watch::channel(false);
        self.runs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(run_id.to_string(), sender);
        receiver
    }

    fn finish_run(&self, run_id: &str) {
        self.runs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(run_id);
        self.drop_seq(run_id);
    }

    fn cancel_run(&self, run_id: &str) -> bool {
        self.runs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(run_id)
            .map(|sender| sender.send(true).is_ok())
            .unwrap_or(false)
    }

    fn residents_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, ResidentEntry>> {
        self.residents
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn emit_state(&self, emitter: &PluginEmitter, request: &TaskRequest, state: &str) {
        let _ = emitter.event(
            "task/state",
            json!({
                "event": "task/state",
                "taskId": request.task_id,
                "runId": request.run_id,
                "state": state,
            }),
        );
    }

    fn emit_progress(&self, emitter: &PluginEmitter, request: &TaskRequest, percent: f64) {
        let _ = emitter.event(
            "task/progress",
            json!({
                "event": "task/progress",
                "taskId": request.task_id,
                "runId": request.run_id,
                "percent": percent,
            }),
        );
    }

    fn emit_resident_state(
        &self,
        emitter: &PluginEmitter,
        task_id: &str,
        run_id: &str,
        session_id: &str,
        state: ResidentState,
    ) {
        let _ = emitter.event(
            "task/state",
            json!({
                "event": "task/state",
                "taskId": task_id,
                "runId": run_id,
                "sessionId": session_id,
                "state": state.as_str(),
            }),
        );
    }

    #[allow(clippy::too_many_arguments)] // flat event fields mirror the frozen payload shape
    fn emit_log(
        &self,
        emitter: &PluginEmitter,
        task_id: &str,
        run_id: &str,
        seq: u64,
        stream: LogStream,
        level: &str,
        message: &str,
    ) {
        let _ = emitter.event(
            "task/log",
            json!({
                "event": "task/log",
                "taskId": task_id,
                "runId": run_id,
                "seq": seq,
                "stream": stream.as_str(),
                "level": level,
                "message": message,
                "timestamp": rfc3339_now(),
            }),
        );
    }

    // -- task/validate ------------------------------------------------------

    /// `task/validate`: pure config/trigger inspection — no dial, no secret
    /// access (ADR §5.2: validation must not touch secret plaintext).
    pub(crate) fn validate_request(params: &Value) -> Result<Value, String> {
        let task = params
            .get("task")
            .ok_or_else(|| task_error(CODE_INVALID_CONFIG, "Missing task envelope"))?;
        let trigger_id = task
            .get("triggerId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let config = task.get("config").cloned().unwrap_or_else(|| json!({}));
        let (mut errors, warnings) = validate_task_config(trigger_id, &config);
        if task
            .get("connectionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            // A missing connection makes the task unrunnable but the
            // definition itself may still be edited — a warning keeps the
            // form usable (health model: connection missing = warning).
            errors.push("connectionId is required".to_string());
        }
        Ok(json!({
            "valid": errors.is_empty(),
            "errors": errors,
            "warnings": warnings,
        }))
    }

    // -- task/execute -------------------------------------------------------

    /// `task/execute`: run the command once and resolve with the final
    /// result. Timeout/cancel return typed RPC errors after the remote
    /// process has actually been torn down.
    /// Redaction source for a connection: `Some` when the stored (hydrated)
    /// connection exists; `None` when only a live session does (secrets were
    /// never pushed this process run). Errors with the contract's
    /// `connection_missing` code when neither exists.
    async fn resolve_redactor(ssh: &SshRuntime, connection_id: &str) -> Result<Redactor, String> {
        match ssh.stored_connection(connection_id).await {
            Ok(connection) => Ok(Redactor::from_connection(&connection)),
            Err(error) => {
                if ssh.has_live_session(connection_id).await {
                    Ok(Redactor::default())
                } else {
                    Err(task_error(CODE_CONNECTION_MISSING, error))
                }
            }
        }
    }

    pub(crate) async fn execute(
        &self,
        ssh: &SshRuntime,
        params: &Value,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let request = TaskRequest::parse(params)?;
        if request.trigger_id != "execute" {
            return Err(task_error(
                CODE_INVALID_CONFIG,
                format!("trigger {:?} does not support execute", request.trigger_id),
            ));
        }
        let config = TaskConfig::parse(&request.trigger_id, &request.config)?;
        // Fail fast with the contract's connection_missing code when neither
        // a stored (hydrated) connection nor a live session exists — a
        // scheduled run against a dropped connection must not masquerade as
        // a transport failure (ADR §5.4: connection_missing is
        // non-retryable).
        let redactor = match Self::resolve_redactor(ssh, &request.connection_id).await {
            Ok(redactor) => redactor,
            Err(error) => return Err(error),
        };
        let mut cancel = self.register_run(&request.run_id);
        self.emit_state(&emitter, &request, "running");
        self.emit_progress(&emitter, &request, 0.0);
        self.emit_log(
            &emitter,
            &request.task_id,
            &request.run_id,
            self.next_seq(&request.run_id),
            LogStream::System,
            "info",
            &redactor.scrub(&format!("Starting command on {}", request.connection_id)),
        );
        let outcome = self
            .run_command(ssh, &request, &config, &redactor, &mut cancel, &emitter)
            .await;
        self.finish_run(&request.run_id);
        match outcome {
            Ok(RunEnd::Completed(Some(0))) => {
                self.emit_state(&emitter, &request, "success");
                self.emit_progress(&emitter, &request, 100.0);
                Ok(json!({
                    "success": true,
                    "exitCode": 0,
                    "message": "Command completed",
                    "artifacts": [],
                }))
            }
            Ok(RunEnd::Completed(exit_code)) => {
                self.emit_state(&emitter, &request, "failed");
                let exit_code = exit_code.unwrap_or(-1);
                self.emit_log(
                    &emitter,
                    &request.task_id,
                    &request.run_id,
                    self.next_seq(&request.run_id),
                    LogStream::System,
                    "error",
                    &format!("Command exited with code {exit_code}"),
                );
                Ok(json!({
                    "success": false,
                    "exitCode": exit_code,
                    "message": format!("Command exited with code {exit_code}"),
                    "artifacts": [],
                }))
            }
            Ok(RunEnd::TimedOut) => {
                self.emit_state(&emitter, &request, "timeout");
                Err(task_error(
                    CODE_TIMEOUT,
                    format!(
                        "command exceeded its {}s limit and was stopped",
                        config.timeout_seconds.unwrap_or_default()
                    ),
                ))
            }
            Ok(RunEnd::Cancelled) => {
                self.emit_state(&emitter, &request, "cancelled");
                Err(task_error(CODE_CANCELLED, "command was cancelled"))
            }
            Err(error) => {
                self.emit_state(&emitter, &request, "failed");
                Err(redactor.scrub(&error))
            }
        }
    }

    async fn run_command(
        &self,
        ssh: &SshRuntime,
        request: &TaskRequest,
        config: &TaskConfig,
        redactor: &Redactor,
        cancel: &mut watch::Receiver<bool>,
        emitter: &PluginEmitter,
    ) -> Result<RunEnd, String> {
        let transport = ssh
            .task_transport(
                &request.connection_id,
                &format!("task-{}", request.run_id),
                Some(emitter.clone()),
            )
            .await
            .map_err(|error| redactor.scrub(&error))?;
        let script = build_script(config);
        let outcome = run_streaming(
            transport.handle(),
            &script,
            config.pty,
            config.timeout_seconds.map(Duration::from_secs),
            cancel,
            |stream, message| {
                let message = redactor.scrub(&message);
                self.emit_log(
                    emitter,
                    &request.task_id,
                    &request.run_id,
                    self.next_seq(&request.run_id),
                    stream,
                    stream.default_level(),
                    &message,
                );
            },
            None,
        )
        .await;
        transport.release().await;
        outcome
    }

    // -- task/start (resident) ----------------------------------------------

    /// `task/start`: spawn a supervised resident session. Per the contract's
    /// concurrency default (Replace) an existing session for the same task
    /// is stopped first; each TaskDefinition has at most one live session.
    pub(crate) async fn start_resident(
        self: &Arc<Self>,
        ssh: Arc<SshRuntime>,
        params: Value,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let request = TaskRequest::parse(&params)?;
        if request.trigger_id != "resident" {
            return Err(task_error(
                CODE_INVALID_CONFIG,
                format!(
                    "trigger {:?} does not support resident start",
                    request.trigger_id
                ),
            ));
        }
        let config = TaskConfig::parse(&request.trigger_id, &request.config)?;
        // Fail fast before a supervisor is spawned: a missing connection
        // would otherwise burn its restart budget crashing on dial errors.
        Self::resolve_redactor(&ssh, &request.connection_id).await?;
        // Replace: signal every live session of this task; their supervisor
        // loops observe the cancel and land on `stopped` on their own.
        {
            let mut residents = self.residents_lock();
            for entry in residents.values_mut() {
                if entry.task_id == request.task_id
                    && !matches!(
                        entry.state,
                        ResidentState::Stopped | ResidentState::Degraded
                    )
                {
                    entry.state = ResidentState::Stopping;
                    let _ = entry.cancel.send(true);
                }
            }
        }
        let session_id = format!("resident-{}", uuid::Uuid::new_v4().simple());
        let (cancel, cancel_rx) = watch::channel(false);
        self.residents_lock().insert(
            session_id.clone(),
            ResidentEntry {
                task_id: request.task_id.clone(),
                state: ResidentState::Starting,
                heartbeat_at: Some(SystemTime::now()),
                restart_count: 0,
                cancel,
            },
        );
        self.emit_resident_state(
            &emitter,
            &request.task_id,
            &request.run_id,
            &session_id,
            ResidentState::Starting,
        );
        let provider = Arc::clone(self);
        let supervise_session = session_id.clone();
        tokio::spawn(async move {
            provider
                .resident_supervise(ssh, request, config, supervise_session, cancel_rx, emitter)
                .await;
        });
        Ok(json!({ "sessionId": session_id, "state": "starting" }))
    }

    /// Resident supervision loop: dial → run → on crash obey the bounded
    /// restart policy → degrade when the budget is exhausted. Cancel lands
    /// at every await point and always ends in a real channel teardown.
    async fn resident_supervise(
        self: Arc<Self>,
        ssh: Arc<SshRuntime>,
        request: TaskRequest,
        config: TaskConfig,
        session_id: String,
        mut cancel: watch::Receiver<bool>,
        emitter: PluginEmitter,
    ) {
        // start_resident already verified presence; an empty redactor only
        // means the secrets were never pushed this process run.
        let redactor = Self::resolve_redactor(&ssh, &request.connection_id)
            .await
            .unwrap_or_default();
        let script = build_script(&config);
        let mut restarts: Vec<Instant> = Vec::new();
        loop {
            // Dial (live session handle or dedicated headless transport).
            let transport = match ssh
                .task_transport(
                    &request.connection_id,
                    &format!("task-{}", request.run_id),
                    Some(emitter.clone()),
                )
                .await
            {
                Ok(transport) => transport,
                Err(error) => {
                    let degraded = self
                        .resident_crash_step(
                            &request,
                            &config,
                            &session_id,
                            &emitter,
                            &mut restarts,
                            &mut cancel,
                            &redactor.scrub(&format!("connect failed: {error}")),
                        )
                        .await;
                    if degraded {
                        return;
                    }
                    continue;
                }
            };
            self.resident_set_state(&session_id, ResidentState::Running);
            self.emit_resident_state(
                &emitter,
                &request.task_id,
                &request.run_id,
                &session_id,
                ResidentState::Running,
            );
            let session_for_tick = session_id.clone();
            let provider_for_tick = Arc::clone(&self);
            let outcome = run_streaming(
                transport.handle(),
                &script,
                config.pty,
                // Contract: timeout_seconds governs run executions and the
                // resident start phase only — the resident loop itself is
                // supervised by the restart policy, not a wall clock.
                None,
                &mut cancel,
                |stream, message| {
                    let message = redactor.scrub(&message);
                    provider_for_tick.emit_log(
                        &emitter,
                        &request.task_id,
                        &request.run_id,
                        provider_for_tick.next_seq(&request.run_id),
                        stream,
                        stream.default_level(),
                        &message,
                    );
                },
                Some(&mut || {
                    provider_for_tick.resident_heartbeat(&session_for_tick);
                }),
            )
            .await;
            transport.release().await;
            match outcome {
                Ok(RunEnd::Cancelled) => {
                    self.resident_set_state(&session_id, ResidentState::Stopped);
                    self.emit_resident_state(
                        &emitter,
                        &request.task_id,
                        &request.run_id,
                        &session_id,
                        ResidentState::Stopped,
                    );
                    self.emit_log(
                        &emitter,
                        &request.task_id,
                        &request.run_id,
                        self.next_seq(&request.run_id),
                        LogStream::System,
                        "info",
                        "Resident command stopped",
                    );
                    return;
                }
                Ok(RunEnd::TimedOut) => {
                    // Unreachable for residents (no wall-clock deadline), kept
                    // total so the match stays exhaustive.
                    let degraded = self
                        .resident_crash_step(
                            &request,
                            &config,
                            &session_id,
                            &emitter,
                            &mut restarts,
                            &mut cancel,
                            "Resident start phase exceeded its deadline",
                        )
                        .await;
                    if degraded {
                        return;
                    }
                }
                Ok(RunEnd::Completed(exit_code)) => {
                    let detail = match exit_code {
                        Some(code) => format!("exited with code {code}"),
                        None => "channel closed without an exit status".to_string(),
                    };
                    let degraded = self
                        .resident_crash_step(
                            &request,
                            &config,
                            &session_id,
                            &emitter,
                            &mut restarts,
                            &mut cancel,
                            &format!("Resident command {detail}"),
                        )
                        .await;
                    if degraded {
                        return;
                    }
                }
                Err(error) => {
                    let degraded = self
                        .resident_crash_step(
                            &request,
                            &config,
                            &session_id,
                            &emitter,
                            &mut restarts,
                            &mut cancel,
                            &redactor.scrub(&error),
                        )
                        .await;
                    if degraded {
                        return;
                    }
                }
            }
        }
    }

    /// One crash iteration: record it, then restart (bounded) or degrade.
    /// Returns `true` when the session is finished (degraded or — on cancel
    /// during backoff — stopped).
    #[allow(clippy::too_many_arguments)]
    async fn resident_crash_step(
        &self,
        request: &TaskRequest,
        config: &TaskConfig,
        session_id: &str,
        emitter: &PluginEmitter,
        restarts: &mut Vec<Instant>,
        cancel: &mut watch::Receiver<bool>,
        detail: &str,
    ) -> bool {
        let now = Instant::now();
        restarts.push(now);
        self.resident_set_state(session_id, ResidentState::Crashed);
        self.emit_resident_state(
            emitter,
            &request.task_id,
            &request.run_id,
            session_id,
            ResidentState::Crashed,
        );
        let policy = &config.restart;
        if !policy.restart_allowed(restarts, now) {
            // Surface the exhausted budget through restartCount too: the
            // denied restart still happened as a crash the supervisor
            // handled, and the reconcile view should show it.
            {
                let mut residents = self.residents_lock();
                if let Some(entry) = residents.get_mut(session_id) {
                    entry.restart_count = restarts.len() as u32;
                }
            }
            self.resident_set_state(session_id, ResidentState::Degraded);
            self.emit_resident_state(
                emitter,
                &request.task_id,
                &request.run_id,
                session_id,
                ResidentState::Degraded,
            );
            self.emit_log(
                emitter,
                &request.task_id,
                &request.run_id,
                self.next_seq(&request.run_id),
                LogStream::System,
                "error",
                &format!(
                    "{detail}; restart budget exhausted ({} restarts within {}), session degraded",
                    restarts.len(),
                    policy
                        .window_seconds
                        .map(|window| format!("{window}s window"))
                        .unwrap_or_else(|| "the process lifetime".to_string()),
                ),
            );
            return true;
        }
        let attempt = restarts.len() as u32;
        {
            let mut residents = self.residents_lock();
            if let Some(entry) = residents.get_mut(session_id) {
                entry.restart_count = attempt;
            }
        }
        self.emit_log(
            emitter,
            &request.task_id,
            &request.run_id,
            self.next_seq(&request.run_id),
            LogStream::System,
            "warn",
            &format!(
                "{detail}; restarting ({attempt}/{}) in {}s",
                policy.max_restarts, policy.backoff_seconds
            ),
        );
        let deadline = Instant::now() + Duration::from_secs(policy.backoff_seconds);
        while Instant::now() < deadline {
            if *cancel.borrow_and_update() {
                self.resident_set_state(session_id, ResidentState::Stopped);
                self.emit_resident_state(
                    emitter,
                    &request.task_id,
                    &request.run_id,
                    session_id,
                    ResidentState::Stopped,
                );
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    fn resident_set_state(&self, session_id: &str, state: ResidentState) {
        let mut residents = self.residents_lock();
        if let Some(entry) = residents.get_mut(session_id) {
            entry.state = state;
            if state == ResidentState::Running || state == ResidentState::Stopped {
                entry.heartbeat_at = Some(SystemTime::now());
            }
        }
    }

    fn resident_heartbeat(&self, session_id: &str) {
        let mut residents = self.residents_lock();
        if let Some(entry) = residents.get_mut(session_id) {
            entry.heartbeat_at = Some(SystemTime::now());
        }
    }

    // -- task/stop ----------------------------------------------------------

    /// `task/stop`: cancel a run-mode execution (by runId) or stop a
    /// resident session (by sessionId). Idempotent: unknown ids answer `{}`.
    pub(crate) async fn stop(&self, params: &Value) -> Result<Value, String> {
        // Resident first: sessionId is the precise target.
        if let Some(session_id) = params
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let cancel = {
                let mut residents = self.residents_lock();
                match residents.get_mut(session_id) {
                    Some(entry) => {
                        if matches!(
                            entry.state,
                            ResidentState::Running
                                | ResidentState::Starting
                                | ResidentState::Crashed
                        ) {
                            entry.state = ResidentState::Stopping;
                        }
                        entry.cancel.clone()
                    }
                    None => return Ok(json!({})),
                }
            };
            let _ = cancel.send(true);
            // Wait (bounded) so the response reflects a real teardown, not
            // just an accepted signal.
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                let state = self
                    .residents_lock()
                    .get(session_id)
                    .map(|entry| entry.state)
                    .unwrap_or(ResidentState::Stopped);
                if matches!(state, ResidentState::Stopped | ResidentState::Degraded) {
                    return Ok(json!({}));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            return Ok(json!({}));
        }
        if let Some(run_id) = params
            .get("runId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            self.cancel_run(run_id);
        }
        Ok(json!({}))
    }

    // -- task/status --------------------------------------------------------

    /// `task/status`: reconcile view for the host supervisor. Unknown
    /// session ids report `stopped` so a sidecar restart (which loses the
    /// in-memory registry) converges instead of wedging recovery.
    pub(crate) fn status(&self, params: &Value) -> Result<Value, String> {
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let task_id = params
            .get("taskId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let residents = self.residents_lock();
        let entry = match (session_id, task_id) {
            (Some(session_id), _) => residents.get(session_id),
            (None, Some(task_id)) => residents.values().find(|entry| entry.task_id == task_id),
            (None, None) => {
                return Err(task_error(
                    CODE_INVALID_CONFIG,
                    "sessionId or taskId is required",
                ))
            }
        };
        Ok(match entry {
            Some(entry) => json!({
                "state": entry.state.as_str(),
                "heartbeatAt": entry.heartbeat_at.map(|at| {
                    rfc3339(at.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
                }),
                "restartCount": entry.restart_count,
            }),
            None => json!({
                "state": "stopped",
                "heartbeatAt": Value::Null,
                "restartCount": 0,
            }),
        })
    }
}

// ---------------------------------------------------------------------------
// Tests (pure logic; live end-to-end coverage lives in
// scripts/smoke_task_provider.py against the dbx-ssh-test container)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn config_json(extra: Value) -> Value {
        let mut config = json!({
            "command": "echo hello",
            "working_directory": "/tmp",
            "environment": "FOO=bar\nBAZ=qux",
            "timeout_seconds": 60,
        });
        if let (Some(base), Some(extra)) = (config.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        config
    }

    /// JSON string array → Vec<String> for the validate error/warning lists.
    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    // -- validate -----------------------------------------------------------

    #[test]
    fn validate_accepts_a_well_formed_execute_task() {
        let response = TaskProvider::validate_request(&json!({
            "task": {
                "providerId": "io.dbx.ssh.tasks",
                "triggerId": "execute",
                "connectionId": "conn-1",
                "configVersion": 1,
                "config": config_json(json!({})),
            }
        }))
        .expect("validate");
        assert_eq!(response["valid"], true, "{response}");
        assert_eq!(response["errors"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn validate_collects_every_config_error_at_once() {
        let response = TaskProvider::validate_request(&json!({
            "task": {
                "providerId": "io.dbx.ssh.tasks",
                "triggerId": "execute",
                "config": {
                    "command": "",
                    "environment": "GOOD=1\nbad key=no\nMULTI=line\nvalue",                    "timeout_seconds": -5,
                },
            }
        }))
        .expect("validate");
        assert_eq!(response["valid"], false, "{response}");
        let errors = strings(&response["errors"]);
        assert!(
            errors.iter().any(|e| e.contains("command is required")),
            "{errors:?}"
        );
        assert!(errors.iter().any(|e| e.contains("bad key")), "{errors:?}");
        // `MULTI=line` is a valid KEY=VALUE pair; the bare `value` line is not.
        assert!(
            errors.iter().any(|e| e.contains("environment entry")),
            "{errors:?}"
        );
        assert!(
            errors.iter().any(|e| e.contains("timeout_seconds")),
            "{errors:?}"
        );
        assert!(
            errors
                .iter()
                .any(|e| e.contains("connectionId is required")),
            "missing connection must surface: {errors:?}"
        );
    }

    #[test]
    fn validate_rejects_unknown_trigger_and_non_resident_restart_knobs() {
        let response = TaskProvider::validate_request(&json!({
            "task": {
                "providerId": "io.dbx.ssh.tasks",
                "triggerId": "daemonize",
                "connectionId": "conn-1",
                "config": { "command": "top", "max_restarts": 3 },
            }
        }))
        .expect("validate");
        assert_eq!(response["valid"], false, "{response}");
        let errors = strings(&response["errors"]);
        assert!(
            errors.iter().any(|e| e.contains("unknown trigger")),
            "{errors:?}"
        );
        let warnings = strings(&response["warnings"]);
        assert!(
            warnings
                .iter()
                .any(|w| w.contains("max_restarts only applies to the resident")),
            "{warnings:?}"
        );
    }

    #[test]
    fn validate_warns_when_pty_merges_streams() {
        let response = TaskProvider::validate_request(&json!({
            "task": {
                "providerId": "io.dbx.ssh.tasks",
                "triggerId": "execute",
                "connectionId": "conn-1",
                "config": config_json(json!({ "pty": true })),
            }
        }))
        .expect("validate");
        assert_eq!(response["valid"], true, "{response}");
        let warnings = response["warnings"].as_array().unwrap();
        assert!(warnings
            .iter()
            .any(|warning| warning.as_str().unwrap().contains("merged")));
    }

    // -- config parsing & script building ------------------------------------

    #[test]
    fn parse_resident_config_applies_restart_defaults_and_bounds() {
        let config = TaskConfig::parse("resident", &json!({ "command": "tail -F x" }))
            .expect("resident config");
        assert_eq!(config.restart, RestartPolicy::default());
        assert!(!config.pty);

        let bounded = TaskConfig::parse(
            "resident",
            &json!({
                "command": "tail -F x",
                "max_restarts": 999,
                "restart_backoff_seconds": 0,
            }),
        )
        .expect_err("out-of-bounds restart knobs must fail validation");
        assert!(bounded.starts_with("invalid_config:"), "{bounded}");
    }

    #[test]
    fn build_script_exports_env_then_guards_cd_then_runs_command() {
        let script = build_script(&TaskConfig {
            command: "make deploy\nmake notify".to_string(),
            working_directory: "/opt/app my dir".to_string(),
            environment: vec![
                ("FOO".to_string(), "it's".to_string()),
                ("BAR".to_string(), "x".to_string()),
            ],
            timeout_seconds: None,
            pty: false,
            restart: RestartPolicy::default(),
        });
        // Env first (single-quoted, apostrophe escaped), guarded cd, then
        // the raw command as the trailing statement so the exit status is
        // the command's own.
        assert!(
            script.starts_with("export FOO='it'\\''s'\nexport BAR='x'\n"),
            "{script}"
        );
        assert!(
            script.contains("cd '/opt/app my dir' || exit 125\n"),
            "{script}"
        );
        assert!(script.ends_with("make deploy\nmake notify"), "{script}");
    }

    #[test]
    fn build_script_without_optional_parts_is_just_the_command() {
        let script = build_script(&TaskConfig {
            command: "uptime".to_string(),
            working_directory: String::new(),
            environment: Vec::new(),
            timeout_seconds: None,
            pty: false,
            restart: RestartPolicy::default(),
        });
        assert_eq!(script, "uptime");
    }

    // -- restart budget -------------------------------------------------------

    #[test]
    fn restart_budget_is_bounded_within_the_window() {
        let policy = RestartPolicy {
            max_restarts: 3,
            backoff_seconds: 5,
            window_seconds: Some(60),
        };
        let now = Instant::now();
        // Two restarts inside the window: budget remains for one more.
        let within: Vec<Instant> = (0..2)
            .map(|i| now - Duration::from_secs(10 * (i + 1)))
            .collect();
        assert!(policy.restart_allowed(&within, now));
        // A restart older than the window does not count against the budget:
        // 2 stale + 2 recent stays under the cap of 3.
        let stale: Vec<Instant> = vec![
            now - Duration::from_secs(120),
            now - Duration::from_secs(130),
        ];
        let mixed: Vec<Instant> = stale
            .iter()
            .copied()
            .chain(within.iter().copied())
            .collect();
        assert!(policy.restart_allowed(&mixed, now));
        // At the cap the next crash must degrade, not restart.
        let at_cap: Vec<Instant> = (0..3)
            .map(|i| now - Duration::from_secs(i as u64 + 1))
            .collect();
        assert!(!policy.restart_allowed(&at_cap, now));
    }

    #[test]
    fn restart_budget_without_window_counts_process_lifetime() {
        let policy = RestartPolicy {
            max_restarts: 2,
            backoff_seconds: 1,
            window_seconds: None,
        };
        let now = Instant::now();
        let old: Vec<Instant> = vec![now - Duration::from_secs(3_600)];
        assert!(policy.restart_allowed(&old, now));
        let at_cap: Vec<Instant> = vec![now - Duration::from_secs(3_600), now];
        assert!(!policy.restart_allowed(&at_cap, now));
    }

    // -- redaction -------------------------------------------------------------

    #[test]
    fn redactor_masks_connection_secrets_in_emitted_text() {
        // Same lifecycle shape the host pushes on connection/connect (see
        // model.rs tests); secrets are never carried in task config.
        let connection =
            crate::model::StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "conn-1",
                    "host": "h",
                    "port": 22,
                    "username": "ops",
                    "password": "sup3r-secret-pass",
                    "external_config": { "authentication": "password" },
                }
            }))
            .expect("StoredConnection fixture");
        let redactor = Redactor::from_connection(&connection);
        let leaked = "auth failed for sup3r-secret-pass on host";
        assert_eq!(redactor.scrub(leaked), "auth failed for [redacted] on host");
        // Short secrets are left alone (redacting them mangles normal text).
        let mut tiny = Redactor::default();
        tiny.add("ab");
        assert_eq!(tiny.scrub("abcabd"), "abcabd");
    }

    // -- line buffering ----------------------------------------------------------

    #[test]
    fn line_buffer_emits_complete_lines_and_keeps_partials() {
        let mut buffer = LineBuffer::default();
        let mut emitted = Vec::new();
        buffer.push(b"hello ", |line| emitted.push(line));
        assert!(emitted.is_empty());
        buffer.push(b"world\nnext", |line| emitted.push(line));
        assert_eq!(emitted, vec!["hello world".to_string()]);
        buffer.push(b"\r\n", |line| emitted.push(line));
        // The CR belongs to the previous line's tail and is preserved
        // verbatim; lossy decoding never silently strips it.
        assert_eq!(emitted.last().unwrap(), "next\r");
        let before_flush = emitted.len();
        buffer.flush(|line| emitted.push(line));
        // Nothing pending → flush emits nothing extra.
        assert_eq!(emitted.len(), before_flush);
    }

    #[test]
    fn line_buffer_flushes_oversized_partial_lines() {
        let mut buffer = LineBuffer::default();
        let mut emitted = Vec::new();
        let chunk = vec![b'x'; PARTIAL_LINE_LIMIT];
        buffer.push(&chunk, |line| emitted.push(line));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].len(), PARTIAL_LINE_LIMIT);
    }

    // -- error codes & timestamps -------------------------------------------------

    #[test]
    fn error_codes_use_the_contract_vocabulary_prefix() {
        assert_eq!(
            task_error(CODE_TIMEOUT, "late"),
            "timeout: late".to_string()
        );
        assert_eq!(
            task_error(CODE_CONNECTION_MISSING, "gone"),
            "connection_missing: gone".to_string()
        );
    }

    #[test]
    fn rfc3339_formats_known_timestamps() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn resident_state_serializes_to_contract_vocabulary() {
        assert_eq!(ResidentState::Starting.as_str(), "starting");
        assert_eq!(ResidentState::Running.as_str(), "running");
        assert_eq!(ResidentState::Stopping.as_str(), "stopping");
        assert_eq!(ResidentState::Stopped.as_str(), "stopped");
        assert_eq!(ResidentState::Crashed.as_str(), "crashed");
        assert_eq!(ResidentState::Degraded.as_str(), "degraded");
    }

    // -- request envelope ------------------------------------------------------------

    #[test]
    fn task_request_parse_requires_connection_and_defaults_run_id() {
        let request = TaskRequest::parse(&json!({
            "task": {
                "providerId": "io.dbx.ssh.tasks",
                "triggerId": "execute",
                "connectionId": "conn-1",
                "config": { "command": "uptime" },
            }
        }))
        .expect("request");
        assert_eq!(request.connection_id, "conn-1");
        assert!(
            !request.run_id.is_empty(),
            "runId must be generated when absent"
        );

        let error = TaskRequest::parse(&json!({ "task": { "triggerId": "execute" } }))
            .expect_err("connectionId is mandatory");
        assert!(error.starts_with("invalid_config:"), "{error}");
    }

    #[test]
    fn task_request_accepts_run_envelope_run_id() {
        let request = TaskRequest::parse(&json!({
            "task": { "triggerId": "resident", "connectionId": "c", "config": {} },
            "run": { "runId": "run-42", "attempt": 1 },
        }))
        .expect("request");
        assert_eq!(request.run_id, "run-42");
    }
}
