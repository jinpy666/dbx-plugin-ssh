//! Remote command execution with Quick Sudo support, ported from the
//! tiny-rdm auth-orchestration pipeline: `sudo -S` password injection over
//! stdin plus automatic follow-up answers for 2FA/TOTP prompts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data_encoding::{BASE32, HEXLOWER};
use hmac::{Hmac, Mac};
use russh::client::Handle;
use russh::ChannelMsg;
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};

use crate::ssh::SshClient;

pub const SUDO_EXEC_TIMEOUT: Duration = Duration::from_secs(90);
pub const PLAIN_EXEC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_AUTH_ROUNDS: u32 = 3;

const PASSWORD_PROMPT_PATTERS: &[&str] = &[
    "password:",
    "passphrase:",
    "pass phrase",
    "[sudo] password for",
    "密码:",
    "密码：",
];

const TOTP_PROMPT_PATTERS: &[&str] = &[
    "verification code",
    "verification code:",
    "otp:",
    // JumpServer 堡垒机（koko）的 MFA 提问：[OTP Code]: / [RADIUS Code]:，
    // 指令行 "Please Enter MFA Code."（见 koko pkg/auth/mfa_option.go）。
    "otp code",
    "mfa code",
    "mfa:",
    "totp:",
    "2fa code",
    "one-time password",
    "one time password",
    "authentication code",
    "动态密码",
    "验证码",
    "一次性密码",
];

const AUTH_FAILURE_MARKERS: &[&str] = &[
    "sorry, try again",
    "authentication failure",
    "incorrect password",
];

