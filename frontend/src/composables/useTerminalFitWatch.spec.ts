// @vitest-environment happy-dom
// issue #262 防御修复：终端「半屏」自愈看门狗。
// 症状链：宿主切 tab 时沙箱 iframe 短暂脱离 → scheduleFit 的 fit() 抛错被
// 静默吞掉（App.vue "The iframe can briefly be detached"）或容器零尺寸守卫
// 直接丢弃本次 → 宿主回切后 ResizeObserver 不再触发（元素盒尺寸未变）→
// xterm 行列停在旧值，内容只占容器一角。这里按固定周期比对
// fitAddon.proposeDimensions() 与 xterm 实际行列，失配即补偿 scheduleFit，
// 与宿主隐藏/脱离的具体行为无关。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalFitWatch } from "./useTerminalFitWatch";

function mount(overrides?: { intervalMs?: number }) {
  const scheduleFit = vi.fn();
  let proposed: { cols: number; rows: number } | undefined = { cols: 80, rows: 24 };
  let current: { cols: number; rows: number } | undefined = { cols: 80, rows: 24 };
  let hasSession = true;
  const watch = useTerminalFitWatch({
    hasActiveSession: () => hasSession,
    getProposedDimensions: () => proposed,
    getTerminalDimensions: () => current,
    scheduleFit,
    intervalMs: overrides?.intervalMs ?? 1000,
  });
  return {
    watch,
    scheduleFit,
    setProposed: (value: typeof proposed) => (proposed = value),
    setCurrent: (value: typeof current) => (current = value),
    setSession: (value: boolean) => (hasSession = value),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useTerminalFitWatch", () => {
  it("行列失配 → 一个周期内补偿 scheduleFit（#262 半屏自愈）", () => {
    const ctx = mount();
    ctx.watch.start();
    ctx.setProposed({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(1000);
    expect(ctx.scheduleFit).toHaveBeenCalledTimes(1);
    ctx.watch.stop();
  });

  it("行列一致 → 不触发", () => {
    const ctx = mount();
    ctx.watch.start();
    vi.advanceTimersByTime(3000);
    expect(ctx.scheduleFit).not.toHaveBeenCalled();
    ctx.watch.stop();
  });

  it("无活跃会话 → 即使失配也不触发", () => {
    const ctx = mount();
    ctx.setProposed({ cols: 120, rows: 40 });
    ctx.setSession(false);
    ctx.watch.start();
    vi.advanceTimersByTime(3000);
    expect(ctx.scheduleFit).not.toHaveBeenCalled();
    ctx.watch.stop();
  });

  it("容器不可测量（proposeDimensions undefined）→ 不触发", () => {
    const ctx = mount();
    ctx.setProposed(undefined);
    ctx.watch.start();
    vi.advanceTimersByTime(3000);
    expect(ctx.scheduleFit).not.toHaveBeenCalled();
    ctx.watch.stop();
  });

  it("收敛后停止触发；stop 后不再检查", () => {
    const ctx = mount();
    ctx.watch.start();
    ctx.setProposed({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(1000);
    expect(ctx.scheduleFit).toHaveBeenCalledTimes(1);
    // 真实链路里 scheduleFit → fit() 收敛行列；模拟收敛后不再触发。
    ctx.setCurrent({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(3000);
    expect(ctx.scheduleFit).toHaveBeenCalledTimes(1);
    ctx.watch.stop();
    ctx.setProposed({ cols: 60, rows: 20 });
    vi.advanceTimersByTime(3000);
    expect(ctx.scheduleFit).toHaveBeenCalledTimes(1);
  });

  it("start 幂等：重复 start 不叠加周期", () => {
    const ctx = mount();
    ctx.watch.start();
    ctx.watch.start();
    ctx.setProposed({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(1000);
    expect(ctx.scheduleFit).toHaveBeenCalledTimes(1);
    ctx.watch.stop();
  });
});
