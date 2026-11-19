//! Resident streaming monitor: one long-lived exec channel per connection
//! emitting counter lines once per second; all rate math lives on this side.
//!
//! Two collectors per connection share the same script style: the fast loop
//! diffs `/proc` counters into per-second CPU/memory/network samples, the
//! slow loop emits a load/uptime/disk/user burst every 5s. Both scripts are
//! single POSIX sh commands in the `metrics.rs` style with Linux `/proc`
//! readers only — other platforms get a cap/unsupported line so the panel
//! can show a terminal "unsupported" state. Sample timestamps are stamped
//! at sidecar arrival (busybox `date` has no `%3N`, so remote clocks are
//! never trusted). All parsing and diff math lives in pure functions below
//! so script-output fixtures can be unit-tested without a server.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use russh::client::{Handle, Msg};
use russh::ChannelMsg;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::ssh::{SshClient, SshRuntime};

pub const MONITOR_TASK_LIMIT: usize = 24;
pub const FAST_RING_CAP: usize = 720; // 12 min @ 1s
pub const SLOW_RING_CAP: usize = 144; // 12 min @ 5s
pub const SNAPSHOT_DEFAULT_POINTS: usize = 120;

/// Inter-line watchdog on the fast channel: 3s without a counter row means
/// the stream stalled without an EOF — the loop reopens the channel.
const FAST_WATCHDOG: Duration = Duration::from_secs(3);
/// Backoff between watchdog reopen attempts (still cancellable).
const REOPEN_BACKOFF: Duration = Duration::from_millis(500);

/// Consecutive failed channel reopens the fast loop tolerates: the second
/// consecutive failure is terminal (`failed`), one failure backs off and
/// retries.
const MAX_REOPEN_FAILURES: u32 = 2;

/// Reopen-ladder decision, pure so the give-up rule stays unit-testable
/// without a russh channel mock: once `reopen_failures` reaches
/// [`MAX_REOPEN_FAILURES`] the loop must report `failed` and exit instead
/// of backing off yet again.
fn should_fail_after_reopen(reopen_failures: u32) -> bool {
    reopen_failures >= MAX_REOPEN_FAILURES
}

const MON_FAST_SCRIPT: &str = concat!(
    "echo \"dbx-mon-cap $(uname -sr)\"; ",
    "[ -r /proc/stat ] && [ -r /proc/net/dev ] && [ -r /proc/meminfo ] || ",
    "{ echo \"dbx-mon-unsupported $(uname -s)\"; exit 0; }; ",
    "while :; do ",
    "set -- $(grep '^cpu ' /proc/stat); ",
    "c_total=$(($2 + $3 + $4 + $5 + $6 + $7 + $8)); c_idle=$(($5 + $6)); ",
    "m_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo); ",
    "m_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo); ",
    "case \"$m_avail\" in ''|*[!0-9]*) m_avail=$(awk 'BEGIN{f=b=c=s=sh=0}",
    "/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SReclaimable:/{s=$2}",
    "/^Shmem:/{sh=$2}END{a=f+b+c+s-sh; if(a<0)a=0; print a}' /proc/meminfo);; esac; ",
    "iface=$(awk '$2==\"00000000\"{print $1; exit}' /proc/net/route 2>/dev/null); ",
    // Both iface sources pass the same charset whitelist before the eval:
    // a failed validation clears $iface (no fallback re-entry), so a hostile
    // /proc/net/dev name can never reach `awk -v IF="$iface"` either.
    "case \"$iface\" in *[!A-Za-z0-9.@_-]*) iface=;; esac; ",
    "[ -n \"$iface\" ] || iface=$(awk 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1!=\"lo\"){print $1; exit}}' /proc/net/dev); ",
    "case \"$iface\" in *[!A-Za-z0-9.@_-]*) iface=;; esac; ",
    "n_rx=0; n_tx=0; ",
    "case \"$iface\" in ?*) eval \"$(awk -v IF=\"$iface\" 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1==IF){print \"n_rx=\"$2; print \"n_tx=\"$10; exit}}' /proc/net/dev)\";; esac; ",
    "printf 'dbx-mon c=%s,%s m=%s,%s n=%s,%s,%s\\n' ",
    "\"$c_total\" \"$c_idle\" \"$m_total\" \"$m_avail\" \"$n_rx\" \"$n_tx\" \"$iface\"; ",
    "sleep 1; done",
);

const MON_SLOW_SCRIPT: &str = concat!(
    "[ -r /proc/loadavg ] && [ -r /proc/uptime ] || { echo \"dbx-det end\"; exit 0; }; ",
    "while :; do ",
    "echo \"dbx-det load=$(cut -d' ' -f1-3 /proc/loadavg)\"; ",
    "echo \"dbx-det uptime=$(awk '{print int($1)}' /proc/uptime)\"; ",
    "df -P -k / 2>/dev/null | tail -n +2 | awk '{printf \"dbx-det disk=%s,%s,%s\\n\", $6, $2, $3}'; ",
    // who awk is pinned verbatim by `MON_WHO_AWK` in the tests module (GNU
    // who prints the login date in column 3; the host arrives paren-wrapped).
    "who 2>/dev/null | head -20 | awk '{f=\"\"; for(i=3;i<=NF;i++) if($i ~ /^\\(.*\\)$/) {f=substr($i,2,length($i)-2); break}; printf \"dbx-det user=%s,%s,%s\\n\", $1, $2, f}'; ",
    "echo \"dbx-det end\"; ",
    "sleep 5; done",
);

/// Lifecycle of one connection's monitor task. `failed`/`unsupported` are
/// terminal — only an explicit stop+start revives them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorState {
    Connecting,
    Live,
    Failed,
    Unsupported,
    Stopped,
}

/// One per-second fast-loop sample. Serialized camelCase per the protocol
/// contract; `iface` is absent when unknown.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: u64,
    pub cpu_pct: f64,
    pub mem_total_mb: f64,
    pub mem_used_mb: f64,
    pub net_rx_kbps: f64,
    pub net_tx_kbps: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iface: Option<String>,
}

/// Axis-break marker the frontend renders as a sparkline gap; serialized as
/// the bare `{"t":…,"gap":true}` object (always true).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GapPoint {
    pub t: u64,
    pub gap: bool,
}

/// One slow-loop detail burst. Serialized camelCase per the protocol
/// contract.
#[derive(Debug, Clone, PartialEq, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub uptime_sec: u64,
    pub disks: Vec<DiskRow>,
    pub users: Vec<UserRow>,
}

/// One mounted filesystem row of a detail burst (`df -P -k /`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskRow {
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
}

/// One login row of a detail burst (`who`: user/tty verbatim, `from` = the
/// first `(...)`-wrapped field with its parens stripped — empty when the
/// login has no remote host).
#[derive(Debug, Clone, PartialEq, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserRow {
    pub user: String,
    pub tty: String,
    pub from: String,
}

