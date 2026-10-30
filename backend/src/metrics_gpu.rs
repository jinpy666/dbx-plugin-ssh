//! GPU / Ascend NPU accelerator overview sections for the metrics document
//! (IMPL_PLAN Task P1-4). The shape mirrors [`crate::metrics`]: one POSIX
//! shell collector per accelerator family whose raw output is wrapped in
//! `BEGIN`/`END` marker lines, plus pure parser functions so hand-written
//! Linux fixtures drive the unit tests without a server.
//!
//! * NVIDIA: `nvidia-smi --query-gpu` CSV (quote-aware: model names may
//!   contain commas) + `--query-compute-apps` processes joined onto their
//!   GPU by uuid (MIG `GPU-uuid/…` instance rows included). `N/A`,
//!   `[Not Supported]` and empty fields become JSON null.
//! * Ascend: `npu-smi info` found on `PATH`, `/usr/local/bin` or the CANN
//!   driver tools directory; the `|`-separated table is parsed into
//!   per-chip devices keyed `ascend:{npu_index}:{chip_id}` (one card with
//!   several dies yields several devices), HBM preferred over Memory when
//!   the header says so, and a missing process table degrades to empty.

use russh::client::Handle;
use serde::Serialize;

use crate::exec::exec_plain;
use crate::ssh::SshClient;

/// MiB per byte-count unit: `nvidia-smi --format=csv,nounits` memory columns
/// and npu-smi `*-Usage(MB)` columns are MiB; the JSON payload exposes byte
/// counts so the frontend can reuse the shared byte formatter directly.
const MIB: u64 = 1024 * 1024;

/// Read-only collector: `command -v` availability probe first (`GPU_AVAILABLE
/// 0/1`), then the two CSV queries wrapped in marker lines so a driver that
/// half-works cannot corrupt the framing.
pub fn gpu_overview_script() -> String {
    concat!(
        "if command -v nvidia-smi >/dev/null 2>&1; then ",
        "echo 'GPU_AVAILABLE 1'; ",
        "echo GPU_CSV_BEGIN; ",
        "nvidia-smi --query-gpu=index,uuid,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit,fan.speed,pstate --format=csv,noheader,nounits 2>/dev/null; ",
        "echo GPU_CSV_END; ",
        "echo GPU_PROCESS_CSV_BEGIN; ",
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name --format=csv,noheader,nounits 2>/dev/null; ",
        "echo GPU_PROCESS_CSV_END; ",
        "else echo 'GPU_AVAILABLE 0'; fi",
    )
    .to_string()
}

/// Read-only collector: npu-smi probed on `PATH`, then the two well-known
/// absolute locations (the driver tools directory glob needs `-x` checks
/// because unmatched globs stay literal), then the CANN toolkit version from
/// the Ascend install-info files (toolkit, nnae, nnrt — first hit wins).
pub fn npu_overview_script() -> String {
    concat!(
        "npu_bin=''; ",
        "if command -v npu-smi >/dev/null 2>&1; then npu_bin='npu-smi'; ",
        "elif [ -x /usr/local/bin/npu-smi ]; then npu_bin='/usr/local/bin/npu-smi'; ",
        "else for p in /usr/local/Ascend/driver/tools/*/npu-smi; do ",
        "if [ -x \"$p\" ]; then npu_bin=\"$p\"; break; fi; done; fi; ",
        "if [ -n \"$npu_bin\" ]; then ",
        "echo 'NPU_AVAILABLE 1'; ",
        "echo NPU_SMI_BEGIN; ",
        "\"$npu_bin\" info 2>/dev/null; ",
        "echo NPU_SMI_END; ",
        "else echo 'NPU_AVAILABLE 0'; fi; ",
        "for f in /usr/local/Ascend/ascend_toolkit_install.info /usr/local/Ascend/ascend_nnae_install.info /usr/local/Ascend/ascend_nnrt_install.info; do ",
        "if [ -r \"$f\" ]; then ",
        "cann=$(awk -F= '/^version=/{print $2; exit}' \"$f\" 2>/dev/null); ",
        "if [ -z \"$cann\" ]; then cann=$(head -n 1 \"$f\" 2>/dev/null); fi; ",
        "if [ -n \"$cann\" ]; then echo \"NPU_CANN $cann\"; break; fi; fi; done",
    )
    .to_string()
}

