//! 纯校验逻辑（无引擎类型依赖，全部单测覆盖）：桌面尺寸门限、剪贴板
//! 整包拒绝门限与 JSON 分片预算切分。

use super::clipboard::CLIPBOARD_CHUNK_JSON_BUDGET;

/// NyaTerm's desktop-size acceptance range (lower bound); the upper bound is
/// the plugin-wide remote-desktop guard so patch payloads stay < 64 MiB.
pub(crate) const MIN_DESKTOP_WIDTH: u16 = 640;
pub(crate) const MIN_DESKTOP_HEIGHT: u16 = 480;
pub(crate) const MAX_DESKTOP_WIDTH: u16 = 3840;
pub(crate) const MAX_DESKTOP_HEIGHT: u16 = 2160;
/// Clipboard package bound (checklist §3-E: NyaTerm's 16 MiB, whole-package
/// rejection, never truncation).
pub(crate) const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;

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

pub(crate) fn json_escaped_len(text: &str) -> usize {
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
