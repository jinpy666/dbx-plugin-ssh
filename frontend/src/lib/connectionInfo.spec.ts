import { describe, expect, it } from "vitest";
import { KNOWN_AUTH_METHODS, formatAuthMethodLabel, normalizeConnectionPort, normalizeConnectionText } from "./connectionInfo";

describe("connection display normalization", () => {
  it("treats null-like and whitespace values as missing", () => {
    expect(normalizeConnectionText(null)).toBe("");
    expect(normalizeConnectionText(undefined)).toBe("");
    expect(normalizeConnectionText("  ")).toBe("");
    expect(normalizeConnectionText(" null ")).toBe("");
    expect(normalizeConnectionText("undefined")).toBe("");
    expect(normalizeConnectionText("  server.example.com  ")).toBe("server.example.com");
  });

  it("accepts only valid SSH ports", () => {
    expect(normalizeConnectionPort(null)).toBeUndefined();
    expect(normalizeConnectionPort("  ")).toBeUndefined();
    expect(normalizeConnectionPort("null")).toBeUndefined();
    expect(normalizeConnectionPort("2222")).toBe(2222);
    expect(normalizeConnectionPort(22)).toBe(22);
    expect(normalizeConnectionPort(0)).toBeUndefined();
    expect(normalizeConnectionPort(65_536)).toBeUndefined();
  });

  it("does not render a serialized null auth method", () => {
    const translate = (method: "password" | "private-key" | "private-key-password" | "agent" | "auto" | "none") => method;
    expect(formatAuthMethodLabel("  ", translate)).toBe("–");
    expect(formatAuthMethodLabel("null", translate)).toBe("–");
    expect(formatAuthMethodLabel("password", translate)).toBe("password");
  });

  it("localizes the Auto ordered-fallback method and keeps unknown names raw", () => {
    // M13-A：auto 是已知方法名（走 i18n），随意的名字原样展示。
    const labels: Record<string, string> = { auto: "自动（按序尝试）" };
    const translate = (method: (typeof KNOWN_AUTH_METHODS)[number]) => labels[method] ?? method;
    expect(formatAuthMethodLabel("auto", translate)).toBe("自动（按序尝试）");
    expect(formatAuthMethodLabel("agent", translate)).toBe("agent");
    expect(formatAuthMethodLabel("sneaky-method", translate)).toBe("sneaky-method");
  });

  it("lists Auto among the known auth methods", () => {
    // 表单下拉/展示层的已知方法集合：auto 位于 agent 与 none 之间，
    // 与 manifest authentication select 的选项顺序一致。
    expect(KNOWN_AUTH_METHODS).toEqual([
      "password",
      "private-key",
      "private-key-password",
      "agent",
      "auto",
      "none",
    ]);
  });
});
