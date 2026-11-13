// 预览编辑态快捷键（issue #288）：Ctrl/Cmd+S 保存、Esc 退出编辑文本框。
// 纯映射函数，App.vue 的 onDocumentKeydown 只在「预览打开且处于编辑态」时调用，
// 因此这里的判定不需要知道弹窗状态，便于单测覆盖各修饰键组合。

export type PreviewEditKeyAction = "save" | "exit" | null;

export interface PreviewEditKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * - save：Ctrl+S / Cmd+S（不叠加 Alt/Shift，避免撞上浏览器「另存为」组合）。
 * - exit：裸 Esc（带 Ctrl/Cmd/Alt 的 Esc 留给系统/终端组合，不劫持）。
 * - null：其余按键一律放行。
 */
export function previewEditKeyAction(event: PreviewEditKeyEvent): PreviewEditKeyAction {
  if (event.key === "Escape") {
    return event.ctrlKey || event.metaKey || event.altKey ? null : "exit";
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "s" || event.key === "S")
  ) {
    return "save";
  }
  return null;
}
