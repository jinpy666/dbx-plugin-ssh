import { describe, expect, it } from "vitest";
import { readPluginMode, readPluginShell, resolveWorkbenchId } from "./pluginContext";

// Read helpers for the PR-A4 context.plugin namespace. The cases lock two things: type-safe reads of the A4 target shape
// type-safe reads (including the hard-switch rejection of the legacy { localTerminal: true } passthrough shape) and
// workbenchId from legacy hosts (Host API 1.0 does not inject it) falls back for compatibility
// (impl-plan R-legacy-host-compat: the fallback must be kept and covered by a test).
describe("pluginContext (PR-A4 context.plugin namespace)", () => {
  it("readPluginMode reads context.plugin.mode from the A4 shape", () => {
    expect(readPluginMode({ plugin: { mode: "local-terminal" } })).toBe("local-terminal");
    // Reserved extension slot (later mode names such as the P2 panel surface pass through verbatim for the caller to compare).
    expect(readPluginMode({ plugin: { mode: "panel" } })).toBe("panel");
    expect(readPluginMode({ plugin: { mode: "local-terminal", extra: 1 } })).toBe("local-terminal");
  });

  it("readPluginMode rejects the legacy top-level shape and malformed payloads (hard switch)", () => {
    // The legacy { localTerminal: true } passthrough shape no longer triggers local-terminal mode.
    expect(readPluginMode({ localTerminal: true })).toBe("");
    expect(readPluginMode({ localTerminal: true, plugin: { mode: "local-terminal" } })).toBe("local-terminal");
    // the payload must be a plain object and mode must be a string.
    expect(readPluginMode({ plugin: null })).toBe("");
    expect(readPluginMode({ plugin: "local-terminal" })).toBe("");
    expect(readPluginMode({ plugin: [{ mode: "local-terminal" }] })).toBe("");
    expect(readPluginMode({ plugin: {} })).toBe("");
    expect(readPluginMode({ plugin: { mode: 42 } })).toBe("");
    expect(readPluginMode({})).toBe("");
    expect(readPluginMode(undefined)).toBe("");
    expect(readPluginMode(null)).toBe("");
  });

  it("readPluginShell reads the dock-selected shell type from the payload", () => {
    expect(readPluginShell({ plugin: { mode: "local-terminal", shell: "/bin/fish" } })).toBe("/bin/fish");
    expect(readPluginShell({ plugin: { mode: "local-terminal" } })).toBe("");
    expect(readPluginShell({ plugin: { mode: "local-terminal", shell: "   " } })).toBe("");
    expect(readPluginShell({ plugin: { shell: 42 } })).toBe("");
    expect(readPluginShell(undefined)).toBe("");
  });

  it("resolveWorkbenchId prefers the host-injected id", () => {
    expect(resolveWorkbenchId({ workbenchId: "host-workbench-1" }, "fallback")).toBe("host-workbench-1");
    expect(resolveWorkbenchId({ workbenchId: "host-workbench-1", restored: true }, "fallback")).toBe("host-workbench-1");
  });

  it("resolveWorkbenchId falls back on legacy hosts that do not inject the id", () => {
    expect(resolveWorkbenchId({}, "fallback")).toBe("fallback");
    expect(resolveWorkbenchId(undefined, "fallback")).toBe("fallback");
    expect(resolveWorkbenchId(null, "fallback")).toBe("fallback");
    // Blank and serialized null-ish values count as missing (same semantics as normalizeConnectionText).
    expect(resolveWorkbenchId({ workbenchId: "   " }, "fallback")).toBe("fallback");
    expect(resolveWorkbenchId({ workbenchId: "null" }, "fallback")).toBe("fallback");
    expect(resolveWorkbenchId({ workbenchId: 42 }, "fallback")).toBe("fallback");
  });
});
