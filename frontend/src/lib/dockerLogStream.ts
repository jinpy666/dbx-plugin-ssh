/**
 * Docker 日志流（`docker/logs/out/{streamId}`，B3）的前端帧解码、合流与
 * 背压写入门。
 *
 * 帧与 SSH/local/serial 输出帧同构（`TerminalFrame`：1 字节流标签 + 大端
 * u64 序号 + 数据，见 docs/PROTOCOL.zh-CN.md「二进制通道」节）：
 * - `0` = 容器 stdout，`1` = 容器 stderr，`2` = 生命周期状态帧；
 * - 每批一帧（sidecar 已按 64 KiB / 100 ms 聚合）；
 * - 未知标签按串口契约静默丢弃（不 panic、不断流）。
 *
 * 合流复用 `mergeTerminalFrames`（issue #302）：连续同流 data 帧合并成一次
 * xterm 写入，state 帧不进终端。写入复用 `createOutputGate` 的 128 KiB /
 * 64 KiB / 32 KiB 门限，积压时切片，避免一次大写入卡住主线程。
 */

import { mergeTerminalFrames, type TerminalFrameItem } from "./terminalFrameBatch";
import type { OutputGate } from "./terminalBackpressure";
import type { TerminalWriteThrottle } from "./terminalWriteThrottle";

export const DOCKER_LOG_STDOUT = 0;
export const DOCKER_LOG_STDERR = 1;
export const DOCKER_LOG_STATE = 2;

/** 前端合流上限：与 sidecar 的批上限一致，超大单帧仍原样一次写入。 */
export const DOCKER_LOG_MERGE_BYTES = 64 * 1024;

export interface DockerLogFrame {
  stream: number;
  sequence: number;
  data: Uint8Array;
}

export function dockerLogOutChannel(streamId: string): string {
  return `docker/logs/out/${streamId}`;
}

/**
 * 解码一帧；长度不足 9、标签未知或序号非安全整数时返回 null（丢帧计数由
 * 调用方自行决定）。payload 用 subarray 视图，不复制。
 */
export function decodeDockerLogFrame(bytes: Uint8Array | ArrayBuffer | undefined | null): DockerLogFrame | null {
  if (!bytes) return null;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength < 9) return null;
  const stream = view[0];
  if (stream !== DOCKER_LOG_STDOUT && stream !== DOCKER_LOG_STDERR && stream !== DOCKER_LOG_STATE) {
    return null;
  }
  const sequence = Number(new DataView(view.buffer, view.byteOffset + 1, 8).getBigUint64(0, false));
  if (!Number.isSafeInteger(sequence)) return null;
  return { stream, sequence, data: view.subarray(9) };
}

/**
 * 把一批帧规划成 xterm 写入片段：丢弃 state 帧，合并连续同流 data 帧。
 * 流切换或累计超过 `maxMergedBytes` 时切段（顺序保持不变）。
 */
export function planDockerLogWrites(
  frames: readonly DockerLogFrame[],
  maxMergedBytes: number = DOCKER_LOG_MERGE_BYTES,
): Uint8Array[] {
  const items: TerminalFrameItem[] = [];
  for (const frame of frames) {
    if (frame.stream === DOCKER_LOG_STATE || frame.data.byteLength === 0) continue;
    items.push({ stream: frame.stream, data: frame.data });
  }
  return mergeTerminalFrames(items, maxMergedBytes).map((segment) => segment.data);
}

/**
 * 一次写入：先按当前积压更新背压门，再把片段交给门切片后写进 throttle。
 * `pendingBytes` 由 throttle 提供（App 的终端写节流器同款）。
 */
export function writeDockerLogFrames(
  frames: readonly DockerLogFrame[],
  gate: OutputGate,
  throttle: TerminalWriteThrottle,
  maxMergedBytes: number = DOCKER_LOG_MERGE_BYTES,
): number {
  const segments = planDockerLogWrites(frames, maxMergedBytes);
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
