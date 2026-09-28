// GeneratorScheduler 单测（批次 2-1，全 Fake 零联网）：覆盖 happy path
// （script→execute 请求组装/postProcess 适配）、splitOn、Fig 原生 suggestion
// 收敛、缺省 postProcess、postProcess 抛错、超时/execute null、非零 exitCode
// 照常 postProcess、前缀过滤、TTL 缓存命中不重复打 RPC、TTL 过期重打、
// 在途共享去重、前缀归并（同 token 连续前缀共享一次执行、调用方各自过滤）、
// 无目标 → null、缓存 key 区分 tokenStart/session/cwd/script、slots 收集
// 异常 → []。
import { describe, expect, it, vi } from "vitest";
import type { CompletionExecuteRequest, CompletionExecuteResult } from "../host/protocol";
import { createCompletionHostClient, type CompletionHostInvoke } from "../host/hostClient";
import { GENERATOR_ITEM_SOURCE } from "./generatorRunner";
import { GeneratorScheduler, type FigGeneratorSlot } from "./generatorScheduler";

function branchesResult(overrides?: Partial<CompletionExecuteResult>): CompletionExecuteResult {
  return { exitCode: 0, stdout: "main\nmaster\nmaintenance\n", stderr: "", truncated: false, timedOut: false, ...overrides };
}

function baseSlot(overrides?: Partial<FigGeneratorSlot>): FigGeneratorSlot {
  return {
    script: ["git", "branch", "--format=%(refname:short)"],
    command: "git",
    commandPath: ["git"],
    prefix: "",
    tokenStart: 4,
    tokenEnd: 6,
    ...overrides,
  };
}

interface SchedulerHarness {
  scheduler: GeneratorScheduler;
  invoke: ReturnType<typeof vi.fn>;
  clock: { now: number };
  setTarget: (target: { kind: "local" | "ssh"; sessionId: string } | null) => void;
  setCwd: (cwd: string | null) => void;
  requests: CompletionExecuteRequest[];
}

function harness(stdoutResult: CompletionExecuteResult | null = branchesResult()): SchedulerHarness {
  const requests: CompletionExecuteRequest[] = [];
  const clock = { now: 1_000_000 };
  let target: { kind: "local" | "ssh"; sessionId: string } | null = { kind: "ssh", sessionId: "session-1" };
  let cwd: string | null = null;
  const invoke = vi.fn(async (method: string, params?: unknown) => {
    expect(method).toBe("completion/execute");
    requests.push(params as CompletionExecuteRequest);
    return stdoutResult;
  });
  const scheduler = new GeneratorScheduler({
    collect: () => [],
    target: () => target,
    cwd: () => cwd,
    hostClient: createCompletionHostClient(invoke as unknown as CompletionHostInvoke),
    now: () => clock.now,
  });
  return {
    scheduler,
    invoke,
    clock,
    requests,
    setTarget: (next) => (target = next),
    setCwd: (next) => (cwd = next),
  };
}

const figNativePostProcess = (out: string) =>
  out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((name) => ({ name, description: `branch ${name}`, icon: "fig-branch" }));

describe("GeneratorScheduler · run（执行 + 收敛）", () => {
  it("happy path：请求组装（mode/timeout/上限）+ Fig 原生 suggestion 收敛为 CompletionItem", async () => {
    const h = harness();
    const items = await h.scheduler.run(baseSlot({ postProcess: figNativePostProcess, prefix: "ma" }));
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      target: { kind: "ssh", sessionId: "session-1" },
      command: "git",
      args: ["branch", "--format=%(refname:short)"],
      cwd: null,
      timeoutMs: 1200,
      maxOutputBytes: 262_144,
      mode: "completion-generator",
    });
    // Fig 原生 {name, description, icon} → label/description 透传，icon 不透传。
    expect(items).toHaveLength(3);
    expect(items?.[0]).toMatchObject({
      label: "main",
      description: "branch main",
      kind: "argument",
      score: 0,
      source: GENERATOR_ITEM_SOURCE,
      edit: { text: "main", replaceStart: 4, replaceEnd: 6, cursorOffset: 8 },
    });
    expect(items?.[0]).not.toHaveProperty("icon");
  });

  it("splitOn 透传：逗号分隔产出经缺省 postProcess 收敛为候选", async () => {
    const h = harness({ exitCode: 0, stdout: "pod-a,pod-b,", stderr: "", truncated: false, timedOut: false });
    const items = await h.scheduler.run(baseSlot({ script: ["kubectl", "get", "pods"], splitOn: "," }));
    expect(items?.map((item) => item.label)).toEqual(["pod-a", "pod-b"]);
  });

  it("无 spec postProcess → 缺省语义：非空切分片段即候选名", async () => {
    const h = harness();
    const items = await h.scheduler.run(baseSlot());
    expect(items?.map((item) => item.label)).toEqual(["main", "master", "maintenance"]);
  });

  it("spec postProcess 抛错 → null（WebView 执行面兜底）", async () => {
    const h = harness();
    const items = await h.scheduler.run(
      baseSlot({
        postProcess: () => {
          throw new Error("postProcess boom");
        },
      }),
    );
    expect(items).toBeNull();
  });

  it("execute null（桥/畸形）与 timedOut → null", async () => {
    const h1 = harness(null);
    await expect(h1.scheduler.run(baseSlot())).resolves.toBeNull();
    const h2 = harness({ exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true });
    await expect(h2.scheduler.run(baseSlot())).resolves.toBeNull();
  });

  it("非零 exitCode 不判失败：stdout 照常交 postProcess", async () => {
    const h = harness({ exitCode: 1, stdout: "main\nmaster\n", stderr: "warn", truncated: false, timedOut: false });
    const items = await h.scheduler.run(baseSlot({ postProcess: figNativePostProcess }));
    expect(items?.map((item) => item.label)).toEqual(["main", "master"]);
  });

  it("前缀过滤：generator 产出按当前 token 前缀收敛", async () => {
    const h = harness();
    const items = await h.scheduler.run(baseSlot({ prefix: "ma" }));
    expect(items?.map((item) => item.label)).toEqual(["main", "master", "maintenance"]);
    const empty = await h.scheduler.run(baseSlot({ prefix: "zzz" }));
    expect(empty).toEqual([]);
  });

  it("无目标（无会话/串口）→ null 且不打 RPC", async () => {
    const h = harness();
    h.setTarget(null);
    await expect(h.scheduler.run(baseSlot())).resolves.toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("cwd 透传进 execute 请求", async () => {
    const h = harness();
    h.setCwd("/srv/repo");
    await h.scheduler.run(baseSlot());
    expect(h.requests[0].cwd).toBe("/srv/repo");
  });
});

