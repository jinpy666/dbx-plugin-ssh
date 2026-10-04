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
  /** `#` AI 命令搜索模式在场：该模式字节不进 PTY，lineEmpty 恒为真——
   *  不显式判位引导条会与 `#` 搜索条叠画（真机截图回归）。 */
  aiSearchActive: boolean;
  /** 终端输出活跃（最近 600ms 有输出）：登录 banner 刷屏期不弹，防遮挡。 */
  outputQuiet: boolean;
  /** 屏上有凭据输入提示（Password: 等）：密码处引导毫无意义还可能泄操作。 */
  passwordPromptOnScreen: boolean;
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
    !gates.overlayOpen &&
    !gates.aiSearchActive &&
    gates.outputQuiet &&
    !gates.passwordPromptOnScreen
  );
}


// —— 密码提示启发（2026-10-02 真机反馈）：`Password:`/`[sudo] password` 这类
// 凭据输入行长得和"空行提示符静置"一模一样（行缓冲口径恒空），但 ↑ 历史/
// 补全引导在密码输入处毫无意义还可能泄操作。采样文本命中即抑制引导条。
// `pass\s?phrase` 由 shared/prompt-corpus.json 语料对齐后端词表补录
// （「pass phrase:」带空格写法，改词表必须同步语料，见 promptCorpus.spec.ts）。
const PASSWORD_PROMPT_PATTERN =
  /(?:pass(?:word|wd|\s?phrase)|口令|密码)[^:：]*[:：]\s*$|^enter password\b/i;

/** 该行文本是否为凭据输入提示（trimEnd 后判定；空串恒 false）。 */
export function isPasswordPromptLine(text: string): boolean {
  const trimmed = (text ?? "").trimEnd();
  if (!trimmed) return false;
  return PASSWORD_PROMPT_PATTERN.test(trimmed);
}

// —— 放置侧（2026-10-02 体验反馈）：光标在第一行（刚登录/刚清屏）时上方
// 放不下引导条，翻到光标行下方——下方是空屏，不遮内容。纯几何供单测。

import { OVERLAY_GAP } from "./overlayPlacement";

/** 引导条单行高度回退值：实测前（挂载前/首帧）用常量判定，实测后按真值。 */
export const PROMPT_HINTS_FALLBACK_BAR_HEIGHT = 32;

/**
 * 引导条放置侧（纯几何）：默认「上方」（底边贴光标行顶，不遮输入行）；
 * 光标行上方放不下（第一行/近顶）时翻「下方」（顶边贴光标行底，恰好盖住
 * 空屏区）。视口不可测或条高不可测时保持上方（调用方 CSS fallback 兜底）。
 */
export function choosePromptHintsPlacement(anchorTopY: number, viewportHeight: number, barHeight: number, gap = OVERLAY_GAP): "above" | "below" {
  if (!(viewportHeight > 0) || !(barHeight > 0)) return "above";
  return anchorTopY - gap >= barHeight ? "above" : "below";
}
