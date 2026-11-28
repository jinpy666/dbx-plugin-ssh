/**
 * Docker 容器指标轮询（`docker/stats`，B2 只读）：3s 一次、页面隐藏即停、
 * 单一请求在途（慢 daemon 不会堆请求），并把 payload 归一成
 * `DockerStatsSnapshot`。速率优先取 sidecar 的差分值，旧 payload 缺字段时
 * 用上一次快照在本机补算（`resolveDockerRates`）。
 *
 * 触发器契约与既有组合式一致：`containerIds` / `params` / `enabled` 是
 * getter（DockerPanel 每次刷新列表后自动换绑），组件只读返回的 ref。
 * 方法不存在（旧 sidecar）会走 error 分支就地提示，不做静默探测。
 */

import { onScopeDispose, ref, watch, type Ref } from "vue";
import {
  EMPTY_DOCKER_STATS,
  aggregateDockerStats,
  normalizeContainerIds,
  normalizeDockerStatsPayload,
  pushDockerStatsPoint,
  resolveDockerRates,
  type DockerStatSample,
  type DockerStatsPoint,
  type DockerStatsSnapshot,
} from "../lib/dockerStats";

/** 轮询间隔：与计划 §4 的 3s 对齐（`docker stats --no-stream` 本身要 ~1-2s）。 */
export const DOCKER_STATS_INTERVAL_MS = 3000;
/** 客户端等待上限：sidecar 采集上限 30s，留 5s 传输余量。 */
export const DOCKER_STATS_TIMEOUT_MS = 35_000;

export interface UseDockerStatsOptions {
  /** 本次要采样的容器 id（通常是列表里 running 的行）。 */
  containerIds: () => string[];
  /** 通用参数（target/sessionId/cli/socket/host），不含 containerIds。 */
  params: () => Record<string, unknown>;
  /** false 时不轮询（面板不可用/未加载列表）。 */
  enabled?: () => boolean;
  /** 注入点：默认走 `window.dbxPlugin.invoke`。 */
  invoke?: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
  intervalMs?: number;
  /** 注入点：默认 `Date.now`（测试可替换）。 */
  now?: () => number;
}

export interface UseDockerStatsResult {
  snapshot: Ref<DockerStatsSnapshot>;
  /** 面板打开期间的总量趋势（60 点 × 3s ≈ 3 分钟），换容器集合即清空。 */
  history: Ref<DockerStatsPoint[]>;
  error: Ref<string>;
  loading: Ref<boolean>;
  refresh: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

function defaultInvoke(
  method: string,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  return window.dbxPlugin.invoke<unknown>(method, params, options);
}

export function useDockerStats(options: UseDockerStatsOptions): UseDockerStatsResult {
  const snapshot = ref<DockerStatsSnapshot>({ ...EMPTY_DOCKER_STATS, stats: [] });
  const history = ref<DockerStatsPoint[]>([]);
  const error = ref("");
  const loading = ref(false);
  const intervalMs = options.intervalMs ?? DOCKER_STATS_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const invoke = options.invoke ?? defaultInvoke;

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let generation = 0;
  let previous: { at: number; samples: Map<string, DockerStatSample> } | null = null;

  function isEnabled(): boolean {
    return options.enabled?.() ?? true;
  }

  async function refresh(): Promise<void> {
    const ids = normalizeContainerIds(options.containerIds());
    if (!isEnabled() || ids.length === 0) {
      snapshot.value = { ...EMPTY_DOCKER_STATS, stats: [] };
      error.value = "";
      previous = null;
      return;
    }
    if (inFlight) return;
    inFlight = true;
    loading.value = true;
    const revision = ++generation;
    try {
      const raw = await invoke(
        "docker/stats",
        { ...options.params(), containerIds: ids },
        { timeoutMs: DOCKER_STATS_TIMEOUT_MS },
      );
      if (revision !== generation) return;
      const next = normalizeDockerStatsPayload(raw);
      const at = now();
      const baseline = previous;
      const elapsed = baseline ? at - baseline.at : 0;
      const stats = next.stats.map((sample) => {
        const rates = resolveDockerRates(
          sample,
          baseline?.samples.get(sample.containerId),
          elapsed,
        );
        return { ...sample, netRxRate: rates.netRxRate, netTxRate: rates.netTxRate };
      });
      snapshot.value = { ...next, stats };
      const totals = aggregateDockerStats(stats);
      history.value = pushDockerStatsPoint(history.value, {
        at: next.sampledAt || at,
        cpuPercent: totals.cpuPercent,
        memPercent: totals.memPercent,
        netBytesPerSec: totals.netRxRate + totals.netTxRate,
      });
      previous = { at, samples: new Map(stats.map((sample) => [sample.containerId, sample])) };
      error.value = "";
    } catch (cause) {
      if (revision !== generation) return;
      error.value = cause instanceof Error ? cause.message : String(cause);
      // 保留上一帧：daemon 短暂抖动不该把指标条清空成闪烁。
    } finally {
      if (revision === generation) loading.value = false;
      inFlight = false;
    }
  }

  function start(): void {
    stop();
    if (!isEnabled()) return;
    void refresh();
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!isEnabled()) return;
      void refresh();
    }, intervalMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function onVisibilityChange(): void {
    if (typeof document !== "undefined" && document.hidden) return;
    if (isEnabled()) void refresh();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  watch(
    [() => normalizeContainerIds(options.containerIds()).join(","), () => isEnabled()],
    ([idsKey, enabled], [previousIdsKey]) => {
      // 换了容器集合，旧曲线不再可比：清空趋势但保留轮询状态机。
      if (idsKey !== previousIdsKey) history.value = [];
      if (enabled) start();
      else stop();
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    stop();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  });

  return { snapshot, history, error, loading, refresh, start, stop };
}
