import * as Zmodem from "zmodem.js";
import type { Detection, Session, Sentry, Transfer } from "zmodem.js";

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

function validTransferOffset(transfer: Transfer, fileSize: number): number {
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
