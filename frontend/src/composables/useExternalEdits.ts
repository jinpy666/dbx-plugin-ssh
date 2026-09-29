import { computed, ref, watch, type Ref } from "vue";
import { enqueueWatchModified, popWatchModified, registerWatch, watchName, type ModifiedPrompt, type WatchRegistry } from "../lib/watchEdits";
import type { SftpEntryKind } from "../lib/sftpEntries";
import type { TransferTask } from "../lib/transferQueue";

/** 外部编辑条目（App.vue 局部接口 SftpEntry 按消费字段收敛）。 */
interface ExternalEditEntry {
  uri: string;
  name: string;
  kind: SftpEntryKind;
}

/** 外部编辑专用下载的 start 回显（App.vue 局部接口 DownloadInfo 按消费字段收敛）。 */
interface ExternalEditDownloadInfo {
  taskId: string;
  fileName: string;
  size: number;
}

/** 外部编辑器回传（P2-5，桌面端；M15 起逐文件化）：watch/file-modified 确认
 * 状态机 + watch/upload 串行链 +「在外部编辑器中打开」的下载/打开入口。
 * 下载走 saveToLocal 直落 remote-edit 目录，复用传输队列的暂停/chunk-waiter
 * 原语（经 options 注入；waitForDownloadChunk/probeLocalCapabilities 所在
 * composable 装配在本域之后，以惰性 getter 解 TDZ）。 */
export function useExternalEdits(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  loadDirectory: (path?: string) => Promise<void>;
  session: Ref<{ sessionId: string } | undefined>;
  openTransferPanel: () => void;
  transferTasks: Record<string, TransferTask>;
  pathFromUri: (uri: string) => string;
  waitWhilePaused: (taskId: string) => Promise<void> | undefined;
  waitForDownloadChunk: (taskId: string, offset: number) => Promise<unknown>;
  cancelledTransferTasks: Set<string>;
  downloadChunkWaiters: Map<string, { timer: number }>;
  probeLocalCapabilities: () => Promise<{ canSaveLocal: boolean; downloadsDir: string } | null | undefined>;
  loadDownloadDir: () => string;
  copyTextToClipboard: (value: string, noticeKey: string, values?: Record<string, string | number>) => void;
  closeFileMenu: () => void;
}) {
  const {
    t,
    showNotice,
    showError,
    loadDirectory,
    session,
    openTransferPanel,
    transferTasks,
    pathFromUri,
    waitWhilePaused,
    waitForDownloadChunk,
    cancelledTransferTasks,
    downloadChunkWaiters,
    probeLocalCapabilities,
    loadDownloadDir,
    copyTextToClipboard,
    closeFileMenu,
  } = options;

// —— 外部编辑器回传（P2-5，桌面端；M15 起多文件并行）：文件先经 sftp/download
// 落到 <下载目录>/remote-edit/<ts>/，watch/start 注册监听（同一会话可同时挂
// 多个远端文件，注册表按 watchId 记、同远端路径按粒度顶替）；编辑器保存经
// watch/file-modified 事件回来逐文件排队弹确认，上传走 watch/upload（sidecar
// 从本机路径读字节、原子写回远端，写门禁与其他 SFTP 写一致）。
const externalEditBusy = ref(false);
const activeExternalWatches = ref<WatchRegistry>({});
const watchModifiedQueue = ref<ModifiedPrompt[]>([]);
/** 当前待确认 = 队列头：决议（上传/总是/取消）才出队，后到文件不顶替。 */
const watchModifiedPrompt = computed<ModifiedPrompt | null>(() => watchModifiedQueue.value[0] ?? null);
// 「总是上传」记住的 watchId：同一监听上的后续保存直接推回，不再逐次确认。
const alwaysUploadWatches = new Set<string>();
// watch/upload 串行链：sidecar 的 .dbx-part 暂存本就按调用隔离，前端再把
// 回传排成一队，避免并发回传的 notice/目录刷新互相覆盖（上传不丢，逐个执行）。
let watchUploadChain: Promise<void> = Promise.resolve();

// —— 外部编辑器回传（P2-5；M15 起逐文件化）——
// watch/file-modified 的确认策略：「总是上传」的记忆命中直接进上传串行链；
// 否则事件入队、逐个弹确认框（后到文件的 modified 事件排队等待，不顶替
// 未决确认、不丢事件），用户对队头决议（上传一次 / 总是上传 / 取消）后才
// 轮到下一个文件。watch/upload 由 sidecar 从 remote-edit 下载路径读字节、
// 经 sftp/write 同款原子提交写回远端（写门禁 ensure_writable 在后端强制）。
// 完成后刷新当前目录，让大小/修改时间立即反映编辑后的内容。
function handleWatchModified(watchId: string) {
  // 不认识的 watchId（监听已被顶替/会话已关）静默丢弃，不弹窗也不上传。
  if (!activeExternalWatches.value[watchId]) return;
  if (alwaysUploadWatches.has(watchId)) {
    void uploadWatchedFile(watchId);
    return;
  }
  watchModifiedQueue.value = enqueueWatchModified(watchModifiedQueue.value, activeExternalWatches.value, watchId);
}

/** 队头决议完成（上传/取消）：弹出队头，露出下一条待确认。过期决议
 * （watchId 已不是队头）由 popWatchModified 拒绝，不动后面的文件。 */
function resolveWatchHead(watchId: string) {
  const next = popWatchModified(watchModifiedQueue.value, watchId);
  if (next) watchModifiedQueue.value = next;
}

/** watch/upload 串行链入口：排入队尾逐个执行，返回前不入队。 */
function uploadWatchedFile(watchId: string) {
  watchUploadChain = watchUploadChain.then(() => invokeWatchUpload(watchId));
}

async function invokeWatchUpload(watchId: string) {
  externalEditBusy.value = true;
  try {
    await window.dbxPlugin.invoke<{ remotePath: string; size: number }>("watch/upload", { watchId });
    showNotice(t("sftpEdit.uploaded", { name: watchName(activeExternalWatches.value, watchId) }));
    // 刷新当前目录，让大小/修改时间立即反映编辑后的内容。
    await loadDirectory();
  } catch (cause) {
    showError(cause, "sftp");
  } finally {
    externalEditBusy.value = false;
  }
}

/** 取消当前队头的确认（该文件本次保存不回传）。 */
function dismissWatchModified() {
  const prompt = watchModifiedPrompt.value;
  if (prompt) resolveWatchHead(prompt.watchId);
}

/** 「上传一次」：决议当前队头后排入上传链。 */
function uploadWatchedFileOnce() {
  const prompt = watchModifiedPrompt.value;
  if (!prompt) return;
  resolveWatchHead(prompt.watchId);
  void uploadWatchedFile(prompt.watchId);
}

/** 「总是上传」：记住当前队头的 watchId 后决议并入上传链。 */
function uploadWatchedFileAlways() {
  const prompt = watchModifiedPrompt.value;
  if (!prompt) return;
  alwaysUploadWatches.add(prompt.watchId);
  resolveWatchHead(prompt.watchId);
  void uploadWatchedFile(prompt.watchId);
}

/** 本地路径拼接（下载目录 + remote-edit 子目录），兼容结尾分隔符。 */
function joinLocalPath(dir: string, suffix: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/** 精简单文件下载（外部编辑专用）：saveToLocal 直落 `downloadDir`，冲突直接
 * 覆盖（目录带时间戳不会撞名），完成后返回 sidecar 落盘的绝对路径。 */
async function downloadForExternalEdit(entry: ExternalEditEntry, downloadDir: string): Promise<string | undefined> {
  if (!session.value || entry.kind !== "file") return undefined;
  openTransferPanel();
  const info = await window.dbxPlugin.invoke<ExternalEditDownloadInfo>("sftp/download/start", {
    sessionId: session.value.sessionId,
    remotePath: pathFromUri(entry.uri),
    saveToLocal: true,
    downloadDir,
    conflict: "overwrite",
  });
  transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "download", fileName: info.fileName, size: info.size, transferred: 0, status: "queued", joinedAt: Date.now() };
  try {
    let offset = 0;
    while (offset < info.size) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消经 chunk waiter 中断；吞掉在途请求的 rejection 以免变成 unhandled。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      await chunkPromise;
      offset += result.length;
      const task = transferTasks[info.taskId];
      if (task) {
        task.status = "running";
        task.transferred = offset;
      }
      if (result.eof) break;
    }
    const finish = await window.dbxPlugin.invoke<{ localPath?: string }>("sftp/download/finish", { taskId: info.taskId });
    cancelledTransferTasks.delete(info.taskId);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (finish?.localPath) task.localPath = finish.localPath;
    }
    return finish?.localPath;
  } catch (cause) {
    const waiter = downloadChunkWaiters.get(info.taskId);
    if (waiter) {
      window.clearTimeout(waiter.timer);
      downloadChunkWaiters.delete(info.taskId);
    }
    await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
    throw cause;
  }
}

