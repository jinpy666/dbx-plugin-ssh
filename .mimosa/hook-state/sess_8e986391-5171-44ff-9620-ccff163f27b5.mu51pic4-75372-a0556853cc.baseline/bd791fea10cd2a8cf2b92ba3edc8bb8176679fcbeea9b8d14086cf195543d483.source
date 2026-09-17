//! Session recording: captures a terminal session's output stream into an
//! asciicast v2 file (`.cast`, JSONL) under `<plugin_data_dir>/recordings/`.
//! One recording per session at a time; the recorder is fed by the session's
//! read loop at the same point as the agent-terminal recorder, so everything
//! the terminal shows (stdout + stderr, after the directory-tracking filter)
//! lands in the file.
//!
//! Format: line 1 is the asciicast v2 header (`{"version":2,...}` with a
//! plugin `meta` block carrying sessionId/connectionId/host); every further
//! line is `{"time": <secs since start>, "eventtype": "o", "eventdata":
//! "<utf-8 output>"}`. Replay consumers (asciinema-compatible) ignore the
//! extra `meta` field; the plugin's own replay reads it back for the list
//! view without touching event lines.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{json, Value};

/// Directory holding the `.cast` files.
pub const RECORDINGS_DIR: &str = "recordings";
/// Cap on one event's stored size — a single PTY burst above this is
/// truncated on write (the terminal itself renders lossily anyway).
const MAX_EVENT_BYTES: usize = 256 * 1024;
/// Max events served by one `ssh/recording/get` page.
pub const PAGE_LIMIT: usize = 500;

pub fn recordings_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(RECORDINGS_DIR)
}

/// Builds the header for a fresh recording. `width`/`height` mirror the
/// session's PTY size when known; the plugin's replay scales to its own
/// xterm size regardless.
pub fn header(connection_id: &str, host: &str, session_id: &str, width: u32, height: u32) -> Value {
    json!({
        "version": 2,
        "width": width.max(1),
        "height": height.max(1),
        "timestamp": unix_now_secs(),
        "env": { "TERM": "xterm-256color" },
        "meta": {
            "recorderId": session_id,
            "sessionId": session_id,
            "connectionId": connection_id,
            "host": host,
        },
    })
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Live recorder for one session. Fed synchronously from the session read
/// loop; `finish` flushes and returns the summary the stop RPC reports.
pub struct SessionRecorder {
    recording_id: String,
    path: PathBuf,
    file: std::io::BufWriter<std::fs::File>,
    started_at: Instant,
    started_at_ms: u64,
    connection_id: String,
    session_id: String,
    host: String,
    events: u64,
    bytes: u64,
}

impl SessionRecorder {
    /// Starts a recording, writing the v2 header. Fails when the recordings
    /// directory cannot be created or the file cannot be opened — callers
    /// surface the error instead of silently dropping output.
    pub fn start(
        data_dir: &Path,
        recording_id: &str,
        connection_id: &str,
        host: &str,
        session_id: &str,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let dir = recordings_dir(data_dir);
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Failed to create recordings directory: {error}"))?;
        let path = dir.join(format!("{recording_id}.cast"));
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("Failed to create recording file: {error}"))?;
        let mut file = std::io::BufWriter::new(file);
        writeln!(
            file,
            "{}",
            header(connection_id, host, session_id, width, height)
        )
        .map_err(|error| format!("Failed to write recording header: {error}"))?;
        Ok(Self {
            recording_id: recording_id.to_string(),
            path,
            file,
            started_at: Instant::now(),
            started_at_ms: unix_now_secs() * 1000,
            connection_id: connection_id.to_string(),
            session_id: session_id.to_string(),
            host: host.to_string(),
            events: 0,
            bytes: 0,
        })
    }

    /// Appends one output burst as an asciicast `o` event. Write errors are
    /// swallowed (the recorder degrades to a truncated recording) — a
    /// failing disk must not kill the terminal stream.
    pub fn observe(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let data = if data.len() > MAX_EVENT_BYTES {
            &data[..MAX_EVENT_BYTES]
        } else {
            data
        };
        let text = String::from_utf8_lossy(data);
        let event = json!({
            "time": self.started_at.elapsed().as_secs_f64(),
            "eventtype": "o",
            "eventdata": text,
        });
        let _ = writeln!(self.file, "{event}");
        self.events += 1;
        self.bytes += data.len() as u64;
    }

    /// Flushes and closes the recording, returning its summary.
    pub fn finish(mut self) -> Result<Value, String> {
        let _ = self.file.flush();
        drop(self.file);
        Ok(json!({
            "recordingId": self.recording_id,
            "sessionId": self.session_id,
            "connectionId": self.connection_id,
            "host": self.host,
            "path": self.path.display().to_string(),
            "startedAt": self.started_at_ms,
            "durationSecs": self.started_at.elapsed().as_secs_f64(),
            "events": self.events,
            "bytes": self.bytes,
        }))
    }
}

