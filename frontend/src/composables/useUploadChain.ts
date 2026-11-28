import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import { filesFromClipboard } from "../lib/clipboardFiles";
import { collectDropRootEntries, scanDroppedEntries, type DropRootEntry } from "../lib/dropEntries";
import { planHostFileDrop } from "../lib/hostFileDrop";
import { canAcceptTerminalDrop, canAcceptFileDrop, dragLeftPane } from "../lib/terminalInteraction";
import { runTransfers, summarizeBatchUpload } from "../lib/transferQueue";
import { createFileBatchCard, type FileBatchCardState } from "../lib/fileBatch";
import { useUploadDuplicatePolicy } from "./useUploadDuplicatePolicy";
import { useDropUploadTargetPrompt } from "./useDropUploadTargetPrompt";
import { useFolderUpload } from "./useFolderUpload";
import { X } from "@lucide/vue";

// 拖入条目/上传重复弹窗的最小结构（App.vue 的 FolderUploadEntry/
// UploadDuplicatePrompt 为局部接口，按消费字段收敛）。
type FolderUploadEntry = { name: string; relativePath: string; size: number; readChunk: (offset: number, length: number) => Promise<Uint8Array> };
type UploadDuplicatePrompt = { name: string; path: string };
// 宿主桥 filedrop 条目（relativePath 为可选增量：宿主遍历目录后附带，
// 旧宿主不带——插件前向兼容，见 handleHostFileDrop）。
type HostFileDropFile = { handleId: string; name: string; size: number; contentType: string; relativePath?: string };

/** 上传链（大功能聚合）：fileTransfer 选择器 → 原生回退 → 本地/文件夹/
 * 拖拽/剪贴板五路上传入口，统一汇入 uploadSource 传输队列；重复目标策略
 * （P1-5：预检 + 重命名/覆盖/询问「应用到全部」）与拖拽落点解析（终端
 * cwd → sftp home → 面板目录，wire 形式 M17）一并收口。 */
