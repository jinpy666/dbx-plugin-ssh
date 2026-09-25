//! RDP remote-desktop sessions (IronRDP client, nyaterm-parity P3-4 RDP-2).
//!
//! Runtime layout mirrors `vnc_session.rs` (one entry per live session in the
//! runtime's own table, generation-guarded reconnects, structured input via a
//! JSON method, framebuffer patches as 44-byte RGBA header frames). The
//! engine differs: IronRDP (the RDP-1 vendored lockstep chain under
//! `backend/vendor/`, ironrdp 0.17) drives the full connection sequence —
//! X.224 negotiation, TLS, CredSSP/NLA and the static channels — on a
//! dedicated OS thread with its own current-thread tokio runtime, exactly
//! like NyaTerm's `spawn_ironrdp_engine`.
//!
//! Scope (review-locked, docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md):
//! password/NLA (CredSSP) + TLS + text-only clipboard + bounded reconnect.
//! Deliberately NOT implemented: audio, drive redirection, keyboard capture,
//! gateway/RDCleanPath, UDP transport, bitmap-cache tuning, Kerberos.
//!
//! Security red-lines implemented here (hard items of the checklist):
//! - NTLMv2-only: the vendored sspi marks NTLMv1 session security and LM key
//!   "deprecated, insecure and not supported by us" (fail-closed by
//!   construction; pinned by a vendored-source test below). The connector
//!   defaults to `ClientMode::Ntlm` and this module never builds a Kerberos
//!   config (Kerberos is out of MVP scope).
//! - Credentials live in `Zeroizing<String>` in the session entry, never in
//!   logs/audit/events/error text (NyaTerm's plaintext
//!   `with_password(...clone())` residency is NOT copied — the Zeroizing
//!   value is only materialized once per generation at the vendored
//!   `ConfigBuilder::with_password` boundary, whose storage is RDP-1 scope).
//!   Authentication failures surface as the unified string "RDP
//!   authentication failed" with no detail that could distinguish a wrong
//!   username from a wrong password.
//! - MITM protection is the certificate policy, fail-closed: `prompt`
//!   (default), `strict`, `accept-temporarily`. The prompt window is 120s;
//!   timeout, cancel and any stale-generation answer all reject. There is no
//!   code path that silently accepts an unverified certificate.
//! - CredSSP rides on TLS only (`with_tls(true)` always on; the legacy
//!   "standard RDP security" path is never advertised).
//! - Clipboard is text-only enforced by the backend format filter (only
//!   CF_UNICODETEXT is ever offered or accepted), bounded at 16 MiB per
//!   package (rejected whole, never truncated), and never logged. Inbound
//!   text is forwarded in budget-sized `rdp/clipboard` chunk events (C2);
//!   the raw inbound payload is length-gated at the backend entry before
//!   any decode (C1 plugin-level mitigation — the vendored cliprdr layer
//!   materializes the whole package first, see rdp-security-review).
//!   Residual (protocol-inherent, recorded): a server can pull the staged
//!   text in several ≤16 MiB format-data batches.
//!
//! Bounds (explicit): desktop 640x480..3840x2160 (NyaTerm's lower bound, the
//! VNC-parity upper bound so a full-frame patch stays < 64 MiB by
//! construction); clipboard text ≤ 16 MiB; input/clipboard command channel
//! capacity 256; reconnect ladder 1/2/4/8/15s capped at 30s, default 5
//! attempts (NyaTerm's default), hard max 10. Frames go straight to the
//! `rdp/frame/{sessionId}` binary channel (same 44-byte patch header as
//! `vnc/frame`, see docs/PROTOCOL.zh-CN.md § VNC 帧补丁) — no pending queue.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use data_encoding::HEXLOWER;
use dbx_plugin_sdk::PluginEmitter;
use ironrdp::client::config::{
    ClipboardType, Config as IronRdpConfig, ConfigBuilder as IronRdpConfigBuilder,
    Destination as IronRdpDestination, ServerCertificateVerifier, ServerCertificateVerifyFuture,
    TransportKind as IronRdpTransportKind,
};
use ironrdp::client::rdp::{
    RdpClient as IronRdpClient, RdpInputEvent as IronRdpInputEvent, RdpOutputEvent,
};
use ironrdp::cliprdr::backend::{
    ClipboardMessage, ClipboardMessageProxy, CliprdrBackend, CliprdrBackendFactory,
};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp::core::impl_as_any;
use ironrdp::input::{
    Database as IronRdpInputDatabase, MouseButton as IronRdpMouseButton,
    MousePosition as IronRdpMousePosition, Operation as IronRdpInputOperation,
    Scancode as IronRdpScancode, WheelRotations as IronRdpWheelRotations,
};
use ironrdp::pdu::input::fast_path::{
    FastPathInputEvent as IronRdpFastPathInputEvent, KeyboardFlags as IronRdpKeyboardFlags,
};
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use smallvec::SmallVec;
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

/// Certificate-prompt window (checklist §3-C: 120s, reject on timeout).
const CERTIFICATE_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
/// NyaTerm's desktop-size acceptance range (lower bound); the upper bound is
/// the plugin-wide remote-desktop guard so patch payloads stay < 64 MiB.
pub(crate) const MIN_DESKTOP_WIDTH: u16 = 640;
pub(crate) const MIN_DESKTOP_HEIGHT: u16 = 480;
pub(crate) const MAX_DESKTOP_WIDTH: u16 = 3840;
pub(crate) const MAX_DESKTOP_HEIGHT: u16 = 2160;
/// Clipboard package bound (checklist §3-E: NyaTerm's 16 MiB, whole-package
/// rejection, never truncation).
pub(crate) const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;
/// Per-event JSON budget for `rdp/clipboard` chunk events (C2,
/// rdp-security-review): the SDK transport silently drops JSON events over
/// 8 MiB (`MAX_JSON_BYTES`), so oversized text is split into chunks whose
/// JSON-escaped size stays under this bound.
const CLIPBOARD_CHUNK_JSON_BUDGET: usize = 7 * 1024 * 1024;
/// Unicode text input bound per `rdp/input` command (E5a,
/// rdp-security-review): each character expands into a press+release
/// operation pair, so unbounded text would materialize an unbounded
/// operation list. Rejected whole, never truncated.
pub(crate) const MAX_UNICODE_TEXT_CHARS: usize = 4096;
/// Wire identity bounds (B6/F6, rdp-security-review): DNS hostname cap plus
/// reasonable identity caps. Rejected at start, never truncated.
const MAX_HOST_LEN: usize = 255;
const MAX_USERNAME_LEN: usize = 128;
const MAX_DOMAIN_LEN: usize = 128;
/// Known-certificate store bound (B4); eviction drops the genuinely oldest
/// entries by insertion time.
const KNOWN_CERTS_MAX_ENTRIES: usize = 1024;
/// Bounded backpressure for input/clipboard/advertise commands.
const COMMAND_CHANNEL_CAPACITY: usize = 256;
/// Automatic reconnects after a transport failure (NyaTerm default 5).
const DEFAULT_RECONNECT_ATTEMPTS: u32 = 5;
const MAX_RECONNECT_ATTEMPTS: u32 = 10;
/// Cumulative automatic-reconnect budget per session worker (D3,
/// rdp-security-review): an active generation resets the backoff ladder
/// step only — never this total — so a hostile server cannot keep the
/// client dialling forever by alternating one active frame with
/// transport-class failures. Manual `rdp/reconnect` spawns a fresh worker
/// (user-driven gate, NyaTerm's explicit-reconnect semantics).
const MAX_TOTAL_RECONNECTS: u32 = 50;
/// The decoded engine pixel buffer is one u32 per pixel (0x00RRGGBB).
const BYTES_PER_PIXEL: usize = 4;
/// Right-shift scancode gets a direct fast-path event (NyaTerm bug fix: the
/// input database treats it as the extended left-shift on some layouts).
/// The protocol scancode space is u8; larger wire values are rejected, not
/// truncated (E5b, rdp-security-review).
const RDP_RIGHT_SHIFT_SCAN_CODE: u8 = 0x36;

// —— configuration (wire → session) ——

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertPolicy {
    /// Unknown fingerprint asks the user (default; checklist §3-C).
    Prompt,
    /// Only an already-remembered matching fingerprint connects.
    Strict,
    /// Accept any certificate without prompting (explicit opt-in only).
    AcceptTemporarily,
}

impl CertPolicy {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "prompt" => Some(Self::Prompt),
            "strict" => Some(Self::Strict),
            "accept-temporarily" => Some(Self::AcceptTemporarily),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Strict => "strict",
            Self::AcceptTemporarily => "accept-temporarily",
        }
    }
}

/// Known-certificate check outcome for one host:port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownCertStatus {
    Match,
    Changed,
    Unknown,
}

impl KnownCertStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::Changed => "changed",
            Self::Unknown => "unknown",
        }
    }
}

/// Resolved security settings for a start request: the explicit wire
/// parameter wins, then the persisted preference, then the review-locked
/// default (`use_nla=true`, `certificate_policy=prompt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedSecurity {
    pub use_nla: bool,
    pub certificate_policy: CertPolicy,
}

pub(crate) fn resolve_security(
    use_nla: Option<bool>,
    certificate_policy: Option<&str>,
    prefs: &Value,
) -> Result<ResolvedSecurity, String> {
    let use_nla = use_nla
        .or_else(|| prefs.get("rdp_use_nla").and_then(Value::as_bool))
        .unwrap_or(true);
    let policy_raw = certificate_policy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            prefs
                .get("rdp_certificate_policy")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    let certificate_policy = match policy_raw.as_deref() {
        None => CertPolicy::Prompt,
        Some(value) => CertPolicy::parse(value).ok_or_else(|| {
            "rdp/start: certificatePolicy must be prompt, strict or accept-temporarily".to_string()
        })?,
    };
    Ok(ResolvedSecurity {
        use_nla,
        certificate_policy,
    })
}

/// `Debug` is manual and redacts the password (`<set>`/`None`, the
/// `ImportedAuth` precedent): sessions can legitimately end up in derived
/// `Debug` output, and a future log or panic message must never be able to
/// carry a credential (B6, rdp-security-review).
impl std::fmt::Debug for RdpStartRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RdpStartRequest")
            .field("workbench_id", &self.workbench_id)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &redacted_secret_flag(&self.password))
            .field("domain", &self.domain)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("use_nla", &self.use_nla)
            .field("certificate_policy", &self.certificate_policy)
            .field("clipboard", &self.clipboard)
            .field("reconnect_attempts", &self.reconnect_attempts)
            .finish()
    }
}

