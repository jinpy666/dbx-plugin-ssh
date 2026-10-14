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
 *
 * `setHold` 是 DECSET 2026 同步渲染（synchronized output）的帧提交闸门：
 * hold 期间取消 rAF 定帧、写入继续入队但不定调度，release（setHold(false)）
 * 时把积压整批合并成一次提交——应用在 `CSI ? 2026 h`…`CSI ? 2026 l` 之间的
 * 中间帧不再逐帧上屏，撕裂与闪烁由此收敛。hold 也受同一字节上限约束：
 * 异常驻留同步态的应用在超限时被强制放行，内存不会无限膨胀。
 *
 * hold 截止时限（holdFlushDelayMs，默认 100ms，对标 WezTerm 的 sync 超时）：
 * PTY 读边界可能把一个同步窗切成两帧（`2026h` 落在上一帧尾、`2026l` 落在
 * 下一帧头）——release 此刻也被 hold 挡在队列里，若不定时放行，唯一出口是
 * 字节上限（codex 这类 30fps 小帧流要积到 1MiB 才触发，表现为终端长时间
 * "卡死"）。deadline 到点即整批放行：健康应用的同帧 h/l 对不受影响，异常
 * 驻留的停摆上限从"字节帽"收敛到一个 deadline。
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
  /** DECSET 2026 hold deadline in ms: a sync window buffered longer than this
   * flushes instead of waiting for the release or the byte cap (default 100). */
  holdFlushDelayMs?: number;
  /** Schedules the hold-deadline flush. Defaults to setTimeout. */
  scheduleHold?: (callback: () => void) => unknown;
  /** Cancels a handle returned by `scheduleHold`. */
  cancelHold?: (handle: unknown) => void;
}

export interface TerminalWriteThrottle {
  /** Queue a chunk; flushed merged with its peers on the next frame. */
  write(data: Uint8Array): void;
  /** Cancel the pending frame and deliver queued bytes now. */
  flush(): void;
  /**
   * DECSET 2026 frame sync: `true` pauses scheduled flushes (queued writes
   * keep accumulating), `false` commits everything buffered so far in one
   * merged call. A hold older than `holdFlushDelayMs` flushes on its own so
   * a release stranded behind the hold (chunk boundary split across frames)
   * cannot stall rendering until the byte cap. Idempotent; repeated values
   * are no-ops.
   */
  setHold(hold: boolean): void;
  /** Flush and stop scheduling; safe to call repeatedly. */
  dispose(): void;
  /** Whether frame sync is currently holding writes back. */
  readonly held: boolean;
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
  const holdFlushDelayMs = options.holdFlushDelayMs ?? 100;
  const scheduleHold = options.scheduleHold ?? ((callback: () => void) => setTimeout(callback, holdFlushDelayMs));
  const cancelHold = options.cancelHold ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let handle: unknown = null;
  let holdHandle: unknown = null;
  let emitting = false;
  let held = false;

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

  // One bounded escape hatch for a sync window that never sees its release on
  // the current batch (PTY read boundary split `2026h`/`2026l` across frames,
  // or an app stalled inside the mode): flush at the deadline instead of
  // buffering until the byte cap.
  function armHoldDeadline() {
    if (holdHandle !== null) return;
    holdHandle = scheduleHold(() => {
      holdHandle = null;
      emit();
    });
  }

  function disarmHoldDeadline() {
    if (holdHandle === null) return;
    cancelHold(holdHandle);
    holdHandle = null;
  }

  return {
    write(data: Uint8Array) {
      if (!data.byteLength) return;
      // A burst pushing the queue past the cap flushes synchronously first:
      // memory stays bounded and chunk order is preserved. The cap also bites
      // while held (no scheduled frame then), so a stuck sync mode degrades to
      // rendering instead of buffering without bound.
      if ((handle !== null || held) && queuedBytes + data.byteLength > maxBufferBytes) emit();
      queue.push(data);
      queuedBytes += data.byteLength;
      if (handle === null && !held) handle = schedule(emit);
      if (held) armHoldDeadline();
    },
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      emit();
    },
    setHold(next: boolean) {
      if (held === next) return;
      held = next;
      if (next) {
        // Pause the pending frame; queued writes wait for the release commit —
        // at most one holdFlushDelayMs, never indefinitely.
        if (handle !== null) {
          cancel(handle);
          handle = null;
        }
        armHoldDeadline();
      } else {
        disarmHoldDeadline();
        this.flush();
      }
    },
    dispose() {
      disarmHoldDeadline();
      this.flush();
    },
    get held() {
      return held;
    },
    get pendingBytes() {
      return queuedBytes;
    },
    get pending() {
      return handle !== null || queue.length > 0;
    },
  };
}
