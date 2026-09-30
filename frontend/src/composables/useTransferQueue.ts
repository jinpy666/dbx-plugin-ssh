import { type TransferTask } from "../lib/transferQueue";
import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue";
import { normalizeTransferStatus } from "../lib/transferHistory";
import { isLiveTransferStatus, sortTransferTasks } from "../lib/transferOrder";
import { mergeTransferProgress, transferCancelReason } from "../lib/transferProgress";
import { clampTransferConcurrency, clampTransferDownloadLimit, clampTransferMaxActive, sanitizeTransferDuplicatePolicy, type TransferDuplicatePolicy } from "../lib/transferQueue";
import { transferPausable } from "../lib/transferResume";
import { sampleTransferSpeed, type TransferSpeedSample } from "../lib/transferSpeed";
import { Download } from "@lucide/vue";

/** 传输队列核心（上传/下载统一账本）：任务记录（终态清收 ring）、进度事件
 * 归并与速度采样、暂停/取消语义、断点恢复对账、面板数据源与展示助手、
 * 传输偏好（并发/重复策略/限速，权威态在内存 + sidecar preferences 同步）。
 * uploadSource 是唯一上传入口（useTransferHistory 断点续传/粘贴/拖拽/快速
 * 命令条共用）；选择器/确认弹窗/下载落盘入口仍在 App.vue。 */
export function useTransferQueue(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  session: Ref<{ sessionId?: string } | undefined>;
  currentPath: Ref<string>;
  panelSurface: Ref<boolean>;
  resolveUploadDuplicateName: (name: string, targetDir: string) => Promise<{ proceed: boolean; name: string }>;
  joinRemote: (parent: string, name: string) => string;
  writeU64: (bytes: Uint8Array, offset: number, value: number) => void;
  syncPrefs: () => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  refreshTransferHistory: () => Promise<void>;
  refreshResumableUploads: () => Promise<void>;
}) {
  const { t, showError, session, currentPath, panelSurface, resolveUploadDuplicateName, joinRemote, writeU64, syncPrefs, refreshTransferHistory, refreshResumableUploads } = options;

// preferences 权威存储，localStorage 仅作同步缓存（语义同下载偏好）。
const TRANSFER_CONCURRENCY_KEY = "ssh-transfer-concurrency";
const TRANSFER_MAX_ACTIVE_KEY = "ssh-transfer-max-active";
// 下载限速（issue #66，KiB/s，0=不限速缺省）：同一偏好链路持久化。
const TRANSFER_DOWNLOAD_LIMIT_KEY = "ssh-transfer-download-limit-kib";

const TRANSFER_DUPLICATE_KEY = "ssh-transfer-duplicate-policy";

const transferConcurrencyState = ref(3);

const transferMaxActiveState = ref(3);
// 下载限速权威态（KiB/s，0=不限速）；sidecar preferences 同步。
const transferDownloadLimitState = ref(0);

const transferDuplicateState = ref<TransferDuplicatePolicy>("rename");

const transferTasks = reactive<Record<string, TransferTask>>({});
// 断点续传（F1）：暂停中的任务（两分片之间生效）；等待恢复的回调登记表。
const pausedTaskIds = reactive(new Set<string>());
const pauseWaiters = new Map<string, Array<() => void>>();
// 后端扫描出的可续传上传任务（spool 前缀仍在磁盘上）。
const transferPanelOpen = ref(false);

const transferSpeeds = reactive<Record<string, number>>({});

// 下载历史项右键：只为已有本机落盘路径提供定位/打开操作；taskId 用于按卡受控打开。
const transferHistoryMenu = ref<{ taskId: string }>();

const uploadAckWaiters = new Map<string, { nextOffset: number; resolve: () => void; reject: (error: Error) => void; timer: number }>();
// 上传收尾等待器（issue #60）：finish RPC 只负责把远端推送交给 sidecar
// 后台任务，真正的完成/失败经终态 progress 事件回传，这里据此结算。
// 评审 H-1（2026-09-30）：等待器自带 watchdog 轮询——终态事件丢失（宿主
// 桥抖动）或 sidecar 在长推送期间重启时，靠 sftp/transfer/status 兜底
// 结算，不再让 uploadSource 永久挂起拖死整批队列。
const COMPLETION_WATCHDOG_MS = 15_000;
const transferCompletionWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; watchdog: number }>();
const downloadChunkWaiters = new Map<string, { offset: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: number }>();
const transferSamples = new Map<string, TransferSpeedSample>();
// Download task ids the user cancelled from the transfer panel; lets the download
// loop distinguish a user cancel (notice) from a real failure (error banner).
const cancelledTransferTasks = new Set<string>();

