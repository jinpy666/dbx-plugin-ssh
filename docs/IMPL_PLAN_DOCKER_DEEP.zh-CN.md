# Docker 容器工作台实施计划（容器 PTY / 文件 / 日志流 / 指标）

- 基线：`34524afb0b8a92926ca8afec7d3c41f1e57df851`（分支 `codex/ssh/docker-plan`）
- 对象与体量（本 worktree `wc -l`）：`backend/src/docker.rs` **1,676**、`frontend/src/components/DockerPanel.vue` **1,137**、`docs/PROTOCOL.zh-CN.md` **1,542**、`frontend/src/mockDbxHost.ts` **2,194**、`backend/src/main.rs` **3,640**、`backend/src/ssh.rs` **12,829**。
- 任务边界：**仅文档**。不改 `backend/`、`frontend/`、`manifest.json`、`Cargo.lock`、`ui/`、`dist/`、版本号；不新增依赖；不 push；不安装 DBX。
- 行号口径：全部为基线文件坐标。批次执行后行号漂移，后续批次按**符号名**定位，不按旧行号（同 `docs/IMPL_PLAN_SSH_SPLIT.zh-CN.md:8` 的约定）。
- **参考实现不可用**：本环境不存在 `/tmp/remotex-probe`（`ls /tmp/remotex-probe` 报 no such file；全盘 `find -name shell_forward.rs` / `stream_registry.rs` 无结果）。因此本文只借用任务书给出的模块名（`engine`/`shell_forward`/`stream_registry`/`stream_batch`/`files/staging`/`stats_limits`/`scripts`）作为**职责清单**，不引用其行号、代码或 RPC 形状；所有落地设计均以本仓库证据为准。

## 0. 结论摘要

当前 Docker 面板是「列表 + 快照日志 + 生命周期动作 + 往输入行填一条 `docker exec` 命令」的只读巡检面板。要变成工作台，必须补齐四件事：**可交互的容器 PTY**、**容器文件浏览/读写**、**持续日志流**、**容器指标**。本仓库已有四套可复用的底座（终端帧/回放、PTY 泵、SSH 通道读循环、流任务配额），缺的不是能力而是接线与协议面；真正的硬约束是**结构预算**：`docker.rs` 与 `main.rs`、`DockerPanel.vue` 与 `App.vue` 都在冻结白名单里，新增代码前必须先瘦身（§3.3、§4.3）。

## 1. 现状差距表

| 能力 | 今天有什么（证据） | 差距 | 要改的代码 |
|---|---|---|---|
| 列表 + 轮询 | `docker/list` 分派 `main.rs:1488`；远端脚本 `docker.rs:235`、Windows 兜底 `docker.rs:247`、探针 `docker.rs:470`、七列解析 `docker.rs:485`、payload `docker.rs:566`；本机直呼 `docker.rs:750`/`828`；前端 10s 轮询、3 连败停轮询 `DockerPanel.vue:88-89`、一次采集 `DockerPanel.vue:217` | 无增量更新（每次全表重取）；无「刚被删/新起」的差异提示；轮询在面板隐藏时仍继续 | 前端抽出 `useDockerList` 组合式；后端无需改协议（可选 `docker/list` 返回 `generatedAt`） |
| 生命周期动作 | 白名单 `docker.rs:344`/`366`、命令文本 `docker.rs:385`/`393`、id 门 `docker.rs:405`；执行/审计/只读门 `main.rs:1651-1751`（意图行 `docker.rs:992`、失败行 `docker.rs:998`）；前端确认门 `frontend/src/lib/dockerActions.ts:16-32` | 无「动作后自动跟踪状态直到稳态」；无 pause/unpause（面板把 paused 只当徽标）；无批量动作 | 动作跟踪是纯前端轮询收敛（`lib/dockerActions.ts` 加 `terminalStates`）；pause/unpause 需扩 `DockerAction` + 白名单 + i18n（低风险） |
| 日志 | 仅快照：`docker/logs` 分派 `main.rs:1559`、脚本 `docker.rs:325`、payload `docker.rs:651`；tail 钳制 `docker.rs:419`；前端 Logs 抽屉 `DockerPanel.vue:416-450`、`<pre>` 直出 `DockerPanel.vue:710`；无 ANSI 处理 | **无 follow/流式**、无 ANSI 染色、无「暂停跟随/清屏/下载」、无 stderr 分流（`2>&1` 合并，见 `docker.rs:334`） | 新增流式通道（§2）；后端 `docker/logs_stream.rs`；前端 `useDockerLogStream` + 只读 xterm 视图 |
| 容器终端 | 只有**字符串填充**：`DockerPanel.vue:123-126` 生成 `docker exec -it <id> sh -lc '…'`，经 window 事件 `DockerPanel.vue:458`/`463` 交给 `App.vue:6160-6172` 写入现有 shell 输入行（不回车） | 没有容器会话：不申请 PTY、没有输入序号/回执、没有 replay、不校验只读连接、容器内 shell 退出后无状态帧；命令是**文本**而非结构化 argv | 新增 `docker/terminal/*` 与 `backend/src/docker/terminal.rs`；前端新窗格组件；删除旧字符串通道 |
| 容器文件 | 无。`docker.rs` 全文无文件操作；`docs/PROTOCOL.zh-CN.md` docker 节（`657-676`）无 files 方法 | 完全缺失：列目录、读、写、删；也没有「容器无 sh / 无 base64」的能力降级 | 新增 `docker/files/*` 与 `backend/src/docker/files.rs`；前端 `DockerFilesPane.vue` |
| 容器指标 | 无。全仓库无 `docker stats`（`grep -rn "docker stats" backend frontend docs` 空） | 缺 CPU/内存/网络/块 IO/PID；宿主指标面板 `MetricsPanel.vue` 是整机，不含容器 | 新增 `docker/stats` + `backend/src/docker/stats.rs` + 前端卡片 |
| 引擎设置 | 三参数 `cli/socket/host`：后端 `docker.rs:49-160`、环境变量下发 `docker.rs:167-207`；前端 `frontend/src/lib/dockerEngine.ts:1-127`；齿轮弹层 `DockerPanel.vue:141-163` | 新能力必须**全部**继承 engine 参数；终端/文件/流各自要重新解析一次（易漏） | 抽 `docker/rpc.rs` 统一 `parse_engine` + `parse_target`，新方法只接收已解析的 `EngineConfig` |
| sudo 兼容 | 列表提权重采 `main.rs:1533-1557`；日志提权 `main.rs:1626-1647`；动作提权 `main.rs:1718-1743`（权限签名 `docker.rs:664`，错误文案 `docker.rs:670`）；提权命令必须过连接级 sudoers 白名单 | 终端/文件/统计**没有** sudo 路径；PTY 里注入 sudo 密码会把密码写进容器会话/屏幕 | 明确策略：daemon 需 sudo 时终端拒绝（除非 sudo 时间戳已预热），文件/统计走与 logs 同款 `sudo -S` 提权（§5.5） |
| Podman | 全家族靠 `cli` 参数切引擎（`docker.rs:39-47`、`docs/PROTOCOL.zh-CN.md:664`）；`podman ps/inspect/logs/exec/stats` 命令形状兼容 | 新命令未验证；rootless podman 的 `exec` 需要用户命名空间，失败信息与 docker 不同 | 新脚本只用两引擎共有的子命令；错误归一（§5.6）；冒烟脚本加 `--cli podman` |
| Windows 远端 | 只有列表有 cmd 兜底（`docker.rs:247-268`，标记缺失即重试 `main.rs:1508-1524`） | 新能力全部依赖 POSIX `sh -c`，Windows 远端无 `sh` | v1 明确降级：新方法在 Windows 远端返回可读错误（§8）；不另写 cmd 采集器 |
| 只读连接 | 动作拒绝：`main.rs:1682-1684` 调 `ensure_writable`（`ssh.rs:4405-4411`）；日志/列表放行 | 终端（可在容器内改文件）、文件写/删尚未纳入门禁 | 终端 open、files write/delete 增加 `ensure_writable`；files read/list 放行 |
| MCP 面 | 已移除容器工具，改走 `ssh_exec`（`docs/PROTOCOL.zh-CN.md:676`） | 新能力不进 MCP（保持现状），避免扩大 AI 执行面 | 不改 `mcp.rs`；文档写明 |

## 2. 协议设计

命名与现有家族一致：`<域>/<动作>`，参数/返回 camelCase，同一族参数复用同名字段（`target`/`sessionId`/`cli`/`socket`/`host`/`containerId`）。现有三个方法见 `docs/PROTOCOL.zh-CN.md:659-676`；参数表见 `docs/PROTOCOL.zh-CN.md:661-666`。

