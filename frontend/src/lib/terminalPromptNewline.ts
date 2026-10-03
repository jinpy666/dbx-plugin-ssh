// Prompt-newline fix (issue t8y2/dbx#10750): command output that does not end
// with a newline used to leave the next remote prompt glued to the tail of the
// output ("…}futianliang@localhost ~ $"). FinalShell/WindTerm-style terminals
// move the prompt to a fresh line instead.
//
// The sidecar arms a per-prompt OSC 7 hook on every interactive shell session
// (bash PROMPT_COMMAND / zsh precmd, see `directory_tracking_script`), so a
// `ESC]7;file://…BEL` frame arrives immediately before every prompt draw. This
// transformer keys the fix off exactly that frame: when one lands and the
// visible output is not at a line start, a CRLF is spliced in ahead of it.
//
// The stream passes through BYTE-FOR-BYTE — the parser never decodes UTF-8 and
// only ever inserts 0x0D 0x0A — because the same bytes also feed the zmodem
// display path and trzsz announce sniffing. Escape sequences are skipped
// opaquely (CSI, OSC, charset designators), which both keeps the at-line-start
// tracking honest (invisible sequences never flip it) and prevents a `]7;`
// inside another OSC payload (e.g. a `633;P;Cwd=…` path containing "]7;") from
// being mistaken for a prompt signal.
//
// Without the hook (fish/nushell, command sessions, hosts where arming failed)
// no OSC 7 frames ever arrive, so the transformer degrades to an identity
// passthrough — same contract as the optional shell-integration features.

/** Frames longer than this are flushed fail-open instead of waiting forever. */
const CARRY_LIMIT_BYTES = 8 * 1024;

const CRLF = new Uint8Array([0x0d, 0x0a]);

const ESC = 0x1b;
const BEL = 0x07;

/** Scanner states: ground text, inside CSI, inside OSC, at/after ESC. */
type ScannerMode = "ground" | "escape" | "csi" | "osc";

export interface PromptNewlinePushOptions {
  /**
   * Track the stream but never insert: alternate-screen apps (vim/top redraw
   * with absolute positioning) and binary transfer displays must not receive
   * spurious line feeds. Frames still pass through untouched.
   */
  suppressInsert?: boolean;
}

export class PromptNewlineTransformer {
  /** True while the next visible output would land at column 0. */
  private atLineStart = true;
  /** Incomplete escape sequence tail waiting for the next chunk. */
  private carry: Uint8Array = new Uint8Array(0);

  push(data: Uint8Array, options: PromptNewlinePushOptions = {}): Uint8Array {
    if (data.length === 0 && this.carry.length === 0) return data;
    const combined = this.carry.length > 0 ? concat(this.carry, data) : data;
    const pieces: Uint8Array[] = [];
    let emit = 0;
    let inserted = false;
    let mode: ScannerMode = "ground";
    // Offset of the ESC byte that started the sequence currently being
    // scanned; -1 in ground mode. The single source of truth for carrying an
    // incomplete sequence over to the next chunk.
    let escapeStart = -1;
    // While inside an OSC, whether its payload is the prompt signal (ESC]7;).
    let oscIsPromptSignal = false;
    let i = 0;

    while (i < combined.length) {
      const byte = combined[i];
      if (mode === "ground") {
        if (byte === ESC) {
          escapeStart = i;
          mode = "escape";
          i += 1;
          continue;
        }
        if (byte === 0x0a || byte === 0x0d) {
          this.atLineStart = true;
        } else if (byte >= 0x20 && byte !== 0x7f) {
          this.atLineStart = false;
        }
        i += 1;
        continue;
      }
      if (mode === "escape") {
        if (byte === 0x5d) {
          // OSC: classify once the 4-byte prefix is available; hold anything
          // shorter for the next chunk.
          if (combined.length - escapeStart < 4) break;
          oscIsPromptSignal = combined[i + 1] === 0x37 /* '7' */ && combined[i + 2] === 0x3b /* ';' */;
          mode = "osc";
          i += 1;
          continue;
        }
        if (byte === 0x5b) {
          mode = "csi";
          i += 1;
          continue;
        }
        // Two-byte escapes (ESC 7/8/c/=/> …): intermediates 0x20–0x2F may run
        // longer (ESC ( B charset designators), then one final byte.
        while (i < combined.length && combined[i] >= 0x20 && combined[i] <= 0x2f) i += 1;
        if (i >= combined.length) break;
        i += 1;
        mode = "ground";
        escapeStart = -1;
        continue;
      }
      if (mode === "csi") {
        // Parameters 0x30–0x3F and intermediates 0x20–0x2F, then one final
        // byte 0x40–0x7E. CSI never flips the line-start flag in this model —
        // real cursor addressing belongs to alternate-screen apps, which run
        // with suppressInsert anyway.
        while (i < combined.length && combined[i] >= 0x20 && combined[i] <= 0x3f) i += 1;
        if (i >= combined.length) break;
        // Final byte ends the sequence; anything else is malformed — consume
        // one byte and resynchronize instead of sticking forever.
        i += 1;
        mode = "ground";
        escapeStart = -1;
        continue;
      }
      // mode === "osc": scan for the BEL or ST (ESC \) terminator.
      if (byte === BEL) {
        if (oscIsPromptSignal && !options.suppressInsert && !this.atLineStart) {
          pieces.push(combined.subarray(emit, escapeStart));
          pieces.push(CRLF);
          emit = escapeStart;
          inserted = true;
        }
        i += 1;
        mode = "ground";
        escapeStart = -1;
        continue;
      }
      if (byte === ESC && i + 1 < combined.length && combined[i + 1] === 0x5c) {
        if (oscIsPromptSignal && !options.suppressInsert && !this.atLineStart) {
          pieces.push(combined.subarray(emit, escapeStart));
          pieces.push(CRLF);
          emit = escapeStart;
          inserted = true;
        }
        i += 2;
        mode = "ground";
        escapeStart = -1;
        continue;
      }
      i += 1;
    }

    if (mode !== "ground") {
      // Incomplete sequence: emit the scanned prefix, carry the sequence bytes
      // over and finish them against the next chunk.
      if (emit < escapeStart) pieces.push(combined.subarray(emit, escapeStart));
      this.carry = combined.slice(escapeStart);
      if (this.carry.length > CARRY_LIMIT_BYTES) {
        // Fail-open: an unterminated multi-KB "sequence" is binary noise, not
        // a prompt signal. Flush it so the stream can never stall. (A frame
        // this long was never completed, so nothing was inserted yet.)
        this.carry = new Uint8Array(0);
        // The flushed bytes were never scanned as ground; a kilobyte of
        // unparsed content overwhelmingly means visible output.
        this.atLineStart = false;
        return combined;
      }
      return pieces.length > 0 ? concatAll(pieces) : new Uint8Array(0);
    }

    this.carry = new Uint8Array(0);
    if (!inserted) return combined;
    if (emit < combined.length) pieces.push(combined.subarray(emit));
    return concatAll(pieces);
  }

  reset(): void {
    this.atLineStart = true;
    this.carry = new Uint8Array(0);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}

function concatAll(pieces: Uint8Array[]): Uint8Array {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    merged.set(piece, offset);
    offset += piece.length;
  }
  return merged;
}
