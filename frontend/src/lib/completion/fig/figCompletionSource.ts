// FigCompletionSource 实现（Lane C'）：把 vendored amazon-q autocomplete parser
// （frontend/vendor/autocomplete-engine/parser.js）与全量 spec manifest
// （frontend/vendor/fig-specs/spec-manifest.generated.ts）接到冻结接缝
// fig/source.ts 上。
//
// 设计（细则 §2/§3 与 docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md）：
// - 语义权威 = 上游 parseArguments.ts 的 updateState 状态机（别名/持久选项/
//   变参/嵌套/`--`/`--flag=value`），本文件只做驱动与候选枚举，不自研语义；
// - 上游 parseArguments() 入口是 async（fs/CDN spec 加载 + generator 执行），
//   冻结接口是同步的 → 用上游状态机原语组装同步驱动：spec 来源换成 manifest
//   注册表（loadSpec 文件系统语义被 manifest 替代，见 vendor NOTICE）；
// - token 边界用 core/tokenize.ts 做行级判定（冻结复用），候选编辑范围用
//   shell-parser 的 token 节点 startIndex/endIndex（buffer 绝对偏移，行尾精确）；
// - generator 声明位置（currentArg.generators / completionObj.generateSpec /
//   loadSpec 函数形态）批次 1 → resolve 返回 null（pass-through）；
// - 任何异常吞掉返 null，绝不上抛（回归红线 §3.1）。

import { splitCommandLine } from "../core/tokenize";
import type {
  CompletionContext,
  CompletionEdit,
  CompletionItem,
  CompletionItemKind,
  CompletionResponse,
} from "../core/types";
import type {
  FigSourceRequest,
  FigSpecManifest,
  FigCompletionSource,
} from "./source";

// ---------------------------------------------------------------------------
// parser.js 的最小类型面（vendored 产物无类型；防御性收敛，不污染全局命名空间）
// ---------------------------------------------------------------------------

// @ts-expect-error — vendored parser 是无类型 JS 产物（见 vendor README / NOTICE）
import * as parserModule from "../../../../vendor/autocomplete-engine/parser.js";
// @ts-nocheck 无法只作用于单条 import；manifest 为生成物（自带 @ts-nocheck）
import generatedManifest from "../../../../vendor/fig-specs/spec-manifest.generated";

/** 上游 TokenType（parseArguments.ts）。 */
const TokenType = {
  None: "none",
  Subcommand: "subcommand",
  Option: "option",
  OptionArg: "option_arg",
  SubcommandArg: "subcommand_arg",
  Composite: "composite",
} as const;

/** 上游 SuggestionFlag 位标志（shared/utils.ts）。 */
const SuggestionFlag = {
  None: 0,
  Subcommands: 1 << 0,
  Options: 1 << 1,
  Args: 1 << 2,
  Any: (1 << 2) | (1 << 1) | (1 << 0),
} as const;

interface ParserAnnotation {
  type: string;
  text: string;
  tokenName?: string;
  subtokens?: ParserAnnotation[];
}

interface ParserTokenNode {
  startIndex: number;
  endIndex: number;
}

interface ParserCommandToken {
  text: string;
  node: ParserTokenNode;
}

interface ParserCommand {
  tokens: ParserCommandToken[];
}

interface ParserArgument {
  name?: string | string[];
  isOptional?: boolean;
  isVariadic?: boolean;
  isCommand?: boolean;
  isModule?: boolean;
  isScript?: boolean;
  loadSpec?: unknown;
  suggestions?: Array<{ name: string; description?: string; type?: string }>;
  generators?: unknown[];
}

interface ParserOption {
  name?: string[];
  description?: string;
  isRepeatable?: boolean | number;
}

interface ParserSubcommand {
  name?: string[];
  description?: string;
  subcommands?: Record<string, ParserSubcommand>;
  options?: Record<string, ParserOption>;
  persistentOptions?: Record<string, ParserOption>;
  args?: ParserArgument[];
  loadSpec?: unknown;
  generateSpec?: unknown;
  parserDirectives?: Record<string, unknown>;
}

interface ParserState {
  completionObj: ParserSubcommand;
  passedOptions: ParserOption[];
  annotations: ParserAnnotation[];
  optionArgState: { args: ParserArgument[] | null; index: number };
  subcommandArgState: { args: ParserArgument[] | null; index: number };
  haveEnteredSubcommandArgs: boolean;
  isEndOfOptions: boolean;
}

