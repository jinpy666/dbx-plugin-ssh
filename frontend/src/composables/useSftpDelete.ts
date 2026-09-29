import type { Ref } from "vue";
import type { SftpEntryKind } from "../lib/sftpEntries";
import { advanceBatchProgress, createBatchProgress, type BatchProgressState } from "../lib/sftpBatchProgress";

// 列表条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type DeleteEntry = { uri: string; name: string; kind: SftpEntryKind };
// 批次进度状态（App.vue 的 batchProgress 使用的结构，lib/sftpBatchProgress

/** SFTP 删除与批量操作：单条删除（sudo 通道分流）、多选批量删除、批量归档
 * （sftp/archive 逐项 + 批次进度）。batchProgress 批次进度为外部编辑/文件夹
 * 上传共用，仍由 App.vue 持有；clearRowSelection/archiveBusy 分别来自
 * useSftpSelectionClipboard/useSftpArchive（晚于本域调用点），以惰性注入。 */
export function useSftpDelete(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  sudoMode: Ref<boolean>;
  currentPath: Ref<string>;
  deleteTarget: Ref<DeleteEntry | undefined>;
  deleteSubmitting: Ref<boolean>;
  batchDeleteOpen: Ref<boolean>;
  batchDeleteSubmitting: Ref<boolean>;
  batchProgress: Ref<BatchProgressState | null>;
  selectedEntries: Ref<DeleteEntry[]>;
  pathFromUri: (uri: string) => string;
  joinRemote: (parent: string, name: string) => string;
  loadDirectory: (path?: string) => Promise<void>;
  clearRowSelection: () => void;
  archiveBusy: Ref<boolean>;
}) {
  const { t, showNotice, showError, session, sudoMode, currentPath, deleteTarget, deleteSubmitting, batchDeleteOpen, batchDeleteSubmitting, batchProgress, selectedEntries, pathFromUri, joinRemote, loadDirectory, clearRowSelection, archiveBusy } = options;

async function confirmDelete() {
  if (!session.value || !deleteTarget.value) return;
  deleteSubmitting.value = true;
  try {
    const path = pathFromUri(deleteTarget.value.uri);
    if (sudoMode.value) {
      await window.dbxPlugin.invoke(deleteTarget.value.kind === "directory" ? "sudo/removeAll" : "sudo/remove", {
        sessionId: session.value.sessionId,
        path,
      });
    } else {
      await window.dbxPlugin.invoke("sftp/delete", {
        sessionId: session.value.sessionId,
        path,
        recursive: deleteTarget.value.kind === "directory",
      });
    }
    deleteTarget.value = undefined;
    await loadDirectory();
    showNotice(t("deleted"));
  } catch (cause) {
    showError(cause);
  } finally {
    deleteSubmitting.value = false;
  }
}

async function confirmBatchDelete() {
  const sessionId = session.value?.sessionId;
  const targets = selectedEntries.value;
  if (!sessionId || !targets.length || batchDeleteSubmitting.value) return;
  batchDeleteSubmitting.value = true;
  let progress = createBatchProgress(targets.length);
  batchProgress.value = progress;
  try {
    for (const entry of targets) {
      const path = pathFromUri(entry.uri);
      try {
        if (sudoMode.value) {
          await window.dbxPlugin.invoke(entry.kind === "directory" ? "sudo/removeAll" : "sudo/remove", { sessionId, path });
        } else {
          await window.dbxPlugin.invoke("sftp/delete", { sessionId, path, recursive: entry.kind === "directory" });
        }
        progress = advanceBatchProgress(progress, { name: entry.name, ok: true });
      } catch (cause) {
        progress = advanceBatchProgress(progress, { name: entry.name, ok: false });
        throw cause;
      }
      batchProgress.value = progress;
    }
    batchDeleteOpen.value = false;
    clearRowSelection();
    await loadDirectory();
    showNotice(t("deleted"));
  } catch (cause) {
    showError(cause);
    await loadDirectory();
  } finally {
    batchDeleteSubmitting.value = false;
    batchProgress.value = null;
  }
}

async function batchArchive() {
  const sessionId = session.value?.sessionId;
  const targets = selectedEntries.value;
  if (!sessionId || !targets.length || archiveBusy.value) return;
  archiveBusy.value = true;
  let progress = createBatchProgress(targets.length);
  batchProgress.value = progress;
  try {
    let done = 0;
    for (const entry of targets) {
      const archiveName = `${entry.name}.tar.gz`;
      try {
        await window.dbxPlugin.invoke("sftp/archive", {
          sessionId,
          sourcePaths: [pathFromUri(entry.uri)],
          archivePath: joinRemote(currentPath.value, archiveName),
        }, { timeoutMs: 30 * 60 * 1000 });
        progress = advanceBatchProgress(progress, { name: archiveName, ok: true });
      } catch (cause) {
        progress = advanceBatchProgress(progress, { name: archiveName, ok: false });
        throw cause;
      }
      batchProgress.value = progress;
      done += 1;
    }
    showNotice(t("sftpBatch.archiveDone", { count: done }));
    await loadDirectory();
  } catch (cause) {
    showError(cause);
    await loadDirectory();
  } finally {
    archiveBusy.value = false;
    batchProgress.value = null;
  }
}


  return {
    confirmDelete,
    confirmBatchDelete,
    batchArchive,
  };
}
