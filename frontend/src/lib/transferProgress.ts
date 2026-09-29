/**
 * 上传进度归并(issue #60):后端把一次上传拆成两个独立计数阶段——
 * `staging`(字节缓进本地 spool 文件,速率≈本机磁盘)与 `uploading`
 * (字节真正推到 SFTP 服务器,速率≈网络)。两个阶段各自的计数都从 0
 * 起步,直接塞给 UI 会出现"3G→100M 回跳"和"20MB/s 假速度"。此归并器
 * 负责把事件流收敛成 UI 可直接消费的单一状态:
 * - staging 事件只推进 `staged`,不动 `transferred`(不虚高速度);
 * - 阶段切换允许计数重置(语义上是新计数器),同阶段内钳制单调,
 *   杂散/乱序事件不可能让进度条回跳;
 * - 无 phase 的载荷(普通下载、旧 sidecar)维持原来的单调合并行为。
 *
 * 压缩通道(M33)新增阶段:上传 `compressing`(spool 本地 gzip,分母=原始
 * 大小);下载 `compressing`(远端 gzip)/`fetching`(拉取压缩流,分母=压缩
 * 流大小)/`decompressing`(本地解压)/`ready`(prep 完成,计数清零待分块)/
 * `transferring`(压缩任务从本地 staging 分块供给,分母=原始大小)。每个
 * 阶段事件自 transferred/size 自描述,分母切换随阶段切换自然发生。
 */

export type TransferPhase = "staging" | "compressing" | "uploading" | "fetching" | "decompressing" | "ready" | "transferring";

/** 本机 CPU/磁盘阶段的字节不喂 `transferred`(与 staging 同理,避免假速度)。 */
const LOCAL_COUNTER_PHASES: readonly TransferPhase[] = ["staging", "compressing"];

export interface TransferProgressEvent {
  transferred?: unknown;
  size?: unknown;
  phase?: unknown;
  status?: unknown;
}

export interface TransferProgressState {
  /** 已推送到 SFTP 服务器的字节数(uploading 阶段计数)。 */
  transferred: number;
  /** 已缓冲进本地 spool 的字节数(staging 阶段计数);下载任务无此计数。 */
  staged?: number;
  size: number;
  phase?: TransferPhase;
}

export function normalizeTransferPhase(value: unknown): TransferPhase | undefined {
  return value === "staging" || value === "compressing" || value === "uploading" || value === "fetching" || value === "decompressing" || value === "ready" || value === "transferring" ? value : undefined;
}

function count(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function mergeTransferProgress(existing: TransferProgressState | undefined, event: TransferProgressEvent): TransferProgressState {
  const size = count(event.size, existing?.size ?? 0);
  const incoming = count(event.transferred);
  const phase = normalizeTransferPhase(event.phase) ?? existing?.phase;
  if (phase !== undefined && LOCAL_COUNTER_PHASES.includes(phase)) {
    return { transferred: existing?.transferred ?? 0, staged: incoming, size, phase };
  }
  if (phase === "ready") {
    // prep 完成标记:计数保持(下载分块即将从 0 重新计),size 回原始体积。
    return { transferred: existing?.transferred ?? 0, staged: existing?.staged ?? 0, size, phase };
  }
  if (phase !== undefined) {
    // uploading / fetching / decompressing / transferring:换阶段即换计数
    // 器(重置允许),同阶段内单调。
    const transferred = existing?.phase === phase ? Math.max(existing.transferred, incoming) : incoming;
    return { transferred, staged: existing?.staged ?? 0, size, phase };
  }
  if (String(event.status) === "completed") {
    return { transferred: size > 0 ? size : incoming, staged: existing?.staged ?? 0, size };
  }
  return { transferred: Math.max(existing?.transferred ?? 0, incoming), staged: existing?.staged ?? 0, size };
}

/**
 * 前端触发 `sftp/transfer/cancel` 时携带的原因 slug,落到后端账本的
 * error 文案里,让"自动取消"下次可定位:user=用户按钮、ack-timeout=
 * 分片确认超时、local-read-error=本地读盘失败、append-failed=sidecar
 * 拒收分片、start-failed=finish 发起失败、client-error=其余前端异常。
 */
export function transferCancelReason(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code;
  switch (code) {
    case "transfer-cancelled":
    case "transfer-terminal":
      return "user";
    case "upload-ack-timeout":
      return "ack-timeout";
    case "upload-read-failed":
      return "local-read-error";
    case "upload-append-failed":
      return "append-failed";
    case "upload-start-failed":
      return "start-failed";
    default:
      return "client-error";
  }
}
