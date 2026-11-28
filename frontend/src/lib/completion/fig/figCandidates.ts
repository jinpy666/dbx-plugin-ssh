// 候选枚举（自 figCompletionSource 纯搬移）：manifest 命令名 / 静态 spec 候选
// 的枚举与 CompletionItem 组装。语义全部来自上游状态机的 suggestionFlags 与
// searchTerm 前缀匹配；本文件不做任何解析（驱动在 figCompletionSource）。

import type {
  CompletionContext,
  CompletionEdit,
  CompletionItem,
  CompletionItemKind,
  CompletionResponse,
} from "../core/types";
import type { FigSourceRequest, FigSpecManifest } from "./source";
import type { ParserCommand, ParserCommandToken, ParserEngineApi, ParserOption, ParserResult } from "./parserTypes";
import { SuggestionFlag } from "./parserTypes";
import {
  firstString,
  isOptionExhausted,
  isRecord,
  lineLengthOf,
  mapArgSuggestionKind,
  safeIndex,
} from "./parserUtils";

const MAX_COMMAND_ITEMS = 32;

/** 单 token 非行尾（正在敲命令名）：manifest 命令名前缀补全。 */
export function buildCommandNameResponse(options: {
  manifest: FigSpecManifest;
  sourceId: string;
  request: FigSourceRequest;
  command: ParserCommand;
  searchTerm: string;
}): CompletionResponse | null {
  const { manifest, sourceId, request, command, searchTerm } = options;
  const names = Object.keys(manifest)
    .filter((name) => name.startsWith(searchTerm))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_COMMAND_ITEMS);
  if (names.length === 0) return null;
  const lastToken = command.tokens[command.tokens.length - 1];
  const items = names.map((name) =>
    buildItem({
      sourceId,
      id: name,
      editText: name + " ",
      kind: "command",
      score: 460,
      token: lastToken,
      lineLength: lineLengthOf(lastToken),
    }),
  );
  const context: CompletionContext = {
    command: searchTerm || null,
    commandPath: [],
    tokenStart: safeIndex(lastToken.node?.startIndex, 0, 0),
    tokenEnd: safeIndex(lastToken.node?.endIndex, 0, 0),
  };
  return {
    requestId: request.requestId,
    revision: request.revision,
    state: "ready",
    context,
    items,
  };
}

/** spec 候选枚举：哪些类目可建议由上游 suggestionFlags 决定。 */
export function buildSpecItems(options: {
  engine: ParserEngineApi;
  sourceId: string;
  result: ParserResult;
  token: ParserCommandToken;
  lineLength: number;
}): CompletionItem[] {
  const { engine, sourceId, result, token, lineLength } = options;
  const items: CompletionItem[] = [];
  const flags = result.suggestionFlags ?? 0;
  const searchTerm = result.searchTerm ?? "";
  const spec = result.completionObj;

  if ((flags & SuggestionFlag.Options) !== 0 && isRecord(spec?.options)) {
    const seen = new Set<string>();
    const collect = (record: Record<string, ParserOption> | undefined, persistent: boolean) => {
      for (const [label, option] of Object.entries(record ?? {})) {
        if (!label.startsWith(searchTerm) || seen.has(label)) continue;
        seen.add(label);
        if (isOptionExhausted(engine, option, result.passedOptions)) continue;
        const description =
          (persistent ? "[persistent] " : "") +
          (typeof option.description === "string" ? option.description : "");
        items.push(
          buildItem({
            sourceId,
            id: label,
            editText: label,
            kind: "option",
            score: 400 + (label === searchTerm ? 200 : 0),
            token,
            lineLength,
            description: description || undefined,
          }),
        );
      }
    };
    collect(spec.options, false);
    collect(spec.persistentOptions, true);
  }

  if (
    (flags & SuggestionFlag.Subcommands) !== 0 &&
    isRecord(spec?.subcommands)
  ) {
    const seen = new Set<string>();
    for (const sub of Object.values(spec.subcommands)) {
      const label = firstString(sub?.name);
      if (!label || !label.startsWith(searchTerm) || seen.has(label)) continue;
      seen.add(label);
      items.push(
        buildItem({
          sourceId,
          id: label,
          editText: label + " ",
          kind: "subcommand",
          score: 420 + (label === searchTerm ? 200 : 0),
          token,
          lineLength,
          description: typeof sub.description === "string" ? sub.description : undefined,
        }),
      );
    }
  }

  if ((flags & SuggestionFlag.Args) !== 0) {
    const arg = result.currentArg;
    for (const suggestion of arg?.suggestions ?? []) {
      // Fig 的 hidden 标记 = 不进菜单、也不参与 Tab 接受的特殊参数
      // （cd 语料里的 `-`/`~` 就是这种）。展示它们会让 `cd ` 的菜单只剩
      // 两个特殊值，Tab 直接把 `cd -` 写进输入行。用户手打 `cd -`/`cd ~`
      // 后仍按原有 shell 语义执行，这里只影响本地候选面。
      // parser 的 suggestion 类型未声明该字段（spec 数据面），按 Fig 语义读。
      if ((suggestion as { hidden?: boolean } | undefined)?.hidden === true) continue;
      const label = suggestion?.name;
      if (typeof label !== "string" || !label.startsWith(searchTerm)) continue;
      items.push(
        buildItem({
          sourceId,
          id: label,
          editText: label.startsWith("-") ? label : label + " ",
          kind: mapArgSuggestionKind(suggestion.type),
          score: 380 + (label === searchTerm ? 200 : 0),
          token,
          lineLength,
          description: typeof suggestion.description === "string" ? suggestion.description : undefined,
        }),
      );
    }
  }
  return items;
}

/** CompletionItem 组装：编辑范围 = token 节点绝对偏移，光标落在替换末尾。 */
function buildItem(options: {
  sourceId: string;
  id: string;
  editText: string;
  kind: CompletionItemKind;
  score: number;
  token: ParserCommandToken | undefined;
  lineLength: number;
  description?: string;
}): CompletionItem {
  const { sourceId, id, editText, kind, score, token, lineLength, description } = options;
  const endIndex = safeIndex(token?.node?.endIndex, lineLength, 0);
  const startIndex = safeIndex(token?.node?.startIndex, endIndex, 0);
  const edit: CompletionEdit = {
    text: editText,
    replaceStart: Math.min(startIndex, endIndex),
    replaceEnd: endIndex,
  };
  edit.cursorOffset = edit.replaceStart + editText.length;
  return {
    id: `${sourceId}:${id}`,
    label: editText.trimEnd(),
    description,
    kind,
    score,
    source: "fig-spec",
    edit,
  };
}
