# 验收矩阵

| 范围 | 原型门槛 | 当前状态 |
| --- | --- | --- |
| Sidecar 编译 | Windows x64 Debug/Release | 已通过 |
| 单元测试 | 主机密钥、路径、序号、补发、临时路径 | 7/7 通过 |
| 工作台 | TypeScript、Vite 自包含构建 | 已通过 |
| Host H1 | 跨版本数据目录 | 5/5 通过 |
| Host H2/H3 | 文件句柄、连接挑战 | 11/11 通过 |
| 插件包 | Windows x64 未签名候选包 | 已生成并通过 Host 安装/生命周期冒烟，本地未发布 |
| Host 真实 SSH/SFTP | 密码、指纹、变化密钥拒绝、PTY、resize、0 B/4 MiB、取消、重连 | 已通过 |
| Windows 桌面完整 UI | 沙箱、剪贴板、文件选择/保存、双栏交互 | 待启动应用验收 |
| DBX Web/Docker | 同包、服务器侧 Sidecar、本地文件句柄 | 待启动集成环境 |
| 长稳与突发 | 30 分钟、序号补发 | 待真实服务器 |
| 大文件 | 100 MiB、1 GiB、SHA-256 | 完整阶段；H2 正式流实现后执行 |
| 五平台包 | Windows、macOS x2、Linux x2 | 工作流已配置，未触发 |

真实验收时应记录 DBX 版本、插件包 SHA-256、SSH 服务端版本、网络延迟/丢包条件、传输文件 SHA-256、残留临时文件检查和终端首尾序号。

## 2026-08-29 本机基线（darwin-arm64，batch3 + S-A/S-B/X-B/A-SSH 全轮收口终值）

> B-SSH-COLLECT 收口基线（未提交 batch3 + 历轮增强工作区，2026-08-29 全量复测）；上方 Windows
> 平台矩阵为早期验收记录，本机未复核、不做改动。明细记录文档已随批次退役删除（见 git 历史）。

| 套件 | 结果 |
| --- | --- |
| backend cargo test | **109/109** 通过，0 ignored（A-SSH 新增 `auth_method_names_round_trip_for_display` 等；S-A 增量：metrics 快照缓存 2、inode/topMemory 解析 3、optional_u64、MCP offset schema） |
| frontend typecheck / vitest / build | 全过；vitest **51/51**（workbench 45 + appearance 6；含 OSC 633 八用例、session status 三用例、输出净化三用例、i18n 七语全对齐两用例、tick/命令历史/快速命令/authMethod 用例）；自包含 ui/index.html（2,317,270 B）产出 |
| smoke_test.py | PASS 1.1s（真机容器 dbx-ssh-test；已含 `sftp/list` kind 断言，O1 关单） |
| smoke_fs_test.py | PASS 17 / SKIP 0 / FAIL 0 |
| smoke_mcp.py | PASS（19 个 MCP 工具；MCP.zh-CN.md 已同步 19） |
| smoke_batch3_test.py | PASS **17/17**（12→17：目录递归 copy、单字符串 from、目录 move、目录目标冲突、overwrite 替换；metrics 网络/Top 进程/inode/快照缓存、sftp/read offset 分页、knownHosts marker、copy/move 语义、sessions/list 含 authMethod 断言） |
| smoke_sudo_otp_test.py | PASS **10/10**（sudo 保活/OTP 编排端到端真机） |
| dbx-plugin package | 0.2.2 darwin-arm64 出包完整（5 文件 + checksums；**4,290,327 B，sha256 `a67bb683a2db1ee67e37ae8b6d96447a44fe160fb07e55b459289a450edf347e`**；出包后对重编二进制复跑 smoke_test PASS 1.2s） |
| 性能基线（PROGRESS-P-SSH §3，真机） | 终端 PTY 流灌入 **71.9 MiB/s**（5 MiB 环形缓存）；SFTP 上传（网络）**220–237 MB/s**、上传（本地 spool）633.9–1078 MB/s；SFTP 下载 **113–118 MB/s**；replay 载荷 2.00 MiB / 601 帧 ≤ 2 MiB 上限（SHA-256 校验一致） |

2026-09-02 增量（PROGRESS-P-SSH §8.7，纯前端轮）：frontend typecheck / build 过；
vitest **86/86**（基线 79 → 86：terminalWriteThrottle 6 + terminalDrop 准入 1）；
浏览器（visual.html Playwright）：终端拖放上传 overlay / drop 全链路（分屏 + solo）/
只读拒绝 / 节流写入回归，截图 screenshots-ui-mock/terminal-drop-{overlay,solo}-round87.png。