/// Classification of one fast-loop output line.
#[derive(Debug, Clone, PartialEq)]
pub enum CounterLine {
    /// `dbx-mon-cap <uname -sr>` — first line of every run; the payload is
    /// the remote kernel string, kept for diagnostics.
    Cap(String),
    /// `dbx-mon-unsupported <uname -s>` — a required /proc file is missing;
    /// the task goes terminal-unsupported with this payload as reason.
    Unsupported(String),
    /// A per-second counter row, fully parsed.
    Counters(Counters),
    /// Anything else (MOTD text, locale noise, empty lines): stream on.
    Ignored,
}

/// One parsed fast-loop counter row. `t` is left at 0 by the parser (pure,
/// clock-free) and stamped with the sidecar-arrival unix ms by the loop
/// before the row enters the diff chain.
#[derive(Debug, Clone, PartialEq)]
pub struct Counters {
    pub t: u64,
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub mem_total_kb: u64,
    pub mem_avail_kb: u64,
    pub rx: u64,
    pub tx: u64,
    pub iface: String,
}

/// Classifies one fast-loop output line. Anything that is not one of the
/// three script-emitted shapes — and not fully parseable — is
/// [`CounterLine::Ignored`]; the stream keeps flowing regardless.
pub fn parse_counter_line(line: &str) -> CounterLine {
    let trimmed = line.trim();
    // The cap/unsupported prefixes are checked first: `dbx-mon-cap` shares
    // its `dbx-mon` prefix with the counter rows.
    if let Some(rest) = trimmed.strip_prefix("dbx-mon-cap") {
        return CounterLine::Cap(rest.trim().to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("dbx-mon-unsupported") {
        return CounterLine::Unsupported(rest.trim().to_string());
    }
    let Some(rest) = trimmed.strip_prefix("dbx-mon ") else {
        return CounterLine::Ignored;
    };
    parse_counters(rest)
        .map(CounterLine::Counters)
        .unwrap_or(CounterLine::Ignored)
}

/// Parses the field block `c=<total>,<idle> m=<total>,<avail>
/// n=<rx>,<tx>,<iface>` as printed by the `MON_FAST_SCRIPT` printf.
/// Every field must be present and numeric or the row is dropped (the
/// callers only push fully-parsed rows into the diff chain).
fn parse_counters(rest: &str) -> Option<Counters> {
    let mut cpu: Option<(u64, u64)> = None;
    let mut mem: Option<(u64, u64)> = None;
    let mut net: Option<(u64, u64, String)> = None;
    for field in rest.split_whitespace() {
        let (key, value) = field.split_once('=')?;
        match key {
            "c" => {
                let (total, idle) = value.split_once(',')?;
                cpu = Some((total.parse().ok()?, idle.parse().ok()?));
            }
            "m" => {
                let (total, avail) = value.split_once(',')?;
                mem = Some((total.parse().ok()?, avail.parse().ok()?));
            }
            "n" => {
                // splitn keeps the interface name intact even though the
                // script only ever prints the charset-validated one.
                let (rx, tail) = value.split_once(',')?;
                let (tx, iface) = tail.split_once(',')?;
                if iface.is_empty() {
                    return None;
                }
                net = Some((rx.parse().ok()?, tx.parse().ok()?, iface.to_string()));
            }
            // Unknown keys (the retired l= among them) drop the whole row.
            _ => return None,
        }
    }
    let (cpu_total, cpu_idle) = cpu?;
    let (mem_total_kb, mem_avail_kb) = mem?;
    let (rx, tx, iface) = net?;
    Some(Counters {
        t: 0,
        cpu_total,
        cpu_idle,
        mem_total_kb,
        mem_avail_kb,
        rx,
        tx,
        iface,
    })
}

/// Diffs two same-interface counter reads into one [`Sample`]. `t_ms` is the
/// sidecar arrival time of `next` — the value `Sample.t` carries, per the
/// protocol unit table (remote clocks are never trusted; busybox `date` has
/// no `%3N`).
///
/// The elapsed sampling window is `t_ms - prev.t`, which is why the caller
/// stamps every parsed row's [`Counters::t`] on arrival. A non-positive
/// window (and an iface change, which the caller detects by comparing and
/// records as a [`GapPoint`] instead of sampling across the switch) yields
/// an all-zero sample the caller drops — the math stays finite either way.
pub fn diff_counters(prev: &Counters, next: &Counters, t_ms: u64) -> Sample {
    let dt_secs = t_ms.saturating_sub(prev.t) as f64 / 1000.0;
    let d_total = next.cpu_total.saturating_sub(prev.cpu_total);
    let d_idle = next.cpu_idle.saturating_sub(prev.cpu_idle);
    // Δtotal == 0 (identical reads, no elapsed window) measures nothing: the
    // plan pins cpu to 0 instead of dividing by zero. The clamp absorbs
    // counter resets where Δidle would overtake Δtotal (saturating first so
    // the u64 subtraction never underflows).
    let cpu_pct = if dt_secs <= 0.0 || d_total == 0 {
        0.0
    } else {
        (d_total.saturating_sub(d_idle) as f64 / d_total as f64 * 100.0).clamp(0.0, 100.0)
    };
    // kB→MB is ÷1024 (protocol units: KB=1024 B, MB=1024² B). avail can
    // exceed total on synthetic input — clamp keeps the value non-negative.
    let mem_used_mb = next.mem_total_kb.saturating_sub(next.mem_avail_kb) as f64 / 1024.0;
    // Counter deltas are bytes over the window; KiB/s = bytes/s ÷ 1024
    // (`netRxKbps`/`netTxKbps` are KiB/s, not kilobits — see PROTOCOL).
    let (rx, tx) = if dt_secs > 0.0 {
        (
            next.rx.saturating_sub(prev.rx) as f64 / dt_secs / 1024.0,
            next.tx.saturating_sub(prev.tx) as f64 / dt_secs / 1024.0,
        )
    } else {
        (0.0, 0.0)
    };
    Sample {
        t: t_ms,
        cpu_pct: round1(cpu_pct),
        mem_total_mb: next.mem_total_kb as f64 / 1024.0,
        mem_used_mb: mem_used_mb.max(0.0),
        net_rx_kbps: round1(rx),
        net_tx_kbps: round1(tx),
        iface: Some(next.iface.clone()),
    }
}

/// One decimal place for the fields the protocol pins to 0..100 / KiB/s.
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Parses one slow-loop detail burst: the `dbx-det …` lines emitted before
/// its `dbx-det end` marker. Lines after the marker (the next burst arriving
/// in the same read chunk) are ignored; unknown or malformed lines are
/// skipped so a partial burst degrades field-by-field instead of failing.
pub fn parse_detail_block(lines: &[&str]) -> Details {
    let mut details = Details::default();
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "dbx-det end" {
            break;
        }
        let Some(rest) = trimmed.strip_prefix("dbx-det ") else {
            continue;
        };
        if let Some(value) = rest.strip_prefix("load=") {
            let mut parts = value.split_whitespace();
            if let (Some(l1), Some(l5), Some(l15)) = (parts.next(), parts.next(), parts.next()) {
                if let (Ok(l1), Ok(l5), Ok(l15)) =
                    (l1.parse::<f64>(), l5.parse::<f64>(), l15.parse::<f64>())
                {
                    details.load1 = l1;
                    details.load5 = l5;
                    details.load15 = l15;
                }
            }
        } else if let Some(value) = rest.strip_prefix("uptime=") {
            if let Ok(secs) = value.parse() {
                details.uptime_sec = secs;
            }
        } else if let Some(value) = rest.strip_prefix("disk=") {
            // df columns mount,total-kB,used-kB; splitn(3) keeps pathological
            // mount points containing commas intact (total/used stay last).
            let mut parts = value.splitn(3, ',');
            if let (Some(mount), Some(total), Some(used)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(total), Ok(used)) = (total.parse::<u64>(), used.parse::<u64>()) {
                    details.disks.push(DiskRow {
                        mount: mount.to_string(),
                        total_kb: total,
                        used_kb: used,
                    });
                }
            }
        } else if let Some(value) = rest.strip_prefix("user=") {
            // who user/tty verbatim; `from` is the awk-extracted host (see
            // MON_WHO_AWK) — a missing from-column degrades to "".
            let mut parts = value.splitn(3, ',');
            let user = parts.next().unwrap_or_default().to_string();
            if user.is_empty() {
                continue;
            }
            let tty = parts.next().unwrap_or_default().to_string();
            let from = parts.next().unwrap_or_default().to_string();
            details.users.push(UserRow { user, tty, from });
        }
    }
    details
}

