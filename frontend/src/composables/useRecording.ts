import { type TerminalThemeLike } from "../lib/terminalScheme";
import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { encodeGif } from "../lib/gifEncoder";
import { nextCountdownValue, RECORD_COUNTDOWN_START } from "../lib/recordingCountdown";
import { createRequestEpoch } from "../lib/requestEpoch";
import { buildTimeline, gifFramePlan, type RecordingSummary, type ReplayEvent } from "../lib/replayScheduler";
import { standaloneArrayBuffer } from "../lib/standaloneBuffer";
import { terminalOptionPatch, type TerminalAppearanceState } from "../lib/terminalAppearance";
import { resolveTerminalFont, type TerminalFontOverride } from "../lib/terminalFont";
import { attachWebglRenderer } from "../lib/terminalWebgl";
import { buildTranscript, transcriptFileName } from "../lib/transcript";
import { formatDuration, formatRecordedAt } from "../lib/recordingFormat";
import { useReplayPlayer } from "./useReplayPlayer";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

/** F3：终端录制 + 回放（asciicast v2）———

录制开始倒计时（录制软件惯例）：点击后 3→2→1 动画，归零才真正
recording/start；Esc/点击遮罩取消。录制中工具栏按钮变红，终端区底部
 * 状态与录制/回放/GIF 导出交互收口在 composables/useRecording（原 F3 分节整体迁移）。 */
