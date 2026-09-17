/**
 * 文件行键盘语义（UI_SCAN R3-P2-5）：文件行获得焦点后的按键 → 动作决策纯
 * 函数，对齐主流文件管理器（VS Code 等）：
 * - Enter = 打开（目录进入 / 文件预览），任何模式下可用；
 * - F2 = 重命名、Delete = 删除，仅可写连接可用；
 * - 其余按键返回 null（不拦截，交给按钮默认行为与全局快捷键）。
 */
export type FileRowAction = "open" | "rename" | "delete";

export function decideFileRowAction(key: string, canWrite: boolean): FileRowAction | null {
  if (key === "Enter") return "open";
  if (!canWrite) return null;
  if (key === "F2") return "rename";
  if (key === "Delete") return "delete";
  return null;
}
