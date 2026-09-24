# 对标 NyaTerm 差距项实施方案 v2（差距项 2/4/5/7/8/9/10）

> v2 重写于分支集成分支 `codex/ssh/nyaterm-parity-integration`（worktree `.worktrees/nyaterm-parity`）。
> v1（主 checkout 未提交稿）的 NyaTerm 1:1 分析结论仍有效，本版不再重复其源码细节；本版聚焦**合并后的真实现状盘点**与**剩余实施计划**。
> 对标源码：`/Users/Jinpy/btroot/nyaterm`（浅克隆）。本文 `nyaterm:` 前缀路径相对该目录。

**目标**：在 DBX 插件形态内对标 NyaTerm 的 7 项差距，剔除已实现/在途项后按新优先级落地。

**基线（本次集成后）**：11 个分支并入集成分支（共 57+ commits），5 个分支判定内容已被 main 覆盖跳过；基线验证全绿——`cargo test` 575 通过、`vitest` 698 通过（74 文件）、`vue-tsc` 0 错、`pnpm build` 产出 `ui/index.html`。

## 0. 本次分支合并结论（集成记录）

| 分支 | 结果 | 说明 |
| --- | --- | --- |
| `codex/ssh/issue-11-69-hostkey-userinput` | ✅ 已并入 | 宿主对话框确认主机密钥（#11/#69） |
| `codex/ssh/terminal-themes` | ✅ 已并入 | Tabby 配色迁移、多主题外观、Tabby 行为/热键设置 |
| `codex/ssh/host-file-drop` | ✅ 已并入 | 宿主 OS 级拖放接线 + 落点询问 + #33/#71 快速输入诊断浮层 |
| `codex/ssh/ci-smoke-hardening` | ✅ 已并入 | 容器冒烟加固、`decode_sequenced_input`、`portable-pty` 依赖、本地终端大部实现 |
| `codex/ssh/local-terminal` | ✅ 已并入 | 本地终端收尾（shell 发现/偏好/徽标） |
| `codex/ssh/a4-webview-contract` … `a4-acceptance` | ✅ 已并入 | A4 契约：宿主权威 workbenchId、workbench/close 作用域释放、`localUiMode` 按钮隐藏 |
| `codex/host-capability-form` | ⏭️ 跳过 | `password_source` 二选一/port 校验等已全部在 main |
| `codex/ssh/jumpserver-ki-mfa` | ⏭️ 跳过 | merged-prompt/2FA 文案 = main 已发布的 0.4.79（`smoke_login_mfa_test.py` 已在） |
| `codex/ssh/private-key-picker` | ⏭️ 跳过 | `picker` 与 `import-private-key` action 已在 main manifest |
| `review/ssh-form-sections` | ⏭️ 跳过 | 表单分区/字段顺序 = main 0.4.79 已做 |

冲突融合要点（供回溯）：App.vue 拖放链路取「main 门禁+桥故障回退 + 分支落点分流（`planHostFileDrop`/targetDir）」，注册收敛为 `initialize()` 一处；响铃取 main 三态实现（分支简化版弃用）；`localUiMode` 语义取 acceptance 的 `v-if` 隐藏版 + 保留 forwards 按钮；工具栏 SSH 专属按钮本地模式下隐藏；PROGRESS 文档两节都保留并加合并注记。

## 1. 七项差距的现状重判（合并后逐项核对）

