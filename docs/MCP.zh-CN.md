# MCP 集成

SSH/SFTP 插件有两种被 MCP 调用的方式。**推荐使用 DBX MCP 桥**——凭据来自 DBX 保存的连接，不另起进程、不另配凭据。

## 方式一：DBX MCP 桥（推荐）

DBX 的 MCP 服务器（`dbx mcp` 或桌面内置 MCP）内置两个通用插件桥工具：

| 工具 | 说明 |
| --- | --- |
| `dbx_list_plugin_tools` | 列出所有已装插件贡献的 MCP 工具（含本插件的 31 个 SSH/SFTP 工具及其 JSON Schema） |
| `dbx_call_plugin_tool` | 调用插件工具；传 `connectionId` 即引用 DBX 已保存的 SSH 连接，凭据由 DBX 解析转发，**工具参数里不出现任何密码** |

典型调用流（MCP 客户端视角）：

```
dbx_list_connections                      → 找到 SSH 连接 id
dbx_list_plugin_tools                     → 发现 io.dbx.ssh 的 ssh_exec / sftp_* / ssh_metrics 等工具
dbx_call_plugin_tool {
  pluginId: "io.dbx.ssh",
  tool: "ssh_exec_sudo",
  connectionId: "<DBX 连接 id>",
  arguments: { "command": "systemctl status nginx" }
}
```

实现细节：

- 桥由宿主 `dbx-mcp` 提供（`LocalBackend`），通过标准 sidecar 协议调用插件的 `mcp/tools`（工具发现）与 `mcp/call`（工具执行）方法；连接凭据以标准 connection lifecycle payload 转发（`PluginHost::connection_params_standalone`），与工作台连接共用同一份配置——包括跳板链、Quick Sudo、TOTP、提示词、`auth_flow_mode` 等全部设置项。
- 插件侧按 `connectionId` 维护连接池，断线自动重连；主机密钥沿用插件的 known_hosts 存储（首次未知主机需先在工作台连接一次确认，或在方式二中用 TOFU）。
- Scoped AI 会话中 `dbx_call_plugin_tool` 被禁用（可能触发变更操作），`dbx_list_plugin_tools` 保持可见。

### 客户端配置示例

```json
{
  "mcpServers": {
    "dbx": {
      "command": "/path/to/dbx",
      "args": ["mcp"]
    }
  }
}
```

## 方式二：独立 stdio 模式（无 DBX 宿主时）

插件二进制直接作为 MCP 服务器运行（MCP `2024-11-05`，换行分隔 JSON-RPC 2.0）：

```bash
dbx-plugin-ssh --mcp
```

此模式下没有 DBX 连接存储，凭据随每次调用内联传入（`host`/`username`/`password` 或 `privateKeyPath`，及 Quick Sudo/2FA 编排字段、`jumpHosts` 跳板链），按 `username@host:port` 进程内池化。未知主机密钥采用 **TOFU 首次信任**（记录后变化仍拒绝）。MCP 模式与 DBX 插件模式互斥：同一进程只运行其中一种。`initialize` 的 `serverInfo.name` 为完整插件 id `io.dbx.ssh`（与同系列插件一致）。带 `connectionId` / `connectionName` 的调用另有桥接兜底，见下节。

### stdio 桥接兜底（免内联凭据）

stdio 会话里用 `connectionId` 调用连接类工具（`ssh_exec` / `ssh_exec_sudo` / `ssh_run_bg` / `ssh_task_status` / `ssh_metrics` / `ssh_test_connection` / `sftp_*` 全家）时，若该 id 未在本会话注册，整次调用自动转发给运行中的 DBX 应用本地 TCP 桥执行——应用未运行会自动唤起，凭据由应用侧解析，**不经工具参数**；桥不可用（应用无法唤起、桥端口不可达等）时回落原内联凭据路径，工具面形状不变。

转发语义注意：

- 命令在**应用侧** sidecar 执行，本会话的进程级只读开关（`DBX_SSH_MCP_READ_ONLY`）与每连接 sudo 白名单闸门**不适用**——由应用侧连接自身的只读标志与连接配置生效。
- 未注册 id 的报错文案给出三条出路：启动 DBX 应用 / 用 `ssh_list_connections` 列出 id / 提供内联凭据。
- 完整列表能力要求应用版本含 `POST /list-plugin-connections` 桥路由，旧版应用上 `ssh_list_connections` 降级为"仅本会话注册表"并附 `note` 说明。
- **桥降级行为**：全部 21 个连接级工具在未注册 id 下都进入同一转发计划；桥端口已发布但应用已死（端口陈旧/假监听）时转发**快速回落**（不消耗唤起等待预算），回落错误带自愈引导；`ssh_list_connections` 在桥不可答时降级 `session-registry` + `note`。smoke 以内嵌 stub DBX app（内存 HTTP 服务器）实转 `/list-plugin-connections` 与 `/call-plugin-tool` 全链路（连接名经桥解析、转发按解析出的 id、应用侧 MCP envelope 原样透传）。

