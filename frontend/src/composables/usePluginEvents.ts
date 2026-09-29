import type { Ref } from "vue";
import {
  enqueueAcceptedAgentPrompt,
  type AgentFinishPayload,
  type AgentNoticePayload,
  type AgentPromptPayload,
} from "../lib/agentTerminal";
import { reduceSerialUpload, type SerialUploadProgress, type SerialUploadUiState } from "../lib/serialUpload";
import {
  isRdpCertificateChallenge,
  reduceRdpSessionState,
  type RdpPointerEvent,
  type RdpSessionStateView,
} from "../lib/rdpFrame";
import type { ConnectLog } from "../lib/connectLog";

/** RDP 证书确认弹窗数据（App.vue 局部接口 RdpCertPrompt 按消费字段收敛）。 */
interface RdpCertPromptView {
  challengeId: string;
  sessionId: string;
  host: string;
  port: number;
  fingerprint: string;
  knownHostStatus: string;
  receivedAt: number;
}

/** 后端事件分派枢纽：sidecar/宿主 method 事件的全部分支整体收口。
 * method 键全局互斥，分支体逐字迁移、命中即 return，与原 if 链语义一致；
 * env（locale/theme）已由 hostThemeRuntime 订阅分发，入口只做窄化排除。
 * 会话/面板主干（openSession、terminalDiag 面板等）留守 App.vue 经 options
 * 注入；vnc/rdp 剪贴板节流戳与 RDP 剪贴板回写为事件侧私有，随域内迁。 */
