// 结构化命令补全（对标 Warp/fig）：按「命令 → 子命令 → flag → 值」层级给出
// 带 description 的下拉候选。schema 是 fig completion spec 思路的裁剪子集：
// 纯静态数据 + 纯函数，不引入 AI、不引入运行时依赖、不做远端枚举（分支/文件
// 等动态值仅出提示行，见 hint 行说明）。
//
// 三层判定（与 App.vue 建议浮层共用 pendingTerminalInput 行缓冲）：
//   git ch          → sub 层：checkout / cherry-pick（带 description）
//   git checkout -  → flag 层：-b / --branch / …
//   kubectl get -o  → value 层：json / yaml / wide（flag 的静态枚举值）
//
// 导出面：splitCommandLine（token 切分）、matchSpecLine（层级匹配 + 前缀过滤
// + 评分排序）。全部纯函数；CompletionMenu.vue 与 App.vue 只做渲染与键盘。

// ---------------------------------------------------------------------------
// schema：spec 数据的最小子集
// ---------------------------------------------------------------------------

/** flag 定义（对标 fig 的 option）：name 不含前导连字符。 */
export interface CompletionFlagSpec {
  /** 长名，如 "verbose"（展示为 --verbose）。 */
  name: string;
  /** 短名，如 "v"（展示为 -v；只作别名，不单独建行——见 flagRows）。 */
  short?: string;
  description: string;
  /** flag 带值时的占位名（如 "format"）；声明即表示该 flag 消费一个值 token。 */
  arg?: string;
  /** flag 值的静态候选枚举（如 --output 的 json|yaml|wide）。 */
  values?: readonly string[];
}

/** 位置参数（对标 fig 的 args）：静态枚举值或动态占位提示。 */
export interface CompletionPositionalSpec {
  /** 占位名，如 "branch"、"file"。 */
  name: string;
  /** 静态候选值（可枚举时给出）。 */
  values?: readonly string[];
  /** 动态值（分支名/文件名等本地不可枚举）：仅出一条 hint 提示行。 */
  dynamic?: boolean;
}

/** 命令 / 子命令节点（根命令与子命令同构，最多两层子命令树）。 */
export interface SpecCommand {
  name: string;
  description: string;
  subcommands?: readonly SpecCommand[];
  flags?: readonly CompletionFlagSpec[];
  positional?: CompletionPositionalSpec;
}

/** 一批命令的 spec 数据（specs/*.ts 每文件导出一个，index.ts 聚合）。 */
export type CompletionSpecs = readonly SpecCommand[];

// ---------------------------------------------------------------------------
// 匹配结果
// ---------------------------------------------------------------------------

export type CompletionRowKind = "sub" | "flag" | "value" | "hint";
export type CompletionLevel = "sub" | "flag" | "value";

export interface CompletionRow {
  kind: CompletionRowKind;
  /** 当前 token 接受后的完整替换文本；hint 行为空串（不可填充）。 */
  token: string;
  /** 接受后是否补一个空格进入下一层。 */
  space: boolean;
  /** 展示主文本（含连字符/等号形态）。 */
  label: string;
  description: string;
  /** 评分排序用，越大越靠前（同分按 label 字典序）。 */
  score: number;
}

export interface SpecMatch {
  /** 解析到的命令节点路径，如 ["git", "checkout"]。 */
  commandPath: string[];
  level: CompletionLevel;
  rows: CompletionRow[];
}

export const SPEC_COMPLETION_MAX_ROWS = 20;

// ---------------------------------------------------------------------------
// token 切分：引号 / 转义 / 尾空格
// ---------------------------------------------------------------------------

export interface CommandToken {
  /** 语义内容（引号已剥、转义已解）。 */
  text: string;
  /** 是否 flag token（以 - 开头、非裸 "--"、且未被 -- 终结符关闭）。 */
  isFlag: boolean;
  /** token 是否整体（或部分）处于引号内——引号内空格不切分。 */
  quoted: boolean;
  /** 裸 "--" 终结符：本身不参与候选，仅对后续 token 关闭 flag 解析。 */
  terminator: boolean;
}

export interface SplitCommandLineResult {
  tokens: CommandToken[];
  /** 行尾是裸空白（引号外）：当前正在敲一个空 token。 */
  trailingSpace: boolean;
  /** 已出现裸 "--" 终结符：其后 token 一律不算 flag。 */
  terminated: boolean;
}