### 2.1 新方法总表

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `docker/stats` | `target?`、`sessionId?`、`cli?`、`socket?`、`host?`、`containerIds: string[]`（1–50，逐项过 id 门） | `{available, needsSudo, sampledAt, stats: [{containerId, name, cpuPercent, memBytes, memLimitBytes, memPercent, netRxBytes, netTxBytes, blockReadBytes, blockWriteBytes, pids}]}` | 一次 `docker stats --no-stream --format` 批量取；未运行的容器被 CLI 跳过（按 `containerId` 缺省处理） |
| `docker/logs/stream/start` | 上述通用参数 + `containerId`、`tail?`（10–2000，缺省 200）、`timestamps?: bool`、`requestedStreamId?` | `{streamId, containerId, tail, binaryInput: true, startedAt}` | 立即返回，后台任务持续推送；`binaryInput` 是能力位（同 `serial/start` 先例 `docs/PROTOCOL.zh-CN.md:753`） |
| `docker/logs/stream/stop` | `streamId` | `{success: true}` | 幂等；未知 id 也返回成功 |
| `docker/terminal/open` | 通用参数 + `containerId`、`shell?`（`auto\|bash\|zsh\|fish\|ash\|sh`，缺省 auto）、`cols`、`rows`、`requestedTerminalId?`、`afterSequence?` | `{terminalId, containerId, shell, cols, rows, sequence, replay: [{sequence, dataBase64}]}` | `requestedTerminalId` 让前端在 RPC 返回前先订阅 `docker/terminal/out/{terminalId}`（同 `requestedSessionId` 先例 `docs/PROTOCOL.zh-CN.md:17`、`backend/src/model.rs:935-937`） |
| `docker/terminal/close` | `terminalId` | `{success: true}` | 幂等；先发 `docker/terminal/end` 再拆会话 |
| `docker/terminal/resize` | `terminalId`、`cols`、`rows` | `{success: true}` | 走会话内 resize 命令（同 `ssh/terminal/resize` 语义 `docs/PROTOCOL.zh-CN.md:57`） |
| `docker/terminal/replay` | `terminalId`、`afterSequence` | `{frameCount, firstAvailableSequence, tailSequence, complete}` | 与 `serial/replay` 完全同构（`docs/PROTOCOL.zh-CN.md:751`） |
| `docker/files/list` | 通用参数 + `containerId`、`path`、`showHidden?` | `{path, entries: [{name, path, kind: "file"\|"dir"\|"link"\|"other", size}], truncated}` | 最多 500 条；`size` 仅普通文件（`wc -c`），目录恒 0；无 mtime（§8） |
| `docker/files/read` | 通用参数 + `containerId`、`path`、`maxBytes?`（1–8 MiB，缺省 1 MiB） | `{path, dataBase64, size, truncated}` | 容器内 `base64 <path>`，Rust 侧解码；`truncated` 表示用户请求上限截断 |
| `docker/files/write` | 通用参数 + `containerId`、`path`、`dataBase64`（解码后 ≤64 KiB）、`overwrite?` | `{path, bytes}` | 写 `path.dbx-part` 再 `mv` 原子落位；`overwrite:false` 时先测存在 |
| `docker/files/delete` | 通用参数 + `containerId`、`path`、`recursive?`、`confirm: true` | `{success: true}` | `recursive` 时拒绝 `/`、空路径与含 `..` 的路径 |

通用参数定义沿用 `docs/PROTOCOL.zh-CN.md:661-666`：`target` 缺省 `"ssh"`，`"local"` 免 `sessionId`；`cli` 白名单 `[A-Za-z0-9_.\\/:/-]{1,256}`；`socket`/`host` 互斥。

### 2.2 二进制通道

| 通道 | 载荷 | 方向 |
|---|---|---|
| `docker/terminal/in/{terminalId}` | 8 字节大端 `u64` 序号 + 原始键序列（**与** `ssh/terminal/in`、`local/terminal/in` 同形） | 前端 → sidecar |
| `docker/terminal/out/{terminalId}` | 9 字节 `TerminalFrame`（1 字节流标签 + 大端 `u64` 序号 + 数据；`Stdout=0`；PTY 内 stderr 合流，故数据帧恒 0；`State=2` 仅生命周期文本） | sidecar → 前端 |
| `docker/logs/out/{streamId}` | 同上 9 字节帧，**保留 stderr 分流**（`Stdout=0` 容器 stdout、`Stderr=1` 容器 stderr、`State=2` 结束标记） | sidecar → 前端 |

帧定义与编码函数已存在：`backend/src/model.rs:859-874`（`TerminalFrame::encode`），流枚举 `backend/src/model.rs:877-887`。**不新造帧格式**，前端可直接复用现有解码/合帧/背压工具（§4）。

### 2.3 事件

| 事件 | 载荷 | 语义 |
|---|---|---|
| `docker/terminal/inputAck` | `{terminalId, sequence}` | 键入确认；**仅审计用，无重传语义**，与 `local/terminal/inputAck`（已记载：`docs/PROTOCOL.zh-CN.md:682`）同义；SSH 侧同名机制在 `backend/src/main.rs:2590-2593`，该事件此前未单独记载（本计划顺带补记为文档缺口） |
| `docker/terminal/error` | `{terminalId, error}` | 二进制写失败时镜像（同 `ssh/terminal/error` `backend/src/main.rs:2584-2587`） |
| `docker/terminal/end` | `{terminalId, reason: "exited"\|"closed"\|"error", exitCode?}` | 唯一终态；重复 close 不再发 |
| `docker/logs/end` | `{streamId, reason: "exited"\|"stopped"\|"ttl"\|"error", exitCode?}` | 终态；`ttl` 表示达到 30 分钟/20 MiB 上限被 sidecar 主动停 |
| `docker/logs/error` | `{streamId, error}` | 通道已建立后的运行期错误（建立前的错误直接作为 RPC 错误返回） |
| `docker/logs/chunk` | `{streamId, sequence, text}` | **兼容降级**：仅当宿主/前端不支持二进制订阅时使用（16 KiB/条，UTF-8 lossy）；主路径恒走二进制通道，避免多字节字符跨块断裂与 ANSI 丢失 |

### 2.4 输入确认语义

沿用既有机制，不新造：

1. 二进制输入必须带 8 字节大端序号；解码复用 `decode_sequenced_input`（`backend/src/main.rs:2747-2760`）。
2. 序号只回显、不参与排序——顺序由 SDK 的 per-channel lane 保证（`backend/src/main.rs:2748-2749` 的注释即契约）。
3. 前端复用 `createTerminalInputQueue`（`frontend/src/lib/terminalInputQueue.ts:1-7`）：发送 Promise 只代表桥接收下，**不等待 inputAck**，避免一次延迟事件卡住后续按键。
4. 死会话写失败必须同时 `docker/terminal/error` + 返回错误，否则前端会表现为「打不进字但看起来还活着」（该教训见 `backend/src/main.rs:2578-2589`）。

### 2.5 错误语义与降级

- 参数错误、id 非法、只读拒绝、`needsSudo` 终端拒绝：**RPC 直接返回错误**（不发事件）。
- 通道建立后的失败：发 `*/error` 或 `*/end`，RPC 已返回成功，前端按终态收场。
- 旧 sidecar（无新方法）：前端在用户点「跟随/终端/文件」时收到 `Method not found`，就地提示并保持快照模式；不做静默探测（同仓库对 `binaryInput` 能力位的处理，`docs/PROTOCOL.zh-CN.md:753`）。
- 容器在读日志/进终端期间被删：`docker logs -f` 的进程以非 0 退出，`docker/terminal` 收到 `exit-status` → `end {reason:"exited", exitCode}`；不得把「容器已不存在」误报成 sidecar 传输错误。

### 2.6 文档落点（`docs/PROTOCOL.zh-CN.md`）

| 内容 | 落点（基线行） |
|---|---|
| RPC 总表新增四行（stats / logs stream / terminal / files） | `docs/PROTOCOL.zh-CN.md:137` 之后，与 docker 现有行同格；首列写全名，后续同族可省前缀 |
| 方法参数/返回/事件的详细小节 | `## Docker 管理面板`（`657`）之后新增 `### 容器指标`、`### 容器日志流`、`### 容器终端`、`### 容器文件` |
| 三个二进制通道 | `## 二进制通道` 列表（`678-693`），按现有条目格式逐条加 |
| 输入确认/回放语义 | 各小节正文，引用 `serial/replay`（`751`）与 `local/terminal/inputAck`（`682`，SSH 同名机制在 `main.rs:2590`） |
| Windows 远端降级、sudo 策略 | `### 容器终端` 与 `### 容器文件` 内的「限制」段 |

`scripts/mock_host_registry_check.mjs` 对文档只做 report-only（脚本头 `:11-12`），但 mock 缺口是硬失败（`:7-8`）——**每个批次必须在同一提交里补 mock 桩**。

## 3. 后端模块布局

### 3.1 目标树

