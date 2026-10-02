# IMPL PLAN：Warp AI 命令体验对齐（`#` 命令搜索 / 报错 AI 修复 / 唤起 AI 助手）

> 状态：提案（2026-10-02）。本文只钉契约与分期，不含实现。
> 前置：Warp 输入体验批（ghost/建议浮层/history 面板/Ctrl+R/Ctrl+Space）已对齐，见 FEATURE_PARITY「终端」区块。

## 0. 目标与红线

把 Warp 的三条 AI 交互映射到本插件，**全部复用 DBX 宿主 AI 能力，插件零密钥、零模型配置**：

| Warp 体验 | 本插件对齐 |
| --- | --- |
| 命令行输入 `#` + 自然语言 → AI Command Suggestions | Feature A（§3）：`#` 前缀进入 AI 命令搜索模式，发起宿主 AI 会话，结果**回填输入行由人执行** |
| 命令失败（非零退出码）→ Fix with AI | Feature B（§4）：非零退出码后输入行上方出修复条，一键带上下文唤起宿主 AI 面板 |
| Agent Mode / 唤起 AI 助手 | Feature C（§5）：热键 + Quick Select 联动唤起宿主 AI 面板；Agent 档走宿主 agent + 既有 MCP 审批门 |

**红线（全部为高危项，实现前需人工评审）**：
1. 插件不持有、不配置、不透传 AI 密钥/端点——一切走宿主 Settings → AI 的既有配置。
2. AI 生成的命令**永不自动执行**：只回填输入行（Ask 档）；Agent 档的执行权在宿主 agent + 既有 MCP `execPermissionMode=confirm` 审批门 + `ssh/agent/prompt` 终端挑战（`agentTerminal.ts`/`agent_approvals.rs`），插件不新增旁路。
3. 发送给 AI 的终端输出必须过**脱敏管线**（§4.3），且默认关闭、首次使用显式确认（远端输出出境是隐私敏感动作）。
4. 旧宿主能力缺失时全链路 optional 降级：`#` 放行为 shell 注释、修复条不出现、热键动作不注册——功能可降不可死（开发规范 2）。

## 1. 事实底座（2026-10-02 调研结论）

### 1.1 Warp 口径

- `#`：命令行键入 `#` 开始用自然语言描述要跑的命令，Warp 随打字给出 AI Command Suggestions（warp.dev/warp-ai）。接受后插入 Input Editor，执行仍需回车。
- 报错修复：命令失败后 block 上出现 AI 修复入口（Command Corrections / Fix with AI），解释错误并给出修正命令。
- Ctrl+R Command Search 已在本插件对齐（⌘⇧H/Ctrl+R → history 面板）；Warp 的统一面板还检索 agent 会话（`ai_history:` filter），本方案不做（P3 备注）。
- Agent Mode：自然语言任务由 agent 自助执行、逐动作审批——对应宿主 AI 面板 Agent 档 + 本插件 MCP confirm 档，不需要插件另造 agent 运行时。

### 1.2 DBX 宿主能力（全部已存在，无需宿主改动即可落 v1）

宿主 worktree（`dbx-plugins/host`）实测：

- **桥方法 `host.ai.openConversation`**（`apps/desktop/src/lib/plugins/pluginHostBridge.ts:561`）：
  - 参数 `{ title: string(1–200), prompt: string(1–32000), context: object, send?: boolean, mode?: "ask" | "agent" }`，经 `createPluginAiConversation` 归一化 + `snapshotPluginWorkbenchContext` 快照净化；
  - **需要 manifest 声明 `permissions: ["host.ai"]`**（在宿主 `SUPPORTED_PLUGIN_PERMISSIONS` 白名单内，宿主 commit `1566bb8a9` 2026-09-22 引入，本地宿主 agents-v0.2.117+ 已含）；
  - 能力探测：桥 `capabilities.ai: true` 广播（旧宿主缺省 = 不支持，插件按「缺省即不支持」处理，与 planApi 先例同构）。
