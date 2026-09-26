import { describe, expect, it } from "vitest";
import { registerTerminalModeQueryHandlers, type TerminalModeQueryOptions } from "./terminalModeQueries";

interface Registered {
  spec: { prefix?: string; intermediates?: string; final: string };
  handler: (params: (number | number[])[]) => boolean;
}

function fakeTerminal(options: TerminalModeQueryOptions = {}) {
  const registered: Registered[] = [];
  const written: string[] = [];
  const terminal = {
    written,
    input(data: string, _wasUserInput: boolean) {
      written.push(data);
    },
    parser: {
      registerCsiHandler(spec: { prefix?: string; intermediates?: string; final: string }, handler: (params: (number | number[])[]) => boolean) {
        // xterm.js validates the function identifier at registration time
        // (EscapeSequenceParser._identifier) and throws on out-of-range bytes;
        // mirror that contract so invalid specs fail here instead of at connect.
        if (spec.prefix) {
          if (spec.prefix.length > 1) throw new Error("only one byte as prefix supported");
          const prefix = spec.prefix.charCodeAt(0);
          if (prefix < 0x3c || prefix > 0x3f) throw new Error("prefix must be in range 0x3c .. 0x3f");
        }
        if (spec.intermediates) {
          if (spec.intermediates.length > 2) throw new Error("only two bytes as intermediates are supported");
          for (const ch of spec.intermediates) {
            const intermediate = ch.charCodeAt(0);
            if (intermediate < 0x20 || intermediate > 0x2f) throw new Error("intermediate must be in range 0x20 .. 0x2f");
          }
        }
        if (spec.final.length !== 1) throw new Error("final must be a single byte");
        const final = spec.final.charCodeAt(0);
        if (final < 0x40 || final > 0x7e) throw new Error("final must be in range 0x40 .. 0x7e");
        registered.push({ spec, handler });
        return { dispose() {} };
      },
    },
  };
  registerTerminalModeQueryHandlers(terminal as never, options);
  const bySpec = (spec: Registered["spec"]) => {
    const found = registered.find((entry) => JSON.stringify(entry.spec) === JSON.stringify(spec));
    expect(found, `handler for ${JSON.stringify(spec)} registered`).toBeTruthy();
    return found!;
  };
  const hasSpec = (spec: Registered["spec"]) => registered.some((entry) => JSON.stringify(entry.spec) === JSON.stringify(spec));
  return { bySpec, hasSpec, written };
}

describe("registerTerminalModeQueryHandlers", () => {
  it("answers the kitty keyboard query with flags 0 and keeps set/pop forms on xterm", () => {
    const { bySpec, written } = fakeTerminal();
    const handler = bySpec({ prefix: "?", final: "u" }).handler;
    // Bare query (claude code / neovim startup probe).
    expect(handler([])).toBe(true);
    expect(written).toEqual(["\x1b[?0u"]);
    written.length = 0;
    // A set with flags 0 (disable enhancements) still counts as a bare query.
    expect(handler([0])).toBe(true);
    expect(written).toEqual(["\x1b[?0u"]);
    written.length = 0;
    // A real set (flags 1) or pop is not a query: fall through to xterm.
    expect(handler([1])).toBe(false);
    expect(handler([[1, 2]])).toBe(false);
    expect(written).toEqual([]);
  });

  it("answers XTVERSION with a DCS response", () => {
    const { bySpec, written } = fakeTerminal();
    // XTVERSION is `CSI > 0 q`: prefix ">", final "q", no intermediate byte.
    const handler = bySpec({ prefix: ">", final: "q" }).handler;
    expect(handler([0])).toBe(true);
    expect(written).toEqual(["\x1bP>|dbx 1.0\x1b\\"]);
    // `CSI > 4 q` is XTQMODKEY, not a version request: fall through to xterm.
    expect(handler([4])).toBe(false);
    expect(handler([4, 2])).toBe(false);
    expect(written).toEqual(["\x1bP>|dbx 1.0\x1b\\"]);
  });

  it("answers DECRQM 2026 as supported (reset) and honors the live sync reporter", () => {
    // WT-1 应答翻转：2026 已实现，应答从「不支持」改为按实时同步态回报
    // （2 = reset 即支持但未开启；1 = set 即同步窗进行中）。
    let held = false;
    const { bySpec, written } = fakeTerminal({
      decRqmState: (mode) => (mode === 2026 ? (held ? 1 : 2) : 2),
    });
    const handler = bySpec({ prefix: "?", intermediates: "$", final: "p" }).handler;
    // 2026 = synchronized output probe from neovim/claude code.
    expect(handler([2026])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;2$y"]);
    written.length = 0;
    // Synchronized-output window active: the reply flips to "set".
    held = true;
    expect(handler([2026])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;1$y"]);
    written.length = 0;
    held = false;
    // DECRQM carries an optional second param; the reply ignores it.
    expect(handler([2026, 1])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;2$y"]);
    // No mode → not a DECRQM request.
    expect(handler([])).toBe(false);
  });

  it("answers DECRQM for other private modes as reset and honors a 0 reporter", () => {
    const { bySpec, written } = fakeTerminal({
      decRqmState: (mode) => (mode === 1000 ? 0 : 2),
    });
    const handler = bySpec({ prefix: "?", intermediates: "$", final: "p" }).handler;
    // 未跟踪的私有模式维持历史回答 2 = reset（识别但关闭），不回 0 打扰
    // 探测 bracketed paste / 备用屏的 TUI；reporter 明确回 0 时如实转发。
    expect(handler([2004])).toBe(true);
    expect(written).toEqual(["\x1b[?2004;2$y"]);
    written.length = 0;
    expect(handler([1000])).toBe(true);
    expect(written).toEqual(["\x1b[?1000;0$y"]);
  });

  it("answers DECRQM with the reset default when no reporter is wired", () => {
    const { bySpec, written } = fakeTerminal();
    const handler = bySpec({ prefix: "?", intermediates: "$", final: "p" }).handler;
    expect(handler([2026])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;2$y"]);
  });

  it("drives the sync-output window from DECSET/DECRST 2026 and leaves other modes on xterm", () => {
    const calls: string[] = [];
    const { bySpec } = fakeTerminal({
      syncOutput: {
        begin: () => calls.push("begin"),
        end: () => calls.push("end"),
      },
    });
    const set = bySpec({ prefix: "?", final: "h" }).handler;
    const rst = bySpec({ prefix: "?", final: "l" }).handler;
    expect(set([2026])).toBe(true);
    expect(calls).toEqual(["begin"]);
    // 同步窗内重复 DECSET 原样转发（throttle 的 setHold 幂等，重复 begin 无副作用）。
    expect(set([2026])).toBe(true);
    expect(rst([2026])).toBe(true);
    expect(calls).toEqual(["begin", "begin", "end"]);
    // 其它 DECSET/DECRST 落回 xterm 原生处理（返回 false）。
    expect(set([1049])).toBe(false);
    expect(set([2004])).toBe(false);
    expect(rst([25])).toBe(false);
    // 混合参数整组交回 xterm，不做半程同步（文档化降级）。
    expect(set([1049, 2026])).toBe(false);
    expect(set([[2026, 1]])).toBe(false);
    expect(calls).toEqual(["begin", "begin", "end"]);
  });

  it("registers no DECSET/DECRST intercepts when sync output is not wired", () => {
    const { hasSpec } = fakeTerminal();
    expect(hasSpec({ prefix: "?", final: "h" })).toBe(false);
    expect(hasSpec({ prefix: "?", final: "l" })).toBe(false);
  });
});
