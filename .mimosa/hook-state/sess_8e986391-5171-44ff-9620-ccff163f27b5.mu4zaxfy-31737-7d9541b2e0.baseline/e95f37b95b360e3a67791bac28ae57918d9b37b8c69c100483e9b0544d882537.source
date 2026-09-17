/**
 * Modal focus-management primitives (P1-2).
 *
 * Native `autofocus` is inert for Vue-inserted DOM, so App.vue drives the
 * focus explicitly: on modal open the first interactive control (or the
 * element marked with the `autofocus` attribute as a positioning hint) gets
 * focused, Tab is trapped inside the dialog, and on close focus returns to
 * the triggering element. Same收口 shape as the kafka plugin's dialog
 * handling; the pure decisions live here so they stay unit-testable.
 */

/** 容器内可聚焦元素选择器（disabled / hidden input / tabindex=-1 除外）。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** 容器内文档顺序的可聚焦元素列表。 */
export function focusableElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Tab 焦点陷阱回绕：无焦点/越界时按方向取首/尾，否则循环步进；空容器返回 -1。 */
export function nextFocusIndex(count: number, currentIndex: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= count) return shift ? count - 1 : 0;
  return (currentIndex + (shift ? -1 : 1) + count) % count;
}

/** 弹层 keydown 决策：Esc → close；Tab → focus 回绕目标下标；其余 → none。 */
export type ModalKeydownDecision = { kind: "none" } | { kind: "close" } | { kind: "focus"; index: number };

export function decideModalKeydown(
  key: string,
  shiftKey: boolean,
  focusableCount: number,
  currentIndex: number,
): ModalKeydownDecision {
  if (key === "Escape") return { kind: "close" };
  if (key !== "Tab" || focusableCount <= 0) return { kind: "none" };
  return { kind: "focus", index: nextFocusIndex(focusableCount, currentIndex, shiftKey) };
}

/**
 * 弹层打开时的初始聚焦目标：带 `autofocus` 属性的元素优先（模板里保留的
 * 原生属性此时仅作聚焦定位提示，浏览器动态插入不会自动生效），否则容器内
 * 首个可聚焦控件；容器为空或没有任何可聚焦元素时返回 null。
 */
export function pickModalFocusTarget(container: ParentNode | null): HTMLElement | null {
  if (!container) return null;
  const marked = Array.from(container.querySelectorAll<HTMLElement>("[autofocus]")).find(
    (el) => !el.hasAttribute("disabled") && !el.hasAttribute("hidden"),
  );
  return marked ?? focusableElements(container)[0] ?? null;
}
