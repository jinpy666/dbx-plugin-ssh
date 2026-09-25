import { describe, expect, it } from "vitest";
import { hasLossyChars, hasWireEscapes, sanitizeNameEncoding } from "./sftpName";

describe("sanitizeNameEncoding", () => {
  it("keeps whitelist values", () => {
    expect(sanitizeNameEncoding("auto")).toBe("auto");
    expect(sanitizeNameEncoding("latin-1")).toBe("latin-1");
  });

  it("falls back to auto for junk", () => {
    expect(sanitizeNameEncoding("gbk")).toBe("auto");
    expect(sanitizeNameEncoding(7)).toBe("auto");
    expect(sanitizeNameEncoding(undefined)).toBe("auto");
    // 自定义 fallback 用于设置草稿回填。
    expect(sanitizeNameEncoding("junk", "latin-1")).toBe("latin-1");
  });
});

describe("hasLossyChars", () => {
  it("detects replacement chars from lossy decoding", () => {
    expect(hasLossyChars("caf\uFFFD.txt")).toBe(true);
    expect(hasLossyChars("café.txt")).toBe(false);
    expect(hasLossyChars("")).toBe(false);
  });
});

describe("hasWireEscapes", () => {
  it("detects percent escapes on wire names", () => {
    expect(hasWireEscapes("caf%E9.txt")).toBe(true);
    expect(hasWireEscapes("a%ff")).toBe(true);
    expect(hasWireEscapes("100%.txt")).toBe(false);
    expect(hasWireEscapes("%2G")).toBe(false);
    expect(hasWireEscapes("café.txt")).toBe(false);
  });
});