### JSON-RPC 错误码分档

stdio JSON-RPC 层错误码与同系列插件一致：**传输层用标准码**——`-32700` parse error（请求行非合法 JSON）、`-32601` method not found（未注册的 `method`，文案仍为 `Method not found: <method>`）、`-32600` invalid request（缺 id 等）；**工具级/应用级错误（含 `tools/call` 内未注册工具名、门拒绝、远端失败）一律 `-32000`**。桥模式（DBX 插件内嵌）不经 JSON-RPC 信封，业务错误统一 `-32000`（`to_plugin_error`），未知 binary 通道 `-32601`。

### 传输层健壮性

stdio 分发循环对敌意输入保持"进程不崩、连接不挂、后续请求照常"：

- **非法 JSON / 非法 UTF-8 字节流** → 单行 `-32700` parse error（id 为 null）后继续服务；真正的管道 I/O 错误仍然终止。
- **notification**（`method` 为 `notifications/*`，无 id）→ **不产生任何响应**，连接继续可用；无 id 的非 notification 请求按分档回 `-32600`（null id）。
- **信封校验（`-32600`）**：`jsonrpc` 非 `"2.0"`（含缺失/数字形态）、`method` 缺失或非字符串、`id` 为 object/null/bool 等非法形态 → 结构化 invalid request；合法 string/number id 原样回显。
- **超长行**（如 8 MiB 参数串）：上限内正常解析并按工具语义应答，不 panic 不挂死。**单行上限**：`DBX_SSH_MCP_STDIO_MAX_LINE`（字节，缺省 16 MiB；非法/0 值回落缺省）。超限行整体丢弃（连同行尾换行消费完毕）并回单条 `-32700`（消息带上限字节数与 env 名），随后继续服务下一请求；非法 UTF-8 经有损解码走同一 `-32700` 路径。
- **pipelining**：请求可不等响应连发，响应按 id 一一对应（处理器并发执行，单行完整性由 stdout 互斥锁保证）。
- **空行 / 纯空白 / CRLF 行尾**：静默容忍，不产生响应也不死循环。

以上行为由 smoke 的 `protocol robustness` 段逐项覆盖（每种敌意输入后跟合法 ping 验证会话健康）。

### connectionId 从哪来

按以下顺序发现，凭据暴露面逐级增大：

1. **`ssh_list_connections`**（首选，无参数）：列出已保存连接元数据（id / name / host / port / username / authentication / readOnly），**只出元数据、任何密钥只出布尔标志位，绝不出值**；`source` 字段标明数据来源（`dbx-app-bridge` 应用桥 / `session-registry` 本会话注册表），降级时附 `note` 说明。
2. **`connectionName` 或 endpoint**：连接类工具可用连接名代替 `connectionId`；若名称重复，同时传 `host`、`port`、`username` 可缩小到唯一连接。也可以不传 id/name，直接用完整 endpoint（`host` + `username`，`port` 默认 22）唯一复用已注册连接。只匹配到多个候选时拒绝执行并列出候选，绝不猜选；stdio 下相同规则先从 DBX bridge 列表解析出 id 后再转发。
3. **内联凭据（最后兜底）**：桥不可用时才考虑。凭据所在位置为 DBX 应用数据 `com.dbx.app/dbx.db` 的 `connections` 与 `connection_secrets` 表——凭据会进工具参数与 LLM 上下文（暴露面），仅限本机可信会话使用。

### 接入 ZCode（stdio 客户端）

独立 stdio 模式可直接注册为 ZCode 的 MCP 服务器（本机路径为机器相关配置，
放用户级 `~/.zcode/cli/config.json` 的 `mcp.servers`，不放工作区共享配置）：

```json
{
  "mcp": {
    "servers": {
      "dbx-ssh": {
        "type": "stdio",
        "command": "/绝对路径/backend/target/release/dbx-plugin-ssh",
        "args": ["--mcp"]
      }
    }
  }
}
```

- 会话启动时自动连接；`tools/list` 即 31 个工具，无需 DBX 在场。
- 凭据内联传参、带 `connectionId` / `connectionName` 时自动桥接转发（见上节），
  或在 DBX 桥模式可用时优先走方式一；数据目录默认
  `/tmp/dbx-plugin-data/io.dbx.ssh`，可用 `DBX_PLUGIN_DATA_DIR` 重定向
  （known_hosts / `mcp-settings.json` / Quick Sudo 全局配置都在其中）。
- 真机回环验证：`DBX_SSH_SMOKE_PASSWORD=… python3 scripts/smoke_mcp.py
  --host <host> --port <port> --username <user>`（凭据走环境变量，不落盘）。

## 工具一览（31 个，两种方式通用）

### 本地传输路径约束（sftp_upload / sftp_download）

MCP 调用方是 LLM，`sftp_upload`（本地读）与 `sftp_download`（本地写）的本地
路径因此受双重约束，任何一条不满足都在拨号前拒绝：