```
backend/src/docker.rs                 根：mod 声明 / pub use / 共享常量 / DockerTarget  (~140)
backend/src/docker/engine.rs          EngineConfig、parse_engine、cli/endpoint 校验、env 前缀 (~210)
backend/src/docker/scripts.rs         list/logs/action/exec 文本渲染、id 门、tail 钳制 (~200)
backend/src/docker/parse.rs           marker/probe/ps/inspect/logs payload 纯解析 (~180)
backend/src/docker/local.rs           CLI 发现、直接 exec、local 列表/日志/动作 (~290)
backend/src/docker/tests.rs           现有单测整体搬移（测试预算 1200） (~700)
backend/src/docker/rpc.rs             现有三方法的处理体（从 main.rs 抽出） (~300)
backend/src/docker/terminal.rs        PTY 会话表、SSH/local 两路泵、resize/replay/close (~480)
backend/src/docker/logs_stream.rs     follow 通道、分帧、TTL、取消 (~330)
backend/src/docker/files.rs           list/read/write/delete 脚本与解析 (~400)
backend/src/docker/stats.rs           stats 模板、单位解析、批量载荷 (~260)
backend/src/docker/streams.rs         流/终端注册表：配额、TTL、取消令牌 (~200)
```

> `docker.rs` + `docker/` 子目录是合法模块根（Rust 2018+），所有 `crate::docker::X` 路径不变；同 `docs/IMPL_PLAN_SSH_SPLIT.zh-CN.md:5` 的既有做法。

### 3.2 预算算式

- 现 `docker.rs` 1,676 行，白名单条目 `("docker.rs", 1676)`（`backend/src/structure_tests.rs:45`），规则「只允许收缩」（`structure_tests.rs:7-9`）。
- 拆分后：根约 140，`engine` 210、`scripts` 200、`parse` 180、`local` 290、`rpc` 300、`terminal` 480、`logs_stream` 330、`files` 400、`stats` 260、`streams` 200，全部 <600；`tests.rs` 约 700 <1200（`structure_tests.rs:20-22`）。白名单**删除** `docker.rs` 条目。
- 现有测试区 `#[cfg(test)]` 从 `docker.rs:1008` 到文件尾（669 行）；搬进 `docker/tests.rs` 后仍整文件 <1200。

### 3.3 `main.rs` 分派瘦身（硬约束）

`main.rs` 3,640 行 = 白名单值 3,640（`structure_tests.rs:36`），任何净增都会让 `cargo test` 的 `structure_tests` 变红。docker 三个臂占 `main.rs:1488-1751`（含注释 1479-1487），共 **264 行**。

**做法**：把这些臂的函数体搬进 `docker/rpc.rs`，`main.rs` 只留字面量方法名 + 一行调用（约 3 行/臂）：

```rust
"docker/logs" => docker::rpc::logs(&self.ssh, &self.runtime, &params),
```

- 必须保留**字面量方法名**：`scripts/mock_host_registry_check.mjs` 用 `^\s*"method" =>` 扫描后端全集（`:30-36`）；改成前缀 guard（`m if m.starts_with("docker/")`）会让注册表检查认为后端不存在这些方法，前端 invoke 立刻被判「幽灵」。
- 264 行换 ~9 行 → 释放约 255 行，足够容纳 B2–B6 新增的 ~12 个薄臂（每臂 3–6 行），并可保持 `main.rs` ≤3640。
- `docker/rpc.rs` 接收 `&SshRuntime`、`&tokio::runtime::Runtime`（`main.rs:100` 的 `Plugin.runtime` 类型）、`&Path`（data_dir，审计用）、`&PluginEmitter`，不引用 `Plugin` 类型，避免 main↔docker 循环依赖。

### 3.4 可复用件（按符号名，不按行号）

| 能力 | 现有实现 | 复用方式 |
|---|---|---|
| 帧编码 | `TerminalFrame::encode`（`model.rs:866-874`） | 直接调用 |
| 输出回放缓冲（2 MiB） | `ReplayBuffer`（`ssh.rs:1293-1344`），上限 `TERMINAL_REPLAY_LIMIT`（`model.rs:4`） | `pub(crate)` 已可跨模块；docker 终端每会话一个 |
| 输出发布 | `publish_terminal`（`ssh.rs:11791-11805`）/ `publish_local_terminal`（`local_terminal.rs:632-647`） | 复制 8 行但把 channel 前缀参数化，或在 `docker/terminal.rs` 自带 `publish_docker_frame` |
| 输入队列/回压 | `enqueue_terminal_input`（`ssh.rs:1188-1195`）、mpsc 256（`ssh.rs:2469`、`local_terminal.rs:435`） | 同容量 256；写失败映射为「会话已关闭」同一文案族 |
| 写序列化 / 有界队列 | 串口「专用写线程 + 256 KiB 有界队列 + 满则整包丢弃并回报」的准入语义（`serial_session.rs:1-10` 头部契约、`docs/PROTOCOL.zh-CN.md:756-763`） | 容器终端键入必须**无损有序**（按键丢包不可接受），沿用 ssh/local 的 mpsc 256 + 阻塞背压；该先例用于日志流的「满则停读、绝不丢行」决策 |
| SSH 通道 + PTY | `channel_open_session` + `request_pty(true,"xterm-256color",…)`（`ssh.rs:2403-2413`） | 容器 PTY 的远端支路逐行照用 |
| 通道读循环 | `ChannelMsg::Data`→Stdout、`ExtendedData`→Stderr、`Eof/Close`→终态（`ssh.rs:2853-2862`） | 日志流与终端泵共用该 `match` 形状 |
| resize | `channel.window_change(cols,rows,0,0)`（`ssh.rs:2762`） | 终端 resize |
| 通道关闭 | `eof()+close()` 必须显式发，drop 不够（`monitor.rs:937-944`） | 日志流/终端/文件取消时统一调用 |
| 本地 PTY | `portable_pty::native_pty_system` + `CommandBuilder` + 读/写/子进程泵（`local_terminal.rs:31`、`416`、`669`） | local target 的 `docker exec -it` 直接走 argv，不经 shell |
| ConPTY 探测 | `conpty_available()`（`local_terminal.rs:331` 调用处） | 提为 `pub(crate)` 供 docker local 终端复用 |
| 取连接句柄 | `live_handle_for_connection`（`ssh.rs:4420-4431`） | 远端终端/日志流从**已认证 transport** 新开通道，不二次拨号 |
| 只读门 | `ensure_writable`（`ssh.rs:4405-4411`） | 终端 open、files write/delete |
| shell 转义 | `exec::shell_quote`（`exec.rs:1763-1765`） | 所有进命令串的 argv 元素 |
| 流任务配额先例 | `MONITOR_TASK_LIMIT = 24` + 双检（`monitor.rs:27`、`485-500`） | docker 的 8/8 配额照抄双检结构 |
| 进度节流 | `ProgressThrottle`（`progress_throttle.rs:17-49`，100ms 窗） | 统计轮询事件（若要发 `docker/stats` 事件）复用；日志流不用（不能丢行） |

### 3.5 关键实现点

- **远端容器 PTY**：`live_handle_for_connection` → 开通道 → `request_pty` → `exec(true, command)`。`command` 由 `docker/scripts.rs` 的纯函数生成：`{env}{cli} exec -it {id} sh -lc '<固定探测脚本>'`，其中 id 已过 `validate_container_id`（`docker.rs:405-416`），固定脚本是 `&'static str`，**无任何用户输入拼接**。容器内 shell 探测脚本与今天 UI 里的一致（`DockerPanel.vue:125`），只是从「文本填充」改为 sidecar 生成。
- **本机容器 PTY**：`CommandBuilder::new(cli)` + `["exec","-it",id,"sh","-lc",SCRIPT]` 直接 argv（无 shell），端点用 `.env("DOCKER_HOST"/"CONTAINER_HOST")`（同 `docker.rs:167-177` 的语义、`docker::run_local` 的 `.env` 注入 `docker.rs:788-812`）。
- **日志流**：远端 `exec(true, "{env}{cli} logs --follow --tail {n} [--timestamps] {id}")`；本机 `tokio::process::Command` 以 piped stdout/stderr 读取。两端统一进入 `StreamRegistry`（`docker/streams.rs`）：`streamId` 一经注册就启动取消令牌与 TTL 计时，读循环把块推给 `logs_stream::publish`（16 KiB 分帧 + `ReplayBuffer` 不启用，日志按在线流处理）。
- **统计**：`STATS_FORMAT` 常量与 `PS_FORMAT`（`docker.rs:272-283`）同风格；单位解析是纯函数（`parse_human_bytes`、`parse_percent`），用固定夹具单测。
- **文件**：固定脚本 + **位置参数**（见 §5.2），Rust 侧只做 base64 编解码与路径校验；不引入新依赖（`base64` 已在 `backend/Cargo.toml:16`）。

## 4. 前端模块布局

### 4.1 目标树（保持平坦：`components/`、`composables/`、`lib/`）

