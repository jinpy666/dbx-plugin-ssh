// @vitest-environment happy-dom
// CompletionMenu 测试（FIG wave-1，方案 §24 映射后）：items props 直用
// （label/description/kind）、激活行高亮、kind 图标分支、option kind 角标、
// hint 行弱化样式与点击 accept 回传完整 CompletionItem（App 侧经
// controller.accept 执行 item.edit）。键盘语义在 App（与既有建议浮层一致）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import CompletionMenu from "./CompletionMenu.vue";
import type { CompletionItem } from "../lib/completion/core/types";
import type { SuggestionAnchor } from "../lib/overlayPlacement";

const t = (key: string) => {
  const table: Record<string, string> = {
    "completionMenu.title": "Command completion",
    "completionMenu.acceptHint": "Tab fills · Esc closes",
  };
  return table[key] ?? key;
};

function makeItem(id: string, overrides: Partial<CompletionItem> = {}): CompletionItem {
  return {
    id,
    label: id,
    description: `${id} description`,
    kind: "subcommand",
    score: 100,
    source: "test",
    edit: { text: `${id} `, replaceStart: 4, replaceEnd: 6 },
    ...overrides,
  };
}

const items: CompletionItem[] = [
  makeItem("checkout", { label: "checkout", description: "Switch branches" }),
  makeItem("--branch", { label: "--branch <name>", description: "Create a branch (-b)", kind: "option", score: 70 }),
  makeItem("hint-branch", { label: "<branch>", description: "Dynamic value", kind: "hint", score: 0 }),
];

function mountMenu(activeIndex = 0, anchor: SuggestionAnchor | null = { x: 40, y: 80, cellHeight: 18 }) {
  return mount(CompletionMenu, {
    props: { items, activeIndex, anchor, t },
  });
}

describe("CompletionMenu", () => {
  it("renders the localized listbox label and one option per item", () => {
    const wrapper = mountMenu(0);
    expect(wrapper.find(".completion-menu").attributes("aria-label")).toBe("Command completion");
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
  });

  it("marks only the active row and exposes listbox option semantics", () => {
    const wrapper = mountMenu(1);
    const options = wrapper.findAll('[role="option"]');
    expect(options[1].classes()).toContain("active");
    expect(options[0].classes()).not.toContain("active");
    expect(options[1].attributes("aria-selected")).toBe("true");
  });

  it("requires a pointer move before hover activates, then accepts with the full CompletionItem on click", async () => {
    // 悬停武装：浮层弹出位置恰在鼠标下时，静止指针不得抢走键盘选择。
    const wrapper = mountMenu();
    await wrapper.findAll('[role="option"]')[2].trigger("mouseenter");
    expect(wrapper.emitted("activate")).toBeUndefined();
    await wrapper.find(".completion-menu").trigger("pointermove");
    await wrapper.findAll('[role="option"]')[2].trigger("mouseenter");
    expect(wrapper.emitted("activate")?.[0]).toEqual([2]);
    await wrapper.findAll('[role="option"]')[0].trigger("click");
    // accept 回传完整候选（App 经 controller.accept 执行 item.edit，§24 映射）。
    expect(wrapper.emitted("accept")?.[0]).toEqual([items[0]]);
  });

  it("weakens hint rows and falls back to the bottom dock without an anchor", () => {
    const wrapper = mountMenu(2, null);
    const hintRow = wrapper.findAll('[role="option"]')[2];
    expect(hintRow.classes()).toContain("hint");
    expect(wrapper.find(".completion-menu").classes()).toContain("anchor-fallback");
    expect(wrapper.find(".completion-menu").attributes("style")).toBeUndefined();
  });

  it("positions the panel just below the cursor row when available", () => {
    // 锚点 y 为光标行顶（textarea rect 语义）：top = 行顶 + 行高 + gap（issue #120）
    const wrapper = mountMenu(0, { x: 40, y: 80, cellHeight: 18 });
    expect(wrapper.find(".completion-menu").attributes("style")).toContain("left: 46px");
    expect(wrapper.find(".completion-menu").attributes("style")).toContain("top: 104px");
  });

  it("keys rows by the stable engine item id", () => {
    // item.id 是引擎给出的稳定键：候选重排/重挂时不复用错误 DOM 状态。
    const wrapper = mountMenu(0);
    const rows = wrapper.findAll('[role="option"]');
    expect(rows.map((row) => row.find(".completion-label").text())).toEqual(["checkout", "--branch <name>", "<branch>"]);
  });
});
