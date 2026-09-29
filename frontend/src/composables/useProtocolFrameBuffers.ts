import { ref, type Ref } from "vue";

const TERMINAL_PENDING_FRAME_LIMIT = 1024;

// 帧条目最小结构（pending Map 值）。
type PendingFrame = { stream: number; data: Uint8Array };
// 回放 RPC 结果的最小结构（App.vue 的 ReplayResult 为局部接口，按消费字段收敛）。
type FrameReplayResult = { complete: boolean; firstAvailableSequence: number };

/** 协议帧缓冲（local/telnet/serial 三路同构）：乱序 pending Map + 序号推进 +
 * 洪峰丢弃 + 缺口回放（三轮无进展跳洞/resync）+ 会话终态帧识别。
 * SSH 主通道的 drainTerminalFrames 与 disposed/reconnect 梯子强耦合，留守
 * App.vue；会话启停函数（start/close×3）经解构 ref 读写这些状态。 */
export function useProtocolFrameBuffers(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  dispatchTerminalOutput: (data: Uint8Array) => void;
  showNotice: (message: string) => void;
  localSession: Ref<{ sessionId: string; shell: string } | null>;
  localState: Ref<string>;
  localExitCode: Ref<number | null>;
  stopCommandMarkerTick: () => void;
  telnetSession: Ref<{ sessionId: string; host: string; port: number } | null>;
  telnetState: Ref<string>;
  telnetError: Ref<string>;
  serialSession: Ref<{ sessionId: string; port: string; baudRate: number } | null>;
  serialState: Ref<string>;
  serialError: Ref<string>;
}) {
  const { t, dispatchTerminalOutput, showNotice, localSession, localState, localExitCode, stopCommandMarkerTick, telnetSession, telnetState, telnetError, serialSession, serialState, serialError } = options;

const localLastSequence = ref(0);
const localPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
const localReplayInFlight = ref(false);
const localReplayNoProgress = ref(0);

const telnetLastSequence = ref(0);
const telnetPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
const telnetReplayInFlight = ref(false);
const telnetReplayNoProgress = ref(0);

const serialLastSequence = ref(0);
const serialPendingFrames = new Map<number, { stream: number; data: Uint8Array }>();
// 序号缺口回放（设计稿 §3）：与 telnet/local 的 drain/replay 体系同构，
// 复用既有 gap 检测 + 无进度重试上限，不新写恢复逻辑。
const serialReplayInFlight = ref(false);
const serialReplayNoProgress = ref(0);

const serialUnknownStreamFrames = ref(0);

function drainLocalTerminalFrames() {
  let frame = localPendingFrames.get(localLastSequence.value + 1);
  while (frame) {
    localPendingFrames.delete(localLastSequence.value + 1);
    localLastSequence.value += 1;
    if (frame.stream === 2) {
      if (new TextDecoder().decode(frame.data) === "local-terminal-exited") markLocalExited(null);
    } else {
      dispatchTerminalOutput(frame.data);
    }
    frame = localPendingFrames.get(localLastSequence.value + 1);
  }
  if (localPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    // 洪峰把有序帧一并丢弃后必须主动补拉一次：清空后 firstPending 变
    // Infinity，下面的洞检测永不触发——会话活着、输入正常、画面停在洪峰前。
    localPendingFrames.clear();
    requestLocalReplay(localLastSequence.value, null);
    return;
  }
  const firstPending = Math.min(...localPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > localLastSequence.value + 1) {
    requestLocalReplay(localLastSequence.value, firstPending - 1);
  }
}

// 本地会话统一的补发拉取：从 afterSequence 起 拉 sidecar 环形缓冲。
// complete=false 表示缓冲淘汰过帧、[hole, firstAvailable) 不可恢复——resync
// 到缓冲首帧继续收尾部（协议承诺 webview 重载可接回活 shell，判死即违背）；
// complete=true 但洞始终补不上时保留"连续三轮无进展就跳洞"的梯子。
function requestLocalReplay(holeAt: number, resyncTarget: number | null) {
  const session = localSession.value;
  if (!session || localReplayInFlight.value) return;
  localReplayInFlight.value = true;
  void window.dbxPlugin
    .invoke<FrameReplayResult>(
      "local/terminal/replay",
      { sessionId: session.sessionId, afterSequence: holeAt },
      // 启动引导路径会经过这里：桥丢响应时不能无限 pending 卡住工作台。
      { timeoutMs: 10_000 },
    )
    .then((result) => {
      if (!result.complete) {
        localLastSequence.value = Math.max(0, result.firstAvailableSequence - 1);
        return;
      }
      if (localLastSequence.value === holeAt) {
        localReplayNoProgress.value += 1;
        if (localReplayNoProgress.value >= 3 && resyncTarget !== null) {
          localLastSequence.value = resyncTarget;
          localReplayNoProgress.value = 0;
        }
      } else {
        localReplayNoProgress.value = 0;
      }
    })
    .catch(() => markLocalExited(null))
    .finally(() => {
      localReplayInFlight.value = false;
      drainLocalTerminalFrames();
    });
}

function markLocalExited(code: number | null) {
  if (!localSession.value || localState.value === "exited") return;
  localState.value = "exited";
  if (code !== null) localExitCode.value = code;
  stopCommandMarkerTick();
}

function markTelnetClosed(error: string | null) {
  if (!telnetSession.value || telnetState.value === "closed") return;
  telnetState.value = "closed";
  if (error !== null) telnetError.value = error;
}

function drainTelnetFrames() {
  let frame = telnetPendingFrames.get(telnetLastSequence.value + 1);
  while (frame) {
    telnetPendingFrames.delete(telnetLastSequence.value + 1);
    telnetLastSequence.value += 1;
    if (frame.stream === 2) {
      if (new TextDecoder().decode(frame.data) === "telnet-session-closed") markTelnetClosed(null);
    } else {
      dispatchTerminalOutput(frame.data);
    }
    frame = telnetPendingFrames.get(telnetLastSequence.value + 1);
  }
  if (telnetPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    telnetPendingFrames.clear();
  }
  const firstPending = Math.min(...telnetPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > telnetLastSequence.value + 1 && !telnetReplayInFlight.value && telnetSession.value) {
    const sessionId = telnetSession.value.sessionId;
    telnetReplayInFlight.value = true;
    const holeAt = telnetLastSequence.value;
    void window.dbxPlugin
      .invoke<FrameReplayResult>("telnet/replay", { sessionId, afterSequence: telnetLastSequence.value })
      .then((result) => {
        if (!result.complete) {
          markTelnetClosed(null);
          return;
        }
        if (telnetLastSequence.value === holeAt) {
          telnetReplayNoProgress.value += 1;
          if (telnetReplayNoProgress.value >= 3) {
            telnetLastSequence.value = firstPending - 1;
            telnetReplayNoProgress.value = 0;
          }
        } else {
          telnetReplayNoProgress.value = 0;
        }
      })
      .catch(() => markTelnetClosed(null))
      .finally(() => {
        telnetReplayInFlight.value = false;
        drainTelnetFrames();
      });
  }
}

function markSerialClosed(error: string | null) {
  if (!serialSession.value || serialState.value === "closed") return;
  serialState.value = "closed";
  if (error !== null) serialError.value = error;
}

function drainSerialFrames() {
  let frame = serialPendingFrames.get(serialLastSequence.value + 1);
  while (frame) {
    serialPendingFrames.delete(serialLastSequence.value + 1);
    serialLastSequence.value += 1;
    dispatchTerminalOutput(frame.data);
    frame = serialPendingFrames.get(serialLastSequence.value + 1);
  }
  if (serialPendingFrames.size > TERMINAL_PENDING_FRAME_LIMIT) {
    serialPendingFrames.clear();
  }
  // 序号缺口 → serial/replay（序号制回放）：重发帧从既有二进制通道到货后
  // 由同一 drain 消费；缺口永不可填（缓冲绕回/会话重建）时按无进度上限
  // resync 游标，避免 replay 循环空转冻结工作台。
  const firstPending = Math.min(...serialPendingFrames.keys());
  if (Number.isFinite(firstPending) && firstPending > serialLastSequence.value + 1 && !serialReplayInFlight.value && serialSession.value) {
    serialReplayInFlight.value = true;
    const holeAt = serialLastSequence.value;
    void window.dbxPlugin
      .invoke<FrameReplayResult>("serial/replay", { sessionId: serialSession.value.sessionId, afterSequence: serialLastSequence.value })
      .then((result) => {
        // complete: false = 缓冲已绕回、回放不完整（设计稿 §3）——提示截断。
        if (!result.complete) showNotice(t("serial.replayTruncated"));
        if (serialLastSequence.value === holeAt) {
          serialReplayNoProgress.value += 1;
          if (serialReplayNoProgress.value >= 3) {
            serialLastSequence.value = firstPending - 1;
            serialReplayNoProgress.value = 0;
          }
        } else {
          serialReplayNoProgress.value = 0;
        }
      })
      .catch(() => {
        // 会话不存在（已关闭/未重建）：resync 过缺口放出后续帧。
        if (firstPending > serialLastSequence.value) {
          serialLastSequence.value = firstPending - 1;
          serialReplayNoProgress.value = 0;
        }
      })
      .finally(() => {
        serialReplayInFlight.value = false;
        drainSerialFrames();
      });
  }
}


  return {
    localLastSequence,
    localPendingFrames,
    localReplayInFlight,
    localReplayNoProgress,
    markLocalExited,
    requestLocalReplay,
    drainLocalTerminalFrames,
    telnetLastSequence,
    telnetPendingFrames,
    telnetReplayInFlight,
    telnetReplayNoProgress,
    markTelnetClosed,
    drainTelnetFrames,
    serialLastSequence,
    serialPendingFrames,
    serialReplayInFlight,
    serialReplayNoProgress,
    serialUnknownStreamFrames,
    markSerialClosed,
    drainSerialFrames,
  };
}
