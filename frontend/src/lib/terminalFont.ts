// 终端字体单独设置（issue #31）：字体族/字号的持久化解析与「用户设置优先、
// 未设置跟随宿主」的合成纯逻辑。零 UI/SSH 依赖。
//
// 语义：
// - 字号沿用既有键 ssh-terminal-font-size（Ctrl+滚轮缩放已写入），clamp 进
//   [TERMINAL_FONT_MIN, TERMINAL_FONT_MAX]；缺失/空白/非数字视为非法 →
//   回退宿主值。
// - 字体族为新键 ssh-terminal-font-family；trim 后非空视为有效设置，缺失/空
//   → 跟随宿主。恢复跟随宿主 = 删键。
// - 存储统一走 pluginStore（宿主 host.storage → guarded localStorage → 内存）；
//   读写在函数体 try 内完成（历史上直读 window.localStorage 在 opaque origin
//   下「访问属性」本身就抛 SecurityError——同 terminalWebgl.ts 的约定）。

import { clampFontSize } from "./terminalZoom";
import { pluginStore } from "./pluginStore";

export const TERMINAL_FONT_SIZE_KEY = "ssh-terminal-font-size";
export const TERMINAL_FONT_FAMILY_KEY = "ssh-terminal-font-family";

/** 用户对终端字体的单独设置；null 字段 = 未设置，跟随宿主。 */
export interface TerminalFontOverride {
  fontFamily: string | null;
  fontSize: number | null;
}

/** 宿主下发的终端字体基准（appearance.terminal 的解析结果）。 */
export interface TerminalFontHost {
  fontFamily: string;
  fontSize: number;
}

/** 解析持久化字号：缺失/空白/非数字为 null（回退宿主），数字 clamp 进合法区间。 */
export function parsePersistedTerminalFontSize(raw: string | null): number | null {
  if (raw == null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampFontSize(parsed, 0) : null;
}

/** 解析持久化字体族：trim 后非空为有效值，缺失/空白为 null（跟随宿主）。 */
export function parsePersistedTerminalFontFamily(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 用户设置优先合成：null 字段回退宿主值（issue #31 的核心语义）。 */
export function resolveTerminalFont(override: TerminalFontOverride, host: TerminalFontHost): TerminalFontHost {
  return {
    fontFamily: override.fontFamily ?? host.fontFamily,
    fontSize: override.fontSize ?? host.fontSize,
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  // 默认走 pluginStore（宿主 host.storage → guarded localStorage → 内存），
  // opaque origin 下不再抛 SecurityError；显式注入 storage 仅测试用。
  return pluginStore;
}

/** 读取当前生效的用户设置（键缺失/非法/存储不可用均归一为 null = 跟随宿主）。 */
export function loadTerminalFontOverride(storage?: Pick<Storage, "getItem">): TerminalFontOverride {
  try {
    const target = storage ?? defaultStorage();
    return {
      fontFamily: parsePersistedTerminalFontFamily(target.getItem(TERMINAL_FONT_FAMILY_KEY)),
      fontSize: parsePersistedTerminalFontSize(target.getItem(TERMINAL_FONT_SIZE_KEY)),
    };
  } catch {
    return { fontFamily: null, fontSize: null };
  }
}

/** 写入/清除字体族设置；null 删键（恢复跟随宿主）。存储不可用时仅失去记忆。 */
export function persistTerminalFontFamily(family: string | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? defaultStorage();
    if (family == null) target.removeItem(TERMINAL_FONT_FAMILY_KEY);
    else target.setItem(TERMINAL_FONT_FAMILY_KEY, family);
  } catch {
    // localStorage 不可用时设置仅对当前会话生效。
  }
}

/** 写入/清除字号设置；null 删键（恢复宿主基准）。 */
export function persistTerminalFontSize(size: number | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? defaultStorage();
    if (size == null) target.removeItem(TERMINAL_FONT_SIZE_KEY);
    else target.setItem(TERMINAL_FONT_SIZE_KEY, String(size));
  } catch {
    // localStorage 不可用时设置仅对当前会话生效。
  }
}
