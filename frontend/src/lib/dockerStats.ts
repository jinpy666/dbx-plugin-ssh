/**
 * Docker 容器指标（`docker/stats`，B2 只读）：响应归一化、字节/百分比
 * 格式化与两次采样间的速率差分。全部为纯函数（同 `quickCommands.ts`
 * 惯例：模块只做计算与显式存取），轮询生命周期在
 * `composables/useDockerStats.ts`，组件只负责渲染。
 *
 * 与 sidecar 的契约（docs/PROTOCOL.zh-CN.md「Docker 管理面板」）：
 * `netRxBytes` / `netTxBytes` / `blockReadBytes` / `blockWriteBytes` 是容器
 * 累计值；`netRxRate` / `netTxRate` 是 sidecar 用同一采样 key 的两次采样
 * 差分出的字节/秒。旧 payload 可能没有 rate 字段——此时前端用自己保存的
 * 上一次快照补算（`resolveRates`），保证面板始终有速率可显示。
 */

export interface DockerStatSample {
  containerId: string;
  name: string;
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  /** 字节/秒；sidecar 差分结果，缺失时前端自行差分。 */
  netRxRate?: number;
  netTxRate?: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface DockerStatsSnapshot {
  available: boolean;
  needsSudo: boolean;
  /** Unix 毫秒（sidecar 采样时刻）。 */
  sampledAt: number;
  stats: DockerStatSample[];
}

export interface DockerStatsTotals {
  containers: number;
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxRate: number;
  netTxRate: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export const EMPTY_DOCKER_STATS: DockerStatsSnapshot = {
  available: false,
  needsSudo: false,
  sampledAt: 0,
  stats: [],
};

/** 两次采样间隔低于该值时不做速率差分（与 sidecar 的 250ms 同口径）。 */
export const DOCKER_STATS_MIN_RATE_WINDOW_MS = 250;
/** 单次请求的容器上限（与 sidecar `STATS_MAX_CONTAINERS` 同值）。 */
export const DOCKER_STATS_MAX_CONTAINERS = 50;

/** 请求前清洗容器 id：去空、去重、封顶（sidecar 还会逐项过十六进制门）。 */
export function normalizeContainerIds(ids: readonly string[]): string[] {
  const unique: string[] = [];
  for (const raw of ids) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed || unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= DOCKER_STATS_MAX_CONTAINERS) break;
  }
  return unique;
}