/// Wraps a command in `sh -c '…'` with POSIX single-quote escaping so sudo
/// receives one argument and metacharacters cannot escape the quoting.
pub fn sanitize_sudo_command(command: &str) -> String {
    let escaped = command.replace('\'', r"'\''");
    format!("sh -c '{escaped}'")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// 变体名刻意与协议值一一对应（off / password_only / password_plus_otp /
// password_then_otp），共享的 Password 前缀是契约不是冗余。
#[allow(clippy::enum_variant_names)]
pub enum AuthFlowMode {
    /// 2FA 自动应答关闭（0.4.77 起连接表单默认值）：密码类提示照常应答，
    /// OTP/组合提示永不自动回码。存量连接缺省该字段时仍走 PasswordThenOtp，
    /// 运行时语义不受新默认值影响。
    Off,
    PasswordOnly,
    PasswordPlusOtp,
    PasswordThenOtp,
}

impl AuthFlowMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" | "disabled" => Self::Off,
            "password" | "password_only" => Self::PasswordOnly,
            "password+otp" | "password_totp" | "password_plus_otp" => Self::PasswordPlusOtp,
            _ => Self::PasswordThenOtp,
        }
    }

    /// Canonical protocol name (as stored in Quick Sudo profiles and
    /// reported by `ssh/settings/get`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::PasswordOnly => "password_only",
            Self::PasswordPlusOtp => "password_plus_otp",
            Self::PasswordThenOtp => "password_then_otp",
        }
    }

    fn allows_otp_after_password(self) -> bool {
        match self {
            Self::Off => false,
            Self::PasswordOnly => false,
            Self::PasswordPlusOtp => true,
            Self::PasswordThenOtp => true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PromptKind {
    Password,
    Totp,
    Combined,
}

#[derive(Debug, Clone)]
pub enum TotpSecret {
    /// RFC 6238 shared secret with parameters.
    Key {
        key: Vec<u8>,
        digits: u32,
        period: u64,
        algorithm: TotpAlgorithm,
    },
    /// Static numeric code (4-10 digits) that is not time-based.
    Static(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TotpAlgorithm {
    Sha1,
    Sha256,
    Sha512,
}

/// Quick Sudo orchestration settings resolved from a stored connection.
/// Shared behind an `Arc<RwLock<…>>` so runtime settings updates apply to
/// running terminals and exec calls immediately, mirroring tiny-rdm's
/// per-output `resolveAuthOrchestrationForProfile` lookups.
#[derive(Debug, Clone, Default)]
pub struct SudoAuth {
    /// Password piped to `sudo -S`; falls back to the login password.
    pub password: String,
    /// One or more TOTP secrets (newline/semicolon separated in the source
    /// field); rotating OTP selection prefers unused codes with the longest
    /// remaining validity, exactly like tiny-rdm's resolveRotatingOTP.
    /// Usage/committed state lives in the process-global OTP ledgers (see
    /// [`otp_usage_ledger`] / [`committed_otp_ledger`]) so it outlives this
    /// instance.
    pub totp_secrets: Vec<TotpSecret>,
    /// Ledger scope for OTP usage/committed marks (see
    /// [`otp_usage_ledger`] / [`committed_otp_ledger`]): identifies the
    /// credential consumer as `user@host:port` so two connections sharing
    /// one secret do not swallow each other's codes — a code burned on
    /// server A must still be submittable on server B within the same
    /// window. Set by the credential-resolution sites; empty = unscoped
    /// (tests).
    pub otp_ledger_scope: String,
    pub password_prompt_hint: String,
    pub totp_prompt_hint: String,
    pub flow_mode: Option<AuthFlowMode>,
}

impl SudoAuth {
    pub fn new(sudo_password: &str, login_password: &str, totp_secret: &str, hints: Hints) -> Self {
        let password = if sudo_password.trim().is_empty() {
            login_password.to_string()
        } else {
            sudo_password.trim().to_string()
        };
        Self {
            password,
            totp_secrets: parse_totp_secrets(totp_secret),
            password_prompt_hint: hints.password,
            totp_prompt_hint: hints.totp,
            flow_mode: hints.flow_mode,
            ..Default::default()
        }
    }

    pub fn totp_configured(&self) -> bool {
        !self.totp_secrets.is_empty()
    }

    /// True when the auth can answer something (a sudo password or a TOTP
    /// secret); drives whether the in-terminal watcher is attached. With the
    /// flow mode off, a TOTP secret alone answers nothing, so it no longer
    /// justifies arming the watcher.
    pub fn useful(&self) -> bool {
        !self.password.is_empty()
            || (self.totp_configured() && self.flow_mode() != AuthFlowMode::Off)
    }

    fn flow_mode(&self) -> AuthFlowMode {
        self.flow_mode.unwrap_or(AuthFlowMode::PasswordThenOtp)
    }

    fn classify(&self, prompt: &str) -> Option<PromptKind> {
        classify_auth_prompt(prompt, self)
    }

    /// Returns the answer to send for a detected prompt, if one is configured.
    /// OTP answers go through [`Self::take_totp_answer`], so a code that was
    /// already submitted within its replay window is skipped (with a log)
    /// instead of being injected twice.
    pub(crate) fn answer_for(&self, kind: PromptKind) -> Option<String> {
        match kind {
            PromptKind::Password => (!self.password.is_empty()).then(|| self.password.clone()),
            // Flow off: the OTP secret is never spent on prompts (manual 2FA).
            PromptKind::Totp => {
                if self.flow_mode() == AuthFlowMode::Off {
                    None
                } else {
                    self.totp_answer_logged()
                }
            }
            PromptKind::Combined => {
                let password = (!self.password.is_empty()).then(|| self.password.clone())?;
                if self.flow_mode() == AuthFlowMode::PasswordPlusOtp {
                    let code = self.totp_answer_logged()?;
                    Some(format!("{password}{code}"))
                } else {
                    Some(password)
                }
            }
        }
    }

    /// Resolves the OTP answer for a prompt, logging (and skipping) when the
    /// only available code was already committed inside its replay window.
    fn totp_answer_logged(&self) -> Option<String> {
        match self.take_totp_answer() {
            Ok(code) => Some(code),
            Err(reason) => {
                eprintln!("[ssh] otp auto-answer skipped: {reason}");
                None
            }
        }
    }

    /// [`Self::answer_for`] 的终端 watcher 变体：OTP 承载型回答（Totp，以及
    /// password_plus_otp 的 Combined）在"唯一可用码已提交且重放窗口未关"时
    /// 返回 `(None, Some(下次可答时刻))`，由调用方推迟到下一个窗口重试；
    /// 其余情形与 `answer_for` 完全一致（永不推迟）。静态恢复码不变，
    /// 重试无意义，同样不推迟。
    pub(crate) fn answer_for_with_retry(&self, kind: PromptKind) -> (Option<String>, Option<u64>) {
        let otp_bearing = self.flow_mode() != AuthFlowMode::Off
            && (matches!(kind, PromptKind::Totp)
                || (kind == PromptKind::Combined
                    && self.flow_mode() == AuthFlowMode::PasswordPlusOtp));
        if !otp_bearing {
            return (self.answer_for(kind), None);
        }
        match self.take_totp_answer() {
            Ok(code) => {
                let answer = if kind == PromptKind::Combined {
                    format!("{}{code}", self.password)
                } else {
                    code
                };
                (Some(answer), None)
            }
            Err(reason) => {
                eprintln!("[ssh] otp auto-answer deferred: {reason}");
                (None, self.otp_retry_boundary())
            }
        }
    }

    /// 下一个 TOTP 窗口边界（+1s 余量）：此刻之后 `take_totp_answer` 会选中
    /// 全新窗口的码。仅当存在轮转密钥时才有意义；纯静态密钥返回 None。
    fn otp_retry_boundary(&self) -> Option<u64> {
        let now = unix_now();
        let period = self
            .totp_secrets
            .iter()
            .filter_map(|secret| match secret {
                TotpSecret::Key { period, .. } => Some(*period),
                TotpSecret::Static(_) => None,
            })
            .min()?;
        Some((now / period + 1) * period + 1)
    }

    /// Picks the code to auto-submit for an OTP prompt, or explains why the
    /// submission must be skipped: a code that was already injected while its
    /// acceptance window (±1 step) is still open must not be replayed
    /// (tiny-rdm's isOTPUsageMarked semantics, hardened to a hard skip). The
    /// chosen code is marked committed on return, so later prompts in the
    /// same window are skipped instead of re-submitting it.
    pub(crate) fn take_totp_answer(&self) -> Result<String, String> {
        let now = unix_now();
        let selection = self
            .current_totp_selection()
            .ok_or_else(|| "no TOTP secret is configured or currently valid".to_string())?;
        let mut committed = committed_otp_ledger()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        committed.retain(|_, until| is_totp_in_replay_window(now, *until));
        let key = format!(
            "{}|{}|{}",
            self.otp_ledger_scope, selection.fingerprint, selection.code
        );
        if let Some(until) = committed.get(&key).copied() {
            return Err(format!(
                "code {} was already submitted and its replay window (±1 step) stays open for {}s",
                selection.code,
                until.saturating_sub(now)
            ));
        }
        committed.insert(
            key,
            totp_replay_window_expiry(selection.valid_until, selection.period),
        );
        Ok(selection.code)
    }

    /// Picks the OTP code to use right now across all configured secrets,
    /// sorted like tiny-rdm's resolveRotatingOTP: unused codes first, then
    /// longest remaining validity, configured order as the stable tie-break;
    /// when every candidate is used the best code is still returned as a
    /// fallback (the replay guard in [`Self::take_totp_answer`] decides
    /// whether it may actually go out). Selections are marked in the
    /// process-global usage ledger until their window expires, so
    /// back-to-back MCP exec calls — each resolving a fresh `SudoAuth` —
    /// keep rotating to an unused secret instead of resubmitting the first
    /// secret's code.
    fn current_totp_selection(&self) -> Option<TotpSelection> {
        let now = unix_now();
        // Scope marks to this auth's credential consumer so the rotation
        // ledger is shared across calls/sessions for the same target while
        // distinct targets (which validate codes independently) never
        // interfere.
        let scope = self.otp_ledger_scope.as_str();
        let mut usage = otp_usage_ledger()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        usage.retain(|_, valid_until| *valid_until > now);

        struct Candidate {
            fingerprint: String,
            code: String,
            valid_until: u64,
            period: u64,
            remaining: u64,
            usage_key: String,
            used: bool,
        }
        let mut candidates: Vec<Candidate> = self
            .totp_secrets
            .iter()
            .map(|secret| {
                let fingerprint = otp_secret_fingerprint(secret);
                match secret {
                    TotpSecret::Static(code) => {
                        let valid_until = now.saturating_add(OTP_STATIC_WINDOW);
                        // Static codes carry no aligned window: keying usage
                        // on the fingerprint alone keeps marks stable across
                        // calls whose `now + window` boundary moved.
                        Candidate {
                            usage_key: format!("{scope}|{fingerprint}|{code}"),
                            fingerprint,
                            code: code.clone(),
                            valid_until,
                            period: OTP_STATIC_WINDOW,
                            remaining: OTP_STATIC_WINDOW,
                            used: false,
                        }
                    }
                    TotpSecret::Key {
                        key,
                        digits,
                        period,
                        algorithm,
                    } => {
                        let counter = now / period;
                        let valid_until = (counter + 1) * period;
                        let code = hotp(key, counter, *digits, *algorithm);
                        Candidate {
                            usage_key: format!("{scope}|{fingerprint}|{valid_until}|{code}"),
                            fingerprint,
                            code,
                            valid_until,
                            period: *period,
                            remaining: valid_until.saturating_sub(now),
                            used: false,
                        }
                    }
                }
            })
            .filter(|candidate| candidate.valid_until > now)
            .collect();
        for candidate in &mut candidates {
            candidate.used = usage.contains_key(&candidate.usage_key);
        }
        // `sort_by` is stable, so the configured secret order stays the
        // tie-break, exactly like tiny-rdm's ref comparison.
        candidates.sort_by(|a, b| a.used.cmp(&b.used).then(b.remaining.cmp(&a.remaining)));
        let chosen = candidates.first()?;
        usage.insert(chosen.usage_key.clone(), chosen.valid_until);
        Some(TotpSelection {
            fingerprint: chosen.fingerprint.clone(),
            code: chosen.code.clone(),
            valid_until: chosen.valid_until,
            period: chosen.period,
        })
    }
}

/// Process-global ledger of OTP selections, keyed by usage key (see
/// [`current_totp_selection`]) with the selection's window expiry as the
/// value. Global — not per `SudoAuth` — because MCP exec calls resolve a
/// fresh instance per call while rotation must survive across calls, which
/// mirrors tiny-rdm's service-level `markOTPUsage`; in-memory only, cleared
/// on sidecar restart.
fn otp_usage_ledger() -> &'static Mutex<HashMap<String, u64>> {
    static LEDGER: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Process-global record of codes already auto-submitted, keyed by
/// `scope|secret-fingerprint|code` with their replay-window expiry
/// (`validUntil + period`, i.e. including the ±1-step acceptance slack).
/// Global for the same reason as [`otp_usage_ledger`].
fn committed_otp_ledger() -> &'static Mutex<HashMap<String, u64>> {
    static LEDGER: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    LEDGER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serializes tests that touch the process-global OTP ledgers and hands
/// each one a clean slate: hold the returned guard for the whole test so
/// parallel tests neither share marks nor wipe each other mid-run.
#[cfg(test)]
fn otp_ledger_test_guard() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: OnceLock<Mutex<()>> = OnceLock::new();
    let serial = SERIAL.get_or_init(|| Mutex::new(()));
    let guard = serial.lock().unwrap_or_else(|poison| poison.into_inner());
    otp_usage_ledger()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    committed_otp_ledger()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    guard
}

/// Stable ledger-key prefix for a secret: a short SHA-256 fingerprint of
/// its canonical form (key material, digits, period, algorithm — or the
/// static code), so marks written by one resolved `SudoAuth` match lookups
/// from the next call regardless of how the secret list was ordered or
/// merged. Only the fingerprint is stored, never the secret.
fn otp_secret_fingerprint(secret: &TotpSecret) -> String {
    let canonical = match secret {
        TotpSecret::Key {
            key,
            digits,
            period,
            algorithm,
        } => format!("k:{}:{digits}:{period}:{algorithm:?}", HEXLOWER.encode(key)),
        TotpSecret::Static(code) => format!("s:{code}"),
    };
    let digest = Sha256::digest(canonical.as_bytes());
    HEXLOWER.encode(&digest)[..16].to_string()
}

/// Ledger scope for the connection a resolved [`SudoAuth`] serves: the OTP
/// usage/committed marks are keyed per target so back-to-back calls against
/// the same host rotate across their shared ledger while a second host
/// reusing the same secret is never blocked by the first host's history.
pub fn otp_ledger_scope_for(username: &str, host: &str, port: u16) -> String {
    format!("{username}@{host}:{port}")
}

/// Nominal replay window for static OTP codes, which carry no period of
/// their own (mirrors tiny-rdm's `otpReuseWindowFallback`).
const OTP_STATIC_WINDOW: u64 = 30;

/// One OTP selection with the data the replay guard needs.
struct TotpSelection {
    /// Ledger-key prefix identifying the secret the code came from.
    fingerprint: String,
    code: String,
    /// Unix seconds after which the code's own window expires.
    valid_until: u64,
    /// Secret period (or the static fallback window).
    period: u64,
}

/// Replay-window expiry for a committed code: its nominal validity plus one
/// extra step, because servers commonly accept the previous and next
/// window's code alongside the current one (the ±1-step slack).
pub fn totp_replay_window_expiry(valid_until: u64, period: u64) -> u64 {
    valid_until.saturating_add(period)
}

/// True while a committed code must not be auto-submitted again.
pub fn is_totp_in_replay_window(now: u64, committed_until: u64) -> bool {
    now <= committed_until
}

/// How often the per-connection sudo keepalive refreshes the timestamp:
/// 4 minutes, comfortably under every common sudo `timestamp_timeout`
/// (tiny-rdm's sudoKeepaliveLoop refreshes on the same order).
pub const SUDO_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(240);

/// Consecutive failed `sudo -nv` validations after which the keepalive loop
/// stops itself (the timestamp is gone; the next sudo exec re-registers).
pub const SUDO_KEEPALIVE_MAX_FAILURES: u32 = 2;

/// Advances the sudo keepalive consecutive-failure counter: success resets
/// it, a failure increments it, and reaching
/// [`SUDO_KEEPALIVE_MAX_FAILURES`] returns `None` — the caller must stop the
/// loop and drop its registration.
pub fn keepalive_failure_step(failures: u32, succeeded: bool) -> Option<u32> {
    if succeeded {
        return Some(0);
    }
    let next = failures + 1;
    (next < SUDO_KEEPALIVE_MAX_FAILURES).then_some(next)
}

#[derive(Debug, Clone, Default)]
pub struct Hints {
    pub password: String,
    pub totp: String,
    pub flow_mode: Option<AuthFlowMode>,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

/// Parses one or more TOTP secrets separated by newlines or semicolons
/// (tiny-rdm's multi-secret `TOTPSecretRefs` equivalent).
pub fn parse_totp_secrets(input: &str) -> Vec<TotpSecret> {
    input
        .split(['\n', '\r', ';'])
        .filter_map(parse_totp_secret)
        .collect()
}

/// Parses a TOTP secret reference: an `otpauth://totp/…` URI, a base32 key,
/// or a static numeric code. Returns `None` for empty or unusable values.
pub fn parse_totp_secret(input: &str) -> Option<TotpSecret> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed
        .strip_prefix("otpauth://")
        .or_else(|| trimmed.strip_prefix("OTPAUTH://"))
    {
        return parse_otpauth(rest);
    }
    if is_numeric_otp(trimmed) {
        return Some(TotpSecret::Static(trimmed.to_string()));
    }
    let key = BASE32
        .decode(trimmed.to_ascii_uppercase().as_bytes())
        .ok()?;
    if key.is_empty() {
        return None;
    }
    Some(TotpSecret::Key {
        key,
        digits: 6,
        period: 30,
        algorithm: TotpAlgorithm::Sha1,
    })
}

fn parse_otpauth(rest: &str) -> Option<TotpSecret> {
    let (scheme_path, query) = rest.split_once('?').unwrap_or((rest, ""));
    if !scheme_path
        .split('/')
        .next()
        .is_some_and(|label| label.eq_ignore_ascii_case("totp"))
    {
        return None;
    }
    let mut secret = None;
    let mut digits = 6_u32;
    let mut period = 30_u64;
    let mut algorithm = TotpAlgorithm::Sha1;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        match key {
            "secret" => {
                secret = BASE32
                    .decode(value.to_ascii_uppercase().as_bytes())
                    .ok()
                    .filter(|decoded| !decoded.is_empty());
            }
            "digits" => digits = value.parse().ok().filter(|d| (6..=8).contains(d))?,
            "period" => period = value.parse().ok().filter(|&p| (1..=120).contains(&p))?,
            "algorithm" => {
                algorithm = match value.to_ascii_uppercase().as_str() {
                    "SHA256" => TotpAlgorithm::Sha256,
                    "SHA512" => TotpAlgorithm::Sha512,
                    _ => TotpAlgorithm::Sha1,
                };
            }
            _ => {}
        }
    }
    Some(TotpSecret::Key {
        key: secret?,
        digits,
        period,
        algorithm,
    })
}

fn is_numeric_otp(input: &str) -> bool {
    (4..=10).contains(&input.len()) && input.bytes().all(|byte| byte.is_ascii_digit())
}

fn hotp(key: &[u8], counter: u64, digits: u32, algorithm: TotpAlgorithm) -> String {
    let message = counter.to_be_bytes();
    let digest: Vec<u8> = match algorithm {
        TotpAlgorithm::Sha1 => {
            let mut mac =
                <Hmac<Sha1> as Mac>::new_from_slice(key).expect("HMAC accepts keys of any length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
        TotpAlgorithm::Sha256 => {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
                .expect("HMAC accepts keys of any length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
        TotpAlgorithm::Sha512 => {
            let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key)
                .expect("HMAC accepts keys of any length");
            mac.update(&message);
            mac.finalize().into_bytes().to_vec()
        }
    };
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    let code = binary % 10_u32.pow(digits);
    format!("{code:0width$}", width = digits as usize)
}

/// Strips ANSI escape sequences and non-printable control characters, then
/// trims the result so prompt fragments can be matched reliably.
pub fn normalize_auth_prompt_text(input: &str) -> String {
    let stripped = strip_ansi_control_sequences(&input.replace('\r', "\n"));
    let cleaned: String = stripped
        .chars()
        .filter(|&character| {
            character == '\n' || character == '\t' || character == ' ' || !character.is_control()
        })
        .collect();
    cleaned.trim().to_string()
}

/// Hard cap for custom prompt hints so a runaway `settings/set` update (or a
/// malformed host-provided config) cannot store unbounded junk on the
/// connection and every live session.
pub const MAX_PROMPT_HINT_LEN: usize = 512;

/// Normalizes a user-provided prompt hint for reliable matching: strips ANSI
/// escape sequences and control characters, trims, and caps the length.
/// Malformed hints degrade to their printable residue instead of poisoning
/// the prompt classifier or the stored connection.
pub fn sanitize_prompt_hint(input: &str) -> String {
    let mut normalized = normalize_auth_prompt_text(input);
    if normalized.len() > MAX_PROMPT_HINT_LEN {
        // Cut on a char boundary so the hint stays valid UTF-8.
        let mut end = MAX_PROMPT_HINT_LEN;
        while !normalized.is_char_boundary(end) {
            end -= 1;
        }
        normalized.truncate(end);
    }
    normalized
}

fn strip_ansi_control_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            output.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 1 >= bytes.len() {
            break;
        }
        match bytes[index + 1] {
            b'[' => {
                index += 2;
                while index < bytes.len() && !(0x40..=0x7e).contains(&bytes[index]) {
                    index += 1;
                }
                index += 1;
            }
            b']' => {
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        break;
                    }
                    if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\'
                    {
                        index += 1;
                        break;
                    }
                    index += 1;
                }
                index += 1;
            }
            _ => index += 2,
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

pub(crate) fn classify_auth_prompt(prompt: &str, auth: &SudoAuth) -> Option<PromptKind> {
    let trimmed = normalize_auth_prompt_text(prompt);
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_lowercase();
    // Hints are matched against the normalized prompt text, so legacy or
    // host-provided hints carrying control characters/ANSI sequences are
    // normalized the same way instead of never matching.
    let password_hint = normalize_auth_prompt_text(&auth.password_prompt_hint).to_lowercase();
    let password_hint_matched = !password_hint.is_empty() && lower.contains(&password_hint);
    let totp_hint = normalize_auth_prompt_text(&auth.totp_prompt_hint).to_lowercase();
    let totp_hint_matched = !totp_hint.is_empty() && lower.contains(&totp_hint);
    let password_builtin = PASSWORD_PROMPT_PATTERS.iter().any(|p| lower.contains(p));
    let totp_builtin = TOTP_PROMPT_PATTERS.iter().any(|p| lower.contains(p));
    // OTP 信号优先于用户自定义的"密码提示词"：堡垒机把 MFA 提问写成
    // "[OTP Code]: "，用户若把这串可见文案填进密码提示词字段，旧逻辑会把
    // 提问判成密码提问、把登录密码当作验证码回给服务器（必然认证失败，
    // issue #30）。只有内置密码模式才允许把提问拉回密码侧。
    let password_matched =
        password_builtin || (password_hint_matched && !totp_builtin && !totp_hint_matched);
    let totp_matched = totp_builtin || totp_hint_matched;
    match (password_matched, totp_matched) {
        (true, true) => Some(PromptKind::Combined),
        (false, true) => Some(PromptKind::Totp),
        (true, false) => Some(PromptKind::Password),
        (false, false) => None,
    }
}

pub(crate) fn can_respond_to_prompt(
    mode: AuthFlowMode,
    kind: PromptKind,
    password_answered: bool,
) -> bool {
    match kind {
        // `exec_with_sudo` pipes the password before any prompt is watched
        // (`password_answered` starts true); answering a visible password
        // prompt again would queue a second password line and shift every
        // later OTP answer one read out of position.
        PromptKind::Password => !password_answered,
        PromptKind::Totp => {
            mode.allows_otp_after_password()
                && (mode != AuthFlowMode::PasswordThenOtp || password_answered)
        }
        PromptKind::Combined => {
            // PasswordPlusOtp answers combined prompts by design; PasswordOnly
            // and Off answer them too (their password half is all they send —
            // refusing the prompt would strand the session, see the
            // flow-modes test). PasswordThenOtp waits until the password has
            // been answered.
            matches!(
                mode,
                AuthFlowMode::PasswordPlusOtp | AuthFlowMode::PasswordOnly | AuthFlowMode::Off
            ) || password_answered
        }
    }
}

/// Result of a remote command execution.
pub struct ExecOutcome {
    pub output: String,
    pub exit_code: i32,
}

/// One CHANNEL_REQUEST "env" entry with its failure policy. Built-in
/// defaults stay best-effort: default sshd configs only `AcceptEnv LANG`
/// and `LC_*`, so e.g. the internal `SUDO_ASKPASS` clear is commonly
/// refused and the caller must not care. Client-specified `setEnv` entries
/// are strict — a silently dropped variable changes what the remote command
/// ends up seeing.
#[derive(Debug, PartialEq, Eq)]
struct ChannelEnv {
    key: String,
    value: String,
    strict: bool,
}

/// Merges built-in channel env defaults with the connection's client
/// `setEnv` entries: user entries win on duplicate keys and every variable
/// ends up requested exactly once — dedup is decided locally here instead
/// of relying on server-side ordering of duplicate env requests.
fn merge_channel_env(defaults: &[(&str, &str)], user_env: &[(String, String)]) -> Vec<ChannelEnv> {
    let mut merged: Vec<ChannelEnv> = defaults
        .iter()
        .map(|(key, value)| ChannelEnv {
            key: (*key).to_string(),
            value: (*value).to_string(),
            strict: false,
        })
        .collect();
    for (key, value) in user_env {
        match merged.iter_mut().find(|entry| entry.key == *key) {
            Some(slot) => {
                slot.value = value.clone();
                slot.strict = true;
            }
            None => merged.push(ChannelEnv {
                key: key.clone(),
                value: value.clone(),
                strict: true,
            }),
        }
    }
    merged
}

/// Requests the merged environment on a session channel before its
/// shell/exec request. Strict (user-configured) entries fail the whole
/// channel setup with the variable named; best-effort defaults keep the
/// historical swallow-and-continue behavior. russh's `set_env` is
/// fire-and-forget, so "failure" here means a broken channel/transport —
/// a server that drops a variable for lack of `AcceptEnv` stays silent by
/// protocol design, exactly like the ssh(1) client.
async fn apply_channel_env(
    channel: &mut russh::Channel<russh::client::Msg>,
    env: &[ChannelEnv],
) -> Result<(), String> {
    for entry in env {
        if let Err(error) = channel.set_env(true, &entry.key, &entry.value).await {
            if entry.strict {
                return Err(format!(
                    "Failed to set remote environment variable '{}': {error}",
                    entry.key
                ));
            }
        }
    }
    Ok(())
}

/// Requests a connection's client-specified `setEnv` entries on a bare
/// channel (interactive session path; no built-in defaults to merge).
/// Semantics are the client-specified half of ssh's SetEnv/SendEnv: only
/// entries from this connection's config are transmitted, never the local
/// process environment.
pub(crate) async fn apply_connection_env(
    channel: &mut russh::Channel<russh::client::Msg>,
    set_env: &[(String, String)],
) -> Result<(), String> {
    apply_channel_env(channel, &merge_channel_env(&[], set_env)).await
}

/// Runs a command without privilege escalation on a new channel.
pub async fn exec_plain(
    handle: &Handle<SshClient>,
    command: &str,
    timeout: Duration,
    set_env: &[(String, String)],
) -> Result<ExecOutcome, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("Failed to open exec channel: {error}"))?;
    apply_connection_env(&mut channel, set_env).await?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|error| format!("Failed to start command: {error}"))?;
    match run_to_completion(&mut channel, timeout, None).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => Err(abort_exec_channel(&mut channel, error).await),
    }
}