仍保持未验收（环境/CI 依赖）：DBX Web/Docker、长稳与突发、大文件 100 MiB/1 GiB、五平台包、
宿主 plugin_tools_bridge 集成段（WIP-SKIP，宿主合流后必跑）。

## 下一批增强建议（2026-08-29 收口后余量）

仓内已完成并关单：smoke_test.py kind 字段对齐（O1）、smoke_batch3 目录级用例（O4）、
i18n 七语全量对齐断言、终端标记条运行中时长 tick、sudo 保活/OTP 端到端真机 smoke
（smoke_sudo_otp_test.py 10 用例）。
依赖宿主/CI（单列）：宿主管线集成回归（test.sh 全量 + plugin_tools_bridge）、DBX Web/Docker
浏览器兜底 e2e、长稳与大文件 100 MiB/1 GiB、五平台包矩阵、多会话语义与端口转发归属决策。


## M1（nyaterm-parity W1，2026-09-23）

单测：cargo **595/595**（基线 575 + 20：metrics_gpu 13 / preferences 7）、vitest **792/792**（基线 698 + 94：matcher 24 / gutter 18 / suggestions+guard+queue 42 / gpu 视图与组件 10）、vue-tsc 0 错、`pnpm build` 过（ui/ 已重生成）；`validate_repo.py`、`connection-forms/verify.mjs` 全过。

e2e（headless Chrome，`mock.html?fresh=1&slow=2`，Playwright + 系统 Chrome）：连接流程 → 设置 Terminal 分类（Action links / Line numbers & timestamps 区渲染、开关→Save 持久化）→ 终端行号+时间戳双列 gutter 对齐 → 命令条造历史后输入 "ec" 建议浮层（匹配高亮 + History 来源标签）→ Downloads 分类（重复策略单选 + 并发输入）→ Server metrics GPU/NPU 卡片（双 A100 P0/P8 + 910B4/310P3 + CANN 徽标 + 空进程态 + 警戒色）→ 动作链接 host:port 下划线（与 IP 关键词高亮共存）。截图经 visual-judge 终审 **7/7 pass**（备注项：Downloads 路径说明行位置、窄卡显存 title 兜底截断，均非阻断）。

仍保持未验收（依赖真机/CI）：NVIDIA/Ascend 真机采集冒烟（无卡主机，TEST_MATRIX 待补跑记录）、Windows ConPTY 下 gutter 渲染、DBX 桌面宿主端到端手测（M1 里程碑 PR 合入前人工执行）。

## M5（nyaterm-parity，2026-09-24）

单测：cargo **719/719**（M4 基线 696，只增不减；vnc_session 11）、vitest **874/874**（基线 861，只增不减；vncFrame 帧编解码 9）、vue-tsc 0 错、`pnpm build` 过（ui/ 已重生成）；clippy `-D warnings` 0、fmt 干净。

新增可测面：`vnc/start|input|resize|reconnect|set-clipboard|close|list` 协议、44 字节 RGBA patch 帧编解码（3840×2160 / 64MiB / 步长上界）、VNC-Auth 密码长度拒绝、Tight/JPEG 矩形显式失败、generation 重连语义；前端 VNC 画布与连接对话框、Docker"在终端打开"fill 通道、x11_spike 编译示例（不参与运行）。

仍保持未验收（依赖真机/CI）：VNC 真机 server（None/VNC-Auth）端到端、X server 转发真机联调、串口硬件、GPU/NPU 主机、Windows ConPTY、DBX 桌面宿主端到端；RDP 维持人工评审门（vendored fork 链 + CredSSP）。


## M5.5（main 同步 + 三会话并行线，2026-09-24）

单测：cargo **735/735**（M5 基线 719，只增不减；串口 ports 规范化/行参数校验 + main 侧 MFA、传输复用、pluginStorage、sessionTransportReuse、terminalModeQueries 等 spec 并入）、vitest **886/886**（基线 874，只增不减）、vue-tsc 0 错、`pnpm build` 过（ui/ 重生成）、clippy `-D warnings` 0、fmt 干净。

新增可测面：serial ports 路径/描述规范化分离与 start 行参数严格校验（纯逻辑）；main 同步带入的交互式 MFA、重复会话认证传输复用、右键粘贴插件视图副本降级链（createTerminalCopyCache/resolveTerminalPasteText）、kitty/XTVERSION/DECRQM 能力探测应答、randomUUID shim 的既有 spec；RDP 立项材料两份与串口协议升级设计稿（评审门文档，无代码面）。

