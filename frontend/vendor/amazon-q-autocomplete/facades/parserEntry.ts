// dbx-plugin-ssh facade（非上游代码）：`frontend/vendor/autocomplete-engine/parser.js`
// 的打包入口（sync 脚本以本文件为 entry 用 vite 打出单文件 browser-safe ESM）。
//
// 设计要点（详见 docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md 与 NOTICE.fig.txt）：
// - 语义权威是上游 `parseArguments.ts` 的 `updateState` 状态机（别名/持久选项/
//   变参/嵌套子命令/`--`/`--flag=value` 全在上游代码内，本插件不自研）；
// - 上游 `parseArguments()` 顶层是 async（fs/CDN spec 加载 + generator 执行），
//   冻结的 `FigCompletionSource.resolve` 是同步接口；故这里只导出状态机原语，
//   由 `figCompletionSource` 组装同步驱动（spec 来源换成 manifest 注册表）；
// - 上游 `updateState` / `getInitialState` 原为模块私有，vendored 快照中仅增加
//   `export` 关键字（语义零改动，清单见 NOTICE.fig.txt）。

export {
  TokenType,
  createArgState,
  updateArgState,
  getResultFromState,
  optionsAreEqual,
  countEqualOptions,
  flattenAnnotations,
  findOption,
  findSubcommand,
  updateState,
  getInitialState,
} from "../packages/autocomplete-parser/src/parseArguments.js";

export type {
  Annotation,
  ArgumentParserResult,
  ArgumentParserState,
} from "../packages/autocomplete-parser/src/parseArguments.js";

export { getCommand } from "../packages/shell-parser/src/command.js";
export type { Command, Token } from "../packages/shell-parser/src/command.js";

export { SuggestionFlag } from "@aws/amazon-q-developer-cli-shared/utils";
export type { SuggestionFlags } from "@aws/amazon-q-developer-cli-shared/utils";

// spec 归一化（上游 npm 依赖 @fig/autocomplete-shared，原样 vendored）：
// 把语料中数组形态的 subcommands/options 归一为 record，并补齐缺省字段。
export {
  convertSubcommand,
  initializeDefault,
} from "@fig/autocomplete-shared";
