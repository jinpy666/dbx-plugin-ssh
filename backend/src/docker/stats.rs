//! `docker/stats`（B2 容器指标，只读）：一次 `docker stats --no-stream`
//! 批量采样最多 50 个容器。
//!
//! 安全模型与 `docker/scripts.rs` 同一套红线：脚本体是常量、容器 id 先过
//! `validate_container_id`（`^[0-9a-f]{12,64}$`），再作为**位置参数**走
//! `sh -c '<固定脚本>' sh <id>…`——id 永不进入脚本文本；本机面 argv 直呼
//! 进程（无 shell）。只读采集：不启动/停止/删除任何容器，也不写文件。
//!
//! 采集与纯函数分离：`parse_bytes` / `parse_percent` / `parse_mem_usage` /
//! `parse_io_pair` / `parse_stats_section` / `rate_bytes_per_sec` 都是纯
//! 函数，单测覆盖单位（`0B` / `1.2kB` / `1.5KiB` / `2.3GiB`）、百分比与速率
//! 差分。网络/块 IO 的原始字段是累计字节；速率是同一采样 key 两次采样间的
//! 差分（首次为 0，计数器回绕按 0 处理），缓存只存内存并按 key 数上限裁剪。

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::exec;

use super::local::run_local;
use super::parse::{marker_section, parse_probe_before};
use super::scripts::PATH_PREFIX;
use super::{find_local_cli, is_daemon_permission_failure, validate_container_id, EngineConfig};

// —— Bounds & templates ——————————————————————————————————

/// `containerIds` 上限：一次 `docker stats --no-stream` 的采集量有界，
/// 面板一屏也不会超过这个数（§2.1 契约 1–50）。
pub const STATS_MAX_CONTAINERS: usize = 50;
/// 等待上限：`docker stats --no-stream` 每个容器要读一次 cgroup 并算一帧，
/// 50 个容器在慢盘上可能超过 10s，留足余量但不让 RPC 无限挂起。
pub const STATS_TIMEOUT: Duration = Duration::from_secs(30);
/// 速率窗口下限：两次采样过近时除以极小窗口会把抖动放大成天文数字。
pub const STATS_MIN_RATE_WINDOW: Duration = Duration::from_millis(250);
/// 采样缓存 key 上限（只读缓存，超限整体丢弃后重新累积，最坏只是一次速率为 0）。
const STATS_CACHE_KEYS: usize = 64;
/// `docker stats --format` 模板：8 列制表输出，与 `PS_FORMAT` 同风格。
/// 列序不可随意调整（解析端按下标取值）。
pub const STATS_FORMAT: &str = "{{.ID}}\\t{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}\\t{{.PIDs}}";

/// 固定脚本体：探针 + `stats`。容器 id 只以 `"$@"` 位置参数进入，
/// 脚本文本本身与用户输入无关（§5.2 红线 1/2）。
pub fn stats_body(engine: &EngineConfig) -> String {
    let mut body = String::from(PATH_PREFIX);
    body.push_str(&engine.env_prefix());
    body.push_str("echo DBXDOCKER_PROBE\n");
    body.push_str(&format!(
        "if command -v {cli} >/dev/null 2>&1; then echo docker-found; else echo docker-missing; fi\n",
        cli = engine.cli
    ));
    body.push_str(&format!(
        "if {cli} info >/dev/null 2>&1; then echo daemon-ok; else echo daemon-denied; fi\n",
        cli = engine.cli
    ));
    body.push_str("echo DBXDOCKER_STATS\n");
    body.push_str(&format!(
        "{cli} stats --no-stream --format '{format}' -- \"$@\" 2>&1\n",
        cli = engine.cli,
        format = STATS_FORMAT
    ));
    body
}

