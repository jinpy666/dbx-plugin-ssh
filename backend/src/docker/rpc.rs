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
use std::sync::Arc;

use dbx_plugin_sdk::PluginEmitter;
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

/// `docker/stats`（B2，只读）：一次 `stats --no-stream` 批量采样。
/// 容器 id 先逐项过门（`parse_container_ids`），远端命令是常量脚本体 +
/// 位置参数；daemon 权限失败时与 `docker/list` 同形回落 Quick Sudo，
/// 提权失败/白名单拒绝都退回原 payload（保留 `needsSudo` 提示）。
/// 速率差分在返回前统一应用一次，避免重试路径把缓存写两遍。
pub fn stats(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_ids = docker::parse_container_ids(params)?;
    let session_id = if target == docker::DockerTarget::Local {
        None
    } else {
        Some(required_string(params, "sessionId")?)
    };
    let cache_key = docker::stats_cache_key(target, &engine, session_id);
    let mut payload = match session_id {
        None => runtime.block_on(docker::collect_stats_local(&engine, &container_ids))?,
        Some(session_id) => remote_stats(ssh, runtime, &engine, &container_ids, session_id)?,
    };
    docker::apply_payload_rates(&cache_key, &mut payload);
    Ok(payload)
}

fn remote_stats(
    ssh: &SshRuntime,
    runtime: &Runtime,
    engine: &docker::EngineConfig,
    container_ids: &[String],
    session_id: &str,
) -> Result<Value, String> {
    let script = docker::stats_script(engine, container_ids)?;
    let response = runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::STATS_TIMEOUT.as_secs()),
    ))?;
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let payload = docker::stats_payload(&output);
    if payload["needsSudo"] != true {
        return Ok(payload);
    }
    // 与 list 同一回落：脚本体走 argv（密码只走 stdin），id 仍作
    // 位置参数；只读连接/白名单拒绝/提权失败都保留原 payload。
    let body = docker::stats_body(engine);
    let Ok(sudo_body) = runtime.block_on(ssh.ensure_sudo_allowed(session_id, &body)) else {
        return Ok(payload);
    };
    let Ok(sudo_script) = docker::stats_script_for_body(&sudo_body, container_ids) else {
        return Ok(payload);
    };
    if let Ok(sudo_response) = runtime.block_on(ssh.exec(
        session_id,
        None,
        &sudo_script,
        true,
        Some(docker::STATS_TIMEOUT.as_secs()),
    )) {
        let sudo_output = sudo_response
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sudo_payload = docker::stats_payload(sudo_output);
        if sudo_payload["available"] == true {
            return Ok(sudo_payload);
        }
    }
    Ok(payload)
}

// —— B4 容器文件（只读：list/read）——————————————————————

/// `docker/files/list`：列容器内一个目录（最多 500 条）。只读连接放行。
pub fn files_list(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?;
    docker::validate_container_id(container_id)?;
    let path = docker::normalize_container_path(required_string(params, "path")?)?;
    let show_hidden = docker::parse_show_hidden(params);
    if target == docker::DockerTarget::Local {
        return runtime.block_on(docker::collect_files_list_local(
            &engine,
            container_id,
            &path,
            show_hidden,
        ));
    }
    let session_id = required_string(params, "sessionId")?;
    let script = docker::files_list_script(&engine, container_id, &path, show_hidden)?;
    let response = runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::FILES_LIST_TIMEOUT.as_secs()),
    ))?;
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(code) = response.get("exitCode").and_then(Value::as_i64) {
        if code != 0 {
            return Err(format!(
                "docker/files/list failed (exit {code}): {}",
                docker::output_snippet(output)
            ));
        }
    }
    docker::files_list_payload(output, &path)
}

/// `docker/files/read`：读容器内一个普通文件（缺省 1 MiB，上限 8 MiB）。
/// 只读连接放行；不写文件，也不引入 sudo 提权面。
pub fn files_read(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?;
    docker::validate_container_id(container_id)?;
    let path = docker::normalize_container_path(required_string(params, "path")?)?;
    let max_bytes = docker::parse_max_bytes(params)?;
    if target == docker::DockerTarget::Local {
        return runtime.block_on(docker::collect_files_read_local(
            &engine,
            container_id,
            &path,
            max_bytes,
        ));
    }
    let session_id = required_string(params, "sessionId")?;
    let script = docker::files_read_script(&engine, container_id, &path, max_bytes)?;
    let response = runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::FILES_READ_TIMEOUT.as_secs()),
    ))?;
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(code) = response.get("exitCode").and_then(Value::as_i64) {
        if code != 0 {
            return Err(format!(
                "docker/files/read failed (exit {code}): {}",
                docker::output_snippet(output)
            ));
        }
    }
    docker::files_read_payload(output, &path, max_bytes)
}

