// @vitest-environment happy-dom
// PreviewPane 组件测试（自 files 插件 PreviewPane.spec 移植并适配 SSH sidecar）：
// 读取桩从 files/read + files/readRange 换成 sftp/read(offset/maxBytes) +
// sftp/stat（普通车道）与 sudo/readFile（sudo 车道）；类名 .wb-* 换 .ssh-preview-*。
// 覆盖：焦点进出、加载态宣告、isDirty 关闭守卫、车道分流（文本/viewer/hex）、
// sudo 车道、分块流式拼装/进度/取消/超上限、Markdown 渲染视图。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, config, type VueWrapper } from "@vue/test-utils";
import { defineComponent } from "vue";
import PreviewPane from "./PreviewPane.vue";

type PreviewPaneProps = InstanceType<typeof PreviewPane>["$props"];
import { PREVIEW_CONFIRM_BYTES, PREVIEW_MAX_BYTES, READ_MAX_BYTES, SUDO_READ_MAX_BYTES } from "../lib/preview";

config.global.stubs = { FileViewerPreview: true };

// 审计#7：替代 CodeMirror 的 TextPreview 桩——点击按钮即模拟草稿改动
// （emit change），expose focus 供编辑态聚焦链路调用。
const TextPreviewStub = defineComponent({
  props: { text: { type: String, default: "" }, editable: Boolean },
  emits: ["change"],
  setup(_props, { expose }) {
    expose({ focus: () => undefined });
  },
  template: `<div class="stub-text"><button data-test="type" @click="$emit('change', text + '!')" /></div>`,
});

const appearance: DbxPluginAppearance = {
  colorScheme: "dark",
  colors: {
    background: "#131416",
    foreground: "#d7d7db",
    muted: "#2a2a2d",
    mutedForeground: "#97989d",
    accent: "#2e2f33",
    accentForeground: "#dddde2",
    border: "#3a3a3d",
    destructive: "#ef4444",
  },
  terminal: { fontFamily: "monospace", fontSize: 12 },
};

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// 1x1 png
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 泵用宏任务而非纯微任务：分块循环多级 await 链对微任务拍数敏感，
// 宏任务泵每拍先排干全部微任务再跨 tick，对跳数不敏感。
async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

/** SSH sidecar 桩：sftp/stat + sftp/read(offset/maxBytes)，可选 sudo 车道。
 * read 每次返回 min(每片上限, total-offset) 字节（total 未给时返回固定 5 字节
 * 正文），truncated 语义与真 sidecar 一致——请求数超出文件尾才算截断。 */
function bindSshApi(options: {
  total?: number;
  sudo?: boolean;
  calls?: RecordedCall[];
  failAll?: boolean;
}) {
  const calls = options.calls ?? [];
  const record = (method: string, params: unknown) => {
    const entry = { method, params: (params ?? {}) as Record<string, unknown> };
    calls.push(entry);
    return entry;
  };
  const handler = async <T,>(method: string, params: unknown): Promise<T> => {
    record(method, params);
    if (options.failAll) throw new Error("sidecar unavailable");
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "sftp/stat" || method === "sudo/stat") {
      return { path: p.path, kind: "file", size: options.total ?? 0 } as unknown as T;
    }
    if (method === "sftp/read" || method === "sudo/readFile") {
      const offset = Number(p.offset ?? 0);
      const perChunk = method === "sudo/readFile" ? SUDO_READ_MAX_BYTES : READ_MAX_BYTES;
      const requested = method === "sudo/readFile" ? Number(p.length ?? perChunk) : Number(p.maxBytes ?? perChunk);
      // total 未给（文本用例）：固定 5 字节正文，未到请求上限 → truncated=false。
      const available = options.total === undefined ? 5 : options.total - offset;
      const length = Math.max(0, Math.min(perChunk, requested, available));
      const truncated = available > length;
      const bytes = new Uint8Array(length);
      if (options.total === undefined) bytes.set(new TextEncoder().encode("hello"));
      else bytes.fill((offset % 250) + 1);
      return { dataBase64: b64encode(bytes), truncated } as unknown as T;
    }
    if (method === "sftp/write" || method === "sudo/writeFile") {
      return { success: true } as unknown as T;
    }
    throw new Error(`unexpected method ${method}`);
  };
  window.dbxPlugin = {
    invoke: handler,
    decodeBase64: b64decode,
    encodeBase64: (value: Uint8Array | ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))),
  } as unknown as DbxPluginApi;
  return calls;
}

