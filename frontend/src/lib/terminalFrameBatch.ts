/**
 * Terminal output frame coalescing (issue #302).
 *
 * The sidecar emits one binary frame per SSH packet with no batching; during
 * an output burst (build logs, ffmpeg, large `cat`) the per-frame middleware
 * chain — zmodem sentry byte scan, trzsz filter, OSC parsers, ANSI stripping —
 * saturates the main thread before xterm's write throttle ever sees the bytes.
 * This planner merges consecutive data frames into single segments so the
 * whole chain runs once per drain instead of once per packet. Stream-2 control
 * frames (JSON state) are never merged and keep their order relative to the
 * data around them; frames with different stream values never mix.
 *
 * Byte cap bounds the merged segment: a cap-sized first frame still passes
 * through as-is (cap only forces a split between frames), so a burst larger
 * than the cap arrives as consecutive capped segments without copying per
 * frame. Single-frame segments reference the original payload — zero copy on
 * the quiet path.
 */

export interface TerminalFrameItem {
  stream: number;
  data: Uint8Array;
}

export interface TerminalFrameSegment {
  stream: number;
  data: Uint8Array;
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

export function mergeTerminalFrames(items: readonly TerminalFrameItem[], maxMergedBytes: number): TerminalFrameSegment[] {
  const segments: TerminalFrameSegment[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let pendingStream: number | null = null;
  const flush = () => {
    if (!pending.length || pendingStream === null) return;
    segments.push({ stream: pendingStream, data: pending.length === 1 ? pending[0] : concatBytes(pending, pendingBytes) });
    pending = [];
    pendingBytes = 0;
    pendingStream = null;
  };
  for (const item of items) {
    const splits = pendingStream !== null && (item.stream !== pendingStream || (pendingBytes > 0 && pendingBytes + item.data.byteLength > maxMergedBytes));
    if (splits) flush();
    pendingStream = item.stream;
    pending.push(item.data);
    pendingBytes += item.data.byteLength;
  }
  flush();
  return segments;
}
