<script setup lang="ts">
// DockerStatsBar（B2）：容器指标汇总条——CPU / 内存 / 网络速率 / 块 IO / PIDs。
// 只渲染 props（快照由 DockerPanel 经 useDockerStats 轮询），无 RPC、无状态。
// 数据不可用（旧 sidecar、CLI 缺失、daemon 拒绝）时退回一行提示而不是占位空条。
import { computed } from "vue";
import {
  aggregateDockerStats,
  formatBytes,
  formatPercent,
  formatRate,
  type DockerStatsSnapshot,
} from "../lib/dockerStats";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  /** 已归一化的 docker/stats 快照（rate 字段已解析）。 */
  snapshot: DockerStatsSnapshot;
  /** 轮询失败文案（空串 = 正常）。 */
  error?: string;
}>();

const totals = computed(() => aggregateDockerStats(props.snapshot.stats));
const visible = computed(
  () => Boolean(props.error) || (props.snapshot.available && props.snapshot.stats.length > 0),
);
</script>

<template>
  <div v-if="visible" class="docker-stats-bar" :title="props.error || undefined">
    <span class="docker-stats-title">{{ props.t("docker.statsTitle") }}</span>
    <span v-if="props.error" class="docker-stats-error">{{ props.t("docker.statsUnavailable") }}</span>
    <template v-else>
      <span class="docker-stats-chip">CPU {{ formatPercent(totals.cpuPercent) }}</span>
      <span class="docker-stats-chip">
        MEM {{ formatBytes(totals.memBytes) }} / {{ formatBytes(totals.memLimitBytes) }}
        · {{ formatPercent(totals.memPercent) }}
      </span>
      <span class="docker-stats-chip">
        NET ↓ {{ formatRate(totals.netRxRate) }} ↑ {{ formatRate(totals.netTxRate) }}
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

.docker-stats-error {
  color: color-mix(in srgb, var(--destructive, #e5484d) 85%, transparent);
}
</style>