/// Runs a command with Quick Sudo: pipes the password to `sudo -S` stdin and,
/// while the command is still authenticating, watches the prompt stream for
/// 2FA/TOTP follow-up prompts and answers them automatically. When no
/// password is configured it falls back to non-interactive `sudo -n`.
pub async fn exec_with_sudo(
    handle: &Handle<SshClient>,
    auth: &SudoAuth,
    command: &str,
    timeout: Duration,
    use_pty: bool,
    set_env: &[(String, String)],
) -> Result<ExecOutcome, String> {
    if auth.password.is_empty() {
        let command_line = format!("sudo -n {}", sanitize_sudo_command(command));
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open sudo channel: {error}"))?;
        apply_connection_env(&mut channel, set_env).await?;
        channel
            .exec(true, command_line.as_bytes())
            .await
            .map_err(|error| format!("Failed to start sudo command: {error}"))?;
        let outcome = match run_to_completion(&mut channel, timeout, None).await {
            Ok(outcome) => outcome,
            Err(error) => return Err(abort_exec_channel(&mut channel, error).await),
        };
        if outcome.exit_code != 0 {
            return Err(format!(
                "sudo exited {}: {} (no password configured - run sudo in the terminal first or configure Quick Sudo)",
                outcome.exit_code, outcome.output
            ));
        }
        return Ok(outcome);
    }

    let command_line = format!("sudo -S -p '' {}", sanitize_sudo_command(command));
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("Failed to open sudo channel: {error}"))?;
    if use_pty {
        // Some PAM stacks only prompt correctly with a TTY. With a PTY the
        // prompt arrives on the merged stdout stream instead of stderr.
        let _ = channel
            .request_pty(true, "xterm-256color", 24, 80, 0, 0, &[])
            .await;
    }
    // Client setEnv entries are merged with (and win over) the internal
    // SUDO_ASKPASS clear: each variable is requested exactly once with the
    // user value taking precedence, so the two env sources cannot fight
    // over the same key via server-side ordering of duplicate requests.
    let env = merge_channel_env(&[("SUDO_ASKPASS", "")], set_env);
    apply_channel_env(&mut channel, &env).await?;
    channel
        .exec(true, command_line.as_bytes())
        .await
        .map_err(|error| format!("Failed to start sudo command: {error}"))?;

    // Phase 1: hand sudo the password, with the OTP code (when configured)
    // queued right behind it - `sudo -S` and its PAM stack read the factors
    // sequentially from stdin. The exec channel stays TTY-less: with a PTY
    // each factor read flushes typed-ahead input (termios TCSAFLUSH in the
    // password readers), so automated writes race an unknowable per-host
    // timing; a plain pipe queues reliably no matter when the reads happen.
    let mut payload = format!("{}\n", auth.password).into_bytes();
    let mut otp_piped = false;
    if let Some(code) = auth.totp_answer_logged() {
        // Already-committed codes inside their replay window are skipped by
        // the watcher path below instead.
        let mut otp_line = code.into_bytes();
        otp_line.push(b'\n');
        payload.extend_from_slice(&otp_line);
        otp_piped = true;
    }
    if let Err(error) = channel.data(payload.as_slice()).await {
        return Err(abort_exec_channel(
            &mut channel,
            format!("Failed to write sudo password: {error}"),
        )
        .await);
    }

    // Phase 2: watch for follow-up prompts and collect output. Both factors
    // were piped, so the watcher only answers hosts that re-prompt and
    // reports sudo's authentication failures.
    let outcome =
        match run_to_completion(&mut channel, timeout, Some((auth, use_pty, otp_piped))).await {
            Ok(outcome) => outcome,
            Err(error) => return Err(abort_exec_channel(&mut channel, error).await),
        };
    if outcome.exit_code != 0 {
        return Err(format!(
            "sudo exited {}: {}",
            outcome.exit_code, outcome.output
        ));
    }
    Ok(outcome)
}

/// Aborts an exec channel after a failed/aborted remote run. Dropping a
/// russh `Channel` does NOT send SSH_MSG_CHANNEL_CLOSE, so the remote
/// process would keep waiting on stdin forever - a mid-authentication
/// `sudo` holds the sudo timestamp lock and deadlocks every later sudo on
/// the connection. Close the channel so sshd reaps the process.
async fn abort_exec_channel(
    channel: &mut russh::Channel<russh::client::Msg>,
    error: String,
) -> String {
    let _ = channel.eof().await;
    let _ = channel.close().await;
    error
}

/// True when the failure happened before the remote command could have
/// started (dead pooled transport, refused channel open): retrying the tool
/// call cannot double-execute the command. Anything after `channel.exec()`
/// was accepted is NOT retry-safe (the command may have run server-side), so
/// those errors stay terminal and the caller decides whether rerunning is
/// safe.
pub fn is_pre_exec_transport_error(error: &str) -> bool {
    const PRE_EXEC_MARKERS: [&str; 4] = [
        "Failed to open exec channel",
        "Failed to open sudo channel",
        "Failed to start command",
        "Failed to start sudo command",
    ];
    PRE_EXEC_MARKERS.iter().any(|marker| error.contains(marker))
}

/// `(auth, use_pty, otp_piped)` — the third flag records that the OTP code
/// was already piped to stdin in phase 1, so the watcher must treat the
/// prompt that consumed it as answered instead of burning the next
/// secret's code on the same prompt.
type PromptContext<'a> = (&'a SudoAuth, bool, bool);

const SUDO_WAIT_TIMEOUT_MESSAGE: &str =
    "Timed out waiting for the remote command to finish. The command may \
     STILL be running on the remote host - check for stray processes or \
     package-manager locks before retrying; for long jobs start them \
     detached (ssh_run_bg + ssh_task_status) instead of extending the wait.";

async fn run_to_completion(
    channel: &mut russh::Channel<russh::client::Msg>,
    timeout: Duration,
    prompt_context: Option<PromptContext<'_>>,
) -> Result<ExecOutcome, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<i32> = None;
    let mut closed = false;
    let mut auth_rounds = 0_u32;
    let mut password_answered = prompt_context.is_some();
    let mut otp_answered = prompt_context
        .as_ref()
        .map(|(_, _, otp_piped)| *otp_piped)
        .unwrap_or(false);

    while !closed {
        let message = tokio::time::timeout_at(deadline, channel.wait())
            .await
            .map_err(|_| SUDO_WAIT_TIMEOUT_MESSAGE.to_string())?;
        let message = match message {
            Some(message) => message,
            None => break,
        };
        match message {
            ChannelMsg::Data { ref data } => {
                stdout.extend_from_slice(data);
                if let Some((auth, use_pty, _)) = prompt_context.as_ref() {
                    if *use_pty {
                        if let Some(error) = maybe_answer_prompt(
                            channel,
                            auth,
                            &String::from_utf8_lossy(data),
                            &mut auth_rounds,
                            &mut password_answered,
                            &mut otp_answered,
                        )
                        .await
                        {
                            return Err(error);
                        }
                    }
                }
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                stderr.extend_from_slice(data);
                if let Some((auth, _, _)) = prompt_context.as_ref() {
                    if let Some(error) = maybe_answer_prompt(
                        channel,
                        auth,
                        &String::from_utf8_lossy(data),
                        &mut auth_rounds,
                        &mut password_answered,
                        &mut otp_answered,
                    )
                    .await
                    {
                        return Err(error);
                    }
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status as i32);
            }
            ChannelMsg::Eof | ChannelMsg::Close => {
                closed = true;
            }
            _ => {}
        }
    }

    let mut output = String::from_utf8_lossy(&stdout)
        .trim_end_matches('\n')
        .to_string();
    let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
    if output.is_empty() {
        if !stderr_text.is_empty() {
            output = stderr_text;
        }
    } else if !stderr_text.is_empty() && exit_code.unwrap_or(0) != 0 {
        output.push('\n');
        output.push_str(&stderr_text);
    }
    Ok(ExecOutcome {
        output,
        exit_code: exit_code.unwrap_or(0),
    })
}

