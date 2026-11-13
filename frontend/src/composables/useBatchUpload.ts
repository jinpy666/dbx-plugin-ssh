import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import {
  addBatchUploadFiles,
  batchUploadTotalBytes,
  joinUploadPath,
  removeBatchUploadFile,
  resolveUploadDir,
  selectableUploadTargets,
  shouldAutoDismissBatchUpload,
  summarizeBatchUploadRows,
  type BatchUploadFile,
  type BatchUploadPolicy,
  type BatchUploadRow,
  type BatchUploadSummary,
} from "../lib/batchUpload";
import { batchTargetLabel, type BatchSendTarget } from "../lib/batchSend";
import { pluginStore } from "../lib/pluginStore";

/**
 * 批量上传（对标批量发送命令的多目标语义）：目标会话复用批量条的勾选列表
 * （跨连接全部存活 SSH 会话），每个目标按自身 sessionId 走 sidecar 的
 * `sftp/upload/*` 分块通道——与 SFTP 面板单文件上传同一条管线（spool 暂存、
 * 压缩决策、传输面板进度/取消都继承），只是不再锁定当前工作台会话。
 *
 * 重名策略在**每台目标上**各判一次：多台服务器目录内容天然不同，不能拿一台
 * 的 exists 结果套到全部（这正是批量发送不需要、批量上传必须做的事）。
 */

/** 全部成功后的结果浮条自动收起时限（与批量发送同 3.5s）。 */
const UPLOAD_RESULT_AUTO_DISMISS_MS = 3500;
/** 上次使用的目标目录（pluginStore：沙箱内 opaque origin 只能经宿主 storage 落盘）。 */
const UPLOAD_DIR_KEY = "ssh-batch-upload-dir";

