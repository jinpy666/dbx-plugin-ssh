// @vitest-environment happy-dom
// TextPreview 组件测试：CodeMirror 以内联最小假实现替换（vi.mock 全部内联在本
// spec，不动生产代码）。覆盖：编辑器挂载与 doc 播种、readOnly/editable 派生、
// 编辑 → change 事件、外部 text 推送与同值短路、editable/appearance 变更重建
// （活编辑保留）、语言扩展命中/未命中/加载失败吞错、shared editorTheme 语法
// 高亮扩展注入（暗色提亮取值）、卸载销毁。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TextPreview from "./TextPreview.vue";

// ---- inline fake of the CodeMirror surface used by the component ----
const cm = vi.hoisted(() => {
  interface FakeExtension {
    kind: string;
    value?: boolean;
    listener?: (update: { docChanged: boolean; state: { doc: { toString(): string } } }) => void;
  }
  interface FakeViewConfig {
    parent: HTMLElement;
    state: { doc: string; extensions: FakeExtension[] };
  }
  interface FakeView {
    parent: HTMLElement;
    readonly doc: string;
    // 组件经 view.state.doc 读取文档（播种与 text 推送），需镜像该形状。
    readonly state: { doc: { toString(): string; readonly length: number } };
    extensions: FakeExtension[];
    editableValue: boolean;
    readOnlyValue: boolean;
    dispatchCount: number;
    destroyed: boolean;
    dispatch(tr: { changes: { from: number; to: number; insert: string } }): void;
    destroy(): void;
  }

  const views: FakeView[] = [];

  function makeView(config: FakeViewConfig): FakeView {
    const updateListeners = config.state.extensions
      .filter((ext) => ext.kind === "updateListener" && typeof ext.listener === "function")
      .map((ext) => ext.listener as (update: { docChanged: boolean; state: { doc: { toString(): string } } }) => void);
    const docRef = { value: config.state.doc };
    // 组件的 updateListener 回调读取 update.state.doc（变更后的文档状态）。
    const notifyChange = () => {
      for (const listener of updateListeners) {
        listener({ docChanged: true, state: { doc: { toString: () => docRef.value } } });
      }
    };
    const view: FakeView = {
      parent: config.parent,
      get doc() {
        return docRef.value;
      },
      get state() {
        return { doc: { toString: () => docRef.value, length: docRef.value.length } };
      },
      extensions: config.state.extensions,
      editableValue: config.state.extensions.some((ext) => ext.kind === "editable" && ext.value === true),
      readOnlyValue: config.state.extensions.some((ext) => ext.kind === "readOnly" && ext.value === true),
      dispatchCount: 0,
      destroyed: false,
      dispatch(tr) {
        docRef.value = docRef.value.slice(0, tr.changes.from) + tr.changes.insert + docRef.value.slice(tr.changes.to);
        view.dispatchCount += 1;
        notifyChange();
      },
      destroy() {
        view.destroyed = true;
      },
    };
    views.push(view);
    return view;
  }

  class FakeEditorView {
    static theme = () => ({ kind: "theme" });
    static editable = { of: (value: boolean) => ({ kind: "editable", value }) };
    static lineWrapping = { kind: "lineWrapping" };
    static updateListener = {
      of: (listener: (update: { docChanged: boolean; state: { doc: { toString(): string } } }) => void) => ({
        kind: "updateListener",
        listener,
      }),
    };
    constructor(config: FakeViewConfig) {
      return makeView(config);
    }
  }

  return { views, makeView, FakeEditorView };
});

vi.mock("codemirror", () => ({ basicSetup: { kind: "basicSetup" } }));

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: (config: { doc: string; extensions?: unknown[] }) => ({ doc: config.doc, extensions: config.extensions ?? [] }),
    readOnly: { of: (value: boolean) => ({ kind: "readOnly", value }) },
  },
}));

