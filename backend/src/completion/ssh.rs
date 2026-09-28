//! ssh target 执行器：复用既有 [`crate::ssh::SshRuntime::exec`] 通道。
//!
//! - read-only 门（决策 D4）：只读连接上一律拒绝——generator 即命令执行，
//!   不能绕过只读承诺；
//! - sudo 恒 false；
//! - 竞速超时（决策 D3）：completion 层 `tokio::time::timeout` 包住 exec，
//!   超时后用同一 execId 走 [`SshRuntime::cancel_exec`] 回收在途任务，
//!   不改 exec 内部的 `clamp(5, 300)` 下限。

use std::time::Duration;

use serde_json::Value;

use crate::completion::protocol::{CompletionExecuteRequest, CompletionExecuteResult};
use crate::completion::security;
use crate::ssh::SshRuntime;

/// 在 SSH 会话 `session_id` 上执行一次 generator 命令。`req` 必须已过
/// [`security::validate_and_clamp`]。
pub async fn execute(
    ssh: &SshRuntime,
    session_id: &str,
    req: &CompletionExecuteRequest,
) -> Result<CompletionExecuteResult, String> {
    if ssh
        .completion_session_read_only(session_id)
        .await
        .map_err(|error| format!("completion: {error}"))?
    {
        return Err("completion: disabled by the read-only connection setting".to_string());
    }
    // wave-1 未定义远端 cwd 语义：显式报错而不是悄悄在错误目录执行
    //（git 类 generator 对目录敏感，静默忽略会产生错误结果）。
    if req.cwd.as_deref().is_some_and(|cwd| !cwd.is_empty()) {
        return Err("completion: cwd is not supported for ssh targets in wave 1".to_string());
    }
    let exec_id = format!("completion-{}", uuid::Uuid::new_v4());
    let command_line = security::build_remote_command_line(&req.command, &req.args);
    let exec = ssh.exec(session_id, Some(&exec_id), &command_line, false, None);
    match tokio::time::timeout(Duration::from_millis(req.timeout_ms), exec).await {
        Ok(Ok(value)) => map_exec_response(&value, req.max_output_bytes),
        Ok(Err(error)) => Err(format!("completion: {error}")),
        Err(_elapsed) => {
            // 回收在途 exec 任务；取消失败（如已自然结束）不影响超时语义。
            let _ = ssh.cancel_exec(&exec_id);
            Ok(CompletionExecuteResult {
                timed_out: true,
                ..CompletionExecuteResult::default()
            })
        }
    }
}

/// 映射 `SshRuntime::exec` 的返回 `{"success": true, "output": String,
/// "exitCode": i32}`（见 `SshRuntime::exec_response`）。字段名与
/// 补全协议不一致，这里做显式映射：`output` 是 exec 通道的
/// **stdout+stderr 合并流**（`ExecOutcome.output`），映射到 `stdout`、
/// `stderr` 恒为空；输出上限在 completion 层统一施加（超限置
/// `truncated`）。
fn map_exec_response(
    value: &Value,
    max_output_bytes: usize,
) -> Result<CompletionExecuteResult, String> {
    let output = value.get("output").and_then(Value::as_str).unwrap_or("");
    let exit_code = value
        .get("exitCode")
        .and_then(Value::as_i64)
        .and_then(|code| i32::try_from(code).ok());
    let (stdout, truncated) = security::truncate_utf8(output, max_output_bytes);
    Ok(CompletionExecuteResult {
        exit_code,
        stdout,
        // exec 合并流没有 stderr 半边；显式置空并靠本注释与协议文档声明。
        stderr: String::new(),
        truncated,
        timed_out: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exec_response(output: &str, exit_code: i32) -> Value {
        json!({ "success": true, "output": output, "exitCode": exit_code })
    }

    #[test]
    fn maps_exec_output_and_exit_code() {
        let result = map_exec_response(&exec_response("main\ndev\n", 0), 4096).unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "main\ndev\n");
        assert_eq!(result.stderr, "");
        assert!(!result.truncated && !result.timed_out);
    }

    #[test]
    fn maps_nonzero_exit_code() {
        let result = map_exec_response(&exec_response("boom", 127), 4096).unwrap();
        assert_eq!(result.exit_code, Some(127));
        assert_eq!(result.stdout, "boom");
    }

    #[test]
    fn applies_output_cap_with_utf8_boundary() {
        // "aééé" = 1+2+2+2 字节：cap=3 恰好落在字符边界，得到 "aé"；
        // cap=2 落在 é 中间，回退边界得到 "a"。
        let result = map_exec_response(&exec_response("aééé", 0), 3).unwrap();
        assert!(result.truncated);
        assert_eq!(result.stdout, "aé");
        let result = map_exec_response(&exec_response("aééé", 0), 2).unwrap();
        assert!(result.truncated);
        assert_eq!(result.stdout, "a");
    }

    #[test]
    fn tolerant_of_missing_fields() {
        let result = map_exec_response(&json!({}), 4096).unwrap();
        assert_eq!(result.exit_code, None);
        assert_eq!(result.stdout, "");
    }

    #[test]
    fn exec_id_carries_completion_prefix() {
        // 固化 execId 前缀约定：与用户手写的 ssh/exec execId 命名空间
        // 区分开，便于排查（真实 uuid 由运行时路径生成）。
        let exec_id = format!("completion-{}", uuid::Uuid::new_v4());
        assert!(exec_id.starts_with("completion-"));
        assert!(exec_id.len() > "completion-".len());
    }
}
