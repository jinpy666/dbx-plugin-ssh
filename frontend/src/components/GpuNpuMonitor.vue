<script setup lang="ts">
import { computed } from "vue";
import { workbenchMessage } from "../lib/i18n";
import { formatBytes } from "../lib/format";
import {
  acceleratorSectionsPresent,
  memoryPercent,
  type GpuInfoView,
  type GpuOverviewView,
  type NpuDeviceView,
  type NpuOverviewView,
} from "../lib/metricsGpuNpu";

// GPU / Ascend NPU 监控卡片（IMPL_PLAN Task P1-4）：跟随现有 metrics 轮询
// （App.vue 的 ssh/metrics 5s 刷新），本组件不建定时器。gpu/npu 键整体缺省
// （旧 sidecar）时整区隐藏；available=false 时显示弱化的"未检测到"提示；
// available 但无设备/字段缺省时分别落在空态与 "–" 占位上。

interface Props {
  locale: string;
  gpu?: GpuOverviewView;
  npu?: NpuOverviewView;
}

const props = defineProps<Props>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const visible = computed(() => acceleratorSectionsPresent(props.gpu, props.npu));
const gpuCards = computed(() => (props.gpu?.available ? props.gpu.gpus : []));
const npuCards = computed(() => (props.npu?.available ? props.npu.devices : []));
const npuCann = computed(() => (props.npu?.available ? props.npu.cann : null));

function memShare(used: number | null | undefined, total: number | null | undefined) {
  return memoryPercent(used, total) ?? 0;
}

function gpuTitle(card: GpuInfoView) {
  return card.name || `GPU ${card.index}`;
}

/** 数值占位：null 显示 "–"（N/A / [Not Supported] 字段的弱网降级形态）。 */
function trimNum(value: number) {
  return String(Math.round(value * 100) / 100);
}

function fmtPercent(value: number | null | undefined) {
  return value == null ? "–" : `${Math.round(value)}%`;
}

function fmtTemp(value: number | null | undefined) {
  return value == null ? "–" : `${Math.round(value)}°C`;
}

function fmtWatts(value: number | null | undefined) {
  return value == null ? "–" : `${trimNum(value)}W`;
}

function fmtGpuPower(card: GpuInfoView) {
  if (card.powerDraw == null) return "–";
  return card.powerLimit == null ? `${trimNum(card.powerDraw)}W` : `${trimNum(card.powerDraw)}/${trimNum(card.powerLimit)}W`;
}

function deviceKeyTitle(device: NpuDeviceView) {
  return device.name ? `${device.name} · ${device.deviceKey}` : device.deviceKey;
}
</script>

