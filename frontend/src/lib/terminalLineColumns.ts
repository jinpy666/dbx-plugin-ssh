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
// xterm 6 的 `translateToString(trimRight, startCol, endCol, outColumns)` 已经给出
// 「第 i 个字符显示在第几列」，本模块只做薄封装 + 兜底，不自己复刻取字规则（复刻一旦与
// xterm 版本漂移，错位会以更难查的方式回来）。

/** 本模块只依赖 `translateToString`：规格测试传假行即可，不必构造完整 IBufferLine。 */
export interface ColumnTableSource {
  translateToString(trimRight?: boolean, startCol?: number, endCol?: number, outColumns?: number[]): string;
}

/** 命中区间换算结果：装饰/链接用的列坐标。 */
export interface ColumnSpan {
  /** 起始列（0-based，与 registerDecoration 的 x 同口径）。 */
  x: number;
  /** 列宽（结束列 - 起始列，不会为负）。 */
  width: number;
}

/**
 * 取「文本下标 → 列号」表：`columns[i]` 是第 i 个字符所在列，`columns[textLength]` 是
 * 文本结束后的下一列（xterm 的 outColumns 契约）。
 *
 * 调用方的 textLength 必须与同一行 `translateToString(true)` 的结果一致，否则表与文本
 * 错位。旧版 xterm 没有 outColumns（表填不满）时返回 undefined，调用方退回下标口径：
 * 宁可保持旧行为，也不要拿半张表算出更偏的列号。
 */
export function lineColumnTable(line: ColumnTableSource, textLength: number): number[] | undefined {
  const columns: number[] = [];
  line.translateToString(true, 0, undefined, columns);
  if (columns.length < textLength + 1) return undefined;
  return columns;
}

/** 命中区间（文本下标）→ x/width（列号）；没有列号表时退回下标口径（旧行为）。 */
export function matchToColumns(columns: readonly number[] | undefined, start: number, end: number): ColumnSpan {
  const indexWidth = Math.max(0, end - start);
  if (!columns) return { x: start, width: indexWidth };
  const x = columns[start] ?? start;
  const next = columns[end] ?? x + indexWidth;
  return { x, width: Math.max(0, next - x) };
}
