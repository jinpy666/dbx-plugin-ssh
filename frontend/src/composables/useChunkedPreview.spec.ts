// @vitest-environment happy-dom
// 分块预览机制（自 PreviewPane 下沉）回归守卫：stat 门禁（硬上限/大文件
// 询问）、分片循环的 token/取消检查点、EOF 语义（已知大小 vs truncated 链）、
// 收口产物（image objectURL / viewer File）与失败续传起点。

import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useChunkedPreview, type PreviewMode } from "./useChunkedPreview";
import type { PreviewResolution } from "../lib/previewResolver";

const toB64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromB64 = (data: string): Uint8Array =>
  new Uint8Array(atob(data).split("").map((c) => c.charCodeAt(0)));

const CHUNK = 1024 * 1024;
// 与 vi.mock 工厂里的字面量保持一致（256 字节硬上限 / 32 字节询问门）。
const CAP = 256;
const CONFIRM = 32;

// 门禁常量取小值便于用例构造（vi.mock 工厂被提升，常量必须内联字面量）。
vi.mock("../lib/preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/preview")>();
  return { ...actual, PREVIEW_MAX_BYTES: 256, PREVIEW_CONFIRM_BYTES: 32 };
});

function resolution(strategy: PreviewResolution["previewStrategy"], mime = "application/octet-stream"): PreviewResolution {
  return { extension: "bin", mime, kind: "unknown", previewStrategy: strategy, editable: false, editorStrategy: null, fallback: false, fallbackReason: null };
}

interface MountOptions {
  statSize?: number | null;
  statFails?: boolean;
  chunks?: Array<Uint8Array | Error>;
  sudo?: boolean;
}

function mount(options: MountOptions = {}) {
  const statSize = options.statSize;
  const chunks = [...(options.chunks ?? [])];
  const invoke = vi.fn(async (method: string, params: { path?: string; offset?: number; maxBytes?: number }) => {
    if (method === "sftp/stat" || method === "sudo/stat") {
      if (options.statFails) throw new Error("stat failed");
      return { size: statSize ?? 0 };
    }
    const chunk = chunks.shift();
    if (!chunk) return { dataBase64: "", truncated: false };
    if (chunk instanceof Error) throw chunk;
    void params;
    return { dataBase64: toB64(chunk), truncated: false };
  });
  (window as unknown as { dbxPlugin: { invoke: typeof invoke; encodeBase64: (bytes: Uint8Array) => string; decodeBase64: (data: string) => Uint8Array } }).dbxPlugin = {
    invoke,
    encodeBase64: toB64,
    decodeBase64: fromB64,
  };
  const size = ref(0);
  const error = ref("");
  const loading = ref(false);
  const mode = ref<PreviewMode>("text");
  const modes: PreviewMode[] = [];
  const resolutionRef = ref<PreviewResolution | null>(resolution("file-viewer"));
  const closed = vi.fn();
  const chunked = useChunkedPreview({
    path: () => "/f",
    perChunkBytes: () => CHUNK,
    readOnce: (path, offset, length) => invoke(options.sudo ? "sudo/readFile" : "sftp/read", { path, offset, maxBytes: length }) as Promise<{ dataBase64: string; truncated: boolean }>,
    title: () => "f.bin",
    resolution: () => resolutionRef.value,
    loading,
    sudo: () => options.sudo ?? false,
    sessionId: () => "s1",
    size,
    error,
    setMode: (value) => { mode.value = value; modes.push(value); },
    emitClose: closed,
  });
  return { chunked, size, error, loading, mode, modes, resolutionRef, closed, invoke };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("useChunkedPreview stat gate", () => {
  it("marks over-cap totals without reading any chunk", async () => {
    const { chunked, size, invoke } = mount({ statSize: CAP + 1 });
    await chunked.loadChunked(resolution("file-viewer"));
    expect(chunked.overCap.value).toBe(true);
    expect(size.value).toBe(CAP + 1);
    expect(chunked.chunkActive.value).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1); // 只有 stat
  });

  it("asks before loading large file-viewer documents and resumes on confirmation", async () => {
    const { chunked, invoke } = mount({ statSize: CONFIRM + 1, chunks: [new Uint8Array(16), new Uint8Array(17)] });
    await chunked.loadChunked(resolution("file-viewer"));
    expect(chunked.largeFile.value).toBe(true);
    expect(chunked.chunkActive.value).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);

    chunked.largeFileConfirmed.value = true;
    await chunked.previewLargeAnyway();
    expect(chunked.largeFile.value).toBe(false);
    expect(chunked.chunkActive.value).toBe(false);
    expect(chunked.sourceFile.value).toBeInstanceOf(File);
  });

  it("does not gate images even above the confirm threshold", async () => {
    const { chunked } = mount({ statSize: CONFIRM + 1, chunks: [new Uint8Array(16), new Uint8Array(17)] });
    await chunked.loadChunked(resolution("image", "image/png"));
    expect(chunked.largeFile.value).toBe(false);
  });
});

