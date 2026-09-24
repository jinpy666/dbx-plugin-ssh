//! VNC remote-desktop sessions (RFB 6143 client, nyaterm-parity P2 2d).
//!
//! Runtime layout mirrors `telnet_session.rs`: one entry per live session in
//! the runtime's own table (a VNC connection carries its own TCP stream and
//! can never live on the SSH `SessionEntry`), structured input arrives on the
//! `vnc/input` (alias `vnc/write`) JSON method with the keysym already mapped
//! by the frontend, and framebuffer updates answer as 44-byte-header RGBA
//! patch frames on the binary channel `vnc/frame/{sessionId}` — the same
//! patch protocol NyaTerm uses (`sequence u64 LE`, desktop W/H, x/y/w/h,
//! stride, pixel format, payload length, all `u32 LE`). Lifecycle changes
//! surface as `vnc/session/state` events (`connecting`/`connected`/
//! `closed`/`error`).
//!
//! Engine: upstream `vnc-rs 0.6` (HsuJv/vnc-rs, MIT OR Apache-2.0) with
//! `PixelFormat::rgba()`, encodings ZRLE + Raw (+ DesktopSizePseudo) only —
//! Tight is deliberately not advertised, and a server that still sends a
//! Tight/JPEG rectangle fails the session with a readable error. Due
//! diligence (why route A, what the upstream limits cover) lives in
//! `docs/SPIKE_VNC_SESSION.zh-CN.md`.
//!
//! Bounds (tighter than upstream's per-message decoder limits):
//! - framebuffer at most 3840x2160 (a `SetResolution` outside the range, or
//!   a rect outside the framebuffer, fails the session);
//! - a patch payload is inherently ≤ 3840*2160*4 < 64 MiB and the encoder
//!   still re-validates stride/rect/payload on every frame;
//! - classic VNC-Auth passwords are rejected above 8 bytes at `vnc/start`
//!   (the protocol truncates silently otherwise);
//! - clipboard text is Latin-1 and ≤ 1 MiB in both directions.
//!
//! Reconnect: every worker run captures a `generation` counter; `vnc/
//! reconnect` (or the automatic retry loop) bumps it, the superseded worker
//! exits without emitting, and the new run repaints from the retained
//! framebuffer plus a full-refresh request so a reattached viewer gets a
//! complete frame. Transport failures retry up to `reconnectAttempts`
//! (default 3); authentication and protocol failures never retry.
//!
//! Safety note: classic VNC authentication is a 8-byte DES challenge and
//! None is cleartext — the plugin surfaces the "trusted networks only"
//! warning in the UI, keeps the password in `Zeroizing`, and never logs
//! passwords, challenge responses or clipboard text.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dbx_plugin_sdk::PluginEmitter;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, RwLock};
use vnc::{
    ClientKeyEvent, ClientMouseEvent, PixelFormat, Rect, Screen, VncClient, VncConnector,
    VncEncoding, VncError, VncEvent, X11Event,
};
use zeroize::Zeroizing;

/// Dial timeout for the initial TCP connect (same contract as Telnet).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// RFB handshake + security negotiation timeout.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// Output-event poll cadence: the engine queues at most a couple of decoded
/// events, so the pump must drain frequently (NyaTerm uses the same 8ms).
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(8);
/// Incremental framebuffer-update request cadence after observed traffic.
const UPDATE_REQUEST_INTERVAL: Duration = Duration::from_millis(16);
/// Placeholder delay that keeps the pinned `Refresh` timer dormant until the
/// first decoded event re-arms it.
const REFRESH_ARM_DELAY: Duration = Duration::from_secs(86_400);
/// Classic VNC-Auth passwords are exactly the first 8 bytes (bit-reversed
/// into the DES key); longer secrets truncate silently, so reject up front.
const MAX_PASSWORD_BYTES: usize = 8;
/// Framebuffer guard — deliberately tighter than upstream's 8192px/8.3MP
/// decoder limits (patch payloads stay < 64 MiB by construction).
pub(crate) const MAX_FRAMEBUFFER_WIDTH: u16 = 3840;
pub(crate) const MAX_FRAMEBUFFER_HEIGHT: u16 = 2160;
const BYTES_PER_PIXEL: usize = 4;
/// Clipboard bounds (RFC 6143 7.6.4 is Latin-1 only).
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
/// Bounded backpressure for input/clipboard commands.
const COMMAND_CHANNEL_CAPACITY: usize = 256;
/// Default automatic reconnects after a transport failure.
const DEFAULT_RECONNECT_ATTEMPTS: u32 = 3;
const MAX_RECONNECT_ATTEMPTS: u32 = 10;

// —— 44-byte patch frame protocol (aligned with NyaTerm encode_frame_patch) ——

pub(crate) const FRAME_HEADER_BYTES: usize = 44;
/// Wire values shared with the frontend decoder and NyaTerm's renderer.
pub(crate) const PIXEL_FORMAT_RGBA8888: u32 = 2;

/// One framebuffer update ready for the `vnc/frame/{sessionId}` binary
/// channel. Validation mirrors NyaTerm's `encode_frame_patch` exactly.
pub(crate) struct FramePatch<'a> {
    pub sequence: u64,
    pub desktop_width: u32,
    pub desktop_height: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub payload: &'a [u8],
}

