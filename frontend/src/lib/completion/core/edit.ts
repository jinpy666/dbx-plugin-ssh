// 补全编辑操作（FIG wave-1 Lane A'）：CompletionEdit 的构造与应用。
// 编辑操作由 parser/resolver 产生，UI 只执行（方案 §5.2）——App.vue 的接受
// 路径不再自行拼字符串，统一走这里的小纯函数。类型来自冻结契约
// core/types.ts（只 import 不改）。

import type { CompletionEdit } from "./types";

export interface AppliedEdit {
  text: string;
  cursor: number;
}

/**
 * 把 CompletionEdit 应用到行文本：用 edit.text 替换 [replaceStart, replaceEnd)
 * 表面范围。cursorOffset 缺省 = edit.text.length（光标落在替换文本尾）。
 * 范围越界时向行界收敛（防御：行漂移时按最近可用位置拼接，不抛错——
 * 补全任何一层失败不得影响 PTY 输入链路）。
 */
export function applyEditToText(text: string, edit: CompletionEdit): AppliedEdit {
  const length = text.length;
  const start = Math.min(Math.max(0, edit.replaceStart), length);
  const end = Math.min(Math.max(start, edit.replaceEnd), length);
  const next = text.slice(0, start) + edit.text + text.slice(end);
  const cursor = start + (edit.cursorOffset ?? edit.text.length);
  return { text: next, cursor };
}

/**
 * 行尾 token 替换的 edit 构造（App 的行漂移兜底 / 测试用）：
 * 把行尾最后一个非空白段（含引号/转义表面）作为替换范围，用 token 整体
 * 替换；addSpace 时 text 尾补一个空格。行尾是空白（或空行）时范围退化为
 * 行尾纯插入点（start === end === text.length）。
 */
export function trailingTokenEdit(text: string, token: string, addSpace: boolean): CompletionEdit {
  const trailing = /\S+$/.exec(text);
  const start = trailing ? trailing.index : text.length;
  return {
    text: token + (addSpace ? " " : ""),
    replaceStart: start,
    replaceEnd: text.length,
  };
}

/**
 * 多候选 Tab 的最长公共前缀 edit（批 4b，对标 Warp `prefix.rs::longest_common_prefix`
 * 与 shell 补全语义）：所有候选共享同一替换区间（replaceStart/replaceEnd 逐项
 * 相同）时，返回以候选文本最长公共前缀为 text 的 edit；否则返回 null（调用方
 * 回落到接受高亮项）。公共前缀必须比行内区间现文本更长（有真实推进）才算命中
 * ——已到公共边界时返回 null，保持菜单打开即可（shell 的"响铃列清单"等价物）。
 */
export function longestCommonPrefixEdit(items: ReadonlyArray<{ edit: CompletionEdit }>, line: string): CompletionEdit | null {
  if (items.length < 2) return null;
  const first = items[0]!.edit;
  for (const item of items) {
    if (item.edit.replaceStart !== first.replaceStart || item.edit.replaceEnd !== first.replaceEnd) return null;
  }
  let prefix = first.text;
  for (const item of items) {
    const candidate = item.edit.text;
    const limit = Math.min(prefix.length, candidate.length);
    let shared = 0;
    while (shared < limit && prefix[shared] === candidate[shared]) shared += 1;
    prefix = prefix.slice(0, shared);
    if (!prefix) return null;
  }
  const start = Math.min(Math.max(0, first.replaceStart), line.length);
  const end = Math.min(Math.max(start, first.replaceEnd), line.length);
  if (prefix.length <= end - start) return null;
  return { text: prefix, replaceStart: first.replaceStart, replaceEnd: first.replaceEnd };
}