| 差距项 | v1 判定 | v2 重判（证据） |
| --- | --- | --- |
| 2 会话类型 | 全缺 | **2a 本地 Shell ✅ 已完成且强于 NyaTerm**（`backend/src/local_terminal.rs`：start/resize/replay/close/list；`local/shells/list` 多平台 shell 发现；shell integration 注入 OSC 133/633/OSC7；退出码覆盖层；webview 重载接回；`localUiMode` 互斥切换；`scripts/smoke_local_terminal.py`）。**2b Telnet / 2c 串口 / 2d VNC / 2e RDP ❌ 仍缺** |
| 4 会话导入 | 全缺 | ❌ 仍缺（无任何导入器） |
| 5 OTP 库 | 全缺 | ❌ 仍缺（现有为连接级 `totp_secret` 字段 + 登录 MFA/sudo 自动应答；无库、无二维码、无 HOTP、无集中面板） |
| 7 X11 转发 | 全缺 | ❌ 仍缺（russh 0.62 x11 API 待 spike） |
| 8 终端体验 | 全缺 | **8a 命令历史 🔶 缩水**：`frontend/src/lib/commandHistory.ts` 已有环形 100 条 + secret-like 过滤 + localStorage 持久化 + 命令弹窗上下键导航（对标 tiny-rdm）；**缺**终端内实时模糊建议浮层与按键级采集——且采集可直接挂已有 `terminalCommandMarkers.ts`（OSC 633），比 NyaTerm 的按键跟踪模型更可靠。**8b 动作链接 / 8c gutter（M1）/ 8e 背景图 / 8f 大输出保护（M2 feel 批）✅ 已落地**；**8d 搜索翻译 🔶 半边**——选中文本在线搜索已随 M2 feel 批上线（引擎可配，openExternal 缺失降级复制链接），**翻译半边依赖宿主 openExternal 能力确认——宿主确认前保持搜索-only** |
| 9 监控深度 | GPU/NPU/Docker 全缺 | ❌ 仍缺（现有 CPU/内存/磁盘+inode/网络速率/top 进程 + 历史） |
| 10 SFTP 尾部 | watcher/并发全缺 | **10b 🔶 缩水**：上传并发已有（`runWithConcurrency(files, 3)`，写死）；断点续传/暂停已有。**缺**并发可配置、重复目标策略。**10a watcher 回传 / 10c symlink 创建 ❌ 仍缺** |

另：NyaTerm 独有的背景图（8e）确认未被 `issue-73-terminal-bg` 覆盖——该分支实为 xterm 6.1 升级 + electerm 特性（黑边修复、字号、全选快捷键），已在 main。

### 我们已经更强、保持不放的部分（NyaTerm 无）

- **MCP 自动化面**：31 个工具 + 独立 stdio + 进程级只读门（`DBX_SSH_MCP_READ_ONLY=1`）。
- **安全运维护栏**：只读连接、sudo 白名单、审计日志、操作审批、告警分诊、Expect 规则风险提示。
- **本地终端的安全面**：宿主权威 workbenchId（A4 契约）、`localUiMode` 下 SSH 专属按钮隐藏、webview 重载会话接回。
- **拖放门禁**：三条上传链路统一「已连接 + 可写」门禁 + 桥故障回退 + 落点询问（NyaTerm 无统一门禁概念）。
- **七语本地化**（NyaTerm 仅中英）、Quick Sudo 全局编排、最多三跳 ProxyJump（MCP 链路）、多机执行。

## 2. 修订后分期路线图

