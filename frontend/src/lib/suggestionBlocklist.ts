// 建议黑名单（批 4c，对标 Warp IgnoredSuggestionsModel 的「单条建议不再
// 提示」语义）：用户对某条历史/快速命令点 ✗ 后持久化排除，浮层不再推荐。
// pluginStore 非敏感持久化（与命令历史同档），容量截断防无限增长；纯函数
// + 显式存取，过滤留在调用方（useCommandSuggestions.runSuggestionSearch）。

import { pluginStore } from "./pluginStore";

const SUGGESTION_BLOCKLIST_KEY = "ssh-suggestion-blocklist";
const SUGGESTION_BLOCKLIST_LIMIT = 100;

/** 读回黑名单：解析失败/非数组/含非字符串行一律丢弃，容量截断。 */
export function loadSuggestionBlocklist(): string[] {
  try {
    const raw = pluginStore.getItem(SUGGESTION_BLOCKLIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, SUGGESTION_BLOCKLIST_LIMIT);
  } catch {
    return [];
  }
}

/** 追加单条（去重、新条目置顶、容量截断）并持久化；返回更新后的列表。 */
export function addToSuggestionBlocklist(command: string, list: string[]): string[] {
  const trimmed = command.trim();
  if (!trimmed) return list;
  const next = [trimmed, ...list.filter((entry) => entry !== trimmed)].slice(0, SUGGESTION_BLOCKLIST_LIMIT);
  saveSuggestionBlocklist(next);
  return next;
}

/** 清空并持久化（设置里的「清空」入口）。 */
export function clearSuggestionBlocklist(): string[] {
  saveSuggestionBlocklist([]);
  return [];
}

function saveSuggestionBlocklist(list: string[]) {
  try {
    pluginStore.setItem(SUGGESTION_BLOCKLIST_KEY, JSON.stringify(list));
  } catch {
    // 持久化失败不阻断交互：本次会话内黑名单仍在内存生效，下次重读。
  }
}
