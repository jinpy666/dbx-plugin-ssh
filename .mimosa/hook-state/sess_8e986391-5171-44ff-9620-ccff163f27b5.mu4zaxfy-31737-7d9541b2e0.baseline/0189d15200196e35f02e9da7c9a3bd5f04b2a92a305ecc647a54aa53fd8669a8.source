/**
 * trzsz (trz / tsz) terminal file transfer support (parity with tssh).
 *
 * The wire protocol is driven by the official `trzsz` npm package
 * (TrzszFilter): server output goes in via processServerOutput, keyboard
 * input via processTerminalInput, and the filter forwards everything
 * untouched until it sees the remote `::TRZSZ:TRANSFER:` announce, at which
 * point it takes the stream over for one transfer.
 *
 * This module owns the pieces the package cannot do for a DBX sandboxed
 * frontend:
 *  - announce detection for the plugin-side overlay/mutual-exclusion state,
 *  - the file-transfer-busy routing decisions shared with the ZMODEM guard,
 *  - a progress state machine fed by the TrzszTransfer progress callbacks,
 *  - browser-File readers / in-memory writers (the package's browser paths
 *    require the File System Access API, which WKWebView sandboxes lack),
 *  - a bridge that overrides the filter's private file-choosing handlers
 *    (chooseSendFiles/chooseSaveDirectory are ignored in browser builds).
 */

import type { TrzszFilter } from "trzsz";

// ---------------------------------------------------------------------------
// Announce detection (::TRZSZ:TRANSFER:<mode>:<version>[:<uniqueId>])
// ---------------------------------------------------------------------------

/** Mode S = server sends (client downloads); R/D = server receives (client uploads; D allows directories). */
export type TrzszTransferDirection = "upload" | "download";

export interface TrzszAnnounce {
  direction: TrzszTransferDirection;
  directory: boolean;
  version: string;
}

const TRZSZ_ANNOUNCE_REGEXP = /::TRZSZ:TRANSFER:([SRD]):(\d+\.\d+\.\d+)(:\d+)?/;

export function detectTrzszAnnounce(text: string): TrzszAnnounce | null {
  const found = TRZSZ_ANNOUNCE_REGEXP.exec(text);
  if (!found) return null;
  const mode = found[1];
  const version = found[2];
  if (mode === "S") return { direction: "download", directory: false, version };
  if (mode === "R") return { direction: "upload", directory: false, version };
  if (mode === "D") return { direction: "upload", directory: true, version };
  return null;
}

/** Latin1 scan of a PTY frame; good enough to locate the ASCII announce. */
export function detectTrzszAnnounceFromBytes(data: Uint8Array): TrzszAnnounce | null {
  let text = "";
  const chunkSize = 8192;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    text += String.fromCharCode(...chunk);
  }
  return detectTrzszAnnounce(text);
}

// ---------------------------------------------------------------------------
// Mutual exclusion with ZMODEM (one file transfer protocol owns the stream)
// ---------------------------------------------------------------------------

export type TerminalInputRoute = "pty" | "trzsz" | "blocked";

/**
 * While a trzsz transfer owns the stream, keyboard input must not reach the
 * remote shell: the caller routes it into the filter while a transfer is
 * running (Ctrl+C stops the transfer, the rest is swallowed) and blocks it
 * while waiting; while ZMODEM is busy it owns the stream and input stays
 * blocked; otherwise input follows the plain PTY path.
 */
export function resolveTerminalInputRoute(options: { zmodemBusy: boolean; trzszBusy: boolean }): TerminalInputRoute {
  if (options.trzszBusy) return "trzsz";
  if (options.zmodemBusy) return "blocked";
  return "pty";
}

export function canStartTrzszTransfer(options: { zmodemBusy: boolean; trzszBusy: boolean }): boolean {
  return !options.zmodemBusy && !options.trzszBusy;
}

// ---------------------------------------------------------------------------
// Progress state machine (fed by TrzszTransfer progress callbacks)
// ---------------------------------------------------------------------------

export type TrzszProgressPhase = "idle" | "waiting" | "transferring" | "success" | "failed";

export type TrzszProgressEvent =
  | { type: "waiting"; direction: TrzszTransferDirection }
  | { type: "started"; direction: TrzszTransferDirection }
  | { type: "num"; count: number }
  | { type: "name"; name: string }
  | { type: "size"; size: number }
  | { type: "step"; step: number }
  | { type: "file-done" }
  | { type: "success" }
  | { type: "failure"; message: string }
  | { type: "cancelled" }
  | { type: "reset" };

export interface TrzszProgressState {
  phase: TrzszProgressPhase;
  direction: TrzszTransferDirection | "";
  fileIndex: number;
  fileCount: number;
  fileName: string;
  fileTransferred: number;
  fileSize: number;
  completedTransferred: number;
  totalTransferred: number;
  totalSize: number;
  message: string;
}

export function initialTrzszProgressState(): TrzszProgressState {
  return {
    phase: "idle",
    direction: "",
    fileIndex: 0,
    fileCount: 0,
    fileName: "",
    fileTransferred: 0,
    fileSize: 0,
    completedTransferred: 0,
    totalTransferred: 0,
    totalSize: 0,
    message: "",
  };
}

