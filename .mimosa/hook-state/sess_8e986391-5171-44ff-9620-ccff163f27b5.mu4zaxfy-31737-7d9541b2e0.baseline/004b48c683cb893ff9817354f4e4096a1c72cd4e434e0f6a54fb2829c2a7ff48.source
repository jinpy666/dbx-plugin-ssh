/**
 * 单调请求序号守卫（UI_SCAN R3-P1-3）：目录列表等异步加载在慢链路下可能
 * 出现"先发 A 后发 B、A 的响应晚到覆盖 B"的竞态。每次发起请求先 `next()`
 * 取号，响应落地前用 `isCurrent(id)` 校验，过期响应整体丢弃（列表、路径、
 * 选中态、loading 收尾都只允许最新请求写入）。
 */
export interface RequestEpoch {
  /** 发起新请求：递增并返回当前序号。 */
  next(): number;
  /** 该序号是否仍是最新请求（晚到的旧响应返回 false）。 */
  isCurrent(id: number): boolean;
}

export function createRequestEpoch(): RequestEpoch {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(id: number) {
      return id === current;
    },
  };
}
