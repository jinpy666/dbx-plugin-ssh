// 纯函数工具（自 figCompletionSource 纯搬移）：防御性收敛，不信任 vendored
// 动态面。全部无副作用，任何异常按调用方约定收敛为安全默认值。

import type { CompletionItemKind } from "../core/types";
import type { ParserAnnotation, ParserArgument, ParserCommandToken, ParserEngineApi, ParserOption, ParserState } from "./parserTypes";
import { TokenType } from "./parserTypes";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function lastAnnotationType(
  engineRef: ParserEngineApi,
  state: ParserState,
): string {
  const annotations = safeFlatten(engineRef, state.annotations);
  const last = annotations[annotations.length - 1];
  return last?.type ?? TokenType.None;
}

export function safeFlatten(
  engineRef: ParserEngineApi,
  annotations: ParserAnnotation[],
): ParserAnnotation[] {
  try {
    const flattened = engineRef.flattenAnnotations(annotations ?? []);
    return Array.isArray(flattened) ? flattened : [];
  } catch {
    return [];
  }
}

/** 参数态里"当前 arg"：镜像上游 preferOptionArg（optionArg 优先）。 */
export function pickCurrentArg(state: ParserState): ParserArgument | null {
  const optionArg = state.optionArgState?.args?.[state.optionArgState.index];
  if (optionArg && (optionArg.isVariadic || optionArg.isOptional !== true)) {
    return optionArg;
  }
  const subcommandArg = state.subcommandArgState?.args?.[state.subcommandArgState.index];
  return subcommandArg ?? optionArg ?? null;
}

/** 非可重复选项已传过 → 不再候选（镜像上游 suggestions 过滤语义）。 */
export function isOptionExhausted(
  engineRef: ParserEngineApi,
  option: ParserOption | undefined,
  passedOptions: ParserOption[],
): boolean {
  if (!option || option.isRepeatable === true) return false;
  const limit = typeof option.isRepeatable === "number" ? option.isRepeatable : 1;
  try {
    return engineRef.countEqualOptions(option, passedOptions ?? []) >= limit;
  } catch {
    return false;
  }
}

export function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return null;
}

/** token 的行尾收敛长度（节点缺偏移时的 fallback）。 */
export function lineLengthOf(token: ParserCommandToken | undefined): number {
  return typeof token?.node?.endIndex === "number" ? token.node.endIndex : 0;
}

export function mapArgSuggestionKind(type: unknown): CompletionItemKind {
  if (type === "file") return "file";
  if (type === "folder") return "directory";
  if (type === "subcommand") return "subcommand";
  if (type === "option") return "option";
  return "argument";
}

export function safeIndex(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.isFinite(fallback) ? fallback : minimum;
  }
  return Math.max(minimum, Math.min(value, Number.MAX_SAFE_INTEGER));
}
