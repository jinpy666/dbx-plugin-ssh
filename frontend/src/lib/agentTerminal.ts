// AI 终端同步执行（agent terminal mode）前端契约：类型 + 纯函数。
// 协议来源：ssh/docs/IMPL_PLAN_AGENT_TERMINAL.zh-CN.md §3（事件/RPC 契约钉死）。
// 事件 payload 均为 camelCase；requestedAt 为 unix 秒，timeoutSecs 为秒。

/** 连接级 agentTerminalMode 三档；顺序即设置弹窗下拉顺序，值即协议值。 */
export const AGENT_MODES = ["off", "auto", "strict"] as const;

export type AgentTerminalMode = (typeof AGENT_MODES)[number];

export type AgentRisk = "low" | "elevated";

export type AgentFinishStatus = "done" | "timeout" | "denied";

/** `ssh/agent/prompt` 事件 payload：审批挑战（超时默认拒绝）。 */
export interface AgentPromptPayload {
  challengeId: string;
  sessionId: string;
  tool: string;
  command: string;
  risk: AgentRisk;
  /** unix 秒；后端发出时刻。 */
  requestedAt: number;
  timeoutSecs: number;
  /**
   * 来源标记（IMPL_PLAN_NETCATTY_PARITY §1.3）：MCP confirm 档触发的挑战带
   * `source:"mcp"`；既有终端审批不带该字段。前端据此前缀化标题；旧前端收到
   * 带 source 的挑战按既有渲染兜底（向后兼容）。
   */
  source?: "mcp";
}

/** `ssh/agent/notice` 事件 payload：低危命令直接注入终端时的告知。 */
/** MCP Docker lifecycle actions carry structured arguments; never allow the
 * confirmation dialog to turn their rendered command into arbitrary SSH.
 * Normal SSH command confirmations remain editable. */
export function agentPromptCommandReadOnly(prompt: Pick<AgentPromptPayload, "source" | "tool">): boolean {
  return prompt.source === "mcp" && prompt.tool === "docker_action";
}

export interface AgentNoticePayload {
  sessionId: string;
  tool: string;
  command: string;
  risk: AgentRisk;
}

/** `ssh/agent/finish` 事件 payload：一次终端路由执行收尾。 */
export interface AgentFinishPayload {
  sessionId: string;
  status: AgentFinishStatus;
}

/**
 * 审批弹窗剩余秒数：requestedAt（秒）+ timeoutSecs − now（毫秒→秒），下限 0。
 * 到 0 前端自动收起弹窗（后端超时语义同样是拒绝）。
 */
export function approvalRemainingSecs(
  payload: Pick<AgentPromptPayload, "requestedAt" | "timeoutSecs">,
  nowMs: number,
): number {
  const remaining = payload.requestedAt + payload.timeoutSecs - nowMs / 1000;
  return remaining > 0 ? remaining : 0;
}

/**
 * 审批挑战队列助手：跨会话并发审批排队（后端同会话已串行化，前端弹窗一次只渲染队首）。
 * 均为不可变语义——始终返回新数组，从不修改入参。
 */

/** 按 challengeId 去重追加：已存在则不追加（返回等价浅拷贝），否则追加到队尾。 */
export function enqueueAgentPrompt<Q extends { challengeId: string }>(
  queue: readonly Q[],
  payload: Q,
): Q[] {
  if (queue.some((item) => item.challengeId === payload.challengeId)) return [...queue];
  return [...queue, payload];
}

/** 移除指定 challengeId 的挑战；未命中返回等价浅拷贝。 */
export function dropAgentPrompt<Q extends { challengeId: string }>(
  queue: readonly Q[],
  challengeId: string,
): Q[] {
  return queue.filter((item) => item.challengeId !== challengeId);
}

/** 按 challengeId 查找队列中的挑战。 */
export function findAgentPrompt<Q extends { challengeId: string }>(
  queue: readonly Q[],
  challengeId: string,
): Q | undefined {
  return queue.find((item) => item.challengeId === challengeId);
}

/**
 * 审批记忆（remembered approvals）纯函数：resolve 请求体构造与设置面板清单归一。
 * 协议来源：ssh/docs/IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT.zh-CN.md §2.1/§2.2。
 */

/** `ssh/agent/resolve` 请求参数：审批弹窗一次决定。 */
export interface AgentResolveInput {
  challengeId: string;
  decision: "approve" | "deny";
  /** approve 时发送用户编辑后的最终命令文本；缺省或空串视为未提供。 */
  command?: string;
  /** 仅 approve 时有意义；只有显式 true 才随请求发送。 */
  remember?: boolean;
}

/**
 * 构造 `ssh/agent/resolve` 请求体：
 * - deny 只带 challengeId + decision（command/remember 一律不带）；
 * - approve 在命令非空时携带 command；`remember: true` 仅在显式勾选时发送，
 *   缺省/false 不出现在请求体里（协议省缺语义即 false）。
 */
export function buildAgentResolveBody(input: AgentResolveInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    challengeId: input.challengeId,
    decision: input.decision,
  };
  if (input.decision === "approve") {
    if (typeof input.command === "string" && input.command.length > 0) body.command = input.command;
    if (input.remember === true) body.remember = true;
  }
  return body;
}

/** 记住清单约束（协议 §2.2）：每行 ≤500 字符、每连接 ≤50 行、去重。 */
export const REMEMBERED_COMMAND_LINE_LIMIT = 500;
export const REMEMBERED_COMMAND_LIST_LIMIT = 50;

/**
 * 设置面板用：归一记住清单（`ssh/settings/set` 的 rememberedCommands）。
 * 输入容忍任意 unknown；仅接受字符串/数字/布尔项。每行 trim、钳制到 500 字符、
 * 去空、按行文本去重、整体截断到 50 行。非数组输入返回空数组（清空语义）。
 */
export function sanitizeRememberedCommands(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") continue;
    const line = String(item).trim().slice(0, REMEMBERED_COMMAND_LINE_LIMIT);
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= REMEMBERED_COMMAND_LIST_LIMIT) break;
  }
  return lines;
}
