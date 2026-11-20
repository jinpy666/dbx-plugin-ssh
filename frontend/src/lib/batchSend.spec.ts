import { describe, expect, it } from "vitest";
import {
  applyConnectionNames,
  batchTargetLabel,
  deriveBatchCommandName,
  filterLiveBatchTargets,
  normalizeBatchTargets,
  normalizeBatchCommandLines,
  normalizeLocalBatchTargets,
  quickPickCommandById,
  selectBatchTargets,
  shouldAutoDismissBatchSummary,
  summarizeBatchResults,
  toggleBatchTarget,
  type BatchSendTarget,
} from "./batchSend";

const row = (overrides: Partial<BatchSendTarget>): BatchSendTarget => ({
  sessionId: "s-1",
  connectionId: "conn-1",
  connected: true,
  host: "prod-01",
  port: 22,
  username: "ops",
  createdAt: 100,
  ...overrides,
});

describe("normalizeBatchTargets", () => {
  it("keeps list order and drops invalid or duplicate rows", () => {
    const targets = normalizeBatchTargets([
      row({ sessionId: "s-1" }),
      null,
      row({ sessionId: "s-1" }),
      { sessionId: "", connectionId: "conn-2" },
      row({ sessionId: "s-2", connected: false }),
      "junk",
    ]);
    expect(targets.map((target) => target.sessionId)).toEqual(["s-1", "s-2"]);
    expect(targets[0].host).toBe("prod-01");
    expect(targets[0].username).toBe("ops");
    expect(targets[1].connected).toBe(false);
  });

  it("returns empty on malformed payloads", () => {
    expect(normalizeBatchTargets(undefined)).toEqual([]);
    expect(normalizeBatchTargets({ sessions: [] })).toEqual([]);
  });
});

describe("filterLiveBatchTargets", () => {
  it("drops rows the backend lists as dead and keeps live and unliveness-tagged rows", () => {
    // issue #217：关闭竞态滞留的 connected:false 死行不得进目标列表/计数。
    const targets = [
      row({ sessionId: "live-1", connected: true }),
      row({ sessionId: "dead-1", connected: false }),
      row({ sessionId: "dead-2", connected: false }),
      // 旧 sidecar / 本地终端目标缺 liveness 字段：无从判定，保留。
      row({ sessionId: "legacy", connected: undefined }),
      { sessionId: "local-1", connectionId: "", local: true, host: "Local · zsh" },
    ];
    expect(filterLiveBatchTargets(targets).map((target) => target.sessionId)).toEqual([
      "live-1",
      "legacy",
      "local-1",
    ]);
  });

  it("does not mutate the input and tolerates empty lists", () => {
    const targets = [row({ sessionId: "dead", connected: false })];
    expect(filterLiveBatchTargets(targets)).toEqual([]);
    expect(targets).toHaveLength(1);
    expect(filterLiveBatchTargets([])).toEqual([]);
  });
});

describe("batchTargetLabel", () => {
  it("prefers user@host and falls back to short session id", () => {
    expect(batchTargetLabel(row({}))).toBe("ops@prod-01");
    expect(batchTargetLabel(row({ username: "" }))).toBe("prod-01");
    expect(batchTargetLabel(row({ host: "", sessionId: "abcdef123456" }))).toBe("abcdef12");
  });

  it("prefers the connection name after a terminal rename (issue #10232)", () => {
    expect(batchTargetLabel(row({ name: "app-server" }))).toBe("app-server");
    // 空白名称视为未命名，回退 user@host。
    expect(batchTargetLabel(row({ name: "   " }))).toBe("ops@prod-01");
    expect(batchTargetLabel(row({ name: "app-server", host: "" }))).toBe("app-server");
  });
});

