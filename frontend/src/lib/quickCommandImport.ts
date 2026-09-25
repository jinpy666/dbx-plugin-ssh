// 快速命令批量导入（对标 Tabby Snippets / NetCatty 快速命令导入）：
// 纯解析 + 合并策略，文件读取 / 预览 UI / sidecar 调用留在调用方（App.vue）。
//
// 支持两种输入（均为 JSON）：
// 1. 通用数组格式 `[{ "name": "...", "command": "..." }, ...]`；
// 2. Tabby 片段导出格式：config 备份把片段放在顶层对象的 `snippets` 数组下，
//    且老版本用 `title` 代替 `name`。字段映射规则（见 mapImportItem）：
//    name  <- name ?? title；command <- command ?? cmd。
//
// 策略（与本文件常量注释一一对应，导入确认弹层同步展示）：
// - 去重：输入内部与「输入 × 已有列表」均按名称做大小写不敏感匹配，同名跳过；
// - 上限：全局 ≤ QUICK_COMMANDS_LIMIT 条。溢出采用「导入前 N 条」：按输入
//   顺序填满剩余槽位，多余条目丢弃并计数提示（不做改名合并，保持可预期）。

import {
  QUICK_COMMANDS_LIMIT,
  QUICK_COMMAND_NAME_MAX_LENGTH,
  QUICK_COMMAND_TEXT_MAX_LENGTH,
  type QuickCommand,
} from "./quickCommands";

export interface QuickCommandImportItem {
  name: string;
  command: string;
}

export interface QuickCommandImportPlan {
  /** 合法化（截断 + 输入内同名去重）后、按输入顺序排列的可导入条目。 */
  items: QuickCommandImportItem[];
  /** 缺 command 或结构非法被丢弃的条目数。 */
  invalid: number;
  /** 输入内部同名（大小写不敏感）被跳过的条目数。 */
  duplicates: number;
}

export interface QuickCommandImportMerge {
  /** 实际会创建的条目（已扣除同名跳过并按剩余槽位截断）。 */
  accepted: QuickCommandImportItem[];
  /** 与已有列表同名被跳过的条目数。 */
  skippedExisting: number;
  /** 超出剩余槽位被丢弃的条目数（上限策略：导入前 N 条）。 */
  overflow: number;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 字段映射：通用格式用 name/command；Tabby 片段兼容 title（name 的旧键）
 *  与 cmd（command 的别名）。两者都缺 command 的条目视为非法。 */
function mapImportItem(item: unknown): QuickCommandImportItem | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const command = nonEmptyString(record.command) || nonEmptyString(record.cmd);
  if (!command) return null;
  const name = nonEmptyString(record.name) || nonEmptyString(record.title);
  return {
    name: name.slice(0, QUICK_COMMAND_NAME_MAX_LENGTH),
    command: command.slice(0, QUICK_COMMAND_TEXT_MAX_LENGTH),
  };
}

function normalizeName(name: string, command: string): string {
  return (name || command).slice(0, QUICK_COMMAND_NAME_MAX_LENGTH);
}

/** 解析导入文本。仅接受 JSON；顶层为数组、或带 `snippets` 数组的对象
 *  （Tabby config 导出形状）均可。解析失败（非 JSON / 空结果）返回
 *  invalid = -1 的空计划，调用方据此提示格式错误。 */
export function parseQuickCommandImport(text: string, limit = QUICK_COMMANDS_LIMIT): QuickCommandImportPlan {
  const plan: QuickCommandImportPlan = { items: [], invalid: 0, duplicates: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { items: [], invalid: -1, duplicates: 0 };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).snippets)
      ? ((parsed as Record<string, unknown>).snippets as unknown[])
      : null;
  if (!list) return { items: [], invalid: -1, duplicates: 0 };
  const seen = new Set<string>();
  for (const raw of list) {
    const item = mapImportItem(raw);
    if (!item) {
      plan.invalid += 1;
      continue;
    }
    const name = normalizeName(item.name, item.command);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      plan.duplicates += 1;
      continue;
    }
    seen.add(key);
    plan.items.push({ name, command: item.command });
    if (plan.items.length >= limit) break;
  }
  return plan;
}

/** 与已有列表合并：同名（大小写不敏感）跳过；剩余条目按顺序填满
 *  `limit - existing.length` 个槽位，放不下的计入 overflow（导入前 N 条）。 */
export function mergeQuickCommandImport(
  existing: readonly QuickCommand[],
  plan: QuickCommandImportPlan,
  limit = QUICK_COMMANDS_LIMIT,
): QuickCommandImportMerge {
  const existingNames = new Set(existing.map((item) => item.name.trim().toLowerCase()));
  const accepted: QuickCommandImportItem[] = [];
  const acceptedNames = new Set<string>();
  let skippedExisting = 0;
  let overflow = 0;
  for (const item of plan.items) {
    const key = item.name.toLowerCase();
    if (existingNames.has(key) || acceptedNames.has(key)) {
      skippedExisting += 1;
      continue;
    }
    if (existing.length + accepted.length >= limit) {
      overflow += 1;
      continue;
    }
    acceptedNames.add(key);
    accepted.push(item);
  }
  return { accepted, skippedExisting, overflow };
}
