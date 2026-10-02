// AI 设置存取单测（Warp AI 对齐批）：默认口径（# 搜索默认关——2026-10-02
// 决策暂缓；assist 开；fix/agentMode 关；未授权）与逐字段容错回退。
import { afterEach, describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import { AI_SETTINGS_STORE_KEY, AI_SETTINGS_DEFAULTS, loadAiSettings, sanitizeAiSettings } from "./aiSettings";

describe("sanitizeAiSettings", () => {
  it("缺省回默认：assist 开；search（# 暂缓）/fix/agentMode 关、未授权", () => {
    expect(sanitizeAiSettings(undefined)).toEqual(AI_SETTINGS_DEFAULTS);
    expect(sanitizeAiSettings({})).toEqual(AI_SETTINGS_DEFAULTS);
  });

  it("合法值逐字段保留，非法字段回退", () => {
    expect(sanitizeAiSettings({ search: true, fix: true, assist: false, agentMode: true, fixConsent: true })).toEqual({ search: true, fix: true, assist: false, agentMode: true, fixConsent: true });
    expect(sanitizeAiSettings({ search: "yes", fix: 1 })).toEqual(AI_SETTINGS_DEFAULTS);
    // fixConsent 只认显式 true（授权位不许模糊值）。
    expect(sanitizeAiSettings({ fixConsent: "yes" }).fixConsent).toBe(false);
  });
});

describe("loadAiSettings", () => {
  afterEach(() => {
    pluginStore.removeItem(AI_SETTINGS_STORE_KEY);
  });

  it("空档回默认；合法档逐字段读回", () => {
    expect(loadAiSettings()).toEqual(AI_SETTINGS_DEFAULTS);
    pluginStore.setItem(AI_SETTINGS_STORE_KEY, JSON.stringify({ fix: true, fixConsent: true }));
    const loaded = loadAiSettings();
    expect(loaded.fix).toBe(true);
    expect(loaded.fixConsent).toBe(true);
    expect(loaded.agentMode).toBe(false);
  });

  it("损坏 JSON 不抛、回默认", () => {
    pluginStore.setItem(AI_SETTINGS_STORE_KEY, "{broken");
    expect(loadAiSettings()).toEqual(AI_SETTINGS_DEFAULTS);
  });
});
