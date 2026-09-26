# 协议文档 ↔ 实现对账审计（2026-09-26）

- **范围**：M14–M21 快速迭代后的「协议文档 ↔ 实现」对账。核对域 = `sftp/read`、`sftp/write`、
  `sftp/createDirectory`、`sftp/rename`、`sftp/delete`、`sftp/exists`、`sftp/touch`、
  `sftp/download/tree/start`、`sftp/download/start`、`watch/start`、`watch/upload` 的 PROTOCOL
  描述（参数/返回/latin-1 行为/错误语义）vs `backend/src/main.rs` 分发层、`backend/src/ssh.rs`、
  `backend/src/sftp_ext.rs`、`backend/src/file_watch.rs`；外加 PROGRESS M19.5/M20/M21 登记
  行为与 PROTOCOL 正文的一致性、FEATURE_PARITY 的计数口径。
- **基线**：integration head `2c963ba5`（分支 `codex/ssh/parity-np22-protocol-audit`）。
- **方法**：逐方法 grep/读源码核实（main.rs 分发臂 → ssh.rs/sftp_ext.rs/mcp.rs/file_watch.rs
  实现 → git 历史定位批次），全部结论有代码出处；不凭印象。
- **本批约定**：纯文档审计——只修文档层错误；实现层疑点仅登记，不改任何 `.rs/.ts/manifest`。

## 结论概要

发现差异 **12 条**：**已修文档 8 处**（PROTOCOL 6 处、FEATURE_PARITY 2 处），**仅登记 4 条**
（实现层不一致 / 计数漂移，待人工确认）。核心文档错误集中在三类：
① latin-1 车道的批次标注漂移（文档声明早于或晚于真实落地批次）；
② 「raw 失败自动回退高层」的回退语义被过度泛化到下载车道（实际下载车道无回退）；
③ `watch/*` 方法族在 PROTOCOL 完全缺文档、`sftp/download/start` 的 saveToLocal+offset
互斥错误语义缺记。

## 已修文档（8 处）