function toNonNegative(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function toFinite(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** 单条样本归一化；缺 id 或 id 不是字符串的行丢弃（`null`）。 */
export function normalizeDockerStatSample(raw: unknown): DockerStatSample | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const containerId = typeof record.containerId === "string" ? record.containerId.trim() : "";
  if (!containerId) return null;
  const sample: DockerStatSample = {
    containerId,
    name: typeof record.name === "string" ? record.name : "",
    cpuPercent: toNonNegative(record.cpuPercent),
    memBytes: toNonNegative(record.memBytes),
    memLimitBytes: toNonNegative(record.memLimitBytes),
    memPercent: toNonNegative(record.memPercent),
    netRxBytes: toNonNegative(record.netRxBytes),
    netTxBytes: toNonNegative(record.netTxBytes),
    blockReadBytes: toNonNegative(record.blockReadBytes),
    blockWriteBytes: toNonNegative(record.blockWriteBytes),
    pids: toNonNegative(record.pids),
  };
  if (Number.isFinite(Number(record.netRxRate))) sample.netRxRate = toNonNegative(record.netRxRate);
  if (Number.isFinite(Number(record.netTxRate))) sample.netTxRate = toNonNegative(record.netTxRate);
  return sample;
}

/** 响应体归一化：字段缺失/非法时退化为空快照，绝不抛错（面板降级用）。 */
export function normalizeDockerStatsPayload(raw: unknown): DockerStatsSnapshot {
  if (!raw || typeof raw !== "object") return { ...EMPTY_DOCKER_STATS, stats: [] };
  const record = raw as Record<string, unknown>;
  const stats = Array.isArray(record.stats)
    ? record.stats
        .map(normalizeDockerStatSample)
        .filter((sample): sample is DockerStatSample => sample !== null)
    : [];
  return {
    available: record.available === true,
    needsSudo: record.needsSudo === true,
    sampledAt: toNonNegative(record.sampledAt),
    stats,
  };
}

function rateBetween(previous: number, current: number, seconds: number): number {
  if (!(seconds > 0) || !Number.isFinite(previous) || !Number.isFinite(current)) return 0;
  if (current < previous) return 0; // 容器重启/计数器回绕
  return Math.round((current - previous) / seconds);
}

/**
 * 用上一次快照差分速率（字节/秒）。窗口过短、无基线或计数器回绕均返回 0。
 * 与 sidecar 的 `rate_bytes_per_sec` 同一语义，便于两侧单测互证。
 */
export function deriveDockerRates(
  previous: DockerStatSample | undefined,
  current: DockerStatSample,
  elapsedMs: number,
): { netRxRate: number; netTxRate: number } {
  if (!previous || !Number.isFinite(elapsedMs) || elapsedMs < DOCKER_STATS_MIN_RATE_WINDOW_MS) {
    return { netRxRate: 0, netTxRate: 0 };
  }
  const seconds = elapsedMs / 1000;
  return {
    netRxRate: rateBetween(previous.netRxBytes, current.netRxBytes, seconds),
    netTxRate: rateBetween(previous.netTxBytes, current.netTxBytes, seconds),
  };
}

/**
 * 展示用速率：payload 自带两个 rate 时以 sidecar 为准（它持有跨请求缓存，
 * 首帧也有值）；否则用前端上一次快照补算。
 */
export function resolveDockerRates(
  sample: DockerStatSample,
  previous: DockerStatSample | undefined,
  elapsedMs: number,
): { netRxRate: number; netTxRate: number } {
  if (typeof sample.netRxRate === "number" && typeof sample.netTxRate === "number") {
    return { netRxRate: sample.netRxRate, netTxRate: sample.netTxRate };
  }
  return deriveDockerRates(previous, sample, elapsedMs);
}

/** 汇总成一行指标条：CPU 求和（每容器百分比之和）、内存用量/上限求和，
 * 内存百分比按汇总值回算（不是百分比相加），速率与 PIDs 求和。 */
export function aggregateDockerStats(stats: DockerStatSample[]): DockerStatsTotals {
  const totals: DockerStatsTotals = {
    containers: stats.length,
    cpuPercent: 0,
    memBytes: 0,
    memLimitBytes: 0,
    memPercent: 0,
    netRxRate: 0,
    netTxRate: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    pids: 0,
  };
  for (const sample of stats) {
    totals.cpuPercent += sample.cpuPercent;
    totals.memBytes += sample.memBytes;
    totals.memLimitBytes += sample.memLimitBytes;
    totals.netRxRate += sample.netRxRate ?? 0;
    totals.netTxRate += sample.netTxRate ?? 0;
    totals.blockReadBytes += sample.blockReadBytes;
    totals.blockWriteBytes += sample.blockWriteBytes;
    totals.pids += sample.pids;
  }
  totals.cpuPercent = Math.round(totals.cpuPercent * 100) / 100;
  totals.memPercent =
    totals.memLimitBytes > 0
      ? Math.round((totals.memBytes / totals.memLimitBytes) * 10_000) / 100
      : 0;
  return totals;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** 1024 进制的紧凑字节格式（`0 B`、`1.5 KiB`、`2.3 GiB`）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** 字节/秒（`1.2 kB/s` 语义沿用 docker 的 SI 观感 → 这里同样 1024 进制，仅接单位）。 */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 百分比保留一位小数（`12.3%`），0 也显示 `0%` 便于对齐。 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${(Math.round(value * 10) / 10).toFixed(1)}%`;
}