export function useUploadChain(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  connected: Ref<boolean>;
  canWrite: Ref<boolean>;
  currentPath: Ref<string>;
  sftpHomePath: Ref<string>;
  terminalCwd: Ref<string>;
  sftpNameEncodingState: Ref<string>;
  dragActive: Ref<boolean>;
  terminalDragActive: Ref<boolean>;
  sftpPaneOpen: Ref<boolean>;
  terminalTransferBusy: Ref<boolean>;
  uploadSource: (name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string, options?: { duplicatePreCheckedAbsent?: boolean; batchId?: string; lzpack?: boolean }) => Promise<boolean>;
  /** 传输任务账本（issue #165）：批次字节进度按 batchId 聚合。 */
  transferTasks: Record<string, import("../lib/transferQueue").TransferTask>;
  loadTransferConcurrency: () => number;
  loadTransferMaxActive: () => number;
  loadTransferDuplicatePolicy: () => "rename" | "ask" | "overwrite";
  transferDuplicateState: Ref<"rename" | "ask" | "overwrite">;
  terminal: () => { focus: () => void } | undefined;
  loadDirectory: (path?: string) => Promise<void>;
  openTransferPanel: () => void;
  joinRemote: (parent: string, name: string) => string;
  /** UploadSudo：与 useTransferQueue 同源判定（sudo 模式 + 可写连接）。重复
   * 预检（exists/rename-unique）与文件夹上传的逐目录建目录随之换 sudo 族——
   * 目标目录（如 /root）对登录用户不可读时 SFTP 探测/建目录必失败。 */
  sudoUpload: () => boolean;
}) {
  const { t, showNotice, showError, session, connected, canWrite, currentPath, sftpHomePath, terminalCwd, sftpNameEncodingState, dragActive, terminalDragActive, sftpPaneOpen, terminalTransferBusy, uploadSource, loadTransferConcurrency, loadTransferMaxActive, loadTransferDuplicatePolicy, transferDuplicateState, terminal: terminalGet, loadDirectory, openTransferPanel, joinRemote, sudoUpload, transferTasks } = options;

  // 重复目标策略与拖入落点询问下沉子 composable（纯搬移）：本处只接依赖，
  // 返回面（弹窗状态/确认回调/wire 落点解析）保持不变。
  const { uploadDuplicatePrompt, uploadDuplicateApplyAll, resolveUploadDuplicate, resolveUploadDuplicateName, resetBatchDecision } = useUploadDuplicatePolicy({ session, transferDuplicateState, sudoUpload, joinRemote });
  const { dropUploadPrompt, dropUploadTarget, dropCwdTarget, dropCwdTargetWire, wireDropDir, dropUploadPathInput, dropUploadPathInputEl, askDropUploadTarget, confirmDropUpload, resolveDropUpload } = useDropUploadTargetPrompt({ currentPath, sftpHomePath, terminalCwd, sftpNameEncodingState });

  // 批次并发与会话深度取小（评审 L-4）：批次上限（1..10）超过会话深度
  // （1..8，sidecar 权威）时，超出的任务会在 upload/start 被 "already has
  // N active transfers" 拒绝并中止整批——源头钳住而不是事后补救。
  const batchTransferLimit = () => Math.min(loadTransferConcurrency(), loadTransferMaxActive());

  // 文件夹上传管线（issue #78）下沉 useFolderUpload（纯搬移）：入口/进度/
  // 能力探测与编排随迁，本处只接依赖。
  const { folderUploadInput, folderUploadSupported, folderUploadProgress, chooseFolderUpload, onFolderUploadInput, uploadFolderFiles } = useFolderUpload({
    t, showNotice, showError, session, connected, canWrite, currentPath, sftpNameEncodingState,
    batchTransferLimit,
    loadTransferDuplicatePolicy,
    uploadSource,
    resolveUploadDuplicateName,
    resetBatchDecision,
    loadDirectory, openTransferPanel, joinRemote, sudoUpload,
  });

const uploadInput = ref<HTMLInputElement>();
// ST10 显式压缩包上传的 webview 兜底选择器（桥不可用时）。
const lzpackUploadInput = ref<HTMLInputElement>();

// 普通多文件上传的批次聚合（issue #165）：一次选择/拖拽/粘贴的多文件在
// 传输面板聚成一张「文件 N/M · 字节」进度卡——逐文件卡在并发受限与文件
// 交接的间隙会整卡消失（完成卡即转入历史），用户感知为"传完就没然后
// 突然又来几个进度条"；批次卡在整批期间常驻填补空窗。单文件不显示。
// 生命周期（建卡/收尾清空）收口在 lib/fileBatch：end 在批次编排结束后
// 延迟清卡——不清卡会在任务账本 30s 终态清收后回跳成 0/N · 0%。
const fileBatchCard = ref<FileBatchCardState>();
const fileBatch = createFileBatchCard(fileBatchCard);
onBeforeUnmount(() => fileBatch.dispose());
/** 批次进度卡数据：文件数随任务账本结算推进，字节按 batchId 聚合。 */
const fileBatchProgress = computed(() => {
  const batch = fileBatchCard.value;
  if (!batch) return undefined;
  return summarizeBatchUpload(Object.values(transferTasks), batch.batchId, batch.filesTotal, batch.totalBytes);
});

async function chooseUpload(lzpack = false) {
  if (!connected.value || !canWrite.value) return;
  // ST10 显式压缩包模式只支持单文件（交付 <名>.dbxz，批量逐文件各自 .dbxz
  // 语义混乱，先收敛单文件）；sudo 车道不支持。
  if (lzpack) {
    openTransferPanel();
    if (!window.dbxPlugin.fileTransfer) {
      lzpackUploadInput.value?.click();
      return;
    }
    try {
      const selection = await window.dbxPlugin.fileTransfer.pick({ multiple: false });
      const file = selection.files[0];
      if (!file) return;
      const uploaded = await uploadHandleFiles([file], undefined, { lzpack: true });
      await loadDirectory();
      if (uploaded) showNotice(t("sftpLzpack.uploaded", { name: `${file.name}.dbxz` }));
    } catch (cause) {
      if (isHostBridgeReadFailure(cause)) {
        fallbackToNativeUploadPicker();
        return;
      }
      showError(cause);
    }
    return;
  }
  openTransferPanel();
  if (!window.dbxPlugin.fileTransfer) {
    uploadInput.value?.click();
    return;
  }
  try {
    const selection = await window.dbxPlugin.fileTransfer.pick({ multiple: true });
    const uploaded = await uploadHandleFiles(selection.files);
    await loadDirectory();
    // 计数只含真实上传：重复弹窗里放弃跳过的文件不计入 uploaded N。
    if (uploaded) showNotice(t("uploaded", { count: uploaded }));
  } catch (cause) {
    // 宿主文件桥失败（pick 或读盘，如 unknown plugin file handle，issue #83/#79）
    // 时不再直接终止：回退到 webview 原生文件选择（File API），上传仍可继续。
    if (isHostBridgeReadFailure(cause)) {
      fallbackToNativeUploadPicker();
      return;
    }
    showError(cause);
  }
}

/** 宿主桥句柄批量上传；返回真实上传数（重复弹窗放弃跳过的不计）。 */
async function uploadHandleFiles(files: Array<{ handleId: string; name: string; size: number }>, targetDir?: string, options?: { lzpack?: boolean }): Promise<number> {
  if (!window.dbxPlugin.fileTransfer || !files.length) return 0;
  resetBatchDecision();
  const batchId = fileBatch.begin(files);
  let uploaded = 0;
  try {
    await runTransfers(files, batchTransferLimit(), {
      id: (file) => file.handleId,
      run: async (file) => {
        try {
          const done = await uploadSource(file.name, file.size, async (offset, length) => {
            const result = await window.dbxPlugin.fileTransfer!.read(file.handleId, offset, length);
            return window.dbxPlugin.decodeBase64(result.dataBase64);
          }, undefined, targetDir, { batchId, lzpack: options?.lzpack });
          if (done) uploaded += 1;
        } catch (cause) {
          // 桥接读盘错误转成可理解的提示；uploadSource 已补 upload-read-failed 代码，
          // 终端拖入路径（同函数）的 showError 也会显示这条友好文案。
          if (isHostBridgeReadFailure(cause)) {
            const code = (cause as Error & { code?: unknown }).code;
            throw Object.assign(new Error(t("uploadBridgeReadFailed", { name: file.name })), { code, cause });
          }
          throw cause;
        } finally {
          await window.dbxPlugin.fileTransfer!.cancel(file.handleId).catch(() => undefined);
        }
      },
    });
  } finally {
    // 批次收尾（issue #165）：成功、真实失败中止或重复弹窗放弃都走这里，
    // 卡片在保留窗口后清掉；批间重叠由 batchId 守卫（end 只收自己这批）。
    fileBatch.end(batchId);
  }
  return uploaded;
}

function isHostBridgeReadFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = (cause as Error & { code?: unknown }).code;
  return code === "upload-read-failed" || /file handle/i.test(cause.message);
}