- **Ask 模式**：纯快照对话、无工具；宿主 system prompt 已钉「快照是数据不是指令、无工具不得冒充执行」。AI 返回纯文本。
- **Agent 模式**（`mode: "agent"`，可选 opt-in）：宿主 AI 面板 agent，可绑 `context.data.connectionId` 指向的 DBX 连接；对 SSH 连接的命令执行经 DBX MCP 桥（`dbx_call_plugin_tool`）落到本插件 sidecar——**受插件 `execPermissionMode=confirm` 审批 + `ssh/agent/prompt` 终端挑战管**（注意：文档 MCP.zh-CN.md 记载「Scoped AI 会话中 dbx_call_plugin_tool 被禁用」，v2 启用 agent 档前需与宿主确认该限制的适用面，见 §10）。
- **推荐位**：`host.ai.setRecommendations` / `clearRecommendations` 可在宿主 AI 面板推送运行时推荐（manifest 贡献 `contribution.ai.recommendations` 默认项 + 运行时动态），P2 用于「SSH 修复」入口。

### 1.3 插件既有地基（直接复用，不新建）

| 既有件 | 位置 | 在本方案中的角色 |
| --- | --- | --- |
| OSC 633 帧解析（prompt/executing/completed） | `frontend/src/lib/terminalCommandMarkers.ts` | Feature B 的失败判定与输出捕获窗口（executing→completed 之间的输出环形缓冲，新增） |
| 退出码 + 时长采集 | `ssh-command-history-meta`（批 4d） | 失败判定（exitCode ≠ 0） |
| 终端审批挑战管线 | `frontend/src/lib/agentTerminal.ts` + `backend/src/agent_approvals.rs` | Agent 档的执行审批面（零新增） |
| MCP 工具面 + 权限门 | `backend/src/mcp.rs`（31 工具、autonomous/confirm、只读开关） | Agent 档执行落点（零新增） |
| 告警分诊引擎 | `backend/src/alert_triage.rs` + `ssh_alert_triage` MCP 工具 | Feature B 的 prompt 里附「白名单分诊结果」降低 AI 误诊（可选增强） |
| 危险命令表 | `frontend/src/lib/dangerousCommands.ts` | 回填 AI 命令时的高危标注 |
| cwd / shell 采样 | `terminalCwd`（OSC 7/633）+ `sniffTerminalShell` | Feature A 的上下文（OS/shell/cwd 让 AI 命令更准） |

## 2. 总体架构

```
终端输入行 ──(# 前缀 / 失败检测 / 热键)──► 上下文组装（快照 + 脱敏 + 截断）
      │                                        │
      │                              hostClient.ai.openConversation
      │                                        ▼
      │                            DBX AI 面板（宿主前端，Ask/Agent）
      │                                        │ Ask: 文本
      ◄── 用户复制/回填 ────────────────────────┘
      │                        Agent: 经 DBX MCP 桥 → ssh_exec → confirm 审批
      ◄── 审批挑战（既有 ssh/agent/prompt）────┘
```

插件前端新增一个薄封装（`frontend/src/lib/aiBridge.ts`）：
`aiAvailable(): boolean`（读桥 capabilities）、`openAiConversation(request)`（探测缺失时抛结构化错误）。宿主桥的 invoke 通道沿既有 `window.dbxPlugin` 面，无新协议方法——**sidecar 零改动**。

## 3. Feature A：`#` AI 命令搜索（Warp 同位）

### 3.1 UX 规格

1. 终端输入行首键入 `#`（空行或行首）时进入 **AI 搜索模式**：行内 ghost/建议浮层全部让位，光标行右侧渲染模式提示（`#` 记号 + 七语占位「描述要运行的命令…」）——纯前端渲染，`#` 字节**不发给远端**（离开模式才补发）。
2. 打字持续更新本地 query；回车 / `Ctrl+Space`（复用 completions 动作位）/ 点击行内按钮 = 发起：
   `openAiConversation({ title: "AI 命令搜索", prompt: <查询 + 指令模板>, context: { connectionId, query, cwd, shell, recentExit? }, send: true, mode: "ask" })`。
   指令模板钉死：要求 AI 只返回**单条可直接执行的命令** + 一行理由；多候选时列表化。
