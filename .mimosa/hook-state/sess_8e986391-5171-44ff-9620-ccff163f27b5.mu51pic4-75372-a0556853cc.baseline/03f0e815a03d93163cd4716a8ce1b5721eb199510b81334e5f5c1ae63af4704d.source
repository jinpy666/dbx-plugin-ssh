mod agent_approvals;
mod agent_terminal;
mod alert_triage;
mod app_bridge;
mod audit_log;
mod exec;
mod highlight_rules;
mod host_key;
mod keys;
mod local_downloads;
mod mcp;
mod mcp_safety;
mod metrics;
mod metrics_history;
mod model;
mod multi_exec;
mod quick_commands;
mod session_recording;
mod sftp_bookmarks;
mod sftp_copy;
mod sftp_ext;
mod ssh;
mod ssh_algorithms;
mod sudo_allowlist;
mod sudo_fs;
mod sudo_profiles;
mod transfer_history;
mod triggers;
mod vault;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use dbx_plugin_sdk::{
    PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, PluginTransport,
    RequestContext,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::model::{path_from_sftp_uri, SessionOpenRequest, StoredConnection, MAX_TRANSFER_SIZE};
use crate::ssh::{connection_id_param, filesystem_path, PromptDecision, SshRuntime};

struct Plugin {
    runtime: Runtime,
    ssh: Arc<SshRuntime>,
    mcp: Arc<mcp::McpState>,
}

impl Plugin {
    fn new() -> Result<Self, String> {
        let data_dir = plugin_data_dir();
        let runtime =
            Runtime::new().map_err(|error| format!("Failed to create async runtime: {error}"))?;
        let ssh = Arc::new(SshRuntime::new(data_dir));
        Ok(Self {
            runtime,
            mcp: Arc::new(mcp::McpState::shared(ssh.clone())),
            ssh,
        })
    }

