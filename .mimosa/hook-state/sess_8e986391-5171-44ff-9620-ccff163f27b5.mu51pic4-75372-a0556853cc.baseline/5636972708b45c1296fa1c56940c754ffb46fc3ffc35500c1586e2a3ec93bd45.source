// 进程管理面板（ssh/processes/list + kill）纯逻辑：排序、可杀性判断。
// 零 UI / 零 sidecar 依赖，单测见 processActions.spec.ts。

export type ProcessSortKey = "cpu" | "mem" | "pid";

export interface ProcessRowLike {
  pid: number;
  cpuPercent: number;
  memPercent: number;
}

// 降序排序（pid 升序例外：小号在前更符合直觉；并列时以 pid 升序决胜）。
export function sortProcessRows<T extends ProcessRowLike>(rows: readonly T[], key: ProcessSortKey): T[] {
  const copy = [...rows];
  if (key === "pid") {
    copy.sort((left, right) => left.pid - right.pid);
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
