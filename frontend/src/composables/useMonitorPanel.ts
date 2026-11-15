// 多服务器监控面板编排核心（DESIGN_MONITOR_PANEL / 计划 §4-B4）。
//
// 职责：监控偏好持久化（pluginStore 三键）+ 双 timer 编排——
// - snapshot 轮询（refreshMs 可调，连续 3 次失败停轮询置 pollStopped，仿 docker 轮询模式）；
// - reconcile 收敛（5s）：host.listConnections(provider-scoped) 过滤 dbType==="ssh"
//   → monitor/status → watched∩connected 无任务补 start → 无 watched 有任务补 stop；
// 动作：toggleWatch（on 写键+未连接经 hostReopen 拉起+立即收敛；off 先 stop 再删键）、
// retry（stop→start 序列）、openTerminal（照 App.vue openConnectionSurface 的
// openWorkbench 调用形状，含 forceNew:true）。
//
// 全部副作用经注入的 api/storage/timers，纯逻辑可在无组件环境下单测
// （useMonitorPanel.spec.ts：假 api + 手动 tick 定时器）。后端契约见 §1 协议
// （serde camelCase 已被 Lane A 单测锁死）：start 幂等、stop 后注册表条目移除、
// snapshot 对无任务连接不给条目、live 可为 null、history 内嵌 Gap 标记。

import { ref, type Ref } from "vue";
import type { KvBacking } from "../../../shared/frontend/pluginStorage";
import { reopenHostConnection } from "../lib/hostReopen";

// —— 协议契约类型（与 docs/superpowers/plans/2026-11-15-monitor-panel.md §1 一致）——

export type MonitorState = "connecting" | "live" | "failed" | "unsupported" | "stopped";

export interface MonitorSample {
  t: number;
  cpuPct: number;
  memTotalMb: number;
  memUsedMb: number;
  netRxKbps: number;
  netTxKbps: number;
  iface?: string;
}

/** 断档标记（iface 切换/采集失败）：sparkline 据此跳线分段。 */
export interface MonitorGap {
  t: number;
  gap: true;
}

export type MonitorHistoryEntry = MonitorSample | MonitorGap;

export interface MonitorDetails {
  load1: number;
  load5: number;
  load15: number;
  uptimeSec: number;
  disks: Array<{ mount: string; totalKb: number; usedKb: number }>;
  users: Array<{ user: string; tty: string; from: string }>;
}

export interface MonitorTaskRow {
  connectionId: string;
  state: MonitorState;
  error?: string;
  since?: number;
  primaryInterface?: string;
}

export interface MonitorSnapshot {
  state: MonitorState;
  live: MonitorSample | null;
  history: MonitorHistoryEntry[];
  details: MonitorDetails | null;
}

/** host.listConnections 行（PR-A4 扩展点）：connected/isConnected 字段探测；groupId 缺省即 Phase 1 平铺。 */
export interface MonitorConnectionRow {
  id: string;
  name: string;
  dbType: string;
  connected?: boolean;
  isConnected?: boolean;
  readOnly?: boolean;
  providerId?: string;
  connectionType?: string;
  groupId?: string;
  groupName?: string;
}

