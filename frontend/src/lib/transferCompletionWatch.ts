// 终态收尾等待器（自 useTransferQueue 纯搬移）：finish RPC 只负责把远端推送
// 交给 sidecar 后台任务，真正的完成/失败经终态 progress 事件回传，这里据此
// 结算。评审 H-1（2026-09-30）：等待器自带 watchdog 轮询——终态事件丢失（宿主
// 桥抖动）或 sidecar 在长推送期间重启时，靠 sftp/transfer/status 兜底结算，
// 不再让 uploadSource 永久挂起拖死整批队列。
// issue #305：固定 15s 的首轮兜底正是「几 KB 小文件成功提示迟到十几秒」
// 的主因——事件丢失后用户至少要盯着一动不动的卡片等一整轮。改为 1s 起步
// 逐级退避：健康链路事件亚秒到达，轮询只是丢失后的保险；退避到 15s 封顶，
// 长推送期间也不会产生高频轮询。

export interface TransferCompletionWatchDeps {
  /** 任务当前错误文案（结算拒绝时的 message 兜底，来自任务账本）。 */
  taskError: (taskId: string) => string | undefined;
  /** 终态本地化文案（transferStatus.*）。 */
  statusLabel: (status: string) => string;
  /** 终态兜底轮询：true = 终态已入账且等待器已结算（sftp/transfer/status）。 */
  pollStatus: (taskId: string) => Promise<boolean>;
}

const COMPLETION_WATCHDOG_STEPS_MS = [1_000, 2_000, 4_000, 8_000];
const COMPLETION_WATCHDOG_MAX_MS = 15_000;

export function createTransferCompletionWatch(deps: TransferCompletionWatchDeps) {
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; watchdog: number }>();

  function armWatchdog(taskId: string, step = 0): number {
    const delay = step < COMPLETION_WATCHDOG_STEPS_MS.length ? COMPLETION_WATCHDOG_STEPS_MS[step]! : COMPLETION_WATCHDOG_MAX_MS;
    return window.setTimeout(async () => {
      if (!waiters.has(taskId)) return;
      if (await deps.pollStatus(taskId)) return;
      const waiter = waiters.get(taskId);
      if (waiter) waiter.watchdog = armWatchdog(taskId, step + 1);
    }, delay);
  }

  /** 终态事件结算 finish 之后的收尾等待器：completed 兑现；cancelled 按用户
   * 取消回传（transfer-cancelled 码，runTransfers 据此继续派发剩余项，评审
   * H-3）；failed 才视为批次失败。其余状态不结算（不触碰等待器）。 */
  function settle(taskId: string, status: string): void {
    const waiter = waiters.get(taskId);
    if (!waiter || (status !== "completed" && status !== "cancelled" && status !== "failed")) return;
    waiters.delete(taskId);
    window.clearTimeout(waiter.watchdog);
    if (status === "completed") waiter.resolve();
    else waiter.reject(Object.assign(new Error(deps.taskError(taskId) || deps.statusLabel(status)), { code: status === "cancelled" ? "transfer-cancelled" : "transfer-terminal" }));
  }

  /** 挂起直到该任务收到终态 progress 事件（完成/取消/失败）；注册前已终态则
   * 立即结算，否则挂等待器并武装 watchdog 轮询兜底（评审 H-1）。后台推送可
   * 持续数十分钟（issue #60），轮询只是轻量 RPC，不设次数上限。 */
  function waitFor(taskId: string, currentStatus?: string): Promise<void> {
    if (currentStatus === "completed" || currentStatus === "cancelled" || currentStatus === "failed") {
      return currentStatus === "completed" ? Promise.resolve() : Promise.reject(Object.assign(new Error(deps.taskError(taskId) || deps.statusLabel(currentStatus)), { code: currentStatus === "cancelled" ? "transfer-cancelled" : "transfer-terminal" }));
    }
    return new Promise<void>((resolve, reject) => {
      waiters.set(taskId, { resolve, reject, watchdog: armWatchdog(taskId) });
    });
  }

  return { settle, waitFor, waiters };
}
