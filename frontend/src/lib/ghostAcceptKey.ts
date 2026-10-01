// ghost 接受键（对齐 Warp Autosuggestions 键位模型）：
// - 整段接受恒可用三键：裸 →、Ctrl+F（readline forward-char）、Ctrl+E
//   （readline end-of-line；我们只在光标行尾出 ghost，此时 Ctrl+E 在远端
//   readline 中是 no-op，拦截安全）——Warp 文档口径，三键并存不可拆；
// - 逐词接受：Ctrl+→ / Ctrl+Shift+→（macOS / Windows·Linux 同收，Warp 同款）；
// - 「Tab 接受建议」为可选开关（Warp Settings > Features > Terminal Input 的
//   Tab key behavior）：开启后 Tab 在 ghost 在场且无菜单时接受整段；补全
//   菜单开着时 Tab 仍归菜单（结构化候选优先）。这是与远端 shell Tab 补全的
//   显式取舍，默认关闭。
// 匹配为纯函数供 App 的按键分支调用；开关存 pluginStore。

import { pluginStore } from "./pluginStore";

const GHOST_TAB_ACCEPT_STORE = "ssh-ghost-tab-accept";

export function loadGhostTabAccept(): boolean {
  try {
    return pluginStore.getItem(GHOST_TAB_ACCEPT_STORE) === "1";
  } catch {
    return false;
  }
}

export function saveGhostTabAccept(value: boolean) {
  try {
    pluginStore.setItem(GHOST_TAB_ACCEPT_STORE, value ? "1" : "0");
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

/** 整段接受命中（纯函数）：裸 →（零修饰）/ Ctrl+F / Ctrl+E（Ctrl 系不含
 *  Shift·Meta·Alt——Cmd 系留给宿主，Shift 组合留给逐词）。仅在有 ghost 时
 *  调用，因此不会抢远端 readline 的同名键。 */
export function matchesGhostFullAccept(eventKey: string, modifiers: GhostKeyModifiers): boolean {
  const { ctrlKey, metaKey, altKey, shiftKey } = modifiers;
  if (eventKey === "ArrowRight") return !ctrlKey && !metaKey && !altKey && !shiftKey;
  if (ctrlKey && !metaKey && !altKey && !shiftKey) {
    const key = eventKey.toLowerCase();
    return key === "f" || key === "e";
  }
  return false;
}

/** 逐词接受命中（纯函数）：Ctrl+→ 与 Ctrl+Shift+→（Warp：macOS 取前者、
 *  Windows/Linux 取后者，我们两者同收）；Meta/Alt 组合不认。 */
export function matchesGhostWordAccept(eventKey: string, modifiers: GhostKeyModifiers): boolean {
  const { ctrlKey, metaKey, altKey } = modifiers;
  return eventKey === "ArrowRight" && ctrlKey && !metaKey && !altKey;
}
