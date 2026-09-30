import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from "vue";
import { confirmDialog } from "../lib/confirmDialog";
import { distroBadge, type DistroBadge } from "../lib/distroBadge";
import { pushSample, sparklinePath, METRICS_SAMPLE_CAPACITY } from "../lib/metricsSparkline";
import { filterDiskMounts, filterNetworkInterfaces } from "../lib/metricsView";
import { canKillProcess, sortProcessRows, type ProcessSortKey } from "../lib/processActions";
import { type GpuOverviewView, type NpuOverviewView } from "../lib/metricsGpuNpu";

export interface ServerMetrics {
  hostname?: string | null;
  kernel?: string | null;
  uptimeSeconds?: number | null;
  cpu?: { cores?: number | null; percent?: number | null; load1?: number | null; load5?: number | null; load15?: number | null };
  memory?: { totalBytes?: number; availableBytes?: number; usedBytes?: number; swapTotalBytes?: number; swapUsedBytes?: number };
  disks?: Array<{ filesystem: string; mount: string; totalBytes: number; usedBytes: number; availableBytes: number; percentUsed: number }>;
  // Extensions reported by newer sidecars; when absent the network and
  // process sections simply stay hidden instead of erroring.
  network?: Array<{ name: string; rxRate: number; txRate: number; rxTotal: number; txTotal: number }>;
  processes?: Array<{ pid: number; user: string; cpuPercent: number; memPercent: number; command: string }>;
  // §1.5 发行版识别（/etc/os-release）：读不到时两字段整体缺省，
  // 旧 sidecar 自然缺失，前端不渲染徽标（optional 降级）。
  osId?: string;
  osPretty?: string;
  // GPU / Ascend NPU 总览（Task P1-4）：仅新 sidecar 输出，缺省时监控面板
  // 不渲染 GPU/NPU 区（optional 降级）。
  gpu?: GpuOverviewView;
  npu?: NpuOverviewView;
}

/** 悬浮指标卡 + 进程管理面板（F2）：5s 轮询、落盘历史回填、sparkline 采样环、
 * 发行版徽标与进程查杀确认。打开录制列表/传输抽屉时互斥收口。 */
