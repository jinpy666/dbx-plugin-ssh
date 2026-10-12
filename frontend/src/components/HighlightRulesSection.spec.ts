// @vitest-environment happy-dom
// HighlightRulesSection 组件测试（M32-A2）：规则列表渲染、启停/编辑/删除上抛、
// 草稿校验（非法颜色不出 emit）、保存成功后随 rules 引用替换复位草稿；
// 关键词显示方式（全局：背景色块 / 字体颜色）的切换与 radio 语义。
import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import HighlightRulesSection from "./HighlightRulesSection.vue";
import { workbenchMessage } from "../lib/i18n";
import type { HighlightDisplayMode, HighlightRuleView } from "../lib/keywordHighlight";

const t = (key: string, values?: Record<string, string | number>) => workbenchMessage("zh-CN", key, values);

const rules: HighlightRuleView[] = [
  { id: "r1", pattern: "ERROR", color: "#ef4444", isRegex: false, caseSensitive: false, enabled: true, createdAt: 1, updatedAt: 1 },
  { id: "r2", pattern: "\\d+ms", color: "#3b82f6", isRegex: true, caseSensitive: true, enabled: false, createdAt: 2, updatedAt: 2 },
];

function mountSection(props: { rules?: HighlightRuleView[]; saving?: boolean; displayMode?: HighlightDisplayMode } = {}) {
  return mount(HighlightRulesSection, {
    props: { rules: props.rules ?? rules, saving: props.saving ?? false, limit: 30, displayMode: props.displayMode ?? "bg", t },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("HighlightRulesSection", () => {
  it("renders rules with badges and emits toggle/delete intents", async () => {
    const wrapper = mountSection();
    const rows = wrapper.findAll(".highlight-rule-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("ERROR");
    expect(rows[1].text()).toContain("regex");
    await rows[0].find('input[type="checkbox"]').setValue(false);
    expect(wrapper.emitted("toggle")![0][0]).toMatchObject({ id: "r1", enabled: true });
    await rows[1].findAll("button")[1].trigger("click");
    expect(wrapper.emitted("delete")![0][0]).toBe("r2");
  });

  it("blocks invalid drafts locally without emitting save", async () => {
    const wrapper = mountSection({ rules: [] });
    const pattern = wrapper.find(".highlight-editor-inputs input");
    await pattern.setValue("ERROR");
    const hex = wrapper.find(".highlight-hex-input");
    await hex.setValue("#zzz");
    await wrapper.find(".highlight-editor-actions .primary-button").trigger("click");
    expect(wrapper.emitted("save")).toBeUndefined();
    expect(wrapper.text()).toContain("十六进制");
  });

  it("emits sanitized save payloads and resets the draft when rules are replaced", async () => {
    const wrapper = mountSection({ rules: [] });
    await wrapper.find(".highlight-editor-inputs input").setValue("  ERROR  ");
    await wrapper.find(".highlight-editor-actions .primary-button").trigger("click");
    expect(wrapper.emitted("save")![0][0]).toEqual({ pattern: "ERROR", color: "#f59e0b", isRegex: false, caseSensitive: false });
    // 数据面在 App：保存成功 = rules 数组整体替换，组件据此清空草稿。
    await wrapper.setProps({ rules: [{ id: "r1", pattern: "ERROR", color: "#f59e0b", isRegex: false, caseSensitive: false, enabled: true, createdAt: 1, updatedAt: 1 }] });
    await flushPromises();
    expect((wrapper.find(".highlight-editor-inputs input").element as HTMLInputElement).value).toBe("");
  });

  it("emits the display mode on switch and keeps both modes GPU-safe", async () => {
    const wrapper = mountSection({ displayMode: "bg" });
    const items = wrapper.findAll(".highlight-display-mode-item");
    expect(items.map((item) => item.text())).toEqual(["背景色块", "字体颜色"]);
    // 默认背景色块 = 既有行为。
    expect(wrapper.find(".highlight-display-mode-hint").exists()).toBe(false);

    await items[1].trigger("click");
    expect(wrapper.emitted("update:displayMode")![0][0]).toBe("text");

    // 「字体颜色」同样在 GPU 渲染器下生效（decoration 的 foregroundColor 被 DOM /
    // WebGL 两条渲染路径共同消费），因此不出现任何"关闭 GPU"的降级提示。
    await wrapper.setProps({ displayMode: "text" });
    expect(wrapper.find(".highlight-display-mode-hint").exists()).toBe(false);
    // 再点已选中项：reka-ui 单选会派发空串（反选），组件按 radio 语义忽略。
    await items[1].trigger("click");
    expect(wrapper.emitted("update:displayMode")).toHaveLength(1);
    await items[0].trigger("click");
    expect(wrapper.emitted("update:displayMode")).toHaveLength(2);
    expect(wrapper.emitted("update:displayMode")![1][0]).toBe("bg");
  });
});
