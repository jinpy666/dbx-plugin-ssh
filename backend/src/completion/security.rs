//! `completion/execute` 的安全校验、参数收紧与远端命令拼装。
//!
//! 错误串统一 `completion:` 前缀（契约 §4.5：sidecar 字符串 Err 惯例加
//! 前缀分类）。远端拼装必须走既有 [`crate::exec::shell_quote`]，逐参数
//! 单引号转义，args 是唯一可能携带用户输入的面。

use crate::completion::protocol::CompletionExecuteRequest;

/// completion 层超时下限（毫秒）。
pub const MIN_TIMEOUT_MS: u64 = 200;
/// completion 层超时上限（毫秒）。
pub const MAX_TIMEOUT_MS: u64 = 3000;
/// 缺省超时（毫秒）。
pub const DEFAULT_TIMEOUT_MS: u64 = 1200;
/// 单流（stdout / stderr 各自）输出上限。
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// args 数量上限。
pub const MAX_ARGS: usize = 32;

/// generator 执行的唯一合法 mode（防止普通 RPC 复用本方法）。
pub const ALLOWED_MODE: &str = "completion-generator";

/// 校验并就地收紧请求：
///
/// - `mode` 必须是 `"completion-generator"`；
/// - `command` 非空且不含 NUL（command 是插件侧 spec 数据给出的程序名，
///   按细则原文保持原样拼接；用户可输入面在 args，一律 shell_quote）；
/// - `args` 数 ≤ [`MAX_ARGS`] 且每个不含 NUL；`cwd`（如有）不含 NUL；
/// - `timeout_ms` 缺省（serde default 0）→ [`DEFAULT_TIMEOUT_MS`]，越界 →
///   clamp 到 [`MIN_TIMEOUT_MS`, `MAX_TIMEOUT_MS`]；
/// - `max_output_bytes` 缺省（0）或超过 [`MAX_OUTPUT_BYTES`] →
///   [`MAX_OUTPUT_BYTES`]。
pub fn validate_and_clamp(req: &mut CompletionExecuteRequest) -> Result<(), String> {
    if req.mode != ALLOWED_MODE {
        return Err("completion: mode not allowed".to_string());
    }
    if req.command.is_empty() || req.command.contains('\0') {
        return Err("completion: invalid command".to_string());
    }
    if req.args.len() > MAX_ARGS {
        return Err(format!("completion: too many args (max {MAX_ARGS})"));
    }
    if req.args.iter().any(|arg| arg.contains('\0')) {
        return Err("completion: invalid arg".to_string());
    }
    if req.cwd.as_deref().is_some_and(|cwd| cwd.contains('\0')) {
        return Err("completion: invalid cwd".to_string());
    }
    if req.timeout_ms == 0 {
        req.timeout_ms = DEFAULT_TIMEOUT_MS;
    }
    req.timeout_ms = req.timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if req.max_output_bytes == 0 || req.max_output_bytes > MAX_OUTPUT_BYTES {
        req.max_output_bytes = MAX_OUTPUT_BYTES;
    }
    Ok(())
}

/// 远端命令行拼装：`command` 原样 + 空格 + `args` 逐个
/// [`crate::exec::shell_quote`]（拒绝注入面）。远端由 `SshRuntime::exec`
/// 经 `exec` 通道直发该行，由远端默认 shell 解释。
pub fn build_remote_command_line(command: &str, args: &[String]) -> String {
    let mut line =
        String::with_capacity(command.len() + args.iter().map(|arg| arg.len() + 3).sum::<usize>());
    line.push_str(command);
    for arg in args {
        line.push(' ');
        line.push_str(&crate::exec::shell_quote(arg));
    }
    line
}

/// SSH 目标接受的 cwd：绝对 POSIX 路径。`~`、相对路径、Windows 盘符的展开
/// 规则由远端 Shell 决定，本轮不猜——明确定界而不是静默在错误目录执行。
pub fn validate_ssh_cwd(cwd: &str) -> Result<(), String> {
    if cwd.contains('\0') {
        return Err("completion: invalid cwd".to_string());
    }
    if !cwd.starts_with('/') {
        return Err("completion: cwd must be an absolute POSIX path".to_string());
    }
    Ok(())
}

/// 「切到 cwd 成功后才执行」的远端命令行：`cd` 走
/// [`crate::exec::shell_quote`] 按字面量转义（空格/单引号/中文原样保留），
/// `&&` 短路保证目录不可用时 generator 不执行；只抑制 `cd` 自身 stderr——
/// exec 通道是 stdout+stderr 合并流，路径报错文本否则会被当作候选。
pub fn build_command_line_in_cwd(command_line: &str, cwd: &str) -> String {
    format!(
        "cd {} 2>/dev/null && {}",
        crate::exec::shell_quote(cwd),
        command_line
    )
}