/// Ring entry of the fast loop: either a computed sample or an axis-break
/// marker. Untagged so entries serialize flat as the protocol's
/// `Sample|Gap` union.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum Point {
    Sample(Sample),
    Gap(GapPoint),
}

/// One slow-loop detail burst with its sidecar-arrival stamp.
#[derive(Debug, Clone, PartialEq)]
pub struct DetailPoint {
    pub t: u64,
    pub details: Details,
}

/// `points` clamp: at least one sample, at most the fast ring cap (the
/// protocol pins the default at 120).
fn clamp_points(points: Option<u64>) -> usize {
    points
        .map(|value| value.clamp(1, FAST_RING_CAP as u64) as usize)
        .unwrap_or(SNAPSHOT_DEFAULT_POINTS)
}

/// Tail-N view of a ring, oldest-first — the frontend charts expect
/// chronological order while the ring holds newest-last.
fn ring_tail(ring: &VecDeque<Point>, points: usize) -> Vec<Point> {
    ring.iter().rev().take(points).rev().cloned().collect()
}

/// Next ring point for a fresh counter row: an iface switch records a Gap
/// and re-baselines (the caller stores `next` as the new `last`), anything
/// else diffs straight into a Sample — no rate is ever computed across the
/// switch, which is what breaks the frontend chart axis.
fn next_point(prev: &Counters, next: &Counters, t_ms: u64) -> Point {
    if prev.iface != next.iface {
        Point::Gap(GapPoint { t: t_ms, gap: true })
    } else {
        Point::Sample(diff_counters(prev, next, t_ms))
    }
}

/// Splits newly arrived bytes into complete lines, keeping the trailing
/// partial line in the buffer for the next chunk — SSH data chunks are not
/// line-aligned and the printf rows can straddle two reads.
fn drain_lines(buffer: &mut String, data: &str) -> Vec<String> {
    buffer.push_str(data);
    let mut lines = Vec::new();
    while let Some(position) = buffer.find('\n') {
        lines.push(buffer[..position].to_string());
        buffer.drain(..=position);
    }
    lines
}

/// Registry of resident monitor tasks, keyed by connectionId. Same shape as
/// the scheduler TaskProvider's registries: a sync-Mutex map of shared task
/// handles owned by the plugin for its whole lifetime. Purely in-memory —
/// tasks die with the sidecar and are never persisted.
pub struct MonitorRegistry {
    tasks: Mutex<HashMap<String, Arc<TaskHandle>>>,
}

/// Shared state of one connection's monitor: lifecycle fields, the two
/// rings and the counters' diff baseline. Plain `std` locks — critical
/// sections are field-sized and never span an await.
pub(crate) struct TaskHandle {
    state: RwLock<MonitorState>,
    error: RwLock<Option<String>>,
    since: RwLock<u64>,
    iface: RwLock<Option<String>>,
    fast: RwLock<VecDeque<Point>>,
    slow: RwLock<VecDeque<DetailPoint>>,
    last: RwLock<Option<Counters>>,
    cancel: watch::Sender<bool>,
    /// Set once the fast loop has exited (failed, unsupported or cancelled).
    done: AtomicBool,
    loops: Mutex<Vec<JoinHandle<()>>>,
}

/// One row of `monitor/status`. `error`/`primaryInterface` appear only when
/// present (protocol: fields exist only when they carry a value).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStatusRow<'a> {
    connection_id: &'a str,
    state: MonitorState,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    since: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_interface: Option<String>,
}

