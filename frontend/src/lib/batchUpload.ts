/**
 * 批量上传（多目标会话）纯函数层：远程目录归一、本地文件去重、重名策略与
 * 逐会话结果汇总。RPC 编排在 composables/useBatchUpload.ts —— 与批量发送
 * 命令（lib/batchSend.ts）同构：目标会话选择复用 batchTargets/batchSelected。
 */

export type BatchUploadPolicy = "overwrite" | "rename" | "skip";

export interface BatchUploadFile {
  /** 列表 key（同名文件可选多份，不能拿 name 当 key）。 */
  id: string;
  name: string;
  size: number;
  file: File;
}

export type BatchUploadRowStatus = "uploaded" | "skipped" | "failed";

export interface BatchUploadRow {
  sessionId: string;
  fileName: string;
  status: BatchUploadRowStatus;
  /** 实际远端路径（rename 策略下与本地文件名不同）。 */
  remotePath?: string;
  error?: string;
}

export interface BatchUploadSummary {
  rows: BatchUploadRow[];
  uploaded: number;
  skipped: number;
  failed: number;
}

/**
 * 归一上传目标目录：sidecar 的 normalize_remote_path 只认绝对路径（`~` 会被
 * 当成字面目录名），所以在 UI 侧就要把常见写法转成绝对路径：
 *   ""/"~"      → 远端主目录（home 未知时回落 /）
 *   "~/sub"     → <home>/sub
 *   "tmp"       → /tmp（无前导斜杠按根下相对）
 * 尾部斜杠去掉（根除外），中间连续斜杠压成一个。
 */
export function resolveUploadDir(raw: string, home?: string): string {
  const root = (home ?? "").trim() || "/";
  let value = (raw ?? "").trim();
  if (!value) value = root;
  if (value === "~") value = root;
  else if (value.startsWith("~/")) value = `${root === "/" ? "" : root.replace(/\/+$/, "")}/${value.slice(2)}`;
  else if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/{2,}/g, "/");
  return value === "/" ? value : value.replace(/\/+$/, "");
}

/** 目录 + 文件名 → 远端路径（目录已是绝对路径，见 resolveUploadDir）。 */
export function joinUploadPath(dir: string, name: string): string {
  const base = dir === "/" ? "" : dir.replace(/\/+$/, "");
  return `${base}/${name.replace(/^\/+/, "")}`;
}

/** 追加选择：同名同大小视为同一份（重复选择同一文件不产生重复行）。 */
export function addBatchUploadFiles(existing: BatchUploadFile[], incoming: BatchUploadFile[]): BatchUploadFile[] {
  const seen = new Set(existing.map((entry) => `${entry.name}\u0000${entry.size}`));
  const merged = [...existing];
  for (const entry of incoming) {
    const key = `${entry.name}\u0000${entry.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

export function removeBatchUploadFile(files: BatchUploadFile[], id: string): BatchUploadFile[] {
  return files.filter((entry) => entry.id !== id);
}

/** 已选文件总字节（状态条展示用；0 表示未选）。 */
export function batchUploadTotalBytes(files: BatchUploadFile[]): number {
  return files.reduce((total, entry) => total + (Number.isFinite(entry.size) ? entry.size : 0), 0);
}

/**
 * 可上传目标：勾选 ∩ 存活 ∩ 非只读 ∩ 非本地终端。
 * 本地 shell 会话没有 SFTP 子系统，混进来只会制造"4 个目标 3 个失败"的噪声。
 */
export function selectableUploadTargets<T extends { sessionId: string; local?: boolean; connected?: boolean; readOnly?: boolean }>(
  targets: T[],
  selected: string[],
): T[] {
  const wanted = new Set(selected);
  return targets.filter((target) => wanted.has(target.sessionId) && !target.local && target.connected !== false && !target.readOnly);
}

/** 汇总逐行结果：成功/跳过/失败三态计数 + 归一后的行（非法行丢弃）。 */
export function summarizeBatchUploadRows(rows: BatchUploadRow[]): BatchUploadSummary {
  const normalized = rows.filter((row) => row.sessionId && row.fileName);
  return {
    rows: normalized,
    uploaded: normalized.filter((row) => row.status === "uploaded").length,
    skipped: normalized.filter((row) => row.status === "skipped").length,
    failed: normalized.filter((row) => row.status === "failed").length,
  };
}

/**
 * 结果浮条自动收起策略（与批量发送同语义）：只有全部成功才短暂展示后自动收；
 * 有失败/跳过行常驻，逐行原因留给用户排查。
 */
export function shouldAutoDismissBatchUpload(summary: BatchUploadSummary): boolean {
  return summary.uploaded > 0 && summary.failed === 0 && summary.skipped === 0;
}