describe("useChunkedPreview chunk loop", () => {
  it("assembles known-size payloads into a viewer File and clears parts", async () => {
    const { chunked, size, loading } = mount({ statSize: 24, chunks: [new Uint8Array(16), new Uint8Array(8)] });
    chunked.newAttempt();
    await chunked.loadChunked(resolution("file-viewer"));
    expect(loading.value).toBe(false);
    expect(size.value).toBe(24);
    expect(chunked.sourceFile.value).toBeInstanceOf(File);
    expect((chunked.sourceFile.value as File).name).toBe("f.bin");
  });

  it("keeps chunkActive on failure and resumes from the failed offset", async () => {
    const boom = new Error("socket closed");
    const { chunked, error, invoke } = mount({ statSize: 24, chunks: [new Uint8Array(16), boom, new Uint8Array(8)] });
    chunked.newAttempt();
    await chunked.loadChunked(resolution("file-viewer"));
    expect(error.value).toBe("socket closed");
    expect(chunked.chunkActive.value).toBe(true);
    expect(chunked.loadedBytes.value).toBe(16);

    await chunked.resumeChunkLoad();
    expect(error.value).toBe("");
    expect(chunked.chunkActive.value).toBe(false);
    expect(chunked.sourceFile.value).toBeInstanceOf(File);
    // 1 次 stat + 2 次读（首片成功 + 失败片）+ 续传 1 次读（从 offset 16）。
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("uses truncated semantics when the size is unknown and stops at EOF", async () => {
    const invoke = vi.fn(async (method: string, params: { path?: string; offset?: number; maxBytes?: number }) => {
      void method;
      if (params.offset === 0) return { dataBase64: window.dbxPlugin.encodeBase64(new Uint8Array(16)), truncated: true };
      return { dataBase64: window.dbxPlugin.encodeBase64(new Uint8Array(8)), truncated: false };
    });
    (window as unknown as { dbxPlugin: { invoke: typeof invoke; encodeBase64: (bytes: Uint8Array) => string; decodeBase64: (data: string) => Uint8Array } }).dbxPlugin = {
      invoke,
      encodeBase64: toB64,
      decodeBase64: fromB64,
    };
    const size = ref(0);
    const error = ref("");
    const loading = ref(false);
    const modes: PreviewMode[] = [];
    const resolutionRef = ref<PreviewResolution | null>(null);
    const chunked = useChunkedPreview({
      path: () => "/f",
      perChunkBytes: () => CHUNK,
      readOnce: (path, offset, length) => invoke("sftp/read", { path, offset, maxBytes: length }) as Promise<{ dataBase64: string; truncated: boolean }>,
      title: () => "f.bin",
      resolution: () => resolutionRef.value,
      loading,
      sudo: () => false,
      sessionId: () => "s1",
      size,
      error,
      setMode: (value) => { modes.push(value); },
      emitClose: vi.fn(),
    });
    chunked.newAttempt();
    await chunked.loadChunked(resolution("file-viewer"));
    // stat 失败 → size 未知 → truncated 读到 EOF 收口，producer File 落位。
    expect(chunked.sourceFile.value).toBeInstanceOf(File);
    expect(chunked.chunkActive.value).toBe(false);
  });

  it("aborts a stale loop when a new attempt invalidates the token", async () => {
    const deferreds: Array<(chunk: Uint8Array) => void> = [];
    const invoke = vi.fn(async (method: string, _params: { path?: string; offset?: number; maxBytes?: number }) => {
      if (method === "sftp/stat") return { size: 24 };
      return await new Promise<{ dataBase64: string; truncated: boolean }>((resolve) => {
        deferreds.push((chunk) => resolve({ dataBase64: toB64(chunk), truncated: false }));
      });
    });
    (window as unknown as { dbxPlugin: { invoke: typeof invoke; encodeBase64: (bytes: Uint8Array) => string; decodeBase64: (data: string) => Uint8Array } }).dbxPlugin = {
      invoke,
      encodeBase64: toB64,
      decodeBase64: fromB64,
    };
    const size = ref(0);
    const error = ref("");
    const loading = ref(false);
    const chunked = useChunkedPreview({
      path: () => "/f",
      perChunkBytes: () => CHUNK,
      readOnce: (path, offset, length) => invoke("sftp/read", { path, offset, maxBytes: length }) as Promise<{ dataBase64: string; truncated: boolean }>,
      title: () => "f.bin",
      resolution: () => resolution("file-viewer"),
      loading,
      sudo: () => false,
      sessionId: () => "s1",
      size,
      error,
      setMode: vi.fn(),
      emitClose: vi.fn(),
    });
    chunked.newAttempt();
    void chunked.loadChunked(resolution("file-viewer"));
    await flush();
    expect(deferreds.length).toBe(1);
    // 换文件：新令牌让旧循环在下一个检查点静默退出，不写 error、不收 chunkActive。
    chunked.newAttempt();
    deferreds[0]!(new Uint8Array(16));
    await flush();
    expect(error.value).toBe("");
    expect(chunked.chunkActive.value).toBe(false);
  });
});

describe("useChunkedPreview finish", () => {
  it("builds an object URL for images and a File for viewers", async () => {
    const { chunked, modes } = mount({ statSize: 16, chunks: [new Uint8Array(16)] });
    chunked.newAttempt();
    await chunked.loadChunked(resolution("image", "image/png"));
    expect(modes).toEqual(["image"]);
    expect(chunked.dataUri.value).toMatch(/^blob:/);

    const viewer = mount({ statSize: 16, chunks: [new Uint8Array(16)] });
    viewer.chunked.newAttempt();
    await viewer.chunked.loadChunked(resolution("file-viewer", "application/pdf"));
    expect(viewer.modes).toEqual(["viewer"]);
    expect(viewer.chunked.sourceFile.value?.type).toBe("application/pdf");
  });

  it("cancels mid-flight: closes cleanly without error UI", async () => {
    const deferreds: Array<(chunk: Uint8Array) => void> = [];
    const invoke = vi.fn(async (method: string, _params: { path?: string; offset?: number; maxBytes?: number }) => {
      if (method === "sftp/stat") return { size: 24 };
      return await new Promise<{ dataBase64: string; truncated: boolean }>((resolve) => {
        deferreds.push((chunk) => resolve({ dataBase64: toB64(chunk), truncated: false }));
      });
    });
    (window as unknown as { dbxPlugin: { invoke: typeof invoke; encodeBase64: (bytes: Uint8Array) => string; decodeBase64: (data: string) => Uint8Array } }).dbxPlugin = {
      invoke,
      encodeBase64: toB64,
      decodeBase64: fromB64,
    };
    const size = ref(0);
    const error = ref("");
    const loading = ref(false);
    const closed = vi.fn();
    const chunked = useChunkedPreview({
      path: () => "/f",
      perChunkBytes: () => CHUNK,
      readOnce: (path, offset, length) => invoke("sftp/read", { path, offset, maxBytes: length }) as Promise<{ dataBase64: string; truncated: boolean }>,
      title: () => "f.bin",
      resolution: () => resolution("file-viewer"),
      loading,
      sudo: () => false,
      sessionId: () => "s1",
      size,
      error,
      setMode: vi.fn(),
      emitClose: closed,
    });
    chunked.newAttempt();
    void chunked.loadChunked(resolution("file-viewer"));
    await flush();
    chunked.cancelChunkLoad();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(chunked.chunkActive.value).toBe(false);
    deferreds[0]!(new Uint8Array(16));
    await flush();
    expect(error.value).toBe("");
  });
});