// 活跃区只显示进行中的任务（queued/running），按 transferOrder 的稳定规则
// 排序：先开始/先加入的排最上，同键用 taskId 兜底（issue #18）。此前这里
// 按对象插入序渲染全部任务：插入序来自后端 HashMap 迭代序 + 事件到达序，
// 终态行还永久堆积，同一张卡就会在面板里"一会儿在上、一会儿在中间、一会儿
// 在下"。终态行由历史区承接（落盘 + 内存合并视图），转终态的同一拍刷新。
const transferList = computed(() =>
  sortTransferTasks(Object.values(transferTasks).filter((task) => isLiveTransferStatus(task.status))),
);
const activeTransfers = computed(() => transferList.value.filter((task) => task.status === "queued" || task.status === "running").length);

function updateTransfer(params: Record<string, unknown>) {
  const taskId = String(params.taskId || "");
  if (!taskId) return;
  const existing = transferTasks[taskId];
  const status = normalizeTransferStatus(params.status, existing?.status);
  const progress = mergeTransferProgress(existing, params);
  // 速度只采样真实网络推送（uploading/fetching/transferring 阶段）：
  // staging 字节走本机内存/磁盘，压缩/解压是本机 CPU 段，计入都会显示
  // 假速度（issue #60；M33 扩展本地阶段集合）。阶段切换时重置采样窗口。
  const phaseChanged = progress.phase !== existing?.phase;
  if (progress.phase === undefined || progress.phase === "uploading" || progress.phase === "fetching" || progress.phase === "transferring") {
    const sample = sampleTransferSpeed(phaseChanged ? undefined : transferSamples.get(taskId), progress.transferred, performance.now());
    transferSamples.set(taskId, sample);
    transferSpeeds[taskId] = sample.speed;
  } else {
    transferSamples.delete(taskId);
    transferSpeeds[taskId] = 0;
  }
  // 目录下载事件附带的树内字段（fileCount/currentFile）有则透传；
  // 文件下载事件不带这些键，保持原有行为。（issue #46）
  const fileCount = params.fileCount !== undefined ? Number(params.fileCount) : existing?.fileCount;
  const currentFile = typeof params.currentFile === "string" ? params.currentFile : existing?.currentFile;
  // 压缩通道标记（M33）：prep 回退事件（compression=none）清掉徽标。
  const compression = params.compression === "gzip" ? "gzip" as const : params.compression === "none" ? undefined : existing?.compression;
  transferTasks[taskId] = {
    taskId,
    sessionId: String(params.sessionId || existing?.sessionId || ""),
    direction: params.direction === "download" ? "download" : existing?.direction || "upload",
    fileName: String(params.fileName || existing?.fileName || ""),
    size: progress.size,
    transferred: progress.transferred,
    staged: progress.staged,
    phase: progress.phase,
    compression,
    status,
    error: typeof params.error === "string" ? params.error : existing?.error,
    joinedAt: existing?.joinedAt ?? Date.now(),
    fileCount: Number.isFinite(fileCount) && fileCount! > 0 ? fileCount : undefined,
    currentFile: currentFile || undefined,
  };
  settleTransferCompletion(taskId, status);
  if (!isLiveTransferStatus(status)) scheduleTerminalTaskSweep(taskId);
  if (!existing && isLiveTransferStatus(transferTasks[taskId].status)) {
    // 面板已开时不得重开：openTransferPanel 的"先收口再开"会卸载弹层、
    // 复位滚动位置，用户正往下看历史时会被弹回顶部（issue #18）。互斥族
    // 保证面板开着时没有其他弹层，直接置 open 即可。Dock panel surface
    // 同样不弹：面板是单一聚焦终端，传输记录入口整体禁用。
    if (!transferPanelOpen.value && !panelSurface.value) transferPanelOpen.value = true;
  }
}

