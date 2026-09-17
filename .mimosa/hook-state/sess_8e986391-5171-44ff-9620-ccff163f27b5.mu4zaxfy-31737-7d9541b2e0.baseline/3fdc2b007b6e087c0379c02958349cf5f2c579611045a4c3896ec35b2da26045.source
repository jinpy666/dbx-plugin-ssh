//! Append-only JSONL execution audit trail (`<data_dir>/audit-log.jsonl`) for
//! the MCP/AI execution plane. The audited surface is exactly the one the sudo
//! allowlist governs: every gated tool call (gate verdict, approval-lifecycle
//! outcome, exit code, duration, execution mode) plus approval lifecycle
//! events (prompt / approved / denied / timeout / remembered). Manual
//! workbench operations — interactive terminal typing, SFTP browsing, the
//! sudo file panel — are deliberately NOT recorded (IMPL_PLAN §0 non-goals).
//!
//! Cross-process semantics (decision D5): the embedded sidecar and the stdio
//! `--mcp` process share one data directory, so each entry is written with a
//! fresh open-append-close cycle and a single `write_all` of `json + "\n"` —
//! one `O_APPEND` write per line keeps concurrent inter-process appends
//! line-atomic. A process-local `Mutex` serializes the size-check + rotation
//! within a single process; inter-process races fall back to the O_APPEND
//! guarantee.
//!
//! Rotation: before each append, when the file has reached [`ROTATE_BYTES`]
//! (5 MiB) it is renamed to `audit-log.jsonl.1` (one retained generation; a
//! failed rename is ignored so writing never blocks). Reading (`tail`) skips
//! malformed lines, so a torn trailing line from a crash can never break
//! replay. `error` text is clamped before writing to keep worst-case lines
//! small (long command text is already clamped upstream).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Rotation threshold: a single audit file caps at 5 MiB before rolling to
/// `audit-log.jsonl.1`.
pub const ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// Hard cap applied to `tail`'s `limit` regardless of caller input (the
/// protocol `ssh/audit/list` contract is limit ∈ [1, 500], enforced there;
/// this clamps defensively).
const TAIL_LIMIT_CAP: usize = 500;

/// Cap of the `error` field, in characters, applied before writing.
const MAX_ERROR_CHARS: usize = 1024;

/// Cap of the `command` field, in characters, applied before writing.
const MAX_COMMAND_CHARS: usize = 512;

/// Cap of the `output` field, in characters, applied before writing. The
/// audit ledger is a replay of *what ran*, not a full transcript: a tail of
/// the output is enough to see what a command did.
const MAX_OUTPUT_CHARS: usize = 1024;

/// Which branch of the existing exec gate sequence produced this entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateOutcome {
    /// All gates passed; the command ran.
    Pass,
    /// Write tool refused (read-only / write-disabled policy).
    WriteDenied,
    /// Command rejected by the sudo allowlist match gate.
    WhitelistDenied,
    /// Command touched a sensitive path.
    SensitivePath,
    /// Destructive command without a confirmed token.
    DestructiveUnconfirmed,
    /// Sudo command rejected by the sudo allowlist gate.
    SudoAllowlistDenied,
    /// Server advertises read-only.
    ReadOnlyServer,
}

/// Approval lifecycle trail for the entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalTrail {
    /// No approval interaction happened (auto-run, or refused by a gate).
    None,
    /// An approval prompt was raised (final decision carried elsewhere).
    Prompt,
    /// Approved by the human.
    Approved,
    /// Denied by the human.
    Denied,
    /// Prompt unanswered until timeout (treated as refusal).
    Timeout,
    /// Admitted by the remembered-commands allowlist (no prompt).
    Remembered,
}

/// Terminal result of the audited action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryOutcome {
    Ok,
    Error,
}

/// Execution channel the action used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecMode {
    /// Hidden stdio channel (plain ssh_exec).
    Stdio,
    /// Embedded sidecar MCP process.
    Embedded,
    /// Injected into the user's workbench terminal.
    Terminal,
}

