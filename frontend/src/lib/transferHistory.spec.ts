import { describe, expect, it } from "vitest";
import { normalizeTransferStatus, sanitizeTransferHistoryTasks, TRANSFER_HISTORY_LIMIT } from "./transferHistory";

describe("normalizeTransferStatus", () => {
  it("保留已知枚举", () => {
    expect(normalizeTransferStatus("queued")).toBe("queued");
    expect(normalizeTransferStatus("completed")).toBe("completed");
  });

  it("未知值回落 fallback", () => {
    expect(normalizeTransferStatus("bogus", "failed")).toBe("failed");
    expect(normalizeTransferStatus(42, "running")).toBe("running");
  });
});

describe("sanitizeTransferHistoryTasks", () => {
  it("丢弃非数组与非对象行、缺 taskId 的行", () => {
    expect(sanitizeTransferHistoryTasks(undefined)).toEqual([]);
    expect(sanitizeTransferHistoryTasks({})).toEqual([]);
    expect(sanitizeTransferHistoryTasks([null, "x", { fileName: "a" }])).toEqual([]);
  });

  it("direction/status 收敛到已知枚举，queued 按 running 展示", () => {
    const out = sanitizeTransferHistoryTasks([
      { taskId: "t1", direction: "download", status: "completed", size: "12", transferred: 3 },
      { taskId: "t2", status: "queued" },
      { taskId: "t3", direction: "sideways", status: "weird" },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ taskId: "t1", direction: "download", status: "completed", size: 12, transferred: 3 });
    expect(out[1]).toMatchObject({ taskId: "t2", direction: "upload", status: "running" });
    expect(out[2]).toMatchObject({ taskId: "t3", direction: "upload", status: "completed" });
  });

  it("数值字段容错：非数值按 0 处理", () => {
    const out = sanitizeTransferHistoryTasks([{ taskId: "t1", size: "abc", transferred: null }]);
    expect(out[0].size).toBe(0);
    expect(out[0].transferred).toBe(0);
  });

  it("查询上限为面板一次取数条数", () => {
    expect(TRANSFER_HISTORY_LIMIT).toBe(50);
  });
});
