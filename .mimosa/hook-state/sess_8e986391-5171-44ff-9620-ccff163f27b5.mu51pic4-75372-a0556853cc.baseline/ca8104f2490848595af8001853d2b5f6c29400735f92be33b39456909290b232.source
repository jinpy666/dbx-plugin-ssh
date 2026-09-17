//! Extended server metrics: per-interface network rates and top processes,
//! appended to the base CPU/memory/disk sample from [`crate::exec`].
//!
//! The collector stays a single POSIX shell command in the same style as the
//! base script: two network counter snapshots separated by `sleep 1`
//! (`/proc/net/dev` on Linux, `netstat -ibn` on macOS/BSD) and one `ps`
//! invocation sorted by CPU. CPU/memory/load/uptime prefer the Linux `/proc`
//! readers and fall back to sysctl/`vm_stat`/`iostat` on macOS; the fallback
//! branches re-emit the same line shapes so the shared parsers stay
//! unchanged. All parsing lives in pure functions so Linux and macOS sample
//! fixtures can be unit-tested without a server.

use std::collections::BTreeMap;

use russh::client::Handle;
use serde::Serialize;

use crate::exec::exec_plain;
use crate::ssh::SshClient;

/// Seconds between the two network counter snapshots (the `sleep 1` in the
/// collector script); used as the denominator for B/s rates.
const NET_SAMPLE_INTERVAL_SECS: f64 = 1.0;
/// Cap for the process command column so the payload stays small.
const PROCESS_COMMAND_MAX_CHARS: usize = 120;
const PROCESS_TOP_LIMIT: usize = 8;

const METRICS_SCRIPT: &str = concat!(
    "echo \"hostname=$(hostname 2>/dev/null)\"; ",
    "echo \"kernel=$(uname -r 2>/dev/null)\"; ",
    // Linux /proc first; macOS/BSD falls back to sysctl (braces stripped so
    // the parser sees three plain floats).
    "echo \"loadavg=$(cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')\"; ",
    // /proc/uptime is two floats; kern.boottime is `{ sec = N, usec = … }` —
    // capture the first `=` value (greedy `.*sec` would grab `usec`).
    "if [ -r /proc/uptime ]; then echo \"uptime=$(cat /proc/uptime 2>/dev/null)\"; ",
    "else boot=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^=]*= *\\([0-9][0-9]*\\).*/\\1/p'); ",
    "[ -n \"$boot\" ] && echo \"uptime=$(( $(date +%s) - boot ))\"; fi; ",
    "echo \"nproc=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)\"; ",
    // Network + processes run before the --mem--/--cpu--/--df-- sections so
    // the base parser safely skips these lines (its section state is still
    // empty here and none of the key=value prefixes can match).
    "echo '--net--'; ",
    "if [ -r /proc/net/dev ]; then cat /proc/net/dev 2>/dev/null; ",
    "elif command -v netstat >/dev/null 2>&1; then netstat -ibn 2>/dev/null; fi; ",
    "echo '--net2--'; sleep 1; ",
    "if [ -r /proc/net/dev ]; then cat /proc/net/dev 2>/dev/null; ",
    "elif command -v netstat >/dev/null 2>&1; then netstat -ibn 2>/dev/null; fi; ",
    "echo '--ps--'; ",
    "(ps -eo pid=,user=,pcpu=,pmem=,args= 2>/dev/null || true) | sort -k3,3nr | head -n 8; ",
    "echo '--psm--'; ",
    "(ps -eo pid=,user=,pcpu=,pmem=,args= 2>/dev/null || true) | sort -k4,4nr | head -n 8; ",
    // Inode usage: `df -iP` keeps the portable layout on Linux; on macOS
    // `-P` silently forces block mode (inode columns vanish), so Darwin must
    // use bare `df -i` to get real iused/ifree/%iused. Column differences
    // are handled by the parser, not the command.
    "echo '--dfi--'; ",
    "if [ \"$(uname -s 2>/dev/null)\" = Darwin ]; then df -i 2>/dev/null | tail -n +2 | head -n 24; ",
    "else df -iP 2>/dev/null | tail -n +2 | head -n 24; fi; ",
    "echo '--mem--'; ",
    "if [ -r /proc/meminfo ]; then grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null; ",
    // macOS: total from hw.memsize (bytes -> kB); available = free + inactive
    // + speculative pages (vm_stat values carry a trailing dot); swap from
    // vm.swapusage in MB — all re-emitted in meminfo `Key: value kB` shape
    // so the shared parser stays unchanged.
    "else echo \"MemTotal: $(($(sysctl -n hw.memsize 2>/dev/null)/1024)) kB\"; ",
    "pskb=$(($(sysctl -n vm.pagesize 2>/dev/null || sysctl -n hw.pagesize 2>/dev/null)/1024)); ",
    "vm_stat 2>/dev/null | awk -v pskb=\"$pskb\" '/Pages free:/{f=$NF} /Pages inactive:/{ia=$NF} /Pages speculative:/{sp=$NF} END{gsub(/\\./,\"\",f); gsub(/\\./,\"\",ia); gsub(/\\./,\"\",sp); if (f!=\"\") printf \"MemAvailable: %d kB\\n\", (f+ia+sp)*pskb}'; ",
    "sysctl -n vm.swapusage 2>/dev/null | awk -F'[ =M]+' '{if ($2 != \"\") printf \"SwapTotal: %d kB\\nSwapFree: %d kB\\n\", $2*1024, $6*1024}'; fi; ",
    "echo '--cpu--'; ",
    "if [ -r /proc/stat ]; then head -n 1 /proc/stat; sleep 0.4; head -n 1 /proc/stat; ",
    // macOS: `iostat -c 2` takes two samples 1s apart; the second is a real
    // delta. The us/sy/id columns sit at a variable offset (per-disk columns
    // precede them), so anchor on the header row and re-emit the percentages
    // as two synthetic tick rows for the shared delta parser.
    "else iostat -c 2 2>/dev/null | awk 'NR==2{for(i=1;i<=NF;i++) if($i==\"id\") c=i} END{if(c){us=$(c-2); sy=$(c-1); id=$c; if (us ~ /^[0-9]+$/ && sy ~ /^[0-9]+$/ && id ~ /^[0-9]+$/) printf \"cpu  0 0 0 0 0\\ncpu  %d 0 0 %d 0\\n\", us+sy, id}}'; fi; ",
    "echo '--df--'; df -kP 2>/dev/null | tail -n +2 | head -n 24; ",
    // Distribution identification (IMPL_PLAN §1.5): both standard paths,
    // first present wins; neither existing (BSD, busybox minimal) leaves the
    // section empty and the payload fields omitted entirely.
    "echo '--os--'; cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null"
);

