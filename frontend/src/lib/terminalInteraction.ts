/**
 * Terminal interaction preferences (select-to-copy / right-click-to-paste).
 * The toggle is a pure-frontend behavior (no sidecar involvement), so it
 * persists via pluginStore (host host.storage → guarded localStorage →
 * memory); "false" disables it, every other value (including a missing
 * entry) keeps the historical default of enabled.
 */

import { pluginStore } from "./pluginStore";

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

export const TERMINAL_COPY_CACHE_MAX_LENGTH = 200_000;

export interface TerminalCopyCache {
  get(): string;
  set(text: string): void;
  clear(): void;
}

/**
 * 插件视图内的复制副本：沙箱 iframe 里系统剪贴板读链必然断（宿主桥缺失 +
 * opaque origin 被 Permissions Policy 拒绝），右键粘贴的降级链依赖这份
 * 副本。选中复制、菜单复制、远端 OSC 52 写剪贴板都写入这里；超长只保留
 * 尾部，空写入不覆盖上一次有效副本。
 */
export function createTerminalCopyCache(maxLength: number = TERMINAL_COPY_CACHE_MAX_LENGTH): TerminalCopyCache {
  let cached = "";
  return {
    get: () => cached,
    set(text: string): void {
      if (!text) return;
      cached = text.length > maxLength ? text.slice(text.length - maxLength) : text;
    },
    clear(): void {
      cached = "";
    },
  };
}

/**
 * 右键粘贴的取文优先级：系统剪贴板（宿主可读时）→ 插件视图复制副本 →
 * 终端当前选区。空白（空格/缩进）是合法粘贴内容，只有空串视为"没有来源"。
 */
export function resolveTerminalPasteText(options: { clipboardText?: string | null; cachedText?: string | null; selectionText?: string | null }): string | null {
  for (const candidate of [options.clipboardText, options.cachedText, options.selectionText]) {
    if (candidate) return candidate;
  }
  return null;
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

/** Whether the browser runs on Apple hardware（Cmd 是主修饰键，electerm 同判定）。 */
export function isApplePlatform(userAgent: string = navigator.userAgent): boolean {
  return /mac/i.test(userAgent);
}

/**
 * 全选快捷键判定（electerm/iTerm2 同款）：Apple 平台 Cmd+A 直选，其余平台
 * Ctrl+Shift+A。裸 Ctrl+A 永不命中——必须继续发给 readline 当"跳行首"。
 */
export function isTerminalSelectAllShortcut(options: { mod: boolean; shiftKey: boolean; metaKey: boolean; key: string; applePlatform: boolean }): boolean {
  const key = options.key.toLowerCase();
  if (key !== "a") return false;
  if (options.mod && options.shiftKey) return true;
  return options.applePlatform && options.metaKey;
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
    pluginStore.setItem(TERMINAL_SEARCH_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Store unavailable: the toggles stay session-scoped.
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
 * Base drop gate shared by every upload drop channel (terminal pane, SFTP
 * pane, host-level drop): needs an active writable session. Callers show a
 * refusal notice instead of dropping silently when this fails.
 */
export function canAcceptFileDrop(options: { connected: boolean; canWrite: boolean }): boolean {
  return options.connected && options.canWrite;
}

/**
 * Whether a file dropped onto the terminal pane can be uploaded right now.
 * The writable-session gate, a file-transfer occupancy check (a running
 * ZMODEM/trzsz protocol owns the terminal data path), and the pane-visibility
 * rule: with the SFTP panel open the panel is the visible drop target (its
 * directory is on screen), so the terminal refuses drops and points the user
 * there instead of landing files in an invisible directory.
 */
export function canAcceptTerminalDrop(options: { connected: boolean; canWrite: boolean; transferBusy: boolean; sftpPaneOpen: boolean }): boolean {
  return canAcceptFileDrop(options) && !options.transferBusy && !options.sftpPaneOpen;
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

/**
 * 终端拖拽「当前目录」落点的解析顺序：shell 的 OSC 7/633 跟踪 cwd 优先（就
 * 是用户说的"终端 cwd"），其次回落远端主目录（连接时已由 sftp/home 探测）；
 * 主目录也拿不到（旧 sidecar）才用调用方兜底值。终端拖拽只在 SFTP 面板关闭
 * 时接收，所以解析链里不再参考面板目录——它此刻不可见，落进去用户也看不到。
 * 落点会在确认弹窗里完整展示，上传前看得到真实目标。
 */
export function resolveDropTargetDir(options: { terminalCwd?: string; sftpHome?: string; fallback: string }): string {
  if (options.terminalCwd) return options.terminalCwd;
  if (options.sftpHome && options.sftpHome !== "/") return options.sftpHome;
  return options.fallback;
}
