// parser.js 的最小类型面（自 figCompletionSource 纯搬移）：vendored 产物无
// 类型；防御性收敛，不污染全局命名空间。常量与接口逐符号与上游
// parseArguments.ts / shared/utils.ts 对齐（语义权威在 vendored 引擎，这里
// 只描述其形状）。

/** 上游 TokenType（parseArguments.ts）。 */
export const TokenType = {
  None: "none",
  Subcommand: "subcommand",
  Option: "option",
  OptionArg: "option_arg",
  SubcommandArg: "subcommand_arg",
  Composite: "composite",
} as const;

/** 上游 SuggestionFlag 位标志（shared/utils.ts）。 */
export const SuggestionFlag = {
  None: 0,
  Subcommands: 1 << 0,
  Options: 1 << 1,
  Args: 1 << 2,
  Any: (1 << 2) | (1 << 1) | (1 << 0),
} as const;

export interface ParserAnnotation {
  type: string;
  text: string;
  tokenName?: string;
  subtokens?: ParserAnnotation[];
}

export interface ParserTokenNode {
  startIndex: number;
  endIndex: number;
}

export interface ParserCommandToken {
  text: string;
  node: ParserTokenNode;
}

export interface ParserCommand {
  tokens: ParserCommandToken[];
}

export interface ParserArgument {
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

export interface ParserOption {
  name?: string[];
  description?: string;
  isRepeatable?: boolean | number;
}

export interface ParserSubcommand {
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

export interface ParserState {
  completionObj: ParserSubcommand;
  passedOptions: ParserOption[];
  annotations: ParserAnnotation[];
  optionArgState: { args: ParserArgument[] | null; index: number };
  subcommandArgState: { args: ParserArgument[] | null; index: number };
  haveEnteredSubcommandArgs: boolean;
  isEndOfOptions: boolean;
}

export interface ParserResult {
  completionObj: ParserSubcommand;
  passedOptions: ParserOption[];
  annotations: ParserAnnotation[];
  currentArg: ParserArgument | null;
  searchTerm: string;
  suggestionFlags: number;
}

/** parser.js 实际暴露面（由 vendor/amazon-q-autocomplete/facades/parserEntry.ts 冻结）。 */
export interface ParserEngineApi {
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
