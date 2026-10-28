import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { initialSerialUploadState, type SerialUploadUiState } from "../lib/serialUpload";
import { usePluginEvents } from "./usePluginEvents";

/** issue #193a 回归锁：会话生命周期事件按 sessionId 严格隔离。关闭/断开某个
 * tab（或 dock 终端）时，sidecar 对该会话的 disconnected 事件绝不能让持有其他
 * 会话的兄弟工作台进入重连梯子；只有事件 sessionId 与本工作台当前会话一致才
 * 触发 scheduleSessionReconnect。 */

function serialUploadState(): SerialUploadUiState {
  return initialSerialUploadState();
}

type HarnessOptions = Partial<Parameters<typeof usePluginEvents>[0]>;

function buildHarness(overrides: HarnessOptions = {}) {
  const scheduleSessionReconnect = vi.fn();
  const options: Parameters<typeof usePluginEvents>[0] = {
    t: (key: string) => key,
    session: ref<{ sessionId?: string } | undefined>({ sessionId: "session-A" }),
    terminalState: ref("connected"),
    showError: vi.fn(),
    showNotice: vi.fn(),
    terminalDiag: { keys: 0, sends: 0, acks: 0, errors: 0, swallowed: 0 },
    batchBarSourceId: "source-1",
    applyRemoteBatchBarState: vi.fn(),
    hostKeyPrompt: ref(null),
    rdpCertPrompt: ref(null),
    rdpCertRemember: ref(false),
    connectLog: { entries: ref([]), push: vi.fn(), clear: vi.fn() },
    scheduleSessionReconnect,
    cancelSessionReconnect: vi.fn(),
    reconnectPending: ref(false),
    localSession: ref<{ sessionId: string; shell: string } | null>(null),
    markLocalExited: vi.fn(),
    telnetSession: ref<{ sessionId: string; host: string; port: number } | null>(null),
    telnetState: ref(""),
    telnetError: ref(""),
    markTelnetClosed: vi.fn(),
    vncSession: ref<{ sessionId: string; host: string; port: number } | null>(null),
    vncState: ref(""),
    vncError: ref(""),
    markVncClosed: vi.fn(),
    serialSession: ref<{ sessionId: string; port: string; baudRate: number } | null>(null),
    markSerialClosed: vi.fn(),
    serialUpload: ref(serialUploadState()),
    rdpSession: ref<{ sessionId: string; host: string; port: number } | null>(null),
    rdpState: ref({ state: "idle", error: "", errorKind: "", attempt: 0, maxAttempts: 0 }),
    rdpSurface: ref(null),
    rdpClipboardChunks: new Map(),
    agentPromptQueue: ref([]),
    agentRunning: ref(undefined),
    recordingActive: ref(false),
    startRecordingClock: vi.fn(),
    handleWatchModified: vi.fn(),
    uploadAckWaiters: new Map(),
    updateTransfer: vi.fn(),
    ...overrides,
  };
  return { handlePluginEvent: usePluginEvents(options).handlePluginEvent, scheduleSessionReconnect };
}

function backendEvent(method: string, params: Record<string, unknown>) {
  return { method, params } as unknown as Parameters<ReturnType<typeof usePluginEvents>["handlePluginEvent"]>[0];
}

describe("usePluginEvents session lifecycle isolation (issue #193a)", () => {
  it("ignores a sibling session's disconnected event and schedules reconnect only for its own session", () => {
    const { handlePluginEvent, scheduleSessionReconnect } = buildHarness();

    // 用户关掉另一个 tab：sidecar 对「那个」会话发 disconnected——本工作台不得反应。
    handlePluginEvent(backendEvent("ssh/session/state", { sessionId: "session-B", state: "disconnected" }));
    expect(scheduleSessionReconnect).not.toHaveBeenCalled();

    // 自己的传输断开才进重连梯子。
    handlePluginEvent(backendEvent("ssh/session/state", { sessionId: "session-A", state: "disconnected" }));
    expect(scheduleSessionReconnect).toHaveBeenCalledTimes(1);
  });

  it("cancels reconnect after an intentional connection delete but keeps transport recovery", () => {
    const cancelSessionReconnect = vi.fn();
    const { handlePluginEvent, scheduleSessionReconnect } = buildHarness({ cancelSessionReconnect });

    handlePluginEvent(backendEvent("ssh/session/state", { sessionId: "session-A", state: "disconnected", reason: "connection-disconnect" }));
    expect(cancelSessionReconnect).toHaveBeenCalledTimes(1);
    expect(scheduleSessionReconnect).not.toHaveBeenCalled();

    handlePluginEvent(backendEvent("ssh/session/state", { sessionId: "session-A", state: "disconnected" }));
    expect(scheduleSessionReconnect).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when the workbench has no session bound", () => {
    const { handlePluginEvent, scheduleSessionReconnect } = buildHarness({
      session: ref<{ sessionId?: string } | undefined>(undefined),
    });
    handlePluginEvent(backendEvent("ssh/session/state", { sessionId: "session-A", state: "disconnected" }));
    expect(scheduleSessionReconnect).not.toHaveBeenCalled();
  });

  it("keeps ssh/terminal/error scoped to the owning session as well", () => {
    const { handlePluginEvent, scheduleSessionReconnect } = buildHarness();
    handlePluginEvent(backendEvent("ssh/terminal/error", { sessionId: "session-B", error: "gone" }));
    expect(scheduleSessionReconnect).not.toHaveBeenCalled();
    handlePluginEvent(backendEvent("ssh/terminal/error", { sessionId: "session-A", error: "gone" }));
    expect(scheduleSessionReconnect).toHaveBeenCalledTimes(1);
  });

  it("routes local shell exit events only for the local session this workbench owns", () => {
    const markLocalExited = vi.fn();
    const localSession = ref<{ sessionId: string; shell: string } | null>({ sessionId: "local-1", shell: "/bin/zsh" });
    const { handlePluginEvent } = buildHarness({ localSession, markLocalExited });
    handlePluginEvent(backendEvent("local/session/state", { sessionId: "local-2", state: "exited", exitCode: 0 }));
    expect(markLocalExited).not.toHaveBeenCalled();
    handlePluginEvent(backendEvent("local/session/state", { sessionId: "local-1", state: "exited", exitCode: 0 }));
    expect(markLocalExited).toHaveBeenCalledTimes(1);
  });
});