/// One audit record. Serde shape is the `ssh/audit/list` entry contract:
/// camelCase keys, enum string values exactly as in PROTOCOL, and `None`
/// serialized as `null` (no `skip_serializing_if`) so every line keeps the
/// same shape. `command`/`output` carry the audited command text and its
/// (truncated) result — clamped at both the write sites and in [`append`].
#[derive(Debug, Clone, PartialEq)]
pub struct AuditEntry {
    pub ts_ms: u64,
    pub tool: String,
    pub connection_id: String,
    pub gate: GateOutcome,
    pub approval: ApprovalTrail,
    pub outcome: EntryOutcome,
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    pub mode: ExecMode,
    pub command: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
}

impl GateOutcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Pass => "pass",
            Self::WriteDenied => "write-denied",
            Self::WhitelistDenied => "whitelist-denied",
            Self::SensitivePath => "sensitive-path",
            Self::DestructiveUnconfirmed => "destructive-unconfirmed",
            Self::SudoAllowlistDenied => "sudo-allowlist-denied",
            Self::ReadOnlyServer => "read-only-server",
        }
    }
}

impl ApprovalTrail {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Prompt => "prompt",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Timeout => "timeout",
            Self::Remembered => "remembered",
        }
    }
}

impl EntryOutcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
        }
    }
}

impl ExecMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Embedded => "embedded",
            Self::Terminal => "terminal",
        }
    }
}

// The serde impls are hand-rolled around the `name()` accessors instead of
// `#[serde(rename)]` so the wire strings live in exactly one place per enum
// (the protocol contract strings must never drift between the two paths).

impl serde::Serialize for GateOutcome {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> serde::Deserialize<'de> for GateOutcome {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_name(&text).ok_or_else(|| {
            serde::de::Error::unknown_variant(
                &text,
                &[
                    "pass",
                    "write-denied",
                    "whitelist-denied",
                    "sensitive-path",
                    "destructive-unconfirmed",
                    "sudo-allowlist-denied",
                    "read-only-server",
                ],
            )
        })
    }
}

impl serde::Serialize for ApprovalTrail {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> serde::Deserialize<'de> for ApprovalTrail {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_name(&text).ok_or_else(|| {
            serde::de::Error::unknown_variant(
                &text,
                &[
                    "none",
                    "prompt",
                    "approved",
                    "denied",
                    "timeout",
                    "remembered",
                ],
            )
        })
    }
}

impl serde::Serialize for EntryOutcome {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> serde::Deserialize<'de> for EntryOutcome {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_name(&text)
            .ok_or_else(|| serde::de::Error::unknown_variant(&text, &["ok", "error"]))
    }
}

impl serde::Serialize for ExecMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.name())
    }
}

impl<'de> serde::Deserialize<'de> for ExecMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::from_name(&text).ok_or_else(|| {
            serde::de::Error::unknown_variant(&text, &["stdio", "embedded", "terminal"])
        })
    }
}

impl GateOutcome {
    fn from_name(text: &str) -> Option<Self> {
        Some(match text {
            "pass" => Self::Pass,
            "write-denied" => Self::WriteDenied,
            "whitelist-denied" => Self::WhitelistDenied,
            "sensitive-path" => Self::SensitivePath,
            "destructive-unconfirmed" => Self::DestructiveUnconfirmed,
            "sudo-allowlist-denied" => Self::SudoAllowlistDenied,
            "read-only-server" => Self::ReadOnlyServer,
            _ => return None,
        })
    }
}

impl ApprovalTrail {
    fn from_name(text: &str) -> Option<Self> {
        Some(match text {
            "none" => Self::None,
            "prompt" => Self::Prompt,
            "approved" => Self::Approved,
            "denied" => Self::Denied,
            "timeout" => Self::Timeout,
            "remembered" => Self::Remembered,
            _ => return None,
        })
    }
}

impl EntryOutcome {
    fn from_name(text: &str) -> Option<Self> {
        Some(match text {
            "ok" => Self::Ok,
            "error" => Self::Error,
            _ => return None,
        })
    }
}

impl ExecMode {
    fn from_name(text: &str) -> Option<Self> {
        Some(match text {
            "stdio" => Self::Stdio,
            "embedded" => Self::Embedded,
            "terminal" => Self::Terminal,
            _ => return None,
        })
    }
}

