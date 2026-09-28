# Lane A 细则（最终架构版）：fig 引擎接线 + legacy 退役

> 分支 `codex/ssh/fig-wave1-frontend-core`，基线 `codex/ssh/fig-wave1-base`。
> 冻结接口（只 import）：`core/types.ts`、`core/tokenize.ts`、`fig/source.ts`。
> 旧版细则中的 legacySpecAdapter / golden parity 章节**作废**；其余签名与 App.vue
> 锚点继续有效。先读：契约（最终架构版）、ROADMAP、FIG_VERIFICATION。

## 1. 目标 / 非目标

目标：fig 引擎（经 `FigCompletionSource` 接缝）成为结构化补全唯一来源；键盘/编辑
内核模块化；legacy `lib/completions/**` 整体退役；设置三态。

非目标：parser/manifest 实现（Lane C'）、generator 执行接线（批次 2）、worker
runner（批次 2）、overlay/定位改动、ghost 与历史建议（独立引擎，不动）。

## 2. 交付物

### 2.1 内核（签名沿用，仍有效）

- `core/edit.ts`：`applyEditToText(text, edit): {text, cursor}`、`trailingTokenEdit(text, token, addSpace): CompletionEdit`。
- `core/ranking.ts`：`rankItems(items)`（MAX_COMPLETION_ITEMS=20，score 降序 + label 字典序，纯函数）。
- `keyboard.ts`：`CompletionKeyboardState` + `resolveCompletionKey(state, key)`；契约 §2.2 表全组合表驱动单测（≥10 用例）。`activeItemKind` 语义：静态候选=accept；`hint`/loading/空=Tab passthrough；Enter 恒 passthrough。
- `CompletionController.ts`：`lineChanged/request/accept/dismiss/resetSession`；构造参数 `sessionId()/readLine()/enabled()/debounceMs?(默认90)/onResponse/onAcceptEdit`；纪律：三重 guard（revision+sessionId+requestId）、debounce 合并、异常降级 pass-through、`enabled()===false` 直接 pass-through。
- resolver = `FigCompletionSource`（注入构造）。本 lane 提供 `FakeFigCompletionSource`（测试用）；真实实现由 Lane C' 在集成分支接入。

### 2.2 legacy 退役（本 lane 独有删除权）

- 删除 `frontend/src/lib/completions/` **整目录**（spec.ts、specs/*、provider.ts、remoteFsProvider.ts、figImport.ts 及全部 *.spec.ts）。
- 清除 `App.vue`、`SettingsDialog.vue`、`pluginStore.ts`、`pluginStorage.spec.ts` 中 `ssh-completion-spec` 的一切引用。
- 门禁：`grep -rn "lib/completions" frontend/src` 与 `grep -rn "ssh-completion-spec" frontend/src` 均无结果。

### 2.3 fig 引擎接线

- App.vue：删除 `matchSpecLine / COMPLETION_SPECS / CompletionRow` 依赖；completion refs 迁 controller + `CompletionResponse`。
- 接线点（锚点=函数名，与旧版 §3 表一致）：`openCompletionMenu / handleCompletionKey / acceptCompletionRow / refreshCompletionMenu / trackPendingInput / replaceTerminalLineWith / refreshSuggestionsAfterInput`、Enter/Ctrl+C 清行点、ghost 接受点、会话切换（`resetSession`）。
- source 返回 null（无命中 / generator 动态位置）→ pass-through：菜单关、Tab 交 shell（§34，与旧 hint 行 UX 等价）。
- `CompletionMenu.vue`：props 迁移为 `items: CompletionItem[]` + `activeIndex` + anchor + viewport；emit `accept(item)` / `activate(index)`（方案 §24 映射：label/description/kind 直用，接受回传 `item.edit`）；同步更新 `CompletionMenu.spec.ts`。App.vue 侧把 item.edit 经 `applyEditToText` 应用后仍走 `replaceTerminalLineWith(nextLine, false)`（整行擦重打机制不变）。

### 2.4 设置与 i18n

- `pluginStore.ts`：删 `ssh-completion-spec`，增 `ssh-completion-engine`（`"fig-safe" | "fig" | "off"`，默认 `"fig-safe"`）。
- `SettingsDialog.vue`：结构化补全开关改为引擎 Select（reka-ui wrapper，参照同文件既有 Select 用法）；`off` = 无结构化浮层（历史/ghost 不受影响）；`fig` 与 `fig-safe` 批次 1 行为相同（差异自 generator 接线起），选项描述注明。
- `i18n.ts`：新增文案七语全补。

## 3. 测试

- edit / ranking / keyboard / controller 单测（旧版 §5 清单去掉 parity 项）。
- FakeFigCompletionSource 驱动 controller 全路径：ready / pass-through(null) / stale 丢弃 / 异常吞掉 / enabled=false / debounce 合并 / accept→onAcceptEdit 边界正确。
- `CompletionMenu.spec.ts` 更新为 items props。
- 既有其余测试零回归（删除 legacy 目录连带其 spec 文件属预期，不计回归）。

## 4. 验收

1. `pnpm --dir frontend typecheck / test / build` 全绿。
2. §2.2 两个 grep 门禁通过。
3. 手动清单（dev + fake source；真实数据冒烟在集成分支做）：`git ch<Tab>` 静态候选、`git co<Tab>` 别名命中（fake 模拟）、无命中命令 Tab 透传、Enter 恒执行、Esc 关闭、`off` 全关、历史/ghost 不受影响。
