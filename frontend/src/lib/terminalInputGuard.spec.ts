import { describe, expect, it } from "vitest";
import { inputTimeoutIndicatesStall } from "./terminalInputGuard";

describe("inputTimeoutIndicatesStall (#302)", () => {
  it("输出刚到达（宽限期内）时输入超时判为请求路径拥塞", () => {
    expect(inputTimeoutIndicatesStall(10_000, 11_000)).toBe(true);
    expect(inputTimeoutIndicatesStall(10_000, 11_999)).toBe(true);
  });

  it("输出停顿超过宽限期时按真实失联处理", () => {
    expect(inputTimeoutIndicatesStall(10_000, 12_000)).toBe(false);
    expect(inputTimeoutIndicatesStall(0, 100_000)).toBe(false);
  });
});
