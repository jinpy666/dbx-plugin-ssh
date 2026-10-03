import type { Detection as ZmodemDetection, Session as ZmodemSession, Sentry as ZmodemSentry, ZmodemFileDetails, ZmodemOffer } from "zmodem.js";
import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import {
  createZmodemSentry,
  decideZmodemDetection,
  mergeZmodemChunks,
  receiveZmodemSession,
  sanitizeZmodemFileName,
  sendZmodemFiles,
  type ZmodemUploadProgress,
} from "../lib/terminalZmodem";
import { sampleTransferSpeed, type TransferSpeedSample } from "../lib/transferSpeed";
import { standaloneArrayBuffer } from "../lib/standaloneBuffer";

/** ZMODEM 上传/下载（sentry 常驻下行流 + rz 菜单上传 + 远端 sz 自动接收）：
 * 检测/协商/进度/落盘/收尾。与 trzsz 同一条终端输出分发链
 * （dispatchTerminalOutput 优先交给 zmodem）；输入路由与菜单入口仍在 App.vue。
 * 下载落盘与 useTrzsz 同一三段式：宿主 fileTransfer（流式）优先，sidecar
 * `local/saveFile`（下载目录设置/冲突处理）次之，浏览器 saveFile 兜底。 */
export function useZmodem(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  connected: Ref<boolean>;
  terminal: () => { focus: () => void } | undefined;
  sendTerminalBytes: (data: Uint8Array) => void;
  dispatchTerminalOutput: (data: Uint8Array) => void;
  loadDirectory: (path?: string) => Promise<void>;
  /** trzsz 持流时拒绝接收（deny 走 abort 序列，远端干净退出）。 */
  receiveAllowed: () => boolean;
  probeLocalCapabilities: () => Promise<{ canSaveLocal: boolean; downloadsDir: string } | undefined>;
  saveHostFile: (chunks: Uint8Array[], fileName: string) => Promise<void>;
  loadDownloadUseDefaultDir: () => boolean;
  askDownloadTarget: (fileName: string) => Promise<{ dir: string; setDefault: boolean } | undefined>;
  loadDownloadDir: () => string;
  resolveDownloadConflictFor: (dir: string, fileName: string) => Promise<"rename" | "overwrite" | undefined>;
  applyChosenDirAsDefault: (dir: string) => void;
  revealTransferTarget: (path: string) => Promise<void>;
}) {
  const { t, showNotice, showError, connected, terminal: terminalGet, sendTerminalBytes, dispatchTerminalOutput, loadDirectory, receiveAllowed, probeLocalCapabilities, saveHostFile, loadDownloadUseDefaultDir, askDownloadTarget, loadDownloadDir, resolveDownloadConflictFor, applyChosenDirAsDefault, revealTransferTarget } = options;

const ZMODEM_DETECTION_TIMEOUT_MS = 5000;

const zmodemState = ref<"idle" | "waiting" | "uploading" | "receiving">("idle");
const zmodemFileName = ref("");
const zmodemTransferred = ref(0);
const zmodemTotalSize = ref(0);
const zmodemSpeed = ref(0);
const zmodemFileIndex = ref(0);
const zmodemFileCount = ref(0);

let zmodemSentry: ZmodemSentry | null = null;
let zmodemSession: ZmodemSession | null = null;
let pendingZmodemFiles: File[] = [];
let zmodemDetectionTimer = 0;
let zmodemSampledAt = 0;
let zmodemSampledBytes = 0;

// 接收（sz 下载）会话状态：落盘通道按批次决定一次，文件逐个落盘。
type ZmodemReceiveChannel = "fileTransfer" | "sidecar" | "hostSave" | "cancelled";
let receiveChannel: ZmodemReceiveChannel | null = null;
let receiveTargetDir = "";
let receiveSetDefaultAfter = false;
let receiveLastSavedPath = "";
let receivedFileCount = 0;
let savedFileCount = 0;
let receivedBytesTotal = 0;
let receiveFileBytes = 0;
let receiveSpeedSample: TransferSpeedSample | undefined;

const zmodemBusy = computed(() => zmodemState.value !== "idle");
const zmodemPercent = computed(() => zmodemTotalSize.value > 0 ? Math.min(100, Math.round((zmodemTransferred.value / zmodemTotalSize.value) * 100)) : 0);

const zmodemStatusLabel = computed(() => {
  switch (zmodemState.value) {
    case "waiting":
      return t("zmodemWaiting");
    case "uploading":
      return t("zmodemUploading", { name: zmodemFileName.value, percent: zmodemPercent.value });
    case "receiving":
      return t("zmodemReceiving", { name: zmodemFileName.value, percent: zmodemPercent.value });
    default:
      return "";
  }
});

function resetZmodemSentry() {
  zmodemSentry = createZmodemSentry({
    send: sendTerminalBytes,
    toTerminal: dispatchTerminalOutput,
    onDetect: handleZmodemDetection,
    onRetract() {},
  });
}

function handleZmodemDetection(detection: ZmodemDetection) {
  const decision = decideZmodemDetection(detection, pendingZmodemFiles.length > 0, receiveAllowed());
  if (decision.action === "deny") {
    detection.deny();
    if (decision.reason === "uploadPending") finishZmodemUpload(new Error(t("zmodemUploadInterrupted")));
    return;
  }
  try {
    zmodemSession = detection.confirm();
  } catch (cause) {
    finishZmodemUpload(cause);
    return;
  }
  window.clearTimeout(zmodemDetectionTimer);
  if (decision.role === "receive") {
    startZmodemReceive(zmodemSession);
    return;
  }
  zmodemState.value = "uploading";
  zmodemSampledAt = performance.now();
  zmodemSampledBytes = 0;
  const files = pendingZmodemFiles;
  void sendZmodemFiles(zmodemSession, files, updateZmodemProgress)
    .then(() => {
      showNotice(t("zmodemUploadComplete", { count: files.length }));
      finishZmodemUpload();
      void loadDirectory();
    })
    .catch(finishZmodemUpload);
}

function updateZmodemProgress(progress: ZmodemUploadProgress) {
  zmodemFileName.value = progress.file.name;
  zmodemTransferred.value = progress.totalTransferred;
  zmodemTotalSize.value = progress.totalSize;
  const now = performance.now();
  const elapsed = now - zmodemSampledAt;
  if (elapsed >= 250 || progress.totalTransferred === progress.totalSize) {
    const speed = elapsed > 0 ? ((progress.totalTransferred - zmodemSampledBytes) * 1000) / elapsed : 0;
    zmodemSpeed.value = zmodemSpeed.value ? zmodemSpeed.value * 0.65 + speed * 0.35 : speed;
    zmodemSampledAt = now;
    zmodemSampledBytes = progress.totalTransferred;
  }
}

function finishZmodemUpload(cause?: unknown) {
  const wasActive = zmodemState.value !== "idle";
  const receiving = zmodemState.value === "receiving";
  // 收尾容错：lrzsz sz 的 saybibi 只等 10s 接收方 ZFIN，慢了就直接退出不发
  // "OO"，随后的 shell 提示符字节会让 zmodem.js 在 post-ZFIN 解析上抛
  // PROTOCOL 异常——此时文件早已全部收完落盘，按成功收尾而不是报错。
  // （正常完成路径的成功通知由 startZmodemReceive 发，这里只在容错分支发，
  // 避免双重提示。）
  const gracefulReceive = Boolean(cause) && receiving && savedFileCount > 0 && savedFileCount === receivedFileCount;
  const savedCount = savedFileCount;
  const savedPath = receiveLastSavedPath;
  cancelZmodemUpload();
  if (!wasActive) return;
  if (gracefulReceive) {
    showNotice(t("zmodemReceiveComplete", { count: savedCount }), savedPath
      ? [{ label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) }]
      : undefined);
  } else if (cause) {
    const key = receiving ? "zmodemReceiveFailed" : "zmodemUploadFailed";
    showError(new Error(t(key, { error: cause instanceof Error ? cause.message : String(cause) })), "terminal");
  }
  terminalGet()?.focus();
}

