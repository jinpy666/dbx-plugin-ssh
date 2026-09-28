// 补全候选排序（FIG wave-1 Lane A'）：引擎唯一排序出口——score 降序、
// 同分 label 字典序（确定序）、截断到 MAX_COMPLETION_ITEMS；所有 source
// （Lane C' 的 fig 引擎 / 批次 2 的 generator 结果）的候选都经这里排序后
// 才进 UI，杜绝各来源私自排序的口径分叉。

import type { CompletionItem } from "./types";

export const MAX_COMPLETION_ITEMS = 20;

/**
 * score 降序、同分 label 字典序（确定序）、截断到 MAX_COMPLETION_ITEMS。
 * 纯函数：不修改入参数组。
 */
export function rankItems(items: CompletionItem[]): CompletionItem[] {
  return [...items]
    .sort((a, b) => (b.score - a.score) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, MAX_COMPLETION_ITEMS);
}
