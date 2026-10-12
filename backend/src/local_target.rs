//! Local shell connection targets (`io.dbx.ssh.local`) — the plugin's second
//! connection provider, for scheduler tasks that must run on the machine
//! running DBX itself instead of over SSH.
//!
//! Division of labor mirrors the SSH provider: the host owns the form, the
//! saved-connection store, and the connection lifecycle routing (it stamps
//! `params.provider.id` on every lifecycle call, so the decision of "is this
//! a local target" is the plugin reading the provider marker the host
//! declared — never a host-side per-provider branch, never a hardcoded
//! connection-id string comparison in task logic). This module owns the
//! payload parsing and the pure provider-marker predicate; the registry
//! itself lives on [`crate::ssh::SshRuntime`] next to the SSH stored
//! connections so both providers share one lifecycle (store on connect, drop
//! on disconnect, read in the task provider).
//!
//! There are no credentials on a local target: the payload carries a display
//! name and an optional absolute shell path only. `shell` staying empty means
//! "resolve at spawn time" through the same chain the local terminal uses
//! ([`crate::local_terminal::resolve_default_shell`]) — resolving lazily (not
//! at connect time) keeps a stale preference edit from wedging an
//! already-saved connection.

use serde_json::Value;

/// Connection-provider contribution id of the local shell target. This is
/// the plugin declaring itself; the host matches it against the manifest and
/// stamps it back onto every lifecycle payload.
pub(crate) const LOCAL_CONNECTION_PROVIDER: &str = "io.dbx.ssh.local";

/// A hydrated local shell target: the scheduler task provider's view of one
/// `io.dbx.ssh.local` connection. No secret material by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalTarget {
    pub id: String,
    pub name: Option<String>,
    /// Absolute shell path from the connection form; empty = resolve the
    /// DBX default shell when the task actually spawns.
    pub shell: String,
    /// Absolute start directory from the connection form; empty = resolve
    /// through the normal chain (last tracked cwd > preference > home).
    pub cwd: String,
    /// Connection-form environment variables (`NAME=value` per line),
    /// sanitized through the same rules as the terminal's `env` parameter —
    /// invalid lines (empty name, `=` in the name, managed TERM family) are
    /// dropped at parse time, never surfaced.
    pub env: Vec<(String, String)>,
}

