// 补全候选排序（FIG wave-1 Lane A）：引擎唯一排序出口。排序语义与 legacy
// parser 的 rankRows 完全一致（score 降序、同分 label 字典序、截断到
// MAX_COMPLETION_ITEMS），golden parity 测试（legacySpecAdapter.spec.ts）
// 依赖这一等价性保证零回归。

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
