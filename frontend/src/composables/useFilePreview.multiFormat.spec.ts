// @vitest-environment happy-dom
// useFilePreview 多格式分流测试（files 插件 App.previewReopen.spec 精神移植）：
// 覆盖 openEntry 的车道判定——image/file-viewer 扩展开多格式弹窗（不再被
// 「已知二进制不打开」拦截），文本/未知扩展留在既有内联链路；closePreview 不
// 动多格式弹窗，closeMultiFormatPreview 只关多格式弹窗。
import { describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import { useFilePreview } from "./useFilePreview";
import * as confirmDialogModule from "../lib/confirmDialog";

vi.mock("../lib/confirmDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/confirmDialog")>()),
  confirmDialog: vi.fn(async () => true),
}));

function makeEntry(overrides: Partial<{ uri: string; name: string; kind: "file" | "directory"; size: number }> = {}) {
  return { uri: "/remote/docs/report.pdf", name: "report.pdf", kind: "file" as const, size: 1024, ...overrides };
}

function b64encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

// 测试环境没有默认 window.dbxPlugin：完整替换（而不是 spread 展开遗留值），
// decodeBase64 必须在位——remoteFileLooksBinary 的 try/catch 会吞掉桩缺方法
// 的 TypeError 并把嗅探降级为「文本」，用例将假阴性。
function installPluginStub(handler: (method: string, params?: unknown) => Promise<unknown>) {
  window.dbxPlugin = {
    invoke: handler,
    decodeBase64: b64decode,
    encodeBase64: (value: Uint8Array | ArrayBuffer) => b64encode(value instanceof Uint8Array ? value : new Uint8Array(value)),
  } as unknown as DbxPluginApi;
}

function setup(options: { canWrite?: boolean; sudoMode?: boolean } = {}) {
  const session: Ref<{ sessionId?: string } | undefined> = ref({ sessionId: "session-1" });
  const sudoMode = ref(options.sudoMode ?? false);
  const canWrite = ref(options.canWrite ?? true);
  const doubleClickAction: Ref<"preview" | "edit"> = ref("preview");
  const notices: string[] = [];
  const errors: unknown[] = [];
  const loadedDirs: string[] = [];
  const downloaded: Array<{ entry: unknown; forceSudo: boolean }> = [];
  const composable = useFilePreview({
    t: (key: string) => key,
    showNotice: (message: string) => notices.push(message),
    showError: (cause: unknown) => errors.push(cause),
    session,
    sudoMode,
    canWrite,
    doubleClickAction,
    loadDirectory: async (path?: string) => {
      loadedDirs.push(path ?? "");
    },
    downloadEntry: async (entry, forceSudo) => {
      downloaded.push({ entry, forceSudo: forceSudo === true });
    },
    pathFromUri: (uri: string) => uri,
  });
  return { composable, session, sudoMode, canWrite, notices, errors, loadedDirs, downloaded };
}

describe("useFilePreview 多格式分流", () => {
  it("routes office/pdf/media files to the multi-format dialog", async () => {
    const { composable } = setup();
    await composable.openEntry(makeEntry({ uri: "/remote/report.docx", name: "report.docx" }));
    expect(composable.multiPreviewOpen.value).toBe(true);
    expect(composable.multiPreviewPath.value).toBe("/remote/report.docx");
    // 旧内联链路未被打开。
    expect(composable.previewOpen.value).toBe(false);
  });

  it("routes images of any size to the multi-format dialog (chunked lane)", async () => {
    const { composable } = setup();
    // >20MiB 图片旧 data URI 链不支持，新分块车道全量接管。
    await composable.openEntry(makeEntry({ uri: "/remote/big.png", name: "big.png", size: 30 * 1024 * 1024 }));
    expect(composable.multiPreviewOpen.value).toBe(true);
    expect(composable.multiPreviewPath.value).toBe("/remote/big.png");
  });

  it("keeps known binary extensions off the not-open blocklist for viewer lanes", async () => {
    const { composable, notices } = setup();
    // pdf 在旧 BINARY_PREVIEW_EXTENSIONS 名单里；多格式车道下不再弹「二进制不打开」。
    await composable.openEntry(makeEntry({ uri: "/remote/manual.pdf", name: "manual.pdf" }));
    expect(notices).toEqual([]);
    expect(composable.multiPreviewOpen.value).toBe(true);
  });

  it("keeps text files on the legacy inline preview", async () => {
    const { composable } = setup();
    // 文本车道不真读正文（sftp/read 完整链路由 PreviewPane 内测覆盖）：
    // 只断言未走多格式弹窗，且嗅探读（8KiB 头部）已发出。
    const invoke = vi.fn((_method: string) => Promise.resolve({ dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: false }));
    installPluginStub(invoke);
    await composable.openEntry(makeEntry({ uri: "/remote/notes.txt", name: "notes.txt" }));
    expect(composable.multiPreviewOpen.value).toBe(false);
    expect(composable.previewOpen.value).toBe(true);
    expect(invoke).toHaveBeenCalledWith("sftp/read", expect.objectContaining({ path: "/remote/notes.txt" }));
  });

  it("still blocks unknown-extension binary sniff hits from either preview", async () => {
    const { composable, notices } = setup();
    // 无扩展名 + 嗅探命中二进制（NUL 字节）：分流前既有兜底依旧生效。
    installPluginStub(vi.fn((_method: string) => Promise.resolve({ dataBase64: b64encode(new Uint8Array([0x00, 0x01, 0x02, 0x03])), truncated: false })));
    await composable.openEntry(makeEntry({ uri: "/remote/blobfile", name: "blobfile", size: 64 }));
    expect(notices).toContain("binaryFile.notOpen");
    expect(composable.multiPreviewOpen.value).toBe(false);
    expect(composable.previewOpen.value).toBe(false);
  });

  it("navigates to directories instead of previewing", async () => {
    const { composable, loadedDirs } = setup();
    await composable.openEntry(makeEntry({ uri: "/remote/docs", name: "docs", kind: "directory" }));
    expect(loadedDirs).toEqual(["/remote/docs"]);
    expect(composable.multiPreviewOpen.value).toBe(false);
  });

  it("keeps the multi-format dialog open across path switches and closes via its own close", async () => {
    const { composable } = setup();
    await composable.openEntry(makeEntry({ uri: "/remote/a.pdf", name: "a.pdf" }));
    expect(composable.multiPreviewPath.value).toBe("/remote/a.pdf");
    // 已开着时再点另一个文件：只换路径不重建弹窗。
    await composable.openEntry(makeEntry({ uri: "/remote/b.docx", name: "b.docx" }));
    expect(composable.multiPreviewPath.value).toBe("/remote/b.docx");
    // 旧内联 closePreview 不动多格式弹窗。
    composable.closePreview();
    expect(composable.multiPreviewOpen.value).toBe(true);
    composable.closeMultiFormatPreview();
    expect(composable.multiPreviewOpen.value).toBe(false);
  });

  it("does not leak the multi-format dialog state into legacy truncated confirmation flows", async () => {
    const { composable } = setup();
    await composable.openEntry(makeEntry({ uri: "/remote/big.csv", name: "big.csv", size: 300 * 1024 * 1024 }));
    expect(composable.multiPreviewOpen.value).toBe(true);
    // 旧链路的过大确认不触发（分流在 size 检查前）。
    expect(confirmDialogModule.confirmDialog).not.toHaveBeenCalled();
  });
});
