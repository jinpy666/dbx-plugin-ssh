import { describe, expect, it } from "vitest";
import { createTerminalWriteThrottle } from "./terminalWriteThrottle";

interface ManualScheduler {
  schedule: (callback: () => void) => number;
  run: () => void;
  cancel: (handle: unknown) => void;
  cancels: () => number;
}

function manualScheduler(): ManualScheduler {
  let callback: (() => void) | undefined;
  let cancelCount = 0;
  return {
    schedule(cb) {
      callback = cb;
      return 1;
    },
    run() {
      const cb = callback;
      callback = undefined;
      cb?.();
    },
    cancel() {
      cancelCount += 1;
      callback = undefined;
    },
    cancels: () => cancelCount,
  };
}

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

describe("createTerminalWriteThrottle", () => {
  it("coalesces consecutive writes into a single ordered sink call per frame", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
    });
    throttle.write(bytes("$ "));
    throttle.write(bytes("ls"));
    throttle.write(bytes("\r\n"));
    expect(delivered).toEqual([]);
    scheduler.run();
    expect(delivered).toEqual(["$ ls\r\n"]);
    expect(throttle.pending).toBe(false);
    expect(throttle.pendingBytes).toBe(0);
  });

  it("keeps byte-level order across the cap boundary and multiple frames", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      maxBufferBytes: 10,
    });
    throttle.write(bytes("aaaaa"));
    throttle.write(bytes("bbbbb")); // 10 bytes queued, still within cap
    throttle.write(bytes("ccccc")); // exceeds cap -> synchronous flush of queued
    expect(delivered).toEqual(["aaaaabbbbb"]);
    scheduler.run();
    expect(delivered).toEqual(["aaaaabbbbb", "ccccc"]);
  });

  it("flush() cancels the pending frame and delivers the merged payload exactly once", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    throttle.write(bytes("hello "));
    throttle.write(bytes("world"));
    throttle.flush();
    expect(delivered).toEqual(["hello world"]);
    expect(scheduler.cancels()).toBe(1);
    // Running the (cancelled) scheduled callback must not double-deliver.
    scheduler.run();
    expect(delivered).toEqual(["hello world"]);
    throttle.flush();
    expect(delivered).toEqual(["hello world"]);
  });

  it("dispose flushes remaining bytes and stops scheduling", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
    });
    throttle.write(bytes("tail"));
    throttle.dispose();
    expect(delivered).toEqual(["tail"]);
    scheduler.run();
    expect(delivered).toEqual(["tail"]);
    expect(throttle.pending).toBe(false);
  });

  it("does not call the sink for an empty queue", () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const throttle = createTerminalWriteThrottle({
      sink: () => {
        calls += 1;
      },
      schedule: scheduler.schedule,
      cancel: () => undefined,
    });
    throttle.write(new Uint8Array(0));
    throttle.flush();
    expect(calls).toBe(0);
    expect(throttle.pending).toBe(false);
  });

  it("single chunks larger than the cap are delivered in one piece on the next frame", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      maxBufferBytes: 4,
    });
    throttle.write(bytes("0123456789"));
    expect(delivered).toEqual([]);
    scheduler.run();
    expect(delivered).toEqual(["0123456789"]);
  });

  // --- DECSET 2026 帧同步（WT-1）：hold 期缓冲、release 整批提交 ---
  it("setHold(true) pauses the pending frame; release commits the whole batch merged", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    throttle.write(bytes("part-1 "));
    throttle.setHold(true);
    // hold 前已排队的帧被取消，不会在同步窗内中途上屏。
    expect(throttle.held).toBe(true);
    expect(scheduler.cancels()).toBe(1);
    throttle.write(bytes("part-2 "));
    // 被取消的 rAF 回调不得触发交付（若误触发会撕裂帧同步窗口）。
    scheduler.run();
    throttle.write(bytes("part-3"));
    expect(delivered).toEqual([]);
    expect(throttle.pending).toBe(true);
    throttle.setHold(false);
    expect(delivered).toEqual(["part-1 part-2 part-3"]);
    expect(throttle.pending).toBe(false);
    expect(throttle.held).toBe(false);
  });

  it("a hold exceeding the byte cap is force-flushed in order and keeps buffering", () => {
    const scheduler = manualScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      maxBufferBytes: 10,
    });
    throttle.write(bytes("aaaaaa"));
    throttle.setHold(true);
    throttle.write(bytes("bbbbbb")); // 12 > cap 10：hold 期强制放行积压
    expect(delivered).toEqual(["aaaaaa"]);
    throttle.write(bytes("cc"));
    expect(delivered).toEqual(["aaaaaa"]);
    throttle.setHold(false);
    expect(delivered).toEqual(["aaaaaa", "bbbbbbcc"]);
    expect(throttle.pending).toBe(false);
  });

  it("setHold is idempotent and an empty release does not call the sink", () => {
    const scheduler = manualScheduler();
    let calls = 0;
    const throttle = createTerminalWriteThrottle({
      sink: () => {
        calls += 1;
      },
      schedule: scheduler.schedule,
      cancel: () => undefined,
    });
    throttle.setHold(true);
    throttle.setHold(true);
    throttle.setHold(false);
    throttle.setHold(false);
    expect(calls).toBe(0);
    expect(throttle.held).toBe(false);
    expect(throttle.pending).toBe(false);
  });

  it("writes during hold are not scheduled until release", () => {
    const scheduler = manualScheduler();
    let scheduled = 0;
    const throttle = createTerminalWriteThrottle({
      sink: () => undefined,
      schedule: (cb) => {
        scheduled += 1;
        return scheduler.schedule(cb);
      },
      cancel: () => undefined,
    });
    throttle.setHold(true);
    throttle.write(bytes("a"));
    throttle.write(bytes("b"));
    expect(scheduled).toBe(0);
    throttle.setHold(false);
    expect(scheduled).toBe(0);
    expect(throttle.pending).toBe(false);
  });

  // --- hold 截止时限（codex 卡死修复）：跨帧边界被切开的同步窗不得无限缓冲 ---
  function manualHoldScheduler() {
    let callback: (() => void) | undefined;
    let cancelCount = 0;
    return {
      schedule(cb: () => void) {
        callback = cb;
        return 1;
      },
      run() {
        const cb = callback;
        callback = undefined;
        cb?.();
      },
      cancel() {
        cancelCount += 1;
        callback = undefined;
      },
      cancels: () => cancelCount,
      armed: () => callback !== undefined,
    };
  }

  it("a hold stranded across a chunk boundary flushes at the deadline", () => {
    const scheduler = manualScheduler();
    const holdTimer = manualHoldScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      scheduleHold: holdTimer.schedule,
      cancelHold: holdTimer.cancel,
    });
    // Frame 1: codex draw whose `2026h` is flushed and parsed (hold engages
    // via the xterm CSI handler) but whose `2026l` lands in the next chunk.
    throttle.write(bytes("\x1b[?2026h\x1b[1;1Hhello"));
    scheduler.run();
    throttle.setHold(true);
    // Frame 2: the rest of the window incl. the release — queued, no frame
    // scheduled (held). Before the fix this waited for the 1MiB byte cap.
    throttle.write(bytes(" world\x1b[?2026l"));
    expect(delivered).toEqual(["\x1b[?2026h\x1b[1;1Hhello"]);
    expect(throttle.pending).toBe(true);
    expect(holdTimer.armed()).toBe(true);
    // Deadline: the stranded window renders instead of buffering. The first
    // batch is already out; the deadline delivers the queued remainder.
    holdTimer.run();
    expect(delivered).toEqual([
      "\x1b[?2026h\x1b[1;1Hhello",
      " world\x1b[?2026l",
    ]);
    expect(throttle.pending).toBe(false);
    // xterm parses the flushed batch; the release now flips the hold off and
    // the (already empty) flush is a no-op.
    throttle.setHold(false);
    expect(delivered).toHaveLength(2);
    expect(throttle.held).toBe(false);
  });

  it("an app stalled inside the mode keeps rendering at deadline cadence", () => {
    const scheduler = manualScheduler();
    const holdTimer = manualHoldScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      scheduleHold: holdTimer.schedule,
      cancelHold: holdTimer.cancel,
    });
    throttle.setHold(true);
    throttle.write(bytes("tick-1"));
    holdTimer.run();
    expect(delivered).toEqual(["tick-1"]);
    // Writes after a deadline flush re-arm the timer, so a permanently held
    // app still makes progress every deadline instead of one flush only.
    throttle.write(bytes("tick-2"));
    expect(holdTimer.armed()).toBe(true);
    holdTimer.run();
    expect(delivered).toEqual(["tick-1", "tick-2"]);
    throttle.setHold(false);
    // The last deadline already fired, so release has no timer left to cancel.
    expect(holdTimer.armed()).toBe(false);
    expect(delivered).toEqual(["tick-1", "tick-2"]);
  });

  it("a release arriving before the deadline still commits merged and cancels the timer", () => {
    const scheduler = manualScheduler();
    const holdTimer = manualHoldScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      scheduleHold: holdTimer.schedule,
      cancelHold: holdTimer.cancel,
    });
    throttle.setHold(true);
    throttle.write(bytes("part-1 "));
    throttle.write(bytes("part-2"));
    throttle.setHold(false);
    expect(delivered).toEqual(["part-1 part-2"]);
    // The deadline must not fire after the release consumed the queue.
    holdTimer.run();
    expect(delivered).toEqual(["part-1 part-2"]);
    expect(throttle.pending).toBe(false);
  });

  it("dispose clears the hold deadline without leaking the timer", () => {
    const scheduler = manualScheduler();
    const holdTimer = manualHoldScheduler();
    const delivered: string[] = [];
    const throttle = createTerminalWriteThrottle({
      sink: (data) => delivered.push(text(data)),
      schedule: scheduler.schedule,
      cancel: () => undefined,
      scheduleHold: holdTimer.schedule,
      cancelHold: holdTimer.cancel,
    });
    throttle.setHold(true);
    throttle.write(bytes("tail"));
    expect(holdTimer.armed()).toBe(true);
    throttle.dispose();
    expect(delivered).toEqual(["tail"]);
    expect(holdTimer.armed()).toBe(false);
    holdTimer.run();
    expect(delivered).toEqual(["tail"]);
  });
});
