/** 文件夹整包上传车道（folderArchive）：把拖拽/选择器展开的文件清单流式打成
 * 单个 POSIX ustar tar（纯实现，无新运行时依赖），交给既有上传管线——网络腿
 * gzip（M33，sidecar 对 spool 压缩后再推）与 sudo 车道（UploadSudo）都由
 * uploadSource 原生接管；落盘后由后端 `sftp/extract`（sudo 车道 sudo tar）
 * 在远端解包。tar 逐字节可预算（512 头 + 内容补齐 + 结尾两块零块），因此
 * 无需预压缩即可声明精确大小。
 *
 * 边界（登记）：条目 mode 统一 0644/uid=gid=0（拖拽清单不携带权限/属主）；
 * 无 mtime 的条目（宿主桥车道）落档时间；latin-1 连接不走该车道（tar 头名
 * 字节按 UTF-8 写，exec 解包命令串同为 UTF-8 边界）。 */

export interface FolderArchiveEntry {
  relativePath: string;
  size: number;
  readChunk: (offset: number, length: number) => Promise<Uint8Array>;
  /** 秒级 mtime；宿主桥清单不含，缺省落档时刻。 */
  mtimeSecs?: number;
}

/** 文件数达到该阈值即自动整包：逐文件上传在 sudo 车道每文件一次 sudo 编排，
 * 大目录下耗时与失败面都线性放大；整包后是 1 次上传 + 1 条远端 tar。 */
export const FOLDER_ARCHIVE_THRESHOLD = 200;

/** 与 sidecar `MAX_TRANSFER_SIZE` 对齐：整包超过则回退逐文件上传。 */
const ARCHIVE_SIZE_LIMIT = 16 * 1024 * 1024 * 1024;

const BLOCK = 512;
/** 单文件 8 GiB 以上 ustar 八进制 size 字段放不下，走 base-256（GNU/BSD tar
 * 均支持）。该值同时是八进制编码的上界。 */
const OCTAL_SIZE_MAX = 8 * 1024 * 1024 * 1024;
/** 内容分片读取的块大小：流式生成，内存只驻留常数个分片。 */
const CONTENT_PIECE = 1024 * 1024;

export function shouldFolderArchive(fileCount: number): boolean {
  return fileCount >= FOLDER_ARCHIVE_THRESHOLD;
}

/** 归档名取首个条目的顶层目录名；多根拖拽（同批丢多个文件夹）按原布局
 * 打包，解包后与逐文件车道落点一致。 */
export function folderArchiveName(entries: readonly { relativePath: string }[]): string {
  const root = entries[0]?.relativePath.split("/")[0]?.trim();
  return `${root || "folder"}.tar`;
}

function pad512(size: number): number {
  return size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK);
}

const encoder = new TextEncoder();

type TarNameLayout =
  | { kind: "plain"; name: Uint8Array }
  | { kind: "split"; name: Uint8Array; prefix: Uint8Array }
  | { kind: "longname"; name: Uint8Array };

/** 名字字节布局：≤100 直接放 name 字段；更长先试 ustar 前缀拆分（'/' 字节
 * 边界，prefix ≤155 且剩余 name ≤100），拆不开走 GNU LongLink 附加条目。 */
export function tarNameLayout(path: string): TarNameLayout {
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return { kind: "plain", name: bytes };
  let cut = -1;
  for (let index = Math.min(bytes.length - 2, 100 + 155); index >= 0; index -= 1) {
    if (bytes[index] !== 0x2f) continue;
    // name 部分从 '/' 后一个字节开始，最长 100 字节。
    if (bytes.length - (index + 1) <= 100 && index <= 155) {
      cut = index;
      break;
    }
  }
  if (cut > 0) {
    return { kind: "split", name: bytes.subarray(cut + 1), prefix: bytes.subarray(0, cut) };
  }
  return { kind: "longname", name: bytes };
}

function writeOctal(field: Uint8Array, value: number): void {
  // 11 位八进制 + NUL（size/mtime）；7 位 + NUL（mode/uid/gid/dev）。
  const digits = field.length - 1;
  let text = value.toString(8);
  if (text.length > digits) text = "7".repeat(digits); // 不应发生：调用方保证
  let offset = digits - text.length;
  for (let index = 0; index < offset; index += 1) field[index] = 0x30;
  for (const char of text) field[offset++] = char.charCodeAt(0);
  field[digits] = 0;
}

function writeSizeField(field: Uint8Array, size: number): void {
  if (size < OCTAL_SIZE_MAX) {
    writeOctal(field, size);
    return;
  }
  // base-256：首字节 0x80 旗标 + 12 字节大端值（写进后 8 字节即可覆盖 2^64）。
  field[0] = 0x80;
  field[1] = 0;
  field[2] = 0;
  field[3] = 0;
  // subarray 与 header 共享 buffer：DataView 必须锚定 field 自身的偏移。
  new DataView(field.buffer, field.byteOffset, field.byteLength).setBigUint64(4, BigInt(size), false);
}

function putBytes(field: Uint8Array, offset: number, bytes: Uint8Array, limit: number): void {
  const clipped = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  field.set(clipped, offset);
}

