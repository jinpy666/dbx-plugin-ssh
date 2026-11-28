// sftpRelay 单测（issue #334 阶段 1）：目标候选过滤与批次规划的纯决策。
import { describe, expect, it } from "vitest";
import { buildRelayQueue, relayTargetOptions } from "./sftpRelay";
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

describe("buildRelayQueue", () => {
  it("passes plain files through (with extra fields) and counts the rest as skipped", () => {
    const entries = [
      { name: "app.log", kind: "file", uri: "sftp:///var/log/app.log" },
      { name: "backup", kind: "directory", uri: "sftp:///var/backup" },
      { name: "link", kind: "symlink", uri: "sftp:///var/link" },
      { name: "report.pdf", kind: "file", uri: "sftp:///var/report.pdf" },
    ];
    expect(buildRelayQueue(entries)).toEqual({
      files: [
        { name: "app.log", kind: "file", uri: "sftp:///var/log/app.log" },
        { name: "report.pdf", kind: "file", uri: "sftp:///var/report.pdf" },
      ],
      skipped: 2,
    });
  });

  it("yields an empty plan for a selection without files", () => {
    expect(buildRelayQueue([{ name: "data", kind: "directory" }])).toEqual({ files: [], skipped: 1 });
    expect(buildRelayQueue([])).toEqual({ files: [], skipped: 0 });
  });
});