describe("applyConnectionNames", () => {
  it("overlays host connection names onto matching targets only", () => {
    const targets = [row({ sessionId: "s-1" }), row({ sessionId: "s-2", connectionId: "conn-2" })];
    const named = applyConnectionNames(targets, { connections: [{ id: "conn-2", name: "app-server" }] });
    expect(named[0]).toEqual(targets[0]);
    expect(named[1]).toEqual({ ...targets[1], name: "app-server" });
  });

  it("accepts the plain-array bridge shape and drops junk or unnamed rows", () => {
    const targets = [row({})];
    expect(
      applyConnectionNames(targets, [{ id: "conn-1", name: "  ops-prod  " }, { id: "conn-1" }, "junk", null]),
    ).toEqual([{ ...targets[0], name: "ops-prod" }]);
  });

  it("prefers workbench titles (#193b: renamed dock terminal) over the connection name", () => {
    const targets = [
      row({ sessionId: "s-1" }),
      row({ sessionId: "s-2", connectionId: "conn-2" }),
      row({ sessionId: "s-3", connectionId: "conn-3" }),
    ];
    const named = applyConnectionNames(targets, [
      // Dock-first aggregation from the host: renamed terminal wins.
      { id: "conn-1", name: "ops-prod", workbenchTitles: ["prod-db", "ops-prod"] },
      // Junk/non-string titles fall back to the connection name.
      { id: "conn-2", name: "app-server", workbenchTitles: [42, null, "   "] },
      // Missing field keeps the plain-name behavior.
      { id: "conn-3", name: "backup" },
    ]);
    expect(named[0]).toEqual({ ...targets[0], name: "prod-db" });
    expect(named[1]).toEqual({ ...targets[1], name: "app-server" });
    expect(named[2]).toEqual({ ...targets[2], name: "backup" });
  });

  it("leaves targets untouched when no usable names exist", () => {
    const targets = [row({}), row({ sessionId: "s-2", connectionId: "", local: true, host: "Local · zsh" })];
    expect(applyConnectionNames(targets, [{ id: "conn-x", name: "   " }])).toEqual(targets);
    expect(applyConnectionNames(targets, { connections: "nope" })).toEqual(targets);
    expect(applyConnectionNames(targets, undefined)).toEqual(targets);
  });
});

describe("toggleBatchTarget / selectBatchTargets", () => {
  it("toggles membership without duplicates", () => {
    let selected = toggleBatchTarget(["s-1"], "s-2");
    expect(selected).toEqual(["s-1", "s-2"]);
    selected = toggleBatchTarget(selected, "s-1");
    expect(selected).toEqual(["s-2"]);
  });

  it("selects all or only live sessions", () => {
    const targets = normalizeBatchTargets([
      row({ sessionId: "s-1" }),
      row({ sessionId: "s-2", connected: false }),
      row({ sessionId: "s-3" }),
    ]);
    expect(selectBatchTargets(targets, "all")).toEqual(["s-1", "s-2", "s-3"]);
    expect(selectBatchTargets(targets, "connected")).toEqual(["s-1", "s-3"]);
  });
});

describe("summarizeBatchResults", () => {
  it("counts sent and failed rows from the backend response", () => {
    const summary = summarizeBatchResults([
      { sessionId: "s-1", success: true },
      { sessionId: "s-2", success: false, error: "SSH session was not found" },
      { sessionId: "", success: true },
      "junk",
    ]);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.rows).toEqual([
      { sessionId: "s-1", success: true, error: undefined },
      { sessionId: "s-2", success: false, error: "SSH session was not found" },
    ]);
  });

  it("treats malformed payloads as zero counts", () => {
    expect(summarizeBatchResults(undefined)).toEqual({ rows: [], sent: 0, failed: 0 });
    expect(summarizeBatchResults("nope" as unknown as unknown[]).failed).toBe(0);
  });
});

