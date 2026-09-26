/**
 * Quick Select Mode（对标 WezTerm Quick Select，WT-1）：扫描终端缓冲区的文本，
 * 用固定正则抽取 URL / 文件路径 / IPv4 / hash，返回结构化命中列表（类别、文本、
 * 行列定位），overlay 菜单逐项展示 + 一键复制。纯计算模块，不触碰 DOM / xterm
 * 实例，与 terminalClickCursor.ts 同款 Buffer-like 建模便于单测。
 *
 * 敌意输入防御（仓库 no-panic / 容量上限模式）：
 * - 逻辑行长截断（maxLineChars）：超长行只扫前缀，正则不吃无界输入；
 * - 扫描行数上限（maxRows）：全缓冲模式也不会拖死主线程；
 * - 命中数上限（maxHits）：雪屏式重复命中不撑爆 overlay；
 * - 全部正则为线性形态（无嵌套量词/回溯炸弹），坏数据降级为少命中或零命中。
 *
 * 定位语义：命中带逻辑行起始 buffer 行号与 0 基列号。换行折行（isWrapped 链）
 * 先拼接成逻辑行再抽取，跨行 URL/路径不会被截成两段噪声；列号以起始物理行为准。
 */

export type QuickSelectKind = "url" | "path" | "ipv4" | "hash";

export interface QuickSelectHit {
  kind: QuickSelectKind;
  /** 可直接进剪贴板的文本（尾部标点已修剪）。 */
  text: string;
  /** 命中起始所在的物理 buffer 行号（含回滚偏移）。 */
  row: number;
  /** 命中起始在该行的 0 基列号。 */
  col: number;
}

/** 与 xterm buffer.active 的最小交互面。 */
export interface QuickSelectLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface QuickSelectBufferLike {
  readonly length: number;
  readonly viewportY: number;
  getLine(row: number): QuickSelectLineLike | undefined;
}

export interface QuickSelectLimits {
  /** 单次扫描的物理行数上限。 */
  maxRows: number;
  /** 单个逻辑行喂给正则的字符数上限（超出部分截断丢弃）。 */
  maxLineChars: number;
  /** 返回的命中总数上限。 */
  maxHits: number;
}

export const QUICK_SELECT_DEFAULT_LIMITS: QuickSelectLimits = {
  maxRows: 2048,
  maxLineChars: 8192,
  maxHits: 200,
};

export type QuickSelectScope = "viewport" | "buffer";

export interface QuickSelectOptions {
  /** viewport（默认）只扫可视区；buffer 从可视区底向上扩展到 maxRows。 */
  scope?: QuickSelectScope;
  limits?: Partial<QuickSelectLimits>;
}

// URL 主体吃到任意非空白；尾部标点由 trimUrlTail 修剪，避免把句子句号/右括号
// 带进剪贴板。十六进制转义与控制字符一并排除。
const URL_PATTERN = /(?:https?|ftp):\/\/[^\s\u0000-\u001f\u007f]+/gi;
// 绝对路径与 ~ / ./ ../ 前缀；段字符刻意保守（不含空白/引号/括号），
// 要求至少一个「/段」，裸 / 与裸 ~ 不算路径。
const PATH_PATTERN = /(?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?/g;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// 7..64 位十六进制：git 短 SHA（7）到 SHA-256（64）。纯数字不算 hash。
const HASH_PATTERN = /\b[0-9a-f]{7,64}\b/gi;

/** 类别优先级：URL > 路径 > IPv4 > hash；低优先级命中完全落在高优先级命中内时丢弃。 */
const KIND_PRIORITY: Record<QuickSelectKind, number> = { url: 0, path: 1, ipv4: 2, hash: 3 };

interface RawMatch {
  kind: QuickSelectKind;
  start: number;
  end: number;
  text: string;
}

function trimUrlTail(text: string): string {
  const tailPunctuation = ".,;:!?'\"]}>》」』";
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (tailPunctuation.includes(ch)) {
      end -= 1;
      continue;
    }
    // 未配对的右括号属于外层文本（「(see https://x)」），配对则保留。
    if ((ch === ")" && countChar(text, "(", 0, end) < countChar(text, ")", 0, end)) ||
        (ch === "]" && countChar(text, "[", 0, end) < countChar(text, "]", 0, end))) {
      end -= 1;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

function countChar(text: string, ch: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i += 1) if (text[i] === ch) count += 1;
  return count;
}

function isIpv4(text: string): boolean {
  const octets = text.split(".");
  if (octets.length !== 4) return false;
  // 前导零拒绝是 v4 书写惯例之外的事（01.2.3.4 合法但不常见），这里只验 0..255。
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function collectMatches(line: string): RawMatch[] {
  const matches: RawMatch[] = [];
  const pushAll = (kind: QuickSelectKind, pattern: RegExp, transform: (text: string) => string | null) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const text = transform(match[0]);
      if (!text) continue;
      matches.push({ kind, start: match.index, end: match.index + text.length, text });
    }
  };
  pushAll("url", URL_PATTERN, trimUrlTail);
  pushAll("path", PATH_PATTERN, (text) => {
    const trimmed = trimUrlTail(text);
    return trimmed.length > 0 ? trimmed : null;
  });
  pushAll("ipv4", IPV4_PATTERN, (text) => (isIpv4(text) ? text : null));
  pushAll("hash", HASH_PATTERN, (text) => (/^\d+$/.test(text) ? null : text));
  // 每类内部按出现位置排序，再按类别优先级整体排序，供包含过滤用。
  matches.sort((a, b) => (a.start - b.start) || (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]));
  const kept: RawMatch[] = [];
  for (const candidate of matches) {
    const contained = kept.some((hit) => KIND_PRIORITY[hit.kind] < KIND_PRIORITY[candidate.kind] && candidate.start >= hit.start && candidate.end <= hit.end);
    if (!contained) kept.push(candidate);
  }
  return kept.sort((a, b) => (a.start - b.start) || (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]));
}

