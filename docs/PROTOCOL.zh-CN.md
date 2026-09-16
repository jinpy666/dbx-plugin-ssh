# SSH/SFTP 插件协议

## 生命周期与状态隔离

Sidecar 是插件级共享进程，所有状态都必须以 `connectionId`、`sessionId` 或 `taskId` 为键。`connection/connect` 只接收并缓存宿主注入的连接配置；`connection/disconnect` 会关闭该连接下的终端、SFTP 子系统和传输任务。工作台不会接收密码字段。

第一阶段不声明 `test` 能力。真实 SSH 握手在 `ssh/session/open` 发起，主机密钥确认完成前不会调用密码认证。

## RPC

| 方法 | 作用 |
| --- | --- |
| `ssh/session/open`、`ssh/session/close` | 创建、关闭 PTY 会话（连接 `remote_command` 非空时 exec 该命令替代 shell，`set_env` 随会话注入；连接配置 `triggers` 时挂载自动交互触发器引擎，命中发 `ssh/trigger` 事件，见「自动交互触发器（Expect）与外部密码管理器」节） |
| `ssh/terminal/resize` | 调整 PTY 行列 |
| `ssh/terminal/replay` | 从指定序号补发终端输出 |
| `ssh/host-key/resolve` | 处理工作台内的主机密钥确认 |
| `ssh/exec` | 在会话连接上执行远程命令，可选 Quick Sudo 提权 |
| `ssh/exec/cancel` | 中止进行中的远程命令（按 `execId`） |
| `ssh/agent/resolve` | 处理 AI 终端同步执行的命令审批（按 `challengeId`，一次性；approve 可携 `command` 编辑后原文与 `remember: true` 记住标记，见「审批记忆」节） |
| `ssh/alert/triage` | 告警分诊：异构告警 JSON/纯文本 → 结构化 + 分类 + 只读诊断命令清单（无需连接，从不执行；见「告警分诊」节） |
| `ssh/audit/list` | 执行审计台账只读回放：`{limit?, beforeTs?}` → `{entries, truncated}`（见「执行审计」节） |
| `ssh/agent/mode/get` | 连接级 AI 终端模式探针（供宿主 MCP 桥转发前判定路由）：`{connectionId}` → `{agentTerminalMode: "off"\|"auto"\|"strict", hasTerminalSession: bool}`；未知连接降级为 `off` + `false` 而非报错，宿主侧任何失败同样回落静默路径 |
| `ssh/metrics` | 采集服务器指标（CPU/内存/负载/磁盘（含 inode 使用率）+ 网络接口速率 + Top CPU/内存进程，只读命令；`cached: true` 返回上次快照；每次新鲜采集顺带落一行趋势历史） |
| `ssh/metrics/history` | 趋势历史查询（`metrics-history.jsonl` 环形 720 行，按连接维度过滤，见下文） |
| `ssh/processes/list`、`ssh/processes/kill` | 全量进程表（CPU 序，上限 500 行）与进程信号（pid/signal 校验，pid 0/1 拒绝），见下文 |
| `ssh/recording/start`、`stop`、`list`、`get`、`delete` | 会话录制（asciicast v2 `.cast` 落盘、回放分页读取、列表/删除，见下文） |
| `ssh/host-key/check` | 连接维度主机密钥预检（探针三态：已知 / 变更 / 未知，不发认证） |
| `ssh/settings/get`、`ssh/settings/set` | 读取/运行时更新 Quick Sudo 编排设置 |
| `mcp/tools`、`mcp/call` | MCP 工具发现与执行（供 DBX MCP 桥 `dbx_call_plugin_tool` 调用；连接凭据以标准 lifecycle payload 转发，按 `connectionId` 池化，payload 新增 `name` 字段携带连接名）。连接类工具新增可选 `connectionName`（与 `connectionId` 二选一，注册表按名匹配，重名报错并列出候选）；stdio 独立模式对未注册 `connectionId` 的调用自动经宿主桥 `POST /list-plugin-connections` 转发到运行中的 DBX 应用执行——请求 `{"plugin_id":"io.dbx.ssh"}`、响应 `{"connections":[{id,name,host,port,username,authentication,readOnly}]}`（仅元数据，密钥只出布尔标志位），桥不可用回落内联凭据；新增 `ssh_list_connections` 工具即消费该路由，降级时仅回本会话注册表并附 `note`。`mcp/tools` 与 stdio `tools/list` 返回的每个工具附 `annotations`（`title` + `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`，与内部门禁分类同源，见 docs/MCP.zh-CN.md「工具 annotations」） |
| `mcp/settings/get`、`mcp/settings/set` | MCP SFTP 尺寸限制策略（maxRead/maxUpload/maxDownload，持久化，`--mcp` 同源生效）；`localTransferRoot` 配置 `sftp_upload`/`sftp_download` 本地传输根（绝对路径或空串回落默认根=临时目录+插件数据目录；敏感路径黑名单任何模式叠加生效） |
| `sftp/chmod` | 修改远端路径权限位（八进制） |
| `sftp/diskUsage` | 路径所在挂载的磁盘用量 |
| `sftp/home`、`sftp/list`、`sftp/read` | 浏览、预览远端文件（`sftp/read` 支持可选 `offset` 分片续读，见下文） |
| `sftp/createDirectory`、`sftp/rename`、`sftp/delete` | SFTP 写操作 |
| `sftp/upload/start`、`finish` | 上传事务生命周期（`resumeTaskId` 断点续传，见下文） |
| `sftp/download/start`、`next`、`finish` | 下载事务生命周期（`offset` 断点续传，见下文；桌面端可选 `downloadDir` 指定本机绝对保存目录） |
| `sftp/stat`、`sftp/exists`、`sftp/touch`、`sftp/write` | 扩展文件操作：元信息单查、存在性检查、空文件创建、小文件直写 |
| `sftp/archive`、`sftp/extract` | 远端 tar.gz 打包与解压 |
| `sftp/copy`、`sftp/move` | 服务器内复制 / 剪切（逐项执行，目标存在需 `overwrite`） |
| `sftp/bookmarks/list`、`sftp/bookmarks/save`、`sftp/bookmarks/delete` | SFTP 路径书签管理（全局命名清单，插件数据目录持久化，见下文） |
| `sftp/transfer/cancel` | 取消并清理临时状态 |
| `sftp/transfer/list`、`sftp/transfer/status` | 查询会话传输任务列表 / 单任务状态（含历史，会话维度过滤） |
| `sftp/transfer/history` | 跨重启传输历史查询（持久化 + 内存 live 合并，见下文） |
| `sftp/transfer/history/clear` | 清空已持久化及当前进程中的传输历史 |
| `sftp/transfer/resumable` | 可续传上传扫描（中断任务的 spool 前缀仍在磁盘上的清单，见下文） |
| `sudo/stat`、`sudo/exists`、`sudo/touch` | sudo 元信息查询与空文件创建 |
| `sudo/listDir`、`sudo/readFile`、`sudo/writeFile` | sudo 目录浏览与文件读写 |
| `sudo/mkdir`、`sudo/remove`、`sudo/removeAll`、`sudo/chmod`、`sudo/rename` | sudo 写操作 |
| `sudo/profiles/list`、`sudo/profiles/save`、`sudo/profiles/delete` | 全局 Quick Sudo 配置管理（多套命名凭据/策略档，插件数据目录持久化，密钥永不回显） |
| `sudo/profiles/options` | 连接表单动态下拉选项（`sudo_profile` 字段的 `options_action`）：返回 `{options: [{value: id, label: name}]}`，按名称排序，永不携带密钥 |
| `connection/action` | 连接表单动作（manifest `connection-provider.actions` 声明）：`action=quick-sudo-profiles` 返回全局配置清单与本连接绑定状态的纯文本摘要（`{message, fieldValues}`） |
| `keys/discover` | 本地 SSH 私钥发现（不返回私钥内容） |
| `ssh/knownHosts/list`、`ssh/knownHosts/remove` | known_hosts 条目管理（含 `@cert-authority` / `@revoked` 标记条目） |
| `ssh/sessions/list` | 只读会话清单：sidecar 当前跟踪的活跃会话 |
| `ssh/quickCommands/list`、`ssh/quickCommands/save`、`ssh/quickCommands/delete` | 全局快速命令管理（用户自定义常用命令片段，插件数据目录持久化，所有连接/工作台共享） |
| `ssh/terminal/batchInput` | 批量发送：把同一条命令写入多个已打开会话的交互终端（PTY 键盘语义），返回逐会话发送结果 |
| `ssh/batchBar/state`（notify） | 批量发送命令条的跨工作台状态同步：工作台把 `{ source, draft, quickPickId, open }` 以通知送达 sidecar，sidecar 原样以同名事件广播给所有插件 webview，各端按 `source` 过滤自己的回声；纯转发不落存储，旧版 sidecar 未注册时调用方静默降级 |

## 运行时设置

