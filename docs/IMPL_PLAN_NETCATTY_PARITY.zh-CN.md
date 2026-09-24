# IMPL_PLAN — Netcatty 对标批次（MCP 权限档/作用域 · 聚合执行 · 关键词高亮 · 审计日志 · metrics 增强）

> **执行方式**：并发双工作包（A 后端 / B 前端，文件所有权不相交）+ 主会话收口（C）。
> 任务用 checkbox 跟踪；每个任务自带验证循环；契约以 §2 为准，A/B 不得自行改契约，
> 有异议回主会话裁决。
>
> **勾选状态注记（2026-09-25）**：checkbox 已按 `docs/PROGRESS-P-SSH.zh-CN.md` 的实际
> 完成记录校准——A1/A2/A3/A5/B1/B2 各项已勾（2026-09-12/13 批次落地与全绿回归）；
> A0（regex 依赖检查，实现走「后端仅形状校验」路线）、A4（审计改由并行批次
> `audit_log.rs` 承担，本批 §1.1 审计契约作废）、B3 收尾确认与 C 系收口保持未勾。

**目标**：落地 Netcatty 对标审阅（2026-09-11）用户选定五项——
① MCP 权限档（confirm）+ 连接作用域；② `ssh_multi_exec` / `ssh_terminal_input`
两个 MCP 工具；③ 终端关键词高亮规则；④ sidecar 审计日志落盘与工作台查看；
⑤ metrics 网络速率 sparkline + 发行版识别。

**架构**：后端全部落在 sidecar（mcp.rs 门禁扩展 + 两个新工具 + 两个新存储模块 +
metrics 采集扩展），前端全部落在 `frontend/`（两个新 lib 纯函数模块 + App.vue 挂点 +
i18n/mock 镜像）。无宿主改动、无新依赖（前端后端均零新增；`regex` crate 仅在
已在依赖树内时使用，见 A3）。

**技术栈**：Rust sidecar（russh，tokio）+ Vue3/Vite 前端（xterm.js 5）+ Python smoke。

**对标依据**：Netcatty `electron/mcp/netcatty-mcp-server.cjs`（permission mode /
scoped session ids / multi_host_execute / terminal_send_input）、
`infrastructure/services/CloudSyncManager.ts`（导出思路降维，本轮不做云同步）、
`components/ConnectionLogsManager.tsx`（审计）、README Features（关键词高亮）、
`TrafficDiagram.tsx` / `DistroAvatar.tsx`（metrics 增强）。对标结论原文见任务会话
2026-09-11 审阅记录；已完成项不再重复（分屏/Serial/Telnet/Mosh/端口转发均不在此批，
端口转发系 2026-09-07 用户决策不做，见 PROGRESS tssh 轮）。

## 0. 全局约束（每个任务默认携带）

- 协议方法 `<域>/<动作>`、字段 camelCase；新增方法与字段必须同步
  `docs/PROTOCOL.zh-CN.md` 与 `docs/MCP.zh-CN.md`（C 包统一收口）。
- 七语文案（zh-CN/zh-TW/en/es/it/ja/pt-BR）缺一不算完成；`workbench.spec.ts`
  的七语 key 一致性测试自动看护。
- 完成定义四件套：单测 + smoke 用例（未注册方法 SKIP 而非 FAIL）+ 对标清单
  （FEATURE_PARITY）更新 + 七语文案。
- 宿主只读：本轮零宿主改动；Host API 1.0 基线，optional 降级不引入。
- 安全红线：写操作过只读门；私钥/凭据只出指纹/布尔位；审计文件 0600；
  **禁止引入 Netcatty 的 SVG/图片资产（GPL-3.0 传染）**，发行版标识用纯 CSS monogram。
- 版本 bump：`manifest.json` + `backend/Cargo.toml`（+lock）0.4.51 → 0.4.52（C 包收口时）。
- 验证顺序：改哪层跑哪层（A：cargo test + clippy；B：typecheck + vitest + build）；
  C 收口跑 `scripts/test.sh --skip-host`（`smoke_sudo_otp_test.py` 存量失败为在案
  预存在问题，按 SKIP 语义处理并手动补跑尾步）+ 打包 + 安装副本双冒烟。
- 仓库卫生：截图/运行时产物不入库。

## 1. 跨包契约（§3/§4 并行开发的唯一依据）

### 1.1 新 RPC 方法（sidecar，注册进 main.rs 分发臂）

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `ssh/highlightRules/list` | 无 | `{ rules: [视图…] }`，按 `createdAt` 升序；首次调用（存储文件不存在）播种 22 条默认规则并持久化（见存储表注），坏文件/用户清空不重播 |
| `ssh/highlightRules/save` | `id?`（空/缺省=新建，非空=更新须存在）、`pattern`（必填，trim 后 1–200 字符）、`isRegex?`（默认 false）、`color?`（默认 `#f59e0b`）、`caseSensitive?`（默认 false）、`enabled?`（默认 true） | `{ rule: 视图, created: bool, rules: [视图…] }`（完整清单随响应下发） |
| `ssh/highlightRules/delete` | `id` | `{ removed: bool, rules: [视图…] }`；未知 id `removed:false` 不报错、不重写文件 |
| `ssh/audit/list` | `limit?`（默认 200，钳 1–1000）、`kind?`（精确匹配过滤） | `{ entries: [逆序 newest-first], truncated: bool }` |
| `ssh/audit/clear` | 无 | `{ cleared: true }` |