    fn handle_request(
        &self,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        match method {
            "triggers/validate" => {
                let raw = params.get("triggers");
                let format = trigger_input_format(raw);
                let secrets = params.get("secretSlots").and_then(Value::as_object);
                let parsed = triggers::parse_triggers(raw, &|key| {
                    secrets
                        .and_then(|values| values.get(key))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })?;
                Ok(json!({
                    "valid": true,
                    "enabled": parsed.is_some(),
                    "format": format,
                    "stages": parsed.as_ref().map(|config| config.stages.len()).unwrap_or(0),
                }))
            }
            "connection/test" => {
                let connection = StoredConnection::from_lifecycle_params(&params)?;
                let operation_id = operation_id(&params);
                self.runtime.block_on(self.ssh.test_connection(
                    &connection,
                    &operation_id,
                    emitter.clone(),
                ))?;
                Ok(
                    json!({ "success": true, "message": "SSH handshake, host-key verification, and authentication succeeded" }),
                )
            }
            "connection/connect" => {
                let connection = StoredConnection::from_lifecycle_params(&params)?;
                self.ssh.store_connection(connection)?;
                Ok(json!({ "success": true }))
            }
            "connection/disconnect" => {
                let connection_id = params
                    .get("connection")
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str)
                    .ok_or("Missing connection id")?;
                self.runtime
                    .block_on(self.ssh.disconnect_connection(connection_id))?;
                Ok(json!({ "success": true }))
            }
            "ssh/session/open" => {
                let operation_id = operation_id(&params);
                let request: SessionOpenRequest = parse(params)?;
                self.runtime.block_on(self.ssh.open_session(
                    &request.connection_id,
                    &request.workbench_id,
                    request.cols,
                    request.rows,
                    &operation_id,
                    emitter.clone(),
                ))
            }
            "ssh/session/attach" => {
                let connection_id = required_string(&params, "connectionId")?;
                let workbench_id = required_string(&params, "workbenchId")?;
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                self.runtime.block_on(self.ssh.attach_session(
                    connection_id,
                    workbench_id,
                    after_sequence,
                    emitter,
                ))
            }
            "ssh/session/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.ssh.close_session(session_id))?;
                Ok(json!({ "success": true }))
            }
            "ssh/exec" => {
                let session_id = required_string(&params, "sessionId")?;
                let command = required_string(&params, "command")?;
                let sudo = params.get("sudo").and_then(Value::as_bool).unwrap_or(false);
                let timeout_secs = params.get("timeoutSecs").and_then(Value::as_u64);
                let exec_id = params.get("execId").and_then(Value::as_str);
                if sudo {
                    // Connection-level sudoers-style allowlist (mirrors the
                    // MCP gate); structured sudo_fs ops stay exempt.
                    self.runtime
                        .block_on(self.ssh.ensure_sudo_allowed(session_id, command))?;
                }
                self.runtime.block_on(self.ssh.exec(
                    session_id,
                    exec_id,
                    command,
                    sudo,
                    timeout_secs,
                ))
            }
            "ssh/exec/cancel" => {
                let exec_id = required_string(&params, "execId")?;
                self.ssh.cancel_exec(exec_id)?;
                Ok(json!({ "success": true }))
            }
            "ssh/terminal/resize" => {
                let session_id = required_string(&params, "sessionId")?;
                let cols = required_u32(&params, "cols")?;
                let rows = required_u32(&params, "rows")?;
                self.runtime
                    .block_on(self.ssh.resize_terminal(session_id, cols, rows))?;
                Ok(json!({ "success": true }))
            }
            "ssh/terminal/batchInput" => {
                let session_ids = params
                    .get("sessionIds")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .filter(|list| !list.is_empty())
                    .ok_or("Missing sessionIds")?;
                let command = required_string(&params, "command")?;
                let append_newline = params
                    .get("appendNewline")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                Ok(self.runtime.block_on(self.ssh.batch_terminal_input(
                    &session_ids,
                    command,
                    append_newline,
                )))
            }
            "ssh/terminal/directoryTracking" => {
                let session_id = required_string(&params, "sessionId")?;
                let enabled = params
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime
                    .block_on(self.ssh.set_directory_tracking(session_id, enabled))?;
                Ok(json!({ "success": true }))
            }
            "ssh/terminal/replay" => {
                let session_id = required_string(&params, "sessionId")?;
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let replay = self.runtime.block_on(self.ssh.replay_terminal(
                    session_id,
                    after_sequence,
                    emitter,
                ))?;
                Ok(replay)
            }
            "workbench/close" => {
                let workbench_id = required_string(&params, "workbenchId")?;
                self.runtime
                    .block_on(self.ssh.close_workbench(workbench_id))?;
                Ok(json!({ "success": true }))
            }
            "ssh/host-key/resolve" | "connection/challenge/resolve" => {
                let challenge_id = required_string(&params, "challengeId")?;
                let operation_id = required_string(&params, "operationId")?;
                let accept = params
                    .get("accept")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let remember = params
                    .get("remember")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime.block_on(self.ssh.prompts.resolve(
                    challenge_id,
                    operation_id,
                    PromptDecision { accept, remember },
                ))?;
                Ok(json!({ "success": true }))
            }
            "sftp/home" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = self.runtime.block_on(self.ssh.sftp_home(session_id))?;
                Ok(json!({ "path": path }))
            }
            "sftp/list" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let entries = self
                    .runtime
                    .block_on(self.ssh.sftp_list_path(session_id, path))?;
                Ok(json!({ "entries": entries }))
            }
            "sftp/read" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let offset = optional_u64(&params, "offset", 0);
                let max_bytes = bounded_bytes(&params, "maxBytes", 256 * 1024);
                let (data, truncated) = self
                    .runtime
                    .block_on(self.ssh.sftp_read_path(session_id, path, offset, max_bytes))?;
                Ok(json!({ "dataBase64": BASE64_STANDARD.encode(data), "truncated": truncated }))
            }
            "sftp/createDirectory" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(self.ssh.sftp_create_directory(session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sftp/rename" => {
                let session_id = required_string(&params, "sessionId")?;
                let source = required_string(&params, "sourcePath")?;
                let target = required_string(&params, "targetPath")?;
                self.runtime
                    .block_on(self.ssh.sftp_rename(session_id, source, target))?;
                Ok(json!({ "success": true }))
            }
            "sftp/chmod" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let mode = params
                    .get("mode")
                    .and_then(|value| {
                        value
                            .as_str()
                            .and_then(|text| u32::from_str_radix(text, 8).ok())
                            .or_else(|| value.as_u64().and_then(|v| u32::try_from(v).ok()))
                    })
                    .filter(|value| *value <= 0o7777)
                    .ok_or("Mode must be an octal value up to 7777")?;
                self.runtime
                    .block_on(self.ssh.sftp_chmod(session_id, path, mode))?;
                Ok(json!({ "success": true }))
            }
            "sftp/diskUsage" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(self.ssh.sftp_disk_usage(session_id, path))
            }
            "sftp/stat" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sftp_ext::stat(&self.ssh, session_id, path))
            }
            "sftp/exists" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let exists = self
                    .runtime
                    .block_on(sftp_ext::exists(&self.ssh, session_id, path))?;
                Ok(json!({ "exists": exists }))
            }
            "sftp/touch" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sftp_ext::touch(&self.ssh, session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sftp/write" => {
                let session_id = required_string(&params, "sessionId")?;
                let remote_path = required_string(&params, "remotePath")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                self.runtime.block_on(sftp_ext::write_file(
                    &self.ssh,
                    session_id,
                    remote_path,
                    data_base64,
                ))?;
                Ok(json!({ "success": true }))
            }
            "sftp/archive" => {
                let session_id = required_string(&params, "sessionId")?;
                let source_paths = params
                    .get("sourcePaths")
                    .and_then(Value::as_array)
                    .ok_or("Missing sourcePaths")?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_string)
                            .ok_or_else(|| "sourcePaths must be strings".to_string())
                    })
                    .collect::<Result<Vec<String>, String>>()?;
                let archive_path = required_string(&params, "archivePath")?;
                self.runtime.block_on(sftp_ext::archive(
                    &self.ssh,
                    session_id,
                    &source_paths,
                    archive_path,
                ))
            }
            "sftp/extract" => {
                let session_id = required_string(&params, "sessionId")?;
                let archive_path = required_string(&params, "archivePath")?;
                let destination_path = required_string(&params, "destinationPath")?;
                let overwrite = params
                    .get("overwrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime.block_on(sftp_ext::extract(
                    &self.ssh,
                    session_id,
                    archive_path,
                    destination_path,
                    overwrite,
                ))?;
                Ok(json!({ "success": true }))
            }
            "sftp/copy" => {
                let session_id = self.filesystem_session(&params)?;
                self.runtime.block_on(sftp_copy::run(
                    &self.ssh,
                    &session_id,
                    sftp_copy::CopyOp::Copy,
                    &params,
                ))
            }
            "sftp/move" => {
                let session_id = self.filesystem_session(&params)?;
                self.runtime.block_on(sftp_copy::run(
                    &self.ssh,
                    &session_id,
                    sftp_copy::CopyOp::Move,
                    &params,
                ))
            }
            "ssh/metrics" => {
                let session_id = required_string(&params, "sessionId")?;
                let cached = params
                    .get("cached")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime.block_on(self.ssh.metrics(session_id, cached))
            }
            "ssh/metrics/history" => {
                let session_id = required_string(&params, "sessionId")?;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(720)
                    .clamp(1, metrics_history::MAX_SAMPLES as u64)
                    as usize;
                self.runtime
                    .block_on(self.ssh.metrics_history(session_id, limit))
            }
            "ssh/processes/list" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.ssh.processes_list(session_id))
            }
            "ssh/processes/kill" => {
                let session_id = required_string(&params, "sessionId")?;
                let pid = params
                    .get("pid")
                    .and_then(Value::as_u64)
                    .ok_or("Missing pid")?;
                let signal = params
                    .get("signal")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or(15);
                self.runtime
                    .block_on(self.ssh.kill_process(session_id, pid, signal))
            }
            "ssh/recording/start" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.ssh.recording_start(session_id))
            }
            "ssh/recording/stop" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.ssh.recording_stop(session_id))
            }
            "ssh/recording/list" => Ok(json!({
                "recordings": session_recording::list_recordings(&self.ssh.data_dir())
            })),
            "ssh/recording/get" => {
                let recording_id = required_string(&params, "recordingId")?;
                let offset = optional_u64(&params, "offset", 0) as usize;
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(session_recording::PAGE_LIMIT as u64)
                    .clamp(1, session_recording::PAGE_LIMIT as u64)
                    as usize;
                session_recording::read_events(&self.ssh.data_dir(), recording_id, offset, limit)
            }
            "ssh/recording/delete" => {
                let recording_id = required_string(&params, "recordingId")?;
                let path = session_recording::cast_path(&self.ssh.data_dir(), recording_id)?;
                std::fs::remove_file(&path)
                    .map_err(|error| format!("Failed to delete recording: {error}"))?;
                Ok(json!({ "success": true }))
            }
            "mcp/tools" => Ok(mcp::tool_definitions()),
            "mcp/call" => self
                .runtime
                .block_on(self.mcp.call_dbx(&params, emitter.clone())),
            "mcp/settings/get" => Ok(self.mcp.settings_get()),
            "mcp/settings/set" => self.mcp.settings_set(&params),
            "ssh/agent/resolve" => {
                let challenge_id = required_string(&params, "challengeId")?;
                let decision = required_string(&params, "decision")?;
                let command = params.get("command").and_then(Value::as_str);
                let remember = params
                    .get("remember")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.ssh
                    .resolve_agent_challenge(challenge_id, decision, command, remember)?;
                Ok(json!({ "success": true }))
            }
            "ssh/alert/triage" => {
                let payload = required_string(&params, "payload")?;
                Ok(alert_triage::triage_view(&alert_triage::triage(payload)))
            }
            "ssh/audit/list" => {
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(100)
                    .clamp(1, 500) as usize;
                let before_ts = params.get("beforeTs").and_then(Value::as_u64);
                // Fetch one extra entry to report truncation without a
                // second full read.
                let mut entries = audit_log::tail(&self.ssh.data_dir(), limit + 1, before_ts)?;
                let truncated = entries.len() > limit;
                entries.truncate(limit);
                let items: Vec<Value> = entries
                    .iter()
                    .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
                    .collect();
                Ok(json!({ "entries": items, "truncated": truncated }))
            }
            "ssh/audit/clear" => {
                audit_log::clear(&self.ssh.data_dir())?;
                Ok(json!({ "success": true }))
            }
            "ssh/agent/mode/get" => {
                let connection_id = required_string(&params, "connectionId")?;
                self.runtime
                    .block_on(self.ssh.agent_mode_get(connection_id))
            }
            "ssh/settings/get" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime
                    .block_on(self.ssh.settings_get(session_id, &params))
            }
            "ssh/settings/set" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime
                    .block_on(self.ssh.settings_set(session_id, &params))
            }
            "sudo/stat" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::stat(&self.ssh, session_id, path))
            }
            "sudo/exists" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let exists = self
                    .runtime
                    .block_on(sudo_fs::exists(&self.ssh, session_id, path))?;
                Ok(json!({ "exists": exists }))
            }
            "sudo/touch" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::touch(&self.ssh, session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sudo/listDir" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::list_dir(&self.ssh, session_id, path))
            }
            "sudo/readFile" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let offset = optional_u64(&params, "offset", 0);
                let length = optional_u64(&params, "length", 0);
                self.runtime.block_on(sudo_fs::read_file(
                    &self.ssh, session_id, path, offset, length,
                ))
            }
            "sudo/writeFile" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                self.runtime.block_on(sudo_fs::write_file(
                    &self.ssh,
                    session_id,
                    path,
                    data_base64,
                ))?;
                Ok(json!({ "success": true }))
            }
            "sudo/mkdir" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::mkdir(&self.ssh, session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sudo/remove" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::remove(&self.ssh, session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sudo/removeAll" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                self.runtime
                    .block_on(sudo_fs::remove_all(&self.ssh, session_id, path))?;
                Ok(json!({ "success": true }))
            }
            "sudo/chmod" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let mode = required_string(&params, "mode")?;
                self.runtime
                    .block_on(sudo_fs::chmod(&self.ssh, session_id, path, mode))?;
                Ok(json!({ "success": true }))
            }
            "sudo/rename" => {
                let session_id = required_string(&params, "sessionId")?;
                let source = required_string(&params, "sourcePath")?;
                let target = required_string(&params, "targetPath")?;
                self.runtime
                    .block_on(sudo_fs::rename(&self.ssh, session_id, source, target))?;
                Ok(json!({ "success": true }))
            }
            "sudo/profiles/list" => Ok(self.ssh.profiles_list()),
            "sudo/profiles/options" => Ok(self.ssh.profiles_options()),
            "sudo/profiles/reveal" => {
                let id = required_string(&params, "id")?;
                self.ssh.profiles_reveal(id)
            }
            "sudo/profiles/save" => self.runtime.block_on(self.ssh.profiles_save(&params)),
            "sudo/profiles/delete" => {
                let id = required_string(&params, "id")?;
                self.runtime.block_on(self.ssh.profiles_delete(id))
            }
            "ssh/quickCommands/list" => Ok(self.ssh.quick_commands_list()),
            "ssh/quickCommands/save" => self.ssh.quick_commands_save(&params),
            "ssh/quickCommands/delete" => {
                let id = required_string(&params, "id")?;
                self.ssh.quick_commands_delete(id)
            }
            "ssh/highlightRules/list" => Ok(self.ssh.highlight_rules_list()),
            "ssh/highlightRules/save" => self.ssh.highlight_rules_save(&params),
            "ssh/highlightRules/delete" => {
                let id = required_string(&params, "id")?;
                self.ssh.highlight_rules_delete(id)
            }
            "ssh/batchBar/state" => {
                // 批量发送命令条的跨工作台状态同步：把调用方（source 标识的
                // webview）的草稿/下拉选择/开关原样广播给所有插件 webview，
                // 各端按 source 过滤掉自己的回声。纯转发，sidecar 不落存储。
                emitter
                    .event("ssh/batchBar/state", params)
                    .map_err(|error| error.message)?;
                Ok(json!({ "broadcast": true }))
            }
            "connection/action" => {
                let action = connection_action_id(&params)?;
                match action {
                    "quick-sudo-profiles" => {
                        let connection_id = params.get("id").and_then(Value::as_str);
                        Ok(self.ssh.profiles_action_summary(connection_id))
                    }
                    other => Err(format!("Unknown connection action: {other}")),
                }
            }
            "keys/discover" => {
                let keys = keys::discover()?;
                Ok(json!({ "keys": keys }))
            }
            // 连接表单 private_key_path 的 options_action 数据源：宿主拉取后
            // 渲染动态下拉；无该扩展能力的宿主保持文本框（见 sudo_profile 先例）。
            "keys/discover/options" => keys::discover_options(),
            "ssh/knownHosts/list" => Ok(keys::list_known_hosts(&plugin_data_dir())?),
            "ssh/knownHosts/remove" => {
                let host = required_string(&params, "host")?;
                let port = params
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok())
                    .filter(|value| *value > 0)
                    .unwrap_or(22);
                let removed = keys::remove_known_host(&plugin_data_dir(), host, port)?;
                Ok(json!({ "success": true, "removed": removed }))
            }
            "sftp/delete" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let recursive = params
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime
                    .block_on(self.ssh.sftp_delete(session_id, path, recursive))?;
                Ok(json!({ "success": true }))
            }
            "sftp/upload/start" => {
                let session_id = required_string(&params, "sessionId")?.to_string();
                let remote_path = required_string(&params, "remotePath")?.to_string();
                let size = params
                    .get("size")
                    .and_then(Value::as_u64)
                    .ok_or("Missing upload size")?;
                let resume_task_id = params
                    .get("resumeTaskId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string);
                self.runtime.block_on(self.ssh.start_upload(
                    session_id,
                    remote_path,
                    size,
                    resume_task_id,
                    emitter,
                ))
            }
            "sftp/upload/finish" => {
                let task_id = required_string(&params, "taskId")?;
                self.runtime
                    .block_on(self.ssh.finish_upload(task_id, emitter))
            }
            "sftp/download/start" => {
                let session_id = required_string(&params, "sessionId")?;
                let remote_path = required_string(&params, "remotePath")?;
                let offset = optional_u64(&params, "offset", 0);
                let save_to_local = params
                    .get("saveToLocal")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let download_dir = params
                    .get("downloadDir")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.runtime.block_on(self.ssh.start_download(
                    session_id,
                    remote_path,
                    offset,
                    save_to_local,
                    download_dir.as_deref(),
                    emitter,
                ))
            }
            "sftp/download/next" => {
                let task_id = required_string(&params, "taskId")?;
                let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                self.runtime
                    .block_on(self.ssh.download_chunk(task_id, offset as u64, emitter))
            }
            "sftp/download/finish" => self.runtime.block_on(
                self.ssh
                    .complete_download(required_string(&params, "taskId")?, emitter),
            ),
            "sftp/transfer/cancel" => {
                self.ssh
                    .cancel_transfer(required_string(&params, "taskId")?, emitter)?;
                Ok(json!({ "success": true }))
            }
            // 本机落盘能力探测：无宿主 fileTransfer API 时前端据此决定
            // 走 sidecar 下载目录落盘还是浏览器 <a download> 兜底。
            "local/capabilities" => {
                let data_dir = plugin_data_dir();
                let downloads_dir =
                    local_downloads::downloads_base_dir(|key| std::env::var_os(key), &data_dir);
                Ok(json!({
                    "canSaveLocal": local_downloads::can_save_local(|key| std::env::var_os(key)),
                    "downloadsDir": downloads_dir.to_string_lossy(),
                    "platform": local_downloads::platform_name(),
                }))
            }
            // 在文件管理器中定位已完成的下载。只允许 reveal 传输历史里
            // 记录过的 localPath，不能成为任意路径打开原语。
            "local/reveal" => {
                let path = required_string(&params, "path")?;
                let history = transfer_history::load_history(&plugin_data_dir());
                local_downloads::reveal_validated(&history, std::path::Path::new(path))?;
                Ok(json!({ "success": true }))
            }
            // 在默认应用中打开已完成的本机下载；同样只允许打开传输历史中
            // 记录过的路径，不能成为任意路径执行原语。
            "local/open" => {
                let path = required_string(&params, "path")?;
                let history = transfer_history::load_history(&plugin_data_dir());
                local_downloads::open_validated(&history, std::path::Path::new(path))?;
                Ok(json!({ "success": true }))
            }
            "sftp/transfer/resumable" => self.ssh.resumable_uploads(),
            "sftp/transfer/list" => self
                .ssh
                .transfer_list(required_string(&params, "sessionId")?),
            "sftp/transfer/status" => self
                .ssh
                .transfer_status(required_string(&params, "taskId")?),
            "sftp/transfer/history" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty());
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 200) as usize;
                self.runtime
                    .block_on(self.ssh.transfer_history_query(session_id, limit))
            }
            "sftp/transfer/history/clear" => {
                self.ssh.clear_transfer_history()?;
                Ok(json!({ "success": true }))
            }
            "sftp/bookmarks/list" => sftp_bookmarks::list(&self.ssh.data_dir()),
            "sftp/bookmarks/save" => sftp_bookmarks::save(&self.ssh.data_dir(), &params),
            "sftp/bookmarks/delete" => {
                let id = required_string(&params, "id")?;
                sftp_bookmarks::delete(&self.ssh.data_dir(), id)
            }
            "filesystem/list" => self.filesystem_list(params),
            "filesystem/read" => self.filesystem_read(params),
            "filesystem/write" => self.filesystem_write(params),
            "filesystem/createDirectory" => self.filesystem_create_directory(params),
            "filesystem/delete" => self.filesystem_delete(params),
            "filesystem/rename" => self.filesystem_rename(params),
            "ssh/host-key/check" => {
                let connection_id = required_string(&params, "connectionId")?;
                self.runtime
                    .block_on(self.ssh.check_host_key(connection_id))
            }
            "ssh/sessions/list" => Ok(self.runtime.block_on(self.ssh.list_sessions())),
            "ssh/status" => Ok(json!({
                "ok": true,
                "plugin": "io.dbx.ssh",
                "maxTransferSize": MAX_TRANSFER_SIZE
            })),
            _ => Err(format!("Method not found: {method}")),
        }
    }

    fn filesystem_session(&self, params: &Value) -> Result<String, String> {
        if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
            return Ok(session_id.to_string());
        }
        let connection_id = connection_id_param(params)?;
        self.runtime
            .block_on(self.ssh.session_id_for_connection(connection_id))
    }

    fn filesystem_list(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        let entries = self
            .runtime
            .block_on(self.ssh.sftp_list_path(&session_id, &path))?;
        Ok(json!({ "entries": entries }))
    }

    fn filesystem_read(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        let offset = optional_u64(&params, "offset", 0);
        let max_bytes = bounded_bytes(&params, "maxBytes", 256 * 1024);
        let (data, truncated) = self.runtime.block_on(self.ssh.sftp_read_path(
            &session_id,
            &path,
            offset,
            max_bytes,
        ))?;
        Ok(json!({
            "dataBase64": BASE64_STANDARD.encode(data),
            "contentType": content_type(&path),
            "truncated": truncated
        }))
    }

    fn filesystem_write(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        let data = BASE64_STANDARD
            .decode(required_string(&params, "dataBase64")?)
            .map_err(|error| format!("Invalid base64 file data: {error}"))?;
        let create = params
            .get("create")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let overwrite = params
            .get("overwrite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.runtime.block_on(self.ssh.sftp_write_path(
            &session_id,
            &path,
            &data,
            create,
            overwrite,
        ))?;
        Ok(json!({ "success": true }))
    }

    fn filesystem_create_directory(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        self.runtime
            .block_on(self.ssh.sftp_create_directory(&session_id, &path))?;
        Ok(json!({ "success": true }))
    }

    fn filesystem_delete(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        let recursive = params
            .get("recursive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.runtime
            .block_on(self.ssh.sftp_delete(&session_id, &path, recursive))?;
        Ok(json!({ "success": true }))
    }

    fn filesystem_rename(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let source = required_string(&params, "sourceUri").and_then(path_from_sftp_uri)?;
        let target = required_string(&params, "targetUri").and_then(path_from_sftp_uri)?;
        self.runtime
            .block_on(self.ssh.sftp_rename(&session_id, &source, &target))?;
        Ok(json!({ "success": true }))
    }
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        self.handle_request(method, params, emitter)
            .map_err(to_plugin_error)
    }

    fn handle_binary(
        &self,
        channel: &str,
        data: Vec<u8>,
        emitter: &PluginEmitter,
    ) -> Result<(), PluginError> {
        if let Some(session_id) = channel.strip_prefix("ssh/terminal/in/") {
            if data.len() < 8 {
                return Err(to_plugin_error(
                    "SSH terminal input is missing its sequence".to_string(),
                ));
            }
            let sequence =
                u64::from_be_bytes(data[..8].try_into().map_err(|_| {
                    to_plugin_error("Invalid SSH terminal input sequence".to_string())
                })?);
            self.ssh
                .write_terminal(session_id, data[8..].to_vec())
                .map_err(to_plugin_error)?;
            emitter.event(
                "ssh/terminal/inputAck",
                json!({ "sessionId": session_id, "sequence": sequence }),
            )?;
            return Ok(());
        }
        if let Some(task_id) = channel.strip_prefix("sftp/upload/") {
            return self
                .ssh
                .append_upload(task_id, &data, emitter)
                .map_err(to_plugin_error);
        }
        Err(PluginError::new(
            -32601,
            format!("Unknown binary channel: {channel}"),
        ))
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("Invalid request parameters: {error}"))
}