```
frontend/src/lib/dockerTerminalFrames.ts    帧/序号/缺口判定（纯函数）
frontend/src/lib/dockerFiles.ts             路径拼接、条目过滤/排序、大小格式化（纯函数）
frontend/src/lib/dockerStats.ts             单位/百分比解析、两次样本求速率（纯函数）
frontend/src/lib/dockerLogStream.ts         行切分、ANSI 安全边界、尾部截断（纯函数）
frontend/src/composables/useDockerTerminal.ts   xterm 实例、输入队列、replay、resize 生命周期
frontend/src/composables/useDockerLogStream.ts  订阅/停止/TTL 提示/背压
frontend/src/composables/useDockerStats.ts      可见性驱动轮询（3s，隐藏即停）
frontend/src/components/DockerWorkbench.vue     容器工作台抽屉：Tabs = 终端/文件/日志/指标
frontend/src/components/DockerTerminalPane.vue  单容器终端窗格（对照 SplitTerminalPane.vue）
frontend/src/components/DockerFilesPane.vue     文件浏览/预览/上传（写）
frontend/src/components/DockerStatsBar.vue      CPU/内存/IO 卡片
frontend/src/components/DockerLogsDrawer.vue    从 DockerPanel.vue 抽出的 Logs 抽屉（快照 + 流式）
```

新文件没有白名单条目，必须 ≤600 行（`frontend/src/structure.spec.ts:22-23`）。

### 4.2 纯逻辑留在 `lib/`

沿用两个既有范例：

- `frontend/src/lib/quickCommands.ts:1-8`：模块头声明「纯函数 + 显式存取」，组件只做接线。
- `frontend/src/composables/useRecording.ts`（749 行）与 `useMetricsPanel.ts`（605 行）：组合式负责生命周期，纯计算下沉到 `lib/`（`terminalFrameBatch.ts`、`terminalWriteThrottle.ts`、`terminalBackpressure.ts` 都是先例）。

Docker 侧对应：**帧解码/缺口判定**放 `lib/dockerTerminalFrames.ts`，**速率计算**放 `lib/dockerStats.ts`，组合式只持有 ref 与订阅。

### 4.3 结构预算（硬约束，先瘦身再长大）

`frontend/src/structure.spec.ts:26-38` 冻结了三个关键条目：

| 文件 | 冻结值 | 本计划要加的代码 | 必须先做的瘦身 |
|---|---:|---|---|
| `./components/DockerPanel.vue` | 1,137（`structure.spec.ts:31`） | 行菜单加「终端/文件/指标」入口、状态徽标扩展 | 把 Logs 抽屉（`DockerPanel.vue:416-455` 状态 + `680-713` 模板 + `1050-1126` 样式，约 210 行）抽成 `DockerLogsDrawer.vue` |
| `./App.vue` | 12,560（`structure.spec.ts:27`） | `handleBinary` 增加 `docker/logs/out/` 与 `docker/terminal/out/` 路由（约 10 行） | 把 `dbx:docker-open-in-terminal` 处理器（`App.vue:6155-6172`，18 行）抽到 `useDockerOpenInTerminal`（或直接删除，B5 后该通道作废） |
| `./mockDbxHost.ts` | 2,194（`structure.spec.ts:30`） | 每批新增 `else if (method === "docker/…")` 分派 | **分派行必须留在本文件**（注册表检查只读这一个文件，`mock_host_registry_check.mjs:20`、`:39-41`）。B1 把 docker 夹具构造体（`mockDbxHost.ts:995-1043` 的校验与数据，约 40 行）抽到新文件 `frontend/src/lib/mockDockerFixtures.ts`，分派改成一行调用；之后每批只增 1–3 行分派，主体行数净减 |

结论：**B1 必须先做 DockerPanel.vue 抽屉外抽 + App.vue 处理器外抽**，否则 B2 起每批都会被 `pnpm test` 的 `structure.spec` 拦住。

### 4.4 渲染选择

- **日志流**用只读 xterm（`disableStdin: true`），而不是 `<pre>`：ANSI 颜色、UTF-8 多字节跨块、`\r` 覆盖行都由 xterm 正确处理；主题复用 `frontend/src/lib/terminalAppearance.ts`。今天的 `<pre>`（`DockerPanel.vue:710`）保留为快照视图。
- **容器终端**新建独立 xterm 实例（不挂进 `useSplitPanes`：那套是 SSH sessionId 寻址，见 `frontend/src/composables/useSplitPanes.ts:1-20`）。窗格组件结构对照 `SplitTerminalPane.vue:1-77`（DOM 容器 + ResizeObserver + 无折行），但数据源改为 `docker/terminal/*`。
- **输入**复用 `createTerminalInputQueue`，`send` 走 `docker/terminal/in/{terminalId}`；不用 `terminalInputChannel`（它只认 ssh/local/telnet 三种身份，`terminalInputQueue.ts:43-47`）。

### 4.5 i18n

`frontend/src/lib/i18n.ts` 有 7 个 locale（`i18n.ts:1`：en/es/it/ja/pt-BR/zh-CN/zh-TW），docker 块从 `:51` 起。新增约 28 个键（工作台 tabs、文件操作、流状态、错误文案），7 语言同批补齐；`i18nKeyReferences.spec.ts` 只认字面量 key，动态拼接会漏检。

## 5. 安全与资源边界

### 5.1 容器 id 门（唯一入口）

- 唯一校验函数：`validate_container_id`（`docker.rs:405-416`），规则 `^[0-9a-f]{12,64}$`，不接受 name/大写/元字符。
- 新方法一律**先校验再渲染**（`logs_script` 即此顺序，`docker.rs:325-326`），且在校验之后仍用 `shell_quote` 包裹一次（纵深）。
- 前端不得把容器 **name** 传进 `containerId`；展示名归展示，命令只用 id（`ContainerRow` 的 `id` 是全 id，`docker.rs:428-440`）。

### 5.2 命令注入面（红线）

现有 `docker exec` 是**文本**：`DockerPanel.vue:125` 把 id 直接拼进 `sh -lc '…'`。虽然 id 来自列表，但这条通道没有任何 sidecar 侧校验，且用户可改输入行后回车——这是 B5 必须替换的核心理由。

新规则（写进 `docker/scripts.rs` 的模块注释并被单测锁定）：

1. **脚本是常量**：所有 `sh -c` 的脚本体是 `&'static str`，用户输入永不进入脚本文本。
2. **用户值只走位置参数**：`sh -c '<固定脚本>' sh <arg1> <arg2>`，每个 arg 经 `exec::shell_quote`（`exec.rs:1763`）。
3. **id 不进 argv**：id 是 `[0-9a-f]` 子集，可直接拼；但同样经 quote。
4. **禁止**：`format!("… {}", user_path)` 直接拼接、`sh -c "$user"`、把路径拼进 heredoc 正文、`eval`。
5. **本机走 argv**：`tokio::process::Command` 直接参数，无 shell（同 `docker.rs:788-812`）。

反例单测（必须红）：`path = "a'b; rm -rf /"`、`"$(id)"`、`` "`id`" ``、含 `\n`、含 NUL、超长 4096。

### 5.3 路径校验（`docker/files/*`）

- 必须是绝对路径、无 NUL、长度 ≤4096、按 `/` 分段后无 `.`/`..`、不以 `//` 开头。
- `delete` 额外：`recursive` 时拒绝 `/`、`/proc`、`/sys`、`/dev`（容器内这些是挂载点，删了会伤宿主内核视图）；非 recursive 允许普通文件。
- 路径**只**作为位置参数传递（§5.2），不参与脚本拼接。
- 拒绝符号链接逃逸不做（容器内没有「工作区」概念，root 即容器 root）；在文档中写明「不做 chroot 语义，等价于 `docker exec` 的权限」。

### 5.4 只读连接策略

| 方法 | 只读连接 |
|---|---|
| `docker/list`、`docker/logs`、`docker/logs/stream/start`、`docker/logs/stream/stop`、`docker/stats`、`docker/files/list`、`docker/files/read` | 放行（只读采集） |
| `docker/terminal/open` | **拒绝**（容器内可写文件、可改状态）；错误文案与 `ensure_writable` 同族 |
| `docker/files/write`、`docker/files/delete` | **拒绝** |

实现：`target:"ssh"` 时先 `ensure_writable(session_id)`（`ssh.rs:4405-4411`）；`target:"local"` 无连接语义，不做该门（本机 = 用户自己的机器），但 `delete` 仍要求 `confirm: true`。

注意 `ensure_writable` 的错误文案目前写死 "SFTP write operation…"（`ssh.rs:4407`），B5 顺带改为中性文案（会触碰 `ssh.rs`，属行为文案非行为变更，需人审）。

### 5.5 sudo / podman