impl MonitorRegistry {
    pub(crate) fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
        }
    }

    /// `monitor/start`: spawns the fast+slow collector loops for a
    /// connection's live session. Idempotent — an existing task (in any
    /// state) is returned as-is; revive a failed task by stopping it first.
    pub async fn start(
        &self,
        ssh: &SshRuntime,
        connection_id: &str,
        spawner: &tokio::runtime::Runtime,
    ) -> Result<Value, String> {
        if let Some(task) = self.task(connection_id) {
            return Ok(task.state_and_since());
        }
        if self.task_count() >= MONITOR_TASK_LIMIT {
            return Err(format!("monitor task limit reached ({MONITOR_TASK_LIMIT})"));
        }
        let handle = ssh
            .live_handle_for_connection(connection_id)
            .await
            .ok_or_else(|| format!("no live SSH session for connection '{connection_id}'"))?;
        // Re-check under the lock: two concurrent starts for one connection
        // must stay idempotent and the limit must hold against the race.
        let mut tasks = self.lock_tasks();
        if let Some(existing) = tasks.get(connection_id) {
            return Ok(existing.state_and_since());
        }
        if tasks.len() >= MONITOR_TASK_LIMIT {
            return Err(format!("monitor task limit reached ({MONITOR_TASK_LIMIT})"));
        }
        let (cancel, cancel_rx) = watch::channel(false);
        let task = Arc::new(TaskHandle {
            state: RwLock::new(MonitorState::Connecting),
            error: RwLock::new(None),
            since: RwLock::new(now_ms()),
            iface: RwLock::new(None),
            fast: RwLock::new(VecDeque::new()),
            slow: RwLock::new(VecDeque::new()),
            last: RwLock::new(None),
            cancel,
            done: AtomicBool::new(false),
            loops: Mutex::new(Vec::new()),
        });
        let fast = spawner.spawn(run_fast_loop(
            Arc::clone(&handle),
            Arc::clone(&task),
            cancel_rx.clone(),
        ));
        let slow = spawner.spawn(run_slow_loop(handle, Arc::clone(&task), cancel_rx));
        task.lock_loops().extend([fast, slow]);
        let payload = task.state_and_since();
        tasks.insert(connection_id.to_string(), Arc::clone(&task));
        Ok(payload)
    }

    /// `monitor/stop`: signals cancel, joins both loops with a shared 2s
    /// budget, then reports stopped. Idempotent — stopping an unknown
    /// connection still reports stopped (and removes the entry, so a later
    /// start can revive a failed task).
    pub async fn stop(&self, connection_id: &str) -> Result<Value, String> {
        let task = {
            let mut tasks = self.lock_tasks();
            tasks.remove(connection_id)
        };
        if let Some(task) = task {
            let _ = task.cancel.send(true);
            if !task.done.load(AtomicOrdering::Relaxed) {
                let loops = std::mem::take(&mut *task.lock_loops());
                // Shared deadline: both joins together must fit in 2s.
                let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                for handle in loops {
                    let _ = tokio::time::timeout_at(deadline, handle).await;
                }
            }
            *task.lock_state() = MonitorState::Stopped;
            *task.lock_error() = None;
            *task.lock_since() = now_ms();
        }
        Ok(json!({ "state": "stopped" }))
    }

    /// `monitor/status`: every resident task's lifecycle row.
    pub async fn status(&self) -> Value {
        let tasks = self.lock_tasks();
        let rows: Vec<Value> = tasks.iter().map(|(id, task)| task.status_row(id)).collect();
        json!({ "tasks": rows })
    }

    /// `monitor/snapshot`: per-connection state, newest sample, history
    /// tail and the latest detail burst. Connections without a task are
    /// omitted from the samples map.
    pub async fn snapshot(&self, params: &Value) -> Value {
        let requested: Option<Vec<String>> = params
            .get("connectionIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            });
        let points = clamp_points(params.get("points").and_then(Value::as_u64));
        let tasks = self.lock_tasks();
        let mut samples = serde_json::Map::new();
        for (id, task) in tasks.iter() {
            if let Some(ids) = &requested {
                if !ids.iter().any(|wanted| wanted == id) {
                    continue;
                }
            }
            samples.insert(id.clone(), task.snapshot_entry(points));
        }
        json!({ "samples": Value::Object(samples) })
    }

    /// `monitor/details`: the latest slow-loop burst for one connection.
    pub async fn details(&self, connection_id: &str) -> Result<Value, String> {
        let task = self.task(connection_id).ok_or_else(|| {
            format!("monitor task was not found for connection '{connection_id}'")
        })?;
        let latest = task.lock_slow().back().cloned();
        match latest {
            Some(burst) => serde_json::to_value(&burst.details)
                .map_err(|error| format!("failed to serialize monitor details: {error}")),
            None => Err(format!(
                "no monitor detail burst has arrived yet for connection '{connection_id}'"
            )),
        }
    }

    fn lock_tasks(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<TaskHandle>>> {
        self.tasks.lock().expect("monitor registry poisoned")
    }

    fn task(&self, connection_id: &str) -> Option<Arc<TaskHandle>> {
        self.lock_tasks().get(connection_id).cloned()
    }

    fn task_count(&self) -> usize {
        self.lock_tasks().len()
    }
}

impl TaskHandle {
    fn lock_state(&self) -> std::sync::RwLockWriteGuard<'_, MonitorState> {
        self.state.write().expect("monitor state poisoned")
    }

    fn lock_error(&self) -> std::sync::RwLockWriteGuard<'_, Option<String>> {
        self.error.write().expect("monitor error poisoned")
    }

    fn lock_since(&self) -> std::sync::RwLockWriteGuard<'_, u64> {
        self.since.write().expect("monitor since poisoned")
    }

    fn lock_iface(&self) -> std::sync::RwLockWriteGuard<'_, Option<String>> {
        self.iface.write().expect("monitor iface poisoned")
    }

    fn lock_fast(&self) -> std::sync::RwLockWriteGuard<'_, VecDeque<Point>> {
        self.fast.write().expect("monitor fast ring poisoned")
    }

    fn lock_slow(&self) -> std::sync::RwLockWriteGuard<'_, VecDeque<DetailPoint>> {
        self.slow.write().expect("monitor slow ring poisoned")
    }

    fn lock_last(&self) -> std::sync::RwLockWriteGuard<'_, Option<Counters>> {
        self.last.write().expect("monitor last poisoned")
    }

    fn lock_loops(&self) -> std::sync::MutexGuard<'_, Vec<JoinHandle<()>>> {
        self.loops.lock().expect("monitor loops poisoned")
    }

    /// `{state, since}` payload for start's idempotent reply.
    fn state_and_since(&self) -> Value {
        json!({
            "state": *self.state.read().expect("monitor state poisoned"),
            "since": *self.since.read().expect("monitor since poisoned"),
        })
    }

    fn status_row(&self, connection_id: &str) -> Value {
        let row = TaskStatusRow {
            connection_id,
            state: *self.state.read().expect("monitor state poisoned"),
            error: self.error.read().expect("monitor error poisoned").clone(),
            since: *self.since.read().expect("monitor since poisoned"),
            primary_interface: self.iface.read().expect("monitor iface poisoned").clone(),
        };
        serde_json::to_value(row).expect("monitor status row serializes")
    }

    /// One connection's `samples` entry: state, newest live sample (only
    /// in the live state), the history tail and the latest details.
    fn snapshot_entry(&self, points: usize) -> Value {
        let state = *self.state.read().expect("monitor state poisoned");
        let (live, history) = {
            let ring = self.fast.read().expect("monitor fast ring poisoned");
            let live = if state == MonitorState::Live {
                ring.iter()
                    .rev()
                    .find_map(|point| match point {
                        Point::Sample(sample) => Some(serde_json::to_value(sample).ok()?),
                        Point::Gap(_) => None,
                    })
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let history: Vec<Value> = ring_tail(&ring, points)
                .iter()
                .map(|point| serde_json::to_value(point).expect("ring point serializes"))
                .collect();
            (live, history)
        };
        let details = self
            .slow
            .read()
            .expect("monitor slow ring poisoned")
            .back()
            .map(|burst| serde_json::to_value(&burst.details).expect("details serialize"))
            .unwrap_or(Value::Null);
        json!({
            "state": state,
            "live": live,
            "history": history,
            "details": details,
        })
    }
}

/// Fast-loop ingest of one complete line: state flips, baseline and ring
/// pushes. The cap line is only traced (its payload has no protocol slot);
/// the unsupported line is the terminal state; counter rows keep the diff
/// chain rolling.
fn ingest_counter_line(task: &TaskHandle, line: &str) {
    match parse_counter_line(line) {
        CounterLine::Cap(uname) => {
            eprintln!("[ssh-trace] monitor: remote reports {uname}");
        }
        CounterLine::Unsupported(reason) => {
            let mut state = task.lock_state();
            if *state != MonitorState::Unsupported {
                eprintln!("[ssh-trace] monitor unsupported on remote: {reason}");
                *state = MonitorState::Unsupported;
                drop(state);
                *task.lock_error() = None;
                *task.lock_iface() = None;
                *task.lock_since() = now_ms();
            }
        }
        CounterLine::Counters(counters) => {
            let t = now_ms();
            // First counter row flips connecting → live and only sets the
            // baseline; every later row diffs into a sample.
            if *task.state.read().expect("monitor state poisoned") == MonitorState::Connecting {
                *task.lock_state() = MonitorState::Live;
                *task.lock_since() = t;
            }
            let prev = task.lock_last().replace(counters.clone());
            if let Some(prev) = &prev {
                let point = next_point(prev, &counters, t);
                push_fast(task, point);
            }
            *task.lock_iface() = Some(counters.iface);
        }
        CounterLine::Ignored => {}
    }
}