/// Serialize by hand (explicit camelCase keys, `None` → `null`) so the wire
/// shape is pinned in one place instead of depending on derive attributes.
impl serde::Serialize for AuditEntry {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AuditEntry", 12)?;
        state.serialize_field("tsMs", &self.ts_ms)?;
        state.serialize_field("tool", &self.tool)?;
        state.serialize_field("connectionId", &self.connection_id)?;
        state.serialize_field("gate", &self.gate)?;
        state.serialize_field("approval", &self.approval)?;
        state.serialize_field("outcome", &self.outcome)?;
        state.serialize_field("exitCode", &self.exit_code)?;
        state.serialize_field("durationMs", &self.duration_ms)?;
        state.serialize_field("mode", &self.mode)?;
        state.serialize_field("command", &self.command)?;
        state.serialize_field("output", &self.output)?;
        state.serialize_field("error", &self.error)?;
        state.end()
    }
}

/// Deserialize through a camelCase-named bridge struct; all fields required
/// (missing `exitCode`/`error` is a bad line, skipped by `tail`). The newer
/// `command`/`output` fields default to `None` so pre-0.4.77 lines (which
/// never carried them) keep replaying.
impl<'de> serde::Deserialize<'de> for AuditEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            ts_ms: u64,
            tool: String,
            connection_id: String,
            gate: GateOutcome,
            approval: ApprovalTrail,
            outcome: EntryOutcome,
            exit_code: Option<i64>,
            duration_ms: u64,
            mode: ExecMode,
            #[serde(default)]
            command: Option<String>,
            #[serde(default)]
            output: Option<String>,
            error: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            ts_ms: wire.ts_ms,
            tool: wire.tool,
            connection_id: wire.connection_id,
            gate: wire.gate,
            approval: wire.approval,
            outcome: wire.outcome,
            exit_code: wire.exit_code,
            duration_ms: wire.duration_ms,
            mode: wire.mode,
            command: wire.command,
            output: wire.output,
            error: wire.error,
        })
    }
}

/// Audit file path inside the plugin data directory.
pub fn audit_path(data_dir: &Path) -> PathBuf {
    data_dir.join("audit-log.jsonl")
}

/// Rotated generation (single retained predecessor).
fn rotated_path(data_dir: &Path) -> PathBuf {
    data_dir.join("audit-log.jsonl.1")
}

/// Process-local serialization of the size-check + rotate + append sequence.
/// Cross-process safety comes from the O_APPEND single-write discipline, not
/// from this lock.
fn append_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Appends one entry as a single JSONL line. Rotates a full file first. The
/// in-process mutex serializes rotation + append; the open-append-close per
/// call keeps inter-process (embedded sidecar vs stdio `--mcp`) writes
/// line-atomic via O_APPEND (decision D5).
pub fn append(data_dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    if let Some(parent) = data_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let path = audit_path(data_dir);
    let _guard = append_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() >= ROTATE_BYTES {
            // Overwrite the previous generation; ignore failures — a stuck
            // rotation must never block auditing.
            let _ = std::fs::rename(&path, rotated_path(data_dir));
        }
    }
    // Clamp before writing so one bad string cannot blow up the line.
    let mut clamped = entry.clone();
    if let Some(error) = clamped.error.take() {
        clamped.error = Some(error.chars().take(MAX_ERROR_CHARS).collect());
    }
    if let Some(command) = clamped.command.take() {
        clamped.command = Some(command.chars().take(MAX_COMMAND_CHARS).collect());
    }
    if let Some(output) = clamped.output.take() {
        clamped.output = Some(output.chars().take(MAX_OUTPUT_CHARS).collect());
    }
    let mut line = serde_json::to_string(&clamped)
        .map_err(|error| format!("Failed to encode audit entry: {error}"))?;
    line.push('\n');
    // Fresh open-append-close per entry (decision D5).
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(())
}

/// Reads the newest entries in file order (oldest → newest). Malformed lines
/// are skipped; a missing file yields an empty list. `before_ts_ms` keeps
/// strictly older entries (`ts_ms < before_ts_ms`); `limit` is clamped to
/// [`TAIL_LIMIT_CAP`] (the caller owns the protocol [1, 500] validation).
pub fn tail(
    data_dir: &Path,
    limit: usize,
    before_ts_ms: Option<u64>,
) -> Result<Vec<AuditEntry>, String> {
    let path = audit_path(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let limit = limit.min(TAIL_LIMIT_CAP);
    let mut entries: Vec<AuditEntry> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<AuditEntry>(line) {
            Ok(entry) => {
                if before_ts_ms.is_some_and(|before| entry.ts_ms >= before) {
                    continue;
                }
                entries.push(entry);
            }
            // Bad lines (torn writes, older shapes) never break replay.
            Err(_) => continue,
        }
    }
    if entries.len() > limit {
        let drop = entries.len() - limit;
        entries.drain(..drop);
    }
    Ok(entries)
}