`ssh/settings/get` 返回当前编排配置（密钥仅以布尔标记呈现，绝不下发明文；传 `revealSecrets: true` 时额外回显本连接配置的 `sudoPassword` / `totpSecret` 原始串（多密钥原文），供工作台设置弹窗预填已存原值——该参数仅工作台使用，MCP 通道不暴露，缺省响应与此前完全一致；另附 `quickSudoProfileId` / `quickSudoProfileName` 报告生效的全局配置绑定（`sudo_source=global` 时含连接表单引用解析结果），未绑定为空串，`sudoSource`（`custom` / `global` / `off`，生效来源），以及 `agentTerminalMode`（`off` / `auto` / `strict`，AI 终端同步模式，见下节））；`ssh/settings/set` 另接受可选 `rememberedCommands`（字符串数组全量替换连接级免审批清单，校验规则见「审批记忆」节，破坏性行拒绝且错误信息带行号，缺省不改变）；`ssh/settings/get` 响应含 `rememberedCommands`。`ssh/settings/set` 接受 `quickSudo`、`sudoUsePty`、`sudoPassword`（空串=清除回退登录密码）、`totpSecret`、`authFlowMode`、`passwordPromptHint`、`totpPromptHint`、可选 `agentTerminalMode`（非法值报错，缺省不改变），以及可选 `quickSudoProfileId`（非空须引用存在的全局配置并持久化绑定，空串解除绑定，缺省不改变；挑选配置会将连接的 `sudo_source` 切到 `global`，解除时 `global` 回落 `custom`）。更新通过共享编排锁立即作用于该连接的**所有存活会话**——终端自动应答与命令弹窗在下一次提示时即用新值（对齐每次输出动态 resolve 的语义）；终端侧监视器随每次设置/配置更新按当前连接状态**重新挂载**：连接时未配置凭据（如密钥认证连接）或 Quick Sudo 处于关闭的会话，在运行时配置密码/TOTP 或重新打开开关后立即开始自动应答，无需重连。`sudoPassword` 等字段级覆盖是 sidecar 本地值，sidecar 重启或重开连接后恢复宿主下发的配置，而 `quickSudoProfileId` 绑定与 `agentTerminalMode` 持久化在插件数据目录、重启保留（0.4.49 起，见「AI 终端同步执行」）。工作台工具栏提供设置弹窗；宿主连接表单通过 manifest 字段提供持久化配置入口：`sudo_source`（三选一 `custom` 本连接 / `global` 全局配置 / `off` 停用；旧连接缺省时按 `quick_sudo` 布尔映射）、`sudo_profile`（仅 `global` 时显示，声明 `options_action: sudo/profiles/options` 由宿主渲染为动态下拉，无该扩展能力的宿主保留文本回退）、`sudo_password`、`sudo_use_pty`（仅 `custom` 时显示）、2FA 编排四件套 `totp_secret`、`auth_flow_mode`、`password_prompt_hint`、`totp_prompt_hint`（`global` 时隐藏——凭据来源整体由全局配置接管；`custom`/`off` 时常显以服务登录期 keyboard-interactive）、超时与 keepalive、`jump_hosts`、`set_env`（会话环境变量）、`remote_command`（会话命令，两者详见「会话环境与会话命令（SetEnv / RemoteCommand）」）、`triggers`（自动交互触发器）与 `password_command` / `passphrase_command`（外部密码管理器，三者详见「自动交互触发器（Expect）与外部密码管理器」）。

## AI 终端同步执行（agent terminal mode）

DBX 内嵌 AI 通道（`mcp/call` 携 lifecycle `connectionId`）的 `ssh_exec` / `ssh_exec_sudo`
可路由到**用户当前交互 shell**（PTY）执行：命令按键盘写入原文注入（与快速命令栏同
信任域，无 shell 拼接面；C0 控制字符先剥离），输出经终端录制（提示符回归 + 300ms
静默判定收尾；1 MiB 有界缓冲，ANSI 剥离后返回）。模式矩阵：

| `agentTerminalMode` | low 风险 | elevated（sudo / 灾难模式命中） |
| --- | --- | --- |
| `off`（默认） | 既有隐藏 exec 通道 | 既有隐藏 exec 通道 |
| `off` + 显式 `runInTerminal: true` | 直接注入（发 `ssh/agent/notice`） | 审批后注入（0.4.49 起；此前为拒绝） |
| `auto` | 直接注入（发 `ssh/agent/notice`） | 审批后注入 |
| `strict` | 审批后注入 | 审批后注入 |

- 调用级覆盖：工具可选参数 `runInTerminal`（`true` 强制终端路径、`false` 强制隐藏
  通道、缺省按连接模式）。stdio `--mcp` 模式的连接类调用自动经宿主桥转发到运行中的
  DBX 应用执行（embedded sidecar 按同一矩阵决策），因此连接级模式开关在 stdio 场景
  同样生效；宿主桥仅在显式 `runInTerminal: true` 或探针确认模式非 `off` 时才打开
  工作台标签，静默调用不再开标签也不再抢窗口焦点。`runInTerminal` 是 agent 可自主
  决定的参数（schema 引导：任务需要可见性/人工监督/交互性时主动置 `true`）。
- 持久化：连接级 `agentTerminalMode` 落盘 `<plugin_data_dir>/agent-modes.json`
  （版本化 JSON：`{version, modes: {connectionId: "auto"|"strict"}}`，原子写，
  `off` 移除条目；损坏按空表处理），sidecar/app 重启后保持，不再回落 `off`。
- 终端工具栏快速开关：工作台按钮行新增「终端 MCP 模式」弹出层（`Bot` 图标，非 `off`
  时高亮），就地读写连接级 `agentTerminalMode`（与设置弹窗共用 `ssh/settings/get` /
  `ssh/settings/set`）；开启后 MCP 命令在本终端可见执行（审计/学习），关闭走静默
  隐藏通道。
- 无终端会话：报错 `No open terminal session for this connection; open the SSH
  workbench terminal first`（可见才执行的承诺）。
- 审批：发 `ssh/agent/prompt` 事件并阻塞等待；`ssh/agent/resolve {challengeId,
  decision: "approve"|"deny", command?, remember?}`（approve 可携带弹窗编辑后的
  命令原文；`remember: true` 仅 approve 时有效，把该命令写入连接级免审批清单，见
  「审批记忆」节）；默认 120s（钳 10–300）超时即拒绝；挑战一次性。
- 收尾：发 `ssh/agent/finish {sessionId, status: "done"|"timeout"|"denied"}`。
- 响应：终端路径返回 `{output, exitCode: null, mode: "terminal", incomplete,
  interrupted}`；超时返回已捕获输出且 `incomplete: true`，命令留在终端继续跑、
  人工可接管（Ctrl+C 复用既有终端通道）。
- 已知限制：多行命令按行执行；全屏 TUI（vim/top 等）无提示符回归、走超时路径；
  回显/尾提示符剥离为尽力而为。
- 既有只读白名单与灾难 `confirmDestructive` 门禁先于路由判定生效，模式不放宽任何门。

## 审批记忆（remembered approvals）

AI 终端审批弹窗勾选「记住此命令」后，批准的命令（用户编辑后的最终文本）写入该
连接的免审批清单（`<plugin_data_dir>/agent-approved-commands.json`，版本化 JSON
`{version, connections: {connectionId: {commands: [原始行…]}}}`，tmp+rename 原子写，
普通 JSON 无凭据不做 0600；损坏按空库处理）。后续同连接的终端路由命中清单即直接
执行、不再弹审批：

- 匹配完整复用 sudo 白名单的 token 语义（`backend/src/sudo_allowlist.rs`）：token
  精确、`*` 匹配一个参数、尾 `*` 匹配剩余且须至少一个参数；记住时存精确形态，可在
  设置面板手工泛化为通配。
- 双重灾难锁（D2）：破坏性命令（`mcp_safety::assess_command == Destructive`）拒绝
  入库（`remember`/`ssh/settings/set rememberedCommands` 均拒绝，后者错误信息带
  行号），且命中清单前的重检对破坏性文本一律无效——灾难确认门永不绕过。
- 生效范围：`decide_with_memory` 只把 `Prompt` 降为 `Run`，`Deny`（off 模式未显式
  opt-in）不覆盖；off/auto/strict 三档下的已记住命令均可免审执行（用户显式动作
  优先于模式默认）。
- 管理：`ssh/settings/get` 返回 `rememberedCommands`（原始行数组）；`ssh/settings/set`
  接受 `rememberedCommands` 全量替换（每行 ≤500 字符、每连接 ≤50 行、去重）。
- 设置弹窗「AI 终端」区块提供清单展示与删除（保存随设置链全量提交）。

## 执行审计（audit log）

MCP/AI 执行面全量落本地 JSONL 审计账（`<plugin_data_dir>/audit-log.jsonl`，
append-only；5 MiB 轮转保留一代 `.1`；open-append 单行写保证 embedded sidecar 与
stdio `--mcp` 双进程共享数据目录时的行完整性；进程内 Mutex 串行）。审计面 =
`call_tool` 每次工具调用一条（gate + outcome + exitCode + 耗时）+ 终端路由审批
生命周期一条（`approval` 字段；工作台人工操作不记）。行结构（camelCase）：
`{tsMs, tool, connectionId, gate, approval, outcome, exitCode, durationMs, mode, command, output, error}`，
其中 `gate ∈ pass|write-denied|whitelist-denied|sensitive-path|destructive-unconfirmed|
sudo-allowlist-denied|read-only-server`，`approval ∈ none|prompt|approved|denied|
timeout|remembered`，`outcome ∈ ok|error`，`mode ∈ stdio|embedded|terminal`；
`command` / `output`（0.4.77 起）记录被审命令文本与其输出尾部——exec 族工具从
入参 `command` 与结果 `output` 提取，审批行只带命令文本；`command` 钳制 512 字符、
`output` 钳制 1024 字符，旧版行无此两字段按 null 回放。`error` 钳制 1 KiB，
凭据从不进入命令文本。宿主桥转发的调用由实际执行方（app 侧
sidecar）记账，不双计。

