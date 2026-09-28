// fig spec 静态 adapter（Lane C）：归一化 FigSpecRoot × 当前命令行 →
// CompletionItem[]（docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md §5）。
//
// 纯函数、零新依赖；token 切分复用 legacy parser 的 splitCommandLine
//（lib/completions/spec.ts，只读 import，不改语义）。能力必须超出 legacy：
// 别名命中（git co → checkout）、persistent option 沿子命令树下传、variadic
// args（多个位置 token 持续补）、repeatable option 不因已出现而消失、子命令树
// 无深度限制、`--` 终结、`--flag=value` 内联值层。
//
// edit 采用与 legacy adapter 相同的行尾 token 边界语义
//（replaceStart/replaceEnd 来自 parser 的精确表面范围）；source 固定
// "fig-spec"；无命中返回 null（调用方回落 legacy → 历史，方案 §35）。

import type { CompletionContext, CompletionItem, CompletionItemKind } from "../core/types";
import type { FigArg, FigOption, FigSpecRoot, FigSubcommand } from "./types";
import { splitCommandLine } from "../../completions/spec";

export interface FigResolveResult {
  items: CompletionItem[];
  context: CompletionContext;
}

/** 与 legacy（SPEC_COMPLETION_MAX_ROWS）对齐的候选上限。 */
export const FIG_MAX_ITEMS = 20;

const SCORE_EXACT = 100;
const SCORE_PREFIX_BASE = 60;
const SCORE_PREFIX_PENALTY_MAX = 24;

type AnyNode = FigSpecRoot | FigSubcommand;

// ---------------------------------------------------------------------------
// 评分（口径与 legacy spec.ts 一致：精确 > 前缀；同分按 label 字典序）
// ---------------------------------------------------------------------------

function kindScore(kind: CompletionItemKind): number {
  if (kind === "subcommand" || kind === "command") return 10;
  if (kind === "option") return 6;
  if (kind === "argument") return 2;
  return 0; // hint
}

function scoreCandidate(prefix: string, candidate: string, kind: CompletionItemKind): number | null {
  const lowerPrefix = prefix.toLowerCase();
  const lowerName = candidate.toLowerCase();
  if (!lowerPrefix) return SCORE_PREFIX_BASE + kindScore(kind);
  if (lowerName === lowerPrefix) return SCORE_EXACT + kindScore(kind);
  if (lowerName.startsWith(lowerPrefix)) {
    return SCORE_PREFIX_BASE - Math.min(SCORE_PREFIX_PENALTY_MAX, lowerPrefix.length) + kindScore(kind);
  }
  return null;
}

function rankItems(items: CompletionItem[]): CompletionItem[] {
  return items
    .sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, FIG_MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// 节点工具：option 池 / 子命令下钻（含别名）
// ---------------------------------------------------------------------------

function nodeSubcommands(node: AnyNode): FigSubcommand[] {
  return node.subcommands ?? [];
}

function nodeOptions(node: AnyNode): FigOption[] {
  return node.options ?? [];
}

function nodeArgs(node: AnyNode): FigArg[] {
  return node.args ?? [];
}

/**
 * option 池：当前节点自身 options + 祖先链上 isPersistent 的 options
 * （innermost 优先；root 的非 persistent option 不下传）。
 */
function collectOptionPool(chain: AnyNode[]): FigOption[] {
  const pool: FigOption[] = [];
  const seen = new Set<FigOption>();
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    for (const option of nodeOptions(chain[i])) {
      if (i < chain.length - 1 && !option.isPersistent) continue;
      if (seen.has(option)) continue;
      seen.add(option);
      pool.push(option);
    }
  }
  return pool;
}

/** surface（用户敲的 flag 面，如 `--branch` / `-b`）→ 命中的 option。 */
function findOptionBySurface(pool: readonly FigOption[], surface: string): FigOption | undefined {
  const stripped = surface.replace(/^-+/, "");
  for (const option of pool) {
    for (const name of option.names) {
      if (name === surface || name.replace(/^-+/, "") === stripped) return option;
    }
  }
  return undefined;
}

/** 子命令下钻：名字或别名精确命中（前缀展开只发生在候选层，不发生在下钻层）。 */
function descendByToken(node: AnyNode, token: string): FigSubcommand | undefined {
  return nodeSubcommands(node).find((sub) => sub.name === token || sub.aliases?.includes(token));
}

