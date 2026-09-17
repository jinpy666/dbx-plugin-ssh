//! Persistent transfer history for SFTP upload/download jobs, kept in
//! `<plugin_data_dir>/transfer-history.json` so the workbench can still list
//! past transfers after a sidecar restart. Only status transitions (start,
//! complete, cancel, fail) hit the disk; per-chunk progress stays in the
//! in-memory registries and the progress events. The store keeps a global
//! ring of the newest 200 rows and is rewritten atomically (tmp + rename,
//! 0600) — same policy as quick-commands.json.
//!
//! Cross-process semantics (last-writer-wins): the embedded sidecar and the
//! stdio `--mcp` process share the plugin data directory, and each
//! transition does a read-merge-rewrite of the whole file keyed by taskId.
//! The history is best-effort UX data (not an audit ledger), so a concurrent
//! write inside the read-modify-write window may drop that writer's row;
//! this is accepted by design.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "transfer-history.json";
/// Global ring cap shared with `sftp/transfer/history` (limit clamps to it).
pub const MAX_HISTORY: usize = 200;
/// Statuses an in-flight transfer carries. Rows still holding one of these
/// were written by a sidecar that died mid-transfer and are downgraded on
/// load (see `load_history`).
const ACTIVE_STATUSES: [&str; 2] = ["running", "queued"];

pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Unix milliseconds, matching the audit-ledger timestamp precision.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Raw read of the persisted rows (oldest first) with no stale-status
/// repair, so `record_transition` never rewrites another live process'
/// `running` rows as failed.
fn load_rows(data_dir: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
        return Vec::new();
    };
    value
        .get("tasks")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter(|row| row.is_object()).cloned().collect())
        .unwrap_or_default()
}

/// Loads the history for display, oldest first. Rows still marked
/// `running`/`queued` come from a sidecar that died mid-transfer and are
/// downgraded to `failed` with an English restart note, so the workbench
/// never shows a ghost running task after a restart. The repair is
/// presentation-only on purpose: the data directory is shared between the
/// embedded sidecar and the stdio `--mcp` process, and rewriting the file at
/// load time would mark another live process' in-flight transfers as failed.
pub fn load_history(data_dir: &Path) -> Vec<Value> {
    load_rows(data_dir)
        .into_iter()
        .map(|mut row| {
            let status = row
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if ACTIVE_STATUSES.contains(&status) {
                if let Some(object) = row.as_object_mut() {
                    object.insert("status".to_string(), json!("failed"));
                    object.insert(
                        "error".to_string(),
                        json!("Transfer was interrupted by a sidecar restart"),
                    );
                }
            }
            row
        })
        .collect()
}

/// Removes the persisted transfer history. In-flight rows are not touched;
/// the live registry will repopulate them on the next history refresh.
pub fn clear_history(data_dir: &Path) -> Result<(), String> {
    let path = store_path(data_dir);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to clear transfer history: {error}")),
    }
}

