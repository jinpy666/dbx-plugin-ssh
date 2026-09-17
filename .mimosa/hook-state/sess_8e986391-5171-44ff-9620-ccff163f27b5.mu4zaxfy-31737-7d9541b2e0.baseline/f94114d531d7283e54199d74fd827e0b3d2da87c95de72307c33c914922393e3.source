/**
 * 行内重命名提交守卫（UI_SCAN R3-P1-2 / R3-P2-1）：
 * blur 是"卸载/失焦"的兜底提交入口，但 Esc 取消（输入框被卸载）与 Enter
 * 提交中（输入框失焦）都会触发幽灵 blur。守卫规则：
 * - 提交中（submitting）一律拒绝 → Enter 双发短路；
 * - 编辑态已不在本行（Esc 已清 renamingPath、或已提交完成清空）一律拒绝
 *   → 取消语义不再被 blur 以草稿名逃逸提交。
 */
export function shouldCommitRename(input: { editingPath: string; entryUri: string; submitting: boolean }): boolean {
  if (input.submitting) return false;
  return input.editingPath === input.entryUri;
}