export function useRecording(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string, actions?: Array<{ label: string; run: () => void }>) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  /** 录制目标会话：SSH 会话或本地 PTY（dock 本地终端），缺省=无可录制会话。 */
  recordingTarget: Ref<{ kind: "ssh" | "local"; sessionId: string } | undefined>;
  appearance: Ref<{ terminal: { fontSize: number } }>;
  terminalTheme: () => TerminalThemeLike;
  openTransferTarget: (path: string) => Promise<void>;
  revealTransferTarget: (path: string) => Promise<void>;
  terminalFontOverride: Ref<TerminalFontOverride>;
  terminalAppearance: Ref<TerminalAppearanceState>;
  hostFontFamily: () => string;
  closeMetrics: () => void;
  loadDownloadDir: () => string;
  loadDownloadUseDefaultDir: () => boolean;
  askDownloadTarget: (fileName: string) => Promise<{ dir: string; setDefault: boolean } | undefined>;
  applyChosenDirAsDefault: (dir: string) => void;
  resolveDownloadConflictFor: (dir: string, fileName: string) => Promise<"rename" | "overwrite" | undefined>;
  probeLocalCapabilities: () => Promise<{ canSaveLocal: boolean; downloadsDir: string } | undefined>;
  saveHostFile: (chunks: Uint8Array[], fileName: string) => Promise<void>;
}) {
  const { t, showNotice, showError, recordingTarget, appearance, terminalTheme, openTransferTarget, revealTransferTarget, terminalFontOverride, terminalAppearance, hostFontFamily, closeMetrics, loadDownloadDir, loadDownloadUseDefaultDir, askDownloadTarget, applyChosenDirAsDefault, resolveDownloadConflictFor, probeLocalCapabilities, saveHostFile } = options;

  // 回放播放器（分页拉全/外观跟随/rAF 推进/倍速锚定/请求序号守卫）下沉
  // useReplayPlayer：录制列表与导出经返回面读 replayState，返回面保持不变。
  const {
    REPLAY_EVENT_CAP, replayState, replayPlaying, replaySpeed, replayPlayheadMs, replayDurationMs, replayHost,
    loadReplayEvents, openReplay, closeReplay, stopReplayLoop, replayFrame, toggleReplayPlay, onReplaySeek,
  } = useReplayPlayer({ showError, appearance, terminalTheme, terminalFontOverride, terminalAppearance, hostFontFamily });

const recordingActive = ref(false);
const recordingsOpen = ref(false);
const recordings = ref<RecordingSummary[]>([]);
const recordingsLoading = ref(false);
// 删除确认走应用内弹窗：工作台 iframe 是 sandbox="allow-scripts"（无
// allow-modals），window.confirm 恒返回 false——曾让删除按钮看起来完全失效。
const recordingDeleteTarget = ref<RecordingSummary | null>(null);
const recordingDeleteSubmitting = ref(false);
// 行内导出进行中的 recordingId：多条记录共用全局导出锁（replayExporting），
// 只有发起行显示 Encoding…，其余行仅禁用。
const recordingExportingId = ref<string | null>(null);
// replayState/replayPlaying/replaySpeed/replayPlayheadMs/replayHost 五个
// 回放状态随播放器下沉 useReplayPlayer；replayExporting 是导出锁，留在本处。
const replayExporting = ref(false);

const recordCountdown = ref<number | null>(null);
const recordingStartedAt = ref<number | null>(null);
const recordingElapsedSec = ref(0);
let recordCountdownTimer = 0;
let recordingElapsedTimer = 0;

function beginRecordCountdown() {
  if (!recordingTarget.value || recordCountdown.value !== null) return;
  recordCountdown.value = RECORD_COUNTDOWN_START;
  window.clearInterval(recordCountdownTimer);
  recordCountdownTimer = window.setInterval(() => {
    const next = nextCountdownValue(recordCountdown.value);
    recordCountdown.value = next;
    if (next === null) {
      window.clearInterval(recordCountdownTimer);
      void startRecordingNow();
    }
  }, 1000);
}

function cancelRecordCountdown() {
  window.clearInterval(recordCountdownTimer);
  recordCountdown.value = null;
}

function startRecordingClock() {
  recordingStartedAt.value = Date.now();
  recordingElapsedSec.value = 0;
  window.clearInterval(recordingElapsedTimer);
  recordingElapsedTimer = window.setInterval(() => {
    recordingElapsedSec.value = recordingStartedAt.value
      ? Math.floor((Date.now() - recordingStartedAt.value) / 1000)
      : 0;
  }, 1000);
}

function stopRecordingClock() {
  window.clearInterval(recordingElapsedTimer);
  recordingStartedAt.value = null;
  recordingElapsedSec.value = 0;
}

async function startRecordingNow() {
  const target = recordingTarget.value;
  if (!target || recordingActive.value) return;
  try {
    await window.dbxPlugin.invoke(
      target.kind === "local" ? "local/recording/start" : "ssh/recording/start",
      { sessionId: target.sessionId },
    );
    recordingActive.value = true;
    startRecordingClock();
    showNotice(t("recordingStarted"));
  } catch (cause) {
    showError(cause);
  }
}

async function toggleRecording() {
  const target = recordingTarget.value;
  if (!target) return;
  if (!recordingActive.value) {
    beginRecordCountdown();
    return;
  }
  try {
    await window.dbxPlugin.invoke(
      target.kind === "local" ? "local/recording/stop" : "ssh/recording/stop",
      { sessionId: target.sessionId },
    );
    recordingActive.value = false;
    stopRecordingClock();
    showNotice(t("recordingStopped"));
    if (recordingsOpen.value) await loadRecordings();
  } catch (cause) {
    showError(cause);
  }
}

// 目标会话消失（SSH 断开 / 本地 shell 退出）：sidecar 侧录制随会话槽位
// 终止，前端红点与计时器同步复位，不悬挂在已消失的会话上。
watch(recordingTarget, (target) => {
  if (!target && recordingActive.value) {
    recordingActive.value = false;
    stopRecordingClock();
  }
});

async function loadRecordings() {
  recordingsLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ recordings: RecordingSummary[] }>("ssh/recording/list", {});
    recordings.value = result.recordings ?? [];
  } catch {
    recordings.value = [];
  } finally {
    recordingsLoading.value = false;
  }
  // 列表有增删（删除/清空/新录制）时同步刷新内容搜索命中。
  if (recordingsQuery.value.trim()) void runRecordingSearch();
}

function toggleRecordings() {
  const next = !recordingsOpen.value;
  if (next) {
    // 与指标浮层同位渲染：打开录制列表时收起指标，防止叠压。
    closeMetrics();
    void probeLocalCapabilities();
    void loadRecordings();
  }
  recordingsOpen.value = next;
}

