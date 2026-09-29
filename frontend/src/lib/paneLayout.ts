// 面板分栏让宽的纯计算（App.vue terminalBasis 共用）。
// Docker 面板为 metrics-float 同款浮层，不参与分栏让宽；只有 SFTP 分栏
// 需要终端让出份额。

/** 终端 flex-basis：SFTP 分栏开时按用户拖拽比例让出份额，
 *  SFTP flex:1 吸收剩余——两栏同显，谁也不挤没谁。 */
export function terminalFlexBasis(input: { sftpOpen: boolean; splitRatio: number }): string {
  if (input.sftpOpen) return `${input.splitRatio}%`;
  return "100%";
}
