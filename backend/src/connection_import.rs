//! Session import from third-party SSH clients (parity wave P2-2, M7 four
//! source additions). Seven source formats are parsed into a common
//! in-memory shape:
//!
//! - **MobaXterm** `.mxtsessions`: a plain INI where every `Bookmarks*`
//!   section lists `SessionName=#109#0%host%port%user%...` pipe-separated
//!   connection strings. No password material exists in the file.
//! - **Xshell** `.xts`: a ZIP of per-session `.xsh` INI files (GBK entry
//!   names on Chinese Windows installs). Only session metadata lives in
//!   `.xsh`; a key file is referenced by name, never embedded.
//! - **WindTerm** `.sessions` + `user.config`: JSON; `session.autoLogin`
//!   holds either a plaintext credential JSON or a base64 AES-256-CBC blob
//!   whose key/IV are PBKDF2-HMAC-SHA3-512 derived from the master password
//!   and the `application.fingerprint` salt.
//! - **SecureCRT** `.xml` session export: a tree of `<key name="...">`
//!   frames with `<string>/<dword>` leaves (dwords are zero-padded 8-digit
//!   hex). The export only ever contains encrypted password blobs, which are
//!   never decoded — sessions keep password semantics with no material.
//! - **FinalShell** conn directory packed as a ZIP (or a bare
//!   `*_connect_config.json`): `folder.json` builds the group tree; the
//!   per-connection JSON uses FinalShell's own DES scheme for passwords,
//!   which stays unread and flagged like SecureCRT.
//! - **Electerm** bookmarks JSON: a bare array, or the `{bookmarks,
//!   bookmarkGroups}` object; groups are resolved through `bookmarkIds` /
//!   `bookmarkGroupIds` parent chains.
//! - **Termius** export JSON: `hosts` + `groups` / `ssh_configs` /
//!   `identities` / `keys` under an optional `data` wrapper. Secret fields
//!   that arrive as encrypted sync blobs (`BA…` base64) are dropped, never
//!   decrypted; plaintext passwords and PEM private keys are carried over.
//!
//! Parsed secrets exist only for the duration of one preview request. The
//! streaming transport retains source bytes only until `import/preview/finish`
//! returns a sanitized preview; no imported connection or credential is ever
//! persisted by this plugin.
//!
//! All parsers are written for hostile input: no panicking indexing (only
//! `get`/`strip_*`/checked parsing), per-file and aggregate size caps on
//! archives, and malformed entries degrade to "skipped" instead of failing
//! the whole import.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

/// Hard caps for Xshell ZIP archives (zip-bomb protection).
pub const MAX_ZIP_ENTRIES: usize = 10_000;
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Total byte budget across the main export and optional WindTerm user.config.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
/// Binary chunks stay well below the host's JSON message limit and match SFTP's
/// bounded, acknowledged upload pattern.
pub const IMPORT_CHUNK_LIMIT: usize = 256 * 1024;
/// Bound the JSON preview/export response to remain below the SDK 8 MiB limit.
pub const MAX_PREVIEW_SESSIONS: usize = 1000;
const MAX_PREVIEW_TEXT_BYTES: usize = 4096;
/// At most this many unfinished imports may retain process memory at once.
pub const MAX_IMPORT_TASKS: usize = 4;
/// Declared input budgets across every live task share one process cap.
pub const MAX_IMPORT_MEMORY_BYTES: u64 = MAX_INPUT_BYTES as u64;
/// Unfinished preview uploads are discarded after this period.
pub const IMPORT_TASK_TTL: Duration = Duration::from_secs(5 * 60);
const LEGACY_STORE_FILE: &str = "imported-connections.json";
/// Error returned when WindTerm encryption is detected (master-password
/// switch on in `user.config`) but the caller did not supply the password.
pub const WINDTERM_MASTER_PASSWORD_REQUIRED: &str = "WindTerm master password is required";

/// Preview secret-note codes: why an imported session has no credential
/// material despite password semantics. The frontend maps them to localized
/// copy (see `importWizard.note.*` in `lib/i18n.ts`); no import output is
/// persisted.
pub const SECRET_NOTE_ENCRYPTED: &str = "encrypted";
pub const SECRET_NOTE_NOT_CARRIED: &str = "not-carried";

/// WindTerm KDF parameters: PBKDF2-HMAC-SHA3-512 over the master password,
/// salted with the raw `application.fingerprint` bytes, producing 48 bytes
/// (AES-256 key + CBC IV).
const WINDTERM_PBKDF2_ROUNDS: u32 = 100_000;
const WINDTERM_DERIVED_BYTES: usize = 48;

/// Non-sensitive authentication metadata carried by one imported preview.
///
/// This is deliberately not a credential container: plaintext passwords,
/// private-key content and key passphrases must never survive parsing into the
/// preview model. Parsers may inspect those fields in `Zeroizing` temporaries
/// only to derive this metadata before the temporary is dropped.
#[derive(Debug, Clone, PartialEq)]
pub enum ImportedAuth {
    Password {
        has_secret: bool,
    },
    PrivateKey {
        path: Option<String>,
        has_secret: bool,
    },
    None,
}

/// One imported session in the common shape shared by all parsers.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedSession {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group_path: Vec<String>,
    pub description: String,
    pub auth: ImportedAuth,
    /// Optional preview note code ([`SECRET_NOTE_ENCRYPTED`] /
    /// [`SECRET_NOTE_NOT_CARRIED`]) explaining missing credential material.
    pub secret_note: String,
}

impl ImportedSession {
    fn new(name: String, host: String, port: u16, username: String) -> ImportedSession {
        ImportedSession {
            name,
            host,
            port,
            username,
            group_path: Vec::new(),
            description: String::new(),
            auth: ImportedAuth::None,
            secret_note: String::new(),
        }
    }
}

/// Kind label shared by preview responses and stored entries.
pub fn auth_kind(auth: &ImportedAuth) -> &'static str {
    match auth {
        ImportedAuth::Password { .. } => "password",
        ImportedAuth::PrivateKey { .. } => "private-key",
        ImportedAuth::None => "none",
    }
}

/// True when the auth carries decryptable secret material (a key *path*
/// alone is not a secret).
fn has_secret(auth: &ImportedAuth) -> bool {
    match auth {
        ImportedAuth::Password { has_secret } | ImportedAuth::PrivateKey { has_secret, .. } => {
            *has_secret
        }
        ImportedAuth::None => false,
    }
}

/// Bounded accumulator shared by every parser. It checks before `Vec::push`,
/// so hostile exports cannot construct an unbounded session preview only to be
/// truncated later by `finish`.
fn push_preview_session(
    sessions: &mut Vec<ImportedSession>,
    session: ImportedSession,
) -> Result<(), String> {
    if sessions.len() >= MAX_PREVIEW_SESSIONS {
        return Err(format!(
            "Import exceeds the {MAX_PREVIEW_SESSIONS} session limit"
        ));
    }
    sessions.push(session);
    Ok(())
}

// ---------------------------------------------------------------------------
// MobaXterm (.mxtsessions)
// ---------------------------------------------------------------------------

/// Parses a MobaXterm `.mxtsessions` INI. Only `Bookmarks*` sections carry
/// sessions; `SubRep` holds the folder path (`\`-separated) applied to every
/// session in its section. SSH connection strings are the entries whose
/// type field starts with `109` (`#109#<subtype>%host%port%user%...`).
pub fn parse_moba_ini(text: &str) -> Result<Vec<ImportedSession>, String> {
    let mut sessions = Vec::new();
    for section in parse_ini_sections(text) {
        if !section.name.starts_with("Bookmarks") {
            continue;
        }
        // SubRep may appear anywhere in the section; resolve it first so
        // group assignment does not depend on key order.
        let group_path = section
            .entries
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("SubRep"))
            .map(|(_, value)| moba_group_path(value))
            .unwrap_or_default();
        for (key, value) in &section.entries {
            if key.is_empty() || key.eq_ignore_ascii_case("SubRep") {
                continue;
            }
            if let Some(mut session) = parse_moba_session_value(key, value) {
                session.group_path = group_path.clone();
                push_preview_session(&mut sessions, session)?;
            }
        }
    }
    Ok(sessions)
}

/// Splits one `#<type>#<subtype>%host%port%username%...` value. Returns
/// `None` for non-SSH types and for entries without a usable host.
fn parse_moba_session_value(name: &str, value: &str) -> Option<ImportedSession> {
    let fields: Vec<&str> = value.split('%').collect();
    let type_field = fields.first()?.trim();
    // "#109#0" -> the segment between the leading '#' markers is the type.
    let type_str = type_field.trim_start_matches('#').split('#').next()?;
    if !type_str.starts_with("109") {
        return None;
    }
    let host = fields
        .get(1)
        .map(|host| host.trim())
        .filter(|host| !host.is_empty())?;
    let port = fields
        .get(2)
        .and_then(|port| port.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(22);
    let username = fields
        .get(3)
        .map(|username| username.trim())
        .filter(|username| !username.is_empty())
        .unwrap_or("root");
    Some(ImportedSession::new(
        name.to_string(),
        host.to_string(),
        port,
        username.to_string(),
    ))
}

fn moba_group_path(sub_rep: &str) -> Vec<String> {
    sub_rep
        .split('\\')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

// ---------------------------------------------------------------------------
// Shared INI scanning (MobaXterm + Xshell .xsh)
// ---------------------------------------------------------------------------

struct IniSection {
    name: String,
    entries: Vec<(String, String)>,
}

/// Minimal line-oriented INI scan: `;`/`#` comment lines, `[section]`
/// headers, `key=value` pairs (first `=` splits). Never panics on odd bytes;
/// a malformed line is skipped.
fn parse_ini_sections(text: &str) -> Vec<IniSection> {
    let mut sections: Vec<IniSection> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with([';', '#']) {
            continue;
        }
        if trimmed.starts_with('[') {
            if let Some(end) = trimmed.find(']') {
                if let Some(name) = trimmed.get(1..end) {
                    sections.push(IniSection {
                        name: name.trim().to_string(),
                        entries: Vec::new(),
                    });
                }
            }
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let (key, value) = (trimmed.get(..eq), trimmed.get(eq + 1..));
            if let (Some(key), Some(value)) = (key, value) {
                if let Some(section) = sections.last_mut() {
                    section
                        .entries
                        .push((key.trim().to_string(), value.trim().to_string()));
                }
            }
        }
    }
    sections
}

fn find_section<'a>(sections: &'a [IniSection], name: &str) -> Option<&'a IniSection> {
    sections
        .iter()
        .find(|section| section.name.eq_ignore_ascii_case(name))
}

fn section_value<'a>(section: &'a IniSection, key: &str) -> Option<&'a str> {
    section
        .entries
        .iter()
        .rev()
        .find(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------------------
// Xshell (.xts ZIP of .xsh INI files)
// ---------------------------------------------------------------------------

/// Parses an Xshell `.xts` archive: every `.xsh` entry is one session. Entry
/// names on Chinese Windows installs are GBK-encoded, so raw bytes are
/// decoded as UTF-8 first (modern exports) with a GBK fallback. Only SSH
/// sessions are kept; archive expansion is bounded by [`MAX_ZIP_ENTRIES`],
/// [`MAX_ENTRY_BYTES`], and [`MAX_TOTAL_BYTES`].
pub fn parse_xshell(zip_bytes: &[u8]) -> Result<Vec<ImportedSession>, String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("Failed to read Xshell archive: {error}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!(
            "Xshell archive has more than {MAX_ZIP_ENTRIES} entries"
        ));
    }
    let mut sessions = Vec::new();
    let mut total_bytes: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read Xshell archive entry {index}: {error}"))?;
        if entry.is_dir() {
            continue;
        }
        let declared = entry.size();
        if declared > MAX_ENTRY_BYTES {
            return Err(format!(
                "Xshell archive entry expands beyond the {} MB per-entry limit",
                MAX_ENTRY_BYTES / (1024 * 1024)
            ));
        }
        total_bytes += declared;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(format!(
                "Xshell archive expands beyond the {} MB total limit",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        // Header-declared size is honored by the reader too, but a hostile
        // archive can lie: cap the actual read as well.
        let name = decode_zip_name(entry.name_raw());
        if !name.to_ascii_lowercase().ends_with(".xsh") {
            continue;
        }
        let mut limited = entry.take(MAX_ENTRY_BYTES + 1);
        let mut content = Vec::new();
        limited
            .read_to_end(&mut content)
            .map_err(|error| format!("Failed to read Xshell entry '{name}': {error}"))?;
        if content.len() as u64 > MAX_ENTRY_BYTES {
            return Err(format!(
                "Xshell archive entry '{name}' exceeds the per-entry size limit"
            ));
        }
        let text = String::from_utf8_lossy(&content);
        if let Some(session) = parse_xsh_file(&name, &text) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

/// UTF-8 first (ASCII is identical under GBK), GBK fallback for Chinese
/// Windows exports, lossy as the last resort. Never fails.
fn decode_zip_name(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(name) => name.to_string(),
        Err(_) => {
            // No BOM handling: entry names never carry BOMs, and BOM
            // sniffing would silently swallow a leading 0xFF 0xFE.
            let (decoded, had_errors) = encoding_rs::GBK.decode_without_bom_handling(raw);
            if had_errors {
                String::from_utf8_lossy(raw).into_owned()
            } else {
                decoded.into_owned()
            }
        }
    }
}

/// Parses one `.xsh` INI file. Returns `None` when the entry is not an SSH
/// session (protocol or host missing) — a bad entry never fails the import.
fn parse_xsh_file(entry_name: &str, text: &str) -> Option<ImportedSession> {
    let sections = parse_ini_sections(text);
    let connection = find_section(&sections, "CONNECTION")?;
    let protocol = section_value(connection, "Protocol")?;
    if !protocol.eq_ignore_ascii_case("SSH") {
        return None;
    }
    let host = section_value(connection, "Host")?;
    let port = section_value(connection, "Port")
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(22);
    let username = find_section(&sections, "CONNECTION:AUTHENTICATION")
        .and_then(|auth| section_value(auth, "UserName"))
        .unwrap_or("root")
        .to_string();
    let auth = find_section(&sections, "CONNECTION:AUTHENTICATION")
        .and_then(|auth| section_value(auth, "UserKey"))
        .map(|key| ImportedAuth::PrivateKey {
            path: Some(key.to_string()),
            has_secret: false,
        })
        .unwrap_or(ImportedAuth::None);
    let mut session = ImportedSession::new(
        xsh_session_name(entry_name),
        host.to_string(),
        port,
        username,
    );
    session.auth = auth;
    session.group_path = xsh_group_path(entry_name);
    Some(session)
}

/// Session display name: the `.xsh` entry's file stem.
fn xsh_session_name(entry_name: &str) -> String {
    let path = entry_name.replace('\\', "/");
    let file = path.rsplit('/').next().unwrap_or(&path);
    strip_xsh_suffix(file).to_string()
}

fn strip_xsh_suffix(name: &str) -> &str {
    match name.get(name.len().saturating_sub(4)..) {
        Some(suffix) if suffix.eq_ignore_ascii_case(".xsh") => {
            // The suffix is ASCII, so the byte boundary is a char boundary.
            &name[..name.len() - 4]
        }
        _ => name,
    }
}

/// Group path from the ZIP directory layout: `Xshell/Sessions/Prod/web.xsh`
/// → `["Prod"]`; root-level entries have no group. The last path component
/// is always the file name and is dropped.
fn xsh_group_path(entry_name: &str) -> Vec<String> {
    let path = entry_name.replace('\\', "/");
    let lowered = path.to_ascii_lowercase();
    let prefix_end = if let Some(index) = lowered.find("xshell/sessions/") {
        index + "xshell/sessions/".len()
    } else if let Some(index) = lowered.find("xshell/") {
        index + "xshell/".len()
    } else {
        0
    };
    let relative = path.get(prefix_end..).unwrap_or(&path);
    let components: Vec<String> = relative
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    components
        .split_last()
        .map(|(_, directories)| directories.to_vec())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// WindTerm (.sessions + user.config)
// ---------------------------------------------------------------------------

/// Resolved bits of `user.config` needed for credential decryption.
#[derive(Debug, Default)]
struct WindTermConfig {
    /// Raw salt bytes (`application.fingerprint`), hex-decoded when possible.
    fingerprint: Option<Vec<u8>>,
    /// `application.masterPassword` switch.
    master_password_enabled: bool,
}

impl WindTermConfig {
    fn from_user_config(user_config: Option<&[u8]>) -> WindTermConfig {
        let Some(bytes) = user_config else {
            return WindTermConfig::default();
        };
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return WindTermConfig::default();
        };
        let application = value.get("application");
        WindTermConfig {
            fingerprint: application
                .and_then(|app| app.get("fingerprint"))
                .and_then(Value::as_str)
                .map(fingerprint_bytes),
            master_password_enabled: application
                .and_then(|app| app.get("masterPassword"))
                .map(config_flag_is_on)
                .unwrap_or(false),
        }
    }
}

/// Lenient truthiness for `user.config` flags (bool true, "true", 1).
fn config_flag_is_on(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::String(flag) => flag.trim().eq_ignore_ascii_case("true"),
        Value::Number(flag) => flag.as_u64() == Some(1),
        _ => false,
    }
}

