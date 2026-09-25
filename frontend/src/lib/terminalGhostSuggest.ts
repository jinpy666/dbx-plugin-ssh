// 终端行内 ghost 自动建议（对标 Warp / fish autosuggest）：用户在终端主输入行
// 敲出历史/快速命令的前缀时，光标右侧以灰色展示匹配命令的剩余部分，按 → 一次
// 接受。本模块只做纯逻辑（可完整单测）——
// - 检索引擎复用 lib/commandSuggestions.ts 的 searchCommands（fzf 风格模糊匹配
//   + 评分排序 + 去重），不重复造引擎，这里只做适配层；
// - ghost 语义比浮层建议更严格：只在「已键入文本是候选命令的严格前缀扩展」时
//   出建议（fish 口径）。模糊命中的非前缀项被跳过——只有前缀扩展才有明确的
//   「接受 = 向 PTY 键入剩余字节」语义，注入不会破坏光标前的已敲内容；
// - 触发/隐藏门由显式状态机驱动：classifyGhostInput（onData 原始字节 → 事件）
//   → nextGhostState（门状态迁移）→ evaluateGhost（搜索 + 剩余文本 + 接受字
//   节）。xterm buffer 采样、overlay 渲染与 PTY 写入都留在调用方（App.vue）。

import {
  SEARCH_COMMANDS_DEFAULTS,
  commandSuggestionQueryAcceptable,
  searchCommands,
  type CommandSuggestionSources,
} from "./commandSuggestions";

export const TERMINAL_GHOST_DEFAULTS = {
  minLength: SEARCH_COMMANDS_DEFAULTS.minLength,
  maxLength: SEARCH_COMMANDS_DEFAULTS.maxLength,
  limit: SEARCH_COMMANDS_DEFAULTS.limit,
} as const;

// ---------------------------------------------------------------------------
// 门状态机：hidden / cursorAtEnd 两位。
// - hidden：任何非「可打印键入/退格」的输入（控制序列、粘贴、Esc、回车、
//   Ctrl+C）都置位，直到下一个可打印字符复位。对标 fish：粘贴与程序输出期间
//   不弹建议；Esc 显式消除当前 ghost。
// - cursorAtEnd：方向键 / 点击定位 / 历史浏览会把光标挪离行尾，置否；可打印
//   字符与退格都会把光标带回行尾，复位。仅行尾态才允许出建议。
// ---------------------------------------------------------------------------

export interface TerminalGhostState {
  /** 抑制中（非可打印输入/Esc 之后，直到下一次可打印键入）。 */
  hidden: boolean;
  /** 光标是否位于行尾（方向键/点击定位后置否）。 */
  cursorAtEnd: boolean;
}

export function createGhostState(): TerminalGhostState {
  return { hidden: true, cursorAtEnd: true };
}

export type TerminalGhostEvent =
  /** 单个可打印字符（onData 单字节正文）。 */
  | { kind: "printable" }
  /** 退格（\u007f）：删除字符，光标仍在行尾。 */
  | { kind: "backspace" }
  /** 回车（\r / \n）：行被执行，ghost 消失。 */
  | { kind: "newline" }
  /** Ctrl+C（\u0003）：打断当前行，ghost 消失。 */
  | { kind: "interrupt" }
  /** 裸 Esc 键：显式消除 ghost。 */
  | { kind: "escape" }
  /** 光标移动（方向键 / Home/End / 翻页），光标离开行尾。 */
  | { kind: "cursorMove" }
  /** 其余 onData（多字符粘贴、未知控制序列、功能键）：无法逐字符追踪，抑制。 */
  | { kind: "opaque" }
  /** 会话切换/断开：整体复位。 */
  | { kind: "reset" };

export function nextGhostState(state: TerminalGhostState, event: TerminalGhostEvent): TerminalGhostState {
  switch (event.kind) {
    case "printable":
    case "backspace":
      // 可打印键入/退格把光标带回行尾，并解除抑制（fish：退格后建议跟着缩短）。
      return { hidden: false, cursorAtEnd: true };
    case "newline":
    case "interrupt":
    case "escape":
    case "reset":
      return { hidden: true, cursorAtEnd: true };
    case "cursorMove":
      // 只标记光标离开行尾；hidden 不变（移动本身不构成「键入」）。
      return { hidden: state.hidden, cursorAtEnd: false };
    case "opaque":
      // 粘贴/未知序列：抑制到下一次可打印键入；光标位置不可知，保守回到行尾
      // （粘贴与程序化写入通常把光标留在行尾，下一个 printable 再校正）。
      return { hidden: true, cursorAtEnd: true };
  }
}

/**
 * onData 原始字节 → ghost 事件。纯字符串判定：
 * - 单个可打印字符 → printable；\u007f → backspace；\r/\n → newline；
 *   \u0003 → interrupt；裸 \u001b → escape；
 * - CSI/SS3 序列以移动键收尾（A/B/C/D/H/F 及 ~ 系翻页/编辑键）→ cursorMove；
 * - 其余（多字符粘贴正文、bracketed paste、未知序列）→ opaque。
 */
