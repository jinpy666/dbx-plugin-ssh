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
// - generator 声明位置（currentArg.generators）：resolve() 保持同步冻结接口
//   语义——静态候选照常给出，纯动态位返回 null（pass-through）；声明式
//   generator（script argv 数组形态）由 collectGenerators()（批次 2-1 新增，
//   不动冻结接口）产出槽位，经 GeneratorScheduler + hostClient 异步执行；
// - 任何异常吞掉返 null，绝不上抛（回归红线 §3.1）。

import { splitCommandLine } from "../core/tokenize";
import type {
  CompletionContext,
  CompletionResponse,
} from "../core/types";
import type { FigGeneratorSlot } from "./generatorScheduler";
import type {
  FigSourceRequest,
  FigSpecManifest,
  FigCompletionSource,
} from "./source";
import {
  buildCommandNameResponse,
  buildSpecItems,
} from "./figCandidates";
import {
  firstString,
  isRecord,
  lastAnnotationType,
  pickCurrentArg,
  safeFlatten,
  safeIndex,
} from "./parserUtils";
import { TokenType } from "./parserTypes";
import type {
  ParserArgument,
  ParserCommand,
  ParserEngineApi,
  ParserResult,
  ParserState,
  ParserSubcommand,
} from "./parserTypes";

// ---------------------------------------------------------------------------
// parser.js 的最小类型面与纯函数工具下沉至 parserTypes / parserUtils；候选
// 枚举（命令名 / spec 静态候选）下沉至 figCandidates。本文件只保留驱动：
// 上游状态机推进、loadSpec 换轨与冻结接口实现。
// ---------------------------------------------------------------------------

