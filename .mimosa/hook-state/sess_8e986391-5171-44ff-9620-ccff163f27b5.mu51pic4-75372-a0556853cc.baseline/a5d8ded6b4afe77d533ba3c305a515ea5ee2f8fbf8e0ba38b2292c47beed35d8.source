// 终端字号缩放范围（Ctrl+滚轮），基准值取宿主下发的字体设置。
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;

/** 在 [min, max] 区间内对当前字号施加步进；超界时钳制在边界值。 */
export function clampFontSize(current: number, delta: number, min = TERMINAL_FONT_MIN, max = TERMINAL_FONT_MAX): number {
  return Math.min(max, Math.max(min, current + delta));
}
