//! User-facing port mapping over a live SSH session (Xshell-style 端口映射,
//! ssh(1) -L/-R/-D parity).
//!
//! Three forward directions:
//! - `local` (-L): we bind `listen_host:listen_port` on the client machine and
//!   open a `direct-tcpip` channel per accepted connection; the server then
//!   dials `target_host:target_port` from its side.
//! - `remote` (-R): we ask the server to bind the port via the `tcpip-forward`
//!   global request; incoming `forwarded-tcpip` channels are relayed to
//!   `target_host:target_port` dialed from the *client* machine.
//! - `dynamic` (-D): a local SOCKS5 CONNECT listener opens direct-tcpip
//!   channels for destinations chosen by each client request.
//!
//! Every mapping lives in the sidecar registry keyed by forward id. Session
//! mappings die with their terminal; independent mappings own a PTY-free SSH
//! transport and survive terminal closure until stopped or disconnected.
//! All protocol-facing fields are camelCase, matching the sibling domains.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dbx_plugin_sdk::PluginEmitter;
use russh::client::Handle;
use serde_json::{json, Value};
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::ssh::{RemoteForwardTable, SshClient};

/// Address snapshot of a remote mapping's local dial target, registered for
/// the forwarded-tcpip handler (which must dial `target_host:target_port`
/// from the client machine without knowing the registry) and carrying the
/// mapping row so relays update the same counters the UI reads.
#[derive(Clone)]
pub(crate) struct RelayTarget {
    pub host: String,
    pub port: u16,
    pub entry: Arc<ForwardEntry>,
}

/// What a listener failure means for the mapping's reported state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

