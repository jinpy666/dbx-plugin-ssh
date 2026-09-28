// legacy spec adapter（FIG wave-1 Lane A）：把既有结构化补全 parser
// （lib/completions/spec.ts 的 matchSpecLine + COMPLETION_SPECS）包装成
// 补全引擎的 resolver。零回归的根：映射逐字段保真——golden parity 测试
// （legacySpecAdapter.spec.ts）对全量 spec 语料断言 controller 输出与
// matchSpecLine 直查在 label/kind/顺序/描述/边界上逐一相等。
//
// 本模块不改 legacy parser 的任何语义（契约 §6：spec.ts 只读共享）；
// wave 2 的 fig provider 链接入后，本 adapter 降级为 provider 链的兜底层。

import type {
  CompletionContext,
  CompletionItem,
  CompletionItemKind,
  CompletionResponse,
} from "../core/types";
import { rankItems } from "../core/ranking";
import type { DynamicCompletionTarget } from "../../completions/provider";
import { matchSpecLine, type CompletionRow, type CompletionLevel, type CompletionRowKind, type SpecMatch } from "../../completions/spec";
import { COMPLETION_SPECS } from "../../completions/specs";

export interface LegacyResolveInput {
  line: string;
  requestId: number;
  revision: number;
  sessionId: string;
}

/** legacy CompletionRowKind → 引擎 CompletionItemKind 的固定映射。 */
const ROW_KIND_TO_ITEM_KIND: Record<CompletionRowKind, CompletionItemKind> = {
  sub: "subcommand",
  flag: "option",
  value: "argument",
  hint: "hint",
};

/** 引擎 CompletionItemKind → legacy CompletionRowKind 的反查（菜单渲染用）。 */
export function itemKindToRowKind(kind: CompletionItemKind): CompletionRowKind {
  if (kind === "subcommand") return "sub";
  if (kind === "option") return "flag";
  if (kind === "hint") return "hint";
  return "value";
}

/** CompletionItem → CompletionMenu 的展示行（token/space 从 edit 反推）。 */
export function completionRowFromItem(item: CompletionItem): CompletionRow {
  const trailingSpace = item.edit.text.endsWith(" ");
  return {
    kind: itemKindToRowKind(item.kind),
    token: trailingSpace ? item.edit.text.slice(0, -1) : item.edit.text,
    space: trailingSpace,
    label: item.label,
    description: item.description ?? "",
    score: item.score,
  };
}

/**
 * matchSpecLine 包装成引擎 resolver：null（无 spec 命中）与 rows 空（命中但
 * 本层无可枚举候选）都归一为 state:"pass-through"、items:[]（App 回落历史
 * 建议浮层的现逻辑不变）。
 */
export function legacyResolve(input: LegacyResolveInput): CompletionResponse {
  const match = matchSpecLine(input.line, COMPLETION_SPECS);
  if (!match || !match.rows.length) {
    return { requestId: input.requestId, revision: input.revision, state: "pass-through", items: [] };
  }
  const context: CompletionContext = {
    command: match.commandPath[0] ?? null,
    commandPath: match.commandPath,
    tokenStart: match.replaceStart,
    tokenEnd: match.replaceEnd,
  };
  const items = rankItems(
    match.rows.map((row, index) => {
      const item: CompletionItem = {
        id: `legacy:${match.commandPath.join(" ")}:${row.label}:${index}`,
        label: row.label,
        description: row.description,
        kind: ROW_KIND_TO_ITEM_KIND[row.kind],
        score: row.score,
        source: "legacy-spec",
        edit: {
          text: row.token + (row.space ? " " : ""),
          replaceStart: match.replaceStart,
          replaceEnd: match.replaceEnd,
        },
      };
      return item;
    }),
  );
  return { requestId: input.requestId, revision: input.revision, state: "ready", context, items };
}

/**
 * 菜单层级（sub/flag/value，仅驱动 CompletionMenu 的层级角标）推导：
 * 冻结的 CompletionResponse 不携带 parser 内部的 level，这里先用
 * items+context 的确定性规则推导；规则覆盖不了的情形（纯 argument/hint 行
 * 无法区分"等待值的 flag"与"位置参数层"，如 `kubectl get -o ` 与
 * `kubectl get `）回落 parser 直查——与 HEAD 的 match.level 逐一相等
 * （parity 测试固化）。wave 2 provider 链接管层级语义后本函数退役。
 */
export function deriveLegacyLevel(response: CompletionResponse, line: string): CompletionLevel {
  const items = response.items;
  if (items.some((item) => item.kind === "subcommand")) return "sub";
  const context = response.context;
  const partial = context ? line.slice(context.tokenStart, context.tokenEnd) : "";
  if (partial.startsWith("-")) return partial.includes("=") ? "value" : "flag";
  if (items.some((item) => item.kind === "option")) return "sub";
  return matchSpecLine(line, COMPLETION_SPECS)?.level ?? "sub";
}

/**
 * 动态值目标（分支/文件/pod 等本地不可枚举层的 DynamicCompletionTarget）：
 * 冻结响应类型不携带该信息，hint 层（整层皆 hint）沿用 parser 直查重建，
 * 供既有动态 provider（lib/completions/provider.ts 注册表，fix-120 的
 * remoteFsProvider）继续工作。非 hint 层返回 null（parser 语义：动态询问
 * 只发生在整层 hint 时）。
 */
export function legacyDynamicTarget(line: string): DynamicCompletionTarget | null {
  const match = matchSpecLine(line, COMPLETION_SPECS);
  if (!match || !match.rows.length || match.rows.some((row) => row.kind !== "hint")) return null;
  return match.dynamic ?? null;
}

/** 测试辅助：暴露 parser 直查结果（parity 断言的对照组）。 */
export function specMatchForLine(line: string): SpecMatch | null {
  return matchSpecLine(line, COMPLETION_SPECS);
}
