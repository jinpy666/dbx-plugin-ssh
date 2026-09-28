// 文件列表窗口化纯计算（SFTP 目录列表虚拟滚动，docs/SFTP_LIST_VIRTUAL_SCROLL_PLAN.zh-CN.md）。
// 渲染层只挂可见窗口的行：上方/下方用等高 spacer 撑起总高，滚动条比例保持
// 真实；选中、范围选择等逻辑层始终作用于全量条目，与窗口无关。

export interface VirtualWindow {
  /** 窗口首行下标（含）。 */
  start: number;
  /** 窗口末行下标（不含）。 */
  end: number;
  /** 窗口上方 spacer 高度（px）。 */
  padTop: number;
  /** 窗口下方 spacer 高度（px）。 */
  padBottom: number;
}

export interface VirtualWindowInput {
  scrollTop: number;
  /** 滚动视口高度（px）；≤0 视为不可见，渲染空窗口。 */
  viewportHeight: number;
  /** 单行总高（px，含分隔线）；非正数按 1 处理防除零。 */
  rowHeight: number;
  total: number;
  /** 窗口上下各多渲染的行数，滚动时减少白边。 */
  overscan?: number;
}

export function computeWindow(input: VirtualWindowInput): VirtualWindow {
  const total = Math.max(0, Math.floor(input.total));
  if (total === 0 || input.viewportHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const rowHeight = Math.max(1, Math.floor(input.rowHeight));
  const overscan = Math.max(0, Math.floor(input.overscan ?? 10));
  const scrollTop = Math.max(0, input.scrollTop);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(input.viewportHeight / rowHeight) + 2 * overscan;
  const end = Math.min(total, start + visibleCount);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (total - end) * rowHeight,
  };
}
