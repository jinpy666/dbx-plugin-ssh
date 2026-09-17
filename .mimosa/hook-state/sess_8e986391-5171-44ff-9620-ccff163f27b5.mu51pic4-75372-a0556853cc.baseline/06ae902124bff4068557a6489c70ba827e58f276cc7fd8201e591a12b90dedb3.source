import { describe, expect, it } from "vitest";
import {
  canResumeUpload,
  matchResumableUpload,
  resumeChunkOffsets,
  transferPausable,
  type ResumableUploadTask,
} from "./transferResume";

function task(overrides: Partial<ResumableUploadTask> = {}): ResumableUploadTask {
  return {
    taskId: "t1",
    remotePath: "/srv/a.bin",
    fileName: "a.bin",
    size: 100,
    resumableBytes: 40,
    ...overrides,
  };
}

describe("transfer pause/resume decisions", () => {
  it("pauses only live transfers", () => {
    expect(transferPausable("queued")).toBe(true);
    expect(transferPausable("running")).toBe(true);
    expect(transferPausable("completed")).toBe(false);
    expect(transferPausable("cancelled")).toBe(false);
    expect(transferPausable("failed")).toBe(false);
  });

  it("requires a partial prefix for resume", () => {
    expect(canResumeUpload(task())).toBe(true);
    expect(canResumeUpload(task({ resumableBytes: 0 }))).toBe(false);
    expect(canResumeUpload(task({ resumableBytes: 100 }))).toBe(false);
    expect(canResumeUpload(task({ resumableBytes: 120 }))).toBe(false);
    expect(canResumeUpload(task({ resumableBytes: Number.NaN }))).toBe(false);
  });

  it("matches the local file by name and size", () => {
    const files = [
      { name: "b.bin", size: 100 },
      { name: "a.bin", size: 100 },
    ];
    expect(matchResumableUpload(task(), files)).toEqual({ name: "a.bin", size: 100 });
    expect(matchResumableUpload(task(), [{ name: "a.bin", size: 99 }])).toBeNull();
    expect(matchResumableUpload(task({ size: 100, resumableBytes: 100 }), files)).toBeNull();
  });

  it("plans resume chunks from the spooled offset", () => {
    expect(resumeChunkOffsets(100, 40, 30)).toEqual([40, 70]);
    expect(resumeChunkOffsets(100, 100, 30)).toEqual([]);
    expect(resumeChunkOffsets(100, 120, 30)).toEqual([]);
    expect(resumeChunkOffsets(100, 0, 40)).toEqual([0, 40, 80]);
    expect(resumeChunkOffsets(100, 40, 0)).toEqual([]);
  });
});