1. **传输根约束**：canonical 化后的本地路径必须落在允许根内。操作者通过
   `mcp/settings/set` 配置 `localTransferRoot`（绝对路径；`mcp/tools` /
   `mcp/call` 通道不可达，agent 无法自行扩根）后，允许根即该目录；未配置时
   默认允许根为**系统临时目录 + 插件数据目录**——覆盖测试夹具与暂存传输的
   常规场景，用户文档与家目录默认不可达。
2. **敏感路径黑名单**（任何模式叠加生效）：`.ssh` / `.gnupg` 等凭据库、
   shell 启动文件（`.bashrc` / `.zshrc` 等）、cron / sudoers / launchd 等
   引导执行路径一律拒绝——上传侧同样受此约束，防止把本机凭据装箱外送。

路径均先 canonical 化（symlink 与 `..` 归一由 OS 解析），配置根不可解析时
直接报错而非静默回落。

| 工具 | 说明 |
| --- | --- |
| `ssh_list_connections` | 列出已保存连接的元数据（id / name / host / port / username / authentication / readOnly），参数无；**仅元数据，任何密钥只出布尔标志位，绝不出值**。数据源为 DBX 应用本地桥（`source: "dbx-app-bridge"`）；桥不可用或应用版本过旧时降级为"仅本会话注册表"（`source: "session-registry"`）并附 `note` 字段说明（详见「方式二」的「connectionId 从哪来」） |
| `ssh_exec` / `ssh_exec_sudo` | 非交互远程命令；sudo 版注入密码并自动应答 2FA/TOTP。TOTP 支持多密钥（换行/分号分隔）：跨调用自动轮换，优先未过期且未使用过的验证码，重放窗口内已提交的码不再注入。两者均受危险命令确认门约束（见下节），只读连接上 `ssh_exec` 仅放行白名单巡检命令，配置了连接 sudo 白名单时特权命令还须命中白名单条目（见下节）。两者均支持可选 `runInTerminal`（见「AI 终端同步执行」）；stdio 模式传 `true` 且带 `connectionId` 时自动转发到运行中的 DBX app（未运行则唤起），在 app 的可见终端里执行。**超过 ~10 秒的命令请改用 `ssh_run_bg`**（宿主等待上限与防重复执行见「长任务与断线恢复」） |
| `ssh_run_bg` | 把长命令以 nohup 方式脱离会话启动，立即返回 `taskId`/`pid`/`logPath`；输出落在服务器 `/tmp/.dbx-ssh-tasks/<taskId>.log`，断线、超时、换会话均不丢。与 `ssh_exec` 同受危险命令确认门与只读写门约束 |
| `ssh_multi_exec` | 一条命令在多个**已保存连接**上聚合执行并逐目标回结果（隐藏通道语义，不经可见终端/agentTerminalMode）。`targets`：1–10 个连接引用（connectionId/connectionName），保序去重，任一未解析整体拒绝；`mode` parallel（默认，并发）/ sequential（顺序）；`stopOnError` 仅 sequential 生效（首败即停）；`confirmDestructive` 一次覆盖全部目标的灾难门；**不提供 sudo**（提权走单目标 `ssh_exec_sudo`）。逐目标独立过只读白名单门（连接只读时仅放行巡检命令）。stdio 独立模式无注册表，targets 解析即报引导 |
| `ssh_terminal_input` | 向连接的**存活 DBX 终端**注入原始输入（交互应答 / Ctrl+C / 方向键语义；终端必须已打开）。`\n`/`\r\n` 折叠为 Enter，NUL 剥离，8 KiB 截断；`appendNewline` 默认 false（交互应答自带 `\r`，要执行键入命令置 true）。**输出不收集**——终端本身可见，要收集输出用 `ssh_exec{runInTerminal:true}`。门禁：只读连接仅放行纯控制序列；灾难行需 `confirmDestructive: true`（只读上一律拒绝）；sudo 行受连接 sudo 白名单约束。stdio 模式无工作台 PTY，调用报引导错误 |
| `ssh_task_status` | 轮询 `ssh_run_bg` 任务：`state`（running/done/missing）、完成后的 `exitCode`、pid 存活状态与输出尾部（`tailBytes`，200–16000）。通过服务器侧日志文件查询，天然跨连接/跨会话 |
| `ssh_metrics` | CPU/内存/负载/磁盘/运行时长（只读命令）。可选 `sections` 投影：只返回点名的顶层段（`hostname`/`kernel`/`uptimeSeconds`/`cpu`/`memory`/`disks`/`network`/`processes`/`topMemory`/`osId`/`osPretty`），接受单名或数组；未知段名在拨号前 fail-fast 并列出合法段，空数组拒绝（省略参数即全量）。用于压缩大响应的 token 占用 |
| `ssh_test_connection` | 验证连通性与认证（含跳板链），返回延迟；支持全部连接寻址（`connectionId` / `connectionName` / 唯一 endpoint），保存连接经桥或注册表解析凭据，不解析成功时报自愈引导（启动 DBX app → `ssh_list_connections` → 内联凭据） |
| `ssh_list_known_hosts` / `ssh_remove_known_host` | 管理插件 known_hosts（不改系统 `~/.ssh/known_hosts`） |
| `ssh_close` | 关闭缓存的连接（方式二按连接键；方式一由 sidecar 生命周期管理） |
| `sftp_list_dir` / `sftp_stat` / `sftp_exists` / `sftp_pwd` | 浏览、检查远端路径与登录家目录；**懒建立连接**：无需先 `ssh_exec` 预热，首次调用即按寻址解析并拨号。文件名编码跟随连接级偏好（连接覆盖 > 全局 `sftp_name_encoding` > auto，见 PROTOCOL「扩展文件操作」M17 节）：latin-1 连接上 `sftp_list_dir` 返回的 `name`/`path` 为显示形式（与工作台一致），把返回的 `path` 原样回传给 `sftp_mkdir`/`sftp_remove`/`sftp_rename` 即落回同一组服务器字节 |
| `sftp_read_file` / `sftp_write_file` | 读写远端文件（文本或 base64，支持 offset 分页） |
| `sftp_upload` / `sftp_download` | 本地 ↔ 远端单文件传输（受 `maxUploadBytes` / `maxDownloadBytes` 限制；本地路径校验先于拨号，校验拒绝不清连接池）。本地路径受传输根约束：必须落在 `localTransferRoot`（未配置时为系统临时目录 + 插件数据目录）之内，且任何模式下都拒绝敏感路径（凭据库、shell 启动文件等，见下文「本地传输路径约束」） |
| `sftp_mkdir` / `sftp_remove` / `sftp_rename` / `sftp_chmod` | 目录与文件管理。latin-1 连接上前三者按显示路径还原服务器字节走裸包操作（非 UTF-8 文件名保真，回退策略同工作台）；`sftp_chmod` 的 `mode` 兼容多种写法：字符串 `"0644"`/`"0o644"` 按八进制数字读；数字全部由 0-7 组成时也按八进制读（`644` → `0644`），其余数字按原始权限位读（`384` = `0600`） |
| `sftp_disk_usage` | 路径所在挂载的磁盘用量 |
| `sftp_copy` / `sftp_move` | 服务器内复制 / 剪切（`from` 单值或数组 → `toDir`，逐项返回成败） |
| `ssh_alert_triage` | 告警分诊（**无连接参数、从不执行**）：异构告警 JSON（任意 schema）或纯文本 → 结构化 + 双语关键词分类（`cpu/memory/disk/inode/network/oom/service/generic`）+ 只读诊断命令清单（每条带 `purposeKey`；playbook 全部命中只读命令白名单，只读连接上可直接执行）。执行由调用方经 `ssh_exec` 等门禁完成 |

