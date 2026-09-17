//! Client for the DBX app's local TCP bridge: lets the stdio MCP server
//! (`--mcp`, no embedded emitter) forward `runInTerminal` tool calls into the
//! running DBX app. The app listens on `127.0.0.1:<port>` and publishes the
//! port in `<app_data_dir>/mcp-bridge-port`; `POST /call-plugin-tool` relays
//! the call to the app's own plugin sidecar (the same process as the
//! workbench), so the command surfaces in the app's visible terminal UI.
//!
//! Deliberately dependency-free: a minimal hand-written HTTP/1.1 POST with an
//! explicit `Content-Length`, response read to EOF, status line + body split.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Port discovery file the app writes into its resolved app-data dir.
const PORT_FILE_NAME: &str = "mcp-bridge-port";
/// Plugin identity the bridge expects for this sidecar's calls.
const PLUGIN_ID: &str = "io.dbx.ssh";
/// Fallback app-data location when `DBX_APP_DATA_DIR` is unset (macOS).
const DEFAULT_APP_DATA_SUBPATH: &str = "Library/Application Support/com.dbx.app";
/// Budget for the local TCP hop.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Teaching-mode approval (up to 120s) happens inside the bridge call, so the
/// HTTP read must outlast the tool timeout by the approval budget plus slack
/// (contract: the read timeout must be >= the forwarded `timeout_ms`).
const APPROVAL_READ_MARGIN: Duration = Duration::from_secs(150);
/// The app reads the whole request with a single 64 KiB read, so the request
/// must fit one write inside that window.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// How long `ensure_app_bridge` keeps polling for the port after a launch
/// attempt.
pub const DEFAULT_ENSURE_WAIT: Duration = Duration::from_secs(30);

/// `<app_data_dir>` resolution order: env `DBX_APP_DATA_DIR`, then
/// `$HOME/Library/Application Support/com.dbx.app`.
fn default_app_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("DBX_APP_DATA_DIR")
        .map(PathBuf::from)
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        return Some(dir);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(DEFAULT_APP_DATA_SUBPATH))
}

/// Reads the bridge port the app published (decimal, whitespace-tolerant).
/// A missing or corrupted file yields `None`.
pub fn bridge_port(app_data_dir: Option<&Path>) -> Option<u16> {
    let dir = match app_data_dir {
        Some(dir) => dir.to_path_buf(),
        None => default_app_data_dir()?,
    };
    let text = std::fs::read_to_string(dir.join(PORT_FILE_NAME)).ok()?;
    text.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

/// Read budget for the connection-list route: the app only reads its
/// connection store — no tool timeout and no approval can run behind it.
const LIST_READ_BUDGET: Duration = Duration::from_secs(10);

/// Builds the `/call-plugin-tool` JSON body (snake_case fields, per the
/// bridge contract).
fn request_body(connection_id: &str, tool: &str, arguments: &Value, timeout_ms: u64) -> Value {
    json!({
        "plugin_id": PLUGIN_ID,
        "connection_id": connection_id,
        "tool": tool,
        "arguments": arguments,
        "timeout_ms": timeout_ms,
    })
}

/// Builds the `/list-plugin-connections` JSON body (snake_case envelope,
/// same family as `/call-plugin-tool`; no per-call fields).
fn list_connections_request_body() -> Value {
    json!({ "plugin_id": PLUGIN_ID })
}

/// Splits a minimal HTTP response into `(status_code, body)`. No chunked
/// handling: the app writes small bodies with an explicit Content-Length and
/// closes the socket.
fn split_http_response(raw: &str) -> Result<(u16, &str), String> {
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .ok_or("DBX app bridge returned a malformed HTTP response (no header/body split)")?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or("DBX app bridge returned an unreadable HTTP status line")?;
    Ok((status, body))
}

/// One hand-written POST to the app bridge: connect, single-write the
/// request, read to EOF, split the response. A 200 yields `Ok(body)`;
/// anything else (or any transport failure) becomes `Err` carrying the
/// shared "DBX app bridge" failure prefix. `read_timeout_hint` is appended
/// verbatim to the read-timeout message so each route can explain what may
/// still be running behind the wait.
async fn post_bridge(
    path: &str,
    body: Vec<u8>,
    read_budget: Duration,
    read_timeout_hint: &str,
) -> Result<String, String> {
    let Some(port) = bridge_port(None) else {
        return Err(
            "DBX app bridge port not found: the DBX app has not published mcp-bridge-port"
                .to_string(),
        );
    };
    let mut request = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(&body);
    if request.len() > MAX_REQUEST_BYTES {
        return Err(format!(
            "DBX app bridge request is {} bytes, above the {MAX_REQUEST_BYTES}-byte single-write ceiling",
            request.len()
        ));
    }

    let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| format!("DBX app bridge connect to 127.0.0.1:{port} timed out"))?
        .map_err(|error| format!("DBX app bridge connect to 127.0.0.1:{port} failed: {error}"))?;
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("DBX app bridge write failed: {error}"))?;

    // Read to EOF: the app closes the socket after answering, and the
    // budget belongs to the route (tool timeout plus approval margin for
    // /call-plugin-tool, a plain store read for the list route).
    let mut raw = Vec::new();
    match tokio::time::timeout(read_budget, stream.read_to_end(&mut raw)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Err(format!("DBX app bridge read failed: {error}")),
        Err(_) => {
            return Err(format!(
                "DBX app bridge read timed out after {:?} {read_timeout_hint}",
                read_budget
            ))
        }
    }
    let raw = String::from_utf8_lossy(&raw).into_owned();
    let (status, body) = split_http_response(&raw)?;
    if status == 200 {
        return Ok(body.trim().to_string());
    }
    Err(format!(
        "DBX app bridge returned HTTP {status}: {}",
        body.trim()
    ))
}

