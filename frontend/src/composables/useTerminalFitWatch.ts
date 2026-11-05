import { onBeforeUnmount } from "vue";

/**
 * issue #262 防御修复：终端行列失配自愈看门狗。
 *
 * 症状链：宿主切 tab 时沙箱 iframe 短暂脱离，scheduleFit 的 fit() 抛错被
 * 静默吞掉、或容器零尺寸守卫丢弃本次，宿主回切后 ResizeObserver 因元素盒
 * 尺寸未变而不再触发——xterm 行列停在旧值，终端内容只占容器一角（"半屏"）。
 *
 * 按固定周期比对 fitAddon.proposeDimensions() 与 xterm 实际行列，失配即补偿
 * scheduleFit()（内部自带 debounce 与零尺寸守卫）。不依赖宿主可见性事件，
 * 与宿主隐藏/脱离 iframe 的具体行为无关。仅在有活跃会话时检查。
 */
export function useTerminalFitWatch(options: {
  hasActiveSession: () => boolean;
  getProposedDimensions: () => { cols: number; rows: number } | undefined;
  getTerminalDimensions: () => { cols: number; rows: number } | undefined;
  scheduleFit: () => void;
  intervalMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 1000;
  let timer = 0;
  let running = false;

  function checkOnce() {
    if (!options.hasActiveSession()) return;
    const proposed = options.getProposedDimensions();
    const current = options.getTerminalDimensions();
    if (!proposed || !current) return;
    if (proposed.cols !== current.cols || proposed.rows !== current.rows) options.scheduleFit();
  }

  function start() {
    if (running) return;
    running = true;
    timer = window.setInterval(checkOnce, intervalMs);
  }

  function stop() {
    if (!running) return;
    running = false;
    window.clearInterval(timer);
  }

  onBeforeUnmount(stop);
  return { start, stop };
}
