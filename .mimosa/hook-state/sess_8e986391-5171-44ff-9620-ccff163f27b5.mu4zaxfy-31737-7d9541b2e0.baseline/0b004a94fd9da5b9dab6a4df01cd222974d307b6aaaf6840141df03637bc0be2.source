// 终端关键词高亮（terminal keyword highlight）前端契约：类型 + 纯函数，零 xterm 依赖。
// 协议来源：ssh/docs/IMPL_PLAN_NETCATTY_PARITY.zh-CN.md §1.1 / §3-B1。
// sidecar `ssh/highlightRules/*` 负责存储与形状校验（regex 合法性明确不在后端
// 校验），本模块负责：规则 → 正则编译（plain 元字符转义、非法 regex 静默丢弃、
// 长词优先排序）、单行命中计算（重叠先到先得、单行上限）、保存前输入校验
// （返回 i18n error key）。装饰注册（xterm decorations）留在 App.vue 接线层。

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
