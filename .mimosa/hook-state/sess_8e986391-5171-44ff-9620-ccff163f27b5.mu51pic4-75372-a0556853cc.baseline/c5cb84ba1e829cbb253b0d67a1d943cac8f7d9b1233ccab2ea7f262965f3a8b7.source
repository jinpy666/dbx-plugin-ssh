// requestEpoch 单测（UI_SCAN R3-P1-3）：单调请求序号——晚到的旧响应通过
// isCurrent 判假被整体丢弃，最新请求落地。
import { describe, expect, it } from "vitest";
import { createRequestEpoch } from "./requestEpoch";

describe("createRequestEpoch", () => {
  it("issues monotonically increasing ids", () => {
    const epoch = createRequestEpoch();
    const first = epoch.next();
    const second = epoch.next();
    expect(second).toBeGreaterThan(first);
  });

  it("accepts the latest request and rejects a stale one", () => {
    const epoch = createRequestEpoch();
    const stale = epoch.next();
    const current = epoch.next();
    expect(epoch.isCurrent(current)).toBe(true);
    expect(epoch.isCurrent(stale)).toBe(false);
  });

  it("rejects unknown ids", () => {
    const epoch = createRequestEpoch();
    expect(epoch.isCurrent(42)).toBe(false);
  });

  it("invalidates every earlier id when a newer request starts", () => {
    const epoch = createRequestEpoch();
    const a = epoch.next();
    const b = epoch.next();
    const c = epoch.next();
    expect(epoch.isCurrent(a)).toBe(false);
    expect(epoch.isCurrent(b)).toBe(false);
    expect(epoch.isCurrent(c)).toBe(true);
  });
});