interface ParserResult {
  completionObj: ParserSubcommand;
  passedOptions: ParserOption[];
  annotations: ParserAnnotation[];
  currentArg: ParserArgument | null;
  searchTerm: string;
  suggestionFlags: number;
}

/** parser.js 实际暴露面（由 vendor/amazon-q-autocomplete/facades/parserEntry.ts 冻结）。 */
interface ParserEngineApi {
  TokenType: typeof TokenType;
  SuggestionFlag: typeof SuggestionFlag;
  createArgState: (args?: ParserArgument[]) => { args: ParserArgument[] | null; index: number };
  updateState: (
    state: ParserState,
    token: string,
    isFinalToken?: boolean,
  ) => ParserState;
  getInitialState: (
    spec: ParserSubcommand,
    text?: string,
    specLocation?: { name: string; type: string },
  ) => ParserState;
  getResultFromState: (state: ParserState) => ParserResult;
  flattenAnnotations: (annotations: ParserAnnotation[]) => ParserAnnotation[];
  countEqualOptions: (option: ParserOption, options: ParserOption[]) => number;
  getCommand: (
    buffer: string,
    aliases: Record<string, string>,
    cursorIndex?: number,
  ) => ParserCommand | null;
  convertSubcommand: (spec: unknown, initializeDefault: unknown) => ParserSubcommand;
  initializeDefault: (spec: unknown) => unknown;
}

const engine = parserModule as unknown as ParserEngineApi;

// ---------------------------------------------------------------------------
// spec 注册表：manifest（静态 bundled）替代上游 fs/CDN loadSpec
// ---------------------------------------------------------------------------

const generatedManifestStore = generatedManifest as unknown as FigSpecManifest;

export interface FigSourceOptions {
  /** 测试/fixture 注入点；默认使用生成的全量 manifest。 */
  manifest?: FigSpecManifest;
}

/** versioned spec（default export 为 createVersionedSpec 函数，如 az/fig）的
 * 同步可解析缓存；resolve() 只读缓存，未预热完成的名称按 pass-through 降级。 */
