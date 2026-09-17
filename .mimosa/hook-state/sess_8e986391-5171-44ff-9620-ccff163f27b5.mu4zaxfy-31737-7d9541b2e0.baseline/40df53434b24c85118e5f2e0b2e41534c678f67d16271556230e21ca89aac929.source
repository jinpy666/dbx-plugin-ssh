// 录制开始倒计时状态机（纯函数，不触 DOM/定时器，便于单测）。
//
// 点击录制按钮不立即写后端：先 3→2→1 倒计时（录制软件惯例，给用户
// "即将开始"的明确预期），倒计时归零才触发 recording/start；
// 期间 Esc/点击可取消（cancel 后状态归零，不触发开始）。

export const RECORD_COUNTDOWN_START = 3;

/**
 * 下一秒倒计时的值：N>1 → N-1；1 → null（归零，调用方此时开始录制）；
 * null → null（未在倒计时，幂等）。
 */
export function nextCountdownValue(current: number | null): number | null {
  if (current === null) return null;
  if (current <= 1) return null;
  return current - 1;
}

/** 倒计时是否处于激活态（Esc 链/遮罩显示共用这个判定）。 */
export function isCountdownActive(value: number | null): boolean {
  return value !== null;
}
