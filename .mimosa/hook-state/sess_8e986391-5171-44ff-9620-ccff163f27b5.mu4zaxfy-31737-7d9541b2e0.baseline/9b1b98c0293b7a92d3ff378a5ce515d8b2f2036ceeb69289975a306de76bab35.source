//! Alert triage: structured normalization + keyword classification +
//! whitelist-safe diagnostic command suggestions.
//!
//! Positioning is deliberately narrow: this module performs NO LLM analysis.
//! Triage = (1) normalize a heterogeneous alert payload into a fixed shape,
//! (2) classify it into one of eight categories via bilingual keyword scoring,
//! (3) emit read-only diagnostic commands. The reasoning about *why* the alert
//! fired is left to the external caller (ZCode, an operator); the plugin is a
//! tool surface, not an agent.
//!
//! Compatibility semantics come from openocta's `/hooks/alert` standardization:
//! a payload that parses as JSON is read field-wise (`alertId`/`alert_id`,
//! `title`, `message`, `severity`, `source`, object `data`); when the parsed
//! `message` is empty — or the payload does not parse as JSON at all, which
//! covers plain-text alerts — the entire payload text becomes the message.
//!
//! Hard constraint (decision D6, pinned by unit tests): every command emitted
//! by [`playbook`] — including the service group with a substituted unit name
//! — must satisfy `mcp_safety::assess_command(cmd) == CommandRisk::ReadOnly`,
//! so the suggestions can pass the plugin's own read-only gate untouched.
//! Suggestions never contain redirection, command substitution, `sudo`, or
//! write verbs. The initial draft's `top -b -n 1 | head -20` was dropped
//! because `top` is not a whitelisted verb (its information is covered by
//! `ps aux --sort=-%cpu` and `vmstat`). To keep D6 true for hostile inputs,
//! [`extract_service`] rejects unit candidates that reference a sensitive
//! path, which would otherwise downgrade `systemctl status <svc>` to
//! `Unknown` (falling back to the generic command set).

use serde_json::Value;

use crate::mcp_safety::is_sensitive_path;

/// Character clamp for `title` / `message` / `alert_id` / `source`.
const MAX_FIELD_CHARS: usize = 2048;
/// Character clamp for the pretty-printed `data` JSON blob.
const MAX_DATA_JSON_CHARS: usize = 16384;

/// Normalized shape of an alert payload.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedAlert {
    pub alert_id: String,
    pub title: String,
    pub message: String,
    pub severity: String,
    pub source: String,
    pub data_json: String,
}

/// Alert category derived from keyword scoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Cpu,
    Memory,
    Disk,
    Inode,
    Network,
    Oom,
    Service,
    Generic,
}

impl Category {
    /// Stable wire name (`ssh/alert/triage` response `category` field).
    pub fn name(self) -> &'static str {
        match self {
            Category::Cpu => "cpu",
            Category::Memory => "memory",
            Category::Disk => "disk",
            Category::Inode => "inode",
            Category::Network => "network",
            Category::Oom => "oom",
            Category::Service => "service",
            Category::Generic => "generic",
        }
    }
}

/// One suggested diagnostic command. `purpose_key` is a stable contract key
/// the frontend maps to i18n labels; it must never be renamed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub command: String,
    pub purpose_key: &'static str,
}

/// Triage result: normalized alert + category + whitelist-safe suggestions.
#[derive(Debug, Clone)]
pub struct TriageResult {
    pub normalized: NormalizedAlert,
    pub category: Category,
    pub suggestions: Vec<Suggestion>,
}

