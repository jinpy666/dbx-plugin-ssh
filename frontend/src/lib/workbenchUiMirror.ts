// 工作台 UI 布局镜像（issue #178）：workbenchState 是 Host API 1.1 的可选
// 桥，宿主未实现时 window.dbxPlugin.workbenchState 为 undefined、
// hostContext.workbenchState 恒缺——paneOrder/自定义表头/SFTP 面板开合/
// 列宽等布局键在真机上整组静默不持久。本模块把同一份布局状态镜像进
// pluginStore（host.storage，单键 JSON），写穿双落、恢复作底层默认：
// 宿主有 workbenchState 时每工作台权威态优先（镜像只兜底），没有时镜像
// 即唯一持久层。会话作用域键（sessionId/terminalSequence/rdp 尺寸）不入
// 镜像——它们语义上属于单个工作台，不该跨工作台回放。

import { pluginStore } from "./pluginStore";

export const WORKBENCH_UI_MIRROR_KEY = "ssh-workbench-ui";

/** 与 App.vue WorkbenchState 的布局子集对齐（workbenchUiMirror.spec 钉住）。 */
export interface WorkbenchUiMirror {
  sftpPath?: string;
  followDirectory?: boolean;
  sudoMode?: boolean;
  splitRatio?: number;
  paneOrder?: "sftp-left" | "terminal-left";
  sftpPaneOpen?: boolean;
  visibleColumns?: string[];
  columnsV2?: boolean;
  sftpColumnWidths?: Record<string, number>;
  sftpNameWidth?: number | null;
  sftpShowHidden?: boolean;
  sftpSort?: { column: string; direction: "asc" | "desc" };
}

export function readWorkbenchUiMirror(): WorkbenchUiMirror {
  try {
    const raw = pluginStore.getItem(WORKBENCH_UI_MIRROR_KEY);
    if (typeof raw !== "string" || !raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as WorkbenchUiMirror) : {};
  } catch {
    return {};
  }
}

export function writeWorkbenchUiMirror(state: WorkbenchUiMirror): void {
  try {
    pluginStore.setItem(WORKBENCH_UI_MIRROR_KEY, JSON.stringify(state));
  } catch {
    // 镜像写失败不阻断：workbenchState 桥在的宿主仍整组持久。
  }
}
