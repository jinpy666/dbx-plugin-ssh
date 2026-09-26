# SSH/SFTP 插件协议

## 生命周期与状态隔离

Sidecar 是插件级共享进程，所有状态都必须以 `connectionId`、`sessionId` 或 `taskId` 为键。`connection/connect` 只接收并缓存宿主注入的连接配置；`connection/disconnect` 会关闭该连接下的终端、SFTP 子系统和传输任务。工作台不会接收密码字段。

Telnet/VNC 的 saved connection 生命周期也走同一入口，但不会进入 SSH 连接池：`connection/connect` 对 `external_config.protocol: "telnet"|"vnc"` 返回成功，`connection/test` 对宿主给出的 `runtime.host:runtime.port` 做 10 秒 TCP 可达性探测，`connection/disconnect` 按 `connection.id` 清理其 Telnet/VNC 会话。逻辑端点始终来自 `connection.host:connection.port`，用于界面显示和身份；实际 TCP 拨号只使用 `runtime.host:runtime.port`（缺省时回退逻辑端点）。

工作台的“新建会话”保持独立 transport 语义，会重新完成 SSH 认证（堡垒机可再次要求 MFA）；“复制会话（免再次验证）”则向 `ssh/session/open` 传 `reuseAuthenticatedTransport: true` 和当前 `reuseAuthenticatedSessionId`，在用户所点窗口当前存活且已认证的 transport 上新开独立 PTY channel。复制会话拥有独立 `sessionId`、`workbenchId`、回放缓冲和终端任务，不复制或缓存 OTP。打开复制 channel 前会先预占共享 transport 引用，因此源会话在 channel/PTY/shell 建立期间关闭也不会提前释放跳板链；关闭任一复制会话只关闭自己的 channel，最后一个共享引用释放后才断开跳板链。每个复制会话都会额外占用一个 SSH channel，数量受服务端 `MaxSessions` 限制（OpenSSH 常见默认值为 10）；超过限制时 `open` 返回 channel 建立失败。

显式传入 `reuseAuthenticatedSessionId` 时严格 fail closed：指定来源不存在、已关闭或连接不匹配都会返回 `No live authenticated SSH connection`。前端收到该错误后只降级一次，以普通“新建会话”语义重新登录，允许堡垒机再次要求 MFA；该错误同时属于永久重试错误，不进入对同一失效 sessionId 的退避重试。只传 `reuseAuthenticatedTransport: true` 的旧调用方保留兼容行为：后端会从同一连接中确定性选取最早创建的存活会话，因此 transport 来源不保证对应调用方当前显示的窗口。

复制会话继承来源会话在连接时解析出的内存态 sudo 编排快照（`SudoAuth`），包括 `password_command` 当时的解析结果；复制时不会再次运行 `password_command`。会话建立后的设置同步仍按各会话现有更新机制独立生效。

`ssh/session/open` 还可接收可选 `requestedSessionId`。前端可在调用长连接 RPC 前预分配该 id，使 `ssh/terminal/out/{sessionId}` 的首帧无需等待 RPC 返回即可进入终端；sidecar 会在注册表冲突或旧调用方缺失该字段时安全回退到新的 UUID，返回的 `sessionId` 始终是权威值。旧前端/sidecar 继续使用现有 replay 语义。交互 PTY 会先建立，远端 shell 能力探测只在启用目录跟踪时懒执行，不阻塞首个 Prompt。

第一阶段不声明 `test` 能力。真实 SSH 握手在 `ssh/session/open` 发起，主机密钥确认完成前不会调用密码认证。
`connection/test`（宿主发起，带 RPC 截止 = 宿主有效连接超时）的拨号预算与宿主截止对齐并留 1s 余量：`connect_timeout_secs` 显式时预算 = 该值 − 1s；缺省时宿主按 dbx-core `default_connect_timeout_secs()` 回退 10s（`crates/dbx-core/src/models/connection.rs:501`，stored 0 → 宿主 10s，与本插件 manifest 默认 30s 分叉），预算取 9s，超时错误附带「高级选项调大 SSH timeout」的指引。工作台 `ssh/session/open` 由插件前端发起、无宿主截止，仍按连接配置的完整超时拨号。

## RPC

