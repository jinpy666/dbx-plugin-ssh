//! Global quick commands: user-defined reusable command snippets persisted in
//! `<plugin_data_dir>/quick-commands.json` and shared by every connection and
//! workbench (tiny-rdm quick commands, promoted from per-workbench localStorage
//! to the plugin-level store). Entries are plain commands the user explicitly
//! saved; the file still gets 0600 because snippets may embed credentials.

use std::path::Path;

use serde_json::{json, Value};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "quick-commands.json";
/// Cap shared with the workbench editor (`QUICK_COMMANDS_LIMIT`).
pub const MAX_COMMANDS: usize = 20;
const MAX_NAME_LEN: usize = 60;
const MAX_COMMAND_LEN: usize = 500;

#[derive(Debug, Clone, PartialEq)]
pub struct QuickCommandEntry {
    pub id: String,
    pub name: String,
    pub command: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct QuickCommandStore {
    pub commands: Vec<QuickCommandEntry>,
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn store_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(FILE_NAME)
}

/// Loads the store; a missing or corrupted file yields an empty store so a
/// bad file can never break the workbench (same policy as quick-sudo-profiles).
pub fn load_store(data_dir: &Path) -> QuickCommandStore {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
        return QuickCommandStore::default();
    };
    let commands = value
        .get("commands")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(entry_from_json).collect())
        .unwrap_or_default();
    QuickCommandStore { commands }
}