export function reduceTrzszProgress(state: TrzszProgressState, event: TrzszProgressEvent): TrzszProgressState {
  switch (event.type) {
    case "reset":
    case "cancelled":
      return initialTrzszProgressState();
    case "waiting":
      return { ...initialTrzszProgressState(), phase: "waiting", direction: event.direction };
    case "started":
      return { ...initialTrzszProgressState(), phase: "transferring", direction: event.direction };
    case "num":
      return { ...state, phase: "transferring", fileCount: Math.max(0, event.count), fileIndex: 0, completedTransferred: 0, totalTransferred: 0 };
    case "name":
      return {
        ...state,
        fileIndex: Math.min(state.fileIndex + 1, state.fileCount || state.fileIndex + 1),
        fileName: event.name,
        fileTransferred: 0,
        fileSize: 0,
      };
    case "size": {
      const size = Math.max(0, event.size);
      return { ...state, fileSize: size, totalSize: state.totalSize + size };
    }
    case "step": {
      const step = Math.max(0, event.step);
      return { ...state, phase: "transferring", fileTransferred: state.fileSize > 0 ? Math.min(step, state.fileSize) : step, totalTransferred: state.completedTransferred + step };
    }
    case "file-done":
      return { ...state, completedTransferred: state.completedTransferred + state.fileTransferred, totalTransferred: state.completedTransferred + state.fileTransferred };
    case "success":
      return { ...state, phase: "success", totalTransferred: state.totalSize };
    case "failure":
      return { ...state, phase: "failed", message: event.message };
  }
}

export function trzszProgressPercent(state: TrzszProgressState): number {
  if (state.phase === "success") return 100;
  const useTotal = state.totalSize > 0;
  const total = useTotal ? state.totalSize : state.fileSize;
  const transferred = useTotal ? state.totalTransferred : state.fileTransferred;
  return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
}

/** Adapts the reducer events to the progress callback shape TrzszTransfer expects. */
export interface TrzszProgressCallbacks {
  onNum(count: number): void;
  onName(name: string): void;
  onSize(size: number): void;
  onStep(step: number): void;
  onDone(): void;
}

export function createTrzszProgressCallback(emit: (event: TrzszProgressEvent) => void): TrzszProgressCallbacks {
  return {
    onNum: (count) => emit({ type: "num", count }),
    onName: (name) => emit({ type: "name", name }),
    onSize: (size) => emit({ type: "size", size }),
    onStep: (step) => emit({ type: "step", step }),
    onDone: () => emit({ type: "file-done" }),
  };
}

/** Ctrl+C on a running trzsz transfer surfaces as a bare "Stopped" error. */
export function isTrzszStopMessage(message: string): boolean {
  return message.trim() === "Stopped";
}

// ---------------------------------------------------------------------------
// Remote file naming (plain name, or a directory JSON with a relative path)
// ---------------------------------------------------------------------------

export interface TrzszRemoteName {
  fileName: string;
  isDirectory: boolean;
}

/** ["dir", "sub", "a.txt"] -> "dir-sub-a.txt": browser saves have no directories. */
export function flattenTrzszPathName(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("-");
}

export function parseTrzszRemoteName(fileName: string, directory: boolean): TrzszRemoteName {
  const raw = typeof fileName === "string" && fileName ? fileName : "file";
  if (!directory) return { fileName: raw, isDirectory: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const flat = flattenTrzszPathName((parsed as { path_name?: unknown }).path_name);
      if (flat) return { fileName: flat, isDirectory: (parsed as { is_dir?: unknown }).is_dir === true };
    }
  } catch {
    // Not the directory JSON shape: keep the raw name.
  }
  return { fileName: raw, isDirectory: false };
}

// ---------------------------------------------------------------------------
// Browser File reader / in-memory writer (duck-typed TrzszFileReader/Writer)
// ---------------------------------------------------------------------------

export interface TrzszFileReaderLike {
  getPathId(): number;
  getRelPath(): string[];
  isDir(): boolean;
  getSize(): number;
  readFile(buf: ArrayBuffer): Promise<Uint8Array>;
  closeFile(): void;
}

export function createFileTrzszReader(pathId: number, file: File): TrzszFileReaderLike {
  let position = 0;
  let closed = false;
  return {
    getPathId: () => pathId,
    getRelPath: () => [file.name],
    isDir: () => false,
    getSize: () => file.size,
    async readFile(buf: ArrayBuffer) {
      if (closed || position >= file.size) return new Uint8Array(0);
      const length = Math.min(buf.byteLength, file.size - position);
      const chunk = file.slice(position, position + length);
      position += length;
      return new Uint8Array(await chunk.arrayBuffer());
    },
    closeFile() {
      closed = true;
    },
  };
}

export interface TrzszDownloadFile {
  fileName: string;
  isDirectory: boolean;
  chunks: Uint8Array[];
  byteLength: number;
}

export interface TrzszFileWriterLike {
  getFileName(): string;
  getLocalName(): string;
  isDir(): boolean;
  writeFile(buf: Uint8Array): Promise<void>;
  closeFile(): void;
  deleteFile(): Promise<string>;
}

