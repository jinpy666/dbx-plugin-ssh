//! 结构守卫：文件体积预算。
//!
//! 为什么需要：`ssh.rs` 已近 1.9 万行、`mcp.rs` 9 千余行，单文件继续膨胀会让
//! review 成本、编译并行度与冲突面失控，而这类退化在 PR 里很难靠肉眼拦住。
//! 这里把「生产源码 ≤ 600 行、测试/规格文件 ≤ 1200 行」变成可执行的检查。
//!
//! 存量债务用冻结白名单过渡：条目值 = 当前行数，**只允许收缩**——文件缩到
//! 预算内或被删除后，条目必须删除，否则测试失败。新增条目等于承认新的单体，
//! 需要在 PR 里说明理由。
//!
//! 白名单从真实文件树生成（失败信息里给出 `路径: 行数`），不要手写行数。
//!
//! 本文件仅在 `#[cfg(test)]` 下编译，不进入 sidecar 运行时，也不引入依赖。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 生产源码预算。
const MAX_SOURCE_LINES: usize = 600;
/// 测试/规格文件预算（用例与断言天然更长）。
const MAX_TEST_LINES: usize = 1_200;

/// 迁移期白名单：相对 `backend/src` 的路径 → 当前允许的行数。
const LINE_ALLOWLIST: &[(&str, usize)] = &[
    ("mcp.rs", 9266),
    ("ssh.rs", 5611),
    // 纯搬移的结果，总量未增、只是换了位置：
    //   B1：内联测试 → ssh/tests.rs（4,470）
    //   B2a：SFTP/monitor 助手 → ssh/{sftp_session,sftp_ops,sftp_helpers,monitor}.rs
    //   B3：传输原语与共享状态 → ssh/{prompt,transport,leases,state,endpoint}.rs
    // 条目随每批搬移收紧（18,457 → 13,929 → 12,829 → 11,787），阻止 ssh.rs 再长回去；
    // ssh/tests.rs 是测试文件，按测试预算（1,200）登记。
    ("ssh/tests.rs", 4472),
    ("exec.rs", 4777),
    ("connection_import.rs", 4545),
    ("model.rs", 3429),
    ("main.rs", 3372),
    ("local_terminal.rs", 2826),
    ("task_provider.rs", 2709),
    ("triggers.rs", 2229),
    ("serial_xmodem.rs", 2172),
    ("sftp_ext.rs", 1966),
    ("telnet_session.rs", 1839),
    ("sftp_raw.rs", 1784),
    ("preferences.rs", 1651),
    ("serial_session.rs", 1574),
    ("monitor.rs", 1516),
    ("mcp_safety.rs", 1509),
    ("vnc_session.rs", 1508),
    ("metrics.rs", 1476),
    ("file_watch.rs", 1344),
    ("forward.rs", 1219),
    ("otp_store.rs", 1029),
    ("rdp/session.rs", 1024),
    ("x11.rs", 1024),
    ("sudo_profiles.rs", 968),
    ("audit_log.rs", 869),
    ("local_editors.rs", 869),
    ("sudo_fs.rs", 848),
    ("metrics_gpu.rs", 836),
    ("agent_terminal.rs", 834),
    ("transfer_compress.rs", 832),
    ("alert_triage.rs", 801),
    ("session_recording.rs", 794),
    ("local_fs.rs", 755),
    ("sftp_copy.rs", 716),
    ("keys.rs", 706),
    ("lzpack.rs", 674),
    ("ssh/upload_finish.rs", 661),
    ("local_downloads.rs", 614),
];

fn count_lines(text: &str) -> usize {
    text.lines().count()
}

/// 测试文件判定：文件名后缀或 `tests/` 目录。
fn is_test_file(rel: &str) -> bool {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    base == "tests.rs"
        || base.ends_with("_tests.rs")
        || base == "test.rs"
        || base.ends_with("_test.rs")
        || base == "test_support.rs"
        || rel.starts_with("tests/")
        || rel.contains("/tests/")
}

fn budget_for(rel: &str) -> usize {
    if is_test_file(rel) {
        MAX_TEST_LINES
    } else {
        MAX_SOURCE_LINES
    }
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        fs::read_dir(dir).unwrap_or_else(|err| panic!("读取目录 {} 失败: {err}", dir.display()));
    for entry in entries {
        let path = entry.expect("读取目录项").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// `backend/src` 下全部 Rust 源码：相对路径（`/` 分隔）→ 文本。
fn load_sources() -> BTreeMap<String, String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    collect_rs(&root, &mut paths);
    let mut sources = BTreeMap::new();
    for path in paths {
        let rel = path
            .strip_prefix(&root)
            .expect("源码路径必须位于 backend/src 下")
            .to_string_lossy()
            .replace('\\', "/");
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()));
        sources.insert(rel, text);
    }
    sources
}

fn allowlist() -> BTreeMap<String, usize> {
    LINE_ALLOWLIST
        .iter()
        .map(|(rel, lines)| ((*rel).to_string(), *lines))
        .collect()
}

