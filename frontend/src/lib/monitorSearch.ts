// 监控面板卡片检索（纯函数）：多主机场合按名称/类型/分组快速定位。与
// Docker 容器列表同款交互——空白分词 AND，标识字段另支持子序列模糊
// （"prod-db" 可命中 "production-db-01"），全部本地过滤、零 RPC。

export interface MonitorSearchRow {
  id: string;
  name: string;
  dbType?: string;
  groupName?: string;
}

/** 查询分词：小写、按空白切分、丢弃空段。 */
export function monitorQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function isSubsequence(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

/** 单行匹配：每个 token 都必须命中（子串或标识字段的子序列）。 */
export function matchesMonitorQuery(row: MonitorSearchRow, query: string): boolean {
  const tokens = monitorQueryTokens(query);
  if (!tokens.length) return true;
  const name = (row.name || "").toLowerCase();
  const id = (row.id || "").toLowerCase();
  const dbType = (row.dbType || "").toLowerCase();
  const groupName = (row.groupName || "").toLowerCase();
  return tokens.every((token) =>
    name.includes(token)
    || dbType.includes(token)
    || groupName.includes(token)
    || id.includes(token)
    || isSubsequence(name, token)
    || isSubsequence(id, token),
  );
}

/** 可见行过滤（保持原顺序）。 */
export function searchMonitorRows<T extends MonitorSearchRow>(rows: readonly T[], query: string): T[] {
  if (!monitorQueryTokens(query).length) return [...rows];
  return rows.filter((row) => matchesMonitorQuery(row, query));
}
