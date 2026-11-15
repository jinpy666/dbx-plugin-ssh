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

pub const MONITOR_TASK_LIMIT: usize = 24;
pub const FAST_RING_CAP: usize = 720; // 12 min @ 1s
pub const SLOW_RING_CAP: usize = 144; // 12 min @ 5s
pub const SNAPSHOT_DEFAULT_POINTS: usize = 120;

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
    "case \"$iface\" in ''|*[!A-Za-z0-9.@_-]*) iface=$(awk 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1!=\"lo\"){print $1; exit}}' /proc/net/dev);; esac; ",
    "n_rx=0; n_tx=0; ",
    "case \"$iface\" in ?*) eval \"$(awk -v IF=\"$iface\" 'NR>2{sub(/:.*/,\"\",$1);",
    "if($1==IF){print \"n_rx=\"$2\"; print \"n_tx=\"$10; exit}}' /proc/net/dev)\";; esac; ",
    "l1=$(awk '{print int($1*100)}' /proc/loadavg); ",
    "printf 'dbx-mon c=%s,%s m=%s,%s n=%s,%s,%s l=%s\\n' ",
    "\"$c_total\" \"$c_idle\" \"$m_total\" \"$m_avail\" \"$n_rx\" \"$n_tx\" \"$iface\" \"$l1\"; ",
    "sleep 1; done",
);

const MON_SLOW_SCRIPT: &str = concat!(
    "while :; do ",
    "echo \"dbx-det load=$(cut -d' ' -f1-3 /proc/loadavg)\"; ",
    "echo \"dbx-det uptime=$(awk '{print int($1)}' /proc/uptime)\"; ",
    "df -P -k / 2>/dev/null | tail -n +2 | awk '{printf \"dbx-det disk=%s,%s,%s\\n\", $6, $2, $3}'; ",
    "who 2>/dev/null | head -20 | awk '{printf \"dbx-det user=%s,%s,%s\\n\", $1, $2, $3}'; ",
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

/// One login row of a detail burst (`who`, first three columns verbatim).
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
    pub load1_x100: u64,
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
/// n=<rx>,<tx>,<iface> l=<x100>` as printed by the `MON_FAST_SCRIPT` printf.
/// Every field must be present and numeric or the row is dropped (the
/// callers only push fully-parsed rows into the diff chain).
fn parse_counters(rest: &str) -> Option<Counters> {
    let mut cpu: Option<(u64, u64)> = None;
    let mut mem: Option<(u64, u64)> = None;
    let mut net: Option<(u64, u64, String)> = None;
    let mut load: Option<u64> = None;
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
            "l" => load = Some(value.parse().ok()?),
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
        load1_x100: load?,
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
            if let (Some(l1), Some(l5), Some(l15)) =
                (parts.next(), parts.next(), parts.next())
            {
                if let (Ok(l1), Ok(l5), Ok(l15)) = (
                    l1.parse::<f64>(),
                    l5.parse::<f64>(),
                    l15.parse::<f64>(),
                ) {
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
            // who columns 1..3 verbatim; a missing from-column degrades to "".
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

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    /// Fixture origin: `/proc/stat` (`cpu  user nice system idle iowait irq
    /// softirq`), `/proc/meminfo` kB rows, `/proc/net/dev` byte counters and
    /// `/proc/loadavg` (load1 ×100), as emitted by the printf in
    /// `MON_FAST_SCRIPT`.
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
            load1_x100: 42,
        }
    }

    #[test]
    fn parses_a_valid_counter_line() {
        let line = "dbx-mon c=1234567,987654 m=16384000,8192000 n=1048576,2048,eth0 l=42";
        match parse_counter_line(line) {
            CounterLine::Counters(c) => {
                assert_eq!(c.cpu_total, 1234567);
                assert_eq!(c.cpu_idle, 987654);
                assert_eq!(c.mem_total_kb, 16384000);
                assert_eq!(c.mem_avail_kb, 8192000);
                assert_eq!(c.rx, 1048576);
                assert_eq!(c.tx, 2048);
                assert_eq!(c.iface, "eth0");
                assert_eq!(c.load1_x100, 42);
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
            "dbx-mon c=x,y m=1,2 n=1,2,eth0 l=1",
            "dbx-mon c=1,2 m=1,2 n=1,2 l=1",
            "dbx-mon c=1,2 m=1,2 n=1,2, l=1",
            "dbx-mon c=1,2 m=1,2 n=1,2,eth0 l=zz",
            "dbx-mon c=1,2 m=-1,2 n=1,2,eth0 l=1",
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
        match parse_counter_line("dbx-mon c=100,50 m=4000,1470 n=0,0,eth0 l=10") {
            CounterLine::Counters(c) => assert_eq!(c.mem_avail_kb, 1470),
            other => panic!("expected counters, got {other:?}"),
        }
        // The fallback expression must stay part of the script.
        assert!(MON_FAST_SCRIPT.contains("MemFree"), "fallback formula missing");
        assert!(MON_FAST_SCRIPT.contains("SReclaimable"), "fallback formula missing");
    }

    #[test]
    fn diff_computes_cpu_memory_and_rates() {
        let prev = counters(1000, 1_000_000, 900_000, 16_384_000, 8_192_000, 1_048_576, 2048, "eth0");
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
        assert_eq!(serde_json::to_value(&with_iface).unwrap()["iface"], json!("eth0"));
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
        assert_eq!(value["users"][0], json!({"user": "alice", "tty": "pts/0", "from": "10.0.0.5"}));
    }

    #[test]
    fn detail_block_without_end_marker_still_parses() {
        let details = parse_detail_block(&["dbx-det load=1 2 3", "dbx-det uptime=10", "dbx-det disk=/data,100,50"]);
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
}
