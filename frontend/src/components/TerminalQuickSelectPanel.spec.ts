// @vitest-environment happy-dom
// TerminalQuickSelectPanel 组件测试（WT-1）：标题计数、逐项渲染（类别徽标 + 文本）、
// 点击复制、悬停/按下激活、关闭按钮、空态文案。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TerminalQuickSelectPanel from "./TerminalQuickSelectPanel.vue";
import type { QuickSelectHit } from "../lib/quickSelect";

const hits: QuickSelectHit[] = [
  { kind: "url", text: "https://example.com/a", row: 0, col: 4 },
  { kind: "ipv4", text: "10.0.0.1", row: 1, col: 5 },
  { kind: "path", text: "/var/log/app.log", row: 2, col: 0 },
];

function mountPanel(props: { hits?: QuickSelectHit[]; activeIndex?: number; locale?: string } = {}) {
  return mount(TerminalQuickSelectPanel, {
    props: { locale: "en", hits, activeIndex: 0, ...props },
  });
}

describe("TerminalQuickSelectPanel", () => {
  it("renders the title with a match count for the en locale", () => {
    const wrapper = mountPanel();
    expect(wrapper.find(".terminal-quick-select-title").text()).toBe("Quick select · 3 matches");
    expect(wrapper.find(".terminal-quick-select").attributes("aria-label")).toBe("Quick select");
  });

  it("renders one entry per hit with its kind label", () => {
    const wrapper = mountPanel();
    const rows = wrapper.findAll(".terminal-quick-select-hit");
    expect(rows).toHaveLength(3);
    expect(rows[0].find(".terminal-quick-select-kind").text()).toBe("URL");
    expect(rows[1].find(".terminal-quick-select-kind").text()).toBe("IP");
    expect(rows[2].find(".terminal-quick-select-kind").text()).toBe("Path");
    expect(rows[1].find(".terminal-quick-select-text").text()).toBe("10.0.0.1");
  });

  it("clicking an entry emits copy with the hit", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".terminal-quick-select-hit")[2].trigger("click");
    expect(wrapper.emitted("copy")?.[0]).toEqual([hits[2]]);
  });

  it("mousedown activates without moving focus; mouseenter previews", async () => {
    const wrapper = mountPanel();
    const second = wrapper.findAll(".terminal-quick-select-hit")[1];
    await second.trigger("mousedown");
    expect(wrapper.emitted("activate")?.[0]).toEqual([1]);
    await second.trigger("mouseenter");
    expect(wrapper.emitted("activate")?.[1]).toEqual([1]);
    expect(second.classes()).not.toContain("active");
    // 激活态由父层 activeIndex 驱动。
    wrapper.setProps({ activeIndex: 1 });
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll(".terminal-quick-select-hit")[1].classes()).toContain("active");
  });

  it("the close button emits close", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".terminal-quick-select-btn").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("shows the empty state without a list or hint", () => {
    const wrapper = mountPanel({ hits: [] });
    expect(wrapper.find(".terminal-quick-select-empty").text()).toBe("No URLs, paths, IPs or hashes on screen");
    expect(wrapper.find(".terminal-quick-select-list").exists()).toBe(false);
    expect(wrapper.find(".terminal-quick-select-hint").exists()).toBe(false);
    expect(wrapper.find(".terminal-quick-select-title").text()).toBe("Quick select");
  });
});
