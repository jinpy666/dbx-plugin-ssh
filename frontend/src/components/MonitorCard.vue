<script lang="ts">
// 监控卡片（DESIGN_MONITOR_PANEL / 计划 §4-B5）：单台服务器的五态徽标 +
// 三条 gap 分段 sparkline（CPU/内存/网络，B2 sparklineSegments）+ 实时值 +
// 可折叠详情 + 头部动作（加入/移出监控开关、已连接时的终端按钮）。
// 纯展示组件：数据与动作全部经 props/emits，编排（轮询/收敛/持久化）在
// useMonitorPanel。组头色板与序列转换从这里导出（面板分组头复用）。
import type { MonitorGap, MonitorHistoryEntry, MonitorSample } from "../lib/monitorProtocol";

/** 组头色板（8 色，FNV-1a hash % 8 取色）：同组 id 恒定同色，组间尽量散开。 */
export const GROUP_COLOR_PALETTE: readonly string[] = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#64748b",
];

/** FNV-1a 32-bit hash：groupId → 色板下标。纯函数，便于单测断言稳定取色。 */
export function groupColorIndex(groupId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < groupId.length; i += 1) {
    hash ^= groupId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % GROUP_COLOR_PALETTE.length;
}

/**
 * history（Sample|Gap 混合）→ 数值序列 + gap 并行标记（sparklineSegments 的
 * 输入形状）：Gap 位补 0 占位并打 true，跳线由 sparklineSegments 切段处理。
 */
export function historySeries(history: readonly MonitorHistoryEntry[], pick: (sample: MonitorSample) => number): { values: number[]; gaps: boolean[] } {
  const isGap = (entry: MonitorHistoryEntry): entry is MonitorGap => (entry as { gap?: unknown }).gap === true;
  const values: number[] = [];
  const gaps: boolean[] = [];
  for (const entry of history) {
    if (isGap(entry)) {
      values.push(0);
      gaps.push(true);
    } else {
      values.push(pick(entry));
      gaps.push(false);
    }
  }
  return { values, gaps };
}
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import { CheckCircle2, Loader2, PlusCircle, SquareTerminal } from "@lucide/vue";
import { sparklineSegments } from "../lib/metricsSparkline";
import type { MonitorConnectionRow, MonitorSnapshot, MonitorState } from "../lib/monitorProtocol";

const props = defineProps<{
  row: MonitorConnectionRow;
  snapshot: MonitorSnapshot | null;
  watched: boolean;
  /** 无任务且未 watched 时空串（占位叙事由 watched/connected 决定）。 */
  state: MonitorState | "";
  privacy: boolean;
  /** 隐私模式下的组内序号（1 起）。 */
  privacyIndex: number;
  t: (key: string) => string;
}>();

const emit = defineEmits<{
  (event: "toggle-watch", connectionId: string, on: boolean): void;
  (event: "open-terminal", row: MonitorConnectionRow): void;
  (event: "retry", connectionId: string): void;
}>();

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;
/** 卡片曲线窗口 = snapshot history 尾部（协议默认 points=120，与轮询一致）。 */
const SPARK_TAIL = 120;

const BADGE_KEY: Record<MonitorState, string> = {
  connecting: "monitor.badgeConnecting",
  live: "monitor.badgeLive",
  failed: "monitor.badgeFailed",
  unsupported: "monitor.badgeUnsupported",
  stopped: "monitor.badgeStopped",
};

const connected = computed(() => props.row.connected === true || props.row.isConnected === true);
const displayName = computed(() => (props.privacy ? `#${props.privacyIndex}` : props.row.name));
const badgeKey = computed(() => (props.state && props.state in BADGE_KEY ? BADGE_KEY[props.state as MonitorState] : ""));
const details = computed(() => props.snapshot?.details ?? null);
const detailsExpanded = ref(false);

const tail = computed(() => (props.snapshot?.history ?? []).slice(-SPARK_TAIL));
const cpuSeries = computed(() => historySeries(tail.value, (entry) => entry.cpuPct));
const memSeries = computed(() => historySeries(tail.value, (entry) => (entry.memTotalMb > 0 ? (entry.memUsedMb / entry.memTotalMb) * 100 : 0)));
const netSeries = computed(() => historySeries(tail.value, (entry) => entry.netRxKbps + entry.netTxKbps));
const cpuSegments = computed(() => sparklineSegments(cpuSeries.value.values, cpuSeries.value.gaps, SPARK_WIDTH, SPARK_HEIGHT));
const memSegments = computed(() => sparklineSegments(memSeries.value.values, memSeries.value.gaps, SPARK_WIDTH, SPARK_HEIGHT));
const netSegments = computed(() => sparklineSegments(netSeries.value.values, netSeries.value.gaps, SPARK_WIDTH, SPARK_HEIGHT));

