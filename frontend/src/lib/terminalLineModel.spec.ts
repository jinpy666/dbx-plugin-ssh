import { describe, expect, it } from "vitest";
import { applyLineEditControlChar } from "./terminalLineModel";

describe("applyLineEditControlChar (readline 编辑键, #138 丝滑度 review P0-B)", () => {
  it("Ctrl+U clears the whole line", () => {
    expect(applyLineEditControlChar("cd /opt/aaa", "\u0015")).toBe("");
    expect(applyLineEditControlChar("", "\u0015")).toBe("");
  });

  it("Ctrl+W kills the trailing word but keeps the separator before it", () => {
    // 实测 bash readline（`read -e` + Ctrl+W）：词前的分隔空白保留。
    expect(applyLineEditControlChar("git status", "\u0017")).toBe("git ");
    expect(applyLineEditControlChar("cd /opt/", "\u0017")).toBe("cd ");
  });

  it("Ctrl+W on a whitespace-only tail kills back to the previous word boundary", () => {
    // bash unix-word-rubout：先吃掉词后的空白，再吃掉词，词前空白保留
    // （"abc  def  " → "abc  "）；只有空白、没有词时才整行清空。
    expect(applyLineEditControlChar("abc ", "\u0017")).toBe("");
    expect(applyLineEditControlChar("abc  def  ", "\u0017")).toBe("abc  ");
    expect(applyLineEditControlChar("   ", "\u0017")).toBe("");
  });

  it("Ctrl+W on an empty line keeps it empty", () => {
    expect(applyLineEditControlChar("", "\u0017")).toBe("");
  });

  it("Ctrl+W treats quotes as ordinary characters, not word boundaries", () => {
    // 词边界只看空白：'a b' → "'a "。
    expect(applyLineEditControlChar("'a b'", "\u0017")).toBe("'a ");
  });

  it("returns null for characters the model handles elsewhere", () => {
    // 可打印字符、退格/回车/Ctrl+C（trackPendingInput 主分支）与未知控制字节
    // 一律不认领，避免与既有处理重复叠加。
    expect(applyLineEditControlChar("abc", "x")).toBeNull();
    expect(applyLineEditControlChar("abc", "\u007f")).toBeNull();
    expect(applyLineEditControlChar("abc", "\r")).toBeNull();
    expect(applyLineEditControlChar("abc", "\u0003")).toBeNull();
    expect(applyLineEditControlChar("abc", "\u0001")).toBeNull();
  });
});
