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

/** 面板条目：命令文本 + 最近执行时间 + 富元数据（批 4d，Warp command search
 *  同位：执行时长 / 退出码；旧数据或无 shell integration 会话两值皆空）。 */
export interface HistoryPanelEntry {
  command: string;
  ts: number | null;
  durationMs: number | null;
  exitCode: number | null;
}

/** 给过滤后的命令列表补时间戳与元数据（Warp 式右侧相对时间 + 时长/退出码）。 */
export function decorateHistoryEntries(
  commands: readonly string[],
  times: Readonly<Record<string, number>>,
  meta: Readonly<Record<string, HistoryMetaRow>> = {},
): HistoryPanelEntry[] {
  return commands.map((command) => {
    const row = meta[command];
    return { command, ts: times[command] ?? null, durationMs: row?.durationMs ?? null, exitCode: row?.exitCode ?? null };
  });
}

// —— 富元数据映射（批 4d，并行结构与时间映射同款）：命令 → {时长, 退出码}。
// OSC 633 D 帧的 lastCommandDuration/lastExitCode 在 applyCommandMarker 写入；
// 无 shell integration 的会话（无 D 帧）两值恒空，面板不渲染这两列。

export interface HistoryMetaRow {
  durationMs: number | null;
  exitCode: number | null;
}

export const HISTORY_META_LIMIT = 100;

/** 解析持久化的元数据映射：仅保留合法键值对并按容量截断。 */
export function sanitizeHistoryMeta(raw: unknown, limit = HISTORY_META_LIMIT): Record<string, HistoryMetaRow> {
  if (!Array.isArray(raw)) return {};
  const out: Record<string, HistoryMetaRow> = {};
  const rows: Array<[string, HistoryMetaRow]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { c, d, x } = item as { c?: unknown; d?: unknown; x?: unknown };
    if (typeof c !== "string" || !c.trim()) continue;
    const durationMs = typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : null;
    const exitCode = typeof x === "number" && Number.isFinite(x) ? x : null;
    if (durationMs === null && exitCode === null) continue;
    rows.push([c, { durationMs, exitCode }]);
  }
  for (const [command, row] of rows.slice(-limit)) out[command] = row;
  return out;
}

/** 记录一条元数据：合并写（时长与退出码可能分两次到达），按时间映射的存续
 *  命令集淘汰最旧。 */
