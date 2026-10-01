// ghost 接受键配置（批 4e，对标 Warp 的 Accept Autosuggestion 可重绑）：
// 默认裸 →（fish 口径），可选 Ctrl+→ / Shift+→ / Tab。Tab 选项会与「补全
// 菜单的 Tab 接受 / shell 路径补全」冲突——这是用户显式自担的选择（Warp 同
// 款：设置里选 Tab 时提示补全菜单改绑 Ctrl+Space；我们当前菜单 Tab 恒定，
// 选 Tab 即明确放弃菜单 Tab），UI 上给警示文案即可，不做自动改绑。
// 存 pluginStore；匹配为纯函数供 App 的按键分支调用。

import { pluginStore } from "./pluginStore";

export type GhostAcceptKey = "ArrowRight" | "CtrlArrowRight" | "ShiftArrowRight" | "Tab";

const GHOST_ACCEPT_KEY_STORE = "ssh-ghost-accept-key";
const GHOST_ACCEPT_KEY_VALUES: ReadonlySet<string> = new Set(["ArrowRight", "CtrlArrowRight", "ShiftArrowRight", "Tab"]);

export function sanitizeGhostAcceptKey(value: unknown): GhostAcceptKey {
  return typeof value === "string" && GHOST_ACCEPT_KEY_VALUES.has(value) ? (value as GhostAcceptKey) : "ArrowRight";
}

export function loadGhostAcceptKey(): GhostAcceptKey {
  try {
    return sanitizeGhostAcceptKey(pluginStore.getItem(GHOST_ACCEPT_KEY_STORE));
  } catch {
    return "ArrowRight";
  }
}

export function saveGhostAcceptKey(value: GhostAcceptKey) {
  try {
    pluginStore.setItem(GHOST_ACCEPT_KEY_STORE, value);
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}

export interface GhostKeyModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 事件是否命中配置的接受键（纯函数）。裸 → 不接受任何修饰；Ctrl+→ 排除
 *  Shift（Ctrl+Shift+→ 仍归逐词接受，Windows/Linux 口径）；Tab 选项不接受
 *  修饰（避免与浏览器焦点循环/其它 Tab 组合混淆）。 */
export function matchesGhostAcceptKey(configured: GhostAcceptKey, eventKey: string, modifiers: GhostKeyModifiers): boolean {
  const { ctrlKey, metaKey, altKey, shiftKey } = modifiers;
  if (eventKey === "ArrowRight") {
    if (configured === "ArrowRight") return !ctrlKey && !metaKey && !altKey && !shiftKey;
    if (configured === "CtrlArrowRight") return ctrlKey && !shiftKey && !metaKey && !altKey;
    if (configured === "ShiftArrowRight") return shiftKey && !ctrlKey && !metaKey && !altKey;
    return false;
  }
  if (eventKey === "Tab" && configured === "Tab") return !ctrlKey && !metaKey && !altKey && !shiftKey;
  return false;
}
