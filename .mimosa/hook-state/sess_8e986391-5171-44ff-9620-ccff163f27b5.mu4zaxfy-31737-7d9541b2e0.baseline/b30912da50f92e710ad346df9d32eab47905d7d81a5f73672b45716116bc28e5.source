// GIF89a 编码器单测：结构逐字节校验 + 迷你 LZW 解码器回读往返。
import { describe, expect, it } from "vitest";
import {
  buildGlobalPalette,
  encodeGif,
  lzwEncode,
  quantizeToPalette,
  type GifFrame,
} from "./gifEncoder";

// 迷你 GIF LZW 解码器：仅用于测试往返正确性（规则与编码器锁步）。
function lzwDecode(minCodeSize: number, data: Uint8Array, expectedPixels: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let dictionary: number[][] = [];
  const resetDictionary = () => {
    dictionary = [];
    for (let index = 0; index < clear; index += 1) dictionary.push([index]);
    dictionary.push([]);
    dictionary.push([]);
  };
  resetDictionary();
  let bitPos = 0;
  const readCode = (): number => {
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byte = bitPos >> 3;
      if (byte >= data.length) return end;
      code |= ((data[byte]! >> (bitPos & 7)) & 1) << bit;
      bitPos += 1;
    }
    return code;
  };
  const out: number[] = [];
  let previous: number[] | null = null;
  while (out.length < expectedPixels) {
    const code = readCode();
    if (code === clear) {
      resetDictionary();
      codeSize = minCodeSize + 1;
      previous = null;
      continue;
    }
    if (code === end) break;
    let entry: number[];
    if (code < dictionary.length && dictionary[code]!.length) {
      entry = dictionary[code]!;
    } else if (previous) {
      entry = [...previous, previous[0]!];
    } else {
      break;
    }
    out.push(...entry);
    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }
  return Uint8Array.from(out);
}

function gatherSubBlocks(bytes: Uint8Array, offset: number): { data: Uint8Array; next: number } {
  const chunks: number[] = [];
  let cursor = offset;
  while (bytes[cursor] !== 0) {
    const size = bytes[cursor]!;
    for (let index = 0; index < size; index += 1) chunks.push(bytes[cursor + 1 + index]!);
    cursor += 1 + size;
  }
  return { data: Uint8Array.from(chunks), next: cursor + 1 };
}

describe("gif palette + quantizer", () => {
  it("builds a 256-entry palette with the base16 head", () => {
    const palette = buildGlobalPalette();
    expect(palette.length).toBe(768);
    expect([...palette.slice(0, 6)]).toEqual([0, 0, 0, 205, 49, 49]);
  });

  it("maps colors to their nearest palette entry with memoization", () => {
    const palette = buildGlobalPalette();
    const rgba = new Uint8Array([
      205, 49, 49, 255, // 精确命中 base16[1]
      255, 255, 255, 255, // 近似灰阶尾
      10, 20, 30, 60, // alpha<128 → 背景黑（索引 0）
    ]);
    const indices = quantizeToPalette(rgba, palette);
    expect(indices[0]).toBe(1);
    expect(indices[2]).toBe(0);
    // 白色应落在高亮区间（>= 200 的灰度或最亮 web cube）。
    const index = indices[1]!;
    expect(palette[index * 3]!).toBeGreaterThan(200);
  });
});

describe("lzw codec roundtrip", () => {
  it("roundtrips small, repetitive, and long inputs", () => {
    const samples = [
      Uint8Array.from([0, 0, 0, 0]),
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      Uint8Array.from(Array.from({ length: 4096 }, (_, index) => index % 256)),
      Uint8Array.from(Array.from({ length: 9000 }, () => 17)),
    ];
    for (const sample of samples) {
      const decoded = lzwDecode(8, lzwEncode(sample), sample.length);
      expect([...decoded]).toEqual([...sample]);
    }
  });
});

describe("gif container", () => {
  it("encodes a two-frame gif with correct header, palette and pixel payload", () => {
    const width = 4;
    const height = 4;
    const makeFrame = (value: number): GifFrame => ({
      rgba: new Uint8Array(width * height * 4).fill(0).map((_, index) =>
        index % 4 === 3 ? 255 : value,
      ),
      delayMs: 200,
    });
    const frames = [makeFrame(205), makeFrame(13)];
    const gif = encodeGif(width, height, frames);
    // 头部与逻辑屏幕描述符。
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect(gif[6]! | (gif[7]! << 8)).toBe(width);
    expect(gif[8]! | (gif[9]! << 8)).toBe(height);
    expect(gif[10]! & 0x80).toBeTruthy(); // 全局调色板存在
    // 调色板起点（第 14 字节起 768 字节）。
    expect(gif[13]!).toBe(0); // 背景色索引
    let cursor = 13 + 768;
    // NETSCAPE 循环扩展。
    expect(gif[cursor]).toBe(0x21);
    cursor += 19; // 0x21 0xff 0x0b + "NETSCAPE2.0" + 0x03 0x01 0x00 0x00
    for (const frame of frames) {
      expect(gif[cursor]).toBe(0x21); // GCE
      expect(gif[cursor + 1]).toBe(0xf9);
      const delay = gif[cursor + 4]! | (gif[cursor + 5]! << 8);
      expect(delay).toBe(20); // 200ms → 20 个 1/100s
      cursor += 8;
      expect(gif[cursor]).toBe(0x2c); // 图像描述符
      cursor += 10;
      expect(gif[cursor]).toBe(8); // min code size
      cursor += 1;
      const { data, next } = gatherSubBlocks(gif, cursor);
      cursor = next;
      const decoded = lzwDecode(8, data, width * height);
      expect([...decoded]).toEqual([...quantizeToPalette(frame.rgba, buildGlobalPalette())]);
    }
    expect(gif[cursor]).toBe(0x3b); // trailer
    expect(cursor).toBe(gif.length - 1);
  });

  it("emits a placeholder frame for empty input", () => {
    const gif = encodeGif(1, 1, []);
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
  });
});