/** window.dbxPlugin 的 MonitorApi 子集（sidecar RPC 走 invoke，宿主扩展点走 request）。 */
export interface MonitorApi {
  invoke(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  request(method: string, params?: unknown): Promise<unknown>;
  openWorkbench?(contributionId: string, context: Record<string, unknown>, options?: { forceNew?: boolean }): Promise<unknown>;
  reopenConnection?(connectionId: string): Promise<unknown>;
}

/** 定时器注入口（默认 window.setInterval/clearInterval；spec 注入手动 tick）。 */
export interface MonitorTimers {
  set(handler: () => unknown, timeoutMs: number): unknown;
  clear(handle: unknown): void;
}

// —— 偏好键与 wire 形态（PLUGIN_STORE_KEYS 同名登记，见 pluginStore.ts 注释）——

export const MONITOR_WATCHED_KEY = "ssh-monitor-watched";
export const MONITOR_PRIVACY_KEY = "ssh-monitor-privacy";
export const MONITOR_REFRESH_MS_KEY = "ssh-monitor-refresh-ms";

const RECONCILE_INTERVAL_MS = 5000;
const SNAPSHOT_FAILURE_LIMIT = 3;
const ALLOWED_REFRESH_MS = [2000, 5000, 10000, 30000, 60000] as const;

interface WatchedWire {
  version: 1;
  watched: Record<string, { addedAt: number }>;
}

function isWatchedWire(value: unknown): value is WatchedWire {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const wire = value as { version?: unknown; watched?: unknown };
  if (wire.version !== 1 || !wire.watched || typeof wire.watched !== "object" || Array.isArray(wire.watched)) return false;
  return Object.values(wire.watched).every((entry) => !!entry && typeof entry === "object" && typeof (entry as { addedAt?: unknown }).addedAt === "number");
}

function isConnectedRow(row: MonitorConnectionRow): boolean {
  return row.connected === true || row.isConnected === true;
}

const defaultTimers: MonitorTimers = {
  set: (handler, timeoutMs) => window.setInterval(() => void handler(), timeoutMs),
  clear: (handle) => window.clearInterval(handle as number),
};

/**
 * 监控面板编排。`start()` 装载偏好、立即跑一轮 reconcile+snapshot 并挂上双
 * timer；`dispose()` 摘除 timer（面板卸载调用）。所有 ref 与动作原样返回，
 * MonitorPanel.vue 直接绑定。
 */
export function useMonitorPanel(deps: { api: MonitorApi; storage: KvBacking; timers?: MonitorTimers }) {
  const { api, storage } = deps;
  const timers = deps.timers ?? defaultTimers;

  // —— 状态 ——
  const connections: Ref<MonitorConnectionRow[]> = ref([]);
  const tasks: Ref<MonitorTaskRow[]> = ref([]);
  const snapshots: Ref<Record<string, MonitorSnapshot>> = ref({});
  const watched: Ref<Record<string, { addedAt: number }>> = ref({});
  const privacy = ref(false);
  const refreshMs = ref(5000);
  const pollStopped = ref(false);
  const taskLimitReached = ref(false);

  // —— 偏好持久化（pluginStore 通道；键已登记水合白名单）——

  function loadWatched(): Record<string, { addedAt: number }> {
    try {
      const raw = storage.getItem(MONITOR_WATCHED_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return isWatchedWire(parsed) ? { ...parsed.watched } : {};
    } catch {
      return {};
    }
  }

  function persistWatched() {
    try {
      const wire: WatchedWire = { version: 1, watched: watched.value };
      storage.setItem(MONITOR_WATCHED_KEY, JSON.stringify(wire));
    } catch {
      // 存储不可用（无宿主桥的直连调试）：面板内存态仍可用，仅不跨重启。
    }
  }

  function loadPrivacy(): boolean {
    try {
      return storage.getItem(MONITOR_PRIVACY_KEY) === "1";
    } catch {
      return false;
    }
  }

  function loadRefreshMs(): number {
    try {
      const parsed = Number(storage.getItem(MONITOR_REFRESH_MS_KEY));
      return (ALLOWED_REFRESH_MS as readonly number[]).includes(parsed) ? parsed : 5000;
    } catch {
      return 5000;
    }
  }

  function togglePrivacy() {
    privacy.value = !privacy.value;
    try {
      storage.setItem(MONITOR_PRIVACY_KEY, privacy.value ? "1" : "0");
    } catch {
      // 同上：内存态生效即可。
    }
  }

  function setRefreshMs(value: number) {
    if (!(ALLOWED_REFRESH_MS as readonly number[]).includes(value)) return;
    refreshMs.value = value;
    restartSnapshotTimer();
    try {
      storage.setItem(MONITOR_REFRESH_MS_KEY, String(value));
    } catch {
      // 同上。
    }
  }

  // —— snapshot 轮询（refreshMs 节拍；连续 3 次失败停轮询）——

  let snapshotFailures = 0;
  let snapshotInFlight = false;
  let snapshotTimer: unknown = null;
  let reconcileTimer: unknown = null;

  async function pollSnapshot() {
    if (snapshotInFlight) return;
    snapshotInFlight = true;
    try {
      const result = (await api.invoke("monitor/snapshot", {})) as { samples?: Record<string, MonitorSnapshot> } | null;
      snapshots.value = result?.samples ?? {};
      snapshotFailures = 0;
      pollStopped.value = false;
    } catch {
      snapshotFailures += 1;
      if (snapshotFailures >= SNAPSHOT_FAILURE_LIMIT) stopSnapshotTimer(true);
    } finally {
      snapshotInFlight = false;
    }
  }

  function startSnapshotTimer() {
    if (snapshotTimer !== null) return;
    snapshotTimer = timers.set(() => void pollSnapshot(), refreshMs.value);
  }

  function stopSnapshotTimer(byFailure = false) {
    if (snapshotTimer !== null) {
      timers.clear(snapshotTimer);
      snapshotTimer = null;
    }
    if (byFailure) pollStopped.value = true;
  }

  function restartSnapshotTimer() {
    stopSnapshotTimer();
    startSnapshotTimer();
  }

  /** 手动刷新（工具栏/停轮询后的重试入口）：清失败计数、恢复 timer、立即拉一次。 */
  async function refresh() {
    snapshotFailures = 0;
    pollStopped.value = false;
    taskLimitReached.value = false;
    restartSnapshotTimer();
    await pollSnapshot();
    await reconcile();
  }

  // —— reconcile 收敛（5s 节拍；失败静默，下一轮重试）——

  let reconcileInFlight = false;

  async function reconcile() {
    if (reconcileInFlight) return;
    reconcileInFlight = true;
    try {
      // ① provider-scoped 连接清单：过滤 ssh；宿主缺扩展点（抛错/null）→ 本轮不动。
      let rows: MonitorConnectionRow[] = [];
      try {
        const listed = (await api.request("host.listConnections")) as { connections?: MonitorConnectionRow[] } | null;
        rows = (listed?.connections ?? []).filter((row) => row && typeof row.id === "string" && row.id && row.dbType === "ssh");
      } catch {
        return;
      }
      connections.value = rows;

      // ② 注册表现状。
      let status: { tasks?: MonitorTaskRow[] };
      try {
        status = (await api.invoke("monitor/status", {})) as { tasks?: MonitorTaskRow[] };
      } catch {
        return;
      }
      tasks.value = status.tasks ?? [];
      const activeTasks = new Set(tasks.value.map((task) => task.connectionId));
      const connected = new Set(rows.filter(isConnectedRow).map((row) => row.id));

      // ③ watched∩connected 无任务 → start（含恢复补启；并发上限报错 → 顶栏提示）。
      const startIds = Object.keys(watched.value).filter((id) => connected.has(id) && !activeTasks.has(id));
      let startFailures = 0;
      await Promise.all(
        startIds.map(async (id) => {
          try {
            await api.invoke("monitor/start", { connectionId: id });
          } catch {
            startFailures += 1;
          }
        }),
      );
      taskLimitReached.value = startFailures > 0;

      // ④ 有任务但不在 watched → stop（stop 幂等；sidecar 收到后移除注册表条目）。
      const stopIds = tasks.value.filter((task) => !watched.value[task.connectionId]).map((task) => task.connectionId);
      await Promise.all(stopIds.map((id) => api.invoke("monitor/stop", { connectionId: id }).catch(() => undefined)));
    } finally {
      reconcileInFlight = false;
    }
  }

  // —— 动作 ——

  /** 加入/移除监控。on：写键 → 未连接则经 hostReopen 拉起 → 立即收敛补 start；
   * off：先 stop（幂等）再删键（下一轮 reconcile 兜底）。 */
  async function toggleWatch(connectionId: string, on: boolean) {
    if (on) {
      if (watched.value[connectionId]) return;
      watched.value = { ...watched.value, [connectionId]: { addedAt: Date.now() } };
      persistWatched();
      const row = connections.value.find((candidate) => candidate.id === connectionId);
      if (row && !isConnectedRow(row)) void reopenHostConnection(api, connectionId);
      await reconcile();
      return;
    }
    try {
      await api.invoke("monitor/stop", { connectionId });
    } catch {
      // 幂等兜底：删键后下一轮 reconcile 第④步再收敛。
    }
    const next = { ...watched.value };
    delete next[connectionId];
    watched.value = next;
    persistWatched();
  }

  /** failed 卡片的 Retry：协议约定的 stop→start 序列（终态不可原地重启）。 */
  async function retry(connectionId: string) {
    try {
      await api.invoke("monitor/stop", { connectionId });
    } catch {
      // stop 幂等；失败不阻塞 start。
    }
    try {
      await api.invoke("monitor/start", { connectionId });
      taskLimitReached.value = false;
    } catch {
      taskLimitReached.value = true;
    }
    await pollSnapshot();
  }

  /** 打开该连接的工作台：照抄 App.vue openConnectionSurface 的 openWorkbench 形状（含 forceNew:true）。 */
  function openTerminal(connection: MonitorConnectionRow) {
    void api.openWorkbench?.(
      "io.dbx.ssh.workbench",
      {
        connectionId: connection.id,
        providerId: connection.providerId,
        connectionType: connection.connectionType,
        connection: { id: connection.id, name: connection.name, readOnly: connection.readOnly === true },
      },
      { forceNew: true },
    );
  }

  // —— 生命周期 ——

  async function start() {
    watched.value = loadWatched();
    privacy.value = loadPrivacy();
    refreshMs.value = loadRefreshMs();
    await Promise.all([reconcile(), pollSnapshot()]);
    startSnapshotTimer();
    // reconcile 节拍固定 5s（连接清单/注册表收敛慢于快照轮询）。
    reconcileTimer = timers.set(() => void reconcile(), RECONCILE_INTERVAL_MS);
  }

  function dispose() {
    stopSnapshotTimer();
    if (reconcileTimer !== null) {
      timers.clear(reconcileTimer);
      reconcileTimer = null;
    }
  }

  return {
    connections,
    tasks,
    snapshots,
    watched,
    privacy,
    refreshMs,
    pollStopped,
    taskLimitReached,
    start,
    dispose,
    refresh,
    togglePrivacy,
    setRefreshMs,
    toggleWatch,
    retry,
    openTerminal,
  };
}
