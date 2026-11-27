//! `docker/list` / `docker/logs` / `docker/action` 的分派体。B1 把这三段
//! 从 `main.rs` 原样搬到这里；`main.rs` 只保留字面量方法名 + 一行委托
//! （`scripts/mock_host_registry_check.mjs` 按字面量扫描后端全集）。
//!
//! Docker 管理面板（IMPL_PLAN Task P2-4）。列表/日志是只读采集
//! 脚本（探针区分「未装容器 CLI」与「daemon socket 拒绝」）；动作
//! 走白名单动词 + 容器 id 严格校验 + 只读连接直接拒绝 + 执行前
//! 审计，plain 失败且命中 daemon 权限签名时才回落 Quick Sudo
//! 管线（密码只走 stdin，绝不拼进命令行）。
//! `target: "local"` 切换到 sidecar 所在本机 daemon（Docker
//! Desktop/OrbStack/无 SSH 会话场景）：无需 sessionId，动作仍过
//! 审计与同一套白名单/id 门。可选 cli/socket/host 参数切换引擎
//! 与 daemon 端点（Podman / 自定义 socket / tcp host）。
//!
//! 以下代码与搬移前的分派臂逐行一致，只把 `self.ssh` / `self.runtime`
//! 换成参数（`ssh` / `runtime`）。

use std::path::Path;

use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::audit_log;
use crate::docker;
use crate::ssh::SshRuntime;
use crate::{optional_u64, required_string};

pub fn list(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    if docker::parse_target(params)? == docker::DockerTarget::Local {
        return runtime.block_on(docker::collect_list_local(&engine));
    }
    let session_id = required_string(params, "sessionId")?;
    let response = runtime.block_on(ssh.exec(
        session_id,
        None,
        &docker::list_script(&engine),
        false,
        Some(docker::LIST_TIMEOUT.as_secs()),
    ))?;
    let mut output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Windows OpenSSH 默认 shell 没有 sh，heredoc 输不出任何
    // 探针标记：多花一个往返用 cmd 版采集器重试。
    if docker::needs_windows_fallback(&output) {
        if let Ok(win_response) = runtime.block_on(ssh.exec(
            session_id,
            None,
            &docker::win_list_script(&engine),
            false,
            Some(docker::LIST_TIMEOUT.as_secs()),
        )) {
            let win_output = win_response
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !docker::needs_windows_fallback(win_output) {
                output = win_output.to_string();
            }
        }
    }
    let payload = docker::list_payload(&output);
    if payload["needsSudo"] != true {
        return Ok(payload);
    }
    // found-but-denied 且本连接配置了 Quick Sudo：用同一管线
    // （sudo -S sh -c '<body>'，密码走 stdin、脚本体走 argv）
    // 提权重采。只读连接/白名单拒绝/提权失败都退回原 payload，
    // 保留 needsSudo 提示而不是让只读调用报错。
    let body = docker::list_body(&engine);
    let sudo_body = match runtime.block_on(ssh.ensure_sudo_allowed(session_id, &body)) {
        Ok(rebuilt) => rebuilt,
        Err(_) => return Ok(payload),
    };
    if let Ok(sudo_response) = runtime.block_on(ssh.exec(
        session_id,
        None,
        &sudo_body,
        true,
        Some(docker::LIST_TIMEOUT.as_secs()),
    )) {
        let sudo_output = sudo_response
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sudo_payload = docker::list_payload(sudo_output);
        if sudo_payload["available"] == true {
            return Ok(sudo_payload);
        }
    }
    Ok(payload)
}

pub fn logs(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let container_id = required_string(params, "containerId")?;
    let tail = optional_u64(params, "tail", docker::TAIL_DEFAULT);
    let engine = docker::parse_engine(params)?;
    if docker::parse_target(params)? == docker::DockerTarget::Local {
        return runtime.block_on(docker::collect_logs_local(&engine, container_id, tail));
    }
    let session_id = required_string(params, "sessionId")?;
    let script = docker::logs_script(&engine, container_id, tail)?;
    let response = runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::LOGS_TIMEOUT.as_secs()),
    ))?;
    let mut output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // Windows 兜底：heredoc 报废时把 inspect/logs 两步拆成裸
    // 命令直跑（cmd 可执行），本地拼回标记文本复用同一解析；
    // 端点经 cmd set 前缀带过（charset 白名单保证 cmd 惰性）。
    if docker::needs_windows_fallback(&output) {
        let tail_clamped = docker::clamp_tail(tail).to_string();
        let inspect = runtime.block_on(ssh.exec(
            session_id,
            None,
            &format!(
                "{}{} inspect {container_id}",
                engine.cmd_env_prefix(),
                engine.cli
            ),
            false,
            Some(docker::LOGS_TIMEOUT.as_secs()),
        ));
        let logs = runtime.block_on(ssh.exec(
            session_id,
            None,
            &format!(
                "{}{} logs --tail {tail_clamped} {container_id}",
                engine.cmd_env_prefix(),
                engine.cli
            ),
            false,
            Some(docker::LOGS_TIMEOUT.as_secs()),
        ));
        if let (Ok(inspect), Ok(logs)) = (inspect, logs) {
            output = format!(
                "DBXDOCKER_INSPECT\n{}\nDBXDOCKER_LOGS\n{}",
                inspect
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                logs.get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
        }
    }
    // daemon socket 权限签名（logs 段 2>&1 合并了错误）→ Quick
    // Sudo 提权重采；任何失败都退回原输出，payload 恒良构。
    if docker::is_daemon_permission_failure(1, &output) {
        let body = docker::sudo_logs_body(&engine, container_id, tail)?;
        if let Ok(sudo_body) = runtime.block_on(ssh.ensure_sudo_allowed(session_id, &body)) {
            if let Ok(sudo_response) = runtime.block_on(ssh.exec(
                session_id,
                None,
                &sudo_body,
                true,
                Some(docker::LOGS_TIMEOUT.as_secs()),
            )) {
                let sudo_output = sudo_response
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if sudo_output.contains("DBXDOCKER_LOGS") {
                    return Ok(docker::logs_payload(sudo_output));
                }
            }
        }
    }
    Ok(docker::logs_payload(&output))
}

