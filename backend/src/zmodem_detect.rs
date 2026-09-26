//! ZMODEM trigger detection on the SSH PTY output path (issue #90).
//!
//! Pure byte-stream state machine, no I/O: it recognizes the ZMODEM
//! session-start sentinel `ZPAD ZPAD ZDLE framin` (`2A 2A 18` + one framing
//! byte) and classifies headers whose frame type is ZRQINIT (0x00) — the
//! sequence a remote `sz` emits to open a download. On a hit the caller is
//! expected to stop publishing the affected bytes to the terminal and surface
//! a user-visible hint instead; the protocol itself is NOT answered (no
//! ZMODEM implementation here — supporting real transfers would be a separate
//! feature).
//!
//! Wire facts this module is built on (verified against lrzsz 0.12.20 source,
//! `src/zmodem.h` + `src/zm.c`):
//! - Framing bytes: `'A'` = ZBIN (crc16), `'B'` = ZHEX, `'C'` = ZBIN32.
//! - Frame types: ZRQINIT = 0x00, ZRINIT = 0x01; a hex header carries the
//!   type as two ASCII hex digits right after the framing byte, a binary
//!   header as one raw byte.
//! - lrzsz `sz` sends its first ZRQINIT — and every retry — via `zshhdr`
//!   (ZHEX): `**\x18B` + `"00"` + 12 hex chars (4 header bytes + crc16) +
//!   `0x0D 0x8A` + `0x11` (XON). It retries every 10s and gives up after
//!   ~30s (`READLINE_PF(100)`, 3 tries), so the suppression window (40s)
//!   covers the whole retry life before resetting.
//! - lrzsz `rz` opens with a hex ZRINIT (`**\x18B01…`): that must reach the
//!   frontend zmodem sentry untouched, because the rz upload flow is a
//!   shipped feature. Only ZRQINIT triggers; every other frame type passes.
//!
//! The detector is a streaming filter: a sentinel — or the header that
//! follows it — may be split across arbitrary chunk boundaries (the terminal
//! pump hands it whatever bytes the channel delivered), so partial
//! candidates are carried between `feed` calls.

/// How long a detection suppresses further ZRQINIT frames. sz gives up after
/// ~30s (3 x 10s retries); 40s covers the whole lifecycle plus the trailing
/// error text, then the filter returns to pass-through so a later `rz` still
/// works without any manual reset.
pub const SUPPRESS_WINDOW_MS: u64 = 40_000;

/// Hex chars that follow the type digits in a hex header: 4 data bytes +
/// crc16, i.e. the run dropped after a ZRQINIT classification.
const HEX_HEADER_REST_MAX: usize = 12;
/// Binary header payload after the framing byte: type(1) + 4 data bytes +
/// crc16 (ZBIN) / crc32 (ZBIN32), counted in ZDLE-escape-aware units. Used
/// to bound the drop scan after a binary ZRQINIT.
const BINARY_HEADER_UNITS_ZBIN: usize = 6;
const BINARY_HEADER_UNITS_ZBIN32: usize = 8;

const ZDLE: u8 = 0x18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Pass-through; every byte is scanned for the sentinel.
    Idle,
    /// A ZRQINIT was seen: matching headers are dropped silently until the
    /// wall-clock window expires. Other frame types (e.g. a ZRINIT from
    /// `rz`) keep passing through.
    Suppressed { until_ms: u64 },
}

/// Continuation of a hex ZRQINIT header that was cut by a chunk boundary
/// mid-run: `hex_left` digits are still expected, then the optional
/// `0x0D 0x8A/0x0A` + `0x11` trailer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingDrop {
    None,
    HexRun { hex_left: usize },
}

/// Outcome of feeding one PTY output chunk through the detector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedOutcome {
    /// Bytes that may be published to the terminal (header runs removed).
    pub clean: Vec<u8>,
    /// True exactly on the Idle → Suppressed transition, i.e. once per
    /// detected `sz` attempt — callers emit one notification per session.
    pub detected: bool,
}

#[derive(Debug)]
pub struct Detector {
    mode: Mode,
    pending_drop: PendingDrop,
    /// Bytes held back because they may be the start of a sentinel split
    /// across the chunk boundary (never more than sentinel + type digits).
    carry: Vec<u8>,
}

impl Default for Detector {
    fn default() -> Self {
        Self::new()
    }
}