/// 把脚本体与**已校验**的容器 id 拼成一条远端命令：`sh -c '<body>' sh <ids>`。
/// id 既已过 `^[0-9a-f]{12,64}$`，仍按 §5.1 纵深要求再 `shell_quote` 一次。
pub fn stats_script(engine: &EngineConfig, container_ids: &[String]) -> Result<String, String> {
    stats_script_for_body(&stats_body(engine), container_ids)
}

/// [`stats_script`] 的体位复用形态（Quick Sudo 重建体后仍需同一层包装）。
pub fn stats_script_for_body(body: &str, container_ids: &[String]) -> Result<String, String> {
    for id in container_ids {
        validate_container_id(id)?;
    }
    let args = container_ids
        .iter()
        .map(|id| exec::shell_quote(id))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!("sh -c {} sh {args}", exec::shell_quote(body)))
}

// —— Request parsing ————————————————————————————————————

/// 解析 `containerIds`：数组、1–50 项、逐项过 id 门、保序去重。
/// 名称（`web-nginx`）与任何元字符在此被拒绝，不会下探到脚本。
pub fn parse_container_ids(params: &Value) -> Result<Vec<String>, String> {
    let value = params.get("containerIds").ok_or_else(|| {
        "Missing containerIds: expected an array of 1-50 container ids".to_string()
    })?;
    let items = value.as_array().ok_or_else(|| {
        "Invalid containerIds: expected an array of 1-50 container ids".to_string()
    })?;
    if items.is_empty() || items.len() > STATS_MAX_CONTAINERS {
        return Err(format!(
            "Invalid containerIds: expected 1-{STATS_MAX_CONTAINERS} ids, got {}",
            items.len()
        ));
    }
    let mut ids: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .as_str()
            .ok_or_else(|| "Invalid containerIds: every entry must be a string".to_string())?;
        validate_container_id(id)?;
        if !ids.iter().any(|seen| seen == id) {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

/// 采样缓存 key：目标 + CLI + 端点 + 会话。同一会话两次 3s 轮询命中同一
/// key，速率差分才有意义；换连接/换引擎自然换 key，不会串台。
pub fn stats_cache_key(
    target: super::DockerTarget,
    engine: &EngineConfig,
    session_id: Option<&str>,
) -> String {
    format!(
        "{target:?}|{}|{}|{}",
        engine.cli,
        engine.endpoint.as_deref().unwrap_or("-"),
        session_id.unwrap_or("local")
    )
}

// —— Pure parsing ——————————————————————————————————————————

/// 解析 docker 的字节单位串：`0B` / `1.2kB` / `1.5KiB` / `2.3GiB`。
/// SI（kB/MB/GB/TB/PB，1000 进制）与 IEC（KiB/MiB/GiB/TiB/PiB，1024 进制）
/// 分开处理；未知单位返回 `None`（不猜）。非负有限值才接受。
pub fn parse_bytes(text: &str) -> Option<u64> {
    let text = text.trim();
    let number_end = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    if number_end == 0 {
        return None;
    }
    let value: f64 = text[..number_end].parse().ok()?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let multiplier: f64 = match text[number_end..].trim() {
        "" | "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "PB" => 1e15,
        "KiB" | "kiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        "PiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    let bytes = value * multiplier;
    if !bytes.is_finite() || bytes >= u64::MAX as f64 {
        return None;
    }
    Some(bytes as u64)
}

/// 解析百分比串（`"12.34%"`、`"0.00%"`）。`"--"`（限制未知）返回 `None`。
pub fn parse_percent(text: &str) -> Option<f64> {
    let value: f64 = text.trim().strip_suffix('%')?.trim().parse().ok()?;
    (value.is_finite() && value >= 0.0).then_some(value)
}

/// `MemUsage` / `NetIO` / `BlockIO` 都是 `"a / b"` 两段式。
pub fn parse_io_pair(text: &str) -> Option<(u64, u64)> {
    let (left, right) = text.split_once('/')?;
    Some((parse_bytes(left)?, parse_bytes(right)?))
}

/// `MemUsage` 的语义化读取（当前占用 / 上限）。
pub fn parse_mem_usage(text: &str) -> Option<(u64, u64)> {
    parse_io_pair(text)
}

/// 上限未知（`0 / 0`）时退回 0，避免除零。
fn percent_of(used: u64, limit: u64) -> f64 {
    if limit == 0 {
        return 0.0;
    }
    ((used as f64 / limit as f64) * 10_000.0).round() / 100.0
}

/// 两次采样间字节/秒。窗口短于 [`STATS_MIN_RATE_WINDOW`] 返回 0（防止
/// 除零放大）；计数器回绕/容器重启（当前 < 上次）也返回 0 而不是下溢。
pub fn rate_bytes_per_sec(previous: u64, current: u64, window: Duration) -> u64 {
    if window < STATS_MIN_RATE_WINDOW {
        return 0;
    }
    let seconds = window.as_secs_f64();
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    let delta = current.saturating_sub(previous);
    (delta as f64 / seconds).round() as u64
}

/// 一条 `docker stats --format` 行（已解析为数字）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatSample {
    pub container_id: String,
    pub name: String,
    pub cpu_percent: f64,
    pub mem_bytes: u64,
    pub mem_limit_bytes: u64,
    pub mem_percent: f64,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub net_rx_rate: u64,
    pub net_tx_rate: u64,
    pub block_read_bytes: u64,
    pub block_write_bytes: u64,
    pub pids: u64,
}

/// 解析 `DBXDOCKER_STATS` 段：每行 8 个制表字段。id 非法的行（错误文本、
/// 损坏输出）直接跳过；重复 id 只保留首条；`--` 百分比/计数按 0 处理。
pub fn parse_stats_section(section: &str) -> Vec<StatSample> {
    let mut samples: Vec<StatSample> = Vec::new();
    for line in section.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 8 {
            continue;
        }
        let id = fields[0].trim();
        if validate_container_id(id).is_err() || samples.iter().any(|seen| seen.container_id == id)
        {
            continue;
        }
        let (mem_bytes, mem_limit_bytes) = parse_mem_usage(fields[3]).unwrap_or((0, 0));
        let (net_rx_bytes, net_tx_bytes) = parse_io_pair(fields[5]).unwrap_or((0, 0));
        let (block_read_bytes, block_write_bytes) = parse_io_pair(fields[6]).unwrap_or((0, 0));
        samples.push(StatSample {
            container_id: id.to_string(),
            name: fields[1].trim().to_string(),
            cpu_percent: parse_percent(fields[2]).unwrap_or(0.0),
            mem_bytes,
            mem_limit_bytes,
            mem_percent: parse_percent(fields[4])
                .unwrap_or_else(|| percent_of(mem_bytes, mem_limit_bytes)),
            net_rx_bytes,
            net_tx_bytes,
            net_rx_rate: 0,
            net_tx_rate: 0,
            block_read_bytes,
            block_write_bytes,
            pids: fields[7].trim().parse().unwrap_or(0),
        });
    }
    samples
}

/// 远端采集输出 → 响应。探针段沿用 `docker/list` 的两行自描述格式，
/// 结尾标记换成 `DBXDOCKER_STATS`；marker 缺失（Windows 无 sh、输出损坏）
/// 等价于不可用，按 §2.5 返回 `available:false` 而不是报错。
pub fn stats_payload(output: &str) -> Value {
    let probe = parse_probe_before(output, "DBXDOCKER_STATS");
    let available = probe.docker_found && probe.daemon_ok;
    let needs_sudo = probe.docker_found && !probe.daemon_ok;
    let samples = if available {
        parse_stats_section(marker_section(output, "DBXDOCKER_STATS", None))
    } else {
        Vec::new()
    };
    json!({
        "available": available,
        "needsSudo": needs_sudo,
        "sampledAt": now_ms(),
        "stats": samples,
    })
}

/// 不可用响应（本机 CLI 缺失/daemon 拒绝）：仍然成功返回，让面板降级
/// 成一行提示而不是整块报错。
pub fn unavailable_stats(needs_sudo: bool) -> Value {
    json!({
        "available": false,
        "needsSudo": needs_sudo,
        "sampledAt": now_ms(),
        "stats": [],
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

// —— Rate cache (in-memory, bounded) ————————————————————

#[derive(Debug, Clone, Copy)]
struct CachedTotals {
    rx: u64,
    tx: u64,
    at: Instant,
}

fn stats_cache() -> &'static Mutex<BTreeMap<String, BTreeMap<String, CachedTotals>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, BTreeMap<String, CachedTotals>>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 用上一次同 key 采样补齐 `netRxRate` / `netTxRate`，并把本次累计值写回
/// 缓存。并发调用只会丢弃一次差分（锁毒化时直接返回 0），不影响快照。
pub fn apply_rates(cache_key: &str, samples: &mut [StatSample], now: Instant) {
    if samples.is_empty() {
        return;
    }
    let Ok(mut cache) = stats_cache().lock() else {
        return;
    };
    if !cache.contains_key(cache_key) && cache.len() >= STATS_CACHE_KEYS {
        cache.clear();
    }
    let previous = cache.entry(cache_key.to_string()).or_default();
    // 新表只保留本次样本：长会话里容器反复创建/销毁不会让 key 内的
    // 记录无界增长（上限 = 单次请求的 50 个容器）。
    let mut next: BTreeMap<String, CachedTotals> = BTreeMap::new();
    for sample in samples.iter_mut() {
        match previous.get(&sample.container_id) {
            Some(prev) => {
                let window = now.saturating_duration_since(prev.at);
                sample.net_rx_rate = rate_bytes_per_sec(prev.rx, sample.net_rx_bytes, window);
                sample.net_tx_rate = rate_bytes_per_sec(prev.tx, sample.net_tx_bytes, window);
            }
            None => {
                sample.net_rx_rate = 0;
                sample.net_tx_rate = 0;
            }
        }
        next.insert(
            sample.container_id.clone(),
            CachedTotals {
                rx: sample.net_rx_bytes,
                tx: sample.net_tx_bytes,
                at: now,
            },
        );
    }
    *previous = next;
}

/// 对响应体里的 `stats` 应用速率差分（RPC 收口处调用一次，避免重试路径
/// 把缓存写两遍）。
pub fn apply_payload_rates(cache_key: &str, payload: &mut Value) {
    let Some(entries) = payload.get("stats").and_then(Value::as_array) else {
        return;
    };
    let mut samples: Vec<StatSample> = entries
        .iter()
        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
        .collect();
    apply_rates(cache_key, &mut samples, Instant::now());
    if let Ok(value) = serde_json::to_value(&samples) {
        payload["stats"] = value;
    }
}

// —— Local collector ——————————————————————————————————————

/// `docker/stats` 的 `target:"local"` 面：argv 直呼 CLI（无 shell），
/// CLI 缺失 / daemon 拒绝都降级为 `available:false`。
pub async fn collect_stats_local(
    engine: &EngineConfig,
    container_ids: &[String],
) -> Result<Value, String> {
    for id in container_ids {
        validate_container_id(id)?;
    }
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Ok(unavailable_stats(false));
    };
    let mut args: Vec<&str> = vec!["stats", "--no-stream", "--format", STATS_FORMAT, "--"];
    args.extend(container_ids.iter().map(String::as_str));
    let (code, output) = run_local(&cli, &args, STATS_TIMEOUT, engine.endpoint.as_deref()).await?;
    // 非 0 且一行数据都没有：CLI/daemon 层面的失败，按探针语义降级
    // （权限签名 → needsSudo，其他 → 纯 unavailable）。有数据时即使退出码
    // 非 0（部分容器已不存在）也照常返回已采到的行。
    if code != 0 && parse_stats_section(&output).is_empty() {
        return Ok(unavailable_stats(is_daemon_permission_failure(
            code, &output,
        )));
    }
    Ok(stats_payload(&format!(
        "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_STATS\n{output}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_line() -> &'static str {
        "3f2a1b4c5d6e\tweb-1\t12.34%\t1.5KiB / 2.3GiB\t0.01%\t1.2kB / 0B\t4.5MB / 1.1GB\t7"
    }

    #[test]
    fn parses_docker_byte_units() {
        assert_eq!(parse_bytes("0B"), Some(0));
        assert_eq!(parse_bytes("1.2kB"), Some(1200));
        assert_eq!(parse_bytes("1.5KiB"), Some(1536));
        assert_eq!(parse_bytes("2.3GiB"), Some(2_469_606_195));
        assert_eq!(parse_bytes("976MiB"), Some(976 * 1024 * 1024));
        assert_eq!(parse_bytes(" 42B "), Some(42));
        assert_eq!(parse_bytes("12Bogus"), None);
        assert_eq!(parse_bytes("--"), None);
        assert_eq!(parse_bytes(""), None);
    }

    #[test]
    fn parses_percent_and_io_pairs() {
        assert_eq!(parse_percent("12.34%"), Some(12.34));
        assert_eq!(parse_percent("0.00%"), Some(0.0));
        assert_eq!(parse_percent("--"), None);
        assert_eq!(parse_io_pair("1.2kB / 0B"), Some((1200, 0)));
        assert_eq!(
            parse_mem_usage("1.5KiB / 2.3GiB"),
            Some((1536, 2_469_606_195))
        );
        assert_eq!(parse_io_pair("1.2kB"), None);
    }

    #[test]
    fn rate_is_delta_per_second_and_survives_counter_reset() {
        assert_eq!(
            rate_bytes_per_sec(1_000, 4_000, Duration::from_secs(3)),
            1_000
        );
        assert_eq!(
            rate_bytes_per_sec(5_000, 10, Duration::from_secs(3)),
            0,
            "container restart must not underflow"
        );
        assert_eq!(
            rate_bytes_per_sec(0, 1_000_000, Duration::from_millis(100)),
            0,
            "too-short window is not scaled up"
        );
    }

    #[test]
    fn parses_stats_section_and_drops_junk_rows() {
        let section = format!(
            "{}\nnot-a-row\n3f2a1b4c5d6e\tdupe\t0.00%\t0B / 0B\t0.00%\t0B / 0B\t0B / 0B\t0\n",
            sample_line()
        );
        let samples = parse_stats_section(&section);
        assert_eq!(samples.len(), 1);
        let sample = &samples[0];
        assert_eq!(sample.container_id, "3f2a1b4c5d6e");
        assert_eq!(sample.name, "web-1");
        assert_eq!(sample.cpu_percent, 12.34);
        assert_eq!(sample.mem_bytes, 1536);
        assert_eq!(sample.mem_percent, 0.01);
        assert_eq!(sample.net_rx_bytes, 1200);
        assert_eq!(sample.net_tx_bytes, 0);
        assert_eq!(sample.pids, 7);
        assert_eq!(sample.net_rx_rate, 0);
    }

    #[test]
    fn mem_percent_falls_back_when_limit_is_unknown() {
        let line = "3f2a1b4c5d6e\tweb-1\t1.00%\t2.0MiB / 0B\t--\t0B / 0B\t0B / 0B\t--";
        let samples = parse_stats_section(line);
        assert_eq!(samples[0].mem_percent, 0.0);
        assert_eq!(samples[0].pids, 0);
    }

    #[test]
    fn unavailable_when_probe_marker_missing() {
        let payload = stats_payload("docker: command not found");
        assert_eq!(payload["available"], false);
        assert_eq!(payload["needsSudo"], false);
        assert_eq!(payload["stats"], json!([]));
    }

    #[test]
    fn needs_sudo_when_cli_found_but_daemon_denied() {
        let payload =
            stats_payload("DBXDOCKER_PROBE\ndocker-found\ndaemon-denied\nDBXDOCKER_STATS\n");
        assert_eq!(payload["available"], false);
        assert_eq!(payload["needsSudo"], true);
    }

    #[test]
    fn payload_parses_full_collector_output() {
        let payload = stats_payload(&format!(
            "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_STATS\n{}\n",
            sample_line()
        ));
        assert_eq!(payload["available"], true);
        assert_eq!(payload["stats"].as_array().map(Vec::len), Some(1));
        assert_eq!(payload["stats"][0]["containerId"], "3f2a1b4c5d6e");
    }

    #[test]
    fn container_ids_are_gated_and_bounded() {
        assert_eq!(
            parse_container_ids(&json!({ "containerIds": ["3f2a1b4c5d6e", "3f2a1b4c5d6e"] })),
            Ok(vec!["3f2a1b4c5d6e".to_string()])
        );
        for bad in [
            json!({}),
            json!({ "containerIds": [] }),
            json!({ "containerIds": "3f2a1b4c5d6e" }),
            json!({ "containerIds": ["web-nginx"] }),
            json!({ "containerIds": [7] }),
            json!({ "containerIds": ["3f2a1b4c5d6e); rm -rf /"] }),
        ] {
            assert!(parse_container_ids(&bad).is_err(), "{bad}");
        }
        let too_many = (0..51)
            .map(|_| "3f2a1b4c5d6e".to_string())
            .collect::<Vec<_>>();
        assert!(parse_container_ids(&json!({ "containerIds": too_many })).is_err());
    }

    #[test]
    fn script_keeps_ids_out_of_the_body() {
        let engine = EngineConfig::default();
        let ids = vec!["3f2a1b4c5d6e".to_string()];
        let script = stats_script(&engine, &ids).expect("script");
        assert!(script.starts_with("sh -c '"), "{script}");
        assert!(script.contains(" sh '3f2a1b4c5d6e'"), "{script}");
        assert!(script.contains("\"$@\""), "{script}");
        assert!(!stats_body(&engine).contains("3f2a1b4c5d6e"));
        assert!(stats_script(&engine, &["3f2a1b4c5d6e'; rm -rf /".to_string()]).is_err());
    }

    #[test]
    fn rate_cache_keeps_only_the_current_sample_set() {
        let start = Instant::now();
        let mut first = parse_stats_section(sample_line());
        apply_rates("bounded-key", &mut first, start);
        let mut second = parse_stats_section(
            "aabbccddeeff\tother\t0.00%\t0B / 0B\t0.00%\t0B / 0B\t0B / 0B\t0\n",
        );
        apply_rates("bounded-key", &mut second, start + Duration::from_secs(3));
        let cache = stats_cache().lock().expect("rate cache");
        let entry = cache.get("bounded-key").expect("cache key");
        assert_eq!(entry.len(), 1, "stale container ids must be pruned");
        assert!(entry.contains_key("aabbccddeeff"));
    }

    #[test]
    fn rates_use_the_previous_same_key_sample() {
        let mut first = parse_stats_section(sample_line());
        apply_rates("test-key", &mut first, Instant::now());
        assert_eq!(first[0].net_rx_rate, 0, "first sample has no baseline");

        let mut second = parse_stats_section(
            "3f2a1b4c5d6e\tweb-1\t1.00%\t2.3KiB / 2.3GiB\t0.01%\t2.2kB / 1kB\t4.5MB / 1.1GB\t7",
        );
        let later = Instant::now() + Duration::from_secs(3);
        apply_rates("test-key", &mut second, later);
        // 1.2kB → 2.2kB over 3s = 1000/3 ≈ 333 B/s。
        assert_eq!(second[0].net_rx_rate, 333);
        assert_eq!(second[0].net_tx_rate, 333);
    }
}
