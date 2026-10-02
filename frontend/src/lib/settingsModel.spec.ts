// MCP 设置镜像单测（存储迁移批 1 收尾）：persisted 优先于 effective（环境变
// 量覆盖不得被回推）、get 载荷提取容错、store 播种/坏档自愈、集合等值比较
// （connectionScope 顺序不稳定不触发收敛）。pluginStore 走 node 内存档。
import { describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  extractMcpSettingsMirror,
  loadMcpSettingsMirror,
  mcpSettingsMirrorEquals,
  MCP_SETTINGS_STORE_KEY,
  persistMcpSettingsMirror,
} from "./settingsModel";

describe("extractMcpSettingsMirror", () => {
  it("prefers persisted permission fields over effective values (env override must not round-trip)", () => {
    const mirror = extractMcpSettingsMirror({
      maxReadBytes: 8 * 1024 * 1024,
      maxUploadBytes: 1024,
      maxDownloadBytes: 2048,
      localTransferRoot: "/device/local", // 设备本地路径：不进镜像
      execPermissionMode: "autonomous", // 生效值（env 覆盖）
      connectionScope: ["prod-*"],
      persistedExecPermissionMode: "confirm",
      persistedConnectionScope: ["prod-a", "prod-b"],
    });
    expect(mirror).toEqual({
      maxReadBytes: 8 * 1024 * 1024,
      maxUploadBytes: 1024,
      maxDownloadBytes: 2048,
      execPermissionMode: "confirm",
      connectionScope: ["prod-a", "prod-b"],
    });
  });

  it("falls back to effective values on old sidecars without persisted fields", () => {
    const mirror = extractMcpSettingsMirror({ execPermissionMode: "confirm", connectionScope: ["x"] });
    expect(mirror.execPermissionMode).toBe("confirm");
    expect(mirror.connectionScope).toEqual(["x"]);
  });

  it("defaults missing size fields to sidecar defaults and sanitizes scope entries", () => {
    const mirror = extractMcpSettingsMirror({ connectionScope: ["  ", "ok", 42, null] });
    expect(mirror.maxReadBytes).toBe(256 * 1024);
    expect(mirror.maxUploadBytes).toBe(16 * 1024 * 1024);
    expect(mirror.maxDownloadBytes).toBe(1024 * 1024);
    expect(mirror.execPermissionMode).toBe("autonomous");
    expect(mirror.connectionScope).toEqual(["ok"]);
  });

  it("tolerates non-object payloads", () => {
    expect(extractMcpSettingsMirror(null).connectionScope).toEqual([]);
    expect(extractMcpSettingsMirror("garbage").execPermissionMode).toBe("autonomous");
  });
});

describe("mirror store round-trip (存储迁移批 1)", () => {
  // 顺序依赖：本文件首个断言在首个 persist 之前（pluginStore 模块缓存同文件共享）。
  it("loadMcpSettingsMirror returns null while the key is absent (seed pending)", () => {
    expect(loadMcpSettingsMirror()).toBeNull();
  });

  it("persist then load round-trips; corrupt JSON self-heals to null (reseed from sidecar)", () => {
    persistMcpSettingsMirror({
      maxReadBytes: 1024,
      maxUploadBytes: 2048,
      maxDownloadBytes: 4096,
      execPermissionMode: "confirm",
      connectionScope: ["a"],
    });
    expect(loadMcpSettingsMirror()).toEqual({
      maxReadBytes: 1024,
      maxUploadBytes: 2048,
      maxDownloadBytes: 4096,
      execPermissionMode: "confirm",
      connectionScope: ["a"],
    });
    pluginStore.setItem(MCP_SETTINGS_STORE_KEY, "{broken");
    // 与批 1 权威数据不同：镜像是派生载荷，坏档回落 null 触发下次播种自愈。
    expect(loadMcpSettingsMirror()).toBeNull();
  });
});

describe("mcpSettingsMirrorEquals", () => {
  const base = { maxReadBytes: 1, maxUploadBytes: 2, maxDownloadBytes: 3, execPermissionMode: "confirm", connectionScope: ["b", "a"] };

  it("compares connectionScope as a set (order drift must not trigger convergence)", () => {
    expect(mcpSettingsMirrorEquals(base, { ...base, connectionScope: ["a", "b"] })).toBe(true);
  });

  it("is strict on numbers and permission mode", () => {
    expect(mcpSettingsMirrorEquals(base, { ...base, maxReadBytes: 9 })).toBe(false);
    expect(mcpSettingsMirrorEquals(base, { ...base, execPermissionMode: "autonomous" })).toBe(false);
    expect(mcpSettingsMirrorEquals(base, { ...base, connectionScope: ["a"] })).toBe(false);
    expect(mcpSettingsMirrorEquals(base, { ...base })).toBe(true);
  });
});