/// Collects the extended metrics sample over a new exec channel. Read-only
/// commands only; the extra `sleep 1` is bounded by the timeout below.
pub async fn collect_metrics(handle: &Handle<SshClient>) -> Result<serde_json::Value, String> {
    // Plugin-internal collector: no client setEnv so locale overrides on the
    // connection cannot reshape the output this parser expects.
    let outcome = exec_plain(
        handle,
        METRICS_SCRIPT,
        std::time::Duration::from_secs(30),
        &[],
    )
    .await?;
    if outcome.exit_code != 0 && outcome.output.is_empty() {
        return Err(format!("metrics collection failed: {}", outcome.output));
    }
    Ok(parse_metrics_output(&outcome.output))
}

/// Top-level section names of the metrics document, used by the MCP
/// `ssh_metrics` tool's optional `sections` projection so agents can pull
/// just the slice they need instead of the full document. Keep in sync with
/// what [`collect_metrics`] / [`parse_metrics_output`] actually emit.
pub const METRICS_SECTIONS: &[&str] = &[
    "hostname",
    "kernel",
    "uptimeSeconds",
    "cpu",
    "memory",
    "disks",
    "network",
    "processes",
    "topMemory",
    "osId",
    "osPretty",
];

/// Validates requested section names against the known universe. Unknown
/// names fail fast with the valid list in the error (matching the tool
/// layer's typo-guidance style) so a typo cannot silently return a
/// near-empty document.
pub fn validate_section_names(requested: &[String]) -> Result<(), String> {
    for name in requested {
        if !METRICS_SECTIONS.contains(&name.as_str()) {
            return Err(format!(
                "Unknown section: '{}'. Valid sections: {}",
                name,
                METRICS_SECTIONS.join(", ")
            ));
        }
    }
    Ok(())
}

/// Projects the metrics document onto the requested top-level sections.
/// Known-but-absent names (e.g. `osId` on hosts with no readable
/// os-release) are simply omitted. Pure so it is unit-testable without a
/// server.
pub fn project_metrics_sections(
    metrics: &mut serde_json::Value,
    requested: &[String],
) -> Result<(), String> {
    validate_section_names(requested)?;
    if let Some(object) = metrics.as_object_mut() {
        object.retain(|key, _| requested.iter().any(|name| name == key));
    }
    Ok(())
}

/// Parses the collector output into the metrics JSON object: the base
/// CPU/memory/disk document plus the `network`, `processes`, `topMemory` and
/// per-disk `inodeUsePercent` extensions. Pure so it can be unit-tested
/// without a server.
pub fn parse_metrics_output(output: &str) -> serde_json::Value {
    let mut root = crate::exec::parse_metrics_output(output);
    if let Some(object) = root.as_object_mut() {
        let network = serde_json::to_value(parse_network_samples(output)).unwrap_or_default();
        object.insert("network".to_string(), network);
        let processes = serde_json::to_value(parse_processes(output)).unwrap_or_default();
        object.insert("processes".to_string(), processes);
        let top_memory = serde_json::to_value(parse_process_lines(section_of(output, "--psm--")))
            .unwrap_or_default();
        object.insert("topMemory".to_string(), top_memory);
        // Distribution identification (IMPL_PLAN §1.5): `osId` / `osPretty`
        // are omitted entirely when the host has no readable os-release —
        // old callers and the frontend treat absence as "no badge".
        let (os_id, os_pretty) = parse_os_release(section_of(output, "--os--"));
        if let Some(id) = os_id {
            object.insert("osId".to_string(), serde_json::json!(id));
        }
        if let Some(pretty) = os_pretty {
            object.insert("osPretty".to_string(), serde_json::json!(pretty));
        }
    }
    merge_inode_usage(&mut root, section_of(output, "--dfi--"));
    root
}

/// Strips one optional layer of single or double quotes from an os-release
/// value (shell-style quoting, per the os-release spec).
fn unquote_os_release_value(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// Parses `ID=` and `PRETTY_NAME=` from an os-release style text into
/// `(osId, osPretty)`. `ID_LIKE` never matches the `ID=` prefix; CRLF and
/// quoted values are tolerated; blank or missing values yield `None` so the
/// metrics payload omits the fields instead of writing empty strings.
pub fn parse_os_release(text: &str) -> (Option<String>, Option<String>) {
    let mut os_id: Option<String> = None;
    let mut os_pretty: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("ID=") {
            if os_id.is_none() {
                let parsed = unquote_os_release_value(value);
                if !parsed.is_empty() {
                    os_id = Some(parsed.to_string());
                }
            }
        } else if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            if os_pretty.is_none() {
                let parsed = unquote_os_release_value(value);
                if !parsed.is_empty() {
                    os_pretty = Some(parsed.to_string());
                }
            }
        }
    }
    (os_id, os_pretty)
}

