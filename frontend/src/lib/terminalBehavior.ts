/**
 * Terminal behavior preferences — the Tabby "Terminal" tab parity surface
 * (Rendering / Keyboard / Mouse / Clipboard / Sound).
 *
 * Pure front-end: no sidecar involvement, so the whole object persists in one
 * pluginStore key (host host.storage → guarded localStorage → memory; see
 * pluginStore.ts). Every default deliberately reproduces the behavior this
 * plugin already had before the settings existed, so simply upgrading changes
 * nothing; the Tabby defaults are cited next to each field and any deliberate
 * divergence is called out in a comment.
 *
 * Platform notes that shape this module:
 * - xterm 6.x dropped the `bellStyle` option, keeping only `onBell`. The bell
 *   mode is therefore driven by the caller off that event.
 * - `scrollOnUserInput` already defaults to true upstream, so `scrollOnInput`
 *   only ever needs to turn it off.
 * - `macOptionIsMeta` is xterm's own Alt-as-Meta switch (macOS only; other
 *   platforms already send an ESC prefix for Alt combinations).
 * - Ligatures stay out of scope: `@xterm/addon-ligatures` pulls opentype.js
 *   through Node built-ins and crashes this plugin's sandboxed iframe, so there
 *   is no honest toggle to offer.
 */

import { pluginStore } from "./pluginStore";

export const TERMINAL_BEHAVIOR_KEY = "ssh-terminal-behavior";

/**
 * Legacy single-boolean key from before the behavior object existed. Kept in
 * sync so a downgrade keeps the user's select-to-copy choice.
 */
export const LEGACY_SELECT_COPY_KEY = "ssh-terminal-select-copy";

export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 200_000;
export const WORD_SEPARATOR_MAX_LENGTH = 32;

export type TerminalRightClickMode = "off" | "menu" | "paste" | "clipboard";
export type TerminalBellMode = "off" | "visual" | "audible";
export type TerminalLinkModifier = "none" | "ctrl" | "alt" | "shift" | "meta";

export interface TerminalBehaviorSettings {
  /** Lines kept in the scrollback buffer. Tabby: 25000. */
  scrollbackLines: number;
  /** Send Alt as Meta. Tabby: false (maps to xterm's macOptionIsMeta). */
  altIsMeta: boolean;
  /** Scroll the viewport to the bottom on user input. Tabby: true. */
  scrollOnInput: boolean;
  /** Right-click semantics. Kept at "paste" to preserve this plugin's previous default. */
  rightClick: TerminalRightClickMode;
  /** Paste the primary selection on middle-click. Tabby: platform-dependent; opt-in here. */
  pasteOnMiddleClick: boolean;
  /** Characters that terminate a double-click word selection. Tabby: ` ()[]{}\'"`. */
  wordSeparator: string;
  /** Modifier required to click links; "none" keeps links always clickable. */
  linkModifier: TerminalLinkModifier;
  /** Copy the selection to the clipboard as soon as it is made. Previous plugin default: true. */
  copyOnSelect: boolean;
  /** Let applications negotiate bracketed paste. Tabby: true. */
  bracketedPaste: boolean;
  /** Confirm before pasting multiple lines. Tabby: true. */
  warnOnMultilinePaste: boolean;
  /** Flatten pasted line breaks into spaces. Tabby: false. */
  replaceNewlinesWithSpaces: boolean;
  /** Strip whitespace and newlines around pasted text. Tabby defaults to true; kept false so pasting behaves exactly as before. */
  trimWhitespaceOnPaste: boolean;
  /** Bell feedback. Tabby: "off". */
  bell: TerminalBellMode;
}

export const TERMINAL_BEHAVIOR_DEFAULTS: TerminalBehaviorSettings = {
  scrollbackLines: 25_000,
  altIsMeta: false,
  scrollOnInput: true,
  rightClick: "paste",
  pasteOnMiddleClick: false,
  wordSeparator: " ()[]{}\\'\"",
  linkModifier: "none",
  copyOnSelect: true,
  bracketedPaste: true,
  warnOnMultilinePaste: true,
  replaceNewlinesWithSpaces: false,
  trimWhitespaceOnPaste: false,
  bell: "off",
};