/// Forwards one tool call through the app bridge. The 200 body is the app's
/// `mcp/call` result (already MCP-content wrapped) and is returned verbatim;
/// any other status becomes `Err` carrying the body text.
pub async fn call_plugin_tool(
    connection_id: &str,
    tool: &str,
    arguments: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let body = serde_json::to_vec(&request_body(
        connection_id,
        tool,
        &arguments,
        timeout.as_millis() as u64,
    ))
    .map_err(|error| format!("Failed to encode the DBX app bridge request: {error}"))?;
    let text = post_bridge(
        "/call-plugin-tool",
        body,
        timeout + APPROVAL_READ_MARGIN,
        "(an approval may still be pending in the app)",
    )
    .await?;
    serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("DBX app bridge returned invalid JSON: {error}"))
}

/// Fetches the app's saved-connection list for this plugin through the
/// bridge (`POST /list-plugin-connections`). The 200 body is
/// `{"connections": [...]}` with metadata-only connection objects
/// (id/name/host/port/username/authentication/readOnly, camelCase —
/// near-verbatim tool output; the contract never includes any credential
/// field). Any other outcome (older app without the route, refused call,
/// app not running) becomes `Err`; callers degrade to their session
/// registry instead of failing.
pub async fn list_plugin_connections() -> Result<Vec<Value>, String> {
    let body = serde_json::to_vec(&list_connections_request_body())
        .map_err(|error| format!("Failed to encode the DBX app bridge request: {error}"))?;
    let text = post_bridge(
        "/list-plugin-connections",
        body,
        LIST_READ_BUDGET,
        "(the app may be busy or not expose this route)",
    )
    .await?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("DBX app bridge returned invalid JSON: {error}"))?;
    let connections = value
        .get("connections")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "DBX app bridge list response is missing the connections array".to_string()
        })?;
    Ok(connections.clone())
}

/// Ensures the app's bridge is reachable: returns the published port
/// Returns the published bridge port only after a TCP connect probe proves
/// something is actually listening: the port file outlives a killed app and
/// would otherwise hand out a stale port forever.
async fn bridge_port_alive() -> Option<u16> {
    let port = bridge_port(None)?;
    let target = ("127.0.0.1", port);
    match tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect(target),
    )
    .await
    {
        Ok(Ok(stream)) => {
            drop(stream);
            Some(port)
        }
        _ => None,
    }
}