- `ssh/audit/list`：`{limit?: 1–500 缺省 100, beforeTs?: ms}` → `{entries: [行…],
  truncated}`，文件序（旧→新）取末尾 limit 条，只读。

## 告警分诊（alert triage）

`ssh/alert/triage {payload: string}`：把异构告警体（JSON 文本任意 schema，或纯文本）
标准化为固定结构并给出**只读诊断命令清单**。兼容语义对齐 openocta `/hooks/alert`：
JSON 解析失败或 `message` 为空时整包文本作为 message；`data` 字段（object）原样
序列化进 `dataJson`。分类为双语关键词计分（`cpu|memory|disk|inode|network|oom|
service|generic`，同分按固定序、全零落 generic）。响应：
`{normalized: {alertId, title, message, severity, source, dataJson}, category,
suggestions: [{command, purposeKey}]}`（字段钳制：title/message ≤2 KiB、dataJson
≤16 KiB）。硬约束：playbook 每条命令必须过 `mcp_safety` 只读白名单（单测钉死），
无重定向/`$()`/`sudo`——建议命令在只读连接上可直接经既有 exec 门执行。该方法是
纯分诊、无需连接、从不执行命令；执行由调用方经 `ssh_exec` 等门禁完成。MCP 通道
同名工具 `ssh_alert_triage`（非写工具、无连接参数）。工作台工具栏「告警排查」
（Siren 图标）弹窗提供粘贴→分析→逐条发送到终端/全部复制。

## Quick Sudo 全局配置

`sudo/profiles/*` 管理跨连接复用的多套 Quick Sudo 配置（全局配置 + 连接级覆盖语义），持久化于 `<plugin_data_dir>/quick-sudo-profiles.json`（版本化 JSON：`profiles` + `bindings`，Unix 权限 0600，原子写；损坏按空库处理；0.4.52 起 `version: 2` 并静态加密，见下）。每套配置含：`name`（唯一，trim 后 1–64 字符）、`sudoPassword`、`totpSecret`、`authFlowMode`（`password_only` / `password_plus_otp` / `password_then_otp`）、`passwordPromptHint`、`totpPromptHint`、`sudoUsePty`。上限 20 套。

**凭据静态加密（vault，0.4.52 起）**：文件内 `sudoPassword` / `totpSecret` 不再明文落盘，改为字段级 AES-256-GCM 信封（`sudoPasswordEnc` / `totpSecretEnc`，密文 `base64(nonce‖ct)`，AAD 绑定 `字段|档案id` 防密文挪用；空值不加密），name/提示词/模式等元数据保持明文。顶层 `crypto: {scheme:"aead-v1", storage:"keyfile"|"keychain"}` 声明 DEK 托管档位。**默认档为同目录 `vault.key`（0600）**：OS keychain 在 sidecar 二进制每次更新（macOS）或每进程首次访问时都会弹授权对话框，违背无人值守体验，故仅显式选入（环境变量 `DBX_SSH_VAULT_STORAGE=keychain`）时新建才走 keychain（服务 `io.dbx.ssh`、账户 `vault-dek-v1`；keyring，解析结果进程级缓存、至多弹一次）。遗留 keychain 档文件在首次成功解密时自动迁移为 keyfile 档并删除 keychain 条目；keychain 被拒绝时该进程内不再重试、文件保持原档位不被空密文覆盖。v1 明文文件加载后自动 best-effort 重写为 v2；解密失败按空处理、元数据保留。内存结构与全部方法视图不变（视图仍只出布尔位，`reveal` 仅工作台可用）。

- `sudo/profiles/list`：返回 `{ profiles: [视图…] }`，按名称排序；视图含 `id`、`name`、`sudoPasswordSet`、`totpConfigured`、`authFlowMode`、提示词、`sudoUsePty`、`createdAt`、`updatedAt`，**永不携带密钥明文**。
- `sudo/profiles/reveal`：参数 `id`；返回 `{ profile: 完整视图 }`（含 `sudoPassword` / `totpSecret` 原值），供工作台配置编辑器预填已存原值；未知 id 报错。**仅工作台方法，不进 MCP 工具面**——MCP 通道（list/save/工具 schema）只见布尔标记，密钥不进 agent 上下文。
- `sudo/profiles/save`：参数 `id?`（有=更新须存在，无=新建）、`name`、`sudoPassword?` / `totpSecret?`（空串/缺省=保持原值）、`clearSudoPassword?` / `clearTotpSecret?`（true=清除）、其余策略字段可选；返回 `{ profile: 视图, created }`。错误：名称为空/超长/重复（大小写不敏感）、id 不存在、超出上限。
- `sudo/profiles/delete`：参数 `id`；返回 `{ success, removed }`；级联清理绑定，并对受影响连接的存活会话即时回退到本连接配置。
- 连接绑定：`ssh/settings/set { sessionId, quickSudoProfileId }` 选择来源（见「运行时设置」）。绑定生效期间该配置**整体覆盖**本连接的 sudo 密码 / TOTP / 提示词 / 认证流 / `sudo_use_pty`（配置密码为空时回退登录密码，而非本连接 sudo 密码）；终端 auto sudo 与 `ssh/exec{sudo:true}` 走同一编排，自动使用所选来源。配置保存/删除即时热更新所有绑定它的存活会话（字段级覆盖，保留 OTP 防重放记账）。
- MCP 通道：`ssh_quick_sudo_profiles_list` / `ssh_quick_sudo_profiles_save` / `ssh_quick_sudo_profiles_delete` 三个工具与上述方法同构；`ssh_exec_sudo` 支持可选 `quickSudoProfile`（id 或精确名称）引用全局配置作为默认凭据，调用内联 `sudoPassword` / `totpSecret` 显式给出时优先；引用在发起任何连接 I/O 前解析，未知名称快速报错。
- MCP 安全门（`mcp_safety.rs`）：`ssh_exec` / `ssh_exec_sudo` 在执行前做命令风险分级——只读连接上仅放行白名单巡检命令（`ssh_exec_sudo` 一律拒绝）；命中灾难模式的命令（`rm -rf` 系统根、mkfs/dd 裸设备、shutdown、`/etc/passwd|sudoers` 覆盖、SQL DROP 等）任何连接都要求 `confirmDestructive: true`，只读连接直接拒绝；`DBX_SSH_MCP_READ_ONLY=1` 可把整个 MCP 进程强制只读。详见 `MCP.zh-CN.md` 生产误操作防范节。
- 入口桩：宿主贡献点仅有 `connection-provider` / `workbench` / `filesystem-provider` 三种，**没有插件级独立设置页**。因此完整管理 UI 挂在工作台（工具栏钥匙按钮直达管理弹窗；来源绑定在设置弹窗「sudo 凭据来源」）；连接表单通过 `connection-provider.actions` 暴露 `quick-sudo-profiles` 动作（`when: always`、`requires_valid_form: false`），点击由宿主调 `connection/action {action, id}`，插件返回配置清单 + 绑定状态的纯文本摘要（不含密钥），作为面板上的可发现桩。

## 跳板机（ProxyJump）与连接存活

- `external_config.jump_hosts`（最多 3 跳）定义跳板链：每跳包含 `host`、`port`（缺省 22）、`username`、`authentication`（`password` / `private-key` / `private-key-password` / `agent`）及对应凭据字段，可选 `totp_secret` / 提示词 / `auth_flow_mode`。配置跳板后整条链替换 runtime 隧道，末跳直连目标 `host:port`；每跳主机密钥独立校验，登录期 keyboard-interactive 2FA 同样生效。会话关闭时按序断开整条链。
- 协议层 keepalive：russh 按 `keepalive_interval_secs`（连接表单字段，缺省 30 秒，0 关闭）周期发送带应答的 keepalive 全局请求（等效 OpenSSH `ServerAliveInterval`），连续 3 次无应答即判定连接死亡，终端转入断开态、由工作台重连；跳板链每跳同参。
- 终端活动保活（`terminal_keepalive_secs`，连接表单字段，默认 0 关闭）：按配置间隔向交互终端 PTY 注入"空格+退格"（净零输入——空命令行不入 shell history，全屏程序内仅光标往返），用于对抗按键盘活动判空闲的服务器侧策略（`TMOUT`、堡垒机审计），协议层探测对此无效。解析侧钳制 5–3600 秒（`model.rs` `clamp_terminal_keepalive`）；仅作用于终端会话（MCP exec 通道不注入），会话关闭即随读写循环退出。`ssh/sessions/list` 以 `terminalKeepaliveSecs` 上报生效值。

## 会话环境与会话命令（SetEnv / RemoteCommand）

