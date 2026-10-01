// 空提示符快捷键引导条（引导 Warp 对齐批次的新键位）：空行静置时在光标行
// 上方浮出一条半透明 kbd 提示——↑ 历史 / Ctrl+R 搜索历史（Warp Command
// Search 默认键）/ Ctrl+Space 补全候选 / → 接受行内建议。纯逻辑层只管两件
// 事：pluginStore 持久化（设置开关 + 一次性消散旗标）与显隐门判定；锚点
// 采样、渲染与「用过即散」的调用点都在 App.vue / 组件。

import { pluginStore } from "./pluginStore";

const PROMPT_HINTS_ENABLED_STORE = "ssh-terminal-prompt-hints-enabled";
const PROMPT_HINTS_DISMISSED_STORE = "ssh-terminal-prompt-hints-dismissed";

/** 设置开关（命令建议分栏）：默认开；关闭即彻底不弹（并保留消散旗标）。 */
export function loadPromptHintsEnabled(): boolean {
  try {
    return pluginStore.getItem(PROMPT_HINTS_ENABLED_STORE) !== "0";
  } catch {
    return true;
  }
}

export function savePromptHintsEnabled(value: boolean) {
  try {
    pluginStore.setItem(PROMPT_HINTS_ENABLED_STORE, value ? "1" : "0");
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}

/** 一次性消散旗标：用户点 ✗ 或实际用过任一被引导的功能（开面板/手动补全/
 *  接受 ghost）即置位，此后不再弹；设置里重开开关时清零。 */
export function loadPromptHintsDismissed(): boolean {
  try {
    return pluginStore.getItem(PROMPT_HINTS_DISMISSED_STORE) === "1";
  } catch {
    return false;
  }
}

export function savePromptHintsDismissed(value: boolean) {
  try {
    pluginStore.setItem(PROMPT_HINTS_DISMISSED_STORE, value ? "1" : "0");
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
}

/** 显隐门（纯函数供单测）：调用方逐项传入当前终端/浮层状态。 */
export interface PromptHintsGates {
  /** 设置开关。 */
  enabled: boolean;
  /** 一次性消散旗标。 */
  dismissed: boolean;
  /** 会话在场（SSH 已连或本地终端在跑）：未连接的空终端不引导。 */
  sessionActive: boolean;
  /** 行缓冲为空（提示符静置态）。 */
  lineEmpty: boolean;
  /** xterm 处于 alternate buffer（vim/tmux 等整屏接管）。 */
  alternateActive: boolean;
  /** 远端命令执行中。 */
  commandRunning: boolean;
  /** zmodem/trzsz 传输占用输入流。 */
  transferBusy: boolean;
  /** 任一既有浮层开启（建议/补全/history 面板/quick-select/终端搜索）。 */
  overlayOpen: boolean;
}

export function shouldShowPromptHints(gates: PromptHintsGates): boolean {
  return (
    gates.enabled &&
    !gates.dismissed &&
    gates.sessionActive &&
    gates.lineEmpty &&
    !gates.alternateActive &&
    !gates.commandRunning &&
    !gates.transferBusy &&
    !gates.overlayOpen
  );
}
