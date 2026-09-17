import { describe, expect, it, vi } from "vitest";
import {
  canStartTrzszTransfer,
  createBufferTrzszWriter,
  createFileTrzszReader,
  createTrzszProgressCallback,
  detectTrzszAnnounce,
  detectTrzszAnnounceFromBytes,
  flattenTrzszPathName,
  formatTrzszSavedFiles,
  initialTrzszProgressState,
  installTrzszHandlers,
  isTrzszStopMessage,
  parseTrzszRemoteName,
  reduceTrzszProgress,
  resolveTerminalInputRoute,
  trzszProgressPercent,
  type TrzszDownloadFile,
  type TrzszProgressEvent,
  type TrzszProgressState,
} from "./terminalTrzsz";

describe("trzsz announce detection", () => {
  it("maps S to download and R/D to upload (D allowing directories)", () => {
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:S:1.0.0")).toEqual({ direction: "download", directory: false, version: "1.0.0" });
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:R:1.1.12")).toEqual({ direction: "upload", directory: false, version: "1.1.12" });
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:D:1.1.12")).toEqual({ direction: "upload", directory: true, version: "1.1.12" });
  });

  it("keeps the unique id suffix out of the version and matches announce inside output noise", () => {
    const announce = detectTrzszAnnounce("trz available\r\n::TRZSZ:TRANSFER:S:1.0.0:12345678901234\r\n");
    expect(announce?.version).toBe("1.0.0");
    expect(announce?.direction).toBe("download");
  });

  it("rejects plain text and malformed magic keys", () => {
    expect(detectTrzszAnnounce("total 42\ndrwxr-xr-x root")).toBeNull();
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:X:1.0.0")).toBeNull();
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:S:abc")).toBeNull();
    expect(detectTrzszAnnounce("")).toBeNull();
  });

  it("detects announces in raw PTY bytes", () => {
    const bytes = new TextEncoder().encode("\x1b[0m::TRZSZ:TRANSFER:R:1.0.0:42");
    expect(detectTrzszAnnounceFromBytes(bytes)?.direction).toBe("upload");
    expect(detectTrzszAnnounceFromBytes(new TextEncoder().encode("hello"))).toBeNull();
  });
});

describe("file transfer stream ownership (mutual exclusion with zmodem)", () => {
  it("routes keyboard input to the trzsz filter only while it owns the stream", () => {
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: false })).toBe("pty");
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: true })).toBe("trzsz");
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: false })).toBe("blocked");
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: true })).toBe("trzsz");
  });

  it("only allows a trzsz takeover when no other transfer protocol is active", () => {
    expect(canStartTrzszTransfer({ zmodemBusy: false, trzszBusy: false })).toBe(true);
    expect(canStartTrzszTransfer({ zmodemBusy: true, trzszBusy: false })).toBe(false);
    expect(canStartTrzszTransfer({ zmodemBusy: false, trzszBusy: true })).toBe(false);
  });
});

function reduceAll(events: TrzszProgressEvent[], initial: TrzszProgressState = initialTrzszProgressState()): TrzszProgressState {
  return events.reduce((state, event) => reduceTrzszProgress(state, event), initial);
}

describe("trzsz progress state machine", () => {
  it("walks waiting -> transferring -> success across multiple files", () => {
    const state = reduceAll([
      { type: "waiting", direction: "download" },
      { type: "started", direction: "download" },
      { type: "num", count: 2 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 40 },
      { type: "step", step: 100 },
      { type: "file-done" },
      { type: "name", name: "b.bin" },
      { type: "size", size: 50 },
      { type: "step", step: 25 },
    ]);
    expect(state.phase).toBe("transferring");
    expect(state.fileIndex).toBe(2);
    expect(state.fileCount).toBe(2);
    expect(state.fileName).toBe("b.bin");
    expect(state.fileTransferred).toBe(25);
    expect(state.totalTransferred).toBe(125);
    expect(state.totalSize).toBe(150);
    expect(trzszProgressPercent(state)).toBe(83);
  });

  it("reaches 100 percent on success even without a final size", () => {
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "empty.txt" },
      { type: "size", size: 0 },
      { type: "success" },
    ]);
    expect(state.phase).toBe("success");
    expect(trzszProgressPercent(state)).toBe(100);
  });

  it("falls back to the current file for the percent while totals are unknown", () => {
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "name", name: "a.log" },
      { type: "size", size: 200 },
      { type: "step", step: 50 },
    ]);
    expect(trzszProgressPercent(state)).toBe(25);
  });

  it("records failures with their message and resets on cancelled", () => {
    const failed = reduceAll([
      { type: "started", direction: "upload" },
      { type: "failure", message: "boom" },
    ]);
    expect(failed.phase).toBe("failed");
    expect(failed.message).toBe("boom");
    expect(reduceTrzszProgress(failed, { type: "cancelled" })).toEqual(initialTrzszProgressState());
  });

  it("does not count past the file size on trailing steps", () => {
    const state = reduceAll([
      { type: "started", direction: "download" },
      { type: "name", name: "a.log" },
      { type: "size", size: 10 },
      { type: "step", step: 99 },
    ]);
    expect(state.fileTransferred).toBe(10);
  });
});

