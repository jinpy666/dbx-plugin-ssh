// OSC 633 命令标记 parser 的回归用例：真实 shell integration 的 precmd 在
// 同一段输出里先发 D（上一命令退出码）再发 A（新提示符），chunk 级合并的
// updates 曾被 A 携带的 lastExitCode=null 覆写，导致退出码标记永远显示不出
// 来（本地终端注入脚本与远端 VS Code 兼容脚本同样受害）。
import { describe, expect, it } from "vitest";
import { formatCommandDuration, getOsc633ParserState, Osc633CommandParser, parseOsc633StreamChunk } from "./terminalCommandMarkers";

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

  it("skips plain byte chunks without ESC and still completes a marker split across chunks", () => {
    // 快路径（首帧优化）：不含 ESC 且无 carry 的字节块零解析直接返回，
    // 大量纯输出不再进解码器；带 ESC 的块与跨块 carry 仍完整解析。
    const parser = new Osc633CommandParser();
    expect(parser.push(new TextEncoder().encode("plain ptY output without escape\r\n"))).toEqual({});
    // ESC 序列跨块：carry 非空时，即使续块不含 ESC 也必须继续解码。
    const head = parser.push(new TextEncoder().encode("\u001b]633;E;cargo bu"));
    expect(head.commandActive).toBeUndefined();
    const tail = parser.push(new TextEncoder().encode("ild\u0007"));
    expect(tail.commandActive).toBe(true);
    expect(tail.command).toBe("cargo build");
    // reset 后 carry/decoder 全清：续块不再拼接旧序列。
    parser.reset();
    expect(parser.push(new TextEncoder().encode("ild\u0007"))).toEqual({});
  });

  it("does not turn a missing start mark into an epoch-sized duration", () => {
    // 命令没有前置 C（重连、恢复会话、shell 只发 D）时 currentCommandStartAt 仍是
    // null，而 Number(null) === 0 也满足 Number.isFinite——少了 > 0 这道判断，
    // 耗时会算成 Date.now() - 0，标记条显示 "29840335m06s" 这种荒谬值。
    const state = getOsc633ParserState();
    parseOsc633StreamChunk("\u001b]633;D;0\u0007", state);
    expect(state.lastCommandDuration).toBeNull();
    expect(formatCommandDuration(state.lastCommandDuration)).toBe("0ms");

    // 正常路径：C 记录起始时间后，D 得到的是真实耗时。
    const started = getOsc633ParserState();
    parseOsc633StreamChunk("\u001b]633;E;ls\u0007\u001b]633;C\u0007", started);
    parseOsc633StreamChunk("\u001b]633;D;0\u0007", started);
    expect(started.lastCommandDuration).toBeGreaterThanOrEqual(0);
    expect(started.lastCommandDuration as number).toBeLessThan(5000);
  });
});