export const RIGHT_CLICK_MODES: readonly TerminalRightClickMode[] = ["off", "menu", "paste", "clipboard"];
export const BELL_MODES: readonly TerminalBellMode[] = ["off", "visual", "audible"];
export const LINK_MODIFIERS: readonly TerminalLinkModifier[] = ["none", "ctrl", "alt", "shift", "meta"];

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Explicit booleans only: a missing or non-boolean field keeps the default. */
function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pickWordSeparator(value: unknown): string {
  if (typeof value !== "string") return TERMINAL_BEHAVIOR_DEFAULTS.wordSeparator;
  return value.slice(0, WORD_SEPARATOR_MAX_LENGTH);
}

/**
 * Normalize a stored (or hand-edited) behavior blob. Malformed fields fall back
 * to their default individually, so one bad value cannot discard the rest.
 * `legacySelectCopy` seeds `copyOnSelect` only when the object itself carries no
 * value, which is what makes the upgrade from the old single-key storage silent.
 */
export function sanitizeTerminalBehavior(raw: unknown, legacySelectCopy?: boolean): TerminalBehaviorSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const copyOnSelect = typeof source.copyOnSelect === "boolean" ? source.copyOnSelect : legacySelectCopy ?? TERMINAL_BEHAVIOR_DEFAULTS.copyOnSelect;
  return {
    scrollbackLines: pickInteger(source.scrollbackLines, SCROLLBACK_MIN, SCROLLBACK_MAX, TERMINAL_BEHAVIOR_DEFAULTS.scrollbackLines),
    altIsMeta: pickBoolean(source.altIsMeta, TERMINAL_BEHAVIOR_DEFAULTS.altIsMeta),
    scrollOnInput: pickBoolean(source.scrollOnInput, TERMINAL_BEHAVIOR_DEFAULTS.scrollOnInput),
    rightClick: pickEnum(source.rightClick, RIGHT_CLICK_MODES, TERMINAL_BEHAVIOR_DEFAULTS.rightClick),
    pasteOnMiddleClick: pickBoolean(source.pasteOnMiddleClick, TERMINAL_BEHAVIOR_DEFAULTS.pasteOnMiddleClick),
    wordSeparator: pickWordSeparator(source.wordSeparator),
    linkModifier: pickEnum(source.linkModifier, LINK_MODIFIERS, TERMINAL_BEHAVIOR_DEFAULTS.linkModifier),
    copyOnSelect,
    bracketedPaste: pickBoolean(source.bracketedPaste, TERMINAL_BEHAVIOR_DEFAULTS.bracketedPaste),
    warnOnMultilinePaste: pickBoolean(source.warnOnMultilinePaste, TERMINAL_BEHAVIOR_DEFAULTS.warnOnMultilinePaste),
    replaceNewlinesWithSpaces: pickBoolean(source.replaceNewlinesWithSpaces, TERMINAL_BEHAVIOR_DEFAULTS.replaceNewlinesWithSpaces),
    trimWhitespaceOnPaste: pickBoolean(source.trimWhitespaceOnPaste, TERMINAL_BEHAVIOR_DEFAULTS.trimWhitespaceOnPaste),
    bell: pickEnum(source.bell, BELL_MODES, TERMINAL_BEHAVIOR_DEFAULTS.bell),
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  // Defaults to pluginStore (host host.storage → guarded localStorage →
  // memory); on the opaque-origin workbench this no longer throws
  // SecurityError. Explicitly injected storage is a test seam only.
  return pluginStore;
}

/**
 * Read the stored behavior. Storage access sits inside the function body so a
 * failing injected storage degrades to defaults rather than throwing.
 */
export function loadTerminalBehavior(storage?: Pick<Storage, "getItem">): TerminalBehaviorSettings {
  let parsed: unknown;
  let legacy: boolean | undefined;
  try {
    const target = storage ?? defaultStorage();
    const raw = target.getItem(TERMINAL_BEHAVIOR_KEY) ?? null;
    parsed = raw == null ? undefined : JSON.parse(raw);
    const legacyRaw = target.getItem(LEGACY_SELECT_COPY_KEY) ?? null;
    legacy = legacyRaw == null ? undefined : legacyRaw !== "false";
  } catch {
    parsed = undefined;
    legacy = undefined;
  }
  return sanitizeTerminalBehavior(parsed, legacy);
}

