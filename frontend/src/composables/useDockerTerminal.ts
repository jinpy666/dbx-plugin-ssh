/**
 * 容器终端组合式（B5）：`docker/terminal/open` + 二进制输出订阅 + 输入队列。
 *
 * 订阅先于 RPC：`requestedTerminalId` 由前端生成并先挂 `onBinary` 监听，
 * open 返回前到达的帧不会丢（与 `requestedStreamId` 同款先例）。close /
 * 卸载 / 重新 open 都用 generation 号作废旧闭包，保证「已关闭仍 emit」
 * 不会传到渲染层。键入复用 `createTerminalInputQueue`：它负责 8 字节序号
 * 与串行发送，只打到 `docker/terminal/in/{id}`（绝不落进 ssh 通道）。
 */

import { onScopeDispose, ref, type Ref } from "vue";
import {
  DOCKER_TERMINAL_STATE,
  decodeDockerTerminalFrame,
  decodeDockerTerminalReplayFrame,
  dockerTerminalOutChannel,
  dockerTerminalInChannel,
  type DockerTerminalFrame,
} from "../lib/dockerTerminalFrames";
import { createTerminalInputQueue, type TerminalInputQueue } from "../lib/terminalInputQueue";

export const DOCKER_TERMINAL_OPEN_TIMEOUT_MS = 20_000;
export const DOCKER_TERMINAL_CLOSE_TIMEOUT_MS = 10_000;
const MAX_QUEUED_FRAMES = 512;

export interface UseDockerTerminalOptions {
  onData: (data: Uint8Array) => void;
  onEnd?: (reason: string, exitCode: number | null) => void;
  onError?: (error: string) => void;
  invoke?: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
  api?: () => typeof window.dbxPlugin | undefined;
}

export interface DockerTerminalHandle {
  active: Ref<boolean>;
  terminalId: Ref<string>;
  error: Ref<string>;
  endedReason: Ref<string>;
  exitCode: Ref<number | null>;
  open(params: Record<string, unknown>): Promise<boolean>;
  close(): Promise<void>;
  sendInput(data: Uint8Array): void;
  resize(cols: number, rows: number): Promise<void>;
  replay(afterSequence?: number): Promise<void>;
}

let terminalSequence = 0;

/** 可复用的客户端 terminal id（注册表键与通道后缀的安全字符集）。 */
export function nextDockerTerminalId(now: number = Date.now()): string {
  terminalSequence += 1;
  return `docker-term-${now.toString(36)}-${terminalSequence}`;
}

