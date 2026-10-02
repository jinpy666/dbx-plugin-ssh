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

// —— 远端 shell 历史导入（↑ history 面板的内容补全）——插件自采集的历史只
// 覆盖本插件会话期间敲的命令;面板要与 shell 原生 history 对齐,还需远端
// 历史文件(~/.bash_history / ~/.zsh_history)里的存量记录。ssh/exec 拉取
// tail 输出后,这里做纯解析与合并。

/**
 * 解析远端历史文件的 tail 文本为命令列表(旧→新)。处理两种格式:
 * - zsh EXTENDED_HISTORY 元数据前缀 `: <ts>:<dur>;`;
 * - 尾反斜杠续行(bash/zsh 历史文件把续行命令存成多行,拼接为一整条;
 *   bash 真实多行命令不带尾反斜杠,会被拆成多条——可接受的近似)。
 */
export function parseShellHistoryText(raw: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const line of raw.split("\n")) {
    let text = line;
    const zshMeta = /^:\s*\d+:\d+;/.exec(text);
    if (zshMeta) text = text.slice(zshMeta[0].length);
    // 反斜杠续行:奇数个尾反斜杠才是续行(偶数个是字面量转义)。
    const trailingBackslashes = /\\+$/.exec(text)?.[0].length ?? 0;
    if (trailingBackslashes % 2 === 1) {
      pending += text.slice(0, -1);
      continue;
    }
    pending += text;
    const joined = pending.trim();
    pending = "";
    if (joined) out.push(joined);
  }
  const tail = pending.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 把远端历史(旧→新)合并进命令环(最新在前):环里已有的命令不动,
 * 新增的按新旧插在环尾(更旧端),整体截断到上限。逐条过持久化过滤
 * (凭据/超长拒收),保证合并结果可直接持久化。
 */
export function mergeShellHistory(current: string[], shellLines: readonly (string)[], limit = COMMAND_HISTORY_LIMIT): string[] {
  const seen = new Set(current);
  const extra: string[] = [];
  for (const line of shellLines) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed) || !isPersistableCommand(trimmed)) continue;
    seen.add(trimmed);
    extra.push(trimmed);
  }
  extra.reverse();
  return [...current, ...extra].slice(0, limit);
}

// —— 按作用域分桶（scope = 连接 id；本地/串口终端固定桶）——多终端（多连接）
// 各占一桶，↑ 面板/建议/ghost/命令弹窗只读当前作用域，历史不再互串。存储键
// 保持单键（宿主 storage 无列键、按连接动态键不可声明，同 ssh-docker-engine
// 先例），值内分桶；旧版全局环（裸 string[]）一次性迁入 legacyScope 桶
// （升级不丢档），SSH 连接随后以各自 shell 历史文件回填，来源回到终端本身。

export interface CommandHistoryBucketOptions {
  /** 旧版全局环（升级前档）的迁入目标桶。 */
  legacyScope: string;
}

export type CommandHistoryBuckets = Record<string, string[]>;

/** 解析分桶历史档：逐桶 sanitize；旧档（裸数组）整体迁入 legacyScope。 */
export function sanitizeCommandHistoryBuckets(raw: unknown, options: CommandHistoryBucketOptions, limit = COMMAND_HISTORY_LIMIT): CommandHistoryBuckets {
  if (Array.isArray(raw)) {
    const legacy = sanitizeCommandHistory(raw, limit);
    return legacy.length && options.legacyScope ? { [options.legacyScope]: legacy } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: CommandHistoryBuckets = {};
  for (const [scope, bucket] of Object.entries(raw)) {
    if (!scope.trim()) continue;
    const rows = sanitizeCommandHistory(bucket, limit);
    if (rows.length) out[scope] = rows;
  }
  return out;
}

/** 持久化前逐桶过滤（凭据/超长/多行拒收）并丢弃空桶。 */
export function persistableCommandHistoryBuckets(buckets: Readonly<CommandHistoryBuckets>): CommandHistoryBuckets {
  const out: CommandHistoryBuckets = {};
  for (const [scope, bucket] of Object.entries(buckets)) {
    if (!scope.trim()) continue;
    const rows = bucket.filter((command) => isPersistableCommand(command));
    if (rows.length) out[scope] = rows;
  }
  return out;
}
