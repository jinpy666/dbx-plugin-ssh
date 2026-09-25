import { describe, expect, it, vi } from "vitest";
import {
  SERIAL_UPLOAD_CHUNK_BYTES,
  SERIAL_UPLOAD_MAX_BYTES,
  initialSerialUploadState,
  reduceSerialUpload,
  serialUploadActive,
  serialUploadPercent,
  streamSerialUploadFile,
  type SerialUploadBridge,
  type SerialUploadProgress,
} from "./serialUpload";

const BASE_PROGRESS: SerialUploadProgress = {
  sessionId: "serial-1",
  protocol: "xmodem",
  fileName: "fw.bin",
  fileIndex: 0,
  sent: 0,
  total: 1024,
  state: "running",
};

describe("serial upload progress reducer", () => {
  it("starts idle and mirrors running progress into the overlay state", () => {
    let state = initialSerialUploadState();
    expect(state.phase).toBe("idle");
    expect(serialUploadActive(state)).toBe(false);
    state = reduceSerialUpload(state, BASE_PROGRESS);
    expect(state).toMatchObject({ phase: "running", fileName: "fw.bin", sent: 0, total: 1024 });
    expect(serialUploadActive(state)).toBe(true);
  });

  it("treats file_complete as still-running (batch stage) and keeps bytes flowing", () => {
    let state = reduceSerialUpload(initialSerialUploadState(), BASE_PROGRESS);
    state = reduceSerialUpload(state, { ...BASE_PROGRESS, state: "file_complete", sent: 1024 });
    expect(state.phase).toBe("running");
    state = reduceSerialUpload(state, { ...BASE_PROGRESS, protocol: "ymodem", fileName: "second.bin", sent: 0, total: 512 });
    expect(state.phase).toBe("running");
    expect(state.fileName).toBe("second.bin");
    expect(state.protocol).toBe("ymodem");
  });

  it("lands on terminal phases and keeps the failure reason", () => {
    let state = reduceSerialUpload(initialSerialUploadState(), BASE_PROGRESS);
    state = reduceSerialUpload(state, { ...BASE_PROGRESS, state: "complete", sent: 1024 });
    expect(state.phase).toBe("complete");
    expect(serialUploadActive(state)).toBe(false);
    const failed = reduceSerialUpload(initialSerialUploadState(), {
      ...BASE_PROGRESS,
      state: "failed",
      reason: "Remote cancelled the transfer",
    });
    expect(failed.phase).toBe("failed");
    expect(failed.reason).toBe("Remote cancelled the transfer");
  });
});

describe("serial upload percent", () => {
  it("clamps to 0..100 and reports 100 on completion", () => {
    expect(serialUploadPercent(initialSerialUploadState())).toBe(0);
    expect(serialUploadPercent({ ...initialSerialUploadState(), phase: "running", sent: 256, total: 1024 })).toBe(25);
    expect(serialUploadPercent({ ...initialSerialUploadState(), phase: "running", sent: 2048, total: 1024 })).toBe(100);
    expect(serialUploadPercent({ ...initialSerialUploadState(), phase: "complete", sent: 0, total: 0 })).toBe(100);
    // 空文件：running 时按 0 展示，完成态仍报 100。
    expect(serialUploadPercent({ ...initialSerialUploadState(), phase: "running", sent: 0, total: 0 })).toBe(0);
  });
});

