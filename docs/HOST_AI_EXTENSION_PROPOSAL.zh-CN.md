# HOST AI EXTENSION PROPOSAL：插件 AI 调用能力扩展提案（io.dbx.ssh / Terminal 插件）

> 状态：提案（2026-10-02）。基于宿主 main `a55f307ec` 的桥实现实测
> （`apps/desktop/src/lib/plugins/pluginHostBridge.ts`、`pluginAiCompletion.ts`、
> `PluginWorkbenchHost.vue`），对照本插件已上线的三条 AI 体验（`#` 命令搜索 /
> 失败命令修复 / 唤起助手）逐项给出「体验不足 → 根因 → 扩展项 → 契约草图」。
> 全部扩展均为**增量式**：能力位探测、旧宿主缺省即回退现有面板/直连路径，无破坏性。

## 0. 现状基线（本插件已在用的宿主面）

| 面 | 方法 / 能力位 | 用途 | 已知限制（§1 的根因） |
| --- | --- | --- | --- |
| 面板会话 | `host.ai.openConversation`（`capabilities.ai`） | 快照对话（ask/agent）、推荐位 | 快照只进不出（无结果回读） |
| 直连生成 | `host.ai.listProviders`/`discoverModels`/`listModels`/`generateText`（`aiModelDiscovery`/`aiCompletion`，**仅 Tauri 运行时**） | `#` 搜索、修复直出 | 单轮阻塞、逐次确认、systemPrompt 钉死、2048 token/16k 上限 |

## 1. 体验不足清单（按用户可感知度排序，均可溯源到宿主实现）

| # | 不足 | 用户可感知的表现 | 宿主根因 |
| --- | --- | --- | --- |
| S1 | 直连生成**每次发送都弹原生确认框**，且只报「插件名 + 模型」不显示将发送什么 | 失败修复条是高频入口（每次命令失败都可能触发），逐次弹窗打断心流；想确认隐私时又看不到内容 | `PluginWorkbenchHost.confirm` 逐次 `tauri ask`；对话框无 prompt 预览、无会话内记忆 |
| S2 | `#` 搜索与修复是「单轮阻塞」：发起后插件侧无进度、无法取消、生成中不能改 prompt | 长生成时终端像卡死；打错发起只能等 | `pluginAiCompletion` busy 锁 + 单次 `complete` await，无 abort/stream |
| S3 | **无流式**：`#` 做不到 Warp 式「打字即出建议」，只能回车后整段等待 | 与 Warp 的核心体感差距（我们因此把 `#` 默认关） | 同 S2，宿主无流式面 |
| S4 | systemPrompt 被宿主钉死（"plain text… no tools"），**格式指令只能塞 user prompt** | 「只回一条命令 + Why 行」的输出格式靠 prompt 恳求，稳定性次优；偶尔模型多话导致解析首行失败 | `pluginAiCompletion.generateAiText` 内部固定 systemPrompt，请求面无 system 字段 |
| S5 | 输出硬上限 2048 token / 16000 字符 | 单命令场景够用；「多步修复方案」类长诊断被截断抛错 | `complete({maxTokens: 2048})` + 16k 校验 |
| S6 | **web/docker 运行时无直连生成** | web 部署形态下修复/搜索全部回退面板会话（多一次面板跳转 + 手动复制） | `PluginWorkbenchHost` 仅 `isTauriRuntime()` 注入 `aiCompletion`（complete 走 Tauri 后端） |
| S7 | 面板会话**结果不可回读**：「分析这段输出」的深度分析结果无法一键回到终端，用户手动复制 | 面板流（ask/agent）与终端流割裂 | `openConversation` 契约明确 "never hands model output back to the plugin" |
| S8 | 插件无法感知 Agent 档在连接上执行了什么 | 终端场景希望展示「AI 刚在你的连接上执行了 X」（透明度/审计联动） | agent 工具执行事件只进宿主面板，无插件侧桥事件 |

## 2. 扩展项（贡献点 + 桥 API，全部增量兼容）

### E1 生成取消 + 流式（解锁 S2/S3；优先级：中高）

```
host.ai.generateTextStream({ configId, model, prompt, requestId })  → 首块即返
host.ai.onGenerationChunk(requestId → { delta, done })              → 增量事件
host.ai.cancelGeneration(requestId)                                  → 取消
能力位：capabilities.aiCompletionStream
```
- 宿主侧复用既有 `complete` 管线换流式端点；确认框仍每请求一次（与 E2 正交）。
- 解锁插件特性：`#` v2「打字即出建议」（Warp 完全体）、修复长诊断分段渲染、取消重试。