const liveValues = computed(() => {
  const live = props.snapshot?.live ?? null;
  if (!live) return { cpu: "—", mem: "—", net: "—" };
  return {
    cpu: `${live.cpuPct.toFixed(1)}%`,
    mem: `${Math.round(live.memUsedMb)}/${Math.round(live.memTotalMb)} MB`,
    net: `${live.netRxKbps.toFixed(1)}/${live.netTxKbps.toFixed(1)} KiB/s`,
  };
});

const seriesRows = computed(() => [
  { metric: "cpu", label: props.t("monitor.cpu"), segments: cpuSegments.value, value: liveValues.value.cpu },
  { metric: "mem", label: props.t("monitor.memory"), segments: memSegments.value, value: liveValues.value.mem },
  { metric: "net", label: props.t("monitor.network"), segments: netSegments.value, value: liveValues.value.net },
]);

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
</script>

<template>
  <article class="monitor-card" :class="{ 'monitor-card--dimmed': state === 'failed' }" :data-connection-id="row.id" :data-state="state || 'idle'">
    <header class="monitor-card-head">
      <strong class="monitor-card-name">{{ displayName }}</strong>
      <span v-if="badgeKey" class="monitor-badge" :data-state="state">{{ t(badgeKey) }}</span>
      <span class="monitor-card-spacer" aria-hidden="true"></span>
      <!-- 开关收敛为单一 icon-toggle：on=实色勾（title 承载移出文案），off=线框加号 -->
      <button
        type="button"
        class="monitor-icon-btn monitor-watch-btn"
        :class="{ 'is-on': watched }"
        :aria-pressed="watched"
        :aria-label="watched ? t('monitor.removeWatch') : t('monitor.addWatch')"
        :title="watched ? t('monitor.removeWatch') : t('monitor.addWatch')"
        @click="emit('toggle-watch', row.id, !watched)"
      >
        <CheckCircle2 v-if="watched" :size="15" aria-hidden="true" />
        <PlusCircle v-else :size="15" aria-hidden="true" />
      </button>
      <button
        v-if="connected"
        type="button"
        class="monitor-icon-btn"
        :aria-label="t('monitor.openTerminal')"
        :title="t('monitor.openTerminal')"
        @click="emit('open-terminal', row)"
      >
        <SquareTerminal :size="15" aria-hidden="true" />
      </button>
    </header>

    <!-- 未连接：灰色占位替代 sparkline 区（开关在头部，说明落位） -->
    <div v-if="!connected" class="monitor-placeholder">
      <p class="monitor-placeholder-text">{{ t("monitor.sessionClosed") }}</p>
    </div>

    <!-- 不支持：说明文案占位（任务存在但无计数器来源） -->
    <div v-else-if="state === 'unsupported'" class="monitor-placeholder">
      <p class="monitor-placeholder-text">{{ t("monitor.badgeUnsupported") }}</p>
    </div>

    <!-- 已连接、采集尚未起表（自动采集在途/watched 声明待首跑）：连接中叙事占位。
         自动采集下该状态只在 start 前一瞬；持续停留 = start 失败（状态徽标会转 failed）。 -->
    <div v-else-if="!watched && !state" class="monitor-placeholder">
      <Loader2 class="monitor-placeholder-spin" :size="16" aria-hidden="true" />
      <p class="monitor-placeholder-text">{{ t("monitor.badgeConnecting") }}</p>
    </div>

    <template v-else>
      <div class="monitor-series-list">
        <div v-for="series in seriesRows" :key="series.metric" class="monitor-series">
          <span class="monitor-series-label">{{ series.label }}</span>
          <svg
            class="monitor-series-spark"
            :data-metric="series.metric"
            :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline v-for="(points, index) in series.segments" :key="index" :points="points" />
          </svg>
          <span class="monitor-series-value">{{ series.value }}</span>
        </div>
      </div>

      <div class="monitor-card-foot">
        <button
          v-if="state === 'failed'"
          type="button"
          class="monitor-chip-btn monitor-retry-btn"
          @click="emit('retry', row.id)"
        >
          {{ t("monitor.retry") }}
        </button>
        <span class="monitor-card-spacer" aria-hidden="true"></span>
        <button type="button" class="monitor-chip-btn" :aria-expanded="detailsExpanded" @click="detailsExpanded = !detailsExpanded">
          {{ t("monitor.details") }}
        </button>
      </div>

      <dl v-if="detailsExpanded" class="monitor-details">
        <div class="monitor-details-row">
          <dt>{{ t("monitor.detailsLoad") }}</dt>
          <dd v-if="details">{{ details.load1.toFixed(2) }} / {{ details.load5.toFixed(2) }} / {{ details.load15.toFixed(2) }}</dd>
          <dd v-else>—</dd>
        </div>
        <div class="monitor-details-row">
          <dt>{{ t("monitor.detailsUptime") }}</dt>
          <dd v-if="details">{{ formatUptime(details.uptimeSec) }}</dd>
          <dd v-else>—</dd>
        </div>
        <div class="monitor-details-row">
          <dt>{{ t("monitor.detailsDisks") }}</dt>
          <dd v-if="details">
            <span v-for="disk in details.disks" :key="disk.mount" class="monitor-details-item">
              {{ disk.mount }} {{ disk.totalKb > 0 ? Math.round((disk.usedKb / disk.totalKb) * 100) : 0 }}%
            </span>
            <span v-if="!details.disks.length">—</span>
          </dd>
          <dd v-else>—</dd>
        </div>
        <div class="monitor-details-row">
          <dt>{{ t("monitor.detailsUsers") }}</dt>
          <dd v-if="details">
            <span v-for="(user, index) in details.users" :key="`${user.user}-${index}`" class="monitor-details-item">
              {{ user.user }} ({{ user.tty }}, {{ user.from }})
            </span>
            <span v-if="!details.users.length">—</span>
          </dd>
          <dd v-else>—</dd>
        </div>
      </dl>
    </template>
  </article>
