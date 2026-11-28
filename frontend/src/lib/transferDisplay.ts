// 传输任务展示助手（自 useTransferQueue 纯搬移）：进度条取值、本地阶段字节
// 口径与精确 tooltip。纯函数，不依赖任务账本。

import type { TransferTask } from "./transferQueue";

export function transferPercent(task: TransferTask): number {
  return task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : task.status === "completed" ? 100 : 0;
}

/** 本机 CPU/磁盘阶段（staging/compressing/decompressing）与 prep 就绪标记
 * 走不定态进度条；网络阶段（uploading/fetching/transferring）用真实百分比
 * （压缩任务各阶段事件自带分母，切换自然衔接）。 */
const INDETERMINATE_BAR_PHASES: ReadonlySet<string> = new Set(["staging", "compressing", "decompressing", "ready"]);

export function transferBarValue(task: TransferTask): number | undefined {
  return task.phase !== undefined && INDETERMINATE_BAR_PHASES.has(task.phase) ? undefined : transferPercent(task);
}

/** staging/compressing 行展示的字节数：本地阶段计数（spool 缓存/压缩输入）；
 * 其余阶段是已推送/已接收计数。 */
export function transferShownBytes(task: TransferTask): number {
  return task.phase === "staging" || task.phase === "compressing" ? task.staged ?? 0 : task.transferred;
}

/** 精确字节数 tooltip：化解 5.9GB(十进制) vs 5.49GiB(二进制) 的口径困惑（issue #60）。 */
export function transferBytesTitle(task: TransferTask): string | undefined {
  if (!(task.size > 0)) return undefined;
  return `${transferShownBytes(task).toLocaleString()} / ${task.size.toLocaleString()} bytes`;
}