/// Encodes `44-byte header | payload` with every network-supplied field
/// re-validated (the framebuffer itself is bounded, but each rect arrives
/// from the wire and must be checked again). Pure — unit-tested.
pub(crate) fn encode_frame_patch(patch: &FramePatch<'_>) -> Result<Vec<u8>, String> {
    if patch.desktop_width == 0 || patch.desktop_height == 0 {
        return Err("VNC framebuffer dimensions must be non-zero".to_string());
    }
    if patch.width == 0 || patch.height == 0 {
        return Err("VNC frame rectangle must be non-zero".to_string());
    }
    let right = patch
        .x
        .checked_add(patch.width)
        .ok_or_else(|| "VNC frame horizontal bounds overflow".to_string())?;
    let bottom = patch
        .y
        .checked_add(patch.height)
        .ok_or_else(|| "VNC frame vertical bounds overflow".to_string())?;
    if right > patch.desktop_width || bottom > patch.desktop_height {
        return Err("VNC frame rectangle exceeds framebuffer bounds".to_string());
    }
    let row_bytes = usize::try_from(patch.width)
        .ok()
        .and_then(|width| width.checked_mul(BYTES_PER_PIXEL))
        .ok_or_else(|| "VNC frame row size overflows".to_string())?;
    let stride =
        usize::try_from(patch.stride).map_err(|_| "VNC frame stride is invalid".to_string())?;
    if stride < row_bytes {
        return Err("VNC frame stride is too small".to_string());
    }
    let required_payload = usize::try_from(patch.height)
        .ok()
        .and_then(|height| stride.checked_mul(height))
        .ok_or_else(|| "VNC frame payload size overflows".to_string())?;
    if patch.payload.len() < required_payload {
        return Err("VNC frame payload is too small".to_string());
    }
    let payload_len = u32::try_from(patch.payload.len())
        .map_err(|_| "VNC frame payload exceeds the wire limit".to_string())?;

    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + patch.payload.len());
    frame.extend_from_slice(&patch.sequence.to_le_bytes());
    frame.extend_from_slice(&patch.desktop_width.to_le_bytes());
    frame.extend_from_slice(&patch.desktop_height.to_le_bytes());
    frame.extend_from_slice(&patch.x.to_le_bytes());
    frame.extend_from_slice(&patch.y.to_le_bytes());
    frame.extend_from_slice(&patch.width.to_le_bytes());
    frame.extend_from_slice(&patch.height.to_le_bytes());
    frame.extend_from_slice(&patch.stride.to_le_bytes());
    frame.extend_from_slice(&PIXEL_FORMAT_RGBA8888.to_le_bytes());
    frame.extend_from_slice(&payload_len.to_le_bytes());
    frame.extend_from_slice(patch.payload);
    Ok(frame)
}

/// Server-side copy of the desktop, used to (a) composite incoming rects and
/// (b) repaint reconnecting viewers with one full-frame patch.
pub(crate) struct VncFramebuffer {
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

impl VncFramebuffer {
    fn new(width: u16, height: u16) -> Result<Self, String> {
        if width == 0
            || height == 0
            || width > MAX_FRAMEBUFFER_WIDTH
            || height > MAX_FRAMEBUFFER_HEIGHT
        {
            return Err(format!(
                "VNC framebuffer {width}x{height} is outside the supported range (max {MAX_FRAMEBUFFER_WIDTH}x{MAX_FRAMEBUFFER_HEIGHT})"
            ));
        }
        let len = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or_else(|| "VNC framebuffer size overflows".to_string())?;
        Ok(Self {
            width,
            height,
            rgba: vec![0; len],
        })
    }

    /// Composites one RGBA rect into the framebuffer. `pixels` must be
    /// exactly `width*4*height` bytes (tight packing, stride == width*4).
    fn apply_rgba(&mut self, rect: Rect, pixels: &[u8]) -> Result<(), String> {
        let right = u32::from(rect.x) + u32::from(rect.width);
        let bottom = u32::from(rect.y) + u32::from(rect.height);
        if rect.width == 0
            || rect.height == 0
            || right > u32::from(self.width)
            || bottom > u32::from(self.height)
        {
            return Err("VNC rectangle exceeds framebuffer bounds".to_string());
        }
        let row_bytes = usize::from(rect.width)
            .checked_mul(BYTES_PER_PIXEL)
            .ok_or_else(|| "VNC rectangle row size overflows".to_string())?;
        let required = row_bytes
            .checked_mul(usize::from(rect.height))
            .ok_or_else(|| "VNC rectangle payload size overflows".to_string())?;
        if pixels.len() != required {
            return Err("VNC rectangle payload length is invalid".to_string());
        }
        let framebuffer_stride = usize::from(self.width) * BYTES_PER_PIXEL;
        for row in 0..usize::from(rect.height) {
            let src_start = row * row_bytes;
            let dst_start = (usize::from(rect.y) + row) * framebuffer_stride
                + usize::from(rect.x) * BYTES_PER_PIXEL;
            self.rgba[dst_start..dst_start + row_bytes]
                .copy_from_slice(&pixels[src_start..src_start + row_bytes]);
        }
        Ok(())
    }

    fn patch_bytes(&self, sequence: u64, rect: Rect, pixels: &[u8]) -> Result<Vec<u8>, String> {
        encode_frame_patch(&FramePatch {
            sequence,
            desktop_width: u32::from(self.width),
            desktop_height: u32::from(self.height),
            x: u32::from(rect.x),
            y: u32::from(rect.y),
            width: u32::from(rect.width),
            height: u32::from(rect.height),
            stride: u32::from(rect.width) * 4,
            payload: pixels,
        })
    }

    fn full_frame_bytes(&self, sequence: u64) -> Result<Vec<u8>, String> {
        self.patch_bytes(
            sequence,
            Rect {
                x: 0,
                y: 0,
                width: self.width,
                height: self.height,
            },
            &self.rgba,
        )
    }
}

// —— request/response shapes ——

/// Front-end scaling hint only — the backend never resizes the remote
/// desktop (`vnc/resize` is accepted and validated, nothing is sent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ScaleMode {
    #[default]
    Fit,
    Stretch,
    Actual,
}

