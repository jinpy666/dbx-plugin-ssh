// 文件夹上传纯函数层的单测（issue #78）：计划构建（路径分组/去重/反斜杠
// 归一/空目录/畸形段过滤）、进度聚合与冲突降级映射。零 UI / 零 sidecar。

import { describe, expect, it } from "vitest";
import {
  advanceFolderUploadDirectories,
  buildFolderUploadPlan,
  createFolderUploadProgress,
  folderUploadConflictAction,
  folderUploadOutcome,
  folderUploadPercent,
  settleFolderUploadFile,
} from "./folderUpload";

describe("buildFolderUploadPlan", () => {
  it("groups files by relative directory and emits parent-first ordered unique directories", () => {
    const plan = buildFolderUploadPlan([
      { name: "a.txt", relativePath: "root/a.txt", size: 1 },
      { name: "b.txt", relativePath: "root/sub/b.txt", size: 2 },
      { name: "c.txt", relativePath: "root/sub/deep/c.txt", size: 3 },
      { name: "d.txt", relativePath: "root/sub/d.txt", size: 4 },
    ]);
    expect(plan.directories).toEqual(["root", "root/sub", "root/sub/deep"]);
    expect(plan.files.map((file) => file.relativePath)).toEqual([
      "root/a.txt",
      "root/sub/b.txt",
      "root/sub/deep/c.txt",
      "root/sub/d.txt",
    ]);
    expect(plan.totalBytes).toBe(10);
  });

  it("normalizes Windows backslash separators in webkitRelativePath", () => {
    const plan = buildFolderUploadPlan([{ name: "b.txt", relativePath: "root\\sub\\b.txt", size: 2 }]);
    expect(plan.files[0].relativePath).toBe("root/sub/b.txt");
    expect(plan.directories).toEqual(["root", "root/sub"]);
  });

  it("resolves dot and dotdot segments so nothing escapes the root", () => {
    const plan = buildFolderUploadPlan([
      { name: "a.txt", relativePath: "root/./a.txt", size: 1 },
      { name: "b.txt", relativePath: "root//x/../b.txt", size: 2 },
    ]);
    expect(plan.directories).toEqual(["root"]);
    expect(plan.files.map((file) => file.relativePath)).toEqual(["root/a.txt", "root/b.txt"]);
  });

  it("skips files whose last segment does not match the file name (malformed input)", () => {
    const good = { name: "good.txt", relativePath: "root/good.txt", size: 5 };
    const plan = buildFolderUploadPlan([
      good,
      { name: "bad.txt", relativePath: "root/other.txt", size: 9 },
      { name: "", relativePath: "", size: 7 },
    ]);
    expect(plan.files).toEqual([{ name: "good.txt", relativePath: "root/good.txt", size: 5, source: good }]);
    expect(plan.totalBytes).toBe(5);
  });

  it("keeps the source entry on each planned file so consumers never pair by index", () => {
    // plan.files 是 entries 的过滤子集：首条畸形被跳过后，按下标配对会把
    // A 的 readChunk 传到 B 的名字下（数据错位）。source 引用是唯一正确配对。
    const first = { name: "skip.txt", relativePath: "", size: 1, readChunk: async () => new Uint8Array() };
    const second = { name: "keep.txt", relativePath: "keep.txt", size: 2, readChunk: async () => new Uint8Array([1]) };
    const plan = buildFolderUploadPlan([first, second]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].source).toBe(second);
    expect(plan.files[0].source.readChunk).toBe(second.readChunk);
  });

  it("accepts a flat selection with no intermediate directories", () => {
    const plan = buildFolderUploadPlan([{ name: "a.txt", relativePath: "a.txt", size: 1 }]);
    expect(plan.directories).toEqual([]);
    expect(plan.files).toHaveLength(1);
  });
});

describe("folder upload progress aggregation", () => {
  it("tracks directory, file and byte counters with an ascending percent", () => {
    const plan = buildFolderUploadPlan([
      { name: "a.txt", relativePath: "root/a.txt", size: 10 },
      { name: "b.txt", relativePath: "root/sub/b.txt", size: 20 },
    ]);
    let state = createFolderUploadProgress(plan);
    expect(state).toEqual({ directoriesDone: 0, directoriesTotal: 2, filesDone: 0, filesTotal: 2, bytesDone: 0, totalBytes: 30, currentFile: "" });
    expect(folderUploadPercent(state)).toBe(0);
    state = advanceFolderUploadDirectories(settleFolderUploadFile(state, { file: plan.files[0], ok: true }));
    expect(state.directoriesDone).toBe(1);
    expect(state.filesDone).toBe(1);
    expect(state.bytesDone).toBe(10);
    expect(folderUploadPercent(state)).toBe(50);
    state = settleFolderUploadFile(state, { file: plan.files[1], ok: false });
    expect(folderUploadPercent(state)).toBe(75);
    expect(state.bytesDone).toBe(10);
  });

  it("maps conflict modes for existing targets: ask degrades to skip, rename/overwrite defer to existing resolution", () => {
    expect(folderUploadConflictAction("ask", true)).toBe("skip");
    expect(folderUploadConflictAction("ask", false)).toBe("upload");
    expect(folderUploadConflictAction("rename", true)).toBe("resolve");
    expect(folderUploadConflictAction("overwrite", true)).toBe("resolve");
  });

  it("summarizes the outcome with uploaded/skipped/failed counts", () => {
    const plan = buildFolderUploadPlan([
      { name: "a.txt", relativePath: "root/a.txt", size: 10 },
      { name: "b.txt", relativePath: "root/sub/b.txt", size: 20 },
    ]);
    let state = createFolderUploadProgress(plan);
    state = advanceFolderUploadDirectories(state);
    state = settleFolderUploadFile(state, { file: plan.files[0], ok: true });
    state = settleFolderUploadFile(state, { file: plan.files[1], ok: true });
    const outcome = folderUploadOutcome(state, 1, 0);
    expect(outcome).toEqual({ fileCount: 2, uploaded: 1, skipped: 1, failed: 0, directories: 1 });
  });
});