对标 ssh(1) `SetEnv` / `RemoteCommand` 的两个连接级会话特性（manifest 字段 `set_env` / `remote_command`，binding `config`；0.4.35 前存量为 `setEnv` / `remoteCommand` camelCase，sidecar 兼容读取两种命名；跳板链不继承，仅作用于最终会话）：

- `set_env`（textarea，默认空串）：每行一条 `KEY=VALUE`（分号亦可作分隔符，空白条目忽略，键值两侧空白去除），在交互终端通道（`ssh/session/open`，PTY 申请后、shell/exec 请求前）与 exec / sudo 命令通道上以 CHANNEL_REQUEST `env` 注入。重复键以最后一条为准——本地合并去重后每个变量恰好请求一次；sudo 通道内部 `SUDO_ASKPASS` 清空默认值让位于用户同名条目（用户值优先，不靠服务器端覆盖顺序）。**默认值**：空串（不发任何 env 请求）。**校验失败行为**：任一条目非法（缺 `=`、键为空或含空白或 NUL、值含 NUL）时连接解析直接失败，并聚合报出全部非法条目——宁可连不上也不错配。语义为客户端显式指定的环境，**不透传本地进程环境变量**；env 请求的注入失败（通道/传输级错误）即报错并命名该变量，不静默吞掉。注意与 ssh(1) 一致的协议现实：env 请求为 fire-and-forget，服务器未 `AcceptEnv` 对应变量时静默丢弃（不发失败应答可观测），此时该变量不生效但连接不失败——需要在远端生效请在服务器 sshd_config 配置 `AcceptEnv`。插件内部管道命令（metrics 采集、磁盘用量、服务器内复制）不注入 setEnv，保证输出解析与连接的语言覆盖解耦。
- `remote_command`（单行文本，默认空串）：非空时 `ssh/session/open` 在申请 PTY 并注入 setEnv 后 exec 该命令**替代 shell request**（PTY 照常申请，对标 `ssh RemoteCommand`）。空串 = 普通交互 shell（默认）。重连或工作台重开会话会**重放同一条命令**，属预期行为（与 ssh(1) 一致：每次新会话都重新执行）。MCP 隐藏 exec 通道、`ssh/exec`、sudo 执行与终端回放（replay）/重连语义不变——remoteCommand 只影响交互会话的启动方式。

## Quick Sudo 远程执行

`ssh/exec` 参数为 `sessionId`、`command`、`sudo`（可选，默认 false）、`timeoutSecs`（可选，5–300 秒）、`execId`（可选，用于取消），返回 `output` 与 `exitCode`；`ssh/exec/cancel` 携带 `execId` 中止执行中的命令并返回取消错误。命令通道（sudo 与非 sudo）会先注入连接的 `set_env` 条目（见「会话环境与会话命令」），注入失败即报错。

Quick Sudo（`sudo: true`）提供 sudo 远程执行服务：

- 命令以 `sudo -S -p '' sh -c '…'` 执行，密码写入 stdin（优先 `connection_secrets.sudo_password`，缺省回退登录密码）；未配置密码时回退 `sudo -n`（NOPASSWD 或已缓存时间戳）。
- 执行期间持续监控提示流，识别密码 / TOTP / 组合提示（内置中英文模式，可用 `external_config.password_prompt_hint`、`totp_prompt_hint` 自定义），并依据 `external_config.auth_flow_mode`（`off` / `password_only` / `password_plus_otp` / `password_then_otp`）自动应答。`off`（0.4.77 起连接表单默认）永不自动回 OTP 验证码（登录 keyboard-interactive、sudo watcher、组合提示三条路径一致，密码类提示照常应答，纯 OTP 凭据不再武装监视器）；存量连接字段缺省时仍按 `password_then_otp` 生效，不受新默认值影响。
- TOTP 密钥来自 `connection_secrets.totp_secret`，支持 `otpauth://totp/…` URI、base32 密钥或 4–10 位静态码；按 RFC 6238（SHA1/SHA256/SHA512，6–8 位）现场计算验证码。多个密钥按行/分号分隔，轮换选择规则：未用过的验证码优先、剩余有效时长最长者优先，配置顺序兜底。**同一验证码在提交后的重放窗口（自身有效窗 + ±1 步长）内不会被再次注入**——服务器普遍接受相邻窗口验证码，重复提交必然失败；命中窗口时自动应答直接跳过（不再等待用户输入），并在编排日志标注 `otp auto-answer skipped`。使用/防重放两本台账驻留 **sidecar 进程全局**（按 **目标作用域** `user@host:port` + 密钥 SHA-256 指纹 + 窗口 + 验证码键控，只存指纹不存密钥），跨 exec 调用、跨终端会话共享——MCP `ssh_exec_sudo` 每次调用独立解析编排实例，轮换状态依然连续；作用域隔离使共用同一密钥的多个连接互不吞码（A 机烧掉的码在 B 机仍可提交）；静态码的 usage 记账不随 `now+窗口` 漂移（键控不含时间戳）。sidecar 重启即清零。
- `external_config.sudo_source` 选择凭据来源：`custom` 本连接凭据（默认）、`global` 全局 Quick Sudo 配置（`sudo_profile` 按名称或 id 引用，未解析到时回落工作台绑定，再退化为本连接凭据，连接不失败）、`off` 停用；旧连接缺省时按 `quick_sudo` 布尔映射（true→`custom`、false→`off`）。`sudo_use_pty` 可为需要 TTY 的 PAM 栈请求 PTY（默认关闭，此时提示走 stderr；`global` 模式下配置自带的 PTY 偏好优先）。
- 检测到 `sorry, try again` 等认证失败标记立即报错；认证应答最多三轮。sudo 执行成功后按连接启动 `sudo -nv` 保活循环：每 4 分钟（`SUDO_KEEPALIVE_INTERVAL`）校验/续期时间戳，连续 2 次（`SUDO_KEEPALIVE_MAX_FAILURES`）校验失败自动停止（时间戳已失效，下次 sudo 执行会重新注册）；同一连接只保留一个循环，连接断开或会话清理时确定性中止。
- 只读连接拒绝 sudo 执行；密码与 TOTP 密钥仅停留在 sidecar 内存中，不下发工作台。

## 登录期 2FA（keyboard-interactive）

密码认证被拒绝或服务器未开放 `password` 方法时，自动降级 keyboard-interactive（PAM）认证：每一轮提示按 Quick Sudo 的同一套编排配置自动应答（密码 / TOTP / 组合提示，遵循 `auth_flow_mode`），未知提示留空交由服务器处理，最多 4 轮，复用连接超时。覆盖 `PasswordAuthentication no` + PAM 2FA 的主机，以及 JumpServer/koko 的"密码或私钥 + 动态口令"登录；密钥+密码（`private-key-password`）回退路径同样适用。

**首因子判定（2026-09-16，issue #17 / #30）**：`password_then_otp` 只在"首因子已经过掉"时才自动回 OTP 验证码。除同一次 KI 交换里答过密码提问外，以下两种情形同样算首因子已满足——① 密码方法已尝试、服务器要求继续认证（koko/JumpServer 用 partial success 表示"密码通过、还差 MFA"；即使服务器未置该位，密码已提交这一事实同样成立）；② 公钥 / SSH Agent 身份被服务器接受但要求后续认证（partial success 且剩余方法只有 keyboard-interactive，私钥/agent 路径据此续答 KI，不再直接报"认证被拒"）。既没有 password 方法、也没提交过密码的纯 KI 主机保持原保护：裸 OTP 提问不自动应答。

**提问识别**：除提问文本本身，挑战的 `name` / `instructions` 也参与匹配——堡垒机（koko）把可读文案放在 instructions（`Please Enter MFA Code.`）、提问是 `[OTP Code]: `，二者都能命中内置模式（新增 `otp code` / `mfa code` / `mfa:` / 动态密码 / 验证码 / 一次性密码）。OTP 信号优先于用户自定义的"密码提示词"：命中 OTP 模式的提问不会被密码提示词改判成密码提问（避免把登录密码当验证码回给服务器）。

**凭据来源与密码半边（2026-09-16）**：登录期 KI 用的流程模式 / TOTP 密钥 / 提示词与 Quick Sudo 同源——`global` 模式下连接表单隐藏 2FA 四件套（凭据整体由全局配置接管），登录提问因此也读该配置的 `authFlowMode` / `totpSecret` / hints；`custom` 模式下连接自身配置优先，绑定（0.4.x 遗留）只补齐连接留空的项；`off` 不提升全局配置。**密码半边始终是登录口令**（含 `password_command` 解析结果）：登录提问若回一个单独的 sudo 口令只会认证失败，还会把特权口令平白送给对端。

**选型指引**：主机先问 MFA、再问密码（或把验证码与密码放进同一个提问）时用「密码 + OTP 合并」模式——该模式不设"先密码"门槛，裸 MFA 提问也会被应答；「先密码，再 OTP」对裸 MFA 提问保持留空（保护），失败信息会点名提问与配置入口。

**诊断**：认证失败时错误信息带上服务器实际提问（`name` / `instructions` / 提问文本，去控制字符并截断，绝不包含凭据），并指路"配置该连接的 TOTP 密钥或 OTP 提示词"；`auth_flow_mode=off` 不自动回码时同样点名提问，便于用户知道该配哪里。端到端回归见 `scripts/smoke_login_mfa_test.py`（本机 mock 堡垒机 + 真 sidecar，paramiko 缺失时 SKIP）。

