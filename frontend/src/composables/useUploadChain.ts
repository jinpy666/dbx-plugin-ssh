import { computed, nextTick, onMounted, ref, watch, type Ref } from "vue";
import { filesFromClipboard } from "../lib/clipboardFiles";
import { collectDropRootEntries, scanDroppedEntries, type DropRootEntry } from "../lib/dropEntries";
import { advanceFolderUploadDirectories, buildFolderUploadPlan, createFolderUploadProgress, folderUploadOutcome, settleFolderUploadFile, type FolderUploadProgress } from "../lib/folderUpload";
import { planHostFileDrop } from "../lib/hostFileDrop";
import { displayPathToWire } from "../lib/sftpName";
import { canAcceptTerminalDrop, canAcceptFileDrop, normalizeDropTargetDir, resolveDropTargetDir } from "../lib/terminalInteraction";
import { runTransfers } from "../lib/transferQueue";
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
  uploadSource: (name: string, size: number, readChunk: (offset: number, length: number) => Promise<Uint8Array>, resume?: { taskId: string; remotePath: string }, targetDir?: string, options?: { duplicatePreCheckedAbsent?: boolean }) => Promise<void>;
  loadTransferConcurrency: () => number;
  loadTransferMaxActive: () => number;
  loadTransferDuplicatePolicy: () => "rename" | "ask" | "overwrite";
  transferDuplicateState: Ref<"rename" | "ask" | "overwrite">;
  terminal: () => { focus: () => void } | undefined;
  loadDirectory: (path?: string) => Promise<void>;
  openTransferPanel: () => void;
  joinRemote: (parent: string, name: string) => string;
}) {
  const { t, showNotice, showError, session, connected, canWrite, currentPath, sftpHomePath, terminalCwd, sftpNameEncodingState, dragActive, terminalDragActive, sftpPaneOpen, terminalTransferBusy, uploadSource, loadTransferConcurrency, loadTransferMaxActive, loadTransferDuplicatePolicy, transferDuplicateState, terminal: terminalGet, loadDirectory, openTransferPanel, joinRemote } = options;

  // 批次并发与会话深度取小（评审 L-4）：批次上限（1..10）超过会话深度
  // （1..8，sidecar 权威）时，超出的任务会在 upload/start 被 "already has
  // N active transfers" 拒绝并中止整批——源头钳住而不是事后补救。
  const batchTransferLimit = () => Math.min(loadTransferConcurrency(), loadTransferMaxActive());

const uploadInput = ref<HTMLInputElement>();
// 文件夹上传（issue #78）：webkitdirectory 选择器 + 能力探测（缺失时入口隐藏）。
const folderUploadInput = ref<HTMLInputElement>();
const folderUploadSupported = ref(false);
// 文件夹批量上传的聚合进度（复用传输面板展示；目录 X/Y · 文件 N/M）。
const folderUploadProgress = ref<FolderUploadProgress>();

const dropUploadPrompt = ref<{ files: Array<{ name: string }> }>();
const dropUploadTarget = ref<"cwd" | "custom">("cwd");
// 拖拽落点解析：终端 cwd（OSC 7/633）优先，其次远端主目录，最后兜底面板目
// 录——终端拖拽只在面板关闭时接收，面板目录此刻不可见，仅作旧 sidecar 兜底。
// 弹窗展示的就是这里的解析结果。
const dropCwdTarget = computed(() => resolveDropTargetDir({ terminalCwd: terminalCwd.value || undefined, sftpHome: sftpHomePath.value || undefined, fallback: currentPath.value }));
// M17 增量②：上传落点的 wire 形式（弹窗仍展示 dropCwdTarget 的显示形式）。
// shell cwd 回读与 sftp home 探测结果是显示文本，latin-1 下经 displayPathToWire
// 转成 wire 形式（% 自转义、U+0080..FF → %XX、>U+00FF 按 UTF-8 兜底），与本地
// 文件名 join 后整条符合 sidecar write_path_bytes 的「wire 目录前缀 + 用户新
// 输入的显示末段」分工；fallback（面板当前目录）本身来自列表链的 wire 形式，
// 原样透传。已知边界：shell cwd 回读中非 UTF-8 的服务器字节在终端解码层已
// 丢失（U+FFFD），无法还原为 latin-1 字节（登记，不做恢复）。
const dropCwdTargetWire = computed(() => resolveDropTargetDir({
  terminalCwd: wireDropDir(terminalCwd.value),
  sftpHome: wireDropDir(sftpHomePath.value),
  fallback: currentPath.value,
}));

/** latin-1 显示文本 → wire 形式（拖入上传的手输/shell cwd 目录）；auto 原样。 */
function wireDropDir(dir: string | undefined): string | undefined {
  if (!dir) return dir;
  return sftpNameEncodingState.value === "latin-1" ? displayPathToWire(dir) : dir;
}
const dropUploadPathInput = ref("");
const dropUploadPathInputEl = ref<HTMLInputElement>();

let dropUploadResolver: ((choice: "cancel" | "cwd" | { dir: string }) => void) | undefined;

async function chooseUpload() {
  if (!connected.value || !canWrite.value) return;
  openTransferPanel();
  if (!window.dbxPlugin.fileTransfer) {
    uploadInput.value?.click();
    return;
  }
  try {
    const selection = await window.dbxPlugin.fileTransfer.pick({ multiple: true });
    await uploadHandleFiles(selection.files);
    await loadDirectory();
    if (selection.files.length) showNotice(t("uploaded", { count: selection.files.length }));
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

async function uploadHandleFiles(files: Array<{ handleId: string; name: string; size: number }>, targetDir?: string) {
  if (!window.dbxPlugin.fileTransfer || !files.length) return;
  uploadDuplicateBatchDecision = undefined;
  await runTransfers(files, batchTransferLimit(), {
    id: (file) => file.handleId,
    run: async (file) => {
      try {
        await uploadSource(file.name, file.size, async (offset, length) => {
          const result = await window.dbxPlugin.fileTransfer!.read(file.handleId, offset, length);
          return window.dbxPlugin.decodeBase64(result.dataBase64);
        }, undefined, targetDir);
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
  try {
    if (plan.kind === "terminal") {
      const choice = await askDropUploadTarget(files);
      terminalGet()?.focus();
      if (choice === "cancel") return;
      // 落点转 wire 形式（M17 增量②，与终端拖拽同款分工）。
      const targetDir = choice === "cwd" ? dropCwdTargetWire.value : wireDropDir(choice.dir);
      if (folderFiles.length) await uploadHostFolderEntries(folderFiles, targetDir);
      if (plainFiles.length) await uploadHandleFiles(plainFiles, targetDir);
    } else {
      if (folderFiles.length) await uploadHostFolderEntries(folderFiles);
      if (plainFiles.length) await uploadHandleFiles(plainFiles);
      await loadDirectory();
    }
    if (plainFiles.length) showNotice(t("uploaded", { count: plainFiles.length }));
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
  uploadDuplicateBatchDecision = undefined;
  // File 对象没有稳定 id：包一层带序号的 key 再交给调度器。
  const entries = files.map((file, index) => ({ file, key: `local-${index}` }));
  await runTransfers(entries, batchTransferLimit(), {
    id: (entry) => entry.key,
    run: (entry) => uploadSource(entry.file.name, entry.file.size, async (offset, length) => new Uint8Array(await entry.file.slice(offset, offset + length).arrayBuffer()), undefined, targetDir),
  });
  await loadDirectory();
  if (files.length) showNotice(t("uploaded", { count: files.length }));
}

let uploadDuplicateBatchDecision: "overwrite" | "rename" | undefined;

interface UploadDuplicatePrompt {
  fileName: string;
  path: string;
  resolve: (choice: "overwrite" | "rename" | undefined) => void;
}
const uploadDuplicatePrompt = ref<UploadDuplicatePrompt | null>(null);
const uploadDuplicateApplyAll = ref(false);

function resolveUploadDuplicate(choice: "overwrite" | "rename" | undefined) {
  if (choice !== undefined && uploadDuplicateApplyAll.value) uploadDuplicateBatchDecision = choice;
  uploadDuplicatePrompt.value?.resolve(choice);
  uploadDuplicatePrompt.value = null;
  uploadDuplicateApplyAll.value = false;
}

function askUploadDuplicate(fileName: string, path: string): Promise<"overwrite" | "rename" | undefined> {
  return new Promise((resolve) => {
    uploadDuplicatePrompt.value = { fileName, path, resolve };
  });
}

/**
 * 解析上传的最终远端文件名：目标已存在时按策略返回 proceed=false（放弃）或
 * 调整后的名字（rename 经后端 sftp/rename-unique 探测 name(1)..name(999)）。
 * 预检/重命名失败不阻断上传，回落现有覆盖语义。
 */
async function resolveUploadDuplicateName(name: string, targetDir: string): Promise<{ name: string; proceed: boolean }> {
  const sessionId = session.value?.sessionId;
  if (!sessionId) return { name, proceed: true };
  const targetPath = joinRemote(targetDir, name);
  let exists = false;
  try {
    const probe = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", { sessionId, path: targetPath });
    exists = probe.exists === true;
  } catch {
    // 预检不可用时保持原语义直接下发。
    return { name, proceed: true };
  }
  if (!exists) return { name, proceed: true };
  const policy = transferDuplicateState.value;
  if (policy === "overwrite") return { name, proceed: true };
  if (policy === "ask" && uploadDuplicateBatchDecision === undefined) {
    const choice = await askUploadDuplicate(name, targetPath);
    if (!choice) return { name, proceed: false };
    uploadDuplicateBatchDecision = choice;
  }
  if (policy === "ask" && uploadDuplicateBatchDecision === "overwrite") return { name, proceed: true };
  // rename（或 ask 选了重命名）：后端探测不冲突新名；旧 sidecar 无该方法时回落原名覆盖。
  try {
    const result = await window.dbxPlugin.invoke<{ name: string }>("sftp/rename-unique", { sessionId, dir: targetDir, name });
    return { name: result.name || name, proceed: true };
  } catch {
    return { name, proceed: true };
  }
}

function onUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (files.length) void uploadLocalFiles(files).catch(showError);
}

// —— 文件夹上传（issue #78）：纯前端编排，复用既有 sftp/upload 管线 ——
// 选目录 → buildFolderUploadPlan 生成远端目录集 + 文件清单 → 逐目录
// sftp/createDirectory（逐个 ensure，父先于子）→ 逐文件 uploadSource
// （冲突策略：rename/overwrite 交给既有 resolveUploadDuplicateName；ask 在
// 批量下降级为「已存在即跳过」+ 完成提示计数，避免上百次弹窗交互）。
// 能力探测：浏览器无 webkitdirectory 支持时入口隐藏（onMounted 一次性探测）。

function chooseFolderUpload() {
  if (!connected.value || !canWrite.value || !folderUploadSupported.value) return;
  openTransferPanel();
  folderUploadInput.value?.click();
}

function onFolderUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length) return;
  void uploadFolderFiles(files.map((file) => ({
    name: file.name,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || "",
    size: file.size,
    readChunk: (offset: number, length: number) => file.slice(offset, offset + length).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  }))).catch(showError);
}

interface FolderUploadEntry {
  name: string;
  relativePath: string;
  size: number;
  readChunk: (offset: number, length: number) => Promise<Uint8Array>;
}

async function uploadFolderFiles(entries: readonly FolderUploadEntry[], baseDir?: string) {
  if (!session.value || !canWrite.value) return;
  // 并发 run 闭包里不能用 session.value（TS 无法跨异步闭包收窄）：守卫后
  // 捕获一次。
  const sessionId = session.value.sessionId;
  // baseDir：终端/宿主桥拖入的自定义落点；缺省仍是 SFTP 当前目录。
  const base = baseDir ?? currentPath.value;
  const plan = buildFolderUploadPlan(entries);
  if (!plan.files.length) {
    showNotice(t("folderUpload.empty"));
    return;
  }
  openTransferPanel();
  let progress = createFolderUploadProgress(plan);
  const publish = (currentFile = "") => {
    folderUploadProgress.value = { ...progress, currentFile };
  };
  publish();
  // 逐目录 ensure：集合已去重且父先于子；单目录失败不阻断（文件上传会
  // 因目录缺失自然失败并计入 failed），创建失败只降级提示。
  for (const relative of plan.directories) {
    const remotePath = joinRemote(base, relative);
    try {
      await window.dbxPlugin.invoke("sftp/createDirectory", { sessionId: session.value.sessionId, path: remotePath });
    } catch {
      // 已存在/权限不足等：由后续文件上传结果兜底，这里不中止整批。
    }
    progress = advanceFolderUploadDirectories(progress);
    publish();
  }
  let skipped = 0;
  let failed = 0;
  // 逐文件上传走 runTransfers（评审 M-4）：尊重批次并发偏好，不再纯串行；
  // 聚合进度（文件 N/M · 当前相对路径）在并发 run 里同步推进（单线程事件
  // 循环内 read-modify-write 无交错）。单文件失败计 failed 不中止整批——
  // catch 吞掉不外抛，runTransfers 的失败中止语义不触发；用户取消同理
  // （计 failed，批次继续，与既有串行语义一致）。
  await runTransfers(plan.files.map((file, index) => ({ file, entry: entries[index], index })), batchTransferLimit(), {
    id: (item) => `folder-${item.index}`,
    run: async (item) => {
      const { file, entry } = item;
      progress.currentFile = file.relativePath;
      publish(file.relativePath);
      const segments = file.relativePath.split("/");
      const dirSegments = segments.slice(0, -1);
      const fileName = segments[segments.length - 1];
      const targetDir = dirSegments.length ? joinRemote(base, dirSegments.join("/")) : base;
      try {
        // ask 模式批量降级：预检已存在则跳过；不存在则带 preCheckedAbsent
        // 上传，免去 uploadSource 内的第二次 sftp/exists（评审 M-4）。
        if (loadTransferDuplicatePolicy() === "ask") {
          const probe = await window.dbxPlugin.invoke<{ exists: boolean }>("sftp/exists", { sessionId, path: joinRemote(targetDir, fileName) }).catch(() => ({ exists: false }));
          if (probe.exists === true) {
            skipped += 1;
            progress = settleFolderUploadFile(progress, { file, ok: false });
            publish();
            return;
          }
          await uploadSource(fileName, file.size, entry.readChunk, undefined, targetDir, { duplicatePreCheckedAbsent: true });
        } else {
          await uploadSource(fileName, file.size, entry.readChunk, undefined, targetDir);
        }
        progress = settleFolderUploadFile(progress, { file, ok: true });
      } catch {
        failed += 1;
        progress = settleFolderUploadFile(progress, { file, ok: false });
      }
      publish();
    },
  });
  const outcome = folderUploadOutcome(progress, skipped, failed);
  folderUploadProgress.value = undefined;
  await loadDirectory();
  let message: string;
  if (outcome.failed) {
    message = t("folderUpload.completedWithFailures", { count: outcome.failed, total: outcome.fileCount });
  } else {
    message = t("folderUpload.completed", { count: outcome.uploaded });
  }
  if (outcome.skipped) message += t("folderUpload.skippedNote", { count: outcome.skipped });
  showNotice(message);
}

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

function onTerminalDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  if (!canAcceptTerminalDrop({ connected: connected.value, canWrite: canWrite.value, transferBusy: terminalTransferBusy.value, sftpPaneOpen: sftpPaneOpen.value })) return;
  terminalDragActive.value = true;
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

function askDropUploadTarget(files: Array<{ name: string }>): Promise<"cancel" | "cwd" | { dir: string }> {
  dropUploadTarget.value = "cwd";
  dropUploadPathInput.value = "";
  return new Promise((resolve) => {
    dropUploadResolver = resolve;
    dropUploadPrompt.value = { files };
  });
}

// 选中“指定目录”即聚焦路径输入框（禁用态拿不到焦点，所以不在打开时聚焦）：
// 键盘流为拖入 → Tab/方向键切到自定义 → 直接输入 → Enter 提交。
watch(dropUploadTarget, async (target) => {
  if (target !== "custom") return;
  await nextTick();
  dropUploadPathInputEl.value?.focus();
});

function confirmDropUpload() {
  if (!dropUploadPrompt.value) return;
  if (dropUploadTarget.value === "custom") {
    const dir = normalizeDropTargetDir(dropUploadPathInput.value);
    if (!dir) return;
    resolveDropUpload({ dir });
    return;
  }
  resolveDropUpload("cwd");
}

function resolveDropUpload(choice: "cancel" | "cwd" | { dir: string }) {
  dropUploadPrompt.value = undefined;
  const resolve = dropUploadResolver;
  dropUploadResolver = undefined;
  resolve?.(choice);
}


  return {
    uploadInput,
    folderUploadInput,
    folderUploadSupported,
    folderUploadProgress,
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
    onTerminalDragEnter,
    onTerminalDrop,
    chooseUpload,
    confirmDropUpload,
    resolveDropUpload,
  };
}
