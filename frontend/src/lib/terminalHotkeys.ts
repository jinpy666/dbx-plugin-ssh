/**
 * Terminal hotkey registry — Tabby's "Hotkeys" tab, scoped to the actions this
 * plugin can actually perform.
 *
 * Only actions with a real implementation are listed: an editor full of inert
 * bindings would be worse than no editor. Actions a standalone terminal needs
 * but a host-owned workbench cannot provide (new tab, split pane, quit, reopen
 * closed tab) are deliberately absent — the host owns those.
 *
 * Combos are built from `KeyboardEvent.code`, not `.key`, so a binding survives
 * layout and Shift-rewriting (Ctrl+= and Ctrl+Shift+= stay distinct instead of
 * collapsing into "+"); `formatHotkeyDisplay` turns the tokens back into
 * something readable for the UI.
 *
 * Platform split follows Tabby: macOS keeps ⌘C/⌘V for copy/paste so Ctrl+C
 * reaches the remote as SIGINT, while Windows/Linux use the Ctrl+Shift forms.
 */

import { pluginStore } from "./pluginStore";

export const TERMINAL_HOTKEYS_KEY = "ssh-terminal-hotkeys";

export type TerminalHotkeyActionId =
  | "search"
  | "copy"
  | "paste"
  | "select-all"
  | "clear"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom"
  | "scroll-to-top"
  | "scroll-to-bottom";

export type TerminalHotkeyGroup = "clipboard" | "view" | "navigation";

export interface TerminalHotkeyAction {
  id: TerminalHotkeyActionId;
  labelKey: string;
  group: TerminalHotkeyGroup;
  /** Defaults for macOS. */
  apple: readonly string[];
  /** Defaults for every other platform. */
  other: readonly string[];
  /**
   * The handler returns false (xterm skips the key) while leaving the browser
   * default in place, which is how the native paste event still fires.
   */
  nativeEvent?: boolean;
}

export const TERMINAL_HOTKEY_ACTIONS: readonly TerminalHotkeyAction[] = [
  { id: "search", labelKey: "terminalHotkeys.actionSearch", group: "view", apple: ["Meta+F"], other: ["Ctrl+Shift+F"] },
  { id: "copy", labelKey: "terminalHotkeys.actionCopy", group: "clipboard", apple: ["Meta+C"], other: ["Ctrl+Shift+C"] },
  { id: "paste", labelKey: "terminalHotkeys.actionPaste", group: "clipboard", apple: ["Meta+V"], other: ["Ctrl+V", "Ctrl+Shift+V"], nativeEvent: true },
  { id: "select-all", labelKey: "terminalHotkeys.actionSelectAll", group: "clipboard", apple: ["Meta+A"], other: ["Ctrl+Shift+A"] },
  { id: "clear", labelKey: "terminalHotkeys.actionClear", group: "view", apple: ["Meta+K"], other: ["Ctrl+Shift+K"] },
  { id: "zoom-in", labelKey: "terminalHotkeys.actionZoomIn", group: "view", apple: ["Meta+=", "Meta+Shift+="], other: ["Ctrl+=", "Ctrl+Shift+="] },
  { id: "zoom-out", labelKey: "terminalHotkeys.actionZoomOut", group: "view", apple: ["Meta+-", "Meta+Shift+-"], other: ["Ctrl+-", "Ctrl+Shift+-"] },
  { id: "reset-zoom", labelKey: "terminalHotkeys.actionResetZoom", group: "view", apple: ["Meta+0"], other: ["Ctrl+0"] },
  { id: "scroll-to-top", labelKey: "terminalHotkeys.actionScrollTop", group: "navigation", apple: ["Shift+PageUp"], other: ["Ctrl+PageUp"] },
  { id: "scroll-to-bottom", labelKey: "terminalHotkeys.actionScrollBottom", group: "navigation", apple: ["Shift+PageDown"], other: ["Ctrl+PageDown"] },
];

export const TERMINAL_HOTKEY_GROUPS: readonly TerminalHotkeyGroup[] = ["clipboard", "view", "navigation"];