export function usePluginEvents(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  session: Ref<{ sessionId?: string } | undefined>;
  terminalState: Ref<string>;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  showNotice: (message: string) => void;
  // 连接生命周期域
  terminalDiag: { keys: number; sends: number; acks: number; errors: number; swallowed: number };
  batchBarSourceId: string;
  applyRemoteBatchBarState: (params: { source?: string; draft?: string; quickPickId?: string; open?: boolean }) => void;
  hostKeyPrompt: Ref<unknown>;
  rdpCertPrompt: Ref<RdpCertPromptView | null>;
  rdpCertRemember: Ref<boolean>;
  connectLog: ConnectLog;
  scheduleSessionReconnect: () => void;
  reconnectPending: Ref<boolean>;
  // 本地/telnet/vnc/serial 会话域
  localSession: Ref<{ sessionId: string; shell: string } | null>;
  markLocalExited: (exitCode: number | null) => void;
  telnetSession: Ref<{ sessionId: string; host: string; port: number } | null>;
  telnetState: Ref<string>;
  telnetError: Ref<string>;
  markTelnetClosed: (error: string | null) => void;
  vncSession: Ref<{ sessionId: string; host: string; port: number } | null>;
  vncState: Ref<string>;
  vncError: Ref<string>;
  markVncClosed: (error: string | null) => void;
  serialSession: Ref<{ sessionId: string; port: string; baudRate: number } | null>;
  markSerialClosed: (error: string | null) => void;
  serialUpload: Ref<SerialUploadUiState>;
  // RDP 会话域
  rdpSession: Ref<{ sessionId: string; host: string; port: number } | null>;
  rdpState: Ref<RdpSessionStateView>;
  rdpSurface: Ref<{ applyPointer(event: RdpPointerEvent): void } | null>;
  rdpClipboardChunks: Map<string, { parts: string[]; received: number }>;
  // Agent / 录制域
  agentPromptQueue: Ref<AgentPromptPayload[]>;
  agentRunning: Ref<AgentNoticePayload | undefined>;
  recordingActive: Ref<boolean>;
  startRecordingClock: () => void;
  // SFTP/传输域
  handleWatchModified: (watchId: string) => void;
  uploadAckWaiters: Map<string, { nextOffset: number; resolve: () => void; reject: (error: Error) => void; timer: number }>;
  updateTransfer: (params: Record<string, unknown>) => void;
}) {
  const {
    t,
    session,
    terminalState,
    showError,
    showNotice,
    terminalDiag,
    batchBarSourceId,
    applyRemoteBatchBarState,
    hostKeyPrompt,
    rdpCertPrompt,
    rdpCertRemember,
    connectLog,
    scheduleSessionReconnect,
    reconnectPending,
    localSession,
    markLocalExited,
    telnetSession,
    telnetState,
    telnetError,
    markTelnetClosed,
    vncSession,
    vncState,
    vncError,
    markVncClosed,
    serialSession,
    markSerialClosed,
    serialUpload,
    rdpSession,
    rdpState,
    rdpSurface,
    rdpClipboardChunks,
    agentPromptQueue,
    agentRunning,
    recordingActive,
    startRecordingClock,
    handleWatchModified,
    uploadAckWaiters,
    updateTransfer,
  } = options;

  // 远端 → 本地剪贴板回写的节流戳（8s 内只提示一次）。
  let vncClipboardNoticeAt = 0;
  let rdpClipboardNoticeAt = 0;

  // 完整文本（含分片拼接结果）回写本地剪贴板 + 节流提示（与 VNC 同款）。
  function writeRdpClipboard(text: string): void {
    if (!text) return;
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        if (Date.now() - rdpClipboardNoticeAt > 8000) {
          rdpClipboardNoticeAt = Date.now();
          showNotice(t("rdp.clipboardReceived"));
        }
      })
      .catch(() => undefined);
  }

  function handlePluginEvent(event: DbxPluginEvent) {
    // env（locale/theme）由 shared/frontend/hostThemeRuntime 的订阅分发；
    // 此处只做窄化排除，后端事件走下方 method 分派。
    if (event.type === "env") return;
    if (event.method === "ssh/terminal/inputAck") {
      terminalDiag.acks += 1;
      return;
    }
    if (event.method === "ssh/batchBar/state") {
      const params = event.params as { source?: string; draft?: string; quickPickId?: string; open?: boolean };
      if (params.source && params.source !== batchBarSourceId) applyRemoteBatchBarState(params);
      return;
    }
    if (event.method === "ssh/host-key/prompt" || event.method === "connection/challenge") {
      // RDP 证书确认（kind=rdp-certificate）路由到专属弹窗：SHA256 指纹 +
      // knownHostStatus + 120s 倒计时；其余挑战沿用 host-key 弹窗。
      const challengeParams = event.params as Record<string, unknown>;
      if (isRdpCertificateChallenge(challengeParams)) {
        rdpCertPrompt.value = {
          challengeId: String(challengeParams.challengeId),
          sessionId: String(challengeParams.sessionId || ""),
          host: String(challengeParams.host || ""),
          port: Number(challengeParams.port) || 3389,
          fingerprint: String(challengeParams.fingerprint || ""),
          knownHostStatus: String(challengeParams.knownHostStatus || "unknown"),
          receivedAt: Date.now(),
        };
        rdpCertRemember.value = false;
        return;
      }
      hostKeyPrompt.value = event.params;
      connectLog.push("info", t("connectCard.log.hostKeyPrompt"));
      return;
    }
    if (event.method === "ssh/host-key/notice") {
      showError(String(event.params.message || "SSH host-key warning"), "terminal");
      return;
    }
    // Auto 认证（M13-A）逐方式进度：sidecar 在按序回退中每跳过一个/失败一个
    // 方式就发一条；对齐 host-key 通知渲染进连接卡片的 Show logs 面板。事件
    // 不带 sessionId（连接尚未建立），按当前连接/操作上下文过滤。
    if (event.method === "ssh/auth/auto") {
      const params = event.params as { method?: string; status?: string; detail?: string; operationId?: string };
      const method = params.method || "unknown";
      const detail = params.detail || "";
      connectLog.push(params.status === "skipped" ? "info" : "warn", t("connectCard.log.authAuto", { method, detail }));
      return;
    }
    if (event.method === "ssh/session/state" && event.params.sessionId === session.value?.sessionId) {
      if (event.params.state === "disconnected") {
        // Transport dropped (network flap, server restart): auto-reconnect with
        // a bounded backoff ladder instead of parking on a dead terminal.
        scheduleSessionReconnect();
      }
      return;
    }
    // Input hit a session the sidecar no longer has (host-pushed disconnect the
    // tab missed, sidecar restart): the terminal still looks alive but every
    // keystroke is swallowed. The sidecar mirrors binary-handler failures as
    // this event; treat it as the same transport-drop ladder. Guarded so a
    // reconnect already in flight is not double-scheduled.
    if (event.method === "ssh/terminal/error" && event.params.sessionId === session.value?.sessionId) {
      if (terminalState.value === "connected" && !reconnectPending.value) {
        scheduleSessionReconnect();
      }
      return;
    }
    if (event.method === "local/session/state" && event.params.sessionId === localSession.value?.sessionId) {
      if (event.params.state === "exited") {
        markLocalExited(typeof event.params.exitCode === "number" ? event.params.exitCode : null);
      }
      return;
    }
    // 输入打进已被 sidecar 回收的本地会话：立即落退出态（覆盖层给重开出口）。
    if (event.method === "local/terminal/error" && event.params.sessionId === localSession.value?.sessionId) {
      markLocalExited(null);
      return;
    }
    // Telnet 生命周期：connecting → connected → closed（error 附带原因文本，
    // 只在退出覆盖层展示）。侧边触发引擎反馈与 ssh/trigger 同构（无应答内容）。
    if (event.method === "telnet/session/state" && event.params.sessionId === telnetSession.value?.sessionId) {
      const state = String(event.params.state || "");
      if (state === "connected") {
        telnetState.value = "running";
        telnetError.value = "";
      } else if (state === "connecting") {
        telnetState.value = "connecting";
      } else if (state === "closed" || state === "error") {
        markTelnetClosed(state === "error" ? String(event.params.error || "") : "");
      }
      return;
    }
    if (event.method === "telnet/terminal/error" && event.params.sessionId === telnetSession.value?.sessionId) {
      markTelnetClosed(null);
      return;
    }
    // VNC 生命周期：connecting → connected → closed/error（error 附带原因）。
    // 远端剪贴板更新回写本地（iframe 沙箱可能拒绝剪贴板写，尽力而为）。
    if (event.method === "vnc/session/state" && event.params.sessionId === vncSession.value?.sessionId) {
      const state = String(event.params.state || "");
      if (state === "connected") {
        vncState.value = "running";
        vncError.value = "";
      } else if (state === "connecting") {
        vncState.value = "connecting";
      } else if (state === "closed" || state === "error") {
        markVncClosed(state === "error" ? String(event.params.error || "") : "");
      }
      return;
    }
    if (event.method === "vnc/clipboard" && event.params.sessionId === vncSession.value?.sessionId) {
      const text = typeof event.params.text === "string" ? event.params.text : "";
      if (text) {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            // 远端复制频繁时节流提示（8s 内只提示一次）。
            if (Date.now() - vncClipboardNoticeAt > 8000) {
              vncClipboardNoticeAt = Date.now();
              showNotice(t("vnc.clipboardReceived"));
            }
          })
          .catch(() => undefined);
      }
      return;
    }
    // RDP 生命周期（RDP-3 前端）：connecting → connected → (reconnecting →)
    // connected/closed，errorKind/error 文本在退出覆盖层展示；重连退避进度
    // （attempt/maxAttempts）驱动 reconnecting 状态条。状态折叠走纯 reducer。
    if (event.method === "rdp/session/state" && event.params.sessionId === rdpSession.value?.sessionId) {
      rdpState.value = reduceRdpSessionState(rdpState.value, event.params as Record<string, unknown>);
      return;
    }
    // 远端 → 本地剪贴板（text-only，CF_UNICODETEXT）：回写本地 + 节流提示，与 VNC 同款。
    // 超大文本按后端分片（chunkIndex/chunkTotal）拼接完整后再回写（C2）。
    if (event.method === "rdp/clipboard" && event.params.sessionId === rdpSession.value?.sessionId) {
      const params = event.params as Record<string, unknown>;
      const sessionId = String(params.sessionId ?? "");
      const text = typeof params.text === "string" ? params.text : "";
      const total = typeof params.chunkTotal === "number" && params.chunkTotal > 1 ? params.chunkTotal : 1;
      const index = typeof params.chunkIndex === "number" ? params.chunkIndex : 0;
      if (total > 1) {
        let buffer = rdpClipboardChunks.get(sessionId);
        if (!buffer || buffer.parts.length !== total) {
          buffer = { parts: new Array<string>(total).fill(""), received: 0 };
          rdpClipboardChunks.set(sessionId, buffer);
        }
        if (buffer.parts[index] === "") {
          buffer.parts[index] = text;
          buffer.received += 1;
        }
        if (buffer.received < total) return;
        rdpClipboardChunks.delete(sessionId);
        writeRdpClipboard(buffer.parts.join(""));
        return;
      }
      writeRdpClipboard(text);
      return;
    }
    // 服务端光标形状（default/hidden/position/bitmap）：落到画布 CSS cursor。
    if (event.method === "rdp/pointer" && event.params.sessionId === rdpSession.value?.sessionId) {
      rdpSurface.value?.applyPointer(event.params as unknown as RdpPointerEvent);
      return;
    }
    // 串口生命周期：start 成功即 running；sidecar 只发 closed（主动关闭）与
    // error（读线程 IO 失败）两种状态事件。
    if (event.method === "serial/session/state" && event.params.sessionId === serialSession.value?.sessionId) {
      const state = String(event.params.state || "");
      if (state === "error") {
        markSerialClosed(String(event.params.error || ""));
      } else if (state === "closed") {
        markSerialClosed(null);
      }
      return;
    }
    // 串口文件上传进度（NyaTerm 对齐 P0-3）：sidecar 引擎事件 → overlay 状态。
    if (event.method === "serial/upload/progress" && event.params.sessionId === serialSession.value?.sessionId) {
      serialUpload.value = reduceSerialUpload(serialUpload.value, event.params as unknown as SerialUploadProgress);
      return;
    }
    if (event.method === "telnet/trigger" && event.params.sessionId === telnetSession.value?.sessionId) {
      const payload = event.params as { sessionId?: string; stage?: number; kind?: string };
      const stage = Math.max(1, Number(payload.stage) || 1);
      showNotice(t(payload.kind === "timeout" ? "telnet.triggerTimeout" : "telnet.triggerAnswered", { stage }));
      return;
    }
    // 声明式自动登录监督（P0-1）：sidecar 只带 status/attempt（无内容，
    // D6 语义），成功/重试文案在这里本地化；重试超限走既有退出覆盖层。
    if (event.method === "telnet/auto_login" && event.params.sessionId === telnetSession.value?.sessionId) {
      const payload = event.params as { status?: string; attempt?: number };
      if (payload.status === "success") {
        showNotice(t("telnet.declSuccessNotice"));
      } else if (payload.status === "retry") {
        showNotice(t("telnet.declRetryNotice", { attempt: Math.max(1, Number(payload.attempt) || 1) }));
      }
      return;
    }
    // MCP confirm-mode prompts are process-level (no sessionId), while ordinary
    // SSH prompts must remain isolated to the active SSH session.
    if (event.method === "ssh/agent/prompt") {
      const prompt = event.params as unknown as AgentPromptPayload;
      const nextQueue = enqueueAcceptedAgentPrompt(agentPromptQueue.value, prompt, session.value?.sessionId);
      if (nextQueue.length === agentPromptQueue.value.length && !agentPromptQueue.value.some((item) => item.challengeId === prompt.challengeId)) {
        return;
      }
      agentPromptQueue.value = nextQueue;
      return;
    }
    if (event.method === "ssh/agent/notice" && event.params.sessionId === session.value?.sessionId) {
      agentRunning.value = event.params as unknown as AgentNoticePayload;
      return;
    }
    if (event.method === "ssh/agent/finish" && event.params.sessionId === session.value?.sessionId) {
      const payload = event.params as unknown as AgentFinishPayload;
      agentRunning.value = undefined;
      showNotice(t(payload.status === "denied" ? "agentDenied" : "agentFinished"));
      return;
    }
    // Trigger engine feedback (expect-style auto interaction): the payload never
    // carries the answered content (sidecar contract), only stage/kind. Events
    // for sessions other than the open one are dropped silently.
    if (event.method === "ssh/trigger" && event.params.sessionId === session.value?.sessionId) {
      const payload = event.params as { sessionId?: string; stage?: number; kind?: string };
      const stage = Math.max(1, Number(payload.stage) || 1);
      showNotice(t(payload.kind === "timeout" ? "triggerTimeout" : "triggerAnswered", { stage }));
      return;
    }
    // ZMODEM 触发检测（#90）：sidecar 在 PTY 输出里识别到远端 sz 发起的
    // ZRQINIT 会话启动序列，协议帧已在 sidecar 侧抑制（不进终端渲染，也
    // 不再走前端 sentry 的静默 deny），这里只把「改用 SFTP 下载」的提示浮
    // 出来。负载仅含 sessionId/kind，不携带任何协议字节。
    if (event.method === "ssh/zmodem" && event.params.sessionId === session.value?.sessionId) {
      showNotice(t("zmodemDownloadUnsupported"));
      return;
    }
    // 会话自动录制（M14）：sidecar 在 open_session 时按 auto_record 偏好自动
    // 挂录制器（或因录制已在进行而跳过），事件每次只发一次，负载仅含 id。
    if (event.method === "ssh/recording/auto" && event.params.sessionId === session.value?.sessionId) {
      const payload = event.params as { sessionId?: string; recordingId?: string; skipped?: boolean };
      if (payload.skipped) {
        showNotice(t("recordingAutoSkipped"));
      } else {
        recordingActive.value = true;
        startRecordingClock();
        showNotice(t("recordingAutoStarted"));
      }
      return;
    }
    if (event.method === "watch/file-modified") {
      const payload = event.params as { watchId?: string };
      const watchId = String(payload.watchId || "");
      if (watchId) handleWatchModified(watchId);
      return;
    }
    if (event.method === "sftp/upload/ack") {
      const taskId = String(event.params.taskId || "");
      const waiter = uploadAckWaiters.get(taskId);
      if (waiter && Number(event.params.nextOffset) === waiter.nextOffset) {
        window.clearTimeout(waiter.timer);
        uploadAckWaiters.delete(taskId);
        waiter.resolve();
      }
      return;
    }
    // sidecar 拒收上传分片（offset 失配/任务丢失/spool 写失败）时立即失败在途
    // ack 等待器，不再等满 30s 超时后才用一个含糊的 ack-timeout 收场（issue #60）。
    if (event.method === "sftp/upload/error") {
      const taskId = String(event.params.taskId || "");
      const waiter = uploadAckWaiters.get(taskId);
      if (waiter) {
        window.clearTimeout(waiter.timer);
        uploadAckWaiters.delete(taskId);
        waiter.reject(Object.assign(new Error(String(event.params.error || "upload rejected")), { code: "upload-append-failed" }));
      }
      return;
    }
    if (event.method === "sftp/transfer/progress") updateTransfer(event.params);
  }

  return { handlePluginEvent };
}
