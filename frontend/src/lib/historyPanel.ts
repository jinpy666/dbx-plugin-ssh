// Warp 式终端 history 面板（↑ 唤起）的纯逻辑层：条目过滤、高亮循环导航与
// 打开门判定。数据来源（commandHistory）与浮层渲染留在 App.vue / 组件——
// 与 commandSuggestions/quickSelect 同一分工。检索复用 searchCommands 的
// fzf 风格子序列评分；无命中（或 query 超长越界）时回落大小写不敏感子串
// 过滤并保持历史顺序，保证「输入越打越具体」永远有可预期的结果集。

import { SEARCH_COMMANDS_DEFAULTS, commandSuggestionQueryAcceptable, searchCommands } from "./commandSuggestions";
import { OVERLAY_GAP } from "./overlayPlacement";

/** 面板单次展示的条目上限：全量历史的可视窗口足够大，超出靠继续输入收窄。 */
export const HISTORY_PANEL_LIMIT = 50;

/** 执行时间映射的容量上限（与 commandHistory 环形同额），超出按时间淘汰最旧。 */
export const HISTORY_TIMES_LIMIT = 100;

/** 面板条目：命令文本 + 最近一次执行时间（旧数据/未知来源无时间戳）。 */
export interface HistoryPanelEntry {
  command: string;
  ts: number | null;
}

/** 给过滤后的命令列表补时间戳（Warp 式右侧相对时间）。 */
export function decorateHistoryEntries(commands: readonly string[], times: Readonly<Record<string, number>>): HistoryPanelEntry[] {
  return commands.map((command) => ({ command, ts: times[command] ?? null }));
}

// —— 执行时间映射（pluginStore 键 ssh-command-history-times 的内存形态）——
// 并行结构而非改 commandHistory 形状：string[] 历史 suggestion/ghost/命令弹窗
// 多处消费，改造形状会波及全部调用点；时间只有面板用，单独一份数据零侵入。

/** 解析 localStorage/宿主档读回的时间映射：仅保留合法键值对并按容量截断。 */
export function sanitizeHistoryTimes(raw: unknown, limit = HISTORY_TIMES_LIMIT): Record<string, number> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  const rows: Array<[string, number]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { c, t } = item as { c?: unknown; t?: unknown };
    if (typeof c !== "string" || !c.trim() || typeof t !== "number" || !Number.isFinite(t) || t <= 0) continue;
    rows.push([c, t]);
  }
  // 新记录在后（record 追加），容量淘汰取最新的 limit 条。
  for (const [command, ts] of rows.slice(-limit)) out[command] = ts;
  return out;
}

/** 记录一条执行时间：去重后追加，按时间淘汰最旧到上限。 */
export function recordHistoryTime(times: Readonly<Record<string, number>>, command: string, now: number, limit = HISTORY_TIMES_LIMIT): Record<string, number> {
  const trimmed = command.trim();
  if (!trimmed) return { ...times };
  const next: Record<string, number> = {};
  for (const [key, ts] of Object.entries(times)) {
    if (key !== trimmed) next[key] = ts;
  }
  next[trimmed] = now;
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(entries.slice(-limit));
}

/** 持久化前修剪：历史环里已不存在的命令时间一并清掉。wire 形态为条目数组。 */
export function pruneHistoryTimes(times: Readonly<Record<string, number>>, history: readonly string[]): Array<{ c: string; t: number }> {
  const live = new Set(history);
  return Object.entries(times)
    .filter(([command]) => live.has(command))
    .map(([c, t]) => ({ c, t }));
}

// —— 相对时间（Warp 式右侧 "2 hours ago"）——分桶到 i18n 键，格式化留组件。

export type RelativeHistoryAge =
  | { kind: "never" }
  | { kind: "just-now" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "days"; count: number };