/// Merges per-mount inode usage into the base `disks` array as an additive
/// `inodeUsePercent` field; mounts without inode data stay untouched.
fn merge_inode_usage(root: &mut serde_json::Value, inode_text: &str) {
    let usage = parse_inode_usage(inode_text);
    if usage.is_empty() {
        return;
    }
    let Some(disks) = root
        .get_mut("disks")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for disk in disks.iter_mut() {
        let Some(mount) = disk.get("mount").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some((_, percent)) = usage.iter().find(|(entry_mount, _)| entry_mount == mount) else {
            continue;
        };
        if let Some(object) = disk.as_object_mut() {
            object.insert("inodeUsePercent".to_string(), serde_json::json!(percent));
        }
    }
}

/// Per-interface traffic counters and B/s rates between the two snapshots.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterfaceMetrics {
    pub name: String,
    /// Receive rate in bytes per second between the two samples.
    pub rx_rate: f64,
    /// Transmit rate in bytes per second between the two samples.
    pub tx_rate: f64,
    /// Cumulative received bytes at the second sample.
    pub rx_total: u64,
    /// Cumulative transmitted bytes at the second sample.
    pub tx_total: u64,
}

/// A row of the top-process table (sorted by CPU, [`PROCESS_TOP_LIMIT`] max).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pub pid: u64,
    pub user: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub command: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct NetCounters {
    rx: u64,
    tx: u64,
}

/// Extracts the raw text of a `--marker--` section: everything after the
/// marker line until the next `--…--` marker or end of output.
fn section_of<'a>(output: &'a str, marker: &str) -> &'a str {
    let mut start: Option<usize> = None;
    let mut cursor = 0;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.len() > 4 && trimmed.starts_with("--") && trimmed.ends_with("--") {
            if let Some(begin) = start {
                return &output[begin..cursor];
            }
            if trimmed == marker {
                start = Some(cursor + line.len());
            }
        }
        cursor += line.len();
    }
    match start {
        Some(begin) => &output[begin..],
        None => "",
    }
}

/// Parses one counter snapshot (either `/proc/net/dev` or `netstat -ibn`
/// text) into per-interface cumulative byte counters. The two formats are
/// distinguished per line, and `netstat` rows repeat per address so the
/// maximum per interface name wins (mirrors tiny-rdm's awk dedup).
fn parse_net_counters(text: &str) -> BTreeMap<String, NetCounters> {
    let mut counters: BTreeMap<String, NetCounters> = BTreeMap::new();
    for line in text.lines() {
        if let Some((name, counter)) = parse_net_line(line) {
            let entry = counters.entry(name).or_default();
            if counter.rx > entry.rx {
                entry.rx = counter.rx;
            }
            if counter.tx > entry.tx {
                entry.tx = counter.tx;
            }
        }
    }
    counters
}

/// Parses one line of either network-counter format into `(name, counters)`.
fn parse_net_line(line: &str) -> Option<(String, NetCounters)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Linux /proc/net/dev: `  eth0: rx_bytes packets … tx_bytes packets …`
    // (16 numeric columns, rx bytes at 0 and tx bytes at 8).
    if let Some((name, rest)) = trimmed.split_once(':') {
        let name = name.trim();
        if !name.is_empty() && !name.chars().any(char::is_whitespace) {
            let fields: Vec<&str> = rest.split_whitespace().collect();
            if fields.len() >= 16 {
                if let (Ok(rx), Ok(tx)) = (fields[0].parse::<u64>(), fields[8].parse::<u64>()) {
                    return Some((name.to_string(), NetCounters { rx, tx }));
                }
            }
        }
    }
    // macOS/BSD netstat -ibn:
    // `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll`.
    // Rows without an Address collapse to 10 fields, but `Coll` is always
    // last, `Obytes` second to last, and `Ibytes` three columns before it.
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() < 10 || fields[0] == "Name" {
        return None;
    }
    let tx = fields[fields.len() - 2].parse::<u64>().ok()?;
    let rx = fields[fields.len() - 5].parse::<u64>().ok()?;
    Some((fields[0].to_string(), NetCounters { rx, tx }))
}

