// 终端关键词高亮（terminal keyword highlight）前端契约：类型 + 纯函数，零 xterm 依赖。
// 协议来源：ssh/docs/IMPL_PLAN_NETCATTY_PARITY.zh-CN.md §1.1 / §3-B1。
// 权威存储 pluginStore（宿主 ui-storage.json，随 DBX secrets 同步加密上云；
// IMPL_PLAN_STORAGE_SYNC 批 1），sidecar `ssh/highlightRules/*` 仅作一次性
// 迁移种子。本模块负责：权威清单存取与 upsert、规则 → 正则编译（plain
// 元字符转义、非法 regex 静默丢弃、长词优先排序）、单行命中计算（重叠先到
// 先得、单行上限）、保存前输入校验（返回 i18n error key）。装饰注册（xterm
// decorations）留在 App.vue 接线层。

import { pluginStore } from "./pluginStore";
import { randomUUID } from "./uuid";

/** `ssh/highlightRules/*` 下发的规则视图字段（§1.1 契约，全 camelCase）。 */
export interface HighlightRuleView {
  id: string;
  pattern: string;
  isRegex: boolean;
  color: string;
  caseSensitive: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 编译产物：预构建的正则 + 装饰渲染所需的着色信息。 */
export interface CompiledHighlightRule {
  pattern: string;
  color: string;
  caseSensitive: boolean;
  regex: RegExp;
}

/** 单行中的一个命中区间（end 为 exclusive）。 */
export interface HighlightMatch {
  start: number;
  end: number;
  color: string;
}

/** 与后端校验同向的约束：pattern trim 后 1–200 字符。 */
export const HIGHLIGHT_RULE_PATTERN_MAX = 200;
/** 规则上限（§1.1：后端 30 条，前端管理弹层据此置灰新增）。 */
export const HIGHLIGHT_RULES_LIMIT = 30;
/** 后端 save 的默认色（§1.1：color 缺省 #f59e0b）。 */
export const HIGHLIGHT_COLOR_DEFAULT = "#f59e0b";
/** 与后端一致的色值形状：#RRGGBB。 */
export const HIGHLIGHT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** 单行命中上限（decoration 数量护栏的一部分，另有全局 400 上限在 App.vue）。 */
export const HIGHLIGHT_MATCHES_PER_LINE_LIMIT = 20;

/**
 * 装饰填充透明度：xterm 的 decoration 元素绘制在文字层上方，纯色背景会
 * 盖死字形（用户可见即"色块遮字"）；用半透明填充让原文字透出、色相保留。
 */
export const HIGHLIGHT_FILL_ALPHA = 0.35;

/**
 * `Terminal.onRender` 的 `start/end` 是**视口相对**行号（契约写明 0..rows-1），
 * 而装饰表里的 row 与 `buffer.viewportY` 是**缓冲绝对**行号。缓冲区滚过一屏后
 * （viewportY > 0）直接比较两者永远不会命中，被原地改写（进度行、`\r` 覆盖）
 * 的行会留下旧色块——这里做一次换算并按缓冲行数裁剪。
 */
export function toAbsoluteRowRange(start: number, end: number, viewportY: number, bufferLength: number): { from: number; to: number } {
  const lastLine = Math.max(0, bufferLength - 1);
  const from = Math.max(0, Math.min(viewportY + start, lastLine));
  return { from, to: Math.max(from, Math.min(viewportY + end, lastLine)) };
}

export interface HighlightRowRebuildInput {
  row: number;
  viewportFrom: number;
  viewportTo: number;
  /** 该行是否落在本帧重绘区间（已换算成绝对行号）。 */
  dirty: boolean;
  previousText: string;
  currentText: string;
}

/**
 * 单行装饰组是否要拆掉重建：
 * - 行滚出视口 → 拆（Map 不同步收缩会拖着全局上限走）；
 * - 行在本帧重绘且文本变了 → 拆（下面按新文本重扫，让高亮跟随编辑）；
 * - 其余（尤其"本帧重绘但文本没变"）→ 留。
 *
 * 最后一条是防闪烁的关键：xterm 在装饰注册/销毁后会再触发整幅重绘，无脑拆建
 * 会让空闲终端陷入"重绘→扫描→拆建→重绘"的自激回路（实测 30fps 持续整屏
 * 重绘 + 装饰 DOM 每秒拆建数百次），高亮层反复摘挂即用户看到的闪烁。
 */
export function shouldRebuildHighlightRow(input: HighlightRowRebuildInput): boolean {
  if (input.row < input.viewportFrom || input.row > input.viewportTo) return true;
  return input.dirty && input.previousText !== input.currentText;
}

/** `#rrggbb` 规则色 → 带透明度的 rgba 填充色（非法形状回退默认色）。 */
export function highlightFillStyle(color: string): string {
  const hex = HIGHLIGHT_COLOR_PATTERN.test(color) ? color : HIGHLIGHT_COLOR_DEFAULT;
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${HIGHLIGHT_FILL_ALPHA})`;
}

function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBool(value: unknown): boolean {
  return value === true;
}

/**
 * 归一 `ssh/highlightRules/list|save|delete` 回传的清单：非对象/缺 id/缺
 * pattern 的条目丢弃、字段类型收紧、按 id 去重、保留后端下发的顺序
 * （约定 createdAt 升序）。unknown 容忍（旧 sidecar / 坏 JSON 的降级路径）。
 */
export function normalizeHighlightRules(raw: unknown, limit = HIGHLIGHT_RULES_LIMIT): HighlightRuleView[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HighlightRuleView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = asString(record.id).slice(0, 80);
    const pattern = asString(record.pattern).slice(0, HIGHLIGHT_RULE_PATTERN_MAX);
    if (!id || !pattern.trim() || seen.has(id)) continue;
    seen.add(id);
    const color = HIGHLIGHT_COLOR_PATTERN.test(asString(record.color)) ? asString(record.color) : HIGHLIGHT_COLOR_DEFAULT;
    const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0;
    const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : createdAt;
    out.push({
      id,
      pattern,
      isRegex: asBool(record.isRegex),
      color,
      caseSensitive: asBool(record.caseSensitive),
      // enabled 缺省视为 true（与后端 save 默认一致）。
      enabled: record.enabled !== false,
      createdAt,
      updatedAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** pluginStore 权威键（IMPL_PLAN_STORAGE_SYNC 批 1）。 */
export const HIGHLIGHT_RULES_STORE_KEY = "ssh-highlight-rules";

/**
 * 从 pluginStore 读权威清单；返回 null 表示键尚不存在（未迁移，调用方应走
 * sidecar 种子搬迁）。存在但为空数组是合法用户态（已清空），不触发搬迁。
 */
export function loadHighlightRulesFromStore(): HighlightRuleView[] | null {
  try {
    const raw = pluginStore.getItem(HIGHLIGHT_RULES_STORE_KEY);
    if (raw === null) return null;
    return normalizeHighlightRules(JSON.parse(raw));
  } catch {
    // 坏 JSON 视为空清单：不回退种子（键已存在 = 已迁移，避免复活旧数据）。
    return [];
  }
}

/** 全量写穿 pluginStore（空数组同样落键，标记"已迁移"）。 */
export function persistHighlightRules(list: readonly HighlightRuleView[]): HighlightRuleView[] {
  const normalized = normalizeHighlightRules(list);
  try {
    pluginStore.setItem(HIGHLIGHT_RULES_STORE_KEY, JSON.stringify(normalized));
  } catch {
    // 持久化失败不阻断：本次会话内存态仍生效。
  }
  return normalized;
}

/** upsert 入参：id 空缺表示新建（生成 id/时间戳）；enabled 缺省沿用旧值（新建为开）。 */
export interface HighlightRuleUpsertInput {
  id?: string;
  pattern: string;
  color: string;
  isRegex: boolean;
  caseSensitive: boolean;
  enabled?: boolean;
}

/**
 * 新建或按 id 更新：更新保留原 id/createdAt、刷新 updatedAt；enabled 未显式
 * 给出时沿用现值（编辑不动启停位，toggle 才显式传）。经 normalizeHighlightRules
 * 收紧字段（颜色容错、去重、上限）。
 */
export function upsertHighlightRule(
  list: readonly HighlightRuleView[],
  input: HighlightRuleUpsertInput,
  now = Date.now(),
): HighlightRuleView[] {
  const existing = input.id ? list.find((rule) => rule.id === input.id) : undefined;
  const row = {
    id: existing?.id ?? input.id ?? randomUUID(),
    pattern: input.pattern,
    color: input.color,
    isRegex: input.isRegex === true,
    caseSensitive: input.caseSensitive === true,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const entry = normalizeHighlightRules([row])[0];
  if (!entry) return [...list];
  const index = list.findIndex((rule) => rule.id === entry.id);
  if (index < 0) return normalizeHighlightRules([...list, entry]);
  const next = [...list];
  next[index] = entry;
  return normalizeHighlightRules(next);
}

/**
 * 把规则视图编译成正则列表：
 * - `enabled: false` 与空 pattern 规则跳过；
 * - plain pattern 元字符转义（字面匹配），isRegex 直通；
 * - 非法 regex 静默丢弃（后端不校验 regex 合法性，这里兜底不抛异常）；
 * - 按 pattern 长度降序排列（长词优先，重叠时先占位）。
 */
export function compileRules(rules: readonly HighlightRuleView[]): CompiledHighlightRule[] {
  const compiled: CompiledHighlightRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    if (!pattern || rule.enabled === false) continue;
    const source = rule.isRegex === true ? pattern : escapeRegExp(pattern);
    let regex: RegExp;
    try {
      regex = new RegExp(source, rule.caseSensitive === true ? "g" : "gi");
    } catch {
      continue;
    }
    compiled.push({ pattern, color: rule.color, caseSensitive: rule.caseSensitive === true, regex });
  }
  return compiled.sort((a, b) => b.pattern.length - a.pattern.length);
}

/**
 * 计算一行文本中的全部命中区间：
 * - 规则按传入顺序（约定为 compileRules 的长词优先序）依次扫描；
 * - 区间重叠时先到先得（先命中者保留，后到的跳过）；
 * - 每行命中数上限 `maxPerLine`（默认 20），达到即提前返回；
 * - 空规则表/空文本/非法上限返回空数组；共享的 global regex 每次重置 lastIndex。
 */
export function matchesInLine(line: string, compiled: readonly CompiledHighlightRule[], maxPerLine = HIGHLIGHT_MATCHES_PER_LINE_LIMIT): HighlightMatch[] {
  if (!line || compiled.length === 0 || maxPerLine <= 0) return [];
  const taken: Array<[number, number]> = [];
  const matches: HighlightMatch[] = [];
  for (const rule of compiled) {
    rule.regex.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = rule.regex.exec(line)) !== null) {
      // 零宽命中防死循环：手动推进一格再继续。
      if (hit[0].length === 0) {
        rule.regex.lastIndex += 1;
        continue;
      }
      const start = hit.index;
      const end = start + hit[0].length;
      if (!taken.some(([takenStart, takenEnd]) => start < takenEnd && end > takenStart)) {
        taken.push([start, end]);
        matches.push({ start, end, color: rule.color });
        if (matches.length >= maxPerLine) return matches.sort((a, b) => a.start - b.start);
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** sanitize 失败时返回的 i18n error key（供调用方 `t(error)` 直接渲染）。 */
export type HighlightRuleInputError =
  | "highlightRules.invalidPattern"
  | "highlightRules.invalidColor"
  | "highlightRules.invalidRegex";

/** 保存表单原始输入（弹层草稿）。 */
export interface HighlightRuleDraftInput {
  pattern: string;
  color?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
}

/** 校验通过后的规整输入（可直接作为 `ssh/highlightRules/save` 参数）。 */
export interface HighlightRuleDraftValue {
  pattern: string;
  color: string;
  isRegex: boolean;
  caseSensitive: boolean;
}

export interface HighlightRuleSanitizeResult {
  value: HighlightRuleDraftValue | null;
  error: HighlightRuleInputError | null;
}

/**
 * 保存前校验（§1.1 后端只校验形状，regex 合法性由前端把关）：
 * ① pattern trim 后必填且 ≤200（invalidPattern）；
 * ② color 匹配 #RRGGBB，空缺省回退默认色（invalidColor）；
 * ③ isRegex 时先行 `new RegExp` 编译校验（invalidRegex）。
 */
export function sanitizeHighlightRuleInput(draft: HighlightRuleDraftInput): HighlightRuleSanitizeResult {
  const pattern = typeof draft.pattern === "string" ? draft.pattern.trim() : "";
  if (!pattern || pattern.length > HIGHLIGHT_RULE_PATTERN_MAX) {
    return { value: null, error: "highlightRules.invalidPattern" };
  }
  const color = typeof draft.color === "string" && draft.color.trim() ? draft.color.trim() : HIGHLIGHT_COLOR_DEFAULT;
  if (!HIGHLIGHT_COLOR_PATTERN.test(color)) {
    return { value: null, error: "highlightRules.invalidColor" };
  }
  const isRegex = draft.isRegex === true;
  if (isRegex) {
    try {
      new RegExp(pattern);
    } catch {
      return { value: null, error: "highlightRules.invalidRegex" };
    }
  }
  return {
    value: { pattern, color, isRegex, caseSensitive: draft.caseSensitive === true },
    error: null,
  };
}
