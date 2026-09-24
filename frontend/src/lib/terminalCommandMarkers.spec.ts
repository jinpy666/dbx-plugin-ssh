// OSC 633 命令标记 parser 的回归用例：真实 shell integration 的 precmd 在
// 同一段输出里先发 D（上一命令退出码）再发 A（新提示符），chunk 级合并的
// updates 曾被 A 携带的 lastExitCode=null 覆写，导致退出码标记永远显示不出
// 来（本地终端注入脚本与远端 VS Code 兼容脚本同样受害）。
import { describe, expect, it } from "vitest";
import { getOsc633ParserState, parseOsc633StreamChunk } from "./terminalCommandMarkers";

describe("terminalCommandMarkers parser", () => {
  it("keeps the D-mark exit code when the prompt A-mark follows in the same chunk", () => {
    const state = getOsc633ParserState();
    const chunk = "\u001b]633;D;2\u0007\u001b]133;D;2\u0007\u001b]633;A\u0007\u001b]133;A\u0007";
    const { updates } = parseOsc633StreamChunk(chunk, state);
    expect(updates.lastExitCode).toBe(2);
    expect(updates.commandActive).toBe(false);
  });

  it("still resets state so the next command starts clean, and parses Cwd", () => {
    const state = getOsc633ParserState();
    parseOsc633StreamChunk("\u001b]633;D;3\u0007\u001b]633;A\u0007", state);
    expect(state.lastExitCode).toBeNull();
    const { updates } = parseOsc633StreamChunk("\u001b]633;P;Cwd=/tmp/work\u0007", state);
    expect(updates.cwd).toBe("/tmp/work");
    const running = parseOsc633StreamChunk("\u001b]633;E;cargo build\u0007\u001b]633;C\u0007", state);
    expect(running.updates.commandActive).toBe(true);
    expect(running.updates.command).toBe("cargo build");
  });

  it("reports the exit code of the previous command when E starts a new one", () => {
    const state = getOsc633ParserState();
    parseOsc633StreamChunk("\u001b]633;A\u0007", state);
    parseOsc633StreamChunk("\u001b]633;E;false\u0007\u001b]633;C\u0007out\u001b]633;D;1\u0007\u001b]633;A\u0007", state);
    const again = parseOsc633StreamChunk("\u001b]633;E;true\u0007", state);
    expect(again.updates.commandActive).toBe(true);
    expect(state.lastExitCode).toBeNull();
  });
});
