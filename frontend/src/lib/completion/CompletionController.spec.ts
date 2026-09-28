// CompletionController 单测（FIG wave-1 Lane A'）：resolver = 冻结接缝
// FigCompletionSource（真实 Fake 驱动 + 桩源驱动异常/stale 路径）。覆盖：
// ready 同步交付 / pass-through(null) / 异常吞掉降级 / stale 丢弃（三重
// guard：revision+requestId+sessionId）/ enabled=false / debounce 合并 /
// accept→onAcceptEdit 边界。FakeFigCompletionSource 自身的小语料行为
// （别名/深层 null/flag）也在本文件一并锁定。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionController } from "./CompletionController";
import { FakeFigCompletionSource, createPassThroughFigSource } from "./testing/fakeFigSource";
import type { CompletionEdit, CompletionItem, CompletionResponse } from "./core/types";
import type { FigCompletionSource, FigSourceRequest } from "./fig/source";

/** 挂起式异步 source（防御 thenable 分支 + stale 路径驱动）。冻结接缝类型为
 * 同步，此处显式断言模拟 Worker 化未来形态，生产实现不受影响。 */
function deferredSource(): { source: FigCompletionSource; pending: Array<{ resolve: (response: CompletionResponse | null) => void; reject: (cause?: unknown) => void }> } {
  const pending: Array<{ resolve: (response: CompletionResponse | null) => void; reject: (cause?: unknown) => void }> = [];
  const source: FigCompletionSource = {
    id: "deferred",
    resolve: () =>
      new Promise<CompletionResponse | null>((resolve, reject) => pending.push({ resolve, reject })) as unknown as CompletionResponse | null,
  };
  return { source, pending };
}

function item(label: string, overrides: Partial<CompletionItem> = {}): CompletionItem {
  return {
    id: `test:${label}`,
    label,
    description: `${label} description`,
    kind: "subcommand",
    score: 100,
    source: "test",
    edit: { text: `${label} `, replaceStart: 4, replaceEnd: 6 },
    ...overrides,
  };
}

function readyResponse(request: { requestId: number; revision: number }, items: CompletionItem[]): CompletionResponse {
  return {
    requestId: request.requestId,
    revision: request.revision,
    state: "ready",
    context: { command: "git", commandPath: ["git"], tokenStart: 4, tokenEnd: 6 },
    items,
  };
}

interface Harness {
  controller: CompletionController;
  responses: CompletionResponse[];
  edits: CompletionEdit[];
  setLine: (line: string) => void;
  setSessionId: (sessionId: string) => void;
  setEnabled: (enabled: boolean) => void;
  seenRequests: FigSourceRequest[];
}

function harness(source: FigCompletionSource, debounceMs = 90): Harness {
  let line = "git ch";
  let sessionId = "session-a";
  let enabled = true;
  const responses: CompletionResponse[] = [];
  const edits: CompletionEdit[] = [];
  const seenRequests: FigSourceRequest[] = [];
  const controller = new CompletionController({
    source: {
      id: source.id,
      resolve: (request) => {
        seenRequests.push(request);
        return source.resolve(request);
      },
    },
    sessionId: () => sessionId,
    readLine: () => line,
    enabled: () => enabled,
    debounceMs,
    onResponse: (response) => responses.push(response),
    onAcceptEdit: (edit) => edits.push(edit),
  });
  return {
    controller,
    responses,
    edits,
    seenRequests,
    setLine: (next) => (line = next),
    setSessionId: (next) => (sessionId = next),
    setEnabled: (next) => (enabled = next),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CompletionController · FakeFigCompletionSource 驱动（同步交付）", () => {
  it("delivers a ready response synchronously inside request()", () => {
    const { controller, responses } = harness(new FakeFigCompletionSource());
    controller.request("typing");
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("ready");
    expect(responses[0].items.map((entry) => entry.label)).toContain("checkout");
    // request 元数据原样回带（三重 guard 的锚点）。
    expect(responses[0].requestId).toBe(1);
    expect(responses[0].revision).toBe(0);
  });

  it("resolves against the line snapshot taken at dispatch time", () => {
    const { controller, responses, setLine } = harness(new FakeFigCompletionSource());
    setLine("git co");
    controller.request("typing");
    // "co" 前缀同时命中 checkout（别名展开）与 commit/config；checkout 以别名分入列。
    const checkout = responses[0].items.find((entry) => entry.label === "checkout");
    expect(checkout?.score).toBe(90);
    expect(responses[0].items.map((entry) => entry.label)).toEqual(expect.arrayContaining(["commit", "config"]));
  });

  it("pass-through: unknown command resolves to null and degrades to a pass-through response", () => {
    const { controller, responses, setLine } = harness(new FakeFigCompletionSource());
    setLine("unknowncmd x");
    controller.request("typing");
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("pass-through");
    expect(responses[0].items).toEqual([]);
  });

  it("pass-through: deeper argument positions resolve to null (generator 领域)", () => {
    const { controller, responses, setLine } = harness(new FakeFigCompletionSource());
    setLine("git checkout ");
    controller.request("typing");
    expect(responses[0].state).toBe("pass-through");
  });

  it("flag prefix candidates carry option kind and per-item edits", () => {
    const { controller, responses, setLine } = harness(new FakeFigCompletionSource());
    setLine("git -");
    controller.request("typing");
    expect(responses[0].items.every((entry) => entry.kind === "option")).toBe(true);
    expect(responses[0].items[0].edit.replaceStart).toBe(4);
  });
});