| # | 位置 | 差异点 | 严重度 | 处理 |
| --- | --- | --- | --- | --- |
| F1 | PROTOCOL `sftp/read` 节 | 「文件名编码（M19 收口）」批次标注错误：latin-1 读车道实际由 M19.5 落地（`769785b3` "READDIR type code must be 12; latin-1 lanes for read + tree download"，对应 PROGRESS M19.5 第 2 条「`sftp/read` 缺 latin-1 车道：M16 编码家族唯一漏网」）。M19 批次（parity-np19-mcp-io）只覆盖 MCP `sftp_upload`/`sftp_download` | 低 | 已修：改为「M19.5 落地」 |
| F2 | PROTOCOL 「递归目录下载」节 latin-1 段 | 「分块下载按转义自动走 raw READ」在 M15-B 写入正文，但该行为 M19.5 才真正落地（`ssh.rs` `TreeDownloadState.latin1` + `raw_read_chunk`，见 PROGRESS M19.5 第 3 条：此前转义名逐文件高层 open → NO_SUCH_FILE 记失败跳过、本地只剩空目录骨架）。表述与实现同步但无批次标注，回溯读文档会误以为 M15-B 即可用 | 中 | 已修：标注「该车道 M19.5 才真正落地」并补此前行为 |
| F3 | PROTOCOL `sftp/list` 节 M14-B/M15-B 段 | 「raw 路径失败（服务器版本协商/异常包）自动回退高层客户端」紧跟下载句之后，读起来覆盖下载车道——**与实现不符**：`ssh.rs` `start_download` 的 raw STAT size 探测与 `download_chunk` 的转义分支 `raw_read_chunk` 失败均 `?` 原样上抛、任务失败，**无任何回退**（转义名高层客户端本就打不开，回退只会重演 NO_SUCH_FILE）。回退仅存在于：列表 raw 读侧（读安全）与写路径裸包客户端**建立**失败（M15 先例） | 中 | 已修：改写为按车道区分的回退口径，并补「start size 探测整条还原走裸包 STAT——M21 收口」（M21 第五层 wire 缺口修复，见 PROGRESS） |
| F4 | PROTOCOL RPC 表 `sftp/stat`/`sftp/exists` 行 | 「latin-1 下 `sftp/stat`/`sftp/exists` 整条 wire 还原走裸包 LSTAT」对 exists 不准确：exists 缺省按「wire 前缀 + 显示末段」分工（`write_path_bytes`），仅 `form: "wire"` 时整条还原（`unescape_wire`）——`sftp_ext.rs::exists` 与该节下文自身均如此，仅 RPC 表行过度概括 | 低 | 已修：按 `form` 分工改写 |
| F5 | PROTOCOL 整体 | **`watch/start`、`watch/stop`、`watch/stop-all` 完全不在 RPC 方法表，watch 族无任何专节**：`file_watch.rs` 的完整契约（remote-edit 路径来源门禁、500ms 防抖、2s 启动抑制窗、SHA-256 基线指纹、`watch/file-modified` 事件负载、64 MiB 指纹/回写上限、watchId 去重与会话回收、`watch/upload` 原子提交与 latin-1 回写）只有 `watch/upload` 在 RPC 表写操作行里混提一笔。PROGRESS M20/M21 登记了 watcher 收口，但正文无对应协议描述 | 中 | 已修：RPC 表补 `watch/*` 行 + 新增「外部编辑器 watcher（watch/*）」专节（逐条对照 `file_watch.rs`/`main.rs` 撰写） |
| F6 | PROTOCOL 「断点续传」节 | `sftp/download/start` 的错误语义缺记：`saveToLocal: true` 与 `offset > 0` 组合直接报错 `Local save downloads cannot resume from an offset`（`ssh.rs::start_download`）。本地落盘不支持续传是调用方可遇的硬错误 | 低 | 已修：补记互斥语义 |
| F7 | FEATURE_PARITY 文首 | 「68 个分发方法臂、69 个方法名（2026-08-29 收口复核）」作为「插件现状」已严重过时：当前 `handle_request` 分发块（main.rs:166 起）为 **182 臂 / 183 名**（`ssh/host-key/resolve` 与 `connection/challenge/resolve` 仍共用一臂，main.rs:792；含 watch/*、sftp/download/tree/start、sudo/download/*、rdp/*、serial/*、docker/*、filesystem/* 等） | 中 | 已修：更新为 182/183 并保留旧口径出处 |
| F8 | FEATURE_PARITY 「候选缺口」表 | 「每连接编码选择——现无连接级编码覆盖」为**假陈述**：M16 已交付连接级覆盖（偏好键 `sftp_name_encoding_overrides`，PROTOCOL `local/preferences` 行与 `sftp/list` 节均有），2026-09-25 清理注也未同步该行 | 中 | 已修：删行 + 清理注补记 |

## 仅登记，待人工确认（4 条，未改任何代码）

| # | 位置 | 疑点 | 严重度 | 处理 |
| --- | --- | --- | --- | --- |
| R1 | `sftp_ext.rs::exists`（工作台 RPC `sftp/exists`）vs `mcp.rs::raw_sftp_exists`（MCP 工具 `sftp_exists`） | **两个 exists 面的错误语义不一致**：MCP 面 latin-1 裸包分支只把 `SSH_FX_NO_SUCH_FILE` 映射为「不存在」、其余错误如实上抛（PROTOCOL M18 段声明的「权限错误绝不误报 exists:false」契约）；工作台 RPC 的 exists 无论 auto（`symlink_metadata(...).is_ok()`）还是 latin-1 裸包分支都把**任何** LSTAT 错误（含权限拒绝、通道异常）映射为 `exists: false`。PROTOCOL `sftp/exists` 节只写了「路径不存在不算错误」，未声明权限错误下的表现。拉齐方向（工作台面对齐 NO_SUCH_FILE-only）属实现行为变更，本批不动 | 中 | **已处理（M23 批）**：工作台面 auto 与 latin-1 两分支均对齐 NO_SUCH_FILE-only（`sftp_ext.rs::exists`），前端三个预检调用方按既有「无法判定、不阻断」惯例消化新错误路径；PROTOCOL `sftp/exists` 节补权限错误语义 |
| R2 | `backend/src/main.rs` `sftp/read` 分发臂注释 | 代码注释写「latin-1（M16 收口）」，实际车道 M19.5 落地（同 F1）。注释漂移不影响行为，但会误导后续考古；随下次代码改动顺带修正即可 | 低 | **已修（M23 批）**：改为「latin-1 车道（M19.5 落地）」 |
| R3 | `sftp/read` latin-1 车道 | `raw_read_chunk` 不经 `normalize_remote_path`（auto 车道经），`~` 展开/相对路径归一在 latin-1 下不发生。wire 契约下前端恒传列表回传的绝对路径，实际风险低；若要统一属实现变更 | 低 | 仅登记 |
| R4 | FEATURE_PARITY MCP 工具数口径 | 「29 工具齐（0.4.61）」「29→31（NetCatty 批）」均为带日期的历史口径，当前 `tool_definitions()` 实际注册 **33 个工具**（含 `docker_action`/`docker_list`）。行为描述未错，建议后续收口轮统一为「当前 33」口径 | 低 | **已补注（M23 批）**：两处历史口径保留出处、补注当前实际 33（含 `docker_action`/`docker_list`） |

## 核对通过、无需处理的代表项

以下 PROTOCOL 声明逐条对过实现，一致（抽样列举，均为本批范围重点）：

- `sftp/read`：`offset` 缺省 0、非法值回退（`optional_u64`）；`maxBytes` 缺省 256 KiB、
  钳制 1..=1 MiB（`bounded_bytes`）；`max_bytes + 1` 探测后截断对齐 `truncated` 语义；
  offset ≥ EOF 空读不报错（auto seek 语义 + raw `requested=0`/EOF 回空）。
- `sftp/write`：`.dbx-part-<uuid>` 暂存 → 原子 rename、权限位保留；4 MiB 直写上限
  （`ensure_direct_write_size`，恰 4 MiB 边界通过）；latin-1 整条 `unescape_wire` 还原。
- `sftp/createDirectory` / `sftp/rename` / `sftp/delete`：latin-1 路径分工与 M15-B 段一致
  （`write_path_bytes` = wire 前缀还原 + 末段显示编码；`>U+00FF` UTF-8 兜底；字面 `%XX`
  保持字面量）；回退仅裸包客户端**建立**失败；delete 判型 LSTAT、symlink 不跟随、
  `recursive: true` 树删。
- `sftp/exists`：`form: "wire"`（M17）两分支与文档一致。
- `sftp/touch`：已存在 best-effort SETSTAT 刷时间（失败容忍）、不存在 OPEN(CREAT|WRITE)。
- `sftp/download/tree/start`：BFS 有界（50 000 文件 / 10 000 目录 / 深度 64 / 单文件 16 GiB，
  `sftp_tree.rs`）；返回 `{taskId, fileName, size, chunkSize, fileCount, dirCount, skippedCount}`；
  空目录保留、根名让位 `" (n)"`、聚合进度事件带 `fileCount/fileIndex/currentFile`、
  队列耗尽回空 eof 块——均与正文一致；latin-1 树扫描裸包 READDIR 建立失败回退高层遍历（读安全）。
- MCP M19 段（`sftp_upload`/`sftp_download` latin-1）：直写/LSTAT 预检/`maxDownloadBytes+1`
  探测封顶/目录 OPEN 落回高层给「is a directory」/download 读侧全回退 + upload 写侧仅建立失败回退
  ——与 `mcp.rs` 实现逐条一致。
- M18 段 `sftp_exists` 的 NO_SUCH_FILE-only 映射（MCP 面）与实现一致（不一致的是工作台 RPC
  面，见 R1）。
- PROGRESS M19.5/M20/M21 登记的三个行为（sftp/read 车道、树逐文件 raw 车道、download start
  size 探测转义还原）现已全部反映到 PROTOCOL 正文（本批 F1/F2/F3 补齐批次标注）。

## 复核口径备注

- 182/183 的清点方式：`handle_request`（main.rs:166 起）`match method` 顶层字符串臂
  （12 空格缩进）去重后 182 个，其中 `"ssh/host-key/resolve" | "connection/challenge/resolve"`
  一臂两名，故方法名 183。
- MCP 工具数 33 的清点方式：`tool_definitions()`（mcp.rs）内 `"name": "…"` 去重计数。
