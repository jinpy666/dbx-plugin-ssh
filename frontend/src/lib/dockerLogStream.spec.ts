import { describe, expect, it } from "vitest";
import { createOutputGate } from "./terminalBackpressure";
import type { TerminalWriteThrottle } from "./terminalWriteThrottle";
import {
  DOCKER_LOG_STATE,
  DOCKER_LOG_STDERR,
  DOCKER_LOG_STDOUT,
  decodeDockerLogFrame,
  dockerLogOutChannel,
  planDockerLogWrites,
  writeDockerLogFrames,
  type DockerLogFrame,
} from "./dockerLogStream";

function encodeFrame(stream: number, sequence: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(9 + payload.byteLength);
  frame[0] = stream;
  new DataView(frame.buffer).setBigUint64(1, BigInt(sequence), false);
  frame.set(payload, 9);
  return frame;
}

function fakeThrottle(pendingBytes = 0): TerminalWriteThrottle & { written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    get pendingBytes() {
      return pendingBytes;
    },
    get pending() {
      return false;
    },
    get held() {
      return false;
    },
    write(data: Uint8Array) {
      written.push(data);
    },
    flush() {},
    setHold() {},
    dispose() {},
  };
}

describe("dockerLogStream frames", () => {
  it("decodes the 9-byte TerminalFrame and keeps multi-byte UTF-8 bytes intact", () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("你\r\nok");
    const frame = decodeDockerLogFrame(encodeFrame(DOCKER_LOG_STDOUT, 7, bytes));
    expect(frame).not.toBeNull();
    expect(frame!.stream).toBe(DOCKER_LOG_STDOUT);
    expect(frame!.sequence).toBe(7);
    expect(Array.from(frame!.data)).toEqual(Array.from(bytes));
    // \r 不被规范化，交给 xterm 处理覆盖行。
    expect(frame!.data[3]).toBe(0x0d);
    expect(dockerLogOutChannel("abc")).toBe("docker/logs/out/abc");
  });

  it("drops short frames and unknown stream tags instead of throwing", () => {
    expect(decodeDockerLogFrame(new Uint8Array([0, 0, 0]))).toBeNull();
    expect(decodeDockerLogFrame(encodeFrame(3, 1, new Uint8Array([1])))).toBeNull();
    expect(decodeDockerLogFrame(encodeFrame(DOCKER_LOG_STDERR, 2, new Uint8Array([9])))).not.toBeNull();
  });

  it("merges consecutive data frames per stream and drops state frames", () => {
    const frames: DockerLogFrame[] = [
      { stream: DOCKER_LOG_STDOUT, sequence: 1, data: new TextEncoder().encode("a") },
      { stream: DOCKER_LOG_STDOUT, sequence: 2, data: new TextEncoder().encode("b") },
      { stream: DOCKER_LOG_STATE, sequence: 3, data: new Uint8Array([0]) },
      { stream: DOCKER_LOG_STDERR, sequence: 4, data: new TextEncoder().encode("e") },
      { stream: DOCKER_LOG_STDOUT, sequence: 5, data: new TextEncoder().encode("c") },
    ];
    const segments = planDockerLogWrites(frames);
    expect(segments.map((segment) => new TextDecoder().decode(segment))).toEqual(["ab", "e", "c"]);
  });

  it("splits merged output at the byte cap without dropping order", () => {
    const frames: DockerLogFrame[] = [
      { stream: DOCKER_LOG_STDOUT, sequence: 1, data: new Uint8Array([1, 2, 3]) },
      { stream: DOCKER_LOG_STDOUT, sequence: 2, data: new Uint8Array([4, 5, 6]) },
    ];
    const segments = planDockerLogWrites(frames, 4);
    expect(segments.map((segment) => Array.from(segment))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("writes through the backpressure gate: a strained backlog splits into bounded frames", () => {
    const gate = createOutputGate({ strainedBytes: 4, resumeBytes: 2, chunkBytes: 2 });
    const throttle = fakeThrottle(10);
    const frames: DockerLogFrame[] = [
      { stream: DOCKER_LOG_STDOUT, sequence: 1, data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    expect(writeDockerLogFrames(frames, gate, throttle)).toBe(5);
    expect(throttle.written.map((part) => part.byteLength)).toEqual([2, 2, 1]);
  });
});
