// 终端外观偏好（对标 Tabby 的 Settings → Appearance）：配色方案两槽（暗/亮
// 自适应切换）、底色来源策略、字体与间距、光标形态，以及「多套主题」快照
// （预设 + 我的主题）。纯逻辑 + pluginStore 持久化，不依赖 Vue/DOM。
//
// 与既有模块的分工：
// - `terminalFont.ts` 仍是字体族/字号的持有者（键 `ssh-terminal-font-family`
//   /`ssh-terminal-font-size`，Ctrl+滚轮缩放链路共用）。主题快照里包含字体，
//   但落地由 App 经既有 API 写入，避免两套真相。
// - `appearance.ts` 负责宿主色板的解析与回退；本模块只在用户显式启用配色
//   方案时叠加覆盖，`schemeSource: "host"`（默认）下插件行为与既有版本完全
//   一致——「全局外观由 DBX 宿主承担」的既有结论不被推翻。
//
// 存储默认走 pluginStore（宿主 host.storage → guarded localStorage → 内存，
// 见 pluginStore.ts）；读写在函数体 try 内完成——历史上直读 window.localStorage
// 在 opaque origin 下「访问属性」本身就抛 SecurityError（同 terminalFont.ts 的约定）。

import { pluginStore } from "./pluginStore";
import {
  builtinSchemeById,
  normalizeHexColor,
  schemeIdFromName,
  schemeToTerminalTheme,
  uniqueSchemeId,
  type TerminalColorScheme,
  type TerminalThemeLike,
} from "./terminalScheme";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN } from "./terminalZoom";

export const TERMINAL_APPEARANCE_KEY = "ssh-terminal-appearance";

/** 自定义方案数量上限：单键约 5MB，60 个方案 ≈ 100KB，留足余量。 */
export const CUSTOM_SCHEME_LIMIT = 60;
/** 用户保存的主题数量上限。 */
export const CUSTOM_THEME_LIMIT = 30;

export type TerminalCursorStyle = "bar" | "block" | "underline";
export type TerminalCursorInactiveStyle = "outline" | "block" | "bar" | "underline" | "none";

export interface TerminalAppearanceSettings {
  /** 配色来源：host=跟随 DBX 宿主色板（默认）；custom=用下方两槽方案。 */
  schemeSource: "host" | "custom";
  /** 宿主为深色时生效的方案 id；null = 用内置 DBX 深色规范板。 */
  darkSchemeId: string | null;
  /** 宿主为浅色时生效的方案 id；null = 用内置 DBX 浅色规范板。 */
  lightSchemeId: string | null;
  /** 终端底色来源：host=宿主面板底色（Tabby 的 background:'theme'）；scheme=方案底色。 */
  backgroundSource: "host" | "scheme";
  /** 字重（100-900），null = 跟随宿主默认（xterm 400）。 */
  fontWeight: number | null;
  /** 粗体字重（100-900）。 */
  fontWeightBold: number | null;
  /** 行高倍数（1-3），1.15 为既有默认。 */
  lineHeight: number | null;
  /** 字间距像素（-5-10，整数），0 为既有默认。 */
  letterSpacing: number | null;
  /** 终端左右内边距像素；null = 内置默认（左 10 / 右 0）。 */
  paddingX: number | null;
  /** 终端上下内边距像素；null = 内置默认（上 5 / 下 8）。 */
  paddingY: number | null;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  cursorInactiveStyle: TerminalCursorInactiveStyle;
  /** 粗体优先用亮色 ANSI（xterm 默认开）。 */
  drawBoldTextInBrightColors: boolean;
  /** 最小对比度（1-21）：xterm 会据此微调前景色保证可读（1 = 关闭）。 */
  minimumContrastRatio: number;
}

