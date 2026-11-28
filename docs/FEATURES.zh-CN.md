# 功能指南

本文按工作台区域说明插件实际提供的能力、用户能看到的行为，以及每条能力的**边界**。
内容以当前分支的 `manifest.json`、`backend/src`、`frontend/src` 为准；协议细节见
[PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)，逐项能力对标见
[FEATURE_PARITY.zh-CN.md](FEATURE_PARITY.zh-CN.md)，安装与构建见仓库根 `README.md`。

> 判断「有没有这个功能」的方法：先看本节的「行为」，再看「限制」。文档里出现但
> 代码里找不到的能力不会写进本文；已知的文档/代码偏差集中在文末「已知限制」。

## 连接

### 六种会话

连接入口由 manifest 的 `connection-provider` 决定：`io.dbx.ssh.connection`（SSH /
Telnet / VNC / Serial / RDP 五选一）、`io.dbx.ssh.local`（本机 Shell）、
`io.dbx.ssh.vnc` 与 `io.dbx.ssh.rdp`（按协议独立的连接类型）。

| 协议 | 入口 | 建链方式 | 默认端口 | 关键配置 |
| --- | --- | --- | --- | --- |
| SSH | `SSH server`，协议选 `ssh` | russh SSH 传输 | 22 | 认证方式、私钥/密码、sudo、保活、启动命令 |
| Telnet | `SSH server`，协议选 `telnet` | TCP 直连（RFC 854/855 子集） | 23 | 主机、端口、用户名/密码；连接弹窗另选退格模式 |
| VNC | `SSH server` 协议选 `vnc`，或 `VNC` 连接类型 | TCP 直连（RFB） | 5900 | 主机、端口、密码 |
| Serial | `SSH server`，协议选 `serial` | sidecar 所在机器的串口 | — | 设备、波特率、数据位、校验、停止位、退格 |
| RDP | `SSH server` 协议选 `rdp`，或 `RDP` 连接类型 | TCP 直连（RDP） | 3389 | 主机、用户名/密码/域、分辨率、证书策略、剪贴板 |
| 本机 Shell | `Local shell` | 本机 PTY，无网络、无凭据 | — | Shell 路径、启动目录、环境变量 |

表单字段按协议显隐（manifest `visible_when`）：切到 Serial 会隐藏主机/端口，
切到非 SSH 会隐藏认证、sudo、2FA 等 SSH 专属字段。Telnet/VNC/Serial/RDP 的会话
视图在各自协议面板里，不与 SSH 终端工具条混用。

**限制**：Telnet 是明文协议；Serial 只能连 sidecar 所在机器的设备（不支持远端
串口服务器，除非操作系统把它映射成本地设备）；VNC/RDP 都不做音频。

### SSH 认证

| 认证方式 | 行为 |
| --- | --- |
| `password` | 使用表单密码或本地命令取密码 |
| `private-key` | 使用私钥路径或粘贴内容 |
| `private-key-password` | 私钥 + 口令（口令可来自表单或本地命令） |
| `agent` | 使用 `SSH_AUTH_SOCK`，可单独指定 socket |
| `auto` | 按序尝试各方式，直到一种成功 |
| `none` | 服务器允许无认证登录时使用 |

- 私钥支持 OpenSSH / PEM / PPK 头；**粘贴的内容优先于路径**（`ssh.rs`
  `resolve_private_key`：内容非空即用内容），加密私钥可配合口令使用。
- 密码来源两种：`direct`（存宿主 secret store）与 `command`（本地命令）。
  本地命令在 sidecar 所在机器执行，10 秒超时、输出上限 4 KiB、**只去掉一个末尾
  换行**；命令本身与输出都不写日志，失败时回落到空密码继续走正常认证失败流程。
- 认证方式只以名称回显（`ssh/sessions/list` 的 `authMethod`），前端拿不到凭据。

**限制**：没有「每次连接都询问密码」的交互式模式；密码要么存起来，要么由本地
命令在拨号时取。

### 双因素（2FA / OTP）

- 支持键盘交互式挑战与 TOTP；连接表单有「2FA 认证流」四档：`off`、
  `password_then_otp`、`password_plus_otp`、`password_only`，用于适配「先问验证码」
  与「密码+验证码合并成一条提问」两类主机。