规则视图字段：`id, pattern, isRegex, color, caseSensitive, enabled, createdAt, updatedAt`。
后端校验：pattern trim 非空 ≤200；color 匹配 `^#[0-9a-fA-F]{6}$`；上限 30 条
（超限报错 `"At most 30 highlight rules…"`，对齐 quickCommands 文案风格）。
**regex 合法性不在后端校验**（避免引入依赖，见 A3 步骤 0 的依赖检查），由前端
保存前 compile 校验（B1）；后端仅校验形状。

审计条目（JSONL 行，字段 camelCase）：

```
{ "ts": 1757500000, "kind": "mcp.tool" | "mcp.gate" | "exec" | "agent.challenge" | "terminal.auto_sudo",
  "tool"?: string,            // mcp.* 专用
  "gate"?: string,            // mcp.gate 专用：scope|confirm|readonly|whitelist|sensitive|destructive|sudoAllowlist
  "connection"?: string,      // 连接引用展示串（名或 id 或 user@host:port，尽力而为）
  "sessionId"?: string,
  "command"?: string,         // 落盘前必过 redact_command
  "decision"?: string,        // agent.challenge：issued|approved|denied|timeout
  "sudo"?: bool, "risk"?: string, "mode"?: string,
  "kind2"?: string,           // terminal.auto_sudo：password|otp（避免与行内 kind 撞名）
  "deferred"?: bool,
  "outcome"?: "ok"|"error", "exitCode"?: number|null, "error"?: string }
```

### 1.2 新 MCP 工具（snake_case，注册进 mcp.rs 工具表；28 → 30）

**`ssh_multi_exec`** —— 多连接聚合执行（隐藏通道语义，不进终端、不路由 agentTerminalMode）。

- 参数：`targets: string[]`（1–10 个连接引用，元素支持 connectionId / connectionName /
  endpoint，逐个经 `registered_connection_by_ref` 归一化，保序去重）、`command: string`、
  `mode?: "parallel"|"sequential"`（默认 parallel）、`stopOnError?: bool`（默认 false，
  仅 sequential 生效）、`timeoutSecs?: number`（5–300，可选）、
  `confirmDestructive?: boolean`（一次确认适用于全部目标）。
- 返回：`{ ok: bool(全部成功才 true), sent: n, failed: n, results: [{ target, connectionId,
  host, port, username, ok, output, exitCode, error? }] }`。
- 门禁：入口先全量归一化 + **作用域门**（任一目标越界整体拒绝）；每目标独立过
  只读白名单 / 敏感路径 / 灾难确认（共享 `confirmDestructive`）。**不提供 sudo**
  （提权走单目标 `ssh_exec_sudo`，描述中注明）。parallel 上限 10 目标。
- 描述文案照抄 `ssh_exec` 的宿主 ~15s 等待上限与 `ssh_run_bg` 引导。

**`ssh_terminal_input`** —— 向连接的存活终端会话注入原始输入（交互应答 / Ctrl+C 语义）。

- 参数：`connectionId` / `connectionName` 二选一（schema 走既有 `anyOf` 连接寻址，
  见 mcp.rs `connection_properties` + 2026-09-10 寻址轮）、`input: string`（归一化
  `\n|\r\n→\r` 后 ≤8 KiB；`\x00` 剥离）、`appendNewline?: bool`（默认 **false**，
  与 batchInput 的 true 区分——交互应答通常自带 `\r`）。
- 返回：`{ sent: true, sessionId }`。
- 解析：连接引用 → 该连接存活终端会话（同 `sftp/copy` 的 connectionId 会话解析
  语义）；无会话报错引导（对齐 agent terminal 的「可见才执行」文案）。
- 门禁（比工作台 batchInput 严，理由：MCP 面是 agent 信任域）：
  ① 只读连接：仅放行**纯控制序列**输入（归一化后每个字符 `is_control()`），
  含任何可见文本即拒绝；② 灾难门：按 `\r` 切行，任一行 `assess_command` 命中
  Destructive → 需 `confirmDestructive`；③ sudo 白名单：任一行 `runs_under_sudo`
  且该连接配置了白名单 → 过 allowlist 门；④ confirm 档：非纯控制输入计为写类
  （过 §1.3 confirm 门）。输出**不收集**（描述引导：要输出用
  `ssh_exec{runInTerminal:true}`）。

### 1.3 `mcp/settings` 新字段（持久化进 `mcp-settings.json`，operator 面）

| 字段 | 类型/默认 | 语义 |
| --- | --- | --- |
| `execPermissionMode` | `"autonomous"`（默认）\|`"confirm"` | confirm 下，写类工具与 exec 族（`is_write_tool` ∪ `ssh_exec`/`ssh_exec_sudo`/`ssh_run_bg`/`ssh_terminal_input`）在全部既有门通过后、执行前，发 `ssh/agent/prompt` 审批（复用既有挑战机制），approve 后执行；deny/超时（120s，钳 10–300）即拒绝。读类工具与 `ssh_close` 不拦 |
| `connectionScope` | `string[]`（默认 `[]`=不限） | 作用域白名单，条目匹配规则：等于连接 id、或连接名精确匹配、或主机名（ASCII 大小写不敏感）。生效范围：连接类调用目标解析后校验；`ssh_list_connections` 只回作用域内条目；stdio 桥转发（`bridge_forward_plan`）同样先过作用域；**作用域非空时内联凭据拨打（host+username 参数）整体拒绝**（fail closed，错误文案指引改用 connectionId/connectionName） |

