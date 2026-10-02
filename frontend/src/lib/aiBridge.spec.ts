// AI 桥薄封装单测（Warp AI 对齐批）：能力探测与 host.ai.openConversation 调用。
import { describe, expect, it } from "vitest";
import { aiBridgeAvailable, aiCompletionAvailable, aiRecommendationsAvailable, clearAiRecommendations, generateAiText, listAiModels, openAiConversation, pickDefaultAiModel, setAiRecommendations, type DbxPluginApiLike } from "./aiBridge";

const asApi = (request: (method: string, params?: unknown) => Promise<unknown>, capabilities: Record<string, unknown> = {}): DbxPluginApiLike => ({ capabilities, request: request as DbxPluginApiLike["request"] });

describe("aiBridgeAvailable", () => {
  it("capabilities.ai === true 才可用（旧宿主缺省即不支持）", () => {
    expect(aiBridgeAvailable(asApi(async () => null, { ai: true }))).toBe(true);
    expect(aiBridgeAvailable(asApi(async () => null))).toBe(false);
    expect(aiBridgeAvailable(undefined)).toBe(false);
    expect(aiBridgeAvailable(null)).toBe(false);
  });
});

describe("openAiConversation", () => {
  it("能力在位时经 request 调 host.ai.openConversation 并返回 true", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const api = asApi(async (method, params) => {
      calls.push({ method, params });
      return null;
    }, { ai: true });
    const request = { title: "t", prompt: "p", context: {} };
    await expect(openAiConversation(api, request)).resolves.toBe(true);
    expect(calls).toEqual([{ method: "host.ai.openConversation", params: request }]);
  });

  it("能力缺失直接 false，不发请求", async () => {
    await expect(openAiConversation(asApi(async () => null), {})).resolves.toBe(false);
    await expect(openAiConversation(undefined, {})).resolves.toBe(false);
  });

  it("宿主异常按原样上抛（调用方降级为可见提示）", async () => {
    const api = asApi(async () => {
      throw new Error("bridge gone");
    }, { ai: true });
    await expect(openAiConversation(api, {})).rejects.toThrow("bridge gone");
  });
});

describe("直连生成 / 推荐位封装（宿主 #10629）", () => {
  const cap = { ai: true, aiCompletion: true, aiRecommendations: true };

  it("能力位探测：aiCompletion / aiRecommendations 缺省即不支持（web 运行时）", () => {
    expect(aiCompletionAvailable(asApi(async () => null, cap))).toBe(true);
    expect(aiCompletionAvailable(asApi(async () => null, { ai: true }))).toBe(false);
    expect(aiRecommendationsAvailable(asApi(async () => null, cap))).toBe(true);
    expect(aiRecommendationsAvailable(undefined)).toBe(false);
  });

  it("listAiModels 白名单过滤 + pickDefaultAiModel 默认优先、空表 null", async () => {
    const api = asApi(async () => [
      { configId: "c2", name: "n2", model: "m2", isDefault: false, endpoint: "http://leak" },
      { configId: "c1", name: "n1", model: "m1", isDefault: true },
      "junk",
      null,
    ], cap);
    const models = await listAiModels(api);
    expect(models).toEqual([{ configId: "c2", name: "n2", model: "m2", isDefault: false }, { configId: "c1", name: "n1", model: "m1", isDefault: true }]);
    expect(pickDefaultAiModel(models)?.model).toBe("m1");
    expect(pickDefaultAiModel([{ configId: "c", name: "n", model: "m", isDefault: false }])?.model).toBe("m");
    expect(pickDefaultAiModel([])).toBeNull();
  });

  it("generateText / setRecommendations / clearRecommendations 走 request 且参数原样", async () => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const api = asApi(async (method, params) => {
      calls.push({ method, params });
      return method === "host.ai.generateText" ? "df -h\nWhy: disk full" : null;
    }, cap);
    await expect(generateAiText(api, { configId: "c", model: "m", prompt: "p" })).resolves.toBe("df -h\nWhy: disk full");
    const update = { context: { a: 1 }, items: [{ id: "x", label: "l", prompt: "p", order: 0 }] };
    await setAiRecommendations(api, update);
    await clearAiRecommendations(api);
    expect(calls.map((c) => c.method)).toEqual(["host.ai.generateText", "host.ai.setRecommendations", "host.ai.clearRecommendations"]);
    expect(calls[1]!.params).toEqual(update);
  });
});