/// Builds the per-interface rate view from the two snapshots: rates in B/s
/// over [`NET_SAMPLE_INTERVAL_SECS`], cumulative totals from the second
/// sample. Interfaces without any traffic stay hidden; results are sorted by
/// total rate (busiest first, name as tiebreaker).
pub fn parse_network_samples(output: &str) -> Vec<NetworkInterfaceMetrics> {
    let first = parse_net_counters(section_of(output, "--net--"));
    let second = parse_net_counters(section_of(output, "--net2--"));
    let mut interfaces: Vec<NetworkInterfaceMetrics> = second
        .into_iter()
        .map(|(name, current)| {
            let previous = first.get(&name).copied().unwrap_or(current);
            let rx_rate = current.rx.saturating_sub(previous.rx) as f64 / NET_SAMPLE_INTERVAL_SECS;
            let tx_rate = current.tx.saturating_sub(previous.tx) as f64 / NET_SAMPLE_INTERVAL_SECS;
            NetworkInterfaceMetrics {
                name,
                rx_rate,
                tx_rate,
                rx_total: current.rx,
                tx_total: current.tx,
            }
        })
        .filter(|net| {
            net.rx_total > 0 || net.tx_total > 0 || net.rx_rate > 0.0 || net.tx_rate > 0.0
        })
        .collect();
    interfaces.sort_by(|a, b| {
        let a_rate = a.rx_rate + a.tx_rate;
        let b_rate = b.rx_rate + b.tx_rate;
        b_rate
            .partial_cmp(&a_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
    interfaces
}

/// Parses the `ps` top-process section of the collector output.
pub fn parse_processes(output: &str) -> Vec<ProcessMetrics> {
    parse_process_lines(section_of(output, "--ps--"))
}

/// Parses `ps -eo pid=,user=,pcpu=,pmem=,args=` lines (already sorted and
/// limited by the collector pipeline).
pub fn parse_process_lines(text: &str) -> Vec<ProcessMetrics> {
    let mut processes = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // pid user cpu% mem% + at least one command token.
        if fields.len() < 5 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u64>() else {
            continue;
        };
        let Some(cpu_percent) = parse_percent(fields[2]) else {
            continue;
        };
        let Some(mem_percent) = parse_percent(fields[3]) else {
            continue;
        };
        let command = truncate_chars(&fields[4..].join(" "), PROCESS_COMMAND_MAX_CHARS);
        processes.push(ProcessMetrics {
            pid,
            user: fields[1].to_string(),
            cpu_percent,
            mem_percent,
            command,
        });
        if processes.len() >= PROCESS_TOP_LIMIT {
            break;
        }
    }
    processes
}

fn parse_percent(value: &str) -> Option<f64> {
    value.trim_end_matches('%').parse::<f64>().ok()
}

// —— Process management (ssh/processes/list, ssh/processes/kill) ———

/// Row cap for the full process list so the payload stays bounded.
pub const PROCESS_LIST_LIMIT: usize = 500;
/// Max chars kept of one process command line.
const PROCESS_LIST_COMMAND_MAX_CHARS: usize = 200;

/// Sorted by CPU (busiest first) and capped server-side; the frontend
/// re-sorts client-side without refetching.
const PROCESS_LIST_SCRIPT: &str = concat!(
    "(ps -eo pid=,ppid=,user=,pcpu=,pmem=,etime=,state=,args= 2>/dev/null || true) ",
    "| sort -k3,3nr | head -n 500"
);

/// One row of the full process list (same `ps` dialect as the top-process
/// section, plus ppid/etime/state for the management panel).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListRow {
    pub pid: u64,
    pub ppid: u64,
    pub user: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub etime: String,
    pub state: String,
    pub command: String,
}

/// Collects the full process list over a new exec channel. Read-only.
pub async fn collect_process_list(handle: &Handle<SshClient>) -> Result<serde_json::Value, String> {
    let outcome = exec_plain(
        handle,
        PROCESS_LIST_SCRIPT,
        std::time::Duration::from_secs(15),
        &[],
    )
    .await?;
    Ok(serde_json::json!({ "processes": parse_process_list(&outcome.output) }))
}

/// Parses the process-list `ps` output. Pure so it can be unit-tested
/// without a server.
pub fn parse_process_list(text: &str) -> Vec<ProcessListRow> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // pid ppid user cpu% mem% etime state + at least one command token.
        if fields.len() < 8 {
            continue;
        }
        let Ok(pid) = fields[0].parse::<u64>() else {
            continue;
        };
        let Ok(ppid) = fields[1].parse::<u64>() else {
            continue;
        };
        let Some(cpu_percent) = parse_percent(fields[3]) else {
            continue;
        };
        let Some(mem_percent) = parse_percent(fields[4]) else {
            continue;
        };
        rows.push(ProcessListRow {
            pid,
            ppid,
            user: fields[2].to_string(),
            cpu_percent,
            mem_percent,
            etime: fields[5].to_string(),
            state: fields[6].to_string(),
            command: truncate_chars(&fields[7..].join(" "), PROCESS_LIST_COMMAND_MAX_CHARS),
        });
        if rows.len() >= PROCESS_LIST_LIMIT {
            break;
        }
    }
    rows
}

/// Validates a kill request and renders the remote command. Pid 0/1 are
/// refused outright (init / the process group escape hatch); only a small
/// safe signal set is accepted.
pub fn kill_command(pid: u64, signal: u32) -> Result<String, String> {
    if pid <= 1 {
        return Err(format!(
            "Refusing to signal pid {pid}: init and pid 0 are protected"
        ));
    }
    let name = match signal {
        1 => "HUP",
        2 => "INT",
        9 => "KILL",
        15 => "TERM",
        _ => return Err(format!("Unsupported signal {signal}; use 1, 2, 9 or 15")),
    };
    Ok(format!("kill -{name} {pid}"))
}

/// Sends one signal to a remote process. Executed through the same
/// plugin-internal exec path as the metrics collector.
pub async fn kill_process(handle: &Handle<SshClient>, pid: u64, signal: u32) -> Result<(), String> {
    let command = kill_command(pid, signal)?;
    let outcome = exec_plain(handle, &command, std::time::Duration::from_secs(10), &[]).await?;
    if outcome.exit_code != 0 {
        return Err(format!(
            "kill failed (exit {}): {}",
            outcome.exit_code, outcome.output
        ));
    }
    Ok(())
}

