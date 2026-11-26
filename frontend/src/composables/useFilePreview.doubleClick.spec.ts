// @vitest-environment happy-dom
// 双击文件行为偏好（预览/编辑，默认预览）测试：openEntry 文本车道加载成功后，
// 偏好为 edit 且满足可编辑条件（可写、未截断）时直接进入编辑态；不可编辑
// （只读连接/截断大文件/多格式车道）一律静默回落预览，不弹提示。
import { describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import { useFilePreview } from "./useFilePreview";

vi.mock("../lib/confirmDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/confirmDialog")>()),
  confirmDialog: vi.fn(async () => true),
}));

function makeEntry(overrides: Partial<{ uri: string; name: string; kind: "file" | "directory" | "symlink" | "other"; targetKind: "directory" | "file" | "other"; size: number }> = {}) {
  return { uri: "/remote/docs/notes.txt", name: "notes.txt", kind: "file" as const, size: 1024, ...overrides };
}

function b64encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function installPluginStub(handler: (method: string, params?: unknown) => Promise<unknown>) {
  window.dbxPlugin = {
    invoke: handler,
    decodeBase64: b64decode,
    encodeBase64: (value: Uint8Array | ArrayBuffer) => b64encode(value instanceof Uint8Array ? value : new Uint8Array(value)),
  } as unknown as DbxPluginApi;
}

type DoubleClickAction = "preview" | "edit";

function setup(options: { canWrite?: boolean; doubleClickAction?: DoubleClickAction; loadDirectory?: (path?: string) => Promise<void> } = {}) {
  const session: Ref<{ sessionId?: string } | undefined> = ref({ sessionId: "session-1" });
  const sudoMode = ref(false);
  const canWrite = ref(options.canWrite ?? true);
  const doubleClickAction: Ref<DoubleClickAction> = ref(options.doubleClickAction ?? "preview");
  const notices: string[] = [];
  const errors: unknown[] = [];
  const composable = useFilePreview({
    t: (key: string) => key,
    showNotice: (message: string) => notices.push(message),
    showError: (cause: unknown) => errors.push(cause),
    session,
    sudoMode,
    canWrite,
    doubleClickAction,
    loadDirectory: options.loadDirectory ?? (async () => {}),
    downloadEntry: async () => {},
    pathFromUri: (uri: string) => uri,
  });
  return { composable, doubleClickAction, notices, errors };
}

describe("useFilePreview 双击行为偏好", () => {
  it("defaults to preview: inline text stays read-only without doubleClickAction=edit", async () => {
    installPluginStub(vi.fn(() => Promise.resolve({ dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: false })));
    const { composable } = setup();
    await composable.openEntry(makeEntry());
    expect(composable.previewOpen.value).toBe(true);
    expect(composable.previewEditable.value).toBe(false);
  });

  it("enters edit mode directly when preference is edit and the file is editable", async () => {
    installPluginStub(vi.fn(() => Promise.resolve({ dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: false })));
    const { composable } = setup({ doubleClickAction: "edit" });
    await composable.openEntry(makeEntry());
    expect(composable.previewOpen.value).toBe(true);
    expect(composable.previewEditable.value).toBe(true);
    expect(composable.previewDraft.value).toBe("hello");
    expect(composable.previewDirty.value).toBe(false);
  });

  it("silently falls back to preview on read-only connections", async () => {
    installPluginStub(vi.fn(() => Promise.resolve({ dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: false })));
    const { composable, notices } = setup({ doubleClickAction: "edit", canWrite: false });
    await composable.openEntry(makeEntry());
    expect(composable.previewOpen.value).toBe(true);
    expect(composable.previewEditable.value).toBe(false);
    expect(notices).toEqual([]);
  });

  it("silently falls back to preview when the head load is truncated (large file)", async () => {
    installPluginStub(vi.fn(() => Promise.resolve({ dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: true })));
    const { composable } = setup({ doubleClickAction: "edit" });
    await composable.openEntry(makeEntry({ size: 2 * 1024 * 1024 }));
    expect(composable.previewOpen.value).toBe(true);
    expect(composable.previewEditable.value).toBe(false);
    expect(composable.previewTruncated.value).toBe(true);
  });

  it("does not affect the multi-format lane (docx opens the viewer dialog)", async () => {
    const { composable } = setup({ doubleClickAction: "edit" });
    await composable.openEntry(makeEntry({ uri: "/remote/report.docx", name: "report.docx" }));
    expect(composable.multiPreviewOpen.value).toBe(true);
    expect(composable.previewOpen.value).toBe(false);
    expect(composable.previewEditable.value).toBe(false);
  });

  it("does not enter edit mode when the read fails", async () => {
    installPluginStub(vi.fn(() => Promise.reject(new Error("sftp read failed"))));
    const { composable, errors } = setup({ doubleClickAction: "edit" });
    await composable.openEntry(makeEntry());
    expect(composable.previewEditable.value).toBe(false);
    expect(errors.length).toBe(0);
  });
});

// issue #330：双击目录符号链接 = 进入目标目录；文件/未知目标的链接维持旧
// 行为（不导航、不打开预览），避免把链接误当文件读。
describe("useFilePreview 目录符号链接双击", () => {
  it("navigates into a symlink whose target is a directory", async () => {
    const loadDirectory = vi.fn(async () => {});
    const { composable } = setup({ loadDirectory });
    await composable.openEntry(
      makeEntry({ uri: "/remote/docs/link-dir", name: "link-dir", kind: "symlink", targetKind: "directory" }),
    );
    expect(loadDirectory).toHaveBeenCalledWith("/remote/docs/link-dir");
    expect(composable.previewOpen.value).toBe(false);
  });

  it("does not navigate into file or unknown-target symlinks", async () => {
    const loadDirectory = vi.fn(async () => {});
    const { composable } = setup({ loadDirectory });
    await composable.openEntry(
      makeEntry({ uri: "/remote/docs/link-file", name: "link-file", kind: "symlink", targetKind: "file" }),
    );
    await composable.openEntry(
      makeEntry({ uri: "/remote/docs/link-unknown", name: "link-unknown", kind: "symlink" }),
    );
    expect(loadDirectory).not.toHaveBeenCalled();
    expect(composable.previewOpen.value).toBe(false);
  });
});