impl LocalTarget {
    /// Parses a connection lifecycle payload into a local target.
    /// `Ok(None)` = the payload belongs to a different provider (the SSH
    /// connection or any future one) and the caller must fall through to its
    /// own handling; `Err` = the payload claims this provider but is
    /// malformed, so the lifecycle call must fail loudly instead of silently
    /// dropping the registration.
    pub(crate) fn from_lifecycle_params(params: &Value) -> Result<Option<Self>, String> {
        if !connection_is_local(provider_id(params).as_deref()) {
            return Ok(None);
        }
        let connection = params
            .get("connection")
            .and_then(Value::as_object)
            .ok_or("Missing connection payload")?;
        let id = connection
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or("Missing connection id")?
            .to_string();
        // Display name is optional exactly like the SSH parser's: older
        // hosts may omit it, and nothing on this surface needs it.
        let name = connection
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        // Shell resolves lazily at spawn; trim only (an empty string is the
        // documented "use the default shell" value).
        let shell = connection
            .get("external_config")
            .and_then(Value::as_object)
            .and_then(|config| config.get("shell"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let (cwd, env) = config_cwd_env(connection);
        Ok(Some(Self {
            id,
            name,
            shell,
            cwd,
            env,
        }))
    }

    /// Shell this target spawns commands with: the connection's explicit
    /// override, else `fallback` (the caller resolves the DBX default shell
    /// once per run — kept a parameter so this stays pure and testable).
    pub(crate) fn shell_or(&self, fallback: &str) -> String {
        if self.shell.is_empty() {
            fallback.to_string()
        } else {
            self.shell.clone()
        }
    }
}

/// The lifecycle payload's `provider.id` stamp, if any. Older hosts may omit
/// the whole `provider` object; absence simply means "not local".
fn provider_id(params: &Value) -> Option<String> {
    params
        .get("provider")
        .and_then(|provider| provider.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extracts the connection form's `cwd` and `env` values. `env` is a
/// textarea: one `NAME=value` per line, blank lines and `#` comments skipped,
/// the first `=` separates name and value (values may contain `=`), and every
/// pair still passes [`crate::local_terminal::sanitize_env_pair`] so managed
/// keys and malformed entries drop exactly like the terminal's own env
/// parameter. A malformed line never fails the connection — it is ignored.
fn config_cwd_env(connection: &serde_json::Map<String, Value>) -> (String, Vec<(String, String)>) {
    let config = connection.get("external_config").and_then(Value::as_object);
    let cwd = config
        .and_then(|config| config.get("cwd"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let text = config
        .and_then(|config| config.get("env"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut env = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if let Some(pair) = crate::local_terminal::sanitize_env_pair(name, value) {
            env.push(pair);
        }
    }
    (cwd, env)
}

/// Pure provider-marker predicate. The task provider's local-vs-SSH decision
/// routes through this constant so the mapping stays one declaration wide.
pub(crate) fn connection_is_local(provider_id: Option<&str>) -> bool {
    provider_id == Some(LOCAL_CONNECTION_PROVIDER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lifecycle(provider_id: &str) -> Value {
        json!({
            "provider": { "id": provider_id, "databaseType": "local" },
            "connection": {
                "id": "conn-local-1",
                "name": "  ops box  ",
                "external_config": { "shell": " /bin/bash " },
            },
            "runtime": { "host": "", "port": 0 },
        })
    }

    #[test]
    fn local_provider_payload_parses_with_trimmed_fields() {
        let target = LocalTarget::from_lifecycle_params(&lifecycle(LOCAL_CONNECTION_PROVIDER))
            .expect("parse")
            .expect("local target");
        assert_eq!(target.id, "conn-local-1");
        assert_eq!(target.name.as_deref(), Some("ops box"));
        assert_eq!(target.shell, "/bin/bash");
        assert_eq!(target.shell_or("/bin/zsh"), "/bin/bash");
        // 旧宿主/旧连接没有 cwd/env 键：解析为空，不报错。
        assert_eq!(target.cwd, "");
        assert!(target.env.is_empty());
    }

    #[test]
    fn connection_form_cwd_and_env_lines_parse_and_sanitize() {
        let mut payload = lifecycle(LOCAL_CONNECTION_PROVIDER);
        payload["connection"]["external_config"] = json!({
            "shell": "/bin/sh",
            "cwd": "  /tmp/work  ",
            "env": "EDITOR=/usr/bin/vim\n# comment\n\nBAD LINE WITHOUT EQUALS\nA=B=C\nTERM=vt100\n  \n=DROPPED",
        });
        let target = LocalTarget::from_lifecycle_params(&payload)
            .expect("parse")
            .expect("local target");
        assert_eq!(target.cwd, "/tmp/work");
        // 第一处 `=` 分隔（值可含 `=`）；空名/托管键/无 `=` 的行静默丢弃。
        assert_eq!(
            target.env,
            vec![
                ("EDITOR".to_string(), "/usr/bin/vim".to_string()),
                ("A".to_string(), "B=C".to_string()),
            ]
        );
    }

    #[test]
    fn other_providers_fall_through_and_missing_provider_is_not_local() {
        // The SSH provider's payload must never be claimed by this parser.
        assert_eq!(
            LocalTarget::from_lifecycle_params(&lifecycle("io.dbx.ssh.connection")).expect("parse"),
            None
        );
        // Older hosts may omit the provider stamp entirely.
        let legacy = json!({ "connection": { "id": "c", "host": "h", "port": 22 } });
        assert_eq!(
            LocalTarget::from_lifecycle_params(&legacy).expect("parse"),
            None
        );
        assert!(!connection_is_local(None));
        assert!(!connection_is_local(Some("io.dbx.ssh.connection")));
        assert!(connection_is_local(Some(LOCAL_CONNECTION_PROVIDER)));
    }

    #[test]
    fn malformed_local_payloads_fail_loudly() {
        // Claims the local provider but carries no connection object.
        let missing_connection = json!({ "provider": { "id": LOCAL_CONNECTION_PROVIDER } });
        assert!(LocalTarget::from_lifecycle_params(&missing_connection).is_err());
        // Connection without an id cannot be registered.
        let missing_id = json!({
            "provider": { "id": LOCAL_CONNECTION_PROVIDER },
            "connection": { "name": "no id" },
        });
        assert!(LocalTarget::from_lifecycle_params(&missing_id).is_err());
    }

    #[test]
    fn empty_shell_falls_back_to_the_resolved_default() {
        let mut target = LocalTarget {
            id: "c".to_string(),
            name: None,
            shell: String::new(),
            cwd: String::new(),
            env: Vec::new(),
        };
        assert_eq!(target.shell_or("/bin/sh"), "/bin/sh");
        target.shell = "/usr/bin/fish".to_string();
        assert_eq!(target.shell_or("/bin/sh"), "/usr/bin/fish");
    }
}
