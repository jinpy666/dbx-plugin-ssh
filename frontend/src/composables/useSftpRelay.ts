import { ref, type Ref } from "vue";
import { runTransfers } from "../lib/transferQueue";
import { buildRelayQueue, relayTargetOptions, type RelayTargetOption } from "../lib/sftpRelay";
import type { BatchSendTarget } from "../lib/batchSend";
import { pluginStore } from "../lib/pluginStore";

/**
 * SFTP 跨会话传输（issue #334 阶段 1）：右键「发送到会话…」把当前面板选中
 * 的文件经前端中继泵到另一台在线服务器。
 *
 * 字节路径（不新增 sidecar 方法，全部复用既有管线）：
 * - 下载腿：`sftp/download/start`（saveToLocal:false）→ `sftp/download/next`
 *   + 二进制帧等待器逐片取**原始字节**（压缩通道只影响 wire，交付恒为明文，
 *   gzip 任务需先等 staging ready）；
 * - 上传腿：`uploadSource(..., { sessionId: 目标会话 })`——与批量上传同一
 *   跨连接投递通道，传输面板卡片/取消/暂停/并发上限全部继承；
 * - 中继泵串在 uploadSource 的 readChunk 里：上传循环逐片拉取，天然背压，
 *   内存峰值只有一片。
 *
 * 阶段 1 仅支持普通文件（文件夹中继 = 远端树遍历 + 逐目录建目录，阶段 2）。
 * sudo 车道不参与：跨机中继按普通车道走，源端 root 属主文件读不到就如实
 * 失败，不做静默换道。
 */

/** 上次使用的目标目录（pluginStore：沙箱内 opaque origin 只能经宿主 storage 落盘）。 */
const RELAY_TARGET_DIR_KEY = "ssh-relay-target-dir";