impl Detector {
    pub fn new() -> Self {
        Self {
            mode: Mode::Idle,
            pending_drop: PendingDrop::None,
            carry: Vec::new(),
        }
    }

    /// Feed one chunk of PTY output at wall-clock `now_ms`.
    pub fn feed(&mut self, chunk: &[u8], now_ms: u64) -> FeedOutcome {
        if let Mode::Suppressed { until_ms } = self.mode {
            if now_ms >= until_ms {
                self.mode = Mode::Idle;
            }
        }
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let mut out: Vec<u8> = Vec::with_capacity(buf.len());
        let mut copied = 0usize; // buf[..copied] has been resolved into `out`
        let mut i = 0usize; // scan cursor
        let mut detected = false;
        let mut hold: Option<usize> = None;

        if self.pending_drop != PendingDrop::None {
            i = self.consume_hex_run_tail(&buf, 0);
            copied = i;
            self.pending_drop = PendingDrop::None;
        }

        while i < buf.len() {
            let Some(rel) = buf[i..].iter().position(|&b| b == b'*') else {
                break;
            };
            let star = i + rel;
            if star > copied {
                out.extend_from_slice(&buf[copied..star]);
                copied = star;
            }
            let remaining = buf.len() - star;
            if remaining < 4 {
                // Not even a full sentinel: hold for the next chunk.
                hold = Some(star);
                break;
            }
            if buf[star + 1] != b'*' || buf[star + 2] != ZDLE {
                i = star + 1;
                continue;
            }
            match buf[star + 3] {
                b'B' => {
                    if remaining < 6 {
                        hold = Some(star);
                        break;
                    }
                    let Some(frame_type) = hex_pair(buf[star + 4], buf[star + 5]) else {
                        // `**\x18B` followed by non-hex: not a ZMODEM header.
                        // Keep scanning; the bytes flow through as text.
                        i = star + 1;
                        continue;
                    };
                    if frame_type != 0 {
                        // ZRINIT (rz), ZSINIT, ZFILE, …: pass through
                        // untouched — the frontend sentry owns those flows.
                        i = star + 6;
                        continue;
                    }
                    if self.mode == Mode::Idle {
                        detected = true;
                        self.mode = Mode::Suppressed {
                            until_ms: now_ms.saturating_add(SUPPRESS_WINDOW_MS),
                        };
                    }
                    // Drop the type digits plus the rest of the hex run and
                    // the CRLF/XON trailer when present in this chunk.
                    i = star + 6;
                    let mut dropped = 0usize;
                    while i < buf.len()
                        && dropped < HEX_HEADER_REST_MAX
                        && buf[i].is_ascii_hexdigit()
                    {
                        i += 1;
                        dropped += 1;
                    }
                    let mut header_done = true;
                    if i < buf.len() {
                        if buf[i] == 0x0D {
                            i += 1;
                            if i < buf.len() && (buf[i] == 0x8A || buf[i] == 0x0A) {
                                i += 1;
                            }
                        }
                        if i < buf.len() && buf[i] == 0x11 {
                            i += 1;
                        }
                    } else {
                        // The chunk ended inside the header — inside the
                        // digit run, or between the run and the trailer:
                        // carry the drop over so the continuation is
                        // swallowed too (hex_left may be 0, meaning only
                        // the CRLF/XON trailer is pending).
                        header_done = false;
                    }
                    if !header_done {
                        self.pending_drop = PendingDrop::HexRun {
                            hex_left: HEX_HEADER_REST_MAX - dropped,
                        };
                    }
                    copied = i;
                }
                framing @ (b'A' | b'C') => {
                    if remaining < 5 {
                        hold = Some(star);
                        break;
                    }
                    if buf[star + 4] != 0x00 {
                        // Binary header of another type: pass intact.
                        i = star + 5;
                        continue;
                    }
                    if self.mode == Mode::Idle {
                        detected = true;
                        self.mode = Mode::Suppressed {
                            until_ms: now_ms.saturating_add(SUPPRESS_WINDOW_MS),
                        };
                    }
                    // Drop the rest of the binary header (4 data bytes +
                    // crc), honouring ZDLE escaping (a 0x18 swallows the
                    // byte after it). A cut inside this tail leaks at most a
                    // few control bytes — binary ZRQINIT senders re-send a
                    // full header on retry anyway.
                    i = star + 5;
                    let units = if framing == b'C' {
                        BINARY_HEADER_UNITS_ZBIN32
                    } else {
                        BINARY_HEADER_UNITS_ZBIN
                    };
                    let mut dropped = 0usize;
                    while i < buf.len() && dropped < units {
                        i += if buf[i] == ZDLE && i + 1 < buf.len() {
                            2
                        } else {
                            1
                        };
                        dropped += 1;
                    }
                    copied = i;
                }
                _ => {
                    i = star + 1;
                }
            }
        }

        match hold {
            Some(start) => {
                if start > copied {
                    out.extend_from_slice(&buf[copied..start]);
                }
                self.carry = buf[start..].to_vec();
            }
            None => {
                if copied < buf.len() {
                    out.extend_from_slice(&buf[copied..]);
                }
            }
        }
        FeedOutcome {
            clean: out,
            detected,
        }
    }