export function classifyGhostInput(data: string): TerminalGhostEvent {
  if (!data) return { kind: "opaque" };
  if (data.includes("\u0003")) return { kind: "interrupt" };
  if (data.includes("\r") || data.includes("\n")) return { kind: "newline" };
  if (data === "\u007f") return { kind: "backspace" };
  if (data === "\u001b") return { kind: "escape" };
  if (data.startsWith("\u001b")) {
    // ESC O A（SS3 应用光标键）与 ESC [ A（CSI）都算移动；其余序列不代指移动。
    const match = /^(?:\u001b\[|\u001bO)[0-9;]*([A-Za-z~])$/.exec(data);
    const final = match?.[1] ?? "";
    // 注意 includes("") === true：先排除未命中（final 为空串）再查移动键表。
    const isMove = final !== "" && ("ABCDHF".includes(final) || final === "~");
    return { kind: isMove ? "cursorMove" : "opaque" };
  }
  if (data.length === 1 && data >= " ") return { kind: "printable" };
  return { kind: "opaque" };
}

// ---------------------------------------------------------------------------
// 评估：门状态 + 行文本采样 → 是否出 ghost、剩余文本、接受字节。
// 状态机不自己持有行文本——行口径与 App 的 pendingTerminalInput（按键轨迹缓
// 冲）一致，由调用方在每次事件后传入，避免两份追踪器在粘贴/自动注入路径上
// 失步。
// ---------------------------------------------------------------------------

export interface GhostMatch {
  /** 命中的完整命令（历史/快速命令原文，保留其大小写）。 */
  command: string;
  /** 行内灰色展示的剩余文本 = command.slice(line.length)。 */
  remainder: string;
}

export interface GhostEvaluationInput {
  /** 当前门状态（classifyGhostInput → nextGhostState 的产物）。 */
  state: TerminalGhostState;
  /** 光标行已键入文本（与调用方按键轨迹缓冲同口径；"" = 空行）。 */
  line: string;
  /** xterm buffer 采样校正：光标右侧到行尾无字符且逻辑行未向下折行。 */
  cursorAtLineEnd: boolean;
  /** 设置总开关。 */
  enabled: boolean;
  /** 远端命令执行中 / 传输占用：不出建议。 */
  commandRunning: boolean;
  /** IME 组合中：不出建议（组合文本尚未落行）。 */
  compositionActive: boolean;
  /** 数据源：历史 + 快速命令（复用既有 refs，不新建存储）。 */
  sources: CommandSuggestionSources;
  /** 查询长度门与候选上限；缺省取 SEARCH_COMMANDS_DEFAULTS。 */
  bounds?: { minLength?: number; maxLength?: number; limit?: number };
}

export interface GhostEvaluation {
  /** 应展示的 ghost；null = 不展示。 */
  match: GhostMatch | null;
  /** 接受时需向 PTY 注入的字节（等价用户键入剩余部分）；无 ghost 时 null。 */
  acceptPayload: string | null;
}

/** 是否为 ghost 可用的候选：已键入文本是命令的严格前缀扩展（大小写不敏感）。 */
export function isGhostPrefixMatch(line: string, command: string): boolean {
  if (command.length <= line.length) return false;
  return command.toLowerCase().startsWith(line.toLowerCase());
}

/** 候选命令含任意控制字符（换行/tab/其他 C0/C1）时不可作 ghost：overlay 以
 * textContent 渲染看不到换行，接受会把多行文本一次性注入终端（fish 对多行
 * 历史同样不出行内建议）。注入字节仍等于历史原文，这里只挡「不可见注入」。 */
const GHOST_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 从 searchCommands 的模糊排序结果中选出 ghost 展示项：取评分最高的「严格前
 * 短扩展」候选。非前缀的模糊命中与含控制字符的候选被跳过（剩余文本无注入
 * 语义），全部被跳过或无候选时返回 null。
 */
export function pickGhostMatch(line: string, candidates: ReturnType<typeof searchCommands>): GhostMatch | null {
  for (const candidate of candidates) {
    if (!isGhostPrefixMatch(line, candidate.command)) continue;
    if (GHOST_CONTROL_CHARS.test(candidate.command)) continue;
    return { command: candidate.command, remainder: candidate.command.slice(line.length) };
  }
  return null;
}

export function evaluateGhost(input: GhostEvaluationInput): GhostEvaluation {
  const { state } = input;
  const minLength = input.bounds?.minLength ?? TERMINAL_GHOST_DEFAULTS.minLength;
  const maxLength = input.bounds?.maxLength ?? TERMINAL_GHOST_DEFAULTS.maxLength;
  const limit = input.bounds?.limit ?? TERMINAL_GHOST_DEFAULTS.limit;
  if (
    !input.enabled ||
    input.commandRunning ||
    input.compositionActive ||
    state.hidden ||
    !state.cursorAtEnd ||
    !input.cursorAtLineEnd ||
    input.line.length === 0 ||
    !commandSuggestionQueryAcceptable(input.line, minLength, maxLength)
  ) {
    return { match: null, acceptPayload: null };
  }
  // 引擎复用：fzf 风格评分排序交给 searchCommands，ghost 只按前缀扩展语义筛。
  const candidates = searchCommands(input.line, input.sources, { minLength, maxLength, limit });
  const match = pickGhostMatch(input.line, candidates);
  return { match, acceptPayload: match?.remainder ?? null };
}