function writeHeader(options: { name: Uint8Array; prefix?: Uint8Array; size: number; mtimeSecs: number; typeflag: string }): Uint8Array {
  const header = new Uint8Array(BLOCK);
  putBytes(header, 0, options.name, 100);
  writeOctal(header.subarray(100, 108), 0o644);
  writeOctal(header.subarray(108, 116), 0);
  writeOctal(header.subarray(116, 124), 0);
  writeSizeField(header.subarray(124, 136), options.size);
  writeOctal(header.subarray(136, 148), options.mtimeSecs);
  header.fill(0x20, 148, 156); // chksum 先按全空格累计
  header[156] = options.typeflag.charCodeAt(0);
  putBytes(header, 257, encoder.encode("ustar"), 6);
  putBytes(header, 263, encoder.encode("00"), 2);
  writeOctal(header.subarray(329, 337), 0);
  writeOctal(header.subarray(337, 345), 0);
  if (options.prefix?.length) putBytes(header, 345, options.prefix, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  // chksum：6 位八进制 + NUL + 空格。
  let text = checksum.toString(8);
  text = "0".repeat(6 - text.length) + text;
  for (let index = 0; index < 6; index += 1) header[148 + index] = text.charCodeAt(index);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** 条目名的截断回退（LongLink 伴随头仍需一个合法 name 字段）：按 UTF-8
 * 边界截到 ≤100 字节。 */
function truncatedName(bytes: Uint8Array): Uint8Array {
  let end = Math.min(bytes.length, 100);
  while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function entrySizeContribution(entry: FolderArchiveEntry): number {
  const layout = tarNameLayout(entry.relativePath);
  let total = entry.size + BLOCK + pad512(entry.size);
  if (layout.kind === "longname") {
    const longContent = layout.name.length + 1;
    total += BLOCK + longContent + pad512(longContent);
  }
  return total;
}

/** 整包字节数（精确）；超过传输上限返回 undefined（调用方回退逐文件）。 */
export function folderArchiveSize(entries: readonly FolderArchiveEntry[]): number | undefined {
  let total = 2 * BLOCK;
  for (const entry of entries) total += entrySizeContribution(entry);
  if (total > ARCHIVE_SIZE_LIMIT) return undefined;
  return total;
}

async function* tarPieces(entries: readonly FolderArchiveEntry[], defaultMtime: number): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    const layout = tarNameLayout(entry.relativePath);
    const mtimeSecs = Math.floor(entry.mtimeSecs ?? defaultMtime);
    if (layout.kind === "longname") {
      const content = new Uint8Array(layout.name.length + 1);
      content.set(layout.name);
      yield writeHeader({ name: encoder.encode("././@LongLink"), size: content.length, mtimeSecs, typeflag: "L" });
      yield content;
      if (pad512(content.length)) yield new Uint8Array(pad512(content.length));
      yield writeHeader({ name: truncatedName(layout.name), size: entry.size, mtimeSecs, typeflag: "0" });
    } else {
      yield writeHeader({
        name: layout.name,
        prefix: layout.kind === "split" ? layout.prefix : undefined,
        size: entry.size,
        mtimeSecs,
        typeflag: "0",
      });
    }
    let offset = 0;
    while (offset < entry.size) {
      const piece = await entry.readChunk(offset, Math.min(CONTENT_PIECE, entry.size - offset));
      if (!piece.byteLength) throw new Error(`folder archive source short read: ${entry.relativePath}`);
      offset += piece.byteLength;
      yield piece;
    }
    if (pad512(entry.size)) yield new Uint8Array(pad512(entry.size));
  }
  yield new Uint8Array(2 * BLOCK);
}

interface TarStreamState {
  pieces: AsyncGenerator<Uint8Array>;
  queue: Uint8Array[];
  queued: number;
  cursor: number;
  eof: boolean;
}

async function pullPiece(state: TarStreamState): Promise<void> {
  const next = await state.pieces.next();
  if (next.done) {
    state.eof = true;
    return;
  }
  state.queue.push(next.value);
  state.queued += next.value.byteLength;
}

function takeFromQueue(state: TarStreamState, length: number): Uint8Array {
  const merged = new Uint8Array(Math.min(length, state.queued));
  let filled = 0;
  while (filled < merged.length && state.queue.length) {
    const head = state.queue[0];
    const take = Math.min(head.byteLength, merged.length - filled);
    merged.set(take ? head.subarray(0, take) : head, filled);
    filled += take;
    if (take >= head.byteLength) {
      state.queue.shift();
    } else {
      state.queue[0] = head.subarray(take);
    }
    state.queued -= take;
  }
  state.cursor += merged.length;
  return merged;
}

export interface FolderArchiveSource {
  name: string;
  size: number;
  readChunk: (offset: number, length: number) => Promise<Uint8Array>;
}

/** 流式 tar 源：readChunk 只向前推进（断点续传时先本地丢弃重生成的前缀，
 * 这些字节不经过网络）。 */
export function createTarChunkSource(entries: readonly FolderArchiveEntry[], archiveName?: string): FolderArchiveSource | undefined {
  const size = folderArchiveSize(entries);
  if (size === undefined) return undefined;
  const state: TarStreamState = {
    pieces: tarPieces(entries, Math.floor(Date.now() / 1000)),
    queue: [],
    queued: 0,
    cursor: 0,
    eof: false,
  };
  async function readChunk(offset: number, length: number): Promise<Uint8Array> {
    if (offset < state.cursor) throw new Error("folder archive stream is forward-only");
    // 断点续传：本地重生成并丢弃前缀（这些字节不经过网络）。
    while (state.cursor < offset) {
      if (!state.queued && !state.eof) await pullPiece(state);
      if (!state.queued) throw new Error("folder archive stream ended before resume offset");
      takeFromQueue(state, Math.min(offset - state.cursor, state.queued));
    }
    while (!state.eof && state.queued < length) await pullPiece(state);
    return takeFromQueue(state, length);
  }
  return { name: archiveName ?? folderArchiveName(entries), size, readChunk };
}