进程级环境变量覆盖持久化值（env 存在即覆盖，供 ZCode 等 MCP 客户端按 server 条目配置）：

- `DBX_SSH_MCP_PERMISSION_MODE` = `autonomous|confirm`
- `DBX_SSH_MCP_CONNECTION_SCOPE` = 逗号分隔条目

与既有 `DBX_SSH_MCP_READ_ONLY=1` 并存，只读总闸优先级最高。
fail-closed 例外：confirm 模式下 `emitter` 为 None（stdio 独立会话、无工作台可审批）
→ **立即报错不挂 120s**，文案指引「切回 autonomous 或在 DBX 工作台打开时使用」。

审批挑战复用：`ssh/agent/prompt` 事件 payload 增加可选 `source: "mcp"` 字段
（既有终端审批不带该字段），前端审批弹窗按 source 调整标题/图标；旧前端收到
带 source 的挑战按既有渲染兜底（向后兼容）。

### 1.4 存储文件（均版本化 JSON/JSONL、tmp+rename 原子写）

| 文件 | 权限 | 说明 |
| --- | --- | --- |
| `<data_dir>/highlight-rules.json` | 0600 | 结构照 `quick-commands.json`（`{version, rules}`；坏文件降级空库）。**首启播种**：文件不存在时 list/save 以固定 id 写入 22 条默认规则（`DEFAULT_RULE_SPECS`，严重度分色：红=硬错误 ERROR/FATAL/Permission denied/No such file or directory/command not found/Connection refused/No space left on device/Failed to/cannot/Exception/Traceback、琥珀=命令失败 FAIL/denied/timed out、黄=警告 WARN/deprecated、绿=成功 SUCCESS/active (running)/done/✓/PASSED（区分大小写）、蓝=IPv4 正则）；长短语优先于词干（同线重叠先到先得，如 "Permission denied" 整段红、孤立 "denied" 琥珀）；文件已存在（含用户删空）永不重播 |
| `<data_dir>/audit-log.jsonl`（+ `.1` 一代轮转） | 0600 | 追加写；>5 MiB 先 rename 为 `.1`（删旧 `.1`）再新建 |

### 1.5 metrics payload 新增可选字段

`ssh/metrics` 返回追加 `"osId": string?`、`"osPretty": string?`（`/etc/os-release`
或 `/usr/lib/os-release` 解析，读不到则两字段整体缺省）；`cached` 快照自然携带。

### 1.6 i18n key 组（七语）

- `highlightRules.*`（约 12 键：title/add/pattern/patternPlaceholder/regex/
  caseSensitive/color/enabled/empty/limit/invalidPattern/invalidColor/invalidRegex）
- `auditLog.*`（约 10 键：title/empty/kindFilter/clear/clearConfirm/refresh/
  outcomeOk/outcomeError/truncated/command 列头等）
- `mcpSettings.permissionMode` / `mcpSettings.permissionModeConfirmHint` /
  `mcpSettings.connectionScope` / `mcpSettings.connectionScopeHint`（约 4 键）
- 审批弹窗 source=mcp 的标题键 `agentPrompt.mcpSource`（1 键）
- sparkline / distro monogram：零文案（tooltip 用 osPretty 原文）

## 2. 工作包 A（后端，单 agent，独占 `backend/`）

### A0. 依赖与现状确认

- [ ] `cargo tree | grep regex` 确认 `regex` 是否已在依赖树（russh 传递依赖）。
  在 → A3/A0 的后端 pattern 形状校验顺带做 `Regex::new` 编译校验（错误信息
  `"pattern is not a valid regular expression: …"`）；不在 → 只做形状校验，
  regex 合法性由前端保存时校验（§1.1 已注明）。**不得新增 Cargo 依赖。**
- [ ] 通读 mcp.rs `call_tool`（:412 起）既有门禁序，确认插入点。

### A1. MCP 权限档（confirm）+ 连接作用域

**Files**：`backend/src/mcp.rs`（McpLimits :58、settings get/set :334 起、
`call_tool` :412、`registered_connection_by_ref` :561、`bridge_forward_plan` :697、
`ssh_list_connections` 工具、`connection_properties` :2628 无改动）、
`backend/src/ssh.rs`（agent 挑战复用，锚点 :737 `agent_challenges`、:2156 起审批函数）、
`backend/src/main.rs`（无新方法臂，`mcp/settings/*` 既有臂透传新字段）。

- [x] **A1-T1 单测先行**（`mcp.rs` `#[cfg(test)]`）：settings roundtrip 携带
  `execPermissionMode`/`connectionScope`（默认值、持久化、坏 JSON 降级默认）；
  mode 非法值 `settings/set` 报错；scope 条目 trim/上限 20/单条 ≤120 校验。
- [x] **A1-T2** 实现 `McpLimits` 两字段（serde default）+ `settings_get/set` 透传
  与校验 + `effective_permission_mode()` / `effective_scope()`（env 覆盖优先，
  env 读取经可注入闭包以便单测，参照 `resolve_plugin_data_dir` 模式）。