| 期 | 项 | 内容（剩余部分） | 新增依赖 | 量级 |
| --- | --- | --- | --- | --- |
| P1 | 8a | 终端内命令模糊建议浮层（采集挂 OSC 633 标记 + 复用 commandHistory 环形库） | 无 | 中 |
| P1 | 8b | 动作链接（IPv4/host:port/压缩包，点击填命令不执行） | 无 | 中 |
| P1 | 8c | 行号/时间戳 gutter | 无 | 中 |
| P1 | 9a/9b | GPU（nvidia-smi）+ Ascend NPU（npu-smi）监控 sections + 面板卡片 | 无 | 小 |
| P1 | 10b | 并发可配置（`transfer.concurrency`，默认 3）+ 重复目标策略（rename/overwrite/ask） | 无 | 小 |
| P2 | 5 | OTP 库：TOTP/HOTP + 二维码导入 + 集中面板 + 连接绑定映射 + 防重放 | `rqrr`、`image` | 中 |
| P2 | 4 | 会话导入：Xshell/MobaXterm/WindTerm → 插件级连接库 → workbench 打开 | `zip`、`encoding_rs`、`sha3`、`cbc`、`pbkdf2` | 中 |
| P2 | 2b | Telnet 会话（自写 IAC；自动登录可复用 triggers Expect 引擎） | 无 | 中 |
| P2 | 9c | Docker 面板（sudo 回退复用 Quick Sudo；白名单+审计+只读门） | 无 | 大 |
| P2 | 10a | 远程文件外部编辑 + notify watcher 自动回传 | `notify` | 中 |
| P2 | 10c | SFTP 新建/编辑符号链接（`symlink@openssh.com`，spike russh-sftp API） | 无 | 小 |
| P2 | 8e | 背景图（CSS 层 + 表面透明化 + 挂起 WebGL，复用 0.6.0 重建逻辑） | 无 | 小 |
| P2 | 8d | 选中文本在线搜索（宿主 openExternal 缺失→剪贴板兜底）；翻译后置。跟踪点（2026-09-25）：翻译半边依赖宿主 openExternal 能力确认——宿主确认前保持搜索-only（搜索半边已落地） | 无 | 中 |
| P2 | 8f | 大输出保护（背压分帧 + strained 模式 + 副组件挂起） | 无 | 中 |
| P3 | 2c | 串口会话（`serialport`） | `serialport` | 中 |
| P3 | 2d | VNC 会话（帧 patch 走现有二进制通道，需压测） | vnc-rs | 大 |
| P3 | 7 | X11 转发（先 spike russh x11 API，报告先行） | — | spike |
| P3 | 2e | RDP（ironrdp + vendored forks，CredSSP 属高风险区） | — | 特大，独立评审 |

相对 v1 的变化：**本地终端整项移出计划**（已完成）；**8a 从新建改为扩展已有 commandHistory + OSC 633 采集**；**10b 缩为配置化+重复策略**；Telnet 升到 P2（triggers 引擎可复用）；串口/VNC/X11/RDP 维持 P3。

## 3. P1 任务卡（无新依赖、无 manifest 变更）

### Task P1-1 命令模糊建议浮层（8a）

**现状衔接**：`commandHistory.ts` 已有环形库/secret 过滤/持久化（`COMMAND_HISTORY_LIMIT=100`）；`terminalCommandMarkers.ts` 已解析 OSC 633（命令/退出码/cwd）。

- [ ] `frontend/src/lib/commandSuggestions.ts`：`searchCommands(query, {history, quickCommands}, limit=12)` 子序列评分（连续命中加分、来源标记 history/quick），纯函数 + 单测
- [ ] 采集接线：在 OSC 633 命令结束标记（D，带退出码）处把命令文本写入现有 `commandHistory` 环形（替代按键跟踪模型——shell integration 缺失的会话退化为不采集，不做按键模拟）；沿用既有 secret-like 过滤；Expect/OTP 注入的输入不入库
- [ ] `frontend/src/components/CommandSuggestions.vue`：光标下方浮层（定位用 xterm `_core._renderService.dimensions.css.cell`，封装到单点函数并留降级：读不到即隐藏）；↑↓ 选择、Tab 填充、Enter 执行、Esc 关闭
- [ ] 抑制门：alternate buffer（vim/top）、pager 启发（`/^[/?:]/` 与单键翻页）、抑制程序集（htop/less/man/journalctl/tail -f…，Ctrl+C 或 q 解除）——纯函数 `canShowSuggestions()` + 单测
- [ ] 设置项 `history.suggestions_enabled`（默认开）+ `min/max_chars`，入 `SettingsDialog.vue` 与 `preferences.rs` allowlist；七语文案
- [ ] 验收：headless Chrome（`mock.html`）注入含 OSC 633 的输出流，输入 `doc` 出浮层、Tab 填充、Enter 执行；密码类命令不入库

### Task P1-2 动作链接（8b）