/// 按 `cap` 字节截断 UTF-8 文本（回退到字符边界），返回 `(截断后文本,
/// 是否截断)`。SSH 路径拿到的是 exec 合并流 String，上限在 completion
/// 层统一施加。
pub fn truncate_utf8(text: &str, cap: usize) -> (String, bool) {
    if text.len() <= cap {
        return (text.to_string(), false);
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(mode: &str, command: &str, args: &[&str]) -> CompletionExecuteRequest {
        serde_json::from_value(json!({
            "target": { "kind": "ssh", "sessionId": "s" },
            "command": command,
            "args": args,
            "timeoutMs": 1200,
            "maxOutputBytes": 4096,
            "mode": mode,
        }))
        .unwrap()
    }

    #[test]
    fn rejects_disallowed_mode() {
        let mut req = request("evil", "git", &[]);
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: mode not allowed".to_string())
        );
    }

    #[test]
    fn rejects_empty_and_nul_command() {
        let mut req = request("completion-generator", "", &[]);
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: invalid command".to_string())
        );
        let mut req = request("completion-generator", "git\0rm", &[]);
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: invalid command".to_string())
        );
    }

    #[test]
    fn rejects_too_many_args() {
        let args: Vec<String> = (0..33).map(|n| n.to_string()).collect();
        let mut req = serde_json::from_value(json!({
            "target": { "kind": "local", "sessionId": "w" },
            "command": "git",
            "args": args,
            "mode": "completion-generator",
        }))
        .unwrap();
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: too many args (max 32)".to_string())
        );
    }

    #[test]
    fn rejects_nul_in_args_and_cwd() {
        let mut req = request("completion-generator", "git", &["branch\0"]);
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: invalid arg".to_string())
        );
        let mut req = request("completion-generator", "git", &[]);
        req.cwd = Some("/tmp\0evil".to_string());
        assert_eq!(
            validate_and_clamp(&mut req),
            Err("completion: invalid cwd".to_string())
        );
    }

    #[test]
    fn clamps_timeout_ms() {
        let mut req = request("completion-generator", "git", &[]);
        req.timeout_ms = 0;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.timeout_ms, DEFAULT_TIMEOUT_MS);

        req.timeout_ms = 1;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.timeout_ms, MIN_TIMEOUT_MS);

        req.timeout_ms = 500_000;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.timeout_ms, MAX_TIMEOUT_MS);

        req.timeout_ms = 800;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.timeout_ms, 800);
    }

    #[test]
    fn clamps_max_output_bytes() {
        let mut req = request("completion-generator", "git", &[]);
        req.max_output_bytes = 0;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.max_output_bytes, MAX_OUTPUT_BYTES);

        req.max_output_bytes = MAX_OUTPUT_BYTES + 1;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.max_output_bytes, MAX_OUTPUT_BYTES);

        req.max_output_bytes = 1024;
        validate_and_clamp(&mut req).unwrap();
        assert_eq!(req.max_output_bytes, 1024);
    }

    #[test]
    fn builds_bare_command_without_args() {
        assert_eq!(build_remote_command_line("git", &[]), "git");
    }

    #[test]
    fn quotes_every_arg() {
        let args: Vec<String> = ["branch", "--list", "a b"]
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            build_remote_command_line("git", &args),
            "git 'branch' '--list' 'a b'"
        );
    }

    #[test]
    fn quotes_embedded_single_quotes_like_shell_quote() {
        // exec::shell_quote 用 '\'' 转义内嵌单引号（仓库既有约定）。
        let args = vec!["a b'c".to_string()];
        assert_eq!(
            build_remote_command_line("printf", &args),
            "printf 'a b'\\''c'"
        );
    }

    #[test]
    fn quotes_unicode_args_verbatim() {
        let args = vec!["分支-ž".to_string()];
        assert_eq!(build_remote_command_line("echo", &args), "echo '分支-ž'");
    }

    #[test]
    fn truncate_utf8_passthrough_and_boundary() {
        assert_eq!(truncate_utf8("abc", 10), ("abc".to_string(), false));
        assert_eq!(truncate_utf8("abcdef", 3), ("abc".to_string(), true));
        // 截断点落在多字节字符中间时回退到字符边界，不产生非法 UTF-8。
        let (cut, truncated) = truncate_utf8("aéz", 2);
        assert_eq!(cut, "a");
        assert!(truncated);
        let (cut, _) = truncate_utf8("éz", 1);
        assert_eq!(cut, "");
    }

    #[test]
    fn ssh_cwd_accepts_only_absolute_posix_paths() {
        const NOT_ABSOLUTE: &str = "completion: cwd must be an absolute POSIX path";
        assert_eq!(validate_ssh_cwd("/home/me/src"), Ok(()));
        assert_eq!(validate_ssh_cwd("/"), Ok(()));
        assert_eq!(validate_ssh_cwd("src").unwrap_err(), NOT_ABSOLUTE);
        assert_eq!(validate_ssh_cwd("./src").unwrap_err(), NOT_ABSOLUTE);
        assert_eq!(validate_ssh_cwd("~/src").unwrap_err(), NOT_ABSOLUTE);
        assert_eq!(validate_ssh_cwd("C:\\work").unwrap_err(), NOT_ABSOLUTE);
        assert_eq!(
            validate_ssh_cwd("/tmp/a\0b").unwrap_err(),
            "completion: invalid cwd"
        );
    }

    #[test]
    fn cwd_prefix_quotes_path_and_short_circuits_on_failure() {
        let line = build_command_line_in_cwd("git 'branch' '--list'", "/home/me/src");
        assert_eq!(
            line,
            "cd '/home/me/src' 2>/dev/null && git 'branch' '--list'"
        );
        // 只抑制 cd 自身的 stderr：命令本身可诊断。
        assert!(line.contains("2>/dev/null && "));
    }

    #[test]
    fn cwd_prefix_keeps_spaces_quotes_and_unicode_verbatim() {
        let line = build_command_line_in_cwd("ls", "/tmp/a b'c/目录");
        assert_eq!(line, "cd '/tmp/a b'\\''c/目录' 2>/dev/null && ls");
    }
}
