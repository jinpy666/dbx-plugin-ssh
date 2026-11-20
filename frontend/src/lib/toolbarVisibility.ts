// 工具栏按钮可配置隐藏（issue #309）：工作台顶部 icon 按钮多且无文字说明，
// 用户（SFTP 之外）常用度差异大。设置·终端「工具栏按钮」分组逐按钮开关，
// 隐藏状态单键 JSON 存 pluginStore，模式照抄 aiSettings.ts。
// 口径：
// - 默认全部显示，与改动前零差异；
// - 只覆盖次要工具按钮（录制/录像、端口映射、监控、Docker、批量发送、快捷
//   命令、Agent、审计日志、自定义列、传输等）；连接/重连、SFTP 面板、会话
//   下拉、设置等核心入口保持常显，不进本清单；
// - 隐藏只影响主 SSH 工作台工具条（!panelSurface），RDP/VNC 专属工具组与
//   dock 面板精简工具条不受影响；
// - 隐藏后的按钮对应功能经会话下拉/设置等既有入口仍可达（如录制功能仍在
//   录像面板可管理），本开关只收敛工具条视觉密度。

import { pluginStore } from "./pluginStore";

export const TOOLBAR_VISIBILITY_STORE_KEY = "ssh-toolbar-hidden-buttons";

/** 可隐藏按钮清单：id + 设置页展示文案（复用工具条既有 tooltip 键，零新增文案）。 */
export interface ToolbarButtonDef {
  id: ToolbarButtonId;
  /** 复用的 i18n 键（工具条 title 已在用，七语齐全）。 */
  labelKey: string;
}

export type ToolbarButtonId =
  | "copySession"
  | "splitPane"
  | "alertTriage"
  | "forwards"
  | "monitor"
  | "docker"
  | "batchSend"
  | "quickCommands"
  | "agentMode"
  | "metrics"
  | "recording"
  | "recordings"
  | "auditLog"
  | "columns"
  | "transfers";

/** 与 App.vue 工具条渲染顺序一致，设置页逐行开关也按此顺序展示。 */
export const TOOLBAR_BUTTONS: readonly ToolbarButtonDef[] = [
  { id: "copySession", labelKey: "copySessionTab" },
  { id: "splitPane", labelKey: "splitPaneToggle" },
  { id: "alertTriage", labelKey: "alertTriage.title" },
  { id: "forwards", labelKey: "forwards.title" },
  { id: "monitor", labelKey: "monitor.title" },
  { id: "docker", labelKey: "docker.toolbarTitle" },
  { id: "batchSend", labelKey: "batchSendTitle" },
  { id: "quickCommands", labelKey: "quickCommands" },
  { id: "agentMode", labelKey: "agentTerminalSection" },
  { id: "metrics", labelKey: "metrics" },
  { id: "recording", labelKey: "recordingTitle" },
  { id: "recordings", labelKey: "recordingsTitle" },
  { id: "auditLog", labelKey: "auditLog.title" },
  { id: "columns", labelKey: "customizeColumns" },
  { id: "transfers", labelKey: "transfers" },
];

/** true = 显示。默认全部显示（false 才落盘，未登记 id 恒为显示）。 */
export type ToolbarVisibility = Record<ToolbarButtonId, boolean>;

export const TOOLBAR_HIDDEN_DEFAULTS: ToolbarVisibility = Object.fromEntries(
  TOOLBAR_BUTTONS.map((b) => [b.id, true]),
) as ToolbarVisibility;

/** 解析持久化值：逐项回退显示（旧版本/损坏值不整包失效），未知 id 丢弃。 */
export function sanitizeToolbarVisibility(raw: unknown): ToolbarVisibility {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const result = { ...TOOLBAR_HIDDEN_DEFAULTS };
  for (const b of TOOLBAR_BUTTONS) {
    if (source[b.id] === false) result[b.id] = false;
  }
  return result;
}

export function loadToolbarVisibility(): ToolbarVisibility {
  try {
    const raw = pluginStore.getItem(TOOLBAR_VISIBILITY_STORE_KEY);
    return sanitizeToolbarVisibility(raw == null || raw === "" ? undefined : JSON.parse(raw));
  } catch {
    return { ...TOOLBAR_HIDDEN_DEFAULTS };
  }
}

export function saveToolbarVisibility(visibility: ToolbarVisibility) {
  try {
    pluginStore.setItem(TOOLBAR_VISIBILITY_STORE_KEY, JSON.stringify(visibility));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}

/** 常显按钮（settings 等不进清单的 id）恒为显示。Partial：模板可用任意来源的显隐记录。 */
export function isToolbarButtonVisible(visibility: Partial<ToolbarVisibility>, id: string): boolean {
  return visibility[id as ToolbarButtonId] !== false;
}
