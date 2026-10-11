//! RDP RPC 线制类型（rdp/start、rdp/input、rdp/resize 的请求形状）与
//! 请求调试脱敏（Debug impl 只出 `<set>`/`None`，凭据不落日志）。
use serde::Deserialize;

/// Wire identity bounds (B6/F6, rdp-security-review): DNS hostname cap plus
/// reasonable identity caps. Rejected at start, never truncated.
pub(crate) const MAX_HOST_LEN: usize = 255;
pub(crate) const MAX_USERNAME_LEN: usize = 128;
pub(crate) const MAX_DOMAIN_LEN: usize = 128;
/// Unicode text input bound per `rdp/input` command (E5a,
/// rdp-security-review): each character expands into a press+release
/// operation pair, so unbounded text would materialize an unbounded
/// operation list. Rejected whole, never truncated.
pub(crate) const MAX_UNICODE_TEXT_CHARS: usize = 4096;

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
    /// Owning plugin connection (lifecycle identity). The start merge uses it
    /// to pull the connection form's saved password — the webview never sees
    /// credentials, so it cannot pass them here itself.
    pub connection_id: Option<String>,
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
