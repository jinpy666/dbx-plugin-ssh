/** 字节数的 UI 格式化（B/KiB/MiB/GiB/TiB），与传输速率展示共用。 */
export function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1024 ** 4).toFixed(2)} TiB`;
}

/** 每秒速率格式化；非有限值或非正数统一显示 "0 B/s"。 */
export function formatRate(bytesPerSecond = 0): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}
