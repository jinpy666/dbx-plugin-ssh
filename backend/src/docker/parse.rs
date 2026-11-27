use serde::Serialize;
use serde_json::{json, Value};

use super::scripts::PS_LEGACY_MARKER;

// —— Parsing (pure, fixture-tested) ———————————————————————

/// One row of `docker ps -a --format` (tab-separated, NyaTerm field set).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

/// Extracts the text between two exact marker lines (end marker optional —
/// everything after the start marker is returned). Exact whole-line
/// equality on both ends; the sentinel names are unusual enough that a
/// container log echoing them stays a documented corner case.
fn marker_section<'a>(output: &'a str, start: &str, end: Option<&str>) -> &'a str {
    let mut cursor = 0usize;
    let mut begin: Option<usize> = None;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim();
        if let Some(start_at) = begin {
            if Some(trimmed) == end {
                return &output[start_at..cursor];
            }
        } else if trimmed == start {
            begin = Some(cursor + line.len());
        }
        cursor += line.len();
    }
    match begin {
        Some(start_at) => &output[start_at..],
        None => "",
    }
}

/// Probe verdict for one host: docker CLI present, daemon reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Probe {
    pub docker_found: bool,
    pub daemon_ok: bool,
}

/// Parses the `DBXDOCKER_PROBE` section (two self-describing lines).
pub fn parse_probe(output: &str) -> Probe {
    let mut probe = Probe::default();
    for line in marker_section(output, "DBXDOCKER_PROBE", Some("DBXDOCKER_PS")).lines() {
        match line.trim() {
            "docker-found" => probe.docker_found = true,
            "daemon-ok" => probe.daemon_ok = true,
            _ => {}
        }
    }
    probe
}

/// Parses the tab-separated `docker ps` section. Malformed rows (wrong
/// column count, empty ids) are skipped line by line — one bad row must
/// never hide the rest of the list.
pub fn parse_ps_section(section: &str) -> Vec<ContainerRow> {
    let mut rows = Vec::new();
    for line in section.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 7 || fields[0].trim().is_empty() {
            continue;
        }
        rows.push(ContainerRow {
            id: fields[0].trim().to_string(),
            name: fields[1].trim().to_string(),
            image: fields[2].trim().to_string(),
            state: fields[3].trim().to_string(),
            status: fields[4].trim().to_string(),
            ports: fields[5].trim().to_string(),
            created_at: fields[6].trim().to_string(),
        });
    }
    rows
}

/// Derives the machine state from the human Status text of a pre-1.13
/// `docker ps` row (no `.State` column): "Up 3 hours" → running,
/// "Exited (0) 2 days ago" → exited, and so on. Unrecognized text degrades
/// to "unknown" — the panel's state badge, not control flow, consumes it.
pub(super) fn legacy_state_from_status(status: &str) -> String {
    let status = status.trim();
    let lowered = status.to_ascii_lowercase();
    if lowered.starts_with("up") {
        // Paused containers render "Up 2 hours (Paused)".
        if lowered.contains("(paused)") {
            return "paused".to_string();
        }
        return "running".to_string();
    }
    if lowered.starts_with("exited") {
        return "exited".to_string();
    }
    if lowered.starts_with("created") {
        return "created".to_string();
    }
    if lowered.starts_with("restarting") {
        return "restarting".to_string();
    }
    if lowered.starts_with("dead") {
        return "dead".to_string();
    }
    if lowered.starts_with("removing") {
        return "removing".to_string();
    }
    "unknown".to_string()
}

/// Parses the pre-1.13 fallback section (6 tab-separated columns — no
/// State). Same malformed-row tolerance as [`parse_ps_section`].
pub fn parse_ps_section_legacy(section: &str) -> Vec<ContainerRow> {
    let mut rows = Vec::new();
    for line in section.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 6 || fields[0].trim().is_empty() {
            continue;
        }
        let status = fields[3].trim().to_string();
        rows.push(ContainerRow {
            id: fields[0].trim().to_string(),
            name: fields[1].trim().to_string(),
            image: fields[2].trim().to_string(),
            state: legacy_state_from_status(&status),
            status,
            ports: fields[4].trim().to_string(),
            created_at: fields[5].trim().to_string(),
        });
    }
    rows
}

