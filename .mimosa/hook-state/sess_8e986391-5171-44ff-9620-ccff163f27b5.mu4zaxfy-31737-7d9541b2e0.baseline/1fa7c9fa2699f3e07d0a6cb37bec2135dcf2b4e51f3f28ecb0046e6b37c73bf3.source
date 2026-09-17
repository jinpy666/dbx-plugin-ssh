/**
 * Click-to-move-cursor (iTerm2/kitty style): a plain click inside the logical
 * line the shell cursor sits on moves the readline cursor by synthesizing
 * left/right arrow escape sequences. Everything here is pure computation so
 * the geometry can be unit tested without a live xterm instance.
 *
 * Terminals cannot move the shell prompt cursor "directly" — readline only
 * understands keypresses — so the best faithful behavior is: clicks on the
 * current input line translate to N cursor-left/right keys; clicks anywhere
 * else (scrolled-back output, other lines) do nothing instead of walking the
 * shell through command history.
 */

export interface CellPoint {
  col: number;
  row: number;
}

export interface BufferCellLike {
  /** 0 = continuation half of a wide char, 1 = narrow, 2 = wide char start. */
  getWidth(): number;
}

export interface BufferLineLike {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(col: number): BufferCellLike | undefined;
}

export interface ActiveBufferLike {
  readonly type: "normal" | "alternate";
  readonly viewportY: number;
  readonly cursorX: number;
  /** Viewport-relative cursor line. */
  readonly cursorY: number;
  getLine(row: number): BufferLineLike | undefined;
}

export interface ClickCursorContext {
  buffer: ActiveBufferLike;
  cols: number;
  /** Viewport-relative click cell. */
  click: CellPoint;
}

export interface ClickCursorMove {
  direction: "left" | "right";
  count: number;
}

/** Bound for one click; far below the history-walk disaster threshold. */
export const CLICK_CURSOR_MAX_MOVES = 1000;

/**
 * Convert a mouse position to a viewport cell. Uses the `.xterm-screen`
 * element (exactly cols×rows cells wide) so viewport scrollbar padding never
 * skews the column math.
 */
export function cellFromMouseEvent(
  host: HTMLElement,
  grid: { cols: number; rows: number },
  clientX: number,
  clientY: number,
): CellPoint | null {
  if (grid.cols <= 0 || grid.rows <= 0) return null;
  const screen = host.querySelector<HTMLElement>(".xterm-screen") ?? host;
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * grid.cols);
  const row = Math.floor(((clientY - rect.top) / rect.height) * grid.rows);
  if (col < 0 || row < 0 || row >= grid.rows) return null;
  return { col, row };
}

/** Logical (unwrapped) line span containing `row`, walking isWrapped chains. */
export function logicalLineSpan(buffer: ActiveBufferLike, row: number): { top: number; bottom: number } {
  let top = row;
  // isWrapped 标在续行上（"wrapped from the previous line"）：top 行自己是续行，
  // 才说明它与上一行同属一个逻辑行。
  while (top > 0) {
    const current = buffer.getLine(top);
    if (!current?.isWrapped) break;
    top -= 1;
  }
  let bottom = row;
  for (;;) {
    const next = buffer.getLine(bottom + 1);
    if (!next?.isWrapped) break;
    bottom += 1;
  }
  return { top, bottom };
}

/** Characters strictly before `col` in the line (wide chars count once). */
function charCountUpTo(line: BufferLineLike, col: number): number {
  let count = 0;
  for (let x = 0; x < col && x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() > 0) count += 1;
  }
  return count;
}

function charCount(line: BufferLineLike): number {
  return charCountUpTo(line, line.length);
}

function logicalCharOffset(buffer: ActiveBufferLike, span: { top: number; bottom: number }, row: number, col: number): number {
  let offset = 0;
  for (let y = span.top; y < row; y += 1) {
    const line = buffer.getLine(y);
    if (line) offset += charCount(line);
  }
  const line = buffer.getLine(row);
  if (line) offset += charCountUpTo(line, col);
  return offset;
}

/**
 * Decide how the cursor should move for a click. Returns null when the click
 * must not synthesize keys: alternate screen apps, clicks outside the
 * cursor's logical line, or clicks already on the cursor.
 */
export function resolveClickCursorMove(context: ClickCursorContext): ClickCursorMove | null {
  const { buffer, cols, click } = context;
  if (buffer.type !== "normal") return null;
  const cursorRow = buffer.viewportY + buffer.cursorY;
  const clickRow = buffer.viewportY + click.row;
  const span = logicalLineSpan(buffer, cursorRow);
  if (clickRow < span.top || clickRow > span.bottom) return null;
  const clickCol = Math.max(0, Math.min(click.col, cols));
  const cursorOffset = logicalCharOffset(buffer, span, cursorRow, buffer.cursorX);
  const clickOffset = logicalCharOffset(buffer, span, clickRow, clickCol);
  const delta = clickOffset - cursorOffset;
  if (delta === 0) return null;
  const count = Math.min(Math.abs(delta), CLICK_CURSOR_MAX_MOVES);
  return { direction: delta < 0 ? "left" : "right", count };
}

/** Arrow escape sequences a readline-style shell understands, repeated. */
export function clickCursorArrows(move: ClickCursorMove): string {
  return (move.direction === "left" ? "\u001b[D" : "\u001b[C").repeat(move.count);
}
