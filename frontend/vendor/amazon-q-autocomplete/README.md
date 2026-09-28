# amazon-q autocomplete parser（vendored 快照）

DBX SSH/SFTP 插件 vendored 的 Fig 补全引擎（TypeScript parser 子树快照）。
本目录由 `scripts/sync_fig_specs.mjs` 生成/刷新；**除 `facades/` 外不要手改**。

## 来源（双 pin，见 `../fig-specs/snapshot.json`）

| 内容 | 仓库 | pin commit | 许可 |
|---|---|---|---|
| parser 子树 | `aws/amazon-q-developer-cli` | `5c621df6fd3112eb44da02132cde06cad25cb418` | MIT OR Apache-2.0 |
| specs 语料 | `withfig/autocomplete` | `aef52acff84c45edde61ae610cc2c964802b9a38` | MIT |

parser pin 说明：上游在 `09aa3cbad570f8fa89ce72c617721557fba4243e`
（"chore: remove autocomplete (#2224)"，2025-07-03）删除了整个 TS autocomplete
引擎；`5c621df6` 是**删除前最后一个包含该子树的 commit**（即引擎的最终状态）。
子树路径以该快照为准：`packages/autocomplete-parser`、`packages/shell-parser`、
`packages/shared`（packages/autocomplete 是 React UI 应用，不 vendored）。

## 目录

- `packages/autocomplete-parser/src/` — 语义引擎（spec 状态机：别名/持久选项/
  变参/嵌套/`--`/`--flag=value` 全在 `parseArguments.ts` 的 `updateState`）。
  对上游的两处非语义修改：给 `updateState`、`getInitialState` 增加 `export`
  （同步驱动入口，语义零改动，见 NOTICE.fig.txt）。
- `packages/shell-parser/src/` — shell 语法解析（`getCommand`：行 → 命令节点 +
  token，含 `startIndex/endIndex` 绝对偏移）。
- `packages/shared/src/` — `Internal` 类型与 utils（SuggestionFlag 等）。
- `facades/` — **本插件手写的隔离层（非上游代码）**，见下表。
- `../autocomplete-engine/parser.js` — sync 用 vite（rolldown）打包的单文件
  browser-safe ESM 产物。

## facades（上游宿主耦合点的剥离面）

| 上游模块 | facade | 行为 |
|---|---|---|
| `loglevel` | `loglevel.ts` | 静音 logger（debug/info 丢弃，error 转采集钩子） |
| `@aws/…-api-bindings` | `apiBindings.ts` | 仅类型（`Settings`），运行时空实现 |
| `@aws/…-api-bindings-wrappers` | `apiBindingsWrappers.ts` | `getSetting` 恒 false、`isInDevMode` false；`executeCommand` / `executeLoginShell` 抛 `unsupported`（批次 2 经 `completion/execute` 注入真实实现） |
| `./loadSpec.js`（相对别名） | `loadSpecStub.ts` | 文件系统/CDN spec 加载被 manifest 替代；同步驱动不经过此路径，误调用即抛 `unsupported` |
| `@fig/autocomplete-shared` | `../fig-npm/autocomplete-shared` | 上游 npm 依赖原样 vendored（spec 归一化 `convertSubcommand`/`initializeDefault`） |
| `@fig/autocomplete-generators` | `../fig-npm/autocomplete-generators` | 上游 npm 依赖原样 vendored（`filepaths`/`folders` 等标准 generator 声明） |

generator **执行**（custom/script）在批次 1 一律不运行：声明位置由
`figCompletionSource` 直接返回 null（pass-through），批次 2 经
`completion/execute` 在目标机执行。
