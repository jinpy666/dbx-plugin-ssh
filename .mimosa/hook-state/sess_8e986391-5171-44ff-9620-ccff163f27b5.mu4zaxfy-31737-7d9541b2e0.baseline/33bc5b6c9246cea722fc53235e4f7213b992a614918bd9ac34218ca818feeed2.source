//! Global SFTP path bookmarks: user-named remote paths persisted in
//! `<plugin_data_dir>/sftp-bookmarks.json` and shared by every connection
//! (paths are global, not per-connection). Mirrors the quick-commands store:
//! versioned JSON, atomic tmp + rename writes with 0600, and a corrupted
//! file falls back to an empty store so a bad file can never break the
//! workbench.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "sftp-bookmarks.json";
/// Cap shared with the workbench bookmark dropdown.
pub const MAX_BOOKMARKS: usize = 20;
const MAX_LABEL_LEN: usize = 64;
/// Paths are not existence-checked (a bookmark may point at an unmounted
/// path), so the length bound is the only sanity rule.
const MAX_PATH_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct BookmarkEntry {
    pub id: String,
    pub label: String,
    pub path: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BookmarkStore {
    pub bookmarks: Vec<BookmarkEntry>,
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Loads the store; a missing or corrupted file yields an empty store so a
/// bad file can never break the workbench (same policy as quick-commands).
pub fn load_store(data_dir: &Path) -> BookmarkStore {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
        return BookmarkStore::default();
    };
    let bookmarks = value
        .get("bookmarks")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(entry_from_json).collect())
        .unwrap_or_default();
    BookmarkStore { bookmarks }
}

