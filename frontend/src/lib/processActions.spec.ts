import { describe, expect, it } from "vitest";
import { canKillProcess, sortProcessRows } from "./processActions";

describe("process management helpers", () => {
  const rows = [
    { pid: 30, cpuPercent: 1.0, memPercent: 9.0 },
    { pid: 10, cpuPercent: 50.0, memPercent: 2.0 },
    { pid: 20, cpuPercent: 5.0, memPercent: 9.0 },
  ];

  it("sorts by cpu, memory (desc) and pid (asc)", () => {
    expect(sortProcessRows(rows, "cpu").map((row) => row.pid)).toEqual([10, 20, 30]);
    expect(sortProcessRows(rows, "mem").map((row) => row.pid)).toEqual([20, 30, 10]);
    expect(sortProcessRows(rows, "pid").map((row) => row.pid)).toEqual([10, 20, 30]);
  });

  it("does not mutate the input order", () => {
    sortProcessRows(rows, "pid");
    expect(rows.map((row) => row.pid)).toEqual([30, 10, 20]);
  });

  it("refuses killing init, pid 0 and non-integers", () => {
    expect(canKillProcess(1)).toBe(false);
    expect(canKillProcess(0)).toBe(false);
    expect(canKillProcess(-5)).toBe(false);
    expect(canKillProcess(1.5)).toBe(false);
    expect(canKillProcess(Number.NaN)).toBe(false);
    expect(canKillProcess(1234)).toBe(true);
  });

  it("sorts by fd count and listening-port count with unknowns last", () => {
    const extras = [
      { pid: 30, cpuPercent: 1.0, memPercent: 1.0, fdCount: 64, listenPorts: [80, 443] },
      { pid: 10, cpuPercent: 1.0, memPercent: 1.0, fdCount: null, listenPorts: [] },
      { pid: 20, cpuPercent: 1.0, memPercent: 1.0, fdCount: 12, listenPorts: [8080] },
    ];
    expect(sortProcessRows(extras, "fd").map((row) => row.pid)).toEqual([30, 20, 10]);
    expect(sortProcessRows(extras, "ports").map((row) => row.pid)).toEqual([30, 20, 10]);
    // 行缺字段（旧 sidecar）同样视为未知、垫底；两个未知行按 pid 升序决胜。
    const legacy = [{ pid: 5, cpuPercent: 1.0, memPercent: 1.0 }];
    expect(sortProcessRows([...extras, ...legacy], "fd").map((row) => row.pid)).toEqual([30, 20, 5, 10]);
  });
});
