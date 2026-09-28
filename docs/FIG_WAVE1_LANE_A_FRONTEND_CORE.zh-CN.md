# Lane A 细则：前端补全核心（frontend-core）

> 分支 `codex/ssh/fig-wave1-frontend-core`，基线 `codex/ssh/fig-wave1-base`。
> 先读：`FIG_WAVE1_CONTRACT.zh-CN.md`、`FIG_ROADMAP.zh-CN.md`、`FIG_VERIFICATION.zh-CN.md`。
> 冻结类型 `frontend/src/lib/completion/core/types.ts` 只 import 不改。

## 1. 目标 / 非目标

目标：把补全的「解析→候选→键盘→接受」从 App.vue 收进可测试的模块层，
行为与 HEAD **零回归**；为 wave 2 的 fig provider / generator 接线留好插槽。

非目标：Worker 化、fig spec 接线、动态 provider 行为变更、overlay/定位改动、
`lib/completions/spec.ts`（legacy parser）语义改动、build.mjs。

## 2. 新增文件与签名

### `frontend/src/lib/completion/core/edit.ts`

```ts
export interface AppliedEdit { text: string; cursor: number }
/** 把 CompletionEdit 应用到行文本；cursorOffset 缺省 = edit.text.length。 */
export function applyEditToText(text: string, edit: CompletionEdit): AppliedEdit
/** 行尾 token 替换的 edit 构造（legacy adapter 用；addSpace 时 text 尾补空格）。 */
export function trailingTokenEdit(text: string, token: string, addSpace: boolean): CompletionEdit
```

### `frontend/src/lib/completion/core/ranking.ts`

```ts
export const MAX_COMPLETION_ITEMS = 20;
/** score 降序、同分 label 字典序、截断；纯函数，引擎唯一排序出口。 */
export function rankItems(items: CompletionItem[]): CompletionItem[]
```

### `frontend/src/lib/completion/keyboard.ts`（契约 §4.2 的固化）

```ts
export interface CompletionKeyboardState {
  menuOpen: boolean;
  hasItems: boolean;
  /** 高亮项 kind：null=无高亮；"hint"=动态占位行（Tab 透传）。 */
  activeItemKind: CompletionItemKind | null;
  loading: boolean;
}
export type CompletionKeyAction = "accept" | "passthrough" | "next" | "prev" | "close" | "none";
export function resolveCompletionKey(state: CompletionKeyboardState, key: string): CompletionKeyAction
```

规则（必须表驱动单测全覆盖，缺一不可）：

| menuOpen | activeItemKind | Enter | Tab | ArrowUp/Down | Escape |
|---|---|---|---|---|---|
| true | subcommand/option/argument/… | passthrough | accept | next/prev | close |
| true | hint（或 hasItems=false / loading） | passthrough | passthrough | next/prev（仅 hasItems） | close |
| false | — | passthrough | passthrough | passthrough | none |

### `frontend/src/lib/completion/legacy/legacySpecAdapter.ts`

把 `matchSpecLine(line, COMPLETION_SPECS)` 包装成引擎 resolver：

```ts
export interface LegacyResolveInput { line: string; requestId: number; revision: number; sessionId: string }
export function legacyResolve(input: LegacyResolveInput): CompletionResponse
```

映射规则（**逐字段保真，零回归的根**）：

- `SpecMatch.rows[].kind`：`sub→subcommand`、`flag→option`、`value→argument`、`hint→hint`。
- `edit` = `{ text: row.token + (row.space ? " " : ""), replaceStart: match.replaceStart, replaceEnd: match.replaceEnd }`（fig-base 的 `SpecMatch` 已带精确边界，见 `lib/completions/spec.ts` `SpecMatch` 定义）。
- `label/description/score` 原样；`source: "legacy-spec"`；`id` 用 `legacy:{commandPath}:{label}:{i}` 稳定串。
- `context`：`command = commandPath[0] ?? null`，`tokenStart=match.replaceStart`，`tokenEnd=match.replaceEnd`。
- `matchSpecLine` 返回 null → `state: "pass-through"`、`items: []`（回落历史建议浮层，由 App.vue 现有逻辑处理）。
- rows 空（spec 命中无候选）同样 `pass-through`。

### `frontend/src/lib/completion/CompletionController.ts`

```ts
export interface CompletionControllerOptions {
  sessionId: () => string;
  readLine: () => string;              // 返回 pendingTerminalInput 当前值
  enabled: () => boolean;              // 总开关 + 引擎开关合成后的判定
  debounceMs?: number;                 // 默认 90
  onResponse: (response: CompletionResponse) => void;
  onAcceptEdit: (edit: CompletionEdit) => void;  // App.vue 执行终端写入
}
export class CompletionController {
  /** App.vue 在行缓冲每个变更点调用：revision++ 并调度 request("typing")。 */
  lineChanged(): void;
  request(trigger: CompletionTrigger): void;
  accept(item: CompletionItem): void;
  dismiss(): void;
  /** 会话切换：重置 revision/requestId，丢弃在途结果（sessionId guard）。 */
  resetSession(): void;
}
```

