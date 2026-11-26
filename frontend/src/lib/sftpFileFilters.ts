import { sftpEntryIsDirectoryLike, type SftpEntryTargetKind } from "./sftpEntries";

export interface SftpFilterableEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  /** issue #330：symlink 目标类型（目录链接归入"文件夹"筛选）。 */
  targetKind?: SftpEntryTargetKind;
}

export type SftpTypeFilter = "all" | "directory" | "file";

/** 判定某个条目是否是默认应该隐藏的"系统/缓存/隐藏"文件。
 *
 * 规则（对标 Nautilus / VS Code / JetBrains 的默认隐藏策略）：
 *   - 名称以 "." 开头 —— Unix 隐藏文件（.ssh、.config、.cache …）；
 *   - 名称完全是 __pycache__、.DS_Store、Thumbs.db —— 语言/平台缓存；
 *   - 名称以 ".pyc"、".pyo" 结尾 —— Python 字节码文件。
 *   - ".." 和 "." 永远不会进入这里（SFTP 协议不返回它们），无需单独处理。
 */
const ALWAYS_HIDDEN_NAMES = new Set([
  "__pycache__",
  ".DS_Store",
  "Thumbs.db",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".SystemVolumeInformation",
]);

export function isHiddenEntry(name: string): boolean {
  if (!name) return false;
  if (name.startsWith(".")) return true;
  if (ALWAYS_HIDDEN_NAMES.has(name)) return true;
  if (name.endsWith(".pyc") || name.endsWith(".pyo")) return true;
  return false;
}

/**
 * Front-end filtering of the currently listed directory: search text
 * (case-insensitive substring on the entry name) plus an entry type filter,
 * plus an optional hidden-file filter (hides dot-files and common system/
 * cache entries unless the caller opts in via `showHidden`).
 */
export function filterSftpEntries<T extends SftpFilterableEntry>(
  entries: readonly T[],
  search: string,
  type: SftpTypeFilter,
  showHidden = false,
): T[] {
  const query = search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!showHidden && isHiddenEntry(entry.name)) return false;
    if (type === "directory" && !sftpEntryIsDirectoryLike(entry.kind, entry.targetKind)) return false;
    if (type === "file" && entry.kind !== "file") return false;
    if (query && !entry.name.toLowerCase().includes(query)) return false;
    return true;
  });
}

/**
 * Shift-click range selection: keeps the current selection and adds every row
 * between the anchor row and the clicked row in the visible list order.
 */
export function expandSelection(
  current: readonly string[],
  anchorUri: string,
  targetUri: string,
  orderedUris: readonly string[],
): string[] {
  const anchorIndex = orderedUris.indexOf(anchorUri);
  const targetIndex = orderedUris.indexOf(targetUri);
  if (anchorIndex < 0 || targetIndex < 0) return [...current];
  const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  const range = orderedUris.slice(from, to + 1);
  return Array.from(new Set([...current, ...range]));
}