vi.mock("@codemirror/view", () => ({ EditorView: cm.FakeEditorView }));

// .js 命中语言 → 加载成功；.md 命中但加载失败（吞错路径）；其余不命中。
// HighlightStyle/syntaxHighlighting 为 shared editorTheme 高亮注入的运行时，
// 假实现保留 spec 数据供扩展注入断言。
vi.mock("@codemirror/language", () => ({
  HighlightStyle: {
    define: (specs: readonly { tag: unknown; color?: string }[]) => ({ kind: "highlightStyle", specs }),
  },
  syntaxHighlighting: (style: unknown) => ({ kind: "syntaxHighlighting", style }),
  LanguageDescription: {
    matchFilename: (_languages: unknown, filename: string) => {
      if (filename.endsWith(".js")) return { load: async () => ({ kind: "languageSupport" }) };
      if (filename.endsWith(".md")) {
        return {
          load: async () => {
            throw new Error("language payload unavailable in tests");
          },
        };
      }
      return undefined;
    },
  },
}));

vi.mock("@codemirror/language-data", () => ({ languages: [{ name: "JavaScript" }] }));

// tags 仅作成员占位（shared editorTheme 按成员名解析，名称即可命中断言）。
vi.mock("@lezer/highlight", () => ({
  tags: new Proxy({}, { get: (_target, name) => ({ name: String(name) }) }),
}));

// ---- fixtures ----
function appearance(scheme: "light" | "dark" = "light"): DbxPluginAppearance {
  return {
    colorScheme: scheme,
    colors: {
      background: "#101010",
      foreground: "#eeeeee",
      muted: "#1a1a1a",
      mutedForeground: "#9a9a9a",
      accent: "#223344",
      accentForeground: "#ffffff",
      border: "#333333",
      destructive: "#ff4444",
    },
    terminal: { fontFamily: "monospace", fontSize: 12 },
  };
}

