//! Per-connection remembered approval store for the AI terminal ("remember
//! this command" in the approval dialog).
//!
//! When a user approves an agent-terminal prompt they may opt in to
//! remembering the final (user-edited) command text: it is stored per
//! connection in `<data_dir>/agent-approved-commands.json` as
//! `{ "version": 1, "connections": { "<connectionId>": { "commands":
//! ["systemctl restart nginx", "docker restart *"] } } }`. Later MCP
//! commands matching the stored lines are routed without another approval
//! prompt. Matching reuses the full `sudo_allowlist` semantics (token exact
//! / mid `*` = one argument / trailing `*` = one-or-more arguments) via
//! `entries_from_lines` + `is_allowed` — zero new matching code (decision
//! D3), so a remembered exact command can be hand-generalized into a
//! wildcard line in settings.
//!
//! Enforced in two places:
//! - MCP `ssh_exec_terminal_tool` routing: a remembered hit downgrades the
//!   terminal routing verdict from `Prompt` to `Run` (`agent_terminal::
//!   decide_with_memory`) — never `Deny`, and `mcp_safety::assess_command`
//!   is re-checked so a stored line can never bless a destructive command
//!   (the disaster gate stays last, decision D2);
//! - settings management: `ssh/settings/get|set` expose the per-connection
//!   lines (`rememberedCommands`) with the same validation as
//!   [`remember`] (length cap, per-connection cap, dedup, destructive
//!   lines refused with the offending line number).
//!
//! Storage follows the `agent-modes.json` policy (decision D4): plain
//! pretty-printed JSON (command text is not credential material, so the
//! sudo-profile 0600 dance is skipped), tmp + rename atomic write, and a
//! missing or corrupted file degrades to an empty store instead of failing
//! the connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "agent-approved-commands.json";

/// Maximum remembered command lines per connection (settings contract).
pub const MAX_REMEMBERED: usize = 50;
/// Maximum characters per remembered line (settings contract).
pub const MAX_LINE_LEN: usize = 500;

/// Per-connection remembered command lines, keyed by connectionId, in
/// configuration order (the order settings show and matching walks).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApprovalStore {
    pub connections: HashMap<String, Vec<String>>,
}

