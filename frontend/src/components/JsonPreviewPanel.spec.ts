// @vitest-environment happy-dom
// JsonPreviewPanel 组件测试：格式化/原始切换、字段搜索过滤、复制交互（值/路径/
// 整篇）与降级提示条。TextPreview（CodeMirror）用轻量 stub 替换——raw 视图仅验证
// "渲染了原始文本载体"，不重复 TextPreview.spec 的编辑器语义。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import JsonPreviewPanel from "./JsonPreviewPanel.vue";
import { buildJsonPreview, type JsonPreviewState } from "../lib/jsonPreview";

const SAMPLE = '{"name":"dbx","user":{"tags":["ops"]},"port":22}';

const okState: JsonPreviewState = buildJsonPreview("sample.json", SAMPLE);
if (okState.kind !== "ok") throw new Error("fixture must parse");

const appearance: DbxPluginAppearance = {
  colorScheme: "light",
  colors: { background: "#fff", foreground: "#111", muted: "#eee", mutedForeground: "#666", accent: "#ddf", accentForeground: "#111", border: "#ccc", destructive: "#c00" },
  terminal: { fontFamily: "monospace", fontSize: 12 },
};

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

// raw 视图复用 TextPreview（CodeMirror）：stub 成纯 div，仅验证"原始文本载体渲染"。
const textPreviewStub = {
  props: ["text", "fileName", "appearance", "editable"],
  template: '<div class="text-preview-stub">{{ text }}</div>',
};

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(JsonPreviewPanel, {
    props: { state: okState, text: SAMPLE, fileName: "sample.json", locale: "en", appearance, ...props },
    global: { stubs: { TextPreview: textPreviewStub } },
  });
}

function rowPaths(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll(".json-field-path").map((node) => node.text());
}

beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  // 组件以 window.dbxPlugin?.clipboard 为首选桥；测试环境保持 undefined → 走 nativeClipboard。
  Reflect.deleteProperty(window, "dbxPlugin");
});

describe("JsonPreviewPanel", () => {
  it("renders pretty text and flattened field rows in formatted mode", () => {
    const wrapper = mountPanel();
    expect(wrapper.find(".json-preview-text").text()).toContain('"name": "dbx"');
    expect(rowPaths(wrapper)).toEqual(["$.name", "$.user.tags[0]", "$.port"]);
    expect(wrapper.find(".json-preview-count").text()).toContain("3/3");
  });

  it("filters field rows by search query (path or value)", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".json-preview-search input").setValue("ops");
    expect(rowPaths(wrapper)).toEqual(["$.user.tags[0]"]);
    expect(wrapper.find(".json-preview-count").text()).toContain("1/3");
    await wrapper.find(".json-preview-search input").setValue("no-such-key");
    expect(rowPaths(wrapper)).toEqual([]);
    expect(wrapper.find(".json-preview-empty").text()).toBe("No matching fields");
  });

  it("copies the full value to the clipboard and flashes inline feedback", async () => {
    const wrapper = mountPanel();
    const firstRow = wrapper.find(".json-field-row");
    await firstRow.findAll("button")[1].trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("dbx");
    expect(firstRow.findAll("button")[1].find(".json-preview-copied").exists()).toBe(true);
  });

  it("copies the JSONPath of a field", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".json-field-row")[1].findAll("button")[0].trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("$.user.tags[0]");
  });

  it("copies the whole document — pretty in formatted mode, raw text in raw mode", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".json-preview-copy-all").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(okState.pretty);
    // reka ToggleGroup（无 portal，happy-dom 可交互）：点原始项切换视图。
    const rawItem = wrapper.findAll('[data-slot="toggle-group-item"]').find((node) => node.text() === "Raw");
    expect(rawItem).toBeTruthy();
    await rawItem!.trigger("click");
    expect(wrapper.find(".json-preview-fields").exists()).toBe(false);
    await wrapper.find(".json-preview-copy-all").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(SAMPLE);
  });

  it("keeps the raw TextPreview view under the raw toggle", async () => {
    const wrapper = mountPanel();
    const rawItem = wrapper.findAll('[data-slot="toggle-group-item"]').find((node) => node.text() === "Raw");
    await rawItem!.trigger("click");
    expect(wrapper.find(".text-preview-stub").exists()).toBe(true);
    expect(wrapper.find(".text-preview-stub").text()).toBe(SAMPLE);
  });

  it("shows a hint and only the raw view when content is not valid JSON", () => {
    const wrapper = mountPanel({ state: { kind: "invalid" } as JsonPreviewState });
    expect(wrapper.find(".json-preview-hint").text()).toBe("Content is not valid JSON — showing the raw text");
    expect(wrapper.find('[data-slot="toggle-group-item"]').exists()).toBe(false);
    expect(wrapper.find(".json-preview-fields").exists()).toBe(false);
    expect(wrapper.find(".text-preview-stub").exists()).toBe(true);
  });

  it("shows the too-large hint for truncated or oversized content", () => {
    const wrapper = mountPanel({ state: { kind: "too-large" } as JsonPreviewState });
    expect(wrapper.find(".json-preview-hint").text()).toBe("Content exceeds the JSON preview limit — showing the raw text only");
    expect(wrapper.find(".text-preview-stub").exists()).toBe(true);
  });

  it("resets the search query when the underlying file text changes", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".json-preview-search input").setValue("ops");
    await wrapper.setProps({ text: '{"other":1}', state: buildJsonPreview("sample.json", '{"other":1}') });
    expect((wrapper.find(".json-preview-search input").element as HTMLInputElement).value).toBe("");
  });
});