describe("trzsz progress callback adapter", () => {
  it("maps the transfer callbacks onto reducer events", () => {
    const events: TrzszProgressEvent[] = [];
    const callbacks = createTrzszProgressCallback((event) => events.push(event));
    callbacks.onNum(1);
    callbacks.onName("a.log");
    callbacks.onSize(3);
    callbacks.onStep(2);
    callbacks.onDone();
    expect(events).toEqual([
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
      { type: "size", size: 3 },
      { type: "step", step: 2 },
      { type: "file-done" },
    ]);
  });
});

describe("trzsz remote name parsing for browser saves", () => {
  it("keeps plain file names untouched", () => {
    expect(parseTrzszRemoteName("a.log", false)).toEqual({ fileName: "a.log", isDirectory: false });
  });

  it("flattens directory download paths and detects directory entries", () => {
    const json = JSON.stringify({ path_id: "id1", path_name: ["dir", "sub", "a.log"], is_dir: false });
    expect(parseTrzszRemoteName(json, true)).toEqual({ fileName: "dir-sub-a.log", isDirectory: false });
    const dirJson = JSON.stringify({ path_id: "id2", path_name: ["dir"], is_dir: true });
    expect(parseTrzszRemoteName(dirJson, true)).toEqual({ fileName: "dir", isDirectory: true });
  });

  it("falls back to the raw name for malformed directory payloads", () => {
    expect(parseTrzszRemoteName("not json", true)).toEqual({ fileName: "not json", isDirectory: false });
    expect(flattenTrzszPathName("nope")).toBe("");
    expect(flattenTrzszPathName(["a", "", 3, "b"])).toBe("a-b");
  });
});

describe("browser file reader", () => {
  it("serves sequential chunks and an empty EOF read", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([payload], "a.bin");
    const reader = createFileTrzszReader(3, file);
    expect(reader.getSize()).toBe(5);
    expect(reader.getRelPath()).toEqual(["a.bin"]);
    expect(reader.getPathId()).toBe(3);
    expect(reader.isDir()).toBe(false);
    const first = await reader.readFile(new ArrayBuffer(3));
    expect([...first]).toEqual([1, 2, 3]);
    const second = await reader.readFile(new ArrayBuffer(3));
    expect([...second]).toEqual([4, 5]);
    expect(await reader.readFile(new ArrayBuffer(3))).toHaveLength(0);
    reader.closeFile();
    expect(await reader.readFile(new ArrayBuffer(3))).toHaveLength(0);
  });
});

