// @vitest-environment happy-dom
// DirTree 组件测试：行单击 open、caret 展开/收缩 toggle（阻断 open）、右键 context、
// 当前目录高亮、懒加载 spinner、展开/收起图标切换、递归子节点渲染与事件冒泡；
// 以及 R3-P2-6 键盘可达：role=treeitem、roving tabindex、aria-expanded、caret
// accessible name、Enter/Space/方向键导航。
import { afterEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DirTree from "./DirTree.vue";
import type { DirTreeNode } from "../lib/sftpDirTree";

// t prop 用确定性假实现：根目录文案与 {name} 插值可断言，其余原样返回 key。
const t = (key: string, values?: Record<string, string | number>) => {
  if (key === "sftpSide.root") return "ROOT";
  const template = key === "sftpSide.expandNode" ? "expand {name}" : key === "sftpSide.collapseNode" ? "collapse {name}" : key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name] ?? `{${name}}`));
};

function node(partial: Partial<DirTreeNode> & { path: string; name: string }): DirTreeNode {
  return { expanded: false, loaded: false, loading: false, children: [], ...partial };
}

function mountTree(nodes: DirTreeNode[], currentPath = "/") {
  // 键盘导航用例依赖 document 级查询与真实 focus 行为，必须挂到 document.body。
  return mount(DirTree, { attachTo: document.body, props: { nodes, depth: 0, currentPath, t } });
}