- [x] **A1-T3 单测先行**：`connection_in_scope(resolved, scope)` 匹配矩阵
  （id 命中 / 名称精确 / host 大小写不敏感 / 空作用域恒 true / 大小写敏感的 id 不匹配）。
- [x] **A1-T4** 作用域门实现，三处生效点：
  ① `call_tool` 在 `registered_connection_by_ref` 归一化后立即校验（越界报错
  `"Connection … is outside the MCP connection scope"`）；
  ② `ssh_list_connections` 结果过滤（bridge 列表与 session registry 两来源都过滤，
  全被过滤时 `source`/`note` 照旧语义）；
  ③ `bridge_forward_plan` 转发前校验（越界不转发，直接本地报错）；
  ④ 内联拨打拒绝：作用域非空且调用无 connectionId/connectionName（带 host+username
  内联凭据）→ 直接报错带指引。确认既有 `inline_dial_is_registered_read_only`
  的端点匹配助手可复用则复用。
- [x] **A1-T5 单测先行**：confirm 门矩阵（2026-09-12 落地：is_confirm_gated_tool 集合断言 + settings 往返/env 覆盖）——写类工具在 confirm 下需要审批、读类
  工具不受影响；emitter None 快速失败文案；审批 approve 放行 / deny 拒绝 /
  超时拒绝（oneshot 注入模拟，参照 ssh.rs `agent_challenges_resolve_once_…`
  测试模式）；灾难 `confirmDestructive` 门先于审批弹窗评估（不弹两次）。
- [x] **A1-T6** confirm 门实现（2026-09-12：call_tool 既有门序后、bridge 转发前接 `request_mcp_confirm`（三件套转正）；stdio 无 emitter fail-closed 立即拒绝；确认文本可替换原文；§1.3 设置项 `execPermissionMode`/`connectionScope` 持久化 + env 覆盖 + merge 写盘（修复 limits 写入覆盖 permission 键的顺序缺陷））
  复用 ssh.rs 审批挑战（新入口 `confirm_via_challenge(emitter, tool, command) ->
  Result<(), String>`，事件 payload `{challengeId, kind:"mcp-confirm", source:"mcp",
  tool, command, timeoutSecs}`；挑战一次性、超时即拒，与既有语义同构）；
  `is_write_tool`（:2165）扩为 `is_gated_by_confirm(name)`（写类 ∪ exec 三工具 ∪
  `ssh_terminal_input`——`ssh_terminal_input` 由 A2 提供名单，先留位）。
- [x] **A1-T7** 跑 `cargo test` 全绿 + `cargo clippy` 无新告警。（2026-09-12 §1.3 权限档落地批回归 cargo 363/363 核实）

### A2. `ssh_multi_exec` + `ssh_terminal_input`

**Files**：`backend/src/mcp.rs`（工具定义 :2675 区域 + handler + `run_tool` 池化）、
`backend/src/mcp_safety.rs`（`CommandRisk` :25 / `assess_command` :36 /
`runs_under_sudo` :53 复用）、`backend/src/ssh.rs`（:1558 `batch_terminal_input`
底层复用）、`backend/src/main.rs`（无工作台新方法——两工具均 MCP-only）。

- [x] **A2-T1 单测先行**（mcp_safety）：`assess_terminal_input(input) -> CommandRisk`
  ——纯控制序列 Low、拆 `\r` 行取最大风险、灾难行命中、`sudo …` 行
  `runs_under_sudo` 命中、8 KiB 截断行为。
- [x] **A2-T2** 实现 `assess_terminal_input` + `is_control_only_input(input)`。
- [x] **A2-T3 单测先行**（mcp.rs）：targets 归一化/去重保序、>10 拒绝、
  sequential+stopOnError 首败短路语义（用可注入的 per-target 执行闭包单测，
  不连 SSH）、results 聚合结构。
- [x] **A2-T4** 实现 `ssh_multi_exec` handler（2026-09-12：targets 全量归一化/去重保序/上限 10 + 保存连接全量预解析（任一未解析整体拒绝）→ 并发 `join_all` 递归 helper（tokio 原生，无 futures 依赖）/ sequential stopOnError 短路 → 聚合响应 `{ok, sent, failed, results:[{target, connectionId, host, port, username, ok, output, exitCode, error?}]}`；命令门 `multi_exec::command_gate` 纯函数（sudo 整体拒绝、灾难确认、只读白名单）；单测 4（A2-T3）+ schema/工具清单入列；smoke_mcp live 段 saved-ref 引导 + 灾难门负例：targets 全量归一化 → 作用域门 →
  parallel（`tokio::join!`/spawn 集合，复用隐藏通道 exec 内部路径，与
  `ssh_exec` off-模式同一条代码路径）/ sequential（逐个 await）→ 聚合响应；
  schema 定义（targets items string、mode enum、描述含 15s 上限与 run_bg 引导、
  不含 sudo）。
- [x] **A2-T5 单测先行**（mcp.rs）：`ssh_terminal_input` 门矩阵（2026-09-12 落地：只读+可见文本拒 / 只读+纯控制放、灾难行无确认拒+只读必拒、白名单 sudo 行拦截、schema anyOf 寻址断言）——只读+可见文本
  拒 / 只读+纯控制放、灾难行无确认拒、白名单连接 sudo 行拦截（复用 A1 期
  sudo allowlist 测试夹具）、appendNewline 归一化、无存活会话错误文案。
