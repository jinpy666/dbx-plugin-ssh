/**
 * Terminal mode/capability query responses (CSI), parity with the OSC 10/11
 * handling in terminalOsc.ts.
 *
 * xterm.js answers Primary DA (`CSI c`) itself, but swallows queries that
 * modern TUIs probe at startup while waiting for the reply before finishing
 * their first paint:
 *
 * - `CSI ? u` (kitty keyboard protocol query): claude code / neovim / kitty
 *   clients ask whether the terminal supports the enhanced keyboard protocol;
 *   an unanswered probe parks the TUI's input stack in raw mode with nothing
 *   echoed — the workbench "terminal is frozen, keyboard dead" report.
 * - `CSI > 0 q` (XTVERSION): several CLIs gate fancy rendering on the answer.
 * - `CSI ? 2026 $ p` (DECRQM, synchronized output): answered from live state —
 *   the mode is now implemented (WT-1, WezTerm parity). `CSI ? 2026 h` holds
 *   the rAF coalescing channel (`terminalWriteThrottle.setHold`), so redraw
 *   batches inside the mode buffer instead of painting mid-frame; `CSI ? 2026 l`
 *   commits the whole batch in one merged write, and the DECRQM reply reports
 *   set/reset from that live hold state. The old "always unsupported" reply
 *   was retired deliberately: apps now get a real frame-sync window instead of
 *   probing forever, and the retry-loop risk that reply guarded against is
 *   addressed by actually honoring set/reset (with the throttle's byte cap
 *   forcing progress if an app stalls inside the mode).
 *
 * The answers advertise nothing we do not implement: kitty flags 0 ("supported
 * protocol, no enhancement flags") lets the caller keep plain legacy encoding,
 * and the XTVERSION string is generic so clients do not enable kitty-specific
 * escapes against a terminal that will not honor them.
 */

import type * as Xterm from "@xterm/xterm";

/** The minimal surface the query responders touch on the terminal. */
export type CsiTerminal = Pick<Xterm.Terminal, "input" | "parser">;

/** DECSET 2026 (synchronized output) frame window driven by the remote. */
export interface TerminalSyncOutput {
  /** `CSI ? 2026 h`: hold writes on the coalescing channel for one batch. */
  begin(): void;
  /** `CSI ? 2026 l`: commit everything buffered since the last begin. */
  end(): void;
}

/** DECRQM reply states (DEC STD 070): 0 = not recognized, 1 = set, 2 = reset. */
export type DecRqmState = 0 | 1 | 2;

export interface TerminalModeQueryOptions {
  /**
   * Live DECRQM reporter. Called for every private-mode query; modes the
   * terminal does not track should report 2 ("reset" — recognized but off).
   * Reporting 0 ("not recognized") for those would be a behavior change for
   * TUIs probing bracketed paste / alt screen / focus reporting, and the
   * previous blanket reply was 2, so the default stays there.
   */
  decRqmState?: (mode: number) => DecRqmState;
  /** When wired, DECSET/DECRST 2026 drive the frame-sync window. */
  syncOutput?: TerminalSyncOutput;
}

/**
 * Registers the capability-query CSI handlers on the terminal's parser.
 * Every handler is defensive: a non-query form (a real `CSI ? <flags> u` set
 * from a remote) returns false and falls through to xterm's own handling.
 * The DECSET/DECRST 2026 intercepts only fire on a bare, sole `2026`
 * parameter — mixed sets (`CSI ? 1049;2026 h`) fall through wholesale so
 * xterm keeps its native alt-screen/bracketed-paste handling; those batches
 * simply render without frame sync (documented degradation, no breakage).
 */
export function registerTerminalModeQueryHandlers(terminal: CsiTerminal, options: TerminalModeQueryOptions = {}): () => void {
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
    // XTVERSION is `CSI > 0 q`: the "q" is the final byte, never an intermediate
    // (xterm rejects intermediates outside 0x20..0x2f at registration).
    terminal.parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
      // XTVERSION is only ever a query; `CSI > 4 q` (XTQMODKEY) falls through.
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
      // Reply state comes from the live reporter (2026 reflects the frame-sync
      // hold); unrecognized modes report 2 = reset (recognized-but-off).
      const state = options.decRqmState?.(mode) ?? 2;
      terminal.input(`\x1b[?${mode};${state}$y`, false);
      return true;
    }),
  );

  if (options.syncOutput) {
    const sync = options.syncOutput;
    // Sole-parameter 2026 only; sub-param arrays (e.g. [2026, 1]) are not a
    // DECSET form we claim, and mixed sets are handed back to xterm untouched.
    const isSyncSet = (params: (number | number[])[]) => params.length === 1 && params[0] === 2026;
    disposables.push(
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (!isSyncSet(params)) return false;
        sync.begin();
        return true;
      }),
    );
    disposables.push(
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (!isSyncSet(params)) return false;
        sync.end();
        return true;
      }),
    );
  }

  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}
