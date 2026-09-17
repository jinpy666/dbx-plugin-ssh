// @vitest-environment happy-dom
// modalFocus 纯函数 + DOM 行为测试（P1-2 弹层焦点管理）：
// 可聚焦元素发现、Tab 回绕、弹层 keydown 决策、初始聚焦目标（autofocus 标记优先）。
import { describe, expect, it } from "vitest";

import { decideModalKeydown, focusableElements, nextFocusIndex, pickModalFocusTarget } from "./modalFocus";

function buildModal(html: string): HTMLElement {
  const backdrop = document.createElement("section");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<article class="modal small-modal">${html}</article>`;
  document.body.appendChild(backdrop);
  return backdrop.querySelector<HTMLElement>(".modal")!;
}

describe("focusableElements", () => {
  it("collects document-order focusable controls and skips disabled/hidden ones", () => {
    const modal = buildModal(`
      <button id="close" class="icon-button">x</button>
      <input id="name" />
      <button id="confirm" disabled>Confirm</button>
      <input id="hidden" type="hidden" />
      <select id="kind"><option>a</option></select>
      <textarea id="note"></textarea>
    `);
    const ids = focusableElements(modal).map((el) => el.id);
    expect(ids).toEqual(["close", "name", "kind", "note"]);
    modal.remove();
  });

  it("returns an empty list for a container without focusable controls", () => {
    const modal = buildModal("<p>plain text</p>");
    expect(focusableElements(modal)).toEqual([]);
    modal.remove();
  });
});

describe("nextFocusIndex", () => {
  it("wraps forward and backward inside the modal", () => {
    expect(nextFocusIndex(3, 0, false)).toBe(1);
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 2, true)).toBe(1);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
  });

  it("pulls stray focus back inside on the first Tab", () => {
    // 焦点在 BODY（-1）时：正向 Tab 进首控件，反向 Tab 进尾控件。
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
  });

  it("returns -1 for an empty container", () => {
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });
});

describe("decideModalKeydown", () => {
  it("closes on Escape and steps focus on Tab only", () => {
    expect(decideModalKeydown("Escape", false, 0, -1)).toEqual({ kind: "close" });
    expect(decideModalKeydown("Tab", false, 3, 0)).toEqual({ kind: "focus", index: 1 });
    expect(decideModalKeydown("Enter", false, 3, 0)).toEqual({ kind: "none" });
    expect(decideModalKeydown("Tab", false, 0, -1)).toEqual({ kind: "none" });
  });
});

describe("pickModalFocusTarget", () => {
  it("prefers the element marked with autofocus (native attribute is inert for Vue-inserted DOM)", () => {
    const modal = buildModal(`
      <button id="close">x</button>
      <input id="draft" autofocus />
      <button id="run">Run</button>
    `);
    expect(pickModalFocusTarget(modal)?.id).toBe("draft");
    modal.remove();
  });

  it("falls back to the first focusable control when nothing is marked", () => {
    // 删除确认弹层模式：无 autofocus 标记 → 首个可聚焦（header 关闭钮）。
    const modal = buildModal(`
      <header><button id="x">x</button></header>
      <footer><button id="cancel">Cancel</button><button id="delete">Delete</button></footer>
    `);
    expect(pickModalFocusTarget(modal)?.id).toBe("x");
    modal.remove();
  });

  it("skips a disabled autofocus element and returns null for empty containers", () => {
    const modal = buildModal(`
      <input id="busy" autofocus disabled />
      <button id="ok">OK</button>
    `);
    expect(pickModalFocusTarget(modal)?.id).toBe("ok");
    modal.remove();
    expect(pickModalFocusTarget(null)).toBeNull();
    const empty = buildModal("<p>loading</p>");
    expect(pickModalFocusTarget(empty)).toBeNull();
    empty.remove();
  });
});
