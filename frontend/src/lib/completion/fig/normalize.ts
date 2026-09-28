// fig spec 归一化（Lane C）：上游 withfig/autocomplete spec 对象 → FigSpecRoot
// 纯数据形态（docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md §4）。
//
// 输入是 node type-stripping 直接 import 上游 `src/<name>.ts` 得到的默认导出
// （宽松对象，含函数/模板等动态指令）；本模块是纯函数、零依赖，
// scripts/sync_fig_specs.mjs（build-time）与单测（离线 fixture）共用。
//
// 归一化规则：
// - Option.name: string | string[] → names: string[]（`--`/`-` 前缀原样保留，
//   aliases 并入 names）；
// - 函数型字段一律丢弃：generator 只留 {kind:"script", script} 声明，
//   postProcess / template-only generator / 函数 suggestions 全部丢弃；
// - loadSpec / generateSpec 指令 → 保留原节点并记 generators: [] 空数组标记
//   （子命令树动态生成，wave 1 未展开，wave 3 处理）；
// - 别名数组保留；args 保留完整有序链（isOptional / isVariadic 原样标记）；
// - 子命令树不截深度（legacy 的两层限制不适用于 fig 路线）。
//
// 序列化确定性：对象按固定键序构建，同输入必产出逐字节相同的 JSON
// （sync 幂等依赖此性质）。

import type {
  FigArg,
  FigGeneratorDecl,
  FigOption,
  FigSpecRoot,
  FigSubcommand,
} from "./types";

// ---------------------------------------------------------------------------
// 上游宽松输入形状（仅作文档；实际窄化全部走运行时判断）
// ---------------------------------------------------------------------------

export type FigUpstreamNode = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 基础窄化
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is FigUpstreamNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 布尔标记只存 true（缺省即 false，减小 snapshot 体积）。 */
function asTrueFlag(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** name 字段归一：string → [name]；string[] → 原样；其它 → undefined。 */
function asNameList(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.length > 0 ? [value] : undefined;
  const list = asArray(value);
  if (!list) return undefined;
  const names = list.filter((item): item is string => typeof item === "string" && item.length > 0);
  return names.length ? names : undefined;
}

/** aliases 字段：string[]（逐项过滤非字符串）。 */
function asAliasList(value: unknown): string[] | undefined {
  const list = asArray(value);
  if (!list) return undefined;
  const aliases = list.filter((item): item is string => typeof item === "string" && item.length > 0);
  return aliases.length ? aliases : undefined;
}

// ---------------------------------------------------------------------------
// generator / suggestions 归一（§3：只留脚本声明，函数全丢）
// ---------------------------------------------------------------------------

/**
 * generator 集合归一：单个或数组里只保留含字符串 script 的对象声明
 * （script: string 包一层数组）；函数型 / template-only generator 丢弃。
 */
function normalizeGenerators(value: unknown): FigGeneratorDecl[] | undefined {
  const list = Array.isArray(value) ? value : [value];
  const decls: FigGeneratorDecl[] = [];
  for (const raw of list) {
    if (!isPlainObject(raw)) continue; // 函数 / 字符串等非对象形态丢弃
    const script = raw.script;
    const scriptList =
      typeof script === "string" ? [script] : asArray(script)?.filter((s): s is string => typeof s === "string") ?? [];
    if (!scriptList.length) continue; // 无脚本（template-only / 纯 postProcess）丢弃
    const splitOn = asString(raw.splitOn);
    decls.push(splitOn ? { kind: "script", script: scriptList, splitOn } : { kind: "script", script: scriptList });
  }
  return decls.length ? decls : undefined;
}

/**
 * suggestions 归一：string 直收；{name} 对象投影 name（description 丢弃——
 * §3 归一形态的 suggestions 是 string[]）；函数 / 其它形态丢弃（undefined）。
 */
function normalizeSuggestions(value: unknown): string[] | undefined {
  if (typeof value === "function") return undefined;
  const list = asArray(value);
  if (!list) return typeof value === "string" ? [value] : undefined;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (item.length > 0) out.push(item);
    } else if (isPlainObject(item)) {
      const name = asString(item.name);
      if (name) out.push(name);
    }
  }
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Arg / Option / Subcommand / Root 归一
// ---------------------------------------------------------------------------

