// 工具栏连接色染色（P2-4）：dark 沿用 10% 染色惯例；light 压到 4%——
// 10% 蓝染叠 muted-foreground（#737373）的会话状态 pill 实测对比度 ≈4.2:1
// （AA 边缘以下），4% 时 ≥4.5:1。内描边 alpha 同步减半保持观感一致。
import type { CSSProperties } from "vue";

export const TOOLBAR_TINT_ALPHA: Record<"dark" | "light", number> = { dark: 0.1, light: 0.04 };
export const TOOLBAR_TINT_EDGE_ALPHA: Record<"dark" | "light", number> = { dark: 0.18, light: 0.08 };

function colorWithAlpha(color: string, alpha: number) {
  const match = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  const hex = match[1].length === 3 ? [...match[1]].map((part) => `${part}${part}`).join("") : match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgb(${red} ${green} ${blue} / ${alpha})`;
}

export function toolbarTintStyle(color: string | undefined, colorScheme: "light" | "dark"): CSSProperties | undefined {
  if (!color) return undefined;
  const scheme = colorScheme === "light" ? "light" : "dark";
  return {
    backgroundColor: colorWithAlpha(color, TOOLBAR_TINT_ALPHA[scheme]),
    boxShadow: `inset 0 1px 0 ${colorWithAlpha(color, TOOLBAR_TINT_EDGE_ALPHA[scheme])}`,
  };
}
