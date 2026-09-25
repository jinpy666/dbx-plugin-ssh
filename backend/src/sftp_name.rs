//! SFTP 文件名编码层（M14-B）：显示解码与传输路径的硬分离。
//!
//! 契约（硬要求）：
//! - **传输路径**永远使用「wire 形式」——服务器路径字节的忠实载体（合法
//!   UTF-8 字节按字符透传，非法字节转义为 `%XX`）。显示层解码结果绝不回灌
//!   到传输路径。
//! - **显示层**才做解码：`auto` 先按 UTF-8，失败按 latin-1（ISO-8859-1，
//!   字节→同码位字符，解码永不失败）固定降级；仍不可表达时用替换符。
//!
//! 已知边界：上游 `russh-sftp` 在反序列化层对文件名做 `from_utf8_lossy`，
//! crate 路径拿到的 String 中非法字节已变成 U+FFFD（不可逆）。原始字节只能
//! 由 `sftp_raw` 的裸包客户端取得；本模块对 `&[u8]` 工作的所有函数都是纯函数，
//! 两条路径共用同一套语义。

/// 文件名显示解码偏好。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameEncoding {
    /// UTF-8 优先，无效字节按 latin-1 重试（默认）。
    Auto,
    /// 固定按 latin-1 解码（服务器端文件系统编码确知非 UTF-8 时选用）。
    Latin1,
}

impl NameEncoding {
    /// 偏好串 → 编码（白名单外返回 None，由 preferences 层拒绝/回退）。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "latin-1" => Some(Self::Latin1),
            _ => None,
        }
    }

    /// 序列化回偏好串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Latin1 => "latin-1",
        }
    }
}

/// 显示解码结果：`text` 只用于展示，`lossy` 标记展示文本无法忠实还原
/// 传输字节（例如 crate 路径早已把非法字节替换成 U+FFFD）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayName {
    pub text: String,
    pub lossy: bool,
}

/// ISO-8859-1 解码：每个字节映射到同码位字符。全字节域可解码，永不失败。
fn latin1_decode(raw: &[u8]) -> String {
    raw.iter().map(|&byte| byte as char).collect()
}

/// 按偏好解码原始文件名字节。`lossy` 仅在 auto 模式下解码失败且无法忠实
/// 还原时为 true（latin-1 全域可解码，结果总是忠实的）。
pub fn decode_display_name(raw: &[u8], encoding: NameEncoding) -> DisplayName {
    match encoding {
        NameEncoding::Auto => match std::str::from_utf8(raw) {
            Ok(text) => DisplayName {
                text: text.to_string(),
                lossy: false,
            },
            Err(_) => DisplayName {
                text: latin1_decode(raw),
                lossy: false,
            },
        },
        NameEncoding::Latin1 => DisplayName {
            text: latin1_decode(raw),
            lossy: false,
        },
    }
}

/// wire 字符串是否携带不可还原字节（上游 lossy 解码留下的 U+FFFD）。
pub fn is_lossy_wire(wire: &str) -> bool {
    wire.contains('\u{FFFD}')
}

/// 原始路径字节 → wire 字符串（传输形式）：合法 UTF-8 序列按字符透传，
/// 非法字节逐字节转义为 `%XX`（大写十六进制）。
pub fn escape_wire(raw: &[u8]) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let invalid_len = error.error_len().unwrap_or(rest.len() - valid);
                // from_utf8 保证 [..valid] 是合法 UTF-8。
                if let Ok(head) = std::str::from_utf8(&rest[..valid]) {
                    out.push_str(head);
                }
                for &byte in &rest[valid..valid + invalid_len] {
                    out.push_str(&format!("%{byte:02X}"));
                }
                rest = &rest[valid + invalid_len..];
                if rest.is_empty() {
                    break;
                }
            }
        }
    }
    out
}

/// wire 字符串是否携带 `%XX` 转义（决定传输是否需要走 raw 字节路径）。
pub fn has_wire_escapes(wire: &str) -> bool {
    let bytes = wire.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(index, &byte)| byte == b'%' && is_hex_pair(&bytes[index + 1..]))
}