## 终端内 Quick Sudo

工作台终端输出流经统一的 sudo 检测与自动应答状态机：

- 出现 sudo 密码提示（`[sudo] password for …` / `Password:`）时自动注入密码并回车；sudo 需要的 2FA 验证码在配置了 `totp_prompt_hint`（或处于 `password_plus_otp` 模式）时自动应答，每个认证序列只应答一次。
- 通用提示仅在配置自定义提示词时应答，避免误答其他交互程序（保守策略）。
- **并发同靶排队**：批量发送把 sudo 命令写入同一 host:port 的多个会话时，各会话的 OTP 提示几乎同时出现，而当前窗口唯一的码已被先到的会话提交、重放保护拒绝重复注入——后到的提示不再永远搁置，而是推迟到下一个 TOTP 窗口边界（+1s）由终端读循环（250ms tick）自动补答新窗口的码（静态恢复码不变，不推迟）；期间检测到 shell 提示符即照常复位。
- 检测到 shell 提示符（行尾 `$` / `#`）即重置状态机。`sudo_source=off`（旧 `quick_sudo=false` 同义）或只读连接时整体停用；每次自动应答（含推迟补答）发出 `ssh/auto-sudo` 事件（`kind` 为 `password` / `otp`）供宿主审计。

## 自动交互触发器（Expect）与外部密码管理器

对标 tssh「自动交互（Expect 系列）」与「外部密码管理器（PasswordCommand / PassphraseCommand）」的两组连接级特性（manifest 字段 `triggers_enabled`、`triggers`、`trigger_answer_1`、`trigger_answer_2`、`password_command`、`passphrase_command`；仅作用于交互终端会话的 PTY 输出，exec/命令通道不接入）。tssh 官方项目与配置参考见 <https://github.com/trzsz/trzsz-ssh>；本插件保留一个整段文本输入框，不把 Expect 阶段拆成多组表单字段：

- `triggers_enabled`（boolean，binding config，默认 `false`）：连接表单独立总开关。关闭时即使 `triggers` 仍有旧文本也不会解析、校验或挂载引擎；统一默认关闭，必须手动打开。
- `triggers`（textarea，binding config，仅在 `triggers_enabled=true` 时显示；默认空）：expect 式有序阶段规则，接受 JSON 对象（宿主 lifecycle payload）与 JSON 字符串（表单 textarea）两种形态，JSON 顶层可选 `"enabled": false`（0.4.77 起）——保留规则的同时显式关闭引擎，缺省或 `true` 行为不变。字符串形态另兼容 tssh（trzsz-ssh）文本规则（0.4.77 起）：文本非法 JSON 但含 `Expect*` 指令即按 tssh 规则解析，`#!!` / `#!` / `#` 前缀可选——全局指令 `ExpectCount`（**0 即显式关闭**；缺省时按已列阶段数生效，不让粘贴的规则静默失效；正值截断超出序号的阶段）、`ExpectTimeout`、`ExpectSleepMS`、`ExpectPassSleep`（no|none|each|enter），阶段指令 `ExpectPatternN`、`ExpectSendTextN`、`ExpectSendOtpN` / `ExpectSendEncOtpN`（本地命令取 stdout，即 `sendCommand`；Enc 形态为 tssh `--enc-secret` 密文解密后取命令）、`ExpectSendPassN` / `ExpectCaseSendPassN <pattern> <enc>`（tssh `--enc-secret` 密文，**按 tssh 同款算法解密**——hex(nonce12 ‖ AES-256-GCM(ct‖tag))，固定内嵌密钥与 tssh 源码逐字节一致）、`ExpectSendTotpN` / `ExpectSendEncTotpN`（RFC 6238 TOTP：HMAC-SHA1、6 位、30 秒步长，命中时按当前时间生成验证码，与 pquerna/otp 默认参数逐字节兼容）及 `ExpectCaseSendTextN <pattern> <text>`；非合法正则的 pattern 按字面量匹配兜底（tssh README 示例 `*assword` 即非合法正则）。JSON schema：`{ "timeoutSecs": 30, "sleepMs": 100, "passSleep": "none", "enabled": true, "stages": [ { "pattern": "(?i)verification code", "sendText": "654321\\r", "sendSecretKey": "trigger_answer_1", "sendSecret": "字面密文", "sendTotp": "base32 TOTP 密钥", "sendCommand": "oathtool --totp -b %h", "casePattern": "\\(yes/no\\)", "caseSendText": "y", "caseSendSecretKey": "trigger_answer_2", "caseSendSecret": "字面密文" } ] }`（`sendSecret` / `sendTotp` / `caseSendSecret` 为 0.4.77 新增，承接 tssh 密文/TOTP 解密产物；连接配置持久化的是原始输入文本，解密值只在会话内存存活）。每阶段 `pattern` 必填（Rust `regex` crate 语法，支持 `(?i)`，≤512 字符）；应答 `sendText` / `sendSecretKey` / `sendSecret` / `sendTotp` / `sendCommand` **五选一**；case 组可选，`caseSendText` / `caseSendSecretKey` / `caseSendSecret` **三选一**。取值范围：`timeoutSecs` 1–600（默认 30）、`sleepMs` 0–5000（默认 100）、`passSleep` ∈ none|each|enter（默认 none）、阶段数 1–16、`sendText`/`sendSecret` ≤4096 字符、`sendTotp` 解码后 ≤64 字节、`sendCommand` ≤1024 字符。`sendText` 转义：`\r` `\n` `\t` 解释为控制字符、`\|` 为分段停顿符（段间停 `sleepMs`），其余反斜杠原样；密文/TOTP/命令应答自动补 `\r`。**校验失败行为**：非法 JSON / 非法 hex 或解密失败的 `--enc-secret` blob / 非法 base32 TOTP 密钥 / 不可编译正则 / 字段组合错误 / 超限 → 连接解析直接失败并报明确错误，不静默降级（tssh 文本形态仅 pattern 字面量兜底一处放宽）。
- 引擎语义（sidecar 终端读循环内）：PTY 输出经 ANSI 剥离归一化后进入 ≤8 KiB 滚动缓冲，跨 chunk 匹配；阶段命中即消费已匹配文本并推进游标（末阶段后回卷，序列可重复）；`casePattern` 命中即应答但**不推进**游标，答完继续等本阶段 pattern；行尾 `$` / `#` shell 提示（与终端内 Quick Sudo 同一判据）将游标归零（一轮结束后可再次触发）。**超时只在序列中途生效**（已命中前序阶段、在等第 2..N 阶段）——空闲等待第一阶段是事件驱动的无限期等待，不设超时、不产生 timeout 事件（否则闲置会话每 `timeoutSecs` 刷一次事件）；超时将游标归零，会话继续不断连。`passSleep` 仅作用于密文/命令应答：none 整段+回车一次写入、each 逐字符按 `sleepMs` 停顿、enter 先应答、停 `sleepMs` 再回车。
- 密文槽位（对齐 tssh `ExpectSendPass`）：`sendSecretKey` 引用 `connection_secrets.trigger_answer_1` / `trigger_answer_2`（manifest 各一个 password 字段，走宿主 secret binding）。槽位名固定两个；引用未知或未填充的槽位时连接失败。tssh `ExpectSendPassN` 的 `--enc-secret` 密文则按 tssh 同款固定密钥在 sidecar 内解密（同为混淆而非加密），无需密文槽。
- 事件 `ssh/trigger`：每次自动应答 / 超时发出 `{ sessionId, stage(1-based), kind: "text"|"secret"|"command"|"timeout" }`，**永不携带应答内容**（密文不出 sidecar）。`sendCommand` 本地执行失败时什么都不发送、不发事件（stderr 只记失败原因如退出码/超时）。
- 防双答互斥：触发器引擎在终端读循环中**先于**终端内 Quick Sudo 观察输出；同一 chunk 至多被其中之一自动应答（触发器命中则该 chunk 跳过 auto-sudo，反之亦然）。
- `password_command` / `passphrase_command`（text，binding config，默认空；对齐 tssh 同名配置）：登录密码 / 私钥口令缺失时本地执行命令取回（gopass、1Password CLI、`oathtool` 等）。占位符 `%h` host、`%u` username、`%p` port、`%n` 连接名（缺省回退连接 id）、`%%` 字面 `%`（其余 `%x` 原样保留）；unix `sh -c` / windows `cmd /C` 执行，10 秒超时，stdout 去掉**单个**结尾换行后为凭据（输出上限 4096 字节，超出按失败处理）。优先级：既有显式凭据（宿主 secret binding / 表单密码）> 命令；配置了 `password_command` 时密码类认证允许不存储密码；`passphrase_command` 仅在密钥确实无法无口令解码时执行。解析点：拨号认证的 orchestration 构建前一次性解析，结果回填后供密码链（password / keyboard-interactive）与 sudo 编排共用，单次连接只执行一次命令。
- MCP：连接类工具新增可选参数 `triggers`（JSON 字符串，同上 schema）、`passwordCommand`、`passphraseCommand`（字符串），与存储路径同一套解析校验，非法即拨号报错；内联拨号没有 secret binding，`sendSecretKey` 引用槽位即报错。MCP 的 `triggers` 是显式参数，不受连接表单 `triggers_enabled` 影响。
- `triggers/validate`（sidecar RPC）：复用同一 parser 做 JSON/tssh 语法检测，返回 `valid`、`enabled`、`format`（`empty`/`json`/`tssh`）和阶段数；失败只返回定位错误，不回显 secret、解密结果或 TOTP key。连接表单若不能调用该 RPC，`connection/test` 仍在启用时执行同一最终校验。
- **安全声明**：①恶意服务器可伪造匹配提示骗取回发内容（含密文槽位的值）——`pattern` 只应指向明确可信的提示序列，密文仅用于该连接上明确配置的场景；②`sendCommand` / `password_command` / `passphrase_command` 以当前用户权限在本地执行，命令完全来自用户自己的连接配置（插件不提供任何默认命令，MCP 工具描述不推广命令执行面）；③密文 / 凭据内容绝不进日志、事件或错误信息，命令输出用后 zeroize。

