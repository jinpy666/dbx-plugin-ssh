import { describe, expect, it } from "vitest";
import { createTarChunkSource, folderArchiveName, folderArchiveSize, shouldFolderArchive, tarNameLayout, type FolderArchiveEntry } from "./folderArchive";

const encoder = new TextEncoder();

function memEntry(relativePath: string, content: string | Uint8Array, mtimeSecs = 1700000000): FolderArchiveEntry {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return {
    relativePath,
    size: bytes.byteLength,
    mtimeSecs,
    readChunk: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

interface ParsedEntry { name: string; size: number; content: Uint8Array; mtimeSecs: number; type: string }

/** 最小 tar 解析器（测试专用）：逐块走头/内容/LongLink，校验 checksum。 */
function parseTar(bytes: Uint8Array): ParsedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ParsedEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      expect(bytes.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)).toBe(true);
      expect(offset + 1024).toBe(bytes.length);
      return entries;
    }
    // checksum 复核：148..156 按空格累计全头。
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    const stored = Number.parseInt(new TextDecoder().decode(header.subarray(148, 155)).replace(/\0.*$/, "").trim(), 8);
    expect(stored).toBe(checksum);
    expect(new TextDecoder().decode(header.subarray(257, 262))).toBe("ustar");
    let size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    if (Number.isNaN(size) && header[124] === 0x80) size = Number(view.getBigUint64(128, false));
    const type = String.fromCharCode(header[156]);
    const nameField = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const prefixField = new TextDecoder().decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    const content = bytes.subarray(contentStart, contentEnd);
    offset = contentEnd + (size % 512 === 0 ? 0 : 512 - (size % 512));
    if (type === "L") {
      pendingLongName = new TextDecoder().decode(content).replace(/\0.*$/, "");
      continue;
    }
    const name = pendingLongName ?? (prefixField ? `${prefixField}/${nameField}` : nameField);
    pendingLongName = undefined;
    entries.push({
      name,
      size,
      content,
      type,
      mtimeSecs: Number.parseInt(new TextDecoder().decode(header.subarray(136, 148)).replace(/\0.*$/, "").trim(), 8),
    });
  }
  throw new Error("tar stream ended without the two zero end blocks");
}

async function drain(source: NonNullable<ReturnType<typeof createTarChunkSource>>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await source.readChunk(offset, 4096);
    if (!chunk.byteLength) break;
    chunks.push(chunk);
    offset += chunk.byteLength;
  }
  // 声明大小必须与实际生成的流严格相等：sidecar 按 received==expected 校验，
  // 少声明会让整包上传在 finish 处失败。
  expect(offset).toBe(source.size);
  const merged = new Uint8Array(offset);
  let filled = 0;
  for (const chunk of chunks) {
    merged.set(chunk, filled);
    filled += chunk.byteLength;
  }
  return merged;
}

describe("folderArchive", () => {
  it("threshold gates the archive lane", () => {
    expect(shouldFolderArchive(199)).toBe(false);
    expect(shouldFolderArchive(200)).toBe(true);
  });

  it("derives the archive name from the first root segment", () => {
    expect(folderArchiveName([{ relativePath: "proj/src/a.ts" }])).toBe("proj.tar");
    expect(folderArchiveName([{ relativePath: "  spaced/x" }])).toBe("spaced.tar");
    expect(folderArchiveName([])).toBe("folder.tar");
  });

  it("round-trips a small folder through the streamed tar", async () => {
    const entries = [memEntry("proj/a.txt", "alpha"), memEntry("proj/lib/b.bin", new Uint8Array([0, 1, 2, 255])), memEntry("proj/中文.md", "中文内容")];
    const source = createTarChunkSource(entries)!;
    expect(source.name).toBe("proj.tar");
    expect(source.size).toEqual(folderArchiveSize(entries));
    const tar = await drain(source);
    expect(tar.byteLength).toBe(source.size);
    const parsed = parseTar(tar);
    expect(parsed.map((entry) => entry.name)).toEqual(["proj/a.txt", "proj/lib/b.bin", "proj/中文.md"]);
    expect(new TextDecoder().decode(parsed[0].content)).toBe("alpha");
    expect(Array.from(parsed[1].content)).toEqual([0, 1, 2, 255]);
    expect(parsed.every((entry) => entry.type === "0")).toBe(true);
    expect(parsed.every((entry) => entry.mtimeSecs === 1700000000)).toBe(true);
  });

  it("splits deep paths into the ustar prefix field", () => {
    const dir = "very-long-directory-name/".repeat(4); // >100 字节整体
    const path = `${dir}leaf.txt`;
    const layout = tarNameLayout(path);
    expect(layout.kind).toBe("split");
    const source = createTarChunkSource([memEntry(path, "deep")])!;
    return drain(source).then((tar) => {
      const parsed = parseTar(tar);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe(path);
    });
  });

  it("falls back to a GNU longname entry when the name cannot split", () => {
    const path = `${"n".repeat(140)}.txt`;
    expect(tarNameLayout(path).kind).toBe("longname");
    const source = createTarChunkSource([memEntry(path, "long")])!;
    return drain(source).then((tar) => {
      const parsed = parseTar(tar);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe(path);
    });
  });

  it("encodes oversize members with base-256 size", async () => {
    const big = 9 * 1024 * 1024 * 1024; // 9 GiB，八进制 12 位字段放不下
    const entry: FolderArchiveEntry = { relativePath: "proj/huge.bin", size: big, readChunk: async () => new Uint8Array(0) };
    const source = createTarChunkSource([entry])!;
    // 只解析头（内容生成器会向 source 读 9GiB，这里直取首块校验 size 字段）。
    const header = await source.readChunk(0, 512);
    expect(header[124]).toBe(0x80);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    expect(view.getBigUint64(128, false)).toBe(BigInt(big));
  });

  it("supports forward-only resume skips", async () => {
    const entries = [memEntry("proj/a.txt", "alpha"), memEntry("proj/b.txt", "beta-longer-content")];
    const source = createTarChunkSource(entries)!;
    const skip = 700; // 落在首条目内容内
    await source.readChunk(skip, 10);
    const chunk = await source.readChunk(skip + 10, 10);
    const whole = await drain(createTarChunkSource(entries)!);
    expect(Array.from(chunk)).toEqual(Array.from(whole.subarray(skip + 10, skip + 20)));
  });

  it("returns no source past the transfer size limit", () => {
    const huge: FolderArchiveEntry = { relativePath: "proj/big.bin", size: 17 * 1024 * 1024 * 1024, readChunk: async () => new Uint8Array(0) };
    expect(createTarChunkSource([huge])).toBeUndefined();
  });
});