function loadRelayTargetDir(): string {
  try {
    return pluginStore.getItem(RELAY_TARGET_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistRelayTargetDir(value: string) {
  try {
    pluginStore.setItem(RELAY_TARGET_DIR_KEY, value);
  } catch {
    // 存储不可用只失去记忆，发送本身不受影响。
  }
}

interface RelayDownloadStart {
  taskId: string;
  fileName: string;
  size: number;
  chunkSize: number;
  compression?: string;
}

/** 中继队列行：面板条目 + 稳定调度 key（同名文件不能共用 id）。 */
interface RelayQueueRow {
  key: string;
  name: string;
  uri: string;
}

export function useSftpRelay(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  connected: Ref<boolean>;
  session: Ref<{ sessionId: string } | undefined>;
  currentPath: Ref<string>;
  /** 批量目标刷新（useBatchSend.refreshBatchTargets）后读全量列表：含连接名覆盖与本地行（本模块自行过滤）。 */
  loadBatchTargets: () => Promise<BatchSendTarget[]>;
  /** 传输队列入口（useTransferQueue）：sessionId 显式传入即按目标会话投递。 */
  uploadSource: (
    name: string,
    size: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
    resume?: { taskId: string; remotePath: string },
    targetDir?: string,
    extra?: { sessionId?: string; batchId?: string; sudoLane?: boolean },
  ) => Promise<boolean>;
  /** 下载分块二进制等待器（useSftpDownload）：帧路由按 taskId 全局分发。 */
  waitForDownloadChunk: (taskId: string, offset: number) => Promise<Uint8Array>;
  /** 压缩下载的 staging 等待（useSftpDownload）：gzip 任务 prep 就绪前 download/next 报错。 */
  waitForDownloadReady: (taskId: string, compression: string | undefined) => Promise<void>;
  loadTransferConcurrency: () => number;
  pathFromUri: (uri: string) => string;
  openTransferPanel: () => void;
}) {
  const { t, showNotice, showError, connected, session, currentPath, loadBatchTargets, uploadSource, waitForDownloadChunk, waitForDownloadReady, loadTransferConcurrency, pathFromUri, openTransferPanel } = options;

  // 对话框态：relayPrompt 为 null = 关闭；skipped 随批次展示/提示。
  const relayPrompt = ref<{ count: number; skipped: number } | null>(null);
  const relayTargets = ref<RelayTargetOption[]>([]);
  const relayTargetSession = ref("");
  const relayTargetDir = ref("");
  const relayBusy = ref(false);
  let relayRows: RelayQueueRow[] = [];
  let relaySkipped = 0;
  let relaySeq = 0;

  /** 右键「发送到会话…」：规划批次 + 拉目标列表 + 打开对话框。无可选目标时
   * 直接报错不开框（比打开一个空下拉更直接）。 */
  async function openSendToSession(entries: ReadonlyArray<{ name: string; kind: string; uri: string }>) {
    if (!connected.value || relayBusy.value) return;
    const plan = buildRelayRows(entries);
    if (!plan.rows.length) {
      showError(new Error(t("sftpRelay.filesOnly")), "sftp");
      return;
    }
    let targets: RelayTargetOption[] = [];
    try {
      targets = relayTargetOptions(await loadBatchTargets(), session.value?.sessionId ?? "");
    } catch (cause) {
      showError(cause, "sftp");
      return;
    }
    if (!targets.length) {
      showError(new Error(t("sftpRelay.noTargets")), "sftp");
      return;
    }
    relayRows = plan.rows;
    relaySkipped = plan.skipped;
    relayTargets.value = targets;
    relayTargetSession.value = targets[0]?.sessionId ?? "";
    relayTargetDir.value = loadRelayTargetDir() || currentPath.value;
    relayPrompt.value = { count: plan.rows.length, skipped: plan.skipped };
  }

  function closeSendToSession() {
    if (relayBusy.value) return;
    relayPrompt.value = null;
  }

  /** 单文件中继：下载腿原始字节 → uploadSource 逐片泵到目标会话。 */
  async function relayOne(row: RelayQueueRow, sourceSessionId: string, targetSessionId: string, targetDir: string, batchId: string): Promise<boolean> {
    const info = await window.dbxPlugin.invoke<RelayDownloadStart>("sftp/download/start", {
      sessionId: sourceSessionId,
      // M27-A 路径形态契约：下载 start 只吃列表回传的 wire 形式。
      remotePath: pathFromUri(row.uri),
      saveToLocal: false,
    });
    // 压缩任务等 staging ready（未就绪时 download/next 直接报错）。
    await waitForDownloadReady(info.taskId, info.compression);
    let pullOffset = 0;
    let pullEof = false;
    // uploadSource 的泵严格顺序推进（offset 单调），中继只服务顺序读；
    // 乱序请求视为管线状态破坏，按读失败终止（uploadSource 会把
    // readChunk 异常标记 upload-read-failed 并取消任务）。
    const readChunk = async (offset: number): Promise<Uint8Array> => {
      if (offset !== pullOffset || pullEof) throw new Error(t("errors.downloadChunkLength"));
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消经等待器中断；在途请求的 rejection 吞掉避免 unhandled。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      pullOffset += chunk.byteLength;
      if (result.eof) pullEof = true;
      return chunk;
    };
    try {
      const done = await uploadSource(row.name, info.size, readChunk, undefined, targetDir, {
        sessionId: targetSessionId,
        batchId,
        sudoLane: false,
      });
      await window.dbxPlugin.invoke("sftp/download/finish", { taskId: info.taskId }, { timeoutMs: 60_000 });
      return done;
    } catch (cause) {
      // 上传腿失败/取消：回收下载腿（任务取消，sidecar 顺带清远端临时件），
      // 原样上抛让 runTransfers 记账（用户取消不中止整批，语义继承）。
      await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
      throw cause;
    }
  }

  async function confirmSendToSession() {
    if (relayBusy.value || !relayPrompt.value) return;
    const targetSessionId = relayTargetSession.value.trim();
    if (!targetSessionId) return;
    const sourceSessionId = session.value?.sessionId;
    if (!sourceSessionId) return;
    const targetDir = relayTargetDir.value.trim() || "/";
    const targetLabel = relayTargets.value.find((target) => target.sessionId === targetSessionId)?.label || targetSessionId;
    const total = relayRows.length;
    const skipped = relaySkipped;
    persistRelayTargetDir(targetDir);
    relayBusy.value = true;
    openTransferPanel();
    const batchId = `relay-${++relaySeq}`;
    let uploaded = 0;
    try {
      // 目标目录 ensure：已存在/无权限等失败静默放行——真正的缺失会在
      // upload/start 明确报错（任务卡失败），这里不替用户猜语义。
      await window.dbxPlugin.invoke("sftp/createDirectory", { sessionId: targetSessionId, path: targetDir }).catch(() => undefined);
      await runTransfers(relayRows, Math.max(1, loadTransferConcurrency()), {
        id: (row) => row.key,
        run: async (row) => {
          const done = await relayOne(row, sourceSessionId, targetSessionId, targetDir, batchId);
          if (done) uploaded += 1;
        },
      });
    } catch (cause) {
      showError(cause, "sftp");
    } finally {
      relayBusy.value = false;
      relayPrompt.value = null;
    }
    if (uploaded === total) {
      showNotice(t("sftpRelay.completed", { count: uploaded, target: targetLabel }));
    } else {
      showNotice(t("sftpRelay.completedWithFailures", { count: total - uploaded, total, target: targetLabel }));
    }
    if (skipped) showNotice(t("sftpRelay.skippedNote", { count: skipped }));
  }

  return {
    relayPrompt,
    relayTargets,
    relayTargetSession,
    relayTargetDir,
    relayBusy,
    openSendToSession,
    closeSendToSession,
    confirmSendToSession,
  };
}

/** 面板条目 → 中继行：只留普通文件，附稳定调度 key（同名文件各自成行）。 */
function buildRelayRows(entries: ReadonlyArray<{ name: string; kind: string; uri: string }>): { rows: RelayQueueRow[]; skipped: number } {
  const plan = buildRelayQueue(entries);
  return {
    rows: plan.files.map((entry, index) => ({ key: `relay-${index}`, name: entry.name, uri: entry.uri })),
    skipped: plan.skipped,
  };
}
