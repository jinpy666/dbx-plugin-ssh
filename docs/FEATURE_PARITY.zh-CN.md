# SSH/SFTP 特性能力清单

插件现状：`backend/src/main.rs` 方法表（**184 个分发方法臂、185 个方法名**——`ssh/host-key/resolve`
与 `connection/challenge/resolve` 共用一臂（main.rs:792），含 sftp/copy、sftp/move、ssh/host-key/check、
keys/discover/options，以及 watch/*、sftp/download/tree/start、sudo/download/*、rdp/*、serial/* 等
后续批次方法；2026-09-26 协议审计复核，原「68 臂 / 69 名」为 2026-08-29 收口值、共用臂当时在
main.rs:174）。
原则：补齐完整 SSH/SFTP 能力面；DBX 已由宿主承担的能力（连接管理、
profile 分组、全局外观）不重复实现。

## 能力对照总表

| 能力 | 参照位置 | 插件状态 | 优先级 |
| --- | --- | --- | --- |
| SFTP 基础（list/read/mkdir/rename/chmod/delete/upload/download/传输槽） | sftp_service.go | ✅ 已有（`sftp/read` 另支持可选 `offset` 分片续读，对齐 ReadFile(offset,length)） | — |
| 大文件压缩传输（超阈值先 gzip 再过网络） | WinSCP/Termius 等压缩传输惯例；远端 tar.gz 归档手动流 | ✅ 已有（2026-09-29，M33 gzip 混合方案：压缩端程序内置 flate2、对端远端 gzip/gunzip/tar 工具调用——单文件上传=spool 预压→推 .gz→远端 gunzip→既有原子提交；单文件下载=远端 gzip 临时件→拉取→本地解压→分块管线读解压暂存；目录下载=远端 tar.gz 单流→本地解包 staging→既有树分块管线，目录上传逐文件压缩。决策/回退矩阵：偏好关/低于阈值 64MiB（可配 0..=65536）/扩展名黑名单/远端缺工具/只读/latin-1/压缩率 ≥95% 全部静默回退普通传输，压缩下载不支持 offset 续传（恒走普通管线）。无新增 RPC 方法——`sftp/upload/start`/`sftp/download/start`/`sftp/download/tree/start` 响应增 `compression` 字段，进度事件增 `compressing/fetching/decompressing/ready/transferring` phase 与 `compression` 字段，偏好 `transfer_compress_mode`（三态：`auto` 默认=智能综合判断（含弱 CPU 门槛：≤2 核跳过 + 上传实测吞吐 <20 MiB/s 中途回退）/`on` 豁免 CPU 门槛/`off` 关闭）、`transfer_compress_threshold_mib`（默认 64）。协议见 PROTOCOL「压缩传输（gzip 混合方案）」节，单测 `backend/src/transfer_compress.rs` 内联，冒烟 `scripts/smoke_fs_test.py` 压缩组（容器缺 gzip 整组 SKIP），基准对照 `scripts/perf_baseline_test.py` 压缩档） | — |
| 外部编辑器打开方式（按扩展名映射编辑器 + 保存即回传） | FinalShell 本地编辑自动回传 / WinSCP Preferences→Editors | ✅ 已有（2026-10-03，编辑器映射增强：watcher 回写链 M15/M20/M21 既有，本批补「指定编辑器」与「实时回传」——`local/editors/list` 返回平台知名编辑器目录（macOS /Applications、Windows 标准安装路径含 WPS 版本目录、Linux PATH；文件系统探测不 spawn 进程，unavailable 条目保留），`local/open-with {path, editorId|custom}` 在 `local/open` 同源下载历史 allowlist 下用指定编辑器打开（argv 直接 spawn 不过 shell；自定义命令 shlex 分词、Windows 反斜杠保形）；右键「打开方式 ▸」子菜单（系统默认 + 探测编辑器打勾 + 自定义命令弹窗可「记住为 *.ext 默认」），设置 → 传输新增「外部编辑器」区（默认编辑器/扩展名关联增删/自定义编辑器管理/回传策略），配置持久化 pluginStore 单键 `ssh-editor-config`（editorRules.ts 纯函数解析 + 单测，sidecar 不读）；**回传策略默认 `auto`（FinalShell 式保存即静默回传）**，`ask` 恢复逐次确认，「总是上传」仍为逐 watchId 记忆；协议见 PROTOCOL「外部编辑器目录与打开方式」节，冒烟 `smoke_fs_test.py` 编辑器目录组。2026-10-03 真机回归三修：watcher 启动抑制窗归零（2s 窗口静默吞掉编辑器已在运行场景的真实早期保存，预热噪音改由 SHA-256 基线把关）、监听对象改父目录（原子保存 rename 覆盖交换 inode 使文件级监听失聪）、前端注册表不再按 remotePath 顶替（同远端多副本 watcher 全保留，旧窗口保存不再静默丢）） | — |
| 目录磁盘占用 diskUsage | sftp_service.go | ✅ 已有 | — |
| 终端 PTY/回放/resize/目录跟随 | ssh_service.go | ✅ 已有（2026-09-28 补跟随权限引导：终端 sudo 切换后跟随撞上登录用户权限墙（如 `sudo su` 后跟到 /root，路径来自 root shell 自带 shell 集成的 OSC 7/633/1337——插件注入钩子不跨 su 存活）时，`loadDirectory` 跟随失败分支经 `lib/sftpErrors.ts` `shouldOfferSudoRetryAfterFollowFailure`（仅 fromTerminal/sudo 模式未开/连接可写/权限类错误四条件）升级为「切 sudo 模式并重试」通知动作（复用 BannerAction，8000ms 时窗），重试走手动导航语义、再失败落 SFTP 错误横幅不循环；七语 `followDirectorySudoHint`/`followDirectorySudoRetry`） | — |
| 启动命令（连接建立进 shell 后按序自动键入） | Tabby Login scripts | ✅ 已有（2026-09-25，`codex/ssh/parity-startup-commands` 分支 M7 P0-4）：偏好 `startup_commands`（`local/preferences/*` 白名单，按 connectionId 分桶 `{enabled, commands:[{command ≤4KiB, delayMs 0..=30000 缺省300, enabled}]}`，每连接 ≤20 条）；shell 起来后一次性顺序注入器经 PTY 键盘通道写入 `command+"\r"`，会话关闭即停；`remote_command`（exec）会话语义冲突自动跳过；完成发 `ssh/startup {sessionId, count, completed}`（不带命令内容）；设置 → 终端列表编辑（增删/排序/启停/延迟，开关默认关，七语）。协议见 PROTOCOL「启动命令（Login scripts 对标）」节，冒烟 `scripts/smoke_startup_commands_test.py` | — |
| ssh/exec + sudo（含 PTY/MFA/TOTP 编排） | sudo_exec_service.go | ✅ 已有（exec.rs）；2026-09-04 OTP 多密钥轮换升级：使用/防重放台账进程全局（跨 exec 调用、跨会话；MCP `ssh_exec_sudo` 每调用独立实例也连续轮换），密钥 SHA-256 指纹+窗口+码键控，静态码 usage 键防时间戳漂移，选择排序对齐 resolveRotatingOTP（未用优先→剩余时长最长→配置顺序） | — |
| 登录期动态令牌人工输入（keyboard-interactive） | JumpServer/koko / PAM MFA | ✅ 已有（2026-09-24）：密码/TOTP 自动编排优先；仍未回答的提问经 Host API 1.1 `host.requestUserInput` 打开密文弹窗，支持手机 App、硬件令牌、短信等当前码，答案只用于本次连接且不持久化；取消/超时/空值 fail closed，旧宿主保持原降级诊断；2026-10-03 阿里云 Bastionhost 回归加固：内置 pattern 显式收录官方提问 "Please Input Mfa Code (SMS):"（说明行 "Two-Step Verification required" 仅作挑战上下文、永不单独判成验证码提问），smoke_login_mfa_test 新增阿里云三场景（off 弹窗输入短信码、私钥 partial success 弹窗、官方文案免提示词 TOTP 自动回码） | — |
| 复制已认证会话（免重复 MFA） | SSH multiplex / 同 transport 多 channel | ✅ 已有（2026-09-24）：工具栏“复制会话”复用当前存活、已认证 SSH transport，新 tab 使用独立 PTY/session/workbench/replay；打开期间先预占共享引用，避免源会话并发关闭导致跳板链被提前释放；不缓存或重放 OTP，原 transport 不可用时只降级一次为全新登录并可重新询问 MFA，不会对失效 sessionId 无限退避；复制继承来源会话已解析的 sudo 编排快照；“新建会话”仍建立独立 transport 并重新认证；每个复制会话占一个 SSH channel，受服务端 `MaxSessions` 限制 | — |
| ZMODEM rz/sz | ssh_service.go | ✅ 已有（rz 上传 2026-09 上线；**sz 下载自动接收** 2026-10-03：sentry 自动确认 receive 会话，落盘与 trzsz 同三段式（fileTransfer 流式/sidecar 下载目录/浏览器兜底），offer 文件名净化防路径逃逸；检测器改「透传+事件窗口」，见 PROTOCOL「ZMODEM」两节） | — |
| 终端拖入文件上传（落点询问：当前目录 / 指定绝对路径目录） | Tabby/WindTerm 等拖拽上传 | ✅ 已有（2026-09-15：拖到终端面板先弹落点询问——上传到 SFTP 当前目录（目录跟随时即 shell cwd）或输入目标目录绝对路径（`normalizeDropTargetDir` 归一化，七语 `terminalDropPrompt`），确认后走 `sftp/upload/*` 既有链路；SFTP 面板拖放保持直传不变。2026-09-22 起桌面宿主 OS 级拖放经 fileTransfer onDrop/onDragState 桥接进工作台（`planHostFileDrop` 分流：SFTP 面板打开→当前目录直传，solo 终端→同一落点询问，只读/传输中→忽略；上游宿主事件已合入，真机验收待跑），并移除 initialize() 残留的第二套 onDrop/onDragState 直传注册避免真机双上传。2026-09-26 起支持**文件夹上传**（issue #78，M31-A：SFTP 面板「上传文件夹…」入口，`<input webkitdirectory>` 递归枚举 + `lib/folderUpload.ts` 纯前端编排——远端目录集去重建链 + 逐文件复用既有 upload 管线，结构保留在当前目录下以根名命名的一层，与目录下载同语义） | — |
| 文件夹上传（递归目录上传、保留结构） | Tabby/WindTerm 目录拖放 | ✅ 已有（2026-09-26，issue #78 / M31-A：见上「终端拖入文件上传」行内文件夹上传段——纯前端编排，`sftp/createDirectory` 父先于子 ensure + `sftp/upload/start/finish` 既有管线；`transfer_duplicate_policy=ask` 批量下降级为已存在跳过并计数提示，rename/overwrite 走既有解析；聚合进度卡「目录 X/Y · 文件 N/M · 字节」复用传输面板；能力探测 webkitdirectory 缺失时入口隐藏。2026-09-28 补工具栏入口：SFTP 面板动作栏「上传文件」旁新增「文件夹上传」按钮（对标 dbx-plugin-files FileToolbar，同一 `chooseFolderUpload` 链路，能力缺失时随右键入口一并隐藏）。2026-09-29 补**拖文件夹上传**（web/DOM 车道）：SFTP 面板与终端的 DOM drop 经 `lib/dropEntries.ts`（`webkitGetAsEntry` 同步收根 + 有界递归遍历）产出相对路径清单接入文件夹管线——含目录走文件夹批量语义，纯文件保持单文件语义，API 缺失回退 `dataTransfer.files` 现状。桌面宿主 OS 级拖放走 fileTransfer 桥，宿主侧 `plugin_file_open` 拒绝目录且静默跳过（文件夹拖放在宿主仓库侧待支持：目录遍历 + `PluginFileHandleMeta.relativePath` 增量字段）；插件已前向兼容该契约——filedrop 条目带 `relativePath` 即走文件夹管线，旧宿主不带则行为不变） | — |
| 终端 Shell Integration 命令标记（OSC 633：命令/退出码/时长/cwd） | frontend/src/modules/ssh/osc633-parser.js | ✅ 已有（`terminalCommandMarkers.ts` 解析器移植 + 状态条，S-B；运行中时长 1s tick `runningCommandElapsedMs` + `marker-elapsed` span，X-B。2026-09-20 修复：precmd 同 chunk 先 D 后 A 时 A 携带的 `lastExitCode=null` 会在合并 updates 里覆写 D 的退出码，退出码标记永远显示不出来——A 不再携带该字段，SSH/本地终端同益） | — |
| 提示符换行（无结尾换行的命令输出后，提示符另起一行） | FinalShell / WindTerm | ✅ 已有（2026-10-03，issue t8y2/dbx#10750：SSH 交互 shell 会话打开即武装按提示符发 OSC 7 的钩子——bash `PROMPT_COMMAND` 前置 / zsh `precmd_functions`，帧信号与 SFTP 目录跟随共用；前端 `lib/terminalPromptNewline.ts` 字节级变换器在帧前按需补 CRLF，除插入外逐字节透传，备用屏/传输期只跟踪不插入，无钩子流恒等直通；「跟随目录」关闭不再拆钩子，武装对会话全生命周期生效；协议见 PROTOCOL「提示符钩子与提示符换行」节，单测 Rust 注入门控/脚本 + 前端变换器分块边界矩阵） | — |
| 本地终端（sidecar 本机交互式登录 shell + shell integration 注入） | VS Code 集成终端 / Termius local shell | ✅ 已有（2026-09-20：`local/terminal/start|resize|replay` + `local/session/list|close`，portable-pty 三平台（Unix openpty / Windows ConPTY），`backend/src/local_terminal.rs` 独立会话表与输出泵，复用 `ReplayBuffer`/`TerminalFrame` 帧协议；shell 解析 dscl→$SHELL→平台缺省且一律登录 shell（macOS GUI PATH 教训，Ghostty/Warp）；自带精简 shell integration 注入（zsh ZDOTDIR 包装/bash rcfile/fish -C/pwsh -Command，fail-safe + 可关闭），OSC 133 A/C/D + 633 E/Cwd + OSC 7(9;9) 供前端命令标记与 cwd；工作台显式入口，与 SSH 会话互斥展示、确认后切换，退出码覆盖层 + 重开（VS Code 式）；webview 重载经 `local/session/list` 接回，`workbench/close` 回收；冒烟 `scripts/smoke_local_terminal.py`，协议见 PROTOCOL「本地终端」节。2026-09-21 追平批次：`local/shells/list` 多平台 shell 发现（/etc/shells+dscl / Windows PATH 枚举 pwsh/PowerShell/cmd/wsl）+ 工作台 shell 选择菜单（偏好 `localShell`/`localShellIntegration` 持久化）+ 重开继承 cwd + 徽标显示 shell 名 + D/A 同帧退出码标记修复（见上条）。已知风险：Windows ConPTY 新版标志兼容坑（portable-pty 上游）。2026-09-27 Windows 10 实测通过并修复首伤：ConPTY 启动握手 `CSI 6n` 在收到 CPR 应答前扣留全部输出，宿主桥 binary 回传丢帧时本地终端永久黑屏（进程活着但无横幅/提示符/回显）——sidecar 现对首个查询以 PTY 尺寸代答（PROTOCOL「本地终端」节）。PR-A4 迁移（context.plugin 形状/宿主权威 workbenchId/restored 恢复语义）进行中，见实施计划（docs/HOST_UI_A4_IMPL_PLAN.zh-CN.md）。 | — |
| 会话状态规范化展示（连接中/已连接/重连中/已断开/错误） | frontend/src/modules/ssh/session-status.js | ✅ 已有（`sessionStatus.ts` 移植 + reconnecting 扩展，S-B；多会话择优不适用未移植） | — |
| 命令输出净化（控制序列剥离/回显移除） | frontend/src/modules/ssh/terminal-output.js | ✅ 已有（`terminalOutputText.ts` 通用部分移植；`.mcp_ctl_*` hook 特判不适用） | — |
| 命令历史（弹窗历史区/↑↓ 浏览/一键重发） | SshPage 命令历史 | ✅ 已有（`frontend/src/lib/commandHistory.ts` 环形 100 条 + App.vue 接线；疑似凭据/超长/多行命令不落 localStorage，A-SSH）；**按连接作用域隔离（2026-10-02）**：三个存储键单键值内按 scope（连接 id；本地/串口终端固定桶）分桶（宿主 storage 无列键，同 ssh-docker-engine 先例），↑ 面板/建议/ghost/命令弹窗只读当前作用域，多终端历史不再互串；旧全局档一次性迁入 local 桶，SSH 连接以各自 shell 历史文件回填（`loadRemoteShellHistory`） | — |
| 快速命令栏（CRUD/发送语义） | QuickCommand | ✅ 已有（`frontend/src/lib/quickCommands.ts` 上限 20 + 工具栏 Zap 下拉；发送走 PTY 键盘写入原文保留交互 shell 状态，A-SSH。2026-09-04 起存储升级为**全局**：`ssh/quickCommands/*` + sidecar `quick-commands.json`，所有连接/工作台共享，localStorage 旧数据一次性迁移。2026-09-26 M32-A 职责归位：工具条弹层只留列表+搜索+执行（Run/Paste），新建/编辑/导入迁「设置 → 终端」（`QuickCommandsSection.vue`），数据面 RPC 不变） | — |
| 批量发送（多会话发送命令） | useBatchSend/SshBatchSendPanel | ✅ 已有（`ssh/terminal/batchInput` 写入各会话 PTY；交互 2026-09-08 改版为终端底部常驻命令条（思路 Electerm quick-command bar）：回车即发送、目标选择 popover（全选/仅存活/刷新）、快速命令下拉切换回填、内联保存为快速命令（`ssh/quickCommands/*` 全局共享 ≤20）、结果浮条逐会话汇总；发送成功清空入历史、↑↓ 回选；跨工作台草稿/开关经 `ssh/batchBar/state` 广播同步；危险命令复用粘贴确认；输出不收集回显在各自终端；并发同靶 OTP 提示撞重放保护时延迟到下一窗口自动补答（2026-09-08）；2026-10-03 目标行标签改显连接名（issue #10232：终端改名后批量目标仍显示旧名——`refreshBatchTargets` 增经 `host.listConnections` 按实时连接表覆盖 `name`，改名无需重连、下一次目标刷新即生效；响应形状数组/`{connections}` 双兼容，旧宿主缺该扩展点静默回退 `user@host`） | — |
| 连接信息面板（Host/Port/User/认证方式/只读/延迟） | 连接信息摘要 | ✅ 已有（App.vue `connection-info-popover`；`ssh/sessions/list` 行新增只读 `authMethod`（model.rs:46 `method_name()`、ssh.rs:599/609/1236/1249），延迟走既有 ssh/exec echo 探测，A-SSH） | — |
| 终端字体缩放（Ctrl/⌘ 滚轮、复位、持久化） | batch3 工作包 A 第 3 条细化 | ✅ 已有（`frontend/src/lib/terminalZoom.ts` `clampFontSize` 绝对字号 [8,32] + App.vue A+/A− 按钮与 localStorage 持久化，A-SSH） | — |
| 点击定位光标（iTerm2/kitty 风格）+ 细竖线光标 | iTerm2 Option+Click / kitty click-to-move | ✅ 已有（2026-09-09：`frontend/src/lib/terminalClickCursor.ts` 纯几何计算——同逻辑行内原地点击按字符差值代发左右方向键，宽字符 2 格记 1、折行跨行展开、备用屏/鼠标上报应用/trzsz·zmodem 占流一律不动作；光标 `cursorStyle: "bar"`。终端协议无直接落点能力，readline 只认按键，行外点击不动作防翻历史） | — |
| **终端配色方案与多套主题**（Tabby 对标：192 内置配色 / 深浅双槽自动切换 / 字体·间距·光标·渲染细项 / 四格式方案导入 / 实时可视化预览） | Tabby `TerminalColorScheme` + `colorSchemeSelector` + `colorSchemePreview`；tabby-community-color-schemes（上游 iTerm2-Color-Schemes） | ✅ 已有（2026-09-22，`codex/ssh/terminal-themes` 分支）：见下文专节。**默认仍为「跟随宿主」，不改变既有观感**——只有用户显式选方案才覆盖 | — |
| known_hosts 管理（list/remove，宿主侧文件） | ssh_service.go ListKnownHosts/RemoveKnownHost | ✅ 已有（第一批，实测通过） | — |
| RDP 远程桌面（NLA/CredSSP + TLS、文本剪贴板、断线重连） | NyaTerm `src/core/rdp.rs` | 🧪 实验能力（2026-09-25 RDP-1/2/3 代码链已落地：vendored IronRDP 六 crate 锁步链，协议 `rdp/start`、`rdp/input`、`rdp/resize`、`rdp/set-clipboard`、`rdp/reconnect`、`rdp/certificate/resolve`、`rdp/close`、`rdp/list`，见 PROTOCOL「RDP 远程桌面会话」节）。**`rdp_experimental_enabled` 默认关闭**；用户可在「设置 → 实验性 RDP」显式启用，后端 `local/preferences/set` 白名单持久化。2026-09-26 M32-B 起 RDP 连接经宿主连接管理的 `protocol: rdp` 记录进入（manifest 连接类型 + openSession 路由），工具条不再有直开入口；该偏好非 true 时 `rdp/start` 后端门直接拒绝（直接 RPC 同样拒绝，不能绕过）；未完成真实 RDP server 联调、WKWebView 位图光标走查与 CBT 端到端核对，绝不宣称真机已验证。 | 人工验证门 |
| 终端行内 ghost 自动建议（Warp/fish 对齐） | Warp inline autosuggest | ✅ 已有（2026-09-25，parity-warp-ghost cee2c90）：`terminalGhostSuggest.ts` 纯状态机 + 终端区 overlay 渲染（IME/粘贴/远端命令中隐藏），设置自治开关（默认开）；**批 2 复活（2026-10-01，#138 丝滑度 review P0-C）**：数据分工——前缀延伸命中归 ghost、纯模糊命中归浮层（ghost 开启时浮层对前缀命中不弹，此前两开关同开 ghost 永不可见）；→ 整段接受 / **Ctrl+→ 逐词接受**（`firstGhostWordChunk`，Warp word-accept）；与结构化补全菜单同屏共存（菜单只占用 ↑↓/Tab/Esc，→ 恒归 ghost）；**批 3a 锚点乐观前进**：击键期按字符单元格宽度（`terminalCharCells` 简化 wcwidth）本地推进灰字位置，回显 settle 后按真实 buffer 光标 rAF 合帧校正——SSH RTT 窗口内 ghost 不再落后一拍；**批 4e 接受键可配置**：ghost 灰字尾部键位胶囊（→ / Ctrl+→ / Shift+→ / Tab 下拉换绑，pluginStore 持久化，Tab 为显式自担的菜单冲突选择，Ctrl+→ 被绑为整段时逐词自动让位） | — |
| 终端命令历史模糊建议浮层（输入即弹、fzf 子序列评分、设置开关） | Warp 智能命令建议 | ✅ 已有（P1-1）：历史 + 快速命令模糊检索（`lib/commandSuggestions.ts` 纯引擎）+ `CommandSuggestions.vue` 浮层，↑↓ 选择、点击回填、Enter 恒执行当前行、Esc 关闭；**Tab 键裁决（2026-10-01，issue #138）**：仅当高亮建议是当前输入行的严格延伸（`resolveSuggestionTabKey`）或用户已 ↑↓ 显式选中（armed 锁，键入重算即复位）时回填，其余情形（自动高亮的模糊命中/整行已一致）关闭浮层把 Tab 放行远端 shell 做路径补全，裸 Tab 的 onData 短路防同键重开；条目**无原生 title 悬浮提示**（#138 跟进：弹出位置的静止鼠标不再冒 tips，结构化补全浮层同批去除，信息由行内来源标签/描述列承载）；补全菜单打开时同步收起建议浮层（批 1 P0-A，worker 异步响应不再双浮层叠加）；**前缀延伸命中让位行内 ghost**（批 2 数据分工，ghost 开启时不弹）；**批 3 手感**：空结果 150ms 宽限防闪烁（打词中间态的瞬时空洞不再即关即开，VS Code 同款迟滞）+ 底部内联 kbd 提示行（`suggestions.kbdHint` 七语，非 tooltip）；**批 4 收尾**：起始门槛默认 2→1（Warp 首字符即建议，单字符噪音由 ghost/浮层分工去噪）、单条建议「不再提示」黑名单（行内 ✗ + 设置计数/清空，pluginStore 持久化上限 100）、多候选 Tab 先补最长公共前缀（`longestCommonPrefixEdit`，无推进则接受高亮项）；history 面板**富元数据**（OSC 633 D 帧时长 + 非零退出码红徽标，`ssh-command-history-meta` 并行映射，无 shell integration 会话两列恒空） | — |
| 结构化命令补全（三级下拉：flag/子命令/值候选） | Warp/fig spec completions | ✅ 已有（2026-09-25，parity-warp-spec 9717fa1）：`lib/completions/spec.ts` schema/评分纯函数 + 首批 12 个精选 CLI spec（git/docker/kubectl/ssh 等）+ `CompletionMenu.vue` 三级下拉，命令条接线 spec 优先/历史回落，设置开关（默认开）；与 ghost 建议互斥（M10 fe-fix）；**手动唤起键（2026-10-01 对齐批，2026-10-02 键位修订）**：注册表新增 `completions` 动作——默认 **Ctrl+/**（两平台）+ Ctrl+Space 副键：裸 Ctrl+Space 被 macOS「切换输入源」与 Windows 中文输入法开关**系统级抢占**，键事件到不了网页层，故不作首选（Warp 同绑 Ctrl+Space，但原生应用用户可在系统设置让路；系统未占用的机器两键都生效）；Ctrl+/ 无系统/浏览器冲突，透传远端仅对应 readline undo(0x1F)，被消费时不落键。`openCompletionsManually` 显式放行输入门（抑制锁存不拦显式动作），history 面板/终端搜索占用、alternate 屏、命令运行中、传输占用时不开，随键入自动弹不受影响； | — |
| 终端 history 可视化面板（↑ 唤起、Warp 版式全宽贴输入行上方展开、输入即过滤、相对时间、选中实时回填输入行） | Warp command history palette | ✅ 已有（2026-09-29）：`lib/historyPanel.ts` 纯逻辑（fzf 子序列检索 + 子串回落 / 循环导航 / 打开门矩阵 / 执行时间并行映射 `ssh-command-history-times` / Warp 优先向上的放置函数）+ `TerminalHistoryPanel.vue`（两侧 8px 全宽、底边贴光标行顶向上展开、`>_` 提示符图标 + 命令 + 右侧相对时间、kbd 键帽提示行，随宿主主题、令牌缺失时 fallback 保可见）；裸 ↑ 直达（alternate 屏 / 命令运行中 / 传输占用 / 既有浮层开启时不抢，shell readline 历史保留），注册表 `command-history` 动作为可配置补充入口（⌘⇧H / Ctrl+Shift+H + **Ctrl+R**，2026-10-01 对齐批——Ctrl+R 是 Warp Command Search 的默认键 `workspace:show_command_search`，热键入口聚焦搜索框即 Warp 搜索流心智；需要远端 readline 原生 reverse-i-search 的用户可在热键编辑器解绑 Ctrl+R）；**空提示符快捷键引导条（2026-10-02）**：`TerminalPromptHints.vue` 空行静置时在光标行上方浮出 kbd 键位速览（**放置自适应 2026-10-02 体验反馈**：光标在第一行/近顶时上方放不下，`choosePromptHintsPlacement` 翻到光标行下方——下方是空屏不遮内容，与 history 面板翻转同语义，条高实测优先首帧常量回退）（↑ 历史 / Ctrl+R 搜索历史 / Ctrl+Space 补全 / → 接受行内建议，Ctrl 系键 Apple 平台按热键编辑器同款 ⌃ 符号渲染），显隐门纯函数 `lib/terminalPromptHints.ts`（行空 / alternate / 命令运行 / 传输 / 既有浮层 / 会话在场），用过任一被引导功能（开面板 / 手动补全 / 接受 ghost）或点 ✗ 即永久消散（pluginStore 旗标），设置「命令建议」栏开关重开即清旗标；开启期间继续打字进命令行不过滤（搜索框 query 才过滤，行缓冲有 Ctrl+U/W 残影不作 query——历史缺陷口径），选中即回填（2026-09-30，shell ↑ 语义）：打开/↑↓/点击/搜索框重过滤都把当前高亮命令实时写入输入行（整行擦重打不回车，行内容与面板高亮恒一致；悬停只浏览——不抢高亮不改输入，选中只认键盘与点击），键位映射纯函数 `resolveHistoryPanelKey`——顶部最旧一条 ↑ 停住不回绕，Esc 及底部最新一条再 ↓ 恢复打开前的原输入行并收起；Enter/Tab 确认收起（2026-10-01，#138 交互跟进：面板打开**不抢焦点**，光标留在命令行，搜索框点击聚焦后才过滤；命令行焦点路径放行 shell——回车执行当前行（shell ↑ 语义）/Tab 交远端补全，搜索框路径仅收起归还焦点不代执行；确认不做整行替换，不覆盖用户对行的编辑；行内条目无原生 title 悬浮提示）；与命令建议/结构化补全/ghost 浮层互斥（打开即连带关闭补全并落输入门，开启期间键入分流不开浮层，选中回填触发的 lineChanged 重调度不再拉起补全菜单），会话切换 / OSC 633 命令开始 / 清屏兜底关闭；数据沿用当前作用域的 `commandHistory`（2026-10-02 起按连接分桶，见命令历史行）+ 执行时间映射（统一采集口 `pushTerminalCommandHistory`，四个采集点共用，旧数据无时间不显示时间列）；七语 + 单测 + `smoke_ui_mock.mjs` 走查 | — |
| `#` AI 命令搜索（空提示符键入 # 自然语言描述命令，发起宿主 AI 面板生成命令） | Warp AI Command Search | ✅ 已有（2026-10-02，Warp AI 对齐批，IMPL_PLAN_WARP_AI_TERMINAL §3）：空行键入 `#` 进入本地搜索模式——onData 全部改道状态机（`lib/aiSearchMode.ts` 纯状态机：printable/batch 并入 query、退格回退、回车 submit、Esc/Ctrl+C 退出、控制序列 abort），**字节不进 PTY**（退出零擦除；能力缺失时 `#` 照常放行，shell 注释语义天然兜底），行内提示条（badge + query + kbd 键位）锚在光标格（**放置自适应 2026-10-02**：与引导条共用 `choosePromptHintsPlacement`，第一行/近顶翻到光标行下方）；回车把「query + connectionId + cwd」经 `host.ai.openConversation`（ask 模式，send=true）发宿主 AI 面板，prompt 模板钉「只回一条可执行命令 + Why 行」；**AI 生成命令一律不回写 PTY 不代执行**（执行权在人）；能力位 `capabilities.ai`（旧宿主缺省即不支持）+ 设置开关（默认开），门矩阵与建议浮层同构（alternate/命令运行/传输/既有浮层不激活）；**多语言/多 shell 上下文（2026-10-02 跟进）**：context 随发 `locale`（LLM 以终端用户语言回答）+ shell 语义——本地终端取 shell 偏好 basename 与平台口径（macos/windows/linux），SSH 复用补全的提示符采样判 PowerShell/cmd（导出既有 `sniffTerminalShell`，不为 AI 另写探测），远端 OS 刻意不发探测命令（AI 从输出推断，诚实省优于猜测）；**与 Warp 的既示差异**：Warp `#` 为随打字内联建议（需宿主流式补全桥，P3），本 v1 为「回车发起面板会话」；**2026-10-02 决策：默认关（暂缓）**——内联体感与 Warp 有差距，直连生成 v2（生成即回填）待后续再启（宿主 t8y2/dbx#10629 的 `ai.generateText` 已具备条件）；此前「宿主无直连 LLM API」的口径已被 #10629 推翻，现穷举 host.ai.* 共 7 方法；**v2 直连回填（2026-10-02，AI 体验改造批）**：`aiCompletion` 能力位在（桌面运行时）时，回车改走直连生成（`listAiModels` → `pickDefaultAiModel` → `generateAiText`，prompt 用抽出的 `buildAiSearchPrompt` 与面板会话共用、钉「首行 = 精确命令 + Why 行」）→ **生成即回填光标处（2026-10-02 体验反馈二次修正：回填确认层拆除，Warp 同款默认插入）**，Why 行走通知提示；**回填不等于执行**——回车权仍在用户（红线保持）；首行为空/异常/能力缺失回退既有面板会话；解析在 `lib/aiResultParse.ts`（与修复直连路径共用）；**默认仍关**（设置开启即得 v2 体验） | — |
| 失败命令 AI 修复（非零退出码出修复条，一键带脱敏输出快照发起宿主 AI 会话） | Warp Fix-with-AI / Command Corrections | ✅ 已有（2026-10-02，同批 §4）：触发面 `lib/aiFix.ts` 纯函数——OSC 633 D 帧非零退出（批 4d 已有采集）+ 门（桥能力 / 设置开关**默认开**，2026-10-02 体验反馈对齐 Warp 自动出现——修复条仅本地展示，发送仍过首次快照预览确认 + 宿主逐次授权 / 非 alternate）+ **预期非零豁免表**（test/[、grep 族、rg、diff、cmp、which、type、command、hash、kill -0，首词剥 env 前缀与 sudo/nohup 包装）；修复条非弹窗贴触发光标行顶（`✗ 码 + 命令 + 用 AI 修复 + ✕`），新命令开始/Esc/会话切换即消失；**输出快照管线**（隐私关键）：执行期环形采集（`lib/aiCapture.ts` 尾部软上限）→ ANSI/OSC 剥离 → 尾部 200 行/16 KiB 截断 → 脱敏（`lib/outputRedaction.ts`：键值对留键名抹值、Bearer/AKIA/GitHub/OpenAI/Slack/PEM/URL 凭据整段抹，幂等）→ **首次发送快照预览确认**（confirmDialog 既有件，同意记「不再询问」，设置页可重置）；热键注册表 `ai-fix` 动作（⌘⇧I / Ctrl+Shift+I）；**直连生成路径（2026-10-02，宿主 #10629 接线）**：`aiCompletion` 能力位在（桌面运行时）时 修复条点击 → 列已配模型（`listAiModels` 插件侧再投影白名单防泄漏）→ 挑默认（`pickDefaultAiModel`）→ `generateText`（prompt 附本地白名单分诊提示 `ssh/alert/triage` 既有 RPC，best-effort）→ **生成即回填光标处（2026-10-02 体验反馈二次修正：回填确认层拆除，Warp 同款默认插入，Why 行走通知）**——回填不等于执行，回车权仍在用户（红线不变）；直连不可用（web 运行时）/失败/取消 回退面板会话（`?aipanel=1` 走查覆盖）；**推荐位（P2 落地）**：修复条出现即 `setRecommendations` 推「用 AI 修复失败的命令」卡（context 带 command/exitCode/connectionId），条消失/新命令/会话切换即 `clearRecommendations` | — |
| 唤起 AI 助手（热键 + Quick Select 上下文，ask 快照对话；Agent 档 opt-in 走宿主 agent + 既有 MCP 审批门） | Warp Agent Mode 入口 | ✅ 已有（2026-10-02，同批 §5，ask 档）：注册表 `ai-assist` 动作（⌘⇧Y / Ctrl+Shift+Y，Y 组避开 select-all 的 Ctrl+Shift+A）——选中文本优先、无选区取屏幕尾部 40 行，过脱敏管线后发宿主 AI 面板；设置页新开「AI 助手」分栏（三开关 + 能力缺失横幅 + 「不再询问」重置）；**红线：插件零密钥零模型配置**（provider/模型全在宿主 Settings → AI），`host.ai.openConversation` 需 manifest `permissions: ["host.ai"]`（宿主白名单内），能力缺失全链路可见降级（`#` 放行 / 修复条不出 / 热键给七语提示）；context 随发 locale + shell/os 上下文（同 `#` 搜索条目）；**Agent 档 opt-in（P2 落地，2026-10-02）**：设置「面板会话 Agent 档」开关（默认关）——开启后修复回退/唤起助手的 `openConversation` 以 `mode:"agent"` 发起，执行面=宿主 agent 经 MCP 策略（`dbx_plugin_tools`/`dbx_plugin_call`）+ 插件既有审批门，无需宿主新代码；**宿主快照边界（实测）**：宿主 `snapshotPluginWorkbenchContext` 只做结构净化（类型白名单 + 2 MiB 上限）**不脱敏**——插件侧脱敏管线是必要层而非重复造轮子；P2（未做）：Agent 档 opt-in、triage 上下文、`setRecommendations` 推荐卡——待宿主确认 Scoped AI 会话的 `dbx_call_plugin_tool` 限制面 | — |
| 补全引擎 v0.2（主题/翻转/贴合/键盘语义/replacement range/动态 provider） | review #120 追加 | ✅ 已有（2026-09-28，codex/ssh/fix-120-suggestion-overlay）：面板令牌随宿主主题；下方/上方翻转 + 右缘 clamp + max-height 内滚（`overlayPlacement.ts`）；锚点 `.xterm-screen` 原点 + 回显 settle 重读（rAF 合帧）消除 SSH RTT 滞后，ghost 共用坐标系；Enter 恒放行执行、动态 hint Tab 透传 shell；replacement range 由 parser 给出（`SpecMatch.replaceStart/End`）；动态 provider 注册表 + SFTP 面板缓存版 remote-fs provider（cd 补全）；Fig/Amazon Q spec 导入器（`figImport.ts` + `scripts/import-fig-specs.mjs`） | — |
| 补全浮层 UX 修正批（贴底翻转坐标系/悬停武装/loading 不开菜单/generator 前缀归并/Windows shell 内建候选） | 2026-09-28 Windows 实机反馈 | ✅ 已有（2026-09-28）：①翻转的 CSS bottom 偏移改用定位包含块（terminal-pane）实测高度——批量条/标记条让位（inset-bottom）时 host 比 pane 矮，旧实现用 host 高度会把浮层压低一条内缩量、盖住输入行（`CompletionMenu.vue`/`CommandSuggestions.vue` 同修，空间判定仍用 host 净高）；②悬停武装：指针在浮层上真实移动过才允许 hover 激活，静止指针不再抢占键盘选择（两浮层同款）；③generator loading 占位不再主动开菜单（消除 generator 位逐键闪出"加载中"悬浮层），浮层仅随 ready 候选开启；补全调度在 zmodem/trzsz 传输与命令弹窗执行期间关门（与 ghost 同门）；④`GeneratorScheduler` 缓存 key 去掉前缀（前缀归并）——同 token 连续前缀共享同一次 `completion/execute`，各调用按自己的前缀过滤，Windows/高 RTT 会话不再逐键打目标机 RPC；⑤Windows shell 内建候选（`lib/completion/shell/shellBuiltins.ts`）：提示符采样（`PS C:\…>`/`C:\…>`，TTL 1s）判 PowerShell/cmd，fig 语料 pass-through 时命令名位兜底 cmdlet/cmd 内建命令（各约 40 条），以 `FigCompletionSource` 包装器叠在 engine runner 外侧（worker 内、检测回调主线程），controller 无感；⑥历史回落分支不再 dismiss 补全调度（`closeSuggestionsOnly`）：worker 模式下 `request` 的响应异步回来，历史无匹配分支原先在同键入内 `dismiss()` 顶掉 revision，异步响应被三重 guard 永久丢弃——历史不命中的前缀下补全整体失效（实测"敲错→退格→再输入不再弹补全"即此根因，GUI 对照复现）；⑦锚点 DOM 兜底测量（`terminalAnchor.ts` `measureCellSizeFromDom`）：`_renderService.dimensions.css.cell` 读不到时（渲染器未就绪/WebGL 恢复切换窗口期，Windows 上更常见）改用渲染 DOM 实测行高与列宽，替代原先直接返回 null 导致的浮层永久贴底降级（不跟随不翻转） | — |
| 终端行为与快捷键设置（右键四档/粘贴变换/响铃三态/键位录制编辑器） | Tabby Terminal/Hotkeys 设置页 | ✅ 已有（2026-09-22 两轮合入，见下文「Tabby 终端行为与快捷键对标补充」专节） | — |
| 连接表单协议化（protocol 字段 ssh/telnet/vnc/serial/rdp，工作台直启对应协议会话） | Tabby 连接设置 protocol | ✅ 已有（2026-09-25，M9：manifest `protocol` select + SSH 特有字段 `visible_when` 联动 + openSession 按 protocol 直启 telnet/vnc 会话（失败回落预填弹窗）。2026-09-26 M32-B 补全：protocol 追加 serial/rdp；serial 组 6 字段（设备/波特率/数据位/校验/停止位/退格）+ rdp 组 4 字段（域/分辨率/证书策略/剪贴板）各带协议门控，host/port 对 TCP 四协议共用（serial 隐藏）；openSession 补 `startSerialFromConnection`/`startRdpFromConnection` 路由（配置缺失/启动失败回落连接表单）；后端 `connection/test` serial 跳过 TCP probe、rdp 走 probe，`connection/connect` 非 SSH 协议一律直通。RDP 仍受 `rdp_experimental_enabled` 后端门控，偏好未开启时 `rdp/start` 拒绝） | — |
| 外部客户端会话导入（MobaXterm/Xshell/WindTerm/SecureCRT/FinalShell/Electerm/Termius） | NyaTerm `core/importer/` | ✅ 已有（前三格式既有；2026-09-25 补齐 SecureCRT .xml/FinalShell .zip/Electerm .json/Termius .json 四解析器，f9fed3c）：这是临时 preview/export，**不创建连接且不持久化凭据**；预览仅有 auth kind/hasSecret/非敏感 key path/metadata，普通密码、PEM 与口令不留在模型。解析各格式（含 ZIP）在 accumulation 前限制 `MAX_PREVIEW_SESSIONS`；统一 `secret_note` 原因码（encrypted/not-carried），密文不解码。导出优先宿主 `saveFile`/`fileTransfer`；Host API 1.0 两者都缺时仅顶层非 sandbox 走 Blob 下载，iframe 依 issue #93 给出升级宿主/顶层打开指引。2026-10-02 起新增**连接表单动作 `import-sessions`**（`when: create`，桌面端系统文件框 + 扩展名/JSON 形态嗅探，复用同一解析器把首条会话回填表单字段；密码永不回填、私钥只回路径；批量与 WindTerm 主密码仍走工作台向导，见 PROTOCOL「会话导入」节与 `IMPL_PLAN_CONNECTION_IMPORT`） | — |
| 主机密钥预检/接受/拒绝（profile 维度） | CheckHostKey/Accept/RejectHostKey | ✅ ssh/host-key/check（探针预检三态，真机验证）+ 挑战流程；2026-09-22 起**连接表单内主机密钥确认 = 支持**（需宿主 ≥0.6.17 / Host API 1.1：`plugin/initialize` 广告 `host.requestUserInput` 时走 `host/requestUserInput` 宿主弹窗，弹窗期间宿主暂停 connection/test 截止，表单内即可信任；旧宿主降级为工作台 `connection/challenge` 确认，cancel/timeout/不应答一律 fail closed，见 PROTOCOL「主机密钥确认通道(requestUserInput)」节） | P1 完成 |
| 本地 SSH 私钥发现（~/.ssh 扫描 + 指纹） | DiscoverKeys | ✅ 已有（第一批，实测通过）；2026-09-15 起另供 `keys/discover/options` 下拉形态（`{options:[{value,label}]}`），只出元数据不出密钥材料；2026-09-17 起 **label 即路径本身**（不再拼算法/指纹，避免下拉控件被撑长），算法与指纹保留在 `keys/discover` 返回值里 | P0 |
| 连接表单私钥录入：手工输入 + 建议下拉 + 任意文件选择 + 粘贴私钥内容 | Electerm 连接表单（选 key 文件 / 直接贴 key 内容）；宿主隧道密钥字段（输入框 + 浏览） | ✅ 已有（2026-09-15；2026-09-17 补文件选择与「可手输」修正）：① 手工输入——`private_key_path` 是普通 text 字段；**刻意不声明 `options_action`**，因为宿主对这类字段渲染纯下拉（`selectOptionsFor()` 优先），既不能手输、也和宿主隧道密钥字段不一致，`~/.ssh` 之外的密钥无法录入。② 建议下拉——宿主内置本地密钥建议器（字段 key 恰为 `private_key_path`，桌面端生效；Web 后端返回空）。`keys/discover/options` RPC 保留为后端能力，label 改为路径本身避免撑长控件。③ 文件选择——`private_key_path` 声明宿主 `picker`（Host API 1.1：`{"kind":"file","content_field":"private_key"}`，**不设 `accept`** 以免 `id_rsa`/`id_ed25519` 这类无扩展名密钥被原生对话框置灰）：桌面端原生对话框写回绝对路径，Web/Docker 无客户端文件系统时同一按钮降级为上传，内容写入 `private_key` 并清空路径（保存时互删，避免旧上传继续命中「内容优先」）。④ 粘贴——`private_key` 可见 textarea（secret 绑定，多行掩码），OpenSSH/PEM/PPK 直贴；内容非空优先于路径（ssh.rs `resolve_private_key_text`，CRLF 归一化），「路径或内容」二选一由 sidecar 连接时校验；MCP 内联拨号同步支持 `privateKeyContent`。⚠️ `picker` 需宿主含该能力的发行版：`engines.dbx` 已固定为 `>=0.6.16`（0.6.16 首个提供该属性；旧宿主 `deny_unknown_fields` 会拒绝整份 manifest，`verify.mjs` 断言只许上移）；另注意上传通道会把私钥内容复制到服务端连接密钥库 | — |
| Stat（文件元信息单查） | sftp_service.go Stat | ✅ 已有（第一批，实测通过）（第一批） | P0 |
| Exists / Touch | Exists/Touch | ✅ 已有（第一批，实测通过）（第一批） | P0 |
| 小文件直写 WriteFile（非传输槽） | WriteFile | ✅ 已有（第一批，实测通过）（第一批） | P0 |
| 归档打包（多路径→tar/zip 远端打包） | Archive | ✅ 已有（第一批，实测通过）（第一批）；2026-08-30 起右键对单文件同样提供压缩 | P1 |
| 解压（tar/zip→目录，可覆盖） | Extract | ✅ 已有（第一批，实测通过）（第一批） | P1 |
| 文件管理器交互（双击预览、二进制不打开、大文件确认、预览内编辑保存） | Sftp 界面（文本预览/编辑/压缩） | ✅ 已有（2026-08-30 交互轮，见下文专节）；2026-09-26 补 JSON 格式化预览（issue #96）：`.json`/`.geojson` 或无后缀嗅探命中时提供格式化/原始切换、字段列表搜索与复制值/复制路径、复制整篇文本（`.jsonl` 除外，截断/>1 MiB 或解析失败降级原文视图） | P1 |
| **Sudo 文件操作族**（无 root 登录下管理 root 文件） | ListDirSudo/ReadFileSudo/WriteFileSudo/MkdirSudo/RemoveSudo/RemoveAllSudo/ChmodSudo/RenameSudo/StatSudo/**DownloadSudo**/**UploadSudo** | ✅ 已有（sudo/stat…sudo/rename 共 11 方法，实测通过）；**DownloadSudo 已实现（M14-C）**——`sudo/download/start|cancel`：源文件 sudo 暂存进同目录 0600 临时件（chown 登录用户），`sftp/download/next`/`finish`/进度事件/传输面板全复用，finally 语义清理（完成/失败/取消/会话关闭），详见 PROTOCOL「sudo 下载（DownloadSudo）」节；**UploadSudo 已实现（2026-09-30）**——`sudo/upload/start|finish`：spool SFTP 推到登录用户 home 暂存件（`.dbx-sudo-ul-*`），提交走单条 exec `sudo mv`（target→backup 让位/回滚 + 权限位保持），分块帧/进度/取消/断点续传全复用上传管线，`sftp/rename-unique` 增 `sudo` 参数走 sudo `test -e` 探测；M33 压缩通道对 sudo 车道正常参与（gz 暂存与远端 gunzip 都落 home 暂存件，不碰目标目录）；前端 sudoMode+可写时上传/下载自动换道（下载右键项 sudo 模式下隐藏），详见 PROTOCOL「sudo 上传（UploadSudo）」节 | **P0 核心** |
| 文件夹整包上传（≥200 文件自动打 tar 单流上传 + 远端解包） | WindTerm 目录打包上传 | ✅ 已有（2026-09-30）：`lib/folderArchive.ts` 纯实现流式 ustar tar（名字 >100 字节 ustar 前缀拆分/GNU LongLink、单文件 ≥8 GiB base-256 size、逐字节可预算声明大小），走既有 upload 管线（M33 网络腿 gzip + sudo 车道原生接管）；落盘后 `sftp/extract` 新增可选 `sudo: true` 解包（sudo 编排列档+解包，整包恒覆盖）；解包成功删归档、失败保留；整包超 16 GiB / latin-1 回退逐文件；宿主拖拽 2000 文件展开上限截断时前端 `hostDrop.truncated` 通知（完整上传指引工具栏文件夹选择器），详见 PROTOCOL「文件夹整包上传（folderArchive）」节 | — |
| 终端缓冲区查询（增量 seq） | GetTerminalBuffer | ✅ ssh/terminal/replay | — |
| 命令中止 | AbortCommand | ✅ ssh/exec/cancel | — |
| SSH 指标（延迟/吞吐采样） | ssh_metrics_service.go | ✅ ssh/metrics：CPU/内存/负载/磁盘 + 网络接口速率、Top CPU/内存进程（`topMemory`）、磁盘 inode 使用率（`inodeUsePercent`）、快照缓存（`cached: true` → `cachedAt`，对齐 GetLastSnapshot）；macOS 主机经 sysctl/`vm_stat`/`iostat` 回退同样可采 CPU/内存/负载/运行时长（2026-09-15 修复） | — |
| MCP 尺寸限制策略（max read/upload/download） | PreferencesMCPSFTP | ✅ mcp/settings/get|set（持久化，重启重载，--mcp 同源） | P2 完成 |
| MCP 本地↔远端传输 + 家目录（sftp_upload / sftp_download / sftp_pwd） | SFTPTransfer / sftpPwd | ✅ 已有（2026-08-30）：29 工具齐（0.4.61 补接 `ssh_alert_triage`；历史口径——当前 `tool_definitions()` 实际注册 33 个工具，含 `docker_action`/`docker_list`，2026-09-26 审计复核）；单文件传输受 maxUpload/maxDownload 限制，本地路径校验先于拨号、校验拒绝不清连接池；0.4.61 SFTP 浏览家族懒建立 + `ssh_test_connection` saved-ref 寻址 + df overlay 行解析兜底（local_ubuntu MCP 覆盖轮发现）；`smoke_mcp.py --host` 真机回环（SHA-256 双端比对 + SFTP 全家族 + run_bg 闭环 + 意图识别三分类） | P2 完成 |
| Docker 管理面板（容器列表/日志/生命周期动作 + 「在终端打开」）+ MCP docker_list/docker_action | NyaTerm Docker 面板 |
| ✅ 已有（P2-4）；**2026-09-27 补本地 daemon 通路（target:"local"）**：docker/list|logs|action 与 MCP docker_list/docker_action 均接受 `target:"local"`——查询 sidecar 所在机器的 Docker daemon（Docker Desktop/OrbStack/rootless），MCP schema anyOf 增补 `{"required":["target"]}` 选择器，无 SSH 会话也能管容器；面板无存活 SSH 会话时自动回落本机并显示「本机」徽标（本机 daemon 拒绝走本地文案；「在终端打开」仅 SSH 模式）。同时采集脚本 PATH 加固（`/usr/local/bin`、`/opt/homebrew/bin`、Docker.app/OrbStack/`~/.docker/bin`/snap 等安装位），修复 macOS 受限 PATH 下误报「未安装 Docker」；本机面 CLI 发现同源（`find_local_cli`），直接 argv 进程执行免 shell 引用、Windows 可用；本机动作仍过白名单/ID 门/审计（本机无 Quick Sudo 管线，daemon 拒绝时返回指引文案）。单测 18 项 + smoke_mcp.py 离线 target=local 形状/schema/非法 target 用例 ；**2026-09-27 第二批（继续）**：① 远端 list/logs 在 daemon socket 拒绝且配置 Quick Sudo 时自动提权重采（`sudo -S sh -c '<脚本体>'`，密码走 stdin/脚本体走 argv，只读连接/白名单拒绝/失败退回原 payload 保留提示）；② Windows OpenSSH 远端兜底——heredoc 无输出（无 DBXDOCKER_PROBE 标记）时改用 cmd 采集器重试（CRLF 逐字段吸收，logs 拆裸命令本地拼回标记）；③ workbench 面本地通路固化为 `scripts/smoke_docker_local.py`（list/logs/幂等 start/校验拒绝实跑）；④ PROTOCOL.zh-CN.md 补齐 docker 家族章节（历史缺口）。⚠️ 提权与 Windows 兜底无真机验证（本机无 sudo+docker 远端、无 Windows 主机），靠 22 项单测覆盖分支与解析；**2026-09-28 第三批（引擎/端点自定义 + 入口独立化）**：① Podman 兼容与自定义 daemon——docker/list|logs|action 与 MCP 工具新增可选 `cli`（命令名/全路径，字符白名单 `[A-Za-z0-9_.\\/:/-]`）、`socket`（unix socket，裸路径自动补 `unix://`）、`host`（tcp 端点，裸值补 `tcp://`）三参数，socket/host 互斥；端点以 env 下发（POSIX 脚本内 `export DOCKER_HOST/CONTAINER_HOST`、sudo 提权烙进脚本体、本机面 `.env()` 注入、Windows cmd 兜底 `set` 行），Docker/Podman 一份设置通用且端点永不进命令行；工作台/MCP 审批与审计文本跟随 cli（`podman rm <id>`）。② 面板入口独立化——从 SFTP 侧栏 tab 迁出为工具条鲸鱼 logo 按钮（Docker 鲸鱼 SVG，Simple Icons CC0），Popover 承载 DockerPanel（终端上方常驻可达，关闭即卸载停轮询），SideNavPanel 收敛为 tree/quick/otp/import；面板头新增「容器连接设置」齿轮弹层（cli/socket/host 三字段，按 connectionId 持久化 localStorage，`lib/dockerEngine.ts` 归一/校验/存取 + spec；「在终端打开」的 exec 命令与 kill/rm 确认文案跟随 cli）。后端 26 项单测（parse_engine/脚本插值/env 前缀/legacy 字节等价钉桩）+ smoke_docker_local.py 补 podman 参数与非法参数形状用例；**2026-09-29 布局三迁——停靠分栏改浮层**：面板从 paneContainer 末尾的 `.docker-pane` 停靠分栏（前置 divider 拖宽、终端/SFTP 经 `--docker-pane-width` 让宽）改为 `.docker-float` 浮层（metrics-float 同款：挂终端面板内右上角，出现即自右缘向左覆盖终端一角，不占分栏、永不遮挡 SFTP 面板），X/Esc 随时可关；paneLayout 移除 dockerOpen/拖宽钳制 API，workbenchState 停写 `dockerPaneWidth`（旧值残留无害）；与指标/录制浮条同角族，同开时按 DOM 序后挂者置顶 | P2 完成 |
| Profile MCP 策略开关 | UpdateProfileMCPPolicy | ⚠️ 由 DBX 侧承担，插件不重复 | 不做 |
| Profile 级快速 sudo / 执行模式 | UpdateProfileQuickSudo / UpdateProfileSSHExecution | ✅ 已有（2026-08-30，**推翻 2026-08-29「不做」结论**）：全局多套 Quick Sudo 配置集中管理（`sudo/profiles/list|save|delete`，`<plugin_data_dir>/quick-sudo-profiles.json` 持久化，密钥永不回显）+ 连接级绑定选择（`ssh/settings/set quickSudoProfileId`，选全局或本连接，插件侧持久化、重连保留）+ 终端 auto sudo / exec / MCP（`ssh_quick_sudo_profiles_*`、`ssh_exec_sudo quickSudoProfile`）全通道生效；2026-08-31（0.4.2）连接表单升级 `sudo_source` 三选一：不开 / 本连接自定义 / 全局配置（`sudo_profile` 引用，visible_when 联动，存量连接按 `quick_sudo` 映射兼容）；2026-08-31（0.4.5）表单 `sudo_profile` 升级动态下拉（`sudo_profile` 字段声明 `options_action: sudo/profiles/options`，宿主拉取配置列表渲染 select，无该扩展能力的宿主文本回退），`global` 模式隐藏 2FA 四件套（`totp_secret`/`auth_flow_mode`/hints——凭据来源整体由全局配置接管），终端监视器改为随设置/配置更新**重新挂载**（修复连接时无凭据、后在工作台配置 quick sudo 不生效的问题，对齐每次输出动态 resolve 的语义） | P1 完成 |
| Profile 分组/排序 | SaveProfileOrganization | DBX 连接管理已承担 | 不做 |
| **SSH 隧道 / 跳板 / 代理（ProxyJump）** | 自建 jump 链 | **整合 DBX 已有能力，不重复实现**：隧道/代理在 DBX 连接编辑"隧道/代理"标签配置（tunnel_profiles）；DBX 先解析传输层，把实际入口以 `runtime.host/port` 传给插件，插件 dial 使用 runtime 端点、主机密钥校验仍以原始 `connection.host/port` 为身份。插件表单已移除 `jump_hosts` 字段避免双轨配置；sidecar 对历史数据保持兼容 | 整合 |

