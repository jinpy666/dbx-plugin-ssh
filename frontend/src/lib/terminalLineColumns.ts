// 「字符串下标 → 单元格列号」换算：关键词高亮与动作链接的坐标口径修正。
//
// 命中来自 `IBufferLine.translateToString` 的文本，`match.start/end` 是文本下标；而
// xterm 的 `registerDecoration({ x, width })` 与 `ILink.range` 用的是单元格列号。两者
// 只在整行等宽（纯 ASCII）时才等价：宽字符（CJK、全角标点、emoji）在字符串里占 1 个
// UTF-16 单元、在终端里占 2 列，宽度为 0 的占位格不产生字符。把下标当列号会让命中区间
// 整体左移——前面有几个宽字符就少几列。中文行因此出现「高亮盖住前面的文字、真命中的
// 尾部没有颜色」的错位：行首的权限列没问题，越靠右的命中（IP、时间戳、JSON key）越歪，
// 严重时整段露白、看起来像"没生效"。
//
// 取列号有两条路，按可用性依次尝试：
// 1. xterm 6 的 `translateToString(trimRight, startColumn, endColumn, outColumns)`——
//    但它只存在于内核的**内部** BufferLine 上；公开 API 的包装类
//    （`lib/xterm.js` 的 `BufferApiView.getLine()`）只转发 3 个参数，公开的
//    `IBufferLine` typings 里也没有第 4 个参数，所以这条路口径正确却常常拿不到数据。
// 2. 公开 `IBufferLine.getCell(x)` + `IBufferCell.getChars()/getWidth()` 自己走格——
//    规则与内核逐格取字一致（宽字符按两列前进、宽度 0 的占位格被跳过、每个 UTF-16
//    单元记同一列、末尾补一列哨兵），只依赖公开契约。
//
// 两条都不行才退回下标口径（旧行为）：宁可保持旧行为，也不要拿半张表算出更偏的列号。

/** 本模块只依赖 `translateToString`：规格测试传假行即可，不必构造完整 IBufferLine。 */
export interface ColumnTableSource {
  translateToString(trimRight?: boolean, startCol?: number, endCol?: number, outColumns?: number[]): string;
  /** 公开 `IBufferLine.length`（列数上限）。缺失时不走走格兜底。 */
  readonly length?: number;
  /** 公开 `IBufferLine.getCell`。缺失时不走走格兜底。 */
  getCell?(x: number): ColumnCellSource | undefined;
}

/** 公开 `IBufferCell` 的子集：走格兜底只用到这两项。 */
export interface ColumnCellSource {
  getChars(): string;
  /** 宽字符 2、宽字符后的占位格 0、其余 1（见 `IBufferCell.getWidth` 的文档）。 */
  getWidth(): number;
}

/** 命中区间换算结果：装饰/链接用的列坐标。 */
export interface ColumnSpan {
  /** 起始列（0-based，与 registerDecoration 的 x 同口径）。 */
  x: number;
  /** 列宽（结束列 - 起始列，不会为负）。 */
  width: number;
}

/** 空白格在文本里的样子（与内核的 `WHITESPACE_CELL_CHAR` 同值）。 */
const WHITESPACE_CELL_CHAR = " ";

/**
 * 取「文本下标 → 列号」表：`columns[i]` 是第 i 个字符所在列，`columns[textLength]` 是
 * 文本结束后的下一列（与 xterm 的 outColumns 契约一致）。
 *
 * 调用方的 textLength 必须与同一行 `translateToString(true)` 的结果一致，否则表与文本
 * 错位。两条取表路都拿不到足额数据时返回 undefined，调用方退回下标口径（旧行为）。
 */
export function lineColumnTable(line: ColumnTableSource, textLength: number): number[] | undefined {
  if (textLength <= 0) return undefined;
  const columns: number[] = [];
  line.translateToString(true, 0, undefined, columns);
  if (columns.length >= textLength + 1) return columns;
  // 公开包装类丢掉了 outColumns（见文件头）：用公开 getCell 自己走格，等价口径。
  return walkColumnTable(line, textLength);
}

/** 按公开 `getCell` 逐格复刻内核的取字/列号规则。 */
function walkColumnTable(line: ColumnTableSource, textLength: number): number[] | undefined {
  const getCell = line.getCell;
  const limit = line.length;
  if (typeof getCell !== "function" || typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  const columns: number[] = [];
  let col = 0;
  while (col < limit && columns.length <= textLength) {
    const cell = getCell.call(line, col);
    const chars = cell?.getChars() || WHITESPACE_CELL_CHAR;
    for (let i = 0; i < chars.length && columns.length <= textLength; i += 1) columns.push(col);
    const width = cell?.getWidth();
    col += width && width > 0 ? width : 1;
  }
  // 收尾哨兵：最后一个字符之后的那一列。循环因列数上限退出时才需要补。
  if (columns.length <= textLength) columns.push(col);
  return columns.length >= textLength + 1 ? columns : undefined;
}

/** 命中区间（文本下标）→ x/width（列号）；没有列号表时退回下标口径（旧行为）。 */
export function matchToColumns(columns: readonly number[] | undefined, start: number, end: number): ColumnSpan {
  const indexWidth = Math.max(0, end - start);
  if (!columns) return { x: start, width: indexWidth };
  const x = columns[start] ?? start;
  const next = columns[end] ?? x + indexWidth;
  return { x, width: Math.max(0, next - x) };
}