/** Persist the behavior; the legacy mirror keeps a downgrade from losing select-to-copy. */
export function persistTerminalBehavior(settings: TerminalBehaviorSettings, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? defaultStorage();
    target.setItem(TERMINAL_BEHAVIOR_KEY, JSON.stringify(settings));
    target.setItem(LEGACY_SELECT_COPY_KEY, settings.copyOnSelect ? "true" : "false");
  } catch {
    // Storage unavailable: the settings stay session-scoped.
  }
}

/** The subset of xterm terminal options the behavior settings drive. */
export interface TerminalBehaviorOptionPatch {
  scrollback: number;
  scrollOnUserInput: boolean;
  wordSeparator: string;
  /** Inverted against `bracketedPaste`: xterm's option is the negative form. */
  ignoreBracketedPasteMode: boolean;
  macOptionIsMeta: boolean;
}

export function terminalBehaviorOptionPatch(settings: TerminalBehaviorSettings): TerminalBehaviorOptionPatch {
  return {
    scrollback: settings.scrollbackLines,
    scrollOnUserInput: settings.scrollOnInput,
    wordSeparator: settings.wordSeparator,
    ignoreBracketedPasteMode: !settings.bracketedPaste,
    macOptionIsMeta: settings.altIsMeta,
  };
}

/**
 * What a right-click should do. Shift+right-click always reaches the context
 * menu — that escape hatch predates the setting and is the only way back to the
 * menu under the "off" and "paste" modes.
 */
export type TerminalRightClickResolution = "off" | "menu" | "paste" | "copy";

export function resolveRightClickBehavior(settings: TerminalBehaviorSettings, options: { hasSelection: boolean; shiftKey: boolean }): TerminalRightClickResolution {
  if (options.shiftKey) return "menu";
  switch (settings.rightClick) {
    case "off":
      return "off";
    case "paste":
      return "paste";
    case "clipboard":
      return options.hasSelection ? "copy" : "paste";
    case "menu":
    default:
      return "menu";
  }
}

/**
 * Paste normalization. Trimming runs first so that a flattened multi-line paste
 * does not keep a leading or trailing separator space.
 */
export function transformPasteText(text: string, settings: TerminalBehaviorSettings): string {
  let result = text;
  if (settings.trimWhitespaceOnPaste) result = result.trim();
  if (settings.replaceNewlinesWithSpaces) result = result.replace(/\r\n|\r|\n/g, " ");
  return result;
}

export interface ModifierState {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Whether the configured link modifier is held. "none" always satisfies. */
export function isLinkModifierSatisfied(settings: TerminalBehaviorSettings, event: ModifierState): boolean {
  switch (settings.linkModifier) {
    case "ctrl":
      return event.ctrlKey;
    case "alt":
      return event.altKey;
    case "shift":
      return event.shiftKey;
    case "meta":
      return event.metaKey;
    case "none":
    default:
      return true;
  }
}

/** Field-by-field comparison, used to decide whether a settings write needs to reach xterm. */
export function behaviorEquals(a: TerminalBehaviorSettings, b: TerminalBehaviorSettings): boolean {
  return (
    a.scrollbackLines === b.scrollbackLines &&
    a.altIsMeta === b.altIsMeta &&
    a.scrollOnInput === b.scrollOnInput &&
    a.rightClick === b.rightClick &&
    a.pasteOnMiddleClick === b.pasteOnMiddleClick &&
    a.wordSeparator === b.wordSeparator &&
    a.linkModifier === b.linkModifier &&
    a.copyOnSelect === b.copyOnSelect &&
    a.bracketedPaste === b.bracketedPaste &&
    a.warnOnMultilinePaste === b.warnOnMultilinePaste &&
    a.replaceNewlinesWithSpaces === b.replaceNewlinesWithSpaces &&
    a.trimWhitespaceOnPaste === b.trimWhitespaceOnPaste &&
    a.bell === b.bell
  );
}