/// Salt bytes: hex-decode the fingerprint when it looks like hex (WindTerm
/// stores a hex string), otherwise use the raw string bytes.
fn fingerprint_bytes(value: &str) -> Vec<u8> {
    let cleaned = value.trim().trim_start_matches("0x");
    if let Ok(bytes) = data_encoding::HEXUPPER_PERMISSIVE.decode(cleaned.as_bytes()) {
        return bytes;
    }
    value.trim().as_bytes().to_vec()
}

/// PBKDF2-HMAC-SHA3-512 → 48 bytes split into an AES-256 key and a CBC IV.
fn derive_windterm_key(master_password: &str, salt: &[u8]) -> ([u8; 32], [u8; 16]) {
    let mut derived = [0u8; WINDTERM_DERIVED_BYTES];
    pbkdf2::pbkdf2_hmac::<sha3::Sha3_512>(
        master_password.as_bytes(),
        salt,
        WINDTERM_PBKDF2_ROUNDS,
        &mut derived,
    );
    let mut key = [0u8; 32];
    let mut iv = [0u8; 16];
    key.copy_from_slice(&derived[..32]);
    iv.copy_from_slice(&derived[32..]);
    (key, iv)
}

/// AES-256-CBC/PKCS7 decryption; `None` on any failure (wrong password,
/// tampered blob, bad padding) — callers skip the credentials.
fn windterm_decrypt(key: &[u8], iv: &[u8], ciphertext: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    use aes::cipher::block_padding::Pkcs7;
    use aes::cipher::{BlockModeDecrypt, KeyIvInit};
    type Aes256CbcDecryptor = cbc::Decryptor<aes::Aes256>;
    Aes256CbcDecryptor::new_from_slices(key, iv)
        .ok()?
        .decrypt_padded_vec::<Pkcs7>(ciphertext)
        .ok()
        .map(Zeroizing::new)
}

/// Parses a WindTerm `.sessions` JSON array. `user_config` supplies the
/// fingerprint salt and the master-password switch; when the switch is on
/// the caller must supply `master_password` (else the dedicated error is
/// returned). Items that are not SSH sessions are skipped; per-item
/// credential failures degrade to `ImportedAuth::None` (warn semantics).
pub fn parse_windterm(
    sessions_json: &[u8],
    user_config: Option<&[u8]>,
    master_password: Option<&str>,
) -> Result<Vec<ImportedSession>, String> {
    let items: Vec<Value> = serde_json::from_slice(sessions_json)
        .map_err(|error| format!("WindTerm sessions file is not a JSON array: {error}"))?;
    let config = WindTermConfig::from_user_config(user_config);
    if config.master_password_enabled && master_password.is_none() {
        return Err(WINDTERM_MASTER_PASSWORD_REQUIRED.to_string());
    }
    let mut sessions = Vec::new();
    for item in &items {
        if let Some(session) = parse_windterm_item(item, &config, master_password) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

fn parse_windterm_item(
    item: &Value,
    config: &WindTermConfig,
    master_password: Option<&str>,
) -> Option<ImportedSession> {
    let session = item.get("session")?;
    let protocol = session
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !protocol.eq_ignore_ascii_case("SSH") {
        return None;
    }
    let target = session
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (user, host) = split_windterm_target(target);
    if host.is_empty() {
        return None;
    }
    let label = session
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(&host);
    let port = windterm_port(session.get("port"));
    let mut imported = ImportedSession::new(
        label.to_string(),
        host,
        port,
        if user.is_empty() {
            "root".to_string()
        } else {
            user
        },
    );
    imported.group_path = session
        .get("group")
        .and_then(Value::as_str)
        .map(|group| {
            group
                .split('>')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    imported.description = session
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    imported.auth = windterm_credentials(session.get("autoLogin"), config, master_password);
    Some(imported)
}

/// `user@host` split on the last `@` (user names may contain `@`); no `@`
/// means the default user applies.
fn split_windterm_target(target: &str) -> (String, String) {
    match target.trim().rsplit_once('@') {
        Some((user, host)) => (user.trim().to_string(), host.trim().to_string()),
        None => (String::new(), target.trim().to_string()),
    }
}

/// Port as number or numeric string; falls back to 22.
fn windterm_port(value: Option<&Value>) -> u16 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(22)
}

/// Credential chain for `session.autoLogin`:
/// 1. plaintext JSON (no master password in use),
/// 2. base64 → AES-256-CBC (PBKDF2 key from master password + fingerprint),
/// 3. anything else → no credentials for this item.
fn windterm_credentials(
    raw: Option<&Value>,
    config: &WindTermConfig,
    master_password: Option<&str>,
) -> ImportedAuth {
    let Some(raw) = raw
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ImportedAuth::None;
    };
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return auto_login_auth(&value);
    }
    let Ok(ciphertext) = BASE64.decode(raw) else {
        return ImportedAuth::None;
    };
    let Some(master_password) = master_password else {
        return ImportedAuth::None;
    };
    let Some(salt) = config.fingerprint.as_deref() else {
        return ImportedAuth::None;
    };
    let (key, iv) = derive_windterm_key(master_password, salt);
    let Some(plaintext) = windterm_decrypt(&key, &iv, &ciphertext) else {
        return ImportedAuth::None;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&plaintext) else {
        return ImportedAuth::None;
    };
    auto_login_auth(&value)
}

/// Reads the decrypted (or plaintext) autoLogin JSON: `PasswordEnabled` +
/// `Password` wins, then `Public Key.<platform>.path/pass`, else none. No
/// credential string is copied into `ImportedAuth`.
fn auto_login_auth(value: &Value) -> ImportedAuth {
    let password_enabled = match value.get("PasswordEnabled") {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(flag)) => flag.trim().eq_ignore_ascii_case("true"),
        _ => false,
    };
    let password = value
        .get("Password")
        .and_then(Value::as_str)
        .filter(|password| !password.is_empty());
    if password_enabled && password.is_some() {
        return ImportedAuth::Password { has_secret: true };
    }
    let public_key = value.get("Public Key").or_else(|| value.get("PublicKey"));
    let key_entry = public_key.and_then(|public_key| {
        ["windows", "linux", "mac"]
            .iter()
            .find_map(|platform| public_key.get(*platform))
    });
    let key_path = key_entry
        .and_then(|entry| entry.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let key_passphrase = key_entry
        .and_then(|entry| entry.get("pass"))
        .and_then(Value::as_str)
        .filter(|pass| !pass.is_empty());
    if key_path.is_some() || key_passphrase.is_some() {
        return ImportedAuth::PrivateKey {
            path: key_path.map(expand_home_prefix),
            has_secret: key_passphrase.is_some(),
        };
    }
    ImportedAuth::None
}

/// Expands the `$(HomeDir)` / `~/` path prefixes against the local home
/// directory; relative paths stay as-is (they are relative to the sessions
/// file, which is only ever kept as a string here).
fn expand_home_prefix(path: &str) -> String {
    for token in ["$(HomeDir)", "~"] {
        if let Some(rest) = path.strip_prefix(token) {
            let rest = rest.trim_start_matches(['/', '\\']);
            if let Some(home) = home_dir() {
                return if rest.is_empty() {
                    home
                } else {
                    format!("{home}/{rest}")
                };
            }
        }
    }
    path.to_string()
}

fn home_dir() -> Option<String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|value| value.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// SecureCRT (XML session export)
// ---------------------------------------------------------------------------

/// One `<key name="...">` frame with its collected `<string>/<dword>` leaves
/// and the names of the enclosing frames (outermost first).
struct SecureCrtFrame {
    name: String,
    fields: Vec<(String, String)>,
    ancestors: Vec<String>,
}

/// Parses a SecureCRT XML session export (`Tools → Export Session Settings`).
/// Sessions are the `<key>` frames nested below the `Sessions` root whose
/// `Protocol Name` is SSH2; folders between `Sessions` and the session frame
/// become the group path.
///
/// SecureCRT only ever writes encrypted password blobs to the export, so —
/// like the NyaTerm importer — nothing is decrypted here: every session keeps
/// `ImportedAuth::Password { has_secret: false }` plus the [`SECRET_NOTE_ENCRYPTED`]
/// preview note.
///
/// The XML subset is scanned by hand (no XML crate dependency): the
/// declaration, comments, CDATA, self-closing tags, the five named entities
/// and numeric character references are handled; anything else fails closed
/// with a readable error.
pub fn parse_securecrt(text: &str) -> Result<Vec<ImportedSession>, String> {
    let frames = scan_securecrt_xml(text)?;
    let mut sessions = Vec::new();
    for frame in &frames {
        if let Some(session) = securecrt_session_from_frame(frame) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

fn scan_securecrt_xml(text: &str) -> Result<Vec<SecureCrtFrame>, String> {
    const ERR_PREFIX: &str = "Invalid SecureCRT XML";
    /// Nesting ceiling for `<key>` frames. Real exports nest
    /// VanDyke > Sessions > folders > session (a handful of levels); a hostile
    /// input nesting thousands deep would clone the whole ancestor stack per
    /// closing tag (O(N²) CPU amplification), so deeper frames fail closed.
    const MAX_KEY_DEPTH: usize = 32;
    let raw = text.as_bytes();
    let mut frames: Vec<SecureCrtFrame> = Vec::new();
    // Stack of open `<key>` frames: (name, collected fields).
    let mut stack: Vec<(String, Vec<(String, String)>)> = Vec::new();
    // Open value element: (tag name, field name, collected raw bytes).
    let mut field: Option<(&'static str, String, Vec<u8>)> = None;
    let mut index = 0usize;
    while index < raw.len() {
        if raw[index] != b'<' {
            if let Some((_, _, value)) = field.as_mut() {
                value.push(raw[index]);
            }
            index += 1;
            continue;
        }
        let rest = &raw[index..];
        if rest.starts_with(b"<!--") {
            let Some(end) = find_subslice(rest, b"-->") else {
                return Err(format!("{ERR_PREFIX}: unterminated comment"));
            };
            index += end + 3;
            continue;
        }
        if rest.starts_with(b"<![CDATA[") {
            let Some(end) = find_subslice(rest, b"]]>") else {
                return Err(format!("{ERR_PREFIX}: unterminated CDATA section"));
            };
            // CDATA outside a value element is unusual for SecureCRT exports
            // but harmless — ignore it.
            if let Some((_, _, value)) = field.as_mut() {
                value.extend_from_slice(&rest[9..end]);
            }
            index += end + 3;
            continue;
        }
        if rest.starts_with(b"<?") || rest.starts_with(b"<!") {
            let Some(end) = find_subslice(rest, b">") else {
                return Err(format!("{ERR_PREFIX}: unterminated declaration"));
            };
            index += end + 1;
            continue;
        }
        if rest.starts_with(b"</") {
            let Some(end) = find_subslice(rest, b">") else {
                return Err(format!("{ERR_PREFIX}: unterminated closing tag"));
            };
            let name = std::str::from_utf8(&rest[2..end])
                .map_err(|_| format!("{ERR_PREFIX}: closing tag is not UTF-8"))?
                .trim();
            index += end + 1;
            if let Some((tag, field_name, value)) = field.take() {
                if tag != name {
                    return Err(format!("{ERR_PREFIX}: </{name}> closes <{tag}>"));
                }
                let text = decode_xml_entities(String::from_utf8_lossy(&value).trim())?;
                if let Some(frame) = stack.last_mut() {
                    frame.1.push((field_name, text));
                }
                continue;
            }
            if name == "key" {
                let Some((frame_name, fields)) = stack.pop() else {
                    return Err(format!("{ERR_PREFIX}: unbalanced </key>"));
                };
                let ancestors = stack.iter().map(|(name, _)| name.clone()).collect();
                if frames.len() >= MAX_PREVIEW_SESSIONS {
                    return Err(format!(
                        "Import exceeds the {MAX_PREVIEW_SESSIONS} session limit"
                    ));
                }
                frames.push(SecureCrtFrame {
                    name: frame_name,
                    fields,
                    ancestors,
                });
            }
            continue;
        }
        // Opening tag: find the closing '>' honoring quoted attributes.
        let Some(end) = find_tag_end(rest) else {
            return Err(format!("{ERR_PREFIX}: unterminated tag"));
        };
        let tag_text = std::str::from_utf8(&rest[1..end])
            .map_err(|_| format!("{ERR_PREFIX}: tag is not UTF-8"))?;
        index += end + 1;
        let self_closing = tag_text.ends_with('/');
        let (tag_name, attrs) = parse_xml_tag(tag_text.trim_end_matches('/'))?;
        if field.is_some() {
            return Err(format!(
                "{ERR_PREFIX}: unexpected <{tag_name}> inside a value"
            ));
        }
        match (tag_name, self_closing) {
            ("key", false) => {
                if stack.len() >= MAX_KEY_DEPTH {
                    return Err(format!(
                        "{ERR_PREFIX}: <key> nesting exceeds the {MAX_KEY_DEPTH} level limit"
                    ));
                }
                let name = xml_attr(&attrs, "name").unwrap_or_default().to_string();
                stack.push((name, Vec::new()));
            }
            ("key", true) => {}
            ("string" | "dword", _) => {
                let Some(name) = xml_attr(&attrs, "name").map(str::to_owned) else {
                    return Err(format!(
                        "{ERR_PREFIX}: <{tag_name}> value without a name attribute"
                    ));
                };
                if self_closing {
                    if let Some(frame) = stack.last_mut() {
                        frame.1.push((name, String::new()));
                    }
                } else {
                    // Tag names are matched against this static str when the
                    // closing tag arrives, so keep them in that domain.
                    let tag: &'static str = if tag_name == "string" {
                        "string"
                    } else {
                        "dword"
                    };
                    field = Some((tag, name, Vec::new()));
                }
            }
            // The `VanDyke` root element and unknown elements are ignored.
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(format!("{ERR_PREFIX}: unclosed <key> frame"));
    }
    Ok(frames)
}

/// First index of `needle` in `haystack`, searching from `from`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&index| &haystack[index..index + needle.len()] == needle)
}

/// Index of the `>` that terminates a tag, honoring quoted attribute values.
fn find_tag_end(rest: &[u8]) -> Option<usize> {
    let mut quote = 0u8;
    for (offset, byte) in rest.iter().copied().enumerate() {
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' => quote = byte,
            b'>' => return Some(offset),
            _ => {}
        }
    }
    None
}

/// Attributes of one XML tag, decoded.
type XmlAttrs = Vec<(String, String)>;

/// Splits `name attr="v" attr2='v2'` into the tag name and its attributes.
/// Attribute values must be quoted — SecureCRT always quotes them, and a
/// malformed export should fail closed rather than mis-parse.
fn parse_xml_tag(tag_text: &str) -> Result<(&str, XmlAttrs), String> {
    let trimmed = tag_text.trim();
    let Some(name_end) = trimmed.find(|byte: char| byte.is_whitespace()) else {
        return Ok((trimmed, Vec::new()));
    };
    let name = &trimmed[..name_end];
    let mut attrs = Vec::new();
    let mut rest = trimmed[name_end..].trim_start();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else {
            return Err(format!(
                "Invalid SecureCRT XML: attribute without a value in <{name}>"
            ));
        };
        let attr_name = rest[..eq].trim().to_string();
        let after_eq = rest[eq + 1..].trim_start();
        let quote = after_eq.as_bytes().first().copied().unwrap_or(0);
        if quote != b'"' && quote != b'\'' {
            return Err(format!(
                "Invalid SecureCRT XML: unquoted attribute value in <{name}>"
            ));
        }
        let value_part = &after_eq[1..];
        let Some(close) = value_part.find(quote as char) else {
            return Err(format!(
                "Invalid SecureCRT XML: unterminated attribute in <{name}>"
            ));
        };
        attrs.push((attr_name, decode_xml_entities(&value_part[..close])?));
        rest = value_part[close + 1..].trim_start();
    }
    Ok((name, attrs))
}

fn xml_attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The five named entities plus decimal/hex numeric character references.
/// Unknown or unterminated entities fail closed — SecureCRT never emits them
/// and silently keeping the raw bytes would corrupt host names.
fn decode_xml_entities(text: &str) -> Result<String, String> {
    if !text.contains('&') {
        return Ok(text.to_string());
    }
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(position) = rest.find('&') {
        decoded.push_str(&rest[..position]);
        let after = &rest[position + 1..];
        let Some(semicolon) = after.find(';') else {
            return Err("Invalid SecureCRT XML: unterminated entity".to_string());
        };
        let entity = &after[..semicolon];
        let replacement = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity.strip_prefix('#').and_then(parse_xml_char_ref),
        };
        let Some(replacement) = replacement else {
            return Err(format!("Invalid SecureCRT XML: unknown entity &{entity};"));
        };
        decoded.push(replacement);
        rest = &after[semicolon + 1..];
    }
    decoded.push_str(rest);
    Ok(decoded)
}

