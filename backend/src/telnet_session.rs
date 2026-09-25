//! Plain-text Telnet client sessions (RFC 854/855 subset, nyaterm-parity P2-3).
//!
//! Runtime layout mirrors `local_terminal.rs`: one entry per live session in
//! the runtime's own table (a Telnet connection carries a TCP stream and can
//! never live on the SSH `SessionEntry`), keystrokes arrive on the sequenced
//! binary channel `telnet/terminal/in/{sessionId}`, output answers on
//! `telnet/terminal/out/{sessionId}` with the shared 9-byte `TerminalFrame`
//! prefix backed by a [`ReplayBuffer`], and lifecycle changes surface as
//! `telnet/session/state` events (`connecting`/`connected`/`closed`/`error`).
//!
//! IAC handling is a hand-written byte state machine (zero new deps):
//! - `WILL ECHO`/`WILL SGA` → `DO`; `DO NAWS` → `WILL NAWS` (+ NAWS updates on
//!   resize); every other offer/request is politely declined (`DONT`/`WONT`);
//! - `IAC IAC` unescapes to a literal `0xFF` payload byte;
//! - the parser is chunk-crossing safe: an IAC sequence split across reads is
//!   completed from the next chunk (state machine, not per-chunk scans).
//!
//! Auto-login reuses the SSH expect-rule engine (`triggers.rs`) verbatim —
//! two input forms lower onto the same engine, so there is exactly one
//! matcher, one validator and one secret policy:
//! - **Rule form** (`autoLogin.rules`): the same tssh/JSON rule text the SSH
//!   side accepts, with `sendSecretKey` slots resolved from the start
//!   request's `secrets` array instead of the connection vault.
//! - **Declarative form** (`autoLogin.declarative`, NyaTerm-parity P0-1):
//!   username/password prompt regexes plus the credentials, success/failure
//!   regexes and a retry budget. The prompts become engine stages (username
//!   as plaintext `sendText`, password through the `trigger_answer_1` secret
//!   slot so it never appears in logs, events or `Debug`), while success and
//!   failure are supervised by [`DeclarativeWatch`] in the read loop: a
//!   failure hit re-arms answering against the retry budget (the host
//!   re-prompts; the engine cursor already wraps), a success hit after any
//!   answer publishes `telnet/auto_login {status:"success"}` (the workbench
//!   localizes the notice), and a failure hit past the budget closes the
//!   session into the existing exit overlay with a readable, content-free
//!   reason. Blank regex fields fall back to NyaTerm's built-in prompt
//!   vocabulary; every regex compiles through the shared `triggers` gate so
//!   an invalid pattern fails `telnet/start` with a readable error (D7).
//!
//! The decision/segment protocol is byte-identical to the SSH read loop
//! (`ssh/trigger` becomes `telnet/trigger` and never carries answer content).
//!
//! Safety note: Telnet is cleartext — credentials typed into it travel
//! unencrypted. The plugin surfaces that warning in the UI and never logs
//! keystrokes or auto-login answers.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use dbx_plugin_sdk::PluginEmitter;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, RwLock};

use crate::exec::strip_ansi_control_sequences;
use crate::model::TerminalStream;
use crate::ssh::ReplayBuffer;
use crate::triggers;

/// Dial timeout for the initial TCP connect (contract P2-3).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Telnet IAC escape byte.
pub const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
/// Negotiated options: echo, suppress-go-ahead, window-size (RFC 1073).
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_NAWS: u8 = 31;

/// Enter-key wire form: CRLF (default, most BBS/Unix line disciplines), bare
/// CR, or LF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EnterMode {
    #[default]
    Crlf,
    Cr,
    Lf,
}

impl EnterMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "crlf" => Some(Self::Crlf),
            "cr" => Some(Self::Cr),
            "lf" => Some(Self::Lf),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for EnterMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        EnterMode::parse(&value)
            .ok_or_else(|| serde::de::Error::custom("enterMode must be crlf, cr or lf"))
    }
}

/// Backspace wire form: DEL 0x7F (default, what xterm sends) or Ctrl+H 0x08
/// for hosts whose line discipline expects it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BackspaceMode {
    #[default]
    Del,
    CtrlH,
}

impl BackspaceMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "del" => Some(Self::Del),
            "ctrl_h" | "ctrlH" => Some(Self::CtrlH),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for BackspaceMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        BackspaceMode::parse(&value)
            .ok_or_else(|| serde::de::Error::custom("backspaceMode must be del or ctrl_h"))
    }
}

/// Converts one keyboard payload into the wire form the host expects:
/// backspace first (`0x7F` → `0x08` under `CtrlH`), then Enter (`\r` per
/// mode; an already-paired `\r\n` collapses to one Enter so CRLF mode cannot
/// double it). Pure — unit-tested below.
pub fn transform_input(data: &[u8], enter: EnterMode, backspace: BackspaceMode) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len() + 8);
    let mut previous_cr = false;
    for &byte in data {
        let byte = match (backspace, byte) {
            (BackspaceMode::CtrlH, 0x7f) => 0x08,
            (_, other) => other,
        };
        match byte {
            // One Enter per CR; a CR already followed by LF stays one Enter.
            0x0d => {
                previous_cr = true;
                match enter {
                    EnterMode::Crlf => {
                        output.push(0x0d);
                        output.push(0x0a);
                    }
                    EnterMode::Cr => output.push(0x0d),
                    EnterMode::Lf => output.push(0x0a),
                }
            }
            0x0a if previous_cr => {
                previous_cr = false;
            }
            other => {
                previous_cr = false;
                output.push(other);
            }
        }
    }
    output
}

/// Builds an RFC 1073 NAWS subnegotiation: `IAC SB NAWS <cols hi lo> <rows
/// hi lo> IAC SE`, with `0xFF` value bytes escaped as `IAC IAC`. Pure.
pub fn naws_frame(cols: u16, rows: u16) -> Vec<u8> {
    let mut frame = vec![IAC, SB, OPT_NAWS];
    for half in [cols, rows] {
        let [hi, lo] = half.to_be_bytes();
        for byte in [hi, lo] {
            if byte == IAC {
                frame.push(IAC);
            }
            frame.push(byte);
        }
    }
    frame.extend_from_slice(&[IAC, SE]);
    frame
}

/// Parser states. `Ground` passes payload bytes through; the rest consume an
/// in-flight IAC sequence that may span chunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum ParseState {
    #[default]
    Ground,
    /// IAC seen; the next byte selects the sequence shape.
    Iac,
    /// WILL/WONT/DO/DONT seen; `verb` holds the request byte.
    Negotiation { verb: u8 },
    /// Inside `SB <option> ... SE` — every byte until the closing `SE` is
    /// swallowed (the plugin never inspects subnegotiation content).
    Subnegotiation,
    /// IAC inside a subnegotiation: `SE` closes, `IAC IAC` is a literal
    /// 0xFF value byte, anything else is malformed and resynchronizes.
    SubnegotiationIac,
}

/// Streaming IAC stripper. Feeds wire chunks in, yields application payload
/// bytes plus negotiation reply bytes. The state machine lives across
/// `feed` calls, so sequences broken across TCP segments parse correctly.
#[derive(Debug, Default)]
pub struct TelnetParser {
    state: ParseState,
}

