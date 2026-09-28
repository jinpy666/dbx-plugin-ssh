// 补全菜单键盘所有权（FIG wave-1 Lane A'，契约 §2.2 / 方案 §21）：纯函数固化
// 「菜单显示 ≠ 键盘所有权」的规则表。菜单开着时只接管 ↑↓/Tab（静态候选）/
// Esc；Enter 恒放行 shell 执行当前行，动态 hint 行（generator 位置，批次 2
// 经 completion/execute 接入；当前本地不可补全，远程 shell 是最后一级
// provider）与 loading 态的 Tab 同样放行。菜单关闭时按键一律归还 shell
// （Escape 除外——它是"无事可关"，交由其它浮层/面板自行处理）。补全任何
// 一层失败不得影响 PTY 输入链路：调用方对本模块的返回值执行，本模块自身
// 永不抛错、永不触碰终端。

import type { CompletionItemKind } from "./core/types";

export interface CompletionKeyboardState {
  menuOpen: boolean;
  hasItems: boolean;
  /** 高亮项 kind：null=无高亮；"hint"=动态占位行（Tab 透传）。 */
  activeItemKind: CompletionItemKind | null;
  loading: boolean;
}

export type CompletionKeyAction = "accept" | "passthrough" | "next" | "prev" | "close" | "none";

/** 当前高亮项是否可被 Tab 接受：有候选、非 loading、非 hint/无高亮。 */
function canAccept(state: CompletionKeyboardState): boolean {
  return state.hasItems && !state.loading && state.activeItemKind !== null && state.activeItemKind !== "hint";
}

/**
 * 规则表（契约 §2.2）：
 *
 * | menuOpen | activeItemKind        | Enter      | Tab        | ↑↓          | Esc   |
 * |----------|-----------------------|------------|------------|-------------|-------|
 * | true     | subcommand/option/…   | passthrough| accept     | next/prev   | close |
 * | true     | hint / 无候选 / loading| passthrough| passthrough| next/prev*  | close |
 * | false    | —                     | passthrough| passthrough| passthrough | none  |
 *
 * * 移动仅在 hasItems 时给出；无候选时返回 none（调用方原样放行）。
 */
export function resolveCompletionKey(state: CompletionKeyboardState, key: string): CompletionKeyAction {
  if (!state.menuOpen) {
    if (key === "Escape") return "none";
    if (key === "Enter" || key === "Tab" || key === "ArrowUp" || key === "ArrowDown") return "passthrough";
    return "none";
  }
  if (key === "Escape") return "close";
  if (key === "ArrowDown") return state.hasItems ? "next" : "none";
  if (key === "ArrowUp") return state.hasItems ? "prev" : "none";
  if (key === "Enter") return "passthrough";
  if (key === "Tab") return canAccept(state) ? "accept" : "passthrough";
  return "none";
}