export const ACTION_IDS: readonly TerminalHotkeyActionId[] = TERMINAL_HOTKEY_ACTIONS.map((action) => action.id);

/** Bindings per action; an empty array means the action is unbound. */
export type TerminalHotkeyBindings = Record<TerminalHotkeyActionId, string[]>;

const MODIFIER_ORDER = ["Meta", "Ctrl", "Alt", "Shift"] as const;
type ModifierToken = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, ModifierToken> = {
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  "⌘": "Meta",
  ctrl: "Ctrl",
  control: "Ctrl",
  "⌃": "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  "⌥": "Alt",
  shift: "Shift",
  "⇧": "Shift",
};

/** `code` → display token, for keys whose code name is not the label. */
const CODE_TOKENS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Escape: "Escape",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const TOKEN_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(CODE_TOKENS).map(([code, token]) => [token.toLowerCase(), code]));

/** Keys that only ever act as modifiers, so a bare press is not a binding. */
const PURE_MODIFIER_CODES = new Set(["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"]);

/** Turn a `KeyboardEvent.code` into a display token, or null when unsupported. */
export function keyTokenFromCode(code: string): string | null {
  if (!code) return null;
  if (PURE_MODIFIER_CODES.has(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_TOKENS[code] ?? null;
}

export interface ModifierEventLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Canonical combo for a key event, e.g. "Ctrl+Shift+F". Modifiers always appear
 * in Meta/Ctrl/Alt/Shift order so two spellings of the same chord compare equal.
 * Returns null for pure-modifier presses and unmappable keys.
 */
export function keyComboFromEvent(event: ModifierEventLike): string | null {
  const token = keyTokenFromCode(event.code);
  if (!token) return null;
  // Shift stays a modifier even for letters: the token comes from `code`, which
  // is Shift-independent, so "Ctrl+A" and "Ctrl+Shift+A" stay distinct chords.
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Meta");
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, token].join("+");
}

/**
 * Parse a user- or storage-supplied combo into its canonical form. Unparseable
 * input returns null; a chord with no modifier and no key token is rejected
 * (a bare letter binding would swallow ordinary typing).
 */
export function sanitizeKeyCombo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
  if (!parts.length) return null;
  const modifiers: string[] = [];
  let token: string | null = null;
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias) {
      if (!modifiers.includes(alias)) modifiers.push(alias);
      continue;
    }
    if (token != null) return null;
    const normalized = /^key([a-z])$/i.test(part) ? part.slice(3).toUpperCase() : /^digit([0-9])$/i.test(part) ? part.slice(5) : part;
    const resolved = TOKEN_TO_CODE[normalized.toLowerCase()] ? normalized : normalizeTokenCase(normalized);
    if (!resolved) return null;
    token = resolved;
  }
  if (!token) return null;
  if (!modifiers.length) return null;
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, token].join("+");
}

function normalizeTokenCase(token: string): string | null {
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
  if (/^Num[0-9]$/i.test(token)) return `Num${token.slice(3)}`;
  return TOKEN_TO_CODE[token.toLowerCase()] ? token : null;
}

const APPLE_SYMBOLS: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

/** Human-readable rendering: "⌘⇧F" on Apple, "Ctrl+Shift+F" elsewhere. */
export function formatHotkeyDisplay(combo: string, applePlatform: boolean): string {
  const parts = combo.split("+");
  if (!applePlatform) return parts.join("+");
  return parts.map((part) => APPLE_SYMBOLS[part] ?? part).join("");
}

/** Default bindings for the platform, cloned so callers cannot mutate the table. */
export function defaultTerminalHotkeys(applePlatform: boolean): TerminalHotkeyBindings {
  const bindings = {} as TerminalHotkeyBindings;
  for (const action of TERMINAL_HOTKEY_ACTIONS) {
    bindings[action.id] = [...(applePlatform ? action.apple : action.other)];
  }
  return bindings;
}

/**
 * Normalize stored bindings: unknown actions are dropped, unknown combos inside
 * a known action are dropped, and any action missing from the blob falls back to
 * its platform default (so a newly added action is never left unusable).
 */
