// 监控面板的协议契约类型（从 composables/useMonitorPanel.ts 抽出）。
//
// 只有类型、没有运行时值：面板与卡片组件都从这里取类型，避免「展示组件从
// 有状态的 composable 里 import type」这种反向观感。字段与
// docs/superpowers/plans/2026-11-15-monitor-panel.md §1 一致，serde camelCase
// 已由后端 Lane A 单测锁死。

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

/** 插件自建监控分组（面板 tab/区块/配色单一来源；宿主侧栏组独立于本配置）。 */
export interface MonitorGroupConfig {
  id: string;
  name: string;
  /** 8 色板内的取值（GROUP_COLOR_PALETTE 语义）；空串 = 派生色（hash）。 */
  color: string;
  connectionIds: string[];
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