impl ScaleMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "fit" => Some(Self::Fit),
            "stretch" => Some(Self::Stretch),
            "actual" => Some(Self::Actual),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Fit => "fit",
            Self::Stretch => "stretch",
            Self::Actual => "actual",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncStartRequest {
    pub workbench_id: String,
    pub host: String,
    /// Defaults to 5900.
    pub port: Option<u16>,
    /// Absent/empty → RFB None security. Present → classic VNC-Auth
    /// (≤ 8 bytes). Held in `Zeroizing`, never logged.
    pub password: Option<String>,
    /// Frontend scaling hint: fit (default) / stretch / actual.
    pub scale_mode: Option<String>,
    /// Automatic reconnects after transport failures (default 3, max 10).
    pub reconnect_attempts: Option<u32>,
}

/// `vnc/input` payload. The frontend maps DOM events to X keysyms
/// (`vncFrame`/`vncInput` helpers), so the backend stays transport-only.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum VncInputEvent {
    #[serde(rename = "key")]
    Key { keysym: u32, pressed: bool },
    #[serde(rename = "pointer")]
    Pointer {
        x: u16,
        y: u16,
        /// Wire contract is camelCase; snake_case stays as an alias for
        /// programmatic callers.
        #[serde(rename = "buttonMask", alias = "button_mask")]
        button_mask: u8,
    },
    #[serde(rename = "release-all")]
    ReleaseAll,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncInputRequest {
    pub session_id: String,
    #[serde(flatten)]
    pub event: VncInputEvent,
}

/// Classic VNC-Auth secret → DES key: the first ≤8 password bytes, each
/// bit-reversed (RFC 6143 7.2.2). Spec-reference helper: upstream applies the
/// same transform inside `AuthHelper` (not part of its public API), so this
/// lives under `#[cfg(test)]` next to the known-vector pin.
#[cfg(test)]
pub fn vnc_auth_key(password: &str) -> [u8; 8] {
    let mut key = [0u8; 8];
    for (slot, byte) in key.iter_mut().zip(password.as_bytes()) {
        *slot = byte.reverse_bits();
    }
    key
}

/// `vnc/start` parameter validation shared with the docs contract: classic
/// VNC authentication cannot carry more than 8 bytes.
pub fn validate_password(password: Option<&str>) -> Result<(), String> {
    if let Some(password) = password {
        // `str::len` is byte length — exactly the classic-auth bound.
        if password.len() > MAX_PASSWORD_BYTES {
            return Err(format!(
                "vnc/start: password must be at most {MAX_PASSWORD_BYTES} bytes (classic VNC authentication limit)"
            ));
        }
    }
    Ok(())
}

/// Clipboard text guard: RFB cut-text is Latin-1 and bounded.
pub fn validate_clipboard_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err("vnc/set-clipboard: text exceeds the 1 MiB clipboard limit".to_string());
    }
    if !text.chars().all(|ch| u32::from(ch) <= 0xff) {
        return Err("vnc/set-clipboard: the VNC clipboard only carries Latin-1 text".to_string());
    }
    Ok(())
}

/// Backoff between reconnect attempts: 1s, 2s, then a flat 4s cap so a dead
/// server cannot pin a worker on long sleeps. Pure — unit-tested.
pub(crate) fn reconnect_delay(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 | 1 => 1,
        2 => 2,
        _ => 4,
    })
}

// —— runtime ——

enum VncCommand {
    Input(VncInputEvent),
    Clipboard(String),
    Close,
}

struct VncSessionEntry {
    workbench_id: String,
    host: String,
    port: u16,
    password: Option<Zeroizing<String>>,
    scale_mode: ScaleMode,
    reconnect_attempts: u32,
    created_at_secs: u64,
    /// Bumped before every (re)connect; the superseded worker exits without
    /// emitting so stale frames/state can never cross generations.
    generation: AtomicU64,
    /// Monotonic across generations so the frontend can drop out-of-order
    /// patches after a reconnect.
    frame_sequence: AtomicU64,
    close_requested: AtomicBool,
    /// Sender of the *current* generation's command channel; `None` while
    /// dialling/reconnecting (input fails fast instead of queueing).
    command_sender: tokio::sync::Mutex<Option<mpsc::Sender<VncCommand>>>,
    /// Retained desktop for reconnect repaints; owned by the live worker
    /// between `SetResolution` and teardown.
    framebuffer: tokio::sync::Mutex<Option<VncFramebuffer>>,
}

pub struct VncSessionRuntime {
    sessions: Arc<RwLock<HashMap<String, Arc<VncSessionEntry>>>>,
}

/// Why one protocol generation ended. `Superseded` means a newer generation
/// took over (reconnect/close) — the worker must exit silently.
enum GenerationEnd {
    Closed,
    Superseded,
    Failed { error: String, retryable: bool },
}

impl GenerationEnd {
    /// Wraps an engine error through the classifier.
    fn failed(error: VncError) -> Self {
        let (message, retryable) = classify_vnc_error(error);
        GenerationEnd::Failed {
            error: message,
            retryable,
        }
    }
}