- OTP 管理面板（SFTP 侧栏的 `OTP` 页）：新增条目、二维码导入、生成当前码、
  复制、发送到终端、绑定到连接、删除；支持 TOTP 与 HOTP，显示剩余秒数，
  同一窗口内已用过的码会提示「本窗口已使用」。
- 连接配置里也可直接填 TOTP 密钥（每行一个），Quick Sudo 阶段可自动应答。
- MCP 的 `ssh_exec_sudo` 在配置了 TOTP 时同样可自动应答 sudo 的验证码提示。

**限制**：OTP 条目存在 sidecar 侧，绑定按 `connectionId`；删除条目会让已绑定的
连接失去自动应答，需重新绑定。

### 跳板、保活与 Known Hosts

- **跳板链**来自 `external_config.jump_hosts`，最多 3 跳，每跳独立配置
  host/port/username/authentication 与凭据，可选 TOTP；每跳主机密钥独立校验。
  **当前连接表单没有跳板字段**——跳板只能由宿主/导入的会话配置提供，或在 MCP
  的 `jumpHosts` 参数里给出；手工新建的连接无法在 UI 里加跳板。
- 协议层保活：`keepalive_interval_secs` 默认 30 秒，`0` 关闭；连续 3 次无应答判定
  连接死亡并进入重连。终端活动保活：`terminal_keepalive_secs` 默认 0（关闭），
  非 0 时钳制在 5–3600 秒，按间隔向 PTY 注入「空格+退格」的净零输入。
- 主机密钥：首次连接未知主机会弹出指纹确认；确认后写入**插件自己的**
  `<data_dir>/known_hosts`，不修改系统 `~/.ssh/known_hosts`；密钥变化直接拒绝。
  设置 → 安全与密钥里可查看指纹并删除旧记录。
- MCP 独立 stdio 模式对未知主机使用 TOFU（首次信任），记录后变化仍拒绝。

**限制**：拒绝变化后的主机密钥没有「本次仍然连接」入口，只能先在设置里删除旧
记录再连；跳板链没有图形化编辑器（见上）。

## 终端

### 会话、标签与分屏

- **标签页由 DBX 宿主提供**，插件在一个标签里渲染一个工作台会话。会话菜单可
  「新建会话」（重新认证，堡垒机可再次要求 MFA）或「复制会话（复用登录）」
  （在当前已认证的 SSH transport 上新开 PTY，不重新认证）。
- 工作台内可分屏，**最多 3 个分屏**，每个分屏独立 PTY；分屏只支持 SSH 会话。
- 「镜像会话」可挂载其他工作台里存活的会话作为副屏，直接复用该会话的 PTY
  （可输入）；关闭副屏不会关闭源会话，适合对照排障。

**限制**：复制会话会多占一个 SSH channel，受服务端 `MaxSessions` 限制
（OpenSSH 默认 10）；超过时新会话打开失败。

### 输出与输入

- 渲染用 xterm.js，启用 WebGL、Unicode 11、内联图片、链接、搜索、fit 等 addon。
  **连字（ligature）不支持**：对应 addon 未引入（依赖 Node 侧 opentype.js）。
- 输出按「流类型 + 大端 u64 序号 + 数据」分帧；前端发现序号缺口会停止乱序输出并
  调 `ssh/terminal/replay` 补发；补发缓存是 2 MiB 环形缓冲。
- 输入带序号确认；写入失败会收到错误事件，前端按传输断开处理并进入有界退避
  重连，不会假装仍在线。
- 断线后按退避梯子自动重连，状态显示在连接卡片/状态条；webview 重载后可通过
  `ssh/session/attach` 接回存活会话。

**限制**：洪峰输出超过 2 MiB 补发缓存时，缺口可能永远补不齐，此时前端会提示
「部分输出被丢弃，已跳到最新输出」，会话保持连接但中间内容不可恢复。

### 搜索、快速选择与历史

- 终端搜索：`⌘F`（Windows/Linux 为 `Ctrl+Shift+F`）打开搜索面板，支持上一个/
  下一个、大小写、正则、整词匹配。
- 快速选择：从可视区抽取 URL、路径、IPv4、哈希，逐项点击复制。
- 命令历史：`↑` 浏览、历史面板回填、批量重发；默认保留 100 条，可配置 10–1000；
  历史按连接作用域隔离，并可从远端 shell 历史文件回填。

### 关键词高亮

