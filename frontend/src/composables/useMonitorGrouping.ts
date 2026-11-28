import { computed, ref, type Ref } from "vue";
import { GROUP_COLOR_PALETTE, groupColorIndex } from "../components/MonitorCard.vue";
import type { MonitorConnectionRow, MonitorGroupConfig, MonitorSnapshot } from "../lib/monitorProtocol";

/** 分组视图（tree 镜像 / 自建组 / 尾部平铺桶的统一形态）。 */
export interface MonitorGroupView {
  /** 空串 = 平铺桶（无 groupId 字段的行/整体降级），不渲染组头。 */
  id: string;
  /** 自建分组的显式色（空串走 hash 派生；平铺桶恒为空串）。 */
  color?: string;
  name: string;
  rows: MonitorConnectionRow[];
}

/** 卡片状态枚举（面板/卡片共用叙事：connecting 任务在途、live 有快照、
 *  failed/unsupported 终态失败、stopped 会话已停）。 */
export const MONITOR_CARD_STATES = ["connecting", "live", "failed", "unsupported", "stopped"] as const;
export type MonitorCardState = (typeof MONITOR_CARD_STATES)[number];

export type MonitorStatusFilter = "all" | "live" | "issues";
export const MONITOR_FILTER_KEYS: Record<MonitorStatusFilter, string> = {
  all: "monitorFilterAll",
  live: "monitorFilterLive",
  issues: "monitorFilterIssues",
};
export const MONITOR_REFRESH_OPTIONS = [2000, 5000, 10000, 30000, 60000] as const;

/** 卡片条目（隐私模式下的组内序号按筛选后的可见序从 1 起）。 */
export interface MonitorCardEntry {
  row: MonitorConnectionRow;
  privacyIndex: number;
  state: MonitorCardState | "";
  watched: boolean;
}

/** 面板分组/过滤/可见性推导（自 MonitorPanel 纯搬移）：
 *  tree 模式镜像宿主侧栏树（任一行带 groupId）；旧宿主回退自建分组；
 *  tab 前缀区分两维度（tree: 只读展示 / group: 成员过滤视图）；
 *  状态筛选与隐私序号在 cardEntries 里统一算。 */