/// `#22` / `#x16` → char; rejects surrogates and out-of-range code points.
fn parse_xml_char_ref(body: &str) -> Option<char> {
    let value = if let Some(hex) = body.strip_prefix('x').or_else(|| body.strip_prefix('X')) {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        body.parse::<u32>().ok()?
    };
    char::from_u32(value)
}

/// Builds an imported session from one `<key>` frame. Returns `None` for
/// frames outside the `Sessions` tree, non-SSH2 protocols and sessions
/// without a usable host (bad entries degrade to skipped, like Xshell).
fn securecrt_session_from_frame(frame: &SecureCrtFrame) -> Option<ImportedSession> {
    let sessions_index = frame.ancestors.iter().position(|name| name == "Sessions")?;
    let field = |name: &str| {
        frame
            .fields
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let protocol = field("Protocol Name").unwrap_or_default();
    if !protocol.eq_ignore_ascii_case("SSH2") {
        return None;
    }
    let host = field("Hostname")
        .map(str::trim)
        .filter(|host| !host.is_empty())?;
    // SSH2 sessions store the port under "[SSH2] Port" (plain "Port" for the
    // rest); both spellings are accepted. SecureCRT writes dwords as
    // zero-padded 8-digit lowercase hex (`00000016` = 22), so hex wins when
    // the shape matches, with a decimal fallback for hand-written exports
    // (the NyaTerm importer parses decimals only, which misreads real
    // exports).
    let port = field("[SSH2] Port")
        .or_else(|| field("Port"))
        .and_then(parse_securecrt_dword)
        .unwrap_or(22);
    let username = field("Username")
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .unwrap_or("root");
    let group_path: Vec<String> = frame.ancestors[sessions_index + 1..]
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    let mut session = ImportedSession::new(
        if frame.name.trim().is_empty() {
            host.to_string()
        } else {
            frame.name.clone()
        },
        host.to_string(),
        port,
        username.to_string(),
    );
    session.group_path = group_path;
    session.auth = ImportedAuth::Password { has_secret: false };
    session.secret_note = SECRET_NOTE_ENCRYPTED.to_string();
    Some(session)
}

/// SecureCRT dword values: zero-padded 8-digit lowercase hex first
/// (`00000016` = 22), decimal fallback otherwise. `None` for junk — the
/// caller falls back to port 22.
fn parse_securecrt_dword(value: &str) -> Option<u16> {
    let trimmed = value.trim();
    if trimmed.len() == 8 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        if let Ok(port) = u16::from_str_radix(trimmed, 16) {
            return (port > 0).then_some(port);
        }
    }
    trimmed.parse::<u16>().ok().filter(|port| *port > 0)
}

// ---------------------------------------------------------------------------
// FinalShell (conn directory packed as a ZIP, or a bare connection JSON)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct FinalShellFolder {
    id: String,
    name: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    delete_time: u64,
}

#[derive(Debug, Deserialize)]
struct FinalShellConnection {
    #[serde(default)]
    name: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u64>,
    #[serde(default)]
    user_name: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    /// 100 is the SSH connection type; other types are skipped.
    #[serde(default)]
    conection_type: Option<i32>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    delete_time: u64,
}

/// Parses a FinalShell conn directory packed as a ZIP: `folder.json` files
/// build the group tree, `*_connect_config.json` files are the connections.
/// A bare JSON object (or array of objects) is accepted as a fallback for
/// single-file exports. Field semantics mirror the NyaTerm importer: only
/// SSH connections (`conection_type == 100`) that were not deleted survive.
///
/// FinalShell stores passwords with its own DES scheme; like NyaTerm, the
/// ciphertext is not carried over — sessions keep password semantics with no
/// material plus the [`SECRET_NOTE_ENCRYPTED`] preview note. Archive
/// expansion is bounded by the same caps as Xshell ([`MAX_ZIP_ENTRIES`],
/// [`MAX_ENTRY_BYTES`], [`MAX_TOTAL_BYTES`]).
pub fn parse_finalshell(zip_bytes: &[u8]) -> Result<Vec<ImportedSession>, String> {
    let (folders, connections) = read_finalshell_entries(zip_bytes)?;
    if connections.is_empty() {
        return Err(
            "FinalShell source does not contain any *_connect_config.json entries".to_string(),
        );
    }
    let mut sessions = Vec::new();
    for connection in connections {
        if let Some(session) = finalshell_session(connection, &folders) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

fn read_finalshell_entries(
    zip_bytes: &[u8],
) -> Result<(HashMap<String, FinalShellFolder>, Vec<FinalShellConnection>), String> {
    if let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)) {
        if archive.len() > MAX_ZIP_ENTRIES {
            return Err(format!(
                "FinalShell archive has more than {MAX_ZIP_ENTRIES} entries"
            ));
        }
        let mut folders: HashMap<String, FinalShellFolder> = HashMap::new();
        let mut connections = Vec::new();
        let mut total_bytes: u64 = 0;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                format!("Failed to read FinalShell archive entry {index}: {error}")
            })?;
            if entry.is_dir() {
                continue;
            }
            let declared = entry.size();
            if declared > MAX_ENTRY_BYTES {
                return Err(format!(
                    "FinalShell archive entry expands beyond the {} MB per-entry limit",
                    MAX_ENTRY_BYTES / (1024 * 1024)
                ));
            }
            total_bytes += declared;
            if total_bytes > MAX_TOTAL_BYTES {
                return Err(format!(
                    "FinalShell archive expands beyond the {} MB total limit",
                    MAX_TOTAL_BYTES / (1024 * 1024)
                ));
            }
            let name = decode_zip_name(entry.name_raw());
            let file_name = name.rsplit('/').next().unwrap_or(&name).to_string();
            if file_name != "folder.json" && !file_name.ends_with("_connect_config.json") {
                continue;
            }
            let mut limited = entry.take(MAX_ENTRY_BYTES + 1);
            let mut content = Vec::new();
            limited
                .read_to_end(&mut content)
                .map_err(|error| format!("Failed to read FinalShell entry '{name}': {error}"))?;
            if content.len() as u64 > MAX_ENTRY_BYTES {
                return Err(format!(
                    "FinalShell archive entry '{name}' exceeds the per-entry size limit"
                ));
            }
            if file_name == "folder.json" {
                // A malformed or deleted folder entry degrades to "no group",
                // a malformed connection entry to "skipped" — neither fails
                // the import.
                if let Ok(folder) = serde_json::from_slice::<FinalShellFolder>(&content) {
                    if folder.delete_time == 0 {
                        folders.insert(folder.id.clone(), folder);
                    }
                }
            } else if let Ok(connection) = serde_json::from_slice::<FinalShellConnection>(&content)
            {
                if connections.len() >= MAX_PREVIEW_SESSIONS {
                    return Err(format!(
                        "Import exceeds the {MAX_PREVIEW_SESSIONS} session limit"
                    ));
                }
                connections.push(connection);
            }
        }
        return Ok((folders, connections));
    }
    // Not a ZIP: accept a bare connection JSON (one object or an array).
    let value: Value = serde_json::from_slice(zip_bytes).map_err(|error| {
        format!("FinalShell source is neither a ZIP archive nor valid JSON: {error}")
    })?;
    let items = match value {
        item @ Value::Object(_) => vec![item],
        Value::Array(items) => items,
        _ => {
            return Err(
                "FinalShell JSON must be a connection object or an array of objects".to_string(),
            )
        }
    };
    let mut connections = Vec::new();
    for item in items {
        if let Ok(connection) = serde_json::from_value::<FinalShellConnection>(item) {
            if connections.len() >= MAX_PREVIEW_SESSIONS {
                return Err(format!(
                    "Import exceeds the {MAX_PREVIEW_SESSIONS} session limit"
                ));
            }
            connections.push(connection);
        }
    }
    Ok((HashMap::new(), connections))
}

fn finalshell_session(
    connection: FinalShellConnection,
    folders: &HashMap<String, FinalShellFolder>,
) -> Option<ImportedSession> {
    if connection.delete_time != 0 || connection.conection_type != Some(100) {
        return None;
    }
    let host = connection.host.trim();
    if host.is_empty() {
        return None;
    }
    let port = connection
        .port
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(22);
    let username = connection
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .unwrap_or("root");
    let name = if connection.name.trim().is_empty() {
        host.to_string()
    } else {
        connection.name
    };
    let mut session = ImportedSession::new(name, host.to_string(), port, username.to_string());
    session.group_path = finalshell_group_path(connection.parent_id.as_deref(), folders);
    session.description = normalize_import_text(connection.description.as_deref());
    session.auth = ImportedAuth::Password { has_secret: false };
    session.secret_note = SECRET_NOTE_ENCRYPTED.to_string();
    Some(session)
}

/// Walks the `parent_id` folder chain bottom-up; `root` / `0` / empty ids end
/// the chain, and the loop bound prevents cycles from spinning forever.
fn finalshell_group_path(
    parent_id: Option<&str>,
    folders: &HashMap<String, FinalShellFolder>,
) -> Vec<String> {
    let Some(mut current) = parent_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    if current == "root" || current == "0" {
        return Vec::new();
    }
    let mut path = Vec::new();
    for _ in 0..folders.len() {
        let Some(folder) = folders.get(current) else {
            break;
        };
        let name = folder.name.trim();
        if !name.is_empty() {
            path.push(name.to_string());
        }
        match folder.parent_id.as_deref().map(str::trim) {
            Some(next) if !next.is_empty() && next != "root" && next != "0" => current = next,
            _ => break,
        }
    }
    path.reverse();
    path
}

