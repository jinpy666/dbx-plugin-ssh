/**
 * SFTP 路径历史：每连接最多保留 limit 条，新路径置顶并去重。
 * 纯函数；localStorage 读写留在调用方。
 */
export function pushPathHistory(
  histories: Record<string, string[]>,
  key: string,
  path: string,
  limit = 10,
): Record<string, string[]> {
  if (!key || !path) return { ...histories };
  const next = [path, ...(histories[key] || []).filter((item) => item !== path)].slice(0, limit);
  return { ...histories, [key]: next };
}

/**
 * 校验并收敛从 localStorage 读回的路径历史：坏 JSON 之外，还要防结构漂移
 * （数组、数字/字符串值、含非字符串元素的数组）。任何畸形连接条目被丢弃
 * 而不是污染响应式状态；每条历史重新限长。
 */
export function sanitizePathHistories(
  value: unknown,
  limit = 10,
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const histories: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !Array.isArray(raw)) continue;
    const paths = raw.filter((item): item is string => typeof item === "string" && item !== "");
    if (paths.length) histories[key] = paths.slice(0, limit);
  }
  return histories;
}