- **列表/日志/统计/文件**：daemon 拒绝时走现有 Quick Sudo 形态——`sudo -S -p '' sh -c '<body>'`，密码走 stdin（`docs/PROTOCOL.zh-CN.md:668`、`main.rs:1533-1557`），且必须过 `ensure_sudo_allowed` 的 sudoers 白名单（`main.rs:1726`）。
- **容器 PTY**：**绝不**在 PTY 内注入密码（会显示在容器屏幕上、可能落 shell 历史）。策略：`docker/terminal/open` 在 `needsSudo:true` 时直接报错「daemon 需要权限：把用户加入 docker 组，或先在本连接执行一次 sudo 以预热时间戳」；若已有预热时间戳，则命令前缀为 `sudo -n`（非交互）——失败即报错，不退化为交互提示。实现需要新增只读访问器 `SshRuntime::has_warm_sudo(connection_id)`（`sudo_keepalive` 注册表已存在，`ssh.rs:2034`、`4109`）。
- **Podman**：所有新命令只用两引擎共有子命令（`exec`/`logs`/`stats`）；rootless podman 的失败（`cannot set terminal process group`/`permission denied`）原样上抛但加一句「podman rootless 需要在用户命名空间内运行」的提示。冒烟脚本以 `--cli podman` 覆盖（§7）。

### 5.6 流 / 终端生命周期

| 资源 | 上限 | 依据/先例 |
|---|---|---|
| 并发日志流 | 8/sidecar | 参照 `MONITOR_TASK_LIMIT`（`monitor.rs:27`）的双检模式 |
| 并发容器终端 | 8/sidecar | 同上；超过返回可读错误，不排队 |
| 日志流 TTL | 30 分钟或 20 MiB 输出（先到者） | 防止「忘记关抽屉」长期占通道；到限发 `end {reason:"ttl"}` |
| 终端空闲 TTL | 30 分钟无输入/输出 | 用户可重开；不发 TTL 终态时前端靠 `end` 收场 |
| 单条日志分帧 | 16 KiB | 同串口分帧口径（`docs/PROTOCOL.zh-CN.md:760`） |
| 终端 replay | 2 MiB 环形 | `TERMINAL_REPLAY_LIMIT`（`model.rs:4`） |
| 文件读 | 8 MiB 解码后 | `MAX_EXEC_OUTPUT_BYTES = 16 MiB`（`exec.rs:1359`）的 base64 膨胀余量 |
| 文件写 | 64 KiB 解码后 | Linux 单 argv 上限 128 KiB（base64 后 ~87 KiB，留余量） |

取消：`streamId`/`terminalId` 注册即建 `watch::Sender<bool>`；`stop`/`close`/TTL/连接断开都 `send(true)` 并 `close_channel`（`monitor.rs:878-883`、`941-944`）。连接断开时统一清理：挂在 `disconnect_connection`（`ssh.rs:2233`，现有 `stop_sudo_keepalive` 清理点 `2281`）同一收尾位置，按 connectionId 回收该连接下所有 docker 流/终端。

### 5.7 输出回压

- 后端：日志读循环按 16 KiB 分帧；每帧发 `PluginEmitter::binary`，若桥接报错（webview 关闭）立即停流并回收，不重试。
- 前端：复用 `createOutputGate`（`frontend/src/lib/terminalBackpressure.ts:54-56`：128 KiB 抬闸 / 64 KiB 恢复 / 32 KiB 分块）与 `createTerminalWriteThrottle`（`terminalWriteThrottle.ts:85`）。
- **不丢日志行**：与传输进度不同（`progress_throttle.rs:3-7` 允许丢中间帧），日志流丢帧即语义错误；回压时阻塞读循环（SSH 窗口自然背压），不能丢。

### 5.8 审计

- 终端 open / 文件 write / 文件 delete 必须写审计意图行（`audit_action_intent`，`docker.rs:992-994`），失败补失败行（`docker.rs:998-1006`）；命令文本用 `action_command` 同款短形态（无端点前缀、无 base64 载荷）。
- 审计**不含文件内容**、不含键入字节（只记录 `cli exec -it <id> <shell>` 与 `write <path> <bytes>`）。

### 5.9 绝不允许

1. 把用户路径/内容拼进 `sh -c` 脚本文本（§5.2）。
2. 在 PTY 里注入 sudo 密码或任何凭据。
3. 把 `docker exec` 的任意命令交给前端（只允许固定能力：列/读/写/删/进 shell）。
4. 允许 `containerId` 为 name、短于 12 位、或大写。
5. 让日志流/终端无限期存活（§5.6）。
6. 为「图省事」在只读连接上放开终端或写文件。

## 6. 分批实施（6 批，每批可独立合并）

> 每批共同要求：`node scripts/mock_host_registry_check.mjs` 必须绿（mock 桩同批）；`docs/PROTOCOL.zh-CN.md` 同步；`docs/MODULE_MAP.zh-CN.md` 的 docker 行（`docs/MODULE_MAP.zh-CN.md:116`、`163`、`288`）更新；前端 `pnpm typecheck && pnpm test`；后端 `cargo fmt --check && cargo clippy -D warnings && cargo test`。AGENTS.md 规定「认证/命令执行/secret 绑定/协议变更」需人审——本计划 B1（分派搬移）、B4（新增 `docker exec` 读取面）、B5（PTY）、B6（破坏性写删）命中「命令执行」或「协议变更」，均标注人审。

### B1 拆分与瘦身（纯搬移，无新协议）

| 项 | 内容 |
|---|---|
| 文件 | 新增 `backend/src/docker/{engine,scripts,parse,local,rpc,tests}.rs`；改 `backend/src/docker.rs`（变根）、`backend/src/main.rs`（docker 臂瘦身）、`frontend/src/components/DockerLogsDrawer.vue`（外抽）、`DockerPanel.vue`、`App.vue`（处理器外抽/删除） |
| 风险 | 低（不改行为/协议），但触碰 `main.rs` 分派与 `App.vue` 事件，仍需常规人审 |
| 验证 | 测试名/数量与基线一致（`cargo test` 的 docker 用例数）；`structure_tests` 删除 `docker.rs` 条目后绿；`structure.spec` 的 DockerPanel/App 条目**收紧**；`python3 scripts/smoke_docker_local.py` 输出与基线同形 |
| 规模 | 搬移 1,676 行（生产 1,007 + 测试 669）+ 前端外抽 ~230 行；净新增 ~80 行（模块声明 + 每臂 1 行调用） |

### B2 容器指标（只读）

| 项 | 内容 |
|---|---|
| 文件 | `backend/src/docker/stats.rs`、`docker/rpc.rs`（stats 臂）、`main.rs`（3 行臂）、`docs/PROTOCOL.zh-CN.md`、`frontend/src/lib/dockerStats.ts(+spec)`、`composables/useDockerStats.ts`、`components/DockerStatsBar.vue`、`DockerPanel.vue`（<10 行）、`mockDbxHost.ts`（分派 2–3 行；夹具函数进 B1 新建的 `mockDockerFixtures.ts`）、i18n ×7 |
| 风险 | 低（只读采集；`docker stats` 是本地 CLI，无新执行面） |
| 验证 | 纯函数单测（单位解析：`0B`/`1.2kB`/`1.5KiB`/`2.3GiB`；百分比；速率差分）；`docker/stats` mock 桩覆盖 available/needsSudo/空；扩展 `smoke_docker_local.py`：`docker/stats {containerIds:[首个容器]}` 形状断言（无 docker 时 `available:false` 也通过） |
| 规模 | ~450 行（后端 200 / 前端 200 / mock+docs 50） |

### B3 日志流（follow）

| 项 | 内容 |
|---|---|
| 文件 | `backend/src/docker/logs_stream.rs`、`docker/streams.rs`（注册表可先只服务日志）、`rpc.rs`、`main.rs`（2 臂）、`docs/PROTOCOL.zh-CN.md`（含二进制通道 2 条）、`frontend/src/lib/dockerLogStream.ts(+spec)`、`composables/useDockerLogStream.ts`、`DockerLogsDrawer.vue`（跟随开关 + 只读 xterm）、`mockDbxHost.ts`（`sendBinary` 侧模拟 3 帧后 end）、i18n |
| 风险 | 中：长驻 exec 通道 + 新二进制通道；`stop` 必须真的 `close`（`monitor.rs:937-944` 的教训） |
| 验证 | 单测：分帧（多字节字符跨块、`\r`、超长行）、TTL 判定、`stop` 幂等；mock：start→3 个 out 帧→end；注册表检查；`smoke_docker_local.py` 新增「start→收到 ≥1 帧→stop」分支，用 `target:"local"` + 一个真实运行的容器（不可用时 skip 并打印） |
| 规模 | ~700 行（后端 330 / 前端 280 / mock+docs 90） |

### B4 容器文件（只读：list/read）

