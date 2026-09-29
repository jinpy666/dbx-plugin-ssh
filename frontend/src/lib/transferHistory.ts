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