export function sanitizeTerminalHotkeys(raw: unknown, applePlatform: boolean): TerminalHotkeyBindings {
  const defaults = defaultTerminalHotkeys(applePlatform);
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bindings = {} as TerminalHotkeyBindings;
  for (const id of ACTION_IDS) {
    const value = source[id];
    if (value === undefined) {
      bindings[id] = defaults[id];
      continue;
    }
    if (!Array.isArray(value)) {
      bindings[id] = defaults[id];
      continue;
    }
    const combos: string[] = [];
    for (const entry of value) {
      const combo = sanitizeKeyCombo(entry);
      if (combo && !combos.includes(combo)) combos.push(combo);
    }
    bindings[id] = combos;
  }
  return bindings;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  // Defaults to pluginStore (host host.storage → guarded localStorage →
  // memory); on the opaque-origin workbench this no longer throws
  // SecurityError. Explicitly injected storage is a test seam only.
  return pluginStore;
}

export function loadTerminalHotkeys(applePlatform: boolean, storage?: Pick<Storage, "getItem">): TerminalHotkeyBindings {
  let parsed: unknown;
  try {
    const raw = (storage ?? defaultStorage()).getItem(TERMINAL_HOTKEYS_KEY) ?? null;
    parsed = raw == null ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  return sanitizeTerminalHotkeys(parsed, applePlatform);
}

export function persistTerminalHotkeys(bindings: TerminalHotkeyBindings, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? defaultStorage()).setItem(TERMINAL_HOTKEYS_KEY, JSON.stringify(bindings));
  } catch {
    // Storage unavailable: the bindings stay session-scoped.
  }
}

/**
 * First action bound to `combo`, or null. An action rebound to `[]` is unbound,
 * and — because plan and navigation keys such as Ctrl+A, Ctrl+C and Ctrl+F are
 * deliberately absent from the defaults — those keep reaching the remote shell.
 * When two actions claim the same combo the first in table order wins; the
 * editor surfaces the clash via `findHotkeyConflicts`.
 */
export function matchTerminalHotkey(bindings: TerminalHotkeyBindings, combo: string): TerminalHotkeyActionId | null {
  for (const action of TERMINAL_HOTKEY_ACTIONS) {
    if (bindings[action.id]?.includes(combo)) return action.id;
  }
  return null;
}

export interface HotkeyConflict {
  combo: string;
  actions: TerminalHotkeyActionId[];
}

/** Combos claimed by more than one action, in action-table order. */
export function findHotkeyConflicts(bindings: TerminalHotkeyBindings): HotkeyConflict[] {
  const owners = new Map<string, TerminalHotkeyActionId[]>();
  for (const id of ACTION_IDS) {
    for (const combo of bindings[id] ?? []) {
      const list = owners.get(combo) ?? [];
      list.push(id);
      owners.set(combo, list);
    }
  }
  const conflicts: HotkeyConflict[] = [];
  for (const [combo, actions] of owners) {
    if (actions.length > 1) conflicts.push({ combo, actions });
  }
  return conflicts;
}

/** Every combo already used by another action (used to flag duplicates live). */
export function combosUsedByOthers(bindings: TerminalHotkeyBindings, actionId: TerminalHotkeyActionId): string[] {
  const used: string[] = [];
  for (const id of ACTION_IDS) {
    if (id === actionId) continue;
    for (const combo of bindings[id] ?? []) if (!used.includes(combo)) used.push(combo);
  }
  return used;
}

export function actionById(id: string): TerminalHotkeyAction | undefined {
  return TERMINAL_HOTKEY_ACTIONS.find((action) => action.id === id);
}

/** Field-by-field comparison of two binding maps over the known action set. */
export function hotkeysEqual(a: TerminalHotkeyBindings, b: TerminalHotkeyBindings): boolean {
  return ACTION_IDS.every((id) => {
    const left = a[id] ?? [];
    const right = b[id] ?? [];
    return left.length === right.length && left.every((combo, index) => combo === right[index]);
  });
}