| 项 | 内容 |
|---|---|
| 文件 | `backend/src/docker/files.rs`（仅 list/read）、`rpc.rs`、`main.rs`（2 臂）、协议文档、`frontend/src/lib/dockerFiles.ts(+spec)`、`components/DockerFilesPane.vue`、`DockerWorkbench.vue`（Tabs 壳，先只挂「文件」）、`DockerPanel.vue`（入口）、mock、i18n |
| 风险 | 中偏高：新增「固定脚本 + 位置参数」执行面（AGENTS.md 的 command-execution，人审）；必须把 §5.2 的注入用例逐条过一遍 |
| 验证 | 纯函数单测：路径校验（合法/`..`/相对/超长/NUL）、固定脚本渲染（恶意路径只出现在 argv 位置且被单引号包裹）、列表解析（tab/空名/超 500 条截断）、base64 解码；冒烟：本机 `docker/files/list {path:"/"}` 形状断言（无 docker skip） |
| 规模 | ~480 行 |

### B5 容器终端（PTY）

| 项 | 内容 |
|---|---|
| 文件 | `backend/src/docker/terminal.rs`、`docker/streams.rs`（终端配额）、`rpc.rs`、`main.rs`（open/close/resize/replay 4 臂）、`ssh.rs`（`ensure_writable` 文案中性化 + `has_warm_sudo` 访问器）、`local_terminal.rs`（`conpty_available` 提权）、协议文档（2 个通道 + 3 事件）、`frontend/src/lib/dockerTerminalFrames.ts(+spec)`、`composables/useDockerTerminal.ts`、`components/DockerTerminalPane.vue`、`DockerWorkbench.vue`（终端 tab）、`App.vue`（`handleBinary` 路由 + 删除旧 `dbx:docker-open-in-terminal`）、`DockerPanel.vue`（「在终端打开」改开工作台）、mock、i18n |
| 风险 | **高**：新执行面 + PTY + 授权边界（AGENTS.md 要求人审）。`ssh.rs` 的 `has_warm_sudo` 是新只读 API；`ensure_writable` 文案变化影响既有错误断言（需搜测试） |
| 验证 | 单测：输入序号（8 字节前缀、<8 字节报错）、resize 钳制（2..500/2..300）、replay 语义（`complete:false`）、close 幂等、只读拒绝、`needsSudo` 拒绝；前端：帧路由（`docker/terminal/out/` 不进 ssh 分支）、输入队列只发对应通道；mock：open→2 帧→end；注册表检查；本机冒烟：`docker/terminal/open` 对运行中容器返回 terminalId，输入 `echo ok\n` 收到 `ok`，close 后 `end`（无 docker skip） |
| 规模 | ~900 行（后端 480+60 / 前端 300 / mock+docs 60） |

### B6 容器文件写/删（破坏性）

| 项 | 内容 |
|---|---|
| 文件 | `backend/src/docker/files.rs`（write/delete）、`rpc.rs`、`main.rs`（2 臂）、协议文档、`DockerFilesPane.vue`（预览编辑器 + 删除确认）、`lib/dockerFiles.ts`（覆盖/递归确认状态机）、mock、i18n |
| 风险 | **高**：破坏性执行 + 用户路径（AGENTS.md 人审）。审计必须先写意图行 |
| 验证 | 单测：`..`/`/`/挂载点拒绝、原子写（唯一临时名、失败清理）、`overwrite:false` 已存在报错、base64 上限、审计命令文本不含内容；冒烟：本机 `write`→`read` 往返一致→`delete`（容器内 `/tmp`）；只读连接拒绝（mock 侧断言） |
| 规模 | ~350 行 |

**批次顺序理由**：B1 先把预算与搬运做干净（否则后面每批都被结构守卫拦）；B2/B3 是只读、无新授权面，先交付用户可见价值并验证流注册表；B4 引入「固定脚本 + 位置参数」这一新执行范式，先用只读文件把范式与测试打牢；B5 才上 PTY（最高风险）；B6 最后做破坏性写删。B4 与 B6 拆开是为了让「只读脚本注入面」单独人审一次。

### 6.1 执行记录（2026-11-27）

| 批次 | 状态 | 实测（行数 / 测试 / 备注） |
|---|---|---|
| B1 | 已完成 | `docker.rs` 1,676 → 根 72 + `engine 167 / scripts 224 / parse 259 / local 263 / rpc 328 / tests 672`；命令字面量 109/109 一致；registry 188 |
| B2 | 已完成 | 新增 `docker/stats.rs` 579（11 个纯函数单测）；`parse` 259→266、`rpc` 328→403、根 72→75、`main.rs` +1 字面量臂；前端 `dockerStats.ts` 224 + spec 186、`useDockerStats.ts` 165、`DockerStatsBar.vue` 78、`mockDockerFixtures.ts` 156；总测试 1,396 |
| B3 | 已完成 | 新增 `logs_batch.rs` 263 + `logs_stream.rs` 462 + `streams.rs` 287；`rpc` 403→487、根 75→81、`tests.rs` 672→1,112；前端 `dockerLogStream.ts` 90 + spec 98、`useDockerLogStream.ts` 198、`DockerLogsDrawer.vue` 154→327；总测试 1,409；`stop_connection` 已接线到 `main.rs` 的 `connection/disconnect` 臂（`SshRuntime` 拿不到 `Plugin` 的注册表，故接线点在分发层而非 `disconnect_connection` 内部） |
| B4 | 已完成 | 新增 `docker/files.rs` 472 + `files_tests.rs` 307；`rpc.rs` +83、`main.rs` +2 字面量臂；路径校验比计划更严（额外拒绝所有 ASCII 控制字符），解析用 NUL 分隔 + 文件名 base64；前端 `dockerFiles.ts` 182 + spec 134、`DockerFilesPane.vue` 365、`DockerWorkbench.vue` 105；后端 1,423 测试全绿 |
| B5 | 已完成 | 新增 `docker/terminal.rs` 308 + `terminal_registry.rs` 390 + `terminal_io.rs` 396 + `terminal_tests.rs` 224；`rpc.rs` +124、`main.rs` +4 字面量臂 +1 输入前缀分支、`docker/streams.rs` 连接清理点接入终端注册表；`ssh/terminal.rs` 文案中性化 + `ssh/keepalive.rs` `has_warm_sudo` 只读访问器；前端 `dockerTerminalFrames.ts` 107 + spec、`useDockerTerminal.ts` 254 + spec、`DockerTerminalPane.vue` 257、`DockerWorkbench.vue` 终端 tab、`DockerPanel.vue` 改开工作台（删除旧 window 事件）；后端 1,431 测试全绿 |
| B6 | 已完成 | 新增 `docker/files_write.rs` 485 + `files_write_tests.rs` 411；`rpc.rs` 694→881；原子写（同目录唯一临时名 + `trap` 清理 + `mv -f`）、`overwrite:false` 默认拒绝、递归删除精确拒绝 `/`/`/proc`/`/sys`/`/dev`、本机删除要 `confirm:true`、审计意图行不含文件内容；前端 `dockerFiles.ts` 290、`DockerFilesPane.vue` 613（按允许清单冻结）、`DockerFilesConfirmBar.vue` 72；后端 1,451 测试全绿 |
| B7 | 已完成 | 收尾拆分：`DockerFilesPane.vue` 613 → 534（保留浏览、读取/保存/删除状态机），新增 `DockerFilePreview.vue` 151（仅呈现 + `v-model:draft`，不新增 IO）与 `DockerFilePreview.spec.ts` 90（8 条：空态/加载/只读/二进制/草稿绑定/save 门禁）；`structure.spec.ts` 白名单条目 613 已删除（TS 14 条）；前端 typecheck、vitest（234 files / 2,419 tests）、build 与两条 UI 走查（mock/settings，strict）全绿 |

**实机验证（2026-11-27，本机 docker 29.8.2）**：用一个 `--rm` 的 `alpine:3.22` 临时容器运行 `scripts/smoke_docker_local.py`，逐项通过——`docker/list`（46 容器）、`docker/stats`（采样 1 条）、`docker/logs`（35 字节）、`docker/logs/stream`（1 帧 / 70 字节，帧头流标签 0）、`docker/files/list`（17 条）、`files/write+read`（23 字节往返一致）、`files/delete`、`action start`（幂等）、`docker/terminal`（open → 4 帧含 `ok` → close → `end{reason:"closed"}` 且重复 close 幂等）。验证后容器已 `rm -f`，无残留；`docker ps` 回到 0 个运行中容器。

B3 落地时补的两处实现细节（协议不变）：

1. **聚合必须有**：主通道是二进制帧，不存在 UTF-8 切断，但一次 pipe read 一个事件会让桥接事件率失控；`ChunkBatcher` 64 KiB / 100 ms 任一 flush，单 fragment 不切分，`end` 前 flush 残余（附录 C.1）。
2. **已结束的流不会自己回注册表**：任务自然结束（`exited`/`ttl`/`error`）只发 `end` 就退出，前端只在关抽屉时发 `stop`；抽屉长开 + 容器反复重启会把 8 条上限永久占满。因此 `register` 在**上限边界**惰性回收 `JoinHandle::is_finished()` 的条目（未到上限时语义不变，条目留到 `stop` 以便墓碑拦住迟到的同 id start），并有用例 `logs_stream_registry_reclaims_finished_slots_at_the_cap`。