- [ ] `frontend/src/lib/actionLinksMatcher.ts`：IPv4 严格校验、host:port（排除源码/日志后缀误报）、压缩包扩展名，正则 + 校验函数单测
- [ ] `frontend/src/lib/actionLinksAddon.ts`：xterm `ILinkProvider` + decoration 虚线下划线；**必须复用 0.4.79 高亮防抖策略**（仅"本帧重绘且文本变化"的行重建），与 IP/关键词高亮同段命中时让位
- [ ] 点击行为：把构造命令（`ping <ip>`、`nc -vz h p`、`unzip f`…）**填充进输入行，不回车不执行**；默认关闭，`SettingsDialog.vue` 加 `action_links_enabled` + 三类开关；七语文案
- [ ] 验收：headless 空闲 12s 零额外重绘/零装饰拆建（0.4.79 同口径）；`cargo test`/`vitest` 全绿

### Task P1-3 行号/时间戳 gutter（8c）

- [ ] `frontend/src/lib/terminalGutter.ts` 纯函数（`computeGutterRows({renderDims, screenOffsetTop, scrollTop, rows, timestamps})`，wrapped 跳过、alternate buffer 不显示、时间戳 map 裁剪 start-3000）+ 单测
- [ ] `frontend/src/components/TerminalGutter.vue`：rAF 节流；时间戳 = 行首写时刻（挂在现有输出写入完成点）+ 回车重盖光标行
- [ ] 设置 `terminal.show_line_numbers` / `show_timestamps` / `timestamp_format`（默认 `[HH:mm:ss]`）；8f 的 strained 模式下挂起；私有 `_core._renderService` 封装单点 + 降级隐藏；七语文案
- [ ] 验收：滚动/回滚/resize/`\r` 原地改写四场景行号对齐、无 map 无界增长

### Task P1-4 GPU + Ascend NPU 监控（9a/9b）

- [ ] `backend/src/metrics_gpu.rs`：`gpu_overview_script()`（`nvidia-smi --format=csv,noheader,nounits` 查询 index/uuid/name/driver/温度/利用率/显存/功耗/风扇/pstate + `--query-compute-apps` 进程）与 `npu_overview_script()`（`npu-smi info` PATH→`/usr/local/bin`→`/usr/local/Ascend/driver/tools/*` 探测；CANN 版本从 `ascend_toolkit_install.info` 读），解析纯函数 + fixture 单测（CSV 引号、`N/A` 容错、HBM 优先、一卡多芯片）
- [ ] `metrics.rs` sections 白名单加 `gpu`/`npu`（MCP `ssh_metrics` 自动受益）；只读采集不受 read_only 限制
- [ ] 监控面板 GPU/NPU 卡片：利用率/显存(HBM)/温度/功耗 + 进程列表（uuid 关联）；轮询 ≥3s，`GPU_AVAILABLE=0` 或 3 连败停轮询；七语文案
- [ ] 验收：fixture 单测全绿；有 NVIDIA/Ascend 主机时真机冒烟（记入 TEST_MATRIX）

### Task P1-5 传输并发配置 + 重复策略（10b 剩余）

- [ ] `frontend/src/lib/transferQueue.ts`：按方向计数的调度纯函数（`nextRunnable(queue, running, limits)`）+ 单测；上传/下载入口接入，替换写死的 `runWithConcurrency(files, 3)`
- [ ] 设置 `transfer.concurrency`（1–10，默认 3）入 `preferences.rs` allowlist + `SettingsDialog.vue`
- [ ] 重复目标：上传前 `sftp/exists` 预检 → `rename`（默认，后端新增 `sftp/rename-unique`，`name(1)..name(999)`）/ `overwrite`（沿现有原子替换）/ `ask`（复用确认对话框 + 应用到全部）；七语文案
- [ ] 验收：并发=2 时 5 文件最多 2 in-flight；ask 模式逐个确认且"全部应用"生效；sidecar `sftp/rename-unique` 单测