/// Pushes one point into the fast ring, trimming past [`FAST_RING_CAP`].
fn push_fast(task: &TaskHandle, point: Point) {
    let mut ring = task.lock_fast();
    ring.push_back(point);
    if ring.len() > FAST_RING_CAP {
        ring.pop_front();
    }
}

/// Pushes one detail burst into the slow ring, trimming past
/// [`SLOW_RING_CAP`].
fn push_slow(task: &TaskHandle, point: DetailPoint) {
    let mut ring = task.lock_slow();
    ring.push_back(point);
    if ring.len() > SLOW_RING_CAP {
        ring.pop_front();
    }
}

/// Marks the task failed with an error payload — unless it is already
/// terminal (unsupported reported earlier, or a stop won the race). The
/// double-checked transition keeps stop-vs-EOF races from resurrecting a
/// stopped task as failed.
fn fail(task: &TaskHandle, error: String) {
    if matches!(
        *task.state.read().expect("monitor state poisoned"),
        MonitorState::Unsupported | MonitorState::Stopped
    ) {
        return;
    }
    let mut state = task.lock_state();
    if matches!(*state, MonitorState::Unsupported | MonitorState::Stopped) {
        return;
    }
    *state = MonitorState::Failed;
    drop(state);
    *task.lock_error() = Some(error);
    *task.lock_since() = now_ms();
    task.done.store(true, AtomicOrdering::Relaxed);
}

/// Fast loop: one channel per attempt streaming `MON_FAST_SCRIPT`. 3s of
/// line silence reopens the channel; two consecutive reopen failures mark
/// the task failed. Every exit path closes the channel explicitly —
/// dropping a russh Channel never sends SSH_MSG_CHANNEL_CLOSE, so the
/// remote `while` loop would keep running forever (the invariant
/// documented at exec.rs's abort_exec_channel).
async fn run_fast_loop(
    handle: Arc<Handle<SshClient>>,
    task: Arc<TaskHandle>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut reopen_failures = 0_u32;
    loop {
        if *cancel.borrow() {
            return;
        }
        let mut channel = match open_monitor_channel(&handle, MON_FAST_SCRIPT).await {
            Ok(channel) => {
                reopen_failures = 0;
                channel
            }
            Err(error) => {
                reopen_failures += 1;
                if should_fail_after_reopen(reopen_failures) {
                    fail(&task, format!("monitor channel failed: {error}"));
                    return;
                }
                if wait_cancelled_for(REOPEN_BACKOFF, &mut cancel).await {
                    return;
                }
                continue;
            }
        };
        let mut remote_closed = false;
        let mut pending = String::new();
        loop {
            tokio::select! {
                biased;
                _ = wait_cancelled_or_dropped(&mut cancel) => {
                    close_channel(&mut channel).await;
                    return;
                }
                waited = tokio::time::timeout(FAST_WATCHDOG, channel.wait()) => match waited {
                    // Watchdog: the stream stalled without an EOF — close
                    // and reopen (the counters keep their kernel values, so
                    // the diff chain survives the restart).
                    Err(_) => {
                        close_channel(&mut channel).await;
                        break;
                    }
                    // EOF: the script never exits by itself, so a closed
                    // channel means the transport died — failed, no retry.
                    Ok(None) => {
                        remote_closed = true;
                        break;
                    }
                    Ok(Some(ChannelMsg::Data { ref data })) => {
                        for line in drain_lines(&mut pending, &String::from_utf8_lossy(data)) {
                            ingest_counter_line(&task, &line);
                        }
                    }
                    Ok(Some(_)) => {}
                }
            }
        }
        if remote_closed {
            fail(
                &task,
                "monitor channel was closed by the remote host".to_string(),
            );
            return;
        }
    }
}

/// Slow loop: one channel streaming `MON_SLOW_SCRIPT`, one detail burst per
/// 5s tick into the slow ring. The fast loop owns the task state — a
/// slow-channel failure only freezes details until the next start, so this
/// loop exits silently on EOF (still closing its channel explicitly).
async fn run_slow_loop(
    handle: Arc<Handle<SshClient>>,
    task: Arc<TaskHandle>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut channel = match open_monitor_channel(&handle, MON_SLOW_SCRIPT).await {
        Ok(channel) => channel,
        Err(error) => {
            eprintln!("[ssh-trace] monitor slow channel unavailable: {error}");
            return;
        }
    };
    let mut pending = String::new();
    let mut burst: Vec<String> = Vec::new();
    loop {
        tokio::select! {
            biased;
            _ = wait_cancelled_or_dropped(&mut cancel) => {
                close_channel(&mut channel).await;
                return;
            }
            message = channel.wait() => match message {
                None => return,
                Some(ChannelMsg::Data { ref data }) => {
                    for line in drain_lines(&mut pending, &String::from_utf8_lossy(data)) {
                        let trimmed = line.trim();
                        if trimmed == "dbx-det end" {
                            let lines: Vec<&str> =
                                burst.iter().map(String::as_str).collect();
                            push_slow(
                                &task,
                                DetailPoint {
                                    t: now_ms(),
                                    details: parse_detail_block(&lines),
                                },
                            );
                            burst.clear();
                        } else if trimmed.starts_with("dbx-det ") {
                            // A truncated burst (no end marker yet) must not
                            // grow unbounded — a real burst stays far below
                            // this ceiling.
                            if burst.len() >= 64 {
                                burst.clear();
                            }
                            burst.push(trimmed.to_string());
                        }
                    }
                }
                Some(_) => {}
            }
        }
    }
}

/// Dials a fresh channel and starts one monitor script on it. No env
/// merging and no PTY (plugin-internal plumbing, same as the metrics
/// collector path); a failed exec still closes the dialed channel.
async fn open_monitor_channel(
    handle: &Handle<SshClient>,
    script: &str,
) -> Result<russh::Channel<Msg>, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("Failed to open monitor channel: {error}"))?;
    if let Err(error) = channel.exec(true, script.as_bytes()).await {
        let message = format!("Failed to start monitor script: {error}");
        close_channel(&mut channel).await;
        return Err(message);
    }
    Ok(channel)
}

