//! `completion/execute` 的线协议 DTO。
//!
//! 冻结镜像是 `frontend/src/lib/completion/host/protocol.ts`（FIG wave-1
//! 契约 §3），两边字段必须逐字一致：请求/响应字段 camelCase，target 用
//! `kind` 标签（internally tagged，小写变体名）。serde round-trip 测试固化
//! 这一对应，改任一侧前先过协调者裁决。

use serde::{Deserialize, Serialize};

/// 补全 generator 的执行目标。`kind` 标签区分 local / ssh；`sessionId`
/// 在 local 侧标识发起补全的本地终端会话（wave-1 仅透传不使用），在 ssh
/// 侧是既有 SSH 会话 id。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CompletionTarget {
    #[serde(rename_all = "camelCase")]
    Local {
        /// 冻结线协议字段：wave-1 执行不读取（将来 environment / cwd
        /// 解析留位），故单独 allow dead_code。
        #[allow(dead_code)]
        session_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Ssh { session_id: String },
}

/// `completion/execute` 请求。`cwd` / `args` / `timeoutMs` /
/// `maxOutputBytes` 带 serde default，缺省时由
/// [`crate::completion::security::validate_and_clamp`] 补默认并收紧；
/// `mode` 必须显式给出且等于 `"completion-generator"`。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionExecuteRequest {
    pub target: CompletionTarget,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub max_output_bytes: usize,
    pub mode: String,
}

/// `completion/execute` 响应。`timedOut=true` 表示 completion 层竞速超时
/// （底层执行已尝试取消回收），此时 `exitCode=null`、输出为空。
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompletionExecuteResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_local_target_request() {
        let request: CompletionExecuteRequest = serde_json::from_value(json!({
            "target": { "kind": "local", "sessionId": "wb-local-1" },
            "command": "git",
            "args": ["branch", "--list"],
            "cwd": "/tmp/repo",
            "timeoutMs": 800,
            "maxOutputBytes": 4096,
            "mode": "completion-generator",
        }))
        .unwrap();
        assert!(matches!(
            &request.target,
            CompletionTarget::Local { session_id } if session_id == "wb-local-1"
        ));
        assert_eq!(request.command, "git");
        assert_eq!(request.args, ["branch", "--list"]);
        assert_eq!(request.cwd.as_deref(), Some("/tmp/repo"));
        assert_eq!(request.timeout_ms, 800);
        assert_eq!(request.max_output_bytes, 4096);
        assert_eq!(request.mode, "completion-generator");
    }

    #[test]
    fn deserializes_ssh_target_request() {
        let request: CompletionExecuteRequest = serde_json::from_value(json!({
            "target": { "kind": "ssh", "sessionId": "ssh-42" },
            "command": "kubectl",
            "args": [],
            "timeoutMs": 1200,
            "maxOutputBytes": 262144,
            "mode": "completion-generator",
        }))
        .unwrap();
        assert!(matches!(
            &request.target,
            CompletionTarget::Ssh { session_id } if session_id == "ssh-42"
        ));
        assert!(request.args.is_empty());
    }

    #[test]
    fn request_with_absent_optional_fields_parses() {
        // cwd/args/timeoutMs/maxOutputBytes 缺省也能解析（serde default），
        // 收紧语义交给 security::validate_and_clamp。
        let request: CompletionExecuteRequest = serde_json::from_value(json!({
            "target": { "kind": "local", "sessionId": "wb-1" },
            "command": "git",
            "mode": "completion-generator",
        }))
        .unwrap();
        assert_eq!(request.cwd, None);
        assert!(request.args.is_empty());
        assert_eq!(request.timeout_ms, 0);
        assert_eq!(request.max_output_bytes, 0);
    }

    #[test]
    fn unknown_target_kind_is_rejected() {
        let error = serde_json::from_value::<CompletionExecuteRequest>(json!({
            "target": { "kind": "wsl", "sessionId": "w-1" },
            "command": "git",
            "mode": "completion-generator",
        }))
        .unwrap_err();
        assert!(error.to_string().contains("wsl"), "{error}");
    }

    #[test]
    fn missing_mode_is_rejected_at_parse() {
        let error = serde_json::from_value::<CompletionExecuteRequest>(json!({
            "target": { "kind": "ssh", "sessionId": "s" },
            "command": "git",
        }))
        .unwrap_err();
        assert!(error.to_string().contains("mode"), "{error}");
    }

    #[test]
    fn serializes_result_with_camel_case_fields() {
        let result = CompletionExecuteResult {
            exit_code: None,
            stdout: "main\n".to_string(),
            stderr: String::new(),
            truncated: true,
            timed_out: true,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(
            value,
            json!({
                "exitCode": null,
                "stdout": "main\n",
                "stderr": "",
                "truncated": true,
                "timedOut": true,
            })
        );
    }
}