/** 主题快照：外观设置 + 字体（字体落地由 App 走 terminalFont 既有键）。 */
export interface TerminalAppearanceProfile {
  id: string;
  name: string;
  /** 内置预设不可删除。 */
  builtin: boolean;
  settings: TerminalAppearanceSettings;
  font: {
    /** null = 跟随宿主终端字体。 */
    family: string | null;
    /** null = 跟随宿主终端字号。 */
    size: number | null;
  };
}

export interface TerminalAppearanceState {
  settings: TerminalAppearanceSettings;
  font: TerminalAppearanceProfile["font"];
  customSchemes: TerminalColorScheme[];
  customThemes: TerminalAppearanceProfile[];
}

export const DEFAULT_TERMINAL_APPEARANCE_SETTINGS: TerminalAppearanceSettings = {
  schemeSource: "host",
  darkSchemeId: null,
  lightSchemeId: null,
  backgroundSource: "scheme",
  fontWeight: null,
  fontWeightBold: null,
  lineHeight: null,
  letterSpacing: null,
  paddingX: null,
  paddingY: null,
  // 既有实现即细竖线光标（bar）常亮，默认保持，避免升级后光标形态突变。
  cursorStyle: "bar",
  cursorBlink: true,
  cursorInactiveStyle: "outline",
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
};

/** 内置预设主题：可直接套用的几套成品配置（对标 Tabby 的「配色 + 字体」组合）。 */
export const TERMINAL_APPEARANCE_PRESETS: readonly TerminalAppearanceProfile[] = [
  {
    id: "preset-host",
    name: "presetHost",
    builtin: true,
    settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS },
    font: { family: null, size: null },
  },
  {
    id: "preset-dracula",
    name: "presetDracula",
    builtin: true,
    settings: {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      schemeSource: "custom",
      darkSchemeId: "dracula",
      lightSchemeId: "solarized-light",
      backgroundSource: "scheme",
      lineHeight: 1.3,
      paddingX: 12,
      paddingY: 8,
    },
    font: { family: "'JetBrains Mono', Consolas, monospace", size: 14 },
  },
  {
    id: "preset-nord",
    name: "presetNord",
    builtin: true,
    settings: {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      schemeSource: "custom",
      darkSchemeId: "nord",
      lightSchemeId: "onehalflight",
      backgroundSource: "scheme",
      lineHeight: 1.25,
      letterSpacing: 0,
    },
    font: { family: null, size: null },
  },
  {
    id: "preset-tokyo-night",
    name: "presetTokyoNight",
    builtin: true,
    settings: {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      schemeSource: "custom",
      darkSchemeId: "tokyonight-storm",
      lightSchemeId: "tokyonight-day",
      backgroundSource: "scheme",
      lineHeight: 1.35,
      letterSpacing: 1,
      paddingX: 12,
    },
    font: { family: "'JetBrains Mono', Consolas, monospace", size: 14 },
  },
  {
    id: "preset-gruvbox",
    name: "presetGruvbox",
    builtin: true,
    settings: {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      schemeSource: "custom",
      darkSchemeId: "gruvbox-dark",
      lightSchemeId: "onehalflight",
      backgroundSource: "scheme",
      lineHeight: 1.2,
      paddingY: 10,
    },
    font: { family: null, size: null },
  },
  {
    id: "preset-high-contrast",
    name: "presetHighContrast",
    builtin: true,
    settings: {
      ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS,
      schemeSource: "custom",
      darkSchemeId: "hardcore",
      lightSchemeId: "terminal-basic",
      backgroundSource: "scheme",
      fontWeight: 500,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 4.5,
      cursorStyle: "block",
    },
    font: { family: null, size: null },
  },
];

