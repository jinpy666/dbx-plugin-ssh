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

/** ssh/sessions/list 行（回退源）：sidecar 会话清单，仅取映射所需字段。 */
interface MonitorSessionRow {
  connectionId?: string;
  connected?: boolean;
  readOnly?: boolean;
  username?: string;
  host?: string;
}

/** 插件自建监控分组（面板 tab/区块/配色单一来源；宿主侧栏组独立于本配置）。 */
export interface MonitorGroupConfig {
  id: string;
  name: string;
  /** 8 色板内的取值（GROUP_COLOR_PALETTE 语义）；空串 = 派生色（hash）。 */
  color: string;
  connectionIds: string[];
}

/** groups wire 校验：数组、每项 id/name 非空串、connectionIds 字符串数组。 */
function isGroupsWire(value: unknown): value is { groups: MonitorGroupConfig[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return false;
  return groups.every(
    (group) =>
      group &&
      typeof group === "object" &&
      typeof (group as MonitorGroupConfig).id === "string" &&
      !!(group as MonitorGroupConfig).id &&
      typeof (group as MonitorGroupConfig).name === "string" &&
      Array.isArray((group as MonitorGroupConfig).connectionIds) &&
      (group as MonitorGroupConfig).connectionIds.every((id) => typeof id === "string"),
  );
}

/** window.dbxPlugin 的 MonitorApi 子集（sidecar RPC 走 invoke，宿主扩展点走 request）。 */
export interface MonitorApi {
  invoke(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  request(method: string, params?: unknown): Promise<unknown>;
  openWorkbench?(contributionId: string, context: Record<string, unknown>, options?: { forceNew?: boolean; target?: "tab" }): Promise<unknown>;
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
export const MONITOR_GROUPS_KEY = "ssh-monitor-groups";

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

/**
 * 后端唯一超限错误串（Lane A monitor.rs：`monitor task limit reached (24)`）。
 * 其余 start 失败（无会话/通道错误等）走通用失败路径，不亮「最多 24 台」横幅。
 */
function isTaskLimitError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return message.includes("monitor task limit reached");
}

const defaultTimers: MonitorTimers = {
  set: (handler, timeoutMs) => window.setInterval(() => void handler(), timeoutMs),
  clear: (handle) => window.clearInterval(handle as number),
};

/**
 * 监控面板编排。`start()` 装载偏好、立即跑一轮 reconcile+snapshot 并挂上双
 * timer（重入安全：timer 未摘除前二次调用直接返回）；`dispose()` 摘除 timer
 * 并置 disposed（面板卸载调用；卸载后悬挂的异步回调不再写状态）。
 * 所有 ref 与动作原样返回，MonitorPanel.vue 直接绑定。
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
  // 数据源与诊断：旧宿主无 host.listConnections 扩展点时回退 sidecar 会话清单；
  // 空态下把两源结果暴露给面板诊断行（截图即可定位宿主版本/字段问题）。
  const dataSource = ref<"connections" | "sessions" | "none">("none");
  const listDiagnostics = ref<{ listState: "ok" | "null" | "error"; listCount: number }>({ listState: "ok", listCount: 0 });
  // 用户显式停止采集的连接（内存，面板会话内有效）：自动采集不复活的闸。
  const dismissedAuto = ref<Set<string>>(new Set());
  // —— 插件自建分组（面板 tab/区块/配色）——
  const groups: Ref<MonitorGroupConfig[]> = ref([]);

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

  // —— 分组 CRUD（插件自建；wire 形态 {groups:[…]}）——

  function persistGroups() {
    try {
      storage.setItem(MONITOR_GROUPS_KEY, JSON.stringify({ groups: groups.value }));
    } catch {
      // 同 watched：无桥直连调试时降级为会话内状态。
    }
  }

  function loadGroups(): MonitorGroupConfig[] {
    try {
      const raw = storage.getItem(MONITOR_GROUPS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return isGroupsWire(parsed) ? parsed.groups : [];
    } catch {
      return [];
    }
  }

  function createGroup(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const group: MonitorGroupConfig = {
      id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: trimmed,
      color: "",
      connectionIds: [],
    };
    groups.value = [...groups.value, group];
    persistGroups();
    return group.id;
  }

  function renameGroup(groupId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    groups.value = groups.value.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group));
    persistGroups();
  }

  function deleteGroup(groupId: string) {
    groups.value = groups.value.filter((group) => group.id !== groupId);
    persistGroups();
  }

  function setGroupColor(groupId: string, color: string) {
    groups.value = groups.value.map((group) => (group.id === groupId ? { ...group, color } : group));
    persistGroups();
  }

  function toggleGroupMember(groupId: string, connectionId: string) {
    // 互斥归属：加入新组时自动从旧组移除（一机一组，避免同卡在多组重复渲染）。
    groups.value = groups.value
      .map((group) => {
        if (group.id === groupId) return group;
        const without = group.connectionIds.filter((id) => id !== connectionId);
        return without.length === group.connectionIds.length ? group : { ...group, connectionIds: without };
      })
      .map((group) => {
        if (group.id !== groupId) return group;
        const has = group.connectionIds.includes(connectionId);
        return { ...group, connectionIds: has ? group.connectionIds.filter((id) => id !== connectionId) : [...group.connectionIds, connectionId] };
      });
    persistGroups();
  }

  /** 连接的插件分组归属（一个连接至多属一个组——首次命中即返回）。 */
  function groupOfConnection(connectionId: string): string {
    return groups.value.find((group) => group.connectionIds.includes(connectionId))?.id ?? "";
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
  // 面板生命周期标志：dispose() 后悬挂的异步回调一律不再写状态（卸载竞态防护）。
  let disposed = false;

  async function pollSnapshot() {
    if (snapshotInFlight) return;
    snapshotInFlight = true;
    try {
      const result = (await api.invoke("monitor/snapshot", {})) as { samples?: Record<string, MonitorSnapshot> } | null;
      if (disposed) return;
      snapshots.value = result?.samples ?? {};
      snapshotFailures = 0;
      pollStopped.value = false;
    } catch {
      if (disposed) return;
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
      // ① 连接清单：主源 host.listConnections（provider-scoped，宿主 ≥ 扩展点版本
      // 才有；dispatch 返回裸数组 PluginConnectionSummary[]，兼容旧包裹形状）。
      // 旧宿主 unknown method resolve null/抛错时**回退 sidecar ssh/sessions/list**：
      // sidecar 永远知道已连接会话（去重 per connectionId），已连接主机的监控不依赖
      // 宿主版本；两源皆空才是真·无服务器。
      let rows: MonitorConnectionRow[] = [];
      let listState: "ok" | "null" | "error" = "ok";
      let listCount = 0;
      try {
        const listed = (await api.request("host.listConnections")) as MonitorConnectionRow[] | { connections?: MonitorConnectionRow[] } | null;
        const rawRows: MonitorConnectionRow[] = Array.isArray(listed) ? listed : (listed?.connections ?? []);
        if (listed == null) listState = "null";
        listCount = rawRows.length;
        // 真机宿主把插件连接的 db_type 存为 "plugin"（connectionStore.ts:5446），
        // SSH 身份看 plugin_connection_type === "ssh"（用户库实锤：db_type=plugin +
        // provider=io.dbx.ssh.connection + type=ssh）；兼容原生 db_type="ssh" 的
        // 表示。vnc/rdp/local 由 connectionType 白名单排除。
        rows = rawRows.filter((row) => row && typeof row.id === "string" && row.id && (row.dbType === "ssh" ? row.connectionType === undefined || row.connectionType === "ssh" : row.dbType === "plugin" && row.providerId?.startsWith("io.dbx.ssh.") === true && row.connectionType === "ssh"));
      } catch {
        listState = "error";
      }
      let viaSessions = false;
      if (!rows.length) {
        try {
          const listed = (await api.invoke("ssh/sessions/list")) as { sessions?: MonitorSessionRow[] } | null;
          const byConnection = new Map<string, MonitorConnectionRow>();
          for (const session of listed?.sessions ?? []) {
            if (!session || typeof session.connectionId !== "string" || !session.connectionId) continue;
            if (byConnection.has(session.connectionId)) continue;
            const label = [session.username, session.host].filter(Boolean).join("@");
            byConnection.set(session.connectionId, {
              id: session.connectionId,
              name: label || session.connectionId,
              dbType: "ssh",
              connected: session.connected === true,
              isConnected: session.connected === true,
              readOnly: session.readOnly === true,
            });
          }
          rows = [...byConnection.values()];
          viaSessions = rows.length > 0;
        } catch {
          // sidecar 也缺 → 维持空，noServers 是真实结论。
        }
      }
      if (disposed) return;
      connections.value = rows;
      dataSource.value = rows.length ? (viaSessions ? "sessions" : "connections") : "none";
      listDiagnostics.value = { listState, listCount };

      // ② 注册表现状。
      let status: { tasks?: MonitorTaskRow[] };
      try {
        status = (await api.invoke("monitor/status", {})) as { tasks?: MonitorTaskRow[] };
      } catch {
        return;
      }
      if (disposed) return;
      tasks.value = status.tasks ?? [];
      const activeTasks = new Set(tasks.value.map((task) => task.connectionId));
      const connected = new Set(rows.filter(isConnectedRow).map((row) => row.id));

      // ③ 已连接主机**自动开始采集**（打开面板即见曲线；纯本地采集、不拨连接）。
      // watched 表保留「未连接主机的拉起声明」与跨会话恢复语义；显式关闭采集的
      // id 记入 dismissed（内存），本面板会话内不再自动复活（④不回收，③跳过）。
      const startIds = [...connected].filter(
        (id) => !activeTasks.has(id) && (watched.value[id] || !dismissedAuto.value.has(id)),
      );
      let startLimitFailures = 0;
      await Promise.all(
        startIds.map(async (id) => {
          try {
            await api.invoke("monitor/start", { connectionId: id });
          } catch (error) {
            if (isTaskLimitError(error)) startLimitFailures += 1;
          }
        }),
      );
      if (disposed) return;
      taskLimitReached.value = startLimitFailures > 0;

      // ④ 回收失效任务：会话已不在线且用户未声明 watched → stop（stop 幂等，
      // sidecar 收到后移除注册表条目）。已连接主机的任务一律保留（自动采集）。
      const stopIds = tasks.value
        .filter((task) => !connected.has(task.connectionId) && !watched.value[task.connectionId])
        .map((task) => task.connectionId);
      await Promise.all(stopIds.map((id) => api.invoke("monitor/stop", { connectionId: id }).catch(() => undefined)));
    } finally {
      reconcileInFlight = false;
    }
  }

  // —— 动作 ——

  /** 加入/移除监控。on：写键（同时清 dismissed）→ 未连接则经 hostReopen 拉起 →
   * 立即收敛补 start；off：先 stop（幂等）再删键，并记入 dismissedAuto——
   * 已连接主机的自动采集被用户显式关闭后，本面板会话内不再自动复活。 */
  async function toggleWatch(connectionId: string, on: boolean) {
    if (on) {
      if (watched.value[connectionId]) return;
      watched.value = { ...watched.value, [connectionId]: { addedAt: Date.now() } };
      persistWatched();
      const dismissed = new Set(dismissedAuto.value);
      dismissed.delete(connectionId);
      dismissedAuto.value = dismissed;
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
    if (!dismissedAuto.value.has(connectionId)) {
      dismissedAuto.value = new Set([...dismissedAuto.value, connectionId]);
    }
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
      if (!disposed) taskLimitReached.value = false;
    } catch (error) {
      // 仅超限错误亮横幅；通道类失败静默（下一轮 reconcile/手动刷新兜底）。
      if (!disposed && isTaskLimitError(error)) taskLimitReached.value = true;
    }
    await pollSnapshot();
  }

  /** 打开该连接的工作台：照抄 App.vue openConnectionSurface 的 openWorkbench 形状
   * （forceNew + target:"tab"；缺省 target 时同面板复用可能覆盖当前 tab）。 */
  function openTerminal(connection: MonitorConnectionRow) {
    void api.openWorkbench?.(
      "io.dbx.ssh.workbench",
      {
        connectionId: connection.id,
        providerId: connection.providerId,
        connectionType: connection.connectionType,
        connection: { id: connection.id, name: connection.name, readOnly: connection.readOnly === true },
      },
      { forceNew: true, target: "tab" },
    );
  }

  // —— 生命周期 ——

  async function start() {
    // 重入守卫：timer 未摘除前二次 start 会双开节拍（并覆盖 reconcileTimer 泄漏首柄）。
    if (disposed || snapshotTimer !== null || reconcileTimer !== null) return;
    watched.value = loadWatched();
    groups.value = loadGroups();
    privacy.value = loadPrivacy();
    refreshMs.value = loadRefreshMs();
    await Promise.all([reconcile(), pollSnapshot()]);
    if (disposed) return; // start 悬挂期间已卸载：不挂 timer。
    startSnapshotTimer();
    // reconcile 节拍固定 5s（连接清单/注册表收敛慢于快照轮询）。
    reconcileTimer = timers.set(() => void reconcile(), RECONCILE_INTERVAL_MS);
  }

  function dispose() {
    disposed = true;
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
    groups,
    createGroup,
    renameGroup,
    deleteGroup,
    setGroupColor,
    toggleGroupMember,
    groupOfConnection,
    privacy,
    refreshMs,
    pollStopped,
    taskLimitReached,
    dataSource,
    listDiagnostics,
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
