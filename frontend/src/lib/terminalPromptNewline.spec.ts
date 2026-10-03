import { describe, expect, it } from "vitest";
import { PromptNewlineTransformer } from "./terminalPromptNewline";

const ESC = "\u001b";
const BEL = "\u0007";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

const OSC7_BEL = `${ESC}]7;file://host/tmp${BEL}`;
const OSC7_ST = `${ESC}]7;file://host/tmp${ESC}\\`;

describe("PromptNewlineTransformer", () => {
  it("passes streams without OSC 7 frames through untouched", () => {
    const transformer = new PromptNewlineTransformer();
    const input = bytes("hello world\nsecond line");
    expect(transformer.push(input)).toBe(input);
  });

  it("inserts CRLF before the prompt frame when output is mid-line", () => {
    const transformer = new PromptNewlineTransformer();
    const out = transformer.push(bytes('{"code":200}'));
    expect(text(out)).toBe('{"code":200}');
    const out2 = transformer.push(bytes(OSC7_BEL));
    expect(text(out2)).toBe(`\r\n${OSC7_BEL}`);
  });

  it("leaves the stream alone when output already ends on a line start", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("line\n")))).toBe("line\n");
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(OSC7_BEL);

    // A bare CR also counts: progress bars ("50%\r60%\r") end at column 0.
    expect(text(transformer.push(bytes("50%\r60%\r")))).toBe("50%\r60%\r");
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(OSC7_BEL);
  });

  it("handles both BEL and ST frame terminators", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("mid")))).toBe("mid");
    expect(text(transformer.push(bytes(OSC7_ST)))).toBe(`\r\n${OSC7_ST}`);
  });

  it("carries a frame split across chunks and inserts before its start", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("payload ")))).toBe("payload ");
    expect(text(transformer.push(bytes(`${ESC}]7;`)))).toBe("");
    expect(text(transformer.push(bytes("file://host/tmp")))).toBe("");
    expect(text(transformer.push(bytes(`${BEL}$ `)))).toBe(`\r\n${ESC}]7;file://host/tmp${BEL}$ `);
  });

  it("never misreads a ]7; inside another OSC payload as a prompt signal", () => {
    const transformer = new PromptNewlineTransformer();
    const decoy = `${ESC}]633;P;Cwd=file://host/tmp/x]7;y/${BEL}`;
    expect(text(transformer.push(bytes(`after${decoy}`)))).toBe(`after${decoy}`);
    // Only the real OSC 7 frame triggers the newline, and only one.
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);
  });

  it("treats escape sequences as invisible for line-start tracking", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("a\u001b[2K")))).toBe("a\u001b[2K");
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);

    const transformer2 = new PromptNewlineTransformer();
    expect(text(transformer2.push(bytes("a\r\u001b[2K")))).toBe("a\r\u001b[2K");
    expect(text(transformer2.push(bytes(OSC7_BEL)))).toBe(OSC7_BEL);
  });

  it("keeps multibyte UTF-8 intact across chunk boundaries", () => {
    const transformer = new PromptNewlineTransformer();
    const raw = "执行完成：密码: 中".split("").map((ch) => bytes(ch));
    let merged: Uint8Array = new Uint8Array(0);
    for (const chunk of raw) merged = concat(merged, transformer.push(chunk));
    expect(text(merged)).toBe("执行完成：密码: 中");
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);
  });

  it("suppresses insertion while tracking the stream", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("mid"), { suppressInsert: true }))).toBe("mid");
    expect(text(transformer.push(bytes(OSC7_BEL), { suppressInsert: true }))).toBe(OSC7_BEL);
    // Tracking still happened: the same stream with inserts re-enabled
    // mid-line inserts exactly once.
    expect(text(transformer.push(bytes("tail")))).toBe("tail");
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);
  });

  it("flushes an oversized unterminated sequence instead of stalling", () => {
    const transformer = new PromptNewlineTransformer();
    const junk = `${ESC}]7;${"x".repeat(9 * 1024)}`;
    const out = transformer.push(bytes(junk));
    expect(text(out)).toBe(junk);
    // Fail-open leaves ground state "not at line start": the next real frame
    // still gets its newline, and no bytes were dropped or duplicated.
    expect(transformer.push(bytes(OSC7_BEL))).toBeInstanceOf(Uint8Array);
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);
  });

  it("reset drops carry and restores the initial line-start state", () => {
    const transformer = new PromptNewlineTransformer();
    expect(text(transformer.push(bytes("mid")))).toBe("mid");
    expect(text(transformer.push(bytes(`${ESC}]7;file`)))).toBe("");
    transformer.reset();
    // The carried half-frame is gone: the tail bytes flow through as plain
    // ground bytes (the lone BEL is an invisible control, ignored).
    expect(text(transformer.push(bytes(`://host${BEL}`)))).toBe(`://host${BEL}`);
    expect(text(transformer.push(bytes(OSC7_BEL)))).toBe(`\r\n${OSC7_BEL}`);
  });

  it("handles several frames and outputs inside one chunk", () => {
    const transformer = new PromptNewlineTransformer();
    // First frame lands right after a newline (no insert); the echoed command
    // moves the cursor mid-line, so the second frame gets its CRLF in front.
    const stream = bytes(`\n${OSC7_BEL}$ ls${OSC7_BEL}`);
    expect(text(transformer.push(stream))).toBe(`\n${OSC7_BEL}$ ls\r\n${OSC7_BEL}`);
  });
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}
