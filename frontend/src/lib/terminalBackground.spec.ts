// 终端底色净化单测（issue #73）：覆盖"可证明 xterm 落黑"的三类取值与必须原样
// 透传的宿主取值。真实解析语义用 xterm 的等价规则在测试内复刻——xterm 的
// `css.toColor` 只可靠处理 hex / 逗号 rgb()/rgba()，其余靠 canvas 探针，探针在
// node 环境拿不到 fillStyle，故这里以"是否属于这三类"建模，不引入 DOM 依赖。
import { describe, expect, it } from "vitest";
import { DBX_APPEARANCE_PALETTES } from "./appearance";
import { isUnusableTerminalBackground, sanitizeTerminalBackground } from "./terminalBackground";

const DARK_FALLBACK = DBX_APPEARANCE_PALETTES.dark.background;
const LIGHT_FALLBACK = DBX_APPEARANCE_PALETTES.light.background;

describe("isUnusableTerminalBackground", () => {
  it("flags the literal transparent keyword regardless of case", () => {
    expect(isUnusableTerminalBackground("transparent")).toBe(true);
    expect(isUnusableTerminalBackground("TRANSPARENT")).toBe(true);
    expect(isUnusableTerminalBackground("  Transparent  ")).toBe(true);
  });

  it("flags values that need the cascade to resolve", () => {
    // 宿主设背景图时最常下发的就是这两类：xterm 的 canvas 探针在 detached
    // 上下文取不到级联值，抛 "Unsupported css format" → 回退 #000。
    expect(isUnusableTerminalBackground("var(--color-background)")).toBe(true);
    expect(isUnusableTerminalBackground("color-mix(in srgb, #131416 94%, #000)")).toBe(true);
    expect(isUnusableTerminalBackground("light-dark(#ffffff, #131416)")).toBe(true);
    expect(isUnusableTerminalBackground("calc(1px + 1px)")).toBe(true);
    expect(isUnusableTerminalBackground("env(safe-area-inset-top)")).toBe(true);
  });

  it("flags explicit zero alpha in hex and functional forms", () => {
    expect(isUnusableTerminalBackground("#13141600")).toBe(true);
    expect(isUnusableTerminalBackground("#0000")).toBe(true);
    expect(isUnusableTerminalBackground("rgba(19, 20, 22, 0)")).toBe(true);
    expect(isUnusableTerminalBackground("rgba(19,20,22,0.0)")).toBe(true);
    expect(isUnusableTerminalBackground("rgb(19 20 22 / 0%)")).toBe(true);
  });

  it("keeps usable host colours out of the fallback path", () => {
    for (const usable of [
      "#131416",
      "#abc",
      "rgb(19, 20, 22)",
      "rgb(19 20 22)",
      "rgba(19, 20, 22, 0.28)",
      "rgb(110 110 114 / 28%)",
      "hsl(210 10% 10%)",
      "rebeccapurple",
      "#131416ff",
    ]) {
      expect(isUnusableTerminalBackground(usable), usable).toBe(false);
    }
  });
});

describe("sanitizeTerminalBackground", () => {
  it("falls back for non-strings, blanks and zero-alpha values", () => {
    for (const broken of [undefined, null, 42, {}, [], "", "   ", "transparent", "#13141600", "rgba(19,20,22,0)"]) {
      expect(sanitizeTerminalBackground(broken, "dark"), String(broken)).toBe(DARK_FALLBACK);
      expect(sanitizeTerminalBackground(broken, "light"), String(broken)).toBe(LIGHT_FALLBACK);
    }
  });

  it("falls back for cascade-dependent forms that xterm cannot resolve", () => {
    expect(sanitizeTerminalBackground("var(--color-background)", "dark")).toBe(DARK_FALLBACK);
    expect(sanitizeTerminalBackground("color-mix(in srgb, var(--color-background) 62%, transparent)", "dark")).toBe(DARK_FALLBACK);
    expect(sanitizeTerminalBackground("color-mix(in srgb, #131416 94%, #000)", "light")).toBe(LIGHT_FALLBACK);
  });

  it("passes usable host colours through untouched, trimmed of surrounding space", () => {
    expect(sanitizeTerminalBackground("#101010", "dark")).toBe("#101010");
    expect(sanitizeTerminalBackground("  rgb(19 20 22)  ", "dark")).toBe("rgb(19 20 22)");
    expect(sanitizeTerminalBackground("rgba(19, 20, 22, 0.28)", "light")).toBe("rgba(19, 20, 22, 0.28)");
    // 判不了的不等于坏值：hsl/命名色交 xterm 自己的解析路径，不做插件侧改写。
    expect(sanitizeTerminalBackground("hsl(210 10% 10%)", "dark")).toBe("hsl(210 10% 10%)");
    expect(sanitizeTerminalBackground("rebeccapurple", "dark")).toBe("rebeccapurple");
  });

  it("uses the canonical palette colour for the requested scheme as the fallback", () => {
    // 回退值必须来自当前明暗的规范色板，否则浅色主题会退回深色底。
    expect(sanitizeTerminalBackground("transparent", "light")).toBe(DBX_APPEARANCE_PALETTES.light.background);
    expect(sanitizeTerminalBackground("transparent", "dark")).toBe(DBX_APPEARANCE_PALETTES.dark.background);
    expect(DARK_FALLBACK).not.toBe(LIGHT_FALLBACK);
  });

  it("keeps the canonical palette values themselves usable", () => {
    // 规范色板是回退源，若它自己的取值被判为不可用就会失去兜底意义。
    for (const scheme of ["light", "dark"] as const) {
      const canonical = DBX_APPEARANCE_PALETTES[scheme].background;
      expect(isUnusableTerminalBackground(canonical), `${scheme}: ${canonical}`).toBe(false);
      expect(sanitizeTerminalBackground(canonical, scheme)).toBe(canonical);
    }
  });
});