## Sudo 文件操作

`sudo/*` 方法族在不以 root 登录的前提下管理远端 root 文件，覆盖完整的 Sudo 文件操作族（`StatSudo` / `ListDirSudo` / `ReadFileSudo` / `WriteFileSudo` / `MkdirSudo` / `RemoveSudo` / `RemoveAllSudo` / `ChmodSudo` / `RenameSudo`）。全部方法复用 `ssh/exec` 的 Quick Sudo 编排（密码 / TOTP 自动应答、`auth_flow_mode`、提示词、`sudo -nv` 保活），在远端以 sudo 权限执行命令并解析输出：stat 走 `stat -c`，list 走 `ls -la --time-style=+%s`，read 走 `dd` / `base64`，write 走 `dd of=`。

公共参数：每个方法都必填 `sessionId`（string，会话 id），下文参数表不再重复列出。共同错误情形：

- 只读连接拒绝全部写操作（`touch` / `write` / `mkdir` / `remove` / `removeAll` / `chmod` / `rename`），错误信息与 SFTP 写操作一致；
- sudo 不可用（未配置密码且 `sudo -n` 失败、密码 / TOTP 认证失败、超过应答轮次）立即报错；
- 路径不存在按各方法说明处理（`exists` 返回 `false`，其余报错）。

### sudo/stat

查询单个远端路径的元信息。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端绝对路径 |

返回 `{ path, kind, size, modifiedAt, mode, owner, group }`：`kind` 取 `file` / `directory` / `symlink` / `other`；`size` 为文件字节数（目录可省略）；`modifiedAt` 为 Unix 秒级时间戳；`mode` 为八进制权限位字符串（如 `0644`）；`owner` / `group` 为属主 / 属组名。错误：路径不存在；sudo 不可用。

### sudo/exists

检查路径是否存在，参数同 `sudo/stat`（`sessionId`、`path`）。返回 `{ exists: bool }`，路径不存在不算错误。

### sudo/touch

创建空文件，或刷新已有文件的访问 / 修改时间戳。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 目标远端路径 |

无附加返回字段。错误：父目录不存在或无权限；只读连接；sudo 不可用。

### sudo/listDir

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端目录路径 |

返回 `{ path, entries }`，`entries` 为 `SftpEntry` 数组，结构与 `sftp/list` 完全一致（`name`、`uri`、`kind`、`size`、`modifiedAt`、`permissions`、`contentType`，可选字段缺省时省略）。错误：路径不存在或不是目录；sudo 不可用。

### sudo/readFile

按偏移分片读取文件内容。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端文件路径 |
| `offset` | number | 是 | 起始字节偏移 |
| `length` | number | 是 | 请求读取的字节数 |

返回 `{ dataBase64, truncated }`：内容以 base64 编码返回；实际返回少于 `length` 字节（如已到文件末尾）时 `truncated` 为 `true`，调用方据此推进 `offset` 续读。错误：路径不存在或不是普通文件；`offset` 超出文件大小；sudo 不可用。

### sudo/writeFile

整体覆写小文件。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 目标远端路径 |
| `dataBase64` | string | 是 | 完整文件内容（base64） |

解码后不得超过 4 MiB，超限直接报错——大文件必须改走 `sftp/upload/*` 上传槽。错误：载荷超限；父目录不存在或无权限；只读连接；sudo 不可用。

### sudo/mkdir

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 待创建目录路径 |

错误：路径已存在；父目录不存在或无权限；只读连接；sudo 不可用。

### sudo/remove

删除单个文件或空目录，不递归。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 待删除路径 |

错误：路径不存在；目标是非空目录（改用 `sudo/removeAll`）；只读连接；sudo 不可用。

### sudo/removeAll

递归删除目录树。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 待删除路径 |

递归删除，不跟随符号链接——只删除链接本身，不触碰其指向的目标（防误删语义）。错误：路径不存在；只读连接；sudo 不可用。

### sudo/chmod

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端路径 |
| `mode` | string / number | 是 | 八进制权限位，最大 `7777`（与 `sftp/chmod` 约定一致） |

错误：路径不存在；只读连接；sudo 不可用。