impl VncSessionRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers the session row immediately (so the UI can bind its pane)
    /// and spawns the pump, which publishes `connecting` → `connected` /
    /// `error` state events and framebuffer patches.
    pub async fn start(
        &self,
        request: VncStartRequest,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let host = request.host.trim().to_string();
        if host.is_empty() {
            return Err("vnc/start: host is required".to_string());
        }
        let port = request.port.unwrap_or(5900);
        if port == 0 {
            return Err("vnc/start: port must be between 1 and 65535".to_string());
        }
        let password = request
            .password
            .filter(|password| !password.is_empty())
            .map(Zeroizing::new);
        validate_password(password.as_ref().map(|p| p.as_str()))?;
        let scale_mode = match request.scale_mode.as_deref() {
            None | Some("") => ScaleMode::default(),
            Some(value) => ScaleMode::parse(value)
                .ok_or_else(|| "vnc/start: scaleMode must be fit, stretch or actual".to_string())?,
        };
        let reconnect_attempts = request
            .reconnect_attempts
            .unwrap_or(DEFAULT_RECONNECT_ATTEMPTS)
            .min(MAX_RECONNECT_ATTEMPTS);
        let session_id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(VncSessionEntry {
            workbench_id: request.workbench_id.clone(),
            host: host.clone(),
            port,
            password,
            scale_mode,
            reconnect_attempts,
            created_at_secs: unix_now_secs(),
            generation: AtomicU64::new(0),
            frame_sequence: AtomicU64::new(0),
            close_requested: AtomicBool::new(false),
            command_sender: tokio::sync::Mutex::new(None),
            framebuffer: tokio::sync::Mutex::new(None),
        });
        self.sessions
            .write()
            .await
            .insert(session_id.clone(), entry.clone());
        spawn_worker(session_id.clone(), entry, emitter, self.sessions.clone());
        Ok(json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "scaleMode": scale_mode.as_str(),
            "reconnectAttempts": reconnect_attempts,
        }))
    }

    async fn session(&self, session_id: &str) -> Result<Arc<VncSessionEntry>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "VNC session was not found".to_string())
    }

    /// Keyboard/pointer event forwarding (`vnc/input`, alias `vnc/write`).
    pub async fn input(&self, session_id: &str, event: VncInputEvent) -> Result<(), String> {
        let entry = self.session(session_id).await?;
        let sender = entry
            .command_sender
            .lock()
            .await
            .clone()
            .ok_or_else(|| "VNC session is not connected".to_string())?;
        sender
            .send(VncCommand::Input(event))
            .await
            .map_err(|_| "VNC session is closed".to_string())
    }

    /// Frontend scaling hint only — validated against the live session,
    /// never forwarded to the remote desktop.
    pub async fn resize(&self, session_id: &str) -> Result<(), String> {
        // Touches the table so an unknown/dead session still errors.
        self.session(session_id).await.map(|_| ())
    }

    /// Local clipboard → remote (`vnc/set-clipboard`).
    pub async fn set_clipboard(&self, session_id: &str, text: String) -> Result<(), String> {
        validate_clipboard_text(&text)?;
        let entry = self.session(session_id).await?;
        let sender = entry
            .command_sender
            .lock()
            .await
            .clone()
            .ok_or_else(|| "VNC session is not connected".to_string())?;
        sender
            .send(VncCommand::Clipboard(text))
            .await
            .map_err(|_| "VNC session is closed".to_string())
    }

    /// Manual reconnect: kill the current generation, keep the framebuffer
    /// (the new generation repaints it after `connected`), restart the pump.
    pub async fn reconnect(
        &self,
        session_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let entry = self.session(session_id).await?;
        entry.close_requested.store(false, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(VncCommand::Close).await;
        }
        spawn_worker(
            session_id.to_string(),
            entry,
            emitter,
            self.sessions.clone(),
        );
        Ok(json!({ "sessionId": session_id, "success": true }))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let entry = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("VNC session was not found")?;
        entry.close_requested.store(true, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(VncCommand::Close).await;
        }
        Ok(())
    }

    /// Closing a workbench tears down its VNC sessions (same contract as the
    /// local shells and Telnet); a webview reload never passes through here.
    pub async fn close_workbench(&self, workbench_id: &str) {
        let session_ids: Vec<String> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, entry)| entry.workbench_id == workbench_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in session_ids {
            let _ = self.close(&session_id).await;
        }
    }

    /// Read-only inventory of live VNC sessions.
    pub async fn list(&self) -> Value {
        let sessions = self.sessions.read().await;
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, entry)| {
                json!({
                    "sessionId": session_id,
                    "workbenchId": entry.workbench_id,
                    "host": entry.host,
                    "port": entry.port,
                    "hasPassword": entry.password.is_some(),
                    "scaleMode": entry.scale_mode.as_str(),
                    "createdAt": entry.created_at_secs,
                })
            })
            .collect();
        list.sort_by(|a, b| {
            a["createdAt"]
                .as_u64()
                .cmp(&b["createdAt"].as_u64())
                .then_with(|| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()))
        });
        json!({ "sessions": list })
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Maps engine errors onto `(message, retryable)`. Authentication and
/// protocol failures never retry; transport hiccups do.
fn classify_vnc_error(error: VncError) -> (String, bool) {
    match error {
        VncError::NoPassword | VncError::WrongPassword | VncError::ConnectError => (
            "VNC authentication failed (the server requires classic VNC-Auth and the \
             password was missing or wrong)"
                .to_string(),
            false,
        ),
        VncError::InvalidSecurityTyep(_) => (
            "The VNC server requires an unsupported security type (supported: None and \
             classic VNC-Auth only)"
                .to_string(),
            false,
        ),
        VncError::IoError(error) => (format!("VNC connection failed: {error}"), true),
        VncError::ClientNotRunning => ("VNC client stopped".to_string(), false),
        // NoEncoding / WrongPixelFormat / WrongServerMessage / InvalidImageData
        // / General — protocol violations never retry (the enum is
        // #[non_exhaustive], so future variants land here too).
        other => (other.to_string(), false),
    }
}

const TIGHT_UNSUPPORTED: &str = "The VNC server sent a Tight/JPEG update; this client supports \
     Raw and ZRLE encodings only. Configure the server to allow Raw or ZRLE.";

