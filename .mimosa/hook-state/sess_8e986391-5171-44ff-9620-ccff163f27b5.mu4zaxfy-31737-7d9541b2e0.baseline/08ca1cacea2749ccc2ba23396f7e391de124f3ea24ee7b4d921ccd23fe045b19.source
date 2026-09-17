// GIF89a 编码器（零依赖）：会话录制回放的 GIF 导出用。
// - 固定全局调色板（xterm 16 色 + 6×6×6 web cube + 24 级灰度 = 256 色），
//   像素按最近邻映射到索引；
// - 每帧一张全尺寸图 + 图形控制扩展（GCE，单位 1/100s 延迟）；
// - LZW 压缩按 GIF 规范实现（min code size 固定 8）。
// 纯函数、无 DOM 依赖；正确性由 gifEncoder.spec.ts 的迷你 GIF 解码器
// 逐位回读校验。

export interface GifFrame {
  /** RGBA 像素（长度 = width * height * 4）。 */
  rgba: Uint8Array;
  /** 帧显示时长（毫秒），编码为 GIF 的 1/100s 延迟。 */
  delayMs: number;
}

// —— 调色板 ——————————————————————————————————————————————

// xterm 默认 16 色（与 vga 主题一致的近似值，回放 GIF 观感足够）。
const BASE16: Array<[number, number, number]> = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
  [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
  [59, 142, 234], [214, 112, 214], [41, 184, 219], [229, 229, 229],
];

// 生成 256 色全局调色板：0-15 为 BASE16，16-231 为 6×6×6 web cube，
// 232-255 为 24 级灰度。返回 256×3 字节。
export function buildGlobalPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  const set = (index: number, r: number, g: number, b: number) => {
    palette[index * 3] = r;
    palette[index * 3 + 1] = g;
    palette[index * 3 + 2] = b;
  };
  BASE16.forEach(([r, g, b], index) => set(index, r, g, b));
  let index = 16;
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        set(index, r * 51, g * 51, b * 51);
        index += 1;
      }
    }
  }
  for (let level = 0; index < 256; level += 1, index += 1) {
    const gray = Math.min(255, 8 + level * 10);
    set(index, gray, gray, gray);
  }
  return palette;
}

const PALETTE_CACHE = new WeakMap<Uint8Array, Map<number, number>>();

// 最近邻映射：RGBA → 调色板索引。带 memo（按 rgb 打包键）；alpha<128
// 视为背景黑。palette 需由 buildGlobalPalette 生成（256 项）。
export function quantizeToPalette(rgba: Uint8Array, palette: Uint8Array): Uint8Array {
  let memo = PALETTE_CACHE.get(palette);
  if (!memo) {
    memo = new Map();
    PALETTE_CACHE.set(palette, memo);
  }
  const pixels = rgba.length >> 2;
  const indices = new Uint8Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const base = pixel << 2;
    if (rgba[base + 3]! < 128) {
      indices[pixel] = 0;
      continue;
    }
    const key = (rgba[base]! << 16) | (rgba[base + 1]! << 8) | rgba[base + 2]!;
    const cached = memo.get(key);
    if (cached !== undefined) {
      indices[pixel] = cached;
      continue;
    }
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let entry = 0; entry < 256; entry += 1) {
      const dr = palette[entry * 3]! - rgba[base]!;
      const dg = palette[entry * 3 + 1]! - rgba[base + 1]!;
      const db = palette[entry * 3 + 2]! - rgba[base + 2]!;
      const distance = dr * dr * 2 + dg * dg * 4 + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }
    memo.set(key, best);
    indices[pixel] = best;
  }
  return indices;
}

// —— LZW ——————————————————————————————————————————————

const MIN_CODE_SIZE = 8;
const CLEAR_CODE = 1 << MIN_CODE_SIZE; // 256
const END_CODE = CLEAR_CODE + 1; // 257

