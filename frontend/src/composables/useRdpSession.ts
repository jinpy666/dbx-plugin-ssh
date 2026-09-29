import { nextTick, ref, watch, type Ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import type { RdpConnectOptions } from "../components/RdpConnectDialog.vue";
import {
  initialRdpSessionState,
  rdpCertRemainingSecs,
  type RdpInputEvent,
  type RdpSessionStateView,
} from "../lib/rdpFrame";

/** RDP 证书确认弹窗数据（原 App.vue 局部接口 RdpCertPrompt，随状态收口）。 */
export interface RdpCertPromptView {
  challengeId: string;
  sessionId: string;
  host: string;
  port: number;
  fingerprint: string;
  knownHostStatus: string;
  receivedAt: number;
}

/** RDP 会话生命周期 + 证书确认域：start/close/reconnect/输入与剪贴板回写
 * 四个 RPC 出口、rdp-certificate 挑战的 120s 倒计时弹窗（fail-closed，超时
 * 即拒绝，与 sidecar 两侧语义一致）。rdpSession/rdpState/rdpSurface 等
 * 模板共享态留守 App.vue，经 options 注入；rdpClipboardChunks 因卸载清理
 * 仍在 App.vue，同样透传。terminal/disposed 为每会话可变量，以 getter 取。 */
export function useRdpSession(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  showNotice: (message: string) => void;
  rdpSession: Ref<{ sessionId: string; host: string; port: number } | null>;
  rdpState: Ref<RdpSessionStateView>;
  rdpSurface: Ref<{ reset(): void; $el?: any } | null>;
  rdpScaleMode: Ref<RdpConnectOptions["scaleMode"]>;
  rdpClipboardChunks: Map<string, { parts: string[]; received: number }>;
  workbenchId: Ref<string>;
  isDisposed: () => boolean;
  getTerminal: () => Terminal | undefined;
}) {
  const {
    t,
    showError,
    showNotice,
    rdpSession,
    rdpState,
    rdpSurface,
    rdpScaleMode,
    rdpClipboardChunks,
    workbenchId,
    isDisposed,
    getTerminal,
  } = options;

  // RDP 证书确认（connection/challenge kind=rdp-certificate，RDP-3 前端）：
  // 复用 host-key 挑战的 kind 分支入口，展示 SHA256 指纹 + 120s 倒计时 +
  // remember 勾选；应答走 rdp/certificate/resolve（fail-closed，超时即拒绝）。
  const rdpCertPrompt = ref<RdpCertPromptView | null>(null);
  const rdpCertRemember = ref(false);
  const rdpCertRemaining = ref(0);
  let rdpCertTimer = 0;

  async function startRdpSession(options: RdpConnectOptions): Promise<boolean> {
    // 同一终端视图互斥：残留的 closed 会话先清场再开新连接。
    if (rdpSession.value && rdpState.value.state !== "closed") await closeRdpSession();
    try {
      const info = await window.dbxPlugin.invoke<{ sessionId: string; host: string; port: number }>("rdp/start", {
        workbenchId: workbenchId.value,
        host: options.host,
        port: options.port,
        username: options.username,
        width: options.width,
        height: options.height,
        certificatePolicy: options.certificatePolicy,
        clipboard: options.clipboard,
        ...(options.password ? { password: options.password } : {}),
        ...(options.domain ? { domain: options.domain } : {}),
      });
      if (isDisposed()) {
        void window.dbxPlugin.invoke("rdp/close", { sessionId: info.sessionId }).catch(() => undefined);
        return false;
      }
      rdpSession.value = { sessionId: info.sessionId, host: info.host, port: info.port };
      rdpScaleMode.value = options.scaleMode;
      rdpState.value = { state: "connecting", error: "", errorKind: "", attempt: 0, maxAttempts: 0 };
      rdpSurface.value?.reset();
      await nextTick();
      rdpSurface.value?.$el?.querySelector("canvas")?.focus();
      return true;
    } catch (cause) {
      showError(cause, "terminal");
      return false;
    }
  }

  async function closeRdpSession() {
    const sessionId = rdpSession.value?.sessionId;
    rdpSession.value = null;
    rdpState.value = initialRdpSessionState();
    dismissRdpCertPrompt();
    rdpClipboardChunks.delete(sessionId ?? "");
    if (!sessionId) return;
    await window.dbxPlugin.invoke("rdp/close", { sessionId }).catch(() => undefined);
    getTerminal()?.focus();
  }

  function sendRdpInput(event: RdpInputEvent) {
    const sessionId = rdpSession.value?.sessionId;
    if (!sessionId) return;
    void window.dbxPlugin.invoke("rdp/input", { sessionId, ...event }).catch(() => undefined);
  }

  function sendRdpClipboard(text: string) {
    const sessionId = rdpSession.value?.sessionId;
    if (!sessionId || !text) return;
    void window.dbxPlugin.invoke("rdp/set-clipboard", { sessionId, text }).catch(() => undefined);
    showNotice(t("rdp.clipboardSent"));
  }

  // 手动重连（graceful disconnect / 终态错误后的出口）：generation 递增由
  // sidecar 负责，前端只触发并让 rdp/session/state 事件驱动状态条。
  async function reconnectRdpSession() {
    const sessionId = rdpSession.value?.sessionId;
    if (!sessionId) return;
    try {
      await window.dbxPlugin.invoke("rdp/reconnect", { sessionId });
    } catch (cause) {
      showError(cause, "terminal");
    }
  }

  // —— RDP 证书确认（rdp-certificate challenge）：120s 倒计时 + fail-closed ——
  // 倒计时基于队首 receivedAt + 120s 绝对期限（与 AI 审批弹窗同一 tick 模式），
  // 到 0 仅关弹窗——sidecar 侧超时同样拒绝该挑战，两侧语义一致。
  watch(rdpCertPrompt, (prompt) => {
    if (rdpCertTimer) {
      window.clearInterval(rdpCertTimer);
      rdpCertTimer = 0;
    }
    if (!prompt) {
      rdpCertRemaining.value = 0;
      return;
    }
    const tick = () => {
      const current = rdpCertPrompt.value;
      if (!current) return;
      rdpCertRemaining.value = rdpCertRemainingSecs(current.receivedAt, Date.now());
      if (rdpCertRemaining.value <= 0) dismissRdpCertPrompt();
    };
    tick();
    rdpCertTimer = window.setInterval(tick, 250);
  });

  // 挑战一次性：先出弹窗再 resolve（超时/取消/未知 id 一律按拒绝处理）。
  function dismissRdpCertPrompt() {
    if (rdpCertTimer) {
      window.clearInterval(rdpCertTimer);
      rdpCertTimer = 0;
    }
    rdpCertPrompt.value = null;
    rdpCertRemaining.value = 0;
  }

  async function resolveRdpCertificate(accept: boolean) {
    const prompt = rdpCertPrompt.value;
    if (!prompt) return;
    const remember = accept && rdpCertRemember.value;
    dismissRdpCertPrompt();
    try {
      await window.dbxPlugin.invoke("rdp/certificate/resolve", {
        challengeId: prompt.challengeId,
        accept,
        remember,
      });
    } catch (cause) {
      showError(cause, "terminal");
    }
  }

  return {
    rdpCertPrompt,
    rdpCertRemember,
    rdpCertRemaining,
    startRdpSession,
    closeRdpSession,
    sendRdpInput,
    sendRdpClipboard,
    reconnectRdpSession,
    resolveRdpCertificate,
  };
}
