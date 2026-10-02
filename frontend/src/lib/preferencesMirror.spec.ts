// 工作台偏好镜像单测（存储迁移批 3）：wire 键名同形提取（部分载荷逐字段
// 回默认）、消毒器边界（原 App.vue 内联逻辑下沉后的回归）、round-trip、
// 坏档自愈、收敛等值。pluginStore 走 node 内存档；顺序依赖：首个"未播种"
// 断言在首个写入之前。
import { describe, expect, it } from "vitest";
import { pluginStore } from "./pluginStore";
import {
  clampSuggestionMaxChars,
  clampSuggestionMinChars,
  extractPreferencesMirror,
  loadPreferencesMirror,
  PREFERENCES_MIRROR_STORE_KEY,
  persistPreferencesMirror,
  preferencesMirrorEquals,
  sanitizeConflictPolicy,
  sanitizeTransferCompressMode,
  sanitizeTransferCompressThresholdMib,
} from "./preferencesMirror";

describe("preference sanitizers (原 App.vue 内联逻辑的回归)", () => {
  it("conflict policy whitelist falls back to rename", () => {
    expect(sanitizeConflictPolicy("ask")).toBe("ask");
    expect(sanitizeConflictPolicy("overwrite")).toBe("overwrite");
    expect(sanitizeConflictPolicy("nope")).toBe("rename");
  });

  it("compress threshold clamps 0..=65536 with default 64", () => {
    expect(sanitizeTransferCompressThresholdMib(undefined)).toBe(64);
    expect(sanitizeTransferCompressThresholdMib(-5)).toBe(0);
    expect(sanitizeTransferCompressThresholdMib(1 << 20)).toBe(65536);
    expect(sanitizeTransferCompressThresholdMib(128.7)).toBe(128);
  });

  it("compress mode whitelist falls back to auto", () => {
    expect(sanitizeTransferCompressMode("on")).toBe("on");
    expect(sanitizeTransferCompressMode(1)).toBe("auto");
  });

  it("suggestion bounds: min 1..=16 (default 2), max 8..=512 (default 64)", () => {
    expect(clampSuggestionMinChars(undefined)).toBe(2);
    expect(clampSuggestionMinChars(0)).toBe(1);
    expect(clampSuggestionMinChars(99)).toBe(16);
    expect(clampSuggestionMaxChars(undefined)).toBe(64);
    expect(clampSuggestionMaxChars(1)).toBe(8);
    expect(clampSuggestionMaxChars(9999)).toBe(512);
  });
});

describe("extractPreferencesMirror", () => {
  it("builds a fully sanitized mirror from a partial get payload", () => {
    const mirror = extractPreferencesMirror({
      downloadDir: "  /tmp/dl  ",
      transfer_concurrency: 99,
      sftp_compat_mode: true,
      history_suggestion_min_chars: 0,
    });
    expect(mirror).toEqual({
      downloadDir: "/tmp/dl",
      downloadUseDefaultDir: true,
      downloadConflictPolicy: "rename",
      transfer_concurrency: 10,
      transfer_duplicate_policy: "rename",
      transfer_max_active: 3,
      transfer_download_limit_kib: 0,
      sftp_compat_mode: true,
      sftp_name_encoding: "auto",
      transfer_compress_mode: "auto",
      transfer_compress_threshold_mib: 64,
      history_suggestions_enabled: true,
      history_suggestion_min_chars: 1,
      history_suggestion_max_chars: 64,
    });
  });

  it("tolerates non-object payloads with all defaults", () => {
    expect(extractPreferencesMirror(null).downloadDir).toBe("");
    expect(extractPreferencesMirror("x").sftp_name_encoding).toBe("auto");
  });
});

describe("mirror store round-trip (存储迁移批 3)", () => {
  // 顺序依赖：本文件首个断言在首个 persist 之前（pluginStore 模块缓存同文件共享）。
  it("loadPreferencesMirror returns null while the key is absent (seed pending)", () => {
    expect(loadPreferencesMirror()).toBeNull();
  });

  it("persist then load round-trips; corrupt JSON self-heals to null (reseed from sidecar)", () => {
    const mirror = extractPreferencesMirror({ downloadDir: "/d", transfer_concurrency: 5, history_suggestions_enabled: false });
    persistPreferencesMirror(mirror);
    expect(loadPreferencesMirror()).toEqual(mirror);
    pluginStore.setItem(PREFERENCES_MIRROR_STORE_KEY, "{broken");
    expect(loadPreferencesMirror()).toBeNull();
  });
});

describe("preferencesMirrorEquals", () => {
  const base = extractPreferencesMirror({});

  it("is false on any field drift and true on identical sanitized views", () => {
    expect(preferencesMirrorEquals(base, extractPreferencesMirror({}))).toBe(true);
    expect(preferencesMirrorEquals(base, { ...base, transfer_concurrency: 7 })).toBe(false);
    expect(preferencesMirrorEquals(base, { ...base, downloadDir: "/other" })).toBe(false);
  });
});
