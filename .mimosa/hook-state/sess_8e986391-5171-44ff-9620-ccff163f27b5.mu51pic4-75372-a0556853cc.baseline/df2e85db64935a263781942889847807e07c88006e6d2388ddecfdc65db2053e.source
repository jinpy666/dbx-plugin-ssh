// 薄 spec：验证 shared/frontend/themeSync 在本插件工具链下 import 解析与行为成立。
import { describe, expect, it } from "vitest";
import { themeBridgeCss, THEME_BRIDGE_STYLE_ID } from "../../../shared/frontend/themeSync";

describe("themeBridgeCss", () => {
  it("bridges plugin vars onto host theme tokens", () => {
    const css = themeBridgeCss();
    expect(css).toContain("--background:var(--color-background,#131416)");
    expect(css).toContain("--primary:var(--color-primary,#3b82f6)");
    expect(css).toContain("--popover:var(--color-popover,");
    expect(css).toContain("--terminal-font-family:var(--font-mono,");
    expect(css).toContain("--mono-font-family:var(--font-mono,");
    expect(css).toContain(':root[data-dbx-theme="light"],:root[data-theme="light"]{color-scheme:light}');
  });

  it("bridges semantic status colors and the overlay scrim", () => {
    const css = themeBridgeCss();
    expect(css).toContain("--success:var(--color-success,");
    expect(css).toContain("--success-bg:var(--color-success-bg,");
    expect(css).toContain("--warning:var(--color-warning,");
    expect(css).toContain("--warning-bg:var(--color-warning-bg,");
    expect(css).toContain("--overlay:rgb(0 0 0 / 40%)");
    // Host API 1.0 / mock（无 --color-* 令牌）时按宿主明暗规范值回退。
    expect(css).toContain(':root[data-dbx-theme="light"],:root[data-theme="light"]{--success:var(--color-success,rgb(22 163 74));--warning:var(--color-warning,rgb(217 119 6));--info:var(--color-info,rgb(37 99 235))}');
    // 暗色遮罩走背景 mix，双属性分支谁先到都生效。
    expect(css).toContain(':root[data-dbx-theme="dark"],:root[data-theme="dark"]{--overlay:color-mix(in srgb, var(--background) 70%, transparent)}');
  });

  it("allows per-plugin fallback overrides", () => {
    const css = themeBridgeCss({ "--background": "#000000" });
    expect(css).toContain("--background:var(--color-background,#000000)");
    expect(css).toContain("--foreground:var(--color-foreground,#d7d7db)");
  });

  it("exposes the stable style element id", () => {
    expect(THEME_BRIDGE_STYLE_ID).toBe("dbx-host-theme-bridge");
  });
});