/// `<set>`/`None` instead of the secret itself (mirrors the redaction style
/// of `connection_import::redacted_secret_flag`).
fn redacted_secret_flag(value: &Option<String>) -> &'static str {
    if value.is_some() {
        "<set>"
    } else {
        "None"
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpStartRequest {
    pub workbench_id: String,
    pub host: String,
    /// Defaults to 3389.
    pub port: Option<u16>,
    pub username: String,
    /// Password for NLA/CredSSP (or the legacy TLS logon screen). Held in
    /// `Zeroizing`, never logged, never echoed into errors or events. The
    /// plaintext window is one request-handling cycle only (wire parse →
    /// `Zeroizing`), see rdp-security-review B6.
    pub password: Option<String>,
    /// Optional Windows domain (empty = local account).
    pub domain: Option<String>,
    /// Initial desktop size; defaults to 1280x800.
    pub width: Option<u16>,
    pub height: Option<u16>,
    /// NLA (CredSSP) on/off; default true via preferences.
    pub use_nla: Option<bool>,
    /// prompt (default) / strict / accept-temporarily, via preferences.
    pub certificate_policy: Option<String>,
    /// Text clipboard redirection; default true.
    pub clipboard: Option<bool>,
    /// Automatic reconnects after transport failures (default 5, max 10).
    pub reconnect_attempts: Option<u32>,
}

/// `rdp/input` payload (alias `rdp/write`). Shape follows NyaTerm's
/// `RdpInputEvent`: scancodes (with the extended flag), mouse, wheel in
/// browser delta units, and a Unicode text path for IME-ish injection.
/// Field names are snake_case; the camelCase forms the frontend sends
/// (`scanCode`/`deltaX`/`deltaY`) are accepted as aliases (NyaTerm wire
/// compatibility).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind")]
pub enum RdpWireInput {
    #[serde(rename = "key-down")]
    KeyDown {
        /// The protocol scancode space is u8: serde rejects values > 0xFF
        /// outright instead of silently truncating them (E5b,
        /// rdp-security-review).
        #[serde(alias = "scanCode")]
        scan_code: u8,
        #[serde(default)]
        extended: bool,
    },
    #[serde(rename = "key-up")]
    KeyUp {
        #[serde(alias = "scanCode")]
        scan_code: u8,
        #[serde(default)]
        extended: bool,
    },
    #[serde(rename = "mouse-move")]
    MouseMove { x: u32, y: u32 },
    #[serde(rename = "mouse-button")]
    MouseButton {
        button: String,
        pressed: bool,
        x: u32,
        y: u32,
    },
    #[serde(rename = "mouse-wheel")]
    MouseWheel {
        #[serde(alias = "deltaX")]
        delta_x: f64,
        #[serde(alias = "deltaY")]
        delta_y: f64,
        x: u32,
        y: u32,
    },
    #[serde(rename = "unicode")]
    Unicode { text: String },
    #[serde(rename = "release-all")]
    ReleaseAll,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpInputRequest {
    pub session_id: String,
    #[serde(flatten)]
    pub input: RdpWireInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpResizeRequest {
    pub session_id: String,
    pub width: u16,
    pub height: u16,
}

// —— pure logic (unit-tested; no engine types needed) ——

/// Desktop size gate applied at start and at `rdp/resize`.
pub(crate) fn validate_desktop_size(width: u16, height: u16) -> Result<(), String> {
    if !(MIN_DESKTOP_WIDTH..=MAX_DESKTOP_WIDTH).contains(&width)
        || !(MIN_DESKTOP_HEIGHT..=MAX_DESKTOP_HEIGHT).contains(&height)
    {
        return Err(format!(
            "RDP desktop size must be within {MIN_DESKTOP_WIDTH}x{MIN_DESKTOP_HEIGHT} .. {MAX_DESKTOP_WIDTH}x{MAX_DESKTOP_HEIGHT}"
        ));
    }
    Ok(())
}

/// Clipboard raw-payload gate applied at the backend entry (C1,
/// rdp-security-review): oversized raw payloads are rejected BEFORE any
/// decode/materialization. Vendored mitigation note: the vendored cliprdr
/// PDU layer materializes the whole format-data package before our backend
/// ever sees it (ironrdp-cliprdr 0.7.0 exposes no streaming API), so an
/// entry-point streaming gate is impossible at plugin level — we gate as
/// early as the plugin can: raw length first, then the UTF-16 → String
/// decode, then the text bound. 缓解：vendored 层整包物化不可避免，见
/// rdp-security-review C1.
pub(crate) fn validate_clipboard_payload_len(raw_len: usize) -> Result<(), String> {
    if raw_len > MAX_CLIPBOARD_TEXT_BYTES {
        return Err(format!(
            "rdp clipboard: payload exceeds the {} MiB limit",
            MAX_CLIPBOARD_TEXT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

/// Clipboard text guard: bounded whole-package (never truncated).
pub(crate) fn validate_clipboard_text(text: &str) -> Result<(), String> {
    validate_clipboard_payload_len(text.len())
}

/// JSON-escaped byte length of one char under serde_json (control chars,
/// quote and backslash inflate to `\uXXXX`; non-ASCII passes through as raw
/// UTF-8).
fn json_escaped_char_len(character: char) -> usize {
    if character.is_ascii() {
        if character < ' ' || character == '"' || character == '\\' {
            6
        } else {
            1
        }
    } else {
        character.len_utf8()
    }
}

fn json_escaped_len(text: &str) -> usize {
    text.chars().map(json_escaped_char_len).sum()
}

/// Splits clipboard text into chunks whose JSON-escaped size stays under
/// `CLIPBOARD_CHUNK_JSON_BUDGET` (C2, rdp-security-review: a single >8 MiB
/// `rdp/clipboard` event is silently dropped by the SDK transport). Splits
/// on char boundaries only; a text that already fits comes back as one
/// chunk. Pure — unit-tested.
pub(crate) fn clipboard_chunks(text: &str) -> Vec<&str> {
    if json_escaped_len(text) <= CLIPBOARD_CHUNK_JSON_BUDGET {
        return vec![text];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut escaped = 0usize;
    for (offset, character) in text.char_indices() {
        let character_len = json_escaped_char_len(character);
        if escaped > 0 && escaped + character_len > CLIPBOARD_CHUNK_JSON_BUDGET {
            chunks.push(&text[start..offset]);
            start = offset;
            escaped = 0;
        }
        escaped += character_len;
    }
    if start < text.len() {
        chunks.push(&text[start..]);
    }
    chunks
}

/// Reconnect gating state for one worker loop (D3, rdp-security-review;
/// pure — unit-tested). The ladder step resets when a generation reached an
/// active frame, but the cumulative total never does: a hostile server
/// cannot loop the client forever by alternating one active frame with
/// transport-class failures.
struct ReconnectBudget {
    attempt: u32,
    total: u32,
}

impl ReconnectBudget {
    fn new() -> Self {
        Self {
            attempt: 0,
            total: 0,
        }
    }

    /// The generation had been fully active: fresh backoff ladder (NyaTerm
    /// resets the attempt counter on the first active frame), budget kept.
    fn on_active_generation(&mut self) {
        self.attempt = 0;
    }

    /// Charge one automatic reconnect against both the ladder and the total.
    fn charge(&mut self) {
        self.attempt += 1;
        self.total += 1;
    }

    /// May another automatic reconnect start?
    fn allows(&self, max_attempts: u32, retryable: bool) -> bool {
        retryable && self.attempt < max_attempts && self.total < MAX_TOTAL_RECONNECTS
    }
}

/// Backoff between reconnect attempts (NyaTerm's ladder without the random
/// jitter — determinism keeps the behaviour reviewable and testable).
pub(crate) fn reconnect_delay(attempt: u32) -> Duration {
    let base = match attempt {
        0 | 1 => 1_000,
        2 => 2_000,
        3 => 4_000,
        4 => 8_000,
        5 => 15_000,
        _ => 30_000,
    };
    Duration::from_millis(base)
}

/// Why a protocol generation ended. `Superseded` means a newer generation
/// took over (reconnect/close) — the worker must exit silently.
enum GenerationEnd {
    Closed,
    Superseded,
    Failed {
        error: String,
        error_kind: RdpErrorKind,
        retryable: bool,
        /// The generation reached an active frame before failing: the next
        /// retry gets a fresh attempt budget (NyaTerm resets on Active).
        was_active: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RdpErrorKind {
    Transport,
    Tls,
    Certificate,
    Authentication,
    Negotiation,
    Session,
    Clipboard,
}

impl RdpErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Transport => "transport",
            Self::Tls => "tls",
            Self::Certificate => "certificate",
            Self::Authentication => "authentication",
            Self::Negotiation => "negotiation",
            Self::Session => "session",
            Self::Clipboard => "clipboard",
        }
    }
}

/// Connection-sequence failures (`RdpOutputEvent::ConnectionFailure`).
/// NyaTerm's classifier: certificate/authentication/negotiation failures
/// never retry (a retry cannot fix wrong credentials and a rejected
/// certificate must fail closed), TLS and transport failures do.
pub(crate) fn classify_connector_error_text(text: &str) -> (RdpErrorKind, bool) {
    let lowered = text.to_ascii_lowercase();
    if is_certificate_rejection(&lowered) {
        return (RdpErrorKind::Certificate, false);
    }
    if is_tls_error_text(&lowered) {
        return (RdpErrorKind::Tls, true);
    }
    if lowered.contains("credssp")
        || lowered.contains("authentication")
        || lowered.contains("password")
        || lowered.contains("logon")
        || lowered.contains("access denied")
    {
        return (RdpErrorKind::Authentication, false);
    }
    if lowered.contains("negotiation") || lowered.contains("x224") || lowered.contains("nla") {
        return (RdpErrorKind::Negotiation, false);
    }
    if lowered.contains("certificate") {
        return (RdpErrorKind::Certificate, false);
    }
    (RdpErrorKind::Transport, true)
}

/// Active-session failures (`RdpOutputEvent::Terminated(Err)`).
pub(crate) fn classify_session_error_text(text: &str) -> (RdpErrorKind, bool) {
    let lowered = text.to_ascii_lowercase();
    if is_tls_error_text(&lowered) {
        return (RdpErrorKind::Tls, true);
    }
    if lowered.contains("authentication") || lowered.contains("password") {
        return (RdpErrorKind::Authentication, false);
    }
    if lowered.contains("clipboard") || lowered.contains("cliprdr") {
        return (RdpErrorKind::Clipboard, false);
    }
    if lowered.contains("eof")
        || lowered.contains("reset")
        || lowered.contains("timeout")
        || lowered.contains("broken pipe")
        || lowered.contains("connection aborted")
        || lowered.contains("transport")
    {
        return (RdpErrorKind::Transport, true);
    }
    (RdpErrorKind::Session, true)
}

fn is_certificate_rejection(text: &str) -> bool {
    text.contains("certificate rejected")
        || text.contains("unknown certificate")
        || text.contains("certificate fingerprint changed")
}

fn is_tls_error_text(text: &str) -> bool {
    text.contains("tls")
        || text.contains("handshake")
        || text.contains("schannel")
        || text.contains("connectionreset")
        || text.contains("connection reset")
}

/// User-facing connector error. Authentication is deliberately opaque
/// (checklist §3-A: no username-existence / password-correctness oracle);
/// raw error detail is only kept for transport/TLS kinds, which never carry
/// credentials.
pub(crate) fn connector_error_message(kind: RdpErrorKind, raw: &str) -> String {
    match kind {
        RdpErrorKind::Authentication => "RDP authentication failed".to_string(),
        RdpErrorKind::Certificate => format!("RDP certificate error: {raw}"),
        RdpErrorKind::Negotiation => format!("RDP negotiation failed: {raw}"),
        RdpErrorKind::Tls => format!("RDP TLS connection failed: {raw}"),
        RdpErrorKind::Transport => format!("RDP transport error: {raw}"),
        RdpErrorKind::Session | RdpErrorKind::Clipboard => format!("RDP connection failed: {raw}"),
    }
}

pub(crate) fn session_error_message(kind: RdpErrorKind, raw: &str) -> String {
    match kind {
        RdpErrorKind::Authentication => "RDP authentication failed".to_string(),
        RdpErrorKind::Clipboard => format!("RDP clipboard error: {raw}"),
        RdpErrorKind::Transport => format!("RDP transport interrupted: {raw}"),
        RdpErrorKind::Tls => format!("RDP TLS connection failed: {raw}"),
        RdpErrorKind::Certificate | RdpErrorKind::Negotiation | RdpErrorKind::Session => {
            format!("RDP session error: {raw}")
        }
    }
}

/// Certificate policy decision without a prompt (NyaTerm
/// `certificate_policy_allows_without_prompt`).
pub(crate) fn certificate_allows_without_prompt(
    policy: CertPolicy,
    status: KnownCertStatus,
) -> Result<bool, String> {
    match policy {
        CertPolicy::Strict => match status {
            KnownCertStatus::Match => Ok(true),
            KnownCertStatus::Unknown => Err("unknown certificate".to_string()),
            KnownCertStatus::Changed => Err("certificate fingerprint changed".to_string()),
        },
        CertPolicy::AcceptTemporarily => Ok(true),
        CertPolicy::Prompt => Ok(status == KnownCertStatus::Match),
    }
}

/// SHA-256 fingerprint in the NyaTerm wire form (`SHA256:<hex>`).
pub(crate) fn certificate_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    format!("SHA256:{}", HEXLOWER.encode(&digest))
}

fn cert_key(host: &str, port: u16) -> String {
    // Hostnames are case-insensitive: normalize so `RDP.local` and
    // `rdp.local` share one entry (rdp-security-review B4 次要 — otherwise
    // a case flip silently re-prompts, fail-closed but lossy).
    format!("{}:{port}", host.to_ascii_lowercase())
}

/// Status of `fingerprint` against the remembered store for host:port.
pub(crate) fn known_cert_status(
    store: &HashMap<String, String>,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> KnownCertStatus {
    match store.get(&cert_key(host, port)) {
        Some(stored) if stored == fingerprint => KnownCertStatus::Match,
        Some(_) => KnownCertStatus::Changed,
        None => KnownCertStatus::Unknown,
    }
}

/// Disk-backed known-certificate store (`rdp-known-certs.json`), shaped like
/// the SSH known-hosts precedent, bounded at 1024 entries, atomic tmp+rename
/// writes with a per-call unique tmp name (B4, rdp-security-review: a fixed
/// tmp name let concurrent remember() calls clobber each other's
/// intermediate file). Fingerprint persistence only — never certificate
/// contents, never credentials.
#[derive(Clone)]
struct KnownCertStore {
    path: PathBuf,
}

/// One disk entry: fingerprint plus insertion timestamp, so eviction can
/// drop the genuinely oldest keys (B4: the previous implementation took the
/// lexicographically smallest key, which could evict a hot host at random).
#[derive(serde::Serialize, serde::Deserialize)]
struct KnownCertEntry {
    fingerprint: String,
    inserted_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct KnownCertFile {
    entries: HashMap<String, KnownCertEntry>,
}

/// Backward-compatible disk shape: the pre-B4 flat map
/// `{"host:port": "SHA256:hex"}` and the current `{"entries": …}` envelope.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum KnownCertFileShape {
    V2(KnownCertFile),
    /// Legacy flat shape; entries are treated as inserted at 0, i.e. evicted
    /// first (safe direction).
    V1(HashMap<String, String>),
}

/// Drop the oldest entries (by `inserted_at`, ties broken by key for
/// determinism) until the store fits the cap. Pure — unit-tested.
fn prune_oldest_entries(store: &mut HashMap<String, KnownCertEntry>, cap: usize) {
    while store.len() > cap {
        let oldest = store
            .iter()
            .min_by(|(key_a, entry_a), (key_b, entry_b)| {
                entry_a
                    .inserted_at
                    .cmp(&entry_b.inserted_at)
                    .then_with(|| key_a.cmp(key_b))
            })
            .map(|(key, _)| key.clone());
        match oldest {
            Some(key) => {
                store.remove(&key);
            }
            None => break,
        }
    }
}

impl KnownCertStore {
    fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("rdp-known-certs.json"),
        }
    }

    fn load_entries(&self) -> HashMap<String, KnownCertEntry> {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        match serde_json::from_str::<KnownCertFileShape>(&text) {
            Ok(KnownCertFileShape::V2(file)) => file.entries,
            // Corrupt file → empty store (fail-closed: the next connect
            // re-prompts). Same for the legacy flat shape with per-entry
            // inserted_at = 0.
            Ok(KnownCertFileShape::V1(flat)) => flat
                .into_iter()
                .map(|(key, fingerprint)| {
                    (
                        key,
                        KnownCertEntry {
                            fingerprint,
                            inserted_at: 0,
                        },
                    )
                })
                .collect(),
            Err(_) => HashMap::new(),
        }
    }

    fn check(&self, host: &str, port: u16, fingerprint: &str) -> KnownCertStatus {
        let store: HashMap<String, String> = self
            .load_entries()
            .into_iter()
            .map(|(key, entry)| (key, entry.fingerprint))
            .collect();
        known_cert_status(&store, host, port, fingerprint)
    }

    fn remember(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        self.remember_at(host, port, fingerprint, unix_now_secs())
    }

    fn remember_at(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
        inserted_at: u64,
    ) -> Result<(), String> {
        let mut store = self.load_entries();
        store.insert(
            cert_key(host, port),
            KnownCertEntry {
                fingerprint: fingerprint.to_string(),
                inserted_at,
            },
        );
        prune_oldest_entries(&mut store, KNOWN_CERTS_MAX_ENTRIES);
        let text = serde_json::to_string(&KnownCertFile { entries: store })
            .map_err(|error| format!("failed to encode known certificates: {error}"))?;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Unique tmp name per call (B4): concurrent remember() calls must
        // not share one intermediate file. Residual window: two concurrent
        // remembers can still race the final rename (last writer wins
        // wholesale); the worst case is a forgotten entry → re-prompt,
        // fail-closed.
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "known-certificate store path is invalid".to_string())?;
        let tmp = self
            .path
            .with_file_name(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, text)
            .map_err(|error| format!("failed to write known certificates: {error}"))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|error| format!("failed to persist known certificates: {error}"))
    }
}

// —— certificate prompt broker (120s window, generation-guarded) ——

#[derive(Debug, Clone, Copy)]
struct CertDecision {
    accept: bool,
    remember: bool,
}

struct PendingCertPrompt {
    session_id: String,
    responder: oneshot::Sender<CertDecision>,
}

/// Workbench-event broker for the certificate confirmation, mirroring the
/// SSH host-key PromptBroker shape: one `connection/challenge` event with
/// `kind: "rdp-certificate"`, resolved by `rdp/certificate/resolve`. The
/// caller enforces the 120s window; timeout resolves to rejection
/// (fail-closed).
#[derive(Default)]
pub(crate) struct CertPromptBroker {
    pending: StdMutex<HashMap<String, PendingCertPrompt>>,
}

impl CertPromptBroker {
    fn new() -> Self {
        Self::default()
    }

    async fn request(
        &self,
        emitter: &PluginEmitter,
        session_id: &str,
        host: &str,
        port: u16,
        fingerprint: &str,
        known_host_status: KnownCertStatus,
    ) -> Option<CertDecision> {
        let challenge_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().ok()?;
            pending.insert(
                challenge_id.clone(),
                PendingCertPrompt {
                    session_id: session_id.to_string(),
                    responder: sender,
                },
            );
        }
        let emitted = emitter.event(
            "connection/challenge",
            json!({
                "challengeId": challenge_id,
                "kind": "rdp-certificate",
                "sessionId": session_id,
                "host": host,
                "port": port,
                "fingerprint": fingerprint,
                "knownHostStatus": known_host_status.as_str(),
            }),
        );
        if emitted.is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&challenge_id);
            }
            return None;
        }
        let decision = tokio::time::timeout(CERTIFICATE_PROMPT_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(|answer| answer.ok());
        // Remove whatever is left (timeout/dropped answer) so a late resolve
        // cannot succeed after the window closed.
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&challenge_id);
        }
        decision
    }

    pub(crate) fn resolve(
        &self,
        challenge_id: &str,
        accept: bool,
        remember: bool,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "certificate prompt registry is poisoned".to_string())?
            .remove(challenge_id)
            .ok_or_else(|| {
                "RDP certificate challenge was not found or already resolved".to_string()
            })?;
        let _ = pending.responder.send(CertDecision { accept, remember });
        Ok(())
    }

    /// Close/reconnect teardown: answer every pending prompt of the session
    /// with a rejection so the verifier cannot park on a dead session.
    fn cancel_session(&self, session_id: &str) {
        let responders: Vec<oneshot::Sender<CertDecision>> = match self.pending.lock() {
            Ok(mut pending) => {
                let stale: Vec<String> = pending
                    .iter()
                    .filter(|(_, prompt)| prompt.session_id == session_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                stale
                    .iter()
                    .filter_map(|id| pending.remove(id))
                    .map(|prompt| prompt.responder)
                    .collect()
            }
            Err(_) => return,
        };
        for responder in responders {
            let _ = responder.send(CertDecision {
                accept: false,
                remember: false,
            });
        }
    }
}

