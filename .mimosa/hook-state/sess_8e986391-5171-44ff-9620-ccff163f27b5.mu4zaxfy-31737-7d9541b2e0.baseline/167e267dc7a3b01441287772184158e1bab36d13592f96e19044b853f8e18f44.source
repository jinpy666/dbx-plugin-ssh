//! Persisted metrics history for trend charts, kept as JSONL in
//! `<plugin_data_dir>/metrics-history.jsonl`. One row per fresh
//! `ssh/metrics` collection (the workbench polls every few seconds, so the
//! ring accumulates while the metrics card is open and survives sidecar
//! restarts). Rows are keyed by connectionId — session ids change on every
//! reconnect, the connection they belong to does not.
//!
//! Same policy as `transfer_history.rs`: append + best-effort, UX data not
//! an audit ledger; the file is trimmed to the newest [`MAX_SAMPLES`] rows
//! (rewrite) and the store is shared last-writer-wins between the embedded
//! sidecar and the stdio `--mcp` process.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

const FILE_NAME: &str = "metrics-history.jsonl";
/// Ring cap: 1 hour at a 5s poll cadence.
pub const MAX_SAMPLES: usize = 720;

pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// Unix milliseconds for sample timestamps.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Builds one history row from a fresh metrics snapshot. Rows carry only
/// the fields the trend charts render; per-disk / per-process detail stays
/// out of the ring. Pure so it is unit-testable without a snapshot source.
pub fn sample_from_snapshot(connection_id: &str, snapshot: &Value) -> Value {
    let cpu_percent = snapshot
        .get("cpu")
        .and_then(|cpu| cpu.get("percent"))
        .and_then(Value::as_f64);
    let load1 = snapshot
        .get("cpu")
        .and_then(|cpu| cpu.get("load1"))
        .and_then(Value::as_f64);
    let memory_percent = match (
        snapshot
            .get("memory")
            .and_then(|memory| memory.get("totalBytes"))
            .and_then(Value::as_u64),
        snapshot
            .get("memory")
            .and_then(|memory| memory.get("availableBytes"))
            .and_then(Value::as_u64),
    ) {
        (Some(total), Some(available)) if total > 0 => {
            Some((total.saturating_sub(available)) as f64 * 100.0 / total as f64)
        }
        _ => None,
    };
    let (rx_rate, tx_rate) = snapshot
        .get("network")
        .and_then(Value::as_array)
        .map(|nets| {
            nets.iter().fold((0.0_f64, 0.0_f64), |(rx, tx), net| {
                (
                    rx + net.get("rxRate").and_then(Value::as_f64).unwrap_or(0.0),
                    tx + net.get("txRate").and_then(Value::as_f64).unwrap_or(0.0),
                )
            })
        })
        .unwrap_or((0.0, 0.0));
    let mut row = json!({
        "connectionId": connection_id,
        "ts": now_ms(),
    });
    if let Some(object) = row.as_object_mut() {
        if let Some(value) = cpu_percent {
            object.insert("cpuPercent".to_string(), json!(value));
        }
        if let Some(value) = memory_percent {
            object.insert("memoryPercent".to_string(), json!(value));
        }
        if let Some(value) = load1 {
            object.insert("load1".to_string(), json!(value));
        }
        object.insert("rxRate".to_string(), json!(rx_rate));
        object.insert("txRate".to_string(), json!(tx_rate));
    }
    row
}

/// Appends one sample to the JSONL ring, trimming to the newest
/// [`MAX_SAMPLES`] rows when the file grows past the cap. The ring file is
/// tiny (≤ ~64 KB at the cap), so the read-per-append cost is negligible;
/// correctness beats a fragile size heuristic. Best-effort: callers log
/// failures, metrics never depend on it.
pub fn append_sample(data_dir: &Path, row: &Value) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string(row)
        .map_err(|error| format!("Failed to encode metrics sample: {error}"))?;
    let existing = load_raw_rows(&path);
    if existing.len() + 1 > MAX_SAMPLES {
        // Rewrite keeping room for the incoming row so the ring never
        // grows past the cap.
        let keep_from = existing.len().saturating_sub(MAX_SAMPLES.saturating_sub(1));
        let mut kept = existing;
        kept.drain(..keep_from);
        let mut body = kept.join("\n");
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&text);
        body.push('\n');
        write_atomic(&path, &body)?;
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    writeln!(file, "{text}").map_err(|error| format!("Failed to append metrics sample: {error}"))
}

