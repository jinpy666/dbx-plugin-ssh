# Changelog

本文件记录 DBX SSH Terminal 的面向用户的版本变更。除非另有说明，版本日期以 GitHub Release 发布日为准。

This file records user-facing changes for DBX SSH Terminal. Unless noted otherwise, version dates follow the corresponding GitHub Release.

## [Unreleased]

### 改进 / Improved

- **连接表单按分区组织，Sudo 与 2FA 不再被藏起来**：表单原先靠一个默认关闭的 `advanced_options` 开关收纳 12 个字段，sudo 与 2FA 都在里面——用户既找不到 MFA 配置（issue #17/#30 的结构性原因），打开开关后又面对一堵输入框。现在改用宿主的分区与卡片能力（`group` + `panel`）：外层是**页签**——**基本信息**（连接与认证凭据）、**身份与安全**（Sudo 凭据、2FA）、**高级选项**（终端与自动化、超时·保活·只读），页签内部再分成四个可折叠分区（分区标题改为整行浅底样式、右侧显示已填计数）：**Sudo 凭据**（默认展开）、**2FA**（默认展开）、**终端与自动化**（默认折叠）、**超时、保活与只读**（默认折叠），全局开关退役。页签与分区标题都常显并显示已填数量（如 `1/5`），折叠状态按会话记忆，明细字段仍按来源/模式按需展开（选「自定义」才出现 sudo 密码、请求 PTY、白名单；选 OTP 模式才出现 TOTP 密钥与提示词）。`sudo_source` 默认保持「自定义（本连接）」——空 sudo 密码的语义是回退登录密码，改默认会静默关掉"用登录密码应答 sudo 提示"，因此只调整展示、不改行为。另把「全局 Quick Sudo 配置」选择器从纯下拉改为**可输入 + 可选择的建议控件**（`options_style: "suggest"`），profile id 既能手输也能从列表选。七语补上分区标题。
  **The connection form is organized into sections, and Sudo/2FA are no longer hidden.** The form used to park twelve fields behind a default-off `advanced_options` switch - sudo and 2FA among them - which is why users could not find the MFA setup (the structural cause behind issues #17/#30) and why turning the switch on revealed a wall of inputs. It now uses the host's `group` + `panel` capabilities: an outer **tab strip** - **Basic information** (connection and credentials), **Identity & security** (Sudo credentials, 2FA) and **Advanced options** (terminal/automation and limits) - each tab wrapping its collapsible sections, whose headings are now full-width muted rows with the filled count on the right: **Sudo credentials** (expanded), **2FA** (expanded), **Terminal & automation** (collapsed) and **Timeouts, keepalive & read-only** (collapsed), with the global switch retired. Tab and section headings are always visible and report how many of their fields are filled (`1/5`), folding is remembered per session, and detail fields still open on demand (Custom reveals the sudo password/PTY/allowlist; an OTP mode reveals the TOTP secret and prompt hints). `sudo_source` keeps its historical `custom` default - an empty sudo password falls back to the login password, so changing the default would silently disable that - and the global Quick Sudo picker became a typable suggestion field (`options_style: "suggest"`) so a profile id can be typed or picked. Section labels are localized in all seven languages.

- **私钥路径恢复「可手输」，密钥下拉不再撑长**：`private_key_path` 去掉 `options_action`——声明它会让宿主把字段渲染成纯下拉（无法输入路径），与宿主隧道密钥字段（输入框 + 浏览）体验不一致，也会让 `~/.ssh` 之外的密钥没法录入。现在字段保持普通输入框，选择交给宿主内置本地密钥建议器（桌面端）与「选择文件…」按钮（桌面选路径 / Web·Docker 上传到「私钥内容」）。`keys/discover/options` 保留为后端能力，label 由 `文件名 · 算法 · [已加密] · SHA256:指纹` 改为**路径本身**，避免下拉控件被长文本撑开；算法与指纹仍在 `keys/discover` 返回值里。
  **Private key path is typable again, and the key dropdown stops stretching.** `private_key_path` no longer declares `options_action` - that made the host render a select-only control (no manual input), which neither matched the host's own tunnel key field (text input plus browse) nor allowed keys outside `~/.ssh`. The field stays a plain input; selection comes from the host's built-in local-key suggestion list (desktop) and the file button (desktop picks a path; Web/Docker uploads into the pasted-key field). `keys/discover/options` stays a backend capability, and its label is now the key path itself instead of `basename · algorithm · [encrypted] · SHA256:fingerprint`, so the control is no longer stretched by long text; algorithm and fingerprint remain in `keys/discover`.

- **连接表单私钥录入新增「选择文件」通道**：`private_key_path` 现声明宿主 `picker`（Host API 1.1）——桌面端用原生对话框选择任意位置的私钥（写回绝对路径），Web/Docker 没有客户端文件系统时同一个按钮降级为上传，把文件内容写入「私钥内容」（secret 槽位）并清空路径。与原有的发现下拉、粘贴内容并存；路径与内容互斥（选文件会清掉已粘贴/上传的内容，反之亦然），不会出现"重新选路径后旧上传仍在生效"。刻意不声明扩展名过滤，避免 `id_rsa` / `id_ed25519` 这类无扩展名密钥在原生对话框里被置灰。注意：该属性只在认识它的宿主发行版上能解析（旧宿主 `deny_unknown_fields` 会拒绝整份 manifest），发布前需把 `engines.dbx` 抬到该发行版；走上传通道时私钥内容会复制到服务端连接密钥库。
  **Connection form private key: file picker channel.** `private_key_path` now declares the host `picker` (Host API 1.1): the desktop opens a native dialog and keeps the chosen absolute path, while Web/Docker builds — which have no client filesystem — turn the same button into an upload that writes the file content into the pasted-key field and clears the path. It stacks on top of the discovery dropdown and pasting, and path/content stay exclusive (choosing a file clears the pasted or uploaded copy and vice versa). No `accept` filter on purpose, so extension-less keys such as `id_rsa` / `id_ed25519` stay selectable. The attribute only parses on a host release that ships it (older hosts reject the manifest via `deny_unknown_fields`), so `engines.dbx` must be raised to that release before publishing.

### 修复 / Fixed

- **登录期 MFA（JumpServer / 堡垒机）**：`先密码，再 OTP` 在"密码或公钥先被服务器接受、再用 keyboard-interactive 问 MFA"的流程下不再把 OTP 提问留空；提问识别覆盖 koko 的 `[OTP Code]: ` 与 `Please Enter MFA Code.`，密码提示词也不会再劫持 OTP 提问（把登录密码当验证码回给服务器）；私钥 / SSH Agent 的 partial success 会续答 MFA，不再直接报"认证被拒"。登录提问的密码半边固定为登录口令（不再误用单独的 sudo 口令），`global` 模式下登录期 MFA 也能读到全局 Quick Sudo 配置的流程模式与 TOTP 密钥。认证失败信息会点名服务器提问并指路 2FA 配置。新增 `scripts/smoke_login_mfa_test.py`：10 个组合场景（四种提问形态 × 密码/私钥/全局配置 × 流程模式）端到端回归（issue #17 / #30）。
  **Login-time MFA (JumpServer / bastion hosts):** `Password first, then OTP` no longer leaves the MFA question blank when the password or public key is accepted first and keyboard-interactive follows; prompt recognition covers koko's `[OTP Code]: ` and `Please Enter MFA Code.`, a password hint can no longer hijack the OTP prompt (which used to send the login password as the code), and partial key / agent success continues into MFA instead of failing outright. Failure messages now name the server's prompt and point at the 2FA settings (issues #17 / #30).

- **合并提问（密码与验证码同一条）**：两种 OTP 模式都拼接成"密码+验证码"再回答（以前 `先密码，再 OTP` 只回密码半边，真正的合并提问必然失败）；终端内合并提问同样处理，`password_only` / `off` 仍只回密码半边。
  **Merged prompts (password and code in one question):** both OTP modes now answer with password + code concatenated instead of sending only the password half; the in-terminal watcher behaves the same, while `password_only` / `off` keep sending the password half alone.

- **连接表单 2FA 文案与顺序**：`Off` 选项改为"关闭（不自动应答 OTP）"（插件不提供手工输入通道，"手动输入"名不副实），2FA 说明补上选型指引（先问验证码/合并提问请选「密码与 OTP 组合」），TOTP 与提示词字段说明补上堡垒机示例与"填错字段不会生效"提示，OTP 提示词字段移到密码提示词之前；工作台设置弹窗同步加了一条 2FA 选型说明（七语）。
  **Connection form 2FA copy and field order:** the `Off` option is now "Off (never auto-answer OTP)", the 2FA description carries the selection guidance, the TOTP/hint fields mention bastion wording and the field-placement caveat, the OTP prompt field moved above the password prompt field, and the workbench settings dialog gained a 2FA selection hint (7 locales).

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