/**
 * Silently tears the ZMODEM state down (abort the wire session, drop pending
 * files, reset the overlay, rebuild the sentry). Used both after a completed
 * or failed transfer and when the SSH session is closed mid-transfer —
 * without it a closed session would leave zmodemBusy stuck true and terminal
 * input routed into a dead sentry.
 */
function cancelZmodemUpload() {
  window.clearTimeout(zmodemDetectionTimer);
  if (zmodemSession && !zmodemSession.has_ended()) {
    try { zmodemSession.abort(); } catch {}
  }
  pendingZmodemFiles = [];
  zmodemSession = null;
  zmodemState.value = "idle";
  zmodemFileName.value = "";
  zmodemTransferred.value = 0;
  zmodemTotalSize.value = 0;
  zmodemSpeed.value = 0;
  zmodemFileIndex.value = 0;
  zmodemFileCount.value = 0;
  resetZmodemSentry();
}

function onZmodemInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || !connected.value) return;
  pendingZmodemFiles = files;
  zmodemState.value = "waiting";
  zmodemFileName.value = files[0]?.name || "";
  zmodemTransferred.value = 0;
  zmodemTotalSize.value = files.reduce((sum, file) => sum + file.size, 0);
  resetZmodemSentry();
  sendTerminalBytes(new TextEncoder().encode("rz\r"));
  zmodemDetectionTimer = window.setTimeout(() => finishZmodemUpload(new Error(t("zmodemNotAvailable"))), ZMODEM_DETECTION_TIMEOUT_MS);
}

