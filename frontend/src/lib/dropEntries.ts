// 拖拽条目遍历（web/DOM 车道）：`dataTransfer.items` 经 `webkitGetAsEntry`
// 递归收集文件（含目录树内成员），产出带相对路径的清单——拖文件夹上传的前端
// 编排放这里，消费侧（useUploadChain）把结果喂给既有文件夹上传管线。零 UI /
// 零 sidecar 依赖，单测见 dropEntries.spec.ts。
//
// 两个硬约束：
// - `webkitGetAsEntry()` 必须在 drop 事件处理器同步调用（事件让出后
//   DataTransferItemList 即失效），所以收根（collectDropRootEntries）与遍历
//   （scanDroppedEntries）拆成同步/异步两步；
// - `webkitGetAsEntry` 是 Chromium 系扩展，缺失（旧内核/部分宿主）时
//   collectDropRootEntries 返回 null，调用方回退 `dataTransfer.files` 现状。

export interface DroppedFileEntry {
  file: File;
  /** 相对拖拽根的路径（`/` 分隔，含文件名本身）。 */
  relativePath: string;
}

export interface DroppedScan {
  entries: DroppedFileEntry[];
  /** 拖入内容中的目录数（>0 时调用方按文件夹批量语义处理）。 */
  directories: number;
}

// 遍历防呆上界（与后端树扫描同量级；超限停止收集，按已得内容继续）。
const MAX_FILES = 50_000;
const MAX_DEPTH = 64;

/** webkitGetAsEntry 产出的最小结构面（DOM FileSystemEntry 的测试替身口径）。 */
export interface DropRootEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  name: string;
  file?: (success: (file: File) => void, failure?: (error: unknown) => void) => void;
  createReader?: () => { readEntries: (success: (entries: DropRootEntry[]) => void, failure?: (error: unknown) => void) => void };
}

/** DataTransferItem 的最小结构面（只要 kind 与 webkitGetAsEntry）。 */
export interface DropEntryItem {
  kind: string;
  webkitGetAsEntry?: () => DropRootEntry | null;
}

/**
 * 事件处理器内同步收取拖拽根条目。返回 null = 环境无 webkitGetAsEntry
 * （调用方回退 files 车道）；空数组 = 有 API 但没有文件条目（纯文本/元素拖拽）。
 */
export function collectDropRootEntries(items: ArrayLike<DropEntryItem> | null | undefined): DropRootEntry[] | null {
  if (!items) return null;
  const roots: DropRootEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.kind !== "file") continue;
    const getEntry = item.webkitGetAsEntry;
    if (typeof getEntry !== "function") return null;
    const entry = getEntry.call(item);
    if (entry) roots.push(entry);
  }
  return roots;
}

/** 遍历拖拽根，产出文件清单（目录内成员的 relativePath 带完整相对路径）。 */
export async function scanDroppedEntries(roots: readonly DropRootEntry[]): Promise<DroppedScan> {
  const entries: DroppedFileEntry[] = [];
  let directories = 0;
  for (const root of roots) {
    if (root.isDirectory) directories += 1;
    await collectEntry(root, entries);
  }
  return { entries, directories };
}

/** 去掉 fullPath 的前导 `/` 得相对路径（Chromium 惯例：fullPath 以 / 开头）。 */
function relativePathOf(entry: DropRootEntry): string {
  return entry.fullPath.replace(/^\//, "");
}

async function collectEntry(entry: DropRootEntry, out: DroppedFileEntry[], depth = 0): Promise<void> {
  if (out.length >= MAX_FILES) return;
  if (entry.isFile) {
    const read = entry.file;
    if (typeof read !== "function") return;
    try {
      const file = await new Promise<File | null>((resolve) => {
        read.call(entry, (file) => resolve(file), () => resolve(null));
      });
      if (file) out.push({ file, relativePath: relativePathOf(entry) || entry.name });
    } catch {
      // 单个条目读失败不阻断整批（后续上传阶段各自兜底报错）。
    }
    return;
  }
  if (!entry.isDirectory || typeof entry.createReader !== "function") return;
  if (depth >= MAX_DEPTH) return;
  const reader = entry.createReader();
  // readEntries 每批最多返回 100 条，返回空数组才是目录结束。
  for (;;) {
    if (out.length >= MAX_FILES) return;
    const batch = await new Promise<DropRootEntry[]>((resolve) => {
      reader.readEntries((entries) => resolve(entries), () => resolve([]));
    });
    if (!batch.length) return;
    for (const child of batch) {
      await collectEntry(child, out, depth + 1);
    }
  }
}
