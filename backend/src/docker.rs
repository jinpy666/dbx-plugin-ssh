//! Docker management panel backend (`docker/list` / `docker/logs` /
//! `docker/action`): POSIX collector scripts executed through `sh -s`
//! heredocs plus pure parsers, in the same style as [`crate::metrics`].
//! Zero new dependencies by design — the Docker CLI is driven over shell,
//! never the daemon API, and no docker client crate is pulled in.
//!
//! Safety model for actions: the verb comes from a fixed whitelist, the
//! container id must match `^[0-9a-f]{12,64}$`, read-only connections are
//! refused by the caller (`ensure_writable`), the intent is audited before
//! execution, and the sudo password never travels on the command line —
//! the fallback reuses the Quick Sudo pipeline (`exec_with_sudo`) which
//! pipes credentials over stdin.

use std::path::Path;
use std::time::Duration;

use russh::client::Handle;
use serde::Serialize;
use serde_json::{json, Value};

use crate::audit_log;
use crate::exec;
use crate::ssh::SshClient;

/// Wait cap for the container list collector (one `docker ps` round-trip).
pub const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// Wait cap for `docker logs --tail N`; tailing is bounded by `--tail`.
pub const LOGS_TIMEOUT: Duration = Duration::from_secs(30);
/// Wait cap for lifecycle actions; `stop`/`restart` default to a 10s
/// container shutdown timeout, so 60s covers the worst case with slack.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

/// Bounds for the `--tail` line count of `docker/logs`.
pub const TAIL_MIN: u64 = 10;
pub const TAIL_MAX: u64 = 2000;
pub const TAIL_DEFAULT: u64 = 200;

// —— Engine / endpoint configuration (Podman & custom daemons) ————————

/// Default container CLI when the caller passes no `cli` parameter.
pub const DEFAULT_CLI: &str = "docker";

/// Resolved invocation config for one docker-family call: which CLI to run
/// (`docker`, `podman`, or a full path) and, optionally, an explicit daemon
/// endpoint (`unix://…` socket or `tcp://host:port`). The endpoint is
/// applied through the engine's own env var (`DOCKER_HOST` for Docker,
/// `CONTAINER_HOST` for Podman) so one setting covers both CLIs without
/// flag differences — and without ever placing it on the command line of
/// the CLI invocation itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineConfig {
    pub cli: String,
    pub endpoint: Option<String>,
}

impl Default for EngineConfig {
    /// The stock Docker invocation (default CLI, default daemon socket).
    fn default() -> Self {
        Self {
            cli: DEFAULT_CLI.to_string(),
            endpoint: None,
        }
    }
}

/// Charset gate shared by `cli` and the endpoint values. Everything on it
/// is inert in POSIX single quotes *and* in cmd `set` lines (no spaces,
/// quotes, `%`, `&`, `|`, `<`, `>`, `^`, `!`), so the same validated string
/// can be baked into heredocs, sudo bodies and Windows fallbacks alike.
fn is_engine_charset(value: &str) -> bool {
    value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-' | b':' | b'\\')
    })
}

/// Validates the `cli` parameter: a binary name (`podman`) or a path
/// (`/usr/local/bin/podman`, `C:\...\podman.exe`). Anything else is
/// refused before a command is ever rendered.
fn validate_cli(cli: &str) -> Result<(), String> {
    if cli.is_empty() || cli.len() > 256 {
        return Err(format!("Invalid cli '{cli}': expected 1-256 characters"));
    }
    if !is_engine_charset(cli) {
        return Err(format!(
            "Invalid cli '{cli}': only letters, digits and _ . / \\ : - are allowed"
        ));
    }
    Ok(())
}

/// Normalizes the optional daemon endpoint from the mutually exclusive
/// `socket` / `host` parameters into one env-ready URL: bare socket paths
/// gain a `unix://` prefix, bare `host:port` values gain `tcp://`, and
/// explicit `unix://` / `tcp://` / `http(s)://` / Windows `npipe:` URLs
/// pass through unchanged.
fn normalize_endpoint(socket: Option<&str>, host: Option<&str>) -> Result<Option<String>, String> {
    let socket = socket.map(str::trim).filter(|value| !value.is_empty());
    let host = host.map(str::trim).filter(|value| !value.is_empty());
    if socket.is_some() && host.is_some() {
        return Err(
            "docker socket and host are mutually exclusive: pass exactly one daemon endpoint"
                .to_string(),
        );
    }
    let Some(raw) = socket.or(host) else {
        return Ok(None);
    };
    if raw.len() > 512 || !is_engine_charset(raw) {
        return Err(format!(
            "Invalid daemon endpoint '{raw}': only letters, digits and _ . / \\ : - are allowed (1-512 chars)"
        ));
    }
    let lower = raw.to_ascii_lowercase();
    let normalized = if lower.starts_with("unix://")
        || lower.starts_with("tcp://")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("npipe:")
    {
        raw.to_string()
    } else if raw.starts_with('/') {
        format!("unix://{raw}")
    } else if raw.contains(':') {
        format!("tcp://{raw}")
    } else {
        return Err(format!(
            "Invalid daemon endpoint '{raw}': expected a unix socket path or host:port"
        ));
    };
    Ok(Some(normalized))
}

/// Parses the optional `cli` / `socket` / `host` parameters off a
/// docker-family argument object. Absent or empty values yield the
/// stock Docker invocation, so legacy callers are byte-for-byte unchanged.
pub fn parse_engine(params: &Value) -> Result<EngineConfig, String> {
    let cli = match params.get("cli") {
        None | Some(Value::Null) => DEFAULT_CLI.to_string(),
        Some(Value::String(cli)) => {
            let cli = cli.trim();
            // Empty string behaves like an absent parameter (default CLI).
            if !cli.is_empty() {
                validate_cli(cli)?;
            }
            if cli.is_empty() {
                DEFAULT_CLI.to_string()
            } else {
                cli.to_string()
            }
        }
        Some(other) => return Err(format!("Invalid cli {other}: expected a string")),
    };
    let str_param = |key: &str| -> Result<Option<&str>, String> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.as_str())),
            Some(other) => Err(format!("Invalid {key} {other}: expected a string")),
        }
    };
    let endpoint = normalize_endpoint(str_param("socket")?, str_param("host")?)?;
    Ok(EngineConfig { cli, endpoint })
}

impl EngineConfig {
    /// POSIX prefix baked in front of collector bodies and one-shot
    /// commands: an `export` of both engines' endpoint env vars (Docker
    /// reads `DOCKER_HOST`, Podman reads `CONTAINER_HOST`), or an empty
    /// string when the default daemon socket applies.
    pub fn env_prefix(&self) -> String {
        match &self.endpoint {
            None => String::new(),
            Some(endpoint) => {
                let quoted = exec::shell_quote(endpoint);
                format!("export DOCKER_HOST={quoted} CONTAINER_HOST={quoted}; ")
            }
        }
    }

    /// Windows cmd fallback shape of [`EngineConfig::env_prefix`]: two
    /// `set` lines for the line-based fallback collector, or empty.
    pub fn cmd_env_lines(&self) -> String {
        match &self.endpoint {
            None => String::new(),
            Some(endpoint) => {
                format!("set DOCKER_HOST={endpoint}\r\nset CONTAINER_HOST={endpoint}\r\n")
            }
        }
    }

    /// Windows cmd inline shape: `set …&&` chaining in front of the bare
    /// fallback commands (`cmd /c`-style, same line). Empty by default.
    pub fn cmd_env_prefix(&self) -> String {
        match &self.endpoint {
            None => String::new(),
            Some(endpoint) => {
                format!("set DOCKER_HOST={endpoint}&& set CONTAINER_HOST={endpoint}&& ")
            }
        }
    }
}

