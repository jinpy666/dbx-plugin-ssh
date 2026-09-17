// sftpBookmarks 单测：校验矩阵（label/path 边界、大小写不敏感重复、上限）、
// 默认 label、排序纯函数、list 响应收敛（畸形行丢弃）与 RPC 封装的方法名/参数
// 映射（window.dbxPlugin 经 vi.stubGlobal 注入，参照后端契约 sftp/bookmarks/*）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultBookmarkLabel,
  deleteBookmark,
  listBookmarks,
  SFTP_BOOKMARKS_LIMIT,
  SFTP_BOOKMARK_LABEL_MAX_LENGTH,
  SFTP_BOOKMARK_PATH_MAX_LENGTH,
  sanitizeSftpBookmarks,
  saveBookmark,
  sortBookmarksByLabel,
  validateBookmarkInput,
  type SftpBookmark,
} from "./sftpBookmarks";

function bookmark(overrides: Partial<SftpBookmark>): SftpBookmark {
  return { id: "id", label: "label", path: "/tmp", createdAt: 0, updatedAt: 0, ...overrides };
}

describe("validateBookmarkInput", () => {
  it("passes a healthy create input", () => {
    expect(validateBookmarkInput({ label: "logs", path: "/var/log" }, [])).toBeNull();
  });

  it("rejects an empty or whitespace-only label first", () => {
    expect(validateBookmarkInput({ label: "", path: "/var/log" })).toBe("labelEmpty");
    expect(validateBookmarkInput({ label: "   ", path: "/var/log" })).toBe("labelEmpty");
  });

  it("enforces the 64-character label bound (boundary inclusive)", () => {
    const label = "l".repeat(SFTP_BOOKMARK_LABEL_MAX_LENGTH);
    expect(validateBookmarkInput({ label, path: "/var/log" })).toBeNull();
    expect(validateBookmarkInput({ label: `${label}x`, path: "/var/log" })).toBe("labelTooLong");
  });

  it("rejects an empty path after the label checks", () => {
    expect(validateBookmarkInput({ label: "logs", path: "" })).toBe("pathEmpty");
    expect(validateBookmarkInput({ label: "logs", path: "  " })).toBe("pathEmpty");
  });

  it("enforces the 1024-character path bound (boundary inclusive)", () => {
    const path = `/${"p".repeat(SFTP_BOOKMARK_PATH_MAX_LENGTH - 1)}`;
    expect(validateBookmarkInput({ label: "logs", path })).toBeNull();
    expect(validateBookmarkInput({ label: "logs", path: `${path}x` })).toBe("pathTooLong");
  });

  it("reports limitReached before duplicate when the store is full", () => {
    const full = Array.from({ length: SFTP_BOOKMARKS_LIMIT }, (_unused, index) => bookmark({ id: `b${index}`, label: `name-${index}` }));
    expect(validateBookmarkInput({ label: "name-0", path: "/x" }, full)).toBe("limitReached");
    const nearFull = full.slice(0, SFTP_BOOKMARKS_LIMIT - 1);
    expect(validateBookmarkInput({ label: "name-0", path: "/x" }, nearFull)).toBe("labelDuplicate");
  });

  it("detects duplicate labels case-insensitively", () => {
    const existing = [bookmark({ id: "b1", label: "Logs" })];
    expect(validateBookmarkInput({ label: "logs", path: "/var/log" }, existing)).toBe("labelDuplicate");
    expect(validateBookmarkInput({ label: "LOGS ", path: "/var/log" }, existing)).toBe("labelDuplicate");
    expect(validateBookmarkInput({ label: "backups", path: "/var/backups" }, existing)).toBeNull();
  });
});

describe("defaultBookmarkLabel", () => {
  it("takes the last path segment", () => {
    expect(defaultBookmarkLabel("/var/log/app")).toBe("app");
    expect(defaultBookmarkLabel("/var/log/")).toBe("log");
  });

  it("falls back to / for the root and empty paths", () => {
    expect(defaultBookmarkLabel("/")).toBe("/");
    expect(defaultBookmarkLabel("")).toBe("/");
    expect(defaultBookmarkLabel("   ")).toBe("/");
  });

  it("truncates long segments to the label bound", () => {
    expect(defaultBookmarkLabel(`/${"x".repeat(100)}`)).toHaveLength(SFTP_BOOKMARK_LABEL_MAX_LENGTH);
  });
});