describe("DirTree", () => {
  it("renders one row per node and localizes the '/' root label", () => {
    const wrapper = mountTree([node({ path: "/", name: "/" }), node({ path: "/var", name: "var" })]);
    const rows = wrapper.findAll(".sftp-tree-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].find(".sftp-tree-name").text()).toBe("ROOT");
    expect(rows[1].find(".sftp-tree-name").text()).toBe("var");
    expect(rows[0].attributes("title")).toBe("/");
  });

  it("marks the row matching currentPath with is-current", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var" }), node({ path: "/etc", name: "etc" })], "/etc");
    expect(wrapper.findAll(".sftp-tree-row.is-current")).toHaveLength(1);
    expect(wrapper.find(".sftp-tree-row.is-current .sftp-tree-name").text()).toBe("etc");
  });

  it("indents rows by depth via padding-left", () => {
    const wrapper = mountTree([node({ path: "/", name: "/" })]);
    // depth 0 → 6px, depth 1 → 18px (6 + 12 * depth).
    expect(wrapper.find(".sftp-tree-row").attributes("style")).toContain("padding-left: 6px");
    const nested = mount(DirTree, { props: { nodes: [node({ path: "/var", name: "var" })], depth: 1, currentPath: "/", t } });
    expect(nested.find(".sftp-tree-row").attributes("style")).toContain("padding-left: 18px");
  });

  it("clicking a row emits open with the node (panel navigates)", async () => {
    const target = node({ path: "/var", name: "var" });
    const wrapper = mountTree([node({ path: "/", name: "/" }), target]);
    await wrapper.findAll(".sftp-tree-row")[1].trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([target]);
  });

  it("clicking the caret emits toggle only and does not emit open", async () => {
    const target = node({ path: "/var", name: "var" });
    const wrapper = mountTree([target]);
    await wrapper.find(".sftp-tree-caret").trigger("click");
    expect(wrapper.emitted("toggle")?.[0]).toEqual([target]);
    expect(wrapper.emitted("open")).toBeUndefined();
  });

  it("shows the loading spinner instead of a chevron while a node loads", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var", loading: true })]);
    expect(wrapper.find(".sftp-tree-spinner").exists()).toBe(true);
    expect(wrapper.find(".sftp-tree-caret svg").exists()).toBe(false);
  });

  it("swaps chevron-down + folder-open when expanded, chevron-right + folder when collapsed", () => {
    const wrapper = mountTree([node({ path: "/a", name: "a", expanded: true }), node({ path: "/b", name: "b" })]);
    const rows = wrapper.findAll(".sftp-tree-row");
    const expandedCaret = rows[0].find(".sftp-tree-caret svg");
    const collapsedCaret = rows[1].find(".sftp-tree-caret svg");
    expect(expandedCaret.classes()).toContain("lucide-chevron-down");
    expect(collapsedCaret.classes()).toContain("lucide-chevron-right");
    expect(rows[0].find("svg.lucide-folder-open").exists()).toBe(true);
    expect(rows[1].find("svg.lucide-folder-open").exists()).toBe(false);
    expect(rows[1].find("svg.lucide-folder").exists()).toBe(true);
  });

  it("right-click emits context with the node and pointer coordinates", async () => {
    const target = node({ path: "/var", name: "var" });
    const wrapper = mountTree([target]);
    await wrapper.find(".sftp-tree-row").trigger("contextmenu", { clientX: 120, clientY: 80 });
    expect(wrapper.emitted("context")?.[0]).toEqual([{ node: target, x: 120, y: 80 }]);
  });

  it("renders expanded children one level deeper and bubbles their events to the parent emits", async () => {
    const child = node({ path: "/var/log", name: "log" });
    const root = node({ path: "/var", name: "var", expanded: true, loaded: true, children: [child] });
    const wrapper = mountTree([root]);
    const rows = wrapper.findAll(".sftp-tree-row");
    expect(rows).toHaveLength(2);
    expect(rows[1].attributes("style")).toContain("padding-left: 18px");

    // Child events bubble through the recursive instance up to the same emits.
    await rows[1].trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual([child]);
    await rows[1].find(".sftp-tree-caret").trigger("click");
    expect(wrapper.emitted("toggle")?.[0]).toEqual([child]);
    await rows[1].trigger("contextmenu", { clientX: 5, clientY: 9 });
    expect(wrapper.emitted("context")?.[0]).toEqual([{ node: child, x: 5, y: 9 }]);
  });

  it("does not render child rows for an expanded node whose children are empty", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var", expanded: true, loaded: true, children: [] })]);
    expect(wrapper.findAll(".sftp-tree-row")).toHaveLength(1);
  });

  // ---- R3-P2-6：键盘可达与 aria ----

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes treeitem semantics, aria-expanded and a roving tabindex (R3-P2-6)", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var", expanded: true }), node({ path: "/etc", name: "etc" })], "/etc");
    const rows = wrapper.findAll(".sftp-tree-row");
    expect(rows[0].attributes("role")).toBe("treeitem");
    expect(rows[0].attributes("aria-expanded")).toBe("true");
    expect(rows[1].attributes("aria-expanded")).toBe("false");
    // 当前行 tabindex=0，其余 -1。
    expect(rows[0].attributes("tabindex")).toBe("-1");
    expect(rows[1].attributes("tabindex")).toBe("0");
  });

  it("falls back the roving tabindex to the first row when no row is current", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var" }), node({ path: "/etc", name: "etc" })], "/nowhere");
    const rows = wrapper.findAll(".sftp-tree-row");
    expect(rows[0].attributes("tabindex")).toBe("0");
    expect(rows[1].attributes("tabindex")).toBe("-1");
  });

  it("gives the caret an accessible name with expand/collapse semantics (R3-P2-6)", () => {
    const wrapper = mountTree([node({ path: "/var", name: "var" }), node({ path: "/etc", name: "etc", expanded: true })]);
    const carets = wrapper.findAll(".sftp-tree-caret");
    expect(carets[0].attributes("aria-label")).toBe("expand var");
    expect(carets[1].attributes("aria-label")).toBe("collapse etc");
  });

  it("names the root caret with the localized root label", () => {
    const wrapper = mountTree([node({ path: "/", name: "/" })]);
    expect(wrapper.find(".sftp-tree-caret").attributes("aria-label")).toBe("expand ROOT");
  });

  it("opens on Enter and toggles on Space without emitting the other action", async () => {
    const target = node({ path: "/var", name: "var" });
    const wrapper = mountTree([target]);
    const row = wrapper.find(".sftp-tree-row");
    await row.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("open")?.[0]).toEqual([target]);
    expect(wrapper.emitted("toggle")).toBeUndefined();
    await row.trigger("keydown", { key: " " });
    expect(wrapper.emitted("toggle")?.[0]).toEqual([target]);
    expect(wrapper.emitted("open")).toHaveLength(1);
  });

  it("moves focus with ArrowDown/ArrowUp across rows (roving navigation, R3-P2-6)", async () => {
    const wrapper = mountTree([node({ path: "/a", name: "a" }), node({ path: "/b", name: "b" }), node({ path: "/c", name: "c" })]);
    const rows = wrapper.findAll(".sftp-tree-row");
    await rows[0].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1].element);
    await rows[1].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[2].element);
    await rows[2].trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[1].element);
  });

  it("does not move focus or preventDefault at the list edges", async () => {
    const wrapper = mountTree([node({ path: "/a", name: "a" }), node({ path: "/b", name: "b" })]);
    const rows = wrapper.findAll(".sftp-tree-row");
    await rows[2]?.trigger("keydown", { key: "ArrowDown" });
    await rows[0].trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).not.toBe(rows[1].element);
  });
});
