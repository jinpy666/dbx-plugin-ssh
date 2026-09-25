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
    const handler = bySpec({ prefix: ">", intermediates: "q", final: "q" }).handler;
    expect(handler([0])).toBe(true);
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
