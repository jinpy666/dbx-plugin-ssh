import { describe, expect, it } from "vitest";
import {
  addBatchUploadFiles,
  batchUploadTotalBytes,
  joinUploadPath,
  removeBatchUploadFile,
  resolveUploadDir,
  selectableUploadTargets,
  shouldAutoDismissBatchUpload,
  summarizeBatchUploadRows,
  type BatchUploadFile,
  type BatchUploadRow,
} from "./batchUpload";

function entry(id: string, name: string, size = 10): BatchUploadFile {
  return { id, name, size, file: { name, size } as unknown as File };
}

describe("resolveUploadDir", () => {
  it("falls back to the remote home when the input is empty or a bare tilde", () => {
    expect(resolveUploadDir("", "/home/ops")).toBe("/home/ops");
    expect(resolveUploadDir("   ", "/home/ops")).toBe("/home/ops");
    expect(resolveUploadDir("~", "/home/ops")).toBe("/home/ops");
  });

  it("expands ~/sub against the home directory", () => {
    expect(resolveUploadDir("~/deploy", "/home/ops")).toBe("/home/ops/deploy");
    expect(resolveUploadDir("~/deploy", "/")).toBe("/deploy");
  });

  it("treats a relative path as rooted (sidecar only accepts absolute paths)", () => {
    expect(resolveUploadDir("tmp", "/home/ops")).toBe("/tmp");
    expect(resolveUploadDir("opt/app/bin", "/home/ops")).toBe("/opt/app/bin");
  });

  it("normalizes duplicate and trailing slashes but keeps the root", () => {
    expect(resolveUploadDir("//var//log//", "/home/ops")).toBe("/var/log");
    expect(resolveUploadDir("/", "/home/ops")).toBe("/");
  });
});

describe("joinUploadPath", () => {
  it("joins without doubling or dropping the separator", () => {
    expect(joinUploadPath("/tmp", "a.bin")).toBe("/tmp/a.bin");
    expect(joinUploadPath("/tmp/", "a.bin")).toBe("/tmp/a.bin");
    expect(joinUploadPath("/", "a.bin")).toBe("/a.bin");
    expect(joinUploadPath("/tmp", "/a.bin")).toBe("/tmp/a.bin");
  });
});

describe("addBatchUploadFiles", () => {
  it("appends new files and skips same name + size duplicates", () => {
    const first = addBatchUploadFiles([], [entry("1", "a.bin"), entry("2", "b.bin", 20)]);
    expect(first.map((item) => item.id)).toEqual(["1", "2"]);
    const merged = addBatchUploadFiles(first, [entry("3", "a.bin"), entry("4", "c.bin")]);
    expect(merged.map((item) => item.name)).toEqual(["a.bin", "b.bin", "c.bin"]);
  });

  it("keeps same-name files that differ in size (genuinely different files)", () => {
    const merged = addBatchUploadFiles([entry("1", "a.bin", 10)], [entry("2", "a.bin", 11)]);
    expect(merged).toHaveLength(2);
  });
});

describe("removeBatchUploadFile / batchUploadTotalBytes", () => {
  it("removes by id and sums sizes", () => {
    const files = [entry("1", "a", 5), entry("2", "b", 7)];
    expect(removeBatchUploadFile(files, "1").map((item) => item.id)).toEqual(["2"]);
    expect(batchUploadTotalBytes(files)).toBe(12);
    expect(batchUploadTotalBytes([])).toBe(0);
  });
});

describe("selectableUploadTargets", () => {
  const targets = [
    { sessionId: "a", connected: true },
    { sessionId: "b", connected: false },
    { sessionId: "c", connected: true, readOnly: true },
    { sessionId: "d", connected: true, local: true },
    { sessionId: "e", connected: true },
  ];

  it("keeps only selected, live, writable, remote sessions", () => {
    const picked = selectableUploadTargets(targets, ["a", "b", "c", "d", "e"]);
    expect(picked.map((item) => item.sessionId)).toEqual(["a", "e"]);
  });

  it("respects the selection even when a target is otherwise usable", () => {
    expect(selectableUploadTargets(targets, ["e"]).map((item) => item.sessionId)).toEqual(["e"]);
    expect(selectableUploadTargets(targets, [])).toEqual([]);
  });
});

describe("summarizeBatchUploadRows", () => {
  const rows: BatchUploadRow[] = [
    { sessionId: "a", fileName: "x.bin", status: "uploaded", remotePath: "/tmp/x.bin" },
    { sessionId: "a", fileName: "y.bin", status: "skipped" },
    { sessionId: "b", fileName: "x.bin", status: "failed", error: "permission denied" },
  ];

  it("counts the three outcome states", () => {
    expect(summarizeBatchUploadRows(rows)).toMatchObject({ uploaded: 1, skipped: 1, failed: 1 });
  });

  it("drops rows without a session or file name", () => {
    const summary = summarizeBatchUploadRows([...rows, { sessionId: "", fileName: "z", status: "failed" }]);
    expect(summary.rows).toHaveLength(3);
    expect(summary.failed).toBe(1);
  });
});

describe("shouldAutoDismissBatchUpload", () => {
  it("auto-dismisses only when everything uploaded", () => {
    expect(shouldAutoDismissBatchUpload({ rows: [], uploaded: 2, skipped: 0, failed: 0 })).toBe(true);
    expect(shouldAutoDismissBatchUpload({ rows: [], uploaded: 2, skipped: 1, failed: 0 })).toBe(false);
    expect(shouldAutoDismissBatchUpload({ rows: [], uploaded: 0, skipped: 0, failed: 0 })).toBe(false);
  });
});
