import { afterEach, describe, expect, it, vi } from "vitest";
import { reopenHostConnection } from "./hostReopen";

afterEach(() => vi.useRealTimers());

describe("reopenHostConnection", () => {
  it("uses the host API and waits for its acknowledgement", async () => {
    const reopenConnection = vi.fn().mockResolvedValue({ success: true });
    const request = vi.fn();
    expect(await reopenHostConnection({ reopenConnection, request }, "c1")).toBe(true);
    expect(reopenConnection).toHaveBeenCalledWith("c1");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the legacy bridge and reports host refusal", async () => {
    const request = vi.fn().mockResolvedValue({ success: false });
    expect(await reopenHostConnection({ request }, "c1")).toBe(false);
    expect(request).toHaveBeenCalledWith("host.reopenConnection", { connectionId: "c1" });
  });

  it("reports rejected and unanswered reopen requests", async () => {
    expect(await reopenHostConnection({ request: vi.fn().mockRejectedValue(new Error("method unavailable")) }, "c1")).toBe(false);
    vi.useFakeTimers();
    const pending = reopenHostConnection({ request: vi.fn().mockReturnValue(new Promise(() => undefined)) }, "c1", 25);
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe(false);
  });
});