// —— B6 容器文件写/删（破坏性）：先审计意图，再执行 ————————————

/// `docker/files/write`：base64 解码后 ≤64 KiB，同目录临时文件 + `mv`
/// 原子覆盖；只读连接拒绝（§5.4），审计行只含路径与字节数（§5.8）。
pub fn files_write(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?;
    docker::validate_container_id(container_id)?;
    let path = docker::validate_mutation_path(required_string(params, "path")?)?;
    let (data_base64, bytes) = docker::parse_write_data(params)?;
    let overwrite = docker::parse_overwrite(params)?;
    let temp_path = docker::write_temp_path(&path)?;
    let command = docker::files_write_command(&engine, container_id, &path, bytes);
    if target == docker::DockerTarget::Local {
        audit_action_intent(&ssh.data_dir(), &command);
        let started = std::time::Instant::now();
        return match runtime.block_on(docker::collect_files_write_local(
            &engine,
            container_id,
            &path,
            &data_base64,
            overwrite,
            &temp_path,
        )) {
            Ok(payload) => Ok(payload),
            Err(error) => {
                audit_action_failure(
                    &ssh.data_dir(),
                    &command,
                    &error,
                    started.elapsed().as_millis() as u64,
                );
                Err(error)
            }
        };
    }
    let session_id = required_string(params, "sessionId")?;
    // 只读连接直接拒绝：写容器内文件是破坏性动作。与 `ensure_writable`
    // 同查询同文案，但把判定收敛到可离线单测的 `docker::mutation_access`。
    let read_only = runtime.block_on(ssh.session_read_only(session_id))?;
    docker::mutation_access(read_only)?;
    let script = docker::files_write_script(
        &engine,
        container_id,
        &path,
        &data_base64,
        overwrite,
        &temp_path,
    )?;
    audit_action_intent(&ssh.data_dir(), &command);
    let started = std::time::Instant::now();
    let response = match runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::FILES_WRITE_TIMEOUT.as_secs()),
    )) {
        Ok(response) => response,
        Err(error) => {
            audit_action_failure(
                &ssh.data_dir(),
                &command,
                &error,
                started.elapsed().as_millis() as u64,
            );
            return Err(error);
        }
    };
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let failure = response
        .get("exitCode")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
        .map(|code| {
            format!(
                "docker/files/write failed (exit {code}): {}",
                docker::output_snippet(output)
            )
        });
    let result = match failure {
        Some(error) => Err(error),
        None => docker::files_write_payload(output, &path),
    };
    if let Err(error) = &result {
        audit_action_failure(
            &ssh.data_dir(),
            &command,
            error,
            started.elapsed().as_millis() as u64,
        );
    }
    result
}

