/**
 * SFTP 路径书签：全局命名路径清单（不按连接分，上限 20 条，镜像 quick_commands 模式）。
 * 权威存储 pluginStore（宿主 ui-storage.json，随 DBX secrets 同步加密上云；
 * IMPL_PLAN_STORAGE_SYNC 批 1）：sidecar `sftp/bookmarks/list` 仅作一次性迁移
 * 种子，本模块提供类型、校验、权威清单存取与 upsert/remove 纯函数；可单测。
 */

import { pluginStore } from "./pluginStore";
import { randomUUID } from "./uuid";

export interface SftpBookmark {
  id: string;
  label: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface SftpBookmarkInput {
  label: string;
  path: string;
}

export const SFTP_BOOKMARKS_LIMIT = 20;
export const SFTP_BOOKMARK_LABEL_MAX_LENGTH = 64;
export const SFTP_BOOKMARK_PATH_MAX_LENGTH = 1024;

/** 校验错误码（后端同规则）：App.vue 按 `sftpBookmark.error.<code>` 映射七语文案。 */
export type SftpBookmarkErrorCode =
  | "labelEmpty"
  | "labelTooLong"
  | "pathEmpty"
  | "pathTooLong"
  | "limitReached"
  | "labelDuplicate";

function nonEmptyTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 前端先行校验（新建语义，与后端同规则）：
 * label 1–64 非空且大小写不敏感唯一、path 非空 ≤1024、新建不超上限。
 * 返回 null 表示通过；错误码按检查顺序返回首个失败项。
 */
export function validateBookmarkInput(
  input: SftpBookmarkInput,
  existing: readonly SftpBookmark[] = [],
  limit = SFTP_BOOKMARKS_LIMIT,
): SftpBookmarkErrorCode | null {
  const label = nonEmptyTrimmed(input?.label);
  if (!label) return "labelEmpty";
  if (label.length > SFTP_BOOKMARK_LABEL_MAX_LENGTH) return "labelTooLong";
  const path = nonEmptyTrimmed(input?.path);
  if (!path) return "pathEmpty";
  if (path.length > SFTP_BOOKMARK_PATH_MAX_LENGTH) return "pathTooLong";
  if (existing.length >= limit) return "limitReached";
  const lowered = label.toLowerCase();
  if (existing.some((bookmark) => bookmark.label.toLowerCase() === lowered)) return "labelDuplicate";
  return null;
}

/** label 默认值：路径末段（根路径与空路径回退 "/"）。 */
export function defaultBookmarkLabel(path: string): string {
  const segments = path.trim().split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "/";
  return last.slice(0, SFTP_BOOKMARK_LABEL_MAX_LENGTH);
}

/** 按 label 排序（后端已排，前端合并/兜底时保持同序）：不区分大小写 + 数字自然序。 */
export function sortBookmarksByLabel(bookmarks: readonly SftpBookmark[]): SftpBookmark[] {
  return [...bookmarks].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function bookmarkRowsFromPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).bookmarks)) {
    return (raw as { bookmarks: unknown[] }).bookmarks;
  }
  return [];
}

/** 收敛 sftp/bookmarks 响应：非对象包络回退空表；缺 id/label/path 的行丢弃，数值字段兜底 0。 */
export function sanitizeSftpBookmarks(raw: unknown): SftpBookmark[] {
  const out: SftpBookmark[] = [];
  for (const row of bookmarkRowsFromPayload(raw)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = nonEmptyTrimmed(record.id);
    const label = typeof record.label === "string" ? record.label : "";
    const path = typeof record.path === "string" ? record.path : "";
    if (!id || !label || !path) continue;
    out.push({
      id,
      label,
      path,
      createdAt: Number(record.createdAt ?? 0) || 0,
      updatedAt: Number(record.updatedAt ?? 0) || 0,
    });
  }
  return out;
}

/** pluginStore 权威键（IMPL_PLAN_STORAGE_SYNC 批 1）。 */
export const SFTP_BOOKMARKS_STORE_KEY = "ssh-sftp-bookmarks";

/**
 * 从 pluginStore 读权威清单；返回 null 表示键尚不存在（未迁移，调用方应走
 * sidecar 种子搬迁）。存在但为空数组是合法用户态（已清空），不触发搬迁。
 */
export function loadSftpBookmarksFromStore(): SftpBookmark[] | null {
  try {
    const raw = pluginStore.getItem(SFTP_BOOKMARKS_STORE_KEY);
    if (raw === null) return null;
    return sortBookmarksByLabel(sanitizeSftpBookmarks(JSON.parse(raw)));
  } catch {
    // 坏 JSON 视为空清单：不回退种子（键已存在 = 已迁移，避免复活旧数据）。
    return [];
  }
}

/** 全量写穿 pluginStore（空数组同样落键，标记"已迁移"）；落盘前按 label 排序。 */
export function persistSftpBookmarks(list: readonly SftpBookmark[]): SftpBookmark[] {
  const normalized = sortBookmarksByLabel(sanitizeSftpBookmarks(list));
  try {
    pluginStore.setItem(SFTP_BOOKMARKS_STORE_KEY, JSON.stringify(normalized));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
  return normalized;
}

/**
 * 新建或按 id 更新：新建生成 id/时间戳并追加；更新保留原 createdAt、刷新
 * updatedAt。label 重复/超限由调用方 validateBookmarkInput 前置拦截（与后端
 * 同规则）；落盘形态与后端一致（按 label 排序、≤20 条）。
 */
export function upsertBookmark(
  list: readonly SftpBookmark[],
  input: SftpBookmarkInput & { id?: string },
  now = Date.now(),
): { bookmarks: SftpBookmark[]; bookmark: SftpBookmark } {
  const label = nonEmptyTrimmed(input?.label);
  const path = nonEmptyTrimmed(input?.path);
  const existing = input?.id ? list.find((bookmark) => bookmark.id === input.id) : undefined;
  const bookmark: SftpBookmark = existing
    ? { ...existing, label, path, updatedAt: now }
    : { id: randomUUID(), label, path, createdAt: now, updatedAt: now };
  const next = sortBookmarksByLabel([...list.filter((item) => item.id !== bookmark.id), bookmark]).slice(
    0,
    SFTP_BOOKMARKS_LIMIT,
  );
  return { bookmarks: next, bookmark };
}

/** 按 id 移除；id 不存在时返回等价副本。 */
export function removeBookmark(list: readonly SftpBookmark[], id: string): SftpBookmark[] {
  return list.filter((bookmark) => bookmark.id !== id);
}

export async function listBookmarks(): Promise<SftpBookmark[]> {
  const result = await window.dbxPlugin.invoke<unknown>("sftp/bookmarks/list");
  return sanitizeSftpBookmarks(result);
}
