// ghostClickGuard 纯逻辑单测（UI_SCAN R3-P1-1）：焦点归还后的合成 click
// 抑制窗——无 mousedown 前驱的 click 在窗内被吞且只吞一次，真实鼠标点击
// （带 mousedown）与窗外 click 一律放行。
import { describe, expect, it } from "vitest";
import { createGhostClickGuard } from "./ghostClickGuard";

describe("createGhostClickGuard", () => {
  it("suppresses a synthetic click (no prior mousedown) inside the armed window", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.arm(now);
    now += 50;
    expect(guard.shouldSuppress(now)).toBe(true);
  });

  it("suppresses only once: the window is consumed by the first hit", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.arm(now);
    now += 50;
    expect(guard.shouldSuppress(now)).toBe(true);
    now += 10;
    expect(guard.shouldSuppress(now)).toBe(false);
  });

  it("passes clicks outside the armed window", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.arm(now);
    now += 401;
    expect(guard.shouldSuppress(now)).toBe(false);
  });

  it("passes clicks without arming (real mouse flows untouched)", () => {
    const guard = createGhostClickGuard(() => 1000);
    expect(guard.shouldSuppress(1000)).toBe(false);
  });

  it("passes a click that carries a recent real mousedown (fast double-click safe)", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.noteMouseDown(now);
    guard.arm(now);
    now += 100; // < GHOST_CLICK_MOUSE_DOWN_GRACE_MS
    expect(guard.shouldSuppress(now)).toBe(false);
  });

  it("still suppresses when the mousedown predates the grace window", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.noteMouseDown(now);
    guard.arm(now);
    now += 300; // > GHOST_CLICK_MOUSE_DOWN_GRACE_MS but inside the arm window
    expect(guard.shouldSuppress(now)).toBe(true);
  });

  it("re-arms for a later focus return after a previous hit", () => {
    let now = 1000;
    const guard = createGhostClickGuard(() => now);
    guard.arm(now);
    now += 10;
    expect(guard.shouldSuppress(now)).toBe(true);
    guard.arm(now);
    now += 10;
    expect(guard.shouldSuppress(now)).toBe(true);
  });
});