/// `docker/files/delete`：非递归只删普通文件/链接，目录报错；递归拒绝
/// 容器根与 `/proc`、`/sys`、`/dev` 挂载点；本机删除要求 `confirm: true`。
pub fn files_delete(ssh: &SshRuntime, runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?;
    docker::validate_container_id(container_id)?;
    let recursive = docker::parse_recursive(params)?;
    let path = docker::validate_delete_path(required_string(params, "path")?, recursive)?;
    let command = docker::files_delete_command(&engine, container_id, &path);
    if target == docker::DockerTarget::Local {
        if !docker::parse_confirm(params)? {
            return Err("docker/files/delete on the local host requires confirm: true".to_string());
        }
        audit_action_intent(&ssh.data_dir(), &command);
        let started = std::time::Instant::now();
        return match runtime.block_on(docker::collect_files_delete_local(
            &engine,
            container_id,
            &path,
            recursive,
        )) {
            Ok(payload) => Ok(payload),
            Err(error) => {
                audit_action_failure(
                    &ssh.data_dir(),
                    &command,
                    &error,
                    started.elapsed().as_millis() as u64,
                );
                Err(error)
            }
        };
    }
    let session_id = required_string(params, "sessionId")?;
    // 只读连接直接拒绝：删除容器内文件是破坏性动作（同 `ensure_writable`）。
    let read_only = runtime.block_on(ssh.session_read_only(session_id))?;
    docker::mutation_access(read_only)?;
    let script = docker::files_delete_script(&engine, container_id, &path, recursive)?;
    audit_action_intent(&ssh.data_dir(), &command);
    let started = std::time::Instant::now();
    let response = match runtime.block_on(ssh.exec(
        session_id,
        None,
        &script,
        false,
        Some(docker::FILES_DELETE_TIMEOUT.as_secs()),
    )) {
        Ok(response) => response,
        Err(error) => {
            audit_action_failure(
                &ssh.data_dir(),
                &command,
                &error,
                started.elapsed().as_millis() as u64,
            );
            return Err(error);
        }
    };
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let failure = response
        .get("exitCode")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
        .map(|code| {
            format!(
                "docker/files/delete failed (exit {code}): {}",
                docker::output_snippet(output)
            )
        });
    let result = match failure {
        Some(error) => Err(error),
        None => docker::files_delete_payload(output, &path),
    };
    if let Err(error) = &result {
        audit_action_failure(
            &ssh.data_dir(),
            &command,
            error,
            started.elapsed().as_millis() as u64,
        );
    }
    result
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

/// `docker/logs/stream/start`（B3，只读）：固定脚本 + 位置参数启动
/// `docker logs -f`，注册后立即返回；输出走二进制通道
/// `docker/logs/out/{streamId}`，终态发 `docker/logs/end`。
///
/// 只读连接照 §5.4 放行（日志是只读采集），不再走 `ensure_writable`；
/// 也不走 Quick Sudo（提权只影响一次性采集，follow 流不新增密码注入面）。
pub fn logs_stream_start(
    ssh: &SshRuntime,
    runtime: &Runtime,
    registry: &docker::StreamRegistry,
    emitter: &PluginEmitter,
    params: &Value,
) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?.to_string();
    docker::validate_container_id(&container_id)?;
    let tail = docker::clamp_tail(optional_u64(params, "tail", docker::TAIL_DEFAULT));
    let timestamps = params
        .get("timestamps")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let requested_stream_id = params
        .get("requestedStreamId")
        .and_then(Value::as_str)
        .map(str::to_owned);

    let (connection_id, source) = match target {
        docker::DockerTarget::Local => {
            let program = docker::find_local_cli(&engine.cli).ok_or_else(|| {
                format!(
                    "Container CLI '{}' was not found on this machine",
                    engine.cli
                )
            })?;
            let args = docker::logs_stream_args(&container_id, tail, timestamps);
            (
                "local".to_string(),
                docker::StreamSource::Local {
                    program,
                    args,
                    endpoint: engine.endpoint.clone(),
                },
            )
        }
        docker::DockerTarget::Ssh => {
            let session_id = required_string(params, "sessionId")?;
            let connection_id = runtime
                .block_on(ssh.connection_id_for_session(session_id))
                .ok_or("SSH session was not found or expired")?;
            let handle = runtime
                .block_on(ssh.live_handle_for_connection(&connection_id))
                .ok_or_else(|| format!("no live SSH session for connection '{connection_id}'"))?;
            let script = docker::logs_stream_script(&engine, &container_id, tail, timestamps)?;
            (connection_id, docker::StreamSource::Ssh { handle, script })
        }
    };

    let sink: Arc<dyn docker::StreamSink> = Arc::new(emitter.clone());
    runtime.block_on(registry.start(
        docker::StreamRequest {
            connection_id,
            container_id,
            requested_stream_id,
            tail,
            timestamps,
            source,
        },
        sink,
    ))
}

/// `docker/logs/stream/stop`（B3）：幂等；未知 id 也返回成功。
pub fn logs_stream_stop(
    runtime: &Runtime,
    registry: &docker::StreamRegistry,
    params: &Value,
) -> Result<Value, String> {
    let stream_id = required_string(params, "streamId")?;
    runtime.block_on(registry.stop(stream_id))
}

