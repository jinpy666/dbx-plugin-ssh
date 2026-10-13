import { describe, expect, it } from "vitest";
import { lineColumnTable, matchToColumns, type ColumnSpan, type ColumnTableSource } from "./terminalLineColumns";

// 假行：只实现 xterm IBufferLine.translateToString 的取字与列号语义
// （xterm.js src/common/buffer/BufferLine.ts）：逐格取字 → 每个 UTF-16 单元记同一列 →
// 宽字符按两列前进（宽度 0 的占位格因此被跳过）→ 末尾补一列哨兵。
interface FakeCell {
  chars: string;
  width: number;
}

interface FakeLine extends ColumnTableSource {
  text: string;
}

function fakeLine(cells: FakeCell[]): FakeLine {
  const trimmedLength = () => {
    let end = cells.length;
    while (end > 0 && !cells[end - 1].chars) end -= 1;
    return end;
  };
  const translateToString = (trimRight = false, startCol = 0, endCol = cells.length, outColumns?: number[]) => {
    if (trimRight) endCol = Math.min(endCol, trimmedLength());
    if (outColumns) outColumns.length = 0;
    const chars: string[] = [];
    let col = startCol;
    while (col < endCol) {
      const cell = cells[col];
      const text = cell.chars || " ";
      chars.push(text);
      if (outColumns) for (let i = 0; i < text.length; i += 1) outColumns.push(col);
      col += cell.width || 1;
    }
    if (outColumns) outColumns.push(col);
    return chars.join("");
  };
  // text 与 translateToString(true) 同口径，断言里当基准文本用。
  return { text: translateToString(true), translateToString };
}

/** 一个字符一列的文本。 */
const narrow = (text: string): FakeCell[] => [...text].map((chars) => ({ chars, width: 1 }));
/** 宽字符（CJK、全角标点）：一个字符占两列，后跟一个宽度 0 的占位格（终端缓冲区就是这样）。 */
const wide = (text: string): FakeCell[] =>
  [...text].flatMap((chars) => [
    { chars, width: 2 },
    { chars: "", width: 0 },
  ]);
const row = (...parts: FakeCell[][]): FakeLine => fakeLine(parts.flat());

/** 按「下标命中」换算列区间——这是接线层真正要用的那一跳。 */
const span = (line: FakeLine, start: number, end: number): ColumnSpan =>
  matchToColumns(lineColumnTable(line, line.text.length), start, end);

describe("terminal line column table", () => {
  it("keeps index equal to column for plain ASCII lines", () => {
    const line = row(narrow("eth0 192.168.1.7 up"));
    expect(line.text).toBe("eth0 192.168.1.7 up");
    expect(span(line, 5, 16)).toEqual({ x: 5, width: 11 });
  });

  it("shifts a match after wide characters onto its real columns", () => {
    // lastb 风格行：3 个双宽字符让下标比列号少 3——时间戳会整体左移盖住前面的文字。
    const line = row(wide("登录："), narrow(" Tue Oct 13 13:56:18"));
    expect(line.text).toBe("登录： Tue Oct 13 13:56:18");
    const start = line.text.indexOf("Oct");
    const end = line.text.length;
    // 3 个双宽字符占 6 列，加 " Tue " 5 列 → Oct 在第 11 列，而下标只有 8。
    expect(start).toBe(8);
    expect(lineColumnTable(line, line.text.length)![start]).toBe(11);
    expect(span(line, start, end)).toEqual({ x: 11, width: 15 });
  });

  it("measures a match that spans wide and narrow text in columns, not code units", () => {
    const line = row(narrow('"'), wide("值"), narrow('": 1'));
    expect(line.text).toBe('"值": 1');
    expect(line.text.length).toBe(6);
    // 6 个 UTF-16 单元，但显示占 7 列：start 端点取到的是哨兵列。
    expect(span(line, 0, line.text.length)).toEqual({ x: 0, width: 7 });
  });

  it("puts a match ending at the line end on the sentinel column", () => {
    const line = row(wide("键"), narrow(" value"));
    const start = line.text.indexOf("value");
    expect(span(line, start, line.text.length)).toEqual({ x: 3, width: 5 });
  });

  it("leaves surrogate pairs unshifted because they already occupy two columns", () => {
    const line = row(wide("😀"), narrow("ab"));
    expect(line.text).toBe("😀ab");
    expect(line.text.length).toBe(4);
    expect(span(line, 2, 4)).toEqual({ x: 2, width: 2 });
  });

  it("falls back to indices when the line cannot fill the column table", () => {
    // 旧版 xterm 没有 outColumns：表填不满 → 返回 undefined，退回下标口径（旧行为）。
    const legacy: ColumnTableSource = { translateToString: () => "中文 abc" };
    expect(lineColumnTable(legacy, "中文 abc".length)).toBeUndefined();
    expect(matchToColumns(undefined, 3, 6)).toEqual({ x: 3, width: 3 });
  });

  it("never reports a negative width", () => {
    expect(matchToColumns(undefined, 5, 5)).toEqual({ x: 5, width: 0 });
    expect(matchToColumns([0, 2, 4, 6], 2, 2)).toEqual({ x: 4, width: 0 });
  });
});
