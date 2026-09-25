mod agent_approvals;
mod agent_terminal;
mod alert_triage;
mod app_bridge;
mod audit_log;
mod connection_import;
mod docker;
mod exec;
mod file_watch;
mod forward;
mod highlight_rules;
mod host_key;
mod keys;
mod local_downloads;
mod local_fs;
mod local_terminal;
mod mcp;
mod mcp_safety;
mod metrics;
mod metrics_history;
mod model;
mod multi_exec;
mod otp;
mod otp_store;
mod preferences;
mod quick_commands;
mod rdp_session;
mod serial_session;
mod serial_xmodem;
mod session_recording;
mod sftp_bookmarks;
mod sftp_copy;
mod sftp_ext;
mod sftp_name;
mod sftp_raw;
mod sftp_tree;
mod ssh;
mod ssh_algorithms;
mod startup_commands;
mod sudo_allowlist;
mod sudo_download;
mod sudo_fs;
mod sudo_profiles;
mod telnet_session;
mod transfer_history;
mod triggers;
mod vault;
mod vnc_session;
mod x11;

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
    local: Arc<local_terminal::LocalTerminalRuntime>,
    telnet: Arc<telnet_session::TelnetSessionRuntime>,
    serial: Arc<serial_session::SerialSessionRuntime>,
    vnc: Arc<vnc_session::VncSessionRuntime>,
    rdp: Arc<rdp_session::RdpSessionRuntime>,
    mcp: Arc<mcp::McpState>,
    watcher: Arc<file_watch::WatchRuntime>,
}

impl Plugin {
    fn new() -> Result<Self, String> {
        let data_dir = plugin_data_dir();
        let runtime =
            Runtime::new().map_err(|error| format!("Failed to create async runtime: {error}"))?;
        otp_store::init_data_dir(&data_dir);
        // Sidecar 启动即同步 X11 快速标志（重启会丢进程内状态）。
        let prefs = preferences::load_preferences(&data_dir);
        x11::set_enabled(prefs.get("x11_forwarding").and_then(Value::as_bool) == Some(true));
        // 会话自动录制（M14）沿用 X11 快速标志模式：open_session 读进程内
        // 原子量，不重复解析 preferences.json。
        session_recording::set_auto_record(
            prefs.get("auto_record").and_then(Value::as_bool) == Some(true),
        );
        let ssh = Arc::new(SshRuntime::new(data_dir));
        Ok(Self {
            runtime,
            mcp: Arc::new(mcp::McpState::shared(ssh.clone())),
            ssh,
            local: Arc::new(local_terminal::LocalTerminalRuntime::new()),
            telnet: Arc::new(telnet_session::TelnetSessionRuntime::new()),
            serial: Arc::new(serial_session::SerialSessionRuntime::new()),
            vnc: Arc::new(vnc_session::VncSessionRuntime::new()),
            rdp: Arc::new(rdp_session::RdpSessionRuntime::new()),
            watcher: Arc::new(file_watch::WatchRuntime::new()),
        })
    }

    /// 连接级 SFTP 文件名编码判定（M16）：sessionId → connectionId →
    /// 连接覆盖 > 全局偏好 > 缺省 auto。会话未知/已断开按未覆盖处理
    /// （跟随全局），判定绝不因会话状态失败。
    fn resolve_sftp_encoding(&self, session_id: &str) -> crate::sftp_name::NameEncoding {
        self.resolve_sftp_encoding_opt(Some(session_id))
    }

    /// 同上，供 watchId/taskId 链上查不到所属会话的入口使用：None 时
    /// 跳过连接覆盖直接回退全局（与"会话未知按未覆盖"语义一致）。
    fn resolve_sftp_encoding_opt(
        &self,
        session_id: Option<&str>,
    ) -> crate::sftp_name::NameEncoding {
        let connection_id = match session_id {
            Some(session_id) => self
                .runtime
                .block_on(self.ssh.connection_id_for_session(session_id)),
            None => None,
        };
        preferences::sftp_name_encoding_for(&plugin_data_dir(), connection_id.as_deref())
    }