/// Detects auth prompts in a freshly received chunk and answers them on the
/// channel stdin. Returns `Err` when sudo reports an authentication failure.
async fn maybe_answer_prompt(
    channel: &mut russh::Channel<russh::client::Msg>,
    auth: &SudoAuth,
    chunk: &str,
    auth_rounds: &mut u32,
    password_answered: &mut bool,
    otp_answered: &mut bool,
) -> Option<String> {
    let normalized = normalize_auth_prompt_text(chunk).to_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if AUTH_FAILURE_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return Some(format!("sudo authentication failed: {normalized}"));
    }
    let mode = auth.flow_mode();
    let kind = auth.classify(&normalized)?;
    if *auth_rounds >= MAX_AUTH_ROUNDS {
        return None;
    }
    if matches!(kind, PromptKind::Totp | PromptKind::Combined) && *otp_answered {
        return None;
    }
    if !can_respond_to_prompt(mode, kind, *password_answered) {
        return None;
    }
    let answer = auth.answer_for(kind)?;
    let mut payload = answer.into_bytes();
    payload.push(b'\n');
    if let Err(error) = channel.data(&payload[..]).await {
        return Some(format!("Failed to write auth answer: {error}"));
    }
    match kind {
        PromptKind::Password => *password_answered = true,
        PromptKind::Totp => *otp_answered = true,
        PromptKind::Combined => {
            *password_answered = true;
            if mode == AuthFlowMode::PasswordPlusOtp {
                *otp_answered = true;
            }
        }
    }
    *auth_rounds += 1;
    None
}

/// Validates a cached sudo timestamp without prompting; used by the
/// background keepalive loop.
pub async fn validate_sudo_timestamp(handle: &Handle<SshClient>) -> Result<(), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("Failed to open sudo keepalive channel: {error}"))?;
    channel
        .exec(true, b"sudo -nv")
        .await
        .map_err(|error| format!("Failed to start sudo keepalive: {error}"))?;
    let outcome = run_to_completion(&mut channel, Duration::from_secs(15), None).await?;
    if outcome.exit_code == 0 {
        Ok(())
    } else {
        Err("sudo timestamp expired".to_string())
    }
}

/// Single-quote shell escaping for embedding a path in a remote command.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Server metrics collected with read-only commands: /proc readers on Linux
/// with sysctl/`vm_stat`/`iostat` fallbacks on macOS, `df -kP` for mounts,
/// plus the network-rate and top-process extensions. Thin delegation to
/// [`crate::metrics`], which owns the extended collector and parsers.
pub async fn collect_metrics(handle: &Handle<SshClient>) -> Result<serde_json::Value, String> {
    crate::metrics::collect_metrics(handle).await
}

pub use crate::metrics::{project_metrics_sections, validate_section_names, METRICS_SECTIONS};

/// Parses the output of [`METRICS_SCRIPT`] into a metrics JSON object.
/// Pure so it can be unit-tested without a server.
pub fn parse_metrics_output(output: &str) -> serde_json::Value {
    use serde_json::json;

    let mut hostname = serde_json::Value::Null;
    let mut kernel = serde_json::Value::Null;
    let mut loadavg = String::new();
    let mut uptime = String::new();
    let mut nproc: serde_json::Value = serde_json::Value::Null;
    let mut mem_kib: HashMap<&str, u64> = HashMap::new();
    let mut cpu_samples: Vec<Vec<u64>> = Vec::new();
    let mut disks = Vec::new();
    let mut section = "";

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "--mem--" || line == "--cpu--" || line == "--df--" {
            section = line;
            continue;
        }
        if let Some(rest) = line.strip_prefix("hostname=") {
            hostname = json!(rest);
        } else if let Some(rest) = line.strip_prefix("kernel=") {
            kernel = json!(rest);
        } else if let Some(rest) = line.strip_prefix("loadavg=") {
            loadavg = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("uptime=") {
            uptime = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("nproc=") {
            nproc = rest
                .parse::<u32>()
                .map(|v| json!(v))
                .unwrap_or(serde_json::Value::Null);
        } else if section == "--mem--" {
            // "MemTotal:       16384 kB"
            if let Some((key, value)) = rest_after_colon(line) {
                if let Some(kib) = value
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<u64>().ok())
                {
                    mem_kib.insert(key, kib);
                }
            }
        } else if section == "--cpu--" {
            if let Some(rest) = line.strip_prefix("cpu ") {
                let values = rest
                    .split_whitespace()
                    .filter_map(|n| n.parse::<u64>().ok())
                    .collect::<Vec<_>>();
                if values.len() >= 4 {
                    cpu_samples.push(values);
                }
            }
        } else if section == "--df--" {
            // filesystem total used avail pct mount
            let fields = line.split_whitespace().collect::<Vec<_>>();
            // 严格行形校验：容量三列必须是数字、百分比列必须以 % 结尾、挂载点
            // 必须是绝对路径。段切换只认 --mem--/--cpu--/--df--，后面的 --os--
            // 段内容会落在 df 段里——os-release 的 `PRETTY_NAME="Alibaba Cloud
            // Linux release 3 (OpenAnolis)"` 恰好 6 个字段，宽松解析会把
            // "(OpenAnolis)" 混成 0 B 的幽灵磁盘行。
            if fields.len() >= 6 && fields[5].starts_with('/') {
                if let (Ok(total_kib), Ok(used_kib), Ok(available_kib)) = (
                    fields[1].parse::<u64>(),
                    fields[2].parse::<u64>(),
                    fields[3].parse::<u64>(),
                ) {
                    if let Some(percent) = fields[4]
                        .strip_suffix('%')
                        .and_then(|p| p.parse::<f64>().ok())
                    {
                        disks.push(json!({
                            "filesystem": fields[0],
                            "mount": fields[5],
                            "totalBytes": total_kib * 1024,
                            "usedBytes": used_kib * 1024,
                            "availableBytes": available_kib * 1024,
                            "percentUsed": percent,
                        }));
                    }
                }
            }
        }
    }

    let mut cpu_percent = serde_json::Value::Null;
    if cpu_samples.len() == 2 {
        let first = &cpu_samples[0];
        let second = &cpu_samples[1];
        let delta: Vec<i64> = second
            .iter()
            .zip(first.iter())
            .map(|(next, prev)| *next as i64 - *prev as i64)
            .collect();
        let total: i64 = delta.iter().sum();
        // Columns are user nice system idle iowait …; idle time is idle+iowait.
        let idle = delta.get(3).copied().unwrap_or(0) + delta.get(4).copied().unwrap_or(0);
        if total > 0 {
            cpu_percent =
                json!(((total - idle) as f64 * 100.0 / total as f64 * 10.0).round() / 10.0);
        }
    }

    let loads: Vec<f64> = loadavg
        .split_whitespace()
        .take(3)
        .filter_map(|n| n.parse::<f64>().ok())
        .collect();
    let (load1, load5, load15) = match loads.as_slice() {
        [one, five, fifteen] => (json!(one), json!(five), json!(fifteen)),
        _ => (
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        ),
    };
    let mem_total = mem_kib.get("MemTotal").copied().unwrap_or(0) * 1024;
    let mem_available = mem_kib.get("MemAvailable").copied().unwrap_or(0) * 1024;
    let swap_total = mem_kib.get("SwapTotal").copied().unwrap_or(0) * 1024;
    let swap_free = mem_kib.get("SwapFree").copied().unwrap_or(0) * 1024;
    let uptime_seconds = uptime
        .split_whitespace()
        .next()
        .and_then(|n| n.parse::<f64>().ok())
        .map(|v| json!(v as u64))
        .unwrap_or(serde_json::Value::Null);

    json!({
        "hostname": hostname,
        "kernel": kernel,
        "uptimeSeconds": uptime_seconds,
        "cpu": { "cores": nproc, "percent": cpu_percent, "load1": load1, "load5": load5, "load15": load15 },
        "memory": {
            "totalBytes": mem_total,
            "availableBytes": mem_available,
            "usedBytes": mem_total.saturating_sub(mem_available),
            "swapTotalBytes": swap_total,
            "swapUsedBytes": swap_total.saturating_sub(swap_free),
        },
        "disks": disks,
    })
}

fn rest_after_colon(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once(':')?;
    Some((key.trim(), value.trim()))
}

/// Parses `df -kP <path>` output (header stripped) into a usage object.
pub fn parse_disk_usage(df_output: &str) -> Option<serde_json::Value> {
    use serde_json::json;
    // `df -kP <path>` prints one data line for the filesystem holding the
    // path, but that line does not necessarily start with '/': overlay and
    // tmpfs mounts (containers!) name their filesystem `overlay`/`tmpfs`.
    // Prefer a device-style line, then fall back to any 6-field line whose
    // block counts parse as numbers (the POSIX header says "1024-blocks",
    // so it never passes the numeric check).
    let candidate = |line: &str| -> Option<serde_json::Value> {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 6 {
            return None;
        }
        Some(json!({
            "filesystem": fields[0],
            "mount": fields[5],
            "totalBytes": fields[1].parse::<u64>().ok()? * 1024,
            "usedBytes": fields[2].parse::<u64>().ok()? * 1024,
            "availableBytes": fields[3].parse::<u64>().ok()? * 1024,
            "percentUsed": fields[4].trim_end_matches('%').parse::<f64>().ok()?,
        }))
    };
    df_output
        .lines()
        .rev()
        .find_map(|line| {
            line.trim()
                .starts_with('/')
                .then(|| candidate(line))
                .flatten()
        })
        .or_else(|| df_output.lines().rev().find_map(candidate))
}

/// Tracks whether the first authentication factor is already behind us during
/// a keyboard-interactive handshake, mirroring tiny-rdm's per-connection
/// state. `password_then_otp` gates OTP answers on this flag so a bare OTP
/// question cannot be answered before the password step.
#[derive(Debug, Default)]
pub struct KeyboardInteractiveState {
    password_answered: bool,
}

impl KeyboardInteractiveState {
    /// Seeds the state for a keyboard-interactive exchange that starts *after*
    /// the first factor was already accepted. JumpServer/koko accepts the
    /// password (or publickey) with `partial_success` and only then asks for
    /// the MFA code over keyboard-interactive; without this seed the MFA
    /// question looks like "the password has not been sent yet" and
    /// `password_then_otp` leaves it blank, so the login can never succeed.
    pub fn first_factor_accepted() -> Self {
        Self {
            password_answered: true,
        }
    }
}

/// Joins a keyboard-interactive challenge's `name` and `instructions` into the
/// fallback text used to classify prompts whose own wording is unrecognized.
/// koko sends the readable "Please Enter MFA Code." as instructions while the
/// prompt itself is "[OTP Code]: ", so users who copy the visible line into
/// the OTP hint would otherwise never match anything. Server-controlled text,
/// so it is stripped of control characters and capped like a user hint.
pub fn keyboard_interactive_challenge_context(name: &str, instructions: &str) -> String {
    let mut context = String::new();
    for part in [name, instructions] {
        let part = sanitize_prompt_hint(part);
        if part.is_empty() || context.contains(&part) {
            continue;
        }
        if !context.is_empty() {
            context.push('\n');
        }
        context.push_str(&part);
    }
    context
}