// 桥接不可用时的兜底（对标 dbx-plugin-files PR #47）：提示后自动打开 webview
// 原生文件选择器（File API，不依赖宿主句柄），上传仍可完成。
function fallbackToNativeUploadPicker() {
  showNotice(t("uploadBridgeFallback"));
  uploadInput.value?.click();
}

// 宿主 fileTransfer 桥的拖入链路（桌面端）：OS 级拖放由宿主 webview 捕获并路由
// 到本工作台。与其他两条链路共用同一道门禁：只读连接/断连时拒绝并提示，不能
// 成为绕过 readOnly 的旁路。落点按面板状态分流（planHostFileDrop）：SFTP 面板
// 打开 → 当前目录；终端独占 → 走落点询问；否则忽略。桥故障时与工具栏上传一致
// 回退原生选择器重挑，而不是只报错走死。
async function handleHostFileDrop(files: HostFileDropFile[]) {
  dragActive.value = false;
  if (!canAcceptFileDrop({ connected: connected.value, canWrite: canWrite.value })) {
    showNotice(t("dropRefused"));
    return;
  }
  const plan = planHostFileDrop({
    files: files.length,
    connected: connected.value,
    canWrite: canWrite.value,
    sftpPaneOpen: sftpPaneOpen.value,
    terminalTransferBusy: terminalTransferBusy.value,
  });
  if (plan.kind === "ignore") return;
  openTransferPanel();
  // 带相对路径的条目（宿主遍历目录后的增量契约）走文件夹管线，其余照旧。
  const folderFiles = files.filter((file) => typeof file.relativePath === "string" && file.relativePath);
  const plainFiles = files.filter((file) => !file.relativePath);
  let plainUploaded = 0;
  try {
    if (plan.kind === "terminal") {
      const choice = await askDropUploadTarget(files);
      terminalGet()?.focus();
      if (choice === "cancel") return;
      // 落点转 wire 形式（M17 增量②，与终端拖拽同款分工）。
      const targetDir = choice === "cwd" ? dropCwdTargetWire.value : wireDropDir(choice.dir);
      if (folderFiles.length) await uploadHostFolderEntries(folderFiles, targetDir);
      if (plainFiles.length) plainUploaded = await uploadHandleFiles(plainFiles, targetDir);
    } else {
      if (folderFiles.length) await uploadHostFolderEntries(folderFiles);
      if (plainFiles.length) plainUploaded = await uploadHandleFiles(plainFiles);
      await loadDirectory();
    }
    if (plainUploaded) showNotice(t("uploaded", { count: plainUploaded }));
  } catch (cause) {
    if (isHostBridgeReadFailure(cause)) fallbackToNativeUploadPicker();
    else showError(cause);
  }
}

