import { computed, ref, watch } from "vue";
import { enqueueWatchModified, popWatchModified, watchName, type ModifiedPrompt, type WatchRegistry } from "../lib/watchEdits";

/** 外部编辑器回传（P2-5，桌面端；M15 起逐文件化）：watch/file-modified 确认
 * 状态机 + watch/upload 串行链。「在外部编辑器中打开」的下载/打开入口与
 * 传输队列内部状态仍在 App.vue（与传输域耦合）。 */
export function useExternalEdits(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showNotice, showError, loadDirectory } = options;

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
  };
}
