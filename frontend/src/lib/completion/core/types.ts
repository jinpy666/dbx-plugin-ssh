// FIG 补全引擎 wave-1 契约类型（冻结）。
// 实现方只 import，不修改；需要变更时写进 lane 报告由协调者裁决。
// 依据 docs/FIG_AUTOCOMPLETE_INTEGRATION_PLAN.zh-CN.md §5/§9 与
// docs/FIG_WAVE1_CONTRACT.zh-CN.md。wave-1 修正：引擎跑主线程（构建管线
// 单文件内联），requestId/revision 字段保留为将来 Worker 化留位。

export type ShellKind =
  | "bash"
  | "zsh"
  | "fish"
  | "pwsh"
  | "powershell"
  | "cmd"
  | "unknown";

export type CompletionTargetKind = "local" | "ssh" | "wsl";

export interface CompletionTarget {
  kind: CompletionTargetKind;
  sessionId: string;
}

export interface EditBufferState {
  sessionId: string;
  /** 每次输入变更 +1；异步结果回来时 revision 不匹配即静默丢弃。 */
  revision: number;
  /** 当前逻辑行文本（pendingTerminalInput 的升级形态）。 */
  text: string;
  /** 光标在 text 中的 UTF-16 下标；wave 1 恒等于 text.length（行尾补全）。 */
  cursor: number;
  target: CompletionTarget;
  shell: ShellKind;
}

export type CompletionItemKind =
  | "command"
  | "subcommand"
  | "option"
  | "argument"
  | "file"
  | "directory"
  | "history"
  | "hint";

/** 编辑操作由 parser/resolver 产生，UI 只执行（方案 §5.2）。 */
export interface CompletionEdit {
  text: string;
  replaceStart: number;
  replaceEnd: number;
  cursorOffset?: number;
}

export interface CompletionItem {
  id: string;
  label: string;
  description?: string;
  kind: CompletionItemKind;
  score: number;
  /** 候选来源标签（如 "legacy-spec" / "fig-spec" / "history"）。 */
  source: string;
  edit: CompletionEdit;
}

export type CompletionTrigger = "typing" | "tab" | "manual";

export interface CompletionContext {
  command: string | null;
  commandPath: string[];
  /** 当前 token 在 text 中的 [start, end) UTF-16 下标。 */
  tokenStart: number;
  tokenEnd: number;
}

export type CompletionResponseState = "idle" | "loading" | "ready" | "pass-through";

export interface CompletionResponse {
  requestId: number;
  revision: number;
  state: CompletionResponseState;
  context?: CompletionContext;
  items: CompletionItem[];
}