// 打开录制文件所在目录：仅在桌面端（sidecar 在本机）有意义，
// web/docker 的录制文件在远端服务器上。
async function revealRecording(item: RecordingSummary) {
  try {
    await window.dbxPlugin.invoke("ssh/recording/reveal", { recordingId: item.recordingId });
  } catch (cause) {
    showError(cause);
  }
}

/** 导出落盘的共用收尾（transcript 与 GIF 同款，自两条导出链去重）：sidecar
 * 在本机时落到下载目录（或「每次询问」选择的目录），冲突走既有协商流，完成
 * 后提示完整路径并带打开/定位动作；web/docker（sidecar 不在本机）走宿主
 * host.saveFile——iframe 内 <a download> 被浏览器静默丢弃（issue #93）。 */
async function saveRecordingFileLocally(bytes: Uint8Array, fileName: string) {
  const local = await probeLocalCapabilities();
  if (!local?.canSaveLocal) {
    await saveHostFile([bytes], fileName);
    showNotice(t("replayExported"));
    return;
  }
  let targetDir = "";
  let setDefaultAfter = false;
  if (!loadDownloadUseDefaultDir()) {
    const chosen = await askDownloadTarget(fileName);
    if (chosen === undefined) return;
    targetDir = chosen.dir.trim();
    setDefaultAfter = chosen.setDefault;
  }
  const conflict = await resolveDownloadConflictFor(targetDir, fileName);
  if (conflict === undefined) return;
  const saved = await window.dbxPlugin.invoke<{ localPath: string; name: string }>("local/saveFile", {
    name: fileName,
    dataBase64: window.dbxPlugin.encodeBase64(bytes),
    targetDir: targetDir || loadDownloadDir() || undefined,
    conflict: conflict === "overwrite" ? "overwrite" : undefined,
  });
  const savedPath = saved.localPath;
  showNotice(t("downloadedTo", { name: saved.name, path: savedPath }), [
    { label: t("openDownloadedFile"), run: () => void openTransferTarget(savedPath) },
    { label: t("revealInFolder"), run: () => void revealTransferTarget(savedPath) },
  ]);
  if (setDefaultAfter) applyChosenDirAsDefault(targetDir);
}

// —— M14 录制增强：transcript 导出 ———
// 回放链已把事件分页拉到前端，transcript 在前端拼装（lib/transcript 纯函数）
// 并走既有保存桥（宿主 fileTransfer → sidecar local/saveFile → 浏览器下载），
// 不新增协议面。
async function exportRecordingTranscript(item: RecordingSummary) {
  if (recordingExportingId.value) return;
  recordingExportingId.value = item.recordingId;
  try {
    const events = await loadReplayEvents(item.recordingId);
    const text = buildTranscript(events);
    if (!text) throw new Error(t("replayExportFailed"));
    const bytes = new TextEncoder().encode(text);
    const fileName = transcriptFileName(item.recordingId);
    const fileTransfer = window.dbxPlugin.fileTransfer;
    if (fileTransfer) {
      // 宿主原生保存对话框：用户自选目的地。
      const target = await fileTransfer.beginSave({ name: fileName, contentType: "text/plain", size: bytes.byteLength });
      try {
        // issue #116：同 SFTP/trzsz/GIF 落盘——transfer 列表只收 ArrayBuffer，
        // 交独立 buffer（transcript 导出是 integration 线独有入口，与三处同源）。
        await fileTransfer.write(target.handleId, 0, standaloneArrayBuffer(bytes));
        await fileTransfer.finish(target.handleId);
      } catch (cause) {
        await fileTransfer.cancel(target.handleId).catch(() => undefined);
        throw cause;
      }
      showNotice(t("replayExported"));
      return;
    }
    // sidecar 落盘/宿主兜底的共用收尾（saveRecordingFileLocally）。
    await saveRecordingFileLocally(bytes, fileName);
  } catch (cause) {
    showError(cause);
  } finally {
    recordingExportingId.value = null;
  }
}

