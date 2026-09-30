import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import { deleteTunnelProfile, loadTunnelProfiles, saveTunnelProfile } from "./tunnelProfiles";

afterEach(() => pluginStore.removeItem("ssh-tunnel-profiles"));

describe("saved tunnel profiles", () => {
  it("persists valid mappings by connection and avoids duplicate presets", () => {
    const draft = { kind: "dynamic" as const, listenHost: "127.0.0.1", listenPort: "1080", targetHost: "", targetPort: "" };
    const saved = saveTunnelProfile("connection-a", draft);
    expect(saveTunnelProfile("connection-a", draft).id).toBe(saved.id);
    expect(loadTunnelProfiles("connection-b")).toEqual([]);
    expect(loadTunnelProfiles("connection-a")).toEqual([saved]);
    deleteTunnelProfile(saved.id);
    expect(loadTunnelProfiles("connection-a")).toEqual([]);
  });

  it("drops malformed entries and rejects invalid targets", () => {
    pluginStore.setItem("ssh-tunnel-profiles", JSON.stringify([{ id: "bad", connectionId: "a", kind: "local", listenHost: "127.0.0.1", listenPort: "8080", targetHost: "", targetPort: "80" }]));
    expect(loadTunnelProfiles("a")).toEqual([]);
    expect(() => saveTunnelProfile("a", { kind: "local", listenHost: "127.0.0.1", listenPort: "8080", targetHost: "", targetPort: "80" })).toThrow();
  });
});
