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

/**
 * SFTP 面板级按键语义（issue #337）：行级 F2/Delete 只在行持有焦点时生效，
 * 面板级补齐空白/工具栏按钮焦点场景。F2 仅单选生效（对齐资源管理器：多选
 * 不重命名）；Delete 按选择规模分流——单选走单项确认、多选走批量确认。
 * 只读连接与空选不接管；Enter 不接管（面板级回车无统一语义，交给焦点元素
 * 默认行为）。Backspace 有意不放行删除：macOS 键盘 Delete 键即 Backspace，
 * 行级语义同为仅认 "Delete"，保持一致（误删代价不对称，宁缺勿滥）。
 */
export type SftpPaneAction = "rename" | "delete-single" | "delete-multi";

export function decideSftpPaneAction(key: string, canWrite: boolean, selectionCount: number): SftpPaneAction | null {
  if (!canWrite || selectionCount <= 0) return null;
  if (key === "F2") return selectionCount === 1 ? "rename" : null;
  if (key === "Delete") return selectionCount === 1 ? "delete-single" : "delete-multi";
  return null;
}