/// Normalizes a raw alert payload (JSON or plain text) into the fixed shape.
///
/// JSON path: string fields are picked (`alertId` with an `alert_id`
/// fallback); an object `data` becomes pretty-printed `data_json`. When the
/// parsed `message` is empty the entire payload becomes the message.
/// Non-JSON path (plain-text alerts): the entire payload becomes the message.
/// Strings are char-clamped; `severity` / `source` are lowercased and a
/// missing severity becomes `"unknown"`.
pub fn normalize(payload: &str) -> NormalizedAlert {
    let trimmed = payload.trim();
    let mut alert_id = String::new();
    let mut title = String::new();
    let mut severity = String::new();
    let mut source = String::new();
    let mut data_json = String::new();
    let mut message;

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        alert_id = string_field(&value, &["alertId", "alert_id"]);
        title = string_field(&value, &["title"]);
        message = string_field(&value, &["message"]);
        severity = string_field(&value, &["severity"]).to_lowercase();
        source = string_field(&value, &["source"]).to_lowercase();
        if let Some(data) = value.get("data").filter(|value| value.is_object()) {
            data_json = serde_json::to_string_pretty(data).unwrap_or_default();
        }
        // openocta /hooks/alert compatibility: an alert whose `message` is
        // empty degrades to the whole payload text.
        if message.is_empty() {
            message = trimmed.to_string();
        }
    } else {
        // Plain-text alert (or any non-JSON payload).
        message = trimmed.to_string();
    }

    if severity.is_empty() {
        severity = "unknown".to_string();
    }

    NormalizedAlert {
        alert_id: clamp_chars(&alert_id, MAX_FIELD_CHARS),
        title: clamp_chars(&title, MAX_FIELD_CHARS),
        message: clamp_chars(&message, MAX_FIELD_CHARS),
        severity,
        source,
        data_json: clamp_chars(&data_json, MAX_DATA_JSON_CHARS),
    }
}

/// First present string field among `keys`; non-string values count as
/// missing. Returns an empty string when no key matches.
fn string_field(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn clamp_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Bilingual (English + Chinese) keyword sets per category, lowercased.
const KEYWORDS: &[(Category, &[&str])] = &[
    (
        Category::Oom,
        &[
            "oom",
            "out of memory",
            "oom-kill",
            "killed process",
            "内存耗尽",
        ],
    ),
    (Category::Inode, &["inode"]),
    (
        Category::Cpu,
        &[
            "cpu",
            "processor",
            "load average",
            "loadavg",
            "处理器",
            "负载",
        ],
    ),
    (Category::Memory, &["memory", "mem usage", "内存", "swap"]),
    (
        Category::Disk,
        &["disk", "no space", "disk space", "磁盘", "剩余空间"],
    ),
    (
        Category::Network,
        &["network", "bandwidth", "packet loss", "丢包", "网卡"],
    ),
    (
        Category::Service,
        &["systemd", "service", "unit", "服务", "restart"],
    ),
];

/// Tie-break precedence. Declaration order applies (first listed wins on
/// equal scores) with one deliberate override: `Oom` precedes `Memory`, so
/// "内存耗尽" / "out of memory" alerts — where the OOM keyword also scores a
/// Memory keyword — always land on Oom. Pinned by `classify` tests.
const SCORE_ORDER: &[Category] = &[
    Category::Oom,
    Category::Cpu,
    Category::Memory,
    Category::Disk,
    Category::Inode,
    Category::Network,
    Category::Service,
];

/// Classifies an alert by keyword scoring over `title + message + data_json`
/// (lowercased). Highest score wins; all-zero scores yield
/// [`Category::Generic`]; ties are resolved by [`SCORE_ORDER`].
pub fn classify(alert: &NormalizedAlert) -> Category {
    let text = format!("{} {} {}", alert.title, alert.message, alert.data_json).to_lowercase();
    let mut best = Category::Generic;
    let mut best_score = 0usize;
    for category in SCORE_ORDER {
        let Some((_, keywords)) = KEYWORDS.iter().find(|(owner, _)| owner == category) else {
            continue;
        };
        let score: usize = keywords
            .iter()
            .map(|keyword| text.matches(keyword).count())
            .sum();
        if score > best_score {
            best_score = score;
            best = *category;
        }
    }
    best
}

/// Extracts the systemd unit name for the Service category.
///
/// Order: first `<name>.service` token, then `unit=<name>`, then
/// `service=<name>`. Candidates are restricted to `[A-Za-z0-9@._-]+` and are
/// rejected when they reference a sensitive path (defense for decision D6 —
/// such a name would keep `systemctl status <svc>` out of the read-only
/// class, so the caller falls back to the generic command set instead).
pub fn extract_service(alert: &NormalizedAlert) -> Option<String> {
    let haystack = format!("{} {}", alert.message, alert.data_json).to_lowercase();
    service_token(&haystack)
        .or_else(|| keyed_service(&haystack, "unit="))
        .or_else(|| keyed_service(&haystack, "service="))
}

/// Valid unit-name characters (`systemctl status`/`journalctl -u` argument).
fn is_unit_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-')
}

