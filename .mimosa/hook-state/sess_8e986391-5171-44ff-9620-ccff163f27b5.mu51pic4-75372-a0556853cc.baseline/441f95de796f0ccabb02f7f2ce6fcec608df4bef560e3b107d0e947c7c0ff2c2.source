// @vitest-environment happy-dom
// SideNavPanel 组件测试：tree/quick 双 tab 切换、刷新与收起/展开、树行
// open→navigate、caret→toggle-node、右键→node-context、快捷路径列表
// （导航 / 当前高亮 / home 与普通目录图标 / 右键菜单）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SideNavPanel, { type SftpSideQuickPath } from "./SideNavPanel.vue";
import type { DirTreeNode } from "../lib/sftpDirTree";

// t prop 假实现：key 原样返回，title 属性断言与 i18n 表解耦且可定位按钮。
const t = (key: string) => key;

const quickPaths: SftpSideQuickPath[] = [
  { path: "/home/dev", label: "HOME_DIR", home: true },
  { path: "/srv/data", label: "/srv/data" },
];

function node(partial: Partial<DirTreeNode> & { path: string; name: string }): DirTreeNode {
  return { expanded: false, loaded: false, loading: false, children: [], ...partial };
}

const treeRoot = node({
  path: "/",
  name: "/",
  expanded: true,
  loaded: true,
  children: [node({ path: "/var", name: "var" })],
});

function mountPanel(props: Partial<{ tab: "tree" | "quick"; collapsed: boolean; currentPath: string; treeRoot: DirTreeNode | null }> = {}) {
  return mount(SideNavPanel, {
    props: {
      tab: "tree",
      collapsed: false,
      treeRoot,
      quickPaths,
      currentPath: "/",
      t,
      ...props,
    },
  });
}

describe("SideNavPanel", () => {
  it("activates the tree tab by default and shows the refresh button only there", () => {
    const wrapper = mountPanel();
    expect(wrapper.find('button[title="sftpSide.tree"]').classes()).toContain("is-active");
    expect(wrapper.find('button[title="sftpQuickPath.title"]').classes()).not.toContain("is-active");
    expect(wrapper.find('button[title="refresh"]').exists()).toBe(true);
  });

  it("clicking the quick tab emits update:tab and hides the refresh button", async () => {
    const wrapper = mountPanel({ tab: "quick" });
    await wrapper.find('button[title="sftpQuickPath.title"]').trigger("click");
    expect(wrapper.emitted("update:tab")?.[0]).toEqual(["quick"]);
    expect(wrapper.find('button[title="refresh"]').exists()).toBe(false);
  });

  it("clicking the tree tab emits update:tab with 'tree'", async () => {
    const wrapper = mountPanel({ tab: "quick" });
    await wrapper.find('button[title="sftpSide.tree"]').trigger("click");
    expect(wrapper.emitted("update:tab")?.[0]).toEqual(["tree"]);
  });

  it("the refresh button emits refresh-tree", async () => {
    const wrapper = mountPanel();
    await wrapper.find('button[title="refresh"]').trigger("click");
    expect(wrapper.emitted("refresh-tree")).toHaveLength(1);
  });

  it("the collapse button emits update:collapsed true", async () => {
    const wrapper = mountPanel();
    await wrapper.find('button[title="sftpSide.collapse"]').trigger("click");
    expect(wrapper.emitted("update:collapsed")?.[0]).toEqual([true]);
  });

  it("collapses to the rail and the expand button emits update:collapsed false", async () => {
    const wrapper = mountPanel({ collapsed: true });
    expect(wrapper.find(".sftp-side-panel").exists()).toBe(false);
    expect(wrapper.find(".sftp-side-rail").exists()).toBe(true);
    await wrapper.find(".sftp-side-rail button").trigger("click");
    expect(wrapper.emitted("update:collapsed")?.[0]).toEqual([false]);
  });

  it("wires the tree: row click → navigate, caret click → toggle-node, right-click → node-context", async () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".sftp-tree-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    await rows[1].trigger("click"); // /var row → open ⇒ navigate(path)
    expect(wrapper.emitted("navigate")?.[0]).toEqual(["/var"]);

    await rows[1].find(".sftp-tree-caret").trigger("click");
    const toggled = wrapper.emitted("toggle-node")?.[0]?.[0] as DirTreeNode;
    expect(toggled.path).toBe("/var");

    await rows[1].trigger("contextmenu", { clientX: 40, clientY: 30 });
    expect(wrapper.emitted("node-context")?.[0]).toEqual([{ path: "/var", x: 40, y: 30 }]);
  });

  it("renders quick paths, navigates on click, marks the current one and right-click emits node-context", async () => {
    const wrapper = mountPanel({ tab: "quick", currentPath: "/srv/data" });
    const buttons = wrapper.findAll(".sftp-side-quick button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].find("span").text()).toBe("HOME_DIR");
    expect(buttons[1].classes()).toContain("is-current");
    expect(buttons[0].classes()).not.toContain("is-current");

    await buttons[0].trigger("click");
    expect(wrapper.emitted("navigate")?.[0]).toEqual(["/home/dev"]);

    await buttons[1].trigger("contextmenu", { clientX: 7, clientY: 9 });
    expect(wrapper.emitted("node-context")?.[0]).toEqual([{ path: "/srv/data", x: 7, y: 9 }]);
  });

  it("shows a home icon for home quick paths and a folder icon for the rest", () => {
    const wrapper = mountPanel({ tab: "quick" });
    const buttons = wrapper.findAll(".sftp-side-quick button");
    // lucide 的 Home 组件是 House 图标的别名，渲染类名为 lucide-house。
    expect(buttons[0].find("svg.lucide-house").exists()).toBe(true);
    expect(buttons[1].find("svg.lucide-house").exists()).toBe(false);
    expect(buttons[1].find("svg.lucide-folder").exists()).toBe(true);
  });
});
