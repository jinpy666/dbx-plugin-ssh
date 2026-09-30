# Changelog

本文件记录终端（Terminal）的面向用户的版本变更。除非另有说明，版本日期以 GitHub Release 发布日为准。

This file records user-facing changes for Terminal. Unless noted otherwise, version dates follow the corresponding GitHub Release.

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