/// Persists one status transition (start / complete / cancel / fail). The
/// row is merged into the store keyed by taskId — an existing row is
/// replaced in place (keeping its `startedAt`/`connectionId` when the new
/// record does not carry them), otherwise the record is appended as the
/// newest row. The ring is trimmed to the newest `MAX_HISTORY` rows and the
/// file is rewritten atomically.
pub fn record_transition(data_dir: &Path, task: &Value) -> Result<(), String> {
    let task_id = task
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Transfer record is missing its taskId")?;
    let mut rows = load_rows(data_dir);
    let position = rows
        .iter()
        .position(|row| row.get("taskId").and_then(Value::as_str) == Some(task_id));
    let (prev_started_at, prev_connection_id) = position
        .and_then(|index| rows.get(index))
        .map(|row| {
            (
                row.get("startedAt").and_then(Value::as_u64),
                row.get("connectionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .unwrap_or((None, String::new()));
    let merged = merge_transition(task, prev_started_at, &prev_connection_id);
    match position {
        Some(index) => rows[index] = merged,
        None => rows.push(merged),
    }
    if rows.len() > MAX_HISTORY {
        rows.drain(..rows.len() - MAX_HISTORY);
    }
    save_rows(data_dir, &rows)
}

/// Normalizes one transition into the persisted row shape. Terminal
/// transitions are raised from the in-memory registries, which only carry
/// live state, so `startedAt` and `connectionId` are inherited from the
/// previous row of the same task when the caller does not know them.
fn merge_transition(task: &Value, prev_started_at: Option<u64>, prev_connection_id: &str) -> Value {
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("running");
    let started_at = task
        .get("startedAt")
        .and_then(Value::as_u64)
        .or(prev_started_at)
        .unwrap_or_else(now_ms);
    let connection_id = task
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| prev_connection_id.to_string());
    let finished_at = if status == "running" {
        Value::Null
    } else {
        json!(now_ms())
    };
    let mut row = json!({
        "taskId": task.get("taskId").cloned().unwrap_or_default(),
        "sessionId": task.get("sessionId").cloned().unwrap_or_default(),
        "connectionId": connection_id,
        "direction": task.get("direction").cloned().unwrap_or_default(),
        "fileName": task.get("fileName").cloned().unwrap_or_default(),
        "size": task.get("size").cloned().unwrap_or(json!(0)),
        "transferred": task.get("transferred").cloned().unwrap_or(json!(0)),
        "status": status,
        "startedAt": started_at,
        "finishedAt": finished_at,
    });
    if let Some(error) = task
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        row["error"] = json!(error);
    }
    // saveToLocal 下载完成行的本机落盘路径；`local/reveal` 以它做白名单校验。
    if let Some(local_path) = task
        .get("localPath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        row["localPath"] = json!(local_path);
    }
    row
}

/// Persists atomically (tmp + rename) with 0600 permissions on Unix.
fn save_rows(data_dir: &Path, rows: &[Value]) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!({
        "version": STORAGE_VERSION,
        "tasks": rows,
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode transfer history: {error}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dbx-transfer-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn row(task_id: &str, status: &str) -> Value {
        json!({
            "taskId": task_id,
            "sessionId": "s1",
            "connectionId": "c1",
            "direction": "download",
            "fileName": format!("{task_id}.bin"),
            "size": 10,
            "transferred": 10,
            "status": status,
            "startedAt": 1,
            "finishedAt": 2,
        })
    }

    #[test]
    fn roundtrip_preserves_terminal_rows_in_order() {
        let dir = temp_dir();
        let rows = vec![row("t1", "completed"), row("t2", "cancelled")];
        save_rows(&dir, &rows).unwrap();
        let loaded = load_history(&dir);
        assert_eq!(loaded, rows);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ring_cap_drops_the_oldest_rows() {
        let dir = temp_dir();
        for index in 0..MAX_HISTORY + 5 {
            record_transition(&dir, &row(&format!("t{index}"), "completed")).unwrap();
        }
        let loaded = load_history(&dir);
        assert_eq!(loaded.len(), MAX_HISTORY);
        assert_eq!(loaded[0]["taskId"], "t5", "the oldest rows must be trimmed");
        assert_eq!(
            loaded.last().unwrap()["taskId"],
            format!("t{}", MAX_HISTORY + 4)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_running_rows_are_downgraded_on_load() {
        let dir = temp_dir();
        let text = serde_json::to_string(&json!({
            "version": 1,
            "tasks": [
                row("t-run", "running"),
                {
                    "taskId": "t-queued", "sessionId": "s1", "direction": "upload",
                    "fileName": "q.bin", "size": 1, "transferred": 0,
                    "status": "queued", "startedAt": 5, "finishedAt": null,
                },
                row("t-done", "completed"),
            ],
        }))
        .unwrap();
        std::fs::write(store_path(&dir), text).unwrap();
        let loaded = load_history(&dir);
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0]["status"], "failed");
        assert!(
            loaded[0]["error"]
                .as_str()
                .unwrap()
                .contains("sidecar restart"),
            "unexpected error: {}",
            loaded[0]["error"]
        );
        assert_eq!(loaded[1]["status"], "failed");
        assert_eq!(loaded[2]["status"], "completed");
        // Terminal rows keep their own error untouched.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn transition_updates_in_place_and_inherits_context() {
        let dir = temp_dir();
        record_transition(
            &dir,
            &json!({
                "taskId": "t1", "sessionId": "s1", "connectionId": "c1",
                "direction": "upload", "fileName": "a.bin", "size": 9,
                "transferred": 0, "status": "running",
                "startedAt": 100, "finishedAt": null,
            }),
        )
        .unwrap();
        record_transition(
            &dir,
            &json!({
                "taskId": "t1", "sessionId": "s1", "direction": "upload",
                "fileName": "a.bin", "size": 9, "transferred": 9,
                "status": "completed",
            }),
        )
        .unwrap();
        let loaded = load_history(&dir);
        assert_eq!(loaded.len(), 1, "the same task must not duplicate");
        assert_eq!(loaded[0]["status"], "completed");
        assert_eq!(loaded[0]["connectionId"], "c1", "start context is kept");
        assert_eq!(loaded[0]["startedAt"], 100);
        assert!(loaded[0]["finishedAt"].as_u64().is_some());
        // A second task appends as a new row.
        record_transition(
            &dir,
            &json!({
                "taskId": "t2", "sessionId": "s1", "direction": "download",
                "fileName": "b.bin", "size": 3, "transferred": 1,
                "status": "cancelled", "error": "Upload cancelled",
            }),
        )
        .unwrap();
        let loaded = load_history(&dir);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1]["status"], "cancelled");
        assert_eq!(loaded[1]["error"], "Upload cancelled");
        assert_eq!(loaded[1]["connectionId"], "", "unknown context stays empty");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_file_falls_back_to_empty_history() {
        let dir = temp_dir();
        std::fs::write(store_path(&dir), "{not json").unwrap();
        assert!(load_history(&dir).is_empty());
        // Recording still works from the empty base.
        record_transition(&dir, &row("t1", "failed")).unwrap();
        assert_eq!(load_history(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