// @ts-expect-error — vendored parser 是无类型 JS 产物（见 vendor README / NOTICE）
import * as parserModule from "../../../../vendor/autocomplete-engine/parser.js";
// @ts-nocheck 无法只作用于单条 import；manifest 为生成物（自带 @ts-nocheck）
import generatedManifest from "../../../../vendor/fig-specs/spec-manifest.generated";

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
      return this.analyzeOrThrow(request).response;
    } catch {
      return null; // 回归红线 §3.1：任何异常不外抛
    }
  }

  /**
   * 批次 2-1：当前请求位置的声明式 generator 槽位（不动冻结接口的第二通道，
   * 由 GeneratorScheduler 消费）。仅产出 script 为 argv 数组形态的声明式
   * generator（§16 allowShellScript=false：字符串/函数形态属 shell script /
   * custom JS，本批次不执行；template 生成器属文件 provider 领域，亦不产出）。
   * 任何异常 → []（调用方按无槽位处理，绝不抛）。
   */
  collectGenerators(request: FigSourceRequest): FigGeneratorSlot[] {
    try {
      return this.analyzeOrThrow(request).slots;
    } catch {
      return [];
    }
  }

  private analyzeOrThrow(request: FigSourceRequest): {
    response: CompletionResponse | null;
    slots: FigGeneratorSlot[];
  } {
    const { line, requestId, revision } = request;
    if (typeof line !== "string" || line.length === 0) return { response: null, slots: [] };

    // 冻结 tokenize：行级判定（空行/无 token 直接 pass-through）。
    const split = splitCommandLine(line);
    if (split.tokens.length === 0) return { response: null, slots: [] };

    // 上游 shell-parser：行 → 命令节点（光标所在命令；`git status && docker `
    // 这类多段行只对当前段补全）。token 节点携带 buffer 绝对偏移。
    const command = engine.getCommand(line, EMPTY_ALIASES, line.length);
    if (!command || command.tokens.length === 0) return { response: null, slots: [] };

    const tokens = command.tokens;
    const lastToken = tokens[tokens.length - 1];

    // 单 token 且非行尾空白：正在敲命令名 → 用 manifest 命令名补全。
    if (tokens.length === 1 && !split.trailingSpace) {
      return { response: this.commandNameResponse(request, command, tokens[0].text), slots: [] };
    }

    const rootName = tokens[0].text;
    let rootSpec = this.lookupSpec(rootName, new Set());
    if (!rootSpec) {
      if (tokens.length === 1) return { response: this.commandNameResponse(request, command, rootName), slots: [] };
      return { response: null, slots: [] }; // 无 spec 命中 → pass-through（不造假候选）
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
      if (!rootSwapped) return { response: null, slots: [] };
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
        return { response: null, slots: [] }; // token 无法消费（上游语义）→ pass-through
      }
      const swapped = this.applySyncLoadSpec(state, token, visitedLoadSpec, argBefore);
      if (swapped === null) return { response: null, slots: [] };
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
    if (!isRecord(result)) return { response: null, slots: [] };

    // 候选枚举（语义全部来自上游状态机：哪些类目可建议由 suggestionFlags 决定）。
    const items = buildSpecItems({ engine, sourceId: this.id, result, token: lastToken, lineLength: line.length });

    // generator 声明参数位（currentArg.generators）：resolve() 静态面不执行
    // generator（冻结同步接口），静态候选照常给出；完全无静态候选的动态位
    // → null 响应 + 槽位由 collectGenerators 异步通道执行（批次 2-1）。
    const currentArg = result.currentArg;
    const generatorOwned =
      !!currentArg && Array.isArray(currentArg.generators) && currentArg.generators.length > 0;
    const slots = this.generatorSlotsOf(result, command, line.length);
    if (items.length === 0) {
      if (generatorOwned) return { response: null, slots };
      // isCommand/isModule 参数位（如 `sudo `）：静态可补的是 manifest 命令名。
      if (currentArg && (currentArg.isCommand || typeof currentArg.isModule === "string") && !currentArg.isScript) {
        return { response: this.commandNameResponse(request, command, result.searchTerm ?? ""), slots: [] };
      }
      return { response: null, slots: [] }; // 无命中 → pass-through
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
      response: {
        requestId,
        revision,
        state: "ready",
        context,
        items,
      },
      slots,
    };
  }

  /** currentArg.generators 中的声明式子集 → 槽位（script argv 数组 +
   * splitOn + spec 原生 postProcess + 编辑/缓存上下文）。template 生成器、
   * 字符串/函数 script 不产出（§16/§17/批次 3 边界）。 */
  private generatorSlotsOf(
    result: ParserResult,
    command: ParserCommand,
    lineLength: number,
  ): FigGeneratorSlot[] {
    const arg = result.currentArg;
    if (!arg || !Array.isArray(arg.generators)) return [];
    const lastToken = command.tokens[command.tokens.length - 1];
    const tokenStart = safeIndex(lastToken.node?.startIndex, lineLength, 0);
    const tokenEnd = safeIndex(lastToken.node?.endIndex, lineLength, lineLength);
    const flattened = safeFlatten(engine, result.annotations);
    const commandPath = flattened
      .filter((a) => a.type === TokenType.Subcommand)
      .map((a) => a.text);
    const rootName = command.tokens[0]?.text ?? "";
    const primaryName = firstString(result.completionObj?.name) ?? rootName;
    const prefix = typeof result.searchTerm === "string" ? result.searchTerm : "";
    const slots: FigGeneratorSlot[] = [];
    for (const raw of arg.generators) {
      if (!isRecord(raw)) continue;
      const script = raw.script;
      if (!Array.isArray(script) || script.length === 0) continue;
      if (!script.every((entry) => typeof entry === "string")) continue;
      slots.push({
        script: script.filter((entry): entry is string => typeof entry === "string"),
        ...(typeof raw.splitOn === "string" && raw.splitOn.length > 0 ? { splitOn: raw.splitOn } : {}),
        ...(typeof raw.postProcess === "function" ? { postProcess: raw.postProcess as FigGeneratorSlot["postProcess"] } : {}),
        command: primaryName || null,
        commandPath,
        prefix,
        tokenStart,
        tokenEnd,
      });
    }
    return slots;
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
    return buildCommandNameResponse({ manifest: this.manifest, sourceId: this.id, request, command, searchTerm });
  }

}

const EMPTY_ALIASES: Readonly<Record<string, string>> = Object.freeze({})

// ---------------------------------------------------------------------------
// 默认实例（Lane A' 的注入来源；单测可经 createFigCompletionSource 换 fixture）
// 导出类型保持实现类：App 的 generator 通道需要 collectGenerators（批次 2-1
// 第二通道）；实现类可赋给冻结接口 FigCompletionSource，接缝不受影响。
// ---------------------------------------------------------------------------

export function createFigCompletionSource(options: FigSourceOptions = {}): FigCompletionSourceImpl {
  return new FigCompletionSourceImpl(options);
}

export const figCompletionSource = createFigCompletionSource();

export default figCompletionSource;
