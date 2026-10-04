import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import { pluginStore } from "../lib/pluginStore";
import { randomUUID } from "../lib/uuid";
import { browseCommandHistory } from "../lib/commandHistory";
import {
  applyConnectionNames,
  batchTargetLabel,
  deriveBatchCommandName,
  normalizeBatchTargets,
  normalizeLocalBatchTargets,
  quickPickCommandById,
  selectBatchTargets,
  summarizeBatchResults,
  toggleBatchTarget,
  type BatchSendSummary,
  type BatchSendTarget,
} from "../lib/batchSend";
import { persistQuickCommands, QUICK_COMMANDS_LIMIT, type QuickCommand } from "../lib/quickCommands";

/** 批量发送命令条（Electerm quick-command bar 风格）：常驻贴在终端底部，回车
 * 即发送。目标来自 ssh/sessions/list（跨连接全部活跃会话），命令写入各会话
 * 交互终端（PTY 键盘语义，输出回显在各自终端，对齐 tiny-rdm batch send）。
 * 跨工作台状态广播与内联保存为快速命令也在此收口。 */
export function useBatchSend(options: {
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  connected: ComputedRef<boolean>;
  session: Ref<{ sessionId?: string } | undefined>;
  localSession: Ref<{ sessionId: string } | null>;
  quickCommands: Ref<QuickCommand[]>;
  commandHistory: Ref<string[]>;
  panelSurface: ComputedRef<boolean>;
  sftpPaneOpen: Ref<boolean>;
  transferPanelOpen: Ref<boolean>;
  persistCommandHistory: () => void;
  /** 统一采集口（Warp 式 history 面板）：命令环 + 执行时间映射一并推进。 */
  pushTerminalCommandHistory: (command: string) => void;
  confirmRiskyPaste: (text: string) => Promise<boolean>;
  terminalInputQueue: { enqueue: (sessionId: string, data: Uint8Array) => void };
}) {
  const { showError, connected, session, localSession, quickCommands, commandHistory, panelSurface, sftpPaneOpen, transferPanelOpen, persistCommandHistory, pushTerminalCommandHistory, confirmRiskyPaste, terminalInputQueue } = options;

// 即发送。目标来自 ssh/sessions/list（跨连接全部活跃会话），命令写入各会话
// 交互终端（PTY 键盘语义，输出回显在各自终端，对齐 tiny-rdm batch send）。
const BATCH_BAR_OPEN_KEY = "ssh-batch-bar-open";

function loadBatchBarOpen(): boolean {
  try {
    return pluginStore.getItem(BATCH_BAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

// Dock panel surface keeps the bar closed unconditionally: the panel is a single
// focused terminal, and the sandbox has no localStorage so the persisted
// default (open) would otherwise win.
const batchBarOpen = ref(panelSurface.value ? false : loadBatchBarOpen());
const batchTargetsOpen = ref(false);
const batchLoading = ref(false);
const batchSending = ref(false);
const batchTargets = ref<BatchSendTarget[]>([]);
const batchSelected = ref<string[]>([]);
const batchDraft = ref("");
const batchError = ref("");
const batchSummary = ref<BatchSendSummary>();
const batchQuickPickId = ref("");
// hostContext 由 initialize() 异步填充，panelSurface 在 setup 时还是 false——
// 初始门控永远打不中（这就是"批量命令条关不掉"的根因）。改为响应式强制：
// panel 成立即收批量条、关 SFTP 窗格（无窗格即无目录列表/SFTP 流量）。
watch(panelSurface, (panel) => {
  if (!panel) return;
  batchBarOpen.value = false;
  sftpPaneOpen.value = false;
  transferPanelOpen.value = false;
}, { immediate: true });
// 保存为快速命令的内联名称态（保存走 ssh/quickCommands/save，全局共享）。
const batchSaveMode = ref(false);
const batchSaveName = ref("");
const batchSaving = ref(false);
// 命令条 ↑↓ 浏览历史（与命令弹窗共用 commandHistory 一份存储）。
const batchHistoryIndex = ref(-1);
const batchHistoryBackup = ref("");
// 跨工作台同步源标识：sidecar 把本端状态广播给所有 webview，各端按 source
// 过滤回声；sidecar 缺该方法（旧版二进制）时静默降级，只影响同步。
const batchBarSourceId = randomUUID();
let batchBroadcastTimer: number | undefined;

/** 命令条开关：持久化（pluginStore），打开时顺带刷新目标列表。 */
function toggleBatchBar() {
  batchBarOpen.value = !batchBarOpen.value;
  try {
    pluginStore.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
  } catch {
    // 存储不可用时仅失去记忆，功能不受影响。
  }
  if (batchBarOpen.value) {
    void refreshBatchTargets();
  } else {
    batchTargetsOpen.value = false;
    batchSaveMode.value = false;
  }
  broadcastBatchBarState(true);
}

/** 本地命令条状态广播（输入去抖 150ms，开关/清空等离散动作立即发）。 */
function broadcastBatchBarState(immediate = false) {
  if (batchBroadcastTimer !== undefined) window.clearTimeout(batchBroadcastTimer);
  const send = () => {
    batchBroadcastTimer = undefined;
    void window.dbxPlugin
      .notify("ssh/batchBar/state", {
        source: batchBarSourceId,
        draft: batchDraft.value,
        quickPickId: batchQuickPickId.value,
        open: batchBarOpen.value,
      })
      .catch(() => undefined);
  };
  if (immediate) {
    send();
  } else {
    batchBroadcastTimer = window.setTimeout(send, 150);
  }
}

/** 应用其他工作台广播来的命令条状态（不含保存态/弹出层，不打断本端输入焦点）。 */
function applyRemoteBatchBarState(params: { draft?: unknown; quickPickId?: unknown; open?: unknown }) {
  if (typeof params.draft === "string") batchDraft.value = params.draft;
  if (typeof params.quickPickId === "string") batchQuickPickId.value = params.quickPickId;
  batchHistoryIndex.value = -1;
  if (typeof params.open === "boolean" && params.open !== batchBarOpen.value) {
    batchBarOpen.value = params.open;
    try {
      pluginStore.setItem(BATCH_BAR_OPEN_KEY, batchBarOpen.value ? "1" : "0");
    } catch {
      // 同 toggleBatchBar：存储不可用只失去记忆。
    }
    if (params.open && !batchTargets.value.length) void refreshBatchTargets();
  }
}

// 刷新 stale-guard：连续两次刷新（快速开合下拉/连接事件）时旧响应可能后到
// 覆盖新列表。epoch 递增，过期响应直接丢弃；下次刷新自愈。
let batchTargetsEpoch = 0;

async function refreshBatchTargets() {
  const epoch = ++batchTargetsEpoch;
  batchLoading.value = true;
  batchError.value = "";
  try {
    const response = await window.dbxPlugin.invoke<{ sessions: unknown }>("ssh/sessions/list");
    // 批量目标包含本地终端：同是"向 PTY 键盘写入"，发送阶段按通道分流。
    let targets = normalizeBatchTargets(response.sessions);
    try {
      const local = await window.dbxPlugin.invoke<{ sessions?: unknown }>("local/session/list", {}, { timeoutMs: 5000 });
      targets = [...targets, ...normalizeLocalBatchTargets(local?.sessions)];
    } catch {
      // 旧 sidecar 无本地会话能力：只保留 SSH 目标。
    }
    // 连接名覆盖（issue #10232）：host.listConnections 是宿主连接表的实时读数，
    // 终端（连接）改名后无需重连，下一次目标刷新即生效；旧宿主缺该扩展点时
    // 静默跳过，行标签回退 user@host。
    try {
      targets = applyConnectionNames(targets, await window.dbxPlugin.request<unknown>("host.listConnections"));
    } catch {
      // 旧宿主无 listConnections：保持 user@host 标签。
    }
    if (epoch !== batchTargetsEpoch) return;
    batchTargets.value = targets;
    // 剔除已关闭会话；选择为空时默认只预选当前会话（本地面板预选本地会话；
    // 批量写入影响所有被选主机，宁缺毋滥）。
    const known = new Set(batchTargets.value.map((target) => target.sessionId));
    batchSelected.value = batchSelected.value.filter((id) => known.has(id));
    const currentSessionId = session.value?.sessionId ?? localSession.value?.sessionId;
    if (!batchSelected.value.length) {
      batchSelected.value = currentSessionId && known.has(currentSessionId) ? [currentSessionId] : [];
    }
  } catch (cause) {
    if (epoch !== batchTargetsEpoch) return;
    batchTargets.value = [];
    batchSelected.value = [];
    batchError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (epoch === batchTargetsEpoch) batchLoading.value = false;
  }
}

function toggleBatchTargetsPopover() {
  batchTargetsOpen.value = !batchTargetsOpen.value;
  if (batchTargetsOpen.value) void refreshBatchTargets();
}

function toggleBatchTargetId(sessionId: string) {
  batchSelected.value = toggleBatchTarget(batchSelected.value, sessionId);
}

function pickBatchTargets(mode: "all" | "connected") {
  batchSelected.value = selectBatchTargets(batchTargets.value, mode);
}

// 下拉切换命令：回填输入框（Electerm 语义），发送仍由回车/发送按钮触发。
function onBatchQuickPick(value: unknown) {
  batchQuickPickId.value = value == null ? "" : String(value);
  applyBatchQuickPick();
}

function applyBatchQuickPick() {
  const command = quickPickCommandById(quickCommands.value, batchQuickPickId.value);
  if (command) {
    batchDraft.value = command;
    batchHistoryIndex.value = -1;
    broadcastBatchBarState(true);
  }
}

// 命令条 ↑↓ 浏览历史（与命令弹窗同一份 commandHistory，弹窗/命令条互相可见）。
function browseBatchHistoryUp() {
  batchHistoryBackup.value = batchHistoryIndex.value === -1 ? batchDraft.value : batchHistoryBackup.value;
  const step = browseCommandHistory(commandHistory.value, batchHistoryIndex.value, "up", batchHistoryBackup.value);
  batchHistoryIndex.value = step.index;
  batchDraft.value = step.draft;
}

function browseBatchHistoryDown() {
  const step = browseCommandHistory(commandHistory.value, batchHistoryIndex.value, "down", batchHistoryBackup.value);
  batchHistoryIndex.value = step.index;
  batchDraft.value = step.draft;
}

function batchSessionLabel(sessionId: string): string {
  const target = batchTargets.value.find((item) => item.sessionId === sessionId);
  return target ? batchTargetLabel(target) : sessionId.slice(0, 8);
}

async function sendBatchCommand() {
  const command = batchDraft.value.trim();
  if (!command || !batchSelected.value.length || batchSending.value) return;
  // 危险/超长命令复用粘贴红色确认弹窗（同一套 dangerousCommands 规则）。
  const confirmed = await confirmRiskyPaste(command);
  if (!confirmed) return;
  batchSending.value = true;
  batchError.value = "";
  batchSummary.value = undefined;
  try {
    // 目标按通道分流：SSH 走 sidecar 批量写入；本地终端复用输入队列（同一
    // 序号框架，保持与键入一致的顺序语义），命令补 \r 回车与键入等价。
    const selectedSet = new Set(batchSelected.value);
    const sshIds = batchTargets.value.filter((target) => !target.local && selectedSet.has(target.sessionId)).map((target) => target.sessionId);
    const localIds = batchTargets.value.filter((target) => target.local && selectedSet.has(target.sessionId)).map((target) => target.sessionId);
    const results: unknown[] = [];
    if (sshIds.length) {
      const response = await window.dbxPlugin.invoke<{ results: unknown }>("ssh/terminal/batchInput", { sessionIds: sshIds, command });
      if (Array.isArray(response.results)) results.push(...response.results);
    }
    let localAlive: Set<string> | undefined;
    if (localIds.length) {
      // 发送前复核本地会话存活（刷新到发送之间会话可能已关闭）：enqueue 是
      // 同步且不抛错的（异步失败走全局 onError，无法归因到本行），不复核会把
      // 已关闭会话恒报成功。探测失败按全部存活处理（旧 sidecar 无该能力）。
      try {
        const local = await window.dbxPlugin.invoke<{ sessions?: unknown }>("local/session/list", {}, { timeoutMs: 5000 });
        localAlive = new Set(normalizeLocalBatchTargets(local?.sessions).map((target) => target.sessionId));
      } catch {
        localAlive = undefined;
      }
    }
    for (const sessionId of localIds) {
      if (localAlive && !localAlive.has(sessionId)) {
        results.push({ sessionId, success: false, error: "Local session has closed" });
        continue;
      }
      // enqueue 即本地 PTY 的受理边界（与 SSH 路径的桥受理语义一致）；
      // 异步发送失败由输入队列的全局 onError 上报。
      terminalInputQueue.enqueue(sessionId, new TextEncoder().encode(`${command}\r`));
      results.push({ sessionId, success: true });
    }
    batchSummary.value = summarizeBatchResults(results);
    if (batchSummary.value.sent) {
      // 发送成功即清空输入与下拉选中（对齐原弹窗语义），命令入历史供 ↑↓ 回选。
      pushTerminalCommandHistory(command);
      batchDraft.value = "";
      batchQuickPickId.value = "";
      batchHistoryIndex.value = -1;
      batchHistoryBackup.value = "";
      broadcastBatchBarState(true);
    }
  } catch (cause) {
    batchError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    batchSending.value = false;
  }
}

function dismissBatchResult() {
  batchSummary.value = undefined;
  batchError.value = "";
}

// ---- 命令条内联保存为快速命令（存储迁移批 1：本地 upsert 落 pluginStore，
// 与工具栏 Zap 弹层同源，全局共享）----

function openBatchBarSave() {
  const command = batchDraft.value.trim();
  if (!command || quickCommands.value.length >= QUICK_COMMANDS_LIMIT) return;
  batchSaveMode.value = true;
  batchSaveName.value = deriveBatchCommandName(command);
}

async function confirmBatchBarSave() {
  const command = batchDraft.value.trim();
  if (!command || batchSaving.value || quickCommands.value.length >= QUICK_COMMANDS_LIMIT) return;
  batchSaving.value = true;
  try {
    const entry: QuickCommand = { id: randomUUID(), name: batchSaveName.value.trim(), command };
    // 名称兜底/截断由 persist 内的 normalize 收紧；上限已由入口守卫拦截。
    quickCommands.value = persistQuickCommands([...quickCommands.value, entry]);
    batchSaveMode.value = false;
    batchSaveName.value = "";
    batchQuickPickId.value = quickCommands.value.find((item) => item.command === command)?.id ?? "";
  } finally {
    batchSaving.value = false;
  }
}

function cancelBatchBarSave() {
  batchSaveMode.value = false;
  batchSaveName.value = "";
}


// 连接建立后刷新目标计数；断开时收起命令条的弹出层/保存态。
watch(connected, (value) => {
  if (value && batchBarOpen.value) {
    void refreshBatchTargets();
  } else if (!value) {
    batchTargetsOpen.value = false;
    batchSaveMode.value = false;
  }
});

onBeforeUnmount(() => {
  if (batchBroadcastTimer !== undefined) window.clearTimeout(batchBroadcastTimer);
});

  return {
    batchBarOpen,
    batchTargetsOpen,
    batchLoading,
    batchSending,
    batchTargets,
    batchSelected,
    batchDraft,
    batchError,
    batchSummary,
    batchQuickPickId,
    batchSaveMode,
    batchSaveName,
    batchSaving,
    batchHistoryIndex,
    batchHistoryBackup,
    batchBarSourceId,
    toggleBatchBar,
    broadcastBatchBarState,
    applyRemoteBatchBarState,
    refreshBatchTargets,
    toggleBatchTargetsPopover,
    toggleBatchTargetId,
    pickBatchTargets,
    onBatchQuickPick,
    applyBatchQuickPick,
    browseBatchHistoryUp,
    browseBatchHistoryDown,
    batchSessionLabel,
    sendBatchCommand,
    dismissBatchResult,
    openBatchBarSave,
    confirmBatchBarSave,
    cancelBatchBarSave,
  };
}