**连接寻址（保存连接优先，内联凭据兜底）**：上表除 `ssh_list_connections`、known_hosts 管理与本地工具外的连接类工具，都可用 `connectionId` 精确定位；也可用 `connectionName`，重名时补充 `host` / `port` / `username` 做唯一筛选。若不传 id/name，提供完整 endpoint（`host` + `username`，`port` 默认 22）也会唯一复用已注册连接，因此不需要重复传密码。候选为零时才回落内联凭据/stdio bridge 兜底；候选超过一个时拒绝并列出候选 id，避免静默连错主机或账户。`connectionId` 与其它 selector 同时出现但不一致也会拒绝。

**工具 annotations（MCP 规范 Tool annotations）**：`tools/list` 与 `mcp/tools`（DBX MCP 桥共用同一份定义）为全部 31 个工具附加 `annotations` 元数据——`title`（客户端工具选择器的人读名）、`readOnlyHint`（可证明只读的巡检/读取类工具为 true）、`destructiveHint`（exec 家族与 remove/move/overwrite/删除类为 true；mkdir/rename/chmod/profile save/close 等变更但非破坏类为 false）、`idempotentHint`、`openWorldHint`（`ssh_alert_triage` 全离线为 false，其余默认 true）。hints 仅是建议信号，供 MCP 客户端做只读预放行与破坏性确认分级；服务端安全门（mcp_safety 白名单、confirm 门、只读连接门）始终是最终裁决，hints 分类与内部门禁分类保持一致。宿主侧两条桥路径——dbx-mcp `LocalBackend::list_plugin_tools` 与桌面 `mcp_bridge.rs` ——对工具定义响应均为 serde_json Value 纯透传，annotations 原样到达 `dbx_list_plugin_tools` 客户端。

### LLM 输入容错

针对"调用方是 LLM"这一现实，参数解析层做了如下宽容与 fail-fast（均在任何网络 I/O 之前）：