async function mountPreview(props: { text?: string; fileName?: string; appearance?: DbxPluginAppearance; editable?: boolean } = {}) {
  const wrapper = mount(TextPreview, {
    props: {
      text: props.text ?? "hello",
      fileName: props.fileName ?? "notes.txt",
      appearance: props.appearance ?? appearance(),
      editable: props.editable,
    },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  cm.views.length = 0;
});

describe("TextPreview", () => {
  it("creates the editor inside .preview-editor and seeds it with props.text", async () => {
    const wrapper = await mountPreview({ text: "const a = 1;" });
    expect(wrapper.find(".preview-editor").exists()).toBe(true);
    expect(cm.views).toHaveLength(1);
    expect(cm.views[0].doc).toBe("const a = 1;");
    expect(cm.views[0].parent).toBe(wrapper.find(".preview-editor").element);
  });

  it("is read-only by default and becomes editable only with editable=true", async () => {
    await mountPreview();
    expect(cm.views[0].readOnlyValue).toBe(true);
    expect(cm.views[0].editableValue).toBe(false);

    await mountPreview({ editable: true });
    expect(cm.views[1].readOnlyValue).toBe(false);
    expect(cm.views[1].editableValue).toBe(true);
  });

  it("emits change with the full document after each editor edit", async () => {
    const wrapper = await mountPreview({ text: "abc" });
    cm.views[0].dispatch({ changes: { from: 3, to: 3, insert: "def" } });
    expect(wrapper.emitted("change")?.[0]).toEqual(["abcdef"]);
    cm.views[0].dispatch({ changes: { from: 0, to: 3, insert: "XYZ" } });
    expect(wrapper.emitted("change")?.[1]).toEqual(["XYZdef"]);
  });

  it("pushes external text prop changes into the live editor", async () => {
    const wrapper = await mountPreview({ text: "v1" });
    await wrapper.setProps({ text: "v2-longer" });
    expect(cm.views[0].doc).toBe("v2-longer");
    expect(cm.views[0].dispatchCount).toBe(1);
  });

  it("skips the dispatch when the text prop equals the live document", async () => {
    const wrapper = await mountPreview({ text: "same" });
    await wrapper.setProps({ text: "same" });
    expect(cm.views[0].dispatchCount).toBe(0);
  });

  it("re-creates on editable change while keeping live edits and destroying the old view", async () => {
    const wrapper = await mountPreview({ text: "seed" });
    cm.views[0].dispatch({ changes: { from: 4, to: 4, insert: " + edit" } });
    expect(cm.views[0].doc).toBe("seed + edit");

    await wrapper.setProps({ editable: true });
    await flushPromises();
    expect(cm.views).toHaveLength(2);
    expect(cm.views[0].destroyed).toBe(true);
    expect(cm.views[1].doc).toBe("seed + edit");
    expect(cm.views[1].editableValue).toBe(true);
  });

  it("re-creates the editor when the appearance (theme) changes", async () => {
    const wrapper = await mountPreview();
    await wrapper.setProps({ appearance: appearance("dark") });
    await flushPromises();
    expect(cm.views).toHaveLength(2);
    expect(cm.views[0].destroyed).toBe(true);
  });

  it("injects the shared editorTheme highlight extension with brightened dark tokens", async () => {
    // 暗色挂载：basicSetup 之后必须追加 syntaxHighlighting 扩展（覆盖内置浅色
    // defaultHighlightStyle），且关键字取提亮后的调色板值。
    await mountPreview({ fileName: "script.js", appearance: appearance("dark") });
    const highlight = cm.views[0].extensions.find((ext) => ext.kind === "syntaxHighlighting") as
      | { style: { specs: Array<{ tag: { name: string }; color?: string }> } }
      | undefined;
    expect(highlight).toBeDefined();
    const keywordSpec = highlight!.style.specs.find((spec) => spec.tag.name === "keyword");
    expect(keywordSpec?.color).toBe("#4fc1ff");
    // 修饰器组合 tag（函数调用名）同样解析注入
    const functionSpec = highlight!.style.specs.find((spec) => spec.tag.name === "function(variableName)");
    expect(functionSpec?.color).toBe("#d2a8ff");

    // 浅色挂载：关键字回到 Light+ 同源取值
    await mountPreview({ fileName: "script.js" });
    const lightHighlight = cm.views[1].extensions.find((ext) => ext.kind === "syntaxHighlighting") as
      | { style: { specs: Array<{ tag: { name: string }; color?: string }> } }
      | undefined;
    expect(lightHighlight?.style.specs.find((spec) => spec.tag.name === "keyword")?.color).toBe("#0000ff");
  });

  it("adds language support for matched files, swallows loader failures and skips unmatched files", async () => {
    await mountPreview({ fileName: "script.js" });
    expect(cm.views[0].extensions.some((ext) => ext.kind === "languageSupport")).toBe(true);

    // 命中 .md 但 load 抛错 → 组件吞错，不添加 support、不阻断挂载。
    await mountPreview({ fileName: "README.md" });
    expect(cm.views[1].extensions.some((ext) => ext.kind === "languageSupport")).toBe(false);

    await mountPreview({ fileName: "data.txt" });
    expect(cm.views[2].extensions.some((ext) => ext.kind === "languageSupport")).toBe(false);

    // fileName 变更同样触发重建并重新解析语言（3 次挂载 + 本次挂载 + setProps 共 5 个 view）。
    const wrapper = await mountPreview({ fileName: "data.txt" });
    await wrapper.setProps({ fileName: "script.js" });
    await flushPromises();
    expect(cm.views).toHaveLength(5);
    expect(cm.views[4].extensions.some((ext) => ext.kind === "languageSupport")).toBe(true);
  });

  it("destroys the editor on unmount", async () => {
    const wrapper = await mountPreview();
    wrapper.unmount();
    expect(cm.views[0].destroyed).toBe(true);
  });
});