/// Waits for a reachable app bridge: verifies immediately when present,
/// otherwise wakes the app (`DBX_APP_LAUNCH_CMD` override, else macOS
/// `open -a DBX.app`) and re-reads + re-probes the port file every 500 ms
/// until `wait` elapses, so a relaunched app's fresh port is picked up.
pub async fn ensure_app_bridge(wait: Duration) -> Result<u16, String> {
    if let Some(port) = bridge_port_alive().await {
        return Ok(port);
    }
    launch_app();
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(port) = bridge_port_alive().await {
            return Ok(port);
        }
        if tokio::time::Instant::now() >= deadline {
            // Same "DBX app bridge" prefix as every other bridge failure so
            // callers (and smoke tests) can grep one actionable marker.
            return Err(format!(
                "DBX app bridge unreachable after {}s: no reachable mcp-bridge-port; \
                 start the DBX app and retry",
                wait.as_secs()
            ));
        }
    }
}

/// Best-effort app launch; failure is not fatal because the port-file poll
/// below is the source of truth.
fn launch_app() {
    let launch = std::env::var("DBX_APP_LAUNCH_CMD")
        .ok()
        .filter(|cmd| !cmd.trim().is_empty());
    let mut command = match launch {
        Some(cmd) => {
            let mut command = std::process::Command::new("sh");
            command.arg("-c").arg(cmd);
            command
        }
        None => {
            let mut command = std::process::Command::new("open");
            command.args(["-a", "DBX.app"]);
            command
        }
    };
    let _ = command.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_port_parses_trimmed_decimal_ports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PORT_FILE_NAME);
        std::fs::write(&path, "49152\n").unwrap();
        assert_eq!(bridge_port(Some(dir.path())), Some(49152));
        std::fs::write(&path, "  54321  ").unwrap();
        assert_eq!(bridge_port(Some(dir.path())), Some(54321));
    }

    #[test]
    fn bridge_port_rejects_garbage_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        // Missing file.
        assert_eq!(bridge_port(Some(dir.path())), None);
        let path = dir.path().join(PORT_FILE_NAME);
        for garbage in ["not-a-port", "", "99999", "0", "49152.5"] {
            std::fs::write(&path, garbage).unwrap();
            assert_eq!(bridge_port(Some(dir.path())), None, "garbage: {garbage}");
        }
    }

    #[test]
    fn request_body_carries_every_snake_case_contract_field() {
        let body = request_body(
            "conn-1",
            "ssh_exec",
            &json!({ "command": "uptime" }),
            300_000,
        );
        let object = body.as_object().unwrap();
        for key in [
            "plugin_id",
            "connection_id",
            "tool",
            "arguments",
            "timeout_ms",
        ] {
            assert!(object.contains_key(key), "missing {key}");
        }
        assert_eq!(object.len(), 5);
        assert_eq!(object["plugin_id"], "io.dbx.ssh");
        assert_eq!(object["connection_id"], "conn-1");
        assert_eq!(object["tool"], "ssh_exec");
        assert_eq!(object["arguments"]["command"], "uptime");
        assert_eq!(object["timeout_ms"], 300_000);
    }

    #[test]
    fn list_connections_request_body_is_the_bare_plugin_envelope() {
        let body = list_connections_request_body();
        let object = body.as_object().unwrap();
        assert_eq!(object.len(), 1, "the list route takes no per-call fields");
        assert_eq!(object["plugin_id"], "io.dbx.ssh");
    }

    #[test]
    fn split_http_response_extracts_status_and_body() {
        let (status, body) = split_http_response(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\nhello",
        )
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "hello");

        let (status, body) = split_http_response(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\nno such route",
        )
        .unwrap();
        assert_eq!(status, 404);
        assert_eq!(body, "no such route");

        // Malformed inputs are refused instead of mis-parsed.
        assert!(split_http_response("garbage without a blank line").is_err());
        assert!(split_http_response("HTTP/1.1 notastatus\r\n\r\nx").is_err());
        assert!(split_http_response("").is_err());
    }
}
