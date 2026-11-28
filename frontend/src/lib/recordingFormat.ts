/** 回放/录制时长格式化（自 useRecording 纯搬移）：H:MM:SS 或 MM:SS。 */
export function formatDuration(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 录制开始时间展示（asciicast v2 的 startedAt 是秒级 epoch）。 */
export function formatRecordedAt(startedAt?: number): string {
  if (!startedAt) return "";
  return new Date(startedAt * 1000).toLocaleString();
}