describe("shouldAutoDismissBatchSummary", () => {
  it("auto-dismisses full success but keeps partial failures for triage", () => {
    // 全部成功：短暂提示后自动收起（用户报障「已发送到 N 个会话不会自动关闭」）。
    expect(shouldAutoDismissBatchSummary({ rows: [{ sessionId: "s-1", success: true }], sent: 1, failed: 0 })).toBe(true);
    // 部分失败：逐行错误需要时间排查，常驻直到手动关闭。
    expect(shouldAutoDismissBatchSummary({ rows: [{ sessionId: "s-1", success: true }, { sessionId: "s-2", success: false, error: "x" }], sent: 1, failed: 1 })).toBe(false);
    // 空汇总（正常路径不会出现）：不触发自动收起。
    expect(shouldAutoDismissBatchSummary({ rows: [], sent: 0, failed: 0 })).toBe(false);
  });
});

describe("deriveBatchCommandName", () => {
  it("flattens whitespace and keeps short commands intact", () => {
    expect(deriveBatchCommandName("  systemctl   status\nnginx  ")).toBe("systemctl status nginx");
  });

  it("truncates long commands with an ellipsis", () => {
    const name = deriveBatchCommandName("a".repeat(40));
    expect(name.length).toBe(30);
    expect(name.endsWith("…")).toBe(true);
  });

  it("returns empty for blank commands", () => {
    expect(deriveBatchCommandName("   ")).toBe("");
  });

  it("truncates by code point so surrogate pairs stay intact", () => {
    // 32 个 emoji（64 个 UTF-16 code unit）：按 code unit 截断会把代理对劈成
    // 乱码；按 code point 截断后省略号前最后一个字符仍是完整 emoji。
    const name = deriveBatchCommandName("🚀".repeat(32));
    expect(Array.from(name.slice(0, -1)).length).toBe(29);
    expect(name.endsWith("…")).toBe(true);
  });
});

describe("quickPickCommandById", () => {
  const commands = [
    { id: "c1", name: "df", command: "df -h" },
    { id: "c2", name: "uptime", command: "uptime" },
  ];

  it("returns the command text for a known id", () => {
    expect(quickPickCommandById(commands, "c2")).toBe("uptime");
  });

  it("returns empty for unknown or empty ids", () => {
    expect(quickPickCommandById(commands, "missing")).toBe("");
    expect(quickPickCommandById(commands, "")).toBe("");
  });
});

describe("normalizeLocalBatchTargets", () => {
  it("maps local sessions to local batch targets labeled by shell", () => {
    expect(
      normalizeLocalBatchTargets([
        { sessionId: "l1", workbenchId: "wb1", shell: "/bin/zsh" },
        { sessionId: "l2", shell: "C:\\PowerShell\\pwsh.exe" },
      ]),
    ).toEqual([
      { sessionId: "l1", connectionId: "", local: true, host: "Local · zsh" },
      { sessionId: "l2", connectionId: "", local: true, host: "Local · pwsh.exe" },
    ]);
  });

  it("drops invalid rows, dedups ids and tolerates a missing shell", () => {
    expect(
      normalizeLocalBatchTargets([
        { sessionId: "", shell: "/bin/bash" },
        { sessionId: "l1", shell: "" },
        { sessionId: "l1", shell: "/bin/bash" },
        "nope",
      ]),
    ).toEqual([{ sessionId: "l1", connectionId: "", local: true, host: "Local · shell" }]);
    expect(normalizeLocalBatchTargets("nope")).toEqual([]);
  });
});

describe("normalizeBatchCommandLines", () => {
  it("turns every line break into a PTY carriage return (sidecar batch_input_payload 语义)", () => {
    expect(normalizeBatchCommandLines("ls\ncd /usr\nls")).toBe("ls\rcd /usr\rls");
    expect(normalizeBatchCommandLines("a\r\nb\rc\nd")).toBe("a\rb\rc\rd");
  });
  it("leaves single-line commands untouched", () => {
    expect(normalizeBatchCommandLines("df -h")).toBe("df -h");
    expect(normalizeBatchCommandLines("")).toBe("");
  });
});
