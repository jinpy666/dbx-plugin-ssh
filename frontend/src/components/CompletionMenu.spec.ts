// @vitest-environment happy-dom
// CompletionMenu 测试：面包屑/层级标签、激活行高亮、kind 图标分支、
// hint 行弱化样式与点击 accept 上抛。键盘语义在 App（与既有建议浮层一致）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import CompletionMenu from "./CompletionMenu.vue";
import type { CompletionRow } from "../lib/completions/spec";

const t = (key: string) => {
  const table: Record<string, string> = {
    "completionMenu.title": "Command completion",
    "completionMenu.levelSub": "Subcommands",
    "completionMenu.levelFlag": "Flags",
    "completionMenu.levelValue": "Values",
    "completionMenu.acceptHint": "Tab/Enter fills · Esc closes",
  };
  return table[key] ?? key;
};

const rows: CompletionRow[] = [
  { kind: "sub", token: "checkout", space: true, label: "checkout", description: "Switch branches", score: 100 },
  { kind: "flag", token: "--branch", space: false, label: "--branch <name>", description: "Create a branch (-b)", score: 70 },
  { kind: "hint", token: "", space: false, label: "<branch>", description: "Dynamic value", score: 0 },
];

function mountMenu(activeIndex = 0, level: "sub" | "flag" | "value" = "sub", anchor: { x: number; y: number } | null = { x: 40, y: 80 }) {
  return mount(CompletionMenu, {
    props: { rows, level, commandPath: ["git", "checkout"], activeIndex, anchor, t },
  });
}

describe("CompletionMenu", () => {
  it("renders the command breadcrumb and the localized level label", () => {
    const wrapper = mountMenu(0, "flag");
    expect(wrapper.find(".completion-crumb").text()).toBe("git › checkout");
    expect(wrapper.find(".completion-level").text()).toBe("Flags");
    expect(wrapper.find(".completion-menu").attributes("aria-label")).toBe("Command completion");
  });

  it("marks only the active row and exposes listbox option semantics", () => {
    const wrapper = mountMenu(1);
    const options = wrapper.findAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options[1].classes()).toContain("active");
    expect(options[0].classes()).not.toContain("active");
    expect(options[1].attributes("aria-selected")).toBe("true");
  });

  it("emits activate on hover and accept with the full row on click", async () => {
    const wrapper = mountMenu();
    await wrapper.findAll('[role="option"]')[2].trigger("mouseenter");
    expect(wrapper.emitted("activate")?.[0]).toEqual([2]);
    await wrapper.findAll('[role="option"]')[0].trigger("click");
    expect(wrapper.emitted("accept")?.[0]).toEqual([rows[0]]);
  });

  it("weakens hint rows and falls back to the bottom dock without an anchor", () => {
    const wrapper = mountMenu(2, "value", null);
    const hintRow = wrapper.findAll('[role="option"]')[2];
    expect(hintRow.classes()).toContain("hint");
    expect(wrapper.find(".completion-menu").classes()).toContain("anchor-fallback");
    expect(wrapper.find(".completion-menu").attributes("style")).toBeUndefined();
  });

  it("positions the panel at the cursor anchor when available", () => {
    const wrapper = mountMenu(0, "sub", { x: 40, y: 80 });
    expect(wrapper.find(".completion-menu").attributes("style")).toContain("left: 40px");
    expect(wrapper.find(".completion-menu").attributes("style")).toContain("top: 80px");
  });
});