/// Builds automatic answers for a keyboard-interactive login round. Prompts
/// are classified individually; a prompt whose own wording is unrecognized
/// falls back to the challenge `name`/`instructions`. Unknown or unanswered
/// prompts get an empty string so the server can re-prompt or fail cleanly.
/// Ported from tiny-rdm's keyboardInteractivePasswordAuth callback.
pub fn keyboard_interactive_answers(
    auth: &SudoAuth,
    state: &mut KeyboardInteractiveState,
    challenge_context: &str,
    prompts: &[russh::client::Prompt],
) -> Vec<String> {
    let mode = auth.flow_mode();
    let mut password_answered_round = false;
    let context_kind = (!challenge_context.trim().is_empty())
        .then(|| classify_auth_prompt(challenge_context, auth))
        .flatten();
    let answers = prompts
        .iter()
        .map(
            |prompt| match classify_auth_prompt(&prompt.prompt, auth).or(context_kind) {
                Some(PromptKind::Password) => {
                    if auth.password.is_empty() {
                        String::new()
                    } else {
                        password_answered_round = true;
                        auth.password.clone()
                    }
                }
                Some(PromptKind::Totp) => {
                    if !can_respond_to_prompt(
                        mode,
                        PromptKind::Totp,
                        state.password_answered || password_answered_round,
                    ) {
                        String::new()
                    } else {
                        auth.totp_answer_logged().unwrap_or_default()
                    }
                }
                Some(PromptKind::Combined) => {
                    if auth.password.is_empty() {
                        String::new()
                    } else if mode == AuthFlowMode::PasswordPlusOtp {
                        match auth.totp_answer_logged() {
                            Some(code) => {
                                password_answered_round = true;
                                format!("{}{}", auth.password, code)
                            }
                            // No code available (or the previous one is still
                            // inside its replay window): leave the prompt empty
                            // so the server re-prompts or fails cleanly.
                            None => String::new(),
                        }
                    } else {
                        password_answered_round = true;
                        auth.password.clone()
                    }
                }
                None => String::new(),
            },
        )
        .collect();
    if password_answered_round {
        state.password_answered = true;
    }
    answers
}

const SUDO_PROMPT_PATTERS: &[&str] = &["[sudo] password for", "password:"];

/// True when the last non-empty line of the terminal output looks like a
/// shell prompt, meaning any in-flight auth sequence has finished.
pub(crate) fn has_shell_prompt(normalized: &str) -> bool {
    normalized
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            let line = line.trim_end();
            line.ends_with('$') || line.ends_with('#')
        })
}

/// What the state machine decided to type into the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoSudoKind {
    Password,
    Totp,
}

/// In-terminal Quick Sudo, ported from tiny-rdm's detectAndHandleSudo and
/// handleOrchestrationPrompt: watches PTY output and answers sudo password /
/// 2FA prompts automatically while the user keeps typing normal commands.
/// The auth settings are read through a shared lock on every chunk, so
/// runtime settings updates apply without reopening the terminal.
pub struct TerminalAutoSudo {
    auth: Arc<RwLock<SudoAuth>>,
    sudo_pending: bool,
    password_sent: bool,
    otp_sent: bool,
    /// 推迟的 OTP 应答（并发同靶场景）：同一 otp_ledger_scope（user@host:port）
    /// 的多个终端会话几乎同时弹出 OTP 提示时，当前窗口唯一的码已被先到的
    /// 会话提交，重放保护会拒绝重复注入——后到的提示不应就此晾死，而是
    /// 记下"下一个窗口再答"，由终端读循环周期性重试（`take_deferred_otp`）。
    /// 仅轮转密钥（Key）适用；静态恢复码永远不变，重试无意义。
    otp_deferred_kind: Option<PromptKind>,
    otp_deferred_until: Option<u64>,
}

impl TerminalAutoSudo {
    pub fn new(auth: Arc<RwLock<SudoAuth>>) -> Self {
        Self {
            auth,
            sudo_pending: false,
            password_sent: false,
            otp_sent: false,
            otp_deferred_kind: None,
            otp_deferred_until: None,
        }
    }

    /// Feeds one terminal output chunk and returns the answer to type back
    /// (without the carriage return), if any prompt was answered.
    pub fn observe(&mut self, chunk: &str) -> Option<(AutoSudoKind, String)> {
        let auth = self
            .auth
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let auth = &auth;
        let normalized = normalize_auth_prompt_text(chunk);
        if normalized.is_empty() {
            return None;
        }
        if has_shell_prompt(&normalized) {
            self.sudo_pending = false;
            self.password_sent = false;
            self.otp_sent = false;
            self.otp_deferred_kind = None;
            self.otp_deferred_until = None;
            return None;
        }
        let lower = normalized.to_lowercase();
        let mode = auth.flow_mode();
        let kind = classify_auth_prompt(&lower, auth);

        if self.sudo_pending {
            match kind {
                Some(PromptKind::Totp) => {
                    if self.otp_sent
                        || !can_respond_to_prompt(mode, PromptKind::Totp, self.password_sent)
                    {
                        return None;
                    }
                }
                _ => return None,
            }
        }

        // Direct sudo password prompts are answered unconditionally.
        if SUDO_PROMPT_PATTERS
            .iter()
            .any(|pattern| lower.contains(pattern))
        {
            if auth.password.is_empty() {
                // Make the silent no-answer case diagnosable: the watcher is
                // armed but holds no credential (sudo source off/unbound, or
                // neither the connection nor the login path has a password).
                eprintln!(
                    "[ssh] terminal auto-sudo: sudo password prompt detected but no sudo password is configured (check the connection's sudo source / global profile binding)"
                );
                return None;
            }
            self.sudo_pending = true;
            self.password_sent = true;
            return Some((AutoSudoKind::Password, auth.password.clone()));
        }

        // Generic prompts are only auto-answered when custom hints are
        // configured; broad default patterns would false-positive on other
        // interactive programs (tiny-rdm applies the same guard).
        let has_custom_hint = !auth.password_prompt_hint.trim().is_empty()
            || !auth.totp_prompt_hint.trim().is_empty();
        if !has_custom_hint {
            return None;
        }
        let kind = kind?;
        if !can_respond_to_prompt(mode, kind, self.password_sent) {
            return None;
        }
        let (answer, otp_retry_at) = auth.answer_for_with_retry(kind);
        let Some(answer) = answer else {
            // 码已在重放窗口内被同靶的其他会话提交：不注入、不晾死，
            // 推迟到下一个 TOTP 窗口由读循环重试补答。
            self.otp_deferred_kind = Some(kind);
            self.otp_deferred_until = otp_retry_at;
            return None;
        };
        let auto_kind = match kind {
            PromptKind::Totp => AutoSudoKind::Totp,
            _ => AutoSudoKind::Password,
        };
        if matches!(kind, PromptKind::Password | PromptKind::Combined) {
            self.password_sent = true;
        }
        if matches!(kind, PromptKind::Totp)
            || (kind == PromptKind::Combined && mode == AuthFlowMode::PasswordPlusOtp)
        {
            self.otp_sent = true;
        }
        self.sudo_pending = true;
        Some((auto_kind, answer))
    }

