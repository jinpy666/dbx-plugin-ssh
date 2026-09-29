import { describe, expect, it } from "vitest";
import { mergeTransferProgress, transferCancelReason, type TransferProgressState } from "./transferProgress";

function state(overrides: Partial<TransferProgressState> = {}): TransferProgressState {
  return { transferred: 0, staged: 0, size: 1000, ...overrides };
}

describe("mergeTransferProgress", () => {
  it("keeps the push counter untouched while staging", () => {
    const merged = mergeTransferProgress(state(), { transferred: 300, size: 1000, phase: "staging" });
    expect(merged).toEqual({ transferred: 0, staged: 300, size: 1000, phase: "staging" });
    // 无 phase 事件（下载/旧 sidecar）不会被误判成 staging。
    expect(mergeTransferProgress(state(), { transferred: 300, size: 1000 }).phase).toBeUndefined();
  });

  it("allows the counter reset at the staging→uploading boundary", () => {
    let merged = mergeTransferProgress(undefined, { transferred: 500, size: 1000, phase: "staging" });
    merged = mergeTransferProgress(merged, { transferred: 100, size: 1000, phase: "uploading" });
    expect(merged).toEqual({ transferred: 100, staged: 500, size: 1000, phase: "uploading" });
  });

  it("clamps progress monotonic within the uploading phase", () => {
    let merged = mergeTransferProgress(undefined, { transferred: 400, size: 1000, phase: "uploading" });
    merged = mergeTransferProgress(merged, { transferred: 250, size: 1000, phase: "uploading" });
    expect(merged.transferred).toBe(400);
    merged = mergeTransferProgress(merged, { transferred: 900, size: 1000, phase: "uploading" });
    expect(merged.transferred).toBe(900);
  });

  it("drops non-finite and negative counts instead of poisoning the state", () => {
    expect(mergeTransferProgress(undefined, { transferred: Number.NaN, size: 1000, phase: "staging" }).staged).toBe(0);
    expect(mergeTransferProgress(undefined, { transferred: -5, size: 1000, phase: "uploading" }).transferred).toBe(0);
    expect(mergeTransferProgress(state({ size: 1000 }), { transferred: 10, size: "bogus", phase: "staging" }).size).toBe(1000);
  });

  it("marks completed without a phase as fully transferred", () => {
    expect(mergeTransferProgress(state({ transferred: 400 }), { transferred: 400, size: 1000, status: "completed" })).toEqual({ transferred: 1000, staged: 0, size: 1000 });
  });

  it("behaves like the legacy monotonic merge for downloads without phases", () => {
    let merged = mergeTransferProgress(undefined, { transferred: 100, size: 1000 });
    merged = mergeTransferProgress(merged, { transferred: 60, size: 1000 });
    expect(merged.transferred).toBe(100);
    merged = mergeTransferProgress(merged, { transferred: 120, size: 1000, status: "completed" });
    expect(merged.transferred).toBe(1000);
  });

  // —— 压缩通道（M29）：本地 CPU 阶段与网络阶段的计数隔离 ——

  it("keeps upload compressing bytes out of the transferred counter", () => {
    let merged = mergeTransferProgress(undefined, { transferred: 500, size: 1000, phase: "staging" });
    merged = mergeTransferProgress(merged, { transferred: 700, size: 1000, phase: "compressing" });
    // compressing 的字节记 staged（压缩输入进度），推送计数不动。
    expect(merged).toEqual({ transferred: 0, staged: 700, size: 1000, phase: "compressing" });
    // compressing→uploading 换阶段允许计数重置（分母切到压缩后体积）。
    merged = mergeTransferProgress(merged, { transferred: 40, size: 620, phase: "uploading" });
    expect(merged.transferred).toBe(40);
    expect(merged.size).toBe(620);
  });

  it("resets the download counter at each compressed prep phase boundary", () => {
    // 远端 gzip：压缩中不产字节。
    let merged = mergeTransferProgress(undefined, { transferred: 0, size: 1000, phase: "compressing" });
    expect(merged.staged).toBe(0);
    // fetching 按压缩流计（分母=压缩后体积）；乱序回退被钳制。
    merged = mergeTransferProgress(merged, { transferred: 100, size: 400, phase: "fetching" });
    expect(merged).toEqual({ transferred: 100, staged: 0, size: 400, phase: "fetching" });
    merged = mergeTransferProgress(merged, { transferred: 60, size: 400, phase: "fetching" });
    expect(merged.transferred).toBe(100);
    // decompressing 换计数器（分母=原始体积）；ready 保持计数不清零。
    merged = mergeTransferProgress(merged, { transferred: 10, size: 1000, phase: "decompressing" });
    expect(merged.transferred).toBe(10);
    merged = mergeTransferProgress(merged, { transferred: 0, size: 1000, phase: "ready" });
    expect(merged.phase).toBe("ready");
    // transferring 从 0 重新计（本地 staging 分块供给，分母=原始体积）。
    merged = mergeTransferProgress(merged, { transferred: 0, size: 1000, phase: "transferring" });
    expect(merged.transferred).toBe(0);
    merged = mergeTransferProgress(merged, { transferred: 50, size: 1000, phase: "transferring" });
    expect(merged.transferred).toBe(50);
  });

  it("drops unknown compression phases instead of poisoning the phase marker", () => {
    expect(mergeTransferProgress(undefined, { transferred: 5, size: 1000, phase: "hologram" }).phase).toBeUndefined();
  });
});

describe("transferCancelReason", () => {
  it("maps known error codes to stable slugs", () => {
    expect(transferCancelReason({ code: "transfer-cancelled" })).toBe("user");
    expect(transferCancelReason({ code: "transfer-terminal" })).toBe("user");
    expect(transferCancelReason({ code: "upload-ack-timeout" })).toBe("ack-timeout");
    expect(transferCancelReason({ code: "upload-read-failed" })).toBe("local-read-error");
    expect(transferCancelReason({ code: "upload-append-failed" })).toBe("append-failed");
    expect(transferCancelReason({ code: "upload-start-failed" })).toBe("start-failed");
  });

  it("falls back to client-error for unknown causes", () => {
    expect(transferCancelReason(new Error("boom"))).toBe("client-error");
    expect(transferCancelReason(undefined)).toBe("client-error");
    expect(transferCancelReason({ code: 42 })).toBe("client-error");
  });
});
