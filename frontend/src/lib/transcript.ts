/**
 * Transcript（M14，对标 iShell）：把录制事件流（asciicast `o` 事件的
 * eventdata）拼成纯文本。回放链已经把事件分页拉到前端（`ssh/recording/get`），
 * 故导出走前端纯函数 + 既有保存桥，不新增协议面。
 */

import type { ReplayEvent } from "./replayScheduler";

/** Input event: `ReplayEvent` plus the optional asciicast `type` carried by
 * page rows (`ssh/recording/get`); rows without `type` are output events. */
export type TranscriptEvent = ReplayEvent & { type?: string };

/**
 * Strips ANSI/OSC control sequences from raw terminal output so the
 * transcript is plain text: CSI (through the final byte @-~), OSC (through
 * BEL or ST), lone ESC (plus one following byte), CR dropped (asciicast
 * lines end `\r\n`; lone CR redraws collapse to their final state on the
 * next line). Unlike the search-side flattener, newlines are preserved
 * here — the transcript keeps the terminal's line layout.
 */
export function stripAnsiSequences(raw: string): string {
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const ch = raw[index]!;
    if (ch !== "\x1b") {
      if (ch !== "\r") out += ch;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === "[") {
      // CSI: params 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
      index += 2;
      while (index < raw.length && !/[\x40-\x7E]/.test(raw[index]!)) {
        index += 1;
      }
      index += 1;
    } else if (next === "]") {
      index += 2;
      while (index < raw.length && raw[index] !== "\x07" && raw[index] !== "\x1b") {
        index += 1;
      }
      if (raw[index] === "\x07") {
        index += 1;
      } else if (raw[index] === "\x1b" && raw[index + 1] === "\\") {
        index += 2;
      }
    } else {
      // Lone escape (or unknown two-byte sequence): drop ESC + one byte.
      index += next === undefined ? 1 : 2;
    }
  }
  return out;
}

/** Formats seconds as `[h:mm:ss]` for timestamped transcripts. */
export function formatTranscriptStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `[${hours}:${pad(minutes)}:${pad(secs)}]`;
}

/**
 * Builds the transcript text: stdout chunks concatenated in order (the
 * terminal's own line layout), ANSI stripped. With `timestamps` each event
 * chunk is prefixed at the start of a new line, so a burst spanning wrapped
 * lines is only stamped once. Always ends with a newline; empty recordings
 * produce an empty string.
 */
export function buildTranscript(
  events: readonly TranscriptEvent[],
  options: { timestamps?: boolean } = {},
): string {
  const timestamps = options.timestamps === true;
  let out = "";
  let atLineStart = true;
  for (const event of events) {
    if (event.type !== "o") continue;
    const text = stripAnsiSequences(event.data);
    if (!text) continue;
    if (timestamps) {
      const stamp = formatTranscriptStamp(event.time);
      out += stamp;
      atLineStart = false;
    }
    for (const ch of text) {
      if (atLineStart && timestamps && ch !== "\n") {
        // Fresh line after a stamp-less newline: re-stamp it.
        out += formatTranscriptStamp(event.time);
      }
      out += ch;
      atLineStart = ch === "\n";
    }
  }
  return out.endsWith("\n") || out === "" ? out : `${out}\n`;
}

/** Suggested transcript file name for a recording summary row. */
export function transcriptFileName(recordingId: string): string {
  return `${recordingId || "session"}.txt`;
}