/// Resolves the `.cast` path of a recording id, rejecting path traversal —
/// recording ids are sidecar-minted UUIDs, but the RPC boundary validates.
pub fn cast_path(data_dir: &Path, recording_id: &str) -> Result<PathBuf, String> {
    if recording_id.is_empty()
        || recording_id.contains('/')
        || recording_id.contains('\\')
        || recording_id.contains("..")
    {
        return Err("Invalid recording id".to_string());
    }
    Ok(recordings_dir(data_dir).join(format!("{recording_id}.cast")))
}

/// Lists recordings (newest first by file mtime): header line per file +
/// duration read from the last event. Corrupt files are skipped silently.
pub fn list_recordings(data_dir: &Path) -> Vec<Value> {
    let dir = recordings_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items: Vec<(std::time::SystemTime, Value)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("cast") {
            continue;
        }
        let Some(recording_id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Some(item) = describe_recording(&path, &recording_id) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        items.push((modified, item));
    }
    items.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    items.into_iter().map(|(_, item)| item).collect()
}

/// Reads one recording's header and last event into a list row.
fn describe_recording(path: &Path, recording_id: &str) -> Option<Value> {
    let mut lines = std::io::BufReader::new(std::fs::File::open(path).ok()?).lines();
    let first = lines.next()?.ok()?;
    let head: Value = serde_json::from_str(first.trim()).ok()?;
    let meta = head.get("meta").cloned().unwrap_or(json!({}));
    let mut last_time = 0.0_f64;
    let mut last_line = String::new();
    for line in lines {
        match line {
            Ok(text) if !text.trim().is_empty() => {
                last_line = text;
            }
            _ => continue,
        }
    }
    if let Ok(event) = serde_json::from_str::<Value>(last_line.trim()) {
        last_time = event.get("time").and_then(Value::as_f64).unwrap_or(0.0);
    }
    Some(json!({
        "recordingId": recording_id,
        "sessionId": meta.get("sessionId").cloned().unwrap_or(json!("")),
        "connectionId": meta.get("connectionId").cloned().unwrap_or(json!("")),
        "host": meta.get("host").cloned().unwrap_or(json!("")),
        "startedAt": head.get("timestamp").cloned().unwrap_or(json!(0)),
        "durationSecs": last_time,
        "bytes": std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0),
    }))
}