/// Store file path inside the plugin data directory.
pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Loads the persisted store; a missing or corrupted file yields an empty
/// store so a bad file can never break connecting (same policy as
/// agent-modes.json and the quick-commands store).
pub fn load_store(data_dir: &Path) -> ApprovalStore {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<serde_json::Value>(&text).ok() else {
        return ApprovalStore::default();
    };
    let Some(connections) = value
        .get("connections")
        .and_then(serde_json::Value::as_object)
    else {
        return ApprovalStore::default();
    };
    ApprovalStore {
        connections: connections
            .iter()
            .map(|(connection, entry)| {
                let commands = entry
                    .get("commands")
                    .and_then(serde_json::Value::as_array)
                    .map(|lines| {
                        lines
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (connection.clone(), commands)
            })
            .collect(),
    }
}

/// Persists the store atomically (tmp + rename). Plain JSON, no 0600: the
/// lines are command texts the user explicitly approved, not credentials.
pub fn save_store(data_dir: &Path, store: &ApprovalStore) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let connections: serde_json::Map<String, serde_json::Value> = store
        .connections
        .iter()
        .map(|(connection, commands)| {
            (
                connection.clone(),
                serde_json::json!({ "commands": commands }),
            )
        })
        .collect();
    let value = serde_json::json!({ "version": STORAGE_VERSION, "connections": connections });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode remembered approvals: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

/// True when `command` matches any remembered line of the connection under
/// the full `sudo_allowlist` semantics (D3). Unknown connections and empty
/// lists never match; a destructive command still has to be excluded by the
/// caller (decision D2: the disaster gate stays last regardless of the
/// store's content).
pub fn matches(store: &ApprovalStore, connection_id: &str, command: &str) -> bool {
    store
        .connections
        .get(connection_id)
        .map(|lines| {
            let entries = crate::sudo_allowlist::entries_from_lines(lines);
            crate::sudo_allowlist::is_allowed(&entries, command)
        })
        .unwrap_or(false)
}

/// The connection's remembered lines in configuration order (settings
/// `rememberedCommands`); unknown connections yield an empty list.
pub fn list_lines(store: &ApprovalStore, connection_id: &str) -> Vec<String> {
    store
        .connections
        .get(connection_id)
        .cloned()
        .unwrap_or_default()
}

/// True when the command may enter the remember list: anything the disaster
/// classifier does not flag as `Destructive` (decision D2 — the disaster
/// gate always stays in force, so a remembered hit can never skip it).
pub fn is_rememberable(command: &str) -> bool {
    !matches!(
        crate::mcp_safety::assess_command(command),
        crate::mcp_safety::CommandRisk::Destructive(_)
    )
}

/// Remembers one approved command for the connection. The stored text is the
/// trimmed command; a line that already exists (trimmed-exact equality)
/// returns `Ok(false)` idempotently. Empty commands, oversized commands and
/// destructive commands are refused (the last with an explicit reason, so
/// the approval UI can explain why "remember" was ignored).
pub fn remember(
    store: &mut ApprovalStore,
    connection_id: &str,
    command: &str,
) -> Result<bool, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Cannot remember an empty command".to_string());
    }
    if command.chars().count() > MAX_LINE_LEN {
        return Err(format!(
            "Remembered command is limited to {MAX_LINE_LEN} characters"
        ));
    }
    if !is_rememberable(command) {
        return Err(
            "Refusing to remember a destructive command: the disaster gate always stays in force"
                .to_string(),
        );
    }
    if store
        .connections
        .get(connection_id)
        .is_some_and(|lines| lines.iter().any(|line| line.trim() == command))
    {
        return Ok(false);
    }
    let lines = store
        .connections
        .entry(connection_id.to_string())
        .or_default();
    if lines.len() >= MAX_REMEMBERED {
        return Err(format!(
            "At most {MAX_REMEMBERED} remembered commands are supported per connection"
        ));
    }
    lines.push(command.to_string());
    Ok(true)
}

