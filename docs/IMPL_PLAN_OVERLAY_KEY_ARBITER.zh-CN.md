# 实施计划：终端浮层键权仲裁器（Overlay Key Arbiter）

> 目标：把终端区四个浮层（历史面板 / 引导条 / ghost 建议 / 命令建议浮层）对手工
> 维护的互斥布尔矩阵，收口为**单一优先级表仲裁器**——「当前 ↑ 归谁、↓ 归谁、
> → 接受归谁、Esc 归谁、锚点归谁、键入归谁」在一个函数里可查、可测、可画图。
> 这是架构评审（2026-10，双通道）给出的最高优先还债项：#150/#152 的整个返工
> 周期证明缺陷不在单点实现，而在互斥关系的组合复杂度已超过手工维护能力——
> 第 N 个浮层的集成成本是 O(N) 次手工编辑 × O(N²) 测试组合。
>
> 状态标记：✅ 已完成 / 🔜 待实施 / ⛔ 明确不做（含理由）。
> **状态（2026-10-05）：✅ 已实施（S1–S3 三个提交：仲裁器纯函数+快照 spec →
> 历史面板+引导条接线 → 其余五浮层全量接线）。实施偏差（均已在代码注释说明）：**
> ① 键维度按真实拓扑拆为七个——enter/tab/accept(→族) 三分，因三者让位规则不同
> （ghost 对 completion 不让 → 却让 Tab；补全 Enter 恒透传）；② §1.2 的初版
> 优先级表在快照守卫下被证伪两处（面板分支实际位于补全/建议之后、搜索/胶囊
> 菜单之前），已按真实链序重排——快照先行的价值即在此；③ ghost 的 → 族接受
> 分支不查表（Ctrl+F/Ctrl+E 无键维度，其组合键条件即让位编码的另一半），
> 其 Tab/Esc 维度照常由 claims 表达。

## 0. 现状与问题（证据）

| 浮层 | 判定入口 | 门数量 | 键位占用声明 |
| --- | --- | --- | --- |
| 历史面板 | `historyPanel.ts:256` `HistoryPanelGates` / `:278` `canOpenHistoryPanel` | 8 | `:232` `resolveHistoryPanelKey`（↑↓/Enter/Esc，open 态独占） |
| 引导条 | `terminalPromptHints.ts:48` `PromptHintsGates` / `:74` `shouldShowPromptHints` | 11 | 无键占用（纯展示），但有屏幕锚点（`:119` above/below 放置） |
| ghost 建议 | `terminalGhostSuggest.ts:178` `evaluateGhost`（9 门）+ `:210` `ghostMenuSuppressed` | 9+1 | `classifyGhostInput`（→ 接受词块、Esc 关闭） |
| 命令建议浮层 | `suggestionGuard.ts:88` `canShowSuggestions`（含锁存状态机） | 6 | 建议打开时 ↑↓/Enter/Esc 由浮层消费 |

问题形态（评审原文归纳）：

1. **互斥关系分散且手工**：每个新浮层要在其余每一个的门列表里加自己，并声明
   自己对 ↑/↓/→/Esc 的占用。加第 5 个浮层（如 ghost 词接受、AI 搜索、trzsz 传输条）
   预计还要改 4 处门 + 1 处新门。
2. **同一信号多头采样**：`interactivePromptPending` / `passwordPromptOnScreen` /
   `commandRunning` / `transferBusy` 等在 App.vue 一个 hub（约 `App.vue:7690-7748`）
   集中采样后逐组件分发——采样是好的，但「谁该让位」的决策散在四个模块里。
3. **回归史**：#150（↑↓ 在交互提示待答时抢键）、#152（历史面板与光标行的
   放置/钳高三连修）的返工全部落在这个矩阵上。
4. **on-call 不可视**：查「为什么 ↑ 不进历史面板」要同时读四个模块的布尔式。

## 1. 设计

### 1.1 核心类型与唯一决策函数

```ts
// frontend/src/lib/overlayArbiter.ts（✅ 已实施：纯函数，无依赖）

export type OverlayId = "historyPanel" | "promptHints" | "ghost" | "suggestion" | "completion" | "quickSelect" | "search";
// 实施定稿为七个维度：enter/tab/accept(→族) 三分（让位规则不同，见 §1.2）。
export type ClaimKey = "arrowUp" | "arrowDown" | "enter" | "tab" | "accept" | "escape" | "anchor";

/** 一个浮层对某个键维度的一次声明。visible 由现有各模块的 can* 布尔照旧给出。 */
export interface ArbiterClaim {
  overlay: OverlayId;
  key: ClaimKey;
  /** 数值越大优先级越高；同键维度取最大者获胜，全 false 时无人持有。 */
  priority: number;
  visible: boolean;
}

/** 唯一决策点：给定全部声明，返回每个键维度的持有者。 */
export function resolveKeyOwners(claims: readonly ArbiterClaim[]): Record<ClaimKey, OverlayId | null>;
```