## 7. 测试策略

| 层 | 内容 | 说明 |
|---|---|---|
| 纯函数单测（后端） | 脚本渲染（正常/恶意路径）、payload 解析、stats 单位解析、路径校验、TTL/配额判定、base64 边界 | 全部无网络、无 docker；放各模块 `#[cfg(test)]` 或 `docker/tests.rs`（<1200 行） |
| 纯函数单测（前端） | 帧解析/缺口、行切分/ANSI 边界、字节格式化、速率差分、确认状态机 | `lib/*.spec.ts`，vitest（`frontend/package.json` 的 `test`） |
| mock 宿主 | 每个新方法 + 事件/二进制帧；`sendBinary` 分支模拟 out 帧 | **注册表检查是硬门**：后端有、mock 无 → exit 1（`scripts/mock_host_registry_check.mjs:6-8`）；前端 `invoke` 字面量必须命中后端（`:9-10`） |
| 冒烟（真实本地 docker） | 扩 `scripts/smoke_docker_local.py`：stats、files list/read/write/delete、logs stream start/stop、terminal open→输入→close | 复用 `sidecar_client.py` 的 stdio 帧协议（`smoke_docker_local.py:19-20`）；无 docker 时保持「形状断言通过 + skip 内容断言」的既有风格（`:5-7`） |
| UI 走查 | `node scripts/smoke_ui_mock.mjs`（mock 模式）覆盖新抽屉/窗格的挂载 | 与现有 docker 面板走查同路径 |
| CI 不能覆盖 | 真实容器 TTY（CI 无 docker daemon）、Windows 远端、rootless podman、sudo 提权后的 exec、真实 ANSI 全屏程序 | 在 PR 里记「人工验证」；B5/B6 必须贴本机运行记录 |

补充：

- `cargo test` 会跑 `structure_tests`；`pnpm test` 会跑 `structure.spec`——**这两个是每批的第一道门**。
- 协议新增方法必须在 `docs/PROTOCOL.zh-CN.md` 出现（report-only，但 PR 评审要求）；mock 与前端字面量是硬门。
- 前端 `DockerPanel.spec.ts` 走真实面板路径（`DockerPanel.spec.ts:1-40`），新入口按钮要加断言；`dockerExecCommand` 的旧测试（字符串填充）随 B5 删除。

## 8. 不做的范围

1. `docker compose` / swarm / Kubernetes / Podman pods。
2. 远端 daemon 的 TLS 证书管理（`DOCKER_TLS_VERIFY`/`DOCKER_CERT_PATH`）；只支持 `socket`/`host` 两参数。
3. 镜像构建、拉取、推送、tag、登录；容器创建/编辑/commit/export/import。
4. 任意 `docker exec` 命令执行（只允许固定能力：列/读/写/删/进 shell）。
5. 大文件传输（>64 KiB 写、>8 MiB 读）与 `docker cp` 暂存管线；后续可单列。
6. 文件 mtime / 权限位 / 属主（POSIX 脚本跨 busybox/BSD 不稳定，v1 不采）。
7. `docker attach`、容器端口转发、容器事件流（`docker events`）。
8. Windows 远端的新能力（终端/文件/日志流/统计）：返回可读错误；只保留现有 list 的 cmd 兜底。
9. `target:"local"` 的只读连接语义（本机没有「连接只读」概念），仅 delete 要求 `confirm:true`。
10. MCP 工具面新增容器能力（维持 `docs/PROTOCOL.zh-CN.md:676` 的现状）。
11. 录制（`session_recording`）覆盖容器终端；v1 不录。

## 9. 风险与回滚

| 批次 | 主要风险 | 缓解 | 回滚 |
|---|---|---|---|
| B1 | 搬移漏改可见性/路径，测试数量变化 | 纯搬移、不改逻辑；用测试名集合对比；`cargo test` 全量 | revert 单提交；`docker.rs` 白名单条目恢复 1676 |
| B2 | `docker stats` 在旧 CLI（<1.13）或 podman 上模板不支持 | 失败降级 `available:false` + 可读错误；模板只用长期存在的字段 | revert；前端隐藏指标卡（能力位） |
| B3 | 长驻通道泄漏（远端 `docker logs -f` 进程残留） | 显式 `eof+close`（`monitor.rs:941-944`）；TTL；连接断开清理；配额 | revert；已建流随 sidecar 重启消失 |
| B4 | 用户路径第一次进入 `docker exec` 命令；无 `sh` 容器（distroless）失败 | 位置参数 + `shell_quote` + 恶意路径单测（§5.2/§5.3）；无 `sh` 时明确报错不重试；人审 | revert；文件 tab 隐藏 |
| B5 | PTY 权限面、sudo 密码误注入、只读连接绕过 | 只读门 + needsSudo 拒绝 + 无密码路径；输入/输出全程审计；人审 | revert；「在终端打开」回退到旧的输入行填充（保留一个版本做开关） |
| B6 | 误删容器内关键路径（`/proc` 等） | 路径校验 + 挂载点黑名单 + `confirm:true` + 审计意图先行 | revert；写删 UI 关闭，保留只读文件 |

全局回滚策略：所有协议变更是**新增**（不改 `docker/list|logs|action`），旧前端对旧 sidecar 完全不受影响；单个批次 revert 不会破坏其它批次（`docker/rpc.rs` 采用「每方法一个函数」而非中央状态机）。

## 附录 A 验证记录（基线 `34524afb`，本 worktree 实测）

### A.1 引用的行数来自 `wc -l`

```
$ wc -l backend/src/docker.rs frontend/src/components/DockerPanel.vue \
        docs/PROTOCOL.zh-CN.md frontend/src/mockDbxHost.ts \
        backend/src/main.rs backend/src/ssh.rs frontend/src/App.vue
    1676 backend/src/docker.rs
    1137 frontend/src/components/DockerPanel.vue
    1542 docs/PROTOCOL.zh-CN.md
    2194 frontend/src/mockDbxHost.ts
    3640 backend/src/main.rs
   12829 backend/src/ssh.rs
   12560 frontend/src/App.vue
```

`docker.rs` 测试区 1008–1676 = 669 行；docker 分派臂 1488–1751 = 264 行（均为上表同一文件的坐标）。

### A.2 既有 RPC 名均可 grep 到

```
$ grep -c "<method>" docs/PROTOCOL.zh-CN.md backend/src/docker.rs backend/src/main.rs
docker/list                PROTOCOL:3   docker.rs+main.rs:4
docker/logs                PROTOCOL:3   docker.rs+main.rs:6
docker/action              PROTOCOL:3   docker.rs+main.rs:6
ssh/terminal/resize        PROTOCOL:1   docker.rs+main.rs:1
ssh/terminal/replay        PROTOCOL:3   docker.rs+main.rs:1
local/terminal/inputAck    PROTOCOL:2   docker.rs+main.rs:1
serial/replay              PROTOCOL:4   docker.rs+main.rs:1
```

`ssh/terminal/inputAck` 只在 `backend/src/main.rs:2590` 出现、`docs/PROTOCOL.zh-CN.md` 未单独记载——这是既有文档缺口，本文已在 §2.3 标注。

### A.3 本计划新增的名字（基线中不存在，属预期）

方法：`docker/stats`、`docker/logs/stream/start`、`docker/logs/stream/stop`、`docker/terminal/open`、`docker/terminal/close`、`docker/terminal/resize`、`docker/terminal/replay`、`docker/files/list`、`docker/files/read`、`docker/files/write`、`docker/files/delete`。
通道：`docker/terminal/in/{terminalId}`、`docker/terminal/out/{terminalId}`、`docker/logs/out/{streamId}`。
事件：`docker/terminal/inputAck`、`docker/terminal/error`、`docker/terminal/end`、`docker/logs/end`、`docker/logs/error`、`docker/logs/chunk`。
文件：`backend/src/docker/*.rs`（engine/scripts/parse/local/rpc/tests/terminal/logs_stream/files/stats/streams）、`frontend/src/lib/docker*.ts`、`frontend/src/composables/useDocker*.ts`、`frontend/src/components/Docker{Workbench,LogsDrawer,TerminalPane,FilesPane,StatsBar}.vue`。

对基线逐一 `grep -rn "<name>" backend docs frontend scripts | grep -v IMPL_PLAN_DOCKER_DEEP`，全部为 0 行（含通道前缀 `docker/terminal/in`、`docker/terminal/out`、`docker/logs/out`），因此它们只能出现在本计划的**新增**表格，不会与既有方法混淆。

### A.4 引用的既有路径全部存在

