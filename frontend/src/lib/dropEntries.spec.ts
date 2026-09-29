import { describe, expect, it } from "vitest";
import { collectDropRootEntries, scanDroppedEntries, type DropEntryItem, type DropRootEntry } from "./dropEntries";

function fileEntry(fullPath: string, name = fullPath.split("/").pop() || fullPath): DropRootEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    name,
    file: (success) => success({ name, size: 7 } as File),
  };
}

function directoryEntry(fullPath: string, children: DropRootEntry[]): DropRootEntry {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    name: fullPath.split("/").pop() || fullPath,
    createReader: () => {
      let batched = false;
      return {
        readEntries: (success) => {
          // readEntries 每批一交（≤100），交完即空批结束。
          if (batched) success([]);
          batched = true;
          success(children);
        },
      };
    },
  };
}

function itemsOf(entries: Array<DropRootEntry | null>): Array<DropEntryItem> {
  return entries.map((entry) => ({
    kind: "file",
    webkitGetAsEntry: () => entry,
  }));
}

describe("collectDropRootEntries", () => {
  it("returns null when webkitGetAsEntry is unavailable (fallback lane)", () => {
    expect(collectDropRootEntries([{ kind: "file" }])).toBeNull();
    expect(collectDropRootEntries(null)).toBeNull();
    expect(collectDropRootEntries(undefined)).toBeNull();
  });

  it("collects file roots synchronously and skips non-file items", () => {
    const roots = collectDropRootEntries([
      { kind: "string" },
      ...itemsOf([fileEntry("/a.txt")]),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots?.[0].fullPath).toBe("/a.txt");
  });

  it("returns an empty array when no item carries files", () => {
    expect(collectDropRootEntries([{ kind: "string" }])).toEqual([]);
  });
});

describe("scanDroppedEntries", () => {
  it("walks nested directories and reports relative paths", async () => {
    const scan = await scanDroppedEntries([
      directoryEntry("/myfolder", [
        directoryEntry("/myfolder/sub", [fileEntry("/myfolder/sub/a.log")]),
        fileEntry("/myfolder/b.txt"),
      ]),
      fileEntry("/loose.bin"),
    ]);
    expect(scan.directories).toBe(1);
    expect(scan.entries.map((entry) => entry.relativePath)).toEqual([
      "myfolder/sub/a.log",
      "myfolder/b.txt",
      "loose.bin",
    ]);
  });

  it("keeps unreadable file entries from failing the whole batch", async () => {
    const broken = fileEntry("/bad.bin");
    broken.file = (_success, failure) => failure?.(new Error("gone"));
    const scan = await scanDroppedEntries([broken, fileEntry("/ok.bin")]);
    expect(scan.entries.map((entry) => entry.relativePath)).toEqual(["ok.bin"]);
  });

  it("handles a reader that errors instead of ending with an empty batch", async () => {
    const dir: DropRootEntry = {
      isFile: false,
      isDirectory: true,
      fullPath: "/d",
      name: "d",
      createReader: () => ({
        readEntries: (_success, failure) => failure?.(new Error("boom")),
      }),
    };
    const scan = await scanDroppedEntries([dir]);
    expect(scan.directories).toBe(1);
    expect(scan.entries).toEqual([]);
  });
});