### E2 发送确认的会话内记忆 + 数据预览（解锁 S1；优先级：**高**——纯 UX，改动最小收益最大）

- `confirm` 对话框增加：**prompt 首行 + 字节数 + 上下文标签（连接名/cwd）**的预览区；新增「本工作台内不再询问」（会话级记忆，宿主持有，插件不可篡改）。
- 契约不变（`generateText` 签名不动），纯宿主 UX 改动；可按插件维度配置豁免（设置页），默认仍逐次确认。

### E3 受限 system 附加段或任务枚举（解锁 S4；优先级：中）

二选一（枚举更可控，建议先做枚举）：
```
generateText({ ..., systemAddendum })   // ≤2000 字符，宿主过滤控制字符，拼接在钉死段之后
generateText({ ..., task: "command-generation" | "rewrite" | "classify" })  // 宿主内置模板
```
- `command-generation` 模板即宿主替所有终端类插件钉「first line = exact command; then `Why:` line」——一处优化全生态受益。

### E4 输出预算可按任务放宽（解锁 S5；优先级：低）

- `generateText` 增加可选 `maxTokens`（宿主钳制上限，如 8192），或随 E3 的 task 枚举内置。仅长诊断场景需要。

### E5 面板会话结果回读（解锁 S7；优先级：中）

- `openConversation({ ..., requestResult: true })`：面板在用户点击「回传给插件」后，经桥事件
  `host.ai.conversationResult → { conversationId, text }` 交付最终文本。
- 保持快照安全边界：回传是**用户显式动作**，宿主只搬运不解析；无 `requestResult` 时行为与现状完全一致。

### E6 web 运行时直连对齐（解锁 S6；优先级：中）

- `aiComplete` 已是后端 RPC；web 后端补同一端点后，`PluginWorkbenchHost` 的
  `isTauriRuntime()` 门放宽为「运行时具备 aiComplete 通道」。插件侧零改动（能力位自动亮）。

### E7 Agent 执行事件桥（解锁 S8；优先级：低，可延后）

- `host.ai.onAgentToolEvent`（仅 agent 档会话）：工具名/命令摘要/审批结果，供终端插件做透明度展示与审计联动。涉及面较大，建议独立 PIP 评审。

### C1 manifest 贡献点：`contribution.ai.completion` 声明（配套 E2/E3）

```jsonc
"ai": { "completion": { "purpose": "generate shell command fixes from redacted failure output", "dataClasses": ["command", "exit-code", "redacted-output-tail"] } }
```
- 宿主确认对话框展示 `purpose`（替代泛化文案）；`dataClasses` 为未来细粒度授权/审计留钩子。缺声明时行为不变（向后兼容）。

## 3. 优先级与解锁矩阵

| 扩展项 | 优先级 | 工作量（宿主侧粗估） | 解锁的插件特性 |
| --- | --- | --- | --- |
| E2 确认记忆+预览 | **高** | S（纯宿主 UX） | 修复条高频入口顺滑化；隐私可见性 |
| E1 流式+取消 | 中高 | M | `#` v2 打字即建议；取消/重试；分段渲染 |
| E3 任务枚举 | 中 | S–M | 命令生成格式稳定 → 直连回填可靠化 |
| E5 结果回读 | 中 | M | 面板深度分析一键回终端 |
| E6 web 对齐 | 中 | M（web 后端端点） | web/docker 部署全功能 |
| E4 预算放宽 | 低 | S | 多步修复方案 |
| E7 Agent 事件桥 | 低 | L | 终端透明度/审计联动 |
| C1 贡献点声明 | 随 E2/E3 | S | 授权粒度与审计基础 |

## 4. 兼容性承诺（插件侧已就绪）

- 本插件所有消费点按 `capabilities.*` 探测，缺省即回退现有路径（直连↔面板双通道已上线并
  有 smoke 覆盖）——宿主按任意顺序、任意子集落地上述扩展均不破坏现有体验。
- 落地顺序建议：**E2 →（E3，E1 并行）→ E5/E6**；E2 单独即可把修复条入口的体验摩擦消掉大半。
