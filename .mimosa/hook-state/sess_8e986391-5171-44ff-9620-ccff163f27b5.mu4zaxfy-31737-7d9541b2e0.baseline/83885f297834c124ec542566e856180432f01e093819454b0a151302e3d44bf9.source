/**
 * Extract files from a native paste event without depending on a host-specific
 * clipboard API. Finder/Explorer pastes normally populate `files`; browsers
 * that only expose DataTransferItem entries are covered by the fallback.
 */
export interface ClipboardFileItemLike {
  kind?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardFileDataLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ClipboardFileItemLike> | null;
}

export function filesFromClipboard(data: ClipboardFileDataLike | null | undefined): File[] {
  const files = data?.files ? Array.from(data.files) : [];
  if (files.length) return files;
  if (!data?.items) return [];

  const pasted: File[] = [];
  for (let index = 0; index < data.items.length; index += 1) {
    const item = data.items[index];
    if (item?.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file) pasted.push(file);
  }
  return pasted;
}