纪律（单测必须覆盖）：

1. 响应回来时 `requestId`、`revision`、`sessionId` 三者任一不匹配当前态 → 静默丢弃。
2. `resolve` 全程 try/catch；任何异常 → `state:"pass-through"` 空响应，绝不抛到调用方（PTY 红线）。
3. debounce 期间的多次 `lineChanged` 只发一次请求。
4. `enabled()===false` → 直接 pass-through，不调度。

wave 1 的 resolver 就是 `legacyResolve`；provider 链（fig）留 wave 2，不在本 lane 实现。

## 3. App.vue 接线（锚点为 fig-base 行号，允许 ±小漂移，以函数名为准）

| 位置 | 改造 |
|---|---|
| `COMPLETION_SPEC_ENABLED_KEY` ≈L913 / `completionSpecEnabled()` ≈L925 | 保留总开关；新增 `COMPLETION_ENGINE_KEY = "ssh-completion-engine"`，读值 `legacy`(默认)/`fig-safe`，wave 1 两种值都走 legacy resolver |
| `openCompletionMenu(match)` ≈L940 | 改为消费 `CompletionResponse`：items 映射进现有 `completionRows/Level/CommandPath/ActiveIndex/Anchor` refs（Level 由 context+activeKind 推导，保持现有三层展示语义） |
| `handleCompletionKey(event)` ≈L995 | 改为：构造 `CompletionKeyboardState` → `resolveCompletionKey` → 按 action 执行（accept 走 `controller.accept`；passthrough 返回 false；close `closeCompletionMenu`）。**Enter 恒放行、hint 行 Tab 放行的现语义必须保持**（由键盘单测背书） |
| `acceptCompletionRow(row)` ≈L1030 | 改为 `controller.accept(item)` → `onAcceptEdit(edit)` → `applyEditToText(pendingTerminalInput, edit)` → 沿用 `replaceTerminalLineWith(nextLine, false)`（整行擦重打的现机制不动）→ `controller.lineChanged()` 刷新 |
| `refreshCompletionMenu()` ≈L1050 / `refreshSuggestionsAfterInput()` ≈L3069 | 内层的 `matchSpecLine` 直调替换为 `controller.request("manual"/"typing")`；历史建议/ghost 分支**一行不动** |
| `trackPendingInput` ≈L3020 / `replaceTerminalLineWith` ≈L3230 / Enter/Ctrl+C 清行点 / ghost 接受点 | 每处行缓冲变更后补 `controller.lineChanged()`（一行调用，不改既有逻辑） |
| 会话切换/关闭 | `controller.resetSession()` |

## 4. 设置项与 i18n

- `frontend/src/lib/pluginStore.ts`：`PLUGIN_STORE_KEYS` 追加 `"ssh-completion-engine"`（本 lane 唯一允许改此文件的一行；B/C 不碰它）。
- `SettingsDialog.vue`：在现有 `ssh-completion-spec` 开关（≈L270）旁加引擎 Select（reka-ui wrapper，参照同文件既有 Select 用法）：`legacy` / `fig-safe`；`fig-safe` 项描述注明「wave 2 生效」。
- `i18n.ts`：新增 key（如 `settings.completion.engine`、`.engineLegacy`、`.engineFigSafe`、`.engineHint`）七语全补（zh-CN/zh-TW/en/es/it/ja/pt）。

## 5. 测试清单（`*.spec.ts` 同目录）

- `edit.spec.ts`：trailingTokenEdit 边界（尾空格/空行=纯插入点、引号 token、`--flag=val`）；applyEditToText cursorOffset。
- `ranking.spec.ts`：排序确定性、截断 20。
- `keyboard.spec.ts`：§2 表全组合（≥10 用例）。
- `legacySpecAdapter.spec.ts`：**golden parity**——对现有 `spec.spec.ts` 语料 + specs/index 全量 spec，断言 controller 输出与 `matchSpecLine` 直查在 label/kind/顺序/描述上逐一相等。
- `CompletionController.spec.ts`：三重 guard（revision/requestId/sessionId）、debounce 合并、异常降级 pass-through、accept→onAcceptEdit 的 edit 正确、enabled=false。
- 既有 `spec.spec.ts` / `CompletionMenu.spec.ts` 必须零修改通过。

## 6. 验收

1. `pnpm --dir frontend typecheck && pnpm --dir frontend test && pnpm --dir frontend build` 全绿。
2. 手动清单（UI mock 或 dev）：`git ch<Tab>` 填充、`git checkout -<Tab>` 进值层、hint 行 Tab 透传、Enter 恒执行、Esc 关闭、总开关关闭后零浮层——与 HEAD 行为一致。
3. 默认路径（无 `ssh-completion-engine` 存储）行为与 HEAD 完全一致（parity 测试背书）。
