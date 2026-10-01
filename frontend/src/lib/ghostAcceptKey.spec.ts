// @vitest-environment happy-dom
// ghost 接受键配置单测（批 4e）：sanitize/load/save 往返 + 事件匹配矩阵。
import { beforeEach, describe, expect, it } from "vitest";
import { loadGhostAcceptKey, matchesGhostAcceptKey, sanitizeGhostAcceptKey, saveGhostAcceptKey, type GhostAcceptKey } from "./ghostAcceptKey";

const NO_MOD = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("ghostAcceptKey (批 4e, Warp Accept Autosuggestion 可重绑)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to bare ArrowRight and round-trips a custom binding", () => {
    expect(loadGhostAcceptKey()).toBe("ArrowRight");
    saveGhostAcceptKey("CtrlArrowRight");
    expect(loadGhostAcceptKey()).toBe("CtrlArrowRight");
    saveGhostAcceptKey("ArrowRight");
  });

  it("sanitizes unknown values back to the default", () => {
    expect(sanitizeGhostAcceptKey("Space")).toBe("ArrowRight");
    expect(sanitizeGhostAcceptKey(42)).toBe("ArrowRight");
  });

  it("matches per-configured key with exact modifier sets", () => {
    expect(matchesGhostAcceptKey("ArrowRight", "ArrowRight", NO_MOD)).toBe(true);
    expect(matchesGhostAcceptKey("ArrowRight", "ArrowRight", { ...NO_MOD, ctrlKey: true })).toBe(false);
    expect(matchesGhostAcceptKey("CtrlArrowRight", "ArrowRight", { ...NO_MOD, ctrlKey: true })).toBe(true);
    expect(matchesGhostAcceptKey("CtrlArrowRight", "ArrowRight", { ...NO_MOD, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(matchesGhostAcceptKey("ShiftArrowRight", "ArrowRight", { ...NO_MOD, shiftKey: true })).toBe(true);
    expect(matchesGhostAcceptKey("Tab", "Tab", NO_MOD)).toBe(true);
    expect(matchesGhostAcceptKey("Tab", "Tab", { ...NO_MOD, shiftKey: true })).toBe(false);
    expect(matchesGhostAcceptKey("Tab", "ArrowRight", NO_MOD)).toBe(false);
  });

  it("types round-trip through the value set", () => {
    const values: GhostAcceptKey[] = ["ArrowRight", "CtrlArrowRight", "ShiftArrowRight", "Tab"];
    for (const value of values) expect(sanitizeGhostAcceptKey(value)).toBe(value);
  });
});
