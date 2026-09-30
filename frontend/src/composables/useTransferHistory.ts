import { ref, type Ref } from "vue";
import { canResumeUpload, matchResumableUpload, type ResumableUploadTask } from "../lib/transferResume";
import { sanitizeTransferHistoryTasks, TRANSFER_HISTORY_LIMIT, type TransferHistoryEntry } from "../lib/transferHistory";

/** 传输历史 + 断点续传：面板数据源与交互（状态 + sidecar 接线）。
 * 历史区与活跃任务并列展示，后端未升级/读取失败仅提示加载失败（optional 特性降级）。
 * 面板编排（活跃任务对账、打开/终态刷新时机）仍在 App.vue。 */
export function useTransferHistory(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  // 返回值沿用 uploadSource 的 boolean 契约（true=已交付、false=用户放弃）；
  // 本处续传只 await 完成与否，false 同样视为结束。
  uploadSource: (name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string) => Promise<boolean>;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showNotice, showError, uploadSource, loadDirectory } = options;

  const transferHistory = ref<TransferHistoryEntry[]>([]);
  const transferHistoryLoading = ref(false);
  const transferHistoryFailed = ref(false);

  async function refreshTransferHistory() {
    transferHistoryLoading.value = true;
    try {
      const result = await window.dbxPlugin.invoke<{ tasks: unknown }>("sftp/transfer/history", { limit: TRANSFER_HISTORY_LIMIT });
      transferHistory.value = sanitizeTransferHistoryTasks(result?.tasks);
      transferHistoryFailed.value = false;
    } catch {
      // 历史是 best-effort UX 数据：后端未升级/读取失败仅提示加载失败，
      // 保留上一次快照——一次瞬时错误不能把用户可见的记录清空。
      transferHistoryFailed.value = true;
    } finally {
      transferHistoryLoading.value = false;
    }
  }

  // 应用内弹窗确认：宿主沙箱 iframe 无 allow-modals，window.confirm 恒 false
  const transferHistoryClearOpen = ref(false);
  async function confirmTransferHistoryClear() {
    try {
      await window.dbxPlugin.invoke("sftp/transfer/history/clear", {});
      transferHistory.value = [];
      transferHistoryFailed.value = false;
      transferHistoryClearOpen.value = false;
      showNotice(t("transfersHistory.cleared"));
    } catch (cause) {
      showError(cause);
    }
  }

  const resumableTasks = ref<ResumableUploadTask[]>([]);
  const resumableLoading = ref(false);
  const resumeInput = ref<HTMLInputElement | null>(null);
  const resumeTargetTaskId = ref("");

  async function refreshResumableUploads() {
    resumableLoading.value = true;
    try {
      const result = await window.dbxPlugin.invoke<{ tasks: ResumableUploadTask[] }>("sftp/transfer/resumable", {});
      resumableTasks.value = (result.tasks ?? []).filter(canResumeUpload);
    } catch {
      resumableTasks.value = [];
    } finally {
      resumableLoading.value = false;
    }
  }

  function beginResumeUpload(task: ResumableUploadTask) {
    resumeTargetTaskId.value = task.taskId;
    resumeInput.value?.click();
  }

  async function onResumeFilePicked(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    const task = resumableTasks.value.find((item) => item.taskId === resumeTargetTaskId.value);
    resumeTargetTaskId.value = "";
    if (!file || !task) return;
    if (!matchResumableUpload(task, [{ name: file.name, size: file.size }])) {
      showError(new Error(t("resumableMismatch")));
      return;
    }
    try {
      await uploadSource(file.name, file.size, async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()), { taskId: task.taskId, remotePath: task.remotePath });
      await loadDirectory();
      showNotice(t("resumableResumed", { name: file.name }));
      void refreshTransferHistory();
      void refreshResumableUploads();
    } catch (cause) {
      showError(cause);
    }
  }

  return {
    transferHistory,
    transferHistoryLoading,
    transferHistoryFailed,
    transferHistoryClearOpen,
    refreshTransferHistory,
    confirmTransferHistoryClear,
    resumableTasks,
    resumableLoading,
    resumeInput,
    resumeTargetTaskId,
    refreshResumableUploads,
    beginResumeUpload,
    onResumeFilePicked,
  };
}
