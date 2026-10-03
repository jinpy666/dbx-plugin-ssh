//! ZMODEM trigger detection on the SSH PTY output path (issue #90).
//!
//! Pure byte-stream observer, no I/O: it recognizes the ZMODEM session-start
//! sentinel `ZPAD ZPAD ZDLE framin` (`2A 2A 18` + one framing byte) and
//! classifies headers whose frame type is ZRQINIT (0x00) — the sequence a
//! remote `sz` emits to open a download.
//!
//! The detector never modifies the stream. ZMODEM download is a shipped
//! feature (the frontend sentry, zmodem.js, consumes the protocol frames on
//! `ssh/terminal/out`), so every byte — ZRQINIT included — passes through to
//! the terminal path untouched. This module's only output is the boolean
//! `feed` result: exactly one hit per ZRQINIT lifecycle, which the caller
//! turns into the `ssh/zmodem` event (UX hint + observability).
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
//!   ~30s (`READLINE_PF(100)`, 3 tries), so the event window (40s) dedupes
//!   the whole retry lifecycle into a single event before resetting.
//! - lrzsz `rz` opens with a hex ZRINIT (`**\x18B01`): that never triggers —
//!   only ZRQINIT does — so the rz upload flow produces no event.
//!
//! The detector is a streaming filter: a sentinel — or the type digits that
//! follow it — may be split across arbitrary chunk boundaries (the terminal
//! pump hands it whatever bytes the channel delivered), so partial
//! candidates are carried between `feed` calls.

/// How long a detection mutes further ZRQINIT events. sz gives up after
/// ~30s (3 x 10s retries); 40s covers the whole lifecycle plus the trailing
/// error text, then the detector re-arms so a later `sz` fires again.
pub const EVENT_WINDOW_MS: u64 = 40_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Scanning for the sentinel; the next hit fires the event.
    Idle,
    /// A ZRQINIT was seen: further hits inside the wall-clock window are
    /// silent (sz retries the same header every 10s). Other frame types
    /// (e.g. a ZRINIT from `rz`) never trigger anyway.
    Detected { until_ms: u64 },
}

const ZDLE: u8 = 0x18;

