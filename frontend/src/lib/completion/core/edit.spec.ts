// applyEditToText / trailingTokenEdit 纯函数单测（FIG wave-1 Lane A）。
// 边界对齐 legacy 接受路径的 HEAD 语义：尾空格/空行 = 行尾纯插入点、
// 引号 token 表面、--flag=val 整体替换、行漂移时的兜底范围。
import { describe, expect, it } from "vitest";
import { applyEditToText, trailingTokenEdit } from "./edit";

describe("trailingTokenEdit", () => {
  it("replaces the trailing token surface and appends a space when asked", () => {
    expect(trailingTokenEdit("git ch", "checkout", true)).toEqual({
      text: "checkout ",
      replaceStart: 4,
      replaceEnd: 6,
    });
    expect(trailingTokenEdit("git ch", "checkout", false)).toEqual({
      text: "checkout",
      replaceStart: 4,
      replaceEnd: 6,
    });
  });

  it("degenerates to a pure insertion point after trailing whitespace / on empty lines", () => {
    expect(trailingTokenEdit("git checkout ", "main", true)).toEqual({
      text: "main ",
      replaceStart: 13,
      replaceEnd: 13,
    });
    expect(trailingTokenEdit("", "git", true)).toEqual({
      text: "git ",
      replaceStart: 0,
      replaceEnd: 0,
    });
    expect(trailingTokenEdit("git   ", "status", false)).toEqual({
      text: "status",
      replaceStart: 6,
      replaceEnd: 6,
    });
  });

  it("keeps the quote surface of a quoted trailing token in the replaced range", () => {
    // HEAD 语义：/\S+$/ 表面含开引号，接受时引号一并替换。
    expect(trailingTokenEdit('git commit -m "hello', "world", false)).toEqual({
      text: "world",
      replaceStart: 14,
      replaceEnd: 20,
    });
  });

  it("covers the whole inline --flag=value surface", () => {
    const line = "kubectl get --output=j";
    expect(trailingTokenEdit(line, "--output=json", false)).toEqual({
      text: "--output=json",
      replaceStart: line.indexOf("--output=j"),
      replaceEnd: line.length,
    });
  });
});

describe("applyEditToText", () => {
  it("replaces the range and defaults the cursor to the end of the inserted text", () => {
    expect(applyEditToText("git ch", { text: "checkout ", replaceStart: 4, replaceEnd: 6 })).toEqual({
      text: "git checkout ",
      cursor: 13,
    });
  });

  it("honours an explicit cursorOffset", () => {
    expect(applyEditToText("git ch", { text: "checkout", replaceStart: 4, replaceEnd: 6, cursorOffset: 2 })).toEqual({
      text: "git checkout",
      cursor: 6,
    });
  });

  it("inserts at a collapsed end-of-line range without consuming anything", () => {
    expect(applyEditToText("git checkout ", { text: "main ", replaceStart: 13, replaceEnd: 13 })).toEqual({
      text: "git checkout main ",
      cursor: 18,
    });
  });

  it("clamps out-of-range edits to the line bounds instead of throwing", () => {
    // 行漂移防御：越界范围向行界收敛（追加语义），不抛错。
    expect(applyEditToText("git", { text: " status", replaceStart: 99, replaceEnd: 120 })).toEqual({
      text: "git status",
      cursor: 10,
    });
    expect(applyEditToText("git", { text: "x", replaceStart: -5, replaceEnd: -1 })).toEqual({
      text: "xgit",
      cursor: 1,
    });
  });

  it("round-trips with trailingTokenEdit: the HEAD acceptance fallback", () => {
    const line = "git ch";
    const edit = trailingTokenEdit(line, "checkout", true);
    expect(applyEditToText(line, edit)).toEqual({ text: "git checkout ", cursor: 13 });
  });
});
