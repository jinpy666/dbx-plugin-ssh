import { describe, expect, it } from "vitest";
import { terminalWordEditingInput, wordEditingLineUntrusted } from "./terminalWordEditing";

const event = (key: string, patch = {}) => ({
  type: "keydown", key, altKey: true, ctrlKey: false, metaKey: false,
  shiftKey: false, isComposing: false, keyCode: 0,
  getModifierState: () => false, ...patch,
});
const options = { enabled: true, alternateActive: false, hotkeyMatched: false };

describe("Alt/Option word editing", () => {
  it.each([
    ["ArrowLeft", "\x1bb"], ["ArrowRight", "\x1bf"],
    ["Backspace", "\x1b\x7f"], ["Delete", "\x1bd"],
  ])("maps %s, including key repeats", (key, bytes) => {
    expect(terminalWordEditingInput(event(key), options)).toBe(bytes);
    expect(terminalWordEditingInput(event(key, { repeat: true }), options)).toBe(bytes);
  });

  it.each([
    { altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true },
    { isComposing: true }, { keyCode: 229 }, { type: "keyup" },
    { getModifierState: (key: string) => key === "AltGraph" },
  ])("preserves other modifiers and composition: %j", patch => {
    expect(terminalWordEditingInput(event("ArrowLeft", patch), options)).toBeUndefined();
  });

  it.each([
    { enabled: false }, { alternateActive: true }, { hotkeyMatched: true },
  ])("preserves opt-out, full-screen input and user hotkeys: %j", patch => {
    expect(terminalWordEditingInput(event("ArrowLeft"), { ...options, ...patch })).toBeUndefined();
  });

  it.each(["ArrowUp", "ArrowDown", "b", "f", "Dead", "toString"])("leaves %s untouched", key => {
    expect(terminalWordEditingInput(event(key), options)).toBeUndefined();
  });

  it("keeps stale suggestions suppressed through further typing until a new line", () => {
    for (const data of ["\x1bb", "\x1bf", "\x1b\x7f", "\x1bd"]) {
      expect(wordEditingLineUntrusted(false, data)).toBe(true);
    }
    for (const data of ["x", "\x7f", "\t", "\x1b[C"]) {
      expect(wordEditingLineUntrusted(true, data)).toBe(true);
    }
    for (const data of ["\r", "\n", "\x03"]) {
      expect(wordEditingLineUntrusted(true, data)).toBe(false);
    }
    expect(wordEditingLineUntrusted(false, "x")).toBe(false);
  });

  it("marks shell-owned line rewrites as untrusted on their own", () => {
    // Tab（shell 自己的补全）、Ctrl+W/A/E/R、方向键/Home/End/历史序列都会
    // 让增量模型与真实行失步；此后普通键入不得把它重新变成可信。
    for (const data of ["\t", "\x17", "\x01", "\x05", "\x12"]) {
      expect(wordEditingLineUntrusted(false, data)).toBe(true);
    }
    for (const data of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[H", "\x1b[F", "\x1bOH", "\x1b[3~"]) {
      expect(wordEditingLineUntrusted(false, data)).toBe(true);
    }
    // 序列被拆包：末尾残留 ESC / CSI / SS3 起始符同样不可追踪。
    for (const data of ["\x1b", "\x1b[", "\x1b[1", "\x1bO"]) {
      expect(wordEditingLineUntrusted(false, data)).toBe(true);
    }
    // 多字节块内嵌控制序列同样命中。
    expect(wordEditingLineUntrusted(false, "ab\x17")).toBe(true);
  });

  it("keeps ordinary typing trusted and resets only on a new line", () => {
    expect(wordEditingLineUntrusted(false, "abc")).toBe(false);
    expect(wordEditingLineUntrusted(false, "/opt/aa")).toBe(false);
    // 键入不解除不可信：只有回车/Ctrl+C 开新行才恢复。
    expect(wordEditingLineUntrusted(true, "abc")).toBe(true);
    expect(wordEditingLineUntrusted(true, "\r")).toBe(false);
  });
});
