import { describe, expect, it } from "vitest";
import { auditKindLabel, auditKindOptions, auditOutcomeLabel, sanitizeAuditEntries, AUDIT_KIND_TO_I18N } from "./auditLog";

const translate = (key: string) => ({ "auditLog.kind.mcpTool": "MCP tool", "auditLog.kind.exec": "Exec", "auditLog.outcomeOk": "ok", "auditLog.outcomeError": "error" })[key] || key;

describe("audit log kinds", () => {
  it("maps known kinds to i18n and shows unknown kinds verbatim", () => {
    expect(auditKindLabel("exec", translate)).toBe("Exec");
    expect(auditKindLabel("mcp.tool", translate)).toBe("MCP tool");
    expect(auditKindLabel("future.kind", translate)).toBe("future.kind");
    expect(auditKindLabel("", translate)).toBe("");
  });

  it("builds filter options from the entries themselves, deduped and sorted", () => {
    const entries = sanitizeAuditEntries([
      { tsMs: 1_757_500_100_000, tool: "ssh_exec" },
      { ts: 1_757_500_000, kind: "exec" },
      { tsMs: 1_757_500_200_000, tool: "ssh_exec" },
      { ts: 1_757_499_000, kind: "agent.challenge" },
    ]);
    expect(auditKindOptions(entries)).toEqual(["agent.challenge", "exec", "ssh_exec"]);
    expect(auditKindOptions([])).toEqual([]);
    expect(Object.keys(AUDIT_KIND_TO_I18N)).toContain("exec");
  });
});

describe("audit entry sanitization", () => {
  it("keeps well-formed entries and tightens field types", () => {
    const entries = sanitizeAuditEntries([
      {
        ts: 1_757_500_000,
        kind: "exec",
        command: "systemctl restart nginx",
        sessionId: "s1",
        outcome: "ok",
        exitCode: 0,
        sudo: false,
      },
      { ts: 1_757_500_100, kind: "agent.challenge", decision: "denied", command: "rm -rf /" },
    ]);
    // newest-first 客户端排序。
    expect(entries).toEqual([
      { ts: 1_757_500_100, kind: "agent.challenge", decision: "denied", command: "rm -rf /" },
      { ts: 1_757_500_000, kind: "exec", command: "systemctl restart nginx", sessionId: "s1", outcome: "ok", exitCode: 0 },
    ]);
    // sudo:false 不出现在视图（缺省语义）。
    expect(entries[1].sudo).toBeUndefined();
  });

  it("tolerates the parallel-batch MCP exec audit shape (tsMs/tool/connectionId)", () => {
    const entries = sanitizeAuditEntries([
      {
        tsMs: 1_757_500_000_500,
        tool: "ssh_exec",
        connectionId: "conn-1",
        gate: "pass",
        approval: "approved",
        outcome: "ok",
        exitCode: 0,
        durationMs: 1234,
        mode: "terminal",
      },
    ]);
    expect(entries).toEqual([
      {
        ts: 1_757_500_000,
        kind: "ssh_exec",
        tool: "ssh_exec",
        connection: "conn-1",
        gate: "pass",
        approval: "approved",
        outcome: "ok",
        exitCode: 0,
        durationMs: 1234,
        mode: "terminal",
      },
    ]);
  });

  it("drops malformed entries and honors the newest limit", () => {
    const raw = [
      { kind: "exec" }, // 缺 ts/tsMs
      { ts: "soon", kind: "exec" }, // ts 非数字
      { ts: 1 }, // 缺 kind 与 tool
      "not an object",
      null,
      { tsMs: 1_757_499_996_000, tool: "ssh_exec" }, // 最旧
      { tsMs: 1_757_499_997_000, tool: "ssh_exec" },
      { tsMs: 1_757_499_998_000, tool: "ssh_exec" },
      { ts: 1_757_500_200, kind: "mcp.gate", gate: "readonly" },
      { ts: 1_757_500_300, kind: "mcp.tool", exitCode: "zero" }, // exitCode 非数字被丢
    ];
    const entries = sanitizeAuditEntries(raw);
    expect(entries).toHaveLength(5);
    // newest-first：排序后取前 limit 条，最旧的被挤出。
    expect(sanitizeAuditEntries(raw, 3).map((entry) => entry.ts)).toEqual([1_757_500_300, 1_757_500_200, 1_757_499_998]);
    expect(entries[entries.length - 1].ts).toBe(1_757_499_996);
    expect(sanitizeAuditEntries("junk")).toEqual([]);
    expect(entries.find((entry) => entry.kind === "mcp.tool")?.exitCode).toBeUndefined();
  });

  it("keeps boolean flags only when explicitly true", () => {
    const entries = sanitizeAuditEntries([
      { ts: 1, kind: "terminal.auto_sudo", kind2: "otp", deferred: true, sudo: true },
      { ts: 2, kind: "terminal.auto_sudo", sudo: false, deferred: false },
    ]);
    expect(entries[0]).toEqual({ ts: 2, kind: "terminal.auto_sudo" });
    expect(entries[1]).toEqual({ ts: 1, kind: "terminal.auto_sudo", kind2: "otp", deferred: true, sudo: true });
  });
});

describe("audit outcome label", () => {
  it("prefers outcome, then decision, then the auto-sudo answer type", () => {
    expect(auditOutcomeLabel({ ts: 1, kind: "exec", outcome: "ok" }, translate)).toBe("ok");
    expect(auditOutcomeLabel({ ts: 1, kind: "exec", outcome: "error" }, translate)).toBe("error");
    expect(auditOutcomeLabel({ ts: 1, kind: "agent.challenge", decision: "timeout" }, translate)).toBe("timeout");
    expect(auditOutcomeLabel({ ts: 1, kind: "terminal.auto_sudo", kind2: "otp" }, translate)).toBe("otp");
    expect(auditOutcomeLabel({ ts: 1, kind: "mcp.gate", gate: "scope" }, translate)).toBe("");
  });
});
