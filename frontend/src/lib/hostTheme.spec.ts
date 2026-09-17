import { describe, expect, it } from "vitest";
import { isDbxPluginTheme, themeFromEnvDetail, themeToAppearance } from "./hostTheme";
import { resolveAppearance } from "./appearance";

describe("isDbxPluginTheme", () => {
  it("accepts the host bridge theme shape", () => {
    expect(isDbxPluginTheme({ appearance: "dark", tokens: { "--color-background": "#111" } })).toBe(true);
    expect(isDbxPluginTheme({ appearance: "light", tokens: {} })).toBe(true);
    expect(isDbxPluginTheme({ appearance: "dark" })).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isDbxPluginTheme(null)).toBe(false);
    expect(isDbxPluginTheme("dark")).toBe(false);
    expect(isDbxPluginTheme({ appearance: "system", tokens: {} })).toBe(false);
    expect(isDbxPluginTheme({ appearance: "dark", tokens: "x" })).toBe(false);
  });
});

describe("themeFromEnvDetail", () => {
  it("extracts the theme from an env message detail", () => {
    expect(themeFromEnvDetail({ type: "env", locale: "en", theme: { appearance: "light", tokens: {} } })).toEqual({
      appearance: "light",
      tokens: {},
    });
  });

  it("returns null for env messages without a usable theme", () => {
    expect(themeFromEnvDetail({ type: "env", locale: "en" })).toBeNull();
    expect(themeFromEnvDetail({ theme: { appearance: "nope" } })).toBeNull();
    expect(themeFromEnvDetail(undefined)).toBeNull();
  });
});

describe("themeToAppearance", () => {
  it("maps host tokens onto the appearance colors contract", () => {
    const theme: DbxPluginTheme = {
      appearance: "dark",
      tokens: {
        "--color-background": "rgb(1 2 3)",
        "--color-muted-foreground": "rgb(4 5 6)",
        "--radius-lg": "10px",
        "--font-mono": "'Fira Code', monospace",
        "--font-sans": "'IBM Plex Sans', sans-serif",
      },
    };
    expect(themeToAppearance(theme)).toEqual({
      colorScheme: "dark",
      colors: { background: "rgb(1 2 3)", mutedForeground: "rgb(4 5 6)" },
      terminal: { fontFamily: "'Fira Code', monospace" },
      ui: { fontFamily: "'IBM Plex Sans', sans-serif" },
    });
    expect(resolveAppearance(themeToAppearance(theme)).terminal.fontFamily).toBe("'Fira Code', monospace");
  });

  it("skips blank token values", () => {
    const theme: DbxPluginTheme = {
      appearance: "light",
      tokens: { "--color-border": "  ", "--font-mono": "", "--font-sans": "  " },
    };
    expect(themeToAppearance(theme)).toEqual({ colorScheme: "light", colors: {} });
  });
});

describe("themeToAppearance + resolveAppearance", () => {
  it("fills missing fields from the canonical palette of the pushed scheme", () => {
    const partial = themeToAppearance({ appearance: "light", tokens: { "--color-background": "#fff" } });
    const resolved = resolveAppearance(partial);
    expect(resolved.colorScheme).toBe("light");
    expect(resolved.colors.background).toBe("#fff");
    expect(resolved.colors.foreground).toBe(resolveAppearance({ colorScheme: "light" }).colors.foreground);
    // 缺失 --font-mono 时回退本地规范值。
    expect(resolved.terminal.fontFamily).toBe(resolveAppearance().terminal.fontFamily);
  });
});
