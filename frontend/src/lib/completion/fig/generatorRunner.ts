// 声明式 generator 运行器（骨架，FIG wave-1 契约 §2 决策 6 / 方案 M5）。
// 只负责一条流水线：decl.script → completion/execute（目标机执行，前端不直连
// shell）→ splitOn 切分 stdout → postProcess 产候选 → 归一化为 CompletionItem[]。
// 骨架边界：不接 source/controller/App.vue（正式接线属批次 2-1），不含
// ranking/过滤（打分与按前缀过滤属 Lane A' 的 ranking 层，score 恒 0）。
// 失败/超时/任何异常一律 null（调用方 pass-through），绝不 throw。

import type { CompletionContext, CompletionItem } from "../core/types";
import type { CompletionExecuteRequest, CompletionExecuteResult, CompletionExecuteTarget } from "../host/protocol";
import {
  COMPLETION_DEFAULT_MAX_OUTPUT_BYTES,
  COMPLETION_DEFAULT_TIMEOUT_MS,
  COMPLETION_GENERATOR_MODE,
  type CompletionHostClient,
} from "../host/hostClient";

/** Fig.Generator 的声明式子集：script[0] 为可执行命令，其余为 argv。 */
export interface DeclarativeGeneratorDecl {
  script: string[];
  /** stdout 切分分隔符；缺省/空串按 "\n"。 */
  splitOn?: string;
}

/** postProcess 的归一化产出；映射为 CompletionItem 时 label/description 原样透传。 */
export interface GeneratorSuggestion {
  label: string;
  description?: string;
}

/**
 * postProcess：与 Fig.Spec 语义对齐——收到按 splitOn 切分后的 stdout 片段
 * 与原始执行结果（可判 truncated/exitCode）。返回 null/undefined 或抛错
 * = 本次 generator 失败（降级 null）。
 */
export type GeneratorPostProcess = (
  parts: string[],
  result: CompletionExecuteResult,
) => GeneratorSuggestion[] | null | undefined;

export interface GeneratorRunContext {
  /** 目标会话（local/ssh）；generator 一律经 completion/execute 在目标机执行。 */
  target: CompletionExecuteTarget;
  /** 由 createCompletionHostClient().execute 提供；测试注入 Fake。 */
  execute: CompletionHostClient["execute"];
  /** 冻结 parser 上下文（commandPath / 当前 token 区间），供 edit 定位。 */
  context: CompletionContext;
  /** 当前 token 文本（= 上下文前缀）；供 postProcess 闭包与将来 ranking 使用。 */
  prefix: string;
  cwd?: string | null;
  /** 缺省时交 hostClient 默认（1200，clamp [200,3000]）。 */
  timeoutMs?: number;
  /** 缺省 256 KiB。 */
  maxOutputBytes?: number;
}

export const GENERATOR_ITEM_SOURCE = "fig-generator";
export const GENERATOR_ITEM_KIND: CompletionItem["kind"] = "argument";

function splitOutput(stdout: string, splitOn: string | undefined): string[] {
  const separator = typeof splitOn === "string" && splitOn.length > 0 ? splitOn : "\n";
  return stdout.split(separator);
}

/**
 * 运行一个声明式 generator。返回 null = 失败/超时/畸形（调用方降级）；
 * 返回 [] = 执行成功但无候选（合法结果）。
 */
export async function runDeclarativeGenerator(
  decl: DeclarativeGeneratorDecl,
  postProcess: GeneratorPostProcess,
  ctx: GeneratorRunContext,
): Promise<CompletionItem[] | null> {
  try {
    const script = decl?.script;
    if (!Array.isArray(script) || script.length === 0) return null;
    const [command, ...args] = script;
    if (typeof command !== "string" || command.trim() === "") return null;
    if (args.some((arg) => typeof arg !== "string")) return null;
    if (typeof postProcess !== "function") return null;
    if (typeof ctx?.execute !== "function") return null;

    const request: CompletionExecuteRequest = {
      target: ctx.target,
      command,
      args,
      cwd: typeof ctx.cwd === "string" ? ctx.cwd : null,
      timeoutMs: typeof ctx.timeoutMs === "number" ? ctx.timeoutMs : COMPLETION_DEFAULT_TIMEOUT_MS,
      maxOutputBytes:
        typeof ctx.maxOutputBytes === "number" ? ctx.maxOutputBytes : COMPLETION_DEFAULT_MAX_OUTPUT_BYTES,
      mode: COMPLETION_GENERATOR_MODE,
    };

    const result = await ctx.execute(request);
    // execute 返回 null = 桥/传输/畸形失败；timedOut = completion 层超时。
    if (!result || result.timedOut) return null;

    const parts = splitOutput(result.stdout, decl.splitOn);
    const suggestions = postProcess(parts, result);
    if (!Array.isArray(suggestions)) return null;

    const { context } = ctx;
    const items: CompletionItem[] = [];
    suggestions.forEach((suggestion, index) => {
      if (typeof suggestion !== "object" || suggestion === null) return;
      if (typeof suggestion.label !== "string") return;
      items.push({
        id: `${GENERATOR_ITEM_SOURCE}:${command}:${index}:${suggestion.label}`,
        label: suggestion.label,
        ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
        kind: GENERATOR_ITEM_KIND,
        score: 0,
        source: GENERATOR_ITEM_SOURCE,
        edit: {
          text: suggestion.label,
          replaceStart: context.tokenStart,
          replaceEnd: context.tokenEnd,
          cursorOffset: context.tokenStart + suggestion.label.length,
        },
      });
    });
    return items;
  } catch {
    return null;
  }
}
