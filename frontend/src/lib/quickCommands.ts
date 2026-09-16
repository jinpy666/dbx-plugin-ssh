// 快速命令栏：用户自定义常用命令片段（对标 tiny-rdm 快速命令）。
// localStorage CRUD，上限 20 条；纯函数，localStorage 读写留在调用方。

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
}

export const QUICK_COMMANDS_LIMIT = 20;
export const QUICK_COMMAND_NAME_MAX_LENGTH = 60;
export const QUICK_COMMAND_TEXT_MAX_LENGTH = 500;

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= 80;
}

/** 解析 localStorage 读回的快速命令：非法项丢弃、字段截断、按 id 去重、超限截断。 */
export function normalizeQuickCommands(raw: unknown, limit = QUICK_COMMANDS_LIMIT): QuickCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QuickCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const command = nonEmptyString(record.command).slice(0, QUICK_COMMAND_TEXT_MAX_LENGTH);
    if (!isValidId(id) || !command || seen.has(id)) continue;
    seen.add(id);
    const name = (nonEmptyString(record.name) || command).slice(0, QUICK_COMMAND_NAME_MAX_LENGTH);
    out.push({ id, name, command });
    if (out.length >= limit) break;
  }
  return out;
}

/** 新增或按 id 更新；已存在则原位更新，新条目追加到末尾，超限时丢弃最旧的（队首）。 */
export function upsertQuickCommand(list: QuickCommand[], item: QuickCommand, limit = QUICK_COMMANDS_LIMIT): QuickCommand[] {
  const command = item.command.trim();
  if (!command) return [...list];
  const entry: QuickCommand = {
    id: item.id,
    name: (item.name.trim() || command).slice(0, QUICK_COMMAND_NAME_MAX_LENGTH),
    command: command.slice(0, QUICK_COMMAND_TEXT_MAX_LENGTH),
  };
  const index = list.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return next;
  }
  return [...list, entry].slice(-limit);
}

/** 按 id 移除；id 不存在时返回等价副本。 */
export function removeQuickCommand(list: QuickCommand[], id: string): QuickCommand[] {
  return list.filter((item) => item.id !== id);
}

/** 名称/命令的大小写不敏感子串过滤；空查询返回全量。 */
export function filterQuickCommands(
  list: readonly QuickCommand[],
  query: string,
): QuickCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...list];
  return list.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.command.toLowerCase().includes(needle),
  );
}

/**
 * 写入终端的命令文本：保留多行结构，并把换行统一成 PTY 的 Enter
 * （Run/Paste 共用）。保留换行对反斜杠续行尤其重要；折叠为空格会把
 * `command \\` 变成带转义空格的错误命令。
 */
export function quickCommandText(command: string): string {
  return command.replace(/\r\n?/g, "\n").replace(/\n/g, "\r").trim();
}
