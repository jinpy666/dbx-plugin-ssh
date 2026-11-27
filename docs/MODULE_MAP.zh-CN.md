# 模块地图与边界

本文回答三个问题：**代码分成哪些模块、每个模块负责什么、改一处会牵动哪里**。
所有数字都在 base `f5052f8` 的工作树上用 `wc -l` / `grep` 实测（复核命令见
[附录](#附录复核命令)），不是估算。RPC 方法名以
[PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md) 为准；能力对标与「是否已实现」以
[FEATURE_PARITY.zh-CN.md](FEATURE_PARITY.zh-CN.md) 和代码为准。

> 阅读顺序建议：先看 §1 的进程边界，再看 §2/§3 找模块，最后看 §5「边界现状」和
> §6「改动时先看这里」。日常改代码不需要通读全文。

## 1. 进程与运行时边界

```
DBX 宿主进程
├── 连接/凭据存储 · 设置 · 主题 · MCP 桥(dbx-mcp) · host.storage · host.ai
├── webview（iframe，opaque origin）
│     ui/ bundle：main.ts → App.vue | TunnelManager.vue | MonitorPanel.vue
│     window.dbxPlugin：invoke(RPC) · binary 通道 · openWorkbench · host.*
└── lifecycle 注入 ↓                    ↑ 事件回传（PluginEmitter）
                │
                │ stdio 分帧：JSON 帧 ≤ 8 MiB / binary 帧 ≤ 64 MiB
                ▼
bin/dbx-plugin-ssh（Rust sidecar，插件级单进程，所有连接共享）
├── main.rs：206 个分发臂 / 209 个方法名，事件回推宿主
├── SshRuntime：SSH 传输、会话池、终端 I/O、端口映射、SFTP 与传输
├── Telnet · VNC · RDP · Serial · Local PTY：各自独立会话表
├── monitor · metrics · docker · recording · audit · tasks · MCP
└── 状态一律以 connectionId / sessionId / taskId 为键
                │
   ┌────────────┼──────────────┬───────────────┬──────────────┐
   ▼            ▼              ▼               ▼              ▼
SSH 服务器   Telnet/VNC/RDP   串口设备        本机 shell     外部 CLI
(russh,      (TCP 直连，      (sidecar 所在机 (PTY，sidecar   (docker/podman,
 direct-tcpip) 不经 SSH)       的 /dev/tty*)   所在机)        sh -s 脚本)
```

三条边界事实：

1. **前端不持有凭据**。连接表单提交给宿主，宿主以 lifecycle payload 注入 sidecar；
   前端只能拿到 `connectionId`/`sessionId` 并透传（PROTOCOL「生命周期与状态隔离」）。
2. **sidecar 是唯一权威**。会话、传输、sudo 保活、监控流、录制都在 sidecar 内存或
   `<data_dir>` 里；前端的 UI 偏好走宿主 `host.storage`（`pluginStore`），与 sidecar
   的 `preferences.json` 是两套存储，键名不同、部分键刻意镜像（见 §5.3）。
3. **sidecar 也可脱离宿主运行**：`dbx-plugin-ssh --mcp` 以 MCP stdio 模式直接服务
   AI 客户端（`backend/src/mcp.rs`、`app_bridge.rs`、`proxy.rs`），此时没有 webview。

## 2. 后端模块（`backend/src`，144 个 `.rs`，106,432 行）

### 2.1 入口、分发与模型

| 模块（行数） | 职责（一句话） | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `main.rs` (3,404) | RPC 分发、二进制通道路由、事件发射、插件生命周期 | `impl PluginHandler for Plugin`；`mock_host_registry_check.mjs` 校验 199 名方法（含别名）；`ssh/terminal/in/{id}`、`docker/logs/out/{id}` 等二进制前缀 | 几乎所有模块 |
| `model.rs` (3,429) | 连接/任务参数模型、字段校验与钳制、跳板链解析 | `ConnectionConfig`、`JumpHost`、`clamp_terminal_keepalive` | serde、`keys` |
| `preferences.rs` (1,651) | 工作台偏好白名单读写（`preferences.json`） | `local/preferences/get` / `local/preferences/set` 的存储面 | `model` |
| `app_bridge.rs` (403) | 独立 MCP 模式连接 DBX app 的本地 TCP 桥 | `--mcp` 模式客户端 | std::net |
| `job_object.rs` | Windows Job Object 子进程回收（仅 `cfg(windows)`） | 进程退出清理 | Win32 |

### 2.2 SSH 核心与远程执行

| 模块（行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `ssh.rs` (256) + `ssh/` 子树（43 文件，18,415 行） | SSH 拨号/认证/known_hosts、连接注册表与会话池、PTY I/O 与回放、端口映射、SFTP 与传输引擎；根只留 `SshRuntime` 定义、`set_directory_tracking`、模块声明与再导出（见 §2.2.1） | `SshRuntime::{open_session, attach_session, write_terminal, replay_terminal, resize_terminal, batch_terminal_input, forward_start, forward_stop, sftp_*}` | russh、`keys`、`host_key`、`sftp_raw`、`sftp_ext`、`exec`、`forward`、`transfer_*` |
| `keys.rs` (706) | 本机私钥发现、OpenSSH/PEM/PPK 头校验、口令探测 | `keys/discover` | ssh-key |
| `host_key.rs` (548) | 主机密钥指纹、known_hosts 判定 | `ssh/host-key/resolve`、`ssh/knownHosts/*` | ssh-key |
| `ssh_algorithms.rs` | 握手算法集合（现代默认在前，旧算法尾附） | `SshRuntime` 握手配置 | russh |
| `vault.rs` (513) | 字段级 AES-256-GCM 密封（Quick Sudo 的密码与 TOTP 密钥） | `seal` / `open` | aes-gcm |
| `exec.rs` (4,777) | 远程命令 + Quick Sudo 编排、进程列表/终止 | `ssh/exec`、`ssh/exec/cancel`、`ssh/processes/list`、`ssh/processes/kill` | `ssh.rs` |
| `forward.rs` (1,219) | `-L`/`-R`/`-D` 规格校验、监听与流量统计 | `ssh/forward/start` / `stop` / `list` / `interfaces` | `ssh.rs` |
| `tunnel_menu.rs` | 保存的端口映射 → 宿主动态菜单、批量启停 | `contextMenu/manage-tunnels` | `forward`、宿主 `ui-storage.json` |
| `proxy.rs` (336) | MCP 内联拨号的 SOCKS5 / HTTP CONNECT | `socksProxy` / `httpProxy` 参数 | tokio-socks |
| `x11.rs` (1,024) | X11 转发（MVP，偏好 `x11_forwarding` 开关） | `server_channel_open_x11` 桥接 | `ssh.rs` |

### 2.3 SFTP、传输与本地文件

| 模块（行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `sftp_raw.rs` (1,784) | SFTP 低层读写/列目录原语与兼容处理 | `sftp/list`、`sftp/read`、`sftp/write` 的底层 | russh-sftp |
| `sftp_ext.rs` (1,966) | 扩展文件操作（stat/touch/archive/extract） | `sftp/stat`、`sftp/exists`、`sftp/touch`、`sftp/archive`、`sftp/extract` | `sftp_raw` |
| `sftp_copy.rs` (716) | 远端复制/移动（跨目录、原子提交） | `sftp/copy`、`sftp/move` | `sftp_raw` |
| `sftp_name.rs` (421) | 文件名编码（`auto` / `latin-1`）与覆盖规则 | `sftp/list` 响应 | encoding_rs |
| `sftp_tree.rs` (377) | 递归目录树扫描 | `sftp/download/tree/start` | `ssh.rs` |
| `sftp_bookmarks.rs` (373) | SFTP 书签存储 | `sftp/bookmarks/list\|save\|delete` | 文件存储 |
| `sudo_fs.rs` (848) | root 文件操作族（stat/list/read/write/mkdir/remove/chmod/rename） | `sudo/stat\|listDir\|readFile\|writeFile\|mkdir\|remove\|removeAll\|chmod\|rename` | `exec.rs` |
| `sudo_download.rs` (333) | sudo 下载的独立分块车道 | `sudo/download/start\|cancel` | 下载管线 |
| `sudo_profiles.rs` (968) | 全局 Quick Sudo 配置（密钥密封、不回显） | `sudo/profiles/list\|options\|reveal\|save\|delete` | `vault` |
| `sudo_allowlist.rs` | 每连接 sudo 命令白名单 | 表单 `sudo_whitelist` | — |
| `transfer_compress.rs` (832)、`lzpack.rs` (674) | 压缩传输决策矩阵与 `.dbxz` 显式打包 | `sftp/upload/start`、`sftp/download/start` 的 `compression` | flate2 |
| `transfer_multistream.rs` (359)、`transfer_throttle.rs`、`progress_throttle.rs` | 多流下载、下载限速、进度事件节流 | 下载分块循环 | — |
| `transfer_history.rs` (356) | 传输历史 JSONL | `sftp/transfer/history` | 文件存储 |
| `transfer_schedule.rs` (526) | 传输模型/压缩策略的纯计算（当前 `auto` 恒选 direct） | `decide` | — |
| `file_watch.rs` (1,344) | 外部编辑器 watcher 与保存回写 | `watch/start\|stop\|stop-all\|upload` | notify |
| `local_fs.rs` (755)、`local_downloads.rs` (614)、`local_editors.rs` (869) | 本机文件浏览、下载落盘、编辑器发现/打开 | `local/fs/browse\|drives\|exists`、`local/saveFile`、`local/reveal`、`local/open`、`local/editors/list`、`local/open-with` | std::fs |

#### 2.2.1 `ssh/` 子树（43 文件，18,415 行）

生产文件全部在 600 行预算内；例外只有两个「单函数冻结」文件（`open_session.rs` 883、`upload_finish.rs` 661）
与测试文件（`tests.rs` 4,475、`channel_error_tests.rs` 25），三者在 `structure_tests.rs` 的允许清单里登记。
纯搬移批次逐符号校验过（函数体/签名/文档注释零改动，只允许 `pub(super)` 最小提升），字面量多重集前后一致。

| 分组 | 文件（行数） |
| --- | --- |
| 拨号与认证 | `ssh_client` 415（`SshClient` + handler）、`auth` 578（自动/密码/键盘交互）、`auth_key` 346（私钥文本规范化）、`auth_dial` 248、`probe` 232、`host_key_support` 90、`keepalive` 104 |
| 会话与终端 | `open_session` 883（单函数）、`lifecycle` 199、`terminal` 412、`terminal_stream` 439、`port_forward` 381、`prompt` 388、`state` 461、`transport` 73、`leases` 75、`endpoint` 65 |
| 执行、审批与配置 | `exec_methods` 371、`approval` 329、`agent_auth` 193、`sudo_support` 247、`settings` 527 |
| 上传与传输登记 | `upload` 408、`upload_finish` 661（单函数）、`upload_compress` 229、`upload_meta` 167、`transfer_registry` 498、`transfer_paths` 203 |
| 下载 | `download_sudo` 186、`download_lzpack` 538、`download_start` 294、`download_prep` 458、`tree_download` 570、`tree_chunk` 320、`download_chunk` 373、`download_complete` 450、`tree_fs` 380 |
| SFTP 与监控 | `sftp_session` 234、`sftp_ops` 466、`sftp_helpers` 289、`monitor` 135 |
| 测试 | `tests` 4,475、`channel_error_tests` 25 |

### 2.4 非 SSH 会话

| 模块（行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `telnet_session.rs` (1,839) | Telnet 客户端（RFC 854/855 子集、NAWS、自动登录复用 expect 引擎） | `telnet/start\|write\|resize\|replay\|close\|list` | `triggers` |
| `vnc_session.rs` (1,508) | VNC/RFB 6143 客户端（ZRLE/Raw、剪贴板） | `vnc/start\|input\|write\|resize\|reconnect\|set-clipboard\|close\|replay\|list` | vnc-rs |
| `rdp/`（11 文件；`session.rs` 1,024、`cert.rs` 436、`tests.rs` 1,197） | RDP 客户端（vendored IronRDP 链、NLA/CredSSP、文本剪贴板） | `rdp/start\|input\|write\|resize\|set-clipboard\|reconnect\|certificate/resolve\|close\|replay\|list` | `backend/vendor/ironrdp*` |
| `serial_session.rs` (1,574) | 串口会话（RS-232，阻塞读线程 + 写锁） | `serial/ports/list`、`serial/start`、`serial/write`、`serial/close`、`serial/list`、`serial/replay` | serialport |
| `serial_xmodem.rs` (2,172) | 串口 X/Y/ZMODEM 上传状态机 | `serial/upload/start\|data\|cancel` | — |
| `local_terminal.rs` (2,826) | 本机 shell（portable-pty）+ shell integration 注入 | `local/terminal/start\|resize\|replay\|launch-options`、`local/shells/list`、`local/session/*` | portable-pty |
| `shell_integration/*` | zsh/bash/fish/pwsh 注入脚本与包装器 | 本地终端启动时注入 | — |

### 2.5 监控、运维与记录

| 模块（行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `monitor.rs` (1,516) | 常驻流式监控（每连接一条长 exec，Linux `/proc`） | `monitor/start\|stop\|status\|snapshot\|details` | `ssh.rs` |
| `metrics.rs` (1,476) | 一次性服务器指标（Linux `/proc` + macOS sysctl 回退） | `ssh/metrics` | `exec.rs` |
| `metrics_gpu.rs` (836) | NVIDIA GPU / Ascend NPU 概览，并入 `ssh/metrics` | `ssh/metrics` 的 `gpu`/`npu` 键 | 远端 CLI |
| `metrics_history.rs` | 指标趋势 JSONL | `ssh/metrics/history` | 文件存储 |
| `docker/` 模块树（root 94；engine 167 / scripts 224 / parse 266 / local 263 / rpc 881 / stats 579 / logs_batch 263 + logs_stream 462 + streams 326 / files 472 + files_write 485 / terminal 308 + terminal_io 396 + terminal_registry 390 / tests 1,112 + files_tests 307 + files_write_tests 411 + terminal_tests 224） | Docker/Podman 面板（CLI + `sh -s`/cmd 脚本，动作白名单；stats 只读批量采样；files 只读浏览/预览与原子写/删除；日志流 `logs -f` + 64 KiB/100 ms 聚合 + TTL/墓碑/子进程回收；容器终端 `exec -it` PTY，密码永不进 PTY）；脚本体恒为常量、id/路径只作位置参数；`rpc.rs` 承接原 `main.rs` 的分派臂实现，`main.rs` 只留字面量臂（`mock_host_registry_check.mjs` 只扫 `main.rs`） | `docker/list`、`docker/logs`、`docker/action`、`docker/stats`、`docker/logs/stream/start\|stop`、`docker/files/list\|read\|write\|delete`、`docker/terminal/open\|close\|resize\|replay` | `exec.rs`、`audit_log`、`model.rs`（TerminalFrame） |
| `audit_log.rs` (869) | 追加式执行审计 `audit-log.jsonl` | `ssh/audit/list`、`ssh/audit/clear` | 文件存储 |
| `alert_triage.rs` (801) | 告警归一化 + 关键词分类 + 只读诊断命令（无 LLM） | `ssh/alert/triage` | `metrics` 脚本 |
| `session_recording.rs` (794) | 会话输出录制为 asciicast v2 `.cast` | `ssh/recording/start\|stop\|list\|get\|delete\|clear\|search\|reveal`；`local/recording/*` | 文件存储 |

### 2.6 自动化、智能体与辅助

| 模块（行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `mcp.rs` (9,266) | MCP stdio 服务器 + 工具目录（16 个）+ 桥调用 | `--mcp`、`mcp/tools`、`mcp/call`、`mcp/settings/*` | `mcp_safety`、`proxy`、`app_bridge`、`exec`、SFTP |
| `mcp_safety.rs` (1,509) | 只读门、灾难命令确认、`connectionScope`、权限档 | 供 `mcp.rs` 与 `ssh/exec` 复用 | — |
| `agent_terminal.rs` (834) | AI 智能体在交互终端内同步执行的路由/捕获/净化 | `ssh/agent/mode/get`、`ssh/settings/*` 的 `agentTerminalMode` | `exec.rs` |
| `agent_approvals.rs` (431) | 每连接「记住的审批」存储 | 智能体执行前查询 | 文件存储 |
| `task_provider.rs` (2,709) | 调度器 Task Provider（`task/*` 固定 RPC） | `task/validate\|execute\|start\|stop\|status` | `ssh.rs`、`local_target` |
| `completion/`（6 文件） | FIG 补全 generator 的 sidecar 执行端与安全裁剪 | `completion/execute` | `exec.rs`、`completion/security.rs` |
| `triggers.rs` (2,229) | 自动应答 / Expect 引擎（SSH、Telnet 自动登录、sudo 提示共用） | `triggers/validate`；会话内规则 | `otp` |
| `startup_commands.rs` (525) | 登录启动命令（Login scripts 对标）：校验、计划与注入 | `local/preferences/*` 的 `startup_commands` 键；`ssh/session/open` 时注入 | `preferences`、`ssh.rs` |
| `otp.rs` (499)、`otp_store.rs` (1,029) | TOTP/HOTP 计算、OTP 条目/绑定持久化、QR 解析 | `otp/list\|save\|delete\|bind\|unbind\|generate\|import-qr` | `vault`（字段级加密） |
| `connection_import.rs` (4,545) | 8 种第三方会话来源解析 + 脱敏导出 | `import/preview/start\|finish\|cancel` + 二进制通道 | 无外部依赖 |
| `quick_commands.rs` (590)、`highlight_rules.rs` (590) | 全局快速命令/高亮规则的 sidecar 存储（现仅作首启种子） | `ssh/quickCommands/*`、`ssh/highlightRules/*` | 文件存储 |
| `non_ssh_credentials.rs` | 非 SSH（telnet/vnc/rdp）凭据的内存暂存（`Zeroizing`） | `connection/connect` 非 SSH 分支 | `model` |
| `multi_exec.rs` | `ssh_multi_exec` 纯逻辑（目标去重/上限/命令门禁） | `ssh_multi_exec` 工具 | — |
| `zmodem_detect.rs` | SSH PTY 输出上的 ZRQINIT 边沿检测（不改字节） | 会话输出泵 | — |

## 3. 前端模块（`frontend/src`，559 文件，106,345 行；其中测试 227 文件 / 30,137 行）

表中路径均相对 `frontend/src/`（另注明的除外）。

| 模块（产物行数） | 职责 | 关键入口 | 依赖 |
| --- | --- | --- | --- |
| `App.vue` (12,560) | 工作台根组件：工具条/会话菜单/布局、xterm 生命周期与加固、SFTP 与传输编排、跨面板状态 | 全部 RPC 调用点；挂载各 dialog/panel | `composables`、`lib`、`components`、`rdp` |
| `main.ts` (140) | 启动：`pluginStore` 水合 → 装主题桥 → 按 contribution 挂 3 个根之一 | `dbx-plugin-init` 事件、`host.context` | `shared/frontend/themeSync`、`lib/pluginContext` |
| `TunnelManager.vue` (78) | 端口映射工作台根（同时服务 `presentation: "dialog"` 的右键入口） | `ssh/forward/*` | `components/ui/dialog` |
| `components/`（43 个 `.vue`；13,786 行） | 面板与对话框（设置、SFTP 预览、Docker、监控、OTP、导入、搜索…） | 见 §3.1 | `lib`、`composables`、`ui` |
| `components/ui/`（10 组，1,111 行） | reka-ui/shadcn 风格基础原语（dialog/select/table/tabs…） | — | reka-ui |
| `composables/`（44 个，11,387 行） | 有状态 UI 流程（分屏、传输队列、上传链、SFTP 下载/预览、ZMODEM/trzsz、监控编排、录制…） | `useSplitPanes`、`useTransferQueue`、`useUploadChain`、`useSftpDownload`、`useZmodem`、`useTrzsz`、`useMonitorPanel`、`useMetricsPanel`、`useRecording`、`usePluginEvents` | `lib` |
| `lib/`（166 个生产 `.ts`，29,022 行） | 纯逻辑、协议镜像、解析、持久化门面 | `pluginStore`、`i18n`、`aiBridge`、`sftpEntries`、`downloadPrefs`、`keywordHighlight`、`previewResolver`、`terminalInput` | 少量 vue；不依赖 `App.vue` |
| `lib/completion/`（子目录，2,734 行） | 结构化补全（fig 语料、parser、worker、host 客户端） | `CompletionController`、`lib/completion/host/hostClient.ts` | `completion/execute` RPC |
| `rdp/`（1,318 行） | RDP 画布、帧解码、会话与工作台 | `useRdpSession`、`useRdpWorkbench`、`rdpFrame`、`RdpSurface` | `lib`、`components` |
| `styles/tailwind.css` (64) | Tailwind v4 入口（`style.css` 1,619 行为主题与组件样式） | — | tailwind |
| `mockDbxHost.ts` (2,191) | 浏览器/vitest 的宿主 + RPC mock（契约镜像） | `mockDbxHost.spec.ts` | 全部 RPC 契约 |

### 3.1 主要组件

| 组件 | 职责 | 关键行为 |
| --- | --- | --- |
| `SettingsDialog.vue` (2,876) | 13 个设置分类：appearance / scheme / terminal / suggestions / highlight / commands / ai / hotkeys / sudo / agent / transfer / security / mcp | 会话级分类（sudo/agent）对本地终端隐藏 |
| `DockerPanel.vue` (1,107) + `DockerLogsDrawer.vue` (327) + `DockerStatsBar.vue` (78) + `DockerFilesPane.vue` (365) + `DockerWorkbench.vue` (105) + `lib/dockerStats.ts` (224) + `lib/dockerFiles.ts` (182) + `lib/dockerLogStream.ts` (90) + `composables/useDockerStats.ts` (165) + `composables/useDockerLogStream.ts` (194) + `composables/useDockerOpenInTerminal.ts` (32) | 容器列表、启停/重启/删除、引擎设置（docker/podman、socket/host）、运行中容器的 CPU/内存/网络/IO/PIDs 指标条（3s 只读轮询，隐藏即停）、日志抽屉（只读 xterm 跟随流 + 快照降级）、容器文件工作台（只读 list/read + 文本预览）；日志抽屉与「在终端打开」已外抽 | 也可作为指标面板的 docker tab 内容 |
| `MonitorPanel.vue` (791) | 多主机监控卡片、分组、过滤（all/live/issues）、隐私模式 | 独立工作台；分组依赖宿主 `listConnections` 的 `groupId` |
| `MetricsPanel.vue` (490) | 单机会话指标：概览/进程/磁盘/网络/docker | 5s 刷新，GPU/NPU 卡片 |
| `PreviewPane.vue` (643) | SFTP 文件预览与编辑 | 文本 CodeMirror、图片、Office/PDF/媒体走 file-viewer |
| `OtpPanel.vue` (822) | OTP 条目管理、二维码导入、绑定连接、发送验证码 | TOTP/HOTP，单窗口防重放提示 |
| `ImportWizard.vue` | 会话导入 3 步：选源 → 解析 → 预览/脱敏导出 | 8 种来源、64 MiB 预算 |
| `SideNavPanel.vue` | SFTP 侧栏：树 / 快捷路径 / OTP / 导入 | tab 状态由 App 持久化 |
| `TerminalSearchPanel.vue`、`TerminalQuickSelectPanel.vue`、`TerminalHistoryPanel.vue` | 搜索、可视区快速选择、命令历史面板 | 均由 App 驱动 |
| `CommandSuggestions.vue`、`CompletionMenu.vue` | 历史/快速命令建议、结构化补全菜单 | 键盘语义在 `App.vue` |
| `SplitTerminalPane.vue`、`TerminalGutter.vue` | 分屏渲染、行号/时间戳 gutter | 分屏上限 3 |
| `PortForwardDialog.vue`、`DirTree.vue`、`VncSurface.vue`、`rdp/RdpSurface.vue` | 映射表单、目录树、VNC/RDP 画布 | 未带目录的组件名均位于 `components/` |

## 4. `shared/` 与 `scripts/`

`shared/` 是**跨插件公共层的唯一实现点**（ssh / files / ldap / kafka 共用），插件内
只允许相对引用，不允许各抄一份。

| 路径 | 作用 | 消费方 |
| --- | --- | --- |
| `shared/frontend/pluginStorage.ts` (236) | 宿主 `host.storage` → guarded localStorage → 内存三级回退 | `lib/pluginStore.ts` |
| `shared/frontend/themeSync.ts` (77) | 宿主主题令牌 → 插件 CSS 变量桥 | `main.ts` |
| `shared/frontend/hostThemeRuntime.ts` (114) | 宿主环境/主题订阅聚合 | `App.vue`、`useTerminalAppearance` |
| `shared/frontend/binaryEvent.ts` (29) | 宿主 binary 事件双形状归一化（`Uint8Array` / `dataBase64`） | `App.vue`（终端帧、上传/下载分块） |
| `shared/frontend/editorTheme.ts` (173) | CodeMirror 语法高亮调色板 | `TextPreview.vue` |
| `shared/prompt-corpus.json` (235) | 前后端提示词识别统一语料（防漂移） | `backend/src/exec.rs`、`lib/interactivePromptGuard.ts` |
| `shared/sdk/rust/dbx-plugin-sdk/src/lib.rs` (1,302) | sidecar SDK：分帧协议、事件发射、`host/requestUserInput` | `backend/src/*` |

`scripts/`（57 个条目）按用途分：

| 类别 | 代表文件 | 说明 |
| --- | --- | --- |
| 构建/打包/安装 | `build.sh`、`build.cmd`、`package_and_verify.sh`、`install.sh`、`install.cmd`、`verify_packaged_sdk.py` | 前端构建 + sidecar 编译 + `.dbxp` 打包；安装需人工执行 |
| 规范/一致性校验 | `validate_repo.py`、`check_vendor_lockstep.py`、`check_candidates.py`、`mock_host_registry_check.mjs`、`verify_rdp_vendor_integrity.py` | 仓库结构、vendor 版本锁步、mock 注册表 |
| 端到端冒烟（28 个 `smoke_*.py` + 3 个 `smoke_ui_*.mjs`） | `smoke_fs_test.py`、`smoke_sudo_otp_test.py`、`smoke_local_terminal.py`、`smoke_tunnel_menu.py`、`smoke_ui_settings.mjs` | 需要可控测试服务器/本机 mock 宿主 |
| E2E | `e2e_agent_terminal.py`、`e2e_agent_app_bridge.py` | 智能体终端与 app 桥 |
| 性能/压力 | `perf_baseline_test.py`、`terminal_burst_test.py` | SFTP 基准、终端洪峰 |
| 补全语料 | `sync_fig_specs.mjs`、`verify_fig_specs.mjs` | fig spec 同步/校验 |
| 测试基础设施 | `test.sh`、`sidecar_client.py`、`zmodem_receive_bridge.mjs`、`cargo_target_shim.sh`、`sdk_root_shim.sh` | 直接驱动 sidecar 的客户端 |

## 5. 边界现状（实测）

### 5.1 前端目录之间的导入关系

口径：只统计生产文件（排除 `*.spec.ts` / `*.test.ts`），解析 `from "…"` 相对路径并
映射到目录；同目录内部引用不计。数字是**导入边数**，不是文件数。

| 从 / 到 | `lib` | `composables` | `components` | `rdp` | 目录外（`shared/` 等） |
| --- | --- | --- | --- | --- | --- |
| `App.vue` / `main.ts` | 125 | 43 | 36 | 5 | 3 |
| `components/` | 139 | 5 | — | — | 1 |
| `composables/` | 163 | — | 2 | 1 | 2 |
| `lib/` | — | — | 1 | — | 3 |
| `rdp/` | 3 | — | 2 | — | — |

可直接读出的结构结论：

- **`lib` 是叶子层**：它几乎不反向依赖 UI（仅 1 条 `lib → components` 边），
  因此新增纯逻辑优先放 `lib`，可单测、不会把组件树拖进测试。
- **`App.vue` 是装配层**：125 条到 `lib`、43 条到 `composables`、36 条到
  `components`、5 条到 `rdp`。它不做底层实现，但把四层缝在一起。
- **`composables` 与 `components` 基本解耦**：`composables → components` 只有 2 条，
  `components → composables` 只有 5 条；两侧都主要依赖 `lib`。
- **跨插件公共层只有一个入口**：7 条生产 import 指向 `shared/frontend/*`（另有
  9 条 spec 断言），集中在 `pluginStore`、主题桥、`binaryEvent`、`editorTheme`。

### 5.2 已知单体与它们当前混合的职责

| 文件 | 行数 | 当前混合的职责（代码可验证） |
| --- | --- | --- |
| `backend/src/ssh/open_session.rs`、`ssh/upload_finish.rs` | **883 / 661** | 各是一个不可再拆的单函数：`open_session`（拨号 → 认证挑战 → 会话登记）与 `finish_upload`（续传收尾 → sudo 提交 → 压缩推送）。原先 18,457 行的 `ssh.rs` 已拆成根 256 + 43 个子模块，这两处是拆分后仅存的两个超预算生产文件 |
| `frontend/src/App.vue` | **12,543** | ① 工作台外壳（工具条、会话菜单、dock、布局持久化）；② xterm 生命周期与输入路由（搜索、zmodem/trzsz、ghost、高亮装饰）；③ SFTP 浏览 + 预览/编辑 + 传输队列/批量栏；④ 各面板（设置/OTP/导入/Docker/会话信息/告警/审计）的挂载与事件分发 |
| `frontend/src/lib/i18n.ts` | **10,764** | ① 7 个 locale 的全部文案数据（`en`/`es`/`it`/`ja`/`pt-BR`/`zh-CN`/`zh-TW`）；② 工作台消息表与 locale 解析/插值函数（`workbenchMessageTable`、`resolveWorkbenchLocale`、`workbenchMessage`） |
| `backend/src/mcp.rs` | 9,266 | ① MCP stdio 传输与初始化；② 16 个工具的 schema 目录；③ `mcp/call` 分派与工具实现（exec/SFTP/known_hosts）；④ 桥模式与独立模式的差异处理 |
| `frontend/src/components/SettingsDialog.vue` | 2,876 | 13 个设置分类的全部表单、校验、加载/保存与局部状态机集中在单文件 |
| `backend/src/exec.rs` | 4,777 | ① 普通远程 exec 与取消；② Quick Sudo 编排（密码注入、提示词应答、保活）；③ 进程列表与终止；④ metrics/docker/completion 复用的执行底座 |

> 拆分建议不是本文的范围；这里只记录「改一处要同时理解几件事」。例如改 SSH
> 终端输入语义，实际会碰到 `App.vue` 的输入路由 + `useSplitPanes` + `ssh.rs` 的
> `write_terminal`/`replay_terminal` + `main.rs` 的二进制前缀。

### 5.3 状态归属

| 状态 | 权威方 | 持久化位置 | 说明 |
| --- | --- | --- | --- |
| 连接配置与凭据 | DBX 宿主 | 宿主 secret store | sidecar 只在 `connection/connect` 时缓存到内存注册表 |
| 会话 / 传输 / 端口映射 | sidecar | 内存（传输 meta/spool 落 `<data_dir>/transfers`） | 端口映射不落盘，DBX 重启即失 |
| known_hosts | sidecar | `<data_dir>/known_hosts` | 不写系统 `~/.ssh/known_hosts` |
| 工作台偏好 | sidecar | `<data_dir>/preferences.json` | `local/preferences/*`，白名单键 |
| UI 偏好（面板形态/字体/历史条数…） | 宿主 | `host.storage`（`pluginStore`） | 见 `lib/pluginStore.ts` 顶部「明确不进 store 的键」清单 |
| 快速命令 / 高亮规则 | 宿主 | `host.storage` | sidecar `quick-commands.json` / `highlight-rules.json` 仅首启搬迁种子 |
| 录制 / 审计 / 指标历史 / 传输历史 | sidecar | `<data_dir>/recordings`、`audit-log.jsonl`、`metrics-history.jsonl` 等 | 用户可在 UI 里查看/删除 |
| OTP 条目与绑定 | sidecar | OTP store 文件（密钥密封） | 绑定按 `connectionId` |
| MCP 尺寸/传输根策略 | sidecar | 策略文件；可同步子集镜像进 `host.storage` | `mcp/settings/get\|set` |
| RDP 实验开关 / X11 开关 | sidecar | `preferences.json` | 前端开关写偏好，后端 `rdp/start`/X11 门控读取 |

### 5.4 文档与代码的已知偏差（实测）

这些偏差直接影响「读文档改代码」的准确性，列出以免踩坑：

1. **分发方法数**：`docs/FEATURE_PARITY.zh-CN.md` 写「184 臂 / 185 名」（2026-09-26
   收口值）；按附录命令实测当前 `backend/src/main.rs` 为 **211 臂 / 214 名**（含
   `vnc/write`、`rdp/write`、`connection/challenge/resolve` 这类别名合并）；
   `mock_host_registry_check.mjs` 按「方法名」口径报告 **193** 名（别名归并、且不含
   只在二进制/事件面出现的前缀），两者口径不同，不要互相换算。
2. **MCP 工具数**：`README.md` 写「31 个 MCP 工具」；`docs/PROTOCOL.zh-CN.md` 写
   「16 个」并提到「外部精简面 12 个」；当前 manifest `io.dbx.ssh.mcp` 与
   `mcp.rs` 的 `tool_definitions()` 都是 **16 个**，且 16 个都声明了 `access`。
3. **宿主安装下限**：`PROTOCOL.zh-CN.md` 写 `engines.dbx` 当前 `>=0.6.31`；manifest
   实测为 `>=0.6.59`。
4. **快速命令上限**：代码是 200（`lib/quickCommands.ts` 的
   `QUICK_COMMANDS_LIMIT`），但七语文案仍写「达到 20 条上限」
   （`quickCommandsImportPolicy`）。

## 6. 改动时先看这里

表中未写全路径的 `lib/…`、`components/…` 均相对 `frontend/src/`。

| 任务类型 | 先读/先改的文件 | 连带检查 |
| --- | --- | --- |
| 新增或改 RPC 方法 | `backend/src/main.rs` 分发表 → [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md) 对应节 → 前端 `invoke` 调用点 | 二进制通道前缀（`backend/src/main.rs` 从 2568 行起的 `strip_prefix` 分支）、`docs/AUDIT-PROTOCOL-IMPL.zh-CN.md` |
| 改连接表单字段 | `manifest.json` 的 `connection-provider.fields` → `backend/src/model.rs` → `frontend/src/lib/settingsModel.ts` | `localizations` 七语、`connection/protocol` 透传、`mockDbxHost.ts` |
| 终端输入/输出/回放 | `frontend/src/App.vue` 输入路由 → `lib/terminalInput.ts` → `backend/src/ssh.rs` 的 `write_terminal`/`replay_terminal` | `useSplitPanes.ts`、`lib/terminalZmodem.ts`、`lib/terminalTrzsz.ts`、帧序号缺口处理 |
| 分屏/镜像会话 | `frontend/src/composables/useSplitPanes.ts`、`frontend/src/components/SplitTerminalPane.vue` | `ssh/session/open` 的 `reuseAuthenticatedTransport`、`SPLIT_PANE_MAX` |
| SFTP 浏览/预览/编辑 | `frontend/src/composables/useSftp*.ts`、`lib/previewResolver.ts`、`frontend/src/components/PreviewPane.vue` | `backend/src/sftp_raw.rs`、`sftp_ext.rs`、`sftp_name.rs`、`sudo_fs.rs` |
| 传输队列/续传/压缩 | `frontend/src/composables/useTransferQueue.ts`、`useUploadChain.ts`、`lib/transferSpeed.ts` | `backend/src/transfer_*.rs`、`lzpack.rs`、`sftp/download/next` 协议 |
| Quick Sudo / sudo 文件操作 | `backend/src/exec.rs`、`sudo_fs.rs`、`sudo_profiles.rs` | `frontend/src/App.vue` 的 `sudoMode`、`ssh/settings/*`、`triggers.rs` |
| 端口映射 / 代理 | `backend/src/forward.rs`、`tunnel_menu.rs`、`proxy.rs` | `frontend/src/TunnelManager.vue`、`components/PortForwardDialog.vue`、`lib/portForward.ts` |
| Docker 面板 | `backend/src/docker/*.rs`（`rpc.rs` 是分派臂实现；`files.rs` 只读文件 list/read；`logs_batch.rs` 聚合/UTF-8/脚本，`logs_stream.rs` runner，`streams.rs` 注册表）→ `frontend/src/components/DockerPanel.vue` + `DockerLogsDrawer.vue` + `DockerStatsBar.vue` + `DockerFilesPane.vue` + `DockerWorkbench.vue` | `lib/dockerEngine.ts`、`lib/dockerActions.ts`、`lib/dockerStats.ts`、`lib/dockerFiles.ts`、`lib/dockerLogStream.ts`、`composables/useDockerStats.ts`、`composables/useDockerLogStream.ts`、`composables/useDockerOpenInTerminal.ts`、`audit_log` |
| 监控 / 指标 | `backend/src/monitor.rs`、`metrics*.rs` → `useMonitorPanel.ts`、`useMetricsPanel.ts` | 宿主 `listConnections` 的 `groupId`（缺失即平铺）、Linux-only 分支 |
| MCP 工具 | `backend/src/mcp.rs` 的 `tool_definitions()` → `mcp_safety.rs` → manifest `mcp.tools` | 尺寸预算单测、`docs/MCP.zh-CN.md`、`docs/MCP_USAGE.zh-CN.md` |
| AI 助手/智能体 | `frontend/src/lib/ai*.ts`、`backend/src/agent_terminal.rs` | manifest `host.ai` 权限、`agent_approvals.rs`、宿主 `capabilities.ai` |
| 结构化补全 | `frontend/src/lib/completion/**`、`backend/src/completion/*` | `scripts/sync_fig_specs.mjs` / `verify_fig_specs.mjs`、1200ms 超时 |
| 非 SSH 协议 | `backend/src/telnet_session.rs`、`vnc_session.rs`、`rdp/`、`serial_session.rs`、`local_terminal.rs` | 各自前端 surface（VncSurface/RdpSurface/SerialUploadDialog）、`connection/protocol` 路由 |
| 文案 | `frontend/src/lib/i18n.ts`（7 个 locale 必须同时改） | `manifest.json` 的 `localizations` |
| 打包/发布 | `scripts/build.sh`、`package_and_verify.sh`、`dbx-plugin.toml` | `ui/` 为生成物，由集成方维护 |

## 附录：复核命令

以下命令与输出均在本工作树执行过（`wc`/`find` 的列宽会随终端不同，数字为准）。

```bash
$ wc -l backend/src/ssh.rs frontend/src/App.vue frontend/src/lib/i18n.ts
     256 backend/src/ssh.rs
   12543 frontend/src/App.vue
   10764 frontend/src/lib/i18n.ts
   33563 total

$ find backend/src -name '*.rs' | xargs wc -l | tail -1
  106432 total
$ find backend/src -name '*.rs' | wc -l
     144
$ find frontend/src -type f | wc -l
     579

$ python3 - <<'PY'
import re
arms=[]; names=[]
for l in open('backend/src/main.rs'):
    m=re.match(r'^ {12}((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=>', l)
    if m:
        arms.append(l)
        names += re.findall(r'"([^"]+)"', m.group(1))
print(len(arms), len(names))
PY
206 209
```

前端目录导入边（仅生产文件，解析相对 import 后映射到目录）：

```bash
$ python3 - <<'PY'
import os, re, collections
root='frontend/src'
files=[os.path.join(dp,f) for dp,_,fs in os.walk(root) for f in fs
       if f.endswith(('.ts','.vue')) and '.spec.' not in f and '.test.' not in f]
pat=re.compile(r'''(?:from|import)\s*\(?\s*["']([^"']+)["']''')
def area(p):
    parts=os.path.relpath(p,root).split(os.sep)
    return 'App/main' if len(parts)==1 else parts[0]
edges=collections.Counter()
for f in files:
    for spec in pat.findall(open(f,encoding='utf-8',errors='ignore').read()):
        if not spec.startswith('.'): continue
        t=os.path.normpath(os.path.join(os.path.dirname(f),spec))
        hit=next((area(t+e) for e in ('','.ts','.vue','/index.ts','/index.vue')
                  if os.path.isfile(t+e)), None)
        if hit and hit!=area(f): edges[(area(f),hit)]+=1
for (a,b),n in sorted(edges.items(), key=lambda x:-x[1]): print(f"{a:12s}->{b:12s}{n}")
PY
composables ->lib         163
components  ->lib         139
App/main    ->lib         125
App/main    ->composables 43
App/main    ->components  36
App/main    ->rdp         5
components  ->composables 5
App/main    ->..          3
rdp         ->lib         3
lib         ->..          3
composables ->..          2
composables ->components  2
rdp         ->components  2
App/main    ->styles      1
composables ->rdp         1
components  ->..          1
lib         ->components  1
```

单点存在性（节选）：

```bash
$ grep -c '"name": "ssh_exec"' backend/src/mcp.rs
1
$ grep -n 'dbx-plugin-ssh' dbx-plugin.toml
6:binary = "dbx-plugin-ssh"
$ grep -n 'rdp_experimental_enabled' backend/src/main.rs | head -1
3073:    if preferences::rdp_experimental_enabled(data_dir) {
$ grep -n 'pub const TRANSFER_CHUNK_SIZE' backend/src/model.rs
5:pub const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
```

所有正文中出现的 RPC 方法名另用脚本对 `backend/src/main.rs` 的方法表与
`docs/PROTOCOL.zh-CN.md` 做了逐名核对（别名以 `a|b|c` 形式写出，脚本按同一前缀
展开后校验）。
