import { describe, expect, it } from "vitest";
import { looksBinary } from "./textSniff";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("looksBinary", () => {
  it("treats empty chunks as text", () => {
    expect(looksBinary(new Uint8Array())).toBe(false);
  });

  it("accepts plain ASCII and UTF-8 text", () => {
    expect(looksBinary(utf8("#!/bin/sh\necho hello\n"))).toBe(false);
    expect(looksBinary(utf8("配置文件:\n  端口: 8080\n"))).toBe(false);
  });

  it("accepts ANSI-colored log lines", () => {
    expect(looksBinary(utf8("\x1b[32mok\x1b[0m\n\x1b[31mfail\x1b[0m\n"))).toBe(false);
  });

  it("flags NUL bytes anywhere in the chunk", () => {
    const bytes = utf8("hello");
    const withNul = new Uint8Array([...bytes, 0, 1, 2]);
    expect(looksBinary(withNul)).toBe(true);
  });

  it("flags invalid UTF-8 payloads like PNG or compiled output", () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(looksBinary(new Uint8Array([0xcf, 0xf2, 0xed, 0xee, 0xfb, 0xfc, 0xfd]))).toBe(true);
  });

  it("tolerates the occasional stray control character in text", () => {
    const text = `${"ok line\n".repeat(200)}\x07${"more text\n".repeat(200)}`;
    expect(looksBinary(utf8(text))).toBe(false);
  });
});
