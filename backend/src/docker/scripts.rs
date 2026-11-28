use super::{EngineConfig, TAIL_MAX, TAIL_MIN};

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
         ps_out=$({cli} ps -a --no-trunc --format '{PS_FORMAT}' 2>/dev/null)\n\
         if [ -n \"$ps_out\" ]; then printf '%s\\n' \"$ps_out\"; else\n\
           echo DBXDOCKER_PS_LEGACY\n\
           {cli} ps -a --no-trunc --format '{PS_FORMAT_LEGACY}' 2>/dev/null\n\
         fi\n",
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

/// Pre-1.13 fallback template: `{{.State}}` entered `docker ps --format`
/// with Docker 1.13 (API 1.25); older CLIs (CentOS 7 extras ships 1.12)
/// fail the whole template with a parsing error whose stderr the collector
/// swallows — the panel then showed an empty list with no hint (issue
/// #168). The legacy set keeps the same column ORDER minus State; the
/// parser derives state from the Status text. It runs only as a second
/// in-script attempt when the modern format produced no rows.
pub const PS_FORMAT_LEGACY: &str =
    "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}\\t{{.CreatedAt}}";

/// The section marker emitted right before the legacy-format retry. The
/// parser splits the `DBXDOCKER_PS` section on it; absent means the modern
/// attempt produced rows (or the host is empty).
pub const PS_LEGACY_MARKER: &str = "DBXDOCKER_PS_LEGACY";

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