3. AI 面板返回后由用户复制；`send:false` 变体（设置可选「先编辑再发送」）只预填不发送。
4. 退出模式：`Esc` / 清空 `#` / 会话切换；`#` 后跟空格再打字仍属模式内（Warp 同）。行内有内容时键入 `#` 不触发（只在空行）。

### 3.2 降级矩阵

| 宿主状态 | 行为 |
| --- | --- |
| `capabilities.ai !== true`（旧宿主/web 模式） | `#` 按普通字符发远端（shell 注释语义天然安全），不渲染模式提示 |
| 宿主有 AI 面板但未配置 provider | `openAiConversation` 打开面板，宿主自身引导配置（插件不感知） |
| 设置开关「AI 命令搜索」关 | 同上放行，设置页入口置灰提示能力缺失 |

## 4. Feature B：报错 → 用 AI 修复（Warp Fix-with-AI 同位）

### 4.1 触发

- 判定：命令块 completed 帧带 `exitCode ≠ 0`（批 4d 已采集）；无 shell integration 的会话无 D 帧 → 不触发（诚实降级，不猜）。
- 门槛：非 alternate 屏、非命令运行中、`lastExitCode` 属于当前交互命令（排除 `grep` 故意非零 / `test` 等常见预期非零命令——首版用**白名单豁免表**（`test`/`grep`/`diff`/`cmp`/`set -e` 场景除外，纯函数可测）。

### 4.2 修复条 UI

- 失败后输入行上方出一条**非弹窗修复条**（形态同 ghost 键位胶囊/hint 行）：`✗ exit 1 · 用 AI 修复 (⌘⇧I)` + 关闭 ✕；单条，新失败覆盖旧条，用户执行任何新命令或 `Esc` 关闭即消失。不遮挡不抢焦点。
- 热键：注册表新增 `ai-fix` 动作（默认 macOS `Meta+Shift+I` / 其他 `Ctrl+Shift+I`，冲突扫描进编辑器）。

### 4.3 输出快照管线（隐私关键，先于 UI 实现）

1. 捕获：executing→completed 帧之间的输出文本进**环形缓冲**（新增，仅开启「AI 修复」开关时采集；默认关）。
2. 截断：尾部 ≤200 行 / ≤16 KiB（保尾部——错误摘要多在尾部；常量钉死）。
3. 脱敏（新增纯函数 `redactTerminalOutput`，`frontend/src/lib/outputRedaction.ts`）：
   - 正则面：`password[=:]\s*\S+`、`token[=:]`、`api[_-]?key[=:]`、`Bearer \S+`、`AKIA[0-9A-Z]{16}`、PEM 块、`//user:pass@` URL 凭据、IPv4 保留段可选；
   - 替换为 `***`；处理后的文本进 context，原始输出不出插件。
4. 首次使用确认（confirmDialog 既有件）：展示将发送的快照预览，用户确认后才发送；可勾选「不再询问」（pluginStore）。
5. 发送：`openAiConversation({ title: "命令修复：<命令前 40 字>", prompt: 修复模板, context: { connectionId, command, exitCode, cwd, redactedOutput, triage? }, send: true, mode: "ask" })`；triage 位为可选 `ssh_alert_triage` 白名单分诊结果（同进程内已有引擎，主线程调不起——P2 经 sidecar RPC 补，v1 留空）。

### 4.4 结果回路

AI 返回纯文本。v1 人工复制；增强（P2）：宿主 AI 面板的回复无结构化通道回插件，回填靠用户复制——**不做**跨面板抓取（脆弱且越权）。若 P3 宿主补「插件可读对话结果」桥，再考虑一键回填。

## 5. Feature C：唤起 AI 助手

