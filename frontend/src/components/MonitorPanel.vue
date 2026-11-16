<script setup lang="ts">
// 多服务器监控面板根组件（DESIGN_MONITOR_PANEL / 计划 §4-B5）。
// 路由：main.ts 按 contribution id（io.dbx.ssh.monitor）分支到此，以 { context }
// 传 props（TunnelManager 面板根模式）。数据与编排全部在 useMonitorPanel
// （B4：快照轮询 + 5s 收敛 + 偏好持久化），本组件只做视图：
// - 工具栏：隐私开关 / 刷新间隔下拉 / 状态筛选（all|live|issues）；
// - 分组：listConnections 行含 groupId 时按组分区（组头色条 = FNV-1a % 8
//   取 MonitorCard.GROUP_COLOR_PALETTE，组序 = 数组首次出现序），无 groupId
//   字段 → 单一平铺区（Phase 1 降级）；
// - 卡片：MonitorCard（五态徽标 / gap 分段 sparkline / 详情 / Retry）。
// locale 经 window.dbxPlugin 初始值 + env 事件跟随（TunnelManager 同款）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Eye, EyeOff, RefreshCw, X } from "@lucide/vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import MonitorCard, { GROUP_COLOR_PALETTE, groupColorIndex } from "./MonitorCard.vue";
import { workbenchMessage } from "../lib/i18n";
import { pluginStore } from "../lib/pluginStore";
import { useMonitorPanel, type MonitorConnectionRow } from "../composables/useMonitorPanel";

defineProps<{ context: Record<string, unknown> }>();

const locale = ref(window.dbxPlugin.locale || "zh-CN");
const t = (key: string) => workbenchMessage(locale.value, key);
const unsubscribe = window.dbxPlugin.onEvent((event) => {
  if (event.type === "env" && event.locale) locale.value = event.locale;
});

const {
  connections,
  tasks,
  snapshots,
  watched,
  groups: pluginGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  setGroupColor,
  toggleGroupMember,
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
} = useMonitorPanel({ api: window.dbxPlugin, storage: pluginStore });
onMounted(() => void start());
onBeforeUnmount(() => {
  unsubscribe();
  dispose();
});

// —— 工具栏 ——

type StatusFilter = "all" | "live" | "issues";
const statusFilter = ref<StatusFilter>("all");
const FILTER_KEYS: Record<StatusFilter, string> = {
  all: "monitor.filterAll",
  live: "monitor.filterLive",
  issues: "monitor.filterIssues",
};
const REFRESH_OPTIONS = [2000, 5000, 10000, 30000, 60000] as const;

// —— 分组与筛选 ——

const CARD_STATES = ["connecting", "live", "failed", "unsupported", "stopped"] as const;
type PanelCardState = (typeof CARD_STATES)[number];

interface MonitorGroupView {
  /** 空串 = 平铺桶（无 groupId 字段的行/整体降级），不渲染组头。 */
  id: string;
  /** 自建分组的显式色（空串走 hash 派生；平铺桶恒为空串）。 */
  color?: string;
  name: string;
  rows: MonitorConnectionRow[];
}

interface MonitorCardEntry {
  row: MonitorConnectionRow;
  privacyIndex: number;
  state: PanelCardState | "";
  watched: boolean;
}

function stateOf(row: MonitorConnectionRow): PanelCardState | "" {
  const snapshotState = snapshots.value[row.id]?.state;
  if (snapshotState && (CARD_STATES as readonly string[]).includes(snapshotState)) return snapshotState as PanelCardState;
  // watched 但首个快照未落：按 connecting 叙事渲染（任务在途）。
  return watched.value[row.id] ? "connecting" : "";
}

/** 卡片开关的 on 态：显式 watched，或任务在采（已连接自动采集）——
 *  已连接卡片的开关默认就是 on（关闭即停止采集并记 dismissed）。 */
function watchActive(row: MonitorConnectionRow): boolean {
  if (watched.value[row.id]) return true;
  return tasks.value.some((task: { connectionId: string }) => task.connectionId === row.id);
}

