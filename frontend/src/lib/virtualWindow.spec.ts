// virtualWindow 纯函数单测：窗口边界、overscan、钳制与退化输入。
import { describe, expect, it } from "vitest";
import { computeWindow } from "./virtualWindow";

const ROW = 30;

function win(scrollTop: number, viewportHeight: number, total: number, overscan = 10) {
  return computeWindow({ scrollTop, viewportHeight, rowHeight: ROW, total, overscan });
}

describe("computeWindow", () => {
  it("renders an empty window for an empty list or hidden viewport", () => {
    expect(win(0, 600, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(win(0, 0, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(win(0, -1, 500)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("at the top renders the first page plus overscan on both sides", () => {
    // 视口 600px = 20 行，overscan 10 → 最多 40 行；100 条 → 0..40。
    expect(win(0, 600, 100)).toEqual({ start: 0, end: 40, padTop: 0, padBottom: (100 - 40) * ROW });
  });

  it("slides the window with scroll and clamps start at zero", () => {
    // scrollTop 600 = 第 20 行 → start 20-10=10，end 10+40=50。
    expect(win(600, 600, 1000).start).toBe(10);
    expect(win(600, 600, 1000).end).toBe(50);
    // 负 scrollTop 视为 0。
    expect(win(-50, 600, 1000).start).toBe(0);
  });

  it("clamps end at the last row near the bottom", () => {
    // 滚到底：100 行总高 3000，视口 600 → 最大合法 scrollTop 2400（浏览器
    // 会把超界值钳到这里）→ start 80-10=70，end 钳到 100。
    const result = win(2400, 600, 100);
    expect(result.start).toBe(70);
    expect(result.end).toBe(100);
    expect(result.padBottom).toBe(0);
  });

  it("keeps pads consistent: padTop + rows + padBottom === total height", () => {
    for (const scrollTop of [0, 300, 1200, 2900]) {
      const result = win(scrollTop, 600, 100);
      const rowCount = result.end - result.start;
      expect(result.padTop + rowCount * ROW + result.padBottom).toBe(100 * ROW);
    }
  });

  it("short lists render everything without pads", () => {
    expect(win(0, 600, 5)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 });
  });

  it("tolerates degenerate row heights and negative overscan", () => {
    const result = computeWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 0, total: 50, overscan: -3 });
    // rowHeight 钳到 1：50 行全在窗口内。
    expect(result.end).toBe(50);
  });
});
