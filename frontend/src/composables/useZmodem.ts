import type { Detection as ZmodemDetection, Session as ZmodemSession, Sentry as ZmodemSentry } from "zmodem.js";
import { computed, onBeforeUnmount, ref, type Ref } from "vue";
import { createZmodemSentry, decideZmodemDetection, sendZmodemFiles, type ZmodemUploadProgress } from "../lib/terminalZmodem";

/** ZMODEM 上传（sentry 常驻下行流 + rz 菜单上传）：检测/协商/进度/收尾。
 * 与 trzsz 同一条终端输出分发链（dispatchTerminalOutput 优先交给 zmodem）；
 * 输入路由与菜单入口仍在 App.vue。 */
export function useZmodem(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  connected: Ref<boolean>;
  terminal: () => { focus: () => void } | undefined;
  sendTerminalBytes: (data: Uint8Array) => void;
  dispatchTerminalOutput: (data: Uint8Array) => void;
  loadDirectory: (path?: string) => Promise<void>;
}) {
  const { t, showNotice, showError, connected, terminal: terminalGet, sendTerminalBytes, dispatchTerminalOutput, loadDirectory } = options;

const ZMODEM_DETECTION_TIMEOUT_MS = 5000;

const zmodemState = ref<"idle" | "waiting" | "uploading">("idle");
const zmodemFileName = ref("");
const zmodemTransferred = ref(0);
const zmodemTotalSize = ref(0);
const zmodemSpeed = ref(0);

let zmodemSentry: ZmodemSentry | null = null;
let zmodemSession: ZmodemSession | null = null;
let pendingZmodemFiles: File[] = [];
let zmodemDetectionTimer = 0;
let zmodemSampledAt = 0;
let zmodemSampledBytes = 0;

const zmodemBusy = computed(() => zmodemState.value !== "idle");
const zmodemPercent = computed(() => zmodemTotalSize.value > 0 ? Math.min(100, Math.round((zmodemTransferred.value / zmodemTotalSize.value) * 100)) : 0);

function resetZmodemSentry() {
  zmodemSentry = createZmodemSentry({
    send: sendTerminalBytes,
    toTerminal: dispatchTerminalOutput,
    onDetect: handleZmodemDetection,
    onRetract() {},
  });
}

function handleZmodemDetection(detection: ZmodemDetection) {
  const decision = decideZmodemDetection(detection, pendingZmodemFiles.length > 0);
  if (decision.action === "deny") {
    detection.deny();
    if (decision.reason === "roleMismatch") finishZmodemUpload(new Error(t("zmodemUploadOnly")));
    return;
  }
  try {
    zmodemSession = detection.confirm();
  } catch (cause) {
    finishZmodemUpload(cause);
    return;
  }
  window.clearTimeout(zmodemDetectionTimer);
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
  cancelZmodemUpload();
  if (!wasActive) return;
  if (cause) showError(new Error(t("zmodemUploadFailed", { error: cause instanceof Error ? cause.message : String(cause) })), "terminal");
  terminalGet()?.focus();
}

/**
 * Silently tears the ZMODEM state down (abort the wire session, drop pending
 * files, reset the overlay, rebuild the sentry). Used both after a completed
 * or failed upload and when the SSH session is closed mid-transfer — without
 * it a closed session would leave zmodemBusy stuck true and terminal input
 * routed into a dead sentry.
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

onBeforeUnmount(() => {
  window.clearTimeout(zmodemDetectionTimer);
});


  return {
    zmodemState,
    zmodemFileName,
    zmodemTransferred,
    zmodemTotalSize,
    zmodemSpeed,
    zmodemBusy,
    zmodemPercent,
    resetZmodemSentry,
    finishZmodemUpload,
    cancelZmodemUpload,
    onZmodemInput,
    consumeFrameViaZmodem,
  };
}