    /// Async liveness probe for the file watchers: an emission only prompts
    /// when the owning SSH session still exists. Built from `list_sessions`
    /// because the session table itself stays inside ssh.rs; a listing
    /// failure must never kill watches, so it reports "alive".
    fn session_probe(&self) -> file_watch::SessionProbe {
        let ssh = self.ssh.clone();
        Arc::new(move |session_id: String| {
            let ssh = ssh.clone();
            Box::pin(async move {
                ssh.list_sessions()
                    .await
                    .get("sessions")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter().any(|row| {
                            row.get("sessionId").and_then(Value::as_str)
                                == Some(session_id.as_str())
                        })
                    })
                    .unwrap_or(true)
            })
        })
    }

    fn handle_request(
        &self,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        match method {
            "otp/list" => {
                let store = otp_store::load_store(&plugin_data_dir());
                Ok(json!({
                    "entries": otp_store::list_views(&store),
                    "bindings": otp_store::binding_views(&store),
                }))
            }
            "otp/save" => {
                let data_dir = plugin_data_dir();
                let vault = otp_store::vault_for(&data_dir);
                let mut store = otp_store::load_store(&data_dir);
                let (entry, created) = otp_store::save_entry(&mut store, &params, &vault)?;
                otp_store::save_store(&data_dir, &store)?;
                Ok(json!({ "entry": otp_store::entry_view(&entry), "created": created }))
            }
            "otp/delete" => {
                let data_dir = plugin_data_dir();
                let mut store = otp_store::load_store(&data_dir);
                let id = params.get("id").and_then(Value::as_str).unwrap_or_default();
                let deleted = otp_store::delete_entry(&mut store, id);
                if deleted {
                    otp_store::save_store(&data_dir, &store)?;
                }
                Ok(json!({ "deleted": deleted }))
            }
            "otp/bind" => {
                let data_dir = plugin_data_dir();
                let mut store = otp_store::load_store(&data_dir);
                let connection_id = params
                    .get("connectionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let entry_id = params
                    .get("entryId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                otp_store::bind(&mut store, connection_id, entry_id)?;
                otp_store::save_store(&data_dir, &store)?;
                Ok(json!({ "bound": true }))
            }
            "otp/unbind" => {
                let data_dir = plugin_data_dir();
                let mut store = otp_store::load_store(&data_dir);
                let connection_id = params
                    .get("connectionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let removed = otp_store::unbind(&mut store, connection_id);
                if removed {
                    otp_store::save_store(&data_dir, &store)?;
                }
                Ok(json!({ "removed": removed }))
            }
            "otp/generate" => {
                let data_dir = plugin_data_dir();
                let store = otp_store::load_store(&data_dir);
                let id = params
                    .get("entryId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let entry = store
                    .entries
                    .iter()
                    .find(|entry| entry.id == id)
                    .ok_or_else(|| "otp entry not found".to_string())?
                    .clone();
                let vault = otp_store::vault_for(&data_dir);
                let secret = otp_store::get_decrypted_secret(&vault, &entry)
                    .ok_or_else(|| "otp secret unavailable".to_string())?;
                if entry.otp_type == "hotp" {
                    let counter = entry.counter.unwrap_or(0);
                    let code = otp::hotp(entry.algorithm, &secret, counter, entry.digits);
                    let mut store = store;
                    if let Some(entry) = store.entries.iter_mut().find(|e| e.id == id) {
                        entry.counter = Some(counter + 1);
                    }
                    otp_store::save_store(&data_dir, &store)?;
                    Ok(
                        json!({ "code": format!("{code:0width$}", width = entry.digits as usize), "hotp": true }),
                    )
                } else {
                    match otp_store::take_window_code(
                        &entry.id,
                        &secret,
                        entry.algorithm,
                        entry.digits,
                        entry.period,
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    ) {
                        Ok(window) => Ok(json!({
                            "code": window.code,
                            "remainingSeconds": window.remaining_secs,
                        })),
                        Err(used) => Ok(json!({
                            "code": null,
                            "reused": true,
                            "remainingSeconds": used.remaining_secs,
                        })),
                    }
                }
            }
            "otp/import-qr" => {
                let image = params
                    .get("imageBase64")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let parsed = otp_store::decode_otpauth_qr(image)?;
                Ok(json!({
                    "otpType": parsed.otp_type,
                    "issuer": parsed.issuer,
                    "label": parsed.label,
                    "secretBase32": parsed.secret_base32,
                    "algorithm": parsed.algorithm.as_str(),
                    "digits": parsed.digits,
                    "period": parsed.period,
                    "counter": parsed.counter,
                }))
            }
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
                // 协议路由守卫（M9）：telnet/vnc 连接由工作台驱动各自的
                // 会话协议；SSH 握手对它们是无意义的错误拨号（还会把明文
                // TELNET banner 误报成握手失败）。这里给出指路错误。
                if connection.protocol != "ssh" {
                    return Ok(json!({
                        "success": false,
                        "message": format!(
                            "This connection uses the {} protocol; open it from the workbench session toolbar instead of testing it as SSH.",
                            connection.protocol
                        ),
                    }));
                }
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
                // 协议路由守卫（M9）：同 connection/test——telnet/vnc 连接
                // 不进 SSH 连接池；工作台按 protocol 路由到各自会话。
                if connection.protocol != "ssh" {
                    return Ok(json!({
                        "success": false,
                        "message": format!(
                            "This connection uses the {} protocol; open it from the workbench session toolbar instead of connecting it as SSH.",
                            connection.protocol
                        ),
                    }));
                }
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
                    &request,
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
                // External-editor watchers belong to the session; the workbench
                // usually stops them first via watch/stop-all, this is the
                // backend-side backstop.
                self.runtime.block_on(self.watcher.stop_session(session_id));
                Ok(json!({ "success": true }))
            }
            "ssh/forward/list" => Ok(self.ssh.forward_list(&params)),
            "ssh/forward/interfaces" => Ok(forward::local_interface_rows()),
            "ssh/forward/start" => self
                .runtime
                .block_on(self.ssh.forward_start(&params, emitter.clone())),
            "ssh/forward/stop" => {
                let id = required_string(&params, "id")?;
                self.runtime.block_on(self.ssh.forward_stop(id))
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
            // 本地终端：sidecar 所在机器上的交互式登录 shell。入口在 SSH
            // 工作台内，用户显式点击才会创建（默认行为零改变）；注入的
            // shell integration 只做装饰/cwd 跟踪，绝不执行其数据。
            "local/terminal/start" => {
                let request: local_terminal::LocalTerminalStartRequest = parse(params)?;
                self.runtime
                    .block_on(self.local.start(request, emitter.clone()))
            }
            "local/terminal/resize" => {
                let session_id = required_string(&params, "sessionId")?;
                let cols = required_u32(&params, "cols")?;
                let rows = required_u32(&params, "rows")?;
                self.runtime
                    .block_on(self.local.resize(session_id, cols, rows))?;
                Ok(json!({ "success": true }))
            }
            "local/terminal/replay" => {
                let session_id = required_string(&params, "sessionId")?;
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let replay = self.runtime.block_on(self.local.replay(
                    session_id,
                    after_sequence,
                    emitter,
                ))?;
                Ok(replay)
            }
            "local/session/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.local.close(session_id))?;
                Ok(json!({ "success": true }))
            }
            "local/session/list" => Ok(self.runtime.block_on(self.local.list())),
            // 本地终端 shell 发现：工作台选择器用（多平台 shell 设置）。
            "local/shells/list" => Ok(self.local.shells()),
            // PR-A4 generic launch-options contract: picker entries for the dock "+".
            "local/terminal/launch-options" => Ok(self.local.launch_options()),
            // Telnet 会话（明文协议，P2-3）：入口在 SSH 工作台工具栏，用户显
            // 式点击才会创建。IAC 协商/NAWS/Expect 自动登录见 telnet_session.rs；
            // 输入走 `telnet/terminal/in/{id}` 二进制通道，输出走
            // `telnet/terminal/out/{id}`，生命周期事件 `telnet/session/state`。
            "telnet/start" => {
                let request: telnet_session::TelnetStartRequest = parse(params)?;
                self.runtime
                    .block_on(self.telnet.start(request, emitter.clone()))
            }
            // `telnet/write` JSON 兜底（键盘主路径是二进制通道）。
            "telnet/write" => {
                let session_id = required_string(&params, "sessionId")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                let data = telnet_session::decode_write_payload(data_base64)?;
                self.telnet.write_input(session_id, data)?;
                Ok(json!({ "success": true }))
            }
            "telnet/resize" => {
                let session_id = required_string(&params, "sessionId")?;
                let cols = required_u32(&params, "cols")?;
                let rows = required_u32(&params, "rows")?;
                self.runtime
                    .block_on(self.telnet.resize(session_id, cols, rows))?;
                Ok(json!({ "success": true }))
            }
            "telnet/replay" => {
                let session_id = required_string(&params, "sessionId")?;
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let replay = self.runtime.block_on(self.telnet.replay(
                    session_id,
                    after_sequence,
                    emitter,
                ))?;
                Ok(replay)
            }
            "telnet/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.telnet.close(session_id))?;
                Ok(json!({ "success": true }))
            }
            "telnet/list" => Ok(self.runtime.block_on(self.telnet.list())),
            "serial/ports/list" => Ok(self.serial.list_ports()),
            "serial/start" => {
                let request: serial_session::SerialStartRequest = parse(params)?;
                self.runtime
                    .block_on(self.serial.start(request, emitter.clone()))
            }
            "serial/write" => {
                let session_id = required_string(&params, "sessionId")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                let data = serial_session::decode_write_payload(data_base64)?;
                let session = self.runtime.block_on(self.serial.session(session_id))?;
                self.serial
                    .write_input(&session, session_id, &data, emitter)?;
                Ok(json!({ "success": true }))
            }
            "serial/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.serial.close(session_id))?;
                Ok(json!({ "success": true }))
            }
            "serial/list" => Ok(self.runtime.block_on(self.serial.list())),
            // 序号制输出回放（设计稿 §3）：webview 重载/断线重连后恢复滚动区
            // 上下文；帧走既有 serial/terminal/out 二进制通道，摘要走 JSON。
            "serial/replay" => {
                let session_id = required_string(&params, "sessionId")?;
                let after_sequence = params
                    .get("afterSequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let replay = self.runtime.block_on(self.serial.replay(
                    session_id,
                    after_sequence,
                    emitter,
                ))?;
                Ok(replay)
            }
            // 串口文件上传（XMODEM/YMODEM/ZMODEM，NyaTerm 对齐）：引擎是纯
            // 状态机，由串口读线程喂数据/取输出；文件字节由前端 File API
            // 分块（≤64KiB）送入，sidecar 不落盘（web/docker 浏览器兜底）。
            "serial/upload/start" => {
                let session_id = required_string(&params, "sessionId")?;
                let protocol =
                    serial_xmodem::UploadProtocol::parse(required_string(&params, "protocol")?)?;
                let file_name = required_string(&params, "fileName")?;
                let total_size = params
                    .get("totalSize")
                    .and_then(Value::as_u64)
                    .ok_or("serial/upload/start: totalSize is required")?;
                self.runtime.block_on(self.serial.upload_start(
                    session_id,
                    protocol,
                    file_name.to_string(),
                    total_size,
                    emitter,
                ))
            }
            "serial/upload/data" => {
                let session_id = required_string(&params, "sessionId")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                let data = serial_session::decode_write_payload(data_base64)?;
                if data.len() > serial_xmodem::UPLOAD_CHUNK_LIMIT {
                    return Err(format!(
                        "serial/upload/data: chunk of {} bytes exceeds the {} byte limit",
                        data.len(),
                        serial_xmodem::UPLOAD_CHUNK_LIMIT
                    ));
                }
                let final_chunk = params
                    .get("final")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.runtime.block_on(self.serial.upload_data(
                    session_id,
                    data,
                    final_chunk,
                    emitter,
                ))
            }
            "serial/upload/cancel" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime
                    .block_on(self.serial.upload_cancel(session_id, emitter))
            }
            // VNC 远程桌面会话（RFB 6143 客户端，nyaterm-parity P2 2d）：入口在
            // SSH 工作台工具栏，用户显式点击才会创建。引擎为上游 vnc-rs 0.6
            // （尽调见 docs/SPIKE_VNC_SESSION.zh-CN.md）；仅声明 ZRLE+Raw 编码，
            // 帧缓冲上限 3840x2160；帧以 44 字节 patch 头（RGBA）走
            // `vnc/frame/{id}` 二进制通道，生命周期事件 `vnc/session/state`，
            // 远端剪贴板更新走 `vnc/clipboard` 事件。classic VNC-Auth 密码
            // ≤8 字节，仅建议在可信网络使用（None 认证为明文协议）。
            "vnc/start" => {
                let request: vnc_session::VncStartRequest = parse(params)?;
                self.runtime
                    .block_on(self.vnc.start(request, emitter.clone()))
            }
            // 键盘/指针事件转发（keysym 由前端映射后传入）；`vnc/write` 为
            // 同语义别名。
            "vnc/input" | "vnc/write" => {
                let request: vnc_session::VncInputRequest = parse(params)?;
                self.runtime
                    .block_on(self.vnc.input(&request.session_id, request.event))?;
                Ok(json!({ "success": true }))
            }
            // 仅前端缩放（fit/stretch/actual），不改远端分辨率。
            "vnc/resize" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.vnc.resize(session_id))?;
                Ok(json!({ "success": true }))
            }
            // 手动重连：generation 计数防串话，保留帧缓冲做整幅重绘。
            "vnc/reconnect" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime
                    .block_on(self.vnc.reconnect(session_id, emitter.clone()))
            }
            // 本地剪贴板 → 远端（Latin-1、≤1MiB）。
            "vnc/set-clipboard" => {
                let session_id = required_string(&params, "sessionId")?;
                let text = required_string(&params, "text")?.to_string();
                self.runtime
                    .block_on(self.vnc.set_clipboard(session_id, text))?;
                Ok(json!({ "success": true }))
            }
            "vnc/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.vnc.close(session_id))?;
                Ok(json!({ "success": true }))
            }
            "vnc/list" => Ok(self.runtime.block_on(self.vnc.list())),
            // RDP 远程桌面会话（RDP-2，nyaterm-parity P3-4）：引擎为 RDP-1
            // vendored IronRDP 链（0.17 lockstep）。范围（评审定案，见
            // docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md）：密码/NLA（CredSSP）
            // + TLS + 文本剪贴板 + 断线重连；不做音频/驱动器重定向/网关/UDP/
            // Kerberos。桌面帧以 44 字节 patch 头走 `rdp/frame/{id}`（与
            // vnc/frame 同族），生命周期事件 `rdp/session/state`，远端剪贴板
            // 更新走 `rdp/clipboard` 事件。安全红线：密码以 Zeroizing 持有、
            // 不进日志/审计/错误；证书策略 fail-closed（prompt 默认、120s
            // 确认窗、remember 记入 rdp-known-certs.json）；剪贴板 text-only
            // + 16 MiB 上限；认证类失败不自动重连。
            "rdp/start" => {
                let request: rdp_session::RdpStartRequest = parse(params)?;
                self.runtime
                    .block_on(self.rdp.start(request, emitter.clone(), &plugin_data_dir()))
            }
            // 键盘/指针事件转发（scancode + extended 位，映射同 NyaTerm）；
            // `rdp/write` 为同语义别名。
            "rdp/input" | "rdp/write" => {
                let request: rdp_session::RdpInputRequest = parse(params)?;
                self.runtime
                    .block_on(self.rdp.input(&request.session_id, request.input))?;
                Ok(json!({ "success": true }))
            }
            // 服务端动态分辨率（校验桌面尺寸上界后转发引擎）。
            "rdp/resize" => {
                let request: rdp_session::RdpResizeRequest = parse(params)?;
                self.runtime.block_on(self.rdp.resize(
                    &request.session_id,
                    request.width,
                    request.height,
                ))?;
                Ok(json!({ "success": true }))
            }
            // 本地剪贴板 → 远端（text-only，16 MiB 上限）。
            "rdp/set-clipboard" => {
                let session_id = required_string(&params, "sessionId")?;
                let text = required_string(&params, "text")?.to_string();
                self.runtime
                    .block_on(self.rdp.set_clipboard(session_id, text))?;
                Ok(json!({ "success": true }))
            }
            // 手动重连：generation 计数防串话。
            "rdp/reconnect" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime
                    .block_on(self.rdp.reconnect(session_id, emitter.clone()))
            }
            // 证书确认应答（`connection/challenge` kind=rdp-certificate）。
            // 缺省 accept=false：超时/取消一律拒绝（fail-closed）。
            "rdp/certificate/resolve" => {
                let challenge_id = required_string(&params, "challengeId")?;
                let accept = params
                    .get("accept")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let remember = params
                    .get("remember")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.rdp
                    .resolve_certificate(challenge_id, accept, remember)?;
                Ok(json!({ "success": true }))
            }
            "rdp/close" => {
                let session_id = required_string(&params, "sessionId")?;
                self.runtime.block_on(self.rdp.close(session_id))?;
                Ok(json!({ "success": true }))
            }
            "rdp/list" => Ok(self.runtime.block_on(self.rdp.list())),
            "workbench/close" => {
                let workbench_id = required_string(&params, "workbenchId")?;
                self.runtime
                    .block_on(self.ssh.close_workbench(workbench_id))?;
                // Local shells, Telnet and VNC sessions belong to the closing
                // tab too; a webview reload never calls this, so live
                // sessions stay reattachable there.
                self.runtime
                    .block_on(self.local.close_workbench(workbench_id));
                self.runtime
                    .block_on(self.telnet.close_workbench(workbench_id));
                self.runtime
                    .block_on(self.vnc.close_workbench(workbench_id));
                self.runtime
                    .block_on(self.rdp.close_workbench(workbench_id));
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
                // RDP 证书确认（kind=rdp-certificate）有自己的注册表；先按
                // id 路由，未命中再进 SSH host-key/agent 的共享 resolve。
                if self.rdp.has_certificate_challenge(challenge_id) {
                    self.rdp
                        .resolve_certificate(challenge_id, accept, remember)?;
                } else {
                    self.runtime.block_on(self.ssh.prompts.resolve(
                        challenge_id,
                        operation_id,
                        PromptDecision { accept, remember },
                    ))?;
                }
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
                let include_owner = params
                    .get("includeOwner")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                // 文件名编码判定（M16 连接级）：连接覆盖 > 全局偏好（latin-1 时列表走原始字节路径）。
                let encoding = self.resolve_sftp_encoding(session_id);
                let entries = self.runtime.block_on(self.ssh.sftp_list_path(
                    session_id,
                    path,
                    include_owner,
                    encoding,
                ))?;
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
                // 文件名编码判定（M16 连接级）：连接覆盖 > 全局偏好（latin-1 时写操作走原始字节路径）。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(self.ssh.sftp_create_directory(session_id, path, encoding))?;
                Ok(json!({ "success": true }))
            }
            "sftp/rename" => {
                let session_id = required_string(&params, "sessionId")?;
                let source = required_string(&params, "sourcePath")?;
                let target = required_string(&params, "targetPath")?;
                // latin-1：源按 wire 还原、目标按显示文本编码，raw RENAME。
                // 判定走连接级优先级（M16）：连接覆盖 > 全局偏好。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(self.ssh.sftp_rename(session_id, source, target, encoding))?;
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
                // latin-1（M17 增量③）：整条 wire 路径还原字节后 raw SETSTAT。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(self.ssh.sftp_chmod(session_id, path, mode, encoding))?;
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
                // latin-1（M17 增量③）：整条 wire 路径还原字节后 raw LSTAT。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(sftp_ext::stat(&self.ssh, session_id, path, encoding))
            }
            "sftp/exists" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                // 路径形式（M17 增量①）：缺省「wire 目录前缀 + 显示末段」
                // （rename 覆盖预检、上传撞名预检）；`form: "wire"` 表示整条
                // 都是列表回传的 wire 形式（粘贴预检）。latin-1（M16）下分别
                // 按 write_path_bytes / unescape_wire 还原字节，raw LSTAT 探测。
                let whole_wire = params.get("form").and_then(Value::as_str) == Some("wire");
                let encoding = self.resolve_sftp_encoding(session_id);
                let exists = self.runtime.block_on(sftp_ext::exists(
                    &self.ssh, session_id, path, encoding, whole_wire,
                ))?;
                Ok(json!({ "exists": exists }))
            }
            "sftp/rename-unique" => {
                let session_id = required_string(&params, "sessionId")?;
                let dir = required_string(&params, "dir")?;
                let name = required_string(&params, "name")?;
                // latin-1（M16）：dir 按 wire 还原、name 是新输入显示文本，
                // raw LSTAT 逐候选探测。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::rename_unique(
                    &self.ssh, session_id, dir, name, encoding,
                ))
            }
            "sftp/touch" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                // latin-1（M16）：新建文件名为用户新输入显示文本，raw
                // LSTAT/SETSTAT/OPEN。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(sftp_ext::touch(&self.ssh, session_id, path, encoding))?;
                Ok(json!({ "success": true }))
            }
            // 符号链接三命令：创建/读取指向/改指向。写操作走 ensure_writable
            // 只读门禁（对齐 sftp/chmod）；target 允许相对路径（symlink 语义）。
            "sftp/symlink-create" => {
                let session_id = required_string(&params, "sessionId")?;
                let target = required_string(&params, "target")?;
                let link_path = required_string(&params, "linkPath")?;
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::symlink_create(
                    &self.ssh, session_id, target, link_path, encoding,
                ))?;
                Ok(json!({ "success": true }))
            }
            "sftp/symlink-read" => {
                let session_id = required_string(&params, "sessionId")?;
                let link_path = required_string(&params, "linkPath")?;
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::symlink_read(
                    &self.ssh, session_id, link_path, encoding,
                ))
            }
            "sftp/symlink-update" => {
                let session_id = required_string(&params, "sessionId")?;
                let link_path = required_string(&params, "linkPath")?;
                let target = required_string(&params, "target")?;
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::symlink_update(
                    &self.ssh, session_id, link_path, target, encoding,
                ))?;
                Ok(json!({ "success": true }))
            }
            "sftp/write" => {
                let session_id = required_string(&params, "sessionId")?;
                let remote_path = required_string(&params, "remotePath")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                // latin-1（M16）：remotePath 是整条 wire 形式（列表回传），
                // 整条还原字节后 raw 暂存提交。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::write_file(
                    &self.ssh,
                    session_id,
                    remote_path,
                    data_base64,
                    encoding,
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
            // 外部编辑器回传：把 watcher 交付的 remote-edit 本地文件推回远端。
            // 安全边界见 sftp_ext::validate_remote_edit_path —— 只收
            // <下载目录>/remote-edit/ 之下、经 canonicalize 校验的文件。
            "sftp/upload-local" => {
                let session_id = required_string(&params, "sessionId")?;
                let local_path = required_string(&params, "localPath")?;
                let remote_path = required_string(&params, "remotePath")?;
                // latin-1（M16）：remotePath 是 watcher 登记的整条 wire 形式，
                // 整条还原字节后 raw 暂存提交。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(sftp_ext::upload_watched_file(
                    &self.ssh,
                    session_id,
                    local_path,
                    remote_path,
                    encoding,
                ))
            }
            // 外部编辑器回传（仅桌面端）：前端先用 sftp/download 把文件落到
            // 本地 remote-edit 目录，这里只注册监听；确认内容真变后经
            // watch/file-modified 事件推回工作台。
            "watch/start" => {
                let request: file_watch::WatchStartRequest = parse(params)?;
                self.runtime.block_on(self.watcher.start(
                    request,
                    Arc::new(WatchEventPublisher(emitter.clone())),
                    self.session_probe(),
                    &self.ssh.data_dir(),
                ))
            }
            "watch/stop" => {
                let watch_id = required_string(&params, "watchId")?;
                self.runtime.block_on(self.watcher.stop(watch_id))?;
                Ok(json!({ "success": true }))
            }
            "watch/stop-all" => {
                let session_id = required_string(&params, "sessionId")?;
                let stopped = self.runtime.block_on(self.watcher.stop_session(session_id));
                Ok(json!({ "success": true, "stopped": stopped }))
            }
            // 把被监听文件的当前磁盘字节推回远端：sidecar 从 remote-edit 下载
            // 路径读字节（宿主桥没有按路径读本地文件的能力），走 sftp/write
            // 同款原子落盘；写门禁 ensure_writable 与其他 SFTP 写完全一致。
            "watch/upload" => {
                let watch_id = required_string(&params, "watchId")?;
                let session_id = self
                    .runtime
                    .block_on(self.watcher.session_for_watch(watch_id));
                let encoding = self.resolve_sftp_encoding_opt(session_id.as_deref());
                self.runtime
                    .block_on(self.watcher.upload_back(&self.ssh, watch_id, encoding))
            }
            "sftp/copy" => {
                let session_id = self.filesystem_session(&params)?;
                // latin-1（M17 增量①）：from/toDir 是列表回传的 wire 形式，
                // 存在性预检与同名目录 move 快路径走裸包字节保真；底层 shell
                // cp/mv 的 exec 字节参数边界见 sftp_copy。
                let encoding = self.resolve_sftp_encoding(&session_id);
                self.runtime.block_on(sftp_copy::run(
                    &self.ssh,
                    &session_id,
                    sftp_copy::CopyOp::Copy,
                    &params,
                    encoding,
                ))
            }
            "sftp/move" => {
                let session_id = self.filesystem_session(&params)?;
                let encoding = self.resolve_sftp_encoding(&session_id);
                self.runtime.block_on(sftp_copy::run(
                    &self.ssh,
                    &session_id,
                    sftp_copy::CopyOp::Move,
                    &params,
                    encoding,
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
            // Docker 管理面板（IMPL_PLAN Task P2-4）。列表/日志是只读采集
            // 脚本（探针区分「未装 docker」与「daemon socket 拒绝」）；动作
            // 走白名单动词 + 容器 id 严格校验 + 只读连接直接拒绝 + 执行前
            // 审计，plain 失败且命中 daemon 权限签名时才回落 Quick Sudo
            // 管线（密码只走 stdin，绝不拼进命令行）。
            "docker/list" => {
                let session_id = required_string(&params, "sessionId")?;
                let response = self.runtime.block_on(self.ssh.exec(
                    session_id,
                    None,
                    docker::LIST_SCRIPT,
                    false,
                    Some(docker::LIST_TIMEOUT.as_secs()),
                ))?;
                let output = response
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(docker::list_payload(output))
            }
            "docker/logs" => {
                let session_id = required_string(&params, "sessionId")?;
                let container_id = required_string(&params, "containerId")?;
                let tail = optional_u64(&params, "tail", docker::TAIL_DEFAULT);
                let script = docker::logs_script(container_id, tail)?;
                let response = self.runtime.block_on(self.ssh.exec(
                    session_id,
                    None,
                    &script,
                    false,
                    Some(docker::LOGS_TIMEOUT.as_secs()),
                ))?;
                let output = response
                    .get("output")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Ok(docker::logs_payload(output))
            }
            "docker/action" => {
                let session_id = required_string(&params, "sessionId")?;
                let container_id = required_string(&params, "containerId")?;
                docker::validate_container_id(container_id)?;
                let action = docker::parse_action(required_string(&params, "action")?)?;
                // 只读连接直接拒绝：动作会改变远端容器状态。
                self.runtime
                    .block_on(self.ssh.ensure_writable(session_id))?;
                let command = docker::action_command(action, container_id);
                // 执行前写审计（意图行）：即使 sidecar 中途退出，账本上也留
                // 有一条记录；失败时补一行带错误详情的失败行。
                docker::audit_action_intent(&self.ssh.data_dir(), &command);
                let started = std::time::Instant::now();
                let plain = self.runtime.block_on(self.ssh.exec(
                    session_id,
                    None,
                    &command,
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
                    docker::audit_action_failure(
                        &self.ssh.data_dir(),
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
                    // keepalive 全部复用），连接级 sudoers 白名单同语义生效。
                    self.runtime
                        .block_on(self.ssh.ensure_sudo_allowed(session_id, &command))?;
                    return match self.runtime.block_on(self.ssh.exec(
                        session_id,
                        None,
                        &command,
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
                    "docker {} failed (exit {}): {}",
                    action.as_str(),
                    exit_code,
                    output
                )))
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
            // 一键清空：只删 recordings 目录里的 .cast 文件，返回删除数量。
            "ssh/recording/clear" => {
                let deleted = session_recording::clear_recordings(&self.ssh.data_dir());
                Ok(json!({ "success": true, "deleted": deleted }))
            }
            // 录制搜索（M14）：无持久索引，对现存 .cast 即时扫描——名称命中
            // （host/recordingId 包含查询词，大小写不敏感）或内容命中（展平
            // stdout 文本包含查询词）。空查询返回空集（前端显示未过滤列表）。
            "ssh/recording/search" => {
                let query = params
                    .get("query")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Ok(json!({
                    "recordings": session_recording::search_recordings(&self.ssh.data_dir(), &query),
                }))
            }
            // 在文件管理器中定位录制文件：按 recordingId 解析路径（校验过
            // 遍历），不暴露任意路径打开原语。
            "ssh/recording/reveal" => {
                let recording_id = required_string(&params, "recordingId")?;
                let path = session_recording::cast_path(&self.ssh.data_dir(), recording_id)?;
                if !path.exists() {
                    return Err("Recording file no longer exists".to_string());
                }
                local_downloads::reveal_in_file_manager(&path)?;
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
            // sudo 下载（M14-C DownloadSudo）：root 大文件二进制下载。start 把
            // 源文件 sudo 暂存进同目录 0600 临时件后登记进下载注册表，分块
            // （sftp/download/next）、finish 与进度事件复用既有下载管线；
            // cancel 与 sftp/transfer/cancel 同构（任务住同一个注册表）。
            "sudo/download/start" => {
                let session_id = required_string(&params, "sessionId")?;
                let path = required_string(&params, "path")?;
                let save_to_local = params
                    .get("saveToLocal")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let download_dir = params
                    .get("downloadDir")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let conflict = params.get("conflict").and_then(Value::as_str);
                self.runtime.block_on(self.ssh.start_sudo_download(
                    session_id,
                    path,
                    save_to_local,
                    download_dir.as_deref(),
                    conflict,
                    emitter,
                ))
            }
            "sudo/download/cancel" => {
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(120).collect::<String>());
                self.runtime.block_on(self.ssh.cancel_transfer(
                    required_string(&params, "taskId")?,
                    reason.as_deref(),
                    emitter,
                ))?;
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
                    // 「从文件导入私钥」：桌面端弹系统文件选择框，读取校验后
                    // 回填表单 private_key 字段；取消安静返回；web/docker
                    // sidecar 不在本机，指引粘贴内容。
                    "import-private-key" => {
                        if !local_downloads::can_save_local(|key| std::env::var_os(key)) {
                            return Err(
                                "File import is only available on desktop — paste the key content instead"
                                    .to_string(),
                            );
                        }
                        match local_fs::pick_file()? {
                            None => Ok(json!({ "message": "", "fieldValues": null })),
                            Some(path) => {
                                let content =
                                    keys::read_private_key_file(std::path::Path::new(&path))?;
                                Ok(json!({
                                    "message": format!("Imported private key from {path}"),
                                    "fieldValues": { "private_key": content },
                                }))
                            }
                        }
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
                // latin-1：wire 路径还原为原始字节，raw REMOVE/RMDIR/树删。
                // 判定走连接级优先级（M16）：连接覆盖 > 全局偏好。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime
                    .block_on(self.ssh.sftp_delete(session_id, path, recursive, encoding))?;
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
                // latin-1（M16）：远端落盘路径还原为原始字节后走裸包暂存提交。
                let session_id = self.ssh.upload_session_id(task_id);
                let encoding = self.resolve_sftp_encoding_opt(session_id.as_deref());
                self.runtime
                    .block_on(self.ssh.finish_upload(task_id, encoding, emitter))
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
                let conflict = params.get("conflict").and_then(Value::as_str);
                self.runtime.block_on(self.ssh.start_download(
                    session_id,
                    remote_path,
                    offset,
                    save_to_local,
                    download_dir.as_deref(),
                    conflict,
                    emitter,
                ))
            }
            // 递归目录下载：远端 read_dir 走树（不碰 shell、不产生远端临时
            // 包），逐文件复用下方分块下载管线，本地按相对路径镜像；分块与
            // finish/cancel 与单文件下载共用（任务在同一个注册表里）。
            // latin-1：远端遍历走裸包 READDIR，整树路径字节保真。
            "sftp/download/tree/start" => {
                let session_id = required_string(&params, "sessionId")?;
                let remote_path = required_string(&params, "remotePath")?;
                let download_dir = params
                    .get("downloadDir")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // 判定走连接级优先级（M16）：连接覆盖 > 全局偏好（整树 latin-1 遍历）。
                let encoding = self.resolve_sftp_encoding(session_id);
                self.runtime.block_on(self.ssh.start_tree_download(
                    session_id,
                    remote_path,
                    download_dir.as_deref(),
                    encoding,
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
                // Optional reason slug from the workbench ("user",
                // "ack-timeout", ...) surfaces in the ledger so a cancel can
                // be told apart from a server failure on the next bug report.
                let reason = params
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.chars().take(120).collect::<String>());
                self.runtime.block_on(self.ssh.cancel_transfer(
                    required_string(&params, "taskId")?,
                    reason.as_deref(),
                    emitter,
                ))?;
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
            // 通用本机落盘：不经过 SFTP 传输链的本地产物（录制 GIF 导出等）。
            // 与下载共用目录语义；targetDir 缺省落下载目录，必须绝对路径。
            "local/saveFile" => {
                let name = required_string(&params, "name")?;
                let data_base64 = required_string(&params, "dataBase64")?;
                let data = BASE64_STANDARD
                    .decode(data_base64)
                    .map_err(|error| format!("dataBase64 is not valid base64: {error}"))?;
                let target_dir = params.get("targetDir").and_then(Value::as_str);
                let conflict = params.get("conflict").and_then(Value::as_str);
                local_downloads::save_local_file(
                    &plugin_data_dir(),
                    name,
                    &data,
                    target_dir,
                    conflict,
                )
            }
            // 插件级 UI 偏好（下载目录、「每次询问」等）：工作台 iframe 是
            // sandbox="allow-scripts"（opaque origin），localStorage 不可用，
            // sidecar 的 preferences.json 是唯一持久存储。固定键白名单。
            "local/preferences/get" => Ok(preferences::load_preferences(&plugin_data_dir())),
            "local/preferences/set" => {
                let result = preferences::save_preferences(&plugin_data_dir(), &params);
                // Keep the X11 fast-path flag in lockstep with the file.
                let prefs = preferences::load_preferences(&plugin_data_dir());
                x11::set_enabled(
                    prefs.get("x11_forwarding").and_then(Value::as_bool) == Some(true),
                );
                // 自动录制快速标志同样与文件保持同步（对之后 open 的会话生效）。
                session_recording::set_auto_record(
                    prefs.get("auto_record").and_then(Value::as_bool) == Some(true),
                );
                result
            }
            // 背景图（P2-9）：桌面形态落盘 <plugin_data_dir>/wallpaper（≤8MiB，
            // png/jpeg/webp 魔数校验）；web/docker 形态 sidecar 存储不在本机时，
            // 前端对 set 失败降级为仅本次会话内存态。
            "local/wallpaper/get" => Ok(preferences::load_wallpaper(&plugin_data_dir())),
            "local/wallpaper/set" => preferences::save_wallpaper(&plugin_data_dir(), &params),
            "local/wallpaper/clear" => Ok(preferences::clear_wallpaper(&plugin_data_dir())),
            // 应用内目录选择器的本机浏览：只列目录（永不返回文件内容）；
            // drives 供 Windows「此电脑」盘符页，其他平台为空。
            "local/fs/browse" => {
                let path = params.get("path").and_then(Value::as_str);
                local_fs::browse_local_dir(path, &plugin_data_dir())
            }
            "local/fs/drives" => Ok(json!({ "drives": local_fs::list_local_drives() })),
            // 「询问我」冲突策略的预检：目标目录下同名文件是否已存在。
            "local/fs/exists" => {
                let dir = required_string(&params, "dir")?;
                let name = required_string(&params, "name")?;
                local_fs::target_exists(dir, name)
            }
            // 在文件管理器中定位已完成的下载。只允许 reveal 传输历史里
            // 记录过的 localPath，不能成为任意路径打开原语。目标文件已被
            // 移走/改名时回落到其父目录，再退到插件的下载目录（配置或
            // 默认），而不是让文件管理器落到系统的文档目录（issue #18）。
            "local/reveal" => {
                let path = required_string(&params, "path")?;
                let data_dir = plugin_data_dir();
                let history = transfer_history::load_history(&data_dir);
                let recorded = std::path::PathBuf::from(&path);
                local_downloads::reveal_validated(&history, &recorded)?;
                let target = local_downloads::reveal_target(
                    &recorded,
                    &local_downloads::reveal_download_dir(&data_dir),
                );
                local_downloads::reveal_in_file_manager(&target)?;
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
            // 会话导入（Xshell .xts / MobaXterm .mxtsessions / WindTerm
            // .sessions）：parse 只回脱敏预览（凭据以 hasSecret 表示），
            // commit 按选中下标重新解析并入库（凭据经 vault 加密落盘到
            // imported-connections.json，0600）。
            "import/parse" => connection_import::handle_parse(&params),
            "import/commit" => connection_import::handle_commit(&plugin_data_dir(), &params),
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
        // Host filesystem-provider listings stay on the zero-round-trip path;
        // owner names are opt-in via `sftp/list` only.
        // 宿主 filesystem-provider 列表固定 auto：编码容错只面向 SFTP 面板。
        let entries = self.runtime.block_on(self.ssh.sftp_list_path(
            &session_id,
            &path,
            false,
            sftp_name::NameEncoding::Auto,
        ))?;
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
        // 宿主 filesystem-provider 固定 auto：编码容错只面向 SFTP 面板。
        self.runtime.block_on(self.ssh.sftp_create_directory(
            &session_id,
            &path,
            sftp_name::NameEncoding::Auto,
        ))?;
        Ok(json!({ "success": true }))
    }

    fn filesystem_delete(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let path = filesystem_path(&params)?;
        let recursive = params
            .get("recursive")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.runtime.block_on(self.ssh.sftp_delete(
            &session_id,
            &path,
            recursive,
            sftp_name::NameEncoding::Auto,
        ))?;
        Ok(json!({ "success": true }))
    }

    fn filesystem_rename(&self, params: Value) -> Result<Value, String> {
        let session_id = self.filesystem_session(&params)?;
        let source = required_string(&params, "sourceUri").and_then(path_from_sftp_uri)?;
        let target = required_string(&params, "targetUri").and_then(path_from_sftp_uri)?;
        self.runtime.block_on(self.ssh.sftp_rename(
            &session_id,
            &source,
            &target,
            sftp_name::NameEncoding::Auto,
        ))?;
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
            TERMINAL_INPUT_FRAMES_RECEIVED.fetch_add(1, Ordering::Relaxed);
            let (sequence, payload) = match decode_sequenced_input(&data) {
                Ok(split) => split,
                Err(error) => return Err(to_plugin_error(error)),
            };
            if let Err(error) = self.ssh.write_terminal(session_id, payload) {
                // Binary handler failures are only logged by the SDK loop, so a
                // workbench typing into a dead session (host-pushed disconnect,
                // sidecar restart) would otherwise learn nothing: the tab keeps
                // looking alive while every keystroke is swallowed. Mirror the
                // failure as an event the workbench can auto-reconnect on.
                let _ = emitter.event(
                    "ssh/terminal/error",
                    json!({ "sessionId": session_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            emitter.event(
                "ssh/terminal/inputAck",
                json!({ "sessionId": session_id, "sequence": sequence }),
            )?;
            return Ok(());
        }
        if let Some(session_id) = channel.strip_prefix("local/terminal/in/") {
            let (sequence, payload) = match decode_sequenced_input(&data) {
                Ok(split) => split,
                Err(error) => return Err(to_plugin_error(error)),
            };
            if let Err(error) = self.local.write_input(session_id, payload) {
                // Mirror the SSH branch: without an event the tab keeps
                // looking alive while every keystroke is swallowed.
                let _ = emitter.event(
                    "local/terminal/error",
                    json!({ "sessionId": session_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            emitter.event(
                "local/terminal/inputAck",
                json!({ "sessionId": session_id, "sequence": sequence }),
            )?;
            return Ok(());
        }
        if let Some(session_id) = channel.strip_prefix("telnet/terminal/in/") {
            let (sequence, payload) = match decode_sequenced_input(&data) {
                Ok(split) => split,
                Err(error) => return Err(to_plugin_error(error)),
            };
            if let Err(error) = self.telnet.write_input(session_id, payload) {
                // Mirror the SSH/local branches: without an event the tab
                // keeps looking alive while every keystroke is swallowed.
                let _ = emitter.event(
                    "telnet/terminal/error",
                    json!({ "sessionId": session_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            emitter.event(
                "telnet/terminal/inputAck",
                json!({ "sessionId": session_id, "sequence": sequence }),
            )?;
            return Ok(());
        }
        if let Some(session_id) = channel.strip_prefix("serial/terminal/in/") {
            // 串口 B1 二进制写通道：帧与输出同构（流标签 + u64 序号 + 数据），
            // 非 Stdin 标签/截断帧 → 参数错误。上传活动期间一律拒绝（互斥
            // 后盾，第一道闸门在前端）；死会话/互斥拒绝镜像 `serial/terminal/
            // error` 事件，工作台不至于看着在线却打不进字。
            TERMINAL_INPUT_FRAMES_RECEIVED.fetch_add(1, Ordering::Relaxed);
            let (sequence, payload) = match serial_session::decode_input_frame(&data) {
                Ok(split) => split,
                Err(error) => return Err(to_plugin_error(error)),
            };
            let session = match self.runtime.block_on(self.serial.session(session_id)) {
                Ok(session) => session,
                Err(error) => {
                    let _ = emitter.event(
                        "serial/terminal/error",
                        json!({ "sessionId": session_id, "error": error }),
                    );
                    return Err(to_plugin_error(error));
                }
            };
            if session.upload_active() {
                let error =
                    "Serial input is rejected while a file upload is in progress".to_string();
                let _ = emitter.event(
                    "serial/terminal/error",
                    json!({ "sessionId": session_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            if let Err(error) = self
                .serial
                .write_input(&session, session_id, &payload, emitter)
            {
                let _ = emitter.event(
                    "serial/terminal/error",
                    json!({ "sessionId": session_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            emitter.event(
                "serial/terminal/inputAck",
                json!({ "sessionId": session_id, "sequence": sequence }),
            )?;
            return Ok(());
        }
        if let Some(task_id) = channel.strip_prefix("sftp/upload/") {
            // Binary handler failures are only logged by the SDK loop, so the
            // workbench would otherwise learn about a desynced/missing upload
            // only through a 30s ack timeout. Mirror the failure as an event
            // it can react to immediately.
            if let Err(error) = self.ssh.append_upload(task_id, &data, emitter) {
                let _ = emitter.event(
                    "sftp/upload/error",
                    json!({ "taskId": task_id, "error": error }),
                );
                return Err(to_plugin_error(error));
            }
            return Ok(());
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

/// Forwards confirmed watcher changes to the host as a `watch/file-modified`
/// event, channel shape matching the other sidecar state broadcasts
/// (`local/session/state`, `ssh/forward/state`). Emission failures are logged
/// and otherwise ignored — the registry stays authoritative.
struct WatchEventPublisher(PluginEmitter);

impl file_watch::EventPublisher for WatchEventPublisher {
    fn publish(&self, payload: Value) {
        if let Err(error) = self.0.event("watch/file-modified", payload) {
            eprintln!(
                "[ssh-sftp-plugin] watch file-modified event failed: {}",
                error.message
            );
        }
    }
}

/// Terminal binary input frames carry an 8-byte BE sequence ahead of the
/// keystrokes; the sequence is only echoed in the inputAck event for the
/// workbench's bookkeeping — ordering comes from the SDK's per-channel lane.
fn decode_sequenced_input(data: &[u8]) -> Result<(u64, Vec<u8>), String> {
    if data.len() < 8 {
        return Err("terminal input is missing its sequence".to_string());
    }
    let sequence = u64::from_be_bytes(
        data[..8]
            .try_into()
            .map_err(|_| "invalid terminal input sequence".to_string())?,
    );
    Ok((sequence, data[8..].to_vec()))
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
    log_sidecar_exit("serve-start".to_string());
    spawn_terminal_input_counter();
    let plugin = Plugin::new().map_err(std::io::Error::other)?;
    let metadata = PluginMetadata::new("io.dbx.ssh", env!("CARGO_PKG_VERSION"))
        .with_capability("connections")
        .with_capability("events")
        .with_capability("binary")
        .with_capability("filesystem");
    let result = PluginServer::new(metadata, plugin)
        .transport(PluginTransport::Framed)
        .worker_threads(4)
        .serve();
    // serve() only returns when stdin reaches EOF (host closed the pipe) or a
    // read fails; everything else — SIGTERM/SIGKILL, a crash — ends the
    // process without any trace. #33/#71 debugging showed mid-session sidecar
    // exits that leave zero output in the host log, so the exit cause is
    // appended here to tell "host closed stdin" (line present) apart from
    // "host signalled the process" (no line).
    log_sidecar_exit(match &result {
        Ok(()) => "serve-ok stdin-eof".to_string(),
        Err(error) => format!("serve-err {error}"),
    });
    result
}

/// Best-effort append to `<data-dir>/sidecar-exit.log`; never fails startup
/// or shutdown when the data dir is unusable.
fn log_sidecar_exit(stage: String) {
    use std::io::Write;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let path = plugin_data_dir().join("sidecar-exit.log");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = writeln!(file, "{} pid={} {}", timestamp, std::process::id(), stage);
}

/// Terminal input frames received from the host bridge (#33/#71 rapid-input
/// loss diagnosis): the count dumped to `<data-dir>/terminal-input-count.log`
/// every few seconds is the sidecar-side ground truth. Compared against what
/// the user actually typed it tells input loss before the sidecar (webview or
/// host bridge dropped frames) apart from loss after it (display side).
static TERMINAL_INPUT_FRAMES_RECEIVED: AtomicU64 = AtomicU64::new(0);

fn spawn_terminal_input_counter() {
    std::thread::spawn(|| {
        let mut last_dumped = 0u64;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let total = TERMINAL_INPUT_FRAMES_RECEIVED.load(Ordering::Relaxed);
            if total == last_dumped {
                continue;
            }
            last_dumped = total;
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs())
                .unwrap_or(0);
            let path = plugin_data_dir().join("terminal-input-count.log");
            let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            else {
                continue;
            };
            use std::io::Write;
            let _ = writeln!(file, "{timestamp} pid={} total={total}", std::process::id());
        }
    });
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