function clampNumber(value: unknown, min: number, max: number, integer = false): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.round(clamped) : clamped;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 校验并归一化来自 localStorage / 旧版本的设置：越界值钳制，非法值回默认。 */
export function sanitizeAppearanceSettings(raw: unknown): TerminalAppearanceSettings {
  const record = (raw ?? {}) as Record<string, unknown>;
  const schemeSource = record.schemeSource === "custom" ? "custom" : "host";
  const backgroundSource = record.backgroundSource === "host" ? "host" : "scheme";
  const cursorStyle = record.cursorStyle === "block" || record.cursorStyle === "underline" ? record.cursorStyle : "bar";
  const inactiveStyles: TerminalCursorInactiveStyle[] = ["outline", "block", "bar", "underline", "none"];
  const cursorInactiveStyle = inactiveStyles.includes(record.cursorInactiveStyle as TerminalCursorInactiveStyle)
    ? (record.cursorInactiveStyle as TerminalCursorInactiveStyle)
    : "outline";
  const ratio = clampNumber(record.minimumContrastRatio, 1, 21);
  return {
    schemeSource,
    darkSchemeId: optionalString(record.darkSchemeId),
    lightSchemeId: optionalString(record.lightSchemeId),
    backgroundSource,
    fontWeight: clampNumber(record.fontWeight, 100, 900, true),
    fontWeightBold: clampNumber(record.fontWeightBold, 100, 900, true),
    lineHeight: clampNumber(record.lineHeight, 1, 3),
    letterSpacing: clampNumber(record.letterSpacing, -5, 10, true),
    paddingX: clampNumber(record.paddingX, 0, 32, true),
    paddingY: clampNumber(record.paddingY, 0, 32, true),
    cursorStyle,
    cursorBlink: record.cursorBlink !== false,
    cursorInactiveStyle,
    drawBoldTextInBrightColors: record.drawBoldTextInBrightColors !== false,
    minimumContrastRatio: ratio ?? 1,
  };
}

function sanitizeFont(raw: unknown): TerminalAppearanceProfile["font"] {
  const record = (raw ?? {}) as Record<string, unknown>;
  const size = clampNumber(record.size, TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, true);
  return { family: optionalString(record.family), size };
}

/** 校验自定义方案：色值全量归一化，id 缺失时按名称重算（并去重）。 */
export function sanitizeCustomScheme(raw: unknown, taken: readonly string[]): TerminalColorScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const foreground = normalizeHexColor(record.foreground);
  const background = normalizeHexColor(record.background);
  if (!foreground || !background) return null;
  const colors = Array.isArray(record.colors) ? record.colors.slice(0, 16).map(normalizeHexColor) : [];
  if (colors.length < 16 || colors.some((color) => color === null)) return null;
  const name = optionalString(record.name) ?? "Imported scheme";
  const id = optionalString(record.id) ?? uniqueSchemeId(schemeIdFromName(name), taken);
  return {
    id,
    name,
    foreground,
    background,
    cursor: normalizeHexColor(record.cursor) ?? foreground,
    colors: colors as string[],
    selectionBackground: normalizeHexColor(record.selectionBackground) ?? undefined,
    source: "custom",
  };
}