// —— M14 录制增强：列表搜索（名称过滤 + 内容全文命中摘录）———
// 内容搜索走 ssh/recording/search 即时扫描（无持久索引），只回命中摘录，
// 前端不在搜索路径上拉全量事件。
const recordingsQuery = ref("");
const recordingHits = ref<Record<string, string[]>>({});
const recordingSearchBusy = ref(false);
let recordingSearchTimer = 0;

const filteredRecordings = computed(() => {
  const query = recordingsQuery.value.trim().toLowerCase();
  if (!query) return recordings.value;
  return recordings.value.filter((item) => {
    if ((item.host || "").toLowerCase().includes(query)) return true;
    if (item.recordingId.toLowerCase().includes(query)) return true;
    return (recordingHits.value[item.recordingId] ?? []).length > 0;
  });
});

const searchEpoch = createRequestEpoch();

async function runRecordingSearch() {
  const query = recordingsQuery.value.trim();
  if (!query) {
    recordingHits.value = {};
    recordingSearchBusy.value = false;
    return;
  }
  // 即时全文扫描无持久索引，慢查询可能晚于新查询返回：过期响应整体丢弃，
  // 不写 hits、不收 busy（收尾只属于最新请求）。
  const epoch = searchEpoch.next();
  recordingSearchBusy.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ recordings: Array<{ recordingId: string; hits?: Array<{ excerpt: string }> }> }>(
      "ssh/recording/search",
      { query },
    );
    if (!searchEpoch.isCurrent(epoch)) return;
    const hits: Record<string, string[]> = {};
    for (const row of result.recordings ?? []) {
      hits[row.recordingId] = (row.hits ?? []).map((hit) => hit.excerpt);
    }
    recordingHits.value = hits;
  } catch {
    if (!searchEpoch.isCurrent(epoch)) return;
    recordingHits.value = {};
  } finally {
    if (searchEpoch.isCurrent(epoch)) recordingSearchBusy.value = false;
  }
}

watch(recordingsQuery, () => {
  window.clearTimeout(recordingSearchTimer);
  recordingSearchTimer = window.setTimeout(() => void runRecordingSearch(), 250);
});

function clearRecordingsSearch() {
  recordingsQuery.value = "";
  recordingHits.value = {};
}

function deleteRecording(item: RecordingSummary) {
  recordingDeleteTarget.value = item;
}

async function confirmRecordingDelete() {
  const item = recordingDeleteTarget.value;
  if (!item || recordingDeleteSubmitting.value) return;
  recordingDeleteSubmitting.value = true;
  try {
    await window.dbxPlugin.invoke("ssh/recording/delete", { recordingId: item.recordingId });
    recordingDeleteTarget.value = null;
    await loadRecordings();
  } catch (cause) {
    showError(cause);
  } finally {
    recordingDeleteSubmitting.value = false;
  }
}

// 一键清空：应用内确认弹窗（沙箱 iframe confirm 恒 false），确认后
// ssh/recording/clear 全删 .cast，重载列表并提示删除数量。
const recordingClearAllOpen = ref(false);
const recordingClearAllSubmitting = ref(false);

async function confirmRecordingClearAll() {
  if (recordingClearAllSubmitting.value) return;
  recordingClearAllSubmitting.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ deleted?: number }>("ssh/recording/clear", {});
    recordingClearAllOpen.value = false;
    await loadRecordings();
    showNotice(t("recordingsCleared", { count: result.deleted ?? 0 }));
  } catch (cause) {
    showError(cause);
  } finally {
    recordingClearAllSubmitting.value = false;
  }
}

// 回放播放器（loadReplayEvents/openReplay/closeReplay/replayFrame/
// toggleReplayPlay/onReplaySeek/倍速锚定 watch/REPLAY_EVENT_CAP）下沉
// useReplayPlayer（文件头部接线）。