## 第一批任务（本轮指派，纯后端新模块，不改 main.rs 之外的现有文件）

1. `backend/src/sudo_fs.rs` — Sudo 文件操作族（P0）
   - `sudo_fs::{stat, exists, touch, list_dir, read_file, write_file, mkdir, remove, remove_all, chmod, rename}`
   - 复用 `exec.rs` 的 sudo 编排（AuthFlowMode/SudoAuth/Hints）与 ssh.rs 的会话池
   - 语义：stat 走 `stat -c`，list 走 `ls -la --time-style=+%s` 解析，
     read 走 `dd`/`base64`，write 走 `dd of=`，remove_all 防符号链接跟随
2. `backend/src/sftp_ext.rs` — 基础补齐（P0）
   - `sftp_ext::{stat, exists, touch, write_file}`（russh-sftp 原生实现，非 sudo）
   - `sftp_ext::{archive, extract}`：tar.gz 打包/解压（远端 `tar` 命令实现）
3. `backend/src/keys.rs` — 密钥发现（P0）
   - `keys::discover()`：扫描 `~/.ssh`（id_rsa/ed25519/ecdsa/…、config 内 IdentityFile），
     返回路径 + 算法 + 指纹（SHA256），不返回私钥内容
   - `host_key` 管理 API：`list_known_hosts()/remove_known_host(host, port)`（host_key.rs 已有，补薄封装）

