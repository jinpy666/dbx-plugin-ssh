// @vitest-environment happy-dom
// terminalAnchor 单测：锁死 xterm buffer 行号语义，防止 ghost/建议浮层锚点
// 公式回归（历史缺陷：用 `cursorY - viewportY` 求可见行，回滚区出现后为负，
// overlay 画出画布；用 `cursorY + viewportY` 采样光标行，上滚时采到滚回区旧行）。
import { describe, expect, it } from "vitest";
import { cursorAbsoluteRow, cursorViewportRow, type CursorBufferLike } from "./terminalAnchor";

const ROWS = 24;
const BUFFER_LENGTH = 124; // 100 行滚回 + 24 行视口

/**
 * 伪造一个带滚回区的 buffer：viewportY ≠ baseY 表示用户已上滚（视口顶不在
 * 贴底位置），这是旧公式翻车的场景。
 */
function scrolledBackBuffer(overrides: Partial<CursorBufferLike> = {}): CursorBufferLike {
  return {
    // 贴底时视口顶 = BUFFER_LENGTH - ROWS；上滚 40 行后视口顶 = 60。
    baseY: BUFFER_LENGTH - ROWS, // 100
    viewportY: 60,
    cursorY: 10, // 视口内第 10 行（0..ROWS-1），对应缓冲绝对行 110
    ...overrides,
  };
}

describe("cursorViewportRow (overlay 像素锚点的可见行)", () => {
  it("returns cursorY as-is: it is already viewport-relative (0..rows-1)", () => {
    const buffer = scrolledBackBuffer();
    expect(cursorViewportRow(buffer)).toBe(10);
  });

  it("stays on-canvas when scrollback exists and viewportY !== baseY (old formula went negative)", () => {
    const buffer = scrolledBackBuffer();
    // 旧公式 `cursorY - viewportY` = 10 - 60 = -50：负行号，overlay 画出画布顶。
    expect(buffer.cursorY - buffer.viewportY).toBeLessThan(0);
    // 新公式落在视口内。
    const visibleRow = cursorViewportRow(buffer);
    expect(visibleRow).toBeGreaterThanOrEqual(0);
    expect(visibleRow).toBeLessThan(ROWS);
  });

  it("matches viewport-relative semantics at the bottom (viewportY === baseY)", () => {
    const buffer = scrolledBackBuffer({ viewportY: BUFFER_LENGTH - ROWS });
    expect(cursorViewportRow(buffer)).toBe(10);
  });
});

describe("cursorAbsoluteRow (buffer.getLine 采样的绝对行)", () => {
  it("samples the cursor's buffer row as baseY + cursorY, not viewportY + cursorY", () => {
    const buffer = scrolledBackBuffer();
    // 光标在缓冲绝对行 110；旧公式 `cursorY + viewportY` = 70 会采到滚回区旧行。
    expect(cursorAbsoluteRow(buffer)).toBe(110);
    expect(buffer.cursorY + buffer.viewportY).toBe(70);
  });

  it("equals baseY + cursorY when scrolled to the bottom", () => {
    const buffer = scrolledBackBuffer({ viewportY: BUFFER_LENGTH - ROWS });
    expect(cursorAbsoluteRow(buffer)).toBe(BUFFER_LENGTH - ROWS + 10);
  });
});