describe("in-memory download writer", () => {
  it("accumulates chunks into the sink and reports the byte length", async () => {
    const target: TrzszDownloadFile = { fileName: "a.log", isDirectory: false, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    expect(writer.getLocalName()).toBe("a.log");
    await writer.writeFile(new Uint8Array([1, 2]));
    await writer.writeFile(new Uint8Array([3]));
    writer.closeFile();
    expect(target.chunks.map((chunk) => [...chunk])).toEqual([[1, 2], [3]]);
    expect(target.byteLength).toBe(3);
    expect(await writer.deleteFile()).toBe("");
  });

  it("rejects writes after close", async () => {
    const target: TrzszDownloadFile = { fileName: "a.log", isDirectory: false, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    writer.closeFile();
    await expect(writer.writeFile(new Uint8Array([1]))).rejects.toThrow(/after close/);
  });

  it("marks directory entries without buffering data", () => {
    const target: TrzszDownloadFile = { fileName: "dir", isDirectory: true, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    expect(writer.isDir()).toBe(true);
  });
});

describe("trzsz filter handler bridge", () => {
  interface FakeTransfer {
    sendAction: ReturnType<typeof vi.fn>;
    recvConfig: ReturnType<typeof vi.fn>;
    sendFiles: ReturnType<typeof vi.fn>;
    recvFiles: ReturnType<typeof vi.fn>;
    clientExit: ReturnType<typeof vi.fn>;
  }

  function createFakeFilter(transfer: Partial<FakeTransfer>) {
    const fakeTransfer = {
      sendAction: vi.fn().mockResolvedValue(undefined),
      recvConfig: vi.fn().mockResolvedValue({ binary: true }),
      sendFiles: vi.fn().mockResolvedValue(["remote-a.log"]),
      recvFiles: vi.fn().mockResolvedValue(["a.log"]),
      clientExit: vi.fn().mockResolvedValue(undefined),
      ...transfer,
    };
    const filter = { trzszTransfer: fakeTransfer, uploadFilesList: null } as unknown as Parameters<typeof installTrzszHandlers>[0];
    return { filter, fakeTransfer };
  }

  it("uploads picked files and reports success", async () => {
    const { filter, fakeTransfer } = createFakeFilter({});
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue([new File([new Uint8Array([1])], "a.log")]),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszUploadFiles("1.0.0", false, false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(true, false);
    expect(fakeTransfer.sendFiles).toHaveBeenCalledTimes(1);
    expect(fakeTransfer.clientExit).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["started", "success"]);
  });

  it("declines the transfer and emits cancelled when the user aborts the picker", async () => {
    const { filter, fakeTransfer } = createFakeFilter({});
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue(undefined),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszUploadFiles("1.0.0", false, false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(false, false);
    expect(fakeTransfer.sendFiles).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["cancelled"]);
  });

  it("emits failure and rethrows upload errors so the filter can notify the remote", async () => {
    const { filter, fakeTransfer } = createFakeFilter({ sendFiles: vi.fn().mockRejectedValue(new Error("disk full")) });
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue([new File([new Uint8Array([1])], "a.log")]),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await expect(internals.handleTrzszUploadFiles("1.0.0", false, false)).rejects.toThrow("disk full");
    expect(events.at(-1)).toEqual({ type: "failure", message: "disk full" });
  });

  it("buffers downloaded chunks and hands finished files to the save bridge", async () => {
    const { filter, fakeTransfer } = createFakeFilter({
      recvFiles: vi.fn().mockImplementation(async (_saveParam: unknown, openSaveFile: (param: unknown, name: string, directory: boolean, overwrite: boolean) => Promise<{ writeFile: (buf: Uint8Array) => Promise<void>; closeFile: () => void; getLocalName: () => string }>) => {
        const writer = await openSaveFile(null, "a.log", false, false);
        await writer.writeFile(new Uint8Array([7, 7, 7]));
        writer.closeFile();
        return [writer.getLocalName()];
      }),
    });
    const events: TrzszProgressEvent[] = [];
    const saveDownloadedFiles = vi.fn().mockResolvedValue(undefined);
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn(),
      saveDownloadedFiles,
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszDownloadFiles: (version: string, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszDownloadFiles("1.0.0", false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(true, false);
    expect(fakeTransfer.clientExit).toHaveBeenCalled();
    expect(saveDownloadedFiles).toHaveBeenCalledTimes(1);
    const saved = saveDownloadedFiles.mock.calls[0][0] as TrzszDownloadFile[];
    expect(saved).toHaveLength(1);
    expect(saved[0].fileName).toBe("a.log");
    expect(saved[0].byteLength).toBe(3);
    expect(events.map((event) => event.type)).toEqual(["started", "success"]);
  });

  it("does not save anything when the download transfer fails", async () => {
    const { filter } = createFakeFilter({ recvFiles: vi.fn().mockRejectedValue(new Error("timeout")) });
    const events: TrzszProgressEvent[] = [];
    const saveDownloadedFiles = vi.fn().mockResolvedValue(undefined);
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn(),
      saveDownloadedFiles,
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszDownloadFiles: (version: string, remoteIsWindows: boolean) => Promise<void> };
    await expect(internals.handleTrzszDownloadFiles("1.0.0", false)).rejects.toThrow("timeout");
    expect(saveDownloadedFiles).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "failure", message: "timeout" });
  });
});

describe("trzsz helpers", () => {
  it("recognizes the Ctrl+C stop error", () => {
    expect(isTrzszStopMessage("Stopped")).toBe(true);
    expect(isTrzszStopMessage("Stopped ")).toBe(true);
    expect(isTrzszStopMessage("Receive data timeout")).toBe(false);
  });

  it("formats the saved-files exit message for the remote terminal", () => {
    expect(formatTrzszSavedFiles(["a.log", "b.log"])).toBe("Saved 2 files/directories\r\n- a.log\r\n- b.log");
    expect(formatTrzszSavedFiles(["a.log"])).toBe("Saved 1 file/directory\r\n- a.log");
  });
});