接线（main.rs match 臂注册）与 smoke 扩展由主会话统一完成，避免多 agent 编辑冲突。

## 第三批任务（已落地，2026-08-28 基线）

2026-08 全量差距复审后立项，四个并发工作包：
A 终端体验（搜索/字体缩放/WebLinks/风险粘贴防护/滚动缓冲 25k）、
B SFTP 面板（搜索过滤/多选批量/新建文件/属性弹窗/路径历史/sudo 编辑/服务器内复制粘贴；
0.4.x 增补：面板可收起/打开按钮 + 默认不打开偏好、DBX 重启恢复的
「Connection is not active」快速失败提示，见 PROGRESS-P-SSH §8.3）、
C 后端补齐（sftp/copy+move、sudo 时间戳保活、OTP 防重放）、
D 指标增强（网络接口速率/Top 进程/分区展示）。
实施细节、文件所有权与验收标准记录在批次对标文档中（已随批次退役删除，见 git 历史）。
四包代码、单测与 smoke 均已通过（并发期间 cargo test 100/100、vitest 21/21、smoke_batch3 7/7）；
合流后 S-A 第二轮（metrics inode/topMemory、sftp/read offset、快照缓存）与 S-B
（OSC 633 命令标记、会话状态展示、输出净化）继续追加；X-B 轮落地 top5 建议仓内四项
（smoke kind 修正 + sftp/list 断言、i18n 七语 key/占位符全对齐断言、smoke_batch3 目录级用例
12→17、终端标记条运行中时长 tick）；A-SSH 轮落地命令历史/快速命令/连接信息（含
`ssh/sessions/list` 增量 `authMethod` 契约）/字体缩放绝对字号钳制。收口终值基线
（2026-08-29 全量复测）：cargo test 109/109、vitest 51/51、五份 smoke 全绿
（smoke_test PASS、smoke_fs 17、smoke_mcp 19 tools、smoke_batch3 17、smoke_sudo_otp 10）、
出包 0.2.2 sha256 `a67bb683…f347e`（明细记录文档已随批次退役删除，见 git 历史）。
A-SSH 各项归属见原批次「A-SSH 轮核对」记录（该文档已删除）。
git 提交与宿主管线集成验收留待主会话合流后执行。
deferred（本批不做）：多会话分屏、端口转发、SecretRef/审计、远程 SQL——原因见该文档。

