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
  snapshots,
  watched,
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

function matchesFilter(state: PanelCardState | ""): boolean {
  if (statusFilter.value === "all") return true;
  if (statusFilter.value === "live") return state === "live";
  return state === "failed" || state === "unsupported";
}

const groups = computed<MonitorGroupView[]>(() => {
  const rows = connections.value;
  // Phase 1 降级：任一行都不带 groupId → 单一平铺区。
  if (!rows.some((row) => typeof row.groupId === "string" && row.groupId)) {
    return [{ id: "", name: "", rows }];
  }
  // 组序 = 数组首次出现序；无 groupId 的行落入尾部平铺桶（不渲染组头）。
  const order: string[] = [];
  const names = new Map<string, string>();
  const byGroup = new Map<string, MonitorConnectionRow[]>();
  for (const row of rows) {
    const groupId = typeof row.groupId === "string" && row.groupId ? row.groupId : "";
    if (!byGroup.has(groupId)) {
      byGroup.set(groupId, []);
      order.push(groupId);
    }
    if (!names.has(groupId) && typeof row.groupName === "string" && row.groupName) names.set(groupId, row.groupName);
    byGroup.get(groupId)!.push(row);
  }
  return order.map((groupId) => ({ id: groupId, name: names.get(groupId) ?? groupId, rows: byGroup.get(groupId)! }));
});

function cardEntries(group: MonitorGroupView): MonitorCardEntry[] {
  const entries: MonitorCardEntry[] = [];
  // 隐私模式下的组内序号（1 起，按筛选后的可见序）。
  let ordinal = 0;
  for (const row of group.rows) {
    const state = stateOf(row);
    if (!matchesFilter(state)) continue;
    ordinal += 1;
    entries.push({ row, privacyIndex: ordinal, state, watched: !!watched.value[row.id] });
  }
  return entries;
}

function groupAccent(group: MonitorGroupView): string {
  return GROUP_COLOR_PALETTE[groupColorIndex(group.id)];
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

    <!-- 连续 3 次快照失败后轮询自停：横幅即恢复按钮（refresh 会清 pollStopped） -->
    <button v-if="pollStopped" type="button" class="monitor-banner" @click="() => refresh()">{{ t("monitor.pollStopped") }}</button>
    <p v-if="taskLimitReached" class="monitor-banner monitor-banner--error">{{ t("monitor.taskLimit") }}</p>

    <p v-if="!connections.length" class="monitor-empty">{{ t("monitor.noServers") }}</p>
    <!-- 空态诊断行（数据行，非文案）：两源结果与行数，截图即可定位宿主版本/字段问题 -->
    <p v-if="!connections.length" class="monitor-diag" data-testid="monitor-diag">
      listConnections: {{ listDiagnostics.listState }} ({{ listDiagnostics.listCount }}) · sessions: {{ dataSource === "sessions" ? "fallback" : dataSource }}
    </p>

    <template v-else>
      <section v-for="group in groups" :key="group.id || '__flat__'" class="monitor-group">
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
