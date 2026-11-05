import { describe, expect, it } from "vitest";
import { formatHistoryDuration, formatHistoryStartedAt, normalizeTransferStatus, sanitizeTransferHistoryTasks, TRANSFER_HISTORY_LIMIT } from "./transferHistory";

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

// issue #269：历史卡片显示传输时间。格式化必须与时区无关——期望值用本地
// Date 分量构造，不在断言里写死 UTC 偏移。
describe("formatHistoryStartedAt (#269)", () => {
  it("按本地 YYYY-MM-DD HH:mm 格式化 startedAt", () => {
    const ts = new Date(2026, 10, 4, 14, 30).getTime();
    expect(formatHistoryStartedAt(ts)).toBe("2026-11-04 14:30");
  });

  it("缺失/非法时间戳返回空串（卡片隐藏时间段）", () => {
    expect(formatHistoryStartedAt(undefined)).toBe("");
    expect(formatHistoryStartedAt(0)).toBe("");
    expect(formatHistoryStartedAt(Number.NaN)).toBe("");
  });
});

describe("formatHistoryDuration (#269)", () => {
  it("耗时格式化为分:秒，跨小时带小时段", () => {
    const start = new Date(2026, 10, 4, 10, 0, 0).getTime();
    expect(formatHistoryDuration(start, start + 65_000)).toBe("1:05");
    expect(formatHistoryDuration(start, start + 3_661_000)).toBe("1:01:01");
  });

  it("不足一秒显示 <1s", () => {
    const start = new Date(2026, 10, 4, 10, 0, 0).getTime();
    expect(formatHistoryDuration(start, start + 400)).toBe("<1s");
  });

  it("缺起点/终点或终点早于起点返回空串", () => {
    const start = new Date(2026, 10, 4, 10, 0, 0).getTime();
    expect(formatHistoryDuration(undefined, start)).toBe("");
    expect(formatHistoryDuration(start, undefined)).toBe("");
    expect(formatHistoryDuration(start + 1_000, start)).toBe("");
  });
});