/// Persists atomically (tmp + rename) with 0600 permissions on Unix.
pub fn save_store(data_dir: &Path, store: &BookmarkStore) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!({
        "version": STORAGE_VERSION,
        "bookmarks": store.bookmarks.iter().map(entry_json).collect::<Vec<_>>(),
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode sftp bookmarks: {error}"))?;
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

fn entry_from_json(value: &Value) -> Option<BookmarkEntry> {
    let object = value.as_object()?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(BookmarkEntry {
        id: string("id"),
        label: string("label"),
        path: string("path"),
        created_at: object.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
        updated_at: object.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn entry_json(entry: &BookmarkEntry) -> Value {
    json!({
        "id": entry.id,
        "label": entry.label,
        "path": entry.path,
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
    })
}

pub fn bookmark_view(entry: &BookmarkEntry) -> Value {
    entry_json(entry)
}

/// Sorted by label (case-insensitive, matching the uniqueness rule) so the
/// workbench dropdown order is stable.
pub fn list_views(store: &BookmarkStore) -> Vec<Value> {
    let mut entries = store.bookmarks.clone();
    entries.sort_by_key(|a| a.label.to_lowercase());
    entries.iter().map(bookmark_view).collect()
}

/// Creates or updates one bookmark from the shared camelCase parameter shape
/// (protocol `sftp/bookmarks/save`). Labels are unique case-insensitively
/// across the store; an existing `id` must resolve. Returns the saved entry
/// plus whether it was newly created.
pub fn save_entry(
    store: &mut BookmarkStore,
    params: &Value,
) -> Result<(BookmarkEntry, bool), String> {
    let label = params
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing label")?;
    if label.chars().count() > MAX_LABEL_LEN {
        return Err(format!(
            "Bookmark label is limited to {MAX_LABEL_LEN} characters"
        ));
    }
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing path")?;
    if path.chars().count() > MAX_PATH_LEN {
        return Err(format!(
            "Bookmark path is limited to {MAX_PATH_LEN} characters"
        ));
    }
    let existing_id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let existing =
        existing_id.and_then(|id| store.bookmarks.iter().position(|entry| entry.id == id));
    if existing_id.is_some() && existing.is_none() {
        return Err("Bookmark was not found".to_string());
    }
    let label_key = label.to_lowercase();
    if store
        .bookmarks
        .iter()
        .enumerate()
        .any(|(index, entry)| entry.label.to_lowercase() == label_key && Some(index) != existing)
    {
        return Err("A bookmark with this label already exists".to_string());
    }
    if existing.is_none() && store.bookmarks.len() >= MAX_BOOKMARKS {
        return Err(format!("At most {MAX_BOOKMARKS} bookmarks are supported"));
    }
    let now = unix_now_secs();
    let entry = match existing {
        Some(index) => {
            let entry = &mut store.bookmarks[index];
            entry.label = label.to_string();
            entry.path = path.to_string();
            entry.updated_at = now;
            entry.clone()
        }
        None => {
            let entry = BookmarkEntry {
                id: uuid::Uuid::new_v4().to_string(),
                label: label.to_string(),
                path: path.to_string(),
                created_at: now,
                updated_at: now,
            };
            store.bookmarks.push(entry.clone());
            entry
        }
    };
    Ok((entry, existing.is_none()))
}

/// Removes an entry by id; returns false when the id is unknown (the caller
/// turns that into the `sftp/bookmarks/delete` error).
pub fn delete_entry(store: &mut BookmarkStore, id: &str) -> bool {
    let before = store.bookmarks.len();
    store.bookmarks.retain(|entry| entry.id != id);
    store.bookmarks.len() != before
}

/// Full `sftp/bookmarks/list` response.
pub fn list(data_dir: &Path) -> Result<Value, String> {
    Ok(json!({ "bookmarks": list_views(&load_store(data_dir)) }))
}

/// Full `sftp/bookmarks/save` response: `{ bookmark, created }`.
pub fn save(data_dir: &Path, params: &Value) -> Result<Value, String> {
    let mut store = load_store(data_dir);
    let (entry, created) = save_entry(&mut store, params)?;
    save_store(data_dir, &store)?;
    Ok(json!({ "bookmark": bookmark_view(&entry), "created": created }))
}

/// Full `sftp/bookmarks/delete` response; an unknown id is an error.
pub fn delete(data_dir: &Path, id: &str) -> Result<Value, String> {
    let mut store = load_store(data_dir);
    if !delete_entry(&mut store, id) {
        return Err("Bookmark was not found".to_string());
    }
    save_store(data_dir, &store)?;
    Ok(json!({ "success": true, "removed": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save_to(store: &mut BookmarkStore, label: &str, path: &str) -> BookmarkEntry {
        save_entry(store, &json!({ "label": label, "path": path }))
            .unwrap()
            .0
    }

    #[test]
    fn save_creates_and_updates() {
        let mut store = BookmarkStore::default();
        let (created_entry, created) =
            save_entry(&mut store, &json!({ "label": "logs", "path": "/var/log" })).unwrap();
        assert!(created);
        assert_eq!(created_entry.label, "logs");
        assert_eq!(created_entry.path, "/var/log");
        let id = created_entry.id;
        let (updated, created) = save_entry(
            &mut store,
            &json!({ "id": id, "label": "Logs", "path": "/var/log/nginx" }),
        )
        .unwrap();
        assert!(!created);
        assert_eq!(updated.path, "/var/log/nginx");
        assert_eq!(updated.created_at, created_entry.created_at);
        assert!(updated.updated_at >= created_entry.updated_at);
        assert_eq!(store.bookmarks.len(), 1);
    }

    #[test]
    fn save_rejects_missing_oversized_or_duplicate_input() {
        let mut store = BookmarkStore::default();
        save_to(&mut store, "ops", "/opt");
        // Label: blank, oversized, duplicate (case-insensitive).
        assert!(save_entry(&mut store, &json!({ "label": "  ", "path": "/tmp" })).is_err());
        assert!(save_entry(&mut store, &json!({ "path": "/tmp" })).is_err());
        assert!(save_entry(
            &mut store,
            &json!({ "label": "l".repeat(65), "path": "/tmp" })
        )
        .is_err());
        assert!(save_entry(&mut store, &json!({ "label": "OPS", "path": "/tmp" })).is_err());
        // Path: blank, oversized.
        assert!(save_entry(&mut store, &json!({ "label": "tmp", "path": " " })).is_err());
        assert!(save_entry(&mut store, &json!({ "label": "tmp" })).is_err());
        assert!(save_entry(
            &mut store,
            &json!({ "label": "tmp", "path": "/".repeat(1025) })
        )
        .is_err());
        // Unknown update id.
        assert!(save_entry(
            &mut store,
            &json!({ "id": "ghost", "label": "x", "path": "/x" })
        )
        .is_err());
        assert_eq!(store.bookmarks.len(), 1);
    }

    #[test]
    fn cap_is_enforced_on_new_entries_only() {
        let mut store = BookmarkStore::default();
        for index in 0..MAX_BOOKMARKS {
            save_to(&mut store, &format!("b{index}"), &format!("/p{index}"));
        }
        assert!(save_entry(&mut store, &json!({ "label": "overflow", "path": "/x" })).is_err());
        // Updating an existing entry stays within the cap.
        let id = store.bookmarks[0].id.clone();
        assert!(save_entry(
            &mut store,
            &json!({ "id": id, "label": "b0", "path": "/renamed" })
        )
        .is_ok());
    }

    #[test]
    fn delete_reports_presence() {
        let mut store = BookmarkStore::default();
        let entry = save_to(&mut store, "ops", "/opt");
        assert!(delete_entry(&mut store, &entry.id));
        assert!(!delete_entry(&mut store, &entry.id));
        assert!(store.bookmarks.is_empty());
    }

    #[test]
    fn corrupted_file_falls_back_to_empty_store() {
        let dir = std::env::temp_dir().join(format!("dbx-sftp-bm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store_path(&dir), "{not json").unwrap();
        assert!(load_store(&dir).bookmarks.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_roundtrip_preserves_entries() {
        let dir = std::env::temp_dir().join(format!("dbx-sftp-bm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = BookmarkStore::default();
        save_to(&mut store, "logs", "/var/log");
        save_to(&mut store, "home", "/home/deployer");
        save_store(&dir, &store).unwrap();
        let loaded = load_store(&dir);
        assert_eq!(loaded, store);
        assert_eq!(loaded.bookmarks.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_are_sorted_by_label_case_insensitively() {
        let mut store = BookmarkStore::default();
        save_to(&mut store, "uploads", "/srv/uploads");
        save_to(&mut store, "apache", "/etc/apache2");
        save_to(&mut store, "Backups", "/mnt/backups");
        let views = list_views(&store);
        let labels: Vec<&str> = views
            .iter()
            .map(|view| view["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels, vec!["apache", "Backups", "uploads"]);
        assert_eq!(views[0]["path"], "/etc/apache2");
        assert!(views[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    }

    #[test]
    fn high_level_delete_refuses_unknown_ids() {
        let dir = std::env::temp_dir().join(format!("dbx-sftp-bm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(delete(&dir, "ghost").is_err());
        let response = save(&dir, &json!({ "label": "ops", "path": "/opt" })).unwrap();
        assert_eq!(response["created"], true);
        let id = response["bookmark"]["id"].as_str().unwrap().to_string();
        let removed = delete(&dir, &id).unwrap();
        assert_eq!(removed["success"], true);
        assert_eq!(removed["removed"], true);
        assert!(list(&dir).unwrap()["bookmarks"]
            .as_array()
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