// —— 终态任务清收 ——
// transferTasks/transferSpeeds 此前只在视图层过滤，记录本身永不清收：长会话
// 成千上万次小传输会持续累积响应式对象并放大每次进度写入的依赖追踪成本。
// 终态后保留一小段时间供用户看到结果，随后删除任务与速度/采样记录；记录
// 总量超 ring 上限时最老终态先删。活跃任务永不清理；记录删除后同一 taskId
// 再来事件会照常重建（updateTransfer 的 !existing 分支）。
const TERMINAL_TASK_RETENTION_MS = 30_000;
const TERMINAL_TASK_RING_LIMIT = 200;
const terminalTaskSweepTimers = new Map<string, number>();

function dropTransferRecord(taskId: string) {
  const timer = terminalTaskSweepTimers.get(taskId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    terminalTaskSweepTimers.delete(taskId);
  }
  delete transferTasks[taskId];
  delete transferSpeeds[taskId];
  transferSamples.delete(taskId);
}

function scheduleTerminalTaskSweep(taskId: string) {
  if (terminalTaskSweepTimers.has(taskId)) return;
  terminalTaskSweepTimers.set(
    taskId,
    window.setTimeout(() => {
      terminalTaskSweepTimers.delete(taskId);
      dropTransferRecord(taskId);
    }, TERMINAL_TASK_RETENTION_MS),
  );
  enforceTransferRecordRing();
}

function enforceTransferRecordRing() {
  let overflow = Object.keys(transferTasks).length - TERMINAL_TASK_RING_LIMIT;
  if (overflow <= 0) return;
  const sweepable = Object.values(transferTasks)
    .filter((task) => !isLiveTransferStatus(task.status) && terminalTaskSweepTimers.has(task.taskId))
    .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
  for (const task of sweepable) {
    if (overflow <= 0) break;
    dropTransferRecord(task.taskId);
    overflow -= 1;
  }
}

onBeforeUnmount(() => {
  for (const timer of terminalTaskSweepTimers.values()) window.clearTimeout(timer);
  terminalTaskSweepTimers.clear();
});

/** 终态事件结算 finish 之后的收尾等待器：completed 兑现；cancelled 按用户
 * 取消回传（transfer-cancelled 码，runTransfers 据此继续派发剩余项，评审
 * H-3）；failed 才视为批次失败。 */
function settleTransferCompletion(taskId: string, status: TransferTask["status"]) {
  const waiter = transferCompletionWaiters.get(taskId);
  if (!waiter || (status !== "completed" && status !== "cancelled" && status !== "failed")) return;
  transferCompletionWaiters.delete(taskId);
  window.clearTimeout(waiter.watchdog);
  if (status === "completed") waiter.resolve();
  else if (status === "cancelled") waiter.reject(Object.assign(new Error(transferTasks[taskId]?.error || t(`transferStatus.${status}`)), { code: "transfer-cancelled" }));
  else waiter.reject(Object.assign(new Error(transferTasks[taskId]?.error || t(`transferStatus.${status}`)), { code: "transfer-terminal" }));
}

/** 后端状态快照统一入账（评审 H-1）：面板对账与 watchdog 轮询共用——
 * 终态才生效，且必须穿过 settleTransferCompletion。此前 reconcile 直接改
 * task.status 绕过结算，事件丢失后等待器永不兑现、批次挂死。 */