- 规则字段：pattern、是否正则、颜色（`#rrggbb`）、大小写敏感、启用开关；
  支持整行/文字两种显示模式，总开关默认开。
- 上限：30 条规则、单条 pattern 200 字符、单行最多 20 个高亮命中。
- 首次运行会从 sidecar 种子导入 22 条默认规则（ERROR/FATAL/Permission denied/
  command not found 等）。

**限制**：正则合法性在前端保存时校验，sidecar 只校验形状；因此绕过前端直接写
存储可能留下编译失败的正则（会被静默丢弃，不会崩）。

### 快速命令

- 保存常用命令，支持分组、搜索、运行（发到当前会话）与粘贴（只填入不执行）。
- 上限 200 条，可导入 Tabby 片段或 `{name, command}` JSON；同名（不区分大小写）
  跳过，超出上限按输入顺序取前 N 条。
- 批量发送栏里可以把刚发送的命令直接存为快速命令。

**限制**：帮助文案仍写「达到 20 条上限」，实际代码上限是 200
（`frontend/src/lib/quickCommands.ts` 的 `QUICK_COMMANDS_LIMIT`）。

### 批量输入

- 把同一条命令写入多个**已打开**会话的交互终端，目标可以是全部、仅存活或当前
  会话；输出回显在各自终端里，`cd`/`env` 等状态留在各自 shell。
- 命令归一化 `\r\n`/`\n`/`\r` 为回车，归一后上限 256 KiB，默认末尾补回车。

**限制**：方法只返回「发送结果」，不收集远端输出与退出码；命令不做 shell 转义，
等同于键盘输入；只读连接不拦截（与手敲一致）。

### ZMODEM 与 trzsz

- 远端 `sz` 下载会被前端自动接管（无需手敲确认）：识别 ZRQINIT 后自动确认并接收，
  进度覆盖层显示文件名/百分比/速度，可取消。远端 `rz` 上传走菜单入口。
- trzsz（`trz`/`tsz`）由 `trzsz` 过滤器接管，支持上传与下载、进度与取消。
- 落盘顺序三选一：宿主 `fileTransfer` 流式写入 → sidecar `local/saveFile`
  （受下载目录/冲突策略控制）→ 浏览器 `saveFile` 兜底。
- 下载文件名会净化（剥离路径、控制字符、Windows 保留名），防止远端构造路径穿越。

**限制**：ZMODEM 只能用于 SSH PTY（本地终端/串口/Telnet 未接检测器）；浏览器兜底
整包上限 512 MiB；会话录制文件会包含 ZMODEM/trzsz 的协议帧。

### 命令建议与补全

- 历史/快速命令的模糊建议、行内 ghost 自动建议、结构化补全三层。
- 结构化补全引擎三档：`off`（关闭结构化弹层，历史建议与 ghost 不受影响）、
  `fig-safe`（默认）、`fig`。**本版本 `fig` 与 `fig-safe` 行为相同**，generator 都
  通过 `completion/execute` 在目标机执行。
- 静态候选先显示，动态候选（如已加载的 SFTP 目录条目）异步补齐；Esc 关闭、
  Enter 恒定放行执行、Tab 接受静态候选，动态 hint 行 Tab 透传给远端 shell。

**限制**：补全层超时 1200 ms（200–3000 可调），超时即回落为静态候选；动态值
目前只覆盖「SFTP 面板当前目录已加载的条目」，不额外发起远端查询。

### AI 助手与智能体终端

- 依赖宿主 AI 能力（`capabilities.ai` 等）；**插件不持有任何 AI 配置或密钥**，
  provider/模型都在 DBX 设置里。
- 三个开关（`AI_SETTINGS_DEFAULTS` 实际默认值）：`#` AI 命令搜索 **关**、
  失败命令 AI 修复 **开**、热键唤起助手 **开**。
- `#` 在空提示符进入本地搜索模式，字节不进 PTY；回车把自然语言 + 连接 + cwd
  交给宿主 AI 面板。
- 失败修复会采集终端输出，首次发送前有快照预览与「不再询问」记忆位。
- 默认热键：AI 修复 `⌘/Ctrl+Shift+I`，唤起 AI 助手 `⌘/Ctrl+Shift+Y`（可在
  快捷键设置里改绑；宿主无 AI 能力时按键会给出可见降级提示）。
