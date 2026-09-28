// 补全编辑操作（FIG wave-1 Lane A）：CompletionEdit 的构造与应用。
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
 * 行尾 token 替换的 edit 构造（legacy adapter 与 App 的行漂移兜底共用）：
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
