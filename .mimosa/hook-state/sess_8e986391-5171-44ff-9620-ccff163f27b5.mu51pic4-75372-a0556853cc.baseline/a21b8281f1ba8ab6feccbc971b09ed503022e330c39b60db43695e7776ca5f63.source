//! `ssh_multi_exec` 的纯逻辑（IMPL_PLAN_NETCATTY A2-T3）：targets 归一化、
//! 保序去重、上限校验与命令文本门禁。零 I/O，单测见本文件 tests。

use serde_json::Value;

/// Parallel aggregate cap (IMPL_PLAN §1.1: parallel 上限 10 目标).
pub const MULTI_EXEC_MAX_TARGETS: usize = 10;

/// One normalized multi-exec target: the raw selector text the caller sent
/// plus the resolved registry identity the row reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRef {
    pub raw: String,
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

/// Validates count/ordering on the RAW selector list: 1–10 entries, no
/// empty strings, duplicates removed preserving first occurrence. Registry
/// resolution happens per target in the handler (async), so this stays
/// pure over the raw strings.
pub fn normalize_targets(raw: &[String]) -> Result<Vec<String>, String> {
    if raw.is_empty() {
        return Err("targets must contain at least one connection reference".to_string());
    }
    if raw.len() > MULTI_EXEC_MAX_TARGETS {
        return Err(format!(
            "targets is capped at {MULTI_EXEC_MAX_TARGETS}; got {}",
            raw.len()
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::with_capacity(raw.len());
    for target in raw {
        if target.trim().is_empty() {
            return Err("targets must be non-empty strings".to_string());
        }
        if seen.insert(target.as_str()) {
            unique.push(target.clone());
        }
    }
    Ok(unique)
}

/// Command-text gate shared by every target of one multi-exec call
/// (arguments-only checks; the per-connection read-only flag is enforced
/// per dial in the handler). Mirrors the `ssh_exec` gate: destructive
/// commands need `confirmDestructive` and are refused outright on
/// read-only; no sudo — escalation goes through single-target
/// `ssh_exec_sudo`, so any `sudo …` command is refused here outright.
pub fn command_gate(
    command: &str,
    read_only: bool,
    confirm_destructive: bool,
) -> Result<(), String> {
    use crate::mcp_safety::{assess_command, runs_under_sudo, CommandRisk};
    if runs_under_sudo(command) {
        return Err(
            "ssh_multi_exec does not run privileged commands; use single-target \
             ssh_exec_sudo for escalation"
                .to_string(),
        );
    }
    match assess_command(command) {
        CommandRisk::Destructive(reason) if read_only => Err(format!(
            "Refused on read-only connection ({reason}): {command}"
        )),
        CommandRisk::Destructive(reason) => {
            if confirm_destructive {
                Ok(())
            } else {
                Err(format!(
                    "Command looks destructive ({reason}): {command}. \
                     Retry with confirmDestructive: true if this is intended."
                ))
            }
        }
        CommandRisk::Unknown if read_only => Err(format!(
            "Connection is read-only and the command is not recognized as read-only: \
             {command}. Only inspection commands pass."
        )),
        _ => Ok(()),
    }
}

/// Builds the per-target resolved identity from a registry `StoredConnection`
/// payload (subset of fields the result row reports). Pure over JSON so
/// tests avoid the registry.
pub fn target_from_connection(raw: &str, connection: &Value) -> Option<TargetRef> {
    let id = connection.get("id").and_then(Value::as_str)?;
    let host = connection.get("host").and_then(Value::as_str)?;
    let username = connection.get("username").and_then(Value::as_str)?;
    let port = connection
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(22);
    Some(TargetRef {
        raw: raw.to_string(),
        connection_id: id.to_string(),
        host: host.to_string(),
        port,
        username: username.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raws(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    // —— A2-T3：targets 归一化 / 去重 / 上限 ——

    #[test]
    fn targets_dedupe_preserving_first_occurrence() {
        let normalized = normalize_targets(&raws(&["b", "a", "b", "c", "a"])).unwrap();
        assert_eq!(normalized, raws(&["b", "a", "c"]));
    }

    #[test]
    fn targets_reject_empty_and_oversize() {
        assert!(normalize_targets(&raws(&[])).is_err());
        assert!(normalize_targets(&raws(&["a", ""])).is_err());
        assert!(normalize_targets(&raws(&["a", "  "])).is_err());
        let too_many: Vec<String> = (0..11).map(|index| format!("t{index}")).collect();
        let error = normalize_targets(&too_many).unwrap_err();
        assert!(error.contains("capped at 10"), "{error}");
        // 10 targets pass.
        let exactly_ten: Vec<String> = (0..10).map(|index| format!("t{index}")).collect();
        assert_eq!(normalize_targets(&exactly_ten).unwrap().len(), 10);
    }

    // —— A2-T3：命令门禁 ——

    #[test]
    fn command_gate_blocks_sudo_altogether() {
        let error = command_gate("sudo systemctl restart nginx", false, false).unwrap_err();
        assert!(error.contains("ssh_exec_sudo"), "{error}");
        // sudo 检查先于灾难检查。
        assert!(command_gate("sudo rm -rf /", false, true).is_err());
    }

    #[test]
    fn command_gate_destructive_needs_confirmation_and_readonly_refuses() {
        assert!(command_gate("rm -rf /", false, false).is_err());
        assert!(command_gate("rm -rf /", false, true).is_ok());
        let error = command_gate("rm -rf /", true, true).unwrap_err();
        assert!(error.contains("read-only"), "{error}");
    }

    #[test]
    fn command_gate_readonly_unknown_and_plain_paths() {
        // 只读连接：非白名单命令拒绝，巡检命令放行。
        let error = command_gate("systemctl restart nginx", true, false).unwrap_err();
        assert!(error.contains("read-only"), "{error}");
        assert!(command_gate("df -h", true, false).is_ok());
        // 可写连接：写类（Unknown）直接放行。
        assert!(command_gate("systemctl restart nginx", false, false).is_ok());
    }

    #[test]
    fn target_row_extracts_registry_identity() {
        let row = target_from_connection(
            "web-01",
            &serde_json::json!({ "id": "conn-9", "host": "web.local",
                                 "port": 2222, "username": "ops" }),
        )
        .unwrap();
        assert_eq!(row.connection_id, "conn-9");
        assert_eq!(row.raw, "web-01");
        assert_eq!(row.host, "web.local");
        assert_eq!(row.port, 2222);
        assert_eq!(row.username, "ops");
        // 缺字段/非法端口按 None 处理，handler 报该目标失败。
        assert!(target_from_connection("x", &serde_json::json!({ "host": "h" })).is_none());
    }
}
