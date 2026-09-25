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
/// Max recordings a single `ssh/recording/search` scan walks — the RPC is an
/// instant on-demand scan over existing files, not a persistent index, so the
/// budget is bounded (task spec: ≤200 recordings).
pub const SEARCH_MAX_RECORDINGS: usize = 200;
/// Max text hits returned per recording (excerpts are small, but the payload
/// must stay bounded).
pub const SEARCH_MAX_HITS: usize = 5;

/// Fast-path `auto_record` flag (mirrors the `x11_forwarding` pattern: an
/// in-process atomic kept in lockstep with the allowlisted preferences.json
/// key; read per `open_session` without re-parsing the file).
static AUTO_RECORD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_auto_record(enabled: bool) {
    AUTO_RECORD.store(enabled, std::sync::atomic::Ordering::Release);
}

pub fn auto_record_enabled() -> bool {
    AUTO_RECORD.load(std::sync::atomic::Ordering::Acquire)
}

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

/// Deletes every `.cast` recording (one-click "clear all" from the workbench).
/// Only `.cast` files inside the recordings dir are touched; a file that
/// cannot be removed (e.g. an in-progress recording still open on Windows)
/// is skipped rather than failing the whole batch. Returns the deleted count.
pub fn clear_recordings(data_dir: &Path) -> usize {
    let dir = recordings_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut deleted = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("cast") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    deleted
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

/// Case-insensitive `contains` over lossy UTF-8 — recordings are terminal
/// output, so matching is byte-folded text, no locale collation.
fn contains_fold(haystack: &str, needle_lower: &str) -> bool {
    haystack.to_lowercase().contains(needle_lower)
}

/// Extracts a display excerpt anchored at the first match in `text`: the
/// matched word always shows in full, up to `max_chars` visible characters
/// follow it, and cut sides get an ellipsis. Pure so tests can pin the output.
fn excerpt_around(text: &str, needle_lower: &str, max_chars: usize) -> String {
    let Some(relative) = text.to_lowercase().find(needle_lower) else {
        return String::new();
    };
    let chars: Vec<char> = text.chars().collect();
    let mut byte_index = 0;
    let mut char_index = 0;
    for (index, ch) in chars.iter().enumerate() {
        if byte_index + ch.len_utf8() > relative {
            char_index = index;
            break;
        }
        byte_index += ch.len_utf8();
        char_index = index + 1;
    }
    const ELLIPSIS: &str = "…";
    let lead = usize::from(char_index > 0);
    let window = max_chars
        .saturating_sub(lead)
        .saturating_sub(1)
        .max(needle_lower.chars().count());
    let start = char_index;
    let end = (char_index + window).min(chars.len());
    let mut out = String::new();
    if lead == 1 {
        out.push_str(ELLIPSIS);
    }
    out.extend(chars[start..end].iter());
    if end < chars.len() {
        out.push_str(ELLIPSIS);
    }
    out
}

/// Builds a single-line flattened text of one event's `eventdata`: ANSI/OSC
/// control sequences are stripped (searching must not miss "ERROR" hidden
/// behind a color escape) and line breaks become spaces so each hit renders
/// as one excerpt line.
fn flatten_event_text(event: &Value) -> String {
    let raw = event.get("eventdata").and_then(Value::as_str).unwrap_or("");
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => {
                // CSI: swallow through the final byte (@-~); OSC: through BEL
                // or ST. Anything else: one following byte max.
                if chars.peek() == Some(&'[') {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                } else if chars.peek() == Some(&']') {
                    chars.next();
                    for next in chars.by_ref() {
                        match next {
                            '\x07' => break,
                            '\x1b' => {
                                // ST 终止符（ESC \）：连反斜杠一起吞掉。
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                }
                                break;
                            }
                            _ => {}
                        }
                    }
                } else {
                    chars.next();
                }
            }
            '\r' => {}
            '\n' | '\t' => out.push(' '),
            other => out.push(other),
        }
    }
    out.trim().to_string()
}

