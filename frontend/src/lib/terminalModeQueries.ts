/**
 * Terminal mode/capability query responses (CSI), parity with the OSC 10/11
 * handling in terminalOsc.ts.
 *
 * xterm.js answers Primary DA (`CSI c`) itself, but swallows two queries that
 * modern TUIs probe at startup while waiting for the reply before finishing
 * their first paint:
 *
 * - `CSI ? u` (kitty keyboard protocol query): claude code / neovim / kitty
 *   clients ask whether the terminal supports the enhanced keyboard protocol;
 *   an unanswered probe parks the TUI's input stack in raw mode with nothing
 *   echoed — the workbench "terminal is frozen, keyboard dead" report.
 * - `CSI > 0 q` (XTVERSION): several CLIs gate fancy rendering on the answer.
 * - `CSI ? 2026 $ p` (DECRQM, synchronized output): answered as unsupported so
 *   the caller falls back to plain rendering instead of retry-looping.
 *
 * The answers advertise nothing we do not implement: kitty flags 0 ("supported
 * protocol, no enhancement flags") lets the caller keep plain legacy encoding,
 * and the XTVERSION string is generic so clients do not enable kitty-specific
 * escapes against a terminal that will not honor them.
 */

import type * as Xterm from "@xterm/xterm";

/** The minimal surface the query responders touch on the terminal. */
export type CsiTerminal = Pick<Xterm.Terminal, "input" | "parser">;

/**
 * Registers the capability-query CSI handlers on the terminal's parser.
 * Every handler is defensive: a non-query form (a real `CSI ? <flags> u` set
 * from a remote) returns false and falls through to xterm's own handling.
 */
export function registerTerminalModeQueryHandlers(terminal: CsiTerminal): () => void {
  const disposables: Array<{ dispose(): void }> = [];

  disposables.push(
    terminal.parser.registerCsiHandler({ prefix: "?", final: "u" }, (params) => {
      // A set/pop with flags arrives with params; the bare query has none.
      if (params.length > 0 && params[0] !== 0) return false;
      terminal.input("\x1b[?0u", false);
      return true;
    }),
  );

  disposables.push(
    // XTVERSION wire form is `CSI > Ps q`: ">" is the prefix, Ps a parameter
    // and "q" the final byte — there is NO intermediate. Passing "q" as an
    // intermediate made xterm's parser._identifier throw at registration time
    // (intermediates must be 0x20..0x2f), which killed the whole workbench
    // boot before any session could attach.
    terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
      // Only the query form (Ps omitted or 0) gets the DCS reply.
      if (params.length > 0 && params[0] !== 0) return false;
      terminal.input("\x1bP>|dbx 1.0\x1b\\", false);
      return true;
    }),
  );

  disposables.push(
    terminal.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
      // Shape: <mode> [; 1]. A missing mode is not a DECRQM request.
      const mode = params[0];
      if (typeof mode !== "number") return false;
      // 2 = not recognized (DECRQM "unsupported" reply), so callers probing
      // 2026 synchronized output fall back immediately instead of waiting.
      terminal.input(`\x1b[?${mode};2$y`, false);
      return true;
    }),
  );

  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}
