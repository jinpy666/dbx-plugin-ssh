/**
 * Split panes（分屏副终端）：在同一个工作台 tab 内并排显示多个终端会话，
 * 对标 SecureCRT 的 tiled sessions。
 *
 * 设计契约（与后端协议对齐，见 docs/PROTOCOL.zh-CN.md）：
 * - 后端一切按 sessionId 寻址（ssh/terminal/out|in/{id}、resize、replay、
 *   close），副屏只是"同一 webview 内的第二个/第三个会话视图"，不需要任何
 *   后端改动。
 * - 副屏会话用复制会话同款链路打开：`ssh/session/open` + 当前连接的
 *   `reuseAuthenticatedTransport`（复用已认证 transport，免二次认证）。
 * - 镜像副屏（跨连接）：从 `ssh/sessions/list` 选任意存活会话挂载——sidecar
 *   的二进制帧按 channel 广播到插件的全部 webview，前端按 sessionId 路由
 *   （本文件 acceptFrame 即路由终点）；输入经 `ssh/terminal/in/{id}` 直接
 *   驱动远端 PTY。镜像会话的所有权仍在原工作台：原 tab 关闭时会话随之关闭，
 *   副屏只呈现断开态，绝不代替原 tab 执行 close。
 * - 控制帧（stream===2）携带会话状态文本（ssh-session-exited 等），副屏按
 *   同语义落到断开态。
 */
import { ref, type Ref } from "vue";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { randomUUID } from "../lib/uuid";
import { normalizeTerminalInputBytes } from "../lib/terminalInput";

export const SPLIT_PANE_MAX = 3;

export interface SplitPaneRecord {
  id: string;
  sessionId: string;
  connectionId: string;
  /** 会话归属的工作台 id（镜像会话=原工作台；本工作台开的=本工作台）。 */
  ownerWorkbenchId: string;
  title: string;
  subtitle: string;
  /** true = 挂载的其他工作台/其他连接的存活会话，关闭副屏不关会话。 */
  mirrored: boolean;
  state: "connecting" | "connected" | "closed";
  error: string;
}

export interface SplitPaneFrame {
  stream: number;
  data: Uint8Array;
}

export interface SplitPaneSessionSummary {
  sessionId: string;
  connectionId?: string;
  workbenchId?: string;
  connected?: boolean;
  readOnly?: boolean;
  host?: string;
  port?: number;
  username?: string;
  createdAt?: number;
}

export interface SplitPaneRuntime {
  terminal?: Terminal;
  fit?: FitAddon;
  lastSequence: number;
  pending: Map<number, SplitPaneFrame>;
  replayInFlight: boolean;
}

export interface UseSplitPanesDeps {
  t: (key: string, values?: Record<string, string | number>) => string;
  notify: (message: string) => void;
  showError: (cause: unknown, scope: string) => void;
  connectionId: () => string | undefined;
  workbenchId: () => string | undefined;
  mainSessionId: () => string | undefined;
  connected: () => boolean;
  isSshMode: () => boolean;
  /** App 侧合成外观（字体/主题/行为项与主终端一致）创建副屏 xterm。 */
  createPaneTerminal: () => { terminal: Terminal; fit: FitAddon };
  spawnDimensions: () => { cols: number; rows: number };
  enqueueInput: (sessionId: string, data: Uint8Array) => void;
  invoke: <T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<T>;
}

interface SplitPaneInternal {
  record: SplitPaneRecord;
  runtime: SplitPaneRuntime;
}

const CONTROL_STREAM = 2;
const PENDING_FRAME_LIMIT = 512;

function controlText(state: string): string {
  if (state === "ssh-transport-disconnected") return "transport";
  if (state === "ssh-session-exited") return "exited";
  if (state === "ssh-session-killed") return "killed";
  return state || "exited";
}

