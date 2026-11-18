import { describe, expect, it } from "vitest";
import { mergeTerminalFrames } from "./terminalFrameBatch";

const bytes = (values: number[]) => new Uint8Array(values);

describe("mergeTerminalFrames (#302)", () => {
  it("连续数据帧合并为单段，字节序保持", () => {
    const merged = mergeTerminalFrames(
      [
        { stream: 1, data: bytes([1, 2, 3]) },
        { stream: 1, data: bytes([4, 5]) },
      ],
      1024,
    );
    expect(merged).toHaveLength(1);
    expect(Array.from(merged[0]!.data)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[0]!.stream).toBe(1);
  });

  it("控制帧（stream=2）切断合并且保持原序", () => {
    const control = bytes([9]);
    const merged = mergeTerminalFrames(
      [
        { stream: 1, data: bytes([1]) },
        { stream: 2, data: control },
        { stream: 1, data: bytes([2]) },
      ],
      1024,
    );
    expect(merged.map((s) => s.stream)).toEqual([1, 2, 1]);
    expect(Array.from(merged[0]!.data)).toEqual([1]);
    expect(merged[1]!.data).toBe(control);
    expect(Array.from(merged[2]!.data)).toEqual([2]);
  });

  it("不同 stream 值不互混合并", () => {
    const merged = mergeTerminalFrames(
      [
        { stream: 1, data: bytes([1]) },
        { stream: 3, data: bytes([2]) },
      ],
      1024,
    );
    expect(merged.map((s) => s.stream)).toEqual([1, 3]);
  });

  it("超过字节上限时提前切段", () => {
    const merged = mergeTerminalFrames(
      [
        { stream: 1, data: bytes([1, 2]) },
        { stream: 1, data: bytes([3, 4]) },
      ],
      3,
    );
    expect(merged).toHaveLength(2);
    expect(Array.from(merged[0]!.data)).toEqual([1, 2]);
    expect(Array.from(merged[1]!.data)).toEqual([3, 4]);
  });

  it("单帧不拷贝：段直接引用原数据", () => {
    const data = bytes([7]);
    const merged = mergeTerminalFrames([{ stream: 1, data }], 1024);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.data).toBe(data);
  });

  it("空输入返回空段列表", () => {
    expect(mergeTerminalFrames([], 1024)).toEqual([]);
  });
});
