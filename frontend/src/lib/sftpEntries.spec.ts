// sanitizeSftpEntries 单测（UI_SCAN R3-P2-3）：sftp/list 坏响应防御——
// null/非数组整体收敛为空数组、null 行与无名/无 uri 行丢弃、缺 kind 降级
// 为 file（渲染占位而非整表丢弃/比较器抛错）。
import { describe, expect, it } from "vitest";
import { formatSftpPermissions, sanitizeSftpEntries, sanitizeVisibleColumns, sftpEntryIconKind, sftpFileTypeName } from "./sftpEntries";

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
    // sanitize 归一化补齐 owner/group（undefined）与 lossy（缺省即 undefined），
    // 其余字段原样透传。
    expect(sanitizeSftpEntries([row])).toEqual([{ ...row, lossy: undefined }]);
  });

  it("keeps owner/group strings and normalizes non-string values to undefined", () => {
    const entries = sanitizeSftpEntries([
      { name: "a", uri: "sftp:/a", kind: "file", owner: "root", group: "docker" },
      { name: "b", uri: "sftp:/b", kind: "file", owner: 1000, group: null },
      { name: "c", uri: "sftp:/c", kind: "file" },
    ]);
    // issue #34：字符串直接透传；数字/空值归一为缺省（UI 渲染 "-"）。
    expect(entries[0].owner).toBe("root");
    expect(entries[0].group).toBe("docker");
    expect(entries[1].owner).toBeUndefined();
    expect(entries[1].group).toBeUndefined();
    expect(entries[2].owner).toBeUndefined();
    expect(entries[2].group).toBeUndefined();
  });

  it("keeps the lossy flag only for boolean true (non-UTF-8 names)", () => {
    // 名称解码后含 U+FFFD 的条目由 sidecar 标记 lossy=true；
    // 缺字段（旧 sidecar）与非布尔值一律归一为缺省，避免畸形数据触发警示。
    const entries = sanitizeSftpEntries([
      { name: "bad\uFFFDname", uri: "sftp:/x", kind: "file", lossy: true },
      { name: "clean", uri: "sftp:/y", kind: "file" },
      { name: "junk", uri: "sftp:/z", kind: "file", lossy: "yes" },
    ]);
    expect(entries[0].lossy).toBe(true);
    expect(entries[1].lossy).toBeUndefined();
    expect(entries[2].lossy).toBeUndefined();
  });
});

describe("sanitizeVisibleColumns", () => {
  it("falls back to the default columns for non-array payloads", () => {
    expect(sanitizeVisibleColumns(undefined)).toEqual(["modified", "size", "kind"]);
    expect(sanitizeVisibleColumns(null)).toEqual(["modified", "size", "kind"]);
    expect(sanitizeVisibleColumns("size")).toEqual(["modified", "size", "kind"]);
  });

  it("keeps only known columns and drops junk entries", () => {
    expect(sanitizeVisibleColumns(["size", "owner", "group", "permissions", "evil"])).toEqual(["size", "owner", "group"]);
    // 独立权限列已并入名称第二行，旧偏好只丢弃该列，不影响其他选择。
    expect(sanitizeVisibleColumns(["modified", "permissions"])).toEqual(["modified"]);
  });

  it("falls back to defaults when nothing usable remains", () => {
    expect(sanitizeVisibleColumns([])).toEqual(["modified", "size", "kind"]);
    expect(sanitizeVisibleColumns([42, null])).toEqual(["modified", "size", "kind"]);
  });

  it("accepts kind and owner/group columns from persisted state", () => {
    expect(sanitizeVisibleColumns(["size", "kind", "owner", "group"])).toEqual(["size", "kind", "owner", "group"]);
  });
});

describe("sftpFileTypeName", () => {
  it("returns a lowercase extension for the kind column", () => {
    expect(sftpFileTypeName("Archive.TAR.GZ")).toBe("gz");
    expect(sftpFileTypeName("server.LOG")).toBe("log");
  });

  it("ignores URL query strings and fragments when reading the extension", () => {
    expect(sftpFileTypeName("photo.JPG?Expires=1780717009&Signature=abc")).toBe("jpg");
    expect(sftpFileTypeName("report.PDF#page=3")).toBe("pdf");
  });

  it("returns an empty label for extensionless files and dotfiles", () => {
    expect(sftpFileTypeName("README")).toBe("");
    expect(sftpFileTypeName(".gitignore")).toBe("");
    expect(sftpFileTypeName(" trailing.")).toBe("");
  });
});

describe("formatSftpPermissions", () => {
  it("renders POSIX permission bits with the entry type", () => {
    expect(formatSftpPermissions("0755", "directory")).toBe("drwxr-xr-x");
    expect(formatSftpPermissions("0644", "file")).toBe("-rw-r--r--");
    expect(formatSftpPermissions("0600", "file")).toBe("-rw-------");
    expect(formatSftpPermissions("0777", "symlink")).toBe("lrwxrwxrwx");
  });

  it("preserves setuid, setgid and sticky bits", () => {
    expect(formatSftpPermissions("4755", "file")).toBe("-rwsr-xr-x");
    expect(formatSftpPermissions("2751", "file")).toBe("-rwxr-s--x");
    expect(formatSftpPermissions("1777", "directory")).toBe("drwxrwxrwt");
    expect(formatSftpPermissions("1776", "directory")).toBe("drwxrwxrwT");
  });

  it("passes through existing symbolic or missing values", () => {
    expect(formatSftpPermissions("drwxr-xr-x", "directory")).toBe("drwxr-xr-x");
    expect(formatSftpPermissions(undefined, "file")).toBe("");
  });
});

// sftpEntryIconKind 单测（issue #36）：文件列表图标的唯一裁决点——
// 只有 directory 允许文件夹图标；other/未知（旧 sidecar、类型位缺失兜底
// 之前的输入）一律按普通文件渲染，杜绝"文件显示成文件夹图标"。
describe("sftpEntryIconKind", () => {
  it("renders only directories as folders", () => {
    expect(sftpEntryIconKind("directory")).toBe("folder");
  });

  it("renders regular files — with or without an extension — as files", () => {
    expect(sftpEntryIconKind("file")).toBe("file");
  });

  it("keeps symlinks on the link-doc icon", () => {
    expect(sftpEntryIconKind("symlink")).toBe("link");
  });

  it("degrades other/unknown kinds to the file icon, never a folder", () => {
    expect(sftpEntryIconKind("other")).toBe("file");
    expect(sftpEntryIconKind(undefined)).toBe("file");
    expect(sftpEntryIconKind("")).toBe("file");
    expect(sftpEntryIconKind("weird-future-kind")).toBe("file");
  });
});