export interface FigSourceRuntime {
  readonly specCount: number;
  readonly prewarmedSpecNames: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export class FigCompletionSourceImpl implements FigCompletionSource {
  readonly id = "fig-spec";

  private readonly manifest: FigSpecManifest;
  private readonly convertedCache = new Map<string, ParserSubcommand | null>();
  private readonly versionedResolved = new Map<string, ParserSubcommand | null>();

  constructor(options: FigSourceOptions = {}) {
    this.manifest = options.manifest ?? generatedManifestStore;
  }

  /** 异步预热 versioned spec（default export 是函数的条目，数量个位数）。
   * 吞掉一切异常；构造时 fire-and-forget，批次 1 不阻塞首帧。 */
  async prewarm(): Promise<FigSourceRuntime> {
    for (const [name, raw] of Object.entries(this.manifest)) {
      if (typeof raw !== "function") continue;
      try {
        const info: unknown = await (raw as (version?: string) => Promise<unknown>)(undefined);
        const spec = this.resolveVersionedInfo(name, info, new Set([name]));
        const converted = this.convert(spec);
        this.versionedResolved.set(name, converted);
      } catch {
        this.versionedResolved.set(name, null);
      }
    }
    return { specCount: Object.keys(this.manifest).length, prewarmedSpecNames: [...this.versionedResolved.keys()] };
  }

  // ---- manifest → 归一化 spec --------------------------------------------

  private convert(raw: unknown): ParserSubcommand | null {
    if (typeof raw !== "object" || raw === null) return null;
    try {
      const converted = engine.convertSubcommand(raw, engine.initializeDefault);
      return isRecord(converted) ? (converted as ParserSubcommand) : null;
    } catch {
      return null;
    }
  }

  /** versioned spec 函数返回值的解析：{versionedSpecPath} → 指向的 spec。 */
  private resolveVersionedInfo(
    name: string,
    info: unknown,
    visited: Set<string>,
  ): unknown {
    if (!isRecord(info)) return info;
    const path = info.versionedSpecPath;
    if (typeof path !== "string") return info;
    if (visited.has(path)) return null;
    visited.add(path);
    const target = this.manifest[path];
    if (typeof target === "function") return null; // 嵌套 versioned：批次 1 不追
    return target ?? null;
  }

  private lookupSpec(name: string, visited: Set<string>): ParserSubcommand | null {
    if (visited.has(name)) return null;
    if (this.convertedCache.has(name)) return this.convertedCache.get(name) ?? null;
    visited.add(name);
    let converted: ParserSubcommand | null = null;
    const raw = this.manifest[name];
    if (typeof raw === "function") {
      converted = this.versionedResolved.get(name) ?? null; // 未预热 → 降级 null
    } else if (raw !== undefined) {
      converted = this.convert(raw);
    }
    this.convertedCache.set(name, converted);
    return converted;
  }

  // ---- 冻结接口实现 ---------------------------------------------------------

  resolve(request: FigSourceRequest): CompletionResponse | null {
    try {
      return this.resolveOrThrow(request);
    } catch {
      return null; // 回归红线 §3.1：任何异常不外抛
    }
  }

  private resolveOrThrow(request: FigSourceRequest): CompletionResponse | null {
    const { line, requestId, revision } = request;
    if (typeof line !== "string" || line.length === 0) return null;

    // 冻结 tokenize：行级判定（空行/无 token 直接 pass-through）。
    const split = splitCommandLine(line);
    if (split.tokens.length === 0) return null;

    // 上游 shell-parser：行 → 命令节点（光标所在命令；`git status && docker `
    // 这类多段行只对当前段补全）。token 节点携带 buffer 绝对偏移。
    const command = engine.getCommand(line, EMPTY_ALIASES, line.length);
    if (!command || command.tokens.length === 0) return null;

    const tokens = command.tokens;
    const lastToken = tokens[tokens.length - 1];

    // 单 token 且非行尾空白：正在敲命令名 → 用 manifest 命令名补全。
    if (tokens.length === 1 && !split.trailingSpace) {
      return this.commandNameResponse(request, command, tokens[0].text);
    }

    const rootName = tokens[0].text;
    let rootSpec = this.lookupSpec(rootName, new Set());
    if (!rootSpec) {
      if (tokens.length === 1) return this.commandNameResponse(request, command, rootName);
      return null; // 无 spec 命中 → pass-through（不造假候选）
    }

    let state = engine.getInitialState(rootSpec, rootName, {
      name: rootName,
      type: "global",
    });

    const visitedLoadSpec = new Set<string>([rootName]);
    // 根级 loadSpec（上游 parseArgumentsCached 进入循环前先解析，见其
    // updateStateForLoadSpec(…, 0) 调用）：函数形态（宿主/exec 语义）→ null；
    // string/数组/内联对象 → manifest 解析换轨。
    if (rootSpec.loadSpec !== undefined && rootSpec.loadSpec !== null) {
      const rootSwapped = this.resolveLoadSpecValue(rootSpec.loadSpec, visitedLoadSpec);
      if (!rootSwapped) return null;
      rootSpec = rootSwapped;
    }

    // 中间 token：逐个喂上游状态机（语义权威）。generateSpec 动态面不执行：
    // 上游 generateSpecForState 失败时同样沿用静态 spec 继续（错误仅记日志），
    // 故保留静态候选（镜像上游降级语义）；纯动态位因无静态候选自然 null。
    for (let i = 1; i < tokens.length - 1; i += 1) {
      const token = tokens[i].text;
      // 上游在 updateState 之前捕获“将要被消费的 arg”（lastArgObject，见
      // parseArgumentsCached 循环），用于其后的 arg.loadSpec/isCommand 换轨。
      const argBefore = pickCurrentArg(state);
      try {
        state = engine.updateState(state, token);
      } catch {
        return null; // token 无法消费（上游语义）→ pass-through
      }
      const swapped = this.applySyncLoadSpec(state, token, visitedLoadSpec, argBefore);
      if (swapped === null) return null;
      state = swapped;
    }

    // 末 token：isFinalToken=true 只标注不消费（searchTerm 语义，同上游）。
    let finalState: ParserState;
    try {
      finalState = engine.updateState(state, lastToken.text, true);
    } catch {
      finalState = {
        ...state,
        annotations: [
          ...state.annotations,
          { type: TokenType.None, text: lastToken.text },
        ],
      };
    }
    const result = engine.getResultFromState(finalState);
    if (!isRecord(result)) return null;

    // 候选枚举（语义全部来自上游状态机：哪些类目可建议由 suggestionFlags 决定）。
    const items = this.buildItems(result, lastToken, line.length);

    // generator 声明参数位（currentArg.generators）：批次 1 不执行 generator，
    // 静态候选（options/subcommands/静态 args suggestions）照常给出；完全无
    // 静态候选的动态位 → null（pass-through；批次 2 经 completion/execute 接入）。
    const currentArg = result.currentArg;
    const generatorOwned =
      !!currentArg && Array.isArray(currentArg.generators) && currentArg.generators.length > 0;
    if (items.length === 0) {
      if (generatorOwned) return null;
      // isCommand/isModule 参数位（如 `sudo `）：静态可补的是 manifest 命令名。
      if (currentArg && (currentArg.isCommand || typeof currentArg.isModule === "string") && !currentArg.isScript) {
        return this.commandNameResponse(request, command, result.searchTerm ?? "");
      }
      return null; // 无命中 → pass-through
    }

    const flattened = safeFlatten(engine, result.annotations);
    const commandPath = flattened
      .filter((a) => a.type === TokenType.Subcommand)
      .map((a) => a.text);
    const primaryName = firstString(result.completionObj?.name) ?? rootName;

    const context: CompletionContext = {
      command: primaryName,
      commandPath,
      tokenStart: safeIndex(lastToken.node?.startIndex, line.length, 0),
      tokenEnd: safeIndex(lastToken.node?.endIndex, line.length, line.length),
    };
    return {
      requestId,
      revision,
      state: "ready",
      context,
      items,
    };
  }

  /** 上游 loadSpec 语义的同步镜像（loadSpec.ts 被 manifest 替代）。上游
   * initializeDefault 已把 loadSpec 归一化：string → [{name,type}] 数组、
   * function → 宿主/exec 形态、object → 内联 subcommand。此处按形态分派：
   * 数组取首个 location 的 name 查 manifest；函数形态视为 generator 位 →
   * null；对象直接 convert。任何解析失败 → null（pass-through，等价于上游
   * UpdateStateError 的降级）。 */
  private applySyncLoadSpec(
    state: ParserState,
    token: string,
    visited: Set<string>,
    argBefore?: ParserArgument | null,
  ): ParserState | null {
    const completionObj = state.completionObj;
    const lastType = lastAnnotationType(engine, state);
    let loadSpecValue: unknown;
    if (lastType === TokenType.Subcommand) {
      loadSpecValue = completionObj?.loadSpec;
    } else if (lastType === TokenType.OptionArg || lastType === TokenType.SubcommandArg) {
      const arg = argBefore ?? null;
      if (arg) {
        if (arg.loadSpec !== undefined && arg.loadSpec !== null) loadSpecValue = arg.loadSpec;
        else if (arg.isCommand) loadSpecValue = token;
        else if (typeof arg.isModule === "string") loadSpecValue = `${arg.isModule}${token}`;
      }
    }
    if (loadSpecValue === undefined || loadSpecValue === null) return state;

    const spec = this.resolveLoadSpecValue(loadSpecValue, visited);
    if (!spec) return null;
    return {
      ...state,
      completionObj: {
        ...spec,
        parserDirectives: {
          ...state.completionObj?.parserDirectives,
          ...spec.parserDirectives,
        },
      },
      optionArgState: engine.createArgState(),
      passedOptions: [],
      subcommandArgState: engine.createArgState(spec.args ?? []),
      haveEnteredSubcommandArgs: false,
    };
  }

  private resolveLoadSpecValue(
    value: unknown,
    visited: Set<string>,
  ): ParserSubcommand | null {
    if (typeof value === "function") return null; // 宿主/exec 形态 → 批次 2
    if (typeof value === "string") return this.lookupSpec(value, visited);
    if (Array.isArray(value)) {
      const location = value.find((entry) => isRecord(entry) && typeof entry.name === "string");
      return location ? this.lookupSpec(location.name as string, visited) : null;
    }
    if (isRecord(value)) return this.convert(value);
    return null;
  }

  // ---- 候选枚举（manifest 命令名 / 静态 spec 候选） -------------------------

  private commandNameResponse(
    request: FigSourceRequest,
    command: ParserCommand,
    searchTerm: string,
  ): CompletionResponse | null {
    const names = Object.keys(this.manifest)
      .filter((name) => name.startsWith(searchTerm))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_COMMAND_ITEMS);
    if (names.length === 0) return null;
    const lastToken = command.tokens[command.tokens.length - 1];
    const items = names.map((name) =>
      this.toItem(name, name + " ", "command", 460, lastToken, lineLengthOf(lastToken)),
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

  private buildItems(
    result: ParserResult,
    token: ParserCommandToken,
    lineLength: number,
  ): CompletionItem[] {
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
            this.toItem(
              label,
              label,
              "option",
              400 + (label === searchTerm ? 200 : 0),
              token,
              lineLength,
              description || undefined,
            ),
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
          this.toItem(
            label,
            label + " ",
            "subcommand",
            420 + (label === searchTerm ? 200 : 0),
            token,
            lineLength,
            typeof sub.description === "string" ? sub.description : undefined,
          ),
        );
      }
    }