describe("sortBookmarksByLabel", () => {
  it("sorts case-insensitively with numeric order and keeps the input untouched", () => {
    const input = [bookmark({ id: "3", label: "beta" }), bookmark({ id: "1", label: "Alpha" }), bookmark({ id: "2", label: "a10" }), bookmark({ id: "4", label: "a2" })];
    const sorted = sortBookmarksByLabel(input);
    // sensitivity:"base" + numeric:true：a2 < a10（数字自然序），数字段先于字母段，大小写不敏感。
    expect(sorted.map((item) => item.id)).toEqual(["4", "2", "1", "3"]);
    expect(input.map((item) => item.id)).toEqual(["3", "1", "2", "4"]);
  });
});

describe("sanitizeSftpBookmarks", () => {
  it("returns an empty array for null / non-object payloads", () => {
    expect(sanitizeSftpBookmarks(null)).toEqual([]);
    expect(sanitizeSftpBookmarks("bookmarks")).toEqual([]);
    expect(sanitizeSftpBookmarks({ bookmarks: "nope" })).toEqual([]);
  });

  it("drops rows missing id/label/path and non-object rows", () => {
    const result = sanitizeSftpBookmarks({
      bookmarks: [
        null,
        42,
        { id: "", label: "a", path: "/a" },
        { id: "b", label: "", path: "/b" },
        { id: "c", label: "c" },
        { id: "d", label: "d", path: "/d", createdAt: 11, updatedAt: 22 },
      ],
    });
    expect(result).toEqual([expect.objectContaining({ id: "d", path: "/d", createdAt: 11, updatedAt: 22 })]);
  });

  it("defaults missing numeric fields to 0", () => {
    const result = sanitizeSftpBookmarks({ bookmarks: [{ id: "e", label: "e", path: "/e" }] });
    expect(result).toEqual([expect.objectContaining({ id: "e", createdAt: 0, updatedAt: 0 })]);
  });

  it("accepts a bare array payload", () => {
    const result = sanitizeSftpBookmarks([{ id: "f", label: "f", path: "/f" }]);
    expect(result).toHaveLength(1);
  });
});

describe("sftp/bookmarks RPC wrappers", () => {
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal("window", { dbxPlugin: { invoke } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("listBookmarks calls sftp/bookmarks/list and sanitizes the payload", async () => {
    invoke.mockResolvedValue({ bookmarks: [{ id: "b1", label: "logs", path: "/var/log", createdAt: 1, updatedAt: 2 }] });
    const bookmarks = await listBookmarks();
    expect(invoke).toHaveBeenCalledWith("sftp/bookmarks/list");
    expect(bookmarks).toEqual([expect.objectContaining({ id: "b1", label: "logs", path: "/var/log" })]);
  });

  it("saveBookmark trims and forwards label/path, mapping the created flag", async () => {
    invoke.mockResolvedValue({ bookmark: { id: "b2", label: "logs", path: "/var/log", createdAt: 3, updatedAt: 4 }, created: true });
    const result = await saveBookmark({ label: "  logs  ", path: " /var/log " });
    expect(invoke).toHaveBeenCalledWith("sftp/bookmarks/save", { label: "logs", path: "/var/log" });
    expect(result).toEqual({ bookmark: expect.objectContaining({ id: "b2" }), created: true });
  });

  it("saveBookmark rejects an invalid bookmark envelope instead of returning garbage", async () => {
    invoke.mockResolvedValue({ bookmark: { id: "", label: "bad" }, created: false });
    await expect(saveBookmark({ label: "bad", path: "/bad" })).rejects.toThrow(/invalid bookmark/);
    invoke.mockResolvedValue(undefined);
    await expect(saveBookmark({ label: "bad", path: "/bad" })).rejects.toThrow(/invalid bookmark/);
  });

  it("deleteBookmark calls sftp/bookmarks/delete and maps the booleans", async () => {
    invoke.mockResolvedValue({ success: true, removed: true });
    expect(await deleteBookmark("b1")).toEqual({ success: true, removed: true });
    expect(invoke).toHaveBeenCalledWith("sftp/bookmarks/delete", { id: "b1" });
    invoke.mockResolvedValue({ success: true });
    expect(await deleteBookmark("missing")).toEqual({ success: true, removed: false });
  });

  it("propagates RPC failures to the caller", async () => {
    invoke.mockRejectedValue(new Error("method not found"));
    await expect(listBookmarks()).rejects.toThrow("method not found");
    await expect(deleteBookmark("b1")).rejects.toThrow("method not found");
  });
});
