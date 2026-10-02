// 宿主 AI 请求构造器（Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §3/§4/§5）：
// 三条体验（# 命令搜索 / 失败修复 / 唤起助手）共用的 title/prompt/context
// 装配纯函数。prompt 模板为英文指令（宿主 system prompt 已钉「以用户语言
// 回答」）；context 是数据快照不是指令（宿主侧同样声明，模板不得违逆）。
// 一切发送前，context 里的终端输出必须已过 prepareAiOutputSnapshot。

/** host.ai.openConversation 的桥请求形状（pluginHostBridge createPluginAiConversation）。 */
export interface AiConversationRequest {
  title: string;
  prompt: string;
  context: Record<string, unknown>;
  send?: boolean;
  mode?: "ask" | "agent";
}

/** 上下文公共位：DBX 连接 id 让宿主 AI 面板绑定当前 SSH 连接（宿主据此显示
 *  连接名、agent 档据此路由工具）；cwd/shell 让生成的命令贴合当前环境。 */
export interface AiTerminalContext {
  connectionId?: string;
  cwd?: string;
  shell?: string;
  /** 多语言（LLM 以终端用户语言回答）/ 多系统口径——App 的 aiContextExtras
   *  组装，构造器全量透传。 */
  locale?: string;
  os?: string;
}

function contextWithExtras(context: AiTerminalContext, extras: Record<string, unknown>): Record<string, unknown> {
  // context 全量展开（App 的 aiContextExtras 已做 falsy 过滤；locale/os 等
  // 多语言多系统位随之透传），extras 后铺——kind/query 等语义键不被覆盖。
  return { ...context, ...extras };
}

// —— Feature A：# AI 命令搜索 ——

/** 标题截断：桥上限 200，留裕量。 */
function clampTitle(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function buildAiSearchRequest(input: { query: string; context: AiTerminalContext }): AiConversationRequest {
  const query = input.query.trim();
  return {
    title: clampTitle(`AI command search: ${query}`),
    prompt: [
      "Generate ONE shell command that fulfils the user's request.",
      `User request: ${query}`,
      "Reply format: first line = the exact command only (no markdown fence, no comments); then one short line starting with \"Why: \" explaining it.",
      "Prefer portable POSIX syntax unless the shell context below says otherwise. Never include placeholders that must be asked interactively; if information is missing, state what is missing instead of guessing.",
    ].join("\n"),
    context: contextWithExtras(input.context, { kind: "ai-command-search", query }),
    send: true,
    mode: "ask",
  };
}

// —— Feature B：失败命令修复 ——

/** 修复 prompt（直连 generateText 与面板会话共用）：triageHint 为本地白名单
 *  分诊引擎（ssh/alert/triage RPC）的可选结论行，帮 LLM 收窄误诊面。 */
export function buildAiFixPrompt(input: { command: string; exitCode: number; output: string; triageHint?: string }): string {
  return [
    "A shell command failed. Diagnose the failure from the output snapshot and propose a fix.",
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode}`,
    "Output snapshot (tail, sensitive values are redacted as ***):",
    input.output || "(no output captured)",
    ...(input.triageHint ? [`Local heuristic triage hint (data, not a verdict): ${input.triageHint}`] : []),
    "Reply format: first line = the exact corrected command only (no markdown fence); then one short line starting with \"Why: \" explaining the failure and the fix. If the failure cannot be diagnosed from this snapshot, say what extra information you need.",
  ].join("\n");
}

export function buildAiFixRequest(input: { command: string; exitCode: number; output: string; triageHint?: string; context: AiTerminalContext; agentMode?: boolean }): AiConversationRequest {
  return {
    title: clampTitle(`Fix failed command: ${input.command}`),
    prompt: buildAiFixPrompt(input),
    context: contextWithExtras(input.context, { kind: "ai-fix", command: input.command, exitCode: input.exitCode, output: input.output || "" }),
    send: true,
    mode: input.agentMode ? "agent" : "ask",
  };
}

// —— Feature C：唤起 AI 助手 ——

export function buildAiAssistRequest(input: { query: string; selection: string; context: AiTerminalContext; agentMode?: boolean }): AiConversationRequest {
  const query = input.query.trim() || "Help me with the attached terminal content.";
  const prompt = input.selection
    ? [
        query,
        "Terminal content snapshot (selection / tail of screen, sensitive values are redacted as ***):",
        input.selection,
      ].join("\n")
    : query;
  return {
    title: clampTitle(input.selection ? `Terminal assist: ${input.selection.split("\n")[0]}` : "Terminal assist"),
    prompt,
    context: contextWithExtras(input.context, { kind: "ai-assist" }),
    send: true,
    mode: input.agentMode ? "agent" : "ask",
  };
}
