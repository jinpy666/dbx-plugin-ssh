import { computed, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import type { ConnectLog } from "../lib/connectLog";

/** 连接卡片四态与手动重连入口：四态由用户取消/连接成功旗标对底层
 * terminalState 窄化而来，Show logs 面板条目直通 connectLog。cancelConnect
 * 清掉待触发的重试定时器并切已取消态；startConnect 从已取消态走完整连接；
 * reconnectNow 在退避梯子 pending 时清定时器立即重连（_connect 卡片
 * @reconnect/@cancel/@connect 与终端工具条重连按钮共用）。会话主干
 * openSession/closeSession/宿主重开连接留守 App.vue，经 options 注入；
 * terminal 为可变 let（每会话重建），以 getter 取当前实例。 */
export function useConnectCard(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  terminalState: Ref<string>;
  connectCancelled: Ref<boolean>;
  connectSucceeded: Ref<boolean>;
  connectLog: ConnectLog;
  reconnectPending: Ref<boolean>;
  reconnectAttempt: Ref<number>;
  reconnectTimer: Ref<number>;
  getTerminal: () => Terminal | undefined;
  resetGutterTimestamps: () => void;
  requestHostReopenConnection: () => Promise<unknown>;
  openSession: (forceNew?: boolean, bootRestore?: boolean, isRetry?: boolean) => Promise<void>;
  closeSession: (updateStatus?: boolean) => Promise<void>;
}) {
  const {
    t,
    terminalState,
    connectCancelled,
    connectSucceeded,
    connectLog,
    reconnectPending,
    reconnectAttempt,
    reconnectTimer,
    getTerminal,
    resetGutterTimestamps,
    requestHostReopenConnection,
    openSession,
    closeSession,
  } = options;

  // 连接卡片四态：用户取消优先于底层 terminalState（在途 open 仍是 connecting）；
  // open 成功后的短暂 success 态优先于 connecting；其余（error/disconnected）
  // 统一呈现错误行 + Reconnect。
  const connectCardState = computed<"connecting" | "error" | "cancelled" | "success">(() => {
    if (connectCancelled.value) return "cancelled";
    if (connectSucceeded.value) return "success";
    return terminalState.value === "connecting" ? "connecting" : "error";
  });
  const connectLogEntries = computed(() => connectLog.entries.value);

  async function reconnect() {
    getTerminal()?.clear();
    resetGutterTimestamps();
    await closeSession(false);
    await requestHostReopenConnection();
    await openSession();
  }

  /**
   * 连接卡片 Cancel：在途 ssh/session/open 无法中止，仅清掉待触发的重试定时器
   * 并把卡片切到已取消态；promise 落地后由 openSession 内的 connectCancelled
   * 分支负责回收孤儿会话 / 跳过重试与错误呈现。
   */
  function cancelConnect() {
    window.clearTimeout(reconnectTimer.value);
    connectCancelled.value = true;
    connectLog.push("warn", t("connectCard.log.cancelled"));
  }

  /** 已取消态的 Connect 出口：与错误态 reconnect 同路径——先请宿主按最新配置
   * 重开连接（侧边栏改密码/连接信息后 sidecar 凭据已过期，缺这步会拿旧凭据
   * 反复失败、把 inactive 重试梯子耗尽才落错误态），再走完整 openSession
   * 流程（入口会重置取消标记）。 */
  async function startConnect() {
    connectCancelled.value = false;
    await requestHostReopenConnection();
    void openSession();
  }

  /**
   * Manual "reconnect now" entry: while the auto-reconnect backoff ladder is
   * pending, cancel the scheduled retry and reconnect immediately instead of
   * waiting out the current delay; otherwise behave like the plain reconnect.
   */
  async function reconnectNow() {
    if (!reconnectPending.value) {
      await reconnect();
      return;
    }
    window.clearTimeout(reconnectTimer.value);
    reconnectPending.value = false;
    reconnectAttempt.value = 0;
    await openSession();
  }

  return { connectCardState, connectLogEntries, reconnect, cancelConnect, startConnect, reconnectNow };
}