/** 宿主桥句柄的文件夹批量上传：readChunk 走 fileTransfer.read，整批结束后
 * 统一回收句柄（readChunk 逐块调用，不能在块级 finally 里提前关闭）。 */
async function uploadHostFolderEntries(files: HostFileDropFile[], targetDir?: string) {
  try {
    await uploadFolderFiles(files.map((file) => ({
      name: file.name,
      relativePath: file.relativePath as string,
      size: file.size,
      readChunk: async (offset: number, length: number) => {
        const result = await window.dbxPlugin.fileTransfer!.read(file.handleId, offset, length);
        return window.dbxPlugin.decodeBase64(result.dataBase64);
      },
    })), targetDir);
  } finally {
    for (const file of files) {
      await window.dbxPlugin.fileTransfer!.cancel(file.handleId).catch(() => undefined);
    }
  }
}

async function uploadLocalFiles(files: readonly File[], targetDir?: string) {
  openTransferPanel();
  resetBatchDecision();
  // File 对象没有稳定 id：包一层带序号的 key 再交给调度器。
  const entries = files.map((file, index) => ({ file, key: `local-${index}` }));
  const batchId = fileBatch.begin(files);
  let uploaded = 0;
  try {
    await runTransfers(entries, batchTransferLimit(), {
      id: (entry) => entry.key,
      run: async (entry) => {
        const done = await uploadSource(entry.file.name, entry.file.size, async (offset, length) => new Uint8Array(await entry.file.slice(offset, offset + length).arrayBuffer()), undefined, targetDir, { batchId });
        if (done) uploaded += 1;
      },
    });
  } finally {
    // 批次收尾（issue #165）：编排结束即安排卡片清空，失败中止同帧收尾。
    fileBatch.end(batchId);
  }
  await loadDirectory();
  if (uploaded) showNotice(t("uploaded", { count: uploaded }));
}

function onUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (files.length) void uploadLocalFiles(files).catch(showError);
}

function onLzpackUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  // 显式压缩包模式单文件：uploadSource 直走 mode=lzpack。
  const file = files[0];
  if (!file) return;
  openTransferPanel();
  void uploadSource(
    file.name,
    file.size,
    async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    undefined,
    undefined,
    { lzpack: true },
  )
    .then((done) => {
      if (done) showNotice(t("sftpLzpack.uploaded", { name: `${file.name}.dbxz` }));
      return loadDirectory();
    })
    .catch(showError);
}

// 文件夹上传管线（issue #78）下沉 useFolderUpload。

/**
 * Native file paste is the browser-compatible bridge for Finder/Explorer
 * clipboard files. Text paste is deliberately left untouched so path/search
 * inputs and the remote SFTP clipboard keep their existing behavior.
 */
function onSftpClipboardPaste(event: ClipboardEvent) {
  if (!connected.value || !canWrite.value) return;
  const files = filesFromClipboard(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  void uploadLocalFiles(files).catch(showError);
}

function onDrop(event: DragEvent) {
  dragActive.value = false;
  // 与终端侧共用同一道门禁；拒绝时给提示而不是无声吞掉拖入。
  if (!canAcceptFileDrop({ connected: connected.value, canWrite: canWrite.value })) {
    showNotice(t("dropRefused"));
    return;
  }
  // 根条目必须在本处理器内同步收（事件让出后 dataTransfer.items 失效）。
  const roots = event.dataTransfer ? collectDropRootEntries(event.dataTransfer.items) : null;
  void (async () => {
    if (roots) {
      const scan = await scanDroppedEntries(roots);
      if (scan.directories > 0) {
        // 含目录（空目录也一样）走文件夹管线：零文件由管线给 folderUpload.empty 提示。
        await uploadFolderFiles(scan.entries.map(folderEntryFromFile));
      } else if (scan.entries.length) {
        await uploadLocalFiles(scan.entries.map((entry) => entry.file));
      }
      return;
    }
    // webkitGetAsEntry 不可用（旧内核）时的回退：现状 files 车道。
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) await uploadLocalFiles(files);
  })().catch(showError);
}

/** 拖拽遍历结果 → 文件夹管线条目（readChunk 从 File 分片读）。 */
function folderEntryFromFile(entry: { file: File; relativePath: string }): FolderUploadEntry {
  const file = entry.file;
  return {
    name: file.name,
    relativePath: entry.relativePath,
    size: file.size,
    readChunk: (offset: number, length: number) => file.slice(offset, offset + length).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  };
}