<template>
  <div v-if="visible" class="gpu-npu-section">
    <h3 class="settings-section-title">
      <span>{{ t("metricsGpu.title") }}</span>
      <span v-if="npuCann" class="mono gpu-npu-cann" :title="t('metricsNpu.cann')">CANN {{ npuCann }}</span>
    </h3>

    <!-- NVIDIA GPU：available 但无行落在空态文案上 -->
    <template v-if="gpu">
      <div v-if="gpuCards.length" class="gpu-npu-cards">
        <article v-for="card in gpuCards" :key="card.uuid || card.index" class="gpu-npu-card">
          <header class="gpu-npu-card-head">
            <strong class="gpu-npu-card-name" :title="gpuTitle(card)">{{ gpuTitle(card) }}</strong>
            <span v-if="card.pstate" class="mono gpu-npu-badge">{{ card.pstate }}</span>
          </header>
          <div class="gpu-npu-stats">
            <span class="gpu-npu-stat"><b>{{ fmtPercent(card.utilization) }}</b>{{ t("metricsGpu.utilization") }}</span>
            <span class="gpu-npu-stat"><b>{{ fmtTemp(card.temperature) }}</b>{{ t("metricsGpu.temperature") }}</span>
            <span class="gpu-npu-stat"><b>{{ fmtGpuPower(card) }}</b>{{ t("metricsGpu.power") }}</span>
            <span class="gpu-npu-stat"><b>{{ fmtPercent(card.fan) }}</b>{{ t("metricsGpu.fan") }}</span>
          </div>
          <div v-if="card.totalMem" class="disk-row">
            <span class="mono">{{ t("metricsGpu.memory") }}</span>
            <progress :value="memShare(card.usedMem, card.totalMem)" max="100" :class="{ 'disk-warn': memShare(card.usedMem, card.totalMem) >= 85 }" />
            <span class="numeric" :title="`${formatBytes(card.usedMem ?? 0)} / ${formatBytes(card.totalMem)} · ${Math.round(memShare(card.usedMem, card.totalMem))}%`">{{ formatBytes(card.usedMem ?? 0) }} / {{ formatBytes(card.totalMem) }} · {{ Math.round(memShare(card.usedMem, card.totalMem)) }}%</span>
          </div>
          <div v-if="card.processes.length" class="gpu-npu-processes">
            <div v-for="proc in card.processes" :key="`${card.uuid}-${proc.pid}-${proc.mem ?? 0}`" class="gpu-npu-process-row">
              <span class="mono">{{ proc.pid }}</span>
              <span class="mono gpu-npu-process-name" :title="proc.name">{{ proc.name }}</span>
              <span class="numeric">{{ proc.mem != null ? formatBytes(proc.mem) : "–" }}</span>
            </div>
          </div>
          <p v-else class="metrics-hint muted">{{ t("metricsGpu.noProcesses") }}</p>
          <small v-if="card.driver" class="muted gpu-npu-driver" :title="`${t('metricsGpu.driver')} ${card.driver}`">{{ card.driver }}</small>
        </article>
      </div>
      <p v-else class="metrics-hint muted gpu-npu-unavailable">{{ gpu.available ? t("metricsGpu.empty") : t("metricsGpu.unavailable") }}</p>
    </template>

    <!-- Ascend NPU：HBM 列存在时文案切 HBM，一卡多芯片每芯一张卡 -->
    <template v-if="npu">
      <div v-if="npuCards.length" class="gpu-npu-cards">
        <article v-for="device in npuCards" :key="device.deviceKey" class="gpu-npu-card">
          <header class="gpu-npu-card-head">
            <strong class="gpu-npu-card-name" :title="deviceKeyTitle(device)">{{ device.name || device.deviceKey }}</strong>
            <span v-if="device.health && device.health !== 'OK'" class="mono gpu-npu-badge gpu-npu-badge-warn" :title="t('metricsNpu.health')">{{ device.health }}</span>
          </header>
          <div class="gpu-npu-stats">
            <span class="gpu-npu-stat"><b>{{ fmtPercent(device.aicore) }}</b>{{ t("metricsNpu.aicore") }}</span>
            <span class="gpu-npu-stat"><b>{{ fmtTemp(device.temperature) }}</b>{{ t("metricsGpu.temperature") }}</span>
            <span class="gpu-npu-stat"><b>{{ fmtWatts(device.power) }}</b>{{ t("metricsGpu.power") }}</span>
          </div>
          <div v-if="device.totalMem" class="disk-row">
            <span class="mono">{{ device.memoryLabel === "hbm" ? t("metricsNpu.hbm") : t("metricsGpu.memory") }}</span>
            <progress :value="memShare(device.usedMem, device.totalMem)" max="100" :class="{ 'disk-warn': memShare(device.usedMem, device.totalMem) >= 85 }" />
            <span class="numeric">{{ formatBytes(device.usedMem ?? 0) }} / {{ formatBytes(device.totalMem) }} · {{ Math.round(memShare(device.usedMem, device.totalMem)) }}%</span>
          </div>
          <div v-if="device.processes.length" class="gpu-npu-processes">
            <div v-for="proc in device.processes" :key="`${device.deviceKey}-${proc.pid}`" class="gpu-npu-process-row">
              <span class="mono">{{ proc.pid }}</span>
              <span class="mono gpu-npu-process-name" :title="proc.name">{{ proc.name }}</span>
              <span class="numeric">{{ proc.mem != null ? formatBytes(proc.mem) : "–" }}</span>
            </div>
          </div>
          <p v-else class="metrics-hint muted">{{ t("metricsGpu.noProcesses") }}</p>
        </article>
      </div>
      <p v-else class="metrics-hint muted gpu-npu-unavailable">{{ npu.available ? t("metricsNpu.empty") : t("metricsNpu.unavailable") }}</p>
    </template>
  </div>
</template>

<style scoped>
/* 对齐 style.css 的 .metric-card / .metrics-grid：同样的边框、圆角、底色
   token 与 auto-fit 网格，保证与监控面板其余卡片视觉一致。 */
.gpu-npu-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.gpu-npu-card { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; background: color-mix(in srgb, var(--muted) 40%, transparent); overflow: hidden; }
.gpu-npu-card-head { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; }
.gpu-npu-card-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.gpu-npu-badge { flex: 0 0 auto; border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; color: var(--muted-foreground); font-size: 10px; }
.gpu-npu-badge-warn { color: var(--destructive); border-color: color-mix(in srgb, var(--destructive) 50%, transparent); }
.gpu-npu-stats { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--muted-foreground); font-size: 10px; }
.gpu-npu-stat b { margin-right: 4px; color: var(--foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.gpu-npu-processes { display: flex; flex-direction: column; gap: 2px; }
.gpu-npu-process-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: 10px; }
.gpu-npu-process-name { min-width: 0; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis; white-space: nowrap; }
.gpu-npu-cann { display: inline-block; margin-left: 8px; color: var(--muted-foreground); font-size: 10px; }
/* 窄卡片（auto-fit 两列时 ~185px）里显存数值会被挤成竖排折行：禁止折行并
   缩一号字；放不下时以省略号截断（完整值在 title 里），不再被卡片硬裁丢尾。 */
.gpu-npu-section .numeric { min-width: 0; overflow: hidden; white-space: nowrap; font-size: 10px; text-overflow: ellipsis; }
.gpu-npu-driver { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
/* 不可用态刻意弱化：面板其余区域保持主要地位。 */
.gpu-npu-unavailable { opacity: 0.75; }
</style>