/// `docker/terminal/open`（B5）：只读连接拒绝；`needsSudo` 无预热拒绝；
/// 审计意图行先落账；返回后输出走 `docker/terminal/out/{id}`。
///
/// `needsSudo` 由前端把 `docker/list` 的只读探针结果带过来（不是授权依据，
/// 只是省一次往返的提示）；真正的授权判定仍在 sidecar：只读门 + sudo 预热
/// 注册表 + 固定脚本/位置参数。
pub fn terminal_open(
    ssh: &SshRuntime,
    runtime: &Runtime,
    emitter: &PluginEmitter,
    params: &Value,
) -> Result<Value, String> {
    let engine = docker::parse_engine(params)?;
    let target = docker::parse_target(params)?;
    let container_id = required_string(params, "containerId")?.to_string();
    docker::validate_container_id(&container_id)?;
    let shell = docker::TerminalShell::parse(params.get("shell").and_then(Value::as_str))?;
    let cols = params.get("cols").and_then(Value::as_u64);
    let rows = params.get("rows").and_then(Value::as_u64);
    let (cols, rows) = docker::clamp_terminal_size(cols, rows);
    let requested_terminal_id = params
        .get("requestedTerminalId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let after_sequence = optional_u64(params, "afterSequence", 0);
    let needs_sudo = params
        .get("needsSudo")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (connection_id, source) = match target {
        docker::DockerTarget::Local => {
            // 本机没有「只读连接」语义，但也不注入 sudo 密码：容器 CLI 权限
            // 不足时直接给出可读提示（用户可自行把账号加入 docker 组）。
            docker::terminal_access(false, needs_sudo, false)?;
            let program = docker::find_local_cli(&engine.cli).ok_or_else(|| {
                format!(
                    "Container CLI '{}' was not found on this machine",
                    engine.cli
                )
            })?;
            (
                "local".to_string(),
                docker::TerminalSource::Local {
                    program,
                    args: docker::terminal_local_args(&container_id, shell),
                    endpoint: engine.endpoint.clone(),
                },
            )
        }
        docker::DockerTarget::Ssh => {
            let session_id = required_string(params, "sessionId")?;
            // 只读连接直接拒绝（容器终端可写容器内文件、可改状态）。
            runtime.block_on(ssh.ensure_writable(session_id))?;
            let connection_id = runtime
                .block_on(ssh.connection_id_for_session(session_id))
                .ok_or("SSH session was not found or expired")?;
            let warm = ssh.has_warm_sudo(&connection_id);
            let plan = docker::terminal_access(false, needs_sudo, warm)?;
            let handle = runtime
                .block_on(ssh.live_handle_for_connection(&connection_id))
                .ok_or_else(|| format!("no live SSH session for connection '{connection_id}'"))?;
            let command = docker::terminal_ssh_command(
                &engine,
                &container_id,
                shell,
                plan == docker::SudoPlan::NonInteractive,
            );
            (
                connection_id,
                docker::TerminalSource::Ssh { handle, command },
            )
        }
    };

    // 授权/引擎校验通过后、真正建 PTY 前写审计意图行；命令文本不含键入字节。
    audit_action_intent(
        &ssh.data_dir(),
        &docker::terminal_audit_command(&engine, &container_id, shell),
    );
    let sink: Arc<dyn docker::StreamSink> = Arc::new(emitter.clone());
    runtime.block_on(docker::TerminalRegistry::global().open(
        docker::TerminalOpenRequest {
            connection_id,
            container_id,
            shell,
            cols,
            rows,
            requested_terminal_id,
            after_sequence,
            source,
        },
        sink,
    ))
}

/// `docker/terminal/close`：幂等；先 `end` 再拆，未知 id 返回 success。
pub fn terminal_close(
    runtime: &Runtime,
    emitter: &PluginEmitter,
    params: &Value,
) -> Result<Value, String> {
    let terminal_id = required_string(params, "terminalId")?;
    let sink: Arc<dyn docker::StreamSink> = Arc::new(emitter.clone());
    runtime.block_on(docker::TerminalRegistry::global().close(terminal_id, sink.as_ref()))
}

/// `docker/terminal/resize`：会话内 resize（cols/rows 同 open 钳制）。
pub fn terminal_resize(runtime: &Runtime, params: &Value) -> Result<Value, String> {
    let terminal_id = required_string(params, "terminalId")?;
    let cols = params.get("cols").and_then(Value::as_u64);
    let rows = params.get("rows").and_then(Value::as_u64);
    let (cols, rows) = docker::clamp_terminal_size(cols, rows);
    runtime.block_on(docker::TerminalRegistry::global().resize(terminal_id, cols, rows))?;
    Ok(json!({ "success": true }))
}

/// `docker/terminal/replay`：与 `serial/replay` 同构，帧直接补发到输出通道。
pub fn terminal_replay(emitter: &PluginEmitter, params: &Value) -> Result<Value, String> {
    let terminal_id = required_string(params, "terminalId")?;
    let after_sequence = optional_u64(params, "afterSequence", 0);
    let sink: Arc<dyn docker::StreamSink> = Arc::new(emitter.clone());
    docker::TerminalRegistry::global().replay(terminal_id, after_sequence, sink.as_ref())
}