/// The `ServerCertificateVerifier` injected into the vendored client.
/// Fail-closed by construction: remembered match (any policy), explicit
/// accept-temporarily, or a resolved prompt — everything else errors.
struct RdpCertificateVerifier {
    emitter: PluginEmitter,
    broker: Arc<CertPromptBroker>,
    known_certs: KnownCertStore,
    session_id: String,
    policy: CertPolicy,
    /// Session-wide generation counter; the verifier rejects when the
    /// generation moved (close/reconnect) before or after the prompt.
    generation: Arc<AtomicU64>,
    own_generation: u64,
}

impl std::fmt::Debug for RdpCertificateVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identifiers only — never the emitter's writer or any credential.
        f.debug_struct("RdpCertificateVerifier")
            .field("session_id", &self.session_id)
            .field("generation", &self.own_generation)
            .finish()
    }
}

impl RdpCertificateVerifier {
    fn stale(&self) -> bool {
        self.generation.load(Ordering::Acquire) != self.own_generation
    }

    async fn verify(&self, host: &str, port: u16, der: &[u8]) -> Result<(), String> {
        if self.stale() {
            return Err("certificate rejected: stale RDP connection generation".to_string());
        }
        let fingerprint = certificate_fingerprint(der);
        let status = self.known_certs.check(host, port, &fingerprint);
        match certificate_allows_without_prompt(self.policy, status)? {
            true => Ok(()),
            false => {
                let decision = self
                    .broker
                    .request(
                        &self.emitter,
                        &self.session_id,
                        host,
                        port,
                        &fingerprint,
                        status,
                    )
                    .await
                    .ok_or_else(|| "certificate rejected".to_string())?;
                // A close/reconnect must not let a prompt decision carry
                // across generations.
                if self.stale() {
                    return Err("certificate rejected: stale RDP connection generation".to_string());
                }
                if !decision.accept {
                    return Err("certificate rejected".to_string());
                }
                if decision.remember {
                    self.known_certs.remember(host, port, &fingerprint)?;
                }
                Ok(())
            }
        }
    }
}

impl ServerCertificateVerifier for RdpCertificateVerifier {
    fn verify_server_certificate<'a>(
        &'a self,
        host: &'a str,
        port: u16,
        der: Vec<u8>,
    ) -> ServerCertificateVerifyFuture<'a> {
        Box::pin(async move { self.verify(host, port, &der).await })
    }
}

// —— clipboard (text-only bridge) ——

/// Local-side clipboard text staged by `rdp/set-clipboard`. The CLIPRDR
/// backend answers the server's format-data requests from here; the OS
/// clipboard itself stays with the workbench frontend (the sidecar is
/// headless — same split as VNC). Never logged, never audited.
#[derive(Default)]
pub(crate) struct ClipboardStage {
    text: StdMutex<Option<String>>,
}

impl ClipboardStage {
    fn set_text(&self, text: String) {
        if let Ok(mut slot) = self.text.lock() {
            *slot = Some(text);
        }
    }

    fn text(&self) -> Option<String> {
        self.text.lock().ok().and_then(|slot| slot.clone())
    }

    fn clear(&self) {
        if let Ok(mut slot) = self.text.lock() {
            *slot = None;
        }
    }
}

/// Text-only CLIPRDR backend: only CF_UNICODETEXT is ever advertised,
/// requested or accepted. Every file-contents/lock path answers with an
/// error so a hostile server cannot pull anything but the staged text, and
/// even that is bounded at 16 MiB per package.
struct TextClipboardBackend {
    session_id: String,
    stage: Arc<ClipboardStage>,
    proxy: Arc<StdMutex<Box<dyn ClipboardMessageProxy>>>,
    emitter: PluginEmitter,
}

impl std::fmt::Debug for TextClipboardBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identifier only: the emitter has no Debug surface and the staged
        // clipboard text must never appear in a Debug render.
        f.debug_struct("TextClipboardBackend")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl_as_any!(TextClipboardBackend);

impl TextClipboardBackend {
    fn send(&self, message: ClipboardMessage) {
        if let Ok(proxy) = self.proxy.lock() {
            proxy.send_clipboard_message(message);
        }
    }

    /// Advertises the staged text when present (outbound copy initiation).
    fn advertise_staged_text(&mut self) {
        if self.stage.text().is_some() {
            self.send(ClipboardMessage::SendInitiateCopy(vec![
                ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
            ]));
        }
    }
}

impl CliprdrBackend for TextClipboardBackend {
    fn temporary_directory(&self) -> &str {
        // Never used: file transfers answer with errors, but the trait
        // requires a path.
        ".dbx-ssh-rdp-cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        self.advertise_staged_text();
    }

    fn on_request_format_list(&mut self) {
        self.advertise_staged_text();
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        // Remote copy → pull only the text format.
        if available_formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.send(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT,
            ));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        // Backend-enforced text-only: every other format is an error reply,
        // never an empty/implicit success.
        let response = match request.format {
            ClipboardFormatId::CF_UNICODETEXT => match self.stage.text() {
                Some(text) if validate_clipboard_text(&text).is_ok() => {
                    OwnedFormatDataResponse::new_unicode_string(&text)
                }
                _ => OwnedFormatDataResponse::new_error(),
            },
            _ => OwnedFormatDataResponse::new_error(),
        };
        self.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        // C1 entry gate (rdp-security-review): length-check the raw payload
        // BEFORE the UTF-16 → String materialization. 缓解：vendored 层整包
        // 物化不可避免（ironrdp-cliprdr 0.7.0 无流式 API），见
        // rdp-security-review C1 —— 本插件层只能在进入后端回调后尽早拒绝。
        if let Err(error) = validate_clipboard_payload_len(response.data().len()) {
            // Whole-package rejection; the oversized payload is never kept
            // or logged.
            eprintln!("[ssh-sftp-plugin] rdp clipboard inbound rejected: {error}");
            return;
        }
        let Ok(text) = response.to_unicode_string() else {
            return;
        };
        if let Err(error) = validate_clipboard_text(&text) {
            // Whole-package rejection; the oversized payload is never kept
            // or logged.
            eprintln!("[ssh-sftp-plugin] rdp clipboard inbound rejected: {error}");
            return;
        }
        // Forward to the workbench (the frontend bridges to the OS
        // clipboard); the text only ever rides the local IPC event. Oversized
        // text is split into budget-sized chunks (C2): a single >8 MiB JSON
        // event is silently dropped by the SDK transport.
        let chunks = clipboard_chunks(&text);
        let total = chunks.len();
        for (index, chunk) in chunks.iter().enumerate() {
            let mut payload = json!({ "sessionId": self.session_id, "text": chunk });
            if total > 1 {
                payload["chunkIndex"] = Value::from(index);
                payload["chunkTotal"] = Value::from(total);
            }
            if let Err(error) = self.emitter.event("rdp/clipboard", payload) {
                // Never silent (C2): a dropped clipboard event is at least
                // logged. No clipboard text in the log line.
                eprintln!(
                    "[ssh-sftp-plugin] rdp clipboard event dropped: {}",
                    error.message
                );
            }
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.send(ClipboardMessage::SendFileContentsResponse(
            FileContentsResponse::new_error(request.stream_id),
        ));
    }

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// Factory handed to the vendored client: the client invokes it once per
/// run with its own `ClipboardMessageProxy` (which forwards messages into
/// the client's input queue) and we bind that proxy to the backend.
struct TextClipboardBackendFactory {
    session_id: String,
    stage: Arc<ClipboardStage>,
    emitter: PluginEmitter,
    proxy: Arc<StdMutex<Box<dyn ClipboardMessageProxy>>>,
}

impl CliprdrBackendFactory for TextClipboardBackendFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(TextClipboardBackend {
            session_id: self.session_id.clone(),
            stage: self.stage.clone(),
            proxy: self.proxy.clone(),
            emitter: self.emitter.clone(),
        })
    }
}

// —— runtime ——

enum RdpCommand {
    Input(RdpWireInput),
    /// Server-side desktop resize (NyaTerm's dynamic resize path).
    Resize {
        width: u16,
        height: u16,
    },
    /// The staged clipboard text was updated; advertise it to the remote.
    ClipboardAdvertise,
    Close,
}

/// One retained 4K RGBA desktop is 31,850,496 bytes. Keeping one composite
/// frame guarantees a remount paints the whole desktop while staying far below
/// the former eight-patch worst case (>250 MiB).
const RDP_REPLAY_FRAMEBUFFER_MAX_BYTES: usize =
    MAX_DESKTOP_WIDTH as usize * MAX_DESKTOP_HEIGHT as usize * BYTES_PER_PIXEL;

/// Bounded composite desktop used only for webview reattachment. It keeps the
/// most recent pixel at every coordinate, rather than retaining arbitrary
/// incremental wire patches that cannot reconstruct a complete scene.
struct RdpReplayFramebuffer {
    width: u16,
    height: u16,
    rgba: Vec<u8>,
}

impl RdpReplayFramebuffer {
    fn new(width: u16, height: u16) -> Result<Self, String> {
        if width == 0 || height == 0 || width > MAX_DESKTOP_WIDTH || height > MAX_DESKTOP_HEIGHT {
            return Err(format!(
                "RDP replay framebuffer {width}x{height} is outside the supported range"
            ));
        }
        let bytes = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL))
            .ok_or_else(|| "RDP replay framebuffer size overflows".to_string())?;
        if bytes > RDP_REPLAY_FRAMEBUFFER_MAX_BYTES {
            return Err("RDP replay framebuffer exceeds the byte budget".to_string());
        }
        Ok(Self {
            width,
            height,
            rgba: vec![0; bytes],
        })
    }

    #[cfg(test)]
    fn byte_len(&self) -> usize {
        self.rgba.len()
    }

    #[cfg(test)]
    fn clear(&mut self) {
        self.rgba.clear();
        self.rgba.shrink_to_fit();
    }

    #[allow(clippy::too_many_arguments)]
    fn apply_patch(
        &mut self,
        pixels: &[u32],
        desktop_width: u16,
        desktop_height: u16,
        patch_x: u16,
        patch_y: u16,
        patch_width: u16,
        patch_height: u16,
    ) -> Result<(), String> {
        if self.rgba.is_empty() {
            return Err("RDP replay framebuffer has been released".to_string());
        }
        if (self.width, self.height) != (desktop_width, desktop_height) {
            return Err("RDP replay framebuffer dimensions changed".to_string());
        }
        let patch_pixels = usize::from(patch_width)
            .checked_mul(usize::from(patch_height))
            .ok_or_else(|| "RDP replay patch size overflows".to_string())?;
        if pixels.len() < patch_pixels {
            return Err("RDP replay patch buffer is smaller than the patch".to_string());
        }
        let right = u32::from(patch_x) + u32::from(patch_width);
        let bottom = u32::from(patch_y) + u32::from(patch_height);
        if patch_width == 0
            || patch_height == 0
            || right > u32::from(self.width)
            || bottom > u32::from(self.height)
        {
            return Err("RDP replay patch exceeds framebuffer bounds".to_string());
        }
        let stride = usize::from(self.width) * BYTES_PER_PIXEL;
        for row in 0..usize::from(patch_height) {
            for column in 0..usize::from(patch_width) {
                let pixel = pixels[row * usize::from(patch_width) + column];
                let [_, red, green, blue] = pixel.to_be_bytes();
                let offset = (usize::from(patch_y) + row) * stride
                    + (usize::from(patch_x) + column) * BYTES_PER_PIXEL;
                self.rgba[offset..offset + BYTES_PER_PIXEL]
                    .copy_from_slice(&[red, green, blue, 255]);
            }
        }
        Ok(())
    }

    fn full_frame(&self, sequence: u64) -> Result<Vec<u8>, String> {
        if self.rgba.is_empty() {
            return Err("RDP replay framebuffer has been released".to_string());
        }
        crate::vnc_session::encode_frame_patch(&crate::vnc_session::FramePatch {
            sequence,
            desktop_width: u32::from(self.width),
            desktop_height: u32::from(self.height),
            x: 0,
            y: 0,
            width: u32::from(self.width),
            height: u32::from(self.height),
            stride: u32::from(self.width) * BYTES_PER_PIXEL as u32,
            payload: &self.rgba,
        })
        .map_err(|error| error.replace("VNC", "RDP"))
    }
}