/// Longest valid-unit-character run starting at `start`.
fn unit_run_at(text: &str, start: usize) -> String {
    text[start..]
        .chars()
        .take_while(|c| is_unit_char(*c))
        .collect()
}

/// First maximal `[A-Za-z0-9@._-]+` run that ends with `.service` and has a
/// non-empty name part.
fn service_token(text: &str) -> Option<String> {
    let mut start = 0;
    while start < text.len() {
        if !text[start..].starts_with(|c: char| is_unit_char(c)) {
            start += 1;
            continue;
        }
        let run = unit_run_at(text, start);
        if let Some(name) = run.strip_suffix(".service") {
            if !name.is_empty() && !is_sensitive_path(&run) {
                return Some(run);
            }
        }
        start += run.len().max(1);
    }
    None
}

/// Value after a `key=` marker (e.g. `unit=nginx`).
fn keyed_service(text: &str, key: &str) -> Option<String> {
    let mut rest = text;
    while let Some(position) = rest.find(key) {
        let value = unit_run_at(rest, position + key.len());
        if !value.is_empty() && !is_sensitive_path(&value) {
            return Some(value);
        }
        rest = &rest[position + key.len()..];
    }
    None
}

/// Generic command set used as the fallback for [`Category::Generic`] and for
/// [`Category::Service`] when no unit name could be extracted (test-pinned).
fn generic_suggestions() -> Vec<Suggestion> {
    vec![
        suggestion("uptime", "loadSnapshot"),
        suggestion("df -h", "diskUsage"),
        suggestion("free -m", "memFree"),
        suggestion("ps aux --sort=-%cpu | head -10", "cpuTopProcesses"),
    ]
}

fn suggestion(command: &str, purpose_key: &'static str) -> Suggestion {
    Suggestion {
        command: command.to_string(),
        purpose_key,
    }
}

/// Static playbook per category. Every emitted command is pinned by the
/// `playbook` tests to satisfy `mcp_safety::assess_command == ReadOnly`
/// (decision D6).
///
/// Dropped from the initial draft: `top -b -n 1 | head -20` (`cpuTop`) —
/// `top` is not in `mcp_safety::READ_ONLY_VERBS`, so the pipeline degrades to
/// `Unknown`; its information (hot processes + instantaneous CPU state) is
/// already covered by `cpuTopProcesses` and `cpuVmstat`.
pub fn playbook(category: Category, alert: &NormalizedAlert) -> Vec<Suggestion> {
    match category {
        Category::Cpu => vec![
            suggestion("uptime", "loadSnapshot"),
            suggestion("ps aux --sort=-%cpu | head -15", "cpuTopProcesses"),
            suggestion("vmstat 1 3", "cpuVmstat"),
        ],
        Category::Memory => vec![
            suggestion("free -m", "memFree"),
            suggestion("ps aux --sort=-%mem | head -15", "memTopProcesses"),
        ],
        Category::Disk => vec![
            suggestion("df -h", "diskUsage"),
            suggestion("du -x -d 1 / | sort -rh | head -15", "diskDu"),
        ],
        Category::Inode => vec![suggestion("df -i", "diskInode")],
        Category::Network => vec![
            suggestion("ss -s", "netSummary"),
            suggestion("ip -s link", "netLinks"),
        ],
        Category::Oom => vec![
            suggestion("dmesg -T | tail -100", "oomDmesg"),
            suggestion("journalctl -k -n 200 --no-pager", "oomJournal"),
        ],
        Category::Service => match extract_service(alert) {
            Some(service) => vec![
                suggestion(&format!("systemctl status {service}"), "serviceStatus"),
                suggestion(
                    &format!("journalctl -u {service} -n 100 --no-pager"),
                    "serviceJournal",
                ),
            ],
            // No unit name found: fall back to the generic command set.
            None => generic_suggestions(),
        },
        Category::Generic => generic_suggestions(),
    }
}

/// Runs the full pipeline: normalize → classify → playbook.
pub fn triage(payload: &str) -> TriageResult {
    let normalized = normalize(payload);
    let category = classify(&normalized);
    let suggestions = playbook(category, &normalized);
    TriageResult {
        normalized,
        category,
        suggestions,
    }
}