describe("CompletionController · 异常降级（PTY 红线）", () => {
  it("degrades a throwing sync source to a pass-through response without rethrowing", () => {
    const boom: FigCompletionSource = {
      id: "boom",
      resolve: () => {
        throw new Error("parser exploded");
      },
    };
    const { controller, responses } = harness(boom);
    expect(() => controller.request("typing")).not.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("pass-through");
    expect(responses[0].items).toEqual([]);
  });

  it("degrades a rejecting async source to a pass-through response", async () => {
    const deferred = deferredSource();
    const { controller, responses } = harness(deferred.source);
    controller.request("typing");
    deferred.pending[0].reject(new Error("rpc failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("pass-through");
  });

  it("swallows a throwing onAcceptEdit instead of bubbling into the key handler", () => {
    const edits: CompletionEdit[] = [];
    const controller = new CompletionController({
      source: new FakeFigCompletionSource(),
      sessionId: () => "s",
      readLine: () => "git ch",
      enabled: () => true,
      onResponse: () => undefined,
      onAcceptEdit: (edit) => {
        edits.push(edit);
        throw new Error("terminal write failed");
      },
    });
    const candidate = item("checkout");
    expect(() => controller.accept(candidate)).not.toThrow();
    expect(edits).toHaveLength(1);
  });
});

describe("CompletionController · 三重 guard（stale 丢弃）", () => {
  it("drops a response whose revision advanced while resolving (lineChanged re-entrancy)", () => {
    const { controller, responses } = harness({
      id: "reentrant",
      resolve: (request) => {
        // source 同步解析期间行又变了：响应带着旧 revision 返回，必须被丢弃。
        controller.lineChanged();
        return readyResponse(request, [item("checkout")]);
      },
    });
    controller.request("typing");
    expect(responses).toHaveLength(0);
  });

  it("drops a response whose requestId was superseded by a newer dispatch", async () => {
    const deferred = deferredSource();
    const { controller, responses } = harness(deferred.source);
    controller.request("typing");
    controller.request("manual");
    expect(deferred.pending).toHaveLength(2);
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
    deferred.pending[1].resolve(readyResponse({ requestId: 2, revision: 0 }, [item("status")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
    expect(responses[0].items[0].label).toBe("status");
  });

  it("drops a response delivered after a session switch (sessionId guard)", async () => {
    const deferred = deferredSource();
    const { controller, responses, setSessionId } = harness(deferred.source);
    controller.request("typing");
    setSessionId("session-b");
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
  });

  it("resetSession invalidates in-flight results (requestId bump)", async () => {
    const deferred = deferredSource();
    const { controller, responses } = harness(deferred.source);
    controller.request("typing");
    controller.resetSession();
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(0);
  });

  it("still delivers when all three anchors match", async () => {
    const deferred = deferredSource();
    const { controller, responses } = harness(deferred.source);
    controller.request("typing");
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(1);
    expect(responses[0].state).toBe("ready");
  });
});

describe("CompletionController · debounce 合并", () => {
  it("coalesces multiple lineChanged calls within the window into one request", () => {
    const { controller, responses, seenRequests, setLine } = harness(new FakeFigCompletionSource());
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
    // 只发一次，且基于最后一次行缓冲快照。
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].line).toBe("git ch");
    expect(seenRequests[0].trigger).toBe("typing");
  });

  it("re-arms the window on a later lineChanged", () => {
    const { controller, responses } = harness(new FakeFigCompletionSource());
    controller.lineChanged();
    vi.advanceTimersByTime(60);
    controller.lineChanged();
    vi.advanceTimersByTime(60);
    expect(responses).toHaveLength(0);
    vi.advanceTimersByTime(30);
    expect(responses).toHaveLength(1);
  });

  it("request() flushes immediately and cancels the pending debounce", () => {
    const { controller, responses } = harness(new FakeFigCompletionSource());
    controller.lineChanged();
    controller.request("manual");
    expect(responses).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(responses).toHaveLength(1);
  });

  it("dismiss() cancels the scheduled debounce and invalidates in-flight results", async () => {
    const deferred = deferredSource();
    const { controller, responses } = harness(deferred.source);
    controller.request("typing");
    controller.dismiss();
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    // dismiss 先 revision++：在途结果 revision 不再匹配 → 丢弃。
    expect(responses).toHaveLength(0);
    controller.lineChanged();
    vi.advanceTimersByTime(500);
    expect(responses).toHaveLength(0);
  });
});

describe("CompletionController · enabled 开关", () => {
  it("does not schedule or resolve when disabled (lineChanged path)", () => {
    const { controller, responses, setEnabled } = harness(new FakeFigCompletionSource());
    setEnabled(false);
    controller.lineChanged();
    vi.advanceTimersByTime(1000);
    expect(responses).toHaveLength(0);
  });

  it("does not resolve on a direct request when disabled", () => {
    const { controller, responses, setEnabled } = harness(new FakeFigCompletionSource());
    setEnabled(false);
    controller.request("manual");
    expect(responses).toHaveLength(0);
  });

  it("still bumps revision while disabled so late results stay stale", async () => {
    const deferred = deferredSource();
    const { controller, responses, setEnabled } = harness(deferred.source);
    controller.request("typing");
    setEnabled(false);
    controller.lineChanged();
    setEnabled(true);
    deferred.pending[0].resolve(readyResponse({ requestId: 1, revision: 0 }, [item("checkout")]));
    await vi.advanceTimersByTimeAsync(0);
    // 关闭期间的 lineChanged 已使 revision 前进：旧结果不得复活。
    expect(responses).toHaveLength(0);
  });
});

describe("CompletionController · accept", () => {
  it("forwards the source-produced edit to onAcceptEdit verbatim", () => {
    const { controller, edits } = harness(new FakeFigCompletionSource());
    const candidate = item("checkout");
    controller.accept(candidate);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ text: "checkout ", replaceStart: 4, replaceEnd: 6 });
  });
});

describe("createPassThroughFigSource", () => {
  it("always resolves to null (批次 1 生产占位，零浮层)", () => {
    const source = createPassThroughFigSource();
    expect(source.id).toBe("pass-through");
    expect(source.resolve({ line: "git ch", requestId: 1, revision: 0, sessionId: "s", trigger: "typing" })).toBeNull();
  });
});

describe("FakeFigCompletionSource · 小语料行为（手动清单锚点）", () => {
  const source = new FakeFigCompletionSource();
  const requestOf = (line: string): FigSourceRequest => ({ line, requestId: 1, revision: 0, sessionId: "s", trigger: "typing" });

  it("git ch → 静态子命令候选（checkout/cherry/cherry-pick…）", () => {
    const response = source.resolve(requestOf("git ch"));
    expect(response?.state).toBe("ready");
    const labels = response?.items.map((entry) => entry.label) ?? [];
    expect(labels).toContain("checkout");
    expect(labels).toContain("cherry");
    expect(labels).toContain("cherry-pick");
  });

  it("git co → 别名命中展开为 checkout（与普通前缀命中并存，别名分更高可信）", () => {
    const response = source.resolve(requestOf("git co"));
    const checkout = response?.items.find((entry) => entry.label === "checkout");
    expect(checkout?.kind).toBe("subcommand");
    expect(checkout?.score).toBe(90);
    expect(response?.items.every((entry) => entry.edit.replaceEnd === response?.items[0]?.edit.replaceEnd)).toBe(true);
  });

  it("无命中命令 → null（Tab 透传）", () => {
    expect(source.resolve(requestOf("notacommand su"))).toBeNull();
  });

  it("空行 → null", () => {
    expect(source.resolve(requestOf(""))).toBeNull();
  });

  it("深参数位置 → null（generator 动态位示范）", () => {
    expect(source.resolve(requestOf("git checkout main"))).toBeNull();
  });
});