/// Assembles the `docker/list` payload from raw script output:
/// `{available, needsSudo, containers}`. `needsSudo` is the found-but-
/// denied combination (docker CLI present, daemon socket refused) — the
/// actions still have a path via the Quick Sudo fallback. A
/// [`PS_LEGACY_MARKER`] inside the ps section splits off the pre-1.13
/// fallback rows (6 columns, state derived from Status text).
pub fn list_payload(output: &str) -> Value {
    let probe = parse_probe(output);
    let available = probe.docker_found && probe.daemon_ok;
    let needs_sudo = probe.docker_found && !probe.daemon_ok;
    let section = marker_section(output, "DBXDOCKER_PS", None);
    let (modern, legacy) = match section.find(PS_LEGACY_MARKER) {
        Some(index) => (
            &section[..index],
            Some(&section[index + PS_LEGACY_MARKER.len()..]),
        ),
        None => (section, None),
    };
    let mut containers = parse_ps_section(modern);
    if let Some(legacy_section) = legacy {
        containers.extend(parse_ps_section_legacy(legacy_section));
    }
    json!({
        "available": available,
        "needsSudo": needs_sudo,
        "containers": containers,
    })
}

/// Key fields projected out of one `docker inspect` JSON document.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InspectSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub running: bool,
    pub started_at: String,
    pub health: Option<String>,
    pub restart_policy: String,
}

/// Parses `docker inspect` output (a JSON array; the first element wins)
/// into the summary. Missing/absent fields degrade to defaults so a
/// truncated or exotic inspect document never fails the logs view.
pub fn parse_inspect_output(text: &str) -> Option<InspectSummary> {
    let parsed: Value = serde_json::from_str(text.trim()).ok()?;
    let container = parsed.as_array()?.first()?;
    let state = container.get("State");
    let string_at = |pointer: &str| -> String {
        container
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Some(InspectSummary {
        id: string_at("/Id"),
        name: string_at("/Name").trim_start_matches('/').to_string(),
        image: string_at("/Config/Image"),
        status: state
            .and_then(|state| state.get("Status"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        running: state
            .and_then(|state| state.get("Running"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        started_at: state
            .and_then(|state| state.get("StartedAt"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        health: state
            .and_then(|state| state.get("Health"))
            .and_then(|health| health.get("Status"))
            .and_then(Value::as_str)
            .map(str::to_string),
        restart_policy: container
            .pointer("/HostConfig/RestartPolicy/Name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// Assembles the `docker/logs` payload: `{logs, container}` where
/// `container` is the optional inspect summary (null when inspect failed,
/// e.g. the container vanished between list and logs).
pub fn logs_payload(output: &str) -> Value {
    let inspect_text = marker_section(output, "DBXDOCKER_INSPECT", Some("DBXDOCKER_LOGS"));
    let logs = marker_section(output, "DBXDOCKER_LOGS", None);
    json!({
        "logs": logs,
        "container": parse_inspect_output(inspect_text),
    })
}

/// True when a failed plain run is the docker-daemon socket permission
/// error — the only failure shape that justifies the sudo fallback. Every
/// other failure must stay terminal: retrying a half-executed action with
/// sudo could double-apply a state change.
pub fn is_daemon_permission_failure(exit_code: i32, output: &str) -> bool {
    exit_code != 0 && output.to_ascii_lowercase().contains("permission denied")
}

/// Readable error when even the Quick Sudo fallback failed; points at the
/// configuration surface instead of leaking raw sudo noise.
pub fn sudo_fallback_error(error: String) -> String {
    format!(
        "{error}. Docker actions need daemon permission: add the user to the \
         docker group on the host, or configure Quick Sudo for this connection \
         (connection settings > Quick Sudo) so the panel can elevate."
    )
}