/// Persists atomically (tmp + rename) with 0600 permissions on Unix.
pub fn save_store(data_dir: &Path, store: &QuickCommandStore) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!({
        "version": STORAGE_VERSION,
        "commands": store.commands.iter().map(entry_json).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode quick commands: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn entry_from_json(value: &Value) -> Option<QuickCommandEntry> {
    let object = value.as_object()?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(QuickCommandEntry {
        id: string("id"),
        name: string("name"),
        command: string("command"),
        created_at: object.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
        updated_at: object.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn entry_json(entry: &QuickCommandEntry) -> Value {
    json!({
        "id": entry.id,
        "name": entry.name,
        "command": entry.command,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
    })
}

pub fn entry_view(entry: &QuickCommandEntry) -> Value {
    entry_json(entry)
}

/// Insertion order (createdAt asc) so the workbench dropdown is stable.
pub fn list_views(store: &QuickCommandStore) -> Vec<Value> {
    store.commands.iter().map(entry_view).collect()
}

/// Creates or updates one entry from the shared camelCase parameter shape
/// (protocol `ssh/quickCommands/save`). A blank `name` falls back to the
/// command itself (front-end parity). Returns the saved entry plus whether it
/// was newly created.
pub fn save_entry(
    store: &mut QuickCommandStore,
    params: &Value,
) -> Result<(QuickCommandEntry, bool), String> {
    let command = params
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing command")?;
    if command.chars().count() > MAX_COMMAND_LEN {
        return Err(format!(
            "Quick command is limited to {MAX_COMMAND_LEN} characters"
        ));
    }
    let name_input = params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if name_input.chars().count() > MAX_NAME_LEN {
        return Err(format!(
            "Quick command name is limited to {MAX_NAME_LEN} characters"
        ));
    }
    let existing_id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let existing =
        existing_id.and_then(|id| store.commands.iter().position(|entry| entry.id == id));
    if existing.is_none() && store.commands.len() >= MAX_COMMANDS {
        return Err(format!(
            "At most {MAX_COMMANDS} quick commands are supported"
        ));
    }
    let now = unix_now_secs();
    let entry = match existing {
        Some(index) => {
            let entry = &mut store.commands[index];
            entry.name = if name_input.is_empty() {
                command.chars().take(MAX_NAME_LEN).collect()
            } else {
                name_input.to_string()
            };
            entry.command = command.to_string();
            entry.updated_at = now;
            entry.clone()
        }
        None => {
            let entry = QuickCommandEntry {
                id: uuid::Uuid::new_v4().to_string(),
                name: if name_input.is_empty() {
                    command.chars().take(MAX_NAME_LEN).collect()
                } else {
                    name_input.to_string()
                },
                command: command.to_string(),
                created_at: now,
                updated_at: now,
            };
            store.commands.push(entry.clone());
            entry
        }
    };
    Ok((entry, existing.is_none()))
}

/// Removes an entry by id; returns false when the id is unknown (mirrors
/// `ssh/knownHosts/remove` semantics).
pub fn delete_entry(store: &mut QuickCommandStore, id: &str) -> bool {
    let before = store.commands.len();
    store.commands.retain(|entry| entry.id != id);
    store.commands.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(store: &mut QuickCommandStore, name: &str, command: &str) -> QuickCommandEntry {
        save_entry(store, &json!({ "name": name, "command": command }))
            .unwrap()
            .0
    }

    #[test]
    fn save_creates_updates_and_defaults_name() {
        let mut store = QuickCommandStore::default();
        let (created_entry, created) =
            save_entry(&mut store, &json!({ "command": "df -h" })).unwrap();
        assert!(created);
        assert_eq!(created_entry.name, "df -h");
        let id = created_entry.id;
        let (updated, created) = save_entry(
            &mut store,
            &json!({ "id": id, "name": "disk", "command": "df -h /" }),
        )
        .unwrap();
        assert!(!created);
        assert_eq!(updated.name, "disk");
        assert_eq!(store.commands.len(), 1);
        assert_eq!(store.commands[0].command, "df -h /");
    }

    #[test]
    fn save_rejects_missing_or_oversized_input() {
        let mut store = QuickCommandStore::default();
        assert!(save_entry(&mut store, &json!({ "command": "   " })).is_err());
        assert!(save_entry(&mut store, &json!({})).is_err());
        assert!(save_entry(&mut store, &json!({ "command": "a".repeat(501) })).is_err());
        save(&mut store, "ops", "echo hi");
        assert!(save_entry(
            &mut store,
            &json!({ "command": "echo hi", "name": "n".repeat(61) })
        )
        .is_err());
    }

    #[test]
    fn cap_is_enforced_on_new_entries_only() {
        let mut store = QuickCommandStore::default();
        for index in 0..MAX_COMMANDS {
            save(&mut store, &format!("p{index}"), "echo hi");
        }
        assert!(save_entry(&mut store, &json!({ "command": "overflow" })).is_err());
        // Updating an existing entry stays within the cap.
        let id = store.commands[0].id.clone();
        assert!(save_entry(&mut store, &json!({ "id": id, "command": "echo ok" })).is_ok());
    }

    #[test]
    fn delete_reports_presence() {
        let mut store = QuickCommandStore::default();
        let entry = save(&mut store, "ops", "echo hi");
        assert!(delete_entry(&mut store, &entry.id));
        assert!(!delete_entry(&mut store, &entry.id));
        assert!(store.commands.is_empty());
    }

    #[test]
    fn corrupted_file_falls_back_to_empty_store() {
        let dir = std::env::temp_dir().join(format!("dbx-quick-cmds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store_path(&dir), "{not json").unwrap();
        assert!(load_store(&dir).commands.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_roundtrip_preserves_entries_in_order() {
        let dir = std::env::temp_dir().join(format!("dbx-quick-cmds-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = QuickCommandStore::default();
        save(&mut store, "disk", "df -h");
        save(&mut store, "uptime", "uptime");
        save_store(&dir, &store).unwrap();
        let loaded = load_store(&dir);
        assert_eq!(loaded, store);
        assert_eq!(loaded.commands.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_carry_full_fields_in_insertion_order() {
        let mut store = QuickCommandStore::default();
        save(&mut store, "disk", "df -h");
        save(&mut store, "uptime", "uptime");
        let views = list_views(&store);
        assert_eq!(views.len(), 2);
        assert_eq!(views[0]["name"], "disk");
        assert_eq!(views[1]["command"], "uptime");
        assert!(views[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    }
}