impl TelnetParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consumes one wire chunk; returns `(payload, replies)`.
    pub fn feed(&mut self, chunk: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut payload = Vec::with_capacity(chunk.len());
        let mut replies = Vec::new();
        for &byte in chunk {
            match self.state {
                ParseState::Ground => match byte {
                    IAC => self.state = ParseState::Iac,
                    other => payload.push(other),
                },
                ParseState::Iac => {
                    self.state = match byte {
                        IAC => {
                            // IAC IAC → literal 0xFF payload byte.
                            payload.push(IAC);
                            ParseState::Ground
                        }
                        WILL | WONT | DO | DONT => ParseState::Negotiation { verb: byte },
                        SB => ParseState::Subnegotiation,
                        // NOP / other one-byte commands: swallowed silently.
                        _ => ParseState::Ground,
                    };
                }
                ParseState::Negotiation { verb } => {
                    self.state = ParseState::Ground;
                    let option = byte;
                    match (verb, option) {
                        (WILL, OPT_ECHO) | (WILL, OPT_SGA) => {
                            replies.extend_from_slice(&[IAC, DO, option]);
                        }
                        (WILL, _) => replies.extend_from_slice(&[IAC, DONT, option]),
                        (DO, OPT_NAWS) => replies.extend_from_slice(&[IAC, WILL, option]),
                        (DO, _) => replies.extend_from_slice(&[IAC, WONT, option]),
                        // Peer refusals (WONT/DONT) need no answer.
                        _ => {}
                    }
                }
                ParseState::Subnegotiation => {
                    if byte == IAC {
                        self.state = ParseState::SubnegotiationIac;
                    }
                }
                ParseState::SubnegotiationIac => {
                    self.state = match byte {
                        SE => ParseState::Ground,
                        IAC => ParseState::Subnegotiation,
                        // Malformed: resynchronize at ground state.
                        _ => ParseState::Ground,
                    };
                }
            }
        }
        (payload, replies)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetStartRequest {
    pub connection_id: Option<String>,
    pub workbench_id: String,
    /// Logical endpoint retained for identity and display.
    pub host: String,
    /// Logical endpoint port. Defaults to 23.
    pub port: Option<u16>,
    /// Runtime endpoint supplied by the host transport; it is the only target
    /// dialed by the TCP pump. Missing fields fall back to the logical endpoint.
    pub runtime_host: Option<String>,
    pub runtime_port: Option<u16>,
    pub enter_mode: Option<EnterMode>,
    pub backspace_mode: Option<BackspaceMode>,
    /// Initial window size for the first NAWS frame; the workbench sends its
    /// real size right after start anyway.
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    /// Optional auto-login, in exactly one of two forms (both validated
    /// before the dial — D7: invalid configuration fails the start with a
    /// readable error and never degrades silently).
    pub auto_login: Option<AutoLoginSpec>,
}

/// Auto-login request: either expect `rules` (tssh/JSON grammar) or the
/// NyaTerm-style `declarative` prompt/credential form — mutually exclusive.
/// Secrets travel as request values only; `Debug` redacts them so no log or
/// panic message can ever carry a credential.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoLoginSpec {
    /// tssh text form, JSON string form or raw JSON object form — exactly the
    /// shapes `triggers/validate` accepts.
    pub rules: Option<Value>,
    /// Slot values for `trigger_answer_1` / `trigger_answer_2`, in order.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// Declarative form (P0-1): prompt regexes + credentials + success /
    /// failure detection + retry budget.
    pub declarative: Option<DeclarativeAutoLogin>,
}

impl fmt::Debug for AutoLoginSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AutoLoginSpec")
            .field("rules", &self.rules)
            .field("secrets", &"<redacted>")
            .field("declarative", &self.declarative)
            .finish()
    }
}

/// NyaTerm-parity declarative login config (`TelnetAutoLoginConfig` minus the
/// knobs the dialog does not expose). Regexes are optional — blank falls back
/// to the built-in prompt vocabulary ([`DECL_USERNAME_PROMPT_DEFAULT`] and
/// friends). `Debug` redacts the password.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativeAutoLogin {
    pub username: Option<String>,
    pub password: Option<String>,
    pub username_prompt_regex: Option<String>,
    pub password_prompt_regex: Option<String>,
    pub success_regex: Option<String>,
    pub failure_regex: Option<String>,
    pub max_retries: Option<u8>,
}

impl fmt::Debug for DeclarativeAutoLogin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeclarativeAutoLogin")
            .field("username", &self.username.as_ref().map(|_| "<set>"))
            .field("password", &"<redacted>")
            .field("usernamePromptRegex", &self.username_prompt_regex)
            .field("passwordPromptRegex", &self.password_prompt_regex)
            .field("successRegex", &self.success_regex)
            .field("failureRegex", &self.failure_regex)
            .field("maxRetries", &self.max_retries)
            .finish()
    }
}

/// Built-in prompt vocabulary, mirroring NyaTerm's default regexes so a
/// declarative config works without any pattern field filled in. Matched
/// with the same regex engine the expect stages use (substring `find`
/// semantics over a rolling tail).
///
/// Both defaults are end-anchored (NyaTerm `auto_login.rs` matches its
/// defaults against line candidates the same way): a live prompt is keyword +
/// punctuation + only whitespace up to the end of the rolling buffer. A
/// `Last login: <time>` MOTD banner therefore cannot trigger an answer — the
/// trailing timestamp breaks `\s*$` — which is NyaTerm's explicit
/// `last_login_regex` exclusion expressed structurally (the Rust `regex`
/// engine has no look-around for a line-start negative guard, and a `^` anchor
/// would miss prompts split across chunk boundaries, where the per-chunk
/// normalization trims the separating newline). A banner line consisting of
/// only `Last login:` with the timestamp on the next line would still match —
/// the same unavoidable fused-line behavior NyaTerm's last-line exclusion
/// tolerates — but that banner shape does not occur in practice.
const DECL_USERNAME_PROMPT_DEFAULT: &str = r#"(?i)(?:user\s*name|username|login|logon|account|userid|user\s*id|用户名|帐号|账号|登录|登入)\s*[:：>]\s*$"#;
const DECL_PASSWORD_PROMPT_DEFAULT: &str =
    r#"(?i)(?:password|passwd|passcode|passphrase|pin|密码|口令)\s*[:：>]\s*$"#;
const DECL_SUCCESS_DEFAULT: &str = r#"[$#>]\s*$"#;
const DECL_FAILURE_DEFAULT: &str =
    r#"(?i)(login\s+incorrect|authentication\s+failed|access\s+denied|密码错误|认证失败)"#;
/// Retry budget ceiling: NyaTerm is `u8`-unbounded; the plugin caps the
/// abuse surface (each retry re-sends credentials).
const DECL_MAX_RETRIES: u8 = 10;
/// Watch rolling tail cap in chars: enough context for prompt/failure
/// regexes without unbounded growth on chatty banners.
const DECL_WATCH_TAIL_CHARS: usize = 4096;

/// A parsed auto-login request: the expect-engine configuration (both forms
/// lower onto it) plus, for the declarative form, the success/failure/retry
/// supervision the engine itself does not model.
#[derive(Debug)]
pub struct AutoLoginPlan {
    pub triggers: triggers::TriggersConfig,
    pub watch: Option<DeclarativeWatch>,
}

/// Per-connection auto-login runtime owned by the read loop.
struct AutoLoginRuntime {
    engine: triggers::TriggerEngine,
    watch: Option<DeclarativeWatch>,
}

enum TelnetCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct TelnetSession {
    connection_id: Option<String>,
    workbench_id: String,
    host: String,
    port: u16,
    runtime_host: String,
    runtime_port: u16,
    created_at_secs: u64,
    cmd_tx: mpsc::Sender<TelnetCommand>,
    replay: Arc<tokio::sync::Mutex<ReplayBuffer>>,
}

pub struct TelnetSessionRuntime {
    sessions: Arc<RwLock<HashMap<String, Arc<TelnetSession>>>>,
}

