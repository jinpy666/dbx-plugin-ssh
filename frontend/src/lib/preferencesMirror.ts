/**
 * 工作台偏好镜像（存储迁移批 3，IMPL_PLAN_STORAGE_SYNC）：14 个传输/下载/
 * 历史建议偏好键合并成单个 pluginStore 键作云同步载荷。sidecar
 * `preferences.json` 仍是即时权威（传输/下载任务启动时现读现用），镜像走
 * 「保存双写 + 启动播种/收敛」，与 mcp-settings 镜像同模式。
 *
 * 镜像字段名与 `local/preferences/*` 的 wire 键**完全一致**（snake_case）：
 * get 载荷可直接提取为镜像、镜像可直接作为 set 的部分更新载荷，零键名转换。
 * `localShell` 等设备本地字段不进镜像。
 */

import { pluginStore } from "./pluginStore";
import { clampTransferConcurrency, clampTransferDownloadLimit, clampTransferMaxActive, sanitizeTransferDuplicatePolicy, type TransferDuplicatePolicy } from "./transferQueue";
import { sanitizeNameEncoding, type SftpNameEncoding } from "./sftpName";
import type { DownloadConflictPolicy } from "./downloadPrefs";

export type SftpCompressMode = "auto" | "on" | "off";

export const PREFERENCES_MIRROR_STORE_KEY = "ssh-preferences-mirror";

export interface PreferencesMirror {
  downloadDir: string;
  downloadUseDefaultDir: boolean;
  downloadConflictPolicy: DownloadConflictPolicy;
  transfer_concurrency: number;
  transfer_duplicate_policy: TransferDuplicatePolicy;
  transfer_max_active: number;
  transfer_download_limit_kib: number;
  sftp_compat_mode: boolean;
  sftp_name_encoding: SftpNameEncoding;
  transfer_compress_mode: SftpCompressMode;
  transfer_compress_threshold_mib: number;
  history_suggestions_enabled: boolean;
  history_suggestion_min_chars: number;
  history_suggestion_max_chars: number;
}

// ---- 消毒器（原 App.vue 内联，随镜像下沉为可单测的纯函数；与 sidecar 白名单同向）----

export function sanitizeConflictPolicy(value: unknown): DownloadConflictPolicy {
  return value === "ask" || value === "overwrite" ? value : "rename";
}

/** 压缩阈值 MiB 钳制（M33）：0..=65536，非法回落默认 64（与后端白名单同向）。 */
export function sanitizeTransferCompressThresholdMib(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 64;
  return Math.min(65536, Math.max(0, Math.floor(parsed)));
}

/** 压缩策略三态白名单（M33）：非法回落 auto（与后端 CompressPolicy 同向）。 */
export function sanitizeTransferCompressMode(value: unknown): SftpCompressMode {
  return value === "on" || value === "off" ? value : "auto";
}

/** 建议长度上下限钳制：min 1..=16（默认 2），max 8..=512（默认 64），且 max 不低于 min。 */
export function clampSuggestionMinChars(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(16, Math.max(1, Math.floor(parsed)));
}

export function clampSuggestionMaxChars(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 64;
  return Math.min(512, Math.max(8, Math.floor(parsed)));
}

// ---- 镜像存取 ----

/** 从 `local/preferences/get` 载荷（或任意部分对象）提取镜像：逐字段消毒、缺省回侧默认。 */
export function extractPreferencesMirror(payload: unknown): PreferencesMirror {
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return {
    downloadDir: typeof record.downloadDir === "string" ? record.downloadDir.trim() : "",
    downloadUseDefaultDir: record.downloadUseDefaultDir !== false,
    downloadConflictPolicy: sanitizeConflictPolicy(record.downloadConflictPolicy),
    transfer_concurrency: clampTransferConcurrency(record.transfer_concurrency),
    transfer_duplicate_policy: sanitizeTransferDuplicatePolicy(record.transfer_duplicate_policy),
    transfer_max_active: clampTransferMaxActive(record.transfer_max_active),
    transfer_download_limit_kib: clampTransferDownloadLimit(record.transfer_download_limit_kib),
    sftp_compat_mode: record.sftp_compat_mode === true,
    sftp_name_encoding: sanitizeNameEncoding(record.sftp_name_encoding),
    transfer_compress_mode: sanitizeTransferCompressMode(record.transfer_compress_mode),
    transfer_compress_threshold_mib: sanitizeTransferCompressThresholdMib(record.transfer_compress_threshold_mib),
    history_suggestions_enabled: record.history_suggestions_enabled !== false,
    history_suggestion_min_chars: clampSuggestionMinChars(record.history_suggestion_min_chars),
    history_suggestion_max_chars: clampSuggestionMaxChars(record.history_suggestion_max_chars),
  };
}

/**
 * 从 pluginStore 读镜像；null = 键不存在（未播种）或坏 JSON——镜像可从
 * sidecar 自愈重播种（与 mcp-settings 镜像同语义，与批 1 权威数据相反）。
 */
export function loadPreferencesMirror(): PreferencesMirror | null {
  try {
    const raw = pluginStore.getItem(PREFERENCES_MIRROR_STORE_KEY);
    if (raw === null) return null;
    return extractPreferencesMirror(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 全量写穿镜像（syncPrefs 双写与启动播种共用）。 */
export function persistPreferencesMirror(mirror: PreferencesMirror): void {
  try {
    pluginStore.setItem(PREFERENCES_MIRROR_STORE_KEY, JSON.stringify(extractPreferencesMirror(mirror)));
  } catch {
    // 持久化失败不阻断：镜像只是同步载荷，sidecar 文件仍是即时权威。
  }
}

/** 镜像等值（启动收敛判定）：消毒后规范 JSON 比较（键序固定）。 */
export function preferencesMirrorEquals(a: PreferencesMirror, b: PreferencesMirror): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
