//! 错误分类与重连门控：连接器/会话错误文本 → errorKind + retryable，
//! 认证类失败绝不重试；退避梯子与累计预算（D3，rdp-security-review）。
use super::session::MAX_TOTAL_RECONNECTS;
use std::time::Duration;

/// transport-class failures.
/// Reconnect gating state for one worker loop (D3, rdp-security-review;
/// pure — unit-tested). The ladder step resets when a generation reached an
/// active frame, but the cumulative total never does: a hostile server
/// cannot loop the client forever by alternating one active frame with
/// transport-class failures.
pub(crate) struct ReconnectBudget {
    pub(crate) attempt: u32,
    total: u32,
}

impl ReconnectBudget {
    pub(crate) fn new() -> Self {
        Self {
            attempt: 0,
            total: 0,
        }
    }

    /// The generation had been fully active: fresh backoff ladder (NyaTerm
    /// resets the attempt counter on the first active frame), budget kept.
    pub(crate) fn on_active_generation(&mut self) {
        self.attempt = 0;
    }

    /// Charge one automatic reconnect against both the ladder and the total.
    pub(crate) fn charge(&mut self) {
        self.attempt += 1;
        self.total += 1;
    }

    /// May another automatic reconnect start?
    pub(crate) fn allows(&self, max_attempts: u32, retryable: bool) -> bool {
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
pub(crate) enum GenerationEnd {
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
    pub(crate) fn as_str(self) -> &'static str {
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
