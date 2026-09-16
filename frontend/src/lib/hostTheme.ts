// 宿主 1.1 主题通道（PluginBridgeTheme）→ 插件 appearance 契约的适配层。
// 宿主在 init 与 env 消息里推送 { appearance, tokens }，tokens 是宿主根节点
// 解析后的 `--color-*` 等 CSS 变量；旧宿主（Host API 1.0）无此字段，调用方
// 按缺失降级走本地规范色板。

const THEME_TOKEN_COLORS = [
  ["background", "--color-background"],
  ["foreground", "--color-foreground"],
  ["muted", "--color-muted"],
  ["mutedForeground", "--color-muted-foreground"],
  ["accent", "--color-accent"],
  ["accentForeground", "--color-accent-foreground"],
  ["border", "--color-border"],
  ["destructive", "--color-destructive"],
] as const;

// These are the existing font tokens bridged by shared/frontend/themeSync.ts.
// Keep this mapping limited to tokens already in the host theme contract; the
// SSH terminal must follow DBX's mono font rather than inventing a plugin-only
// font setting.
const THEME_TOKEN_FONTS = [
  ["terminal", "--font-mono"],
  ["ui", "--font-sans"],
] as const;

export function isDbxPluginTheme(value: unknown): value is DbxPluginTheme {
  if (typeof value !== "object" || value === null) return false;
  const theme = value as { appearance?: unknown; tokens?: unknown };
  if (theme.appearance !== "light" && theme.appearance !== "dark") return false;
  return theme.tokens === undefined || (typeof theme.tokens === "object" && theme.tokens !== null);
}

// 宿主 SDK 对 env 消息派发 `dbx-plugin-env` CustomEvent，detail 即消息本体。
export function themeFromEnvDetail(detail: unknown): DbxPluginTheme | null {
  const theme = (detail as { theme?: unknown } | null | undefined)?.theme;
  if (!isDbxPluginTheme(theme)) return null;
  return { appearance: theme.appearance, tokens: theme.tokens ?? {} };
}

// 缺失的 token 字段留空，交由 resolveAppearance 按当前方案规范色板补齐。
export function themeToAppearance(theme: DbxPluginTheme): {
  colorScheme: "light" | "dark";
  colors: Partial<DbxPluginAppearance["colors"]>;
  terminal?: Partial<DbxPluginAppearance["terminal"]>;
  ui?: Partial<NonNullable<DbxPluginAppearance["ui"]>>;
} {
  const tokens = theme.tokens ?? {};
  const colors: Partial<DbxPluginAppearance["colors"]> = {};
  for (const [key, token] of THEME_TOKEN_COLORS) {
    const value = tokens[token];
    if (typeof value === "string" && value.trim()) colors[key] = value;
  }
  const fonts: {
    terminal?: Partial<DbxPluginAppearance["terminal"]>;
    ui?: Partial<NonNullable<DbxPluginAppearance["ui"]>>;
  } = {};
  for (const [target, token] of THEME_TOKEN_FONTS) {
    const value = tokens[token];
    if (typeof value !== "string" || !value.trim()) continue;
    if (target === "terminal") fonts.terminal = { fontFamily: value };
    else fonts.ui = { fontFamily: value };
  }
  return { colorScheme: theme.appearance, colors, ...fonts };
}

export function onHostThemeChange(listener: (theme: DbxPluginTheme) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const theme = themeFromEnvDetail((event as CustomEvent).detail);
    if (theme) listener(theme);
  };
  document.addEventListener("dbx-plugin-env", handler);
  return () => document.removeEventListener("dbx-plugin-env", handler);
}
