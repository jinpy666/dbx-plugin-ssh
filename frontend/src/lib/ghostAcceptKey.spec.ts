// @vitest-environment happy-dom
// ghost 接受键单测（Warp 多键模型）：Tab 开关持久化 + 整段/逐词匹配矩阵。
import { beforeEach, describe, expect, it } from "vitest";
import { loadGhostTabAccept, matchesGhostFullAccept, matchesGhostWordAccept, saveGhostTabAccept } from "./ghostAcceptKey";

const NO_MOD = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("ghostAcceptKey (Warp Autosuggestions 键位模型)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("Tab accept defaults off and round-trips", () => {
    expect(loadGhostTabAccept()).toBe(false);
    saveGhostTabAccept(true);
    expect(loadGhostTabAccept()).toBe(true);
    saveGhostTabAccept(false);
  });

  it("full accept: bare ArrowRight, Ctrl+F and Ctrl+E with ctrl only", () => {
    expect(matchesGhostFullAccept("ArrowRight", NO_MOD)).toBe(true);
    expect(matchesGhostFullAccept("f", { ...NO_MOD, ctrlKey: true })).toBe(true);
    expect(matchesGhostFullAccept("F", { ...NO_MOD, ctrlKey: true })).toBe(true);
    expect(matchesGhostFullAccept("e", { ...NO_MOD, ctrlKey: true })).toBe(true);
  });

  it("full accept rejects modifier mixtures that belong to other actions", () => {
    expect(matchesGhostFullAccept("ArrowRight", { ...NO_MOD, ctrlKey: true })).toBe(false);
    expect(matchesGhostFullAccept("ArrowRight", { ...NO_MOD, shiftKey: true })).toBe(false);
    expect(matchesGhostFullAccept("f", { ...NO_MOD, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(matchesGhostFullAccept("e", { ...NO_MOD, ctrlKey: true, metaKey: true })).toBe(false);
    expect(matchesGhostFullAccept("f", NO_MOD)).toBe(false);
    expect(matchesGhostFullAccept("g", { ...NO_MOD, ctrlKey: true })).toBe(false);
  });

  it("word accept: Ctrl+→ and Ctrl+Shift+→ (macOS / Windows·Linux), not Meta/Alt", () => {
    expect(matchesGhostWordAccept("ArrowRight", { ...NO_MOD, ctrlKey: true })).toBe(true);
    expect(matchesGhostWordAccept("ArrowRight", { ...NO_MOD, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(matchesGhostWordAccept("ArrowRight", { ...NO_MOD, metaKey: true })).toBe(false);
    expect(matchesGhostWordAccept("ArrowRight", { ...NO_MOD, altKey: true })).toBe(false);
    expect(matchesGhostWordAccept("ArrowRight", NO_MOD)).toBe(false);
    expect(matchesGhostWordAccept("Tab", { ...NO_MOD, ctrlKey: true })).toBe(false);
  });
});