fn trigger_input_format(raw: Option<&Value>) -> &'static str {
    match raw {
        None | Some(Value::Null) => "empty",
        Some(Value::Object(_)) => "json",
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                "empty"
            } else if serde_json::from_str::<serde_json::Map<String, Value>>(trimmed).is_ok() {
                "json"
            } else if trimmed.lines().any(|line| {
                line.trim_start_matches(['#', '!', ' '])
                    .starts_with("Expect")
            }) {
                "tssh"
            } else {
                "json"
            }
        }
        Some(_) => "invalid",
    }
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {key}"))
}

/// DBX Host sends connection actions as `{ "action": { "id": "..." } }`.
/// Accept the pre-Host-API-1.1 string form as well so older callers remain
/// compatible while the plugin follows the current host contract.
fn connection_action_id(params: &Value) -> Result<&str, String> {
    let action = params
        .get("action")
        .ok_or_else(|| "Missing action".to_string())?;
    action
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| action.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing action id".to_string())
}

/// Host API 1.1 passes `operationId` to correlate connection lifecycle calls;
/// on Host API 1.0 it is absent, so a locally generated id is used instead.
/// The id only needs to stay stable between a challenge prompt and its resolve.
fn operation_id(params: &Value) -> String {
    params
        .get("operationId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn required_u32(params: &Value, key: &str) -> Result<u32, String> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("Invalid {key}"))
}

fn bounded_bytes(params: &Value, key: &str, default: usize) -> usize {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, 1024 * 1024)
}

