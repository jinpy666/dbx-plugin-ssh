// @vitest-environment happy-dom
// 弹层动画冻结保险（"鬼影弹层"兜底）：宿主渲染器冻结 CSS 动画时，reka 入场
// 动画定格在首帧（opacity 0），弹层"已打开但永远透明"。kick 逻辑只在
// 300ms 后弹层仍不足全不透明时才把冻结动画 finish 到终态（= 自然可见样式）。
import { describe, expect, it, vi } from "vitest";
import { popupRevealKick, schedulePopupReveal, watchPopupReveal } from "./popupReveal";

function mountedEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/** 测试用假动画：只需 playState/finish 两个字段供 kick 分支与断言使用。 */
interface FakeAnimation {
  playState: string;
  finish: () => void;
}

/** 覆盖（或置空，模拟无 WAAPI 的老引擎）元素上的 getAnimations。 */
function setAnimations(el: HTMLElement, anims: FakeAnimation[] | undefined): void {
  (el as unknown as Record<string, unknown>).getAnimations = anims ? () => anims : undefined;
}

function stubOpacity(el: HTMLElement, opacity: string): void {
  const win = el.ownerDocument.defaultView!;
  vi.spyOn(win, "getComputedStyle").mockImplementation(
    () => ({ opacity }) as unknown as CSSStyleDeclaration,
  );
}

describe("popupRevealKick", () => {
  it("does nothing when the element is already fully opaque (healthy host)", () => {
    const el = mountedEl();
    stubOpacity(el, "1");
    expect(popupRevealKick(el)).toBe(false);
  });

  it("ignores elements detached from the document", () => {
    const el = document.createElement("div");
    stubOpacity(el, "0");
    expect(popupRevealKick(el)).toBe(false);
  });

  it("falls back to inline animation:none when getAnimations is unavailable", () => {
    const el = mountedEl();
    setAnimations(el, undefined);
    stubOpacity(el, "0");
    expect(popupRevealKick(el)).toBe(true);
    expect(el.style.animation).toBe("none");
  });

  it("finishes running and paused frozen animations via WAAPI", () => {
    const finish = vi.fn();
    const finishPaused = vi.fn();
    const el = mountedEl();
    stubOpacity(el, "0");
    setAnimations(el, [
      { playState: "running", finish },
      { playState: "paused", finish: finishPaused },
      { playState: "finished", finish: vi.fn() },
    ]);
    expect(popupRevealKick(el)).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finishPaused).toHaveBeenCalledTimes(1);
  });

  it("reports a no-op when a WAAPI host has nothing to finish", () => {
    const el = mountedEl();
    stubOpacity(el, "0.4");
    setAnimations(el, []);
    expect(popupRevealKick(el)).toBe(false);
  });
});

describe("schedulePopupReveal", () => {
  it("kicks the element once the delay elapses and supports cancel", () => {
    vi.useFakeTimers();
    const el = mountedEl();
    setAnimations(el, undefined);
    stubOpacity(el, "0");
    const cancel = schedulePopupReveal(el, 300);
    vi.advanceTimersByTime(299);
    expect(el.style.animation).toBe("");
    vi.advanceTimersByTime(1);
    expect(el.style.animation).toBe("none");
    cancel();
    vi.useRealTimers();
  });

  it("cancelled timers never kick", () => {
    vi.useFakeTimers();
    const el = mountedEl();
    setAnimations(el, undefined);
    stubOpacity(el, "0");
    const cancel = schedulePopupReveal(el, 300);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(el.style.animation).toBe("");
    vi.useRealTimers();
  });
});

describe("watchPopupReveal", () => {
  it("schedules a reveal when a popup layer mounts anywhere under the root", async () => {
    vi.useFakeTimers();
    watchPopupReveal(document.body);
    const wrapper = document.createElement("div");
    const layer = document.createElement("div");
    layer.setAttribute("data-slot", "dialog-content");
    wrapper.appendChild(layer);
    document.body.appendChild(wrapper);
    setAnimations(layer, undefined);
    stubOpacity(layer, "0");
    // MutationObserver 回调走微任务，先 flush 再推进定时器。
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(299);
    expect(layer.style.animation).toBe("");
    vi.advanceTimersByTime(1);
    expect(layer.style.animation).toBe("none");
    vi.useRealTimers();
  });

  it("ignores mounted nodes without a popup layer", async () => {
    vi.useFakeTimers();
    watchPopupReveal(document.body);
    const plain = document.createElement("div");
    plain.textContent = "no layer here";
    document.body.appendChild(plain);
    setAnimations(plain, undefined);
    stubOpacity(plain, "0");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1000);
    expect(plain.style.animation).toBe("");
    vi.useRealTimers();
  });
});
