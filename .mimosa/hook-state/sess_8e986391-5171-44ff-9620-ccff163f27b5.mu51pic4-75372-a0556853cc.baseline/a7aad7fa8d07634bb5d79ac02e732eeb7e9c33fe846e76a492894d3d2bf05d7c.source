/**
 * Coalesced terminal write scheduling (large-output rendering throttle).
 *
 * xterm.js's Terminal.write is asynchronous internally but still pays
 * per-call parse overhead; the sidecar streaming a big `cat`/build log emits
 * many small binary frames in quick succession, and writing each frame
 * straight through floods the parser. This helper buffers consecutive chunks
 * and hands xterm a single merged write per animation frame, preserving
 * chunk order exactly. A byte cap flushes synchronously once the queued
 * payload grows past it, so a sustained burst cannot balloon the buffer.
 */

export interface TerminalWriteThrottleOptions {
  /** Receives the merged payload (one call per flush, never re-entrant). */
  sink: (data: Uint8Array) => void;
  /** Schedules the deferred flush and returns a cancellable handle. Defaults to requestAnimationFrame (setTimeout 0 fallback). */
  schedule?: (callback: () => void) => unknown;
  /** Cancels a handle returned by `schedule`. */
  cancel?: (handle: unknown) => void;
  /** Flush synchronously once queued bytes exceed this cap (default 1 MiB). */
  maxBufferBytes?: number;
}

export interface TerminalWriteThrottle {
  /** Queue a chunk; flushed merged with its peers on the next frame. */
  write(data: Uint8Array): void;
  /** Cancel the pending frame and deliver queued bytes now. */
  flush(): void;
  /** Flush and stop scheduling; safe to call repeatedly. */
  dispose(): void;
  readonly pendingBytes: number;
  readonly pending: boolean;
}

const hasAnimationFrame = typeof requestAnimationFrame === "function";
const defaultSchedule = hasAnimationFrame
  ? (callback: () => void) => requestAnimationFrame(callback)
  : (callback: () => void) => setTimeout(callback, 0);
const defaultCancel = hasAnimationFrame
  ? (handle: unknown) => cancelAnimationFrame(handle as number)
  : (handle: unknown) => clearTimeout(handle as number);

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function createTerminalWriteThrottle(options: TerminalWriteThrottleOptions): TerminalWriteThrottle {
  const maxBufferBytes = options.maxBufferBytes ?? 1_048_576;
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let handle: unknown = null;
  let emitting = false;

  function emit() {
    handle = null;
    if (emitting || !queue.length) return;
    emitting = true;
    try {
      const data = mergeChunks(queue, queuedBytes);
      queue = [];
      queuedBytes = 0;
      options.sink(data);
    } finally {
      emitting = false;
    }
  }

  return {
    write(data: Uint8Array) {
      if (!data.byteLength) return;
      // A burst pushing the queue past the cap flushes synchronously first:
      // memory stays bounded and chunk order is preserved.
      if (handle !== null && queuedBytes + data.byteLength > maxBufferBytes) emit();
      queue.push(data);
      queuedBytes += data.byteLength;
      if (handle === null) handle = schedule(emit);
    },
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      emit();
    },
    dispose() {
      this.flush();
    },
    get pendingBytes() {
      return queuedBytes;
    },
    get pending() {
      return handle !== null || queue.length > 0;
    },
  };
}
