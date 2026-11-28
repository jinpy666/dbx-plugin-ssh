import { describe, expect, it } from "vitest";
import { matchesMonitorQuery, monitorQueryTokens, searchMonitorRows } from "./monitorSearch";

const rows = [
  { id: "c1", name: "Production DB", dbType: "mysql", groupName: "prod" },
  { id: "c2", name: "staging-db-01", dbType: "postgres", groupName: "stage" },
  { id: "c3", name: "производство", dbType: "redis", groupName: "" },
];

describe("monitorQueryTokens", () => {
  it("lowercases and splits on whitespace", () => {
    expect(monitorQueryTokens("  Prod   DB ")).toEqual(["prod", "db"]);
    expect(monitorQueryTokens("")).toEqual([]);
  });
});

describe("matchesMonitorQuery", () => {
  it("matches everything for an empty query", () => {
    expect(matchesMonitorQuery(rows[0]!, "")).toBe(true);
    expect(matchesMonitorQuery(rows[0]!, "   ")).toBe(true);
  });

  it("matches name/dbType/groupName substrings case-insensitively", () => {
    expect(matchesMonitorQuery(rows[0]!, "prod")).toBe(true);
    expect(matchesMonitorQuery(rows[0]!, "MYSQL")).toBe(true);
    expect(matchesMonitorQuery(rows[0]!, "prod")).toBe(true);
    expect(matchesMonitorQuery(rows[1]!, "stage")).toBe(true);
  });

  it("requires every whitespace token to match (AND)", () => {
    expect(matchesMonitorQuery(rows[1]!, "staging db")).toBe(true);
    expect(matchesMonitorQuery(rows[1]!, "staging redis")).toBe(false);
  });

  it("falls back to subsequence fuzzy on name and id", () => {
    expect(matchesMonitorQuery(rows[1]!, "sgdb")).toBe(true); // s→g→d→b 子序列
    expect(matchesMonitorQuery(rows[1]!, "c2")).toBe(true);
    expect(matchesMonitorQuery(rows[1]!, "zzz")).toBe(false);
  });

  it("matches non-ASCII names as plain substrings", () => {
    expect(matchesMonitorQuery(rows[2]!, "извод")).toBe(true);
  });
});

describe("searchMonitorRows", () => {
  it("returns a copy for an empty query and preserves order otherwise", () => {
    const all = searchMonitorRows(rows, "");
    expect(all).toEqual(rows);
    expect(all).not.toBe(rows);
    expect(searchMonitorRows(rows, "db").map((row) => row.id)).toEqual(["c1", "c2"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchMonitorRows(rows, "nope")).toEqual([]);
  });
});