- 智能体终端模式（每连接 `off`/`auto`/`strict`）：AI/MCP 在执行命令前展示执行
  横幅并走审批；「记住的审批」可在设置里查看/删除。

**限制**：宿主能力缺失时入口降级/隐藏，只保留普通终端；AI 修复默认开启意味着
默认允许采集失败命令的输出（可在设置关闭）。

## SFTP 与文件

### 浏览

- 目录列表、隐藏文件开关、目录树、快捷路径、书签、路径历史、按名称/大小/时间
  排序、多选与键盘导航。
- 文件操作：新建目录、重命名、删除、chmod、touch、符号链接（创建/读取/更新）、
  复制/移动（远端内）、压缩/解压、磁盘用量。
- 文件名编码可选 `auto` / `latin-1`，支持按连接覆盖（老旧服务器乱码场景）。

**说明**：manifest 另外声明了宿主 `filesystem-provider`（`sftp` scheme），供 DBX
自己的文件面板访问同一远端文件系统；插件内嵌的 SFTP 面板走 `sftp/*` RPC。两条
路径看到的是同一台远端机器。

### 传输

- 上传/下载队列：并发 1–10（默认 3），会话级同时在传任务默认 3（1–8）；
  单文件上传/下载上限 16 GiB，分块 256 KiB，逐块确认。
- 冲突策略：重命名（默认）/询问/覆盖；批量上传可选择覆盖/重命名/跳过。
- 断点续传：上传用 `resumeTaskId` 复用已 spool 的分片，下载用 `offset` 续传；
  本地落盘下载不支持续传。
- 限速：下载限速 0–1048576 KiB/s（0 = 不限速），任务启动时快照，对下一个任务生效。
- 压缩传输：`auto`/`on`/`off`，阈值默认 64 MiB；低于阈值、扩展名黑名单、远端
  缺 gzip/tar、只读连接、latin-1 等条件会静默回退普通传输；压缩下载不支持续传。
- 多流下载：超过阈值（默认 256 MiB）时并发多流；阈值 0 关闭。
- 目录下载走递归树扫描；文件夹上传可整包归档上传；均有进度与取消。
- 传输历史持久化，可在面板里查看/清空。

**限制**：**没有目录双向同步（sync）功能**——不存在「镜像目录 / 双向同步」的
入口或 RPC；目录级操作是「整包上传」「递归下载」两种单向搬运。压缩下载不支持
续传；限速对 sudo 下载车道不生效。

### sudo 文件操作

- SFTP 面板可切到 sudo 模式，用 Quick Sudo 权限读取/写入 root 文件：
  stat、exists、listDir、readFile、writeFile、mkdir、remove、removeAll、chmod、rename。
- sudo 下载走独立分块车道；sudo 上传有独立 start/finish 流程。
- sudo 凭据来源：连接表单自定义、全局 Quick Sudo 配置或关闭；全局配置的密钥
  在 sidecar 侧字段级加密，回显只给「已设置」布尔值。

**限制**：只读连接拒绝所有 sudo 写操作；未配置密码且 `sudo -n` 失败时直接报错；
sudo 操作依赖远端 `sudo` 与常见 coreutils（`stat`/`dd`/`base64`/`ls`）。

### 预览与编辑

- 文本/代码用 CodeMirror 内联预览与编辑；JSON 有格式化视图；未知扩展按
  text/hex 启发式；图片、PDF、Office、表格、演示、OFD、思维导图等交给内嵌
  file-viewer。
- 大小边界：内联文本预览 1 MiB（超出先确认）、可直接保存编辑 4 MiB、图片预览
  20 MiB。
- 外部编辑器：按扩展名映射到本机编辑器，保存后由 watcher 自动回传远端。

**限制**：超过边界的文本只能截断预览，不能在面板内直接保存；归档文件没有专门的
「包内浏览」，按未知扩展处理。

## 端口映射

- 三种映射：`local`（-L）、`remote`（-R）、`dynamic`（-D，SOCKS5）。
- 终端右上角「管理端口映射」和连接右键「管理端口映射」打开同一界面；右键入口
  以宿主 dialog 承载，不创建标签页或 PTY。
- 映射以 `connectionId` 持有独立 SSH 传输，关掉终端不会断映射；最后一条映射停止
  或连接断开时释放传输。
- 保存的映射可在连接右键菜单里一键启动（单个或全部），也可在 Port forwards
  工作台里管理。