/** 终端帧经 zmodem sentry 消费；失败时按占用态分流：busy=收尾传输，
 * 空闲=重建 sentry 并把帧回落到普通终端输出分发。 */
function consumeFrameViaZmodem(data: Uint8Array) {
  try {
    if (!zmodemSentry) resetZmodemSentry();
    zmodemSentry?.consume(data.slice().buffer);
  } catch (cause) {
    if (zmodemBusy.value) finishZmodemUpload(cause);
    else {
      resetZmodemSentry();
      dispatchTerminalOutput(data);
    }
  }
}

// ---------------------------------------------------------------------------
// 接收（远端 sz）：offer 逐个接管，按批次选一次落盘通道，文件逐个保存。
// ---------------------------------------------------------------------------

function startZmodemReceive(session: ZmodemSession) {
  zmodemState.value = "receiving";
  receiveChannel = null;
  receiveTargetDir = "";
  receiveSetDefaultAfter = false;
  receiveLastSavedPath = "";
  receivedFileCount = 0;
  savedFileCount = 0;
  receivedBytesTotal = 0;
  receiveFileBytes = 0;
  receiveSpeedSample = undefined;
  zmodemFileIndex.value = 0;
  zmodemFileCount.value = 0;
  void receiveZmodemSession(session, handleReceiveOffer).then((outcome) => {
    if (session.aborted()) return; // 主动取消：cancelZmodemUpload 已收尾
    if (outcome.error !== undefined) {
      if (!session.has_ended()) {
        try { session.abort(); } catch {}
      }
      finishZmodemUpload(outcome.error);
      return;
    }
    const savedCount = savedFileCount;
    const savedPath = receiveLastSavedPath;
    finishZmodemUpload();
    if (savedCount > 0) {
      showNotice(t("zmodemReceiveComplete", { count: savedCount }), savedPath
        ? [{ label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) }]
        : undefined);
    }
    if (receiveSetDefaultAfter && receiveTargetDir) applyChosenDirAsDefault(receiveTargetDir);
  });
}

/** 按批次选一次落盘通道（与 useTrzsz.saveTrzszDownloadedFiles 同一优先级：
 * 宿主 fileTransfer → sidecar 本机落盘（可设下载目录/每次询问）→ 浏览器
 * saveFile 兜底）。取消目录选择视为放弃整批接收。 */
