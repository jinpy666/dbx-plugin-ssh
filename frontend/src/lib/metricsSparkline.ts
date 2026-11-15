// metrics 网络速率 sparkline（IMPL_PLAN_NETCATTY_PARITY §3-B2）：纯函数，零 UI 依赖。
// 采样环缓冲（每方向 60 帧，metrics 轮询 5s ≈ 最近 5 分钟）+ polyline points
// 生成（60×18 SVG，App.vue 以 rx=var(--primary)/tx=var(--success) 着色）。

/** 每方向保留的采样数（60 帧 × 5s 轮询 ≈ 5 分钟窗口）。 */
export const METRICS_SAMPLE_CAPACITY = 60;

/**
 * 推入一个采样并返回新数组（不可变语义，对齐 pushCommandHistory 风格）；
 * 超容量时丢弃最旧样本。非有限/负值按 0 记账，防 NaN 污染曲线。
 */
export function pushSample(ring: readonly number[], sample: number, capacity = METRICS_SAMPLE_CAPACITY): number[] {
  const value = Number.isFinite(sample) && sample > 0 ? sample : 0;
  const next = capacity <= 0 ? [] : [...ring, value].slice(-capacity);
  return next;
}

/**
 * 生成 polyline 的 `points` 字符串（"x,y x,y …"）：
 * - 空序列 → ""（调用方不渲染 SVG）；
 * - 单点画在左端中线（曲线尚未成形时的稳定占位）；
 * - x 均匀铺满 [0, width]，y 按 max 归一化（全零/非正 max 时贴底边），
 *   超出 max 的值钳制在顶边，坐标取整到像素。
 * - 可选 `max`：监控面板分段曲线传入全序列共享峰值，让多段比例可比；
 *   缺省仍从序列内推导（既有调用零改动）。显式传入非正 max 视为全零序列。
 */
export function sparklinePath(values: readonly number[], width: number, height: number, max?: number): string {
  if (!values.length || width <= 0 || height <= 0) return "";
  if (values.length === 1) return `0,${Math.round(height / 2)}`;
  const peak = max === undefined ? values.reduce((derived, value) => Math.max(derived, value), 0) : max;
  const points = values.map((value, index) => {
    const x = Math.round((index / (values.length - 1)) * width);
    const ratio = peak > 0 ? Math.min(1, Math.max(0, value / peak)) : 0;
    const y = height - Math.round(ratio * height);
    return `${x},${y}`;
  });
  return points.join(" ");
}

/**
 * Gap-aware segmented polyline points (monitor panel, DESIGN_MONITOR_PANEL §卡片)：
 * 断档（iface 切换/采集失败）处跳线不插值——按 gaps 并行标记切段，返回每段
 * 独立的 `points` 字符串（调用方在同一个 SVG 里各画一条 polyline）。
 * - 空序列/非法尺寸/全 gap → []（无可渲染段）；
 * - 无 gap → 与 sparklinePath 输出完全一致（单元素数组）；
 * - y 归一化用全序列共享 max（同 sparklinePath 语义），段间比例可比；
 * - x 取点的**全序列位置**（跳线后曲线仍停留在窗口内的真实时刻上）；
 * - 单点段沿用“中线占位”语义，但 x 保留其全局位置。
 */
export function sparklineSegments(values: readonly number[], gaps: readonly boolean[], width: number, height: number): string[] {
  if (!values.length || width <= 0 || height <= 0) return [];
  const isGap = (index: number) => gaps[index] === true;
  if (!values.some((_value, index) => isGap(index))) return [sparklinePath(values, width, height)];
  const sharedMax = values.reduce((peak, value, index) => (isGap(index) ? peak : Math.max(peak, value)), 0);
  const xAt = (index: number) => (values.length === 1 ? 0 : Math.round((index / (values.length - 1)) * width));
  const yAt = (value: number) => {
    const ratio = sharedMax > 0 ? Math.min(1, Math.max(0, value / sharedMax)) : 0;
    return height - Math.round(ratio * height);
  };
  const segments: string[] = [];
  // 连续非 gap 下标收敛成段（runs[i].start + values.length === 下一.sample 下标）。
  const runs: Array<{ start: number; values: number[] }> = [];
  values.forEach((value, index) => {
    if (isGap(index)) return;
    const last = runs[runs.length - 1];
    if (last && last.start + last.values.length === index) last.values.push(value);
    else runs.push({ start: index, values: [value] });
  });
  for (const run of runs) {
    if (run.values.length === 1) {
      segments.push(`${xAt(run.start)},${Math.round(height / 2)}`);
      continue;
    }
    segments.push(run.values.map((value, offset) => `${xAt(run.start + offset)},${yAt(value)}`).join(" "));
  }
  return segments;
}

export function smoothSparklinePath(points: string, baseline?: number): string {
  const values = points.trim().split(/\s+/).filter(Boolean).map((point) => point.split(",").map(Number));
  if (values.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return "";
  if (!values.length) return "";
  const [firstX, firstY] = values[0];
  let path = `M ${firstX},${firstY}`;
  for (let index = 0; index < values.length - 1; index += 1) {
    const previous = values[Math.max(0, index - 1)];
    const current = values[index];
    const next = values[index + 1];
    const after = values[Math.min(values.length - 1, index + 2)];
    const cp1x = current[0] + (next[0] - previous[0]) / 6;
    const cp1y = current[1] + (next[1] - previous[1]) / 6;
    const cp2x = next[0] - (after[0] - current[0]) / 6;
    const cp2y = next[1] - (after[1] - current[1]) / 6;
    path += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${next[0]},${next[1]}`;
  }
  if (baseline != null) path += ` L ${values.at(-1)![0]},${baseline} L ${firstX},${baseline} Z`;
  return path;
}