impl ForwardKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ForwardKind::Local => "local",
            ForwardKind::Remote => "remote",
            ForwardKind::Dynamic => "dynamic",
        }
    }

    /// Protocol-facing parse: only the three supported kinds are accepted so a typo
    /// fails loudly instead of silently forwarding the wrong direction.
    pub(crate) fn parse(value: &Value) -> Result<Self, String> {
        match value.as_str() {
            Some("local") => Ok(ForwardKind::Local),
            Some("remote") => Ok(ForwardKind::Remote),
            Some("dynamic") => Ok(ForwardKind::Dynamic),
            other => Err(format!(
                "Invalid forward kind: {other:?}; expected \"local\", \"remote\" or \"dynamic\""
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ForwardState {
    Starting,
    Active,
    Stopped,
    Error,
}

impl ForwardState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ForwardState::Starting => "starting",
            ForwardState::Active => "active",
            ForwardState::Stopped => "stopped",
            ForwardState::Error => "error",
        }
    }
}

/// One live mapping row, shared between the registry, the accept task and the
/// forwarded-tcpip relays so counters and state stay consistent regardless of
/// which side observes them first.
pub(crate) struct ForwardEntry {
    pub id: String,
    pub session_id: String,
    pub connection_id: String,
    pub kind: ForwardKind,
    pub listen_host: String,
    /// Port requested at start. For remote forwards this may be 0 (server
    /// picks); `bound_port` carries what the server actually bound.
    pub listen_port: u16,
    pub target_host: String,
    pub target_port: u16,
    /// An independent mapping owns an authenticated transport without a PTY.
    /// Session-backed mappings leave this empty and use their session handle.
    pub transport: Option<Arc<ForwardTransport>>,
    /// Remote forwards only: the port the server bound (0 until confirmed).
    pub bound_port: AtomicU32,
    pub state: Mutex<ForwardState>,
    pub error: Mutex<Option<String>>,
    pub connections_total: AtomicU64,
    pub connections_active: AtomicI64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
    /// Local forwards: the accept loop. Aborted by stop / session close;
    /// dropping the listener unbinds the port immediately.
    pub listener_task: Mutex<Option<tokio::task::AbortHandle>>,
    /// Per-connection relay tasks; aborted on stop so an existing mapping
    /// cannot keep moving bytes after the user removed it.
    pub relays: Mutex<Vec<tokio::task::AbortHandle>>,
    /// `Some` in production (cloned from the RPC that started the mapping)
    /// so state transitions reach workbenches; unit tests build entries with
    /// `None` and the SDK has no public emitter constructor.
    pub emitter: Option<PluginEmitter>,
    pub stopping: AtomicBool,
}

pub(crate) struct ForwardTransport {
    pub handle: Arc<Handle<SshClient>>,
    pub jump_chain: Vec<Arc<Handle<SshClient>>>,
}

impl ForwardEntry {
    /// Protocol-facing row for `ssh/forward/list` and `ssh/forward/start`.
    pub(crate) fn payload(&self) -> Value {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let error = self
            .error
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let bound = self.bound_port.load(Ordering::Relaxed);
        json!({
            "id": self.id,
            "sessionId": self.session_id,
            "connectionId": self.connection_id,
            "kind": self.kind.as_str(),
            "listenHost": self.listen_host,
            "listenPort": u32::from(self.listen_port),
            "boundPort": bound,
            "targetHost": self.target_host,
            "targetPort": u32::from(self.target_port),
            "state": state.as_str(),
            "error": error,
            "connectionsTotal": self.connections_total.load(Ordering::Relaxed),
            "connectionsActive": self.connections_active.load(Ordering::Relaxed).max(0),
            "bytesUp": self.bytes_up.load(Ordering::Relaxed),
            "bytesDown": self.bytes_down.load(Ordering::Relaxed),
        })
    }
}

/// Human-readable mapping description (used in traces and diagnostics):
/// `127.0.0.1:8080 -> db.internal:5432`. Pure so tests pin the shape.
pub(crate) fn describe(
    kind: ForwardKind,
    listen_host: &str,
    listen_port: u16,
    target_host: &str,
    target_port: u16,
) -> String {
    if kind == ForwardKind::Dynamic {
        return format!("SOCKS5 {listen_host}:{listen_port}");
    }
    let arrow = match kind {
        ForwardKind::Local => "->",
        // Remote direction reads right-to-left from the server's view; the
        // arrow keeps the user's mental model (client dials the target).
        ForwardKind::Remote => "<-",
        ForwardKind::Dynamic => unreachable!(),
    };
    format!("{listen_host}:{listen_port} {arrow} {target_host}:{target_port}")
}

/// Validates and normalizes one mapping request. Hosts accept IPv4, IPv6
/// (bracketed or bare) and plain hostnames; the listen host defaults like
/// ssh(1) — empty is the loopback interface, never the wildcard — and `*`
/// (bind-everywhere) is only meaningful server-side, so a local mapping
/// rejects it instead of failing later at bind time. Listen port 0 asks the
/// OS (local) or the server (remote) to pick a port; the actually bound
/// value is reported through `boundPort`. Pure so tests exercise every
/// rejection without touching the network.
pub(crate) fn parse_spec(
    params: &Value,
) -> Result<(ForwardKind, String, u16, String, u16), String> {
    let kind = ForwardKind::parse(params.get("kind").unwrap_or(&Value::Null))?;
    let listen_host = normalize_host(
        params
            .get("listenHost")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )?;
    if kind != ForwardKind::Remote && listen_host == "*" {
        return Err(
            "listenHost \"*\" is a server-side wildcard; local mappings bind a concrete host (use 0.0.0.0 for all interfaces)"
                .to_string(),
        );
    }
    let listen_port = parse_port(params.get("listenPort"), "listenPort")?;
    if kind == ForwardKind::Dynamic {
        if params
            .get("targetHost")
            .is_some_and(|host| host.as_str().is_some_and(|host| !host.trim().is_empty()))
            || params
                .get("targetPort")
                .is_some_and(|port| port.as_u64().is_some_and(|port| port != 0))
        {
            return Err("Dynamic forwarding selects its destination per SOCKS5 request; targetHost and targetPort must be omitted".to_string());
        }
        return Ok((kind, listen_host, listen_port, String::new(), 0));
    }
    // Unlike the listen host, a missing target has no sensible default —
    // reject before normalize_host silently substitutes the loopback.
    let raw_target = params
        .get("targetHost")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw_target.is_empty() {
        return Err("targetHost is required".to_string());
    }
    let target_host = normalize_host(raw_target)?;
    let target_port = parse_port(params.get("targetPort"), "targetPort")?;
    Ok((kind, listen_host, listen_port, target_host, target_port))
}

/// Host syntax gate: IPv4 / IPv6 (URL-style `[...]` brackets stripped) /
/// hostname labels / the `*` listen wildcard. Empty stays the caller's
/// contract (loopback default applied here). Everything that embeds a port
/// or scheme (`host:8080`, `http://…`, `user@host`) is rejected so a typo
/// never silently becomes a hostname lookup of garbage.
pub(crate) fn normalize_host(raw: &str) -> Result<String, String> {
    let invalid = |reason: &str| format!("Invalid host {raw:?}: {reason}");
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok("127.0.0.1".to_string());
    }
    if trimmed.len() > 253 || trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid("must be a hostname or IP without whitespace"));
    }
    // `[::1]` / `[fe80::1]`: brackets are a URL convention — strip them and
    // reject `[::1]:8080` (the port belongs in its own field).
    let host = if trimmed.starts_with('[') {
        let Some(end) = trimmed.find(']') else {
            return Err(invalid("unclosed bracket"));
        };
        if end != trimmed.len() - 1 {
            return Err(invalid(
                "bracketed IPv6 must not be followed by more text (put the port in its own field)",
            ));
        }
        &trimmed[1..end]
    } else {
        trimmed
    };
    let lower = host.to_lowercase();
    if lower == "*" {
        return Ok(lower);
    }
    // Bare IPs (v4 and v6, including scoped zones like fe80::1%en0) win over
    // hostname rules; std's parser is the authority.
    if lower.parse::<std::net::IpAddr>().is_ok() {
        return Ok(lower);
    }
    if lower.contains([':', '/', '@']) {
        return Err(invalid("expected an IPv4/IPv6 address or a hostname"));
    }
    // All-numeric dotted strings that failed the IPv4 parse above are typos
    // like `999.1.1.1`, not hostnames — reject instead of a DNS surprise.
    if !lower.is_empty() && lower.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(invalid("looks like an IPv4 address but is not a valid one"));
    }
    let label_ok = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    if !lower.split('.').all(label_ok) {
        return Err(invalid(
            "hostname labels accept letters, digits and inner hyphens only",
        ));
    }
    Ok(lower)
}