/// Trimmed description, empty when absent.
fn normalize_import_text(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// Lenient field readers for the JSON formats (Electerm, Termius, FinalShell
/// bare fallback): absent fields and wrong types degrade to `None` / empty
/// instead of failing the whole import.
fn json_text<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn json_u64(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    match object.get(key) {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(text)) => text.trim().parse().ok(),
        _ => None,
    }
}

fn json_text_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `{"id": "x"}` reference object or a bare string id.
fn json_id_ref<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    match object.get(key) {
        Some(Value::Object(inner)) => inner.get("id").and_then(Value::as_str),
        Some(Value::String(text)) if !text.is_empty() => Some(text.as_str()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Electerm (bookmarks JSON)
// ---------------------------------------------------------------------------

struct ElectermGroup {
    id: String,
    title: String,
    bookmark_ids: Vec<String>,
    group_ids: Vec<String>,
}

/// Parses an Electerm bookmarks export: either a bare JSON array of bookmark
/// objects (no group information available) or the `{bookmarks,
/// bookmarkGroups}` object Electerm stores. Field semantics mirror the
/// NyaTerm importer: only `type == "ssh"` bookmarks with `enable_ssh` unset
/// or true survive; an out-of-range port skips the bookmark. Electerm keeps
/// credentials out of the bookmarks file, so password-auth bookmarks carry no
/// material and get the [`SECRET_NOTE_NOT_CARRIED`] preview note.
pub fn parse_electerm(bytes: &[u8]) -> Result<Vec<ImportedSession>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Electerm bookmarks file is not valid JSON: {error}"))?;
    let (bookmarks, groups_raw) = match value {
        Value::Array(items) => (items, None),
        Value::Object(map) => {
            let Some(bookmarks) = map.get("bookmarks").and_then(Value::as_array).cloned() else {
                return Err("Electerm JSON object has no bookmarks array".to_string());
            };
            (bookmarks, map.get("bookmarkGroups").cloned())
        }
        _ => {
            return Err(
                "Electerm bookmarks file must be a JSON array or an object with a bookmarks array"
                    .to_string(),
            )
        }
    };
    let groups = electerm_groups(groups_raw.as_ref());
    let mut bookmark_groups: HashMap<String, String> = HashMap::new();
    for group in &groups {
        for bookmark_id in &group.bookmark_ids {
            bookmark_groups
                .entry(bookmark_id.clone())
                .or_insert_with(|| group.id.clone());
        }
    }
    let mut sessions = Vec::new();
    for bookmark in &bookmarks {
        if let Some(session) = electerm_session(bookmark, &groups, &bookmark_groups) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

fn electerm_groups(raw: Option<&Value>) -> Vec<ElectermGroup> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            Some(ElectermGroup {
                id: json_text(object, "id")?.to_string(),
                title: json_text(object, "title").unwrap_or_default().to_string(),
                bookmark_ids: json_text_list(object.get("bookmarkIds")),
                group_ids: json_text_list(object.get("bookmarkGroupIds")),
            })
        })
        .collect()
}

fn electerm_session(
    bookmark: &Value,
    groups: &[ElectermGroup],
    bookmark_groups: &HashMap<String, String>,
) -> Option<ImportedSession> {
    let object = bookmark.as_object()?;
    let session_type = json_text(object, "type").unwrap_or_default();
    if !session_type.eq_ignore_ascii_case("ssh") {
        return None;
    }
    if object.get("enable_ssh") == Some(&Value::Bool(false)) {
        return None;
    }
    let host = json_text(object, "host")
        .map(str::trim)
        .filter(|host| !host.is_empty())?;
    let port = match json_u64(object, "port") {
        Some(port) if (1..=u64::from(u16::MAX)).contains(&port) => port as u16,
        // An explicit out-of-range port marks the bookmark as broken — skip
        // it (NyaTerm semantics), do not silently fall back to 22.
        Some(_) => return None,
        None => 22,
    };
    let username = json_text(object, "username")
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .unwrap_or("root");
    let name = json_text(object, "title")
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(host);
    let mut session = ImportedSession::new(
        name.to_string(),
        host.to_string(),
        port,
        username.to_string(),
    );
    session.group_path = json_text(object, "id")
        .and_then(|id| bookmark_groups.get(id))
        .map(|group_id| electerm_group_path(group_id, groups))
        .unwrap_or_default();
    if json_text(object, "auth_type")
        .map(str::trim)
        .is_some_and(|auth| auth.eq_ignore_ascii_case("password"))
    {
        session.auth = ImportedAuth::Password { has_secret: false };
        session.secret_note = SECRET_NOTE_NOT_CARRIED.to_string();
    }
    Some(session)
}

/// Resolves a group id to its full path by walking `bookmarkGroupIds` parent
/// chains; a `visited` set breaks cycles.
fn electerm_group_path(group_id: &str, groups: &[ElectermGroup]) -> Vec<String> {
    let by_id: HashMap<&str, &ElectermGroup> = groups
        .iter()
        .map(|group| (group.id.as_str(), group))
        .collect();
    let parent_of: HashMap<&str, &str> = groups
        .iter()
        .flat_map(|group| {
            group
                .group_ids
                .iter()
                .map(move |child| (child.as_str(), group.id.as_str()))
        })
        .collect();
    let mut path = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut current = group_id;
    loop {
        if !visited.insert(current.to_string()) {
            break;
        }
        let Some(group) = by_id.get(current) else {
            break;
        };
        let title = group.title.trim();
        if !title.is_empty() {
            path.push(title.to_string());
        }
        let Some(parent) = parent_of.get(current) else {
            break;
        };
        current = parent;
    }
    path.reverse();
    path
}

// ---------------------------------------------------------------------------
// Termius (exported JSON)
// ---------------------------------------------------------------------------

/// Flattened reference tables for a Termius export: hosts point at
/// `ssh_config` entries (port), which point at `identities` (username,
/// password), which point at `keys` (PEM material).
#[derive(Debug, Default)]
struct TermiusConfig {
    port: Option<u64>,
    identity_id: Option<String>,
}

#[derive(Debug, Default)]
struct TermiusIdentity {
    username: String,
    password: String,
    ssh_key_id: Option<String>,
}

#[derive(Debug, Default)]
struct TermiusKey {
    passphrase: String,
    private_key: String,
}

#[derive(Debug, Default)]
struct TermiusGroup {
    label: String,
    parent_id: Option<String>,
}

/// Parses a Termius JSON export (`Settings → Export`): an object whose
/// optional `data` wrapper holds `hosts`, `groups`, `ssh_configs`,
/// `identities` and `keys` arrays. Field mapping mirrors the NyaTerm
/// importer: the host label falls back to the address, the username to
/// `root`, and the port resolves through the host's `ssh_config`. Secret
/// fields that arrive as encrypted sync blobs (base64 starting with the
/// `BA` version prefix) are dropped, never decrypted — the session keeps
/// password semantics with the [`SECRET_NOTE_ENCRYPTED`] note. Plaintext
/// passwords and PEM private keys are carried over.
pub fn parse_termius(bytes: &[u8]) -> Result<Vec<ImportedSession>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Termius export file is not valid JSON: {error}"))?;
    let root = value.get("data").unwrap_or(&value);
    let Some(hosts) = root.get("hosts").and_then(Value::as_array) else {
        return Err("Termius export JSON has no hosts array".to_string());
    };
    let groups = termius_groups(root.get("groups"));
    let configs = termius_configs(root.get("ssh_configs"));
    let identities = termius_identities(root.get("identities"));
    let keys = termius_keys(root.get("keys").or_else(|| root.get("ssh_keys")));
    let mut sessions = Vec::new();
    for host in hosts {
        if let Some(session) = termius_session(host, &groups, &configs, &identities, &keys) {
            push_preview_session(&mut sessions, session)?;
        }
    }
    Ok(sessions)
}

fn termius_groups(value: Option<&Value>) -> HashMap<String, TermiusGroup> {
    let Some(items) = value.and_then(Value::as_array) else {
        return HashMap::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = json_text(object, "id")?.to_string();
            Some((
                id,
                TermiusGroup {
                    label: normalize_import_text(json_text(object, "label")),
                    parent_id: json_id_ref(object, "parent").map(str::to_owned),
                },
            ))
        })
        .collect()
}

fn termius_configs(value: Option<&Value>) -> HashMap<String, TermiusConfig> {
    let Some(items) = value.and_then(Value::as_array) else {
        return HashMap::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = json_text(object, "id")?.to_string();
            Some((
                id,
                TermiusConfig {
                    port: json_u64(object, "port").filter(|port| *port > 0),
                    identity_id: json_id_ref(object, "identity")
                        .or_else(|| json_id_ref(object, "identity_id"))
                        .map(str::to_owned),
                },
            ))
        })
        .collect()
}

fn termius_identities(value: Option<&Value>) -> HashMap<String, TermiusIdentity> {
    let Some(items) = value.and_then(Value::as_array) else {
        return HashMap::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = json_text(object, "id")?.to_string();
            Some((
                id,
                TermiusIdentity {
                    username: normalize_import_text(json_text(object, "username")),
                    password: normalize_import_text(json_text(object, "password")),
                    ssh_key_id: json_id_ref(object, "ssh_key")
                        .or_else(|| json_id_ref(object, "ssh_key_id"))
                        .map(str::to_owned),
                },
            ))
        })
        .collect()
}

fn termius_keys(value: Option<&Value>) -> HashMap<String, TermiusKey> {
    let Some(items) = value.and_then(Value::as_array) else {
        return HashMap::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = json_text(object, "id")?.to_string();
            Some((
                id,
                TermiusKey {
                    passphrase: normalize_import_text(json_text(object, "passphrase")),
                    private_key: normalize_import_text(
                        json_text(object, "privateKey")
                            .or_else(|| json_text(object, "private_key")),
                    ),
                },
            ))
        })
        .collect()
}

fn termius_session(
    host: &Value,
    groups: &HashMap<String, TermiusGroup>,
    configs: &HashMap<String, TermiusConfig>,
    identities: &HashMap<String, TermiusIdentity>,
    keys: &HashMap<String, TermiusKey>,
) -> Option<ImportedSession> {
    let object = host.as_object()?;
    let address = json_text(object, "address")
        .map(str::trim)
        .filter(|address| !address.is_empty())?;
    let config = json_id_ref(object, "ssh_config").and_then(|id| configs.get(id));
    let port = json_u64(object, "port")
        .filter(|port| *port > 0)
        .or(config.and_then(|config| config.port))
        .and_then(|port| u16::try_from(port).ok())
        .unwrap_or(22);
    let identity = json_id_ref(object, "identity")
        .or(config.and_then(|config| config.identity_id.as_deref()))
        .and_then(|id| identities.get(id));
    let mut username = json_text(object, "username")
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .unwrap_or_else(|| {
            identity
                .map(|identity| identity.username.as_str())
                .unwrap_or_default()
        });
    if username.is_empty() {
        username = "root";
    }
    let name = json_text(object, "label")
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or(address);
    // Password: the host entry wins, then the identity.
    let mut password_raw = normalize_import_text(json_text(object, "password"));
    if password_raw.is_empty() {
        password_raw = identity
            .map(|identity| identity.password.as_str())
            .unwrap_or_default()
            .to_string();
    }
    let password_present = !password_raw.is_empty();
    let plaintext_password = password_present && !is_termius_encrypted_blob(&password_raw);
    // Key material is never carried into the preview model: we only derive
    // whether a plaintext PEM/passphrase existed before the parsed JSON drops.
    let key = identity
        .and_then(|identity| identity.ssh_key_id.as_deref())
        .and_then(|id| keys.get(id));
    let has_key_content = key
        .map(|key| key.private_key.trim())
        .is_some_and(|private_key| private_key.starts_with("-----BEGIN"));
    let has_key_passphrase = key
        .map(|key| key.passphrase.as_str())
        .is_some_and(|passphrase| !passphrase.is_empty() && !is_termius_encrypted_blob(passphrase));
    let mut session = ImportedSession::new(
        name.to_string(),
        address.to_string(),
        port,
        username.to_string(),
    );
    session.group_path = termius_group_path(
        json_id_ref(object, "group").or_else(|| json_text(object, "group_id")),
        groups,
    );
    let encrypted_password = password_present && !plaintext_password;
    let (auth, note) = if plaintext_password {
        (ImportedAuth::Password { has_secret: true }, None)
    } else if encrypted_password {
        (
            ImportedAuth::Password { has_secret: false },
            Some(SECRET_NOTE_ENCRYPTED),
        )
    } else if has_key_content || has_key_passphrase {
        (
            ImportedAuth::PrivateKey {
                path: None,
                has_secret: has_key_content || has_key_passphrase,
            },
            None,
        )
    } else {
        (ImportedAuth::None, None)
    };
    session.auth = auth;
    session.secret_note = note.unwrap_or_default().to_string();
    Some(session)
}

/// Walks the group parent chain bottom-up; a `visited` set breaks cycles.
fn termius_group_path(
    group_id: Option<&str>,
    groups: &HashMap<String, TermiusGroup>,
) -> Vec<String> {
    let Some(mut current) = group_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    let mut path = Vec::new();
    let mut visited = std::collections::HashSet::new();
    loop {
        if !visited.insert(current.to_string()) {
            break;
        }
        let Some(group) = groups.get(current) else {
            break;
        };
        if !group.label.is_empty() {
            path.push(group.label.clone());
        }
        let Some(parent) = group
            .parent_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            break;
        };
        current = parent;
    }
    path.reverse();
    path
}

/// Termius encrypts secret fields into base64 blobs whose decoded form starts
/// with the `BA` version prefix — the same heuristic as the NyaTerm importer
/// (`is_termius_encrypted_value`). Encrypted material is never decoded here.
fn is_termius_encrypted_blob(value: &str) -> bool {
    value.len() >= 40
        && value.starts_with("BA")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

// ---------------------------------------------------------------------------
// Streaming preview protocol
// ---------------------------------------------------------------------------

/// Removes the obsolete pre-streaming connection store at startup. It is not
/// migrated because the new contract never retains imported connections.
pub fn remove_legacy_store(data_dir: &Path) -> Result<(), String> {
    let legacy = data_dir.join(LEGACY_STORE_FILE);
    match std::fs::remove_file(legacy) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Failed to remove legacy import store".to_string()),
    }
}