const SPLIT_WIDTH_KEY = "ssh-split-pane-width";
const SPLIT_WIDTH_DEFAULT = 360;
const SPLIT_HEIGHT_KEY = "ssh-split-pane-height";
const SPLIT_HEIGHT_DEFAULT = 320;
const SPLIT_DIRECTION_KEY = "ssh-split-pane-dir";

/**
 * 副屏列宽的首读必须自带兜底：工作台 iframe 是 `sandbox="allow-scripts"`
 * （opaque origin），`localStorage` 一访问就抛 SecurityError（同 App.vue 下载
 * 偏好处的注释）。本函数在 setup 顶层执行，裸读会让整个工作台挂载中断 →
 * 空白面板且无任何 JS 报错，而本地 dev/mock（localhost 有正常 origin）完全
 * 复现不到。读取失败按默认宽度继续，功能不受影响。
 */
function readStoredSplitWidth(): number {
  try {
    const raw = window.localStorage?.getItem(SPLIT_WIDTH_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* 沙箱禁止 localStorage：用默认宽度 */
  }
  return SPLIT_WIDTH_DEFAULT;
}

function readStoredSplitHeight(): number {
  try {
    const raw = window.localStorage?.getItem(SPLIT_HEIGHT_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    /* 沙箱禁止 localStorage：用默认高度 */
  }
  return SPLIT_HEIGHT_DEFAULT;
}

function readStoredSplitDirection(): "column" | "row" {
  try {
    return window.localStorage?.getItem(SPLIT_DIRECTION_KEY) === "row" ? "row" : "column";
  } catch {
    /* 沙箱禁止 localStorage：默认右列布局 */
  }
  return "column";
}

export function useSplitPanes(deps: UseSplitPanesDeps) {
  const panes = ref<SplitPaneRecord[]>([]) as Ref<SplitPaneRecord[]>;
  const splitOpen = ref(false);
  const pickOpen = ref(false);
  const pickLoading = ref(false);
  const pickRows = ref<SplitPaneSessionSummary[]>([]);
  const splitWidth = ref<number>(readStoredSplitWidth());
  // 布局方向：column=右侧副屏列（纵向堆叠）；row=底部副屏区（横向并排，主终端
  // 在上、副屏全宽在下，对标 CRT 的上下 tiled）。方向与两个轴向的尺寸独立记忆。
  const splitDirection = ref<"column" | "row">(readStoredSplitDirection());
  const splitHeight = ref<number>(readStoredSplitHeight());
  const internals = new Map<string, SplitPaneInternal>();

  function runtimeFor(paneId: string): SplitPaneRuntime | undefined {
    return internals.get(paneId)?.runtime;
  }

  function recordForSession(sessionId: string): SplitPaneRecord | undefined {
    return panes.value.find((pane) => pane.sessionId === sessionId);
  }

  function setWidth(width: number): void {
    const clamped = Math.min(Math.max(Math.round(width), 220), 1200);
    splitWidth.value = clamped;
    try {
      window.localStorage?.setItem(SPLIT_WIDTH_KEY, String(clamped));
    } catch {
      /* 持久化失败（沙箱禁 localStorage）不影响功能 */
    }
  }

  /** row 模式的副屏区高度（分隔条纵向拖拽；下限保证窗格标题栏 + 可用终端行）。 */
  function setHeight(height: number): void {
    const clamped = Math.min(Math.max(Math.round(height), 140), 900);
    splitHeight.value = clamped;
    try {
      window.localStorage?.setItem(SPLIT_HEIGHT_KEY, String(clamped));
    } catch {
      /* 持久化失败（沙箱禁 localStorage）不影响功能 */
    }
  }

  /** column（右列纵排）↔ row（底部横排）切换；方向记忆落盘，失败不影响切换。 */
  function toggleDirection(): void {
    splitDirection.value = splitDirection.value === "column" ? "row" : "column";
    try {
      window.localStorage?.setItem(SPLIT_DIRECTION_KEY, splitDirection.value);
    } catch {
      /* 持久化失败（沙箱禁 localStorage）不影响功能 */
    }
  }

  function toggleSplit(): void {
    if (!splitOpen.value) {
      splitOpen.value = true;
      if (!panes.value.length) void addPane();
      return;
    }
    // 关闭分屏栏：只收起视图，副屏会话保留（backend 会话仍活），再次展开即可回附。
    splitOpen.value = false;
  }

  function togglePane(): void {
    if (!splitOpen.value) {
      splitOpen.value = true;
      if (!panes.value.length) void addPane();
      return;
    }
    if (panes.value.length >= SPLIT_PANE_MAX) {
      deps.notify(deps.t("splitPaneMaxPanes", { max: SPLIT_PANE_MAX }));
      return;
    }
    void addPane();
  }

  /** 同连接新 shell：复制会话链路（复用主会话已认证的 transport）。 */
  async function addPane(): Promise<void> {
    if (panes.value.length >= SPLIT_PANE_MAX) {
      deps.notify(deps.t("splitPaneMaxPanes", { max: SPLIT_PANE_MAX }));
      return;
    }
    const connectionId = deps.connectionId();
    const workbenchId = deps.workbenchId();
    const mainSessionId = deps.mainSessionId();
    if (!connectionId || !workbenchId) return;
    if (!deps.isSshMode()) {
      deps.notify(deps.t("splitPaneSshOnly"));
      return;
    }
    const sessionId = randomUUID();
    const paneId = randomUUID();
    const record: SplitPaneRecord = {
      id: paneId,
      sessionId,
      connectionId,
      ownerWorkbenchId: workbenchId,
      title: deps.t("splitPanePaneTitle", { n: panes.value.length + 2 }),
      subtitle: "",
      mirrored: false,
      state: "connecting",
      error: "",
    };
    internals.set(paneId, { record, runtime: { lastSequence: 0, pending: new Map(), replayInFlight: false } });
    panes.value = [...panes.value, record];
    try {
      const info = await deps.invoke<{ sessionId?: string }>("ssh/session/open", {
        connectionId,
        workbenchId,
        requestedSessionId: sessionId,
        // 复制会话同款：复用主会话已认证 transport，免二次认证/免堡垒机口令。
        // 主会话不在线时后端按原语义报错，副屏落断开态，不静默降级重拨。
        reuseAuthenticatedTransport: Boolean(mainSessionId),
        reuseAuthenticatedSessionId: mainSessionId,
        ...deps.spawnDimensions(),
      }, { timeoutMs: 120_000 });
      const actual = info?.sessionId && typeof info.sessionId === "string" ? info.sessionId : sessionId;
      const internal = internals.get(paneId);
      if (internal && actual !== sessionId) {
        // 后端改写了会话 id（requestedSessionId 被占用等）：以返回值为准。
        internal.record.sessionId = actual;
        const index = panes.value.findIndex((entry) => entry.id === paneId);
        if (index >= 0) panes.value[index] = { ...panes.value[index], sessionId: actual };
      }
      const target = internals.get(paneId);
      if (target) target.record.state = "connected";
      const index = panes.value.findIndex((entry) => entry.id === paneId);
      if (index >= 0) panes.value[index] = { ...panes.value[index], state: "connected" };
      splitOpen.value = true;
    } catch (cause) {
      markPaneClosed(paneId, cause instanceof Error ? cause.message : String(cause));
      deps.showError(cause, "terminal");
    }
  }

  /** 镜像副屏：挂载任意存活会话（含其他连接/其他 tab）。 */
  async function openPicker(): Promise<void> {
    pickOpen.value = true;
    pickLoading.value = true;
    pickRows.value = [];
    try {
      const result = await deps.invoke<{ sessions?: SplitPaneSessionSummary[] }>("ssh/sessions/list", {}, { timeoutMs: 10_000 });
      const ownWorkbenchId = deps.workbenchId();
      pickRows.value = (result?.sessions ?? []).filter(
        (session) =>
          session &&
          typeof session.sessionId === "string" &&
          session.connected !== false &&
          session.workbenchId !== ownWorkbenchId,
      );
    } catch (cause) {
      deps.showError(cause, "terminal");
    } finally {
      pickLoading.value = false;
    }
  }

  function closePicker(): void {
    pickOpen.value = false;
  }

  async function attachPane(summary: SplitPaneSessionSummary): Promise<void> {
    if (panes.value.length >= SPLIT_PANE_MAX) {
      deps.notify(deps.t("splitPaneMaxPanes", { max: SPLIT_PANE_MAX }));
      return;
    }
    const paneId = randomUUID();
    const host = typeof summary.host === "string" && summary.host ? summary.host : "";
    const user = typeof summary.username === "string" && summary.username ? summary.username : "";
    const endpoint = user && host ? `${user}@${host}` : host || summary.sessionId.slice(0, 8);
    const record: SplitPaneRecord = {
      id: paneId,
      sessionId: summary.sessionId,
      connectionId: summary.connectionId ?? "",
      ownerWorkbenchId: summary.workbenchId ?? "",
      title: deps.t("splitPaneMirrorTitle"),
      subtitle: endpoint,
      mirrored: true,
      state: "connecting",
      error: "",
    };
    internals.set(paneId, { record, runtime: { lastSequence: 0, pending: new Map(), replayInFlight: false } });
    panes.value = [...panes.value, record];
    pickOpen.value = false;
    splitOpen.value = true;
    try {
      // 历史回放：帧经 ssh/terminal/out/{id} 广播回来，acceptFrame 按序去重落屏。
      await deps.invoke("ssh/terminal/replay", { sessionId: summary.sessionId, afterSequence: 0 }, { timeoutMs: 30_000 });
      const target = internals.get(paneId);
      if (target && target.record.state === "connecting") {
        target.record.state = "connected";
        const index = panes.value.findIndex((entry) => entry.id === paneId);
        if (index >= 0) panes.value[index] = { ...panes.value[index], state: "connected" };
      }
    } catch (cause) {
      // 会话可能在挂载间隙退出：保持窗格并给出错误文本，不自动移除。
      markPaneClosed(paneId, cause instanceof Error ? cause.message : String(cause));
    }
  }

  function markPaneClosed(paneId: string, message: string): void {
    const internal = internals.get(paneId);
    if (!internal) return;
    internal.record.state = "closed";
    internal.record.error = message || deps.t("splitPaneDisconnected");
    const index = panes.value.findIndex((entry) => entry.id === paneId);
    if (index >= 0) panes.value[index] = { ...panes.value[index], state: "closed", error: internal.record.error };
  }

  /** handleBinary 路由终点：主会话之外的 ssh/terminal/out/{id} 帧进入这里。 */
  function acceptFrame(sessionId: string, payload: Uint8Array): void {
    const internal = [...internals.values()].find((entry) => entry.record.sessionId === sessionId);
    if (!internal) return;
    const { runtime } = internal;
    if (payload.length < 9) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const sequence = view.getBigUint64(1, false);
    const seqNumber = Number(sequence);
    if (seqNumber <= runtime.lastSequence) return;
    runtime.pending.set(seqNumber, { stream: payload[0], data: payload.slice(9) });
    drainPane(runtime);
  }

  function drainPane(runtime: SplitPaneRuntime): void {
    let frame = runtime.pending.get(runtime.lastSequence + 1);
    while (frame) {
      runtime.pending.delete(runtime.lastSequence + 1);
      runtime.lastSequence += 1;
      if (frame.stream === CONTROL_STREAM) {
        const state = new TextDecoder().decode(frame.data);
        if (state !== "directory-tracking-unavailable") {
          markPaneClosed(runtimePaneId(runtime), controlText(state));
        }
      } else {
        try {
          runtime.terminal?.write(frame.data);
        } catch {
          /* 终端已释放：丢帧即可 */
        }
      }
      frame = runtime.pending.get(runtime.lastSequence + 1);
    }
    if (runtime.pending.size > PENDING_FRAME_LIMIT) runtime.pending.clear();
  }

  function runtimePaneId(runtime: SplitPaneRuntime): string {
    for (const [id, entry] of internals) if (entry.runtime === runtime) return id;
    return "";
  }

  /** 组件挂载时创建副屏 xterm（外观由 App 侧工厂与主终端同源合成）。 */
  function mountPane(paneId: string, host: HTMLElement): void {
    const internal = internals.get(paneId);
    if (!internal || internal.runtime.terminal) return;
    const { terminal, fit } = deps.createPaneTerminal();
    internal.runtime.terminal = terminal;
    internal.runtime.fit = fit;
    terminal.onData((data) => {
      deps.enqueueInput(internal.record.sessionId, normalizeTerminalInputBytes(new TextEncoder().encode(data)));
    });
    terminal.open(host);
    try {
      fit.fit();
    } catch {
      /* 宿主切 tab 时 iframe 短暂脱离：静默跳过 */
    }
  }

  /** 组件卸载（窗格关闭/工作台拆除）时释放 xterm 实例；会话关闭由 closePane 负责。 */
  function unmountPane(paneId: string): void {
    const internal = internals.get(paneId);
    if (!internal) return;
    try {
      internal.runtime.terminal?.dispose();
    } catch {
      /* 已释放则忽略 */
    }
    internal.runtime.terminal = undefined;
    internal.runtime.fit = undefined;
  }

  function handlePaneInput(paneId: string, data: Uint8Array): void {
    const internal = internals.get(paneId);
    if (!internal || internal.record.state !== "connected") return;
    deps.enqueueInput(internal.record.sessionId, normalizeTerminalInputBytes(data));
  }

  function resizePane(paneId: string, cols: number, rows: number): void {
    const internal = internals.get(paneId);
    if (!internal || internal.record.state !== "connected") return;
    void deps.invoke("ssh/terminal/resize", { sessionId: internal.record.sessionId, cols, rows }).catch(() => undefined);
  }

  function closePane(paneId: string): void {
    const internal = internals.get(paneId);
    if (!internal) return;
    internals.delete(paneId);
    panes.value = panes.value.filter((entry) => entry.id !== paneId);
    internal.runtime.terminal?.dispose();
    // 镜像会话所有权在原工作台，只本地摘除；本工作台开的副屏会话随关随清。
    if (!internal.record.mirrored && internal.record.state !== "closed") {
      void deps.invoke("ssh/session/close", { sessionId: internal.record.sessionId }).catch(() => undefined);
    }
    if (!panes.value.length) splitOpen.value = false;
  }

  function disposeAll(): void {
    for (const [paneId, internal] of [...internals.entries()]) {
      internals.delete(paneId);
      internal.runtime.terminal?.dispose();
      if (!internal.record.mirrored && internal.record.state !== "closed") {
        void deps.invoke("ssh/session/close", { sessionId: internal.record.sessionId }).catch(() => undefined);
      }
    }
    panes.value = [];
    splitOpen.value = false;
    pickOpen.value = false;
  }

  /** 主会话断开时联动：非镜像副屏共用同一 transport，一并落断开态。 */
  function notifyMainDisconnected(): void {
    for (const internal of internals.values()) {
      if (!internal.record.mirrored && internal.record.state === "connected") {
        markPaneClosed(internal.record.id, deps.t("splitPaneDisconnected"));
      }
    }
  }

  return {
    panes,
    splitOpen,
    splitWidth,
    splitHeight,
    splitDirection,
    pickOpen,
    pickLoading,
    pickRows,
    toggleSplit,
    togglePane,
    toggleDirection,
    addPane,
    openPicker,
    closePicker,
    attachPane,
    closePane,
    acceptFrame,
    handlePaneInput,
    resizePane,
    runtimeFor,
    mountPane,
    unmountPane,
    setWidth,
    setHeight,
    disposeAll,
    notifyMainDisconnected,
    markPaneClosed,
  };
}

export type UseSplitPanes = ReturnType<typeof useSplitPanes>;
