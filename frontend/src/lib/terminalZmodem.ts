import * as Zmodem from "zmodem.js";
import type { Detection, Session, Sentry, Transfer, ZmodemFileDetails, ZmodemOffer } from "zmodem.js";

export interface ZmodemUploadProgress {
  file: File;
  fileIndex: number;
  fileCount: number;
  fileTransferred: number;
  totalTransferred: number;
  totalSize: number;
}

export interface ZmodemSentryHandlers {
  send(data: Uint8Array): void;
  toTerminal(data: Uint8Array): void;
  onDetect(detection: Detection): void;
  onRetract(): void;
}

const ZMODEM_CHUNK_SIZE = 64 * 1024;

/**
 * Decision for an incoming ZMODEM detection. The terminal owns the stream for
 * exactly one transfer at a time:
 * - a "send"-role session (peer announcing `sz`, i.e. offering files) is
 *   confirmed only when it matches the locally pending upload queue;
 * - a "receive"-role session (peer running `sz`, i.e. sending files to us) is
 *   confirmed whenever downloads are allowed and no upload is queued;
 * - everything else is denied so the peer's session terminates cleanly
 *   (deny() sends the ZMODEM abort sequence) instead of hanging the wire.
 */
export type ZmodemDetectionDecision =
  | { action: "confirm"; role: "send" | "receive" }
  | { action: "prompt-upload" }
  | { action: "deny"; reason: "uploadPending" | "roleMismatch" };

export function decideZmodemDetection(
  detection: { get_session_role(): string },
  pendingUploadFiles: boolean,
  receiveAllowed = true,
  options: { promptPeerRz?: boolean } = {},
): ZmodemDetectionDecision {
  const role = detection.get_session_role();
  if (role === "send") {
    if (pendingUploadFiles) return { action: "confirm", role };
    // 经典 lrzsz rz（用户在远端手敲 rz，issue #171）：send 角色检测携带的是
    // 完整 hex ZRINIT——机器生成且经 zmodem.js 帧解析 + CRC16 校验才走到这，
    // 自然文本误中需要刻意构造。提示式接管：不自动弹窗、不自动占线，用户
    // 选择参与才 confirm；超时/取消一律 deny（远端干净退出）。关闭提示时
    // 维持既有语义（deny = 发 abort 序列让对端结束）。
    if (options.promptPeerRz) return { action: "prompt-upload" };
    return { action: "deny", reason: "roleMismatch" };
  }
  if (pendingUploadFiles) return { action: "deny", reason: "uploadPending" };
  if (role === "receive" && receiveAllowed) return { action: "confirm", role };
  return { action: "deny", reason: "roleMismatch" };
}

const ZMODEM_FALLBACK_FILE_NAME = "download";
/** Leaves headroom for conflict-rename suffixes on every filesystem. */
const ZMODEM_MAX_FILE_NAME_CHARS = 180;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * The offer name is remote-controlled: a `../../` segment must never steer
 * the file outside the download target. Reduce it to a single safe basename
 * (POSIX and Windows separators, control characters, Windows-illegal glyphs
 * and reserved device names included) with a guaranteed non-empty result.
 */