export function recordHistoryMeta(
  meta: Readonly<Record<string, HistoryMetaRow>>,
  command: string,
  patch: Partial<HistoryMetaRow>,
  liveCommands: ReadonlySet<string>,
  limit = HISTORY_META_LIMIT,
): Record<string, HistoryMetaRow> {
  const trimmed = command.trim();
  if (!trimmed || !liveCommands.has(trimmed)) return { ...meta };
  const previous = meta[trimmed] ?? { durationMs: null, exitCode: null };
  const next: Record<string, HistoryMetaRow> = {};
  for (const [key, row] of Object.entries(meta)) {
    if (key !== trimmed && liveCommands.has(key)) next[key] = row;
  }
  next[trimmed] = {
    durationMs: patch.durationMs !== undefined ? patch.durationMs : previous.durationMs,
    exitCode: patch.exitCode !== undefined ? patch.exitCode : previous.exitCode,
  };
  const entries = Object.entries(next);
  if (entries.length <= limit) return next;
  return Object.fromEntries(entries.slice(-limit));
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

/** 打开期间翻面的绝对下限：低于它面板铬层（标题+搜索+键位提示，≈90px）
 *  已挤掉列表区，翻面才有意义。迟滞用它而非 minHeight——刀锋线附近锚点的
 *  单行抖动（回填换行）幅度小于两者之差，以 minHeight 为迟滞线仍会来回
 *  强制翻面；以铬层下限为线，中线以上一律保持原侧。 */
export const HISTORY_PANEL_FLIP_FLOOR = 96;

/**
 * Warp 版式放置侧：优先在输入行上方展开（底边贴光标行顶）；上方可用高度
 * 不足最小值且下方更大时（光标贴近视口顶部，如刚 clear 的提示符）翻到下方。
 * 视口不可测时保持上方（CSS max-height 兜底）。纯几何，不依赖内容测量——
 * DOM scrollHeight 在测试/渲染器就绪前不可得，放置决策不能挂在它上面。
 *
 * previous 为面板当前的放置侧（打开期间传入即启用迟滞）：锚点像素级抖动
 * （回显 settle 前后、长命令回填换行使光标行 ±1）不应让面板反复翻面——
 * 仅当当前侧可用高度跌破绝对下限且另一侧严格更大时才翻，否则维持原侧。
 */
export function chooseHistoryPanelPlacement(
  anchorTopY: number,
  cellHeight: number,
  viewportHeight: number,
  gap = OVERLAY_GAP,
  minHeight = HISTORY_PANEL_MIN_HEIGHT,
  previous?: "above" | "below",
  flipFloor = HISTORY_PANEL_FLIP_FLOOR,
): "above" | "below" {
  if (!(viewportHeight > 0)) return previous ?? "above";
  const spaceAbove = anchorTopY - gap;
  const spaceBelow = viewportHeight - anchorTopY - cellHeight - gap;
  if (previous === "above" || previous === "below") {
    const spaceCurrent = previous === "above" ? spaceAbove : spaceBelow;
    const spaceOther = previous === "above" ? spaceBelow : spaceAbove;
    if (spaceCurrent >= flipFloor || spaceCurrent >= spaceOther) return previous;
    return previous === "above" ? "below" : "above";
  }
  return spaceAbove >= minHeight || spaceAbove >= spaceBelow ? "above" : "below";
}

/**
 * 过滤面板条目。输出统一为「旧上新下」(与 shell readline 的 ↑ 方向一致:
 * 底部是最新执行的命令,↑ 一直往上翻更旧的);空 query 返回全量历史的最新
 * limit 条。检索命中时保持 searchCommands 的相关性排序再反转(最相关在
 * 底部,初始高亮即它);无命中或 query 超出检索长度门时退化为大小写不敏感
 * 子串过滤,同样保持旧上新下。
 */
export function filterHistoryEntries(history: readonly string[], query: string, limit = HISTORY_PANEL_LIMIT): string[] {
  const max = Math.max(0, limit);
  const trimmed = query.trim();
  if (!trimmed) return history.slice(0, max).reverse();
  if (commandSuggestionQueryAcceptable(trimmed, 1, SEARCH_COMMANDS_DEFAULTS.maxLength)) {
    const ranked = searchCommands(trimmed, { history, quickCommands: [] }, { limit: max, minLength: 1 });
    if (ranked.length) return ranked.map((row) => row.command).reverse();
  }
  const needle = trimmed.toLowerCase();
  return history.filter((command) => command.toLowerCase().includes(needle)).slice(0, max).reverse();
}

/** 循环移动高亮项（↑↓ 到边缘回绕）；空列表恒为 0。 */
export function moveHistoryPanelIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** 面板开启期间的键位→动作映射（shell ↑ 语义，纯函数供单测；App 消费动作
 *  并把选中项实时回填输入行）。move=移动高亮；stay=消费但不动（顶部最旧
 *  一条再 ↑ 停住，不回绕到最新——readline 到最旧即止）；fill=确认收起——
 *  行内容已与高亮实时同步，App 按焦点来源决定放行回车/Tab 归 shell 还是仅
 *  收起（不做整行替换，避免覆盖行内编辑）；cancel=取消导航：恢复打开前的
 *  原输入行并收起面板（Esc，以及底部最新一条再 ↓——越过最新回到原行，等价
 *  shell 历史栈回退）；close=确认收起（空列表的 Enter/Tab 无高亮项）。返回
 *  null 的按键不消费、放行远端。 */
export type HistoryPanelKeyAction =
  | { kind: "move"; delta: -1 | 1 }
  | { kind: "stay" }
  | { kind: "fill" }
  | { kind: "cancel" }
  | { kind: "close" };

export function resolveHistoryPanelKey(key: string, activeIndex: number, length: number): HistoryPanelKeyAction | null {
  switch (key) {
    case "Escape":
      return { kind: "cancel" };
    case "ArrowDown":
      if (length > 0 && activeIndex >= length - 1) return { kind: "cancel" };
      return { kind: "move", delta: 1 };
    case "ArrowUp":
      return activeIndex > 0 ? { kind: "move", delta: -1 } : { kind: "stay" };
    case "Enter":
    case "Tab":
      return length > 0 ? { kind: "fill" } : { kind: "close" };
    default:
      return null;
  }
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
  /** 登录期认证挑战待答（issue #150，MFA/OTP 待码输入或挑战弹窗未决）：
   *  ↑/↓ 留给远端交互（堡垒机选目标服务器），面板不抢。 */
  interactivePromptPending: boolean;
}

/**
 * 裸 ↑ 是否可被面板拦截：任一既有浮层占用按键、alternate 屏（全屏程序
 * 靠 ↑ 导航）、命令运行中、传输占用或终端交互提示待答（询问输入/选择，
 * issue #150 及其反馈扩展）时不抢——shell 原生 readline 历史在面板未拦截
 * 的场景依旧可达。
 */
export function canOpenHistoryPanel(gates: HistoryPanelGates): boolean {
  return (
    !gates.completionOpen &&
    !gates.suggestionOpen &&
    !gates.quickSelectOpen &&
    !gates.searchOpen &&
    !gates.alternateActive &&
    !gates.commandRunning &&
    !gates.transferBusy &&
    !gates.interactivePromptPending
  );
}

// —— 分桶档（scope = 连接 id；本地/串口终端固定桶）——三个历史存储键保持
// 单键值内分桶（宿主 storage 无列键、按连接动态键不可声明，同
// ssh-docker-engine 先例）；旧版单映射档（裸数组）一次性迁入 legacyScope 桶。

export interface HistoryBucketOptions {
  /** 旧版全局档（升级前）的迁入目标桶。 */
  legacyScope: string;
}

export type HistoryTimesBuckets = Record<string, Record<string, number>>;
export type HistoryMetaBuckets = Record<string, Record<string, HistoryMetaRow>>;
/** 持久化 wire 形态（按作用域的条目数组）。 */
export type HistoryTimesWireBuckets = Record<string, Array<{ c: string; t: number }>>;
export type HistoryMetaWireBuckets = Record<string, Array<{ c: string; d: number | null; x: number | null }>>;

/** 解析分桶时间档：逐桶 sanitize；旧档（裸 [{c,t}] 数组）整体迁入 legacyScope。 */
export function sanitizeHistoryTimesBuckets(raw: unknown, options: HistoryBucketOptions, limit = HISTORY_TIMES_LIMIT): HistoryTimesBuckets {
  if (Array.isArray(raw)) {
    const legacy = sanitizeHistoryTimes(raw, limit);
    return Object.keys(legacy).length && options.legacyScope ? { [options.legacyScope]: legacy } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: HistoryTimesBuckets = {};
  for (const [scope, bucket] of Object.entries(raw)) {
    if (!scope.trim()) continue;
    const rows = sanitizeHistoryTimes(bucket, limit);
    if (Object.keys(rows).length) out[scope] = rows;
  }
  return out;
}

/** 解析分桶元数据档：逐桶 sanitize；旧档（裸 [{c,d,x}] 数组）整体迁入 legacyScope。 */
export function sanitizeHistoryMetaBuckets(raw: unknown, options: HistoryBucketOptions, limit = HISTORY_META_LIMIT): HistoryMetaBuckets {
  if (Array.isArray(raw)) {
    const legacy = sanitizeHistoryMeta(raw, limit);
    return Object.keys(legacy).length && options.legacyScope ? { [options.legacyScope]: legacy } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const out: HistoryMetaBuckets = {};
  for (const [scope, bucket] of Object.entries(raw)) {
    if (!scope.trim()) continue;
    const rows = sanitizeHistoryMeta(bucket, limit);
    if (Object.keys(rows).length) out[scope] = rows;
  }
  return out;
}

/** 持久化前修剪分桶时间档：每桶按本作用域命令环裁剪（wire 为条目数组），空桶丢弃。 */
export function pruneHistoryTimesBuckets(times: Readonly<HistoryTimesBuckets>, rings: Readonly<Record<string, readonly string[]>>): HistoryTimesWireBuckets {
  const out: HistoryTimesWireBuckets = {};
  for (const [scope, bucket] of Object.entries(times)) {
    const rows = pruneHistoryTimes(bucket, rings[scope] ?? []);
    if (rows.length) out[scope] = rows;
  }
  return out;
}

/** 持久化前过滤分桶元数据档：每桶只留本作用域命令环存续的条目，空桶丢弃。 */
export function persistableHistoryMetaBuckets(meta: Readonly<HistoryMetaBuckets>, rings: Readonly<Record<string, readonly string[]>>): HistoryMetaWireBuckets {
  const out: HistoryMetaWireBuckets = {};
  for (const [scope, bucket] of Object.entries(meta)) {
    const live = new Set(rings[scope] ?? []);
    const rows = Object.entries(bucket)
      .filter(([command]) => live.has(command))
      .map(([c, row]) => ({ c, d: row.durationMs, x: row.exitCode }));
    if (rows.length) out[scope] = rows;
  }
  return out;
}