    /// 重试被推迟的 OTP 应答；由终端读循环周期性调用（`now` 为调用方传入的
    /// 当前 unix 秒，便于测试注入）。仅当提示序列仍挂起（未被 shell prompt
    /// 复位，也尚未直接应答过 OTP）且推迟时刻已到时才尝试；拿到新窗口的码
    /// 即清掉推迟态并返回应答，仍拿不到则顺延到下一个窗口。
    pub fn take_deferred_otp(&mut self, now: u64) -> Option<(AutoSudoKind, String)> {
        if self.otp_sent {
            self.otp_deferred_kind = None;
            self.otp_deferred_until = None;
            return None;
        }
        let kind = self.otp_deferred_kind?;
        let due = self.otp_deferred_until?;
        if now < due {
            return None;
        }
        let auth = self
            .auth
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let (answer, retry_at) = auth.answer_for_with_retry(kind);
        match answer {
            Some(text) => {
                self.otp_deferred_kind = None;
                self.otp_deferred_until = None;
                self.otp_sent = true;
                let auto_kind = if kind == PromptKind::Totp {
                    AutoSudoKind::Totp
                } else {
                    AutoSudoKind::Password
                };
                Some((auto_kind, text))
            }
            None => {
                // 新窗口的码又被同靶会话抢了：继续顺延（重试时刻必然后移）。
                self.otp_deferred_until = retry_at.or(self.otp_deferred_until);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B vectors use the ASCII secret of "12345678901234567890".
    const RFC_KEY: &[u8] = b"12345678901234567890";

    #[test]
    fn rfc6238_sha1_vectors() {
        // (counter, 8-digit code) from RFC 6238 appendix B.
        let vectors = [
            (1_u64, "94287082"),
            (0x23523EC, "07081804"),
            (0x23523ED, "14050471"),
            (0x273EF07, "89005924"),
            (0x3F940AA, "69279037"),
            (0x27BC86AA, "65353130"),
        ];
        for (counter, expected) in vectors {
            assert_eq!(hotp(RFC_KEY, counter, 8, TotpAlgorithm::Sha1), expected);
        }
    }

    #[test]
    fn parses_base32_and_static_secrets() {
        let base32 = parse_totp_secret("JBSWY3DPEHPK3PXP").unwrap();
        match base32 {
            TotpSecret::Key { digits, period, .. } => {
                assert_eq!(digits, 6);
                assert_eq!(period, 30);
            }
            other => panic!("expected key, got {other:?}"),
        }
        match parse_totp_secret("12345678").unwrap() {
            TotpSecret::Static(code) => assert_eq!(code, "12345678"),
            other => panic!("expected static, got {other:?}"),
        }
        assert!(parse_totp_secret("  ").is_none());
        assert!(parse_totp_secret("not base32!!").is_none());
    }

    #[test]
    fn parses_otpauth_uri() {
        let secret = parse_totp_secret(
            "otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&issuer=ACME&digits=8&period=60&algorithm=SHA256",
        )
        .unwrap();
        match secret {
            TotpSecret::Key {
                key,
                digits,
                period,
                algorithm,
            } => {
                assert_eq!(key, b"Hello!\xde\xad\xbe\xef");
                assert_eq!(digits, 8);
                assert_eq!(period, 60);
                assert_eq!(algorithm, TotpAlgorithm::Sha256);
            }
            other => panic!("expected key, got {other:?}"),
        }
        assert!(parse_totp_secret("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP").is_none());
    }

    #[test]
    fn sanitizes_sudo_commands() {
        assert_eq!(sanitize_sudo_command("ls -la"), "sh -c 'ls -la'");
        assert_eq!(
            sanitize_sudo_command("echo 'hi'; rm -rf /tmp/x"),
            "sh -c 'echo '\\''hi'\\''; rm -rf /tmp/x'"
        );
    }

    #[test]
    fn sanitizes_prompt_hints_against_adversarial_input() {
        // ANSI sequences and control characters are stripped, not stored.
        assert_eq!(
            sanitize_prompt_hint("\x1b[1midentity token\x1b[0m\u{7}"),
            "identity token"
        );
        assert_eq!(
            sanitize_prompt_hint("  duo \r passcode \n"),
            "duo \n passcode"
        );
        // Overlong hints are capped on a char boundary.
        let long = "a".repeat(MAX_PROMPT_HINT_LEN + 4096);
        let sanitized = sanitize_prompt_hint(&long);
        assert!(sanitized.len() <= MAX_PROMPT_HINT_LEN);
        let multibyte = "密".repeat(MAX_PROMPT_HINT_LEN / 2 + 16);
        assert!(sanitize_prompt_hint(&multibyte).is_char_boundary(0));
        assert!(sanitize_prompt_hint(&multibyte).len() <= MAX_PROMPT_HINT_LEN);
        // Clean input passes through unchanged.
        assert_eq!(
            sanitize_prompt_hint("verification code"),
            "verification code"
        );
    }

    #[test]
    fn classify_matches_hints_despite_control_characters() {
        // A hint stored before sanitization existed (or delivered by an older
        // host) still matches the normalized prompt text.
        let auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: Vec::new(),
            password_prompt_hint: "\x1b[1midentity token\x1b[0m".into(),
            totp_prompt_hint: String::new(),
            flow_mode: None,
            ..Default::default()
        };
        assert_eq!(
            auth.classify("Enter identity token:"),
            Some(PromptKind::Password)
        );
    }

    #[test]
    fn auth_flow_mode_parse_falls_back_for_adversarial_values() {
        // Unknown / hostile values degrade to the default flow instead of
        // panicking or producing an invalid mode.
        for value in [
            "",
            "garbage",
            "password\u{0}otp",
            "PASSWORD+OTP ",
            " password_only\t",
        ] {
            let _ = AuthFlowMode::parse(value);
        }
        assert_eq!(
            AuthFlowMode::parse("garbage"),
            AuthFlowMode::PasswordThenOtp
        );
        assert_eq!(
            AuthFlowMode::parse("PASSWORD+OTP"),
            AuthFlowMode::PasswordPlusOtp
        );
        assert_eq!(
            AuthFlowMode::parse(" password_only\t"),
            AuthFlowMode::PasswordOnly
        );
    }

    #[test]
    fn off_flow_keeps_password_and_never_spends_otp() {
        // `off`（0.4.77 起连接表单默认）继续应答密码类提示，但 OTP 密钥哪怕
        // 已配置也绝不自动回码（登录 keyboard-interactive、sudo watcher、
        // 组合提示三条路径一致），且纯 OTP 凭据不再视作「有用」。
        let totp_only = SudoAuth::new(
            "",
            "",
            "JBSWY3DPEHPK3PXP\n123456",
            Hints {
                password: String::new(),
                totp: String::new(),
                flow_mode: Some(AuthFlowMode::Off),
            },
        );
        assert!(totp_only.totp_configured());
        assert!(
            !totp_only.useful(),
            "totp-only auth must not arm the watcher when off"
        );
        assert!(totp_only.answer_for(PromptKind::Totp).is_none());
        let (answer, retry_at) = totp_only.answer_for_with_retry(PromptKind::Totp);
        assert!(answer.is_none());
        assert!(retry_at.is_none(), "off must not schedule an OTP retry");
        // 密码路径不受 off 影响：组合提示仍回密码半段（拒答会晾死会话）。
        let with_password = SudoAuth::new(
            "",
            "login",
            "JBSWY3DPEHPK3PXP",
            Hints {
                password: String::new(),
                totp: String::new(),
                flow_mode: Some(AuthFlowMode::Off),
            },
        );
        assert!(with_password.useful());
        assert_eq!(
            with_password.answer_for(PromptKind::Combined).as_deref(),
            Some("login")
        );
        assert!(!can_respond_to_prompt(
            AuthFlowMode::Off,
            PromptKind::Totp,
            true
        ));
        assert!(can_respond_to_prompt(
            AuthFlowMode::Off,
            PromptKind::Password,
            false
        ));
        assert!(can_respond_to_prompt(
            AuthFlowMode::Off,
            PromptKind::Combined,
            false
        ));
        assert_eq!(AuthFlowMode::parse("off"), AuthFlowMode::Off);
        assert_eq!(AuthFlowMode::parse("Disabled"), AuthFlowMode::Off);
        assert_eq!(AuthFlowMode::Off.name(), "off");
    }

    #[test]
    fn totp_secret_parsing_degrades_for_malformed_input() {
        // Multi-line input keeps the usable lines and drops the junk.
        let secrets = parse_totp_secrets("JBSWY3DPEHPK3PXP\nnot base32!!\n\n123456");
        assert_eq!(secrets.len(), 2);
        assert!(matches!(secrets[0], TotpSecret::Key { .. }));
        assert!(matches!(secrets[1], TotpSecret::Static(_)));
        // A space-laden pseudo-base32 line is rejected rather than decoded.
        assert!(parse_totp_secret("JBSW Y3DP EHPK 3PXP").is_none());
        // Semicolon-separated multi-secret input behaves like newlines.
        assert_eq!(parse_totp_secrets("JBSWY3DPEHPK3PXP;;bad value!").len(), 1);
        assert!(parse_totp_secrets("").is_empty());
    }

    #[test]
    fn classifies_prompts_with_hints_and_defaults() {
        let auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("JBSWY3DPEHPK3PXP"),
            password_prompt_hint: String::new(),
            totp_prompt_hint: String::new(),
            flow_mode: None,
            ..Default::default()
        };
        assert_eq!(
            auth.classify("[sudo] password for user:"),
            Some(PromptKind::Password)
        );
        assert_eq!(auth.classify("Verification code:"), Some(PromptKind::Totp));
        assert_eq!(auth.classify("密码："), Some(PromptKind::Password));
        assert_eq!(auth.classify("some regular output"), None);

        let hinted = SudoAuth {
            password: "pw".into(),
            totp_secrets: Vec::new(),
            password_prompt_hint: "identity token".into(),
            totp_prompt_hint: "duo passcode".into(),
            flow_mode: None,
            ..Default::default()
        };
        assert_eq!(
            hinted.classify("Enter identity token:"),
            Some(PromptKind::Password)
        );
        assert_eq!(hinted.classify("Duo passcode:"), Some(PromptKind::Totp));
    }

    #[test]
    fn ansi_and_control_sequences_are_stripped() {
        assert_eq!(
            normalize_auth_prompt_text("\x1b[1m[sudo] password\x1b[0m for u: "),
            "[sudo] password for u:"
        );
        assert_eq!(normalize_auth_prompt_text("\r\nOTP:\u{7}"), "OTP:");
    }

    #[test]
    fn flow_modes_gate_otp_answers() {
        assert!(can_respond_to_prompt(
            AuthFlowMode::PasswordThenOtp,
            PromptKind::Totp,
            true
        ));
        assert!(!can_respond_to_prompt(
            AuthFlowMode::PasswordThenOtp,
            PromptKind::Totp,
            false
        ));
        assert!(!can_respond_to_prompt(
            AuthFlowMode::PasswordOnly,
            PromptKind::Totp,
            true
        ));
        assert!(can_respond_to_prompt(
            AuthFlowMode::PasswordPlusOtp,
            PromptKind::Totp,
            false
        ));
        assert!(can_respond_to_prompt(
            AuthFlowMode::PasswordOnly,
            PromptKind::Combined,
            false
        ));
    }

    #[test]
    fn piped_password_is_not_reanswered_on_visible_prompt() {
        // exec_with_sudo pipes the password before watching prompts; a second
        // copy would desync the stdin line stream against the OTP answer.
        assert!(!can_respond_to_prompt(
            AuthFlowMode::PasswordThenOtp,
            PromptKind::Password,
            true
        ));
        assert!(can_respond_to_prompt(
            AuthFlowMode::PasswordThenOtp,
            PromptKind::Password,
            false
        ));
    }

    #[test]
    fn sudo_password_overrides_login_password() {
        let auth = SudoAuth::new("sudo-pw", "login-pw", "", Hints::default());
        assert_eq!(auth.password, "sudo-pw");
        let fallback = SudoAuth::new("", "login-pw", "", Hints::default());
        assert_eq!(fallback.password, "login-pw");
    }

    #[test]
    fn combined_answers_follow_flow_mode() {
        let mut auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("123456"),
            password_prompt_hint: String::new(),
            totp_prompt_hint: String::new(),
            flow_mode: Some(AuthFlowMode::PasswordThenOtp),
            ..Default::default()
        };
        assert_eq!(auth.answer_for(PromptKind::Combined).unwrap(), "pw");
        auth.flow_mode = Some(AuthFlowMode::PasswordPlusOtp);
        let combined = auth.answer_for(PromptKind::Combined).unwrap();
        assert_eq!(combined.len(), 8);
        assert!(combined.starts_with("pw"));
    }

    fn prompt(text: &str, echo: bool) -> russh::client::Prompt {
        russh::client::Prompt {
            prompt: text.to_string(),
            echo,
        }
    }