/** 相对时间分桶：坏值/缺值 never；<1min 刚刚；<1h 分钟；<1d 小时；其余天数。 */
export function relativeHistoryAge(ts: number | null | undefined, now: number): RelativeHistoryAge {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0 || now < ts) return { kind: "never" };
  const elapsedMinutes = Math.floor((now - ts) / 60_000);
  if (elapsedMinutes < 1) return { kind: "just-now" };
  if (elapsedMinutes < 60) return { kind: "minutes", count: elapsedMinutes };
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return { kind: "hours", count: elapsedHours };
  return { kind: "days", count: Math.floor(elapsedHours / 24) };
}

/** 面板向上展开的最小可用高度：低于它且下方更大才翻到输入行下方。 */
export const HISTORY_PANEL_MIN_HEIGHT = 140;

/**
 * Warp 版式放置侧：优先在输入行上方展开（底边贴光标行顶）；上方可用高度
 * 不足最小值且下方更大时（光标贴近视口顶部，如刚 clear 的提示符）翻到下方。
 * 视口不可测时保持上方（CSS max-height 兜底）。纯几何，不依赖内容测量——
 * DOM scrollHeight 在测试/渲染器就绪前不可得，放置决策不能挂在它上面。
 */
export function chooseHistoryPanelPlacement(
  anchorTopY: number,
  cellHeight: number,
  viewportHeight: number,
  gap = OVERLAY_GAP,
  minHeight = HISTORY_PANEL_MIN_HEIGHT,
): "above" | "below" {
  if (!(viewportHeight > 0)) return "above";
  const spaceAbove = anchorTopY - gap;
  const spaceBelow = viewportHeight - anchorTopY - cellHeight - gap;
  return spaceAbove >= minHeight || spaceAbove >= spaceBelow ? "above" : "below";
}

/**
 * 过滤面板条目：空 query 返回历史全量（截断到上限）；否则优先模糊检索
 * （子序列评分排序），无命中或 query 超出检索长度门时退化为大小写不敏感
 * 子串过滤（保持历史顺序，最新置顶语义不丢）。
 */
export function filterHistoryEntries(history: readonly string[], query: string, limit = HISTORY_PANEL_LIMIT): string[] {
  const max = Math.max(0, limit);
  const trimmed = query.trim();
  if (!trimmed) return history.slice(0, max);
  if (commandSuggestionQueryAcceptable(trimmed, 1, SEARCH_COMMANDS_DEFAULTS.maxLength)) {
    const ranked = searchCommands(trimmed, { history, quickCommands: [] }, { limit: max, minLength: 1 });
    if (ranked.length) return ranked.map((row) => row.command);
  }
  const needle = trimmed.toLowerCase();
  return history.filter((command) => command.toLowerCase().includes(needle)).slice(0, max);
}

/** 循环移动高亮项（↑↓ 到边缘回绕）；空列表恒为 0。 */
export function moveHistoryPanelIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** 重过滤后收拢高亮项：越界裁到列表尾，空列表归零。 */
export function clampHistoryPanelIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/** 打开门的输入面：调用方逐项传入当前浮层/终端状态，保持纯函数可测。 */
export interface HistoryPanelGates {
  completionOpen: boolean;
  suggestionOpen: boolean;
  quickSelectOpen: boolean;
  searchOpen: boolean;
  /** xterm 处于 alternate buffer（vim/tmux/htop 等整屏接管）。 */
  alternateActive: boolean;
  /** 远端命令执行中。 */
  commandRunning: boolean;
  /** zmodem/trzsz 传输占用输入流。 */
  transferBusy: boolean;
}

/**
 * 裸 ↑ 是否可被面板拦截：任一既有浮层占用按键、alternate 屏（全屏程序
 * 靠 ↑ 导航）、命令运行中或传输占用时不抢——shell 原生 readline 历史在
 * 面板未拦截的场景依旧可达。
 */
export function canOpenHistoryPanel(gates: HistoryPanelGates): boolean {
  return (
    !gates.completionOpen &&
    !gates.suggestionOpen &&
    !gates.quickSelectOpen &&
    !gates.searchOpen &&
    !gates.alternateActive &&
    !gates.commandRunning &&
    !gates.transferBusy
  );
}