/// Reads one page of events (oldest first) for replay: `offset` counts
/// event lines (header excluded). Returns the events plus `hasMore`.
pub fn read_events(
    data_dir: &Path,
    recording_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    let path = cast_path(data_dir, recording_id)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read recording: {error}"))?;
    let mut total = 0_usize;
    let mut events: Vec<Value> = Vec::new();
    for line in text.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let index = total;
        total += 1;
        if index >= offset && events.len() < limit.min(PAGE_LIMIT) {
            events.push(json!({
                "time": event.get("time").cloned().unwrap_or(json!(0)),
                "type": event.get("eventtype").cloned().unwrap_or(json!("o")),
                "data": event.get("eventdata").cloned().unwrap_or(json!("")),
            }));
        }
    }
    let has_more = offset + events.len() < total;
    Ok(json!({
        "recordingId": recording_id,
        "offset": offset,
        "total": total,
        "hasMore": has_more,
        "events": events,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dbx-session-recording-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn start_observe_finish_writes_asciicast_v2() {
        let dir = temp_dir();
        let mut recorder =
            SessionRecorder::start(&dir, "rec-1", "conn-1", "web-01", "sess-1", 120, 40).unwrap();
        recorder.observe(b"hello ");
        recorder.observe(b"world\n");
        let summary = recorder.finish().unwrap();
        assert_eq!(summary["events"], 2);
        assert_eq!(summary["recordingId"], "rec-1");
        let text = std::fs::read_to_string(recordings_dir(&dir).join("rec-1.cast")).unwrap();
        let mut lines = text.lines();
        let head: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(head["version"], 2);
        assert_eq!(head["width"], 120);
        assert_eq!(head["meta"]["host"], "web-01");
        assert_eq!(head["meta"]["sessionId"], "sess-1");
        let events: Vec<Value> = lines
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["eventtype"], "o");
        assert_eq!(events[0]["eventdata"], "hello ");
        assert_eq!(events[1]["eventdata"], "world\n");
        assert!(events[0]["time"].as_f64().unwrap() <= events[1]["time"].as_f64().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_bursts_and_huge_bursts_are_handled() {
        let dir = temp_dir();
        let mut recorder = SessionRecorder::start(&dir, "rec-2", "c", "h", "s", 80, 24).unwrap();
        recorder.observe(b"");
        let huge = vec![b'x'; MAX_EVENT_BYTES + 4096];
        recorder.observe(&huge);
        let summary = recorder.finish().unwrap();
        assert_eq!(summary["events"], 1, "empty bursts write nothing");
        assert_eq!(summary["bytes"], MAX_EVENT_BYTES as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_reports_headers_and_duration_newest_first() {
        let dir = temp_dir();
        let mut older = SessionRecorder::start(&dir, "rec-a", "c", "h1", "s1", 80, 24).unwrap();
        older.observe(b"one\n");
        older.finish().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut newer = SessionRecorder::start(&dir, "rec-b", "c", "h2", "s2", 80, 24).unwrap();
        newer.observe(b"two\n");
        newer.finish().unwrap();

        let list = list_recordings(&dir);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["recordingId"], "rec-b", "newest first");
        assert_eq!(list[1]["recordingId"], "rec-a");
        assert_eq!(list[1]["host"], "h1");
        assert!(list[1]["startedAt"].as_u64().unwrap() > 0);
        assert!(list[1]["durationSecs"].as_f64().unwrap() >= 0.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_events_paginates_and_counts() {
        let dir = temp_dir();
        let mut recorder = SessionRecorder::start(&dir, "rec-3", "c", "h", "s", 80, 24).unwrap();
        for index in 0..7 {
            recorder.observe(format!("line-{index}\n").as_bytes());
        }
        recorder.finish().unwrap();
        let page = read_events(&dir, "rec-3", 0, 5).unwrap();
        assert_eq!(page["total"], 7);
        assert_eq!(page["events"].as_array().unwrap().len(), 5);
        assert_eq!(page["hasMore"], true);
        let tail = read_events(&dir, "rec-3", 5, 5).unwrap();
        assert_eq!(tail["events"].as_array().unwrap().len(), 2);
        assert_eq!(tail["hasMore"], false);
        assert_eq!(
            tail["events"][1]["data"],
            json!("line-6\n"),
            "event order is oldest first"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cast_path_rejects_traversal() {
        let dir = temp_dir();
        assert!(cast_path(&dir, "../escape").is_err());
        assert!(cast_path(&dir, "a/b").is_err());
        assert!(cast_path(&dir, "").is_err());
        assert!(cast_path(&dir, "ok-uuid").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