function matchesFilter(state: PanelCardState | ""): boolean {
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

// —— 分组管理弹层 ——
const groupManagerOpen = ref(false);
const draftName = ref("");
// 打开浮层时自动选中一个自建分组作为编辑目标（成员区依赖它）；无组则提示先建。
watch(groupManagerOpen, (open) => {
  if (!open) return;
  if (!activeTab.value.startsWith("group:")) {
    const first = pluginGroups.value[0];
    if (first) activeTab.value = `group:${first.id}`;
  }
});

function submitNewGroup() {
  const id = createGroup(draftName.value);
  if (id) {
    draftName.value = "";
    activeTab.value = `group:${id}`;
  }
}

// —— 成员区的 dock 树分节（tree 模式）：组头全选整组进/出当前编辑的 monitor 组 ——
const sectionCheckRefs = new Map<string, HTMLInputElement>();

function setSectionRef(sectionId: string, el: unknown) {
  const input = el as HTMLInputElement | null;
  if (input) sectionCheckRefs.set(sectionId, input);
  else sectionCheckRefs.delete(sectionId);
}

const treeMemberSections = computed(() => {
  const activeGroupId = activeTab.value.startsWith("group:") ? activeTab.value.slice(6) : "";
  const activeGroup = pluginGroups.value.find((group) => group.id === activeGroupId);
  if (!activeGroup) return [];
  return treeGroups.value
    .filter((section) => section.rows.length > 0)
    .map((section) => {
      const memberIds = section.rows.map((row) => row.id);
      const selected = memberIds.filter((id) => activeGroup.connectionIds.includes(id)).length;
      return { id: section.id, name: section.name || t("monitor.groupAll"), rows: section.rows, allSelected: selected === memberIds.length && memberIds.length > 0, selected };
    });
});

function toggleSection(section: { id: string; rows: MonitorConnectionRow[]; allSelected: boolean }) {
  const activeGroupId = activeTab.value.startsWith("group:") ? activeTab.value.slice(6) : "";
  if (!activeGroupId) return;
  const memberSet = new Set(pluginGroups.value.find((group) => group.id === activeGroupId)?.connectionIds ?? []);
  for (const row of section.rows) {
    const isMember = memberSet.has(row.id);
    if (!section.allSelected && !isMember) toggleGroupMember(activeGroupId, row.id);
    else if (section.allSelected && isMember) toggleGroupMember(activeGroupId, row.id);
  }
}

// 部分选中 → indeterminate 视觉态（checkbox 三态）。
watch(treeMemberSections, (sections) => {
  for (const section of sections) {
    const el = sectionCheckRefs.get(section.id);
    if (el) el.indeterminate = section.selected > 0 && !section.allSelected;
  }
}, { deep: true });
</script>

<template>
  <div class="monitor-panel">
    <header class="monitor-toolbar">
      <h1 class="monitor-title">{{ t("monitor.title") }}</h1>
      <!-- 服务器计数摘要：列表来源就绪后的直观规模感（列表空时不显示） -->
      <span v-if="connections.length" class="monitor-summary" data-testid="monitor-summary">
        {{ connections.length }} · {{ tasks.filter((task: { state: string }) => task.state === "live").length }} live
      </span>
      <button type="button" class="monitor-icon-btn" :aria-label="t('monitor.refresh')" :title="t('monitor.refresh')" data-testid="monitor-refresh" @click="() => refresh()">
        <RefreshCw :size="14" aria-hidden="true" />
      </button>
      <div class="monitor-filter" role="group" :aria-label="t('monitor.title')">
        <button
          v-for="filter in Object.keys(FILTER_KEYS) as StatusFilter[]"
          :key="filter"
          type="button"
          class="monitor-filter-btn"
          :data-testid="`monitor-filter-${filter}`"
          :aria-pressed="statusFilter === filter"
          @click="statusFilter = filter"
        >
          {{ t(FILTER_KEYS[filter]) }}
        </button>
      </div>
      <label class="monitor-refresh">
        <span class="monitor-refresh-label">{{ t("monitor.refresh") }}</span>
        <Select :model-value="refreshMs" @update:model-value="(value) => setRefreshMs(Number(value))">
          <SelectTrigger class="monitor-refresh-select" :aria-label="t('monitor.refresh')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in REFRESH_OPTIONS" :key="option" :value="option">{{ `${option / 1000}s` }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <button
        type="button"
        class="monitor-toolbar-btn"
        data-testid="monitor-privacy-toggle"
        :aria-pressed="privacy"
        :title="t('monitor.privacyHint')"
        @click="togglePrivacy"
      >
        <Eye v-if="!privacy" :size="14" aria-hidden="true" />
        <EyeOff v-else :size="14" aria-hidden="true" />
        <span>{{ t("monitor.privacy") }}</span>
      </button>
    </header>

    <!-- 分组 tab 条：全部 + 自建分组（色点）+ 管理入口。空连接列表也渲染，方便先建组。 -->
    <nav class="monitor-tabs" role="tablist" :aria-label="t('monitor.groupAll')">
      <button
        type="button"
        class="monitor-tab"
        :class="{ 'is-active': activeTab === 'all' }"
        role="tab"
        data-testid="monitor-tab-all"
        :aria-selected="activeTab === 'all'"
        @click="activeTab = 'all'"
      >
        {{ t("monitor.groupAll") }}
      </button>
      <button
        v-for="tab in groupTabs"
        :key="tab.id"
        type="button"
        class="monitor-tab"
        :class="{ 'is-active': activeTab === tab.id }"
        role="tab"
        :data-testid="`monitor-tab-${tab.id}`"
        :data-tree="tab.tree"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        <span class="monitor-tab-dot" :style="{ backgroundColor: tab.color || groupAccent({ id: tab.id, name: tab.name, color: tab.color, rows: [] }) }" aria-hidden="true"></span>
        {{ tab.name }}
      </button>
      <button type="button" class="monitor-tab monitor-tab-manage" :aria-pressed="groupManagerOpen" data-testid="monitor-group-manage" @click="groupManagerOpen = !groupManagerOpen">
        {{ t("monitor.groupManage") }}
      </button>
    </nav>

    <!-- 分组管理浮层：backdrop + 居中卡（不再内联推挤 dashboard） -->
    <div v-if="groupManagerOpen" class="monitor-manager-overlay" @click.self="groupManagerOpen = false">
      <section class="monitor-group-manager" data-testid="monitor-group-manager" role="dialog" :aria-label="t('monitor.groupManage')">
        <header class="monitor-manager-head">
          <strong>{{ t("monitor.groupManage") }}</strong>
          <button type="button" class="monitor-icon-btn" :aria-label="t('monitor.close')" data-testid="monitor-group-close" @click="groupManagerOpen = false">
            <X :size="15" aria-hidden="true" />
          </button>
        </header>
        <form class="monitor-group-new" @submit.prevent="submitNewGroup">
          <input v-model="draftName" class="monitor-group-input" :placeholder="t('monitor.groupName')" :aria-label="t('monitor.groupName')" />
          <button type="submit" class="monitor-toolbar-btn" :disabled="!draftName.trim()">{{ t("monitor.groupNew") }}</button>
        </form>
        <div v-for="group in pluginGroups" :key="group.id" class="monitor-group-row" :data-group-id="group.id">
          <div class="monitor-group-row-head">
            <input class="monitor-group-input" :value="group.name" :aria-label="t('monitor.groupName')" @change="(event) => renameGroup(group.id, (event.target as HTMLInputElement).value)" />
            <div class="monitor-group-colors" role="group" :aria-label="t('monitor.groupColor')">
              <button
                v-for="palette in GROUP_COLOR_PALETTE"
                :key="palette"
                type="button"
                class="monitor-color-dot"
                :class="{ 'is-active': group.color === palette }"
                :style="{ backgroundColor: palette }"
                :aria-label="`${t('monitor.groupColor')} ${palette}`"
                @click="setGroupColor(group.id, group.color === palette ? '' : palette)"
              ></button>
            </div>
          <button type="button" class="monitor-group-delete" @click="deleteGroup(group.id); if (activeTab === `group:${group.id}`) activeTab = 'all'">
            {{ t("monitor.groupDelete") }}
          </button>
        </div>
        <!-- 成员区：tree 分组在位时按 dock 树两级展示（组头全选整组 / 单机勾选）；
             旧宿主无 tree 数据回退平铺 chips。 -->
        <template v-if="hasTree">
          <div v-for="section in treeMemberSections" :key="section.id" class="monitor-member-section">
            <label class="monitor-member-section-head">
              <input
                type="checkbox"
                :checked="section.allSelected"
                :ref="(el) => setSectionRef(section.id, el)"
                @change="() => toggleSection(section)"
              />
              <span class="monitor-member-section-name">{{ section.name }}</span>
            </label>
            <div class="monitor-group-members">
              <label v-for="row in section.rows" :key="row.id" class="monitor-member-chip" :class="{ 'is-member': group.connectionIds.includes(row.id) }">
                <input type="checkbox" :checked="group.connectionIds.includes(row.id)" @change="() => toggleGroupMember(group.id, row.id)" />
                {{ privacy ? `#${connections.indexOf(row) + 1}` : row.name }}
              </label>
            </div>
          </div>
        </template>
        <div v-else class="monitor-group-members">
          <label v-for="row in connections" :key="row.id" class="monitor-member-chip" :class="{ 'is-member': group.connectionIds.includes(row.id) }">
            <input type="checkbox" :checked="group.connectionIds.includes(row.id)" @change="() => toggleGroupMember(group.id, row.id)" />
            {{ privacy ? `#${connections.indexOf(row) + 1}` : row.name }}
          </label>
        </div>
      </div>
      </section>
    </div>

    <!-- 连续 3 次快照失败后轮询自停：横幅即恢复按钮（refresh 会清 pollStopped） -->
    <button v-if="pollStopped" type="button" class="monitor-banner" @click="() => refresh()">{{ t("monitor.pollStopped") }}</button>
    <p v-if="taskLimitReached" class="monitor-banner monitor-banner--error">{{ t("monitor.taskLimit") }}</p>

    <template v-if="!connections.length">
      <p class="monitor-empty">{{ t("monitor.noServers") }}</p>
      <!-- 空态诊断行（数据行，非文案）：两源结果与行数，截图即可定位宿主版本/字段问题 -->
      <p class="monitor-diag" data-testid="monitor-diag">
        listConnections: {{ listDiagnostics.listState }} ({{ listDiagnostics.listCount }}) · sessions: {{ dataSource === "sessions" ? "fallback" : dataSource }}
      </p>
    </template>

    <template v-else>
      <!-- 空视图：tab 指向的组暂无匹配卡片 -->
      <p v-if="activeTab !== 'all' && !visibleGroups().some((candidate) => candidate.rows.length)" class="monitor-empty">{{ t("monitor.emptyGroup") }}</p>
      <section v-for="group in visibleGroups()" :key="group.id || '__flat__'" class="monitor-group">
        <div v-if="group.id" class="monitor-group-head" :data-group-id="group.id">
          <span class="monitor-group-accent" :style="{ backgroundColor: groupAccent(group) }" aria-hidden="true"></span>
          <strong class="monitor-group-name">{{ group.name }}</strong>
          <span class="monitor-group-count">{{ cardEntries(group).length }}</span>
        </div>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          <MonitorCard
            v-for="entry in cardEntries(group)"
            :key="entry.row.id"
            :row="entry.row"
            :snapshot="snapshots[entry.row.id] ?? null"
            :watched="entry.watched"
            :state="entry.state"
            :privacy="privacy"
            :privacy-index="entry.privacyIndex"
            :t="t"
            @toggle-watch="(connectionId, on) => toggleWatch(connectionId, on)"
            @open-terminal="(row) => openTerminal(row)"
            @retry="(connectionId) => retry(connectionId)"
          />
        </div>
        <p v-if="!cardEntries(group).length" class="monitor-empty">{{ t("monitor.emptyGroup") }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.monitor-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem;
  min-height: 100%;
  box-sizing: border-box;
}
.monitor-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.625rem;
}
.monitor-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  margin-right: auto;
}
.monitor-filter {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.monitor-filter-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  cursor: pointer;
}
.monitor-filter-btn + .monitor-filter-btn {
  border-left: 1px solid var(--border);
}
.monitor-filter-btn[aria-pressed="true"] {
  background: var(--primary);
  color: var(--primary-foreground, #fff);
}
/* —— 分组 tab 条 —— */
.monitor-tabs {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
  margin: 0 0 0.75rem;
}
.monitor-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.monitor-tab.is-active {
  background: var(--primary);
  border-color: var(--primary);
  color: var(--primary-foreground, #fff);
}
.monitor-tab-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  flex: none;
}
.monitor-tab-manage {
  border-style: dashed;
}
/* tree 段（dock 镜像）与 monitor 自建段之间的视觉分隔。 */
.monitor-tab[data-tree="true"] + .monitor-tab[data-tree="false"] {
  margin-left: 0.375rem;
  position: relative;
}
.monitor-tab[data-tree="true"] + .monitor-tab[data-tree="false"]::before {
  content: "";
  position: absolute;
  left: -0.25rem;
  top: 15%;
  height: 70%;
  width: 1px;
  background: var(--border);
}
/* —— 工具栏摘要与刷新 —— */
.monitor-summary {
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.monitor-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 6px;
  border: none;
  color: var(--muted-foreground);
  background: transparent;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.monitor-icon-btn:hover {
  color: var(--foreground);
  background: var(--muted);
}
.monitor-icon-btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
/* —— 分组管理浮层（backdrop + 居中卡） —— */
.monitor-manager-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 4rem 1rem 1rem;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}
.monitor-group-manager {
  width: min(560px, 100%);
  max-height: min(70vh, 560px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.625rem;
  padding: 0.875rem;
  background: var(--card, var(--background));
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.35);
}
.monitor-manager-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.monitor-manager-head strong {
  font-size: 0.8125rem;
}
/* —— 分组管理弹层 —— */
.monitor-group-manager {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
  margin: 0 0 0.75rem;
}
.monitor-group-new {
  display: flex;
  gap: 0.5rem;
}
.monitor-group-input {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--foreground);
}
.monitor-group-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
}
.monitor-group-row-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.monitor-group-colors {
  display: inline-flex;
  gap: 0.25rem;
}
.monitor-color-dot {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  cursor: pointer;
  padding: 0;
}
.monitor-color-dot.is-active {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.monitor-group-delete {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--destructive, #ef4444);
  cursor: pointer;
}
.monitor-group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}
/* —— 成员区 dock 树分节（tree 模式） —— */
.monitor-member-section {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border-left: 2px solid var(--border);
  padding-left: 0.5rem;
  margin-bottom: 0.5rem;
}
.monitor-member-section-head {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--foreground);
  cursor: pointer;
  user-select: none;
}
.monitor-member-section-name {
  font-weight: 600;
}
.monitor-member-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.monitor-member-chip.is-member {
  border-color: var(--primary);
  color: var(--foreground);
}
.monitor-refresh {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
.monitor-refresh-select {
  height: 1.75rem;
  width: 4.5rem;
  font-size: 0.75rem;
}
.monitor-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  padding: 0.25rem 0.625rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.monitor-toolbar-btn[aria-pressed="true"] {
  color: var(--primary);
  border-color: var(--primary);
}
.monitor-banner {
  margin: 0;
  font-size: 0.75rem;
  padding: 0.375rem 0.625rem;
  border-radius: 8px;
  border: 1px solid var(--warning, var(--border));
  background: var(--muted);
  color: var(--muted-foreground);
  text-align: left;
  cursor: pointer;
}
.monitor-banner--error {
  color: var(--destructive);
  border-color: var(--destructive);
  cursor: default;
}
.monitor-empty {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.monitor-diag {
  margin: 4px 0 0;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--muted-foreground);
  opacity: 0.75;
}
.monitor-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.monitor-group-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.monitor-group-accent {
  width: 0.25rem;
  height: 1rem;
  border-radius: 2px;
}
.monitor-group-name {
  font-size: 0.8125rem;
  font-weight: 600;
}
.monitor-group-count {
  font-size: 0.6875rem;
  padding: 0.125rem 0.375rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
</style>
