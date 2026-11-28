<script setup lang="ts">
// DockerStatsBar（B2）：容器指标汇总条——CPU / 内存 / 网络速率 / 块 IO / PIDs。
// 只渲染 props（快照由 DockerPanel 经 useDockerStats 轮询），无 RPC、无状态。
// 数据不可用（旧 sidecar、CLI 缺失、daemon 拒绝）时退回一行提示而不是占位空条。
import { computed } from "vue";
import {
  aggregateDockerStats,
  dockerStatsSeries,
  formatBytes,
  formatPercent,
  formatRate,
  type DockerStatsPoint,
  type DockerStatsSnapshot,
} from "../lib/dockerStats";
import { sparklinePath } from "../lib/metricsSparkline";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 已归一化的 docker/stats 快照（rate 字段已解析）。 */
  snapshot: DockerStatsSnapshot;
  /** 面板打开期间的总体趋势（useDockerStats.history）；< 2 点不画。 */
  history?: readonly DockerStatsPoint[];
  /** 轮询失败文案（空串 = 正常）。 */
  error?: string;
}>();

const totals = computed(() => aggregateDockerStats(props.snapshot.stats));
const visible = computed(
  () => Boolean(props.error) || (props.snapshot.available && props.snapshot.stats.length > 0),
);

/** 三条趋势线：CPU/MEM 用 0–100% 固定上限，网络按窗口内峰值。 */
const SPARK_WIDTH = 56;
const SPARK_HEIGHT = 14;
const trend = computed(() => {
  const points = props.history ?? [];
  if (points.length < 2) return null;
  return {
    cpu: sparklinePath(dockerStatsSeries(points, "cpuPercent"), SPARK_WIDTH, SPARK_HEIGHT, 100),
    mem: sparklinePath(dockerStatsSeries(points, "memPercent"), SPARK_WIDTH, SPARK_HEIGHT, 100),
    net: sparklinePath(dockerStatsSeries(points, "netBytesPerSec"), SPARK_WIDTH, SPARK_HEIGHT),
  };
});
</script>

<template>
  <div v-if="visible" class="docker-stats-bar" :title="props.error || undefined">
    <span class="docker-stats-title">{{ props.t("docker.statsTitle") }}</span>
    <span v-if="props.error" class="docker-stats-error">{{ props.t("docker.statsUnavailable") }}</span>
    <template v-else>
      <span class="docker-stats-chip">
        CPU {{ formatPercent(totals.cpuPercent) }}
        <svg
          v-if="trend"
          class="docker-stats-spark"
          :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
          aria-hidden="true"
          data-test="docker-stats-spark-cpu"
        ><polyline :points="trend.cpu" /></svg>
      </span>
      <span class="docker-stats-chip">
        MEM {{ formatBytes(totals.memBytes) }} / {{ formatBytes(totals.memLimitBytes) }}
        · {{ formatPercent(totals.memPercent) }}
        <svg
          v-if="trend"
          class="docker-stats-spark"
          :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
          aria-hidden="true"
          data-test="docker-stats-spark-mem"
        ><polyline :points="trend.mem" /></svg>
      </span>
      <span class="docker-stats-chip">
        NET ↓ {{ formatRate(totals.netRxRate) }} ↑ {{ formatRate(totals.netTxRate) }}
        <svg
          v-if="trend"
          class="docker-stats-spark"
          :viewBox="`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`"
          aria-hidden="true"
          data-test="docker-stats-spark-net"
        ><polyline :points="trend.net" /></svg>
      </span>
      <span class="docker-stats-chip">
        IO {{ formatBytes(totals.blockReadBytes) }} / {{ formatBytes(totals.blockWriteBytes) }}
      </span>
      <span class="docker-stats-chip">PIDs {{ totals.pids }}</span>
    </template>
  </div>
</template>

<style scoped>
.docker-stats-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.75rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  border-radius: 6px;
  background: color-mix(in srgb, var(--foreground, #888) 4%, transparent);
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--foreground, #ccc) 82%, transparent);
}

.docker-stats-title {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.75;
}

.docker-stats-chip {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* 趋势线：宽度固定 56px，随 chip 内文对齐；描边走 currentColor 跟随主题。 */
.docker-stats-spark {
  width: 3.5rem;
  height: 0.9rem;
  margin-left: 0.3rem;
  vertical-align: text-bottom;
  opacity: 0.8;
}

.docker-stats-spark polyline {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.docker-stats-error {
  color: color-mix(in srgb, var(--destructive, #e5484d) 85%, transparent);
}
</style>