// GIF 导出管线：离屏 xterm 逐事件重放，按 500ms 事件时间抽帧（封顶 120 帧），
// 每帧从 xterm 画布取像素 → encodeGif。纯前端，无新依赖。回放弹窗与录制
// 列表行内按钮共用；调用方负责 replayExporting 状态与错误呈现。
async function exportRecordingGif(summary: RecordingSummary, events: readonly ReplayEvent[]) {
  const COLS = 80;
  const ROWS = 24;
  const FRAME_INTERVAL_MS = 500;
  const MAX_FRAMES = 120;
  const fileName = `${summary.recordingId || "session"}.gif`;
  // Open the native save picker before the first await so browsers that require
  // a user gesture keep the permission to choose both directory and filename.
  // DBX hosts without File System Access continue through fileTransfer below.
  let nativeSave: DbxGifSaveFileHandle | undefined;
  if (window.showSaveFilePicker) {
    try {
      nativeSave = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "GIF image", accept: { "image/gif": [".gif"] } }],
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      throw cause;
    }
  }
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;";
  document.body.appendChild(host);
  let term: Terminal | null = null;
  try {
    // 离屏终端与主终端同款外观（配色/字体/字重/行高）：导出的 GIF 必须和用户
    // 屏幕上看到的一致，否则「导出」就失去意义。
    const exportFont = resolveTerminalFont(terminalFontOverride.value, {
      fontFamily: hostFontFamily(),
      fontSize: appearance.value.terminal.fontSize,
    });
    const exportPatch = terminalOptionPatch(terminalAppearance.value.settings);
    term = new Terminal({
      cols: COLS,
      rows: ROWS,
      theme: terminalTheme(),
      fontFamily: exportFont.fontFamily,
      fontSize: exportFont.fontSize,
      fontWeight: exportPatch.fontWeight,
      fontWeightBold: exportPatch.fontWeightBold,
      lineHeight: exportPatch.lineHeight,
      letterSpacing: exportPatch.letterSpacing,
      drawBoldTextInBrightColors: exportPatch.drawBoldTextInBrightColors,
    });
    term.open(host);
    // xterm 6 移除了 canvas 渲染器：DOM 渲染器不产出 canvas，逐帧取像素必须
    // 挂 WebGL renderer。两个此前就存在的坑在此一并修掉：screenElement 下第
    // 一块 canvas 是链接下划线的 2d renderLayer（透明，querySelector 会抓错），
    // 真画布按「能取到 webgl2 上下文」选中（getContext 幂等无副作用）；
    // preserveDrawingBuffer 是 WebglAddon 的构造参数（0.20 beta 起改为 options
    // 对象；默认 false，关闭时合成后回读全零像素），导出终端显式开启——主终端
    // 不取像素，维持默认。GPU 被
    // 禁/context 耗尽挂不上 renderer（DOM 渲染无 canvas）时，走 !screen 分支
    // 给出 replayExportFailed 明确错误，而不是永远空帧。
    attachWebglRenderer(term, () => new WebglAddon({ preserveDrawingBuffer: true }));
    const screen =
      (Array.from(host.querySelectorAll("canvas")) as HTMLCanvasElement[])
        .find((c) => c.getContext("webgl2")) ?? null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!screen || !context) throw new Error(t("replayExportFailed"));
    canvas.width = screen.width;
    canvas.height = screen.height;
    const timeline = buildTimeline(events, 1);
    const plan = gifFramePlan(timeline, FRAME_INTERVAL_MS, MAX_FRAMES);
    const frames: Array<{ rgba: Uint8Array; delayMs: number }> = [];
    let written = 0;
    for (const boundary of plan) {
      while (written < boundary) {
        term.write(events[written]!.data);
        written += 1;
      }
      // 等两帧渲染再取像素：正常窗口双 rAF 精确等待；标签页被隐藏等场景
      // rAF 永不回调，用 250ms 定时兜底，导出流程永不悬挂在 Encoding…。
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        requestAnimationFrame(() => requestAnimationFrame(settle));
        window.setTimeout(settle, 250);
      });
      context.drawImage(screen, 0, 0);
      frames.push({ rgba: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data), delayMs: FRAME_INTERVAL_MS });
    }
    term.dispose();
    term = null;
    const gif = encodeGif(canvas.width, canvas.height, frames);
    if (nativeSave) {
      const writable = await nativeSave.createWritable();
      await writable.write(gif);
      await writable.close();
    } else if (window.dbxPlugin.fileTransfer) {
      // DBX hosts own the native save dialog here, so the user can choose the
      // destination instead of silently losing the file in an unknown folder.
      const fileTransfer = window.dbxPlugin.fileTransfer;
      const target = await fileTransfer.beginSave({ name: fileName, contentType: "image/gif", size: gif.byteLength });
      if (!target) return; // 用户在原生保存框取消：安静结束，不提示导出成功
      try {
        // issue #116：同 SFTP/trzsz 落盘——transfer 列表只收 ArrayBuffer。
        await fileTransfer.write(target.handleId, 0, standaloneArrayBuffer(gif));
        await fileTransfer.finish(target.handleId);
      } catch (cause) {
        await fileTransfer.cancel(target.handleId).catch(() => undefined);
        throw cause;
      }
      showNotice(t("replayExported"));
    } else {
      // sidecar 落盘/宿主兜底的共用收尾（saveRecordingFileLocally）。
      await saveRecordingFileLocally(gif, fileName);
      return;
    }
    showNotice(t("replayExported"));
  } finally {
    term?.dispose();
    host.remove();
  }
}

