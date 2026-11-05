// 传输历史（sftp/transfer/history）：响应收敛与枚举归一（纯逻辑，无 Vue 依赖）。
// 后端环形 200，面板一次取 50。
export const TRANSFER_HISTORY_LIMIT = 50;

export type TransferStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
// sftp/transfer/history 行（落盘历史 + 内存 live 合并视图）：status 沿用现有枚举、无 queued。
export interface TransferHistoryEntry {
  taskId: string;
  sessionId?: string;
  connectionId?: string;
  direction: "upload" | "download";
  fileName: string;
  size: number;
  transferred: number;
  status: "running" | "completed" | "cancelled" | "failed";
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  localPath?: string;
}

export function normalizeTransferStatus(value: unknown, fallback: TransferStatus = "running"): TransferStatus {
  return ["queued", "running", "completed", "cancelled", "failed"].includes(String(value)) ? String(value) as TransferStatus : fallback;
}

/** 收敛 sftp/transfer/history 响应：丢畸形行，方向/状态收敛到已知枚举（镜像 normalizeTransferStatus）。 */
export function sanitizeTransferHistoryTasks(raw: unknown): TransferHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TransferHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const taskId = typeof record.taskId === "string" ? record.taskId : "";
    if (!taskId) continue;
    // 历史枚举无 queued；异常遗留 queued 行按 running 展示（保守降级，不丢条目）。
    const status = normalizeTransferStatus(record.status, "completed");
    out.push({
      taskId,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      connectionId: typeof record.connectionId === "string" ? record.connectionId : undefined,
      direction: record.direction === "download" ? "download" : "upload",
      fileName: typeof record.fileName === "string" ? record.fileName : "",
      size: Number(record.size ?? 0) || 0,
      transferred: Number(record.transferred ?? 0) || 0,
      status: status === "queued" ? "running" : status,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
      finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
      error: typeof record.error === "string" && record.error ? record.error : undefined,
      localPath: typeof record.localPath === "string" && record.localPath ? record.localPath : undefined,
    });
  }
  return out;
}

const pad2 = (value: number, width = 2) => String(value).padStart(width, "0");

/** issue #269 历史卡片时间显示：startedAt → 本地 `YYYY-MM-DD HH:mm`；
 * 缺失/非法时间戳返回空串，模板侧 v-if 隐藏该段。 */
export function formatHistoryStartedAt(startedAt?: number): string {
  if (!Number.isFinite(startedAt) || (startedAt ?? 0) <= 0) return "";
  const date = new Date(startedAt!);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** issue #269 耗时展示（卡片 title 提示用）：startedAt→finishedAt 的 `H:MM:SS` /
 * `MM:SS`，不足一秒显示 `<1s`；缺任一端或终点早于起点返回空串。 */
export function formatHistoryDuration(startedAt?: number, finishedAt?: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return "";
  const ms = (finishedAt ?? 0) - (startedAt ?? 0);
  if (ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds <= 0) return "<1s";
  const hours = Math.floor(totalSeconds / 3600);
  // 跨小时段分钟补零（1:01:01）；纯分:秒保持常规读法（1:05 而非 01:05）。
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const body = `${pad2(minutes, hours > 0 ? 2 : 1)}:${pad2(totalSeconds % 60)}`;
  return hours > 0 ? `${hours}:${body}` : body;
}