/// Reads an optional non-negative integer parameter, falling back to the
/// default when the key is absent or not a `u64` (negative/invalid).
fn optional_u64(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(Value::as_u64).unwrap_or(default)
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "txt" | "md" | "log" | "json" | "yaml" | "yml" | "toml" | "rs" | "ts" | "js" => {
            "text/plain"
        }
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn to_plugin_error(error: String) -> PluginError {
    PluginError::new(-32000, error)
}

/// Pure resolver for the plugin data directory so the fallback order is unit
/// testable without mutating process environment state (`lookup` abstracts
/// `std::env::var_os`). An env var counts as set only when present and
/// non-blank after trimming. Fallback order, first available wins:
///
/// 1. `DBX_PLUGIN_DATA_DIR` — host-injected explicit override (future
///    integration point).
/// 2. `DBX_DATA_DIR` → `<DBX_DATA_DIR>/plugin-data/io.dbx.ssh` (portable/web
///    host mode; `plugin-data/` avoids the installer-managed registration
///    tree).
/// 3. Platform standard user data dir: macOS `$HOME/Library/Application
///    Support`, other unix `${XDG_DATA_HOME:-$HOME/.local/share}`, Windows
///    `%APPDATA%`.
/// 4. `std::env::temp_dir()` — last resort so this function never fails.
fn resolve_plugin_data_dir(lookup: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let env = |key: &str| lookup(key).filter(|value| !value.to_string_lossy().trim().is_empty());
    if let Some(dir) = env("DBX_PLUGIN_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Some(dbx_data_dir) = env("DBX_DATA_DIR") {
        return PathBuf::from(dbx_data_dir)
            .join("plugin-data")
            .join("io.dbx.ssh");
    }
    let platform_base = if cfg!(windows) {
        env("APPDATA").map(PathBuf::from)
    } else {
        env("HOME").map(|home| {
            let home = PathBuf::from(home);
            if cfg!(target_os = "macos") {
                home.join("Library").join("Application Support")
            } else {
                env("XDG_DATA_HOME")
                    .map_or_else(|| home.join(".local").join("share"), PathBuf::from)
            }
        })
    };
    platform_base
        .map(|base| base.join("dbx-plugin-data").join("io.dbx.ssh"))
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("dbx-plugin-data")
                .join("io.dbx.ssh")
        })
}