struct RdpSessionEntry {
    workbench_id: String,
    host: String,
    port: u16,
    username: String,
    domain: String,
    /// Zeroizing-held credential; materialized once per generation at the
    /// vendored `with_password` boundary, dropped (zeroized) with the entry.
    password: Option<Zeroizing<String>>,
    width: u16,
    height: u16,
    use_nla: bool,
    cert_policy: CertPolicy,
    clipboard_enabled: bool,
    reconnect_attempts: u32,
    created_at_secs: u64,
    /// Bumped before every (re)connect; superseded workers exit without
    /// emitting and every prompt decision across generations is rejected.
    generation: Arc<AtomicU64>,
    /// Monotonic across generations so the frontend can drop out-of-order
    /// patches after a reconnect.
    frame_sequence: AtomicU64,
    /// One bounded, composite RGBA desktop for an exact full-frame remount.
    replay_framebuffer: tokio::sync::Mutex<Option<RdpReplayFramebuffer>>,
    close_requested: AtomicBool,
    /// Sender of the *current* generation's command channel; `None` while
    /// dialling/reconnecting (input fails fast instead of queueing).
    command_sender: tokio::sync::Mutex<Option<mpsc::Sender<RdpCommand>>>,
    /// Local clipboard text staged for the remote (`rdp/set-clipboard`).
    clipboard_stage: Arc<ClipboardStage>,
    broker: Arc<CertPromptBroker>,
    known_certs: KnownCertStore,
}

pub struct RdpSessionRuntime {
    sessions: Arc<tokio::sync::RwLock<HashMap<String, Arc<RdpSessionEntry>>>>,
    broker: Arc<CertPromptBroker>,
}

impl RdpSessionRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            broker: Arc::new(CertPromptBroker::new()),
        }
    }

    /// Registers the session row immediately and spawns the worker, which
    /// publishes `connecting` → `connected`/`error` state events, frame
    /// patches and clipboard events.
    pub async fn start(
        &self,
        request: RdpStartRequest,
        emitter: PluginEmitter,
        data_dir: &Path,
    ) -> Result<Value, String> {
        let host = request.host.trim().to_string();
        if host.is_empty() {
            return Err("rdp/start: host is required".to_string());
        }
        // Identity bounds (B6/F6, rdp-security-review): reject oversized
        // wire identities instead of passing unbounded strings through to
        // the vendored CredSSP/Destination layer.
        if host.len() > MAX_HOST_LEN {
            return Err(format!(
                "rdp/start: host exceeds the {MAX_HOST_LEN} character limit"
            ));
        }
        if request.username.trim().is_empty() {
            return Err("rdp/start: username is required".to_string());
        }
        if request.username.trim().len() > MAX_USERNAME_LEN {
            return Err(format!(
                "rdp/start: username exceeds the {MAX_USERNAME_LEN} character limit"
            ));
        }
        let domain = request.domain.unwrap_or_default();
        if domain.len() > MAX_DOMAIN_LEN {
            return Err(format!(
                "rdp/start: domain exceeds the {MAX_DOMAIN_LEN} character limit"
            ));
        }
        let port = request.port.unwrap_or(3389);
        if port == 0 {
            return Err("rdp/start: port must be between 1 and 65535".to_string());
        }
        let width = request.width.unwrap_or(1280);
        let height = request.height.unwrap_or(800);
        validate_desktop_size(width, height)?;
        let security = {
            let prefs = crate::preferences::load_preferences(data_dir);
            resolve_security(
                request.use_nla,
                request.certificate_policy.as_deref(),
                &prefs,
            )?
        };
        let clipboard_enabled = request.clipboard.unwrap_or(true);
        let reconnect_attempts = request
            .reconnect_attempts
            .unwrap_or(DEFAULT_RECONNECT_ATTEMPTS)
            .min(MAX_RECONNECT_ATTEMPTS);
        let password = request
            .password
            .filter(|password| !password.is_empty())
            .map(Zeroizing::new);
        let session_id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(RdpSessionEntry {
            workbench_id: request.workbench_id.clone(),
            host: host.clone(),
            port,
            username: request.username,
            domain,
            password,
            width,
            height,
            use_nla: security.use_nla,
            cert_policy: security.certificate_policy,
            clipboard_enabled,
            reconnect_attempts,
            created_at_secs: unix_now_secs(),
            generation: Arc::new(AtomicU64::new(0)),
            frame_sequence: AtomicU64::new(0),
            replay_framebuffer: tokio::sync::Mutex::new(None),
            close_requested: AtomicBool::new(false),
            command_sender: tokio::sync::Mutex::new(None),
            clipboard_stage: Arc::new(ClipboardStage::default()),
            broker: self.broker.clone(),
            known_certs: KnownCertStore::new(data_dir),
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
            "useNla": security.use_nla,
            "certificatePolicy": security.certificate_policy.as_str(),
            "clipboard": clipboard_enabled,
            "reconnectAttempts": reconnect_attempts,
        }))
    }
    async fn session(&self, session_id: &str) -> Result<Arc<RdpSessionEntry>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "RDP session was not found".to_string())
    }

    async fn command_sender(&self, session_id: &str) -> Result<mpsc::Sender<RdpCommand>, String> {
        let entry = self.session(session_id).await?;
        let sender = entry.command_sender.lock().await.clone();
        sender.ok_or_else(|| "RDP session is not connected".to_string())
    }

    /// Keyboard/pointer forwarding (`rdp/input`, alias `rdp/write`).
    pub async fn input(&self, session_id: &str, input: RdpWireInput) -> Result<(), String> {
        // Unicode text bound (E5a, rdp-security-review): each character
        // expands into a press+release operation pair, so unbounded text
        // would materialize an unbounded operation list. Rejected whole.
        if let RdpWireInput::Unicode { text } = &input {
            let characters = text.chars().count();
            if characters > MAX_UNICODE_TEXT_CHARS {
                return Err(format!(
                    "rdp/input: unicode text exceeds the {MAX_UNICODE_TEXT_CHARS} character limit"
                ));
            }
        }
        self.session(session_id).await?;
        let sender = self.command_sender(session_id).await?;
        sender
            .send(RdpCommand::Input(input))
            .await
            .map_err(|_| "RDP session is closed".to_string())
    }

    /// Server-side desktop resize (`rdp/resize`), NyaTerm's dynamic resize.
    pub async fn resize(&self, session_id: &str, width: u16, height: u16) -> Result<(), String> {
        validate_desktop_size(width, height)?;
        self.session(session_id).await?;
        let sender = self.command_sender(session_id).await?;
        sender
            .send(RdpCommand::Resize { width, height })
            .await
            .map_err(|_| "RDP session is closed".to_string())
    }

    /// Local clipboard → remote (`rdp/set-clipboard`): stage the text and
    /// advertise it as CF_UNICODETEXT.
    pub async fn set_clipboard(&self, session_id: &str, text: String) -> Result<(), String> {
        let entry = self.session(session_id).await?;
        if !entry.clipboard_enabled {
            return Err(
                "rdp/set-clipboard: clipboard redirection is disabled for this session".to_string(),
            );
        }
        validate_clipboard_text(&text)?;
        entry.clipboard_stage.set_text(text);
        let sender = self.command_sender(session_id).await?;
        sender
            .send(RdpCommand::ClipboardAdvertise)
            .await
            .map_err(|_| "RDP session is closed".to_string())
    }

    /// Manual reconnect: kill the current generation and restart the pump.
    pub async fn reconnect(
        &self,
        session_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let entry = self.session(session_id).await?;
        entry.close_requested.store(false, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        *entry.replay_framebuffer.lock().await = None;
        self.broker.cancel_session(session_id);
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(RdpCommand::Close).await;
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
            .ok_or("RDP session was not found")?;
        entry.close_requested.store(true, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        *entry.replay_framebuffer.lock().await = None;
        // Any pending certificate prompt of this session must reject now,
        // and the staged clipboard text is dropped with the entry.
        self.broker.cancel_session(session_id);
        entry.clipboard_stage.clear();
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(RdpCommand::Close).await;
        }
        Ok(())
    }

    /// Closing a workbench tears down its RDP sessions (same contract as the
    /// local shells, Telnet and VNC).
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

    /// Read-only inventory of live RDP sessions (no credentials, no state —
    /// state changes only surface as `rdp/session/state` events).
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
                    "username": entry.username,
                    "hasPassword": entry.password.is_some(),
                    "useNla": entry.use_nla,
                    "certificatePolicy": entry.cert_policy.as_str(),
                    "clipboard": entry.clipboard_enabled,
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

    /// Re-emits one composite full desktop after a webview remount. Incremental
    /// RDP patches cannot restore a renderer independently, so this never
    /// replays partial patches as if they were a complete scene.
    pub async fn replay(&self, session_id: &str, emitter: &PluginEmitter) -> Result<Value, String> {
        let entry = self.session(session_id).await?;
        let framebuffer = entry.replay_framebuffer.lock().await;
        let Some(framebuffer) = framebuffer.as_ref() else {
            return Ok(json!({ "frameCount": 0, "complete": false }));
        };
        let sequence = entry.frame_sequence.fetch_add(1, Ordering::AcqRel);
        let frame = framebuffer.full_frame(sequence)?;
        publish_frame(session_id, &frame, emitter);
        Ok(json!({ "frameCount": 1, "complete": true }))
    }

    /// Certificate-prompt resolution (`rdp/certificate/resolve`).
    pub fn resolve_certificate(
        &self,
        challenge_id: &str,
        accept: bool,
        remember: bool,
    ) -> Result<(), String> {
        self.broker.resolve(challenge_id, accept, remember)
    }

    /// True when the challenge id belongs to an RDP certificate prompt (the
    /// shared `connection/challenge/resolve` dispatcher uses this to route).
    pub fn has_certificate_challenge(&self, challenge_id: &str) -> bool {
        self.broker
            .pending
            .lock()
            .map(|pending| pending.contains_key(challenge_id))
            .unwrap_or(false)
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

// —— worker (generation-guarded pump) ——

fn spawn_worker(
    session_id: String,
    entry: Arc<RdpSessionEntry>,
    emitter: PluginEmitter,
    sessions: Arc<tokio::sync::RwLock<HashMap<String, Arc<RdpSessionEntry>>>>,
) {
    tokio::spawn(async move {
        let emit_state = |state: &str, error: Option<(&str, &str)>, attempt: Option<(u32, u32)>| {
            let mut payload = json!({
                "sessionId": session_id,
                "workbenchId": entry.workbench_id,
                "state": state,
            });
            if let Some((kind, message)) = error {
                payload["errorKind"] = Value::String(kind.to_string());
                payload["error"] = Value::String(message.to_string());
            }
            if let Some((attempt, max)) = attempt {
                payload["attempt"] = Value::from(attempt);
                payload["maxAttempts"] = Value::from(max);
            }
            emitter.event("rdp/session/state", payload)
        };
        // D3 (rdp-security-review): ladder step + cumulative total budget.
        // An active generation resets the step only, so a hostile server
        // cannot keep the client dialling forever.
        let mut budget = ReconnectBudget::new();
        loop {
            if entry.close_requested.load(Ordering::Acquire) {
                return;
            }
            let generation = entry.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let _ = emit_state("connecting", None, None);
            match run_generation(&session_id, &entry, generation, &emitter).await {
                GenerationEnd::Closed | GenerationEnd::Superseded => {
                    // Only the current generation may publish the terminal
                    // state (close() owns the closed state; a superseded
                    // generation's successor owns the session now).
                    if entry.generation.load(Ordering::Acquire) == generation
                        && !entry.close_requested.load(Ordering::Acquire)
                    {
                        let _ = emit_state("closed", None, None);
                        *entry.replay_framebuffer.lock().await = None;
                        sessions.write().await.remove(&session_id);
                    }
                    return;
                }
                GenerationEnd::Failed {
                    error,
                    error_kind,
                    retryable,
                    was_active,
                } => {
                    let _ = emit_state("error", Some((error_kind.as_str(), error.as_str())), None);
                    // An error invalidates the retained scene. Release the
                    // bounded buffer before retry backoff so a dead/retrying
                    // session never holds a stale 4K desktop in memory.
                    *entry.replay_framebuffer.lock().await = None;
                    if was_active {
                        // The session had been fully active in this
                        // generation: a fresh backoff ladder (NyaTerm resets
                        // the attempt counter on the first active frame).
                        // The cumulative budget is NOT reset (D3).
                        budget.on_active_generation();
                    }
                    if !budget.allows(entry.reconnect_attempts, retryable)
                        || entry.close_requested.load(Ordering::Acquire)
                        || entry.generation.load(Ordering::Acquire) != generation
                    {
                        let _ = emit_state("closed", None, None);
                        *entry.replay_framebuffer.lock().await = None;
                        sessions.write().await.remove(&session_id);
                        return;
                    }
                    budget.charge();
                    let _ = emit_state(
                        "reconnecting",
                        Some((error_kind.as_str(), error.as_str())),
                        Some((budget.attempt, entry.reconnect_attempts)),
                    );
                    tokio::time::sleep(reconnect_delay(budget.attempt)).await;
                }
            }
        }
    });
}

/// One dial → negotiate → pump cycle. Runs the IronRDP client on a dedicated
/// OS thread (current-thread runtime, NyaTerm's engine-thread shape) and
/// pumps its output events into binary frames / state events.
async fn run_generation(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    emitter: &PluginEmitter,
) -> GenerationEnd {
    if entry.generation.load(Ordering::Acquire) != generation {
        return GenerationEnd::Superseded;
    }
    let config = match build_ironrdp_config(session_id, entry, generation, emitter) {
        Ok(config) => config,
        Err(error) => {
            return GenerationEnd::Failed {
                error,
                error_kind: RdpErrorKind::Session,
                retryable: false,
                was_active: false,
            };
        }
    };
    let (output_sender, mut output_receiver) = mpsc::channel::<RdpOutputEvent>(2);
    let client = IronRdpClient::new(config, output_sender);
    let input_sender = client.input_sender();
    let mut join_handle = Some(std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(runtime) = runtime {
            runtime.block_on(client.run());
        }
    }));

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<RdpCommand>(COMMAND_CHANNEL_CAPACITY);
    *entry.command_sender.lock().await = Some(cmd_tx);

    let mut input_database = IronRdpInputDatabase::new();
    let mut was_active = false;
    let end = loop {
        if entry.generation.load(Ordering::Acquire) != generation {
            break GenerationEnd::Superseded;
        }
        tokio::select! {
            event = output_receiver.recv() => match event {
                Some(event) => {
                    if let Some(end) = handle_output_event(
                        session_id, entry, generation, event, emitter, &mut was_active,
                    )
                    .await
                    {
                        break end;
                    }
                }
                None => {
                    // The engine thread dropped its sender: it stopped.
                    if let Some(handle) = join_handle.take() {
                        let _ = handle.join();
                    }
                    break GenerationEnd::Failed {
                        error: "RDP engine stopped".to_string(),
                        error_kind: RdpErrorKind::Session,
                        retryable: true,
                        was_active,
                    };
                }
            },
            command = cmd_rx.recv() => match command {
                Some(RdpCommand::Input(input)) => {
                    if let Err(error) = send_wire_input(&input_sender, &mut input_database, input)
                    {
                        break GenerationEnd::Failed {
                            error,
                            error_kind: RdpErrorKind::Session,
                            retryable: false,
                            was_active,
                        };
                    }
                }
                Some(RdpCommand::Resize { width, height }) => {
                    let sent = input_sender.send(IronRdpInputEvent::Resize {
                        width,
                        height,
                        scale_factor: 100,
                        physical_size: None,
                    });
                    if sent.is_err() {
                        break GenerationEnd::Failed {
                            error: "RDP input channel is closed".to_string(),
                            error_kind: RdpErrorKind::Session,
                            retryable: false,
                            was_active,
                        };
                    }
                }
                Some(RdpCommand::ClipboardAdvertise) => {
                    let sent = input_sender.send(IronRdpInputEvent::Clipboard(
                        ClipboardMessage::SendInitiateCopy(vec![ClipboardFormat::new(
                            ClipboardFormatId::CF_UNICODETEXT,
                        )]),
                    ));
                    if sent.is_err() {
                        break GenerationEnd::Failed {
                            error: "RDP input channel is closed".to_string(),
                            error_kind: RdpErrorKind::Session,
                            retryable: false,
                            was_active,
                        };
                    }
                }
                Some(RdpCommand::Close) | None => break GenerationEnd::Closed,
            },
        }
    };
    // Clear only when this generation still owns the channel: a superseded
    // worker must not drop the successor's sender.
    if entry.generation.load(Ordering::Acquire) == generation {
        *entry.command_sender.lock().await = None;
    }
    // Tell the engine to finish; a still-running thread detaches and exits
    // on its own (NyaTerm only joins when already finished too).
    let _ = input_sender.send(IronRdpInputEvent::Close);
    if let Some(handle) = join_handle.take() {
        if handle.is_finished() {
            let _ = handle.join();
        }
    }
    end
}

