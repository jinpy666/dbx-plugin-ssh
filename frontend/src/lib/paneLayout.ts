// 面板分栏让宽的纯计算（App.vue terminalBasis / Docker 面板拖宽共用）。
// Docker 停靠面板宽度经 CSS 变量 --docker-pane-width 下发，终端、SFTP、
// Docker 三段的让宽口径必须同源，否则同开时会互相挤占（SFTP flex:1 被
// 压成 0 宽，见「Docker 面板遮挡 SFTP」修复）。

/** Docker 面板拖宽下限：对齐旧 CSS clamp 的 320px 下限。 */
export const DOCKER_PANE_MIN_WIDTH = 320;
/** Docker 面板拖宽上限：不超过分栏容器宽度的 70%，给终端留最小可用区。 */
export const DOCKER_PANE_MAX_SHARE = 0.7;

/** 终端 flex-basis：按「SFTP 开 / Docker 开」组合让出对应宽度。
 *  两者同开时终端在「(100% - Docker 宽)」内按 SFTP 比例取份额，
 *  SFTP flex:1 吸收剩余——三栏同显，谁也不挤没谁。 */
export function terminalFlexBasis(input: { sftpOpen: boolean; dockerOpen: boolean; splitRatio: number }): string {
  if (input.sftpOpen && input.dockerOpen) {
    const ratio = Math.min(100, Math.max(0, input.splitRatio)) / 100;
    return `calc((100% - var(--docker-pane-width)) * ${ratio})`;
  }
  if (input.sftpOpen) return `${input.splitRatio}%`;
  if (input.dockerOpen) return "calc(100% - var(--docker-pane-width))";
  return "100%";
}

/** Docker 面板宽度钳制：[320px, max(320px, 容器宽 70%)]，四舍五入到整像素。 */
export function clampDockerPaneWidth(px: number, containerWidth: number): number {
  const max = Math.max(DOCKER_PANE_MIN_WIDTH, Math.round(containerWidth * DOCKER_PANE_MAX_SHARE));
  return Math.round(Math.min(Math.max(px, DOCKER_PANE_MIN_WIDTH), max));
}