/// Top-level NVIDIA overview: `available` mirrors the `GPU_AVAILABLE` probe
/// line; `gpus` carries one entry per physical GPU with its compute
/// processes attached.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuOverview {
    pub available: bool,
    pub gpus: Vec<GpuInfo>,
}

/// One physical GPU. Device identity is the uuid (stable across driver
/// reloads and unique under MIG); memory fields are byte counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u64,
    pub uuid: String,
    pub name: String,
    pub driver: Option<String>,
    /// GPU temperature in degrees Celsius.
    pub temperature: Option<f64>,
    /// GPU utilization percent.
    pub utilization: Option<f64>,
    /// Memory-controller utilization percent (`utilization.memory`).
    pub mem_util: Option<f64>,
    pub total_mem: Option<u64>,
    pub used_mem: Option<u64>,
    pub free_mem: Option<u64>,
    /// Current board power draw in watts.
    pub power_draw: Option<f64>,
    /// Enforced power limit in watts (`[Not Supported]` on many boards).
    pub power_limit: Option<f64>,
    /// Fan speed percent (`[N/A]` on passively cooled boards).
    pub fan: Option<f64>,
    /// Performance state such as `P0` (max) or `P8` (idle).
    pub pstate: Option<String>,
    pub processes: Vec<GpuProcess>,
}

/// One compute process on a GPU, joined onto its card by uuid.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuProcess {
    pub uuid: String,
    pub pid: u64,
    /// GPU memory used by the process, in bytes.
    pub mem: Option<u64>,
    pub name: String,
}

/// Top-level Ascend overview. `cann` is the toolkit/nnae/nnrt version string
/// when an Ascend install-info file was readable.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpuOverview {
    pub available: bool,
    pub cann: Option<String>,
    pub devices: Vec<NpuDevice>,
}

/// One NPU chip. Ascend exposes one-card-many-chip cards as repeated rows
/// under the same NPU index, so the device key pairs the NPU index with the
/// chip id (`ascend:{npu_index}:{chip_id}`). Memory fields are byte counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpuDevice {
    pub device_key: String,
    pub npu_index: u64,
    pub chip_id: u64,
    /// Card model such as `910B4` or `310P3`.
    pub name: String,
    /// `OK` / `Warning` / `Error` as reported by npu-smi.
    pub health: Option<String>,
    /// Board power draw in watts.
    pub power: Option<f64>,
    /// Chip temperature in degrees Celsius.
    pub temperature: Option<f64>,
    /// AI Core utilization percent.
    pub aicore: Option<f64>,
    /// `hbm` when the header says HBM-Usage, `memory` otherwise.
    pub memory_label: Option<String>,
    pub used_mem: Option<u64>,
    pub total_mem: Option<u64>,
    pub processes: Vec<NpuProcess>,
}

/// One compute process on an NPU chip (joined by NPU index; the process
/// table's Device ID column carries the NPU index).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpuProcess {
    pub pid: u64,
    pub name: String,
    pub npu_index: u64,
    /// Device memory used by the process, in bytes.
    pub mem: Option<u64>,
}

/// Collects the NVIDIA GPU overview over a new exec channel (read-only).
pub async fn collect_gpu_overview(handle: &Handle<SshClient>) -> Result<serde_json::Value, String> {
    let outcome = exec_plain(
        handle,
        &gpu_overview_script(),
        std::time::Duration::from_secs(3),
        &[],
    )
    .await?;
    Ok(parse_gpu_overview_output(&outcome.output))
}

/// Collects the Ascend NPU overview over a new exec channel (read-only).
pub async fn collect_npu_overview(handle: &Handle<SshClient>) -> Result<serde_json::Value, String> {
    let outcome = exec_plain(
        handle,
        &npu_overview_script(),
        std::time::Duration::from_secs(3),
        &[],
    )
    .await?;
    Ok(parse_npu_overview_output(&outcome.output))
}

