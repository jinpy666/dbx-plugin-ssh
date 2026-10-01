//! `completion/execute` 的统一分派入口（供 `main.rs` 路由臂调用）。
//!
//! 按 [`crate::completion::protocol::CompletionTarget::kind`] 分派：local
//! 走短生命周期子进程，ssh 复用 `SshRuntime::exec`。错误统一
//! `Result<_, String>`（sidecar 字符串 Err 惯例，`completion:` 前缀）。

use crate::completion::local;
use crate::completion::protocol::{
    CompletionExecuteRequest, CompletionExecuteResult, CompletionTarget,
};
use crate::completion::ssh;
use crate::ssh::SshRuntime;

/// 执行一个已通过
/// [`crate::completion::security::validate_and_clamp`] 的请求。`runtime`
/// 仅在 ssh target 下使用（local 分支不触碰任何连接状态）。
pub async fn dispatch(
    runtime: &SshRuntime,
    req: &CompletionExecuteRequest,
) -> Result<CompletionExecuteResult, String> {
    match &req.target {
        // local 的 session_id 在 wave-1 仅标识发起方（为将来 environment/
        // cwd 解析留位），不参与执行。
        CompletionTarget::Local { .. } => {
            local::execute(
                &req.command,
                &req.args,
                req.cwd.as_deref(),
                req.timeout_ms,
                req.max_output_bytes,
            )
            .await
        }
        CompletionTarget::Ssh { session_id } => ssh::execute(runtime, session_id, req).await,
    }
}

#[cfg(test)]
mod tests {
    // 用例与助手均限 unix（local 目标分派的端到端断言依赖 POSIX printf）；
    // Windows 的 test target 里保持空模块，避免 unused/dead-code 撞 -D warnings。
    #[cfg(unix)]
    use super::*;
    #[cfg(unix)]
    use serde_json::json;

    // 唯一调用方是下方 #[cfg(unix)] 用例；Windows 的 test target 里是死代码，
    // 会撞 -D warnings（CI 的 clippy 门禁跑在 Linux runner）。
    #[cfg(unix)]
    fn local_request(command: &str, args: &[&str]) -> CompletionExecuteRequest {
        let mut req: CompletionExecuteRequest = serde_json::from_value(json!({
            "target": { "kind": "local", "sessionId": "wb-1" },
            "command": command,
            "args": args,
            "mode": "completion-generator",
        }))
        .unwrap();
        crate::completion::security::validate_and_clamp(&mut req).unwrap();
        req
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dispatches_local_target_end_to_end() {
        // SshRuntime::new 只建目录不联网；local 分支不触碰它。
        let dir = tempfile::tempdir().unwrap();
        let runtime = SshRuntime::new(dir.path().to_path_buf());
        let result = dispatch(&runtime, &local_request("printf", &["dispatched"]))
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "dispatched");
        assert!(!result.timed_out);
    }
}
