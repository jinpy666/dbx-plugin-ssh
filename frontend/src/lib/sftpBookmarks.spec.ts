// sftpBookmarks 单测：校验矩阵（label/path 边界、大小写不敏感重复、上限）、
// 默认 label、排序纯函数、list 响应收敛（畸形行丢弃）、权威清单存取与
// upsert/remove 纯函数（存储迁移批 1：pluginStore 权威，listBookmarks 仅作
// sidecar 一次性搬迁种子；vi.stubGlobal 注入 window.dbxPlugin）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultBookmarkLabel,
  listBookmarks,
  loadSftpBookmarksFromStore,
  persistSftpBookmarks,
  removeBookmark,
  SFTP_BOOKMARKS_LIMIT,
  SFTP_BOOKMARK_LABEL_MAX_LENGTH,
  SFTP_BOOKMARK_PATH_MAX_LENGTH,
  sanitizeSftpBookmarks,
  sortBookmarksByLabel,
  upsertBookmark,
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

  it("propagates RPC failures to the caller", async () => {
    invoke.mockRejectedValue(new Error("method not found"));
    await expect(listBookmarks()).rejects.toThrow("method not found");
  });
});

describe("store-backed authority (存储迁移批 1)", () => {
  // 本文件的 store 断言依赖顺序：未落键 → null 的断言必须在首个 persist 之前
  // （pluginStore 模块缓存在同文件内跨用例存活，load 走缓存不回源）。
  it("loadSftpBookmarksFromStore returns null while the key is absent (seed not yet applied)", () => {
    expect(loadSftpBookmarksFromStore()).toBeNull();
  });

  it("persist then load round-trips a sorted, sanitized list", () => {
    const stored = persistSftpBookmarks([
      { id: "b2", label: "beta", path: "/b", createdAt: 2, updatedAt: 2 },
      { id: "b1", label: "alpha", path: "/a", createdAt: 1, updatedAt: 1 },
    ]);
    expect(stored.map((item) => item.id)).toEqual(["b1", "b2"]);
    expect(loadSftpBookmarksFromStore()).toEqual(stored);
  });

  it("treating an empty list as present prevents legacy resurrection after user clears all", () => {
    persistSftpBookmarks([]);
    expect(loadSftpBookmarksFromStore()).toEqual([]);
  });

  describe("upsertBookmark", () => {
    it("creates with a generated id and timestamps, keeping label order", () => {
      const { bookmarks, bookmark: saved } = upsertBookmark(
        [bookmark({ id: "b2", label: "beta" })],
        { label: "alpha", path: "/a" },
        1000,
      );
      expect(bookmarks.map((item) => item.id)).toEqual([saved.id, "b2"]);
      expect(saved).toEqual({ id: expect.any(String), label: "alpha", path: "/a", createdAt: 1000, updatedAt: 1000 });
      expect(saved.id).not.toBe("b2");
    });

    it("updates by id keeping createdAt and refreshing updatedAt", () => {
      const seed = [bookmark({ id: "b1", label: "alpha", path: "/old", createdAt: 5, updatedAt: 5 })];
      const { bookmarks, bookmark: saved } = upsertBookmark(seed, { id: "b1", label: "alpha", path: "/new" }, 2000);
      expect(bookmarks).toHaveLength(1);
      expect(saved).toEqual({ id: "b1", label: "alpha", path: "/new", createdAt: 5, updatedAt: 2000 });
    });

    it("never exceeds the 20-entry limit as a backstop behind validateBookmarkInput", () => {
      let list: SftpBookmark[] = [];
      for (let i = 0; i < SFTP_BOOKMARKS_LIMIT + 5; i += 1) {
        list = upsertBookmark(list, { label: `n-${String(i).padStart(2, "0")}`, path: `/p${i}` }, i).bookmarks;
      }
      expect(list).toHaveLength(SFTP_BOOKMARKS_LIMIT);
    });
  });

  describe("removeBookmark", () => {
    it("removes by id and ignores unknown ids", () => {
      const seed = [bookmark({ id: "b1" }), bookmark({ id: "b2" })];
      expect(removeBookmark(seed, "b1").map((item) => item.id)).toEqual(["b2"]);
      expect(removeBookmark(seed, "missing").map((item) => item.id)).toEqual(["b1", "b2"]);
    });
  });
});