function loadUploadDir(): string {
  try {
    return pluginStore.getItem(UPLOAD_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistUploadDir(value: string) {
  try {
    pluginStore.setItem(UPLOAD_DIR_KEY, value);
  } catch {
    // 存储不可用只失去记忆，上传本身不受影响。
  }
}

export interface BatchUploadProgress {
  targetIndex: number;
  targetCount: number;
  fileIndex: number;
  fileCount: number;
  label: string;
  fileName: string;
}

export function useBatchUpload(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  /** 传输队列入口（useTransferQueue）：sessionId 显式传入即按目标会话投递。 */
  uploadSource: (
    name: string,
    size: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
    resume?: { taskId: string; remotePath: string },
    targetDir?: string,
    extra?: { duplicatePreCheckedAbsent?: boolean; batchId?: string; lzpack?: boolean; sessionId?: string; sudoLane?: boolean },
  ) => Promise<boolean>;
  batchTargets: Ref<BatchSendTarget[]>;
  batchSelected: Ref<string[]>;
  /** 远端主目录（SFTP 探测结果）：路径留空/`~` 时的落点。 */
  homeDir: ComputedRef<string>;
  /** 本地选择器（`<input type="file" multiple>`）的宿主 ref。 */
  fileInput: Ref<HTMLInputElement | undefined>;
}) {
  const { t, showError, uploadSource, batchTargets, batchSelected, homeDir, fileInput } = options;

  // 命令 / 上传两种模式共用一条批量条：目标按钮与结果浮条位置都不变。
  const batchMode = ref<"command" | "upload">("command");
  const uploadDir = ref(loadUploadDir());
  const uploadPolicy = ref<BatchUploadPolicy>("overwrite");
  const uploadFiles = ref<BatchUploadFile[]>([]);
  const uploading = ref(false);
  const uploadProgress = ref<BatchUploadProgress>();
  const uploadSummary = ref<BatchUploadSummary>();
  const uploadError = ref("");
  const uploadFilesOpen = ref(false);
  let uploadResultTimer: number | undefined;
  let fileSeq = 0;

  const uploadTotalBytes = computed(() => batchUploadTotalBytes(uploadFiles.value));
  const uploadTargetCount = computed(() => selectableUploadTargets(batchTargets.value, batchSelected.value).length);
  const uploadReady = computed(() => !uploading.value && uploadFiles.value.length > 0 && uploadTargetCount.value > 0);

  function clearUploadResultTimer() {
    if (uploadResultTimer !== undefined) {
      window.clearTimeout(uploadResultTimer);
      uploadResultTimer = undefined;
    }
  }

  /** 切换到上传模式时预填目标目录：优先上次输入，其次当前会话的远端主目录。 */
  function enterUploadMode() {
    batchMode.value = "upload";
    if (!uploadDir.value.trim()) uploadDir.value = homeDir.value || "/";
    uploadError.value = "";
  }

  function setBatchMode(mode: "command" | "upload") {
    if (mode === "upload") {
      enterUploadMode();
      return;
    }
    batchMode.value = "command";
    uploadFilesOpen.value = false;
  }

  function pickUploadFiles() {
    fileInput.value?.click();
  }

  function onUploadFilesInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const chosen = Array.from(input.files ?? []);
    // 采集后清空 value：同一批文件（或同名替换）再次选择也能触发 change。
    input.value = "";
    if (!chosen.length) return;
    uploadFiles.value = addBatchUploadFiles(
      uploadFiles.value,
      chosen.map((file) => ({ id: `batch-upload-${++fileSeq}`, name: file.name, size: file.size, file })),
    );
    if (uploadFiles.value.length > 1) uploadFilesOpen.value = true;
  }

  function removeUploadFile(id: string) {
    uploadFiles.value = removeBatchUploadFile(uploadFiles.value, id);
    if (!uploadFiles.value.length) uploadFilesOpen.value = false;
  }

  function clearUploadFiles() {
    uploadFiles.value = [];
    uploadFilesOpen.value = false;
  }

  function dismissUploadResult() {
    clearUploadResultTimer();
    uploadSummary.value = undefined;
    uploadError.value = "";
  }

  /** 目标上是否已有同名文件（探测失败按"不存在"处理：宁可直接传，不阻断）。 */
  async function remoteExists(sessionId: string, path: string): Promise<boolean> {
    try {
      const probe = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", { sessionId, path });
      return probe.exists === true;
    } catch {
      return false;
    }
  }

  /** rename 策略：交给 sidecar 探测 `name(1)..name(999)`，失败回落原名覆盖。 */
  async function uniqueRemoteName(sessionId: string, dir: string, name: string): Promise<string> {
    try {
      const result = await window.dbxPlugin.invoke<{ name: string }>("sftp/rename-unique", { sessionId, dir, name });
      return result?.name || name;
    } catch {
      return name;
    }
  }

  function readChunkOf(entry: BatchUploadFile) {
    return async (offset: number, length: number) => new Uint8Array(await entry.file.slice(offset, offset + length).arrayBuffer());
  }

  async function runBatchUpload() {
    if (uploading.value) return;
    const targets = selectableUploadTargets(batchTargets.value, batchSelected.value);
    if (!targets.length) {
      uploadError.value = t("batchUploadNeedTargets");
      return;
    }
    if (!uploadFiles.value.length) {
      uploadError.value = t("batchUploadNeedFiles");
      return;
    }
    const dir = resolveUploadDir(uploadDir.value, homeDir.value);
    // 归一结果回写输入框（`tmp` → `/tmp`、`~` → 远端主目录），避免同一输入
    // 下次上传落到别处。
    uploadDir.value = dir;
    const policy = uploadPolicy.value;
    const files = [...uploadFiles.value];
    uploading.value = true;
    uploadError.value = "";
    uploadSummary.value = undefined;
    clearUploadResultTimer();
    const rows: BatchUploadRow[] = [];
    try {
      for (const [targetIndex, target] of targets.entries()) {
        for (const [fileIndex, entry] of files.entries()) {
          uploadProgress.value = {
            targetIndex: targetIndex + 1,
            targetCount: targets.length,
            fileIndex: fileIndex + 1,
            fileCount: files.length,
            label: batchTargetLabel(target),
            fileName: entry.name,
          };
          let name = entry.name;
          try {
            if (policy !== "overwrite") {
              const probePath = joinUploadPath(dir, entry.name);
              const exists = await remoteExists(target.sessionId, probePath);
              if (exists && policy === "skip") {
                rows.push({ sessionId: target.sessionId, fileName: entry.name, status: "skipped", remotePath: probePath });
                continue;
              }
              if (exists && policy === "rename") name = await uniqueRemoteName(target.sessionId, dir, entry.name);
            }
            const remotePath = joinUploadPath(dir, name);
            const done = await uploadSource(name, entry.size, readChunkOf(entry), undefined, dir, {
              sessionId: target.sessionId,
              // 重名已在上面按目标逐台判定（批量场景不走单会话的 ask 弹窗）。
              duplicatePreCheckedAbsent: true,
              sudoLane: false,
            });
            rows.push({
              sessionId: target.sessionId,
              fileName: entry.name,
              status: done ? "uploaded" : "failed",
              remotePath: done ? remotePath : undefined,
              error: done ? undefined : t("batchUploadFailed"),
            });
          } catch (cause) {
            rows.push({
              sessionId: target.sessionId,
              fileName: entry.name,
              status: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      }
    } catch (cause) {
      // 逐文件失败已在行内记录；能落到这里的是编排层异常（目标列表/文件读取
      // 之外的意外），交给统一错误通道，避免"什么都没发生"。
      showError(cause, "sftp");
    } finally {
      uploadProgress.value = undefined;
      uploading.value = false;
    }
    uploadSummary.value = summarizeBatchUploadRows(rows);
    // 部分失败不自动收（逐行错误要留给用户），全成功才短暂展示。
    if (shouldAutoDismissBatchUpload(uploadSummary.value)) {
      clearUploadResultTimer();
      uploadResultTimer = window.setTimeout(dismissUploadResult, UPLOAD_RESULT_AUTO_DISMISS_MS);
    }
  }

  // 记住上次的目标目录：下次打开上传模式直接沿用（归一后的绝对路径）。
  watch(uploadDir, (value) => {
    if (value.trim()) persistUploadDir(value.trim());
  });
  watch(batchMode, (mode) => {
    if (mode === "command") uploadFilesOpen.value = false;
  });
  onBeforeUnmount(clearUploadResultTimer);

  return {
    batchMode,
    uploadDir,
    uploadPolicy,
    uploadFiles,
    uploading,
    uploadProgress,
    uploadSummary,
    uploadError,
    uploadFilesOpen,
    uploadTotalBytes,
    uploadTargetCount,
    uploadReady,
    setBatchMode,
    enterUploadMode,
    pickUploadFiles,
    onUploadFilesInput,
    removeUploadFile,
    clearUploadFiles,
    runBatchUpload,
    dismissUploadResult,
  };
}