export function useMetricsPanel(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showNotice: (message: string) => void;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  transferPanelOpen: Ref<boolean>;
  recordingsOpen: Ref<boolean>;
}) {
  const { t, showNotice, showError, session, transferPanelOpen, recordingsOpen } = options;

const metricsOpen = ref(false);
// F2：进程管理面板 + 排序键；F3：录制/回放状态。
interface ProcessRow {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  etime: string;
  state: string;
  command: string;
  // iShell 对标列（best-effort）：句柄数与监听端口。旧 sidecar / 非 Linux
  // 主机可能缺失，未知以 null/空数组表示并显示占位符。
  fdCount?: number | null;
  listenPorts?: number[];
}
const processesOpen = ref(false);
const processRows = ref<ProcessRow[]>([]);
const processLoading = ref(false);
const processSortKey = ref<ProcessSortKey>("cpu");
const metrics = ref<ServerMetrics>();
const metricsLoading = ref(false);
const metricsError = ref("");

// ---------------------------------------------------------------------------
// metrics sparkline + 发行版徽标（IMPL_PLAN_NETCATTY_PARITY §3-B2）
// ---------------------------------------------------------------------------

// 每方向环形采样（60 帧 × 5s 轮询 ≈ 5 分钟）；跨重连（新 session）清空。
// F2：cpu/mem 环形同样 60 帧，打开指标卡时用落盘历史回填（跨重启可见趋势）。
const metricSamples = reactive({ rx: [] as number[], tx: [] as number[], cpu: [] as number[], mem: [] as number[] });

function recordMetricSamples() {
  let rx = 0;
  let tx = 0;
  for (const net of metrics.value?.network ?? []) {
    rx += Math.max(0, net.rxRate || 0);
    tx += Math.max(0, net.txRate || 0);
  }
  metricSamples.rx = pushSample(metricSamples.rx, rx, METRICS_SAMPLE_CAPACITY);
  metricSamples.tx = pushSample(metricSamples.tx, tx, METRICS_SAMPLE_CAPACITY);
  const cpuPercent = metrics.value?.cpu?.percent;
  if (cpuPercent != null) metricSamples.cpu = pushSample(metricSamples.cpu, cpuPercent, METRICS_SAMPLE_CAPACITY);
  const totalBytes = metrics.value?.memory?.totalBytes ?? 0;
  if (totalBytes > 0) metricSamples.mem = pushSample(metricSamples.mem, ((metrics.value?.memory?.usedBytes ?? 0) / totalBytes) * 100, METRICS_SAMPLE_CAPACITY);
}

const metricsRxSparkline = computed(() => sparklinePath(metricSamples.rx, 60, 18));
const metricsTxSparkline = computed(() => sparklinePath(metricSamples.tx, 60, 18));
const metricsCpuSparkline = computed(() => sparklinePath(metricSamples.cpu, 120, 18));
const metricsMemSparkline = computed(() => sparklinePath(metricSamples.mem, 120, 18));
// 视图层去噪：伪文件系统/overlay 重复挂载/零流量虚拟网卡不进渲染（纯函数在 lib/metricsView）。
const visibleDiskMounts = computed(() => filterDiskMounts(metrics.value?.disks));
const visibleNetworkInterfaces = computed(() => filterNetworkInterfaces(metrics.value?.network));
// 旧 sidecar 无 osId/osPretty 时整体缺徽标（optional 降级，§6.6）。
const metricsDistroBadge = computed<DistroBadge | null>(() => (metrics.value ? distroBadge(metrics.value.osId, metrics.value.osPretty) : null));

let metricsTimer = 0;

async function refreshMetrics() {
  if (!session.value) return;
  metricsLoading.value = true;
  try {
    metrics.value = await window.dbxPlugin.invoke<ServerMetrics>("ssh/metrics", { sessionId: session.value.sessionId }, { timeoutMs: 30_000 });
    metricsError.value = "";
    recordMetricSamples();
  } catch (cause) {
    metricsError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    metricsLoading.value = false;
  }
}

// 悬浮指标卡：打开即刷新并启动 5s 轮询；不阻塞终端/SFTP 操作，随时开关。
// 与 SFTP transfers 抽屉、Recordings 浮层同位渲染，打开其一互斥关闭其余，
// 避免内容叠字（mock 页实测）。
function toggleMetrics() {
  if (metricsOpen.value) {
    closeMetrics();
    return;
  }
  transferPanelOpen.value = false;
  recordingsOpen.value = false;
  metricsOpen.value = true;
  void backfillMetricsHistory();
  void refreshMetrics();
  window.clearInterval(metricsTimer);
  metricsTimer = window.setInterval(() => {
    if (metricsOpen.value && !metricsLoading.value) void refreshMetrics();
  }, 5000);
}

function closeMetrics() {
  metricsOpen.value = false;
  window.clearInterval(metricsTimer);
}

// Peak rate across every interface normalizes the per-interface bars; the
// network/process sections only render when the sidecar reports the fields,
// so older backends simply hide them.
const metricsRatePeak = computed(() => {
  let peak = 0;
  for (const net of metrics.value?.network ?? []) peak = Math.max(peak, net.rxRate, net.txRate);
  return peak > 0 ? peak : 1;
});

function networkRateShare(net: { rxRate: number; txRate: number }) {
  return Math.min(100, Math.round((Math.max(net.rxRate, net.txRate) / metricsRatePeak.value) * 100));
}

// 列宽要放得下 7 位 PID、常见用户名与带天数的 etime（单元格 ellipsis 会截断关键值）；
// 浮层同步放宽到 448px，满宽时命令列不窄于加宽前；终端面板窄于约 464px 时浮层被
// calc 钳制、命令列会被压缩，属已接受行为。管理表总宽仍超浮层，横向滚动是既有状态。
// 句柄/端口两列（M13-B）加入后总宽进一步增加，同样接受横向滚动。
const metricsProcGridStyle = { gridTemplateColumns: "64px 80px 56px 56px minmax(0, 1fr)" };
const procGridStyle = { gridTemplateColumns: "64px 80px 56px 56px 96px 56px 96px minmax(0, 1fr) 132px" };

// —— F2：指标历史回填 + 进程管理 ———

// 打开指标卡时拉一次落盘历史（connectionId 维度，跨重启可见趋势）；
// 旧 sidecar 无该方法时静默降级。
async function backfillMetricsHistory() {
  if (!session.value) return;
  try {
    const result = await window.dbxPlugin.invoke<{ samples: Array<{ cpuPercent?: number; memoryPercent?: number; rxRate?: number; txRate?: number }> }>("ssh/metrics/history", { sessionId: session.value.sessionId, limit: METRICS_SAMPLE_CAPACITY });
    for (const sample of result.samples ?? []) {
      if (sample.cpuPercent != null) metricSamples.cpu = pushSample(metricSamples.cpu, sample.cpuPercent, METRICS_SAMPLE_CAPACITY);
      if (sample.memoryPercent != null) metricSamples.mem = pushSample(metricSamples.mem, sample.memoryPercent, METRICS_SAMPLE_CAPACITY);
      metricSamples.rx = pushSample(metricSamples.rx, Math.max(0, sample.rxRate ?? 0), METRICS_SAMPLE_CAPACITY);
      metricSamples.tx = pushSample(metricSamples.tx, Math.max(0, sample.txRate ?? 0), METRICS_SAMPLE_CAPACITY);
    }
  } catch {
    // optional 降级：无历史则趋势从本次打开开始累计。
  }
}

async function toggleProcessPanel() {
  processesOpen.value = !processesOpen.value;
  if (processesOpen.value) await refreshProcessList();
}

async function refreshProcessList() {
  if (!session.value) return;
  processLoading.value = true;
  try {
    const result = await window.dbxPlugin.invoke<{ processes: ProcessRow[] }>("ssh/processes/list", { sessionId: session.value.sessionId }, { timeoutMs: 20_000 });
    processRows.value = result.processes ?? [];
  } catch (cause) {
    showError(cause);
  } finally {
    processLoading.value = false;
  }
}

const sortedProcessRows = computed(() => sortProcessRows(processRows.value, processSortKey.value));
const PROCESS_VISIBLE_LIMIT = 100;
const visibleProcessRows = computed(() => sortedProcessRows.value.slice(0, PROCESS_VISIBLE_LIMIT));

async function killProcessRow(row: ProcessRow, signal: 15 | 9) {
  if (!session.value || !canKillProcess(row.pid)) return;
  const confirmKey = signal === 9 ? "procKillForceConfirm" : "procKillConfirm";
  if (!(await confirmDialog(t(confirmKey, { pid: row.pid, command: row.command })))) return;

  try {
    await window.dbxPlugin.invoke("ssh/processes/kill", { sessionId: session.value.sessionId, pid: row.pid, signal });
    showNotice(t("procKilled", { pid: row.pid }));
    await refreshProcessList();
  } catch (cause) {
    showError(cause);
  }
}


onBeforeUnmount(() => {
  window.clearInterval(metricsTimer);
});

// 换会话清空采样环（跨重连不残留旧趋势）。
watch(() => session.value?.sessionId, (next, previous) => {
  if (next !== previous) {
    metricSamples.rx = [];
    metricSamples.tx = [];
    metricSamples.cpu = [];
    metricSamples.mem = [];
  }
});

  return {
    metricsOpen,
    processesOpen,
    processRows,
    processLoading,
    processSortKey,
    metrics,
    metricsLoading,
    metricsError,
    metricSamples,
    recordMetricSamples,
    metricsRxSparkline,
    metricsTxSparkline,
    metricsCpuSparkline,
    metricsMemSparkline,
    visibleDiskMounts,
    visibleNetworkInterfaces,
    metricsDistroBadge,
    refreshMetrics,
    toggleMetrics,
    closeMetrics,
    metricsRatePeak,
    networkRateShare,
    metricsProcGridStyle,
    procGridStyle,
    backfillMetricsHistory,
    toggleProcessPanel,
    refreshProcessList,
    sortedProcessRows,
    PROCESS_VISIBLE_LIMIT,
    visibleProcessRows,
    killProcessRow,
  };
}