**限制**：映射是运行时状态，不落盘、不跨 DBX 重启恢复；`-D` 只支持无认证的
SOCKS5 CONNECT（BIND/UDP ASSOCIATE 拒绝）；本地监听通配 `*` 被拒绝。

## 运维面板

### 服务器指标（单会话）

- 指标面板每 5 秒刷新：概览（CPU/内存/磁盘/负载/运行时长）、进程（CPU 与内存
  各取前 8，可搜索、排序）、磁盘、网络、Docker。
- GPU/NPU 卡片：NVIDIA `nvidia-smi` 与昇腾 `npu-smi` 可用时显示。
- 进程可终止（`ssh/processes/kill`，PID > 1；面板提供 TERM(15)/KILL(9) 两档），
  只读连接拒绝。
- 指标历史存 JSONL，可用于趋势图。

**限制**：Linux 用 `/proc`，macOS 走 sysctl 等回退，部分字段可能为空；GPU/NPU
依赖远端 CLI 与驱动，不支持时整块隐藏。

### 设置分类检索

- 设置弹窗左侧导航顶部有搜索框：按分类名（本地化文案）、分类 id、labelKey
  匹配，空白分词 AND；命中保持导航原序，输入即切到首个命中分类，清空不改当前
  分类。会话级分类（sudo / agent）在本地终端先被门控隐藏，不参与检索。

### 多机监控面板

- 独立 `Monitor` 工作台：多台 SSH 服务器的实时卡片，支持隐私模式、刷新间隔、
  状态过滤（全部/存活/异常）、分组与组色。
- **卡片检索**：搜索按空白分词 AND，匹配主机名/数据库类型/分组名/连接 id，标识
  字段另支持子序列模糊；与状态筛选叠加生效，无命中时给出专门的空因文案（而非笼统
  的空组），纯本地过滤、零 RPC。
- 数据来自常驻流式采集（每连接一条长 exec，每秒样本），不需要反复建链。

**限制**：常驻采集只支持 Linux `/proc`，其他平台显示为 unsupported；分组需要宿主
`listConnections` 返回 `groupId`/`groupName`，宿主不提供时退化为单一平铺列表；
监控卡片需要会话存活，断线后显示 gap。

### Docker 面板

- 容器列表（名称/镜像/状态/端口）、一次性日志、启动/停止/重启/终止/删除。
- **列表搜索与筛选**：搜索按空白分词 AND，匹配名称/镜像/ID/状态/端口，标识字段
  （ID/名称）另支持子序列模糊（`31b4` 可命中 `3f2a1b4c5d6e`）；状态筛选 all /
  running / stopped，搜索时显示命中/总数；纯前端本地过滤，不发 RPC。
- **实时指标**：`docker/stats` 一次批量采样 CPU/内存/网络/块设备/PID（1–50 个容器），
  只读；速率由 sidecar 用同一采样键做差分（窗口 <250ms 记 0），旧 payload 缺速率时
  前端用上一帧自算。CLI 缺失或 daemon 不可达时返回 `available:false`，不报错。
- **指标趋势**：面板打开期间客户端保留最近 3 分钟（60 点 × 3s）的 CPU/内存/网络总量
  曲线，画在指标条内（CPU/内存固定 0–100% 轴，网络按窗口峰值）；换容器集合即清空，
  不持久化、不新增 RPC。
- **日志跟随**：抽屉内 `docker logs -f`，走二进制帧（stdout/stderr 分流），
  64 KiB / 100 ms 任一到达即 flush，回压时阻塞读循环、不丢行；单 sidecar 最多 8 条，
  30 分钟或 20 MiB 先到者自动停并回收子进程；桥接不支持二进制时降级为 16 KiB JSON chunk。
- **容器文件**：工作台「文件」页签浏览目录（最多 500 条，NUL 分隔 + 文件名 base64）、
  本地搜索（空白分词 AND、大小写不敏感名称匹配）与预览文件（缺省 1 MiB，上限 8 MiB）。只读操作，权限等同 `docker exec`，不做 chroot 语义。
- **容器终端**：工作台「终端」页签直接 `docker exec -it` 起 PTY；输入带 8 字节序号、
  2 MiB 回放环形、resize 钳 2..500 / 2..300。只读连接直接拒绝；需要提权时**绝不**把
  sudo 密码注入 PTY（无预热时间戳报错，有预热只用 `sudo -n`）；打开前写审计意图行。