### 1.2 优先级表（✅ 已按实施定稿；初版两处链序误读被 S1 快照守卫纠正）

| ClaimKey | 优先级（高→低） | 说明 |
| --- | --- | --- |
| `arrowUp` / `arrowDown` | completion(400) > suggestion(300) > historyPanel(200) > quickSelect(100) | 面板关闭时的裸 ↑ 唤起是同 overlay 的另一条 claim（可见性=唤起门；#150 待答态判 false 即无人持有，↑ 归远端） |
| `enter` | completion(400) > suggestion(300) > historyPanel(200) > quickSelect(100) | 补全 Enter 恒透传是其 handler 内语义，所有权不变 |
| `tab` | ghost(500，可见性含 !completionOpen) > completion(400) > suggestion(300) > historyPanel(200) | 「Tab 接受建议」开关在菜单开着时不生效——让位编码在可见性 |
| `accept`（→ 族） | ghost(500，唯一 claimant) | 词块/整段接受分支本体不查表（Ctrl+F/Ctrl+E 无维度） |
| `escape` | completion(400) > suggestion(300) > historyPanel(200) > search(150) > ghost 键位胶囊(140) > quickSelect(100) | 链序：面板分支先于搜索/胶囊菜单 |
| `anchor` | promptHints(100，唯一 claimant) | 其他浮层在场由其 overlayOpen 门置不可见，仲裁器兜底 |

关键原则：**四模块的判定逻辑原样保留**（它们各有完整 spec），仲裁器只把
「各自 can* 输出 + 键位声明」收口为单一决策点。这不是重写判定，是收口消费。

### 1.3 接线（App.vue 侧）

- hub 采样结果（`App.vue:7690-7748` 一带）组装 `ArbiterClaim[]` 一次，四浮层的
  open/展示与按键路由全部改读 `resolveKeyOwners` 的结果。
- xterm `attachCustomKeyEventHandler` 的 ↑/↓/→/Esc 分支改查仲裁器持有者——
  分支数从「每浮层一套 if」收敛为「查表分发」。

## 2. 迁移步骤（✅ 已完成；每步一个提交，独立可回滚）

| 步骤 | 内容 | 验收门 | 状态 |
| --- | --- | --- | --- |
| S1 | 新增 `overlayArbiter.ts` + spec（含优先级表快照用例：#150/#152 的回归场景在 mock 断言键权归属） | 前端三件套 + smoke_ui_mock/settings all green | ✅ a622f776 |
| S2 | 历史面板 + 引导条接入 | 同上 + #152 场景回归 | ✅ 3c7cf602 |
| S3 | ghost/补全/建议/quick-select/搜索接入（ghost → 族两分支按 §1.2 注保留组合键条件） | 同上 + #150 场景回归 | ✅ bb73cc84 |
| S4 | 收尾：路由查表核对（7 分支全部 owner 门）、§1.2 定稿回写、全量管线 | scripts/test.sh --skip-host all green | ✅ 本提交 |

实施修正记录：S1 快照守卫纠正了两处 §1.2 初版的链序误读（面板 vs 补全/建议/
搜索/胶囊菜单的先后），见文首状态注 ②；键维度由五个扩为七个，见状态注 ①。

## 3. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 优先级表定错（如 ghost 菜单压过建议浮层） | 表是**数据**不是逻辑：S1 的快照用例把 #150/#152 全部历史场景钉死，改表先改用例，review 一眼可见 |
| 迁移期双轨不一致 | S2-S4 每步只接一或两个浮层，旧门在接入步删除而非冻结并存 |
| App.vue 接线失误引入新抢键 | S4 后 `attachCustomKeyEventHandler` 只剩查表分发，可 grep 验证无残余分支 |

## 4. 明确不做（⛔）

- 不引入事件总线/响应式 store：浮层状态本就集中在 App.vue，仲裁器保持纯函数。
- 不迁移 `suggestionGuard` 的锁存状态机与 ghost 的输入分类：那是判定不是键权，
  收口消费即可，动了反而扩大回归面。
- 不做浮层 z-index/绘制顺序统一：与本债务无关，现状无问题。

## 5. 验收标准

1. `resolveKeyOwners` 对 #150/#152 全部历史场景给出与修复后现状一致的键权归属
   （快照用例）。
2. 四个浮层的 can*/evaluate 判定 spec 零改动全绿（判定未迁移的证据）。
3. 新增第 5 个浮层的演练用例（spec 注释形式）：只需一行 claim 声明，无既有门改动。
4. 全量 `scripts/test.sh --skip-host` all green。
