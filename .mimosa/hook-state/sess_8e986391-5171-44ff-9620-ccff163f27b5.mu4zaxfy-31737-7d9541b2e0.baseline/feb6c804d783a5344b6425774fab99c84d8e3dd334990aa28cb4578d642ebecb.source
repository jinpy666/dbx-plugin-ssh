//! Expect-style terminal trigger engine (tssh「自动交互」对标，0.4.74)。
//!
//! 用户在连接上配置有序阶段规则（对齐 tssh `ExpectPattern1..N`）：PTY 输出
//! 经 `normalize_auth_prompt_text` 归一化后进入 ≤8 KiB 滚动缓冲，按序匹配
//! 正则，命中后生成应答发送计划（`TriggerDecision.segments`），由终端读
//! 循环负责分段 `tokio::sleep` 写回 channel。每阶段应答五选一：
//! - 明文 `sendText`（`\r`/`\n`/`\t` 转义、`\|` 分段停顿 `sleepMs`）；
//! - 密文引用 `sendSecretKey`（解析宿主 secret binding 槽位，自动补 `\r`）；
//! - 字面密文 `sendSecret`（tssh `ExpectSendPassN` 解密产物，自动补 `\r`）；
//! - TOTP `sendTotp`（RFC 6238 SHA1/6 位/30 s，命中时按当前时间生成，
//!   对齐 tssh `ExpectSendTotpN` / `ExpectSendEncTotpN`，自动补 `\r`）；
//! - 本地命令 `sendCommand`（shell 执行取 stdout，自动补 `\r`；
//!   对齐 tssh `ExpectSendOtpN` / `ExpectSendEncOtpN`）。
//!
//! tssh 文本形态完全兼容（0.4.77 起）：`ExpectSendPassN` /
//! `ExpectCaseSendPassN` / `ExpectSendEncTotpN` / `ExpectSendEncOtpN` 的
//! `--enc-secret` 密文按 tssh `decodeSecret` 同款算法解密（AES-256-GCM、
//! 固定内嵌密钥，见 [`decode_tssh_enc_secret`]）——与 tssh 同为混淆而非加密。
//!
//! 复位语义（契约 D3）：行尾 `$`/`#` 的 shell 提示（复用 `exec::has_shell_prompt`）
//! 即阶段游标归零；阶段超时（秒级，`now` 由调用方注入便于测试）同样归零并
//! 产出 `timeout` 决策，会话继续不断连。超时只在**序列中途**生效（已命中
//! 前序阶段、在等第 2..N 阶段）：空闲等待第一阶段是事件驱动的无限期等待，
//! 不设超时，否则闲置会话会周期性刷 timeout。case 预匹配（`casePattern`）
//! 命中不推进游标，答完继续等本阶段 pattern。
//!
//! 安全红线：应答内容只存在于发送计划里，绝不进日志、事件或错误信息；
//! `TriggersConfig` 的 `Debug` 实现对密文应答（`Secret`/`Totp`）脱敏。

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::process::Output;
use std::time::Duration;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use hmac::{Hmac, Mac};
use regex::Regex;
use sha1::Sha1;
use zeroize::Zeroizing;

use crate::exec::{has_shell_prompt, normalize_auth_prompt_text};

/// Stage-count ceiling (contract D8): guards against config abuse.
pub const MAX_STAGES: usize = 16;
/// Pattern length ceiling, aligned with `exec::MAX_PROMPT_HINT_LEN` (D8).
pub const MAX_PATTERN_LEN: usize = 512;
/// `timeoutSecs` range: 1..=600 (D8); absent means the default.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// `sleepMs` range: 0..=5000 (D8); absent means the default.
pub const DEFAULT_SLEEP_MS: u64 = 100;
pub const MAX_SLEEP_MS: u64 = 5000;
/// Send-text cap: the `\|` split and the per-char `passSleep = each` shape
/// both multiply the answer into segments, so an unbounded answer could stall
/// the terminal read loop on a misconfigured rule.
pub const MAX_SEND_TEXT_LEN: usize = 4096;
/// Command-line cap for `sendCommand`/`password_command`/`passphrase_command`.
pub const MAX_COMMAND_LEN: usize = 1024;
/// Runtime cap on captured stdout of a trigger/credential command: these
/// commands answer prompts (passwords, OTPs), so multi-KB output is a bug.
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 4096;
/// Fixed command timeout (contract D4).
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
/// The only secret slots a `sendSecretKey` may reference (contract D5); the
/// manifest provides one password field per slot bound to `connection_secrets`.
pub const SECRET_SLOT_KEYS: &[&str] = &["trigger_answer_1", "trigger_answer_2"];
/// Rolling match buffer ceiling (contract D2).
const MAX_BUFFER_BYTES: usize = 8 * 1024;
/// TOTP secret ceiling after base32 decode (RFC 4226 recommends ≥16 bytes;
/// 64 is a generous abuse cap).
const MAX_TOTP_SECRET_BYTES: usize = 64;
/// tssh (trzsz-ssh) `--enc-secret` obfuscation key, byte-for-byte identical to
/// tssh's embedded `secretEncodeKey` (tssh/config.go): hex blobs are
/// `nonce(12) || AES-256-GCM(ct||tag)` under this key. Obfuscation, not
/// encryption — the same trust level tssh itself documents.
const TSSH_ENC_SECRET_KEY: &[u8; 32] = b"THE_UNSAFE_KEY_FOR_ENCODING_ONLY";

/// How secret/command answers are paced onto the wire (tssh `ExpectPassSleep`).
/// Plain `sendText` answers are never paced by this knob (contract §2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PassSleep {
    /// Whole answer plus Enter in one write (default).
    #[default]
    None,
    /// One character per write, `sleep_ms` between characters.
    Each,
    /// Answer first, then Enter after `sleep_ms`.
    Enter,
}

impl PassSleep {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "each" => Some(Self::Each),
            "enter" => Some(Self::Enter),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Each => "each",
            Self::Enter => "enter",
        }
    }
}

/// One stage's answer, with secret slots already resolved to their values.
/// Variants other than `Secret`/`Totp` carry user-authored configuration
/// (plaintext by definition); `Secret` holds a fetched slot value or a
/// decrypted tssh blob and `Totp` holds a raw TOTP key — both are redacted in
/// `Debug` so a connection dump can never leak them.
#[derive(Clone, PartialEq, Eq)]
pub enum StageAnswer {
    Text(String),
    Secret(String),
    /// Raw RFC 4226 HMAC key (base32-decoded); the code is generated at match
    /// time so a long-pending stage answers with a fresh one.
    Totp(Vec<u8>),
    Command(String),
}

impl StageAnswer {
    /// Wire kind name (same vocabulary as `TriggerKind::name`); exercised by
    /// the parser tests, kept public for diagnostics.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Text(_) => "text",
            Self::Secret(_) | Self::Totp(_) => "secret",
            Self::Command(_) => "command",
        }
    }
}

impl fmt::Debug for StageAnswer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => write!(formatter, "Text({text:?})"),
            Self::Secret(_) => formatter.write_str("Secret(\"<redacted>\")"),
            Self::Totp(_) => formatter.write_str("Totp(\"<redacted>\")"),
            Self::Command(command) => write!(formatter, "Command({command:?})"),
        }
    }
}

/// Optional pre-match rule: fires the answer when `pattern` appears while the
/// stage is pending, without advancing the stage cursor. Only text/secret
/// answers are allowed here (validated at parse time).
#[derive(Clone, Debug)]
pub struct CaseRule {
    pub pattern: Regex,
    pub answer: StageAnswer,
}

/// One ordered expect stage: `pattern` hit → answer (three-way), with an
/// optional case pre-match.
#[derive(Clone, Debug)]
pub struct TriggerStage {
    pub pattern: Regex,
    pub answer: StageAnswer,
    pub case: Option<CaseRule>,
}

/// Parsed and validated `external_config.triggers` (contract §2.1). Invalid
/// shapes fail the connection (D7) instead of degrading silently.
#[derive(Clone)]
pub struct TriggersConfig {
    /// Seconds a pending stage may wait for its pattern before resetting.
    pub timeout_secs: u64,
    /// Pause between `\|` text segments (and between paced secret chars).
    pub sleep_ms: u64,
    /// Pacing mode for secret/command answers.
    pub pass_sleep: PassSleep,
    /// Ordered stages, 1..=MAX_STAGES.
    pub stages: Vec<TriggerStage>,
}

impl fmt::Debug for TriggersConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TriggersConfig")
            .field("timeout_secs", &self.timeout_secs)
            .field("sleep_ms", &self.sleep_ms)
            .field("pass_sleep", &self.pass_sleep.name())
            .field("stages", &self.stages)
            .finish()
    }
}

/// What the engine decided to type back after one output chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerDecision {
    /// 1-based stage number the decision belongs to (timeout reports the
    /// stage that gave up).
    pub stage: usize,
    pub kind: TriggerKind,
    /// Segment send plan: `(payload, delay_ms)` — the delay elapses before
    /// the payload is written (0 for the first segment). The read loop owns
    /// the actual pacing via `tokio::time::sleep`.
    pub segments: Vec<(Vec<u8>, u64)>,
    /// Only for `TriggerKind::Command`: the placeholder-substituted command
    /// the caller must run locally before sending its (trimmed) stdout.
    pub command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerKind {
    Text,
    Secret,
    Command,
    Timeout,
}

impl TriggerKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Secret => "secret",
            Self::Command => "command",
            Self::Timeout => "timeout",
        }
    }
}

/// `%h`/`%u`/`%p`/`%n` placeholder context for local command execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPlaceholders {
    pub host: String,
    pub username: String,
    pub port: u16,
    /// Connection display name, falling back to the connection id.
    pub name: String,
}

impl CommandPlaceholders {
    pub fn new(host: &str, username: &str, port: u16, name: &str) -> Self {
        Self {
            host: host.to_string(),
            username: username.to_string(),
            port,
            name: name.to_string(),
        }
    }
}

