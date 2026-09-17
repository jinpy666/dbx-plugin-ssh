// 断点续传（sftp upload resume / transfer pause）纯逻辑：
// 本地文件 ↔ 远端可续传任务的匹配、可暂停性判断、恢复起点校验。
// 零 UI / 零 sidecar 依赖，单测见 transferResume.spec.ts。

export interface ResumableUploadTask {
  taskId: string;
  remotePath: string;
  fileName: string;
  size: number;
  resumableBytes: number;
}

export interface LocalFileCandidate {
  name: string;
  size: number;
}

// 停在 queued/running 的任务可以在两个分片之间暂停；终态一律不可。
export function transferPausable(status: string): boolean {
  return status === "queued" || status === "running";
}

// 后端扫描出的可续传任务还需满足"有已传前缀且未传完"。
export function canResumeUpload(task: ResumableUploadTask): boolean {
  return Number.isFinite(task.resumableBytes) && task.resumableBytes > 0 && task.resumableBytes < task.size;
}

// 本地文件与可续传任务的身份匹配：文件名 + 字节数双一致。
// 任一不一致都拒绝续传（spool 前缀可能拼接到错误的文件尾部）。
export function matchResumableUpload(
  task: ResumableUploadTask,
  files: readonly LocalFileCandidate[],
): LocalFileCandidate | null {
  if (!canResumeUpload(task)) return null;
  return files.find((file) => file.name === task.fileName && file.size === task.size) ?? null;
}

// 恢复上传的分片序列：从 resumeOffset 起按 chunkSize 推进到 size。
// 空序列（resumeOffset >= size）表示无事可传，调用方直接走 finish。
export function resumeChunkOffsets(
  size: number,
  resumeOffset: number,
  chunkSize: number,
): number[] {
  if (!Number.isFinite(size) || !Number.isFinite(resumeOffset) || chunkSize <= 0) return [];
  const start = Math.min(Math.max(0, Math.floor(resumeOffset)), Math.max(0, Math.floor(size)));
  const offsets: number[] = [];
  for (let offset = start; offset < size; offset += chunkSize) {
    offsets.push(offset);
  }
  return offsets;
}