### sudo/rename

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sourcePath` | string | 是 | 原路径 |
| `targetPath` | string | 是 | 新路径 |

重命名 / 移动，语义等价 `mv`。错误：`sourcePath` 不存在；`targetPath` 父目录不存在或无权限；只读连接；sudo 不可用。

## 扩展文件操作

`sftp/*` 扩展方法基于 russh-sftp 原生协议与远端 `tar` 命令，提供 `Stat` / `Exists` / `Touch` / `WriteFile` / `Archive` / `Extract` 能力，走常规 SFTP 通道（无 sudo）。公共参数：均必填 `sessionId`（string，会话 id），下文参数表不再重复列出；写操作（`touch` / `write` / `archive` / `extract`）被只读连接拒绝。

### sftp/stat

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端绝对路径 |

返回结构与 `sudo/stat` 完全一致（`{ path, kind, size, modifiedAt, mode, owner, group }`）。错误：路径不存在。

### sftp/exists

参数同 `sftp/stat`（`sessionId`、`path`）。返回 `{ exists: bool }`，路径不存在不算错误。

### sftp/read

小文件直读（非传输槽，支持 `offset` 偏移分片语义）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端文件路径 |
| `offset` | number | 否 | 起始字节偏移，默认 `0`；省略或非法值按 `0` 处理 |
| `maxBytes` | number | 否 | 本次最多返回的字节数，默认 256 KiB，上限 1 MiB（至少为 1） |

返回 `{ dataBase64, truncated }`：内容 base64 编码；返回字节数达到 `maxBytes` 且文件还有剩余时 `truncated` 为 `true`，调用方以 `offset += 返回字节数` 续读。`offset` 在文件末尾或超出文件大小时返回空内容且 `truncated: false`（不报错，与 `sudo/readFile` 的「offset 超界报错」语义不同——SFTP 侧以空读表示 EOF）。错误：路径不存在或不是普通文件；无读取权限。

### sftp/touch

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 目标远端路径 |

创建空文件或刷新时间戳。错误：父目录不存在或无权限；只读连接。

### sftp/write

小文件直写（非传输槽）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `remotePath` | string | 是 | 目标远端路径 |
| `dataBase64` | string | 是 | 完整文件内容（base64） |

先写入同目录临时 `.dbx-part` 文件，完成后原子替换目标路径，避免读到半写状态。解码后不得超过 4 MiB，超限报错并提示改走 `sftp/upload/*` 上传槽。错误：载荷超限；父目录不存在或无权限；只读连接。

### sftp/archive

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sourcePaths` | string[] | 是 | 待打包的远端路径列表（至少一项） |
| `archivePath` | string | 是 | 输出归档路径（`.tar.gz`） |

在远端执行 `tar -czf` 打包为 tar.gz。返回 `{ path, size }`（归档路径与字节数）。错误：任一源路径不存在；输出父目录不存在或无权限；远端缺少 `tar`；只读连接。

### sftp/extract

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `archivePath` | string | 是 | 归档路径（`.tar.gz` / `.tgz` / `.tar`） |
| `destinationPath` | string | 是 | 解压目标目录 |
| `overwrite` | bool | 是 | 是否覆盖已存在的同名条目 |

仅支持 tar.gz / tgz / tar；传入 `.zip` 明确报错（不支持 zip）。`overwrite` 为 `false` 且目标目录下已存在同名条目时报错。错误：归档不存在；格式不支持；目标目录不存在或无权限；远端缺少 `tar`；只读连接。

### sftp/copy

服务器内复制（server-internal copy & paste 语义）。源被复制**进** `toDir`，保留各自的基名；目录递归复制并保留权限（远端 `cp -a --`）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `from` | string / string[] | 是 | 单个或多个源路径 |
| `toDir` | string | 是 | 已存在的目标目录 |
| `overwrite` | bool | 否 | 目标已存在时是否覆盖（默认 `false`，不覆盖时报错） |

会话内 `sessionId` 与连接级 `connectionId` 二选一（`connectionId` 自动解析到该连接的存活会话）。返回 `{ success, results: [{ from, to, ok, error? }] }`：逐项执行、逐项回报，`error` 仅出现在失败项上；任一项失败则 `success` 为 `false`。`overwrite: false` 时先用远端 `test -e` 探测目标，已存在直接按项失败。同一目录内的 move 优先走 SFTP rename。错误（整体）：参数缺失或非法；只读连接。

### sftp/move

服务器内剪切 / 移动。参数与返回结构同 `sftp/copy`；远端 `mv -f --`（`overwrite: false` 时先探测目标，存在则按项报错），移动完成后源路径不复存在。sudo 模式不做。远端 `cp` / `mv` 的执行预算为 300 秒。

## 服务器指标

`ssh/metrics` 以单条 POSIX 只读命令采集：`/proc` 读取器、两次 `/proc/stat` 采样（间隔 0.4s）算 CPU 利用率、`df -kP` 采集挂载、`df -iP` 采集 inode 使用率，另附网络与进程扩展——两次网络计数快照（间隔 1s；Linux 读 `/proc/net/dev`，macOS/BSD 回退 `netstat -ibn`）差分出每接口速率，`ps` 分别按 CPU 与内存排序取前 8 进程。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | string | 是 | 会话 id |
| `cached` | bool | 否 | 为 `true` 时优先返回该会话上一次采集的快照（带 `cachedAt` 字段，Unix 秒）；无缓存时现采并回填。默认 `false` 现采（成功后同样回填缓存） |

返回（关键字段，camelCase）：

```
{
  "hostname": "...", "kernel": "...", "uptimeSeconds": 123456,
  "cpu": { "cores": 8, "percent": 12.3, "load1": 0.4, "load5": 0.3, "load15": 0.2 },
  "memory": { "totalBytes", "availableBytes", "usedBytes", "swapTotalBytes", "swapUsedBytes" },
  "disks": [{ "filesystem", "mount", "totalBytes", "usedBytes", "availableBytes", "percentUsed",
              "inodeUsePercent" }],
  "network":  [{ "name", "rxRate", "txRate", "rxTotal", "txTotal" }],
  "processes": [{ "pid", "user", "cpuPercent", "memPercent", "command" }],
  "topMemory": [{ "pid", "user", "cpuPercent", "memPercent", "command" }],
  "cachedAt": 1756300000        // 仅 cached 命中时出现
}
```

`network` 速率为两次快照间的字节/秒；`rxTotal` / `txTotal` 为第二次快照的累计字节数。`processes` 为按 CPU 排序的前 8 进程，`topMemory` 为按内存占用排序的前 8 进程（两者字段同构，均为扩展字段，旧 sidecar 可能缺失——调用方按可选处理）。`disks[].inodeUsePercent` 为该挂载点的 inode 使用率（百分比数值），仅当 `df -iP` 采集到对应挂载时出现（GNU/busybox 列布局差异由解析端吸收）。`command` 截断到 120 字符。快照缓存仅存内存（每会话一份），会话关闭即清除。只读命令，只读连接同样可用。

## 二进制通道

- `ssh/terminal/in/{sessionId}`：原始终端输入。
- `ssh/terminal/out/{sessionId}`：首字节为流类型，随后为大端 `u64` 单调序号，再后为终端数据。
- `sftp/upload/{taskId}`：大端 `u64` 文件偏移加最多 256 KiB 数据；偏移必须等于服务端期待值。
- `sftp/download/{taskId}`：大端 `u64` 文件偏移加最多 256 KiB 数据。

终端输出保留 2 MiB 环形缓存。前端检测到序号缺口后停止乱序输出并调用 `ssh/terminal/replay`。文件传输采用逐块 RPC 确认，不依赖广播队列可靠送达。

传输状态查询（只读，不产生副作用）：

- `sftp/transfer/list`：参数 `sessionId`。返回 `{ tasks: [...] }`——该会话进行中的上传 / 下载与近期历史（每个会话独立记录），元素结构 `{ taskId, sessionId, direction, fileName, size, transferred, status }`，`status` 取 `running` / `completed` / `cancelled`。
- `sftp/transfer/status`：参数 `taskId`。返回单个任务的同构状态对象；任务不存在时先查历史，仍无则报错。
- `sftp/transfer/history`：参数 `sessionId?`（可选过滤）、`limit?`（默认 50，上限 200）。返回 `{ tasks: [...] }`——持久化传输历史（`transfer-history.json`，环形上限 200 条，跨 sidecar 重启保留）与内存 live 任务按 `taskId` 去重合并、新→旧排序，元素结构 `{ taskId, sessionId, connectionId, direction, fileName, size, transferred, status, startedAt, finishedAt, error? }`（时间戳 Unix 毫秒；`status` 同上并含 `failed`）。无活动连接也可查询；仅状态跃迁落盘，逐块进度不落盘；跨进程（embedded 与 stdio `--mcp`）last-writer-wins；重启后遗留 `running` 呈现为 `failed`（不回写文件）。不进 MCP 工具面。

## 主机密钥

`DBX_PLUGIN_DATA_DIR/known_hosts` 保存插件确认过的主机密钥，同时只读系统 `known_hosts`。未知主机通过 `ssh/host-key/prompt` 事件交给工作台确认；已知主机密钥变化直接拒绝，不能用一次确认覆盖。

插件数据目录解析顺序（取第一个可用项，"可用"= 环境变量存在且 trim 后非空）：① `DBX_PLUGIN_DATA_DIR` 原样使用（宿主显式注入，未来方案 A 接入点）；② `DBX_DATA_DIR` → `<DBX_DATA_DIR>/plugin-data/io.dbx.ssh`（便携/web 模式，`plugin-data/` 避开安装器管理的注册树）；③ 平台标准用户数据目录下 `dbx-plugin-data/io.dbx.ssh`（macOS `$HOME/Library/Application Support`、其他 unix `${XDG_DATA_HOME:-$HOME/.local/share}`、Windows `%APPDATA%`）；④ 全缺才回落 `std::env::temp_dir()/dbx-plugin-data/io.dbx.ssh`（临时兜底，永不失败）。当前宿主尚未注入 `DBX_PLUGIN_DATA_DIR`，实际生效的是 ③；切勿将持久数据依赖 ④ 的临时目录（重启即清空）。

框架级连接测试挑战采用事件 `connection/challenge` 和固定响应方法 `connection/challenge/resolve`。原型未声明 `test`，因此暂不触发该流程。

## 本地密钥与 known_hosts

本地能力，不依赖任何连接，均不携带 `sessionId`。两类方法都只返回元信息（路径、算法、指纹），绝不返回私钥内容或口令。

### keys/discover

参数：无（空对象）。扫描 `~/.ssh` 下默认命名的私钥（`id_rsa` / `id_ed25519` / `id_ecdsa` 等，不含 `.pub`）以及 `~/.ssh/config` 中声明的 `IdentityFile`。返回 `{ keys: [...] }`，元素结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 私钥绝对路径 |
| `algorithm` | string | 公钥算法（如 `ssh-ed25519`、`ssh-rsa`、`ecdsa-sha2-nistp256`） |
| `fingerprint` | string | 公钥指纹，`SHA256:…` 格式 |
| `hasPassphrase` | bool | 私钥是否带口令 |

`~/.ssh` 不存在或无可识别私钥时返回空 `keys` 数组，不算错误。

### ssh/knownHosts/list

参数：无。列出插件自身 known_hosts 存储（`DBX_PLUGIN_DATA_DIR/known_hosts`）中的条目；系统 `~/.ssh/known_hosts` 保持只读、不参与管理。返回 `{ entries: [...] }`，元素结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | 主机名或 IP |
| `port` | number | 端口（默认 22） |
| `keyType` | string | 密钥类型（如 `ssh-ed25519`） |
| `fingerprint` | string | 主机密钥指纹 |
| `marker` | string / null | OpenSSH 标记：`@cert-authority`（CA 信任）或 `@revoked`（吊销）；普通条目为 `null`。标记条目按其 host 字段（可为通配模式）展示与删除 |

列表按 `host` → `port` → `keyType` 稳定排序。通配模式的标记条目（如 `*.prod.example`）仅按字面 host 匹配删除，不做 glob 展开。

### ssh/knownHosts/remove

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `host` | string | 是 | 主机名或 IP |
| `port` | number | 是 | 端口 |

返回 `{ removed: n }`（实际删除的行数，可为 0；同一主机的标记行与普通行一并按 host 匹配删除）。条目删除后，对应主机再次连接会重新触发 `ssh/host-key/prompt` 确认。错误：known_hosts 文件读写失败。

### ssh/sessions/list

参数：无。返回 sidecar 内存中当前跟踪的会话清单（不发起任何 SSH 流量），用于诊断与多面板展示。返回 `{ sessions: [...] }`，按 `createdAt` 升序稳定排序：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 会话 id（与 `ssh/session/open` 返回一致） |
| `connectionId` | string | 所属连接 id |
| `workbenchId` | string | 所属工作台 id |
| `readOnly` | bool | 只读连接标志 |
| `connected` | bool | 会话是否存活（传输层断开后为 `false`） |
| `sudoKeepalive` | bool | 该连接是否运行 Quick Sudo 时间戳保活循环 |
| `terminalKeepaliveSecs` | number | 终端活动保活间隔（秒，0=关闭）；回显该连接 `terminal_keepalive_secs` 的生效值 |
| `createdAt` | number | 会话创建时刻（Unix 秒） |
| `authMethod` | string | 该连接的认证方式名（`password` / `private-key` / `private-key-password` / `agent` / `none`；连接不在注册表时回退 `password`）。仅方法名，**不含任何凭据材料**；供工作台连接信息面板只读展示 |
| `host` | string | 所属连接主机名/IP（连接不在注册表时为空串）；只读展示字段 |
| `port` | number | 所属连接端口（连接不在注册表时回退 22） |
| `username` | string | 所属连接登录用户（连接不在注册表时为空串） |

内存态清单，sidecar 重启即清零；会话关闭（`ssh/session/close`、`workbench/close`、连接断开）后不再出现。

### ssh/quickCommands/list、ssh/quickCommands/save、ssh/quickCommands/delete

全局快速命令：用户自定义的常用命令片段（名称 + 命令原文），持久化在
`DBX_PLUGIN_DATA_DIR/quick-commands.json`（原子写、Unix 0600、坏文件降级为空清单），
**所有连接与工作台共享一份**（全局共享语义；此前存工作台
localStorage 会因宿主 webview 存储分区表现为"绑连接"，已废弃该存储）。
上限 20 条、`name` ≤ 60 字符、`command` ≤ 500 字符（与前端 `lib/quickCommands.ts`
常量一致）。命令不含凭据字段，无脱敏需求，但文件权限与 sudo 配置存储保持同款收紧。

`ssh/quickCommands/list`：参数无。返回 `{ commands: [{ id, name, command, createdAt, updatedAt }] }`，按插入顺序（`createdAt` 升序）排列。

`ssh/quickCommands/save`：参数 `id?`（空/缺省=新建，非空=更新须存在）、`name?`（空/缺省取 `command` 截断兜底）、`command`（必填，trim 后非空）。返回 `{ quickCommand: {…}, created: bool, commands: [...] }`（完整清单随响应下发，工作台可直接采纳权威顺序）。错误：超限（"At most 20 quick commands…"）、字段超长、`command` 缺失。

`ssh/quickCommands/delete`：参数 `id`。返回 `{ removed: bool, commands: [...] }`；id 不存在时 `removed: false` 不算错误（对齐 `ssh/knownHosts/remove` 语义），此时不重写存储文件。

### sftp/bookmarks/list、sftp/bookmarks/save、sftp/bookmarks/delete

SFTP 路径书签：用户收藏的命名远端路径（label + path），持久化在
`DBX_PLUGIN_DATA_DIR/sftp-bookmarks.json`（原子写、Unix 0600、坏文件降级为空清单），
**全局共享一份**（不按连接分组），模式与 `ssh/quickCommands/*` 同构。上限 20 条
（仅约束新建）、`label` trim 后 1–64 字符且全库唯一（大小写不敏感）、`path` 非空
≤ 1024（不做存在性校验，书签可指向未挂载路径）。

`sftp/bookmarks/list`：参数无。返回 `{ bookmarks: [{ id, label, path, createdAt, updatedAt }] }`，按 `label` 排序。

`sftp/bookmarks/save`：参数 `id?`（有=更新须存在，无=新建）、`label`、`path`。返回 `{ bookmark: {…}, created: bool }`。错误：`label` 为空/超长/重复（大小写不敏感）、`path` 为空/超长、`id` 不存在、超出上限。

`sftp/bookmarks/delete`：参数 `id`。返回 `{ success, removed }`；未知 id 报错。工作台方法，不进 MCP 工具面。

### ssh/terminal/batchInput

批量发送命令：把同一条命令写入多个**已打开**会话的
交互终端（PTY 键盘语义）——输出回显在各自会话的终端里，`cd`/`env` 等状态留在
各 shell；方法本身不收集远端输出与退出码，只返回逐会话**发送**结果。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionIds` | string[] | 是 | 目标会话 id 非空数组；后端按序去重 |
| `command` | string | 是 | 命令原文；`\r\n`/`\n`/`\r` 归一为 `\r`（每个即一次回车），归一后上限 256 KiB |
| `appendNewline` | bool | 否 | 默认 `true`，末尾追加回车即执行 |

返回 `{ results: [{ sessionId, success, error? }], sent, failed }`：会话不存在、输入队列满/关闭记为该目标 `failed`（带 `error` 文本），不影响其他目标。发送语义等同用户键盘输入，命令原文不做 shell 转义；只读连接不拦截（与终端手敲一致）。

### 断点续传（sftp/upload/start resumeTaskId、sftp/download/start offset、sftp/transfer/resumable）

上传**恢复**：`sftp/upload/start` 新增可选 `resumeTaskId` —— 指向一次此前中断的上传任务。后端校验
`<data_dir>/transfers/upload-<taskId>.json` sidecar meta（`remotePath`/`size` 必须与本次请求一致）与
`upload-<taskId>.part` spool 文件后，以追加模式复用该 spool，返回 `{ taskId, chunkSize, maxBytes, resumeOffset }`
（`resumeOffset` = 已 spool 字节数；新任务恒为 0）。调用方只重传 `resumeOffset` 之后的分片（二进制通道
offset 语义不变）。中断来源不限：前端中止、sidecar 重启、会话断开（meta+spool 保留即列为可续传）。
任务取消仍删除 spool 与 meta（显式放弃）；`finish_upload` 不完整分支保留它们供续传。历史上限
`resumeOffset <= size`，非法组合报错。`sftp/transfer/resumable` 无参，返回
`{ tasks: [{ taskId, direction: "upload", remotePath, fileName, size, resumableBytes }] }`
（按 taskId 倒序≈最新优先；live 任务与 meta/spool 缺失者不在列）。不进 MCP 工具面。

下载**恢复**：`sftp/download/start` 新增可选 `offset`（默认 0）——调用方本地已持有前 `offset` 字节，
后端把 `nextOffset` 置为该值继续分片；`offset > size` 报错。身份校验仅为 best-effort 的 size 一致
（同尺寸改写会拼接错内容，文档明示）；返回体新增 `resumeOffset` 回显。会话内暂停/恢复为纯前端语义
（分片循环在两分片之间挂起），不涉及新方法。

### ssh/metrics/history

参数 `{ sessionId, limit? }`（默认/上限 720）。返回 `{ connectionId, samples: [...] }`，样本旧→新排列，
每行 `{ connectionId, ts, cpuPercent?, memoryPercent?, load1?, rxRate, txRate }`（时间戳 Unix 毫秒）。
落盘为 `<data_dir>/metrics-history.jsonl`，每次**新鲜** `ssh/metrics` 采集追加一行（缓存命中不落），
环形上限 720 行（≈5s 轮询 × 1h）；行按连接 id 维度过滤读取，跨 sidecar 重启保留；坏行跳过。
`cpuPercent`/`memoryPercent` 快照缺失时整键省略（非 null 占位）。

### ssh/processes/list、ssh/processes/kill

`ssh/processes/list`：参数 `{ sessionId }`。单条只读命令
`ps -eo pid=,ppid=,user=,pcpu=,pmem=,etime=,state=,args= | sort -k3,3nr | head -n 500` 采集，
返回 `{ processes: [{ pid, ppid, user, cpuPercent, memPercent, etime, state, command }] }`
（CPU 降序、服务端封顶 500 行、`command` 截断 200 字符；前端可本地重排）。不进 MCP 工具面。

`ssh/processes/kill`：参数 `{ sessionId, pid, signal? }`（默认 15）。后端校验：pid 为正整数且
`> 1`（init/pid 0 直接拒绝），signal 仅接受 `1/2/9/15`；渲染为 `kill -<NAME> <pid>`（数值全部白名单化，
无注入面）。返回 `{ success: true, pid }`；远端退出码非 0 报错（如进程不存在）。

### ssh/recording/start、stop、list、get、delete

会话级录制：`ssh/recording/start`（参数 `{ sessionId }`）在会话读循环安装录制器，输出
（stdout+stderr、目录跟随过滤后、不含 State 帧）以 asciicast v2 JSONL 写入
`<data_dir>/recordings/<recordingId>.cast`——首行为 v2 头（`version/width/height/timestamp/env/meta`，
`meta` 携带 `sessionId/connectionId/host`），其后每行 `{"time": <秒>, "eventtype": "o", "eventdata": "…"}`
（单事件截断 256 KiB）。每会话同时最多一段录制，重复 start 报错；会话关闭（读循环退出）自动
finish，无需显式 stop。`stop` 返回摘要
`{ recordingId, sessionId, connectionId, host, path, startedAt, durationSecs, events, bytes }`。

`ssh/recording/list` 无参 → `{ recordings: [{ recordingId, sessionId, connectionId, host, startedAt,
durationSecs, bytes }] }`（文件 mtime 新→旧；坏文件跳过）。`ssh/recording/get` 参数
`{ recordingId, offset?, limit? }`（limit 上限 500）→ `{ recordingId, offset, total, hasMore,
events: [{ time, type, data }] }`（旧→新分页）。`ssh/recording/delete` 参数 `{ recordingId }`
删除文件；id 走路径穿越校验（含 `/`、`\`、`..` 拒绝）。录制属工作台能力，不进 MCP 工具面；
`ssh/sessions/list` 每行新增 `recording: bool` 反映该会话是否录制中。