async function chooseReceiveChannel(firstFileName: string): Promise<void> {
  if (window.dbxPlugin.fileTransfer) {
    receiveChannel = "fileTransfer";
    return;
  }
  const local = await probeLocalCapabilities().catch(() => undefined);
  if (!local?.canSaveLocal) {
    receiveChannel = "hostSave";
    return;
  }
  receiveChannel = "sidecar";
  let targetDir = "";
  let setDefaultAfter = false;
  if (!loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(firstFileName);
    if (chosen === undefined) {
      receiveChannel = "cancelled";
      return;
    }
    targetDir = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  receiveTargetDir = targetDir || loadDownloadDir() || "";
  receiveSetDefaultAfter = setDefaultAfter;
}

async function handleReceiveOffer(offer: ZmodemOffer): Promise<void> {
  const details = offer.get_details();
  const fileName = sanitizeZmodemFileName(details.name ?? "");
  receivedFileCount += 1;
  receiveFileBytes = 0;
  zmodemFileName.value = fileName;
  zmodemFileIndex.value = receivedFileCount;
  zmodemFileCount.value = details.files_remaining ?? 0;

  if (receiveChannel === null) await chooseReceiveChannel(fileName);
  if (receiveChannel === "cancelled") {
    void offer.skip();
    return;
  }
  if (receiveChannel === "fileTransfer") {
    await receiveViaFileTransfer(offer, fileName, details);
    return;
  }
  const chunks: Uint8Array[] = [];
  await offer.accept({
    on_input: (payload) => noteReceiveChunk(Uint8Array.from(payload), chunks, fileName, details),
  });
  if (receiveChannel === "sidecar") await saveReceivedFileViaSidecar(fileName, chunks);
  else await saveHostFile(chunks, fileName);
}

/** 宿主 fileTransfer 流式落盘：beginSave 打开目标后随 on_input 逐块写，
 * 不在内存攒整文件；用户取消原生保存框只跳过该文件（批内继续）。 */
async function receiveViaFileTransfer(offer: ZmodemOffer, fileName: string, details: ZmodemFileDetails): Promise<void> {
  const fileTransfer = window.dbxPlugin.fileTransfer!;
  const target = await fileTransfer.beginSave({ name: fileName, size: details.size ?? 0 });
  if (!target) {
    void offer.skip();
    return;
  }
  let offset = 0;
  let writeChain: Promise<void> = Promise.resolve();
  // 持有者对象而非可空 let：TS 的控制流分析不追踪闭包内赋值，`if (err)`
  // 会被窄化成 never；属性读取没有这个问题。
  const writeState: { error: unknown } = { error: null };
  try {
    await offer.accept({
      on_input: (payload) => {
        const chunk = Uint8Array.from(payload);
        const at = offset;
        offset += chunk.length;
        noteReceiveProgress(chunk.length, fileName, details);
        writeChain = writeChain.then(async () => {
          if (writeState.error !== null) return;
          try {
            await fileTransfer.write(target.handleId, at, standaloneArrayBuffer(chunk));
          } catch (cause) {
            writeState.error = cause;
          }
        });
      },
    });
    await writeChain;
    if (writeState.error !== null) throw writeState.error;
    await fileTransfer.finish(target.handleId);
  } catch (cause) {
    await fileTransfer.cancel(target.handleId).catch(() => undefined);
    throw cause;
  }
  savedFileCount += 1;
}

async function saveReceivedFileViaSidecar(fileName: string, chunks: Uint8Array[]): Promise<void> {
  // 冲突策略逐文件生效：ask 撞名逐个询问，取消只跳过该文件（与 trzsz 一致）。
  const conflict = await resolveDownloadConflictFor(receiveTargetDir, fileName);
  if (conflict === undefined) return;
  const merged = mergeZmodemChunks(chunks);
  const saved = await window.dbxPlugin.invoke<{ localPath: string; name: string }>("local/saveFile", {
    name: fileName,
    dataBase64: window.dbxPlugin.encodeBase64(merged),
    targetDir: receiveTargetDir || undefined,
    conflict: conflict === "overwrite" ? "overwrite" : undefined,
  });
  receiveLastSavedPath = saved.localPath;
  savedFileCount += 1;
}

/** 进度记账：每文件的字节进度 + 会话总量的速度采样（与 trzsz 同款 EWMA）。 */
function noteReceiveChunk(chunk: Uint8Array, spool: Uint8Array[], fileName: string, details: ZmodemFileDetails) {
  spool.push(chunk);
  noteReceiveProgress(chunk.length, fileName, details);
}

function noteReceiveProgress(length: number, fileName: string, details: ZmodemFileDetails) {
  receiveFileBytes += length;
  receivedBytesTotal += length;
  zmodemFileName.value = fileName;
  zmodemTransferred.value = receiveFileBytes;
  zmodemTotalSize.value = details.size ?? 0;
  receiveSpeedSample = sampleTransferSpeed(receiveSpeedSample, receivedBytesTotal, performance.now());
  zmodemSpeed.value = receiveSpeedSample.speed;
}

onBeforeUnmount(() => {
  window.clearTimeout(zmodemDetectionTimer);
});


  return {
    zmodemState,
    zmodemFileName,
    zmodemTransferred,
    zmodemTotalSize,
    zmodemSpeed,
    zmodemFileIndex,
    zmodemFileCount,
    zmodemBusy,
    zmodemPercent,
    zmodemStatusLabel,
    resetZmodemSentry,
    finishZmodemUpload,
    cancelZmodemUpload,
    onZmodemInput,
    consumeFrameViaZmodem,
  };
}