function normalizeArg(raw: unknown): FigArg | null {
  if (!isPlainObject(raw)) return null;
  const arg: FigArg = {};
  const name = asString(raw.name);
  if (name) arg.name = name;
  const description = asString(raw.description);
  if (description) arg.description = description;
  const isVariadic = asTrueFlag(raw.isVariadic);
  if (isVariadic !== undefined) arg.isVariadic = isVariadic;
  const isOptional = asTrueFlag(raw.isOptional);
  if (isOptional !== undefined) arg.isOptional = isOptional;
  const suggestions = normalizeSuggestions(raw.suggestions);
  if (suggestions) arg.suggestions = suggestions;
  const generators = normalizeGenerators(raw.generators);
  if (generators) arg.generators = generators;
  return Object.keys(arg).length ? arg : null;
}

/**
 * Option 的 args 归一：上游允许 `true`（无名占位）/ Arg 对象 / Arg 数组。
 * 归一形态是单值（FigOption.args?: FigArg | null）：true → {}（无名占位）；
 * 数组取首个有效项。
 */
function normalizeOptionArgs(raw: unknown): FigArg | null {
  if (raw === true) return {};
  if (asArray(raw)) {
    for (const item of raw as unknown[]) {
      const arg = normalizeArg(item);
      if (arg) return arg;
    }
    return null;
  }
  return normalizeArg(raw);
}

function normalizeOption(raw: unknown): FigOption | null {
  if (!isPlainObject(raw)) return null;
  const names = [...(asNameList(raw.name) ?? []), ...(asAliasList(raw.aliases) ?? [])];
  if (!names.length) return null;
  const option: FigOption = { names };
  const description = asString(raw.description);
  if (description) option.description = description;
  if (raw.args !== undefined && raw.args !== null && raw.args !== false) {
    const args = normalizeOptionArgs(raw.args);
    if (args) option.args = args;
  }
  const isRepeatable = asTrueFlag(raw.isRepeatable);
  if (isRepeatable !== undefined) option.isRepeatable = isRepeatable;
  const isPersistent = asTrueFlag(raw.isPersistent);
  if (isPersistent !== undefined) option.isPersistent = isPersistent;
  const isRequired = asTrueFlag(raw.isRequired);
  if (isRequired !== undefined) option.isRequired = isRequired;
  return option;
}

function normalizeSubcommand(raw: unknown): FigSubcommand | null {
  if (!isPlainObject(raw)) return null;
  const names = asNameList(raw.name);
  if (!names?.length) return null;
  const [name, ...nameAliases] = names;
  const subcommand: FigSubcommand = { name };
  const aliases = dedupeStrings([...nameAliases, ...(asAliasList(raw.aliases) ?? [])]);
  if (aliases.length) subcommand.aliases = aliases;
  const description = asString(raw.description);
  if (description) subcommand.description = description;

  const subcommands = (asArray(raw.subcommands) ?? [])
    .map(normalizeSubcommand)
    .filter((sub): sub is FigSubcommand => sub !== null);
  if (subcommands.length) subcommand.subcommands = subcommands;

  const options = (asArray(raw.options) ?? [])
    .map(normalizeOption)
    .filter((option): option is FigOption => option !== null);
  if (options.length) subcommand.options = options;

  const args = (asArray(raw.args) ?? [raw.args])
    .map(normalizeArg)
    .filter((arg): arg is FigArg => arg !== null);
  if (args.length) subcommand.args = args;

  // loadSpec / generateSpec：动态子命令树指令——保留原节点 + 空 generators 标记。
  if ((raw.loadSpec !== undefined && raw.loadSpec !== null) || (raw.generateSpec !== undefined && raw.generateSpec !== null)) {
    subcommand.generators = [];
  }
  return subcommand;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * 上游 spec 根对象 → FigSpecRoot。无效输入（无可用 name）返回 null，
 * 由调用方（sync 脚本 / 测试）决定记 skipped 还是断言失败。
 */
export function normalizeFigSpec(raw: unknown): FigSpecRoot | null {
  if (!isPlainObject(raw)) return null;
  const names = asNameList(raw.name);
  if (!names?.length) return null;
  const [name, ...nameAliases] = names;
  const root: FigSpecRoot = { name };
  const aliases = dedupeStrings([...nameAliases, ...(asAliasList(raw.aliases) ?? [])]);
  if (aliases.length) root.aliases = aliases;
  const description = asString(raw.description);
  if (description) root.description = description;

  const subcommands = (asArray(raw.subcommands) ?? [])
    .map(normalizeSubcommand)
    .filter((sub): sub is FigSubcommand => sub !== null);
  if (subcommands.length) root.subcommands = subcommands;

  const options = (asArray(raw.options) ?? [])
    .map(normalizeOption)
    .filter((option): option is FigOption => option !== null);
  if (options.length) root.options = options;

  const args = (asArray(raw.args) ?? [raw.args])
    .map(normalizeArg)
    .filter((arg): arg is FigArg => arg !== null);
  if (args.length) root.args = args;

  return root;
}
