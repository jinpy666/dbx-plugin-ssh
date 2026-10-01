// AI 请求构造器单测（Warp AI 对齐批）：桥请求形状与上下文装配契约。
import { describe, expect, it } from "vitest";
import { buildAiAssistRequest, buildAiFixRequest, buildAiSearchRequest } from "./aiRequests";

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
