import { describe, expect, it } from "vitest";
import { displayPathToWire, hasLossyChars, hasWireEscapes, sanitizeNameEncoding } from "./sftpName";

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

describe("displayPathToWire", () => {
  it("passes ASCII paths through untouched", () => {
    expect(displayPathToWire("/home/user/uploads")).toBe("/home/user/uploads");
    expect(displayPathToWire("/")).toBe("/");
    expect(displayPathToWire("")).toBe("");
  });

  it("escapes latin-1 range chars as %XX and self-escapes %", () => {
    // é (U+00E9) → 0xE9 字节的转义形式（sidecar escape_wire 同款大写十六进制）。
    expect(displayPathToWire("/tmp/café")).toBe("/tmp/caf%E9");
    expect(displayPathToWire("naïve")).toBe("na%EFve");
    // '%' 自转义：字面 %XX 输入经 sidecar unescape_wire 还原不吞。
    expect(displayPathToWire("/tmp/100%.txt")).toBe("/tmp/100%25.txt");
    expect(displayPathToWire("a%41b")).toBe("a%2541b");
  });

  it("passes non-latin-1 chars through as UTF-8 fallback", () => {
    // >U+00FF 的字符与 sidecar latin1_encode_display 的 UTF-8 兜底一致。
    expect(displayPathToWire("/data/生产环境")).toBe("/data/生产环境");
    expect(displayPathToWire("/tmp/café/生产")).toBe("/tmp/caf%E9/生产");
  });
});
