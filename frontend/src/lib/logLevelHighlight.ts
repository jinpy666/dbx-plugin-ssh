// SFTP 文件预览的日志级别智能高亮（issue #224 第 2 条）。
//
// 背景：.log/.out/.err 这类纯文本日志没有任何语法（CodeMirror 语言包不认），
// TextPreview 里整篇都是默认前景色，INFO/WARN/ERROR 视觉上无法分层，排障低效。
// 本模块提供：
// 1. 纯函数 `classifyLogLevelLine` / `classifyLogLines`：按行首级别词分类
//    （行首空白容忍、大小写不敏感、必须整词），堆栈续行（空白开头且无级别
//    标记）继承上一非空行级别；
// 2. `isLogFileName`：按扩展名（.log/.out/.err，大小写不敏感）判定"日志文件"；
// 3. `logLevelHighlightExtension`：CodeMirror 6 装饰扩展——命中行整行
//    `Decoration.line` 按级别着色（error 红调 / warn 黄调 / debug 暗淡 /
//    info 微强调，明暗两套），行内 ERROR/FATAL 词用 `Decoration.mark` 加重。
//
// 接线：TextPreview.vue 仅在 `isLogFileName(props.fileName)` 时把扩展加入
// extensions；fileName 变化经既有 watch → createEditor 重建自然生效。
// 约束：不新增运行时依赖（@codemirror/view/state 均为 frontend 既有直接依赖）；
// 颜色用内联 style 的固定明暗调色板（与 shared/frontend/editorTheme 同源观感，
// 不依赖宿主 tokens），非日志文件行为与升级前完全一致。

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Extension, Range, Text } from "@codemirror/state";

/** 日志级别（error/warn 合并同色系；debug/trace、info/notice 两两同组）。 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** 宿主明暗色系（与 DbxPluginAppearance.colorScheme 同形状，避免依赖全局声明）。 */
export type LogHighlightColorScheme = "light" | "dark";

/**
 * 行首级别词匹配：`^\s*` 容忍行首空白（含 \t），大小写不敏感在取词后
 * 统一 toLowerCase；`(?![A-Za-z0-9_])` 保证整词——ERRORX、errors、
 * error2024、Informational 一律不算级别。取整词后再查表，避免 \b 对
 * WARNING 之类前缀词的误判歧义。
 */
const LEVEL_TOKEN_PATTERN = /^\s*([A-Za-z]+)(?![A-Za-z0-9_])/;

const LEVEL_BY_TOKEN: Readonly<Record<string, LogLevel>> = {
  error: "error",
  fatal: "error",
  warn: "warn",
  warning: "warn",
  debug: "debug",
  trace: "debug",
  info: "info",
  notice: "info",
};

/**
 * 单行级别分类（不含续行继承——需要上下文时用 `classifyLogLines`）：
 * ERROR/FATAL→error，WARN/WARNING→warn，DEBUG/TRACE→debug，
 * INFO/NOTICE→info，其余（含空行）→ null。
 */
export function classifyLogLevelLine(line: string): LogLevel | null {
  const match = LEVEL_TOKEN_PATTERN.exec(line);
  if (!match) return null;
  return LEVEL_BY_TOKEN[match[1].toLowerCase()] ?? null;
}

/** 行内关键级别词：只认大写整词 ERROR/FATAL，避免命中英文散文里的 error/fatal。 */
const ERROR_KEYWORD_PATTERN = /\b(?:ERROR|FATAL)\b/g;

/** 单行行内加重上限（防超长行正则回溯刷装饰）。 */
const MAX_MARKS_PER_LINE = 8;

/** 行内一个待加重的 ERROR/FATAL 词区间（相对行文本的绝对偏移，end exclusive）。 */
export interface LogLineMark {
  readonly start: number;
  readonly end: number;
}

/** `classifyLogLines` 的单行产物：级别（含续行继承后的）+ 行内加重区间。 */
export interface ClassifiedLogLine {
  readonly level: LogLevel | null;
  readonly marks: readonly LogLineMark[];
}

/**
 * 整篇日志逐行分类（装饰构建的唯一数据源，纯函数便于单测续行归属）：
 * - 行首有级别词 → 该级别，并刷新"最近非空行级别"；
 * - 空白开头、非空、无级别词 → 堆栈续行，继承最近非空行级别（Java/Python
 *   堆栈的 `\tat ...`、`  File "..."` 行随所属块同色）；
 * - 顶格无级别词的普通行 → null，并切断继承（新块开始）；
 * - 纯空白行 → 不装饰、不改变继承（日志块之间的空行不打断续行归属）。
 * 行内 ERROR/FATAL 词（大写整词）在任意行上都收集加重点位。
 */
export function classifyLogLines(lines: readonly string[]): ClassifiedLogLine[] {
  const out: ClassifiedLogLine[] = [];
  let inherited: LogLevel | null = null;
  for (const line of lines) {
    const own = classifyLogLevelLine(line);
    const marks = collectErrorMarks(line, own);
    if (own) {
      inherited = own;
      out.push({ level: own, marks });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0 && /^\s/.test(line)) {
      out.push({ level: inherited, marks });
      continue;
    }
    if (trimmed.length > 0) inherited = null;
    out.push({ level: null, marks });
  }
  return out;
}

