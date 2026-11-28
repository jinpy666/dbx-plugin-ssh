// @vitest-environment happy-dom
// 终态收尾等待器（评审 H-1 / issue #305 / 评审 H-3 语义回归守卫）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransferCompletionWatch } from "./transferCompletionWatch";

function mount(overrides?: Partial<{ pollStatus: (taskId: string) => Promise<boolean> }>) {
  const pollStatus = overrides?.pollStatus ?? vi.fn(async () => false);
  const watch = createTransferCompletionWatch({
    taskError: (taskId) => (taskId === "boom" ? "disk full" : undefined),
    statusLabel: (status) => `transferStatus.${status}`,
    pollStatus,
  });
  return { watch, pollStatus };
}

describe("transferCompletionWatch waitFor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately for an already-completed status without arming the watchdog", async () => {
    const { watch, pollStatus } = mount();
    await expect(watch.waitFor("t1", "completed")).resolves.toBeUndefined();
    expect(pollStatus).not.toHaveBeenCalled();
  });

  it("rejects already-terminal statuses with the transfer-cancelled code", async () => {
    const { watch } = mount();
    await expect(watch.waitFor("boom", "cancelled")).rejects.toMatchObject({ code: "transfer-cancelled", message: "disk full" });
    await expect(watch.waitFor("t1", "failed")).rejects.toMatchObject({ code: "transfer-terminal", message: "transferStatus.failed" });
  });

  it("keeps the waiter pending for live statuses", async () => {
    const { watch } = mount();
    let settled = false;
    void watch.waitFor("t1", "running").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
  });
});

describe("transferCompletionWatch settle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves the waiter on completed and ignores non-terminal statuses", async () => {
    const { watch } = mount();
    const done = watch.waitFor("t1", "running");
    watch.settle("t1", "running");
    watch.settle("t1", "staging");
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void done.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    watch.settle("t1", "completed");
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects with taskError fallback then the localized label and the right code", async () => {
    const { watch } = mount();
    const cancelled = watch.waitFor("boom", "running");
    const failed = watch.waitFor("t1", "running");
    watch.settle("boom", "cancelled");
    watch.settle("t1", "failed");
    await expect(cancelled).rejects.toMatchObject({ code: "transfer-cancelled", message: "disk full" });
    await expect(failed).rejects.toMatchObject({ code: "transfer-terminal", message: "transferStatus.failed" });
  });

  it("is idempotent: the second settle for the same task is a no-op", async () => {
    const { watch } = mount();
    const done = watch.waitFor("t1", "running");
    watch.settle("t1", "completed");
    await expect(done).resolves.toBeUndefined();
    expect(() => watch.settle("t1", "failed")).not.toThrow();
  });
});

describe("transferCompletionWatch watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles via the poll when the backend snapshot reports a terminal status", async () => {
    // pollStatus 契约 = 后端快照已入账并结算等待器（真实链路：pollTransferStatus
    // → applyTransferStatusSnapshot → completionWatch.settle），这里镜像它。
    const watch = createTransferCompletionWatch({
      taskError: () => undefined,
      statusLabel: (status) => `transferStatus.${status}`,
      pollStatus: async (taskId) => {
        watch.settle(taskId, "completed");
        return true;
      },
    });
    const done = watch.waitFor("t1", "running");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toBeUndefined();
  });

  it("re-arms through the backoff ladder when the task is still live", async () => {
    const { watch, pollStatus } = mount({ pollStatus: vi.fn(async () => false) });
    void watch.waitFor("t1", "running");
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 15_000);
    expect(pollStatus).toHaveBeenCalledTimes(5);
  });
});