/// Protocol response shape for `ssh/alert/triage` (camelCase).
pub fn triage_view(result: &TriageResult) -> Value {
    serde_json::json!({
        "normalized": {
            "alertId": result.normalized.alert_id,
            "title": result.normalized.title,
            "message": result.normalized.message,
            "severity": result.normalized.severity,
            "source": result.normalized.source,
            "dataJson": result.normalized.data_json,
        },
        "category": result.category.name(),
        "suggestions": result
            .suggestions
            .iter()
            .map(|item| {
                serde_json::json!({
                    "command": item.command,
                    "purposeKey": item.purpose_key,
                })
            })
            .collect::<Vec<Value>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_safety::{assess_command, CommandRisk};
    use serde_json::json;

    /// Builds a `NormalizedAlert` directly (bypasses `normalize`).
    fn alert(title: &str, message: &str) -> NormalizedAlert {
        NormalizedAlert {
            title: title.to_string(),
            message: message.to_string(),
            ..NormalizedAlert::default()
        }
    }

    fn classify_text(text: &str) -> Category {
        classify(&alert("", text))
    }

    // ---------- normalize ----------

    #[test]
    fn structured_json_fields_are_extracted() {
        let payload = r#"{"alertId":"a-1","title":"CPU High","message":"cpu at 95%",
            "severity":"CRITICAL","source":"Prometheus",
            "data":{"node":"web-1","value":95}}"#;
        let normalized = normalize(payload);
        assert_eq!(normalized.alert_id, "a-1");
        assert_eq!(normalized.title, "CPU High");
        assert_eq!(normalized.message, "cpu at 95%");
        assert_eq!(normalized.severity, "critical"); // lowercased
        assert_eq!(normalized.source, "prometheus");
        // Object data becomes pretty-printed JSON.
        assert!(normalized.data_json.contains("\n"));
        assert!(normalized.data_json.contains("\"node\": \"web-1\""));
    }

    #[test]
    fn snake_case_alert_id_is_accepted() {
        let normalized = normalize(r#"{"alert_id":"sn-7","message":"m"}"#);
        assert_eq!(normalized.alert_id, "sn-7");
    }

    #[test]
    fn non_string_fields_are_missing_and_data_non_object_is_dropped() {
        let normalized = normalize(r#"{"alertId":42,"title":7,"data":"not-an-object"}"#);
        assert_eq!(normalized.alert_id, "");
        assert_eq!(normalized.title, "");
        assert_eq!(normalized.data_json, "");
    }

    #[test]
    fn empty_message_falls_back_to_whole_payload() {
        let payload = r#"{"severity":"critical"}"#;
        let normalized = normalize(payload);
        assert_eq!(normalized.message, payload);
    }

    #[test]
    fn plain_text_payload_becomes_the_message() {
        let normalized = normalize("  Disk almost full on /var  ");
        assert_eq!(normalized.message, "Disk almost full on /var");
        assert_eq!(normalized.title, "");
        assert_eq!(normalized.severity, "unknown");
        assert_eq!(normalized.source, "");
        assert_eq!(normalized.data_json, "");
    }

    #[test]
    fn missing_severity_becomes_unknown() {
        assert_eq!(normalize(r#"{"message":"m"}"#).severity, "unknown");
        assert_eq!(
            normalize(r#"{"message":"m","severity":""}"#).severity,
            "unknown"
        );
    }

    #[test]
    fn overlong_fields_are_clamped_by_chars() {
        let payload = json!({
            "title": "t".repeat(3000),
            "message": "m".repeat(3000),
            "data": { "blob": "x".repeat(20000) },
        })
        .to_string();
        let normalized = normalize(&payload);
        assert_eq!(normalized.title.chars().count(), MAX_FIELD_CHARS);
        assert_eq!(normalized.message.chars().count(), MAX_FIELD_CHARS);
        assert_eq!(normalized.data_json.chars().count(), MAX_DATA_JSON_CHARS);
        // Multibyte content truncates on char boundaries.
        let wide = normalize(&json!({ "message": "内".repeat(3000) }).to_string());
        assert_eq!(wide.message.chars().count(), MAX_FIELD_CHARS);
    }

    // ---------- classify ----------

    #[test]
    fn cpu_alerts_are_detected() {
        assert_eq!(classify_text("CPU 使用率过高, 负载 12.0"), Category::Cpu);
        assert_ne!(classify_text("free memory is low"), Category::Cpu);
    }

    #[test]
    fn memory_alerts_are_detected() {
        assert_eq!(classify_text("内存使用 95%, swap 已满"), Category::Memory);
        assert_ne!(classify_text("cpu idle 100%"), Category::Memory);
    }

    #[test]
    fn disk_alerts_are_detected() {
        assert_eq!(
            classify_text("磁盘告警: no space left on device"),
            Category::Disk
        );
        assert_ne!(classify_text("memory usage 90%"), Category::Disk);
    }

    #[test]
    fn inode_alerts_are_detected() {
        assert_eq!(classify_text("inode usage 99% on /var"), Category::Inode);
        // Plain disk keywords must not bleed into Inode.
        assert_ne!(classify_text("disk io slow"), Category::Inode);
    }

    #[test]
    fn network_alerts_are_detected() {
        assert_eq!(
            classify_text("网卡 eth0 packet loss 10%, 丢包"),
            Category::Network
        );
        assert_ne!(classify_text("cpu load high"), Category::Network);
    }

    #[test]
    fn oom_alerts_are_detected() {
        assert_eq!(
            classify_text("Out of memory: OOM killer terminated java"),
            Category::Oom
        );
        assert_ne!(classify_text("disk almost full"), Category::Oom);
    }

    /// Pins the tie-break decision: OOM keywords that also score a Memory
    /// keyword ("out of memory" → "memory", "内存耗尽" → "内存") must resolve
    /// to Oom, i.e. Oom precedes Memory in the tie-break order.
    #[test]
    fn oom_outranks_memory_on_tied_scores() {
        assert_eq!(classify_text("内存耗尽"), Category::Oom);
        assert_eq!(classify_text("out of memory"), Category::Oom);
    }

    #[test]
    fn service_alerts_are_detected() {
        assert_eq!(
            classify_text("systemd: unit nginx.service restart failed"),
            Category::Service
        );
        assert_ne!(classify_text("cpu high"), Category::Service);
    }

    #[test]
    fn zero_scores_fall_back_to_generic() {
        assert_eq!(
            classify_text("backup finished successfully at 03:00"),
            Category::Generic
        );
        assert_eq!(classify(&NormalizedAlert::default()), Category::Generic);
    }

    // ---------- playbook ----------

    /// D6 core acceptance: every emitted suggestion — for every category,
    /// including the service group with a substituted unit name and the
    /// service→generic fallback — must be provably read-only.
    #[test]
    fn every_suggestion_passes_the_read_only_whitelist() {
        let service_alert = alert("服务异常", "systemd unit nginx.service restart failed");
        let cases = [
            Category::Cpu,
            Category::Memory,
            Category::Disk,
            Category::Inode,
            Category::Network,
            Category::Oom,
            Category::Service,
            Category::Generic,
        ];
        for category in cases {
            let suggestions = playbook(category, &service_alert);
            assert!(
                !suggestions.is_empty(),
                "{category:?} produced no suggestions"
            );
            for item in suggestions {
                assert_eq!(
                    assess_command(&item.command),
                    CommandRisk::ReadOnly,
                    "command not read-only: {}",
                    item.command
                );
                assert!(!item.command.contains('>'));
                assert!(!item.command.contains("sudo"));
                assert!(!item.command.contains("$("));
                assert!(!item.command.contains('`'));
            }
        }
        // Service with an unextractable unit also falls back to generic.
        let anonymous = alert("", "service crashed, no unit name");
        for item in playbook(Category::Service, &anonymous) {
            assert_eq!(assess_command(&item.command), CommandRisk::ReadOnly);
        }
    }

    #[test]
    fn purpose_keys_are_stable() {
        let empty = NormalizedAlert::default();
        // The Service row needs a sample unit name; an empty alert would
        // (correctly) fall back to the generic command set.
        let named = alert("服务异常", "systemd unit cron.service restart failed");
        let keys = |category| -> Vec<&'static str> {
            let sample = if category == Category::Service {
                &named
            } else {
                &empty
            };
            playbook(category, sample)
                .into_iter()
                .map(|item| item.purpose_key)
                .collect()
        };
        assert_eq!(
            keys(Category::Cpu),
            ["loadSnapshot", "cpuTopProcesses", "cpuVmstat"]
        );
        assert_eq!(keys(Category::Memory), ["memFree", "memTopProcesses"]);
        assert_eq!(keys(Category::Disk), ["diskUsage", "diskDu"]);
        assert_eq!(keys(Category::Inode), ["diskInode"]);
        assert_eq!(keys(Category::Network), ["netSummary", "netLinks"]);
        assert_eq!(keys(Category::Oom), ["oomDmesg", "oomJournal"]);
        assert_eq!(keys(Category::Service), ["serviceStatus", "serviceJournal"]);
        assert_eq!(
            keys(Category::Generic),
            ["loadSnapshot", "diskUsage", "memFree", "cpuTopProcesses"]
        );
    }

    // ---------- extract_service ----------

    #[test]
    fn extracts_name_dot_service_token() {
        let found = alert("", "Failed to start nginx.service: timeout");
        assert_eq!(extract_service(&found).as_deref(), Some("nginx.service"));
    }

    #[test]
    fn extracts_unit_key_form() {
        let found = alert("", "unit=redis failed to start");
        assert_eq!(extract_service(&found).as_deref(), Some("redis"));
    }

    #[test]
    fn extracts_service_key_form() {
        let found = alert("", "service=mysql stopped unexpectedly");
        assert_eq!(extract_service(&found).as_deref(), Some("mysql"));
    }

    #[test]
    fn missing_service_returns_none() {
        assert_eq!(extract_service(&alert("", "unknown failure")), None);
        assert_eq!(extract_service(&alert("", "unit= failed")), None);
    }

    /// D6 defense: a sensitive-path candidate must not reach
    /// `systemctl status <svc>` (it would leave the read-only class).
    #[test]
    fn sensitive_candidates_are_rejected() {
        let key_like = alert("", "unit=id_rsa.service failed");
        assert_eq!(extract_service(&key_like), None);
        let hidden = alert("", "check unit=.ssh for details");
        assert_eq!(extract_service(&hidden), None);
    }

    // ---------- triage + triage_view ----------

    #[test]
    fn category_names_are_stable() {
        assert_eq!(Category::Cpu.name(), "cpu");
        assert_eq!(Category::Memory.name(), "memory");
        assert_eq!(Category::Disk.name(), "disk");
        assert_eq!(Category::Inode.name(), "inode");
        assert_eq!(Category::Network.name(), "network");
        assert_eq!(Category::Oom.name(), "oom");
        assert_eq!(Category::Service.name(), "service");
        assert_eq!(Category::Generic.name(), "generic");
    }

    #[test]
    fn triage_view_uses_camel_case_response_shape() {
        let payload = r#"{"alertId":"a-9","title":"CPU 高","severity":"critical","data":{"v":1}}"#;
        let result = triage(payload);
        let view = triage_view(&result);

        // Top-level keys exactly as contracted.
        let top_keys: Vec<&str> = view
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(top_keys, ["category", "normalized", "suggestions"]);

        let normalized = &view["normalized"];
        assert_eq!(normalized["alertId"], "a-9");
        assert_eq!(normalized["title"], "CPU 高");
        // Empty parsed message degrades to the whole payload.
        assert_eq!(normalized["message"], payload);
        assert_eq!(normalized["severity"], "critical");
        assert_eq!(normalized["source"], "");
        assert!(normalized["dataJson"]
            .as_str()
            .unwrap()
            .contains("\"v\": 1"));

        assert_eq!(view["category"], "cpu");
        assert_eq!(
            view["suggestions"][0],
            json!({ "command": "uptime", "purposeKey": "loadSnapshot" })
        );
        assert_eq!(view["suggestions"][2]["purposeKey"], "cpuVmstat");
    }

    #[test]
    fn triage_end_to_end_uses_the_substituted_service_name() {
        let payload = r#"{"title":"服务异常","message":"systemd unit cron.service failed"}"#;
        let result = triage(payload);
        assert_eq!(result.category, Category::Service);
        let commands: Vec<&str> = result
            .suggestions
            .iter()
            .map(|item| item.command.as_str())
            .collect();
        assert_eq!(
            commands,
            [
                "systemctl status cron.service",
                "journalctl -u cron.service -n 100 --no-pager",
            ]
        );
    }
}
