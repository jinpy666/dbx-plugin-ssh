import { describe, expect, it } from "vitest";
import { applyLineEditControlChar } from "./terminalLineModel";

describe("applyLineEditControlChar (readline 编辑键, #138 丝滑度 review P0-B)", () => {
  it("Ctrl+U clears the whole line", () => {
    expect(applyLineEditControlChar("cd /opt/aaa", "\u0015")).toBe("");
    expect(applyLineEditControlChar("", "\u0015")).toBe("");
  });

  it("Ctrl+W kills the trailing word plus preceding whitespace", () => {
    expect(applyLineEditControlChar("git status", "\u0017")).toBe("git");
    expect(applyLineEditControlChar("cd /opt/", "\u0017")).toBe("cd");
  });

  it("Ctrl+W on a whitespace-only tail kills back to the previous word boundary", () => {
    // bash unix-word-rubout：词后已敲的空白随词一并删除（"abc " → ""）。
    expect(applyLineEditControlChar("abc ", "\u0017")).toBe("");
    expect(applyLineEditControlChar("abc  def  ", "\u0017")).toBe("abc");
  });

  it("Ctrl+W on an empty line keeps it empty", () => {
    expect(applyLineEditControlChar("", "\u0017")).toBe("");
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