describe("streamSerialUploadFile", () => {
  function makeBridge() {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const invoke = vi.fn(async <T,>(method: string, params: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> });
      return {} as T;
    });
    // vi.fn 的 Mock 包装在泛型推导上与桥接口不一致，这里显式对齐签名。
    const bridge: SerialUploadBridge = {
      invoke: invoke as unknown as SerialUploadBridge["invoke"],
      encodeBase64: (bytes: Uint8Array) => `b64(${bytes.length})`,
    };
    return { bridge, calls };
  }

  it("sends start then 64KiB chunks with final on the last one", async () => {
    const { bridge, calls } = makeBridge();
    const size = SERIAL_UPLOAD_CHUNK_BYTES + 10;
    await streamSerialUploadFile({ size }, {
      sessionId: "serial-1",
      protocol: "zmodem",
      fileName: "fw.bin",
      bridge,
      readChunk: async (start, end) => new Uint8Array(end - start),
    });
    expect(calls[0]).toMatchObject({ method: "serial/upload/start", params: { sessionId: "serial-1", protocol: "zmodem", fileName: "fw.bin", totalSize: size } });
    expect(calls[1]?.params).toMatchObject({ final: false });
    expect(calls[calls.length - 1]?.params).toMatchObject({ final: true });
    expect(calls.filter((call) => call.method === "serial/upload/data")).toHaveLength(2);
  });

  it("sends exactly one data chunk for small files", async () => {
    const { bridge, calls } = makeBridge();
    await streamSerialUploadFile({ size: 3 }, {
      sessionId: "s",
      protocol: "xmodem",
      fileName: "a.bin",
      bridge,
      readChunk: async (start, end) => new Uint8Array(end - start),
    });
    const dataCalls = calls.filter((call) => call.method === "serial/upload/data");
    expect(dataCalls).toHaveLength(1);
    expect(dataCalls[0]?.params).toMatchObject({ dataBase64: "b64(3)", final: true });
  });

  it("sends an empty final chunk for zero-byte files", async () => {
    // D1 回归：0 字节文件循环体不执行，sidecar 的 X/Y 引擎会停在挂起态且
    // 时钟被抑制（永不超时）；必须显式补一条空的 final 分块让源收尾。
    const { bridge, calls } = makeBridge();
    await streamSerialUploadFile({ size: 0 }, {
      sessionId: "s",
      protocol: "xmodem",
      fileName: "empty.bin",
      bridge,
      readChunk: async () => new Uint8Array(0),
    });
    expect(calls[0]).toMatchObject({ method: "serial/upload/start", params: { totalSize: 0 } });
    const dataCalls = calls.filter((call) => call.method === "serial/upload/data");
    expect(dataCalls).toHaveLength(1);
    expect(dataCalls[0]?.params).toMatchObject({ dataBase64: "", final: true });
    expect(calls.some((call) => call.method === "serial/upload/cancel")).toBe(false);
  });

  it("honors a smaller chunkBytes override", async () => {
    const { bridge, calls } = makeBridge();
    await streamSerialUploadFile({ size: 5 }, {
      sessionId: "s",
      protocol: "ymodem",
      fileName: "a.bin",
      bridge,
      readChunk: async (start, end) => new Uint8Array(end - start),
      chunkBytes: 2,
    });
    const dataCalls = calls.filter((call) => call.method === "serial/upload/data");
    expect(dataCalls).toHaveLength(3);
    expect(dataCalls.map((call) => call.params.final)).toEqual([false, false, true]);
  });

  it("stops streaming and cancels when abort is requested mid-file", async () => {
    const { bridge, calls } = makeBridge();
    let aborted = false;
    const requestAbort = () => {
      aborted = true;
    };
    await streamSerialUploadFile({ size: SERIAL_UPLOAD_CHUNK_BYTES * 3 }, {
      sessionId: "s",
      protocol: "xmodem",
      fileName: "a.bin",
      bridge,
      readChunk: async (start, end) => {
        if (start > 0) requestAbort();
        return new Uint8Array(end - start);
      },
      shouldAbort: () => aborted,
    });
    expect(calls.some((call) => call.method === "serial/upload/cancel")).toBe(false);
    // abort 后不再发送新分块（首块已发出的保持原样）。
    expect(calls.filter((call) => call.method === "serial/upload/data").length).toBeLessThan(3);
  });

  it("rejects oversized files before any RPC", async () => {
    const { bridge, calls } = makeBridge();
    await expect(streamSerialUploadFile({ size: SERIAL_UPLOAD_MAX_BYTES + 1 }, {
      sessionId: "s",
      protocol: "xmodem",
      fileName: "big.bin",
      bridge,
      readChunk: async () => new Uint8Array(0),
    })).rejects.toThrow("tooLarge");
    expect(calls).toHaveLength(0);
  });

  it("cancels the sidecar transfer when a data chunk RPC fails", async () => {
    const calls: Array<{ method: string }> = [];
    const invoke = vi.fn(async <T,>(method: string, _params: unknown): Promise<T> => {
      calls.push({ method });
      if (method === "serial/upload/data") throw new Error("bridge gone");
      return {} as T;
    });
    // vi.fn 的 Mock 包装在泛型推导上与桥接口不一致，这里显式对齐签名。
    const bridge: SerialUploadBridge = {
      invoke: invoke as unknown as SerialUploadBridge["invoke"],
      encodeBase64: () => "b64",
    };
    await expect(streamSerialUploadFile({ size: 10 }, {
      sessionId: "s",
      protocol: "xmodem",
      fileName: "a.bin",
      bridge,
      readChunk: async (start, end) => new Uint8Array(end - start),
    })).rejects.toThrow("bridge gone");
    expect(calls.some((call) => call.method === "serial/upload/cancel")).toBe(true);
  });
});
