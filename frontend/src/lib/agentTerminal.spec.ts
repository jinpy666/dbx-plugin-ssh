import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  approvalRemainingSecs,
  agentPromptCommandReadOnly,
  buildAgentResolveBody,
  dropAgentPrompt,
  enqueueAgentPrompt,
  findAgentPrompt,
  REMEMBERED_COMMAND_LINE_LIMIT,
  REMEMBERED_COMMAND_LIST_LIMIT,
  sanitizeRememberedCommands,
  type AgentPromptPayload,
} from "./agentTerminal";

describe("agent terminal mode contract", () => {
  it("keeps the canonical mode order off/auto/strict", () => {
    expect(AGENT_MODES).toEqual(["off", "auto", "strict"]);
    expect([...AGENT_MODES]).toHaveLength(3);
  });

  it("counts down from requestedAt + timeoutSecs against a millisecond clock", () => {
    // requestedAt=1000s, timeout=120s → 期限 1120s；now=1120_000ms 恰好为 0。
    const payload = { requestedAt: 1000, timeoutSecs: 120 };
    expect(approvalRemainingSecs(payload, 1_000_000)).toBe(120);
    expect(approvalRemainingSecs(payload, 1_060_500)).toBeCloseTo(59.5, 6);
    expect(approvalRemainingSecs(payload, 1_120_000)).toBe(0);
  });

  it("clamps negative remainders to zero once the deadline has passed", () => {
    const payload = { requestedAt: 1000, timeoutSecs: 30 };
    expect(approvalRemainingSecs(payload, 1_030_001)).toBe(0);
    expect(approvalRemainingSecs(payload, 2_000_000)).toBe(0);
  });

  it("treats a zero timeout as immediately expired at the deadline", () => {
    const payload = { requestedAt: 1000, timeoutSecs: 0 };
    expect(approvalRemainingSecs(payload, 1_000_000)).toBe(0);
    expect(approvalRemainingSecs(payload, 2_000_000)).toBe(0);
    // 未到期时仍返回微小的正剩余（0.001s），前端 250ms tick 会立即收口到 0。
    expect(approvalRemainingSecs(payload, 999_999)).toBeCloseTo(0.001, 6);
  });
});

describe("MCP approval command editing", () => {
  it("keeps structured Docker lifecycle actions read-only while normal SSH commands stay editable", () => {
    expect(agentPromptCommandReadOnly({ source: "mcp", tool: "docker_action" })).toBe(true);
    expect(agentPromptCommandReadOnly({ source: "mcp", tool: "ssh_exec" })).toBe(false);
    expect(agentPromptCommandReadOnly({ tool: "docker_action" })).toBe(false);
  });
});

describe("agent prompt queue helpers", () => {
  const first: AgentPromptPayload = {
    challengeId: "c1", sessionId: "s1", tool: "ssh_exec", command: "ls", risk: "low", requestedAt: 1000, timeoutSecs: 120,
  };
  const second: AgentPromptPayload = { ...first, challengeId: "c2", risk: "elevated" };
  const third: AgentPromptPayload = { ...first, challengeId: "c3", sessionId: "s2" };

  it("appends new challenges in arrival order", () => {
    expect(enqueueAgentPrompt([], first)).toEqual([first]);
    expect(enqueueAgentPrompt(enqueueAgentPrompt([], first), second)).toEqual([first, second]);
  });

  it("dedupes by challengeId and returns an equivalent copy instead of the same reference", () => {
    const queue = [first];
    const result = enqueueAgentPrompt(queue, { ...first });
    expect(result).toEqual([first]);
    expect(result).not.toBe(queue);
  });

  it("never mutates the input queue", () => {
    const queue = [first, second];
    enqueueAgentPrompt(queue, third);
    expect(queue).toEqual([first, second]);
    dropAgentPrompt(queue, first.challengeId);
    expect(queue).toEqual([first, second]);
  });

  it("removes only the matching challenge and preserves the order of the rest", () => {
    const queue = [first, second, third];
    expect(dropAgentPrompt(queue, second.challengeId)).toEqual([first, third]);
    expect(dropAgentPrompt(queue, first.challengeId)).toEqual([second, third]);
  });

  it("returns an equivalent array when dropping an unknown challengeId", () => {
    const queue = [first, second];
    expect(dropAgentPrompt(queue, "missing")).toEqual([first, second]);
  });

  it("finds a challenge by challengeId or returns undefined", () => {
    const queue = [first, second];
    expect(findAgentPrompt(queue, "c2")).toBe(second);
    expect(findAgentPrompt(queue, "missing")).toBeUndefined();
  });
});