/**
 * 切分命令行：空白分隔；单引号内全字面；双引号与引号外支持反斜杠转义；
 * 空 token 只有显式 `''` 会产生（裸尾空格用 trailingSpace 表达）。
 */
export function splitCommandLine(line: string): SplitCommandLineResult {
  const tokens: CommandToken[] = [];
  let current: { text: string; quoted: boolean } | null = null;
  let trailingSpace = false;
  let terminated = false;

  const pushCurrent = () => {
    if (!current) return;
    // 裸 "--" 是 flag 终结符：保留为 terminator 标记 token（可能是正在敲的
    // 半截 token，如 `git checkout --`——此时仍要按 flag 层出候选），仅对
    // 之后的 token 关闭 flag 解析。
    if (current.text === "--" && !current.quoted && !terminated) {
      tokens.push({ text: current.text, isFlag: false, quoted: false, terminator: true });
      terminated = true;
    } else {
      tokens.push({ text: current.text, isFlag: !terminated && current.text.startsWith("-") && current.text !== "-", quoted: current.quoted, terminator: false });
    }
    current = null;
  };

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const char of line) {
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current ??= { text: "", quoted: false };
        current.text += char;
        current.quoted = true;
      }
      continue;
    }
    if (escaped) {
      current ??= { text: "", quoted: false };
      current.text += char;
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        escaped = true;
        current ??= { text: "", quoted: false };
        current.quoted = true;
      } else if (char === '"') {
        inDouble = false;
        if (current) current.quoted = true;
      } else if (char === " " || char === "\t") {
        current ??= { text: "", quoted: false };
        current.text += char;
        current.quoted = true;
      } else {
        current ??= { text: "", quoted: false };
        current.text += char;
      }
      continue;
    }
    if (char === "'") {
      current ??= { text: "", quoted: false };
      current.quoted = true;
      inSingle = true;
      continue;
    }
    if (char === '"') {
      current ??= { text: "", quoted: false };
      current.quoted = true;
      inDouble = true;
      continue;
    }
    if (char === "\\") {
      current ??= { text: "", quoted: false };
      escaped = true;
      continue;
    }
    if (char === " " || char === "\t") {
      pushCurrent();
      trailingSpace = true;
      continue;
    }
    current ??= { text: "", quoted: false };
    current.text += char;
    trailingSpace = false;
  }
  if (escaped) {
    // 行尾悬空反斜杠：按字面量保留，避免吞 token。
    current ??= { text: "", quoted: false };
    current.text += "\\";
  }
  pushCurrent();
  return { tokens, trailingSpace, terminated };
}

// ---------------------------------------------------------------------------
// 层级匹配
// ---------------------------------------------------------------------------

const SCORE_EXACT = 100;
const SCORE_PREFIX_BASE = 60;
const SCORE_PREFIX_PENALTY_MAX = 24;
const SCORE_KIND_SUB = 10;
const SCORE_KIND_FLAG = 6;
const SCORE_KIND_VALUE = 2;
const SCORE_KIND_HINT = 0;

function kindScore(kind: CompletionRowKind): number {
  if (kind === "sub") return SCORE_KIND_SUB;
  if (kind === "flag") return SCORE_KIND_FLAG;
  if (kind === "value") return SCORE_KIND_VALUE;
  return SCORE_KIND_HINT;
}

/** 前缀过滤 + 评分：精确命中 > 前缀命中（前缀越短加分越高）；未命中返回 null。 */
function scoreCandidate(prefix: string, name: string, kind: CompletionRowKind): number | null {
  const lowerPrefix = prefix.toLowerCase();
  const lowerName = name.toLowerCase();
  if (!lowerPrefix) return SCORE_PREFIX_BASE + kindScore(kind);
  if (lowerName === lowerPrefix) return SCORE_EXACT + kindScore(kind);
  if (lowerName.startsWith(lowerPrefix)) {
    return SCORE_PREFIX_BASE - Math.min(SCORE_PREFIX_PENALTY_MAX, lowerPrefix.length) + kindScore(kind);
  }
  return null;
}

interface FlagRequest {
  flag: CompletionFlagSpec;
  /** 值已内联（--format=json）：不再把该 flag 记作“等待值”。 */
  valueInline: boolean;
}

function findFlag(command: SpecCommand, name: string): CompletionFlagSpec | undefined {
  return command.flags?.find((flag) => flag.name === name || (flag.short !== undefined && flag.short === name));
}

/** 子命令树精确下钻：只按名字精确匹配（子命令不做前缀展开，展开只发生在候选层）。 */
function descend(command: SpecCommand, name: string): SpecCommand | undefined {
  return command.subcommands?.find((sub) => sub.name === name);
}