function applyTransferStatusSnapshot(taskId: string, status: { transferred?: number; status: string; phase?: string }): boolean {
  const task = transferTasks[taskId];
  if (!task) return true;
  const normalized = normalizeTransferStatus(status.status, task.status);
  if (normalized !== "queued" && normalized !== "running") {
    task.status = normalized;
    if (status.transferred != null) {
      // staging 阶段的 transferred 字段是 spool 字节数，不能覆盖真实推送计数。
      if (status.phase === "staging") task.staged = status.transferred;
      else task.transferred = status.transferred;
    }
    settleTransferCompletion(taskId, normalized);
    if (!isLiveTransferStatus(normalized)) scheduleTerminalTaskSweep(taskId);
    return true;
  }
  return false;
}

/** 终态兜底轮询：终态已入账返回 true（等待器已结算）；否则继续等下一轮。
 * 查询失败（sidecar 重启中/任务已被清收）不算终态。 */
async function pollTransferStatus(taskId: string): Promise<boolean> {
  try {
    const status = await window.dbxPlugin.invoke<{ transferred?: number; status: string; phase?: string }>("sftp/transfer/status", { taskId });
    return applyTransferStatusSnapshot(taskId, status);
  } catch {
    return false;
  }
}

function armCompletionWatchdog(taskId: string): number {
  return window.setTimeout(async () => {
    if (!transferCompletionWaiters.has(taskId)) return;
    if (await pollTransferStatus(taskId)) return;
    const waiter = transferCompletionWaiters.get(taskId);
    if (waiter) waiter.watchdog = armCompletionWatchdog(taskId);
  }, COMPLETION_WATCHDOG_MS);
}

/** 挂起直到该任务收到终态 progress 事件（完成/取消/失败）；注册前已终态则
 * 立即结算，否则挂等待器并武装 watchdog 轮询兜底（评审 H-1）。后台推送可
 * 持续数十分钟（issue #60），轮询只是轻量 RPC，不设次数上限。 */
function waitForTransferCompletion(taskId: string) {
  const existing = transferTasks[taskId];
  const status = existing?.status;
  if (status === "completed" || status === "cancelled" || status === "failed") {
    return status === "completed" ? Promise.resolve() : Promise.reject(Object.assign(new Error(existing?.error || t(`transferStatus.${status}`)), { code: status === "cancelled" ? "transfer-cancelled" : "transfer-terminal" }));
  }
  return new Promise<void>((resolve, reject) => {
    transferCompletionWaiters.set(taskId, { resolve, reject, watchdog: armCompletionWatchdog(taskId) });
  });
}

async function restoreTransfers() {
  if (!session.value) return;
  const result = await window.dbxPlugin.invoke<{ tasks: TransferTask[] }>("sftp/transfer/list", { sessionId: session.value.sessionId }).catch(() => ({ tasks: [] }));
  for (const task of result.tasks) {
    // 后端 list 的 staging 行把 spool 字节放在 transferred 里；恢复到本地
    // 状态时归位到 staged，避免重挂后进度条展示阶段计数（issue #60）。
    if (task.phase === "staging") {
      task.staged = task.transferred;
      task.transferred = 0;
    }
    const existing = transferTasks[task.taskId];
    // joinedAt 只在首次见到时落一次：后端返回序（HashMap 迭代序）不再影响
    // 活跃区排序（issue #18）。
    transferTasks[task.taskId] = { ...task, joinedAt: existing?.joinedAt ?? Date.now() };
  }
}

/**
 * 面板打开时对账活跃任务：逐个向后端查询 `sftp/transfer/status`，后端已不
 * 认识的任务（sidecar 重启、页面重载后错过终态事件的“僵尸行”）标记为失败，
 * 终态以服务端为准。查询失败视为任务已死——存活任务的状态查询总会成功。
 * 入账统一走 applyTransferStatusSnapshot（评审 H-1）：直接改状态会绕过
 * settleTransferCompletion，事件丢失时 uploadSource 的收尾等待永不兑现。
 */
