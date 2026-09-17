//! Terminal keyword highlight rules (Netcatty parity batch, IMPL_PLAN §1.1):
//! user-defined `{pattern, color, isRegex, caseSensitive, enabled}` entries
//! persisted in `<plugin_data_dir>/highlight-rules.json` and shared by every
//! workbench terminal. The module mirrors `quick_commands.rs` line by line
//! (same storage policy: versioned pretty JSON, tmp+rename atomic write,
//! 0600 on Unix, corrupted file degrades to an empty store).
//!
//! Regex validity is deliberately NOT checked here (no `regex` dependency;
//! the frontend compiles patterns before saving per §1.1) — the backend only
//! validates the shape: non-empty trimmed pattern up to 200 chars and a
//! `#rrggbb` color.

use std::path::Path;

use serde_json::{json, Value};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "highlight-rules.json";
/// Cap shared with the workbench editor (`HIGHLIGHT_RULES_LIMIT`).
pub const MAX_RULES: usize = 30;
const MAX_PATTERN_CHARS: usize = 200;
/// Default color for new rules (amber-500), mirrored by the frontend swatch.
pub const DEFAULT_COLOR: &str = "#f59e0b";

/// First-run rules seeded into an empty data dir (deterministic ids so a
/// future "restore defaults" can recognize them). Every pattern is something
/// an SSH user actually reads in terminal output, colored from the workbench
/// palette by severity: red = hard error, amber = command failed / restricted,
/// yellow = warning, green = success / healthy, blue = extractable info.
///
/// Matching priority is pattern length (frontend sorts longest-first), so the
/// specific red phrases win over their generic amber stems inside the same
/// line: "Permission denied" renders red while "Access denied" stays amber.
/// `(id, pattern, color, caseSensitive, isRegex)` — plain + case-insensitive
/// everywhere except the exact-case `PASSED` (avoids prose "passed") and the
/// IPv4 regex.
const DEFAULT_RULE_SPECS: [(&str, &str, &str, bool, bool); 22] = [
    // ---- 红：硬错误 ----
    ("default-error", "ERROR", "#ef4444", false, false),
    ("default-fatal", "FATAL", "#ef4444", false, false),
    (
        "default-permission-denied",
        "Permission denied",
        "#ef4444",
        false,
        false,
    ),
    (
        "default-no-such-file",
        "No such file or directory",
        "#ef4444",
        false,
        false,
    ),
    (
        "default-command-not-found",
        "command not found",
        "#ef4444",
        false,
        false,
    ),
    (
        "default-connection-refused",
        "Connection refused",
        "#ef4444",
        false,
        false,
    ),
    (
        "default-no-space-left",
        "No space left on device",
        "#ef4444",
        false,
        false,
    ),
    ("default-failed-to", "Failed to", "#ef4444", false, false),
    ("default-cannot", "cannot", "#ef4444", false, false),
    ("default-exception", "Exception", "#ef4444", false, false),
    (
        "default-traceback",
        "Traceback (most recent call last)",
        "#ef4444",
        false,
        false,
    ),
    // ---- 琥珀：命令失败 / 受限 ----
    ("default-fail", "FAIL", "#f59e0b", false, false),
    ("default-denied", "denied", "#f59e0b", false, false),
    ("default-timed-out", "timed out", "#f59e0b", false, false),
    // ---- 黄：警告 ----
    ("default-warn", "WARN", "#facc15", false, false),
    ("default-deprecated", "deprecated", "#facc15", false, false),
    // ---- 绿：成功 / 健康 ----
    ("default-success", "SUCCESS", "#22c55e", false, false),
    (
        "default-active-running",
        "active (running)",
        "#22c55e",
        false,
        false,
    ),
    ("default-done", "done", "#22c55e", false, false),
    ("default-check", "✓", "#22c55e", false, false),
    ("default-passed", "PASSED", "#22c55e", true, false),
    // ---- 蓝：可提取信息 ----
    (
        "default-ipv4",
        r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
        "#3b82f6",
        false,
        true,
    ),
];