// —— Scripts ——————————————————————————————————————————————

/// Raw POSIX collector body (PATH hardening + probe + `<cli> ps`), shared
/// by the heredoc wrapper ([`list_script`]) and the Quick Sudo elevated
/// retry — the latter passes the body through `sanitize_sudo_command`
/// (`sudo -S -p '' sh -c '<escaped>'`) so sudo's stdin stays free for the
/// password while the script travels as argv. `engine.env_prefix()` bakes
/// the endpoint export in as part of the body text, so the elevated path
/// keeps it too (sudo's env_reset cannot strip what is in the script).
pub fn list_body(engine: &EngineConfig) -> String {
    format!(
        "{PATH_PREFIX}{export}\
         echo DBXDOCKER_PROBE\n\
         if command -v {cli} >/dev/null 2>&1; then echo docker-found; else echo docker-missing; fi\n\
         if {cli} info >/dev/null 2>&1; then echo daemon-ok; else echo daemon-denied; fi\n\
         echo DBXDOCKER_PS\n\
         {cli} ps -a --no-trunc --format '{PS_FORMAT}' 2>/dev/null\n",
        export = engine.env_prefix(),
        cli = engine.cli,
    )
}

/// Container list collector. The probe section distinguishes "CLI not
/// installed" (available: false) from "daemon socket denied" (available:
/// false plus needsSudo: true, the docker-group hint) so the panel can
/// explain *why* a host shows an empty list instead of a bare empty state.
///
/// The PATH line is load-bearing: non-interactive shells (sshd exec, macOS
/// GUI children) carry a skeletal PATH where Homebrew (`/opt/homebrew/bin`,
/// `/usr/local/bin`), Docker Desktop and OrbStack installs are invisible,
/// so a bare `command -v docker` reports "not installed" on healthy hosts.
pub fn list_script(engine: &EngineConfig) -> String {
    format!("sh -s <<'DBXDOCKER'\n{}DBXDOCKER\n", list_body(engine))
}

/// cmd.exe fallback collector for Windows OpenSSH hosts, where the default
/// shell has no `sh` and the heredoc above produces no markers at all. The
/// trigger is the missing `DBXDOCKER_PROBE` marker (POSIX hosts always emit
/// it, even on a docker-missing verdict), so the retry costs one extra
/// round-trip only on hosts that garbled the first collector. cmd emits
/// CRLF, which the parsers already trim field by field. A configured
/// endpoint travels as `set` lines (the charset gate keeps the values
/// cmd-inert).
pub fn win_list_script(engine: &EngineConfig) -> String {
    format!(
        "echo DBXDOCKER_PROBE\r\n{env}\
         where /q {cli} 2>nul && echo docker-found || echo docker-missing\r\n\
         {cli} info >nul 2>&1 && echo daemon-ok || echo daemon-denied\r\n\
         echo DBXDOCKER_PS\r\n\
         {cli} ps -a --no-trunc --format \"{PS_FORMAT}\" 2>nul\r\n",
        env = engine.cmd_env_lines(),
        cli = engine.cli,
    )
}

/// True when the collector output carries no `DBXDOCKER_PROBE` marker at
/// all — the signature of a remote shell that cannot run the heredoc
/// (Windows cmd/PowerShell). POSIX hosts always emit the marker, even on a
/// docker-missing verdict, so the [`WIN_LIST_SCRIPT`] retry costs one
/// extra round-trip only on hosts that garbled the first collector.
pub fn needs_windows_fallback(output: &str) -> bool {
    !output.contains("DBXDOCKER_PROBE")
}

/// The `docker ps --format` template shared by the remote LIST_SCRIPT and
/// the local direct-exec collector (7 tab-separated columns, docker's own
/// `\t` escapes). One test pins LIST_SCRIPT to this constant so the two
/// collection paths cannot drift apart.
pub const PS_FORMAT: &str =
    "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}\\t{{.CreatedAt}}";

/// PATH hardening prepended to every remote collector heredoc (same
/// well-known install dirs as the local CLI discovery below). Actions keep
/// the bare cli verb: the approval text is derived from that exact
/// rendering, and a list that succeeded proves the CLI resolves.
pub const PATH_PREFIX: &str = concat!(
    "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin:/snap/bin",
    ":/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin",
    ":$HOME/.orbstack/bin:$HOME/bin:$HOME/.local/bin\"\n",
);

/// Elevated logs body for the Quick Sudo retry of `docker/logs`: same
/// inspect→logs order as [`logs_script`], passed as argv (never stdin, the
/// password owns it) through `sanitize_sudo_command` by the callers.
pub fn sudo_logs_body(
    engine: &EngineConfig,
    container_id: &str,
    tail: u64,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    let tail = clamp_tail(tail);
    Ok(format!(
        "{PATH_PREFIX}{export}\
         echo DBXDOCKER_INSPECT\n\
         {cli} inspect {container_id} 2>/dev/null\n\
         echo DBXDOCKER_LOGS\n\
         {cli} logs --tail {tail} {container_id} 2>&1\n",
        export = engine.env_prefix(),
        cli = engine.cli,
    ))
}

/// Builds the logs + inspect collector for one container. Inspect runs
/// first so the (potentially large) log tail cannot bury the marker scan,
/// and the log section is last by construction (everything after its
/// marker is the log text, `2>&1` merged so permission errors surface).
pub fn logs_script(engine: &EngineConfig, container_id: &str, tail: u64) -> Result<String, String> {
    validate_container_id(container_id)?;
    let tail = clamp_tail(tail);
    Ok(format!(
        "sh -s <<'DBXDOCKER'\n\
         {PATH_PREFIX}{export}\
         echo DBXDOCKER_INSPECT\n\
         {cli} inspect {container_id} 2>/dev/null\n\
         echo DBXDOCKER_LOGS\n\
         {cli} logs --tail {tail} {container_id} 2>&1\n\
         DBXDOCKER\n",
        export = engine.env_prefix(),
        cli = engine.cli,
    ))
}

/// Lifecycle verbs the panel may run. Anything outside this whitelist is
/// rejected before any remote I/O (`parse_action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerAction {
    Start,
    Stop,
    Restart,
    Kill,
    Remove,
}

impl DockerAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Kill => "kill",
            Self::Remove => "rm",
        }
    }
}

/// Parses the requested action name. Unknown verbs fail with the accepted
/// list in the error (typo-guidance style, like metrics sections).
pub fn parse_action(name: &str) -> Result<DockerAction, String> {
    match name {
        "start" => Ok(DockerAction::Start),
        "stop" => Ok(DockerAction::Stop),
        "restart" => Ok(DockerAction::Restart),
        "kill" => Ok(DockerAction::Kill),
        "rm" | "remove" => Ok(DockerAction::Remove),
        _ => Err(format!(
            "Unsupported docker action '{}'. Supported: start, stop, restart, kill, rm",
            name
        )),
    }
}

/// Renders the remote command for one action as the approval/audit text:
/// `{cli} {action} {id}` — no endpoint env prefix (the gate text must stay
/// short and stable). The id is inserted verbatim; callers must have run
/// [`validate_container_id`] (both protocol entry points do, and the
/// format! below only ever receives validated input).
pub fn action_command(engine: &EngineConfig, action: DockerAction, container_id: &str) -> String {
    format!("{} {} {}", engine.cli, action.as_str(), container_id)
}

/// The command actually executed: the endpoint export (if any) prepended
/// to [`action_command`]. POSIX shells only — Windows hosts reach actions
/// through the same text (`set` prefixes never gate actions because the
/// daemon-permission fallback does not apply there).
pub fn exec_command(engine: &EngineConfig, action: DockerAction, container_id: &str) -> String {
    format!(
        "{}{}",
        engine.env_prefix(),
        action_command(engine, action, container_id)
    )
}

