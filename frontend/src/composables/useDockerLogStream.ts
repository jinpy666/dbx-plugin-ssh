/**
 * Docker 日志流组合式（B3）：发起 `docker/logs/stream/start`、订阅二进制
 * `docker/logs/out/{streamId}`、处理 `end` / `error` / 降级 `chunk`。
 *
 * 订阅先于 RPC：`requestedStreamId` 由前端生成并先挂监听，start 返回前
 * 到达的帧不会丢（与 `requestedSessionId` 同款先例）。stop / 卸载 / 新一轮
 * start 都以 generation 号作废旧闭包，保证「已关闭仍 emit」不会传到渲染层。
 */

import { onScopeDispose, ref, type Ref } from "vue";
import {
  DOCKER_LOG_STATE,
  decodeDockerLogFrame,
  dockerLogOutChannel,
  type DockerLogFrame,
} from "../lib/dockerLogStream";

/** start 客户端等待上限：真实路径立即返回，给慢会话解析留余量。 */
export const DOCKER_LOG_START_TIMEOUT_MS = 20_000;
/** stop 只需发取消信号；sidecar 在宽限内收尾。 */
export const DOCKER_LOG_STOP_TIMEOUT_MS = 15_000;
/** 未渲染帧的软上限：桥接推送过快时先同步冲刷，避免无界增长。 */
const MAX_QUEUED_FRAMES = 512;

export interface UseDockerLogStreamOptions {
  /** 每次渲染批次回调（已按流合流、未过背压门）。 */
  onData: (data: Uint8Array) => void;
  onEnd?: (reason: string) => void;
  onError?: (error: string) => void;
  invoke?: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
  api?: () => typeof window.dbxPlugin | undefined;
}

export interface DockerLogStreamHandle {
  active: Ref<boolean>;
  streamId: Ref<string>;
  error: Ref<string>;
  endedReason: Ref<string>;
  start(params: Record<string, unknown>): Promise<boolean>;
  stop(options?: { notify?: boolean }): Promise<void>;
}

let streamSequence = 0;

/** 可复用的客户端流 id：注册表键与通道后缀的安全字符集。 */
export function nextDockerLogStreamId(now: number = Date.now()): string {
  streamSequence += 1;
  return `docker-log-${now.toString(36)}-${streamSequence}`;
}

export function useDockerLogStream(options: UseDockerLogStreamOptions): DockerLogStreamHandle {
  const active = ref(false);
  const streamId = ref("");
  const error = ref("");
  const endedReason = ref("");

  let generation = 0;
  let unsubscribeBinary: (() => void) | undefined;
  let unsubscribeEvent: (() => void) | undefined;
  let queued: DockerLogFrame[] = [];
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
    for (const frame of frames) options.onData(frame.data);
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

  function enqueue(frame: DockerLogFrame, mine: number): void {
    if (mine !== generation) return;
    if (frame.stream === DOCKER_LOG_STATE) return;
    queued.push(frame);
    scheduleFlush(mine);
  }

  async function start(params: Record<string, unknown>): Promise<boolean> {
    await stop({ notify: true });
    const mine = ++generation;
    const requested = nextDockerLogStreamId();
    streamId.value = requested;
    error.value = "";
    endedReason.value = "";
    const host = api();
    if (!host) {
      error.value = "Host API unavailable";
      options.onError?.(error.value);
      return false;
    }
    unsubscribeBinary = host.onBinary((event) => {
      if (mine !== generation) return;
      if (event.channel !== dockerLogOutChannel(requested)) return;
      const bytes = event.data ?? (event.dataBase64 ? host.decodeBase64(event.dataBase64) : undefined);
      const frame = decodeDockerLogFrame(bytes);
      if (frame) enqueue(frame, mine);
    });
    unsubscribeEvent = host.onEvent((event) => {
      if (mine !== generation) return;
      // 宿主也会经同一通道推送环境事件（type:"env"），只处理后端事件。
      if (!("method" in event)) return;
      const payload = (event.params ?? {}) as Record<string, unknown>;
      if (payload.streamId !== requested) return;
      if (event.method === "docker/logs/end") {
        flushNow();
        active.value = false;
        endedReason.value = typeof payload.reason === "string" ? payload.reason : "exited";
        detach();
        options.onEnd?.(endedReason.value);
        return;
      }
      if (event.method === "docker/logs/error") {
        error.value = typeof payload.error === "string" ? payload.error : "docker logs stream failed";
        options.onError?.(error.value);
        return;
      }
      if (event.method === "docker/logs/chunk" && typeof payload.text === "string") {
        enqueue(
          { stream: 0, sequence: Number(payload.sequence) || 0, data: new TextEncoder().encode(payload.text) },
          mine,
        );
      }
    });
    active.value = true;
    try {
      const response = await invoke(
        "docker/logs/stream/start",
        { ...params, requestedStreamId: requested },
        { timeoutMs: DOCKER_LOG_START_TIMEOUT_MS },
      );
      if (mine !== generation) return false;
      const payload = (response ?? {}) as Record<string, unknown>;
      if (typeof payload.streamId === "string" && payload.streamId) streamId.value = payload.streamId;
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

  async function stop(stopOptions: { notify?: boolean } = {}): Promise<void> {
    const id = streamId.value;
    generation += 1;
    active.value = false;
    detach();
    streamId.value = "";
    if (!id || stopOptions.notify === false) return;
    try {
      await invoke("docker/logs/stream/stop", { streamId: id }, { timeoutMs: DOCKER_LOG_STOP_TIMEOUT_MS });
    } catch {
      // stop 幂等；旧 sidecar 缺方法时静默降级（流由 TTL 兜底回收）。
    }
  }

  onScopeDispose(() => {
    void stop({ notify: true });
  });

  return { active, streamId, error, endedReason, start, stop };
}
