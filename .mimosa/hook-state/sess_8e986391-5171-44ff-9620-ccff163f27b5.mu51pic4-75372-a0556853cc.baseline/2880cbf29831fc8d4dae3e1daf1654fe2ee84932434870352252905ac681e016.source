// DBX 宿主外观契约的插件侧解析：颜色令牌取自 DBX globals.css 的
// `:root`（浅色 pearl，白底）与 `.dark` 两个规范块。宿主只下发 colorScheme
// 或部分颜色时，缺失字段按当前方案回退到规范值，避免出现拼色。

export const DBX_APPEARANCE_PALETTES: Record<"light" | "dark", DbxPluginAppearance["colors"]> = {
  light: {
    background: "rgb(255 255 255)",
    foreground: "rgb(10 10 10)",
    muted: "rgb(245 245 245)",
    mutedForeground: "rgb(115 115 115)",
    accent: "rgb(245 245 245)",
    accentForeground: "rgb(23 23 23)",
    border: "rgb(229 229 229)",
    destructive: "rgb(231 0 11)",
  },
  dark: {
    background: "rgb(19 20 22)",
    foreground: "rgb(215 215 219)",
    muted: "rgb(42 42 45)",
    mutedForeground: "rgb(151 152 157)",
    accent: "rgb(46 47 51)",
    accentForeground: "rgb(221 221 226)",
    border: "rgb(110 110 114 / 0.28)",
    destructive: "rgb(243 98 95)",
  },
};

// 弹层背景按 DBX `--popover` 规范值，白底不透光，深色比背景略亮。
export const DBX_POPOVER: Record<"light" | "dark", string> = {
  light: "rgb(255 255 255)",
  dark: "rgb(30 30 32)",
};

const DEFAULT_TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace";
const DEFAULT_UI_FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const DEFAULT_TERMINAL_FONT_SIZE = 13;

export interface TerminalAnsiPalette {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

// xterm 16 色：深色沿用既有调色板；浅色参考 VS Code Light+，
// brightWhite 等亮色在白底下仍可读（不能直接用纯白）。
export const TERMINAL_ANSI: Record<"light" | "dark", TerminalAnsiPalette> = {
  dark: {
    black: "#1f2937", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
    blue: "#3b82f6", magenta: "#a855f7", cyan: "#06b6d4", white: "#d1d5db",
    brightBlack: "#6b7280", brightRed: "#f87171", brightGreen: "#4ade80", brightYellow: "#facc15",
    brightBlue: "#60a5fa", brightMagenta: "#c084fc", brightCyan: "#22d3ee", brightWhite: "#f2f3f5",
  },
  light: {
    black: "#1f2328", red: "#cd3131", green: "#00bc00", yellow: "#949800",
    blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14", brightYellow: "#b5ba00",
    brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// 宿主下发的 appearance 允许逐字段缺失（1.0 部分下发、1.1 theme 通道只带颜色令牌）。
export interface DbxPluginAppearanceInput {
  colorScheme?: "light" | "dark";
  colors?: Partial<DbxPluginAppearance["colors"]>;
  terminal?: Partial<DbxPluginAppearance["terminal"]>;
  ui?: Partial<NonNullable<DbxPluginAppearance["ui"]>>;
}

// 返回值保证 ui 字段存在，调用方无需再判空。
export function resolveAppearance(next?: DbxPluginAppearanceInput | null): DbxPluginAppearance & { ui: { fontFamily: string } } {
  const colorScheme = next?.colorScheme === "light" ? "light" : "dark";
  const colors: DbxPluginAppearance["colors"] = { ...DBX_APPEARANCE_PALETTES[colorScheme] };
  const hostColors = next?.colors as Record<string, unknown> | undefined;
  if (hostColors) {
    for (const key of Object.keys(colors) as Array<keyof DbxPluginAppearance["colors"]>) {
      if (isNonEmptyString(hostColors[key])) colors[key] = hostColors[key] as string;
    }
  }
  const fontFamily = isNonEmptyString(next?.terminal?.fontFamily) ? next!.terminal!.fontFamily : DEFAULT_TERMINAL_FONT_FAMILY;
  const fontSize = isPositiveFiniteNumber(next?.terminal?.fontSize) ? next!.terminal!.fontSize : DEFAULT_TERMINAL_FONT_SIZE;
  const uiFontFamily = isNonEmptyString(next?.ui?.fontFamily) ? next!.ui!.fontFamily : DEFAULT_UI_FONT_FAMILY;
  return {
    colorScheme,
    colors,
    terminal: { fontFamily, fontSize },
    ui: { fontFamily: uiFontFamily },
  };
}