/** 收集一行的加重区间：error 行的行首级别词（任意大小写）+ 全行大写 ERROR/FATAL 整词。 */
function collectErrorMarks(line: string, own: LogLevel | null): LogLineMark[] {
  const marks: LogLineMark[] = [];
  if (own === "error") {
    const match = LEVEL_TOKEN_PATTERN.exec(line);
    if (match) marks.push({ start: match[0].length - match[1].length, end: match[0].length });
  }
  ERROR_KEYWORD_PATTERN.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = ERROR_KEYWORD_PATTERN.exec(line)) !== null) {
    const start = hit.index;
    const end = start + hit[0].length;
    // 与行首词重叠（如行首恰为大写 ERROR）时先到先得，不重复加成。
    if (!marks.some((mark) => start < mark.end && end > mark.start)) marks.push({ start, end });
    if (marks.length >= MAX_MARKS_PER_LINE) break;
  }
  return marks;
}

/**
 * 判定文件名是否按"日志文件"启用级别高亮：.log/.out/.err 后缀，大小写不敏感。
 * 无扩展名（applog、logfile）与纯隐藏名（".log" 无主名）不算；带路径时取
 * 末段（兼容 / 与 \），"app.log.1" 这类多段后缀只认最后一段，故不算。
 */
export function isLogFileName(fileName: string): boolean {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = base.slice(dot + 1).toLowerCase();
  return extension === "log" || extension === "out" || extension === "err";
}

// ---- 明暗两套调色板（内联 style；参照 GitHub 系，与 shared/editorTheme 观感一致）----
// error：红调；warn：黄调；debug/trace：暗淡灰（弱于正文）；info：默认前景 + 极淡蓝底（微强调）。

const LINE_STYLES: Record<LogHighlightColorScheme, Record<LogLevel, string>> = {
  light: {
    error: "background-color: rgba(164, 14, 38, 0.08); color: #a40e26;",
    warn: "background-color: rgba(154, 103, 0, 0.12); color: #7a5200;",
    info: "background-color: rgba(9, 105, 218, 0.05);",
    debug: "color: #6e7781;",
  },
  dark: {
    error: "background-color: rgba(248, 81, 73, 0.14); color: #ff8b85;",
    warn: "background-color: rgba(187, 128, 9, 0.16); color: #e3b341;",
    info: "background-color: rgba(56, 139, 253, 0.09);",
    debug: "color: #8b949e;",
  },
};

/** ERROR/FATAL 词加重：同色相再加深 + 加粗（比整行底色更醒目一档）。 */
const MARK_STYLES: Record<LogHighlightColorScheme, string> = {
  light: "color: #82071a; font-weight: 600; background-color: rgba(164, 14, 38, 0.14);",
  dark: "color: #ffa198; font-weight: 600; background-color: rgba(248, 81, 73, 0.24);",
};

/** 装饰扩展：日志文件按级别整行着色 + 行内 ERROR/FATAL 词加重。
 * appearance（colorScheme）变化经 TextPreview 既有 watch 重建编辑器自然生效；
 * 文档变化（预览内编辑/整篇替换）按 docChanged 全量重算。 */
export function logLevelHighlightExtension(colorScheme: LogHighlightColorScheme): Extension {
  const lineStyles = LINE_STYLES[colorScheme];
  const markStyle = MARK_STYLES[colorScheme];
  return ViewPlugin.fromClass(
    class LogLevelHighlightPlugin {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLogDecorations(view.state.doc, lineStyles, markStyle);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = buildLogDecorations(update.state.doc, lineStyles, markStyle);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

function buildLogDecorations(doc: Text, lineStyles: Record<LogLevel, string>, markStyle: string): DecorationSet {
  const lines: string[] = new Array(doc.lines);
  for (let i = 1; i <= doc.lines; i += 1) lines[i - 1] = doc.line(i).text;
  const classified = classifyLogLines(lines);
  const ranges: Array<Range<Decoration>> = [];
  for (let i = 0; i < classified.length; i += 1) {
    const entry = classified[i];
    const line = doc.line(i + 1);
    if (entry.level) {
      ranges.push(Decoration.line({ attributes: { style: lineStyles[entry.level] } }).range(line.from));
    }
    for (const mark of entry.marks) {
      if (mark.end <= mark.start || mark.end > line.text.length) continue;
      ranges.push(
        Decoration.mark({ attributes: { style: markStyle } }).range(line.from + mark.start, line.from + mark.end),
      );
    }
  }
  // 逐行按序生成即天然满足 RangeSet 有序性：行位置递增；同一行内
  // Decoration.line 先于同位置 mark（line 装饰 side 极负），mark 区间互不重叠
  // 且升序，故可直接以 sorted=true 交给 Decoration.set。
  return Decoration.set(ranges, true);
}