## 4. P2 任务卡（要点与 v1 差异）

- **Task P2-1 OTP 库（5）**：算法零新依赖（`hmac`/`sha1`/`sha2`/`data-encoding` 已有）自写 `backend/src/otp.rs`（RFC 4226/6238 向量单测）；存储 `<plugin_data_dir>/otp-entries.json` 0600 + secret 经 `vault.rs` 加密；`otp/list|save|delete|generate|import-qr`（HOTP 生成即 counter+1 持久化；TOTP 返回 remaining）；二维码用 `rqrr`+`image`（仅此引入）；连接绑定走 workbench 设置映射（不动 manifest），自动应答取码优先级：连接 `totp_secret` → 绑定条目 → 全局 Quick Sudo；进程内防重放缓存（同 time_step 不复用）。面板入 `SideNavPanel.vue`。
- **Task P2-2 会话导入（4）**：`backend/src/connection_import.rs` 解析器（Moba INI → Xshell ZIP+INI → WindTerm JSON+PBKDF2-SHA3-512/AES-CBC，主密码缺失明确报错）；产物入 `<plugin_data_dir>/imported-connections.json`，凭据经 vault 加密；协议 `import/parse`（预览）+`import/commit`——比 NyaTerm 多预览勾选步；UI 向导入 SideNavPanel；zip-bomb 防护（条目/解压上限）；Web/Docker 走 File API 上传字节。CHANGELOG 注明"存插件本机，不进 DBX 连接库"。
- **Task P2-3 Telnet（2b）**：`backend/src/telnet_session.rs`（IAC 协商/NAWS/剥命令/回车模式/Backspace 0x7F→0x08）；自动登录复用 `triggers.rs` Expect 引擎（比 NyaTerm 自写 auto_login 更安全：已有双密文槽与风险提示）；workbench 内新增临时会话入口（与本地终端同模式，`localUiMode` 体系扩展为 `directMode`——命名评审时定）；七语。
- **Task P2-4 Docker（9c）**：`backend/src/docker.rs`（`--format` tab + BEGIN/END 分节脚本与解析）；动作白名单 start/stop/restart/kill/rm + 容器 id hex 校验；sudo 回退：plain → Quick Sudo profile → 报错指路（密码绝不拼命令行，stdin 传递）；审计 + read_only 门 + MCP 工具（`docker_list` 只读 / `docker_action` 需 confirm）；面板：列表/详情/日志/「在终端打开」（生成 `docker exec -it` 写入当前终端）；rm/kill 前端确认。
- **Task P2-5 watcher 回传（10a）**：`backend/src/file_watch.rs`（notify + len/mtime/SHA256 指纹 + 500ms 去抖 + 2s 启动抑制 + temp+rename 防误报）；`watch/start|stop` 协议 + `file-modified` 事件（复用现有 sidecar→UI 事件通道，若需新增协议面先过评审）；UI：SFTP 右键「在外部编辑器打开」→ 下载到 `remote-edit/{ts}/` → watch → 「上传一次/总是/取消」；Web/Docker 禁用（沿下载目录探测先例）；会话关闭 `watch/stop-all`。
- **Task P2-6 symlink（10c）**：先 spike russh-sftp 3 的 `symlink`/EXT_EXTENDED 支持（半天），缺则 exec `ln -s` 兜底（`sh_quote` + 路径校验）；`sftp/symlink-create|read|update`；右键菜单 + 列表 `→ target` 显示；审计 + 只读拒绝。
- **Task P2-7 背景图（8e）**：桌面 sidecar 读图（≤8MB，png/jpg/webp）返回 data URL；`appearance.background_*` 入 preferences allowlist；背景层 `pointer-events:none` + 表面 color-mix 透明化 + **挂起 WebGL**（复用 0.6.0 渲染器开关点）；headless 验收开/关无黑屏。
- **Task P2-8 搜索/翻译（8d）**：`TerminalContextMenu.vue`（当前无终端右键菜单，需新建；打开时暂停输入捕获，勿扰 macOS 直写路径）；搜索引擎设置 + URL 构造；宿主无 openExternal → 剪贴板兜底 + toast（docs 记录待宿主 API）；翻译（sidecar `translate.rs`，deepl key 经 vault）后置到宿主 openExternal 可用后。
- **Task P2-9 大输出保护（8f）**：先做输出管线审计（App.vue 写入路径现状，产出附录）；`terminalBackpressure.ts` 状态机（128KB strained / 64KB 恢复 / 32KB 分帧 / visible 200K / hidden 50K）+ 单测；接入写入路径，strained 时 gutter/高亮扫描挂起；「大输出保护已生效/恢复」七语提示（比 NyaTerm 的未接线文案做完整）。