/// Resolves the auto-login spec into a validated [`AutoLoginPlan`]. The rule
/// form maps its secrets closure onto the protocol's fixed slot names
/// (`trigger_answer_N` = `secrets[N-1]`) so the shared `parse_triggers`
/// validation (unknown slot, empty slot) applies unchanged; the declarative
/// form is lowered in [`parse_declarative_auto_login`]. The two forms are
/// mutually exclusive — sending both is a configuration error (D7).
pub fn parse_auto_login(spec: &AutoLoginSpec) -> Result<Option<AutoLoginPlan>, String> {
    if spec.rules.is_some() && spec.declarative.is_some() {
        return Err(
            "telnet/start: autoLogin.rules and autoLogin.declarative are mutually exclusive"
                .to_string(),
        );
    }
    if let Some(declarative) = &spec.declarative {
        return parse_declarative_auto_login(declarative);
    }
    let slots = spec.secrets.clone();
    Ok(
        triggers::parse_triggers(spec.rules.as_ref(), &move |key| match key {
            "trigger_answer_1" => slots.first().filter(|value| !value.is_empty()).cloned(),
            "trigger_answer_2" => slots.get(1).filter(|value| !value.is_empty()).cloned(),
            _ => None,
        })?
        .map(|triggers| AutoLoginPlan {
            triggers,
            watch: None,
        }),
    )
}

/// Lowers the NyaTerm-style declarative form onto the shared expect engine:
/// username → plaintext stage, password → `trigger_answer_1` secret stage
/// (redacted in `Debug`, never logged, its value only ever lives in the send
/// plan). Prompt regexes compile through the shared triggers gate so invalid
/// patterns fail the start with a readable error naming the dialog field;
/// success/failure regexes build the [`DeclarativeWatch`].
fn parse_declarative_auto_login(
    declarative: &DeclarativeAutoLogin,
) -> Result<Option<AutoLoginPlan>, String> {
    let username = declarative.username.as_deref().unwrap_or("").trim();
    let password = declarative.password.as_deref().unwrap_or("");
    if username.is_empty() && password.is_empty() {
        return Err(
            "telnet/start: autoLogin.declarative needs at least a username or a password to send"
                .to_string(),
        );
    }
    let max_retries = declarative.max_retries.unwrap_or(0);
    if max_retries > DECL_MAX_RETRIES {
        return Err(format!(
            "telnet/start: autoLogin.maxRetries must be between 0 and {DECL_MAX_RETRIES}, got {max_retries}"
        ));
    }
    let username_pattern = decl_pattern_text(
        declarative.username_prompt_regex.as_deref(),
        "usernamePromptRegex",
        DECL_USERNAME_PROMPT_DEFAULT,
    )?;
    let password_pattern = decl_pattern_text(
        declarative.password_prompt_regex.as_deref(),
        "passwordPromptRegex",
        DECL_PASSWORD_PROMPT_DEFAULT,
    )?;

    let mut stages = Vec::new();
    if !username.is_empty() {
        stages.push(json!({
            "pattern": username_pattern,
            "sendText": format!("{username}\r"),
        }));
    }
    if !password.is_empty() {
        stages.push(json!({
            "pattern": password_pattern,
            "sendSecretKey": "trigger_answer_1",
        }));
    }
    // Username or password is non-empty above, so the stage list can never
    // be empty and `parse_triggers` cannot answer `Ok(None)` here.
    let password_slot = password.to_string();
    let triggers_config = triggers::parse_triggers(Some(&json!({ "stages": stages })), &|key| {
        match key {
            "trigger_answer_1" if !password_slot.is_empty() => Some(password_slot.clone()),
            _ => None,
        }
    })?
    .ok_or_else(|| "telnet/start: autoLogin.declarative lowered to no login stages".to_string())?;

    let success = decl_regex(
        declarative.success_regex.as_deref(),
        "successRegex",
        DECL_SUCCESS_DEFAULT,
    )?;
    let failure = decl_regex(
        declarative.failure_regex.as_deref(),
        "failureRegex",
        DECL_FAILURE_DEFAULT,
    )?;

    Ok(Some(AutoLoginPlan {
        triggers: triggers_config,
        watch: Some(DeclarativeWatch::new(success, failure, max_retries)),
    }))
}

/// Resolves one optional declarative pattern field to its effective text:
/// blank/absent falls back to the built-in default, a custom value passes the
/// shared [`triggers::validate_pattern_text`] gate (length ceiling + regex
/// dialect) so an invalid pattern fails with the field name prefixed.
fn decl_pattern_text(value: Option<&str>, field: &str, default: &str) -> Result<String, String> {
    match value.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => triggers::validate_pattern_text(text)
            .map(|_| text.to_string())
            .map_err(|error| format!("telnet/start: autoLogin.{field}: {error}")),
        None => Ok(default.to_string()),
    }
}

/// Compiles one optional watch regex (success/failure): same blank-falls-back
/// to the NyaTerm default rule as [`decl_pattern_text`].
fn decl_regex(value: Option<&str>, field: &str, default: &str) -> Result<Regex, String> {
    let custom = match value.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => {
            triggers::validate_pattern_text(text)
                .map_err(|error| format!("telnet/start: autoLogin.{field}: {error}"))?;
            Some(text)
        }
        None => None,
    };
    let pattern = custom.map_or_else(|| default.to_string(), str::to_string);
    Regex::new(&pattern).map_err(|error| format!("telnet/start: autoLogin.{field}: {error}"))
}

/// What the declarative supervision decided after one output chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// Success regex matched after at least one prompt answer: the login is
    /// complete, supervision and answering stop.
    Success,
    /// Failure regex matched within budget: the host will re-prompt and the
    /// engine re-answers; `attempt` is the 1-based re-send round.
    Retry { attempt: u8 },
    /// Failure hit past the retry budget: the session closes into the exit
    /// overlay with a readable reason.
    Exhausted,
}

/// Success/failure/retry supervision for the declarative form (NyaTerm
/// `TelnetAutoLogin` semantics with prompt answering delegated to the shared
/// expect engine). A small rolling tail gives anchored success patterns like
/// `[$#>]\s*$` a stable end-of-buffer to match against; failure detection
/// runs regardless of whether an answer went out, success only after one did
/// (NyaTerm's `sent_username || sent_password` guard).
pub struct DeclarativeWatch {
    success: Regex,
    failure: Regex,
    max_retries: u8,
    retries: u8,
    tail: String,
    state: WatchState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchState {
    Active,
    Completed,
    Failed,
}

impl fmt::Debug for DeclarativeWatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The tail holds host output only, but it is still terminal content —
        // report its size, never its text.
        formatter
            .debug_struct("DeclarativeWatch")
            .field("max_retries", &self.max_retries)
            .field("retries", &self.retries)
            .field("tail_chars", &self.tail.chars().count())
            .field("state", &self.state)
            .finish()
    }
}

impl DeclarativeWatch {
    fn new(success: Regex, failure: Regex, max_retries: u8) -> Self {
        Self {
            success,
            failure,
            max_retries,
            retries: 0,
            tail: String::new(),
            state: WatchState::Active,
        }
    }

    /// Feeds one output chunk. `answered` tells whether at least one prompt
    /// answer went out this session (arms the success check).
    pub fn observe(&mut self, text: &str, answered: bool) -> Option<WatchEvent> {
        if self.state != WatchState::Active {
            return None;
        }
        self.push_tail(text);
        // Failure takes precedence over success/prompts (NyaTerm order): a
        // rejection banner that happens to end in a prompt must count as a
        // failure, not re-trigger an answer into a dead session.
        if self.failure.is_match(&self.tail) {
            if self.retries < self.max_retries {
                self.retries += 1;
                // Clear the tail so the same failure text cannot re-count on
                // every subsequent chunk (NyaTerm clears its window too).
                self.tail.clear();
                return Some(WatchEvent::Retry {
                    attempt: self.retries,
                });
            }
            self.state = WatchState::Failed;
            return Some(WatchEvent::Exhausted);
        }
        if answered && self.success.is_match(&self.tail) {
            self.state = WatchState::Completed;
            return Some(WatchEvent::Success);
        }
        None
    }

    /// Initial attempt plus the re-send rounds used so far; the readable
    /// close reason reports this when the budget is exhausted.
    pub fn attempts_used(&self) -> u8 {
        self.retries.saturating_add(1)
    }

    fn push_tail(&mut self, text: &str) {
        self.tail.push_str(text);
        let overflow = self
            .tail
            .chars()
            .count()
            .saturating_sub(DECL_WATCH_TAIL_CHARS);
        if overflow > 0 {
            self.tail = self.tail.chars().skip(overflow).collect();
        }
    }
}

