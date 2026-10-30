<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Activity,
  ChevronRight,
  Clock3,
  Cpu,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Terminal as TerminalIcon,
  Wifi,
  X,
} from "@lucide/vue";
import GpuNpuMonitor from "./GpuNpuMonitor.vue";
import DockerWhaleLogo from "./DockerWhaleLogo.vue";
import { Progress } from "./ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import type { ServerMetrics } from "../composables/useMetricsPanel";
import type { DistroBadge } from "../lib/distroBadge";
import type { DiskMountView } from "../lib/metricsView";
import type { ProcessSortKey } from "../lib/processActions";
import { formatBytes, formatRate } from "../lib/format";
import { smoothSparklinePath } from "../lib/metricsSparkline";
import { workbenchMessage } from "../lib/i18n";

interface ProcessPanelRow {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  etime: string;
  state: string;
  command: string;
  fdCount?: number | null;
  listenPorts?: number[];
}

interface NetworkPanelRow {
  name: string;
  rxRate: number;
  txRate: number;
  rxTotal: number;
  txTotal: number;
}

type MetricsTab = "overview" | "processes" | "disks" | "network" | "docker";

const props = withDefaults(defineProps<{
  locale: string;
  modelValue: MetricsTab;
  metrics?: ServerMetrics;
  loading: boolean;
  error: string;
  distroBadge?: DistroBadge | null;
  endpoint?: string;
  live: boolean;
  refreshMs: number;
  samples: { rx: number[]; tx: number[]; cpu: number[]; mem: number[] };
  cpuSparkline: string;
  memSparkline: string;
  rxSparkline: string;
  disks: DiskMountView[];
  networks: NetworkPanelRow[];
  processesOpen: boolean;
  processCount: number;
  totalSortedCount: number;
  processLoading: boolean;
  processSortKey: ProcessSortKey;
  visibleProcessRows: ProcessPanelRow[];
  processCap: number;
}>(), { metrics: undefined, distroBadge: null, endpoint: "" });

const emit = defineEmits<{
  "update:modelValue": [value: MetricsTab];
  close: [];
  refresh: [];
  toggleLive: [];
  setRefreshMs: [value: number];
  toggleProcesses: [];
  refreshProcesses: [];
  setProcessSort: [key: ProcessSortKey];
  kill: [row: ProcessPanelRow, signal: 15 | 9];
}>();

const activeTab = ref<MetricsTab>(props.modelValue);
watch(() => props.modelValue, (value) => {
  if (value !== activeTab.value) activeTab.value = value;
});
const processQuery = ref("");
const processSortKeys: ProcessSortKey[] = ["cpu", "mem", "pid", "fd", "ports"];
const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);
const tabs = [
  { id: "overview" as const, label: "metricsOverview", icon: Activity },
  { id: "processes" as const, label: "metricsProcesses", icon: TerminalIcon },
  { id: "disks" as const, label: "metricsDisk", icon: HardDrive },
  { id: "network" as const, label: "metricsNetwork", icon: Wifi },
  { id: "docker" as const, label: "docker.toolbarTitle", icon: DockerWhaleLogo },
];

const cpuPercent = computed(() => Math.round(props.metrics?.cpu?.percent ?? 0));
const memoryPercent = computed(() => {
  const total = props.metrics?.memory?.totalBytes ?? 0;
  return total > 0 ? Math.round(((props.metrics?.memory?.usedBytes ?? 0) / total) * 100) : 0;
});
const primaryDisk = computed(() => props.disks[0]);
const netRx = computed(() => props.networks.reduce((sum, net) => sum + Math.max(0, net.rxRate ?? 0), 0));
const netTx = computed(() => props.networks.reduce((sum, net) => sum + Math.max(0, net.txRate ?? 0), 0));
const uptime = computed(() => {
  const seconds = props.metrics?.uptimeSeconds;
  if (seconds == null) return "";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t("uptimeDays", { count: days, hours });
  if (hours > 0) return t("uptimeHours", { count: hours, minutes });
  return t("uptimeMinutes", { count: minutes });
});
const filteredProcesses = computed(() => {
  const query = processQuery.value.trim().toLowerCase();
  if (!query) return props.visibleProcessRows;
  return props.visibleProcessRows.filter((row) => `${row.pid} ${row.user} ${row.command}`.toLowerCase().includes(query));
});