/// Handles one engine output event; `Some(end)` aborts the pump.
async fn handle_output_event(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    event: RdpOutputEvent,
    emitter: &PluginEmitter,
    was_active: &mut bool,
) -> Option<GenerationEnd> {
    if entry.generation.load(Ordering::Acquire) != generation {
        return Some(GenerationEnd::Superseded);
    }
    match event {
        RdpOutputEvent::ImagePatch {
            buffer,
            desktop_width,
            desktop_height,
            x,
            y,
            width,
            height,
        } => {
            if !*was_active {
                *was_active = true;
                let _ = emitter.event(
                    "rdp/session/state",
                    json!({
                        "sessionId": session_id,
                        "workbenchId": entry.workbench_id,
                        "state": "connected",
                    }),
                );
            }
            // The desktop is engine-supplied: bound it like every other
            // wire-derived value (fail the session on violation).
            if desktop_width > MAX_DESKTOP_WIDTH || desktop_height > MAX_DESKTOP_HEIGHT {
                return Some(GenerationEnd::Failed {
                    error: format!(
                        "RDP desktop {desktop_width}x{desktop_height} is outside the supported range (max {MAX_DESKTOP_WIDTH}x{MAX_DESKTOP_HEIGHT})"
                    ),
                    error_kind: RdpErrorKind::Session,
                    retryable: false,
                    was_active: false,
                });
            }
            let sequence = entry.frame_sequence.fetch_add(1, Ordering::AcqRel);
            match image_patch_to_frame(
                &buffer,
                desktop_width,
                desktop_height,
                x,
                y,
                width,
                height,
                sequence,
            ) {
                Ok(frame) => {
                    let mut framebuffer = entry.replay_framebuffer.lock().await;
                    let dimensions = (desktop_width, desktop_height);
                    let needs_reset = framebuffer
                        .as_ref()
                        .is_none_or(|current| (current.width, current.height) != dimensions);
                    if needs_reset {
                        *framebuffer =
                            match RdpReplayFramebuffer::new(desktop_width, desktop_height) {
                                Ok(next) => Some(next),
                                Err(error) => {
                                    return Some(GenerationEnd::Failed {
                                        error,
                                        error_kind: RdpErrorKind::Session,
                                        retryable: false,
                                        was_active: false,
                                    });
                                }
                            };
                    }
                    if let Some(current) = framebuffer.as_mut() {
                        if let Err(error) = current.apply_patch(
                            &buffer,
                            desktop_width,
                            desktop_height,
                            x,
                            y,
                            width,
                            height,
                        ) {
                            return Some(GenerationEnd::Failed {
                                error,
                                error_kind: RdpErrorKind::Session,
                                retryable: false,
                                was_active: false,
                            });
                        }
                    }
                    drop(framebuffer);
                    publish_frame(session_id, &frame, emitter);
                }
                Err(error) => {
                    // A malformed patch is visual-only damage (the frame is
                    // dropped); the engine keeps running. NyaTerm logs and
                    // discards too.
                    eprintln!("[ssh-sftp-plugin] rdp frame dropped: {error}");
                }
            }
            None
        }
        RdpOutputEvent::ConnectionFailure(error) => {
            let (kind, retryable) = classify_connector_error_text(&format!("{error:?}"));
            let message = connector_error_message(kind, &format!("{error:?}"));
            eprintln!(
                "[ssh-sftp-plugin] rdp connection failed ({}): {}",
                kind.as_str(),
                message
            );
            Some(GenerationEnd::Failed {
                error: message,
                error_kind: kind,
                retryable,
                was_active: false,
            })
        }
        RdpOutputEvent::Terminated(result) => match result {
            Ok(reason) => Some(GenerationEnd::Failed {
                error: format!("RDP session disconnected: {reason:?}"),
                error_kind: RdpErrorKind::Session,
                // Graceful server-side disconnect: no auto-reconnect
                // (NyaTerm parity — the user decides via rdp/reconnect).
                retryable: false,
                was_active: *was_active,
            }),
            Err(error) => {
                let (kind, retryable) = classify_session_error_text(&format!("{error:?}"));
                let message = session_error_message(kind, &format!("{error:?}"));
                eprintln!(
                    "[ssh-sftp-plugin] rdp session failed ({}): {}",
                    kind.as_str(),
                    message
                );
                Some(GenerationEnd::Failed {
                    error: message,
                    error_kind: kind,
                    retryable,
                    was_active: *was_active,
                })
            }
        },
        RdpOutputEvent::PointerDefault => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "default", "sessionId": session_id }),
            );
            None
        }
        RdpOutputEvent::PointerHidden => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "hidden", "sessionId": session_id }),
            );
            None
        }
        RdpOutputEvent::PointerPosition { x, y } => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "position", "sessionId": session_id, "x": x, "y": y }),
            );
            None
        }
        RdpOutputEvent::PointerBitmap(pointer) => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({
                    "type": "bitmap",
                    "sessionId": session_id,
                    "width": pointer.width,
                    "height": pointer.height,
                    "hotspotX": pointer.hotspot_x,
                    "hotspotY": pointer.hotspot_y,
                    "rgbaBase64": BASE64_STANDARD.encode(&pointer.bitmap_data),
                }),
            );
            None
        }
    }
}

fn publish_frame(session_id: &str, frame: &[u8], emitter: &PluginEmitter) {
    if let Err(error) = emitter.binary(&format!("rdp/frame/{session_id}"), frame) {
        // Frame loss is visual-only; the engine's own I/O errors tear the
        // session down, so a failing emit only needs a log line.
        eprintln!(
            "[ssh-sftp-plugin] rdp frame publish failed: {}",
            error.message
        );
    }
}

/// Converts one engine `ImagePatch` (u32 0x00RRGGBB pixels) into the shared
/// 44-byte RGBA patch frame (same wire format as `vnc/frame`). Pure —
/// unit-tested against the shared golden vector shape. The argument list
/// mirrors the engine event's own field set (NyaTerm's helper has the same
/// shape), hence the targeted allow.
#[allow(clippy::too_many_arguments)]
fn image_patch_to_frame(
    pixels: &[u32],
    desktop_width: u16,
    desktop_height: u16,
    patch_x: u16,
    patch_y: u16,
    patch_width: u16,
    patch_height: u16,
    sequence: u64,
) -> Result<Vec<u8>, String> {
    let pixel_count = usize::from(patch_width)
        .checked_mul(usize::from(patch_height))
        .ok_or_else(|| "RDP frame pixel count overflows".to_string())?;
    if pixels.len() < pixel_count {
        return Err("RDP frame pixel buffer is smaller than the patch".to_string());
    }
    let payload_len = pixel_count
        .checked_mul(BYTES_PER_PIXEL)
        .ok_or_else(|| "RDP frame payload size overflows".to_string())?;
    let mut payload = vec![0_u8; payload_len];
    for (index, pixel) in pixels.iter().take(pixel_count).enumerate() {
        let [_, red, green, blue] = pixel.to_be_bytes();
        let offset = index * BYTES_PER_PIXEL;
        payload[offset] = red;
        payload[offset + 1] = green;
        payload[offset + 2] = blue;
        payload[offset + 3] = 255;
    }
    crate::vnc_session::encode_frame_patch(&crate::vnc_session::FramePatch {
        sequence,
        desktop_width: u32::from(desktop_width),
        desktop_height: u32::from(desktop_height),
        x: u32::from(patch_x),
        y: u32::from(patch_y),
        width: u32::from(patch_width),
        height: u32::from(patch_height),
        stride: u32::from(patch_width) * 4,
        payload: &payload,
    })
    .map_err(|error| error.replace("VNC", "RDP"))
}

// —— input mapping (NyaTerm's rdp_input_to_fast_path_input) ——

enum InputAction {
    Operations(Vec<IronRdpInputOperation>),
    FastPath(IronRdpFastPathInputEvent),
}

fn wire_input_to_action(input: RdpWireInput) -> Option<InputAction> {
    match input {
        RdpWireInput::KeyDown {
            scan_code,
            extended,
        } if is_right_shift_scan_code(scan_code, extended) => Some(InputAction::FastPath(
            IronRdpFastPathInputEvent::KeyboardEvent(
                IronRdpKeyboardFlags::empty(),
                RDP_RIGHT_SHIFT_SCAN_CODE,
            ),
        )),
        RdpWireInput::KeyDown {
            scan_code,
            extended,
        } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::KeyPressed(IronRdpScancode::from_u8(extended, scan_code)),
        ])),
        RdpWireInput::KeyUp {
            scan_code,
            extended,
        } if is_right_shift_scan_code(scan_code, extended) => Some(InputAction::FastPath(
            IronRdpFastPathInputEvent::KeyboardEvent(
                IronRdpKeyboardFlags::RELEASE,
                RDP_RIGHT_SHIFT_SCAN_CODE,
            ),
        )),
        RdpWireInput::KeyUp {
            scan_code,
            extended,
        } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::KeyReleased(IronRdpScancode::from_u8(extended, scan_code)),
        ])),
        RdpWireInput::MouseMove { x, y } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            }),
        ])),
        RdpWireInput::MouseButton {
            button,
            pressed,
            x,
            y,
        } => {
            let Some(button) = ironrdp_mouse_button(&button) else {
                return Some(InputAction::Operations(Vec::new()));
            };
            let mut operations = vec![IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            })];
            operations.push(if pressed {
                IronRdpInputOperation::MouseButtonPressed(button)
            } else {
                IronRdpInputOperation::MouseButtonReleased(button)
            });
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::MouseWheel {
            delta_x,
            delta_y,
            x,
            y,
        } => {
            let mut operations = vec![IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            })];
            if delta_x.abs() > 0.001 {
                operations.push(IronRdpInputOperation::WheelRotations(
                    IronRdpWheelRotations {
                        is_vertical: false,
                        rotation_units: clamp_f64_to_i16(-delta_x),
                    },
                ));
            }
            if delta_y.abs() > 0.001 {
                operations.push(IronRdpInputOperation::WheelRotations(
                    IronRdpWheelRotations {
                        is_vertical: true,
                        rotation_units: clamp_f64_to_i16(-delta_y),
                    },
                ));
            }
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::Unicode { text } => {
            let mut operations = Vec::new();
            for character in text.chars() {
                operations.push(IronRdpInputOperation::UnicodeKeyPressed(character));
                operations.push(IronRdpInputOperation::UnicodeKeyReleased(character));
            }
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::ReleaseAll => None,
    }
}

fn is_right_shift_scan_code(scan_code: u8, extended: bool) -> bool {
    !extended && scan_code == RDP_RIGHT_SHIFT_SCAN_CODE
}

fn ironrdp_mouse_button(button: &str) -> Option<IronRdpMouseButton> {
    match button {
        "left" => Some(IronRdpMouseButton::Left),
        "middle" => Some(IronRdpMouseButton::Middle),
        "right" => Some(IronRdpMouseButton::Right),
        "back" => Some(IronRdpMouseButton::X1),
        "forward" => Some(IronRdpMouseButton::X2),
        _ => None,
    }
}

fn clamp_u32_to_u16(value: u32) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

