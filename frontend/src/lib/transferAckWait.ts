// 分片 ACK 兜底轮询（自 useTransferQueue 纯搬移）。issue #305：分片 ACK 事件
// 丢失时不再死等 30s——按阶梯轮询 sftp/transfer/status 兜底。3s 首查（健康链路
// ACK 亚秒到达，缺席即异常），之后 8s/15s/30s 退避重查；transferred 达标即放行，
// 大分片慢链路不受影响（轮询只在 ACK 缺席时发生，正常传输零额外 RPC）。
// issue #237：轮询触发即给任务挂 ackLagging 标记（卡片外显「确认滞后」），
// 串行停等链路上的静默卡住变成可感知状态；等待器结算（ACK 事件、error 事件、
// 兜底轮询放行/拒绝、面板分离拒绝）一律先清标记再收场。

export interface TransferAckWaitDeps {
  /** ACK 缺席时挂可感知标记（任务已被清收则跳过——账本耦合留在调用方）。 */
  markAckLagging: (taskId: string) => void;
  /** 本等待器结算（放行/拒绝）时清除标记。 */
  clearAckLagging: (taskId: string) => void;
  /** 任务当前错误文案（终态拒绝时的 message 兜底）。 */
  taskError: (taskId: string) => string | undefined;
  /** 终态本地化文案（transferStatus.*）。 */
  statusLabel: (status: string) => string;
  /** 状态快照查询（sftp/transfer/status）；失败（sidecar 重启中/任务已清收）
   * 由本机制按阶梯继续重试，封顶后以 30s 周期持续轮询直到结算。 */
  fetchStatus: (taskId: string) => Promise<{ transferred: number; status: string }>;
}

const UPLOAD_ACK_POLL_STEPS_MS = [3_000, 8_000, 15_000, 30_000];

export function createUploadAckWait(deps: TransferAckWaitDeps) {
  // 原样暴露：ACK/error 桥事件（usePluginEvents）与取消路径直接结算这张表的
  // 条目（clearTimeout + delete + resolve/reject），机制外移不改外部消费形态。
  const waiters = new Map<string, { nextOffset: number; resolve: () => void; reject: (error: Error) => void; timer: number }>();

  function waitForAck(taskId: string, nextOffset: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const resolveSettled = () => {
        deps.clearAckLagging(taskId);
        resolve();
      };
      const rejectSettled = (error: Error) => {
        deps.clearAckLagging(taskId);
        reject(error);
      };
      const settle = (outcome: () => void) => {
        waiters.delete(taskId);
        outcome();
      };
      const poll = (step: number) => {
        const delay = UPLOAD_ACK_POLL_STEPS_MS[Math.min(step, UPLOAD_ACK_POLL_STEPS_MS.length - 1)]!;
        const timer = window.setTimeout(async () => {
          deps.markAckLagging(taskId);
          try {
            const status = await deps.fetchStatus(taskId);
            if (status.transferred >= nextOffset && status.status !== "cancelled" && status.status !== "failed") {
              settle(resolveSettled);
              return;
            }
            if (status.status === "cancelled" || status.status === "failed") {
              settle(() => rejectSettled(Object.assign(new Error(deps.taskError(taskId) || deps.statusLabel(status.status)), { code: status.status === "cancelled" ? "transfer-cancelled" : "transfer-terminal" })));
              return;
            }
            poll(step + 1);
          } catch {
            // 状态查询失败（sidecar 重启中/任务已清收）：按阶梯继续重试；
            // 封顶后以 30s 周期持续轮询直到结算（评审 H-1 同款：轻量 RPC
            // 不设次数上限），大分片慢链路的 ACK 迟到不再被误杀。
            poll(step + 1);
          }
        }, delay);
        waiters.set(taskId, { nextOffset, resolve: resolveSettled, reject: rejectSettled, timer });
      };
      poll(0);
    });
  }

  return { waitForAck, waiters };
}