- [x] **A2-T6** 实现 `ssh_terminal_input` handler（2026-09-12：registered ref → 存活会话解析（无会话/endpoint 选择器统一回落 NO_TERMINAL_SESSION 引导）→ 门禁 → 单会话 batch_terminal_input 复用；smoke_mcp live 段新增 no-session 引导负例）：连接引用 → 存活终端会话解析
  （复用 `sftp/copy` 的 connectionId 会话解析路径）→ 门禁 → 单会话版
  `batch_terminal_input`（ssh.rs 加薄封装 `terminal_input_to_session` 或
  batch 复用 `vec![session]`，取侵入最小者）→ `{sent:true, sessionId}`。
- [x] **A2-T7** confirm 门名单接入（2026-09-12：is_confirm_gated_tool = is_write_tool ∪ ssh_exec/ssh_multi_exec/ssh_terminal_input；`terminal_input_gate` ④ 号留位由同一 confirm 门覆盖；schema anyOf 断言已在 connection_tools_declare_connection_id + 清单测试）
  `smoke` 之外先补 `connection_tools_declare_connection_id` 式 schema 单测
  （anyOf 寻址、confirmDestructive 声明）。
- [x] **A2-T8** `cargo test` 全绿 + clippy。（2026-09-12 multi_exec 批回归 357/357 + test.sh exit=0 核实）

### A3. 关键词高亮规则存储

**Files**：`backend/src/highlight_rules.rs`（新建，逐行对照
`quick_commands.rs` 模板：STORAGE_VERSION/FILE_NAME/MAX_RULES=30/MAX_PATTERN=200/
`store_path/load_store/save_store/entry_from_json/entry_json/entry_view/list_views/
save_entry/delete_entry` + `#[cfg(test)]` 全套）、`backend/src/ssh.rs`
（`highlight_rules_list/save/delete`，对照 :2841-2863 quick_commands_* 三方法）、
`backend/src/main.rs`（分发臂加在 :512-514 quickCommands 块旁：
`ssh/highlightRules/list|save|delete`）。

- [x] **A3-T1 单测先行**（highlight_rules.rs tests，对照 quick_commands 七用例）：
  save 建改与默认值（isRegex=false/color=#f59e0b/caseSensitive=false/enabled=true）、
  非法输入拒绝（空 pattern/超长/坏色值）、上限 30 只约束新建、delete 幂等、
  坏文件降级空库、roundtrip 保序、视图字段完整。
- [x] **A3-T2** 实现模块 + SshRuntime 三方法 + main.rs 三臂（save 返回完整清单、
  delete 未知 id `removed:false`）。
- [x] **A3-T3** `cargo test` 全绿。（2026-09-11 Netcatty 批落地，后续 09-12 全量回归持续绿）

### A4. 审计日志

**Files**：`backend/src/audit.rs`（新建）、`backend/src/mcp.rs`（记录点）、
`backend/src/ssh.rs`（记录点 + `audit_list/audit_clear`）、`backend/src/main.rs`
（`ssh/audit/list|clear` 两臂，加在 :518 batchBar 旁）、`backend/src/main.rs`
（`mod audit;`）。**不注册进 mcp 工具表**（agent 无读写审计面）。

- [ ] **A4-T1 单测先行**（audit.rs）：`redact_command`（`password=…`/`--password …`/
  `TOKEN: …`/`api_key=…` 值段替换 `***`，大小写不敏感；无命中原样返回）；
  append→read_recent roundtrip（逆序、limit 钳制、kind 过滤、truncated 标志）；
  轮转（写满 5 MiB 阈值后旧文件落 `.1`、读含两代、clear 双删）；append 失败不 panic。
- [ ] **A4-T2** 实现 audit.rs（`record` 每次 append+flush，错误 eprintln 吞掉
  不影响主流程；条目结构见 §1.1）。
- [ ] **A4-T3 埋点**（每点一行调用，注入 data_dir 经 SshRuntime/runtime 既有访问器）：
  - mcp.rs `call_tool`：既有各门拒绝处 → `kind:"mcp.gate"`（带 gate 名）；
    exec/写类工具执行完成处 → `kind:"mcp.tool"`（tool/connection/command(redacted)/
    outcome/exitCode/mode）。
  - ssh.rs `ssh/exec` 工作台路径完成处 → `kind:"exec"`（sessionId/command(redacted)/
    sudo/outcome）。
  - ssh.rs agent 审批（:2156 区域）：签发 → `kind:"agent.challenge", decision:"issued"`；
    resolve/超时 → `decision:"approved"|"denied"|"timeout"`（approve 带编辑后命令）。
  - ssh.rs 终端 auto-sudo 应答处（含推迟补答）→ `kind:"terminal.auto_sudo"`
    （kind2=password|otp、deferred）。
  - sftp/sudo 文件写操作**不在本批**（遗留 §7）。
- [ ] **A4-T4** `audit_list`（limit/kind 过滤、逆序、truncated）/ `audit_clear`；
  main.rs 两臂。
- [ ] **A4-T5 单测**：埋点冒烟级（SshRuntime 层注入临时 data_dir，跑一次
  `quick_commands_save` 等无 SSH 依赖路径不可行——audit 埋点在 exec/mcp 路径，
  单测覆盖 audit.rs 纯函数即可，链路由 smoke 覆盖，见 C 包）。