async function reconcileActiveTransfers() {
  for (const task of Object.values(transferTasks)) {
    if (task.status !== "queued" && task.status !== "running") continue;
    try {
      const status = await window.dbxPlugin.invoke<{ transferred?: number; status: string; phase?: string }>("sftp/transfer/status", { taskId: task.taskId });
      applyTransferStatusSnapshot(task.taskId, status);
    } catch {
      task.status = "failed";
      task.error = t("transfersHistory.interrupted");
      settleTransferCompletion(task.taskId, "failed");
    }
  }
}


/** Refresh every data source rendered by the transfer popover. */
async function refreshTransferPanel() {
  await Promise.all([
    refreshTransferHistory(),
    refreshResumableUploads(),
    restoreTransfers(),
  ]);
  await reconcileActiveTransfers();
}

// 打开传输面板或任一任务转为终态时拉取历史：终态卡从活跃区消失的同一拍
// 进入历史区，不等最后一个任务结束（issue #18：有传输任务时历史也要可查）。
// 打开面板的同时对账活跃任务，防止错过终态事件的行永远卡在 running。
watch(transferPanelOpen, (open) => {
  if (open) {
    void refreshTransferPanel();
  }
});
const liveTransferIds = computed(() =>
  transferList.value.map((task) => task.taskId).join("|"),
);
watch(liveTransferIds, (current, previous) => {
  if (!transferPanelOpen.value) return;
  const before = new Set((previous ?? "").split("|").filter(Boolean));
  const after = new Set(current.split("|").filter(Boolean));
  // 只有任务离开活跃集合（转终态）才刷新；新任务加入由面板打开路径负责。
  const departed = [...before].some((taskId) => !after.has(taskId));
  if (departed) void refreshTransferHistory();
});

function loadTransferConcurrency(): number {
  return transferConcurrencyState.value;
}

function persistTransferConcurrency(value: number) {
  transferConcurrencyState.value = clampTransferConcurrency(value);
  void syncPrefs();
}

function loadTransferDuplicatePolicy(): TransferDuplicatePolicy {
  return transferDuplicateState.value;
}

function persistTransferDuplicatePolicy(value: TransferDuplicatePolicy) {
  transferDuplicateState.value = sanitizeTransferDuplicatePolicy(value);
  void syncPrefs();
}

// M14-B 三键读写（设置弹窗经适配器调用）。
function loadTransferMaxActive(): number {
  return transferMaxActiveState.value;
}

function persistTransferMaxActive(value: number) {
  transferMaxActiveState.value = clampTransferMaxActive(value);
  void syncPrefs();
}

// 下载限速（issue #66）：设置弹窗经适配器读写，权威态在此。
function loadTransferDownloadLimit(): number {
  return transferDownloadLimitState.value;
}

function persistTransferDownloadLimit(value: number) {
  transferDownloadLimitState.value = clampTransferDownloadLimit(value);
  void syncPrefs();
}

