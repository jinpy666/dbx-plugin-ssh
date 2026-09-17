// sanitizeSftpEntries 单测（UI_SCAN R3-P2-3）：sftp/list 坏响应防御——
// null/非数组整体收敛为空数组、null 行与无名/无 uri 行丢弃、缺 kind 降级
// 为 file（渲染占位而非整表丢弃/比较器抛错）。
import { describe, expect, it } from "vitest";
import { sanitizeSftpEntries } from "./sftpEntries";

describe("sanitizeSftpEntries", () => {
  it("returns an empty array for null / non-array payloads", () => {
    expect(sanitizeSftpEntries(null)).toEqual([]);
    expect(sanitizeSftpEntries(undefined)).toEqual([]);
    expect(sanitizeSftpEntries({ entries: null })).toEqual([]);
    expect(sanitizeSftpEntries("entries")).toEqual([]);
  });

  it("drops null and non-object rows instead of crashing the sorter", () => {
    const rows = [null, 42, "x", [], { name: "a", uri: "sftp:/a", kind: "file" }];
    expect(sanitizeSftpEntries(rows)).toEqual([
      expect.objectContaining({ name: "a", kind: "file" }),
    ]);
  });

  it("drops rows without a name or uri", () => {
    const rows = [
      { uri: "sftp:/a", kind: "file" },
      { name: "b", kind: "file" },
      { name: "c", uri: "sftp:/c", kind: "directory" },
    ];
    expect(sanitizeSftpEntries(rows).map((row) => row.name)).toEqual(["c"]);
  });

  it("downgrades a missing kind to file (placeholder rendering)", () => {
    const entries = sanitizeSftpEntries([{ name: "odd", uri: "sftp:/odd" }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("file");
  });

  it("keeps known kinds untouched", () => {
    const entries = sanitizeSftpEntries([
      { name: "d", uri: "sftp:/d", kind: "directory" },
      { name: "l", uri: "sftp:/l", kind: "symlink" },
      { name: "o", uri: "sftp:/o", kind: "other" },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["directory", "symlink", "other"]);
  });

  it("neutralizes non-numeric size/modifiedAt instead of crashing comparators", () => {
    const entries = sanitizeSftpEntries([
      { name: "a", uri: "sftp:/a", kind: "file", size: "big", modifiedAt: "yesterday" },
      { name: "b", uri: "sftp:/b", kind: "file", size: 10, modifiedAt: 20 },
    ]);
    expect(entries[0].size).toBeUndefined();
    expect(entries[0].modifiedAt).toBeUndefined();
    expect(entries[1].size).toBe(10);
    expect(entries[1].modifiedAt).toBe(20);
  });

  it("passes a healthy payload through unchanged in shape", () => {
    const row = { name: "hosts", uri: "sftp:/etc/hosts", kind: "file", size: 221, modifiedAt: 1700000000, permissions: "0644" };
    expect(sanitizeSftpEntries([row])).toEqual([row]);
  });
});