- 引擎可选 docker 或 podman，可配 CLI 名、unix socket 或 TCP 端点；支持本机与
  远端两种目标。
- 动作走固定白名单 + 容器 id 校验，执行前写审计；远端只读连接直接拒绝；
  需要提权时复用 Quick Sudo 管线，密码不进命令行。

**限制**：不调用 Docker daemon API，只驱动目标机上的 CLI；目标机没有 docker/podman
时面板不可用；Windows 主机走 cmd 回退采集，字段可能少于 Linux。文件面要求容器内有
POSIX `sh`、`base64`、`wc`、`head`、`tr`（distroless 容器不可用）；文件写上限 64 KiB；
日志流与容器终端各最多 8 条并发。

### 会话录制

- 每个会话可开始/停止录制，输出写成 asciicast v2（`.cast`，JSONL，只记录输出，
  不记录输入）；支持自动录制偏好。
- 录制列表支持搜索（名称或内容）、回放、导出 GIF（500ms/帧，最多 120 帧，约
  60 秒）、导出文本记录、删除/清空。

**限制**：只录输出流；回放依赖已保存的 `.cast`；GIF 导出有时长上限（约 60 秒）。

### 告警分诊与执行审计

- 告警分诊：粘贴 JSON 或纯文本告警 → 归一化 → 八类关键词分类 → 给出只读诊断命令，
  可一键发送到当前终端。**不做 LLM 推理**，只做规则分类。
- 执行审计：`audit-log.jsonl` 追加记录命令执行、Docker 动作等，可在面板按类型/
  结果筛选并清空。

## 自动化与集成

### MCP

- 两种接入：DBX MCP 桥（推荐，凭据由宿主按连接注入）或独立 stdio
  （`dbx-plugin-ssh --mcp`）。
- 工具面 **16 个**：`ssh_exec`、`ssh_exec_sudo`、`ssh_multi_exec`、
  `ssh_terminal_input`、`ssh_run_bg`、`ssh_task_status`、`ssh_close`、
  `ssh_list_known_hosts`、`ssh_list_connections`、`ssh_remove_known_host`、
  `sftp_list_dir`、`sftp_stat`、`sftp_upload`、`sftp_download`、`sftp_read_file`、
  `sftp_write_file`。
- 每个工具在 manifest 里声明 `access`（read/write/full）；桥模式还要过宿主的
  「懒模式 + 插件 grant + access ceiling」三关。
- 尺寸策略可调：`mcp/settings/*` 的读取默认 256 KiB（上限 8 MiB），上传/下载上限
  2 GiB；`localTransferRoot` 限制本地传输根。
- 运维级只读开关：`DBX_SSH_MCP_READ_ONLY=1` 让整个进程强制只读。

**限制**：MCP 工具面刻意小于工作台 RPC 面（会话/面板类方法不暴露）；桥模式在
旧宿主上不可见；独立 stdio 模式的未知主机走 TOFU；`README.md` 写的「31 个工具」
是过期数字，实际是 16 个。

### 调度任务

- 通过 `task/*` 固定 RPC 提供远端/本机命令任务（validate/execute/start/stop/status），
  由宿主的调度器调用；本机目标使用 `Local shell` 连接。

### 会话导入

- 支持 8 种来源：MobaXterm（`.mxtsessions`）、Xshell（`.xts`）、WindTerm
  （`.sessions`，可带 `user.config` 与主密码）、SecureCRT（`.xml`）、FinalShell
  （`.zip`）、Electerm（`.json`）、Termius（`.json`）、OpenSSH `ssh_config`。
- 文件按二进制通道分块上传（256 KiB/块），总预算 64 MiB；解析后进入预览步骤，
  显示每条会话与「是否携带凭据材料」的标注，可导出脱敏 JSON。

**限制**：这一步是**预览/脱敏导出**，不会直接创建 DBX 连接（源码里没有创建连接的
调用）；`ssh_config` 的 `Include` 不跟随、`ProxyJump`/`ProxyCommand` 只标注
「需手动映射」，绝不执行外部命令；密码与私钥原文不会出现在导出里。

## 设置与外观

- 设置分 13 类：外观、配色方案、终端、建议、高亮、快速命令、AI、快捷键、Quick
  Sudo、智能体、传输、安全与密钥、MCP。