/// Parses the `df -iP` inode section into `(mount, usePercent)` rows.
/// Dialects differ in where the percent column sits (GNU prints `IUse%`
/// fourth, busybox third), so the last `%`-suffixed token before the mount
/// column wins; header rows have none and are skipped.
pub fn parse_inode_usage(text: &str) -> Vec<(String, f64)> {
    let mut rows = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // filesystem <counts...> use% mount — at least 5 columns.
        if fields.len() < 5 {
            continue;
        }
        let Some(percent) = fields
            .iter()
            .rev()
            .skip(1)
            .find_map(|field| parse_percent(field))
        else {
            continue;
        };
        rows.push((fields[fields.len() - 1].to_string(), percent));
    }
    rows
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_string()
    } else {
        value.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Full collector output in Linux shape: /proc/net/dev twice around the
    /// process table, followed by the base sections.
    const LINUX_FIXTURE: &str = "\
hostname=web-01
kernel=6.1.0-18-amd64
loadavg=0.28 0.42 0.35 1/887 23456
uptime=987654.32 456789.01
nproc=8
--net--
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000    50    0    0    0     0          0         0  5000    50    0    0    0     0       0          0
  eth0: 1000    10    0    0    0     0          0         0  2000    20    0    0    0     0       0          0
  eth1: 0    0    0    0    0     0          0         0  0    0    0    0    0     0       0          0
--net2--
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 6500    65    0    0    0     0          0         0  6500    65    0    0    0     0       0          0
  eth0: 3000    30    0    0    0     0          0         0  2500    25    0    0    0     0       0          0
  eth1: 0    0    0    0    0     0          0         0  0    0    0    0    0     0       0          0
--ps--
  1234 root        12.5  4.2 /usr/sbin/nginx -c /etc/nginx/nginx.conf
   567 alice        8.0  1.1 /usr/bin/python3 /opt/app/server.py --port 8080
   999 postgres      2.3 12.8 postgres: writer process
--psm--
   999 postgres      2.3 12.8 postgres: writer process
  1234 root        12.5  4.2 /usr/sbin/nginx -c /etc/nginx/nginx.conf
   567 alice        8.0  1.1 /usr/bin/python3 /opt/app/server.py --port 8080
--dfi--
Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/sda1 3200000 320000 2880000 10% /
/dev/sdb1 40960 18432 22528 55% /srv
--mem--
MemTotal:       16308856 kB
MemAvailable:   12000000 kB
SwapTotal:      2047996 kB
SwapFree:       2047996 kB
--cpu--
cpu  100 0 200 8000 40 0 0 0 0 0
cpu  200 0 300 8100 40 0 0 0 0 0
--df--
/dev/sda1 51469868 23456780 25879924 48% /
/dev/sdb1 1024000 512000 512000 50% /srv
/dev/sdc1 2048000 1024000 1024000 50% /var
";

    /// Collector output in post-fix macOS shape: sysctl/vm_stat/iostat
    /// fallbacks re-emit the Linux line shapes (`loadavg`/`uptime` keys,
    /// meminfo-style `--mem--` rows, synthetic `cpu` tick rows), `netstat
    /// -ibn` network counters and bare `df -i` inode columns.
    const MACOS_FIXTURE: &str = "\
hostname=mac-mini
kernel=25.0.0
loadavg= 164.17 195.50 176.54
uptime=1789900000
nproc=10
--net--
Name       Mtu   Network       Address            Ipkts  Ierrs     Ibytes    Opkts  Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       12345      0     1000    12345      0     1000     0
en0        1500  <Link#4>    aa:bb:cc:dd:ee:ff    98765      0  1000000    54321      0   200000     0
en0        1500  fe80::%en0/64 fe80::1%en0        98765      0   900000    54321      0   150000     0
en0        1500  192.168.1    192.168.1.10       98765      0  1000000    54321      0   200000     0
--net2--
Name       Mtu   Network       Address            Ipkts  Ierrs     Ibytes    Opkts  Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       12346      0     2000    12346      0     2000     0
en0        1500  <Link#4>    aa:bb:cc:dd:ee:ff    98805      0  1500000    54361      0   240000     0
en0        1500  fe80::%en0/64 fe80::1%en0        98805      0  1100000    54361      0   200000     0
en0        1500  192.168.1    192.168.1.10       98805      0  1500000    54361      0   240000     0
--ps--
   321 jin          45.1  8.3 /Applications/DBX.app/Contents/MacOS/DBX
   402 root         3.2  0.4 /usr/libexec/taskgated
--psm--
   321 jin          45.1  8.3 /Applications/DBX.app/Contents/MacOS/DBX
   402 root         3.2  0.4 /usr/libexec/taskgated
--dfi--
Filesystem         512-blocks       Used Available Capacity  iused      ifree %iused  Mounted on
/dev/disk3s1s1     1942700360   24682824  96661440    21%   458732  480207920    0%   /
devfs                     541        541         0  100%      936          0  100%   /dev
--mem--
MemTotal: 33554432 kB
MemAvailable: 6104352 kB
SwapTotal: 18874368 kB
SwapFree: 809216 kB
--cpu--
cpu  0 0 0 0 0
cpu  97 0 0 3 0
--df--
/dev/disk3s1s1 971350180 12341412 48020792 21% /
devfs 270 270 0 100% /dev
";

    #[test]
    fn parses_linux_network_rates_and_totals() {
        let network = parse_network_samples(LINUX_FIXTURE);
        // Busy interfaces first; the idle eth1 is hidden.
        assert_eq!(network.len(), 2);
        assert_eq!(network[0].name, "lo");
        assert_eq!(network[0].rx_rate, 1500.0);
        assert_eq!(network[0].tx_rate, 1500.0);
        assert_eq!(network[0].rx_total, 6500);
        // eth0: rx delta 2000, tx delta 500.
        let eth0 = network.iter().find(|net| net.name == "eth0").unwrap();
        assert_eq!(eth0.rx_rate, 2000.0);
        assert_eq!(eth0.tx_rate, 500.0);
        assert_eq!(eth0.rx_total, 3000);
        assert_eq!(eth0.tx_total, 2500);
    }

    #[test]
    fn parses_macos_netstat_headers_and_duplicate_rows() {
        let network = parse_network_samples(MACOS_FIXTURE);
        assert_eq!(network.len(), 2);
        // en0 aggregates the max across per-address rows: rx 1000000 -> 1500000.
        let en0 = network.iter().find(|net| net.name == "en0").unwrap();
        assert_eq!(en0.rx_rate, 500000.0);
        assert_eq!(en0.tx_rate, 40000.0);
        assert_eq!(en0.rx_total, 1500000);
        assert_eq!(en0.tx_total, 240000);
        let lo0 = network.iter().find(|net| net.name == "lo0").unwrap();
        assert_eq!(lo0.rx_rate, 1000.0);
        assert_eq!(lo0.tx_total, 2000);
        // Busiest interface sorts first.
        assert_eq!(network[0].name, "en0");
    }

    #[test]
    fn netstat_rows_without_address_collapse_to_ten_columns() {
        // Real `netstat -ibn` prints rows like lo0's <Link#1> line without an
        // Address column; Obytes stays second-to-last and Ibytes three before.
        let counters = parse_net_counters(
            "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n\
             lo0 16384 <Link#1> 12345 0 1000 12345 0 2000 0\n\
             en0 1500 <Link#4> aa:bb:cc 10 0 100 20 0 300 0\n",
        );
        assert_eq!(
            counters.get("lo0"),
            Some(&NetCounters { rx: 1000, tx: 2000 })
        );
        assert_eq!(counters.get("en0"), Some(&NetCounters { rx: 100, tx: 300 }));
    }

    #[test]
    fn empty_or_missing_network_sections_yield_nothing() {
        assert!(parse_network_samples("--net--\n--net2--\n").is_empty());
        assert!(parse_network_samples("").is_empty());
        assert!(parse_network_samples("hostname=x\n--mem--\n").is_empty());
    }

    #[test]
    fn handles_counter_reset_between_samples() {
        let output = "\
--net--
eth0: 9000    9 0 0 0 0 0 0 8000 8 0 0 0 0 0 0
--net2--
eth0: 100    1 0 0 0 0 0 0 50 1 0 0 0 0 0 0
";
        let network = parse_network_samples(output);
        assert_eq!(network.len(), 1);
        // Counter reset clamps to zero instead of producing a huge spike.
        assert_eq!(network[0].rx_rate, 0.0);
        assert_eq!(network[0].tx_rate, 0.0);
        assert_eq!(network[0].rx_total, 100);
    }

    #[test]
    fn parses_top_processes_with_truncated_commands() {
        let processes = parse_processes(LINUX_FIXTURE);
        assert_eq!(processes.len(), 3);
        assert_eq!(processes[0].pid, 1234);
        assert_eq!(processes[0].user, "root");
        assert_eq!(processes[0].cpu_percent, 12.5);
        assert_eq!(processes[0].mem_percent, 4.2);
        assert_eq!(
            processes[0].command,
            "/usr/sbin/nginx -c /etc/nginx/nginx.conf"
        );
        assert_eq!(processes[2].pid, 999);
        assert_eq!(processes[2].user, "postgres");

        let long_command = "x".repeat(300);
        let text = format!("1 u 1.0 1.0 {long_command}\n");
        let parsed = parse_process_lines(&text);
        assert_eq!(parsed[0].command.chars().count(), PROCESS_COMMAND_MAX_CHARS);

        // Header-like or malformed lines are skipped.
        assert!(
            parse_process_lines("PID USER %CPU %MEM COMMAND\nnot-a-pid line here\n").is_empty()
        );
    }

    #[test]
    fn extended_json_keeps_base_fields_and_adds_defaults() {
        let metrics = parse_metrics_output(LINUX_FIXTURE);
        // Base fields from exec::parse_metrics_output stay intact.
        assert_eq!(metrics["hostname"], "web-01");
        assert_eq!(metrics["cpu"]["percent"], 66.7);
        assert_eq!(metrics["memory"]["totalBytes"], 16_308_856_u64 * 1024);
        // Network/process/dfi lines run before --mem--/--df-- so the base
        // parser must not misread them as disks: exactly the 3 real df rows.
        assert_eq!(metrics["disks"].as_array().unwrap().len(), 3);
        // New fields always exist (serde-default style for old callers).
        assert_eq!(metrics["network"][0]["name"], "lo");
        assert_eq!(metrics["network"][0]["rxRate"], 1500.0);
        assert_eq!(metrics["network"][0]["rxTotal"], 6500);
        assert_eq!(metrics["processes"][0]["pid"], 1234);
        assert_eq!(metrics["processes"][0]["cpuPercent"], 12.5);
        assert_eq!(metrics["processes"][0]["user"], "root");
        assert_eq!(metrics["topMemory"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn parses_inode_usage_across_df_dialects() {
        // GNU layout: IUse% is the fourth column; busybox prints it third.
        // Header rows carry no percent token and are skipped.
        let rows = parse_inode_usage(
            "Filesystem Inodes IUsed IFree IUse% Mounted on\n\
             /dev/sda1 3200000 320000 2880000 10% /\n\
             tmpfs 100000 50000 50000 50% /run\n",
        );
        assert_eq!(
            rows,
            vec![("/".to_string(), 10.0), ("/run".to_string(), 50.0)]
        );

        let busybox = parse_inode_usage(
            "Filesystem Inodes Used Free Use% Mounted on\n\
             /dev/root 24576 4096 20480 17% /\n",
        );
        assert_eq!(busybox, vec![("/".to_string(), 17.0)]);

        assert!(parse_inode_usage("").is_empty());
        assert!(parse_inode_usage("Filesystem Inodes IUsed IFree IUse% Mounted on").is_empty());
    }

    #[test]
    fn inode_usage_merges_into_matching_mounts_only() {
        let metrics = parse_metrics_output(LINUX_FIXTURE);
        let disks = metrics["disks"].as_array().unwrap();
        assert_eq!(disks[0]["mount"], json!("/"));
        assert_eq!(disks[0]["inodeUsePercent"], 10.0);
        assert_eq!(disks[1]["mount"], json!("/srv"));
        assert_eq!(disks[1]["inodeUsePercent"], 55.0);
        // /var has no df -iP row: the field stays absent instead of nulling.
        assert_eq!(disks[2]["mount"], json!("/var"));
        assert!(disks[2].get("inodeUsePercent").is_none());
    }

    #[test]
    fn top_memory_processes_are_parsed_independently() {
        let metrics = parse_metrics_output(LINUX_FIXTURE);
        let top_memory = metrics["topMemory"].as_array().unwrap();
        assert_eq!(top_memory[0]["pid"], 999);
        assert_eq!(top_memory[0]["memPercent"], 12.8);
        assert_eq!(top_memory[0]["command"], "postgres: writer process");
        // The CPU-sorted `processes` list is untouched by the mem ordering.
        assert_eq!(metrics["processes"][0]["pid"], 1234);

        let empty = parse_metrics_output("--psm--\n--mem--\n");
        assert_eq!(empty["topMemory"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn parses_macos_json_end_to_end() {
        let metrics = parse_metrics_output(MACOS_FIXTURE);
        assert_eq!(metrics["hostname"], "mac-mini");
        // sysctl 回退产出的负载与运行时长被解析成三个 load 与整数秒。
        assert_eq!(metrics["cpu"]["load1"], 164.17);
        assert_eq!(metrics["cpu"]["load15"], 176.54);
        assert_eq!(metrics["uptimeSeconds"], 1_789_900_000_u64);
        // iostat 百分比合成的 tick 行算出 CPU 繁忙率：(97+0)*100/(97+3)。
        assert_eq!(metrics["cpu"]["percent"], 97.0);
        // meminfo 形状的 sysctl 回退行给出完整内存与 swap 视图。
        assert_eq!(metrics["memory"]["totalBytes"], 34_359_738_368_u64);
        assert_eq!(metrics["memory"]["availableBytes"], 6_250_856_448_u64);
        assert_eq!(metrics["memory"]["usedBytes"], 28_108_881_920_u64);
        assert_eq!(metrics["memory"]["swapTotalBytes"], 19_327_352_832_u64);
        assert_eq!(metrics["memory"]["swapUsedBytes"], 18_498_715_648_u64);
        // df -i 的 %iused 列（最右百分号）胜过同行的 Capacity 21%。
        let disks = metrics["disks"].as_array().unwrap();
        assert_eq!(disks[0]["mount"], json!("/"));
        assert_eq!(disks[0]["inodeUsePercent"], 0.0);
        assert_eq!(disks[1]["mount"], json!("/dev"));
        assert_eq!(disks[1]["inodeUsePercent"], 100.0);
        // Network/process extensions stay intact on the fallback path.
        assert_eq!(metrics["network"].as_array().unwrap().len(), 2);
        assert_eq!(
            metrics["processes"][0]["command"],
            "/Applications/DBX.app/Contents/MacOS/DBX"
        );
        assert_eq!(metrics["processes"][0]["pid"], 321);
    }

    #[test]
    fn section_extraction_scopes_to_markers() {
        assert_eq!(
            section_of("--net--\nabc\n--net2--\ndef\n", "--net--"),
            "abc\n"
        );
        assert_eq!(
            section_of("--net--\nabc\n--net2--\ndef\n", "--net2--"),
            "def\n"
        );
        assert_eq!(section_of("no markers here", "--net--"), "");
        assert_eq!(section_of("--net--\nabc", "--net--"), "abc");
    }

    #[test]
    fn serializes_camel_case_payload() {
        let value = serde_json::to_value(NetworkInterfaceMetrics {
            name: "en0".into(),
            rx_rate: 1.5,
            tx_rate: 2.5,
            rx_total: 10,
            tx_total: 20,
        })
        .unwrap();
        assert_eq!(
            value,
            json!({"name": "en0", "rxRate": 1.5, "txRate": 2.5, "rxTotal": 10, "txTotal": 20})
        );
    }

    // —— A5: os-release identification ————————————————

    #[test]
    fn parses_os_release_id_and_pretty_name() {
        let text = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n\
                    PRETTY_NAME=\"Ubuntu 22.04.3 LTS\"\nVERSION_ID=\"22.04\"\n";
        let (id, pretty) = parse_os_release(text);
        assert_eq!(id.as_deref(), Some("ubuntu"));
        assert_eq!(pretty.as_deref(), Some("Ubuntu 22.04.3 LTS"));
        // ID_LIKE must not be mistaken for ID.

        // CRLF output is tolerated.
        let (id, pretty) = parse_os_release("ID=\"centos\"\r\nPRETTY_NAME=\"CentOS Stream 9\"\r\n");
        assert_eq!(id.as_deref(), Some("centos"));
        assert_eq!(pretty.as_deref(), Some("CentOS Stream 9"));

        // Unquoted values work.
        let (id, _) = parse_os_release("ID=alpine\n");
        assert_eq!(id.as_deref(), Some("alpine"));

        // Missing keys, empty text, and blank values yield nothing.
        assert_eq!(parse_os_release(""), (None, None));
        assert_eq!(parse_os_release("NAME=\"BusyBox\"\n"), (None, None));
        let (id, pretty) = parse_os_release("ID=\"\"\nPRETTY_NAME=\"\"\n");
        assert_eq!(id, None);
        assert_eq!(pretty, None);
    }

    #[test]
    fn os_release_fields_land_in_the_payload_only_when_present() {
        // The collector section parse: ID/PRETTY_NAME become optional top
        // level fields; a missing --os-- section (BSD, busybox minimal)
        // omits both entirely instead of writing nulls.
        let with_os = parse_metrics_output("--os--\nID=ubuntu\nPRETTY_NAME=\"Ubuntu 22.04\"\n");
        assert_eq!(with_os["osId"], "ubuntu");
        assert_eq!(with_os["osPretty"], "Ubuntu 22.04");

        let without_os = parse_metrics_output("--ps--\n");
        assert!(without_os.get("osId").is_none(), "{without_os}");
        assert!(without_os.get("osPretty").is_none(), "{without_os}");

        // A section whose cat found nothing (both paths missing) stays out.
        let empty_section = parse_metrics_output("--os--\n");
        assert!(empty_section.get("osId").is_none());
        assert!(empty_section.get("osPretty").is_none());
    }

    // —— Process management ——————————————————————————

    const PROCESS_LIST_FIXTURE: &str = "\
  1234 1200 root        12.5  4.2 10-03:12:05 S /usr/sbin/nginx -c /etc/nginx/nginx.conf
   567    1 alice        8.0  1.1 5-01:00:00 R /usr/bin/python3 /opt/app/server.py
     9    1 postgres     2.3 12.8 30-12:00:00 S postgres: writer process
bad line here
";

    #[test]
    fn parses_full_process_list_rows() {
        let rows = parse_process_list(PROCESS_LIST_FIXTURE);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pid, 1234);
        assert_eq!(rows[0].ppid, 1200);
        assert_eq!(rows[0].user, "root");
        assert_eq!(rows[0].cpu_percent, 12.5);
        assert_eq!(rows[0].mem_percent, 4.2);
        assert_eq!(rows[0].etime, "10-03:12:05");
        assert_eq!(rows[0].state, "S");
        assert_eq!(rows[0].command, "/usr/sbin/nginx -c /etc/nginx/nginx.conf");
        assert_eq!(rows[2].command, "postgres: writer process");
        // Malformed lines are skipped (bad pid, too few columns).
        assert!(parse_process_list("not-a-pid 1 u 1.0 1.0 1-00:00:00 R cmd\n").is_empty());
        assert!(parse_process_list("").is_empty());
    }

    #[test]
    fn process_list_rows_serialize_camel_case() {
        let value = serde_json::to_value(&parse_process_list(PROCESS_LIST_FIXTURE)[0]).unwrap();
        assert_eq!(value["pid"], 1234);
        assert_eq!(value["ppid"], 1200);
        assert_eq!(value["cpuPercent"], 12.5);
        assert_eq!(value["memPercent"], 4.2);
        assert_eq!(value["command"], "/usr/sbin/nginx -c /etc/nginx/nginx.conf");
    }

    #[test]
    fn kill_requests_are_validated_and_rendered() {
        assert_eq!(kill_command(1234, 15).unwrap(), "kill -TERM 1234");
        assert_eq!(kill_command(1234, 9).unwrap(), "kill -KILL 1234");
        assert_eq!(kill_command(42, 1).unwrap(), "kill -HUP 42");
        assert_eq!(kill_command(42, 2).unwrap(), "kill -INT 42");
        // init / pid 0 and unsupported signals are refused.
        assert!(kill_command(1, 15).is_err());
        assert!(kill_command(0, 9).is_err());
        assert!(kill_command(1234, 19).is_err());
    }

    #[test]
    fn section_projection_keeps_only_requested_keys() {
        let mut doc = parse_metrics_output(LINUX_FIXTURE);
        assert!(doc.as_object().unwrap().contains_key("network"));
        project_metrics_sections(&mut doc, &["cpu".to_string(), "memory".to_string()]).unwrap();
        let keys: Vec<&str> = doc
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, vec!["cpu", "memory"]);
    }

    #[test]
    fn section_projection_rejects_unknown_and_tolerates_absent() {
        let mut doc = parse_metrics_output(LINUX_FIXTURE);
        // 未知段名 fail-fast 并列出合法段。
        let error = project_metrics_sections(&mut doc, &["memry".to_string()]).unwrap_err();
        assert!(error.contains("Unknown section: 'memry'"), "{error}");
        assert!(error.contains("topMemory"), "{error}");
        // 原文档未被错误路径破坏。
        assert!(doc.as_object().unwrap().len() > 3);
        // 合法但该主机缺失的段（如 osId）静默省略，不算错。
        project_metrics_sections(&mut doc, &["osId".to_string(), "cpu".to_string()]).unwrap();
        assert!(doc.as_object().unwrap().contains_key("cpu"));
    }
}