pub fn action(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let container_id = required_string(params, "containerId")?;
    docker::validate_container_id(container_id)?;
    let action = docker::parse_action(required_string(params, "action")?)?;
    let engine = docker::parse_engine(params)?;
    if docker::parse_target(params)? == docker::DockerTarget::Local {
        // 本机动作同样先审计再执行；本机没有只读连接语义，
        // 破坏性确认由前端/MCP 确认门承担。
        audit_action_intent(
            &ssh.data_dir(),
            &docker::action_command(&engine, action, container_id),
        );
        let started = std::time::Instant::now();
        return match runtime.block_on(docker::perform_action_local(&engine, container_id, action)) {
            Ok(payload) => Ok(payload),
            Err(error) => {
                audit_action_failure(
                    &ssh.data_dir(),
                    &docker::action_command(&engine, action, container_id),
                    &error,
                    started.elapsed().as_millis() as u64,
                );
                Err(error)
            }
        };
    }
    let session_id = required_string(params, "sessionId")?;
    // 只读连接直接拒绝：动作会改变远端容器状态。
    runtime.block_on(ssh.ensure_writable(session_id))?;
    // 审计/展示文本用短形态（cli 动词 id）；实际执行命令额外
    // 带端点 export 前缀（POSIX），sudo 回落重放同一条文本。
    let command = docker::action_command(&engine, action, container_id);
    let exec_text = docker::exec_command(&engine, action, container_id);
    // 执行前写审计（意图行）：即使 sidecar 中途退出，账本上也留
    // 有一条记录；失败时补一行带错误详情的失败行。
    audit_action_intent(&ssh.data_dir(), &command);
    let started = std::time::Instant::now();
    let plain = runtime.block_on(ssh.exec(
        session_id,
        None,
        &exec_text,
        false,
        Some(docker::ACTION_TIMEOUT.as_secs()),
    ))?;
    let exit_code = plain.get("exitCode").and_then(Value::as_i64).unwrap_or(-1) as i32;
    let output = plain
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if exit_code == 0 {
        return Ok(json!({ "success": true, "output": output }));
    }
    let failure = |error: String| {
        audit_action_failure(
            &ssh.data_dir(),
            &command,
            &error,
            started.elapsed().as_millis() as u64,
        );
        error
    };
    if docker::is_daemon_permission_failure(exit_code, &output) {
        // daemon socket 权限失败是唯一允许回落 sudo 的失败形态：
        // 其余失败重试可能把半执行的动作应用两次。回落走与
        // ssh/exec 同一条 Quick Sudo 管线（编排凭据、use_pty、
        // keepalive 全部复用），连接级 sudoers 白名单同语义生效，
        // 白名单放行时以重建后的 token 命令提权重跑。
        let sudo_exec = runtime.block_on(ssh.ensure_sudo_allowed(session_id, &exec_text))?;
        return match runtime.block_on(ssh.exec(
            session_id,
            None,
            &sudo_exec,
            true,
            Some(docker::ACTION_TIMEOUT.as_secs()),
        )) {
            Ok(sudo_response) => {
                let sudo_output = sudo_response
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(json!({ "success": true, "output": sudo_output }))
            }
            Err(error) => Err(failure(docker::sudo_fallback_error(error))),
        };
    }
    Err(failure(format!(
        "{} {} failed (exit {}): {}",
        engine.cli,
        action.as_str(),
        exit_code,
        output
    )))
}

// —— Audit (workbench docker/action path) ——————————————————

fn audit_row(
    data_dir: &Path,
    command: &str,
    outcome: audit_log::EntryOutcome,
    error: Option<&str>,
    duration_ms: u64,
) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default();
    let entry = audit_log::AuditEntry {
        ts_ms,
        tool: "docker/action".to_string(),
        // The workbench path keys on sessionId; the connection column stays
        // empty exactly like MCP rows without a connectionId argument.
        connection_id: String::new(),
        gate: audit_log::GateOutcome::Pass,
        approval: audit_log::ApprovalTrail::None,
        outcome,
        exit_code: None,
        duration_ms,
        mode: audit_log::ExecMode::Stdio,
        command: Some(command.to_string()),
        output: None,
        error: error.map(|error| error.chars().take(256).collect()),
    };
    if let Err(error) = audit_log::append(data_dir, &entry) {
        eprintln!("[docker] audit append failed: {error}");
    }
}

/// Mandatory pre-execution audit row: the intent is on the ledger even if
/// the sidecar dies between the audit write and the remote run.
pub fn audit_action_intent(data_dir: &Path, command: &str) {
    audit_row(data_dir, command, audit_log::EntryOutcome::Ok, None, 0);
}

/// Post-execution failure row (success is already covered by the intent
/// row; only failures add a second entry carrying the error text).
pub fn audit_action_failure(data_dir: &Path, command: &str, error: &str, duration_ms: u64) {
    audit_row(
        data_dir,
        command,
        audit_log::EntryOutcome::Error,
        Some(error),
        duration_ms,
    );
}
