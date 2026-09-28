// CompletionController 单测（FIG wave-1 Lane A）：三重 guard
// （revision/requestId/sessionId）、debounce 合并、异常降级 pass-through、
// accept→onAcceptEdit、enabled=false、同步 resolver 的零时序交付。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionController, type CompletionResolver } from "./CompletionController";
import type { CompletionEdit, CompletionItem, CompletionResponse } from "./core/types";

interface DeferredResolver {
  resolver: CompletionResolver;
  pending: Array<{ resolve: (response: CompletionResponse) => void; reject: (cause?: unknown) => void }>;
}

/** 挂起式 resolver：每次调用登记一个 pending，由测试手动 resolve/reject。 */
function deferredResolver(): DeferredResolver {
  const pending: DeferredResolver["pending"] = [];
  const resolver: CompletionResolver = (input) =>
    new Promise<CompletionResponse>((resolve, reject) => pending.push({ resolve, reject }));
  return { resolver, pending };
}

function readyResponse(input: { requestId: number; revision: number }, label = "checkout"): CompletionResponse {
  const item: CompletionItem = {
    id: `test:${label}`,
    label,
    kind: "subcommand",
    score: 100,
    source: "test",
    edit: { text: `${label} `, replaceStart: 4, replaceEnd: 6 },
  };
  return { requestId: input.requestId, revision: input.revision, state: "ready", context: { command: "git", commandPath: ["git"], tokenStart: 4, tokenEnd: 6 }, items: [item] };
}

interface Harness {
  controller: CompletionController;
  responses: CompletionResponse[];
  edits: CompletionEdit[];
  setLine: (line: string) => void;
  setSessionId: (sessionId: string) => void;
  setEnabled: (enabled: boolean) => void;
}

function harness(resolver?: CompletionResolver, debounceMs = 90): Harness {
  let line = "git ch";
  let sessionId = "session-a";
  let enabled = true;
  const responses: CompletionResponse[] = [];
  const edits: CompletionEdit[] = [];
  const controller = new CompletionController({
    sessionId: () => sessionId,
    readLine: () => line,
    enabled: () => enabled,
    debounceMs,
    resolver,
    onResponse: (response) => responses.push(response),
    onAcceptEdit: (edit) => edits.push(edit),
  });
  return {
    controller,
    responses,
    edits,
    setLine: (next) => (line = next),
    setSessionId: (next) => (sessionId = next),
    setEnabled: (next) => (enabled = next),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CompletionController · 同步交付（wave 1 legacy 形态）", () => {
  it("delivers the default legacy resolver response synchronously inside request()", () => {
    const { controller, responses } = harness();
    controller.request("typing");
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("ready");
    expect(responses[0].items.map((item) => item.label)).toContain("checkout");
  });

  it("resolves against the line snapshot taken at dispatch time", () => {
    const { controller, responses, setLine } = harness();
    setLine("git checkout -");
    controller.request("manual");
    expect(responses[0].items.every((item) => item.kind === "option")).toBe(true);
  });
});

describe("CompletionController · debounce 合并", () => {
  it("coalesces multiple lineChanged calls within the window into one request", () => {
    const { controller, responses, setLine } = harness();
    controller.lineChanged();
    setLine("git c");
    controller.lineChanged();
    setLine("git ch");
    controller.lineChanged();
    expect(responses).toHaveLength(0);
    vi.advanceTimersByTime(89);
    expect(responses).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(responses).toHaveLength(1);
    // 请求基于最后一次行缓冲（git ch），而非中间态。
    expect(responses[0].items.map((item) => item.label)).toContain("checkout");
  });

  it("re-arms the window on a later lineChanged", () => {
    const { controller, responses } = harness();
    controller.lineChanged();
    vi.advanceTimersByTime(60);
    controller.lineChanged();
    vi.advanceTimersByTime(60);
    expect(responses).toHaveLength(0);
    vi.advanceTimersByTime(30);
    expect(responses).toHaveLength(1);
  });

  it("request() flushes immediately and cancels the pending debounce", () => {
    const { controller, responses } = harness();
    controller.lineChanged();
    controller.request("manual");
    expect(responses).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(responses).toHaveLength(1);
  });

  it("dismiss() cancels the scheduled debounce", () => {
    const { controller, responses } = harness();
    controller.lineChanged();
    controller.dismiss();
    vi.advanceTimersByTime(500);
    expect(responses).toHaveLength(0);
  });
});

