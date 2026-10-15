// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  lineColumnTable,
  matchToColumns,
  type ColumnCellSource,
  type ColumnSpan,
  type ColumnTableSource,
} from "./terminalLineColumns";

// 假行：只实现 xterm IBufferLine 的取字与列号语义
// （xterm.js src/common/buffer/BufferLine.ts）：逐格取字 → 每个 UTF-16 单元记同一列 →
// 宽字符按两列前进（宽度 0 的占位格因此被跳过）→ 末尾补一列哨兵。
interface FakeCell {
  chars: string;
  width: number;
}

interface FakeLine extends ColumnTableSource {
  text: string;
}

/**
 * `fillOutColumns: false` 模拟公开包装类（`BufferApiView.getLine()` 返回的对象）：
 * 它只转发 3 个参数，第 4 个 outColumns 会被丢掉。
 */
function fakeLine(cells: FakeCell[], fillOutColumns = true): FakeLine {
  const trimmedLength = () => {
    let end = cells.length;
    while (end > 0 && !cells[end - 1].chars) end -= 1;
    return end;
  };
  const translateToString = (trimRight = false, startCol = 0, endCol = cells.length, outColumns?: number[]) => {
    if (trimRight) endCol = Math.min(endCol, trimmedLength());
    if (fillOutColumns && outColumns) outColumns.length = 0;
    const chars: string[] = [];
    let col = startCol;
    while (col < endCol) {
      const cell = cells[col];
      const text = cell.chars || " ";
      chars.push(text);
      if (fillOutColumns && outColumns) for (let i = 0; i < text.length; i += 1) outColumns.push(col);
      col += cell.width || 1;
    }
    if (fillOutColumns && outColumns) outColumns.push(col);
    return chars.join("");
  };
  const getCell = (x: number): ColumnCellSource | undefined => {
    const cell = cells[x];
    if (!cell) return undefined;
    return { getChars: () => cell.chars, getWidth: () => cell.width };
  };
  // text 与 translateToString(true) 同口径，断言里当基准文本用。
  return { text: translateToString(true), translateToString, length: cells.length, getCell };
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

  it("walks cells when the public wrapper drops outColumns", () => {
    // 公开 IBufferLine 包装类只转发 3 个参数（outColumns 永远是空表）：
    // 这时必须走 getCell 兜底，否则整条修复在真实终端里静默失效。
    const line = fakeLine([...wide("登录："), ...narrow(" Tue Oct 13 13:56:18")], false);
    expect(line.text).toBe("登录： Tue Oct 13 13:56:18");
    const start = line.text.indexOf("Oct");
    expect(span(line, start, line.text.length)).toEqual({ x: 11, width: 15 });
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

  it("keeps the sentinel in the walk fallback when the line ends on a wide character", () => {
    const line = fakeLine(wide("键值"), false);
    expect(line.text).toBe("键值");
    // 2 个宽字符占 4 列：文本下标 0/1 落在第 0/2 列，末尾哨兵是第 4 列。
    expect(span(line, 0, line.text.length)).toEqual({ x: 0, width: 4 });
    expect(lineColumnTable(line, line.text.length)).toEqual([0, 2, 4]);
  });

  it("leaves surrogate pairs unshifted because they already occupy two columns", () => {
    const line = row(wide("😀"), narrow("ab"));
    expect(line.text).toBe("😀ab");
    expect(line.text.length).toBe(4);
    expect(span(line, 2, 4)).toEqual({ x: 2, width: 2 });
  });

  it("falls back to indices when neither the table nor cells are available", () => {
    // 旧版 xterm 没有 outColumns 且行对象不给 getCell：返回 undefined，退回下标口径（旧行为）。
    const legacy: ColumnTableSource = { translateToString: () => "中文 abc" };
    expect(lineColumnTable(legacy, "中文 abc".length)).toBeUndefined();
    expect(matchToColumns(undefined, 3, 6)).toEqual({ x: 3, width: 3 });
  });

  it("never reports a negative width", () => {
    expect(matchToColumns(undefined, 5, 5)).toEqual({ x: 5, width: 0 });
    expect(matchToColumns([0, 2, 4, 6], 2, 2)).toEqual({ x: 4, width: 0 });
  });
});

// 真实内核回归锚点：公开包装类丢掉 outColumns 是 6.1.0-beta.304 的实测行为，
// 这段用例是「修复是否真的生效」的唯一可信证据——只喂假行的规格测试会一路绿过去。
describe("terminal line column table (real xterm core)", () => {
  const lastbLine = "最后一次失败的登录：  Thu Oct 15 12:24:09 CST 2026 从 110.40.156.247 ssh:notty 上";

  async function realLine(text: string, cols = 200) {
    const term = new Terminal({ allowProposedApi: true, cols, rows: 6 });
    term.write(`${text}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const buffer = term.buffer.active;
    return { term, line: buffer.getLine(buffer.baseY)! };
  }

  it("builds the column table for the real public IBufferLine", async () => {
    const { term, line } = await realLine(lastbLine);
    const text = line.translateToString(true);
    expect(text).toBe(lastbLine);
    const table = lineColumnTable(line, text.length);
    expect(table).toBeDefined();
    // 前 10 个字符是双宽 CJK：下标 16 的 "Oct" 落在第 26 列，下标 43 的 IP 落在第 54 列。
    expect(table![text.indexOf("Oct")]).toBe(26);
    expect(table![text.indexOf("110.40")]).toBe(54);
    term.dispose();
  });

  it("maps the lastb-style matches onto the glyphs they matched", async () => {
    const { term, line } = await realLine(lastbLine);
    const text = line.translateToString(true);
    const table = lineColumnTable(line, text.length);
    // 规则 "Oct 15 12:24:09"（下标 16..31）与 "110.40.156.247"（下标 43..57）。
    expect(matchToColumns(table, text.indexOf("Oct"), text.indexOf("Oct") + 15)).toEqual({ x: 26, width: 15 });
    expect(matchToColumns(table, text.indexOf("110.40"), text.indexOf("110.40") + 14)).toEqual({
      x: 54,
      width: 14,
    });
    term.dispose();
  });
});
