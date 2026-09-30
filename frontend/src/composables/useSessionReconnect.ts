import { ref, watch, type Ref, onBeforeUnmount } from "vue";
import { describeReconnectCountdown, terminalReconnectDelay, TERMINAL_RECONNECT_DELAYS, type ReconnectCountdown } from "../lib/terminalReconnect";

/** 传输断开重连梯子（有界退避）：pending/倒计时（250ms tick 供状态胶囊与
 * 横幅）/尝试计数；梯子第一级先请宿主按最新配置重开连接。耗尽落到
 * disconnected 终态等待手动重连。openSession/attachSession/cancelConnect/
 * reconnectNow 经解构 ref 直接读写梯子状态（reconnectTimer.value/Attempt）。 */
export function useSessionReconnect(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  terminalState: Ref<string>;
  terminalError: Ref<string>;
  isDisposed: () => boolean;
  openSession: (forceNew?: boolean) => Promise<void>;
  requestHostReopenConnection: () => Promise<unknown>;
}) {
  const { t, terminalState, terminalError, isDisposed, openSession, requestHostReopenConnection } = options;

const reconnectTimer = ref(0);
const reconnectAttempt = ref(0);

const reconnectPending = ref(false);
// Pure-display reconnect countdown for the status pill: seconds until the
// next retry plus the progress through the current backoff delay.
const reconnectCountdown = ref<ReconnectCountdown | null>(null);
const reconnectNextAt = ref(0);
const reconnectDelayMs = ref(0);
const reconnectCountdownTimer = ref(0);
// Set the moment a backoff loop starts; consumed by afterSessionConnected to
// show the "connection restored" notice (with cwd context) only after a real
// reconnect, not on the initial connect.
const reconnectWasPending = ref(false);

watch(reconnectPending, (pending) => {
  if (pending) reconnectWasPending.value = true;
  if (reconnectCountdownTimer.value) {
    window.clearInterval(reconnectCountdownTimer.value);
    reconnectCountdownTimer.value = 0;
  }
  if (!pending) {
    reconnectCountdown.value = null;
    return;
  }
  const update = () => {
    reconnectCountdown.value = describeReconnectCountdown({
      pending: true,
      attempt: reconnectAttempt.value,
      nextAt: reconnectNextAt.value,
      now: Date.now(),
      delayMs: reconnectDelayMs.value,
    });
  };
  update();
  reconnectCountdownTimer.value = window.setInterval(update, 250);
});

function scheduleSessionReconnect() {
  // 断开事件可能成对到达（sidecar 重启常伴双事件）：重复调度必须先撤旧
  // timer 再设新的——直接覆盖会让被顶掉的 setTimeout 仍到点触发 openSession，
  // 与新 timer 形成并发双开会话。
  window.clearTimeout(reconnectTimer.value);
  if (!isDisposed() && reconnectAttempt.value < TERMINAL_RECONNECT_DELAYS.length) {
    const delay = terminalReconnectDelay(reconnectAttempt.value++);
    terminalState.value = "connecting";
    reconnectPending.value = true;
    reconnectTimer.value = window.setTimeout(() => {
      if (isDisposed()) return;
      // 梯子第一级重试前先请宿主按最新配置重开连接（与手动 reconnect 同路径）：
      // 侧边栏编辑连接（改密码等）会让 sidecar 凭据过期，缺这步自动重连必撞
      // 旧凭据、落到红色错误态等手动自救——凭据已是新的时这是一次假错误。
      if (reconnectAttempt.value === 1) void requestHostReopenConnection().finally(() => { if (!isDisposed()) void openSession(); });
      else void openSession();
    }, delay);
    return;
  }
  terminalState.value = "disconnected";
  reconnectPending.value = false;
  terminalError.value = t("transportDisconnected");
}


  onBeforeUnmount(() => {
    window.clearTimeout(reconnectTimer.value);
    window.clearInterval(reconnectCountdownTimer.value);
  });

  return {
    reconnectPending,
    reconnectCountdown,
    reconnectWasPending,
    reconnectTimer,
    reconnectAttempt,
    reconnectCountdownTimer,
    reconnectNextAt,
    reconnectDelayMs,
    scheduleSessionReconnect,
  };
}