/// Parses `nvidia-smi --query-gpu` + `--query-compute-apps` collector output
/// into the `gpu` metrics section. Pure so it can be unit-tested without a
/// server.
pub fn parse_gpu_overview_output(output: &str) -> serde_json::Value {
    let available = output.lines().any(|line| line.trim() == "GPU_AVAILABLE 1");
    let mut gpus: Vec<GpuInfo> = Vec::new();
    for row in marker_section(output, "GPU_CSV_BEGIN", "GPU_CSV_END").lines() {
        let fields = split_csv_row(row);
        if fields.len() < 14 {
            continue;
        }
        let Ok(index) = fields[0].parse::<u64>() else {
            continue;
        };
        let uuid = fields[1].clone();
        if uuid.is_empty() {
            continue;
        }
        gpus.push(GpuInfo {
            index,
            uuid,
            name: fields[2].clone(),
            driver: optional_string(&fields[3]),
            temperature: parse_optional_f64(&fields[4]),
            utilization: parse_optional_f64(&fields[5]),
            mem_util: parse_optional_f64(&fields[6]),
            total_mem: parse_optional_u64(&fields[7]).map(mib_bytes),
            used_mem: parse_optional_u64(&fields[8]).map(mib_bytes),
            free_mem: parse_optional_u64(&fields[9]).map(mib_bytes),
            power_draw: parse_optional_f64(&fields[10]),
            power_limit: parse_optional_f64(&fields[11]),
            fan: parse_optional_f64(&fields[12]),
            pstate: optional_string(&fields[13]),
            processes: Vec::new(),
        });
    }
    for row in marker_section(output, "GPU_PROCESS_CSV_BEGIN", "GPU_PROCESS_CSV_END").lines() {
        let fields = split_csv_row(row);
        if fields.len() < 4 {
            continue;
        }
        let uuid = fields[0].clone();
        let Ok(pid) = fields[1].parse::<u64>() else {
            continue;
        };
        // `query-compute-apps` reports the physical GPU uuid, or a
        // `GPU-uuid/instance` path under MIG — match both.
        let target = gpus.iter_mut().find(|gpu| {
            gpu.uuid == uuid
                || uuid
                    .strip_prefix(gpu.uuid.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        });
        if let Some(gpu) = target {
            gpu.processes.push(GpuProcess {
                uuid,
                pid,
                mem: parse_optional_u64(&fields[2]).map(mib_bytes),
                name: fields[3..].join(", "),
            });
        }
    }
    serde_json::to_value(GpuOverview { available, gpus }).unwrap_or_default()
}

/// Parses `npu-smi info` collector output into the `npu` metrics section.
/// Pure so it can be unit-tested without a server.
pub fn parse_npu_overview_output(output: &str) -> serde_json::Value {
    let available = output.lines().any(|line| line.trim() == "NPU_AVAILABLE 1");
    let cann = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("NPU_CANN ")
            .map(str::trim)
            .filter(|version| !version.is_empty())
            .map(str::to_string)
    });
    let mut devices: Vec<NpuDevice> = Vec::new();
    let mut card: Option<CardState> = None;
    let mut hbm = false;
    let mut in_process_table = false;
    for line in marker_section(output, "NPU_SMI_BEGIN", "NPU_SMI_END").lines() {
        let trimmed = line.trim();
        // Separator rows (`+---+---+`, `+===+===+`) carry no `|` cell body.
        if trimmed.is_empty() || !trimmed.contains('|') {
            continue;
        }
        let cells = pipe_cells(trimmed);
        if cells.is_empty() {
            continue;
        }
        if is_chip_header(&cells) {
            // HBM preferred: only 910-class boards expose an HBM column.
            hbm = cells
                .iter()
                .any(|cell| cell.to_ascii_uppercase().contains("HBM"));
            continue;
        }
        if is_card_header(&cells) {
            card = None;
            in_process_table = false;
            continue;
        }
        if cells
            .iter()
            .any(|cell| cell.to_ascii_lowercase().contains("process"))
        {
            in_process_table = true;
            continue;
        }
        if in_process_table {
            if let Some((pid, name, npu_index, mem)) = parse_npu_process_row(&cells) {
                if let Some(device) = devices
                    .iter_mut()
                    .find(|device| device.npu_index == npu_index)
                {
                    device.processes.push(NpuProcess {
                        pid,
                        name,
                        npu_index,
                        mem,
                    });
                }
            }
            continue;
        }
        let head: Vec<&str> = cells[0].split_whitespace().collect();
        let Some(first) = head.first().and_then(|token| token.parse::<u64>().ok()) else {
            continue;
        };
        if head.len() < 2 {
            continue;
        }
        if head[1].parse::<u64>().is_err() {
            // Card row: `NPU Name | Health | Power(W) Temp(C) Huge-Flash(T)`.
            card = Some(CardState {
                name: head[1..].join(" "),
                health: optional_string(&cells[1]),
                power: detail_tokens(&cells)
                    .first()
                    .and_then(|token| token.parse::<f64>().ok()),
                temperature: detail_tokens(&cells)
                    .get(1)
                    .and_then(|token| token.parse::<f64>().ok()),
            });
        } else {
            // Chip row. npu-smi repeats the NPU index in the first column
            // and distinguishes the dies in the second (`Chip Device`):
            // `| 0 0 |` and `| 0 1 |` are the two dies of one card.
            let Ok(chip_id) = head[1].parse::<u64>() else {
                continue;
            };
            let state = card.as_ref();
            let detail = detail_tokens(&cells);
            let memory = slash_pair(&detail);
            devices.push(NpuDevice {
                device_key: format!("ascend:{}:{}", first, chip_id),
                npu_index: first,
                chip_id,
                name: state.map_or_else(String::new, |state| state.name.clone()),
                health: state.and_then(|state| state.health.clone()),
                power: state.and_then(|state| state.power),
                temperature: state.and_then(|state| state.temperature),
                aicore: detail.first().and_then(|token| token.parse::<f64>().ok()),
                memory_label: Some(if hbm { "hbm" } else { "memory" }.to_string()),
                used_mem: memory.and_then(|(used, _)| used).map(mib_bytes),
                total_mem: memory.and_then(|(_, total)| total).map(mib_bytes),
                processes: Vec::new(),
            });
        }
    }
    serde_json::to_value(NpuOverview {
        available,
        cann,
        devices,
    })
    .unwrap_or_default()
}