## 文件管理器交互轮（2026-08-30）

双击文件是文件管理器的主路径，此前实现存在三处体感缺陷：扩展名白名单外的文本文件
（`Makefile` / `.env` / 无后缀等）与超过 1 MiB 的文本文件双击后**静默转为下载**，预览
形同丢失；二进制文件会先打开预览弹窗再显示徽标，而非"不打开并提示"；大文件无任何
询问。本轮纯前端修复（`frontend/src/App.vue` + `frontend/src/lib/textSniff.ts` 新建）：

- **双击默认预览**：取消扩展名白名单门槛，非图片文件一律走预览（图片 MIME 判定保留）。
- **二进制不打开并提示**：已知二进制扩展名直接提示不打开；无后缀/改名文件在打开前读
  头部 8 KiB 嗅探（`looksBinary`：NUL 字节 / 无效 UTF-8 与控制字符占比 > 10%），命中
  同样只提示不开弹窗（七语 `binaryFile.notOpen`）。
- **大文件先询问**：> 1 MiB 先 confirm（七语 `previewDialog.tooLargeConfirm`），确认后
  仅加载头部 1 MiB 且**只读**，弹窗标题显示截断徽标（`previewDialog.truncated`）；
  并修复原截断分支可编辑保存导致整文件被头部覆盖的数据丢失 bug
  （`previewEditableAllowed` 增加"未截断"约束）。
- **压缩入口放宽**：右键压缩从"仅目录"放开到单文件（归档文件本身除外）；批量压缩、
  解压逻辑不变。
- 后端零改动（`sftp/read` / `sftp/write` / `sftp/archive` / `sftp/extract` 契约不变），
  无新增协议方法与 smoke 用例；新增 `textSniff.spec.ts` 6 用例（vitest 51 → 57）。

## 第二批任务（已完成）

- 前端工作台接入：sudo 模式开关（文件面板工具栏）、归档/解压右键菜单、
  小文件快速编辑保存（WriteFile）、known_hosts 管理入口
- 主机密钥预检 API（连接表单"检查密钥"按钮）
- MCP 设置 API（尺寸限制）
- i18n 七语文案补齐

## tssh 对标补充（2026-09-07，0.4.34，feat/ssh-tssh-parity 分支）

