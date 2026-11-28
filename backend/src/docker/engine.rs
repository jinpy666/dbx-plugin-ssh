use serde_json::Value;

use crate::exec;

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