/// Explicitly closes a monitor channel (EOF + CLOSE) so sshd reaps the
/// remote script. Dropping the russh Channel is NOT enough — it never
/// sends SSH_MSG_CHANNEL_CLOSE and the remote `while` loop would leak
/// (same invariant as exec.rs's abort_exec_channel).
async fn close_channel(channel: &mut russh::Channel<Msg>) {
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

/// Resolves once cancellation is requested OR the registry drops the
/// sender (entry removed — the task is being torn down either way). This
/// is deliberately the opposite of `exec::wait_cancelled`'s
/// sender-dropped-means-never-cancel: there the dropped sender belongs to a
/// still-tracked run, here it means the task is already gone.
async fn wait_cancelled_or_dropped(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Cancellable backoff sleep; resolves true when the task should exit
/// (cancel requested or the registry dropped the sender).
async fn wait_cancelled_for(delay: Duration, cancel: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        biased;
        _ = wait_cancelled_or_dropped(cancel) => true,
        _ = tokio::time::sleep(delay) => false,
    }
}

/// Unix milliseconds for the sidecar-arrival timestamps (`Sample.t`, the
/// `since` lifecycle stamps). Remote clocks are never consulted.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    /// Fixture origin: `/proc/stat` (`cpu  user nice system idle iowait irq
    /// softirq`), `/proc/meminfo` kB rows and `/proc/net/dev` byte counters,
    /// as emitted by the printf in `MON_FAST_SCRIPT`.
    #[allow(clippy::too_many_arguments)]
    fn counters(
        t: u64,
        cpu_total: u64,
        cpu_idle: u64,
        mem_total_kb: u64,
        mem_avail_kb: u64,
        rx: u64,
        tx: u64,
        iface: &str,
    ) -> Counters {
        Counters {
            t,
            cpu_total,
            cpu_idle,
            mem_total_kb,
            mem_avail_kb,
            rx,
            tx,
            iface: iface.to_string(),
        }
    }

    #[test]
    fn parses_a_valid_counter_line() {
        let line = "dbx-mon c=1234567,987654 m=16384000,8192000 n=1048576,2048,eth0";
        match parse_counter_line(line) {
            CounterLine::Counters(c) => {
                assert_eq!(c.cpu_total, 1234567);
                assert_eq!(c.cpu_idle, 987654);
                assert_eq!(c.mem_total_kb, 16384000);
                assert_eq!(c.mem_avail_kb, 8192000);
                assert_eq!(c.rx, 1048576);
                assert_eq!(c.tx, 2048);
                assert_eq!(c.iface, "eth0");
            }
            other => panic!("expected counters, got {other:?}"),
        }
    }

    #[test]
    fn cap_and_unsupported_lines_carry_their_payloads() {
        assert_eq!(
            parse_counter_line("dbx-mon-cap Linux 6.1.0-virt"),
            CounterLine::Cap("Linux 6.1.0-virt".into())
        );
        assert_eq!(
            parse_counter_line("dbx-mon-unsupported Darwin"),
            CounterLine::Unsupported("Darwin".into())
        );
    }

    #[test]
    fn malformed_lines_are_ignored() {
        for line in [
            "",
            "dbx-mon",
            "dbx-mon garbage",
            "dbx-mon c=1,2 m=3",
            "dbx-mon c=x,y m=1,2 n=1,2,eth0",
            "dbx-mon c=1,2 m=1,2 n=1,2",
            "dbx-mon c=1,2 m=1,2 n=1,2,",
            // The load1 counter is gone from the fast loop: an l= field is
            // unknown now and the whole row must be dropped, not half-parsed.
            "dbx-mon c=1,2 m=1,2 n=1,2,eth0 l=zz",
            "dbx-mon c=1,2 m=1,2 n=1,2,eth0 l=1",
            "dbx-mon c=1,2 m=-1,2 n=1,2,eth0",
            "dbx-det uptime=12",
            "hello",
        ] {
            assert!(
                matches!(parse_counter_line(line), CounterLine::Ignored),
                "line {line:?}"
            );
        }
    }

    #[test]
    fn memavailable_fallback_value_round_trips() {
        // When the kernel has no MemAvailable row the script recomputes it
        // as MemFree+Buffers+Cached+SReclaimable−Shmem (clamped ≥0) before
        // printing. This fixture is what that awk formula yields for
        // MemFree=1000 Buffers=200 Cached=300 SReclaimable=50 Shmem=80.
        assert_eq!(1000 + 200 + 300 + 50 - 80, 1470);
        match parse_counter_line("dbx-mon c=100,50 m=4000,1470 n=0,0,eth0") {
            CounterLine::Counters(c) => assert_eq!(c.mem_avail_kb, 1470),
            other => panic!("expected counters, got {other:?}"),
        }
        // The fallback expression must stay part of the script.
        assert!(
            MON_FAST_SCRIPT.contains("MemFree"),
            "fallback formula missing"
        );
        assert!(
            MON_FAST_SCRIPT.contains("SReclaimable"),
            "fallback formula missing"
        );
    }

    #[test]
    fn diff_computes_cpu_memory_and_rates() {
        let prev = counters(
            1000, 1_000_000, 900_000, 16_384_000, 8_192_000, 1_048_576, 2048, "eth0",
        );
        let next = counters(
            2000,
            1_100_000,
            950_000,
            16_384_000,
            8_192_000,
            1_048_576 + 51_200,
            2048 + 2560,
            "eth0",
        );
        let sample = diff_counters(&prev, &next, 2000);
        assert_eq!(sample.t, 2000);
        // (Δtotal 100000 − Δidle 50000) / Δtotal → 50.0%.
        assert_eq!(sample.cpu_pct, 50.0);
        assert_eq!(sample.mem_total_mb, 16000.0);
        assert_eq!(sample.mem_used_mb, 8000.0);
        // Δbytes over the 1s window ÷ 1024 → KiB/s.
        assert_eq!(sample.net_rx_kbps, 50.0);
        assert_eq!(sample.net_tx_kbps, 2.5);
        assert_eq!(sample.iface.as_deref(), Some("eth0"));
    }

    #[test]
    fn cpu_clamps_into_0_100_and_zero_delta_is_zero() {
        // Counter reset between reads: Δidle would exceed Δtotal — saturate,
        // don't panic, clamp to 0.
        let prev = counters(1000, 100, 10, 1000, 500, 0, 0, "eth0");
        let next = counters(2000, 200, 200, 1000, 500, 0, 0, "eth0");
        assert_eq!(diff_counters(&prev, &next, 2000).cpu_pct, 0.0);
        // A fully busy second → exactly 100.0.
        let prev = counters(1000, 100, 0, 1000, 500, 0, 0, "eth0");
        let next = counters(2000, 200, 0, 1000, 500, 0, 0, "eth0");
        assert_eq!(diff_counters(&prev, &next, 2000).cpu_pct, 100.0);
        // Δtotal == 0 → cpu 0 (no division by zero).
        let same = counters(1000, 500, 100, 1000, 500, 0, 0, "eth0");
        assert_eq!(diff_counters(&same, &same, 2000).cpu_pct, 0.0);
    }

    #[test]
    fn zero_elapsed_time_yields_zero_rates_not_nan() {
        // Same arrival stamp as the previous read — the loop records a Gap
        // and drops the sample; the diff itself must stay finite anyway.
        let prev = counters(5000, 1_000_000, 900_000, 1000, 500, 4096, 4096, "eth0");
        let next = counters(5000, 1_100_000, 900_000, 1000, 500, 8192, 8192, "eth0");
        let sample = diff_counters(&prev, &next, 5000);
        assert_eq!(sample.net_rx_kbps, 0.0);
        assert_eq!(sample.net_tx_kbps, 0.0);
        assert_eq!(sample.cpu_pct, 0.0);
    }

    #[test]
    fn iface_change_marks_a_gap_for_the_caller() {
        // The loop compares ifaces itself, pushes a Gap and re-baselines
        // instead of sampling across the switch; the diff of a changed
        // iface is caller-discarded, so only the payload routing matters.
        let prev = counters(1000, 1000, 500, 1000, 500, 100, 100, "eth0");
        let next = counters(2000, 2000, 500, 1000, 500, 300, 300, "eth1");
        assert_ne!(prev.iface, next.iface);
        let sample = diff_counters(&prev, &next, 2000);
        assert_eq!(sample.iface.as_deref(), Some("eth1"));
        let gap = serde_json::to_value(GapPoint { t: 999, gap: true }).unwrap();
        assert_eq!(gap, json!({"t": 999, "gap": true}));
    }

    #[test]
    fn sample_serializes_camel_case_and_omits_absent_iface() {
        let sample = Sample {
            t: 2000,
            cpu_pct: 12.3,
            mem_total_mb: 16000.0,
            mem_used_mb: 8000.0,
            net_rx_kbps: 50.0,
            net_tx_kbps: 2.5,
            iface: None,
        };
        let value = serde_json::to_value(&sample).unwrap();
        assert_eq!(
            value,
            json!({
                "t": 2000,
                "cpuPct": 12.3,
                "memTotalMb": 16000.0,
                "memUsedMb": 8000.0,
                "netRxKbps": 50.0,
                "netTxKbps": 2.5
            })
        );
        let with_iface = Sample {
            iface: Some("eth0".into()),
            ..sample
        };
        assert_eq!(
            serde_json::to_value(&with_iface).unwrap()["iface"],
            json!("eth0")
        );
    }

    #[test]
    fn parses_a_full_detail_block() {
        let details = parse_detail_block(&[
            "dbx-det load=0.10 0.20 0.30",
            "dbx-det uptime=3600",
            "dbx-det disk=/,10485760,2097152",
            "dbx-det disk=/home,5242880,1048576",
            "dbx-det user=alice,pts/0,10.0.0.5",
            "dbx-det end",
            // A next-burst line after the end marker must not leak in.
            "dbx-det load=9.9 9.9 9.9",
        ]);
        assert_eq!(details.load1, 0.1);
        assert_eq!(details.load5, 0.2);
        assert_eq!(details.load15, 0.3);
        assert_eq!(details.uptime_sec, 3600);
        assert_eq!(details.disks.len(), 2);
        assert_eq!(details.disks[0].mount, "/");
        assert_eq!(details.disks[0].total_kb, 10485760);
        assert_eq!(details.disks[0].used_kb, 2097152);
        assert_eq!(details.disks[1].mount, "/home");
        assert_eq!(details.users.len(), 1);
        assert_eq!(details.users[0].user, "alice");
        assert_eq!(details.users[0].tty, "pts/0");
        assert_eq!(details.users[0].from, "10.0.0.5");
    }

    #[test]
    fn details_serialize_camel_case() {
        let details = parse_detail_block(&[
            "dbx-det load=0.10 0.20 0.30",
            "dbx-det uptime=3600",
            "dbx-det disk=/,10485760,2097152",
            "dbx-det user=alice,pts/0,10.0.0.5",
        ]);
        let value = serde_json::to_value(&details).unwrap();
        assert_eq!(value["uptimeSec"], json!(3600));
        assert_eq!(value["load1"], json!(0.1));
        assert_eq!(
            value["disks"][0],
            json!({"mount": "/", "totalKb": 10485760, "usedKb": 2097152})
        );
        assert_eq!(
            value["users"][0],
            json!({"user": "alice", "tty": "pts/0", "from": "10.0.0.5"})
        );
    }

    #[test]
    fn detail_block_without_end_marker_still_parses() {
        let details = parse_detail_block(&[
            "dbx-det load=1 2 3",
            "dbx-det uptime=10",
            "dbx-det disk=/data,100,50",
        ]);
        assert_eq!(details.uptime_sec, 10);
        assert_eq!(details.disks.len(), 1);
        assert_eq!(details.disks[0].mount, "/data");
        assert_eq!(details.users.len(), 0);
        assert_eq!(details.load5, 2.0);
    }

    #[test]
    fn malformed_detail_lines_are_skipped() {
        let details = parse_detail_block(&[
            "dbx-det load=not numbers",
            "dbx-det uptime=abc",
            "dbx-det disk=/bad,notanumber,50",
            "dbx-det user=",
            "dbx-det whatever=1",
            "",
        ]);
        assert_eq!(details, Details::default());
    }

    #[test]
    fn user_row_degrades_to_empty_from_without_the_paren_field() {
        // The script always prints three comma-separated columns; a local
        // login without a remote host leaves the third one empty.
        let details = parse_detail_block(&["dbx-det user=carol,tty2,"]);
        assert_eq!(
            details.users[0],
            UserRow {
                user: "carol".into(),
                tty: "tty2".into(),
                from: String::new(),
            }
        );
    }

    /// Runs the who→user awk program against one fixture line (real awk:
    /// the GNU-coreutils `who` shape that motivated the column-3 bug is
    /// exactly what this test pins down).
    /// who→user awk as embedded in `MON_SLOW_SCRIPT` (the `contains`
    /// assertion below pins the two together). user/tty stay verbatim;
    /// `from` is the first `(...)`-wrapped field with its parens stripped —
    /// GNU `who` prints the login DATE in column 3 and the remote host
    /// paren-wrapped after the time, or nothing for local logins.
    const MON_WHO_AWK: &str = "{f=\"\"; for(i=3;i<=NF;i++) if($i ~ /^\\(.*\\)$/) {f=substr($i,2,length($i)-2); break}; printf \"dbx-det user=%s,%s,%s\\n\", $1, $2, f}";

    /// Runs the who→user awk program against one fixture line (real awk:
    /// the GNU-coreutils `who` shape that motivated the column-3 bug is
    /// exactly what this test pins down).
    fn run_awk(program: &str, line: &str) -> String {
        use std::io::Write as _;
        let mut child = std::process::Command::new("awk")
            .arg(program)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("awk available on dev hosts");
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(line.as_bytes())
            .expect("awk reads its stdin");
        let output = child.wait_with_output().expect("awk exits");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn who_awk_reads_the_host_from_the_paren_wrapped_field_not_column_3() {
        // GNU coreutils `who`: `alice pts/0 2026-11-15 09:12 (10.0.0.8)` —
        // the third column is the login DATE, the remote host arrives
        // paren-wrapped after the time. The program must take `from` from
        // the first paren-wrapped field (parens stripped), not column 3.
        let out = run_awk(MON_WHO_AWK, "alice pts/0 2026-11-15 09:12 (10.0.0.8)");
        assert_eq!(out.trim_end(), "dbx-det user=alice,pts/0,10.0.0.8");
        // Local login: no paren-wrapped host at all → empty from-column.
        let out = run_awk(MON_WHO_AWK, "bob tty1 2026-11-15 09:12");
        assert_eq!(out.trim_end(), "dbx-det user=bob,tty1,");
        // Drift guard: the script must run exactly this program.
        assert!(
            MON_SLOW_SCRIPT.contains(MON_WHO_AWK),
            "MON_SLOW_SCRIPT drifted from MON_WHO_AWK"
        );
    }

    #[test]
    fn unvalidated_fallback_iface_never_reaches_the_counter_eval() {
        // The /proc/net/dev fallback name must re-enter the same charset
        // whitelist before `eval "$(awk -v IF="$iface" …)"`. Two checks:
        // the gate itself clears hostile names under POSIX sh (a cleared
        // iface skips the `?*` eval case, so n_rx/n_tx stay 0 — "no NIC"
        // behaviour), and the script runs BOTH sources through it — exactly
        // two gates, the second sitting between the fallback read and the
        // eval.
        let gate = "case \"$iface\" in *[!A-Za-z0-9.@_-]*) iface=;; esac; ";
        for (name, kept) in [
            ("eth0", true),
            ("eth0.100", true),
            ("br-lan_1", true),
            ("bad$(id)", false),
            ("a b", false),
            ("x;y", false),
        ] {
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("iface=$1; {gate}printf '%s' \"$iface\""))
                .arg("sh")
                .arg(name)
                .output()
                .expect("/bin/sh available on dev hosts");
            let expected = if kept { name } else { "" };
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                expected,
                "iface {name:?}"
            );
        }
        let gates: Vec<usize> = MON_FAST_SCRIPT
            .match_indices(gate)
            .map(|(index, _)| index)
            .collect();
        assert_eq!(gates.len(), 2, "route and fallback ifaces share one gate");
        let fallback = MON_FAST_SCRIPT
            .find("/proc/net/dev")
            .expect("fallback source");
        let eval = MON_FAST_SCRIPT
            .find("eval \"$(awk -v IF=")
            .expect("counter eval");
        assert!(fallback < gates[1] && gates[1] < eval);
    }

    #[test]
    fn snapshot_points_clamp_into_1_cap() {
        assert_eq!(clamp_points(None), SNAPSHOT_DEFAULT_POINTS);
        assert_eq!(clamp_points(Some(0)), 1);
        assert_eq!(clamp_points(Some(5)), 5);
        assert_eq!(clamp_points(Some(10_000)), FAST_RING_CAP);
    }

    #[test]
    fn ring_tail_returns_oldest_first_slice_of_the_newest_points() {
        let mut ring = VecDeque::new();
        for index in 0..5_u64 {
            ring.push_back(Point::Sample(Sample {
                t: index,
                cpu_pct: index as f64,
                mem_total_mb: 0.0,
                mem_used_mb: 0.0,
                net_rx_kbps: 0.0,
                net_tx_kbps: 0.0,
                iface: Some("eth0".into()),
            }));
        }
        // The tail keeps the NEWEST points, oldest-first for the chart.
        let tail = ring_tail(&ring, 2);
        assert_eq!(tail.len(), 2);
        match (&tail[0], &tail[1]) {
            (Point::Sample(a), Point::Sample(b)) => {
                assert_eq!(a.t, 3);
                assert_eq!(b.t, 4);
            }
            other => panic!("expected samples, got {other:?}"),
        }
        // More points than the ring holds → the whole ring, oldest first.
        let whole = ring_tail(&ring, 10);
        assert_eq!(whole.len(), 5);
        match &whole[0] {
            Point::Sample(sample) => assert_eq!(sample.t, 0),
            other => panic!("expected a sample, got {other:?}"),
        }
        assert!(ring_tail(&VecDeque::new(), 3).is_empty());
    }

    #[test]
    fn iface_switch_yields_gap_then_rebaseline_sample() {
        // The switch row itself produces only the Gap marker; the caller
        // stores it as the new baseline and the NEXT row samples against it
        // (no rate is ever computed across the switch).
        let eth0 = counters(1000, 1000, 500, 1000, 500, 100, 100, "eth0");
        let eth1 = counters(2000, 2000, 500, 1000, 500, 300, 300, "eth1");
        assert!(matches!(
            next_point(&eth0, &eth1, 2000),
            Point::Gap(GapPoint { t: 2000, gap: true })
        ));
        let follow = counters(3000, 3000, 500, 1000, 500, 400, 400, "eth1");
        match next_point(&eth1, &follow, 3000) {
            Point::Sample(sample) => {
                assert_eq!(sample.iface.as_deref(), Some("eth1"));
                assert_eq!(sample.cpu_pct, 100.0);
            }
            other => panic!("expected a sample after the re-baseline, got {other:?}"),
        }
    }

    #[test]
    fn partial_lines_reassemble_across_chunks() {
        // SSH data chunks are not line-aligned: a printf row can arrive in
        // two reads; the trailing partial line stays buffered.
        let mut pending = String::new();
        let lines = drain_lines(&mut pending, "dbx-mon c=1,2 m=3,4");
        assert!(lines.is_empty());
        assert_eq!(pending, "dbx-mon c=1,2 m=3,4");
        let lines = drain_lines(
            &mut pending,
            " n=5,6,eth0\ndbx-mon c=8,9 m=10,11 n=12,13,eth1\n",
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "dbx-mon c=1,2 m=3,4 n=5,6,eth0");
        assert_eq!(lines[1], "dbx-mon c=8,9 m=10,11 n=12,13,eth1");
        assert!(pending.is_empty());
    }

    #[test]
    fn second_consecutive_reopen_failure_is_terminal() {
        // The reopen ladder: one failed reopen backs off and retries, the
        // second consecutive failure reports `failed` and stops the loop.
        assert!(!should_fail_after_reopen(0));
        assert!(!should_fail_after_reopen(1));
        assert!(should_fail_after_reopen(2));
        assert!(should_fail_after_reopen(3));
    }

    #[tokio::test]
    async fn reopen_backoff_is_interrupted_by_cancel() {
        // A cancel request must beat the 500ms backoff — otherwise
        // monitor/stop would wait out a full sleep per pending reopen.
        let (_tx, mut rx) = watch::channel(false);
        let started = std::time::Instant::now();
        assert!(!wait_cancelled_for(Duration::from_millis(50), &mut rx).await);
        assert!(started.elapsed() >= Duration::from_millis(50));

        let (tx, mut rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = tx.send(true);
        });
        let started = std::time::Instant::now();
        assert!(wait_cancelled_for(Duration::from_secs(60), &mut rx).await);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn slow_script_guards_procfs_and_exits_gracefully_before_its_loop() {
        // Same procfs guard style as the fast channel: without the /proc
        // files the slow readers need, the script echoes the pre-existing
        // end marker and exits 0 — an empty-but-valid burst, then a clean
        // EOF (details just freeze). No new line shape enters the protocol.
        let guard_at = MON_SLOW_SCRIPT
            .find("[ -r /proc/loadavg ] && [ -r /proc/uptime ] || { echo \"dbx-det end\"; exit 0; }; ")
            .expect("slow procfs guard with graceful end-marker exit");
        assert_eq!(guard_at, 0, "guard runs before the loop");
        assert!(
            guard_at < MON_SLOW_SCRIPT.find("while :; do").expect("slow loop"),
            "guard precedes the burst loop"
        );
        assert!(!MON_SLOW_SCRIPT.contains("dbx-det-unsupported"));
    }
}
