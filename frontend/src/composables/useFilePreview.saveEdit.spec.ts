// @vitest-environment happy-dom
// 保存后保持编辑态（issue #288）：保存成功不回落「编辑」按钮，dirty 归零并
// 给出成功提示；同一编辑态下可直接再次保存，无需重新点「编辑」。
import { describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import { useFilePreview } from "./useFilePreview";

vi.mock("../lib/confirmDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/confirmDialog")>()),
  confirmDialog: vi.fn(async () => true),
}));

function b64encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function setup() {
  const session: Ref<{ sessionId?: string } | undefined> = ref({ sessionId: "session-1" });
  const sudoMode = ref(false);
  const canWrite = ref(true);
  const doubleClickAction: Ref<"preview" | "edit"> = ref("edit");
  const notices: string[] = [];
  const errors: unknown[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const invoke = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sftp/read") {
      return { dataBase64: b64encode(new TextEncoder().encode("hello")), truncated: false };
    }
    if (method === "sftp/write") {
      const data = String(params?.dataBase64 ?? "");
      writes.push({ path: String(params?.remotePath ?? ""), text: new TextDecoder().decode(b64decode(data)) });
      return {};
    }
    return {};
  });
  window.dbxPlugin = {
    invoke,
    decodeBase64: b64decode,
    encodeBase64: (value: Uint8Array | ArrayBuffer) => b64encode(value instanceof Uint8Array ? value : new Uint8Array(value)),
  } as unknown as DbxPluginApi;
  const composable = useFilePreview({
    t: (key: string) => key,
    showNotice: (message: string) => notices.push(message),
    showError: (cause: unknown) => errors.push(cause),
    session,
    sudoMode,
    canWrite,
    doubleClickAction,
    loadDirectory: async () => {},
    downloadEntry: async () => {},
    pathFromUri: (uri: string) => uri,
  });
  return { composable, notices, errors, writes };
}

const entry = { uri: "/remote/docs/notes.txt", name: "notes.txt", kind: "file" as const, size: 1024 };

describe("useFilePreview 保存后保持编辑态", () => {
  it("keeps edit mode active after save and clears the dirty flag", async () => {
    const { composable, notices, errors, writes } = setup();
    await composable.openEntry(entry);
    expect(composable.previewEditable.value).toBe(true);

    composable.previewDraft.value = "hello world";
    expect(composable.previewDirty.value).toBe(true);
    await composable.savePreview();

    expect(errors).toEqual([]);
    expect(writes).toEqual([{ path: "/remote/docs/notes.txt", text: "hello world" }]);
    expect(composable.previewEditable.value).toBe(true);
    expect(composable.previewDirty.value).toBe(false);
    expect(composable.previewDraft.value).toBe("hello world");
    expect(composable.previewText.value).toBe("hello world");
    expect(notices).toEqual(["editSave.saved"]);
  });

  it("allows saving again directly without re-entering edit mode", async () => {
    const { composable, notices, writes } = setup();
    await composable.openEntry(entry);
    composable.previewDraft.value = "first";
    await composable.savePreview();

    // 不调用 beginPreviewEdit：按钮仍是「保存」，可直接再存。
    expect(composable.previewEditable.value).toBe(true);
    composable.previewDraft.value = "second";
    await composable.savePreview();

    expect(writes.map((write) => write.text)).toEqual(["first", "second"]);
    expect(notices).toEqual(["editSave.saved", "editSave.saved"]);
    expect(composable.previewEditable.value).toBe(true);
    expect(composable.previewDirty.value).toBe(false);
  });
});
