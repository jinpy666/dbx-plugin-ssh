import { describe, expect, it } from "vitest";
import appSource from "./App.vue?raw";
// 事件分派收口在 composables/usePluginEvents 后，挑战路由断言扫描两个源。
import eventsSource from "./composables/usePluginEvents.ts?raw";

describe("SSH host-key challenge protocol", () => {
  it("routes plugin challenges through the sidecar resolver payload", () => {
    expect(eventsSource).toContain('event.method === "ssh/host-key/prompt" || event.method === "connection/challenge"');
    expect(appSource).toMatch(/window\.dbxPlugin\.invoke\("connection\/challenge\/resolve",\s*\{[\s\S]*?challengeId:\s*prompt\.challengeId,[\s\S]*?operationId:\s*prompt\.operationId,[\s\S]*?accept,[\s\S]*?remember:\s*accept && rememberHostKey\.value/);
  });

  it("does not resolve plugin challenges through the host SSH prompt endpoint", () => {
    expect(appSource).not.toContain("/api/ssh/prompts/resolve");
  });
});