/// Outcome of feeding one PTY output chunk through the detector. Bytes are
/// never held back from the caller — the result is purely the event edge.
#[derive(Debug)]
pub struct Detector {
    mode: Mode,
    /// Tail of the previous chunk that may be the start of a sentinel split
    /// across the chunk boundary (never more than `CANDIDATE_MAX - 1`).
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
            carry: Vec::new(),
        }
    }

    /// Feed one chunk of PTY output at wall-clock `now_ms`. Returns true
    /// exactly on the Idle → Detected transition, i.e. once per detected
    /// `sz` lifecycle — callers emit one notification per session.
    pub fn feed(&mut self, chunk: &[u8], now_ms: u64) -> bool {
        if let Mode::Detected { until_ms } = self.mode {
            if now_ms >= until_ms {
                self.mode = Mode::Idle;
            }
        }
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let mut i = 0usize; // scan cursor
        let mut detected = false;

        while i < buf.len() {
            let Some(rel) = buf[i..].iter().position(|&b| b == b'*') else {
                // No further candidate start in the tail: nothing to carry.
                break;
            };
            let star = i + rel;
            if self.candidate_cut_short(&buf, star) {
                // Not enough bytes to classify: hold for the next chunk.
                self.carry = buf[star..].to_vec();
                return detected;
            }
            if buf[star + 1] != b'*' || buf[star + 2] != ZDLE {
                i = star + 1;
                continue;
            }
            match buf[star + 3] {
                b'B' => {
                    let Some(frame_type) = hex_pair(buf[star + 4], buf[star + 5]) else {
                        // `**\x18B` followed by non-hex: not a ZMODEM header.
                        i = star + 1;
                        continue;
                    };
                    if frame_type == 0 {
                        detected |= self.mark(now_ms);
                    }
                    i = star + 6;
                }
                b'A' | b'C' => {
                    if buf[star + 4] == 0x00 {
                        detected |= self.mark(now_ms);
                    }
                    i = star + 5;
                }
                _ => {
                    i = star + 1;
                }
            }
        }
        detected
    }

    /// True when a candidate starting at `star` cannot be classified from
    /// this chunk alone even though at least 4 bytes remain: the hex form
    /// needs 6 bytes, the binary form 5.
    fn candidate_cut_short(&self, buf: &[u8], star: usize) -> bool {
        if buf.len() - star < 4 {
            return true;
        }
        if buf[star + 1] != b'*' || buf[star + 2] != ZDLE {
            return false;
        }
        match buf[star + 3] {
            b'B' => buf.len() - star < 6,
            b'A' | b'C' => buf.len() - star < 5,
            _ => false,
        }
    }

    /// One-shot edge: fire only when idle, then mute the window.
    fn mark(&mut self, now_ms: u64) -> bool {
        if self.mode != Mode::Idle {
            return false;
        }
        self.mode = Mode::Detected {
            until_ms: now_ms.saturating_add(EVENT_WINDOW_MS),
        };
        true
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

    /// Longest complete candidate: hex header = sentinel(3) + 'B' + 2 type
    /// digits; a binary candidate is one byte shorter. Bytes held back for a
    /// possible split candidate never exceed `CANDIDATE_MAX - 1`.
    const CANDIDATE_MAX: usize = 6;

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
    fn hex_zrqinit_triggers_once_per_lifecycle() {
        let mut detector = Detector::new();
        let mut data = b"before ".to_vec();
        data.extend_from_slice(&hex_zrqinit());
        data.extend_from_slice(b" after");
        assert!(detector.feed(&data, 1_000));
        assert!(!detector.feed(b"prompt $ ", 2_000));
    }

    #[test]
    fn sentinel_split_across_chunk_boundaries_is_detected() {
        let full = hex_zrqinit();
        for cut in [1usize, 2, 3, 4, 5, 6, 7, 10, 14, 18] {
            let mut detector = Detector::new();
            let detected = [&full[..cut], &full[cut..]]
                .into_iter()
                .enumerate()
                .fold(false, |acc, (index, piece)| {
                    acc | detector.feed(piece, 1_000 + index as u64)
                });
            assert!(detected, "cut at {cut} must still detect");
            // The window mutes the immediate retry after the split too.
            assert!(!detector.feed(&hex_zrqinit(), 1_100));
        }
    }

    #[test]
    fn rz_zrinit_never_triggers() {
        let mut detector = Detector::new();
        let mut data = b"rz\r\n".to_vec();
        data.extend_from_slice(&hex_zrinit());
        assert!(!detector.feed(&data, 1_000));
        // The rz flow keeps working right after a sz was detected.
        let mut detector = Detector::new();
        assert!(detector.feed(&hex_zrqinit(), 1_000));
        assert!(!detector.feed(&hex_zrinit(), 1_100));
    }

    #[test]
    fn binary_zbin32_zrqinit_triggers() {
        let mut detector = Detector::new();
        // ZPAD ZPAD ZDLE 'C' + type 0x00 + 4 zero data bytes + 4 crc bytes.
        let mut data = b"**\x18C\x00".to_vec();
        data.extend_from_slice(&[0u8; 8]);
        assert!(detector.feed(&data, 1_000));
    }

    #[test]
    fn binary_zbin_zrinit_passes_through() {
        let mut detector = Detector::new();
        // ZPAD ZDLE 'A' + ZRINIT(0x01) + data + crc16.
        let data = [b"*\x18A\x01\x00\x00\x00\x00".as_slice(), &[0xBE, 0x50]].concat();
        assert!(!detector.feed(&data, 1_000));
    }

    #[test]
    fn window_mutes_retries_then_re_arms() {
        let mut detector = Detector::new();
        assert!(detector.feed(&hex_zrqinit(), 1_000));
        // sz retries the same header every 10s: silent, no new event.
        assert!(!detector.feed(&hex_zrqinit(), 11_000));
        assert!(!detector.feed(&hex_zrinit(), 12_000));
        // After the window the detector is back to scanning.
        assert!(detector.feed(&hex_zrqinit(), 1_000 + EVENT_WINDOW_MS + 1));
    }

    #[test]
    fn plain_text_with_asterisks_never_triggers() {
        let mut detector = Detector::new();
        let text = b"git 2**3=6\n**bold**\x18\n*not zmodem*\nok\n".to_vec();
        assert!(!detector.feed(&text, 1_000));
        // Same text must not trigger across arbitrary chunk splits either.
        let mut detector = Detector::new();
        let mut detected = false;
        for piece in [&text[..9], &text[9..17], &text[17..]] {
            detected |= detector.feed(piece, 1_000);
        }
        assert!(!detected);
    }

    #[test]
    fn non_zrqinit_hex_types_pass_untouched() {
        let mut detector = Detector::new();
        for type_digits in ["02", "03", "ff"] {
            let mut data = b"**\x18B".to_vec();
            data.extend_from_slice(type_digits.as_bytes());
            data.extend_from_slice(b"000000000000");
            data.extend_from_slice(&[0x0D, 0x8A, 0x11]);
            assert!(
                !detector.feed(&data, 1_000),
                "type {type_digits} must not trigger"
            );
        }
    }

    #[test]
    fn trailing_partial_candidate_is_carried_and_completed() {
        // A chunk ending in `*` must not lose the candidate: it completes
        // with the next chunk.
        let mut detector = Detector::new();
        assert!(!detector.feed(b"done *", 1_000));
        assert!(detector.feed(&hex_zrqinit(), 1_001));
        // A cut inside the type digits is equally completed, not dropped.
        let full = hex_zrqinit();
        let mut detector = Detector::new();
        assert!(!detector.feed(&full[..5], 1_000));
        assert!(detector.feed(&full[5..], 1_001));
    }

    #[test]
    fn carry_stays_bounded_for_pathological_input() {
        let mut detector = Detector::new();
        // A chunk of pure sentinel prefixes must not grow the carry without
        // bound across many feeds.
        for n in 0..1000 {
            let _ = detector.feed(b"**\x18B0", n);
        }
        assert!(detector.carry.len() < CANDIDATE_MAX);
    }
}
