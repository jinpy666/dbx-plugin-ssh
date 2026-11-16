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
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Eye, EyeOff } from "@lucide/vue";
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

const groups = computed<MonitorGroupView[]>(() => {
  const rows = connections.value;
  // 自建分组驱动（面板 tab/区块/配色单一来源）：配置序 = 区块序；未入组成员
  // 落尾部平铺桶（不渲染组头）。宿主 groupId 字段（PR #15003）暂不参与渲染，
  // 避免双分组体系——落地后再评估合并策略。
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

/** 面板 tab：全部 + 自建分组（含空组——tab 是入口，删成员不该抹掉配置）。 */
const groupTabs = computed(() => pluginGroups.value.map((group) => ({ id: group.id, name: group.name, color: group.color })));

const activeTab = ref<string>("all");

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

function submitNewGroup() {
  const id = createGroup(draftName.value);
  if (id) {
    draftName.value = "";
    activeTab.value = id;
  }
}
</script>

<template>
  <div class="monitor-panel">
    <header class="monitor-toolbar">
      <h1 class="monitor-title">{{ t("monitor.title") }}</h1>
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

    <!-- 分组管理弹层：新建 + 每组（名称/8 色板/成员勾选/删除） -->
    <section v-if="groupManagerOpen" class="monitor-group-manager" data-testid="monitor-group-manager">
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
          <button type="button" class="monitor-group-delete" @click="deleteGroup(group.id); if (activeTab === group.id) activeTab = 'all'">
            {{ t("monitor.groupDelete") }}
          </button>
        </div>
        <div class="monitor-group-members">
          <label v-for="row in connections" :key="row.id" class="monitor-member-chip" :class="{ 'is-member': group.connectionIds.includes(row.id) }">
            <input type="checkbox" :checked="group.connectionIds.includes(row.id)" @change="() => toggleGroupMember(group.id, row.id)" />
            {{ privacy ? `#${connections.indexOf(row) + 1}` : row.name }}
          </label>
        </div>
      </div>
    </section>

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
      <!-- 空分组视图：选中 tab 的组暂无成员（groups computed 滤掉空组时也要有反馈） -->
      <p v-if="activeTab !== 'all' && !groups.some((candidate) => candidate.id === activeTab)" class="monitor-empty">{{ t("monitor.emptyGroup") }}</p>
      <section v-for="group in activeTab === 'all' ? groups : groups.filter((candidate) => candidate.id === activeTab)" :key="group.id || '__flat__'" class="monitor-group">
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
