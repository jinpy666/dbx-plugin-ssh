// issue #329：下载分块等待的兜底策略（纯函数）单测。
import { describe, expect, it } from "vitest";
import {
  classifyDownloadChunkWait,
  downloadChunkWaitDelayMs,
  DOWNLOAD_CHUNK_WAIT_FIRST_MS,
  DOWNLOAD_CHUNK_WAIT_MAX_MS,
  DOWNLOAD_CHUNK_WAIT_MAX_STATUS_FAILURES,
  DOWNLOAD_CHUNK_WAIT_STEP_MS,
} from "./downloadChunkWait";

describe("downloadChunkWaitDelayMs", () => {
  it("keeps the old 30s first probe and then settles on a 60s cadence", () => {
    expect(DOWNLOAD_CHUNK_WAIT_FIRST_MS).toBe(30_000);
    expect(DOWNLOAD_CHUNK_WAIT_STEP_MS).toBe(60_000);
    expect(downloadChunkWaitDelayMs(0)).toBe(30_000);
    expect(downloadChunkWaitDelayMs(1)).toBe(60_000);
    expect(downloadChunkWaitDelayMs(9)).toBe(60_000);
    expect(downloadChunkWaitDelayMs(-1)).toBe(30_000);
  });

  it("bounds a single chunk wait far below a healthy slow transfer", () => {
    // 256 KiB / 10 min ≈ 0.43 KiB/s：更慢的“读取”只能视为卡死。
    expect(DOWNLOAD_CHUNK_WAIT_MAX_MS).toBe(10 * 60_000);
    expect(DOWNLOAD_CHUNK_WAIT_MAX_STATUS_FAILURES).toBe(3);
  });
});

describe("classifyDownloadChunkWait", () => {
  it("keeps waiting while the sidecar has not advanced past the awaited offset", () => {
    // 慢链路正在读本片：transferred 仍停在 offset。
    expect(classifyDownloadChunkWait({ status: "running", transferred: 0 }, 0)).toBe("keep-waiting");
    expect(classifyDownloadChunkWait({ status: "queued", transferred: 262_144 }, 262_144)).toBe("keep-waiting");
    // transferred 缺失/非法也不得误判为丢帧。
    expect(classifyDownloadChunkWait({ status: "running" }, 0)).toBe("keep-waiting");
    expect(classifyDownloadChunkWait({ status: "running", transferred: Number.NaN }, 0)).toBe("keep-waiting");
  });

  it("fails fast once the sidecar advanced, because the emitted frame was lost", () => {
    expect(classifyDownloadChunkWait({ status: "running", transferred: 262_145 }, 0)).toBe("chunk-lost");
    expect(classifyDownloadChunkWait({ status: "running", transferred: 524_288 }, 262_144)).toBe("chunk-lost");
  });

  it("treats terminal task states as terminal", () => {
    for (const status of ["failed", "cancelled", "completed"]) {
      expect(classifyDownloadChunkWait({ status, transferred: 0 }, 0)).toBe("terminal");
    }
  });

  it("reports unavailable when the status probe returned nothing usable", () => {
    expect(classifyDownloadChunkWait(undefined, 0)).toBe("unavailable");
    expect(classifyDownloadChunkWait(null, 0)).toBe("unavailable");
  });
});