/// Content-only full-text scan of one recording: returns up to
/// `max_hits` `{ time, excerpt }` rows. Excerpt window is the flattened
/// single-line text so hits stay readable in a compact list.
fn search_recording_content(
    path: &Path,
    needle_lower: &str,
    max_hits: usize,
) -> Option<Vec<Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut hits: Vec<Value> = Vec::new();
    let mut truncated = false;
    for line in text.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let flat = flatten_event_text(&event);
        if flat.is_empty() || !contains_fold(&flat, needle_lower) {
            continue;
        }
        if hits.len() >= max_hits {
            truncated = true;
            break;
        }
        hits.push(json!({
            "time": event.get("time").cloned().unwrap_or(json!(0)),
            "excerpt": excerpt_around(&flat, needle_lower, 120),
        }));
    }
    if truncated || !hits.is_empty() {
        Some(hits)
    } else {
        None
    }
}

/// `ssh/recording/search`: instant full-text scan over existing `.cast`
/// recordings (no persistent index; bounded by SEARCH_MAX_RECORDINGS). A hit
/// is a name match (host / recordingId contains `query`, case-insensitive —
/// listed with zero content hits) or a content match (flattened stdout text
/// contains `query`). Newest first, mirroring `list_recordings`. Empty query
/// yields an empty result set — the workbench shows the unfiltered list.
pub fn search_recordings(data_dir: &Path, query: &str) -> Vec<Value> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let dir = recordings_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items: Vec<(std::time::SystemTime, Value)> = Vec::new();
    for entry in entries.flatten().take(SEARCH_MAX_RECORDINGS * 4) {
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
        if items.len() >= SEARCH_MAX_RECORDINGS {
            break;
        }
        let Some(row) = describe_recording(&path, &recording_id) else {
            continue;
        };
        let host = row.get("host").and_then(Value::as_str).unwrap_or("");
        let name_match = contains_fold(host, &needle) || contains_fold(&recording_id, &needle);
        let hits = search_recording_content(&path, &needle, SEARCH_MAX_HITS);
        if !name_match && hits.is_none() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        items.push((
            modified,
            json!({
                "recordingId": recording_id,
                "sessionId": row.get("sessionId").cloned().unwrap_or(json!("")),
                "connectionId": row.get("connectionId").cloned().unwrap_or(json!("")),
                "host": row.get("host").cloned().unwrap_or(json!("")),
                "startedAt": row.get("startedAt").cloned().unwrap_or(json!(0)),
                "durationSecs": row.get("durationSecs").cloned().unwrap_or(json!(0)),
                "bytes": row.get("bytes").cloned().unwrap_or(json!(0)),
                "nameMatch": name_match,
                "hits": hits.unwrap_or_default(),
            }),
        ));
    }
    items.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    items.into_iter().map(|(_, item)| item).collect()
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
    fn clear_recordings_deletes_only_cast_files() {
        let dir = temp_dir();
        let recordings = recordings_dir(&dir);
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::write(recordings.join("a.cast"), "{}").unwrap();
        std::fs::write(recordings.join("b.cast"), "{}").unwrap();
        std::fs::write(recordings.join("keep.txt"), "not a recording").unwrap();
        assert_eq!(clear_recordings(&dir), 2);
        assert!(!recordings.join("a.cast").exists());
        assert!(!recordings.join("b.cast").exists());
        assert!(recordings.join("keep.txt").exists());
        // 目录不存在时安全返回 0。
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(clear_recordings(&dir), 0);
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

    /// Issue #12 回归：「只点击了录制然后终止」产出仅含 header 的录制
    /// （0 事件），必须照常列入列表且可经 RPC 同路径（cast_path + 删文件）
    /// 删除，删除后从列表消失。
    #[test]
    fn header_only_recording_is_listed_and_deletable() {
        let dir = temp_dir();
        let recorder = SessionRecorder::start(&dir, "rec-empty", "c", "h", "s", 80, 24).unwrap();
        recorder.finish().unwrap();

        let list = list_recordings(&dir);
        assert_eq!(
            list.len(),
            1,
            "header-only recording still shows in the list"
        );
        assert_eq!(list[0]["recordingId"], "rec-empty");
        assert_eq!(
            list[0]["durationSecs"], 0.0,
            "no events means zero duration"
        );

        let path = cast_path(&dir, "rec-empty").unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
        assert!(
            list_recordings(&dir).is_empty(),
            "deleted recording leaves the list"
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

    #[test]
    fn flatten_event_text_strips_control_sequences() {
        // 颜色/OSC 控制序列剥掉后命中词才不会被转义符藏起来；换行/制表压成
        // 空格（摘录保持单行），CR 直接丢弃。
        let event =
            json!({ "eventdata": "\x1b[31mER\x1b[0mROR\x1b]0;title\x07: boom\r\nnext\tline" });
        let flat = flatten_event_text(&event);
        assert_eq!(flat, "ERROR: boom next line");
        assert_eq!(flatten_event_text(&json!({ "eventdata": "" })), "");
        // 非法/悬空转义序列也被吞掉，不会把 ESC 泄进摘录。
        assert_eq!(flatten_event_text(&json!({ "eventdata": "a\x1bZb" })), "ab");
    }

    #[test]
    fn excerpt_around_windows_on_match() {
        let text = "aaaaaaaaaa NEEDLE bbbbbbbbbb";
        // 窗口锚定在命中处：命中词完整显示，前面截断带前导省略号。
        assert_eq!(excerpt_around(text, "needle", 12), "…NEEDLE bbb…");
        // 预算足够时命中之后到结尾全部保留，只有前导省略号（窗口锚定命中处）。
        assert_eq!(excerpt_around(text, "needle", 40), "…NEEDLE bbbbbbbbbb");
        assert_eq!(excerpt_around("no match here", "zzz", 10), "");
        // 多字节字符按字符窗口截取，不切半个 code point；命中词保持完整。
        assert_eq!(excerpt_around("你好needle世界", "needle", 9), "…needle世…");
    }

    #[test]
    fn search_matches_name_and_content_newest_first() {
        let dir = temp_dir();
        let mut older = SessionRecorder::start(&dir, "rec-a", "c", "web-01", "s1", 80, 24).unwrap();
        older.observe(b"health check passed\n");
        older.observe(b"failed to start service\n");
        older.observe(b"second health mention\n");
        older.finish().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut newer = SessionRecorder::start(&dir, "rec-b", "c", "db-02", "s2", 80, 24).unwrap();
        newer.observe(b"\x1b[32mHealth Check OK\x1b[0m\n");
        newer.finish().unwrap();
        std::fs::write(recordings_dir(&dir).join("not-a-cast.txt"), "health").unwrap();

        // 内容命中（大小写不敏感 + 转义符后面的词也算）。
        let hits = search_recordings(&dir, "HEALTH");
        assert_eq!(
            hits.len(),
            2,
            "both recordings mention health; newest first"
        );
        assert_eq!(hits[0]["recordingId"], "rec-b");
        assert_eq!(hits[0]["nameMatch"], false);
        let rec_b_hits = hits[0]["hits"].as_array().unwrap();
        assert_eq!(rec_b_hits.len(), 1);
        assert_eq!(rec_b_hits[0]["excerpt"], "Health Check OK");
        let rec_a_hits = hits[1]["hits"].as_array().unwrap();
        assert_eq!(rec_a_hits.len(), 2, "both matching events listed");
        assert_eq!(rec_a_hits[0]["excerpt"], "health check passed");
        assert!(rec_a_hits[0]["time"].as_f64().unwrap() <= rec_a_hits[1]["time"].as_f64().unwrap());

        // 名称命中：host 包含查询词即可，即使内容不匹配也列出（hits 空）。
        let by_host = search_recordings(&dir, "db-0");
        assert_eq!(by_host.len(), 1);
        assert_eq!(by_host[0]["recordingId"], "rec-b");
        assert_eq!(by_host[0]["nameMatch"], true);

        let by_id = search_recordings(&dir, "REC-A");
        assert_eq!(by_id.len(), 1);
        assert_eq!(by_id[0]["nameMatch"], true);

        // 空查询/无命中：空集。
        assert!(search_recordings(&dir, "").is_empty());
        assert!(search_recordings(&dir, "zzz-not-present").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_caps_hits_and_respects_missing_dir() {
        let dir = temp_dir();
        let mut recorder = SessionRecorder::start(&dir, "rec-cap", "c", "h", "s", 80, 24).unwrap();
        for index in 0..(SEARCH_MAX_HITS + 3) {
            recorder.observe(format!("oops {index}\n").as_bytes());
        }
        recorder.finish().unwrap();
        let hits = search_recordings(&dir, "oops");
        assert_eq!(hits.len(), 1);
        let rows = hits[0]["hits"].as_array().unwrap();
        assert_eq!(rows.len(), SEARCH_MAX_HITS);
        // 不存在的目录安全返回空。
        assert!(search_recordings(&temp_dir(), "oops").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_record_flag_round_trips() {
        set_auto_record(true);
        assert!(auto_record_enabled());
        set_auto_record(false);
        assert!(!auto_record_enabled());
    }
}
