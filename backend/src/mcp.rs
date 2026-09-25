//! MCP stdio server mode (`--mcp`): exposes SSH exec and SFTP tools to MCP
//! clients over newline-delimited JSON-RPC, mirroring tiny-rdm's MCP tool
//! surface (ssh_exec, ssh_exec_sudo, sftp_*) adapted to inline connection
//! parameters with a per-process connection pool.

use std::collections::HashMap;
use std::future::Future;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use dbx_plugin_sdk::PluginEmitter;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex as AsyncMutex, RwLock as AsyncRwLock};

use crate::agent_approvals;
use crate::agent_terminal::{self, AgentTerminalMode};
use crate::alert_triage;
use crate::app_bridge;
use crate::audit_log;
use crate::docker;
use crate::exec::{self, AuthFlowMode, Hints, SudoAuth};
use crate::host_key::HostKeyVerifier;
use crate::mcp_safety::{self, CommandRisk};
use crate::model::{AuthenticationMethod, JumpHost, StoredConnection, SudoSource};
use crate::multi_exec;
use crate::preferences;
use crate::sftp_copy;
use crate::sftp_name;
use crate::sftp_raw;
use crate::ssh::{
    classify_raw_kind, raw_delete_tree, RawSftpClient, SshClient, SshRuntime,
    NO_TERMINAL_SESSION_MESSAGE,
};
use crate::sudo_allowlist;
use crate::sudo_profiles;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// Ceilings for the MCP size settings (tiny-rdm's PreferencesMCPSFTP
/// equivalent): `mcp/settings/set` may lower a limit freely or raise it up
/// to these values, never beyond. The same ceilings clamp the values after
/// loading `mcp-settings.json`, so a corrupted or hand-edited file cannot
/// disable the caps.
const READ_LIMIT_CEILING: u64 = 8 * 1024 * 1024;
const UPLOAD_LIMIT_CEILING: u64 = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_LIMIT_CEILING: u64 = 2 * 1024 * 1024 * 1024;

/// Size preferences for the MCP tools, persisted in
/// `<plugin_data_dir>/mcp-settings.json`:
/// - `max_read_bytes`: default size of a single `sftp_read_file` call
///   (previously the `DEFAULT_READ_BYTES` constant);
/// - `max_download_bytes`: ceiling for an explicit `maxBytes` request,
///   i.e. the most a single read/download may return (previously the
///   `MAX_READ_BYTES` constant);
/// - `max_upload_bytes`: ceiling for the content of a single
///   `sftp_write_file` call (new; writes were previously uncapped);
/// - `local_transfer_root`: confinement root for the local side of
///   `sftp_upload` / `sftp_download`; empty = the default roots (OS temp
///   dir + plugin data dir). See
///   [`ensure_local_transfer_allowed_in`].
///
/// §1.3 permission settings ride the same file (`execPermissionMode`,
/// `connectionScope`), parsed into [`McpPermission`] separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpLimits {
    pub max_read_bytes: u64,
    pub max_upload_bytes: u64,
    pub max_download_bytes: u64,
    pub local_transfer_root: String,
}

impl Default for McpLimits {
    fn default() -> Self {
        Self {
            max_read_bytes: 256 * 1024,
            max_upload_bytes: 16 * 1024 * 1024,
            max_download_bytes: 1024 * 1024,
            local_transfer_root: String::new(),
        }
    }
}

impl McpLimits {
    /// Clamps each field into `1..=ceiling`. Applied after loading the
    /// settings file and after every update so out-of-range values can
    /// never reach the tool implementations.
    fn sanitized(self) -> Self {
        Self {
            max_read_bytes: self.max_read_bytes.clamp(1, READ_LIMIT_CEILING),
            max_upload_bytes: self.max_upload_bytes.clamp(1, UPLOAD_LIMIT_CEILING),
            max_download_bytes: self.max_download_bytes.clamp(1, DOWNLOAD_LIMIT_CEILING),
            local_transfer_root: self.local_transfer_root,
        }
    }
    /// Parses the persisted JSON, falling back per-field to the defaults for
    /// missing or non-numeric entries.
    fn from_json(value: &Value) -> Self {
        let defaults = Self::default();
        let field =
            |key: &str, fallback: u64| value.get(key).and_then(Value::as_u64).unwrap_or(fallback);
        Self {
            max_read_bytes: field("maxReadBytes", defaults.max_read_bytes),
            max_upload_bytes: field("maxUploadBytes", defaults.max_upload_bytes),
            max_download_bytes: field("maxDownloadBytes", defaults.max_download_bytes),
            local_transfer_root: value
                .get("localTransferRoot")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string(),
        }
        .sanitized()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "maxReadBytes": self.max_read_bytes,
            "maxUploadBytes": self.max_upload_bytes,
            "maxDownloadBytes": self.max_download_bytes,
            "localTransferRoot": self.local_transfer_root,
        })
    }

    /// Reads the persisted settings; a missing or corrupted file falls back
    /// to the defaults and never fails.
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| Self::from_json(&value))
            .unwrap_or_default()
    }
}

/// §1.3 permission settings (`IMPL_PLAN_NETCATTY_PARITY`), persisted in the
/// same `mcp-settings.json` as [`McpLimits`]:
/// - `exec_permission_mode`: `"autonomous"` (default; existing gate-only
///   behavior) or `"confirm"` (write/exec tools additionally raise a
///   human approval challenge before executing);
/// - `connection_scope`: allowlist of connection references (connection id,
///   connection name, or host — ASCII case-insensitive); empty = no
///   restriction. While non-empty, calls whose resolved target is out of
///   scope are refused, inline-credential dialing is refused outright
///   (fail closed), and `ssh_list_connections` only reports in-scope
///   entries.
///
/// Process env vars override the persisted values when present
/// (`DBX_SSH_MCP_PERMISSION_MODE`, `DBX_SSH_MCP_CONNECTION_SCOPE` as a
/// comma-separated list) so MCP clients can pin policy per server entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpPermission {
    pub exec_permission_mode: String,
    pub connection_scope: Vec<String>,
}

pub const PERMISSION_MODE_AUTONOMOUS: &str = "autonomous";
pub const PERMISSION_MODE_CONFIRM: &str = "confirm";
/// Cap on scope entries so a pathological list cannot balloon the gate.
pub const CONNECTION_SCOPE_MAX_ENTRIES: usize = 64;

impl Default for McpPermission {
    fn default() -> Self {
        Self {
            exec_permission_mode: PERMISSION_MODE_AUTONOMOUS.to_string(),
            connection_scope: Vec::new(),
        }
    }
}

impl McpPermission {
    /// Parses the permission section of the persisted JSON; missing or
    /// invalid fields fall back to the defaults (a hand-edited file can
    /// loosen nothing below the defaults).
    fn from_json(value: &Value) -> Self {
        let mode = value
            .get("execPermissionMode")
            .and_then(Value::as_str)
            .filter(|text| matches!(*text, PERMISSION_MODE_AUTONOMOUS | PERMISSION_MODE_CONFIRM))
            .unwrap_or(PERMISSION_MODE_AUTONOMOUS);
        let scope = value
            .get("connectionScope")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .take(CONNECTION_SCOPE_MAX_ENTRIES)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            exec_permission_mode: mode.to_string(),
            connection_scope: scope,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "execPermissionMode": self.exec_permission_mode,
            "connectionScope": self.connection_scope,
        })
    }

    /// Reads the persisted permission section; a missing or corrupted file
    /// falls back to the defaults and never fails.
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| Self::from_json(&value))
            .unwrap_or_default()
    }
}

/// Writes the combined MCP settings document (size limits + §1.3
/// permission keys) in one pass, so either section's writer can never
/// clobber the other's keys.
fn write_settings_document(
    path: &Path,
    limits: &McpLimits,
    permission: &McpPermission,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut document = json!({});
    {
        let map = document.as_object_mut().expect("json!({}) is an object");
        let limit_entries = limits.clone().to_json();
        if let Some(limit_map) = limit_entries.as_object() {
            for (key, value) in limit_map {
                map.insert(key.clone(), value.clone());
            }
        }
        let permission_entries = permission.clone().to_json();
        if let Some(permission_map) = permission_entries.as_object() {
            for (key, value) in permission_map {
                map.insert(key.clone(), value.clone());
            }
        }
    }
    let text = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("Failed to encode MCP settings: {error}"))?;
    std::fs::write(path, text)
        .map_err(|error| format!("Failed to write MCP settings {}: {error}", path.display()))
}

/// Parses `DBX_SSH_MCP_PERMISSION_MODE`: present-and-valid wins, any other
/// value (unset, blank, unknown mode) leaves the persisted setting in force.
fn permission_mode_from_env(lookup: impl FnOnce(&str) -> Option<String>) -> Option<String> {
    let value = lookup("DBX_SSH_MCP_PERMISSION_MODE")?;
    let trimmed = value.trim();
    if trimmed == PERMISSION_MODE_AUTONOMOUS || trimmed == PERMISSION_MODE_CONFIRM {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Effective connection-scope policy. Persisted empty arrays retain their
/// original "unrestricted" UI meaning, while an explicitly empty environment
/// override is fail-closed and therefore must use a distinct representation.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConnectionScope {
    Unrestricted,
    DenyAll,
    AllowList(Vec<String>),
}

impl ConnectionScope {
    fn from_persisted(entries: Vec<String>) -> Self {
        if entries.is_empty() {
            Self::Unrestricted
        } else {
            Self::AllowList(entries)
        }
    }

    fn allows(&self, id: &str, name: Option<&str>, host: &str) -> bool {
        match self {
            Self::Unrestricted => true,
            Self::DenyAll => false,
            Self::AllowList(entries) => scope_allows(entries, id, name, host),
        }
    }

    fn is_active(&self) -> bool {
        !matches!(self, Self::Unrestricted)
    }

    fn entries(&self) -> &[String] {
        match self {
            Self::AllowList(entries) => entries,
            Self::Unrestricted | Self::DenyAll => &[],
        }
    }
}

/// Parses `DBX_SSH_MCP_CONNECTION_SCOPE` (comma-separated entries). An env
/// var that is set but parses to zero entries still counts as an override —
/// an operator pinning an empty list means "no connections", not "unset".
fn scope_from_env(lookup: impl FnOnce(&str) -> Option<String>) -> Option<ConnectionScope> {
    let value = lookup("DBX_SSH_MCP_CONNECTION_SCOPE")?;
    let entries: Vec<String> = value
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .take(CONNECTION_SCOPE_MAX_ENTRIES)
        .collect();
    Some(if entries.is_empty() {
        ConnectionScope::DenyAll
    } else {
        ConnectionScope::AllowList(entries)
    })
}

/// Scope match rule (§1.3): an entry allows a connection when it equals the
/// connection id, equals the connection name, or equals the host ASCII
/// case-insensitively. Empty entry lists are only used by callers that have
/// already selected the unrestricted policy.
pub fn scope_allows(scope: &[String], id: &str, name: Option<&str>, host: &str) -> bool {
    scope.iter().any(|entry| {
        entry == id
            || name.map(|name| entry == name).unwrap_or(false)
            || entry.eq_ignore_ascii_case(host)
    })
}

/// Confirm-mode gate set (§1.3): write tools plus the exec family.
/// Read-only tools and `ssh_close` are never intercepted. `docker_action` is
/// intentionally structured; the frontend shows its canonical command but
/// keeps that confirmation field read-only, unlike ordinary SSH commands.
fn is_confirm_gated_tool(name: &str) -> bool {
    is_write_tool(name) || matches!(name, "ssh_exec" | "ssh_multi_exec" | "ssh_terminal_input")
}

/// Tools whose resolved target must sit inside a non-empty
/// `connectionScope` (§1.3). Local/offline tools (known-hosts management,
/// Quick Sudo profiles, alert triage, the list tool itself) stay outside.
fn is_connection_scoped_tool(name: &str) -> bool {
    if is_confirm_gated_tool(name) {
        return true;
    }
    matches!(
        name,
        "ssh_task_status"
            | "ssh_metrics"
            | "docker_list"
            | "docker_action"
            | "ssh_test_connection"
            | "ssh_close"
            | "sftp_list_dir"
            | "sftp_stat"
            | "sftp_exists"
            | "sftp_pwd"
            | "sftp_read_file"
            | "sftp_write_file"
            | "sftp_upload"
            | "sftp_download"
            | "sftp_mkdir"
            | "sftp_remove"
            | "sftp_rename"
            | "sftp_chmod"
            | "sftp_disk_usage"
            | "sftp_copy"
            | "sftp_move"
    )
}

/// Validates the `localTransferRoot` setting: an absolute path string, or
/// empty to clear the override (falling back to the default transfer
/// roots).
fn validated_transfer_root(value: &Value) -> Result<String, String> {
    let root = value
        .as_str()
        .ok_or_else(|| {
            "localTransferRoot must be a string (absolute path, or empty to reset)".to_string()
        })?
        .trim()
        .to_string();
    if !root.is_empty() && !Path::new(&root).is_absolute() {
        return Err("localTransferRoot must be an absolute path (or empty to reset)".to_string());
    }
    Ok(root)
}

/// Validates one `mcp/settings/set` field: an unsigned integer within
/// `1..=ceiling`.
fn validated_limit(value: &Value, name: &str, ceiling: u64) -> Result<u64, String> {
    let bytes = value
        .as_u64()
        .ok_or_else(|| format!("{name} must be a positive integer number of bytes"))?;
    if bytes == 0 || bytes > ceiling {
        return Err(format!("{name} must be between 1 and {ceiling} bytes"));
    }
    Ok(bytes)
}

/// Single input-line ceiling (`DBX_SSH_MCP_STDIO_MAX_LINE`, bytes), the
/// family contract shared with files (`DBX_FILES_MCP_STDIO_MAX_LINE`) /
/// ldap / kafka: the request side has no schema-level size cap (a large
/// inline payload is a legitimate line), but the reader must stay bounded —
/// an unbounded line is an unbounded allocation from any writer on the other
/// end of the pipe. Default 16 MiB comfortably fits every legitimate inline
/// payload (the smoke's 8 MiB hostile-line case included); tests/smoke lower
/// it to exercise the over-limit path cheaply.
const DEFAULT_STDIO_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

fn stdio_max_line_bytes() -> usize {
    std::env::var("DBX_SSH_MCP_STDIO_MAX_LINE")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STDIO_MAX_LINE_BYTES)
}

/// `-32700` answer for one over-limit input line (null id). The line has
/// already been consumed through its trailing newline by the `read_until`
/// loop, so the session continues with the next request.
fn over_limit_line_response(bytes: usize, limit: usize) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": {
            "code": -32700,
            "message": format!(
                "Parse error: request line of {bytes} bytes exceeds the \
                 {limit}-byte limit (DBX_SSH_MCP_STDIO_MAX_LINE)"
            ),
        },
    })
}

pub fn run_mcp_stdio(data_dir: PathBuf) -> io::Result<()> {
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|error| io::Error::other(format!("Failed to create async runtime: {error}")))?;
    let state = Arc::new(McpState::new(data_dir));
    let stdin = io::stdin();
    // Spawned handlers may finish out of order; the mutex keeps each
    // JSON-RPC line intact and id-based correlation makes ordering
    // irrelevant to callers.
    let stdout = Arc::new(std::sync::Mutex::new(io::stdout()));
    // Handles of every spawned request, drained before exit so a task that
    // is mid-connection (or mid-command) isn't cancelled when stdin closes.
    let mut in_flight = Vec::new();
    // Single-line ceiling: `read_until` (not `lines()`) so an over-limit
    // line is consumed WHOLE through its newline — the -32700 reply goes out
    // and the next request still parses. Lossy decoding turns invalid UTF-8
    // into U+FFFD, which fails JSON parsing below into the same -32700 path
    // (the InvalidData arm in `classify_stdio_line` stays as the defensive
    // fallback for that error shape).
    let max_line = stdio_max_line_bytes();
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        let read = stdin.lock().read_until(b'\n', &mut raw)?;
        if read == 0 {
            break; // EOF: stdin closed
        }
        let text = String::from_utf8_lossy(&raw);
        let text = text.trim_end_matches(['\n', '\r']).to_string();
        if text.len() > max_line {
            write_response(&stdout, over_limit_line_response(text.len(), max_line))?;
            continue;
        }
        // Spawn every request instead of block_on: one long tool call (a
        // slow ssh_exec, an sftp transfer) must not stall ping, tools/list,
        // or calls for other connections behind it. The host may already
        // have abandoned THIS call; its handler still runs to completion
        // and replies into the pipe.
        match classify_stdio_line(Ok(text))? {
            StdioLine::Silent => continue,
            StdioLine::Reply(response) => write_response(&stdout, response)?,
            StdioLine::Request(request) => {
                let state = Arc::clone(&state);
                let stdout = Arc::clone(&stdout);
                in_flight.push(runtime.spawn(async move {
                    if let Some(response) = state.dispatch(request).await {
                        let _ = write_response(&stdout, response);
                    }
                }));
            }
        }
    }
    // stdin is closed: drain in-flight handlers (bounded, as a runaway
    // handler must not pin the process forever) before the runtime drops.
    // The timeout future is built INSIDE block_on: tokio timers capture
    // Handle::current() at construction, which needs the runtime context.
    let drain = async {
        for handle in in_flight {
            let _ = handle.await;
        }
    };
    let _ = runtime.block_on(async { tokio::time::timeout(Duration::from_secs(300), drain).await });
    Ok(())
}

fn write_response(stdout: &std::sync::Mutex<io::Stdout>, response: Value) -> io::Result<()> {
    let mut guard = stdout
        .lock()
        .map_err(|poisoned| io::Error::other(poisoned.to_string()))?;
    writeln!(guard, "{response}")?;
    guard.flush()
}

/// Transport-tier outcome of one stdio line (reliability round 5): keep the
/// process serving no matter what a hostile client writes into the pipe.
#[derive(Debug)]
enum StdioLine {
    /// Blank line or CRLF-only line: nothing to answer, no state change.
    Silent,
    /// A ready transport-tier reply (-32700 parse error) that must go out
    /// before the next line is read.
    Reply(Value),
    /// A parseable JSON value for the async JSON-RPC dispatcher.
    Request(Value),
}

/// Classifies one stdin line. The `read_until` loop decodes lossily, so an
/// invalid-UTF-8 line arrives as a String with U+FFFD bytes and fails JSON
/// parsing into the same -32700 path; the `InvalidData` arm below stays as
/// the defensive fallback for the `BufRead::lines`-style error shape (and is
/// unit-tested). Real I/O errors still abort.
fn classify_stdio_line(line: io::Result<String>) -> io::Result<StdioLine> {
    let line = match line {
        Ok(line) => line,
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            return Ok(StdioLine::Reply(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": format!("Parse error: {error}") },
            })));
        }
        Err(error) => return Err(error),
    };
    if line.trim().is_empty() {
        // Trailing `\r` from a CRLF peer and empty keepalive lines land here.
        return Ok(StdioLine::Silent);
    }
    match serde_json::from_str(&line) {
        Ok(request) => Ok(StdioLine::Request(request)),
        Err(error) => Ok(StdioLine::Reply(json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": { "code": -32700, "message": format!("Parse error: {error}") },
        }))),
    }
}

struct McpConnection {
    handle: Arc<Handle<SshClient>>,
    #[allow(dead_code)]
    jumps: Vec<Arc<Handle<SshClient>>>,
    sftp: Option<Arc<AsyncMutex<SftpSession>>>,
}

impl McpConnection {
    async fn sftp(&mut self) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        if let Some(sftp) = self.sftp.as_ref() {
            return Ok(sftp.clone());
        }
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        let sftp = Arc::new(AsyncMutex::new(
            SftpSession::new(channel.into_stream())
                .await
                .map_err(|error| format!("Failed to start SFTP: {error}"))?,
        ));
        self.sftp = Some(sftp.clone());
        Ok(sftp)
    }

    /// 独立打开一条 sftp 子系统通道跑裸包客户端（严格串行请求/响应），与
    /// 高层会话并存不复用：latin-1 编码模式下列表/写操作保原始字节专用
    /// （M17，语义与 `ssh.rs::raw_sftp_client` 一致）。
    async fn raw_sftp(&mut self) -> Result<RawSftpClient, String> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        sftp_raw::RawSftp::init(channel.into_stream()).await
    }
}

pub struct McpState {
    runtime: Arc<SshRuntime>,
    connections: AsyncRwLock<HashMap<String, McpConnection>>,
    /// StoredConnection payloads registered through `mcp/call` (DBX
    /// connections), kept so a dropped pooled handle can be reconnected
    /// without asking the caller for credentials again.
    dbx_connections: AsyncRwLock<HashMap<String, StoredConnection>>,
    /// MCP size preferences, mirrored to `limits_path` on every change.
    limits: RwLock<McpLimits>,
    /// §1.3 permission settings, sharing `limits_path`'s
    /// `mcp-settings.json` (separate read/write guard).
    permission: RwLock<McpPermission>,
    limits_path: PathBuf,
    /// Operator-level kill switch: `DBX_SSH_MCP_READ_ONLY` forces every
    /// tool call (bridge and standalone alike) through the read-only gates.
    global_read_only: bool,
    /// L1 stdio bridge fallback switch: forwards unregistered-`connectionId`
    /// calls to the running DBX app through the local TCP bridge. Always on
    /// in production; tests flip it off to keep decision paths hermetic (no
    /// real app bridge on the box).
    bridge_fallback: bool,
}

/// Truthy values accepted for `DBX_SSH_MCP_READ_ONLY`.
fn env_read_only() -> bool {
    matches!(
        std::env::var("DBX_SSH_MCP_READ_ONLY").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "on")
    )
}

impl McpState {
    pub fn new(data_dir: PathBuf) -> Self {
        let limits_path = data_dir.join("mcp-settings.json");
        let limits = McpLimits::load(&limits_path);
        let permission = McpPermission::load(&limits_path);
        Self {
            runtime: Arc::new(SshRuntime::new(data_dir).with_auto_trust_keys()),
            connections: AsyncRwLock::new(HashMap::new()),
            dbx_connections: AsyncRwLock::new(HashMap::new()),
            limits: RwLock::new(limits),
            permission: RwLock::new(permission),
            limits_path,
            global_read_only: env_read_only(),
            bridge_fallback: true,
        }
    }

    /// Wraps the workbench sidecar's shared runtime so `mcp/call` reuses the
    /// plugin's connection registry, known_hosts store, and settings.
    pub fn shared(runtime: Arc<SshRuntime>) -> Self {
        let limits_path = runtime.data_dir().join("mcp-settings.json");
        let limits = McpLimits::load(&limits_path);
        let permission = McpPermission::load(&limits_path);
        Self {
            runtime,
            connections: AsyncRwLock::new(HashMap::new()),
            dbx_connections: AsyncRwLock::new(HashMap::new()),
            limits: RwLock::new(limits),
            permission: RwLock::new(permission),
            limits_path,
            global_read_only: env_read_only(),
            bridge_fallback: true,
        }
    }

    /// Snapshot of the MCP size preferences (already clamped to ceilings).
    fn size_limits(&self) -> McpLimits {
        self.limits
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// `mcp/settings/get`: the effective MCP size preferences plus the
    /// §1.3 permission settings (env overrides applied, `persisted*` keys
    /// showing what a later env removal would restore).
    pub fn settings_get(&self) -> Value {
        let mut payload = self.size_limits().to_json();
        let (mode, scope) = self.effective_permission();
        if let Some(object) = payload.as_object_mut() {
            object.insert("execPermissionMode".to_string(), json!(mode));
            object.insert("connectionScope".to_string(), json!(scope.entries()));
            object.insert(
                "connectionScopeDenyAll".to_string(),
                json!(matches!(scope, ConnectionScope::DenyAll)),
            );
            let persisted = self
                .permission
                .read()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone();
            object.insert(
                "persistedExecPermissionMode".to_string(),
                json!(persisted.exec_permission_mode),
            );
            object.insert(
                "persistedConnectionScope".to_string(),
                json!(persisted.connection_scope),
            );
        }
        payload
    }

    /// `mcp/settings/set`: partial update with per-field validation
    /// (unsigned integers in `1..=ceiling` only), persisted to
    /// `mcp-settings.json`; returns the complete updated object. Every
    /// field is validated before anything is written — a rejected update
    /// must not touch the persisted file at all.
    pub fn settings_set(&self, updates: &Value) -> Result<Value, String> {
        let mut limits = self.size_limits();
        if let Some(value) = updates.get("maxReadBytes") {
            limits.max_read_bytes = validated_limit(value, "maxReadBytes", READ_LIMIT_CEILING)?;
        }
        if let Some(value) = updates.get("maxUploadBytes") {
            limits.max_upload_bytes =
                validated_limit(value, "maxUploadBytes", UPLOAD_LIMIT_CEILING)?;
        }
        if let Some(value) = updates.get("maxDownloadBytes") {
            limits.max_download_bytes =
                validated_limit(value, "maxDownloadBytes", DOWNLOAD_LIMIT_CEILING)?;
        }
        if let Some(value) = updates.get("localTransferRoot") {
            limits.local_transfer_root = validated_transfer_root(value)?;
        }
        limits = limits.sanitized();
        let mut permission = self
            .permission
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        if let Some(value) = updates.get("execPermissionMode") {
            permission.exec_permission_mode = value
                .as_str()
                .filter(|text| {
                    matches!(*text, PERMISSION_MODE_AUTONOMOUS | PERMISSION_MODE_CONFIRM)
                })
                .ok_or_else(|| {
                    format!(
                        "execPermissionMode must be \"{PERMISSION_MODE_AUTONOMOUS}\" or \
                         \"{PERMISSION_MODE_CONFIRM}\""
                    )
                })?
                .to_string();
        }
        if let Some(value) = updates.get("connectionScope") {
            let entries = value
                .as_array()
                .ok_or_else(|| "connectionScope must be an array of strings".to_string())?;
            let mut scope = Vec::new();
            for entry in entries {
                let text = entry
                    .as_str()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| {
                        "connectionScope entries must be non-empty strings".to_string()
                    })?;
                scope.push(text);
            }
            if scope.len() > CONNECTION_SCOPE_MAX_ENTRIES {
                return Err(format!(
                    "connectionScope is capped at {CONNECTION_SCOPE_MAX_ENTRIES} entries"
                ));
            }
            permission.connection_scope = scope;
        }
        // All validation passed: one merged write keeps both sections in
        // the single settings document (the size-limit writer used to
        // replace the file wholesale and drop the permission keys).
        write_settings_document(&self.limits_path, &limits, &permission)?;
        *self
            .limits
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = limits;
        *self
            .permission
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = permission;
        Ok(self.settings_get())
    }

    /// Effective (env-overridden) permission pair: `(mode, scope)`. The env
    /// vars win when present-and-valid; the persisted values apply
    /// otherwise.
    fn effective_permission(&self) -> (String, ConnectionScope) {
        let persisted = self
            .permission
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let mode = permission_mode_from_env(|key| std::env::var(key).ok())
            .unwrap_or(persisted.exec_permission_mode);
        let scope = scope_from_env(|key| std::env::var(key).ok())
            .unwrap_or_else(|| ConnectionScope::from_persisted(persisted.connection_scope));
        (mode, scope)
    }

    /// True when the call needs a human confirm challenge on top of the
    /// existing gates (§1.3 `confirm` mode + gated tool set).
    fn exec_confirm_required(&self, name: &str) -> bool {
        let (mode, _) = self.effective_permission();
        mode == PERMISSION_MODE_CONFIRM && is_confirm_gated_tool(name)
    }

    /// Effective scope for gate checks.
    fn effective_scope(&self) -> ConnectionScope {
        self.effective_permission().1
    }

    async fn dispatch(&self, request: Value) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        if method.starts_with("notifications/") {
            return None;
        }
        // Envelope validation (reliability round 5): a malformed request
        // envelope gets a structured -32600 instead of being silently
        // tolerated (wrong protocol version) or crashing on weird id
        // shapes. Notifications above stay silent regardless of envelope.
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(Self::invalid_request_envelope(
                id,
                "Invalid request: jsonrpc must be exactly \"2.0\"".to_string(),
            ));
        }
        if let Some(id) = &id {
            if !id.is_string() && !id.is_number() {
                return Some(Self::invalid_request_envelope(
                    None,
                    format!("Invalid request: id must be a string or number, got {id}"),
                ));
            }
        }
        if method.is_empty() {
            return Some(Self::invalid_request_envelope(
                id,
                "Invalid request: method must be a non-empty string".to_string(),
            ));
        }
        // JSON-RPC error tiering (family-wide with ldap/kafka/files): the
        // transport layer uses the standard codes — parse -32700, unknown
        // method -32601, invalid request -32600 — while tool-level errors
        // stay -32000 across all four plugins.
        let result: Result<Value, (i64, String)> = match method.as_str() {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    // 同族基线：完整插件 id（files/ldap/kafka 同款）。
                    "name": "io.dbx.ssh",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                // stdio mode has no event emitter: `runInTerminal` routing
                // goes through the DBX app's local TCP bridge inside
                // `ssh_exec_tool` (the None-emitter arm).
                self.call_tool(&name, &arguments, None)
                    .await
                    .map_err(|message| (-32000, message))
            }
            other => Err((-32601, format!("Method not found: {other}"))),
        };
        Some(match (id, result) {
            (Some(id), Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            (Some(id), Err((code, message))) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message },
            }),
            // A request without an id is invalid JSON-RPC; reply with a null id.
            (None, result) => Self::invalid_request_envelope(
                None,
                result
                    .err()
                    .map(|(_, message)| message)
                    .unwrap_or_else(|| "Invalid request".to_string()),
            ),
        })
    }

    /// Structured -32600 for a malformed request envelope: the id is echoed
    /// only when it is itself protocol-valid (string/number), otherwise
    /// nulled per JSON-RPC 2.0's invalid-request framing.
    fn invalid_request_envelope(id: Option<Value>, message: String) -> Value {
        let id = match id {
            Some(id) if id.is_string() || id.is_number() => id,
            _ => Value::Null,
        };
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32600, "message": message },
        })
    }

    /// Execution-plane audit (IMPL_PLAN §2): every gated tool call lands
    /// one ledger row with its verdict, exit code, and duration — the row
    /// the workbench audit view and `ssh/audit/list` replay. Gate refusals
    /// that return before the inner dispatch record `Pass` gates with the
    /// refusal error text (the verdict detail lives in `error`); approval
    /// lifecycle rows are separate (`audit_approval` in ssh.rs).
    async fn call_tool(
        &self,
        name: &str,
        arguments: &Value,
        emitter: Option<&PluginEmitter>,
    ) -> Result<Value, String> {
        if !is_confirm_gated_tool(name) {
            return self.call_tool_inner(name, arguments, emitter).await;
        }
        let started = std::time::Instant::now();
        let result = self.call_tool_inner(name, arguments, emitter).await;
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();
        let entry = audit_log::AuditEntry {
            ts_ms,
            tool: name.to_string(),
            connection_id: arguments
                .get("connectionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            gate: audit_log::GateOutcome::Pass,
            approval: audit_log::ApprovalTrail::None,
            outcome: if result.is_ok() {
                audit_log::EntryOutcome::Ok
            } else {
                audit_log::EntryOutcome::Error
            },
            exit_code: result
                .as_ref()
                .ok()
                .and_then(|value| value.get("exitCode"))
                .and_then(Value::as_i64),
            duration_ms: started.elapsed().as_millis() as u64,
            mode: if emitter.is_some() {
                audit_log::ExecMode::Embedded
            } else {
                audit_log::ExecMode::Stdio
            },
            // The exec family carries `command` in and returns `output` —
            // record both (clamped in audit_log::append) so the ledger replays
            // what ran and what it printed. Other gated tools simply carry no
            // such fields and stay null.
            command: arguments
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string),
            output: result
                .as_ref()
                .ok()
                .and_then(|value| value.get("output"))
                .and_then(Value::as_str)
                .map(str::to_string),
            error: result
                .as_ref()
                .err()
                .map(|error| error.chars().take(256).collect()),
        };
        if let Err(error) = audit_log::append(&self.runtime.data_dir(), &entry) {
            eprintln!("[mcp] audit append failed: {error}");
        }
        result
    }

    async fn call_tool_inner(
        &self,
        name: &str,
        arguments: &Value,
        emitter: Option<&PluginEmitter>,
    ) -> Result<Value, String> {
        // Cheapest local checks first: an unregistered tool name and a
        // malformed port must fail with an actionable error before any gate,
        // registry lookup, or dial. A malformed port must never silently
        // dial the default 22 instead of the requested one.
        if !is_known_tool(name) {
            return Err(unknown_tool_message(name));
        }
        arg_port(arguments)?;
        // Normalize a saved-connection reference before any gate or tool sees
        // it. This makes connectionName and unique host/port/username matches
        // equivalent to an explicit connectionId, including pool keys and
        // visible-terminal routing, while still rejecting ambiguity. The
        // resolved entry is kept alongside for the §1.3 scope gate.
        let resolved_ref = self.registered_connection_by_ref(arguments).await?;
        let normalized_arguments = resolved_ref.as_ref().map(|connection| {
            let mut normalized = arguments.clone();
            if let Some(map) = normalized.as_object_mut() {
                map.insert("connectionId".to_string(), json!(connection.id));
            }
            normalized
        });
        let arguments = normalized_arguments
            .as_ref()
            .map_or(arguments, |normalized| normalized as &Value);
        // §1.3 scope gate: while `connectionScope` is non-empty, every
        // connection-class tool must resolve to an in-scope saved entry.
        // Inline credentials (endpoint selectors) have no registry identity
        // and are refused outright — fail closed, so a pinned scope cannot
        // be widened by dialing around the registry.
        {
            let scope = self.effective_scope();
            if scope.is_active() && is_connection_scoped_tool(name) {
                match resolved_ref.as_ref() {
                    Some(connection) => {
                        if !scope.allows(
                            &connection.id,
                            connection.name.as_deref(),
                            &connection.host,
                        ) {
                            return Err(format!(
                                "Connection '{}' ({} / {}) is outside this MCP server's \
                                 connectionScope; ask the operator to widen the scope or \
                                 pick an in-scope connection",
                                connection.id, connection.host, connection.username
                            ));
                        }
                    }
                    None => {
                        return Err(
                            "connectionScope is active on this MCP server: inline-credential \
                             calls are refused. Pass a saved connectionId/connectionName that \
                             is inside the scope (see ssh_list_connections)"
                                .to_string(),
                        );
                    }
                }
            }
        }
        // Safety gates, ordered cheapest-first and all evaluated before any
        // network I/O:
        // 1. Read-only gate: write-class tools are rejected when the DBX
        //    connection they reference was opened read-only (mirroring the
        //    workbench `ensure_writable` gate) or the operator forced the
        //    whole server read-only via DBX_SSH_MCP_READ_ONLY.
        // 2. Read-only command whitelist: `ssh_exec` stays available on
        //    read-only connections, but only for provably read-only
        //    commands (ls, df, systemctl status, ...).
        // 3. Sensitive-path denylist: on read-only connections even
        //    whitelisted inspection tools may not touch credential/key paths
        //    (~/.ssh, /etc/shadow, .env, *.pem, ...) — the exfiltration
        //    channel the command whitelist cannot see for SFTP tools.
        // 4. Destructive-command confirmation: recognized catastrophic
        //    patterns require an explicit confirmDestructive: true on every
        //    connection (and are refused outright on read-only ones).
        let read_only = self.connection_is_read_only(arguments).await;
        if is_write_tool(name) && read_only {
            return Err(format!(
                "Tool {name} is a write operation and the connection is read-only"
            ));
        }
        if read_only {
            if let Some(path) = sensitive_read_path(name, arguments) {
                return Err(format!(
                    "Tool {name} reads the sensitive path {path}; refused on read-only \
                     connections"
                ));
            }
        }
        if matches!(name, "ssh_exec" | "ssh_exec_sudo" | "ssh_run_bg") {
            let command = required_str(arguments, "command")?;
            // Per-connection sudoers-style allowlist: privileged commands
            // must match a `sudo_whitelist` entry when the connection
            // declares one. Covers `ssh_exec_sudo` plus inline `sudo …` in
            // `ssh_exec`/`ssh_run_bg` (NOPASSWD / cached-stamp bypasses).
            if name == "ssh_exec_sudo" || mcp_safety::runs_under_sudo(command) {
                let allowlist = self.sudo_allowlist_for(arguments).await?;
                if !allowlist.is_empty() && !sudo_allowlist::is_allowed(&allowlist, command) {
                    return Err(format!(
                        "sudo command is not allowed by this connection's whitelist. \
                         Allowed patterns: {}",
                        sudo_allowlist::render_entries(&allowlist)
                    ));
                }
            }
            match mcp_safety::assess_command(command) {
                CommandRisk::Destructive(reason) if read_only => {
                    return Err(format!(
                        "Refused on read-only connection ({reason}): {command}"
                    ));
                }
                CommandRisk::Destructive(reason) => {
                    let confirmed = arg_bool(arguments, "confirmDestructive")?.unwrap_or(false);
                    if !confirmed {
                        return Err(format!(
                            "Command looks destructive ({reason}): {command}. \
                             Retry with confirmDestructive: true if this is intended."
                        ));
                    }
                }
                CommandRisk::Unknown if name == "ssh_exec" && read_only => {
                    return Err(format!(
                        "Connection is read-only and the command is not recognized \
                         as read-only: {command}. Only inspection commands (ls, cat, \
                         df, ps, systemctl status, journalctl, docker ps, ...) pass."
                    ));
                }
                _ => {}
            }
        }
        if name == "ssh_terminal_input" {
            // §1.2 gates run on the normalized text (the same text that will
            // be typed), so normalization happens here once and the handler
            // reuses the normalized form by re-deriving it from `input`.
            let input = required_str(arguments, "input")?;
            let normalized = mcp_safety::normalize_terminal_input(input);
            let allowlist = self.sudo_allowlist_for(arguments).await?;
            terminal_input_gate(
                &normalized,
                read_only,
                arg_bool(arguments, "confirmDestructive")?.unwrap_or(false),
                &allowlist,
            )?;
        }
        // §1.3 confirm permission mode: after every existing gate, before
        // any execution path (the L1 bridge forward included), a gated tool
        // must carry a human approval. Fail-closed without an emitter: a
        // stdio standalone session has no approval channel, so the call
        // errors immediately instead of hanging on the 120s timeout.
        let mut confirmed_arguments: Option<Value> = None;
        if self.exec_confirm_required(name) {
            let Some(emitter) = emitter else {
                return Err(format!(
                    "Tool {name} requires approval under execPermissionMode=confirm, but \
                     this MCP session has no approval channel (stdio standalone mode). \
                     Switch the mode back to autonomous (mcp/settings/set) or run the \
                     server inside the DBX workbench session."
                ));
            };
            let command_key = if name == "ssh_terminal_input" {
                "input"
            } else {
                "command"
            };
            // docker_action carries no `command` argument: derive the exact
            // approval text (`docker rm <id>`) from the validated action so
            // the dialog shows precisely what will run, and a malformed
            // id/action fails here instead of after approval.
            let command: String = if name == "docker_action" {
                let container_id = required_str(arguments, "containerId")?;
                docker::validate_container_id(container_id)?;
                let action = docker::parse_action(required_str(arguments, "action")?)?;
                docker::action_command(action, container_id)
            } else {
                required_str(arguments, command_key)?.to_string()
            };
            let connection_id = arguments.get("connectionId").and_then(Value::as_str);
            let approved = self
                .runtime
                .request_mcp_confirm(name, &command, connection_id, emitter)
                .await?;
            // docker_action is intentionally structured: its canonical text
            // is evidence for the action/container pair, not an alternate
            // shell input. Refuse edits instead of displaying one action and
            // executing another.
            if name == "docker_action" && approved != command {
                return Err(
                    "Docker action confirmation text is not editable; approve the displayed canonical command or cancel"
                        .to_string(),
                );
            }
            // Other command-based tools retain the existing editable approval
            // contract: the approved text replaces the original execution
            // input.
            if approved != command {
                let mut rewritten = arguments.clone();
                if let Some(map) = rewritten.as_object_mut() {
                    map.insert(command_key.to_string(), json!(approved));
                }
                confirmed_arguments = Some(rewritten);
            }
        }
        let arguments = confirmed_arguments.as_ref().unwrap_or(arguments);
        // L1 stdio bridge fallback: a call referencing a `connectionId` that
        // is NOT in this session's lifecycle registry (the normal state of a
        // standalone `--mcp` session) is forwarded to the running DBX app's
        // own sidecar through the local TCP bridge, so saved connections work
        // without inline credentials and credentials never travel in tool
        // arguments. Gate semantics across the forward: the local gates above
        // stay in front of it (the DBX_SSH_MCP_READ_ONLY kill switch and the
        // command-text checks are arguments-only and must not be dodged),
        // while the registry-metadata gates (per-connection read-only flag,
        // sudo whitelist) cannot resolve here by definition — the app-side
        // sidecar enforces them against its own lifecycle registration.
        if emitter.is_none() {
            if let Some((connection_id, forwarded)) =
                self.bridge_forward_plan(name, arguments).await?
            {
                if let Ok(result) = self
                    .forward_tool_via_bridge(name, &connection_id, &forwarded)
                    .await
                {
                    return Ok(result);
                }
                // Bridge unreachable or refused (app down, unwakeable, older
                // app): fall through to the inline path so the original
                // guidance error — now carrying the self-heal hints — is
                // what the caller sees.
            }
        }
        let text = self.run_tool(name, arguments, emitter).await?;
        // The app-bridge forward returns the app's MCP content envelope
        // verbatim (`app_bridge::call_plugin_tool`); wrapping again would
        // bury the app's answer one JSON level deeper, so an already
        // enveloped result passes through untouched.
        if text.get("content").is_some() && text.get("isError").is_some() {
            return Ok(text);
        }
        Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&text).unwrap_or_default() }],
            "isError": false,
        }))
    }

    /// True when the call must pass the read-only gates: either the DBX
    /// connection it references was registered read-only, or the operator
    /// flipped the process-wide `DBX_SSH_MCP_READ_ONLY` kill switch.
    async fn connection_is_read_only(&self, arguments: &Value) -> bool {
        self.global_read_only || self.registered_connection_is_read_only(arguments).await
    }

    /// Resolves a saved connection reference without making the caller carry
    /// an opaque id. Exact `connectionId` wins, then an exact display name,
    /// then a unique endpoint (`host` + `username`, with port defaulting to
    /// 22). Endpoint fields narrow a name match when both are supplied. Any
    /// ambiguity is an error; a miss returns `None` so inline credentials and
    /// the stdio bridge fallback retain their existing behavior.
    async fn registered_connection_by_ref(
        &self,
        arguments: &Value,
    ) -> Result<Option<StoredConnection>, String> {
        let id = non_empty_argument(arguments, "connectionId");
        let name = non_empty_argument(arguments, "connectionName");
        let endpoint = endpoint_selector(arguments);
        if id.is_none() && name.is_none() && endpoint.is_none() {
            return Ok(None);
        }
        let registry = self.dbx_connections.read().await;

        if let Some(id) = id {
            if let Some(connection) = registry.get(id) {
                if !connection_matches_selectors(connection, name, endpoint.as_ref()) {
                    return Err(format!(
                        "connectionId '{id}' does not match the supplied connectionName/host/port/username"
                    ));
                }
                return Ok(Some(connection.clone()));
            }
            // Preserve the existing self-heal behavior for a stale id when a
            // second selector can still identify the saved connection.
            if name.is_none() && endpoint.is_none() {
                return Ok(None);
            }
        }

        let candidates: Vec<&StoredConnection> = registry
            .values()
            .filter(|connection| connection_matches_selectors(connection, name, endpoint.as_ref()))
            .collect();
        match candidates.len() {
            0 => Ok(None),
            1 => Ok(Some(candidates[0].clone())),
            _ => {
                let selector = name
                    .map(|value| format!("connection name '{value}'"))
                    .or_else(|| endpoint.as_ref().map(endpoint_selector_label))
                    .unwrap_or_else(|| "connection selectors".to_string());
                Err(format!(
                    "{selector} is ambiguous: {}; pass connectionId instead",
                    render_connection_candidates(&candidates)
                ))
            }
        }
    }

    /// True when the arguments reference a DBX-registered connection that was
    /// registered as read-only through `mcp/call` lifecycle payloads.
    ///
    /// Without a resolvable reference the gate falls back to endpoint
    /// identity (host + port + username): keying read-only by connectionId
    /// alone would let a caller walk around a read-only registration by
    /// re-dialing the same host with inline credentials.
    async fn registered_connection_is_read_only(&self, arguments: &Value) -> bool {
        match self.registered_connection_by_ref(arguments).await {
            Ok(Some(connection)) => connection.read_only,
            // Ambiguous connectionName: conservatively read-only; the
            // disambiguation error with every candidate surfaces from the
            // execution path.
            Err(_) => true,
            Ok(None) => self.inline_dial_is_registered_read_only(arguments).await,
        }
    }
    /// True when the inline dial arguments (host/port/username) identify the
    /// same endpoint as a DBX-registered read-only connection.
    async fn inline_dial_is_registered_read_only(&self, arguments: &Value) -> bool {
        self.registered_connection_matching_inline(arguments)
            .await
            .is_some_and(|connection| connection.read_only)
    }

    /// Finds a lifecycle-registered connection whose endpoint identity
    /// (host + port + username) matches the inline dial arguments. The port
    /// defaults to 22 on both sides; host comparison is ASCII-case-insensitive.
    async fn registered_connection_matching_inline(
        &self,
        arguments: &Value,
    ) -> Option<StoredConnection> {
        let host = arguments
            .get("host")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        let port = arg_port_lossy(arguments);
        let username = arguments
            .get("username")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        self.dbx_connections
            .read()
            .await
            .values()
            .find(|connection| {
                connection.host.trim().eq_ignore_ascii_case(host)
                    && connection.port == port
                    && connection.username == username
            })
            .cloned()
    }

    /// Resolves the connection's sudoers-style allowlist: by `connectionId`
    /// (or `connectionName`) through the lifecycle registry, else by inline
    /// endpoint identity (the same fallback as the read-only gate, so
    /// re-dialing a whitelisted host with inline credentials cannot skip the
    /// list). Empty = not configured. An ambiguous connectionName is an
    /// error, not a silent gate-off.
    async fn sudo_allowlist_for(&self, arguments: &Value) -> Result<Vec<Vec<String>>, String> {
        Ok(match self.registered_connection_by_ref(arguments).await? {
            Some(connection) => {
                if !connection.sudo_whitelist.is_empty() {
                    sudo_allowlist::entries_from_lines(&connection.sudo_whitelist)
                } else {
                    Default::default()
                }
            }
            None => self
                .registered_connection_matching_inline(arguments)
                .await
                .and_then(|connection| {
                    (!connection.sudo_whitelist.is_empty())
                        .then(|| sudo_allowlist::entries_from_lines(&connection.sudo_whitelist))
                })
                .unwrap_or_default(),
        })
    }

    /// L1 stdio bridge fallback decision: `Ok(Some((connection_id,
    /// arguments)))` when the call must be forwarded through the DBX app
    /// bridge, `Ok(None)` when the local path owns the call (registered
    /// reference, no connection reference, local-only tool, runInTerminal
    /// routing, or a name the bridge list cannot resolve — the inline path
    /// then raises its own guidance error), `Err` for an actionable
    /// disambiguation failure from the bridge list.
    async fn bridge_forward_plan(
        &self,
        name: &str,
        arguments: &Value,
    ) -> Result<Option<(String, Value)>, String> {
        if !self.bridge_fallback || !is_connection_bound_tool(name) {
            return Ok(None);
        }
        // runInTerminal routing already owns its own bridge forward
        // (`ssh_exec_app_bridge`), which never required a registry entry;
        // keep that path exclusive so a down bridge cannot stack two
        // sequential wake-and-wait attempts. A malformed value cannot reach
        // here (call_tool validated the arguments' port only; be lossy).
        if arg_bool(arguments, "runInTerminal").unwrap_or(None) == Some(true) {
            return Ok(None);
        }
        if let Some(id) = arguments
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let registered = self.dbx_connections.read().await.contains_key(id);
            // Registered: the local path runs unchanged (embedded-bridge
            // semantics). Unregistered: forward as-is — the app-side sidecar
            // holds the connection's credentials, read-only flag, and sudo
            // whitelist, and answers with its own MCP envelope.
            return Ok((!registered).then(|| (id.to_string(), arguments.clone())));
        }
        if arguments.get("connectionName").is_none() && endpoint_selector(arguments).is_none() {
            return Ok(None);
        }
        // A registry hit (unique or ambiguous) stays local — the same
        // resolver reports ambiguity with all candidates. Only a stdio
        // session with no registry entry needs the bridge list to resolve
        // the selector to an id before forwarding.
        match self.registered_connection_by_ref(arguments).await {
            Ok(Some(_)) | Err(_) => Ok(None),
            Ok(None) => match self.resolve_connection_via_bridge(arguments).await {
                Ok(id) => {
                    let mut forwarded = arguments.clone();
                    if let Some(map) = forwarded.as_object_mut() {
                        map.insert("connectionId".to_string(), json!(id.clone()));
                    }
                    Ok(Some((id, forwarded)))
                }
                // Bridge list unavailable or selector not found: fall
                // through so the inline path reports the normal guidance.
                Err(_) => Ok(None),
            },
        }
    }

    /// stdio connection resolution: reads the bridge list (no app wake-up —
    /// a down bridge simply fails the resolution and the call degrades) and
    /// applies the same exact-name / unique-endpoint rules as the lifecycle
    /// registry.
    async fn resolve_connection_via_bridge(&self, arguments: &Value) -> Result<String, String> {
        let entries = app_bridge::list_plugin_connections().await?;
        resolve_connection_in_bridge_list(&entries, arguments)
    }

    /// Forwards one connection-bound tool call through the DBX app bridge
    /// (L1). Same wake-and-verify contract as `ssh_exec_app_bridge`; the
    /// tool timeout follows the `timeoutSecs` argument with the same 5–300s
    /// clamp ssh_exec applies. The 200 body is the app's MCP content
    /// envelope and is returned verbatim.
    async fn forward_tool_via_bridge(
        &self,
        name: &str,
        connection_id: &str,
        arguments: &Value,
    ) -> Result<Value, String> {
        app_bridge::ensure_app_bridge(app_bridge::DEFAULT_ENSURE_WAIT).await?;
        let timeout_secs = arg_u64(arguments, "timeoutSecs")
            .ok()
            .flatten()
            .map(|secs| secs.clamp(5, 300))
            .unwrap_or(300);
        app_bridge::call_plugin_tool(
            connection_id,
            name,
            arguments.clone(),
            Duration::from_secs(timeout_secs),
        )
        .await
    }

    /// `ssh_list_connections`: saved-connection discovery for stdio agents.
    /// The bridge list comes first (metadata only — the app never returns
    /// credentials), merged with this session's lifecycle registry
    /// (deduplicated by id; registry entries may add credential-presence
    /// flags because they carry the secrets). A bridge that answers nothing
    /// (app down, or an older app without the /list-plugin-connections
    /// route) degrades to the registry alone plus an upgrade note instead of
    /// failing.
    async fn ssh_list_connections_tool(&self) -> Result<Value, String> {
        let registry: Vec<StoredConnection> = self
            .dbx_connections
            .read()
            .await
            .values()
            .cloned()
            .collect();
        let bridge = app_bridge::list_plugin_connections().await;
        let scope = self.effective_scope();
        Ok(connection_list_result(bridge, &registry, &scope))
    }

    async fn run_tool(
        &self,
        name: &str,
        arguments: &Value,
        emitter: Option<&PluginEmitter>,
    ) -> Result<Value, String> {
        match name {
            "ssh_close" => self.ssh_close(arguments).await,
            // Local↔remote transfers validate their local side before any
            // connection I/O; validation refusals must keep the pooled
            // connection (they are not transport failures), so these tools
            // own their drop-on-transport-error semantics instead of the
            // blanket cleanup below.
            "sftp_upload" => self.sftp_upload_tool(arguments).await,
            "sftp_download" => self.sftp_download_tool(arguments).await,
            // Global Quick Sudo profile management: local config reads and
            // writes through the shared runtime store (not remote writes, so
            // these stay outside the read-only tool gate).
            "ssh_quick_sudo_profiles_list" => Ok(self.runtime.profiles_list()),
            "ssh_quick_sudo_profiles_save" => self.runtime.profiles_save(arguments).await,
            "ssh_quick_sudo_profiles_delete" => {
                let id = required_str(arguments, "id")?;
                self.runtime.profiles_delete(id).await
            }
            "ssh_test_connection" => {
                // Saved-connection addressing first: a registry reference
                // (embedded bridge or a normalized stdio call) dials with the
                // stored credentials; inline credentials stay the fallback
                // for standalone --mcp sessions. An unregistered stdio
                // reference never reaches here — it is forwarded through the
                // app bridge (is_connection_bound_tool) before this arm runs.
                let connection = match self.registered_connection_by_ref(arguments).await? {
                    Some(connection) => connection,
                    None => stored_connection_from_arguments(arguments).map_err(|error| {
                        // A reference the local session cannot resolve (no
                        // registry entry, bridge down) must keep the self-heal
                        // path visible instead of the bare "missing host".
                        let has_reference = non_empty_argument(arguments, "connectionId").is_some()
                            || non_empty_argument(arguments, "connectionName").is_some()
                            || endpoint_selector(arguments).is_some();
                        if has_reference {
                            format!(
                                "{error}. The saved connection could not be resolved in this \
                                 session: start the DBX app (its sidecar holds the credentials), \
                                 list saved connections with ssh_list_connections, or provide \
                                 inline credentials (host/username plus password or \
                                 privateKeyPath/privateKeyContent)."
                            )
                        } else {
                            error
                        }
                    })?,
                };
                let started = std::time::Instant::now();
                let (handle, jumps) = self.runtime.connect_headless(&connection).await?;
                let latency_ms = started.elapsed().as_millis() as u64;
                let _ = handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "MCP connection test complete",
                        "English",
                    )
                    .await;
                for jump in jumps {
                    let _ = jump
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "MCP jump connection closed",
                            "English",
                        )
                        .await;
                }
                Ok(json!({
                    "ok": true,
                    "host": connection.host,
                    "port": connection.port,
                    "username": connection.username,
                    "latencyMs": latency_ms,
                }))
            }
            "ssh_list_known_hosts" => {
                let verifier = HostKeyVerifier::new(self.runtime.known_hosts_path());
                let entries: Vec<Value> = verifier
                    .list_known_hosts()?
                    .into_iter()
                    .map(|entry| {
                        json!({
                            "hostField": entry.host_field,
                            "keyType": entry.key_type,
                            "fingerprint": entry.fingerprint,
                            "comment": entry.comment,
                        })
                    })
                    .collect();
                Ok(json!({ "knownHosts": entries }))
            }
            "ssh_list_connections" => self.ssh_list_connections_tool().await,
            "ssh_remove_known_host" => {
                let host = required_str(arguments, "host")?;
                let port = arg_port(arguments)?;
                let verifier = HostKeyVerifier::new(self.runtime.known_hosts_path());
                let removed = verifier.remove_known_host(host, port)?;
                Ok(json!({ "host": host, "port": port, "removed": removed }))
            }
            "ssh_alert_triage" => {
                // Offline intent recognition: the raw alert payload is
                // normalized and classified without any SSH I/O, so the
                // playbook can run before an operator even picks a host.
                let payload = required_str(arguments, "payload")?;
                Ok(alert_triage::triage_view(&alert_triage::triage(payload)))
            }
            _ => {
                let mut result = match name {
                    "ssh_exec" | "ssh_exec_sudo" => {
                        self.ssh_exec_tool(name, arguments, emitter).await
                    }
                    "ssh_run_bg" => self.ssh_run_bg_tool(arguments).await,
                    "ssh_terminal_input" => self.ssh_terminal_input_tool(arguments).await,
                    "ssh_multi_exec" => self.ssh_multi_exec_tool(arguments).await,
                    "ssh_task_status" => self.ssh_task_status_tool(arguments).await,
                    "ssh_metrics" => {
                        // Section names are validated before dialing so a
                        // typo fails fast without a connection round-trip.
                        let sections = metrics_sections(arguments)?;
                        let connection = self.connection(arguments).await?;
                        let mut metrics = exec::collect_metrics(&connection).await?;
                        if let Some(sections) = &sections {
                            exec::project_metrics_sections(&mut metrics, sections)?;
                        }
                        Ok(metrics)
                    }
                    "sftp_disk_usage" => {
                        let path = required_str(arguments, "path")?;
                        let connection = self.connection(arguments).await?;
                        let command = format!("df -kP {}", exec::shell_quote(path));
                        // Plugin-internal plumbing: no client setEnv, keeping
                        // the df output parseable regardless of locale overrides.
                        let outcome =
                            exec::exec_plain(&connection, &command, Duration::from_secs(20), &[])
                                .await?;
                        exec::parse_disk_usage(&outcome.output).ok_or_else(|| {
                            format!("Could not parse disk usage: {}", outcome.output)
                        })
                    }
                    "docker_list" => {
                        // Read-only collection on the pooled connection; the
                        // probe degrades to available:false instead of erroring.
                        let connection = self.connection(arguments).await?;
                        docker::collect_list(&connection).await
                    }
                    "docker_action" => {
                        // Validation before any connection I/O (same
                        // fail-fast shape as metrics_sections).
                        let container_id = required_str(arguments, "containerId")?;
                        docker::validate_container_id(container_id)?;
                        let action = docker::parse_action(required_str(arguments, "action")?)?;
                        let connection = self.connection(arguments).await?;
                        // Quick Sudo credentials resolve up front from local
                        // sources only (registry + profile store); a resolution
                        // failure degrades to None and the fallback surfaces
                        // the configuration guidance. No password argument
                        // exists on this tool by contract.
                        let stored = self
                            .registered_connection_by_ref(arguments)
                            .await
                            .ok()
                            .flatten();
                        let sudo_auth = self.resolve_sudo_auth(arguments, None, stored).await.ok();
                        docker::perform_action(
                            &connection,
                            sudo_auth.as_ref(),
                            false,
                            container_id,
                            action,
                        )
                        .await
                    }
                    other => self.sftp_tool(other, arguments).await,
                };
                if result.is_err() {
                    // Drop the cached connection on failure so the next call
                    // reconnects with fresh credentials instead of reusing a
                    // broken transport.
                    self.drop_connection(arguments).await;
                    // Flapping-network recovery: when the pooled transport
                    // died BEFORE the remote command could start (channel
                    // open/exec refused on a dead connection), retry once on
                    // the fresh connection. Pre-exec failures cannot
                    // double-execute the command; post-exec transport deaths
                    // stay terminal because the command may already have run.
                    if matches!(name, "ssh_exec" | "ssh_exec_sudo" | "ssh_run_bg") {
                        let retryable = result
                            .as_ref()
                            .err()
                            .map(|error| exec::is_pre_exec_transport_error(error))
                            .unwrap_or(false);
                        if retryable {
                            result = match name {
                                "ssh_exec" | "ssh_exec_sudo" => {
                                    self.ssh_exec_tool(name, arguments, emitter).await
                                }
                                _ => self.ssh_run_bg_tool(arguments).await,
                            };
                        }
                    }
                }
                result
            }
        }
    }

    async fn ssh_exec_tool(
        &self,
        name: &str,
        arguments: &Value,
        emitter: Option<&PluginEmitter>,
    ) -> Result<Value, String> {
        let command = required_str(arguments, "command")?;
        let timeout_secs =
            arg_u64(arguments, "timeoutSecs")?.map(|secs| Duration::from_secs(secs.clamp(5, 300)));
        // A quickSudoProfile reference is resolved (and validated) before any
        // connection I/O so unknown ids/names fail fast.
        let sudo_profile = if name == "ssh_exec_sudo" {
            let store = sudo_profiles::load_store(&self.runtime.data_dir());
            resolve_profile_reference(&store, arguments)?
        } else {
            None
        };
        // Agent terminal routing (agent terminal mode plan §1): only the DBX
        // embedded bridge carries an emitter plus a lifecycle connectionId;
        // every other caller stays on the hidden exec channel below.
        let run_in_terminal = arg_bool(arguments, "runInTerminal")?;
        let connection_id = arguments
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        match (emitter, connection_id) {
            (Some(emitter), Some(connection_id)) => {
                let mode = self.runtime.agent_terminal_mode(connection_id);
                // An explicit runInTerminal wins; the connection mode decides
                // when it is absent. Off keeps the existing path untouched.
                let route = run_in_terminal.unwrap_or(mode != AgentTerminalMode::Off);
                if route {
                    // Whether the agent explicitly opted into the visible
                    // terminal decides the `off` + elevated matrix cell
                    // (approve with explicit opt-in, deny without it).
                    let explicit = run_in_terminal == Some(true);
                    return self
                        .ssh_exec_terminal_tool(
                            name,
                            command,
                            connection_id,
                            explicit,
                            timeout_secs,
                            emitter,
                        )
                        .await;
                }
            }
            (None, _) if run_in_terminal == Some(true) => {
                // stdio mode forwards through the DBX app's local TCP bridge:
                // the app opens the connection's workbench tab and runs the
                // tool on its own sidecar, so the command lands in the app's
                // visible terminal.
                let Some(connection_id) = connection_id else {
                    return Err(
                        "runInTerminal needs a saved DBX connection: pass connectionId (the connection must exist in the DBX app) so the command can run in the app's visible terminal. Saved connection ids can be listed with ssh_list_connections."
                            .to_string(),
                    );
                };
                return self
                    .ssh_exec_app_bridge(name, connection_id, arguments, timeout_secs)
                    .await;
            }
            (Some(_), None) if run_in_terminal == Some(true) => {
                return Err(
                    "runInTerminal requires a lifecycle connectionId from the DBX embedded bridge. Saved connection ids can be listed with ssh_list_connections."
                        .to_string(),
                );
            }
            _ => {}
        }
        // Saved DBX connections declare their Quick Sudo source (form field
        // sudo_source); the hidden exec channel honors it exactly like the
        // workbench instead of requiring inline credentials on every call.
        // The unified lookup also honors connectionName and endpoint
        // selectors; an ambiguous reference is rejected before dialing.
        let stored = self
            .registered_connection_by_ref(arguments)
            .await
            .ok()
            .flatten();
        // The hidden exec channel carries the saved connection's setEnv too,
        // matching the workbench exec path.
        let set_env = stored
            .as_ref()
            .map(|connection| connection.set_env.clone())
            .unwrap_or_default();
        if name == "ssh_exec_sudo" {
            let auth = self
                .resolve_sudo_auth(arguments, sudo_profile, stored)
                .await?;
            // The hidden exec channel stays TTY-less on purpose: with a PTY,
            // each PAM factor read flushes typed-ahead input, so piped
            // credentials race an unknowable per-host timing; without one,
            // stdin is a plain pipe and `exec_with_sudo` queues password and
            // OTP deterministically.
            let connection = self.connection(arguments).await?;
            exec::exec_with_sudo(
                &connection,
                &auth,
                command,
                timeout_secs.unwrap_or(exec::SUDO_EXEC_TIMEOUT),
                false,
                &set_env,
            )
            .await
            .map(|outcome| json!({ "output": outcome.output, "exitCode": outcome.exit_code }))
        } else {
            let connection = self.connection(arguments).await?;
            exec::exec_plain(
                &connection,
                command,
                timeout_secs.unwrap_or(exec::PLAIN_EXEC_TIMEOUT),
                &set_env,
            )
            .await
            .map(|outcome| json!({ "output": outcome.output, "exitCode": outcome.exit_code }))
        }
    }

    /// `ssh_run_bg`: stages a long-running command detached on the remote
    /// host (nohup, output appended to `/tmp/.dbx-ssh-tasks/<taskId>.log`)
    /// and returns immediately. The server-side log file is the task's
    /// durable record: status polling reattaches over a fresh connection, so
    /// flapping networks, disconnects, and MCP-host wait caps never lose
    /// output or kill the job.
    async fn ssh_run_bg_tool(&self, arguments: &Value) -> Result<Value, String> {
        let command = required_str(arguments, "command")?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        let task_id = format!("bg-{stamp}-{}", std::process::id() % 100_000);
        // Single-quote escape for embedding inside the remote `sh -c '...'`.
        let escaped = command.replace('\'', "'\\''");
        let remote = format!(
            "d=/tmp/.dbx-ssh-tasks; mkdir -p \"$d\" || exit 3; f=\"$d/{task_id}.log\"; : > \"$f\"; \
             nohup sh -c '{escaped}; s=$?; echo EXIT_$s' >> \"$f\" 2>&1 & p=$!; \
             echo \"$p\" > \"$f.pid\"; echo \"PID=$p\"; echo \"LOG=$f\""
        );
        let connection = self.connection(arguments).await?;
        // Internal staging wrapper: env-free so the wrapper's own output
        // stays parseable; the user command inherits the server defaults.
        let outcome = exec::exec_plain(&connection, &remote, Duration::from_secs(15), &[]).await?;
        if outcome.exit_code != 0 {
            return Err(format!(
                "Failed to stage background task (exit {}): {}",
                outcome.exit_code, outcome.output
            ));
        }
        let default_log = format!("/tmp/.dbx-ssh-tasks/{task_id}.log");
        let (pid, log_path) = parse_bg_start_output(&outcome.output, default_log);
        Ok(json!({
            "taskId": task_id,
            "pid": pid,
            "logPath": log_path,
            "pollWith": "ssh_task_status",
            "note": "Running detached (nohup). Poll ssh_task_status(logPath); output survives disconnects and session restarts.",
        }))
    }

    /// `ssh_task_status`: polls a task started by `ssh_run_bg` through its
    /// server-side log file. Works across disconnects and from later
    /// sessions because the log lives on the remote host, not in this MCP
    /// session.
    async fn ssh_task_status_tool(&self, arguments: &Value) -> Result<Value, String> {
        let log_path = required_str(arguments, "logPath")?;
        let tail_bytes = arg_u64(arguments, "tailBytes")?
            .unwrap_or(4_000)
            .clamp(200, 16_000);
        let quoted = exec::shell_quote(log_path);
        let remote = format!(
            "f={quoted}; if [ ! -f \"$f\" ]; then echo STATE=MISSING; exit 0; fi; \
             if grep -q '^EXIT_[0-9][0-9]*$' \"$f\" 2>/dev/null; then \
               echo STATE=DONE; echo CODE=$(grep -o '^EXIT_[0-9][0-9]*$' \"$f\" | tail -1); \
             else echo STATE=RUNNING; fi; \
             pf=\"$f.pid\"; if [ -f \"$pf\" ]; then p=$(cat \"$pf\"); \
               kill -0 \"$p\" 2>/dev/null && echo PID_ALIVE=yes || echo PID_ALIVE=no; fi; \
             echo ===TAIL===; tail -c {tail_bytes} \"$f\""
        );
        let connection = self.connection(arguments).await?;
        let outcome = exec::exec_plain(&connection, &remote, Duration::from_secs(15), &[]).await?;
        if outcome.exit_code != 0 {
            return Err(format!(
                "Failed to read task status (exit {}): {}",
                outcome.exit_code, outcome.output
            ));
        }
        let (state, exit_code, pid_alive, tail) = parse_task_status_output(&outcome.output);
        Ok(json!({
            "state": state,
            "exitCode": exit_code,
            "pidAlive": pid_alive,
            "output": tail.trim_end(),
            "logPath": log_path,
            "done": state == "done",
        }))
    }

    /// `ssh_exec_sudo` credential resolution for the hidden exec channel:
    /// explicit per-call arguments always win; otherwise a saved DBX
    /// connection's declared sudo source applies (Global: its form profile
    /// reference / workbench binding, Custom: the connection's secret-bound
    /// sudo configuration, Off: refuse unless the caller passed explicit
    /// credentials), mirroring the workbench exec gate; the per-call
    /// `quickSudoProfile` reference replaces the connection's declared
    /// global profile.
    async fn resolve_sudo_auth(
        &self,
        arguments: &Value,
        explicit_profile: Option<sudo_profiles::SudoProfile>,
        stored: Option<StoredConnection>,
    ) -> Result<SudoAuth, String> {
        let has_explicit_credentials = ["sudoPassword", "totpSecret"].iter().any(|key| {
            arguments
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        });
        if let Some(stored) = &stored {
            if stored.sudo_source == SudoSource::Off && !has_explicit_credentials {
                return Err("Quick Sudo is disabled for this connection".to_string());
            }
        }
        let store = sudo_profiles::load_store(&self.runtime.data_dir());
        let profile = match explicit_profile {
            Some(profile) => Some(profile),
            None => stored
                .as_ref()
                .and_then(|stored| crate::ssh::effective_sudo_profile(stored, &store)),
        };
        let mut auth = match (&stored, &profile) {
            (Some(stored), profile) => crate::ssh::resolved_sudo_auth(stored, profile.as_ref()),
            (None, Some(profile)) => {
                let mut auth = sudo_auth(arguments);
                apply_profile_fallbacks(&mut auth, profile);
                auth
            }
            (None, None) => sudo_auth(arguments),
        };
        apply_explicit_argument_overrides(&mut auth, arguments);
        Ok(auth)
    }

    /// Terminal-routed `ssh_exec` / `ssh_exec_sudo`: resolves the
    /// connection's live workbench PTY, applies the §1 approval matrix
    /// (sudo and catastrophic mcp_safety hits are elevated), then types the
    /// command into the terminal and captures the output.
    /// Polls `session_id_for_connection` until the workbench PTY shows up or
    /// `wait` elapses, so a just-triggered workbench auto-open can win the
    /// race against the first terminal-routed command.
    async fn wait_for_connection_session(
        &self,
        connection_id: &str,
        wait: Duration,
    ) -> Result<String, String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match self.runtime.session_id_for_connection(connection_id).await {
                Ok(session_id) => return Ok(session_id),
                Err(error) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(error);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn ssh_exec_terminal_tool(
        &self,
        name: &str,
        command: &str,
        connection_id: &str,
        explicit: bool,
        timeout_secs: Option<Duration>,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let mode = self.runtime.agent_terminal_mode(connection_id);
        let risk = if name == "ssh_exec_sudo" {
            // Sudo runs through the user's terminal where the auto-sudo
            // state machine or a human answers the password prompt.
            agent_terminal::CommandRisk::Elevated
        } else if mcp_safety::runs_under_sudo(command) {
            // An inline `sudo …` is privilege escalation too, even when the
            // inner verb is harmless: teaching mode must approve it.
            agent_terminal::CommandRisk::Elevated
        } else {
            match mcp_safety::assess_command(command) {
                mcp_safety::CommandRisk::Destructive(_) => agent_terminal::CommandRisk::Elevated,
                _ => agent_terminal::CommandRisk::Low,
            }
        };
        let timeout = timeout_secs.map(|duration| duration.as_secs());
        // `ssh_exec_sudo` must type its `sudo` prefix into the terminal or
        // the escalation silently disappears (this path has no separate sudo
        // orchestration — the terminal's auto-sudo state machine answers the
        // prompt the prefixed command raises). Idempotent, so a prefix kept
        // through the approval dialog round-trips unchanged; an inline
        // `sudo …` from `ssh_exec` already carries it and stays untouched.
        // Shadowing here also puts the prefixed text on the approval prompt,
        // so what the user approves is exactly what gets typed.
        let command = if name == "ssh_exec_sudo" {
            agent_terminal::sudo_command_text(command)
        } else {
            command.to_string()
        };
        // Both routing outcomes need the connection's live workbench PTY.
        // The DBX app bridge opens the workbench tab right before forwarding,
        // so the PTY session may take a moment to appear: poll briefly before
        // falling back to the guidance error.
        let session_id = self
            .wait_for_connection_session(connection_id, Duration::from_secs(20))
            .await
            .map_err(|_| NO_TERMINAL_SESSION_MESSAGE.to_string())?;
        // Serialize concurrent agent commands on the same session: the guard
        // is intentionally held across the approval wait and the whole run —
        // that IS the serialization, so a second command queues behind an
        // in-flight approval instead of interleaving keystrokes with it on
        // the shared PTY. The lock is per-session, so different connections
        // still execute in parallel (no global lock here on purpose).
        let _exec_guard = self.runtime.agent_exec_guard(&session_id).await?;
        // Remembered approvals (IMPL_PLAN D1): a command on the connection's
        // remembered list downgrades `Prompt` to `Run`, so "approve +
        // remember" actually skips later prompts. Matching mirrors the
        // settings view (sudoers-style token rules on the exact typed
        // command); the disaster gate stays last — it lives inside
        // `exec_in_terminal` and is never bypassed by memory (D2).
        let remembered = agent_approvals::matches(
            &agent_approvals::load_store(&self.runtime.data_dir()),
            connection_id,
            &command,
        );
        match agent_terminal::decide_with_memory(mode, risk, explicit, remembered) {
            agent_terminal::RoutingDecision::Run => {
                self.runtime
                    .exec_in_terminal(&session_id, name, &command, risk, timeout, emitter)
                    .await
            }
            agent_terminal::RoutingDecision::Prompt => {
                let approved = self
                    .runtime
                    .request_agent_approval(&session_id, name, &command, risk, None, emitter)
                    .await?;
                self.runtime
                    .exec_in_terminal(&session_id, name, &approved, risk, timeout, emitter)
                    .await
            }
            agent_terminal::RoutingDecision::Deny(reason) => Err(reason.to_string()),
        }
    }

    /// `ssh_multi_exec` (IMPL_PLAN_NETCATTY A2-T4): aggregate execution
    /// across several saved connections on the hidden channel (never routes
    /// through the visible terminal or agentTerminalMode). Targets are
    /// resolved and scope-gated up front (any out-of-scope target refuses
    /// the whole call); per-target gates share the call's
    /// `confirmDestructive`. Sequential mode honors `stopOnError`.
    async fn ssh_multi_exec_tool(&self, arguments: &Value) -> Result<Value, String> {
        // Enumerate every missing required parameter in one error (round 6):
        // an absent targets/command pair is reported together so the caller
        // does not burn one round per gap. Wrong-typed values fall through to
        // the precise per-parameter errors below.
        missing_required(arguments, &["targets", "command"])?;
        let command = required_str(arguments, "command")?;
        let targets = arguments
            .get("targets")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "targets must be an array of 1-10 connection references \
                 (connectionId or connectionName strings)"
                    .to_string()
            })?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| "targets must be non-empty strings".to_string())
            })
            .collect::<Result<Vec<String>, String>>()?;
        let parallel = multi_exec::normalize_targets(&targets)?;
        let mode = arguments
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("parallel");
        let sequential = match mode {
            "parallel" => false,
            "sequential" => true,
            other => {
                return Err(format!(
                    "mode must be \"parallel\" or \"sequential\"; got '{other}'"
                ))
            }
        };
        let stop_on_error = arg_bool(arguments, "stopOnError")?.unwrap_or(false);
        let timeout_secs =
            arg_u64(arguments, "timeoutSecs")?.map(|secs| Duration::from_secs(secs.clamp(5, 300)));
        let confirm_destructive = arg_bool(arguments, "confirmDestructive")?.unwrap_or(false);
        let read_only = self.connection_is_read_only(arguments).await;
        // Per-target gates are arguments-only (command text), so they run
        // once here and apply to every dial; the per-connection read-only
        // flag is enforced per dial in `multi_exec_one`. No sudo allowlist
        // lookup: `command_gate` refuses `sudo …` outright (escalation goes
        // through single-target `ssh_exec_sudo`).
        multi_exec::command_gate(command, read_only, confirm_destructive)?;

        // Resolve every raw selector into its registry identity up front so
        // an unknown/ambiguous reference refuses the whole call before any
        // dial (IMPL_PLAN §1.1: 全量归一化 + 作用域门在执行前)。§1.3 作用域：
        // 任一目标越界整体拒绝。
        let scope = self.effective_scope();
        let mut targets_resolved: Vec<multi_exec::TargetRef> = Vec::with_capacity(parallel.len());
        for raw in &parallel {
            let mut selector = json!({ "connectionId": raw });
            let resolved = match self.registered_connection_by_ref(&selector).await? {
                Some(stored) => stored,
                None => {
                    selector = json!({ "connectionName": raw });
                    self.registered_connection_by_ref(&selector)
                        .await?
                        .ok_or_else(|| format!("No saved connection matched '{raw}'"))?
                }
            };
            if scope.is_active()
                && !scope.allows(&resolved.id, resolved.name.as_deref(), &resolved.host)
            {
                return Err(format!(
                    "Connection '{}' ({} / {}) is outside this MCP server's connectionScope; \
                     remove it from targets or ask the operator to widen the scope",
                    resolved.id, resolved.host, resolved.username
                ));
            }
            let payload = json!({
                "id": resolved.id,
                "host": resolved.host,
                "port": resolved.port,
                "username": resolved.username,
            });
            match multi_exec::target_from_connection(raw, &payload) {
                Some(target) => targets_resolved.push(target),
                None => return Err(format!("Connection '{raw}' registry entry is malformed")),
            }
        }

        let mut results: Vec<Value> = Vec::with_capacity(targets_resolved.len());
        if sequential {
            for target in &targets_resolved {
                let row = self.multi_exec_one(target, command, timeout_secs).await;
                let failed = row.get("ok").and_then(Value::as_bool) != Some(true);
                results.push(row);
                if failed && stop_on_error {
                    break;
                }
            }
        } else {
            let mut runs = Vec::with_capacity(targets_resolved.len());
            for target in &targets_resolved {
                runs.push(self.multi_exec_one(target, command, timeout_secs));
            }
            // join! 的参数个数是静态的，动态 1–10 路扇出用递归 helper。
            let rows = join_all(runs).await;
            for row in rows {
                results.push(row);
            }
        }
        let sent = results
            .iter()
            .filter(|row| row.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        let failed = results.len() - sent;
        Ok(json!({
            "ok": failed == 0,
            "sent": sent,
            "failed": failed,
            "results": results,
        }))
    }

    /// One target row of `ssh_multi_exec`: resolves the saved connection
    /// (already normalized by `normalize_targets`), dials through the shared
    /// pool, and runs the command on the hidden channel. Failures become an
    /// `ok: false` row instead of failing the aggregate call.
    async fn multi_exec_one(
        &self,
        target: &multi_exec::TargetRef,
        command: &str,
        timeout_secs: Option<Duration>,
    ) -> Value {
        let arguments = json!({ "connectionId": target.connection_id });
        let result: Result<Value, String> = async {
            let stored = self
                .registered_connection_by_ref(&arguments)
                .await?
                .ok_or("Connection is no longer registered")?;
            if stored.read_only {
                return Err("Connection is read-only".to_string());
            }
            let set_env = stored.set_env.clone();
            let connection = self.connection(&arguments).await?;
            let outcome = exec::exec_plain(
                &connection,
                command,
                timeout_secs.unwrap_or(exec::PLAIN_EXEC_TIMEOUT),
                &set_env,
            )
            .await?;
            Ok(json!({ "output": outcome.output, "exitCode": outcome.exit_code }))
        }
        .await;
        match result {
            Ok(outcome) => json!({
                "target": target.raw,
                "connectionId": target.connection_id,
                "host": target.host,
                "port": target.port,
                "username": target.username,
                "ok": true,
                "output": outcome["output"],
                "exitCode": outcome["exitCode"],
            }),
            Err(error) => json!({
                "target": target.raw,
                "connectionId": target.connection_id,
                "host": target.host,
                "port": target.port,
                "username": target.username,
                "ok": false,
                "output": "",
                "exitCode": Value::Null,
                "error": error,
            }),
        }
    }

    /// `ssh_terminal_input` (IMPL_PLAN_NETCATTY A2-T6): injects raw input
    /// into the connection's LIVE terminal session (interactive answers /
    /// Ctrl-C semantics). Output is deliberately not collected — the
    /// terminal itself shows it; for captured output the caller uses
    /// `ssh_exec` with `runInTerminal: true`. No session means a guidance
    /// error, matching the agent terminal "visible before it runs" rule.
    async fn ssh_terminal_input_tool(&self, arguments: &Value) -> Result<Value, String> {
        let input = required_str(arguments, "input")?;
        let append_newline = arg_bool(arguments, "appendNewline")?.unwrap_or(false);
        let normalized = mcp_safety::normalize_terminal_input(input);
        // Terminal sessions are keyed by saved connection id; an endpoint
        // (host/user) selector has no lifecycle registration and therefore
        // no workbench PTY either — both shapes fall into the same guidance.
        let connection_id = match self.registered_connection_by_ref(arguments).await? {
            Some(stored) => stored.id,
            None => {
                return Err(format!(
                    "{NO_TERMINAL_SESSION_MESSAGE}; for captured output use \
                     ssh_exec with runInTerminal: true"
                ));
            }
        };
        let session_id = self
            .runtime
            .session_id_for_connection(&connection_id)
            .await
            .map_err(|_| {
                format!(
                    "{NO_TERMINAL_SESSION_MESSAGE}; for captured output use \
                     ssh_exec with runInTerminal: true"
                )
            })?;
        // batch_terminal_input reports per-target outcomes (it cannot fail
        // as a call); a full/closed input queue surfaces in the row error.
        let outcome = self
            .runtime
            .batch_terminal_input(
                std::slice::from_ref(&session_id),
                &normalized,
                append_newline,
            )
            .await;
        let row = outcome
            .get("results")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .ok_or("Terminal input outcome is missing its result row")?;
        if row.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(row
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Terminal input could not be delivered")
                .to_string());
        }
        Ok(json!({ "sent": true, "sessionId": session_id }))
    }

    /// stdio-mode terminal forwarding: relays the exec tool call to the DBX
    /// app's local TCP bridge, which opens the connection's workbench tab and
    /// runs the tool on the app's own sidecar — the same process as the
    /// visible terminal. The 200 body is already MCP-content wrapped and is
    /// returned verbatim (`call_tool` passes it through untouched); failures
    /// keep the bridge error and add reconnect guidance.
    async fn ssh_exec_app_bridge(
        &self,
        name: &str,
        connection_id: &str,
        arguments: &Value,
        timeout_secs: Option<Duration>,
    ) -> Result<Value, String> {
        app_bridge::ensure_app_bridge(app_bridge::DEFAULT_ENSURE_WAIT).await?;
        let timeout = timeout_secs.unwrap_or(Duration::from_secs(300));
        app_bridge::call_plugin_tool(connection_id, name, arguments.clone(), timeout)
            .await
            .map_err(|error| format!("{error}. Open the connection in DBX and retry"))
    }

    async fn sftp_tool(&self, name: &str, arguments: &Value) -> Result<Value, String> {
        // Same lazy-establish contract as the transfer tools: resolve the
        // saved-connection reference (connectionId / connectionName /
        // endpoint) and dial on first use, so browsing a host the caller
        // never ssh_exec'd first works instead of demanding a pre-existing
        // pool entry.
        self.connection(arguments).await?;
        let mut guard = self.connections.write().await;
        let entry = guard
            .get_mut(&connection_pool_key(arguments))
            .ok_or("Connection is not established")?;
        // 文件名编码判定（M17，连接级）：连接覆盖 > 全局偏好 > 缺省 auto。
        // dispatch 层已把 connectionName/端点选择器归一化为显式 connectionId
        // （见 call_tool_inner），这里只需读 connectionId；内联拨号按未覆盖
        // 处理（跟随全局），与工作台 resolve_sftp_encoding_opt 同构。
        let encoding = mcp_sftp_encoding(&self.runtime.data_dir(), arguments);
        match name {
            "sftp_list_dir" => {
                let path = required_str(arguments, "path")?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M17）：裸包 READDIR 保原始字节，名字口径为显示
                    // 形式（latin-1 解码忠实可逆，AI 回传同一路径即落回原始
                    // 字节）。裸包路径任何失败回退高层（读操作回退安全，与
                    // 工作台 sftp_list_path 同策略）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => match client
                            .readdir(&sftp_name::latin1_encode_display(path))
                            .await
                        {
                            Ok(raw_entries) => {
                                return Ok(json!({
                                    "path": path,
                                    "entries": raw_list_items(path, raw_entries),
                                }));
                            }
                            Err(error) => {
                                eprintln!(
                                    "[ssh] MCP sftp_list_dir: raw byte listing unavailable, falling back: {error}"
                                );
                            }
                        },
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_list_dir: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                let entries = sftp.lock().await.read_dir(path).await.map_err(sftp_error)?;
                let items: Vec<Value> = entries
                    .map(|entry| {
                        let metadata = entry.metadata();
                        json!({
                            "name": entry.file_name(),
                            "path": entry.path(),
                            "kind": match entry.file_type() {
                                FileType::Dir => "directory",
                                FileType::Symlink => "symlink",
                                FileType::File => "file",
                                FileType::Other => "other",
                            },
                            "size": metadata.size,
                            "modifiedAt": metadata.mtime,
                        })
                    })
                    .collect();
                Ok(json!({ "path": path, "entries": items }))
            }
            "sftp_stat" => {
                let path = required_str(arguments, "path")?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M18）：显示路径还原字节后走裸包 LSTAT（不跟随
                    // 符号链接，与工作台 sftp/stat M17 同口径）。裸包 v3
                    // attrs 不携带 uid/gid：shell 查询尽力而为补齐（M17 先例，
                    // 非 ASCII 名的字节参数边界登记在案）。仅裸包客户端建立
                    // 失败回退高层；操作错误原样上抛（工作台 stat 同策略）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            let attrs = client
                                .lstat(&sftp_name::latin1_encode_display(path))
                                .await?;
                            let (uid, gid) = lookup_remote_uid_gid(&entry.handle, path).await;
                            return Ok(raw_stat_json(path, attrs, uid, gid));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_stat: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                let metadata = sftp.lock().await.metadata(path).await.map_err(sftp_error)?;
                Ok(json!({
                    "path": path,
                    "size": metadata.size,
                    "permissions": metadata.permissions.map(|bits| format!("{:04o}", bits & 0o7777)),
                    "modifiedAt": metadata.mtime,
                    "accessedAt": metadata.atime,
                    "uid": metadata.uid,
                    "gid": metadata.gid,
                }))
            }
            "sftp_exists" => {
                let path = required_str(arguments, "path")?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M18）：裸包 LSTAT，只认 NO_SUCH_FILE 为
                    // 「不存在」，其余错误如实上抛。仅裸包客户端建立失败回退
                    // 高层（M17-B 写工具同策略）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            let exists = raw_sftp_exists(&mut client, path).await?;
                            return Ok(json!({ "path": path, "exists": exists }));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_exists: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                // Only "no such file" means absent: a permission error or a
                // dead channel must surface as an error, never as a
                // misleading `exists: false`.
                let exists = match sftp.lock().await.metadata(path).await {
                    Ok(_) => true,
                    Err(error) if is_no_such_file_error(&error) => false,
                    Err(error) => return Err(sftp_error(error)),
                };
                Ok(json!({ "path": path, "exists": exists }))
            }
            "sftp_pwd" => {
                let sftp = entry.sftp().await?;
                let home = sftp
                    .lock()
                    .await
                    .canonicalize(".")
                    .await
                    .map_err(sftp_error)?;
                Ok(json!({ "home": home }))
            }
            "sftp_read_file" => {
                let path = required_str(arguments, "path")?;
                // Settings move the default and the ceiling (down freely, up
                // within the soft caps); the clamp itself stays as the
                // defensive hard limit against oversized requests.
                let limits = self.size_limits();
                let max_bytes = arg_u64(arguments, "maxBytes")?
                    .unwrap_or(limits.max_read_bytes)
                    .clamp(1, limits.max_download_bytes);
                let as_base64 = arg_bool(arguments, "base64")?.unwrap_or(false);
                let offset = arg_u64(arguments, "offset")?.unwrap_or(0);
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M18）：显示路径还原字节后 OPEN(READ)+READ 分块
                    // （32 KiB 粒度）。大文件策略沿既有 MCP 边界：单次至多
                    // maxBytes（上限 maxDownloadBytes），超出标记 truncated。
                    // 读操作回退安全（M17-B readdir 同策略）：裸包路径任何
                    // 失败回退高层重读。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            match raw_sftp_read_file(&mut client, path, offset, max_bytes).await {
                                Ok((data, truncated)) => {
                                    return Ok(read_file_response(
                                        path, &data, truncated, as_base64,
                                    ));
                                }
                                Err(error) => {
                                    eprintln!(
                                        "[ssh] MCP sftp_read_file: raw byte read unavailable, falling back: {error}"
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_read_file: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                let mut file = sftp.lock().await.open(path).await.map_err(sftp_error)?;
                if offset > 0 {
                    use tokio::io::AsyncSeekExt;
                    // SeekFrom::Start only moves the local read cursor; an
                    // offset at/after EOF simply yields no data.
                    file.seek(std::io::SeekFrom::Start(offset))
                        .await
                        .map_err(|error| format!("SFTP seek failed: {error}"))?;
                }
                let mut data = Vec::new();
                file.take(max_bytes.saturating_add(1))
                    .read_to_end(&mut data)
                    .await
                    .map_err(|error| format!("SFTP read failed: {error}"))?;
                let truncated = data.len() as u64 > max_bytes;
                data.truncate(max_bytes as usize);
                Ok(read_file_response(path, &data, truncated, as_base64))
            }
            "sftp_write_file" => {
                let path = required_str(arguments, "path")?;
                let content = required_str(arguments, "content")?;
                let upload_limit = self.size_limits().max_upload_bytes;
                if content.len() as u64 > upload_limit {
                    return Err(format!(
                        "Content of {} bytes exceeds the MCP upload limit of {upload_limit} bytes \
                         (adjust maxUploadBytes via mcp/settings/set)",
                        content.len()
                    ));
                }
                let overwrite = arg_bool(arguments, "overwrite")?.unwrap_or(false);
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M18）：显示路径还原字节后走裸包直写（选型：MCP
                    // 面沿既有 sftp_write_file 直写语义——OPEN(CREAT|WRITE|
                    // TRUNC) 截断 + WRITE 32 KiB 分块，无工作台上传族的
                    // `.dbx-part` 暂存需求）。覆盖预检与写入同一字节口径
                    // （裸包 LSTAT）。仅裸包客户端建立失败回退高层（M17-B 写
                    // 工具同策略）；操作错误原样上抛，不回退（不会重复执行）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            return raw_sftp_write_file(
                                &mut client,
                                path,
                                content.as_bytes(),
                                overwrite,
                            )
                            .await;
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_write_file: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                if !overwrite && sftp.lock().await.metadata(path).await.is_ok() {
                    return Err(format!(
                        "Remote path already exists: {path} (pass overwrite=true to replace)"
                    ));
                }
                let mut file = sftp.lock().await.create(path).await.map_err(sftp_error)?;
                tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes())
                    .await
                    .map_err(|error| format!("SFTP write failed: {error}"))?;
                tokio::io::AsyncWriteExt::flush(&mut file)
                    .await
                    .map_err(|error| format!("SFTP write flush failed: {error}"))?;
                Ok(json!({ "path": path, "bytes": content.len() }))
            }
            "sftp_mkdir" => {
                let path = required_str(arguments, "path")?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M17）：显示路径整条按 latin1_encode_display 还原
                    // 字节后走裸包 MKDIR。仅裸包通道建立失败回退高层（建立阶段
                    // 尚未发出任何请求，回退不会重复执行）；操作错误原样上抛，
                    // 不回退（与工作台 sftp_create_directory 同策略）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            client
                                .mkdir(&sftp_name::latin1_encode_display(path))
                                .await?;
                            return Ok(json!({ "path": path, "created": true }));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_mkdir: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                sftp.lock()
                    .await
                    .create_dir(path)
                    .await
                    .map_err(sftp_error)?;
                Ok(json!({ "path": path, "created": true }))
            }
            "sftp_remove" => {
                let path = required_str(arguments, "path")?;
                let recursive = arg_bool(arguments, "recursive")?.unwrap_or(false);
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M17）：显示路径还原字节后走裸包删除。LSTAT 判型
                    // 分派与高层分支一致（symlink/文件 REMOVE、目录递归树删、
                    // 非递归目录报错），符号链接绝不跟随。回退策略同 mkdir。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            let raw_path = sftp_name::latin1_encode_display(path);
                            let attrs = client.lstat(&raw_path).await?;
                            if classify_raw_kind(attrs.permissions) == "directory" {
                                if !recursive {
                                    return Err(format!(
                                        "{path} is a directory; pass recursive=true"
                                    ));
                                }
                                raw_delete_tree(&mut client, &raw_path).await?;
                            } else {
                                client.remove(&raw_path).await?;
                            }
                            return Ok(json!({ "path": path, "removed": true }));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_remove: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                let metadata = sftp
                    .lock()
                    .await
                    .symlink_metadata(path)
                    .await
                    .map_err(sftp_error)?;
                if metadata.is_symlink() || !metadata.is_dir() {
                    sftp.lock()
                        .await
                        .remove_file(path)
                        .await
                        .map_err(sftp_error)?;
                } else if recursive {
                    remove_tree(&sftp, path.to_string()).await?;
                } else {
                    return Err(format!("{path} is a directory; pass recursive=true"));
                }
                Ok(json!({ "path": path, "removed": true }))
            }
            "sftp_rename" => {
                let source = required_str(arguments, "sourcePath")?;
                let target = required_str(arguments, "targetPath")?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M17）：源是列表回传的显示路径（latin1_encode_
                    // display 精确逆变换还原字节），目标是 AI 新输入/组合的
                    // 显示文本（latin-1 域内字符映回同值字节，域外 UTF-8 兜底，
                    // 与工作台新输入语义一致）。裸包 RENAME 保证改名不破坏
                    // 非 UTF-8 字节。回退策略同 mkdir。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            client
                                .rename(
                                    &sftp_name::latin1_encode_display(source),
                                    &sftp_name::latin1_encode_display(target),
                                )
                                .await?;
                            return Ok(json!({
                                "sourcePath": source,
                                "targetPath": target,
                                "renamed": true,
                            }));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_rename: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                sftp.lock()
                    .await
                    .rename(source, target)
                    .await
                    .map_err(sftp_error)?;
                Ok(json!({ "sourcePath": source, "targetPath": target, "renamed": true }))
            }
            "sftp_chmod" => {
                let path = required_str(arguments, "path")?;
                let mode = arguments.get("mode").ok_or_else(|| {
                    "Missing or invalid parameter: mode (expected an octal value up to 7777, \
                     e.g. \"644\" or 0644)"
                        .to_string()
                })?;
                let mode = parse_chmod_mode(mode)?;
                if encoding == sftp_name::NameEncoding::Latin1 {
                    // latin-1（M18）：显示路径还原字节后裸包 SETSTAT（只带
                    // permissions 子集）。仅裸包客户端建立失败回退高层；操作
                    // 错误原样上抛（与 M17-B 写工具同策略）。
                    match entry.raw_sftp().await {
                        Ok(mut client) => {
                            return raw_sftp_chmod(&mut client, path, mode).await;
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_chmod: raw byte client unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                let sftp = entry.sftp().await?;
                let metadata = russh_sftp::protocol::FileAttributes {
                    permissions: Some(mode),
                    ..Default::default()
                };
                sftp.lock()
                    .await
                    .set_metadata(path, metadata)
                    .await
                    .map_err(sftp_error)?;
                Ok(json!({ "path": path, "mode": format!("{mode:04o}") }))
            }
            "sftp_copy" | "sftp_move" => {
                let op = if name == "sftp_move" {
                    sftp_copy::CopyOp::Move
                } else {
                    sftp_copy::CopyOp::Copy
                };
                let request = sftp_copy::parse_request(arguments)?;
                // The SFTP channel only enables the rename fast path; its
                // absence falls back to the shell for every item.
                let sftp = match entry.sftp().await {
                    Ok(sftp) => Some(sftp),
                    Err(error) => {
                        eprintln!(
                            "[ssh] MCP {name}: SFTP channel unavailable ({error}); shell fallback only"
                        );
                        None
                    }
                };
                // latin-1（M18）：裸包客户端可用时，覆盖预检与同目录 move 的
                // RENAME 快路径走字节保真（工作台 M17-A 同模式；路径口径为
                // 显示形式）。执行层边界（登记，同工作台 M17-A）：远端
                // `cp`/`mv` 的 exec 命令串是 UTF-8 String，服务器原始字节经
                // shell 参数不可控，copy 与跨目录 move 的执行层保持字面量
                // 发送（clean 名不受影响，非 ASCII 名由服务器侧报错）。
                let raw = if encoding == sftp_name::NameEncoding::Latin1 {
                    match entry.raw_sftp().await {
                        Ok(client) => Some(client),
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP {name}: raw byte client unavailable, literal precheck fallback: {error}"
                            );
                            None
                        }
                    }
                } else {
                    None
                };
                Ok(sftp_copy::execute(&entry.handle, sftp, raw, op, &request)
                    .await
                    .into_json())
            }
            other => Err(format!("Unknown tool: {other}")),
        }
    }

    /// Containment gate for agent-supplied local transfer paths; see
    /// [`ensure_local_transfer_allowed_in`] for the policy.
    fn ensure_local_transfer_allowed(&self, path: &Path) -> Result<(), String> {
        let configured = self.size_limits().local_transfer_root;
        let roots = local_transfer_roots_for(&configured, &self.runtime.data_dir())?;
        ensure_local_transfer_allowed_in(&roots, &configured, path)
    }

    /// `sftp_upload`: transfers one local file to the remote server. The
    /// local side is validated before any connection I/O (readable, inside
    /// the allowed transfer roots, clear of the sensitive-path blocklist,
    /// within the configured `maxUploadBytes`) so bad paths fail fast and
    /// refusals leave the pooled connection untouched. SFTP transport
    /// errors drop the cached connection so the next call reconnects.
    async fn sftp_upload_tool(&self, arguments: &Value) -> Result<Value, String> {
        // Both gaps named in one error (round 6 enumeration contract).
        missing_required(arguments, &["localPath", "remotePath"])?;
        let local_path = required_str(arguments, "localPath")?;
        let remote_path = required_str(arguments, "remotePath")?;
        let overwrite = arg_bool(arguments, "overwrite")?.unwrap_or(false);
        let local_source = std::fs::canonicalize(local_path)
            .map_err(|error| format!("Cannot read local file {local_path}: {error}"))?;
        self.ensure_local_transfer_allowed(&local_source)?;
        let data = std::fs::read(&local_source).map_err(|error| {
            format!("Cannot read local file {}: {error}", local_source.display())
        })?;
        let upload_limit = self.size_limits().max_upload_bytes;
        if data.len() as u64 > upload_limit {
            return Err(format!(
                "Local file {local_path} is {} bytes and exceeds the MCP upload limit of \
                 {upload_limit} bytes (adjust maxUploadBytes via mcp/settings/set)",
                data.len()
            ));
        }
        let outcome = self
            .upload_via_sftp(arguments, local_path, remote_path, &data, overwrite)
            .await;
        if outcome.is_err() {
            self.drop_connection(arguments).await;
        }
        outcome
    }

    async fn upload_via_sftp(
        &self,
        arguments: &Value,
        local_path: &str,
        remote_path: &str,
        data: &[u8],
        overwrite: bool,
    ) -> Result<Value, String> {
        self.connection(arguments).await?;
        let mut guard = self.connections.write().await;
        let entry = guard
            .get_mut(&connection_pool_key(arguments))
            .ok_or("Connection is not established")?;
        // latin-1（M19）：显示路径整条按 latin1_encode_display 还原字节后走
        // 裸包直写（选型：沿既有 sftp_upload 直写语义，无工作台上传族的
        // `.dbx-part` 暂存需求；覆盖预检与写入同一字节口径，复用 M18 的
        // raw_sftp_write_bytes）。仅裸包客户端建立失败回退高层（M18 写工具
        // 同策略）；操作错误原样上抛，不回退（不会重复执行）。
        if mcp_sftp_encoding(&self.runtime.data_dir(), arguments) == sftp_name::NameEncoding::Latin1
        {
            match entry.raw_sftp().await {
                Ok(mut client) => {
                    let bytes =
                        raw_sftp_write_bytes(&mut client, remote_path, data, overwrite).await?;
                    return Ok(json!({
                        "localPath": local_path,
                        "remotePath": remote_path,
                        "bytes": bytes,
                    }));
                }
                Err(error) => {
                    eprintln!(
                        "[ssh] MCP sftp_upload: raw byte client unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = entry.sftp().await?;
        if !overwrite && sftp.lock().await.metadata(remote_path).await.is_ok() {
            return Err(format!(
                "Remote path already exists: {remote_path} (pass overwrite=true to replace)"
            ));
        }
        let mut file = sftp
            .lock()
            .await
            .create(remote_path)
            .await
            .map_err(sftp_error)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, data)
            .await
            .map_err(|error| format!("SFTP write failed: {error}"))?;
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|error| format!("SFTP write flush failed: {error}"))?;
        Ok(json!({ "localPath": local_path, "remotePath": remote_path, "bytes": data.len() }))
    }

    /// `sftp_download`: transfers one remote file to a local path. The local
    /// target is validated before dialing (those refusals keep the pooled
    /// connection); the remote size is checked against the configured
    /// `maxDownloadBytes` and transport errors drop the cached connection.
    async fn sftp_download_tool(&self, arguments: &Value) -> Result<Value, String> {
        // Both gaps named in one error (round 6 enumeration contract), in
        // the schema's required order (remotePath before localPath).
        missing_required(arguments, &["remotePath", "localPath"])?;
        let local_path = required_str(arguments, "localPath")?;
        let remote_path = required_str(arguments, "remotePath")?;
        // Local-write hygiene before anything else: remote content must not
        // land on shell bootstrap / scheduled-execution paths.
        if is_sensitive_local_path(local_path) {
            return Err(format!(
                "Refusing to write the local sensitive path {local_path} via sftp_download"
            ));
        }
        let overwrite = arg_bool(arguments, "overwrite")?.unwrap_or(false);
        let local = Path::new(local_path);
        if local.exists() && !overwrite {
            return Err(format!(
                "Local path already exists: {local_path} (pass overwrite=true to replace)"
            ));
        }
        let file_name = local
            .file_name()
            .ok_or_else(|| format!("Invalid local path: {local_path}"))?;
        if let Some(parent) = local
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create local directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        // Write through the canonical parent (symlinks and `..` resolved by
        // the OS) re-joined with the requested file name, so the target is
        // exactly the requested path and never a traversal artifact.
        let local_target = match local
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            Some(parent) => std::fs::canonicalize(parent)
                .map_err(|error| {
                    format!(
                        "Cannot resolve local directory {}: {error}",
                        parent.display()
                    )
                })?
                .join(file_name),
            None => PathBuf::from(file_name),
        };
        // Containment before dialing: refusals here keep the pooled
        // connection untouched (same contract as the other local checks).
        self.ensure_local_transfer_allowed(&local_target)?;
        let outcome = self
            .download_via_sftp(arguments, remote_path, local_path, &local_target)
            .await;
        if outcome.is_err() {
            self.drop_connection(arguments).await;
        }
        outcome
    }

    async fn download_via_sftp(
        &self,
        arguments: &Value,
        remote_path: &str,
        local_path: &str,
        local_target: &Path,
    ) -> Result<Value, String> {
        self.connection(arguments).await?;
        let download_limit = self.size_limits().max_download_bytes;
        let mut guard = self.connections.write().await;
        let entry = guard
            .get_mut(&connection_pool_key(arguments))
            .ok_or("Connection is not established")?;
        // latin-1（M19）：读侧沿 M18 sftp_read_file 同策略——显示路径整条
        // latin1_encode_display 还原字节后 OPEN(READ)+READ，裸包路径任何
        // 失败回退高层重读（读操作安全）。目录探测不单独走裸包 STAT：目录
        // 的 OPEN 会被服务器拒绝、落入回退，由高层给出与 auto 分支一致的
        // 「is a directory」错误；超限沿既有 post-read 口径报错（读取量以
        // download_limit+1 探测封顶，不做无界传输）。
        if mcp_sftp_encoding(&self.runtime.data_dir(), arguments) == sftp_name::NameEncoding::Latin1
        {
            match entry.raw_sftp().await {
                Ok(mut client) => {
                    match raw_sftp_read_file(&mut client, remote_path, 0, download_limit).await {
                        Ok((data, truncated)) => {
                            if truncated {
                                return Err(format!(
                                    "Remote file {remote_path} exceeds the MCP download limit \
                                     of {download_limit} bytes (adjust maxDownloadBytes via \
                                     mcp/settings/set)"
                                ));
                            }
                            std::fs::write(local_target, &data).map_err(|error| {
                                format!(
                                    "Cannot write local file {}: {error}",
                                    local_target.display()
                                )
                            })?;
                            return Ok(json!({
                                "remotePath": remote_path,
                                "localPath": local_path,
                                "bytes": data.len(),
                            }));
                        }
                        Err(error) => {
                            eprintln!(
                                "[ssh] MCP sftp_download: raw byte read unavailable, falling back: {error}"
                            );
                        }
                    }
                }
                Err(error) => {
                    eprintln!(
                        "[ssh] MCP sftp_download: raw byte client unavailable, falling back: {error}"
                    );
                }
            }
        }
        let sftp = entry.sftp().await?;
        let metadata = sftp
            .lock()
            .await
            .metadata(remote_path)
            .await
            .map_err(sftp_error)?;
        if metadata.is_dir() {
            return Err(format!(
                "{remote_path} is a directory; sftp_download transfers a single file"
            ));
        }
        if let Some(size) = metadata.size {
            if size > download_limit {
                return Err(format!(
                    "Remote file {remote_path} is {size} bytes and exceeds the MCP download \
                     limit of {download_limit} bytes (adjust maxDownloadBytes via mcp/settings/set)"
                ));
            }
        }
        let file = sftp
            .lock()
            .await
            .open(remote_path)
            .await
            .map_err(sftp_error)?;
        // `take` is the hard cap for files that reported no size (or grew
        // between stat and open); the stat check above is only the fast path.
        let mut data = Vec::new();
        file.take(download_limit.saturating_add(1))
            .read_to_end(&mut data)
            .await
            .map_err(|error| format!("SFTP read failed: {error}"))?;
        if data.len() as u64 > download_limit {
            return Err(format!(
                "Remote file {remote_path} exceeds the MCP download limit of {download_limit} \
                 bytes (adjust maxDownloadBytes via mcp/settings/set)"
            ));
        }
        std::fs::write(local_target, &data).map_err(|error| {
            format!(
                "Cannot write local file {}: {error}",
                local_target.display()
            )
        })?;
        Ok(json!({ "remotePath": remote_path, "localPath": local_path, "bytes": data.len() }))
    }

    async fn ssh_close(&self, arguments: &Value) -> Result<Value, String> {
        // A selector-less close would silently target the meaningless
        // "mcp-@:22" pool key; demand a reference instead of a confusing
        // "no cached connection" miss.
        if non_empty_argument(arguments, "connectionId").is_none()
            && non_empty_argument(arguments, "connectionName").is_none()
            && endpoint_selector(arguments).is_none()
        {
            return Err(
                "ssh_close needs a connection reference: pass connectionId (or \
                 connectionName, or a unique host+username endpoint, as listed by \
                 ssh_list_connections)"
                    .to_string(),
            );
        }
        let pool_id = connection_pool_key(arguments);
        let entry = self.connections.write().await.remove(&pool_id);
        match entry {
            Some(entry) => {
                let _ = entry
                    .handle
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "MCP connection closed",
                        "English",
                    )
                    .await;
                for jump in entry.jumps {
                    let _ = jump
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "MCP jump connection closed",
                            "English",
                        )
                        .await;
                }
                Ok(json!({ "connectionId": pool_id, "closed": true }))
            }
            None => Err(format!("No cached connection for {pool_id}")),
        }
    }

    async fn drop_connection(&self, arguments: &Value) {
        let pool_id = connection_pool_key(arguments);
        self.connections.write().await.remove(&pool_id);
    }

    async fn connection(&self, arguments: &Value) -> Result<Arc<Handle<SshClient>>, String> {
        // DBX bridge calls reference a saved connection by id (or name);
        // inline calls (standalone --mcp mode) derive the pool key from the
        // credentials. The unified lookup resolves connectionId first, then
        // connectionName, and fails on ambiguity with every candidate.
        let explicit_id = arguments
            .get("connectionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let explicit_name = arguments
            .get("connectionName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let registered = self.registered_connection_by_ref(arguments).await?;
        let (pool_id, connection) = match registered {
            // The real registry id is the pool key either way, so pooled
            // handles line up with the app-side and forwarded calls.
            Some(connection) => (connection.id.clone(), Some(connection)),
            None => {
                if let Some(id) = explicit_id {
                    // Unregistered id: a pooled handle may still exist (an
                    // earlier registration left one behind), so the pool hit
                    // below gets its chance before the guidance error fires.
                    (id.to_string(), None)
                } else if let Some(name) = explicit_name {
                    // Unregistered name: no pool key can be derived, so the
                    // self-heal error fires immediately (L0).
                    return Err(format!(
                        "No connection named '{name}' is registered with this plugin session and \
                         the DBX app bridge is unavailable. Start the DBX app, list saved \
                         connections with ssh_list_connections, or provide inline credentials \
                         (host/username plus password or privateKeyPath/privateKeyContent)."
                    ));
                } else {
                    (
                        connection_pool_id(arguments),
                        Some(stored_connection_from_arguments(arguments)?),
                    )
                }
            }
        };
        {
            let guard = self.connections.read().await;
            if let Some(entry) = guard.get(&pool_id) {
                return Ok(entry.handle.clone());
            }
        }
        // Unregistered connectionId with no pooled handle: with the L1
        // bridge fallback active this only fires when the DBX app bridge is
        // also unavailable, so the message carries the full self-heal path.
        let connection = match connection {
            Some(connection) => connection,
            None => {
                return Err(format!(
                    "Connection {pool_id} is not registered with this plugin session and the DBX \
                     app bridge is unavailable. Start the DBX app, list saved connections with \
                     ssh_list_connections, or provide inline credentials (host/username plus \
                     password or privateKeyPath/privateKeyContent)."
                ))
            }
        };
        let (handle, jumps) = self.runtime.connect_headless(&connection).await?;
        let mut guard = self.connections.write().await;
        drop(connection);
        let entry = guard.entry(pool_id).or_insert(McpConnection {
            handle: handle.clone(),
            jumps,
            sftp: None,
        });
        Ok(entry.handle.clone())
    }

    /// `mcp/call` entry used by the DBX MCP bridge (`dbx_call_plugin_tool`):
    /// registers the forwarded connection lifecycle payload, then dispatches
    /// the tool with a `connectionId` reference so credentials never travel
    /// inline with tool arguments. The emitter enables the agent terminal
    /// routing (`runInTerminal` / `agentTerminalMode`); stdio mode passes
    /// `None` and only leaves the hidden exec channel for `runInTerminal`
    /// calls, which forward to the DBX app's local TCP bridge.
    pub async fn call_dbx(&self, params: &Value, emitter: PluginEmitter) -> Result<Value, String> {
        self.call_dbx_with(params, Some(emitter)).await
    }

    /// Emitter-less variant; tests (and the stdio path semantics) use it to
    /// exercise lifecycle registration without a bridge emitter.
    pub(crate) async fn call_dbx_with(
        &self,
        params: &Value,
        emitter: Option<PluginEmitter>,
    ) -> Result<Value, String> {
        let tool = required_str(params, "tool")?.to_string();
        let mut arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if !arguments.is_object() {
            return Err("arguments must be a JSON object".to_string());
        }
        if let Some(lifecycle) = params.get("lifecycle") {
            let connection = StoredConnection::from_lifecycle_params(lifecycle)?;
            self.dbx_connections
                .write()
                .await
                .insert(connection.id.clone(), connection.clone());
            if let Some(map) = arguments.as_object_mut() {
                map.insert("connectionId".to_string(), json!(connection.id));
            }
        }
        self.call_tool(&tool, &arguments, emitter.as_ref()).await
    }
}

async fn remove_tree(sftp: &Arc<AsyncMutex<SftpSession>>, root: String) -> Result<(), String> {
    let mut pending = vec![root];
    let mut directories = Vec::new();
    while let Some(directory) = pending.pop() {
        directories.push(directory.clone());
        let entries = sftp
            .lock()
            .await
            .read_dir(directory)
            .await
            .map_err(sftp_error)?;
        for entry in entries {
            if entry.file_type() == FileType::Dir {
                pending.push(entry.path());
            } else {
                sftp.lock()
                    .await
                    .remove_file(entry.path())
                    .await
                    .map_err(sftp_error)?;
            }
        }
    }
    for directory in directories.into_iter().rev() {
        sftp.lock()
            .await
            .remove_dir(directory)
            .await
            .map_err(sftp_error)?;
    }
    Ok(())
}

/// MCP 工具面的连接级文件名编码判定（M17）：arguments 携带的 connectionId
/// （保存连接；dispatch 层已把 connectionName/端点选择器归一化为该字段）
/// 命中 `sftp_name_encoding_overrides` 时优先，否则跟随全局
/// `sftp_name_encoding`，缺省 auto——与工作台
/// `Plugin::resolve_sftp_encoding_opt` 同构（内联拨号按未覆盖处理）。
fn mcp_sftp_encoding(data_dir: &Path, arguments: &Value) -> sftp_name::NameEncoding {
    preferences::sftp_name_encoding_for(data_dir, non_empty_argument(arguments, "connectionId"))
}

/// latin-1 裸包列表条目 → MCP 工具响应条目（M17）。名字口径为**显示形式**：
/// `name`/`path` 都是 latin-1 解码文本（解码输出恒在 U+0000..=U+00FF 域内，
/// `latin1_encode_display` 是其精确逆变换——AI 把返回的 path 原样回传给
/// sftp_mkdir/sftp_remove/sftp_rename 即落回服务器原始字节，不引入 %XX
/// 转义噪声）。kind 按 v3 permissions 类型位归类（缺 permissions 退回
/// file，非标准服务器不会把普通文件误渲染成目录）；`.`/`..` 跳过。
fn raw_list_items(dir: &str, entries: Vec<sftp_raw::RawEntry>) -> Vec<Value> {
    entries
        .into_iter()
        .filter(|entry| entry.name.as_slice() != b"." && entry.name.as_slice() != b"..")
        .map(|entry| {
            let display =
                sftp_name::decode_display_name(&entry.name, sftp_name::NameEncoding::Latin1);
            // 目录 + 显示名的拼接与 join_wire_name 同形（纯字符串 join，无转
            // 义语义），直接复用避免重复实现。
            json!({
                "name": display.text,
                "path": sftp_name::join_wire_name(dir, &display.text),
                "kind": classify_raw_kind(entry.attrs.permissions),
                "size": entry.attrs.size,
                "modifiedAt": entry.attrs.mtime,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// latin-1（M18）MCP 工具面裸包辅助：显示路径整条 latin1_encode_display 还原
// 服务器字节后走裸包操作。泛型 over `RawSftp<S>` 是为了测试能用内存双工桩
// （`sftp_raw::test_support`）做 latin-1 往返闭环，生产调用方传入的是
// russh 通道流上的 `RawSftpClient`。
// ---------------------------------------------------------------------------

/// `sftp_stat` 响应装配（auto 与 latin-1 共用）。口径与 auto 分支一致：
/// permissions 四位八进制、秒级时间戳。uid/gid 由调用方尽力而为补齐（裸包
/// v3 attrs 不携带，见 [`lookup_remote_uid_gid`]）。
fn raw_stat_json(
    path: &str,
    attrs: sftp_raw::RawAttrs,
    uid: Option<u32>,
    gid: Option<u32>,
) -> Value {
    json!({
        "path": path,
        "size": attrs.size,
        "permissions": attrs.permissions.map(|bits| format!("{:04o}", bits & 0o7777)),
        "modifiedAt": attrs.mtime,
        "accessedAt": attrs.atime,
        "uid": uid,
        "gid": gid,
    })
}

/// latin-1（M18）裸包 attrs 无 uid/gid（工作台 `sftp/stat` M17 先例同口径）：
/// shell `stat -c '%u %g'` 尽力而为补齐属主数字。命令串是 UTF-8 String，非
/// ASCII 显示名的字节参数不可控（M17-A 登记边界），exec 失败/解析不出按
/// `(None, None)` 处理，主元数据不受影响。
async fn lookup_remote_uid_gid(
    handle: &Handle<SshClient>,
    path: &str,
) -> (Option<u32>, Option<u32>) {
    let command = format!("stat -c '%u %g' -- {}", exec::shell_quote(path));
    let Ok(outcome) = exec::exec_plain(handle, &command, Duration::from_secs(10), &[]).await else {
        return (None, None);
    };
    let mut fields = outcome.output.split_whitespace();
    (
        fields.next().and_then(|field| field.parse().ok()),
        fields.next().and_then(|field| field.parse().ok()),
    )
}

/// latin-1（M18）`sftp_exists` 裸包分支：裸包 LSTAT，只把
/// SSH_FX_NO_SUCH_FILE 映射为「不存在」，其余错误如实上抛——与 auto 分支
/// 「权限错误/死通道绝不误报 exists:false」的契约一致。
async fn raw_sftp_exists<S>(client: &mut sftp_raw::RawSftp<S>, path: &str) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + std::marker::Unpin,
{
    match client.lstat(&sftp_name::latin1_encode_display(path)).await {
        Ok(_) => Ok(true),
        Err(error) => match sftp_raw::error_status(&error) {
            Some(sftp_raw::SSH_FX_NO_SUCH_FILE) => Ok(false),
            _ => Err(error),
        },
    }
}

/// latin-1（M18）`sftp_read_file` 裸包分支：显示路径还原字节后
/// OPEN(READ) + READ 分块循环（`RawSftp::read_file`，32 KiB 粒度，v3 规范
/// 建议口径）。大文件策略沿既有 MCP 边界：单次至多 `max_bytes`（上限
/// maxDownloadBytes），用 `max_bytes + 1` 探测截断——与 auto 分支 `take()`
/// 语义一致。返回 `(数据, 是否截断)`。
async fn raw_sftp_read_file<S>(
    client: &mut sftp_raw::RawSftp<S>,
    path: &str,
    offset: u64,
    max_bytes: u64,
) -> Result<(Vec<u8>, bool), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + std::marker::Unpin,
{
    let mut data = client
        .read_file(
            &sftp_name::latin1_encode_display(path),
            offset,
            max_bytes.saturating_add(1),
        )
        .await?;
    let truncated = data.len() as u64 > max_bytes;
    if truncated {
        data.truncate(max_bytes as usize);
    }
    Ok((data, truncated))
}

/// `sftp_read_file` 响应装配（auto 与 latin-1 共用）。
fn read_file_response(path: &str, data: &[u8], truncated: bool, as_base64: bool) -> Value {
    if as_base64 {
        json!({
            "path": path,
            "dataBase64": BASE64_STANDARD.encode(data),
            "truncated": truncated,
        })
    } else {
        json!({
            "path": path,
            "content": String::from_utf8_lossy(data),
            "truncated": truncated,
        })
    }
}

/// latin-1（M18）`sftp_write_file` 裸包分支：显示路径还原字节后
/// OPEN(CREAT|WRITE|TRUNC) 截断直写 + WRITE 32 KiB 分块（选型：MCP 面
/// 沿既有 sftp_write_file 直写语义，无工作台上传族的 `.dbx-part` 暂存
/// 需求）。`overwrite=false` 的覆盖预检走裸包 LSTAT，与写入同一字节口径；
/// 操作错误原样上抛不回退（与 M17-B 写工具同策略，避免重复执行）。
async fn raw_sftp_write_file<S>(
    client: &mut sftp_raw::RawSftp<S>,
    path: &str,
    content: &[u8],
    overwrite: bool,
) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + std::marker::Unpin,
{
    let bytes = raw_sftp_write_bytes(client, path, content, overwrite).await?;
    Ok(json!({ "path": path, "bytes": bytes }))
}

/// latin-1（M19）`sftp_upload` 裸包车道共用核心：与 [`raw_sftp_write_file`]
/// 同一直写语义，返回写入字节数供调用方按工具各自的响应形状组装
/// （sftp_write_file → `{path, bytes}`；sftp_upload → `{localPath,
/// remotePath, bytes}`）。
async fn raw_sftp_write_bytes<S>(
    client: &mut sftp_raw::RawSftp<S>,
    path: &str,
    content: &[u8],
    overwrite: bool,
) -> Result<usize, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + std::marker::Unpin,
{
    let raw_path = sftp_name::latin1_encode_display(path);
    if !overwrite && client.lstat(&raw_path).await.is_ok() {
        return Err(format!(
            "Remote path already exists: {path} (pass overwrite=true to replace)"
        ));
    }
    let handle = client.open_write(&raw_path).await?;
    let result = async {
        for (index, chunk) in content.chunks(sftp_raw::MAX_WRITE_CHUNK).enumerate() {
            client
                .write_chunk(&handle, (index * sftp_raw::MAX_WRITE_CHUNK) as u64, chunk)
                .await?;
        }
        Ok::<(), String>(())
    }
    .await;
    // 写失败也先 CLOSE 释放句柄，再上抛原错误。
    let closed = client.close(&handle).await;
    result?;
    closed?;
    Ok(content.len())
}

/// latin-1（M18）`sftp_chmod` 裸包分支：显示路径还原字节后 SETSTAT 只带
/// permissions 子集（与 auto 分支 set_metadata 的 attrs 语义一致；mode 解析
/// 复用 [`parse_chmod_mode`]，建立失败回退高层、操作错误原样上抛）。
async fn raw_sftp_chmod<S>(
    client: &mut sftp_raw::RawSftp<S>,
    path: &str,
    mode: u32,
) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + std::marker::Unpin,
{
    client
        .setstat(
            &sftp_name::latin1_encode_display(path),
            &sftp_raw::RawAttrs {
                permissions: Some(mode),
                ..sftp_raw::RawAttrs::default()
            },
        )
        .await?;
    Ok(json!({ "path": path, "mode": format!("{mode:04o}") }))
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("Missing or invalid parameter: {key} (expected a non-empty string)"))
}

/// Parses the optional `ssh_metrics` `sections` projection argument.
/// Accepted shapes (LLM input tolerance): absent/null, a single section
/// name string, or an array of section names. An empty array is refused so
/// a caller can never mistake "no sections" for "all sections"; unknown
/// names fail fast against the known universe before any dialing.
fn metrics_sections(arguments: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(value) = arguments.get("sections").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let names: Vec<String> = match value {
        Value::String(name) => vec![name.clone()],
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| "sections must be non-empty section-name strings".to_string())
            })
            .collect::<Result<Vec<String>, String>>()?,
        _ => {
            return Err(
                "sections must be a section name or an array of section names \
                 (e.g. [\"cpu\", \"memory\"]); omit it for the full document"
                    .to_string(),
            )
        }
    };
    if names.is_empty() {
        return Err(
            "sections must name at least one section; omit the argument for \
             the full document"
                .to_string(),
        );
    }
    exec::validate_section_names(&names)?;
    Ok(Some(names))
}

/// Enumerates EVERY absent required string parameter in one error
/// (`Missing required parameters: a, b`): an LLM caller fixes all gaps in a
/// single turn instead of discovering them one fail-fast round at a time.
/// Present-but-invalid values (wrong type, empty string) are NOT listed here
/// — the per-parameter `required_str`/type checks that follow name them
/// precisely with `Missing or invalid parameter: <key>`.
fn missing_required(arguments: &Value, keys: &[&str]) -> Result<(), String> {
    let missing: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|key| matches!(arguments.get(key), None | Some(Value::Null)))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Missing required parameters: {}",
            missing.join(", ")
        ))
    }
}

/// Reads an integer argument that may arrive as a JSON number or a numeric
/// string (LLMs frequently quote numbers: `"port": "2222"`). Returns
/// `Ok(None)` when absent/null; a non-numeric value is a clear parameter
/// error instead of silently falling back to the argument's default.
pub(crate) fn arg_u64(arguments: &Value, key: &str) -> Result<Option<u64>, String> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(number) = value.as_u64() {
        return Ok(Some(number));
    }
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if let Ok(number) = trimmed.parse::<u64>() {
            return Ok(Some(number));
        }
        return Err(format!("{key} must be an integer, got '{trimmed}'"));
    }
    Err(format!("{key} must be an integer, got {value}"))
}

/// Strict port validation: absent → 22, a number or numeric string within
/// `1..=65535` is accepted, anything else is a range/type error. Runs in
/// `call_tool` before every gate so a malformed port can never silently
/// dial the default port 22 instead of the requested one.
fn arg_port(arguments: &Value) -> Result<u16, String> {
    match arg_u64(arguments, "port")? {
        None => Ok(22),
        Some(port) if (1..=u16::MAX as u64).contains(&port) => Ok(port as u16),
        Some(port) => Err(format!("port must be between 1 and 65535, got {port}")),
    }
}

/// Lossy port read for gate/pool lookups (absent or malformed → 22).
/// `call_tool` rejects malformed ports before any gate runs, so the
/// fallback is only reachable through direct test entry points.
fn arg_port_lossy(arguments: &Value) -> u16 {
    arg_port(arguments).unwrap_or(22)
}

/// Reads a boolean argument, tolerating the `"true"`/`"false"` string
/// variants LLMs emit (`confirmDestructive: "true"` must not silently read
/// as `false`). Absent/null → `Ok(None)`.
pub(crate) fn arg_bool(arguments: &Value, key: &str) -> Result<Option<bool>, String> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(flag) = value.as_bool() {
        return Ok(Some(flag));
    }
    if let Some(text) = value.as_str() {
        return match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Ok(Some(true)),
            "false" | "0" | "no" | "off" => Ok(Some(false)),
            _ => Err(format!("{key} must be a boolean, got '{text}'")),
        };
    }
    Err(format!("{key} must be a boolean, got {value}"))
}

/// Parses `sftp_chmod`'s `mode`. LLMs pass the octal permission in several
/// shapes; all are normalized to permission bits:
/// - string digits (`"644"`, `"0644"`, optional `0o` prefix) → octal;
/// - a number whose decimal digits are all 0-7 (`644`) → octal digits;
/// - any other number (`384` = 0o600, `493` = 0o755) → raw permission bits.
fn parse_chmod_mode(value: &Value) -> Result<u32, String> {
    const MAX_MODE_TEXT: &str =
        "mode must be an octal value up to 7777 (e.g. \"644\", \"0755\" or 644)";
    let octal = |text: &str| {
        u32::from_str_radix(text, 8)
            .ok()
            .filter(|mode| *mode <= 0o7777)
            .ok_or_else(|| MAX_MODE_TEXT.to_string())
    };
    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        let digits = trimmed
            .strip_prefix("0o")
            .or_else(|| trimmed.strip_prefix("0O"))
            .unwrap_or(trimmed);
        return octal(digits);
    }
    let Some(number) = value.as_i64() else {
        return Err(MAX_MODE_TEXT.to_string());
    };
    if number < 0 {
        return Err(MAX_MODE_TEXT.to_string());
    }
    let digits = number.to_string();
    if digits.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return octal(&digits);
    }
    u32::try_from(number)
        .ok()
        .filter(|mode| *mode <= 0o7777)
        .ok_or_else(|| MAX_MODE_TEXT.to_string())
}

/// True for SFTP "no such file" statuses only: `sftp_exists` must not
/// report a permission error or a dead channel as a missing path.
fn is_no_such_file_error(error: &russh_sftp::client::error::Error) -> bool {
    matches!(
        error,
        russh_sftp::client::error::Error::Status(status)
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile
    )
}

/// Every MCP tool name this sidecar registers, kept in sync with
/// `tool_definitions` (a unit test pins the two together). Backs the
/// unknown-tool check with its did-you-mean suggestion.
pub const TOOL_NAMES: &[&str] = &[
    "ssh_exec",
    "ssh_exec_sudo",
    "ssh_multi_exec",
    "ssh_terminal_input",
    "ssh_run_bg",
    "ssh_task_status",
    "ssh_metrics",
    "docker_list",
    "docker_action",
    "ssh_alert_triage",
    "ssh_close",
    "ssh_test_connection",
    "ssh_list_known_hosts",
    "ssh_list_connections",
    "ssh_remove_known_host",
    "ssh_quick_sudo_profiles_list",
    "ssh_quick_sudo_profiles_save",
    "ssh_quick_sudo_profiles_delete",
    "sftp_list_dir",
    "sftp_stat",
    "sftp_exists",
    "sftp_pwd",
    "sftp_upload",
    "sftp_download",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_mkdir",
    "sftp_remove",
    "sftp_rename",
    "sftp_chmod",
    "sftp_copy",
    "sftp_move",
    "sftp_disk_usage",
];

fn is_known_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Actionable error for an unregistered tool name: a separator/case
/// variant (`sftp-listdir`, `SSH_EXEC`) suggests the exact registered
/// name, and every miss points at the discovery surface.
fn unknown_tool_message(name: &str) -> String {
    let compact = |text: &str| text.to_ascii_lowercase().replace(['-', '_', ' '], "");
    let query = compact(name);
    let mut suggestion = None;
    for tool in TOOL_NAMES {
        let candidate = compact(tool);
        if candidate == query {
            suggestion = Some(*tool);
            break;
        }
        if query.len() >= 4 && (candidate.contains(&query) || query.contains(&candidate)) {
            suggestion = Some(*tool);
        }
    }
    format!(
        "Unknown tool: '{name}'. {}Use tools/list to list the {} available tools \
         (ssh_exec, ssh_exec_sudo, ssh_run_bg, ssh_task_status, ssh_metrics, \
         ssh_terminal_input, ssh_multi_exec, ssh_alert_triage, sftp_*, ...).",
        suggestion
            .map(|tool| format!("Did you mean '{tool}'? "))
            .unwrap_or_default(),
        TOOL_NAMES.len(),
    )
}

/// Polls a dynamically sized batch of futures concurrently and returns all
/// outputs in input order. `tokio::join!` arities are static, so this small
/// recursive helper covers `ssh_multi_exec`'s dynamic 1-10 fan-out without
/// pulling in the `futures` crate. Each future is boxed+pinned so slots
/// stay pollable across wakes without an `Unpin` bound on `F`.
async fn join_all<F, T>(futures: Vec<F>) -> Vec<T>
where
    F: Future<Output = T> + Send,
    T: Send,
{
    let mut slots: Vec<std::pin::Pin<Box<dyn Future<Output = T> + Send>>> = futures
        .into_iter()
        .map(|future| Box::pin(future) as std::pin::Pin<Box<dyn Future<Output = T> + Send>>)
        .collect();
    let mut outputs: Vec<Option<T>> = std::iter::repeat_with(|| None).take(slots.len()).collect();
    loop {
        let mut pending = false;
        for (index, slot) in slots.iter_mut().enumerate() {
            if outputs[index].is_some() {
                continue;
            }
            let output = slot.as_mut().await;
            outputs[index] = Some(output);
            // Reset the await point for the next sweep; completed slots are
            // skipped by the `outputs` guard above.
            pending = true;
        }
        if !pending {
            break;
        }
    }
    outputs
        .into_iter()
        .map(|output| output.expect("every slot resolves before completion"))
        .collect()
}

fn sftp_error(error: impl std::fmt::Display) -> String {
    format!("SFTP operation failed: {error}")
}

fn connection_pool_id(arguments: &Value) -> String {
    let host = arguments.get("host").and_then(Value::as_str).unwrap_or("");
    let port = arg_port_lossy(arguments);
    let username = arguments
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("");
    format!("mcp-{username}@{host}:{port}")
}

/// Pool key for an arguments payload: an explicit `connectionId` (the DBX
/// bridge path) wins over inline credentials, keeping `ssh_close` on the same
/// pool key `connection()` used to register the handle.
fn connection_pool_key(arguments: &Value) -> String {
    arguments
        .get("connectionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| connection_pool_id(arguments))
}

/// Tools whose execution targets a saved connection: in stdio mode an
/// unregistered `connectionId` is forwarded through the DBX app bridge (L1
/// fallback) instead of failing the local registry lookup. Local-only tools
/// are deliberately absent: `ssh_close` keeps local pool semantics,
/// known-hosts / quick-sudo / settings tools never target a connection, and
/// `ssh_list_connections` is the discovery surface itself. `ssh_test_connection`
/// forwards when a saved reference cannot be resolved locally (the app-side
/// sidecar holds the credentials) while inline-credential calls stay local.
/// `sftp_upload` / `sftp_download` forward too: bridge and stdio sidecar run
/// on the same machine, so `localPath` stays valid on the app side (its
/// sidecar re-applies the local transfer gates with the shared plugin settings).
fn is_connection_bound_tool(name: &str) -> bool {
    matches!(
        name,
        "ssh_exec"
            | "ssh_exec_sudo"
            | "ssh_run_bg"
            | "ssh_task_status"
            | "ssh_metrics"
            | "docker_list"
            | "docker_action"
            | "ssh_test_connection"
            | "sftp_list_dir"
            | "sftp_stat"
            | "sftp_exists"
            | "sftp_pwd"
            | "sftp_read_file"
            | "sftp_write_file"
            | "sftp_mkdir"
            | "sftp_remove"
            | "sftp_rename"
            | "sftp_chmod"
            | "sftp_copy"
            | "sftp_move"
            | "sftp_disk_usage"
            | "sftp_upload"
            | "sftp_download"
    )
}

/// Registry entry as a list view: metadata plus credential PRESENCE flags
/// only (same discipline as the Quick Sudo profile views — never values).
fn registry_connection_view(connection: &StoredConnection) -> Value {
    json!({
        "id": connection.id,
        "name": connection.name,
        "host": connection.host,
        "port": connection.port,
        "username": connection.username,
        "authentication": connection.authentication.method_name(),
        "readOnly": connection.read_only,
        "passwordSet": !connection.password.is_empty(),
    })
}

/// Merges the bridge connection list (preferred, when the app answered)
/// with the session registry, deduplicated by id (bridge data wins).
/// Returns the tool payload: `source` records the data origin, and the
/// degraded branch carries a note pointing at the app start/upgrade
/// requirement. Bridge entries are credential-free by contract; registry
/// views expose presence flags only.
fn connection_list_result(
    bridge: Result<Vec<Value>, String>,
    registry: &[StoredConnection],
    scope: &ConnectionScope,
) -> Value {
    // §1.3: an active scope hides out-of-scope entries from the list view
    // (both bridge and registry sources), so discovery cannot enumerate
    // beyond the operator's allowlist. DenyAll intentionally produces an
    // empty list rather than reusing the persisted unrestricted empty array.
    fn in_scope(entry: &Value, scope: &ConnectionScope) -> bool {
        scope.allows(
            entry.get("id").and_then(Value::as_str).unwrap_or_default(),
            entry.get("name").and_then(Value::as_str),
            entry
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    }
    match bridge {
        Ok(entries) => {
            let listed: std::collections::HashSet<String> = entries
                .iter()
                .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
                .collect();
            let mut merged: Vec<Value> = entries
                .into_iter()
                .filter(|entry| in_scope(entry, scope))
                .collect();
            for connection in registry
                .iter()
                .filter(|connection| !listed.contains(&connection.id))
                .filter(|connection| {
                    scope.allows(&connection.id, connection.name.as_deref(), &connection.host)
                })
            {
                merged.push(registry_connection_view(connection));
            }
            json!({ "connections": merged, "source": "dbx-app-bridge" })
        }
        Err(_) => json!({
            "connections": registry
                .iter()
                .filter(|connection| {
                    scope.allows(
                        &connection.id,
                        connection.name.as_deref(),
                        &connection.host,
                    )
                })
                .map(registry_connection_view)
                .collect::<Vec<_>>(),
            "source": "session-registry",
            "note": "The DBX app bridge did not answer the saved-connection list (the app is not running, or this DBX version predates the /list-plugin-connections route). Only connections registered in this session are shown; start or upgrade the DBX app to get the full saved-connection list.",
        }),
    }
}

#[derive(Debug, Clone, Copy)]
struct EndpointSelector<'a> {
    host: &'a str,
    port: u16,
    username: &'a str,
}

fn non_empty_argument<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A host selector is intentionally complete: host plus username, with port
/// defaulting to 22. Matching only on host would silently choose the wrong
/// saved account when a machine has multiple SSH users.
fn endpoint_selector(arguments: &Value) -> Option<EndpointSelector<'_>> {
    let host = non_empty_argument(arguments, "host")?;
    let username = non_empty_argument(arguments, "username")?;
    let port = arg_port_lossy(arguments);
    Some(EndpointSelector {
        host,
        port,
        username,
    })
}

fn connection_matches_selectors(
    connection: &StoredConnection,
    name: Option<&str>,
    endpoint: Option<&EndpointSelector<'_>>,
) -> bool {
    name.is_none_or(|wanted| connection.name.as_deref() == Some(wanted))
        && endpoint.is_none_or(|selector| {
            connection.host.trim().eq_ignore_ascii_case(selector.host)
                && connection.port == selector.port
                && connection.username == selector.username
        })
}

fn endpoint_selector_label(selector: &EndpointSelector<'_>) -> String {
    format!(
        "endpoint {}@{}:{}",
        selector.username, selector.host, selector.port
    )
}

/// Pure selector→id resolution over a bridge connection list: exact name
/// and/or complete endpoint selectors filter candidates, exactly one hit
/// yields its id, and ambiguity lists every candidate id + host.
fn resolve_connection_in_bridge_list(
    entries: &[Value],
    arguments: &Value,
) -> Result<String, String> {
    let name = non_empty_argument(arguments, "connectionName");
    let endpoint = endpoint_selector(arguments);
    let mut hits: Vec<(&str, &str)> = Vec::new();
    for entry in entries {
        let entry_name = entry.get("name").and_then(Value::as_str).map(str::trim);
        let entry_host = entry.get("host").and_then(Value::as_str).unwrap_or("");
        let entry_port = entry
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(22);
        let entry_username = entry.get("username").and_then(Value::as_str).unwrap_or("");
        let name_matches = name.is_none_or(|wanted| entry_name == Some(wanted));
        let endpoint_matches = endpoint.is_none_or(|selector| {
            entry_host.trim().eq_ignore_ascii_case(selector.host)
                && entry_port == selector.port
                && entry_username == selector.username
        });
        if name_matches && endpoint_matches {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                hits.push((id, entry_host));
            }
        }
    }
    let selector = name
        .map(|value| format!("connection name '{value}'"))
        .or_else(|| endpoint.as_ref().map(endpoint_selector_label))
        .unwrap_or_else(|| "connection selectors".to_string());
    match hits.len() {
        1 => Ok(hits[0].0.to_string()),
        0 => Err(format!("No saved connection matched {selector}")),
        _ => Err(format!(
            "{selector} is ambiguous: {}; pass connectionId instead",
            hits.iter()
                .map(|(id, host)| format!("{id} (host {host})"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// Renders registry candidates for the ambiguous-connectionName error.
fn render_connection_candidates(connections: &[&StoredConnection]) -> String {
    connections
        .iter()
        .map(|connection| format!("{} (host {})", connection.id, connection.host))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Tools that mutate remote state and must be rejected on read-only
/// connections (mirrors the workbench `ensure_writable` / sudo-exec gates).
/// Plain `ssh_exec` is not listed: on read-only connections it is gated by
/// the read-only command whitelist in `call_tool` instead, so inspection
/// commands (`df`, `systemctl status`, ...) stay available. Like the
/// workbench read-only terminal, `sudo` execution is always refused.
/// `sftp_download` stays allowed too: it only reads the remote side (its
/// local write target is guarded by `is_sensitive_local_path`, and the
/// remote path by the sensitive-path denylist on read-only connections).
/// Terminal-input gate (IMPL_PLAN_NETCATTY §1.2, A2-T5). `normalized` is
/// already through `normalize_terminal_input`. Ordered cheapest-first:
/// ① read-only connections only accept control-only input (Enter / Ctrl+C /
/// escape runs — anything shell-visible could mutate state); ② any `\r`
/// line that assesses destructive needs `confirmDestructive` (refused
/// outright on read-only, mirroring `ssh_exec`); ③ `sudo …` lines go
/// through the connection's sudo allowlist when it declares one. ④ the
/// confirm permission-mode hook (§1.3 `execPermissionMode`) is a
/// deliberate留位 — the mode setting itself is not implemented yet.
fn terminal_input_gate(
    normalized: &str,
    read_only: bool,
    confirm_destructive: bool,
    allowlist: &[Vec<String>],
) -> Result<(), String> {
    if read_only && !mcp_safety::is_control_only_input(normalized) {
        return Err(
            "Connection is read-only; terminal input may only be control sequences \
             (Enter, Ctrl+C, escape runs) with no visible text"
                .to_string(),
        );
    }
    // Destructive check via the aggregate line assessor: the worst
    // `\r`-delimited line wins, so one catastrophic line is enough to gate.
    if let CommandRisk::Destructive(reason) = mcp_safety::assess_terminal_input(normalized) {
        if read_only {
            return Err(format!(
                "Refused on read-only connection ({reason}): {normalized}"
            ));
        }
        if !confirm_destructive {
            return Err(format!(
                "Terminal input looks destructive ({reason}): {normalized}. \
                 Retry with confirmDestructive: true if this is intended."
            ));
        }
    }
    for line in normalized.split('\r') {
        if mcp_safety::runs_under_sudo(line)
            && !allowlist.is_empty()
            && !sudo_allowlist::is_allowed(allowlist, line)
        {
            return Err(format!(
                "sudo command is not allowed by this connection's whitelist. \
                 Allowed patterns: {}",
                sudo_allowlist::render_entries(allowlist)
            ));
        }
    }
    Ok(())
}

fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "ssh_exec_sudo"
            | "ssh_run_bg"
            | "docker_action"
            | "sftp_write_file"
            | "sftp_upload"
            | "sftp_mkdir"
            | "sftp_remove"
            | "sftp_rename"
            | "sftp_chmod"
            | "sftp_copy"
            | "sftp_move"
    )
}

/// Remote-path arguments of read tools that must respect the sensitive-path
/// denylist on read-only connections. These tools return file content or
/// listings straight to the LLM, a channel the exec command whitelist cannot
/// classify; the denylist itself lives in `mcp_safety::is_sensitive_path`.
fn sensitive_read_path(name: &str, arguments: &Value) -> Option<String> {
    if !matches!(
        name,
        "sftp_list_dir"
            | "sftp_read_file"
            | "sftp_stat"
            | "sftp_exists"
            | "sftp_download"
            | "ssh_task_status"
    ) {
        return None;
    }
    ["path", "remotePath", "logPath"].iter().find_map(|key| {
        arguments
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| mcp_safety::is_sensitive_path(value))
            .map(str::to_string)
    })
}

/// Local write targets that must never receive downloaded content through
/// the MCP channel: shell/SSH bootstrap files plus cron / systemd / launchd
/// drop locations turn a remote file into local code execution. Applied on
/// every connection (read-only or not) — this guard protects the operator
/// machine, not the remote side. Defense in depth, not a sandbox.
fn is_sensitive_local_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    // Match on a collapsed form so `/etc//cron.d/x`, `/etc/./profile` and
    // friends cannot dodge the component / prefix rules (reliability
    // round 5 adversarial pass).
    let normalized = mcp_safety::normalized_path(&lower);
    const COMPONENTS: &[&str] = &[".ssh", ".gnupg"];
    if normalized
        .split('/')
        .any(|component| COMPONENTS.contains(&component))
    {
        return true;
    }
    const PREFIXES: &[&str] = &[
        "/etc/cron",
        "/var/spool/cron",
        "/etc/sudoers",
        "/etc/ssh",
        "/etc/ld.so",
        "/etc/pam.d",
        "/etc/profile",
        "/etc/bash",
        "/etc/rc",
        "/etc/systemd/system",
        "/library/launchdaemons",
        "/library/launchagents",
    ];
    if PREFIXES.iter().any(|prefix| normalized.starts_with(prefix)) {
        return true;
    }
    let file_name = Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(
        file_name,
        ".bashrc"
            | ".zshrc"
            | ".profile"
            | ".bash_profile"
            | ".zprofile"
            | ".zshenv"
            | ".zlogin"
            | ".cshrc"
            | ".tcshrc"
            | "authorized_keys"
            | ".netrc"
            | ".git-credentials"
            | ".npmrc"
            | ".htpasswd"
    )
}

/// Resolves the allowed local roots for agent-driven `sftp_upload` /
/// `sftp_download` transfers: the configured `localTransferRoot` when set
/// (it must resolve — an unreachable root is an error, never a silent
/// fallback), otherwise the OS temp dir plus the plugin data dir. Roots
/// are canonicalized so macOS `/var` → `/private/var` style aliasing
/// cannot dodge the `starts_with` containment check.
fn local_transfer_roots_for(configured: &str, data_dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !configured.is_empty() {
        return std::fs::canonicalize(configured)
            .map(|root| vec![root])
            .map_err(|error| {
                format!(
                    "Configured localTransferRoot {configured} cannot be resolved: {error} \
                     (create the directory or reset it via mcp/settings/set)"
                )
            });
    }
    Ok([std::env::temp_dir(), data_dir.to_path_buf()]
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(&root).ok())
        .collect())
}

/// Containment gate for every agent-supplied local path behind
/// `sftp_upload` (read side) and `sftp_download` (write side): the
/// canonical path must stay inside an allowed root and clear the
/// sensitive-path blocklist (credential stores, shell bootstrap files) in
/// every mode, so a configured root cannot be used to reach them either.
/// `path` must already be canonical — symlink and `..` traversal artifacts
/// are resolved by the caller (`std::fs::canonicalize`, or the
/// canonical-parent rejoin on the download side).
fn ensure_local_transfer_allowed_in(
    roots: &[PathBuf],
    configured: &str,
    path: &Path,
) -> Result<(), String> {
    if is_sensitive_local_path(&path.to_string_lossy()) {
        return Err(format!(
            "Refusing to transfer the local sensitive path {} via sftp_upload/sftp_download",
            path.display()
        ));
    }
    if roots.iter().any(|root| path.starts_with(root)) {
        return Ok(());
    }
    Err(if configured.is_empty() {
        format!(
            "Local path {} is outside the allowed transfer roots (OS temp dir and plugin data \
             dir); set localTransferRoot via mcp/settings/set to allow more",
            path.display()
        )
    } else {
        format!(
            "Local path {} is outside the configured localTransferRoot {configured}",
            path.display()
        )
    })
}

/// Resolves the optional `quickSudoProfile` argument (id or exact name)
/// before any connection I/O, so unknown references fail fast instead of
/// dialing first.
fn resolve_profile_reference(
    store: &sudo_profiles::SudoProfileStore,
    arguments: &Value,
) -> Result<Option<sudo_profiles::SudoProfile>, String> {
    let Some(reference) = arguments
        .get("quickSudoProfile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    sudo_profiles::find_by_ref(store, reference)
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("Quick Sudo profile '{reference}' not found"))
}

/// Fills auth gaps from a resolved global Quick Sudo profile: fields the
/// caller set explicitly always win; unset fields fall back to the profile.
fn apply_profile_fallbacks(auth: &mut SudoAuth, profile: &sudo_profiles::SudoProfile) {
    if auth.password.is_empty() && !profile.sudo_password.trim().is_empty() {
        auth.password = profile.sudo_password.trim().to_string();
    }
    if auth.totp_secrets.is_empty() {
        auth.totp_secrets = exec::parse_totp_secrets(&profile.totp_secret);
    }
    if auth.password_prompt_hint.is_empty() {
        auth.password_prompt_hint = exec::sanitize_prompt_hint(&profile.password_prompt_hint);
    }
    if auth.totp_prompt_hint.is_empty() {
        auth.totp_prompt_hint = exec::sanitize_prompt_hint(&profile.totp_prompt_hint);
    }
    if auth.flow_mode.is_none() {
        auth.flow_mode = Some(AuthFlowMode::parse(&profile.auth_flow_mode));
    }
}

/// Re-applies the caller's explicit per-call arguments on top of the
/// source-resolved base auth: values the caller actually sent always win,
/// whatever the connection's declared sudo source contributed.
fn apply_explicit_argument_overrides(auth: &mut SudoAuth, arguments: &Value) {
    let explicit = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if let Some(password) = explicit("sudoPassword") {
        auth.password = password.to_string();
    }
    if let Some(secret) = explicit("totpSecret") {
        auth.totp_secrets = exec::parse_totp_secrets(secret);
    }
    if let Some(hint) = explicit("passwordPromptHint") {
        auth.password_prompt_hint = exec::sanitize_prompt_hint(hint);
    }
    if let Some(hint) = explicit("totpPromptHint") {
        auth.totp_prompt_hint = exec::sanitize_prompt_hint(hint);
    }
    if let Some(mode) = explicit("authFlowMode") {
        auth.flow_mode = Some(AuthFlowMode::parse(mode));
    }
}

fn sudo_auth(arguments: &Value) -> SudoAuth {
    let mut auth = SudoAuth::new(
        arguments
            .get("sudoPassword")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        arguments
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        arguments
            .get("totpSecret")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        Hints {
            password: arguments
                .get("passwordPromptHint")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            totp: arguments
                .get("totpPromptHint")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            flow_mode: arguments
                .get("authFlowMode")
                .and_then(Value::as_str)
                .map(AuthFlowMode::parse),
        },
    );
    auth.otp_ledger_scope = exec::otp_ledger_scope_for(
        arguments
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        arguments
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        arg_port_lossy(arguments),
    );
    auth
}

fn stored_connection_from_arguments(arguments: &Value) -> Result<StoredConnection, String> {
    let jump_hosts = parse_jump_hosts(arguments)?;
    let host = required_str(arguments, "host")?;
    let username = required_str(arguments, "username")?;
    let port = arg_port(arguments)?;
    let password = arguments
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let private_key_path = arguments
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let private_key_content = arguments
        .get("privateKeyContent")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let has_key = !private_key_path.is_empty() || !private_key_content.is_empty();
    let authentication = match arguments
        .get("authentication")
        .and_then(Value::as_str)
        .unwrap_or("password")
    {
        "private-key" if has_key => AuthenticationMethod::PrivateKey,
        "private-key-password" if has_key => AuthenticationMethod::PrivateKeyPassword,
        "agent" => AuthenticationMethod::Agent,
        _ => {
            if has_key {
                AuthenticationMethod::PrivateKey
            } else {
                AuthenticationMethod::Password
            }
        }
    };
    if matches!(authentication, AuthenticationMethod::Password) && password.is_empty() {
        let password_command = arguments
            .get("passwordCommand")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if password_command.is_empty() {
            return Err("Password authentication requires a password".to_string());
        }
    }
    if matches!(
        authentication,
        AuthenticationMethod::PrivateKey | AuthenticationMethod::PrivateKeyPassword
    ) && !has_key
    {
        return Err(
            "Private-key authentication requires privateKeyPath or privateKeyContent".to_string(),
        );
    }
    // Expect 式触发器（JSON 字符串形态，同 §2.1 schema）与外部密码管理器
    // 命令：解析/校验与存储路径同一套代码（triggers::parse_triggers），非法
    // 即拨号报错。内联拨号没有 secret binding，sendSecretKey 引用的槽位
    // 无法填充，引用即报错。
    let triggers = crate::triggers::parse_triggers(arguments.get("triggers"), &|_key| None)?;
    let password_command = arguments
        .get("passwordCommand")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let passphrase_command = arguments
        .get("passphraseCommand")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let connect_timeout = arg_u64(arguments, "connectTimeoutSecs")?;
    Ok(StoredConnection {
        sudo_whitelist: Vec::new(),
        id: connection_pool_id(arguments),
        // Inline MCP dials carry no display name.
        name: None,
        host: host.to_string(),
        port,
        runtime_host: host.to_string(),
        runtime_port: port,
        username: username.to_string(),
        protocol: "ssh".to_string(),
        password,
        authentication,
        private_key_path,
        private_key: private_key_content,
        private_key_passphrase: arguments
            .get("privateKeyPassphrase")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        agent_socket: arguments
            .get("agentSocket")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        connect_timeout_secs: connect_timeout.unwrap_or(30).max(1),
        connect_timeout_explicit: connect_timeout.is_some(),
        keepalive_interval_secs: 30,
        // MCP drives exec channels, never the user's interactive PTY —
        // activity injection doesn't apply here.
        terminal_keepalive_secs: 0,
        read_only: false,
        sudo_password: arguments
            .get("sudoPassword")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        totp_secret: arguments
            .get("totpSecret")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // MCP keeps its own quickSudoProfile resolution (explicit arguments
        // win), so the stored connection carries the plain on/off source.
        sudo_source: if arg_bool(arguments, "quickSudo")?.unwrap_or(true) {
            SudoSource::Custom
        } else {
            SudoSource::Off
        },
        sudo_profile_ref: String::new(),
        sudo_use_pty: false,
        password_prompt_hint: arguments
            .get("passwordPromptHint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        totp_prompt_hint: arguments
            .get("totpPromptHint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        auth_flow_mode: arguments
            .get("authFlowMode")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // MCP tool calls carry their own env/command semantics; connection
        // SetEnv / RemoteCommand are workbench connection-form features.
        set_env: Vec::new(),
        remote_command: String::new(),
        triggers_enabled: triggers.is_some(),
        triggers,
        password_command,
        passphrase_command,
        jump_hosts,
    })
}

/// Parses the `PID=` / `LOG=` lines emitted by the `ssh_run_bg` staging
/// command. Falls back to the derived default log path when the remote
/// never echoed `LOG=`.
fn parse_bg_start_output(output: &str, default_log: String) -> (String, String) {
    let mut pid = String::new();
    let mut log_path = default_log;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("PID=") {
            pid = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("LOG=") {
            log_path = value.trim().to_string();
        }
    }
    (pid, log_path)
}

/// Parses the STATE= / CODE= / PID_ALIVE= markers and the post-`===TAIL===`
/// section emitted by the `ssh_task_status` probe command.
type TaskStatusParse = (String, Option<i64>, Option<bool>, String);
fn parse_task_status_output(output: &str) -> TaskStatusParse {
    let mut state = "unknown".to_string();
    let mut exit_code: Option<i64> = None;
    let mut pid_alive: Option<bool> = None;
    let mut tail = String::new();
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("STATE=") {
            state = value.trim().to_lowercase();
        } else if let Some(value) = line.strip_prefix("CODE=EXIT_") {
            exit_code = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("PID_ALIVE=") {
            pid_alive = Some(value.trim() == "yes");
        } else if line == "===TAIL===" {
            tail.clear();
        } else if !line.is_empty() {
            tail.push_str(line);
            tail.push('\n');
        }
    }
    (state, exit_code, pid_alive, tail)
}

/// Parses the optional `jumpHosts` array (snake_case fields, same shape as
/// `external_config.jump_hosts`) into the ProxyJump chain.
fn parse_jump_hosts(arguments: &Value) -> Result<Vec<JumpHost>, String> {
    let Some(list) = arguments.get("jumpHosts") else {
        return Ok(Vec::new());
    };
    let Some(list) = list.as_array() else {
        return Err("jumpHosts must be an array of jump host objects".to_string());
    };
    if list.len() > 3 {
        return Err("At most 3 jump hosts are supported".to_string());
    }
    let mut hosts = Vec::with_capacity(list.len());
    for (position, value) in list.iter().enumerate() {
        let host = JumpHost::from_json(value)
            .map_err(|error| format!("jumpHosts[{position}]: {error}"))?;
        host.validate(position)
            .map_err(|error| format!("jumpHosts[{position}]: {error}"))?;
        hosts.push(host);
    }
    Ok(hosts)
}

/// Parameter descriptions shared by the connection property family and the
/// Quick Sudo profile tool (schema round 6: every advertised parameter must
/// carry an accurate description; defined once here, referenced by both
/// schema sites so the wording can never drift apart).
const AUTHENTICATION_DESCRIPTION: &str = "Authentication method for inline dials: password (default), private-key, private-key-password, or agent. Omitted is inferred: privateKeyPath or privateKeyContent present selects private-key, otherwise password; private-key* requires one of the two and password requires password";
const CONNECT_TIMEOUT_DESCRIPTION: &str =
    "TCP connect timeout in seconds for inline dials (default 30, minimum 1)";
const AUTH_FLOW_MODE_DESCRIPTION: &str = "Two-factor sudo authentication flow: password_only (no OTP), password_plus_otp (password and TOTP code submitted together at a combined prompt), password_then_otp (password first, TOTP answered at a separate later prompt; default when omitted). Values are matched case-insensitively (PASSWORD_PLUS_OTP works); unrecognized values fall back to the default flow instead of erroring. When set both inline and via a Quick Sudo profile, explicit arguments win";
const PASSWORD_PROMPT_HINT_DESCRIPTION: &str = "Text fragment used to recognize a non-standard sudo password prompt (localized or custom message) when the built-in prompt patterns miss it";
const TOTP_PROMPT_HINT_DESCRIPTION: &str = "Text fragment used to recognize a non-standard TOTP/verification-code prompt when the built-in prompt patterns miss it";

/// Tool-specific parameters layered on the shared connection properties.
/// Each entry is `(key, json type, description)`; the type is part of the
/// contract because the dispatcher parses numbers and booleans from these
/// fields (`maxBytes`, `overwrite`, …).
fn connection_properties(extra: &[(&str, &str, &str)]) -> Value {
    let mut properties = json!({
        // Declared here so strict MCP hosts forward it: the dispatcher reads
        // it for terminal routing (runInTerminal) and stored-connection
        // resolution, and an undeclared argument is dropped by schema
        // validation before the sidecar ever sees the call.
        "connectionId": { "type": "string", "description": "Saved DBX connection id (list ids with ssh_list_connections, or in the DBX app). With runInTerminal: true, a stdio-mode call is forwarded through the DBX app bridge to the connection's visible workbench terminal; on the embedded bridge it also resolves the stored connection's Quick Sudo source and read-only flag. In stdio mode an id unknown to this session is forwarded to the running DBX app, so no inline credentials are needed" },
        "connectionName": { "type": "string", "description": "Saved DBX connection name. It may replace connectionId; if names repeat, also provide host, port, and username to narrow to one connection. Ambiguous matches are refused with candidate ids." },
        "host": { "type": "string", "description": "Remote SSH host" },
        "port": { "type": "integer", "description": "SSH port (default 22)" },
        "username": { "type": "string", "description": "Login user" },
        "password": { "type": "string", "description": "Login password (password auth, or sudo fallback)" },
        "privateKeyPath": { "type": "string", "description": "Local private key path for key auth" },
        "privateKeyContent": { "type": "string", "description": "Private key contents for key auth (OpenSSH/PEM/PPK); takes precedence over privateKeyPath" },
        "privateKeyPassphrase": { "type": "string", "description": "Private key passphrase" },
        "agentSocket": { "type": "string", "description": "SSH agent socket for agent auth" },
        "authentication": { "type": "string", "enum": ["password", "private-key", "private-key-password", "agent"], "description": AUTHENTICATION_DESCRIPTION },
        "connectTimeoutSecs": { "type": "integer", "description": CONNECT_TIMEOUT_DESCRIPTION },
        "sudoPassword": { "type": "string", "description": "Sudo password override (defaults to password)" },
        "totpSecret": { "type": "string", "description": "TOTP secret (otpauth:// URI, base32 key, or static code) for 2FA auto-answer; multiple secrets (newline/semicolon separated) rotate automatically — unexpired, unused codes first, across calls" },
        "authFlowMode": { "type": "string", "enum": ["password_only", "password_plus_otp", "password_then_otp"], "description": AUTH_FLOW_MODE_DESCRIPTION },
        "passwordPromptHint": { "type": "string", "description": PASSWORD_PROMPT_HINT_DESCRIPTION },
        "totpPromptHint": { "type": "string", "description": TOTP_PROMPT_HINT_DESCRIPTION },
        "jumpHosts": { "type": "array", "description": "ProxyJump chain (up to 3): [{\"host\":\"bastion\",\"port\":22,\"username\":\"ops\",\"password\":\"…\"}] with snake_case fields; replaces direct dialing" },
        "triggers": { "type": "string", "description": "Expect-style terminal triggers as a JSON or tssh text string. Official syntax reference: https://github.com/trzsz/trzsz-ssh. Example: {\"stages\":[{\"pattern\":\"(?i)code\",\"sendText\":\"654321\\\\r\"}]}; each stage answers sendText, sendSecretKey (trigger_answer_1/2, unavailable on inline dials) or sendCommand (local command) when its ordered regex matches the PTY output. Invalid JSON/tssh rules, limits (max 16 stages) or an uncompileable regex fails the dial. A malicious server can fake a matching prompt to harvest the configured reply" },
        "passwordCommand": { "type": "string", "description": "Local command run only when no explicit password is set; its stdout minus one trailing newline is the login password. Placeholders: %h host, %u username, %p port, %% a literal %. Explicit credentials win" },
        "passphraseCommand": { "type": "string", "description": "Local command run only when an encrypted private key cannot be decoded without a passphrase; its stdout minus one trailing newline is the passphrase. Placeholders: %h host, %u username, %p port, %% a literal %" },
    });
    if let Some(map) = properties.as_object_mut() {
        for (key, kind, description) in extra {
            map.insert(
                key.to_string(),
                json!({ "type": kind, "description": description }),
            );
        }
    }
    properties
}

fn connection_selector_requirements() -> Value {
    json!([
        { "required": ["connectionId"] },
        { "required": ["connectionName"] },
        { "required": ["host", "username"] },
    ])
}

/// Advisory MCP tool annotations (spec "Tool annotations"): per-tool hints
/// clients may use to pre-approve read-only tools or gate destructive ones.
/// Advisory only — the server-side gates (mcp_safety whitelist, confirm
/// gate, read-only connection gate) stay authoritative regardless of what
/// a client does with these hints. The classification deliberately mirrors
/// the internal gate sets (`is_write_tool` / `is_confirm_gated_tool` /
/// read-only sparing) so hints and enforcement cannot drift apart in
/// opposite directions: the whole exec family and every
/// remove/move/overwrite/delete tool is destructive=true, everything the
/// confirm gate spares as provably read-only is readOnly=true, and the
/// mutating-but-non-destructive writes (mkdir/rename/chmod, profile save,
/// close) sit destructive=false between the two.
fn tool_annotations(name: &str) -> Value {
    // Provably no mutation of remote or local state (matches the set the
    // confirm gate spares).
    const READ_ONLY: &[&str] = &[
        "ssh_list_connections",
        "ssh_list_known_hosts",
        "ssh_quick_sudo_profiles_list",
        "ssh_metrics",
        "ssh_alert_triage",
        "ssh_test_connection",
        "ssh_task_status",
        "sftp_list_dir",
        "sftp_stat",
        "sftp_exists",
        "sftp_pwd",
        "sftp_read_file",
        "sftp_disk_usage",
        // Docker panel read surface: list/poll containers only.
        "docker_list",
    ];
    // May destroy or replace existing state: the exec family (arbitrary
    // remote commands), store deletions, and remove/move/overwrite-capable
    // writes (matches the confirm-gated set plus the delete tools).
    const DESTRUCTIVE: &[&str] = &[
        "ssh_exec",
        "ssh_exec_sudo",
        "ssh_multi_exec",
        "ssh_terminal_input",
        "ssh_run_bg",
        "ssh_remove_known_host",
        "ssh_quick_sudo_profiles_delete",
        "sftp_remove",
        "sftp_move",
        "sftp_copy",
        "sftp_upload",
        "sftp_download",
        "sftp_write_file",
        // Container lifecycle (rm/kill especially) is destructive; the tool
        // description spells out the confirm-first semantics.
        "docker_action",
    ];
    // Mutating but non-destructive, and repeating them converges to the
    // same state instead of compounding (idempotentHint).
    const IDEMPOTENT_MUTATING: &[&str] =
        &["ssh_close", "ssh_quick_sudo_profiles_save", "sftp_chmod"];
    let read_only = READ_ONLY.contains(&name);
    let destructive = DESTRUCTIVE.contains(&name);
    let mut annotations = json!({
        "readOnlyHint": read_only,
        "destructiveHint": destructive,
        "idempotentHint": read_only || IDEMPOTENT_MUTATING.contains(&name),
        "openWorldHint": name != "ssh_alert_triage",
    });
    if let Some(title) = tool_title(name) {
        annotations["title"] = json!(title);
    }
    annotations
}

/// Human-readable display names (spec `annotations.title`) for MCP client
/// tool pickers. Unknown names yield no title and keep the conservative
/// default hints from [`tool_annotations`].
fn tool_title(name: &str) -> Option<&'static str> {
    Some(match name {
        "ssh_exec" => "Run SSH command",
        "ssh_exec_sudo" => "Run SSH command with sudo",
        "ssh_multi_exec" => "Run SSH command on several connections",
        "ssh_terminal_input" => "Inject terminal input",
        "ssh_run_bg" => "Start background SSH task",
        "ssh_task_status" => "Poll background SSH task",
        "ssh_metrics" => "Collect server metrics",
        "docker_list" => "List Docker containers",
        "docker_action" => "Manage Docker container",
        "ssh_alert_triage" => "SSH alert triage",
        "ssh_close" => "Close SSH connection",
        "ssh_test_connection" => "Test SSH connection",
        "ssh_list_known_hosts" => "List known hosts",
        "ssh_list_connections" => "List SSH connections",
        "ssh_remove_known_host" => "Remove known host",
        "ssh_quick_sudo_profiles_list" => "List Quick Sudo profiles",
        "ssh_quick_sudo_profiles_save" => "Save Quick Sudo profile",
        "ssh_quick_sudo_profiles_delete" => "Delete Quick Sudo profile",
        "sftp_list_dir" => "List remote directory",
        "sftp_stat" => "Stat remote path",
        "sftp_exists" => "Check remote path exists",
        "sftp_pwd" => "Remote home directory",
        "sftp_upload" => "Upload file over SFTP",
        "sftp_download" => "Download file over SFTP",
        "sftp_read_file" => "Read remote file",
        "sftp_write_file" => "Write remote file",
        "sftp_mkdir" => "Create remote directory",
        "sftp_remove" => "Remove remote path",
        "sftp_rename" => "Rename remote path",
        "sftp_chmod" => "Change remote permissions",
        "sftp_copy" => "Copy remote files",
        "sftp_move" => "Move remote files",
        "sftp_disk_usage" => "Remote disk usage",
        _ => return None,
    })
}

pub fn tool_definitions() -> Value {
    let mut tools = json!([
        {
            "name": "ssh_exec",
            "description": "Run a non-interactive remote shell command over SSH. Quick Sudo orchestration is NOT applied; use ssh_exec_sudo for privileged commands. Commands matching catastrophic patterns (disk formatting, recursive system deletes, shutdown, raw device writes, SQL DROP) require confirmDestructive: true; on read-only connections only whitelisted inspection commands (ls, cat, df, ps, systemctl status, journalctl, docker ps, ...) are allowed. Hosts commonly give up waiting after ~15s regardless of timeoutSecs while the command keeps running remotely (and further calls to this server stall until it finishes) - for anything that may exceed ~10s use ssh_run_bg + ssh_task_status instead. After a timeout the command may STILL be running: verify before rerunning.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("command", "string", "Shell command to execute"),
                    ("timeoutSecs", "integer", "Plugin-side wait cap in seconds (5-300, default 60). The MCP host may abandon the wait earlier (~15s); the command keeps running remotely either way"),
                    ("confirmDestructive", "boolean", "Set true to allow a command recognized as destructive (disk formatting, recursive system deletes, shutdown, ...) after human review"),
                    ("runInTerminal", "boolean", "Run inside the user's visible DBX terminal so the command and its output are visible and interruptible. Through the DBX embedded bridge it routes to the open workbench terminal; in stdio mode it is forwarded to the DBX app bridge (requires a saved connectionId that exists in the DBX app). This is yours to decide as the agent: set true when the task needs visibility, human oversight, or interactivity. Elevated commands run only after the user approves them in the terminal; the connection-level terminal MCP mode (toggled in the DBX terminal toolbar, persisted across restarts) decides when the flag is omitted: modes other than off route every exec through the visible terminal, off keeps the silent hidden channel"),
                ]),
                "required": ["command"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_exec_sudo",
            "description": "Run a remote shell command with sudo. The sudo password is piped over stdin and 2FA/TOTP prompts are answered automatically when a TOTP secret is available (inline arguments, or a shared global Quick Sudo profile referenced by quickSudoProfile; explicit arguments win). Commands matching catastrophic patterns require confirmDestructive: true; refused outright on read-only connections. Same wait-cap caveat as ssh_exec: hosts may stop waiting after ~15s; prefer short commands and keep long privileged jobs under ssh_run_bg.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("command", "string", "Shell command to execute with sudo"),
                    ("timeoutSecs", "integer", "Plugin-side wait cap in seconds (5-300, default 90). The MCP host may abandon the wait earlier (~15s); the command keeps running remotely either way"),
                    ("quickSudoProfile", "string", "Global Quick Sudo profile id or exact name supplying sudo password/TOTP/prompt defaults"),
                    ("confirmDestructive", "boolean", "Set true to allow a command recognized as destructive (disk formatting, recursive system deletes, shutdown, ...) after human review"),
                    ("runInTerminal", "boolean", "Run inside the user's visible DBX terminal so the command and its output are visible and interruptible. Through the DBX embedded bridge it routes to the open workbench terminal; in stdio mode it is forwarded to the DBX app bridge (requires a saved connectionId that exists in the DBX app). This is yours to decide as the agent: set true when the task needs visibility, human oversight, or interactivity. Elevated commands run only after the user approves them in the terminal; the connection-level terminal MCP mode (toggled in the DBX terminal toolbar, persisted across restarts) decides when the flag is omitted: modes other than off route every exec through the visible terminal, off keeps the silent hidden channel"),
                ]),
                "required": ["command"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_multi_exec",
            "description": "Run one command on several saved connections and collect per-target results (aggregate execution on the hidden channel; never routed through a visible terminal). targets: 1-10 connection references (connectionId or connectionName), deduplicated in order. mode: parallel (default) or sequential; stopOnError (sequential only) stops at the first failure. confirmDestructive: true covers catastrophic commands on every target; sudo is NOT available here - use single-target ssh_exec_sudo for escalation. Gates are evaluated per target: read-only connections only accept whitelisted inspection commands, and the MCP host may abandon the wait after ~15s while commands keep running - for anything slow use ssh_run_bg per target instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "targets": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10,
                                 "description": "Connection references (connectionId or connectionName); deduplicated preserving order" },
                    "command": { "type": "string", "description": "Shell command to run on every target" },
                    "mode": { "type": "string", "enum": ["parallel", "sequential"],
                              "description": "parallel (default) runs all targets concurrently; sequential walks them in order" },
                    "stopOnError": { "type": "boolean", "description": "Sequential mode only: stop before the next target once one fails (default false)" },
                    "timeoutSecs": { "type": "integer", "description": "Plugin-side wait cap per target (5-300)" },
                    "confirmDestructive": { "type": "boolean", "description": "Set true to allow a command recognized as catastrophic on all targets" },
                },
                "required": ["targets", "command"],
            },
        },
        {
            "name": "ssh_terminal_input",
            "description": "Inject raw input (interactive answers, Ctrl+C, escape sequences) into the connection's LIVE DBX terminal so the human can watch it happen; the terminal must already be open. Newlines (\\n, \\r\\n) fold to Enter (\\r), NUL is stripped, and the input is capped at 8 KiB. appendNewline (default false) appends one Enter - set it to run a typed command, leave it off for prompt answers or control keys. Output is NOT collected (the terminal itself shows it); for captured output use ssh_exec with runInTerminal: true. Gates: read-only connections only accept control-only input; catastrophic lines require confirmDestructive: true; sudo lines must match the connection's sudo whitelist when one is configured.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("input", "string", "Raw terminal input to inject; newlines fold to Enter (\\r)"),
                    ("appendNewline", "boolean", "Append one Enter after the input (default false; interactive answers usually carry their own \\r)"),
                    ("confirmDestructive", "boolean", "Set true to allow a line recognized as a catastrophic pattern (disk formatting, recursive deletes, shutdown, ...)"),
                ]),
                "required": ["input"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_run_bg",
            "description": "Start a long-running command detached on the remote host (nohup; output appended to /tmp/.dbx-ssh-tasks/<taskId>.log) and return immediately with taskId/pid/logPath. Survives disconnects, MCP-host wait caps, and session restarts because the output lives on the server. Poll progress with ssh_task_status(logPath). Same safety gates as ssh_exec: destructive patterns need confirmDestructive: true, read-only connections refuse it.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("command", "string", "Shell command to run detached"),
                    ("confirmDestructive", "boolean", "Set true to allow a command recognized as destructive (disk formatting, recursive system deletes, shutdown, ...) after human review"),
                ]),
                "required": ["command"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_task_status",
            "description": "Poll a background task started with ssh_run_bg: returns state (running/done/missing), exit code once finished, pid liveness, and the trailing bytes of output from the server-side log file. Reconnects transparently, so it works after disconnects or from a later session.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("logPath", "string", "logPath returned by ssh_run_bg"),
                    ("tailBytes", "integer", "Trailing bytes of output to return (200-16000, default 4000)"),
                ]),
                "required": ["logPath"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_metrics",
            "description": "Collect server metrics (CPU utilization, load, memory, swap, disk mounts with inode usage, uptime, per-interface network rx/tx rates, top 8 processes by CPU and by memory) using read-only commands. Pass sections to return only the named top-level sections and keep the response small.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[]),
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "docker_list",
            "description": "List Docker containers on a remote host (docker ps -a via read-only shell collection): name, image, state, status, ports, creation time. When the docker CLI is missing or the daemon socket is denied, available=false and containers=[] instead of an error; needsSudo=true marks the denied case, where lifecycle actions can still run through the connection's Quick Sudo credentials.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[]),
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "docker_action",
            "description": "Run a lifecycle action (start | stop | restart | kill | rm) on one remote Docker container. DESTRUCTIVE for rm (removes the container) and kill (SIGKILL): get explicit human confirmation in the frontend/dialog before sending them - start/stop/restart are reversible and do not need one. containerId must be 12-64 lowercase hex characters; the tool never accepts passwords. Plain execution first; only a daemon-socket permission failure retries through the connection's Quick Sudo credentials (piped over stdin, never the command line). Read-only connections are refused.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[
                    ("containerId", "string", "Container id (12-64 lowercase hex characters, as returned by docker_list)"),
                    ("action", "string", "Lifecycle action: start | stop | restart | kill | rm. rm/kill are destructive and need explicit human confirmation"),
                ]),
                "required": ["containerId", "action"],
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_alert_triage",
            "description": "Triage an ops alert OFFLINE (no SSH connection): normalizes a heterogeneous alert payload, classifies the intent by bilingual keyword scoring (cpu / memory / disk / oom / inode / network / service / generic), and returns a whitelist-safe diagnostic playbook. Pass the raw alert as a JSON string (fields like alertId/title/severity/source/message are recognized; unknown shapes degrade to generic). Read-only: nothing is executed and no suggestion contains sudo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "payload": { "type": "string", "description": "Raw alert payload as a JSON string; heterogeneous fields (alertId/title/severity/source/message/data) are normalized" },
                },
                "required": ["payload"],
            },
        },
        {
            "name": "ssh_close",
            "description": "Close the cached SSH/SFTP connection for a host after finishing work.",
            "inputSchema": {
                "type": "object",
                "properties": connection_properties(&[]),
                "anyOf": connection_selector_requirements(),
            },
        },
        {
            "name": "ssh_test_connection",
            "description": "Verify connectivity and authentication without running commands. Accepts inline SSH settings (including the jump chain) or a saved connection reference: connectionId / connectionName / a unique host+port+username endpoint resolve through the DBX app (app bridge or lifecycle registry), so no credentials need to travel in tool arguments.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[]), "anyOf": connection_selector_requirements() },
        },
        {
            "name": "ssh_list_known_hosts",
            "description": "List entries of the plugin's known_hosts store (the system ~/.ssh/known_hosts is never modified).",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "ssh_list_connections",
            "description": "List the DBX app's saved SSH connections for this plugin (id, name, host, port, username, authentication method, read-only flag) merged with connections registered in this MCP session. Metadata only: credentials are never included. Use an entry's id as connectionId, its name as connectionName, or its host+port+username as an endpoint reference on the connection-bound tools; a unique endpoint match reuses the saved connection without inline credentials.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "ssh_remove_known_host",
            "description": "Remove entries for host:port from the plugin's known_hosts store; use after a legitimate server reinstall.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "host": { "type": "string", "description": "Host name as recorded" },
                    "port": { "type": "integer", "description": "Port (default 22)" },
                },
                "required": ["host"],
            },
        },
        {
            "name": "ssh_quick_sudo_profiles_list",
            "description": "List the plugin's global Quick Sudo profiles: named sudo password/TOTP/prompt presets reusable across connections. Secrets are reported as configured flags only, never as values.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "ssh_quick_sudo_profiles_save",
            "description": "Create or update a global Quick Sudo profile (supply id to update). Empty sudoPassword/totpSecret keep the stored values; clearSudoPassword/clearTotpSecret remove them. Returns the profile without secrets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Profile id to update; omit to create" },
                    "name": { "type": "string", "description": "Unique display name (max 64 characters)" },
                    "sudoPassword": { "type": "string", "description": "Sudo password; empty keeps the stored one" },
                    "totpSecret": { "type": "string", "description": "TOTP secret (otpauth:// URI, base32 key, or static code); multiple secrets (newline/semicolon separated) rotate automatically — unexpired, unused codes first. Empty keeps the stored one" },
                    "clearSudoPassword": { "type": "boolean", "description": "Set true to remove the stored sudo password" },
                    "clearTotpSecret": { "type": "boolean", "description": "Set true to remove the stored TOTP secret" },
                    "authFlowMode": { "type": "string", "enum": ["password_only", "password_plus_otp", "password_then_otp"], "description": AUTH_FLOW_MODE_DESCRIPTION },
                    "passwordPromptHint": { "type": "string", "description": PASSWORD_PROMPT_HINT_DESCRIPTION },
                    "totpPromptHint": { "type": "string", "description": TOTP_PROMPT_HINT_DESCRIPTION },
                    "sudoUsePty": { "type": "boolean", "description": "Request a PTY for sudo executions using this profile" },
                },
                "required": ["name"],
            },
        },
        {
            "name": "ssh_quick_sudo_profiles_delete",
            "description": "Delete a global Quick Sudo profile by id. Connections bound to it fall back to their own sudo configuration.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Profile id" },
                },
                "required": ["id"],
            },
        },
        {
            "name": "sftp_list_dir",
            "description": "List a remote directory over SFTP. Names follow the connection's file-name encoding preference: on latin-1 connections entries are decoded from raw server bytes to display form, and a returned path passed back to sftp_mkdir/sftp_remove/sftp_rename addresses the same server bytes.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[("path", "string", "Remote directory path")]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_stat",
            "description": "Inspect a remote path over SFTP (size, permissions, timestamps).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[("path", "string", "Remote path")]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_exists",
            "description": "Check whether a remote path exists.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[("path", "string", "Remote path")]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_pwd",
            "description": "Return the remote login user's home directory (canonicalized absolute path over SFTP).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[]), "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_upload",
            "description": "Upload a local file to the remote server over SFTP (single file, no directory recursion). The local file must be readable by the MCP server process; size is capped by the configured maxUploadBytes.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("localPath", "string", "Local file path to upload"),
                ("remotePath", "string", "Remote file path to create"),
                ("overwrite", "boolean", "Set true to replace an existing remote file"),
            ]), "required": ["localPath", "remotePath"] },
        },
        {
            "name": "sftp_download",
            "description": "Download a remote file to a local path over SFTP (single file). Remote size is capped by the configured maxDownloadBytes; missing local parent directories are created. Shell/cron/systemd bootstrap paths are refused as local targets, and on read-only connections credential paths are refused as remote sources.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("remotePath", "string", "Remote file path to download"),
                ("localPath", "string", "Local target file path"),
                ("overwrite", "boolean", "Set true to replace an existing local file"),
            ]), "required": ["remotePath", "localPath"] },
        },
        {
            "name": "sftp_read_file",
            "description": "Read a remote file (text by default, or base64). Truncates at maxBytes; default and ceiling come from the plugin's MCP size settings. Pass offset to continue reading from a byte position (empty result at/after EOF).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("path", "string", "Remote file path"),
                ("maxBytes", "integer", "Maximum bytes to read; clamped to the configured maxDownloadBytes (base64 field ignored)"),
                ("offset", "integer", "Byte offset to start reading from (default 0)"),
                ("base64", "boolean", "Set true to return base64 instead of UTF-8 text"),
            ]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_write_file",
            "description": "Write a remote file with UTF-8 content. Existing files require overwrite=true; content is capped at the configured maxUploadBytes.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("path", "string", "Remote file path"),
                ("content", "string", "File content (UTF-8 text)"),
                ("overwrite", "boolean", "Set true to replace an existing file"),
            ]), "required": ["path", "content"] },
        },
        {
            "name": "sftp_mkdir",
            "description": "Create a remote directory. Paths follow the same display convention as sftp_list_dir responses (on latin-1 connections a display path maps back to the original server bytes).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[("path", "string", "Remote directory path")]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_remove",
            "description": "Remove a remote file or directory (directories need recursive=true). Paths follow the same display convention as sftp_list_dir responses (on latin-1 connections a display path maps back to the original server bytes).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("path", "string", "Remote path"),
                ("recursive", "boolean", "Set true to remove directories recursively"),
            ]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
        {
            "name": "sftp_rename",
            "description": "Rename or move a remote path. Paths follow the same display convention as sftp_list_dir responses (on latin-1 connections display paths map back to the original server bytes).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("sourcePath", "string", "Existing remote path"),
                ("targetPath", "string", "New remote path"),
            ]), "required": ["sourcePath", "targetPath"] },
        },
        {
            "name": "sftp_chmod",
            "description": "Change permission bits of a remote path (octal, e.g. 0644).",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("path", "string", "Remote path"),
                ("mode", "string", "Octal permission value such as 0644 or 0755. Strings are read as octal digits (an optional 0o prefix is accepted); a number with only 0-7 digits (e.g. 644) is read as octal digits, any other number (e.g. 384 = 0o600) as raw permission bits"),
            ]), "required": ["path", "mode"] },
        },
        {
            "name": "sftp_copy",
            "description": "Copy remote files or directories into a target directory on the same server (recursive, preserves permissions; write operation). Existing targets require overwrite=true.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("from", "string", "Remote source path, or an array of source paths"),
                ("toDir", "string", "Existing remote directory that receives the copies"),
                ("overwrite", "boolean", "Set true to replace existing targets"),
            ]), "required": ["from", "toDir"] },
        },
        {
            "name": "sftp_move",
            "description": "Move remote files or directories into a target directory on the same server (the sources are removed; write operation). Existing targets require overwrite=true.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[
                ("from", "string", "Remote source path, or an array of source paths"),
                ("toDir", "string", "Existing remote directory that receives the moved items"),
                ("overwrite", "boolean", "Set true to replace existing targets"),
            ]), "required": ["from", "toDir"] },
        },
        {
            "name": "sftp_disk_usage",
            "description": "Report filesystem usage for the mount containing a remote path.",
            "inputSchema": { "type": "object", "properties": connection_properties(&[("path", "string", "Remote path")]), "required": ["path"], "anyOf": connection_selector_requirements() },
        },
    ]);
    // Connection-bound tools share the selector alternatives; add them here
    // after the compact JSON declarations so path/command required fields
    // stay independent from connection addressing. Every tool additionally
    // gets its advisory annotations (see `tool_annotations`).
    if let Some(tool_list) = tools.as_array_mut() {
        for tool in tool_list {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let is_connection_bound = matches!(
                name.as_str(),
                "sftp_list_dir"
                    | "sftp_stat"
                    | "sftp_exists"
                    | "sftp_pwd"
                    | "sftp_upload"
                    | "sftp_download"
                    | "sftp_read_file"
                    | "sftp_write_file"
                    | "sftp_mkdir"
                    | "sftp_remove"
                    | "sftp_rename"
                    | "sftp_chmod"
                    | "sftp_copy"
                    | "sftp_move"
                    | "sftp_disk_usage"
            );
            if !is_connection_bound {
                tool["annotations"] = tool_annotations(&name);
            } else {
                if let Some(schema) = tool.get_mut("inputSchema").and_then(Value::as_object_mut) {
                    schema.insert("anyOf".to_string(), connection_selector_requirements());
                }
                tool["annotations"] = tool_annotations(&name);
            }
            // ssh_metrics advertises its optional sections projection
            // (declared post-hoc: the property carries a dynamic enum from
            // METRICS_SECTIONS, which the compact literal cannot inline).
            if name == "ssh_metrics" {
                if let Some(props) = tool
                    .pointer_mut("/inputSchema/properties")
                    .and_then(Value::as_object_mut)
                {
                    props.insert(
                        "sections".to_string(),
                        json!({
                            "type": "array",
                            "items": { "type": "string", "enum": exec::METRICS_SECTIONS },
                            "uniqueItems": true,
                            "description": "Optional projection onto top-level sections (hostname, kernel, uptimeSeconds, cpu, memory, disks, network, processes, topMemory, osId, osPretty); a single name string is accepted too. Omit for the full document"
                        }),
                    );
                }
            }
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> McpState {
        // Unique data dir per call: settings persistence (limits AND the
        // §1.3 permission keys) must not leak across parallel tests.
        McpState::new(std::env::temp_dir().join(format!("dbx-mcp-test-{}", uuid::Uuid::new_v4())))
    }

    // —— §1.3 confirm 档 + connectionScope ——

    #[test]
    fn scope_allows_matches_id_name_and_host() {
        let scope = |entries: &[&str]| -> Vec<String> {
            entries.iter().map(|entry| entry.to_string()).collect()
        };
        // 空 entry 列表本身不授予权限；持久化空数组会在 ConnectionScope
        // 层映射为 Unrestricted，显式空环境变量则映射为 DenyAll。
        assert!(!scope_allows(&[], "c1", Some("prod"), "db.local"));
        let entries = scope(&["conn-9", "ops@LEGACY", "Web-01"]);
        assert!(scope_allows(&entries, "conn-9", None, "other.local"));
        assert!(scope_allows(&entries, "other-id", Some("ops@LEGACY"), "x")); // name 精确（大小写敏感）
        assert!(scope_allows(&entries, "other-id", None, "web-01")); // host 大小写不敏感
        assert!(!scope_allows(
            &entries,
            "other-id",
            Some("prod"),
            "db.local"
        ));
        assert!(!scope_allows(&entries, "other-id", None, "db.local"));
    }

    #[test]
    fn env_permission_parsers_distinguish_unset_allowlist_and_deny_all() {
        assert_eq!(
            permission_mode_from_env(|_| Some("confirm".to_string())).as_deref(),
            Some("confirm")
        );
        // 未设置/未知值不覆盖。
        assert!(permission_mode_from_env(|_| None).is_none());
        assert!(permission_mode_from_env(|_| Some("yolo".to_string())).is_none());
        assert_eq!(
            scope_from_env(|_| Some(" a , b,,c ".to_string())),
            Some(ConnectionScope::AllowList(vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
            ]))
        );
        // 显式空列表是有效的 fail-closed 覆盖，绝不能与持久化空数组
        // （未限制）复用同一种状态。
        assert_eq!(
            scope_from_env(|_| Some(" , ".to_string())),
            Some(ConnectionScope::DenyAll)
        );
        assert!(scope_from_env(|_| None).is_none());
    }

    #[test]
    fn connection_scope_policy_preserves_persisted_empty_as_unrestricted() {
        assert!(ConnectionScope::from_persisted(Vec::new()).allows("id", Some("name"), "host"));
        assert!(!ConnectionScope::DenyAll.allows("id", Some("name"), "host"));
        assert!(ConnectionScope::AllowList(vec!["host".to_string()]).allows("id", None, "HOST"));
    }

    #[test]
    fn confirm_gate_set_covers_exec_family_and_spares_read_tools() {
        for gated in [
            "ssh_exec",
            "ssh_exec_sudo",
            "ssh_run_bg",
            "ssh_multi_exec",
            "ssh_terminal_input",
            "docker_action",
            "sftp_write_file",
            "sftp_upload",
            "sftp_remove",
        ] {
            assert!(is_confirm_gated_tool(gated), "{gated} should be gated");
        }
        for spared in [
            "ssh_close",
            "ssh_metrics",
            "docker_list",
            "ssh_test_connection",
            "sftp_list_dir",
            "sftp_read_file",
            "sftp_download",
            "ssh_alert_triage",
        ] {
            assert!(!is_confirm_gated_tool(spared), "{spared} must not be gated");
        }
    }

    #[test]
    fn scoped_tool_set_excludes_local_tools() {
        for scoped in ["ssh_exec", "sftp_upload", "ssh_close", "ssh_task_status"] {
            assert!(is_connection_scoped_tool(scoped), "{scoped}");
        }
        for local in [
            "ssh_list_connections",
            "ssh_list_known_hosts",
            "ssh_remove_known_host",
            "ssh_quick_sudo_profiles_list",
            "ssh_alert_triage",
        ] {
            assert!(!is_connection_scoped_tool(local), "{local}");
        }
    }

    #[test]
    fn every_tool_carries_complete_annotations() {
        let definitions = tool_definitions();
        let tools = definitions.as_array().unwrap();
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let annotations = &tool["annotations"];
            let obj = annotations
                .as_object()
                .unwrap_or_else(|| panic!("{name} lacks annotations"));
            for hint in [
                "readOnlyHint",
                "destructiveHint",
                "idempotentHint",
                "openWorldHint",
            ] {
                assert!(
                    obj.get(hint).and_then(Value::as_bool).is_some(),
                    "{name} annotations lack boolean {hint}"
                );
            }
            assert!(
                obj.get("title").and_then(Value::as_str).is_some(),
                "{name} annotations lack a title"
            );
        }
    }

    #[test]
    fn annotation_hints_align_with_gate_classification() {
        let definitions = tool_definitions();
        let annotations = |name: &str| {
            definitions
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("{name} missing from tools/list"))["annotations"]
                .clone()
        };
        // Provably read-only: the whole set the confirm gate spares for
        // being read-only (plus ssh_close, which is also spared).
        for name in [
            "ssh_list_connections",
            "ssh_list_known_hosts",
            "ssh_quick_sudo_profiles_list",
            "ssh_metrics",
            "docker_list",
            "ssh_alert_triage",
            "ssh_test_connection",
            "ssh_task_status",
            "sftp_list_dir",
            "sftp_stat",
            "sftp_exists",
            "sftp_pwd",
            "sftp_read_file",
            "sftp_disk_usage",
        ] {
            let a = annotations(name);
            assert_eq!(a["readOnlyHint"], true, "{name} should be readOnly");
            assert_eq!(
                a["destructiveHint"], false,
                "{name} should not be destructive"
            );
        }
        // Exec family and remove/move/overwrite/delete tools advertise
        // destructive so clients gate them like the confirm gate does.
        for name in [
            "ssh_exec",
            "ssh_exec_sudo",
            "ssh_multi_exec",
            "ssh_terminal_input",
            "ssh_run_bg",
            "docker_action",
            "ssh_remove_known_host",
            "ssh_quick_sudo_profiles_delete",
            "sftp_remove",
            "sftp_move",
            "sftp_copy",
            "sftp_upload",
            "sftp_download",
            "sftp_write_file",
        ] {
            let a = annotations(name);
            assert_eq!(a["readOnlyHint"], false, "{name} should not be readOnly");
            assert_eq!(a["destructiveHint"], true, "{name} should be destructive");
        }
        // Mutating but non-destructive writes.
        for name in [
            "sftp_mkdir",
            "sftp_rename",
            "sftp_chmod",
            "ssh_quick_sudo_profiles_save",
        ] {
            let a = annotations(name);
            assert_eq!(a["readOnlyHint"], false, "{name}");
            assert_eq!(a["destructiveHint"], false, "{name}");
        }
        // Closed-world: alert triage runs fully offline.
        assert_eq!(annotations("ssh_alert_triage")["openWorldHint"], false);
        assert_eq!(annotations("ssh_exec")["openWorldHint"], true);
        // Every declared tool is covered by the explicit sets — no tool may
        // slip through with unreviewed hints.
        let tools = definitions.as_array().unwrap();
        assert_eq!(
            tools.len(),
            33,
            "tool count changed; revisit annotation sets"
        );
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let a = &tool["annotations"];
            assert_eq!(
                a["readOnlyHint"].as_bool().unwrap(),
                matches!(
                    name,
                    "ssh_list_connections"
                        | "ssh_list_known_hosts"
                        | "ssh_quick_sudo_profiles_list"
                        | "ssh_metrics"
                        | "docker_list"
                        | "ssh_alert_triage"
                        | "ssh_test_connection"
                        | "ssh_task_status"
                        | "sftp_list_dir"
                        | "sftp_stat"
                        | "sftp_exists"
                        | "sftp_pwd"
                        | "sftp_read_file"
                        | "sftp_disk_usage"
                ),
                "{name} readOnlyHint drift"
            );
        }
    }

    #[test]
    fn metrics_sections_argument_shapes_and_fail_fast() {
        // 缺省/null → None（返回全量文档）。
        assert_eq!(metrics_sections(&json!({})).unwrap(), None);
        assert_eq!(
            metrics_sections(&json!({ "sections": null })).unwrap(),
            None
        );
        // 单字符串 / 数组两种形态都收（LLM 容错）。
        assert_eq!(
            metrics_sections(&json!({ "sections": "cpu" })).unwrap(),
            Some(vec!["cpu".to_string()])
        );
        assert_eq!(
            metrics_sections(&json!({ "sections": ["cpu", "memory"] })).unwrap(),
            Some(vec!["cpu".to_string(), "memory".to_string()])
        );
        // 空数组拒绝：绝不能把"没点名"误当"全量"。
        assert!(metrics_sections(&json!({ "sections": [] })).is_err());
        // 未知段名 fail-fast 并列出合法段（拨号前拒绝）。
        let error = metrics_sections(&json!({ "sections": ["memry"] })).unwrap_err();
        assert!(error.contains("Unknown section: 'memry'"), "{error}");
        assert!(error.contains("topMemory"), "{error}");
        // 非字符串项精确报错。
        assert!(metrics_sections(&json!({ "sections": [42] })).is_err());
    }

    #[test]
    fn metrics_schema_advertises_sections_projection() {
        let definitions = tool_definitions();
        let metrics = definitions
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "ssh_metrics")
            .unwrap();
        let sections = &metrics["inputSchema"]["properties"]["sections"];
        assert_eq!(sections["type"], "array");
        let enum_names: Vec<&str> = sections["items"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(enum_names, exec::METRICS_SECTIONS);
    }

    #[test]
    fn settings_roundtrip_permission_fields_and_env_override() {
        let state = state();
        // 默认 autonomous + 空作用域。
        let view = state.settings_get();
        assert_eq!(view["execPermissionMode"], "autonomous");
        assert_eq!(view["connectionScope"], json!([]));
        // 合法更新。
        let updated = state
            .settings_set(&json!({
                "execPermissionMode": "confirm",
                "connectionScope": ["conn-1", "Prod-DB"],
            }))
            .unwrap();
        assert_eq!(updated["execPermissionMode"], "confirm");
        assert_eq!(updated["connectionScope"], json!(["conn-1", "Prod-DB"]));
        assert_eq!(updated["persistedExecPermissionMode"], "confirm");
        // 非法 mode / 非 scope 数组被拒绝。
        assert!(state
            .settings_set(&json!({ "execPermissionMode": "yolo" }))
            .is_err());
        assert!(state
            .settings_set(&json!({ "connectionScope": "conn-1" }))
            .is_err());
        // 重读（含从盘加载路径）不丢。
        let reloaded = McpPermission::load(&state.limits_path);
        assert_eq!(reloaded.exec_permission_mode, "confirm");
        assert_eq!(
            reloaded.connection_scope,
            vec!["conn-1".to_string(), "Prod-DB".to_string()]
        );
        // size-limit 键与 permission 键同文件共存（merge 写入）。
        state
            .settings_set(&json!({ "maxReadBytes": 4096 }))
            .unwrap();
        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(&state.limits_path).unwrap()).unwrap();
        assert_eq!(document["maxReadBytes"], 4096);
        assert_eq!(document["execPermissionMode"], "confirm");
    }

    #[test]
    fn connection_list_result_filters_by_scope() {
        let stored = || {
            StoredConnection::from_lifecycle_params(&json!({
                "connection": { "id": "conn-1", "name": "prod", "host": "db.local",
                                "port": 22, "username": "ops", "password": "pw" }
            }))
            .unwrap()
        };
        // 持久化空作用域映射为未限制：两来源都全量。
        let all = connection_list_result(
            Ok(vec![
                json!({"id":"conn-9","name":"staging","host":"stg.local"}),
            ]),
            &[stored()],
            &ConnectionScope::Unrestricted,
        );
        assert_eq!(all["connections"].as_array().unwrap().len(), 2);
        // host 作用域：bridge 条目按 host 过滤，registry 条目按 id/name/host。
        let filtered = connection_list_result(
            Ok(vec![
                json!({"id":"conn-9","name":"staging","host":"stg.local"}),
                json!({"id":"conn-1","name":"prod","host":"db.local"}),
            ]),
            &[stored()],
            &ConnectionScope::AllowList(vec!["db.local".to_string()]),
        );
        let ids: Vec<&str> = filtered["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["conn-1"]);
        // registry 降级路径同样过滤。
        let degraded = connection_list_result(
            Err("bridge down".to_string()),
            &[stored()],
            &ConnectionScope::AllowList(vec!["conn-9".to_string()]),
        );
        assert_eq!(degraded["connections"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn parses_bg_start_markers_with_default_log_fallback() {
        let (pid, log) = parse_bg_start_output(
            "PID=4242\nLOG=/tmp/.dbx-ssh-tasks/bg-1-2.log\n",
            "/tmp/.dbx-ssh-tasks/default.log".to_string(),
        );
        assert_eq!(pid, "4242");
        assert_eq!(log, "/tmp/.dbx-ssh-tasks/bg-1-2.log");

        // A remote without echo output (busybox edge) still yields the
        // derived default path.
        let (pid, log) = parse_bg_start_output("", "/tmp/.dbx-ssh-tasks/x.log".to_string());
        assert_eq!(pid, "");
        assert_eq!(log, "/tmp/.dbx-ssh-tasks/x.log");
    }

    #[test]
    fn parses_task_status_running_done_and_missing() {
        let (state, code, alive, tail) = parse_task_status_output(
            "STATE=RUNNING\nPID_ALIVE=yes\n===TAIL===\nstep 1 done\nstep 2 running\n",
        );
        assert_eq!(state, "running");
        assert_eq!(code, None);
        assert_eq!(alive, Some(true));
        assert_eq!(tail, "step 1 done\nstep 2 running\n");

        let (state, code, alive, _tail) =
            parse_task_status_output("STATE=DONE\nCODE=EXIT_3\nPID_ALIVE=no\n===TAIL===\nEXIT_3\n");
        assert_eq!(state, "done");
        assert_eq!(code, Some(3));
        assert_eq!(alive, Some(false));

        let (state, code, alive, tail) = parse_task_status_output("STATE=MISSING\n===TAIL===\n");
        assert_eq!(state, "missing");
        assert_eq!(code, None);
        assert_eq!(alive, None);
        assert_eq!(tail, "");
    }

    #[tokio::test]
    async fn run_bg_respects_read_only_gate() {
        let mut state = state();
        state.global_read_only = true;
        let error = state
            .call_tool(
                "ssh_run_bg",
                &json!({
                    "host": "example.test",
                    "username": "op",
                    "command": "sleep 30"
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("read-only"),
            "expected read-only refusal, got: {error}"
        );
    }

    #[tokio::test]
    async fn inline_dial_inherits_registered_read_only_gate() {
        let state = state();
        // All credential values in tests are assembled at runtime — never
        // real credentials, never literals in source.
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-ro",
                "host": "prod.example.test",
                "port": 2222,
                "username": "deploy",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
                "read_only": true,
            }
        }))
        .unwrap();
        assert!(stored.read_only, "lifecycle payload must carry read_only");
        state
            .dbx_connections
            .write()
            .await
            .insert("conn-ro".to_string(), stored);
        // Same endpoint re-dialed inline (no connectionId, host case-insensitive):
        // the read-only gate still applies to write tools — the error fires
        // before run_tool, so no localPath is needed to distinguish it from
        // a plain validation error.
        let error = state
            .call_tool(
                "sftp_upload",
                &json!({
                    "host": "PROD.example.test",
                    "port": 2222,
                    "username": "deploy",
                    "remotePath": "/tmp/x",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("read-only"),
            "expected read-only refusal for inline dial of a registered host, got: {error}"
        );
        // A different username or host is not covered by that registration.
        for identity in [
            json!({"host": "prod.example.test", "port": 2222, "username": "other"}),
            json!({"host": "other.example.test", "username": "deploy"}),
        ] {
            let error = state
                .call_tool("sftp_upload", &identity, None)
                .await
                .unwrap_err();
            assert!(
                !error.contains("read-only"),
                "expected non-matching identity to pass the gate, got: {error}"
            );
        }
    }

    #[tokio::test]
    async fn sudo_allowlist_gates_privileged_tools() {
        let state = state();
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-sudo-list",
                "host": "web.example.test",
                "port": 22,
                "username": "deploy",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
                "external_config": {
                    "sudo_whitelist": "systemctl restart nginx\ndocker restart *"
                },
            }
        }))
        .unwrap();
        assert_eq!(stored.sudo_whitelist.len(), 2, "external_config must parse");
        state
            .dbx_connections
            .write()
            .await
            .insert("conn-sudo-list".to_string(), stored);

        // ssh_exec_sudo with an unlisted command: refused, patterns listed.
        let error = state
            .call_tool(
                "ssh_exec_sudo",
                &json!({
                    "connectionId": "conn-sudo-list",
                    "command": "systemctl restart mysql",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("not allowed by this connection's whitelist")
                && error.contains("docker restart *"),
            "expected allowlist refusal, got: {error}"
        );

        // A matching command passes the gate and fails later (no dial here).
        let error = state
            .call_tool(
                "ssh_exec_sudo",
                &json!({
                    "connectionId": "conn-sudo-list",
                    "command": "docker restart api",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("whitelist"),
            "expected matching command to pass the gate, got: {error}"
        );

        // Inline `sudo …` inside plain ssh_exec is gated too.
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({
                    "connectionId": "conn-sudo-list",
                    "command": "sudo systemctl restart mysql",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("not allowed by this connection's whitelist"),
            "expected inline-sudo refusal, got: {error}"
        );

        // Inline identity fallback: re-dialing the same host without a
        // connectionId inherits the whitelist; a different host does not.
        let error = state
            .call_tool(
                "ssh_exec_sudo",
                &json!({
                    "host": "web.example.test",
                    "username": "deploy",
                    "command": "reboot",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("not allowed by this connection's whitelist"),
            "expected identity-fallback refusal, got: {error}"
        );
        let error = state
            .call_tool(
                "ssh_exec_sudo",
                &json!({
                    "host": "other.example.test",
                    "username": "deploy",
                    "command": "reboot",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("whitelist"),
            "expected other host to skip the allowlist, got: {error}"
        );
    }

    #[tokio::test]
    async fn read_only_tools_respect_sensitive_path_denylist() {
        let mut read_only_state = state();
        read_only_state.global_read_only = true;
        for (name, arguments) in [
            (
                "sftp_read_file",
                json!({"host": "h.test", "username": "op", "path": "/root/.ssh/id_rsa"}),
            ),
            (
                "sftp_list_dir",
                json!({"host": "h.test", "username": "op", "path": "/root/.ssh"}),
            ),
            (
                "sftp_download",
                json!({"host": "h.test", "username": "op", "remotePath": "/etc/shadow",
                       "localPath": "/tmp/dbx-denylist-test"}),
            ),
            (
                "ssh_task_status",
                json!({"host": "h.test", "username": "op", "logPath": "/root/.bash_history"}),
            ),
        ] {
            let error = read_only_state
                .call_tool(name, &arguments, None)
                .await
                .unwrap_err();
            assert!(
                error.contains("sensitive"),
                "expected sensitive-path refusal for {name}, got: {error}"
            );
        }
        // Ordinary inspection paths still pass the gate (they fail later, at
        // the dial).
        let error = read_only_state
            .call_tool(
                "sftp_read_file",
                &json!({"host": "h.test", "username": "op", "path": "/var/log/app.log"}),
                None,
            )
            .await
            .unwrap_err();
        assert!(!error.contains("sensitive"), "got: {error}");
        // On normal connections the denylist does not apply — the operator
        // already grants full access.
        let normal_state = state();
        let error = normal_state
            .call_tool(
                "sftp_read_file",
                &json!({"host": "h.test", "username": "op", "path": "/root/.ssh/id_rsa"}),
                None,
            )
            .await
            .unwrap_err();
        assert!(!error.contains("sensitive"), "got: {error}");
    }

    #[tokio::test]
    async fn exec_whitelist_refuses_sensitive_paths_on_read_only() {
        let mut state = state();
        state.global_read_only = true;
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "h.test",
                    "username": "op",
                    "command": "cat /root/.ssh/id_rsa",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("not recognized"),
            "expected whitelist refusal for a sensitive path, got: {error}"
        );
    }

    #[tokio::test]
    async fn sftp_download_refuses_sensitive_local_targets() {
        let state = state();
        for local in [
            "/home/u/.bashrc",
            "/home/u/.ssh/authorized_keys",
            "/etc/cron.d/payload",
            "/Library/LaunchDaemons/com.example.payload.plist",
        ] {
            let error = state
                .call_tool(
                    "sftp_download",
                    &json!({
                        "host": "h.test",
                        "username": "op",
                        "remotePath": "/tmp/payload.sh",
                        "localPath": local,
                    }),
                    None,
                )
                .await
                .unwrap_err();
            assert!(
                error.contains("Refusing to write the local sensitive path"),
                "expected local denylist refusal for {local}, got: {error}"
            );
        }
        // Ordinary destinations pass the denylist (they fail later, at the
        // dial).
        let error = state
            .call_tool(
                "sftp_download",
                &json!({
                    "host": "h.test",
                    "username": "op",
                    "remotePath": "/tmp/payload.sh",
                    "localPath": "/tmp/dbx-download-ok/payload.sh",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("Refusing to write"),
            "expected plain target to pass the denylist, got: {error}"
        );
    }

    #[test]
    fn connection_tools_declare_connection_id() {
        // Strict MCP hosts drop arguments the input schema does not declare,
        // so connection selectors must be advertised for both stdio routing
        // and saved-connection reuse. The selector anyOf is checked below so
        // strict clients can call with id, name, or endpoint fields.
        let tools = tool_definitions();
        let array = tools.as_array().unwrap();
        for name in [
            "ssh_exec",
            "ssh_exec_sudo",
            "ssh_run_bg",
            "ssh_terminal_input",
            "ssh_task_status",
            "ssh_metrics",
            "ssh_test_connection",
            "sftp_list_dir",
            "sftp_upload",
        ] {
            let properties = array
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("tool {name} missing from definitions"))["inputSchema"]
                ["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("tool {name} schema has no properties object"));
            for key in ["connectionId", "connectionName"] {
                let schema = properties
                    .get(key)
                    .unwrap_or_else(|| panic!("tool {name} schema does not declare {key}"));
                assert_eq!(schema["type"], "string", "tool {name} {key} type");
            }
            assert!(
                array.iter().find(|tool| tool["name"] == name).unwrap()["inputSchema"]["anyOf"]
                    .as_array()
                    .is_some(),
                "tool {name} must accept a saved id/name or endpoint"
            );
        }
    }

    // —— ssh_terminal_input 门矩阵（IMPL_PLAN_NETCATTY A2-T5）———

    #[test]
    fn terminal_input_gate_read_only_only_allows_control_sequences() {
        // 纯控制序列（回车/Ctrl+C）在只读连接放行。
        assert!(terminal_input_gate("\r", true, false, &[]).is_ok());
        assert!(terminal_input_gate("\u{3}", true, false, &[]).is_ok());
        assert!(terminal_input_gate("", true, false, &[]).is_ok());
        // 任何可见文本（哪怕只读命令）都拒绝：终端注入不在只读白名单模型内。
        let error = terminal_input_gate("echo hi\r", true, false, &[]).unwrap_err();
        assert!(error.contains("read-only"), "{error}");
    }

    #[test]
    fn terminal_input_gate_destructive_lines_need_confirmation() {
        // 灾难行（递归删除系统根）：无确认拒绝，确认放行（可写连接）。
        // 非灾难目标的 rm -rf /tmp/x 只是 Unknown 写操作，不触发本门。
        let error = terminal_input_gate("rm -rf /\r", false, false, &[]).unwrap_err();
        assert!(error.contains("destructive"), "{error}");
        assert!(terminal_input_gate("rm -rf /\r", false, true, &[]).is_ok());
        // 只读连接上灾难行即使带确认也拒绝（与 ssh_exec 一致）。
        let error = terminal_input_gate("rm -rf /\r", true, true, &[]).unwrap_err();
        assert!(error.contains("read-only"), "{error}");
        // 多行取最坏：干净行 + 灾难行整体拒绝。
        let error = terminal_input_gate("df -h\rrm -rf /\r", false, false, &[]).unwrap_err();
        assert!(error.contains("destructive"), "{error}");
    }

    #[test]
    fn terminal_input_gate_sudo_lines_follow_the_allowlist() {
        // 连接声明了白名单：sudo 行必须命中条目。
        let allowlist = vec![vec![
            "systemctl".to_string(),
            "restart".to_string(),
            "*".to_string(),
        ]];
        let error =
            terminal_input_gate("sudo yum update -y\r", false, false, &allowlist).unwrap_err();
        assert!(error.contains("whitelist"), "{error}");
        assert!(
            terminal_input_gate("sudo systemctl restart nginx\r", false, false, &allowlist).is_ok()
        );
        // 未声明白名单的连接不做该门（行为与 ssh_exec 一致）。
        assert!(terminal_input_gate("sudo yum update -y\r", false, false, &[]).is_ok());
    }

    #[tokio::test]
    async fn run_bg_requires_destructive_confirmation() {
        let state = state();
        let error = state
            .call_tool(
                "ssh_run_bg",
                &json!({
                    "host": "example.test",
                    "username": "op",
                    "command": "rm -rf /"
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("destructive"),
            "expected destructive refusal, got: {error}"
        );
    }

    #[test]
    fn pre_exec_transport_errors_are_retryable_post_exec_are_not() {
        assert!(exec::is_pre_exec_transport_error(
            "Failed to open exec channel: Disconnected"
        ));
        assert!(exec::is_pre_exec_transport_error(
            "Failed to start command: broken pipe"
        ));
        // Post-exec failures must NOT look retryable: the command may have
        // already run server-side.
        assert!(!exec::is_pre_exec_transport_error(
            "Timed out waiting for the remote command to finish."
        ));
        assert!(!exec::is_pre_exec_transport_error(
            "sudo exited 1: wrong password"
        ));
    }

    #[tokio::test]
    async fn initialize_and_list_tools_follow_mcp_shape() {
        let state = state();
        let init = state
            .dispatch(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }))
            .await
            .unwrap();
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(init["result"]["capabilities"]["tools"].is_object());
        // 同族基线：serverInfo.name 用完整插件 id（files/ldap/kafka 同款）。
        assert_eq!(init["result"]["serverInfo"]["name"], "io.dbx.ssh");

        let list = state
            .dispatch(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }))
            .await
            .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        for expected in [
            "ssh_exec",
            "ssh_exec_sudo",
            "ssh_run_bg",
            "ssh_terminal_input",
            "ssh_multi_exec",
            "ssh_task_status",
            "ssh_metrics",
            "ssh_close",
            "ssh_test_connection",
            "ssh_list_known_hosts",
            "ssh_list_connections",
            "ssh_remove_known_host",
            "ssh_quick_sudo_profiles_list",
            "ssh_quick_sudo_profiles_save",
            "ssh_quick_sudo_profiles_delete",
            "sftp_list_dir",
            "sftp_stat",
            "sftp_exists",
            "sftp_pwd",
            "sftp_read_file",
            "sftp_write_file",
            "sftp_mkdir",
            "sftp_remove",
            "sftp_rename",
            "sftp_chmod",
            "sftp_copy",
            "sftp_move",
            "sftp_disk_usage",
            "sftp_upload",
            "sftp_download",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert!(tools
            .iter()
            .all(|tool| tool["inputSchema"]["type"] == "object"));

        // The discovery tool takes no arguments (same shape as
        // ssh_list_known_hosts) and points at the reference parameters.
        let discovery = tools
            .iter()
            .find(|t| t["name"] == "ssh_list_connections")
            .unwrap();
        assert!(
            discovery["inputSchema"]["properties"]
                .as_object()
                .unwrap()
                .is_empty(),
            "ssh_list_connections must take no arguments"
        );
        assert!(
            discovery["description"]
                .as_str()
                .unwrap()
                .contains("connectionId"),
            "description must explain how to use the entries"
        );

        // The read tool exposes the offset knob so MCP clients can page
        // through files; the metrics tool advertises the extended dimensions.
        let read = tools
            .iter()
            .find(|t| t["name"] == "sftp_read_file")
            .unwrap();
        let props = read["inputSchema"]["properties"].as_object().unwrap();
        assert!(props.contains_key("offset"), "sftp_read_file lacks offset");
        // Transfer tools expose the local/remote path pair and overwrite knob.
        for tool_name in ["sftp_upload", "sftp_download"] {
            let tool = tools.iter().find(|t| t["name"] == tool_name).unwrap();
            let props = tool["inputSchema"]["properties"].as_object().unwrap();
            assert!(
                props.contains_key("localPath"),
                "{tool_name} lacks localPath"
            );
            assert!(
                props.contains_key("remotePath"),
                "{tool_name} lacks remotePath"
            );
            assert!(
                props.contains_key("overwrite"),
                "{tool_name} lacks overwrite"
            );
        }
        let sudo = tools.iter().find(|t| t["name"] == "ssh_exec_sudo").unwrap();
        let sudo_props = sudo["inputSchema"]["properties"].as_object().unwrap();
        assert!(
            sudo_props.contains_key("quickSudoProfile"),
            "ssh_exec_sudo lacks quickSudoProfile"
        );
        // Both exec tools advertise the terminal routing knob.
        for tool_name in ["ssh_exec", "ssh_exec_sudo"] {
            let tool = tools.iter().find(|t| t["name"] == tool_name).unwrap();
            let props = tool["inputSchema"]["properties"].as_object().unwrap();
            assert!(
                props.contains_key("runInTerminal"),
                "{tool_name} lacks runInTerminal"
            );
        }
        let metrics = tools.iter().find(|t| t["name"] == "ssh_metrics").unwrap();
        assert!(metrics["description"]
            .as_str()
            .unwrap()
            .contains("inode usage"));

        // Notifications produce no response; unknown methods return the
        // standard JSON-RPC -32601 (Method not found), family-wide with
        // ldap/kafka/files.
        assert!(state
            .dispatch(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await
            .is_none());
        let error = state
            .dispatch(json!({ "jsonrpc": "2.0", "id": 3, "method": "no/such" }))
            .await
            .unwrap();
        assert_eq!(error["error"]["code"], -32601);
        assert!(error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Method not found"));
    }

    /// Reliability round 5: malformed request envelopes get structured
    /// -32600 errors (never a panic, never a silently tolerated shape), and
    /// a valid request still works right after every hostile one.
    #[tokio::test]
    async fn malformed_envelopes_get_structured_invalid_request_errors() {
        let state = state();
        let hostile: Vec<(Value, &str)> = vec![
            // Wrong / missing protocol version.
            (
                json!({ "jsonrpc": "1.0", "id": 1, "method": "ping" }),
                "jsonrpc",
            ),
            (
                json!({ "jsonrpc": 2.0, "id": 2, "method": "ping" }),
                "jsonrpc",
            ),
            (json!({ "id": 3, "method": "ping" }), "jsonrpc"),
            // Malformed id shapes (JSON-RPC allows string/number only).
            (
                json!({ "jsonrpc": "2.0", "id": { "n": 1 }, "method": "ping" }),
                "id",
            ),
            (
                json!({ "jsonrpc": "2.0", "id": true, "method": "ping" }),
                "id",
            ),
            (
                json!({ "jsonrpc": "2.0", "id": [7], "method": "ping" }),
                "id",
            ),
            // Missing / non-string method.
            (json!({ "jsonrpc": "2.0", "id": 4 }), "method"),
            (json!({ "jsonrpc": "2.0", "id": 5, "method": 42 }), "method"),
            (json!({ "jsonrpc": "2.0", "id": 6, "method": "" }), "method"),
        ];
        for (request, fragment) in hostile {
            let response = state.dispatch(request).await.unwrap();
            assert_eq!(
                response["error"]["code"], -32600,
                "expected -32600 for {response}"
            );
            assert!(response["error"]["message"]
                .as_str()
                .unwrap()
                .contains(fragment));
            // The echoed id is protocol-valid (string/number) or null.
            assert!(
                response["id"].is_null()
                    || response["id"].is_string()
                    || response["id"].is_number(),
                "invalid id echo: {response}"
            );
            // The connection stays healthy: ping still answers.
            let pong = state
                .dispatch(json!({ "jsonrpc": "2.0", "id": 99, "method": "ping" }))
                .await
                .unwrap();
            assert_eq!(pong["id"], 99);
            assert!(pong.get("error").is_none(), "ping failed: {pong}");
        }

        // An explicit `id: null` is invalid per JSON-RPC and answers with a
        // null-id -32600 (documented tiering: 无 id/坏 id → -32600).
        let null_id = state
            .dispatch(json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }))
            .await
            .unwrap();
        assert_eq!(null_id["error"]["code"], -32600);
        assert!(null_id["id"].is_null());

        // Well-formed string and number ids still echo verbatim.
        let string_id = state
            .dispatch(json!({ "jsonrpc": "2.0", "id": "abc-1", "method": "ping" }))
            .await
            .unwrap();
        assert_eq!(string_id["id"], "abc-1");
        assert!(string_id.get("error").is_none());
    }

    /// Reliability round 5: the stdio line classifier must survive hostile
    /// lines — invalid UTF-8 (previously killed the whole session), garbage
    /// JSON, blank/CRLF lines — replying -32700 where a reply is owed and
    /// surfacing real I/O errors.
    #[test]
    fn stdio_line_classification_survives_hostile_lines() {
        // Blank and whitespace/CRLF-only lines are silent (no death loop).
        assert!(matches!(
            classify_stdio_line(Ok(String::new())),
            Ok(StdioLine::Silent)
        ));
        assert!(matches!(
            classify_stdio_line(Ok("   \t ".to_string())),
            Ok(StdioLine::Silent)
        ));
        assert!(matches!(
            classify_stdio_line(Ok("\r".to_string())),
            Ok(StdioLine::Silent)
        ));

        // Invalid UTF-8 becomes a -32700 parse error, not a process exit.
        let invalid_utf8 = Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        ));
        match classify_stdio_line(invalid_utf8) {
            Ok(StdioLine::Reply(response)) => {
                assert_eq!(response["error"]["code"], -32700);
                assert!(response["id"].is_null());
            }
            other => panic!("expected a parse-error reply, got {other:?}"),
        }

        // Real I/O errors still abort the loop.
        let io_error = Err(io::Error::new(io::ErrorKind::BrokenPipe, "gone"));
        assert!(classify_stdio_line(io_error).is_err());

        // Garbage JSON answers -32700; valid JSON reaches the dispatcher.
        match classify_stdio_line(Ok("{not json".to_string())) {
            Ok(StdioLine::Reply(response)) => {
                assert_eq!(response["error"]["code"], -32700);
            }
            other => panic!("expected a parse-error reply, got {other:?}"),
        }
        match classify_stdio_line(Ok(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_string())) {
            Ok(StdioLine::Request(request)) => assert_eq!(request["method"], "ping"),
            other => panic!("expected a request, got {other:?}"),
        }
        // CRLF line endings parse fine (serde_json tolerates the trailing \r).
        match classify_stdio_line(Ok(
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\r".to_string()
        )) {
            Ok(StdioLine::Request(request)) => assert_eq!(request["id"], 2),
            other => panic!("expected a request, got {other:?}"),
        }
    }

    /// Round 6 family contract: the single-line ceiling parses its env knob
    /// with a safe fallback (junk / zero / unset → the 16 MiB default), and
    /// an over-limit line answers a structured -32700 naming the limit and
    /// the env var (the loop consumed the line through its newline, so the
    /// session continues — pinned e2e by the smoke line-limit section).
    #[test]
    fn stdio_max_line_env_is_parsed_with_safe_fallback() {
        std::env::set_var("DBX_SSH_MCP_STDIO_MAX_LINE", "1024");
        assert_eq!(stdio_max_line_bytes(), 1024);
        std::env::set_var("DBX_SSH_MCP_STDIO_MAX_LINE", " 8388608 ");
        assert_eq!(stdio_max_line_bytes(), 8_388_608);
        for junk in ["", "abc", "0", "-5", "16 MiB"] {
            std::env::set_var("DBX_SSH_MCP_STDIO_MAX_LINE", junk);
            assert_eq!(
                stdio_max_line_bytes(),
                DEFAULT_STDIO_MAX_LINE_BYTES,
                "junk value {junk:?} must fall back to the default"
            );
        }
        std::env::remove_var("DBX_SSH_MCP_STDIO_MAX_LINE");
        assert_eq!(stdio_max_line_bytes(), DEFAULT_STDIO_MAX_LINE_BYTES);
    }

    #[test]
    fn over_limit_line_gets_structured_parse_error() {
        let response = over_limit_line_response(20 * 1024 * 1024, DEFAULT_STDIO_MAX_LINE_BYTES);
        assert_eq!(response["error"]["code"], -32700);
        assert!(response["id"].is_null());
        let message = response["error"]["message"].as_str().unwrap();
        assert!(message.contains("exceeds the"), "{message}");
        assert!(message.contains("16777216-byte limit"), "{message}");
        assert!(message.contains("DBX_SSH_MCP_STDIO_MAX_LINE"), "{message}");
    }

    /// Round 6: missing-required errors enumerate EVERY absent parameter in
    /// one message (`Missing required parameters: a, b`) so an LLM fixes all
    /// gaps in one turn; present-but-wrong-typed values keep the precise
    /// per-parameter error instead of being misreported as missing.
    #[tokio::test]
    async fn missing_required_errors_enumerate_every_gap() {
        let state = state();
        // ssh_multi_exec: both gaps named in one error, schema required order.
        let message = multi_exec_error(&state, json!({})).await;
        assert!(message.contains("Missing required parameters"), "{message}");
        assert!(
            message.contains("targets") && message.contains("command"),
            "{message}"
        );

        // Only one gap → only that one named (the other was supplied).
        let message = multi_exec_error(&state, json!({ "targets": ["conn-1"] })).await;
        assert_eq!(message, "Missing required parameters: command", "{message}");
        let message = multi_exec_error(&state, json!({ "command": "uptime" })).await;
        assert_eq!(message, "Missing required parameters: targets", "{message}");

        // sftp_upload / sftp_download: both paths enumerated together.
        for name in ["sftp_upload", "sftp_download"] {
            let message = tool_error(&state, name, json!({})).await;
            assert!(
                message.contains("Missing required parameters"),
                "{name}: {message}"
            );
            assert!(
                message.contains("localPath") && message.contains("remotePath"),
                "{name}: {message}"
            );
        }

        // Present-but-wrong-typed stays a per-parameter error (smoke pins the
        // array case too): enumeration must not mislabel it as missing. Note
        // `{"targets": "conn-1"}` alone still enumerates command — command is
        // genuinely absent there.
        let message =
            multi_exec_error(&state, json!({ "targets": "conn-1", "command": "uptime" })).await;
        assert!(message.contains("targets must be an array"), "{message}");
        // Null counts as absent (JSON's explicit "no value").
        let message =
            multi_exec_error(&state, json!({ "targets": ["conn-1"], "command": null })).await;
        assert_eq!(message, "Missing required parameters: command", "{message}");
    }

    async fn multi_exec_error(state: &McpState, arguments: Value) -> String {
        tool_error(state, "ssh_multi_exec", arguments).await
    }

    /// Round 7 (§3.3 live coverage input): the `mode` enum is case-sensitive
    /// by design — invalid and wrong-case values must fail fast with the
    /// full legal value list (matching the schema enum) before any dial or
    /// saved-connection resolution, so the refusal has no side effects.
    #[tokio::test]
    async fn multi_exec_mode_enum_rejects_invalid_and_wrong_case() {
        let state = state();
        for mode in ["wrong", "PARALLEL", "Sequential"] {
            let message = multi_exec_error(
                &state,
                json!({ "targets": ["conn-1"], "command": "echo probe", "mode": mode }),
            )
            .await;
            assert!(
                message.contains(r#"mode must be "parallel" or "sequential""#)
                    && message.contains(mode),
                "mode {mode}: {message}"
            );
        }
    }

    async fn tool_error(state: &McpState, name: &str, arguments: Value) -> String {
        String::from(
            state
                .dispatch(json!({
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": { "name": name, "arguments": arguments },
                }))
                .await
                .unwrap()["error"]["message"]
                .as_str()
                .unwrap_or_default(),
        )
    }

    #[tokio::test]
    async fn tool_calls_validate_parameters_before_connecting() {
        let state = state();
        let missing = state
            .dispatch(json!({
                "jsonrpc": "2.0", "id": 9, "method": "tools/call",
                "params": { "name": "sftp_upload", "arguments": { "host": "example.com", "username": "u" } },
            }))
            .await
            .unwrap();
        let text = missing["error"]["message"].as_str().unwrap();
        assert!(text.contains("localPath"), "unexpected error: {text}");

        let no_password = state
            .dispatch(json!({
                "jsonrpc": "2.0", "id": 10, "method": "tools/call",
                "params": { "name": "ssh_exec", "arguments": { "host": "example.com", "username": "u", "command": "true" } },
            }))
            .await
            .unwrap();
        let message = no_password["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("password"), "unexpected error: {message}");
    }

    #[tokio::test]
    async fn transfer_tools_validate_the_local_side_before_dialing() {
        let directory = tempfile::tempdir().unwrap();
        let state = McpState::new(directory.path().join("data"));
        let remote = json!({ "host": "203.0.113.1", "username": "u", "password": "p" });
        let merge = |mut base: Value, extra: Value| {
            for (key, value) in extra.as_object().unwrap() {
                base[key.as_str()] = value.clone();
            }
            base
        };

        // A missing local file fails before any connection attempt.
        let missing_file = state
            .run_tool(
                "sftp_upload",
                &merge(
                    remote.clone(),
                    json!({ "localPath": "/no/such/file.bin", "remotePath": "/tmp/x" }),
                ),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            missing_file.contains("Cannot read local file"),
            "unexpected error: {missing_file}"
        );

        // The upload cap follows the configured maxUploadBytes.
        let local_file = directory.path().join("payload.bin");
        std::fs::write(&local_file, vec![0u8; 64]).unwrap();
        state.settings_set(&json!({ "maxUploadBytes": 8 })).unwrap();
        let too_big = state
            .run_tool(
                "sftp_upload",
                &merge(
                    remote.clone(),
                    json!({ "localPath": local_file.display().to_string(), "remotePath": "/tmp/x" }),
                ),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            too_big.contains("upload limit"),
            "unexpected error: {too_big}"
        );

        // An existing local target refuses to be replaced without overwrite.
        let existing_target = directory.path().join("already-here.txt");
        std::fs::write(&existing_target, "keep").unwrap();
        let refused = state
            .run_tool(
                "sftp_download",
                &merge(
                    remote,
                    json!({
                        "remotePath": "/tmp/remote.txt",
                        "localPath": existing_target.display().to_string(),
                    }),
                ),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            refused.contains("Local path already exists"),
            "unexpected error: {refused}"
        );
    }

    #[tokio::test]
    async fn quick_sudo_profiles_roundtrip_without_echoing_secrets() {
        let dir = std::env::temp_dir().join(format!("dbx-mcp-profiles-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = McpState::new(dir.clone());
        // Test-only secret assembled at runtime (never a real credential).
        let secret = format!("test-{}", uuid::Uuid::new_v4());

        let saved = state
            .run_tool(
                "ssh_quick_sudo_profiles_save",
                &json!({
                    "name": "ops",
                    "sudoPassword": secret,
                    "totpSecret": "JBSWY3DPEHPK3PXP",
                    "authFlowMode": "password_plus_otp",
                    "sudoUsePty": true,
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(saved["created"], true);
        assert_eq!(saved["profile"]["sudoPasswordSet"], true);
        assert_eq!(saved["profile"]["totpConfigured"], true);

        let listed = state
            .run_tool("ssh_quick_sudo_profiles_list", &json!({}), None)
            .await
            .unwrap();
        let rendered = listed.to_string();
        assert!(!rendered.contains(&secret), "secret leaked: {rendered}");
        assert!(rendered.contains("\"sudoPasswordSet\":true"));

        // Duplicate names are rejected, unknown references report clearly.
        let duplicate = state
            .run_tool(
                "ssh_quick_sudo_profiles_save",
                &json!({ "name": "OPS" }),
                None,
            )
            .await;
        assert!(duplicate.unwrap_err().contains("already in use"));
        let missing = resolve_profile_reference(
            &sudo_profiles::load_store(&dir),
            &json!({ "quickSudoProfile": "ghost" }),
        );
        assert!(missing.unwrap_err().contains("not found"));

        let id = saved["profile"]["id"].as_str().unwrap().to_string();
        let removed = state
            .run_tool("ssh_quick_sudo_profiles_delete", &json!({ "id": id }), None)
            .await
            .unwrap();
        assert_eq!(removed["removed"], true);
        let listed = state
            .run_tool("ssh_quick_sudo_profiles_list", &json!({}), None)
            .await
            .unwrap();
        assert_eq!(listed["profiles"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Builds a saved-connection payload with the given declared sudo source;
    /// returns the connection plus its (runtime-composed) login password.
    /// All credential values in tests are assembled at runtime — never real
    /// credentials, never literals in source.
    fn source_connection(source: &str, profile_ref: &str) -> (StoredConnection, String) {
        let login = format!("login-{}", uuid::Uuid::new_v4());
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-src",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": login,
                "external_config": {
                    "sudo_source": source,
                    "sudo_profile": profile_ref,
                },
            }
        }))
        .unwrap();
        (stored, login)
    }

    #[tokio::test]
    async fn sudo_auth_resolution_follows_declared_source() {
        let dir = std::env::temp_dir().join(format!("dbx-mcp-sudo-src-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = McpState::new(dir.clone());
        let profile_secret = format!("profile-{}", uuid::Uuid::new_v4());
        let call_secret = format!("call-{}", uuid::Uuid::new_v4());

        let saved = state
            .run_tool(
                "ssh_quick_sudo_profiles_save",
                &json!({
                    "name": "src-ops",
                    "sudoPassword": profile_secret,
                    "totpSecret": "JBSWY3DPEHPK3PXP",
                }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(saved["created"], true);

        // Global source: the referenced global profile owns the credential
        // source (with TOTP), exactly like the workbench.
        let (stored, _) = source_connection("global", "src-ops");
        let auth = state
            .resolve_sudo_auth(&json!({}), None, Some(stored))
            .await
            .unwrap();
        assert_eq!(auth.password, profile_secret);
        assert!(!auth.totp_secrets.is_empty());

        // Explicit per-call arguments win over the declared source.
        let (stored, _) = source_connection("global", "src-ops");
        let auth = state
            .resolve_sudo_auth(&json!({ "sudoPassword": call_secret }), None, Some(stored))
            .await
            .unwrap();
        assert_eq!(auth.password, call_secret);

        // The per-call quickSudoProfile reference replaces the declared one
        // and is applied even without a saved connection (inline MCP calls).
        let explicit_profile = sudo_profiles::SudoProfile {
            id: "inline".to_string(),
            name: "inline".to_string(),
            sudo_password: call_secret.clone(),
            totp_secret: String::new(),
            auth_flow_mode: "password_only".to_string(),
            password_prompt_hint: String::new(),
            totp_prompt_hint: String::new(),
            sudo_use_pty: false,
            created_at: 0,
            updated_at: 0,
        };
        let (stored, _) = source_connection("global", "src-ops");
        let auth = state
            .resolve_sudo_auth(&json!({}), Some(explicit_profile.clone()), Some(stored))
            .await
            .unwrap();
        assert_eq!(auth.password, call_secret);
        assert!(auth.totp_secrets.is_empty());
        let auth = state
            .resolve_sudo_auth(&json!({}), Some(explicit_profile.clone()), None)
            .await
            .unwrap();
        assert_eq!(auth.password, call_secret);

        // Custom source without a binding: the connection's own sudo config
        // (empty here) degrades to the login password fallback.
        let (stored, login) = source_connection("custom", "");
        let auth = state
            .resolve_sudo_auth(&json!({}), None, Some(stored))
            .await
            .unwrap();
        assert_eq!(auth.password, login);

        // Off refuses like the workbench gate, unless the caller passes
        // explicit credentials.
        let (stored, _) = source_connection("off", "");
        let refused = state
            .resolve_sudo_auth(&json!({}), None, Some(stored))
            .await;
        assert!(refused.unwrap_err().contains("Quick Sudo is disabled"));
        let (stored, _) = source_connection("off", "");
        let auth = state
            .resolve_sudo_auth(&json!({ "sudoPassword": call_secret }), None, Some(stored))
            .await
            .unwrap();
        assert_eq!(auth.password, call_secret);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pool_ids_key_by_identity() {
        let id = connection_pool_id(&json!({ "host": "h", "port": 2222, "username": "u" }));
        assert_eq!(id, "mcp-u@h:2222");
        assert_eq!(
            connection_pool_id(&json!({ "host": "h", "username": "u" })),
            "mcp-u@h:22"
        );
    }

    #[test]
    fn jump_hosts_parse_into_the_chain() {
        let connection = stored_connection_from_arguments(&json!({
            "host": "target", "username": "u", "password": "p",
            "jumpHosts": [
                { "host": "bastion", "port": 2222, "username": "ops", "password": "jp" },
                { "host": "inner", "username": "relay", "authentication": "private-key", "private_key_path": "/k" },
            ],
        }))
        .unwrap();
        assert_eq!(connection.jump_hosts.len(), 2);
        assert_eq!(connection.jump_hosts[0].port, 2222);
        assert_eq!(connection.jump_hosts[1].authentication, "private-key");

        let too_many = json!({
            "host": "t", "username": "u", "password": "p",
            "jumpHosts": [
                { "host": "a", "username": "u", "password": "p" },
                { "host": "b", "username": "u", "password": "p" },
                { "host": "c", "username": "u", "password": "p" },
                { "host": "d", "username": "u", "password": "p" },
            ],
        });
        assert!(stored_connection_from_arguments(&too_many)
            .err()
            .unwrap()
            .contains("At most 3"));

        let missing_password = json!({
            "host": "t", "username": "u", "password": "p",
            "jumpHosts": [{ "host": "bastion", "username": "ops" }],
        });
        assert!(stored_connection_from_arguments(&missing_password).is_err());
    }

    #[test]
    fn connections_map_authentication_sensibly() {
        let by_key = stored_connection_from_arguments(&json!({
            "host": "h", "username": "u", "command": "x",
            "privateKeyPath": "/k", "totpSecret": "123456", "authFlowMode": "password_plus_otp"
        }))
        .unwrap();
        assert_eq!(by_key.authentication, AuthenticationMethod::PrivateKey);
        assert_eq!(by_key.totp_secret, "123456");
        assert!(
            stored_connection_from_arguments(&json!({ "host": "h", "username": "u" })).is_err()
        );
    }

    /// MCP inline dials accept pasted key contents as the path alternative:
    /// content-only selects private-key without touching the filesystem, and
    /// a dial with neither path nor content is rejected up front.
    #[test]
    fn connections_accept_private_key_content() {
        let by_content = stored_connection_from_arguments(&json!({
            "host": "h", "username": "u", "command": "x",
            "privateKeyContent": "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n"
        }))
        .unwrap();
        assert_eq!(by_content.authentication, AuthenticationMethod::PrivateKey);
        assert!(by_content.private_key_path.is_empty());
        assert!(by_content.private_key.starts_with("-----BEGIN"));

        let explicit_password_mode = stored_connection_from_arguments(&json!({
            "host": "h", "username": "u", "command": "x",
            "authentication": "private-key-password",
            "privateKeyContent": "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n",
            "password": "login"
        }))
        .unwrap();
        assert_eq!(
            explicit_password_mode.authentication,
            AuthenticationMethod::PrivateKeyPassword
        );

        // 既有的推断语义保持不变：没有密钥材料时显式 private-key 仍按
        // 「有密码则回退 password」解析（内联拨号从不挂空路径的私钥）。
        let degraded = stored_connection_from_arguments(&json!({
            "host": "h", "username": "u", "command": "x",
            "authentication": "private-key", "password": "login"
        }))
        .unwrap();
        assert_eq!(degraded.authentication, AuthenticationMethod::Password);
        let neither = stored_connection_from_arguments(&json!({
            "host": "h", "username": "u", "command": "x",
            "authentication": "private-key"
        }))
        .unwrap_err();
        assert!(
            neither.contains("Password authentication requires a password"),
            "{neither}"
        );
    }

    #[test]
    fn mcp_limits_default_and_clamp_into_ceilings() {
        let defaults = McpLimits::default();
        assert_eq!(defaults.max_read_bytes, 256 * 1024);
        assert_eq!(defaults.max_download_bytes, 1024 * 1024);
        assert_eq!(defaults.local_transfer_root, "");
        assert_eq!(
            McpLimits {
                max_read_bytes: 0,
                max_upload_bytes: u64::MAX,
                max_download_bytes: 0,
                local_transfer_root: String::new(),
            }
            .sanitized(),
            McpLimits {
                max_read_bytes: 1,
                max_upload_bytes: UPLOAD_LIMIT_CEILING,
                max_download_bytes: 1,
                local_transfer_root: String::new(),
            }
        );
        // Values inside the ceilings pass through untouched.
        let inside = McpLimits {
            max_read_bytes: 512 * 1024,
            max_upload_bytes: 64 * 1024 * 1024,
            max_download_bytes: 4 * 1024 * 1024,
            local_transfer_root: String::new(),
        };
        assert_eq!(inside.clone().sanitized(), inside);
    }

    #[cfg(windows)]
    const ABS_TEST_ROOT: &str = "C:\\tmp\\transfers";
    #[cfg(not(windows))]
    const ABS_TEST_ROOT: &str = "/tmp/transfers";

    #[test]
    fn local_transfer_root_setting_accepts_absolute_and_empty_only() {
        assert_eq!(validated_transfer_root(&json!("")).unwrap(), "");
        assert_eq!(
            validated_transfer_root(&json!(ABS_TEST_ROOT)).unwrap(),
            ABS_TEST_ROOT
        );
        assert!(validated_transfer_root(&json!("relative/path")).is_err());
        assert!(validated_transfer_root(&json!(42)).is_err());
    }

    #[test]
    fn local_transfer_settings_persist_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mcp-limits-test-{}", std::process::id()));
        let path = dir.join("mcp-settings.json");
        let _ = std::fs::remove_file(&path);
        let defaults = McpLimits::load(&path);
        assert_eq!(defaults.local_transfer_root, "");
        let mut updated = defaults;
        updated.local_transfer_root = ABS_TEST_ROOT.to_string();
        write_settings_document(&path, &updated, &McpPermission::default()).unwrap();
        let reloaded = McpLimits::load(&path);
        assert_eq!(reloaded.local_transfer_root, ABS_TEST_ROOT);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn local_transfer_gate_confines_paths_to_allowed_roots() {
        let scratch = std::env::temp_dir().join(format!("mcp-gate-{}", std::process::id()));
        std::fs::create_dir_all(&scratch).unwrap();
        let inside_dir = scratch.join("inside");
        std::fs::create_dir_all(&inside_dir).unwrap();
        std::fs::write(inside_dir.join("a.bin"), b"x").unwrap();
        let inside = std::fs::canonicalize(inside_dir.join("a.bin")).unwrap();
        let roots = vec![std::fs::canonicalize(&inside_dir).unwrap()];
        // Inside the only configured root passes…
        assert!(ensure_local_transfer_allowed_in(&roots, "/x", &inside).is_ok());
        // …anything else (even non-sensitive) is refused…
        let outside = std::fs::canonicalize("/usr").unwrap_or_else(|_| PathBuf::from("/usr"));
        let error = ensure_local_transfer_allowed_in(&roots, "/x", &outside).unwrap_err();
        assert!(error.contains("localTransferRoot"), "{error}");
        // …and the default-roots message names the setting to widen.
        let empty_roots: Vec<PathBuf> = vec![];
        let error = ensure_local_transfer_allowed_in(&empty_roots, "", &inside).unwrap_err();
        assert!(
            error.contains("outside the allowed transfer roots"),
            "{error}"
        );
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn local_transfer_gate_blocklist_applies_inside_allowed_roots() {
        let scratch = std::env::temp_dir().join(format!("mcp-gate-bl-{}", std::process::id()));
        let secret_dir = scratch.join(".ssh");
        std::fs::create_dir_all(&secret_dir).unwrap();
        std::fs::write(secret_dir.join("id_rsa"), b"k").unwrap();
        let key = std::fs::canonicalize(secret_dir.join("id_rsa")).unwrap();
        let rc = std::fs::canonicalize(&scratch).unwrap().join(".bashrc");
        let roots = vec![std::fs::canonicalize(&scratch).unwrap()];
        assert!(ensure_local_transfer_allowed_in(&roots, "", &key).is_err());
        assert!(ensure_local_transfer_allowed_in(&roots, "", &rc).is_err());
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn local_transfer_roots_default_to_temp_and_data_dir() {
        let data_dir = std::env::temp_dir().join(format!("mcp-data-{}", std::process::id()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let roots = local_transfer_roots_for("", &data_dir).unwrap();
        let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let data = std::fs::canonicalize(&data_dir).unwrap();
        assert!(roots.contains(&temp), "{roots:?}");
        assert!(roots.contains(&data), "{roots:?}");
        // A configured root narrows the policy to exactly that root…
        let roots = local_transfer_roots_for(data.to_str().unwrap(), &data_dir).unwrap();
        assert_eq!(roots, vec![data.clone()]);
        // …and an unresolvable configured root is an error, not a fallback.
        assert!(local_transfer_roots_for("/nonexistent/mcp-root", &data_dir).is_err());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn mcp_limits_load_falls_back_on_missing_or_corrupt_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp-settings.json");
        // Missing file and unparseable content both fall back to defaults.
        assert_eq!(McpLimits::load(&path), McpLimits::default());
        std::fs::write(&path, "not json at all {{{").unwrap();
        assert_eq!(McpLimits::load(&path), McpLimits::default());
        // Partial/garbage fields fall back per-field and out-of-range values
        // are clamped on load.
        std::fs::write(
            &path,
            serde_json::to_string(&json!({
                "maxReadBytes": "bogus",
                "maxUploadBytes": 32 * 1024 * 1024,
                "maxDownloadBytes": 999u64 * 1024 * 1024 * 1024,
            }))
            .unwrap(),
        )
        .unwrap();
        let loaded = McpLimits::load(&path);
        assert_eq!(loaded.max_read_bytes, McpLimits::default().max_read_bytes);
        assert_eq!(loaded.max_upload_bytes, 32 * 1024 * 1024);
        assert_eq!(loaded.max_download_bytes, DOWNLOAD_LIMIT_CEILING);
    }

    #[test]
    fn mcp_limits_persist_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp-settings.json");
        let limits = McpLimits {
            max_read_bytes: 128 * 1024,
            max_upload_bytes: 8 * 1024 * 1024,
            max_download_bytes: 2 * 1024 * 1024,
            local_transfer_root: String::new(),
        };
        write_settings_document(&path, &limits, &McpPermission::default()).unwrap();
        assert_eq!(McpLimits::load(&path), limits);
        // A fresh state over the same data dir picks the persisted values up
        // (this is how the --mcp stdio process shares the settings).
        let state = McpState::new(directory.path().to_path_buf());
        // settings_get carries the §1.3 permission keys too; the limit
        // fields must round-trip unchanged.
        let view = state.settings_get();
        let expected = limits.to_json();
        assert_eq!(view["maxReadBytes"], expected["maxReadBytes"]);
        assert_eq!(view["maxUploadBytes"], expected["maxUploadBytes"]);
        assert_eq!(view["maxDownloadBytes"], expected["maxDownloadBytes"]);
        assert_eq!(view["localTransferRoot"], expected["localTransferRoot"]);
    }

    #[test]
    fn mcp_settings_set_validates_and_persists_partial_updates() {
        let directory = tempfile::tempdir().unwrap();
        let state = McpState::new(directory.path().to_path_buf());

        // Partial update: only the named field changes.
        let updated = state
            .settings_set(&json!({ "maxReadBytes": 64 * 1024 }))
            .unwrap();
        assert_eq!(updated["maxReadBytes"], 64 * 1024);
        assert_eq!(
            updated["maxUploadBytes"],
            McpLimits::default().max_upload_bytes
        );
        assert_eq!(state.settings_get(), updated);

        // Invalid values are rejected without touching the stored settings.
        for bad in [
            json!({ "maxReadBytes": 0 }),
            json!({ "maxReadBytes": READ_LIMIT_CEILING + 1 }),
            json!({ "maxUploadBytes": "big" }),
            json!({ "maxDownloadBytes": -1 }),
            json!({ "localTransferRoot": "relative/root" }),
            json!({ "localTransferRoot": 7 }),
        ] {
            assert!(
                state.settings_set(&bad).is_err(),
                "expected error for {bad}"
            );
        }
        assert_eq!(
            state.settings_get()["maxReadBytes"],
            64 * 1024,
            "rejected updates must not change the settings"
        );

        // The transfer root accepts an absolute path and clears on empty.
        let with_root = state
            .settings_set(&json!({ "localTransferRoot": ABS_TEST_ROOT }))
            .unwrap();
        assert_eq!(with_root["localTransferRoot"], ABS_TEST_ROOT);
        let cleared = state
            .settings_set(&json!({ "localTransferRoot": "" }))
            .unwrap();
        assert_eq!(cleared["localTransferRoot"], "");

        // The soft ceilings themselves are accepted.
        let ceilings = state
            .settings_set(&json!({
                "maxReadBytes": READ_LIMIT_CEILING,
                "maxUploadBytes": UPLOAD_LIMIT_CEILING,
                "maxDownloadBytes": DOWNLOAD_LIMIT_CEILING,
            }))
            .unwrap();
        assert_eq!(ceilings["maxReadBytes"], READ_LIMIT_CEILING);

        // Persistence: a second state over the same directory reloads the
        // last accepted values.
        let reloaded = McpState::new(directory.path().to_path_buf());
        assert_eq!(reloaded.settings_get(), ceilings);
    }

    #[tokio::test]
    async fn destructive_commands_require_explicit_confirmation() {
        let state = state();
        // Refused without the flag; the refusal happens before credential
        // validation (no "password" complaint), proving the gate ordering.
        let refused = state
            .dispatch(json!({
                "jsonrpc": "2.0", "id": 30, "method": "tools/call",
                "params": { "name": "ssh_exec", "arguments": {
                    "host": "203.0.113.1", "username": "u",
                    "command": "mkfs.ext4 /dev/sda1",
                }},
            }))
            .await
            .unwrap();
        let message = refused["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("confirmDestructive"),
            "unexpected: {message}"
        );
        assert!(
            !message.contains("password"),
            "gate must fire first: {message}"
        );

        // With the flag the gate passes and the call proceeds to parameter
        // validation (missing password), proving it was not blocked.
        let gated_through = state
            .dispatch(json!({
                "jsonrpc": "2.0", "id": 31, "method": "tools/call",
                "params": { "name": "ssh_exec", "arguments": {
                    "host": "203.0.113.1", "username": "u",
                    "command": "mkfs.ext4 /dev/sda1",
                    "confirmDestructive": true,
                }},
            }))
            .await
            .unwrap();
        let message = gated_through["error"]["message"].as_str().unwrap();
        assert!(message.contains("password"), "unexpected: {message}");

        // The same gate covers the sudo tool, and pipelines leak through
        // chain segments.
        for tool in ["ssh_exec_sudo"] {
            let chained = state
                .dispatch(json!({
                    "jsonrpc": "2.0", "id": 32, "method": "tools/call",
                    "params": { "name": tool, "arguments": {
                        "host": "203.0.113.1", "username": "u",
                        "command": "uptime && shutdown -h now",
                    }},
                }))
                .await
                .unwrap();
            let message = chained["error"]["message"].as_str().unwrap();
            assert!(
                message.contains("confirmDestructive"),
                "unexpected: {message}"
            );
        }
    }

    /// Reliability round 5: sudo-prefixed and substitution-hidden
    /// destructive commands demand `confirmDestructive` at the tool gate
    /// too (they used to slip through as plain Unknown and run unconfirmed
    /// on writable connections), while ordinary commands still pass the
    /// gate through to the credential check.
    #[tokio::test]
    async fn sudo_and_substitution_destructive_variants_demand_confirmation() {
        let state = state();
        for command in [
            "sudo rm -rf /",
            "sudo -u root rm -rf /etc",
            "sudo sh -c 'rm -rf /etc'",
            "sh -c 'mkfs.ext4 /dev/sda1'",
            "echo $(rm -rf /)",
            "echo `shutdown -h now`",
        ] {
            let refused = state
                .call_tool(
                    "ssh_exec",
                    &json!({ "host": "203.0.113.1", "username": "u", "command": command }),
                    None,
                )
                .await
                .unwrap_err();
            assert!(
                refused.contains("confirmDestructive"),
                "{command}: {refused}"
            );
            assert!(!refused.contains("password"), "{command}: {refused}");
        }
        // The gate did not over-fire: a benign command proceeds past it.
        let through = state
            .call_tool(
                "ssh_exec",
                &json!({ "host": "203.0.113.1", "username": "u", "command": "echo hi" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(through.contains("password"), "{through}");
    }

    /// Reliability round 5: the local download/denylist gate holds across
    /// double-slash and `./` path aliasing.
    #[test]
    fn sensitive_local_path_gate_survives_path_shapes() {
        for path in [
            "/etc//cron.d/payload",
            "/etc/./cron.d/payload",
            "/etc/./profile",
            "/home/u//.ssh/authorized_keys",
            "/var/spool//cron/x",
            "/Library/./LaunchDaemons/evil.plist",
        ] {
            assert!(
                is_sensitive_local_path(path),
                "expected '{path}' to be a sensitive local path"
            );
        }
        for path in [
            "/tmp/ok.bin",
            "/home/u/project/cron-doc.txt",
            "/home/u/ssh-config-backup", // prefix must match components, not substrings
        ] {
            assert!(
                !is_sensitive_local_path(path),
                "expected '{path}' NOT to be a sensitive local path"
            );
        }
    }

    // —— 第五轮：会话/存储 churn 可靠性 ————————————————

    /// Reliability round 5 (churn): 500 register→resolve→drop cycles on the
    /// lifecycle registry must keep every lookup shape correct (exact id,
    /// display name, endpoint identity, ambiguity, stale-id miss) and the
    /// map bounded to the live entries.
    #[tokio::test]
    async fn registry_churn_keeps_lookup_correct() {
        let mut state = state();
        state.bridge_fallback = false;
        const CYCLES: usize = 500;
        for index in 0..CYCLES {
            let id = format!("churn-conn-{index}");
            let name = format!("Web {index}");
            let connection = stored_connection(&id, "192.0.2.10", 22, json!({ "name": name }));
            // Register.
            state
                .dbx_connections
                .write()
                .await
                .insert(id.clone(), connection);
            assert!(
                state.dbx_connections.read().await.len() <= 1,
                "registry leaked before cycle {index}"
            );
            // Exact id lookup.
            let resolved = state
                .registered_connection_by_ref(&json!({ "connectionId": id }))
                .await
                .expect("id lookup");
            assert!(resolved.is_some(), "registered id not found at {index}");
            // Display-name lookup.
            let resolved = state
                .registered_connection_by_ref(&json!({ "connectionName": name }))
                .await
                .expect("name lookup");
            assert_eq!(resolved.unwrap().id, id);
            // Endpoint lookup (host + username, default port).
            let resolved = state
                .registered_connection_by_ref(
                    &json!({ "host": "192.0.2.10", "username": "deploy" }),
                )
                .await
                .expect("endpoint lookup");
            assert_eq!(resolved.unwrap().id, id);
            // Mismatched selectors are an error, not a silent miss.
            assert!(state
                .registered_connection_by_ref(&json!({
                    "connectionId": id, "connectionName": "other"
                }))
                .await
                .is_err());
            // Drop and confirm the miss (stale ids keep the self-heal path).
            state.dbx_connections.write().await.remove(&id);
            let resolved = state
                .registered_connection_by_ref(&json!({ "connectionId": id }))
                .await
                .expect("post-drop lookup");
            assert!(resolved.is_none(), "dropped id still resolves at {index}");
            assert!(state.dbx_connections.read().await.is_empty());
        }
        assert!(state.dbx_connections.read().await.is_empty());
    }

    /// Reliability round 5 (churn/idempotency): 100 repeated calls of the
    /// read-only tools (alert triage, known_hosts, settings read) must
    /// return byte-identical results — no state accumulation, no drift.
    #[tokio::test]
    async fn read_only_tools_are_stable_under_repeated_calls() {
        let state = state();
        let payload = json!({
            "alertId": "churn-1", "title": "CPU 使用率过高",
            "severity": "critical", "source": "prometheus",
            "message": "node-1 cpu_usage above 0.9",
        });
        let first_triage = state
            .call_tool(
                "ssh_alert_triage",
                &json!({ "payload": payload.to_string() }),
                None,
            )
            .await
            .expect("triage");
        let first_hosts = state
            .call_tool("ssh_list_known_hosts", &json!({}), None)
            .await
            .expect("known_hosts");
        let first_settings = state.settings_get();
        for index in 1..100 {
            let triage = state
                .call_tool(
                    "ssh_alert_triage",
                    &json!({ "payload": payload.to_string() }),
                    None,
                )
                .await
                .expect("triage");
            assert_eq!(triage, first_triage, "triage drifted at call {index}");
            let hosts = state
                .call_tool("ssh_list_known_hosts", &json!({}), None)
                .await
                .expect("known_hosts");
            assert_eq!(hosts, first_hosts, "known_hosts drifted at call {index}");
            assert_eq!(
                state.settings_get(),
                first_settings,
                "settings read drifted at call {index}"
            );
        }
    }

    /// Reliability round 5 (churn): 500 settings write cycles must keep the
    /// persisted document bounded (fixed shape, no accumulation files) and
    /// every newly-set value immediately visible (no stale-read staleness);
    /// clamp semantics keep working across the whole churn.
    #[tokio::test]
    async fn settings_storage_churn_stays_bounded() {
        let state = state();
        state
            .settings_set(&json!({ "execPermissionMode": "autonomous" }))
            .expect("initial settings write");
        let baseline_files = std::fs::read_dir(state.limits_path.parent().unwrap())
            .expect("data dir")
            .count();
        for index in 0..500 {
            let mode = if index % 2 == 0 {
                "confirm"
            } else {
                "autonomous"
            };
            let upload: u64 = if index % 3 == 0 { 1024 } else { 2048 };
            state
                .settings_set(&json!({
                    "execPermissionMode": mode,
                    "maxUploadBytes": upload,
                }))
                .unwrap_or_else(|error| panic!("settings_set failed at {index}: {error}"));
            let settings = state.settings_get();
            assert_eq!(
                settings["execPermissionMode"],
                json!(mode),
                "mode not visible immediately at {index}"
            );
            assert_eq!(settings["maxUploadBytes"], json!(upload));
        }
        // The store stays a fixed-shape document: file size bounded, no new
        // files appeared next to it (no per-write accumulation).
        let metadata = std::fs::metadata(&state.limits_path).expect("settings file");
        assert!(
            metadata.len() < 4 * 1024,
            "settings document grew to {} bytes",
            metadata.len()
        );
        let after_files = std::fs::read_dir(state.limits_path.parent().unwrap())
            .expect("data dir")
            .count();
        assert_eq!(after_files, baseline_files, "data dir accumulated files");
        // Clamp semantics survive churn: over-ceiling values never persist.
        state
            .settings_set(&json!({ "maxUploadBytes": u64::MAX }))
            .expect_err("over-ceiling upload cap must be rejected");
    }

    /// Reliability round 5 (churn): the `ssh_run_bg` / `ssh_task_status`
    /// offline surface is the two output parsers (the task table itself
    /// lives on the remote host under /tmp/.dbx-ssh-tasks — there is no
    /// in-process registry to leak). 300 start→running→done→missing cycles
    /// must parse identically every time.
    #[test]
    fn bg_task_parsers_stay_stable_under_churn() {
        let start = "PID=4242\nLOG=/tmp/.dbx-ssh-tasks/bg-1.log";
        let running = "STATE=RUNNING\nPID_ALIVE=yes\n===TAIL===\nworking\n";
        let done = "STATE=DONE\nCODE=EXIT_0\nPID_ALIVE=no\n===TAIL===\nEXIT_0\n";
        let missing = "STATE=MISSING\n===TAIL===\n";
        for cycle in 0..300 {
            assert_eq!(
                parse_bg_start_output(start, "/tmp/.dbx-ssh-tasks/default.log".to_string()),
                (
                    "4242".to_string(),
                    "/tmp/.dbx-ssh-tasks/bg-1.log".to_string()
                ),
                "bg start drifted at cycle {cycle}"
            );
            assert_eq!(
                parse_task_status_output(running),
                (
                    "running".to_string(),
                    None,
                    Some(true),
                    "working\n".to_string()
                ),
                "running parse drifted at cycle {cycle}"
            );
            assert_eq!(
                parse_task_status_output(done),
                (
                    "done".to_string(),
                    Some(0),
                    Some(false),
                    "EXIT_0\n".to_string()
                ),
                "done parse drifted at cycle {cycle}"
            );
            assert_eq!(
                parse_task_status_output(missing),
                ("missing".to_string(), None, None, String::new()),
                "missing parse drifted at cycle {cycle}"
            );
        }
    }

    /// In stdio mode (no emitter), `runInTerminal: true` needs a saved DBX
    /// connectionId to forward through the app bridge; without one it is
    /// refused with guidance instead of silently running hidden, and the
    /// read-only/destructive gates keep firing before the routing branch.
    #[tokio::test]
    async fn run_in_terminal_stdio_requires_a_connection_id() {
        let state = state();

        let refused = state
            .run_tool(
                "ssh_exec",
                &json!({ "host": "h", "username": "u", "command": "echo hi", "runInTerminal": true }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            refused.contains("runInTerminal needs a saved DBX connection"),
            "unexpected: {refused}"
        );
        // L0 self-heal hint appended to the guidance error.
        assert!(
            refused.contains("ssh_list_connections"),
            "expected the discovery-tool hint, got: {refused}"
        );

        // The same refusal covers the sudo tool; runInTerminal absent or
        // false keeps the existing hidden-channel behavior (which then fails
        // on the missing password, proving the route was not taken).
        let sudo = state
            .run_tool(
                "ssh_exec_sudo",
                &json!({ "host": "h", "username": "u", "command": "uptime", "runInTerminal": true }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            sudo.contains("runInTerminal needs a saved DBX connection"),
            "unexpected: {sudo}"
        );
        let hidden = state
            .run_tool(
                "ssh_exec",
                &json!({ "host": "h", "username": "u", "command": "echo hi", "runInTerminal": false }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            !hidden.contains("runInTerminal"),
            "false must keep the hidden channel: {hidden}"
        );
    }

    /// L0: with the bridge fallback disabled (hermetic stand-in for "the
    /// bridge is also unavailable"), an unregistered connectionId reports
    /// the full self-heal path instead of the old bare message.
    #[tokio::test]
    async fn unregistered_connection_id_error_carries_selfheal_hints() {
        let mut state = state();
        state.bridge_fallback = false;
        let error = state
            .call_tool("ssh_metrics", &json!({ "connectionId": "ghost" }), None)
            .await
            .unwrap_err();
        assert!(
            error.contains(
                "not registered with this plugin session and the DBX app bridge is unavailable"
            ),
            "unexpected: {error}"
        );
        assert!(
            error.contains("ssh_list_connections") && error.contains("inline credentials"),
            "expected the self-heal hints, got: {error}"
        );
    }

    /// L1: the forward decision reads only the registry — a registered id
    /// stays local, an unregistered id forwards with the original
    /// arguments, local-only tools and runInTerminal routing never forward,
    /// and the kill switch disables the fallback entirely.
    #[tokio::test]
    async fn bridge_forward_plan_decides_by_registry() {
        let mut state = state();
        state.bridge_fallback = true;
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-fwd",
                "name": "Prod",
                "host": "192.0.2.10",
                "port": 22,
                "username": "ops",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        }))
        .unwrap();
        state
            .dbx_connections
            .write()
            .await
            .insert("conn-fwd".to_string(), stored);

        // Registered id: local path owns the call.
        let plan = state
            .bridge_forward_plan(
                "ssh_exec",
                &json!({ "connectionId": "conn-fwd", "command": "uptime" }),
            )
            .await
            .unwrap();
        assert!(plan.is_none(), "registered id must stay local");

        // Unregistered id: forward with the arguments untouched.
        let (id, args) = state
            .bridge_forward_plan(
                "ssh_exec",
                &json!({ "connectionId": "ghost", "command": "uptime" }),
            )
            .await
            .unwrap()
            .expect("unregistered id must forward");
        assert_eq!(id, "ghost");
        assert_eq!(args["command"], "uptime");

        // Local-only tools never forward, even with an unregistered id.
        let plan = state
            .bridge_forward_plan("ssh_close", &json!({ "connectionId": "ghost" }))
            .await
            .unwrap();
        assert!(plan.is_none(), "ssh_close keeps local semantics");

        // Registry name hit stays local (connection() resolves it).
        let plan = state
            .bridge_forward_plan(
                "sftp_list_dir",
                &json!({ "connectionName": "Prod", "path": "/tmp" }),
            )
            .await
            .unwrap();
        assert!(plan.is_none(), "registry name hit stays local");

        // No connection reference: local path.
        let plan = state
            .bridge_forward_plan("ssh_metrics", &json!({}))
            .await
            .unwrap();
        assert!(plan.is_none());

        // runInTerminal keeps its exclusive forward path.
        let plan = state
            .bridge_forward_plan(
                "ssh_exec",
                &json!({ "connectionId": "ghost", "command": "uptime", "runInTerminal": true }),
            )
            .await
            .unwrap();
        assert!(plan.is_none(), "runInTerminal owns its bridge forward");

        // Fallback disabled: never forward.
        state.bridge_fallback = false;
        let plan = state
            .bridge_forward_plan(
                "ssh_exec",
                &json!({ "connectionId": "ghost", "command": "uptime" }),
            )
            .await
            .unwrap();
        assert!(plan.is_none(), "disabled fallback must not forward");
    }

    /// L2: list views expose metadata plus credential PRESENCE flags only —
    /// the runtime-composed secret never appears in any branch, and the
    /// degraded branch carries the start/upgrade note.
    #[test]
    fn connection_list_views_never_echo_credentials() {
        let secret = format!("pw-{}", uuid::Uuid::new_v4());
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-list",
                "name": "Web",
                "host": "web.example.test",
                "port": 2222,
                "username": "deploy",
                "password": secret,
                "read_only": true,
            }
        }))
        .unwrap();
        assert_eq!(stored.name.as_deref(), Some("Web"));

        // Degraded branch: registry alone + note.
        let degraded = connection_list_result(
            Err("bridge down".to_string()),
            std::slice::from_ref(&stored),
            &ConnectionScope::Unrestricted,
        );
        assert_eq!(degraded["source"], "session-registry");
        assert!(
            degraded["note"]
                .as_str()
                .unwrap()
                .contains("upgrade the DBX app"),
            "expected the upgrade note: {degraded}"
        );
        let entry = &degraded["connections"][0];
        assert_eq!(entry["id"], "conn-list");
        assert_eq!(entry["name"], "Web");
        assert_eq!(entry["host"], "web.example.test");
        assert_eq!(entry["port"], 2222);
        assert_eq!(entry["username"], "deploy");
        assert_eq!(entry["authentication"], "password");
        assert_eq!(entry["readOnly"], true);
        assert_eq!(entry["passwordSet"], true);
        let rendered = degraded.to_string();
        assert!(!rendered.contains(&secret), "secret leaked: {rendered}");
        assert!(
            !rendered.contains("\"password\":"),
            "raw credential field leaked: {rendered}"
        );

        // Bridge branch: bridge data wins by id, registry-only ids append,
        // and no note is attached.
        let bridge_entry = json!({
            "id": "conn-list", "name": "Web", "host": "web.example.test",
            "port": 2222, "username": "deploy", "authentication": "password",
            "readOnly": false,
        });
        let extra = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-extra", "host": "db.example.test", "port": 22,
                "username": "ops", "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        }))
        .unwrap();
        let merged = connection_list_result(
            Ok(vec![bridge_entry]),
            &[stored, extra],
            &ConnectionScope::Unrestricted,
        );
        assert_eq!(merged["source"], "dbx-app-bridge");
        assert!(merged.get("note").is_none(), "bridge hit must not degrade");
        let entries = merged["connections"].as_array().unwrap();
        assert_eq!(entries.len(), 2, "bridge entry + registry-only append");
        assert_eq!(entries[0]["id"], "conn-list");
        // Bridge entries carry no credential flags (contract: absent means
        // the app did not send one).
        assert!(entries[0].get("passwordSet").is_none());
        assert_eq!(entries[1]["id"], "conn-extra");
    }

    /// stdio selector→id resolution over the bridge list: unique hit,
    /// ambiguous (both candidates listed with host), and missing. The
    /// endpoint selector disambiguates a duplicate name.
    #[test]
    fn resolve_connection_in_bridge_list_matches_name_and_endpoint() {
        let entries = vec![
            json!({ "id": "a", "name": "Web", "host": "h1", "port": 22, "username": "ops" }),
            // Trailing space in the payload name still matches after trim.
            json!({ "id": "b", "name": "Web ", "host": "h2", "port": 2222, "username": "deploy" }),
            json!({ "id": "c", "name": "DB", "host": "h3", "port": 22, "username": "ops" }),
        ];
        assert_eq!(
            resolve_connection_in_bridge_list(&entries, &json!({ "connectionName": "DB" }))
                .unwrap(),
            "c"
        );
        let error =
            resolve_connection_in_bridge_list(&entries, &json!({ "connectionName": "Web" }))
                .unwrap_err();
        assert!(
            error.contains("ambiguous")
                && error.contains("a")
                && error.contains("b")
                && error.contains("h1")
                && error.contains("h2"),
            "expected candidates in the error: {error}"
        );
        // Endpoint narrows the duplicate name to exactly one candidate.
        assert_eq!(
            resolve_connection_in_bridge_list(
                &entries,
                &json!({ "connectionName": "Web", "host": "h2", "port": 2222, "username": "deploy" })
            )
            .unwrap(),
            "b"
        );
        // A complete endpoint alone reuses the saved connection.
        assert_eq!(
            resolve_connection_in_bridge_list(
                &entries,
                &json!({ "host": "H2", "port": 2222, "username": "deploy" })
            )
            .unwrap(),
            "b"
        );
        assert!(
            resolve_connection_in_bridge_list(&entries, &json!({ "connectionName": "ghost" }))
                .unwrap_err()
                .contains("No saved connection matched"),
            "missing selector must be a clear error"
        );
    }

    /// L3: lifecycle payloads carry the display name through; absent names
    /// stay None (older hosts, inline dials).
    #[test]
    fn lifecycle_name_roundtrip_and_optional_default() {
        let named = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "c1", "name": "  Bastion  ", "host": "h", "port": 22,
                "username": "u", "password": "p",
            }
        }))
        .unwrap();
        assert_eq!(named.name.as_deref(), Some("Bastion"));
        let unnamed = StoredConnection::from_lifecycle_params(&json!({
            "connection": { "id": "c2", "host": "h", "port": 22, "username": "u", "password": "p" }
        }))
        .unwrap();
        assert_eq!(unnamed.name, None);
    }

    /// L3: two same-named registry entries make the reference ambiguous —
    /// the error lists every candidate id + host so the caller can
    /// disambiguate by id.
    #[tokio::test]
    async fn ambiguous_connection_name_lists_candidates() {
        let state = state();
        for (id, host) in [("conn-x", "10.0.0.1"), ("conn-y", "10.0.0.2")] {
            let stored = StoredConnection::from_lifecycle_params(&json!({
                "connection": {
                    "id": id, "name": "Twin", "host": host, "port": 22,
                    "username": "ops",
                    "password": format!("pw-{}", uuid::Uuid::new_v4()),
                }
            }))
            .unwrap();
            state
                .dbx_connections
                .write()
                .await
                .insert(id.to_string(), stored);
        }
        let error = state
            .call_tool("ssh_metrics", &json!({ "connectionName": "Twin" }), None)
            .await
            .unwrap_err();
        assert!(
            error.contains("ambiguous")
                && error.contains("conn-x")
                && error.contains("conn-y")
                && error.contains("10.0.0.1")
                && error.contains("10.0.0.2"),
            "expected every candidate in the error: {error}"
        );
    }

    #[tokio::test]
    async fn endpoint_identity_resolves_a_unique_saved_connection_without_id() {
        let state = state();
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-endpoint",
                "name": "Prod bastion",
                "host": "prod.example.test",
                "port": 2222,
                "username": "deploy",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        }))
        .unwrap();
        state
            .dbx_connections
            .write()
            .await
            .insert(stored.id.clone(), stored);

        let resolved = state
            .registered_connection_by_ref(&json!({
                "host": "PROD.example.test",
                "port": 2222,
                "username": "deploy",
            }))
            .await
            .unwrap()
            .expect("endpoint should resolve the saved connection");
        assert_eq!(resolved.id, "conn-endpoint");
    }

    #[tokio::test]
    async fn connection_name_uses_endpoint_to_disambiguate_candidates() {
        let state = state();
        for (id, host) in [("conn-x", "10.0.0.1"), ("conn-y", "10.0.0.2")] {
            let stored = StoredConnection::from_lifecycle_params(&json!({
                "connection": {
                    "id": id,
                    "name": "Twin",
                    "host": host,
                    "port": 22,
                    "username": "ops",
                    "password": format!("pw-{}", uuid::Uuid::new_v4()),
                }
            }))
            .unwrap();
            state
                .dbx_connections
                .write()
                .await
                .insert(id.to_string(), stored);
        }

        let resolved = state
            .registered_connection_by_ref(&json!({
                "connectionName": "Twin",
                "host": "10.0.0.2",
                "port": 22,
                "username": "ops",
            }))
            .await
            .unwrap()
            .expect("name plus endpoint should resolve one candidate");
        assert_eq!(resolved.id, "conn-y");
    }

    #[tokio::test]
    async fn conflicting_connection_selectors_are_rejected() {
        let state = state();
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-prod",
                "name": "Prod",
                "host": "prod.example.test",
                "port": 22,
                "username": "ops",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        }))
        .unwrap();
        state
            .dbx_connections
            .write()
            .await
            .insert(stored.id.clone(), stored);

        let error = state
            .registered_connection_by_ref(&json!({
                "connectionId": "conn-prod",
                "host": "other.example.test",
                "username": "ops",
            }))
            .await
            .unwrap_err();
        assert!(
            error.contains("does not match"),
            "unexpected error: {error}"
        );
    }

    /// Saved-connection addressing must reach the dialers: with the fix, an
    /// sftp call referencing a registered connection attempts the dial (a
    /// refused-port error) instead of dying on the pre-fix pool lookup, and
    /// ssh_test_connection no longer demands inline `host`.
    #[tokio::test]
    async fn sftp_and_test_connection_resolve_saved_reference_before_dialing() {
        let state = state();
        let stored = StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "conn-prod",
                "name": "Prod",
                "host": "127.0.0.1",
                "port": 1,
                "username": "ops",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        }))
        .unwrap();
        state
            .dbx_connections
            .write()
            .await
            .insert(stored.id.clone(), stored);

        for (tool, arguments) in [
            (
                "sftp_exists",
                json!({ "connectionName": "Prod", "path": "/tmp" }),
            ),
            ("ssh_test_connection", json!({ "connectionName": "Prod" })),
        ] {
            let error = state.call_tool(tool, &arguments, None).await.unwrap_err();
            assert!(
                !error.contains("Connection is not established")
                    && !error.contains("Missing required parameter"),
                "{tool} bypassed saved-connection resolution: {error}"
            );
        }
    }

    /// The MCP tool surface must expose the alert triage playbook: the
    /// stdio smoke asserts the tool by name, so a dispatch-only protocol
    /// method (`ssh/alert/triage`) without an MCP tool would regress the
    /// intent-recognition surface. Offline: no connection I/O involved.
    #[tokio::test]
    async fn alert_triage_is_wired_as_an_mcp_tool() {
        let state = state();
        let response = state
            .call_tool(
                "ssh_alert_triage",
                &json!({
                    "payload": json!({
                        "alertId": "unit-1",
                        "title": "CPU 使用率过高",
                        "severity": "critical",
                        "source": "prometheus",
                        "message": "node-1 cpu_usage above 0.9",
                    })
                    .to_string()
                }),
                None,
            )
            .await
            .unwrap();
        let envelope_text = response["content"][0]["text"].as_str().unwrap();
        let result: Value = serde_json::from_str(envelope_text).unwrap();
        assert_eq!(result["normalized"]["alertId"], "unit-1");
        assert_eq!(result["category"], "cpu");
        assert!(!result["suggestions"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn read_only_connection_gates_writes_and_unknown_commands() {
        let state = McpState::shared(Arc::new(SshRuntime::new(
            std::env::temp_dir().join("dbx-mcp-readonly-test"),
        )));
        let lifecycle = json!({
            "connection": {
                "id": "conn-readonly",
                "name": "Prod bastion",
                "host": "192.0.2.10",
                "port": 22,
                "username": "ops",
                "password": "secret",
                "external_config": { "authentication": "password", "read_only": true },
            },
            "runtime": { "host": "192.0.2.10", "port": 22 },
            "operationId": "op-ro",
        });

        // Write-class tools are rejected on sight.
        for tool in ["sftp_write_file", "ssh_exec_sudo"] {
            let error = state
                .call_dbx_with(
                    &json!({
                        "tool": tool,
                        "arguments": { "command": "uptime", "path": "/tmp/x", "content": "y" },
                        "lifecycle": lifecycle,
                    }),
                    None,
                )
                .await
                .expect_err("write tool must be refused on a read-only connection");
            assert!(error.contains("read-only"), "unexpected: {error}");
        }

        // ssh_exec survives only for provably read-only commands: an
        // unrecognized mutating command is refused by the whitelist (before
        // any dialing), while a destructive pattern is refused outright.
        let unknown = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "command": "systemctl restart nginx" },
                    "lifecycle": lifecycle,
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(unknown.contains("not recognized"), "unexpected: {unknown}");

        let destructive = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "command": "rm -rf /etc" },
                    "lifecycle": lifecycle,
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            destructive.contains("Refused on read-only"),
            "unexpected: {destructive}"
        );

        // confirmDestructive cannot override a read-only connection.
        let confirmed = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "command": "rm -rf /etc", "confirmDestructive": true },
                    "lifecycle": lifecycle,
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            confirmed.contains("Refused on read-only"),
            "unexpected: {confirmed}"
        );
    }

    // —— MCP 容错性专项（2026-09-13 测试覆盖审计）———

    #[test]
    fn argument_type_tolerant_parsers_accept_numeric_and_boolean_strings() {
        let arguments = json!({ "port": "2222", "timeoutSecs": 90, "tail": " 4000 " });
        assert_eq!(arg_u64(&arguments, "port").unwrap(), Some(2222));
        assert_eq!(arg_u64(&arguments, "timeoutSecs").unwrap(), Some(90));
        assert_eq!(arg_u64(&arguments, "tail").unwrap(), Some(4000));
        // 缺省与 null 都是 None；非法值给可行动错误而不是静默回默认。
        assert_eq!(arg_u64(&json!({}), "port").unwrap(), None);
        assert_eq!(arg_u64(&json!({ "port": null }), "port").unwrap(), None);
        let error = arg_u64(&json!({ "port": "abc" }), "port").unwrap_err();
        assert!(
            error.contains("port must be an integer") && error.contains("abc"),
            "{error}"
        );
        assert_eq!(arg_port(&json!({})).unwrap(), 22);
        assert_eq!(arg_port(&json!({ "port": "22" })).unwrap(), 22);
        assert!(arg_port(&json!({ "port": 0 }))
            .unwrap_err()
            .contains("between 1 and 65535"));
        assert!(arg_port(&json!({ "port": 99999 }))
            .unwrap_err()
            .contains("between 1 and 65535"));
        // 布尔字符串变体："true"/"yes"/"1" 为真，"off"/"0" 为假。
        for (value, expected) in [
            ("true", true),
            ("TRUE", true),
            (" yes ", true),
            ("1", true),
            ("false", false),
            ("Off", false),
            ("0", false),
        ] {
            assert_eq!(
                arg_bool(&json!({ "flag": value }), "flag").unwrap(),
                Some(expected),
                "{value}"
            );
        }
        assert_eq!(arg_bool(&json!({}), "flag").unwrap(), None);
        assert!(arg_bool(&json!({ "flag": "maybe" }), "flag")
            .unwrap_err()
            .contains("must be a boolean"));
    }

    #[test]
    fn chmod_mode_parsing_accepts_llm_variants() {
        // 字符串八进制（含 0o 前缀与补零）。
        assert_eq!(parse_chmod_mode(&json!("644")).unwrap(), 0o644);
        assert_eq!(parse_chmod_mode(&json!("0644")).unwrap(), 0o644);
        assert_eq!(parse_chmod_mode(&json!(" 0o755 ")).unwrap(), 0o755);
        assert_eq!(parse_chmod_mode(&json!("4755")).unwrap(), 0o4755);
        // 纯 0-7 数字的数字按八进制读：644 不是 0o1350。
        assert_eq!(parse_chmod_mode(&json!(644)).unwrap(), 0o644);
        assert_eq!(parse_chmod_mode(&json!(600)).unwrap(), 0o600);
        assert_eq!(parse_chmod_mode(&json!(0)).unwrap(), 0);
        // 其他数字按原始权限位读（Python 0o600 字面量 = 384）。
        assert_eq!(parse_chmod_mode(&json!(384)).unwrap(), 0o600);
        assert_eq!(parse_chmod_mode(&json!(493)).unwrap(), 0o755);
        // 越界与非法输入。
        assert!(parse_chmod_mode(&json!("999")).is_err());
        assert!(parse_chmod_mode(&json!(-1)).is_err());
        assert!(parse_chmod_mode(&json!(8192)).is_err());
        assert!(parse_chmod_mode(&json!(1.5)).is_err());
        assert!(parse_chmod_mode(&json!(true)).is_err());
    }

    #[test]
    fn tool_names_constant_matches_tool_definitions() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), TOOL_NAMES.len(), "tool count drifted");
        for (declared, constant) in names.iter().zip(TOOL_NAMES.iter()) {
            assert_eq!(declared, constant, "tool order/name mismatch");
        }
    }

    #[tokio::test]
    async fn unknown_tool_names_get_actionable_errors() {
        let state = state();
        // 分隔符/大小写变体给出 did-you-mean。
        let error = state
            .call_tool("sftp-listdir", &json!({}), None)
            .await
            .unwrap_err();
        assert!(
            error.contains("Unknown tool") && error.contains("Did you mean 'sftp_list_dir'?"),
            "{error}"
        );
        // 大小写变体精确命中。
        let error = state
            .call_tool("SSH_EXEC", &json!({}), None)
            .await
            .unwrap_err();
        assert!(error.contains("Did you mean 'ssh_exec'?"), "{error}");
        // 完全无关的名字指向 tools/list。
        let error = state
            .call_tool("database_query", &json!({}), None)
            .await
            .unwrap_err();
        assert!(
            error.contains("Unknown tool") && error.contains("tools/list"),
            "{error}"
        );
        // 未注册的 tool 名是 tools/call 之内的工具级错误，仍是 -32000
        // （传输层未知 method 才用标准 -32601，见 dispatch 注释）。
        let response = state
            .dispatch(json!({
                "jsonrpc": "2.0", "id": 41, "method": "tools/call",
                "params": { "name": "nope", "arguments": {} },
            }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32000);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Unknown tool"));
    }

    #[tokio::test]
    async fn malformed_ports_fail_fast_and_numeric_strings_parse() {
        let state = state();
        // 非法端口在一切门/拨号之前报范围错误（此前会静默回退 22 端口）。
        for bad_port in [json!(0), json!(99999), json!("0"), json!("abc"), json!(1.5)] {
            let error = state
                .call_tool(
                    "ssh_exec",
                    &json!({ "host": "h.test", "username": "op", "command": "true", "port": bad_port }),
                    None,
                )
                .await
                .unwrap_err();
            assert!(
                error.contains("port must be"),
                "expected port error for {bad_port}, got: {error}"
            );
        }
        // 合法端口的数字字符串继续走完校验链（在缺凭据处报错）。
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({ "host": "h.test", "username": "op", "command": "true", "port": "2222" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("password"), "unexpected: {error}");
    }

    #[tokio::test]
    async fn string_booleans_and_numbers_flow_through_the_gates() {
        let state = state();
        // confirmDestructive 写成字符串 "true" 同样过灾难门（此前恒读 false）。
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "h.test", "username": "op",
                    "command": "mkfs.ext4 /dev/sda1", "confirmDestructive": "true",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("password"),
            "string confirmDestructive must pass the gate, got: {error}"
        );
        // 非法布尔值给清晰报错（confirmDestructive 只在灾难分支被读取，
        // 所以必须配一条灾难命令才能触达解析）。
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "h.test", "username": "op",
                    "command": "mkfs.ext4 /dev/sda1", "confirmDestructive": "maybe",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("confirmDestructive must be a boolean"),
            "{error}"
        );
        // timeoutSecs 数字字符串被解析（非法值同样报错）。
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({ "host": "h.test", "username": "op", "command": "true", "timeoutSecs": "30" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("password"), "unexpected: {error}");
        let error = state
            .call_tool(
                "ssh_exec",
                &json!({ "host": "h.test", "username": "op", "command": "true", "timeoutSecs": "soon" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("timeoutSecs must be an integer"), "{error}");
    }

    #[tokio::test]
    async fn multi_exec_rejects_non_array_targets_with_guidance() {
        let state = state();
        let error = state
            .call_tool(
                "ssh_multi_exec",
                &json!({ "targets": "conn-1", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("targets must be an array") && error.contains("connectionId"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn ssh_close_demands_a_connection_reference() {
        let state = state();
        let error = state
            .call_tool("ssh_close", &json!({}), None)
            .await
            .unwrap_err();
        assert!(
            error.contains("ssh_close needs a connection reference"),
            "{error}"
        );
    }

    #[test]
    fn required_str_reports_type_mismatch_with_guidance() {
        let arguments = json!({ "localPath": 42, "path": "" });
        let error = required_str(&arguments, "localPath").unwrap_err();
        assert!(
            error.contains("localPath") && error.contains("non-empty string"),
            "{error}"
        );
        // 空字符串与缺失走同一条消息（键名始终可见）。
        let error = required_str(&arguments, "path").unwrap_err();
        assert!(error.contains("path"), "{error}");
    }

    // —— MCP 第二轮：降级矩阵 + 安全门组合矩阵（2026-09-13）———

    fn stored_connection(id: &str, host: &str, port: u16, extra: Value) -> StoredConnection {
        let mut connection = json!({
            "connection": {
                "id": id,
                "host": host,
                "port": port,
                "username": "deploy",
                "password": format!("pw-{}", uuid::Uuid::new_v4()),
            }
        });
        if let (Some(target), Some(source)) = (connection.get_mut("connection"), extra.as_object())
        {
            for (key, value) in source {
                target[key.clone()] = value.clone();
            }
        }
        StoredConnection::from_lifecycle_params(&connection).unwrap()
    }

    /// 降级矩阵 ①：每一个连接级工具在 stdio 会话里带未注册 connectionId 时
    /// 都会进入 L1 桥转发计划（即桥不可用时全部走同一 fail-closed 回落），
    /// 而本地工具从不转发。只读进程级开关不改变转发决定（转发语义由
    /// 应用侧门禁负责）。
    #[tokio::test]
    async fn every_connection_bound_tool_plans_a_bridge_forward_for_a_ghost_id() {
        let mut state = state();
        state.bridge_fallback = true;
        let forwarders: Vec<&str> = TOOL_NAMES
            .iter()
            .copied()
            .filter(|name| is_connection_bound_tool(name))
            .collect();
        assert_eq!(forwarders.len(), 23, "connection-bound tool set drifted");
        for name in forwarders {
            let arguments = match name {
                "ssh_exec" | "ssh_exec_sudo" | "ssh_run_bg" => {
                    json!({ "connectionId": "ghost", "command": "uptime" })
                }
                "ssh_task_status" => {
                    json!({ "connectionId": "ghost", "logPath": "/tmp/.dbx-ssh-tasks/x.log" })
                }
                "docker_action" => {
                    json!({ "connectionId": "ghost", "containerId": "d4a7c9f1e2b3", "action": "start" })
                }
                "sftp_upload" => json!({ "connectionId": "ghost",
                    "localPath": "/tmp/in", "remotePath": "/tmp/out" }),
                "sftp_download" => json!({ "connectionId": "ghost",
                    "remotePath": "/tmp/in", "localPath": "/tmp/out" }),
                _ => json!({ "connectionId": "ghost", "path": "/tmp" }),
            };
            let plan = state
                .bridge_forward_plan(name, &arguments)
                .await
                .unwrap_or_else(|error| panic!("{name} plan errored: {error}"));
            assert!(
                plan.is_some(),
                "{name} with an unregistered connectionId must plan a bridge forward"
            );
            let (id, forwarded) = plan.unwrap();
            assert_eq!(id, "ghost", "{name} must forward under the requested id");
            assert_eq!(forwarded["connectionId"], "ghost");
        }
        // 本地工具与本地无连接工具不进转发计划。
        for name in [
            "ssh_close",
            "ssh_list_connections",
            "ssh_alert_triage",
            "ssh_list_known_hosts",
            "ssh_quick_sudo_profiles_list",
        ] {
            let plan = state
                .bridge_forward_plan(name, &json!({ "connectionId": "ghost" }))
                .await
                .unwrap();
            assert!(plan.is_none(), "{name} must stay local");
        }
    }

    /// 降级矩阵 ②：连接寻址双源（bridge registry vs session registry）
    /// 同 id 冲突时桥数据胜出且不产生重复条目；不同 id 各自成列；作用域
    /// 对两个来源都生效。
    #[test]
    fn connection_list_merge_resolves_dual_source_conflicts() {
        let bridge_entry = |id: &str, host: &str| {
            json!({
                "id": id, "name": id.to_uppercase(), "host": host, "port": 22,
                "username": "deploy", "authentication": "password", "readOnly": false,
            })
        };
        let registry = vec![
            // 同 id 不同 host：会话注册表声明更旧的元数据。
            stored_connection("conn-x", "old.example.test", 22, json!({})),
            // 不同 id：必须与桥条目并列出现。
            stored_connection("conn-y", "other.example.test", 2222, json!({})),
        ];
        let bridge = Ok(vec![
            bridge_entry("conn-x", "new.example.test"),
            bridge_entry("conn-y", "other.example.test"),
        ]);

        let merged =
            connection_list_result(bridge.clone(), &registry, &ConnectionScope::Unrestricted);
        assert_eq!(merged["source"], "dbx-app-bridge");
        let rows = merged["connections"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "id conflict must deduplicate, not append");
        let x = rows.iter().find(|row| row["id"] == "conn-x").unwrap();
        assert_eq!(
            x["host"], "new.example.test",
            "bridge metadata wins on an id conflict"
        );

        // 作用域对桥与注册表两来源都过滤：只留 conn-y。
        let scoped = connection_list_result(
            bridge,
            &registry,
            &ConnectionScope::AllowList(vec!["conn-y".to_string()]),
        );
        let rows = scoped["connections"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0]["id"], "conn-y");

        // 桥不可用时降级到注册表 + note（同 id 冲突无从发生）。
        let degraded = connection_list_result(
            Err("bridge down".into()),
            &registry,
            &ConnectionScope::Unrestricted,
        );
        assert_eq!(degraded["source"], "session-registry");
        assert_eq!(degraded["connections"].as_array().unwrap().len(), 2);
    }

    /// 安全门组合矩阵：只读门 × confirmDestructive × sudo 白名单 × 进程级
    /// 只读开关 × connectionScope 的组合行为。核心不变量：
    /// 白名单/确认位都不放大权限——灾难门永远在白名单之后仍然生效；
    /// 只读门先于一切；scope 是 fail-closed 的第一道闸。
    #[tokio::test]
    async fn gate_combo_matrix_read_only_destructive_sudo_and_scope() {
        // 普通连接（sudo 白名单：精确 systemctl restart nginx + shutdown *）。
        let rw_state = state();
        rw_state.dbx_connections.write().await.insert(
            "conn-rw".to_string(),
            stored_connection(
                "conn-rw",
                "web.example.test",
                22,
                json!({ "external_config": {
                        "sudo_whitelist": "systemctl restart nginx\nshutdown *"
                    } }),
            ),
        );
        // 只读连接（同白名单）：只读门必须先于白名单与确认位。
        let ro_state = state();
        ro_state.dbx_connections.write().await.insert(
            "conn-ro".to_string(),
            stored_connection(
                "conn-ro",
                "web.example.test",
                22,
                json!({ "read_only": true, "external_config": {
                        "sudo_whitelist": "systemctl restart nginx\nshutdown *"
                    } }),
            ),
        );
        // 组合 1：非只读 + 灾难命令 + confirmDestructive:true → 过灾难门
        // （错误是拨号失败，不再是 confirm 提示）。
        let error = rw_state
            .call_tool(
                "ssh_exec",
                &json!({
                    "connectionId": "conn-rw",
                    "command": "shutdown -h now",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("confirmDestructive") && !error.contains("looks destructive"),
            "confirmed destructive command must proceed past the gate, got: {error}"
        );

        // 组合 2：非只读 + 灾难命令 + 无确认 → confirm 提示（对照组）。
        let error = rw_state
            .call_tool(
                "ssh_exec",
                &json!({ "connectionId": "conn-rw", "command": "shutdown -h now" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("confirmDestructive"), "{error}");

        // 组合 3：白名单命中的灾难命令（shutdown -h now ∈ shutdown *）→
        // 白名单放行不豁免灾难门，仍需 confirmDestructive。
        let error = rw_state
            .call_tool(
                "ssh_exec_sudo",
                &json!({ "connectionId": "conn-rw", "command": "shutdown -h now" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("confirmDestructive") && !error.contains("whitelist"),
            "whitelist must not bypass the destructive gate, got: {error}"
        );
        // 同命令带确认后过两道门（白名单 + 灾难），落到拨号失败。
        let error = rw_state
            .call_tool(
                "ssh_exec_sudo",
                &json!({
                    "connectionId": "conn-rw",
                    "command": "shutdown -h now",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("whitelist") && !error.contains("confirmDestructive"),
            "confirmed whitelisted command must pass both gates, got: {error}"
        );

        // 组合 4：只读连接 + ssh_exec_sudo（写类）+ 命令命中白名单 →
        // 只读门先行，白名单救不回写工具。
        let error = ro_state
            .call_tool(
                "ssh_exec_sudo",
                &json!({ "connectionId": "conn-ro", "command": "systemctl restart nginx" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("read-only"),
            "read-only gate must fire before the whitelist, got: {error}"
        );

        // 组合 5：只读连接 + 白名单巡检命令 + confirmDestructive:true →
        // 确认位不改变白名单判定，调用照常走到拨号。
        let error = ro_state
            .call_tool(
                "ssh_exec",
                &json!({
                    "connectionId": "conn-ro",
                    "command": "df -h",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("read-only") && !error.contains("not recognized"),
            "inspection command must stay available on read-only, got: {error}"
        );

        // 组合 6：只读连接 + 灾难命令 + confirmDestructive:true →
        // 确认位无法覆盖只读（同命令在非只读上只需要确认）。
        let error = ro_state
            .call_tool(
                "ssh_exec",
                &json!({
                    "connectionId": "conn-ro",
                    "command": "shutdown -h now",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("Refused on read-only"),
            "read-only must refuse destructive commands outright, got: {error}"
        );

        // 组合 7：进程级只读开关（DBX_SSH_MCP_READ_ONLY）× 非只读注册连接
        // × 灾难命令 + 确认 → 操作员开关压过连接自身的可写属性。
        let mut killed_state = state();
        killed_state.global_read_only = true;
        killed_state.dbx_connections.write().await.insert(
            "conn-rw".to_string(),
            stored_connection("conn-rw", "web.example.test", 22, json!({})),
        );
        let error = killed_state
            .call_tool(
                "ssh_exec",
                &json!({
                    "connectionId": "conn-rw",
                    "command": "shutdown -h now",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("Refused on read-only"),
            "process kill switch must dominate the connection flag, got: {error}"
        );
        // 同开关下白名单巡检命令仍可用（fail-closed 不等于全拒）：错误来自
        // 拨号层而不是任何一道门。
        let error = killed_state
            .call_tool(
                "ssh_exec",
                &json!({ "connectionId": "conn-rw", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("read-only")
                && !error.contains("not recognized")
                && !error.contains("confirmDestructive"),
            "uptime must pass the gates and fail at dialing, got: {error}"
        );

        // 组合 8：connectionScope 非空 × 内联凭据 × 灾难命令 → scope 是
        // fail-closed 的第一道闸，报 scope 而非 confirm 提示。
        let scoped_state = state();
        scoped_state
            .settings_set(&json!({ "connectionScope": ["conn-rw"] }))
            .unwrap();
        let error = scoped_state
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "web.example.test", "username": "deploy",
                    "command": "shutdown -h now", "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("connectionScope"),
            "scope must refuse inline dials before the destructive gate, got: {error}"
        );
    }

    /// 组合矩阵补充：terminal_input 的只读 × 灾难 × sudo 白名单三闸叠加，
    /// 以及灾难 + 确认后仍受白名单约束（确认位只解锁灾难门一层）。
    #[tokio::test]
    async fn terminal_input_combo_gates_stack_in_order() {
        let state = state();
        state.dbx_connections.write().await.insert(
            "conn-ti".to_string(),
            stored_connection(
                "conn-ti",
                "web.example.test",
                22,
                json!({ "external_config": { "sudo_whitelist": "systemctl restart nginx" } }),
            ),
        );
        // 灾难行 + confirmDestructive → 过灾难门，但 sudo 行仍受白名单拒绝。
        let error = state
            .call_tool(
                "ssh_terminal_input",
                &json!({
                    "connectionId": "conn-ti",
                    "input": "sudo reboot\r",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("not allowed by this connection's whitelist"),
            "confirm must not lift the sudo allowlist, got: {error}"
        );
        // 白名单命中的 sudo 行 + 确认 → 两闸皆过，落到会话引导错误。
        let error = state
            .call_tool(
                "ssh_terminal_input",
                &json!({
                    "connectionId": "conn-ti",
                    "input": "sudo systemctl restart nginx\r",
                    "confirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("terminal"),
            "allowed sudo line must pass both gates, got: {error}"
        );
    }

    /// alert_triage 工具面（ssh_alert_triage）扩类：network / oom /
    /// service / generic / 中英混合按 KEYWORDS 表实际行为断言；每条建议
    /// 命令在工具出口处仍满足 D6（只读白名单可执行、无重定向/替换/sudo）。
    #[tokio::test]
    async fn alert_triage_tool_surface_classifies_extended_intents() {
        let state = state();
        let cases: [(&str, &str); 9] = [
            // (payload, 期望 category)
            (
                r#"{"alertId":"n1","message":"network eth0 packet loss 5%, bandwidth saturated"}"#,
                "network",
            ),
            // 中英混合：丢包 + bandwidth 双命中仍归 network。
            (
                r#"{"message":"网络抖动, 丢包严重, bandwidth 不足"}"#,
                "network",
            ),
            // OOM 优先于 memory（out of memory 同时命中 memory 关键词）。
            (
                r#"{"message":"Out of memory: oom-kill killed process 4321 (java)"}"#,
                "oom",
            ),
            (
                r#"{"message":"systemd unit cron.service restart failed"}"#,
                "service",
            ),
            // 零命中回落 generic。
            (
                r#"{"message":"backup job completed without errors at 03:00"}"#,
                "generic",
            ),
            // 中英混合 CPU。
            (r#"{"message":"CPU loadavg 飙升, 处理器过热"}"#, "cpu"),
            (r#"{"message":"内存 swap 已满, mem usage 99%"}"#, "memory"),
            (r#"{"message":"磁盘 no space left on device"}"#, "disk"),
            (r#"{"message":"inode usage 98% on /var"}"#, "inode"),
        ];
        for (payload, expected) in cases {
            let result = state
                .call_tool("ssh_alert_triage", &json!({ "payload": payload }), None)
                .await
                .expect("triage must succeed offline");
            let envelope: Value =
                serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(envelope["category"], expected, "payload: {payload}");
            let suggestions = envelope["suggestions"].as_array().unwrap();
            assert!(!suggestions.is_empty(), "payload: {payload}");
            for item in suggestions {
                let command = item["command"].as_str().unwrap();
                assert_eq!(
                    mcp_safety::assess_command(command),
                    CommandRisk::ReadOnly,
                    "suggestion not read-only: {command}"
                );
                assert!(!command.contains('>'));
                assert!(!command.contains("sudo"));
                assert!(!command.contains("$("));
            }
        }
        // service 类建议替换出具体 unit 名（服务名抽取在工具面生效）。
        let result = state
            .call_tool(
                "ssh_alert_triage",
                &json!({ "payload": r#"{"message":"systemd unit cron.service restart failed"}"# }),
                None,
            )
            .await
            .unwrap();
        let envelope: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            envelope["suggestions"][0]["command"],
            "systemctl status cron.service"
        );
    }

    /// settings 联动回归：mcp/settings/set 的每个可调项都能立即驱动受影响
    /// 工具的行为（传输根收窄、上传限额、confirm 档 fail-closed、scope 闸），
    /// settings_get 回显生效值与 persisted 值。
    #[tokio::test]
    async fn settings_set_changes_drive_downstream_tool_behavior() {
        // (a) localTransferRoot 收窄：默认根内的文件过根闸，收窄后被拒。
        let st = state();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("inside.bin"), b"data").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("outside.bin"), b"data").unwrap();
        let upload_args = |path: &Path| {
            json!({
                "host": "web.example.test", "username": "deploy",
                "localPath": path.to_str().unwrap(), "remotePath": "/tmp/x",
            })
        };
        // 默认允许根（系统临时目录）放行两个文件 → 错误是拨号失败而非根拒绝。
        let error = st
            .call_tool(
                "sftp_upload",
                &upload_args(&outside.path().join("outside.bin")),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("allowed transfer roots") && !error.contains("localTransferRoot"),
            "default roots must allow temp files, got: {error}"
        );
        // 收窄到 root 后：根外文件在拨号前被拒。
        st.settings_set(&json!({ "localTransferRoot": root.path().to_str().unwrap() }))
            .unwrap();
        let error = st
            .call_tool(
                "sftp_upload",
                &upload_args(&outside.path().join("outside.bin")),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("localTransferRoot"),
            "narrowed root must refuse outside paths, got: {error}"
        );
        // 根内文件过根闸（错误回到拨号层）。
        let error = st
            .call_tool(
                "sftp_upload",
                &upload_args(&root.path().join("inside.bin")),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("localTransferRoot") && !error.contains("allowed transfer roots"),
            "in-root file must pass the root gate, got: {error}"
        );

        // (b) maxUploadBytes：设置即时生效，超限文件在拨号前被拒。
        let st = state();
        let big = tempfile::tempdir().unwrap();
        std::fs::write(big.path().join("big.bin"), vec![0u8; 64]).unwrap();
        st.settings_set(&json!({ "maxUploadBytes": 32 })).unwrap();
        let error = st
            .call_tool(
                "sftp_upload",
                &json!({
                    "host": "web.example.test", "username": "deploy",
                    "localPath": big.path().join("big.bin").to_str().unwrap(),
                    "remotePath": "/tmp/x",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("exceeds the MCP upload limit"),
            "upload limit must apply immediately, got: {error}"
        );

        // (c) execPermissionMode=confirm：stdio 无审批通道 → 立即 fail-closed；
        // 切回 autonomous 后调用恢复（落到拨号错误）。
        let st = state();
        st.settings_set(&json!({ "execPermissionMode": "confirm" }))
            .unwrap();
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({ "host": "web.example.test", "username": "deploy", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("execPermissionMode=confirm"),
            "confirm mode must fail closed without an approval channel, got: {error}"
        );
        st.settings_set(&json!({ "execPermissionMode": "autonomous" }))
            .unwrap();
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({ "host": "web.example.test", "username": "deploy", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("execPermissionMode"),
            "switching back to autonomous must lift the gate, got: {error}"
        );

        // (d) connectionScope：非空即拒绝内联拨打（fail-closed），list 工具
        // 仍可用；清空后恢复。settings_get 回显生效值与 persisted 值。
        let st = state();
        st.settings_set(&json!({ "connectionScope": ["only-this"] }))
            .unwrap();
        let view = st.settings_get();
        assert_eq!(view["connectionScope"], json!(["only-this"]));
        assert_eq!(view["persistedConnectionScope"], json!(["only-this"]));
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({ "host": "web.example.test", "username": "deploy", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("connectionScope"), "{error}");
        let listed = st.call_tool("ssh_list_connections", &json!({}), None).await;
        assert!(listed.is_ok(), "list stays answerable under a scope");
        st.settings_set(&json!({ "connectionScope": [] })).unwrap();
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({ "host": "web.example.test", "username": "deploy", "command": "uptime" }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("connectionScope"),
            "clearing the scope must lift the gate, got: {error}"
        );
    }

    /// 生产路径端口早校验挡死 arg_port_lossy 的静默回退：任何工具带非法
    /// 端口都在门/池键/known_hosts 触碰之前报错，绝不按 22 继续。
    #[tokio::test]
    async fn malformed_port_is_rejected_before_lossy_gate_reads() {
        let st = state();
        // sftp 工具：非法端口在 lossy 门查找/池键派生之前被早校验拦下。
        let error = st
            .call_tool(
                "sftp_stat",
                &json!({
                    "host": "web.example.test", "username": "deploy",
                    "path": "/tmp", "port": "abc",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("port must be an integer"),
            "expected the early port check, got: {error}"
        );
        // ssh_close：端口早校验先于工具自身的引用指引。
        let error = st
            .call_tool(
                "ssh_close",
                &json!({ "connectionName": "x", "port": 0 }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.contains("port must be between 1 and 65535"),
            "{error}"
        );
        // known_hosts 工具同样先过早校验，不触碰文件。
        let error = st
            .call_tool(
                "ssh_remove_known_host",
                &json!({ "host": "h.example.test", "port": 99999 }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("port must be between"), "{error}");
    }

    /// schema 外未知参数静默忽略（宿主职责）不得反噬：多余字段不改变既有
    /// 参数的解析，大小写变体不被识别（也不解锁任何门）。
    #[tokio::test]
    async fn unknown_arguments_never_distort_known_parameter_parsing() {
        let st = state();
        // 未知参数 + 合法参数混合：仍在缺密码处报错（解析未被带偏）。
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "web.example.test", "username": "deploy", "command": "true",
                    "totallyUnknown": { "nested": true }, "cmd": "evil",
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("password"), "{error}");
        // 大小写不同的 "Port" 不被识别为 port：不触发范围错误，按缺省 22。
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "web.example.test", "username": "deploy",
                    "command": "true", "Port": 99999,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(
            !error.contains("port must be"),
            "unknown-case key must be ignored, got: {error}"
        );
        assert!(error.contains("password"), "{error}");
        // 大写 ConfirmDestructive 不解锁灾难门（未知参数不能放大权限）。
        let error = st
            .call_tool(
                "ssh_exec",
                &json!({
                    "host": "web.example.test", "username": "deploy",
                    "command": "mkfs.ext4 /dev/sda1", "ConfirmDestructive": true,
                }),
                None,
            )
            .await
            .unwrap_err();
        assert!(error.contains("confirmDestructive"), "{error}");
        // 本地工具携带未知参数照常成功。
        let result = st
            .call_tool(
                "ssh_alert_triage",
                &json!({ "payload": "cpu high", "extra": 42 }),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result["isError"], false);
    }
}

#[cfg(test)]
mod dbx_bridge_tests {
    use super::*;

    #[tokio::test]
    async fn dbx_bridge_registers_lifecycle_and_dispatches_tools() {
        let state = McpState::shared(Arc::new(SshRuntime::new(
            std::env::temp_dir().join("dbx-mcp-bridge-test"),
        )));
        let lifecycle = json!({
            "connection": {
                "id": "conn-ssh-1",
                "name": "Prod bastion",
                "host": "192.0.2.10",
                "port": 22,
                "username": "ops",
                "password": "secret",
                "external_config": { "authentication": "password", "quick_sudo": true },
                "connection_secrets": { "totp_secret": "JBSWY3DPEHPK3PXP" },
            },
            "runtime": { "host": "192.0.2.10", "port": 22 },
            "operationId": "op-1",
        });

        // A tool that needs no connection runs right away.
        let listed = state
            .call_dbx_with(
                &json!({ "tool": "ssh_list_known_hosts", "arguments": {}, "lifecycle": lifecycle }),
                None,
            )
            .await
            .unwrap();
        assert!(listed["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("knownHosts"));

        // The lifecycle connection is registered: a connection-bound tool now
        // gets past credential resolution (it fails on the missing command
        // parameter, proving connectionId routing works end to end).
        let err = state
            .call_dbx_with(&json!({ "tool": "ssh_exec", "arguments": {} }), None)
            .await
            .err()
            .unwrap();
        assert!(err.contains("command"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn dbx_bridge_requires_complete_lifecycle_payloads() {
        let state = McpState::shared(Arc::new(SshRuntime::new(
            std::env::temp_dir().join("dbx-mcp-bridge-test-2"),
        )));
        let err = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "command": "true" },
                    "lifecycle": { "connection": { "id": "x", "username": "u", "password": "p" } },
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(err.contains("host"), "unexpected error: {err}");
    }

    /// L3: a lifecycle-registered connection is resolvable by its display
    /// name — the call gets past the registry lookup and fails on the
    /// missing tool parameter instead, proving name → connection routing.
    #[tokio::test]
    async fn connection_name_resolves_through_registry() {
        let mut state = McpState::shared(Arc::new(SshRuntime::new(
            std::env::temp_dir().join("dbx-mcp-name-test"),
        )));
        // Hermetic: keep the name-miss path off the real app bridge.
        state.bridge_fallback = false;
        let lifecycle = json!({
            "connection": {
                "id": "conn-named",
                "name": "Prod bastion",
                "host": "192.0.2.10",
                "port": 22,
                "username": "ops",
                "password": "secret",
            },
            "runtime": { "host": "192.0.2.10", "port": 22 },
            "operationId": "op-name",
        });
        let listed = state
            .call_dbx_with(
                &json!({ "tool": "ssh_list_known_hosts", "arguments": {}, "lifecycle": lifecycle }),
                None,
            )
            .await
            .unwrap();
        assert!(listed["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("knownHosts"));

        // connectionName (exact, as stored) reaches the tool's own parameter
        // validation: the registry lookup passed.
        let err = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "connectionName": "Prod bastion" },
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(err.contains("command"), "unexpected error: {err}");

        // An unknown name gets the self-heal guidance (no bridge available
        // in tests is the same degradation as an older app).
        let err = state
            .call_dbx_with(
                &json!({
                    "tool": "ssh_exec",
                    "arguments": { "connectionName": "ghost", "command": "true" },
                }),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(
            err.contains("No connection named 'ghost'") && err.contains("ssh_list_connections"),
            "unexpected error: {err}"
        );
    }

    // —— M17：MCP 工具面文件名编码模式 ——

    #[test]
    fn mcp_encoding_prefers_connection_override_then_global() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let store = preferences::store_path(data_dir.path());
        // 只设连接覆盖：命中覆盖 → latin-1；未命中的连接 → 全局缺省 auto。
        std::fs::write(
            &store,
            r#"{"prefs":{"sftp_name_encoding_overrides":{"conn-1":"latin-1"}}}"#,
        )
        .expect("write prefs");
        assert_eq!(
            mcp_sftp_encoding(data_dir.path(), &json!({ "connectionId": "conn-1" })),
            sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            mcp_sftp_encoding(data_dir.path(), &json!({ "connectionId": "conn-2" })),
            sftp_name::NameEncoding::Auto
        );
        // 全局 latin-1：内联拨号（无 connectionId，dispatch 层也无法归一化）
        // 按未覆盖处理，跟随全局。
        std::fs::write(&store, r#"{"prefs":{"sftp_name_encoding":"latin-1"}}"#)
            .expect("write prefs");
        assert_eq!(
            mcp_sftp_encoding(data_dir.path(), &json!({})),
            sftp_name::NameEncoding::Latin1
        );
        // 连接覆盖压过全局偏好（优先级链第三态）。
        std::fs::write(
            &store,
            r#"{"prefs":{"sftp_name_encoding":"latin-1","sftp_name_encoding_overrides":{"conn-9":"auto"}}}"#,
        )
        .expect("write prefs");
        assert_eq!(
            mcp_sftp_encoding(data_dir.path(), &json!({ "connectionId": "conn-9" })),
            sftp_name::NameEncoding::Auto
        );
    }

    #[test]
    fn raw_list_items_display_paths_round_trip_to_server_bytes() {
        let entry = |name: &[u8], size: Option<u64>, permissions: Option<u32>| sftp_raw::RawEntry {
            name: name.to_vec(),
            attrs: sftp_raw::RawAttrs {
                size,
                permissions,
                mtime: Some(100),
                ..sftp_raw::RawAttrs::default()
            },
        };
        let items = raw_list_items(
            "/data",
            vec![
                entry(b"caf\xe9.txt", Some(12), Some(0o100644)),
                entry(b"dir\xe9", None, Some(0o040755)),
                entry(b".", None, Some(0o040755)),
                entry(b"..", None, None),
                entry(b"\xff\xfe.bin", Some(3), None),
            ],
        );
        // `.`/`..` 跳过；名字口径 = 显示形式（latin-1 解码，忠实可逆）。
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["name"], json!("caf\u{e9}.txt"));
        assert_eq!(items[0]["path"], json!("/data/caf\u{e9}.txt"));
        assert_eq!(items[0]["kind"], json!("file"));
        assert_eq!(items[0]["size"], json!(12));
        assert_eq!(items[0]["modifiedAt"], json!(100));
        assert_eq!(items[1]["name"], json!("dir\u{e9}"));
        assert_eq!(items[1]["path"], json!("/data/dir\u{e9}"));
        assert_eq!(items[1]["kind"], json!("directory"));
        // attrs 缺 permissions（非标准服务器）退回 file，不误判成目录。
        assert_eq!(items[2]["name"], json!("\u{ff}\u{fe}.bin"));
        assert_eq!(items[2]["kind"], json!("file"));

        // 往返闭环：AI 把列表返回的 path 原样回传给 sftp_remove 等写工具时，
        // latin1_encode_display 精确还原服务器原始字节（显示 → 字节是 latin-1
        // 解码的逆变换，目录 ASCII 前缀按字面量透传）。
        assert_eq!(
            sftp_name::latin1_encode_display(items[0]["path"].as_str().unwrap()),
            b"/data/caf\xe9.txt".to_vec()
        );
        // 子目录导航同样闭环：父列表返回的显示目录路径进入下一次列表/
        // rename 目标组合时还原字节。
        assert_eq!(
            sftp_name::latin1_encode_display(items[1]["path"].as_str().unwrap()),
            b"/data/dir\xe9".to_vec()
        );
        // rename 往返：源 = 列表回传显示路径；目标 = 同目录 + 新输入显示文本
        //（latin-1 域内字符映回同值字节）。
        assert_eq!(
            sftp_name::latin1_encode_display(items[0]["path"].as_str().unwrap()),
            b"/data/caf\xe9.txt".to_vec()
        );
        assert_eq!(
            sftp_name::latin1_encode_display("/data/caf\u{e9}2.txt"),
            b"/data/caf\xe92.txt".to_vec()
        );
    }

    // —— M18：MCP 工具面剩余 SFTP 工具的 latin-1 往返闭环 ——

    /// 带请求日志的内存桩裸包客户端（复用 `sftp_raw::test_support` 的
    /// duplex 桩服务器，不连 SSH）。请求日志记录的是去帧 payload：
    /// `[type, id 4 字节, 包体]`。
    async fn stub_raw_sftp(
        replies: Vec<Vec<u8>>,
    ) -> (
        sftp_raw::RawSftp<tokio::io::DuplexStream>,
        sftp_raw::test_support::RequestLog,
    ) {
        let log = sftp_raw::test_support::request_log();
        let (client_side, server_side) = tokio::io::duplex(4096);
        tokio::spawn(sftp_raw::test_support::scripted_server(
            server_side,
            replies,
            Some(log.clone()),
        ));
        let client = sftp_raw::RawSftp::init(client_side).await.unwrap();
        (client, log)
    }

    #[tokio::test]
    async fn raw_stat_maps_v3_attrs_and_lstat_carries_latin1_path_bytes() {
        let (mut client, log) = stub_raw_sftp(vec![sftp_raw::test_support::attrs_body_full(
            12,
            0o100644,
            Some(111),
            Some(222),
        )])
        .await;
        let path = "/data/caf\u{e9}.txt";
        let attrs = client
            .lstat(&sftp_name::latin1_encode_display(path))
            .await
            .unwrap();
        // 裸包 attrs 无 uid/gid：调用方 shell 查询尽力而为（此处按缺省
        // None 验证装配口径），主元数据不受影响。
        let stat = raw_stat_json(path, attrs, None, None);
        assert_eq!(stat["size"], json!(12));
        assert_eq!(stat["permissions"], json!("0644"));
        assert_eq!(stat["modifiedAt"], json!(222));
        assert_eq!(stat["accessedAt"], json!(111));
        assert_eq!(stat["uid"], Value::Null);
        assert_eq!(stat["gid"], Value::Null);
        // 字节级闭环：LSTAT 帧携带显示路径还原出的服务器原始字节。
        let lstat = &sftp_raw::test_support::recorded_requests(&log)[1];
        assert_eq!(lstat[0], 7); // FXP_LSTAT
        assert_eq!(&lstat[9..], b"/data/caf\xe9.txt");
        // 响应里的 path 原样回传工具面即落回原始字节（精确逆变换）。
        assert_eq!(
            sftp_name::latin1_encode_display(stat["path"].as_str().unwrap()),
            b"/data/caf\xe9.txt".to_vec()
        );
    }

    #[tokio::test]
    async fn raw_sftp_exists_maps_no_such_file_only() {
        // 存在：LSTAT → ATTRS。
        let (mut client, log) =
            stub_raw_sftp(vec![sftp_raw::test_support::attrs_body(1, 0o100644)]).await;
        assert!(raw_sftp_exists(&mut client, "/d/caf\u{e9}.txt")
            .await
            .unwrap());
        let lstat = &sftp_raw::test_support::recorded_requests(&log)[1];
        assert_eq!(lstat[0], 7); // FXP_LSTAT
        assert_eq!(&lstat[9..], b"/d/caf\xe9.txt");

        // 不存在：LSTAT → SSH_FX_NO_SUCH_FILE。
        let (mut client, _) = stub_raw_sftp(vec![sftp_raw::test_support::status_body(2)]).await;
        assert!(!raw_sftp_exists(&mut client, "/d/caf\u{e9}.txt")
            .await
            .unwrap());

        // 其余错误如实上抛：绝不把权限失败误报成 exists:false（auto 分支
        // 同契约）。
        let (mut client, _) = stub_raw_sftp(vec![sftp_raw::test_support::status_body(3)]).await;
        let error = raw_sftp_exists(&mut client, "/d/x").await.unwrap_err();
        assert!(error.contains("status 3"), "{error}");
    }

    #[tokio::test]
    async fn raw_sftp_read_file_round_trips_latin1_path_and_flags_truncation() {
        // 截断：max_bytes=5，服务器回 11 字节 → truncated=true + 截到 5。
        let (mut client, log) = stub_raw_sftp(vec![
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::data_body(b"hello world"),
            sftp_raw::test_support::status_body(0),
        ])
        .await;
        let (data, truncated) = raw_sftp_read_file(&mut client, "/d/caf\u{e9}.txt", 0, 5)
            .await
            .unwrap();
        assert!(truncated);
        assert_eq!(data, b"hello".to_vec());
        // OPEN 帧路径字节 = 显示路径的 latin1_encode_display 逆变换
        // （payload = type + id + path_len + path + pflags + attrs）。
        let open = &sftp_raw::test_support::recorded_requests(&log)[1];
        assert_eq!(open[0], 3); // FXP_OPEN
        assert_eq!(&open[9..20], b"/d/caf\xe9.txt");

        // 未截断 + offset 分页起点显式携带（READ 循环读到 EOF 收尾）。
        let (mut client, log) = stub_raw_sftp(vec![
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::data_body(b"rld"),
            sftp_raw::test_support::status_body(1), // SSH_FX_EOF：数据读完
            sftp_raw::test_support::status_body(0), // CLOSE
        ])
        .await;
        let (data, truncated) = raw_sftp_read_file(&mut client, "/d/f", 8, 100)
            .await
            .unwrap();
        assert!(!truncated);
        assert_eq!(data, b"rld".to_vec());
        let read = &sftp_raw::test_support::recorded_requests(&log)[2];
        assert_eq!(read[0], 5); // FXP_READ
        assert_eq!(&read[11..19], &8_u64.to_be_bytes());
    }

    #[tokio::test]
    async fn raw_sftp_write_file_chunks_at_32kib_and_round_trips_latin1_path() {
        let content = vec![0xA9_u8; sftp_raw::MAX_WRITE_CHUNK + 5];
        let (mut client, log) = stub_raw_sftp(vec![
            sftp_raw::test_support::status_body(2), // LSTAT 预检：目标不存在
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::status_body(0), // WRITE#1
            sftp_raw::test_support::status_body(0), // WRITE#2
            sftp_raw::test_support::status_body(0), // CLOSE
        ])
        .await;
        let written = raw_sftp_write_file(&mut client, "/d/caf\u{e9}.txt", &content, false)
            .await
            .unwrap();
        assert_eq!(written["bytes"], json!(content.len()));
        let requests = sftp_raw::test_support::recorded_requests(&log);
        // 覆盖预检与 OPEN 同一字节口径（显示路径 → 服务器原始字节）。
        let lstat = &requests[1];
        assert_eq!(lstat[0], 7); // FXP_LSTAT
        assert_eq!(&lstat[9..], b"/d/caf\xe9.txt");
        let open = &requests[2];
        assert_eq!(open[0], 3); // FXP_OPEN
        assert_eq!(&open[9..20], b"/d/caf\xe9.txt");
        // WRITE 按 32 KiB 切块、offset 显式推进（payload 坐标：type+id+
        // handle_len+handle 之后是 offset 8 字节）。
        let write1 = &requests[3];
        assert_eq!(write1[0], 6); // FXP_WRITE
        assert_eq!(&write1[11..19], &0_u64.to_be_bytes());
        let write2 = &requests[4];
        assert_eq!(
            &write2[11..19],
            &(sftp_raw::MAX_WRITE_CHUNK as u64).to_be_bytes()
        );
        assert_eq!(write2[23..].len(), 5);
    }

    #[tokio::test]
    async fn raw_sftp_write_file_refuses_existing_target_without_overwrite() {
        let (mut client, _) =
            stub_raw_sftp(vec![sftp_raw::test_support::attrs_body(1, 0o100644)]).await;
        let error = raw_sftp_write_file(&mut client, "/d/caf\u{e9}.txt", b"x", false)
            .await
            .unwrap_err();
        assert!(error.contains("already exists"), "{error}");
    }

    #[tokio::test]
    async fn raw_sftp_upload_round_trips_latin1_path_and_payload() {
        // M19 sftp_upload 裸包车道：覆盖预检 LSTAT（NO_SUCH_FILE）→ OPEN →
        // WRITE → CLOSE；OPEN 帧路径字节 = 显示路径 latin1_encode_display
        // 逆变换，载荷逐字节落 WRITE 帧（与 sftp_download 的往返闭环见
        // raw_sftp_upload_download_round_trip_closes_latin1_loop）。
        let payload = b"mcp upload \xE9 \xA9 payload".to_vec();
        let (mut client, log) = stub_raw_sftp(vec![
            sftp_raw::test_support::status_body(2), // LSTAT 预检：目标不存在
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::status_body(0), // WRITE
            sftp_raw::test_support::status_body(0), // CLOSE
        ])
        .await;
        let bytes = raw_sftp_write_bytes(&mut client, "/up/caf\u{e9}.bin", &payload, false)
            .await
            .unwrap();
        assert_eq!(bytes, payload.len());
        let requests = sftp_raw::test_support::recorded_requests(&log);
        // 覆盖预检与 OPEN 同一字节口径（显示路径 → 服务器原始字节）。
        let lstat = &requests[1];
        assert_eq!(lstat[0], 7); // FXP_LSTAT
        assert_eq!(&lstat[9..], b"/up/caf\xe9.bin");
        let open = &requests[2];
        assert_eq!(open[0], 3); // FXP_OPEN
        assert_eq!(&open[9..21], b"/up/caf\xe9.bin");
        // WRITE 帧尾部载荷逐字节一致（payload = type+id+handle_len+handle
        // +offset+data_len 之后是 data）。
        let write = &requests[3];
        assert_eq!(write[0], 6); // FXP_WRITE
        assert_eq!(&write[write.len() - payload.len()..], &payload[..]);
    }

    #[tokio::test]
    async fn raw_sftp_download_round_trips_latin1_path_and_payload() {
        // M19 sftp_download 裸包车道：OPEN(READ) → READ → EOF → CLOSE；
        // OPEN 帧路径字节 = 显示路径 latin1_encode_display 逆变换，载荷
        // 逐字节回收（与 upload 的同路径闭环见下一条）。
        let payload = b"mcp download \xE9 \xA9 payload".to_vec();
        let (mut client, log) = stub_raw_sftp(vec![
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::data_body(&payload),
            sftp_raw::test_support::status_body(1), // SSH_FX_EOF：读完
            sftp_raw::test_support::status_body(0), // CLOSE
        ])
        .await;
        let (data, truncated) = raw_sftp_read_file(&mut client, "/up/caf\u{e9}.bin", 0, 4096)
            .await
            .unwrap();
        assert!(!truncated);
        assert_eq!(data, payload);
        let open = &sftp_raw::test_support::recorded_requests(&log)[1];
        assert_eq!(open[0], 3); // FXP_OPEN
        assert_eq!(&open[9..21], b"/up/caf\xe9.bin");
    }

    #[tokio::test]
    async fn raw_sftp_upload_download_round_trip_closes_latin1_loop() {
        // M19 往返闭环：同一显示路径下，upload 的 OPEN 帧路径字节与
        // download 的 OPEN 帧路径字节完全一致（同一 latin1_encode_display
        // 逆变换），且上传载荷经下载侧逐字节回收——latin-1 域内显示 → 字节
        // → 显示精确闭环（duplex 桩先例，M18 同款）。
        let payload = b"mcp round trip \xE9 \xA9 payload".to_vec();
        let display_path = "/up/caf\u{e9}.bin";
        let raw_path = b"/up/caf\xe9.bin";

        // 前半程：upload（LSTAT 不存在 → OPEN → WRITE → CLOSE）。
        let (mut client, upload_log) = stub_raw_sftp(vec![
            sftp_raw::test_support::status_body(2),
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::status_body(0),
            sftp_raw::test_support::status_body(0),
        ])
        .await;
        let bytes = raw_sftp_write_bytes(&mut client, display_path, &payload, false)
            .await
            .unwrap();
        assert_eq!(bytes, payload.len());
        let upload_open = &sftp_raw::test_support::recorded_requests(&upload_log)[2];
        assert_eq!(upload_open[0], 3); // FXP_OPEN
        assert_eq!(&upload_open[9..9 + raw_path.len()], &raw_path[..]);

        // 后半程：download（OPEN → READ → EOF → CLOSE），同一显示路径。
        let (mut client, download_log) = stub_raw_sftp(vec![
            sftp_raw::test_support::handle_body(b"h1"),
            sftp_raw::test_support::data_body(&payload),
            sftp_raw::test_support::status_body(1), // SSH_FX_EOF：读完
            sftp_raw::test_support::status_body(0),
        ])
        .await;
        let (data, truncated) = raw_sftp_read_file(&mut client, display_path, 0, 4096)
            .await
            .unwrap();
        assert!(!truncated);
        assert_eq!(data, payload);
        let download_open = &sftp_raw::test_support::recorded_requests(&download_log)[1];
        assert_eq!(download_open[0], 3); // FXP_OPEN
                                         // 两侧 OPEN 帧路径字节一致：AI 把 upload 响应里的 remotePath 原样
                                         // 回传给 sftp_download 即命中同一组服务器字节。

        assert_eq!(
            &download_open[9..9 + raw_path.len()],
            &upload_open[9..9 + raw_path.len()]
        );
    }

    #[tokio::test]
    async fn raw_sftp_chmod_sends_setstat_with_latin1_path_bytes() {
        let (mut client, log) = stub_raw_sftp(vec![sftp_raw::test_support::status_body(0)]).await;
        let result = raw_sftp_chmod(&mut client, "/d/caf\u{e9}.txt", 0o600)
            .await
            .unwrap();
        assert_eq!(result["mode"], json!("0600"));
        let setstat = &sftp_raw::test_support::recorded_requests(&log)[1];
        assert_eq!(setstat[0], 9); // FXP_SETSTAT
        assert_eq!(&setstat[9..20], b"/d/caf\xe9.txt");
        // attrs 只带 permissions 子集：flags=ATTR_PERMISSIONS(0x4) + mode。
        let attrs = &setstat[20..]; // path 之后紧跟编码 attrs
        assert_eq!(&attrs[..4], &4_u32.to_be_bytes());
        assert_eq!(&attrs[4..], &0o600_u32.to_be_bytes());
    }
}