async function uploadSource(name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string, options?: { duplicatePreCheckedAbsent?: boolean }) {
  if (!session.value) return;
  // resume 携带原 taskId/remotePath：后端校验 spool meta 后从已传前缀续接。
  // targetDir 仅新上传生效（终端拖入的自定义目标目录）；缺省仍是 SFTP 当前目录。
  const dir = targetDir ?? currentPath.value;
  // 重复目标预检（P1-5）：仅新上传生效；rename 可能改写最终远端文件名，
  // 后续 remotePath 与传输面板展示名都用解析后的名字。duplicatePreChecked-
  // Absent（评审 M-4）：文件夹批量 ask 模式已逐文件预检过不存在，跳过二次
  // sftp/exists（千文件目录少一半往返）。
  let uploadName = name;
  if (!resume && !options?.duplicatePreCheckedAbsent) {
    const resolved = await resolveUploadDuplicateName(name, dir);
    if (!resolved.proceed) return;
    uploadName = resolved.name;
  }
  const info = await window.dbxPlugin.invoke<{ taskId: string; chunkSize: number; resumeOffset?: number; compression?: string }>("sftp/upload/start", resume
    ? { sessionId: session.value.sessionId, remotePath: resume.remotePath, size, resumeTaskId: resume.taskId }
    : { sessionId: session.value.sessionId, remotePath: joinRemote(dir, uploadName), size });
  const startOffset = info.resumeOffset ?? 0;
  // 压缩通道标记（M33）：start 响应即带决策结果，任务卡建卡时就点徽标；
  // 后续 progress 事件（恒带 compression）接手维护，回退时以 none 清除。
  transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "upload", fileName: uploadName, size, transferred: startOffset, compression: info.compression === "gzip" ? "gzip" : undefined, status: startOffset > 0 ? "running" : "queued", joinedAt: Date.now() };
  try {
    let offset = startOffset;
    while (offset < size) {
      await waitWhilePaused(info.taskId);
      let chunk: Uint8Array;
      try {
        chunk = await readChunk(offset, info.chunkSize);
      } catch (cause) {
        throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { code: "upload-read-failed" });
      }
      if (!chunk.byteLength) throw new Error(t("errors.localFileShortRead"));
      const payload = new Uint8Array(8 + chunk.byteLength);
      writeU64(payload, 0, offset);
      payload.set(chunk, 8);
      const nextOffset = offset + chunk.byteLength;
      const ack = waitForUploadAck(info.taskId, nextOffset);
      await window.dbxPlugin.sendBinary(`sftp/upload/${info.taskId}`, payload);
      await ack;
      offset = nextOffset;
    }
    // finish RPC 只把远端推送交给 sidecar 后台任务就返回（多 GB 文件的推送
    // 可达数十分钟，长持 RPC 会被桥上任何一端的 deadline 判死并"自动取消"，
    // issue #60）；真正的完成/失败由终态 progress 事件回传，这里等它落地。
    try {
      await window.dbxPlugin.invoke("sftp/upload/finish", { taskId: info.taskId }, { timeoutMs: 60_000 });
    } catch (cause) {
      throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { code: "upload-start-failed" });
    }
    await waitForTransferCompletion(info.taskId);
  } catch (cause) {
    await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId, reason: transferCancelReason(cause) }).catch(() => undefined);
    throw cause;
  }
}

function waitForUploadAck(taskId: string, nextOffset: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(async () => {
      uploadAckWaiters.delete(taskId);
      try {
        const status = await window.dbxPlugin.invoke<{ transferred: number; status: string }>("sftp/transfer/status", { taskId });
        if (status.transferred >= nextOffset && status.status === "running") resolve();
        else reject(Object.assign(new Error(t("errors.uploadAckTimeout")), { code: "upload-ack-timeout" }));
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }, 30_000);
    uploadAckWaiters.set(taskId, { nextOffset, resolve, reject, timer });
  });
}

// 分片循环在每个分片之间调用；暂停时挂起，恢复后继续。
function waitWhilePaused(taskId: string): Promise<void> | undefined {
  if (!pausedTaskIds.has(taskId)) return undefined;
  return new Promise((resolve) => {
    const waiters = pauseWaiters.get(taskId) ?? [];
    waiters.push(resolve);
    pauseWaiters.set(taskId, waiters);
  });
}

function releasePause(taskId: string) {
  if (pausedTaskIds.delete(taskId)) {
    for (const waiter of pauseWaiters.get(taskId) ?? []) waiter();
  }
  pauseWaiters.delete(taskId);
}

function toggleTransferPause(task: TransferTask) {
  if (!transferPausable(task.status)) return;
  if (pausedTaskIds.has(task.taskId)) releasePause(task.taskId);
  else pausedTaskIds.add(task.taskId);
}

