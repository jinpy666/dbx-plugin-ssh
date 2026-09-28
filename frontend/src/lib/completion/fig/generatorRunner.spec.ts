import { describe, expect, it, vi } from "vitest";
import type { CompletionExecuteRequest, CompletionExecuteResult } from "../host/protocol";
import { createCompletionHostClient, type CompletionHostInvoke } from "../host/hostClient";
import {
  GENERATOR_ITEM_SOURCE,
  runDeclarativeGenerator,
  type GeneratorPostProcess,
  type GeneratorRunContext,
} from "./generatorRunner";

function fakeExecute(result: CompletionExecuteResult | null) {
  return vi.fn(async (_req: CompletionExecuteRequest) => result);
}

function baseContext(overrides?: Partial<GeneratorRunContext>): GeneratorRunContext {
  return {
    target: { kind: "ssh", sessionId: "session-1" },
    execute: fakeExecute(null),
    context: { command: "git", commandPath: ["git", "checkout"], tokenStart: 13, tokenEnd: 15 },
    prefix: "ma",
    ...overrides,
  };
}

const branchDecl = { script: ["git", "branch", "--format=%(refname:short)"] };

const branchesResult: CompletionExecuteResult = {
  exitCode: 0,
  stdout: "main\nmaster\nmaintenance\n",
  stderr: "",
  truncated: false,
  timedOut: false,
};

const identityPostProcess: GeneratorPostProcess = (parts) => parts.filter((p) => p.length > 0).map((label) => ({ label }));

describe("runDeclarativeGenerator（骨架，全 Fake）", () => {
  it("happy path：script[0]+argv 组装请求，stdout 按 splitOn 切分，postProcess 产候选", async () => {
    const execute = fakeExecute(branchesResult);
    const ctx = baseContext({ execute });
    const items = await runDeclarativeGenerator(branchDecl, identityPostProcess, ctx);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      target: { kind: "ssh", sessionId: "session-1" },
      command: "git",
      args: ["branch", "--format=%(refname:short)"],
      cwd: null,
      timeoutMs: 1200,
      maxOutputBytes: 262_144,
      mode: "completion-generator",
    });
    expect(items).toHaveLength(3);
    expect(items?.[0]).toMatchObject({
      id: `${GENERATOR_ITEM_SOURCE}:git:0:main`,
      label: "main",
      kind: "argument",
      score: 0,
      source: GENERATOR_ITEM_SOURCE,
      edit: { text: "main", replaceStart: 13, replaceEnd: 15, cursorOffset: 17 },
    });
  });

  it("splitOn 自定义分隔符（如逗号）", async () => {
    const execute = fakeExecute({ ...branchesResult, stdout: "pod-a,pod-b," });
    const ctx = baseContext({ execute });
    const items = await runDeclarativeGenerator(
      { script: ["kubectl", "get", "pods"], splitOn: "," },
      identityPostProcess,
      ctx,
    );
    expect(items?.map((item) => item.label)).toEqual(["pod-a", "pod-b"]);
  });

  it("ctx.cwd / timeoutMs / maxOutputBytes 透传进 execute 请求", async () => {
    const execute = fakeExecute(branchesResult);
    await runDeclarativeGenerator(branchDecl, identityPostProcess, baseContext({
      execute,
      cwd: "/srv/repo",
      timeoutMs: 2500,
      maxOutputBytes: 4096,
    }));
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/srv/repo", timeoutMs: 2500, maxOutputBytes: 4096 }),
    );
  });

  it("description 透传；缺省时不得带 undefined 键", async () => {
    const execute = fakeExecute({ ...branchesResult, stdout: "main\n" });
    const items = await runDeclarativeGenerator(
      branchDecl,
      () => [{ label: "main", description: "default branch" }, { label: "bare" }],
      baseContext({ execute }),
    );
    expect(items).toEqual([
      expect.objectContaining({ label: "main", description: "default branch" }),
      expect.objectContaining({ label: "bare" }),
    ]);
    expect(items?.[1]).not.toHaveProperty("description");
  });

  it("重复 label 生成唯一 id", async () => {
    const execute = fakeExecute({ ...branchesResult, stdout: "dup\ndup\n" });
    const items = await runDeclarativeGenerator(branchDecl, identityPostProcess, baseContext({ execute }));
    const ids = items?.map((item) => item.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("空 stdout → postProcess 收 ['']，产空数组（执行成功但无候选）", async () => {
    const execute = fakeExecute({ ...branchesResult, stdout: "" });
    const items = await runDeclarativeGenerator(branchDecl, identityPostProcess, baseContext({ execute }));
    expect(items).toEqual([]);
  });

  it("execute 返回 null（桥/传输失败）→ null", async () => {
    const items = await runDeclarativeGenerator(branchDecl, identityPostProcess, baseContext({
      execute: fakeExecute(null),
    }));
    expect(items).toBeNull();
  });

  it("timedOut → null", async () => {
    const items = await runDeclarativeGenerator(branchDecl, identityPostProcess, baseContext({
      execute: fakeExecute({ exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true }),
    }));
    expect(items).toBeNull();
  });

  it("postProcess 返回 null / 抛错 → null", async () => {
    const execute = fakeExecute(branchesResult);
    await expect(
      runDeclarativeGenerator(branchDecl, () => null, baseContext({ execute: fakeExecute(branchesResult) })),
    ).resolves.toBeNull();
    await expect(
      runDeclarativeGenerator(
        branchDecl,
        () => {
          throw new Error("postProcess boom");
        },
        baseContext({ execute }),
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ["decl 缺 script", { script: [] }],
    ["script[0] 空", { script: ["  ", "x"] }],
    ["argv 非字符串", { script: ["git", 1] as unknown as string[] }],
  ])("decl 畸形（%s）→ null 且不触 execute", async (_name, decl) => {
    const execute = fakeExecute(branchesResult);
    await expect(runDeclarativeGenerator(decl, identityPostProcess, baseContext({ execute }))).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("ctx.execute 缺失 → null", async () => {
    const ctx = baseContext();
    ctx.execute = undefined as unknown as GeneratorRunContext["execute"];
    await expect(runDeclarativeGenerator(branchDecl, identityPostProcess, ctx)).resolves.toBeNull();
  });

  it("接缝集成：ctx.execute 由注入式 Fake 桥的 createCompletionHostClient 提供", async () => {
    const invoke = vi.fn(async () => branchesResult);
    const hostClient = createCompletionHostClient(invoke as CompletionHostInvoke);
    const items = await runDeclarativeGenerator(
      branchDecl,
      identityPostProcess,
      baseContext({ execute: hostClient.execute }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(items?.map((item) => item.label)).toEqual(["main", "master", "maintenance"]);
  });
});
