// @vitest-environment happy-dom
// issue #329：下载分块等待器的行为回归——修复前固定 30s 直接 reject 并取消
// 任务，慢链路（一片 256 KiB 读超过 30s）被误杀；修复后超时先查
// sftp/transfer/status，任务仍健康就继续等。
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSftpDownload } from "./useSftpDownload";

type ChunkWaiter = {
  offset: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: number;
};

function mountDownload(status: () => Promise<unknown>) {
  const downloadChunkWaiters = new Map<string, ChunkWaiter>();
  const invoke = vi.fn((method: string) =>
    method === "sftp/transfer/status" ? status() : Promise.resolve(undefined));
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
  const composable = useSftpDownload({
    t: (key) => key,
    showNotice: vi.fn(),
    showError: vi.fn(),
    session: ref({ sessionId: "s1" }),
    entries: ref([]),
    fileMenu: ref(undefined),
    localDownloadDir: ref(""),
    localCanSave: ref(true),
    transferTasks: {},
    cancelledTransferTasks: new Set(),
    downloadChunkWaiters,
    waitWhilePaused: () => undefined,
    loadDownloadDir: () => "",
    loadDownloadUseDefaultDir: () => true,
    askDownloadTarget: vi.fn(),
    applyChosenDirAsDefault: vi.fn(),
    resolveDownloadConflictFor: async () => "overwrite",
    openTransferPanel: vi.fn(),
    pathFromUri: (uri: string) => uri,
    sudoDownload: () => false,
  });
  return { composable, downloadChunkWaiters, invoke };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForDownloadChunk (issue #329)", () => {
  it("keeps waiting past the old 30s cap while the chunk read is still healthy", async () => {
    vi.useFakeTimers();
    const { composable, downloadChunkWaiters, invoke } = mountDownload(async () => ({ status: "running", transferred: 0 }));
    const wait = composable.waitForDownloadChunk("task-1", 0);
    let outcome = "pending";
    void wait.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledWith("sftp/transfer/status", { taskId: "task-1" });
    expect(outcome).toBe("pending");
    expect(downloadChunkWaiters.has("task-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(outcome).toBe("pending");

    // 迟到的二进制帧仍然结算等待器。
    downloadChunkWaiters.get("task-1")!.resolve(new Uint8Array([7, 8, 9]));
    await expect(wait).resolves.toEqual(new Uint8Array([7, 8, 9]));
    expect(downloadChunkWaiters.has("task-1")).toBe(false);
  });

  it("fails fast when the sidecar advanced past the offset (binary frame was lost)", async () => {
    vi.useFakeTimers();
    const { composable } = mountDownload(async () => ({ status: "running", transferred: 262_144 }));
    const wait = composable.waitForDownloadChunk("task-2", 0);
    const rejected = expect(wait).rejects.toThrow("errors.downloadChunkTimeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  it("fails immediately when the task reached a terminal state", async () => {
    vi.useFakeTimers();
    const { composable } = mountDownload(async () => ({ status: "cancelled", transferred: 0 }));
    const wait = composable.waitForDownloadChunk("task-3", 0);
    const rejected = expect(wait).rejects.toThrow("errors.downloadChunkTimeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  it("gives up after three consecutive status probe failures", async () => {
    vi.useFakeTimers();
    const { composable, invoke } = mountDownload(async () => {
      throw new Error("bridge down");
    });
    const wait = composable.waitForDownloadChunk("task-4", 0);
    const rejected = expect(wait).rejects.toThrow("errors.downloadChunkTimeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    await rejected;
  });

  it("bounds a stuck read at the per-chunk ceiling", async () => {
    vi.useFakeTimers();
    const { composable, invoke } = mountDownload(async () => ({ status: "running", transferred: 0 }));
    const wait = composable.waitForDownloadChunk("task-5", 0);
    const rejected = expect(wait).rejects.toThrow("errors.downloadChunkTimeout");
    // 首查 30s + 10 个 60s 步长后越过 10 分钟上限（t=630s）。
    await vi.advanceTimersByTimeAsync(30_000 + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(invoke.mock.calls.length).toBeGreaterThan(0);
  });
});
