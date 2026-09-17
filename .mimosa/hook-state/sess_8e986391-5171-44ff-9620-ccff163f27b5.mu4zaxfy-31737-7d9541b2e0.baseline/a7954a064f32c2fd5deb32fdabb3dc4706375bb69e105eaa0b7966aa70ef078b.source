/**
 * 弹层焦点归还后的"幽灵点击"守卫（UI_SCAN R3-P1-1）。
 *
 * 背景：键盘 Enter 提交 mkdir/newFile 后弹层关闭、焦点归还触发按钮，浏览器
 * 会在刚获得焦点的按钮上派发一次**无 mousedown 前驱的合成 click**，把刚关掉
 * 的弹层立即重开。守卫思路：
 * 1. 焦点归还前 `arm()` 开启一个短抑制窗；
 * 2. 抑制窗内到达、且此前没有真实 mousedown 的 click（合成激活的特征）
 *    判定为幽灵点击并拦截；
 * 3. 窗口外或带 mousedown 的 click（真实鼠标操作）一律放行，不影响快速连点。
 */
export const GHOST_CLICK_WINDOW_MS = 400;
/** 真实鼠标 click 的 mousedown 一般在前 100ms 内；超出该间隔视为无前驱。 */
export const GHOST_CLICK_MOUSE_DOWN_GRACE_MS = 200;

export interface GhostClickGuard {
  /** 记录一次真实 mousedown（capture 级监听器每次按下都调用）。 */
  noteMouseDown(nowMs?: number): void;
  /** 开启抑制窗（焦点归还前调用）。 */
  arm(nowMs?: number): void;
  /**
   * 判定并消费一次 click：抑制窗内的无 mousedown 前驱 click 返回 true
   * （应 preventDefault + stopPropagation）；命中后窗口立即失效，最多吞一次。
   */
  shouldSuppress(nowMs?: number): boolean;
}

export function createGhostClickGuard(now: () => number = () => Date.now()): GhostClickGuard {
  let armedUntil = 0;
  let lastMouseDownAt = Number.NEGATIVE_INFINITY;
  return {
    noteMouseDown(nowMs = now()) {
      lastMouseDownAt = nowMs;
    },
    arm(nowMs = now()) {
      armedUntil = nowMs + GHOST_CLICK_WINDOW_MS;
    },
    shouldSuppress(nowMs = now()) {
      if (nowMs > armedUntil) return false;
      armedUntil = 0;
      return nowMs - lastMouseDownAt > GHOST_CLICK_MOUSE_DOWN_GRACE_MS;
    },
  };
}
