// AI 桥薄封装单测（Warp AI 对齐批）：能力探测与 host.ai.openConversation 调用。
import { describe, expect, it } from "vitest";
import { aiBridgeAvailable, openAiConversation, type DbxPluginApiLike } from "./aiBridge";

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
