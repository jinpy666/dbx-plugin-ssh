// standaloneArrayBuffer 单测（issue #116）：宿主桥 fileTransfer.write 的
// transfer 列表只收 ArrayBuffer（Uint8Array 视图会被 Chromium 拒绝为
// "Value at index 0 does not have a transferable type"），payload 必须归一
// 成"底层存储恰为本块字节"的独立 ArrayBuffer。
import { describe, expect, it } from "vitest";
import { standaloneArrayBuffer } from "./standaloneBuffer";

describe("standaloneArrayBuffer", () => {
  it("returns the underlying buffer unchanged for a full-span view", () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    view[0] = 0x42;
    expect(standaloneArrayBuffer(view)).toBe(buffer);
  });

  it("copies a subview into a standalone buffer covering only the visible range", () => {
    const storage = new ArrayBuffer(16);
    const subview = new Uint8Array(storage, 4, 8);
    for (let index = 0; index < 8; index += 1) subview[index] = index + 1;
    const standalone = standaloneArrayBuffer(subview);
    expect(standalone).not.toBe(storage);
    expect(standalone.byteLength).toBe(8);
    expect(Array.from(new Uint8Array(standalone))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("copies a non-zero offset view even when the span matches byteLength", () => {
    const storage = new ArrayBuffer(16);
    const tail = new Uint8Array(storage, 8);
    const standalone = standaloneArrayBuffer(tail);
    expect(standalone).not.toBe(storage);
    expect(standalone.byteLength).toBe(8);
  });

  it("copies a subview independently so repeated writes stay reusable", () => {
    // 桥端 transfer 会 detach 传入的 ArrayBuffer；每次调用必须返回新鲜
    // 独立 buffer，同一 Uint8Array 视图二次写入不被上一次影响。
    const payload = new Uint8Array(new ArrayBuffer(16), 0, 8);
    payload.set([9, 8, 7, 6, 5, 4, 3, 2]);
    const first = standaloneArrayBuffer(payload);
    const second = standaloneArrayBuffer(payload);
    expect(first).not.toBe(second);
    expect(Array.from(new Uint8Array(second))).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
  });

  it("accepts a zero-length view", () => {
    expect(standaloneArrayBuffer(new Uint8Array(0)).byteLength).toBe(0);
  });
});
