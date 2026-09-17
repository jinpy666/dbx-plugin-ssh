import { describe, expect, it } from "vitest";
import { TOOLBAR_TINT_ALPHA, TOOLBAR_TINT_EDGE_ALPHA, toolbarTintStyle } from "./toolbarTint";

// 与 mockDbxHost 夹具一致的主题色板（DBX 规范块）：
// light 底 = 白、muted-foreground = #737373；dark 底 = rgb(19 20 22)、muted-foreground = #97989d；
// 连接色 = #3b82f6。P2-4 的验收口径：会话状态 pill（muted 文字）叠在染色工具栏上对比度 ≥ 4.5:1。
const CONNECTION_COLOR = "#3b82f6";
const LIGHT_BACKGROUND: Rgb = [255, 255, 255];
const LIGHT_MUTED_FOREGROUND: Rgb = [115, 115, 115];
const DARK_BACKGROUND: Rgb = [19, 20, 22];
const DARK_MUTED_FOREGROUND: Rgb = [151, 152, 157];

type Rgb = [number, number, number];

function parseRgb(value: string): { rgb: Rgb; alpha: number } {
  const match = value.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/);
  if (!match) throw new Error(`unexpected rgb string: ${value}`);
  return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha: Number(match[4]) };
}

function blendOver(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  return [0, 1, 2].map((index) => foreground[index] * alpha + background[index] * (1 - alpha)) as Rgb;
}

function channelLuminance(channel: number) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb) {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
}

function contrastRatio(a: Rgb, b: Rgb) {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function mutedContrastOnTint(background: Rgb, mutedForeground: Rgb, colorScheme: "light" | "dark") {
  const style = toolbarTintStyle(CONNECTION_COLOR, colorScheme)!;
  const tint = parseRgb(style.backgroundColor ?? "");
  return contrastRatio(mutedForeground, blendOver(tint.rgb, tint.alpha, background));
}

describe("toolbarTintStyle", () => {
  it("returns undefined when the connection has no color", () => {
    expect(toolbarTintStyle(undefined, "dark")).toBeUndefined();
    expect(toolbarTintStyle(undefined, "light")).toBeUndefined();
  });

  it("keeps the 10% tint convention in dark and halves it in light", () => {
    const dark = toolbarTintStyle(CONNECTION_COLOR, "dark")!;
    expect(parseRgb(dark.backgroundColor ?? "").alpha).toBe(TOOLBAR_TINT_ALPHA.dark);
    expect(dark.boxShadow ?? "").toContain(`/ ${TOOLBAR_TINT_EDGE_ALPHA.dark})`);
    const light = toolbarTintStyle(CONNECTION_COLOR, "light")!;
    expect(parseRgb(light.backgroundColor ?? "").alpha).toBe(TOOLBAR_TINT_ALPHA.light);
    expect(TOOLBAR_TINT_ALPHA.light).toBeLessThan(TOOLBAR_TINT_ALPHA.dark);
  });

  it("maps unknown color schemes onto the dark defaults", () => {
    // appearance 解析层保证 light|dark 之外不会出现，防御性收口到 dark 分支。
    const fallback = toolbarTintStyle(CONNECTION_COLOR, "nope" as "dark")!;
    expect(parseRgb(fallback.backgroundColor ?? "").alpha).toBe(TOOLBAR_TINT_ALPHA.dark);
  });

  it("keeps muted-foreground text at AA contrast on the tinted toolbar (light, P2-4)", () => {
    // 回归口径：light 10% 染色时该值 ≈4.22:1（AA 边缘以下）。
    expect(mutedContrastOnTint(LIGHT_BACKGROUND, LIGHT_MUTED_FOREGROUND, "light")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps muted-foreground text at AA contrast on the tinted toolbar (dark)", () => {
    expect(mutedContrastOnTint(DARK_BACKGROUND, DARK_MUTED_FOREGROUND, "dark")).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back to color-mix for non-hex connection colors", () => {
    const style = toolbarTintStyle("rgb(59 130 246)", "light")!;
    expect(style.backgroundColor ?? "").toBe(`color-mix(in srgb, rgb(59 130 246) ${Math.round(TOOLBAR_TINT_ALPHA.light * 100)}%, transparent)`);
  });
});
