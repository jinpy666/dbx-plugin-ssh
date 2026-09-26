// 文件夹上传编排的纯函数层（issue #78）：`<input type="file" webkitdirectory>`
// 产出的 FileList（每个 File 带非标准的 `webkitRelativePath`）在这里整理成
// 上传计划——远端目录集（去重、按深度排序保证父目录先建）+ 逐文件相对路径。
// App.vue 只负责消费计划：逐目录 `sftp/createDirectory`（建过即跳过）、
// 逐文件走既有 `sftp/upload/*` 管线（冲突策略由既有 resolveUploadDuplicateName
// 承接）。进度聚合（目录 X/Y · 文件 N/M · 字节）也是纯函数，单测见
// folderUpload.spec.ts。零 UI / 零 sidecar 依赖。

export interface FolderUploadFile {
  /** 浏览器给出的文件名（最后一段）。 */
  name: string;
  /** 相对所选目录的路径，`/` 分隔（含文件名本身）；无相对路径时即 name。 */
  relativePath: string;
  size: number;
}

export interface FolderUploadPlan {
  /**
   * 需要确保存在的远端目录（相对所选根目录），深度升序——父目录排在子目录
   * 之前，按序逐个 createDirectory 即可；已去重。
   */
  directories: string[];
  /** 待上传文件（已跳过空路径段），relativePath 指向所选根目录内的目标。 */
  files: FolderUploadFile[];
  /** 总字节数（进度分母）。 */
  totalBytes: number;
}

export interface FolderUploadProgress {
  /** 已 ensure 的远端目录数（成功或已存在）。 */
  directoriesDone: number;
  directoriesTotal: number;
  /** 已完成（或跳过）的文件数。 */
  filesDone: number;
  filesTotal: number;
  /** 已完成文件的字节累计（不含失败项）。 */
  bytesDone: number;
  totalBytes: number;
  /** 当前在传文件的相对路径（面板进度行展示用）。 */
  currentFile: string;
}

/** 冲突降级（MVP）：ask 模式在文件夹批量下不逐个弹窗（可能上百次交互），
 * 统一按「跳过已存在文件」处理并在完成提示中说明计数。 */
export type FolderUploadConflictMode = "rename" | "ask" | "overwrite";

export function createFolderUploadProgress(plan: FolderUploadPlan): FolderUploadProgress {
  return {
    directoriesDone: 0,
    directoriesTotal: plan.directories.length,
    filesDone: 0,
    filesTotal: plan.files.length,
    bytesDone: 0,
    totalBytes: plan.totalBytes,
    currentFile: "",
  };
}

/** 返回新状态（纯）：目录推进一格。 */
export function advanceFolderUploadDirectories(state: FolderUploadProgress): FolderUploadProgress {
  return { ...state, directoriesDone: Math.min(state.directoriesDone + 1, state.directoriesTotal) };
}

/** 返回新状态（纯）：一个文件完成（字节计入）或跳过（字节不计）。 */
export function settleFolderUploadFile(state: FolderUploadProgress, update: { file: FolderUploadFile; ok: boolean }): FolderUploadProgress {
  return {
    ...state,
    filesDone: Math.min(state.filesDone + 1, state.filesTotal),
    bytesDone: state.bytesDone + (update.ok ? Math.max(0, update.file.size) : 0),
  };
}

export function folderUploadPercent(state: FolderUploadProgress): number {
  const steps = state.directoriesTotal + state.filesTotal;
  if (steps <= 0) return 0;
  const done = Math.min(state.directoriesDone + state.filesDone, steps);
  return Math.round((done / steps) * 100);
}

/**
 * 从 `<input webkitdirectory>` 的 FileList 构建上传计划。
 * - `webkitRelativePath` 缺失时回退 `webkitdirectory-root/<name>`（不该发生，
 *   但降级路径仍能上传，不丢文件）；
 * - Windows 反斜杠归一为 `/`；
 * - 空段（`a//b`）与 `.` 跳过，`..` 回弹上一段（栈式解析，越界忽略）；
 * - 首段是所选根目录名：目录集**包含根段**（远端保持 `<根名>/…` 结构，
 *   与目录下载同语义——树落在当前目录下以所选目录命名的一层）。
 * - 文件相对路径推导出的全部中间目录入 directories 集（去重 + 深度升序）。
 */
export function buildFolderUploadPlan(entries: readonly { name: string; relativePath: string; size: number }[]): FolderUploadPlan {
  const directorySet = new Set<string>();
  const files: FolderUploadFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const name = String(entry.name || "").trim();
    if (!name) continue;
    const segments = normalizeRelativeSegments(entry.relativePath);
    // 最后一段必须是文件名本身；归一后与 name 不符的条目（畸形输入）跳过。
    if (!segments.length || segments[segments.length - 1] !== name) continue;
    const dirSegments = segments.slice(0, -1);
    for (let depth = 1; depth <= dirSegments.length; depth += 1) {
      directorySet.add(dirSegments.slice(0, depth).join("/"));
    }
    files.push({ name, relativePath: segments.join("/"), size: Number.isFinite(entry.size) && entry.size > 0 ? Math.floor(entry.size) : 0 });
    totalBytes += Math.max(0, Math.floor(Number(entry.size) || 0));
  }
  return { directories: sortDirectoryPaths(directorySet), files, totalBytes };
}

/** 相对路径 → 合法段序列；空段与 `.` 跳过，`..` 回弹上一段（栈空则忽略）。 */
function normalizeRelativeSegments(relativePath: string): string[] {
  const raw = String(relativePath || "").trim();
  if (!raw) return [];
  // webkitdirectory 在 Windows 上给反斜杠分隔的相对路径；统一归一。
  const segments: string[] = [];
  for (const segment of raw.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** 深度升序（父先于子），同深度按字典序保证输出确定可测。 */
function sortDirectoryPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth !== 0 ? depth : left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * 冲突模式 → 单文件处置：文件夹批量下 ask 降级为「已存在则跳过」（skip），
 * 由 App.vue 在 sftp/exists 预检后处置；rename/overwrite 仍交给既有
 * resolveUploadDuplicateName（rename-unique / 直接覆盖）。
 */
export function folderUploadConflictAction(mode: FolderUploadConflictMode, exists: boolean): "upload" | "skip" | "resolve" {
  if (!exists) return "upload";
  return mode === "ask" ? "skip" : "resolve";
}

/**
 * 完成汇总 → 七语提示用数值。部分失败/跳过仍算完成（与目录下载 outcome 同
 * 语义），failed/skipped 计数放在提示尾注里。
 */
export interface FolderUploadOutcome {
  fileCount: number;
  uploaded: number;
  skipped: number;
  failed: number;
  directories: number;
}

export function folderUploadOutcome(state: FolderUploadProgress, skipped: number, failed: number): FolderUploadOutcome {
  return {
    fileCount: state.filesTotal,
    uploaded: Math.max(0, state.filesDone - skipped - failed),
    skipped: Math.max(0, skipped),
    failed: Math.max(0, failed),
    directories: state.directoriesDone,
  };
}