/// Container id gate: `^[0-9a-f]{12,64}$`. Hand-rolled (no regex needed):
/// lowercase hex only, 12 (short id) to 64 (full sha256) chars. Anything
/// else — names, ids with shells metacharacters, uppercase — is refused
/// before a command is ever rendered.
pub fn validate_container_id(container_id: &str) -> Result<(), String> {
    let valid_len = (12..=64).contains(&container_id.len());
    let hex_only = container_id
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if valid_len && hex_only {
        return Ok(());
    }
    Err(format!(
        "Invalid containerId '{container_id}': expected 12-64 lowercase hex characters"
    ))
}

/// Clamps the requested tail line count into [10, 2000].
pub fn clamp_tail(tail: u64) -> u64 {
    tail.clamp(TAIL_MIN, TAIL_MAX)
}

// —— Parsing (pure, fixture-tested) ———————————————————————

/// One row of `docker ps -a --format` (tab-separated, NyaTerm field set).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

/// Extracts the text between two exact marker lines (end marker optional —
/// everything after the start marker is returned). Exact whole-line
/// equality on both ends; the sentinel names are unusual enough that a
/// container log echoing them stays a documented corner case.
fn marker_section<'a>(output: &'a str, start: &str, end: Option<&str>) -> &'a str {
    let mut cursor = 0usize;
    let mut begin: Option<usize> = None;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim();
        if let Some(start_at) = begin {
            if Some(trimmed) == end {
                return &output[start_at..cursor];
            }
        } else if trimmed == start {
            begin = Some(cursor + line.len());
        }
        cursor += line.len();
    }
    match begin {
        Some(start_at) => &output[start_at..],
        None => "",
    }
}

/// Probe verdict for one host: docker CLI present, daemon reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Probe {
    pub docker_found: bool,
    pub daemon_ok: bool,
}

/// Parses the `DBXDOCKER_PROBE` section (two self-describing lines).
pub fn parse_probe(output: &str) -> Probe {
    let mut probe = Probe::default();
    for line in marker_section(output, "DBXDOCKER_PROBE", Some("DBXDOCKER_PS")).lines() {
        match line.trim() {
            "docker-found" => probe.docker_found = true,
            "daemon-ok" => probe.daemon_ok = true,
            _ => {}
        }
    }
    probe
}

/// Parses the tab-separated `docker ps` section. Malformed rows (wrong
/// column count, empty ids) are skipped line by line — one bad row must
/// never hide the rest of the list.
pub fn parse_ps_section(section: &str) -> Vec<ContainerRow> {
    let mut rows = Vec::new();
    for line in section.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 || fields[0].trim().is_empty() {
            continue;
        }
        rows.push(ContainerRow {
            id: fields[0].trim().to_string(),
            name: fields[1].trim().to_string(),
            image: fields[2].trim().to_string(),
            state: fields[3].trim().to_string(),
            status: fields[4].trim().to_string(),
            ports: fields[5].trim().to_string(),
            created_at: fields[6].trim().to_string(),
        });
    }
    rows
}

/// Assembles the `docker/list` payload from raw script output:
/// `{available, needsSudo, containers}`. `needsSudo` is the found-but-
/// denied combination (docker CLI present, daemon socket refused) — the
/// actions still have a path via the Quick Sudo fallback.
pub fn list_payload(output: &str) -> Value {
    let probe = parse_probe(output);
    let available = probe.docker_found && probe.daemon_ok;
    let needs_sudo = probe.docker_found && !probe.daemon_ok;
    let containers = parse_ps_section(marker_section(output, "DBXDOCKER_PS", None));
    json!({
        "available": available,
        "needsSudo": needs_sudo,
        "containers": containers,
    })
}

/// Key fields projected out of one `docker inspect` JSON document.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InspectSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub running: bool,
    pub started_at: String,
    pub health: Option<String>,
    pub restart_policy: String,
}