- **数字写成字符串可解析**：`port` / `timeoutSecs` / `tailBytes` / `maxBytes` / `offset` / `connectTimeoutSecs` 接受数字或数字字符串（`"port": "2222"`），不再静默回落默认值；非数字字符串报 `{key} must be an integer, got '...'`。
- **布尔写成字符串可解析**：`confirmDestructive` / `overwrite` / `recursive` / `base64` / `appendNewline` / `stopOnError` / `runInTerminal` / `quickSudo` 接受 `true`/`false`（不区分大小写）及 `"1"/"0"/"yes"/"no"/"on"/"off"` 变体；其他值报 `{key} must be a boolean`。
- **端口 fail-fast**：`port` 出现但为 0、越界（>65535）或非数字时立即报 `port must be between 1 and 65535` / `port must be an integer`，绝不静默按默认 22 端口拨打错误主机。
- **未知工具名可行动**：调用未注册工具名报 `Unknown tool: '<名字>'`，分隔符/大小写变体（`sftp-listdir`、`SSH_EXEC`）附 `Did you mean '...'` 建议，所有报错都指向 `tools/list`。
- **`sftp_exists` 只把 `NoSuchFile` 判为不存在**：权限拒绝等真实错误按错误返回，不再误报 `exists: false`。
- **`ssh_close` 需要显式连接引用**：无任何 selector 时报指引错误，而不是对无意义的 `mcp-@:22` 池键报 "no cached connection"。
- **缺参一次枚举全部缺失项**：`ssh_multi_exec`（`targets`/`command`）与
  `sftp_upload` / `sftp_download`（`localPath`/`remotePath`）在多个必填参数
  同时缺失时单条报错全部点名（`Missing required parameters: a, b`，按 schema
  required 顺序），调用方一轮即可补齐；缺一个时只点名那一个。出现但类型错误
  的参数不混入枚举，仍按参数点名报
  `Missing or invalid parameter: <key> (expected a non-empty string)`。
- 参数类型错误（必填字段传了数字/空串）统一报 `Missing or invalid parameter: <key> (expected a non-empty string)`。

## 生产环境误操作防范

MCP 调用方是 LLM，误操作的代价与人在终端敲错相同——因此工具调用在执行前过
四层安全门（全部在任何网络 I/O 之前，实现见 `backend/src/mcp_safety.rs`）：

1. **只读连接写门**：DBX 连接勾选了"只读"后，写类工具（`ssh_exec_sudo`、
   `ssh_run_bg` 与全部 sftp 写操作）直接拒绝，与工作台 `ensure_writable` 同源。
   只读判定按连接身份：有 `connectionId` 时查注册表；无 `connectionId` 的内联
   凭据拨打按 `host + port + username` 与已注册只读连接比对，同一主机换个方式
   重拨不绕过门禁。
2. **只读命令白名单**：只读连接上的 `ssh_exec` 只放行**可证明只读**的巡检命令
   （`ls` / `cat` / `df` / `ps` / `systemctl status` / `journalctl` / `docker ps`
   / `git log` 等，含管道组合；重定向、命令替换、`sudo`、白名单外的动词一律
   拒绝）。白名单而非黑名单：识别不了 = 不放行。若干"形似只读、实可变更"的
   形态按 Unknown 处理：`sort -o`（输出落盘）、`find -fprint/-fprintf/-fls`
   （结果写文件）、`ip` 深层变更子命令（`route flush`、`link set`、`addr add`）、
   git 变更形态（`branch <名>`、`branch -D`、`tag <名>`、`tag -d`、`remote add`、
   `reflog delete`）、`dmesg -c/-C/-n`、`history -c/-w` 等。
3. **敏感路径拒绝清单**（只读连接）：命令参数或 SFTP 读工具（`sftp_list_dir`
   / `sftp_read_file` / `sftp_stat` / `sftp_exists` / `sftp_download` /
   `ssh_task_status`）的路径命中凭据/私钥位置即拒绝——`~/.ssh`、`.gnupg`、
   `.aws`、`.kube` 目录，`id_rsa` 等 `id_*` / `ssh_host_*_key` 私钥、
   `*.pem/*.key/*.p12/*.pfx`、`/etc/shadow`、`/etc/sudoers`、`.env`、
   `.netrc`、`.git-credentials`、`.pgpass`、`my.cnf` 及各类 shell history。
   针对的是"LLM 被注入后凭只读连接偷凭据"这一现实威胁；普通连接不设限
   （操作员已授予全权）。纵深防御而非穷举——白名单外动词本来就进不来。
