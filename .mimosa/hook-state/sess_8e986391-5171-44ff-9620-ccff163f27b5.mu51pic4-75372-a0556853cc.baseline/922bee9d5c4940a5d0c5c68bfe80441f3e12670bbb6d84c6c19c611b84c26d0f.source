// 命令弹窗的远程命令历史（对标 tiny-rdm 命令历史）：
// 内存环形（最新置顶、去重、上限 100 条），localStorage 只持久化非敏感命令。
// 纯函数；localStorage 读写留在调用方。

export const COMMAND_HISTORY_LIMIT = 100;
// 持久化单条命令的最大长度：超长命令多半是一次性脚本片段，重放价值低。
export const PERSISTED_COMMAND_MAX_LENGTH = 200;
// 疑似内嵌凭据的命令不落 localStorage（内存历史仍保留，便于当前会话重放）。
const SECRET_LIKE_PATTERN = /(?:password|passwd|passphrase|token|secret|api[-_]?key|access[-_]?key)\s*[:=]/i;

export type CommandInputAction = "run" | "history-up" | "history-down" | "none";

/**
 * Resolves keyboard behavior for the multiline command editor. Ctrl/Cmd+Enter
 * submits; plain Enter remains available for shell scripts and backslash
 * continuations. History navigation only takes over at the corresponding edge
 * of the editor, so arrows keep their normal multiline editing behavior.
 */
export function commandInputAction(options: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  selectionStart: number;
  selectionEnd: number;
  valueLength: number;
}): CommandInputAction {
  if (options.key === "Enter" && (options.ctrlKey || options.metaKey) && !options.shiftKey) {
    return "run";
  }
  if (
    options.selectionStart !== options.selectionEnd ||
    options.ctrlKey ||
    options.metaKey ||
    options.shiftKey
  ) {
    return "none";
  }
  if (options.key === "ArrowUp" && options.selectionStart === 0) return "history-up";
  if (options.key === "ArrowDown" && options.selectionEnd === options.valueLength) return "history-down";
  return "none";
}

/** 记录一条命令：去重后置顶，截断到上限；空命令原样返回等价副本。 */
export function pushCommandHistory(history: string[], command: string, limit = COMMAND_HISTORY_LIMIT): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [...history];
  return [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, limit);
}

/** 该命令是否适合写入 localStorage（非空、不超长、无内嵌凭据痕迹）。 */
export function isPersistableCommand(command: string, maxLength = PERSISTED_COMMAND_MAX_LENGTH): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > maxLength || /\n|\r/.test(trimmed)) return false;
  return !SECRET_LIKE_PATTERN.test(trimmed);
}

/** ↑↓ 浏览历史：index 为 -1 表示未处于浏览态。向上到顶停住，向下越过最新一条回到回退草稿。 */
export function browseCommandHistory(
  history: string[],
  index: number,
  direction: "up" | "down",
  fallbackDraft = "",
): { index: number; draft: string } {
  if (!history.length) return { index: -1, draft: fallbackDraft };
  if (direction === "up") {
    const next = Math.min(index + 1, history.length - 1);
    return { index: next, draft: history[next] };
  }
  if (index <= 0) return { index: -1, draft: fallbackDraft };
  return { index: index - 1, draft: history[index - 1] };
}

/** 解析 localStorage 读回的历史：只保留合法字符串并按持久化规则过滤、去重、截断。 */
export function sanitizeCommandHistory(raw: unknown, limit = COMMAND_HISTORY_LIMIT): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!isPersistableCommand(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}