describe("CompletionController · 三重 guard", () => {
  it("drops a response whose revision no longer matches (line changed while resolving)", async () => {
    const deferred = deferredResolver();
    const { controller, responses } = harness(deferred.resolver);
    controller.request("typing");
    expect(deferred.pending).toHaveLength(1);
    const { resolve } = deferred.pending[0];
    controller.lineChanged(); // revision++（行已变）
    resolve(readyResponse({ requestId: 1, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
  });

  it("drops a response whose requestId was superseded by a newer dispatch", async () => {
    const deferred = deferredResolver();
    const { controller, responses } = harness(deferred.resolver);
    controller.request("typing");
    controller.request("manual");
    expect(deferred.pending).toHaveLength(2);
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
    deferred.pending[1].resolve(readyResponse({ requestId: 2, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
  });

  it("drops a response delivered after a session switch (sessionId guard / resetSession)", async () => {
    const deferred = deferredResolver();
    const { controller, responses, setSessionId } = harness(deferred.resolver);
    controller.request("typing");
    setSessionId("session-b");
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
    // resetSession 同样作废在途（requestId 跳变）。
    controller.request("typing");
    controller.resetSession();
    deferred.pending[1].resolve(readyResponse({ requestId: 2, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
  });

  it("still delivers when all three anchors match", async () => {
    const deferred = deferredResolver();
    const { controller, responses } = harness(deferred.resolver);
    controller.request("typing");
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("ready");
  });
});

describe("CompletionController · 异常降级（PTY 红线）", () => {
  it("degrades a throwing sync resolver to a pass-through response without rethrowing", () => {
    const boom: CompletionResolver = () => {
      throw new Error("parser exploded");
    };
    const { controller, responses } = harness(boom);
    expect(() => controller.request("typing")).not.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("pass-through");
    expect(responses[0].items).toEqual([]);
  });

  it("degrades a rejecting async resolver to a pass-through response", async () => {
    const deferred = deferredResolver();
    const { controller, responses } = harness(deferred.resolver);
    controller.request("typing");
    deferred.pending[0].reject(new Error("rpc failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("pass-through");
  });

  it("swallows a throwing onAcceptEdit instead of bubbling into the key handler", () => {
    const edits: CompletionEdit[] = [];
    const controller = new CompletionController({
      sessionId: () => "s",
      readLine: () => "git ch",
      enabled: () => true,
      onResponse: () => undefined,
      onAcceptEdit: (edit) => {
        edits.push(edit);
        throw new Error("terminal write failed");
      },
    });
    const item = readyResponse({ requestId: 1, revision: 0 }).items[0];
    expect(() => controller.accept(item)).not.toThrow();
    expect(edits).toHaveLength(1);
  });
});

describe("CompletionController · accept", () => {
  it("forwards the resolver-produced edit to onAcceptEdit verbatim", () => {
    const { controller, responses, edits } = harness();
    controller.request("typing");
    const checkout = responses[0].items.find((item) => item.label === "checkout");
    expect(checkout).toBeDefined();
    controller.accept(checkout!);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ text: "checkout ", replaceStart: 4, replaceEnd: 6 });
  });
});

describe("CompletionController · enabled 开关", () => {
  it("does not schedule or resolve when disabled (lineChanged path)", () => {
    const { controller, responses, setEnabled } = harness();
    setEnabled(false);
    controller.lineChanged();
    vi.advanceTimersByTime(1000);
    expect(responses).toHaveLength(0);
  });

  it("does not resolve on a direct request when disabled", () => {
    const { controller, responses, setEnabled } = harness();
    setEnabled(false);
    controller.request("manual");
    expect(responses).toHaveLength(0);
  });
});