export function useMonitorGrouping(options: {
  connections: Ref<MonitorConnectionRow[]>;
  snapshots: Ref<Record<string, MonitorSnapshot>>;
  /** 订阅表（值形状随实现：布尔或 {addedAt}，非空即视为开启）。 */
  watched: Ref<Record<string, unknown>>;
  tasks: Ref<Array<{ connectionId: string }>>;
  pluginGroups: Ref<MonitorGroupConfig[]>;
}) {
  const { connections, snapshots, watched, tasks, pluginGroups } = options;

  const statusFilter = ref<MonitorStatusFilter>("all");

  function stateOf(row: MonitorConnectionRow): MonitorCardState | "" {
    const snapshotState = snapshots.value[row.id]?.state;
    if (snapshotState && (MONITOR_CARD_STATES as readonly string[]).includes(snapshotState)) return snapshotState as MonitorCardState;
    // watched 但首个快照未落：按 connecting 叙事渲染（任务在途）。
    return watched.value[row.id] ? "connecting" : "";
  }

  /** 卡片开关的 on 态：显式 watched，或任务在采（已连接自动采集）——
   *  已连接卡片的开关默认就是 on（关闭即停止采集并记 dismissed）。 */
  function watchActive(row: MonitorConnectionRow): boolean {
    if (watched.value[row.id]) return true;
    return tasks.value.some((task) => task.connectionId === row.id);
  }

  function matchesFilter(state: MonitorCardState | ""): boolean {
    if (statusFilter.value === "all") return true;
    if (statusFilter.value === "live") return state === "live";
    return state === "failed" || state === "unsupported";
  }

  /** 宿主侧栏树分组（dock tree）数据在位判定：任一行带 groupId 即 tree 模式
   *  （PR #15003 落地的宿主；旧宿主无此字段 → 回退自建分组/平铺）。 */
  const hasTree = computed(() => connections.value.some((row) => typeof row.groupId === "string" && !!row.groupId));

  /** tree 分组区块（dock 侧栏树镜像）：组序 = 行首次出现序，组名 = groupName。 */
  const treeGroups = computed<MonitorGroupView[]>(() => {
    if (!hasTree.value) return [];
    const rows = connections.value;
    const order: Array<{ id: string; name: string }> = [];
    const byGroup = new Map<string, MonitorConnectionRow[]>();
    for (const row of rows) {
      const groupId = typeof row.groupId === "string" && row.groupId ? row.groupId : "";
      if (!byGroup.has(groupId)) {
        byGroup.set(groupId, []);
        if (groupId) order.push({ id: groupId, name: typeof row.groupName === "string" && row.groupName ? row.groupName : groupId });
      }
      byGroup.get(groupId)!.push(row);
    }
    const view: MonitorGroupView[] = order.map(({ id, name }) => ({ id, name, color: "", rows: byGroup.get(id)! }));
    const ungrouped = byGroup.get("");
    if (ungrouped?.length) view.push({ id: "", name: "", color: "", rows: ungrouped });
    return view;
  });

  const groups = computed<MonitorGroupView[]>(() => {
    const rows = connections.value;
    if (hasTree.value) return treeGroups.value;
    // 自建分组驱动（无 tree 数据的旧宿主回退）：配置序 = 区块序；未入组成员
    // 落尾部平铺桶（不渲染组头）。
    const viewGroups: MonitorGroupView[] = pluginGroups.value.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      rows: rows.filter((row) => group.connectionIds.includes(row.id)),
    }));
    const ungrouped = rows.filter((row) => !pluginGroups.value.some((group) => group.connectionIds.includes(row.id)));
    if (ungrouped.length) viewGroups.push({ id: "", name: "", color: "", rows: ungrouped });
    return viewGroups.filter((group) => group.id === "" || group.rows.length > 0);
  });

  /** 面板 tab（前缀区分两个维度）：
   *  - tree 模式：「全部」+ dock 树分组（镜像宿主侧栏，只读展示 tab）+ 自建组（过滤视图）
   *  - 旧宿主回退：「全部」+ 自建分组（含空组——tab 是入口，删成员不该抹掉配置） */
  const groupTabs = computed(() => {
    const pluginTabs = pluginGroups.value.map((group) => ({ id: `group:${group.id}`, name: group.name, color: group.color, tree: false }));
    if (hasTree.value) {
      return [
        ...treeGroups.value.filter((group) => group.id).map((group) => ({ id: `tree:${group.id}`, name: group.name, color: group.color, tree: true })),
        ...pluginTabs,
      ];
    }
    return pluginTabs;
  });

  const activeTab = ref<string>("all");

  /** tab → 区块过滤：tree:前缀选 tree 组；group:前缀（回退模式）选自建组成员。 */
  function visibleGroups(): MonitorGroupView[] {
    if (activeTab.value === "all") return groups.value;
    if (activeTab.value.startsWith("tree:")) {
      const treeId = activeTab.value.slice(5);
      return groups.value.filter((group) => group.id === treeId);
    }
    const pluginId = activeTab.value.slice(6);
    const memberIds = new Set(pluginGroups.value.find((group) => group.id === pluginId)?.connectionIds ?? []);
    return groups.value
      .map((group) => ({ ...group, rows: group.rows.filter((row) => memberIds.has(row.id)) }))
      .filter((group) => group.rows.length > 0 || (hasTree.value ? false : group.id === pluginId));
  }

  function groupAccent(group: MonitorGroupView): string {
    const configured = pluginGroups.value.find((candidate) => candidate.id === group.id)?.color;
    if (configured) return configured;
    return GROUP_COLOR_PALETTE[groupColorIndex(group.id)];
  }

  function cardEntries(group: MonitorGroupView): MonitorCardEntry[] {
    const entries: MonitorCardEntry[] = [];
    // 隐私模式下的组内序号（1 起，按筛选后的可见序）。
    let ordinal = 0;
    for (const row of group.rows) {
      const state = stateOf(row);
      if (!matchesFilter(state)) continue;
      ordinal += 1;
      entries.push({ row, privacyIndex: ordinal, state, watched: watchActive(row) });
    }
    return entries;
  }

  return {
    statusFilter,
    stateOf,
    watchActive,
    matchesFilter,
    hasTree,
    treeGroups,
    groups,
    groupTabs,
    activeTab,
    visibleGroups,
    groupAccent,
    cardEntries,
  };
}