4. **危险命令确认**：任何连接（含非只读）上，命中已知灾难模式的命令要求显式
   `confirmDestructive: true` 才执行；只读连接上直接拒绝、确认位也无法覆盖。
   覆盖的模式：`rm -rf` 深层系统根（`/`、`/etc`、`/usr` 等 ≤2 层路径；`/tmp`、
   `/var/tmp` 下的常规清理不拦）、`mkfs`/`fdisk`/`wipefs` 等磁盘格式化、
   `dd of=/dev/…` 裸设备写入、`> /dev/sdX` 重定向、`shutdown`/`reboot`/`init 0/6`、
   fork 炸弹、`chmod/chown -R` 系统根、`/etc/passwd|shadow|sudoers|fstab` 与
   `/boot/` 覆盖或删除、`docker prune`、`find -delete`、`kill -9 -1`、SQL
   `DROP DATABASE/TABLE`。误判方向刻意保守：拦错只是多要一次确认，放错才是事故。
   灾难判定对常见绕过形态保持命中——`sudo` 前缀剥旗标后检查内层
   （`sudo rm -rf /`、`sudo -u root rm -rf /etc`、`sudo -- mkfs …`）、
   `sh/bash/zsh -c` 脚本文本递归评估（`sh -c 'rm -rf /'`）、`$(…)`/反引号
   子命令载荷扫描（`echo $(rm -rf /)`、嵌套替换）——三者只做
   Unknown→Destructive 的**单向收紧**，绝不反向把包装命令升级为只读白名单
   （`sh -c 'df -h'` 仍是 Unknown、只读连接照拒）。敏感路径匹配统一走归一化
   形态：`//etc//shadow`、`/etc/./shadow`、相对路径 `./etc/shadow` 与系统目录
   cwd 下的裸文件名（`cat shadow`）不再绕过；`%2e%2e` 等 URL 编码**刻意不解码**
   （shell 与 SFTP 都不解码百分号，字面文件名不构成穿越）。`sftp_download`
   本地落点黑名单同步归一化（`/etc//cron.d/x`、`/etc/./profile` 不可绕过）。

**进程级只读开关**：以 `DBX_SSH_MCP_READ_ONLY=1` 启动（对 stdio 独立模式即
`DBX_SSH_MCP_READ_ONLY=1 dbx-plugin-ssh --mcp`）后，整个进程强制走只读门——
给生产环境开一个"只能看不能改"的 MCP 入口，操作员级开关、工具无法自行关闭。

**本地落点防护**（任何连接生效，保护的是操作员本机而非远端）：`sftp_download`
拒绝把远端内容写到 shell/systemd/cron/launchd 引导路径——`~/.ssh`、`~/.gnupg`、
`.bashrc`/`.zshrc`/`.profile` 等启动文件、`authorized_keys`、`/etc/cron*`、
`/var/spool/cron`、`/etc/systemd/system`、`/Library/Launch*` 等，防止远端文件
落地即本地代码执行。

**每连接 sudo 白名单（sudoers 式）**：连接表单 `sudo 命令白名单`
（`external_config.sudo_whitelist`）按 sudoers 思路为特权命令设白名单，每行
一条（单行输入可用 `;` 分隔，`#` 注释）。匹配语义比真实 sudoers 更严：
令牌精确匹配、`*` 匹配一个参数、结尾 `*` 匹配剩余（须至少一个，如
`systemctl restart *`）；**不写通配 = 只放行这条精确命令**（反转 sudoers
"不写参数 = 任意参数"的危险默认）；`sudo` 前缀自动剥离，但 `sudo` 旗标
（`-u` 等 run-as）不建模、永不匹配。白名单非空时，`ssh_exec_sudo`、
`ssh_exec`/`ssh_run_bg` 里的内联 `sudo …`（防 NOPASSWD/时间戳缓存绕过）与
工作台 exec 栏的 sudo 执行都要求命中条目，未命中即拒绝并回显允许模式
（`sudo -l` 风格，LLM 可自我纠正）；空 = 门关闭。结构化
`sudo_fs` 操作（工作台 sudo 文件面板）是用户主动 UI 动作，不在门内。
内联凭据重拨同一主机时按端点身份继承该主机的白名单（与只读门同源）。

分类器不做 shell 完整解析（引号内 `;` 仍会切分、`$(...)` 与重定向按 Unknown
处理；但替换/包装内的灾难载荷会按上文包装形态规则升级为 Destructive），所有偏差
方向都是"更严"：最坏情况是把可放行的命令降级拒绝，不会放行更危险的命令。
新增只读动词/危险模式/敏感路径请同步 `mcp_safety.rs` 的表与
单测，sudo 白名单语义见 `sudo_allowlist.rs`。

**门序与组合不变量**：call_tool 门序为
未知工具/端口早校验 → connectionScope（fail-closed）→ 只读写门 → 敏感
路径 → sudo 白名单 → 灾难 `confirmDestructive` →（confirm 权限档）→ 桥转发
→ 执行。组合不放大权限：白名单命中的灾难命令仍要确认；确认位无法覆盖
只读连接与进程级只读开关；只读门先于白名单（写工具救不回）；scope 非空
时内联拨打在任何灾难判定之前整体拒绝；确认位也不解除 sudo 白名单
（terminal_input 组合同序）。

## 权限档（execPermissionMode / connectionScope）

操作者级两个开关，`mcp/settings/set` 持久化（与尺寸限制同文件
`mcp-settings.json`，**先全量验证再合并写盘**——拒绝的更新不动文件），
stdio 独立模式用 env 覆盖（存在即覆盖持久化值）：