/// True when two listen endpoints of the same direction collide on the same
/// machine (local) or server (remote): equal ports and equal hosts, or
/// either side a wildcard (`*` / `0.0.0.0` / `::` / empty). Port 0 lets the
/// OS or the server pick, so it never pre-conflicts. Pure; both sides are
/// expected pre-normalized.
pub(crate) fn listen_endpoints_conflict(
    a_host: &str,
    a_port: u16,
    b_host: &str,
    b_port: u16,
) -> bool {
    if a_port == 0 || a_port != b_port {
        return false;
    }
    let wildcard = |host: &str| matches!(host, "*" | "0.0.0.0" | "::" | "");
    wildcard(a_host) || wildcard(b_host) || a_host == b_host
}

/// 1..=65535 for explicit ports; 0 is only meaningful for a remote listen
/// port (server-picked), which `parse_spec` special-cases before calling.
fn parse_port(value: Option<&Value>, field: &str) -> Result<u16, String> {
    let raw = value
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{field} must be an integer"))?;
    u16::try_from(raw).map_err(|_| format!("{field} must be within 0..=65535, got {raw}"))
}

/// Registers the `(listen_host, bound_port) -> target` row the
/// forwarded-tcpip handler matches against. The server echoes the address as
/// it was requested (OpenSSH lowercases nothing), so lookups normalize and
/// fall back to a port-only match when the bound form differs (e.g. the
/// client asked for 127.0.0.1 and the daemon reports ::1 or 0.0.0.0).
pub(crate) fn register_remote_target(
    table: &RemoteForwardTable,
    listen_host: &str,
    bound_port: u16,
    target_host: &str,
    target_port: u16,
    entry: Arc<ForwardEntry>,
) {
    let mut table = table.lock().unwrap_or_else(|poison| poison.into_inner());
    let host = listen_host.to_lowercase();
    table.insert(
        (host.clone(), u32::from(bound_port)),
        RelayTarget {
            host: target_host.to_string(),
            port: target_port,
            entry: entry.clone(),
        },
    );
    if host == "localhost" {
        table.insert(
            ("127.0.0.1".to_string(), u32::from(bound_port)),
            RelayTarget {
                host: target_host.to_string(),
                port: target_port,
                entry,
            },
        );
    }
}

/// Handler-side lookup: exact normalized key first, then a same-port scan —
/// the daemon may report the bound form differently from what the client
/// asked for (0.0.0.0 / :: vs 127.0.0.1), so wildcard binds win the fallback
/// and otherwise the single same-port mapping is used.
pub(crate) fn lookup_remote_target(
    table: &RemoteForwardTable,
    connected_address: &str,
    connected_port: u32,
) -> Option<RelayTarget> {
    let table = table.lock().unwrap_or_else(|poison| poison.into_inner());
    let host = connected_address.trim().to_lowercase();
    if let Some(target) = table.get(&(host, connected_port)) {
        return Some(target.clone());
    }
    let is_wildcard = |key_host: &str| matches!(key_host, "" | "*" | "0.0.0.0" | "::");
    let mut fallback: Option<&RelayTarget> = None;
    for ((key_host, key_port), target) in table.iter() {
        if *key_port != connected_port {
            continue;
        }
        if is_wildcard(key_host) {
            return Some(target.clone());
        }
        fallback = fallback.or(Some(target));
    }
    fallback.cloned()
}

/// Accept loop for a local (-L) mapping: binds the port on the client
/// machine, then relays every accepted TCP connection through a
/// `direct-tcpip` channel. Binding happens before the task starts so the
/// mapping is only marked active once the port is actually usable.
pub(crate) async fn spawn_local_listener(
    entry: Arc<ForwardEntry>,
    handle: Arc<Handle<SshClient>>,
) -> Result<(), String> {
    let listener = TcpListener::bind((entry.listen_host.as_str(), entry.listen_port))
        .await
        .map_err(|error| {
            format!(
                "Cannot bind {}:{}: {error}",
                entry.listen_host, entry.listen_port
            )
        })?;
    let actual = listener.local_addr().map_err(|error| error.to_string())?;
    entry
        .bound_port
        .store(u32::from(actual.port()), Ordering::Relaxed);
    let task = tokio::spawn(accept_loop(entry.clone(), handle, listener));
    *entry
        .listener_task
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some(task.abort_handle());
    Ok(())
}