    /// Consume a hex ZRQINIT header continuation starting at `from`:
    /// up to `hex_left` digits, then the optional CRLF/XON trailer.
    fn consume_hex_run_tail(&mut self, buf: &[u8], from: usize) -> usize {
        let PendingDrop::HexRun { hex_left } = self.pending_drop else {
            return from;
        };
        let mut i = from;
        let mut left = hex_left;
        while i < buf.len() && left > 0 && buf[i].is_ascii_hexdigit() {
            i += 1;
            left -= 1;
        }
        if left > 0 && i == buf.len() {
            // Still inside the digit run: keep waiting for the rest.
            self.pending_drop = PendingDrop::HexRun { hex_left: left };
            return i;
        }
        if left == 0 && i == buf.len() {
            // Digits complete but the chunk ended before the trailer: keep
            // waiting for it instead of eating a later chunk's first byte.
            self.pending_drop = PendingDrop::HexRun { hex_left: 0 };
            return i;
        }
        if i < buf.len() && buf[i] == 0x0D {
            i += 1;
            if i < buf.len() && (buf[i] == 0x8A || buf[i] == 0x0A) {
                i += 1;
            }
        }
        if i < buf.len() && buf[i] == 0x11 {
            i += 1;
        }
        i
    }
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    let high = (high as char).to_digit(16)?;
    let low = (low as char).to_digit(16)?;
    Some((high * 16 + low) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// lrzsz `zshhdr(ZRQINIT, …)` as captured on the wire: sentinel + hex
    /// type "00" + 4 zero fields + crc16 "0000" + CRLF(0x0D 0x8A) + XON.
    fn hex_zrqinit() -> Vec<u8> {
        let mut bytes = b"**\x18B00".to_vec();
        bytes.extend_from_slice(b"000000000000");
        bytes.extend_from_slice(&[0x0D, 0x8A, 0x11]);
        bytes
    }

    /// lrzsz `rz` opening header: hex ZRINIT ("01").
    fn hex_zrinit() -> Vec<u8> {
        let mut bytes = b"**\x18B01".to_vec();
        bytes.extend_from_slice(b"00000023be50");
        bytes.extend_from_slice(&[0x0D, 0x8A, 0x11]);
        bytes
    }

    #[test]
    fn hex_zrqinit_triggers_and_is_suppressed_in_one_frame() {
        let mut detector = Detector::new();
        let mut data = b"before ".to_vec();
        data.extend_from_slice(&hex_zrqinit());
        data.extend_from_slice(b" after");
        let outcome = detector.feed(&data, 1_000);
        assert!(outcome.detected);
        assert_eq!(outcome.clean, b"before  after".to_vec());
    }

    #[test]
    fn sentinel_split_across_chunk_boundaries_is_detected_without_leaks() {
        let full = hex_zrqinit();
        for cut in [2usize, 4, 5, 6, 7, 10, 14, 18] {
            let mut detector = Detector::new();
            let mut detected_any = false;
            let mut collected = Vec::new();
            for (index, piece) in [&full[..cut], &full[cut..]].into_iter().enumerate() {
                let outcome = detector.feed(piece, 1_000 + index as u64);
                detected_any |= outcome.detected;
                collected.extend_from_slice(&outcome.clean);
            }
            assert!(detected_any, "cut at {cut} must still detect");
            assert_eq!(
                collected,
                Vec::<u8>::new(),
                "cut at {cut} must not leak bytes"
            );
            // The suppression state persists after the split.
            let outcome = detector.feed(&hex_zrqinit(), 1_100);
            assert!(!outcome.detected);
            assert!(outcome.clean.is_empty());
        }
    }

    #[test]
    fn rz_zrinit_passes_through_byte_identical_without_detection() {
        let mut detector = Detector::new();
        let mut data = b"rz\r\n".to_vec();
        data.extend_from_slice(&hex_zrinit());
        let outcome = detector.feed(&data, 1_000);
        assert!(!outcome.detected);
        assert_eq!(outcome.clean, data);
    }

    #[test]
    fn binary_zbin32_zrqinit_triggers() {
        let mut detector = Detector::new();
        // ZPAD ZPAD ZDLE 'C' + type 0x00 + 4 zero data bytes + 4 crc bytes.
        let mut data = b"**\x18C\x00".to_vec();
        data.extend_from_slice(&[0u8; 8]);
        let outcome = detector.feed(&data, 1_000);
        assert!(outcome.detected);
        assert!(outcome.clean.is_empty());
    }

    #[test]
    fn binary_zbin_zrinit_passes_through() {
        let mut detector = Detector::new();
        // ZPAD ZDLE 'A' + ZRINIT(0x01) + data + crc16.
        let data = [b"*\x18A\x01\x00\x00\x00\x00".as_slice(), &[0xBE, 0x50]].concat();
        let outcome = detector.feed(&data, 1_000);
        assert!(!outcome.detected);
        assert_eq!(outcome.clean, data);
    }

    #[test]
    fn suppressed_mode_drops_retries_but_passes_plain_text_and_expires() {
        let mut detector = Detector::new();
        assert!(detector.feed(&hex_zrqinit(), 1_000).detected);
        // sz retries the same header every 10s: silent, no new event.
        let outcome = detector.feed(&hex_zrqinit(), 11_000);
        assert!(!outcome.detected);
        assert!(outcome.clean.is_empty());
        // sz's eventual error text and the shell prompt stay visible.
        let outcome = detector.feed(b"sz: giving up\r\n$ ", 12_000);
        assert_eq!(outcome.clean, b"sz: giving up\r\n$ ".to_vec());
        // A ZRINIT arriving inside the window (user starts rz right away)
        // must still pass so the upload flow keeps working.
        let outcome = detector.feed(&hex_zrinit(), 13_000);
        assert_eq!(outcome.clean, hex_zrinit());
        // After the window the detector is back to pass-through + scanning.
        let outcome = detector.feed(&hex_zrqinit(), 1_000 + SUPPRESS_WINDOW_MS + 1);
        assert!(outcome.detected);
        assert!(outcome.clean.is_empty());
    }

    #[test]
    fn plain_text_with_asterisks_passes_unchanged() {
        let mut detector = Detector::new();
        let text = b"git 2**3=6\n**bold**\x18\n*not zmodem*\nok\n".to_vec();
        let outcome = detector.feed(&text, 1_000);
        assert!(!outcome.detected);
        assert_eq!(outcome.clean, text);
        // Same text must survive arbitrary chunk splits.
        let mut detector = Detector::new();
        let mut merged = Vec::new();
        for piece in [&text[..9], &text[9..17], &text[17..]] {
            merged.extend_from_slice(&detector.feed(piece, 1_000).clean);
        }
        assert_eq!(merged, text);
    }

    #[test]
    fn non_zrqinit_hex_types_pass_untouched() {
        let mut detector = Detector::new();
        for type_digits in ["02", "03", "ff"] {
            let mut data = b"**\x18B".to_vec();
            data.extend_from_slice(type_digits.as_bytes());
            data.extend_from_slice(b"000000000000");
            data.extend_from_slice(&[0x0D, 0x8A, 0x11]);
            let outcome = detector.feed(&data, 1_000);
            assert!(!outcome.detected, "type {type_digits} must not trigger");
            assert_eq!(outcome.clean, data);
        }
    }

    #[test]
    fn trailing_partial_candidate_is_carried_not_dropped() {
        let mut detector = Detector::new();
        // A chunk ending in `*` must not lose that byte: it may become a
        // sentinel with the next chunk — or turn out to be plain text.
        let outcome = detector.feed(b"done *", 1_000);
        assert_eq!(outcome.clean, b"done ".to_vec());
        let outcome = detector.feed(b"* done\n", 1_001);
        assert_eq!(outcome.clean, b"** done\n".to_vec());
    }
}