</template>

<style scoped>
.monitor-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  background: var(--card, transparent);
  min-width: 0;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
}
.monitor-card:hover {
  border-color: var(--muted-foreground);
  box-shadow: 0 1px 6px rgb(0 0 0 / 0.18);
}
.monitor-card--dimmed {
  opacity: 0.55;
}
.monitor-card-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.monitor-card-name {
  font-size: 0.8125rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-card-spacer {
  flex: 1;
}
.monitor-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.6875rem;
  line-height: 1;
  padding: 0.25rem 0.5rem 0.25rem 0.4rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
}
/* 状态点：live 绿 + 呼吸脉冲；failed 红；connecting 黄 + 闪烁。 */
.monitor-badge::before {
  content: "";
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: currentColor;
  flex: none;
}
.monitor-badge[data-state="live"] {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 45%, transparent);
}
.monitor-badge[data-state="live"]::before {
  animation: monitor-pulse 2s ease-in-out infinite;
}
.monitor-badge[data-state="failed"] {
  color: var(--destructive);
  border-color: color-mix(in srgb, var(--destructive) 45%, transparent);
}
.monitor-badge[data-state="connecting"] {
  color: var(--warning, #eab308);
  border-color: color-mix(in srgb, var(--warning, #eab308) 45%, transparent);
}
.monitor-badge[data-state="connecting"]::before {
  animation: monitor-blink 1.1s ease-in-out infinite;
}
@keyframes monitor-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@keyframes monitor-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
}
.monitor-icon-btn {
  flex: none;
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
.monitor-icon-btn.is-on {
  color: var(--primary);
}
.monitor-icon-btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.monitor-chip-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
  background: transparent;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.monitor-chip-btn:hover {
  color: var(--foreground);
  border-color: var(--muted-foreground);
}
.monitor-chip-btn[aria-pressed="true"] {
  color: var(--primary);
  border-color: var(--primary);
}
.monitor-chip-btn[aria-expanded="true"] {
  color: var(--foreground);
  border-color: var(--muted-foreground);
}
.monitor-retry-btn {
  color: var(--destructive);
  border-color: var(--destructive);
}
.monitor-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 64px;
  padding: 0.5rem;
  border: 1px dashed var(--border);
  border-radius: 6px;
  background: var(--muted);
}
.monitor-placeholder-spin {
  color: var(--muted-foreground);
  animation: monitor-spin 1.2s linear infinite;
}
@keyframes monitor-spin {
  to {
    transform: rotate(360deg);
  }
}
.monitor-placeholder-text {
  margin: 0;
  font-size: 0.75rem;
  color: var(--muted-foreground);
  text-align: center;
}
.monitor-series-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.monitor-series {
  display: grid;
  grid-template-columns: 3.25rem 1fr 6.5rem;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  border-radius: 4px;
  padding: 0 0.25rem;
  transition: background-color 0.15s ease;
}
.monitor-series:hover {
  background: var(--muted);
}
.monitor-series-label {
  font-size: 0.6875rem;
  color: var(--muted-foreground);
}
.monitor-series-spark {
  display: block;
  width: 100%;
  height: 26px;
}
.monitor-series-spark polyline {
  fill: none;
  stroke: var(--primary);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.monitor-series-spark[data-metric="mem"] polyline {
  stroke: var(--success);
}
.monitor-series-spark[data-metric="net"] polyline {
  stroke: var(--warning, var(--muted-foreground));
}
.monitor-series-value {
  font-size: 0.6875rem;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.monitor-card-foot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.monitor-details {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.6875rem;
  color: var(--muted-foreground);
}
.monitor-details-row {
  display: grid;
  grid-template-columns: 5.5rem 1fr;
  gap: 0.5rem;
  min-width: 0;
}
.monitor-details-row dd {
  margin: 0;
  min-width: 0;
}
.monitor-details-item {
  display: inline-block;
  margin-right: 0.5rem;
}
</style>
