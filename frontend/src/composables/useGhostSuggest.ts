import type { Terminal } from "@xterm/xterm";
import type { QuickCommand } from "../lib/quickCommands";
import { ref, type Ref } from "vue";
import { pluginStore } from "../lib/pluginStore";
import { cursorAbsoluteRow } from "../lib/terminalAnchor";
import { classifyGhostInput, createGhostState, evaluateGhost, nextGhostState, ghostMenuSuppressed, type TerminalGhostState } from "../lib/terminalGhostSuggest";

/** 终端行内 ghost 自动建议（对标 Warp/fish autosuggest）：状态机纯逻辑在
 * lib/terminalGhostSuggest.ts；数据源即 commandHistory/quickCommands refs
 * （经 evaluateGhost 选项注入）。开关持久化在 SettingsDialog（pluginStore
 * 键 ssh-terminal-ghost-suggest，组件内自治），App 只持内存态、经
 * update:ghost-suggest 即时跟随；accept 直接写 PTY，等价用户键入。 */
export function useGhostSuggest(options: {
  terminal: () => Terminal | undefined;
  sendTerminalBytes: (data: Uint8Array) => void;
  getPendingTerminalInput: () => string;
  appendToPendingTerminalInput: (data: string) => void;
  commandRunning: Ref<boolean>;
  terminalTransferBusy: Ref<boolean>;
  commandHistory: Ref<string[]>;
  quickCommands: Ref<QuickCommand[]>;
  suggestionOpen: Ref<boolean>;
  completionOpen: Ref<boolean>;
  /** Warp 式 history 面板开启期间不出 ghost（面板打字即过滤，同屏不叠两层）。 */
  historyPanelOpen: Ref<boolean>;
  completionController: { lineChanged(): void };
  suggestionMinCharsState: Ref<number>;
  suggestionMaxCharsState: Ref<number>;
  readTerminalCellFrame: () => { originLeft: number; originTop: number; cursorX: number; visibleRow: number; cellWidth: number; cellHeight: number } | null;
}) {
  const { terminal: terminalGet, sendTerminalBytes, getPendingTerminalInput, appendToPendingTerminalInput, commandRunning, terminalTransferBusy, commandHistory, quickCommands, suggestionOpen, completionOpen, historyPanelOpen, completionController, suggestionMinCharsState, suggestionMaxCharsState, readTerminalCellFrame } = options;

// —— 终端行内 ghost 自动建议（对标 Warp/fish autosuggest）——状态机纯逻辑在
// lib/terminalGhostSuggest.ts；数据源即上方 commandHistory/quickCommands refs
// （经 evaluateGhost 选项注入，不新建存储）。开关持久化在 SettingsDialog
// （pluginStore 键 ssh-terminal-ghost-suggest，组件内自治），App 只持内存态、
// 经 update:ghost-suggest 即时跟随；acceptPayload 直接写 PTY，等价用户键入。
const GHOST_SUGGEST_KEY = "ssh-terminal-ghost-suggest";
function loadGhostSuggestEnabled(): boolean {
  try {
    return pluginStore.getItem(GHOST_SUGGEST_KEY) !== "0";
  } catch {
    return true;
  }
}
const ghostEnabled = ref(loadGhostSuggestEnabled());
const ghostMatch = ref<{ command: string; remainder: string } | null>(null);
const ghostAnchor = ref<{ x: number; y: number } | null>(null);
// 门状态非响应式：只有 evaluateGhost 的产物（ghostMatch）进渲染。
let ghostGate: TerminalGhostState = createGhostState();

function setGhostEnabled(next: boolean) {
  ghostEnabled.value = next;
  if (!next) hideGhostSuggestion();
}

function hideGhostSuggestion() {
  ghostMatch.value = null;
}

/** 会话切换/断开：门锁存与展示一并复位（与 closeSuggestions 同点调用）。 */
function resetGhostSuggestion() {
  ghostGate = createGhostState();
  ghostMatch.value = null;
}

/**
 * 光标行采样：光标右侧到行尾无字符、且逻辑行未向下折行时视为「光标在行尾」。
 * 纯 buffer 读取，与字宽无关；读不到 buffer（渲染器未就绪/备用屏）时保守返回
 * false——不出 ghost 优于错位注入。
 */
function terminalCursorAtLineEnd(): boolean {
  const term = terminalGet();
  if (!term) return false;
  try {
    const buffer = term.buffer.active;
    if (buffer.type !== "normal") return false;
    // 光标行按缓冲绝对行号采样：baseY + cursorY（cursorY 是视口内相对行，
    // viewportY 随用户滚动偏移，`cursorY + viewportY` 上滚时会采到滚回区旧行）。
    const rowY = cursorAbsoluteRow(buffer);
    const row = buffer.getLine(rowY);
    if (!row) return false;
    for (let x = buffer.cursorX; x < term.cols; x += 1) {
      if (row.getCell(x)?.getChars()) return false;
    }
    // 折行命令的后续视觉行仍属同一逻辑行：光标在视觉行尾 ≠ 逻辑行尾。
    if (buffer.getLine(rowY + 1)?.isWrapped) return false;
    return true;
  } catch {
    return false;
  }
}

/** ghost 专用锚点：光标像素坐标（灰字从光标格起绘，y 取光标行行顶）。 */
/** ghost 行内建议锚点：与建议浮层同一光标格换算（含 .xterm-screen 原点，
 *  可配置内边距自动计入），盖在光标行上。 */
function readGhostAnchor(): { x: number; y: number } | null {
  const frame = readTerminalCellFrame();
  if (!frame) return null;
  return {
    x: Math.round(frame.originLeft + frame.cursorX * frame.cellWidth),
    y: Math.round(frame.originTop + frame.visibleRow * frame.cellHeight),
  };
}

/** onData 每次输入后调用：推进门状态并重算 ghost（与浮层建议同一采样点）。 */
function refreshGhostAfterInput(data: string) {
  ghostGate = nextGhostState(ghostGate, classifyGhostInput(data));
  updateGhostSuggestion();
}

function updateGhostSuggestion() {
  // 浮层建议/结构化补全菜单开着时不出 ghost：菜单占用 →/Enter/Esc，与
  // 「→ 仅在无菜单态下接受」一致，同屏叠两层建议也无法阅读。
  // history 面板同理：面板开启期间继续打字是过滤输入，不出 ghost。
  if (ghostMenuSuppressed(suggestionOpen.value, completionOpen.value) || historyPanelOpen.value) {
    ghostMatch.value = null;
    return;
  }
  const evaluation = evaluateGhost({
    state: ghostGate,
    line: getPendingTerminalInput(),
    cursorAtLineEnd: terminalCursorAtLineEnd(),
    enabled: ghostEnabled.value,
    // 远端命令执行中 / zmodem、trzsz 传输占用流时不出建议（任务约束）。
    commandRunning: commandRunning.value || terminalTransferBusy.value,
    compositionActive: false,
    sources: { history: commandHistory.value, quickCommands: quickCommands.value },
    bounds: {
      minLength: Math.max(1, suggestionMinCharsState.value),
      maxLength: Math.max(suggestionMinCharsState.value, suggestionMaxCharsState.value),
      limit: 12,
    },
  });
  ghostMatch.value = evaluation.match;
  if (evaluation.match) ghostAnchor.value = readGhostAnchor();
}

/** → 接受：向 PTY 注入剩余字节（等价用户逐键键入；按键轨迹缓冲同步补齐）。 */
function acceptGhostSuggestion() {
  const match = ghostMatch.value;
  if (!match || !match.remainder) return;
  ghostMatch.value = null;
  appendToPendingTerminalInput(match.remainder);
  sendTerminalBytes(new TextEncoder().encode(match.remainder));
  // ghost 接受同样推进行缓冲（FIG wave-1 锚点）：作废在途结构化补全结果
  // 并防抖重算（补全后的行可能命中引擎候选）。
  completionController.lineChanged();
  // 接受后按新行重算：更长同前缀历史可继续 → 扩展（fish 同款行为）。
  updateGhostSuggestion();
}


  return {
    ghostEnabled,
    ghostMatch,
    ghostAnchor,
    setGhostEnabled,
    hideGhostSuggestion,
    resetGhostSuggestion,
    refreshGhostAfterInput,
    acceptGhostSuggestion,
  };
}
