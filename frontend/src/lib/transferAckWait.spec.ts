// @vitest-environment happy-dom
// 分片 ACK 阶梯轮询（issue #305 / issue #237 语义回归守卫）+ 等待器表的外部
// 结算契约（usePluginEvents 的 ACK/error 桥事件直接操作该表）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadAckWait } from "./transferAckWait";

function mount(overrides?: Partial<Parameters<typeof createUploadAckWait>[0]>) {
  const marked: string[] = [];
  const cleared: string[] = [];
  const ack = createUploadAckWait({
    markAckLagging: (taskId) => marked.push(taskId),
    clearAckLagging: (taskId) => cleared.push(taskId),
    taskError: (taskId) => (taskId === "boom" ? "disk full" : undefined),
    statusLabel: (status) => `transferStatus.${status}`,
    fetchStatus: overrides?.fetchStatus ?? vi.fn(async () => ({ transferred: 0, status: "running" })),
    ...overrides,
  });
  return { ack, marked, cleared };
}

describe("uploadAckWait ladder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves through the status poll once transferred reaches nextOffset", async () => {
    const { ack, cleared } = mount({ fetchStatus: vi.fn(async () => ({ transferred: 2048, status: "running" })) });
    const done = ack.waitForAck("t1", 2048);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(done).resolves.toBeUndefined();
    expect(cleared).toEqual(["t1"]);
  });

  it("rejects cancelled/failed snapshots with the transfer-cancelled code", async () => {
    const { ack } = mount({ fetchStatus: vi.fn(async () => ({ transferred: 0, status: "cancelled" })) });
    const done = ack.waitForAck("boom", 1024);
    // 先挂拒绝断言再推进时钟：结算发生在定时器回调里，后挂会漏接 rejection。
    const expectation = expect(done).rejects.toMatchObject({ code: "transfer-cancelled", message: "disk full" });
    await vi.advanceTimersByTimeAsync(3_000);
    await expectation;
  });

  it("retries through the ladder while the status query fails", async () => {
    const steps: Array<{ transferred: number; status: string } | Error> = [
      new Error("sidecar restarting"),
      { transferred: 512, status: "running" },
    ];
    const fetchStatus = vi.fn(async () => {
      const step = steps.shift() ?? new Error("sidecar restarting");
      if (step instanceof Error) throw step;
      return step;
    });
    const { ack } = mount({ fetchStatus });
    const done = ack.waitForAck("t1", 512);
    await vi.advanceTimersByTimeAsync(3_000 + 8_000);
    await expect(done).resolves.toBeUndefined();
  });

  it("marks ackLagging on each poll trigger and clears it on settlement", async () => {
    const steps: Array<{ transferred: number; status: string } | Error> = [
      { transferred: 0, status: "running" },
      { transferred: 8, status: "running" },
    ];
    const fetchStatus = vi.fn(async () => {
      const step = steps.shift() ?? new Error("sidecar restarting");
      if (step instanceof Error) throw step;
      return step;
    });
    const { ack, marked, cleared } = mount({ fetchStatus });
    const done = ack.waitForAck("t1", 8);
    await vi.advanceTimersByTimeAsync(3_000 + 8_000);
    await expect(done).resolves.toBeUndefined();
    expect(marked).toEqual(["t1", "t1"]);
    expect(cleared).toEqual(["t1"]);
  });
});

describe("uploadAckWait external settlement contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exposes the waiter map so bridge events can clearTimeout + delete + resolve", async () => {
    const { ack } = mount({ fetchStatus: vi.fn(async () => ({ transferred: 0, status: "running" })) });
    const done = ack.waitForAck("t1", 64);
    const waiter = ack.waiters.get("t1");
    expect(waiter?.nextOffset).toBe(64);
    window.clearTimeout(waiter!.timer);
    ack.waiters.delete("t1");
    waiter!.resolve();
    await expect(done).resolves.toBeUndefined();
  });
});
