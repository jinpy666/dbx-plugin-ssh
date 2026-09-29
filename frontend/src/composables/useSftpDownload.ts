import { type Ref } from "vue";
import type { SftpEntryKind } from "../lib/sftpEntries";
import type { TransferTask } from "../lib/transferQueue";

type DownloadListEntry = { uri: string; name: string; kind: SftpEntryKind; size?: number };
import { confirmDialog } from "../lib/confirmDialog";
import { formatBytes } from "../lib/format";
import { MIB } from "../lib/settingsModel";
import { folderDownloadOutcome, type FolderDownloadFinish } from "../lib/sftpFolderDownload";
import { standaloneArrayBuffer } from "../lib/standaloneBuffer";

/** SFTP 下载落盘链：单文件/目录/批量下载（saveToLocal 直落 vs 分块拉取）、
 * 本机能力探测缓存、宿主 saveFile 兜底（沙箱 iframe 内 <a download> 被静默
 * 丢弃，issue #93）、下载目录/「每次询问」/冲突策略联动、落盘后定位/打开。
 * 分块暂停/取消等待器经 useTransferQueue 解构传入（引用语义）。 */
export function useSftpDownload(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp", retry?: () => void) => void;
  session: Ref<{ sessionId?: string } | undefined>;
  entries: Ref<DownloadListEntry[]>;
  fileMenu: Ref<{ entry: DownloadListEntry; selection: string[] } | undefined>;
  localDownloadDir: Ref<string>;
  localCanSave: Ref<boolean>;
  transferTasks: Record<string, TransferTask>;
  cancelledTransferTasks: Set<string>;
  downloadChunkWaiters: Map<string, { offset: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void; timer: number }>;
  waitWhilePaused: (taskId: string) => Promise<void> | undefined;
  loadDownloadDir: () => string;
  loadDownloadUseDefaultDir: () => boolean;
  askDownloadTarget: (fileName: string) => Promise<{ dir: string; setDefault: boolean } | undefined>;
  applyChosenDirAsDefault: (dir: string) => void;
  resolveDownloadConflictFor: (dir: string, fileName: string) => Promise<"rename" | "overwrite" | undefined>;
  openTransferPanel: () => void;
  pathFromUri: (uri: string) => string;
}) {
  const { t, showNotice, showError, session, entries, fileMenu, localDownloadDir, localCanSave, transferTasks, cancelledTransferTasks, downloadChunkWaiters, waitWhilePaused, loadDownloadDir, loadDownloadUseDefaultDir, askDownloadTarget, applyChosenDirAsDefault, resolveDownloadConflictFor, openTransferPanel, pathFromUri } = options;

// 列表条目/下载起始信息的最小结构（App.vue 的 SftpEntry/DownloadInfo 为局部接口）。
type DownloadListEntry = { uri: string; name: string; kind: SftpEntryKind; size?: number };
type DownloadStartInfo = { taskId: string; fileName: string; size: number; chunkSize: number; resumeOffset?: number; fileCount?: number; compression?: string; [key: string]: unknown };

// Above this size the browser download path buffers the whole file in memory, so ask first.
const WEB_DOWNLOAD_WARNING_BYTES = 512 * MIB;

/** 压缩下载的 prep 等待（M33）：start 返回 compression=gzip 时，sidecar 正
 * 在后台做「远端 gzip/tar → 拉取 → 本地解压」，分块泵必须等 ready 才能开
 * 始（staging 未就绪时 download/next 直接报错）。事件丢失时以 status 轮询
 * 兜底（1s 间隔，ready 标记 / 任务消失 / 用户取消三种出口），上限 15 分钟
 * ——16GiB 归档的打包+解压在本机盘上也不该更久。 */
async function waitForDownloadReady(taskId: string, compression: string | undefined): Promise<void> {
  if (compression !== "gzip") return;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    if (cancelledTransferTasks.has(taskId)) throw new Error(t("transferStatus.cancelled"));
    const status = await window.dbxPlugin.invoke<{ ready?: boolean } | undefined>("sftp/transfer/status", { taskId }).catch(() => undefined);
    if (!status) throw new Error(t("errors.downloadChunkTimeout"));
    if (status.ready) return;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error(t("transferCompress.prepTimeout"));
}

// 本机落盘能力探测（sidecar local/capabilities）：宿主缺 fileTransfer API 时，
// 桌面端 sidecar 可直接把下载写进本机下载目录；web/docker 模式探测失败或
// canSaveLocal=false 时回退浏览器 <a download>。结果按工作台生命周期缓存。
let localCapabilities: Promise<{ canSaveLocal: boolean; downloadsDir: string } | undefined> | undefined;

function probeLocalCapabilities() {
  localCapabilities ??= window.dbxPlugin
    .invoke<{ canSaveLocal: boolean; downloadsDir: string }>("local/capabilities")
    .then((result) => {
      localDownloadDir.value = result.downloadsDir || "";
      localCanSave.value = result.canSaveLocal;
      return result;
    })
    .catch(() => undefined);
  return localCapabilities;
}

/** 单文件/目录下载入口；forceSudo 走 sudo/download/start（M14-C DownloadSudo，
 * root 大文件二进制下载）——start 换方法换参数名（path），分块循环、finish、
 * 取消与进度面板全部复用既有下载管线，取消路径的 sftp/transfer/cancel 对
 * sudo 任务同样生效（sidecar 会顺带清掉远端临时件）。 */
async function downloadEntry(entry: DownloadListEntry, forceSudo = false) {
  fileMenu.value = undefined;
  // 目录条目走递归文件夹下载（tree/start + 同一分块管线）；文件沿用单文件管线。
  // sudo 下载只覆盖普通文件：root 目录没有对应的暂存语义，明确拒绝。
  if (forceSudo && entry.kind !== "file") {
    showError(new Error(t("sudoDownload.filesOnly")));
    return;
  }
  if (entry.kind === "directory") {
    await downloadDirectoryEntry(entry);
    return;
  }
  openTransferPanel();
  if (!session.value || entry.kind !== "file") return;
  // Prefer the sidecar local sink on desktop so completed downloads retain a
  // validated localPath for the reveal/open actions in the transfer panel and
  // persisted history. Fall back to the host file-transfer bridge when a
  // local filesystem is unavailable (web/docker).
  const local = await probeLocalCapabilities();
  const saveToLocal = !!local?.canSaveLocal;
  // 「使用默认地址」关闭时先选保存目录；取消则整次下载不发生。
  // 仅本地落盘可指定目录——web/docker 浏览器下载由浏览器决定位置。
  let dirOverride = "";
  let setDefaultAfter = false;
  if (saveToLocal && !loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(entry.name);
    if (chosen === undefined) return;
    dirOverride = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  // 冲突策略：ask 且确实撞名时先问，取消则整次下载不发生（仅本地落盘可查本机目录）。
  const conflict = saveToLocal ? await resolveDownloadConflictFor(dirOverride, entry.name) : undefined;
  if (saveToLocal && conflict === undefined) return;
  const fileTransfer = saveToLocal ? undefined : window.dbxPlugin.fileTransfer;
  // Web/Docker mode has no local sink and no host save dialog; the whole file
  // is buffered in browser memory before saving, so warn before large ones.
  if (!fileTransfer && !saveToLocal && (entry.size || 0) > WEB_DOWNLOAD_WARNING_BYTES && !(await confirmDialog(t("webDownload.largeWarning", { name: entry.name, size: formatBytes(entry.size || 0) }), { danger: false }))) return;

  let info: DownloadStartInfo | undefined;
  let target: { handleId: string; chunkBytes: number } | undefined;
  const chunks = fileTransfer || saveToLocal ? undefined : ([] as Uint8Array[]);
  try {
    const startParams = {
      sessionId: session.value.sessionId,
      saveToLocal,
      downloadDir: dirOverride || loadDownloadDir() || undefined,
      conflict: conflict === "overwrite" ? "overwrite" : undefined,
    };
    // sudo 下载族参数名用 path（与 sudo/stat 等同族一致），sftp 族用 remotePath。
    info = forceSudo
      ? await window.dbxPlugin.invoke<DownloadStartInfo>("sudo/download/start", { ...startParams, path: pathFromUri(entry.uri) })
      : await window.dbxPlugin.invoke<DownloadStartInfo>("sftp/download/start", { ...startParams, remotePath: pathFromUri(entry.uri) });
    transferTasks[info.taskId] = { taskId: info.taskId, sessionId: session.value.sessionId, direction: "download", fileName: info.fileName, size: info.size, transferred: 0, status: "queued", joinedAt: Date.now(), compression: info.compression === "gzip" ? "gzip" : undefined };
    // 压缩任务等 prep 就绪（M33）：普通任务（含 sudo/回退）立即返回。
    await waitForDownloadReady(info.taskId, info.compression);
    // beginSave 在用户取消原生保存框时按契约返回 null：必须立刻终止整个下载，
    // 否则 target=null 会让循环滑进「只推进度不写盘」分支，最终提示成功却无文件。
    target = fileTransfer ? (await fileTransfer.beginSave({ name: info.fileName, size: info.size })) ?? undefined : undefined;
    if (fileTransfer && !target) {
      await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId, reason: "user" }).catch(() => undefined);
      cancelledTransferTasks.add(info.taskId);
      throw new Error(t("transferStatus.cancelled"));
    }
    let offset = 0;
    while (offset < info.size) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // Cancellation interrupts via the chunk waiter; swallow the rejection of the
      // in-flight request so it cannot surface as an unhandled promise rejection.
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      if (chunks) {
        chunks.push(chunk);
        offset += chunk.byteLength;
        const task = transferTasks[info.taskId];
        if (task) {
          task.status = "running";
          task.transferred = offset;
        }
      } else if (fileTransfer && target) {
        // issue #116：同 trzsz 落盘——transfer 列表只收 ArrayBuffer，交独立 buffer。
        const write = await fileTransfer.write(target.handleId, offset, standaloneArrayBuffer(chunk));
        offset = write.nextOffset;
      } else {
        // saveToLocal：字节已在 sidecar 侧写入暂存文件，这里只跟进进度。
        offset += chunk.byteLength;
        const task = transferTasks[info.taskId];
        if (task) {
          task.status = "running";
          task.transferred = offset;
        }
      }
      if (result.eof) break;
    }
    let localPath: string | undefined;
    if (target) {
      await fileTransfer!.finish(target.handleId);
      target = undefined;
    } else if (chunks) {
      await saveHostFile(chunks, info.fileName);
    }
    const finishResult = await window.dbxPlugin.invoke<{ localPath?: string }>("sftp/download/finish", { taskId: info.taskId });
    localPath = finishResult?.localPath;
    cancelledTransferTasks.delete(info.taskId);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (localPath) task.localPath = localPath;
    }
    // 完成闭环：本机落盘的下载给出「打开文件 / 打开目录」动作。
    if (localPath) {
      const savedPath = localPath;
      showNotice(t("downloadedTo", { name: info.fileName, path: savedPath }), [
        { label: t("openDownloadedFile"), run: () => void openTransferTarget(savedPath) },
        { label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) },
      ]);
    } else {
      showNotice(t("downloaded", { name: info.fileName }));
    }
    if (setDefaultAfter) applyChosenDirAsDefault(dirOverride);
  } catch (cause) {
    if (info) {
      const waiter = downloadChunkWaiters.get(info.taskId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        downloadChunkWaiters.delete(info.taskId);
      }
    }
    if (target && fileTransfer) await fileTransfer.cancel(target.handleId).catch(() => undefined);
    if (info) await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
    if (info && cancelledTransferTasks.delete(info.taskId)) {
      const task = transferTasks[info.taskId];
      if (task) task.status = "cancelled";
      showNotice(t("transferStatus.cancelled"));
    } else {
      // 失败闭环：横幅带「重试」，按原入口完整重跑（含询问/冲突流程）。
      showError(cause, "sftp", () => void downloadEntry(entry, forceSudo));
    }
  }
}