- **`execPermissionMode`**：`autonomous`（默认）| `confirm`。confirm 下写类
  工具 ∪ exec 族（`ssh_exec` / `ssh_exec_sudo` / `ssh_run_bg` /
  `ssh_multi_exec` / `ssh_terminal_input`；读类工具与 `ssh_close` 不拦）在
  全部既有门通过后、执行前再发一次人工审批——`ssh/agent/prompt`
  （kind `mcp-confirm`、source `mcp`，120s 超时即拒绝），审批弹窗可编辑命令，
  确认文本替换原文执行。**fail-closed**：stdio 独立会话没有审批通道，gated
  调用立即报错引导（切回 autonomous 或在工作台会话内运行），绝不挂 120s。
  env：`DBX_SSH_MCP_PERMISSION_MODE=autonomous|confirm`。
- **`connectionScope`**：≤64 条连接允许清单，条目匹配 = 连接 id 精确 / 连接名
  精确 / host（ASCII 大小写不敏感）。非空时：连接类调用解析出的目标越界即
  整体拒绝（`ssh_multi_exec` 任一 target 越界整体拒绝）；**内联凭据拨打
  （host+username）整体拒绝**——端点选择器没有 registry 身份，fail-closed，
  不能借内联参数绕开作用域；`ssh_list_connections` 只回作用域内条目（bridge
  与 registry 两来源都过滤）。known_hosts 管理、Quick Sudo 档案、告警分诊等
  本地工具不受作用域限制。env：`DBX_SSH_MCP_CONNECTION_SCOPE`=逗号分隔条目
  （显式空列表=合法覆盖，拒绝一切）。

单测覆盖设置往返/merge 写盘、env 解析、confirm 工具集与作用域工具集、
scope 匹配规则、list 过滤；smoke_mcp 以两个注入 env 的 stdio 进程实跑
confirm fail-closed 与 scope fail-closed（含 list 在作用域下可用）。

## 长任务与断线恢复

三层机制协同，针对"长命令 + 不稳定网络 + MCP 宿主等待上限"的组合场景：

1. **stdio 请求并发**：sidecar 的 JSON-RPC 主循环逐请求 `tokio::spawn`，一个
   慢 `ssh_exec` 不会阻塞 `ping` / `tools/list` / 其他连接的调用。stdin 关闭后
   在途请求 drain 至多 300 秒再退出。响应可能乱序返回，JSON-RPC 以 id 关联，
   语义不变。
2. **后台任务工具**：`ssh_run_bg` + `ssh_task_status` 把"nohup + 日志文件 +
   轮询"产品化。日志与 pid 文件存放在服务器 `/tmp/.dbx-ssh-tasks/`，是任务的
   持久记录——宿主放弃等待、连接反复断开、sidecar 重启、换一个会话，都能重新
   连上查询进度与最终退出码。`run_to_completion` 超时错误文本会提示"命令可能
   仍在远程运行"，引导调用方先查证再重试，避免双实例互等包管理器锁。
3. **pre-exec 断线自动重试**：连接池条目在调用失败时照旧丢弃（下次调用重连）；
   若失败发生在**命令启动之前**（死连接上打开 exec 通道被拒等，`is_pre_exec_
   transport_error` 判定），同一次调用内换新连接自动重试一次——命令确定没跑过，
   重试不可能双执行；命令已启动后的传输错误保持终态，由调用方决定是否重跑。
   keepalive（30 秒间隔，3 次容忍）用于让 NAT/防火墙不掐空闲连接、断线尽早暴露。

## AI 终端同步执行（runInTerminal）

`ssh_exec` / `ssh_exec_sudo` 均接受可选 `runInTerminal: boolean`，把命令路由到
**用户当前打开的终端 UI**（工作台 PTY 交互 shell）执行——命令回显在终端、输出
实时可见、人可随时打字或 Ctrl+C 介入，AI 拿到录制捕获的输出文本
（`{output, exitCode: null, mode: "terminal", incomplete, interrupted}`）。

- **stdio 方式亦可转发**：stdio 模式传 `runInTerminal: true` 时，sidecar 通过 DBX
  app 的本地 TCP 桥（`<app-data>/mcp-bridge-port`，可用 `DBX_APP_DATA_DIR` 重定向；
  app 未运行会尝试 `open -a DBX.app` 唤起，可用 `DBX_APP_LAUNCH_CMD` 自定义）把调用
  转发到 **app 自己的插件 sidecar**——与工作台同一进程，命令出现在 app 终端里。
  转发要求 `connectionId` 指向 DBX 已保存的连接（凭据由 app 侧解析，不经 stdio 调用方）。
  `connectionId` 已随全部连接类工具的 inputSchema 声明，严格校验的 stdio 客户端
  （如 ZCode）不会以「未声明参数」拒绝该字段；
  连接 id 可用 `ssh_list_connections` 列出（见「connectionId 从哪来」；DBX 连接存储
  `connections` 表 `id` 列、连接名在 `config_json.name` 为最后兜底）。