| 方法 | 作用 |
| --- | --- |
| `ssh/session/open`、`ssh/session/close` | 创建、关闭 PTY 会话（`open` 可选 `requestedSessionId`、`reuseAuthenticatedTransport` + `reuseAuthenticatedSessionId`，`requestedSessionId` 供前端在长 RPC 返回前按预分配 id 接收终端首帧，sidecar 在注册表冲突或缺省时回退服务端 UUID；复用指定同连接存活会话的认证 transport 并新开独立 channel；显式 ID 不可用时 fail closed，只有布尔参数时兼容选择同连接最早存活会话；复用会继承来源会话已解析的 sudo 编排快照；连接 `remote_command` 非空时 exec 该命令替代 shell，`set_env` 随会话注入；连接配置 `triggers` 时挂载自动交互触发器引擎，命中发 `ssh/trigger` 事件，见「自动交互触发器（Expect）与外部密码管理器」节；`startup_commands` 偏好启用的连接在 shell 建立后按序自动键入预置命令并发 `ssh/startup` 事件，见「启动命令（Login scripts 对标）」节） |
| `ssh/terminal/resize` | 调整 PTY 行列 |
| `ssh/terminal/replay` | 从指定序号补发终端输出 |
| `ssh/host-key/resolve` | 处理工作台内的主机密钥确认 |
| `ssh/exec` | 在会话连接上执行远程命令，可选 Quick Sudo 提权 |
| `ssh/exec/cancel` | 中止进行中的远程命令（按 `execId`） |
| `ssh/forward/interfaces` | 本机网卡地址探测（供端口映射面板的监听地址选择器）：无参 → `{interfaces: [{name, addr, isLoopback}]}`，回环优先、v4 先于 v6、按 IP 去重；探测失败返回空数组（选择器隐藏，手输不受影响）。`if-addrs`（getifaddrs）实现，无会话依赖 |
| `ssh/forward/list`、`ssh/forward/start`、`ssh/forward/stop` | 用户级端口映射（ssh(1) -L/-R，见「端口映射」节）：`list` 按 `{connectionId?}`/`{sessionId?}` 过滤返回 `{forwards: [row]}`；`start` `{sessionId, kind: "local"\|"remote", listenHost?, listenPort, targetHost, targetPort}`（`listenHost` 缺省 127.0.0.1；`listenPort: 0` 由本机/服务端挑选，`boundPort` 回报实际端口）→ `{forward: row}`；`stop` `{id}` → `{success, forward}`，未知 id 报错。row 字段 camelCase：`id/sessionId/connectionId/kind/listenHost/listenPort/boundPort/targetHost/targetPort/state("starting"\|"active"\|"stopped"\|"error")/error?/connectionsTotal/connectionsActive/bytesUp/bytesDown`。状态迁移发 `ssh/forward/state`（notify）`{id, sessionId, connectionId, state, error?}` |
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
| `sftp/chmod` | 修改远端路径权限位（八进制）；`sftp_name_encoding` 为 `latin-1` 时路径整条按 wire 还原走裸包 SETSTAT（M17） |
| `sftp/diskUsage` | 路径所在挂载的磁盘用量 |
| `sftp/home`、`sftp/list`、`sftp/read` | 浏览、预览远端文件（`sftp/list` 支持可选 `includeOwner` 附加属主/属组；`sftp/read` 支持可选 `offset` 分片续读，见下文） |
| `sftp/createDirectory`、`sftp/rename`、`sftp/delete`、`sftp/exists`、`sftp/rename-unique`、`sftp/touch`、`sftp/write`、`sftp/symlink-create/read/update`、`sftp/upload/start/finish`、`sftp/upload-local`、`watch/upload` | SFTP 写操作/预检（`sftp_name_encoding` 为 `latin-1` 时走裸包客户端字节保真，路径来源分工见 `sftp/list` 节 M15-B/M16 段） |
| `sftp/upload/start`、`finish` | 上传事务生命周期（`resumeTaskId` 断点续传；`finish` 校验后交后台任务推送并立即返回，见「上传两阶段计数与收尾语义」） |
| `watch/start`、`watch/stop`、`watch/stop-all`、`watch/upload` | 外部编辑器回写 watcher（仅桌面端，见「外部编辑器 watcher（watch/*）」节）：`start` 对 `remote-edit/` 下载目录内的本机文件登记监听并返回 `{watchId}`，内容确认变化后发 `watch/file-modified` 事件；`upload` 把监听文件当前字节按 `sftp/write` 同款原子提交推回远端（latin-1 按所属连接编码走裸包字节保真，M21） |
| `sftp/download/start`、`next`、`finish` | 下载事务生命周期（`offset` 断点续传，见下文；桌面端可选 `downloadDir` 指定本机绝对保存目录） |
| `sftp/download/tree/start` | 递归目录下载启动：远端 `read_dir` 走树扫描（有界），本地镜像目录布局后复用 `sftp/download/next`/`finish`/`sftp/transfer/cancel` 分块管线（见「递归目录下载」节） |
| `sftp/stat`、`sftp/exists`、`sftp/touch`、`sftp/write` | 扩展文件操作：元信息单查、存在性检查、空文件创建、小文件直写；latin-1 下 `sftp/stat` 整条 wire 还原走裸包 LSTAT，`sftp/exists` 按 `form` 参数分工还原（缺省「wire 前缀 + 显示末段」、`form: "wire"` 整条），均走裸包 LSTAT（M17，见 `sftp/exists` 节） |
| `sftp/archive`、`sftp/extract` | 远端 tar.gz 打包与解压 |
| `sftp/copy`、`sftp/move` | 服务器内复制 / 剪切（逐项执行，目标存在需 `overwrite`）；latin-1 下覆盖预检与同目录 move rename 快路径走裸包字节保真（M17，shell 执行层边界见 `sftp/list` 节） |
| `sftp/bookmarks/list`、`sftp/bookmarks/save`、`sftp/bookmarks/delete` | SFTP 路径书签管理（全局命名清单，插件数据目录持久化，见下文） |
| `sftp/transfer/cancel` | 取消并清理临时状态（可选 `reason` slug 落入账本，见「上传两阶段计数与收尾语义」） |
| `sftp/transfer/list`、`sftp/transfer/status` | 查询会话传输任务列表 / 单任务状态（含历史，会话维度过滤） |
| `sftp/transfer/history` | 跨重启传输历史查询（持久化 + 内存 live 合并，见下文） |
| `sftp/transfer/history/clear` | 清空已持久化及当前进程中的传输历史 |
| `sftp/transfer/resumable` | 可续传上传扫描（中断任务的 spool 前缀仍在磁盘上的清单，见下文） |
| `import/preview/start`、`finish`、`cancel` | 第三方 SSH 客户端会话导入的临时流式预览与脱敏规范化导出（不落盘，见下文） |
| `sudo/stat`、`sudo/exists`、`sudo/touch` | sudo 元信息查询与空文件创建 |
| `sudo/listDir`、`sudo/readFile`、`sudo/writeFile` | sudo 目录浏览与文件读写 |
| `sudo/mkdir`、`sudo/remove`、`sudo/removeAll`、`sudo/chmod`、`sudo/rename` | sudo 写操作 |
| `sudo/download/start`、`sudo/download/cancel` | sudo 下载（root 大文件二进制下载，M14-C DownloadSudo）：start 把源文件暂存进同目录 0600 临时件后复用 `sftp/download/next`/`finish` 分块管线与进度事件，见「sudo 下载（DownloadSudo）」节 |
| `sudo/profiles/list`、`sudo/profiles/save`、`sudo/profiles/delete` | 全局 Quick Sudo 配置管理（多套命名凭据/策略档，插件数据目录持久化，密钥永不回显） |
| `sudo/profiles/options` | 连接表单动态下拉选项（`sudo_profile` 字段的 `options_action`）：返回 `{options: [{value: id, label: name}]}`，按名称排序，永不携带密钥 |
| `connection/action` | 连接表单动作（manifest `connection-provider.actions` 声明）：`action=quick-sudo-profiles` 返回全局配置清单与本连接绑定状态的纯文本摘要（`{message, fieldValues}`） |
| `keys/discover` | 本地 SSH 私钥发现（不返回私钥内容） |
| `ssh/knownHosts/list`、`ssh/knownHosts/remove` | known_hosts 条目管理（含 `@cert-authority` / `@revoked` 标记条目） |
| `ssh/sessions/list` | 只读会话清单：sidecar 当前跟踪的活跃会话 |
| `ssh/quickCommands/list`、`ssh/quickCommands/save`、`ssh/quickCommands/delete` | 全局快速命令管理（用户自定义常用命令片段，插件数据目录持久化，所有连接/工作台共享） |
| `ssh/terminal/batchInput` | 批量发送：把同一条命令写入多个已打开会话的交互终端（PTY 键盘语义），返回逐会话发送结果 |
| `ssh/batchBar/state`（notify） | 批量发送命令条的跨工作台状态同步：工作台把 `{ source, draft, quickPickId, open }` 以通知送达 sidecar，sidecar 原样以同名事件广播给所有插件 webview，各端按 `source` 过滤自己的回声；纯转发不落存储，旧版 sidecar 未注册时调用方静默降级 |
| `local/terminal/start`、`local/terminal/resize`、`local/terminal/replay` | 本地终端：sidecar 所在机器的交互式登录 shell（工作台显式入口触发，见「本地终端」节；`start` 支持显式 `shell` 与继承用的 `cwd`） |
| `local/shells/list` | 本机可启动 shell 清单（用户登录 shell 置顶，含 `isDefault`/`isUserShell`/`injectable` 标记——最后一项表示该 shell 是否支持 integration 注入，不支持的在选择器中灰掉开关；Unix 读 `/etc/shells`+`dscl`，Windows 枚举 PATH 下的 pwsh/PowerShell/cmd/wsl），工作台 shell 选择器数据源 |
| `local/session/list`、`local/session/close` | 本地终端会话清单（webview 重载后接回）与关闭 |
| `local/preferences/get`、`local/preferences/set` | 工作台级 UI 偏好（`<plugin_data_dir>/preferences.json`，固定键白名单、原子写入，非法类型报错、非白名单键丢弃）：`downloadDir`（string，≤512 字符）、`downloadUseDefaultDir`（bool，默认 true）、`downloadConflictPolicy`（`rename`/`ask`/`overwrite`，默认 `rename`）、`startup_commands`（连接级启动命令存储，对象按 connectionId 分桶 `{ enabled: bool（默认 false）, commands: [{command, delayMs, enabled}] }`；整体非对象报错，桶/行级非法形状清洗丢弃；上限每连接 20 条、单条 4KiB、延迟 0..=30000ms 缺省 300，见「启动命令（Login scripts 对标）」节）。`transfer_concurrency`（u64，1..=10，默认 3）、`transfer_duplicate_policy`（`rename`/`ask`/`overwrite`，默认 `rename`）、`transfer_max_active`（M14-B 会话级并发传输深度，u64，1..=8，默认 3；sidecar 每次任务启动现读现用——改动即时生效，新任务按新深度启动，进行中任务按旧深度自然完成）、`sftp_compat_mode`（M14-B 老旧服务器兼容模式，bool，默认 false；开启后 SFTP 会话不做流水线并发（读写各 1 路）并把并发深度强制 1，对新建 SFTP 会话生效（重连后应用）；SFTP 探测失败时 sidecar 对该会话一次性在错误信息中附带建议开启的提示）、`sftp_name_encoding`（M14-B 文件名显示编码，`auto`/`latin-1`，默认 `auto`，语义见 `sftp/list` 节）、`sftp_name_encoding_overrides`（M16 连接级文件名编码覆盖，对象按 connectionId 分桶 `{ <connectionId>: "auto"|"latin-1" }`；整体非对象报错，桶内非法值/空 connectionId 清洗丢弃，桶数上限 512；缺省语义为「跟随全局」——桶内无本连接条目即回退全局 `sftp_name_encoding`，再缺省 `auto`；判定优先级 连接覆盖 > 全局偏好 > 缺省 auto，覆盖值非法（白名单外）同样按未覆盖回退；判定点现读现用（`sftp/list`、`sftp/rename`、`sftp/delete`、`sftp/createDirectory`、`sftp/download/tree/start`），改动对下一次调用即时生效；sessionId 无法映射到连接（已断开）时按未覆盖处理）。兼容：set 为部分合并，缺省键不变；旧 sidecar 缺少的键前端按缺省处理 |
| `serial/upload/start`、`serial/upload/data`、`serial/upload/cancel` | 串口文件上传（XMODEM/YMODEM/ZMODEM，NyaTerm 对齐）：协议状态机在 sidecar（`backend/src/serial_xmodem.rs` 纯状态机，由串口读线程喂数据/取输出），文件字节由前端 File API 分块（≤64KiB）经 `data` 送入，sidecar 不落盘；单次上传总量上限 256 MiB；进度事件 `serial/upload/progress`（`sent`/`total`，不含文件内容）；同一会话同一时刻至多一个上传（并发第二次 `start` 报错），见「串口文件上传（X/Y/ZMODEM）」节 |
| `telnet/list`、`vnc/list`、`rdp/list`、`serial/list` | 活跃非 SSH 会话清单（均含 `sessionId`、`workbenchId`、逻辑端点和创建时间；Telnet/VNC saved connection 会额外带 `connectionId`、`runtimeHost`、`runtimePort`）。工作台重建只按相同 `workbenchId` 回附，绝不按连接抢占另一标签页会话。 |
| `telnet/replay`、`serial/replay`、`vnc/replay`、`rdp/replay` | Webview 重建回附的输出恢复：Telnet/Serial 重发序号制终端帧；VNC 重发当前完整 framebuffer；RDP 重发一张有明确内存预算的完整合成 framebuffer，绝不重放不能独立恢复画面的增量 patch 序列。 |

## 会话导入：流式预览与脱敏规范化导出

`import/preview/start` 参数为 `{ kind, mainSize, userConfigSize?, masterPassword? }`：`kind` 为 `moba`、`xshell`、`windterm`、`securecrt`、`finalshell`、`electerm` 或 `termius`；主文件与仅 WindTerm 可用的 `userConfigSize` 共用 **64 MiB** 总预算。返回 `{ taskId, chunkSize }`，当前 `chunkSize` 为 256 KiB，刻意保持在 SDK 8 MiB JSON 上限以下。

文件内容不经 JSON/base64 RPC 传输。前端按 SFTP 上传同款发送二进制通道 `import/preview/<taskId>/main`；WindTerm 可选文件使用 `import/preview/<taskId>/user-config`。每帧是 `[u64 BE offset][raw bytes]`，必须连续、从 offset 0 开始，单块至多 `chunkSize`。sidecar 成功接收后发 `import/preview/ack { taskId, part, nextOffset }`；前端等待 ACK 再发下一块。协议错误会发 `import/preview/error { taskId, part, error }`，并立即清理该任务。

`import/preview/finish { taskId }` 只接受所有声明字节已到齐的任务；它在返回前移除原始文件字节和 WindTerm 主密码，返回 `{ sourceKind, sessions, totalSessions, truncated, export }`。这是一次性**临时 preview/export**：不创建连接、没有 `import/commit` 成功语义、也不持久化导入结果。所有格式（含 ZIP）使用解析前受限 accumulator，在每个 session `push` 前强制 `MAX_PREVIEW_SESSIONS=1000`，超限 fail-closed 而不是先构造巨大 `Vec` 后截断；ZIP 另受条目、单项与总解压预算限制。`sessions` 是最多 1000 行的脱敏预览（仅名称、主机、端口、用户、分组、描述、认证类别、`hasSecret` 与 `secretNote`）；`export` 是可供前端保存的规范化 JSON：`{ schemaVersion, sourceKind, sessions }`。每一行认证信息只有 `kind`、`hasSecret`、`keyPath`（路径元数据）和 `secretNote`；普通密码、私钥内容和私钥口令都不进入 `ImportedAuth` 预览模型，解密/检查仅用 `Zeroizing` 临时缓冲后立即释放；因此它们在任何响应、导出或插件私有文件中均不存在。该插件不再创建或读取 `imported-connections.json`。

`import/preview/cancel { taskId }` 幂等地丢弃未完成的内存上传；组件卸载、读取失败、ACK 超时和用户返回均应调用它。sidecar 进程退出同样释放进程内状态。导出优先使用宿主 `saveFile`，其次 `fileTransfer`；Host API 1.0 同时缺失两项时，顶层、非 sandbox 页面使用浏览器 Blob 下载。因 issue #93，sandbox iframe **不得**尝试 `<a download>`：它必须失败并提示用户升级到带 `saveFile`/`fileTransfer` 的宿主或在顶层浏览器上下文打开，不能静默返回无导出结果。

## 运行时设置

`ssh/settings/get` 返回当前编排配置（密钥仅以布尔标记呈现，绝不下发明文；传 `revealSecrets: true` 时额外回显本连接配置的 `sudoPassword` / `totpSecret` 原始串（多密钥原文），供工作台设置弹窗预填已存原值——该参数仅工作台使用，MCP 通道不暴露，缺省响应与此前完全一致；另附 `quickSudoProfileId` / `quickSudoProfileName` 报告生效的全局配置绑定（`sudo_source=global` 时含连接表单引用解析结果），未绑定为空串，`sudoSource`（`custom` / `global` / `off`，生效来源），以及 `agentTerminalMode`（`off` / `auto` / `strict`，AI 终端同步模式，见下节））；`ssh/settings/set` 另接受可选 `rememberedCommands`（字符串数组全量替换连接级免审批清单，校验规则见「审批记忆」节，破坏性行拒绝且错误信息带行号，缺省不改变）；`ssh/settings/get` 响应含 `rememberedCommands`。`ssh/settings/set` 接受 `quickSudo`、`sudoUsePty`、`sudoPassword`（空串=清除回退登录密码）、`totpSecret`、`authFlowMode`、`passwordPromptHint`、`totpPromptHint`、可选 `agentTerminalMode`（非法值报错，缺省不改变），以及可选 `quickSudoProfileId`（非空须引用存在的全局配置并持久化绑定，空串解除绑定，缺省不改变；挑选配置会将连接的 `sudo_source` 切到 `global`，解除时 `global` 回落 `custom`）。更新通过共享编排锁立即作用于该连接的**所有存活会话**——终端自动应答与命令弹窗在下一次提示时即用新值（对齐每次输出动态 resolve 的语义）；终端侧监视器随每次设置/配置更新按当前连接状态**重新挂载**：连接时未配置凭据（如密钥认证连接）或 Quick Sudo 处于关闭的会话，在运行时配置密码/TOTP 或重新打开开关后立即开始自动应答，无需重连。`sudoPassword` 等字段级覆盖是 sidecar 本地值，sidecar 重启或重开连接后恢复宿主下发的配置，而 `quickSudoProfileId` 绑定与 `agentTerminalMode` 持久化在插件数据目录、重启保留（0.4.49 起，见「AI 终端同步执行」）。工作台工具栏提供设置弹窗；宿主连接表单通过 manifest 字段提供持久化配置入口：`sudo_source`（三选一 `custom` 本连接 / `global` 全局配置 / `off` 停用；旧连接缺省时按 `quick_sudo` 布尔映射）、`sudo_profile`（仅 `global` 时显示，声明 `options_action: sudo/profiles/options` 由宿主渲染为动态下拉，无该扩展能力的宿主保留文本回退）、`sudo_password`、`sudo_use_pty`（仅 `custom` 时显示）、2FA 编排四件套 `totp_secret`、`auth_flow_mode`、`password_prompt_hint`、`totp_prompt_hint`（`global` 时隐藏——凭据来源整体由全局配置接管；`custom`/`off` 时 `auth_flow_mode` 常显以服务登录期 keyboard-interactive，`totp_secret`/`totp_prompt_hint` 仅在自动回码的两种 OTP 模式（`password_then_otp`/`password_plus_otp`）下出现，`password_prompt_hint` 与 TOTP 字段同集并紧随其后——2FA 关闭时整组折叠，不再残留孤立的密码提示词行）、超时与 keepalive、`jump_hosts`、`set_env`（会话环境变量）、`remote_command`（会话命令，两者详见「会话环境与会话命令（SetEnv / RemoteCommand）」）、`triggers`（自动交互触发器）与 `password_command` / `passphrase_command`（外部密码管理器，三者详见「自动交互触发器（Expect）与外部密码管理器」）。

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

## 端口映射（-L / -R）

用户级端口映射（对标 ssh(1) `-L`/`-R` 与 Xshell「隧道」面板；`-D` 动态转发刻意不做——宿主 dbx-core 已为数据库代拨内置动态隧道，见对标清单）。挂在当前连接的**工作台会话**上，会话关闭（`ssh/session/close`、连接断开）即整组清理：本地监听 abort、远端 `cancel-tcpip-forward` 撤销（句柄已死则跳过），注册表行随事件 `ssh/forward/state {state:"stopped"}` 下发后移除。映射为运行时状态，不落盘、不跨会话恢复。

- **local（-L）**：sidecar 在客户端机器 `listen_host:listen_port` 起 TCP 监听；每条入站连接开一条 `direct-tcpip` 通道，由服务端拨 `target_host:target_port`。双向转发走 `copy_bidirectional`，按连接累计 `bytesUp/bytesDown`。
- **remote（-R）**：sidecar 先向服务端发 `tcpip-forward` 全局请求（拒绝即 start 报错，`AllowTcpForwarding no` 的服务器在此处失败）；`listenPort: 0` 时由服务端挑选端口并以 `boundPort` 回报。服务端侧入站连接以 `forwarded-tcpip` 通道送达，sidecar 的客户端 handler 按连接维度的转发表（`(listen_host, bound_port) → target`，含归一化与通配端口回退匹配）在**客户端机器**拨目标地址并双向转发。停止时发 `cancel-tcpip-forward` 并摘除表项。
- **输入校验与冲突预检**：listen/target 主机接受 IPv4、IPv6（`[...]` 括号剥除）与主机名标签；嵌入式端口/scheme（`host:8080`、`http://…`）、`999.1.1.1` 这类伪 IP、本地映射的 `*` 通配均拒绝（空 listenHost 缺省回环）。`start` 在 bind/`tcpip-forward` 之前做监听端点冲突预检：同方向、同显式端口（0 = 自动挑选永不冲突）、主机相同或任一侧通配（`*`/`0.0.0.0`/`::`/空）即报 `Listen endpoint … is already forwarded by mapping …`；local 作用于全部连接（同一台客户机），remote 作用于同连接（同一台服务器）。工作台面板同规则预检并在表单内联提示。
- `stop` 语义：后台任务全部 abort（含已建立的转发连接），registry 立即摘除；对同一 id 重复 stop 报 `not found` 错误。已建立的映射在会话存活期间持续转发；映射生命周期 = 会话生命周期。
- 事件 `ssh/forward/state` 为状态广播（starting/active/error/stopped），工作台面板（`PortForwardDialog.vue`，自订阅该事件）据此就地刷新；list 为准、事件为加速。

## 会话环境与会话命令（SetEnv / RemoteCommand）

对标 ssh(1) `SetEnv` / `RemoteCommand` 的两个连接级会话特性（manifest 字段 `set_env` / `remote_command`，binding `config`；0.4.35 前存量为 `setEnv` / `remoteCommand` camelCase，sidecar 兼容读取两种命名；跳板链不继承，仅作用于最终会话）：

- `set_env`（textarea，默认空串）：每行一条 `KEY=VALUE`（分号亦可作分隔符，空白条目忽略，键值两侧空白去除），在交互终端通道（`ssh/session/open`，PTY 申请后、shell/exec 请求前）与 exec / sudo 命令通道上以 CHANNEL_REQUEST `env` 注入。重复键以最后一条为准——本地合并去重后每个变量恰好请求一次；sudo 通道内部 `SUDO_ASKPASS` 清空默认值让位于用户同名条目（用户值优先，不靠服务器端覆盖顺序）。**默认值**：空串（不发任何 env 请求）。**校验失败行为**：任一条目非法（缺 `=`、键为空或含空白或 NUL、值含 NUL）时连接解析直接失败，并聚合报出全部非法条目——宁可连不上也不错配。语义为客户端显式指定的环境，**不透传本地进程环境变量**；env 请求的注入失败（通道/传输级错误）即报错并命名该变量，不静默吞掉。注意与 ssh(1) 一致的协议现实：env 请求为 fire-and-forget，服务器未 `AcceptEnv` 对应变量时静默丢弃（不发失败应答可观测），此时该变量不生效但连接不失败——需要在远端生效请在服务器 sshd_config 配置 `AcceptEnv`。插件内部管道命令（metrics 采集、磁盘用量、服务器内复制）不注入 setEnv，保证输出解析与连接的语言覆盖解耦。
- `remote_command`（单行文本，默认空串）：非空时 `ssh/session/open` 在申请 PTY 并注入 setEnv 后 exec 该命令**替代 shell request**（PTY 照常申请，对标 `ssh RemoteCommand`）。空串 = 普通交互 shell（默认）。重连或工作台重开会话会**重放同一条命令**，属预期行为（与 ssh(1) 一致：每次新会话都重新执行）。MCP 隐藏 exec 通道、`ssh/exec`、sudo 执行与终端回放（replay）/重连语义不变——remoteCommand 只影响交互会话的启动方式。

## 启动命令（Login scripts 对标）

连接级启动命令（Tabby「Login scripts」对标，M7 P0-4）：连接建立、`request_shell` 成功进入交互 shell 后，sidecar 按配置顺序把预置命令逐条经终端输入通道（与终端 keepalive 相同的 PTY 键盘语义）写入并回车。这是 shell 起来之后的自动键入序列，**不是** `RemoteCommand` 的替代：`remote_command` 非空的 exec 会话没有可键入的 shell 提示符，语义冲突，**自动跳过启动命令**（见上节）。

- 存储：复用 `local/preferences/*` 白名单键 `startup_commands`（`<plugin_data_dir>/preferences.json`），按 connectionId 分桶：`{ <connectionId>: { enabled: bool（默认 false）, commands: [{ command: string（≤4KiB，结尾 CR/LF 剥离）, delayMs: u64（0..=30000，缺省 300）, enabled: bool（默认 true） }] } }`；每连接最多 20 条、最多 512 个连接桶，桶/行级非法形状丢弃不报错（整体非对象由 set 报错）。前端「设置 → 终端 → 启动命令」列表编辑（增删/排序/启停/延迟毫秒，开关默认关），改动对之后新开的会话生效（`open_session` 时读取）。
- 执行：shell 起来后 spawn 一次性顺序注入器；每条命令先等 `delayMs`（首条等待同时覆盖 shell 提示符就绪），再写入 `command + "\r"`；会话关闭（输入通道断开）注入即停。命令可能含敏感串——**永不进日志、审计或事件**。
- 事件 `ssh/startup`：注入结束发一次 `{ sessionId, count, completed }`（`count` 为计划条数；`completed: false` 表示会话中途关闭、序列未走完），**不带任何命令内容**。

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

密码认证被拒绝或服务器未开放 `password` 方法时，自动降级 keyboard-interactive（PAM）认证：每一轮提示先按 Quick Sudo 的同一套编排配置自动应答（密码 / TOTP / 组合提示，遵循 `auth_flow_mode`）；仍未回答的提示在宿主支持 Host API 1.1 `host.requestUserInput` 时打开一次性密文弹窗，展示净化后的服务器 `name` / `instructions` / 提问文本，由用户输入当前动态令牌。弹窗答案只用于本次认证，不写配置、不进日志；取消、超时或空值均 fail closed。旧宿主不支持该接口时保持兼容：未知提示留空交由服务器处理并在失败信息中给出配置指引。最多 4 轮，复用连接超时。覆盖 `PasswordAuthentication no` + PAM 2FA 的主机，以及 JumpServer/koko 的"密码或私钥 + 动态口令"登录；密钥+密码（`private-key-password`）回退路径同样适用。

**首因子判定（2026-09-16，issue #17 / #30）**：`password_then_otp` 只在"首因子已经过掉"时才自动回 OTP 验证码。除同一次 KI 交换里答过密码提问外，以下两种情形同样算首因子已满足——① 密码方法已尝试、服务器要求继续认证（koko/JumpServer 用 partial success 表示"密码通过、还差 MFA"；即使服务器未置该位，密码已提交这一事实同样成立）；② 公钥 / SSH Agent 身份被服务器接受但要求后续认证（partial success 且剩余方法只有 keyboard-interactive，私钥/agent 路径据此续答 KI，不再直接报"认证被拒"）。既没有 password 方法、也没提交过密码的纯 KI 主机保持原保护：裸 OTP 提问不自动应答。

**提问识别**：除提问文本本身，挑战的 `name` / `instructions` 也参与匹配——堡垒机（koko）把可读文案放在 instructions（`Please Enter MFA Code.`）、提问是 `[OTP Code]: `，二者都能命中内置模式（新增 `otp code` / `mfa code` / `mfa:` / 动态密码 / 验证码 / 一次性密码）。OTP 信号优先于用户自定义的"密码提示词"：命中 OTP 模式的提问不会被密码提示词改判成密码提问（避免把登录密码当验证码回给服务器）。

**凭据来源与密码半边（2026-09-16）**：登录期 KI 用的流程模式 / TOTP 密钥 / 提示词与 Quick Sudo 同源——`global` 模式下连接表单隐藏 2FA 四件套（凭据整体由全局配置接管），登录提问因此也读该配置的 `authFlowMode` / `totpSecret` / hints；`custom` 模式下连接自身配置优先，绑定（0.4.x 遗留）只补齐连接留空的项；`off` 不提升全局配置。**密码半边始终是登录口令**（含 `password_command` 解析结果）：登录提问若回一个单独的 sudo 口令只会认证失败，还会把特权口令平白送给对端。

**选型指引**：有稳定的 `otpauth://` URI / base32 密钥时可配置自动回码；手机、硬件令牌或短信里不断变化的六位码不要保存到 `TOTP 密钥`，把该字段留空，连接时在密文弹窗输入当前码。主机先问 MFA、再问密码且需要自动应答时用「密码 + OTP 合并」模式——该模式不设"先密码"门槛，裸 MFA 提问也会被应答；「先密码，再 OTP」对裸 MFA 提问保持留空（保护），随后由宿主弹窗询问。**合并提问**（一条提问里同时要密码与验证码，如 `Password: OTP Code: `）两种 OTP 模式都拼接应答（只回密码半边必然失败）；`password_only` / `off` 仍只自动回密码半边，未回答部分可由连接期弹窗补充。终端内的合并提问同样处理，但需命中密码类内置模式（`[sudo] password for` / `password:`）或配置了自定义提示词，避免误答其他交互程序。

**诊断**：认证失败时错误信息带上服务器实际提问（`name` / `instructions` / 提问文本，去控制字符并截断，绝不包含凭据）。支持 Host API 1.1 的 DBX 会先弹出密文输入框；旧宿主则指路配置 TOTP 密钥或 OTP 提示词。`auth_flow_mode=off` 只关闭自动回码，不关闭连接期人工输入。端到端回归见 `scripts/smoke_login_mfa_test.py`（本机 mock 堡垒机 + 真 sidecar，paramiko 缺失时 SKIP）。

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

返回 `{ path, entries }`，`entries` 为 `SftpEntry` 数组，结构与 `sftp/list` 完全一致（`name`、`uri`、`kind`、`size`、`modifiedAt`、`permissions`、`contentType`，可选字段缺省时省略），并恒定附带 `owner`/`group` 属主与属组名字（来自 `ls -la` 解析，无额外往返；解析不到时省略）。错误：路径不存在或不是目录；sudo 不可用。

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

### sftp/list

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端目录路径 |
| `includeOwner` | boolean | 否 | 是否附加属主/属组信息，默认 `false` |

返回 `{ entries: SftpEntry[] }`。`SftpEntry` 基础字段：`name`、`uri`、`kind`（`file`/`directory`/`symlink`/`other`）、`size`、`modifiedAt`、`permissions`、`contentType`（可选字段缺省时省略）。

**文件名编码（M14-B / M15-B）**：偏好 `sftp_name_encoding`（`auto`/`latin-1`，默认 `auto`）控制列表文件名的显示解码。`auto` 走高层客户端（合法 UTF-8 服务器字节往返无损），wire 名含 U+FFFD（上游 lossy 解码已替换非法字节）时条目附带 `lossy: true`（false 时字段省略）。`latin-1` 改走独立裸包客户端（SFTPv3，严格串行）拿原始文件名字节：`name` 为 latin-1 解码的显示文本，`uri` 中的文件名为 `%XX` 转义的 wire 形式——**传输路径始终用服务器原始字节/转义形式，显示层解码绝不回灌**；下载这类条目时 sidecar 自动把转义还原为原始字节走 raw OPEN/READ（每 chunk 独立 open/close；`start` 的 size 探测同样整条还原后走裸包 STAT——M21 收口）。**回退口径按车道区分（2026-09-26 审计修正）**：列表 raw 路径失败（服务器版本协商/异常包）自动回退高层客户端（只读安全）；下载车道（size 探测与分块读取）不做回退，raw 失败原样上抛——转义名在高层客户端本就打不开，回退只会重演同一错误；写路径按 M15 先例仅在裸包客户端**建立**失败时回退。**M16 连接级覆盖**：编码判定来源升级为「连接覆盖 > 全局偏好 > 缺省 auto」——覆盖存储在偏好键 `sftp_name_encoding_overrides`（语义见 `local/preferences` 行），全局偏好缺省时的行为完全不变；本节所述 raw/auto 两条路径的语义只取决于**最终生效的编码值**，与它来自连接覆盖还是全局无关。

**M15-B 起 latin-1 模式下路径写操作同样走裸包客户端字节保真**：`sftp/rename`、`sftp/delete`（含 `recursive: true` 的递归树删）、`sftp/createDirectory` 对路径参数先还原为服务器原始字节再发送 raw RENAME/REMOVE/RMDIR/MKDIR（判型用 raw LSTAT，symlink 绝不跟随，与 auto 语义一致）。路径处理规则：目录前缀（列表回传的 wire 形式）按 `%XX` 转义还原；rename 目标 / mkdir 名这类**用户新输入的最后一段**按 latin-1 显示编码回字节（>U+00FF 的字符按 UTF-8 兜底；输入中的字面 `%XX` 序列保持字面量，不再转义）。裸包客户端**建立**失败时自动回退高层客户端（此时尚未发出任何请求，回退安全）；操作已发出后的失败原样报错，不回退（避免重复执行写操作）。`auto` 模式下所有操作行为完全不变（继续走高层客户端）。

**M16 起 latin-1 裸包字节保真覆盖全部前端 SFTP 写路径**。裸包客户端补齐写侧操作（OPEN(creat|write|trunc)/WRITE/SETSTAT/READLINK/SYMLINK，SYMLINK 按 OpenSSH wire 次序装包，与高层 `symlink(target, linkPath)` 的生产行为一致）。路径来源分两类，还原分工固定：

- **「wire 目录前缀 + 用户新输入的显示末段」**——`sftp/touch`（新建文件）、`sftp/symlink-create`（新链接名）、`sftp/exists`（rename 覆盖/上传撞名预检的目标路径）、`sftp/rename-unique`（上传撞名探测，候选名连 `(n)` 增量一起按显示编码；返回的 `name` 保持显示形式，回传给上传后按同一分工编码出同一组字节）、`sftp/upload/start|finish`（远端落盘名 = 前端 `joinRemote(当前目录, 本地文件名)`）：目录前缀按 `%XX` 还原、末段按 latin-1 显示编码回字节（即 M15 的 `write_path_bytes` 分工）。
- **「整条 wire 路径」**——`sftp/write`（前端回传 `pathFromUri(entry.uri)` 与 watcher 的 remote-edit 目标）、`sftp/upload-local`（watcher 登记的 wire 路径）、`sftp/symlink-update`（链接路径）、`sftp/rename` 源路径、`sftp/delete`：整条按 `%XX` 还原为服务器字节（wire 的 `%` 自转义保证字面 `%XX` 名往返不吞）。`symlink-read` 的指向文本按 latin-1 显示解码返回，`symlink-update` 再按显示编码回字节，读↔写在 latin-1 域内闭环。

上传/直写均保持「暂存 ASCII 临时文件 → 权限位保留（SETSTAT `0o7777`）→ 原子 rename 落位 → 失败清理/回滚」的提交语义（权限保留对齐高层 issue #37 行为），上传分块按 ≤32 KiB 切分（SFTPv3 兼容上限）。回退策略同 M15：仅裸包客户端**建立**失败回退高层客户端。

**M17 起 latin-1 字节保真补齐读侧与粘贴/拖入链**（M16 遗留 ①② 收尾）：

- **粘贴预检与底层 copy/move**：`sftp/exists` 新增可选参数 `form: "wire"`——粘贴预检（`pasteClipboard`）传来的整条路径是列表回传的 wire 形式，latin-1 下整条按 `%XX` 还原后 raw LSTAT（此前末段被按「新输入显示文本」编码，非 UTF-8 名探不到）；缺省（rename 覆盖预检、上传撞名预检）仍按「wire 前缀 + 显示末段」分工。`sftp/copy`/`sftp/move` 的 `from`/`toDir` 同为 wire 形式：`overwrite: false` 的覆盖预检在 latin-1 下改为逐个裸包 LSTAT（目标整条还原字节），同目录 move 的 SFTP rename 快路径改走裸包 RENAME（SFTPv3 不覆盖已存在目标，撞名/跨设备失败与原先一致回落 shell `mv`）；裸包客户端**建立**失败回退既有字面量路径。**设计边界（登记）**：底层执行仍是远端服务器侧 `cp -a --` / `mv -f --`，SSH exec 的命令串是 UTF-8 String，服务器原始字节经 shell 参数不可控——copy 与跨目录 move 的执行层不做字节保真迁移：clean 名（无转义）行为不变，转义名由服务器侧报错。
- **终端拖入上传的目标目录**：拖入落点询问弹窗的「当前目录」选项（shell cwd OSC 7/633 回读 → sftp home 探测 → 面板当前目录兜底）与「指定目录」手输路径都是显示文本，前端在 latin-1 下经 `displayPathToWire`（与 sidecar `latin1_encode_display` + `escape_wire` 组合逐字符等价：ASCII 字面量透传、`%` 自转义为 `%25`、U+0080..=U+00FF 按码位转义 `%XX`、>U+00FF 的字符按 UTF-8 兜底）转成 wire 形式后与本地文件名 join，整条符合 `write_path_bytes` 的「wire 目录前缀 + 显示末段」分工；面板当前目录兜底本就走列表链的 wire 形式，原样透传。**已知边界（登记）**：shell cwd 回读中非 UTF-8 的服务器字节在终端解码层已丢失（U+FFFD），无法还原为 latin-1 字节，该场景不做恢复。
- **查漏补缺**：`sftp/stat`（属性对话框）与 `sftp/chmod`（权限编辑）在 latin-1 下整条 wire 还原后走裸包 LSTAT/SETSTAT（此前字面量发送，转义名探不到）；裸包 v3 attrs 不携带 uid/gid，`sftp/stat` 的属主/属组仍经 `stat -c` shell 查询尽力而为（转义名下该查询受上述 shell 字节边界限制，失败显示 `-`），元数据主体（kind/size/mtime/mode）不受影响。
- **仍按字面量发送的残留点（登记，shell 字节参数不可控）**：`sftp/diskUsage`（`df -kP` 按目录路径拼命令）、`sftp/archive`/`sftp/extract`（远端 `tar` 拼命令）、sudo 模式全族（`sudo/*` 走 shell 文本管道 `ls -la`/`stat`，本就没有 wire 形式的名字来源）。这些入口在 latin-1 下对含转义的名字维持字面量发送、由远端报错，语义与迁移前一致。


**M17 起 MCP 工具面复用同一编码判定并迁移列表/写工具（字节保真闭环）**：MCP 连接类工具在连接上下文内执行，编码判定直接复用连接级优先链——工具 `arguments` 的 `connectionId`（dispatch 层已把 `connectionName`/端点选择器归一化为该字段，stdio 与 `mcp/call` 同构）命中 `sftp_name_encoding_overrides` 时优先，否则跟随全局 `sftp_name_encoding`，缺省 auto；内联拨号（无 registry 身份）按未覆盖处理。latin-1 生效时：`sftp_list_dir` 改走裸包 READDIR（与工作台列表同源），**名字口径为显示形式**——`name`/`path` 均为 latin-1 解码文本（与工作台看到的显示名一致，不向 AI 消费者暴露 `%XX` wire 噪声），`.`/`..` 跳过，kind 按 v3 类型位归类（缺 permissions 退回 `file`）；`sftp_mkdir`/`sftp_remove`/`sftp_rename` 把路径参数整条按 latin-1 显示编码还原为服务器字节后走裸包 MKDIR/LSTAT+REMOVE/RMDIR/树删/RENAME（remove 判型分派与 auto 分支一致：symlink/文件 REMOVE、目录递归树删、非递归目录报错；rename 源 = 列表回传显示路径、目标 = AI 新输入显示文本，>U+00FF 字符 UTF-8 兜底）。**往返闭环**：latin-1 解码输出恒在 U+0000..=U+00FF 域内，显示 → 字节的 `latin1_encode_display` 是其精确逆变换——AI 把列表返回的 `path` 原样回传给写工具即落回原始字节（单测覆盖）。回退策略与工作台一致：列表 raw 路径任何失败回退高层（读操作安全），写操作仅裸包客户端**建立**失败回退；`auto` 模式下四个工具行为完全不变。

**遗留（登记）**：① ~~粘贴预检与 `sftp/copy`/`sftp/move` 未迁移 raw~~（M17 已收尾，见上——shell 执行层的字节边界仍登记在案）。② ~~终端拖入上传的自定义目标目录按 wire 前缀处理~~（M17 已收尾，见上；shell cwd 回读的非 UTF-8 字节丢失为不可恢复边界）。③ ~~MCP 工具面其余工具按字面量发送~~（M18 已收尾，见下）。

**M18 起 MCP 工具面剩余 SFTP 工具完成 latin-1 字节保真迁移（M17 遗留 ③ 收尾）**：沿用 M17-B 同一模式（显示路径整条 `latin1_encode_display` 还原字节 + 连接级裸包客户端），latin-1 生效时：

- **读侧**：`sftp_stat` 走裸包 LSTAT（不跟随符号链接，与工作台 `sftp/stat` M17 同口径）；裸包 v3 attrs 不携带 uid/gid，属主数字经 `stat -c '%u %g'` shell 查询尽力而为补齐（非 ASCII 显示名的 shell 字节参数不可控——M17-A 登记边界，失败回 `null`，主元数据不受影响）；`sftp_exists` 走裸包 LSTAT，**只把 SSH_FX_NO_SUCH_FILE 映射为「不存在」**，其余错误如实上抛（auto 分支「权限错误绝不误报 exists:false」契约保持）；`sftp_read_file` 走裸包 OPEN(READ)+READ 分块循环（32 KiB 粒度，v3 规范建议口径），大文件策略沿既有 MCP 边界——单次至多 `maxBytes`（上限 maxDownloadBytes），超出标记 `truncated`，`offset` 分页起点显式携带。
- **写侧**：`sftp_write_file` 走裸包 OPEN(CREAT|WRITE|TRUNC) 截断直写 + WRITE 32 KiB 分块（**选型**：MCP 面沿既有直写语义，无工作台上传族的 `.dbx-part` 暂存需求；`overwrite=false` 的覆盖预检走裸包 LSTAT，与写入同一字节口径）；`sftp_chmod` 走裸包 SETSTAT（只带 permissions 子集）。
- **copy/move**：`sftp_copy`/`sftp_move` 沿工作台 M17-A 同模式接入裸包车道（路径口径为**显示形式**，与 MCP 面 rename 一致）：`overwrite=false` 的覆盖预检逐个裸包 LSTAT，同目录 move 的 RENAME 快路径走裸包 RENAME（SFTPv3 不覆盖已存在目标，失败回落 shell `mv`）。**执行层边界（登记，同工作台）**：远端 `cp -a --`/`mv -f --` 的 exec 命令串是 UTF-8 String，服务器原始字节经 shell 参数不可控——copy 与跨目录 move 的执行层保持字面量发送：clean 名（纯 ASCII）行为不变，非 ASCII 名由服务器侧报错。
- **回退策略与 auto 不变性**：读操作（read_file/list_dir）裸包路径任何失败回退高层（读安全）；写操作（stat/exists/write_file/chmod/copy/move 的操作阶段）仅裸包客户端**建立**失败回退，操作错误原样上抛不重试；`auto` 模式下全部工具行为不变。每工具均有 latin-1 往返闭环单测（内存双工桩，字节级断言）。

**M19 起 MCP 传输工具 `sftp_upload`/`sftp_download` 完成 latin-1 字节保真迁移（编码保真家族收尾）**：沿用 M17-B/M18 同一模式（显示路径整条 `latin1_encode_display` 还原字节 + 连接级裸包客户端），latin-1 生效时——`sftp_upload` 走裸包 OPEN(CREAT|WRITE|TRUNC) 截断直写 + WRITE 32 KiB 分块（**选型**：沿既有 MCP 传输直写语义，无工作台上传族的 `.dbx-part` 暂存需求；`overwrite=false` 的覆盖预检走裸包 LSTAT，与写入同一字节口径，复用 M18 `sftp_write_file` 直写核心）；`sftp_download` 走裸包 OPEN(READ)+READ 分块（读取量以 `maxDownloadBytes+1` 探测封顶，超限沿既有 post-read 口径报错；目录的 OPEN 被服务器拒绝后落回高层，由高层给出与 auto 分支一致的「is a directory」错误）。**往返闭环**：upload 响应的 `remotePath` 为显示形式，原样回传给 `sftp_download` 即命中同一组服务器字节（单测以内存双工桩断言两侧 OPEN 帧路径字节一致 + 载荷逐字节回收）。回退策略沿先例：download 读侧裸包路径任何失败回退高层重读（读安全），upload 写侧仅裸包客户端**建立**失败回退，操作错误原样上抛；`auto` 模式下两个工具行为完全不变（本地路径校验、传输根约束、敏感路径拒绝、大小上限均先于拨号，不受影响）。


`includeOwner: true` 时，每个条目可携带可选 `owner`、`group` 字符串字段（属主用户、属组）：优先服务器直接提供的名字（SFTPv4+ 属主属性），数字 uid/gid 次之，SFTPv3 服务器（如 OpenSSH）再经一次只读 `ls -l` 往返升级为名字——该次往返失败（无 shell、无 `ls`、超时）时静默保留数字或省略字段，不影响列表本身。字段缺失即"未知"，由 UI 显示 `-`。省略 `includeOwner`（或为 `false`）时不输出这两个字段，与历史响应完全一致。`sudo/listDir` 恒定返回 `owner`/`group`（`ls -la` 解析附带，无额外往返）。

### sftp/stat

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端绝对路径 |

返回结构与 `sudo/stat` 完全一致（`{ path, kind, size, modifiedAt, mode, owner, group }`）。错误：路径不存在。`sftp_name_encoding` 为 `latin-1` 时路径整条按 wire 还原走裸包 LSTAT（M17）；裸包 v3 attrs 不携带 uid/gid，属主/属组仍经 `stat -c` shell 查询尽力而为（转义名下受 shell 字节边界限制，失败显示 `-`）。

### sftp/exists

参数同 `sftp/stat`（`sessionId`、`path`），另有可选 `form: "wire"`（M17）：粘贴预检传来的是整条 wire 路径，带该参数时 latin-1 模式整条按 `%XX` 还原字节探测；缺省按「wire 前缀 + 显示末段」分工（见 `sftp/list` 节 M17 段）。返回 `{ exists: bool }`，路径不存在不算错误。

错误语义（M23/R1，两面对齐后口径统一）：只有 SSH_FX_NO_SUCH_FILE 判「不存在」，其余 LSTAT 失败（权限拒绝、通道异常等）如实报错——权限错误绝不误报 `exists: false`（与 MCP 工具 `sftp_exists` 的 M18 契约一致，工作台 RPC 面同一口径）。工作台预检调用方（rename 覆盖预检、粘贴预检、上传撞名预检）对预检报错均按「无法判定、不阻断，交由后续执行时报错」的既有惯例处理——预检无法判定时报错优于误判。

### sftp/read

小文件直读（非传输槽，支持 `offset` 偏移分片语义）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 是 | 远端文件路径 |
| `offset` | number | 否 | 起始字节偏移，默认 `0`；省略或非法值按 `0` 处理 |
| `maxBytes` | number | 否 | 本次最多返回的字节数，默认 256 KiB，上限 1 MiB（至少为 1） |

**文件名编码（M19.5 落地）**：生效编码为 `latin-1` 时 `path` 是整条 wire 形式（列表回传的 `%XX` 转义路径），sidecar 整条还原为服务器字节后走裸包 READ（与下载分片同一车道）；`auto` 按 UTF-8 走高层客户端。

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

会话内 `sessionId` 与连接级 `connectionId` 二选一（`connectionId` 自动解析到该连接的存活会话）。返回 `{ success, results: [{ from, to, ok, error? }] }`：逐项执行、逐项回报，`error` 仅出现在失败项上；任一项失败则 `success` 为 `false`。`overwrite: false` 时先探测目标（latin-1 下逐个裸包 LSTAT，目标整条按 wire 还原字节；其余一轮远端 `test -e`），已存在直接按项失败。同一目录内的 move 优先走 SFTP rename（latin-1 下走裸包 RENAME，失败回落 shell `mv`）。底层 shell `cp`/`mv` 的 exec 命令串是 UTF-8 String，转义名字节的执行层边界见 `sftp/list` 节 M17 段。错误（整体）：参数缺失或非法；只读连接。

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
- `local/terminal/in/{sessionId}`：本地终端输入，与 `ssh/terminal/in` 同形（8 字节大端序号 + 数据）；确认事件为 `local/terminal/inputAck`，死会话镜像 `local/terminal/error`。
- `local/terminal/out/{sessionId}`：本地终端输出，与 `ssh/terminal/out` 同帧格式（流类型 + u64 序号）；stdout/stderr 在 PTY 内合流，数据帧恒为流 0。
- `serial/terminal/out/{sessionId}`：串口终端输出，与 `ssh/terminal/out` 同帧格式（流类型 + u64 序号），数据帧恒为 Stdout 流（读线程逐读递增序号）。
- `serial/terminal/in/{sessionId}`：串口终端输入（B1 二进制写通道），帧与输出同构（`TerminalFrame`：1 字节流标签 + 大端 `u64` 序号 + 原始键序字节），标签**恒为 `Stdin = 3`**（避开 local 终端带内状态帧占用的 `State = 2`）；非 Stdin 标签/截断帧由 sidecar 按参数错误拒绝；文件上传活动期间一律拒绝（互斥后盾，第一道闸门在前端）；拒绝与死会话镜像 `serial/terminal/error`，成功确认 `serial/terminal/inputAck {sessionId, sequence}`（sequence 仅审计用，无重传语义）。解码端遇到未知流标签（> 3）一律静默丢帧并计数，不得断连或 panic。设计依据 `docs/SERIAL_ENHANCE_DESIGN.zh-CN.md` §2。
- `sftp/upload/{taskId}`：大端 `u64` 文件偏移加最多 256 KiB 数据；偏移必须等于服务端期待值。
- `sftp/download/{taskId}`：大端 `u64` 文件偏移加最多 256 KiB 数据（树任务该偏移为整树聚合字节位置；队列耗尽后的 eof 应答携带 0 字节数据）。
- `vnc/frame/{sessionId}`：VNC 帧补丁，44 字节头 + RGBA 像素负载，全部**小端**（字段表见下文「VNC 帧补丁」小节）。
- `rdp/frame/{sessionId}`：RDP 帧补丁，与 `vnc/frame` **同一** 44 字节 patch 头 + RGBA 像素负载（全小端；字段表、校验不变式与跨端 golden 向量同「VNC 帧补丁」小节，前端解码器直接复用）。

终端输出保留 2 MiB 环形缓存。前端检测到序号缺口后停止乱序输出并调用 `ssh/terminal/replay`。文件传输采用逐块 RPC 确认，不依赖广播队列可靠送达。

### VNC 帧补丁（`vnc/frame/{sessionId}`）

VNC 远程桌面的帧缓冲更新以 patch 帧推送：`44 字节头 | RGBA 像素负载`，所有字段一律**小端（LE）**——与 `ssh/terminal/out` 的大端序号刻意不同（逐字段对齐 NyaTerm 的 patch 协议）。字段序与偏移：

| 偏移 | 长度 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- | --- |
| 0 | 8 | u64 LE | `sequence` | 单调递增（跨重连持续），前端据此丢弃乱序补丁 |
| 8 | 4 | u32 LE | `desktopWidth` | 桌面宽（像素，≤3840） |
| 12 | 4 | u32 LE | `desktopHeight` | 桌面高（像素，≤2160） |
| 16 | 4 | u32 LE | `x` | 补丁左上角 x |
| 20 | 4 | u32 LE | `y` | 补丁左上角 y |
| 24 | 4 | u32 LE | `width` | 补丁宽（像素） |
| 28 | 4 | u32 LE | `height` | 补丁高（像素） |
| 32 | 4 | u32 LE | `stride` | 字节/行；恒为 `width*4`（RGBA 紧排），作为对齐 NyaTerm 的保留字段 |
| 36 | 4 | u32 LE | `pixelFormat` | 恒为 `2`（RGBA8888，R/G/B/A 字节序） |
| 40 | 4 | u32 LE | `payloadLength` | 负载字节数 |
| 44 | N | bytes | payload | RGBA 像素数据，按行存放，行尾可有 stride 填充 |

编解码两侧（sidecar `encode_frame_patch` / 前端 `decodeVncFramePatch`）校验同一组不变式，任一不满足整帧丢弃（前端抛错丢帧；sidecar 判会话失败）：桌面与矩形尺寸非零；`x+width ≤ desktopWidth`、`y+height ≤ desktopHeight`（带回绕保护）；`stride ≥ width*4`；`payloadLength ≥ stride*height`；帧总长恰为 `44 + payloadLength`；`pixelFormat == 2`。桌面有界（≤3840×2160）使补丁负载天然 < 64 MiB。`sequence` 无需请求重放——丢帧只影响画面，下一帧补丁或全帧刷新（重连重画）自愈。

参考实现：`backend/src/vnc_session.rs`（编码端）、`frontend/src/lib/vncFrame.ts`（解码端）；跨端 golden 向量以同一 hex 字符串硬编码在两侧测试中（`patch_frame_golden_vector_matches_frontend` / `vncFrame.spec.ts` 的 golden 断言，互指本文档）。`vnc/start {connectionId?, workbenchId, host, port?, runtimeHost?, runtimePort?, ...}` 和 `telnet/start` 同理：`host/port` 是逻辑显示端点、`runtimeHost/runtimePort` 是唯一拨号端点（省略时回退逻辑端点）；`vnc/replay {sessionId}` 通过原帧通道发送当前完整 framebuffer 并返回 `{frameCount, complete:true}`，不会新建会话。

### 死会话输入事件（`ssh/terminal/error`）

二进制 handler 失败只落 sidecar stderr（SDK 循环仅日志），工作台原本对"输入撞上已消失会话"毫无感知——终端看似在线实则打不进字。与 `sftp/upload/error` 同理，`ssh/terminal/in/{sessionId}` 处理失败时镜像发事件 `ssh/terminal/error { sessionId, error }`（错误串即 `write_terminal` 原文，会话不存在时为 `SSH session was not found or expired`，与 `session()` 同契约）。前端收到后按传输断开的同款有界退避梯子自动重连；`ssh/terminal/replay` 因会话消失报错时，前端同样将序号游标 resync 过缺口（让卡在缓冲里的 `ssh-transport-disconnected` 状态帧得以放出）再进入重连。

### 上传两阶段计数与收尾语义（issue #60）

上传事件 `sftp/transfer/progress` 携带 `phase` 字段区分两个独立计数（各自从 0 起步）：`staging` = 字节缓存进本地 spool 文件（`transferred` = 已缓冲字节数，速率≈本机磁盘），`uploading` = 字节真正推送到 SFTP 服务器（`transferred` = 已推送字节数，速率≈网络）。工作台只在 `uploading` 阶段采样速度、并按阶段钳制进度单调，避免"3G→100M 回跳"与"20MB/s 假速度"。`sftp/transfer/list` / `sftp/transfer/status` 的上传行同样带 `phase`（staging 行的 `transferred` 为 spool 字节数）。下载事件无 `phase`。

`sftp/upload/finish` **不再长持 RPC**：校验 spool 完整后把远端推送交给 sidecar 后台任务并立即返回 `{ success: true, taskId, phase: "uploading", accepted }`；完成/失败/取消只经终态 progress 事件回传（此前长持 RPC 会被桥上任一端的 deadline 判死，健康的多 GB 上传被误报为 "upload cancelled"）。`sftp/transfer/cancel` 新增可选 `reason`（字符串 slug，≤120 字符：`user`=用户按钮、`ack-timeout`=分片确认超时、`local-read-error`/`append-failed`/`start-failed`/`client-error`=前端各类异常清理），取消事件的 `error` 文案据此区分（如 "Upload cancelled by user" / "Upload cancelled (ack-timeout)"），sidecar 日志同步打印取消原因。二进制拒收（offset 失配/任务丢失/spool 写失败）新增事件 `sftp/upload/error { taskId, error }`，前端无需等满 30s ack 超时。

传输状态查询（只读，不产生副作用）：

- `sftp/transfer/list`：参数 `sessionId`。返回 `{ tasks: [...] }`——该会话进行中的上传 / 下载与近期历史（每个会话独立记录），元素结构 `{ taskId, sessionId, direction, fileName, size, transferred, status }`，`status` 取 `running` / `completed` / `cancelled`。
- `sftp/transfer/status`：参数 `taskId`。返回单个任务的同构状态对象；任务不存在时先查历史，仍无则报错。
- `sftp/transfer/history`：参数 `sessionId?`（可选过滤）、`limit?`（默认 50，上限 200）。返回 `{ tasks: [...] }`——持久化传输历史（`transfer-history.json`，环形上限 200 条，跨 sidecar 重启保留）与内存 live 任务按 `taskId` 去重合并、新→旧排序，元素结构 `{ taskId, sessionId, connectionId, direction, fileName, size, transferred, status, startedAt, finishedAt, error? }`（时间戳 Unix 毫秒；`status` 同上并含 `failed`）。无活动连接也可查询；仅状态跃迁落盘，逐块进度不落盘；跨进程（embedded 与 stdio `--mcp`）last-writer-wins；重启后遗留 `running` 呈现为 `failed`（不回写文件）。不进 MCP 工具面。

## 本地终端

工作台内的本机 shell 入口（sidecar 所在机器，非 SSH 远端）。与 SSH 终端共用二进制帧协议、序号重放（2 MiB 环形缓存）与输出管线，但独立会话表，不依赖任何 SSH 连接：

- `local/terminal/start {workbenchId, cols, rows, shell?, shellIntegration?, cwd?}` → `{sessionId, shell, shellIntegration}`。`shell` 来自选择器偏好（`localShell`，空=自动探测）；`cwd` 供重开继承上次跟踪目录（VS Code 惯例），非法/已删目录静默回落家目录。shell 解析顺序：显式 `shell` 参数 → macOS Directory Services `UserShell`（`dscl`）→ `$SHELL` → 平台缺省（macOS `/bin/zsh`、Linux `/bin/bash`、Windows `powershell.exe`）；`nologin`/`false` 一类登录不可用 shell 视为未设置。Unix 侧一律以**登录 shell** 启动（macOS GUI 进程 PATH 不全，Ghostty/Warp 惯例），cwd 为用户家目录，`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=dbx`。会话关闭先落 master 让 shell 收到 EOF/HUP 干净退出（zsh/bash 仅在干净退出时保存命令历史），5s 宽限后才 SIGKILL 兜底（再给 2s 收取退出码）。
- shell integration 注入（`shellIntegration: false` 可关闭；脚本落盘/包装失败时静默回退裸 shell）：自带精简脚本集（zsh 经 `ZDOTDIR` 包装链，保留用户 `.zprofile`/`.zshrc`/`.zlogin` 与登录语义；bash 走 `--rcfile` 包装自建 profile 链；fish `-C`；PowerShell `-Command`），每步 fail-safe，用户 rc 损坏不阻断 shell。脚本发射 OSC `133;A/C/D;exit`、`633;E;命令行`、`633;P;Cwd=…` 与 OSC 7（Windows 为 OSC 9;9），前端复用既有命令标记/目录解析渲染运行中命令、退出码与 cwd。**注入数据仅用于装饰与 cwd 跟踪，绝不进入任何执行路径**（VS Code shell integration RCE 前车之鉴）。
- 输出帧同 `ssh/terminal/out`；会话结束发流 2 State 帧 `local-terminal-exited` 并伴随事件 `local/session/state {sessionId, workbenchId, state: "exited", exitCode}`（`exitCode` 为 null 表示未能取得，如进程被杀）。输入通道失配镜像 `local/terminal/error {sessionId, error}` + `local/terminal/inputAck` 确认，语义与 SSH 同构。
- `local/session/list` 供 webview 重载后接回仍活着的 shell；`workbench/close` 会回收该工作台的本地会话；sidecar 退出即全部终止（本地 PTY 生命周期 = sidecar 生命周期）。
- 安全语义：入口为工作台显式按钮（未连接也可用；SSH 会话在连时经确认先关闭），无自动开启路径；manifest 权限集不变（复用 `host.binary`），本机命令执行能力与用户自身终端同级，无提权。
- 偏好（`local/preferences/*` 白名单新增）：`localShell`（字符串 ≤200，空=自动探测）、`localShellIntegration`（布尔，缺省 true）。shell 选择器在工作台本地终端按钮旁的设置菜单（`local/shells/list` 发现 + 注入开关），徽标显示 `Local · <shell>`，重开按钮在本地会话存活时保持可用（restart 语义：关当前 → 按新偏好重开）。

## 串口终端回放（`serial/replay`）

与 telnet/local 终端完全同构的序号制输出回放（设计稿 `docs/SERIAL_ENHANCE_DESIGN.zh-CN.md` §3）：读线程在会话生命周期内把输出帧存入按字节预算截断的有界环形缓冲（串口会话 128 KiB，远小于终端的 2 MiB——串口输出是控制台流量而非全屏重绘），`serial/terminal/out` 的在线帧与回放帧共用同一单调序号。

- `serial/replay {sessionId, afterSequence}` → 在 `serial/terminal/out/{id}` 上重发其后帧，并返回摘要 `{frameCount, firstAvailableSequence, tailSequence, complete}`。`complete: false` 表示缓冲已绕回、回放不完整，前端提示截断；会话已关闭时返回 "Serial session was not found"。
- 前端复用既有 gap 检测/drain 机制（`drainSerialFrames`）：缺口经 `serial/replay` 回填；缺口永不可填时按无进度上限 resync 游标。
- 能力探测降级（设计稿 §2 兼容策略）：`serial/start` 响应新增 `binaryInput: true` 能力字段；未声明该字段的旧 sidecar 由前端走 JSON `serial/write` 兼容路径，前端对 `serial/terminal/in` 通道报错一律一次性降级 JSON，老前端不受影响。`BackspaceMode` 的 DEL→BS 改写在两个通道上语义一致（sidecar 内统一执行）。
- RS-232 无窗口尺寸概念，串口会话无 `resize` 方法（设计稿 §4 明确不实现）。

### 写序列化与回压

串口写方向收敛到每会话一条**专用写线程**（独占端口写方向；读线程与写线程共用端口互斥锁但各持短临界区）：键入（B1 二进制帧与 `serial/write` JSON 同源）与上传引擎输出只**入队**不碰锁。设计稿「写序列化与回压」节定稿参数：

- 分帧：键入大包按 **4 KiB** 小块分帧入队，单块持锁写时间有上界（@9600 波特约 4 秒）；上传引擎输出保持块级原样，不受切分影响。
- 有界队列：按 **256 KiB** 字节预算有界；准入全有或全无（半个包入队会让线上字节流停在任意中断点）。满时键入**整包丢弃**并发事件 `serial/input/dropped {sessionId, bytes, reason: "oversize" | "queue_full"}` 回报前端；引擎输出满时报错终止上传（可读错误，绝不阻塞调用线程）。键入单包上限 **16 KiB**，超限按 `oversize` 丢弃并回报。
- 可取消：上传取消先清空队列再入队取消序列；会话关闭清空队列并唤醒写线程退出（在途系统调用写入无法中断，其后队列内容保证不再写出）。
- 写失败镜像事件 `serial/write/error {sessionId, error}`（写线程异步写失败时；会话保持存活，端口消失由读线程 error 状态收场）。

## 串口文件上传（X/Y/ZMODEM）

串口会话（RS-232 控制台）支持向对端设备发送文件，三协议引擎为纯状态机（输入=对端字节流，输出=待写字节序列），由串口读线程在既有泵循环内驱动；对端响应既驱动协议也照常上屏（NyaTerm 语义），上传期间的键入由前端拦截（控制字符窗口），sidecar 拒绝并发第二次上传。

- `serial/upload/start {sessionId, protocol, fileName, totalSize}` → `{sessionId, protocol, totalSize}`。`protocol ∈ "xmodem" | "ymodem" | "zmodem"`（拼写为 `zmodem`）；`fileName` 仅作标签与协议头负载，不落盘；`totalSize` 超过 256 MiB、YMODEM 头元数据（name\0size）超过 128 字节、或该会话已有上传在跑时直接报错。
- `serial/upload/data {sessionId, dataBase64, final}` → `{received, final}`。前端 File API 分块（≤64KiB）送入；未收尾（`final: false`）时部分数据不会被视为文件尾，引擎在协议请求越过已到数据且未收尾时保持等待（超时时钟暂停），因此文件可在协议握手的同时流式灌入。
- `serial/upload/cancel {sessionId}` → `{success}`。X/Y 发 CAN×8、ZMODEM 发 ZDLE×5+BS×5 取消序列并落 `failed` 进度事件；幂等。
- 事件 `serial/upload/progress`（notify）：`{sessionId, protocol, fileName, fileIndex, sent, total, state, reason?}`，`state ∈ "running" | "file_complete" | "complete" | "failed"`；`sent` 为对端已确认（ZMODEM）或已确认收到（X/Y ACK）的字节数，不含文件内容；事件按 ≥4KiB 增量或 200ms 窗口限流，状态变化强制上报。

协议语义（对齐 NyaTerm 及其 vendor zmodem2 发送端行为，代码手写）：XMODEM 128B 块 + CRC16（`C` 握手）或 8-bit checksum（`NAK` 握手）、CPM-EOF 尾填充、EOT 先 NAK 后 ACK；YMODEM 批形态（块 0 头 `name\0size` 零填充、固定 CRC、EOT 后收尾全零头块）；ZMODEM ZRQINIT(hex)→ZRINIT→ZFILE(bin32+CRCW 子包)→ZRPOS→ZDATA（每帧单 ZCRCW 子包等待落盘确认，子包按对端 ZRINIT 声明的接收缓冲截断，上限 8KiB）→ZEOF→ZRINIT→ZFIN(hex)→`OO`，支持 ZRPOS 断点续传与 ZSKIP 拒收；对端连续取消字节（X/Y CAN×2、Z ZDLE×5）判远端取消，静默 10s 重发最后一帧、10 次后失败。

## RDP 远程桌面会话

RDP 客户端（RDP-2，nyaterm-parity P3-4）：引擎为 RDP-1 vendored IronRDP 链（ironrdp 0.17 lockstep，`backend/vendor/`），连接序列（X.224 协商 → TLS → CredSSP/NLA → 虚通道）与 NyaTerm `src/core/rdp.rs` 同构。**范围（评审定案，见 `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）**：密码/NLA（CredSSP）+ TLS + 文本剪贴板 + 断线重连；不做音频、驱动器重定向、键盘捕获、网关/RDCleanPath、UDP 传输、Kerberos。仅 TCP 直连形态。

- `rdp/start {workbenchId, host, port?=3389, username, password?, domain?, width?=1280, height?=800, useNla?, certificatePolicy?, clipboard?=true, reconnectAttempts?=5}` → `{sessionId, host, port, useNla, certificatePolicy, clipboard, reconnectAttempts}`。`width/height` 须在 640x480..3840x2160（下界沿 NyaTerm，上界沿插件远程桌面上界，保证补丁负载 < 64 MiB）。`useNla`/`certificatePolicy` 缺省依次回落偏好（`rdp_use_nla`/`rdp_certificate_policy`，见下）与评审锁定缺省（`true`/`prompt`）。密码仅本地 IPC 传输，sidecar 以 `Zeroizing` 持有，不落日志/审计/错误信息。
- `rdp/input`（别名 `rdp/write`）`{sessionId, kind, ...}`：`kind ∈ key-down | key-up | mouse-move | mouse-button | mouse-wheel | unicode | release-all`。键盘字段 `scan_code`（camelCase `scanCode` 别名）+ `extended`；鼠标 `button ∈ left|middle|right|back|forward`、`pressed`、`x/y`；滚轮 `deltaX/deltaY`（浏览器增量，取反映射为 RDP 旋转单位，NyaTerm 语义）；`unicode` 按字符 press+release（每条 `unicode` 文本 ≤4096 字符，超限整包拒绝——字符逐一展开为 press+release 对，无界文本即无界操作列表；收官审查 E5 修复）。右 Shift（非扩展 0x36）走直发 fast-path（NyaTerm 修复），其余经输入数据库派生 fast-path 事件。返回 `{success}`。
- `rdp/resize {sessionId, width, height}`：服务端动态分辨率，尺寸门限同 start。返回 `{success}`。
- `rdp/set-clipboard {sessionId, text}`：本地文本 → 远端（暂存 + 以 CF_UNICODETEXT 广告）。**仅文本**；上限 16 MiB，超限整包拒绝（不截断）。返回 `{success}`。
- `rdp/reconnect {sessionId}`：手动重连（generation 计数防串话）。返回 `{sessionId, success}`。
- `rdp/close {sessionId}`：关闭会话（凭据随会话丢弃、待定证书确认全部拒绝、剪贴板暂存清空）。返回 `{success}`。
- `rdp/replay {sessionId}`：Webview 重建后在原 `rdp/frame/{sessionId}` 通道重发**一张完整合成 framebuffer**，返回 `{frameCount: 1, complete:true}`。只有一张覆盖整个当前桌面的全屏 patch（`x=0,y=0,width=desktopWidth,height=desktopHeight`）才能建立 replay 基线；首帧为局部 patch、尺寸改变、close/error/reconnect 清理后均返回 `{frameCount: 0, complete:false}`，前端必须等待新的全屏基线，绝不得把增量 patch 误当完整桌面。实时 patch 合成、sequence 分配、replay 帧构造与发布由同一个会话锁串行，重挂帧不能插队到已分配但尚未发布的实时 sequence 之前。合成图严格限制为一张 RGBA 画面，尺寸上限 3840×2160，最大 **31,850,496 bytes（约 30.4 MiB）**；不保留多张 patch（旧方案在 4K 下可能累积数百 MiB）。
- `rdp/list` → `{sessions: [{sessionId, workbenchId, host, port, username, hasPassword, useNla, certificatePolicy, clipboard, createdAt}]}`（按创建时间排序；不含密码与实时状态）。
- `rdp/certificate/resolve {challengeId, accept?, remember?}`：证书确认应答。`accept` 缺省 false——超时/取消/未知 id 一律拒绝（fail-closed）。`remember=true` 时把指纹记入 `<plugin-data>/rdp-known-certs.json`（`{"host:port": "SHA256:hex"}`，上限 1024 条，与 SSH known_hosts 先例同作用域语义）。共享入口 `connection/challenge/resolve` 亦按 challengeId 路由到 RDP 注册表。

事件：

- `rdp/session/state {sessionId, workbenchId, state, errorKind?, error?, attempt?, maxAttempts?}`：`state ∈ connecting | connected | reconnecting | closed | error`；`connected` 在首个桌面帧到达时发布。`errorKind ∈ transport | tls | certificate | authentication | negotiation | session | clipboard`。**认证失败文案统一为 "RDP authentication failed"**（不区分用户名/密码错误、不回显凭据）。
- `rdp/frame/{sessionId}`（二进制）：44 字节 patch 头 + RGBA 负载，与 `vnc/frame` 同格式（见上文），`sequence` 跨重连单调。
- `rdp/clipboard {sessionId, text, chunkIndex?, chunkTotal?}`：远端 → 本地文本（≤16 MiB，仅 CF_UNICODETEXT；由后端格式过滤保证，非 UI 约束）。JSON 转义后超过单事件预算（7 MiB，超出会被 SDK 传输静默丢弃）的文本由后端按字符边界分片发送，多片事件附带 `chunkIndex`/`chunkTotal`，前端按会话隔离缓冲拼接（收官审查 C2 修复；单片事件不附这两个字段）。
- `rdp/pointer {sessionId, type, ...}`：`type ∈ default | hidden | position(x,y) | bitmap(width,height,hotspotX,hotspotY,rgbaBase64)`（服务端光标形状，NyaTerm 同族事件）。
- `connection/challenge {challengeId, kind: "rdp-certificate", sessionId, host, port, fingerprint, knownHostStatus}`：证书确认请求（`knownHostStatus ∈ match | changed | unknown`）。确认窗 **120s**，超时即拒绝；generation 变更后到达的应答一律拒绝（防串话）。

重连门控（NyaTerm 同款分类器）：证书/认证/协商类失败**永不**自动重试；TLS/传输类失败有限重试，退避 1/2/4/8/15s 封顶 30s，默认 5 次（上限 10；`reconnectAttempts` 可调）。会话曾进入 active（收到过帧）后失败则重置重试预算；服务端主动断开（graceful disconnect）不自动重连，由用户 `rdp/reconnect` 决定。`rdp/close` 与 `rdp/reconnect` 递增 generation，旧代 worker 静默退出，帧/事件/证书应答均按 generation 过滤。另有**会话生命周期累计重连总预算 50 次**（`MAX_TOTAL_RECONNECTS`，永不重置——active 重置只回退退避步长、不回补总预算，防恶意服务器把有限退避变成无限循环；收官审查 D3 修复），预算耗尽即终局关闭。

安全红线（实现与评审对照见 `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`）：NTLMv2-only（vendored sspi 明示不支持 NTLMv1/LM，源码断言钉在 `vendored_sspi_marks_ntlmv1_and_lm_as_unsupported`）；CredSSP 仅在 TLS 之上（`with_tls(true)` 恒开）；证书策略 fail-closed（`prompt` 默认 / `strict` / `accept-temporarily`，无「静默接受」路径）；剪贴板 text-only + 16 MiB + 不落审计；凭据 `Zeroizing` 持有、不进日志/事件/错误。用户文档保留「连接期间远端可读写会话剪贴板、凭据实质交付目标主机，仅连接可信主机」警示。

实验门控与偏好（`local/preferences/*` 白名单，RDP-2）：`rdp_experimental_enabled` 仅显式布尔 `true` 才启用，缺失、非法或 false 均默认关闭；用户在**设置 → 实验性 RDP → 启用实验性 RDP**写入该键，前端才展示入口。后端在 `rdp/start` 前独立检查同一偏好，因此门关闭时直接 RPC 默认拒绝，不能绕过 UI。另有 `rdp_use_nla`（布尔，缺省 true）、`rdp_certificate_policy`（`prompt`（缺省）| `strict` | `accept-temporarily`，白名单外拒绝写入）。不新增 manifest 字段。

## 主机密钥确认通道(requestUserInput)

首次连接(或主机密钥变更)时,sidecar 的确认请求按以下顺序选通道:

1. **宿主弹窗(优先)**:宿主在 `plugin/initialize` 通过 `host.features` 广告
   `host.requestUserInput`(点分形式,Host API 1.1 起)时,sidecar 直接调用
   `host/requestUserInput`(字符串 id `plugin-N`,`echo: true`,`options:
   accept/remember`,`timeoutSecs: 300`;title/prompt 超过宿主 200/2000 字符
   上限时 sidecar 先行截断)。代码门控只按 `host.features` 列表判断,不校验
   `hostApiVersion` 版本号。弹窗期间宿主暂停 `connection/test` /
   `connection/connect` 的请求截止时间,连接表单里即可完成信任;sidecar 自身
   的 connection/test 镜像预算若在弹窗挂起期间到期,会以"挑战等待 + 连接超时"
   重臂一次(仅弹窗路径;Host API 1.0 路径预算不变)。
2. **工作台事件(降级)**:宿主不支持(-32601)、参数被宿主拒绝(-32602)或无
   可用弹窗面(-32001 且非 SDK 本地超时)时,仍发既有事件 `connection/challenge`,
   由工作台 UI 应答(`connection/challenge/resolve`),语义与字段不变。
3. **fail closed**:用户 cancel/timeout、宿主对请求不应答(SDK 本地 330s 超时,
   `-32001` + "did not answer")、或其他错误——一律拒绝握手,不降级、不猜测。
   弹窗应答仅 `action: "submit"` 且 `value` 为 `accept`/`remember` 才授信,
   缺失/未知 value 一律视为拒绝。MCP 模式的 `auto_trust`(TOFU)行为不变。

已知限制:Host API 1.0 宿主 + 工作台未打开(连接表单路径)仍无应答者,`connection/test`
约 9s 后返回可读超时文案(0.4.78+ 缓解),文案在挑战已发出且未走弹窗路径时附指引。

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

### 连接表单的私钥录入（四通道）

`private_key_path`（text，binding config）与 `private_key`（textarea，binding secret）是同一份凭据的两个槽位。表单提供四条录入通道，落到这两个槽位上：

| 通道 | 宿主能力 | 落点 | 适用部署 |
| --- | --- | --- | --- |
| 手工输入 | 普通 `text` 字段（**刻意不声明 `options_action`**） | `private_key_path` | 全部 |
| 建议下拉 | 宿主内置本地密钥建议器（字段 key 恰为 `private_key_path`，`list_local_ssh_keys`） | `private_key_path` | 桌面 |
| 文件选择 | `picker: { "kind": "file", "content_field": "private_key" }`（Host API 1.1） | 桌面：`private_key_path`；Web/Docker：`private_key` | 桌面与 Web/Docker |
| 粘贴内容 | 无（普通 textarea） | `private_key` | 全部 |

- **为什么不声明 `options_action`**：宿主对声明了它的字段渲染成**纯下拉**（`selectOptionsFor()` 优先于文本框），既与宿主自身隧道密钥字段（输入框 + 浏览按钮）不一致，也让"发现列表里没有的密钥"（U 盘、导出到 `/tmp` 的临时密钥、非 `~/.ssh` 目录）无法录入。`keys/discover/options` RPC 仍保留（`label` 即路径本身，避免下拉被算法/指纹撑长），宿主或其它集成方需要时自行渲染。
- 桌面宿主打开原生对话框，把**绝对路径**写回 `private_key_path`（sidecar 与用户同机，自己读文件）；浏览器宿主（dbx-web / Docker）拿不到客户端路径，同一个按钮变成上传：DBX 读取文件内容（上限 1 MiB）写入 `private_key` 并清空路径。
- 两个槽位互斥：任一方写入会清空另一方，保存时对应地从 `external_config` / `connection_secrets` 删除。sidecar 侧 `private_key` 内容优先于路径（`resolve_private_key_text`），两条通道共用同一套解析（OpenSSH/PEM/PPK，CRLF 归一化）。
- 刻意不声明 `picker.accept`：私钥常见名为 `id_rsa` / `id_ed25519`（无扩展名），原生对话框的扩展名过滤会把它们置灰、而不是列出来。
- **兼容性**：`picker` 是新增字段属性，而宿主 manifest 解析器带 `deny_unknown_fields`——不认识该属性的宿主会拒绝整份 manifest，且解析失败先于版本检查发生，因此版本下限只能声明事实、挡不住旧宿主。DBX **0.6.16 是首个带该能力的发行版**（0.6.15 及更早的 `PluginFormFieldDefinition` 没有 `picker`），本 manifest 的 `engines.dbx` 因此固定为 `>=0.6.16`，只允许上移（`scripts/connection-forms/verify.mjs` 断言）。用 `host_api` 无法门控该能力：`SUPPORTED_PLUGIN_HOST_API_VERSION` 在 picker 之前就已是 `1.1.0`。
- **数据位置**：走上传通道时私钥内容会被复制到 DBX 服务端（容器）的连接密钥库（`plugin_connection.private_key`）；桌面端只记录路径，不复制密钥。

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
（分片循环在两分片之间挂起），不涉及新方法。本地落盘下载（`saveToLocal: true`）不支持续传——与
`offset > 0` 组合直接报错 `Local save downloads cannot resume from an offset`（2026-09-26 审计补记，
此前该错误语义未入文档）。

### 递归目录下载（sftp/download/tree/start）

纯 SFTP 递归下载一个远端目录，**不依赖远端 shell、不在远端产生临时打包文件**。参数
`{ sessionId, remotePath, downloadDir? }`（`downloadDir` 为本机绝对目录，缺省用偏好下载目录）。
`start` 先做远端 BFS 扫描（`read_dir`，有界：≤50 000 文件、≤10 000 目录、深度 ≤64，超限整体报错
而不静默截断），随后创建本地根目录并镜像全部子目录（**空目录也保留**）。返回
`{ taskId, fileName, size, chunkSize, fileCount, dirCount, skippedCount }`，其中 `size` 是整树
字节总量（聚合进度的分母）。

**文件名编码（M15-B，M16 起判定走连接级优先级）**：生效编码为 `latin-1`（全局偏好或本连接覆盖，见 `local/preferences` 行）时远端遍历改走裸包 READDIR（同一
通道内 LSTAT 根预检 + 递归），整树路径字节保真——远端文件路径用 wire 转义形式（分块下载按
转义自动走 raw READ——该车道 M19.5 才真正落地，此前转义名的逐文件读取会以 NO_SUCH_FILE
记失败跳过、本地只剩空目录骨架），本地落盘名（含根目录名）用 latin-1 解码的显示名；symlink/特殊条目同样
跳过不跟随，容量上限与容错语义不变。裸包通道建立失败自动回退高层遍历（只读，安全）。`auto`
模式行为完全不变。

之后**复用现有单文件分块管线**：`sftp/download/next` 按序逐文件传输（文件完成即把暂存 `.part`
改名落位并接续下一文件，调用方循环写法与普通下载完全一致），`next_offset` 语义为整树聚合字节
位置；队列耗尽后 `next` 返回空 `eof` 块（零字节树由此完成，调用方须循环到 `eof` 而非字节数）。
`sftp/download/finish` 返回
`{ success, taskId, localPath, fileCount, failedCount, skippedCount, failedFiles: [{ path, error }] }`
（`failedFiles` 内联上限 50 条，完整计数始终随行）。`sftp/transfer/progress` 事件为聚合进度，
树任务额外携带 `fileCount`/`fileIndex`/`currentFile`。

语义约定：

- **符号链接与特殊条目默认跳过**（永不跟随，防环），计入 `skippedCount`。
- **容错**：单个文件/子目录读取失败只记入失败汇总并继续；整树完成时任务状态仍为 `completed`
  并携带 `failedCount`，由工作台提示「N 个文件失败」。
- **同名冲突**：根目录名按单文件下载同一让位策略（` " (n)"`）在 start 时定名；目录下载无
  「覆盖」语义。
- **路径防护**：服务端返回的每个路径分量都经文件名消毒（`.`/`..`/分隔符/控制字符中和），落盘
  前再校验最终路径必须仍在本任务下载根之下。
- **取消/未完成**：`sftp/transfer/cancel` 或未传完即 `finish` 时**整棵半成品目录删除**（根目录是
  本任务新建的让位目录，删除不伤及既有文件）；部分成功（`failedCount > 0`）的完成结果保留。
- 仅桌面本机落盘模式可用（`local/capabilities.canSaveLocal`）；web/docker 无本地文件系统时工作台
  直接提示不可用。单个文件大小仍受 16 GiB 传输上限约束，超限文件记为失败而非中断。

### 外部编辑器 watcher（watch/start、watch/stop、watch/stop-all、watch/upload）

SFTP「用外部编辑器打开」的回写链（M15 立项，M20/M21 真容器收口；实现 `backend/src/file_watch.rs`）。
前端先把远端文件经 `sftp/download/start` 带 `downloadDir=<下载目录>/remote-edit/<时间戳>/` 落盘，
打开 OS 默认应用后调 `watch/start` 登记监听；编辑器保存且 sidecar 确认内容真变后发
`watch/file-modified` 事件，工作台弹确认并由 `watch/upload` 把当前磁盘字节推回远端。

- `watch/start {sessionId, remotePath, localPath}` → `{watchId}`。仅桌面端（本地下载能力缺失直接拒绝，
  web/docker 无本机文件系统语义）；`localPath` 必须是插件自身 `remote-edit/` 下载目录之下、经
  canonicalize 校验的既有普通文件——路径来源门禁（watchId 是持有即可用的令牌，任意本机路径绝不可
  监听、更不可经回写推到远端）。同一 `{sessionId, canonical localPath}` 重复登记时旧 watcher 先拆、
  以新快照为基线。指纹上限 64 MiB：登记时文件超过该值即拒绝（无法建立基线）；监听期间文件长过
  该值则快照不可判、不发事件。
- 事件判定：notify 事件 500ms 防抖合并；`start` 后 2s 启动抑制窗（编辑器预热噪音直接丢弃，不入队
  不延迟）；基线指纹（len+mtime 预滤 + SHA-256 权威比对）确认字节真变才发
  `watch/file-modified {watchId, sessionId, localPath, remotePath}`（不含文件内容）；发出后的状态
  成为新基线——同内容重复保存不再触发。文件消失或所属会话死亡时 watcher 自清理；
  `ssh/session/close` 回收该会话的全部 watcher。
- `watch/stop {watchId}` → `{success}`，未知 id 报 `Watch was not found`；`watch/stop-all {sessionId}`
  → `{success, stopped}`（移除数量）。
- `watch/upload {watchId}` → `{remotePath, size}`：sidecar 重新校验路径来源（防 start 后本地路径被
  符号链接调包）后读取当前字节（≤64 MiB，整文件读入内存做单次原子提交，超限拒绝且不启动读取），
  按 `sftp/write` 同款「`.dbx-part` 暂存 → 原子 rename、权限位保留」落回远端；只读门禁
  `ensure_writable` 与其他 SFTP 写一致。latin-1 连接按 watch 所属连接的编码判定整条 wire 还原后
  走裸包字节保真回写（M21）。

### sudo 下载（DownloadSudo）

root 权限的大文件二进制下载（M14-C，对标 tiny-rdm DownloadSudo），补齐「sudo/readFile 退化下载
受 exec+base64 包尺寸限制」的缺口。**方案取舍**：选用**远端临时文件**方案——`sudo/download/start`
把源文件经 sudo 编排（密码/2FA/白名单/只读拒绝与 sudo 族完全一致）拷进远端临时件，再把临时件登记
进下载注册表；`sftp/download/next`、`sftp/download/finish`、`sftp/transfer/progress` 事件与传输面板
**全部原样复用**。备选的 `sudo dd` 逐块流式方案被否：exec 输出通道无二进制边界、无 seek/续传、每块
都要过密码编排，且需要为下载族另建一整套分块/进度/取消管线。

- `sudo/download/start`：参数 `{ sessionId, path, saveToLocal?, downloadDir?, conflict? }`——参数名
  沿用 sudo 族的 `path`；`saveToLocal`/`downloadDir`/`conflict` 语义与 `sftp/download/start` 完全一致。
  返回 `{ taskId, fileName, size, chunkSize, resumeOffset, saveToLocal, sudo: true }`（`fileName` 为
  **源文件名**而非临时件名）。无独立 `status` 方法（对齐下载先例：进度经 `sftp/transfer/progress`
  事件与 `sftp/transfer/list`/`history` 查询）。
- **暂存流程**：sudo `stat` 校验源为普通文件并取 size → plain exec `id -u` 取登录用户 uid →
  `mktemp` 在**源文件同目录**创建 `.dbx-sudo-dl-XXXXXXXX`（同文件系统：空间语义与源一致，避开 /tmp
  常见 tmpfs——大文件拷贝会吃内存）→ `chown <uid>` + `chmod 600`（SFTP 会话以登录用户读临时件；
  0600 + 用户属主仍然只有该用户可读，不会出现 root 临时件全局可读的窗口）→ sudo `cat src > tmp` →
  sudo `stat` 校验临时件与源**等大**（ENOSPC/中断在这里暴露）→ SFTP `metadata` 提前探测登录用户
  可读（源目录不可穿越——如 `/root` 0700——时给出明确错误而非首块分块才失败）。
- **限制**：拷贝走一次阻塞 exec，受 5–300s 超时夹取（超时/失败即清理报错）；单个文件仍受 16 GiB
  传输上限；暂存期间远端需要与源等量的临时空间。
- **清理（finally 语义）**：完成、失败（未传完即 finish）、取消（`sftp/transfer/cancel` 或
  `sudo/download/cancel`）、注册失败、会话关闭五条路径都 best-effort sudo `rm -f` 临时件；清理失败
  不吞掉原结果——成功响应附加 `warning` 字段、其余路径落 sidecar stderr。清理命令有命名空间防护：
  只允许删除最终文件名以 `.dbx-sudo-dl-` 为前缀的路径。
- `sudo/download/cancel`：参数 `{ taskId, reason? }`，与 `sftp/transfer/cancel` 同构（任务住同一个
  传输注册表；reason slug 语义相同）。前端取消路径走 `sftp/transfer/cancel`，效果一致。

### ssh/metrics/history

参数 `{ sessionId, limit? }`（默认/上限 720）。返回 `{ connectionId, samples: [...] }`，样本旧→新排列，
每行 `{ connectionId, ts, cpuPercent?, memoryPercent?, load1?, rxRate, txRate }`（时间戳 Unix 毫秒）。
落盘为 `<data_dir>/metrics-history.jsonl`，每次**新鲜** `ssh/metrics` 采集追加一行（缓存命中不落），
环形上限 720 行（≈5s 轮询 × 1h）；行按连接 id 维度过滤读取，跨 sidecar 重启保留；坏行跳过。
`cpuPercent`/`memoryPercent` 快照缺失时整键省略（非 null 占位）。

### ssh/processes/list、ssh/processes/kill

`ssh/processes/list`：参数 `{ sessionId }`。单条只读命令：`ps` 段
`ps -eo pid=,ppid=,user=,pcpu=,pmem=,etime=,state=,args= | sort -k3,3nr | head -n 500` 采集，
其后追加三段 best-effort 段（同一命令内完成）：`--fds--`（纯 shell 内建遍历
`/proc/<pid>/fd` 计数，无可读权限的目录跳过）、`--sock--`（`find -lname/-printf` 枚举
`/proc/<pid>/fd/*` 中指向 socket 的符号链接，单次 spawn，映射全在解析端完成）、
`--netp--`（`cat /proc/net/tcp /proc/net/tcp6` 原始 dump，解析端只取监听态 `0A`）。
返回 `{ processes: [{ pid, ppid, user, cpuPercent, memPercent, etime, state, command, fdCount, listenPorts }] }`
（CPU 降序、服务端封顶 500 行、`command` 截断 200 字符；前端可本地重排）。
`fdCount`（打开句柄数）与 `listenPorts`（该 pid 拥有的监听 TCP 端口，去重升序、上限 16 个，
由 fd 符号链接 inode 与 `/proc/net/tcp{,6}` inode 匹配得到）为 best-effort 扩展字段：
取不到（非 root 下的其他用户进程、macOS/BSD 无 procfs、busybox find 不支持 `-printf`）
时 `fdCount` 为 `null`、`listenPorts` 为空数组，调用方按占位符展示，不要当 0。
全程只读、无 sudo 降级；不进 MCP 工具面。

`ssh/processes/kill`：参数 `{ sessionId, pid, signal? }`（默认 15）。后端校验：pid 为正整数且
`> 1`（init/pid 0 直接拒绝），signal 仅接受 `1/2/9/15`；渲染为 `kill -<NAME> <pid>`（数值全部白名单化，
无注入面）。返回 `{ success: true, pid }`；远端退出码非 0 报错（如进程不存在）。

### ssh/recording/start、stop、list、get、delete、search

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

`ssh/recording/search`（M14）参数 `{ query }` → `{ recordings: [{ recordingId, sessionId,
connectionId, host, startedAt, durationSecs, bytes, nameMatch, hits: [{ time, excerpt }] }] }`：
无持久索引，对现存 `.cast` 即时扫描（上限 200 个录制、每录制最多 5 条命中，excerpt 以
ANSI/OSC 剥离 + 换行压平后的单行文本截取约 120 字符、命中词完整保留）。命中 = 名称命中
（`host`/`recordingId` 包含查询词，大小写不敏感，`nameMatch: true`、`hits` 可为空）或内容命中
（stdout 展平文本包含查询词）。空查询返回空集（前端显示未过滤列表）；新→旧排序同 `list`。

会话自动录制（M14）：偏好键 `auto_record`（`local/preferences/set` 白名单布尔，默认关），
sidecar 启动与偏好写入时同步进程内快速标志（同 `x11_forwarding` 模式）；`ssh/session/open`
按该标志对每个新会话自动挂录制器（只读连接不禁用——录制是被动输出捕获），已有录制进行中
则跳过。两种情形均经事件 `ssh/recording/auto` 提示一次，负载 `{ sessionId, recordingId? }` 或
`{ sessionId, skipped: true }`，只含 id 不含内容。Transcript 纯文本导出在前端完成（复用
`ssh/recording/get` 分页 + 既有保存桥，ANSI 剥离/时间戳拼接为纯前端逻辑），不新增协议面。