/// Substitutes `%h` host, `%u` username, `%p` port, `%n` connection name and
/// `%%` literal `%`; any other `%x` sequence passes through untouched.
pub fn apply_command_placeholders(command: &str, placeholders: &CommandPlaceholders) -> String {
    let mut output = String::with_capacity(command.len());
    let mut chars = command.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '%' {
            output.push(character);
            continue;
        }
        match chars.peek().copied() {
            Some('%') => {
                chars.next();
                output.push('%');
            }
            Some('h') => {
                chars.next();
                output.push_str(&placeholders.host);
            }
            Some('u') => {
                chars.next();
                output.push_str(&placeholders.username);
            }
            Some('p') => {
                chars.next();
                output.push_str(&placeholders.port.to_string());
            }
            Some('n') => {
                chars.next();
                output.push_str(&placeholders.name);
            }
            _ => output.push('%'),
        }
    }
    output
}

/// Spawns the substituted command through the platform shell and waits for
/// completion. Injectable so command execution is unit-testable without a
/// real shell (the production implementation is [`ShellExecutor`]).
pub trait CommandExecutor: Send + Sync {
    fn run(
        &self,
        command: &str,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Output>> + Send + '_>>;
}

/// Production executor: unix `sh -c` / windows `cmd /C` (contract D4).
pub struct ShellExecutor;

impl CommandExecutor for ShellExecutor {
    fn run(
        &self,
        command: &str,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Output>> + Send + '_>> {
        let command = command.to_string();
        Box::pin(async move {
            #[cfg(unix)]
            {
                tokio::process::Command::new("sh")
                    .arg("-c")
                    .arg(&command)
                    .output()
                    .await
            }
            #[cfg(windows)]
            {
                tokio::process::Command::new("cmd")
                    .args(["/C"])
                    .arg(&command)
                    .output()
                    .await
            }
        })
    }
}

/// Runs one local command (placeholders substituted, fixed timeout, exit-code
/// check) and returns its stdout with a single trailing newline stripped,
/// zeroize-wrapped so the credential buffer is wiped when dropped. Errors
/// carry only the failure mode (timeout / spawn error / exit code) — never
/// the command output.
pub fn execute_command<'a>(
    executor: &'a dyn CommandExecutor,
    command: &str,
    placeholders: &CommandPlaceholders,
    timeout: Duration,
) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>> {
    let substituted = apply_command_placeholders(command, placeholders);
    Box::pin(async move {
        let output = tokio::time::timeout(timeout, executor.run(&substituted))
            .await
            .map_err(|_| {
                format!(
                    "local command timed out after {}s",
                    timeout.as_secs().max(1)
                )
            })?
            .map_err(|error| format!("local command could not be spawned: {error}"))?;
        if !output.status.success() {
            return Err(match output.status.code() {
                Some(code) => format!("local command exited with code {code}"),
                None => "local command was terminated by a signal".to_string(),
            });
        }
        let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        // Strip exactly one trailing newline: `echo pw` emits "pw\n", a
        // password genuinely ending in "\n" would emit "pw\n\n" and keep it.
        if stdout.ends_with('\n') {
            stdout.pop();
            if stdout.ends_with('\r') {
                stdout.pop();
            }
        }
        if stdout.len() > MAX_COMMAND_OUTPUT_BYTES {
            return Err(format!(
                "local command produced more than {MAX_COMMAND_OUTPUT_BYTES} bytes of output"
            ));
        }
        Ok(Zeroizing::new(stdout))
    })
}

/// Convenience wrapper used by the SSH auth/trigger paths: production shell
/// executor plus the fixed 10s timeout (contract D4).
pub fn run_credential_command<'a>(
    command: &'a str,
    placeholders: &'a CommandPlaceholders,
) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>> {
    execute_command(&ShellExecutor, command, placeholders, COMMAND_TIMEOUT)
}

/// Decodes a TOTP shared secret: base32 (RFC 4648), tolerant of the shapes
/// authenticator apps and tssh accept — spaces/hyphens dropped, case folded,
/// missing `=` padding restored. Returns the raw HMAC key bytes.
fn decode_base32_secret(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = text
        .chars()
        .filter(|character| !matches!(character, ' ' | '-'))
        .map(|character| character.to_ascii_uppercase())
        .collect();
    let unpadded = cleaned.trim_end_matches('=');
    let mut padded = unpadded.to_string();
    if !unpadded.len().is_multiple_of(8) {
        let padding = 8 - (unpadded.len() % 8);
        padded.push_str(&"=".repeat(padding));
    }
    data_encoding::BASE32
        .decode(padded.as_bytes())
        .map_err(|_| format!("invalid base32 TOTP secret (expected A-Z2-7, got '{text}')"))
}

/// Generates the RFC 6238 TOTP code: HMAC-SHA1, 6 digits, 30-second step —
/// the pquerna/otp defaults tssh's `getTotpCode` uses, so codes are
/// byte-compatible with `tssh ExpectSendTotpN`.
fn totp_code(secret: &[u8], now_ms: u64) -> String {
    let counter = (now_ms / 1000) / 30;
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary =
        u32::from_be_bytes(digest[offset..offset + 4].try_into().expect("4 bytes")) & 0x7fff_ffff;
    format!("{:06}", binary % 1_000_000)
}

/// Decrypts a tssh `--enc-secret` blob the exact way tssh's `decodeSecret`
/// does: hex-decode, split off the 12-byte nonce, AES-256-GCM open under the
/// fixed embedded key. `error_context` names the offending directive
/// (`ExpectSendPass2`, …) for the connection error.
fn decode_tssh_enc_secret(hex_text: &str, error_context: &str) -> Result<String, String> {
    let blob = data_encoding::HEXLOWER_PERMISSIVE
        .decode(hex_text.trim().as_bytes())
        .map_err(|_| format!("{error_context}: value is not a valid tssh --enc-secret hex blob"))?;
    if blob.len() < 12 + 16 {
        return Err(format!(
            "{error_context}: tssh --enc-secret blob is too short (expected nonce + ciphertext + tag)"
        ));
    }
    let cipher = Aes256Gcm::new(TSSH_ENC_SECRET_KEY.into());
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&blob[..12]), &blob[12..])
        .map_err(|_| {
            format!(
                "{error_context}: tssh --enc-secret blob failed to decrypt (was it produced by tssh --enc-secret?)"
            )
        })?;
    String::from_utf8(plaintext)
        .map_err(|_| format!("{error_context}: decrypted secret is not valid UTF-8"))
}

/// Parses `external_config.triggers` into a validated [`TriggersConfig`].
/// Accepts three input shapes:
/// - the raw JSON object (host lifecycle payloads, smoke tests);
/// - the JSON-string form (connection-form textarea), optionally carrying a
///   top-level `"enabled": false` to switch the rules off without deleting
///   them;
/// - tssh (trzsz-ssh) text-form rules (`ExpectCount` / `ExpectPatternN` /
///   `ExpectSendTextN` …, with or without the `#!!` ssh-config comment
///   prefix) — detected whenever the text is not valid JSON but mentions an
///   `Expect*` directive (tssh 自动交互输入兼容，0.4.77).
///
/// Missing/empty/`stages: []`/`enabled: false`/`ExpectCount 0` mean the
/// feature is off (`Ok(None)`); everything invalid is a hard error
/// (contract D7).
pub fn parse_triggers(
    raw: Option<&serde_json::Value>,
    secrets: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<TriggersConfig>, String> {
    let Some(value) = raw else {
        return Ok(None);
    };
    match value {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return Ok(None);
            }
            match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(text) {
                Ok(object) => parse_object(&object, secrets),
                Err(error) => {
                    // A mangled JSON document must surface as a JSON error;
                    // only non-JSON text that names an Expect* directive is
                    // reinterpreted as the tssh text form.
                    if looks_like_tssh_text(text) {
                        parse_tssh_text(text, secrets)
                    } else {
                        Err(format!("triggers: invalid JSON: {error}"))
                    }
                }
            }
        }
        serde_json::Value::Object(object) => parse_object(object, secrets),
        other => Err(format!(
            "triggers: expected a JSON object or JSON string, got {}",
            json_type_name(other)
        )),
    }
}

/// Shared validator for the object form (host object or parsed textarea
/// JSON). `enabled: false` keeps the stages stored but disables the engine.
fn parse_object(
    object: &serde_json::Map<String, serde_json::Value>,
    secrets: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<TriggersConfig>, String> {
    match object.get("enabled") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Bool(false)) => return Ok(None),
        Some(serde_json::Value::Bool(true)) => {}
        Some(other) => {
            return Err(format!(
                "triggers.enabled: expected a boolean, got {}",
                json_type_name(other)
            ))
        }
    }
    let stages = match object.get("stages") {
        None | Some(serde_json::Value::Null) => return Ok(None),
        Some(serde_json::Value::Array(stages)) => stages,
        Some(other) => {
            return Err(format!(
                "triggers.stages: expected a JSON array, got {}",
                json_type_name(other)
            ))
        }
    };
    if stages.is_empty() {
        return Ok(None);
    }
    if stages.len() > MAX_STAGES {
        return Err(format!(
            "triggers.stages: at most {MAX_STAGES} stages are supported, got {}",
            stages.len()
        ));
    }
    let timeout_secs = match object.get("timeoutSecs") {
        None | Some(serde_json::Value::Null) => DEFAULT_TIMEOUT_SECS,
        Some(value) => value
            .as_u64()
            .filter(|value| (1..=MAX_TIMEOUT_SECS).contains(value))
            .ok_or_else(|| {
                format!("triggers.timeoutSecs: must be an integer between 1 and {MAX_TIMEOUT_SECS}")
            })?,
    };
    let sleep_ms = match object.get("sleepMs") {
        None | Some(serde_json::Value::Null) => DEFAULT_SLEEP_MS,
        Some(value) => value
            .as_u64()
            .filter(|value| *value <= MAX_SLEEP_MS)
            .ok_or_else(|| {
                format!("triggers.sleepMs: must be an integer between 0 and {MAX_SLEEP_MS}")
            })?,
    };
    let pass_sleep = match object.get("passSleep") {
        None | Some(serde_json::Value::Null) => PassSleep::None,
        Some(serde_json::Value::String(name)) => PassSleep::parse(name).ok_or_else(|| {
            format!("triggers.passSleep: must be none, each or enter, got '{name}'")
        })?,
        Some(other) => {
            return Err(format!(
                "triggers.passSleep: expected a string, got {}",
                json_type_name(other)
            ))
        }
    };
    let mut parsed = Vec::with_capacity(stages.len());
    for (index, stage) in stages.iter().enumerate() {
        let stage = stage.as_object().ok_or_else(|| {
            format!(
                "triggers.stages[{}]: expected a JSON object, got {}",
                index + 1,
                json_type_name(stage)
            )
        })?;
        parsed.push(parse_stage(stage, index, secrets)?);
    }
    Ok(Some(TriggersConfig {
        timeout_secs,
        sleep_ms,
        pass_sleep,
        stages: parsed,
    }))
}