/// 超预算文件 + 陈旧白名单条目。空输入必须返回空结果（自测锁住这一点）。
fn line_violations(
    sources: &BTreeMap<String, String>,
    allow: &BTreeMap<String, usize>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (rel, text) in sources {
        let lines = count_lines(text);
        let limit = allow.get(rel).copied().unwrap_or(budget_for(rel));
        if lines > limit {
            out.push(format!("{rel}: {lines} > {limit}"));
        }
    }
    for (rel, allowed) in allow {
        let budget = budget_for(rel);
        if *allowed <= budget {
            out.push(format!(
                "{rel}: 白名单值 {allowed} 必须大于预算 {budget}（冻结的是超标行数）"
            ));
            continue;
        }
        if let Some(text) = sources.get(rel) {
            let lines = count_lines(text);
            if lines <= budget {
                out.push(format!(
                    "{rel}: 白名单条目已陈旧（{lines} <= 预算 {budget}，允许 {allowed}）——请删除该条目"
                ));
            }
        }
    }
    out
}

/// 白名单指向的文件已不存在（改名/删除后必须删条目）。
fn dead_entries(
    sources: &BTreeMap<String, String>,
    allow: &BTreeMap<String, usize>,
) -> Vec<String> {
    allow
        .keys()
        .filter(|rel| !sources.contains_key(*rel))
        .cloned()
        .collect()
}

/// 失败信息排序后输出，便于和上次失败比对（新增/消失的条目一眼可见）。
fn report(mut violations: Vec<String>) -> String {
    violations.sort();
    violations.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成源文件：`lines` 行，每行一个字符。
    fn sources(entries: &[(&str, usize)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(rel, lines)| ((*rel).to_string(), "x\n".repeat(*lines)))
            .collect()
    }

    fn allow(entries: &[(&str, usize)]) -> BTreeMap<String, usize> {
        entries
            .iter()
            .map(|(rel, lines)| ((*rel).to_string(), *lines))
            .collect()
    }

    #[test]
    fn empty_input_passes() {
        assert!(line_violations(&BTreeMap::new(), &BTreeMap::new()).is_empty());
        assert!(dead_entries(&BTreeMap::new(), &BTreeMap::new()).is_empty());
    }

    #[test]
    fn source_budget_is_enforced() {
        assert!(line_violations(&sources(&[("ok.rs", MAX_SOURCE_LINES)]), &allow(&[])).is_empty());

        let violations =
            line_violations(&sources(&[("big.rs", MAX_SOURCE_LINES + 1)]), &allow(&[]));
        assert_eq!(violations, vec!["big.rs: 601 > 600".to_string()]);
    }

    #[test]
    fn test_budget_is_enforced() {
        for rel in ["rdp/tests.rs", "foo_tests.rs", "test.rs", "test_support.rs"] {
            assert!(
                line_violations(&sources(&[(rel, MAX_TEST_LINES)]), &allow(&[])).is_empty(),
                "{rel} 应适用测试预算"
            );
            let violations = line_violations(&sources(&[(rel, MAX_TEST_LINES + 1)]), &allow(&[]));
            assert_eq!(violations, vec![format!("{rel}: 1201 > 1200")]);
        }
    }

    #[test]
    fn allowlist_entry_covering_current_size_passes() {
        assert!(
            line_violations(&sources(&[("big.rs", 700)]), &allow(&[("big.rs", 700)])).is_empty()
        );
    }

    #[test]
    fn stale_allowlist_entry_is_detected() {
        // 曾经 800 行、现在降到预算内：条目必须删除。
        let violations = line_violations(
            &sources(&[("was_big.rs", MAX_SOURCE_LINES)]),
            &allow(&[("was_big.rs", 800)]),
        );
        assert_eq!(violations.len(), 1);
        assert!(violations[0].contains("陈旧"), "{violations:?}");

        // 仍在预算外（只是变短）不算陈旧，不误报。
        assert!(
            line_violations(&sources(&[("big.rs", 650)]), &allow(&[("big.rs", 800)])).is_empty()
        );
    }

    #[test]
    fn dead_allowlist_entry_is_detected() {
        let dead = dead_entries(&sources(&[("other.rs", 1)]), &allow(&[("gone.rs", 900)]));
        assert_eq!(dead, vec!["gone.rs".to_string()]);
    }

    #[test]
    fn invalid_allowlist_value_is_detected() {
        let violations = line_violations(&sources(&[("x.rs", 550)]), &allow(&[("x.rs", 500)]));
        assert!(
            violations.iter().any(|v| v.contains("必须大于预算")),
            "{violations:?}"
        );
    }

    #[test]
    fn real_tree_is_not_vacuous() {
        let sources = load_sources();
        assert!(sources.len() >= 60, "只扫到 {} 个文件", sources.len());
        assert!(sources.contains_key("main.rs"));
        assert!(sources.contains_key("ssh.rs"));
        assert!(sources.contains_key("rdp/tests.rs"));
    }

    #[test]
    fn real_tree_stays_within_budgets() {
        let sources = load_sources();
        let violations = line_violations(&sources, &allowlist());
        assert!(
            violations.is_empty(),
            "文件体积预算被突破（超预算行数或陈旧条目）：\n{}",
            report(violations)
        );
    }

    #[test]
    fn real_allowlist_is_alive() {
        let sources = load_sources();
        let dead = dead_entries(&sources, &allowlist());
        assert!(
            dead.is_empty(),
            "白名单条目已失效（文件被删/改名），请删除：\n{}",
            report(dead)
        );
    }
}