以 [trzsz-ssh（tssh）](https://github.com/trzsz/trzsz-ssh) 为参照做的特性追赶
（worktree `.worktrees/feat-ssh-tssh-parity`，并发双工作包，详见
`PROGRESS-P-SSH.zh-CN.md` 同日章节）：

| tssh 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| trz/tsz 文件传输 | ✅ 已有 | 前端集成 trzsz.js 1.1.6（`TrzszFilter` 流式挂接，与 zmodem 共存互斥；announce 自动接管 + 右键 Upload (trz) 触发；上传走 File API、下载宿主 fileTransfer 优先/浏览器 `<a download>` 兜底；WKWebView 无 File System Access API 的接缝已覆写处理）。唯一依赖豁免，理由见 PROGRESS |
| SetEnv | ✅ 已有 | 连接表单 `set_env`（textarea，多行 `KEY=VALUE`，分号兼容，严格校验非法条目即连接失败；0.4.35 前表单 key 为 `setEnv`，sidecar 兼容读取）；交互 shell 通道 + exec/sudo 命令通道统一注入（`exec.rs merge_channel_env`，用户条目覆盖内置默认）；fire-and-forget 语义与 ssh(1) 一致（服务端无 AcceptEnv 时静默不生效，文档已注明） |
| RemoteCommand | ✅ 已有 | 连接表单 `remote_command`（非空生效；0.4.35 前表单 key 为 `remoteCommand`，sidecar 兼容读取）：交互会话 PTY 照常、exec 替代 shell request；命令退出即会话终止（与 `ssh host command` 同语义）；reattach 重放属预期 |
| 端口转发（-L/-R/-D） | ✅ 用户级端口映射：`ssh/forward/list|start|stop` 支持 local、remote 与 SOCKS5 dynamic。连接右键动态“端口映射”二级菜单按已保存预设与运行状态提供管理、逐条启动/停止、批量启动和停止所有映射（`dynamic: true` 贡献点，需宿主 ≥0.6.30）；管理项在宿主弹框中打开，与 SSH 终端右上角按钮复用同一管理界面，不需要新终端会话。预设继续保存在宿主 `host.storage`，菜单后端只读同一插件数据文件。独立映射随连接断开清理。监听地址按方向提供本机或服务端候选；动态转发支持无认证 TCP CONNECT 与服务端域名解析，默认仅监听本机回环地址。 |
| Agent 转发（ForwardAgent/-A） | ❌ 不做 | **2026-09-07 用户决策**：转发类特性不做（认证侧 ssh-agent 已支持：SSH_AUTH_SOCK/自定义 socket/Pageant/agent 内证书身份，见 `ssh.rs authenticate_agent`） |
| X11 转发 | ✅ 已有（2026-09-24 M4 **翻转本节原「不做」结论**） | `backend/src/x11.rs` 全栈：DISPLAY 解析/假 MIT-MAGIC-COOKIE/.Xauthority/准入门 + PTY 后 `request_x11` + 服务端 x11 channel 显式 fail-closed gate；偏好 `x11_forwarding` 默认关、只读禁用（merge 75c5219，Windows 侧 unix-socket 形态报可读错误指路 VcXsrv TCP）；真机 X server 联调记遗留 |
| mosh/UDP 漫游、GSSAPI、ControlMaster、SSH console | ❌ 不做 | 需自研服务端组件/大额自研、或宿主已承担（连接管理/凭据）、或 GUI 客户端不适用；理由见 review 结论 |
| 批量登录、登录选择器/分组、记住密码、自动重连 | ✅ 已有（等价） | 分别对应批量发送（跨连接活跃会话）、DBX 连接管理、宿主 secret binding、断线自动重连 |
| 自动交互（Expect 系列：ExpectPattern/SendText/SendPass/CaseSendText/CaseSendPass/Timeout/SleepMS/PassSleep） | ✅ 已有 | 连接表单 `triggers_enabled`（独立 boolean，默认关闭）+ `triggers`（单一 textarea，仅开关打开后显示；已有文本不会自动启用；官方参考：<https://github.com/trzsz/trzsz-ssh>；可用 `triggers/validate` 复用 parser 检测）：多阶段正则按序匹配 PTY 输出（ANSI 剥离归一化、≤8 KiB 滚动缓冲跨 chunk 匹配），每阶段三选一应答——明文 `sendText`（`\r\n\t` 转义、`\|` 分段停顿 `sleepMs`）、密文 `sendSecretKey`、本地命令 `sendCommand`；case 预匹配（`casePattern` + `caseSend*`）命中不推进游标；阶段超时或 shell 提示复位重新武装；`passSleep`（none/each/enter）控制密文/命令应答节奏。引擎在 sidecar 终端读循环、先于终端 auto-sudo（互斥防双答），`ssh/trigger` 事件只报 `{sessionId, stage, kind}` 永不带应答内容。**0.4.77 输入兼容升级**：`triggers` 文本形态直接接受 tssh 规则原文（`#!!` 前缀可选；`ExpectCount`/`ExpectTimeout`/`ExpectSleepMS`/`ExpectPassSleep`/`ExpectPatternN`/`ExpectSendTextN`/`ExpectSendOtpN`/`ExpectCaseSendTextN`，`ExpectCount 0` 显式关闭；非合法正则按字面量匹配兜底），JSON 形态新增顶层 `"enabled": false` 保留规则并关闭引擎。**0.4.77 完全兼容升级**：tssh 密文/TOTP 应答指令全部支持——`ExpectSendPassN` / `ExpectCaseSendPassN` / `ExpectSendEncTotpN` / `ExpectSendEncOtpN` 的 `--enc-secret` 密文按 tssh 源码同款算法在 sidecar 解密（hex(nonce12‖AES-256-GCM)，固定内嵌密钥逐字节一致），`ExpectSendTotpN` / `ExpectSendEncTotpN` 按 RFC 6238（HMAC-SHA1/6 位/30 秒，与 pquerna/otp 默认一致）在命中时刻生成验证码；JSON 形态相应新增 `sendSecret` / `sendTotp` / `caseSendSecret` 应答字段。**差异**：`ExpectSendPass` 亦可继续走宿主 secret binding（`trigger_answer_1/2` 连接表单槽位）；exec/命令通道不接入（仅 PTY 终端会话） |
| 外部密码管理器（PasswordCommand/PassphraseCommand） | ✅ 已有 | 连接表单 `password_command` / `passphrase_command`（0.4.74）：登录密码/私钥口令缺失时本地执行命令取回（gopass、1Password CLI、`oathtool` 等），占位符 `%h`/`%u`/`%p`/`%n`/`%%`，`sh -c`/`cmd /C` 执行、10s 超时、stdout 去单个结尾换行；优先级 显式凭据 > 命令（对齐 tssh「加密 > 命令 > 明文」的插件侧映射——加密层由宿主 secret binding 承担）；`password_command` 在拨号认证的 orchestration 构建前一次性解析，登录链与 sudo 编排共用；命令日志只记已执行/失败退出码，输出用后 zeroize |

## openocta 对标补充（2026-09-11，0.4.52）

以 [openocta/openocta](https://github.com/openocta/openocta)（AIOps 运维智能体平台，
Go Gateway + Agent Runtime + Skills + MCP 客户端）为参照的运维闭环能力借鉴
（实施计划 `docs/IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT.zh-CN.md`；SSH 传输层不对标
——对方依赖系统 openssh-clients，本插件自研 russh 深度领先）：

| openocta 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| 审批队列持久化（`src/pkg/security/approval_queue.go` 按 storePath 单例 + 持久化批准存储） | ✅ 已有（等价增强） | 审批弹窗「记住此命令」（`ssh/agent/resolve remember`）→ 连接级免审批清单 `agent-approved-commands.json`，匹配复用 sudoers 式 token 语义、可手工泛化通配；破坏性命令拒绝入库且命中重检无效（灾难门永不绕过） |
| 执行可追溯（事件总线 + 审批中间件） | ✅ 已有（SSH 域内） | 执行审计 JSONL（`audit-log.jsonl`，5 MiB 轮转）：MCP/AI 执行面每调用一条（gate/outcome/exitCode/耗时/**命令文本 + 输出尾部**，0.4.77 起记录 `command` ≤512 字符与 `output` ≤1024 字符，旧行按 null 回放）+ 审批生命周期一条（approved/denied/timeout/remembered，带命令文本）；`ssh/audit/list` 只读回放；工作台人工操作按既定信任模型不记 |
| 告警标准化 + 固定分析 Prompt（`/hooks/alert`） | ✅ 已有（插件侧形态） | `ssh_alert_triage` 工具 + `ssh/alert/triage` RPC：异构告警 JSON/纯文本 → 结构化（相同兼容语义：解析失败整包当 message）+ 双语关键词分类 + 白名单级只读诊断命令清单；分析与执行分离（分诊在插件、推理在外部 Agent），不接收 webhook（宿主契约之外） |
| 主机巡检场景（`deploy/scenarios/host-inspection`） | ⏸ 未做（另有对标项） | 一键巡检报告（复用 `ssh/metrics` + `ssh/exec` 的配方化组织）列为后续候选，见对比评审结论 #1 |
| 定时调度（`src/pkg/cron`）、IM 渠道指挥（channels）、数字员工（employees） | ❌ 不做 | 宿主/生态层职责（sidecar 生命周期受宿主管理，长期定时任务不合适；IM 渠道超出插件契约）；角色预设包（快速命令组 + sudo 白名单模板组合）列为后续候选 |

## sshbool 对标补充（2026-09-11，0.4.52）

以 [omarsenusi/sshbool](https://github.com/omarsenusi/sshbool)（Tauri v2 + russh +
React 19 独立桌面 SSH 工作台）为参照的能力借鉴（实施计划
`docs/IMPL_PLAN_SSH_VAULT_TRANSFER_HISTORY.zh-CN.md`；SSH 传输层双方同级单连接
多路复用，其每次操作新开 SFTP channel 的做法劣于本插件会话级复用）：

| sshbool 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| 本地凭据静态加密（SQLCipher 库 + Argon2id KEK + AES-256-GCM DEK 信封） | ✅ 已有（keyfile 默认档） | `quick-sudo-profiles.json` 升 v2：密钥字段 AES-256-GCM 信封（AAD 绑定字段+档案 id）、DEK 默认存同目录 0600 keyfile，OS keychain 仅显式选入（`DBX_SSH_VAULT_STORAGE=keychain`；macOS 每次更新都会重弹授权框，见 IMPL_PLAN D2a）、遗留 keychain 档自动迁移；v1 自动迁移、解密失败按空降级；实施计划特性 A |
| 传输任务持久化（`transfer_jobs`/`transfer_items` 表） | ✅ 已有（轻量形态 + 断点续传） | `transfer-history.json` 环形 200 条 + `sftp/transfer/history` 持久化/live 合并查询，仅状态跃迁落盘；上传断点续传（spool+meta 保留 → `resumeTaskId` 续传）与下载 `offset` 恢复 + 会话内暂停/恢复已落地（2026-09-12 iShell Pro 对标批，见下节）；实施计划特性 B1 |
| SFTP 书签（`sftp_bookmarks` 表 + 双栏书签） | ✅ 已有 | `sftp-bookmarks.json` + `sftp/bookmarks/list` / `save` / `delete` + 路径栏星标收藏/下拉跳转（七语）；实施计划特性 B2 |
| 主密码 Vault（解锁屏 / 自动锁定 / 生物识别 / FIDO2） | ❌ 不做 | 宿主插件形态下无人值守 sudo 自动应答要求重启免解锁；keychain 托管已覆盖“防拷贝/备份外泄”目标，主密码模型收益不成立 |
| 端口转发（`channel_open_direct_tcpip` 本地转发，数据库面板经隧道连 DB） | ✅ 已有（沿 2026-09-22 用户级端口映射立项，见上方 -L/-R 行；ProxyJump 数据库代拨仍归宿主隧道，不重复） |
| 监控历史趋势（`host_snapshots` + 分桶 `metric_series` 落盘 + 趋势图） | ✅ 已有（轻量形态） | `metrics-history.jsonl` 环形 720 行按连接落盘 + `ssh/metrics/history` 查询 + 打开指标卡回填 CPU/内存/网速 sparkline（2026-09-12 落地）；无分桶聚合（环形全量即可覆盖 1h 视窗）；进程管理（`ssh/processes/list`+`kill`）同批落地 |
| 终端 BiDi/阿拉伯语变形（`arabic-xterm.ts` 词级 reshape 保词序 + shell UTF-8 locale） | ⏸ 未做（候选） | xterm.js 原生无 BiDi/shaping；本插件 UI 七语无阿拉伯语，但终端输出内容可能含 RTL 文本，shaping 管线可放 `shared/frontend/` 公共层单点实现 |
| 审计账 + 审计面板（`audit_log` 表 + audit-panel） | ✅ 已有（SSH 域内） | MCP/AI 执行面 JSONL 审计 + `ssh/audit/list`，见上节 openocta 对标（本批前已落地） |

## iShell Pro 对标补充（2026-09-12）

以 [iShell Pro](https://ishell.cc/)（六协议独立终端平台 v3.0，免费+订阅）为参照的能力差距收敛。
产品形态不同（宿主内插件 vs 独立终端），仅取终端/SFTP/监控域内可对齐项。本节登记时
「协议广度（RDP/VNC/Telnet/串口）、端口转发、X11 转发」仍列为不做——其后已分批翻转：
Telnet/串口/VNC 已全栈落地（M2/M4/M5，见 PROGRESS 2026-09-24 收口记录）、X11 转发已实现
（M4，merge 75c5219）、端口转发 -L/-R 已内置（2026-09-22 用户决策翻转，见 tssh 节）、
RDP 已收官（2026-09-25，vendored IronRDP 链 RDP-1/2/3，真机 server 联调为人工门，
见能力总表 RDP 行）、会话导入已补齐 7 种外部客户端格式（M7 P0-2，见能力总表）；
仍不做的收敛为多标签分屏（宿主工作台承担）、云同步、隐私遮蔽等（宿主承担或超出插件契约）。

| iShell Pro 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| SFTP 传输断点续传 / 暂停恢复 | ✅ 已有（同批落地） | 上传：中断任务 spool+meta 保留 → `sftp/transfer/resumable` 列出 → `sftp/upload/start resumeTaskId` 从已传前缀续传（文件名+字节数双校验）；下载：`sftp/download/start offset` 恢复（size 一致性 best-effort）；会话内暂停/恢复为分片间挂起（前端纯语义）。iShell 的传输器形态（独立客户端常驻）与之不同，语义对齐 |
| 下载本机落盘 + 文件管理器定位（无 fileTransfer 宿主） | ✅ 已有（2026-09-15 修复批） | 宿主缺 `fileTransfer` 且 webview 会静默取消 `<a download>`（wry 无 download handler），此前下载"显示已完成但文件不存在"。现 `sftp/download/start saveToLocal` 由 sidecar 直写 `~/Downloads`（去重改名，`DBX_SSH_DOWNLOAD_DIR`/`DBX_SSH_LOCAL_SAVE` 可覆盖探测），`finish` 返回 `localPath` 并落进传输历史；完成通知/传输面板/历史展示路径，`local/reveal`（macOS `open -R`/Windows `explorer /select,`/Linux `xdg-open`）一键定位，仅允许 reveal 历史记录过的路径；web/docker 探测 false 时保留浏览器下载兜底；权限不足/文件不存在错误转七语友好提示（`lib/sftpErrors.ts`） |
| 实时监控趋势（历史曲线 1–60s 采样） | ✅ 已有（轻量形态） | `metrics-history.jsonl` 环形 720 行 + `ssh/metrics/history` 回填 sparkline；采样间隔跟随指标卡 5s 轮询，不做独立采样线程与分桶聚合 |
| 进程管理（列表 + SIGTERM/SIGKILL 终止需确认） | ✅ 已有 | `ssh/processes/list`（500 行 CPU 序）+ `ssh/processes/kill`（pid 0/1 拒绝、signal 白名单 1/2/9/15、前端 confirm 门禁）；iShell 的句柄数/监听端口维度未做 |
| 会话录制回放 + GIF 导出 | ✅ 已有（同批新增） | `ssh/recording/*` 五方法：asciicast v2 `.cast` 落盘（会话关闭自动收尾）、`ssh/recording/get` 分页回放（xterm 重放、0.5–4× 倍速、进度条 seek）、GIF 导出（离屏 xterm 逐事件重放 + 500ms 抽帧 + 零依赖 GIF89a 编码器，封顶 120 帧）。iShell 的暂停/快进/水印/帧率质量参数未做 |
| GPU 监控、大文件扫描、主机巡检报告 | ⏸ 未做（候选） | GPU 依赖远端 nvidia-smi 等工具可用性；大文件扫描与巡检报告维持"另有对标项"候选结论 |
| SFTP 下载限速 | ✅ 已有（2026-09-26，issue #66 / M31-B） | 偏好 `transfer_download_limit_kib`（设置 → 传输数值输入，KiB/s，0=不限速缺省，上限 1 GiB/s）：sidecar 在下载任务启动时快照现值，单文件与递归目录下载的分块循环按「理想耗时 − 实际耗时」逐块补等待，限速 0 时零开销；改动对下一个下载任务生效，sudo 下载（独立车道）本期不限速。协议见 PROTOCOL「下载限速生效口径」段 |
| 终端 WebGL GPU 加速渲染 | ✅ 已有（2026-09-13 落地） | `@xterm/addon-webgl`（0.18.0，配 xterm 5.5）：主终端默认挂 GPU renderer（localStorage 偏好 `ssh-terminal-webgl`，设置弹窗「终端渲染」开关即时切换）；WebGL 不可用（headless/无 context/驱动限制）构造即回退 DOM 渲染器，context loss（GPU 重置）自动 dispose 回退；回放弹窗与 GIF 导出的离屏终端刻意保持 2d canvas（导出依赖 drawImage 稳定路径、且浏览器 WebGL context 总数有限）。纯逻辑（偏好/挂载/回退/切换）独立模块 `terminalWebgl.ts` + 单测 7 |

## NetCatty 对标补充（2026-09-11 立项，2026-09-13 收口）

以 binaricat/Netcatty（Electron SSH 客户端，内置 MCP server 面向 AI agent）为参照的
五项能力落地（实施计划 `docs/IMPL_PLAN_NETCATTY_PARITY.zh-CN.md`；期间 mcp.rs 事故
导致 A1/A2 首次实现回退，2026-09-12 重放落地，全程记录见 `PROGRESS-P-SSH` 同日章节）：

| NetCatty 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| MCP 权限档（permission mode）+ 作用域会话 | ✅ 已有 | `mcp/settings` 新增 `execPermissionMode`（autonomous 默认 / confirm——写类与 exec 族工具在全部既有门通过后、执行前经 `ssh/agent/prompt` 人工审批，stdio 无工作台 fail-closed 立即拒绝）+ `connectionScope` 作用域白名单（条目匹配连接 id / 连接名 / 主机名 ASCII 大小写不敏感；越界整体拒绝、`ssh_list_connections` 只回作用域内条目、作用域非空时内联凭据拨打整体拒绝）；进程级 env 覆盖 `DBX_SSH_MCP_PERMISSION_MODE` / `DBX_SSH_MCP_CONNECTION_SCOPE` |
| multi_host_execute / terminal_send_input | ✅ 已有 | `ssh_multi_exec`（1–10 连接聚合执行，parallel/sequential + stopOnError 首败短路；sudo 整体拒绝、灾难门与只读白名单逐目标生效）+ `ssh_terminal_input`（向存活终端会话注入原始输入，交互应答/Ctrl+C 语义；只读连接仅放行纯控制序列；输出不收集），工具数 29→31（历史口径，同上——当前 `tool_definitions()` 实际 33 个，2026-09-26 审计复核） |
| 终端关键词高亮（README Features） | ✅ 已有 | `highlight_rules.rs` 存储（上限 30、文件 0600、首启播种后永不重播）+ `ssh/highlightRules/list\|save\|delete`；22 条按严重度分色的默认规则（红=ERROR/FATAL/Permission denied…、琥珀=FAIL/denied/timed out、黄=WARN/deprecated、绿=SUCCESS/PASSED 区分大小写、蓝=IPv4 正则；长短语优先）；前端 `keywordHighlight.ts` 纯函数 + xterm onRender 视口自绘着色（rAF 节流、单行/全局上限、总开关 `ssh-keyword-highlight`）+ 管理入口（2026-09-26 M32-A：工具栏弹层移除，增删改/启停迁「设置 → 终端」`HighlightRulesSection.vue`，渲染链路不变；regex 合法性由前端保存前校验） |
| 连接日志审计（ConnectionLogsManager） | ✅ 已有（等价收敛） | MCP/AI 执行面 JSONL 审计（`audit-log.jsonl`，5 MiB 单代轮转 `.1`）：gated 工具每调用一条（gate/outcome/exitCode/耗时/命令 ≤512 字符 + 输出尾部 ≤1024）+ 审批生命周期 + exec/终端 auto-sudo 事件；`ssh/audit/list` 工作台只读查看（kind 过滤/truncated 提示）+ `ssh/audit/clear` 清空；与 openocta 对标批同源（见上节），agent 面无审计工具，人工工作台操作不记 |
| 流量图 / 发行版徽标（TrafficDiagram/DistroAvatar） | ✅ 已有（去资产化） | `lib/metricsSparkline.ts` 60 点环形 SVG（rx/tx 双曲线）+ `lib/distroBadge.ts` 14 发行版纯 CSS monogram（圆角方块 + 首字母 + 主题色变量，**不引入任何图片资产**——Netcatty SVG 资产为 GPL-3.0，刻意隔离）；`ssh/metrics` 追加可选 `osId`/`osPretty`（os-release 解析，缺失整体省略，旧 sidecar 不渲染徽标不报错） |
| 云同步（CloudSyncManager） | ❌ 不做（宿主基础能力提供） | DBX 宿主基础能力已提供配置同步/上传（2026-09-25 决策）；插件侧不再立项，口令加密导出导入降维方案一并除名 |

本批同步登记明确不做（IMPL_PLAN §7）：sftp/sudo 文件写操作的审计埋点（审计面现只覆盖
exec 族 + 审批生命周期 + auto-sudo）、审计日志分页/导出（v1 只读最近条目）、作用域
条目的 host+username 粒度（v1 只到 host）、`ssh_audit` 只读 MCP 工具（与「agent 不可读
审计」原则冲突，除非未来加独立开关）。

## Tabby 主题对标补充（2026-09-22，`codex/ssh/terminal-themes` 分支）

以 [Tabby](https://github.com/Eugeny/tabby) 的终端外观体系为参照，把「配色方案 + 多套主题 +
排版细项」按 Tabby 的语义模型迁移进插件工作台。**纯前端改动，后端零改动**（无新增协议方法，
因此无新增 smoke 用例——见下方「验收口径」）。

### 迁移来源与授权

| 来源 | 内容 | 授权 |
| --- | --- | --- |
| `tabby-terminal/src/colorSchemes.ts` | Tabby Default / Tabby Default Light 两套出厂配色（`#171717`/`#cacaca`） | MIT |
| `tabby-community-color-schemes/schemes/*` | 190 个 Xresources 配色文件 | MIT（上游 iTerm2-Color-Schemes，MIT） |

共 **192 套内置配色**（2 出厂 + 190 社区）。上游 191 个文件中的 `Melange Dark` 只声明了
1 个 ANSI 色（不足 16 色，Tabby 自身解析器同样会截断产出不完整方案），已跳过并在产物头部注明。
配色表以**紧凑元组数组**（`readonly TerminalSchemeTuple[]`）落库而非 192 个对象字面量，
目的是压住包体；同一份表由 `scripts/gen-terminal-schemes.py` 生成，**可重跑复现**：

```bash
python3 scripts/gen-terminal-schemes.py   # 重新扫描 Xresources → 覆写 terminalSchemeCatalog.ts
```

生成器刻意**复用 Tabby 自己的解析语义**：扫描 `#define` 变量表做值替换，按 `color0..color15`
**顺序**收集并在第一个缺口处停止。TS 侧 `schemeIdFromName` 与生成器的 slug 规则逐字对齐
（`[^a-z0-9]+` → `-`，去首尾 `-`，空则回落 `scheme`）——两边规则一旦漂移，导入去重就会失效。

### 「不重复宿主」原则的守卫方式

本仓库既有原则是「全局外观由宿主承担，插件不重复实现」（见文首与开发规范第 3 条）。
本轮不改这条原则，而是把它做成**默认态**：

- `schemeSource` 默认 `"host"`。此时 `applySchemeToTerminalTheme()` **原样返回宿主基底主题**，
  终端观感与改动前逐值相等（默认值 `bar` 光标 / 1.15 行高 / 0 字间距 / 左10·右0·上5·下8 内边距
  与旧硬编码一致，由单测 `terminalOptionPatch(DEFAULT) === TERMINAL_OPTION_DEFAULTS` 钉住）。
- 只有用户显式选「使用配色方案」才覆盖背景/前景/16 色。宿主仍在负责它自己的面板配色；
  插件只新增「终端区域可被用户单独指定」，与宿主互不争夺。
- 宿主切换亮/暗时（`appearance.colorScheme`）自动在**深浅双槽**间切换：`darkSchemeId` /
  `lightSchemeId` 各挂一套，由此满足「黑白主题配置选择」。

### 能力清单

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 192 套内置配色目录 | `frontend/src/lib/terminalSchemeCatalog.ts`（生成物） | 紧凑元组 + 溯源头部（授权、上游、重生成命令、跳过文件说明） |
| 配色纯逻辑层 | `frontend/src/lib/terminalScheme.ts` | 类型、目录索引、亮暗判定（WCAG 相对亮度 > 0.5 为亮）、搜索/色调过滤、主题合成、四格式导入解析器 |
| 偏好模型与持久化 | `frontend/src/lib/terminalAppearance.ts` | `ssh-terminal-appearance` 单键；自定义方案上限 60、自定义主题上限 30（localStorage 单键约 5 MB 的容量压力） |
| 多套主题（快照） | 同上 `TerminalAppearanceProfile` | = 外观设置 + 字体（family/size）。Tabby 原生下拉只放 2 套配色，而「配置多套主题」需要连字体/间距一起存，故按**快照**建模 |
| 出厂预设 | 同上 `TERMINAL_APPEARANCE_PRESETS` | 跟随宿主 / Dracula / Nord / Tokyo Night / Gruvbox / 高对比，共 6 套 |
| 排版细项 | 同上 `TerminalOptionPatch` | 字重、粗体字重、行高、字间距、横向/纵向内边距、光标样式（block/underline/bar）、光标闪烁、失焦光标样式、粗体用亮色、最小对比度 |
| 方案导入 | `terminalScheme.ts` 四个 parser | Xresources（Tabby/类 Unix）、iTerm2 `.itermcolors`（plist）、Windows Terminal（JSON）、Tabby（YAML）。YAML 走**手写缩进扫描器**，不引 YAML 库 |
| 可视化预览 | `frontend/src/components/TerminalAppearancePreview.vue` | 纯 DOM 实时预览（不实例化真 xterm）：`ls -la` 配色样例、选区色块、粗体样例、光标样式动画（`prefers-reduced-motion` 降级）、低对比度告警（< 4.5:1） |
| 方案选择器 | `frontend/src/components/TerminalSchemePicker.vue` | 深浅双槽页签 + 搜索 + 全部/亮/暗过滤 + 「跟随宿主」行 + 每行 16 色色块 + 自定义徽标 + 色调标签 + 空态 |
| 设置入口 | `frontend/src/components/SettingsDialog.vue` | 新增「外观」分类并置于**首位**、弹窗默认落在该分类；原「终端字体」块移出终端页，留七语指引 |
| 跨表面外观同步（2026-09-30 补） | `frontend/src/lib/appearanceSync.ts` + `frontend/src/composables/useAppearanceCrossSurfaceSync.ts` | tab 工作台与 dock 底部栏面板是两个独立 webview，外观三键（`ssh-terminal-appearance`/`-font-family`/`-font-size`）写穿宿主 storage 后对端无通知（桥无 storage 变更事件）——host 通道 1.5s 低频轮询直读桥（隐藏期间停拍、复现/聚焦即补），localStorage 档（浏览器直连）另有原生 `storage` 事件即时补拍；双闸门状态机防「本端写穿未落地被读回旧值回落」，外观/字体两键族各自独立判定。桥返回值按 pluginStore 水合同一语义归一（字符串原样/对象 stringify） |
| dock 面板终端快捷区（2026-09-30 补） | `frontend/src/App.vue`（`panel-actions` 工具条 + `panel-toolbar-left` 信息带）+ `frontend/src/style.css` | dock 底部栏（`surface=panel`）工具条从整体隐藏改为精简快捷区：左组**系统信息带**（CPU/内存/↓↑网速，复用 `ssh/metrics` 的 5s 环境轮询与 `refreshMetrics` 采样环，指标卡打开时让位；数据未就绪/旧 sidecar 缺字段整条隐藏；SSH 场景请求失败改为降级占位带（CPU/MEM –% 弱化，tooltip 携带失败原因，下一拍成功自愈——不再无声消失），本地终端的平台性缺失（Windows 无 sh）保持整条隐藏；2026-09-30 起本地终端也显示——新方法 `local/metrics` 以同一采集脚本采 sidecar 宿主机本机（macOS 走 sysctl/vm_stat/netstat 兜底；Windows 无 sh 结构化报错整条隐藏；GPU/NPU 保持 SSH-only），telnet/serial/vnc/rdp 不适用）；右组字号 A−/A+、**录屏**（`toggleRecording`，录制中红色高亮；SSH 会话与本地终端都可录——sidecar 新方法 `local/recording/start|stop` 给本地 PTY 挂同一 asciicast 录制器，`.cast` 进同一 recordings 目录，回放/GIF 导出全家族通用）、**SFTP 传输**（`toggleTransferPanel` 弹层 + 活跃计数点）、配色快切弹层（按当前宿主明暗档过滤同调性方案 + 「跟随宿主」+ 「更多设置」入口）、设置齿轮、**工具条收起**（偏好落 `ssh-panel-toolbar-hidden` 单键，隐藏后右上角低透明度微钮还原）；30px 紧凑行 + 透明 ghost 按钮（去条底色/分隔线，hover 才显形），弹层窄体 + 列表内滚适配矮面板。**SFTP 文件面板**可在 dock 手动开合（`toggleSftpPane`，默认仍不开、不自动建 SFTP 会话；连接建立时 `loadDirectory` 已拉列表，打开即有数据）；另有「在 tab 打开当前连接」按钮（`openNewSessionTab` → 宿主 `openWorkbench`；2026-09-30 起携带 `target: "tab"` 桥选项——宿主 dock 处理器识别后路由到主工作台 tab（复用 `queryStore.openPluginWorkbench` 的复用/会话编号语义），复制会话/命令会话同款；旧宿主忽略该选项回落「新增 dock 条目」既有行为） |

光标形状/宽字符/折行等**几何**行为不受影响——`terminalClickCursor.ts` 原地定位逻辑照旧，
本轮只把 `cursorStyle` 从硬编码 `"bar"` 改为可配置、默认值不变。

### 三处需要留意的接缝

1. **DOM 沙箱与 localStorage**：工作台 iframe 是 `sandbox="allow-scripts"`（不透明源），
   在**默认参数位置**读 `window.localStorage` 会抛 `SecurityError`。故所有存储访问都在函数体
   `try` 内（`terminalFont.ts` / `terminalWebgl.ts` 既有同一模式，本轮 `terminalAppearance.ts` 沿用）。
2. **FitAddon 与内边距**：内边距必须挂在 `.xterm`（即 `terminal.element`）而不是宿主 div 上，
   否则 FitAddon 会多算一行。故内边距经 CSS 变量下发、由 `style.css` 的
   `.terminal-host .xterm` 消费，未设置的方向 `removeProperty` 回落内置值。
3. **字体单一事实源**：字体仍由既有 `terminalFontOverride` 权威持有；`terminalAppearanceState`
   只是**计算合并**用于展示与主题匹配。`setTerminalFont` 保留 `null`（而非折成宿主具体值）——
   否则主题快照与实况永不相等，主题高亮会永远失效。

### 验收口径

- 基线 SHA：`acddf777ac5943adda4912e77090e59a0cc3726e`（main）。
- 新增单测 **44 例**（`terminalScheme.spec.ts` 18 + `terminalAppearance.spec.ts` 26），
  全量 vitest **66 文件 / 605 用例全绿**；`vue-tsc --noEmit` 通过；Vite 打包通过
  （3.35 MB 自包含 UI，仅剩既有 trzsz externalize 与 chunk size 告警）。
- `python3 scripts/validate_repo.py`、`node scripts/connection-forms/verify.mjs` 均 PASS。
- 无新增 smoke 用例：本轮未注册任何 sidecar 方法，按开发规范第 6 条
  「未注册方法 SKIP 而非 FAIL」，smoke 家族不适用。
- **不提交 `ui/`**：`frontend/build.mjs` 输出到 `../ui`，而 `ui/` 与 `dist/` 属 integrator
  所有权（`.github/agent-flow.yml`），打包由 integrator 统一执行。
- 七语文案（zh-CN/zh-TW/en/es/it/ja/pt-BR）全量补齐；`workbench.spec.ts` 的
  key 集合与占位符对齐断言覆盖新键。
- 未新增任何运行时依赖（YAML 导入为手写扫描器）。

## Tabby 终端行为与快捷键对标补充（2026-09-22，同分支第二轮）

> 状态补注（2026-09-25 M13 文档同步轮核实）：本节与上一轮主题对标的改动已随
> `codex/ssh/terminal-themes` 线合入 `codex/ssh/nyaterm-parity-integration`
> （`f1c764c3 feat(settings): add Tabby-parity terminal behaviour and hotkey settings`），
> 能力总表对应行已补。以下原文保留，供实现细节与验收口径查证。

接上一轮的「外观」对标，补齐 Tabby 设置面的另外两块：**Terminal**（行为）与 **Hotkeys**
（快捷键）。同时按 Tabby 的分类粒度把原「外观」拆成「外观 / 配色方案」两页。仍然是
**纯前端改动、后端零改动**（无新增 sidecar 方法，smoke 家族不适用）。

### 分类对齐

Tabby 把 Terminal 设置注册为三个页签，并对 Appearance 与 Color scheme 标记 `prioritized`。
本轮据此把本插件的设置导航重排为：**外观 → 配色方案 → 终端 → 快捷键**，再接本插件特有的
sudo / 智能体 / 传输 / 安全 / MCP。

| 页签 | 对标 Tabby 页签 | 内容 |
| --- | --- | --- |
| 外观 | Appearance | 字体与字号、字重、粗体字重、行高、字间距、内边距、光标、粗体用亮色、最小对比度 + 实时预览 |
| 配色方案 | Color scheme | 主题快照（预设 6 套 + 用户保存）、实时预览、深浅双槽配色方案、终端背景来源、四格式导入 |
| 终端 | Terminal | 渲染 / 键盘 / 鼠标 / 剪贴板 / 声音 五组 |
| 快捷键 | Hotkeys | 注册表编辑器：分组列出、搜动作名、点键位录制、冲突标注、单项与整体复位 |

### 新增模块

| 模块 | 职责 |
| --- | --- |
| `frontend/src/lib/terminalBehavior.ts` | 行为偏好的类型、默认值、归一化、持久化、xterm 选项映射、右键四档判决、粘贴文本变换、链接修饰键判定 |
| `frontend/src/lib/terminalHotkeys.ts` | 快捷键动作表、平台默认、`event.code` → 组合串折算、组合串解析与规范化、平台化显示、匹配与冲突检测 |
| `frontend/src/components/TerminalHotkeyEditor.vue` | 快捷键编辑器（唯一样式化交互新组件） |

`frontend/src/lib/terminalInteraction.ts` 中原有的 `sanitizeSelectCopyEnabled` /
`resolveTerminalRightClickAction` / `resolveTerminalKeyAction` / `isTerminalSelectAllShortcut`
四个硬编码判决器**已删除**，由上述两个可配置模块取代；`terminalInteraction.ts` 只保留
平台判定、搜索选项与拖放判定。

### 默认值：逐项复现改动前行为

这一轮的功能全部是「把原来写死的换成可配置」，因此**每个默认值都必须等于改动前的硬编码值**，
否则升级即等于静默改变用户终端行为。逐项对照如下（括号内为 Tabby 默认值，不同处已注明理由）：

| 设置 | 本插件默认 | 与 Tabby 的差异及理由 |
| --- | --- | --- |
| 回滚缓冲行数 | 25000 | 与 Tabby 相同；改动前即硬编码 25000 |
| Alt 用作 Meta 键 | 关 | 与 Tabby 相同 |
| 输入时滚到底部 | 开 | 与 Tabby 相同（xterm `scrollOnUserInput` 上游默认亦为 true） |
| 右键语义 | **粘贴** | Tabby 为「上下文菜单」。沿用本插件既有行为，且 `Shift+右键` 出菜单的逃生口保持不变 |
| 中键粘贴 | 关 | Tabby 在 macOS 亦为开（但那是 X11 主选区语义，浏览器里读到的是普通剪贴板，故保持可选） |
| 词分隔符 | `` ()[]{}\'" `` | 与 Tabby 相同 |
| 链接修饰键 | 无 | 与 Tabby 相同（链接始终可点） |
| 选中即复制 | **开** | Tabby 为关。沿用本插件既有行为；旧键 `ssh-terminal-select-copy` 作为兼容镜像继续读写 |
| 括号粘贴 | 开 | 与 Tabby 相同（xterm 选项是反向的 `ignoreBracketedPasteMode`） |
| 多行粘贴警告 | 开 | 与 Tabby 相同；关闭只影响多行/超长提示，**危险命令（`rm -rf` 等）的确认不受该开关约束** |
| 换行折空格 | 关 | 与 Tabby 相同 |
| 去首尾空白 | **关** | Tabby 为开。保持关，粘贴内容逐字节不变 |
| 终端响铃 | 关 | 与 Tabby 相同 |

### 两处有意的行为变更（需 review 关注）

1. **非 Apple 平台「终端搜索」默认键位由 `Ctrl+F` 改为 `Ctrl+Shift+F`**（对齐 Tabby；
   macOS 仍为 `Cmd+F`）。原因：`Ctrl+F` 是 readline 的 `forward-char`，绑定搜索会把它从远端
   shell 手里抢走；本插件此前占用该键位是与 Tabby 的偏差而非特性。此变更通过新的快捷键编辑器
   可随时改回，属显式放开而非收紧。
2. **「选中即复制」从独立开关收敛为「剪贴板」组内的一项**，且右键语义从「选中复制 ⇒ 右键粘贴」
   的隐式联动改为独立四档。改动前 `resolveTerminalRightClickAction` 是「选中复制开 ⇒ 右键粘贴」，
   对应现在的默认组合（`rightClick: "paste"` + `copyOnSelect: true`），**逐例等价**；但用户若只改
   其中一项，不再联动另一项（这正是四档模型的目的）。同时退役了被取代的文案键
   `terminalSelectCopy.section` 与冗余键 `terminalBehavior.copyOnSelect`。

### 能力清单

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 渲染组 | `terminalBehavior.ts` → `terminalBehaviorOptionPatch` | WebGL 渲染器（沿用既有开关）、回滚缓冲（100–200000，越界夹取） |
| 键盘组 | 同上 + `App.vue` | Alt 作 Meta（`macOptionIsMeta`）、输入滚到底（`scrollOnUserInput`）、词分隔符（`wordSeparator`，超 32 字符截断） |
| 鼠标组 | `resolveRightClickBehavior` + `App.vue` | 右键四档 off / menu / paste / clipboard（无选区粘贴、有选区复制）+ `Shift` 恒定出菜单；中键粘贴；链接修饰键（none/ctrl/alt/shift/meta） |
| 剪贴板组 | `transformPasteText` + App | 选中即复制、括号粘贴、多行粘贴警告、换行折空格、去首尾空白。变换与确认收口在 `sendConfirmedPaste`，所有粘贴路径共用 |
| 声音组 | `App.vue handleTerminalBell` | 三态 off / visual / audible。xterm 6.x 已移除 `bellStyle` 只抛 `onBell`，故视觉态走 `::after` 覆盖层 CSS 动画（150ms），听觉态用 WebAudio 现场合成（不引音频资源），沙箱拒建 `AudioContext` 时退化为视觉闪动 |
| 快捷键注册表 | `terminalHotkeys.ts` | 10 个动作（搜索/复制/粘贴/全选/清屏/放大/缩小/复位字号/滚到顶/滚到底），按剪贴板·视图·导航三组 |
| 组合串口径 | `keyComboFromEvent` / `sanitizeKeyCombo` | 基于 `event.code` 而非 `event.key`，故 `Ctrl+=` 与 `Ctrl+Shift+=` 不会塌成一个；`Shift` 因此必须恒保留为修饰键 |
| 编辑器 | `TerminalHotkeyEditor.vue` | 动作名搜索、点键位录制（再点取消、`Esc` 取消、纯修饰键不自成一体）、裸键拒绝、同动作内去重、每动作上限 3 条、冲突标注（不拦截）、单项复位与整体复位 |

### 刻意不做的项（附理由）

| 未做 | 理由 |
| --- | --- |
| 连字（Ligatures） | `@xterm/addon-ligatures` 经 opentype.js 触达 Node 内置模块，在本插件的沙箱 iframe 中会崩（既有 App 注释已记录），给不出诚实的开关 |
| Sixel 开关 | 图片渲染已由 `ImageAddon` 固定开启（32 MiB 像素上限），做成开关需要条件加载插件，收益不足 |
| 会话启动 / 窗口（COMSPEC、环境刷新）/ 任务栏闪烁 | 属宿主或 Electron 专有，插件工作台内无对应物 |
| 复制为 HTML | 需要新依赖；纯文本终端下收益有限 |
| Tabby 的 `Ctrl+±` 字号键位 | 与既有的 `Ctrl/Cmd+滚轮` 缩放重叠，避免两套口径打架（该动作仍可在编辑器里自行绑定） |
| 新建标签页 / 分屏 / 退出 / 重开已关标签 / 上一个提示符 | 工作台的标签与分屏归宿主所有，插件注册这些动作只会得到一堆死绑定 |
| 「智能 Ctrl-C」独立动作 | Tabby 用专门动作表达「有选区则复制、否则中断」；本插件的 `copy` 动作已是同一语义，无需再拆 |

### 需要留意的接缝

1. **`bellStyle` 已不存在**：xterm 6.1-beta 只保留 `onBell: IEvent<void>`。响铃三态必须由调用方
   在事件里自行实现；视觉态用 `::after` 覆盖层而非宿主自身的 `outline`/`box-shadow`，因为宿主背景
   已被 xterm 画布铺满，只有独立伪元素能稳定压在最上层。
2. **组合串必须基于 `event.code`**：若用 `event.key`，`Shift` 会把字母改写成大写、把 `=` 改写成 `+`，
   `Ctrl+=` 与 `Ctrl+Shift+=` 就会塌成同一个键位。代价是 `Shift` 必须始终作为修饰键保留。
3. **匹配读表是实时的**：`handleTerminalKey` 每次按键都查一次注册表，因此改键位无需重挂钩子；
   钩子只在 `createTerminal` 里挂一次。
4. **录制期事件必须吞掉**：编辑器在 `window` 捕获阶段监听并 `preventDefault`。设置弹窗是模态的，
   终端拿不到焦点，故不影响会话；但若将来设置改成非模态，这里需要重新评估。

### 验收口径（本轮）

- 基线 SHA：`dc36c9d`（上一轮主题对标的提交，同一分支继续）。
- 新增单测 **77 例**：`terminalBehavior.spec.ts` 29 + `terminalHotkeys.spec.ts` 33 +
  `TerminalHotkeyEditor.spec.ts` 15。全量 vitest **69 文件 / 675 用例全绿**；
  `vue-tsc --noEmit` 通过。
- 无新增 smoke 用例：本轮未注册任何 sidecar 方法，按开发规范第 6 条「未注册方法 SKIP 而非 FAIL」。
- **不提交 `ui/`**：同上轮，`frontend/build.mjs` 输出到 `../ui` 属 integrator 所有权，
  本轮验证性打包写入 `/tmp` 下的临时目录。
- 七语文案全量补齐；同时退役两个被取代的键，`workbench.spec.ts` 的 key 集合与占位符对齐断言覆盖。
- 未新增任何运行时依赖（听觉响铃为 WebAudio 合成，无音频资源文件）。

### UI 走查（e2e）

新增 `scripts/smoke_ui_settings.mjs`，沿用既有 `smoke_ui_mock.mjs` 的约定（vite 起 `mock.html`、
headless Chrome + playwright-core 走系统 Chrome channel、依赖缺失即 SKIP 退出 0、
截图落在未跟踪的 `docs/screenshots-ui-settings/`）。**44 项断言全绿**（运行时报 `ok` 的行数；
静态 `check(` 调用为 42 处，其余来自循环），覆盖：

| 断言组 | 内容 |
| --- | --- |
| 分类顺序 | 9 个分类；外观 / 配色方案 / 终端 / 快捷键 排在最前 |
| 两页拆分 | 外观只留排版与光标、配色控件确实移出；两页各自都有实时预览 |
| 终端默认值 | 五个分区标题齐备；回滚 25000、右键默认 `paste`（四档）、响铃默认 `off`（三档）、词分隔符与 Tabby 逐字符相同、选中复制默认开 |
| 快捷键编辑器 | 10 个动作、三组分组、搜索过滤与空态、录制改写、裸键被拒且保持录制、冲突标注与占用者提示、移除重复后冲突消失 |
| 往返 | 改右键语义与回滚行数 → 落 localStorage → 刷新页面 → 重开设置回显一致；兼容旧键镜像同步 |
| 派发贯通 | 把「终端搜索」从其平台默认键位改到新组合后：**旧默认键位不再打开搜索面板，新组合能打开，`Esc` 能关闭** |
| 本地化 | `?locale=zh-CN` 下新分类显示为「外观 / 配色方案 / 快捷键」 |

关于派发断言的口径：mock 的 PTY **不模拟 tty 回显**（只有批量发送路径会显式回显），
因此不能靠「往终端打字再看回显」来证明按键生效。改用搜索面板这一**无内容依赖**的可观测量——
它同时证明了「注册表被真实派发链路消费」，而不只是「值被写进了 localStorage」。

既有 `scripts/smoke_ui_mock.mjs`（工作台锚点、快捷命令 CRUD、批量发送、WebGL 渲染器）
在本轮改动后**回归全绿**。

### 调试路径（本轮实测）

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 官方开发宿主 | `export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$HOME/Library/pnpm:$HOME/.cargo/bin:$PATH"`<br>`dbx-plugin dev --path . --port 5190` | 宿主级联调（会按 `[backend]` 构建并拉起 Rust sidecar）。**它服务的是构建产物 `ui/`**，而 `ui/` 属 integrator 所有权，因此前端迭代期不适合用它 |
| 前端 fixture | `node scripts/smoke_ui_settings.mjs` / `scripts/smoke_ui_mock.mjs`（内部起 vite 服务 `frontend/mock.html`） | 前端改动迭代与 e2e 回归：直接服务 `frontend/src`，改完即生效，不写 `ui/` |
| 脱敏日志 | `node <dbx-plugin-skill>/scripts/dev-logs.mjs --port 5190 --level error --follow` | 官方 dev 宿主的诊断 API |

注意：`dbx-plugin` 装在 nvm 全局 bin（`~/.nvm/versions/node/<ver>/bin/dbx-plugin`，实测 0.1.9），
**不在默认 PATH 上**；`scripts/smoke_ui_mock.mjs` 依赖 `pnpm` 在 PATH 上，跑之前需按上面的
PATH 导出，否则 `spawn pnpm ENOENT`。

## i18n 键引用护栏与 `d983f8fc` 回归修复（2026-09-22，同分支第三轮）

### 起因

上一轮从七语中退役了 `terminalSelectCopy.section` 与 `terminalBehavior.copyOnSelect`（并入 Clipboard 板块）。
而 `workbenchMessage` 在查不到键时**会把 key 原样返回**，所以任何残留引用都会把原始的
点号键直接渲染到界面上。既有断言（`workbench.spec.ts:171`）只比对**七个语言之间**的键集合是否一致——
**一个在七语中同时缺失的键，这条断言天然抓不到**。因此先补护栏，再用它验证退役是否干净。

### 新增护栏：`frontend/src/lib/i18nKeyReferences.spec.ts`

用 `import.meta.glob("../**/*.{vue,ts}", { query: "?raw", eager: true })` 内联源码（不需要文件系统访问，
默认 node 环境即可运行），扫描两类引用并断言其全部存在于 `en` 表：

| 扫描面 | 形态 | 实测规模 |
| --- | --- | --- |
| 翻译调用首参 | `t("a.b")` / `props.t("a.b")` / `translate(...)` / `workbenchMessage(...)` | 903 处 |
| 动作表间接引用 | `labelKey: "a.b"` | 19 处 |
| **唯一引用合计** | | **617 条**，覆盖 130 个源文件 |

五个断言：① 扫描面非空（含**分类型下限**）；② 所有引用均可解析；③ 任意语言下都不会把键名当文案返回；
④ 上一轮退役的两个键不得复活；⑤ 新命名空间 `terminalBehavior.*` / `terminalHotkeys.*` 必须被扫到。

**为什么第①条要分类型下限**：初版把键统一取 `match[2]`，而属性式正则的第二个捕获组是**引号字符**，
于是 19 处 `labelKey` 引用被静默跳过，总数看起来依旧健康。这个自身缺陷只有在修正分组索引后才暴露出来。

**为什么属性扫描用白名单而非 `*Key` 通配**：`*Key` 会连 `shiftKey` / `ctrlKey` / `altKey` / `metaKey`（DOM 修饰键）、
`purposeKey`（后端 playbook 契约键，由 `lib/alertTriage.ts` 映射为 `alertTriage.purpose.<key>`）、
`hostKey`、`authMethodPrivateKey`（SSH 领域概念）以及恰好以 key 结尾的 `hotkey` 一并命中，产生 4 条误报。

### 发现：19 个「被引用、但七语中都不存在」的键

护栏首次运行即报出 19 条未解析引用。逐项核对确认**并非扫描器误报**（对应值全部取自运行时表）：

| 来源 | 键 | 用户可见后果 |
| --- | --- | --- |
| `App.vue` 模板直渲 | `metricsSwap` | 会话指标面板显示字面量 `metricsSwap`，而非「交换空间」 |
| `App.vue` 模板直渲 | `terminalDropPrompt.title` / `summary` / `toCurrent` / `toCustom` / `pathPlaceholder` | 拖拽上传确认框的标题、说明、两个目标选项与路径占位符全部显示原始键 |
| `SettingsDialog.vue` 模板 | `mcpSettings.permissionModeAutonomous` / `permissionModeConfirm` | MCP 自动执行权限模式下拉项显示原始键 |
| `App.vue` / `lib/sftpErrors.ts` 错误路径 | `errors.sessionChanged`、`errors.uploadAckTimeout`、`errors.downloadChunkLength`、`errors.downloadEmptyChunk`、`errors.downloadChunkTimeout`、`errors.probeOutput`、`errors.hostBridgeMissing`、`errors.workbenchDetached`、`errors.permissionDenied`、`errors.remoteNotFound`、`terminalCopyUnavailable` | 错误提示把原始键当文案抛出 |

### 根因：`d983f8fc` 的 i18n 回退

`git log -S` 显示这些键在 `i18n.ts` 上各只有两次变更：首次引入与 `d983f8fc`
（"feat: add trigger-driven SSH authentication providers"）。该提交对本文件的改动为
**+28 / -112 行**，把 `terminalDropPrompt` 整块、`metricsSwap`、`permissionMode*` 等键一并删除，
而 `App.vue` / `SettingsDialog.vue` / `sftpErrors.ts` 的调用点保留至今
（调用点本身引入于更早的 `9b212eaa`）。即：**一次顺带的 i18n 重写让 19 处文案丢失，且没有任何断言能发现。**

### 修复：逐字恢复，纯新增

新增 `restoredMessages` 表并合并进 `supplemental`，沿用本文件既有写法
（`terminalFontMovedMessages`、`uploadBridgeMessages` 同为该模式，且已有 `"errors.localFileShortRead"`
这类扁平点号键先例）。`workbenchMessage` 的解析顺序是「嵌套 → `en` 嵌套 → `supplemental` → 原样返回 key」，
因此**扁平点号键与嵌套键完全等价**，无需还原原嵌套结构，改动面收敛为每语言一个插入点。

- **19 键 × 7 语言 = 133 条**，取值逐字取自 `d983f8fc^:frontend/src/lib/i18n.ts`
  （脚本提取 + JSON 往返规范化转义），**不是重新翻译**。
- `git diff` 为 **+157 / -0**，未修改任何既有行。
- `errors.terminalInputAckTimeout` 同样被该提交删除，但**全仓库零引用**（含 `backend/`），故不恢复。

### 验收口径（本轮）

- 基线：同一分支的 `f1c764c`。
- 七语键数由 750 恢复至 **769**；`workbench.spec.ts` 的七语集合与占位符对齐断言继续通过。
- 新增单测 5 例；全量 vitest **70 文件 / 680 用例全绿**；`vue-tsc --noEmit` 通过；
  `scripts/validate_repo.py` 与 `scripts/connection-forms/verify.mjs` 均 PASS
  （后者本身就校验「七语言标签/选项」）。
- 无新增单测以外的能力：本轮只恢复文案并补护栏；既有 `scripts/smoke_ui_settings.mjs` 新增 3 条断言
  （见下），`scripts/smoke_ui_mock.mjs` 未改动且回归全绿。
- 未新增运行时依赖；未提交 `ui/`（integrator 所有权）。

### UI 走查（e2e）补充

上面那 19 个键里，只有 `mcpSettings.permissionModeAutonomous` / `permissionModeConfirm` 能在
没有真实 SSH 会话的情况下触达（它们位于设置面板的 MCP 分类）。因此在
`scripts/smoke_ui_settings.mjs` 末尾新增一组断言，把「修复真的到达了界面」钉住：

| 断言 | 内容 |
| --- | --- |
| MCP execution-approval field rendered | 通过标签文本「MCP execution approval」定位到字段，并确认其内的下拉存在 |
| permission-mode options are translated, not raw keys | 展开下拉后，选项文案为 `Autonomous` / `Confirm before running` |
| no raw i18n key leaked into the options | 选项里不得出现 `mcpSettings.<X>` 形式的原始键 |

运行时报 `ok` 47 条、0 失败（本轮 3 条 + 既有 44 条）。
`metricsSwap` 与拖拽上传对话框的 5 个键需要真实会话/拖拽事件才能触达，
故只在单测层（运行时语言表解析）覆盖，不在 e2e 覆盖。

## WezTerm 对标补充（2026-09-26，本分支登记）

以 [wezterm/wezterm](https://github.com/wezterm/wezterm)（Rust GPU 终端 + 内置 SSH + 多路复用）
为参照的能力对照与差距收敛。产品形态不同（独立终端 vs 宿主内插件）：WezTerm 的配置系统
（Lua 热重载 + 插件系统）、分屏/workspace/mux server、背景图/毛玻璃/WebGPU 等桌面级渲染特性
均属宿主边界或沙箱不可达（连字经 opentype.js 触达 Node 内置模块即崩，见 App.vue 既有注释），
**不做**；本节只取协议兼容、导入兼容与终端交互域内可对齐项。SFTP/文件传输、会话录制回放、
串口/Telnet/RDP 协议广度等 WezTerm 未覆盖或弱于本插件的维度不在差距之列。

| WezTerm 能力 | 插件状态 | 说明 |
| --- | --- | --- |
| 终端内核与 WebGL 渲染 | ✅ 同水位 | xterm.js 6 + WebGL addon（默认开、context loss 回退）；WezTerm 自研内核走 WebGPU 属原生应用形态，不追 |
| Sixel + iTerm2 OSC 1337 内联图形 | ✅ 已有（更完整） | `ImageAddon` 固定开启、32 MiB 像素上限；WezTerm 自认 sixel「preliminary and incomplete」（上游 #217），kitty 图形协议双方均不支持 |
| kitty 键盘协议 `CSI ? u` | ✅ 已有（更保守） | 补答 flags=0 保持 legacy 编码（`terminalModeQueries.ts`）；WezTerm 以 `enable_kitty_keyboard` 可选启用，应用面暂无刚需 |
| OSC 52 剪贴板 | ✅ 设计一致 | 双方均只写不读；写方向 1 MiB 防御上限，读查询故意吞掉防隐私泄漏 |
| DECSET 2026 同步渲染 | ✅ 已有（WT-1 落地） | WezTerm 支持并做帧合并。`terminalModeQueries.ts` DECRQM 2026 已改答「支持」，`terminalWriteThrottle.ts` rAF 合帧实现「同步窗内缓冲、结束时整批提交」（`setHold`/`held`，字节上限防异常驻留）；`cat` 大文件与 vim 重绘的撕裂闪烁显著收敛 |
| 转义序列应答矩阵文档化 | ✅ 已有（WT-2 落地成文） | WezTerm 把 DA/DSR/OSC 的应答、忽略、故意不支持逐项写成活文档。本插件 `TEST_MATRIX.zh-CN.md` 已新增「WT-2 终端应答矩阵」节，DSR 5/6、Primary DA、SGR 冒号形式以真实 xterm 内核 parser 单测做实测锚点（`terminalProtocolMatrix.spec.ts`），内核行为漂移先红防文档失真 |
| OSC 1337 SetUserVar / OSC 9·777 通知 | ✅ 已有（WT-2 落地） | `registerOscHandler(9/777/1337)`：OSC 9/777 → 工作台通知（压行/截断防刷屏），OSC 1337 SetUserVar（base64）→ cwd 元数据优先通道驱动目录跟随，提示符注入猜测降为回落（`terminalOscChannels.ts` 纯函数 + 防御上限）；OSC 7 回落循环接入「更晚事件为准」裁决 |
| tmux control mode（DCS 1000）桥接 | ⚠️ 双方均不完整 | WezTerm 自认 incomplete（上游 #336）；本插件不做（终端内正常使用 tmux，control-mode 桥接需 mux 底座） |
| SSH 客户端算法与认证面 | ✅ 同水位 | russh 现代套件优先 + legacy 尾部兼容（SHA-1 MAC/DH GEX/AES-CBC/3DES 堡垒机），认证密码/密钥/agent/TOTP/keyboard-interactive 齐全；WezTerm `ssh_backend` 可选 libssh，ServerAliveInterval 走 IGNORE 包——本插件另有终端活动保活绕 TMOUT/堡垒机审计，领先 |
| **`~/.ssh/config` 兼容解析/导入** | ✅ 已有（WT-3 落地，含降级） | `connection_import.rs` 第 8 来源 `sshconfig`：Host 通配/Hostname/User/Port/IdentityFile（仅路径映射不读密钥材料，`key-path-only`）/UserKnownHostsFile/Match host/user 受限支持；Include 按「未跟随标注」降级（管线只收上传字节，不引入 sidecar 磁盘读取），ProxyCommand/ProxyJump 仅标注「需手动映射」绝不执行（同 tssh Expect 信任模型） |
| SSH 会话多路复用（新 tab 开新 channel 免重认证） | ✅ 等价 + spawn（WT-4 落地） | `sessionTransportReuse.ts` 复用已认证 transport；WezTerm `spawn` 语义已补齐——同 transport 指定命令新开 channel（`ssh/session/open` 可选 `spawnCommand`，独立 PTY，共享引用预占与跳板链生命周期同「复制会话」，MaxSessions 失败可见）。WezTerm 声明 SSH 会话**不持久**，本插件重连阶梯 + reattach + boot 恢复在 SSH 场景更实用 |
| 分屏/panes/workspaces/PaneSelect | ❌ 刻意不做 | 宿主工作台承担标签与分屏（「不重复宿主」原则）；WezTerm 的 mux server 持久会话需自研服务端组件，插件形态下立项不成立 |
| Quick Select Mode / vi Copy Mode | ✅ 已有（WT-1 落地 Quick Select）；vi Copy Mode 刻意不做 | Quick Select：buffer 逻辑行拼接 + URL/路径/IPv4/hash 正则抽取（容量上限/去重/折行定位），`Cmd/Ctrl+Shift+O` 经快捷键注册表登记可改键，overlay 逐项一键复制（`quickSelect.ts` + `TerminalQuickSelectPanel.vue`）；vi Copy Mode 与 xterm.js 交互模型冲突大，维持不做 |
| 命令面板/启动器/字符选择器 | ⚠️ 宿主承担 | DBX 工作台已有命令入口体系（快速命令/批量发送/命令历史），不重复 |
| Lua 配置 + 插件系统、桌面级渲染（背景图/毛玻璃/WebGPU） | ❌ 不做 | 宿主负责设置与主题（沿用 Tabby 主题轮的「默认跟随宿主」守卫）；沙箱 iframe 限制连字已不可达，桌面渲染无对应物 |

### 实施排期（WT-1–WT-4）

> 编号说明（2026-09-26 重编号）：本排期登记时（129f636f）使用 M27–M30（原拟接续
> PROGRESS M26-A），与并行推进的字节边界矩阵 / issue 分诊工作线在 PROGRESS 中
> 已占用的 M27–M31 撞号（PROGRESS 的 M27–M31 指的是 shell_quote 收编、下载编码
> 修复、issue 分诊、文件夹上传/限速等另一系列批次）。为免混淆改为独立前缀
> **WT-1–WT-4**，内容与验收口径不变。
>
> **收口（2026-09-27）**：WT-1–WT-4 全部实施落地（分支 `codex/ssh/parity-wt{1..4}-*-2026`，
> 集成于 `codex/ssh/parity-wt-integration-2026`，基线 `f837d28d`）。上表能力行状态已同步
> 更新。降级/未实施项：Include 递归跟随（管线只收上传字节，按「未跟随标注」降级）、
> vi Copy Mode（维持不做）、GBK 堡垒机 8 位 C1 真机实测（TEST_MATRIX 已记设计立场，
> 待真机补充）、Quick Select 全缓冲档开关（已实现未默认开）。

| 批次 | 内容 | 改动面 | 验收口径 |
| --- | --- | --- | --- |
| **WT-1** 终端交互批（纯前端，低成本高价值） | ① Quick Select Mode：URL/路径/IPv4/hash 正则抽取，`Cmd/Ctrl+Shift+O`（快捷键注册表登记，可改）唤起 overlay 菜单，一键复制单项；② DECSET 2026 应答翻转：`terminalModeQueries.ts` DECRQM 2026 改答「支持」，以既有 rAF 合帧写入通道实现「批次内缓冲、模式结束后整体提交」的帧同步语义 | 仅 `frontend/`（新纯逻辑模块 + App.vue 接线 + 七语 + 快捷键表）；后端零改动、无新 sidecar 方法 | 纯函数单测（抽取正则/2026 缓冲边界）；`smoke_ui_mock` 回归全绿；DECRQM 应答翻转的单测与注释同步更新 |
| **WT-2** 协议应答矩阵审计批（前端为主） | ① 逐项核对并成文：DSR 5/6、Primary DA（xterm 内核已答则记录实测证据，缺则补）、SGR 冒号形式（`4:3`/`38:2::r:g:b`）在命令标记/关键词高亮自研路径的行为；② OSC 忽略白名单落地：OSC 9/777 → 工作台通知，OSC 1337 SetUserVar → `user-var-changed` 等价消费（优先替代目录跟随的提示符猜测）；③ `TEST_MATRIX.zh-CN.md` 新增「终端应答矩阵」节 | 仅 `frontend/` + 测试文档；无新 sidecar 方法 | 应答矩阵文档逐行标注「应答/忽略/不支持+理由」；SetUserVar 元数据通道单测；七语 key 对齐断言通过 |
| **WT-3** OpenSSH config 导入批（后端 + 前端） | `~/.ssh/config` 作为 `connection_import` 第 8 种来源：Host 通配、Hostname/User/Port/IdentityFile（路径映射，不读密钥材料）、UserKnownHostsFile、Include（递归上限 + 环检测）、`Match host/user` 受限支持；ProxyCommand 仅识别并标注「需手动映射」（不执行外部命令——与 tssh Expect 同款「密文/外部命令不自动执行」信任模型）；复用现有 preview/sanitize 流水线与 `secret_note` 原因码 | `backend/src/connection_import.rs` 扩展 + main.rs 一处来源注册 + 前端导入向导七语 | cargo test 新增 parser 单测（敌意输入沿用既有 no-panic/容量上限模式）；smoke 导入预览用例；不持久化任何凭据的既有断言保持 |
| **WT-4** 同 transport 命令会话批（后端 + 前端） | WezTerm `spawn` 语义：已认证 transport 上新开 channel 执行指定命令（独立 PTY/session），复用「复制会话」的共享引用预占与跳板链生命周期，适配「一键开 htop 第二个 tab」类场景；受服务端 `MaxSessions` 限制沿用既有语义 | `backend/src/ssh.rs` 复制会话链路参数化 + PROTOCOL 新节 + smoke | smoke 新增 spawn 会话开合与共享引用并发关闭用例；PROTOCOL 契约先行评审 |

排期外的明确不做（附理由）：vi Copy Mode（与 xterm.js 键位模型冲突大，选区/搜索已覆盖）、
tmux control-mode 桥接（需 mux 底座）、Lua/插件化配置、SSH 持久 mux server、
WezTerm 私有 SGR 色彩模式 6（RGBA 扩展，生态无应用依赖）、8 位 C1 控制码（维持 UTF-8-only 立场，
GBK 堡垒机行为纳入 WT-2 应答矩阵实测记录）。

## 候选缺口（未排期）

对标复审（Tabby / NetCatty / iShell 文档线索 + 本仓批次遗留）沉淀的候选登记。
均未排期、无承诺；立项前需过依赖/范围评审，登记处随评审结果更新：

| 候选项 | 来源线索 | 说明 |
| --- | --- | --- |
| 终端 BiDi | sshbool 对标候选（见上节） | xterm.js 原生无 BiDi/shaping；shaping 管线建议放 `shared/frontend/` 公共层单点实现 |

> 2026-09-25 清理：认证 Auto 模式、Quick Commands 导入、进程管理句柄/端口（M13）、录制 transcript/自动录制/搜索、SFTP pipeline 深度/兼容模式/文件名编码（M14）、多文件并行 watcher 编辑（M15）已交付，从本表移除（见主矩阵各 ✅ 行）。云同步经决策除名——DBX 宿主基础能力已提供配置同步/上传，插件侧不再立项（含口令加密导出导入降维方案）。
> 2026-09-26 协议审计清理：「每连接编码选择」行移除——M16 已交付连接级编码覆盖（偏好键 `sftp_name_encoding_overrides`，语义见 PROTOCOL `local/preferences` 行），该行「现无连接级编码覆盖」的陈述已失效。

## Tabby/NetCatty 五协议对标批（2026-09-27）

以 Tabby（master 4004cc5）、NetCatty（main@8568375）、electerm、tssh、Guacamole
为参照的五协议（SSH/RDP/串口/VNC/Telnet）处理与测试用例对标；结论与逐条映射见
`docs/TABBY_PROTOCOL_PARITY.zh-CN.md`，认证域对抗评审终裁见
`docs/AUTH_ADVERSARIAL_REVIEW.zh-CN.md`。RDP/VNC 在 Tabby/NetCatty/WindTerm/
Xshell/Termius/SecureCRT 全部不存在，维持不立项；Telnet/Serial 维持宿主承担
（立项时按对标文档 §4/§5 测试维度清单验收）。本批落地：

| 能力 | 参照位置 | 插件状态 | 说明 |
| --- | --- | --- | --- |
| agent 认证预算计划器（MaxAuthTries 防护） | Tabby authMethodSelection / NetCatty identitiesOnly | ✅ 已有（对抗评审 #1 落地） | `plan_agent_identity_attempt` 纯函数 + `AGENT_IDENTITY_MAX_ATTEMPTS=5`（MaxAuthTries 默认 6 − none 探测 1）；partial success 命中即转 keyboard-interactive 不再烧名额；transport 错误首错即停并透出原文（替换笼统 `No SSH Agent identity was accepted`），预算耗尽文案指引指定私钥。`AgentAuthOutcome::Rejected(String)` 携带原因；4 个计划器单测 + koko mock `PasswordRejectedThenMfa` 形状固化"密码全拒仍 seed 第一因子"契约（#7，改严格判定会打爆 PAM smoke，属知情让渡） |
| none 探测 | NetCatty 认证序列 | ✅ 已有（实证澄清） | 生产认证序列第一步即发 none（ssh.rs:2456-2468），此前对标文档误记"未见"；广告集消费（reconcile）经对抗评审裁为二期，前置条件已满足，待独立 PR |
| SFTP 文件名不可解码标记 | NetCatty gb18030 解码 | ✅ 已有（最小方案） | russh-sftp wire 层 `from_utf8_lossy` 使 GBK 原始字节不可恢复（encoding_rs 无效，对抗评审裁决不引入）；`sftp/list` 与 sudo 列表条目按文件名含 U+FFFD 标记布尔 `lossy`（M14-B 命名，合并 tabby 批时统一），前端警示图标 + 多语提示；PROTOCOL 文档已同步 |
| zmodem/trzsz 传输状态机幂等 | electerm xmodem stale-ACK | ✅ 已有（修复） | trzsz 进度：step 单调钳制（乱序/重放不回跳）、totalTransferred 用钳制后增量、重复 size 事件去重、`num` 分支清残留 totalSize、NaN size 守卫；zmodem：检测决策纯函数 `decideZmodemDetection`（上传占流/trzsz 占流时 deny，sz 下载自动 confirm）、resume offset 越界钳制、offer 文件名净化（路径段剥离/Windows 保留名/非法字符） |
| known_hosts TOFU 闭环测试 | electerm host-trust / tssh 鲁棒性 | ✅ 已有（测试资产） | check→learn→check 变 Trusted、learned key 变更拒绝（MITM 护栏）两个闭环用例；写路径 learn 追加语义 + 8192 字符脏行截断既有覆盖不变 |
| 上传临时件路径边界 | Guacamole 路径矩阵 | ✅ 已有（修复） | `remote_transfer_paths` 段级 `..` 收敛（含 `..` 目标的 `.part`/`.backup` 临时件与 normalize 后目标同目录，原子 rename 前提）；相对父目录弹空显式拒绝 |
| 认证计划纯函数单测 | Tabby authMethodSelection 7 用例 | ✅ 已有 | `method_offered`/`auth_partial_success` 直接断言（服务器广告驱动、Success/空集 false、partial 三态） |
