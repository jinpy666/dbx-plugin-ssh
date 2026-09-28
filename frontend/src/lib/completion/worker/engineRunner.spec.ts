// @vitest-environment happy-dom（经 engine.worker 引入 parser 产物，其模块顶层向 window 注册调试钩子）
// engineRunner 单测（FIG 批次 2-2）：全 Fake、零联网、不触发真实 inline worker
// 构造。覆盖 roadmap 批次 2-2 四条路径：
//   1. 主线程 fallback（构造 throw / 环境不支持）→ 严格同步直跑 createSource；
//   2. worker 模式协议序列化往返（FakeWorker 记录 postMessage / 回执注入）；
//   3. 崩溃恢复 §44：error/messageerror → 丢弃在途 → 重启一次 → 再败永久降级；
//   4. engine.worker 消息处理（真实 handler + Fake source）：异常 → response:null。
// 真实 WebView 内 data-URL worker 的端到端路径见 lane 报告"人工验收清单"。

import { beforeEach, describe, expect, it, vi } from "vitest";

// 真实 `?worker&inline` 构造器在测试中绝不允许被触发：默认工厂若被走到必须
// 显式炸出（构造 throw 会被 runner 的 trySpawn 捕获降级，这正是被测路径）。
vi.mock("./engine.worker.ts?worker&inline", () => ({
  default: class ForbiddenRealInlineWorker {
    constructor() {
      throw new Error(
        "engineRunner.spec: 真实 inline worker 不得在测试中构造（应注入 createWorker）",
      );
    }
  },
}));

import {
  createEngineRunner,
  type EngineWorkerRequest,
  type EngineWorkerResponse,
} from "./engineRunner";
import { createWorkerMessageHandler } from "./engine.worker";
import type { CompletionResponse } from "../core/types";
import type { FigCompletionSource, FigSourceRequest } from "../fig/source";

// ---------------------------------------------------------------------------
// Fake 设施
// ---------------------------------------------------------------------------

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly sent: unknown[] = [];
  terminated = false;

  postMessage(data: unknown): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 测试辅助：模拟 worker 回执。 */
  reply(message: { requestId: number; response?: CompletionResponse | null }): void {
    const payload: EngineWorkerResponse = {
      kind: "response",
      requestId: message.requestId,
      revision: 0,
      sessionId: "s1",
      response: message.response ?? null,
    };
    this.onmessage?.({ data: payload });
  }

  /** 测试辅助：模拟 worker 脚本级崩溃（error 事件）。 */
  crash(): void {
    this.onerror?.(new Error("fake worker error"));
  }

  /** 测试辅助：模拟结构化克隆失败（messageerror 事件）。 */
  messageError(): void {
    this.onmessageerror?.(new Error("fake messageerror"));
  }
}

function makeWorkerFactory(): { create: () => Worker; instances: FakeWorker[] } {
  const instances: FakeWorker[] = [];
  const create = (): Worker => {
    const worker = new FakeWorker();
    instances.push(worker);
    return worker as unknown as Worker;
  };
  return { create, instances };
}

class FakeSource implements FigCompletionSource {
  readonly id = "fake-spec";
  readonly calls: FigSourceRequest[] = [];
  throwOnResolve = false;
  /** 非 null 时返回该畸形产物（测 worker 侧形态校验）。 */
  malformedOutcome: unknown = null;

  resolve(request: FigSourceRequest): CompletionResponse | null {
    this.calls.push(request);
    if (this.throwOnResolve) throw new Error("fake source boom");
    if (this.malformedOutcome !== null) return this.malformedOutcome as CompletionResponse;
    return {
      requestId: request.requestId,
      revision: request.revision,
      state: "ready",
      items: [],
    };
  }
}

function makeRequest(overrides: Partial<FigSourceRequest> = {}): FigSourceRequest {
  return {
    line: "git ch",
    requestId: 1,
    revision: 1,
    sessionId: "s1",
    trigger: "typing",
    ...overrides,
  };
}