/// Reads the raw JSONL lines (oldest first) without parsing; used by the
/// trim rewrite so valid-but-unparsed lines are never dropped.
fn load_raw_rows(path: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Owned loader: reads the JSONL rows (oldest first), drops corrupt lines,
/// filters to one connection when requested, and keeps only the newest
/// `limit` rows.
pub fn load_history(data_dir: &Path, connection_id: Option<&str>, limit: usize) -> Vec<Value> {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let mut rows: Vec<Value> = text
        .lines()
        .filter_map(|line| {
            let value = serde_json::from_str::<Value>(line.trim()).ok()?;
            value.is_object().then_some(value)
        })
        .collect();
    if let Some(connection_id) = connection_id {
        rows.retain(|row| row.get("connectionId").and_then(Value::as_str) == Some(connection_id));
    }
    if rows.len() > limit {
        rows.drain(..rows.len() - limit);
    }
    rows
}

fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, body)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dbx-metrics-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn snapshot(cpu: f64, total: u64, available: u64, rx: f64) -> Value {
        json!({
            "cpu": { "cores": 4, "percent": cpu, "load1": 0.5 },
            "memory": { "totalBytes": total, "availableBytes": available },
            "network": [
                { "name": "eth0", "rxRate": rx, "txRate": 10.0, "rxTotal": 1, "txTotal": 1 },
                { "name": "lo", "rxRate": 0.0, "txRate": 0.0, "rxTotal": 1, "txTotal": 1 },
            ],
        })
    }

    #[test]
    fn sample_extracts_chart_fields_from_snapshot() {
        let row = sample_from_snapshot("conn-1", &snapshot(33.5, 1000, 250, 120.0));
        assert_eq!(row["connectionId"], "conn-1");
        assert_eq!(row["cpuPercent"], 33.5);
        assert_eq!(row["memoryPercent"], 75.0);
        assert_eq!(row["load1"], 0.5);
        assert_eq!(row["rxRate"], 120.0);
        assert_eq!(row["txRate"], 10.0);
        assert!(row["ts"].as_u64().unwrap() > 0);
    }

    #[test]
    fn sample_tolerates_missing_sections() {
        let row = sample_from_snapshot("c", &json!({}));
        assert!(row.get("cpuPercent").is_none());
        assert!(row.get("memoryPercent").is_none());
        assert_eq!(row["rxRate"], 0.0);
        // Zero-total memory must not divide by zero.
        let zero = sample_from_snapshot(
            "c",
            &json!({ "memory": { "totalBytes": 0, "availableBytes": 0 } }),
        );
        assert!(zero.get("memoryPercent").is_none());
    }

    #[test]
    fn history_roundtrips_and_filters_by_connection() {
        let dir = temp_dir();
        for connection in ["a", "b"] {
            for index in 0..3 {
                let mut row = sample_from_snapshot(connection, &snapshot(1.0, 10, 5, 0.0));
                row["ts"] = json!(1000 + index);
                append_sample(&dir, &row).unwrap();
            }
        }
        let all = load_history(&dir, None, 100);
        assert_eq!(all.len(), 6);
        assert_eq!(all[0]["connectionId"], "a", "oldest first");
        let only_b = load_history(&dir, Some("b"), 100);
        assert_eq!(only_b.len(), 3);
        assert!(only_b.iter().all(|row| row["connectionId"] == "b"));
        // Limit keeps the newest rows (oldest of the kept pair first).
        let last_two = load_history(&dir, None, 2);
        assert_eq!(last_two.len(), 2);
        assert_eq!(last_two[0]["connectionId"], "b");
        assert_eq!(last_two[0]["ts"], 1001);
        assert_eq!(last_two[1]["ts"], 1002);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ring_trims_to_the_cap_on_append() {
        let dir = temp_dir();
        for index in 0..(MAX_SAMPLES + 30) {
            let mut row = sample_from_snapshot("a", &snapshot(1.0, 10, 5, 0.0));
            row["ts"] = json!(index);
            append_sample(&dir, &row).unwrap();
        }
        let rows = load_history(&dir, None, usize::MAX);
        assert_eq!(rows.len(), MAX_SAMPLES);
        assert_eq!(rows[0]["ts"], 30, "the oldest rows must be trimmed");
        assert_eq!(rows.last().unwrap()["ts"], json!(MAX_SAMPLES + 29));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_lines_are_skipped() {
        let dir = temp_dir();
        std::fs::write(
            store_path(&dir),
            "{not json\n{\"connectionId\":\"a\",\"ts\":1}\n\n",
        )
        .unwrap();
        let rows = load_history(&dir, None, 100);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["ts"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