function onSftpDragEnter(event: DragEvent) {
  // 只对文件拖拽点亮高亮：拖文本/元素路过不应给出可放置暗示（终端侧同款预检）。
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragActive.value = true;
}

function onSftpDragLeave(event: DragEvent) {
  // 拖拽真正离开面板子树才熄灭「上传」高亮（issue #197）：dragleave 在面板内
  // 子元素间移动时也冒泡触发，旧 `.self` 绑定把「经子元素拖出面板/拖出窗口/
  // Esc 取消」的那次 leave 一并吞掉，面板就永久停在上传悬浮层。
  const pane = event.currentTarget;
  if (pane instanceof Node && !dragLeftPane(event, pane)) return;
  dragActive.value = false;
}

function onTerminalDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value, sftpPaneOpen: sftpPaneOpen.value })) return;
  terminalDragActive.value = true;
}

function onTerminalDragLeave(event: DragEvent) {
  // 同面板侧（issue #197）：按 relatedTarget 判定去向，子元素间路过不闪烁，
  // 拖走/取消即恢复拖入前状态。
  const pane = event.currentTarget;
  if (pane instanceof Node && !dragLeftPane(event, pane)) return;
  terminalDragActive.value = false;
}

function onTerminalDrop(event: DragEvent) {
  terminalDragActive.value = false;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value, sftpPaneOpen: sftpPaneOpen.value })) {
    // 拒绝不再静默：面板打开时指引拖到面板（那里目录可见），其余（断连/
    // 只读/传输占用）给同一条提示。
    showNotice(t(sftpPaneOpen.value ? "terminalDropToPanel" : "dropRefused"));
    return;
  }
  // Files dropped on the terminal ask for a landing directory first: the
  // shell's cwd (SFTP directory tracking) or any absolute directory typed in
  // the prompt — silence would make a wrong-guess overwrite too easy.
  // 根条目同样在本处理器内同步收（与 SFTP 面板拖拽同款约束）。
  const roots = event.dataTransfer ? collectDropRootEntries(event.dataTransfer.items) : null;
  const fallbackFiles = Array.from(event.dataTransfer?.files || []);
  // Firefox 等浏览器对文件夹拖拽不给 dataTransfer.files：弹窗清单回退显示
  // 根目录名（同步可得，不受异步遍历影响）。
  const promptFiles = fallbackFiles.length
    ? fallbackFiles
    : (roots ?? []).filter((root) => root.isDirectory).map((root) => ({ name: root.name }));
  if (!promptFiles.length) return;
  void runTerminalDropUpload(fallbackFiles, roots, promptFiles);
}

async function runTerminalDropUpload(files: File[], roots: DropRootEntry[] | null, promptFiles: Array<{ name: string }>) {
  const choice = await askDropUploadTarget(promptFiles);
  terminalGet()?.focus();
  if (choice === "cancel") return;
  try {
    // 落点转 wire 形式（M17 增量②）：cwd 选项取 wire 化的解析结果，自定义
    // 目录是手输显示文本，latin-1 下经 wireDropDir 转换（auto 原样）。
    const targetDir = choice === "cwd" ? dropCwdTargetWire.value : wireDropDir(choice.dir);
    if (roots) {
      const scan = await scanDroppedEntries(roots);
      if (scan.directories > 0) {
        await uploadFolderFiles(scan.entries.map(folderEntryFromFile), targetDir);
        return;
      }
    }
    if (files.length) await uploadLocalFiles(files, targetDir);
  } catch (cause) {
    showError(cause);
  }
}

// 拖入落点询问链与确认/取消（askDropUploadTarget/confirmDropUpload/
// resolveDropUpload）下沉 useDropUploadTargetPrompt。


  return {
    uploadInput,
    lzpackUploadInput,
    onLzpackUploadInput,
    folderUploadInput,
    folderUploadSupported,
    folderUploadProgress,
    fileBatchProgress,
    dropUploadPrompt,
    dropUploadTarget,
    dropCwdTarget,
    dropCwdTargetWire,
    dropUploadPathInput,
    dropUploadPathInputEl,
    uploadDuplicatePrompt,
    uploadDuplicateApplyAll,
    wireDropDir,
    resolveUploadDuplicateName,
    resolveUploadDuplicate,
    onUploadInput,
    chooseFolderUpload,
    onFolderUploadInput,
    onSftpClipboardPaste,
    handleHostFileDrop,
    onDrop,
    onSftpDragEnter,
    onSftpDragLeave,
    onTerminalDragEnter,
    onTerminalDragLeave,
    onTerminalDrop,
    chooseUpload,
    confirmDropUpload,
    resolveDropUpload,
  };
}