`backend/src/docker.rs`、`backend/src/main.rs`、`backend/src/ssh.rs`、`backend/src/local_terminal.rs`、`backend/src/monitor.rs`、`backend/src/exec.rs`、`backend/src/model.rs`、`backend/src/progress_throttle.rs`、`backend/src/structure_tests.rs`、`backend/src/audit_log.rs`、`frontend/src/App.vue`、`frontend/src/components/DockerPanel.vue`、`frontend/src/components/SplitTerminalPane.vue`、`frontend/src/components/MetricsPanel.vue`、`frontend/src/composables/useSplitPanes.ts`、`frontend/src/lib/{dockerActions,dockerEngine,dockerRowMenu,i18n,quickCommands,terminalInputQueue,terminalBackpressure,terminalWriteThrottle,terminalAppearance}.ts`、`frontend/src/structure.spec.ts`、`frontend/src/mockDbxHost.ts`、`docs/PROTOCOL.zh-CN.md`、`docs/MODULE_MAP.zh-CN.md`、`docs/IMPL_PLAN_SSH_SPLIT.zh-CN.md`、`scripts/mock_host_registry_check.mjs`、`scripts/smoke_docker_local.py`。

### A.5 注册表检查（未改代码，必须仍绿）

```
$ node scripts/mock_host_registry_check.mjs
mock host registry check PASS: backend 188 methods (aliases included), mock 107 implemented, frontend-invoke 83 verified, allowlist 0, skip 55, docs 189/188 documented
$ echo $?
0
$ python3 scripts/validate_repo.py
PASS repository identity: io.dbx.ssh 0.7.17-beta.1; standalone paths and vendored SDK present
$ git diff --check        # 无输出
```

### A.6 变更面

```
$ git status --porcelain
?? docs/IMPL_PLAN_DOCKER_DEEP.zh-CN.md
```

只有新增文档，未改任何源码/清单/生成物。

## 附录 B 引用索引

| 引用 | 位置 |
|---|---|
| docker 模块文档（CLI over shell、零依赖、动作安全模型） | `backend/src/docker.rs:1-12` |
| 超时常量 | `backend/src/docker.rs:24-29` |
| tail 上下限 | `backend/src/docker.rs:32-34` |
| EngineConfig / 字符白名单 / cli 校验 / 端点归一 | `backend/src/docker.rs:49-129` |
| `parse_engine` | `backend/src/docker.rs:134-160` |
| env 前缀（DOCKER_HOST/CONTAINER_HOST） | `backend/src/docker.rs:167-207` |
| 列表脚本 / Windows 兜底 | `backend/src/docker.rs:209-268` |
| PS 模板 / 旧版模板 / 标记 / PATH 加固 | `backend/src/docker.rs:272-298` |
| sudo 日志体 / 日志脚本 | `backend/src/docker.rs:303-339` |
| 动作枚举 / 解析 / 命令渲染 / id 门 / tail 钳制 | `backend/src/docker.rs:344-426` |
| 列表解析与 payload | `backend/src/docker.rs:428-587` |
| inspect 摘要 / 日志 payload / 权限签名 / sudo 错误 | `backend/src/docker.rs:592-675` |
| target / CLI 发现 / 本机 exec / 三个本机采集 / 审计 | `backend/src/docker.rs:682-1006` |
| docker 单测 | `backend/src/docker.rs:1008-1676` |
| 后端 docker 分派三臂 | `backend/src/main.rs:1488-1751` |
| 只读门 | `backend/src/ssh.rs:4405-4411` |
| 终端输入解码 + inputAck | `backend/src/main.rs:2572-2594`、`2747-2760` |
| 二进制帧 | `backend/src/model.rs:859-887`、`model.rs:4` |
| ReplayBuffer / 输入队列容量 | `backend/src/ssh.rs:1293-1344`、`2469` |
| SSH PTY 申请 / resize / Data 分流 | `backend/src/ssh.rs:2403-2413`、`2762`、`2853-2862` |
| 输出发布 | `backend/src/ssh.rs:11791-11805`、`local_terminal.rs:632-647` |
| 本地 PTY 泵 / ConPTY | `backend/src/local_terminal.rs:324-471`、`669` |
| 流任务配额 / 通道关闭 | `backend/src/monitor.rs:27`、`485-500`、`921-944` |
| 结构预算（后端） | `backend/src/structure_tests.rs:20-45` |
| 结构预算（前端） | `frontend/src/structure.spec.ts:22-31` |
| 协议 docker 节 | `docs/PROTOCOL.zh-CN.md:657-676` |
| 二进制通道清单 | `docs/PROTOCOL.zh-CN.md:678-693` |
| 串口回放 / 写回压先例 | `docs/PROTOCOL.zh-CN.md:747-763` |
| 前端输入队列契约 | `frontend/src/lib/terminalInputQueue.ts:1-50` |
| 前端回压 | `frontend/src/lib/terminalBackpressure.ts:54-95` |
| 前端分屏先例 | `frontend/src/composables/useSplitPanes.ts:1-20`、`frontend/src/components/SplitTerminalPane.vue:1-77` |
| 结构/迁移先例 | `docs/IMPL_PLAN_SSH_SPLIT.zh-CN.md:5-8` |
| mock 注册表检查 | `scripts/mock_host_registry_check.mjs:1-12` |
| 本机冒烟 | `scripts/smoke_docker_local.py:1-60` |

## 附录 C 参考实现对照补充（2026-11-27，对照 `apolloqi123/dbx-plugin-remotex`）

撰写本文时 `/tmp/remotex-probe` 已被系统清理，正文没有引用其代码；事后重新 clone 并对照，补三条**协议不变、但实现必须显式处理**的机制。下面引用的常量与函数名来自参考实现 `backend/src/features/docker/`，用来说明数量级与失败模式，不要求照搬其模块结构。

### C.1 日志分块聚合（落到 B3）

参考实现 `stream_batch.rs`：`MAX_BATCH_BYTES = 64 KiB`、`BATCH_INTERVAL = 100 ms`，任一到达即 flush；单个 fragment 不切分。其注释给出的理由是「否则一次 pipe read 一个事件，洪峰时每秒数百个事件」。它另带**增量 UTF-8 解码 carry**：多字节字符被批边界切断时，`from_utf8_lossy` 会产出 U+FFFD。

我们的主通道是二进制帧（§2.2），不存在 UTF-8 切断问题，但**聚合仍然必需**，否则 host bridge 事件率同样失控：

- `docker/logs_stream.rs` 内置纯函数 `ChunkBatcher`（64 KiB / 100 ms 起手，可在 `docker/tests.rs` 直接单测边界与 flush 时机）；
- `docker/logs/out/{streamId}` 每批一帧，`docker/logs/end` 之前必须 flush 残余；
- 仅当降级走 JSON `docker/logs/chunk`（§2.6）时，才需要参考实现的 UTF-8 carry，且必须与聚合在同一模块内保留跨批残余字节。

### C.2 子进程必须可回收（落到 B3 / B5）

参考实现用 `stop_runner(runner, stop_grace)`：先取消，超过 grace 再 SIGKILL；`supervised_follow_command` 在 HUP / TERM / stdin EOF / TTL watchdog 四处都回收子进程；并显式处理了「supervisor 自己被 SIGKILL、trap 跑不到」的路径——由 TTL 兜底。

我们的 docker 侧会长出三类子进程：`logs -f`、`exec -it`（PTY）、files 脚本。统一要求：

- 一个 supervisor 封装：`Child` + cancel watch + grace 后 `kill()`，开启 `kill_on_drop`；
- TTL 独立于取消路径，作为最后兜底（trap 可能不执行）；
- 测试必须包含「子进程忽略 SIGTERM，仍在 grace 后被 SIGKILL」，否则取消逻辑在容器内 `sh` 上会静默失效。

### C.3 关闭与迟到事件的竞态（落到 B3 / B5）

参考实现 `stream_registry.rs` 用 `closed_owners: HashMap<owner, Instant>` + `CLOSED_OWNER_TTL` 做**墓碑**：close 之后一段时间内同一 owner 的 start 直接被拒，避免「关闭后晚到的 open 把流复活」；并固定「先 registry 锁、后 closed 锁」的顺序防死锁，`cancel_owner` 只是快路径，真正的判重在注册时的墓碑检查。

我们的对应设计：

- `owner` 取 `sessionId` / `terminalId`，close 时写墓碑并带 TTL；
- start 固定流程「查墓碑 → 查活跃 → 注册」，命中墓碑立即返回 `closed` 且不建流；
- 墓碑过期用惰性 `retain`（在注册路径顺手做），不额外起定时任务；
- 必须有并发单测：同一 owner 交替 close/start，最终只能存在 0 或 1 条流，且不会出现「已关闭仍 emit」。

> 三条都不改变 §2 的协议与方法表，只影响 B3/B5 的实现细节与测试项；B1 不受影响。

