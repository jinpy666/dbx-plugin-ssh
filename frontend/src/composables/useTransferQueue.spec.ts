// @vitest-environment happy-dom
// issue #272 回归守卫：上传占位卡。start RPC（exists/rename-unique/upload-
// start 多次往返 + 大文件压缩决策）落地前面板必须有「排队中」占位卡——
// 100M+ 文件拖入后不再是一段空白等待。占位卡三条出路都不得遗留 pending 卡：
// 转正（真任务卡顶替且 joinedAt 延续，活跃区排序稳定）、重复目标放弃、start 抛错。
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useTransferQueue } from "./useTransferQueue";

/** 挂载最小上传队列：invoke 桩按方法分发，未注册方法一律 resolve(undefined)。 */
function mountQueue(handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {}, overrides?: { duplicateProceed?: boolean }) {
  const invoke = vi.fn((method: string, ...rest: unknown[]) => {
    const handler = handlers[method];
    if (!handler) return Promise.resolve(undefined);
    return handler(...rest);
  });
  (window as unknown as { dbxPlugin: { invoke: typeof invoke } }).dbxPlugin = { invoke };
  return useTransferQueue({
    t: (key) => key,
    session: ref({ sessionId: "s1" }),
    currentPath: ref("/root"),
    panelSurface: ref(false),
    resolveUploadDuplicateName: async () => ({ proceed: overrides?.duplicateProceed ?? true, name: "a.bin" }),
    joinRemote: (parent: string, name: string) => `${parent}/${name}`,
    writeU64: () => {},
    syncPrefs: () => {},
    showError: vi.fn(),
    refreshTransferHistory: async () => {},
    refreshResumableUploads: async () => {},
    sudoUpload: () => false,
  });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function pendingKeyOf(queue: ReturnType<typeof useTransferQueue>): string | undefined {
  return Object.keys(queue.transferTasks).find((key) => key.startsWith("pending-upload-"));
}

describe("uploadSource 占位卡 (#272)", () => {
  it("start 落地前就有排队占位卡；转正后占位卡消失、joinedAt 延续", async () => {
    let settleStart!: (value: { taskId: string; chunkSize: number }) => void;
    const started = new Promise<{ taskId: string; chunkSize: number }>((resolve) => {
      settleStart = resolve;
    });
    const queue = mountQueue({
      "sftp/upload/start": () => started,
      // size=0 跳过分片循环；finish 交后台推送后由测试注入终态事件结算。
      "sftp/upload/finish": async () => undefined,
    });
    const pending = queue.uploadSource("a.bin", 0, async () => new Uint8Array(0));
    await flush();
    const key = pendingKeyOf(queue);
    expect(key).toBeDefined();
    const joinedAt = queue.transferTasks[key!].joinedAt;
    expect(queue.transferTasks[key!]).toMatchObject({ direction: "upload", fileName: "a.bin", status: "queued" });
    settleStart({ taskId: "t1", chunkSize: 512 });
    await flush();
    expect(pendingKeyOf(queue)).toBeUndefined();
    expect(queue.transferTasks.t1).toMatchObject({ fileName: "a.bin", status: "queued" });
    expect(queue.transferTasks.t1.joinedAt).toBe(joinedAt);
    queue.updateTransfer({ taskId: "t1", status: "completed", transferred: 0 });
    await expect(pending).resolves.toBe(true);
  });

  it("重复目标放弃时移除占位卡", async () => {
    const queue = mountQueue({}, { duplicateProceed: false });
    await expect(queue.uploadSource("a.bin", 10, async () => new Uint8Array(0))).resolves.toBe(false);
    expect(pendingKeyOf(queue)).toBeUndefined();
  });

  it("start 抛错时移除占位卡并把错误原样抛出", async () => {
    const queue = mountQueue({
      "sftp/upload/start": async () => {
        throw new Error("start boom");
      },
    });
    await expect(queue.uploadSource("a.bin", 10, async () => new Uint8Array(0))).rejects.toThrow("start boom");
    expect(pendingKeyOf(queue)).toBeUndefined();
  });
});