async fn accept_loop(
    entry: Arc<ForwardEntry>,
    handle: Arc<Handle<SshClient>>,
    listener: TcpListener,
) {
    set_state(&entry, ForwardState::Active, None);
    loop {
        let accepted = listener.accept().await;
        match accepted {
            Ok((tcp, peer)) => {
                entry.connections_total.fetch_add(1, Ordering::Relaxed);
                entry.connections_active.fetch_add(1, Ordering::Relaxed);
                let relay = if entry.kind == ForwardKind::Dynamic {
                    tokio::spawn(relay_dynamic(entry.clone(), handle.clone(), tcp, peer))
                } else {
                    tokio::spawn(relay_local(entry.clone(), handle.clone(), tcp, peer))
                };
                retain_live_relays(&entry);
                entry
                    .relays
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .push(relay.abort_handle());
            }
            Err(error) => {
                set_state(
                    &entry,
                    ForwardState::Error,
                    Some(format!(
                        "Listener on {}:{} failed: {error}",
                        entry.listen_host,
                        bound_display(&entry)
                    )),
                );
                return;
            }
        }
    }
}

/// Relay one local mapping connection: client TCP stream <-> direct-tcpip
/// channel. The server dials `target_host:target_port` from its own network.
async fn relay_local(
    entry: Arc<ForwardEntry>,
    handle: Arc<Handle<SshClient>>,
    mut tcp: TcpStream,
    peer: SocketAddr,
) {
    let channel_result = handle
        .channel_open_direct_tcpip(
            entry.target_host.clone(),
            u32::from(entry.target_port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await;
    let mut channel = match channel_result {
        Ok(channel) => channel.into_stream(),
        Err(error) => {
            note_relay_end(&entry);
            eprintln!(
                "[ssh-forward] {} channel open failed: {error}",
                describe(
                    entry.kind,
                    &entry.listen_host,
                    bound_display(&entry),
                    &entry.target_host,
                    entry.target_port
                )
            );
            return;
        }
    };
    let (up, down) = match copy_bidirectional(&mut tcp, &mut channel).await {
        Ok((up, down)) => (up, down),
        Err(error) => {
            eprintln!("[ssh-forward] relay ended with {error}");
            (0, 0)
        }
    };
    entry.bytes_up.fetch_add(up, Ordering::Relaxed);
    entry.bytes_down.fetch_add(down, Ordering::Relaxed);
    note_relay_end(&entry);
}

const SOCKS5_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Negotiate the SOCKS5 no-auth CONNECT subset. The host string is passed to
/// direct-tcpip unchanged so domain names are resolved by the SSH server.
async fn socks5_destination(tcp: &mut TcpStream) -> Result<(String, u16), String> {
    let mut greeting = [0u8; 2];
    tcp.read_exact(&mut greeting)
        .await
        .map_err(|e| e.to_string())?;
    if greeting[0] != 5 || greeting[1] == 0 {
        let _ = tcp.write_all(&[5, 0xff]).await;
        return Err("Invalid SOCKS5 greeting".to_string());
    }
    let mut methods = vec![0u8; usize::from(greeting[1])];
    tcp.read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    if !methods.contains(&0) {
        let _ = tcp.write_all(&[5, 0xff]).await;
        return Err("SOCKS5 client did not offer no-authentication".to_string());
    }
    tcp.write_all(&[5, 0]).await.map_err(|e| e.to_string())?;

    let mut request = [0u8; 4];
    tcp.read_exact(&mut request)
        .await
        .map_err(|e| e.to_string())?;
    if request[0] != 5 || request[2] != 0 {
        socks5_reply(tcp, 1).await;
        return Err("Invalid SOCKS5 request".to_string());
    }
    if request[1] != 1 {
        socks5_reply(tcp, 7).await;
        return Err("Only SOCKS5 CONNECT is supported".to_string());
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            tcp.read_exact(&mut ip).await.map_err(|e| e.to_string())?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let length = tcp.read_u8().await.map_err(|e| e.to_string())?;
            if length == 0 {
                socks5_reply(tcp, 8).await;
                return Err("Empty SOCKS5 domain".to_string());
            }
            let mut bytes = vec![0u8; usize::from(length)];
            tcp.read_exact(&mut bytes)
                .await
                .map_err(|e| e.to_string())?;
            match String::from_utf8(bytes) {
                Ok(host) if !host.contains('\0') => host,
                _ => {
                    socks5_reply(tcp, 8).await;
                    return Err("Invalid SOCKS5 domain".to_string());
                }
            }
        }
        4 => {
            let mut ip = [0u8; 16];
            tcp.read_exact(&mut ip).await.map_err(|e| e.to_string())?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => {
            socks5_reply(tcp, 8).await;
            return Err("Unsupported SOCKS5 address type".to_string());
        }
    };
    let port = tcp.read_u16().await.map_err(|e| e.to_string())?;
    if port == 0 {
        socks5_reply(tcp, 1).await;
        return Err("SOCKS5 target port must not be zero".to_string());
    }
    Ok((host, port))
}

async fn socks5_reply(tcp: &mut TcpStream, code: u8) {
    let _ = tcp.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await;
}

async fn relay_dynamic(
    entry: Arc<ForwardEntry>,
    handle: Arc<Handle<SshClient>>,
    mut tcp: TcpStream,
    peer: SocketAddr,
) {
    let destination =
        tokio::time::timeout(SOCKS5_HANDSHAKE_TIMEOUT, socks5_destination(&mut tcp)).await;
    let (host, port) = match destination {
        Ok(Ok(destination)) => destination,
        Ok(Err(error)) => {
            eprintln!("[ssh-forward] SOCKS5 handshake failed: {error}");
            note_relay_end(&entry);
            return;
        }
        Err(_) => {
            eprintln!("[ssh-forward] SOCKS5 handshake timed out");
            note_relay_end(&entry);
            return;
        }
    };
    let channel = handle
        .channel_open_direct_tcpip(
            host,
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await;
    let mut channel = match channel {
        Ok(channel) => channel.into_stream(),
        Err(error) => {
            socks5_reply(&mut tcp, 5).await;
            eprintln!("[ssh-forward] SOCKS5 channel open failed: {error}");
            note_relay_end(&entry);
            return;
        }
    };
    socks5_reply(&mut tcp, 0).await;
    match copy_bidirectional(&mut tcp, &mut channel).await {
        Ok((up, down)) => {
            entry.bytes_up.fetch_add(up, Ordering::Relaxed);
            entry.bytes_down.fetch_add(down, Ordering::Relaxed);
        }
        Err(error) => eprintln!("[ssh-forward] SOCKS5 relay ended with {error}"),
    }
    note_relay_end(&entry);
}

/// Relay one remote (-R) mapping connection handed over by the SSH client
/// handler: forwarded-tcpip channel <-> TCP stream dialed from the client
/// machine. Counters land on the same mapping row as local relays.
pub(crate) async fn relay_remote(
    entry: Arc<ForwardEntry>,
    channel: russh::Channel<russh::client::Msg>,
    mut tcp: TcpStream,
) {
    entry.connections_total.fetch_add(1, Ordering::Relaxed);
    entry.connections_active.fetch_add(1, Ordering::Relaxed);
    let mut channel = channel.into_stream();
    let (up, down) = match copy_bidirectional(&mut tcp, &mut channel).await {
        Ok((up, down)) => (up, down),
        Err(error) => {
            eprintln!("[ssh-forward] remote relay ended with {error}");
            (0, 0)
        }
    };
    entry.bytes_up.fetch_add(up, Ordering::Relaxed);
    entry.bytes_down.fetch_add(down, Ordering::Relaxed);
    note_relay_end(&entry);
}

fn note_relay_end(entry: &ForwardEntry) {
    entry.connections_active.fetch_sub(1, Ordering::Relaxed);
    retain_live_relays(entry);
}

fn retain_live_relays(entry: &ForwardEntry) {
    let mut relays = entry
        .relays
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    relays.retain(|handle| !handle.is_finished());
}

fn bound_display(entry: &ForwardEntry) -> u16 {
    let bound = entry.bound_port.load(Ordering::Relaxed);
    if bound == 0 {
        entry.listen_port
    } else {
        u16::try_from(bound).unwrap_or(entry.listen_port)
    }
}

/// Transitions the mapping state and notifies workbenches listening on the
/// `ssh/forward/state` event (skipped when the entry carries no emitter).
/// Emission failures are ignored by design: the registry stays authoritative
/// and the next `ssh/forward/list` corrects the UI.
pub(crate) fn set_state(entry: &ForwardEntry, state: ForwardState, error: Option<String>) {
    {
        let mut guard = entry
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // A stopped mapping must never come back to active through a stray
        // relay task finishing after stop.
        if *guard == ForwardState::Stopped && state != ForwardState::Stopped {
            return;
        }
        *guard = state.clone();
    }
    *entry
        .error
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = error.clone();
    if let Some(emitter) = entry.emitter.as_ref() {
        let _ = emitter.event(
            "ssh/forward/state",
            json!({
                "id": entry.id,
                "sessionId": entry.session_id,
                "connectionId": entry.connection_id,
                "state": state.as_str(),
                "error": error,
            }),
        );
    }
}

/// Stops the background tasks of one mapping (accept loop + live relays).
/// Called by `ssh/forward/stop` and by session teardown; the remote listener
/// cancellation (`cancel-tcpip-forward`) stays with the caller because it
/// needs the SSH handle and must not block teardown on the network.
pub(crate) fn abort_tasks(entry: &ForwardEntry) {
    entry.stopping.store(true, Ordering::Relaxed);
    if let Some(task) = entry
        .listener_task
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take()
    {
        task.abort();
    }
    let mut relays = entry
        .relays
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    for handle in relays.drain(..) {
        handle.abort();
    }
}

/// Client-machine interface addresses for the forward dialog's listen-host
/// picker (`ssh/forward/interfaces`): one row per distinct bindable IP with
/// its interface name and loopback flag. Ordered loopback → IPv4 → IPv6 →
/// name so the picker reads stably; deduped because one IP can appear on
/// several interfaces. Takes normalized `(interface, ip, is_loopback)` rows
/// so tests pin the ordering without constructing host-specific structs.
/// An empty probe result degrades to an empty list — the picker hides and
/// manual input keeps working.
pub(crate) fn interface_rows(probe: Vec<(String, std::net::IpAddr, bool)>) -> Value {
    let mut rows = probe;
    // Loopback first, then IPv4, then IPv6; !is_loopback so true sorts first.
    rows.sort_by(|a, b| {
        (!a.2, a.1.is_ipv6(), &a.0, a.1.to_string()).cmp(&(
            !b.2,
            b.1.is_ipv6(),
            &b.0,
            b.1.to_string(),
        ))
    });
    rows.dedup_by(|a, b| a.1 == b.1);
    let interfaces: Vec<Value> = rows
        .into_iter()
        .map(|(name, ip, is_loopback)| {
            json!({
                "name": name,
                "addr": ip.to_string(),
                "isLoopback": is_loopback,
            })
        })
        .collect();
    json!({ "interfaces": interfaces })
}

/// Live probe wrapper for the RPC arm; the pure sorting lives in
/// [`interface_rows`].
pub(crate) fn local_interface_rows() -> Value {
    let probe: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|iface| {
            let ip = iface.ip();
            (iface.name, ip, ip.is_loopback())
        })
        .collect();
    interface_rows(probe)
}

/// Registry of live mappings, one per sidecar process (not per session) so
/// `ssh/forward/list` can answer for a whole connection or a single session.
#[derive(Default)]
pub(crate) struct ForwardRegistry {
    entries: Mutex<HashMap<String, Arc<ForwardEntry>>>,
}

impl ForwardRegistry {
    pub(crate) fn insert(&self, entry: Arc<ForwardEntry>) {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(entry.id.clone(), entry);
    }

    pub(crate) fn get(&self, id: &str) -> Option<Arc<ForwardEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .get(id)
            .cloned()
    }

    pub(crate) fn remove(&self, id: &str) -> Option<Arc<ForwardEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(id)
    }

    pub(crate) fn rows(&self) -> Vec<Arc<ForwardEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .values()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn spec(params: Value) -> Result<(ForwardKind, String, u16, String, u16), String> {
        parse_spec(&params)
    }

    #[test]
    fn parses_local_mapping_with_loopback_default() {
        let (kind, listen_host, listen_port, target_host, target_port) = spec(json!({
            "kind": "local", "listenPort": 8080, "targetHost": "db.internal", "targetPort": 5432
        }))
        .unwrap();
        assert_eq!(kind, ForwardKind::Local);
        assert_eq!(listen_host, "127.0.0.1");
        assert_eq!(listen_port, 8080);
        assert_eq!(target_host, "db.internal");
        assert_eq!(target_port, 5432);
    }

    #[test]
    fn parses_remote_mapping_with_server_picked_port() {
        let (kind, listen_host, listen_port, _, _) = spec(json!({
            "kind": "remote", "listenHost": "0.0.0.0", "listenPort": 0,
            "targetHost": "127.0.0.1", "targetPort": 3000
        }))
        .unwrap();
        assert_eq!(kind, ForwardKind::Remote);
        assert_eq!(listen_host, "0.0.0.0");
        assert_eq!(listen_port, 0);
    }

    #[test]
    fn rejects_unknown_kind_and_bad_ports() {
        let error =
            spec(json!({"kind": "unknown", "listenPort": 1, "targetHost": "h", "targetPort": 2}))
                .unwrap_err();
        assert!(error.contains("expected"), "unexpected: {error}");
        let error =
            spec(json!({"kind": "local", "listenPort": 70000, "targetHost": "h", "targetPort": 2}))
                .unwrap_err();
        assert!(error.contains("listenPort"), "unexpected: {error}");
        let error =
            spec(json!({"kind": "local", "listenPort": 80, "targetHost": "", "targetPort": 2}))
                .unwrap_err();
        assert!(error.contains("targetHost"), "unexpected: {error}");
        let error =
            spec(json!({"kind": "local", "listenPort": "x", "targetHost": "h", "targetPort": 2}))
                .unwrap_err();
        assert!(error.contains("listenPort"), "unexpected: {error}");
    }

    #[test]
    fn dynamic_mapping_has_no_fixed_target() {
        let parsed = spec(json!({"kind": "dynamic", "listenPort": 0})).unwrap();
        assert_eq!(
            parsed,
            (
                ForwardKind::Dynamic,
                "127.0.0.1".to_string(),
                0,
                String::new(),
                0
            )
        );
        assert!(spec(
            json!({"kind": "dynamic", "listenPort": 1080, "targetHost": "web", "targetPort": 80})
        )
        .is_err());
        assert!(spec(json!({"kind": "dynamic", "listenHost": "*", "listenPort": 1080})).is_err());
    }

    #[tokio::test]
    async fn socks5_connect_parses_ipv4_domain_and_ipv6() {
        for (address, expected) in [
            (vec![1, 10, 0, 0, 5], "10.0.0.5".to_string()),
            (
                vec![3, 7, b'i', b'n', b't', b'e', b'r', b'n', b'l'],
                "internl".to_string(),
            ),
            (
                {
                    let mut bytes = vec![4];
                    bytes.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
                    bytes
                },
                "::1".to_string(),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut tcp, _) = listener.accept().await.unwrap();
                socks5_destination(&mut tcp).await.unwrap()
            });
            let mut client = TcpStream::connect(addr).await.unwrap();
            client.write_all(&[5, 2, 2, 0]).await.unwrap();
            let mut reply = [0u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, [5, 0]);
            let mut request = vec![5, 1, 0];
            request.extend_from_slice(&address);
            request.extend_from_slice(&8080u16.to_be_bytes());
            client.write_all(&request).await.unwrap();
            assert_eq!(server.await.unwrap(), (expected, 8080));
        }
    }

    #[tokio::test]
    async fn socks5_rejects_auth_only_and_udp_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            // Windows turns an immediate drop after the rejection write into a
            // mid-read RST (10054); linger briefly so the reply is delivered.
            let result = socks5_destination(&mut tcp).await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            result
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(&[5, 1, 2]).await.unwrap();
        let mut reply = [0u8; 2];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 0xff]);
        assert!(server.await.unwrap().is_err());

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            // Windows turns an immediate drop after the rejection write into a
            // mid-read RST (10054); linger briefly so the reply is delivered.
            let result = socks5_destination(&mut tcp).await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            result
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 0]);
        client
            .write_all(&[5, 3, 0, 1, 127, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        let mut response = [0u8; 10];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(response[1], 7);
        assert!(server.await.unwrap().is_err());
    }

    #[test]
    fn normalizes_host_whitespace_and_case() {
        assert_eq!(normalize_host("  DB-01 ").unwrap(), "db-01");
        assert_eq!(normalize_host("").unwrap(), "127.0.0.1");
        assert!(normalize_host("bad host").is_err());
    }

    #[test]
    fn accepts_ipv4_ipv6_bracketed_and_hostnames() {
        // IPv4 (case/whitespace normalized).
        assert_eq!(normalize_host("192.168.1.10").unwrap(), "192.168.1.10");
        // IPv6 bare and URL-bracketed; brackets are stripped for the bind.
        assert_eq!(normalize_host("::1").unwrap(), "::1");
        assert_eq!(normalize_host("[FE80::1]").unwrap(), "fe80::1");
        // Plain hostname and loopback name.
        assert_eq!(normalize_host("db.Internal").unwrap(), "db.internal");
        assert_eq!(normalize_host("localhost").unwrap(), "localhost");
        // The listen wildcard stays verbatim (remote-side bind everywhere).
        assert_eq!(normalize_host("*").unwrap(), "*");
    }

    #[test]
    fn rejects_scheme_port_and_malformed_hosts() {
        // Embedded port / scheme / userinfo never become garbage lookups.
        assert!(normalize_host("10.0.0.5:8080").is_err());
        assert!(normalize_host("http://10.0.0.5").is_err());
        assert!(normalize_host("user@db").is_err());
        // Broken bracket forms.
        assert!(normalize_host("[::1").is_err());
        assert!(normalize_host("[::1]:8080").is_err());
        // Malformed hostnames and IPs.
        assert!(normalize_host("-lead.ing").is_err());
        assert!(normalize_host("end-.ing").is_err());
        assert!(normalize_host("..").is_err());
        assert!(normalize_host("999.1.1.1").is_err());
        assert!(normalize_host("fe80::1%en0").is_err()); // zone scope: bind via the interface name instead
    }

    #[test]
    fn local_kind_rejects_wildcard_star() {
        let error = spec(json!({
            "kind": "local", "listenHost": "*", "listenPort": 80,
            "targetHost": "h", "targetPort": 1
        }))
        .unwrap_err();
        assert!(error.contains("wildcard"), "unexpected: {error}");
        // Remote keeps the sshd "bind everywhere" spelling.
        let parsed = spec(json!({
            "kind": "remote", "listenHost": "*", "listenPort": 80,
            "targetHost": "h", "targetPort": 1
        }))
        .unwrap();
        assert_eq!(parsed.1, "*");
    }

    #[test]
    fn listen_conflicts_need_same_port_and_overlapping_host() {
        use crate::forward as fwd;
        // Same host, same port.
        assert!(fwd::listen_endpoints_conflict(
            "127.0.0.1",
            8080,
            "127.0.0.1",
            8080
        ));
        // Wildcard overlaps any host on the same port.
        assert!(fwd::listen_endpoints_conflict(
            "0.0.0.0",
            8080,
            "192.168.1.5",
            8080
        ));
        assert!(fwd::listen_endpoints_conflict("::1", 8080, "*", 8080));
        // Different port or auto-pick never conflicts.
        assert!(!fwd::listen_endpoints_conflict(
            "127.0.0.1",
            8080,
            "127.0.0.1",
            8081
        ));
        assert!(!fwd::listen_endpoints_conflict(
            "127.0.0.1",
            0,
            "127.0.0.1",
            8080
        ));
        // Different concrete hosts coexist.
        assert!(!fwd::listen_endpoints_conflict(
            "127.0.0.1",
            8080,
            "192.168.1.5",
            8080
        ));
    }

    #[test]
    fn interface_rows_order_loopback_v4_v6_and_dedupe() {
        use std::net::IpAddr;
        let ip = |v: &str| v.parse::<IpAddr>().unwrap();
        let rows = interface_rows(vec![
            ("en0".to_string(), ip("192.168.1.10"), false),
            ("utun3".to_string(), ip("::1"), true),
            ("lo0".to_string(), ip("127.0.0.1"), true),
            ("en1".to_string(), ip("192.168.1.10"), false), // duplicate IP across ifaces
        ]);
        let list = rows["interfaces"].as_array().unwrap();
        let addrs: Vec<&str> = list
            .iter()
            .map(|row| row["addr"].as_str().unwrap())
            .collect();
        // Both loopbacks lead (v4 before v6 inside the group), then the rest.
        assert_eq!(addrs, vec!["127.0.0.1", "::1", "192.168.1.10"]);
        assert!(list[0]["isLoopback"].as_bool().unwrap());
        assert_eq!(list[0]["name"].as_str().unwrap(), "lo0");
        assert!(list[1]["isLoopback"].as_bool().unwrap());
        assert!(!list[2]["isLoopback"].as_bool().unwrap());
    }

    #[test]
    fn describes_both_directions() {
        assert_eq!(
            describe(ForwardKind::Local, "127.0.0.1", 8080, "db", 5432),
            "127.0.0.1:8080 -> db:5432"
        );
        assert_eq!(
            describe(ForwardKind::Remote, "127.0.0.1", 80, "web", 3000),
            "127.0.0.1:80 <- web:3000"
        );
    }

    #[test]
    fn remote_table_lookup_matches_exact_and_port_fallback() {
        use crate::forward as fwd;
        let table: RemoteForwardTable = Mutex::new(HashMap::new());
        let entry = |listen_port: u16| {
            Arc::new(ForwardEntry {
                id: format!("fwd-{listen_port}"),
                session_id: "s".to_string(),
                connection_id: "c".to_string(),
                kind: ForwardKind::Remote,
                listen_host: "127.0.0.1".to_string(),
                listen_port,
                target_host: "127.0.0.1".to_string(),
                target_port: 3000,
                transport: None,
                bound_port: AtomicU32::new(listen_port as u32),
                state: Mutex::new(ForwardState::Active),
                error: Mutex::new(None),
                connections_total: AtomicU64::new(0),
                connections_active: AtomicI64::new(0),
                bytes_up: AtomicU64::new(0),
                bytes_down: AtomicU64::new(0),
                listener_task: Mutex::new(None),
                relays: Mutex::new(Vec::new()),
                emitter: None,
                stopping: AtomicBool::new(false),
            })
        };
        fwd::register_remote_target(&table, "127.0.0.1", 8080, "web", 3000, entry(8080));
        // Exact match on the requested host.
        let hit = fwd::lookup_remote_target(&table, "127.0.0.1", 8080).unwrap();
        assert_eq!(hit.host, "web");
        assert_eq!(hit.port, 3000);
        // Server may report a different bound form for the same port: the
        // port-only fallback must still resolve it.
        let hit = fwd::lookup_remote_target(&table, "0.0.0.0", 8080).unwrap();
        assert_eq!(hit.host, "web");
        // Unknown port misses.
        assert!(fwd::lookup_remote_target(&table, "127.0.0.1", 9999).is_none());
    }
}
