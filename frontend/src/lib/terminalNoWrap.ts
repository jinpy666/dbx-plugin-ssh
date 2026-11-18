/**
 * Terminal no-wrap mode (issue #306).
 *
 * xterm.js has no display-only switch to stop folding: the only honest
 * mechanism is a wider PTY, so long lines stay on one logical row and the
 * host container scrolls horizontally. That changes what remote applications
 * see, which is fine for log/JSON/SQL inspection but ruins full-screen apps —
 * so while the alternate screen is active (vim, htop, less) the width resolves
 * back to the viewport and restores once the app exits.
 *
 * This module is the single source of truth for the resolved width: the fit
 * override, the #262 fit watchdog's target dimensions and the alt-screen
 * CSI revert all read the same resolver, otherwise the watchdog would fight
 * the override and resize-thrash every interval.
 */

export interface NoWrapTargetInput {
  enabled: boolean;
  configuredCols: number;
  viewportCols: number;
  alternate: boolean;
}

/** Alternate-screen DEC private modes: 1049 (the modern save-cursor +
 * switch), 1047 and 47 (legacy variants). */
export const ALT_SCREEN_DEC_MODES = [47, 1047, 1049];

export function resolveNoWrapTargetCols(input: NoWrapTargetInput): number {
  if (!input.enabled || input.alternate) return input.viewportCols;
  return Math.max(input.viewportCols, input.configuredCols);
}

/** CSI ?h / CSI ?l handler filter: true when the params touch an
 * alternate-screen mode. xterm parser params nest sub-params as arrays. */
export function isAltScreenSwitch(params: ReadonlyArray<number | number[] | string | string[]>): boolean {
  return params.some((param) => {
    if (Array.isArray(param)) return param.some((value) => ALT_SCREEN_DEC_MODES.includes(Number(value)));
    return ALT_SCREEN_DEC_MODES.includes(Number(param));
  });
}

/** Minimal structural view of an xterm Terminal the width helper needs. */
export interface NoWrapTerminalLike {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  readonly buffer: { readonly active: { readonly type: string } };
}

/** Apply the no-wrap width to a live terminal. Returns true when resized —
 * callers use that to decide whether the PTY needs a resize notification. */
export function applyNoWrapWidth(term: NoWrapTerminalLike, opts: { enabled: boolean; configuredCols: number; viewportCols?: number }): boolean {
  const alternate = term.buffer.active.type === "alternate";
  const viewportCols = opts.viewportCols ?? term.cols;
  const target = resolveNoWrapTargetCols({ enabled: opts.enabled, configuredCols: opts.configuredCols, viewportCols, alternate });
  if (!Number.isFinite(target) || target < 1 || target === term.cols) return false;
  term.resize(target, term.rows);
  return true;
}

/** Minimal structural view of the xterm parser API the watch needs. */
export interface NoWrapParserLike {
  registerCsiHandler(matcher: { prefix?: string; final: string }, callback: (params: ReadonlyArray<number | number[]>) => boolean | void | Promise<boolean> | Promise<void>): unknown;
}

/** Watch DECSET/DECRST alternate-screen switches (CSI ?h / ?l with modes
 * 47/1047/1049) and invoke `onSwitch` so the caller can re-resolve the PTY
 * width. Handlers always return false — the switch must still reach xterm's
 * own buffer handling. Silently no-ops when the parser API is unavailable. */
export function registerAltScreenWatch(term: { parser: NoWrapParserLike }, onSwitch: () => void): void {
  try {
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (isAltScreenSwitch(params)) onSwitch();
      return false;
    });
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (isAltScreenSwitch(params)) onSwitch();
      return false;
    });
  } catch {
    /* 老版本 xterm 无 parser API：无折行模式退化为常宽，不回退备用屏。 */
  }
}