describe("agent resolve body", () => {
  it("deny sends only challengeId and decision", () => {
    expect(buildAgentResolveBody({ challengeId: "c1", decision: "deny" })).toEqual({
      challengeId: "c1",
      decision: "deny",
    });
  });

  it("approve without a command sends only challengeId and decision", () => {
    expect(buildAgentResolveBody({ challengeId: "c1", decision: "approve" })).toEqual({
      challengeId: "c1",
      decision: "approve",
    });
  });

  it("approve with a command carries the edited command text but no remember key", () => {
    expect(buildAgentResolveBody({ challengeId: "c1", decision: "approve", command: "systemctl restart nginx" })).toEqual({
      challengeId: "c1",
      decision: "approve",
      command: "systemctl restart nginx",
    });
    // 空串视为未提供命令。
    expect(buildAgentResolveBody({ challengeId: "c1", decision: "approve", command: "" })).toEqual({
      challengeId: "c1",
      decision: "approve",
    });
  });

  it("approve + command + remember sends remember:true only when explicitly true", () => {
    expect(buildAgentResolveBody({ challengeId: "c1", decision: "approve", command: "df -h", remember: true })).toEqual({
      challengeId: "c1",
      decision: "approve",
      command: "df -h",
      remember: true,
    });
    // 缺省 / 显式 false 都不发送 remember（协议省缺语义即 false）。
    expect("remember" in buildAgentResolveBody({ challengeId: "c1", decision: "approve", command: "df -h" })).toBe(false);
    expect("remember" in buildAgentResolveBody({ challengeId: "c1", decision: "approve", command: "df -h", remember: false })).toBe(false);
    // deny 即使误带 command/remember 也不发送。
    const denyBody = buildAgentResolveBody({ challengeId: "c1", decision: "deny", command: "df -h", remember: true });
    expect(denyBody).toEqual({ challengeId: "c1", decision: "deny" });
  });
});

describe("remembered command list sanitization", () => {
  it("trims lines and drops empties", () => {
    expect(sanitizeRememberedCommands(["  df -h  ", "", "   ", "uptime"])).toEqual(["df -h", "uptime"]);
  });

  it("dedupes by trimmed line text and preserves first-seen order", () => {
    expect(sanitizeRememberedCommands(["df -h", "  df -h", "uptime", "df -h"])).toEqual(["df -h", "uptime"]);
  });

  it("clamps each line to 500 characters instead of rejecting it", () => {
    const long = "x".repeat(REMEMBERED_COMMAND_LINE_LIMIT + 50);
    const [line] = sanitizeRememberedCommands([long]);
    expect(line).toHaveLength(REMEMBERED_COMMAND_LINE_LIMIT);
  });

  it("truncates the list to 50 entries", () => {
    const many = Array.from({ length: REMEMBERED_COMMAND_LIST_LIMIT + 10 }, (_, i) => `cmd-${i}`);
    const lines = sanitizeRememberedCommands(many);
    expect(lines).toHaveLength(REMEMBERED_COMMAND_LIST_LIMIT);
    expect(lines[0]).toBe("cmd-0");
    expect(lines.at(-1)).toBe(`cmd-${REMEMBERED_COMMAND_LIST_LIMIT - 1}`);
  });

  it("returns an empty list for non-array input and skips junk items", () => {
    expect(sanitizeRememberedCommands("df -h")).toEqual([]);
    expect(sanitizeRememberedCommands(null)).toEqual([]);
    expect(sanitizeRememberedCommands(undefined)).toEqual([]);
    expect(sanitizeRememberedCommands({ commands: ["df -h"] })).toEqual([]);
    // 非字符串项按原语 coercion 处理，对象/数组项直接跳过。
    expect(sanitizeRememberedCommands([42, true, { x: 1 }, ["df"], "uptime"])).toEqual(["42", "true", "uptime"]);
  });
});