/// True when the trimmed textarea text names at least one tssh `Expect*`
/// directive, so failed JSON parsing falls through to the tssh text parser
/// instead of a JSON error.
fn looks_like_tssh_text(text: &str) -> bool {
    text.lines().any(|line| {
        let line = strip_tssh_comment_prefix(line).trim_start();
        match line.split_whitespace().next() {
            Some(token) => {
                let token = token.trim_matches('"').to_ascii_lowercase();
                token.starts_with("expect")
            }
            None => false,
        }
    })
}

/// Drops an optional tssh comment prefix: `#!!` (ssh-config embedding),
/// `#!`, or a plain `#`.
fn strip_tssh_comment_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    for prefix in ["#!!", "#!", "#"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest;
        }
    }
    trimmed
}

/// Splits `Directive value…` at the first whitespace run; the value keeps its
/// inner spacing (patterns and answers may contain spaces) and loses one
/// optional pair of surrounding double quotes.
fn split_tssh_directive(line: &str) -> Option<(String, &str)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let directive = parts.next()?.trim().to_ascii_lowercase();
    if directive.is_empty() {
        return None;
    }
    let value = parts.next().unwrap_or("").trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    Some((directive, value))
}

/// Splits a directive name into its alphabetic head and 1-based stage index
/// (`expectpattern3` → `("expectpattern", 3)`).
fn split_tssh_index(directive: &str) -> (&str, Option<usize>) {
    match directive
        .char_indices()
        .rev()
        .find(|(_, c)| !c.is_ascii_digit())
    {
        Some((boundary, _)) if boundary + 1 < directive.len() => (
            &directive[..=boundary],
            directive[boundary + 1..].parse::<usize>().ok(),
        ),
        _ => (directive, None),
    }
}

fn tssh_error(line_no: usize, message: &str) -> String {
    format!("triggers: tssh text input, line {line_no}: {message}")
}

fn tssh_pattern_value(value: &str, line_no: usize) -> Result<String, String> {
    if value.len() > MAX_PATTERN_LEN {
        return Err(tssh_error(
            line_no,
            &format!("pattern exceeds {MAX_PATTERN_LEN} characters"),
        ));
    }
    // The JSON form stays strict (D7), but pasted tssh rules were written for
    // tssh's matcher: a value that is not a valid regex falls back to a
    // literal substring match (tssh's own README example `*assword` is not a
    // valid regex either).
    if Regex::new(value).is_ok() {
        Ok(value.to_string())
    } else {
        Ok(regex::escape(value))
    }
}

/// Parses the tssh (trzsz-ssh) text form: `ExpectCount` / `ExpectTimeout` /
/// `ExpectSleepMS` / `ExpectPassSleep` globals plus per-stage
/// `ExpectPatternN` / `ExpectSendTextN` / `ExpectSendOtpN` and
/// `ExpectCaseSendTextN <pattern> <text>`. `ExpectCount 0` explicitly
/// disables the engine. The tssh ciphertext/TOTP answer directives are fully
/// supported (0.4.77): `ExpectSendPassN` / `ExpectCaseSendPassN` /
/// `ExpectSendEncTotpN` / `ExpectSendEncOtpN` decrypt `--enc-secret` blobs
/// exactly like tssh (`decode_tssh_enc_secret`), and `ExpectSendTotpN`
/// generates RFC 6238 codes — both mapping onto the plugin's
/// `sendSecret` / `sendTotp` / `sendCommand` answers.
fn parse_tssh_text(
    text: &str,
    secrets: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<TriggersConfig>, String> {
    let mut expect_count: Option<u64> = None;
    let mut timeout_secs: Option<u64> = None;
    let mut sleep_ms: Option<u64> = None;
    let mut pass_sleep: Option<PassSleep> = None;
    let mut stages: std::collections::BTreeMap<usize, serde_json::Map<String, serde_json::Value>> =
        std::collections::BTreeMap::new();

    // Inserts one answer field after enforcing the one-answer-per-stage rule
    // (tssh resolves duplicates by directive priority; a paste carrying two
    // answers for the same stage is pathological, so reject it).
    let insert_answer = |stages: &mut std::collections::BTreeMap<
        usize,
        serde_json::Map<String, serde_json::Value>,
    >,
                         number: usize,
                         field: &str,
                         value: String,
                         line_no: usize|
     -> Result<(), String> {
        let stage = stages.entry(number).or_default();
        if [
            "sendText",
            "sendSecretKey",
            "sendSecret",
            "sendTotp",
            "sendCommand",
        ]
        .iter()
        .any(|key| stage.contains_key(*key))
        {
            return Err(tssh_error(line_no, "duplicate stage answer"));
        }
        stage.insert(field.to_string(), serde_json::Value::String(value));
        Ok(())
    };

    for (offset, raw_line) in text.lines().enumerate() {
        let line_no = offset + 1;
        let line = strip_tssh_comment_prefix(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        let (directive, value) = split_tssh_directive(line)
            .ok_or_else(|| tssh_error(line_no, "expected 'Directive value'"))?;
        let (name, index) = split_tssh_index(&directive);
        let stage_number = || -> Result<usize, String> {
            index
                .filter(|index| (1..=MAX_STAGES).contains(index))
                .ok_or_else(|| {
                    tssh_error(
                        line_no,
                        &format!("{name} requires a stage number between 1 and {MAX_STAGES}"),
                    )
                })
        };
        match name {
            "expectcount" => {
                expect_count = Some(value.parse::<u64>().map_err(|_| {
                    tssh_error(
                        line_no,
                        &format!("ExpectCount must be an integer, got '{value}'"),
                    )
                })?);
            }
            "expecttimeout" => {
                let seconds = value.parse::<u64>().map_err(|_| {
                    tssh_error(
                        line_no,
                        &format!("ExpectTimeout must be an integer, got '{value}'"),
                    )
                })?;
                if !(1..=MAX_TIMEOUT_SECS).contains(&seconds) {
                    return Err(tssh_error(
                        line_no,
                        &format!("ExpectTimeout must be between 1 and {MAX_TIMEOUT_SECS}"),
                    ));
                }
                timeout_secs = Some(seconds);
            }
            "expectsleepms" => {
                let millis = value.parse::<u64>().map_err(|_| {
                    tssh_error(
                        line_no,
                        &format!("ExpectSleepMS must be an integer, got '{value}'"),
                    )
                })?;
                if millis > MAX_SLEEP_MS {
                    return Err(tssh_error(
                        line_no,
                        &format!("ExpectSleepMS must be between 0 and {MAX_SLEEP_MS}"),
                    ));
                }
                sleep_ms = Some(millis);
            }
            "expectpasssleep" => {
                pass_sleep = Some(PassSleep::parse(&value.to_ascii_lowercase()).ok_or_else(
                    || tssh_error(line_no, "ExpectPassSleep must be no, none, each or enter"),
                )?);
            }
            "expectpattern" => {
                let number = stage_number()?;
                stages.entry(number).or_default().insert(
                    "pattern".to_string(),
                    serde_json::Value::String(tssh_pattern_value(value, line_no)?),
                );
            }
            // tssh ExpectSendOtpN runs a local command and sends its stdout —
            // exactly the plugin's sendCommand.
            "expectsendtext" | "expectsendotp" => {
                let field = if name == "expectsendtext" {
                    "sendText"
                } else {
                    "sendCommand"
                };
                let number = stage_number()?;
                insert_answer(&mut stages, number, field, value.to_string(), line_no)?;
            }
            // tssh ExpectSendPassN: --enc-secret blob, decrypted with tssh's
            // own fixed key and sent as a secret (Enter appended).
            "expectsendpass" => {
                let number = stage_number()?;
                let decoded = decode_tssh_enc_secret(value, &format!("ExpectSendPass{number}"))?;
                insert_answer(&mut stages, number, "sendSecret", decoded, line_no)?;
            }
            // tssh ExpectSendTotpN: plaintext base32 secret; the code is
            // generated at match time.
            "expectsendtotp" => {
                let number = stage_number()?;
                decode_base32_secret(value).map_err(|error| tssh_error(line_no, &error))?;
                insert_answer(&mut stages, number, "sendTotp", value.to_string(), line_no)?;
            }
            // tssh ExpectSendEncTotpN: --enc-secret blob whose plaintext is
            // the base32 TOTP secret.
            "expectsendenctotp" => {
                let number = stage_number()?;
                let decoded = decode_tssh_enc_secret(value, &format!("ExpectSendEncTotp{number}"))?;
                decode_base32_secret(&decoded).map_err(|error| tssh_error(line_no, &error))?;
                insert_answer(&mut stages, number, "sendTotp", decoded, line_no)?;
            }
            // tssh ExpectSendEncOtpN: --enc-secret blob whose plaintext is a
            // local command producing the dynamic password.
            "expectsendencotp" => {
                let number = stage_number()?;
                let decoded = decode_tssh_enc_secret(value, &format!("ExpectSendEncOtp{number}"))?;
                insert_answer(&mut stages, number, "sendCommand", decoded, line_no)?;
            }
            "expectcasesendtext" => {
                let number = stage_number()?;
                let (case_pattern, case_text) =
                    value.split_once(char::is_whitespace).ok_or_else(|| {
                        tssh_error(line_no, "ExpectCaseSendText requires '<pattern> <answer>'")
                    })?;
                let case_pattern = case_pattern.trim();
                let stage = stages.entry(number).or_default();
                if stage.contains_key("casePattern") {
                    return Err(tssh_error(line_no, "duplicate case rule"));
                }
                stage.insert(
                    "casePattern".to_string(),
                    serde_json::Value::String(tssh_pattern_value(case_pattern.trim(), line_no)?),
                );
                stage.insert(
                    "caseSendText".to_string(),
                    serde_json::Value::String(case_text.trim().to_string()),
                );
            }
            // tssh ExpectCaseSendPassN: case pre-match answering a decrypted
            // --enc-secret secret.
            "expectcasesendpass" => {
                let number = stage_number()?;
                let (case_pattern, case_value) =
                    value.split_once(char::is_whitespace).ok_or_else(|| {
                        tssh_error(line_no, "ExpectCaseSendPass requires '<pattern> <secret>'")
                    })?;
                let case_pattern = case_pattern.trim();
                let decoded = decode_tssh_enc_secret(
                    case_value.trim(),
                    &format!("ExpectCaseSendPass{number}"),
                )?;
                let stage = stages.entry(number).or_default();
                if stage.contains_key("casePattern") {
                    return Err(tssh_error(line_no, "duplicate case rule"));
                }
                stage.insert(
                    "casePattern".to_string(),
                    serde_json::Value::String(tssh_pattern_value(case_pattern, line_no)?),
                );
                stage.insert(
                    "caseSendSecret".to_string(),
                    serde_json::Value::String(decoded),
                );
            }
            _ if name.starts_with("expectcasesend") || name.starts_with("expectsend") => {
                return Err(tssh_error(
                    line_no,
                    &format!(
                        "'{directive}' is not a supported tssh directive; supported forms: ExpectSendTextN, ExpectSendPassN, ExpectSendTotpN, ExpectSendEncTotpN, ExpectSendOtpN, ExpectSendEncOtpN, ExpectCaseSendTextN, ExpectCaseSendPassN"
                    ),
                ));
            }
            _ => {
                return Err(tssh_error(
                    line_no,
                    &format!("unknown directive '{directive}'"),
                ));
            }
        }
    }

    // tssh gates the whole feature on ExpectCount; an explicit 0 means off.
    // When the count is absent, pasted stages are taken at face value instead
    // of silently doing nothing (tssh's default 0 would be a paste foot-gun).
    let count = expect_count.unwrap_or(stages.len() as u64);
    if count == 0 {
        return Ok(None);
    }
    if stages.is_empty() {
        return Ok(None);
    }
    let mut object = serde_json::Map::new();
    if let Some(seconds) = timeout_secs {
        object.insert("timeoutSecs".to_string(), serde_json::Value::from(seconds));
    }
    if let Some(millis) = sleep_ms {
        object.insert("sleepMs".to_string(), serde_json::Value::from(millis));
    }
    if let Some(pacing) = pass_sleep {
        object.insert(
            "passSleep".to_string(),
            serde_json::Value::String(pacing.name().to_string()),
        );
    }
    let mut stage_list = Vec::new();
    for (number, stage) in stages {
        if (number as u64) > count {
            break;
        }
        stage_list.push(serde_json::Value::Object(stage));
    }
    object.insert("stages".to_string(), serde_json::Value::Array(stage_list));
    parse_object(&object, secrets)
}

fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

/// Reads a required non-empty string field; `null` counts as absent.
fn required_text<'a>(
    stage: &'a serde_json::Map<String, serde_json::Value>,
    field: &'a str,
) -> Result<Option<&'a str>, String> {
    match stage.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(text)) if !text.is_empty() => Ok(Some(text)),
        Some(serde_json::Value::String(_)) => Err(format!("{field}: must not be empty")),
        Some(other) => Err(format!(
            "{field}: expected a string, got {}",
            json_type_name(other)
        )),
    }
}

