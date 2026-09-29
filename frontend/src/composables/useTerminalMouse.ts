import type { TerminalBehaviorSettings } from "../lib/terminalBehavior";
import { type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import { isLinkModifierSatisfied } from "../lib/terminalBehavior";
import { cellFromMouseEvent, clickCursorArrows, resolveClickCursorMove } from "../lib/terminalClickCursor";
import { resolveTerminalInputRoute } from "../lib/terminalTrzsz";

/** 终端鼠标交互：链接修饰键点击（防反向标签劫持）、中键粘贴、Ctrl+滚轮
 * 缩放、点击定位光标（iTerm2/kitty 风格，占用态不代发方向键）。 */
export function useTerminalMouse(options: {
  terminalBehavior: Ref<TerminalBehaviorSettings>;
  terminalMenuOpen: Ref<boolean>;
  closeFileMenu: () => void;
  pasteTerminal: () => Promise<void> | void;
  adjustTerminalZoom: (delta: number) => void;
  terminal: () => Terminal | undefined;
  getTerminalHost: () => HTMLElement | null | undefined;
  session: Ref<{ sessionId?: string } | undefined>;
  sendTerminalBytes: (data: Uint8Array) => void;
  zmodemBusy: () => boolean;
  trzszBusy: () => boolean;
}) {
  const { terminalBehavior, terminalMenuOpen, closeFileMenu, pasteTerminal, adjustTerminalZoom, terminal: terminalGet, getTerminalHost, session, sendTerminalBytes, zmodemBusy, trzszBusy } = options;

let terminalMouseDownAt: { clientX: number; clientY: number } | undefined;

function openTerminalLink(event: MouseEvent, uri: string) {
  if (!isLinkModifierSatisfied(terminalBehavior.value, event)) return;
  const opened = window.open();
  if (!opened) return;
  try {
    opened.opener = null;
  } catch {
    // Electron 等环境写入 opener 会抛错；与内置处理器同样忽略。
  }
  opened.location.href = uri;
}

/**
 * 中键粘贴（对标 Tabby「Mouse → Paste on middle-click」，默认关闭）。
 * 仅当设置开启时消费事件：默认放行，保持浏览器既有行为不变。
 */
function handleTerminalMiddleClick(event: MouseEvent) {
  if (!terminalBehavior.value.pasteOnMiddleClick) return;
  event.preventDefault();
  terminalMenuOpen.value = false;
  closeFileMenu();
  void pasteTerminal();
}


function handleTerminalWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  adjustTerminalZoom(event.deltaY < 0 ? 1 : -1);
}

// 点击定位光标（iTerm2/kitty 风格）：readline 只认按键，所以在光标所在逻辑行内
// 的“原地点击”（无拖拽成选区）换算成 N 次左右方向键发给远端；行外点击不动作，
// 避免方向键把 shell 翻进历史命令。鼠标上报（vim/htop）与备用屏（TUI 全屏应用）
// 时点击属于应用自身语义，一律不代发。
function handleTerminalMouseDown(event: MouseEvent) {
  terminalMouseDownAt = event.button === 0 ? { clientX: event.clientX, clientY: event.clientY } : undefined;
}

function handleTerminalMouseUp(event: MouseEvent) {
  const down = terminalMouseDownAt;
  terminalMouseDownAt = undefined;
  const term = terminalGet();
  const host = getTerminalHost();
  if (!down || !term || !host || !session.value) return;
  if (term.hasSelection()) return;
  if (Math.abs(event.clientX - down.clientX) > 2 || Math.abs(event.clientY - down.clientY) > 2) return;
  if (term.modes.mouseTrackingMode !== "none") return;
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return;
  const click = cellFromMouseEvent(host, { cols: term.cols, rows: term.rows }, event.clientX, event.clientY);
  if (!click) return;
  const move = resolveClickCursorMove({ buffer, cols: term.cols, click });
  if (!move) return;
  const route = resolveTerminalInputRoute({ zmodemBusy: zmodemBusy(), trzszBusy: trzszBusy() });
  if (route !== "pty") return;
  sendTerminalBytes(new TextEncoder().encode(clickCursorArrows(move)));
}


  return {
    openTerminalLink,
    handleTerminalMiddleClick,
    handleTerminalWheel,
    handleTerminalMouseDown,
    handleTerminalMouseUp,
  };
}
