// @vitest-environment happy-dom
// TerminalSearchPanel 组件测试：输入即查、prev/next/close 按钮、Aa|.*\|w\| 三个
// 开关（data-state=on / aria-pressed / 持久化 pluginStore / 触发重查）、Enter 与
// Shift+Enter、Esc 关闭、空查询 clear、挂载聚焦 + 选区种子即查、match/no-match 状态文案。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import TerminalSearchPanel from "./TerminalSearchPanel.vue";
import { TERMINAL_SEARCH_OPTIONS_KEY, type TerminalSearchOptions } from "../lib/terminalInteraction";
import { pluginStore } from "../lib/pluginStore";

const baseProps = {
  locale: "en",
  matchState: "idle" as "idle" | "match" | "no-match",
  resultIndex: 0,
  resultCount: 0,
};

// 行内三个圆钮按 DOM 顺序为 prev / next / close；选项开关为 Aa / .* / |w|。
function mountPanel(props: Partial<typeof baseProps & { initialQuery: string; initialOptions: TerminalSearchOptions }> = {}) {
  return mount(TerminalSearchPanel, { props: { ...baseProps, ...props } });
}

function toggleButtons(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll(".terminal-search-toggles button");
}

beforeEach(() => {
  // 搜索选项键已迁 pluginStore（happy-dom 下导入时即完成水合，通道为
  // localStorage）：播种/清理/断言必须走 store 实例，直接改全局
  // localStorage 读不到缓存值。
  pluginStore.removeItem(TERMINAL_SEARCH_OPTIONS_KEY);
});