fn clamp_f64_to_i16(value: f64) -> i16 {
    if value.is_nan() {
        return 0;
    }
    value.clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

/// Feeds one wire input through NyaTerm's mapping (right-shift direct
/// fast-path, everything else via the input database) and pushes the
/// resulting fast-path events to the engine.
fn send_wire_input(
    input_sender: &mpsc::UnboundedSender<IronRdpInputEvent>,
    database: &mut IronRdpInputDatabase,
    input: RdpWireInput,
) -> Result<(), String> {
    let fast_path: SmallVec<[IronRdpFastPathInputEvent; 2]> = match wire_input_to_action(input) {
        Some(InputAction::Operations(operations)) => database.apply(operations),
        Some(InputAction::FastPath(event)) => smallvec::smallvec![event],
        None => database.release_all(),
    };
    if !fast_path.is_empty()
        && input_sender
            .send(IronRdpInputEvent::FastPath(fast_path))
            .is_err()
    {
        return Err("RDP input channel is closed".to_string());
    }
    Ok(())
}

// —— engine config builder ——

fn build_ironrdp_config(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    emitter: &PluginEmitter,
) -> Result<IronRdpConfig, String> {
    let verifier = Arc::new(RdpCertificateVerifier {
        emitter: emitter.clone(),
        broker: entry.broker.clone(),
        known_certs: entry.known_certs.clone(),
        session_id: session_id.to_string(),
        policy: entry.cert_policy,
        generation: entry.generation.clone(),
        own_generation: generation,
    });
    let mut builder = IronRdpConfigBuilder::new()
        .with_destination(IronRdpDestination::from_parts(
            entry.host.clone(),
            entry.port,
        ))
        .with_transport(IronRdpTransportKind::Direct)
        .with_username(entry.username.clone())
        .with_domain(entry.domain.clone())
        // Credential boundary: the Zeroizing-held password is materialized
        // once here per generation (vendored storage is RDP-1 scope); our
        // side never keeps a plaintext copy.
        .with_password(
            entry
                .password
                .as_ref()
                .map(|p| p.as_str())
                .unwrap_or_default(),
        )
        .with_desktop_width(entry.width)
        .with_desktop_height(entry.height)
        .with_desktop_scale_factor(100)
        .with_color_depth(32)
        .with_credssp(entry.use_nla)
        // TLS is always on: CredSSP rides on TLS and the legacy "standard
        // RDP security" path is never advertised (checklist §3-C).
        .with_tls(true)
        .with_autologon(true)
        // NyaTerm: IronRDP 0.17 decodes compressed FastPath bitmaps
        // inconsistently after reactivation — do not advertise bulk
        // compression.
        .with_compression(false)
        .with_server_pointer(true)
        .with_client_build(client_build())
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_client_name(client_name())
        .with_platform(current_platform())
        .with_server_certificate_verifier(verifier);

    if entry.clipboard_enabled {
        builder = builder
            .with_clipboard(ClipboardType::Enable)
            .with_cliprdr_factory({
                let session_id = session_id.to_string();
                let stage = entry.clipboard_stage.clone();
                let emitter = emitter.clone();
                move |proxy| {
                    Box::new(TextClipboardBackendFactory {
                        session_id: session_id.clone(),
                        stage: stage.clone(),
                        emitter: emitter.clone(),
                        proxy: Arc::new(StdMutex::new(proxy)),
                    })
                }
            });
    } else {
        entry.clipboard_stage.clear();
        builder = builder.with_clipboard(ClipboardType::Disable);
    }

    builder
        .build()
        .map_err(|error| format!("Unable to build RDP config: {error}"))
}

fn client_build() -> u32 {
    env!("CARGO_PKG_VERSION")
        .split('.')
        .take(3)
        .fold(0_u32, |acc, part| {
            acc.saturating_mul(100)
                .saturating_add(part.parse::<u32>().unwrap_or(0))
        })
}

fn client_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "DBX-SSH".to_string())
}