1. 注册表新增 `ai-assist` 动作（默认 macOS `Meta+Shift+A` / 其他 `Ctrl+Shift+A`）：把「选中文本（有则）/ 当前屏尾部 40 行（脱敏）/ 或空上下文」作为快照打开 Ask 对话。
2. Quick Select 联动（WT-1 既有浮层）：选中项旁新增「问 AI」动作，带该条文本。
3. 设置页新增「AI 助手」分类（七语）：三个开关（命令搜索 / AI 修复 / 唤起）+ 输出采集授权状态 + 「清空不再询问」；能力缺失时整栏降级提示。
4. P2：AI 修复条出现时同步 `host.ai.setRecommendations` 推一张「修复上次失败命令」推荐卡（宿主 AI 面板入口）。

## 6. 清单与协议改动

- `manifest.json`：`permissions` 增 `"host.ai"`；`engines.host_api` 维持 `>=1.0.0`（`host.ai` 是桥 JS 能力非 manifest schema 字段，旧宿主拒绝的是**未知权限**——需确认旧宿主权限白名单是否含 `host.ai`：宿主本地 agents-v0.2.117（2026-09-22）起含；`engines.dbx` 下限是否上移到含该白名单的发行版，**由 integrator 定版时确认**（picker 先例 >=0.6.16 的做法）。
- `docs/PROTOCOL.zh-CN.md`：sidecar 无新方法；补一节「宿主 AI 通道（前端桥）」记录 context 快照契约与脱敏承诺。
- `docs/FEATURE_PARITY.zh-CN.md`：新增三行（对标 Warp AI Command Search / Fix with AI / Agent Mode 入口）。
- 新增七语文案：`aiSearch.*`（占位/按钮/降级提示）、`aiFix.*`（修复条/确认对话框/预览）、`aiAssist.*`、`terminalHotkeys.actionAiFix`/`actionAiAssist`、设置分类 `settingsNav.ai`。

## 7. 安全评审清单（高危项）

1. **远程命令执行链零变化**：AI 桥纯前端 → 宿主面板；插件 sidecar 不解析、不执行任何 AI 输出。Agent 档执行面=既有 MCP 工具 + 既有审批门，本方案不新增执行路径（评审点：确认无旁路）。
2. **数据出境**：终端输出脱敏管线单测钉死（含对抗样例：multiline PEM、URL 内嵌凭据、base64 密钥串）；快照预览让用户看到「将发送什么」；默认关。
3. **权限最小化**：`host.ai` 是宿主权限模型内最小新增；不申请 `host.data:read` 等无关权限。
4. **快照非指令**：prompt 模板显式声明上下文是数据（宿主 system prompt 已钉，插件模板不违逆）。

## 8. 测试与验收（仓库三件套标准）

- 单测：`outputRedaction`（脱敏+截断）、`aiSearchMode` 状态机（`#` 进入/退出/降级）、修复条触发判定（含白名单豁免）、热键注册表两动作、`aiBridge` 探测降级。
- smoke：`smoke_ui_mock.mjs` 走查——mock 宿主加 `capabilities.ai:true` 夹具：`#` 模式提示渲染 / Esc 退出 / 降级夹具下 `#` 放行；mock 失败命令（D 帧 exit 28 已有）出修复条 / 确认对话框 / 脱敏预览不含真实 secret。`smoke_ui_settings.mjs` 加设置栏走查。
- 后端：`cargo test` 零改动确认（无 Rust 面）。

## 9. 分期

| 期 | 内容 | 依赖 |
| --- | --- | --- |
| P0 地基 | `outputRedaction` + 执行期输出环形缓冲 + `aiBridge` 探测 + 三开关设置栏 + 热键两动作 + manifest 权限 | 无（纯本仓库） |
| P1 | Feature A（`#` 模式 ask）、Feature B（修复条 + 首次确认 + 发送）、Feature C（热键/Quick Select ask） | P0 + integrator 定版 engines.dbx 下限 |
| P2 | Agent 档 opt-in（连接级设置三档，复用 agentTerminalMode 心智）+ triage 上下文 + setRecommendations 推荐卡 | 与宿主确认 Scoped AI 会话禁用面（§10） |
| P3（需宿主新桥，另立契约提案） | `#` 逐字 inline 流式建议（Warp 完全体）：宿主补面向插件的流式 `ai.complete` 桥；Ctrl+R 面板纳 AI 会话历史 | 宿主侧开发 |

## 10. 开放问题