/// Card-level values shared by every chip of one physical card (parsed once
/// per card row, reused for each following chip row). The NPU index itself
/// comes from the chip row's first column, which npu-smi keeps in sync.
struct CardState {
    name: String,
    health: Option<String>,
    power: Option<f64>,
    temperature: Option<f64>,
}

/// Raw text between two marker lines. A missing `END` marker runs to the end
/// of the output; a missing `BEGIN` yields nothing. Marker lines are
/// compared trimmed so CRLF output still matches.
fn marker_section<'a>(output: &'a str, begin: &str, end: &str) -> &'a str {
    let mut start: Option<usize> = None;
    let mut cursor = 0;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim();
        if let Some(begin_offset) = start {
            if trimmed == end {
                return &output[begin_offset..cursor];
            }
        } else if trimmed == begin {
            start = Some(cursor + line.len());
        }
        cursor += line.len();
    }
    match start {
        Some(begin_offset) => &output[begin_offset..],
        None => "",
    }
}

/// Splits one CSV row on commas outside double quotes; a `""` pair inside a
/// quoted field collapses to a literal quote. nvidia-smi quotes the GPU name
/// when it contains a comma (`"NVIDIA GeForce RTX 3090, 24GB"`).
fn split_csv_row(row: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = row.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            fields.push(current.trim().to_string());
            current = String::new();
        } else {
            current.push(c);
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// Trims the outer pipe columns of one npu-smi table row into cells
/// (`| a | b |` becomes `["a", "b"]`).
fn pipe_cells(line: &str) -> Vec<String> {
    let columns: Vec<&str> = line.split('|').collect();
    if columns.len() < 3 {
        return Vec::new();
    }
    columns[1..columns.len() - 1]
        .iter()
        .map(|cell| cell.trim().to_string())
        .collect()
}

/// Device-table header first row (`| NPU Name | Health | Power… |`).
fn is_card_header(cells: &[String]) -> bool {
    cells.first().is_some_and(|first| {
        let tokens: Vec<&str> = first.split_whitespace().collect();
        tokens.contains(&"NPU") && tokens.contains(&"Name")
    })
}

/// Device-table header second row (`| Chip Device | Bus-Id | Aicore… |`).
fn is_chip_header(cells: &[String]) -> bool {
    cells.first().is_some_and(|first| {
        let tokens: Vec<&str> = first.split_whitespace().collect();
        tokens.contains(&"Chip") && tokens.contains(&"Device")
    })
}

/// Whitespace tokens of a table row's detail column (the last one).
fn detail_tokens(cells: &[String]) -> Vec<&str> {
    cells
        .get(2)
        .map(|cell| cell.split_whitespace().collect())
        .unwrap_or_default()
}

/// `used / total` pair around the slash token of a detail column.
fn slash_pair(tokens: &[&str]) -> Option<(Option<u64>, Option<u64>)> {
    let position = tokens
        .iter()
        .position(|token| *token == "/")
        .filter(|position| *position > 0)?;
    let used = tokens[position - 1].parse::<u64>().ok();
    let total = tokens
        .get(position + 1)
        .and_then(|token| token.parse::<u64>().ok());
    Some((used, total))
}

/// One process-table data row: pid first, memory last, NPU id second to
/// last, everything between is the (multi-token) process name.
fn parse_npu_process_row(cells: &[String]) -> Option<(u64, String, u64, Option<u64>)> {
    let flattened = cells.join(" ");
    let tokens: Vec<&str> = flattened.split_whitespace().collect();
    if tokens.len() < 3 {
        return None;
    }
    let pid = tokens[0].parse::<u64>().ok()?;
    let mem = tokens[tokens.len() - 1].parse::<u64>().ok().map(mib_bytes);
    let npu_index = tokens[tokens.len() - 2].parse::<u64>().ok()?;
    let name = tokens[1..tokens.len() - 2].join(" ");
    Some((pid, name, npu_index, mem))
}

/// nvidia-smi marks unsupported counters as `N/A`, `[N/A]`,
/// `[Not Supported]`, `[Insufficient Permissions]` or an empty field; all of
/// them collapse to JSON null instead of failing the row.
fn is_unsupported(field: &str) -> bool {
    let value = field.trim();
    value.is_empty()
        || value.eq_ignore_ascii_case("n/a")
        || (value.starts_with('[') && value.ends_with(']'))
}

fn optional_string(field: &str) -> Option<String> {
    let value = field.trim();
    if is_unsupported(value) {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_optional_f64(field: &str) -> Option<f64> {
    if is_unsupported(field) {
        None
    } else {
        field.trim().parse::<f64>().ok()
    }
}

fn parse_optional_u64(field: &str) -> Option<u64> {
    if is_unsupported(field) {
        None
    } else {
        field.trim().parse::<u64>().ok()
    }
}

/// MiB column value to a byte count (see [`MIB`]).
fn mib_bytes(mib: u64) -> u64 {
    mib.saturating_mul(MIB)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// nvidia-smi CSV fixture: the 3090's model name is quoted (contains a
    /// comma), the A100 reports `N/A` / `[Not Supported]` on several
    /// counters, and one compute process points at a uuid no listed GPU owns.
    const GPU_FIXTURE: &str = "\
GPU_AVAILABLE 1
GPU_CSV_BEGIN
0, GPU-5a1b2c3d-1111-2222-3333-444455556666, \"NVIDIA GeForce RTX 3090, 24GB\", 535.129.03, 45, 12, 30, 24576, 8192, 16384, 65.02, 350.00, 60, P2
1, GPU-9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff, NVIDIA A100-SXM4-40GB, 535.129.03, [N/A], 0, 0, 40960, 1024, 39936, N/A, [Not Supported], [N/A], P0
GPU_CSV_END
GPU_PROCESS_CSV_BEGIN
GPU-5a1b2c3d-1111-2222-3333-444455556666, 4321, 4096, python3
GPU-5a1b2c3d-1111-2222-3333-444455556666, 4322, 512, /usr/local/bin/trainer --epochs 10
GPU-deadbeef-0000-0000-0000-000000000000, 999, 100, mystery
GPU_PROCESS_CSV_END
";

    /// Collector output when nvidia-smi is not installed.
    const GPU_UNAVAILABLE_FIXTURE: &str = "GPU_AVAILABLE 0\n";

    /// npu-smi info fixture: header rows plus data rows in Ascend's
    /// `|`-separated layout, npu 0 carries two chips (one card, two dies),
    /// HBM column present, process table with Device-ID association and a
    /// CANN toolkit version line.
    const NPU_FIXTURE: &str = "\
NPU_AVAILABLE 1
NPU_SMI_BEGIN
+-------------------------------------------------------------------------------------------+
| npu-smi 23.0.0                            Version: 23.0.0                                 |
+---------------------------+----------------+----------------------------------------------+
| NPU     Name              | Health         | Power(W)     Temp(C)         Huge-Flash(T)  |
| Chip    Device            | Bus-Id         | Aicore(%)    ASICL(%)        HBM-Usage(MB)  |
+===========================+================+==============================================+
| 0       910B4             | OK             | 63.6         42               0 / 0         |
| 0       0                 | 0000:C1:00.0   | 0            0                8192 / 32509  |
| 0       1                 | 0000:C1:00.1   | 12           0                10240 / 32509 |
+===========================+================+==============================================+
| 1       310P3             | OK             | 43.5         40               0 / 0         |
| 1       0                 | 0000:C2:00.0   | 0            0                512 / 21504   |
+===========================+================+==============================================+
+-------------------------------------------------------------------------------------------+
| Process ID                 Process name                    | Device ID | Memory(MB)        |
+-------------------------------------------------------------------------------------------+
| 123456    python3                                           | 0         | 4096              |
| 123457    mindspore                                         | 1         | 2048              |
+-------------------------------------------------------------------------------------------+
NPU_SMI_END
NPU_CANN 8.0.RC1
";

    /// npu-smi info without an HBM column (older DDR-based cards) and with
    /// the process table missing entirely.
    const NPU_DDR_NO_PROCS_FIXTURE: &str = "\
NPU_AVAILABLE 1
NPU_SMI_BEGIN
+---------------------------+----------------+----------------------------------------------+
| NPU     Name              | Health         | Power(W)     Temp(C)         Huge-Flash(T)  |
| Chip    Device            | Bus-Id         | Aicore(%)    ASICL(%)        DDR-Usage(MB)  |
+===========================+================+==============================================+
| 0       310P3             | OK             | 43.5         40               0 / 0         |
| 0       0                 | 0000:C1:00.0   | 0            0                512 / 21504   |
+===========================+================+==============================================+
NPU_SMI_END
";

    const NPU_UNAVAILABLE_FIXTURE: &str = "NPU_AVAILABLE 0\n";

    // —— GPU collector script ———————————————————————

    #[test]
    fn gpu_script_probes_and_wraps_both_queries() {
        let script = gpu_overview_script();
        assert!(script.contains("command -v nvidia-smi"), "{script}");
        assert!(script.contains("GPU_AVAILABLE"), "{script}");
        assert!(
            script.contains("GPU_CSV_BEGIN") && script.contains("GPU_CSV_END"),
            "{script}"
        );
        assert!(
            script.contains("GPU_PROCESS_CSV_BEGIN") && script.contains("GPU_PROCESS_CSV_END"),
            "{script}"
        );
        assert!(
            script.contains(
                "--query-gpu=index,uuid,name,driver_version,temperature.gpu,utilization.gpu,\
                 utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit,\
                 fan.speed,pstate"
            ),
            "{script}"
        );
        assert!(
            script.contains("--query-compute-apps=gpu_uuid,pid,used_gpu_memory,process_name"),
            "{script}"
        );
        assert!(script.contains("--format=csv,noheader,nounits"), "{script}");
    }

    #[test]
    fn npu_script_probes_all_paths_and_reads_cann() {
        let script = npu_overview_script();
        assert!(script.contains("command -v npu-smi"), "{script}");
        assert!(script.contains("/usr/local/bin/npu-smi"), "{script}");
        assert!(
            script.contains("/usr/local/Ascend/driver/tools/*/npu-smi"),
            "{script}"
        );
        assert!(script.contains("NPU_AVAILABLE"), "{script}");
        assert!(
            script.contains("NPU_SMI_BEGIN") && script.contains("NPU_SMI_END"),
            "{script}"
        );
        assert!(script.contains("NPU_CANN"), "{script}");
        assert!(
            script.contains("/usr/local/Ascend/ascend_toolkit_install.info"),
            "{script}"
        );
        // nnae / nnrt toolkit variants are probed as CANN fallbacks.
        assert!(script.contains("ascend_nnae_install.info"), "{script}");
        assert!(script.contains("ascend_nnrt_install.info"), "{script}");
    }

    // —— GPU parsing ——————————————————————————————————

    #[test]
    fn parses_gpu_csv_with_quoted_names_and_na_fields() {
        let parsed = parse_gpu_overview_output(GPU_FIXTURE);
        assert_eq!(parsed["available"], json!(true));
        let gpus = parsed["gpus"].as_array().unwrap();
        assert_eq!(gpus.len(), 2);

        let rtx = &gpus[0];
        assert_eq!(rtx["index"], json!(0));
        assert_eq!(rtx["uuid"], "GPU-5a1b2c3d-1111-2222-3333-444455556666");
        // The quoted comma inside the model name stays one field.
        assert_eq!(rtx["name"], "NVIDIA GeForce RTX 3090, 24GB");
        assert_eq!(rtx["driver"], "535.129.03");
        assert_eq!(rtx["temperature"], json!(45.0));
        assert_eq!(rtx["utilization"], json!(12.0));
        assert_eq!(rtx["memUtil"], json!(30.0));
        // MiB CSV columns are exposed as byte counts.
        assert_eq!(rtx["totalMem"], json!(24_576_u64 * 1024 * 1024));
        assert_eq!(rtx["usedMem"], json!(8_192_u64 * 1024 * 1024));
        assert_eq!(rtx["freeMem"], json!(16_384_u64 * 1024 * 1024));
        assert_eq!(rtx["powerDraw"], json!(65.02));
        assert_eq!(rtx["powerLimit"], json!(350.0));
        assert_eq!(rtx["fan"], json!(60.0));
        assert_eq!(rtx["pstate"], "P2");

        let a100 = &gpus[1];
        // N/A / [Not Supported] collapse to null.
        assert_eq!(a100["temperature"], serde_json::Value::Null);
        assert_eq!(a100["powerDraw"], serde_json::Value::Null);
        assert_eq!(a100["powerLimit"], serde_json::Value::Null);
        assert_eq!(a100["fan"], serde_json::Value::Null);
        assert_eq!(a100["pstate"], "P0");
    }

    #[test]
    fn gpu_processes_join_by_uuid_and_unknowns_drop() {
        let parsed = parse_gpu_overview_output(GPU_FIXTURE);
        let gpus = parsed["gpus"].as_array().unwrap();
        let rtx_processes = gpus[0]["processes"].as_array().unwrap();
        assert_eq!(rtx_processes.len(), 2);
        assert_eq!(rtx_processes[0]["pid"], json!(4321));
        assert_eq!(rtx_processes[0]["name"], "python3");
        assert_eq!(
            rtx_processes[0]["uuid"],
            "GPU-5a1b2c3d-1111-2222-3333-444455556666"
        );
        assert_eq!(rtx_processes[0]["mem"], json!(4_096_u64 * 1024 * 1024));
        // Process names may contain spaces; they stay one field.
        assert_eq!(
            rtx_processes[1]["name"],
            "/usr/local/bin/trainer --epochs 10"
        );
        // The A100 has no compute processes; the orphan process is dropped.
        assert!(gpus[1]["processes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn gpu_unavailable_yields_false_with_empty_list() {
        let parsed = parse_gpu_overview_output(GPU_UNAVAILABLE_FIXTURE);
        assert_eq!(parsed["available"], json!(false));
        assert!(parsed["gpus"].as_array().unwrap().is_empty());
    }

    #[test]
    fn gpu_malformed_csv_rows_are_skipped() {
        let parsed = parse_gpu_overview_output(
            "GPU_AVAILABLE 1\nGPU_CSV_BEGIN\nnot,a,csv,row,at,all,,,,,,,x\n\
             0, GPU-ok, Short GPU, 1.0, 40, 5, 5, 8192, 100, 8092, 10, 100, 50\nGPU_CSV_END\n",
        );
        // The short row (13 fields) is skipped; nothing crashes.
        assert_eq!(parsed["gpus"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn gpu_escaped_quotes_inside_names_survive() {
        let parsed = parse_gpu_overview_output(
            "GPU_AVAILABLE 1\nGPU_CSV_BEGIN\n\
             0, GPU-qq, \"Model \"\"Pro\"\", 24GB\", 1.0, 40, 5, 5, 8192, 100, 8092, 10, 100, 50, P0\n\
             GPU_CSV_END\nGPU_PROCESS_CSV_BEGIN\nGPU_PROCESS_CSV_END\n",
        );
        assert_eq!(parsed["gpus"][0]["name"], "Model \"Pro\", 24GB");
    }

    // —— NPU parsing ——————————————————————————————————

    #[test]
    fn parses_npu_devices_with_hbm_and_multi_chip_card() {
        let parsed = parse_npu_overview_output(NPU_FIXTURE);
        assert_eq!(parsed["available"], json!(true));
        assert_eq!(parsed["cann"], "8.0.RC1");
        let devices = parsed["devices"].as_array().unwrap();
        // npu 0 owns two chips, npu 1 one chip.
        assert_eq!(devices.len(), 3);

        let first = &devices[0];
        assert_eq!(first["deviceKey"], "ascend:0:0");
        assert_eq!(first["npuIndex"], json!(0));
        assert_eq!(first["chipId"], json!(0));
        assert_eq!(first["name"], "910B4");
        assert_eq!(first["health"], "OK");
        assert_eq!(first["power"], json!(63.6));
        assert_eq!(first["temperature"], json!(42.0));
        assert_eq!(first["aicore"], json!(0.0));
        // HBM preferred: the chip header says HBM-Usage.
        assert_eq!(first["memoryLabel"], "hbm");
        assert_eq!(first["usedMem"], json!(8_192_u64 * 1024 * 1024));
        assert_eq!(first["totalMem"], json!(32_509_u64 * 1024 * 1024));

        let second = &devices[1];
        assert_eq!(second["deviceKey"], "ascend:0:1");
        assert_eq!(second["chipId"], json!(1));
        assert_eq!(second["aicore"], json!(12.0));
        assert_eq!(second["usedMem"], json!(10_240_u64 * 1024 * 1024));

        let third = &devices[2];
        assert_eq!(third["deviceKey"], "ascend:1:0");
        assert_eq!(third["name"], "310P3");
        assert_eq!(third["usedMem"], json!(512_u64 * 1024 * 1024));
    }

    #[test]
    fn npu_processes_attach_to_matching_npu_index() {
        let parsed = parse_npu_overview_output(NPU_FIXTURE);
        let devices = parsed["devices"].as_array().unwrap();
        let first_processes = devices[0]["processes"].as_array().unwrap();
        assert_eq!(first_processes.len(), 1);
        assert_eq!(first_processes[0]["pid"], json!(123456));
        assert_eq!(first_processes[0]["name"], "python3");
        assert_eq!(first_processes[0]["npuIndex"], json!(0));
        assert_eq!(first_processes[0]["mem"], json!(4_096_u64 * 1024 * 1024));
        // npu 1's process lands on the matching device; npu 0 chip 1 has none.
        assert_eq!(devices[1]["processes"].as_array().unwrap().len(), 0);
        assert_eq!(devices[2]["processes"].as_array().unwrap().len(), 1);
        assert_eq!(devices[2]["processes"][0]["pid"], json!(123457));
    }

    #[test]
    fn npu_without_hbm_uses_memory_label_and_tolerates_missing_process_table() {
        let parsed = parse_npu_overview_output(NPU_DDR_NO_PROCS_FIXTURE);
        assert_eq!(parsed["available"], json!(true));
        assert_eq!(parsed["cann"], serde_json::Value::Null);
        let devices = parsed["devices"].as_array().unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0]["memoryLabel"], "memory");
        assert!(devices[0]["processes"].as_array().unwrap().is_empty());
    }

    #[test]
    fn npu_unavailable_yields_false_with_empty_list() {
        let parsed = parse_npu_overview_output(NPU_UNAVAILABLE_FIXTURE);
        assert_eq!(parsed["available"], json!(false));
        assert!(parsed["devices"].as_array().unwrap().is_empty());
        assert_eq!(parsed["cann"], serde_json::Value::Null);
    }

    #[test]
    fn npu_empty_or_absent_sections_degrade_cleanly() {
        // A probe that found the binary but the info call failed.
        let parsed = parse_npu_overview_output("NPU_AVAILABLE 1\nNPU_SMI_BEGIN\nNPU_SMI_END\n");
        assert_eq!(parsed["available"], json!(true));
        assert!(parsed["devices"].as_array().unwrap().is_empty());
        // No output at all (exec failed on a weird shell): everything empty.
        let empty = parse_npu_overview_output("");
        assert_eq!(empty["available"], json!(false));
        assert!(empty["devices"].as_array().unwrap().is_empty());
    }
}