impl TelnetSessionRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Opens a Telnet session: registers the table entry immediately (so the
    /// UI can bind its terminal), then the pump dials the host with the 10s
    /// timeout and publishes `connecting` → `connected`/`error` state events.
    pub async fn start(
        &self,
        request: TelnetStartRequest,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let host = request.host.trim().to_string();
        if host.is_empty() {
            return Err("telnet/start: host is required".to_string());
        }
        let port = request.port.unwrap_or(23);
        if port == 0 {
            return Err("telnet/start: port must be between 1 and 65535".to_string());
        }
        let runtime_host = request
            .runtime_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(host.as_str())
            .to_string();
        let runtime_port = request.runtime_port.unwrap_or(port);
        if runtime_port == 0 {
            return Err("telnet/start: runtimePort must be between 1 and 65535".to_string());
        }
        let cols = request.cols.unwrap_or(120).clamp(2, u16::MAX as u32) as u16;
        let rows = request.rows.unwrap_or(32).clamp(2, u16::MAX as u32) as u16;
        let enter_mode = request.enter_mode.unwrap_or_default();
        let backspace_mode = request.backspace_mode.unwrap_or_default();
        // Invalid auto-login configuration fails the start (SSH D7 contract:
        // never degrade silently) — and the error text is configuration
        // feedback, it never includes secret values.
        let auto_login_plan = match &request.auto_login {
            Some(spec) => parse_auto_login(spec)?,
            None => None,
        };
        let session_id = uuid::Uuid::new_v4().to_string();
        let replay = Arc::new(tokio::sync::Mutex::new(ReplayBuffer::default()));
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        self.sessions.write().await.insert(
            session_id.clone(),
            Arc::new(TelnetSession {
                connection_id: request.connection_id.clone(),
                workbench_id: request.workbench_id.clone(),
                host: host.clone(),
                port,
                runtime_host: runtime_host.clone(),
                runtime_port,
                created_at_secs: unix_now_secs(),
                cmd_tx,
                replay: replay.clone(),
            }),
        );
        spawn_pump(
            session_id.clone(),
            request.workbench_id,
            host.clone(),
            port,
            runtime_host,
            runtime_port,
            cols,
            rows,
            enter_mode,
            backspace_mode,
            auto_login_plan,
            cmd_rx,
            replay,
            emitter,
            self.sessions.clone(),
        );
        Ok(json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
        }))
    }

    async fn session(&self, session_id: &str) -> Result<Arc<TelnetSession>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Telnet session was not found".to_string())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        self.session(session_id)
            .await?
            .cmd_tx
            .send(TelnetCommand::Resize {
                cols: cols.clamp(1, u16::MAX as u32) as u16,
                rows: rows.clamp(1, u16::MAX as u32) as u16,
            })
            .await
            .map_err(|_| "Telnet session is closed".to_string())
    }

    pub async fn replay(
        &self,
        session_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let replay = session.replay.lock().await;
        let first_available_sequence = replay.first_sequence();
        let tail_sequence = replay.tail_sequence();
        let frames = replay.after(after_sequence);
        drop(replay);
        for frame in &frames {
            emitter
                .binary(
                    &format!("telnet/terminal/out/{session_id}"),
                    &frame.encode(),
                )
                .map_err(|error| error.message)?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": after_sequence.saturating_add(1) >= first_available_sequence
        }))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("Telnet session was not found")?;
        let _ = session.cmd_tx.send(TelnetCommand::Close).await;
        Ok(())
    }

    /// Closing a workbench tears down its Telnet sessions (same contract as
    /// the local shells); a webview reload does NOT pass through here.
    pub async fn close_connection(&self, connection_id: &str) {
        let session_ids: Vec<String> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.connection_id.as_deref() == Some(connection_id))
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in session_ids {
            let _ = self.close(&session_id).await;
        }
    }

    pub async fn close_workbench(&self, workbench_id: &str) {
        let session_ids: Vec<String> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.workbench_id == workbench_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in session_ids {
            let _ = self.close(&session_id).await;
        }
    }

    /// Read-only inventory of live Telnet sessions (workbench reattach hook).
    pub async fn list(&self) -> Value {
        let sessions = self.sessions.read().await;
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, session)| {
                json!({
                    "sessionId": session_id,
                    "connectionId": session.connection_id,
                    "workbenchId": session.workbench_id,
                    "host": session.host,
                    "port": session.port,
                    "runtimeHost": session.runtime_host,
                    "runtimePort": session.runtime_port,
                    "createdAt": session.created_at_secs,
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

    /// Keyboard input from the SDK's blocking binary-handler thread; the
    /// bounded channel applies backpressure instead of dropping keystrokes.
    /// The same entry point serves the `telnet/write` JSON fallback.
    pub fn write_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        // Do not hold the session-map read guard while applying backpressure:
        // closing a dead session needs the write lock to drop the receiver.
        let cmd_tx = {
            let sessions = self.sessions.blocking_read();
            sessions
                .get(session_id)
                .map(|session| session.cmd_tx.clone())
                // Same string contract as the SSH/local mirrors — the
                // workbench's dead-session detection matches on this error.
                .ok_or("Telnet session was not found or expired")?
        };
        cmd_tx
            .blocking_send(TelnetCommand::Input(data))
            .map_err(|error| format!("Telnet session input queue is closed: {error}"))
    }
}

async fn publish_telnet_output(
    session_id: &str,
    stream: TerminalStream,
    data: Vec<u8>,
    replay: &Arc<tokio::sync::Mutex<ReplayBuffer>>,
    emitter: &PluginEmitter,
) {
    let frame = replay.lock().await.push(stream, data);
    if let Err(error) = emitter.binary(
        &format!("telnet/terminal/out/{session_id}"),
        &frame.encode(),
    ) {
        eprintln!(
            "[ssh-sftp-plugin] telnet output publish failed: {}",
            error.message
        );
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Applies one trigger decision's segments exactly like the SSH read loop:
/// command answers run locally first (their trimmed stdout becomes the
/// answer), then segments are written with `sleepMs` pacing. Returns `true`
/// when anything was sent (a timeout counts as handled; a failed command
/// sends nothing).
async fn apply_trigger_decision(
    write_half: &mut tokio::net::tcp::OwnedWriteHalf,
    decision: &triggers::TriggerDecision,
    placeholders: &triggers::CommandPlaceholders,
    pacing: (u64, triggers::PassSleep),
) -> std::io::Result<bool> {
    let segments = match decision.kind {
        triggers::TriggerKind::Command => {
            let Some(command) = decision.command.as_deref() else {
                return Ok(false);
            };
            match triggers::run_credential_command(command, placeholders).await {
                Ok(answer) => triggers::pass_sleep_segments(&answer, pacing.0, pacing.1),
                Err(error) => {
                    // Failure reasons only — never the answer content.
                    eprintln!("[telnet] trigger stage {}: {error}", decision.stage);
                    return Ok(false);
                }
            }
        }
        _ => decision.segments.clone(),
    };
    let mut answered = matches!(decision.kind, triggers::TriggerKind::Timeout);
    for (payload, delay_ms) in &segments {
        if *delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
        }
        write_half.write_all(payload).await?;
        answered = true;
    }
    Ok(answered)
}

/// Owns one Telnet TCP connection: dials with the 10s timeout, pumps output
/// through the IAC parser (plus the expect engine), serves workbench commands
/// and tears down on peer close/close command/any write failure.
#[allow(clippy::too_many_arguments)]
fn spawn_pump(
    session_id: String,
    workbench_id: String,
    host: String,
    port: u16,
    runtime_host: String,
    runtime_port: u16,
    cols: u16,
    rows: u16,
    enter_mode: EnterMode,
    backspace_mode: BackspaceMode,
    auto_login_plan: Option<AutoLoginPlan>,
    mut cmd_rx: mpsc::Receiver<TelnetCommand>,
    replay: Arc<tokio::sync::Mutex<ReplayBuffer>>,
    emitter: PluginEmitter,
    sessions: Arc<RwLock<HashMap<String, Arc<TelnetSession>>>>,
) {
    tokio::spawn(async move {
        let emit_state = |state: &str, error: Option<String>| {
            let mut payload = json!({
                "sessionId": session_id,
                "workbenchId": workbench_id,
                "state": state,
            });
            if let Some(error) = error {
                payload["error"] = Value::String(error);
            }
            emitter.event("telnet/session/state", payload)
        };
        let _ = emit_state("connecting", None);
        let stream = match tokio::time::timeout(
            CONNECT_TIMEOUT,
            TcpStream::connect((runtime_host.as_str(), runtime_port)),
        )
        .await
        {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                let _ = emit_state(
                    "error",
                    Some(format!("connect {runtime_host}:{runtime_port}: {error}")),
                );
                let _ = emit_state("closed", None);
                sessions.write().await.remove(&session_id);
                return;
            }
            Err(_) => {
                let _ = emit_state(
                    "error",
                    Some(format!(
                        "connect {runtime_host}:{runtime_port} timed out after 10s"
                    )),
                );
                let _ = emit_state("closed", None);
                sessions.write().await.remove(&session_id);
                return;
            }
        };
        let _ = emit_state("connected", None);

        let (mut read_half, mut write_half) = stream.into_split();
        // 首帧 NAWS：对端声明 DO NAWS 后窗口尺寸就有意义了，尽力而为
        // （未协商时多数实现直接忽略 SB NAWS）。
        let _ = write_half.write_all(&naws_frame(cols, rows)).await;
        // Reader task → unbounded channel, so the select loop never blocks a
        // read against command handling (mirrors the local PTY pump).
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 8192];
            loop {
                match read_half.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if out_tx.send(buffer[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });

        let mut parser = TelnetParser::new();
        let mut auto_login: Option<AutoLoginRuntime> =
            auto_login_plan.map(|plan| AutoLoginRuntime {
                engine: triggers::TriggerEngine::new(
                    plan.triggers,
                    triggers::CommandPlaceholders::new(&host, "", port, &host),
                ),
                watch: plan.watch,
            });
        // Armed once the first prompt answer goes out: the declarative watch
        // only treats a success pattern as "logged in" after we answered
        // something (NyaTerm's `sent_username || sent_password` guard).
        let mut answered_stages = false;
        let mut closing_reason: Option<String> = None;
        loop {
            tokio::select! {
                chunk = out_rx.recv() => {
                    let Some(chunk) = chunk else {
                        closing_reason.get_or_insert_with(|| "peer closed".to_string());
                        break;
                    };
                    let (payload, replies) = parser.feed(&chunk);
                    if !replies.is_empty() && write_half.write_all(&replies).await.is_err() {
                        closing_reason.get_or_insert_with(|| "write failed".to_string());
                        break;
                    }
                    if payload.is_empty() {
                        continue;
                    }
                    let chunk_text = String::from_utf8_lossy(&payload).into_owned();
                    publish_telnet_output(
                        &session_id,
                        TerminalStream::Stdout,
                        payload,
                        &replay,
                        &emitter,
                    )
                    .await;
                    // Declarative supervision first: failure takes precedence
                    // over answering further prompts (NyaTerm order), so a
                    // rejection banner never feeds the expect engine. The
                    // watch matches anchored success/failure regexes on this
                    // text, so ANSI escapes are stripped first (NyaTerm's
                    // `strip_ansi_escapes`): a colored `$ ` prompt still hits
                    // `[$#>]\s*$`. Only the matching window is cleaned — the
                    // published payload above stays the raw bytes.
                    let watch_event = auto_login
                        .as_mut()
                        .and_then(|runtime| runtime.watch.as_mut())
                        .and_then(|watch| {
                            watch.observe(&strip_ansi_control_sequences(&chunk_text), answered_stages)
                        });
                    match watch_event {
                        // D6: the event carries the outcome only — never the
                        // matched text, never an answer.
                        Some(WatchEvent::Retry { attempt }) => {
                            // 重试轮次立即把引擎游标归位到第一阶段（NyaTerm
                            // 重置 sent_username/sent_password 的对应物）：
                            // 失败可能发生在序列中途（用户名已发、密码未达），
                            // 归位后宿主重印 login: 即从用户名重新应答。
                            if let Some(runtime) = auto_login.as_mut() {
                                runtime.engine.reset(unix_now_ms());
                            }
                            let _ = emitter.event(
                                "telnet/auto_login",
                                json!({ "sessionId": session_id, "status": "retry", "attempt": attempt }),
                            );
                        }
                        Some(WatchEvent::Success) => {
                            let _ = emitter.event(
                                "telnet/auto_login",
                                json!({ "sessionId": session_id, "status": "success" }),
                            );
                            // Login complete: stop answering and supervising
                            // (NyaTerm's Complete state), the user takes over.
                            auto_login = None;
                        }
                        Some(WatchEvent::Exhausted) => {
                            let attempts = auto_login
                                .as_ref()
                                .and_then(|runtime| runtime.watch.as_ref())
                                .map(DeclarativeWatch::attempts_used)
                                .unwrap_or(1);
                            closing_reason.get_or_insert_with(|| {
                                format!(
                                    "auto-login failed: host rejected the login after {attempts} attempt(s)"
                                )
                            });
                            break;
                        }
                        None => {}
                    }
                    if let Some(runtime) = auto_login.as_mut() {
                        let hit = runtime.engine.observe(&chunk_text, unix_now_ms()).map(|decision| {
                            (decision, runtime.engine.placeholders().clone(), runtime.engine.pacing())
                        });
                        if let Some((decision, placeholders, pacing)) = hit {
                            match apply_trigger_decision(
                                &mut write_half,
                                &decision,
                                &placeholders,
                                pacing,
                            )
                            .await
                            {
                                // D6: the event never carries answer content.
                                Ok(true) => {
                                    answered_stages = true;
                                    let _ = emitter.event(
                                        "telnet/trigger",
                                        json!({
                                            "sessionId": session_id,
                                            "stage": decision.stage,
                                            "kind": decision.kind.name(),
                                        }),
                                    );
                                }
                                Ok(false) => {}
                                Err(_) => {
                                    closing_reason.get_or_insert_with(|| "write failed".to_string());
                                    break;
                                }
                            }
                        }
                    }
                }
                command = cmd_rx.recv() => match command {
                    Some(TelnetCommand::Input(data)) => {
                        let wire = transform_input(&data, enter_mode, backspace_mode);
                        if !wire.is_empty() && write_half.write_all(&wire).await.is_err() {
                            closing_reason.get_or_insert_with(|| "write failed".to_string());
                            break;
                        }
                    }
                    Some(TelnetCommand::Resize { cols, rows }) => {
                        let frame = naws_frame(cols, rows);
                        if write_half.write_all(&frame).await.is_err() {
                            closing_reason.get_or_insert_with(|| "write failed".to_string());
                            break;
                        }
                    }
                    Some(TelnetCommand::Close) | None => break,
                },
            }
        }
        // Terminal-lifecycle State frame so a drained workbench observes the
        // end of the stream, mirroring `local-terminal-exited`.
        publish_telnet_output(
            &session_id,
            TerminalStream::State,
            b"telnet-session-closed".to_vec(),
            &replay,
            &emitter,
        )
        .await;
        let _ = emit_state("closed", closing_reason);
        sessions.write().await.remove(&session_id);
    });
}

/// Decodes the `telnet/write` JSON fallback payload.
pub fn decode_write_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|_| "telnet/write: dataBase64 is not valid base64".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TerminalFrame;
    use serde_json::json;

    const WILL_ECHO: &[u8] = &[IAC, WILL, OPT_ECHO];
    const DO_NAWS: &[u8] = &[IAC, DO, OPT_NAWS];

    fn feed_all(chunks: &[&[u8]]) -> (Vec<u8>, Vec<u8>) {
        let mut parser = TelnetParser::new();
        let mut payload = Vec::new();
        let mut replies = Vec::new();
        for chunk in chunks {
            let (chunk_payload, chunk_replies) = parser.feed(chunk);
            payload.extend_from_slice(&chunk_payload);
            replies.extend_from_slice(&chunk_replies);
        }
        (payload, replies)
    }

    // —— 协商应答矩阵 ——————————————————————————————————————

    #[test]
    fn negotiation_replies_follow_the_matrix() {
        // WILL ECHO / WILL SGA → DO；WILL 其他 → DONT。
        let (_, replies) = feed_all(&[WILL_ECHO]);
        assert_eq!(replies, vec![IAC, DO, OPT_ECHO]);
        let (_, replies) = feed_all(&[&[IAC, WILL, OPT_SGA]]);
        assert_eq!(replies, vec![IAC, DO, OPT_SGA]);
        let (_, replies) = feed_all(&[&[IAC, WILL, 24]]);
        assert_eq!(replies, vec![IAC, DONT, 24]);
        // DO NAWS → WILL NAWS；DO 其他 → WONT。
        let (_, replies) = feed_all(&[DO_NAWS]);
        assert_eq!(replies, vec![IAC, WILL, OPT_NAWS]);
        let (_, replies) = feed_all(&[&[IAC, DO, OPT_ECHO]]);
        assert_eq!(replies, vec![IAC, WONT, OPT_ECHO]);
        // WONT/DONT 无应答；单字节命令（NOP/AYT）静默吞掉。
        for sequence in [
            vec![IAC, WONT, OPT_ECHO],
            vec![IAC, DONT, OPT_NAWS],
            vec![IAC, 241], // NOP
            vec![IAC, 246], // AYT
        ] {
            let (payload, replies) = feed_all(&[&sequence]);
            assert!(replies.is_empty(), "no reply for {sequence:?}");
            assert!(payload.is_empty());
        }
    }

    #[test]
    fn strip_removes_iac_and_keeps_payload_bytes() {
        let wire = [b'a', b'b', IAC, WILL, OPT_ECHO, b'c', IAC, 241, b'd'];
        let (payload, replies) = feed_all(&[&wire]);
        assert_eq!(payload, b"abcd");
        assert_eq!(replies, vec![IAC, DO, OPT_ECHO]);
    }

    #[test]
    fn iac_iac_unescapes_to_a_literal_ff() {
        let wire = [b'x', IAC, IAC, 0xfe, b'y'];
        let (payload, replies) = feed_all(&[&wire]);
        assert_eq!(payload, vec![b'x', 0xff, 0xfe, b'y']);
        assert!(replies.is_empty());
    }

    #[test]
    fn iac_split_across_chunks_still_parses() {
        // IAC 断在块边界：首块以 IAC 结尾，次块补完 WILL ECHO。
        let (payload, replies) = feed_all(&[&[b'o', b'k', IAC], &[WILL, OPT_ECHO, b'!']]);
        assert_eq!(payload, b"ok!");
        assert_eq!(replies, vec![IAC, DO, OPT_ECHO]);
        // 子协商断块同样成立。
        let (payload, replies) = feed_all(&[&[b'a', IAC, SB, 24, b'x'], &[b'y', IAC], &[SE, b'b']]);
        assert_eq!(payload, b"ab");
        assert!(replies.is_empty());
    }

    #[test]
    fn subnegotiation_content_is_swallowed() {
        // TTYPE (24) 子协商内容（含 0xFF 之外的任意字节）不进 payload。
        let wire = [IAC, SB, 24, 0, b'x', 0xff, b't', IAC, SE, b'z'];
        let (payload, replies) = feed_all(&[&wire]);
        assert_eq!(payload, b"z");
        assert!(replies.is_empty());
        // 子协商里的 IAC IAC 是字面 0xFF 值字节，仍留在 SB 内。
        let wire = [IAC, SB, OPT_NAWS, 0x00, IAC, IAC, 0x78, IAC, SE, b'!'];
        let (payload, _) = feed_all(&[&wire]);
        assert_eq!(payload, b"!");
    }

    #[test]
    fn malformed_subnegotiation_resynchronizes() {
        // 子协商中 IAC 后跟非法字节 → 回到 Ground，后续 payload 恢复透传。
        let wire = [IAC, SB, 24, IAC, b'q', b'!'];
        let (payload, _) = feed_all(&[&wire]);
        assert_eq!(payload, b"!");
    }

    // —— NAWS / 输入转换 ————————————————————————————————————

    #[test]
    fn naws_encodes_big_endian_columns_and_rows() {
        assert_eq!(
            naws_frame(120, 32),
            vec![IAC, SB, OPT_NAWS, 0, 120, 0, 32, IAC, SE]
        );
        // 0xFF 值字节按 Telnet 规则转义为 IAC IAC。
        assert_eq!(
            naws_frame(0x00ff, 0x0102),
            vec![IAC, SB, OPT_NAWS, 0x00, IAC, IAC, 0x01, 0x02, IAC, SE]
        );
    }

    #[test]
    fn enter_mode_converts_carriage_returns() {
        // crlf：\r → \r\n（默认）。
        assert_eq!(
            transform_input(b"a\rb", EnterMode::Crlf, BackspaceMode::Del),
            b"a\r\nb"
        );
        // 已成对的 \r\n 只算一次回车，不翻倍。
        assert_eq!(
            transform_input(b"a\r\nb", EnterMode::Crlf, BackspaceMode::Del),
            b"a\r\nb"
        );
        // cr：原样；lf：\r → \n。
        assert_eq!(
            transform_input(b"a\rb", EnterMode::Cr, BackspaceMode::Del),
            b"a\rb"
        );
        assert_eq!(
            transform_input(b"a\rb", EnterMode::Lf, BackspaceMode::Del),
            b"a\nb"
        );
    }

    #[test]
    fn backspace_mode_maps_del_to_ctrl_h() {
        let input = [b'a', 0x7f, b'b'];
        assert_eq!(
            transform_input(&input, EnterMode::Cr, BackspaceMode::Del),
            input
        );
        assert_eq!(
            transform_input(&input, EnterMode::Cr, BackspaceMode::CtrlH),
            [b'a', 0x08, b'b']
        );
        // 组合生效：ctrl_h 换映射，crlf 换回车。
        assert_eq!(
            transform_input(&input, EnterMode::Crlf, BackspaceMode::CtrlH),
            [b'a', 0x08, b'b']
        );
    }

    // —— 自动登录（规则形态复用 triggers 规则引擎）———————————
    // 与声明式形态（NyaTerm 对齐）共用 parse_auto_login → AutoLoginPlan。

    fn slot_secrets() -> Vec<String> {
        vec!["s3cret-one".to_string(), "s3cret-two".to_string()]
    }

    fn rule_spec(rules: serde_json::Value) -> AutoLoginSpec {
        AutoLoginSpec {
            rules: Some(rules),
            secrets: slot_secrets(),
            declarative: None,
        }
    }

    /// 声明式规格构造：正则全部留空 → 走内置默认提示词表。
    fn decl_spec(username: &str, password: &str, max_retries: u8) -> AutoLoginSpec {
        AutoLoginSpec {
            rules: None,
            secrets: Vec::new(),
            declarative: Some(DeclarativeAutoLogin {
                username: (!username.is_empty()).then(|| username.to_string()),
                password: (!password.is_empty()).then(|| password.to_string()),
                username_prompt_regex: None,
                password_prompt_regex: None,
                success_regex: None,
                failure_regex: None,
                max_retries: Some(max_retries),
            }),
        }
    }

    #[test]
    fn auto_login_parses_rules_and_answers_fake_output() {
        // JSON 对象形态：明文 + 密文槽两阶段（sendSecretKey 槽引用）。
        // JSON 形态按 D7 严格校验（`*assword` 只在 tssh 文本形态有字面量兜底）。
        let spec = rule_spec(json!(
            r#"{"stages":[{"pattern":"ogin:","sendText":"myuser\r"},{"pattern":"assword","sendSecretKey":"trigger_answer_1"}]}"#
        ));
        let plan = parse_auto_login(&spec)
            .expect("rules parse")
            .expect("enabled");
        assert_eq!(plan.triggers.stages.len(), 2);
        assert!(plan.watch.is_none(), "rule form has no declarative watch");

        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("bbs.example", "", 23, "bbs.example"),
        );
        // 喂假输出流：login 提示命中阶段 1，明文应答。
        let decision = engine
            .observe("Welcome!\r\nlogin: ", 1_000)
            .expect("stage 1 must answer");
        assert_eq!(decision.stage, 1);
        assert_eq!(decision.kind, triggers::TriggerKind::Text);
        assert_eq!(decision.segments, vec![(b"myuser\r".to_vec(), 0)]);

        // 随后 password 提示命中阶段 2，密文槽应答（槽 1 值）。
        let decision = engine
            .observe("Password: ", 2_000)
            .expect("stage 2 must answer");
        assert_eq!(decision.stage, 2);
        assert_eq!(decision.kind, triggers::TriggerKind::Secret);
        assert_eq!(
            decision.segments,
            triggers::pass_sleep_segments("s3cret-one", 100, triggers::PassSleep::None)
        );
    }

    #[test]
    fn auto_login_accepts_the_tssh_text_form() {
        // tssh 文本形态同样全量可用（Expect* 指令）；注意 tssh 语法里没有
        // sendSecretKey——槽引用属于 JSON 形态的 sendSecretKey 字段。
        let spec = rule_spec(json!(
            "#!! ExpectCount 1\n#!! ExpectPattern1 ogin:\n#!! ExpectSendText1 myuser\\r"
        ));
        let plan = parse_auto_login(&spec)
            .expect("rules parse")
            .expect("enabled");
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("bbs", "", 23, "bbs"),
        );
        let decision = engine.observe("login: ", 1_000).expect("stage 1");
        assert_eq!(decision.segments, vec![(b"myuser\r".to_vec(), 0)]);
    }

    #[test]
    fn auto_login_maps_both_secret_slots() {
        let spec = rule_spec(json!(
            r#"{"stages":[{"pattern":"a","sendSecretKey":"trigger_answer_1"},{"pattern":"b","sendSecretKey":"trigger_answer_2"}]}"#
        ));
        let plan = parse_auto_login(&spec)
            .expect("rules parse")
            .expect("enabled");
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("h", "", 23, "h"),
        );
        let decision = engine.observe("aaa", 1_000).expect("stage 1");
        assert_eq!(decision.segments[0].0, b"s3cret-one\r".to_vec());
        let decision = engine.observe("bbb", 2_000).expect("stage 2");
        assert_eq!(decision.segments[0].0, b"s3cret-two\r".to_vec());
    }

    #[test]
    fn auto_login_rejects_invalid_rules_and_empty_slots() {
        // 非法 JSON 且不含 Expect 指令 → 沿用 triggers 的 JSON 报错。
        let spec = rule_spec(json!("{not json"));
        let error = parse_auto_login(&spec).expect_err("must fail");
        assert!(error.contains("invalid JSON"), "{error}");
        // 槽位为空 = 配置错误（D7 同款）。
        let spec = AutoLoginSpec {
            rules: Some(json!(
                r#"{"stages":[{"pattern":"a","sendSecretKey":"trigger_answer_1"}]}"#
            )),
            secrets: Vec::new(),
            declarative: None,
        };
        let error = parse_auto_login(&spec).expect_err("must fail");
        assert!(error.contains("is empty"), "{error}");
        // ExpectCount 0 = 显式关闭。
        let spec = rule_spec(json!("ExpectCount 0\nExpectPattern1 a\nExpectSendText1 x"));
        assert!(parse_auto_login(&spec).expect("rules parse").is_none());
    }

    // —— 自动登录（声明式形态，NyaTerm 对齐 P0-1）————————————

    #[test]
    fn declarative_builds_stages_and_watch_supervises_success() {
        let spec = AutoLoginSpec {
            rules: None,
            secrets: Vec::new(),
            declarative: Some(DeclarativeAutoLogin {
                username: Some("myuser".to_string()),
                password: Some("s3cret-pass".to_string()),
                username_prompt_regex: Some("ogin:".to_string()),
                password_prompt_regex: Some("assword".to_string()),
                success_regex: Some(r"\$ $".to_string()),
                failure_regex: Some("incorrect".to_string()),
                max_retries: Some(2),
            }),
        };
        let mut plan = parse_auto_login(&spec)
            .expect("declarative parse")
            .expect("enabled");
        assert_eq!(plan.triggers.stages.len(), 2);
        let mut watch = plan.watch.take().expect("declarative form has a watch");

        // 提示应答走共享引擎：用户名明文阶段 + 密码密文槽阶段。
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("host", "", 23, "host"),
        );
        let decision = engine
            .observe("Welcome!\r\nlogin: ", 1_000)
            .expect("stage 1");
        assert_eq!(decision.kind, triggers::TriggerKind::Text);
        assert_eq!(decision.segments, vec![(b"myuser\r".to_vec(), 0)]);
        let decision = engine.observe("Password: ", 2_000).expect("stage 2");
        assert_eq!(decision.kind, triggers::TriggerKind::Secret);
        assert_eq!(
            decision.segments,
            triggers::pass_sleep_segments("s3cret-pass", 100, triggers::PassSleep::None)
        );

        // 未发出任何应答前，成功正则不生效（NyaTerm sent_* 守卫）。
        assert!(watch.observe("$ ", false).is_none());
        // 发出应答后命中成功正则 → Success，之后停止监督。
        assert_eq!(
            watch.observe("user@host:~$ ", true),
            Some(WatchEvent::Success)
        );
        assert!(watch.observe("anything", true).is_none());
    }

    #[test]
    fn declarative_defaults_cover_common_prompts() {
        let plan = parse_auto_login(&decl_spec("dev", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        // 内置用户名提示默认：英文与中文。每次用全新引擎，避免上一提示命中
        // 后游标停在密码阶段。
        for prompt in ["login: ", "Username: ", "用户名：", "帐号:"] {
            let mut engine = triggers::TriggerEngine::new(
                plan.triggers.clone(),
                triggers::CommandPlaceholders::new("host", "", 23, "host"),
            );
            let decision = engine
                .observe(prompt, 1_000)
                .unwrap_or_else(|| panic!("default username prompt must match {prompt:?}"));
            assert_eq!(
                decision.segments,
                vec![(b"dev\r".to_vec(), 0)],
                "{prompt:?}"
            );
        }
        // 内置密码提示默认：密码-only 规格（引擎游标从密码阶段开始）。
        let plan = parse_auto_login(&decl_spec("", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        assert_eq!(
            plan.triggers.stages.len(),
            1,
            "password-only keeps one stage"
        );
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("host", "", 23, "host"),
        );
        let decision = engine
            .observe("Password: ", 2_000)
            .expect("password prompt");
        assert_eq!(decision.kind, triggers::TriggerKind::Secret);
        // 内置失败默认 + max_retries=0：首次失败即耗尽。
        let mut watch = plan.watch.expect("watch present");
        assert_eq!(
            watch.observe("Login incorrect", false),
            Some(WatchEvent::Exhausted)
        );
        // 内置成功默认（发出应答后生效）。
        let plan = parse_auto_login(&decl_spec("dev", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.expect("watch present");
        assert_eq!(
            watch.observe("dev@host:~$ ", true),
            Some(WatchEvent::Success)
        );
    }

    #[test]
    fn declarative_default_prompts_ignore_last_login_banner() {
        // E1 回归：行尾锚定后，`Last login: <time>` MOTD 横幅不再命中内置
        // 用户名提示（旧行为会把用户名提前打进远端并回显）。
        let plan = parse_auto_login(&decl_spec("dev", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers.clone(),
            triggers::CommandPlaceholders::new("host", "", 23, "host"),
        );
        assert!(
            engine
                .observe(
                    "Welcome to host\r\nLast login: 10.0.0.1 on Mon Sep 24 22:00:00 2026\r\n",
                    1_000
                )
                .is_none(),
            "MOTD banner must not answer the username prompt"
        );
        // 横幅之后的真实 login: 提示照常命中（跨 chunk 场景：引擎按 chunk
        // 归一化拼接，提示符在缓冲末尾即活提示）。
        let decision = engine.observe("login: ", 1_001).expect("username prompt");
        assert_eq!(decision.segments, vec![(b"dev\r".to_vec(), 0)]);
        // 内置密码提示同源修复：帮助文本中的 "password:" 子串不再误发密码。
        let plan = parse_auto_login(&decl_spec("", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        let mut engine = triggers::TriggerEngine::new(
            plan.triggers,
            triggers::CommandPlaceholders::new("host", "", 23, "host"),
        );
        assert!(
            engine
                .observe("Type 'run password: reset' to rotate it\r\n", 1_000)
                .is_none(),
            "embedded 'password:' text must not answer the password stage"
        );
        let decision = engine
            .observe("Password: ", 1_001)
            .expect("password prompt");
        assert_eq!(decision.kind, triggers::TriggerKind::Secret);
    }

    #[test]
    fn declarative_watch_strips_ansi_before_matching_success() {
        // E2 回归：带颜色的 `$ ` 成功提示（ANSI 包裹）必须先剥离再匹配
        // （NyaTerm strip_ansi_escapes 同语义；未剥离时默认成功正则不命中）。
        let colored = "\x1b[32mdev@host:~$ \x1b[0m";
        // 旧行为锚定：原始转义字节尾随 `m`，默认成功正则不命中。
        let mut plan = parse_auto_login(&decl_spec("dev", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.take().expect("watch present");
        assert!(
            watch.observe(colored, true).is_none(),
            "raw escapes must not match"
        );
        // 读循环喂给 watch 前剥离（publish 的透传字节不动）。
        let mut plan = parse_auto_login(&decl_spec("dev", "pw", 0))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.take().expect("watch present");
        assert_eq!(
            watch.observe(&strip_ansi_control_sequences(colored), true),
            Some(WatchEvent::Success)
        );
    }

    #[test]
    fn declarative_tail_refills_after_retry_so_each_failure_counts_once() {
        let mut plan = parse_auto_login(&decl_spec("dev", "pw", 1))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.take().expect("watch present");
        assert_eq!(
            watch.observe("Login incorrect", false),
            Some(WatchEvent::Retry { attempt: 1 })
        );
        // tail 已清空后同文本再次到达 = 宿主再次拒绝 → 重新计数并立即耗尽
        // （budget=1）。
        assert_eq!(
            watch.observe("Login incorrect", false),
            Some(WatchEvent::Exhausted)
        );
        assert_eq!(watch.attempts_used(), 2, "初始 1 次 + 重试 1 次");
        // 断言清空语义的另一半：失败文本被无关输出稀释时不得连击。
        let mut plan = parse_auto_login(&decl_spec("dev", "pw", 1))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.take().expect("watch present");
        assert_eq!(
            watch.observe("Login incorrect", false),
            Some(WatchEvent::Retry { attempt: 1 })
        );
        assert!(watch.observe("welcome banner", false).is_none());
    }

    #[test]
    fn declarative_retry_budget_exhausts_and_reports_attempts() {
        let mut plan = parse_auto_login(&decl_spec("dev", "pw", 2))
            .expect("declarative parse")
            .expect("enabled");
        let mut watch = plan.watch.take().expect("watch present");
        assert_eq!(
            watch.observe("Authentication failed", false),
            Some(WatchEvent::Retry { attempt: 1 })
        );
        assert!(watch.observe("ok", false).is_none());
        assert_eq!(
            watch.observe("Authentication failed", false),
            Some(WatchEvent::Retry { attempt: 2 })
        );
        assert_eq!(
            watch.observe("Authentication failed", false),
            Some(WatchEvent::Exhausted)
        );
        assert_eq!(watch.attempts_used(), 3);
    }

    #[test]
    fn declarative_rejects_invalid_config_before_start() {
        // 非法成功正则 → 可读错误带字段名。
        let mut spec = decl_spec("dev", "pw", 0);
        spec.declarative.as_mut().unwrap().success_regex = Some("(unclosed".to_string());
        let error = parse_auto_login(&spec).expect_err("invalid success regex must fail");
        assert!(error.contains("autoLogin.successRegex"), "{error}");
        // 非法用户名提示正则同理。
        let mut spec = decl_spec("dev", "pw", 0);
        spec.declarative.as_mut().unwrap().username_prompt_regex = Some("[".to_string());
        let error = parse_auto_login(&spec).expect_err("invalid prompt regex must fail");
        assert!(error.contains("autoLogin.usernamePromptRegex"), "{error}");
        // 无凭据可发 = 配置错误。
        let error = parse_auto_login(&decl_spec("", "", 0)).expect_err("no credentials must fail");
        assert!(error.contains("username or a password"), "{error}");
        // 重试预算超上限。
        let error = parse_auto_login(&decl_spec("dev", "pw", 11)).expect_err("retries cap");
        assert!(error.contains("autoLogin.maxRetries"), "{error}");
        // 两种形态互斥。
        let spec = AutoLoginSpec {
            rules: Some(json!({"stages": []})),
            secrets: Vec::new(),
            declarative: Some(DeclarativeAutoLogin {
                username: Some("dev".to_string()),
                password: None,
                username_prompt_regex: None,
                password_prompt_regex: None,
                success_regex: None,
                failure_regex: None,
                max_retries: None,
            }),
        };
        let error = parse_auto_login(&spec).expect_err("both forms must fail");
        assert!(error.contains("mutually exclusive"), "{error}");
    }

    #[test]
    fn declarative_credentials_never_reach_debug_output() {
        // 安全红线：密码/密文槽值不得出现在任何 Debug 输出（日志/panic 的载体）。
        let spec = decl_spec("dev", "s3cret-pass", 1);
        assert!(!format!("{spec:?}").contains("s3cret-pass"));
        let plan = parse_auto_login(&spec).expect("parse").expect("enabled");
        // TriggersConfig 的 Debug 对 Secret 脱敏，Watch 不含凭据。
        assert!(!format!("{plan:?}").contains("s3cret-pass"));
        let rendered = format!("{:?}", plan.triggers.stages[1].answer);
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn mode_enums_accept_wire_names_only() {
        assert_eq!(EnterMode::parse("crlf"), Some(EnterMode::Crlf));
        assert_eq!(EnterMode::parse("cr"), Some(EnterMode::Cr));
        assert_eq!(EnterMode::parse("lf"), Some(EnterMode::Lf));
        assert_eq!(EnterMode::parse("cr lf"), None);
        assert_eq!(BackspaceMode::parse("del"), Some(BackspaceMode::Del));
        assert_eq!(BackspaceMode::parse("ctrl_h"), Some(BackspaceMode::CtrlH));
        assert_eq!(BackspaceMode::parse("ctrlH"), Some(BackspaceMode::CtrlH));
        assert_eq!(BackspaceMode::parse("backspace"), None);
    }

    #[test]
    fn write_payload_requires_base64() {
        assert_eq!(decode_write_payload("aGk=").unwrap(), b"hi");
        assert!(decode_write_payload("!!").is_err());
    }

    #[test]
    fn telnet_state_frame_roundtrips_through_terminal_frame() {
        let frame = TerminalFrame {
            sequence: 3,
            stream: TerminalStream::State,
            data: b"telnet-session-closed".to_vec(),
        };
        let encoded = frame.encode();
        assert_eq!(encoded[0], 2);
        assert_eq!(&encoded[1..9], &3u64.to_be_bytes());
    }
}
