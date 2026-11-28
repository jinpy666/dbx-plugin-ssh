// sftpRelay 单测（issue #334 阶段 1）：目标候选过滤与批次规划的纯决策。
import { describe, expect, it } from "vitest";
import { orderRelayTree, relayTargetDirPrefixes, relayTargetOptions, triageRelaySelection } from "./sftpRelay";
import type { BatchSendTarget } from "./batchSend";

function target(overrides: Partial<BatchSendTarget> & { sessionId: string }): BatchSendTarget {
  return { connectionId: `conn-${overrides.sessionId}`, connected: true, host: "host", username: "root", ...overrides };
}

describe("relayTargetOptions", () => {
  it("keeps live SSH sessions other than the current one", () => {
    const options = relayTargetOptions(
      [target({ sessionId: "a" }), target({ sessionId: "b", host: "other", name: "生产库" })],
      "a",
    );
    expect(options).toEqual([{ sessionId: "b", label: "生产库" }]);
  });

  it("excludes the current session, local terminals, dead and read-only rows", () => {
    const options = relayTargetOptions(
      [
        target({ sessionId: "current" }),
        target({ sessionId: "local", local: true }),
        target({ sessionId: "dead", connected: false }),
        target({ sessionId: "ro", readOnly: true }),
        target({ sessionId: "ok" }),
      ],
      "current",
    );
    expect(options.map((option) => option.sessionId)).toEqual(["ok"]);
  });
});

describe("triageRelaySelection", () => {
  it("routes files to the direct queue, directories to the walker, rest to skipped", () => {
    const entries = [
      { name: "app.log", kind: "file", uri: "sftp:///var/log/app.log" },
      { name: "backup", kind: "directory", uri: "sftp:///var/backup" },
      { name: "link", kind: "symlink", uri: "sftp:///var/link" },
      { name: "report.pdf", kind: "file", uri: "sftp:///var/report.pdf" },
    ];
    expect(triageRelaySelection(entries)).toEqual({
      files: [
        { name: "app.log", kind: "file", uri: "sftp:///var/log/app.log" },
        { name: "report.pdf", kind: "file", uri: "sftp:///var/report.pdf" },
      ],
      dirs: [{ name: "backup", kind: "directory", uri: "sftp:///var/backup" }],
      skipped: 1,
    });
  });

  it("yields empty routes for a selection without files or directories", () => {
    expect(triageRelaySelection([{ name: "link", kind: "symlink" }])).toEqual({ files: [], dirs: [], skipped: 1 });
    expect(triageRelaySelection([])).toEqual({ files: [], dirs: [], skipped: 0 });
  });
});

describe("orderRelayTree", () => {
  it("orders directories parent-before-child with dedupe and stable file passthrough", () => {
    const order = orderRelayTree(
      ["backup/sub/deep", "backup", "backup/sub", "backup"],
      [
        { relDir: "backup/sub", name: "b.log", uri: "sftp:///src/b.log" },
        { relDir: "", name: "top.log", uri: "sftp:///src/top.log" },
      ],
    );
    expect(order.dirs).toEqual(["backup", "backup/sub", "backup/sub/deep"]);
    expect(order.files).toEqual([
      { relDir: "backup/sub", name: "b.log", uri: "sftp:///src/b.log" },
      { relDir: "", name: "top.log", uri: "sftp:///src/top.log" },
    ]);
  });

  it("sorts same-depth directories lexicographically", () => {
    expect(orderRelayTree(["b", "a", "a/c", "b/d"], []).dirs).toEqual(["a", "b", "a/c", "b/d"]);
  });
});

describe("relayTargetDirPrefixes", () => {
  it("splits a multi-level path into per-level prefixes (mkdir -p equivalent)", () => {
    expect(relayTargetDirPrefixes("/tmp/dest/backup")).toEqual(["/tmp", "/tmp/dest", "/tmp/dest/backup"]);
  });

  it("returns empty for root and blank input", () => {
    expect(relayTargetDirPrefixes("/")).toEqual([]);
    expect(relayTargetDirPrefixes("")).toEqual([]);
    expect(relayTargetDirPrefixes("   ")).toEqual([]);
  });

  it("normalizes duplicate slashes", () => {
    expect(relayTargetDirPrefixes("/tmp//dest")).toEqual(["/tmp", "/tmp/dest"]);
  });
});
