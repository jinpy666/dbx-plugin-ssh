# Changelog

本文件记录终端（Terminal）的面向用户的版本变更。除非另有说明，版本日期以 GitHub Release 发布日为准。

This file records user-facing changes for Terminal. Unless noted otherwise, version dates follow the corresponding GitHub Release.

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
