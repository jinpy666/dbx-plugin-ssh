// 连接级镜像助手单测（存储迁移批 2）：条目级存在性语义——null = 该连接未
// 迁移（整键缺失/坏档/无该条目），条目存在即使内容是垃圾也经 sanitizer 收紧
// 后返回（不回退种子，防清空复活）；读改写保留其他连接条目。
// pluginStore 走 node 内存档；顺序依赖：首个"未迁移"断言在首个写入之前。
import { describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import { connectionEntryEquals, loadConnectionEntry, saveConnectionEntry } from "./connectionSettingMirror";

const KEY = "test-conn-mirror";
const sanitizeString = (raw: unknown): string => (typeof raw === "string" ? raw : "");

describe("loadConnectionEntry", () => {
  it("returns null while the key is absent (seed pending)", () => {
    expect(loadConnectionEntry(KEY, "conn-a", sanitizeString)).toBeNull();
  });

  it("returns the sanitized entry once present, garbage tightens to the domain default", () => {
    saveConnectionEntry(KEY, "conn-a", "auto");
    expect(loadConnectionEntry(KEY, "conn-a", sanitizeString)).toBe("auto");
    saveConnectionEntry(KEY, "conn-b", { broken: true });
    // 条目存在即"已迁移"：垃圾收紧为默认值，不回退种子。
    expect(loadConnectionEntry(KEY, "conn-b", sanitizeString)).toBe("");
  });

  it("returns null for a connection that has no entry yet (per-entry migration)", () => {
    expect(loadConnectionEntry(KEY, "conn-missing", sanitizeString)).toBeNull();
  });

  it("treats a corrupt whole key as unseeded", () => {
    pluginStore.setItem(KEY, "{not-json");
    expect(loadConnectionEntry(KEY, "conn-a", sanitizeString)).toBeNull();
    // 下一次保存以当前条目重建整键（坏档自愈）。
    saveConnectionEntry(KEY, "conn-c", "ok");
    expect(loadConnectionEntry(KEY, "conn-c", sanitizeString)).toBe("ok");
  });

  it("ignores empty connection ids", () => {
    expect(loadConnectionEntry(KEY, "", sanitizeString)).toBeNull();
    saveConnectionEntry(KEY, "", "x");
    expect(loadConnectionEntry(KEY, "", sanitizeString)).toBeNull();
  });
});

describe("saveConnectionEntry", () => {
  it("read-modify-write preserves other connections' entries and overwrites the target", () => {
    saveConnectionEntry(KEY, "keep-1", { v: 1 });
    saveConnectionEntry(KEY, "keep-2", { v: 2 });
    saveConnectionEntry(KEY, "keep-1", { v: 11 });
    expect(loadConnectionEntry(KEY, "keep-1", (raw) => raw)).toEqual({ v: 11 });
    expect(loadConnectionEntry(KEY, "keep-2", (raw) => raw)).toEqual({ v: 2 });
  });

  it("over a corrupt key rebuilds it from the current entry", () => {
    pluginStore.setItem(KEY, "[not-an-object");
    saveConnectionEntry(KEY, "fresh", "v");
    expect(loadConnectionEntry(KEY, "fresh", sanitizeString)).toBe("v");
  });
});

describe("connectionEntryEquals", () => {
  it("compares canonical JSON (strict on array order, the injection order for startup commands)", () => {
    expect(connectionEntryEquals({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(connectionEntryEquals({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(connectionEntryEquals("auto", "auto")).toBe(true);
    expect(connectionEntryEquals(null, null)).toBe(true);
  });
});
