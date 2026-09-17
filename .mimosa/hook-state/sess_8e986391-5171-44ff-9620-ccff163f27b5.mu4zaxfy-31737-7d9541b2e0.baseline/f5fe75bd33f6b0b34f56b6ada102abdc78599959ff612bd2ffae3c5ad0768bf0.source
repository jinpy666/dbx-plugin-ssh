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
});
