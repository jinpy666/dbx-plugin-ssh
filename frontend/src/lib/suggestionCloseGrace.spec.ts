// @vitest-environment happy-dom
// 空结果宽限（批 3b 防闪烁）回归守卫：150ms 迟滞内重新命中不关闭，
// 真正无匹配才收起。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuggestionCloseGrace } from "./suggestionCloseGrace";

describe("suggestionCloseGrace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("closes after the grace window when the overlay stays empty", () => {
    const close = vi.fn();
    const grace = createSuggestionCloseGrace(close);
    grace.schedule(true);
    vi.advanceTimersByTime(149);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not schedule for a closed overlay", () => {
    const close = vi.fn();
    const grace = createSuggestionCloseGrace(close);
    grace.schedule(false);
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });

  it("cancels the pending close when the next keystroke re-hits", () => {
    const close = vi.fn();
    const grace = createSuggestionCloseGrace(close);
    grace.schedule(true);
    vi.advanceTimersByTime(100);
    grace.cancel();
    vi.advanceTimersByTime(500);
    expect(close).not.toHaveBeenCalled();
  });

  it("re-scheduling replaces the pending close instead of stacking timers", () => {
    const close = vi.fn();
    const grace = createSuggestionCloseGrace(close);
    grace.schedule(true);
    vi.advanceTimersByTime(100);
    grace.schedule(true);
    vi.advanceTimersByTime(149);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
