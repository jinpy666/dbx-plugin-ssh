// shouldCommitRename 单测（UI_SCAN R3-P1-2 / R3-P2-1）：blur 兜底提交入口的
// 守卫——Esc 取消（editingPath 已清空）与 Enter 提交中（submitting）的幽灵
// blur 一律拒绝，仅编辑态仍指向本行时放行。
import { describe, expect, it } from "vitest";
import { shouldCommitRename } from "./sftpRename";

const editing = { editingPath: "sftp:/home/demo/server.log", entryUri: "sftp:/home/demo/server.log", submitting: false };

describe("shouldCommitRename", () => {
  it("allows the commit while the row is still being edited", () => {
    expect(shouldCommitRename(editing)).toBe(true);
  });

  it("rejects after Escape cleared the editing path (cancel semantics)", () => {
    expect(shouldCommitRename({ ...editing, editingPath: "" })).toBe(false);
  });

  it("rejects the ghost blur after Enter submitted (renamePath already cleared)", () => {
    expect(shouldCommitRename({ ...editing, editingPath: "" })).toBe(false);
  });

  it("rejects while a commit is in flight (Enter double-submit guard)", () => {
    expect(shouldCommitRename({ ...editing, submitting: true })).toBe(false);
  });

  it("rejects a blur leaking from a different row", () => {
    expect(shouldCommitRename({ ...editing, entryUri: "sftp:/home/demo/other.log" })).toBe(false);
  });

  it("prioritizes the submitting guard even if the path still matches", () => {
    expect(shouldCommitRename({ ...editing, submitting: true })).toBe(false);
  });
});