/**
 * 把当前行解析为候选上下文。返回 null 表示没有 spec 命中（调用方回落历史
 * 建议浮层）；rows 为空数组表示 spec 命中但本层无可枚举候选（同样回落）。
 */
export function matchSpecLine(line: string, specs: CompletionSpecs): SpecMatch | null {
  const { tokens, trailingSpace } = splitCommandLine(line);

  // 当前正在敲的 token：尾空格（或空行）= 空前缀。
  const partial = trailingSpace ? "" : (tokens[tokens.length - 1]?.text ?? "");
  const completeTokens = trailingSpace ? tokens : tokens.slice(0, -1);

  // 根命令尚未敲完（无完整 token 且非 flag）：对根名做前缀匹配（`gi` → git）。
  const first = completeTokens[0];
  if (!first) {
    if (!partial || partial.startsWith("-")) return null;
    return { commandPath: [], level: "sub", rows: rootRows(specs, partial) };
  }
  if (first.isFlag) return null;
  const root = specs.find((spec) => spec.name === first.text);
  if (!root) return null;

  let command: SpecCommand = root;
  const commandPath: string[] = [root.name];
  /** 上一层是“等待值”的 flag：当前（空/值）token 属于 value 层。 */
  let pendingValueFlag: CompletionFlagSpec | null = null;
  /** 位置参数是否已被占用（静态候选只提示第一个位置）。 */
  let positionalFilled = false;
  /** 完整 token 里已出现裸 "--"：其后不再按 flag 解析。 */
  let terminated = false;

  for (let i = 1; i < completeTokens.length; i += 1) {
    const token = completeTokens[i];
    if (token.terminator) {
      terminated = true;
      pendingValueFlag = null;
      continue;
    }
    if (token.isFlag) {
      pendingValueFlag = null;
      // --name=value：值已内联；--name：若带 arg 则下一个 token 是它的值。
      const equals = token.text.indexOf("=");
      const bare = equals === -1 ? token.text : token.text.slice(0, equals);
      const bareName = bare.replace(/^-{1,2}/, "");
      const flag = findFlag(command, bareName);
      if (!flag) {
        pendingValueFlag = null;
        continue;
      }
      if (equals !== -1) {
        pendingValueFlag = null;
      } else if (flag.arg !== undefined) {
        pendingValueFlag = flag;
      }
      continue;
    }
    // 位置 token：优先给等待值的 flag 收值；否则尝试子命令下钻。
    if (pendingValueFlag) {
      pendingValueFlag = null;
      continue;
    }
    const sub = descend(command, token.text);
    if (sub) {
      command = sub;
      commandPath.push(sub.name);
      continue;
    }
    positionalFilled = true;
  }

  // ---- 判定当前层并生成候选 ----
  // flag 层：当前 token 以 - 开头（且未越过 -- 终结符）。
  if (!terminated && partial.startsWith("-")) {
    // --name=val 形态 → value 层（前缀取 = 后半段）。
    const equals = partial.indexOf("=");
    if (equals !== -1) {
      const typedFlagPrefix = partial.slice(0, equals);
      const bareName = typedFlagPrefix.replace(/^-{1,2}/, "");
      const flag = findFlag(command, bareName);
      const valuePrefix = partial.slice(equals + 1);
      if (flag) {
        return { commandPath, level: "value", rows: valueRows(flag, valuePrefix, typedFlagPrefix) };
      }
      return { commandPath, level: "value", rows: [] };
    }
    return { commandPath, level: "flag", rows: flagRows(command, partial) };
  }
  // value 层：上一个完整 token 是等待值的 flag（如 `kubectl get -o `）。
  if (pendingValueFlag) {
    return { commandPath, level: "value", rows: valueRows(pendingValueFlag, partial, "") };
  }
  // sub 层：子命令 + 位置参数候选（-- 终结符之后不再拿 flags 兜底）。
  return { commandPath, level: "sub", rows: terminated ? subRows(command, partial, positionalFilled, false) : subRows(command, partial, positionalFilled, true) };
}