- 终端外观：主题跟随宿主，可选配色方案、背景/壁纸、字体与字号、光标样式、
  渲染方式；支持导入终端配色。
- 终端分类：WebGL 开关、X11 转发开关、实验性 RDP 开关、会话自动录制、连接级
  启动命令。
- 安全与密钥：known_hosts 列表与删除、本机密钥发现。
- 七种界面语言：`en`、`es`、`it`、`ja`、`pt-BR`、`zh-CN`、`zh-TW`；manifest 与
  工作台文案分两套本地化表。

**RDP 的门控方式**（实测）：偏好 `rdp_experimental_enabled` 默认 `false`；设置 →
终端 →「实验性 RDP」打开后，`rdp/start` 才会通过前置检查，否则直接返回
「rdp/start is disabled until experimental RDP is explicitly enabled」。连接表单里
RDP 协议标注为 experimental。

## 已知限制

以下每条都能在代码或现有文档中定位，按影响面排序：

1. **RDP 是实验能力**：默认关闭、需在设置里显式启用；只有文本剪贴板（16 MiB），
   不做音频、驱动器重定向、键盘捕获、网关/RDCleanPath、UDP 传输、Kerberos；
   运行中改分辨率是「按新尺寸重连」，不是无缝 resize。
2. **VNC 认证是 classic VNC-Auth**：密码超过 8 字节直接拒绝；编码只支持 ZRLE + Raw，
   服务端只发 Tight/JPEG 时连接失败；帧缓冲上限 3840×2160；剪贴板 1 MiB；无音频。
3. **Telnet 明文且是子集**：RFC 854/855 子集 + NAWS；自动登录依赖提示符正则，
   提示符不匹配时需要手填登录；没有加密。
4. **串口只能连本机设备**：sidecar 必须运行在拥有串口的机器上；同一会话同一时刻
   只允许一个 X/Y/ZMODEM 文件上传，上传期间键盘输入被拒绝；串口回放只有 128 KiB。
5. **本地 Shell 没有 SSH 专属能力**：sudo、智能体、会话级设置对本地终端隐藏；
   Windows ConPTY 仍有上游兼容风险（首个握手黑屏问题已由尺寸代答修复）。
6. **分屏仅 SSH、最多 3 个**；镜像会话复用源会话的 PTY（可输入），关闭副屏
   不影响源会话。
7. **终端补发缓存 2 MiB**：洪峰溢出的输出不可恢复，只能跳到最新；连字不支持。
8. **ZMODEM 仅 SSH PTY**：本地终端/串口/Telnet 不检测；浏览器兜底整包 512 MiB；
   录制文件会包含协议帧。
9. **监控面板只支持 Linux 常驻采集**；其他平台显示 unsupported；分组依赖宿主
   `listConnections` 的 `groupId`，缺失时平铺。
10. **Docker 面板依赖目标机 CLI**（docker/podman），不直连 daemon；Windows 字段
    较少；动作是固定白名单。
11. **MCP 只有 16 个工具**，工作台 RPC 不全部暴露；桥模式需要宿主 grant；
    `README.md` 的「31 个」已过期。
12. **AI 需要宿主能力**：`capabilities.ai` 缺失时入口降级；插件不存密钥；
    失败修复默认开（会采集失败命令输出），介意隐私需手动关闭。
13. **补全的 `fig` 与 `fig-safe` 本版本等价**；动态候选只来自已加载的 SFTP 目录；
    超时 1200 ms。
14. **导入不建连接**：只解析、预览、导出脱敏 JSON；64 MiB 预算；`ssh_config` 的
    Include/ProxyJump 不自动跟随或执行。
15. **没有目录双向同步**：SFTP 只提供单向的目录上传/递归下载，不存在 sync 命令。
16. **快速命令帮助文案与实际上限不一致**：文案写 20 条，代码上限 200 条。
17. **录制只录输出**，GIF 导出最多约 60 秒（120 帧 × 500 ms）。
18. **X11 转发是 MVP**（模块注释自述）：默认关闭，需本机 X server 与显式开关。
19. **跳板链没有表单字段**：只能在导入的会话配置或 MCP 参数里提供，最多 3 跳。
20. **协议方法数会随批次增长**：`FEATURE_PARITY.zh-CN.md` 的「184 臂 / 185 名」是
    2026-09-26 的收口值，当前实测 206 臂 / 209 名。
