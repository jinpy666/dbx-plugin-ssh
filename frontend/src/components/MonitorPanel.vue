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
import { useMonitorPanel } from "../composables/useMonitorPanel";
import type { MonitorConnectionRow } from "../lib/monitorProtocol";
import { useMonitorGrouping, MONITOR_FILTER_KEYS, MONITOR_REFRESH_OPTIONS, type MonitorStatusFilter } from "../composables/useMonitorGrouping";
import { useMonitorGroupManager } from "../composables/useMonitorGroupManager";

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

// 分组/过滤/可见性推导（tree 镜像、自建组、tab 前缀、隐私序号）下沉
// useMonitorGrouping：面板只留工具栏与卡片渲染。
const {
  statusFilter,
  query,
  matchesQuery,
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
} = useMonitorGrouping({ connections, snapshots, watched, tasks, pluginGroups });
onMounted(() => void start());
onBeforeUnmount(() => {
  unsubscribe();
  dispose();
});

// —— 工具栏 ——

// 过滤/刷新常量随 useMonitorGrouping 提供。
const FILTER_KEYS = MONITOR_FILTER_KEYS;
const REFRESH_OPTIONS = MONITOR_REFRESH_OPTIONS;

// 分组管理浮层（新建/成员分节/全选三态）下沉 useMonitorGroupManager。
const { groupManagerOpen, draftName, submitNewGroup, setSectionRef, treeMemberSections, toggleSection } = useMonitorGroupManager({
  t,
  pluginGroups,
  treeGroups,
  activeTab,
  createGroup,
  toggleGroupMember,
});
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
          v-for="filter in Object.keys(FILTER_KEYS) as MonitorStatusFilter[]"
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
      <label class="monitor-search">
        <input
          v-model="query"
          type="search"
          class="monitor-search-input"
          data-testid="monitor-search"
          :placeholder="t('monitor.searchPlaceholder')"
          :aria-label="t('monitor.searchPlaceholder')"
          spellcheck="false"
        />
        <button
          v-if="query"
          type="button"
          class="monitor-search-clear"
          data-testid="monitor-search-clear"
          :aria-label="t('monitor.searchClear')"
          :title="t('monitor.searchClear')"
          @click="query = ''"
        ><X :size="12" aria-hidden="true" /></button>
      </label>
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
    <MonitorGroupManager
      v-if="groupManagerOpen"
      :t="t"
      :open="groupManagerOpen"
      :groups="pluginGroups"
      :connections="connections"
      :has-tree="hasTree"
      :tree-groups="treeGroups"
      :active-tab="activeTab"
      :privacy="privacy"
      :create-group="createGroup"
      :rename-group="renameGroup"
      :delete-group="deleteGroup"
      :set-group-color="setGroupColor"
      :toggle-group-member="toggleGroupMember"
      @close="groupManagerOpen = false"
      @update:active-tab="(value: string) => (activeTab = value)"
    />

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
        <!-- 空组文案区分「检索无命中」：搜索时给出明确的空因，而不是笼统的空组。 -->
        <p v-if="!cardEntries(group).length" class="monitor-empty" :data-testid="query.trim() ? 'monitor-no-match' : 'monitor-empty-group'">
          {{ query.trim() ? t("monitor.searchNoMatch") : t("monitor.emptyGroup") }}
        </p>
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
.monitor-search {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.monitor-search-input {
  width: 9rem;
  font-size: 0.75rem;
  padding: 0.2rem 1.4rem 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--foreground);
}
.monitor-search-input::placeholder { opacity: 0.55; }
.monitor-search-clear {
  position: absolute;
  right: 0.25rem;
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 0;
}
.monitor-search-clear:hover { color: var(--foreground); }
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
