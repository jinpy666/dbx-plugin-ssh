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
 */
export function sparklinePath(values: readonly number[], width: number, height: number): string {
  if (!values.length || width <= 0 || height <= 0) return "";
  if (values.length === 1) return `0,${Math.round(height / 2)}`;
  const max = values.reduce((peak, value) => Math.max(peak, value), 0);
  const points = values.map((value, index) => {
    const x = Math.round((index / (values.length - 1)) * width);
    const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
    const y = height - Math.round(ratio * height);
    return `${x},${y}`;
  });
  return points.join(" ");
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
