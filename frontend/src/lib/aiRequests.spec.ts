// AI 请求构造器单测（Warp AI 对齐批）：桥请求形状与上下文装配契约。
import { describe, expect, it } from "vitest";
import { buildAiAssistRequest, buildAiFixPrompt, buildAiFixRequest, buildAiSearchPrompt, buildAiSearchRequest } from "./aiRequests";

describe("buildAiSearchRequest", () => {
  it("ask 模式 + send，query 同时进 prompt 与 context", () => {
    const request = buildAiSearchRequest({ query: " list files by size ", context: { connectionId: "c1", cwd: "/srv" } });
    expect(request.mode).toBe("ask");
    expect(request.send).toBe(true);
    expect(request.prompt).toContain("list files by size");
    expect(request.context).toMatchObject({ kind: "ai-command-search", query: "list files by size", connectionId: "c1", cwd: "/srv" });
    expect(request.title.startsWith("AI command search:")).toBe(true);
  });

  it("标题超长截断且不超桥上限", () => {
    const request = buildAiSearchRequest({ query: "x".repeat(500), context: {} });
    expect(request.title.length).toBeLessThanOrEqual(121);
  });

  it("可选上下文缺省不占位", () => {
    const request = buildAiSearchRequest({ query: "q", context: {} });
    expect(request.context).toEqual({ kind: "ai-command-search", query: "q" });
  });

  it("多语言 / 多 shell 上下文原样透传（locale/os/shell 由 App 组装）", () => {
    const request = buildAiSearchRequest({
      query: "list files by size",
      context: { locale: "zh-CN", shell: "powershell", os: "windows", cwd: "C:\\demo", connectionId: "c1" },
    });
    expect(request.context).toMatchObject({ locale: "zh-CN", shell: "powershell", os: "windows", cwd: "C:\\demo", connectionId: "c1" });
    // prompt 模板与 shell 上下文联动：非 POSIX 口径由 context 声明，模板不写死。
    expect(request.prompt).toContain("shell context");
  });
});

describe("buildAiSearchPrompt（v2 直连与面板共用）", () => {
  it("格式钉「首行 = 精确命令 + Why 行」，query 独立成 User request 行", () => {
    const prompt = buildAiSearchPrompt({ query: " list files by size " });
    expect(prompt).toContain("User request: list files by size");
    expect(prompt).toContain("first line = the exact command");
    expect(prompt).toContain("Why: ");
    // mock 宿主按该标记分流罐头（smoke_ui_mock 依赖）：标记必须稳定在场。
    expect(prompt).toContain("User request:");
  });

  it("面板会话与直连共用同一 prompt（buildAiSearchRequest 复用不漂移）", () => {
    const request = buildAiSearchRequest({ query: "tail logs", context: {} });
    expect(request.prompt).toBe(buildAiSearchPrompt({ query: "tail logs" }));
  });
});

describe("buildAiFixRequest", () => {
  it("命令/退出码/输出进 prompt 与 context", () => {
    const request = buildAiFixRequest({ command: "curl -sf http://x", exitCode: 28, output: "timeout", context: { connectionId: "c1" } });
    expect(request.mode).toBe("ask");
    expect(request.prompt).toContain("curl -sf http://x");
    expect(request.prompt).toContain("28");
    expect(request.prompt).toContain("timeout");
    expect(request.context).toMatchObject({ kind: "ai-fix", command: "curl -sf http://x", exitCode: 28, connectionId: "c1" });
  });

  it("空输出显式占位（诚实降级）", () => {
    const request = buildAiFixRequest({ command: "x", exitCode: 1, output: "", context: {} });
    expect(request.prompt).toContain("(no output captured)");
    expect(request.context).toMatchObject({ output: "" });
  });
});

describe("buildAiAssistRequest", () => {
  it("有快照带快照、无快照纯 query", () => {
    const withSnapshot = buildAiAssistRequest({ query: "", selection: "ERR file not found", context: {} });
    expect(withSnapshot.prompt).toContain("ERR file not found");
    const plain = buildAiAssistRequest({ query: "how to tail logs", selection: "", context: { cwd: "/tmp" } });
    expect(plain.prompt).toContain("how to tail logs");
    expect(plain.context).toMatchObject({ kind: "ai-assist", cwd: "/tmp" });
  });
});

describe("直连 prompt 与 agentMode（面板会话档位）", () => {
  it("buildAiFixPrompt：triage 提示位随缘出现，格式指令恒在", () => {
    const base = buildAiFixPrompt({ command: "x", exitCode: 1, output: "boom" });
    expect(base).toContain("first line = the exact corrected command");
    expect(base).not.toContain("triage");
    const withHint = buildAiFixPrompt({ command: "x", exitCode: 1, output: "boom", triageHint: "category=disk, whitelisted suggestions: df -h" });
    expect(withHint).toContain("Local heuristic triage hint");
    expect(withHint).toContain("category=disk");
  });

  it("buildAiFixRequest / buildAiAssistRequest 的 mode 随 agentMode 档位", () => {
    expect(buildAiFixRequest({ command: "x", exitCode: 1, output: "", context: {} }).mode).toBe("ask");
    expect(buildAiFixRequest({ command: "x", exitCode: 1, output: "", context: {}, agentMode: true }).mode).toBe("agent");
    expect(buildAiAssistRequest({ query: "q", selection: "", context: {} }).mode).toBe("ask");
    expect(buildAiAssistRequest({ query: "q", selection: "", context: {}, agentMode: true }).mode).toBe("agent");
  });
});
