# Changelog

本文件记录终端（Terminal）的面向用户的版本变更。除非另有说明，版本日期以 GitHub Release 发布日为准。

This file records user-facing changes for Terminal. Unless noted otherwise, version dates follow the corresponding GitHub Release.

## [Unreleased]

- **vim 等 alternate 屏程序下 Ctrl+F 不再弹本地搜索（#108 反馈三）**。0.7.9-beta.3 的 alternate 屏热键透传覆盖了裸 ↑ 与命令历史热键，但漏了新加的 Ctrl+F→终端搜索分流：`resolveCtrlFRoute` 未判 alternate 屏，vim/less/tmux copy-mode 里 Ctrl+F（远端向前翻页）仍被本地搜索框抢占。现 alternate 屏一律放行远端，本地搜索由可配置热键（默认 Ctrl+Shift+F）全场景兜底。
  **Ctrl+F no longer opens the local search box inside alternate-screen programs like vim (#108 feedback 3).** The 0.7.9-beta.3 alternate-screen hotkey passthrough covered bare ↑ and the command-history hotkey but missed the newly added Ctrl+F→terminal-search routing: `resolveCtrlFRoute` had no alternate-screen gate, so vim/less/tmux copy-mode kept losing Ctrl+F (remote page-forward) to the local search box. The alternate screen now always passes Ctrl+F through to the remote; local search remains available everywhere via the configurable hotkey (default Ctrl+Shift+F).

- **定时任务支持本地 Shell 目标与脚本文件**。调度任务编辑器新增两处能力：任务连接可选「本地 Shell」（新连接类型 `io.dbx.ssh.local`——表单只有连接名与可选 Shell 绝对路径，无网络端点、无凭据），让定时/常驻命令直接运行在 DBX 所在机器上（进程级应用环境变量与工作目录，流式日志、取消、超时与 SSH 同契约；取消/超时按进程组 TERM→SIGKILL 清理，本地路径忽略 PTY 选项）；两个触发器均新增可选「脚本文件」字段（带本机文件选择器），与「命令」互斥、至少填一个——SSH 连接把脚本上传到远端 `mktemp` 临时文件以 bash（无则 sh）执行、run 结束必删临时文件，本地 Shell 直接执行该文件。本地化覆盖全部既有语言。
  **Scheduled tasks gain a local shell target and script files.** The task editor adds two capabilities: task connections may bind a "Local shell" target (new connection type `io.dbx.ssh.local` — the form carries only a display name and an optional absolute shell path, no network endpoint and no credentials) so scheduled and resident commands run on the machine running DBX itself (environment and working directory apply at the process level; streaming logs, cancel and timeout follow the same contract as SSH, with cancel/timeout tearing down the whole process group TERM→SIGKILL; the PTY field is ignored on local targets); and both triggers gain an optional "Script file" field (with a native file picker), mutually exclusive with "Command" and at least one required — SSH targets upload the script to a remote `mktemp` temp file, run it with bash (falling back to sh) and always remove the temp file afterwards, while local-shell targets execute the file directly. Localizations cover every shipped language.

## [0.7.10-beta.2] — 2026-10-25

> 预发布基线说明同 [0.7.10-beta.1](#0710-beta1--2026-10-25)：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。
> **Pre-release baseline note:** same as [0.7.10-beta.1](#0710-beta1--2026-10-25) — the scheduler task-provider declaration stays withheld until the DBX host ships the capability.

- **MCP 尺寸设置可正常保存（#241）**。修复三处叠加造成的「保存后又还原」：读取上限默认 256 KiB，回填时被四舍五入成 0，令整段 MCP 表单持续校验失败；校验失败时该段被静默跳过，主保存仍提示「设置已保存」；越界输入（如读取上限填 1024 MiB，sidecar 上限为 8 MiB）只由 sidecar 拒绝，界面既无上限提示也无错误留存。现在亚 MiB 值按小数回填（默认显示 0.25）、输入接受正数并按 sidecar 上限预校验、面板标注各字段上限；MCP 段未提交时不再谎报保存成功。
  **MCP size limits now save correctly (#241).** Fixes three combined causes of "save, then it reverts": the 256 KiB default read limit was rounded to 0 on load, leaving the whole MCP form permanently invalid; an invalid form was skipped silently while the main save still reported success; and an over-ceiling value (e.g. 1024 MiB for the read limit, whose sidecar ceiling is 8 MiB) was only rejected by the sidecar, with no ceiling hint and no visible error. Sub-MiB values now keep their decimals (0.25 by default), inputs accept positive numbers and are pre-validated against the sidecar ceilings, each ceiling is shown in the panel, and a skipped MCP section no longer reports a successful save.

- manifest 版本从 `0.7.10-beta.1` 提升为 `0.7.10-beta.2`；rdp client_build 断言保持 700（0.7.x-beta 家族的 minor 段带 `-beta` 后缀按 0 计）。
  The manifest version moves `0.7.10-beta.1` → `0.7.10-beta.2`; the rdp client_build assertion stays 700 (the `-beta` suffix in the minor segment counts as 0 for the 0.7.x-beta family).

## [0.7.10-beta.1] — 2026-10-25

> 预发布基线说明（延续 0.7.7 系列）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from the 0.7.7 line):** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **SFTP 预览弹窗文件类型图标与「打开方式」入口**。列表与预览标题按扩展名渲染文件类型图标：单一映射表按扩展名给出图标与主题色，未知类型回落通用文件图标，PDF 使用独立的双色文档块图标；预览弹窗新增「打开方式」子菜单，复用右键的「下载副本 + 外部编辑器」链路并支持已知编辑器与自定义命令，多格式预览同步接入。七语文案补齐。
  **File-type icons and an "Open with" entry in the SFTP preview dialog.** The list and preview title render a per-extension file-type icon from a single mapping table (unknown types fall back to the generic file icon, PDF gets its own two-tone document icon); the preview dialog gains an "Open with" submenu that reuses the context-menu "download a copy + external editor" chain, covering known editors and custom commands, and the multi-format previews are wired in too. All seven languages are covered.

- **SFTP sudo 模式卡死修复（跨 TOTP 窗口补答）**。根因：sudo 时间戳按 tty/父进程记账，跨 SSH exec 通道不共享，SFTP 的每个文件操作都会重新认证；TOTP 重放保护拒绝当前窗口的旧码后，exec 车道静默不写 stdin，远端停在 OTP 提示符直到超时（30/60/120 秒）。现 exec 车道复用 `answer_for_with_retry`：重放受阻时等下一个 TOTP 窗口边界用新码补答，截止时间最多顺延一次（保留命令原有剩余预算），仍超出或静态码无法轮转则立即失败并给出可操作提示；密码已预灌时把拼接在同一 chunk 的 Combined 提示降级为 Totp，避免 OTP 提示被整体忽略；GNU/BSD 方言回退只在远端明确拒绝选项时触发，超时或认证失败不再二次 sudo；SFTP 面板加载中允许切换 sudo 模式。
  **SFTP sudo mode no longer hangs (answers across TOTP window boundaries).** Root cause: sudo timestamps are accounted per tty/parent process and are not shared across SSH exec channels, so every SFTP file operation re-authenticates; once TOTP replay protection rejects the current window's code, the exec lane silently stops writing stdin and the remote sits at the OTP prompt until the 30/60/120-second timeout. The exec lane now reuses `answer_for_with_retry`: when a replay is refused it waits for the next TOTP window boundary and answers with a fresh code, extending the deadline at most once (preserving the command's remaining budget), and fails immediately with an actionable message when that is still not enough or the secret is static; when the password was pre-fed, a Combined prompt arriving in the same chunk is downgraded to Totp so the OTP prompt is not dropped; GNU/BSD dialect fallback only triggers on an explicit remote rejection and never retries sudo after a timeout or auth failure; the SFTP panel can switch sudo mode while loading.

- manifest 版本从 `0.7.9` 提升为 `0.7.10-beta.1`；rdp client_build 断言按预发布口径更新为 700。
  The manifest version moves `0.7.9` → `0.7.10-beta.1`; the rdp client_build assertion follows the pre-release convention and becomes 700.

## [0.7.9] — 2026-10-24

- **0.7.9 正式版**。主体内容与 [0.7.9-beta.3](#079-beta3--2026-10-23) 预发布一致：SFTP 自适应传输引擎一期（自研 lzpack `.dbxz` 压缩包模式、下载预取与裸包写流水线、传输性能模型闭环）、sudo PTY 车道假死修复、多格式预览（图片/Office/PDF/媒体/表格/Markdown）、一批 issue 修复（#214 预览选区高亮、#216 历史面板手动输入联动、#217 堡垒机目标会话注册表清理、#218 连接过渡反馈、#219 字体控件覆盖态同步、#220 触摸板幽灵拖选守卫、#223 乱码定性文档、#224a 命令参数即时提示 v1、MCP SFTP 错误串回填数字状态码）；另含 beta.3 之后合入的内容：Alt/Option 按词编辑（←/→ 跳词、Backspace/Delete 删词，终端设置可关，词编辑后暂停不可信补全）、SFTP 面板打开固定从服务器主目录开始（不再继承其他主机的路径）、SFTP 工具栏新增「定位到终端目录」按钮（与跟随终端开关解耦的一次性跳转）、MCP stdio 面支持 MCP 2026-07-28 修订版（成功结果强制 `resultType`、`initialize` 版本协商回显、`server/discover` 能力发现）。manifest 版本从 `0.7.9-beta.3` 提升为 `0.7.9`。调度任务功能声明延续摘除——待 DBX 上游发布宿主侧 task-provider 能力后恢复。
  **0.7.9 stable.** The core content matches the [0.7.9-beta.3](#079-beta3--2026-10-23) pre-release: adaptive SFTP transfer engine phase one (self-contained lzpack `.dbxz` archive mode, download prefetch and raw-write pipelining, and the closed-loop transfer performance model), the sudo PTY lane hang fix, multi-format preview (image/Office/PDF/media/spreadsheet/Markdown), and the issue sweep (#214 preview selection highlight, #216 history-panel typing linkage, #217 bastion target-session registry cleanup, #218 connection transition feedback, #219 font control override sync, #220 touchpad ghost-drag guard, #223 garbled-text writeup, #224a flag hints v1, and MCP SFTP error strings carrying numeric status codes). Beyond beta.3 it also carries: Alt/Option word editing (←/→ word movement, Backspace/Delete word deletion, opt-out in terminal settings, stale suggestions paused after edits), the SFTP panel opening at the server home directory instead of inheriting another host's path, a new SFTP toolbar "jump to terminal directory" button (a one-shot jump decoupled from the follow toggle), and MCP 2026-07-28 conformance on the stdio face (mandatory `resultType`, `initialize` version-negotiation echo, and `server/discover`). The manifest version moves `0.7.9-beta.3` → `0.7.9`. The scheduler feature declaration stays withheld until the DBX host ships the task-provider capability.

## [0.7.9-beta.3] — 2026-10-23

> 预发布基线说明（延续 0.7.7 系列）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from the 0.7.7 line):** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **SFTP 自适应传输引擎一期**。三块能力：①自研 lzpack 压缩包模式（`sftp/upload/start` 增 `mode:"lzpack"` 交付 `<目标名>.dbxz`；`sftp/download/start` 增 `expandLzpack:true` 还原原始文件）——压缩/解压全在本地（DBXZ v1 容器，LZ77 + RAW 回退），远端零依赖，shell-less 服务器完整可用，文件菜单新增「压缩上传为 .dbxz / 解压 .dbxz」两入口；②下载预取与裸包写流水线：普通单文件下载后台预读下一片（命中省一个整 RTT），latin-1 裸包上传改 8×32KiB 有界在途窗口统一收 ACK，高延迟链路吞吐显著提升；③传输性能模型：每连接上传/下载分离 EMA 带宽 + codec 实测吞吐回灌，显式压缩 start 时顾问预测（样本不足沉默、负收益仅日志提示不拦截），连接断开清理档案。
  **Adaptive SFTP transfer engine, phase one.** Three blocks: (1) self-contained lzpack archive mode (`mode:"lzpack"` on upload delivers `<name>.dbxz`; `expandLzpack:true` on download restores the original file) — compression and decompression run entirely locally (DBXZ v1 container, LZ77 with RAW fallback), zero remote dependencies, fully usable on shell-less servers; the file menu gains "Upload as compressed (.dbxz)" and "Expand .dbxz" entries. (2) Download prefetch and raw-write pipelining: plain single-file downloads pre-read the next chunk in the background (a hit saves a full RTT), latin-1 raw uploads switch to a bounded 8×32 KiB in-flight window with batched ACKs, markedly better throughput on high-latency links. (3) Transfer performance model: per-connection upload/download EMA bandwidth plus measured codec throughput, an advisor prediction on explicit-compression starts (silent when under-sampled, log-only on negative gain — never blocks), and profile cleanup on disconnect.

- **sudo PTY 车道修复**（`sudo_use_pty` 连接）：PTY 下 sudo/PAM 密码读取器冲掉预灌输入（termios TCSAFLUSH），原管道路径提示词永不渲染导致挂满超时；现走「可见提示词 + watcher 补答 + 输出剥提示词」，sudo 车道 SFTP 操作不再假死。
  **sudo PTY lane fix** (for `sudo_use_pty` connections): under a PTY the sudo/PAM password reader flushes typed-ahead input (termios TCSAFLUSH), so the pipe-path silent prompt never rendered and every sudo-lane SFTP op ran to full timeout; now uses a visible prompt with watcher answering and prompt stripping from output.

- **多格式预览**（自 files 插件移植）：图片/Office/PDF/媒体/表格/Markdown 预览链路，sftp/read(offset) 1MiB 流式拼装（≤256MiB），进度/取消/断点续传；sudo 模式整链换 sudo/readFile。
  **Multi-format preview** (ported from the files plugin): image/Office/PDF/media/spreadsheet/Markdown pipelines stream via `sftp/read(offset)` in 1 MiB slices (≤256 MiB) with progress, cancel and resume; sudo mode switches the whole chain to sudo/readFile.

- 新增默认开启的 Alt/Option 按词编辑：←/→ 跳词，Backspace/Delete 删除光标前/后的词；可在终端设置关闭。保留自定义热键、输入法和全屏程序按键，并在词编辑后暂停不可信的补全提示。
  Add default-on Alt/Option word movement and deletion with a terminal settings opt-out; preserve custom hotkeys, composition and alternate-screen keys, and suppress stale suggestions after word edits.

- **一批 issue 修复**：#214 预览选区高亮、#216 历史面板手动输入联动（打字收起/常驻过滤）、#217 堡垒机目标会话注册表清理、#218 连接过渡反馈、#219 字体控件覆盖态同步、#220 触摸板幽灵拖选守卫、#223 乱码定性文档、#224a 命令参数即时提示 v1、MCP SFTP 错误串回填数字状态码。
  **Issue sweep:** #214 preview selection highlight, #216 history-panel typing linkage, #217 bastion target-session registry cleanup, #218 connection transition feedback, #219 font control override sync, #220 touchpad ghost-drag guard, #223 garbled-text writeup, #224a flag hints v1, and MCP SFTP error strings carrying numeric status codes.

- 完整实测与决策口径见 `docs/PERF_REPORT_SFTP_TURBO.zh-CN.md`（lzpack 微基准三档、真机 100MiB 端到端、跨平台 musl 双架构 check；Windows 构建由 CI windows job 覆盖）。
  Full measurements and decision rationale in `docs/PERF_REPORT_SFTP_TURBO.zh-CN.md`.

## [0.7.9-beta.2] — 2026-10-19

> 预发布基线说明（延续 0.7.7 系列）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from the 0.7.7 line):** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **SFTP 上传大文件 flush timeout 修复（#206）**。SFTP 库按单个请求默认 10 秒超时，慢链路/经跳板时大文件上传的批量在途写请求单个确认超时即整体失败；现统一放宽到 60 秒（老旧服务器兼容模式的串行并发语义不变），覆盖工作台主 SFTP、定时任务脚本上传与 MCP 三处会话创建点。
  **Large-upload "flush timeout" fixed (#206).** The SFTP library applies a 10-second default timeout per request, so on slow links or through jump hosts a single in-flight WRITE acknowledgement over budget failed the whole upload; the per-request timeout is now uniformly widened to 60s (compat-mode serialised concurrency unchanged) across all three session creation sites: the workbench SFTP, scheduled-task script upload and MCP.
- **上下布局分栏拖动生效 + 把手提示按轴向（#207）**。「始终上下」与窄屏断点下两栏高度此前被样式钉死在 52%/48%，拖动把手与键盘微调均不生效；现高度由分栏比例驱动（拖拽、↑/↓ 微调与持久化即时生效），把手悬浮提示在纵向布局显示「调整高度」（七语）。
  **Stacked-layout split dragging works, with axis-aware divider hints (#207).** In the always-stacked layout and the narrow-viewport breakpoint the two panes were pinned to 52%/48% by CSS, so dragging the divider (and keyboard nudging) did nothing; heights now follow the split ratio (drag, ↑/↓ nudge and persistence apply immediately), and the divider tooltip reads "resize height" in the stacked layout (all seven languages).
- **SFTP 目录跟随/自动加载失败静默化（#209）**。连堡垒机时 SFTP 面板挂载堡垒机自身文件系统，目录跟随与连接后自动首拉用目标机路径加载失败会弹全局错误横幅；现改为面板内低调软提示条（含路径与重试按钮，原始错误进悬停提示），sudo 权限墙引导迁入软条，用户手动操作失败行为不变。
  **Quiet in-panel failures for SFTP directory-follow and auto-load (#209).** Against bastion hosts the SFTP panel mounts the bastion's own filesystem, so follow-the-terminal and post-connect auto loads failed with a global error banner; failures now surface as a low-key in-panel soft bar (path + retry, raw error in a hover tooltip), the sudo-permission-wall guidance moved into the soft bar, and manual actions keep the banner.
- **Ctrl+R 历史面板热键在 alternate 屏透传远端（#108 反馈二顺带）**。热键在功能开启但门控关闭时一律吞键，vim 的 Ctrl+R（redo）、less/tmux copy-mode 的 ^R 被无声吞掉；现总开关关闭或 alternate 屏时透传远端，传输占用/OTP 待答/浮层开启等场景维持吞键（避免污染传输字节流或验证码输入）。堡垒机列表页按 ↑ 弹历史窗的主修复（正向证据门）随 composer 特性线交付。
  **History-panel hotkey (Ctrl+R) now passes through to the remote on the alternate screen (#108 feedback 2).** With the feature enabled but a gate closed the hotkey was swallowed with no action, eating vim's Ctrl+R (redo) and less/tmux copy-mode ^R; it now passes through when the master switch is off or the alternate screen is active, while transfer-busy/OTP-pending/overlay-open states keep swallowing (keeping transfer byte streams and code prompts clean). The primary fix for the bastion list capturing ↑ (a positive-evidence gate) ships with the composer feature line.

## [0.7.9-beta.1] — 2026-10-19

> 预发布基线说明（延续 0.7.7 系列）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from the 0.7.7 line):** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **web/Docker 部署浏览器侧 SSH 传输中断自愈**。HTTP(S) 浏览器部署下，浏览器与宿主之间的连接中断此前不产生任何 SSH 会话事件：终端停在旧画面，键盘输入被一次永不落定的桥接发送堵住后续所有击键，网络恢复后也不会自动回到会话。现新增传输看守：online/offline 事件给即时信号；对 navigator.onLine 恒真的 Docker/WebSocket 路径用有界探测兜底（5s 间隔、8s 超时，另加 2s 同源可达性探测决定何时安全重连）；探测走只读 replay RPC，顺带补齐中断期间丢失的输出帧；连通后自动重新 attach 会话。输入队列的桥接发送加超时上限，单次失联的发送不再把后续击键链在永不结算的 Promise 后。
  **Browser-side SSH transport self-healing for web/Docker deployments.** In HTTP(S) browser deployments, an outage between the browser and the host previously produced no SSH session event at all: the terminal froze on stale output, one never-settling bridge send stalled every later keystroke, and connectivity coming back did not rejoin the session. A transport watcher now uses online/offline events for an immediate signal and covers Docker/WebSocket paths where navigator.onLine stays true with a bounded probe (5s interval, 8s timeout, plus a 2s same-origin reachability check to decide when re-attaching is safe); the probe is the read-only replay RPC, which also backfills output frames missed during the outage; the session re-attaches automatically once connectivity returns. Bridge sends from the input queue get a bounded timeout so one dropped connection can no longer chain every later keystroke behind a promise that never settles.
- **批量发送全部成功后结果浮条自动收起**。「已发送到 N 个会话」此前只能手动关闭；现全部成功 3.5 秒后自动收起（与普通通知 toast 同时长），有失败行或发送异常时常驻供逐行排查，手动关闭保留。
  **Batch-send summary bar auto-dismisses after full success.** The "Sent to N session(s)" bar used to stay until manually closed; on full success it now auto-dismisses after 3.5 seconds (same duration as ordinary notice toasts), while partial failures and send errors stay visible for row-by-row triage, with manual close kept.
- **批量发送快速命令选择对齐右上角面板形态**。平铺下拉换成同形态弹层：搜索框、可折叠分组头（组名 + 计数徽标，与面板共用折叠状态）、命令卡片显示名称与命令预览；点击卡片回填批量输入框（发送仍由回车/发送按钮触发）；无真实分组时保持平铺，不渲染噪声组头。
  **Batch-send quick-command picker now mirrors the top-right quick-commands panel.** The flat dropdown becomes a same-shaped popover: a search box, collapsible group headers (name + count badge, sharing the panel's collapse state) and command cards showing the name with a command preview; clicking a card fills the batch input (sending stays on Enter/the send button); with no real groups the list stays flat instead of rendering noise headers.

## [0.7.8] — 2026-10-19

- **0.7.8 正式版**。内容与 [0.7.8-beta.1](#078-beta1--2026-10-18) 预发布完全一致：web 刷新后连接恢复失败修复（#202——后端幂等注册 + 残留清扫顺带修 Quick Sudo 保活静默失效，前端主动请求宿主重开）、lrzsz `rz` 直传上传支持与 trz/zmodem 传输鼠标指针修复（#171）、Ctrl+F 打开终端搜索（#108）、快速指令分组与上限 200（#201）、SFTP 面板布局方向偏好自动/始终上下/始终左右（#187）、Docker 面板宽度可拖拽 300~720 持久化（#170）、MCP 工具面二轮瘦身 tools/list 实测 43,842 字符并文档化预算口径（#203，#190/#188 同根因随本轮解决）、设置页配色方案排版修复（#163），经 beta 验证后仅版本号转正；manifest 版本从 `0.7.8-beta.1` 提升为 `0.7.8`。调度任务功能声明延续摘除——待 DBX 上游发布宿主侧 task-provider 能力后恢复。
  **0.7.8 stable.** Content is identical to the [0.7.8-beta.1](#078-beta1--2026-10-18) pre-release: the web-refresh connection-recovery fix (#202 — idempotent re-registration + residue sweep on the backend, which also fixes Quick Sudo keepalives silently breaking, plus the frontend actively asking the host to reopen), classic lrzsz `rz` upload support and the transfer-time mouse-pointer fix (#171), Ctrl+F terminal search (#108), quick-command groups with the 200-entry cap (#201), the SFTP pane layout-direction preference auto/always-stacked/always-side-by-side (#187), the draggable 300–720px Docker panel width (#170), the second MCP tool-face slimming round with tools/list measured at 43,842 chars and the budget contract documented (#203; #190/#188 share the root cause and are resolved by the same round), and the color-scheme settings layout fix (#163) — promoted after beta validation with only the version number finalized; the manifest version moves `0.7.8-beta.1` → `0.7.8`. The scheduler feature declaration stays withheld until the DBX host ships the task-provider capability.

## [0.7.8-beta.1] — 2026-10-18

> 预发布基线说明（延续 0.7.7 系列）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from the 0.7.7 line):** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **web 刷新后连接恢复失败修复（#202）**。浏览器直接刷新打开中的连接时，工作台此前无限重试「正在连接（第 13 次尝试）」永不成功：web 刷新不重启宿主、不会重放 `connection/connect`，而 sidecar 连接注册表在纯内存中，boot-restore 重试窗口内永远等不到凭据。后端现把同连接重复注册改为严格幂等并清扫上一轮残留（绑定死会话的 Quick Sudo 保活——顺带修复刷新重连后保活静默失效、孤儿会话缓存、无会话的端口转发表），空注册表下 open/attach/write/close 立即返回结构化错误（单测逐字锁定）；前端恢复失败时主动请求宿主重开连接（`reopenConnection` 幂等），宿主明确拒绝后立即失败不再空烧重试窗口。
  **Connection recovery after a browser refresh fixed (#202).** Refreshing the browser with a live connection used to spin forever on "connecting (attempt 13)": a web refresh does not restart the host and therefore never replays `connection/connect`, while the sidecar connection registry lives purely in memory, so the boot-restore retry window waited for credentials that could never arrive. The backend now treats re-registering the same connection as strictly idempotent and sweeps the previous round's residue (Quick Sudo keepalives bound to dead sessions — also fixing keepalives silently breaking after refresh-reconnect, orphaned session caches, and port-forward tables without sessions), and open/attach/write/close against an empty registry fail fast with structured errors (locked verbatim by unit tests); the frontend actively asks the host to reopen the connection on restore failure (`reopenConnection` is idempotent) and fails immediately once the host explicitly refuses instead of burning the retry window.
- **lrzsz `rz` 直传上传支持（#171）**。此前仅 `sz` 下载自动接收（0.7.4 起）与 trzsz `trz`/`tsz`；现支持经典 lrzsz 的 `rz`：检测按完整 hex ZRINIT 帧匹配（`**\x18B` 前缀 + 帧体 + CRC16-CCITT 校验通过）才触发，任何不完整/歧义序列一律不接管；触发时不自动占线，终端上方出现非阻塞提示「选择文件上传 / 取消」，确认后才弹文件选择（10 秒未确认自动取消并回注 abort 序列），rz 重发的 keep-alive ZRINIT 不叠加提示。误报样例（含 `**` 前缀的普通文本、坏 CRC 帧）均有单测锁定。
  **Classic lrzsz `rz` upload support (#171).** Only `sz` auto-receive (since 0.7.4) and trzsz `trz`/`tsz` worked before; the classic lrzsz `rz` now works too. Detection engages only on a complete hex ZRINIT frame (`**\x18B` prefix + body + a passing CRC16-CCITT check) and never on partial or ambiguous sequences; engaging does not seize the terminal — a non-blocking banner offers "choose files to upload / cancel", the file picker opens only after confirmation (auto-cancels with the abort sequence after 10s), and rz's keep-alive ZRINIT re-sends never stack prompts. False-positive samples (plain text containing `**`, bad-CRC frames) are locked by unit tests.
- **trz/zmodem 传输期间鼠标指针不可见修复（#171）**。传输占用期间终端面板现显式钉住系统箭头光标（类切换强制命中重算），进度卡取消按钮可点性不受影响。
  **Mouse pointer stays visible during trz/zmodem transfers (#171).** While a transfer owns the terminal, the pane now pins the system arrow cursor explicitly (the class toggle forces a hit-test recompute); the progress card's cancel button keeps working.
- **Ctrl+F 打开终端搜索（#108）**。Ctrl+F 此前被 ghost 命令建议的「整段接受」占用，无法搜索终端内容；现仅当 ghost 建议实际可见待接受时 Ctrl+F 才是接受键，其余情况直接打开终端搜索（iTerm2 同位）；→ / Ctrl+E 接受行为不变，trz/zmodem 传输占用期间按键照旧透传。
  **Ctrl+F opens terminal search (#108).** Ctrl+F used to be captured by the ghost suggestion's "accept whole suggestion" binding, leaving terminal content unsearchable; it now accepts a suggestion only when one is actually visible and pending, and opens terminal search otherwise (iTerm2 parity). → / Ctrl+E acceptance is unchanged, and keys still pass through while a trz/zmodem transfer owns the input.
- **快速指令分组与上限放宽（#201）**。上限从 20 条放宽到 200 条；命令可归属分组（未分组恒排最前、空组自然消失），设置页与工作台弹层均支持分组折叠展示，编辑时可选既有组或新建分组，组头可改名/解散（带确认弹窗）；旧数据自动迁移到「未分组」，schema 保持扁平、兼容云同步；计数文案改为「N 组 · M 条」，搜索同时匹配组名。
  **Quick-command groups and a higher cap (#201).** The limit rises from 20 to 200 entries; commands can belong to groups (ungrouped always sorts first, empty groups disappear), both the settings page and the workbench popup show collapsible groups, the editor offers existing or new groups, and group headers can be renamed or dissolved (with a confirm dialog); existing data migrates to "ungrouped" automatically while the schema stays flat and cloud-sync compatible; the counter reads "N groups · M entries" and search matches group names too.
- **SFTP 面板位置可固定在底部（#187）**。布局方向此前完全由视口宽度决定（≤900px 上下、宽屏左右）；现设置 → 终端 → 工作台布局新增「布局方向」三选：自动（默认，保持现状）/ 始终上下（终端在上、SFTP 在下）/ 始终左右，持久化并随 workbenchState 跨重启同步；强制纵向时分栏拖拽把手自动按 Y 轴/高度方向工作。
  **The SFTP pane can now be pinned to the bottom (#187).** Pane direction used to follow the viewport alone (stacked at ≤900px, side-by-side above); Settings → Terminal → Workbench layout gains a three-way "layout direction" preference: auto (default, unchanged behavior) / always stacked (terminal on top, SFTP at the bottom) / always side-by-side, persisted and synced across restarts via workbenchState; the split drag handle works along the Y axis/height when forced vertical.
- **Docker 面板宽度可拖拽（#170）**。面板宽度此前固定导致内容显示不全；现左缘新增拖拽手柄，宽度可调（300~720px），拖完自动记忆（重启读回）；表格列在宽面板下自然展宽，窄面板维持横向滚动兜底。
  **Docker panel width is now draggable (#170).** The fixed width previously cut content off; a drag handle on the left edge resizes the panel (300–720px) and the chosen width is remembered across restarts; table columns stretch naturally on wider panels while narrow widths keep the horizontal-scroll fallback.
- **MCP 工具面二轮瘦身，tools/list 实测 43,842 字符（#203）**。第一轮瘦身（0.7.7 的 33→16 工具）后 raw `tools/list` 仍达 49,492 字符，桥包装文本 ≈44.5k，贴 Claude Code ≈50,000 字符落盘线无余量；本轮只精简工具描述文案（不动工具数/方法名/参数名/语义/安全警告）后实测 raw **43,842 字符**、桥文本 ≈39.5k，余量约 10k。预算测试收紧为断言 raw ≤ 50,000，注释与 PROTOCOL 文档写明计量口径（桥文本 ≈ raw × 0.9；Claude Code ≈50k 最严、Qoder CLI ≈75k）；AI 助手无法调用 SSH 工具（#190）与「SSH 通道是否支持 agent MCP」（#188）同根因，随本轮一并解决。
  **Second MCP tool-face slimming round — tools/list measured at 43,842 chars (#203).** After the first round (33→16 tools in 0.7.7) the raw `tools/list` still measured 49,492 chars with a ≈44.5k bridge-wrapped text, hugging Claude Code's ≈50,000-char persistence threshold with no headroom; this round trims tool description prose only (tool count, method names, parameters, semantics and safety warnings untouched), landing at a measured **43,842 raw chars** (≈39.5k bridged, ~10k of headroom). The budget test now asserts raw ≤ 50,000, with the measurement contract documented in the test comment and the PROTOCOL doc (bridge text ≈ raw × 0.9; Claude Code ≈50k strictest, Qoder CLI ≈75k). The AI-assistant tool-call failures (#190) and the "does the SSH channel support agent MCP" question (#188) share this root cause and are resolved by the same round.
- **设置页配色方案排版修复（#163）**。预设方案 chips 换行时被 flex 压缩出裁切重叠（现正常换行、行高一致、超长名称省略号截断）；「主题名称 + 保存当前为我的主题 + 恢复默认外观」行的间距与按钮对齐与其他设置区块统一（英文长文案不再折行错乱）。
  **Color-scheme settings page layout fixed (#163).** Preset scheme chips no longer clip/overlap when wrapping (clean wraps, uniform row height, ellipsis for long names), and the theme-name + save + restore row now aligns with the other settings blocks (long English labels no longer wrap messily).

## [0.7.7] — 2026-10-17

- **0.7.7 正式版**。内容与 [0.7.7-beta.1](#077-beta1--2026-10-16) / [0.7.7-beta.2](#077-beta2--2026-10-17) 两个预发布完全一致：连接提速（消除 SSH 拨号前 4.5 秒协议查询空等）、宽字符行关键词高亮与链接定位修复（#185）、终端 2026 同步窗跨帧边界长时间卡死修复（codex cli 流式应用）、手动重连前先恢复 SSH 连接注册、本地任务进程组 killpg 化（以上 beta.1）；SFTP 上传批次卡收尾与失败可见（#165）、本地终端中文乱码全平台收口（#173——Unix locale 注入 + Windows ConPTY UTF-8 代码页）、批量操作目标行跟随终端改名（#193b，需宿主 ≥ `workbenchTitles` 通道，缺字段宿主优雅降级；#193a 的宿主侧修复见宿主仓库对应 PR，不随本插件交付）、命令历史采集修复 Tab 补全/方向键脱敏行与历史条数可配置（#192）、快捷指令执行后 ghost 行内建议残留消除（#196）、SFTP 拖拽取消后高亮卡住修复（#197），经 beta 验证后仅版本号转正；manifest 版本从 `0.7.7-beta.2` 提升为 `0.7.7`。调度任务功能声明继续摘除——待 DBX 上游发布宿主侧 task-provider 能力后恢复。
  **0.7.7 stable.** Content is identical to the [0.7.7-beta.1](#077-beta1--2026-10-16) / [0.7.7-beta.2](#077-beta2--2026-10-17) pre-releases: faster connects (the 4.5-second pre-dial protocol-query idle is gone), keyword highlight and link positioning on wide-character rows (#185), the long terminal stall when a CSI ?2026 synchronized-update window spans a read boundary (codex cli), manual reconnects restoring the SSH connection registration first, and killpg-based local task teardown (beta.1); the SFTP upload batch card settle and failure visibility (#165), the cross-platform CJK local-shell fix (#173 — Unix locale fallback plus Windows ConPTY UTF-8 code page), batch-send target rows following renamed terminals (#193b, requires a host with `workbenchTitles`, degrading gracefully without it; the #193a host-side fix lives in the host repository and does not ship with this plugin), command-history capture fixes for Tab-completion/arrow-desynced lines plus a configurable history limit (#192), the quick-command ghost-suggestion residue fix (#196), and the SFTP drag-cancel highlight fix (#197) — promoted after beta validation with only the version number finalized; the manifest version moves `0.7.7-beta.2` → `0.7.7`. The scheduler feature declaration stays withheld until the DBX host ships the task-provider capability.

## [0.7.7-beta.2] — 2026-10-17

> 预发布基线说明（延续 beta.1）：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from beta.1):** the scheduler task-provider contribution stays withheld on this line — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **上传批次卡收尾与失败可见（#165）**。批次卡此前在整批结束后永久悬挂，且任务账本 30 秒终态清收删掉任务行后聚合归零、卡片回跳成「0/N · 0%」；现批次编排结束（含失败中止）后经 2.5 秒保留窗口统一收尾清卡，批间重叠由批次键守卫；面板重开时后端重列任务不再冲掉前端批次键。批次卡新增失败后缀（仅在有失败时出现）：失败计入完成数、不吞总数。
  **Batch card wrap-up and failure visibility (#165).** The batch card used to linger forever after a batch finished, and the transfer ledger's 30-second terminal sweep deleted the task rows the aggregation reads, regressing the card to "0/N · 0%". The card now clears 2.5s after the batch orchestration settles (including mid-batch failure aborts), with the batch id guarding overlapping batches; reopening the panel no longer wipes the frontend-only batch key when the backend re-lists tasks. The card gains a failed suffix (shown only when failures exist): failed files count toward progress without eating the total.
- **本地终端中文乱码修复（#173）**。DBX 以 GUI 进程启动插件 sidecar，GUI 会话不携带 `LANG`，本地 Shell 的 PTY 子 shell 因此回落 C locale——中日韩输入按字节断裂（行编辑、补全、文件名显示乱码；macOS 终端 App 惯常代设的 LANG 在这里无人补上）。现 `local/terminal/start` 在净化后的用户 env 与继承环境都未携带非空 `LANG`/`LC_ALL`/`LC_CTYPE` 时注入 UTF-8 locale（macOS `en_US.UTF-8`、Linux `C.UTF-8`）：用户在环境变量偏好/连接表单显式设置的 locale 永不被覆盖。Windows 侧同 issue 一并收口：中文 Windows 的 ConPTY 子进程控制台默认落在 GBK 代码页 936，一切信任控制台代码页的输出（`cmd type`、git、node 一类 UTF-8 程序）与终端的 UTF-8 错位，中文必然乱码；现按 shell 类型在 spawn argv 上注入 UTF-8 预设——`chcp 65001` 翻转控制台输入/输出代码页（conhost 字节转换与 CRT 跟随），PowerShell 额外预置 `[Console]::OutputEncoding=UTF8`（ConsoleHost 用进程启动时缓存的该编码解码原生命令输出，.NET Framework 缓存不随 `chcp` 更新，实测 `cmd /c chcp` 已报 65001 而 `cmd /c type` 一个 UTF-8 文件仍乱码，两层都设后字节精确）——PS 折入既有的 `-Command` 载荷（integration 注入关闭时补 `-NoExit -Command` 保持交互），cmd 包一层 `/k chcp 65001>nul&title %COMSPEC%`（`title` 复位，避免 chcp 命令行残留为会话标题），wsl 与未知 shell 不动（WSL 自成 UTF-8 世界、任意 shell 无安全 argv 注入面）。改写仅涉 argv：用户显式 env 合并语义不受影响，`chcp` 自身输出已静音，ConPTY 启动握手与启动窗口 resize 门控看到的流量不变。已知取舍：代码页切到 65001 后，仍按 GBK 编码输出的遗留程序（如 `type` 一个 ANSI/GBK 编码文件）会反过来乱码——与 Windows Terminal「使用 Unicode UTF-8」测试选项及所有现代终端同一取舍。
  **Local terminal CJK garbling fixed (#173).** DBX launches the plugin sidecar as a GUI process, and GUI sessions carry no `LANG`, so the local shell's PTY child fell back to the C locale — CJK input broke down per byte (line editing, completion and filename display garbled; the LANG that Terminal.app-like apps usually set was never provided here). `local/terminal/start` now injects a UTF-8 locale (macOS `en_US.UTF-8`, Linux `C.UTF-8`) when neither the sanitized user env nor the inherited environment names a non-empty `LANG`/`LC_ALL`/`LC_CTYPE`: a locale explicitly set in the env preferences or the connection form is never overridden. The Windows side of the same issue is closed here too: on a Chinese/GBK Windows the ConPTY child console boots at code page 936, where every program that trusts the console code page (`cmd type`, git, node — UTF-8 emitters) mis-aligns with the terminal's UTF-8 and CJK output garbles; the spawn argv now injects UTF-8 presets per shell kind — `chcp 65001` flips the console input/output code page (conhost byte conversions and the CRT follow), and PowerShell additionally presets `[Console]::OutputEncoding=UTF8` (ConsoleHost decodes native-command output through that process-start-cached encoding; .NET Framework never re-reads it after `chcp` — measured: `cmd /c chcp` reported 65001 while `cmd /c type` of a UTF-8 file still garbled, and presetting both layers made the bytes exact) — folded into PowerShell's existing `-Command` payload (with a `-NoExit -Command` stand-in keeping the shell interactive when integration injection is off), and cmd wrapped as `/k chcp 65001>nul&title %COMSPEC%` (the `title` reset keeps the chcp command line from lingering as the session title), while wsl and unknown shells stay untouched (WSL runs its own UTF-8 world and arbitrary shells have no safe argv seam). The rewrite is argv-only: the user env merge semantics are untouched, `chcp`'s own output is suppressed, and the ConPTY startup handshake and startup-window resize gate see the same traffic as before. Known trade-off: at code page 65001, legacy programs that still emit GBK (e.g. `type` of an ANSI/GBK-encoded file) garble the other way round — the same trade as Windows Terminal's "Use Unicode UTF-8" beta option and every modern terminal.
- **批量操作目标行跟随终端改名（#193b，需宿主 ≥ `workbenchTitles` 通道）**。批量发送面板的目标行标签此前只认连接名：用户给底部 dock 终端条目改名后，面板里仍显示连接名。现宿主 `host.listConnections` 每行新增 `workbenchTitles`（宿主按「dock 终端条目 → 工作台 tab」聚合、dock 在前），标签优先级扩展为 标题 → 连接名 → user@host；旧宿主缺该字段时行为完全不变。
  **Batch-send target rows follow renamed terminals (#193b, requires a host with `workbenchTitles`).** Batch-send rows previously only knew the connection name, so renaming a bottom-dock terminal entry never showed up in the panel. The host's `host.listConnections` rows now carry `workbenchTitles` (aggregated as dock entries first, then workbench tabs); the label priority becomes title → connection name → user@host, with behavior unchanged on hosts that lack the field.
- **命令历史采集修复 Tab 补全与方向键脱敏行（#192）+ 历史条数可配置**。历史面板此前只在「按键模型逐字出现在屏幕回显」时采集命令：Tab 补全后继续输入（cp/mv 补全路径、sh 脚本名）会让模型停在过期前缀上，方向键召回（重跑 sh 脚本的最常用姿势）与光标移动又让模型整段被 ESC 块跳过——两类日常流程的命令都进不了历史。现 EnterLineTracker 按行记录「首个行重写事件时的模型锚点 + 其后可见按键回显活性证明」，从屏幕反向提取命令（证明在光标行、锚在重写前缀，venv 式提示符与重定向已验证）；反斜杠续行（多行 cp/管道）并入单条，与远端历史导入同语义，Ctrl+C 丢弃草稿；凭据/选择类提示与 readline 反向搜索 UI 行双重拒绝（延续 #150）。命令历史上限改为可配置（设置项，默认不变）。
  **Command history captures Tab/arrow-desynced lines (#192) and a configurable history cap.** The history panel previously recorded a command only when the keystroke model appeared verbatim in the screen echo: typing after Tab completion desynced the model onto a stale prefix, and arrow-key recall (the usual way to re-run a script) or cursor moves left the model empty — both everyday flows silently never reached history. EnterLineTracker now records, per line, the model at the first line-rewrite event (anchor) plus the visible keys typed after it (echo-liveness proof) and re-derives the command from the screen; backslash continuations join into a single entry with the same semantics as the remote history import, Ctrl+C discards the draft, credential/selection prompts and readline reverse-search UI lines stay rejected (carrying #150 forward). The history count becomes configurable in settings (default unchanged).
- **快捷指令执行后 ghost 行内建议残留消除（#196）**。快捷指令 Run/Paste 与 sudo -v 刷新是 PTY 程序化写入、不经用户键入路由，ghost 门状态机不推进——已展示的灰字建议重锚到回滚贴底的光标行上且不自动消失（「执行快捷指令后最下面有个文字挡住光标行」）。现 writeQuickCommand（Run/Paste 两态）与 sendSudoRefresh 在写入前先消除 ghost，对齐粘贴路径的既有语义；带组合桩回归用例（修复前 4 例失败，修复后全绿）。
  **Ghost inline suggestions no longer linger after quick commands (#196).** Quick-command Run/Paste and the sudo -v refresh write to the PTY programmatically, bypassing the user-typing route, so the ghost gate never advances and a shown suggestion re-anchors onto the cursor row and stays there ("text blocking the cursor line after running a quick command"). writeQuickCommand (both modes) and sendSudoRefresh now dismiss the ghost before sending, matching the existing paste-path semantics, with a composed-stub regression spec (4 failing cases before the fix, all green after).
- **SFTP 拖拽高亮在拖拽取消后不再卡住（#197）**。文件拖入经子元素离开窗格时（拖出窗口、Esc 取消）`@dragleave.self` 不触发，SFTP 窗格的上传高亮遮罩永久卡住。现按 `relatedTarget` 判定离开（子树内离开保持高亮不闪烁，指向外部或 null 即复位），终端窗格高亮同生命周期，另加窗口级 dragleave 兜底；组合式生命周期用例 + smoke 走查复现旧失败。
  **SFTP drag highlight unsticks when a drag is cancelled without drop (#197).** File drags entering the SFTP pane lit the upload overlay, but `@dragleave.self` only cleared it when the leave fired on the pane element itself — a leave bubbling from a child (dragging out of the window, Esc cancel) swallowed the event and the pane stayed stuck on the overlay. The reset now decides by `relatedTarget` (leaves inside the subtree keep the highlight without flicker, leaves pointing outside or null reset it), the terminal pane highlight shares the same lifecycle, and a window-level dragleave fallback clears both flags; covered by a composable lifecycle spec and a smoke_ui_mock walkthrough reproducing the old failure.

## [0.7.7-beta.1] — 2026-10-16

> 预发布基线说明：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note:** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

> 预发布基线说明：调度任务（task-provider）功能声明继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note:** the scheduler task-provider contribution stays withheld — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **连接提速：SSH 连接不再白等 4.5 秒**。0.7.6 引入的 `connection/protocol` 前端查询窗口对 SSH 连接永远拿不到答案（sidecar 只暂存非 SSH 协议），于是每次打开 SSH 连接都在拨号前多等一整个窗口；现 sidecar 对已登记的 SSH 连接直接回答 `"ssh"`，前端窗口同时从「恢复态 10×500ms / 常规 2×250ms」收敛到「4×250ms / 2×250ms」，实测同一连接的协议查询从 10 次、跨 4.5 秒降到 4 次、跨 0.75 秒。
  **Faster connects: SSH no longer idles for 4.5 seconds.** The `connection/protocol` query window introduced in 0.7.6 could never be answered for SSH connections (the sidecar only stages non-SSH protocols), so every SSH connection spent a full window waiting before dialing; the sidecar now answers `"ssh"` for registered SSH connections and the frontend window shrinks from 10×500ms (restore) / 2×250ms (regular) to 4×250ms / 2×250ms — the measured query burst for one connection drops from 10 calls over 4.5 seconds to 4 calls over 0.75 seconds.
- **宽字符行上关键词高亮与链接定位修复（#185）**。关键词高亮、动作链接常驻虚线与可点击链接在含中文等宽字符的行上整体左移：命中的 start/end 是 `translateToString` 文本的 UTF-16 下标，而装饰的 x/width 与链接 range 需要的是单元格列号，每个宽字符差 1 列——中文行上时间戳、IP 尾部露白、命中点涂错，链接悬停与点击也点不中。现按「字符 → 列号」表换算后再挂装饰：优先取 xterm `translateToString` 的 `outColumns` 输出，公开包装类不转发该参数或旧版 xterm 不支持时逐格 `getCell()` 回退（宽字符按格宽前进、行尾补哨兵），两代实现都有配套用例覆盖。
  **Keyword highlights and links now line up on wide-character rows (#185).** Highlight overlays, persistent action-link underlines and clickable links all shifted left on rows containing CJK and other wide characters: match start/end are UTF-16 indices from `translateToString`, while decoration x/width and link ranges need terminal cell columns — every wide character costs one column, so timestamps and IPs leaked their tails on Chinese rows and link clicks missed. Decorations are now placed through a character-to-column table: xterm's `translateToString` `outColumns` output when available, with a cell-by-cell `getCell()` fallback (wide characters advance by cell width, end-of-row sentinel) when the public wrapper doesn't forward the parameter or older xterm lacks it; both paths carry dedicated test coverage.
- **终端 2026 同步窗跨帧边界不再长时间卡死**。PTY 读边界把一帧的同步输出窗（CSI ?2026 h…l）切成两个数据块时，结束序列会被渲染 hold 队列挡住，而 hold 期间的写入不调度任何 flush，唯一出口是 1MiB 字节帽——codex cli 这类每帧重绘都包同步窗的流式应用要积 20 分钟以上才渲染一次，表现为终端长时间静止。现 hold 到 100ms（对标 WezTerm 的同步超时）即整批放行，结束序列先到则取消定时器；健康应用的同帧 h/l 配对行为不变。
  **Terminal no longer stalls for a long time when a 2026 synchronized-update window spans a read boundary.** When a PTY read boundary splits one frame's synchronized-update window (CSI ?2026 h…l) into two chunks, the end sequence gets stuck behind the render hold queue — and writes during a hold schedule no flush, so the only escape was the 1MiB byte cap; streaming apps like codex cli that wrap every frame in a sync window could sit frozen for 20+ minutes. The hold now releases the whole batch after 100ms (matching WezTerm's sync timeout) and an earlier end sequence cancels the timer; well-behaved same-frame h/l pairs behave exactly as before.
- **手动重连前先恢复 SSH 连接注册**。工作台还活着但 sidecar 里的连接注册已失效时（例如连接在侧边栏被编辑——宿主摘掉 connected 标记且不回推插件），重连只会拿旧凭据反复失败。现在「Connection is not active」类错误的第一次重试前，前端先请宿主按 vault 最新配置重放连接生命周期（凭据不下发 webview），再进入有界轮询；宿主重开失败立即呈现错误，不再对空连接表反复发起会话打开。
  **Manual reconnects restore the SSH connection registration first.** When a live workbench outlives its sidecar connection registration (for example after the connection was edited in the sidebar — the host drops the connected flag without notifying the plugin), reconnects kept failing on stale credentials. The first retry for a "Connection is not active" error now asks the host to replay the connection lifecycle from the vault-backed latest configuration (credentials never reach the webview) before the bounded polling resumes; a failed reopen surfaces the error immediately instead of hammering session opens against an empty connection table.
- **内部：本地任务进程组终止改用 `killpg` 直接系统调用**。本地 Shell/定时任务的进程组清理此前经外部 `kill` 二进制组杀，其负 pid argv 处理在部分环境下有误伤宿主进程的风险；改为 `libc::killpg` 直接系统调用后无外部二进制解析风险，进程组拆除延迟也更低（免一次 fork/exec）。
  **Internal: local task process-group teardown uses the killpg syscall directly.** Local shell/task process-group teardown previously shelled out to the external `kill` binary, whose negative-pid argv handling risks collateral damage to host processes in some environments; the direct `libc::killpg` syscall removes that risk and tears the group down faster (no fork/exec).
## [0.7.6] — 2026-10-12

- **0.7.6 正式版**。内容与 [0.7.6-beta.1](#076-beta1--2026-10-12) / [0.7.6-beta.2](#076-beta2--2026-10-12) / [0.7.6-beta.3](#076-beta3--2026-10-12) 三个预发布完全一致：关键词高亮显示方式全局可选（#180）、工作台布局/视图偏好跨重启持久化与水合登记修复（#178/#181）、SFTP 自动连接偏好（#179）、本地 Shell 全套增强（右键粘贴修复、复制反馈与选区快照、设置保存、env/cwd 启动参数、「选择 Shell 打开」）、Docker 容器 shell 退出不再接力（#182）与表格横向滚动回流，经 beta 验证后仅版本号转正；manifest 版本从 `0.7.6-beta.3` 提升为 `0.7.6`。调度任务功能声明继续摘除——待 DBX 上游发布宿主侧 task-provider 能力后恢复。
  **0.7.6 stable.** Content is identical to the [0.7.6-beta.1](#076-beta1--2026-10-12) / [0.7.6-beta.2](#076-beta2--2026-10-12) / [0.7.6-beta.3](#076-beta3--2026-10-12) pre-releases: the keyword-highlight display mode (#180), cross-restart workbench layout persistence with hydration-registration fixes (#178/#181), the SFTP auto-connect preference (#179), the full local-shell enhancement set (right-click paste fix, copy feedback and selection snapshot, settings save, env/cwd launch parameters, "Open with Shell"), Docker container-shell no-chain-after-exit (#182) and the carried-over table-scrolling fix — promoted after beta validation with only the version number finalized; the manifest version moves `0.7.6-beta.3` → `0.7.6`. The scheduler feature declaration stays withheld until the DBX host ships the task-provider capability.

## [0.7.6-beta.3] — 2026-10-12

> 预发布基线说明（延续 beta.1）：调度任务（task-provider）功能声明在本预发布线继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from beta.1):** the scheduler task-provider contribution stays withheld on this line — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **本地 Shell：启动目录、环境变量与「选择 Shell 打开」**。`local/terminal/start` 新增 `env` 参数（逐条净化：空名/`=`/控制字符/超限丢弃，TERM 族托管键忽略）；`io.dbx.ssh.local` 连接表单新增 cwd/env 字段，设置菜单新增「启动目录 + 环境变量编辑器」（偏好 localShellCwd/localShellEnv，与连接级合并：cwd 重开继承 > 连接 > 偏好，env 同名连接覆盖）；会话菜单新增「选择 Shell 打开」子页（dock「+」同款发现列表，一次性 override 不改默认偏好）；本地模式面板收口三层防线（进入前收起 SFTP 分栏/批量栏、恢复层不水合分栏、overlay 补 localUiMode 门），修掉 SSH 分栏切本地与布局镜像带病启动的幽灵分栏。
  **Local shell: working directory, environment variables, and "Open with Shell".** `local/terminal/start` gains a sanitized `env` parameter; the `io.dbx.ssh.local` connection form gains cwd/env fields and settings gains a "startup directory + environment variable editor" (connection-level wins over preferences); the session menu gains an "Open with Shell" subpage (one-shot override, default preference untouched); and the local-mode panel collapse now has three layers of defense, fixing ghost split panes when switching from SSH splits or restoring from a poisoned layout mirror.
- **Docker：容器 shell 退出后不再接力（#182）**。此前 `bash || zsh || fish || ash || sh` 链在命令非零退出后继续启动后续 shell——用户 `exit` 后仍留在容器内并看到缺 shell 报错；现改为 `command -v` 探测后 `exec` 启动，所选 shell 以任意状态退出即结束会话并保留退出码。
  **Docker: container shell no longer chains after exit (#182).** The previous `bash || zsh || …` fallback kept starting the next shell after a non-zero exit, trapping users inside the container with a missing-shell error; it now probes with `command -v` and `exec`s the shell, so any exit ends the session and preserves the exit code.
- **Docker：表格横向滚动三修（0.7.5 修复回流）**。表格横向滚动条修复此前随 0.7.5 发布（滚动条可见 + 名称/操作列粘性），但未回流主线、0.7.6 系列一度退化；本次自 0.7.5 发布线收编。
  **Docker: table horizontal scrolling (0.7.5 fix carried over).** The scrollbar-visibility and sticky name/action column fixes shipped in 0.7.5 but never made it back into the mainline, regressing in the 0.7.6 series; this release brings the fix over from the 0.7.5 release line.

## [0.7.6-beta.2] — 2026-10-12

> 预发布基线说明（延续 beta.1）：调度任务（task-provider）功能声明在本预发布线继续摘除——DBX 上游尚未发布宿主侧 task-provider 能力。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note (carried over from beta.1):** the scheduler task-provider contribution stays withheld on this line — the DBX host has not shipped the task-provider capability yet. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **关键词高亮显示方式全局可选「背景色块 / 字体颜色」（#180）**。规则色此前只有「装饰层半透明铺底」一种画法；设置页新增全局显示方式开关——「字体颜色」把规则色交给 xterm decoration 的 `foregroundColor` 直接染命中字形（只染字、不铺底），DOM 与 WebGL 两条渲染路径都生效，GPU 渲染不受影响；默认「背景色块」与既有行为完全一致，脏值一律回落，升级不改动画法。
  **Keyword highlights gain a global display mode: background block or text color (#180).** Rule colors previously had a single rendering style (a translucent overlay fill). Settings now offer a global display-mode switch — "text color" hands the rule color to the xterm decoration `foregroundColor`, tinting only the matched glyphs with no fill; it is consumed by both the DOM and WebGL render paths, so GPU rendering is unaffected. The default "background block" keeps the existing behavior verbatim, and any stale stored value falls back to it.
- **工作台布局与视图偏好跨重启持久化（#178）**。终端/SFTP 左右布局、分栏比例、SFTP 面板开合、自定义列显隐与列宽、显示隐藏文件、排序规则此前随会话孤儿化，重启一律回落硬编码默认；现在经双持久层（pluginStore 全局偏好 + 布局镜像）跨重启保留，宿主 workbenchState 桥的每工作台恢复仍优先。空提示符快捷键引导的开关与「用过即散」旗标补齐水合登记，重启后设置不再丢失。
  **Workbench layout and view preferences now survive restarts (#178).** Pane order, split ratio, SFTP pane visibility, custom column visibility/widths, hidden-file display and sort rules were previously keyed to the session and reset to hardcoded defaults on every restart; they now persist through a dual layer (a pluginStore global preference plus a layout mirror), while per-workbench state restored via the host workbenchState bridge still wins. The prompt-hints onboarding toggle and its one-shot dismissal flag are now registered for hydration, so those settings also survive restarts.
- **SFTP 自动连接偏好（#179）**。新增全局「SFTP 自动连接」开关（默认开，行为不变）：关闭后连接成功不再自动拉取远端列表——未开 SFTP 子系统的服务器不再每次连接弹错误横幅；首次手动打开 SFTP 面板时惰性补载一次。入口在「自定义列」popover。
  **SFTP auto-connect preference (#179).** A new global "SFTP auto-connect" switch (default on, unchanged behavior): when off, a successful connect no longer prefetches the remote listing — servers without an SFTP subsystem stop surfacing an error banner on every connect, and the first manual open of the SFTP pane lazily fetches the listing once. The switch lives in the "Customize columns" popover.
- **本地 Shell 终端右键粘贴修复**。会话门此前只检查 SSH 会话，本地 Shell/Telnet/串口会话下粘贴确认后字节静默丢失（感知为「右键没动静」）；会话门改为按活动传输判定，与终端写入分派对齐，本地粘贴顺带进入命令历史采集。
  **Local shell terminals: right-click paste is fixed.** The paste gate only checked the SSH session, so on local shell/Telnet/serial sessions confirmed paste bytes were silently dropped (the menu appeared to do nothing); the gate now accepts whichever transport is active, matching the terminal-write dispatch, and local pastes join command-history capture as well.
- **右键复制反馈、选区快照与本地 Shell 设置保存（#178 跟进）**。空选区点「复制」此前无任何反馈且菜单不关，现在无论成败都关菜单并给明确提示；选区在菜单打开瞬间快照，弹层接管焦点后不再复制到空串。本地 Shell 连接的设置保存按钮此前恒灰（会话元数据按 SSH 假设缺失即卡死），现在本地会话放行全局偏好保存、仅跳过 SSH 会话级段。
  **Right-click copy feedback, selection snapshot, and Local shell settings save (#178 follow-up).** Clicking "Copy" with an empty selection previously gave no feedback and left the menu open; the menu now always closes and empty selections say so explicitly. The selection is snapshotted the moment the menu opens, so focus-taking popovers no longer copy an empty string. The Local shell settings save button was permanently disabled because session metadata was assumed to be SSH-shaped; local sessions now save global preferences while skipping only the SSH session-scoped sections.
- **内部：CI 基线修复**。Rust 侧清零 clippy `-D warnings`（`let _ =` 单元值、参数数量上限、悬空 doc comment）并补齐 `cargo fmt`；同步 main 的关键词显示方式与持久化两个特性（合并冲突按双持久层语义收口）。前端 RDP 模块断链在本预发布线此前已修复。
  **Internal: CI baseline repairs.** The Rust side is now clean under clippy `-D warnings` (unit `let _ =` bindings, argument-count ceiling, dangling doc comments) and `cargo fmt` is applied; the keyword display-mode and persistence features are merged in from main with the conflict resolved under the dual persistence-layer semantics. The frontend RDP module breakage was already fixed earlier on this pre-release line.

## [0.7.6-beta.1] — 2026-10-12

> 预发布基线说明：调度任务（task-provider）功能声明在本预发布线摘除——DBX 上游尚未发布宿主侧 task-provider 能力，声明会在宿主加载时报未知贡献类型。sidecar `task/*` 实现与本地 Shell 连接类型保留，待上游发布后恢复。
> **Pre-release note:** the scheduler task-provider contribution is withheld on this line — the DBX host has not shipped the task-provider capability yet and rejects the unknown contribution type at load time. The sidecar `task/*` implementation and the Local shell connection type are kept; the declaration returns once upstream ships.

- **本地 Shell 连接可直接打开**。`io.dbx.ssh.local` 连接此前只能作为（未发布的）调度任务目标，宿主侧要求每个连接提供者声明工作台或文件系统提供者，双击已保存的本地 Shell 连接会报 "does not declare a workbench or filesystem provider"。现在该连接声明 Terminal 工作台，`connection/protocol` 返回 `local` 协议，工作台按本地 Shell 路由（`local/terminal/start`）而不再误拨 SSH。
  **Local shell connections are now openable.** The `io.dbx.ssh.local` provider previously existed only as a (yet unreleased) scheduler target; the host requires every connection provider to declare a workbench or filesystem provider, so opening a saved Local shell connection failed with "does not declare a workbench or filesystem provider". The connection now declares the Terminal workbench, `connection/protocol` reports the `local` protocol, and the workbench routes it to a local shell session instead of dialing SSH.
- **RDP：CredSSP 通道绑定修复（域机 EPA 强制可用）**。域控开启扩展保护（EPA）强制时 NTLM 认证结构性被拒——CredSSP 客户端从不发送 `tls-server-end-point` 通道绑定哈希。补丁横跨 vendored 认证链五个 crate（channel bindings 装配、NTLM MIC 纳入、`connect_finalize` 透传），公司域机由 CredSSP 结构性失败收敛为服务器凭据级判定。
  **RDP: CredSSP channel-binding fix (EPA-enforced domain machines).** With Extended Protection enforced, NTLM authentication was structurally refused because the CredSSP client never sent the `tls-server-end-point` channel-binding hash. The patch spans five vendored authentication-chain crates (binding assembly, NTLM MIC inclusion, `connect_finalize` pass-through); domain-joined hosts now fall back from a structural CredSSP failure to a normal credential-level verdict.
- **RDP 工作台整理**。RDP 连接隐藏 SSH 专属工具组（sudo/SFTP/隧道等），新增缩放与大文本粘贴工具；RDP 后端由单文件拆为模块组（会话/帧/输入/证书/剪贴板/安全/限额/wire）。
  **RDP workbench clean-up.** RDP connections hide the SSH-specific toolbar groups (sudo/SFTP/tunnels) and gain zoom plus large-text paste tools; the RDP backend is split from a single file into a module group (session/frame/input/cert/clipboard/security/limits/wire).
- **导入对话框在 Windows 置顶（#160）**。「导入连接」第二段系统文件对话框没有置顶 owner，常弹在 DBX 主窗之后——用户以为导入未执行而重试，撞上防重入守卫报 "already open"。对话框现挂不可见置顶 owner 表单，守卫文案给出「可能被遮挡」指引。
  **Import dialog stays on top on Windows (#160).** The second native file dialog had no topmost owner and often opened behind the DBX window — users assumed the import did nothing and retried into the single-flight guard. The dialog now parents to an invisible topmost owner form, and the guard message explains the window may be behind.
- **MCP 工具清单瘦身（#172）**。`tools/list` 串行化 143.7k 字符，桥模式下被 MCP 客户端判超限落盘。自明参数描述整条去除、行为语义参数保留精简版，降到 100.2k（约 -30%），并以预算测试钉住上限。
  **MCP tool listing slimmed (#172).** `tools/list` serialized to 143.7k chars and exceeded MCP client result caps in bridge mode. Self-evident parameters drop their descriptions entirely while behavioral ones keep condensed wording, bringing it to 100.2k (about -30%), with a budget test pinning the ceiling.
- **SFTP「打开方式」兼容自定义下载目录（#175）**。remote-edit 路径守卫回落在默认基址解析，自定义下载目录的用户全部校验必然失败（"not inside the remote-edit directory"）。守卫与前端取值同源（downloadDir 偏好优先），跨目录文件依旧被拒。
  **SFTP "Open with" honors a custom download directory (#175).** The remote-edit path gate resolved against the default base, so users with a custom download directory always failed validation ("not inside the remote-edit directory"). The gate now resolves from the same source as the frontend (the downloadDir preference wins), while cross-directory files stay rejected.
- **Docker 面板兼容旧版 daemon 并按工作台绑定（#168）**。`docker ps --format` 的 `.State` 占位符需 Docker 1.13+，旧 CLI 整条模板报错且被静默——面板空列表无提示；现自动回退 legacy 占位符集并由 Status 文本推导状态。多台服务器同时有会话时面板此前绑「全局最新会话」而错乱，现严格绑定所在工作台的连接。
  **Docker panel supports legacy daemons and binds to its workbench (#168).** The `.State` placeholder needs Docker 1.13+; older CLIs fail the whole template silently, leaving an unexplained empty list — the collectors now fall back to a legacy placeholder set and derive state from the Status text. The panel previously bound to the globally newest session and mixed machines up; it now binds strictly to its own workbench's connection.
- **SFTP 多文件上传批次进度卡（#165）**。一次选择/拖拽/粘贴的多文件在传输面板聚合成「文件 N/M · 总字节」进度卡，整批常驻填补逐文件卡交接空窗（"传完就没、突然又来几个进度条"）；文件夹上传同款语义。七语覆盖。
  **Batch progress card for multi-file SFTP uploads (#165).** Files picked/dropped/pasted together aggregate into a "files N/M · bytes" progress card that stays up for the whole batch, filling the gap between per-file cards ("finished, nothing there, then more bars suddenly"); folder uploads keep their existing aggregate card. All seven languages covered.
- **工作台布局持久化修复（#178、#176-3）**。三层根因：空提示符引导的消散旗标两键漏注册持久化白名单（每次重开都弹引导）；宿主未实现 workbenchState 桥时 paneOrder/自定义表头/SFTP 面板开合/列宽整组静默不持久（新增 pluginStore 单键镜像兜底）；恢复路径不等异步水合完成。隐藏文件显隐与列表排序规则一并接入持久化。
  **Workbench layout persistence fixed (#178, #176-3).** Three stacked causes: the prompt-hints dismissal keys were missing from the hydration whitelist (the guide bar reappeared on every relaunch); without the host's optional workbenchState bridge the pane order, custom column headers, SFTP pane toggle and column widths silently never persisted (now mirrored into pluginStore as a fallback); and the restore path raced the asynchronous hydration. Show-hidden-files and the list sort rule are persisted too.

## [0.7.5-beta.1] — 2026-10-07

- **SFTP 大目录滚动修复**。文件较多时鼠标滚动失效、列表展示不全——虚拟滚动的窗口 spacer 与行列表被 v-else 写成了互斥：滚动过前几行（spacer 开始撑高）后整个行列表就不再渲染（2000 文件夹具实测：滚到底行数为 0）。现在 spacer 与行并存，滚到底最后一个文件可见；新增 2000 行大目录 mock 夹具与 App.vue 源码结构守卫用例防回归。
  **SFTP large-directory scrolling fix.** With many files, wheel scrolling died and the list was cut off — the virtual-scroll window spacer and the row list were wrongly paired with v-else, so past the first few rows (once the spacer started growing) the entire row list stopped rendering (measured with a 2000-file fixture: zero rows rendered at the bottom). Spacer and rows now coexist and the last file is reachable, with a 2000-row mock fixture and an App.vue source-structure guard test to prevent regressions.
- **弹窗窄视口溢出修复**。窗口较窄时弹窗右半偏出屏幕（最宽的审计日志 680px 弹窗最先暴露）——DialogContent 定位器是 grid 但未定义轨道，弹窗 `width: min(680px, 100%)` 的百分比按内容尺寸解析、收缩失效。定位器显式 `minmax(0, 1fr)` 列/行轨道后，所有弹窗在窄视口正确收缩并保持居中，宽视口行为不变；新增定位器结构守卫用例。
  **Narrow-viewport dialog overflow fix.** On narrower windows dialogs (the widest, Audit log at 680px, first to show it) had their right half pushed off-screen — the DialogContent positioner was a grid with no explicit tracks, so the dialog's `width: min(680px, 100%)` resolved its percentage against content size and never clamped. The positioner now pins `minmax(0, 1fr)` columns/rows; every dialog shrinks and stays centered on narrow viewports, unchanged at wide ones, with a positioner structure guard test.
- **文本预览选区色加深**。打开文本文件后鼠标选取的高亮与背景几乎无法区分（亮色主题下对比度仅 ~1.2:1）——明暗两套选区色加深并提高不透明度（light `#93b4e088`→`#7cabecad`、dark `#5f6f8a88`→`#6481b8ad`），选中范围清晰可辨。
  **Text-preview selection color deepened.** The mouse-selection highlight in an opened text file was nearly indistinguishable from the background (~1.2:1 contrast on the light theme) — both light and dark selection colors are deepened with higher opacity (light `#93b4e088`→`#7cabecad`, dark `#5f6f8a88`→`#6481b8ad`) so selections read clearly.

## [0.7.5] — 2026-10-07

- **0.7.5 正式版**。内容与 [0.7.5-beta.2](#075-beta2--2026-10-07) / [0.7.5-beta.3](#075-beta3--2026-10-07) 两个预发布完全一致（#151 SFTP 大目录滚动、#153 弹窗窄视口溢出、#155 文本预览选区色、Docker 面板表格布局共四处修复，经 beta 验证后仅版本号转正）；manifest 版本从 `0.7.5-beta.3` 提升为 `0.7.5`，RDP client_build 编码恢复按 patch 段计算（705）。不含 scheduler 任务功能——该功能需宿主侧配套，待 DBX 支持后在 main 上另行发版。
  **0.7.5 stable.** Content is identical to the [0.7.5-beta.2](#075-beta2--2026-10-07) / [0.7.5-beta.3](#075-beta3--2026-10-07) pre-releases (four fixes: #151 SFTP large-directory scrolling, #153 narrow-viewport dialog overflow, #155 text-preview selection color, and the Docker panel table layout — promoted after beta validation with only the version number finalized); the manifest version moves `0.7.5-beta.3` → `0.7.5` and the RDP client_build encoding returns to the plain patch segment (705). No scheduler feature — that needs matching host support and ships later from main.

## [0.7.5-beta.3] — 2026-10-07

- **Docker 面板表格布局修复**。列内容过宽时横向滚动条被全局隐藏规则吞掉、操作列的下拉按钮被内容推出视口。现横向溢出时滚动条显式可见可拖(.file-rows 同款例外);容器名首列与操作按钮末列改为粘性列——滚动中名称固定靠左、操作按钮固定靠右永不被遮挡,粘性列带浮层同底色与 1px 分隔缘;表格切 separate 边框模型(Firefox 粘性单元格边框正确随滚动绘制,视觉等价)。
  **Docker panel table layout fix.** With wide content the horizontal scrollbar was swallowed by the global scrollbar-hiding rule and the row actions' dropdown trigger was pushed out of view. The scrollbar is now explicitly visible on horizontal overflow (same exception pattern as .file-rows); the container-name first column and the actions last column are sticky — the name stays pinned left and the dropdown trigger stays pinned right while scrolled content slides beneath, each on an opaque popover background with a 1px separator edge. The table switched to the separate border model so Firefox paints sticky-cell borders correctly (visually identical).

## [0.7.5-beta.2] — 2026-10-07

基于 0.7.4 的三个 bug 修复预发布(不含 0.7.5 调度任务功能;该功能需宿主侧配套,待 DBX 支持后另行发版)。
Three bug fixes on top of 0.7.4 as a pre-release (no scheduler feature — that needs matching host support and ships later).

- **SFTP 大目录滚动修复**(#151)。文件较多时鼠标滚动失效、列表展示不全——虚拟滚动的窗口 spacer 与行列表被 v-else 写成了互斥:滚动过前几行(spacer 开始撑高)后整个行列表就不再渲染(2000 文件夹具实测:滚到底行数为 0)。现在 spacer 与行并存,滚到底最后一个文件可见;新增 2000 行大目录 mock 夹具与 App.vue 源码结构守卫用例防回归。
  **SFTP large-directory scrolling fix (#151).** With many files, wheel scrolling died and the list was cut off — the virtual-scroll window spacer and the row list were wrongly paired with v-else, so past the first few rows (once the spacer started growing) the entire row list stopped rendering (measured with a 2000-file fixture: zero rows rendered at the bottom). Spacer and rows now coexist and the last file is reachable, with a 2000-row mock fixture and an App.vue source-structure guard test to prevent regressions.
- **弹窗窄视口溢出修复**(#153)。窗口较窄时弹窗右半偏出屏幕(最宽的审计日志 680px 弹窗最先暴露)——DialogContent 定位器是 grid 但未定义轨道,弹窗 `width: min(680px, 100%)` 的百分比按内容尺寸解析、收缩失效。定位器显式 `minmax(0, 1fr)` 列/行轨道后,所有弹窗在窄视口正确收缩并保持居中,宽视口行为不变;新增定位器结构守卫用例。
  **Narrow-viewport dialog overflow fix (#153).** On narrower windows dialogs (the widest, Audit log at 680px, first to show it) had their right half pushed off-screen — the DialogContent positioner was a grid with no explicit tracks, so the dialog's `width: min(680px, 100%)` resolved its percentage against content size and never clamped. The positioner now pins `minmax(0, 1fr)` columns/rows; every dialog shrinks and stays centered on narrow viewports, unchanged at wide ones, with a positioner structure guard test.
- **文本预览选区色加深**(#155)。打开文本文件后鼠标选取的高亮与背景几乎无法区分(亮色主题下对比度仅 ~1.2:1)——明暗两套选区色加深并提高不透明度(light `#93b4e088`→`#7cabecad`、dark `#5f6f8a88`→`#6481b8ad`),选中范围清晰可辨。
  **Text-preview selection color deepened (#155).** The mouse-selection highlight in an opened text file was nearly indistinguishable from the background (~1.2:1 contrast on the light theme) — both light and dark selection colors are deepened with higher opacity (light `#93b4e088`→`#7cabecad`, dark `#5f6f8a88`→`#6481b8ad`) so selections read clearly.

## [0.7.4] — 2026-10-05

- **0.7.4 正式版**。内容与 [0.7.4-beta.1](#074-beta1--2026-10-05) 完全一致（sz 自动接收 + 终端/导入/批量发送加固 + 键权仲裁器工程项），经 beta 验证后仅版本号转正；manifest 版本从 `0.7.4-beta.1` 提升为 `0.7.4`，RDP client_build 编码恢复按 patch 段计算（704）。
  **0.7.4 stable.** Content is identical to [0.7.4-beta.1](#074-beta1--2026-10-05) (automatic sz receive + terminal/import/batch-send hardening + the key-arbiter engineering work), promoted after beta validation with only the version number finalized; the manifest version moves `0.7.4-beta.1` → `0.7.4` and the RDP client_build encoding returns to the plain patch segment (704).

## [0.7.4-beta.1] — 2026-10-05

- **ZMODEM 下载（sz）自动接收**。远端跑 `sz` 时终端自动接管收流：进度浮条（文件名/百分比/多文件计数/速度）+ 取消按钮，落盘与 trzsz 下载同一三段式——宿主 fileTransfer 逐块流式写入（不在内存攒整文件）、本机 sidecar 落盘（支持下载目录设置/每次询问/撞名冲突处理，完成后可一键「在文件夹中显示」）、web/docker 模式浏览器 saveFile 兜底（512 MiB 上限）。远端提供的文件名经净化处理（剥离路径段防 `../../` 逃逸、Windows 保留名/非法字符），上传期间或 trzsz 传输中的 `sz` 请求自动拒绝（远端干净退出）。检测器从「拦截协议帧」改为「透传+事件窗口」——协议帧必须原样到达前端 sentry 才能开接收会话；原「请改用 SFTP 面板」提示退役。会话录制文件将包含 sz 协议帧（与 trzsz 现状一致）。
  **ZMODEM downloads (sz) are now received automatically.** When the remote runs `sz`, the terminal takes over the stream: a progress overlay (file name, percent, multi-file counter, speed) with a cancel button, and saving through the same three-tier pipeline as trzsz downloads — streaming per-chunk writes via the host fileTransfer bridge (no whole-file buffering), sidecar saves to the local downloads directory (download-dir settings, ask-every-time, conflict resolution, reveal-in-folder), or the browser saveFile fallback in web/docker mode (512 MiB cap). Remote-provided file names are sanitized (path segments stripped against `../../` escapes, Windows reserved names and illegal glyphs), and an `sz` arriving during a pending rz upload or an active trzsz transfer is cleanly denied. The backend detector switched from suppressing protocol bytes to pass-through plus a dedup-only event window — the frames must reach the frontend sentry for a receive session to open, and the old "use the SFTP panel" notice is retired. Session recordings will contain sz protocol frames (consistent with the existing trzsz behavior).
- **导入对话框加固与跨平台一致**。「从文件导入私钥 / 导入连接」的系统对话框三处脚本插值补齐转义（AppleScript 路径中的 `"`/`\`、PowerShell 文案中的 `'`——含特殊字符的路径此前会让对话框静默失败乃至注入脚本）；同一对话框被占用时第二次「导入」立即提示「已在打开中」，不再并发弹出叠着的两个窗口；Linux 上 kdialog 的文件过滤从只认第一个扩展名改为与 zenity 同一扩展名集合（同一来源在不同桌面过滤范围一致）。
  **Import dialog hardening & cross-platform consistency.** Three script interpolation sites in the native pickers ("Import private key" / "Import connections") now escape properly (AppleScript `"`/`\` in paths, PowerShell `'` in labels — paths with such characters previously failed silently or could inject script); a second "Import" click while a dialog is already open now says so instead of stacking a second window; and on Linux the kdialog file filter accepts the full extension set instead of only the first one (same filtering as zenity).
- **终端提示符与转义序列修复**。远端 dotfile 自带 OSC 7 目录上报与插件钩子同时在场时，每个提示符前恒多一个空行——已去重；被截断的 CSI 转义序列后紧跟的提示帧此前漏判，导致该次输出后提示符仍然粘连输出尾部——现在正确重同步并补换行。
  **Terminal prompt & escape-sequence fixes.** When a remote dotfile emits its own OSC 7 alongside the plugin's hook, a spurious blank line appeared before every prompt — now deduplicated; a prompt frame arriving right after a truncated CSI escape sequence was missed (prompt still glued to output tails) — scanning now resynchronizes and inserts the newline correctly.
- **批量发送准确性**。本地终端会话在发送前复核存活——目标刷新到点击发送之间已关闭的会话现在如实报失败（此前恒报成功、命令悄悄丢失）；目标列表刷新加过期响应守卫（快速开合下拉不再被旧响应覆盖）；「保存为快速命令」的默认名按 code point 截断（emoji 不再被劈成乱码）。
  **Batch-send accuracy.** Local terminal sessions are liveness-checked right before sending — sessions closed between target refresh and the send click now honestly report failure (they used to always report success while silently dropping the command); the target list refresh discards stale responses (fast popover toggling no longer clobbers fresh data); quick-command default names truncate by code point (emoji no longer split into mojibake).
- **sudo 读文件与自动应答**。`sudo/readFile` 的显式 `length` 超上限时钳到 8 MiB 并如实上报 `truncated`（此前传超大值会把整个文件经 base64 约 4 倍放大灌进内存）；登录期密码自动应答词表补「口令:」（与「密码:」同构，中文提示的堡垒机/服务器不再停在提问）。
  **sudo reads & auto-answer.** An oversized explicit `length` on `sudo/readFile` is clamped to 8 MiB with `truncated` reported honestly (a huge value previously buffered the whole file at ~4× size through base64); the login password auto-answer vocabulary gains 「口令:」 (parallel to 「密码:」), so Chinese-prompting hosts no longer stall on the question.
- **会话关闭报错修正**。关闭会话时传输清理失败不再让「关闭会话」误报失败（会话此刻已关，报错只会误导重试并吃到 "not found"）——降级为 stderr 日志。
  **Session-close error fix.** A transfer-cleanup failure while closing a session no longer fails the close itself (the session is already gone; the error only misled retries into "not found") — it is logged to stderr instead.
- **工程门禁**。提示词判定引入前后端共同加载的统一语料（词表单侧改动不再静默漂移，语料即契约）；终端浮层（历史面板/引导条/ghost 建议/补全菜单/建议浮层/quick-select）的手工互斥矩阵收口为单一键权仲裁器优先级表，#150/#152 全部回归场景以快照用例钉死——下一个浮层的接入成本从改 N 处门降为加一行 claim。
  **Engineering gates.** Prompt-classification now runs on a shared corpus loaded by both the Rust and frontend test suites (single-side vocabulary changes can no longer drift silently — the corpus is the contract); the terminal overlays' hand-maintained mutual-exclusion matrix (history panel / prompt hints / ghost / completion menu / suggestions / quick-select) is collapsed into a single key-arbiter priority table with every #150/#152 regression scenario pinned as snapshot cases — integrating the next overlay costs one claim line instead of N gate edits.

## [0.7.3] — 2026-10-02

- **恢复连接右键动态端口映射二级菜单**。宿主 0.6.30 已发布 `dynamic` context-menu 贡献点，manifest 恢复 `manage-tunnels` 的 `dynamic: true`（0.7.2 曾因宿主未发布该字段而临时降级为声明式 `open-workbench`）。右键二级菜单重新提供管理入口、按预设逐条启动/停止、批量启动与停止所有映射；sidecar 侧 `contextMenu/resolve/manage-tunnels` 实现一直保留，本次无需后端改动。`engines.dbx` 相应收紧为 `>=0.6.30`——更早的宿主 manifest 解析器不认识 `dynamic` 字段会拒绝安装，版本约束给出干净的不兼容提示。
  **Restored the dynamic connection context-menu submenu for port forwards.** DBX 0.6.30 has shipped the `dynamic` context-menu contribution, so the manifest restores `dynamic: true` on `manage-tunnels` (0.7.2 had temporarily downgraded the entry to a declarative `open-workbench` action). The submenu again offers the manage entry, per-profile start/stop, start-all and stop-all; the sidecar's `contextMenu/resolve/manage-tunnels` implementation was kept all along, so no backend change is needed. `engines.dbx` is tightened to `>=0.6.30` — older hosts reject the manifest outright on the unknown `dynamic` field, and the version constraint turns that into a clean incompatibility message.

## [0.7.2] — 2026-10-01

- **修复 0.7.1 安装失败**。manifest 的连接右键「端口映射」项携带了宿主尚未发布的 `dynamic` 字段，宿主 manifest 解析器（`deny_unknown_fields`）会拒绝整个 manifest 并报 "unknown field `dynamic`"，现行全部 DBX 版本（含 0.6.29）都无法安装 0.7.1。现改为宿主已支持的声明式 `open-workbench` action：右键「端口映射」直接打开该连接的端口映射管理界面；依赖宿主动态菜单能力的逐条/批量二级菜单暂缓启用（sidecar 侧 `contextMenu/resolve/manage-tunnels` 实现保留，宿主能力在 0.6.29 之后的版本发布后，加回 `dynamic: true` 即恢复）。
  **Fixed: 0.7.1 failed to install.** The connection context-menu "Port forwards" entry carried a `dynamic` field the host has not shipped yet; the host manifest parser (`deny_unknown_fields`) rejects the whole manifest with "unknown field `dynamic`", so no current DBX version (including 0.6.29) could install 0.7.1. The entry now uses the host-supported declarative `open-workbench` action: right-clicking a connection opens that connection's port-forward manager directly. The per-profile start/stop submenu that depends on the unreleased host dynamic-menu capability is disabled for now (the sidecar's `contextMenu/resolve/manage-tunnels` implementation is kept; re-adding `dynamic: true` once the host capability ships, in a version after 0.6.29, restores it).

## [0.7.1] — 2026-10-01

- **修复内部远端采集在真实会话上全部秒失败**。命令取消重构引入的 watch 等待在「发送端已丢弃」分支错误地立即完成——`biased` select 的取消臂因此恒被抢占，`never_cancels()` 直通道上的每个 exec（metrics/processes/docker 面板/completion 执行器）未拨远端就返回 "Remote command was cancelled"（beta.16 起潜伏，冒烟此前未覆盖该车道）。修复为永久挂起（发送端丢弃 = 无人能再取消 = 走正常完成），并把把错误行为钉成契约的单测改判为断言挂起。
  **Fixed: every internal remote collection failed instantly on live sessions.** The cancellation-rework watch waiter completed immediately on a dropped sender, so the biased select's cancel arm always won — every exec on the `never_cancels()` direct path (metrics, processes, docker panel, completion executor) returned "Remote command was cancelled" without ever dialing the remote (latent since beta.16; the smoke suite had not covered that lane). It now parks forever (dropped sender = nobody can cancel = normal completion), and the unit test that had pinned the buggy behavior now asserts the pending semantics.

- **传输与远端进程安全加固**。远端命令取消改为优雅关闭通道（此前丢弃 russh Channel——远端进程残留、sudo timestamp 锁死）；会话自发断开（网络丢失）现在完整清理上传表项、`.part`/spool 与 metrics；SFTP 客户端缓存新增失效路径（死通道不再让该会话 SFTP 永久报错），树下载遇通道死亡立即中止整批，不再烧完队列逐文件登记失败。
  **Transfer & remote-process hardening.** Cancelling a remote command now closes the channel gracefully (previously it dropped the russh Channel, leaving remote processes behind and the sudo timestamp locked); a spontaneously dropped session (network loss) now cleans upload entries, `.part`/spool files and metrics; the SFTP client cache gained an invalidation path (a dead channel no longer errors that session's SFTP forever), and tree downloads abort the whole batch on channel death instead of failing every remaining file one by one.
- **数据完整性 fail-closed**。`rename-unique` 与 `copy` 占用预检遇到瞬时 lstat 错误不再当作「目标不存在/未占用」——链路抖动下曾可能静默覆盖既有文件；sudo 写暂存名与归档暂存名掺 uuid，并发同路径不再交错产出损坏文件。
  **Data-integrity fail-closed.** Transient lstat errors in `rename-unique` and copy occupancy pre-checks are no longer treated as "target absent/unoccupied" (a link flap could silently overwrite an existing file); sudo write-staging and archive staging names now carry a uuid so concurrent same-path writes can no longer corrupt each other.
- **吞吐与内存**。下载分片复用已打开的远端句柄（每片省 2 个 RTT，高延迟链路吞吐大幅提升）；MCP sftp_upload 超限文件不再全量读入内存、sftp_download 改为流式落盘；MCP multi_exec 的 parallel 模式此前实为串行（10 条 300 秒命令排 3000 秒），改真并发；connections 写锁不再横跨整个 SFTP 传输（一次大传输不再堵死全部 MCP 工具调用）。
  **Throughput & memory.** Download chunks reuse the open remote handle (2 fewer RTTs per chunk — a large win on high-latency links); MCP sftp_upload no longer buffers oversized files fully in memory and sftp_download streams to disk; MCP multi_exec's parallel mode was actually serial (ten 300s commands queued for 3000s) and is now truly concurrent; the connections write lock no longer spans whole SFTP transfers, so one big transfer can no longer stall every MCP tool call.
- **前端批处理与面板修复**。数千文件批次的传输调度从 O(n³) 降到摊还 O(1)（大批次不再冻结主线程）；修回放加载竞态/倍速跳变、重连定时器叠加双开会话、OTP 面板失败后每秒重试、列宽拖拽监听泄漏、补全 worker 线程泄漏等；指标卡失败提示补七语文案。
  **Front-end batching & panel fixes.** Transfer scheduling for multi-thousand-file batches dropped from O(n³) to amortized O(1) (large batches no longer freeze the UI); fixed replay-load races/speed-jump drift, reconnect timer stacking that double-opened sessions, the OTP panel's per-second retry hammering, column-drag listener leaks and completion worker leaks; metrics failure notices gained localized copy in all seven languages.
- **MCP/stdio 稳健性**。stdio 行读取带上限预检（对端无换行流不再全额缓冲）；sudo 读文件 8 MiB 上限；confirm 弹窗被人工改写后的命令重跑全部安全闸（破坏性/白名单/只读不再被绕过）。
  **MCP/stdio robustness.** stdio line reads bound-check before buffering (a newline-less stream no longer buffers unbounded); sudo file reads capped at 8 MiB; a command hand-edited in the MCP confirm dialog now re-runs all safety gates (destructive/allowlist/read-only checks can no longer be bypassed).
- **工程门禁**。sidecar 方法名升级四路比对（backend 分派 ↔ mock 桩 ↔ 前端 invoke ↔ 协议文档）并纳入 CI；修复脚本对连字符方法名与别名分支的两个盲区，暴露的 10 个缺口逐一处置。完整审查清单与待办见 `docs/REVIEW_FOLLOWUPS.zh-CN.md`。
  **Engineering gates.** Sidecar method names are now checked four ways (backend dispatch ↔ mock stubs ↔ frontend invoke ↔ protocol doc) in CI; two script blind spots (hyphenated method names and alias arms) fixed, with all 10 exposed gaps resolved. The full review list and remaining todos live in `docs/REVIEW_FOLLOWUPS.zh-CN.md`.

## [0.7.1-beta.17] — 2026-09-30

- 新增 SOCKS5 动态端口映射：支持 IPv4、IPv6 和远端解析的域名目标；独立映射无需打开终端，并在停止最后一条映射或断开连接时释放 SSH 传输。
- 连接右键端口映射菜单根据已保存预设和实时状态提供二级菜单，可逐条或批量启动、停止；管理入口改为宿主弹框，SSH 终端右上角按钮复用同一管理界面。
- 管理界面即时同步从右键菜单启动的映射；界面文案统一使用“端口映射”，并补齐七语翻译。此功能依赖具备动态插件菜单与弹框能力的 DBX 0.6.28 构建。

## [0.7.1-beta.16] — 2026-09-30

- **SFTP sudo 上传车道（UploadSudo）：sudo 模式下向 root 目录上传不再撞权限墙**。新增 sudo/upload/start|finish：分块先落登录用户 home 暂存件（`.dbx-sudo-ul-*`），提交走单条 `sudo mv`（目标同名先让位备份、失败回滚，`sudo chmod` 保持权限位）；分块帧/进度/取消/断点续传全复用既有上传管线，压缩通道在 sudo 车道强制关闭。前端 sudo 模式 + 可写判定全链自动换道（上传、重复名预检、文件夹建目录、预览回落下载）；`sftp/rename-unique` 支持sudo 探测让位；协议文档登记「sudo 上传」边界（mv 跨盘非原子、home 暂存空间）。
  **SFTP sudo upload lane (UploadSudo): uploading into root-owned directories under sudo mode no longer hits the permission wall.** New sudo/upload/start|finish methods spool chunks to a home-directory staging file (`.dbx-sudo-ul-*`) and commit with a single `sudo mv` (existing target is moved aside as backup with rollback on failure; `sudo chmod` preserves permission bits). Chunk frames/progress/cancel/resumable upload reuse the existing pipeline; the compression channel is force-disabled on the sudo lane. The frontend switches the whole chain automatically under sudo + writable (upload, duplicate-name precheck, folder mkdir, preview fallback download); `sftp/rename-unique` gained sudo-aware collision probing; the protocol doc registers the lane's boundaries (mv is non-atomic across devices, home staging space).
- **dock 底部栏快捷工具条 + tab↔面板外观即时同步**。dock 面板（surface=panel）新增 30px 精简工具条：左组系统信息带（CPU/内存/网速，复用 ssh/metrics 5s 轮询，失败自动隐藏），右组透明 ghost 按钮——在 tab 打开当前连接、SFTP 文件面板开关（默认不开、不自动建会话）、录屏、SFTP 传输弹层、字号 A±、配色快切（按宿主明暗档过滤）、设置与工具条收起（偏好记忆，右上低透明微钮还原）。tab 工作台与 dock 面板此前是两个独立 webview、改配色互不同步——现在外观三键（配色方案/字体族/字号）跨表面秒级联动（1.5s 轮询直读宿主桥 + 可见性/焦点即拍，双闸门防「自写未落地被旧值打回」）。
  **Dock quick toolbar + instant appearance sync between tab and panel.** The dock panel (surface=panel) gains a slim 30px toolbar: a left system-info strip (CPU/memory/network rates via the existing ssh/metrics 5s poll, auto-hidden on failure) and right-aligned transparent ghost buttons — open this connection in a tab, SFTP file-pane toggle (closed by default, no auto-session), recording, SFTP transfers popover, font A±, color-scheme quick switch (filtered by the host tone), settings, and a collapsible toolbar (persisted preference, restored via a faint corner button). The tab workbench and the dock panel are separate webviews and previously never synced appearance changes — the three appearance keys (scheme/font family/size) now propagate across surfaces within ~1.5s (bridge polling + visibility/focus catch-up, with a double gate that never lets an in-flight local write be reverted by stale reads).

## [0.7.1-beta.15] — 2026-09-30

- **修复工具条连接标识显示 UUID：宿主下发的 connection 配置被形状守卫整包丢弃**。M32（serial/rdp 路由）提交时把 `connection` computed 的守卫从 `typeof value !== "object"` 误写为 `=== "object"`，恰好把宿主注入的连接配置对象拒掉、`connection` 恒为空——工具条标题只能回落显示 connectionId（UUID）。现在守卫复原（对象之外视为缺失），只读徽标、连接色点与工具条着色、写门禁的 readOnly 分量、telnet/vnc/serial/rdp 协议路由一并恢复；工具条主标题改为连接名优先（未命名回退 `user@host:port`，hover 仍见技术标识，与连接卡同口径）。
  **Fixed: the toolbar showed a UUID because a flipped shape guard dropped the host-provided connection object.** The M32 (serial/rdp routing) commit changed the `connection` computed's guard from `typeof value !== "object"` to `=== "object"`, which rejects exactly the connection object the host injects, leaving it permanently empty — the toolbar could only fall back to the connectionId (UUID). The guard is restored (anything but an object counts as missing); the read-only badge, connection color dot/tint, the readOnly component of the write gate and telnet/vnc/serial/rdp protocol routing all come back. The toolbar title now prefers the connection name (falling back to `user@host:port` when unnamed, hover keeps the technical identity — matching the connect card).
- **history 面板选中即回填（shell ↑ 语义）**。打开/↑↓/悬停激活/搜索框重过滤都把当前高亮命令实时写入输入行（整行擦重打、不回车，行内容与面板高亮恒一致）；键位映射收拢为纯函数 `resolveHistoryPanelKey`——顶部最旧一条 ↑ 停住不回绕，Esc 及底部最新一条再 ↓ 恢复打开前的原输入行并收起；Enter/Tab 确认收起不执行（不新增自动执行命令路径）。
  **History panel now live-fills the input line on selection (shell ↑ semantics).** Open/arrow moves/hover activation/re-filtering all write the highlighted command into the input line as you navigate (whole-line rewrite, no Enter — the line always matches the panel highlight); key handling is consolidated into the pure `resolveHistoryPanelKey` — ↑ stops at the oldest entry instead of wrapping, and Esc (or ↓ past the newest) restores the pre-open input line and closes; Enter/Tab confirm and close without executing (no new auto-execute path).

## [0.7.1-beta.14] — 2026-09-30

- **修复压缩上传「看起来没生效」：传输面板的 gz 徽标此前对上传永不显示**。M33 压缩通道的决策与执行本身正常（端到端实测正常），但上传进度事件从未携带 `compression` 字段（协议文档写了要有）、前端也不消费 start 响应里的它——上传卡片永远不出 gzip 徽标，压没压缩无从判断。现在上传事件与下载同语义恒带该字段（预压不划算/推送或远端解压失败回退时降级 `none` 清徽标），任务建卡即从 start 响应点亮；顺带把 gunzip 失败回退普通推送前先断链远端临时件（远端僵尸解压进程不会再与回退推送写同一文件交错——此前可能静默损坏）。
  **Fixed: the gz badge never showed on uploads, making the compressed channel look broken.** The M33 decision/execution pipeline itself was fine (verified end-to-end), but upload progress events never carried the `compression` field (the protocol doc said they should) and the front end ignored it in the start response — upload cards never showed the gzip badge. Upload events now match downloads: always present, downgraded to `none` when the compressed path falls back, lit from the start response. Fallback plain pushes now also unlink the remote temp first so a zombie remote gunzip can no longer interleave writes with the push (previously silent corruption was possible).
- **新增拖拽文件夹上传（web 车道）**。SFTP 面板与终端的 DOM 拖放经 `webkitGetAsEntry` 同步收根 + 有界递归遍历（≤5 万文件/64 层）产出相对路径清单：拖入含目录即走文件夹上传管线（保留目录结构，空文件夹给明确提示），纯文件保持单文件语义（询问/重命名策略不变）；`webkitGetAsEntry` 不可用时回退原 `dataTransfer.files` 行为，Firefox 这类不给拖拽文件清单的浏览器也能正常弹落点询问。宿主桥 filedrop 契约增可选 `relativePath`——桌面宿主遍历目录后附带即可复用同一管线，旧宿主不带则行为不变（桌面宿主对目录的拒收在宿主仓库侧另行修复）。
  **New: drag-and-drop folder upload (web lane).** DOM drops on the SFTP pane and the terminal collect entries synchronously via `webkitGetAsEntry` and walk the tree with bounds (≤50k files, depth 64): drops containing directories go through the folder-upload pipeline (structure preserved, explicit notice for empty folders) while pure file drops keep single-file semantics (ask/rename policies unchanged); without `webkitGetAsEntry` the old `dataTransfer.files` behavior applies, and Firefox-style browsers that expose no dropped files still get the landing-directory prompt. The host bridge filedrop contract gains an optional `relativePath` — desktop hosts that walk directories can reuse the same pipeline, older hosts are unaffected (the desktop host's directory rejection is being fixed in the host repo).
- **传输链路双车道评审加固**。终态事件丢失不再挂死整批上传——收尾等待器自带 15 秒轮询兜底、传输面板对账改走统一结算（此前对账绕过等待器，一条丢失的完成事件就让剩余文件永不派发）；会话关闭现在与取消同等清理全部临时资产（树半成品根目录、压缩 plain/.gz、远端临时件——此前只删 `.part`，16GiB 级残留可累积），sidecar 启动时清扫孤儿临时件，超龄（>7 天）上传断点连同 meta 回收（断点续传仍跨重启，但不跨 7 天窗口）；上传取消立即生效且不再中止同批剩余文件（此前要等满 30 秒超时且整批报错）；sudo 下载并发尊重「最大并发传输」偏好与兼容模式（此前硬编码 3 路）；压缩下载的字节供给段进度不再冻结在解压终值（补 `transferring` 阶段，进度/速度恢复真实）；压缩通道决策三处收敛为单入口、远端工具探测按会话缓存（目录批量上传不再逐文件探测）；文件夹上传接入并发调度（尊重批次并发偏好）并去掉 ask 模式下的重复存在性预检；批次并发不再超过会话深度导致整批报错；压缩树回退普通管线后空目录不再丢失。
  **Transfer pipeline hardening (dual-lane review fixes).** A lost terminal event no longer wedges an upload batch — completion waiters poll the sidecar every 15s as a fallback and the panel reconciliation settles through the shared path (it previously bypassed waiters, so one lost `completed` event stalled the rest of the batch forever). Session close now cleans every transfer asset like cancel does (tree remnants, compressed staging, remote temps — previously only `.part`, letting 16GiB-scale leftovers accumulate), the sidecar sweeps orphan temps on startup, and resumable upload spools older than 7 days are reclaimed with their meta (resume still survives restarts, just not across the 7-day window). Cancelling an upload takes effect immediately and no longer aborts the rest of the batch (previously a 30s timeout plus a batch-wide error). sudo downloads respect the max-active-transfer preference and compat mode (previously hardcoded to 3). Compressed-download supply progress no longer freezes at the decompressed total (a `transferring` phase was added). The compression decision lives in a single entry point and remote tool probes are cached per session (folder batch uploads no longer probe per file). Folder uploads join the concurrent scheduler (batch concurrency preference respected) and skip their duplicate existence pre-check in ask mode; batch concurrency is clamped to the session depth instead of erroring whole batches; compressed trees that fall back to the plain pipeline no longer lose empty directories.
- **修复独立运行/mock 模式整站黑底黑字的根因（主题接管误判）**。外观变量应用判定「宿主是否接管」此前读 computed 值——独立运行下 tailwind theme 层的 `--color-*` 别名与桥引用互相成环、恒为空不可分辨，而插件自己 inline 过的色板又让 boot 后紧随的 appearance 重放误判「宿主接管」并撤掉自己的色板，复活 `--background` ↔ `--color-background` 循环；现在只看宿主 SDK inline 写入的令牌，重放保持幂等。另将 `<html lang>` 同步跟随界面语言（此前 locale 切到 ja 而 lang 滞留 zh-CN，读屏/拼写检查按错语言）。
  **Fixed: the real cause of the all-black standalone/mock theme (host take-over misdetection).** Whether the host owns the palette is now judged only by the `--color-*` tokens the host SDK inlines on the root (computed values were unreadable: the tailwind alias layer and bridge references form a cycle in standalone mode, and the plugin's own inlined palette made the appearance replay right after boot misdetect take-over and strip itself, reviving the variable loop). `<html lang>` now follows the UI locale too (it used to stay zh-CN after switching to ja, so screen readers/spell check picked the wrong language).

## [0.7.1-beta.13] — 2026-09-29

- **新增 SFTP 大文件压缩传输（gzip 混合方案）**。超过阈值的可压缩文件在上传/下载/目录下载时先 gzip 压缩再过网络、对端解回原样——压缩端用程序内置 flate2（纯 Rust），对端由远端 `gzip`/`gunzip`/`tar` 工具承担（任务开始时探测）。策略三态（设置 → 传输）：**智能**（默认——综合文件大小/类型/远端工具与本机 CPU：≤2 核自动跳过、上传实测压缩速率过低自动回退）、**始终尝试**、**关闭**；生效阈值默认 64 MiB 可配（0=不限）。扩展名黑名单（图片/视频/压缩包等再压不缩的类型）、只读连接、latin-1 编码、压缩率不划算（压缩后 ≥95% 原体积）、远端缺工具——全部静默回退普通传输，功能可降不可死；压缩上传的断点续传不受影响，压缩下载不支持断点（自动走普通管线续传）。传输面板显示 gz 徽标与压缩/拉取/解压阶段进度。实现上无新增 RPC 方法：现有传输方法响应增 `compression` 字段、进度事件增压缩阶段，协议见 PROTOCOL「压缩传输（gzip 混合方案）」节。
  **New: SFTP large-file compressed transfer (hybrid gzip).** Files above the threshold are gzip-compressed before crossing the network on upload/download/folder-download and restored verbatim on the other side — the compressing side uses the built-in flate2 (pure Rust) while the peer side is served by remote `gzip`/`gunzip`/`tar` (probed per task). Three strategies in Settings → Transfer: **Smart** (default — weighs file size/type, remote tools and this machine's CPU: skips on ≤2 cores, falls back automatically when measured upload compression is too slow), **Always try**, **Off**; the threshold defaults to 64 MiB (0 = no minimum). Incompressible types, read-only connections, latin-1 lanes and pointless ratios (≥95% of original) all fall back to plain transfer silently; compressed-upload resume is unaffected, compressed downloads don't resume (plain pipeline takes over). The transfer panel shows a gz badge and compression/fetch/decompress phases. No new RPC methods — existing transfer methods gain a `compression` field and progress events gain compression phases; see PROTOCOL「压缩传输（gzip 混合方案）」.
- **终端历史面板：手动键入命令采集 + 面板内搜索**。无 shell integration 的 SSH/本地会话（远端无 OSC 633 E 帧）在回车点兜底采集键入命令——门过滤（空行/全屏程序/传输占用/命令运行中）加回显对照，关闭回显的凭据输入（sudo/ssh 密码）绝不入史；顺带修复命令历史从未真正落盘的既有 bug（此前刷新/重开会话即清空）。面板新增搜索输入框：打开即聚焦、打字即过滤（fzf 风格子序列评分），↑↓/Enter/Tab/Esc 照常导航回填。
  **Terminal history panel: manual-typed command capture + in-panel search.** SSH/local sessions without shell integration now capture typed commands at the Enter point as a fallback — gated (empty lines/full-screen programs/transfers/running commands) with echo comparison, so echo-disabled credential inputs (sudo/ssh passwords) never enter history; also fixes a long-standing bug where command history was never actually persisted (a refresh cleared it). The panel gains a search box: focused on open, filters as you type (fzf-style subsequence scoring) with unchanged ↑↓/Enter/Tab/Esc navigation.
- **历史面板对齐 shell ↑ 方向并导入远端 shell 历史**。条目顺序统一为旧上新下（与 shell readline ↑ 一致），打开时高亮最新执行的命令、↑ 逐格上翻更旧；连接建立后经非交互通道拉取一次远端历史存量（HISTFILE 优先，回落 `~/.bash_history`/`~/.zsh_history`，tail 500 条，zsh EXTENDED_HISTORY 元数据剥离）合并进命令环，每会话仅拉一次。
  **History panel aligns with shell ↑ direction and imports remote shell history.** Entries now read old-on-top/new-on-bottom (matching readline ↑), with the newest highlighted on open; after connecting, one non-interactive fetch merges the remote history file (HISTFILE first, falling back to `~/.bash_history`/`~/.zsh_history`, tail 500, zsh EXTENDED_HISTORY metadata stripped) into the command ring, once per session.
- **远端历史导入兼容 BusyBox 并支持失败重试**。路由器/NAS 上的 BusyBox `tail` 不识别 `--` 分隔符导致导入静默失败——去掉分隔符并把路径改为 ~ 展开；拉取失败/空输出不再永久放弃，面板下次打开时按需重拉一次。
  **Remote history import: BusyBox compatibility and retry on failure.** BusyBox `tail` on routers/NAS rejects the `--` separator (silent empty import) — the separator is gone and paths now expand `~`; a failed/empty fetch is no longer abandoned permanently and is retried once on the next panel open.

## [0.7.1-beta.12] — 2026-09-29

- **新增 Warp 式 history 面板（↑ 唤起命令历史可视化）**。终端里按裸 ↑ 即在输入行上方展开全宽面板：fzf 式子序列检索 + 子串回落、输入即过滤（行缓冲即 query）、每条命令右侧显示相对执行时间；↑↓ 导航、Enter/Tab 仅回填输入行不自动执行（不新增自动执行命令路径），Esc 关闭。alternate 屏（vim/htop）、命令运行中、传输占用、既有浮层开启时不抢 ↑（shell 原生 readline 历史保留），⌘⇧H / Ctrl+Shift+H 为可配置补充入口；会话切换 / 命令开始执行 / 清屏兜底关闭。数据沿用全局命令历史并新增执行时间映射（统一采集口 `pushTerminalCommandHistory`，四个采集点共用；旧历史无时间则不显示时间列）。
  **New: Warp-style history panel (raise with ↑).** Pressing bare ↑ in the terminal opens a full-width panel above the input line: fzf-style subsequence matching with substring fallback, filter-as-you-type (the line buffer is the query) and a relative execution time per entry; ↑↓ navigates, Enter/Tab only refills the input line without executing (no new auto-execute path) and Esc closes. Bare ↑ is not grabbed when an alternate screen (vim/htop) is active, a command is running, a transfer is in flight or another overlay is open (shell readline history stays reachable); ⌘⇧H / Ctrl+Shift+H is the configurable secondary entry. The panel closes on session switch, command start and clear-screen. Data reuses the global command history plus a new execution-time map (one unified collector `pushTerminalCommandHistory` shared by all four collection points; older entries without timestamps simply show no time column).
- **Docker 面板浮层化：不再挤占终端布局**。面板从 `.docker-pane` 停靠分栏（divider 拖宽、终端/SFTP 让宽）改为 metrics 同款右上浮层（`.docker-float`，挂终端面板内右上角，自右缘向左覆盖终端一角），不占分栏宽度、永不遮挡 SFTP 面板，X/Esc 随时可关；workbenchState 停写 `dockerPaneWidth`（旧值残留无害）。
  **Docker panel is now a floating overlay.** The panel moved from the docked `.docker-pane` split (divider drag, terminal/SFTP giving way) to a metrics-style top-right float (`.docker-float`, anchored inside the terminal pane, overlapping the terminal's right edge) — it no longer takes split width, never covers the SFTP panel, and closes with X/Esc anytime; workbenchState no longer persists `dockerPaneWidth` (stale values are harmless).
- **工程：工作台前端完成结构性拆分**。App.vue 从 14,281 行拆至 ~8,700 行，40 个功能域收口为 composables（传输/导航/会话/事件分派等），纯代码层次拆分、零行为变化；ConPTY 启动探针扩展覆盖 cmd/PowerShell/WSL 三种 shell。
  **Engineering: the workbench front end finished a structural split.** App.vue went from 14,281 to ~8,700 lines with 40 domain composables (transfers, navigation, sessions, event dispatch, …) — pure code restructuring with zero behavior change; the ConPTY startup probe now covers cmd/PowerShell/WSL shells.

## [0.7.1-beta.11] — 2026-09-29

- **修复 Windows 本地终端启动残影的真正成因：ConPTY 握手应答用了错误的值**。ConPTY 以 `PSEUDOCONSOLE_INHERIT_CURSOR` 创建，开场 `CSI 6n` 问的是「终端光标在哪」并把子进程放到该位置；此前 sidecar 用**视口尺寸**应答，等于宣称光标在最后一行——conhost 于是把首字符留在顶部（cmd 的 `M`、WSL 的 `d`）并从底部整屏重画横幅（PowerShell 提示符画两遍）。前三轮修复（spawn 尺寸稳定、同尺寸 resize 去重、启动窗口 resize 门控）都作用于另一条 resize 通路，所以毫无改观。现在工作台在启动时上报终端真实光标（`cursorRow`/`cursorCol`），sidecar 归一化后如实应答——shell 就从用户看到的光标处开始输出。
  **The real cause of the Windows local-terminal startup artifact: the ConPTY handshake was answered with the wrong value.** ConPTY is created with `PSEUDOCONSOLE_INHERIT_CURSOR`, so its opening `CSI 6n` asks where the terminal's cursor is and starts the child there; the sidecar answered with the **viewport size**, i.e. "your cursor is on the last row" — conhost left the first glyph at the top (cmd's `M`, WSL's `d`) and re-drew the whole banner from the inherited bottom row (PowerShell's prompt twice). The three earlier fixes all worked on the other resize path, which is why nothing changed. The workbench now reports the terminal's real cursor at spawn (`cursorRow`/`cursorCol`) and the sidecar answers truthfully, so the shell starts where the user sees the cursor.

## [0.7.1-beta.10] — 2026-09-29

- **修复 Windows 本地终端启动顶部孤字/双提示符在宿主改面板几何时仍复现**：此前两轮修复（spawn 前等插件面板布局稳定、同尺寸 resize 去重）只挡住了插件自己引起的重绘；DBX 宿主在 spawn 之后仍会继续整理 dock/tab 面板几何，这类真实跨几何 resize 落在 shell 开场横幅/首个提示符的输出窗口内，ConPTY 整屏重序列化与输出交错，仍会渲染出顶部孤字（cmd 的 "M"、WSL 的 "d"）或重复提示符（PowerShell 两行 `PS …>`）。现在仅 Windows：spawn 起 3 秒启动窗口内，横幅正在写（距上次输出不足 500ms）时的 resize 请求被扣留并合并，输出安静满 500ms（或窗口到期）后一次性应用最终几何——静止屏幕上的 ConPTY 重绘是幂等重排，不再产生副本；首个输出之前与窗口之外的 resize 立即应用，Unix 平台不受影响。
  **Fix Windows startup orphan-glyph / duplicated prompt resurfacing when the host reshapes the panel after spawn:** the two earlier fixes (pre-spawn layout settling, same-size resize dedup) only removed repaints the plugin itself caused; the host keeps settling dock/tab geometry after spawn, and those real cross-geometry resizes still landed inside the shell's opening output window, where ConPTY's whole-screen re-serialization interleaved with the banner into an orphan glyph (cmd's "M", WSL's "d") or a duplicated prompt (two `PS …>` lines in PowerShell). Windows-only now: within a 3s startup window, resizes arriving while output is in flight (less than 500ms since the last PTY output) are held and merged; the final geometry applies once output stays quiet for 500ms (or the window expires) — the repaint over a static screen is an idempotent re-layout. Resizes before the first output and past the window still apply immediately; Unix is unaffected.
- **安全加固：sudo 白名单执行语义收口（评审第七轮）**：sudo 白名单此前按"文本匹配"放行、实际经 `sh -c` 执行，存在语义缝隙——现在由 sidecar 逐 token shell-quote 重建放行命令并执行重建版，`LD_PRELOAD=` 前缀赋值被物理剥离、被尾部 `*` 吞掉的元字符 token 失去 shell 语义（此前可借道提权到任意 root 代码）；Quick Sudo 密码/TOTP 不再可能被喂进"密码已答后出现的合并伪提示词"（Combined 分支加 password_answered 门）；sudo 辅助命令输出上限 16MiB/流（超限截断但持续 drain），防恶意远端在超时窗口内灌爆 sidecar 内存；后台任务目录迁至 `$HOME/.dbx-ssh-tasks`（0700），共租用户无法预占/symlink 劫持任务日志。
  **Security hardening: sudo allowlist execution semantics tightened (review round 7):** the allowlist matched text but executed via `sh -c`; the sidecar now rebuilds the allowed command token-by-token with shell quoting and executes the rebuilt form — `LD_PRELOAD=` prefixes are stripped and glob-swallowed metacharacters lose shell meaning (previously an escalation path to arbitrary root code); Quick Sudo passwords/TOTP can no longer be fed to merged fake prompts after the password was already answered (password_answered gate on the Combined branch); sudo helper output is capped at 16MiB/stream (truncated, drain continues) so a malicious remote cannot balloon sidecar memory; the background-task directory moved to `$HOME/.dbx-ssh-tasks` (0700), out of symlink hijack reach from co-tenants.
- **端口映射添加表单修复**：`<form disabled>` 是无效属性——无会话时输入框仍可编辑、仅按钮变灰，用户填完内容点击无任何反馈；改用合法的 `<fieldset :disabled>` 真正禁用控件并显示"请先建立会话"提示（七语）；提交加忙碌锁（防连点重复发起、慢 RPC 时按钮显示加载态），提交失败错误文案显示在弹窗内。与评审第七轮的"在途守卫"合并实现为同一 `submitting` 状态。
  **Port-forward form fixes:** `<form disabled>` is an invalid attribute — without a session the inputs stayed editable and only the button greyed out, so a filled form died silently; replaced with a real `<fieldset :disabled>` plus a visible "establish a session first" hint (7 locales); submit now has a busy lock (no double submissions, spinner during slow RPC) and failures render inside the dialog. Merged with review round 7's in-flight guard into a single `submitting` state.
- **评审第七轮·前端确定性缺陷**：OtpPanel 打开新建/编辑对话框时清除上次遗留的 backend 错误；App.vue 目录链接目标 hydration 带代次复核（快速导航时旧目录的 readlink 晚到批次不再覆盖新目录状态）；卸载清单补 recordingElapsedTimer 与 DockerPanel fillReset。
  **Review round 7 · frontend determinism fixes:** OtpPanel clears the stale backend error when reopening create/edit dialogs; App.vue link-target hydration carries an epoch re-check (late readlink batches from a previous directory no longer overwrite the new one); unmount cleanup adds recordingElapsedTimer and DockerPanel fillReset.

## [0.7.1-beta.9] — 2026-09-27

- **修复 Windows 本地终端提示符渲染两遍（PowerShell 等无 banner shell）**：本地 shell 现在等终端面板布局稳定后再 spawn——dock「+」新开 tab 时 webview 可能尚未布局完成（宿主 0 尺寸回落 80×24、web 字体换装改变单元格度量），shell 按临时尺寸启动后，布局到位的真实 fit 是一次跨几何 resize，ConPTY 整屏重绘＝提示符/横幅画两遍；现在逐帧采样至连续两次 fit 一致（限时 1.5s 兜底）才以最终尺寸启动。
  **Fix duplicated prompt on Windows local terminal start (PowerShell and other banner-less shells):** the local shell now spawns only after the terminal panel's layout has settled — on a dock "+" fresh tab the webview may still be laying out (zero-size host falls back to 80×24, web font swap changes cell metrics), so the shell started at a temporary size and the later real fit became a cross-geometry ConPTY repaint, drawing the prompt twice; spawn now waits for two consecutive identical fits (bounded at 1.5s).
- **dock「+」默认 Shell 启动项提为顶层首位，shell 分组更名「本地SHELL」并默认折叠**：默认 Shell 启动项不再带 `group`（宿主将其平铺在弹窗首位，单击即开），本机扫描到的 shell 子项收进可折叠分组，组标签改为「本地SHELL」（随界面语言），宿主默认折叠该分组。
  **Dock "+" default-shell entry promoted to the top; shell group renamed "Local shell", collapsed by default:** the default-shell launcher no longer carries a `group` (the host pins it as the picker's first row — one click to open); the machine-scanned shell entries move into the collapsible group (localized label, e.g. "本地SHELL"), which the host renders collapsed by default.

## [0.7.1-beta.8] — 2026-09-27

- **修复 Windows 本地终端启动 banner 重复渲染**：sidecar 对本地终端的同尺寸 resize 请求直接丢弃（Windows ConPTY 对同尺寸 `ResizePseudoConsole` 也会整屏重绘缓冲区，与 shell 启动横幅输出竞态，产生顶部孤字/底部重复 banner），仅真实几何变化才到达 PTY。
  **Fix duplicated banner on Windows local terminal start:** same-size resize requests are now dropped before reaching ConPTY — ConPTY re-serializes its whole screen buffer even for same-size resizes, racing the shell banner into a duplicated prompt; only real geometry changes reach the PTY.
- **dock「+」启动项重构为「本地终端」可折叠分组**：`local/terminal/launch-options` 返回的每一项携带 `group` 本地化标签——首项为默认 Shell 启动项（描述展示解析后的默认 Shell，`localShell` 偏好优先），其余为本机扫描到的 shell 子项（`context` 固定 `shell` 程序）；宿主渲染为单个可折叠「本地终端」分组，与下方连接分组同一交互。
  **Dock "+" launch options reworked into a collapsible "Local terminal" group:** every entry now carries a localized `group` label — the first entry launches with the resolved default shell (shown in its description, `localShell` preference first) followed by one entry per machine-scanned shell; the host renders them as one collapsible section matching the connection groups below.

## [0.7.1-beta.7] — 2026-09-27

- **统一终端文案并本地化工作台标签**：sidecar 错误文案去掉「SSH terminal」式旧称（如 `SSH terminal is closed` → `Terminal is closed`、`Failed to open SSH terminal channel` → `Failed to open terminal channel`）；工作台标签标题改为跟随界面语言（中文环境显示「终端」，此前为静态英文 Terminal）。
  **Unified terminal copy and localized the workbench tab title:** sidecar error strings drop the legacy "SSH terminal" wording (`SSH terminal is closed` → `Terminal is closed`, `Failed to open SSH terminal channel` → `Failed to open terminal channel`); the workbench tab title now follows the UI locale ("终端" in Chinese instead of a static English "Terminal").
- **dock「+」启动项标签简化**：启动项标签由「本地终端（自动检测）」简化为「本地终端」，实际使用的 Shell 仍在描述行展示（默认 Shell：…）；仅文案变化，行为不变。
  **Dock "+" launch entry label simplified:** the entry label drops the "(auto-detect)" suffix and is now just "Local terminal"; the effective shell still shows in the description line. Copy-only change, no behavior change.

## [0.7.1-beta.6] — 2026-09-27

- **dock「+」启动选项收敛为单项 + 默认 Shell 可配置**：`local/terminal/launch-options` 只返回一项「本地终端（自动检测）」（接受宿主下发的 `locale`，描述展示解析后的默认 Shell；逐 shell 启动入口保留在工作台 shell 选择器）；设置·终端新增「默认 Shell」选择器（`localShell` 偏好，与工具条 shell 选择器同存储键），dock 新开的本地终端按该配置启动。
  **Dock "+" launch options collapsed to one entry + configurable default shell:** `local/terminal/launch-options` returns a single localized "Local terminal (auto-detect)" entry whose description shows the resolved default shell; Settings · Terminal gains a "Default shell" selector (the `localShell` preference shared with the toolbar shell picker), honored by local terminals opened from the dock.

## [0.7.1-beta.5] — 2026-09-27

### 修复 / Fixed

- **Windows 孤儿进程根治**：sidecar 死亡（崩溃/更新/宿主退出）时本地终端的 ConPTY conhost + shell 全树由进程级 Job Object（kill-on-close）兜底回收，不再残留烧满核心的孤儿 conhost；挂载失败仅记日志不阻断启动。
  **Windows orphan reaping:** a process-level kill-on-close Job Object tears down the whole ConPTY conhost + shell tree when the sidecar dies (crash, update, host exit); assignment failure is logged only, never fatal.
- **本地终端启动不再静默卡死**：`local/terminal/start` 调用补 10s 超时（宿主桥丢响应时 promise 不再永久挂起，超时给出错误提示）；启动中状态新增可见加载覆盖层（此前为零反馈黑屏）；七语文案齐备。
  **Local terminal start hardening:** 10s timeout on the start invoke (a dropped bridge response no longer pends forever and surfaces an error), a visible starting overlay (previously a silent black screen) and localized copy in all seven languages.

### 冒烟 / Tooling

- `scripts/sidecar_client.py` Windows 兼容：管道读改线程探活（原 `select()` 在 Windows 管道句柄必然 `WinError 10038`）+ stderr 后台排空（防 sidecar 日志塞满管道缓冲卡死）；`smoke_local_terminal.py` 首次在 Windows 真机全绿。
  **smoke client Windows support:** thread-based readability probing and stderr draining let `smoke_local_terminal.py` pass natively on Windows for the first time.
## [0.7.1-beta.4] — 2026-09-27

Tabby / NetCatty 五协议对标批（协议处理加固 + 测试面扩容，后端 617 / 前端 646 单测 + 8 个真机 smoke 全绿；对标与决策记录见 `docs/TABBY_PROTOCOL_PARITY.zh-CN.md`、`docs/AUTH_ADVERSARIAL_REVIEW.zh-CN.md`）。

### 新增 / Added（M2 W2b）

- **Docker 管理面板**：`docker/list|logs|action`（白名单 start/stop/restart/kill/rm + 容器 ID hex 门 + 只读连接拒绝 + 审计日志前后落笔）；sudo 回退走 Quick Sudo 管线（密码只走 stdin）；MCP 新增 `docker_list`（只读）与 `docker_action`（destructive 提示）；侧栏面板含 10s 轮询（3 连败停轮询）、日志抽屉、rm/kill 确认框、"在终端打开"剪贴板降级。
  **Docker management panel:** allow-listed container actions with hex-id gate, read-only refusal and audit trail; sudo fallback via the Quick Sudo pipeline; MCP tools; side panel with polling, log drawer and destructive-action confirms.
- **watcher 文件自动回传（桌面端）**：`watch/start|stop|stop-all`（notify 非递归 + 会话去重表 + 500ms 去抖 + 启动 2s 抑制窗），len/mtime/SHA256 三元指纹确认内容真变才广播 `watch/file-modified`；会话关闭自动回收。
  **File watcher (desktop):** notify-based non-recursive watches with session dedup, 500ms debounce, 2s suppression window and len/mtime/SHA256 fingerprints — `watch/file-modified` only fires on real content changes.
- **OTP 面板**：条目列表 + TOTP 倒计时环形（reused 提示）、HOTP 生成（counter+1 持久化）、扫码导入（图片 base64 → `otp/import-qr` 预填）、新增/编辑（secret 遮蔽，编辑留空保留旧密钥）、连接绑定、发送验证码到终端。
  **OTP panel:** entry list with countdown, HOTP generation, QR import, masked editing, connection bindings and send-to-terminal.
- **导入向导**：主文件与可选 WindTerm `user.config` 走有界二进制分块与 ACK 的临时流式预览（64 MiB 总预算、超时/取消即清理），可导出脱敏规范化 JSON；插件不再保存导入会话，密码、私钥内容与口令绝不导出或持久化。
  **Import wizard:** bounded binary chunks with ACKs provide temporary previews for the main export and optional WindTerm `user.config` (64 MiB total; timeout/cancel cleans up), with sanitized normalized JSON export; imported sessions are never stored and passwords, private-key material and passphrases never leave the sidecar.
- **终端大输出保护**：写入积压 ≥128KiB 进入 strained（32KiB 分帧、挂起 gutter/高亮扫描），<64KiB 恢复；七语提示。
  **Large-output protection:** write backlog ≥128KiB strains the terminal (32KiB framing, gutter/highlight scans suspended) until <64KiB; localized notice.
- **终端右键菜单 + 选中文本在线搜索**：Copy/Paste/搜索引擎列表（可配 `ctx_search_engines`，%s 模板）；宿主 openExternal 缺失时降级复制链接。
  **Terminal context menu + online search:** copy/paste and configurable search engines (`ctx_search_engines`); falls back to copying the link until the host ships openExternal.
- **背景图**：`local/wallpaper/get|set|clear`（≤8MiB，png/jpeg/webp 魔数校验，tmp+rename 原子写）；Appearance 设置开关 + 透明度滑杆；开启时挂起 WebGL 回退 DOM 渲染。
  **Wallpaper:** validated get/set/clear protocol, Appearance toggle with opacity slider; enabling suspends WebGL in favour of DOM rendering.

### 新增 / Added（M2 W2a）

- **OTP 中心化库**：TOTP/HOTP 算法（RFC 4226/6238 向量单测）、`otpauth://` 解析、二维码扫码导入（`rqrr`+`image`，新依赖）、条目库（secret 经 vault 加密落盘）、连接绑定、跨路径共享的 TOTP 防重放缓存；登录/sudo 自动应答取码新增「绑定条目」来源（连接 `totp_secret` 优先级不变）。MCP 无新增工具（`otp/*` 为 workbench 内部协议）。
  **Centralized OTP library:** TOTP/HOTP with RFC vectors, otpauth:// parsing, QR import (rqrr+image, new deps), encrypted entry store, connection bindings and a shared replay guard; login/sudo auto-answer now consults bound entries after the connection `totp_secret`.
- **会话导入（Xshell / MobaXterm / WindTerm）**：`.xts`（ZIP+GBK+INI）、`.mxtsessions`（INI 管道格式）、`.sessions`（JSON+PBKDF2-SHA3-512/AES-CBC 主密码解密）解析器；现采用 `import/preview/start|finish|cancel` 临时流式预览与脱敏导出，旧 `import/commit` 与插件私有连接存储已移除；zip-bomb 防护（条目/单条/总量上限）。新依赖 `zip`/`encoding_rs`/`sha3`/`cbc`/`aes`/`pbkdf2`。
  **Session import:** parsers for Xshell/MobaXterm/WindTerm now use temporary `import/preview/start|finish|cancel` streaming previews and sanitized exports; the old `import/commit` and plugin-private connection storage are removed, with zip-bomb guards retained.
- **Telnet 会话**（明文协议，UI 提示仅限可信网络）：手写 IAC 协商（WILL/DO/NAWS、跨块状态机、IAC IAC 还原）、回车与 Backspace 模式、Expect 自动登录（复用 triggers 规则解析）、`telnet/start|write|resize|close|list` + `telnet/terminal/out` 帧通道；工作台 "New Telnet session" 入口（与 SSH/本地会话互斥确认后切换）。
  **Telnet sessions:** hand-rolled IAC negotiation with cross-chunk state machine, enter/backspace modes, Expect auto-login reusing the trigger rule parser, and a workbench entry with mutual-exclusion confirm.

### 新增 / Added

- **终端命令建议浮层**（对标 NyaTerm）：终端内输入时按模糊评分浮出历史/快捷命令建议（↑↓ 选择、Tab 填充、Enter 执行、Esc 关闭）；采集挂接 shell integration 命令标记与命令条执行路径，沿用密钥样过滤，Expect/OTP 注入文本不入库；alternate buffer/pager/抑制程序集（htop/less/man/journalctl/tail -f 等）五门抑制；设置键 `history_suggestions_enabled`（默认开）与长度上下限。
  **Terminal command suggestions:** fuzzy-scored history/quick-command overlay in the terminal (↑↓ select, Tab fill, Enter run, Esc dismiss); collection hooks shell-integration command markers and the command bar, reuses the secret-like filter, and never records Expect/OTP injected text; suppressed in alternate buffers, pagers and a suppressive-program set; new `history_suggestions_enabled` and length-limit preferences.

- **动作链接**（默认关闭，对标 NyaTerm）：识别终端输出中的 IPv4、`host:port` 与压缩包文件名并加下划线，点击把建议命令（`ping`/`nc -vz`/`unzip` 等）填入输入行而不执行；三类匹配器独立开关；与既有 IP/关键词高亮让位共存。
  **Action links (off by default):** underline IPv4, host:port and archive names in terminal output; clicking fills the suggested command (`ping`/`nc -vz`/`unzip`…) into the input line without running it; three matcher toggles; yields to the existing keyword/IP highlights.

- **行号/时间戳 gutter**（默认关闭，对标 NyaTerm）：终端左缘行号列与行首写时间戳列（回车重盖当前行），格式串可配（`[HH:mm:ss]` 默认，token 化）；wrapped 行只标首行，alternate buffer 隐藏，读不到渲染尺寸时整体降级隐藏。
  **Line-number / timestamp gutter (off by default):** left gutter with line numbers and first-write timestamps (Enter restamps the current line), configurable token-based format; wrapped lines mark their first row only, hidden in the alternate buffer, degrades gracefully.

- **GPU / Ascend NPU 监控**（对标 NyaTerm）：`ssh_metrics` 新增 `gpu`/`npu` sections——NVIDIA 经 `nvidia-smi`（利用率/显存/温度/功耗/风扇/pstate + 计算进程按 uuid 归卡），Ascend 经 `npu-smi info`（AI Core/HBM/健康度/功耗 + CANN 版本从安装元数据读取）；MCP `ssh_metrics` 自动受益；监控面板新增卡片区（警戒色阈值、空进程态、不可用弱化提示）。
  **GPU / Ascend NPU monitoring:** `ssh_metrics` gains `gpu`/`npu` sections — NVIDIA via nvidia-smi (utilization/memory/temp/power/fan/pstate plus compute processes keyed by uuid), Ascend via npu-smi info (AI Core/HBM/health/power with the CANN version read from install metadata); the MCP tool benefits automatically and the metrics panel renders per-device cards with warning colours and graceful unavailable states.

- **传输并发与重复目标策略**：上传并发可配置（`transfer_concurrency`，1–10 默认 3，暂停占位/取消释放槽位）；远端同名文件按 `transfer_duplicate_policy` 处理——自动改名（默认，`name(1)..name(999)` 经新 `sftp/rename-unique`）/覆盖/逐个询问（支持应用到全部）。
  **Transfer concurrency and duplicate policy:** configurable upload concurrency (`transfer_concurrency`, 1–10, default 3; paused transfers keep their slot, cancelled release it); remote name clashes follow `transfer_duplicate_policy` — auto-rename (default, via the new `sftp/rename-unique`), overwrite, or per-batch ask with apply-to-all.

### 新增 / Added（五协议对标批）

- **Agent 认证预算计划器**：agent 密钥逐个尝试现在受预算约束（默认 5 次——OpenSSH `MaxAuthTries` 默认 6 次含 none 探测），服务器已示意 keyboard-interactive（partial success）时立即转入 MFA 应答而不再烧掉剩余尝试名额；传输层错误首个即停，错误原文直接呈现，预算耗尽时提示改用指定私钥，不再只给笼统的"身份被拒"。
  **Agent auth budget planner:** identity attempts are now budgeted (5 by default — OpenSSH's `MaxAuthTries` of 6 includes the leading none probe), a partial-success nudge toward keyboard-interactive switches to MFA answering immediately instead of burning remaining attempts, the first transport error stops the loop with its original message, and an exhausted budget suggests pinning a private key instead of a generic rejection.

- **SFTP 文件名不可解码标记**：服务器 locale 非 UTF-8（如 GBK）时文件名里的损坏字符现在会被标记（`sftp/list` 与 sudo 列表恒定输出 `lossy`），SFTP 面板对这类条目显示警示图标与七语提示，引导修正远端 `LANG`；协议层已在解码时丢弃原始字节，任何客户端编码器都无法还原，因此不做转码器。
  **Undecodable SFTP name flag:** names damaged by a non-UTF-8 server locale (GBK etc.) are now flagged (`lossy` on `sftp/list` and sudo listings) with a warning icon and a seven-language hint in the SFTP pane; the wire layer already discards the raw bytes, so no client-side codec could recover them.

- **none 探测广告集门（reconcile）**：none 探测拿到的服务器广告集现在会约束后续密码 / keyboard-interactive 的尝试（两份广告集都放行才尝试、冲突取严；服务器未提供广告集时保持旧行为），密码型连接在被明确拒绝的方法上不再浪费尝试次数。
  **None-probe advertisement gate:** the method set advertised to the none probe now also constrains later password / keyboard-interactive attempts (both sets must allow a method; the stricter side wins; missing sets keep the old behavior), so password connections stop wasting attempts on explicitly rejected methods.

### 修复 / Fixed

- **trzsz 进度不再回跳与虚报**：乱序/重放的进度事件不再让进度条倒退，会话总量不再被重复的 size 通告或超长尾块虚增，重跑传输不再继承上一轮的总量分母，非数值的 size 通告被忽略。
  **trzsz progress no longer jumps backwards or overcounts:** out-of-order / replayed progress events can no longer move the bar backwards, session totals are no longer inflated by duplicate size announcements or oversized trailing chunks, re-runs no longer inherit the previous total, and non-numeric sizes are ignored.

- **含 `..` 的上传目标不再落错临时目录**：上传临时件（`.part`/`.backup`)现在与规范化后的最终目标同目录，原子改名前提在所有路径形态下成立；相对路径父目录弹空时显式报错。
  **Upload targets containing `..` stage in the right directory:** upload temporaries (`.part`/`.backup`) now sit next to the normalized final target, keeping the atomic rename precondition for every path shape; relative paths whose parent collapses away fail with an explicit error.

- **会话导入加固**：OpenSSH `Host a,b` 逗号分隔列表拆分为独立条目（此前整体当作一个具名主机，导入必然连不上的坏条目）；预览文本先剥离 ANSI 控制序列再按上限截断；Host/Match 超长参数按字符边界安全截断。
  **Import hardening:** comma-separated `Host a,b` lists now split into separate entries (previously imported as one unresolvable name); preview text strips ANSI escape sequences before the length cap; overlong Host/Match arguments are truncated on char boundaries.
- **Auto 认证失败聚合去重**：keyboard-interactive 在 partial-success 续答与专属阶段被多次记录时合并 detail，聚合消息不再重复同一方法，「每方法一条、按首试顺序」不变量在 debug 构建不再假失败。
  **Auto-auth dedup:** repeated keyboard-interactive records merge their details instead of duplicating entries in the aggregated failure message.
- **Windows PowerShell 集成脚本兼容 Restricted 策略**：以进程级 `-ExecutionPolicy Bypass` 运行临时目录集成脚本（不改机器/用户策略；组策略强制时保持原 fail-safe 行为）。
  **PowerShell Restricted-policy compatibility:** the temp-dir integration script now runs with process-scoped `-ExecutionPolicy Bypass`; group-policy-enforced machines keep the previous fail-safe behavior.
- **安全加固**：终端录像文件 0600 / 目录 0700 落盘（录像含回显输出，对齐 otp_store 纪律）；telnet 写入与二进制输入通道 64KiB 载荷硬帽；终端输入计数诊断日志 256KB 上限截断。
  **Hardening:** session recordings persist 0600 (dir 0700); telnet input channels cap payloads at 64 KiB; the terminal-input diagnostic log truncates at 256 KiB.
- `.dbx-store.json` 声明 `host.storage` 与 `host.clipboard:read` 宿主能力。
  **Store metadata:** declare `host.storage` and `host.clipboard:read` host capabilities.

### 构建 / Build

- **Vendored RDP 链完整性硬门**：`verify_rdp_vendor_integrity.py` 默认比对 vendored 树 tree-sha256；CI 与发布流程启用 `--require-recorded-hashes`（六个 crate 登记 tarball+树双哈希并逐文件比对）；vendor README 回填实际差异面并修正此前「无补丁」的不实声明。
  **Vendored RDP integrity gate:** tree-digest verification runs by default; CI and release enforce `--require-recorded-hashes` with dual-hash registration and per-file comparison for all six crates; the vendor README records the actual patch surface.
- CI 冒烟新增 `smoke_ssh_config_import.py` 与 `smoke_spawn_session_test.py`（WT-3/WT-4 端到端回归）。
  **CI:** add ssh-config import and same-transport spawn-session smoke regressions.

## [0.6.0] — 2026-09-22

0.6.0 正式版，收束 0.6.0-beta.1–4 的全部变更。

The 0.6.0 stable release, collecting everything from 0.6.0-beta.1 through beta.4.

### 新增 / Added

- **SSH 端口映射（-L/-R）**：工作台新增转发面板（`PortForwardDialog`），sidecar 支持用户级本地/远程端口映射；录入带校验与冲突预检，监听地址输入与接口选择合并为一个字段。
  **SSH port forwarding (-L/-R):** the workbench gains a forwarding panel backed by user-level local/remote tunnels in the sidecar; input is validated with conflict pre-checks, and the listen-host input and interface picker are merged into one field.

- **终端 electerm 对标特性**：xterm 升级到 6.1（beta 线起步），新增 electerm 风格全选快捷键与工作台设置中的终端字号调整（issue #31）；WebGL 渲染器在上下文丢失后按有界预算自动重建，不再黑屏。
  **electerm-parity terminal features:** xterm upgraded to 6.1 (entered on the beta line), electerm-style select-all shortcut and a terminal font-size setting in the workbench settings dialog (issue #31); the WebGL renderer rebuilds itself after context loss within a bounded budget instead of leaving a black canvas.

### 修复 / Fixed

- **macOS 快速输入不再丢键/串键**：WKWebView 下绕开 xterm 6.1 延迟 textarea diff 的直写提交路径，输入队列按传输顺序回放，快速连续输入不再丢字符。
  **Fast typing on macOS no longer drops or scrambles keys:** the macOS WKWebView path routes direct key commits around xterm 6.1's deferred textarea diff, and the input queue replays in transport order.

- **上传不再被宿主桥故障卡死**（#83/#79）：宿主文件桥 pick/读盘失败时自动回退 webview 原生文件选择器（File API）重挑继续上传；宿主级拖入上传读盘失败同样回退。三条拖拽上传链路（终端、SFTP 面板、宿主级拖入）统一共用「已连接 + 可写会话」门禁——宿主级拖入此前不设防，只读连接也能发起上传——拒绝时给出七语提示而不是静默吞掉；SFTP 面板仅在文件拖入时点亮放置高亮。
  **Uploads survive host-bridge failures (#83/#79):** when the host file bridge fails on pick or read, the webview's native file picker (File API) opens so the upload can continue; host-level drop uploads fall back the same way. All three drop-upload channels (terminal, SFTP pane, host-level drop) now share one connected + writable-session gate — the host channel previously had no gate and allowed uploads on read-only connections — and refusals show a seven-language notice instead of failing silently; the SFTP pane only lights its drop highlight for file drags.

## [0.4.79] — 2026-09-18

### 改进 / Improved

- **Sudo 与 2FA 不再藏在「高级选项」里**：这两个入口原本挂在默认关闭的 `advanced_options` 后面，用户配不出 MFA 也找不到 sudo 凭据（issue #17/#30 的结构性原因）。现在 `sudo_source`（默认「自定义（本连接）」——sudo 密码留空时回落登录密码，新连接开箱即有可用的 sudo 编排；不需要 sudo 的场景仍可显式选「关闭」）与 `auth_flow_mode`（默认「关闭（不自动应答 OTP）」）常显，默认表单只多两行；明细字段仍按来源/模式按需展开（选「自定义」才出现 sudo 密码、请求 PTY、白名单，选 OTP 模式才出现 TOTP 密钥与提示词）。`advanced_options` 移到 sudo/2FA 块**之后**，只收起超时、保活、环境变量、自动应答、只读，说明改为直接列出内容；字段顺序同时调整为「连接 → 认证 → Sudo → 2FA → 高级」。
  **Sudo and 2FA are no longer hidden behind "Show advanced options".** Both were gated by a switch that defaults to off, which is why users could not find the MFA setup or the sudo credentials (the structural cause behind issues #17/#30). `sudo_source` (default Custom — an empty sudo password falls back to the login password, so new connections get working sudo orchestration out of the box; hosts that should not touch sudo can still pick Off explicitly) and `auth_flow_mode` (default Off, never auto-answer OTP) are now always visible - a new connection gains two rows - while their detail fields still open on demand (Custom reveals the sudo password, PTY request and allowlist; an OTP mode reveals the TOTP secret and prompt hints). `advanced_options` moved *below* the sudo/2FA block and now only collapses timeouts, keepalive, environment, automatic replies and read-only, with a description that lists its contents; field order is now connection -> authentication -> sudo -> 2FA -> advanced.

- **私钥路径恢复「可手输」，密钥下拉不再撑长**：`private_key_path` 去掉 `options_action`——声明它会让宿主把字段渲染成纯下拉（无法输入路径），与宿主隧道密钥字段（输入框 + 浏览）体验不一致，也会让 `~/.ssh` 之外的密钥没法录入。现在字段保持普通输入框，选择交给宿主内置本地密钥建议器（桌面端）与「选择文件…」按钮（桌面选路径 / Web·Docker 上传到「私钥内容」）。`keys/discover/options` 保留为后端能力，label 由 `文件名 · 算法 · [已加密] · SHA256:指纹` 改为**路径本身**，避免下拉控件被长文本撑开；算法与指纹仍在 `keys/discover` 返回值里。
  **Private key path is typable again, and the key dropdown stops stretching.** `private_key_path` no longer declares `options_action` - that made the host render a select-only control (no manual input), which neither matched the host's own tunnel key field (text input plus browse) nor allowed keys outside `~/.ssh`. The field stays a plain input; selection comes from the host's built-in local-key suggestion list (desktop) and the file button (desktop picks a path; Web/Docker uploads into the pasted-key field). `keys/discover/options` stays a backend capability, and its label is now the key path itself instead of `basename · algorithm · [encrypted] · SHA256:fingerprint`, so the control is no longer stretched by long text; algorithm and fingerprint remain in `keys/discover`.

- **连接表单私钥录入新增「选择文件」通道**：`private_key_path` 现声明宿主 `picker`（Host API 1.1）——桌面端用原生对话框选择任意位置的私钥（写回绝对路径），Web/Docker 没有客户端文件系统时同一个按钮降级为上传，把文件内容写入「私钥内容」（secret 槽位）并清空路径。与原有的发现下拉、粘贴内容并存；路径与内容互斥（选文件会清掉已粘贴/上传的内容，反之亦然），不会出现"重新选路径后旧上传仍在生效"。刻意不声明扩展名过滤，避免 `id_rsa` / `id_ed25519` 这类无扩展名密钥在原生对话框里被置灰。该属性只在认识它的宿主发行版上能解析（旧宿主 `deny_unknown_fields` 会拒绝整份 manifest），因此 `engines.dbx` 固定为 `>=0.6.16`——0.6.16 是首个提供 `picker` 的发行版；走上传通道时私钥内容会复制到服务端连接密钥库。
  **Connection form private key: file picker channel.** `private_key_path` now declares the host `picker` (Host API 1.1): the desktop opens a native dialog and keeps the chosen absolute path, while Web/Docker builds — which have no client filesystem — turn the same button into an upload that writes the file content into the pasted-key field and clears the path. It stacks on top of the discovery dropdown and pasting, and path/content stay exclusive (choosing a file clears the pasted or uploaded copy and vice versa). No `accept` filter on purpose, so extension-less keys such as `id_rsa` / `id_ed25519` stay selectable. The attribute only parses on a host release that ships it (older hosts reject the manifest via `deny_unknown_fields`), so `engines.dbx` is pinned to `>=0.6.16`, the first release that parses it.

### 修复 / Fixed

- **终端快速输入不再串字**：连续快敲时按键会被远端 shell 收成乱序串（如 `ls` 敲多次出现 `lllslllllllss`）。根因在 sidecar SDK 的二进制帧分发：帧虽按线序到达，却被无序地丢进多线程 worker 池，同一终端通道的相邻按键帧并发执行，应用顺序失去保证。现在同一通道（同一会话的终端输入 / 上传流）的帧严格按到达顺序执行，不同通道仍然并行，JSON 请求路径不变；新增 SDK 单测锁定「同通道 FIFO」与「跨通道并发」两个性质。
  **Fast terminal typing no longer scrambles keystrokes:** rapid input used to reach the remote shell reordered (typing `ls` repeatedly could yield `lllslllllllss`). The cause was the sidecar SDK's binary-frame dispatch: frames arrive on the wire in order but were handed to a multi-threaded worker pool unsynchronized, so adjacent keystroke frames on one terminal channel could run concurrently and apply out of order. Frames on the same channel (a session's terminal input / upload stream) now execute strictly in arrival order, different channels stay concurrent, and the JSON request path is unchanged; new SDK tests pin both the per-channel FIFO and cross-channel concurrency properties.

- **2FA 关闭时不再残留「密码提示」行**：连接表单的 `password_prompt_hint`（密码提示）原先挂在「高级选项 + sudo 来源」上，与 TOTP 密钥、OTP 提示词不同组——2FA 选「关闭」时前两者折叠，密码提示却仍然出现，读起来像条件失效。现在它移入 2FA 块、紧挨 OTP 提示词，并只在自动回码的两种模式（`先密码,再 OTP` / `密码与 OTP 组合`）下与 TOTP 字段同现；高级区开关不再影响它，`global`（提示词整体由全局配置接管）时照旧隐藏。「Passphrase command」同步收紧为仅密钥类认证（`private-key` / `private-key-password`）下显示——密码 / agent 认证下它完全不生效，此前却照常出现。
  **The stray "Password prompt" row is gone when 2FA is off.** The connection form's `password_prompt_hint` used to hang off "advanced options + sudo source", in a different group than the TOTP secret and the OTP hint - picking "Off" folded those two but left the password hint visible, which read as a broken condition. It now lives inside the 2FA block next to the OTP hint and appears together with the TOTP fields only in the two auto-answer modes (`password-then-OTP` / `password+OTP combined`); the advanced switch no longer affects it, and a `global` profile (which owns the hints) keeps it hidden as before. "Passphrase command" is likewise tightened to key-based auth (`private-key` / `private-key-password`) - under password or agent auth it never had any effect yet still showed.

- **登录期 MFA（JumpServer / 堡垒机）**：`先密码，再 OTP` 在"密码或公钥先被服务器接受、再用 keyboard-interactive 问 MFA"的流程下不再把 OTP 提问留空；提问识别覆盖 koko 的 `[OTP Code]: ` 与 `Please Enter MFA Code.`，密码提示词也不会再劫持 OTP 提问（把登录密码当验证码回给服务器）；私钥 / SSH Agent 的 partial success 会续答 MFA，不再直接报"认证被拒"。登录提问的密码半边固定为登录口令（不再误用单独的 sudo 口令），`global` 模式下登录期 MFA 也能读到全局 Quick Sudo 配置的流程模式与 TOTP 密钥。认证失败信息会点名服务器提问并指路 2FA 配置。新增 `scripts/smoke_login_mfa_test.py`：10 个组合场景（四种提问形态 × 密码/私钥/全局配置 × 流程模式）端到端回归（issue #17 / #30）。
  **Login-time MFA (JumpServer / bastion hosts):** `Password first, then OTP` no longer leaves the MFA question blank when the password or public key is accepted first and keyboard-interactive follows; prompt recognition covers koko's `[OTP Code]: ` and `Please Enter MFA Code.`, a password hint can no longer hijack the OTP prompt (which used to send the login password as the code), and partial key / agent success continues into MFA instead of failing outright. Failure messages now name the server's prompt and point at the 2FA settings (issues #17 / #30).

- **合并提问（密码与验证码同一条）**：两种 OTP 模式都拼接成"密码+验证码"再回答（以前 `先密码，再 OTP` 只回密码半边，真正的合并提问必然失败）；终端内合并提问同样处理，`password_only` / `off` 仍只回密码半边。
  **Merged prompts (password and code in one question):** both OTP modes now answer with password + code concatenated instead of sending only the password half; the in-terminal watcher behaves the same, while `password_only` / `off` keep sending the password half alone.

- **连接表单 2FA 文案与顺序**：`Off` 选项改为"关闭（不自动应答 OTP）"（插件不提供手工输入通道，"手动输入"名不副实），2FA 说明补上选型指引（先问验证码/合并提问请选「密码与 OTP 组合」），TOTP 与提示词字段说明补上堡垒机示例与"填错字段不会生效"提示，OTP 提示词字段移到密码提示词之前；工作台设置弹窗同步加了一条 2FA 选型说明（七语）。
  **Connection form 2FA copy and field order:** the `Off` option is now "Off (never auto-answer OTP)", the 2FA description carries the selection guidance, the TOTP/hint fields mention bastion wording and the field-placement caveat, the OTP prompt field moved above the password prompt field, and the workbench settings dialog gained a 2FA selection hint (7 locales).

- **依赖宿主 DBX ≥ 0.6.16**：连接表单的私钥 `picker`（文件选择/上传）与条件显隐/条件必填一起，把 `engines.dbx` 从 `>=0.6.14` 抬到 `>=0.6.16`——0.6.16 是首个解析 `picker` 的发行版，旧宿主的 `deny_unknown_fields` 会直接拒绝整份 manifest（解析先于版本检查，所以该下限只声明事实、由契约脚本断言只许上移）。
  **Requires DBX ≥ 0.6.16.** The private-key `picker` (file dialog / upload) needs a host parser that knows the attribute: older hosts reject the whole manifest via `deny_unknown_fields`, so `engines.dbx` moves from `>=0.6.14` to `>=0.6.16`, the first release that ships it. The contract script pins the floor so it can only move up.

- **连接成功后 IP/关键词高亮一直闪**：0.4.78 的"连接后补一次重绘 + 重扫"只治了过渡丢帧，真正的病灶是装饰层自己喂出来的自激回路——每次重绘都把视口内的高亮装饰整组拆掉重建，而 xterm 在装饰注册/销毁后会再触发一次整幅重绘，于是"重绘 → 扫描 → 拆建 → 重绘"永不停歇（headless Chrome 实测：连接落定约 2.5 秒起，空闲终端 4 秒内 296 次整屏重绘、装饰 DOM 拆建各 2637 次；关掉高亮则 0 次）。现在只有"本帧重绘**且**文本确实变了"的行才重建装饰，滚出视口的行照旧释放，回路被掐断（同样场景：0 次拆建、0 次额外重绘）。顺带修正 `onRender` 视口相对行号与缓冲绝对行号的换算，避免缓冲区滚过一屏后原地改写（进度行、`\r` 覆盖）的行残留旧色块。
  **IP/keyword highlights kept flickering after a successful connect:** the 0.4.78 "force one repaint + rescan after connect" only papered over the dropped transition frame; the real cause was a self-sustaining loop in the decoration layer — every repaint tore down and rebuilt all in-viewport highlight decorations, and xterm fires another full repaint right after decoration registration/disposal, so "repaint → scan → rebuild → repaint" never stopped (headless Chrome: starting ~2.5s after the session settles, an idle terminal produced 296 full-screen repaints and 2637 decoration DOM add/remove pairs in 4s, versus 0 with highlighting off). Decorations are now rebuilt only for rows that were repainted *and* whose text actually changed, while rows scrolled out of the viewport are still released (same scenario: 0 rebuilds, 0 extra repaints). The viewport-relative → buffer-absolute mapping of `onRender` is also corrected so in-place rewrites (progress lines, `\r` overwrites) no longer leave stale colour blocks once the buffer has scrolled past one screen.

### 验证 / Validation

- 前端：460 个测试通过（新增 6 个覆盖装饰保留策略与行号换算的回归用例），类型检查与生产构建通过。浏览器走查（headless Chrome + `mock.html?fresh=1&slow=2` 连接流程）：空闲 12 秒装饰拆建 0 次、额外重绘 0 次；注入含 IP 的新输出后高亮即时出现且不再抖动；滚回历史、回看中写入、原地改写三类场景装饰数稳定。
  Frontend: 460 tests passed (6 new regression cases covering the rebuild policy and row mapping), type check and production build passed. Browser walkthrough (headless Chrome, `mock.html?fresh=1&slow=2` connect flow): 12s idle produced 0 decoration rebuilds and 0 extra repaints; injecting new output with an IP highlighted immediately without churn; scrollback, writing while scrolled back, and in-place rewrites all kept a stable decoration count.

## [0.4.78] — 2026-09-18

### 新增 / Added

- **界面字体实时跟随 DBX 全局字体**：插件 UI 与终端字体不再写死内置回退值，改为直接引用宿主 `--font-sans` / `--font-mono` 令牌——此前 `:root` 内联样式压过主题桥引用导致宿主字体永不生效；DBX 改全局字体后经令牌推送实时生效（依赖会在字体变更时主动推送 token 的宿主版本）。
  **UI and terminal fonts now follow the DBX global font in real time:** instead of hardcoding the plugin's built-in fallback fonts, fonts resolve through the host's `--font-sans` / `--font-mono` tokens — previously an inline `:root` style overrode the theme bridge's token references so the host font never applied. Font changes in DBX now take effect live via token push (requires a host build that pushes font tokens on change).

### 改进 / Improved

- **断线重连体验**：「重新连接」在凭据暂不可用（DBX/插件重载后连接注册表为空）时不再瞬间失败，进入最长 30 秒的有界自动重试并显示等待文案；期间从侧边栏重开该连接即自动连上。待宿主支持插件重载后主动重推连接配置后，将无需任何手动操作。
  **Reconnect UX:** clicking "Reconnect" when credentials are temporarily unavailable (connection registry empty after DBX/plugin reload) no longer fails instantly — it enters a bounded 30s auto-retry with a waiting hint; reopening the connection from the sidebar within the window connects automatically. Once the host re-pushes connection configs on plugin reload, no manual step is needed.

- **界面打磨**：录制记录列表改为标准列表项（行间单条发丝分隔线、行 hover 底色，消除双线）；全局 Quick Sudo 配置弹窗重排（高度随内容、工具行承载计数与主按钮「新建配置」、空态图标居中）。
  **UI polish:** the recordings list is now standard list items (single hairline separators, row hover background — no more double divider lines); the global Quick Sudo profiles dialog is restructured (content-height, a toolbar row with the count and a primary "New profile" button, centered empty state with icon).

- **UI 组件体系迁移**：全部对话框、工具栏弹出层、下拉选择、右键菜单、开关与通知横幅从手写实现迁移到 reka-ui（shadcn-vue 风格 wrapper，见 `frontend/src/components/ui/`）+ Tailwind 工具类；视觉与交互语义保持不变（Esc 分层关闭链、焦点归还、幽灵点击守卫等既有行为原样保留），单一文件产物形态不变。
  **UI component migration:** every dialog, toolbar popover, dropdown select, context menu, switch, and toast banner moved from hand-rolled implementations to reka-ui (shadcn-vue-style wrappers under `frontend/src/components/ui/`) with Tailwind utilities; visuals and interaction semantics are unchanged (the layered Esc close chain, focus return, and ghost-click guard are preserved), and the single-file bundle shape is intact.

- **无障碍提升**：弹窗标题接入 reka DialogTitle（读屏可正确公告对话框用途）；对话框 Tab 焦点圈定由 FocusScope 承担；右键菜单获得完整的方向键/Enter/Esc 键盘导航；下拉选择支持键盘检索与明确的选中态公告；通知/错误横幅改为 reka Toast，读屏经 aria-live 区域公告内容，悬停暂停倒计时、滑动关闭开箱即用；工具栏切换钮补齐 aria-pressed，传输状态条补 role="status"，title 提示对键盘聚焦同样生效。
  **Accessibility upgrades:** dialog headings now use reka DialogTitle (screen readers announce dialog purpose correctly); Tab focus trapping in dialogs is handled by FocusScope; context menus gained full arrow-key/Enter/Esc keyboard navigation; dropdown selects support keyboard typeahead and explicit selected-state announcement; notice/error banners are now reka Toasts announced via an aria-live region with pause-on-hover and swipe-to-dismiss; toolbar toggle buttons expose aria-pressed, transfer status bars expose role="status", and title tooltips also appear on keyboard focus.

### 修复 / Fixed

- **macOS 上连接成功后 IP/关键词高亮闪烁、点一下就好**：0.4.77 的连接成功过渡（卡片遮盖 → 终端显示）在 Mac WKWebView 上会漏一帧重绘，高亮装饰停留在过渡前状态，直到第一次点击/输入才刷新。连接落定为 connected 后下一帧主动做一次全量刷新 + 高亮视口重扫（等价于用户首次点击的效果），Windows 行为不变。
  **IP/keyword highlights flickered after a successful connect on macOS until the first click:** the 0.4.77 connect-success transition (card overlay → terminal reveal) drops a repaint frame under WKWebView, leaving highlight decorations stuck in their pre-transition state until the first click or keystroke. The session now forces a full refresh plus a highlight viewport rescan on the frame after the session settles into `connected` (equivalent to that first click). Windows behavior is unchanged.

- **设置弹窗左栏选中项隐形、hover 无反馈、药丸左角被削平**：迁移 reka Tabs 后，`.modal button:not(...)` 按钮复位选择器的实际特异性（`:not()` 按参数计，(0,3,1)）压过了左栏页签的选中/hover 规则 (0,3,0)，把选中药丸的背景抹成透明——白字落在白底上完全看不见；且 `.settings-body` 的 `overflow-y: auto` 使其成为水平裁剪盒，`.settings-layout` 抵消弹窗 padding 的负 margin 冲不出裁剪盒，左栏左边 16px 被整体切掉（药丸左角变直角、视觉贴边）。修复：复位选择器排除 `data-slot="tabs-trigger"`；负 margin 移到 `.settings-body` 自身（裁剪盒扩到弹窗边缘）；hover 底色从亮色主题下近乎隐形的 `--accent` 改为前景色 8% 混合（明暗两态均可见）；左栏水平留白 12px，与宿主设置侧栏一致。
  **Settings dialog sidebar: selected item invisible, no hover feedback, pill's left corners clipped flat:** after the reka Tabs migration, the `.modal button:not(...)` button-reset selector's real specificity (`:not()` counts its argument — (0,3,1)) overrode the sidebar tab active/hover rules (0,3,0) and stripped the active pill's background — white text on a white dialog. Worse, `.settings-body`'s `overflow-y: auto` turns it into a horizontal clip box, so `.settings-layout`'s negative margin (meant to cancel the modal padding) could not escape it — the sidebar's left 16px was sliced off (square left pill corners, pill hugging the edge). Fixes: the reset excludes `data-slot="tabs-trigger"`; the negative margin moved onto `.settings-body` itself so the clip box spans to the modal edge; hover uses an 8% foreground mix (visible in both themes) instead of the near-invisible light-theme `--accent`; sidebar horizontal padding is 12px, matching the DBX settings sidebar.

- **取消重连后点「连接」仍拿旧凭据空转**：在侧边栏改密码/连接信息触发重连、点「取消」、修正凭据后再点「连接」，仍用 sidecar 里的过期凭据反复失败，把 inactive 重试梯子耗尽才落到错误态。「连接」与「重连」改为同路径——先 `host.reopenConnection` 请宿主按最新配置重开连接、刷新凭据，再打开会话。自动重连梯子的第一级重试同样先刷新凭据：改密码后终端断开可自动恢复，不再呈现需要手动自救的假错误。
  **"Connect" after cancelling a reconnect still spun on stale credentials:** after editing the password/connection in the sidebar triggered a reconnect, clicking Cancel, fixing the credential and clicking "Connect" still failed repeatedly with the sidecar's expired credentials until the inactive-retry ladder exhausted. "Connect" now shares the "Reconnect" path — it first asks the host to reopen the connection with the latest config (`host.reopenConnection`) before opening the session. The first rung of the auto-reconnect ladder refreshes credentials the same way, so a terminal drop after a password edit self-heals instead of surfacing a false error.

- **Linux 老系统上插件启动即崩溃**：在 glibc 低于 2.39 的发行版（Ubuntu 22.04 / Debian 11 等）上 sidecar 无法加载，DBX 报 "Plugin 'io.dbx.ssh' exited with status exit status: 1"。Linux 构建改为全静态 musl 二进制（x86_64 / arm64），流水线强制校验包内二进制无动态链接，并在 debian:11（glibc 2.31）与 alpine（musl）容器中真实执行冒烟。
  **Plugin failed to start on older Linux systems:** on distros with glibc older than 2.39 (Ubuntu 22.04 / Debian 11, …) the sidecar failed the dynamic loader and DBX reported "Plugin 'io.dbx.ssh' exited with status exit status: 1". Linux builds are now fully static musl binaries (x86_64 / arm64); the pipeline hard-fails if the packaged binary is dynamically linked and smoke-executes it inside debian:11 (glibc 2.31) and alpine (musl) containers.

- **慢速网络下连接测试报费解的宿主超时**：未展开「高级选项」的连接，存储的 `connect_timeout_secs` 为 0，宿主把 `connection/test` 的 RPC 截止按宿主回退定为 10 秒，而插件 sidecar 的拨号预算默认 30 秒——拨号超过 10 秒时宿主直接杀掉请求，用户只看到 "request 'connection/test' timed out after 10 seconds"。现在 sidecar 的测试拨号预算对齐宿主截止并预留 1 秒（缺省 → 9 秒），超时时报出带补救指引的错误（"Increase 'SSH timeout' under Advanced options and retry"）。遗留宿主侧诉求：宿主物化连接配置时应应用 manifest 声明的 30s 默认值，而非回退到 10s。工作台会话打开路径行为不变。
  **Cryptic host RPC timeout on connection test over slow networks:** for connections whose Advanced options were never expanded, the stored `connect_timeout_secs` is 0 and the host applies its own 10s fallback as the `connection/test` RPC deadline, while the plugin sidecar budgeted 30s — any dial past 10s was killed by the host with a bare "request 'connection/test' timed out after 10 seconds". The sidecar now aligns its test dial budget to the host deadline with a 1s margin (9s when the field is absent) and reports an actionable timeout ("Increase 'SSH timeout' under Advanced options and retry"). Remaining host-side ask: the host should apply the manifest's 30s default when materializing connection configs instead of falling back to 10s. The workbench session-open path is unchanged.

### 验证 / Validation

- 前端：454 个测试通过，类型检查和生产构建通过；`smoke_ui_mock.mjs` 与 `smoke_ui_fresh_review.mjs` 浏览器走查（headless Chrome）全部通过。后端：`cargo test` 通过（含 preferences 白名单校验与合并语义）。流水线：`check_candidates.py` 强制 Linux 候选包内二进制为全静态 ELF（PT_INTERP 探测），CI 另在 debian:11 与 alpine 容器内执行包内二进制冒烟。
  Frontend: 454 tests passed; type checking and production build passed; `smoke_ui_mock.mjs` and `smoke_ui_fresh_review.mjs` browser walkthroughs (headless Chrome) are all green. Backend: `cargo test` passed (including preferences whitelist validation and merge semantics). Pipeline: `check_candidates.py` now hard-requires the Linux candidate's packaged binary to be a fully static ELF (PT_INTERP probe), and CI additionally smoke-executes the packaged binary inside debian:11 and alpine containers.

## [0.4.77] — 2026-09-17

发布地址 / Release: [ssh-v0.4.77](https://github.com/jinpy666/dbx-plugin-ssh/releases/tag/ssh-v0.4.77)

### 新增 / Added

- **Termius 风格连接卡片**：连接过程从裸 spinner 升级为完整卡片——主机信息与身份行、进度线动画、可展开的连接日志（尝试次数、host-key 确认、重试、失败分类）、取消按钮，以及"进度到顶 → 对号 → 短暂停留"的连接成功过渡。
  **Termius-style connect card:** the connecting state is now a full card — host identity, animated progress track, expandable connect log (attempts, host-key prompts, retries, failure categories), cancel, and a "fill → check → hold" success transition.

- **会话与输入可靠性**：同一连接在多个工作台间隔离 SSH 会话；快速输入增加有界背压；粘贴输入统一为 PTY Enter；多行快捷命令完整保留；host 主题等宽字体与终端同步。
  **Session and input reliability:** isolated SSH sessions per workbench on the same connection, bounded backpressure for rapid input, pasted input normalized to PTY Enter, multiline quick commands preserved, and host mono font tokens synced with the terminal.

### 改进 / Improved

- **私钥路径字段**：改为文本输入框 + 右侧「选择本机 SSH 密钥…」下拉（宿主原生特判），不再收缩成一个孤立的小箭头。
  **Private key path field:** now a text input with a native "pick a local SSH key" dropdown, instead of collapsing into a bare chevron.

### 修复 / Fixed

- 连接成功动画播放期间，SFTP/工具栏不再提前渲染（消除抖动）；终端关键词高亮装饰层不再穿透连接遮罩；输入时高亮不再整屏闪烁，且高亮跟随行编辑。
  During the connect-success animation, SFTP/toolbar no longer render early (no flicker); keyword-highlight decorations no longer paint through the connect overlay; highlights no longer flicker while typing and now follow line edits.

### 构建 / Build

- 新增 `.gitattributes` 统一 LF 检出，Windows 本地构建与 CI（Linux）产物逐字节一致。
  Added `.gitattributes` enforcing LF checkouts so Windows builds are byte-identical to CI builds.

### 验证 / Validation

- 前端：458 个测试通过，类型检查和生产构建通过。
  Frontend: 458 tests passed; type checking and production build passed.
- CI：仓库契约、前端、Rust sidecar、SSH 容器冒烟、Windows 连接配置回归全部通过。
  CI: repository contracts, frontend, Rust sidecar, SSH container smoke, and Windows connection-config regression all passed.

## [0.4.76] — 2026-09-15

发布地址 / Release: [ssh-v0.4.76](https://github.com/jinpy666/dbx-plugin-ssh/releases/tag/ssh-v0.4.76)

### 改进 / Improved

- **传输历史与下载工作流**：完善下载完成后的状态、进度展示和本地文件操作入口，并统一传输历史记录与恢复任务的界面反馈。
  **Transfer history and download workflows:** Improved completed-download state, progress presentation, local file actions, and the UI feedback shared by transfer history and resumable tasks.

- **跨平台 UI 与发布准备**：补齐运行时环境声明、国际化文案和发布安装脚本，确保构建后的插件 UI 与安装流程保持一致。
  **Cross-platform UI and release readiness:** Added runtime environment declarations, localized copy, and release installation handling so the packaged UI and install flow stay aligned.

### 验证 / Validation

- 前端：420 个测试通过，类型检查和生产构建通过。
  Frontend: 420 tests passed; type checking and production build passed.
- Rust：457 个测试通过，Clippy 严格检查通过。
  Rust: 457 tests passed; strict Clippy checks passed.
- MCP、SSH/SFTP、OTP、触发器、性能和 UI walkthrough smoke 全部通过。
  MCP, SSH/SFTP, OTP, trigger, performance, and UI walkthrough smoke tests all passed.

## [0.4.75] — 2026-09-15

发布地址 / Release: [ssh-v0.4.75](https://github.com/jinpy666/dbx-plugin-ssh/releases/tag/ssh-v0.4.75)

### 新增 / Added

- **触发器驱动的 SSH 认证流程**：支持 Expect 风格的终端触发器，可根据服务器输出匹配正则并发送文本、密钥槽位中的 secret，或执行本地命令；规则支持超时、等待间隔和条件回复。
  **Trigger-driven SSH authentication:** Added Expect-style terminal triggers that match regular expressions in server output and respond with text, secret-store values, or local commands, with timeout, delay, and conditional-response support.

- **外部凭据命令**：新增 `password_command` 和 `passphrase_command`，可在连接时从本地密码管理器或脚本获取登录密码、私钥口令；显式配置的凭据优先于命令结果。
  **External credential commands:** Added `password_command` and `passphrase_command` for retrieving login passwords and private-key passphrases from a local password manager or script at connection time; explicit credentials always take precedence.

- **系统剪贴板文件上传**：聚焦 SFTP 面板后，可使用 Ctrl/Cmd+V 将系统剪贴板中的本地文件直接上传到当前远程目录；Upload 按钮和拖放上传继续可用。
  **Native clipboard file uploads:** With the SFTP panel focused, Ctrl/Cmd+V can upload local files from the system clipboard into the current remote directory. The Upload button and drag-and-drop flow remain available.

- **SSH 算法兼容策略**：新增 `secure`、`compatible` 和 `legacy` 三种策略，分别用于严格安全连接、兼容 SHA-1 MAC 的旧服务器，以及需要更老旧 KEX/CBC 算法的服务器。
  **Configurable SSH algorithm policies:** Added `secure`, `compatible`, and `legacy` profiles for strict security, older servers requiring SHA-1 MACs, and legacy KEX/CBC compatibility.

- **下载完成后的本地操作**：下载记录现在可以直接打开文件或在文件管理器中定位，减少终端、文件管理器之间的切换。
  **Post-download local actions:** Completed downloads can now be opened directly or revealed in the system file manager, reducing context switching after transfers.

### 改进 / Improved

- 连接表单、生命周期参数和 MCP 连接参数统一支持触发器、外部凭据命令和 SSH 算法策略，配置行为保持一致。
  Connection forms, lifecycle parameters, and MCP connection arguments now share the same support for triggers, external credential commands, and SSH algorithm policies.

- 跳板机连接会继承 SSH 算法策略，避免多跳连接在中间节点上出现不一致的协商行为。
  ProxyJump connections inherit the SSH algorithm policy so multi-hop sessions negotiate consistently across intermediate hosts.

- 兼容模式仍将安全算法置于优先位置，只在必要时追加兼容算法；未知策略值会回退到更严格的 `secure` 配置，不会意外开启 legacy 算法。
  Compatible mode keeps secure algorithms first and only appends compatibility algorithms when needed; unknown policy values fail closed to the stricter `secure` profile instead of enabling legacy algorithms unexpectedly.

- MCP 工具描述补充了新参数、认证流程和安全边界，便于 DBX MCP 桥及其他 MCP 客户端正确发现和调用。
  MCP tool descriptions now document the new parameters, authentication flows, and safety boundaries so the DBX MCP bridge and other MCP clients can discover and use them correctly.

### 修复 / Fixed

- 修复下载完成后只能看到路径、无法从插件界面继续操作的问题。
  Fixed the post-download workflow where users could see the saved path but could not continue with a local file action from the plugin UI.

- 修复非法触发器配置可能被静默忽略的问题；无效 JSON、无法编译的正则、未知 secret 槽位和超出限制的规则现在会在连接阶段明确失败。
  Fixed invalid trigger configurations being silently ignored; malformed JSON, uncompileable regular expressions, unknown secret slots, and oversized rule sets now fail clearly during connection setup.

- 修复密码认证在使用外部密码命令时仍要求填写静态密码的问题。
  Fixed password authentication continuing to require a static password when an external password command is configured.

- 加强本地文件打开入口的路径校验：只有本插件已记录且成功完成的下载文件才允许通过插件操作系统接口打开，避免按钮成为任意本地路径打开入口。
  Hardened local-file actions so only files recorded as successfully completed downloads by this plugin can be opened through the plugin's OS integration, preventing the action from becoming an arbitrary local-path opener.

### 安全与兼容性 / Security & Compatibility

- 触发器发送的 secret 通过 DBX secret binding 解析，不写入普通配置、日志或 MCP 参数；服务器输出可能诱导触发器匹配，请只对可信服务器启用自动回复。
  Trigger secrets are resolved through DBX secret bindings and are not written to ordinary configuration, logs, or MCP arguments. Because server output can intentionally influence matching, enable automatic responses only for trusted servers.

- 新增能力要求 DBX `>=0.5.77` 和 Host API `>=1.0.0`。
  The new capabilities require DBX `>=0.5.77` and Host API `>=1.0.0`.

- 本版本保持现有 SSH/SFTP 连接配置兼容；未配置算法策略时使用 `compatible` 默认行为，现有连接无需迁移。
  Existing SSH/SFTP connection configurations remain compatible. Connections without an explicit algorithm policy use the `compatible` default and require no migration.

### 验证 / Validation

- 前端：420 个测试通过，类型检查和生产构建通过。
  Frontend: 420 tests passed; type checking and production build passed.

- Rust：456 个测试通过，格式检查、Clippy 和锁定依赖构建通过。
  Rust: 456 tests passed; formatting, Clippy, and locked-dependency builds passed.

- 发布包：Linux x64/arm64、macOS x64/arm64、Windows x64 均已构建并上传。
  Release packages: Linux x64/arm64, macOS x64/arm64, and Windows x64 were built and uploaded.

## 历史版本 / Previous releases

- [GitHub Releases](https://github.com/jinpy666/dbx-plugin-ssh/releases)