/** 「在外部编辑器中打开」：下载 → watch/start → 系统默认程序打开 → 通知。
 * 仅桌面端可用（web/docker 的 sidecar 不在本机，无法监听也无法回传）。
 * M15 起可并发打开多个文件：每次打开独立下载、独立注册 watch，互不顶替
 * （同远端路径的重复打开由注册表与 sidecar 的 per-path dedup 收敛为最新）。 */
async function openInExternalEditor(entry: ExternalEditEntry) {
  closeFileMenu();
  if (!session.value) return;
  const local = await probeLocalCapabilities();
  if (!local?.canSaveLocal) {
    showNotice(t("sftpEdit.desktopOnly"));
    return;
  }
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dir = joinLocalPath(loadDownloadDir() || local.downloadsDir, `remote-edit/${stamp}`);
    const localPath = await downloadForExternalEdit(entry, dir);
    if (!localPath || !session.value) return;
    const remotePath = pathFromUri(entry.uri);
    const watch = await window.dbxPlugin.invoke<{ watchId: string }>("watch/start", {
      sessionId: session.value.sessionId,
      remotePath,
      localPath,
    });
    alwaysUploadWatches.delete(watch.watchId);
    activeExternalWatches.value = registerWatch(activeExternalWatches.value, {
      watchId: watch.watchId,
      name: entry.name,
      remotePath,
    });
    // 宿主 local/open 校验该路径确为本插件完成的下载（防任意路径打开）。
    try {
      await window.dbxPlugin.invoke("local/open", { path: localPath });
    } catch {
      await window.dbxPlugin.invoke("local/reveal", { path: localPath });
    }
    copyTextToClipboard(localPath, "sftpEdit.pathCopied");
    showNotice(t("sftpEdit.watching", { name: entry.name }));
  } catch (cause) {
    showError(cause, "sftp");
  }
}

  return {
    externalEditBusy,
    activeExternalWatches,
    watchModifiedQueue,
    watchModifiedPrompt,
    alwaysUploadWatches,
    handleWatchModified,
    dismissWatchModified,
    uploadWatchedFileOnce,
    uploadWatchedFileAlways,
    joinLocalPath,
    openInExternalEditor,
  };
}