/// Clears the audit ledger: truncates the active JSONL to empty and drops
/// the rotated generation. The file itself is kept (mode/mask intact) so a
/// concurrent O_APPEND appender never sees a missing file; entries appended
/// after the clear naturally start the new generation. Used by the
/// workbench settings「审计日志」清空按钮 via `ssh/audit/clear`.
pub fn clear(data_dir: &Path) -> Result<(), String> {
    let _guard = append_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = audit_path(data_dir);
    std::fs::write(&path, b"")
        .map_err(|error| format!("Failed to clear {}: {error}", path.display()))?;
    let _ = std::fs::remove_file(rotated_path(data_dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-audit-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_entry(ts_ms: u64) -> AuditEntry {
        AuditEntry {
            ts_ms,
            tool: "ssh_exec".to_string(),
            connection_id: "conn-1".to_string(),
            gate: GateOutcome::Pass,
            approval: ApprovalTrail::None,
            outcome: EntryOutcome::Ok,
            exit_code: Some(0),
            duration_ms: 12,
            mode: ExecMode::Embedded,
            command: Some("echo hi".to_string()),
            output: Some("hi".to_string()),
            error: None,
        }
    }

    #[test]
    fn clear_truncates_active_and_drops_rotated_generation() {
        let dir = temp_dir("clear");
        append(&dir, &sample_entry(1)).unwrap();
        append(&dir, &sample_entry(2)).unwrap();
        // Simulate a rotated predecessor from an earlier fill.
        std::fs::write(rotated_path(&dir), b"{\"stale\":true}\n").unwrap();
        clear(&dir).unwrap();
        assert!(tail(&dir, 100, None).unwrap().is_empty());
        assert!(
            !rotated_path(&dir).exists(),
            "rotated generation must be dropped"
        );
        // Appends after a clear start the new generation cleanly.
        append(&dir, &sample_entry(3)).unwrap();
        assert_eq!(tools(&tail(&dir, 100, None).unwrap()), vec!["ssh_exec"]);
        // Clear on a missing file is a no-op success.
        let empty = temp_dir("clear-empty");
        clear(&empty).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    fn tools(entries: &[AuditEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.tool.as_str()).collect()
    }

    #[test]
    fn gate_strings_match_the_protocol_contract() {
        let cases = [
            (GateOutcome::Pass, "pass"),
            (GateOutcome::WriteDenied, "write-denied"),
            (GateOutcome::WhitelistDenied, "whitelist-denied"),
            (GateOutcome::SensitivePath, "sensitive-path"),
            (
                GateOutcome::DestructiveUnconfirmed,
                "destructive-unconfirmed",
            ),
            (GateOutcome::SudoAllowlistDenied, "sudo-allowlist-denied"),
            (GateOutcome::ReadOnlyServer, "read-only-server"),
        ];
        for (value, text) in cases {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                serde_json::json!(text)
            );
        }
    }

    #[test]
    fn approval_outcome_mode_strings_match_the_protocol_contract() {
        let approvals = [
            (ApprovalTrail::None, "none"),
            (ApprovalTrail::Prompt, "prompt"),
            (ApprovalTrail::Approved, "approved"),
            (ApprovalTrail::Denied, "denied"),
            (ApprovalTrail::Timeout, "timeout"),
            (ApprovalTrail::Remembered, "remembered"),
        ];
        for (value, text) in approvals {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                serde_json::json!(text)
            );
        }
        for (value, text) in [(EntryOutcome::Ok, "ok"), (EntryOutcome::Error, "error")] {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                serde_json::json!(text)
            );
        }
        for (value, text) in [
            (ExecMode::Stdio, "stdio"),
            (ExecMode::Embedded, "embedded"),
            (ExecMode::Terminal, "terminal"),
        ] {
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                serde_json::json!(text)
            );
        }
    }

    #[test]
    fn entry_serializes_the_exact_wire_shape() {
        let entry = sample_entry(1_730_000_000_000);
        // Key set (`to_value`'s map is unordered, so compare sorted).
        let value = serde_json::to_value(&entry).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "approval",
                "command",
                "connectionId",
                "durationMs",
                "error",
                "exitCode",
                "gate",
                "mode",
                "outcome",
                "output",
                "tool",
                "tsMs"
            ]
        );
        let object = serde_json::to_value(&entry).unwrap();
        assert_eq!(object["exitCode"], 0);
        assert_eq!(object["error"], serde_json::Value::Null, "None stays null");
        // Field order on the actual JSONL line the audit file stores.
        let line = serde_json::to_string(&entry).unwrap();
        let mut cursor = 0;
        for key in [
            "\"tsMs\":",
            "\"tool\":",
            "\"connectionId\":",
            "\"gate\":",
            "\"approval\":",
            "\"outcome\":",
            "\"exitCode\":",
            "\"durationMs\":",
            "\"mode\":",
            "\"command\":",
            "\"output\":",
            "\"error\":",
        ] {
            let at = line[cursor..]
                .find(key)
                .unwrap_or_else(|| panic!("{key} missing or out of order in {line}"));
            cursor += at + key.len();
        }
    }

    #[test]
    fn append_then_tail_roundtrips_every_field() {
        let dir = temp_dir("roundtrip");
        append(&dir, &sample_entry(1_000)).unwrap();
        let mut denied = sample_entry(2_000);
        denied.tool = "ssh_exec_sudo".to_string();
        denied.connection_id = "conn-2".to_string();
        denied.gate = GateOutcome::DestructiveUnconfirmed;
        denied.approval = ApprovalTrail::Denied;
        denied.outcome = EntryOutcome::Error;
        denied.exit_code = None;
        denied.duration_ms = 340;
        denied.mode = ExecMode::Terminal;
        denied.command = Some("rm -rf /tmp/scratch".to_string());
        denied.output = None;
        denied.error = Some("needs confirmation".to_string());
        append(&dir, &denied).unwrap();

        let entries = tail(&dir, 10, None).unwrap();
        assert_eq!(entries.len(), 2);
        let (first, second) = (&entries[0], &entries[1]);
        assert_eq!(first.ts_ms, 1_000);
        assert_eq!(first.tool, "ssh_exec");
        assert_eq!(first.connection_id, "conn-1");
        assert_eq!(first.gate, GateOutcome::Pass);
        assert_eq!(first.approval, ApprovalTrail::None);
        assert_eq!(first.outcome, EntryOutcome::Ok);
        assert_eq!(first.exit_code, Some(0));
        assert_eq!(first.duration_ms, 12);
        assert_eq!(first.mode, ExecMode::Embedded);
        assert_eq!(first.command.as_deref(), Some("echo hi"));
        assert_eq!(first.output.as_deref(), Some("hi"));
        assert_eq!(first.error, None);

        assert_eq!(second.ts_ms, 2_000);
        assert_eq!(second.tool, "ssh_exec_sudo");
        assert_eq!(second.connection_id, "conn-2");
        assert_eq!(second.gate, GateOutcome::DestructiveUnconfirmed);
        assert_eq!(second.approval, ApprovalTrail::Denied);
        assert_eq!(second.outcome, EntryOutcome::Error);
        assert_eq!(second.exit_code, None, "None survives as null");
        assert_eq!(second.duration_ms, 340);
        assert_eq!(second.mode, ExecMode::Terminal);
        assert_eq!(second.command.as_deref(), Some("rm -rf /tmp/scratch"));
        assert_eq!(second.output, None);
        assert_eq!(second.error.as_deref(), Some("needs confirmation"));

        // Raw line keeps nulls in place (stable row shape).
        let raw = std::fs::read_to_string(audit_path(&dir)).unwrap();
        assert!(raw.contains("\"exitCode\":null"));
        assert!(raw.contains("\"error\":null"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_filters_by_ts_and_takes_the_newest_limit() {
        let dir = temp_dir("filter");
        for ts in 1..=6u64 {
            let mut entry = sample_entry(ts * 1_000);
            entry.tool = format!("t{ts}");
            append(&dir, &entry).unwrap();
        }
        // Newest N, still oldest → newest inside the window.
        assert_eq!(tools(&tail(&dir, 2, None).unwrap()), ["t5", "t6"]);
        // before_ts is exclusive: t4 (ts 4000) is not < 4000.
        assert_eq!(
            tools(&tail(&dir, 500, Some(4_000)).unwrap()),
            ["t1", "t2", "t3"]
        );
        assert!(tail(&dir, 0, None).unwrap().is_empty());
        assert_eq!(tail(&dir, 500, None).unwrap().len(), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_skips_malformed_and_partial_lines() {
        let dir = temp_dir("badlines");
        append(&dir, &sample_entry(1_000)).unwrap();
        let path = audit_path(&dir);
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{not json\n");
        text.push('\n');
        text.push_str("{\"tsMs\":2000,\"tool\":\"orphan\"}\n");
        std::fs::write(&path, text).unwrap();
        append(&dir, &sample_entry(3_000)).unwrap();

        let entries = tail(&dir, 500, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].ts_ms, 1_000);
        assert_eq!(entries[1].ts_ms, 3_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_on_missing_file_yields_empty() {
        let dir = temp_dir("missing");
        assert!(tail(&dir, 10, None).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_clamps_long_error_text() {
        let dir = temp_dir("clamp");
        let mut entry = sample_entry(1_000);
        entry.outcome = EntryOutcome::Error;
        entry.error = Some("e".repeat(4_096));
        append(&dir, &entry).unwrap();
        let loaded = tail(&dir, 10, None).unwrap();
        let error = loaded[0].error.as_deref().unwrap();
        assert_eq!(error.chars().count(), MAX_ERROR_CHARS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_clamps_command_and_output_text() {
        let dir = temp_dir("clamp-cmd");
        let mut entry = sample_entry(1_000);
        entry.command = Some("c".repeat(2_048));
        entry.output = Some("o".repeat(4_096));
        append(&dir, &entry).unwrap();
        let loaded = tail(&dir, 10, None).unwrap();
        assert_eq!(
            loaded[0]
                .command
                .as_deref()
                .map(str::chars)
                .map(Iterator::count),
            Some(MAX_COMMAND_CHARS)
        );
        assert_eq!(
            loaded[0]
                .output
                .as_deref()
                .map(str::chars)
                .map(Iterator::count),
            Some(MAX_OUTPUT_CHARS)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_lines_without_command_output_still_replay() {
        // 0.4.77 之前的行没有 command/output 字段：tail 必须继续回放（缺省
        // 为 null），老审计文件不能因为新字段作废。
        let dir = temp_dir("legacy");
        let path = audit_path(&dir);
        std::fs::write(
            &path,
            "{\"tsMs\":1000,\"tool\":\"ssh_exec\",\"connectionId\":\"conn-1\",\"gate\":\"pass\",\"approval\":\"none\",\"outcome\":\"ok\",\"exitCode\":0,\"durationMs\":12,\"mode\":\"embedded\",\"error\":null}\n",
        )
        .unwrap();
        let entries = tail(&dir, 10, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].command, None);
        assert_eq!(entries[0].output, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_file_rotates_and_the_fresh_file_keeps_the_new_entry() {
        let dir = temp_dir("rotate");
        let path = audit_path(&dir);
        // Fill with ≥ ROTATE_BYTES of padding (garbage lines are fine).
        std::fs::write(&path, vec![b'x'; (ROTATE_BYTES + 1_024) as usize]).unwrap();
        append(&dir, &sample_entry(5_000)).unwrap();

        let rotated = std::fs::metadata(rotated_path(&dir)).unwrap();
        assert!(rotated.len() >= ROTATE_BYTES, "old generation preserved");
        let fresh = std::fs::read_to_string(&path).unwrap();
        assert!(
            fresh.contains("\"tool\":\"ssh_exec\""),
            "new file holds the entry"
        );
        // The padding was not valid JSON, so tail sees only the new entry.
        let entries = tail(&dir, 500, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ts_ms, 5_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_appends_within_one_process_all_land() {
        let dir = temp_dir("concurrent");
        let dir = std::sync::Arc::new(dir);
        let mut handles = Vec::new();
        for thread_index in 0..8u32 {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                for index in 0..10u32 {
                    let mut entry = sample_entry(1_000 + (thread_index * 100 + index) as u64);
                    entry.tool = format!("tool-{thread_index}-{index}");
                    append(&dir, &entry).unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let entries = tail(&dir, 500, None).unwrap();
        assert_eq!(entries.len(), 80, "every append survives");
        let mut names: Vec<&str> = entries.iter().map(|e| e.tool.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 80, "no line torn into another");
        let _ = std::fs::remove_dir_all(&*dir);
    }
}