let wrapper: VueWrapper | undefined;

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function mountPane(props: Partial<PreviewPaneProps> & { path: string | null } = { path: null }, stubs: Record<string, unknown> = {}) {
  wrapper = mount(PreviewPane, {
    props: {
      sessionId: "session-1",
      sudo: false,
      canWrite: true,
      appearance,
      t: (key: string) => key,
      ...props,
    },
    global: { stubs: stubs as never },
    attachTo: document.body,
  });
  return wrapper;
}

describe("PreviewPane (预览焦点)", () => {
  it("moves focus into the preview container after open", async () => {
    bindSshApi({ total: 0 });
    const pane = mountPane({ path: "/docs/logo.png" });
    await flush();
    const preview = pane.find(".ssh-preview");
    expect(preview.exists()).toBe(true);
    expect(document.activeElement).toBe(preview.element);
  });

  it("does not render when no path is given", () => {
    mountPane({ path: null });
    expect(wrapper!.find(".ssh-preview").exists()).toBe(false);
  });

  // 关闭（卸载）后焦点归还打开前的触发元素，不再落在 BODY
  it("returns focus to the triggering element after close", async () => {
    bindSshApi({ total: 0 });
    const host = mount(
      {
        components: { PreviewPane },
        data: () => ({ path: null as string | null, appearance, t: (key: string) => key }),
        template: `
          <div>
            <button data-test="trigger">触发</button>
            <!-- 镜像 App.vue 真实挂载：外层 v-if 控制组件整体挂载/卸载 -->
            <PreviewPane v-if="path" :path="path" session-id="s1" :can-write="false" :appearance="appearance" :t="t" />
          </div>
        `,
      },
      { attachTo: document.body },
    );
    wrapper = host;
    const trigger = host.find("[data-test=trigger]").element as HTMLElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await host.setData({ path: "/docs/logo.png" });
    await flush();
    const preview = host.find(".ssh-preview");
    expect(preview.exists()).toBe(true);
    expect(document.activeElement).toBe(preview.element);
    await host.setData({ path: null });
    await flush();
    expect(host.find(".ssh-preview").exists()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });
});

it("announces bounded preview loading without stale size or truncation feedback", async () => {
  let resolveRead!: (value: { dataBase64: string; truncated: boolean }) => void;
  const reads: Record<string, unknown>[] = [];
  window.dbxPlugin = {
    invoke: async <T,>(method: string, params: unknown) => {
      reads.push((params ?? {}) as Record<string, unknown>);
      return new Promise<T>((resolve) => { resolveRead = (value) => resolve(value as T); });
    },
    decodeBase64: b64decode,
  } as unknown as DbxPluginApi;
  wrapper = mountPane({ path: "/large.log" });
  expect(wrapper.get("[role=status]").text()).toBe("loading");
  expect(wrapper.get(".ssh-preview-body").attributes("aria-busy")).toBe("true");
  expect(wrapper.get(".ssh-preview-header").text()).not.toContain("0 B");
  expect(reads[0]).toMatchObject({ path: "/large.log", maxBytes: READ_MAX_BYTES });
  resolveRead({ dataBase64: "aGk=", truncated: true });
  await flush();
  expect(wrapper.find("[data-test=truncated]").exists()).toBe(true);
  await wrapper.setProps({ path: "/next.log" });
  expect(wrapper.get("[role=status]").text()).toBe("loading");
  expect(wrapper.find("[data-test=truncated]").exists()).toBe(false);
  expect(wrapper.get(".ssh-preview-header").text()).not.toContain("MiB");
  resolveRead({ dataBase64: "aGk=", truncated: false });
  await flush();
  expect(wrapper.get(".ssh-preview-body").attributes("aria-busy")).toBe("false");
});

// 审计#7：向外暴露 isDirty（editing 且草稿已改动），App 侧关闭预览前据此
// 弹丢弃确认，防止静默丢失 CodeMirror 编辑内容。
it("exposes unsaved-draft state as isDirty for the close guard", async () => {
  bindSshApi({});
  wrapper = mountPane({ path: "/notes.txt" }, { TextPreview: TextPreviewStub });
  await flush();
  const dirty = () => (wrapper!.findComponent(PreviewPane).vm as unknown as { isDirty: boolean }).isDirty;
  expect(dirty()).toBe(false);
  // 进入编辑（铅笔按钮）但草稿未改动：仍不算脏。
  await wrapper.get("[data-test=preview-edit]").trigger("click");
  await flush();
  expect(dirty()).toBe(false);
  // 草稿改动 → isDirty。
  await wrapper.get(".stub-text [data-test=type]").trigger("click");
  await flush();
  expect(dirty()).toBe(true);
  // 取消编辑回滚草稿 → isDirty 复位。
  await wrapper.get(".ssh-preview-editbar button").trigger("click");
  await flush();
  expect(dirty()).toBe(false);
});

// 预览头部：文件类型图标（files 插件 fileIcons 识别）+ 本地程序打开下拉。
describe("PreviewPane header (file icon + open with)", () => {
  it("renders the archive icon for a zip and enables local open when capable", async () => {
    bindSshApi({ total: 0 });
    const pane = mountPane({ path: "/downloads/bundle.zip", canOpenLocal: true });
    await flush();
    expect(pane.get(".ssh-preview-fileicon").classes()).toContain("ssh-fi-archive");
    const trigger = pane.get("[data-test=preview-open-with]");
    expect(trigger.attributes("disabled")).toBeUndefined();
    expect(trigger.attributes("aria-label")).toBe("sftpEdit.openWith");
  });

  it("disables local open when the desktop capability is missing", async () => {
    bindSshApi({ total: 0 });
    const pane = mountPane({ path: "/downloads/bundle.zip", canOpenLocal: false });
    await flush();
    const trigger = pane.get("[data-test=preview-open-with]");
    expect(trigger.attributes("disabled")).toBeDefined();
    expect(trigger.attributes("title")).toBe("sftpEdit.desktopOnly");
  });

  it("toggles maximize and swaps the header action to restore", async () => {
    bindSshApi({ total: 0 });
    const pane = mountPane({ path: "/notes.txt", maximized: false });
    await flush();
    const button = pane.get("[data-test=preview-maximize]");
    expect(button.attributes("aria-label")).toBe("previewDialog.maximize");
    await button.trigger("click");
    expect(pane.emitted("toggle-maximize")).toHaveLength(1);
    await pane.setProps({ maximized: true });
    expect(button.attributes("aria-label")).toBe("previewDialog.restore");
  });
});

// 车道分流：文本走 CodeMirror，PDF 走 FileViewer，未知二进制回退 hex。
it("routes strategies: text to CodeMirror, PDF to viewer, unknown binary to hex", async () => {  const calls: RecordedCall[] = [];
  bindSshApi({ total: 0, calls });
  wrapper = mountPane({ path: "/notes.txt" });
  await flush();
  expect(wrapper.find(".preview-editor").exists()).toBe(true);

  // PDF：stat 取大小 → 分块读取 → viewer 车道
  await wrapper.setProps({ path: "/docs/report.pdf" });
  await flush(12);
  expect(wrapper.findComponent({ name: "FileViewerPreview" }).exists()).toBe(true);
  expect(calls.some((item) => item.method === "sftp/stat")).toBe(true);

  // 不可打印占比高的未知扩展 → hex dump（换二进制内容桩：64 个 NUL）。
  window.dbxPlugin = {
    invoke: async <T,>() => ({ dataBase64: b64encode(new Uint8Array(64)), truncated: false } as unknown as T),
    decodeBase64: b64decode,
  } as unknown as DbxPluginApi;
  await wrapper.setProps({ path: "/downloads/blob.weird" });
  await flush();
  expect(wrapper.find("pre.ssh-preview-hex").exists()).toBe(true);
});

// sudo 车道：读取/写入全部换 sudo/readFile + sudo/writeFile。
describe("PreviewPane sudo lane", () => {
  it("reads via sudo/readFile and writes via sudo/writeFile", async () => {
    const calls: RecordedCall[] = [];
    bindSshApi({ total: 0, sudo: true, calls });
    wrapper = mountPane({ path: "/root/notes.txt", sudo: true }, { TextPreview: TextPreviewStub });
    await flush();
    expect(calls.some((item) => item.method === "sudo/readFile")).toBe(true);
    expect(calls.some((item) => item.method === "sftp/read")).toBe(false);
    // sudo 车道不 stat（sudo/readFile 无大小语义），按 truncated 累计收口。
    expect(calls.some((item) => item.method === "sftp/stat")).toBe(false);

    // 编辑保存走 sudo/writeFile（remotePath vs path 参数差异断言）。
    await wrapper.get("[data-test=preview-edit]").trigger("click");
    await wrapper.get(".stub-text [data-test=type]").trigger("click");
    await flush();
    const saveButton = wrapper.findAll(".ssh-preview-editbar button").find((b) => b.text() === "editSave.save");
    await saveButton!.trigger("click");
    await flush();
    const write = calls.find((item) => item.method === "sudo/writeFile");
    expect(write).toBeTruthy();
    expect(write!.params).toMatchObject({ sessionId: "session-1", path: "/root/notes.txt" });
    expect(wrapper.emitted("saved")).toEqual([["/root/notes.txt"]]);
  });

  // 回归：sudo 二进制预览此前把无 stat 大小当 0 字节直接收口，PDF/Office/
  // 图片都拿到空 File；现在改用 sudo/stat 取大小并正常分块。
  it("streams sudo binary previews using the sudo/stat size", async () => {
    const total = 3 * SUDO_READ_MAX_BYTES + 321;
    const calls = bindSshApi({ total, sudo: true });
    wrapper = mountPane({ path: "/root/发票.pdf", sudo: true });
    await flush(24);
    expect(calls.some((item) => item.method === "sudo/stat")).toBe(true);
    expect(calls.some((item) => item.method === "sudo/readFile")).toBe(true);
    expect(calls.some((item) => item.method === "sftp/stat")).toBe(false);
    const viewer = wrapper.findComponent({ name: "FileViewerPreview" });
    expect(viewer.exists()).toBe(true);
    expect((viewer.props("source") as File).size).toBe(total);
  });
});

// 大文件门禁：>32MiB 的 PDF/Office/媒体不自动整文件进内存，先给
// 「打开方式 / 下载 / 仍要预览」；>256MiB 由 overcap 分支只保留下载出口。
describe("PreviewPane large file gate", () => {
  it("holds a large PDF until the user downloads or explicitly previews it", async () => {
    const total = PREVIEW_CONFIRM_BYTES + 1;
    const calls = bindSshApi({ total });
    wrapper = mountPane({ path: "/docs/huge.pdf" });
    // 条件等待替代固定拍数 flush：并行负载下硬编码 tick 偶尔不够（本用例
    // 曾以 ~1/3 全量跑的频率抖动）。
    await vi.waitFor(() => expect(wrapper!.find("[data-test=preview-large]").exists()).toBe(true), { timeout: 4000 });
    const notice = wrapper.get("[data-test=preview-large]");
    expect(notice.text()).toContain("previewDialog.largeFileNotice");
    // 门禁阶段不发起任何分块读取。
    expect(calls.some((item) => item.method === "sftp/read")).toBe(false);
    // 下载出口直接交给 App 的既有下载链。
    await wrapper.get("[data-test=preview-large-download]").trigger("click");
    expect(wrapper.emitted("download")).toEqual([["/docs/huge.pdf"]]);
    // 「仍要预览」显式确认后才开始分块并最终交给 viewer。
    // 「仍要预览」后的分片流式加载是 33 轮（32MiB+1 / 1MiB）真实异步链，
    // 并行负载下用固定 flush 等不完：条件等待内重试点击（首次点击若落在
    // loading 收尾前会被守卫吸收），直到 viewer 就位。
    // 「仍要预览」后是 33 轮分片流式加载（32MiB+1 / 1MiB 真实链），并行负载
    // 下 tick 数需求会抬升：先让门禁分支的 loading 收尾，再点一次并给足 tick
    // （不要重试点击——loading 守卫会让后续点击早退，与在跑的链互扰）。
    await flush(4);
    await wrapper.get("[data-test=preview-large-anyway]").trigger("click");
    await flush(400);
    expect(wrapper.findComponent({ name: "FileViewerPreview" }).exists()).toBe(true);
    expect(calls.some((item) => item.method === "sftp/read")).toBe(true);
  });
});

// 回归：sftp/stat 失败时不能把文件当 0 字节；未知大小按 truncated 语义读到 EOF。
it("streams when sftp/stat fails instead of treating the file as empty", async () => {
  const total = 2 * READ_MAX_BYTES + 7;
  const calls: RecordedCall[] = [];
  window.dbxPlugin = {
    invoke: async <T,>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      if (method === "sftp/stat") throw new Error("stat unavailable");
      if (method === "sftp/read") {
        const offset = Number((params as Record<string, unknown>).offset ?? 0);
        const length = Math.max(0, Math.min(READ_MAX_BYTES, total - offset));
        const bytes = new Uint8Array(length);
        bytes.fill(1);
        return {
          dataBase64: b64encode(bytes),
          truncated: offset + length < total,
        } as unknown as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
    decodeBase64: b64decode,
  } as unknown as DbxPluginApi;
  wrapper = mountPane({ path: "/docs/report.pdf" });
  await flush(24);
  const viewer = wrapper.findComponent({ name: "FileViewerPreview" });
  expect(viewer.exists()).toBe(true);
  expect((viewer.props("source") as File).size).toBe(total);
});

// ---- 分块流式加载（sftp/stat + sftp/read offset）----------------------------
// 二进制预览（图片/媒体/office/pdf）：1MiB 顺序分块拼装 Blob、确定性进度条、
// 取消干净关闭、>256MiB 超上限保持「下载代替」。
describe("PreviewPane chunked loading (sftp/read)", () => {
  it("assembles read chunks into a viewer File without exceeding 1MiB per chunk", async () => {
    const total = 2 * READ_MAX_BYTES + 100;
    const calls = bindSshApi({ total });
    const pane = mountPane({ path: "/docs/big.pdf" });
    await flush(24);
    const viewer = pane.findComponent({ name: "FileViewerPreview" });
    expect(viewer.exists()).toBe(true);
    expect((viewer.props("source") as File).size).toBe(total);
    // 顺序（并发 1）分块：offset 单调推进；整读路径不再参与。
    expect(calls.filter((item) => item.method === "sftp/read").map((item) => item.params.offset)).toEqual([
      0,
      READ_MAX_BYTES,
      2 * READ_MAX_BYTES,
    ]);
  });

  it("shows determinate byte progress while chunks arrive", async () => {
    const total = 2 * READ_MAX_BYTES;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const calls: RecordedCall[] = [];
    window.dbxPlugin = {
      invoke: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "sftp/stat") return { path: "", kind: "file", size: total } as unknown as T;
        if (method === "sftp/read") {
          const offset = Number((params as Record<string, unknown>).offset ?? 0);
          if (offset > 0) await gate;
          const length = Math.min(READ_MAX_BYTES, total - offset);
          const bytes = new Uint8Array(length);
          bytes.fill(1);
          return { dataBase64: b64encode(bytes), truncated: false } as unknown as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    const pane = mountPane({
      path: "/docs/big.pdf",
      t: (key: string, values?: Record<string, string | number>) => (values?.done !== undefined ? `${key} ${values.done}` : key),
    });
    await flush(24);
    // 第一片（1MiB）已取，第二片被闸门挂起：进度条呈现 1MiB / 2MiB。
    const chunkbar = pane.get("[data-test=chunkbar]");
    expect(chunkbar.text()).toContain("previewDialog.chunkProgress 1.0 MiB");
    expect(chunkbar.get("[role=progressbar]").attributes("aria-valuenow")).toBe("50");
    releaseGate();
    await flush(24);
    expect(pane.find("[data-test=chunkbar]").exists()).toBe(false);
  });

  it("cancels the remaining chunks and closes cleanly", async () => {
    const total = 3 * READ_MAX_BYTES;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const calls: RecordedCall[] = [];
    window.dbxPlugin = {
      invoke: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "sftp/stat") return { path: "", kind: "file", size: total } as unknown as T;
        if (method === "sftp/read") {
          const offset = Number((params as Record<string, unknown>).offset ?? 0);
          if (offset === READ_MAX_BYTES) await gate;
          const length = Math.min(READ_MAX_BYTES, total - offset);
          const bytes = new Uint8Array(length);
          bytes.fill(1);
          return { dataBase64: b64encode(bytes), truncated: false } as unknown as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    const pane = mountPane({ path: "/docs/big.pdf" });
    await flush(24);
    const readsBefore = calls.filter((item) => item.method === "sftp/read").length;
    await pane.get("[data-test=chunk-cancel]").trigger("click");
    expect(pane.emitted("close")).toHaveLength(1);
    // 释放被挂起的第二片后不再有后续分片请求（取消在分片间隙打断）。
    releaseGate();
    await flush(24);
    expect(calls.filter((item) => item.method === "sftp/read").length).toBe(readsBefore);
  });

  it("stops the chunk loop when the preview unmounts", async () => {
    const total = 3 * READ_MAX_BYTES;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const calls: RecordedCall[] = [];
    window.dbxPlugin = {
      invoke: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "sftp/stat") return { path: "", kind: "file", size: total } as unknown as T;
        if (method === "sftp/read") {
          const offset = Number((params as Record<string, unknown>).offset ?? 0);
          if (offset === READ_MAX_BYTES) await gate;
          const length = Math.min(READ_MAX_BYTES, total - offset);
          const bytes = new Uint8Array(length);
          bytes.fill(1);
          return { dataBase64: b64encode(bytes), truncated: false } as unknown as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    const pane = mountPane({ path: "/docs/big.pdf" });
    await flush(24);
    const readsBefore = calls.filter((item) => item.method === "sftp/read").length;
    // 关闭预览（X/Esc/遮罩）会卸载组件：释放被挂起的分片后不得再请求后续分片。
    pane.unmount();
    wrapper = undefined;
    releaseGate();
    await flush(24);
    expect(calls.filter((item) => item.method === "sftp/read").length).toBe(readsBefore);
  });

  it("keeps the download-instead hint above the hard cap", async () => {
    bindSshApi({ total: PREVIEW_MAX_BYTES + 1 });
    const pane = mountPane({ path: "/docs/big.pdf" });
    await flush(12);
    const overCap = pane.get("[data-test=overcap]");
    expect(overCap.text()).toContain("previewDialog.overCap");
    expect(pane.findComponent({ name: "FileViewerPreview" }).exists()).toBe(false);
    await overCap.get("button").trigger("click");
    expect(pane.emitted("download")).toEqual([["/docs/big.pdf"]]);
  });

  it("offers a retry-from-offset action after a chunk failure", async () => {
    const total = 3 * READ_MAX_BYTES;
    let failNext = true;
    const calls: RecordedCall[] = [];
    window.dbxPlugin = {
      invoke: async <T,>(method: string, params: unknown): Promise<T> => {
        calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
        if (method === "sftp/stat") return { path: "", kind: "file", size: total } as unknown as T;
        if (method === "sftp/read") {
          const offset = Number((params as Record<string, unknown>).offset ?? 0);
          if (offset > 0 && failNext) throw new Error("chunk transfer failed");
          const length = Math.min(READ_MAX_BYTES, total - offset);
          const bytes = new Uint8Array(length);
          bytes.fill(1);
          return { dataBase64: b64encode(bytes), truncated: false } as unknown as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    const pane = mountPane({
      path: "/docs/big.pdf",
      t: (key: string, values?: Record<string, string | number>) => (values?.offset !== undefined ? `${key} ${values.offset}` : key),
    });
    await flush(12);
    const notice = pane.get("[data-test=preview-error]");
    expect(notice.text()).toContain("previewDialog.loadError");
    // 失败保留已取字节：续传按钮从失败 offset（1MiB）继续。
    const retry = pane.get("[data-test=chunk-retry]");
    expect(retry.text()).toContain(String(READ_MAX_BYTES));
    failNext = false;
    await retry.trigger("click");
    await flush(24);
    expect(pane.find("[data-test=preview-error]").exists()).toBe(false);
    expect(pane.findComponent({ name: "FileViewerPreview" }).exists()).toBe(true);
    // 续传从失败 offset 继续，不重复已取分片。
    const readOffsets = calls.filter((item) => item.method === "sftp/read").map((item) => Number(item.params.offset));
    expect(readOffsets[0]).toBe(0);
    expect(readOffsets).toContain(READ_MAX_BYTES);
  });
});

// ---- Markdown 渲染视图（MarkdownRender.vue + 头部「渲染/源码」切换）----------
describe("PreviewPane markdown render view", () => {
  const MD_TEXT = ["# Readme", "", "hello <script>alert(1)</script> world", "", "- alpha", "- beta"].join("\n");

  function mountMd(path = "/docs/README.md") {
    bindSshApi({ total: 0 });
    window.dbxPlugin = {
      invoke: async <T,>() => ({
        dataBase64: b64encode(new TextEncoder().encode(MD_TEXT)),
        truncated: false,
      } as unknown as T),
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    wrapper = mountPane({ path });
  }

  it("opens .md in the rendered view by default with the toggle present", async () => {
    mountMd();
    await flush();
    expect(wrapper!.find("[data-test=md-toggle]").exists()).toBe(true);
    const rendered = wrapper!.get(".wb-md-render");
    expect(rendered.get("h1").text()).toBe("Readme");
    expect(rendered.find("script").exists()).toBe(false);
    // 渲染态不再挂 CodeMirror 源码容器。
    expect(rendered.find(".preview-editor").exists()).toBe(false);
  });

  it("switches to the CodeMirror source view and back to the rendered view", async () => {
    mountMd();
    await flush();
    await wrapper!.get("[data-test=md-source]").trigger("click");
    await flush();
    expect(wrapper!.find(".wb-md-render").exists()).toBe(false);
    expect(wrapper!.find(".preview-editor").exists()).toBe(true);
    await wrapper!.get("[data-test=md-render]").trigger("click");
    await flush();
    expect(wrapper!.find(".wb-md-render").exists()).toBe(true);
    // 会话记忆复位为渲染态，避免污染同文件后续用例的默认视图。
    await wrapper!.get("[data-test=md-source]").trigger("click");
    await wrapper!.get("[data-test=md-render]").trigger("click");
    await flush();
  });

  it("hides the toggle for non-markdown text files", async () => {
    bindSshApi({ total: 0 });
    wrapper = mountPane({ path: "/notes.txt" });
    await flush();
    expect(wrapper.find("[data-test=md-toggle]").exists()).toBe(false);
    expect(wrapper.find(".preview-editor").exists()).toBe(true);
  });
});

// 非 UTF-8 文本：GB18030 回退展示 + 编辑停用（不可逆写坏保护）。
describe("PreviewPane non-UTF-8 guard", () => {
  it("shows the hint and disables editing for GBK text", async () => {
    // "中文" 的 GBK 编码字节：D6 D0 CE C4（非合法 UTF-8）。
    const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    bindSshApi({ total: 0 });
    window.dbxPlugin = {
      invoke: async <T,>() => ({ dataBase64: b64encode(gbkBytes), truncated: false } as unknown as T),
      decodeBase64: b64decode,
    } as unknown as DbxPluginApi;
    wrapper = mountPane({ path: "/docs/gbk.txt" });
    await flush();
    expect(wrapper.get("[data-test=nonutf8-hint]").text()).toBe("previewDialog.nonUtf8");
    expect(wrapper.find("[data-test=preview-edit]").exists()).toBe(false);
  });
});
