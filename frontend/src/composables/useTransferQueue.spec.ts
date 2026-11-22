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
  const sendBinary = vi.fn(async () => {});
  (window as unknown as { dbxPlugin: { invoke: typeof invoke; sendBinary: typeof sendBinary } }).dbxPlugin = { invoke, sendBinary };
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

// ---------------------------------------------------------------------------
// issue #305：小文件上传「一直卡着没动静，过很久才显示成功」——终态 progress
// 事件或分片 ACK 事件在宿主桥上丢失时，兜底轮询的时间常数收敛：
// 完成 watchdog 从固定 15s 改为 1s 起步逐级退避；分片 ACK 等待器从一次性
// 30s 改为 3s 起步的状态轮询阶梯（大分片慢链路不误伤：轮询只在 ACK 缺席时
// 发生，且 transferred 达标即放行）。
// ---------------------------------------------------------------------------

describe("兜底轮询时间常数 (#305)", () => {
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("完成事件丢失时 watchdog 首轮 1s 即轮询状态并结算", async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      let statusPolls = 0;
      const queue = mountQueue({
        "sftp/upload/start": async () => ({ taskId: "t1", chunkSize: 512 }),
        "sftp/upload/finish": async () => {
          finished = true;
          return undefined;
        },
        "sftp/transfer/status": async () => {
          statusPolls += 1;
          return { transferred: 0, status: finished ? "completed" : "running" };
        },
      });
      const pending = queue.uploadSource("a.bin", 0, async () => new Uint8Array(0));
      await tick(0);
      // 模拟终态事件丢失：不喂 updateTransfer，只靠 watchdog 兜底
      await tick(1_000);
      expect(statusPolls).toBe(1);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog 逐级退避：1s→2s，未终态继续等", async () => {
    vi.useFakeTimers();
    try {
      let statusPolls = 0;
      const pollTimes: number[] = [];
      const queue = mountQueue({
        "sftp/upload/start": async () => ({ taskId: "t1", chunkSize: 512 }),
        "sftp/upload/finish": async () => undefined,
        "sftp/transfer/status": async () => {
          statusPolls += 1;
          pollTimes.push(Date.now());
          return { transferred: 0, status: statusPolls >= 2 ? "completed" : "running" };
        },
      });
      const pending = queue.uploadSource("a.bin", 0, async () => new Uint8Array(0));
      await tick(0);
      await tick(1_000);
      await tick(2_000);
      expect(pollTimes).toHaveLength(2);
      expect(pollTimes[1]! - pollTimes[0]!).toBe(2_000);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("分片 ACK 丢失时 3s 状态轮询兜底继续传输（原实现要等满 30s）", async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      let statusPolls = 0;
      const queue = mountQueue({
        "sftp/upload/start": async () => ({ taskId: "t1", chunkSize: 512 }),
        "sftp/upload/finish": async () => {
          finished = true;
          return undefined;
        },
        "sftp/transfer/status": async () => {
          statusPolls += 1;
          return { transferred: 8, status: finished ? "completed" : "running" };
        },
      });
      const pending = queue.uploadSource("a.bin", 8, async () => new Uint8Array(8));
      await tick(0);
      await tick(3_000);
      // 3s 内状态轮询已兜底 ACK 缺席，无需等满 30s
      expect(statusPolls).toBe(1);
      await tick(1_000);
      await expect(pending).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ACK 缺席兜底轮询期间外显「确认滞后」标记，结算即清除（#237）", async () => {
    vi.useFakeTimers();
    try {
      let finished = false;
      let transferred = 0;
      const queue = mountQueue({
        "sftp/upload/start": async () => ({ taskId: "t1", chunkSize: 512 }),
        "sftp/upload/finish": async () => {
          finished = true;
          return undefined;
        },
        "sftp/transfer/status": async () => ({ transferred, status: finished ? "completed" : "running" }),
      });
      const pending = queue.uploadSource("a.bin", 8, async () => new Uint8Array(8));
      await tick(0);
      // ACK 事件缺席但兜底轮询未触发：卡片不应提前报滞后
      expect(queue.transferTasks["t1"]?.ackLagging).toBeUndefined();
      await tick(3_000);
      // 兜底轮询触发且 spool 尚未推进：串行停等链路上的静默卡住变成可感知状态
      expect(queue.transferTasks["t1"]?.ackLagging).toBe(true);
      transferred = 8;
      await tick(8_000);
      await tick(1_000);
      await expect(pending).resolves.toBe(true);
      // 等待器结算（兜底轮询放行）即清除标记
      expect(queue.transferTasks["t1"]?.ackLagging).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