// GIF LZW 编码：输出原始码流字节（不含子块长度前缀，由调用方分块）。
export function lzwEncode(indices: Uint8Array): Uint8Array {
  const bytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = MIN_CODE_SIZE + 1;
  let nextCode = END_CODE + 1;
  // 字典：字符串 → 码。用 "前缀码<<8 | 字符" 的键避免存整个字符串。
  let dictionary = new Map<number, number>();

  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };
  const reset = () => {
    emit(CLEAR_CODE);
    codeSize = MIN_CODE_SIZE + 1;
    nextCode = END_CODE + 1;
    dictionary = new Map();
  };

  reset();
  if (indices.length === 0) {
    emit(END_CODE);
    if (bitCount > 0) bytes.push(bitBuffer & 0xff);
    return Uint8Array.from(bytes);
  }
  let prefix = indices[0]!;
  for (let index = 1; index < indices.length; index += 1) {
    const char = indices[index]!;
    const key = (prefix << 8) | char;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    dictionary.set(key, nextCode);
    nextCode += 1;
    // 码宽递增与解码器锁步：解码器每码建表慢一步（首码后不建表），
    // 所以编码器在 nextCode 超过 2^codeSize（而非追平）时加宽。
    if (nextCode > (1 << codeSize) && codeSize < 12) {
      codeSize += 1;
    }
    if (nextCode >= 4096) {
      reset();
    }
    prefix = char;
  }
  emit(prefix);
  emit(END_CODE);
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return Uint8Array.from(bytes);
}

// —— 容器 ——————————————————————————————————————————————

class ByteWriter {
  private chunks: number[] = [];

  u8(...values: number[]) {
    for (const value of values) this.chunks.push(value & 0xff);
  }

  u16(...values: number[]) {
    for (const value of values) {
      this.chunks.push(value & 0xff, (value >> 8) & 0xff);
    }
  }

  bytes(values: ArrayLike<number>) {
    for (let index = 0; index < values.length; index += 1) {
      this.chunks.push(values[index]! & 0xff);
    }
  }

  text(value: string) {
    for (const char of value) this.u8(char.charCodeAt(0));
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

// 将 LZW 码流切成 ≤255 字节的子块。
function subBlocks(writer: ByteWriter, data: Uint8Array) {
  for (let offset = 0; offset < data.length; offset += 255) {
    const size = Math.min(255, data.length - offset);
    writer.u8(size);
    writer.bytes(data.subarray(offset, offset + size));
  }
  writer.u8(0);
}

// 编码完整 GIF。帧为空时仍输出一个 1×1 的黑帧占位（GIF 不允许零帧）。
export function encodeGif(width: number, height: number, frames: readonly GifFrame[]): Uint8Array {
  const palette = buildGlobalPalette();
  const writer = new ByteWriter();
  writer.text("GIF89a");
  writer.u16(width);
  writer.u16(height);
  writer.u8(0x80 | 0x70 | 0x07); // GCT 存在、8 位色深、256 项
  writer.u8(0); // 背景色索引
  writer.u8(0); // 像素纵横比
  writer.bytes(palette);
  // NETSCAPE2.0 循环扩展：应用扩展块 + 0x03 数据子块 + 终止符。
  writer.u8(0x21, 0xff, 0x0b);
  writer.text("NETSCAPE2.0");
  writer.u8(0x03, 0x01, 0x00, 0x00, 0x00);

  const effective = frames.length
    ? frames
    : [{ rgba: new Uint8Array(4), delayMs: 100 }];
  for (const frame of effective) {
    const delay = Math.max(2, Math.round(frame.delayMs / 10));
    writer.u8(0x21, 0xf9, 0x04);
    writer.u8(0x04); // 处置方式：不处置，透明色未用
    writer.u16(delay);
    writer.u8(0, 0);
    writer.u8(0x2c);
    writer.u16(0, 0, width, height);
    writer.u8(0); // 无局部调色板、非隔行
    writer.u8(MIN_CODE_SIZE);
    const indices = quantizeToPalette(frame.rgba, palette);
    subBlocks(writer, lzwEncode(indices));
  }
  writer.u8(0x3b); // trailer
  return writer.toUint8Array();
}