- 该连接没有打开的终端会话时报错引导（"open the SSH workbench terminal first"），
  不回退到隐藏执行——可见才执行是该模式的承诺；runInTerminal 相关两条报错
  （未注册连接 / 无终端会话）末尾均追加提示"可用 `ssh_list_connections` 列出
  已保存连接 id"。
- 连接级默认行为由工作台设置 `agentTerminalMode` 决定（`off` 默认不路由 /
  `auto` 分级审批 / `strict` 每条必审，协议见 PROTOCOL「AI 终端同步执行」）；
  `runInTerminal` 显式值优先于连接模式。**终端工具栏快速开关**：工作台按钮行
  的「终端 MCP 模式」弹出层（`Bot` 图标，非 `off` 高亮）可就地切换连接级模式——
  开启后 MCP exec 命令（即使不传 `runInTerminal`）都经该终端可见执行（审计/学习），
  关闭则全部走静默隐藏通道。**模式持久化**：`agentTerminalMode` 落盘到
  插件数据目录 `agent-modes.json`（按 connectionId 记录，off 移除条目），
  app/sidecar 重启后保持。
- **agent 可自主决定**：`runInTerminal` 是 agent 决策参数——工具 schema 引导 AI 在
  任务需要可见性、人工监督或交互性时主动传 `true`，不必等用户开模式。`off` 连接上
  显式 `runInTerminal: true` 的提权命令（sudo/灾难命中）不直接死路拒绝，而是触发
  工作台人工审批弹窗（超时即拒绝）；隐式路由（未传参）在 `off` 下维持隐藏通道不变。
- **静默调用不打扰**：宿主桥转发前按「工具是否为 ssh_exec 族 + 显式 `runInTerminal`
  + 连接模式探针（`ssh/agent/mode/get`，任何失败回落 `off`）」判定是否需要打开
  工作台标签；静默调用（隐藏通道）不自动开标签，事件监听也不抢 macOS 窗口
  焦点——标签在后台就位、命令写入终端缓冲，用户回到 DBX 时可完整回看。
- 审批：`auto` 下 elevated（sudo / 灾难命中）与 `strict` 下全部命令会触发工作台
  弹窗（完整命令原文 + 风险徽标 + 倒计时，默认 120s 超时即拒绝）；AI 侧表现为
  明确的 denied/timed out 错误。`off` 连接上 agent 显式 `runInTerminal: true` 的
  提权命令走同一审批弹窗（按「agent 显式申请 + 人工批准」放行）。
- **审批记忆**：弹窗提供「记住此命令」勾选（resolve 请求 `remember: true`），
  批准的命令写入连接级免审批清单（`agent-approved-commands.json`，匹配复用 sudo
  白名单 token 语义，设置弹窗可查看/删除/手工泛化通配）；后续命中清单的命令在
  任何模式下免审批直接执行。破坏性命令双重锁定：拒绝入库且命中重检无效——灾难
  `confirmDestructive` 门永不绕过。
- sudo + 终端路径不注入密码：`sudo …` 原文进用户 shell，密码/TOTP 由终端内
  auto-sudo 自动应答（已配置时）或人工输入。

既有只读白名单（含敏感路径拒绝清单）、灾难 `confirmDestructive`、进程级只读
开关先于路由判定生效，`runInTerminal` 不放宽任何安全门。

## 告警 → 排查（组合用法）

监控告警（Prometheus / Grafana / Zabbix / Sentry webhook 文本等）直接粘给
`ssh_alert_triage`：工具把任意 schema 的告警体标准化（解析失败整包当 message），
按双语关键词分类（cpu / memory / disk / inode / network / oom / service / generic），
返回一组**带 purposeKey 的只读诊断命令**（uptime / free / df / ps 排序 /
journalctl -k / systemctl status 等静态 playbook，全部命中只读命令白名单——
只读连接上可直接执行，普通连接不受限）。典型组合：

1. `ssh_alert_triage {payload: <告警原文>}` → 拿到 `normalized` + `category` +
   `suggestions`；
2. 依次 `ssh_exec` 执行建议命令（门禁照常；超过 ~10s 的改用 `ssh_run_bg`）；
3. 结合输出做根因判断；建议命令之外的排查动作沿用既有门禁语义。

该工具只做结构化与清单，不做 LLM 分析；工作台侧等价入口为工具栏「告警排查」
（Siren 图标）弹窗：粘贴 → 分析 → 逐条发送到当前终端 / 全部复制。

## MCP 工具命名与语义

工具命名与语义沿用 `ssh_exec` / `ssh_exec_sudo` / `sftp_*` 工具族约定。本插件在 DBX 桥模式下凭据与审批归宿主（DBX 连接存储 + MCP scope），独立模式用内联凭据 + TOFU，并额外提供 `ssh_metrics`、`sftp_chmod`、`sftp_disk_usage` 与 known_hosts 管理。