1. Scoped AI 会话（宿主 AI 面板内）调 `dbx_call_plugin_tool` 当前被禁——Agent 档对 SSH 的实际可用面需宿主侧结论后才能定 P2 范围。
2. 修复条的非零退出豁免表覆盖面（`grep`/`test`/`diff`/`ssh` 端错误等）需实机调参。
3. 输出采集环形缓冲对高频输出（`tail -f`）的性能预算：仅 completed 前 N KiB 即可，无需全量——实现时以常量钉死。
4. `engines.dbx` 下限版本号待 integrator 对照发行版定。

## 11. 宿主 AI 能力扩展清单（对照已发布的 host PR #10629，2026-10-02 盘点）

### 11.1 已发布、插件侧待吃进的能力（无需宿主再扩展）

t8y2/dbx#10629（合并于 2026-09-29）给插件桥新增**直连文本生成**面，SDK 注入
`api.ai.{listProviders, discoverModels, listModels, generateText}`：

| 能力 | 桥方法 | 能力位 | 限制 |
| --- | --- | --- | --- |
| 供应商列表 | `host.ai.listProviders` | `capabilities.aiModelDiscovery` | 仅 API 供应商（CLI Agent 排除） |
| 模型发现 | `host.ai.discoverModels(configId)` | `capabilities.aiModelDiscovery` | ≤2000 个；凭据宿主持有 |
| 已配模型列表 | `host.ai.listModels` | `capabilities.aiCompletion` | 仅 `{configId,name,model,isDefault}` |
| **文本生成** | `host.ai.generateText({configId,model,prompt})` | `capabilities.aiCompletion` | prompt ≤100k、输出 ≤16k 纯文本；**每次发送原生对话框确认**（插件名+模型）；systemPrompt 宿主钉死（数据非指令/无工具）；单工作台单并发；供应商错误泛化 |

对本插件的意义：原 P3 前提（「`#` 直出命令需宿主新桥」）**已失效**——`#` 模式
v2（免面板、生成即回填输入行）与 AI 修复直出都可落在 `generateText` 上，
仅需 `aiCompletion` 能力位探测。插件零新增权限（`host.ai` 已声明）。

### 11.2 仍需宿主扩展的 AI 能力（按优先级）

1. **生成取消 / 流式**（中优先）：`generateText` 为单轮阻塞、无 abort 桥。
   `#` 打字即建议（Warp 完全体）与长输出场景需要 `host.ai.generateTextStream`
   （onChunk + 取消）或至少 `host.ai.cancelGeneration(requestId)`。
2. **发送确认的会话内记忆**（高优先，体验）：每次 `generateText` 都弹原生
   确认框，对「失败修复条」这类高频入口过重。请宿主提供工作台级「本次会话
   记住该插件/模型的授权」（等价插件侧 fixConsent 的宿主原生版），保持
   「插件名 + 模型」首次明示。
3. **受限 system-prompt 附加段或任务类型枚举**（中低优先）：systemPrompt
   现被宿主钉死，格式指令只能塞 user prompt（可用但次优）。希望开放
   「插件附加指令段」（宿主限长/审白名单）或提供任务类型枚举
   （如 `command-generation` / `rewrite` / `classify`）让输出格式更稳。
4. **口径确认（非新能力）**：Agent 档对插件连接的工具面——`mode:"agent"`
   文档写「uses live tools … when available」，但 MCP.zh-CN 记载 Scoped AI
   会话禁用 `dbx_call_plugin_tool`。宿主给出准确口径后，插件侧 Agent 档
   （P2）即可接线。

### 11.3 明确不需要宿主扩展的（避免过度索取）

- **多轮对话回读**：`openConversation` 不回传模型输出是刻意设计；本插件
  三条体验均为单轮任务，`generateText` 已覆盖「结果回填」诉求。
- **凭据/供应商管理**：宿主已全权管理，插件侧永不接触（红线保持）。
- **模型发现**：已发布（见 11.1）。
- **推荐位**：`host.ai.setRecommendations`/`clearRecommendations` 桥已在，
  属插件侧 P2 待接线。
