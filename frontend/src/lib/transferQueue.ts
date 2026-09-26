// 传输并发调度（P1-5）：把 App 里"固定 3 路并发"的硬编码抽成可配置的
// 调度策略。槽位语义：running 与 paused 都占位（暂停中的任务不释放并发
// 槽，恢复后原地继续），done/cancelled 释放；多方向混合队列按方向计数
// 均衡取件，同方向保持入队顺序。纯调度 + 一个可注入 runner 的编排函数。

export type TransferDirection = "upload" | "download";

export type TransferQueueStatus = "queued" | "running" | "paused" | "done" | "cancelled";

/** 上传重复目标策略：rename（自动重命名，默认）/ ask（每次询问）/ overwrite（覆盖）。 */
export type TransferDuplicatePolicy = "rename" | "ask" | "overwrite";

export const TRANSFER_DUPLICATE_POLICIES: readonly TransferDuplicatePolicy[] = ["rename", "ask", "overwrite"];

export function sanitizeTransferDuplicatePolicy(value: unknown, fallback: TransferDuplicatePolicy = "rename"): TransferDuplicatePolicy {
  return value === "rename" || value === "ask" || value === "overwrite" ? value : fallback;
}

export interface TransferQueueItem {
  id: string;
  direction: TransferDirection;
  status: TransferQueueStatus;
}

export interface RunTransfersOptions<T> {
  /** 每个元素的稳定 id（取消/完成状态回写用）。 */
  id: (item: T) => string;
  /** 方向抽取器；缺省视为 upload（现有两条入口都是上传批次）。 */
  direction?: (item: T) => TransferDirection;
  /** 单个传输的执行体；抛错 = 该项取消（释放槽位）并停止派发后续项。 */
  run: (item: T) => Promise<void>;
}

/** 占用并发槽的状态：暂停项占位不释放，取消/完成项释放。 */
function occupiesSlot(status: TransferQueueStatus): boolean {
  return status === "running" || status === "paused";
}

export function transferSlotsInUse(queue: readonly TransferQueueItem[]): number {
  return queue.reduce((count, item) => count + (occupiesSlot(item.status) ? 1 : 0), 0);
}

function slotsByDirection(queue: readonly TransferQueueItem[], direction: TransferDirection): number {
  return queue.reduce((count, item) => count + (occupiesSlot(item.status) && item.direction === direction ? 1 : 0), 0);
}

/** 传输并发上限钳制：1..10，非法值回落 3。 */
export function clampTransferConcurrency(value: unknown, fallback = 3): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(10, Math.max(1, Math.floor(parsed)));
}

/**
 * 会话级传输并发深度（M14-B）：1..8，非法值回落 3。与批次队列的
 * clampTransferConcurrency（1..10）是两个维度：本值约束同一 SSH 会话
 * 同时活跃的传输任务数（sidecar 权威），批次值约束前端批量派发。
 */
export function clampTransferMaxActive(value: unknown, fallback = 3): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(8, Math.max(1, Math.floor(parsed)));
}

/**
 * 下载限速（issue #66）：0..1048576 KiB/s（0=不限速，缺省），非法值回落 0。
 * 与 sidecar preferences 的 sanitize_transfer_download_limit_kib 同向钳制。
 */
export const TRANSFER_DOWNLOAD_LIMIT_KIB_MAX = 1_048_576;

export function clampTransferDownloadLimit(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(TRANSFER_DOWNLOAD_LIMIT_KIB_MAX, Math.floor(parsed));
}

/**
 * 下一个可派发的排队项；没有空槽或没有可跑项时返回 null。
 * 全局槽位用 `runningCount` 传入（running + paused 之和），方向均衡只在
 * 有多个方向可跑时影响取件顺序，不改变全局上限。
 */
export function nextRunnable<T extends TransferQueueItem>(queue: readonly T[], runningCount: number, limit: number): T | null {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const active = Math.max(0, Math.floor(runningCount));
  if (active >= boundedLimit) return null;
  let best: T | null = null;
  let bestDirectionSlots = Number.POSITIVE_INFINITY;
  for (const item of queue) {
    if (item.status !== "queued") continue;
    const directionSlots = slotsByDirection(queue, item.direction);
    if (directionSlots < bestDirectionSlots) {
      best = item;
      bestDirectionSlots = directionSlots;
    }
  }
  return best;
}

/**
 * 按调度策略批量执行传输：并发上限内逐个取 queued 项置 running 并交给
 * runner；runner 抛错视为该项取消（状态 cancelled、槽位释放）并向外传播，
 * 失败后不再派发新项（在途项自然跑完）。
 */
export async function runTransfers<T>(items: readonly T[], limit: number, options: RunTransfersOptions<T>): Promise<void> {
  const directionOf = options.direction ?? (() => "upload" as TransferDirection);
  const tracked: TransferQueueItem[] = items.map((item, index) => ({
    id: options.id(item) || `transfer-${index}`,
    direction: directionOf(item),
    status: "queued",
  }));
  if (!tracked.length) return;
  const byId = new Map(tracked.map((item) => [item.id, item]));
  const originals = new Map(tracked.map((item, index) => [item.id, items[index]]));
  let failed = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const next = nextRunnable(tracked, transferSlotsInUse(tracked), limit);
      if (!next) return;
      next.status = "running";
      try {
        await options.run(originals.get(next.id)!);
        byId.get(next.id)!.status = "done";
      } catch (cause) {
        byId.get(next.id)!.status = "cancelled";
        failed = true;
        throw cause;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(clampTransferConcurrency(limit), tracked.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