export function sanitizeZmodemFileName(rawName: string): string {
  let name = rawName.split(/[\\/]+/).pop() ?? "";
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");
  name = name.replace(/[<>:"|?*]/g, "_");
  name = name.replace(/[. ]+$/g, "");
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  if (name.length > ZMODEM_MAX_FILE_NAME_CHARS) name = [...name].slice(0, ZMODEM_MAX_FILE_NAME_CHARS).join("");
  return name || ZMODEM_FALLBACK_FILE_NAME;
}

export function createZmodemSentry(handlers: ZmodemSentryHandlers): Sentry {
  return new Zmodem.Sentry({
    sender(data) {
      handlers.send(Uint8Array.from(data));
    },
    to_terminal(data) {
      if (data.length) handlers.toTerminal(Uint8Array.from(data));
    },
    on_detect: handlers.onDetect,
    on_retract: handlers.onRetract,
  });
}

// ---------------------------------------------------------------------------
// 检测定界器（issue #307）：恢复「hex 首帧 = 独立 burst」的检测前提。
//
// zmodem.js Sentry._parse 只在 hex 首帧恰为本次 consume 末尾时发出检测；
// 否则首帧字节已从其缓存剔除，若尾部杂字节把哨兵挤出 21 字节缓存窗口，
// 该次检测连同哨兵一起永久丢失。逐帧消费时代 PTY 写边界天然满足此前提；
// #302 合帧后同一 drain 批次里的回显/提示符等杂字节会跟在 ZRQINIT 后面，
// 远端 sz 的检测就此静默失效——状态条、进度、完成提示全不出现。
// ---------------------------------------------------------------------------

/** ZMODEM hex 首帧哨兵：`**` + ZDLE(0x18) + 'B'。 */
const ZMODEM_HEX_SENTINEL = [0x2a, 0x2a, 0x18, 0x42];
const ZMODEM_IS_HEX = /^[0-9a-f]$/i;

function bytesEqualAt(buf: Uint8Array, at: number, expected: readonly number[]): boolean {
  if (at + expected.length > buf.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (buf[at + i] !== expected[i]) return false;
  }
  return true;
}

function findHexSentinel(buf: Uint8Array, from: number): number {
  for (let at = from; at + ZMODEM_HEX_SENTINEL.length <= buf.length; at += 1) {
    if (bytesEqualAt(buf, at, ZMODEM_HEX_SENTINEL)) return at;
  }
  return -1;
}

/**
 * buf[at] 是哨兵。判定 hex 首帧的形状：
 * - 返回 >0：完整首帧的结束索引（哨兵 + 14 hex + CR/LF，可选紧随 XON）；
 * - 返回 -1：形状破坏（必不是首帧，可直接按显示字节放行）；
 * - 返回 -2：字节不足（可能是跨帧首帧，需要等待）。
 */
function classifyHexHeader(buf: Uint8Array, at: number): number {
  const hexEnd = at + 18;
  for (let i = at + 4; i < hexEnd; i += 1) {
    if (i >= buf.length) return -2;
    if (!ZMODEM_IS_HEX.test(String.fromCharCode(buf[i]))) return -1;
  }
  if (hexEnd >= buf.length) return -2;
  const cr = buf[hexEnd];
  if (cr !== 0x0d && cr !== 0x8d) return -1;
  const lfIndex = hexEnd + 1;
  if (lfIndex >= buf.length) return -2;
  const lf = buf[lfIndex];
  if (lf !== 0x0a && lf !== 0x8a) return -1;
  const xonIndex = lfIndex + 1;
  // zmlib 的 XON(0x11)：lrzsz hex 首帧可能紧跟一个（被流控吃掉也无妨）。
  if (xonIndex < buf.length && buf[xonIndex] === 0x11) return xonIndex + 1;
  return lfIndex + 1;
}

/** buf 尾部若挂着哨兵前缀（`*` / `**` / `**\x18` / `**\x18B`），返回其长度。 */
function tailSentinelPrefixLength(buf: Uint8Array): number {
  for (let keep = ZMODEM_HEX_SENTINEL.length - 1; keep >= 1; keep -= 1) {
    let matches = true;
    for (let i = 0; i < keep; i += 1) {
      if (buf[buf.length - keep + i] !== ZMODEM_HEX_SENTINEL[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return keep;
  }
  return 0;
}

export interface ZmodemDetectionFeeder {
  feed(data: Uint8Array): void;
}

/**
 * 把下行帧按检测边界切分后喂给 sentry 的 consume。字节保证逐个恰好喂入
 * 一次、顺序不变（显示流只是重新分块，不增不减）；空闲时（无活动会话）
 * 使用。会话进行中不必喂入：会话内解析是真正的流式解析，与 burst 边界
 * 无关。
 */
export function createZmodemDetectionFeeder(consume: (data: Uint8Array) => void): ZmodemDetectionFeeder {
  // 帧尾未完的哨兵/首帧残留（≤21 字节），与下一帧拼合后再判定。这是显示
  // 字节的极小延迟（一个 drain 帧），不是滞留：下一帧必然续完或判破放行。
  let held: Uint8Array = new Uint8Array(0);

  function feed(data: Uint8Array): void {
    let buf = data;
    if (held.length) {
      // held ≤ 21 字节：拼合而非展开（合帧批次可达 MiB 级，避免中间大数组）。
      buf = new Uint8Array(held.length + data.length);
      buf.set(held);
      buf.set(data, held.length);
      held = new Uint8Array(0);
    }
    let cursor = 0;
    while (cursor < buf.length) {
      const at = findHexSentinel(buf, cursor);
      if (at < 0) {
        // 快路径：无哨兵。帧尾挂哨兵前缀则留少量字节到下一帧续判。
        const keep = tailSentinelPrefixLength(buf.subarray(cursor));
        const cut = buf.length - keep;
        if (keep > 0) {
          if (cut > cursor) consume(buf.subarray(cursor, cut));
          held = buf.slice(cut);
        } else {
          consume(buf.subarray(cursor));
        }
        return;
      }
      if (at > cursor) consume(buf.subarray(cursor, at));
      const end = classifyHexHeader(buf, at);
      if (end === -2) {
        // 哨兵起的首帧未完：留到下一帧拼成完整独立 burst。
        held = buf.slice(at);
        return;
      }
      if (end === -1) {
        // 形状破坏：哨兵不是首帧开头，按显示字节放行并从其后继续扫。
        consume(buf.subarray(at, at + ZMODEM_HEX_SENTINEL.length));
        cursor = at + ZMODEM_HEX_SENTINEL.length;
        continue;
      }
      // 完整 hex 首帧：独占一个 consume burst，检测确定性恢复（issue #307）。
      consume(buf.subarray(at, end));
      cursor = end;
    }
  }

  return { feed };
}

export async function sendZmodemFiles(session: Session, files: readonly File[], onProgress?: (progress: ZmodemUploadProgress) => void): Promise<void> {
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  let totalTransferred = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const bytesRemaining = files.slice(fileIndex).reduce((sum, remaining) => sum + remaining.size, 0);
    const transfer = await session.send_offer({
      name: file.name,
      size: file.size,
      mtime: new Date(file.lastModified),
      files_remaining: files.length - fileIndex,
      bytes_remaining: bytesRemaining,
    });
    if (!transfer) continue;

    const initialOffset = validTransferOffset(transfer, file.size);
    let fileTransferred = initialOffset;
    totalTransferred += initialOffset;

    if (file.size === initialOffset) {
      await transfer.end(new Uint8Array());
      notifyProgress(onProgress, file, fileIndex, files.length, fileTransferred, totalTransferred, totalSize);
      continue;
    }

    while (fileTransferred < file.size) {
      if (session.aborted()) throw new Error("ZMODEM session aborted");
      const end = Math.min(fileTransferred + ZMODEM_CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(fileTransferred, end).arrayBuffer());
      const isLastChunk = end === file.size;
      if (isLastChunk) await transfer.end(chunk);
      else await transfer.send(chunk);
      fileTransferred = end;
      totalTransferred += chunk.byteLength;
      notifyProgress(onProgress, file, fileIndex, files.length, fileTransferred, totalTransferred, totalSize);
    }
  }

  await session.close();
}

/**
 * Receive-side session pump: starts the session (the ZRINIT that invites the
 * sender's first ZFILE is emitted by `start()`, not by `confirm()`) and
 * registers the batch offer handler. Resolves once the session ends
 * (ZFIN/OO, abort, or peer loss). An offer handler that throws resolves the
 * promise with `{ error }` so the caller can tear the session down — a
 * rejection inside the event emitter would otherwise surface as an unhandled
 * rejection while the wire sits idle.
 */
export function receiveZmodemSession(session: Session, onOffer: (offer: ZmodemOffer) => Promise<void> | void): Promise<{ error?: unknown }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: { error?: unknown }) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    session.on("offer", (offer) => {
      Promise.resolve()
        .then(() => onOffer(offer))
        .catch((cause) => settle({ error: cause }));
    });
    session.on("session_end", () => settle({}));
    // Receive sessions must be started explicitly: start() emits the ZRINIT
    // that invites the sender's first ZFILE (confirm() alone stays silent).
    void session.start?.()?.catch(() => undefined);
    if (session.has_ended()) settle({});
  });
}

/** Concatenates spooled receive chunks into one standalone buffer. */
export function mergeZmodemChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export type { ZmodemFileDetails, ZmodemOffer };

/** Clamps the peer-declared resume offset into [0, fileSize]; non-finite or
 * out-of-range values restart from zero instead of hanging the chunk loop. */
export function validTransferOffset(transfer: Transfer, fileSize: number): number {
  const offset = transfer.get_offset();
  return Number.isFinite(offset) && offset >= 0 && offset <= fileSize ? offset : 0;
}

function notifyProgress(callback: ((progress: ZmodemUploadProgress) => void) | undefined, file: File, fileIndex: number, fileCount: number, fileTransferred: number, totalTransferred: number, totalSize: number) {
  callback?.({
    file,
    fileIndex,
    fileCount,
    fileTransferred,
    totalTransferred,
    totalSize,
  });
}
