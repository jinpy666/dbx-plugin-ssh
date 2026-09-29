// @vitest-environment happy-dom
// TerminalHistoryPanel 组件测试：标题计数、逐条渲染（提示符图标 + 命令文本 +
// 相对时间）、点击回填、悬停/按下激活（悬停武装）、关闭按钮、空态、锚点降级
// 与 Warp 版式（全宽、bottom 贴输入行上方）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TerminalHistoryPanel from "./TerminalHistoryPanel.vue";
import type { HistoryPanelEntry } from "../lib/historyPanel";

const NOW = Date.now();
const entries: HistoryPanelEntry[] = [
  { command: "kubectl get pods -n prod", ts: NOW - 120_000 },
  { command: "tail -f /var/log/syslog", ts: NOW - 3 * 3_600_000 },
  { command: "git status", ts: null },
];
const anchor = { x: 40, y: 300, cellHeight: 17, cellWidth: 8 };

function mountPanel(props: { entries?: HistoryPanelEntry[]; activeIndex?: number; anchor?: typeof anchor | null; viewport?: { height: number } } = {}) {
  return mount(TerminalHistoryPanel, {
    props: { locale: "en", entries, activeIndex: 0, anchor, ...props },
  });
}

describe("TerminalHistoryPanel", () => {
  it("renders the title with an entry count for the en locale", () => {
    const wrapper = mountPanel();
    expect(wrapper.find(".terminal-history-title").text()).toBe("Command history · 3 entries");
    expect(wrapper.find(".terminal-history-panel").attributes("aria-label")).toBe("Command history");
  });

  it("renders one row per entry with prompt icon, command text and relative age", () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".terminal-history-hit");
    expect(rows).toHaveLength(3);
    expect(rows[0].find(".terminal-history-command").text()).toBe("kubectl get pods -n prod");
    expect(rows[0].find(".terminal-history-prompt").exists()).toBe(true);
    expect(rows[0].find(".terminal-history-age").text()).toBe("2 min ago");
    expect(rows[1].find(".terminal-history-age").text()).toBe("3 h ago");
    // 无时间戳（旧数据）不渲染时间占位。
    expect(rows[2].find(".terminal-history-age").exists()).toBe(false);
    expect(rows[0].classes()).toContain("mono");
  });

  it("clicking an entry emits select with the command text", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".terminal-history-hit")[1].trigger("click");
    expect(wrapper.emitted("select")?.[0]).toEqual(["tail -f /var/log/syslog"]);
  });

  it("mousedown activates without moving focus; pointermove-armed hover activates", async () => {
    const wrapper = mountPanel();
    const second = wrapper.findAll(".terminal-history-hit")[1];
    await second.trigger("mousedown");
    expect(wrapper.emitted("activate")?.[0]).toEqual([1]);
    // 悬停武装：指针未移动过时静止 hover 不抢选。
    await second.trigger("mouseenter");
    expect(wrapper.emitted("activate")).toHaveLength(1);
    await wrapper.find(".terminal-history-panel").trigger("pointermove");
    await second.trigger("mouseenter");
    expect(wrapper.emitted("activate")?.[1]).toEqual([1]);
    // 激活态由父层 activeIndex 驱动。
    wrapper.setProps({ activeIndex: 1 });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".terminal-history-hit")[1].classes()).toContain("active");
  });

  it("the close button emits close", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".terminal-history-btn").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("renders the kbd hint chips", () => {
    const wrapper = mountPanel();
    const chips = wrapper.findAll(".terminal-history-hint kbd");
    expect(chips.map((chip) => chip.text())).toEqual(["↑", "↓", "Enter", "Esc"]);
  });

  it("shows the empty state without a list or hint", () => {
    const wrapper = mountPanel({ entries: [] });
    expect(wrapper.find(".terminal-history-empty").text()).toBe("No matching commands in history");
    expect(wrapper.find(".terminal-history-list").exists()).toBe(false);
    expect(wrapper.find(".terminal-history-hint").exists()).toBe(false);
    expect(wrapper.find(".terminal-history-title").text()).toBe("Command history");
  });

  it("marks the anchor fallback when no cursor anchor is available", () => {
    const wrapper = mountPanel({ anchor: null });
    expect(wrapper.find(".terminal-history-panel").classes()).toContain("anchor-fallback");
    expect(wrapper.find(".terminal-history-panel").attributes("style")).toBeUndefined();
  });

  it("expands upward from the row above the input line (Warp 版式，全宽无 left)", () => {
    const wrapper = mountPanel({ anchor, viewport: { height: 600 } });
    const style = wrapper.find(".terminal-history-panel").attributes("style") ?? "";
    // 底边贴光标行顶：bottom = viewportHeight - anchorY + gap = 600 - 300 + 6。
    expect(style).toContain("bottom: 306px");
    // 全宽版式：水平定位归 CSS（left/right 8px），内联样式不再携带 left。
    expect(style).not.toContain("left");
  });
});