describe("GeneratorScheduler · TTL 缓存（§29）", () => {
  it("同 key 命中不重复打 RPC（在途共享同一 promise）", async () => {
    const h = harness();
    const slot = baseSlot({ postProcess: figNativePostProcess });
    const [a, b] = await Promise.all([h.scheduler.run(slot), h.scheduler.run(slot)]);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    // TTL 窗口内的第三次调用同样命中。
    h.clock.now += 100;
    await h.scheduler.run(slot);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("TTL 过期后重新执行", async () => {
    const h = harness();
    const slot = baseSlot();
    await h.scheduler.run(slot);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.clock.now += 301;
    await h.scheduler.run(slot);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("缓存 key 区分 tokenStart / sessionId / cwd / script（前缀归并不切 key）", async () => {
    const h = harness();
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    await h.scheduler.run(baseSlot({ prefix: "ma", tokenStart: 8 }));
    expect(h.invoke).toHaveBeenCalledTimes(2);
    h.clock.now += 400;
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    h.setTarget({ kind: "local", sessionId: "local-1" });
    h.clock.now += 400;
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    h.setCwd("/tmp");
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    await h.scheduler.run(baseSlot({ prefix: "ma", script: ["git", "tag"] }));
    // tokenStart/session/cwd/script 各 key 均不同 → 每次都执行；TTL 内的
    // 重复调用（第 4 步）命中缓存（前缀归并不切 key，也不多打）。
    expect(h.invoke).toHaveBeenCalledTimes(6);
  });

  it("前缀归并：同 token 连续前缀共享一次执行，各调用按自己的前缀过滤", async () => {
    const h = harness();
    // stdout: main/master/maintenance —— 逐键 ma/mai/空前缀 的模拟
    const first = await h.scheduler.run(baseSlot({ prefix: "ma" }));
    const second = await h.scheduler.run(baseSlot({ prefix: "mai" }));
    const third = await h.scheduler.run(baseSlot({ prefix: "" }));
    expect(h.invoke).toHaveBeenCalledTimes(1); // 一个 burst 只打一次 RPC
    expect(first?.map((item) => item.label)).toEqual(["main", "master", "maintenance"]);
    expect(second?.map((item) => item.label)).toEqual(["main", "maintenance"]);
    expect(third?.map((item) => item.label)).toEqual(["main", "master", "maintenance"]);
    // TTL 过期后同前缀才重打
    h.clock.now += 301;
    await h.scheduler.run(baseSlot({ prefix: "ma" }));
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("TTL 内换 key：tokenStart 变化不串产出", async () => {
    const h = harness();
    await h.scheduler.run(baseSlot({ prefix: "ma", tokenStart: 4 }));
    await h.scheduler.run(baseSlot({ prefix: "ma", tokenStart: 12 }));
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("GeneratorScheduler · slots（收集面）", () => {
  it("collect 抛错 → []；非数组 → []", () => {
    const boom = new GeneratorScheduler({ collect: () => { throw new Error("parse boom"); }, target: () => null });
    expect(boom.slots({ line: "git ", requestId: 1, revision: 0, sessionId: "s", trigger: "typing" })).toEqual([]);
    const weird = new GeneratorScheduler({ collect: () => undefined as unknown as FigGeneratorSlot[], target: () => null });
    expect(weird.slots({ line: "git ", requestId: 1, revision: 0, sessionId: "s", trigger: "typing" })).toEqual([]);
  });
});