function makeResponse(requestId: number, revision = 1): CompletionResponse {
  return {
    requestId,
    revision,
    state: "ready",
    context: { command: "git", commandPath: [], tokenStart: 4, tokenEnd: 6 },
    items: [
      {
        id: "fake-spec:checkout",
        label: "checkout",
        kind: "subcommand",
        score: 420,
        source: "fig-spec",
        edit: { text: "checkout ", replaceStart: 4, replaceEnd: 6 },
      },
    ],
  };
}

const isThenable = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

/** worker 模式专用：断言 resolve 返回 thenable 并按 Promise 取用（冻结接缝
 * 公开类型是同步签名；worker 模式运行时返回 Promise 属 engineRunner 文件头
 * "同步/异步取舍"的既定契约）。 */
function resolveViaWorker(
  runner: FigCompletionSource,
  request: FigSourceRequest,
): Promise<CompletionResponse | null> {
  const outcome = runner.resolve(request);
  expect(isThenable(outcome)).toBe(true);
  return outcome as unknown as Promise<CompletionResponse | null>;
}

let fakeSource: FakeSource;

beforeEach(() => {
  fakeSource = new FakeSource();
});

// ---------------------------------------------------------------------------
// 1. 主线程 fallback 路径
// ---------------------------------------------------------------------------

describe("engineRunner 主线程 fallback", () => {
  it("构造 inline worker throw（CSP 拦 data-URL）→ 主线程直跑，resolve 严格同步", () => {
    const runner = createEngineRunner({
      createSource: () => fakeSource,
      createWorker: () => {
        throw new Error("CSP blocks data-URL worker");
      },
    });
    expect(runner.id).toBe("fake-spec");
    const outcome = runner.resolve(makeRequest({ requestId: 7, revision: 2 }));
    expect(isThenable(outcome)).toBe(false); // 无 Promise：零时序漂移
    expect(outcome).toMatchObject({ requestId: 7, revision: 2, state: "ready" });
    expect(fakeSource.calls).toHaveLength(1);
  });

  it("运行环境无 Worker 全局（默认工厂 feature-detect）→ 主线程直跑", () => {
    // happy-dom/node 均不提供 Worker：defaultSpawn 返回 null，不触碰真实
    // inline worker 构造器（即便被走到，vi.mock 的默认构造器也会 throw，
    // 同样被 defaultSpawn 的 try/catch 捕获降级）。
    const runner = createEngineRunner({ createSource: () => fakeSource });
    const outcome = runner.resolve(makeRequest());
    expect(isThenable(outcome)).toBe(false);
    expect(outcome).toMatchObject({ state: "ready" });
  });
});

// ---------------------------------------------------------------------------
// 2. worker 模式：协议序列化往返（FakeWorker）
// ---------------------------------------------------------------------------