fn compile_pattern(text: &str, error_prefix: &str) -> Result<Regex, String> {
    if text.len() > MAX_PATTERN_LEN {
        return Err(format!(
            "{error_prefix}: pattern exceeds {MAX_PATTERN_LEN} characters"
        ));
    }
    Regex::new(text).map_err(|error| format!("{error_prefix}: {error}"))
}

/// Resolves a `sendSecretKey`/`caseSendSecretKey` reference against the
/// connection's secret slots (contract D5: exactly two known slots; an
/// unfilled slot is a configuration error, D7).
fn resolve_secret(
    key: &str,
    error_prefix: &str,
    secrets: &dyn Fn(&str) -> Option<String>,
) -> Result<StageAnswer, String> {
    if !SECRET_SLOT_KEYS.contains(&key) {
        return Err(format!(
            "{error_prefix}: unknown secret slot '{key}' (expected trigger_answer_1 or trigger_answer_2)"
        ));
    }
    let value = secrets(key).unwrap_or_default();
    if value.is_empty() {
        return Err(format!(
            "{error_prefix}: secret slot '{key}' is empty; fill the trigger secret field on the connection or drop the sendSecretKey reference"
        ));
    }
    Ok(StageAnswer::Secret(value))
}

fn parse_stage(
    stage: &serde_json::Map<String, serde_json::Value>,
    index: usize,
    secrets: &dyn Fn(&str) -> Option<String>,
) -> Result<TriggerStage, String> {
    let prefix = move |field: &str| format!("triggers.stages[{}].{field}", index + 1);
    let pattern_text = required_text(stage, "pattern")?
        .ok_or_else(|| prefix("pattern") + ": is required")?
        .to_string();
    let pattern = compile_pattern(&pattern_text, &prefix("pattern"))?;

    // Answer five-choose-one (contract §2.1).
    let send_text = required_text(stage, "sendText")?;
    let send_secret_key = required_text(stage, "sendSecretKey")?;
    let send_secret = required_text(stage, "sendSecret")?;
    let send_totp = required_text(stage, "sendTotp")?;
    let send_command = required_text(stage, "sendCommand")?;
    let answer_count = usize::from(send_text.is_some())
        + usize::from(send_secret_key.is_some())
        + usize::from(send_secret.is_some())
        + usize::from(send_totp.is_some())
        + usize::from(send_command.is_some());
    if answer_count == 0 {
        return Err(format!(
            "{}: exactly one of sendText, sendSecretKey, sendSecret, sendTotp or sendCommand is required",
            prefix("answer")
        ));
    }
    if answer_count > 1 {
        return Err(format!(
            "{}: sendText, sendSecretKey, sendSecret, sendTotp and sendCommand are mutually exclusive",
            prefix("answer")
        ));
    }
    let answer = if let Some(text) = send_text {
        if text.len() > MAX_SEND_TEXT_LEN {
            return Err(format!(
                "{}: answer exceeds {MAX_SEND_TEXT_LEN} characters",
                prefix("sendText")
            ));
        }
        StageAnswer::Text(text.to_string())
    } else if let Some(key) = send_secret_key {
        resolve_secret(key, &prefix("sendSecretKey"), secrets)?
    } else if let Some(secret) = send_secret {
        if secret.len() > MAX_SEND_TEXT_LEN {
            return Err(format!(
                "{}: answer exceeds {MAX_SEND_TEXT_LEN} characters",
                prefix("sendSecret")
            ));
        }
        StageAnswer::Secret(secret.to_string())
    } else if let Some(secret) = send_totp {
        let key = decode_base32_secret(secret)
            .map_err(|error| format!("{}: {error}", prefix("sendTotp")))?;
        if key.len() > MAX_TOTP_SECRET_BYTES {
            return Err(format!(
                "{}: TOTP secret exceeds {MAX_TOTP_SECRET_BYTES} bytes after base32 decoding",
                prefix("sendTotp")
            ));
        }
        StageAnswer::Totp(key)
    } else {
        let command = send_command.expect("answer_count == 1 guarantees one variant");
        if command.len() > MAX_COMMAND_LEN {
            return Err(format!(
                "{}: command exceeds {MAX_COMMAND_LEN} characters",
                prefix("sendCommand")
            ));
        }
        StageAnswer::Command(command.to_string())
    };

    // Optional case pre-match: casePattern + exactly one caseSend* (contract §2.1).
    let case_pattern_text = required_text(stage, "casePattern")?;
    let case_send_text = required_text(stage, "caseSendText")?;
    let case_send_secret_key = required_text(stage, "caseSendSecretKey")?;
    let case_send_secret = required_text(stage, "caseSendSecret")?;
    let case_answer_count = usize::from(case_send_text.is_some())
        + usize::from(case_send_secret_key.is_some())
        + usize::from(case_send_secret.is_some());
    if case_answer_count > 0 && case_pattern_text.is_none() {
        return Err(format!(
            "{}: caseSendText/caseSendSecretKey/caseSendSecret require casePattern",
            prefix("caseAnswer")
        ));
    }
    if case_pattern_text.is_some() && case_answer_count != 1 {
        return Err(format!(
            "{}: exactly one of caseSendText, caseSendSecretKey or caseSendSecret is required alongside casePattern",
            prefix("caseAnswer")
        ));
    }
    let case = match (
        case_pattern_text,
        case_send_text,
        case_send_secret_key,
        case_send_secret,
    ) {
        (Some(pattern), Some(text), None, None) => {
            if text.len() > MAX_SEND_TEXT_LEN {
                return Err(format!(
                    "{}: answer exceeds {MAX_SEND_TEXT_LEN} characters",
                    prefix("caseSendText")
                ));
            }
            Some(CaseRule {
                pattern: compile_pattern(pattern, &prefix("casePattern"))?,
                answer: StageAnswer::Text(text.to_string()),
            })
        }
        (Some(pattern), None, Some(key), None) => Some(CaseRule {
            pattern: compile_pattern(pattern, &prefix("casePattern"))?,
            answer: resolve_secret(key, &prefix("caseSendSecretKey"), secrets)?,
        }),
        (Some(pattern), None, None, Some(secret)) => {
            if secret.len() > MAX_SEND_TEXT_LEN {
                return Err(format!(
                    "{}: answer exceeds {MAX_SEND_TEXT_LEN} characters",
                    prefix("caseSendSecret")
                ));
            }
            Some(CaseRule {
                pattern: compile_pattern(pattern, &prefix("casePattern"))?,
                answer: StageAnswer::Secret(secret.to_string()),
            })
        }
        _ => None,
    };

    Ok(TriggerStage {
        pattern,
        answer,
        case,
    })
}

