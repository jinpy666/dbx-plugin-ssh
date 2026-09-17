import { describe, expect, it } from "vitest";
import appSource from "./App.vue?raw";

describe("SSH host-key challenge protocol", () => {
  it("routes plugin challenges through the sidecar resolver payload", () => {
    expect(appSource).toContain('event.method === "ssh/host-key/prompt" || event.method === "connection/challenge"');
    expect(appSource).toMatch(/window\.dbxPlugin\.invoke\("connection\/challenge\/resolve",\s*\{[\s\S]*?challengeId:\s*prompt\.challengeId,[\s\S]*?operationId:\s*prompt\.operationId,[\s\S]*?accept,[\s\S]*?remember:\s*accept && rememberHostKey\.value/);
  });

  it("does not resolve plugin challenges through the host SSH prompt endpoint", () => {
    expect(appSource).not.toContain("/api/ssh/prompts/resolve");
  });
});