describe("engineRunner worker 模式协议往返", () => {
  it("resolve 发送协议消息并按 requestId 关联回执", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({
      createSource: () => fakeSource,
      createWorker: create,
    });
    expect(instances).toHaveLength(1); // 构造成功 → worker 模式（source 未被触碰）
    expect(fakeSource.calls).toHaveLength(0);

    const first = instances[0];
    const promise = resolveViaWorker(
      runner,
      makeRequest({ requestId: 11, revision: 3, line: "git co", trigger: "tab" }),
    );
    expect(first.sent).toEqual([
      {
        kind: "resolve",
        requestId: 11,
        revision: 3,
        sessionId: "s1",
        line: "git co",
        trigger: "tab",
      },
    ]);

    const response = makeResponse(11, 3);
    first.reply({ requestId: 11, response });
    await expect(promise).resolves.toBe(response);
  });

  it("response:null 回执按 null 结清（controller 侧转 pass-through）", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const promise = resolveViaWorker(runner, makeRequest({ requestId: 1 }));
    instances[0].reply({ requestId: 1, response: null });
    await expect(promise).resolves.toBe(null);
  });

  it("requestId 未匹配 / 重复回执被忽略，非 response 消息被忽略", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const first = instances[0];
    const promise = resolveViaWorker(runner, makeRequest({ requestId: 1 }));

    first.reply({ requestId: 99 }); // 未知 requestId → 忽略
    first.onmessage?.({ data: { kind: "other" } }); // 未知 kind → 忽略
    first.onmessage?.({ data: null });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false); // 仍挂起

    first.reply({ requestId: 1, response: makeResponse(1) }); // 正常回执
    first.reply({ requestId: 1, response: makeResponse(1) }); // 重复回执 → 忽略
    const settled1 = await promise;
    expect(settled1).not.toBe(null);
  });

  it("postMessage 抛错（通道已坏）→ 按 §44 崩溃处理并结清为 null", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const first = instances[0];
    first.postMessage = () => {
      throw new Error("dead channel");
    };
    const promise = resolveViaWorker(runner, makeRequest({ requestId: 1 }));
    await expect(promise).resolves.toBe(null);
    expect(instances.length).toBe(2); // 触发了一次重启
    expect(first.terminated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 崩溃恢复（§44）：error/messageerror → 丢弃在途 → 重启一次 → 永久降级
// ---------------------------------------------------------------------------

describe("engineRunner 崩溃恢复（§44）", () => {
  it("worker error → 丢弃在途（null 结清）→ 重启一次，新请求走新一代 worker", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const first = instances[0];

    const inFlight = resolveViaWorker(runner, makeRequest({ requestId: 1, revision: 1 }));
    first.crash();
    await expect(inFlight).resolves.toBe(null); // 在途丢弃
    expect(first.terminated).toBe(true);
    expect(instances).toHaveLength(2);

    const second = instances[1];
    const promise2 = runner.resolve(makeRequest({ requestId: 2, revision: 2 }));
    expect(first.sent).toHaveLength(1); // 新消息不再发往旧 worker
    expect((second.sent[0] as EngineWorkerRequest).requestId).toBe(2);
    const response2 = makeResponse(2, 2);
    second.reply({ requestId: 2, response: response2 });
    await expect(promise2).resolves.toBe(response2);
  });

  it("messageerror 同样触发恢复路径", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const inFlight = resolveViaWorker(runner, makeRequest({ requestId: 1 }));
    instances[0].messageError();
    await expect(inFlight).resolves.toBe(null);
    expect(instances).toHaveLength(2);
  });

  it("第二次崩溃 → 永久降级主线程（不再重启，后续 resolve 同步）", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const inFlight = resolveViaWorker(runner, makeRequest({ requestId: 1 }));
    instances[0].crash();
    await inFlight;
    instances[1].crash();

    expect(instances).toHaveLength(2); // 无第三代 worker
    expect(fakeSource.calls).toHaveLength(0); // 降级前 source 未被触碰
    const outcome = runner.resolve(makeRequest({ requestId: 3, revision: 3 }));
    expect(isThenable(outcome)).toBe(false); // 永久主线程：严格同步
    expect(outcome).toMatchObject({ requestId: 3, state: "ready" });
    expect(fakeSource.calls).toHaveLength(1);
  });

  it("旧 worker 的迟到回执不影响新一代 worker", async () => {
    const { create, instances } = makeWorkerFactory();
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    const first = instances[0];
    const inFlight = resolveViaWorker(runner, makeRequest({ requestId: 1 }));
    first.crash();
    await inFlight; // 在途已按 null 结清

    const lateResponse = makeResponse(1);
    first.reply({ requestId: 1, response: lateResponse }); // 迟到回执 → 无人接收

    const second = instances[1];
    const response2 = makeResponse(2, 2);
    const promise2 = resolveViaWorker(runner, makeRequest({ requestId: 2, revision: 2 }));
    second.reply({ requestId: 2, response: response2 });
    await expect(promise2).resolves.toBe(response2); // 迟到回执未串扰新请求
  });

  it("重启时构造失败 → 直接永久降级", async () => {
    let calls = 0;
    const create = (): Worker => {
      calls += 1;
      if (calls > 1) throw new Error("CSP now blocks restart");
      return new FakeWorker() as unknown as Worker;
    };
    const runner = createEngineRunner({ createSource: () => fakeSource, createWorker: create });
    runner.resolve(makeRequest({ requestId: 1 }));
    (runner as unknown as { worker: FakeWorker | null }).worker?.crash();

    const outcome = runner.resolve(makeRequest({ requestId: 2, revision: 2 }));
    expect(isThenable(outcome)).toBe(false); // 重启失败 → 永久主线程
    expect(fakeSource.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. engine.worker 消息处理（真实 handler + Fake source）
// ---------------------------------------------------------------------------

describe("engine.worker 消息处理", () => {
  function makeHandler(source: FigCompletionSource) {
    const posted: EngineWorkerResponse[] = [];
    const handle = createWorkerMessageHandler(source, (message) => {
      posted.push(message);
    });
    return { posted, handle };
  }

  it("resolve 请求 → source.resolve → post 协议回执", () => {
    const { posted, handle } = makeHandler(fakeSource);
    handle({
      kind: "resolve",
      requestId: 5,
      revision: 2,
      sessionId: "sess-a",
      line: "git ch",
      trigger: "typing",
    });
    expect(fakeSource.calls).toEqual([
      {
        line: "git ch",
        requestId: 5,
        revision: 2,
        sessionId: "sess-a",
        trigger: "typing",
      },
    ]);
    expect(posted).toEqual([
      {
        kind: "response",
        requestId: 5,
        revision: 2,
        sessionId: "sess-a",
        response: { requestId: 5, revision: 2, state: "ready", items: [] },
      },
    ]);
  });

  it("source 抛错 → 回 response:null（pass-through 空响应），handler 不外抛", () => {
    fakeSource.throwOnResolve = true;
    const { posted, handle } = makeHandler(fakeSource);
    expect(() =>
      handle({
        kind: "resolve",
        requestId: 1,
        revision: 1,
        sessionId: "s1",
        line: "git ch",
        trigger: "typing",
      }),
    ).not.toThrow();
    expect(posted).toEqual([
      { kind: "response", requestId: 1, revision: 1, sessionId: "s1", response: null },
    ]);
  });

  it("source 返回畸形产物 → 回 response:null", () => {
    fakeSource.malformedOutcome = { unexpected: true };
    const { posted, handle } = makeHandler(fakeSource);
    handle({
      kind: "resolve",
      requestId: 2,
      revision: 1,
      sessionId: "s1",
      line: "git ch",
      trigger: "typing",
    });
    expect(posted[0].response).toBe(null);
  });

  it("畸形消息静默忽略（非对象 / 未知 kind / 字段形态不符）", () => {
    const { posted, handle } = makeHandler(fakeSource);
    expect(() => {
      handle(undefined);
      handle(null);
      handle(42);
      handle({ kind: "other" });
      handle({ kind: "resolve", requestId: "bad", revision: 1, sessionId: "s1", line: "git" });
      handle({ kind: "resolve", requestId: 1, revision: 1, sessionId: 7, line: "git" });
    }).not.toThrow();
    expect(posted).toEqual([]);
    expect(fakeSource.calls).toEqual([]);
  });

  it("trigger 非法值容错为 typing，不弃整条请求", () => {
    const { posted, handle } = makeHandler(fakeSource);
    handle({
      kind: "resolve",
      requestId: 3,
      revision: 1,
      sessionId: "s1",
      line: "git ch",
      trigger: "bogus" as FigSourceRequest["trigger"],
    });
    expect(fakeSource.calls[0].trigger).toBe("typing");
    expect(posted).toHaveLength(1);
    expect(posted[0].response).not.toBe(null);
  });
});
