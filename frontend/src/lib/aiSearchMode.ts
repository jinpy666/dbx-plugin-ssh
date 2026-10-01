// `#` AI 命令搜索模式（Warp AI Command Search 同位，IMPL_PLAN_WARP_AI_TERMINAL
// §3）：空行键入 # 进入——行内提示替代 shell 回显，打字进本地 query 不发远端；
// 回车发起宿主 AI 会话，Esc/Ctrl+C 退出。`#` 字节不进 PTY，所以退出模式无需
// 擦除远端（shell 注释语义天然兜底：能力缺失时 # 照常放行为注释）。纯状态机。

export const AI_SEARCH_QUERY_MAX = 2000;

export interface AiSearchState {
  active: boolean;
  query: string;
}

export function createAiSearchState(): AiSearchState {
  return { active: false, query: "" };
}

export type AiSearchEvent =
  /** 单个可打印字符。 */
  | { kind: "printable"; char: string }
  /** 多字符纯可打印批次（IME 提交/纯文本粘贴）：整段并入 query。 */
  | { kind: "printableBatch"; text: string }
  /** 退格。 */
  | { kind: "backspace" }
  /** 回车：发起。 */
  | { kind: "submit" }
  /** Esc / Ctrl+C：退出且不发起。 */
  | { kind: "cancel" }
  /** 含控制字符或无法追踪的字节（CSI/粘贴夹控制符）：退出（保守）。 */
  | { kind: "abort" };

export type AiSearchAction = "none" | "submit" | "cancel";

/** onData 原始字节 → 事件（仅在模式激活时调用）。 */
export function classifyAiSearchInput(data: string): AiSearchEvent {
  if (!data) return { kind: "abort" };
  if (data.includes("\r") || data.includes("\n")) return { kind: "submit" };
  if (data.includes("\u0003")) return { kind: "cancel" };
  if (data === "\u007f") return { kind: "backspace" };
  if (data === "\u001b") return { kind: "cancel" };
  if (data.startsWith("\u001b")) return { kind: "abort" };
  if ([...data].some((char) => char < " " || char === "\u007f")) return { kind: "abort" };
  if (data.length === 1) return { kind: "printable", char: data };
  return { kind: "printableBatch", text: data };
}

/**
 * 模式内状态迁移（纯函数）。active=false 时只接受 activate（App 在键入 # 的
 * onData 里显式进入），其余事件原样返回。query 超长截断（AI_SEARCH_QUERY_MAX）。
 */
export function nextAiSearchState(state: AiSearchState, event: AiSearchEvent): { state: AiSearchState; action: AiSearchAction } {
  if (!state.active) return { state, action: "none" };
  switch (event.kind) {
    case "printable":
      return { state: { active: true, query: (state.query + event.char).slice(0, AI_SEARCH_QUERY_MAX) }, action: "none" };
    case "printableBatch":
      return { state: { active: true, query: (state.query + event.text).slice(0, AI_SEARCH_QUERY_MAX) }, action: "none" };
    case "backspace":
      if (!state.query) return { state: { active: false, query: "" }, action: "cancel" };
      return { state: { active: true, query: state.query.slice(0, -1) }, action: "none" };
    case "submit":
      return { state: { active: false, query: "" }, action: "submit" };
    case "cancel":
    case "abort":
      return { state: { active: false, query: "" }, action: "cancel" };
  }
}

/** 激活门（纯函数）：任一既有浮层/alternate 屏/命令运行/传输占用时不抢 #。 */
export interface AiSearchGates {
  alternateActive: boolean;
  commandRunning: boolean;
  transferBusy: boolean;
  suggestionOpen: boolean;
  completionOpen: boolean;
  historyPanelOpen: boolean;
  quickSelectOpen: boolean;
  searchOpen: boolean;
}

export function canActivateAiSearch(gates: AiSearchGates): boolean {
  return !gates.alternateActive && !gates.commandRunning && !gates.transferBusy && !gates.suggestionOpen && !gates.completionOpen && !gates.historyPanelOpen && !gates.quickSelectOpen && !gates.searchOpen;
}