仍保持未验收（依赖真机/CI）：VNC server、X server 转发、串口硬件、GPU/NPU 主机、Windows ConPTY、DBX 桌面端到端；RDP 评审执行（材料已备）。新增回归面：App.vue 结构化偏好新键（终端行为/快捷键/传输并发/命令建议）在真机 opaque origin 下的持久化——pluginStore 全量迁移待下轮（PROGRESS 遗留 3）。


## M6（pluginStore 全量迁移，2026-09-24）

单测：vitest **891/891**（基线 886，只增不减；terminalBehavior×2 / terminalHotkeys×2 / terminalAppearance×1 默认 pluginStore 回环与不抛用例，pluginStorage.spec 键清单断言扩展至 15 键并固化 transfer/suggestions 排除项）、vue-tsc 0 错、`pnpm build` 过（ui/ 重生成）。backend 零改动（无 cargo 面变化）。

新增可测面：三结构化偏好键（terminal-behavior/hotkeys/appearance）经 host.storage 通道持久化、web 直连降级 guarded localStorage、键清单锁定断言。

仍保持未验收（依赖真机/CI）：三键真机首装迁移（localStorage 旧值经惰性搬家入 host.storage）与跨重启持久化；老宿主降级行为抽查。VNC/X server/串口/GPU-NPU/ConPTY/DBX 桌面端到端与 RDP 评审执行等既有人工门不变。


## M7（并发验证轮：P0 回归修复 + 三线矩阵，2026-09-25）

单测：vitest **891/891**（基线持平；terminalModeQueries.spec 加固——fake parser 镜像 xterm prefix/intermediates/final 区间校验，XTVERSION query/Ps=0/非零放行三形态）、vue-tsc 0 错、`pnpm build` 过（ui/ 重生成）。backend 零改动。

新增可测面（实例/模拟层）：smoke 家族 8 项矩阵全绿（含 forward 容器复验 6 用例）；干净容器首装挑战流 PASS；浏览器场景矩阵 13 场景（10 PASS + 3 FAIL 已随 P0 修复转绿，等价覆盖见 walkthrough）。P0 修复：XTVERSION CSI 注册参数（`{prefix:">",final:"q"}` + params 校验），同类注册形态从此被 vitest 锁定。

仍保持未验收（依赖真机/人工）：DBX 桌面端到端、VNC/X server/串口硬件/GPU-NPU/ConPTY、pluginStore 真机持久化、S3 visual.html 修复后补录、前端 walkthrough 纳入 CI 的人工排期。


## M7-Warp（结构化补全 spec 下拉，2026-09-25）

单测：vitest **934/934**（spec 纯函数 23 + CompletionMenu 组件 5 + M7 三线增量）、cargo **766/766**（含 M7 startup-commands/import-formats backend 增量）、vue-tsc 0、build 过（ui/ 重生成）。

新增可测面：spec token 切分（引号内空格/`--` terminator/`--flag=v` 内联值）、三层判定（flag/value/sub）、评分截断 20、菜单键盘导航；12 个 CLI spec 数据静态校验。

已知限制：动态值（分支/文件/pod 名）只出占位 hint 不向远端枚举；spec 未覆盖的命令回落历史浮层；菜单 Enter=接受 token（fig 语义）非执行。


## M8（Warp 对齐 + np9 并发轮，2026-09-25）

单测：vitest **960/960**（95 文件；ghost 状态机 26 + completion spec/menu + telnet-autologin + startup_commands 134 行 spec + import 四解析器，基线 901 只增不减）、vue-tsc 0 错、`pnpm build` 过（ui/ 重生成）；backend cargo **745**（基线 735 只增不减：startup_commands 偏好解析/桶上限/注入器）、clippy `-D warnings` 0、fmt 干净。

新增可测面：行内 ghost 建议（字节分类/门闩/前缀扩展/接受注入，Warp/fish 对标）；结构化补全三级下拉（spec 优先/历史回落）；telnet 声明式自动登录；四格式会话导入；连接级启动命令（<=20 行/<=4KiB/<=30s 延迟上限、按 connectionId 分桶、完成事件不含命令内容）。

仍保持未验收（依赖真机/人工）：serial-xymodem 线在途（模块已落盘，验证中）；ghost/spec 真机输入法与宿主渲染联调；DBX 桌面端到端；RDP 评审执行。

- 补录：serial-xymodem 合入（backend 801 / 前端 975 终值），XMODEM/YMODEM/ZMODEM 上传协议状态机与 serialUpload 前端为新增可测面；smoke_serial_upload.py 入实例测试家族。np9 排期清零。