describe("TerminalSearchPanel", () => {
  it("renders the search input with the en placeholder and focuses it on mount", () => {
    // 默认挂载不在文档树内，聚焦需 attachTo 后才能通过 document.activeElement 断言。
    const wrapper = mount(TerminalSearchPanel, { props: { ...baseProps }, attachTo: document.body });
    const input = wrapper.find(".terminal-search-input");
    expect(input.exists()).toBe(true);
    expect(input.attributes("placeholder")).toBe("Search…");
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it("runs an immediate search when opened with a selection seed query", () => {
    const wrapper = mountPanel({ initialQuery: "error" });
    expect(wrapper.emitted("findNext")?.[0]).toEqual(["error", { caseSensitive: false, regex: false, wholeWord: false }]);
  });

  it("typing in the input emits findNext with the query and current options", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".terminal-search-input").setValue("pattern");
    expect(wrapper.emitted("findNext")?.[0]).toEqual(["pattern", { caseSensitive: false, regex: false, wholeWord: false }]);
  });

  it("emptying the query emits clear instead of a search", async () => {
    const wrapper = mountPanel({ initialQuery: "gone" });
    // 选区种子在挂载时已触发一次查找。
    expect(wrapper.emitted("findNext")).toHaveLength(1);
    await wrapper.find(".terminal-search-input").setValue("");
    expect(wrapper.emitted("clear")).toHaveLength(1);
    expect(wrapper.emitted("findNext")).toHaveLength(1);
  });

  it("the prev / next buttons emit findPrevious / findNext", async () => {
    const wrapper = mountPanel({ initialQuery: "x" });
    const buttons = wrapper.findAll(".terminal-search-row .terminal-search-btn");
    expect(buttons).toHaveLength(3); // prev, next, close
    await buttons[1].trigger("click"); // next
    await buttons[0].trigger("click"); // prev
    expect(wrapper.emitted("findNext")?.at(-1)?.[0]).toBe("x");
    expect(wrapper.emitted("findPrevious")?.[0]).toEqual(["x", { caseSensitive: false, regex: false, wholeWord: false }]);
  });

  it("the close button emits close", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".terminal-search-row .terminal-search-btn:last-child").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("an empty query keeps prev/next as no-ops that only emit clear", async () => {
    const wrapper = mountPanel();
    const buttons = wrapper.findAll(".terminal-search-row .terminal-search-btn");
    await buttons[1].trigger("click");
    expect(wrapper.emitted("clear")).toHaveLength(1);
    expect(wrapper.emitted("findNext")).toBeUndefined();
    expect(wrapper.emitted("findPrevious")).toBeUndefined();
  });

  it("Enter searches next, Shift+Enter searches previous, Escape closes", async () => {
    const wrapper = mountPanel({ initialQuery: "key" });
    const input = wrapper.find(".terminal-search-input");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("findNext")?.at(-1)?.[0]).toBe("key");
    await input.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("findPrevious")).toHaveLength(1);
    await input.trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("the case toggle activates, persists and re-runs the search with caseSensitive on", async () => {
    const wrapper = mountPanel({ initialQuery: "Aa" });
    const caseToggle = toggleButtons(wrapper)[0];
    expect(caseToggle.text()).toBe("Aa");
    await caseToggle.trigger("click");
    expect(caseToggle.attributes("data-state")).toBe("on");
    expect(caseToggle.attributes("aria-pressed")).toBe("true");
    expect(wrapper.emitted("findNext")?.at(-1)).toEqual(["Aa", { caseSensitive: true, regex: false, wholeWord: false }]);
    expect(JSON.parse(pluginStore.getItem(TERMINAL_SEARCH_OPTIONS_KEY) ?? "{}")).toEqual({
      caseSensitive: true,
      regex: false,
      wholeWord: false,
    });
  });

  it("the regex and whole-word toggles persist their state and re-run the search", async () => {
    const wrapper = mountPanel({ initialQuery: "a.*b" });
    const toggles = toggleButtons(wrapper);
    expect(toggles[1].text()).toBe(".*");
    expect(toggles[2].text()).toBe("|w|");
    await toggles[1].trigger("click");
    await toggles[2].trigger("click");
    expect(wrapper.emitted("findNext")?.at(-1)).toEqual(["a.*b", { caseSensitive: false, regex: true, wholeWord: true }]);
    expect(JSON.parse(pluginStore.getItem(TERMINAL_SEARCH_OPTIONS_KEY) ?? "{}")).toEqual({
      caseSensitive: false,
      regex: true,
      wholeWord: true,
    });
  });

  it("seeds the toggles from persisted initialOptions without touching storage on mount", () => {
    pluginStore.setItem(TERMINAL_SEARCH_OPTIONS_KEY, JSON.stringify({ caseSensitive: true, regex: true, wholeWord: false }));
    const wrapper = mountPanel({ initialOptions: { caseSensitive: true, regex: true, wholeWord: false } });
    const [caseToggle, regexToggle, wordToggle] = toggleButtons(wrapper);
    expect(caseToggle.attributes("data-state")).toBe("on");
    expect(regexToggle.attributes("data-state")).toBe("on");
    expect(wordToggle.attributes("data-state")).toBe("off");
    // Toggles already in their stored state → no watch fires → storage untouched.
    expect(wrapper.emitted("findNext")).toBeUndefined();
  });

  it("toggling with an empty query persists without emitting a search", async () => {
    const wrapper = mountPanel();
    await toggleButtons(wrapper)[0].trigger("click");
    expect(wrapper.emitted("findNext")).toBeUndefined();
    expect(JSON.parse(pluginStore.getItem(TERMINAL_SEARCH_OPTIONS_KEY) ?? "{}").caseSensitive).toBe(true);
  });

  it("shows 'No matches' with a destructive data-state when nothing matched", () => {
    const wrapper = mountPanel({ initialQuery: "zzz", matchState: "no-match" });
    const status = wrapper.find(".terminal-search-status");
    expect(status.text()).toBe("No matches");
    expect(status.attributes("data-state")).toBe("no-match");
  });

  it("shows the current match index while matches exist", () => {
    const wrapper = mountPanel({ initialQuery: "hit", matchState: "match", resultIndex: 1, resultCount: 3 });
    const status = wrapper.find(".terminal-search-status");
    expect(status.text()).toBe("1/3");
    expect(status.attributes("data-state")).toBe("match");
  });

  it("keeps the status empty in the idle state", () => {
    const wrapper = mountPanel();
    expect(wrapper.find(".terminal-search-status").text()).toBe("");
  });
});