function gaugeOffset(percent: number) {
  const circumference = 2 * Math.PI * 18;
  return circumference - (Math.max(0, Math.min(100, percent)) / 100) * circumference;
}

function selectTab(tab: MetricsTab) {
  activeTab.value = tab;
  emit("update:modelValue", tab);
  if (tab === "processes" && !props.processesOpen) emit("toggleProcesses");
}

function onSelectTab(value: string | number) {
  selectTab(value as MetricsTab);
}

function onSelectRefresh(value: unknown) {
  emit("setRefreshMs", Number(value));
}

function onSelectProcessSort(value: unknown) {
  const key = String(value) as ProcessSortKey;
  if (processSortKeys.includes(key)) emit("setProcessSort", key);
}

</script>

<template>
  <div class="metrics-panel">
    <header class="metrics-header">
      <div class="metrics-identity">
        <div class="metrics-title-row">
          <span class="metrics-live-dot" :class="{ paused: !live }" aria-hidden="true" />
          <span v-if="distroBadge" class="distro-badge" :style="{ backgroundColor: distroBadge.color }" :title="distroBadge.name">{{ distroBadge.label }}</span>
          <strong :title="metrics?.hostname || t('metrics')">{{ metrics?.hostname || t("metrics") }}</strong>
        </div>
        <div class="metrics-subtitle">
          <span>{{ endpoint || t("metrics") }}</span>
          <span v-if="uptime" class="metrics-uptime"><Clock3 :size="11" />{{ uptime }}</span>
        </div>
      </div>
      <div class="metrics-header-actions">
        <Select :model-value="refreshMs" @update:model-value="onSelectRefresh">
          <SelectTrigger class="metrics-interval" :title="t('metricsRefreshRate')" :aria-label="t('metricsRefreshRate')"><SelectValue placeholder="5s" /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="1000">1s</SelectItem>
            <SelectItem :value="2000">2s</SelectItem>
            <SelectItem :value="5000">5s</SelectItem>
          </SelectContent>
        </Select>
        <button class="icon-button" :class="{ 'metrics-resume': !live }" :title="t(live ? 'metricsPause' : 'metricsResume')" :aria-label="t(live ? 'metricsPause' : 'metricsResume')" @click="emit('toggleLive')">
          <Pause v-if="live" :size="13" />
          <Play v-else :size="13" />
        </button>
        <button class="icon-button" :title="t('close')" :aria-label="t('close')" @click="emit('close')"><X :size="14" /></button>
      </div>
    </header>

    <Tabs :model-value="activeTab" class="metrics-tabs" :aria-label="t('metrics')" @update:model-value="onSelectTab">
      <TabsList class="metrics-tabs-list">
        <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" class="metrics-tab-trigger">
          <component :is="tab.icon" :size="13" />
          <span>{{ t(tab.label) }}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <div class="metrics-content">
      <div v-if="loading && !metrics" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
      <p v-else-if="error" class="task-error">{{ error }} <button class="link-button" @click="emit('refresh')">{{ t("refresh") }}</button></p>

      <template v-else-if="metrics">
        <div v-if="activeTab === 'overview'" class="metrics-overview">
          <div class="metrics-summary-grid">
            <article class="metric-summary-card metric-cpu">
              <div class="metric-summary-main">
                <div class="metric-summary-copy">
                  <span class="metric-summary-label"><Cpu :size="12" />{{ t("metricsCpu") }}</span>
                  <strong :class="{ hot: cpuPercent >= 80 }">{{ cpuPercent }}%</strong>
                  <small>{{ metrics.cpu?.cores ?? "–" }} vCPU · {{ metrics.cpu?.load1 ?? "–" }}</small>
                </div>
                <div class="metric-gauge">
                  <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="metric-gauge-track" cx="22" cy="22" r="18" /><circle class="metric-gauge-value" cx="22" cy="22" r="18" stroke="var(--info)" :stroke-dashoffset="gaugeOffset(cpuPercent)" /></svg>
                  <span>{{ cpuPercent }}%</span>
                </div>
              </div>
              <svg v-if="cpuSparkline" class="metric-area" viewBox="0 0 120 18" preserveAspectRatio="none" aria-hidden="true">
                <path class="metric-area-fill" :d="smoothSparklinePath(cpuSparkline, 18)" />
                <path class="metric-area-line" :d="smoothSparklinePath(cpuSparkline)" />
              </svg>
            </article>

            <article class="metric-summary-card metric-memory">
              <div class="metric-summary-main">
                <div class="metric-summary-copy">
                  <span class="metric-summary-label"><Activity :size="12" />{{ t("metricsMemory") }}</span>
                  <strong>{{ memoryPercent }}%</strong>
                  <small v-if="metrics.memory?.totalBytes">{{ formatBytes(metrics.memory.usedBytes) }} / {{ formatBytes(metrics.memory.totalBytes) }}</small>
                </div>
                <div class="metric-gauge">
                  <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="metric-gauge-track" cx="22" cy="22" r="18" /><circle class="metric-gauge-value" cx="22" cy="22" r="18" stroke="var(--success)" :stroke-dashoffset="gaugeOffset(memoryPercent)" /></svg>
                  <span>{{ memoryPercent }}%</span>
                </div>
              </div>
              <small v-if="metrics.memory?.availableBytes != null" class="metric-memory-available">{{ t("metricsAvailable") }} {{ formatBytes(metrics.memory.availableBytes) }}</small>
            </article>

            <article class="metric-summary-card metric-disk">
              <div class="metric-summary-main">
                <div class="metric-summary-copy">
                  <span class="metric-summary-label"><HardDrive :size="12" />{{ t("metricsDisk") }}</span>
                  <strong :class="{ hot: (primaryDisk?.percentUsed ?? 0) >= 85 }">{{ primaryDisk ? Math.round(primaryDisk.percentUsed ?? 0) : "–" }}%</strong>
                  <small v-if="primaryDisk" :title="primaryDisk.mount">{{ primaryDisk.mount }} · {{ formatBytes(primaryDisk.usedBytes) }}</small>
                  <small v-else>–</small>
                </div>
                <div class="metric-gauge">
                  <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="metric-gauge-track" cx="22" cy="22" r="18" /><circle class="metric-gauge-value" cx="22" cy="22" r="18" stroke="var(--warning)" :stroke-dashoffset="gaugeOffset(primaryDisk?.percentUsed ?? 0)" /></svg>
                  <span>{{ primaryDisk ? Math.round(primaryDisk.percentUsed ?? 0) : "–" }}%</span>
                </div>
              </div>
              <button class="metric-detail-link" @click="selectTab('disks')">{{ t("metricsDisk") }}<ChevronRight :size="12" /></button>
            </article>

            <article class="metric-summary-card metric-network">
              <div class="metric-summary-label"><Wifi :size="12" />{{ t("metricsNetwork") }}</div>
              <div class="metric-network-rates">
                <strong>↓ {{ formatRate(netRx) }}</strong>
                <small>↑ {{ formatRate(netTx) }}</small>
              </div>
              <svg v-if="rxSparkline" class="metric-area" viewBox="0 0 60 18" preserveAspectRatio="none" aria-hidden="true">
                <path class="metric-area-fill" :d="smoothSparklinePath(rxSparkline, 18)" />
                <path class="metric-area-line" :d="smoothSparklinePath(rxSparkline)" />
              </svg>
            </article>
          </div>

          <section v-if="metrics.cpu?.corePercents?.length" class="metrics-core-card">
            <div class="metrics-detail-heading">
              <Cpu :size="14" /><strong>{{ t("metricsCoreCount", { count: metrics.cpu.corePercents.length }) }}</strong>
              <span>{{ cpuPercent }}%</span>
            </div>
            <div class="metrics-core-grid">
              <div v-for="(usage, index) in metrics.cpu.corePercents" :key="index" class="metrics-core-item">
                <div class="metrics-core-label"><span>C{{ index + 1 }}</span><strong>{{ usage.toFixed(1) }}%</strong></div>
                <Progress :value="usage" :tone="usage >= 80 ? 'warning' : 'info'" />
              </div>
            </div>
          </section>

          <section v-if="disks.length" class="metrics-overview-disks">
            <div class="metrics-detail-heading">
              <HardDrive :size="14" /><strong>{{ t("metricsDisk") }}</strong>
              <button class="metric-detail-link" @click="selectTab('disks')"><ChevronRight :size="12" /></button>
            </div>
            <article v-for="disk in disks.slice(0, 3)" :key="disk.mount" class="metrics-detail-row">
              <div class="metrics-detail-line">
                <strong class="mono" :title="disk.mount">{{ disk.mount }}</strong>
                <span class="numeric">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }} · {{ Math.round(disk.percentUsed ?? 0) }}%</span>
              </div>
              <Progress :value="Math.min(100, disk.percentUsed ?? 0)" :tone="(disk.percentUsed ?? 0) >= 85 ? 'danger' : 'info'" />
            </article>
          </section>

          <GpuNpuMonitor :locale="locale" :gpu="metrics.gpu" :npu="metrics.npu" />
        </div>

        <section v-else-if="activeTab === 'processes'" class="metrics-process-page">
          <div class="metrics-section-toolbar">
            <div class="metrics-process-title"><strong>{{ t("procTitle", { count: processCount }) }}</strong></div>
            <div class="metrics-process-tools">
              <Select :model-value="processSortKey" @update:model-value="onSelectProcessSort">
                <SelectTrigger class="proc-sort-select"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem v-for="key in processSortKeys" :key="key" :value="key">{{ t(`procSort.${key}`) }}</SelectItem></SelectContent>
              </Select>
              <label class="metrics-search">
                <Search :size="12" />
                <input v-model="processQuery" type="search" :placeholder="t('metricsSearchProc')" :aria-label="t('metricsSearchProc')" />
              </label>
              <button class="icon-button" :title="t('refresh')" :aria-label="t('refresh')" @click="emit('refreshProcesses')"><RefreshCw :size="12" /></button>
            </div>
          </div>
          <div v-if="processLoading && !visibleProcessRows.length" class="empty compact"><Loader2 class="spinning" />{{ t("loading") }}</div>
          <div v-else-if="!filteredProcesses.length" class="empty compact">{{ t("procEmpty") }}</div>
          <div v-else class="metrics-proc-table">
            <Table class="process-table">
              <colgroup><col class="process-col-pid" /><col class="process-col-user" /><col class="process-col-cpu" /><col class="process-col-mem" /><col class="process-col-etime" /><col class="process-col-fd" /><col class="process-col-ports" /><col /><col class="process-col-actions" /></colgroup>
              <TableHeader><TableRow class="process-head">
                <TableHead>{{ t("metricsProcPid") }}</TableHead><TableHead>{{ t("metricsProcUser") }}</TableHead><TableHead class="numeric">{{ t("metricsProcCpu") }}</TableHead><TableHead class="numeric">{{ t("metricsProcMem") }}</TableHead><TableHead>{{ t("procEtime") }}</TableHead><TableHead class="numeric">{{ t("procFd") }}</TableHead><TableHead>{{ t("procPorts") }}</TableHead><TableHead>{{ t("metricsProcCommand") }}</TableHead><TableHead class="process-actions-cell">{{ t("docker.colActions") }}</TableHead>
              </TableRow></TableHeader>
              <TableBody><TableRow v-for="proc in filteredProcesses" :key="proc.pid" class="process-row">
                <TableCell class="mono">{{ proc.pid }}</TableCell><TableCell class="mono">{{ proc.user }}</TableCell>
                <TableCell class="numeric" :class="{ 'proc-hot': proc.cpuPercent >= 50 }">{{ proc.cpuPercent }}%</TableCell>
                <TableCell class="numeric" :class="{ 'proc-hot': proc.memPercent >= 30 }">{{ proc.memPercent }}%</TableCell>
                <TableCell class="mono">{{ proc.etime }}</TableCell><TableCell class="numeric mono">{{ proc.fdCount ?? "—" }}</TableCell>
                <TableCell class="mono process-ports" :title="proc.listenPorts?.join(', ')">{{ proc.listenPorts?.length ? proc.listenPorts.join(", ") : "—" }}</TableCell>
                <TableCell class="mono process-command" :title="proc.command">{{ proc.command }}</TableCell>
                <TableCell class="process-actions-cell"><span class="proc-kill-group"><button class="link-button" @click="emit('kill', proc, 15)">{{ t("procKill") }}</button><button class="link-button proc-kill-force" @click="emit('kill', proc, 9)">{{ t("procKillForce") }}</button></span></TableCell>
              </TableRow></TableBody>
            </Table>
          </div>
          <p v-if="totalSortedCount > processCap" class="metrics-hint muted">{{ t("procCapped", { shown: visibleProcessRows.length, total: totalSortedCount }) }}</p>
        </section>

        <section v-else-if="activeTab === 'disks'" class="metrics-detail-page">
          <div class="metrics-detail-heading"><HardDrive :size="14" /><strong>{{ t("metricsDisk") }}</strong><span>{{ disks.length }}</span></div>
          <div v-if="!disks.length" class="empty compact">–</div>
          <article v-for="disk in disks" :key="disk.mount" class="metrics-detail-row">
            <div class="metrics-detail-line">
              <strong class="mono" :title="disk.mount">{{ disk.mount }}</strong>
              <span class="numeric">{{ formatBytes(disk.usedBytes) }} / {{ formatBytes(disk.totalBytes) }} · {{ Math.round(disk.percentUsed ?? 0) }}%</span>
            </div>
            <Progress :value="Math.min(100, disk.percentUsed ?? 0)" :tone="(disk.percentUsed ?? 0) >= 85 ? 'danger' : 'info'" />
          </article>
        </section>

        <section v-else-if="activeTab === 'network'" class="metrics-detail-page">
          <div class="metrics-detail-heading"><Wifi :size="14" /><strong>{{ t("metricsNetwork") }}</strong><span>{{ networks.length }}</span></div>
          <div v-if="!networks.length" class="empty compact">–</div>
          <article v-for="net in networks" :key="net.name" class="metrics-detail-row">
            <div class="metrics-detail-line">
              <strong class="mono" :title="net.name">{{ net.name }}</strong>
              <span class="numeric"><span class="network-rx">↓ {{ formatRate(net.rxRate) }}</span> · <span class="network-tx">↑ {{ formatRate(net.txRate) }}</span></span>
            </div>
            <small class="muted mono">RX {{ formatBytes(net.rxTotal) }} · TX {{ formatBytes(net.txTotal) }}</small>
          </article>
        </section>

        <section v-else class="metrics-docker-page">
          <slot name="docker" />
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.metrics-panel { --metrics-card-radius: 12px; display: flex; min-height: 0; flex: 1; flex-direction: column; color: var(--foreground); }
.metrics-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 10px; }
.metrics-identity { min-width: 0; }
.metrics-title-row { display: flex; min-width: 0; align-items: center; gap: 8px; }
.metrics-title-row strong { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.metrics-live-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 12%, transparent); }
.metrics-live-dot.paused { background: var(--muted-foreground); box-shadow: none; }
.metrics-subtitle { display: flex; align-items: center; gap: 10px; margin-top: 5px; padding-left: 15px; color: var(--muted-foreground); font-size: 11px; }
.metrics-uptime { display: inline-flex; align-items: center; gap: 4px; }
.metrics-header-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
.metrics-header-actions .icon-button { width: 28px; height: 28px; }
.metrics-resume { color: var(--primary); background: color-mix(in srgb, var(--primary) 10%, transparent); }
.metrics-interval { height: 28px; border: 1px solid var(--border); border-radius: var(--metrics-card-radius); padding: 0 6px; background: var(--background); color: var(--muted-foreground); font: 11px var(--terminal-font-family); outline: none; }
.metrics-tabs { flex: 0 0 auto; margin: 0 18px 14px; }
.metrics-tabs-list { display: flex; width: 100%; height: auto; min-height: 42px; gap: 4px; padding: 4px; border: 1px solid color-mix(in srgb, var(--border) 75%, transparent); border-radius: var(--metrics-card-radius); background: color-mix(in srgb, var(--muted) 34%, transparent); }
.metrics-tabs button { display: flex; min-width: 0; height: 32px; flex: 1 1 0; align-items: center; justify-content: center; gap: 5px; border: 1px solid transparent; border-radius: calc(var(--metrics-card-radius) - 2px); padding: 0 10px; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 12px; transition: none; white-space: nowrap; }
.metrics-tabs button :deep(svg) { width: 14px; height: 14px; flex: 0 0 14px; }
.metrics-tabs .metrics-tab-trigger:not([data-state="active"]) { color: var(--muted-foreground); background: transparent; box-shadow: none; font-weight: 400; }
.metrics-tabs .metrics-tab-trigger:hover { color: var(--foreground); background: color-mix(in srgb, var(--accent) 60%, transparent); }
.metrics-tabs .metrics-tab-trigger[data-state="active"] { border-color: transparent; color: var(--primary-foreground); background: color-mix(in srgb, var(--primary) 82%, transparent); box-shadow: none; font-weight: 600; }
.metrics-content { min-height: 0; flex: 1; overflow: auto; padding: 0 18px 18px; }
.metrics-overview { display: flex; flex-direction: column; gap: 14px; }
.metrics-summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.metric-summary-card { --metric-accent: var(--info); display: flex; min-width: 0; min-height: 152px; flex-direction: column; justify-content: space-between; gap: 10px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius: var(--metrics-card-radius); padding: 14px; background: color-mix(in srgb, var(--muted) 30%, transparent); }
.metric-cpu { --metric-accent: var(--info); }
.metric-memory { --metric-accent: var(--success); }
.metric-disk { --metric-accent: var(--warning); }
.metric-network { --metric-accent: #a855f7; }
.metric-summary-main { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 8px; }
.metric-summary-copy { display: flex; min-width: 0; flex-direction: column; gap: 7px; }
.metric-summary-label { display: flex; align-items: center; gap: 5px; color: var(--muted-foreground); font-size: 11px; font-weight: 550; }
.metric-summary-label :deep(svg) { color: var(--metric-accent); }
.metric-summary-copy strong { color: var(--metric-accent); font-size: 27px; font-weight: 700; line-height: 1.05; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.metric-summary-copy small { overflow: hidden; color: var(--muted-foreground); font-family: var(--terminal-font-family); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.metric-summary-copy strong.hot { color: var(--warning); }
.metric-gauge { position: relative; display: flex; width: 56px; height: 56px; flex: 0 0 56px; align-items: center; justify-content: center; }
.metric-gauge svg { width: 56px; height: 56px; transform: rotate(-90deg); }
.metric-gauge circle { fill: none; stroke-width: 3.5; }
.metric-gauge-track { stroke: color-mix(in srgb, var(--muted-foreground) 15%, transparent); }
.metric-gauge-value { stroke: var(--metric-accent); stroke-dasharray: 113.097; stroke-linecap: round; transition: stroke-dashoffset 400ms ease; }
.metric-gauge > span { position: absolute; font-family: var(--terminal-font-family); font-size: 9px; font-weight: 700; }
.metric-area { display: block; width: 100%; height: 42px; overflow: visible; }
.metric-area-line { fill: none; stroke: var(--metric-accent); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.metric-area-fill { fill: color-mix(in srgb, var(--metric-accent) 18%, transparent); stroke: none; }
.metric-memory-available { color: var(--muted-foreground); font-family: var(--terminal-font-family); font-size: 10px; }
.metric-network-rates { display: flex; flex-direction: column; gap: 6px; }
.metric-network-rates strong { overflow: hidden; color: var(--metric-accent); font-size: 20px; font-weight: 700; letter-spacing: -0.02em; text-overflow: ellipsis; white-space: nowrap; }
.metric-network-rates small { color: var(--info); font-family: var(--terminal-font-family); font-size: 10px; }
.network-rx { color: #a855f7; }
.network-tx { color: var(--info); }
.metric-detail-link { display: flex; align-items: center; justify-content: space-between; border: 0; padding: 0; background: transparent; color: var(--muted-foreground); cursor: pointer; font-size: 10px; }
.metric-detail-link:hover { color: var(--primary); }
.metrics-core-card, .metrics-overview-disks { display: flex; flex-direction: column; gap: 10px; border: 1px solid color-mix(in srgb, var(--border) 78%, transparent); border-radius: var(--metrics-card-radius); padding: 12px 14px; background: color-mix(in srgb, var(--muted) 26%, transparent); }
.metrics-core-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 24px; }
.metrics-core-item { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.metrics-core-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted-foreground); font: 10px var(--terminal-font-family); }
.metrics-core-label strong { color: var(--foreground); font-weight: 600; }
.metrics-docker-page { display: flex; min-height: 0; flex: 1; overflow: hidden; }
.metrics-docker-page :deep(.docker-panel) { flex: 1; }
.metrics-section-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.metrics-section-toolbar > div { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.metrics-process-title { min-height: 30px; }
.metrics-process-title strong { font-size: 12px; }
.metrics-process-tools { gap: 6px !important; }
.metrics-process-tools > .icon-button { width: 28px; height: 28px; flex: 0 0 28px; }
.proc-sort-select { width: 92px; height: 30px; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; background: var(--background); box-shadow: none; font-size: 10px; }
.metrics-search { display: flex; width: min(190px, 50%); height: 30px; align-items: center; gap: 5px; border: 1px solid var(--border); border-radius: 10px; padding: 0 9px; background: var(--background); color: var(--muted-foreground); }
.metrics-search input { width: 100%; min-width: 0; border: 0; padding: 0; background: transparent; color: var(--foreground); font-size: 10px; outline: none; }
.metrics-proc-table { overflow-x: auto; border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: var(--metrics-card-radius); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--foreground) 25%, transparent) transparent; }
.metrics-proc-table::-webkit-scrollbar { display: block; width: 8px; height: 8px; }
.metrics-proc-table::-webkit-scrollbar-thumb { border-radius: 4px; background: color-mix(in srgb, var(--foreground) 25%, transparent); }
.metrics-proc-table::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--foreground) 40%, transparent); }
.metrics-proc-table::-webkit-scrollbar-track { background: transparent; }
.process-table { width: 100%; min-width: 900px; border-collapse: separate; border-spacing: 0; table-layout: fixed; background: var(--popover); }
.process-col-pid { width: 64px; }
.process-col-user { width: 80px; }
.process-col-cpu, .process-col-mem, .process-col-fd { width: 56px; }
.process-col-etime, .process-col-ports { width: 96px; }
.process-col-actions { width: 132px; }
.process-table th, .process-table td { padding: 0 8px; text-align: left; white-space: nowrap; }
.process-table th:first-child, .process-table td:first-child { padding-left: 12px; }
.process-table th:last-child, .process-table td:last-child { padding-right: 12px; }
.process-head { --process-row-bg: color-mix(in srgb, var(--muted) 35%, var(--popover)); }
.process-head th { height: 32px; border-bottom: 1px solid var(--border); background: var(--process-row-bg); color: var(--muted-foreground); font-size: 10px; }
.process-row { --process-row-bg: var(--popover); }
.process-row td { height: 36px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); background: var(--process-row-bg); font-size: 11px; }
.process-row:last-child td { border-bottom: 0; }
.process-row:hover { --process-row-bg: color-mix(in srgb, var(--accent) 45%, var(--popover)); }
.process-table .numeric { text-align: right; font-variant-numeric: tabular-nums; }
.process-actions-cell { position: sticky; right: 0; z-index: 2; background: var(--process-row-bg); box-shadow: -1px 0 0 var(--border); text-align: right; }
.proc-kill-group { display: flex; align-items: center; justify-content: flex-end; gap: 8px; white-space: nowrap; }
.proc-kill-force { color: var(--destructive); }
.process-command, .process-ports { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metrics-detail-page { display: flex; flex-direction: column; gap: 8px; }
.metrics-detail-heading { display: flex; align-items: center; gap: 6px; padding: 2px 0 6px; font-size: 12px; }
.metrics-detail-heading > span { margin-left: auto; color: var(--muted-foreground); font: 10px var(--terminal-font-family); }
.metrics-detail-row { display: flex; flex-direction: column; gap: 7px; border: 1px solid var(--border); border-radius: var(--metrics-card-radius); padding: 10px; background: color-mix(in srgb, var(--muted) 28%, transparent); }
.metrics-detail-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 10px; }
.metrics-detail-line > strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.metrics-detail-line > span { flex: 0 0 auto; }
.metrics-detail-row small { font-size: 9px; }
.metrics-hint { margin: 4px 0 0; font-size: 10px; }
.metrics-panel { container-type: inline-size; }
@container (max-width: 900px) {
  .metrics-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metrics-tabs { overflow-x: auto; }
  .metrics-tabs button { flex: 1 0 auto; }
}
@container (max-width: 640px) {
  .metrics-header { gap: 6px; padding: 12px 12px 8px; }
  .metrics-subtitle { padding-left: 0; }
  .metrics-tabs { margin: 0 12px 10px; }
  .metrics-tabs button { gap: 3px; padding: 0 9px; font-size: 10px; }
  .metrics-content { padding: 0 12px 12px; }
  .metrics-section-toolbar { align-items: center; flex-wrap: wrap; }
  .metrics-process-tools { min-width: 0; flex: 1; justify-content: flex-end; }
  .metrics-search { min-width: 120px; flex: 1; }
}
@container (max-width: 420px) {
  .metrics-summary-grid { grid-template-columns: 1fr; }
  .metric-summary-card { min-height: 132px; }
  .metrics-core-grid { grid-template-columns: 1fr; }
  .metrics-tabs button svg { display: none; }
}
</style>
