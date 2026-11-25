/**
 * 「下载到…」记忆（issue #303）：按连接（“项目”）记住上次手动选择的目标
 * 目录，下次下载询问弹窗预填、目录选择器从该位置打开，不必每次从
 * 「此电脑」根重新导航。纯函数；localStorage 读写留在调用方。
 */

/** localStorage 档的收敛读取：非对象/非字符串/空白条目丢弃而非污染状态。 */
export function sanitizeDownloadToMemory(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const memory: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (typeof raw === "string" && raw.trim()) memory[key] = raw;
  }
  return memory;
}

/** 记住某连接的上次「下载到」目录；空目录清掉该条而不是存空白。 */
export function rememberDownloadToDir(
  memory: Record<string, string>,
  connectionKey: string,
  dir: string,
): Record<string, string> {
  const next = { ...memory };
  const normalized = dir.trim();
  if (!connectionKey) return next;
  if (!normalized) {
    delete next[connectionKey];
    return next;
  }
  next[connectionKey] = normalized;
  return next;
}