export function useDockerTerminal(options: UseDockerTerminalOptions): DockerTerminalHandle {
  const active = ref(false);
  const terminalId = ref("");
  const error = ref("");
  const endedReason = ref("");
  const exitCode = ref<number | null>(null);

  let generation = 0;
  let unsubscribeBinary: (() => void) | undefined;
  let unsubscribeEvent: (() => void) | undefined;
  let inputQueue: TerminalInputQueue | undefined;
  let queued: DockerTerminalFrame[] = [];
  let flushScheduled = false;

  const invoke =
    options.invoke ??
    ((method, params, runOptions) =>
      Promise.resolve(window.dbxPlugin.invoke(method, params, runOptions)));
  const api = options.api ?? (() => window.dbxPlugin);

  function detach(): void {
    unsubscribeBinary?.();
    unsubscribeEvent?.();
    unsubscribeBinary = undefined;
    unsubscribeEvent = undefined;
    queued = [];
    flushScheduled = false;
  }

  function flushNow(): void {
    if (!queued.length) return;
    const frames = queued;
    queued = [];
    // state 帧不进终端；data 帧按到达顺序交给调用方（App 侧已合帧/限流）。
    for (const frame of frames) {
      if (frame.stream === DOCKER_TERMINAL_STATE) continue;
      options.onData(frame.data);
    }
  }

  function scheduleFlush(mine: number): void {
    if (flushScheduled) return;
    if (queued.length >= MAX_QUEUED_FRAMES) {
      flushNow();
      return;
    }
    flushScheduled = true;
    const run = () => {
      flushScheduled = false;
      if (mine !== generation) return;
      flushNow();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function enqueue(frame: DockerTerminalFrame, mine: number): void {
    if (mine !== generation) return;
    if (frame.stream === DOCKER_TERMINAL_STATE) return;
    queued.push(frame);
    scheduleFlush(mine);
  }

  async function open(params: Record<string, unknown>): Promise<boolean> {
    await close();
    const mine = ++generation;
    const requested = nextDockerTerminalId();
    terminalId.value = requested;
    error.value = "";
    endedReason.value = "";
    exitCode.value = null;
    const host = api();
    if (!host) {
      error.value = "Host API unavailable";
      options.onError?.(error.value);
      return false;
    }
    inputQueue = createTerminalInputQueue({
      send: (id, payload) => host.sendBinary(dockerTerminalInChannel(id), payload),
      onError: (cause) => {
        if (mine !== generation) return;
        error.value = cause instanceof Error ? cause.message : String(cause);
        options.onError?.(error.value);
      },
    });
    unsubscribeBinary = host.onBinary((event) => {
      if (mine !== generation) return;
      if (event.channel !== dockerTerminalOutChannel(requested)) return;
      const bytes = event.data ?? (event.dataBase64 ? host.decodeBase64(event.dataBase64) : undefined);
      const frame = decodeDockerTerminalFrame(bytes);
      if (frame) enqueue(frame, mine);
    });
    unsubscribeEvent = host.onEvent((event) => {
      if (mine !== generation) return;
      if (!("method" in event)) return;
      const payload = (event.params ?? {}) as Record<string, unknown>;
      if (payload.terminalId !== requested) return;
      if (event.method === "docker/terminal/end") {
        flushNow();
        generation += 1;
        active.value = false;
        endedReason.value = typeof payload.reason === "string" ? payload.reason : "exited";
        exitCode.value = typeof payload.exitCode === "number" ? payload.exitCode : null;
        detach();
        options.onEnd?.(endedReason.value, exitCode.value);
        return;
      }
      if (event.method === "docker/terminal/error") {
        error.value = typeof payload.error === "string" ? payload.error : "container terminal failed";
        options.onError?.(error.value);
      }
    });
    active.value = true;
    try {
      const response = await invoke(
        "docker/terminal/open",
        { ...params, requestedTerminalId: requested },
        { timeoutMs: DOCKER_TERMINAL_OPEN_TIMEOUT_MS },
      );
      if (mine !== generation) return false;
      const body = (response ?? {}) as Record<string, unknown>;
      if (typeof body.terminalId === "string" && body.terminalId) terminalId.value = body.terminalId;
      // open 返回的 replay 是 base64 帧（重连补发）；与实时帧同路渲染。
      if (Array.isArray(body.replay)) {
        for (const raw of body.replay) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          const frame = decodeDockerTerminalReplayFrame(
            item.sequence,
            item.dataBase64,
            (value) => host.decodeBase64(value),
          );
          if (frame) enqueue(frame, mine);
        }
      }
      return true;
    } catch (cause) {
      if (mine !== generation) return false;
      error.value = cause instanceof Error ? cause.message : String(cause);
      active.value = false;
      detach();
      options.onError?.(error.value);
      return false;
    }
  }

  async function close(): Promise<void> {
    const id = terminalId.value;
    generation += 1;
    active.value = false;
    detach();
    inputQueue?.reset();
    inputQueue = undefined;
    terminalId.value = "";
    if (!id) return;
    try {
      await invoke("docker/terminal/close", { terminalId: id }, { timeoutMs: DOCKER_TERMINAL_CLOSE_TIMEOUT_MS });
    } catch {
      // close 幂等；旧 sidecar 缺方法时静默降级（runner 由 TTL 兜底）。
    }
  }

  function sendInput(data: Uint8Array): void {
    const id = terminalId.value;
    if (!id || !active.value || !inputQueue || data.byteLength === 0) return;
    inputQueue.enqueue(id, data);
  }

  async function resize(cols: number, rows: number): Promise<void> {
    const id = terminalId.value;
    if (!id) return;
    try {
      await invoke("docker/terminal/resize", { terminalId: id, cols, rows });
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      options.onError?.(error.value);
    }
  }

  async function replay(afterSequence = 0): Promise<void> {
    const id = terminalId.value;
    if (!id) return;
    try {
      await invoke("docker/terminal/replay", { terminalId: id, afterSequence });
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      options.onError?.(error.value);
    }
  }

  onScopeDispose(() => {
    void close();
  });

  return { active, terminalId, error, endedReason, exitCode, open, close, sendInput, resize, replay };
}