/// In-memory upload state. The source bytes and master password are wrapped in
/// `Zeroizing`, so removal from the state map wipes their backing buffers.
struct ImportUpload {
    kind: String,
    main: ImportFile,
    user_config: Option<ImportFile>,
    master_password: Option<Zeroizing<String>>,
    created_at: Instant,
    reserved_bytes: u64,
}

struct ImportFile {
    expected: u64,
    bytes: Zeroizing<Vec<u8>>,
}

impl ImportFile {
    fn new(expected: u64) -> ImportFile {
        ImportFile {
            expected,
            bytes: Zeroizing::new(Vec::with_capacity(usize::try_from(expected).unwrap_or(0))),
        }
    }
}

#[derive(Default)]
struct ImportState {
    uploads: HashMap<String, ImportUpload>,
    reserved_bytes: u64,
}

/// Owns temporary preview data. Every state exit (finish, cancel, protocol
/// error and TTL sweep) drops `Zeroizing` source bytes and WindTerm passwords.
#[derive(Default)]
pub struct ImportStream {
    state: Mutex<ImportState>,
}

impl ImportStream {
    pub fn start(&self, params: &Value) -> Result<Value, String> {
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("import/preview/start: kind is required")?;
        validate_kind(kind)?;
        let main_size = required_size(params, "mainSize")?;
        let user_config_size = params.get("userConfigSize").and_then(Value::as_u64);
        if kind != "windterm" && user_config_size.is_some() {
            return Err(
                "import/preview/start: userConfigSize is only valid for WindTerm".to_string(),
            );
        }
        let reserved_bytes = main_size
            .checked_add(user_config_size.unwrap_or(0))
            .ok_or("import/preview/start: size overflow")?;
        if reserved_bytes > MAX_INPUT_BYTES as u64 {
            return Err(format!(
                "Import files exceed the {} MiB total limit",
                MAX_INPUT_BYTES / (1024 * 1024)
            ));
        }
        let master_password = params
            .get("masterPassword")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| Zeroizing::new(value.to_owned()));
        if master_password
            .as_ref()
            .is_some_and(|value| value.len() > 4096)
        {
            return Err(
                "import/preview/start: masterPassword exceeds the 4096 byte limit".to_string(),
            );
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "import preview state is unavailable")?;
        expire_locked(&mut state, Instant::now());
        if state.uploads.len() >= MAX_IMPORT_TASKS {
            return Err("Too many active import previews".to_string());
        }
        if state.reserved_bytes.saturating_add(reserved_bytes) > MAX_IMPORT_MEMORY_BYTES {
            return Err("Active import previews exceed the process memory budget".to_string());
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        state.reserved_bytes += reserved_bytes;
        state.uploads.insert(
            task_id.clone(),
            ImportUpload {
                kind: kind.to_string(),
                main: ImportFile::new(main_size),
                user_config: user_config_size.map(ImportFile::new),
                master_password,
                created_at: Instant::now(),
                reserved_bytes,
            },
        );
        Ok(json!({ "taskId": task_id, "chunkSize": IMPORT_CHUNK_LIMIT }))
    }

    pub fn append(&self, task_id: &str, part: &str, frame: &[u8]) -> Result<u64, String> {
        let result = (|| {
            if frame.len() < 8 {
                return Err("import preview chunk is missing its 8-byte offset".to_string());
            }
            let offset = u64::from_be_bytes(frame[..8].try_into().expect("slice length checked"));
            let payload = &frame[8..];
            if payload.len() > IMPORT_CHUNK_LIMIT {
                return Err(format!(
                    "import preview chunk of {} bytes exceeds the {} byte limit",
                    payload.len(),
                    IMPORT_CHUNK_LIMIT
                ));
            }
            let mut state = self
                .state
                .lock()
                .map_err(|_| "import preview state is unavailable")?;
            expire_locked(&mut state, Instant::now());
            let upload = state
                .uploads
                .get_mut(task_id)
                .ok_or("import preview task was not found")?;
            let file = match part {
                "main" => &mut upload.main,
                "user-config" => upload
                    .user_config
                    .as_mut()
                    .ok_or("import preview task has no user.config stream")?,
                _ => return Err("unknown import preview binary stream".to_string()),
            };
            let expected_offset = file.bytes.len() as u64;
            if offset != expected_offset {
                return Err(format!("import preview chunk offset {offset} does not match expected {expected_offset}"));
            }
            let next_offset = offset
                .checked_add(payload.len() as u64)
                .ok_or("import preview chunk offset overflow")?;
            if next_offset > file.expected {
                return Err("import preview chunk exceeds declared file size".to_string());
            }
            file.bytes.extend_from_slice(payload);
            Ok(next_offset)
        })();
        if result.is_err() {
            self.clear(task_id);
        }
        result
    }

    pub fn finish(&self, task_id: &str) -> Result<Value, String> {
        let upload = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "import preview state is unavailable")?;
            expire_locked(&mut state, Instant::now());
            remove_upload(&mut state, task_id).ok_or("import preview task was not found")?
        };
        if upload.main.bytes.len() as u64 != upload.main.expected {
            return Err("import preview main file is incomplete".to_string());
        }
        if let Some(config) = &upload.user_config {
            if config.bytes.len() as u64 != config.expected {
                return Err("import preview user.config file is incomplete".to_string());
            }
        }
        let sessions = parse_uploaded(
            &upload.kind,
            &upload.main.bytes,
            upload
                .user_config
                .as_ref()
                .map(|config| config.bytes.as_slice()),
            upload
                .master_password
                .as_deref()
                .map(|value| value.as_str()),
        )?;
        let visible = sessions.len().min(MAX_PREVIEW_SESSIONS);
        let selected = (0..visible).collect::<Vec<_>>();
        let normalized = normalized_export(&upload.kind, &sessions, &selected)?;
        let preview = normalized["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, session)| preview_view(index, session))
            .collect::<Vec<_>>();
        Ok(
            json!({ "sourceKind": upload.kind, "sessions": preview, "totalSessions": sessions.len(), "truncated": sessions.len() > visible, "export": normalized }),
        )
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        self.clear(task_id)
    }

    /// Deterministic testable TTL sweep; every public operation invokes it.
    #[cfg(test)]
    pub fn expire_before(&self, now: Instant) -> bool {
        self.state
            .lock()
            .map(|mut state| expire_locked(&mut state, now) > 0)
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn active_task_count(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.uploads.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    fn reserved_bytes(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.reserved_bytes)
            .unwrap_or(0)
    }

    fn clear(&self, task_id: &str) -> bool {
        self.state
            .lock()
            .map(|mut state| {
                expire_locked(&mut state, Instant::now());
                remove_upload(&mut state, task_id).is_some()
            })
            .unwrap_or(false)
    }
}

fn remove_upload(state: &mut ImportState, task_id: &str) -> Option<ImportUpload> {
    let upload = state.uploads.remove(task_id)?;
    state.reserved_bytes = state.reserved_bytes.saturating_sub(upload.reserved_bytes);
    Some(upload)
}

fn expire_locked(state: &mut ImportState, now: Instant) -> usize {
    let expired = state
        .uploads
        .iter()
        .filter(|(_, upload)| now.saturating_duration_since(upload.created_at) >= IMPORT_TASK_TTL)
        .map(|(task_id, _)| task_id.clone())
        .collect::<Vec<_>>();
    for task_id in &expired {
        let _ = remove_upload(state, task_id);
    }
    expired.len()
}

fn required_size(params: &Value, field: &str) -> Result<u64, String> {
    params
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("import/preview/start: {field} is required"))
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "moba" | "xshell" | "windterm" | "securecrt" | "finalshell" | "electerm" | "termius" => {
            Ok(())
        }
        _ => Err(format!("Unknown import kind: {kind}")),
    }
}

fn parse_uploaded(
    kind: &str,
    file: &[u8],
    user_config: Option<&[u8]>,
    master_password: Option<&str>,
) -> Result<Vec<ImportedSession>, String> {
    match kind {
        "moba" => parse_moba_ini(
            std::str::from_utf8(file).map_err(|_| "MobaXterm file is not valid UTF-8")?,
        ),
        "xshell" => parse_xshell(file),
        "windterm" => parse_windterm(file, user_config, master_password),
        "securecrt" => parse_securecrt(
            std::str::from_utf8(file).map_err(|_| "SecureCRT file is not valid UTF-8")?,
        ),
        "finalshell" => parse_finalshell(file),
        "electerm" => parse_electerm(file),
        "termius" => parse_termius(file),
        _ => Err(format!("Unknown import kind: {kind}")),
    }
}

