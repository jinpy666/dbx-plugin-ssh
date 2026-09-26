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
});
