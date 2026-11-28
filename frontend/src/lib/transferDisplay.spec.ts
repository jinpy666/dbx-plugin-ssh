import { describe, expect, it } from "vitest";
import { transferBarValue, transferBytesTitle, transferPercent, transferShownBytes } from "./transferDisplay";
import type { TransferTask } from "./transferQueue";

function task(overrides: Partial<TransferTask>): TransferTask {
  return {
    taskId: "t1",
    sessionId: "s1",
    direction: "upload",
    fileName: "a.bin",
    size: 200,
    transferred: 50,
    status: "running",
    ...overrides,
  };
}

describe("transferPercent", () => {
  it("rounds the transferred share and caps at 100", () => {
    expect(transferPercent(task({}))).toBe(25);
    expect(transferPercent(task({ size: 300, transferred: 300 }))).toBe(100);
    expect(transferPercent(task({ size: 100, transferred: 500 }))).toBe(100);
  });

  it("treats a completed task without a size as done and others as zero", () => {
    expect(transferPercent(task({ size: 0, status: "completed" }))).toBe(100);
    expect(transferPercent(task({ size: 0, status: "running" }))).toBe(0);
  });
});

describe("transferBarValue", () => {
  it("returns undefined for local CPU/disk phases (indeterminate bar)", () => {
    for (const phase of ["staging", "compressing", "decompressing", "ready"] as const) {
      expect(transferBarValue(task({ phase }))).toBeUndefined();
    }
  });

  it("returns the real percent for network phases and phase-less tasks", () => {
    expect(transferBarValue(task({ phase: "uploading" }))).toBe(25);
    expect(transferBarValue(task({ phase: "transferring" }))).toBe(25);
    expect(transferBarValue(task({}))).toBe(25);
  });
});

describe("transferShownBytes", () => {
  it("shows staged bytes for local staging/compressing phases", () => {
    expect(transferShownBytes(task({ phase: "staging", staged: 120 }))).toBe(120);
    expect(transferShownBytes(task({ phase: "compressing", staged: 80 }))).toBe(80);
    expect(transferShownBytes(task({ phase: "staging" }))).toBe(0);
  });

  it("shows transferred bytes otherwise", () => {
    expect(transferShownBytes(task({ phase: "uploading", staged: 120 }))).toBe(50);
    expect(transferShownBytes(task({}))).toBe(50);
  });
});

describe("transferBytesTitle", () => {
  it("formats exact byte counts for the tooltip", () => {
    expect(transferBytesTitle(task({ size: 2048, transferred: 1024 }))).toBe("1,024 / 2,048 bytes");
    expect(transferBytesTitle(task({ size: 0 }))).toBeUndefined();
  });
});