- [ ] **A4-T6** `cargo test` 全绿 + clippy。

### A5. metrics 发行版识别

**Files**：`backend/src/exec.rs`（:1179 `collect_metrics` + 新纯函数
`parse_os_release`）、`backend/src/ssh.rs`（:2546 `metrics` payload 组装处透传）、
`backend/src/model.rs` 无改动。

- [x] **A5-T1 单测先行**：`parse_os_release`——标准 `ID=ubuntu`+带引号
  `PRETTY_NAME="Ubuntu 22.04…"`、`ID_LIKE` 忽略、文件缺失/空文本 → `(None, None)`、
  CRLF 容错。
- [x] **A5-T2** `collect_metrics` 采集命令尾部追加带哨兵的
  `cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null`
  （解析失败/缺文件不影响既有字段，两字段整体缺省）；payload 组装透传
  `osId`/`osPretty`（空则省略）；快照缓存自然携带。
- [x] **A5-T3** `cargo test` 全绿。（2026-09-11 Netcatty 批落地：`metrics.rs` `--os--` 哨兵段）

## 3. 工作包 B（前端，单 agent，独占 `frontend/`）

依赖契约：§1 全部；不依赖 A 的实现进度（mock 先行）。

### B1. 关键词高亮（规则管理 + xterm decorations）

**Files**：`frontend/src/lib/keywordHighlight.ts` + `keywordHighlight.spec.ts`（新建）、
`frontend/src/App.vue`（工具栏按钮 :4791 区域旁、弹层、decoration 引擎、挂载 hydrate）、
`frontend/src/style.css`（弹层 + decoration 相关微样式）、`frontend/src/lib/i18n.ts`
（`highlightRules.*` 七语）、`frontend/src/mockDbxHost.ts`（镜像三方法，内存库）、
`frontend/src/workbench.spec.ts`（七语 key 对齐自动覆盖）。

- [x] **B1-T1 单测先行**（keywordHighlight.spec.ts）：
  - `compileRules(rules)`：plain pattern 元字符转义、isRegex 直通、非法 regex 过滤掉
    不抛异常、按 pattern 长度降序（长词优先）。
  - `matchesInLine(line, compiled, maxPerLine=20)`：多规则命中、重叠先到先得、
    大小写敏感开关、单行上限、空规则零匹配。
  - `sanitizeHighlightRuleInput(draft)`：pattern trim/必填/长度、color hex 校验、
    regex compile 校验（返回 error 键名供 i18n）。
- [x] **B1-T2** 实现 lib 三函数（无 xterm 依赖的纯计算）。
- [x] **B1-T3** App.vue 数据面：挂载时 `hydrateHighlightRules()`（调
  `ssh/highlightRules/list`，失败静默降级空表，对齐 quickCommands hydrate 模式）；
  规则状态 + 弹层开态。
- [x] **B1-T4** App.vue 管理弹层：工具栏按钮（Palette 图标，紧邻快捷命令 Zap 按钮）、
  popover/弹窗列表（每条：色点 + pattern + regex/caseSensitive 徽标 + enabled 开关 +
  删除）、新增表单（pattern 输入 + regex/caseSensitive checkbox + 8 色板 +
  自定义 hex）、上限置灰 + `highlightRules.limit` 提示；焦点管理走既有
  `modalFocus.ts` 链（Esc/Tab 陷阱），对外点关闭复用 batch popover 的
  capture-mousedown 模式。
- [x] **B1-T5** App.vue decoration 引擎：
  - `terminal.onRender(({start,end}) => …)` 触发 rAF 节流扫描（≤30fps）；
  - 仅扫活动 buffer 视口行 `start..end`（alternate buffer 同样处理），
    每行 `matchesInLine(line.translateString(true), compiled)`；
  - `registerDecoration` 用 marker + x/width + backgroundColor（对齐搜索面板
    `allowProposedApi` 用法）；按行维护 `Map<row, decoration[]>`，行滚出视口
    dispose；全局上限 400、超上限停止本帧注册；
  - 规则变更/开关关闭/终端重建（重连、dispose）时全量清理；
  - 总开关 localStorage `ssh-keyword-highlight`（默认开，仅显式 "false" 关，
    对齐 `sanitizeSelectCopyEnabled` 模式）；关闭时零挂钩子。
- [x] **B1-T6** i18n 七语 `highlightRules.*` 全补；mockDbxHost 镜像三方法
  （内存 CRUD，save 返回完整清单、delete 幂等）。
- [x] **B1-T7** `pnpm typecheck` 0 错、`pnpm test` 全绿（新增 ≥8 用例，keywordHighlight 17 spec）、
  `pnpm build` 过；visual.html 浏览器验证（mock 页造含 ERROR/自定义关键字的
  终端输出：命中着色、规则增删即时生效、开关关闭清除、上限提示）——2026-09-11 晚
  UI 打磨轮浏览器实测覆盖（高亮弹层/规则增删/Esc 链，vitest 364 全绿）。

### B2. metrics sparkline + 发行版徽标

**Files**：`frontend/src/lib/metricsSparkline.ts` + spec（新建）、
`frontend/src/lib/distroBadge.ts` + spec（新建）、`frontend/src/App.vue`
（:3869 `refreshMetrics` / :4906 `metrics-float` 区 / 连接信息面板）、
`frontend/src/style.css`（sparkline + monogram 徽标微样式）。