fn spawn_worker(
    session_id: String,
    entry: Arc<VncSessionEntry>,
    emitter: PluginEmitter,
    sessions: Arc<RwLock<HashMap<String, Arc<VncSessionEntry>>>>,
) {
    tokio::spawn(async move {
        let emit_state = |state: &str, error: Option<String>| {
            let mut payload = json!({
                "sessionId": session_id,
                "workbenchId": entry.workbench_id,
                "state": state,
            });
            if let Some(error) = error {
                payload["error"] = Value::String(error);
            }
            emitter.event("vnc/session/state", payload)
        };
        let mut attempt: u32 = 0;
        loop {
            if entry.close_requested.load(Ordering::Acquire) {
                return;
            }
            let generation = entry.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let _ = emit_state("connecting", None);
            match run_generation(&session_id, &entry, generation, &emitter).await {
                GenerationEnd::Closed | GenerationEnd::Superseded => {
                    // Only the current generation may publish the terminal
                    // state (close() already emitted it; reconnect() has a
                    // fresh worker that owns the session now).
                    if entry.generation.load(Ordering::Acquire) == generation
                        && !entry.close_requested.load(Ordering::Acquire)
                    {
                        let _ = emit_state("closed", None);
                        sessions.write().await.remove(&session_id);
                    }
                    return;
                }
                GenerationEnd::Failed { error, retryable } => {
                    let _ = emit_state("error", Some(error));
                    if !retryable
                        || attempt >= entry.reconnect_attempts
                        || entry.close_requested.load(Ordering::Acquire)
                        || entry.generation.load(Ordering::Acquire) != generation
                    {
                        let _ = emit_state("closed", None);
                        sessions.write().await.remove(&session_id);
                        return;
                    }
                    attempt += 1;
                    tokio::time::sleep(reconnect_delay(attempt)).await;
                }
            }
        }
    });
}