// —— 递归文件夹下载（issue #46）：目录条目 → sftp/download/tree/start ——
// 复用单文件下载的分块循环（saveToLocal 语义：字节留在 sidecar 落盘，前端
// 只跟进度）；与文件下载的差异：必须本机落盘（web/docker 无本地文件系统时
// 不可用），循环跑到 eof 为止（空树也会先收到一次空 eof 块），根名撞车由
// sidecar 自动让位（无「覆盖」语义），取消/未完成时 sidecar 整树删除。
async function downloadDirectoryEntry(entry: DownloadListEntry) {
  fileMenu.value = undefined;
  openTransferPanel();
  if (!session.value || entry.kind !== "directory") return;
  const local = await probeLocalCapabilities();
  if (!local?.canSaveLocal) {
    showError(new Error(t("folderDownload.unsupported")));
    return;
  }
  // 「使用默认地址」关闭时先选保存目录；取消则整次下载不发生。
  let dirOverride = "";
  let setDefaultAfter = false;
  if (!loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(entry.name);
    if (chosen === undefined) return;
    dirOverride = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  let info: DownloadStartInfo | undefined;
  try {
    // start 里做远端递归扫描（有界）：树很大时这一步本身耗时，给足超时。
    info = await window.dbxPlugin.invoke<DownloadStartInfo>("sftp/download/tree/start", {
      sessionId: session.value.sessionId,
      remotePath: pathFromUri(entry.uri),
      downloadDir: dirOverride || loadDownloadDir() || undefined,
    }, { timeoutMs: 10 * 60 * 1000 });
    transferTasks[info.taskId] = {
      taskId: info.taskId,
      sessionId: session.value.sessionId,
      direction: "download",
      fileName: info.fileName,
      size: info.size,
      transferred: 0,
      status: "running",
      fileCount: info.fileCount,
      compression: info.compression === "gzip" ? "gzip" : undefined,
    };
    // 压缩树等「远端 tar.gz → 拉取 → 本地解包」prep 就绪（M33）。
    await waitForDownloadReady(info.taskId, info.compression);
    let offset = 0;
    while (true) {
      await waitWhilePaused(info.taskId);
      const chunkPromise = waitForDownloadChunk(info.taskId, offset);
      const nextPromise = window.dbxPlugin.invoke<{ length: number; eof: boolean }>("sftp/download/next", { taskId: info.taskId, offset });
      // 取消会通过分块等待器中断；吞掉在途请求的拒绝避免 unhandled rejection。
      nextPromise.catch(() => undefined);
      const result = await nextPromise;
      const chunk = await chunkPromise;
      if (!result.eof && result.length === 0) throw new Error(t("errors.downloadEmptyChunk"));
      offset += result.length;
      if (chunk.byteLength && chunk.byteLength !== result.length) throw new Error(t("errors.downloadChunkLength"));
      const task = transferTasks[info.taskId];
      if (task) {
        task.status = "running";
        task.transferred = offset;
      }
      if (result.eof) break;
    }
    const finish = await window.dbxPlugin.invoke<FolderDownloadFinish>("sftp/download/finish", { taskId: info.taskId }, { timeoutMs: 30 * 60 * 1000 });
    cancelledTransferTasks.delete(info.taskId);
    const outcome = folderDownloadOutcome(finish);
    const task = transferTasks[info.taskId];
    if (task) {
      task.status = "completed";
      task.transferred = info.size;
      if (outcome.localPath) task.localPath = outcome.localPath;
      task.failedCount = outcome.failedCount || undefined;
      task.failureSample = outcome.failureSample || undefined;
      task.currentFile = undefined;
    }
    const revealActions = outcome.localPath
      ? [
          {
            label: t("revealInFolder"),
            run: () => {
              const savedPath = outcome.localPath;
              if (savedPath) void revealTransferTarget(savedPath);
            },
          },
        ]
      : [];
    let message: string;
    if (outcome.partial) {
      message = t("folderDownload.completedWithFailures", { path: outcome.localPath, count: outcome.failedCount, total: outcome.fileCount });
    } else {
      message = t("downloadedToDir", { count: outcome.fileCount, path: outcome.localPath });
    }
    if (outcome.skippedCount) message += t("folderDownload.skippedNote", { count: outcome.skippedCount });
    showNotice(message, revealActions);
    if (setDefaultAfter) applyChosenDirAsDefault(dirOverride);
  } catch (cause) {
    if (info) {
      const waiter = downloadChunkWaiters.get(info.taskId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        downloadChunkWaiters.delete(info.taskId);
      }
      await window.dbxPlugin.invoke("sftp/transfer/cancel", { taskId: info.taskId }).catch(() => undefined);
      if (cancelledTransferTasks.delete(info.taskId)) {
        const task = transferTasks[info.taskId];
        if (task) task.status = "cancelled";
        showNotice(t("transferStatus.cancelled"));
      } else {
        showError(cause, "sftp", () => void downloadDirectoryEntry(entry));
      }
    } else {
      showError(cause, "sftp", () => void downloadDirectoryEntry(entry));
    }
  }
}

// 多选批量下载：文件与目录混选，逐项走各自管线（单项失败不阻断剩余项）。
async function batchDownload() {
  const menu = fileMenu.value;
  fileMenu.value = undefined;
  if (!menu) return;
  const uris = menu.selection.length ? menu.selection : [menu.entry.uri];
  const targets = entries.value.filter((entry: DownloadListEntry) => uris.includes(entry.uri));
  for (const entry of targets) {
    if (entry.kind !== "file" && entry.kind !== "directory") continue;
    await downloadEntry(entry);
  }
}

// 宿主单次落盘上限（pluginHostBridge MAX_BRIDGE_SAVE_BYTES）：超出时明确报错，
// 绝不回退 iframe 内 <a download>——sandbox="allow-scripts" 下该动作被浏览器
// 静默丢弃，正是 issue #93「提示成功但本机没有文件」的根因。
const HOST_SAVE_MAX_BYTES = 512 * MIB;

/**
 * 无 fileTransfer 宿主（DBX 0.6.14–0.6.17 及全部 web/docker 旧宿主）的落盘路径：
 * 把整包字节交给宿主顶层页面（host.saveFile）保存。宿主顶层文档不受插件 iframe
 * 的 sandbox 约束；桌面端宿主同时弹出原生保存对话框。用户取消返回 null。
 */
async function saveHostFile(chunks: Uint8Array[], fileName: string): Promise<void> {
  if (!window.dbxPlugin.saveFile) throw new Error(t("errors.localSaveUnavailable"));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total > HOST_SAVE_MAX_BYTES) throw new Error(t("errors.localSaveTooLarge", { size: formatBytes(total), limit: formatBytes(HOST_SAVE_MAX_BYTES) }));
  // Runtime chunks always come from decodeBase64 (ArrayBuffer-backed); merge
  // into one buffer because host.saveFile is a single-shot, no-append bridge.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const saved = await window.dbxPlugin.saveFile({ fileName, contentType: "application/octet-stream" }, merged);
  if (!saved) throw new Error(t("transferStatus.cancelled"));
}

function waitForDownloadChunk(taskId: string, offset: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      downloadChunkWaiters.delete(taskId);
      reject(new Error(t("errors.downloadChunkTimeout")));
    }, 30_000);
    downloadChunkWaiters.set(taskId, { offset, resolve, reject, timer });
  });
}

// 在文件管理器中定位本机落盘的下载（sidecar 校验过该路径确为本插件记录）。
async function revealTransferTarget(path: string) {
  try {
    await window.dbxPlugin.invoke("local/reveal", { path });
  } catch (cause) {
    showError(cause);
  }
}

// 在系统默认应用中打开已完成的下载；sidecar 会校验路径必须来自本插件
// 的完成历史，避免把这个按钮变成任意本机路径打开入口。
async function openTransferTarget(path: string) {
  try {
    await window.dbxPlugin.invoke("local/open", { path });
  } catch (cause) {
    showError(cause);
  }
}


  return {
    waitForDownloadChunk,
    probeLocalCapabilities,
    downloadEntry,
    batchDownload,
    saveHostFile,
    revealTransferTarget,
    openTransferTarget,
  };
}