async function exportReplayGif() {
  const state = replayState.value;
  if (!state || replayExporting.value || !state.events.length) return;
  replayExporting.value = true;
  try {
    await exportRecordingGif(state.summary, state.events);
  } catch (cause) {
    showError(cause);
  } finally {
    replayExporting.value = false;
  }
}

// 列表行内导出：按需拉取事件（回放窗不必先打开），再走同一导出管线。
async function exportRecordingFromList(item: RecordingSummary) {
  if (replayExporting.value) return;
  replayExporting.value = true;
  recordingExportingId.value = item.recordingId;
  try {
    const events = await loadReplayEvents(item.recordingId);
    if (!events.length) throw new Error(t("replayExportFailed"));
    await exportRecordingGif(item, events);
  } catch (cause) {
    showError(cause);
  } finally {
    recordingExportingId.value = null;
    replayExporting.value = false;
  }
}

// formatDuration/formatRecordedAt 下沉 lib/recordingFormat（import 复用）。

onBeforeUnmount(() => {
  // 回放 rAF/终端的清理在 useReplayPlayer 卸载钩子里。
  window.clearInterval(recordCountdownTimer);
  window.clearInterval(recordingElapsedTimer);
  // 搜索防抖：卸载后不再发起 invoke。
  window.clearTimeout(recordingSearchTimer);
});

  return {
    recordingActive,
    recordingsOpen,
    recordings,
    recordingsLoading,
    recordingDeleteTarget,
    recordingDeleteSubmitting,
    recordingExportingId,
    replayState,
    replayPlaying,
    replaySpeed,
    replayPlayheadMs,
    replayExporting,
    replayHost,
    recordCountdown,
    recordingStartedAt,
    recordingElapsedSec,
    beginRecordCountdown,
    cancelRecordCountdown,
    startRecordingClock,
    stopRecordingClock,
    startRecordingNow,
    toggleRecording,
    loadRecordings,
    toggleRecordings,
    revealRecording,
    exportRecordingTranscript,
    recordingsQuery,
    recordingHits,
    recordingSearchBusy,
    filteredRecordings,
    runRecordingSearch,
    clearRecordingsSearch,
    deleteRecording,
    confirmRecordingDelete,
    recordingClearAllOpen,
    recordingClearAllSubmitting,
    confirmRecordingClearAll,
    REPLAY_EVENT_CAP,
    replayDurationMs,
    loadReplayEvents,
    openReplay,
    closeReplay,
    stopReplayLoop,
    replayFrame,
    toggleReplayPlay,
    onReplaySeek,
    exportRecordingGif,
    exportReplayGif,
    exportRecordingFromList,
    formatDuration,
    formatRecordedAt,
  };
}