    fn terminal_auth() -> SudoAuth {
        SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("654321"),
            password_prompt_hint: String::new(),
            totp_prompt_hint: String::new(),
            flow_mode: None,
            ..Default::default()
        }
    }

    #[test]
    fn keyboard_interactive_answers_follow_flow_mode() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut state = KeyboardInteractiveState::default();
        let auth = terminal_auth();

        // Round 1: password question.
        let answers = keyboard_interactive_answers(
            &auth,
            &mut state,
            "",
            &[
                prompt("Password:", false),
                prompt("Enter account name:", true),
            ],
        );
        assert_eq!(answers, vec!["pw".to_string(), String::new()]);
        assert!(state.password_answered);

        // Round 2: TOTP is allowed because a password round already succeeded.
        let answers = keyboard_interactive_answers(
            &auth,
            &mut state,
            "",
            &[prompt("Verification code:", false)],
        );
        assert_eq!(answers, vec!["654321".to_string()]);

        // password+otp combined prompts concatenate when configured. A
        // distinct static code: the process-global replay guard already saw
        // "654321" go out in round 2, so the same code must not be answered
        // again inside its window.
        let mut plus = terminal_auth();
        plus.flow_mode = Some(AuthFlowMode::PasswordPlusOtp);
        plus.totp_secrets = parse_totp_secrets("998877");
        let answers = keyboard_interactive_answers(
            &plus,
            &mut KeyboardInteractiveState::default(),
            "",
            &[prompt("Password: otp:", false)],
        );
        assert_eq!(answers, vec!["pw998877".to_string()]);

        // password_only never answers OTP.
        let mut only = terminal_auth();
        only.flow_mode = Some(AuthFlowMode::PasswordOnly);
        let answers = keyboard_interactive_answers(
            &only,
            &mut KeyboardInteractiveState::default(),
            "",
            &[prompt("Verification code:", false)],
        );
        assert_eq!(answers, vec![String::new()]);
    }

    #[test]
    fn keyboard_interactive_without_totp_leaves_prompts_blank() {
        let mut auth = terminal_auth();
        auth.totp_secrets = Vec::new();
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::default(),
            "",
            &[prompt("Verification code:", false)],
        );
        assert_eq!(answers, vec![String::new()]);
    }

    /// JumpServer/koko 的登录期 MFA：密码（或公钥）被 partial success 接受后，
    /// 服务器用 keyboard-interactive 提问 "Please Enter MFA Code." + "[OTP Code]: "。
    /// 这里逐条钉住修复后的行为（issue #17 / #30）。
    #[test]
    fn koko_mfa_prompt_is_answered_after_partial_success_password() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut auth = terminal_auth();
        auth.flow_mode = Some(AuthFlowMode::PasswordThenOtp);
        let prompt = prompt("[OTP Code]: ", false);

        // 未播种（密码尚未提交）：先密码再 OTP 的语义仍然拦住裸 OTP 提问。
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::default(),
            "",
            std::slice::from_ref(&prompt),
        );
        assert_eq!(answers, vec![String::new()]);

        // 前置认证 partial success（koko 的密码已通过）后必须自动回码。
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::first_factor_accepted(),
            "",
            std::slice::from_ref(&prompt),
        );
        assert_eq!(answers, vec!["654321".to_string()]);
    }

    #[test]
    fn keyboard_interactive_falls_back_to_challenge_instructions() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut auth = terminal_auth();
        auth.flow_mode = Some(AuthFlowMode::PasswordThenOtp);
        // 提问文案本身认不出来时，用 koko 的指令行兜底（用户照屏幕抄进
        // OTP 提示词的也是这句话）。
        let context = keyboard_interactive_challenge_context("jumper", "Please Enter MFA Code.");
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::first_factor_accepted(),
            &context,
            &[prompt("Code: ", false)],
        );
        assert_eq!(answers, vec!["654321".to_string()]);

        // 指令行缺省时不得凭空回码。
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::first_factor_accepted(),
            &keyboard_interactive_challenge_context("jumper", ""),
            &[prompt("Code: ", false)],
        );
        assert_eq!(answers, vec![String::new()]);
    }

    /// issue #30：用户把 "OTP Code" 填进了密码提示词字段。旧逻辑把它判成密码
    /// 提问，于是把登录密码当验证码回给服务器（必然被拒）。OTP 信号必须优先。
    #[test]
    fn password_hint_cannot_hijack_an_otp_prompt() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut auth = terminal_auth();
        auth.flow_mode = Some(AuthFlowMode::PasswordThenOtp);
        auth.password_prompt_hint = "OTP Code".into();
        assert_eq!(
            classify_auth_prompt("[OTP Code]: ", &auth),
            Some(PromptKind::Totp)
        );
        let answers = keyboard_interactive_answers(
            &auth,
            &mut KeyboardInteractiveState::first_factor_accepted(),
            "",
            &[prompt("[OTP Code]: ", false)],
        );
        assert_eq!(answers, vec!["654321".to_string()]);
        assert_ne!(answers[0], auth.password);

        // 内置密码模式仍然把真正的密码提问判成密码（提示词重叠不影响）。
        assert_eq!(
            classify_auth_prompt("<user>@root@host's password: ", &auth),
            Some(PromptKind::Password)
        );
    }

    /// 登录期 2FA 组合矩阵：流程模式 × 服务器提问形态 × 首因子是否已过。
    /// 每个用例用各自独立的静态码，避免进程级防重放台账把后一个用例吃掉。
    #[test]
    fn keyboard_interactive_combination_matrix() {
        let _otp_ledger = otp_ledger_test_guard();
        struct Case {
            mode: AuthFlowMode,
            first_factor: bool,
            context: &'static str,
            prompts: Vec<&'static str>,
            expect: Vec<&'static str>,
            code: &'static str,
        }
        let cases = vec![
            // off：密码类提问照答，OTP 永不自动回码（即使首因子已过）。
            Case {
                mode: AuthFlowMode::Off,
                first_factor: true,
                context: "",
                prompts: vec!["Password:"],
                expect: vec!["pw"],
                code: "111111",
            },
            Case {
                mode: AuthFlowMode::Off,
                first_factor: true,
                context: "",
                prompts: vec!["[OTP Code]: "],
                expect: vec![""],
                code: "222222",
            },
            // password_only：同上，只服务密码。
            Case {
                mode: AuthFlowMode::PasswordOnly,
                first_factor: true,
                context: "",
                prompts: vec!["[OTP Code]: "],
                expect: vec![""],
                code: "333333",
            },
            // 先密码再 OTP：首因子已过则回码；未过则留空（保护）。
            Case {
                mode: AuthFlowMode::PasswordThenOtp,
                first_factor: true,
                context: "",
                prompts: vec!["[OTP Code]: "],
                expect: vec!["444444"],
                code: "444444",
            },
            Case {
                mode: AuthFlowMode::PasswordThenOtp,
                first_factor: false,
                context: "",
                prompts: vec!["[OTP Code]: "],
                expect: vec![""],
                code: "555555",
            },
            // 合并提问（服务器把密码与验证码放一行）：+合并模式拼接，先密码再 OTP
            // 只回密码（服务器随后会再问一次验证码，属契约外兜底）。
            Case {
                mode: AuthFlowMode::PasswordPlusOtp,
                first_factor: false,
                context: "",
                prompts: vec!["Password: OTP Code: "],
                expect: vec!["pw888888"],
                code: "888888",
            },
            Case {
                mode: AuthFlowMode::PasswordThenOtp,
                first_factor: true,
                context: "",
                prompts: vec!["Password: OTP Code: "],
                expect: vec!["pw"],
                code: "666666",
            },
            // MFA 先问（反问顺序）：先密码再 OTP 留空；+合并模式不设密码门槛，回码。
            Case {
                mode: AuthFlowMode::PasswordThenOtp,
                first_factor: false,
                context: "",
                prompts: vec!["Please enter OTP code"],
                expect: vec![""],
                code: "121212",
            },
            Case {
                mode: AuthFlowMode::PasswordPlusOtp,
                first_factor: false,
                context: "",
                prompts: vec!["Please enter OTP code"],
                expect: vec!["131313"],
                code: "131313",
            },
            // 提问文案认不出时用挑战 name/instructions 兜底（koko 形状）。
            Case {
                mode: AuthFlowMode::PasswordThenOtp,
                first_factor: true,
                context: "Please Enter MFA Code.",
                prompts: vec!["Code: "],
                expect: vec!["141414"],
                code: "141414",
            },
        ];
        for case in cases {
            let auth = SudoAuth {
                password: "pw".into(),
                totp_secrets: parse_totp_secrets(case.code),
                password_prompt_hint: String::new(),
                totp_prompt_hint: String::new(),
                flow_mode: Some(case.mode),
                ..Default::default()
            };
            let mut state = if case.first_factor {
                KeyboardInteractiveState::first_factor_accepted()
            } else {
                KeyboardInteractiveState::default()
            };
            let prompts: Vec<_> = case
                .prompts
                .iter()
                .map(|text| prompt(text, false))
                .collect();
            let answers = keyboard_interactive_answers(&auth, &mut state, case.context, &prompts);
            let expected: Vec<String> = case.expect.iter().map(|text| text.to_string()).collect();
            assert_eq!(
                answers, expected,
                "mode={:?} first_factor={} prompts={:?} context={:?}",
                case.mode, case.first_factor, case.prompts, case.context
            );
        }

        // 同一轮内先密码、后验证码：in-round 提升，不依赖 partial success
        // （PAM 风格主机把密码放在 KI 里问）。
        let auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("151515"),
            password_prompt_hint: String::new(),
            totp_prompt_hint: String::new(),
            flow_mode: Some(AuthFlowMode::PasswordThenOtp),
            ..Default::default()
        };
        let mut state = KeyboardInteractiveState::default();
        let answers = keyboard_interactive_answers(
            &auth,
            &mut state,
            "",
            &[prompt("Password:", false), prompt("OTP Code: ", false)],
        );
        assert_eq!(answers, vec!["pw".to_string(), "151515".to_string()]);
    }

    #[test]
    fn terminal_auto_sudo_answers_sudo_password() {
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(terminal_auth())));
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw".to_string()))
        );
        // A shell prompt resets the auth sequence.
        assert_eq!(auto.observe("user@host:~$ "), None);
        // Direct sudo prompts keep working after the reset.
        assert_eq!(
            auto.observe("We trust you... [sudo] password for user:"),
            Some((AutoSudoKind::Password, "pw".to_string()))
        );
    }

    #[test]
    fn terminal_auto_sudo_requires_hints_for_generic_otp_prompts() {
        let _otp_ledger = otp_ledger_test_guard();
        // Without a custom hint, generic OTP prompts stay untouched.
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(terminal_auth())));
        assert_eq!(auto.observe("Verification code: "), None);

        // With a hint but password_then_otp mode, a standalone OTP prompt is
        // still skipped: the password must come first.
        let mut hinted = terminal_auth();
        hinted.totp_prompt_hint = "verification code".into();
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(hinted.clone())));
        assert_eq!(auto.observe("sudo: verification code: "), None);

        // password_plus_otp hosts ask for the OTP directly.
        hinted.flow_mode = Some(AuthFlowMode::PasswordPlusOtp);
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(hinted)));
        assert_eq!(
            auto.observe("sudo: verification code: "),
            Some((AutoSudoKind::Totp, "654321".to_string()))
        );
        // The OTP is only answered once per auth sequence.
        assert_eq!(auto.observe("sudo: verification code: "), None);
    }

    #[test]
    fn terminal_auto_sudo_answers_totp_after_sudo_password() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut auth = terminal_auth();
        auth.totp_prompt_hint = "verification code".into();
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(auth)));
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw".to_string()))
        );
        assert_eq!(
            auto.observe("verification code: "),
            Some((AutoSudoKind::Totp, "654321".to_string()))
        );
        // Shell prompt closes the sequence and re-arms everything.
        assert_eq!(auto.observe("user@host:~$ "), None);
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw".to_string()))
        );
    }

    #[test]
    fn terminal_auto_sudo_without_password_stays_silent() {
        let mut auth = terminal_auth();
        auth.password = String::new();
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(auth)));
        assert_eq!(auto.observe("[sudo] password for user: "), None);
    }

    // 并发同靶 sudo：同一 otp_ledger_scope 的另一个会话已提交当前窗口唯一的码，
    // 后到的 OTP 提示应推迟到窗口滚动后补答，而不是永远晾在提示符上。
    #[test]
    fn concurrent_same_target_otp_prompt_defers_then_answers_next_window() {
        let _otp_ledger = otp_ledger_test_guard();
        let mut auth = terminal_auth();
        auth.totp_prompt_hint = "verification code".into();
        auth.totp_secrets = vec![TotpSecret::Key {
            key: RFC_KEY.to_vec(),
            digits: 6,
            period: 30,
            algorithm: TotpAlgorithm::Sha1,
        }];
        let scope = auth.otp_ledger_scope.clone();
        let fingerprint = otp_secret_fingerprint(&auth.totp_secrets[0]);

        // 模拟会话 A：已提交当前窗口的码（提交账本在重放窗口内）。
        let now = unix_now();
        let period = 30u64;
        let counter = now / period;
        let code = hotp(RFC_KEY, counter, 6, TotpAlgorithm::Sha1);
        committed_otp_ledger()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                format!("{scope}|{fingerprint}|{code}"),
                totp_replay_window_expiry((counter + 1) * period, period),
            );

        // 会话 B：密码已答，OTP 提示撞上重放保护 → 跳过并进入推迟态。
        let mut auto = TerminalAutoSudo::new(Arc::new(RwLock::new(auth)));
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw".to_string()))
        );
        assert_eq!(auto.observe("verification code: "), None);
        // 窗口未滚动前不得补答。
        assert_eq!(auto.take_deferred_otp(now), None);

        // 窗口滚动：旧提交过期（回拨账本时间模拟时钟前进），推迟重试到期。
        let boundary = (counter + 1) * period + 1;
        committed_otp_ledger()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                format!("{scope}|{fingerprint}|{code}"),
                now.saturating_sub(1),
            );
        let answered = auto.take_deferred_otp(boundary);
        assert_eq!(answered.map(|(kind, _)| kind), Some(AutoSudoKind::Totp));
        // 推迟态一次性：补答后不再重复注入。
        assert_eq!(auto.take_deferred_otp(boundary), None);
    }

    #[test]
    fn shell_prompt_detection_matches_last_line() {
        assert!(has_shell_prompt("output line\nuser@host:~$ "));
        assert!(has_shell_prompt("root@host:~# "));
        assert!(!has_shell_prompt("[sudo] password for user:"));
        assert!(!has_shell_prompt(""));
    }

    #[test]
    fn parses_server_metrics_output() {
        let output = "\
hostname=web-01
kernel=6.1.0-18-amd64
loadavg=0.28 0.42 0.35 1/887 23456
uptime=987654.32 456789.01
nproc=8
--mem--
MemTotal:       16308856 kB
MemFree:        1234567 kB
MemAvailable:   12000000 kB
SwapTotal:      2047996 kB
SwapFree:       2047996 kB
--cpu--
cpu  100 0 200 8000 40 0 0 0 0 0
cpu  200 0 300 8100 40 0 0 0 0 0
--df--
/dev/sda1 51469868 23456780 25879924 48% /
tmpfs 8154428 0 8154428 0% /dev/shm
/dev/sdb1 103080888 53456780 44349988 55% /data
";
        let metrics = parse_metrics_output(output);
        assert_eq!(metrics["hostname"], "web-01");
        assert_eq!(metrics["cpu"]["cores"], 8);
        assert_eq!(metrics["cpu"]["load1"], 0.28);
        assert_eq!(metrics["uptimeSeconds"], 987654);
        // busy delta = (200-100)+(300-200) = 200; total delta = 200+100 = 300 → 66.7%
        assert_eq!(metrics["cpu"]["percent"], 66.7);
        assert_eq!(metrics["memory"]["totalBytes"], 16_308_856_u64 * 1024);
        assert_eq!(
            metrics["memory"]["usedBytes"],
            (16_308_856_u64 - 12_000_000) * 1024
        );
        assert_eq!(metrics["memory"]["swapUsedBytes"], 0);
        let disks = metrics["disks"].as_array().unwrap();
        assert_eq!(disks.len(), 3);
        assert_eq!(disks[1]["mount"], "/dev/shm");
        assert_eq!(disks[2]["percentUsed"], 55.0);
    }

    #[test]
    fn df_section_rejects_os_release_bleed() {
        // --os-- 段不被段切换识别，其内容会落在 --df-- 段里；
        // PRETTY_NAME 恰好 6 个字段，绝不能被解析成幽灵磁盘行。
        let output = "\
--df--
/dev/vda1 41022688 16785408 22573568 44% /
--os--
NAME=\"Alibaba Cloud Linux\"
PRETTY_NAME=\"Alibaba Cloud Linux release 3 (OpenAnolis)\"
";
        let metrics = parse_metrics_output(output);
        let disks = metrics["disks"].as_array().unwrap();
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0]["mount"], "/");
    }

    #[test]
    fn parses_disk_usage_for_a_path() {
        let usage = parse_disk_usage(
            "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1         51469868  23456780  25879924      48% /",
        )
        .unwrap();
        assert_eq!(usage["filesystem"], "/dev/sda1");
        assert_eq!(usage["mount"], "/");
        assert_eq!(usage["totalBytes"], 51_469_868_u64 * 1024);
        assert_eq!(usage["percentUsed"], 48.0);
        assert!(parse_disk_usage("no output").is_none());
    }

    #[test]
    fn parses_disk_usage_for_non_device_filesystems() {
        // Containers (overlay) and tmpfs mounts do not start with '/' —
        // found by the local_ubuntu MCP coverage pass against the
        // dbx-ssh-test container.
        let usage = parse_disk_usage(
            "Filesystem     1024-blocks      Used Available Capacity Mounted on\noverlay           91029504  76153516  14875988      84% /",
        )
        .unwrap();
        assert_eq!(usage["filesystem"], "overlay");
        assert_eq!(usage["mount"], "/");
        assert_eq!(usage["totalBytes"], 91_029_504_u64 * 1024);
        assert_eq!(usage["availableBytes"], 14_875_988_u64 * 1024);
        assert_eq!(usage["percentUsed"], 84.0);
    }

    #[test]
    fn shell_quotes_paths() {
        assert_eq!(shell_quote("/var/log/it's"), "'/var/log/it'\\''s'");
    }

    #[test]
    fn keepalive_failure_step_stops_after_two_consecutive_failures() {
        // Success resets the counter.
        assert_eq!(keepalive_failure_step(0, true), Some(0));
        assert_eq!(keepalive_failure_step(1, true), Some(0));
        // First failure keeps the loop alive, second one stops it.
        assert_eq!(keepalive_failure_step(0, false), Some(1));
        assert_eq!(keepalive_failure_step(1, false), None);
    }

    #[test]
    fn totp_replay_window_covers_the_one_step_slack() {
        // A 30s code valid until T stays blocked until T + one period.
        assert_eq!(totp_replay_window_expiry(1_000, 30), 1_030);
        assert_eq!(totp_replay_window_expiry(60, 90), 150);
        assert!(is_totp_in_replay_window(1_030, 1_030));
        assert!(!is_totp_in_replay_window(1_031, 1_030));
        assert!(is_totp_in_replay_window(500, 1_030));
    }

    #[test]
    fn take_totp_answer_skips_recommitted_codes_within_window() {
        let _otp_ledger = otp_ledger_test_guard();
        let auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("654321"),
            ..Default::default()
        };
        let first = auth.take_totp_answer().expect("first submission");
        assert_eq!(first, "654321");
        let error = auth.take_totp_answer().expect_err("replay must be skipped");
        assert!(
            error.contains("already submitted") && error.contains("replay window"),
            "{error}"
        );
        // answer_for routes through the same guard, so prompts inside the
        // window get no answer instead of a duplicated injection.
        assert_eq!(auth.answer_for(PromptKind::Totp), None);
    }

    #[test]
    fn committed_otp_state_shares_across_clones() {
        let _otp_ledger = otp_ledger_test_guard();
        let auth = SudoAuth {
            totp_secrets: parse_totp_secrets("334455"),
            ..Default::default()
        };
        assert!(auth.take_totp_answer().is_ok());
        let clone = auth.clone();
        let error = clone
            .take_totp_answer()
            .expect_err("clone shares the state");
        assert!(error.contains("already submitted"), "{error}");
    }
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    // The OTP usage/committed ledgers are process-global (MCP exec calls
    // resolve a fresh `SudoAuth` per call, so that is the point under
    // test). Each test holds the ledger guard so parallel tests neither
    // share marks nor wipe each other mid-run.

    #[test]
    fn parses_multiple_totp_secrets_across_separators() {
        let secrets = parse_totp_secrets("JBSWY3DPEHPK3PXP\nGEZDGNBVGY3TQOJQ; 123456\r\n");
        assert_eq!(secrets.len(), 3);
        assert!(parse_totp_secrets("  \n; ").is_empty());
    }

    #[test]
    fn rotating_totp_avoids_reusing_the_same_code() {
        let _otp_ledger = otp_ledger_test_guard();
        let auth = SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("JBSWY3DPEHPK3PXP\nGEZDGNBVGY3TQOJQ"),
            ..Default::default()
        };
        let first = auth.current_totp_selection().expect("code").code;
        let second = auth.current_totp_selection().expect("code").code;
        assert_ne!(
            first, second,
            "same-window second answer must use the other secret"
        );
        // Once every candidate is used we fall back instead of failing.
        let third = auth.current_totp_selection().expect("code").code;
        assert!(third == first || third == second);
    }

    /// Two `ssh_exec_sudo` calls never share a `SudoAuth` instance (each
    /// call resolves a fresh one), so rotation state must live in the
    /// process-global ledger: the second call inside the same window has to
    /// switch to another secret's unused code instead of resubmitting the
    /// first secret's already-used one, and once every code is used (and
    /// its replay window is open) the guard skips instead of replaying.
    #[test]
    fn otp_rotation_spans_separate_instances() {
        let _otp_ledger = otp_ledger_test_guard();
        let make_call = || SudoAuth {
            password: "pw".into(),
            totp_secrets: parse_totp_secrets("MFRGGZDFMZTWQ2LK\nNBSWY3DPEBLWCZ4A"),
            ..Default::default()
        };
        let first = make_call().take_totp_answer().expect("first call");
        let second = make_call()
            .take_totp_answer()
            .expect("second call must rotate to an unused secret");
        assert_ne!(first, second, "a used code must not be resubmitted");
        let error = make_call()
            .take_totp_answer()
            .expect_err("no unused code is left inside the replay window");
        assert!(error.contains("already submitted"), "{error}");
    }

    /// The committed-replay guard must also span instances: a second exec
    /// call in the same window sees the first call's submission instead of
    /// silently resubmitting the same code.
    #[test]
    fn committed_replay_guard_spans_separate_instances() {
        let _otp_ledger = otp_ledger_test_guard();
        let make_call = || SudoAuth {
            totp_secrets: parse_totp_secrets("778899"),
            ..Default::default()
        };
        assert!(make_call().take_totp_answer().is_ok());
        let error = make_call()
            .take_totp_answer()
            .expect_err("the second call must see the earlier submission");
        assert!(error.contains("already submitted"), "{error}");
    }

    /// Static codes have no aligned time window, so their usage marks must
    /// not be keyed on a per-call `now + window` timestamp: two calls two
    /// seconds apart still have to rotate between the two static secrets.
    #[test]
    fn static_code_usage_keys_do_not_drift_across_calls() {
        let _otp_ledger = otp_ledger_test_guard();
        let make_call = || SudoAuth {
            totp_secrets: parse_totp_secrets("111111\n222222"),
            ..Default::default()
        };
        let first = make_call().take_totp_answer().expect("first call");
        let second = make_call()
            .take_totp_answer()
            .expect("second call must rotate to the other static code");
        assert_ne!(first, second);
    }

    /// Two connections reusing one secret validate codes independently: the
    /// usage/replay marks are scoped per target, so host B can still submit
    /// in the same window the code host A already burned.
    #[test]
    fn otp_ledger_marks_do_not_leak_across_targets() {
        let _otp_ledger = otp_ledger_test_guard();
        let make_call = |scope: &str| SudoAuth {
            totp_secrets: parse_totp_secrets("667788"),
            otp_ledger_scope: scope.into(),
            ..Default::default()
        };
        assert!(make_call("a@h1:22").take_totp_answer().is_ok());
        assert!(
            make_call("b@h2:22").take_totp_answer().is_ok(),
            "host B must not inherit host A's replay guard"
        );
        let error = make_call("a@h1:22")
            .take_totp_answer()
            .expect_err("the same target stays guarded");
        assert!(error.contains("already submitted"), "{error}");
    }

    #[test]
    fn terminal_auto_sudo_reads_settings_updates_live() {
        let shared = Arc::new(RwLock::new(terminal_auth_for("pw1")));
        let mut auto = TerminalAutoSudo::new(shared.clone());
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw1".to_string()))
        );
        assert_eq!(auto.observe("user@host:~$ "), None);

        // Runtime settings update takes effect without recreating anything.
        shared
            .write()
            .unwrap_or_else(|poison| poison.into_inner())
            .password = "pw2".to_string();
        assert_eq!(
            auto.observe("[sudo] password for user: "),
            Some((AutoSudoKind::Password, "pw2".to_string()))
        );
    }

    #[test]
    fn sudo_auth_usefulness_drives_watcher_attach() {
        // No password and no TOTP: the connection cannot answer anything.
        assert!(!SudoAuth::default().useful());
        assert!(terminal_auth_for("").useful(), "TOTP alone is enough");
        assert!(terminal_auth_for("pw").useful());
    }

    /// A watcher never attached for a credential-less session (key-auth
    /// connect, nothing configured yet) must start answering once the user
    /// configures Quick Sudo at runtime — sync re-arms it from the updated
    /// shared auth instead of staying detached for the session's lifetime.
    #[test]
    fn terminal_auto_sudo_arms_after_late_configuration() {
        let shared = Arc::new(RwLock::new(SudoAuth::default()));
        // Pre-configuration: sync sees a useless auth and keeps no watcher,
        // so nothing answers the prompt.
        assert!(!shared.read().unwrap().useful());
        let mut watcher: Option<TerminalAutoSudo> = None;
        assert_eq!(
            watcher
                .as_mut()
                .and_then(|auto| auto.observe("[sudo] password for user: ")),
            None
        );

        // The user saves a sudo password + hint while the terminal is open;
        // sync_auto_sudo re-arms the watcher from the updated shared auth.
        {
            let mut auth = shared.write().unwrap();
            auth.password = "late-pw".to_string();
            auth.password_prompt_hint = "password for".to_string();
        }
        assert!(shared.read().unwrap().useful());
        watcher = Some(TerminalAutoSudo::new(shared.clone()));
        assert_eq!(
            watcher
                .as_mut()
                .and_then(|auto| auto.observe("[sudo] password for user: ")),
            Some((AutoSudoKind::Password, "late-pw".to_string()))
        );
    }

    fn terminal_auth_for(password: &str) -> SudoAuth {
        SudoAuth {
            password: password.to_string(),
            totp_secrets: parse_totp_secrets("654321"),
            ..Default::default()
        }
    }

    /// User setEnv entries win over built-in defaults on duplicate keys and
    /// every variable is requested exactly once (the merged list carries no
    /// duplicates), so the sudo channel cannot see the internal
    /// SUDO_ASKPASS clear clobber a user-configured value.
    #[test]
    fn merge_channel_env_user_entries_win_and_dedup() {
        let user = vec![
            ("LANG".to_string(), "C".to_string()),
            ("SUDO_ASKPASS".to_string(), "/tmp/askpass.sh".to_string()),
        ];
        let merged = merge_channel_env(&[("SUDO_ASKPASS", "")], &user);
        assert_eq!(
            merged,
            vec![
                ChannelEnv {
                    key: "SUDO_ASKPASS".to_string(),
                    value: "/tmp/askpass.sh".to_string(),
                    strict: true,
                },
                ChannelEnv {
                    key: "LANG".to_string(),
                    value: "C".to_string(),
                    strict: true,
                },
            ],
            "user value must replace the default and turn the entry strict"
        );
    }

    /// Without overlap the defaults keep their best-effort policy (default
    /// sshd configs commonly refuse SUDO_ASKPASS) and user entries are
    /// appended strict, in their configured order.
    #[test]
    fn merge_channel_env_keeps_defaults_lenient_and_user_strict() {
        let user = vec![("MY_APP_MODE".to_string(), "debug".to_string())];
        let merged = merge_channel_env(&[("SUDO_ASKPASS", "")], &user);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].key, "SUDO_ASKPASS");
        assert!(!merged[0].strict, "built-in defaults stay best-effort");
        assert_eq!(merged[1].key, "MY_APP_MODE");
        assert_eq!(merged[1].value, "debug");
        assert!(merged[1].strict, "user entries fail loudly when refused");
    }

    /// Empty inputs collapse to an empty request list: connections without
    /// setEnv must not emit any env request at all.
    #[test]
    fn merge_channel_env_empty_inputs_stay_empty() {
        assert!(merge_channel_env(&[], &[]).is_empty());
        let user = vec![("A".to_string(), "1".to_string())];
        assert_eq!(merge_channel_env(&[], &user).len(), 1);
    }
}
