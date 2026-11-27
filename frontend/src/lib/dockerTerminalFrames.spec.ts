import { describe, expect, it } from "vitest";
import {
  DOCKER_TERMINAL_STATE,
  DOCKER_TERMINAL_STDERR,
  decodeDockerTerminalFrame,
  decodeDockerTerminalReplayFrame,
  dockerTerminalChannelId,
  dockerTerminalInChannel,
  dockerTerminalOutChannel,
  planDockerTerminalWrites,
} from "./dockerTerminalFrames";

function frame(stream: number, sequence: number, text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(9 + body.length);
  bytes[0] = stream;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(sequence), false);
  bytes.set(body, 9);
  return bytes;
}

describe("docker terminal frames", () => {
  it("decodes 9-byte TerminalFrame headers and rejects short/unknown frames", () => {
    expect(decodeDockerTerminalFrame(new Uint8Array(8))).toBeNull();
    expect(decodeDockerTerminalFrame(frame(9, 1, "x"))).toBeNull();
    const decoded = decodeDockerTerminalFrame(frame(DOCKER_TERMINAL_STDERR, 7, "boom"))!;
    expect(decoded.stream).toBe(DOCKER_TERMINAL_STDERR);
    expect(decoded.sequence).toBe(7);
    expect(new TextDecoder().decode(decoded.data)).toBe("boom");
  });

  it("routes docker/terminal/out before the SSH branch and keeps channels distinct", () => {
    const channel = dockerTerminalOutChannel("term-1");
    expect(channel).toBe("docker/terminal/out/term-1");
    expect(dockerTerminalChannelId(channel)).toBe("term-1");
    // 关键回归：容器输出绝不能命中 ssh 前缀。
    expect(channel.startsWith("ssh/terminal/out/")).toBe(false);
    expect(dockerTerminalChannelId("ssh/terminal/out/term-1")).toBeNull();
    expect(dockerTerminalInChannel("term-1")).toBe("docker/terminal/in/term-1");
    expect(dockerTerminalInChannel("term-1").startsWith("ssh/")).toBe(false);
  });

  it("merges consecutive data frames and drops state frames", () => {
    const writes = planDockerTerminalWrites([
      { stream: 0, sequence: 1, data: new TextEncoder().encode("a") },
      { stream: 0, sequence: 2, data: new TextEncoder().encode("b") },
      { stream: DOCKER_TERMINAL_STATE, sequence: 3, data: new TextEncoder().encode("state") },
      { stream: 1, sequence: 4, data: new TextEncoder().encode("err") },
    ]);
    expect(writes.map((part) => new TextDecoder().decode(part))).toEqual(["ab", "err"]);
  });

  it("decodes open replay frames from base64", () => {
    const decoded = decodeDockerTerminalReplayFrame(3, "b2s=")!;
    expect(decoded.sequence).toBe(3);
    expect(new TextDecoder().decode(decoded.data)).toBe("ok");
    expect(decodeDockerTerminalReplayFrame(-1, "b2s=")).toBeNull();
    expect(decodeDockerTerminalReplayFrame(3, 4 as unknown as string)).toBeNull();
  });
});
