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
  | { action: "deny"; reason: "uploadPending" | "roleMismatch" };

export function decideZmodemDetection(
  detection: { get_session_role(): string },
  pendingUploadFiles: boolean,
  receiveAllowed = true,
): ZmodemDetectionDecision {
  const role = detection.get_session_role();
  if (role === "send") {
    return pendingUploadFiles ? { action: "confirm", role } : { action: "deny", reason: "roleMismatch" };
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