fn plugin_data_dir() -> PathBuf {
    // Closure (not the generic `var_os` fn item) so the HRTB bound unifies.
    let requested = resolve_plugin_data_dir(|key| std::env::var_os(key));
    // Docker deployments may provide a read-only or not-yet-mounted DBX data
    // directory. Keep startup viable by falling back to the OS temp directory;
    // the warning makes the loss of persistence explicit to the host logs.
    match prepare_plugin_data_dir(&requested) {
        Ok(data_dir) => data_dir,
        Err(request_error) => {
            let fallback = std::env::temp_dir()
                .join("dbx-plugin-data")
                .join("io.dbx.ssh");
            match prepare_plugin_data_dir(&fallback) {
                Ok(data_dir) => {
                    eprintln!(
                        "[ssh-sftp-plugin] data directory {} is unavailable: {request_error}; using temporary directory {}",
                        requested.display(),
                        data_dir.display()
                    );
                    data_dir
                }
                Err(fallback_error) => {
                    eprintln!(
                        "[ssh-sftp-plugin] failed to prepare data directories {} ({request_error}) and {} ({fallback_error})",
                        requested.display(),
                        fallback.display()
                    );
                    requested
                }
            }
        }
    }
}

fn prepare_plugin_data_dir(data_dir: &std::path::Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("{}: {error}", data_dir.display()))?;
    let probe = data_dir.join(format!(".dbx-plugin-write-test-{}", uuid::Uuid::new_v4()));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("{} is not writable: {error}", data_dir.display()))?;
    std::fs::remove_file(&probe)
        .map_err(|error| format!("failed to remove write probe {}: {error}", probe.display()))?;
    // The env vars are the plugin's only path inputs; resolve symlinks and `..`
    // once at the boundary so every store path below it is canonical.
    std::fs::canonicalize(data_dir).map_err(|error| format!("{}: {error}", data_dir.display()))
}

