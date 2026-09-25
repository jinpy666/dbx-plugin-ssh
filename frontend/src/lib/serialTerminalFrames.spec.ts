import { describe, expect, it } from "vitest";
import {
  SERIAL_MAX_KNOWN_STREAM_TAG,
  SERIAL_STREAM_STATE,
  SERIAL_STREAM_STDERR,
  SERIAL_STREAM_STDIN,
  SERIAL_STREAM_STDOUT,
  encodeSerialInputFrame,
  isKnownStreamTag,
  supportsBinaryInput,
} from "./serialTerminalFrames";

describe("serialTerminalFrames", () => {
  it("keeps the Stdin tag at 3 and clear of the State band", () => {
    // B1 契约：Stdin = 3，避开 local 终端已占用的 State = 2。
    expect(SERIAL_STREAM_STDOUT).toBe(0);
    expect(SERIAL_STREAM_STDERR).toBe(1);
    expect(SERIAL_STREAM_STATE).toBe(2);
    expect(SERIAL_STREAM_STDIN).toBe(3);
    expect(SERIAL_MAX_KNOWN_STREAM_TAG).toBe(3);
  });

  it("classifies known and unknown stream tags for the decode side", () => {
    for (const tag of [0, 1, 2, 3]) expect(isKnownStreamTag(tag)).toBe(true);
    // 未知标签（含未来扩展位之外的一切）必须按未知处理。
    for (const tag of [4, 99, 255]) expect(isKnownStreamTag(tag)).toBe(false);
    expect(isKnownStreamTag(-1)).toBe(false);
    expect(isKnownStreamTag(1.5)).toBe(false);
    expect(isKnownStreamTag(Number.NaN)).toBe(false);
  });

  it("encodes a Stdin write frame as tag + big-endian u64 + raw bytes", () => {
    const frame = encodeSerialInputFrame(42, new TextEncoder().encode("ls\r"));
    expect(frame.length).toBe(9 + 3);
    expect(frame[0]).toBe(SERIAL_STREAM_STDIN);
    expect(frame[1]).toBe(0);
    expect(frame[8]).toBe(42);
    expect(Array.from(frame.subarray(9))).toEqual([108, 115, 13]);
  });

  it("encodes large sequences and empty payloads without truncation", () => {
    const empty = encodeSerialInputFrame(0, new Uint8Array(0));
    expect(empty.length).toBe(9);
    expect(empty[0]).toBe(SERIAL_STREAM_STDIN);

    // JS number 精度内的大序号（2^53-1 = 0x001FFFFFFFFFFFFF）：8 个字节
    // 全部按大端落位。
    const sequence = Number.MAX_SAFE_INTEGER;
    const frame = encodeSerialInputFrame(sequence, new Uint8Array([1]));
    expect(Array.from(frame.subarray(1, 9))).toEqual([
      0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("roundtrips against the TerminalFrame wire shape the sidecar encodes", () => {
    // 与 backend/src/model.rs TerminalFrame::encode 对称：首字节标签 +
    // 8 字节大端序号 + 数据。
    const frame = encodeSerialInputFrame(7, new Uint8Array([0x68, 0x69]));
    expect(frame[0]).toBe(3);
    expect(Array.from(frame.subarray(1, 9))).toEqual([0, 0, 0, 0, 0, 0, 0, 7]);
    expect(Array.from(frame.subarray(9))).toEqual([0x68, 0x69]);
  });

  it("enables the binary write channel only on a declared capability", () => {
    // 能力探测降级（设计稿 §2）：serial/start 未声明 binaryInput 的 sidecar
    // （旧版本）一律走 JSON 兼容路径；仅显式 true 启用。
    expect(supportsBinaryInput({ binaryInput: true })).toBe(true);
    expect(supportsBinaryInput({ binaryInput: false })).toBe(false);
    expect(supportsBinaryInput({})).toBe(false);
    expect(supportsBinaryInput({ binaryInput: "true" })).toBe(false);
    expect(supportsBinaryInput(null)).toBe(false);
    expect(supportsBinaryInput(undefined)).toBe(false);
  });
});
