// 容器列表的本地筛选/搜索（纯函数，无 Vue 依赖）。
//
// 语义对齐参考实现（RemoteX `searchContainers` / `filterContainers`）：
// - 状态筛选默认 all（保持既有行为），running 只留 `state === "running"`，
//   stopped 为其余一切（paused/created/exited/dead 都算「没在跑」）；
// - 搜索按空白分词，词与词之间 AND；每个词先在 name/id/image/state/ports 上
//   做大小写不敏感子串匹配，未命中再对标识字段（id/name）做子序列模糊匹配
//   （`31b4` 能命中 `3f2a1b4c5d6e`），这样短 id 前缀/中间片段都能搜到；
// - 空查询返回原列表的浅拷贝，调用方可以自由排序而不改输入。

export type DockerStateFilter = "all" | "running" | "stopped";

export const DOCKER_STATE_FILTERS: readonly DockerStateFilter[] = ["all", "running", "stopped"];

export interface DockerContainerFilterable {
  id: string;
  name: string;
  image: string;
  state: string;
  ports: string;
}

/** 状态筛选：`running` 只留运行中；`stopped` 留其余一切；`all` 原样（浅拷贝）。 */
export function filterDockerContainers<T extends { state: string }>(
  rows: readonly T[],
  filter: DockerStateFilter,
): T[] {
  if (filter === "all") return [...rows];
  const wantRunning = filter === "running";
  return rows.filter((row) => (row.state === "running") === wantRunning);
}

/** 搜索词分词：小写、空白切分、丢弃空段（「  web   running 」→ web/running）。 */
export function dockerQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** needle 的字符是否按顺序出现在 haystack 中（子序列，允许间隔）。 */
function isSubsequence(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return needle.length === 0;
}

function matchesToken(row: DockerContainerFilterable, token: string): boolean {
  const fields = [row.name, row.id, row.image, row.state, row.ports];
  if (fields.some((field) => field.toLowerCase().includes(token))) return true;
  // 标识字段额外支持子序列模糊（参考实现同款：短 id 片段、跨段名字）。
  return [row.id, row.name].some((field) => isSubsequence(field.toLowerCase(), token));
}

/** 搜索：空白分词 AND；空查询返回浅拷贝。 */
export function searchDockerContainers<T extends DockerContainerFilterable>(
  rows: readonly T[],
  query: string,
): T[] {
  const tokens = dockerQueryTokens(query);
  if (!tokens.length) return [...rows];
  return rows.filter((row) => tokens.every((token) => matchesToken(row, token)));
}

/** 筛选 + 搜索的组合入口（列表组件的唯一数据源）。 */
export function visibleDockerContainers<T extends DockerContainerFilterable>(
  rows: readonly T[],
  filter: DockerStateFilter,
  query: string,
): T[] {
  return searchDockerContainers(filterDockerContainers(rows, filter), query);
}
