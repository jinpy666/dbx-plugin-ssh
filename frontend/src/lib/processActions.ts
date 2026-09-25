// 进程管理面板（ssh/processes/list + kill）纯逻辑：排序、可杀性判断。
// 零 UI / 零 sidecar 依赖，单测见 processActions.spec.ts。

// fd / ports：句柄数与监听端口两列（后端 best-effort，取不到为 null/空）。
export type ProcessSortKey = "cpu" | "mem" | "pid" | "fd" | "ports";

export interface ProcessRowLike {
  pid: number;
  cpuPercent: number;
  memPercent: number;
  /** 打开句柄数；未知（其他用户进程 / 非 Linux）为 null。 */
  fdCount?: number | null;
  /** 监听 TCP 端口列表；未知为空数组。 */
  listenPorts?: number[];
}

// 降序排序（pid 升序例外：小号在前更符合直觉；并列时以 pid 升序决胜）。
// fd/ports 排序时未知值（null/空）排在最后，仍以 pid 升序决胜。
export function sortProcessRows<T extends ProcessRowLike>(rows: readonly T[], key: ProcessSortKey): T[] {
  const copy = [...rows];
  if (key === "pid") {
    copy.sort((left, right) => left.pid - right.pid);
  } else if (key === "fd") {
    copy.sort((left, right) => (right.fdCount ?? -1) - (left.fdCount ?? -1) || left.pid - right.pid);
  } else if (key === "ports") {
    copy.sort((left, right) => (right.listenPorts?.length ?? 0) - (left.listenPorts?.length ?? 0) || left.pid - right.pid);
  } else {
    const field = key === "cpu" ? "cpuPercent" : "memPercent";
    copy.sort((left, right) => right[field] - left[field] || left.pid - right.pid);
  }
  return copy;
}

// 与后端 metrics::kill_command 同规则：pid 0/1 拒绝；非正整数拒绝。
export function canKillProcess(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}
