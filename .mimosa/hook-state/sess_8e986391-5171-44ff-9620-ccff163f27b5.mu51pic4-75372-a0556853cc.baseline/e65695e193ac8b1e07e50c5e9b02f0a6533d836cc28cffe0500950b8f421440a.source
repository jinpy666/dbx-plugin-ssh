import { describe, expect, it } from "vitest";
import { formatAuthMethodLabel, normalizeConnectionPort, normalizeConnectionText } from "./connectionInfo";

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
    const translate = (method: "password" | "private-key" | "private-key-password" | "agent" | "none") => method;
    expect(formatAuthMethodLabel("  ", translate)).toBe("–");
    expect(formatAuthMethodLabel("null", translate)).toBe("–");
    expect(formatAuthMethodLabel("password", translate)).toBe("password");
  });
});