fn default_rules(now: u64) -> Vec<HighlightRuleEntry> {
    DEFAULT_RULE_SPECS
        .iter()
        .map(
            |(id, pattern, color, case_sensitive, is_regex)| HighlightRuleEntry {
                id: (*id).to_string(),
                pattern: (*pattern).to_string(),
                is_regex: *is_regex,
                color: (*color).to_string(),
                case_sensitive: *case_sensitive,
                enabled: true,
                created_at: now,
                updated_at: now,
            },
        )
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct HighlightRuleEntry {
    pub id: String,
    pub pattern: String,
    pub is_regex: bool,
    pub color: String,
    pub case_sensitive: bool,
    pub enabled: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HighlightRuleStore {
    pub rules: Vec<HighlightRuleEntry>,
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
/// bad file can never break the workbench (same policy as quick-commands).
pub fn load_store(data_dir: &Path) -> HighlightRuleStore {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
        return HighlightRuleStore::default();
    };
    let rules = value
        .get("rules")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(entry_from_json).collect())
        .unwrap_or_default();
    HighlightRuleStore { rules }
}

/// Loads the store, seeding the first-run defaults when the store file does
/// not exist yet. A corrupted or user-emptied store is never reseeded (the
/// file existing is the "user already has a store" signal); a failed seed
/// write still returns the defaults for this call and retries on the next one.
pub fn load_or_seed_store(data_dir: &Path) -> HighlightRuleStore {
    if !store_path(data_dir).exists() {
        let store = HighlightRuleStore {
            rules: default_rules(unix_now_secs()),
        };
        let _ = save_store(data_dir, &store);
        return store;
    }
    load_store(data_dir)
}

/// Persists atomically (tmp + rename) with 0600 permissions on Unix.
pub fn save_store(data_dir: &Path, store: &HighlightRuleStore) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!({
        "version": STORAGE_VERSION,
        "rules": store.rules.iter().map(entry_json).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode highlight rules: {error}"))?;
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

fn entry_from_json(value: &Value) -> Option<HighlightRuleEntry> {
    let object = value.as_object()?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(HighlightRuleEntry {
        id: string("id"),
        pattern: string("pattern"),
        is_regex: object
            .get("isRegex")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        color: string("color"),
        case_sensitive: object
            .get("caseSensitive")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        created_at: object.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
        updated_at: object.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn entry_json(entry: &HighlightRuleEntry) -> Value {
    json!({
        "id": entry.id,
        "pattern": entry.pattern,
        "isRegex": entry.is_regex,
        "color": entry.color,
        "caseSensitive": entry.case_sensitive,
        "enabled": entry.enabled,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
    })
}

pub fn entry_view(entry: &HighlightRuleEntry) -> Value {
    entry_json(entry)
}

/// Rules in `createdAt` ascending order (stable, so equal timestamps keep
/// insertion order) — the contract order for `ssh/highlightRules/list`.
pub fn list_views(store: &HighlightRuleStore) -> Vec<Value> {
    let mut entries: Vec<&HighlightRuleEntry> = store.rules.iter().collect();
    entries.sort_by_key(|entry| entry.created_at);
    entries.into_iter().map(entry_view).collect()
}

/// `true` for `#rrggbb` in any ASCII hex case.
fn is_valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Creates or updates one rule from the shared camelCase parameter shape
/// (protocol `ssh/highlightRules/save`). A blank/missing `id` creates; a
/// non-empty `id` must reference an existing rule. The 30-rule cap only
/// constrains creation. Regex validity is the frontend's job (§1.1).
pub fn save_entry(
    store: &mut HighlightRuleStore,
    params: &Value,
) -> Result<(HighlightRuleEntry, bool), String> {
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing pattern")?;
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!(
            "Highlight pattern is limited to {MAX_PATTERN_CHARS} characters"
        ));
    }
    let is_regex = params
        .get("isRegex")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let color = match params.get("color") {
        Some(value) => {
            let color = value
                .as_str()
                .ok_or("color must be a #rrggbb hex string")?
                .trim()
                .to_string();
            if !is_valid_color(&color) {
                return Err(format!("color must match #rrggbb (hex); got '{color}'"));
            }
            color
        }
        None => DEFAULT_COLOR.to_string(),
    };
    let case_sensitive = params
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let enabled = params
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let existing_id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let existing = existing_id.and_then(|id| store.rules.iter().position(|entry| entry.id == id));
    if existing_id.is_some() && existing.is_none() {
        return Err(
            "Highlight rule to update was not found; omit id to create a new rule".to_string(),
        );
    }
    if existing.is_none() && store.rules.len() >= MAX_RULES {
        return Err(format!("At most {MAX_RULES} highlight rules are supported"));
    }
    let now = unix_now_secs();
    let entry = match existing {
        Some(index) => {
            let entry = &mut store.rules[index];
            entry.pattern = pattern.to_string();
            entry.is_regex = is_regex;
            entry.color = color;
            entry.case_sensitive = case_sensitive;
            entry.enabled = enabled;
            entry.updated_at = now;
            entry.clone()
        }
        None => {
            let entry = HighlightRuleEntry {
                id: uuid::Uuid::new_v4().to_string(),
                pattern: pattern.to_string(),
                is_regex,
                color,
                case_sensitive,
                enabled,
                created_at: now,
                updated_at: now,
            };
            store.rules.push(entry.clone());
            entry
        }
    };
    Ok((entry, existing.is_none()))
}

/// Removes a rule by id; returns false when the id is unknown (idempotent,
/// mirroring `ssh/quickCommands/delete` semantics — the file is only
/// rewritten when something was actually removed).
pub fn delete_entry(store: &mut HighlightRuleStore, id: &str) -> bool {
    let before = store.rules.len();
    store.rules.retain(|entry| entry.id != id);
    store.rules.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(store: &mut HighlightRuleStore, pattern: &str) -> HighlightRuleEntry {
        save_entry(store, &json!({ "pattern": pattern })).unwrap().0
    }

    #[test]
    fn save_creates_with_defaults_and_updates_in_place() {
        let mut store = HighlightRuleStore::default();
        let (created_entry, created) =
            save_entry(&mut store, &json!({ "pattern": "ERROR" })).unwrap();
        assert!(created);
        assert!(!created_entry.id.is_empty());
        assert_eq!(created_entry.pattern, "ERROR");
        assert!(!created_entry.is_regex, "isRegex defaults to false");
        assert_eq!(created_entry.color, DEFAULT_COLOR);
        assert!(!created_entry.case_sensitive);
        assert!(created_entry.enabled);
        assert_eq!(created_entry.created_at, created_entry.updated_at);

        // Update keeps the id and bumps only the pattern + updatedAt.
        let id = created_entry.id.clone();
        let (updated, created) = save_entry(
            &mut store,
            &json!({ "id": id, "pattern": "FATAL", "isRegex": false, "color": "#22c55e",
                     "caseSensitive": true, "enabled": false }),
        )
        .unwrap();
        assert!(!created);
        assert_eq!(updated.id, id);
        assert_eq!(updated.pattern, "FATAL");
        assert_eq!(updated.color, "#22c55e");
        assert!(updated.case_sensitive);
        assert!(!updated.enabled);
        assert_eq!(store.rules.len(), 1);
    }

    #[test]
    fn save_rejects_missing_oversized_or_malformed_input() {
        let mut store = HighlightRuleStore::default();
        // Pattern is required (trimmed non-empty).
        assert!(save_entry(&mut store, &json!({ "pattern": "   " })).is_err());
        assert!(save_entry(&mut store, &json!({})).is_err());
        // Length cap.
        assert!(save_entry(&mut store, &json!({ "pattern": "x".repeat(201) })).is_err());
        // Color must be #rrggbb.
        for bad_color in [
            "orange",
            "#12345",
            "#1234567",
            "#12h456",
            "f59e0b",
            "#ff00ff00",
        ] {
            assert!(
                save_entry(&mut store, &json!({ "pattern": "e", "color": bad_color })).is_err(),
                "expected color rejection for {bad_color}"
            );
        }
        // Updating a non-existent id is an error (never a silent create).
        assert!(save_entry(&mut store, &json!({ "id": "ghost", "pattern": "e" })).is_err());
        // Valid boundary: exactly 200 chars passes.
        assert!(save_entry(&mut store, &json!({ "pattern": "y".repeat(200) })).is_ok());
    }

    #[test]
    fn cap_is_enforced_on_new_entries_only() {
        let mut store = HighlightRuleStore::default();
        for index in 0..MAX_RULES {
            save(&mut store, &format!("p{index}"));
        }
        assert!(save_entry(&mut store, &json!({ "pattern": "overflow" })).is_err());
        // Updating an existing rule stays within the cap.
        let id = store.rules[0].id.clone();
        assert!(save_entry(&mut store, &json!({ "id": id, "pattern": "ok" })).is_ok());
        assert_eq!(store.rules.len(), MAX_RULES);
    }

    #[test]
    fn delete_reports_presence_and_is_idempotent() {
        let mut store = HighlightRuleStore::default();
        let entry = save(&mut store, "ERROR");
        assert!(delete_entry(&mut store, &entry.id));
        assert!(!delete_entry(&mut store, &entry.id));
        assert!(store.rules.is_empty());
    }

    #[test]
    fn corrupted_file_falls_back_to_empty_store() {
        let dir = std::env::temp_dir().join(format!("dbx-hl-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store_path(&dir), "{not json").unwrap();
        assert!(load_store(&dir).rules.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_load_seeds_defaults_and_persists_them() {
        let dir = std::env::temp_dir().join(format!("dbx-hl-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = load_or_seed_store(&dir);
        let patterns: Vec<&str> = store
            .rules
            .iter()
            .map(|entry| entry.pattern.as_str())
            .collect();
        assert_eq!(
            patterns,
            [
                "ERROR",
                "FATAL",
                "Permission denied",
                "No such file or directory",
                "command not found",
                "Connection refused",
                "No space left on device",
                "Failed to",
                "cannot",
                "Exception",
                "Traceback (most recent call last)",
                "FAIL",
                "denied",
                "timed out",
                "WARN",
                "deprecated",
                "SUCCESS",
                "active (running)",
                "done",
                "✓",
                "PASSED",
                r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
            ]
        );
        for entry in &store.rules {
            assert!(entry.enabled);
            assert_eq!(entry.created_at, entry.updated_at);
            // Only the IPv4 rule is a regex; only PASSED pins the case.
            assert_eq!(entry.is_regex, entry.id == "default-ipv4");
            assert_eq!(entry.case_sensitive, entry.id == "default-passed");
        }
        // The seed is persisted: the next load reads the file, and a user
        // deleting every rule afterwards is NOT reseeded (file exists).
        let reloaded = load_or_seed_store(&dir);
        assert_eq!(reloaded, store);
        let mut emptied = reloaded;
        emptied.rules.clear();
        save_store(&dir, &emptied).unwrap();
        assert!(load_or_seed_store(&dir).rules.is_empty());
        // Deterministic ids so defaults stay recognizable across installs.
        assert_eq!(store.rules[0].id, "default-error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_roundtrip_preserves_rules_in_order() {
        let dir = std::env::temp_dir().join(format!("dbx-hl-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = HighlightRuleStore::default();
        save(&mut store, "ERROR");
        save(&mut store, "FATAL");
        save_store(&dir, &store).unwrap();
        let loaded = load_store(&dir);
        assert_eq!(loaded, store);
        assert_eq!(loaded.rules.len(), 2);
        // The persisted file is 0600 on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_carry_full_fields_sorted_by_created_at() {
        let mut store = HighlightRuleStore::default();
        let first = save(&mut store, "ERROR");
        let second = save(&mut store, "FATAL");
        // Simulate rules stored newest-first with distinct timestamps, then
        // verify the view still lists createdAt-ascending.
        store.rules[0].created_at = 2000;
        store.rules[0].updated_at = 2000;
        store.rules[1].created_at = 1000;
        store.rules[1].updated_at = 1000;
        store.rules.reverse();
        let views = list_views(&store);
        assert_eq!(views.len(), 2);
        assert_eq!(views[0]["pattern"], second.pattern, "older createdAt first");
        assert_eq!(views[1]["pattern"], first.pattern);
        for view in &views {
            let keys: Vec<&str> = view
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            for expected in [
                "id",
                "pattern",
                "isRegex",
                "color",
                "caseSensitive",
                "enabled",
                "createdAt",
                "updatedAt",
            ] {
                assert!(keys.contains(&expected), "missing {expected} in {keys:?}");
            }
        }
    }
}