/// One dial → handshake → pump cycle. Returns why it ended; all teardown of
/// shared state happens in [`spawn_worker`].
async fn run_generation(
    session_id: &str,
    entry: &Arc<VncSessionEntry>,
    generation: u64,
    emitter: &PluginEmitter,
) -> GenerationEnd {
    if entry.generation.load(Ordering::Acquire) != generation {
        return GenerationEnd::Superseded;
    }
    // Password is validated at start; re-check before the DES key so a
    // future reconnect path can never truncate silently.
    if let Err(error) = validate_password(entry.password.as_ref().map(|p| p.as_str())) {
        return GenerationEnd::Failed {
            error,
            retryable: false,
        };
    }
    let password = entry.password.clone().unwrap_or_default();
    let stream = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((entry.host.as_str(), entry.port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            return GenerationEnd::Failed {
                error: format!("connect {}:{}: {error}", entry.host, entry.port),
                retryable: true,
            };
        }
        Err(_) => {
            return GenerationEnd::Failed {
                error: format!(
                    "connect {}:{} timed out after {}s",
                    entry.host,
                    entry.port,
                    CONNECT_TIMEOUT.as_secs()
                ),
                retryable: true,
            };
        }
    };
    // The auth closure always exists so the future keeps one concrete type;
    // with no password it answers `NoPassword` (upstream behaviour: a server
    // that insists on VNC-Auth fails the handshake with a readable error).
    let state = match VncConnector::new(stream)
        .set_auth_method(async move {
            if password.is_empty() {
                Err(VncError::NoPassword)
            } else {
                Ok((*password).clone())
            }
        })
        .set_pixel_format(PixelFormat::rgba())
        .add_encoding(VncEncoding::DesktopSizePseudo)
        .add_encoding(VncEncoding::Zrle)
        .add_encoding(VncEncoding::Raw)
        .allow_shared(true)
        .build()
    {
        Ok(state) => state,
        Err(error) => return GenerationEnd::failed(error),
    };
    let client = match tokio::time::timeout(HANDSHAKE_TIMEOUT, state.try_start()).await {
        Ok(Ok(state)) => match state.finish() {
            Ok(client) => client,
            Err(error) => {
                return GenerationEnd::failed(error);
            }
        },
        Ok(Err(error)) => {
            return GenerationEnd::failed(error);
        }
        Err(_) => {
            return GenerationEnd::Failed {
                error: format!(
                    "VNC protocol negotiation timed out after {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ),
                retryable: true,
            };
        }
    };
    if entry.generation.load(Ordering::Acquire) != generation {
        let _ = client.close().await;
        return GenerationEnd::Superseded;
    }
    let _ = emitter.event(
        "vnc/session/state",
        json!({
            "sessionId": session_id,
            "workbenchId": entry.workbench_id,
            "state": "connected",
        }),
    );

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<VncCommand>(COMMAND_CHANNEL_CAPACITY);
    *entry.command_sender.lock().await = Some(cmd_tx);

    // Reconnect repaint: push the retained desktop as one full-frame patch,
    // then ask the server for a full refresh so new damage keeps flowing.
    {
        let framebuffer = entry.framebuffer.lock().await;
        if let Some(desktop) = framebuffer.as_ref() {
            let sequence = entry.frame_sequence.fetch_add(1, Ordering::AcqRel);
            match desktop.full_frame_bytes(sequence) {
                Ok(frame) => publish_frame(session_id, &frame, emitter),
                Err(error) => eprintln!("[ssh-sftp-plugin] vnc full-frame repaint failed: {error}"),
            }
            let _ = client.input(X11Event::FullRefresh).await;
        }
    }

    let mut pressed_keys = Vec::<u32>::new();
    let mut poll = tokio::time::interval(EVENT_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut refresh_due = false;
    let refresh_delay = tokio::time::sleep(REFRESH_ARM_DELAY);
    tokio::pin!(refresh_delay);
    let end = loop {
        if entry.generation.load(Ordering::Acquire) != generation {
            break GenerationEnd::Superseded;
        }
        tokio::select! {
            _ = poll.tick() => {
                let mut fatal: Option<GenerationEnd> = None;
                loop {
                    match client.poll_event().await {
                        Ok(Some(event)) => {
                            if let Some(end) =
                                handle_vnc_event(session_id, entry, generation, event, emitter)
                                    .await
                            {
                                fatal = Some(end);
                                break;
                            }
                            refresh_due = true;
                            refresh_delay
                                .as_mut()
                                .reset(tokio::time::Instant::now() + UPDATE_REQUEST_INTERVAL);
                        }
                        Ok(None) => break,
                        Err(error) => {
                            fatal = Some(GenerationEnd::failed(error));
                            break;
                        }
                    }
                }
                if let Some(end) = fatal {
                    break end;
                }
            }
            _ = &mut refresh_delay, if refresh_due => {
                if let Err(error) = client.input(X11Event::Refresh).await {
                    break GenerationEnd::failed(error);
                }
                refresh_due = false;
            }
            command = cmd_rx.recv() => match command {
                Some(VncCommand::Input(input)) => {
                    if let Err(error) =
                        apply_input(&client, input, &mut pressed_keys).await
                    {
                        break GenerationEnd::failed(error);
                    }
                }
                Some(VncCommand::Clipboard(text)) => {
                    if let Err(error) = client.input(X11Event::CopyText(text)).await {
                        break GenerationEnd::failed(error);
                    }
                }
                Some(VncCommand::Close) | None => {
                    break GenerationEnd::Closed;
                }
            },
        }
    };
    // Clear only when this generation still owns the channel: a superseded
    // worker must not drop the successor's sender.
    if entry.generation.load(Ordering::Acquire) == generation {
        *entry.command_sender.lock().await = None;
    }
    let _ = client.close().await;
    end
}

async fn apply_input(
    client: &VncClient,
    input: VncInputEvent,
    pressed_keys: &mut Vec<u32>,
) -> Result<(), VncError> {
    match input {
        VncInputEvent::Key { keysym, pressed } => {
            if pressed {
                if !pressed_keys.contains(&keysym) {
                    pressed_keys.push(keysym);
                }
            } else {
                pressed_keys.retain(|key| *key != keysym);
            }
            client
                .input(X11Event::KeyEvent(ClientKeyEvent {
                    keycode: keysym,
                    down: pressed,
                }))
                .await
        }
        VncInputEvent::Pointer { x, y, button_mask } => {
            client
                .input(X11Event::PointerEvent(ClientMouseEvent {
                    position_x: x,
                    position_y: y,
                    bottons: button_mask,
                }))
                .await
        }
        VncInputEvent::ReleaseAll => {
            for keysym in pressed_keys.drain(..) {
                let _ = client
                    .input(X11Event::KeyEvent(ClientKeyEvent {
                        keycode: keysym,
                        down: false,
                    }))
                    .await;
            }
            Ok(())
        }
    }
}

/// Applies one server event. `Some(end)` aborts the pump (readable protocol
/// violations — the server sent something this client never advertised).
async fn handle_vnc_event(
    session_id: &str,
    entry: &Arc<VncSessionEntry>,
    generation: u64,
    event: VncEvent,
    emitter: &PluginEmitter,
) -> Option<GenerationEnd> {
    if entry.generation.load(Ordering::Acquire) != generation {
        return Some(GenerationEnd::Superseded);
    }
    match event {
        VncEvent::SetResolution(Screen { width, height }) => {
            let framebuffer = match VncFramebuffer::new(width, height) {
                Ok(framebuffer) => framebuffer,
                Err(error) => {
                    return Some(GenerationEnd::Failed {
                        error,
                        retryable: false,
                    });
                }
            };
            *entry.framebuffer.lock().await = Some(framebuffer);
            None
        }
        VncEvent::RawImage(rect, pixels) => {
            let mut framebuffer = entry.framebuffer.lock().await;
            if framebuffer.is_none() {
                // Some servers stream rects before the DesktopSize pseudo
                // encoding; derive the desktop from the rect like NyaTerm.
                let width = u32::from(rect.x)
                    .checked_add(u32::from(rect.width))
                    .and_then(NonZeroU32::new)
                    .and_then(|size| u16::try_from(size.get()).ok());
                let height = u32::from(rect.y)
                    .checked_add(u32::from(rect.height))
                    .and_then(NonZeroU32::new)
                    .and_then(|size| u16::try_from(size.get()).ok());
                let (Some(width), Some(height)) = (width, height) else {
                    return Some(GenerationEnd::Failed {
                        error: "VNC rectangle bounds overflow".to_string(),
                        retryable: false,
                    });
                };
                match VncFramebuffer::new(width, height) {
                    Ok(created) => *framebuffer = Some(created),
                    Err(error) => {
                        return Some(GenerationEnd::Failed {
                            error,
                            retryable: false,
                        });
                    }
                }
            }
            let desktop = framebuffer.as_mut().expect("framebuffer initialized");
            if let Err(error) = desktop.apply_rgba(rect, &pixels) {
                return Some(GenerationEnd::Failed {
                    error,
                    retryable: false,
                });
            }
            let sequence = entry.frame_sequence.fetch_add(1, Ordering::AcqRel);
            match desktop.patch_bytes(sequence, rect, &pixels) {
                Ok(frame) => publish_frame(session_id, &frame, emitter),
                Err(error) => {
                    return Some(GenerationEnd::Failed {
                        error,
                        retryable: false,
                    });
                }
            }
            None
        }
        VncEvent::Text(text) => {
            // Inbound clipboard; the same Latin-1/1MiB guard as outbound.
            if validate_clipboard_text(&text).is_ok() {
                let _ = emitter.event(
                    "vnc/clipboard",
                    json!({ "sessionId": session_id, "text": text }),
                );
            }
            None
        }
        VncEvent::JpegImage(_, _) => Some(GenerationEnd::Failed {
            error: TIGHT_UNSUPPORTED.to_string(),
            retryable: false,
        }),
        VncEvent::Copy(_, _) | VncEvent::SetCursor(_, _) => Some(GenerationEnd::Failed {
            error: "The VNC server sent an encoding this client never requested".to_string(),
            retryable: false,
        }),
        VncEvent::Error(message) => Some(GenerationEnd::Failed {
            error: message,
            retryable: false,
        }),
        // SetPixelFormat (we pin the format), Bell, DesktopUpdate (layout
        // bookkeeping) and future variants carry no pixels.
        _ => None,
    }
}

fn publish_frame(session_id: &str, frame: &[u8], emitter: &PluginEmitter) {
    if let Err(error) = emitter.binary(&format!("vnc/frame/{session_id}"), frame) {
        // Frame loss is visual-only; the engine's own I/O errors tear the
        // session down, so a failing emit only needs a log line.
        eprintln!(
            "[ssh-sftp-plugin] vnc frame publish failed: {}",
            error.message
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_patch_header(frame: &[u8]) -> (u64, u32, u32, u32, u32, u32, u32, u32, u32, u32) {
        assert!(frame.len() >= FRAME_HEADER_BYTES);
        let le32 =
            |offset: usize| u32::from_le_bytes(frame[offset..offset + 4].try_into().unwrap());
        (
            u64::from_le_bytes(frame[0..8].try_into().unwrap()),
            le32(8),
            le32(12),
            le32(16),
            le32(20),
            le32(24),
            le32(28),
            le32(32),
            le32(36),
            le32(40),
        )
    }

    // —— patch 头编码/解码往返 ————————————————————————————————————

    #[test]
    fn patch_header_roundtrips() {
        let payload = [1u8, 2, 3, 255, 4, 5, 6, 7];
        let frame = encode_frame_patch(&FramePatch {
            sequence: 7,
            desktop_width: 10,
            desktop_height: 10,
            x: 2,
            y: 3,
            width: 1,
            height: 2,
            stride: 4,
            payload: &payload,
        })
        .expect("frame should encode");
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + payload.len());
        let (sequence, dw, dh, x, y, w, h, stride, format, payload_len) =
            decode_patch_header(&frame);
        assert_eq!(sequence, 7);
        assert_eq!((dw, dh, x, y, w, h, stride), (10, 10, 2, 3, 1, 2, 4));
        assert_eq!(format, PIXEL_FORMAT_RGBA8888);
        assert_eq!(PIXEL_FORMAT_RGBA8888, 2);
        assert_eq!(payload_len, 8);
        assert_eq!(&frame[FRAME_HEADER_BYTES..], &payload);
    }

    #[test]
    fn patch_encoding_rejects_bad_geometry() {
        let payload = [0u8; 4];
        let base = |x: u32, y: u32, width: u32, height: u32, stride: u32| FramePatch {
            sequence: 1,
            desktop_width: 10,
            desktop_height: 10,
            x,
            y,
            width,
            height,
            stride,
            payload: &payload,
        };
        // 矩形出界
        let error = encode_frame_patch(&base(10, 0, 1, 1, 4)).unwrap_err();
        assert!(error.contains("exceeds framebuffer bounds"), "{error}");
        // 零尺寸
        assert!(encode_frame_patch(&base(0, 0, 0, 1, 4)).is_err());
        // stride 过小
        let error = encode_frame_patch(&base(0, 0, 2, 1, 4)).unwrap_err();
        assert!(error.contains("stride is too small"), "{error}");
        // payload 不足
        let error = encode_frame_patch(&base(0, 0, 1, 2, 4)).unwrap_err();
        assert!(error.contains("payload is too small"), "{error}");
        // 坐标回绕
        assert!(encode_frame_patch(&base(u32::MAX, 0, 1, 1, 4)).is_err());
        // 空桌面
        let error = encode_frame_patch(&FramePatch {
            sequence: 1,
            desktop_width: 0,
            desktop_height: 10,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            stride: 4,
            payload: &payload,
        })
        .unwrap_err();
        assert!(error.contains("non-zero"), "{error}");
    }

    // —— 有界保护 ————————————————————————————————————————————————

    #[test]
    fn framebuffer_is_bounded() {
        // 超宽/超高被拒（契约上限 3840x2160）。
        assert!(VncFramebuffer::new(3841, 1).is_err());
        assert!(VncFramebuffer::new(1, 2161).is_err());
        assert!(VncFramebuffer::new(0, 10).is_err());
        // 恰好在上限内可建（33MB 上界 < 64MB patch 线制上限）。
        assert!(VncFramebuffer::new(MAX_FRAMEBUFFER_WIDTH, MAX_FRAMEBUFFER_HEIGHT).is_ok());
    }

    #[test]
    fn framebuffer_applies_patches_and_rebuilds_full_frames() {
        let mut framebuffer = VncFramebuffer::new(2, 2).expect("framebuffer");
        framebuffer
            .apply_rgba(
                Rect {
                    x: 1,
                    y: 1,
                    width: 1,
                    height: 1,
                },
                &[1, 2, 3, 255],
            )
            .expect("patch");
        // 出界与长度不符都被拒。
        assert!(framebuffer
            .apply_rgba(
                Rect {
                    x: 2,
                    y: 0,
                    width: 1,
                    height: 1
                },
                &[0; 4]
            )
            .is_err());
        assert!(framebuffer
            .apply_rgba(
                Rect {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1
                },
                &[0; 3]
            )
            .is_err());
        let frame = framebuffer.full_frame_bytes(9).expect("full frame");
        let (sequence, dw, dh, x, y, w, h, stride, _, payload_len) = decode_patch_header(&frame);
        assert_eq!(sequence, 9);
        assert_eq!(
            (dw, dh, x, y, w, h, stride, payload_len),
            (2, 2, 0, 0, 2, 2, 8, 16)
        );
        // 全帧 payload 即整幅 RGBA，补丁后的像素在 (1,1)。
        assert_eq!(
            &frame[FRAME_HEADER_BYTES + 12..FRAME_HEADER_BYTES + 16],
            &[1, 2, 3, 255]
        );
    }

    // —— 认证参数校验（classic VNC-Auth ≤8 字节）——————————————————

    #[test]
    fn password_validation_enforces_eight_bytes() {
        assert!(validate_password(None).is_ok());
        assert!(validate_password(Some("")).is_ok());
        assert!(validate_password(Some("12345678")).is_ok());
        let error = validate_password(Some("123456789")).unwrap_err();
        assert!(error.contains("at most 8 bytes"), "{error}");
        // 按字节计：4 个多字节字符 = 12 字节 > 8。
        assert!(validate_password(Some("密码密码")).is_err());
    }

    #[test]
    fn vnc_auth_key_bit_reverses_the_first_eight_bytes() {
        // RFC 6143 7.2.2：每个字节位反转，空位补 0。独立参照 u8::reverse_bits。
        let key = vnc_auth_key("password");
        let expected: [u8; 8] = "password"
            .as_bytes()
            .iter()
            .map(|byte| byte.reverse_bits())
            .collect::<Vec<u8>>()
            .try_into()
            .unwrap();
        assert_eq!(key, expected);
        // 已知向量：'p' = 0x70 → 0x0E；短密码尾部补零；超长截断到 8。
        assert_eq!(key[0], 0x0e);
        assert_eq!(vnc_auth_key("a")[0], 0x86);
        assert_eq!(vnc_auth_key("a"), [0x86, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            vnc_auth_key("123456789")[..8],
            vnc_auth_key("12345678")[..8]
        );
    }

    // —— 输入/剪贴板/缩放参数 ————————————————————————————————————

    #[test]
    fn input_events_decode_from_the_documented_shapes() {
        let key: VncInputEvent =
            serde_json::from_value(json!({ "kind": "key", "keysym": 0xff1b, "pressed": true }))
                .expect("key");
        assert!(matches!(
            key,
            VncInputEvent::Key {
                keysym: 0xff1b,
                pressed: true
            }
        ));
        let pointer: VncInputEvent = serde_json::from_value(json!(
            { "kind": "pointer", "x": 10, "y": 20, "buttonMask": 1 }
        ))
        .expect("pointer");
        assert!(matches!(
            pointer,
            VncInputEvent::Pointer {
                x: 10,
                y: 20,
                button_mask: 1
            }
        ));
        let release: VncInputEvent =
            serde_json::from_value(json!({ "kind": "release-all" })).expect("release-all");
        assert!(matches!(release, VncInputEvent::ReleaseAll));
        // 未知 kind / 缺 keysym 必须拒绝（不静默降级）。
        assert!(serde_json::from_value::<VncInputEvent>(json!({ "kind": "drag" })).is_err());
        assert!(serde_json::from_value::<VncInputEvent>(json!({ "kind": "key" })).is_err());
        // 完整请求（camelCase sessionId + flatten event）。
        let request: VncInputRequest = serde_json::from_value(json!({
            "sessionId": "s1", "kind": "pointer", "x": 1, "y": 2, "buttonMask": 4
        }))
        .expect("request");
        assert_eq!(request.session_id, "s1");
    }

    #[test]
    fn clipboard_guard_rejects_oversized_and_non_latin1() {
        assert!(validate_clipboard_text("hello").is_ok());
        assert!(validate_clipboard_text("").is_ok());
        let error = validate_clipboard_text("中文").unwrap_err();
        assert!(error.contains("Latin-1"), "{error}");
        let error = validate_clipboard_text(&"x".repeat(1024 * 1024 + 1)).unwrap_err();
        assert!(error.contains("1 MiB"), "{error}");
    }

    #[test]
    fn scale_mode_accepts_wire_names_only() {
        assert_eq!(ScaleMode::parse("fit"), Some(ScaleMode::Fit));
        assert_eq!(ScaleMode::parse("stretch"), Some(ScaleMode::Stretch));
        assert_eq!(ScaleMode::parse("actual"), Some(ScaleMode::Actual));
        assert_eq!(ScaleMode::parse("auto"), None);
        assert_eq!(ScaleMode::default(), ScaleMode::Fit);
        assert_eq!(ScaleMode::Stretch.as_str(), "stretch");
    }

    #[test]
    fn reconnect_delay_is_bounded() {
        assert_eq!(reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(reconnect_delay(2), Duration::from_secs(2));
        assert_eq!(reconnect_delay(3), Duration::from_secs(4));
        assert_eq!(reconnect_delay(100), Duration::from_secs(4));
    }

    #[test]
    fn classify_routes_transport_as_retryable_only() {
        let io = VncError::IoError(std::io::Error::other("reset"));
        assert!(classify_vnc_error(io).1);
        for protocol in [
            VncError::NoPassword,
            VncError::WrongPassword,
            VncError::ConnectError,
            VncError::InvalidSecurityTyep(19),
            VncError::InvalidImageData,
            VncError::General("denied".to_string()),
        ] {
            assert!(!classify_vnc_error(protocol).1);
        }
    }
}