    if ((flags & SuggestionFlag.Args) !== 0) {
      const arg = result.currentArg;
      for (const suggestion of arg?.suggestions ?? []) {
        const label = suggestion?.name;
        if (typeof label !== "string" || !label.startsWith(searchTerm)) continue;
        items.push(
          this.toItem(
            label,
            label.startsWith("-") ? label : label + " ",
            mapArgSuggestionKind(suggestion.type),
            380 + (label === searchTerm ? 200 : 0),
            token,
            lineLength,
            typeof suggestion.description === "string" ? suggestion.description : undefined,
          ),
        );
      }
    }
    return items;
  }

  private toItem(
    id: string,
    editText: string,
    kind: CompletionItemKind,
    score: number,
    token: ParserCommandToken | undefined,
    lineLength: number,
    description?: string,
  ): CompletionItem {
    const endIndex = safeIndex(token?.node?.endIndex, lineLength, 0);
    const startIndex = safeIndex(token?.node?.startIndex, endIndex, 0);
    const edit: CompletionEdit = {
      text: editText,
      replaceStart: Math.min(startIndex, endIndex),
      replaceEnd: endIndex,
    };
    edit.cursorOffset = edit.replaceStart + editText.length;
    return {
      id: `${this.id}:${id}`,
      label: editText.trimEnd(),
      description,
      kind,
      score,
      source: "fig-spec",
      edit,
    };
  }
}

