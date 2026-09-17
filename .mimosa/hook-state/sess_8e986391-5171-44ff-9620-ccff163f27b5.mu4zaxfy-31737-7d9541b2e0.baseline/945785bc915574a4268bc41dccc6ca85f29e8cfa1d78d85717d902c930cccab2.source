/**
 * Terminal interaction preferences (select-to-copy / right-click-to-paste).
 * The toggle is a pure-frontend behavior (no sidecar involvement), so it
 * persists in localStorage; "false" disables it, every other value (including
 * a missing entry) keeps the historical default of enabled.
 */

export type TerminalRightClickAction = "paste" | "menu";

export function sanitizeSelectCopyEnabled(raw: string | null): boolean {
  return raw !== "false";
}

/**
 * Right-click semantics with the copy-on-select mode enabled: a plain
 * right-click pastes straight from the clipboard (XShell/SecureCRT style),
 * while Shift+right-click keeps the full context menu reachable.
 */
export function resolveTerminalRightClickAction(options: { selectCopy: boolean; shiftKey: boolean }): TerminalRightClickAction {
  return options.selectCopy && !options.shiftKey ? "paste" : "menu";
}

export type TerminalKeyAction = "copy" | "paste" | "none";

/**
 * Keyboard shortcut routing inside the terminal (Windows Terminal/iTerm2
 * style): Ctrl/Cmd+V and Ctrl/Cmd+Shift+V paste, Ctrl/Cmd+C copies when a
 * selection exists and otherwise stays untouched so it keeps reaching the
 * remote shell as SIGINT.
 */
export function resolveTerminalKeyAction(options: { mod: boolean; shiftKey: boolean; key: string; hasSelection: boolean }): TerminalKeyAction {
  const key = options.key.toLowerCase();
  if (options.mod && key === "v") return "paste";
  if (options.mod && key === "c" && options.hasSelection) return "copy";
  return "none";
}

export interface TerminalSearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
}

export const TERMINAL_SEARCH_OPTIONS_KEY = "ssh-terminal-search-options";
const TERMINAL_SEARCH_SEED_MAX_LENGTH = 200;

/**
 * Search toggle persistence: the stored shape is a JSON object; anything
 * malformed (or a missing entry) falls back to the all-off defaults instead
 * of throwing or leaking stale partial state.
 */
export function sanitizeSearchOptions(raw: string | null): TerminalSearchOptions {
  let parsed: unknown;
  try {
    parsed = raw == null ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  const source = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return {
    caseSensitive: source.caseSensitive === true,
    regex: source.regex === true,
    wholeWord: source.wholeWord === true,
  };
}

export function persistSearchOptions(options: TerminalSearchOptions): void {
  try {
    window.localStorage.setItem(TERMINAL_SEARCH_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // localStorage unavailable: the toggles stay session-scoped.
  }
}

/**
 * Search seed from the current terminal selection (iTerm2 "find selected
 * text"): only the first line is kept and clamped to a bounded length, so a
 * huge or multiline selection cannot turn into an unusable query.
 */
export function terminalSearchSeedFromSelection(selection: string): string {
  const firstLine = selection.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.slice(0, TERMINAL_SEARCH_SEED_MAX_LENGTH);
}

/**
 * Whether a file dropped onto the terminal pane can be uploaded right now.
 * Mirrors the SFTP pane's drop gate: needs an active writable session, and a
 * running file transfer protocol (ZMODEM or trzsz) owns the terminal data
 * path so drops are refused while one is busy.
 */
export function canAcceptTerminalDrop(options: { connected: boolean; canWrite: boolean; transferBusy: boolean }): boolean {
  return options.connected && options.canWrite && !options.transferBusy;
}

/**
 * Target directory typed into the terminal drop prompt: whitespace is
 * trimmed, trailing slashes collapse (the bare root "/" stays intact), and
 * an empty result means the input is unusable so the caller can keep the
 * confirm button disabled. The sidecar's normalize_remote_path is the final
 * authority — this only shapes the input before joinRemote().
 */
export function normalizeDropTargetDir(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) return trimmed;
  const collapsed = trimmed.replace(/\/+$/, "");
  return collapsed || "/";
}