## 5. P3 任务卡（协议级扩展，逐项人工评审）

- **Task P3-1 串口（2c）**：`serialport 4` 阻塞读线程；端口枚举/波特率预设表单；Backspace 同 Telnet；X/Y/ZModem 复用 zmodem 栈；仅桌面。
- **Task P3-2 VNC（2d）**：评估上游 `HsuJv/vnc-rs 0.5.3` 直依 vs 移植 NyaTerm 加固 fork（先上游 + 补有界分配审查）；None/VNC-Auth（≤8 字节密码提示）、Raw/ZRLE/Tight；帧 patch 复用 44 字节头协议走现有二进制帧通道（分帧压测帧率/延迟，不达标降级"低帧率查看"）；前端渲染层移植 `remoteDesktopFrame`/`renderer`/viewport（React 无关）。
- **Task P3-3 X11 spike（7）**：验证 russh 0.62 `x11-req`/`channel_open_x11`（或 `direct-tcpip` 到本机 DISPLAY 兜底）；产出 spike 报告（API 结论/兜底路线/是否立项）再排实现；用户需本机 X server（XQuartz/VcXsrv）；文档警示可信网络使用；read_only 默认禁用。
- **Task P3-4 RDP（2e）立项材料**：vendored fork 链维护计划、CredSSP 凭据处理安全评审清单、带宽压测方案；范围裁剪（密码/NLA + TLS + 文本剪贴板 + 重连；不做音频/驱动器重定向/键盘捕获）。

## 6. 全局约束与交付纪律（沿 v1，更新事实）

- 依赖状态更新：`portable-pty 0.9`、`if-addrs` **已在**；待引入 `rqrr`/`image`/`zip`/`encoding_rs`/`sha3`/`cbc`/`pbkdf2`/`notify`/`serialport`/vnc 引擎，逐个过评审（用途/许可证/维护状态）。
- manifest 冻结：新能力一律 workbench 内面板/临时会话，不改 connection-provider（宿主 `deny_unknown_fields` 契约）。
- 每任务 TDD：sidecar `cargo test`（当前基线 575）+ `vitest`（当前基线 698）+ `vue-tsc` + `pnpm build`；UI 改动过 headless Chrome 走查。
- 每期交付：CHANGELOG 双语、TEST_MATRIX 增行、`docs/COMPARISON.zh-CN.md` 矩阵更新、必要时重生成 `ui/`（integrator 所有）。
- 高风险区（watcher 事件、VNC 帧通道、X11、RDP、Telnet/串口临时会话协议）逐项评审后进独立分支 `codex/ssh/parity-<item>`（RDP 线按评审 F-6 统一为 `codex/ssh/parity-rdp*`）；agents 不自合 PR。

## 7. 边界与未知

- NyaTerm 侧结论以 1:1 源码分析为据（v1 文档 + `/Users/Jinpy/btroot/nyaterm`），移植以行为对齐为准。
- 宿主侧待确认（各半天）：openExternal 有无（8d）、连接写入接口有无（4 的长期归属）、sidecar→UI 事件通道形态（10a）。
- 集成分支为工作基线，未经宿主端到端验收前不合回 main；`ui/index.html` 以后续打包构建为准。
