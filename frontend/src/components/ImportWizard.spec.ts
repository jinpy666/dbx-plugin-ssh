// @vitest-environment happy-dom
// 流式会话导入向导：主文件走 start + binary offset chunk + ACK，finish 仅
// 展示脱敏预览并允许导出规范化 JSON；不再调用 import/commit。
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ImportWizard from "./ImportWizard.vue";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const PREVIEW = {
  sessions: [{ index: 0, name: "web-1", host: "10.0.0.1", port: 22, username: "dev", groupPath: "Prod/Web", description: "", authKind: "password", hasSecret: true }],
  export: { schemaVersion: 1, sourceKind: "moba", sessions: [{ name: "web-1", auth: { kind: "password", hasSecret: true } }] },
};

function installBridge(finish: unknown = PREVIEW) {
  const listeners = new Set<(event: { method: string; params: Record<string, unknown> }) => void>();
  const invoke = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "import/preview/start") return { taskId: "preview-1", chunkSize: 256 * 1024 };
    if (method === "import/preview/finish") return finish;
    return { cancelled: true };
  });
  const sendBinary = vi.fn(async (channel: string, frame: Uint8Array) => {
    const [, , taskId, part] = channel.split("/");
    const nextOffset = Number(new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0)) + frame.byteLength - 8;
    for (const listener of listeners) listener({ method: "import/preview/ack", params: { taskId, part, nextOffset } });
  });
  const saveFile = vi.fn(async () => ({ path: "/tmp/export.json" }));
  (window as unknown as { dbxPlugin: unknown }).dbxPlugin = {
    invoke, sendBinary, saveFile,
    onEvent: (listener: (event: { method: string; params: Record<string, unknown> }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { invoke, sendBinary, saveFile };
}

function setFiles(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function reachPreviewStep(wrapper: ReturnType<typeof mount>) {
  await wrapper.findAll(".import-source").at(0)!.trigger("click");
  setFiles(wrapper.find<HTMLInputElement>("input[type=file]").element, new File(["moba-export"], "sessions.mxtsessions"));
  await flushPromises();
  await wrapper.find(".import-nav .primary-button").trigger("click");
  await flushPromises();
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("ImportWizard", () => {
  it("streams a selected export through binary offset chunks and renders only the sanitized preview", async () => {
    const bridge = installBridge();
    const wrapper = mount(ImportWizard, { props: { t } });
    await reachPreviewStep(wrapper);
    expect(bridge.invoke).toHaveBeenCalledWith("import/preview/start", { kind: "moba", mainSize: 11 });
    expect(bridge.sendBinary).toHaveBeenCalledTimes(1);
    const [channel, frame] = bridge.sendBinary.mock.calls[0];
    expect(channel).toBe("import/preview/preview-1/main");
    expect([...frame.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(bridge.invoke).toHaveBeenCalledWith("import/preview/finish", { taskId: "preview-1" });
    expect(wrapper.text()).toContain("web-1");
    expect(wrapper.text()).not.toContain("moba-export");
    expect(bridge.invoke.mock.calls.map(([method]) => method)).not.toContain("import/commit");
  });

  it("cancels an active preview when the wizard unmounts", async () => {
    const bridge = installBridge();
    bridge.sendBinary.mockImplementation(() => new Promise<void>(() => undefined));
    const wrapper = mount(ImportWizard, { props: { t } });
    await wrapper.findAll(".import-source").at(0)!.trigger("click");
    setFiles(wrapper.find<HTMLInputElement>("input[type=file]").element, new File(["x"], "sessions.mxtsessions"));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    wrapper.unmount();
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("import/preview/cancel", { taskId: "preview-1" });
  });

  it("cancels the server preview when the binary stream fails", async () => {
    const bridge = installBridge();
    bridge.sendBinary.mockRejectedValueOnce(new Error("transport closed"));
    const wrapper = mount(ImportWizard, { props: { t } });
    await wrapper.findAll(".import-source").at(0)!.trigger("click");
    setFiles(wrapper.find<HTMLInputElement>("input[type=file]").element, new File(["x"], "sessions.mxtsessions"));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(bridge.invoke).toHaveBeenCalledWith("import/preview/cancel", { taskId: "preview-1" });
    expect(wrapper.text()).toContain("importWizard.parseFailed(error=transport closed)");
  });

  it("exports the normalized preview through the host save bridge", async () => {
    const bridge = installBridge();
    const wrapper = mount(ImportWizard, { props: { t } });
    await reachPreviewStep(wrapper);
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(bridge.saveFile).toHaveBeenCalledWith(
      { fileName: "moba-sessions-sanitized.json", contentType: "application/json" },
      expect.any(Uint8Array),
    );
    const call = bridge.saveFile.mock.calls[0] as unknown as [{ fileName: string; contentType: string }, Uint8Array];
    expect(new TextDecoder().decode(call[1])).not.toContain("s3cret");
  });

  it("maps the WindTerm master-password error after streaming", async () => {
    const bridge = installBridge();
    bridge.invoke.mockImplementation(async (method: string) => {
      if (method === "import/preview/start") return { taskId: "preview-1" };
      if (method === "import/preview/finish") throw new Error("WindTerm master password is required");
      return { cancelled: true };
    });
    const wrapper = mount(ImportWizard, { props: { t } });
    await wrapper.findAll(".import-source").at(2)!.trigger("click");
    setFiles(wrapper.find<HTMLInputElement>("input[type=file]").element, new File(["[]"], "sessions.sessions"));
    await flushPromises();
    await wrapper.find(".import-nav .primary-button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("importWizard.needMasterPassword");
  });
});
