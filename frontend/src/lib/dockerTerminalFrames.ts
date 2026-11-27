/**
 * 容器终端（`docker/terminal/*`，B5）的前端帧解码、合流与通道名。
 *
 * 输出帧与 SSH/local/serial 同构（1 字节流标签 + 大端 u64 序号 + 数据）：
 * `0` = stdout、`1` = stderr，`2` 保留给未来状态帧（当前 sidecar 不发）。
 * 输入帧是 `docker/terminal/in/{id}` 上的 8 字节大端序号 + 原始键（复用
 * `createTerminalInputQueue`）。
 *
 * 路由判定集中在这里：`docker/terminal/out/` 必须在 App 的 SSH 分支之前
 * 命中，绝不能落进 `ssh/terminal/out/`（否则容器输出会被丢弃并污染 SSH
 * 会话的 sequence 状态）。
 */

import { mergeTerminalFrames, type TerminalFrameItem } from "./terminalFrameBatch";
import type { OutputGate } from "./terminalBackpressure";
import type { TerminalWriteThrottle } from "./terminalWriteThrottle";

export const DOCKER_TERMINAL_STDOUT = 0;
export const DOCKER_TERMINAL_STDERR = 1;
export const DOCKER_TERMINAL_STATE = 2;

export const DOCKER_TERMINAL_OUT_PREFIX = "docker/terminal/out/";
export const DOCKER_TERMINAL_IN_PREFIX = "docker/terminal/in/";
export const DOCKER_TERMINAL_MERGE_BYTES = 64 * 1024;

export interface DockerTerminalFrame {
  stream: number;
  sequence: number;
  data: Uint8Array;
}

export function dockerTerminalOutChannel(terminalId: string): string {
  return `${DOCKER_TERMINAL_OUT_PREFIX}${terminalId}`;
}

export function dockerTerminalInChannel(terminalId: string): string {
  return `${DOCKER_TERMINAL_IN_PREFIX}${terminalId}`;
}

/** 输出通道 → terminalId；不是容器终端通道时返回 null。 */
export function dockerTerminalChannelId(channel: string): string | null {
  if (!channel.startsWith(DOCKER_TERMINAL_OUT_PREFIX)) return null;
  return channel.slice(DOCKER_TERMINAL_OUT_PREFIX.length);
}

export function decodeDockerTerminalFrame(
  bytes: Uint8Array | ArrayBuffer | undefined | null,
): DockerTerminalFrame | null {
  if (!bytes) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < 9) return null;
  const stream = view[0];
  if (stream !== DOCKER_TERMINAL_STDOUT && stream !== DOCKER_TERMINAL_STDERR && stream !== DOCKER_TERMINAL_STATE) {
    return null;
  }
  const sequence = Number(new DataView(view.buffer, view.byteOffset + 1, 8).getBigUint64(0, false));
  if (!Number.isSafeInteger(sequence)) return null;
  return { stream, sequence, data: view.subarray(9) };
}

/** 合流：丢弃 state 帧，连续同流 data 帧合并成一次 xterm 写入。 */
export function planDockerTerminalWrites(
  frames: readonly DockerTerminalFrame[],
  maxMergedBytes: number = DOCKER_TERMINAL_MERGE_BYTES,
): Uint8Array[] {
  const items: TerminalFrameItem[] = [];
  for (const frame of frames) {
    if (frame.stream === DOCKER_TERMINAL_STATE || frame.data.byteLength === 0) continue;
    items.push({ stream: frame.stream, data: frame.data });
  }
  return mergeTerminalFrames(items, maxMergedBytes).map((segment) => segment.data);
}

export function writeDockerTerminalFrames(
  frames: readonly DockerTerminalFrame[],
  gate: OutputGate,
  throttle: TerminalWriteThrottle,
  maxMergedBytes: number = DOCKER_TERMINAL_MERGE_BYTES,
): number {
  const segments = planDockerTerminalWrites(frames, maxMergedBytes);
  gate.feed(throttle.pendingBytes);
  let written = 0;
  for (const segment of segments) {
    for (const part of gate.write(segment)) {
      throttle.write(part);
      written += part.byteLength;
    }
  }
  return written;
}

/** base64（open 返回的 replay 帧）→ 输出帧；非法输入返回 null。 */
export function decodeDockerTerminalReplayFrame(
  sequence: unknown,
  dataBase64: unknown,
  decodeBase64?: (value: string) => Uint8Array,
): DockerTerminalFrame | null {
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  if (typeof dataBase64 !== "string") return null;
  const decode = decodeBase64 ?? ((value: string) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  });
  return { stream: DOCKER_TERMINAL_STDOUT, sequence, data: decode(dataBase64) };
}
