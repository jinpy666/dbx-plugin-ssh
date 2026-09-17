import { describe, expect, it } from "vitest";
import { DBX_APPEARANCE_PALETTES, DBX_POPOVER, resolveAppearance, TERMINAL_ANSI } from "./appearance";

describe("appearance resolution", () => {
  it("falls back to the DBX dark spec tokens when the host sends nothing", () => {
    const appearance = resolveAppearance();
    expect(appearance.colorScheme).toBe("dark");
    expect(appearance.colors).toEqual(DBX_APPEARANCE_PALETTES.dark);
    expect(appearance.terminal.fontSize).toBe(13);
  });

  it("maps the white theme to the DBX light (pearl) spec tokens", () => {
    const appearance = resolveAppearance({ colorScheme: "light" });
    expect(appearance.colorScheme).toBe("light");
    expect(appearance.colors).toEqual(DBX_APPEARANCE_PALETTES.light);
    expect(appearance.colors.background).toBe("rgb(255 255 255)");
    expect(DBX_POPOVER.light).toBe("rgb(255 255 255)");
    expect(DBX_POPOVER.dark).not.toBe(DBX_APPEARANCE_PALETTES.dark.background);
  });

  it("merges partial host colors over the palette of the requested scheme", () => {
    const appearance = resolveAppearance({
      colorScheme: "light",
      colors: { background: "#fefefe" } as DbxPluginAppearance["colors"],
    });
    expect(appearance.colors.background).toBe("#fefefe");
    expect(appearance.colors.foreground).toBe(DBX_APPEARANCE_PALETTES.light.foreground);
    expect(appearance.colors.muted).toBe(DBX_APPEARANCE_PALETTES.light.muted);
  });

  it("ignores blank colors and invalid terminal fonts", () => {
    const appearance = resolveAppearance({
      colors: { background: "  ", destructive: "" } as Partial<DbxPluginAppearance["colors"]> as DbxPluginAppearance["colors"],
      terminal: { fontFamily: "  ", fontSize: 0 },
    });
    expect(appearance.colors.background).toBe(DBX_APPEARANCE_PALETTES.dark.background);
    expect(appearance.colors.destructive).toBe(DBX_APPEARANCE_PALETTES.dark.destructive);
    expect(appearance.terminal.fontFamily).toContain("Cascadia Mono");
    expect(appearance.terminal.fontSize).toBe(13);
  });

  it("keeps host terminal and ui fonts when they are usable", () => {
    const appearance = resolveAppearance({
      terminal: { fontFamily: "JetBrains Mono", fontSize: 14 },
      ui: { fontFamily: "SF Pro" },
    });
    expect(appearance.terminal).toEqual({ fontFamily: "JetBrains Mono", fontSize: 14 });
    expect(appearance.ui?.fontFamily).toBe("SF Pro");
  });

  it("keeps both ANSI palettes complete and light readable on white", () => {
    for (const scheme of ["light", "dark"] as const) {
      const palette = TERMINAL_ANSI[scheme];
      const keys = Object.keys(palette);
      expect(keys).toHaveLength(16);
      for (const key of keys) expect(palette[key as keyof typeof palette]).toMatch(/^#/);
    }
    // 纯白在白底终端里不可见；brightWhite 必须是可辨识的灰。
    expect(TERMINAL_ANSI.light.brightWhite).not.toBe("#ffffff");
  });
});