fn current_platform() -> MajorPlatformType {
    #[cfg(target_os = "windows")]
    {
        MajorPlatformType::WINDOWS
    }
    #[cfg(target_os = "macos")]
    {
        MajorPlatformType::MACINTOSH
    }
    #[cfg(target_os = "ios")]
    {
        MajorPlatformType::IOS
    }
    #[cfg(target_os = "android")]
    {
        MajorPlatformType::ANDROID
    }
    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        MajorPlatformType::UNIX
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 配置归一化 ————————————————————————————————————————————

    #[test]
    fn security_defaults_are_review_locked() {
        // 缺省（无参数、无偏好）= use_nla true + prompt（清单 §3-C 基线）。
        let resolved = resolve_security(None, None, &serde_json::json!({})).expect("defaults");
        assert!(resolved.use_nla);
        assert_eq!(resolved.certificate_policy, CertPolicy::Prompt);
    }

    #[test]
    fn security_preferences_fill_absent_params() {
        let prefs = serde_json::json!({ "rdp_use_nla": false, "rdp_certificate_policy": "strict" });
        let resolved = resolve_security(None, None, &prefs).expect("from prefs");
        assert!(!resolved.use_nla);
        assert_eq!(resolved.certificate_policy, CertPolicy::Strict);
        // 显式参数压过偏好。
        let resolved =
            resolve_security(Some(true), Some("accept-temporarily"), &prefs).expect("explicit");
        assert!(resolved.use_nla);
        assert_eq!(resolved.certificate_policy, CertPolicy::AcceptTemporarily);
    }

    #[test]
    fn security_rejects_unknown_policy_names() {
        let error = resolve_security(None, Some("trust-everything"), &serde_json::json!({}))
            .expect_err("unknown policy must fail closed");
        assert!(
            error.contains("prompt, strict or accept-temporarily"),
            "{error}"
        );
    }

    #[test]
    fn desktop_size_bounds_match_the_contract() {
        assert!(validate_desktop_size(640, 480).is_ok());
        assert!(validate_desktop_size(3840, 2160).is_ok());
        assert!(validate_desktop_size(1280, 800).is_ok());
        // NyaTerm 下界（640 以下拒绝）。
        assert!(validate_desktop_size(639, 480).is_err());
        assert!(validate_desktop_size(640, 479).is_err());
        // 插件上界（3840x2160，保证补丁负载 < 64 MiB）。
        assert!(validate_desktop_size(3841, 2160).is_err());
        assert!(validate_desktop_size(3840, 2161).is_err());
    }

    // —— 错误分类与重连门控 ——————————————————————————————————

    #[test]
    fn connector_classifier_gates_reconnect_by_failure_kind() {
        // 认证类失败绝不重试（凭据错误不会因重试变对）。
        for text in [
            "credssp finalization failed",
            "authentication failed",
            "password expired",
            "logon failure",
            "access denied",
        ] {
            let (kind, retryable) = classify_connector_error_text(text);
            assert_eq!(kind, RdpErrorKind::Authentication, "{text}");
            assert!(!retryable, "{text}");
        }
        // 证书拒绝 fail-closed：不重试。
        for text in [
            "tlsupgrade failed: certificate rejected",
            "unknown certificate",
            "certificate fingerprint changed",
        ] {
            let (kind, retryable) = classify_connector_error_text(text);
            assert_eq!(kind, RdpErrorKind::Certificate, "{text}");
            assert!(!retryable, "{text}");
        }
        // TLS 升级被对端重置（NyaTerm 测试向量）：TLS 类，可重试。
        let text =
            r#"error { context: "tlsupgrade", source: os { code: 10054, kind: connectionreset } }"#;
        assert_eq!(
            classify_connector_error_text(text),
            (RdpErrorKind::Tls, true)
        );
        // 协商失败不重试。
        let (kind, retryable) = classify_connector_error_text("x224 negotiation failed");
        assert_eq!(kind, RdpErrorKind::Negotiation);
        assert!(!retryable);
        // 其余传输错误可重试。
        assert_eq!(
            classify_connector_error_text("os error 111 connection refused"),
            (RdpErrorKind::Transport, true)
        );
    }

    #[test]
    fn session_classifier_routes_tls_transport_and_clipboard() {
        assert_eq!(
            classify_session_error_text("native-tls Schannel handshake failure"),
            (RdpErrorKind::Tls, true)
        );
        // TLS 升级被对端重置按 TLS 分类（NyaTerm 同款语义，连接重试）。
        assert_eq!(
            classify_session_error_text("connection reset by peer"),
            (RdpErrorKind::Tls, true)
        );
        // 纯传输中断（broken pipe/eof）按传输分类，可重试。
        assert_eq!(
            classify_session_error_text("broken pipe"),
            (RdpErrorKind::Transport, true)
        );
        assert_eq!(
            classify_session_error_text("unexpected eof from transport"),
            (RdpErrorKind::Transport, true)
        );
        let (kind, retryable) = classify_session_error_text("cliprdr channel broken");
        assert_eq!(kind, RdpErrorKind::Clipboard);
        assert!(!retryable);
        // 认证字样照旧不重试。
        assert_eq!(
            classify_session_error_text("authentication token expired"),
            (RdpErrorKind::Authentication, false)
        );
    }

    #[test]
    fn auth_failures_surface_as_one_opaque_message() {
        // 清单 §3-A：失败语义统一，不区分用户名/密码，不回显凭据。
        let (kind, _) = classify_connector_error_text("credssp: wrong password for admin");
        assert_eq!(
            connector_error_message(kind, "credssp: wrong password for admin"),
            "RDP authentication failed"
        );
        let (kind, _) = classify_session_error_text("password rejected");
        assert_eq!(
            session_error_message(kind, "password rejected"),
            "RDP authentication failed"
        );
        // 传输类错误保留细节（不含凭据）。
        let message =
            connector_error_message(RdpErrorKind::Transport, "os error 111: connection refused");
        assert!(message.contains("connection refused"), "{message}");
    }

    #[test]
    fn reconnect_delay_follows_nyaterm_ladder() {
        assert_eq!(reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(reconnect_delay(2), Duration::from_secs(2));
        assert_eq!(reconnect_delay(3), Duration::from_secs(4));
        assert_eq!(reconnect_delay(4), Duration::from_secs(8));
        assert_eq!(reconnect_delay(5), Duration::from_secs(15));
        assert_eq!(reconnect_delay(6), Duration::from_secs(30));
        assert_eq!(reconnect_delay(100), Duration::from_secs(30));
    }

    // —— 证书策略状态机 ——————————————————————————————————————

    #[test]
    fn certificate_policy_matches_nyaterm_semantics() {
        use KnownCertStatus::{Changed, Match, Unknown};
        // strict：仅已记住的匹配指纹放行，未知/变更一律拒绝。
        assert_eq!(
            certificate_allows_without_prompt(CertPolicy::Strict, Match),
            Ok(true)
        );
        assert!(certificate_allows_without_prompt(CertPolicy::Strict, Unknown).is_err());
        assert!(certificate_allows_without_prompt(CertPolicy::Strict, Changed).is_err());
        // prompt：匹配静默放行，其余弹确认（false = 需要 prompt）。
        assert_eq!(
            certificate_allows_without_prompt(CertPolicy::Prompt, Match),
            Ok(true)
        );
        assert_eq!(
            certificate_allows_without_prompt(CertPolicy::Prompt, Unknown),
            Ok(false)
        );
        assert_eq!(
            certificate_allows_without_prompt(CertPolicy::Prompt, Changed),
            Ok(false)
        );
        // accept-temporarily：显式选择，无需 prompt。
        assert_eq!(
            certificate_allows_without_prompt(CertPolicy::AcceptTemporarily, Changed),
            Ok(true)
        );
        // 无「静默接受任意证书」路径：默认策略对未知证书必须要求 prompt。
        assert_eq!(
            resolve_security(None, None, &serde_json::json!({}))
                .expect("default")
                .certificate_policy,
            CertPolicy::Prompt
        );
    }

    #[test]
    fn cert_policy_parses_wire_names_only() {
        assert_eq!(CertPolicy::parse("prompt"), Some(CertPolicy::Prompt));
        assert_eq!(CertPolicy::parse("strict"), Some(CertPolicy::Strict));
        assert_eq!(
            CertPolicy::parse("accept-temporarily"),
            Some(CertPolicy::AcceptTemporarily)
        );
        assert_eq!(CertPolicy::parse("always-accept"), None);
        assert_eq!(CertPolicy::Prompt.as_str(), "prompt");
    }

    #[test]
    fn known_cert_status_matches_changed_and_unknown() {
        let mut store = HashMap::new();
        store.insert("rdp.local:3389".to_string(), "SHA256:aa".to_string());
        assert_eq!(
            known_cert_status(&store, "rdp.local", 3389, "SHA256:aa"),
            KnownCertStatus::Match
        );
        assert_eq!(
            known_cert_status(&store, "rdp.local", 3389, "SHA256:bb"),
            KnownCertStatus::Changed
        );
        assert_eq!(
            known_cert_status(&store, "other.local", 3389, "SHA256:aa"),
            KnownCertStatus::Unknown
        );
    }

    #[test]
    fn known_cert_store_persists_and_roundtrips() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let store = KnownCertStore::new(data_dir.path());
        assert_eq!(
            store.check("h", 3389, "SHA256:aa"),
            KnownCertStatus::Unknown
        );
        store.remember("h", 3389, "SHA256:aa").expect("remember");
        assert_eq!(store.check("h", 3389, "SHA256:aa"), KnownCertStatus::Match);
        assert_eq!(
            store.check("h", 3389, "SHA256:bb"),
            KnownCertStatus::Changed
        );
        // 损坏文件按空存储处理（不毒化启动）。
        std::fs::write(&store.path, "{not json").expect("write junk");
        assert_eq!(
            store.check("h", 3389, "SHA256:aa"),
            KnownCertStatus::Unknown
        );
    }

    #[test]
    fn fingerprint_is_nyaterm_wire_form() {
        // SHA256:<lowercase hex>，64 位 hex 摘要。
        let fingerprint = certificate_fingerprint(b"der-bytes");
        assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
        assert_eq!(fingerprint.len(), "SHA256:".len() + 64);
        // 确定性：同输入同指纹。
        assert_eq!(certificate_fingerprint(b"der-bytes"), fingerprint);
        assert_ne!(certificate_fingerprint(b"other-der"), fingerprint);
    }

    #[tokio::test]
    async fn cert_broker_request_emits_and_resolves() {
        let broker = Arc::new(CertPromptBroker::new());
        // 先注册一个 prompt（后台任务持有请求端），再从 resolve 端应答。
        let request_task = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .request(
                        &test_emitter(),
                        "s1",
                        "h",
                        3389,
                        "SHA256:aa",
                        KnownCertStatus::Unknown,
                    )
                    .await
            }
        });
        // 等 prompt 注册完成。
        for _ in 0..50 {
            if !broker.pending.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // 找到刚注册的 challengeId（只有一个）。
        let challenge_id = {
            let pending = broker.pending.lock().unwrap();
            assert_eq!(pending.len(), 1);
            pending.keys().next().cloned().expect("one pending")
        };
        assert!(broker.pending.lock().unwrap().contains_key(&challenge_id));
        broker.resolve(&challenge_id, true, false).expect("resolve");
        let decision = request_task.await.expect("task").expect("decision");
        assert!(decision.accept);
        assert!(!decision.remember);
        assert!(!broker.pending.lock().unwrap().contains_key(&challenge_id));
        // 已解析后再 resolve 报错（一次性语义）。
        assert!(broker.resolve(&challenge_id, true, true).is_err());
    }

    #[tokio::test]
    async fn cert_broker_cancel_rejects_pending_prompts() {
        let broker = Arc::new(CertPromptBroker::new());
        let request_task = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .request(
                        &test_emitter(),
                        "s1",
                        "h",
                        3389,
                        "SHA256:aa",
                        KnownCertStatus::Unknown,
                    )
                    .await
            }
        });
        // 等 prompt 注册完成。
        for _ in 0..50 {
            if !broker.pending.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        broker.cancel_session("s1");
        // 取消 = 以 accept=false 应答（fail-closed），verify 端据此拒绝。
        let decision = request_task.await.expect("task").expect("decision");
        assert!(!decision.accept);
        assert!(!decision.remember);
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    fn test_emitter() -> PluginEmitter {
        let output: Arc<StdMutex<Box<dyn std::io::Write + Send>>> =
            Arc::new(StdMutex::new(Box::new(Vec::<u8>::new())));
        PluginEmitter::for_tests(output, dbx_plugin_sdk::PluginTransport::JsonLines)
    }

    // —— 剪贴板上限 ————————————————————————————————————————————

    #[test]
    fn clipboard_limit_rejects_oversized_text_whole() {
        assert!(validate_clipboard_text("").is_ok());
        assert!(validate_clipboard_text("hello").is_ok());
        assert!(validate_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT_BYTES)).is_ok());
        let error = validate_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))
            .expect_err("must reject oversized");
        assert!(error.contains("16 MiB"), "{error}");
    }

    #[test]
    fn clipboard_stage_holds_latest_text_only() {
        let stage = ClipboardStage::default();
        assert!(stage.text().is_none());
        stage.set_text("first".to_string());
        stage.set_text("second".to_string());
        assert_eq!(stage.text().as_deref(), Some("second"));
        stage.clear();
        assert!(stage.text().is_none());
    }

    // —— 帧封装（共享 44 字节 patch 头）————————————————————

    #[test]
    fn image_patch_matches_shared_frame_header() {
        // 与 vnc_session 的 44 字节头逐字段一致（RDP 引擎的 u32 0x00RRGGBB
        // 像素展开成 RGBA8888，alpha 恒 0xff）。
        let pixels = [0x0011_2233, 0x0044_5566, 0x0077_8899, 0x00aa_bbcc];
        let frame = image_patch_to_frame(&pixels, 1920, 1080, 10, 20, 2, 2, 9)
            .expect("valid patch should encode");
        assert_eq!(frame.len(), crate::vnc_session::FRAME_HEADER_BYTES + 16);
        assert_eq!(&frame[0..8], &9_u64.to_le_bytes());
        assert_eq!(&frame[8..12], &1920_u32.to_le_bytes());
        assert_eq!(&frame[12..16], &1080_u32.to_le_bytes());
        assert_eq!(&frame[16..20], &10_u32.to_le_bytes());
        assert_eq!(&frame[20..24], &20_u32.to_le_bytes());
        assert_eq!(&frame[24..28], &2_u32.to_le_bytes());
        assert_eq!(&frame[28..32], &2_u32.to_le_bytes());
        assert_eq!(&frame[32..36], &8_u32.to_le_bytes());
        assert_eq!(
            &frame[36..40],
            &crate::vnc_session::PIXEL_FORMAT_RGBA8888.to_le_bytes()
        );
        assert_eq!(&frame[40..44], &16_u32.to_le_bytes());
        assert_eq!(
            &frame[44..],
            &[
                0x11, 0x22, 0x33, 0xff, 0x44, 0x55, 0x66, 0xff, 0x77, 0x88, 0x99, 0xff, 0xaa, 0xbb,
                0xcc, 0xff
            ]
        );
    }

    #[test]
    fn image_patch_rejects_short_buffers_and_geometry_overflow() {
        // 引擎缓冲小于补丁：丢弃该帧而不是越界读。
        assert!(image_patch_to_frame(&[0], 10, 10, 0, 0, 2, 2, 1).is_err());
        // 补丁几何由 vnc 的 encode_frame_patch 复核（出界/零尺寸拒绝）。
        assert!(image_patch_to_frame(&[0; 4], 10, 10, 9, 0, 2, 2, 1).is_err());
        assert!(image_patch_to_frame(&[0; 16], 10, 10, 0, 0, 0, 2, 1).is_err());
    }

    #[test]
    fn replay_framebuffer_composites_incremental_patches_into_one_full_desktop() {
        let mut framebuffer = RdpReplayFramebuffer::new(4, 2).expect("framebuffer");
        framebuffer
            .apply_patch(&[0x00ff_0000, 0x0000_ff00], 4, 2, 0, 0, 2, 1)
            .expect("first patch");
        framebuffer
            .apply_patch(&[0x0000_00ff, 0x00ff_ffff], 4, 2, 2, 1, 2, 1)
            .expect("second patch");

        let frame = framebuffer.full_frame(42).expect("full replay frame");
        assert_eq!(&frame[0..8], &42_u64.to_le_bytes());
        assert_eq!(
            &frame[16..32],
            &[0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 2, 0, 0, 0]
        );
        assert_eq!(&frame[44..52], &[0xff, 0, 0, 0xff, 0, 0xff, 0, 0xff]);
        assert_eq!(
            &frame[44 + 24..44 + 32],
            &[0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
        );
    }

    #[test]
    fn replay_framebuffer_accepts_4k_within_the_explicit_byte_budget() {
        let framebuffer = RdpReplayFramebuffer::new(MAX_DESKTOP_WIDTH, MAX_DESKTOP_HEIGHT)
            .expect("4K framebuffer stays within the replay budget");
        assert_eq!(framebuffer.byte_len(), RDP_REPLAY_FRAMEBUFFER_MAX_BYTES);
        assert!(framebuffer.byte_len() <= RDP_REPLAY_FRAMEBUFFER_MAX_BYTES);
    }

    #[test]
    fn replay_framebuffer_rejects_invalid_patches_and_can_be_cleared() {
        let mut framebuffer = RdpReplayFramebuffer::new(2, 2).expect("framebuffer");
        assert!(framebuffer.apply_patch(&[0], 2, 2, 1, 1, 2, 1).is_err());
        framebuffer.clear();
        assert_eq!(framebuffer.byte_len(), 0);
        assert!(framebuffer.full_frame(1).is_err());
    }

    // —— 输入映射（NyaTerm 对齐）———————————————————————————

    #[test]
    fn input_events_decode_from_the_documented_shapes() {
        let key: RdpWireInput = serde_json::from_value(serde_json::json!({
            "kind": "key-down", "scanCode": 29, "extended": false
        }))
        .expect("key-down");
        assert!(matches!(
            key,
            RdpWireInput::KeyDown {
                scan_code: 29,
                extended: false
            }
        ));
        // NyaTerm 兼容 camelCase delta 别名。
        let wheel: RdpWireInput = serde_json::from_value(serde_json::json!({
            "kind": "mouse-wheel", "deltaX": 1.0, "deltaY": -2.0, "x": 10, "y": 20
        }))
        .expect("wheel");
        assert!(
            matches!(wheel, RdpWireInput::MouseWheel { delta_x, .. } if (delta_x - 1.0).abs() < f64::EPSILON)
        );
        // 未知 kind 拒绝。
        assert!(
            serde_json::from_value::<RdpWireInput>(serde_json::json!({ "kind": "drag" })).is_err()
        );
        // 完整请求（camelCase sessionId + flatten input）。
        let request: RdpInputRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s1", "kind": "mouse-move", "x": 1, "y": 2
        }))
        .expect("request");
        assert_eq!(request.session_id, "s1");
    }

    #[test]
    fn right_shift_uses_direct_fast_path() {
        let action = wire_input_to_action(RdpWireInput::KeyDown {
            scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
            extended: false,
        })
        .expect("mapped");
        assert!(matches!(
            action,
            InputAction::FastPath(IronRdpFastPathInputEvent::KeyboardEvent(flags, code))
                if flags == IronRdpKeyboardFlags::empty() && code == RDP_RIGHT_SHIFT_SCAN_CODE
        ));
        let action = wire_input_to_action(RdpWireInput::KeyUp {
            scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
            extended: false,
        })
        .expect("mapped");
        assert!(matches!(
            action,
            InputAction::FastPath(IronRdpFastPathInputEvent::KeyboardEvent(flags, code))
                if flags == IronRdpKeyboardFlags::RELEASE && code == RDP_RIGHT_SHIFT_SCAN_CODE
        ));
        // 扩展位上的 0x36 不是右 Shift（照走数据库路径）。
        let action = wire_input_to_action(RdpWireInput::KeyDown {
            scan_code: RDP_RIGHT_SHIFT_SCAN_CODE,
            extended: true,
        })
        .expect("mapped");
        assert!(matches!(action, InputAction::Operations(_)));
    }

    #[test]
    fn wheel_deltas_are_inverted_into_rotation_units() {
        let action = wire_input_to_action(RdpWireInput::MouseWheel {
            delta_x: 3.0,
            delta_y: 120.0,
            x: 10,
            y: 20,
        })
        .expect("mapped");
        let InputAction::Operations(operations) = action else {
            panic!("expected operations");
        };
        assert!(matches!(
            operations.first(),
            Some(IronRdpInputOperation::MouseMove(_))
        ));
        let horizontal = operations.iter().find_map(|operation| match operation {
            IronRdpInputOperation::WheelRotations(rotations) if !rotations.is_vertical => {
                Some(rotations.rotation_units)
            }
            _ => None,
        });
        let vertical = operations.iter().find_map(|operation| match operation {
            IronRdpInputOperation::WheelRotations(rotations) if rotations.is_vertical => {
                Some(rotations.rotation_units)
            }
            _ => None,
        });
        assert_eq!(horizontal, Some(-3));
        assert_eq!(vertical, Some(-120));
    }

    #[test]
    fn unicode_input_presses_and_releases_each_char() {
        let action = wire_input_to_action(RdpWireInput::Unicode {
            text: "ab".to_string(),
        })
        .expect("mapped");
        let InputAction::Operations(operations) = action else {
            panic!("expected operations");
        };
        assert_eq!(operations.len(), 4);
        assert!(matches!(
            operations[0],
            IronRdpInputOperation::UnicodeKeyPressed('a')
        ));
        assert!(matches!(
            operations[1],
            IronRdpInputOperation::UnicodeKeyReleased('a')
        ));
    }

    #[test]
    fn mouse_buttons_map_wire_names_and_unknown_buttons_are_dropped() {
        let action = wire_input_to_action(RdpWireInput::MouseButton {
            button: "right".to_string(),
            pressed: true,
            x: 1,
            y: 2,
        })
        .expect("mapped");
        let InputAction::Operations(operations) = action else {
            panic!("expected operations");
        };
        assert!(matches!(
            operations[1],
            IronRdpInputOperation::MouseButtonPressed(IronRdpMouseButton::Right)
        ));
        let action = wire_input_to_action(RdpWireInput::MouseButton {
            button: "side".to_string(),
            pressed: true,
            x: 1,
            y: 2,
        })
        .expect("mapped");
        let InputAction::Operations(operations) = action else {
            panic!("expected operations");
        };
        assert!(operations.is_empty());
    }

    #[test]
    fn release_all_maps_to_database_release() {
        // ReleaseAll → None → send_wire_input 走 database.release_all()。
        assert!(wire_input_to_action(RdpWireInput::ReleaseAll).is_none());
    }

    #[test]
    fn input_database_roundtrip_keeps_key_state_consistent() {
        // key-down + key-up 经数据库路径各产出 fast-path 键盘事件。
        let mut database = IronRdpInputDatabase::new();
        let down = apply_wire_input(
            &mut database,
            RdpWireInput::KeyDown {
                scan_code: 0x2a,
                extended: false,
            },
        );
        assert_eq!(down.len(), 1);
        let up = apply_wire_input(
            &mut database,
            RdpWireInput::KeyUp {
                scan_code: 0x2a,
                extended: false,
            },
        );
        assert_eq!(up.len(), 1);
        // ReleaseAll 之后的下一次输入照常（状态已清空）。
        let released = apply_wire_input(&mut database, RdpWireInput::ReleaseAll);
        assert!(released.is_empty());
    }

    fn apply_wire_input(
        database: &mut IronRdpInputDatabase,
        input: RdpWireInput,
    ) -> SmallVec<[IronRdpFastPathInputEvent; 2]> {
        match wire_input_to_action(input) {
            Some(InputAction::Operations(operations)) => database.apply(operations),
            Some(InputAction::FastPath(event)) => smallvec::smallvec![event],
            None => database.release_all(),
        }
    }

    // —— 资源上界常量（契约钉在断言上）——————————————————————

    #[test]
    fn bounds_are_pinned() {
        assert_eq!(MAX_CLIPBOARD_TEXT_BYTES, 16 * 1024 * 1024);
        assert_eq!(CLIPBOARD_CHUNK_JSON_BUDGET, 7 * 1024 * 1024);
        assert_eq!(MAX_UNICODE_TEXT_CHARS, 4096);
        assert_eq!(MAX_HOST_LEN, 255);
        assert_eq!(MAX_USERNAME_LEN, 128);
        assert_eq!(MAX_DOMAIN_LEN, 128);
        assert_eq!(KNOWN_CERTS_MAX_ENTRIES, 1024);
        assert_eq!(MAX_TOTAL_RECONNECTS, 50);
        assert_eq!(DEFAULT_RECONNECT_ATTEMPTS, 5);
        assert_eq!(MAX_RECONNECT_ATTEMPTS, 10);
        assert_eq!(CERTIFICATE_PROMPT_TIMEOUT, Duration::from_secs(120));
        assert_eq!(COMMAND_CHANNEL_CAPACITY, 256);
        assert_eq!(MAX_DESKTOP_WIDTH, 3840);
        assert_eq!(MAX_DESKTOP_HEIGHT, 2160);
    }

    // —— C1：入站剪贴板入口长度门（vendored 层缓解）————————————————

    #[test]
    fn clipboard_payload_gate_rejects_before_decode() {
        // 入口门：原始载荷超限在 UTF-16 → String 物化之前拒绝。
        assert!(validate_clipboard_payload_len(0).is_ok());
        assert!(validate_clipboard_payload_len(MAX_CLIPBOARD_TEXT_BYTES).is_ok());
        let error = validate_clipboard_payload_len(MAX_CLIPBOARD_TEXT_BYTES + 1)
            .expect_err("must reject oversized raw payload");
        assert!(error.contains("16 MiB"), "{error}");
    }

    // —— C2：剪贴板事件分片 ————————————————————————————————————————

    #[test]
    fn clipboard_chunks_keeps_fitting_text_whole() {
        let text = "hello".to_string();
        assert_eq!(clipboard_chunks(&text), vec!["hello"]);
        // 恰好压线：7 MiB 纯 ASCII 单事件。
        let text = "x".repeat(CLIPBOARD_CHUNK_JSON_BUDGET);
        assert_eq!(clipboard_chunks(&text).len(), 1);
    }

    #[test]
    fn clipboard_chunks_splits_oversized_text_and_reassembles() {
        // 10 MiB 纯 ASCII：JSON 事件必然超 SDK 8 MiB，必须分片。
        let text = "x".repeat(10 * 1024 * 1024);
        let chunks = clipboard_chunks(&text);
        assert!(chunks.len() > 1, "expected multiple chunks");
        for chunk in &chunks {
            assert!(
                json_escaped_len(chunk) <= CLIPBOARD_CHUNK_JSON_BUDGET,
                "chunk exceeds the event budget"
            );
        }
        let reassembled: String = chunks.concat();
        assert_eq!(reassembled, text);
    }

    #[test]
    fn clipboard_chunks_accounts_for_json_escape_inflation() {
        // 2 MiB 制表符：原始字节 < 7 MiB，但 JSON 转义后 12 MiB > 8 MiB ——
        // 同样必须分片（否则仍被 SDK 静默丢弃）。
        let text = "\t".repeat(2 * 1024 * 1024);
        let chunks = clipboard_chunks(&text);
        assert!(chunks.len() > 1, "control chars inflate 6x and must split");
        for chunk in &chunks {
            assert!(
                json_escaped_len(chunk) <= CLIPBOARD_CHUNK_JSON_BUDGET,
                "chunk exceeds the event budget"
            );
        }
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn clipboard_chunks_never_splits_a_multibyte_char() {
        // 多字节字符只能整体进某一分片（char boundary 切分）。
        let text = "é".repeat(4 * 1024 * 1024); // 2 bytes each → 8 MiB
        let chunks = clipboard_chunks(&text);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().all(|c| c == 'é'));
        }
        assert_eq!(chunks.concat(), text);
    }

    // —— D3：重连累计总预算状态机 ————————————————————————————————————

    #[test]
    fn reconnect_budget_resets_ladder_but_never_total_on_active() {
        let mut budget = ReconnectBudget::new();
        // 非活动失败：梯子 5 步耗尽（NyaTerm 默认）。
        for _ in 0..5 {
            assert!(budget.allows(5, true));
            budget.charge();
        }
        assert!(!budget.allows(5, true), "ladder must exhaust at 5");
        // 活动成功重置梯子步长——但总预算不重置（D3：恶意服务器不能靠
        // active-后-传输错误循环把客户端变成无限重拨机）。
        budget.on_active_generation();
        assert!(budget.allows(5, true), "ladder step reset on active");
        // 继续循环：total 只增不减，第 50 次重连后总预算耗尽。
        for _ in 0..(MAX_TOTAL_RECONNECTS - 5 - 1) {
            budget.charge();
            budget.on_active_generation();
            assert!(budget.allows(5, true));
        }
        budget.charge();
        budget.on_active_generation();
        assert!(
            !budget.allows(5, true),
            "cumulative budget must close the gate at {MAX_TOTAL_RECONNECTS}"
        );
    }

    #[test]
    fn reconnect_budget_gate_closes_on_non_retryable_failures() {
        let mut budget = ReconnectBudget::new();
        assert!(!budget.allows(5, false), "non-retryable never reconnects");
        budget.charge();
        assert!(!budget.allows(5, false));
    }

    // —— E5：输入面上界 ————————————————————————————————————————————

    #[test]
    fn scan_code_above_u8_is_rejected_not_truncated() {
        // 0x136 是报告点名的截断码点（截断后恰为 0x36 右 Shift）：必须整体
        // 拒绝而不是静默截断。
        assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
            "kind": "key-down", "scanCode": 0x136
        }))
        .is_err());
        assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
            "kind": "key-up", "scanCode": 256
        }))
        .is_err());
        // u8 范围内的合法值照常。
        assert!(serde_json::from_value::<RdpWireInput>(serde_json::json!({
            "kind": "key-down", "scanCode": 255
        }))
        .is_ok());
    }

    #[tokio::test]
    async fn unicode_input_over_the_char_limit_is_rejected() {
        let runtime = RdpSessionRuntime::new();
        let oversized = "a".repeat(MAX_UNICODE_TEXT_CHARS + 1);
        let error = runtime
            .input("s1", RdpWireInput::Unicode { text: oversized })
            .await
            .expect_err("must reject oversized unicode text");
        assert!(error.contains("character limit"), "{error}");
        // 恰好 4096 字符：上限校验通过（错误变为“会话不存在”）。
        let at_limit = "a".repeat(MAX_UNICODE_TEXT_CHARS);
        let error = runtime
            .input("s1", RdpWireInput::Unicode { text: at_limit })
            .await
            .expect_err("session lookup still fails");
        assert!(error.contains("not found"), "{error}");
    }

    // —— B4：known-certs 写盘并发安全 + 插入序淘汰 ——————————————————

    #[test]
    fn prune_oldest_entries_drops_the_genuinely_oldest() {
        let mut store = HashMap::new();
        for (key, inserted_at) in [("a", 30_u64), ("b", 10), ("c", 20), ("d", 10)] {
            store.insert(
                key.to_string(),
                KnownCertEntry {
                    fingerprint: format!("SHA256:{key}"),
                    inserted_at,
                },
            );
        }
        prune_oldest_entries(&mut store, 2);
        assert_eq!(store.len(), 2);
        // 最旧的 2 条按 inserted_at 淘汰：b/d 同秒并列（10），按 key 字典序
        // b 先走，随后 d；a(30)/c(20) 保留。
        assert!(!store.contains_key("b"), "oldest tie (b) must go first");
        assert!(!store.contains_key("d"));
        assert!(store.contains_key("a"));
        assert!(store.contains_key("c"));
    }

    #[test]
    fn known_cert_store_loads_legacy_flat_shape() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let store = KnownCertStore::new(data_dir.path());
        std::fs::write(&store.path, r#"{"rdp.local:3389":"SHA256:legacy"}"#)
            .expect("write v1 shape");
        assert_eq!(
            store.check("rdp.local", 3389, "SHA256:legacy"),
            KnownCertStatus::Match
        );
        // 迁移写盘后再读仍是 V2 信封。
        store
            .remember_at("other.local", 3389, "SHA256:new", 42)
            .expect("remember");
        let text = std::fs::read_to_string(&store.path).expect("read");
        assert!(text.contains("\"entries\""), "{text}");
        assert_eq!(
            store.check("rdp.local", 3389, "SHA256:legacy"),
            KnownCertStatus::Match
        );
    }

    #[test]
    fn known_cert_store_evicts_by_insertion_order() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let store = KnownCertStore::new(data_dir.path());
        store.remember_at("old.local", 3389, "SHA256:old", 1).ok();
        store
            .remember_at("new.local", 3389, "SHA256:new", 2)
            .expect("remember");
        // 压到淘汰线上：最旧（inserted_at=1）必须先走，与 key 字典序无关
        //（"old.local" 的字典序反而最小——旧实现会先淘汰它）。
        for index in 0..KNOWN_CERTS_MAX_ENTRIES {
            store
                .remember_at(
                    &format!("host{index}.local"),
                    3389,
                    &format!("SHA256:{index:04}"),
                    100 + index as u64,
                )
                .expect("remember");
        }
        assert_eq!(
            store.check("old.local", 3389, "SHA256:old"),
            KnownCertStatus::Unknown,
            "the genuinely oldest entry must be evicted first"
        );
        assert_eq!(
            store.check("new.local", 3389, "SHA256:new"),
            KnownCertStatus::Unknown,
            "second-oldest goes next — by insertion time, not key order"
        );
        let entries = store.load_entries();
        assert_eq!(entries.len(), KNOWN_CERTS_MAX_ENTRIES);
    }

    #[test]
    fn known_cert_store_concurrent_remembers_leave_valid_file() {
        // B4 TOCTOU：每个 remember 用唯一 tmp 名，并发写不再互相覆盖中间态
        //（残留窗口：最后 rename 者整体胜出，最坏丢一条 → 重新 prompt，
        // fail-closed）。
        let data_dir = std::sync::Arc::new(tempfile::tempdir().expect("tempdir"));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = KnownCertStore::new(data_dir.path());
                std::thread::spawn(move || {
                    store.remember_at(
                        &format!("host{index}.local"),
                        3389,
                        &format!("SHA256:{index:02}"),
                        index as u64,
                    )
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("thread").expect("remember");
        }
        // 产物必须是合法 JSON（坏中间态会让整个 store 变空 → 全部遗忘）。
        let store = KnownCertStore::new(data_dir.path());
        let entries = store.load_entries();
        assert!(
            !entries.is_empty(),
            "concurrent writes must not corrupt the store"
        );
        // 无残留 tmp 文件（全部被 rename 掉）。
        let leftovers: Vec<_> = std::fs::read_dir(data_dir.path())
            .expect("dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.ends_with(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn cert_key_is_case_insensitive() {
        // B4 次要：`RDP.local` 与 `rdp.local` 必须是同一条目，否则大小写
        // 翻转导致重复 prompt（fail-closed 但烦人）。
        assert_eq!(cert_key("RDP.local", 3389), cert_key("rdp.local", 3389));
        let mut store = HashMap::new();
        store.insert(cert_key("RDP.local", 3389), "SHA256:aa".to_string());
        assert_eq!(
            known_cert_status(&store, "rdp.local", 3389, "SHA256:aa"),
            KnownCertStatus::Match
        );
    }

    // —— B6：start 请求脱敏 + wire 身份上界 ————————————————————————

    #[test]
    fn start_request_debug_redacts_the_password() {
        let request: RdpStartRequest = serde_json::from_value(serde_json::json!({
            "workbenchId": "w1", "host": "rdp.local", "username": "admin",
            "password": "hunter2"
        }))
        .expect("parse");
        let rendered = format!("{request:?}");
        assert!(rendered.contains("<set>"), "{rendered}");
        assert!(!rendered.contains("hunter2"), "{rendered}");
        let request: RdpStartRequest = serde_json::from_value(serde_json::json!({
            "workbenchId": "w1", "host": "rdp.local", "username": "admin"
        }))
        .expect("parse");
        assert!(format!("{request:?}").contains("None"));
    }

    #[tokio::test]
    async fn start_rejects_oversized_wire_identities() {
        let runtime = RdpSessionRuntime::new();
        let data_dir = tempfile::tempdir().expect("tempdir");
        let build = |host: String, username: String, domain: Option<String>| RdpStartRequest {
            workbench_id: "w1".to_string(),
            host,
            port: Some(3389),
            username,
            password: None,
            domain,
            width: None,
            height: None,
            use_nla: None,
            certificate_policy: None,
            clipboard: None,
            reconnect_attempts: None,
        };
        // host 256 字节（含 1 字节 trim 后仍超）。
        let error = runtime
            .start(
                build("a".repeat(MAX_HOST_LEN + 1), "user".into(), None),
                test_emitter(),
                data_dir.path(),
            )
            .await
            .expect_err("oversized host");
        assert!(error.contains("host exceeds"), "{error}");
        // username 129 字符。
        let error = runtime
            .start(
                build("rdp.local".into(), "u".repeat(MAX_USERNAME_LEN + 1), None),
                test_emitter(),
                data_dir.path(),
            )
            .await
            .expect_err("oversized username");
        assert!(error.contains("username exceeds"), "{error}");
        // domain 129 字符。
        let error = runtime
            .start(
                build(
                    "rdp.local".into(),
                    "user".into(),
                    Some("d".repeat(MAX_DOMAIN_LEN + 1)),
                ),
                test_emitter(),
                data_dir.path(),
            )
            .await
            .expect_err("oversized domain");
        assert!(error.contains("domain exceeds"), "{error}");
    }

    // —— vendored 链红线（NTLMv1/LM 不可用、连接器默认 NTLM）———————

    #[test]
    fn vendored_sspi_marks_ntlmv1_and_lm_as_unsupported() {
        // 清单 §3-A【硬】禁 NTLMv1/LM：vendored sspi 源码明示二者不受支持
        // （fail-closed by construction）。源码文本断言把该事实钉在测试上，
        // vendored 链升级漂移时立即失败。
        let ntlm = include_str!("../vendor/sspi/src/ntlm/mod.rs");
        assert!(
            ntlm.contains("NTLMv1 Session Security, deprecated, insecure and not supported by us")
        );
        assert!(ntlm.contains("LM Session Security, deprecated, insecure and not supported by us"));
        // 连接器默认走 ClientMode::Ntlm（本模块不构造 Kerberos 配置，
        // Kerberos 属范围外）。
        let credssp = include_str!("../vendor/ironrdp-connector/src/credssp.rs");
        assert!(credssp.contains("ClientMode::Ntlm(sspi::ntlm::NtlmConfig::default())"));
    }

    // —— 客户端标识 ————————————————————————————————————————————

    #[test]
    fn client_build_encodes_the_package_version() {
        assert_eq!(client_build(), 700); // 0.7.0
    }

    #[test]
    fn client_name_falls_back_without_hostname() {
        // 仅验证不 panic 且非空（环境变量在本机存在与否不定）。
        assert!(!client_name().is_empty());
    }
}