fn main() -> std::io::Result<()> {
    // MCP stdio mode: expose SSH/SFTP tools to MCP clients over JSON-RPC
    // instead of running the DBX plugin server.
    if std::env::args().any(|arg| arg == "--mcp") {
        return mcp::run_mcp_stdio(plugin_data_dir());
    }
    let plugin = Plugin::new().map_err(std::io::Error::other)?;
    let metadata = PluginMetadata::new("io.dbx.ssh", env!("CARGO_PKG_VERSION"))
        .with_capability("connections")
        .with_capability("events")
        .with_capability("binary")
        .with_capability("filesystem");
    PluginServer::new(metadata, plugin)
        .transport(PluginTransport::Framed)
        .worker_threads(4)
        .serve()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_validation_reports_format_without_secret_content() {
        assert_eq!(trigger_input_format(None), "empty");
        assert_eq!(trigger_input_format(Some(&json!(""))), "empty");
        assert_eq!(trigger_input_format(Some(&json!({ "stages": [] }))), "json");
        assert_eq!(
            trigger_input_format(Some(&json!("#!! ExpectCount 1\n#!! ExpectPattern1 code"))),
            "tssh"
        );
        assert_eq!(trigger_input_format(Some(&json!(42))), "invalid");

        let parsed = triggers::parse_triggers(
            Some(&json!(
                r#"{"stages":[{"pattern":"code","sendSecretKey":"trigger_answer_1"}]}"#
            )),
            &|key| (key == "trigger_answer_1").then(|| "do-not-return-this".to_string()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(parsed.stages.len(), 1);
        let debug = format!("{parsed:?}");
        assert!(!debug.contains("do-not-return-this"));
    }

    #[test]
    fn preview_byte_limits_are_bounded() {
        assert_eq!(bounded_bytes(&json!({}), "maxBytes", 12), 12);
        assert_eq!(bounded_bytes(&json!({ "maxBytes": 0 }), "maxBytes", 12), 1);
        assert_eq!(
            bounded_bytes(&json!({ "maxBytes": 99_999_999 }), "maxBytes", 12),
            1024 * 1024
        );
    }

    #[test]
    fn connection_action_id_accepts_host_object_and_legacy_string_forms() {
        assert_eq!(
            connection_action_id(&json!({
                "action": { "id": "quick-sudo-profiles" }
            })),
            Ok("quick-sudo-profiles")
        );
        assert_eq!(
            connection_action_id(&json!({ "action": "quick-sudo-profiles" })),
            Ok("quick-sudo-profiles")
        );
        assert_eq!(
            connection_action_id(&json!({ "action": {} })),
            Err("Missing action id".to_string())
        );
    }

    #[test]
    fn optional_u64_falls_back_on_missing_or_invalid() {
        assert_eq!(optional_u64(&json!({}), "offset", 0), 0);
        assert_eq!(optional_u64(&json!({ "offset": 4096 }), "offset", 0), 4096);
        // Negative numbers and non-numeric values fall back to the default.
        assert_eq!(optional_u64(&json!({ "offset": -3 }), "offset", 0), 0);
        assert_eq!(optional_u64(&json!({ "offset": "later" }), "offset", 7), 7);
        assert_eq!(optional_u64(&json!({ "offset": null }), "offset", 7), 7);
    }

    fn lookup_from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| OsString::from(*value))
        }
    }

    #[test]
    fn plugin_data_dir_env_var_takes_priority() {
        let dir = resolve_plugin_data_dir(lookup_from(&[
            ("DBX_PLUGIN_DATA_DIR", "/tmp/explicit-plugin-data"),
            ("DBX_DATA_DIR", "/tmp/unused-dbx-data"),
            ("HOME", "/Users/unused"),
        ]));
        assert_eq!(dir, PathBuf::from("/tmp/explicit-plugin-data"));
    }

    #[test]
    fn blank_env_values_are_treated_as_unset() {
        // A blank DBX_PLUGIN_DATA_DIR must not win; DBX_DATA_DIR still applies.
        let dir = resolve_plugin_data_dir(lookup_from(&[
            ("DBX_PLUGIN_DATA_DIR", "   "),
            ("DBX_DATA_DIR", "/tmp/dbx-root"),
            ("HOME", "/Users/unused"),
        ]));
        assert_eq!(
            dir,
            PathBuf::from("/tmp/dbx-root")
                .join("plugin-data")
                .join("io.dbx.ssh")
        );
    }

    #[test]
    fn dbx_data_dir_maps_into_plugin_data_tree() {
        let dir = resolve_plugin_data_dir(lookup_from(&[
            ("DBX_DATA_DIR", "/tmp/dbx-root"),
            ("HOME", "/Users/unused"),
        ]));
        assert_eq!(
            dir,
            PathBuf::from("/tmp/dbx-root")
                .join("plugin-data")
                .join("io.dbx.ssh")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_home_falls_back_to_application_support() {
        let dir = resolve_plugin_data_dir(lookup_from(&[("HOME", "/Users/tester")]));
        assert_eq!(
            dir,
            PathBuf::from("/Users/tester")
                .join("Library/Application Support")
                .join("dbx-plugin-data")
                .join("io.dbx.ssh")
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn unix_xdg_data_home_is_preferred_over_local_share() {
        let with_xdg = resolve_plugin_data_dir(lookup_from(&[
            ("XDG_DATA_HOME", "/xdg/data"),
            ("HOME", "/Users/tester"),
        ]));
        assert_eq!(
            with_xdg,
            PathBuf::from("/xdg/data/dbx-plugin-data/io.dbx.ssh")
        );
        let without_xdg = resolve_plugin_data_dir(lookup_from(&[("HOME", "/Users/tester")]));
        assert_eq!(
            without_xdg,
            PathBuf::from("/Users/tester/.local/share/dbx-plugin-data/io.dbx.ssh")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_falls_back_to_appdata() {
        let dir = resolve_plugin_data_dir(lookup_from(&[(
            "APPDATA",
            r"C:\Users\tester\AppData\Roaming",
        )]));
        assert_eq!(
            dir,
            PathBuf::from(r"C:\Users\tester\AppData\Roaming")
                .join("dbx-plugin-data")
                .join("io.dbx.ssh")
        );
    }

    #[test]
    fn all_sources_missing_falls_back_to_temp_dir() {
        let dir = resolve_plugin_data_dir(lookup_from(&[]));
        assert_eq!(
            dir,
            std::env::temp_dir()
                .join("dbx-plugin-data")
                .join("io.dbx.ssh")
        );
    }

    #[test]
    fn password_is_not_in_workbench_status() {
        let value = json!({ "ok": true, "plugin": "io.dbx.ssh" });
        assert!(!value.to_string().contains("password"));
    }
}