/// Replaces the connection's whole remembered list (settings full-replace
/// contract, allowing the user to hand-generalize exact commands into
/// wildcard lines). Every non-blank line is validated like [`remember`]:
/// oversized lines and destructive lines are refused (the destructive error
/// names the offending line number); blank lines are skipped; duplicates
/// collapse keeping first-seen order; the per-connection cap applies. An
/// empty (or all-blank) input clears the connection's list entirely.
pub fn set_lines(
    store: &mut ApprovalStore,
    connection_id: &str,
    lines: &[String],
) -> Result<(), String> {
    let mut cleaned: Vec<String> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.chars().count() > MAX_LINE_LEN {
            return Err(format!(
                "Remembered command line {} is limited to {MAX_LINE_LEN} characters",
                index + 1
            ));
        }
        if !is_rememberable(line) {
            return Err(format!(
                "Remembered command line {} is refused: destructive commands can never be remembered",
                index + 1
            ));
        }
        if !cleaned.iter().any(|existing| existing == line) {
            cleaned.push(line.to_string());
        }
    }
    if cleaned.len() > MAX_REMEMBERED {
        return Err(format!(
            "At most {MAX_REMEMBERED} remembered commands are supported per connection"
        ));
    }
    if cleaned.is_empty() {
        store.connections.remove(connection_id);
        return Ok(());
    }
    store.connections.insert(connection_id.to_string(), cleaned);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dbx-agent-approvals-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn remember_then_matches_roundtrip_uses_allowlist_semantics() {
        let mut store = ApprovalStore::default();
        assert!(remember(&mut store, "conn-a", "systemctl restart nginx").unwrap());
        assert!(remember(&mut store, "conn-a", "docker restart *").unwrap());

        // Exact token match, with the shared prefix/shape rules.
        assert!(matches(&store, "conn-a", "systemctl restart nginx"));
        assert!(matches(&store, "conn-a", "sudo systemctl restart nginx"));
        // Trailing `*` = one-or-more arguments.
        assert!(matches(&store, "conn-a", "docker restart api"));
        assert!(matches(&store, "conn-a", "docker restart a b c"));
        // Exact line only (inverted sudoers default): extra args break it.
        assert!(!matches(&store, "conn-a", "systemctl restart nginx --now"));
        assert!(!matches(&store, "conn-a", "systemctl restart mysql"));
        // Trailing `*` needs at least one argument.
        assert!(!matches(&store, "conn-a", "docker restart"));
        // Other connections and unknown connections never match.
        assert!(!matches(&store, "conn-b", "systemctl restart nginx"));
        assert!(!matches(&ApprovalStore::default(), "conn-a", "df -h"));
        assert_eq!(
            list_lines(&store, "conn-a"),
            ["systemctl restart nginx", "docker restart *"]
        );
    }

    #[test]
    fn remember_is_idempotent_on_trimmed_equality() {
        let mut store = ApprovalStore::default();
        assert!(remember(&mut store, "conn-a", "systemctl restart nginx").unwrap());
        // Same command, surrounding whitespace: stored trimmed-equal.
        assert!(!remember(&mut store, "conn-a", "  systemctl restart nginx  ").unwrap());
        assert_eq!(list_lines(&store, "conn-a").len(), 1);
        assert_eq!(list_lines(&store, "conn-a")[0], "systemctl restart nginx");
    }

    #[test]
    fn remember_rejects_empty_oversized_and_destructive_commands() {
        let mut store = ApprovalStore::default();
        // Empty after trim.
        assert!(remember(&mut store, "conn-a", "").is_err());
        assert!(remember(&mut store, "conn-a", "   ").is_err());
        // Over the per-line character cap.
        let long = "x".repeat(MAX_LINE_LEN + 1);
        assert!(remember(&mut store, "conn-a", &long).is_err());
        // Destructive: mcp_safety classifies these as Destructive, so the
        // disaster gate can never be remembered away (decision D2).
        let error = remember(&mut store, "conn-a", "rm -rf /").unwrap_err();
        assert!(error.contains("destructive"), "unexpected error: {error}");
        assert!(remember(&mut store, "conn-a", "reboot").is_err());
        assert!(remember(&mut store, "conn-a", "mkfs.ext4 /dev/sda1").is_err());
        assert!(list_lines(&store, "conn-a").is_empty());
        // Boundary: exactly at the cap is fine.
        assert!(remember(&mut store, "conn-a", &"x".repeat(MAX_LINE_LEN)).is_ok());
    }

    #[test]
    fn remember_enforces_per_connection_cap_without_side_effects() {
        let mut store = ApprovalStore::default();
        for index in 0..MAX_REMEMBERED {
            assert!(remember(&mut store, "conn-a", &format!("echo cmd-{index}")).unwrap());
        }
        let error = remember(&mut store, "conn-a", "echo overflow").unwrap_err();
        assert!(
            error.contains(&MAX_REMEMBERED.to_string()),
            "unexpected error: {error}"
        );
        assert_eq!(list_lines(&store, "conn-a").len(), MAX_REMEMBERED);
        // An existing line is still idempotent at the cap, not an error.
        assert!(!remember(&mut store, "conn-a", "echo cmd-0").unwrap());
        // Caps are per connection.
        assert!(remember(&mut store, "conn-b", "echo free").unwrap());
    }

    #[test]
    fn set_lines_validates_replaces_dedups_and_clears() {
        let mut store = ApprovalStore::default();
        remember(&mut store, "conn-a", "df -h").unwrap();

        // Oversized line is refused with the line number.
        let lines = vec!["df -h".to_string(), "x".repeat(MAX_LINE_LEN + 1)];
        let error = set_lines(&mut store, "conn-a", &lines).unwrap_err();
        assert!(error.contains("line 2"), "unexpected error: {error}");

        // Destructive line is refused with the line number (D2).
        let lines = vec![
            "uptime".to_string(),
            "rm -rf /".to_string(),
            "docker restart *".to_string(),
        ];
        let error = set_lines(&mut store, "conn-a", &lines).unwrap_err();
        assert!(error.contains("line 2"), "unexpected error: {error}");
        // The refusal must not have half-applied: old content intact.
        assert_eq!(list_lines(&store, "conn-a"), ["df -h"]);

        // Full replace: blank lines skipped, duplicates collapse, order kept,
        // wildcard generalization allowed (D3).
        let lines = vec![
            "  ".to_string(),
            "docker restart *".to_string(),
            "docker restart *".to_string(),
            "uptime".to_string(),
        ];
        set_lines(&mut store, "conn-a", &lines).unwrap();
        assert_eq!(list_lines(&store, "conn-a"), ["docker restart *", "uptime"]);

        // Empty slice clears the connection's list entirely.
        set_lines(&mut store, "conn-a", &[]).unwrap();
        assert!(list_lines(&store, "conn-a").is_empty());
        assert!(!store.connections.contains_key("conn-a"));
        // An all-blank slice clears too.
        set_lines(&mut store, "conn-a", &["   ".to_string()]).unwrap();
        assert!(!store.connections.contains_key("conn-a"));
    }

    #[test]
    fn set_lines_enforces_cap_on_deduped_content() {
        let mut store = ApprovalStore::default();
        let lines: Vec<String> = (0..MAX_REMEMBERED + 1)
            .map(|index| format!("echo set-{index}"))
            .collect();
        let error = set_lines(&mut store, "conn-a", &lines).unwrap_err();
        assert!(
            error.contains(&MAX_REMEMBERED.to_string()),
            "unexpected error: {error}"
        );
        assert!(!store.connections.contains_key("conn-a"));
        // Exactly at the cap fits (dedup does not count against it twice).
        let lines: Vec<String> = (0..MAX_REMEMBERED)
            .map(|index| format!("echo set-{index}"))
            .chain(std::iter::once("echo set-0".to_string()))
            .collect();
        set_lines(&mut store, "conn-a", &lines).unwrap();
        assert_eq!(list_lines(&store, "conn-a").len(), MAX_REMEMBERED);
    }

    #[test]
    fn corrupted_or_missing_file_falls_back_to_empty_store() {
        let dir = temp_dir();
        // Missing file.
        assert!(load_store(&dir).connections.is_empty());
        // Corrupted JSON.
        std::fs::write(store_path(&dir), "{ not json").unwrap();
        assert!(load_store(&dir).connections.is_empty());
        // Structurally wrong JSON (no connections object).
        std::fs::write(store_path(&dir), r#"{"version":1}"#).unwrap();
        assert!(load_store(&dir).connections.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_load_roundtrip_preserves_connections_and_order() {
        let dir = temp_dir();
        let mut store = ApprovalStore::default();
        remember(&mut store, "conn-a", "systemctl restart nginx").unwrap();
        remember(&mut store, "conn-a", "docker restart *").unwrap();
        remember(&mut store, "conn-b", "uptime").unwrap();
        save_store(&dir, &store).unwrap();

        let loaded = load_store(&dir);
        assert_eq!(loaded, store);
        assert_eq!(
            list_lines(&loaded, "conn-a"),
            ["systemctl restart nginx", "docker restart *"]
        );
        assert!(matches(&loaded, "conn-b", "uptime"));

        // Reload-then-extend keeps the whole flow working across restarts.
        let mut reloaded = loaded;
        assert!(!remember(&mut reloaded, "conn-a", "docker restart *").unwrap());
        save_store(&dir, &reloaded).unwrap();
        assert_eq!(load_store(&dir), reloaded);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