- [x] **B2-T1 单测先行**：`pushSample(ring, sample)`（容量 60 环形）；
  `sparklinePath(values, width, height)`（空 → `""`、单点、全零、max 缩放、
  polyline points 字符串）；`distroBadge(osId)`：ubuntu/debian/centos/rhel/fedora/
  alpine/arch/rocky/almalinux/opensuse/oracle/amazon/kali/suse 映射
  `{label, color}`、未知/缺失 → 通用 Tux 灰 + osPretty 原文、`centos` 与
  `rhel` 色区分。
- [x] **B2-T2** 实现（纯 CSS monogram 徽标：圆角方块 + 首字母 + 主题色变量；
  **不引入任何图片资产**）。
- [x] **B2-T3** App.vue 接线：metrics 轮询成功时把各接口 rx/tx 求和推进环形缓冲
  （会话关闭/面板关闭时保留缓冲即可，跨重连清空）；`metrics-float` 网络区头部
  渲染两枚 60×18 SVG（rx 用 `var(--primary)`、tx 用 `var(--success)`）；
  卡片头部主机名旁渲染 distro 徽标（tooltip=osPretty）；连接信息面板有 metrics
  数据时同款徽标。旧 sidecar（无 osId 字段）缺徽标不报错（optional 降级）。
- [x] **B2-T4** `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿（新增 ≥6 用例）；
  visual.html 验证（mock metrics fixture 注入多帧速率 + osId，肉眼确认曲线滚动
  与徽标渲染；deep/浅两主题截图不入库仅本地核对）——指标浮层在 2026-09-11 晚
  UI 打磨轮实测范围内（vitest 364 全绿）。

### B3. 设置弹窗：MCP 权限档 + 作用域

**Files**：`frontend/src/App.vue`（MCP 设置区，锚点 :4169 `saveMcpSettings` 与
:4189 保存链）、`frontend/src/lib/i18n.ts`（`mcpSettings.*` 4 键 ×7）。

- [x] **B3-T1** MCP 设置区新增：权限档 select（autonomous/confirm，
  confirm 附 hint：写操作与远程命令执行需在工作台人工审批；无工作台时快速拒绝）+
  作用域 textarea（每行一条：连接 id / 连接名 / 主机名；空 = 不限）；
  读写走既有 `mcp/settings/get|set`；保存链（① profile ② 连接设置 ③ MCP）
  中 `saveMcpSettings` 一并提交两新字段（非法 mode 后端报错经既有
  `mcpError` 容错展示）。
- [x] **B3-T2** 审批弹窗 source=mcp 适配：`agentPromptQueue` 挑战 payload 带
  `source:"mcp"` 时标题改 `agentPrompt.mcpSource`（含工具名），命令可编辑
  与倒计时逻辑复用；无 source 走原渲染（兼容旧 sidecar）。
- [x] **B3-T3** 七语全补 + typecheck/test/build 全绿（2026-09-13 核实收尾：394/394 + build + smoke_ui_mock all green；mcpSettings.* 四键 ×7 与 agentPrompt.mcpSource 在库）；visual.html 验证
  （select 切换、textarea 回显、confirm hint 文案）。

### B4. 审计日志查看

**Files**：`frontend/src/App.vue`（设置弹窗新折叠 section，对照
`profilesInlineOpen` 模式）、`frontend/src/lib/i18n.ts`（`auditLog.*` ×7）。

- [x] **B4-T1** 设置弹窗「审计日志」折叠区：kind 过滤 select（全部/五类）、
  条目列表（时间格式化、kind 徽标、connection、command 展示 redacted 原文、
  outcome/exitCode、gate 名）、刷新按钮、清空按钮（confirm 后调
  `ssh/audit/clear`）、truncated 提示（`auditLog.truncated`）；打开时拉取
  `ssh/audit/list`，失败静默空态。列表只读、无分页（limit 200 默认够用，
  遗留 §7 注记）。
- [x] **B4-T2** 七语全补 + typecheck/test/build 全绿（2026-09-13 核实收尾；并补齐后端脱接：`ssh/audit/clear` RPC 从未注册 + MCP 执行面审计行从未写入——`call_tool` 外层包装对 gated 工具逐调用落账 verdict/exitCode/duration/mode，`audit_log::clear` 带单测与 smoke 用例）；visual.html 验证
  （mock 镜像 `ssh/audit/list|clear`：注入若干条 fixture，过滤/清空/空态三态）。

## 4. 工作包 C（主会话收口）

- [ ] **C1 smoke 扩展**：
  - `scripts/smoke_mcp.py`：EXPECTED_TOOLS 28→30；schema 断言
    （`ssh_multi_exec` targets/mode/无 sudo 字段、`ssh_terminal_input` anyOf 寻址、
    appendNewline 默认）；离线组——`DBX_SSH_MCP_PERMISSION_MODE=confirm` 进程下
    `ssh_exec`（内联凭据）快速失败（fail-closed 文案断言，不拨号）；
    `ssh_terminal_input` 灾难行无确认拒绝（门先于拨号）；
    `mcp/settings` 两新字段 roundtrip；`tools/list` 不含 `ssh_audit*`（审计不进
    agent 面）；作用域单测由 A1 覆盖、smoke 侧 assert settings 持久化即可。
    真机段（容器）：`ssh_multi_exec` 单连接双目标（聚合结果结构 + sequential
    stopOnError 短路）、`ssh_terminal_input` 向存活会话注入 `echo` marker 并经
    replay/观察回显。
  - `scripts/smoke_fs_test.py`：highlightRules CRUD 组（≥6 用例：空表/save/默认值/
    更新/上限/删除幂等）；audit 组——驱动一次 `ssh/exec` 后 `ssh/audit/list`
    出现 `exec` 条目（含 redact 断言：带 `password=x` 的命令落盘为 `***`）、
    kind 过滤、`ssh/audit/clear` 后为空；metrics 用例断言容器返回 `osId`
    （linuxserver/openssh-server 基于 Ubuntu，应命中）。
- [ ] **C2 文档同步**：
  - `docs/PROTOCOL.zh-CN.md`：RPC 表 +5 行（highlightRules×3、audit×2）；
    新节「关键词高亮规则」「审计日志」（条目结构/脱敏边界/轮转/仅工作台面）；
    metrics 字段表补 `osId`/`osPretty`；`mcp/settings` 字段表补两新字段与
    env 覆盖。
  - `docs/MCP.zh-CN.md`：工具一览 28→30；新节「MCP 权限档与连接作用域」
    （confirm 语义、fail-closed 边界、env 变量、ZCode server 条目配置示例）、
    `ssh_multi_exec`/`ssh_terminal_input` 语义（15s 上限、门禁差异、输出收集
    引导）。
  - `docs/FEATURE_PARITY.zh-CN.md`：新增 Netcatty 对标行（权限档/作用域/
    聚合执行/终端输入/关键词高亮/审计日志/metrics 增强；云同步记「不做，导出
    待议」）。
  - `docs/TEST_MATRIX.zh-CN.md`：登记句刷新（cargo/vitest/smoke 新基线数字）。
  - 用户级 skill `dbx-ssh-sftp-dev`：「长任务/MCP 侧约定」节补两个 env 变量与
    新工具一行。
- [ ] **C3 版本与出包**：manifest.json + Cargo.toml（+lock）0.4.51 → 0.4.52；
  `scripts/test.sh --skip-host`（存量 smoke_sudo_otp 失败按在案处理，尾两步
  手动补跑）；`dbx-plugin package .` 出包 + schema 校验；安装副本双冒烟
  （`DBX_PLUGIN_SIDECAR=<安装路径>/bin/…/dbx-plugin-ssh` 跑 smoke_test +
  smoke_fs_test）。
- [ ] **C4 PROGRESS**：`docs/PROGRESS-P-SSH.zh-CN.md` 追加本批次交付报告
  （验证基线表、实现要点、遗留）。

## 5. 验证矩阵（收口通过线）

| 层 | 命令 | 通过线 |
| --- | --- | --- |
| 后端 | `cargo test`（backend/） | 全绿（基线 240 + 本批新增 ≈30） |
| 后端 | `cargo clippy` | 无新告警 |
| 前端 | `pnpm typecheck` | 0 错 |
| 前端 | `pnpm test` | 全绿（基线 289 + 新增 ≈20） |
| 前端 | `pnpm build` | ui/index.html 产出 |
| 冒烟 | `smoke_mcp.py` | all green（30 tools） |
| 冒烟 | `smoke_fs_test.py` | 全 PASS（新增两组） |
| 打包 | `dbx-plugin package .` | schema 校验过 + 出 .dbxp |
| 安装 | 双冒烟（安装副本） | PASS |
| 浏览器 | visual.html 走查 | B1–B4 各自清单过 |

## 6. 风险与边界（实现时写进对应文档）

1. **confirm 档在 headless stdio 下等于只读**：无工作台审批面即快速失败
   （fail closed 是特性不是缺陷），文档写明适用边界。
2. **作用域非空时内联拨打被拒**：防绕过作用域意图的刻意收紧；错误文案给
   connectionId/connectionName 指引。
3. **审计脱敏是启发式**：`redact_command` 只覆盖常见 password/token 形态，
   不承诺完整脱敏；文件 0600 + 仅工作台读取（agent 面无审计工具）兜底。
4. **decoration 性能**：仅视口扫描 + 400 上限 + rAF 节流；规则上限 30；
   关闭开关时零开销。
5. **multi_exec 与宿主 ~15s 等待上限**：parallel 模式受同上限约束（描述照抄
   ssh_exec 引导 run_bg）；sequential 供长任务逐台推进。
6. **os-release 缺失**（BSD/busybox 精简镜像）：字段整体缺省，前端不渲染徽标。
7. **GPL 隔离**：不引入 Netcatty 任何资产/代码；发行版标识为自绘 monogram。

## 7. 本批明确不做（遗留候选）

- 云同步/导出（Netcatty CloudSync 降维版：quick-sudo-profiles/quick-commands 的
  口令加密导出导入）——记录待议。
- sftp/sudo 文件写操作的审计埋点（v1 只覆盖 exec 族 + 审批 + auto-sudo）。
- 审计日志分页/导出（v1 只读最近 1000 条内）。
- 作用域条目的 endpoint（host+username）粒度（v1 只到 host）。
- `ssh_audit` 只读 MCP 工具（给 agent 自查审计）——与「agent 不可读审计」
  原则冲突，除非未来加独立开关，暂不做。