// ---------------------------------------------------------------------------
// 纯函数工具（防御性收敛，不信任 vendored 动态面）
// ---------------------------------------------------------------------------

const EMPTY_ALIASES: Readonly<Record<string, string>> = Object.freeze({});
const MAX_COMMAND_ITEMS = 32;

function lastAnnotationType(
  engineRef: ParserEngineApi,
  state: ParserState,
): string {
  const annotations = safeFlatten(engineRef, state.annotations);
  const last = annotations[annotations.length - 1];
  return last?.type ?? TokenType.None;
}

function safeFlatten(
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
function pickCurrentArg(state: ParserState): ParserArgument | null {
  const optionArg = state.optionArgState?.args?.[state.optionArgState.index];
  if (optionArg && (optionArg.isVariadic || optionArg.isOptional !== true)) {
    return optionArg;
  }
  const subcommandArg = state.subcommandArgState?.args?.[state.subcommandArgState.index];
  return subcommandArg ?? optionArg ?? null;
}

/** 非可重复选项已传过 → 不再候选（镜像上游 suggestions 过滤语义）。 */
function isOptionExhausted(
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

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    if (typeof first === "string") return first;
  }
  return null;
}

/** token 的行尾收敛长度（节点缺偏移时的 fallback）。 */
function lineLengthOf(token: ParserCommandToken | undefined): number {
  return typeof token?.node?.endIndex === "number" ? token.node.endIndex : 0;
}

function mapArgSuggestionKind(type: unknown): CompletionItemKind {
  if (type === "file") return "file";
  if (type === "folder") return "directory";
  if (type === "subcommand") return "subcommand";
  if (type === "option") return "option";
  return "argument";
}

function safeIndex(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.isFinite(fallback) ? fallback : minimum;
  }
  return Math.max(minimum, Math.min(value, Number.MAX_SAFE_INTEGER));
}

// ---------------------------------------------------------------------------
// 默认实例（Lane A' 的注入来源；单测可经 createFigCompletionSource 换 fixture）
// ---------------------------------------------------------------------------

export function createFigCompletionSource(
  options: FigSourceOptions = {},
): FigCompletionSource {
  return new FigCompletionSourceImpl(options);
}

export const figCompletionSource: FigCompletionSource = createFigCompletionSource();

export default figCompletionSource;