export function createBufferTrzszWriter(target: TrzszDownloadFile): TrzszFileWriterLike {
  let closed = false;
  return {
    getFileName: () => target.fileName,
    getLocalName: () => target.fileName,
    isDir: () => target.isDirectory,
    async writeFile(buf: Uint8Array) {
      if (closed) throw new Error(`Write after close: ${target.fileName}`);
      target.chunks.push(buf);
      target.byteLength += buf.byteLength;
    },
    closeFile() {
      closed = true;
    },
    async deleteFile() {
      return "";
    },
  };
}

// ---------------------------------------------------------------------------
// Filter bridge: override the private handlers the browser build hard-wires
// to the File System Access API (absent in sandboxed/WebView environments).
// ---------------------------------------------------------------------------

export interface TrzszUiBridge {
  /** Browser multi-select for `trz` uploads; undefined/empty = user cancelled. */
  pickUploadFiles(directory: boolean): Promise<File[] | undefined>;
  /** Persists finished download buffers (host fileTransfer API or `<a download>`). */
  saveDownloadedFiles(files: TrzszDownloadFile[]): Promise<void>;
  emit(event: TrzszProgressEvent): void;
}

type TrzszTransferCore = {
  sendAction(confirm: boolean, remoteIsWindows: boolean): Promise<void>;
  recvConfig(): Promise<Record<string, unknown>>;
  sendFiles(files: TrzszFileReaderLike[], progress: TrzszProgressCallbacks | null): Promise<string[]>;
  recvFiles(saveParam: unknown, openSaveFile: (saveParam: unknown, fileName: string, directory: boolean, overwrite: boolean) => Promise<TrzszFileWriterLike>, progress: TrzszProgressCallbacks | null): Promise<string[]>;
  clientExit(message: string): Promise<void>;
};

/** Runtime shape of the filter's privates (TS `private` is not runtime-enforced). */
type TrzszFilterInternals = {
  trzszTransfer: TrzszTransferCore | null;
  uploadFilesList: TrzszFileReaderLike[] | null;
} & Record<"handleTrzszUploadFiles" | "handleTrzszDownloadFiles", (...args: unknown[]) => Promise<void>>;

export function formatTrzszSavedFiles(names: readonly string[]): string {
  const count = names.length;
  return [`Saved ${count} ${count === 1 ? "file/directory" : "files/directories"}`].concat([...names]).join("\r\n- ");
}

export function installTrzszHandlers(filter: TrzszFilter, bridge: TrzszUiBridge): void {
  const internals = filter as unknown as TrzszFilterInternals;

  internals.handleTrzszUploadFiles = async (version: unknown, directory: unknown, remoteIsWindows: unknown) => {
    const transfer = internals.trzszTransfer;
    if (!transfer) return;
    let readers = internals.uploadFilesList;
    internals.uploadFilesList = null;
    try {
      if (!readers || !readers.length) {
        const files = await bridge.pickUploadFiles(Boolean(directory));
        readers = (files ?? []).map((file, pathId) => createFileTrzszReader(pathId, file));
      }
      if (!readers.length) {
        // Decline keeps the remote `trz` exit clean, like the stock cancel path.
        await transfer.sendAction(false, Boolean(remoteIsWindows));
        bridge.emit({ type: "cancelled" });
        return;
      }
      bridge.emit({ type: "started", direction: "upload" });
      await transfer.sendAction(true, Boolean(remoteIsWindows));
      await transfer.recvConfig();
      const remoteNames = await transfer.sendFiles(readers, createTrzszProgressCallback(bridge.emit));
      await transfer.clientExit(formatTrzszSavedFiles(remoteNames));
      bridge.emit({ type: "success" });
    } catch (cause) {
      bridge.emit({ type: "failure", message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  };

  internals.handleTrzszDownloadFiles = async (_version: unknown, remoteIsWindows: unknown) => {
    const transfer = internals.trzszTransfer;
    if (!transfer) return;
    const files: TrzszDownloadFile[] = [];
    try {
      bridge.emit({ type: "started", direction: "download" });
      await transfer.sendAction(true, Boolean(remoteIsWindows));
      const config = await transfer.recvConfig();
      const directoryMode = config.directory === true;
      const openSaveFile = async (_saveParam: unknown, fileName: string, directory: boolean) => {
        const parsed = parseTrzszRemoteName(fileName, directory || directoryMode);
        const target: TrzszDownloadFile = { fileName: parsed.fileName, isDirectory: parsed.isDirectory, chunks: [], byteLength: 0 };
        files.push(target);
        return createBufferTrzszWriter(target);
      };
      const localNames = await transfer.recvFiles(null, openSaveFile, createTrzszProgressCallback(bridge.emit));
      await transfer.clientExit(formatTrzszSavedFiles(localNames));
      // Save only after the protocol finished cleanly: a failed transfer must
      // not leave half-written browser downloads behind.
      await bridge.saveDownloadedFiles(files);
      bridge.emit({ type: "success" });
    } catch (cause) {
      bridge.emit({ type: "failure", message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
  };
}