async function cancelTransfer(task: TransferTask) {
  releasePause(task.taskId);
  if (task.direction === "download") {
    // Reject the pending chunk waiter so the download loop exits immediately
    // instead of waiting for its 30s timeout; the backend cancel follows below.
    const waiter = downloadChunkWaiters.get(task.taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      downloadChunkWaiters.delete(task.taskId);
      waiter.reject(new Error(t("transferStatus.cancelled")));
    }
    cancelledTransferTasks.add(task.taskId);
  } else {
    // 上传取消对称地立即释放 ack 等待器（评审 H-3）：后端取消即摘任务，
    // ack 永不再来——不等 30s 超时。错误码 transfer-cancelled 让
    // runTransfers 把用户取消与真实失败区分开、继续派发剩余项。
    const waiter = uploadAckWaiters.get(task.taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      uploadAckWaiters.delete(task.taskId);
      waiter.reject(Object.assign(new Error(t("transferStatus.cancelled")), { code: "transfer-cancelled" }));
    }
  }
  // reason=user 让后端账本把"用户主动取消"与异常清理区分开（issue #60）。
  await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: task.taskId, reason: "user" }).catch((cause) => showError(cause));
}

function transferPercent(task: TransferTask) {
  return task.size > 0 ? Math.min(100, Math.round((task.transferred / task.size) * 100)) : task.status === "completed" ? 100 : 0;
}

/** 本机 CPU/磁盘阶段（staging/compressing/decompressing）与 prep 就绪标记
 * 走不定态进度条；网络阶段（uploading/fetching/transferring）用真实百分比
 * （压缩任务各阶段事件自带分母，切换自然衔接）。 */
const INDETERMINATE_BAR_PHASES: ReadonlySet<string> = new Set(["staging", "compressing", "decompressing", "ready"]);

function transferBarValue(task: TransferTask): number | undefined {
  return task.phase !== undefined && INDETERMINATE_BAR_PHASES.has(task.phase) ? undefined : transferPercent(task);
}

/** staging/compressing 行展示的字节数：本地阶段计数（spool 缓存/压缩输入）；
 * 其余阶段是已推送/已接收计数。 */
function transferShownBytes(task: TransferTask): number {
  return task.phase === "staging" || task.phase === "compressing" ? task.staged ?? 0 : task.transferred;
}

/** 精确字节数 tooltip：化解 5.9GB(十进制) vs 5.49GiB(二进制) 的口径困惑（issue #60）。 */
function transferBytesTitle(task: TransferTask): string | undefined {
  if (!(task.size > 0)) return undefined;
  return `${transferShownBytes(task).toLocaleString()} / ${task.size.toLocaleString()} bytes`;
}


  return {
    TRANSFER_CONCURRENCY_KEY,
    TRANSFER_MAX_ACTIVE_KEY,
    TRANSFER_DOWNLOAD_LIMIT_KEY,
    TRANSFER_DUPLICATE_KEY,
    transferTasks,
    pausedTaskIds,
    transferPanelOpen,
    transferSpeeds,
    transferHistoryMenu,
    transferConcurrencyState,
    transferMaxActiveState,
    transferDownloadLimitState,
    transferDuplicateState,
    cancelledTransferTasks,
    uploadAckWaiters,
    downloadChunkWaiters,
    transferList,
    activeTransfers,
    updateTransfer,
    restoreTransfers,
    reconcileActiveTransfers,
    refreshTransferPanel,
    loadTransferConcurrency,
    persistTransferConcurrency,
    loadTransferDuplicatePolicy,
    persistTransferDuplicatePolicy,
    loadTransferMaxActive,
    persistTransferMaxActive,
    loadTransferDownloadLimit,
    persistTransferDownloadLimit,
    uploadSource,
    waitWhilePaused,
    toggleTransferPause,
    cancelTransfer,
    transferPercent,
    transferBarValue,
    transferShownBytes,
    transferBytesTitle,
  };
}
