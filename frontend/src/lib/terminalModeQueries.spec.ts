import { describe, expect, it } from "vitest";
import { registerTerminalModeQueryHandlers } from "./terminalModeQueries";

interface Registered {
  spec: { prefix?: string; intermediates?: string; final: string };
  handler: (params: (number | number[])[]) => boolean;
}

function fakeTerminal() {
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
  registerTerminalModeQueryHandlers(terminal as never);
  const bySpec = (spec: Registered["spec"]) => {
    const found = registered.find((entry) => JSON.stringify(entry.spec) === JSON.stringify(spec));
    expect(found, `handler for ${JSON.stringify(spec)} registered`).toBeTruthy();
    return found!;
  };
  return { bySpec, written };
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

  it("answers DECRQM private-mode queries as not recognized", () => {
    const { bySpec, written } = fakeTerminal();
    const handler = bySpec({ prefix: "?", intermediates: "$", final: "p" }).handler;
    // 2026 = synchronized output probe from neovim/claude code.
    expect(handler([2026])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;2$y"]);
    written.length = 0;
    // DECRQM carries an optional second param; the reply ignores it.
    expect(handler([2026, 1])).toBe(true);
    expect(written).toEqual(["\x1b[?2026;2$y"]);
    // No mode → not a DECRQM request.
    expect(handler([])).toBe(false);
  });
});
