/**
 * SFTP 路径书签：全局命名路径清单（不按连接分，上限 20 条，镜像 quick_commands 模式）。
 * 后端存储 sftp-bookmarks.json，前端经 sftp/bookmarks/list|save|delete 三方法读写。
 * 本模块提供类型、前端先行校验、响应收敛与 RPC 封装；纯函数可单测，invoke 走 window.dbxPlugin。
 */

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

export interface SftpBookmarkSaveResult {
  bookmark: SftpBookmark;
  created: boolean;
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

export async function listBookmarks(): Promise<SftpBookmark[]> {
  const result = await window.dbxPlugin.invoke<unknown>("sftp/bookmarks/list");
  return sanitizeSftpBookmarks(result);
}

export async function saveBookmark(input: SftpBookmarkInput): Promise<SftpBookmarkSaveResult> {
  const result = await window.dbxPlugin.invoke<{ bookmark?: unknown; created?: unknown }>("sftp/bookmarks/save", {
    label: nonEmptyTrimmed(input?.label),
    path: nonEmptyTrimmed(input?.path),
  });
  const [bookmark] = sanitizeSftpBookmarks({ bookmarks: [result?.bookmark] });
  if (!bookmark) throw new Error("sftp/bookmarks/save returned an invalid bookmark");
  return { bookmark, created: result?.created === true };
}

export async function deleteBookmark(id: string): Promise<{ success: boolean; removed: boolean }> {
  const result = await window.dbxPlugin.invoke<{ success?: unknown; removed?: unknown }>("sftp/bookmarks/delete", { id });
  return { success: result?.success !== false, removed: result?.removed === true };
}