/// Parses a `sendText` answer: `\r` `\n` `\t` become control characters, `\|`
/// starts a new segment (the read loop pauses `sleepMs` between segments),
/// any other backslash stays literal.
pub fn parse_send_text(text: &str) -> Vec<String> {
    let mut segments: Vec<String> = vec![String::new()];
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' {
            match chars.peek().copied() {
                Some('r') => {
                    chars.next();
                    segments
                        .last_mut()
                        .expect("segments never empty")
                        .push('\r');
                }
                Some('n') => {
                    chars.next();
                    segments
                        .last_mut()
                        .expect("segments never empty")
                        .push('\n');
                }
                Some('t') => {
                    chars.next();
                    segments
                        .last_mut()
                        .expect("segments never empty")
                        .push('\t');
                }
                Some('|') => {
                    chars.next();
                    segments.push(String::new());
                }
                _ => segments
                    .last_mut()
                    .expect("segments never empty")
                    .push('\\'),
            }
        } else {
            segments
                .last_mut()
                .expect("segments never empty")
                .push(character);
        }
    }
    segments
}

/// Builds the send plan for a text answer: `\|` segments with `sleep_ms`
/// pauses before every segment but the first.
fn text_segments(text: &str, sleep_ms: u64) -> Vec<(Vec<u8>, u64)> {
    parse_send_text(text)
        .into_iter()
        .enumerate()
        .map(|(index, segment)| (segment.into_bytes(), u64::from(index > 0) * sleep_ms))
        .collect()
}

/// Builds the send plan for a secret/command answer: Enter is appended, and
/// `passSleep` controls the pacing (`none` single write, `each` char-by-char,
/// `enter` answer-then-pause-then-Enter).
pub fn pass_sleep_segments(
    answer: &str,
    sleep_ms: u64,
    pass_sleep: PassSleep,
) -> Vec<(Vec<u8>, u64)> {
    match pass_sleep {
        PassSleep::None => vec![(format!("{answer}\r").into_bytes(), 0)],
        PassSleep::Each => {
            let total = answer.chars().count();
            if total == 0 {
                return vec![(b"\r".to_vec(), 0)];
            }
            answer
                .chars()
                .enumerate()
                .map(|(index, character)| {
                    let mut bytes = character.to_string().into_bytes();
                    if index + 1 == total {
                        bytes.push(b'\r');
                    }
                    (bytes, u64::from(index > 0) * sleep_ms)
                })
                .collect()
        }
        PassSleep::Enter => {
            let mut segments = Vec::new();
            if !answer.is_empty() {
                segments.push((answer.as_bytes().to_vec(), 0));
            }
            segments.push((b"\r".to_vec(), sleep_ms));
            segments
        }
    }
}

/// A resolved answer's send plan: decision kind, the `(payload, delay_ms)`
/// segments, and the unresolved command line for `sendCommand` answers.
type AnswerPlan = (TriggerKind, Vec<(Vec<u8>, u64)>, Option<String>);

/// Builds the send plan plus decision kind for a resolved stage answer.
/// `now_ms` timestamps TOTP generation (the code must be fresh at match time).
fn answer_segments(
    answer: &StageAnswer,
    sleep_ms: u64,
    pass_sleep: PassSleep,
    now_ms: u64,
) -> AnswerPlan {
    match answer {
        StageAnswer::Text(text) => (TriggerKind::Text, text_segments(text, sleep_ms), None),
        StageAnswer::Secret(value) => (
            TriggerKind::Secret,
            pass_sleep_segments(value, sleep_ms, pass_sleep),
            None,
        ),
        StageAnswer::Totp(secret) => (
            TriggerKind::Secret,
            pass_sleep_segments(&totp_code(secret, now_ms), sleep_ms, pass_sleep),
            None,
        ),
        StageAnswer::Command(command) => {
            // The caller runs the command locally and turns the (trimmed)
            // stdout into a passSleep-shaped plan; segments stay empty until
            // then so no unresolved placeholder ever reaches the wire.
            (TriggerKind::Command, Vec::new(), Some(command.clone()))
        }
    }
}

/// Per-session trigger state machine: rolling normalized buffer (D2), stage
/// cursor, per-stage timer (seconds, `now` injected), prompt reset (D3).
pub struct TriggerEngine {
    config: TriggersConfig,
    placeholders: CommandPlaceholders,
    buffer: String,
    /// 0-based index of the stage currently being waited for.
    stage_cursor: usize,
    /// Millisecond timestamp (caller-injected) when the current stage wait
    /// started; `None` until the first chunk arms the timer.
    stage_since_ms: Option<u64>,
}

impl TriggerEngine {
    pub fn new(config: TriggersConfig, placeholders: CommandPlaceholders) -> Self {
        Self {
            config,
            placeholders,
            buffer: String::new(),
            stage_cursor: 0,
            stage_since_ms: None,
        }
    }

    pub fn placeholders(&self) -> &CommandPlaceholders {
        &self.placeholders
    }

    /// Pacing knobs for command answers: their stdout is resolved by the
    /// caller (after `observe` returned), so the caller needs the config's
    /// `sleepMs`/`passSleep` to build the final segment plan via
    /// [`pass_sleep_segments`]. Returned as `(sleep_ms, pass_sleep)`.
    pub fn pacing(&self) -> (u64, PassSleep) {
        (self.config.sleep_ms, self.config.pass_sleep)
    }

    /// Feeds one terminal output chunk (`now_ms` = Unix milliseconds). Returns
    /// the decision to act on: a stage/case answer (with its segment plan), a
    /// command to run locally, or a timeout reset. Shell prompts reset the
    /// stage cursor to stage 1 (D3) and produce no decision.
    pub fn observe(&mut self, chunk: &str, now_ms: u64) -> Option<TriggerDecision> {
        if self.config.stages.is_empty() {
            return None;
        }
        let normalized = normalize_auth_prompt_text(chunk);
        if !normalized.is_empty() {
            self.append_to_buffer(&normalized);
        }
        if self.stage_since_ms.is_none() {
            self.stage_since_ms = Some(now_ms);
        }
        // D3: a shell prompt means the previous round finished; re-arm at
        // stage 1 (tssh "expect re-arms after the login sequence").
        if has_shell_prompt(&self.buffer) {
            self.reset_stage(now_ms);
            return None;
        }
        // Case pre-match answers without advancing the cursor (contract §0).
        if let Some(decision) = self.try_case_match(now_ms) {
            return Some(decision);
        }
        if let Some(decision) = self.try_stage_match(now_ms) {
            return Some(decision);
        }
        self.check_timeout(now_ms)
    }

    fn append_to_buffer(&mut self, normalized: &str) {
        self.buffer.push_str(normalized);
        let overflow = self.buffer.len().saturating_sub(MAX_BUFFER_BYTES);
        if overflow > 0 {
            let mut cut = overflow;
            while !self.buffer.is_char_boundary(cut) {
                cut += 1;
            }
            self.buffer.drain(..cut);
        }
    }

    fn consume_buffer(&mut self, through: usize) {
        self.buffer.drain(..through.min(self.buffer.len()));
    }

    fn reset_stage(&mut self, now_ms: u64) {
        self.stage_cursor = 0;
        self.stage_since_ms = Some(now_ms);
    }

    fn try_case_match(&mut self, now_ms: u64) -> Option<TriggerDecision> {
        let case = self.config.stages[self.stage_cursor].case.as_ref()?;
        let matched = case.pattern.find(&self.buffer)?;
        let (kind, segments, command) = answer_segments(
            &case.answer,
            self.config.sleep_ms,
            self.config.pass_sleep,
            now_ms,
        );
        // Consume the matched text so the same case text cannot answer twice;
        // the stage cursor intentionally stays put.
        self.consume_buffer(matched.end());
        Some(TriggerDecision {
            stage: self.stage_cursor + 1,
            kind,
            segments,
            command,
        })
    }

    fn try_stage_match(&mut self, now_ms: u64) -> Option<TriggerDecision> {
        // Copy the match span and answer out first: `consume_buffer` mutates
        // the buffer the regex match borrows.
        let (match_end, answer) = {
            let stage = &self.config.stages[self.stage_cursor];
            let matched = stage.pattern.find(&self.buffer)?;
            (matched.end(), stage.answer.clone())
        };
        // D2: consume the matched text so later chunks continue past it.
        self.consume_buffer(match_end);
        let (kind, segments, command) = answer_segments(
            &answer,
            self.config.sleep_ms,
            self.config.pass_sleep,
            now_ms,
        );
        let stage_number = self.stage_cursor + 1;
        // Advance (wrapping so a completed sequence can run again without a
        // shell prompt in between) and restart the next stage's timer.
        self.stage_cursor = (self.stage_cursor + 1) % self.config.stages.len();
        self.stage_since_ms = Some(now_ms);
        Some(TriggerDecision {
            stage: stage_number,
            kind,
            segments,
            command,
        })
    }

