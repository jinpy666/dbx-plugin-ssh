export interface SftpFilterableEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export type SftpTypeFilter = "all" | "directory" | "file";

/**
 * Front-end filtering of the currently listed directory: search text
 * (case-insensitive substring on the entry name) plus an entry type filter.
 */
export function filterSftpEntries<T extends SftpFilterableEntry>(
  entries: readonly T[],
  search: string,
  type: SftpTypeFilter,
): T[] {
  const query = search.trim().toLowerCase();
  return entries.filter((entry) => {
    if (type === "directory" && entry.kind !== "directory") return false;
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