/// Builds a portable, normalized export with metadata only. Passwords, private
/// key contents and passphrases are structurally absent even when source files
/// held them in plaintext.
pub fn normalized_export(
    source_kind: &str,
    sessions: &[ImportedSession],
    selected: &[usize],
) -> Result<Value, String> {
    validate_kind(source_kind)?;
    if selected.len() > MAX_PREVIEW_SESSIONS {
        return Err(format!(
            "An export may contain at most {MAX_PREVIEW_SESSIONS} sessions"
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::with_capacity(selected.len());
    for index in selected {
        if !seen.insert(*index) {
            continue;
        }
        let session = sessions
            .get(*index)
            .ok_or_else(|| format!("Selected preview index {index} is invalid"))?;
        rows.push(normalized_session(session));
    }
    Ok(json!({ "schemaVersion": 1, "sourceKind": source_kind, "sessions": rows }))
}

fn normalized_session(session: &ImportedSession) -> Value {
    let key_path = match &session.auth {
        ImportedAuth::PrivateKey { path, .. } => path.as_deref().unwrap_or_default(),
        _ => "",
    };
    json!({
        "name": preview_text(&session.name),
        "host": preview_text(&session.host),
        "port": session.port,
        "username": preview_text(&session.username),
        "groupPath": session.group_path.iter().map(|part| preview_text(part)).collect::<Vec<_>>(),
        "description": preview_text(&session.description),
        "auth": {
            "kind": auth_kind(&session.auth),
            "hasSecret": has_secret(&session.auth),
            "keyPath": preview_text(key_path),
            "secretNote": session.secret_note,
        },
    })
}

fn preview_view(index: usize, session: &Value) -> Value {
    json!({
        "index": index,
        "name": session["name"],
        "host": session["host"],
        "port": session["port"],
        "username": session["username"],
        "groupPath": session["groupPath"].as_array().map(|parts| parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("/")).unwrap_or_default(),
        "description": session["description"],
        "authKind": session["auth"]["kind"],
        "hasSecret": session["auth"]["hasSecret"],
        "secretNote": session["auth"]["secretNote"],
    })
}

fn preview_text(value: &str) -> String {
    if value.len() <= MAX_PREVIEW_TEXT_BYTES {
        return value.to_string();
    }
    let mut end = MAX_PREVIEW_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- MobaXterm ----------------------------------------------------------

    #[test]
    fn moba_parses_ssh_sessions_with_group_and_defaults() {
        let text = concat!(
            "[Bookmarks]\n",
            "SubRep=Prod\\Web\n",
            "ImgNum=42\n",
            "web1=#109#0%192.168.1.10%22%deploy%pw%...\n",
            "db1=#109#0%10.0.0.5%%%pw%...\n",
            "custom=#109#0%10.0.0.9%2222%ops%pw%...\n",
        );
        let sessions = parse_moba_ini(text).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0].name, "web1");
        assert_eq!(sessions[0].group_path, vec!["Prod", "Web"]);
        assert_eq!(sessions[0].host, "192.168.1.10");
        assert_eq!(sessions[0].port, 22);
        assert_eq!(sessions[0].username, "deploy");
        assert_eq!(sessions[0].auth, ImportedAuth::None);
        // Missing port and user fall back to 22 / root.
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].username, "root");
        assert_eq!(sessions[2].port, 2222);
    }

    #[test]
    fn moba_skips_non_ssh_entries_and_other_sections() {
        let text = concat!(
            "[Bookmarks]\n",
            "shell=#1#0%192.168.1.10%22%root%\n",
            "telnet=#99#0%192.168.1.11%23%root%\n",
            "ssh=#109#0%192.168.1.12%22%root%\n",
            "[Bookmarks_2]\n",
            "in-other=#109#0%192.168.1.13%22%root%\n",
            "[Servers]\n",
            "wrong-section=#109#0%192.168.1.14%22%root%\n",
        );
        let sessions = parse_moba_ini(text).unwrap();
        let names: Vec<&str> = sessions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["ssh", "in-other"]);
    }

    #[test]
    fn moba_empty_sub_rep_means_no_group_and_bad_values_are_skipped() {
        let text = concat!(
            "[Bookmarks]\n",
            "SubRep=\n",
            "ok=#109#0%1.2.3.4%22%root%\n",
            "nohost=#109#0%%22%root%\n",
            "badport=#109#0%1.2.3.5%not-a-port%root%\n",
            "novalue=#109#0\n",
        );
        let sessions = parse_moba_ini(text).unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions[0].group_path.is_empty());
        // Unparsable port falls back to 22.
        assert_eq!(sessions[1].port, 22);
    }

    #[test]
    fn moba_tolerates_garbage_comments_and_missing_sections() {
        assert!(parse_moba_ini("").unwrap().is_empty());
        assert!(parse_moba_ini("not an ini at all\n;;;;\n")
            .unwrap()
            .is_empty());
        assert!(parse_moba_ini("[Bookmarks\nx=#109#0%1.2.3.4%22%root%\n")
            .unwrap()
            .is_empty());
        let text = "; comment\n# comment\n[Bookmarks]\n;another\nssh=#109#0%1.2.3.4%22%root%\n";
        let sessions = parse_moba_ini(text).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].host, "1.2.3.4");
    }

    // -- Xshell -------------------------------------------------------------

    /// Builds an in-memory ZIP archive with the given entries.
    fn xshell_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default();
            for (name, content) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buf.into_inner()
    }

    const WEB_XSH: &str = concat!(
        "[CONNECTION]\n",
        "Protocol=SSH\n",
        "Host=192.168.1.20\n",
        "Port=2222\n",
        "\n",
        "[CONNECTION:AUTHENTICATION]\n",
        "UserName=deploy\n",
        "UserKey=my-key\n",
        "\n",
        "[SCRIPT]\n",
        "something=else\n",
    );

    #[test]
    fn xshell_parses_sessions_groups_and_key_auth() {
        let zip = xshell_zip(&[
            ("Xshell/Sessions/Prod/web.xsh", WEB_XSH),
            (
                "Xshell/Sessions/db.xsh",
                "[CONNECTION]\nProtocol=SSH\nHost=10.0.0.2\n",
            ),
            ("notes.txt", "ignore me"),
        ]);
        let sessions = parse_xshell(&zip).unwrap();
        assert_eq!(sessions.len(), 2);
        let web = &sessions[0];
        assert_eq!(web.name, "web");
        assert_eq!(web.host, "192.168.1.20");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        assert_eq!(web.group_path, vec!["Prod"]);
        assert_eq!(
            web.auth,
            ImportedAuth::PrivateKey {
                path: Some("my-key".to_string()),
                has_secret: false,
            }
        );
        // Defaults: port 22, user root, no group at the Sessions root.
        assert_eq!(sessions[1].name, "db");
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].username, "root");
        assert!(sessions[1].group_path.is_empty());
        assert_eq!(sessions[1].auth, ImportedAuth::None);
    }

    #[test]
    fn xshell_skips_non_ssh_and_non_xsh_entries() {
        let zip = xshell_zip(&[
            (
                "Xshell/Sessions/serial.xsh",
                "[CONNECTION]\nProtocol=SERIAL\nHost=COM3\n",
            ),
            (
                "Xshell/Sessions/telnet.xsh",
                "[CONNECTION]\nProtocol=Telnet\nHost=10.0.0.3\nPort=23\n",
            ),
            ("Xshell/Sessions/ssh.xsh", WEB_XSH),
            ("Xshell/backup/old.xsh.bak", "junk"),
        ]);
        let sessions = parse_xshell(&zip).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "ssh");
    }

    #[test]
    fn xshell_malformed_xsh_entries_are_skipped_not_fatal() {
        let zip = xshell_zip(&[
            ("garbage.xsh", "this is not an ini at all"),
            ("no-host.xsh", "[CONNECTION]\nProtocol=SSH\n"),
            ("good.xsh", WEB_XSH),
        ]);
        let sessions = parse_xshell(&zip).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "good");
    }

    #[test]
    fn xshell_rejects_invalid_archives_and_enforces_entry_cap() {
        assert!(parse_xshell(b"definitely not a zip").is_err());
        // One entry over the cap fails the whole archive.
        let mut entries = Vec::new();
        for index in 0..=MAX_ZIP_ENTRIES {
            entries.push((format!("s{index}.xsh"), String::from("[CONNECTION]\n")));
        }
        let refs: Vec<(&str, &str)> = entries
            .iter()
            .map(|(n, c)| (n.as_str(), c.as_str()))
            .collect();
        let zip = xshell_zip(&refs);
        let error = parse_xshell(&zip).unwrap_err();
        assert!(error.contains("more than"), "unexpected error: {error}");
        // Just under the cap parses fine.
        let refs: Vec<(&str, &str)> = entries
            .iter()
            .take(MAX_ZIP_ENTRIES)
            .map(|(n, c)| (n.as_str(), c.as_str()))
            .collect();
        assert!(parse_xshell(&xshell_zip(&refs)).is_ok());
    }

    #[test]
    fn zip_entry_names_decode_utf8_first_then_gbk() {
        // ASCII and UTF-8 names decode verbatim.
        assert_eq!(decode_zip_name(b"web.xsh"), "web.xsh");
        assert_eq!(decode_zip_name("生产环境.xsh".as_bytes()), "生产环境.xsh");
        // GBK bytes for "生产环境.xsh" (Chinese Windows exports) are not
        // valid UTF-8, so the GBK fallback applies.
        let (gbk, _, had_errors) = encoding_rs::GBK.encode("生产环境.xsh");
        assert!(!had_errors);
        let mut raw = b"Xshell/Sessions/".to_vec();
        raw.extend_from_slice(&gbk);
        let decoded = decode_zip_name(&raw);
        assert_eq!(decoded, "Xshell/Sessions/生产环境.xsh");
        // Undecodable bytes degrade lossily instead of panicking.
        assert_eq!(decode_zip_name(&[0xff, 0xfe]), "\u{fffd}\u{fffd}");
    }

    // -- WindTerm -----------------------------------------------------------

    const FINGERPRINT_HEX: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    /// Test-only helper: encrypts like WindTerm does (AES-256-CBC/PKCS7,
    /// key/IV derived via PBKDF2-HMAC-SHA3-512), so the parser round-trips
    /// against an independent encryption path.
    fn windterm_encrypt(master: &str, fingerprint_hex: &str, plaintext: &str) -> String {
        use aes::cipher::block_padding::Pkcs7;
        use aes::cipher::{BlockModeEncrypt, KeyIvInit};
        type Aes256CbcEncryptor = cbc::Encryptor<aes::Aes256>;
        let salt = fingerprint_bytes(fingerprint_hex);
        let (key, iv) = derive_windterm_key(master, &salt);
        let ciphertext = Aes256CbcEncryptor::new_from_slices(&key, &iv)
            .unwrap()
            .encrypt_padded_vec::<Pkcs7>(plaintext.as_bytes());
        BASE64.encode(ciphertext)
    }

    fn user_config_json(master_password: bool) -> String {
        json!({
            "application": {
                "fingerprint": FINGERPRINT_HEX,
                "masterPassword": master_password,
            }
        })
        .to_string()
    }

    #[test]
    fn windterm_parses_ssh_sessions_with_defaults_and_groups() {
        let sessions_json = json!([
            {
                "session": {
                    "protocol": "SSH",
                    "target": "ops@10.1.1.5",
                    "label": "gateway",
                    "port": 2200,
                    "group": "Cloud>AWS>us-east",
                    "description": "primary",
                }
            },
            {
                "session": {
                    "protocol": "ssh",
                    "target": "10.1.1.6",
                }
            },
            {
                "session": { "protocol": "Telnet", "target": "10.1.1.7" }
            },
            { "note": "no session object" },
            {
                "session": { "protocol": "SSH", "target": "@10.1.1.8" }
            },
            {
                "session": { "protocol": "SSH", "target": "10.1.1.9:22", "label": "x" },
            }
        ])
        .to_string();
        let sessions = parse_windterm(sessions_json.as_bytes(), None, None).unwrap();
        assert_eq!(sessions.len(), 4);
        assert_eq!(sessions[0].name, "gateway");
        assert_eq!(sessions[0].host, "10.1.1.5");
        assert_eq!(sessions[0].port, 2200);
        assert_eq!(sessions[0].username, "ops");
        assert_eq!(sessions[0].group_path, vec!["Cloud", "AWS", "us-east"]);
        assert_eq!(sessions[0].description, "primary");
        assert_eq!(sessions[0].auth, ImportedAuth::None);
        // Defaults: no @ → root, no port → 22, no label → host.
        assert_eq!(sessions[1].username, "root");
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].name, "10.1.1.6");
        assert!(sessions[1].group_path.is_empty());
        assert_eq!(sessions[3].username, "root");
    }

    #[test]
    fn windterm_plaintext_autologin_yields_password_auth() {
        let auto_login =
            json!({ "PasswordEnabled": true, "Password": "p@ss", "Public Key": {} }).to_string();
        let sessions_json = json!([{
            "session": {
                "protocol": "SSH",
                "target": "root@10.2.0.1",
                "label": "plain",
                "autoLogin": auto_login,
            }
        }])
        .to_string();
        let sessions = parse_windterm(sessions_json.as_bytes(), None, None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].auth,
            ImportedAuth::Password { has_secret: true }
        );
    }

    #[test]
    fn windterm_encrypted_autologin_roundtrips_with_master_password() {
        let auto_login = json!({
            "PasswordEnabled": true,
            "Password": "enc-p@ss",
            "Public Key": {
                "windows": { "path": "$(HomeDir)keys/id_ed25519", "pass": "key-phr" }
            }
        })
        .to_string();
        let mut sessions_json = json!([{
            "session": {
                "protocol": "SSH",
                "target": "deploy@10.3.0.1",
                "label": "encrypted",
                "autoLogin": windterm_encrypt("master-key", FINGERPRINT_HEX, &auto_login),
            }
        }])
        .to_string();
        let config = user_config_json(true);
        let sessions = parse_windterm(
            sessions_json.as_bytes(),
            Some(config.as_bytes()),
            Some("master-key"),
        )
        .unwrap();
        assert_eq!(sessions.len(), 1);
        // Password wins over the public key entry.
        assert_eq!(
            sessions[0].auth,
            ImportedAuth::Password { has_secret: true }
        );

        // Without the PasswordEnabled flag the public key entry applies, with
        // the $(HomeDir) prefix expanded.
        let key_only = json!({
            "Public Key": {
                "windows": { "path": "~/keys/id_rsa", "pass": "key-phr" }
            }
        })
        .to_string();
        sessions_json = json!([{
            "session": {
                "protocol": "SSH",
                "target": "deploy@10.3.0.1",
                "label": "keyed",
                "autoLogin": windterm_encrypt("master-key", FINGERPRINT_HEX, &key_only),
            }
        }])
        .to_string();
        let sessions = parse_windterm(
            sessions_json.as_bytes(),
            Some(config.as_bytes()),
            Some("master-key"),
        )
        .unwrap();
        match &sessions[0].auth {
            ImportedAuth::PrivateKey { path, has_secret } => {
                let path = path.as_deref().unwrap();
                assert!(path.ends_with("keys/id_rsa"), "unexpected path: {path}");
                assert_ne!(path, "~/keys/id_rsa");
                assert!(*has_secret, "passphrase is represented only as metadata");
            }
            other => panic!("expected private key auth, got {other:?}"),
        }
    }

    #[test]
    fn windterm_master_password_switch_requires_the_password() {
        let auto_login = json!({ "PasswordEnabled": true, "Password": "x" }).to_string();
        let sessions_json = json!([{
            "session": {
                "protocol": "SSH",
                "target": "root@10.3.0.2",
                "autoLogin": windterm_encrypt("master-key", FINGERPRINT_HEX, &auto_login),
            }
        }])
        .to_string();
        let config = user_config_json(true);
        let error =
            parse_windterm(sessions_json.as_bytes(), Some(config.as_bytes()), None).unwrap_err();
        assert_eq!(error, "WindTerm master password is required");
        // Switch off: no password needed, but the blob can't be decrypted —
        // credentials are skipped, the session survives.
        let config_off = user_config_json(false);
        let sessions =
            parse_windterm(sessions_json.as_bytes(), Some(config_off.as_bytes()), None).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].auth, ImportedAuth::None);
    }

    #[test]
    fn windterm_malformed_input_degrades_gracefully() {
        assert!(parse_windterm(b"not json", None, None).is_err());
        assert!(parse_windterm(b"{\"not\":\"an array\"}", None, None).is_err());
        // autoLogin that is neither JSON nor base64, and ciphertext that does
        // not decrypt: credentials skipped, sessions kept.
        let sessions_json = json!([
            { "session": { "protocol": "SSH", "target": "a@10.4.0.1", "autoLogin": "%%%garbage%%%" } },
            { "session": { "protocol": "SSH", "target": "b@10.4.0.2", "autoLogin": "AAAA" } },
        ])
        .to_string();
        let config = user_config_json(false);
        let sessions =
            parse_windterm(sessions_json.as_bytes(), Some(config.as_bytes()), None).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].auth, ImportedAuth::None);
        assert_eq!(sessions[1].auth, ImportedAuth::None);
    }

    // -- SecureCRT ----------------------------------------------------------

    const SECURECRT_EXPORT: &str = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<VanDyke version=\"9.0\">\n",
        "\t<key name=\"Default\">\n",
        "\t\t<string name=\"Protocol Name\">SSH2</string>\n",
        "\t\t<dword name=\"[SSH2] Port\">00000016</dword>\n",
        "\t</key>\n",
        "\t<key name=\"Sessions\">\n",
        "\t\t<key name=\"Prod\">\n",
        "\t\t\t<key name=\"web01\">\n",
        "\t\t\t\t<string name=\"Protocol Name\">SSH2</string>\n",
        "\t\t\t\t<string name=\"Hostname\">192.168.1.10</string>\n",
        "\t\t\t\t<dword name=\"[SSH2] Port\">000008ae</dword>\n",
        "\t\t\t\t<string name=\"Username\">deploy</string>\n",
        "\t\t\t\t<string name=\"Password V2\">uH9kJ2vQ EncryptedBlob</string>\n",
        "\t\t\t</key>\n",
        "\t\t\t<key name=\"legacy\">\n",
        "\t\t\t\t<string name=\"Protocol Name\">SSH2</string>\n",
        "\t\t\t\t<string name=\"Hostname\">10.0.0.5</string>\n",
        "\t\t\t\t<dword name=\"Port\">34</dword>\n",
        "\t\t\t</key>\n",
        "\t\t\t<key name=\"telnet\">\n",
        "\t\t\t\t<string name=\"Protocol Name\">Telnet</string>\n",
        "\t\t\t\t<string name=\"Hostname\">10.0.0.6</string>\n",
        "\t\t\t</key>\n",
        "\t\t\t<key name=\"nohost\">\n",
        "\t\t\t\t<string name=\"Protocol Name\">SSH2</string>\n",
        "\t\t\t</key>\n",
        "\t\t</key>\n",
        "\t\t<key name=\"root-level\">\n",
        "\t\t\t<string name=\"Protocol Name\">SSH2</string>\n",
        "\t\t\t<string name=\"Hostname\">10.0.0.9</string>\n",
        "\t\t</key>\n",
        "\t</key>\n",
        "</VanDyke>\n",
    );

    #[test]
    fn securecrt_parses_sessions_groups_hex_ports_and_defaults() {
        let sessions = parse_securecrt(SECURECRT_EXPORT).unwrap();
        assert_eq!(sessions.len(), 3);
        let web = &sessions[0];
        assert_eq!(web.name, "web01");
        assert_eq!(web.group_path, vec!["Prod"]);
        assert_eq!(web.host, "192.168.1.10");
        // 000008ae is SecureCRT's zero-padded hex dword shape for 2222.
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        // The export only carries encrypted password blobs: password
        // semantics with no material plus the encrypted note.
        assert_eq!(web.auth, ImportedAuth::Password { has_secret: false });
        assert_eq!(web.secret_note, SECRET_NOTE_ENCRYPTED);
        // Decimal fallback for hand-written dword values.
        assert_eq!(sessions[1].port, 34);
        // Defaults: no port → 22, no user → root, root-level key → no group.
        assert_eq!(sessions[2].name, "root-level");
        assert_eq!(sessions[2].port, 22);
        assert_eq!(sessions[2].username, "root");
        assert!(sessions[2].group_path.is_empty());
        // Non-SSH2 protocols and host-less keys are skipped, and the
        // Default key outside Sessions never becomes a session.
    }

    #[test]
    fn securecrt_dword_ports_prefer_hex_then_decimal() {
        assert_eq!(parse_securecrt_dword("00000016"), Some(22));
        assert_eq!(parse_securecrt_dword("000008ae"), Some(2222));
        assert_eq!(parse_securecrt_dword("0000FFFF"), Some(65535));
        // Not the 8-digit shape → decimal.
        assert_eq!(parse_securecrt_dword("34"), Some(34));
        assert_eq!(parse_securecrt_dword("22"), Some(22));
        // Junk and the zero port degrade to None (caller defaults to 22).
        assert_eq!(parse_securecrt_dword("junk"), None);
        assert_eq!(parse_securecrt_dword("00000000"), None);
        assert_eq!(parse_securecrt_dword(""), None);
    }

    #[test]
    fn securecrt_deeply_nested_keys_fail_closed() {
        // A1 回归：恶意深嵌套（500 层）必须快速拒绝，而不是逐闭合标签克隆
        // 整个祖先栈（O(N²) CPU 放大）。
        let mut text = String::from("<VanDyke version=\"9.0\"><key name=\"Sessions\">");
        for depth in 0..500 {
            text.push_str(&format!("<key name=\"folder{depth}\">"));
        }
        for _ in 0..500 {
            text.push_str("</key>");
        }
        text.push_str("</key></VanDyke>");
        let error = parse_securecrt(&text).expect_err("deep nesting must be rejected");
        assert!(error.contains("nesting"), "{error}");
        // 真实导出的嵌套深度（Sessions > 文件夹 > 会话）不受影响。
        let sessions = parse_securecrt(SECURECRT_EXPORT).unwrap();
        assert_eq!(sessions.len(), 3);
    }

    #[test]
    fn imported_auth_debug_has_no_credential_fields() {
        let password = ImportedAuth::Password { has_secret: true };
        let key = ImportedAuth::PrivateKey {
            path: Some("/home/u/id_ed25519".to_string()),
            has_secret: true,
        };
        let rendered = format!("{password:?} {key:?}");
        assert!(rendered.contains("has_secret"), "{rendered}");
        assert!(rendered.contains("/home/u/id_ed25519"), "{rendered}");
        assert!(!rendered.contains("value"), "{rendered}");
        assert!(!rendered.contains("content"), "{rendered}");
        assert!(!rendered.contains("passphrase"), "{rendered}");
    }

    #[test]
    fn securecrt_entity_and_attribute_decoding() {
        let xml = concat!(
            "<VanDyke><key name=\"Sessions\"><key name=\"gr&amp;oup\"><key name=\"sess\">\n",
            "<string name=\"Protocol Name\">SSH2</string>\n",
            "<string name=\"Hostname\">h&#111;st&#x2F;range</string>\n",
            "<string name=\"Username\">u&quot;q</string>\n",
            "</key></key></key></VanDyke>",
        );
        let sessions = parse_securecrt(xml).unwrap();
        assert_eq!(sessions.len(), 1);
        // Frame names and field values decode named and numeric entities.
        assert_eq!(sessions[0].name, "sess");
        assert_eq!(sessions[0].host, "host/range");
        assert_eq!(sessions[0].username, "u\"q");
        assert_eq!(sessions[0].group_path, vec!["gr&oup"]);
    }

    #[test]
    fn securecrt_malformed_xml_fails_closed() {
        // Unterminated tag / comment / closing tag.
        assert!(parse_securecrt("<key name=\"Sessions\"").is_err());
        assert!(parse_securecrt("<!-- never closed").is_err());
        assert!(parse_securecrt("</key").is_err());
        // Unclosed <key> frames.
        assert!(parse_securecrt("<key name=\"Sessions\"><key name=\"a\">").is_err());
        // Unbalanced </key>.
        assert!(parse_securecrt("</key>").is_err());
        // Value element closed by a different tag.
        assert!(parse_securecrt(
            "<key name=\"Sessions\"><key name=\"a\"><string name=\"Hostname\">h</key></key>"
        )
        .is_err());
        // Unquoted attribute value.
        assert!(parse_securecrt("<key name=Sessions></key>").is_err());
        // Unknown / unterminated entity.
        assert!(parse_securecrt(
            "<key name=\"Sessions\"><key name=\"a\"><string name=\"Hostname\">a&b;</string></key></key>"
        )
        .is_err());
        // Structurally valid input without any <key> tree parses to zero
        // sessions instead of failing (bad content ≠ bad structure).
        assert!(parse_securecrt("").unwrap().is_empty());
        assert!(parse_securecrt("plain text, no xml").unwrap().is_empty());
    }

    // -- FinalShell ---------------------------------------------------------

    fn finalshell_config_json(name: &str, host: &str, extra: &str) -> String {
        format!(
            "{{\"name\":\"{name}\",\"host\":\"{host}\",\"port\":2222,\"user_name\":\"deploy\",\
             \"parent_id\":\"f2\",\"conection_type\":100,\"description\":\"primary\"{extra}}}"
        )
    }

    #[test]
    fn finalshell_zip_parses_folders_sessions_and_skips() {
        let folder1 = "{\"id\":\"f1\",\"name\":\"Prod\",\"parent_id\":\"root\"}";
        let folder2 = "{\"id\":\"f2\",\"name\":\"Web\",\"parent_id\":\"f1\"}";
        let zip = xshell_zip(&[
            ("conn/folder.json", folder1),
            ("conn/sub/folder.json", folder2),
            (
                "conn/web_connect_config.json",
                &finalshell_config_json("web1", "10.1.0.1", ""),
            ),
            // Defaults: no port/user/name → 22 / root / host.
            (
                "conn/db_connect_config.json",
                "{\"host\":\"10.1.0.2\",\"conection_type\":100}",
            ),
            // Deleted, non-SSH and junk entries are skipped.
            (
                "conn/deleted_connect_config.json",
                "{\"host\":\"10.1.0.3\",\"conection_type\":100,\"delete_time\":5}",
            ),
            (
                "conn/rdp_connect_config.json",
                "{\"host\":\"10.1.0.4\",\"conection_type\":200}",
            ),
            ("conn/readme.txt", "ignore me"),
        ]);
        let sessions = parse_finalshell(&zip).unwrap();
        assert_eq!(sessions.len(), 2);
        let web = &sessions[0];
        assert_eq!(web.name, "web1");
        assert_eq!(web.host, "10.1.0.1");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        // Nested folder.json files chain into a group path.
        assert_eq!(web.group_path, vec!["Prod", "Web"]);
        assert_eq!(web.description, "primary");
        // FinalShell passwords stay encrypted in the source: no material,
        // flagged in the preview.
        assert_eq!(web.auth, ImportedAuth::Password { has_secret: false });
        assert_eq!(web.secret_note, SECRET_NOTE_ENCRYPTED);
        assert_eq!(sessions[1].name, "10.1.0.2");
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].username, "root");
        assert!(sessions[1].group_path.is_empty());
    }

    #[test]
    fn finalshell_bare_json_fallback_and_fail_closed() {
        // A single connection object and an array both work without a ZIP.
        let single = finalshell_config_json("solo", "10.1.1.1", "");
        let sessions = parse_finalshell(single.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].host, "10.1.1.1");
        let array = format!("[{single},{{\"host\":\"10.1.1.2\",\"conection_type\":100}}]");
        let sessions = parse_finalshell(array.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 2);
        // Neither ZIP nor JSON → readable failure.
        let error = parse_finalshell(b"definitely not a zip and not json").unwrap_err();
        assert!(error.contains("neither a ZIP"), "unexpected error: {error}");
        // JSON scalar is rejected.
        assert!(parse_finalshell(b"42").is_err());
        // ZIP with folders but no connections fails.
        let zip = xshell_zip(&[("conn/folder.json", "{\"id\":\"f1\",\"name\":\"Prod\"}")]);
        let error = parse_finalshell(&zip).unwrap_err();
        assert!(
            error.contains("*_connect_config.json"),
            "unexpected error: {error}"
        );
        // Malformed entries inside a ZIP degrade to skipped, not fatal.
        let zip = xshell_zip(&[
            ("conn/bad_connect_config.json", "{not json"),
            (
                "conn/good_connect_config.json",
                "{\"host\":\"10.1.2.1\",\"conection_type\":100}",
            ),
            ("conn/missing_id_folder.json", "{\"name\":\"broken\"}"),
        ]);
        let sessions = parse_finalshell(&zip).unwrap();
        assert_eq!(sessions.len(), 1);
    }

    #[test]
    fn finalshell_group_chain_breaks_on_cycles() {
        let folder_a = "{\"id\":\"f1\",\"name\":\"A\",\"parent_id\":\"f2\"}";
        let folder_b = "{\"id\":\"f2\",\"name\":\"B\",\"parent_id\":\"f1\"}";
        let zip = xshell_zip(&[
            ("conn/folder.json", folder_a),
            ("conn/sub/folder.json", folder_b),
            (
                "conn/c_connect_config.json",
                "{\"host\":\"10.1.3.1\",\"conection_type\":100,\"parent_id\":\"f1\"}",
            ),
        ]);
        let sessions = parse_finalshell(&zip).unwrap();
        assert_eq!(sessions.len(), 1);
        // The loop bound stops the f1→f2→f1 cycle after one pass each.
        assert_eq!(sessions[0].group_path, vec!["B", "A"]);
        // "root" and "0" parent ids mean the top level.
        let zip = xshell_zip(&[
            ("conn/folder.json", folder_a),
            ("conn/sub/folder.json", folder_b),
            (
                "conn/r_connect_config.json",
                "{\"host\":\"10.1.3.2\",\"conection_type\":100,\"parent_id\":\"root\"}",
            ),
        ]);
        let sessions = parse_finalshell(&zip).unwrap();
        assert!(sessions[0].group_path.is_empty());
    }

    // -- Electerm -----------------------------------------------------------

    const ELECTERM_BOOKMARK: &str = concat!(
        "{",
        "\"id\":\"bm1\",\"title\":\"web\",\"host\":\"10.2.0.1\",\"port\":2222,",
        "\"username\":\"deploy\",\"auth_type\":\"password\",\"type\":\"ssh\"",
        "}"
    );

    #[test]
    fn electerm_array_bookmarks_with_defaults() {
        let json = format!(
            "[{ELECTERM_BOOKMARK},{{\"id\":\"bm2\",\"host\":\"10.2.0.2\",\"type\":\"SSH\"}}]"
        );
        let sessions = parse_electerm(json.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 2);
        let web = &sessions[0];
        assert_eq!(web.name, "web");
        assert_eq!(web.host, "10.2.0.1");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        // Electerm bookmarks carry no credential material: password bookmarks
        // keep the kind with the not-carried note.
        assert_eq!(web.auth, ImportedAuth::Password { has_secret: false });
        assert_eq!(web.secret_note, SECRET_NOTE_NOT_CARRIED);
        assert!(web.group_path.is_empty());
        // Defaults: no port → 22, no user → root, no title → host, no
        // auth_type → no auth at all.
        assert_eq!(sessions[1].name, "10.2.0.2");
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].username, "root");
        assert_eq!(sessions[1].auth, ImportedAuth::None);
        assert_eq!(sessions[1].secret_note, "");
    }

    #[test]
    fn electerm_object_form_resolves_group_paths() {
        let json = json!({
            "bookmarks": [
                { "id": "bm1", "title": "edge", "host": "10.2.1.1", "type": "ssh", "port": 22 },
                { "id": "bm2", "title": "hidden", "host": "10.2.1.2", "type": "ssh", "enable_ssh": false },
                { "id": "bm3", "title": "serial", "host": "COM3", "type": "serial" },
                { "id": "bm4", "title": "badport", "host": "10.2.1.4", "type": "ssh", "port": 70000 },
            ],
            "bookmarkGroups": [
                { "id": "g1", "title": "Prod", "bookmarkIds": [], "bookmarkGroupIds": ["g2"] },
                { "id": "g2", "title": "Web", "bookmarkIds": ["bm1"], "bookmarkGroupIds": [] },
            ],
        })
        .to_string();
        let sessions = parse_electerm(json.as_bytes()).unwrap();
        // hidden (enable_ssh=false), serial (type) and badport (out-of-range
        // port) are skipped.
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "edge");
        // bm1 lives in the child group (Web), whose parent is Prod: the path
        // walks bookmarkGroupIds parent chains bottom-up.
        assert_eq!(sessions[0].group_path, vec!["Prod", "Web"]);
        assert_eq!(sessions[0].auth, ImportedAuth::None);
    }

    #[test]
    fn electerm_group_cycles_stop_and_malformed_fails_closed() {
        let json = json!({
            "bookmarks": [{ "id": "bm1", "host": "10.2.2.1", "type": "ssh" }],
            "bookmarkGroups": [
                { "id": "g1", "title": "A", "bookmarkIds": ["bm1"], "bookmarkGroupIds": ["g2"] },
                { "id": "g2", "title": "B", "bookmarkIds": [], "bookmarkGroupIds": ["g1"] },
            ],
        })
        .to_string();
        let sessions = parse_electerm(json.as_bytes()).unwrap();
        assert_eq!(sessions[0].group_path, vec!["B", "A"]);

        assert!(parse_electerm(b"not json").is_err());
        // An object without a bookmarks array and a scalar both fail closed.
        assert!(parse_electerm(b"{\"bookmarkGroups\":[]}").is_err());
        assert!(parse_electerm(b"42").is_err());
        // Broken entries inside the array are skipped instead of fatal.
        let json = json!([
            { "host": "10.2.2.2", "type": "ssh" },          // no id → ok, id is optional
            { "id": "x", "type": "sftp", "host": "10.2.2.3" }, // wrong type
            "junk",
        ])
        .to_string();
        let sessions = parse_electerm(json.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].host, "10.2.2.2");
    }

    // -- Termius ------------------------------------------------------------

    const TERMIUS_EXPORT: &str = concat!(
        "{",
        "\"data\":{",
        "\"hosts\":[",
        "{\"id\":\"h1\",\"label\":\"web\",\"address\":\"10.3.0.1\",",
        "\"group\":{\"id\":\"g2\"},\"ssh_config\":{\"id\":\"c1\"}},",
        "{\"id\":\"h2\",\"address\":\"10.3.0.2\"}",
        "],",
        "\"groups\":[",
        "{\"id\":\"g1\",\"label\":\"Prod\",\"parent\":null},",
        "{\"id\":\"g2\",\"label\":\"Web\",\"parent\":{\"id\":\"g1\"}}",
        "],",
        "\"ssh_configs\":[{\"id\":\"c1\",\"port\":2222,\"identity\":{\"id\":\"i1\"}}],",
        "\"identities\":[",
        "{\"id\":\"i1\",\"username\":\"deploy\",\"password\":\"plain-pw\"},",
        "{\"id\":\"i2\",\"username\":\"ops\",\"password\":\"BAAAAAAA0123456789012345678901234567890123456789\"}",
        "],",
        "\"keys\":[",
        "{\"id\":\"k1\",\"label\":\"key1\",\"privateKey\":\"-----BEGIN OPENSSH PRIVATE KEY-----\\nabc\\n-----END OPENSSH PRIVATE KEY-----\",\"passphrase\":\"key-phr\"}",
        "]",
        "}",
        "}",
    );

    #[test]
    fn termius_export_maps_hosts_configs_identities_groups() {
        let sessions = parse_termius(TERMIUS_EXPORT.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 2);
        let web = &sessions[0];
        assert_eq!(web.name, "web");
        assert_eq!(web.host, "10.3.0.1");
        // Port and identity resolve through the ssh_config reference.
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        // Plaintext identity password becomes metadata only, no note.
        assert_eq!(web.auth, ImportedAuth::Password { has_secret: true });
        assert_eq!(web.secret_note, "");
        assert_eq!(web.group_path, vec!["Prod", "Web"]);
        // Defaults: no label → host, no group/config → 22 / root / no group.
        assert_eq!(sessions[1].name, "10.3.0.2");
        assert_eq!(sessions[1].port, 22);
        assert_eq!(sessions[1].username, "root");
        assert!(sessions[1].group_path.is_empty());
    }

    #[test]
    fn termius_encrypted_blobs_are_dropped_and_pem_keys_are_carried() {
        // Identity i2 holds an encrypted sync blob for a password.
        let hosts_with_identity = TERMIUS_EXPORT.replace(
            "\"id\":\"h2\",\"address\":\"10.3.0.2\"",
            "\"id\":\"h2\",\"address\":\"10.3.0.2\",\"identity\":{\"id\":\"i2\"},\
             \"ssh_key\":{\"id\":\"k1\"}",
        );
        let sessions = parse_termius(hosts_with_identity.as_bytes()).unwrap();
        let encrypted = &sessions[1];
        // The blob is never decoded: password semantics without material
        // plus the encrypted note.
        assert_eq!(encrypted.username, "ops");
        assert_eq!(encrypted.auth, ImportedAuth::Password { has_secret: false });
        assert_eq!(encrypted.secret_note, SECRET_NOTE_ENCRYPTED);

        // An identity with an ssh_key reference reports key-auth metadata only;
        // PEM content and its passphrase never enter the preview model.
        let key_only = TERMIUS_EXPORT
            .replace(
                "\"id\":\"i2\",\"username\":\"ops\",\"password\":\"BAAAAAAA0123456789012345678901234567890123456789\"",
                "\"id\":\"i2\",\"username\":\"ops\",\"password\":\"\",\"ssh_key\":{\"id\":\"k1\"}",
            )
            .replace(
                "\"id\":\"h2\",\"address\":\"10.3.0.2\"",
                "\"id\":\"h2\",\"address\":\"10.3.0.2\",\"identity\":{\"id\":\"i2\"}",
            );
        let sessions = parse_termius(key_only.as_bytes()).unwrap();
        match &sessions[1].auth {
            ImportedAuth::PrivateKey { path, has_secret } => {
                assert!(path.is_none());
                assert!(*has_secret);
            }
            other => panic!("expected private key auth, got {other:?}"),
        }
        assert_eq!(sessions[1].secret_note, "");
    }

    #[test]
    fn termius_malformed_input_fails_closed() {
        assert!(parse_termius(b"not json").is_err());
        assert!(parse_termius(b"{\"data\":{}}").is_err());
        assert!(parse_termius(b"{\"hosts\":\"nope\"}").is_err());
        assert!(parse_termius(b"[]").is_err());
        // Broken host entries are skipped, not fatal.
        let hosts = json!({
            "hosts": [
                { "id": "h1", "address": "" },
                { "id": "h2", "address": "10.3.1.2" },
                "junk",
            ]
        })
        .to_string();
        let sessions = parse_termius(hosts.as_bytes()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].host, "10.3.1.2");
    }

    #[test]
    fn termius_helpers_edge_cases() {
        // The blob heuristic matches the NyaTerm importer's shape check.
        assert!(is_termius_encrypted_blob(
            "BAAAAAAA0123456789012345678901234567890123456789"
        ));
        assert!(!is_termius_encrypted_blob("BA"));
        assert!(!is_termius_encrypted_blob(
            "BAAAAAAA012345678901234567890123456789012345678!"
        ));
        assert!(!is_termius_encrypted_blob("plain password"));
    }

    // -- Sanitized export ----------------------------------------------------

    fn sample_sessions() -> Vec<ImportedSession> {
        vec![
            ImportedSession {
                name: "web".to_string(),
                host: "10.0.0.1".to_string(),
                port: 22,
                username: "root".to_string(),
                group_path: vec!["Prod".to_string()],
                description: String::new(),
                auth: ImportedAuth::Password { has_secret: true },
                secret_note: String::new(),
            },
            ImportedSession {
                name: "keyed".to_string(),
                host: "10.0.0.2".to_string(),
                port: 2222,
                username: "ops".to_string(),
                group_path: Vec::new(),
                description: "d".to_string(),
                auth: ImportedAuth::PrivateKey {
                    path: Some("/home/u/key".to_string()),
                    has_secret: true,
                },
                secret_note: String::new(),
            },
        ]
    }

    #[test]
    fn parsed_preview_auth_never_retains_plaintext_credentials() {
        let sessions_json = json!([{
            "session": {
                "protocol": "SSH",
                "target": "root@10.2.0.1",
                "autoLogin": json!({ "PasswordEnabled": true, "Password": "do-not-retain" }).to_string(),
            }
        }])
        .to_string();
        let sessions = parse_windterm(sessions_json.as_bytes(), None, None).unwrap();
        let rendered = format!("{:?}", sessions[0]);
        assert!(!rendered.contains("do-not-retain"), "{rendered}");
        let exported = normalized_export("windterm", &sessions, &[0])
            .unwrap()
            .to_string();
        assert!(!exported.contains("do-not-retain"), "{exported}");
    }

    #[test]
    fn parsers_reject_session_counts_before_building_an_unbounded_preview_vec() {
        let mut text = String::from("[Bookmarks]\n");
        for index in 0..=MAX_PREVIEW_SESSIONS {
            text.push_str(&format!("s{index}=#109#0%10.0.0.1%22%root%\n"));
        }
        let error = parse_moba_ini(&text).expect_err("oversized preview must fail closed");
        assert!(error.contains("session limit"), "{error}");

        let entries = (0..=MAX_PREVIEW_SESSIONS)
            .map(|index| (format!("Xshell/Sessions/s{index}.xsh"), WEB_XSH.to_string()))
            .collect::<Vec<_>>();
        let refs = entries
            .iter()
            .map(|(name, body)| (name.as_str(), body.as_str()))
            .collect::<Vec<_>>();
        let error = parse_xshell(&xshell_zip(&refs))
            .expect_err("ZIP preview must fail before a giant session Vec");
        assert!(error.contains("session limit"), "{error}");
    }

    #[test]
    fn normalized_export_never_contains_password_or_key_material() {
        let sessions = sample_sessions();
        let exported = normalized_export("windterm", &sessions, &[0, 1]).unwrap();
        let rendered = exported.to_string();
        assert!(rendered.contains("schemaVersion"));
        assert!(rendered.contains("/home/u/key"));
        assert!(rendered.contains("\"hasSecret\":true"));
        assert!(rendered.contains("\"keyPath\":\"/home/u/key\""));
        assert!(!rendered.contains("\"password\":"));
        assert!(!rendered.contains("\"privateKey\":"));
        assert!(!rendered.contains("\"passphrase\":"));
        assert_eq!(exported["sessions"][0]["auth"]["kind"], "password");
        assert_eq!(exported["sessions"][0]["auth"]["hasSecret"], true);
        assert!(exported["sessions"][0]["auth"].get("password").is_none());
    }

    // -- Streaming preview protocol -----------------------------------------

    #[test]
    fn startup_removes_legacy_import_store_without_exposing_its_contents() {
        let dir = std::env::temp_dir().join(format!("dbx-import-migrate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("imported-connections.json");
        std::fs::write(&legacy, r#"{"password":"do-not-leak"}"#).unwrap();
        assert!(remove_legacy_store(&dir).is_ok());
        assert!(!legacy.exists());
        assert!(
            remove_legacy_store(&dir).is_ok(),
            "missing legacy files are ignored"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn preview_start_enforces_task_and_process_memory_budgets() {
        let stream = ImportStream::default();
        for _ in 0..MAX_IMPORT_TASKS {
            stream
                .start(&json!({ "kind": "moba", "mainSize": 0 }))
                .unwrap();
        }
        assert!(stream
            .start(&json!({ "kind": "moba", "mainSize": 0 }))
            .is_err());
        let bounded = ImportStream::default();
        assert!(bounded
            .start(&json!({ "kind": "moba", "mainSize": MAX_IMPORT_MEMORY_BYTES + 1 }))
            .is_err());
    }

    #[test]
    fn repeated_start_cancel_releases_every_slot_without_spawning_workers() {
        let stream = ImportStream::default();
        for _ in 0..MAX_IMPORT_TASKS * 32 {
            let task = stream
                .start(&json!({ "kind": "moba", "mainSize": 1 }))
                .unwrap();
            let task_id = task["taskId"].as_str().unwrap();
            assert!(stream.cancel(task_id));
        }
        assert_eq!(stream.active_task_count(), 0);
        assert_eq!(stream.reserved_bytes(), 0);
    }

    #[test]
    fn start_lazily_reclaims_expired_tasks_before_enforcing_limits() {
        let stream = ImportStream::default();
        for _ in 0..MAX_IMPORT_TASKS {
            stream
                .start(&json!({ "kind": "moba", "mainSize": 1 }))
                .unwrap();
        }
        assert!(stream.expire_before(Instant::now() + IMPORT_TASK_TTL));
        assert_eq!(stream.active_task_count(), 0);
        assert!(stream
            .start(&json!({ "kind": "moba", "mainSize": 1 }))
            .is_ok());
    }

    #[test]
    fn expired_preview_is_removed_before_next_operation() {
        let stream = ImportStream::default();
        let task = stream
            .start(&json!({ "kind": "moba", "mainSize": 1 }))
            .unwrap();
        let id = task["taskId"].as_str().unwrap();
        assert!(stream.expire_before(std::time::Instant::now() + IMPORT_TASK_TTL));
        assert!(stream.finish(id).is_err());
    }

    #[test]
    fn streaming_preview_requires_contiguous_offsets_and_cleans_up_on_failure() {
        let stream = ImportStream::default();
        let started = stream
            .start(&json!({ "kind": "moba", "mainSize": 4 }))
            .unwrap();
        let task_id = started["taskId"].as_str().unwrap();
        assert_eq!(started["chunkSize"], IMPORT_CHUNK_LIMIT);
        let mut first = 0u64.to_be_bytes().to_vec();
        first.extend_from_slice(b"[Boo");
        assert_eq!(stream.append(task_id, "main", &first).unwrap(), 4);
        let mut wrong = 3u64.to_be_bytes().to_vec();
        wrong.extend_from_slice(b"x");
        assert!(stream.append(task_id, "main", &wrong).is_err());
        assert!(!stream.cancel(task_id));
    }

    #[test]
    fn streaming_preview_finishes_with_sanitized_rows_and_discards_source() {
        let text = b"[Bookmarks]\nweb=#109#0%10.6.0.1%22%root%\n";
        let stream = ImportStream::default();
        let started = stream
            .start(&json!({ "kind": "moba", "mainSize": text.len() }))
            .unwrap();
        let task_id = started["taskId"].as_str().unwrap();
        let mut frame = 0u64.to_be_bytes().to_vec();
        frame.extend_from_slice(text);
        assert_eq!(
            stream.append(task_id, "main", &frame).unwrap(),
            text.len() as u64
        );
        let preview = stream.finish(task_id).unwrap();
        assert_eq!(preview["sessions"][0]["name"], "web");
        assert_eq!(preview["sessions"][0]["groupPath"], "");
        assert!(!preview.to_string().contains("password"));
        assert!(stream.finish(task_id).is_err());
    }

    #[test]
    fn windterm_helpers_edge_cases() {
        // Target splitting keeps multi-@ users intact and trims spaces.
        assert_eq!(
            split_windterm_target(" user@mail.com @ host "),
            ("user@mail.com".to_string(), "host".to_string())
        );
        assert_eq!(
            split_windterm_target("only-host"),
            (String::new(), "only-host".to_string())
        );
        // Ports arrive as numbers or strings; junk falls back to 22.
        assert_eq!(windterm_port(Some(&json!(2222))), 2222);
        assert_eq!(windterm_port(Some(&json!("2222"))), 2222);
        assert_eq!(windterm_port(Some(&json!("nope"))), 22);
        assert_eq!(windterm_port(Some(&json!(0))), 22);
        assert_eq!(windterm_port(None), 22);
        // Fingerprint salt: hex decodes, junk stays raw bytes.
        assert_eq!(fingerprint_bytes("0xa1b2"), vec![0xa1, 0xb2]);
        assert_eq!(fingerprint_bytes("A1B2"), vec![0xa1, 0xb2]);
        assert_eq!(fingerprint_bytes("salt!"), b"salt!".to_vec());
        // Config flags are lenient.
        assert!(config_flag_is_on(&json!(true)));
        assert!(config_flag_is_on(&json!("true")));
        assert!(config_flag_is_on(&json!(1)));
        assert!(!config_flag_is_on(&json!(false)));
        assert!(!config_flag_is_on(&json!("off")));
        // Home prefix expansion without HOME keeps the path verbatim.
        assert_eq!(expand_home_prefix("relative/id_rsa"), "relative/id_rsa");
    }
}
