// @vitest-environment happy-dom
// ImportWizard 组件测试：来源选择进入第二步、文件读取为 base64、解析预览
// 与全选/勾选、WindTerm「需要主密码」契约错误的可读展示、commit 参数与
// 结果计数提示（含「保存在插件本机」注记）、重新开始。Dialog 不涉及，直接
// 查询 wrapper；文件选择用 input.files 打桩触发 change。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ImportWizard from "./ImportWizard.vue";

// t 假实现：key 原样返回、参数拼在括号里，断言与 i18n 表解耦。
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

function installInvoke(invoke: (method: string, params?: Record<string, unknown>) => unknown) {
  const spy = vi.fn(async (method: string, params?: Record<string, unknown>) => invoke(method, params));
  (window as unknown as { dbxPlugin: unknown }).dbxPlugin = { invoke: spy };
  return spy;
}

function mountWizard() {
  return mount(ImportWizard, { props: { t } });
}

function setFiles(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const PREVIEW = {
  sessions: [
    { index: 0, name: "web-1", host: "10.0.0.1", port: 22, username: "dev", groupPath: "Prod/Web", description: "", authKind: "password", hasSecret: true },
    { index: 1, name: "db-1", host: "10.0.0.2", port: 2222, username: "ops", groupPath: "Prod/DB", description: "primary", authKind: "publickey", hasSecret: false },
  ],
};

async function reachPreviewStep(wrapper: ReturnType<typeof mount>, invokeSpy: ReturnType<typeof vi.fn>) {
  // 第一步：选 MobaXterm 来源 → 第二步。
  await wrapper.findAll(".import-source").at(0)!.trigger("click");
  const input = wrapper.find<HTMLInputElement>("input[type=file]");
  setFiles(input.element, new File(["moba-export"], "sessions.mxtsessions", { type: "text/plain" }));
  await flushPromises();
  // 第二步：解析 → 第三步预览。
  await wrapper.find(".import-nav .primary-button").trigger("click");
  await flushPromises();
  expect(invokeSpy).toHaveBeenCalledWith("import/parse", { kind: "moba", fileBase64: btoa("moba-export") });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ImportWizard", () => {
  it("starts at step 1 and moves to the file step after choosing a source", async () => {
    installInvoke(() => ({ sessions: [] }));
    const wrapper = mountWizard();
    expect(wrapper.text()).toContain("importWizard.step(current=1)");
    expect(wrapper.text()).toContain("importWizard.storageNote");
    await wrapper.findAll(".import-source").at(1)!.trigger("click");
    expect(wrapper.text()).toContain("importWizard.step(current=2)");
    expect(wrapper.text()).toContain("importWizard.source.xshell");
  });

  it("parses the picked file into a selectable preview table", async () => {
    const invokeSpy = installInvoke((method) => (method === "import/parse" ? PREVIEW : {}));
    const wrapper = mountWizard();
    await reachPreviewStep(wrapper, invokeSpy);
    expect(wrapper.text()).toContain("importWizard.step(current=3)");
    const rows = wrapper.findAll(".import-table tbody tr");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("web-1");
    expect(wrapper.text()).toContain("10.0.0.1:22");
    expect(wrapper.text()).toContain("importWizard.selectedCount(count=2)");
    // 预览只回脱敏字段，不出现任何明文凭据列。
    expect(wrapper.find(".import-table").text()).not.toContain("password=");
  });

  it("supports select-all/clear and commits only checked indexes, then shows the result with the storage note", async () => {
    const invokeSpy = installInvoke((method) => {
      if (method === "import/parse") return PREVIEW;
      if (method === "import/commit") return { imported: 1, skipped: 0 };
      return {};
    });
    const wrapper = mountWizard();
    await reachPreviewStep(wrapper, invokeSpy);
    // 取消第一行，只提交第二行。
    const checkboxes = wrapper.findAll(".import-table tbody input[type=checkbox]");
    await checkboxes[0].setValue(false);
    expect(wrapper.text()).toContain("importWizard.selectedCount(count=1)");
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(invokeSpy).toHaveBeenCalledWith("import/commit", {
      kind: "moba",
      fileBase64: btoa("moba-export"),
      selectedIndexes: [1],
    });
    expect(wrapper.text()).toContain("importWizard.result(imported=1,skipped=0)");
    expect(wrapper.text()).toContain("importWizard.storageNote");
    // 已导入的行从预览移除，仅剩未选中的行。
    expect(wrapper.findAll(".import-table tbody tr")).toHaveLength(1);
  });

  it("maps the WindTerm master-password contract error to a readable hint", async () => {
    const invokeSpy = installInvoke((method) => {
      if (method === "import/parse") throw new Error("WindTerm master password is required");
      return {};
    });
    const wrapper = mountWizard();
    // 选 WindTerm 来源。
    await wrapper.findAll(".import-source").at(2)!.trigger("click");
    expect(wrapper.text()).toContain("importWizard.masterPassword");
    const input = wrapper.find<HTMLInputElement>("input[type=file]");
    setFiles(input.element, new File(["windterm-export"], "sessions.sessions", { type: "text/plain" }));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(invokeSpy).toHaveBeenCalledWith("import/parse", expect.objectContaining({ kind: "windterm" }));
    expect(wrapper.text()).toContain("importWizard.needMasterPassword");
    // 主密码只在填写时随参数携带。
    expect(invokeSpy.mock.calls[0][1]).not.toHaveProperty("masterPassword");
  });

  it("shows a readable failure for other parse errors and keeps the file state", async () => {
    installInvoke(() => {
      throw new Error("bad magic bytes");
    });
    const wrapper = mountWizard();
    await wrapper.findAll(".import-source").at(0)!.trigger("click");
    setFiles(wrapper.find<HTMLInputElement>("input[type=file]").element, new File(["junk"], "sessions.mxtsessions", { type: "text/plain" }));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("importWizard.parseFailed(error=bad magic bytes)");
    // 回到第一步再回来，状态已重置。
    await wrapper.findAll(".import-nav button").at(0)!.trigger("click");
    expect(wrapper.text()).toContain("importWizard.step(current=1)");
  });

  it("restarts cleanly from the preview step", async () => {
    const invokeSpy = installInvoke((method) => (method === "import/parse" ? PREVIEW : {}));
    const wrapper = mountWizard();
    await reachPreviewStep(wrapper, invokeSpy);
    const buttons = wrapper.findAll(".import-nav button");
    await buttons.at(buttons.length - 1)!.trigger("click");
    expect(wrapper.text()).toContain("importWizard.step(current=1)");
    // 重新进入第二步：文件态已清空，解析按钮不可用。
    await wrapper.findAll(".import-source").at(0)!.trigger("click");
    expect(wrapper.text()).not.toContain("importWizard.fileChosen");
    expect(wrapper.find(".import-nav .primary-button").attributes("disabled")).toBeDefined();
  });

  it("lists the seven sources and shows the FinalShell zip hint on step 2", async () => {
    installInvoke(() => ({ sessions: [] }));
    const wrapper = mountWizard();
    expect(wrapper.findAll(".import-source")).toHaveLength(7);
    // 第 5 张卡是 FinalShell：进入第二步后展示 zip 打包提示。
    await wrapper.findAll(".import-source").at(4)!.trigger("click");
    expect(wrapper.text()).toContain("importWizard.source.finalshell");
    expect(wrapper.text()).toContain("importWizard.source.finalshellHint");
  });

  it("sends the SecureCRT kind and renders the secret-note flag and banner", async () => {
    const noted = {
      sessions: [
        {
          index: 0,
          name: "fw",
          host: "10.0.0.9",
          port: 22,
          username: "root",
          groupPath: "",
          description: "",
          authKind: "password",
          hasSecret: false,
          secretNote: "encrypted",
        },
      ],
    };
    const invokeSpy = installInvoke((method) => (method === "import/parse" ? noted : {}));
    const wrapper = mountWizard();
    // 第 4 张卡是 SecureCRT。
    await wrapper.findAll(".import-source").at(3)!.trigger("click");
    const input = wrapper.find<HTMLInputElement>("input[type=file]");
    setFiles(input.element, new File(["<xml/>"], "sessions.xml", { type: "text/xml" }));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(invokeSpy).toHaveBeenCalledWith("import/parse", {
      kind: "securecrt",
      fileBase64: btoa("<xml/>"),
    });
    // 无凭据材料的行带 • 标记与原因文案，表格上方显示整体横幅。
    expect(wrapper.text()).toContain("importWizard.notesBanner");
    expect(wrapper.find(".import-secret-flag").attributes("title")).toBe(
      "importWizard.note.encrypted",
    );
  });

  it("parses the Electerm and Termius sources with their kinds", async () => {
    const invokeSpy = installInvoke(() => ({ sessions: [] }));
    const wrapper = mountWizard();
    await wrapper.findAll(".import-source").at(5)!.trigger("click"); // electerm
    let input = wrapper.find<HTMLInputElement>("input[type=file]");
    setFiles(input.element, new File(["[]"], "bookmarks.json", { type: "application/json" }));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(invokeSpy).toHaveBeenCalledWith("import/parse", {
      kind: "electerm",
      fileBase64: btoa("[]"),
    });
    // 空解析结果留在第二步；回第一步换 Termius 来源后文件态已重置。
    await wrapper.find(".import-nav .import-back").trigger("click");
    expect(wrapper.text()).toContain("importWizard.step(current=1)");
    await wrapper.findAll(".import-source").at(6)!.trigger("click"); // termius
    input = wrapper.find<HTMLInputElement>("input[type=file]");
    setFiles(input.element, new File(["{}"], "termius.json", { type: "application/json" }));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(invokeSpy).toHaveBeenCalledWith("import/parse", {
      kind: "termius",
      fileBase64: btoa("{}"),
    });
  });
});