/// wire 字符串 → 原始路径字节：`%XX` 还原为字节，其余字符按 UTF-8 编码。
/// 非转义位置的 `%`（后跟不足两个十六进制位）保持字面量。
pub fn unescape_wire(wire: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(wire.len());
    let bytes = wire.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && is_hex_pair(&bytes[index + 1..]) {
            let high = hex_digit(bytes[index + 1]);
            let low = hex_digit(bytes[index + 2]);
            out.push(high * 16 + low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    out
}

fn is_hex_pair(rest: &[u8]) -> bool {
    rest.len() >= 2 && rest[0].is_ascii_hexdigit() && rest[1].is_ascii_hexdigit()
}

fn hex_digit(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => byte - b'A' + 10,
    }
}

/// 目录 + wire 文件名 → 传输路径字符串（与 sftp_ext::join_remote_name 同语义）。
pub fn join_wire_name(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_parse_and_roundtrip() {
        assert_eq!(NameEncoding::parse("auto"), Some(NameEncoding::Auto));
        assert_eq!(NameEncoding::parse(" latin-1 "), Some(NameEncoding::Latin1));
        assert_eq!(NameEncoding::parse("LATIN-1"), Some(NameEncoding::Latin1));
        assert_eq!(NameEncoding::parse("gbk"), None);
        assert_eq!(NameEncoding::parse(""), None);
        assert_eq!(NameEncoding::Auto.as_str(), "auto");
        assert_eq!(NameEncoding::Latin1.as_str(), "latin-1");
    }

    #[test]
    fn decode_auto_passes_valid_utf8_through() {
        let decoded = decode_display_name("café.txt".as_bytes(), NameEncoding::Auto);
        assert_eq!(decoded.text, "café.txt");
        assert!(!decoded.lossy);
        // 多字节中文同样透传（合法 UTF-8 不触发降级）。
        let decoded = decode_display_name("生产环境.tar.gz".as_bytes(), NameEncoding::Auto);
        assert_eq!(decoded.text, "生产环境.tar.gz");
        assert!(!decoded.lossy);
    }

    #[test]
    fn decode_auto_falls_back_to_latin1() {
        // latin-1 编码的 "café"：0xE9 不是合法 UTF-8 起始 → 逐字节 latin-1。
        let raw = b"caf\xe9.txt";
        let decoded = decode_display_name(raw, NameEncoding::Auto);
        assert_eq!(decoded.text, "caf\u{e9}.txt");
        assert!(!decoded.lossy);
        // 强制 latin-1 结果一致。
        assert_eq!(decode_display_name(raw, NameEncoding::Latin1), decoded);
    }

    #[test]
    fn decode_latin1_forces_even_valid_utf8() {
        // latin-1 强制模式下合法 UTF-8 字节也按字节解码（服务器确知非 UTF-8）。
        let decoded = decode_display_name("café".as_bytes(), NameEncoding::Latin1);
        assert_eq!(decoded.text, "caf\u{c3}\u{a9}");
    }

    #[test]
    fn decode_empty_and_ascii() {
        let decoded = decode_display_name(b"", NameEncoding::Auto);
        assert_eq!(decoded.text, "");
        assert!(!decoded.lossy);
        let decoded = decode_display_name(b"plain.txt", NameEncoding::Latin1);
        assert_eq!(decoded.text, "plain.txt");
    }

    #[test]
    fn wire_lossy_marks_replacement_chars() {
        assert!(is_lossy_wire("caf\u{FFFD}.txt"));
        assert!(is_lossy_wire("a\u{FFFD}b"));
        assert!(!is_lossy_wire("café.txt"));
        assert!(!is_lossy_wire("clean"));
    }

    #[test]
    fn escape_wire_passes_clean_names_through() {
        assert_eq!(escape_wire(b"a.txt"), "a.txt");
        assert_eq!(escape_wire("café.txt".as_bytes()), "café.txt");
        assert_eq!(escape_wire("生产/环境".as_bytes()), "生产/环境");
        assert_eq!(escape_wire(b""), "");
    }

    #[test]
    fn escape_wire_percent_escapes_invalid_bytes() {
        // 单个非法字节。
        assert_eq!(escape_wire(b"caf\xe9.txt"), "caf%E9.txt");
        // 连续非法字节逐字节转义。
        assert_eq!(escape_wire(b"\xff\xfe"), "%FF%FE");
        // 混合合法与非法字节。
        assert_eq!(
            escape_wire(&b"caf\xc3\xa9_\xe9.bin"[..]),
            "caf\u{e9}_%E9.bin"
        );
        // 截断的 UTF-8 序列尾部按非法字节转义（不静默丢字节）。
        assert_eq!(escape_wire(&[0x61, 0xC3]), "a%C3");
    }

    #[test]
    fn unescape_wire_round_trips_escape_wire() {
        for raw in [
            &b"a.txt"[..],
            b"caf\xe9.txt",
            b"\xff\xfe\x80",
            "café/生产".as_bytes(),
            b"caf\xe9_\xc3\xa9.bin",
        ] {
            assert_eq!(unescape_wire(&escape_wire(raw)), raw);
        }
    }

    #[test]
    fn unescape_wire_keeps_literals_and_percent() {
        // 非转义位置的字面量与 % 原样保留。
        assert_eq!(unescape_wire("100%.txt"), b"100%.txt".to_vec());
        assert_eq!(unescape_wire("%2G"), b"%2G".to_vec());
        assert_eq!(unescape_wire("%2"), b"%2".to_vec());
        // 真实转义还原为字节。
        assert_eq!(unescape_wire("caf%E9.txt"), b"caf\xe9.txt".to_vec());
        // 转义不区分大小写。
        assert_eq!(unescape_wire("caf%e9.txt"), b"caf\xe9.txt".to_vec());
        assert_eq!(unescape_wire(""), Vec::<u8>::new());
    }

    #[test]
    fn has_wire_escapes_detects_only_real_escapes() {
        assert!(has_wire_escapes("caf%E9.txt"));
        assert!(has_wire_escapes("a%ff"));
        assert!(!has_wire_escapes("café.txt"));
        assert!(!has_wire_escapes("100%.txt"));
        assert!(!has_wire_escapes("%2G"));
        assert!(!has_wire_escapes("%2"));
        assert!(!has_wire_escapes(""));
    }

    #[test]
    fn join_wire_name_handles_root() {
        assert_eq!(join_wire_name("/", "a.txt"), "/a.txt");
        assert_eq!(join_wire_name("/tmp/up", "a.txt"), "/tmp/up/a.txt");
    }
}
