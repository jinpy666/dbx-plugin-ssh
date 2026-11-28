// SFTP 下载分块 ACK 的等待/兜底策略（issue #329）。
//
// `waitForDownloadChunk` 覆盖整个 `sftp/download/next` 往返：sidecar 先读满
// 一片（TRANSFER_CHUNK_SIZE = 256 KiB）再发二进制帧。旧实现只有一个固定
// 30s 定时器，超时即 reject 并取消任务——慢链路（高延迟/低带宽）或远端磁盘
// 繁忙时，健康但读得慢的一片会被误杀，用户看到的正是
// `errors.downloadChunkTimeout`「SFTP 下载分块等待超时」。
//
// issue #305 已把上传分片 ACK 的同类固定 30s 死线改成阶梯轮询；下载侧漏了
// 这一处，这里按同一口径收敛：
//
//  - 首次 30s（旧上限）后查 `sftp/transfer/status`：
//  - 仍在跑且 `transferred <= offset` → 只是读得慢，继续等（60s 重查），
//    单块总等待上限 10 分钟（256 KiB 10 分钟 ≈ 0.43 KiB/s，确属卡死）；
//  - `transferred > offset` → sidecar 已推进到下一位并发出过本片二进制帧，
//    说明事件在桥接层丢了：立即失败，不做无意义的无限等待；
//  - 终态（failed/cancelled/completed）→ 立即失败；
//  - 状态查询连续失败 3 次 → 视为 sidecar 失联，失败。
//
// 纯函数只负责步长与分类，等待器本身在 useSftpDownload 里。

/** 首次兜底：与旧固定上限一致，健康链路（含慢速但正常的一片）不付额外 RPC。 */
export const DOWNLOAD_CHUNK_WAIT_FIRST_MS = 30_000;
/** 首次之后的重查间隔；只在首查判定「仍在跑」时才会排下一次。 */
export const DOWNLOAD_CHUNK_WAIT_STEP_MS = 60_000;
/** 单块等待总上限：超过即按卡死处理（用户仍可手动取消）。 */
export const DOWNLOAD_CHUNK_WAIT_MAX_MS = 10 * 60_000;
/** 连续状态查询失败上限（桥抖动容忍），超过即判定无法确认任务存活。 */
export const DOWNLOAD_CHUNK_WAIT_MAX_STATUS_FAILURES = 3;

export type DownloadChunkWaitOutcome = "keep-waiting" | "chunk-lost" | "terminal" | "unavailable";

export interface DownloadChunkStatusSnapshot {
  status?: unknown;
  transferred?: unknown;
}

/** 第 `step` 次兜底（0 = 首次，随后固定步长）的等待毫秒数。 */
export function downloadChunkWaitDelayMs(step: number): number {
  return step <= 0 ? DOWNLOAD_CHUNK_WAIT_FIRST_MS : DOWNLOAD_CHUNK_WAIT_STEP_MS;
}

/**
 * 分块等待超时后的处置分类。`offset` 是本次等待的分片起点；sidecar 只有在
 * 读完并发出该片二进制帧后才把 `next_offset` 推进到 `offset + length`，因此
 * `transferred > offset` 是「帧已发、本端没收到」的确定证据。
 */
export function classifyDownloadChunkWait(
  snapshot: DownloadChunkStatusSnapshot | null | undefined,
  offset: number,
): DownloadChunkWaitOutcome {
  if (!snapshot || typeof snapshot !== "object") return "unavailable";
  const status = typeof snapshot.status === "string" ? snapshot.status : "";
  if (status === "failed" || status === "cancelled" || status === "completed") return "terminal";
  const transferred = typeof snapshot.transferred === "number" && Number.isFinite(snapshot.transferred)
    ? snapshot.transferred
    : undefined;
  if (transferred !== undefined && transferred > offset) return "chunk-lost";
  return "keep-waiting";
}