/** flag 候选：长名行 + （当前前缀恰为某短名时的短名行）；`--` 与 `-` 全量展开。 */
function flagRows(command: SpecCommand, partial: string): CompletionRow[] {
  const flags = command.flags ?? [];
  if (!flags.length) return [];
  // 前缀剥掉前导连字符后参与匹配；单连字符 + 恰为某已知短名 → 只出短名行。
  const stripped = partial.replace(/^-+/, "");
  const wantShortForm = !partial.startsWith("--") && flags.some((flag) => flag.short !== undefined && flag.short === stripped);

  const rows: CompletionRow[] = [];
  for (const flag of flags) {
    if (wantShortForm) {
      if (flag.short === undefined || flag.short !== stripped) continue;
      rows.push({
        kind: "flag",
        token: `-${flag.short}${flag.arg !== undefined ? " " : ""}`.trimEnd(),
        space: flag.arg === undefined,
        label: `-${flag.short}`,
        description: flag.arg !== undefined ? `${flag.description} <${flag.arg}>` : flag.description,
        score: SCORE_EXACT + SCORE_KIND_FLAG,
      });
      continue;
    }
    const score = scoreCandidate(stripped, flag.name, "flag");
    if (score === null) continue;
    const valueSuffix = flag.arg !== undefined ? ` <${flag.arg}>` : "";
    rows.push({
      kind: "flag",
      token: `--${flag.name}`,
      space: flag.arg === undefined,
      label: `--${flag.name}${valueSuffix}`,
      description: flag.short !== undefined ? `${flag.description} (-${flag.short})` : flag.description,
      score,
    });
  }
  return rankRows(rows);
}

/** 根命令前缀候选（`gi` → git）：只对根名做前缀过滤。 */
function rootRows(specs: CompletionSpecs, prefix: string): CompletionRow[] {
  const rows: CompletionRow[] = [];
  for (const spec of specs) {
    const score = scoreCandidate(prefix, spec.name, "sub");
    if (score === null) continue;
    rows.push({ kind: "sub", token: spec.name, space: true, label: spec.name, description: spec.description, score });
  }
  return rankRows(rows);
}

/**
 * flag 值候选：静态枚举按前缀过滤；`inlinePrefix` 非空表示值内联在
 * `--flag=…` 里（候选 token 要整体替换当前 token），空串表示值是独立 token。
 * 无枚举时给一条 arg 占位 hint 行。
 */
function valueRows(flag: CompletionFlagSpec, prefix: string, inlinePrefix: string): CompletionRow[] {
  const rows: CompletionRow[] = [];
  for (const value of flag.values ?? []) {
    const score = scoreCandidate(prefix, value, "value");
    if (score === null) continue;
    rows.push({
      kind: "value",
      token: inlinePrefix ? `${inlinePrefix}=${value}` : value,
      space: true,
      label: value,
      description: flag.description,
      score,
    });
  }
  if (!rows.length && flag.arg !== undefined && !flag.values?.length) {
    rows.push({ kind: "hint", token: "", space: false, label: `<${flag.arg}>`, description: flag.description, score: SCORE_KIND_HINT });
  }
  return rankRows(rows);
}

/** sub 层候选：子命令 → 位置参数静态值 → 动态占位 hint（仅首位置）；allowFlagFallback 控制空候选时是否拿 flags 兜底。 */
function subRows(command: SpecCommand, prefix: string, positionalFilled: boolean, allowFlagFallback: boolean): CompletionRow[] {
  const rows: CompletionRow[] = [];
  for (const sub of command.subcommands ?? []) {
    const score = scoreCandidate(prefix, sub.name, "sub");
    if (score === null) continue;
    rows.push({ kind: "sub", token: sub.name, space: true, label: sub.name, description: sub.description, score });
  }
  const positional = command.positional;
  if (positional && !positionalFilled) {
    for (const value of positional.values ?? []) {
      const score = scoreCandidate(prefix, value, "value");
      if (score === null) continue;
      rows.push({ kind: "value", token: value, space: true, label: value, description: `${positional.name} — ${command.name}`, score });
    }
    if (positional.dynamic && !positional.values?.length) {
      const score = scoreCandidate(prefix, positional.name, "hint");
      if (score !== null) {
        rows.push({ kind: "hint", token: "", space: false, label: `<${positional.name}>`, description: command.description, score });
      }
    }
  }
  // 无子命令也无位置候选时，sub 层把 flags 作为兜底候选（如 `git commit `）。
  if (!rows.length && allowFlagFallback && command.flags?.length) {
    return flagRows(command, "");
  }
  return rankRows(rows);
}

/** 评分降序，同分按 label 字典序（确定序），超量截断。 */
function rankRows(rows: CompletionRow[]): CompletionRow[] {
  return rows
    .sort((a, b) => (b.score - a.score) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, SPEC_COMPLETION_MAX_ROWS);
}