/// Parses `docker inspect` output (a JSON array; the first element wins)
/// into the summary. Missing/absent fields degrade to defaults so a
/// truncated or exotic inspect document never fails the logs view.
pub fn parse_inspect_output(text: &str) -> Option<InspectSummary> {
    let parsed: Value = serde_json::from_str(text.trim()).ok()?;
    let container = parsed.as_array()?.first()?;
    let state = container.get("State");
    let string_at = |pointer: &str| -> String {
        container
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(InspectSummary {
        id: string_at("/Id"),
        name: string_at("/Name").trim_start_matches('/').to_string(),
        image: string_at("/Config/Image"),
        status: state
            .and_then(|state| state.get("Status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        running: state
            .and_then(|state| state.get("Running"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        started_at: state
            .and_then(|state| state.get("StartedAt"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        health: state
            .and_then(|state| state.get("Health"))
            .and_then(|health| health.get("Status"))
            .and_then(Value::as_str)
            .map(str::to_string),
        restart_policy: container
            .pointer("/HostConfig/RestartPolicy/Name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// Assembles the `docker/logs` payload: `{logs, container}` where
/// `container` is the optional inspect summary (null when inspect failed,
/// e.g. the container vanished between list and logs).
pub fn logs_payload(output: &str) -> Value {
    let inspect_text = marker_section(output, "DBXDOCKER_INSPECT", Some("DBXDOCKER_LOGS"));
    let logs = marker_section(output, "DBXDOCKER_LOGS", None);
    json!({
        "logs": logs,
        "container": parse_inspect_output(inspect_text),
    })
}

/// True when a failed plain run is the docker-daemon socket permission
/// error — the only failure shape that justifies the sudo fallback. Every
/// other failure must stay terminal: retrying a half-executed action with
/// sudo could double-apply a state change.
pub fn is_daemon_permission_failure(exit_code: i32, output: &str) -> bool {
    exit_code != 0 && output.to_ascii_lowercase().contains("permission denied")
}

/// Readable error when even the Quick Sudo fallback failed; points at the
/// configuration surface instead of leaking raw sudo noise.
pub fn sudo_fallback_error(error: String) -> String {
    format!(
        "{error}. Docker actions need daemon permission: add the user to the \
         docker group on the host, or configure Quick Sudo for this connection \
         (connection settings > Quick Sudo) so the panel can elevate."
    )
}

// —— Handle-plane collectors (MCP tool path) ——————————————

/// `docker_list`: list_script round-trip on a fresh exec channel, then
/// the two graceful repairs in order —
/// 1. **Windows fallback**: output without the probe marker means the
///    remote default shell garbled the heredoc (cmd/PowerShell); retry
///    once with [`win_list_script`].
/// 2. **Quick Sudo elevation**: found-but-denied probe with resolvable
///    Quick Sudo credentials retries the same body under
///    `sudo -S sh -c '<body>'` (password on stdin, script as argv). Any
///    elevation failure degrades to the plain payload so the panel keeps
///    its needsSudo hint instead of erroring the read-only call.
pub async fn collect_list(
    handle: &Handle<SshClient>,
    sudo_auth: Option<&exec::SudoAuth>,
    engine: &EngineConfig,
) -> Result<Value, String> {
    let outcome = exec::exec_plain(handle, &list_script(engine), LIST_TIMEOUT, &[]).await?;
    let mut output = outcome.output;
    if needs_windows_fallback(&output) {
        let windows = exec::exec_plain(handle, &win_list_script(engine), LIST_TIMEOUT, &[]).await?;
        if !needs_windows_fallback(&windows.output) {
            output = windows.output;
        }
    }
    let plain_payload = list_payload(&output);
    if plain_payload["available"] == true || plain_payload["needsSudo"] != true {
        return Ok(plain_payload);
    }
    let Some(auth) = sudo_auth else {
        return Ok(plain_payload);
    };
    let elevated =
        exec::exec_with_sudo(handle, auth, &list_body(engine), LIST_TIMEOUT, false, &[]).await?;
    let elevated_payload = list_payload(&elevated.output);
    // Only trust the elevated run when its probe actually cleared the
    // socket denial; a garbled or refused sudo attempt keeps the hint.
    if elevated_payload["available"] == true {
        Ok(elevated_payload)
    } else {
        Ok(plain_payload)
    }
}

/// `docker_action` for the MCP plane: plain run first; on the daemon
/// permission signature only, retries through the Quick Sudo pipeline
/// (`exec_with_sudo` pipes the password over stdin, never the command
/// line, and answers TOTP follow-up prompts). `sudo_auth: None` (no
/// resolvable credentials) skips the fallback and returns the guidance.
/// The elevation rerun uses the same full text (endpoint export included)
/// so the elevated daemon target matches the plain attempt.
pub async fn perform_action(
    handle: &Handle<SshClient>,
    sudo_auth: Option<&exec::SudoAuth>,
    use_pty: bool,
    engine: &EngineConfig,
    container_id: &str,
    action: DockerAction,
) -> Result<Value, String> {
    let command = exec_command(engine, action, container_id);
    let outcome = exec::exec_plain(handle, &command, ACTION_TIMEOUT, &[]).await?;
    if outcome.exit_code == 0 {
        return Ok(json!({ "success": true, "output": outcome.output }));
    }
    if is_daemon_permission_failure(outcome.exit_code, &outcome.output) {
        let Some(auth) = sudo_auth else {
            return Err(sudo_fallback_error(format!(
                "{} {}: {}",
                engine.cli,
                action.as_str(),
                outcome.output
            )));
        };
        return match exec::exec_with_sudo(handle, auth, &command, ACTION_TIMEOUT, use_pty, &[])
            .await
        {
            Ok(sudo_outcome) => Ok(json!({ "success": true, "output": sudo_outcome.output })),
            Err(error) => Err(sudo_fallback_error(error)),
        };
    }
    Err(format!(
        "{} {} failed (exit {}): {}",
        engine.cli,
        action.as_str(),
        outcome.exit_code,
        outcome.output
    ))
}

// —— Local-machine plane (workbench/MCP `target: "local"`) ———————————————

/// Target selector for the docker family: the default `ssh` keeps the
/// historic session/connection semantics, `local` runs against the docker
/// daemon on the machine the sidecar runs on (Docker Desktop, OrbStack,
/// rootless installs). Unknown values fail before any process is spawned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerTarget {
    Ssh,
    Local,
}

pub fn parse_target(params: &Value) -> Result<DockerTarget, String> {
    match params.get("target") {
        None | Some(Value::Null) => Ok(DockerTarget::Ssh),
        Some(Value::String(target)) => match target.as_str() {
            "ssh" => Ok(DockerTarget::Ssh),
            "local" => Ok(DockerTarget::Local),
            other => Err(format!(
                "Unsupported docker target '{other}'. Supported: ssh (default), local"
            )),
        },
        Some(other) => Err(format!(
            "Invalid docker target {other}: expected \"ssh\" or \"local\""
        )),
    }
}

/// Well-known docker CLI install dirs beyond PATH, per platform. macOS GUI
/// processes (DBX → sidecar) and non-interactive remote shells inherit a
/// skeletal PATH, so Homebrew, Docker Desktop, OrbStack and rootless
/// installs are invisible to a bare lookup — the local plane probes these
/// explicitly, exactly like [`LIST_SCRIPT`]'s PATH line does remotely.
pub fn cli_search_dirs(home: &Path, is_windows: bool) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = if is_windows {
        vec!["C:\\Program Files\\Docker\\Docker\\resources\\bin".into()]
    } else {
        vec!["/usr/local/bin".into(), "/opt/homebrew/bin".into()]
    };
    dirs.push(home.join(".docker").join("bin"));
    dirs.push(home.join(".orbstack").join("bin"));
    dirs.push(home.join("bin"));
    dirs.push(home.join(".local").join("bin"));
    if is_windows {
        dirs.push("C:\\ProgramData\\DockerDesktop\\version-bin".into());
    } else {
        dirs.push("/snap/bin".into());
        dirs.push("/Applications/Docker.app/Contents/Resources/bin".into());
    }
    dirs
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolves the local container CLI: an explicit `cli` that looks like a
/// path (`/usr/local/bin/podman`, `C:\...\docker.exe`) is probed directly;
/// a bare name resolves through PATH first, then [`cli_search_dirs`].
/// Returns the executable path so every local invocation is direct process
/// exec — no shell, nothing to quote, works on Windows too (where the
/// heredoc collector style has no `sh` to run under).
pub fn find_local_cli(cli: &str) -> Option<std::path::PathBuf> {
    let has_dir_part = cli.contains('/') || cli.contains('\\');
    let exe = if cfg!(windows) && !cli.to_ascii_lowercase().ends_with(".exe") {
        format!("{cli}.exe")
    } else {
        cli.to_string()
    };
    if has_dir_part {
        let path = std::path::PathBuf::from(&exe);
        return is_executable_file(&path).then_some(path);
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(&exe);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    for dir in cli_search_dirs(&home, cfg!(windows)) {
        let candidate = dir.join(&exe);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// One local `docker` invocation: direct exec (argv, no shell). Output is
/// `wait_with_output`'s stdout followed by stderr — NOT interleaved in
/// order-of-arrival (docker writes diagnostics to stderr and data to stdout,
/// so appending keeps `logs` 2>&1 semantics at the cost of ordering); bounded
/// by `timeout`. Exit code -1 covers signal deaths like the remote parse path.
/// A configured endpoint rides the engine's own env var (`DOCKER_HOST` /
/// `CONTAINER_HOST`) on the spawned process — never argv, never a shell.
async fn run_local(
    cli: &Path,
    args: &[&str],
    timeout: Duration,
    endpoint: Option<&str>,
) -> Result<(i32, String), String> {
    use std::process::Stdio;
    use tokio::process::Command;
    let mut command = Command::new(cli);
    command.args(args).stdin(Stdio::null());
    if let Some(endpoint) = endpoint {
        command
            .env("DOCKER_HOST", endpoint)
            .env("CONTAINER_HOST", endpoint);
    }
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("spawn {:?} failed: {error}", cli))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("{cli:?} timed out after {}s", timeout.as_secs()))?
        .map_err(|error| format!("container CLI failed: {error}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.code().unwrap_or(-1), text))
}

/// The unavailable payload shape, shared with the remote probe semantics:
/// `needsSudo` marks CLI-found-but-daemon-denied (the docker-group hint),
/// plain unavailable covers both "CLI missing" and "daemon not running"
/// with the generic empty state.
fn unavailable_payload(needs_sudo: bool) -> Value {
    json!({ "available": false, "needsSudo": needs_sudo, "containers": [] })
}

/// `docker/list` for `target: "local"`. Same payload contract as the
/// remote path — `available` / `needsSudo` / `containers` — assembled into
/// the same marker text so [`list_payload`] stays the single parser.
pub async fn collect_list_local(engine: &EngineConfig) -> Result<Value, String> {
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Ok(unavailable_payload(false));
    };
    let (info_code, info_output) = run_local(
        &cli,
        &["info", "--format", "{{.ServerVersion}}"],
        LIST_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if info_code != 0 {
        return Ok(unavailable_payload(is_daemon_permission_failure(
            info_code,
            &info_output,
        )));
    }
    let (_, ps_output) = run_local(
        &cli,
        &["ps", "-a", "--no-trunc", "--format", PS_FORMAT],
        LIST_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    Ok(list_payload(&format!(
        "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{ps_output}"
    )))
}

/// `docker/logs` for `target: "local"`: inspect first, then the tail, both
/// assembled into the marker text so [`logs_payload`] parses unchanged.
/// A failed inspect (container gone) degrades to `container: null` exactly
/// like the remote script's `2>/dev/null` section.
pub async fn collect_logs_local(
    engine: &EngineConfig,
    container_id: &str,
    tail: u64,
) -> Result<Value, String> {
    validate_container_id(container_id)?;
    let tail = clamp_tail(tail);
    let cli = find_local_cli(&engine.cli)
        .ok_or_else(|| format!("{} CLI not found on this machine", engine.cli))?;
    let (inspect_code, inspect_output) = run_local(
        &cli,
        &["inspect", container_id],
        LOGS_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if inspect_code != 0 && !inspect_output.trim_start().starts_with('[') {
        // Missing container: keep going into logs, which surface the same
        // "No such container" error — the remote script does the same.
        if is_daemon_permission_failure(inspect_code, &inspect_output) {
            return Err(format!(
                "{} inspect failed: {inspect_output}. Local container access \
                 needs daemon permission: start Docker Desktop/OrbStack/Podman \
                 Desktop, or add your user to the docker group.",
                engine.cli
            ));
        }
    }
    let tail_text = tail.to_string();
    let (_, logs_output) = run_local(
        &cli,
        &["logs", "--tail", &tail_text, container_id],
        LOGS_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    Ok(logs_payload(&format!(
        "DBXDOCKER_INSPECT\n{inspect_output}\nDBXDOCKER_LOGS\n{logs_output}"
    )))
}

/// `docker/action` for `target: "local"`. Same whitelist, id gate and
/// success contract as the remote plane; the sudo fallback does not exist
/// locally (no Quick Sudo plumbing for the machine itself), so a daemon
/// permission failure returns the actionable guidance instead.
pub async fn perform_action_local(
    engine: &EngineConfig,
    container_id: &str,
    action: DockerAction,
) -> Result<Value, String> {
    validate_container_id(container_id)?;
    let cli = find_local_cli(&engine.cli)
        .ok_or_else(|| format!("{} CLI not found on this machine", engine.cli))?;
    let (exit_code, output) = run_local(
        &cli,
        &[action.as_str(), container_id],
        ACTION_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if exit_code == 0 {
        return Ok(json!({ "success": true, "output": output }));
    }
    if is_daemon_permission_failure(exit_code, &output) {
        return Err(format!(
            "{} {}: {output}. Local container actions need daemon permission: \
             start Docker Desktop/OrbStack/Podman Desktop, or add your user to \
             the docker group.",
            engine.cli,
            action.as_str()
        ));
    }
    Err(format!(
        "{} {} failed (exit {}): {}",
        engine.cli,
        action.as_str(),
        exit_code,
        output
    ))
}

// —— Audit (workbench docker/action path) ——————————————————

fn audit_row(
    data_dir: &Path,
    command: &str,
    outcome: audit_log::EntryOutcome,
    error: Option<&str>,
    duration_ms: u64,
) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let entry = audit_log::AuditEntry {
        ts_ms,
        tool: "docker/action".to_string(),
        // The workbench path keys on sessionId; the connection column stays
        // empty exactly like MCP rows without a connectionId argument.
        connection_id: String::new(),
        gate: audit_log::GateOutcome::Pass,
        approval: audit_log::ApprovalTrail::None,
        outcome,
        exit_code: None,
        duration_ms,
        mode: audit_log::ExecMode::Stdio,
        command: Some(command.to_string()),
        output: None,
        error: error.map(|error| error.chars().take(256).collect()),
    };
    if let Err(error) = audit_log::append(data_dir, &entry) {
        eprintln!("[docker] audit append failed: {error}");
    }
}

/// Mandatory pre-execution audit row: the intent is on the ledger even if
/// the sidecar dies between the audit write and the remote run.
pub fn audit_action_intent(data_dir: &Path, command: &str) {
    audit_row(data_dir, command, audit_log::EntryOutcome::Ok, None, 0);
}

/// Post-execution failure row (success is already covered by the intent
/// row; only failures add a second entry carrying the error text).
pub fn audit_action_failure(data_dir: &Path, command: &str, error: &str, duration_ms: u64) {
    audit_row(
        data_dir,
        command,
        audit_log::EntryOutcome::Error,
        Some(error),
        duration_ms,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `docker ps -a` output as the script emits it: tab-separated, one
    /// running and one exited container.
    const PS_FIXTURE: &str = "\
d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp, :::8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC
9f8e7d6c5b4a\tcache\tredis:7-alpine\texited\tExited (0) 2 hours ago\t\t2026-09-18 21:30:00 +0000 UTC
";

    const LIST_FIXTURE_WITH_ROWS: &str = "\
DBXDOCKER_PROBE
docker-found
daemon-ok
DBXDOCKER_PS
d4a7c9f1e2b3\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC
9f8e7d6c5b4a\tcache\tredis:7-alpine\texited\tExited (0) 2 hours ago\t\t2026-09-18 21:30:00 +0000 UTC
";

    const INSPECT_FIXTURE: &str = r#"[
    {
        "Id": "sha256:d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7",
        "Created": "2026-09-01T08:15:03.9Z",
        "Path": "nginx",
        "Name": "/web-nginx",
        "State": {
            "Status": "running",
            "Running": true,
            "StartedAt": "2026-09-20T06:00:00.1Z",
            "Health": { "Status": "healthy" }
        },
        "Config": { "Image": "nginx:1.27" },
        "HostConfig": { "RestartPolicy": { "Name": "unless-stopped" } }
    }
]"#;

    #[test]
    fn parses_container_rows_from_tab_output() {
        let rows = parse_ps_section(PS_FIXTURE);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id.len(), 64);
        assert_eq!(rows[0].name, "web-nginx");
        assert_eq!(rows[0].state, "running");
        assert_eq!(rows[0].ports, "0.0.0.0:8080->80/tcp, :::8080->80/tcp");
        assert_eq!(rows[0].created_at, "2026-09-01 08:15:04 +0000 UTC");
        // Empty ports column survives as an empty string (exited container).
        assert_eq!(rows[1].id, "9f8e7d6c5b4a");
        assert_eq!(rows[1].ports, "");
        assert_eq!(rows[1].state, "exited");
    }

    #[test]
    fn malformed_ps_rows_are_skipped_line_by_line() {
        let text = "only-three-columns\there\tyeah\n\
                     \t\n\
                     9f8e7d6c5b4a\tcache\tredis:7\texited\tExited (0)\t\t2026-09-18 21:30:00 +0000 UTC\n";
        let rows = parse_ps_section(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "cache");
        assert!(parse_ps_section("").is_empty());
        assert!(parse_ps_section("no tabs at all\n").is_empty());
    }

    #[test]
    fn list_payload_reports_available_and_containers() {
        let payload = list_payload(LIST_FIXTURE_WITH_ROWS);
        assert_eq!(payload["available"], true);
        assert_eq!(payload["needsSudo"], false);
        assert_eq!(payload["containers"].as_array().unwrap().len(), 2);
        assert_eq!(payload["containers"][0]["name"], "web-nginx");
        assert_eq!(payload["containers"][0]["id"], "d4a7c9f1e2b3");
    }

    #[test]
    fn list_payload_marks_missing_docker_unavailable() {
        let output = "DBXDOCKER_PROBE\ndocker-missing\ndaemon-denied\nDBXDOCKER_PS\n";
        let payload = list_payload(output);
        assert_eq!(payload["available"], false);
        assert_eq!(payload["needsSudo"], false);
        assert_eq!(payload["containers"].as_array().unwrap().len(), 0);
        // Garbage or empty output (script failed entirely) degrades to the
        // unavailable state instead of erroring the whole call.
        let empty = list_payload("");
        assert_eq!(empty["available"], false);
    }

    #[test]
    fn list_payload_marks_daemon_denied_as_needs_sudo() {
        let output = "DBXDOCKER_PROBE\ndocker-found\ndaemon-denied\nDBXDOCKER_PS\n";
        let payload = list_payload(output);
        assert_eq!(payload["available"], false);
        assert_eq!(payload["needsSudo"], true);
    }

    #[test]
    fn container_id_gate_enforces_lowercase_hex_length() {
        assert!(validate_container_id("d4a7c9f1e2b3").is_ok()); // 12 hex
        assert!(validate_container_id(&"a".repeat(64)).is_ok()); // full sha
                                                                 // Too short / too long.
        assert!(validate_container_id("d4a7c9f1e2b").is_err());
        assert!(validate_container_id(&"a".repeat(65)).is_err());
        // Uppercase, names, separators, shell metacharacters.
        assert!(validate_container_id("D4A7C9F1E2B3").is_err());
        assert!(validate_container_id("web-nginx").is_err());
        assert!(validate_container_id("d4a7c9f1e2b3; rm -rf /").is_err());
        assert!(validate_container_id("d4a7c9f1 e2b3").is_err());
        assert!(validate_container_id("").is_err());
    }

    #[test]
    fn tail_clamps_into_the_documented_band() {
        assert_eq!(clamp_tail(0), TAIL_MIN);
        assert_eq!(clamp_tail(5), TAIL_MIN);
        assert_eq!(clamp_tail(200), 200);
        assert_eq!(clamp_tail(5000), TAIL_MAX);
        assert_eq!(clamp_tail(u64::MAX), TAIL_MAX);
    }

    #[test]
    fn action_whitelist_and_command_rendering() {
        assert_eq!(parse_action("start").unwrap(), DockerAction::Start);
        assert_eq!(parse_action("rm").unwrap(), DockerAction::Remove);
        assert_eq!(parse_action("remove").unwrap(), DockerAction::Remove);
        let error = parse_action("exec").unwrap_err();
        assert!(
            error.contains("Unsupported docker action 'exec'"),
            "{error}"
        );
        assert!(error.contains("start, stop, restart, kill, rm"), "{error}");
        assert!(parse_action("").is_err());
        assert!(parse_action("RM -RF /").is_err());

        let engine = EngineConfig::default();
        assert_eq!(
            action_command(&engine, DockerAction::Start, "d4a7c9f1e2b3"),
            "docker start d4a7c9f1e2b3"
        );
        assert_eq!(
            action_command(&engine, DockerAction::Remove, "d4a7c9f1e2b3"),
            "docker rm d4a7c9f1e2b3"
        );
        // Podman engine: the approval/audit text follows the configured CLI
        // (still no endpoint prefix — that rides env vars only).
        let podman = EngineConfig {
            cli: "podman".into(),
            endpoint: Some("unix:///run/user/1000/podman.sock".into()),
        };
        assert_eq!(
            action_command(&podman, DockerAction::Remove, "d4a7c9f1e2b3"),
            "podman rm d4a7c9f1e2b3"
        );
        assert_eq!(
            exec_command(&podman, DockerAction::Remove, "d4a7c9f1e2b3"),
            "export DOCKER_HOST='unix:///run/user/1000/podman.sock' \
             CONTAINER_HOST='unix:///run/user/1000/podman.sock'; podman rm d4a7c9f1e2b3"
        );
        assert_eq!(
            exec_command(&engine, DockerAction::Stop, "d4a7c9f1e2b3"),
            "docker stop d4a7c9f1e2b3"
        );
    }

    /// The stock-engine renderings must stay byte-identical to the legacy
    /// const scripts (upgrade-safe: old audit expectations keep matching).
    const LEGACY_LIST_BODY: &str = concat!(
        "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin:/snap/bin",
        ":/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin",
        ":$HOME/.orbstack/bin:$HOME/bin:$HOME/.local/bin\"\n",
        "echo DBXDOCKER_PROBE\n",
        "if command -v docker >/dev/null 2>&1; then echo docker-found; else echo docker-missing; fi\n",
        "if docker info >/dev/null 2>&1; then echo daemon-ok; else echo daemon-denied; fi\n",
        "echo DBXDOCKER_PS\n",
        "docker ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}\\t{{.CreatedAt}}' 2>/dev/null\n",
    );

    #[test]
    fn parse_engine_defaults_validates_and_normalizes() {
        // Absent/empty params = stock docker, no endpoint.
        assert_eq!(
            parse_engine(&json!({})).unwrap(),
            EngineConfig {
                cli: "docker".into(),
                endpoint: None
            }
        );
        assert_eq!(
            parse_engine(&json!({ "cli": "", "socket": "", "host": "" })).unwrap(),
            EngineConfig {
                cli: "docker".into(),
                endpoint: None
            }
        );
        // Podman by name; whitespace tolerated.
        assert_eq!(
            parse_engine(&json!({ "cli": " podman " })).unwrap().cli,
            "podman"
        );
        // Full path + socket URL pass through; bare socket path gains unix://.
        let engine = parse_engine(
            &json!({ "cli": "/usr/local/bin/podman", "socket": "/run/user/1000/podman.sock" }),
        )
        .unwrap();
        assert_eq!(engine.cli, "/usr/local/bin/podman");
        assert_eq!(
            engine.endpoint.as_deref(),
            Some("unix:///run/user/1000/podman.sock")
        );
        // Bare host:port gains tcp://; explicit schemes pass through.
        assert_eq!(
            parse_engine(&json!({ "host": "127.0.0.1:2375" }))
                .unwrap()
                .endpoint
                .as_deref(),
            Some("tcp://127.0.0.1:2375")
        );
        assert_eq!(
            parse_engine(&json!({ "host": "tcp://10.0.0.8:2376" }))
                .unwrap()
                .endpoint
                .as_deref(),
            Some("tcp://10.0.0.8:2376")
        );
        // Mutually exclusive endpoints are refused.
        let error =
            parse_engine(&json!({ "socket": "/x.sock", "host": "1.2.3.4:2375" })).unwrap_err();
        assert!(error.contains("mutually exclusive"), "{error}");
        // Charset gate: shell/cmd metacharacters never reach a script.
        assert!(parse_engine(&json!({ "cli": "podman; rm -rf /" })).is_err());
        assert!(parse_engine(&json!({ "cli": "docker --bad space" })).is_err());
        // Whitespace-only behaves like absent (default), per the empty rule.
        assert_eq!(parse_engine(&json!({ "cli": " " })).unwrap().cli, "docker");
        assert!(parse_engine(&json!({ "socket": "unix:///a b.sock" })).is_err());
        assert!(parse_engine(&json!({ "host": "no-port-here" })).is_err());
        assert!(parse_engine(&json!({ "cli": 42 })).is_err());
    }

    #[test]
    fn engine_env_prefixes_cover_posix_and_cmd() {
        let plain = EngineConfig::default();
        assert_eq!(plain.env_prefix(), "");
        assert_eq!(plain.cmd_env_lines(), "");
        assert_eq!(plain.cmd_env_prefix(), "");
        let engine = EngineConfig {
            cli: "podman".into(),
            endpoint: Some("unix:///run/podman/podman.sock".into()),
        };
        assert_eq!(
            engine.env_prefix(),
            "export DOCKER_HOST='unix:///run/podman/podman.sock' CONTAINER_HOST='unix:///run/podman/podman.sock'; "
        );
        assert_eq!(
            engine.cmd_env_lines(),
            "set DOCKER_HOST=unix:///run/podman/podman.sock\r\nset CONTAINER_HOST=unix:///run/podman/podman.sock\r\n"
        );
        assert_eq!(
            engine.cmd_env_prefix(),
            "set DOCKER_HOST=unix:///run/podman/podman.sock&& set CONTAINER_HOST=unix:///run/podman/podman.sock&& "
        );
    }

    #[test]
    fn list_scripts_follow_engine_and_stay_legacy_compatible() {
        // Default engine: byte-identical to the legacy const collectors.
        let default = EngineConfig::default();
        assert_eq!(
            list_script(&default),
            format!("sh -s <<'DBXDOCKER'\n{LEGACY_LIST_BODY}DBXDOCKER\n")
        );
        // Podman + endpoint: cli interpolated, endpoint exported in-body so
        // the Quick Sudo retry (which passes the body as argv) keeps it.
        let podman =
            parse_engine(&json!({ "cli": "podman", "socket": "/run/user/1000/podman.sock" }))
                .unwrap();
        let script = list_script(&podman);
        assert!(script.starts_with("sh -s <<'DBXDOCKER'"), "{script}");
        assert!(script.contains("command -v podman"), "{script}");
        assert!(script.contains("podman info"), "{script}");
        assert!(script.contains("podman ps -a --no-trunc"), "{script}");
        assert!(
            script.contains("export DOCKER_HOST='unix:///run/user/1000/podman.sock'"),
            "{script}"
        );
        assert_eq!(
            list_body(&podman),
            script
                .trim_start_matches("sh -s <<'DBXDOCKER'\n")
                .trim_end_matches("DBXDOCKER\n")
        );
        // Windows fallback: same interpolation, cmd set lines for endpoint.
        let win = win_list_script(&podman);
        assert!(win.contains("where /q podman"), "{win}");
        assert!(win.contains("podman ps -a"), "{win}");
        assert!(
            win.contains("set DOCKER_HOST=unix:///run/user/1000/podman.sock"),
            "{win}"
        );
        assert!(!win.contains("sh -s"), "{win}");
        let win_default = win_list_script(&default);
        assert!(win_default.contains("where /q docker"), "{win_default}");
        assert!(!win_default.contains("set DOCKER_HOST"), "{win_default}");
    }

    #[test]
    fn logs_and_sudo_bodies_follow_engine() {
        let podman = parse_engine(&json!({ "cli": "podman", "host": "127.0.0.1:2375" })).unwrap();
        let script = logs_script(&podman, "d4a7c9f1e2b3", 120).unwrap();
        assert!(script.starts_with("sh -s <<'DBXDOCKER'"), "{script}");
        assert!(script.contains("podman inspect d4a7c9f1e2b3"), "{script}");
        assert!(
            script.contains("podman logs --tail 120 d4a7c9f1e2b3"),
            "{script}"
        );
        assert!(
            script.contains("export DOCKER_HOST='tcp://127.0.0.1:2375'"),
            "{script}"
        );
        let clamped = logs_script(&podman, "d4a7c9f1e2b3", 99_999).unwrap();
        assert!(clamped.contains("podman logs --tail 2000"), "{clamped}");
        assert!(logs_script(&podman, "web-nginx", 100).is_err());
        // Sudo body: same content, no heredoc wrapper (stdin = password).
        let body = sudo_logs_body(&podman, "d4a7c9f1e2b3", 120).unwrap();
        assert!(body.starts_with("PATH="), "{body}");
        assert!(body.contains("podman inspect d4a7c9f1e2b3"), "{body}");
        assert!(
            body.contains("export DOCKER_HOST='tcp://127.0.0.1:2375'"),
            "{body}"
        );
        assert!(!body.contains("sh -s"), "{body}");
        assert!(sudo_logs_body(&podman, "web-nginx", 100).is_err());
    }

    #[test]
    fn marker_sections_split_inspect_and_logs() {
        let output =
            format!("DBXDOCKER_INSPECT\n{INSPECT_FIXTURE}\nDBXDOCKER_LOGS\nline one\nline two\n");
        let payload = logs_payload(&output);
        assert_eq!(payload["logs"], "line one\nline two\n");
        let container = &payload["container"];
        assert_eq!(container["name"], "web-nginx");
        assert_eq!(container["image"], "nginx:1.27");
        assert_eq!(container["status"], "running");
        assert_eq!(container["running"], true);
        assert_eq!(container["startedAt"], "2026-09-20T06:00:00.1Z");
        assert_eq!(container["health"], "healthy");
        assert_eq!(container["restartPolicy"], "unless-stopped");
        assert!(container["id"]
            .as_str()
            .unwrap()
            .starts_with("sha256:d4a7c9f1"));
    }

    #[test]
    fn logs_payload_tolerates_missing_or_broken_inspect() {
        // No inspect section at all (probe failed before inspect ran).
        let no_inspect = logs_payload("DBXDOCKER_LOGS\nhello\n");
        assert_eq!(no_inspect["logs"], "hello\n");
        assert_eq!(no_inspect["container"], Value::Null);
        // Inspect section present but not JSON (docker wrote an error there).
        let broken = logs_payload("DBXDOCKER_INSPECT\nError: No such object\nDBXDOCKER_LOGS\n");
        assert_eq!(broken["container"], Value::Null);
        assert!(parse_inspect_output("").is_none());
        assert!(parse_inspect_output("[]").is_none());
        // Inspect object without the exotic fields still yields a summary.
        let minimal = parse_inspect_output(r#"[{"Id":"sha256:ab","Name":"/x"}]"#).unwrap();
        assert_eq!(minimal.name, "x");
        assert_eq!(minimal.image, "");
        assert_eq!(minimal.health, None);
    }

    #[test]
    fn daemon_permission_signature_gates_the_sudo_fallback() {
        // Real docker CLI wording on a socket-permission failure.
        assert!(is_daemon_permission_failure(
            1,
            "docker: Got permission denied while trying to connect to the Docker daemon socket"
        ));
        assert!(is_daemon_permission_failure(125, "permission denied"));
        // Case-insensitive match on the merged output.
        assert!(is_daemon_permission_failure(1, "PERMISSION DENIED"));
        // Success or any other failure shape must NOT trigger the fallback
        // (retrying a half-executed action with sudo could double-apply it).
        assert!(!is_daemon_permission_failure(0, "permission denied"));
        assert!(!is_daemon_permission_failure(
            1,
            "Error response from daemon: No such container: d4a7c9f1e2b3"
        ));
        assert!(!is_daemon_permission_failure(1, ""));
    }

    #[test]
    fn sudo_fallback_error_points_at_configuration() {
        let error = sudo_fallback_error("sudo exited 1: boom".to_string());
        assert!(error.contains("Quick Sudo"), "{error}");
        assert!(error.contains("docker group"), "{error}");
    }

    #[test]
    fn audit_rows_land_before_and_after_failures() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        audit_action_intent(data_dir, "docker restart d4a7c9f1e2b3");
        audit_action_failure(
            data_dir,
            "docker restart d4a7c9f1e2b3",
            "docker restart failed (exit 1): oops",
            42,
        );
        let entries = audit_log::tail(data_dir, 10, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tool, "docker/action");
        assert_eq!(entries[0].outcome, audit_log::EntryOutcome::Ok);
        assert_eq!(
            entries[0].command.as_deref(),
            Some("docker restart d4a7c9f1e2b3")
        );
        assert_eq!(entries[1].outcome, audit_log::EntryOutcome::Error);
        assert_eq!(
            entries[1].error.as_deref(),
            Some("docker restart failed (exit 1): oops")
        );
        assert_eq!(entries[1].duration_ms, 42);
    }

    // —— Local-machine plane ————————————————————————————————————

    /// The local direct-exec collector and the remote heredoc must share the
    /// exact `--format` template or `parse_ps_section` sees drifted columns.
    #[test]
    fn local_ps_format_is_the_remote_script_template() {
        // 钉死 heredoc 包裹与 body 的组合、以及两个收集器的 --format 模板，
        // 任一路径漂移即测试失败。
        assert!(PS_FORMAT.starts_with("{{.ID}}\\t{{.Names}}"));
        // The PATH hardening covers the well-known GUI-install locations.
        for fragment in [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
            "$HOME/.docker/bin",
            "$HOME/.orbstack/bin",
        ] {
            assert!(PATH_PREFIX.contains(fragment), "{PATH_PREFIX}");
            assert!(list_body(&EngineConfig::default()).contains(fragment));
        }
    }

    #[test]
    fn parse_target_defaults_to_ssh_and_rejects_unknown() {
        assert_eq!(parse_target(&json!({})), Ok(DockerTarget::Ssh));
        assert_eq!(
            parse_target(&json!({ "target": null })),
            Ok(DockerTarget::Ssh)
        );
        assert_eq!(
            parse_target(&json!({ "target": "ssh" })),
            Ok(DockerTarget::Ssh)
        );
        assert_eq!(
            parse_target(&json!({ "target": "local" })),
            Ok(DockerTarget::Local)
        );
        let error = parse_target(&json!({ "target": "remote" })).unwrap_err();
        assert!(
            error.contains("Unsupported docker target 'remote'"),
            "{error}"
        );
        assert!(error.contains("ssh (default), local"), "{error}");
        assert!(parse_target(&json!({ "target": 42 })).is_err());
    }

    #[test]
    fn cli_search_dirs_cover_home_and_platform_installs() {
        let home = Path::new("/Users/dev");
        let unix_dirs = cli_search_dirs(home, false);
        assert!(unix_dirs.contains(&std::path::PathBuf::from("/usr/local/bin")));
        assert!(unix_dirs.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
        assert!(unix_dirs.contains(&home.join(".docker/bin")));
        assert!(unix_dirs.contains(&home.join(".orbstack/bin")));
        assert!(unix_dirs.contains(&std::path::PathBuf::from(
            "/Applications/Docker.app/Contents/Resources/bin"
        )));
        let windows_dirs = cli_search_dirs(Path::new(r"C:\Users\dev"), true);
        assert!(windows_dirs.iter().any(|dir| {
            dir.as_os_str()
                .to_string_lossy()
                .contains("Docker\\Docker\\resources\\bin")
        }));
        // Home-derived dirs must not leak between platforms.
        assert!(!windows_dirs.iter().any(|dir| dir.starts_with("/usr/local")));
    }

    #[test]
    fn find_local_cli_resolves_explicit_paths() {
        // Path-form cli: a real executable file resolves verbatim (no
        // .exe suffixing, no PATH search); a missing path yields None.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let exe_path = dir.path().join("podman");
            std::fs::write(&exe_path, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();
            let found = find_local_cli(exe_path.to_str().unwrap()).unwrap();
            assert_eq!(found, exe_path);
        }
        assert!(find_local_cli("/definitely/not/a/real/container-cli").is_none());
    }

    #[test]
    fn windows_fallback_triggers_only_without_probe_marker() {
        // POSIX hosts always emit the marker — even on docker-missing.
        assert!(!needs_windows_fallback(LIST_FIXTURE_WITH_ROWS));
        assert!(!needs_windows_fallback(
            "DBXDOCKER_PROBE\ndocker-missing\ndaemon-denied\nDBXDOCKER_PS\n"
        ));
        // cmd garbling the heredoc: no markers at all.
        assert!(needs_windows_fallback(""));
        assert!(needs_windows_fallback(
            "'sh' is not recognized as an internal or external command\r\n"
        ));
    }

    #[test]
    fn windows_collector_output_parses_crlf_like_posix() {
        // cmd emits CRLF; the parsers must trim \r field by field.
        let crlf_output = "DBXDOCKER_PROBE\r\ndocker-found\r\ndaemon-ok\r\nDBXDOCKER_PS\r\nd4a7c9f1e2b3\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC\r\n";
        let payload = list_payload(crlf_output);
        assert_eq!(payload["available"], true);
        assert_eq!(payload["needsSudo"], false);
        let rows = payload["containers"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], "web-nginx");
        // Trailing \r must not leak into the last column.
        let created = rows[0]["createdAt"].as_str().unwrap();
        assert!(created.ends_with("UTC"));
        assert!(!created.ends_with('\r'), "{created:?}");
        assert_eq!(created, "2026-09-01 08:15:04 +0000 UTC");
    }

    #[test]
    fn win_list_script_is_a_marker_compatible_cmd_collector() {
        // The fallback must produce output the POSIX parser accepts: same
        // markers, same order, docker-native \t escapes, cmd nul redirects.
        let script = win_list_script(&EngineConfig::default());
        assert!(script.starts_with("echo DBXDOCKER_PROBE"));
        assert!(script.contains("where /q docker"));
        assert!(script.contains("2>nul"));
        assert!(script.contains(PS_FORMAT));
        assert!(!script.contains("sh -s"), "{script}");
    }

    #[test]
    fn sudo_logs_body_validates_and_travels_as_argv() {
        let engine = EngineConfig::default();
        let body = sudo_logs_body(&engine, "d4a7c9f1e2b3", 120).unwrap();
        assert!(body.starts_with("PATH="), "{body}");
        assert!(body.contains("echo DBXDOCKER_INSPECT"), "{body}");
        assert!(body.contains("docker inspect d4a7c9f1e2b3"), "{body}");
        assert!(
            body.contains("docker logs --tail 120 d4a7c9f1e2b3"),
            "{body}"
        );
        // The body must NOT carry the heredoc wrapper: exec_with_sudo wraps
        // it in `sudo -S -p '' sh -c '<escaped>'` where stdin = password.
        assert!(!body.contains("sh -s"), "{body}");
        assert!(!body.contains("DBXDOCKER\n"));
        // Id gate runs before any rendering.
        assert!(sudo_logs_body(&engine, "web-nginx", 100).is_err());
    }

    #[test]
    fn local_marker_assembly_feeds_the_shared_parsers() {
        // collect_list_local assembles probe + ps markers around the direct
        // exec output; the assembled text must parse like remote output.
        let assembled =
            format!("DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{PS_FIXTURE}");
        let payload = list_payload(&assembled);
        assert_eq!(payload["available"], true);
        assert_eq!(payload["containers"].as_array().unwrap().len(), 2);
        // collect_logs_local assembles inspect + logs markers; container
        // summary extraction is unchanged from the remote path.
        let logs_assembled =
            format!("DBXDOCKER_INSPECT\n{INSPECT_FIXTURE}\nDBXDOCKER_LOGS\nlocal line\n");
        let logs = logs_payload(&logs_assembled);
        assert_eq!(logs["container"]["name"], "web-nginx");
        assert_eq!(logs["logs"], "local line\n");
        // Unavailable payload keeps the documented shape for both verdicts.
        assert_eq!(unavailable_payload(false)["available"], false);
        assert_eq!(unavailable_payload(true)["needsSudo"], true);
        assert_eq!(
            unavailable_payload(false)["containers"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}