interface LineSegment {
  /** 物理行号。 */
  row: number;
  /** 该物理行文本在逻辑行里的起始偏移。 */
  offset: number;
  length: number;
}

interface LogicalLine {
  text: string;
  segments: LineSegment[];
}

/**
 * 把物理行折叠成逻辑行（isWrapped 续行拼接），超出 maxLineChars 后强制断链，
 * 后续行重新开行（截断段的命中照常可用，超长行不会拖垮正则）。
 */
function* logicalLines(buffer: QuickSelectBufferLike, top: number, bottom: number, limits: QuickSelectLimits): Generator<LogicalLine> {
  let text = "";
  let segments: LineSegment[] = [];
  for (let row = top; row <= bottom; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const rowText = line.translateToString(true);
    const wrapped = row > top && line.isWrapped && segments.length > 0;
    if (wrapped && text.length + rowText.length <= limits.maxLineChars) {
      segments.push({ row, offset: text.length, length: rowText.length });
      text += rowText;
      continue;
    }
    if (segments.length > 0) yield { text, segments };
    text = rowText.length > limits.maxLineChars ? rowText.slice(0, limits.maxLineChars) : rowText;
    segments = text.length > 0 ? [{ row, offset: 0, length: text.length }] : [];
  }
  if (segments.length > 0) yield { text, segments };
}

function segmentAt(segments: LineSegment[], offset: number): LineSegment {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (offset >= segments[i].offset) return segments[i];
  }
  return segments[0];
}

/**
 * 扫描缓冲区抽取命中。可视区（默认）覆盖运维最常用的「屏幕上有什么点什么」；
 * buffer 档从可视区底向上扩展到 maxRows。命中按出现位置排列（同一起点再按
 * 类别优先级），文本全局去重（首个胜出）。
 */
export function collectQuickSelectHits(
  buffer: QuickSelectBufferLike,
  viewportRows: number,
  options: QuickSelectOptions = {},
): QuickSelectHit[] {
  const limits = { ...QUICK_SELECT_DEFAULT_LIMITS, ...options.limits };
  const length = Math.max(0, buffer.length | 0);
  if (length === 0) return [];
  const viewportBottom = Math.min(Math.max(0, buffer.viewportY) + Math.max(0, viewportRows) - 1, length - 1);
  const bottom = Math.max(0, viewportBottom);
  // viewport 只扫可视区；buffer 档从可视区底向上扩到 maxRows（两种档都吃上限约束）。
  const top = options.scope === "buffer"
    ? Math.max(0, bottom + 1 - limits.maxRows)
    : Math.min(Math.max(0, buffer.viewportY), bottom);
  const hits: QuickSelectHit[] = [];
  const seen = new Set<string>();
  for (const logical of logicalLines(buffer, top, bottom, limits)) {
    for (const match of collectMatches(logical.text)) {
      if (hits.length >= limits.maxHits) return hits;
      if (seen.has(match.text)) continue;
      seen.add(match.text);
      const segment = segmentAt(logical.segments, match.start);
      hits.push({ kind: match.kind, text: match.text, row: segment.row, col: match.start - segment.offset });
    }
  }
  return hits;
}
