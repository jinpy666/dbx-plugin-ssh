import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRowMenuController } from "./dockerRowMenu";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("dockerRowMenu", () => {
  it("opens the hovered row's menu after the open delay", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    expect(menu.isOpen("a")).toBe(false);
    vi.advanceTimersByTime(119);
    expect(menu.isOpen("a")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(menu.isOpen("a")).toBe(true);
  });

  it("moves a pending open to the newly hovered row", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(60);
    menu.hoverTrigger("b");
    vi.advanceTimersByTime(119);
    expect(menu.isOpen("a")).toBe(false);
    expect(menu.isOpen("b")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(menu.isOpen("b")).toBe(true);
  });

  it("keeps the menu open across the trigger→content gap via the close delay", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(120);
    menu.leaveToClose();
    vi.advanceTimersByTime(219);
    expect(menu.isOpen("a")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(menu.isOpen("a")).toBe(false);
  });

  it("cancels the pending close when the pointer enters the menu content", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(120);
    menu.leaveToClose();
    menu.hoverContent();
    vi.advanceTimersByTime(1000);
    expect(menu.isOpen("a")).toBe(true);
  });

  it("cancels the pending close when the pointer returns to the open trigger", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(120);
    menu.leaveToClose();
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(1000);
    expect(menu.isOpen("a")).toBe(true);
  });

  it("toggles immediately on click and switches rows", () => {
    const menu = createRowMenuController();
    menu.toggle("a");
    expect(menu.isOpen("a")).toBe(true);
    menu.toggle("b");
    expect(menu.isOpen("a")).toBe(false);
    expect(menu.isOpen("b")).toBe(true);
    menu.toggle("b");
    expect(menu.isOpen("b")).toBe(false);
  });

  it("close() clears the state and any pending timers", () => {
    const menu = createRowMenuController();
    menu.hoverTrigger("a");
    menu.close();
    vi.advanceTimersByTime(1000);
    expect(menu.isOpen("a")).toBe(false);
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(120);
    menu.leaveToClose();
    menu.close();
    vi.advanceTimersByTime(1000);
    expect(menu.isOpen("a")).toBe(false);
  });

  it("honours custom delays", () => {
    const menu = createRowMenuController({ openDelayMs: 10, closeDelayMs: 20 });
    menu.hoverTrigger("a");
    vi.advanceTimersByTime(10);
    expect(menu.isOpen("a")).toBe(true);
    menu.leaveToClose();
    vi.advanceTimersByTime(20);
    expect(menu.isOpen("a")).toBe(false);
  });
});