/** 全量状态归一化：结构非法（旧版本/手改 localStorage）时回默认，不抛错。 */
export function sanitizeTerminalAppearanceState(raw: unknown): TerminalAppearanceState {
  const record = (raw ?? {}) as Record<string, unknown>;
  const customSchemes: TerminalColorScheme[] = [];
  const taken = new Set<string>();
  for (const item of Array.isArray(record.customSchemes) ? record.customSchemes : []) {
    if (customSchemes.length >= CUSTOM_SCHEME_LIMIT) break;
    const scheme = sanitizeCustomScheme(item, [...taken]);
    if (scheme) {
      customSchemes.push(scheme);
      taken.add(scheme.id);
    }
  }
  const customThemes: TerminalAppearanceProfile[] = [];
  const themeIds = new Set<string>();
  for (const item of Array.isArray(record.customThemes) ? record.customThemes : []) {
    if (customThemes.length >= CUSTOM_THEME_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const theme = item as Record<string, unknown>;
    const name = optionalString(theme.name);
    if (!name) continue;
    const id = optionalString(theme.id) ?? uniqueSchemeId(schemeIdFromName(name), [...themeIds]);
    if (themeIds.has(id)) continue;
    themeIds.add(id);
    customThemes.push({
      id,
      name,
      builtin: false,
      settings: sanitizeAppearanceSettings(theme.settings),
      font: sanitizeFont(theme.font),
    });
  }
  return {
    settings: sanitizeAppearanceSettings(record.settings),
    font: sanitizeFont(record.font),
    customSchemes,
    customThemes,
  };
}

export function defaultTerminalAppearanceState(): TerminalAppearanceState {
  return {
    settings: { ...DEFAULT_TERMINAL_APPEARANCE_SETTINGS },
    font: { family: null, size: null },
    customSchemes: [],
    customThemes: [],
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  // 默认走 pluginStore（宿主 host.storage → guarded localStorage → 内存），
  // opaque origin 下不再抛 SecurityError；显式注入 storage 仅测试用。
  return pluginStore;
}

/** 读取偏好：键缺失/JSON 损坏/存储不可用一律回默认（首次运行即默认态）。 */
export function loadTerminalAppearance(storage?: Pick<Storage, "getItem">): TerminalAppearanceState {
  try {
    const target = storage ?? defaultStorage();
    const raw = target.getItem(TERMINAL_APPEARANCE_KEY);
    if (!raw) return defaultTerminalAppearanceState();
    return sanitizeTerminalAppearanceState(JSON.parse(raw));
  } catch {
    return defaultTerminalAppearanceState();
  }
}

/** 写入偏好；失败仅失去记忆，本次会话内设置仍即时生效。 */
export function persistTerminalAppearance(
  state: TerminalAppearanceState,
  storage?: Pick<Storage, "setItem" | "removeItem">,
): void {
  try {
    const target = storage ?? defaultStorage();
    target.setItem(TERMINAL_APPEARANCE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（沙箱/隐私模式）时设置仅对当前会话生效。
  }
}

/** 方案查找：内置目录 + 用户自定义；两处都查不到返回 null（跟随宿主色板）。 */
export function findScheme(customSchemes: readonly TerminalColorScheme[], id: string | null): TerminalColorScheme | null {
  if (!id) return null;
  return customSchemes.find((scheme) => scheme.id === id) ?? builtinSchemeById(id) ?? null;
}

/** 当前宿主亮暗下生效的方案；`schemeSource: "host"` 或槽位为空时返回 null。 */
export function resolveActiveScheme(
  settings: TerminalAppearanceSettings,
  customSchemes: readonly TerminalColorScheme[],
  hostColorScheme: "light" | "dark",
): TerminalColorScheme | null {
  if (settings.schemeSource !== "custom") return null;
  const id = hostColorScheme === "light" ? settings.lightSchemeId : settings.darkSchemeId;
  return findScheme(customSchemes, id);
}

/**
 * 方案叠加到宿主派生的基础主题之上。
 *
 * - `backgroundSource: "scheme"`：前景/背景/光标/选区全部取自方案（完整还原
 *   方案观感，面板 padding 环带一并跟随）；`"host"` 时保留宿主面板底色与
 *   前景色（Tabby 的 `background: 'theme'` 语义），仅替换 16 色 ANSI，让
 *   `ls`/`git diff` 等彩色输出跟随方案而与宿主 UI 不打架。
 * - 未启用方案时原样返回 base，确保默认路径零行为变化。
 */
export function applySchemeToTerminalTheme(
  base: TerminalThemeLike,
  settings: TerminalAppearanceSettings,
  customSchemes: readonly TerminalColorScheme[],
  hostColorScheme: "light" | "dark",
): TerminalThemeLike {
  const scheme = resolveActiveScheme(settings, customSchemes, hostColorScheme);
  if (!scheme) return base;
  const schemeTheme = schemeToTerminalTheme(scheme);
  if (settings.backgroundSource === "host") {
    return {
      ...schemeTheme,
      background: base.background,
      foreground: base.foreground,
      cursor: base.foreground,
      cursorAccent: base.background,
      selectionBackground: base.selectionBackground,
    };
  }
  return schemeTheme;
}

/** xterm 选项补丁（字体族/字号由 terminalFont 通道单独处理，不在此列）。 */
export interface TerminalOptionPatch {
  fontWeight: number | "normal" | "bold";
  fontWeightBold: number | "normal" | "bold";
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  cursorInactiveStyle: TerminalCursorInactiveStyle;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
}

export const TERMINAL_OPTION_DEFAULTS: TerminalOptionPatch = {
  fontWeight: "normal",
  fontWeightBold: "bold",
  lineHeight: 1.15,
  letterSpacing: 0,
  cursorStyle: "bar",
  cursorBlink: true,
  cursorInactiveStyle: "outline",
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
};

/** 偏好 → xterm 选项补丁：null 字段落回既有默认（1.15 行高、bar 光标等）。 */
export function terminalOptionPatch(settings: TerminalAppearanceSettings): TerminalOptionPatch {
  return {
    fontWeight: settings.fontWeight ?? TERMINAL_OPTION_DEFAULTS.fontWeight,
    fontWeightBold: settings.fontWeightBold ?? TERMINAL_OPTION_DEFAULTS.fontWeightBold,
    lineHeight: settings.lineHeight ?? TERMINAL_OPTION_DEFAULTS.lineHeight,
    letterSpacing: settings.letterSpacing ?? TERMINAL_OPTION_DEFAULTS.letterSpacing,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    cursorInactiveStyle: settings.cursorInactiveStyle,
    drawBoldTextInBrightColors: settings.drawBoldTextInBrightColors,
    minimumContrastRatio: settings.minimumContrastRatio,
  };
}

/** 内边距 CSS 变量值（px 字符串）；null 表示删除变量、回落 style.css 内置值。 */
export function terminalPaddingVars(settings: TerminalAppearanceSettings): {
  left: string | null;
  right: string | null;
  top: string | null;
  bottom: string | null;
} {
  const x = settings.paddingX;
  const y = settings.paddingY;
  if (x == null && y == null) return { left: null, right: null, top: null, bottom: null };
  // 未单独设置的方向保持内置默认（左 10 / 右 0 / 上 5 / 下 8）：显式改一边
  // 不该顺手把另一边也挪走，避免「只想加点左右留白」却把底部呼吸间距改没。
  return {
    left: `${x ?? 10}px`,
    right: `${x == null ? 0 : x}px`,
    top: `${y == null ? 5 : y}px`,
    bottom: `${y == null ? 8 : y}px`,
  };
}

/** 两个主题快照是否等价（用于「当前配置 == 某主题」的选中态判定）。 */
export function appearanceProfileEquals(a: TerminalAppearanceProfile, b: TerminalAppearanceProfile): boolean {
  return a.font.family === b.font.family
    && a.font.size === b.font.size
    && settingsEqual(a.settings, b.settings);
}

/** 设置深比较（字段少且扁平，逐键比较即可）。 */
export function settingsEqual(a: TerminalAppearanceSettings, b: TerminalAppearanceSettings): boolean {
  return (Object.keys(DEFAULT_TERMINAL_APPEARANCE_SETTINGS) as Array<keyof TerminalAppearanceSettings>)
    .every((key) => a[key] === b[key]);
}

/** 主题列表：内置预设在前，用户主题在后（同名不合并，用户可覆盖预设意图）。 */
export function allAppearanceProfiles(state: TerminalAppearanceState): TerminalAppearanceProfile[] {
  return [...TERMINAL_APPEARANCE_PRESETS, ...state.customThemes];
}

/** 当前配置命中的主题 id（含字体比较）；无匹配返回 null。 */
export function activeProfileId(state: TerminalAppearanceState): string | null {
  const current: TerminalAppearanceProfile = { id: "", name: "", builtin: false, settings: state.settings, font: state.font };
  return allAppearanceProfiles(state).find((profile) => appearanceProfileEquals(profile, current))?.id ?? null;
}
