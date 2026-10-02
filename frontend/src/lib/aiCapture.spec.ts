// TailCapture 环形采集单测（Warp AI 对齐批）：软上限裁剪与快照语义。
import { describe, expect, it } from "vitest";
import { TailCapture } from "./aiCapture";

describe("TailCapture", () => {
  it("reset 清零，append 累计", () => {
    const capture = new TailCapture();
    capture.append("abc");
    capture.append("def");
    expect(capture.raw()).toBe("abcdef");
    capture.reset();
    expect(capture.raw()).toBe("");
  });

  it("超过软上限时从头裁到 trimTo（保留尾部）", () => {
    const capture = new TailCapture(100, 40);
    capture.append("x".repeat(90));
    capture.append("y".repeat(30));
    const raw = capture.raw();
    expect(raw.length).toBeLessThanOrEqual(70 + 1); // 90+30>100 → 裁到尾 40，再 +30
    expect(raw.endsWith("y".repeat(30))).toBe(true);
    expect(raw.startsWith("x")).toBe(true);
  });

  it("空 chunk 不改状态", () => {
    const capture = new TailCapture();
    capture.append("");
    expect(capture.raw()).toBe("");
  });
});