    fn check_timeout(&mut self, now_ms: u64) -> Option<TriggerDecision> {
        // Timeout only applies mid-sequence: once a stage has been answered
        // and the engine waits for the next one. Waiting for stage 1 is an
        // event-driven, open-ended wait — an idle session must not spam
        // timeout decisions every `timeoutSecs`.
        if self.stage_cursor == 0 {
            return None;
        }
        let since = self.stage_since_ms?;
        if now_ms.saturating_sub(since) < self.config.timeout_secs.saturating_mul(1000) {
            return None;
        }
        let stage = self.stage_cursor + 1;
        // D3: a timeout zeroes the cursor and reports; the session keeps
        // running and the next window starts from stage 1.
        self.stage_cursor = 0;
        self.stage_since_ms = Some(now_ms);
        Some(TriggerDecision {
            stage,
            kind: TriggerKind::Timeout,
            segments: Vec::new(),
            command: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_secrets(_key: &str) -> Option<String> {
        None
    }

    fn slot_secrets(key: &str) -> Option<String> {
        match key {
            "trigger_answer_1" => Some("s3cret-one".to_string()),
            "trigger_answer_2" => Some("s3cret-two".to_string()),
            _ => None,
        }
    }

    fn parse_config(value: serde_json::Value) -> TriggersConfig {
        parse_triggers(Some(&value), &slot_secrets)
            .expect("config must parse")
            .expect("config must be enabled")
    }

    fn parse_err(value: serde_json::Value) -> String {
        parse_triggers(Some(&value), &slot_secrets).expect_err("config must be rejected")
    }

    // —— 解析与校验（D7/D8）———————————————————————————

    #[test]
    fn parse_minimal_object_config_with_defaults() {
        let config = parse_config(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r" }]
        }));
        assert_eq!(config.timeout_secs, DEFAULT_TIMEOUT_SECS);
        assert_eq!(config.sleep_ms, DEFAULT_SLEEP_MS);
        assert_eq!(config.pass_sleep, PassSleep::None);
        assert_eq!(config.stages.len(), 1);
        assert!(config.stages[0].case.is_none());
    }

    #[test]
    fn parse_accepts_json_string_form() {
        // 连接表单 textarea 送达的是字符串形态。
        let config = parse_triggers(
            Some(&json!(
                r#"{"stages":[{"pattern":"code","sendText":"1\r"}]}"#
            )),
            &no_secrets,
        )
        .unwrap()
        .unwrap();
        assert_eq!(config.stages.len(), 1);
    }

    #[test]
    fn parse_empty_or_stageless_config_disables_feature() {
        for value in [
            json!(null),
            json!(""),
            json!("   "),
            json!({}),
            json!({ "timeoutSecs": 30 }),
            json!({ "stages": [] }),
        ] {
            assert!(
                parse_triggers(Some(&value), &no_secrets).unwrap().is_none(),
                "expected disabled for {value}"
            );
        }
        assert!(parse_triggers(None, &no_secrets).unwrap().is_none());
    }

    #[test]
    fn parse_rejects_invalid_json_string() {
        let error = parse_triggers(Some(&json!("{not json")), &no_secrets).unwrap_err();
        assert!(error.contains("invalid JSON"), "{error}");
        // 非 JSON 对象/字符串形态同样拒绝。
        let error = parse_triggers(Some(&json!(42)), &no_secrets).unwrap_err();
        assert!(error.contains("expected a JSON object"), "{error}");
    }

    #[test]
    fn parse_json_enabled_flag_switches_engine_without_deleting_stages() {
        // enabled:false 保留规则但显式关闭引擎；enabled:true 等价缺省。
        let disabled = json!({
            "enabled": false,
            "stages": [{ "pattern": "code", "sendText": "1\\r" }]
        });
        assert!(parse_triggers(Some(&disabled), &no_secrets)
            .unwrap()
            .is_none());
        let enabled = json!({
            "enabled": true,
            "stages": [{ "pattern": "code", "sendText": "1\\r" }]
        });
        assert!(parse_triggers(Some(&enabled), &no_secrets)
            .unwrap()
            .is_some());
        let error = parse_err(json!({ "enabled": "yes", "stages": [] }));
        assert!(error.contains("triggers.enabled"), "{error}");
    }

    #[test]
    fn parse_tssh_text_form_maps_directives() {
        // tssh（trzsz-ssh）自动交互文本形态：#!! 前缀、Expect* 指令。
        let text = [
            "#!! ExpectCount 2",
            "#!! ExpectTimeout 45",
            "#!! ExpectSleepMS 250",
            "#!! ExpectPassSleep enter",
            "#!! ExpectPattern1 (?i)are you sure",
            "#!! ExpectSendText1 yes\\r",
            "#!! ExpectCaseSendText2 continue\\? no",
            "#!! ExpectPattern2 hostname.*$",
            "#!! ExpectSendOtp2 oathtool --totp -b K",
        ]
        .join("\n");
        let config = parse_triggers(Some(&json!(text)), &no_secrets)
            .unwrap()
            .unwrap();
        assert_eq!(config.timeout_secs, 45);
        assert_eq!(config.sleep_ms, 250);
        assert_eq!(config.pass_sleep, PassSleep::Enter);
        assert_eq!(config.stages.len(), 2);
        assert_eq!(config.stages[0].answer, StageAnswer::Text("yes\\r".into()));
        let case = config.stages[1].case.as_ref().expect("case rule parsed");
        assert!(case.pattern.is_match("continue?"));
        assert_eq!(
            config.stages[1].answer,
            StageAnswer::Command("oathtool --totp -b K".into())
        );
    }

    #[test]
    fn parse_tssh_expect_count_gates_and_truncates() {
        // ExpectCount 0 是 tssh 语义的显式关闭；缺省时不让粘贴的规则静默失效。
        let off = "ExpectCount 0\nExpectPattern1 code\nExpectSendText1 yes";
        assert!(parse_triggers(Some(&json!(off)), &no_secrets)
            .unwrap()
            .is_none());
        let on = "ExpectPattern1 code\nExpectSendText1 yes";
        let config = parse_triggers(Some(&json!(on)), &no_secrets)
            .unwrap()
            .unwrap();
        assert_eq!(config.stages.len(), 1);
        // ExpectCount 截断超出序号的阶段。
        let truncated = [
            "ExpectCount 1",
            "ExpectPattern1 a",
            "ExpectSendText1 x",
            "ExpectPattern2 b",
            "ExpectSendText2 y",
        ]
        .join("\n");
        let config = parse_triggers(Some(&json!(truncated)), &no_secrets)
            .unwrap()
            .unwrap();
        assert_eq!(config.stages.len(), 1);
        assert_eq!(config.stages[0].pattern.as_str(), "a");
    }

    #[test]
    fn parse_tssh_non_regex_pattern_falls_back_to_literal() {
        // tssh README 示例 `*assword` 不是合法正则：文本形态按字面量匹配兜底，
        // JSON 形态保持 D7 严格失败不受影响。
        let text = "ExpectPattern1 *assword\nExpectSendText1 pw\\r";
        let config = parse_triggers(Some(&json!(text)), &no_secrets)
            .unwrap()
            .unwrap();
        assert!(config.stages[0].pattern.is_match("Enter *assword:"));
        assert!(!config.stages[0].pattern.is_match("Enter password:"));
    }

    #[test]
    fn parse_tssh_ciphertext_and_totp_answers_are_fully_supported() {
        // tssh --enc-secret 密文与 TOTP 指令全兼容（0.4.77）：与 tssh 同款
        // AES-256-GCM 固定密钥解密，TOTP 按 RFC 6238 生成。
        fn tssh_encrypt(plaintext: &[u8]) -> String {
            use aes_gcm::aead::Aead;
            let cipher = Aes256Gcm::new(TSSH_ENC_SECRET_KEY.into());
            let nonce = Nonce::from_slice(b"0123456789ab");
            // tssh Seal(nonce, nonce, secret, nil) prefixes the nonce itself.
            let mut blob = nonce.to_vec();
            blob.extend_from_slice(&cipher.encrypt(nonce, plaintext).unwrap());
            data_encoding::HEXLOWER.encode(&blob)
        }
        let pass_blob = tssh_encrypt(b"s3cret-pass");
        let otp_blob = tssh_encrypt(b"oathtool --totp -b K");
        let totp_blob = tssh_encrypt(b"GEZDGNBVGY3TQOJQ");

        let text = format!(
            "#!! ExpectCount 2\n\
             #!! ExpectPattern1 *assword\n\
             #!! ExpectSendPass1 {pass_blob}\n\
             #!! ExpectCaseSendPass1 token {pass_blob}\n\
             #!! ExpectPattern2 token:\n\
             #!! ExpectSendEncTotp2 {totp_blob}"
        );
        let config = parse_triggers(Some(&json!(text)), &no_secrets)
            .unwrap()
            .unwrap();
        assert_eq!(
            config.stages[0].answer,
            StageAnswer::Secret("s3cret-pass".into())
        );
        let case = config.stages[0].case.as_ref().expect("case rule parsed");
        assert_eq!(case.answer, StageAnswer::Secret("s3cret-pass".into()));
        assert_eq!(
            config.stages[1].answer,
            StageAnswer::Totp(b"1234567890".to_vec()),
            "decrypted base32 secret is decoded to raw key bytes"
        );

        // ExpectSendEncOtpN 解密后是本地命令（= sendCommand）。
        let text = format!("ExpectPattern1 token:\nExpectSendEncOtp1 {otp_blob}");
        let config = parse_triggers(Some(&json!(text)), &no_secrets)
            .unwrap()
            .unwrap();
        assert_eq!(
            config.stages[0].answer,
            StageAnswer::Command("oathtool --totp -b K".into())
        );

        // ExpectSendTotpN：明文 base32 密钥直接解码（GEZDGNBVGY3TQOJQ → "1234567890"）。
        let config = parse_triggers(
            Some(&json!(
                "#!! ExpectPattern1 code\n#!! ExpectSendTotp1 gezd gnbv gy3t qojq"
            )),
            &no_secrets,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            config.stages[0].answer,
            StageAnswer::Totp(b"1234567890".to_vec())
        );
    }

    #[test]
    fn totp_code_matches_rfc6238_sha1_vectors() {
        // RFC 6238 附录 B（SHA1，8 位截 6 位）；密钥为 ASCII "12345678901234567890"。
        let secret = b"12345678901234567890";
        assert_eq!(totp_code(secret, 59_000), "287082");
        assert_eq!(totp_code(secret, 1_111_111_109_000), "081804");
        assert_eq!(totp_code(secret, 1_234_567_890_000), "005924");
        assert_eq!(totp_code(secret, 2_000_000_000_000), "279037");
    }

    #[test]
    fn engine_answers_totp_stage_with_fresh_code() {
        // RFC 6238 向量密钥（ASCII "12345678901234567890" 的 base32）。
        let config = parse_config(json!({
            "stages": [{ "pattern": "token:", "sendTotp": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }]
        }));
        let mut engine = TriggerEngine::new(config, CommandPlaceholders::new("h", "u", 22, "n"));
        let decision = engine
            .observe("Please enter token: ", 59_000)
            .expect("stage must answer");
        assert_eq!(decision.kind, TriggerKind::Secret);
        assert_eq!(
            decision.segments,
            pass_sleep_segments("287082", 100, PassSleep::None),
            "segments carry the code generated at match time"
        );
    }

    #[test]
    fn parse_tssh_ciphertext_and_totp_inputs_still_validate() {
        // 非法 hex / 截断 blob / 非法 base32 → 明确报错（连接失败，D7）。
        for text in [
            "#!! ExpectSendPass1 d7983b4a",
            "#!! ExpectSendEncTotp1 zznot-hex",
            "#!! ExpectSendTotp1 not!base32",
        ] {
            let error =
                parse_triggers(Some(&json!(text)), &no_secrets).expect_err("must be rejected");
            assert!(
                error.contains("enc-secret") || error.contains("base32"),
                "{error}"
            );
        }
        let error = parse_triggers(
            Some(&json!({
                "stages": [{ "pattern": "code", "sendTotp": "not!base32" }]
            })),
            &no_secrets,
        )
        .unwrap_err();
        assert!(error.contains("base32"), "{error}");
    }

    #[test]
    fn parse_tssh_unknown_directive_errors_but_json_errors_stay_json() {
        let error = parse_triggers(Some(&json!("#!! ExpectWrong1 foo")), &no_secrets)
            .expect_err("must be rejected");
        assert!(error.contains("unknown directive"), "{error}");
        // 非法 JSON 且不含 Expect 指令 → 维持原 JSON 报错，不被 tssh 分流吞掉。
        let error = parse_triggers(Some(&json!("{not json")), &no_secrets).unwrap_err();
        assert!(error.contains("invalid JSON"), "{error}");
        // 无阶段的全局指令 = 功能关闭。
        assert!(
            parse_triggers(Some(&json!("#!! ExpectCount 3")), &no_secrets)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn parse_enforces_answer_three_way_choice() {
        let error = parse_err(json!({ "stages": [{ "pattern": "code" }] }));
        assert!(error.contains("exactly one of sendText"), "{error}");
        let error = parse_err(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r", "sendCommand": "echo hi" }]
        }));
        assert!(error.contains("mutually exclusive"), "{error}");
    }

    #[test]
    fn parse_enforces_case_group_rules() {
        // case 应答缺 casePattern。
        let error = parse_err(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r", "caseSendText": "y" }]
        }));
        assert!(error.contains("require casePattern"), "{error}");
        // casePattern 缺 case 应答。
        let error = parse_err(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r", "casePattern": "y/n" }]
        }));
        assert!(error.contains("exactly one of caseSendText"), "{error}");
        // case 应答二选一。
        let error = parse_err(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r",
                "casePattern": "y/n", "caseSendText": "y", "caseSendSecretKey": "trigger_answer_2" }]
        }));
        assert!(error.contains("exactly one of caseSendText"), "{error}");
        // 合法 case 组解析成功。
        let config = parse_config(json!({
            "stages": [{ "pattern": "code", "sendText": "1\\r",
                "casePattern": "\\(y/n\\)", "caseSendText": "y" }]
        }));
        assert!(config.stages[0].case.is_some());
    }

    #[test]
    fn parse_enforces_limits() {
        // 阶段数上限 16（D8）。
        let stages: Vec<_> = (0..17)
            .map(|index| json!({ "pattern": format!("p{index}"), "sendText": "1\\r" }))
            .collect();
        let error = parse_err(json!({ "stages": stages }));
        assert!(error.contains("at most 16"), "{error}");
        // pattern 长度上限 512（对齐 MAX_PROMPT_HINT_LEN）。
        let error = parse_err(json!({
            "stages": [{ "pattern": "a".repeat(513), "sendText": "1\\r" }]
        }));
        assert!(error.contains("exceeds 512"), "{error}");
        // timeoutSecs 1..=600。
        for timeout in [0u64, 601] {
            let error = parse_err(json!({
                "stages": [{ "pattern": "p", "sendText": "1\\r" }], "timeoutSecs": timeout
            }));
            assert!(error.contains("timeoutSecs"), "{error}");
        }
        // sleepMs 0..=5000。
        let error = parse_err(json!({
            "stages": [{ "pattern": "p", "sendText": "1\\r" }], "sleepMs": 5001
        }));
        assert!(error.contains("sleepMs"), "{error}");
        // passSleep 枚举。
        let error = parse_err(json!({
            "stages": [{ "pattern": "p", "sendText": "1\\r" }], "passSleep": "sometimes"
        }));
        assert!(error.contains("none, each or enter"), "{error}");
    }

    #[test]
    fn parse_rejects_uncompilable_regex() {
        let error = parse_err(json!({
            "stages": [{ "pattern": "code(", "sendText": "1\\r" }]
        }));
        assert!(error.contains("stages[1].pattern"), "{error}");
    }

    #[test]
    fn parse_rejects_unknown_secret_slot() {
        // 未知槽位拒绝（D5：只有两个固定槽位）。
        let error = parse_err(json!({
            "stages": [{ "pattern": "code", "sendSecretKey": "my_own_key" }]
        }));
        assert!(error.contains("unknown secret slot"), "{error}");
    }

    #[test]
    fn parse_rejects_empty_secret_slot() {
        let error = parse_triggers(
            Some(&json!({
                "stages": [{ "pattern": "code", "sendSecretKey": "trigger_answer_1" }]
            })),
            &no_secrets,
        )
        .unwrap_err();
        assert!(error.contains("is empty"), "{error}");
        // 已填充槽位解析为密文应答。
        let config = parse_config(json!({
            "stages": [{ "pattern": "code", "sendSecretKey": "trigger_answer_1" }]
        }));
        assert_eq!(config.stages[0].answer.kind(), "secret");
    }

    #[test]
    fn debug_redacts_secret_answers() {
        let config = parse_config(json!({
            "stages": [{ "pattern": "code", "sendSecretKey": "trigger_answer_1" }]
        }));
        let dump = format!("{config:?}");
        assert!(!dump.contains("s3cret-one"), "debug leaked secret: {dump}");
        assert!(dump.contains("<redacted>"), "{dump}");
    }

    // —— sendText 转义与分段 ——————————————————————————

    #[test]
    fn parse_send_text_escapes_and_splits() {
        assert_eq!(parse_send_text("abc"), vec!["abc"]);
        // \r \n \t 解释为控制字符。
        assert_eq!(parse_send_text(r"a\rb\nc\td"), vec!["a\rb\nc\td"]);
        // \| 为分段停顿符。
        assert_eq!(parse_send_text(r"first\|second"), vec!["first", "second"]);
        // 其余反斜杠原样。
        assert_eq!(parse_send_text(r"a\qb"), vec![r"a\qb"]);
        assert_eq!(parse_send_text(r"trail\"), vec![r"trail\"]);
        // 空段（\|\|）保留为停顿。
        assert_eq!(parse_send_text(r"a\|\|b"), vec!["a", "", "b"]);
    }

    #[test]
    fn text_segments_carry_sleep_delays() {
        let segments = text_segments(r"go\|slow", 250);
        assert_eq!(
            segments,
            vec![(b"go".to_vec(), 0), (b"slow".to_vec(), 250),]
        );
    }

    #[test]
    fn pass_sleep_shapes_secret_segments() {
        // none：整段 + \r 一次写入。
        assert_eq!(
            pass_sleep_segments("pw", 100, PassSleep::None),
            vec![(b"pw\r".to_vec(), 0)]
        );
        // each：逐字符 + sleep，Enter 拼在最后一个字符后。
        assert_eq!(
            pass_sleep_segments("ab", 40, PassSleep::Each),
            vec![(b"a".to_vec(), 0), (b"b\r".to_vec(), 40)]
        );
        // 空应答 only Enter。
        assert_eq!(
            pass_sleep_segments("", 40, PassSleep::Each),
            vec![(b"\r".to_vec(), 0)]
        );
        // enter：应答、停顿、Enter。
        assert_eq!(
            pass_sleep_segments("ab", 60, PassSleep::Enter),
            vec![(b"ab".to_vec(), 0), (b"\r".to_vec(), 60)]
        );
    }

    // —— 引擎行为 ——————————————————————————————————

    fn text_engine(pattern: &str, text: &str) -> TriggerEngine {
        TriggerEngine::new(
            parse_config(
                json!({ "stages": [{ "pattern": format!("(?i){pattern}"), "sendText": text }] }),
            ),
            CommandPlaceholders::new("host", "user", 22, "name"),
        )
    }

    #[test]
    fn engine_matches_and_advances_cursor() {
        let config = parse_config(json!({
            "stages": [
                { "pattern": "login:", "sendText": "user\\r" },
                { "pattern": "code:", "sendText": "42\\r" }
            ]
        }));
        let mut engine = TriggerEngine::new(config, CommandPlaceholders::new("h", "u", 22, "n"));
        let first = engine
            .observe("Welcome. login:", 1_000)
            .expect("stage 1 fires");
        assert_eq!(first.stage, 1);
        assert_eq!(first.kind, TriggerKind::Text);
        assert_eq!(first.segments, vec![(b"user\r".to_vec(), 0)]);
        let second = engine
            .observe("verification code:", 1_100)
            .expect("stage 2 fires");
        assert_eq!(second.stage, 2);
        assert_eq!(second.segments, vec![(b"42\r".to_vec(), 0)]);
        // 游标已回卷：stage 1 的 pattern 再次命中可重新触发。
        let third = engine.observe("login:", 1_200).expect("wraps to stage 1");
        assert_eq!(third.stage, 1);
    }

    #[test]
    fn engine_matches_across_chunks() {
        let mut engine = text_engine("verification code", "1234\r");
        assert!(
            engine.observe("Verifica", 1_000).is_none(),
            "partial chunk must not fire"
        );
        let decision = engine
            .observe("tion code:", 1_050)
            .expect("cross-chunk match");
        assert_eq!(decision.stage, 1);
        assert_eq!(decision.segments, vec![(b"1234\r".to_vec(), 0)]);
    }

    #[test]
    fn engine_case_pre_match_does_not_advance_cursor() {
        let config = parse_config(json!({
            "stages": [
                { "pattern": "server ready", "sendText": "go\\r",
                  "casePattern": "continue\\? \\(y/n\\)", "caseSendText": "y" },
                { "pattern": "done", "sendText": "ok\\r" }
            ]
        }));
        let mut engine = TriggerEngine::new(config, CommandPlaceholders::new("h", "u", 22, "n"));
        let case = engine
            .observe("continue? (y/n)", 1_000)
            .expect("case rule fires");
        assert_eq!(case.stage, 1);
        assert_eq!(case.segments, vec![(b"y".to_vec(), 0)]);
        // case 命中不推进游标：随后本阶段 pattern 命中仍是 stage 1。
        let stage = engine.observe("server ready", 1_100).expect("stage fires");
        assert_eq!(stage.stage, 1);
        assert_eq!(stage.segments, vec![(b"go\r".to_vec(), 0)]);
        // 游标此刻在 stage 2。
        let second = engine.observe("done", 1_200).expect("stage 2 fires");
        assert_eq!(second.stage, 2);
    }

    #[test]
    fn engine_shell_prompt_resets_cursor() {
        let config = parse_config(json!({
            "stages": [
                { "pattern": "login:", "sendText": "user\\r" },
                { "pattern": "password:", "sendText": "pw\\r" }
            ]
        }));
        let mut engine = TriggerEngine::new(config, CommandPlaceholders::new("h", "u", 22, "n"));
        assert!(engine.observe("login:", 1_000).is_some());
        // 登录序列被 shell 提示打断：游标归零（D3），下一轮从 stage 1 开始。
        assert!(engine.observe("user@host:~$ ", 1_100).is_none());
        let again = engine
            .observe("login:", 1_200)
            .expect("re-armed at stage 1");
        assert_eq!(again.stage, 1);
    }

    #[test]
    fn engine_timeout_resets_and_reports() {
        let mut engine = TriggerEngine::new(
            parse_config(json!({
                "timeoutSecs": 1,
                "stages": [
                    { "pattern": "login:", "sendText": "user\\r" },
                    { "pattern": "password:", "sendText": "pw\\r" }
                ]
            })),
            CommandPlaceholders::new("h", "u", 22, "n"),
        );
        assert!(
            engine.observe("login:", 1_000).is_some(),
            "stage 1 answered"
        );
        assert!(engine.observe("still waiting", 1_500).is_none());
        let timeout = engine
            .observe("still waiting", 2_001)
            .expect("timeout fires");
        assert_eq!(timeout.stage, 2, "timeout reports the pending stage");
        assert_eq!(timeout.kind, TriggerKind::Timeout);
        assert!(timeout.segments.is_empty());
        // 超时后游标归零：stage 1 的 pattern 可以直接再次命中。
        let again = engine.observe("login:", 2_100).expect("re-armed");
        assert_eq!(again.stage, 1);
    }

    #[test]
    fn engine_idle_wait_does_not_time_out() {
        // 空闲等 stage 1 是事件驱动的无限期等待：超时只在序列中途生效，
        // 否则闲置会话每 timeoutSecs 刷一次 timeout 事件。
        let mut engine = TriggerEngine::new(
            parse_config(json!({
                "timeoutSecs": 1,
                "stages": [
                    { "pattern": "login:", "sendText": "user\\r" },
                    { "pattern": "password:", "sendText": "pw\\r" }
                ]
            })),
            CommandPlaceholders::new("h", "u", 22, "n"),
        );
        for now_ms in [1_000u64, 5_000, 60_000, 600_000] {
            assert!(
                engine.observe("unrelated output", now_ms).is_none(),
                "idle stage-1 wait must not report timeout"
            );
        }
        assert_eq!(engine.stage_cursor, 0, "cursor stays armed at stage 1");
        // 空闲后照样能直接命中 stage 1。
        let first = engine.observe("login:", 610_000).expect("stage 1 fires");
        assert_eq!(first.stage, 1);
        // 进入序列中途后，超时语义恢复正常。
        let timeout = engine
            .observe("unrelated output", 611_100)
            .expect("mid-sequence timeout fires");
        assert_eq!(timeout.kind, TriggerKind::Timeout);
    }

    #[test]
    fn engine_strips_ansi_before_matching() {
        let mut engine = text_engine("verification code", "1\\r");
        let decision = engine
            .observe("\x1b[1mVerification CODE:\x1b[0m", 1_000)
            .expect("ansi-wrapped prompt matches");
        assert_eq!(decision.stage, 1);
    }

    #[test]
    fn engine_command_answer_defers_execution() {
        let mut engine = TriggerEngine::new(
            parse_config(json!({
                "stages": [{ "pattern": "code:", "sendCommand": "oathtool --totp -b %h" }]
            })),
            CommandPlaceholders::new("host1", "u", 22, "n"),
        );
        let decision = engine.observe("code:", 1_000).expect("command stage fires");
        assert_eq!(decision.kind, TriggerKind::Command);
        // 占位符替换发生在 execute_command（读循环调用侧），决策携带原命令。
        assert_eq!(decision.command.as_deref(), Some("oathtool --totp -b %h"));
        assert!(
            decision.segments.is_empty(),
            "command output is resolved by the caller"
        );
    }

    // —— 占位符与命令执行（D4）———————————————————————

    #[test]
    fn placeholders_substitution() {
        let placeholders = CommandPlaceholders::new("example.com", "deploy", 2222, "prod-box");
        assert_eq!(
            apply_command_placeholders("%u@%h:%p (%n) 100%%", &placeholders),
            "deploy@example.com:2222 (prod-box) 100%"
        );
        // 未知 %x 原样保留。
        assert_eq!(apply_command_placeholders("%s%z", &placeholders), "%s%z");
        assert_eq!(apply_command_placeholders("100%", &placeholders), "100%");
    }

    #[cfg(unix)] // echo 单引号语义依赖 POSIX shell，Windows 下无对应行为
    #[tokio::test]
    async fn execute_command_echo_positive_case() {
        let placeholders = CommandPlaceholders::new("example.com", "deploy", 2222, "prod-box");
        // 占位符替换 + stdout 去单个结尾换行。
        let answer = execute_command(
            &ShellExecutor,
            "echo '%u@%h:%p'",
            &placeholders,
            Duration::from_secs(5),
        )
        .await
        .expect("echo must succeed");
        assert_eq!(answer.as_str(), "deploy@example.com:2222");
    }

    #[tokio::test]
    async fn execute_command_strips_single_trailing_newline() {
        let placeholders = CommandPlaceholders::new("h", "u", 22, "n");
        let answer = execute_command(
            &ShellExecutor,
            "printf 'pw\\n\\n'",
            &placeholders,
            Duration::from_secs(5),
        )
        .await
        .expect("printf must succeed");
        assert_eq!(
            answer.as_str(),
            "pw\n",
            "exactly one trailing newline is stripped"
        );
        let answer = execute_command(
            &ShellExecutor,
            "printf 'pw\\r\\n'",
            &placeholders,
            Duration::from_secs(5),
        )
        .await
        .expect("printf must succeed");
        assert_eq!(answer.as_str(), "pw");
    }

    #[cfg(unix)] // 依赖 POSIX sleep/ExitStatusExt，Windows 下无语义
    #[tokio::test]
    async fn execute_command_timeout_negative_case() {
        let placeholders = CommandPlaceholders::new("h", "u", 22, "n");
        let error = execute_command(
            &ShellExecutor,
            "sleep 5",
            &placeholders,
            Duration::from_millis(150),
        )
        .await
        .expect_err("sleep must time out");
        assert!(error.contains("timed out"), "{error}");
    }

    #[cfg(unix)] // ExitStatusExt::from_raw 是 POSIX 专属
    #[tokio::test]
    async fn execute_command_reports_exit_code_without_output() {
        use std::os::unix::process::ExitStatusExt;

        struct FailingExecutor;
        impl CommandExecutor for FailingExecutor {
            fn run(
                &self,
                _command: &str,
            ) -> Pin<Box<dyn Future<Output = std::io::Result<Output>> + Send + '_>> {
                Box::pin(async {
                    let output = Output {
                        status: std::process::ExitStatus::from_raw(3 << 8),
                        stdout: b"TOP SECRET OUTPUT".to_vec(),
                        stderr: Vec::new(),
                    };
                    Ok(output)
                })
            }
        }
        let placeholders = CommandPlaceholders::new("h", "u", 22, "n");
        let error = execute_command(
            &FailingExecutor,
            "false",
            &placeholders,
            Duration::from_secs(5),
        )
        .await
        .expect_err("non-zero exit must error");
        assert!(error.contains("exited with code 3"), "{error}");
        assert!(
            !error.contains("TOP SECRET"),
            "command output must never surface in errors: {error}"
        );
    }

    // —— 密文应答的发送计划（读循环消费）—————————————————

    #[test]
    fn secret_answer_segments_follow_pass_sleep() {
        let config = parse_config(json!({
            "sleepMs": 500,
            "passSleep": "enter",
            "stages": [{ "pattern": "code:", "sendSecretKey": "trigger_answer_1" }]
        }));
        let mut engine = TriggerEngine::new(config, CommandPlaceholders::new("h", "u", 22, "n"));
        let decision = engine.observe("code:", 1_000).expect("secret stage fires");
        assert_eq!(decision.kind, TriggerKind::Secret);
        // enter 形态：密文一次写入，停顿 500ms 后补 Enter（密文内容不出现在
        // 事件里，只进入发送计划）。
        assert_eq!(
            decision.segments,
            vec![(b"s3cret-one".to_vec(), 0), (b"\r".to_vec(), 500),]
        );
    }
}
