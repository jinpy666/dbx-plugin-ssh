import { describe, expect, it } from "vitest";

import { rememberDownloadToDir, sanitizeDownloadToMemory } from "./downloadToMemory";

describe("downloadToMemory sanitize", () => {
  it("drops malformed storage shapes without polluting state", () => {
    expect(sanitizeDownloadToMemory(null)).toEqual({});
    expect(sanitizeDownloadToMemory("junk")).toEqual({});
    expect(sanitizeDownloadToMemory([1, 2])).toEqual({});
    expect(
      sanitizeDownloadToMemory({
        "": "/keep",
        ok: "/tmp/dl",
        blank: "   ",
        num: 7,
        nested: { dir: "/x" },
      }),
    ).toEqual({ ok: "/tmp/dl" });
  });
});

describe("downloadToMemory remember", () => {
  it("stores the trimmed per-connection dir", () => {
    const memory = rememberDownloadToDir({}, "conn-1", "  /downloads/proj  ");
    expect(memory).toEqual({ "conn-1": "/downloads/proj" });
  });

  it("keeps other connections untouched", () => {
    const memory = rememberDownloadToDir({ "conn-1": "/a", "conn-2": "/b" }, "conn-2", "/c");
    expect(memory).toEqual({ "conn-1": "/a", "conn-2": "/c" });
  });

  it("clears the entry on an empty dir instead of storing blanks", () => {
    const memory = rememberDownloadToDir({ "conn-1": "/a", "conn-2": "/b" }, "conn-2", "   ");
    expect(memory).toEqual({ "conn-1": "/a" });
  });

  it("returns a copy even without a usable connection key", () => {
    const before = { "conn-1": "/a" };
    const memory = rememberDownloadToDir(before, "", "/new");
    expect(memory).toEqual(before);
    expect(memory).not.toBe(before);
  });
});