function argPlaceholder(arg: FigArg | null | undefined): string {
  return `<${arg?.name?.trim() || "value"}>`;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析一行命令，给出 fig spec 的静态候选。返回 null 表示无 spec 命中
 *（调用方回落 legacy → 历史）；items 语义上可再排序/过滤，id 前缀 "fig:"。
 */
export function resolveFigLine(line: string, specs: readonly FigSpecRoot[]): FigResolveResult | null {
  const { tokens, trailingSpace } = splitCommandLine(line);

  const partial = trailingSpace ? "" : (tokens[tokens.length - 1]?.text ?? "");
  const completeTokens = trailingSpace ? tokens : tokens.slice(0, -1);
  const partialToken = trailingSpace ? undefined : tokens[tokens.length - 1];
  const replaceStart = partialToken ? partialToken.start : line.length;
  const replaceEnd = partialToken ? partialToken.end : line.length;

  const buildContext = (commandPath: string[]): CompletionContext => ({
    command: commandPath[0] ?? null,
    commandPath,
    tokenStart: replaceStart,
    tokenEnd: replaceEnd,
  });

  const makeItem = (
    commandPath: string[],
    index: number,
    kind: CompletionItemKind,
    label: string,
    description: string | undefined,
    insert: string,
    score: number,
  ): CompletionItem => ({
    id: `fig:${commandPath.join(" ")}#${index}`,
    label,
    description,
    kind,
    score,
    source: "fig-spec",
    edit: { text: insert, replaceStart, replaceEnd },
  });

  // ---- 根命令前缀层（`gi` → git）：主名 + 别名均可命中，展示主名 ----
  const first = completeTokens[0];
  if (!first) {
    if (!partial || partial.startsWith("-")) return null;
    const items: CompletionItem[] = [];
    specs.forEach((spec, specIndex) => {
      const byName = scoreCandidate(partial, spec.name, "command");
      const byAlias = spec.aliases?.some((alias) => alias.toLowerCase() === partial.toLowerCase()) ?? false;
      const score = byName ?? (byAlias ? SCORE_EXACT + kindScore("command") : null);
      if (score === null) return;
      items.push(makeItem([], specIndex, "command", spec.name, spec.description, spec.name, score));
    });
    return items.length ? { items: rankItems(items), context: buildContext([]) } : null;
  }
  if (first.isFlag) return null;
  const root = specs.find((spec) => spec.name === first.text || spec.aliases?.includes(first.text));
  if (!root) return null;

  // ---- 完整 token 走树 ----
  let node: AnyNode = root;
  const chain: AnyNode[] = [root];
  const commandPath: string[] = [root.name];
  /** 上一个完整 token 是等待值的 option：当前（空/值）token 属于值层。 */
  let pendingValueOption: FigOption | null = null;
  /** 当前节点 args 的消费进度（variadic 停在该 arg 上不前进）。 */
  let positionalIndex = 0;
  /** 已完整使用过的 option（repeatable 不受影响，不因已出现而消失）。 */
  const usedOptions = new Set<FigOption>();
  /** 完整 token 里已出现裸 "--"：其后不再按 flag / 子命令解析。 */
  let terminated = false;

  for (let i = 1; i < completeTokens.length; i += 1) {
    const token = completeTokens[i];
    if (token.terminator) {
      terminated = true;
      pendingValueOption = null;
      continue;
    }
    if (token.isFlag && !terminated) {
      pendingValueOption = null;
      const equals = token.text.indexOf("=");
      const bare = equals === -1 ? token.text : token.text.slice(0, equals);
      const option = findOptionBySurface(collectOptionPool(chain), bare);
      if (!option) continue;
      usedOptions.add(option);
      if (equals === -1 && option.args) pendingValueOption = option;
      continue;
    }
    if (pendingValueOption) {
      pendingValueOption = null;
      continue;
    }
    if (!terminated && positionalIndex === 0) {
      const sub = descendByToken(node, token.text);
      if (sub) {
        node = sub;
        chain.push(sub);
        commandPath.push(sub.name);
        positionalIndex = 0;
        continue;
      }
    }
    const args = nodeArgs(node);
    const arg = args[positionalIndex];
    if (!arg?.isVariadic) positionalIndex += 1;
  }

  const optionPool = collectOptionPool(chain);
  const availableOptions = optionPool.filter((option) => option.isRepeatable || !usedOptions.has(option));

  /**
   * 值层候选：suggestions 前缀过滤 + 动态/自由值 hint。
   * `inlinePrefix` 非空表示值内联在 `--flag=…` 里（insert 整体替换当前 token）；
   * `prefix` 是值前缀（内联时取 `=` 后半段，独立值 token 时即 partial）。
   */
  const valueItems = (
    arg: FigArg | null | undefined,
    ownerDescription: string | undefined,
    inlinePrefix: string,
    prefix: string,
  ): CompletionItem[] => {
    const out: CompletionItem[] = [];
    arg?.suggestions?.forEach((suggestion) => {
      const score = scoreCandidate(prefix, suggestion, "argument");
      if (score === null) return;
      out.push(
        makeItem(
          commandPath,
          out.length,
          "argument",
          suggestion,
          arg.description ?? ownerDescription,
          inlinePrefix ? `${inlinePrefix}=${suggestion}` : suggestion,
          score,
        ),
      );
    });
    if (!out.length && (arg?.generators?.length || (arg && !arg.suggestions?.length))) {
      // 动态值（脚本 generator，wave 2 接线执行）或自由值：出一条不可插入的 hint。
      out.push(
        makeItem(commandPath, out.length, "hint", argPlaceholder(arg), arg.description ?? ownerDescription, "", kindScore("hint")),
      );
    }
    return out;
  };

  const flagItems = (): CompletionItem[] => {
    const out: CompletionItem[] = [];
    let index = 0;
    for (const option of availableOptions) {
      for (const name of option.names) {
        const score = scoreCandidate(partial, name, "option");
        if (score === null) continue;
        const label = option.args ? `${name} ${argPlaceholder(option.args)}` : name;
        out.push(makeItem(commandPath, index, "option", label, option.description, name, score));
        index += 1;
      }
    }
    return out;
  };

  const subcommandItems = (): CompletionItem[] => {
    const out: CompletionItem[] = [];
    nodeSubcommands(node).forEach((sub, subIndex) => {
      const byName = scoreCandidate(partial, sub.name, "subcommand");
      const byAlias = sub.aliases?.some((alias) => alias.toLowerCase().startsWith(partial.toLowerCase()) && partial.length > 0) ?? false;
      const score = byName ?? (byAlias ? SCORE_PREFIX_BASE + kindScore("subcommand") : null);
      if (score === null) return;
      out.push(makeItem(commandPath, subIndex, "subcommand", sub.name, sub.description, sub.name, score));
    });
    return out;
  };

  // ---- flag 层：当前 token 以 "-" 开头（含 `--flag=value` 内联值层）----
  if (!terminated && partial.startsWith("-")) {
    const equals = partial.indexOf("=");
    if (equals !== -1) {
      const typedFlag = partial.slice(0, equals);
      const valuePrefix = partial.slice(equals + 1);
      const option = findOptionBySurface(optionPool, typedFlag);
      if (!option) return null;
      const items = valueItems(option.args ?? null, option.description, typedFlag, valuePrefix);
      return items.length ? { items: rankItems(items), context: buildContext(commandPath) } : null;
    }
    const items = flagItems();
    return items.length ? { items: rankItems(items), context: buildContext(commandPath) } : null;
  }

  // ---- 值层：上一个完整 token 是等待值的 option ----
  if (pendingValueOption) {
    const items = valueItems(pendingValueOption.args ?? null, pendingValueOption.description, "", partial);
    return items.length ? { items: rankItems(items), context: buildContext(commandPath) } : null;
  }

  // ---- sub / 位置参数层（`--` 之后只剩位置参数）----
  const items: CompletionItem[] = [];
  if (!terminated) items.push(...subcommandItems());
  const arg = nodeArgs(node)[positionalIndex];
  if (arg) {
    const positional = valueItems(arg, undefined, "", partial);
    items.push(...positional);
  }
  // 无子命令与位置候选时拿 option 兜底（对齐 legacy subRows 的兜底行为；
  // `--` 终结后不再兜底）。不满足前缀的兜底也会被 scoreCandidate 过滤。
  if (!items.length && !terminated && availableOptions.length) {
    for (const option of availableOptions) {
      for (const name of option.names) {
        if (!partial || name.startsWith(partial) || name.toLowerCase().startsWith(partial.toLowerCase())) {
          items.push(makeItem(commandPath, items.length, "option", option.args ? `${name} ${argPlaceholder(option.args)}` : name, option.description, name, SCORE_PREFIX_BASE + kindScore("option")));
        }
      }
    }
  }
  return items.length ? { items: rankItems(items), context: buildContext(commandPath) } : null;
}
