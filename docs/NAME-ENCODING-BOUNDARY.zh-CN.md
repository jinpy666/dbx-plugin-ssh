# latin-1 字节保真边界矩阵（远端路径入口总表）

> 基线：`d9133e94`（分支 `codex/ssh/parity-np26-byte-boundary-matrix`）。本文是 M14–M25 迭代后 latin-1
> 文件名编码家族字节保真状态的**单一事实总表**：逐入口一行，登记插件全部接受远端路径参数的入口。
> 既有分散登记（PROTOCOL「仍按字面量发送的残留点」「设计边界（登记）」、PROGRESS M15–M25 各批次段）
> 仍然有效；本文与它们冲突时以实现为准并在「疑点」节提出。

---

## 1. 判定口径

| 标记 | 含义 | 路径参数的实际去向 | 典型后果 |
| --- | --- | --- | --- |
| ✅ | **裸包 SFTP 车道** | 路径参数在插件内还原为**服务器原始字节**（`unescape_wire` / `write_path_bytes` / `latin1_encode_display`，`backend/src/sftp_name.rs`），装进 SFTP 协议帧（SSH_FXP_*）发送，不经任何 shell | 非 UTF-8 文件名（如 latin-1 编码的 `caf%E9.txt` ↔ 字节 `café.txt`）读写改名删除均逐字节保真 |
| ⚠️ | **shell 拼装车道** | 路径参数先 `normalize_remote_path`（`backend/src/model.rs:954`：绝对化 + 去 `.`/`..`/空段 + 拒空/拒 NUL，不做 `~` 展开），再 `shell_quote`（`backend/src/exec.rs:1217`）后拼进 SSH exec 命令串 | 命令串是 UTF-8 String 边界：latin-1 单字节名（wire 形式 `%XX` 或非 ASCII 显示文本）被远端 shell/进程按 locale 重解释，字节层面不可控。**clean 名（纯 ASCII）行为不变**；转义名/非 ASCII 名由远端报错（`No such file` 类） |
| ❌ | **字面量发送** | 路径参数（或命令文本）按调用方原样字符串发送，插件不做编码还原 | 含 `%XX` 转义或非 UTF-8 字节的路径无法命中远端真实文件；适用面是自由命令文本（`ssh/exec`、agent），不在「路径参数」语义之内 |

补充口径：

- **归一**：`normalize_remote_path` 是纯字符级清洗（不涉及编码还原），✅/⚠️ 两类入口都应做；矩阵「归一」列标注该入口有无。
- **编码判定**：连接级优先链——连接覆盖 `sftp_name_encoding_overrides` > 全局偏好 `sftp_name_encoding` > 缺省 `auto`（工作台 `main.rs:117 resolve_sftp_encoding`；MCP `mcp.rs:3270 mcp_sftp_encoding`）。`auto` 模式下 ✅ 入口走高层客户端（russh-sftp），合法 UTF-8 服务器字节往返无损——本矩阵只登记 **latin-1 生效时**的通道归属。
- **回退策略**（不影响归属判定）：读操作裸包路径任何失败回退高层（读安全）；写操作仅裸包客户端**建立**失败回退，操作已发出后的失败原样上抛（不重复执行）——M15 先例，全家族一致。

---

## 2. 矩阵 A：工作台 RPC · SFTP 协议车道（全部 ✅）

分发层均在 `backend/src/main.rs`；实现层按「来源」列的 文件:行号。latin-1 生效时全部走裸包客户端
（`backend/src/sftp_raw.rs`，独立 sftp 子系统通道、严格串行；原始方法见 `sftp_raw.rs:423 readdir`、
`:461 stat`、`:564 lstat`、`:581 remove`、`:592 open_write`、`:630 setstat`、`:647 readlink`、
`:671 symlink`、`:694 mkdir`、`:712 rename`）。

| 入口（工作台 RPC） | MCP 对应 | 路径参数 | 归一 | 字节保真 | 备注 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `sftp/list` | `sftp_list_dir` | `path` | ✅ | ✅ 裸包 READDIR，条目名 latin-1 解码显示、uri 为 `%XX` wire 形式；裸包失败回退高层（读安全） | 归一在分发前由 `sftp_list_path` 完成 | `main.rs:822` → `ssh.rs:4290`（归一 4297；`raw_list_entries` `ssh.rs:4383`，`readdir(path.as_bytes())` 4390） |
| `sftp/read` | `sftp_read_file` | `path`（整条 wire） | ✅ | ✅ latin-1 整条 `unescape_wire` 后裸包 READ（`raw_read_chunk`）；多读 1 字节对齐 truncated 语义 | auto 走高层 `sftp_read_path` | `main.rs:839` → `ssh.rs:4434`（归一 4444、unescape 4445） |
| `sftp/createDirectory` | `sftp_mkdir` | `path`（wire 前缀 + 显示末段） | ✅ | ✅ `write_path_bytes` 组装字节后裸包 MKDIR | 写侧仅客户端建立失败回退 | `main.rs:864` → `ssh.rs:4478`（归一 4485、`write_path_bytes` 4493） |
| `sftp/rename` | `sftp_rename` | `sourcePath`（整条 wire）/ `targetPath`（显示末段） | ✅（双侧） | ✅ 源 `unescape_wire`、目标 `write_path_bytes`，裸包 RENAME | 同上 | `main.rs:873` → `ssh.rs:4552`（归一 4560–4561；unescape 4568 / write_path_bytes 4569） |
| `sftp/chmod` | `sftp_chmod` | `path`（整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后裸包 SETSTAT（permissions 子集） | 同上 | `main.rs:884` → `ssh.rs:4648`（归一 4656、unescape 4662） |
| `sftp/stat` | `sftp_stat` | `path`（整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后裸包 LSTAT | 属主/属组经 `stat -c` shell 查询尽力而为（shell 字节边界，失败显示 `-`，主体元数据不受影响） | `main.rs:909` → `sftp_ext.rs:42`（归一 48、unescape 53） |
| `sftp/exists` | `sftp_exists` | `path`；`form:"wire"` 时整条 wire，缺省「wire 前缀 + 显示末段」 | ✅ | ✅ 分别按 `unescape_wire` / `write_path_bytes` 还原后裸包 LSTAT；只认 NO_SUCH_FILE 为不存在（M23/R1） | 两形态共用同一裸包分支 | `main.rs:917` → `sftp_ext.rs:138`（归一 145；unescape 150 / write_path_bytes 152） |
| `sftp/rename-unique` | — | `dir`（wire）/ `name`（显示文本） | ✅ | ✅ `dir` 整条还原、`name` 连同 `(n)` 候选 `latin1_encode_display` 编码，裸包 LSTAT 逐候选探测 | 返回名保持显示形式，落盘侧 `write_path_bytes` 编出同一组字节 | `main.rs:931` → `sftp_ext.rs:216`（归一 223） |
| `sftp/touch` | — | `path`（wire 前缀 + 显示末段） | ✅ | ✅ `write_path_bytes` 还原后裸包 LSTAT/SETSTAT/OPEN(creat\|write\|trunc) | 时间刷新尽力而为 | `main.rs:942` → `sftp_ext.rs:271`（归一 278、write_path_bytes 282） |
| `sftp/symlink-create` | — | `target`（原文，允许相对）/ `linkPath`（wire 前缀 + 显示末段） | ✅（仅 linkPath） | ✅ `linkPath` 按 `write_path_bytes` 还原、`target` 按字符串字节装包，裸包 SYMLINK（OpenSSH wire 次序） | `target` 归一会破坏相对链接语义，有意跳过 | `main.rs:954` → `sftp_ext.rs:539`（归一 548、write_path_bytes 553） |
| `sftp/symlink-read` | — | `linkPath`（整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后裸包 READLINK，指向文本 latin-1 显示解码 | 读↔写在 latin-1 域内闭环 | `main.rs:964` → `sftp_ext.rs:585`（归一 591、unescape 595） |
| `sftp/symlink-update` | — | `linkPath`（整条 wire）/ `target`（显示文本） | ✅（仅 linkPath） | ✅ link `unescape_wire`、target `latin1_encode_display`，read-compare 后裸包 REMOVE+SYMLINK | v3 无 re-link 原语，remove+recreate 实现 | `main.rs:972` → `sftp_ext.rs:628`（归一 637；unescape 641、encode 642） |
| `sftp/write` | `sftp_write_file` | `remotePath`（整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后裸包暂存（`.dbx-part-<uuid>`）+ 原子提交 | wire 的 `%` 自转义保证字面 `%XX` 名往返不变 | `main.rs:982` → `sftp_ext.rs:334` → `write_bytes:351`（归一 359、unescape 365） |
| `sftp/upload-local` | — | `remotePath`（watcher 登记的整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后裸包暂存 + 原子提交 | 本地文件先经 `validate_remote_edit_path` 源校验 | `main.rs:1040` → `sftp_ext.rs:1220`（归一 1239、unescape 1247） |
| `watch/upload` | — | watcher 登记的 `remotePath`（整条 wire） | ✅ | ✅ 复用 `sftp_ext::write_bytes`，latin-1 按所属连接编码走裸包回写（M21） | watchId 是 bearer token；本地源 `validate_local_origin` 重校验 | `main.rs:1080` → `file_watch.rs:471`（→ `sftp_ext.rs:519` write_bytes） |
| `sftp/copy` | `sftp_copy` | `from`/`toDir`（wire 形式） | ✅（`parse_request` 内 `normalize`，`sftp_copy.rs:157,172`） | ✅ 覆盖预检逐个裸包 LSTAT（`PathForm::WireEscaped` 还原，`sftp_copy.rs:53`）；同目录 move 快路径裸包 RENAME（`sftp_copy.rs:462–480`） | **执行层边界（登记）**：底层远端 `cp -a --`/`mv -f --` 是 shell 拼装（`sftp_copy.rs:217–234`），UTF-8 String 命令串不做字节保真迁移；预检/快路径已收口 | `main.rs:1089` → `sftp_copy.rs:330 run`、`execute_with:367`（预检裸包 407–415） |
| `sftp/move` | `sftp_move` | 同 `sftp/copy` | ✅ | ✅ 同上（同目录 RENAME 快路径；跨目录回落 shell `mv`——执行层同上边界） | SFTPv3 RENAME 不覆盖已存在目标，撞名回落 shell | `main.rs:1103` → `sftp_copy.rs:330` |
| `sftp/delete` | `sftp_remove` | `path`（整条 wire） | ✅ | ✅ 整条 `unescape_wire` 后 `raw_delete_path`（LSTAT 判型 → REMOVE/RMDIR/递归树删，symlink 绝不跟随） | 树删 `raw_delete_path` `ssh.rs:8477` | `main.rs:1582` → `ssh.rs:4589`（归一 4597、unescape 4604） |
| `sftp/upload/start` | — | `remotePath`（wire 前缀 + 显示末段） | ✅（`ssh.rs:5379`） | ✅（落盘阶段） | start 本身只落本地 spool、不发远端请求；字节保真在 finish 执行。**有意选型（M28-A）**：只写本地 spool，字节保真在 finish 执行（`ssh.rs:5618`），无 latin-1 分支非缺口 | `main.rs:1596` → `ssh.rs:5359` |
| `sftp/upload/finish` | — | start 登记的 `remotePath` | ✅（承 start） | ✅ latin-1 走 `raw_push_upload_file`：`write_path_bytes` 还原后裸包暂存 + 原子提交 | 裸包建立失败回退高层暂存 | `main.rs:1616` → `ssh.rs:5618`（raw 分支 5673–5681）→ `sftp_ext.rs:895`（write_path_bytes 903） |
| `sftp/download/start` | — | `remotePath`（整条 wire） | ✅（`ssh.rs:6007`） | ✅ latin-1 生效且含转义时整条 `unescape_wire` 后裸包 STAT 取真实字节数（M21 收口）；车道判定按生效编码收口在 `has_wire_lane`（`sftp_name.rs`，M28-B 修 D-7）——**auto 一律走高层客户端**（auto 列表 uri 字面 `%` 未经 `%25` 自转义，wire 串里的 `%XX` 是文件名字面量，不能还原）；下载车道 raw 失败**不回退**（回退只会重演同一错误） | 字面 `%XX` 歧义已裁决：latin-1 下载车道 wire 形式为排他契约（D-1 闭环，M27-A）；auto/回退列表 uri 未自转义的往返缺口**已修（M28-B）**，见 D-7 | `main.rs:1624` → `ssh.rs:5999`（编码判定 main.rs 1637、判分支 6030、raw stat 6037） |
| `sftp/download/tree/start` | — | `remotePath`（整条 wire） | ✅（`ssh.rs:6123`） | ✅ latin-1 整树裸包 READDIR 遍历（`scan_tree_with_raw`，`ssh.rs:8386`），本地根名按原始字节解码显示 | 裸包建立失败回退高层遍历（读安全） | `main.rs:1651` → `ssh.rs:6109`（unescape 6146） |
| `sftp/download/next` | — | start 登记的 `remotePath`（树模式为逐文件 wire 路径） | ✅（`raw_read_chunk` 内，M24/R3） | ✅ 单文件 latin-1 转义路径裸包 READ（每 chunk 独立 open/close，按 start 登记的生效编码 `download.latin1` 判——M28-B 修 D-7，auto 一律高层）；树模式 latin-1 分支同样 `raw_read_chunk`（`ssh.rs:6344–6354`） | latin-1 车道按 D-1 裁决维持 wire 契约（M27-A）；auto 判分支已按编码区分（M28-B） | `main.rs:1678` → `ssh.rs:6465`（判分支 6501 → raw 6502） |

小计：**24 个 ✅ 入口**。

---

## 3. 矩阵 B：工作台 RPC · shell 拼装车道（⚠️）与自由命令（❌）

本族路径参数先归一再 `shell_quote` 进 exec 命令串（UTF-8 String 边界）。**这些入口本就没有
wire 形式的名字来源**（不消费 latin-1 列表回传的 `%XX` 转义），latin-1 下维持字面量发送、
由远端报错（PROTOCOL 431 行登记）。sudo 族统一经 `runtime.exec(..., sudo=true, ...)`
（`sudo_fs.rs:40 sudo_exec` → `ssh.rs:3565 exec` → `exec.rs exec_with_sudo`）。

| 入口（工作台 RPC） | MCP 对应 | 路径参数 | 归一 | 字节保真 | 备注 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `sftp/diskUsage` | `sftp_disk_usage` | `path` | ✅ | ⚠️ `df -kP '<path>'`（归一后 `shell_quote` 拼命令） | 只读；命令串无 client setEnv，输出解析与 locale 解耦 | `main.rs:903` → `ssh.rs:4688`（归一 4690、拼命令 4691） |
| `sftp/archive` | — | `sourcePaths[]` / `archivePath` | ✅（`clean_source_paths` `sftp_ext.rs:1026`；`normalize` 476） | ⚠️ `tar -czf '<tmp>' -C '<parent>' '<rel>'...`（`build_archive_command` `sftp_ext.rs:1082`，全参 `shell_quote`）；tar 成功后 SFTP rename 落位 | 归档名含转义/非 ASCII 字节时远端 tar 报错 | `main.rs:998` → `sftp_ext.rs:416` |
| `sftp/extract` | — | `archivePath` / `destinationPath` | ✅（`sftp_ext.rs:476–477`） | ⚠️ `tar -t[z]f '<archive>'` 预检 + `mkdir -p '<dest>' && tar -x[z]f '<archive>' -C '<dest>'`（`sftp_ext.rs:1097/1103`） | overwrite=false 的撞名预检走高层 SFTP symlink_metadata（字面量语义） | `main.rs:1020` → `sftp_ext.rs:472` |
| `sudo/stat` | — | `path` | ✅（`sudo_fs.rs:141`） | ⚠️ `stat -c '<fmt>' -- '<path>'`（GNU 失败回落 BSD `stat -f`） | sudo 族自带 `shell_quote`（`sudo_fs.rs:27`，与 `exec.rs:1217` 文本等价） | `main.rs:1375` → `sudo_fs.rs:140` |
| `sudo/exists` | — | `path` | ✅（180） | ⚠️ `test -e '<path>' && echo 1 \|\| echo 0` | | `main.rs:1381` → `sudo_fs.rs:178` |
| `sudo/touch` | — | `path` | ✅（187） | ⚠️ `touch -- '<path>'` | | `main.rs:1389` → `sudo_fs.rs:186` |
| `sudo/listDir` | — | `path` | ✅（375） | ⚠️ `ls -la --time-style=+%s -- '<path>'`（376，回落 380） | 名字来源是 `ls` 文本输出，本无 wire 形式 | `main.rs:1396` → `sudo_fs.rs:374` |
| `sudo/readFile` | — | `path` | ✅（405） | ⚠️ `cat -- '<path>'` / `head`/`tail -c` 拼接（408–423） | | `main.rs:1402` → `sudo_fs.rs:398` |
| `sudo/writeFile` | — | `path` | ✅（458） | ⚠️ `: > '<path>'`（469）+ base64 载荷经 stdin 管道（452–489） | 载荷走 stdin 不进命令串，路径仍进 | `main.rs:1411` → `sudo_fs.rs:452` |
| `sudo/mkdir` | — | `path` | ✅（492） | ⚠️ `mkdir -p -- '<path>'`（493） | | `main.rs:1423` → `sudo_fs.rs:491` |
| `sudo/remove` | — | `path` | ✅（501） | ⚠️ `rm -f -- '<path>'`（502） | | `main.rs:1430` → `sudo_fs.rs:500` |
| `sudo/removeAll` | — | `path` | ✅（512） | ⚠️ `rm -rf -- '<path>'`（516） | | `main.rs:1437` → `sudo_fs.rs:511` |
| `sudo/chmod` | — | `path` | ✅（540） | ⚠️ `chmod <mode> -- '<path>'`（542） | | `main.rs:1444` → `sudo_fs.rs:534` |
| `sudo/rename` | — | `sourcePath` / `targetPath` | ✅（555–556） | ⚠️ `mv -- '<src>' '<tgt>'`（557） | | `main.rs:1452` → `sudo_fs.rs:549` |
| `sudo/download/start` | — | `path` | ✅（`sudo_download.rs:139`） | ⚠️ 暂存链 `mktemp -- '<dir>/...XXXXXXXX'`、`cat -- '<src>' > '<tmp>'`、`chown/chmod`（`sudo_download.rs:74/112/119`）；**暂存后的分块读走 SFTP**（复用 `sftp/download/next` 管线，但对象是 ASCII 临时件路径） | 根文件下载先 sudo 复制为同目录 0600 临时件 | `main.rs:1464` → `ssh.rs:5891` → `sudo_download.rs:134 stage_source` |
| `ssh/exec` | `ssh_exec`/`ssh_exec_sudo`/`ssh_run_bg` | `command`（完整命令文本） | —（无路径参数） | ❌ 自由命令文本按原样发送 | **天然超出字节保真语义**：路径只是命令文本的子串，插件无从区分「路径参数」；用户可在命令内自行还原编码。sudo 面受连接级 allowlist 门禁（`main.rs:408–412`） | `main.rs:403` → `ssh.rs:3565` |
| agent exec（`exec_in_terminal` 终端注入路由） | — | `command`（完整命令文本） | — | ❌ 命令经 `sanitize_command`（去控制字符）后注入交互 PTY，按键盘输入语义执行 | 同上：自由命令文本；注入前有 approval 挑战与 agent-exec 串行锁 | `ssh.rs:3743` |

小计：**15 个 ⚠️ 入口 + 2 个 ❌（自由命令）**。

---

## 4. 矩阵 C：MCP 工具面（`backend/src/mcp.rs`，与工作台对齐情况）

M25 已把全部接受远端路径参数的 SFTP 工具分发臂统一 `normalize_remote_path`
（latin-1 臂归一发生在 `latin1_encode_display` 还原**之前**；helper `raw_sftp_*` 族内部不重复归一）。
latin-1 名字口径为**显示形式**：`latin1_encode_display`（`sftp_name.rs:186`）是 latin-1 解码的精确逆变换，
AI 把列表返回的 `path` 原样回传即落回服务器原始字节（往返闭环，单测覆盖）。

| MCP 工具 | 工作台对应 | 路径参数 | 归一 | 字节保真（latin-1 生效时） | 备注 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `sftp_list_dir` | `sftp/list` | `path` | ✅（M25，2346） | ✅ 裸包 READDIR（`latin1_encode_display` 还原 2354），返回显示形式 `name`/`path`；裸包任何失败回退高层 | 与工作台同源 | `mcp.rs:2342` |
| `sftp_stat` | `sftp/stat` | `path` | ✅（2404） | ✅ 裸包 LSTAT（2414）；uid/gid 经 shell 查询尽力而为（shell 字节边界，可能 `null`） | 不跟随 symlink，与工作台同口径 | `mcp.rs:2402` |
| `sftp_exists` | `sftp/exists` | `path` | ✅（2445） | ✅ 裸包 LSTAT（`raw_sftp_exists` 2452 → `mcp.rs:3349`），只认 NO_SUCH_FILE | 与工作台 M23/R1 契约一致 | `mcp.rs:2443` |
| `sftp_pwd` | `sftp/home` | 无路径参数 | — | —（N/A） | 高层 `canonicalize(".")`；家目录名非 UTF-8 时返回串可能已 lossy（见疑点 D-3） | `mcp.rs:2473`；工作台 `ssh.rs:3505` |
| `sftp_read_file` | `sftp/read` | `path` | ✅（2485） | ✅ 裸包 OPEN(READ)+READ（`raw_sftp_read_file` 2503 → `mcp.rs:3367`），32 KiB 分块；任何失败回退高层重读 | | `mcp.rs:2483` |
| `sftp_write_file` | `sftp/write` | `path` | ✅（2544） | ✅ 裸包 OPEN(CREAT\|WRITE\|TRUNC) 直写（`raw_sftp_write_file` 2564 → `raw_sftp_write_bytes` `mcp.rs:3429`）；覆盖预检与写入同字节口径 | MCP 面直写语义（无 `.dbx-part` 暂存需求） | `mcp.rs:2542` |
| `sftp_mkdir` | `sftp/createDirectory` | `path` | ✅（2596） | ✅ 显示路径整条 `latin1_encode_display` 后裸包 MKDIR（2605） | | `mcp.rs:2594` |
| `sftp_remove` | `sftp/delete` | `path` | ✅（2626） | ✅ 裸包 LSTAT 判型（2634）→ REMOVE/递归树删（复用 `ssh.rs:8492 raw_delete_tree`） | symlink 绝不跟随 | `mcp.rs:2624` |
| `sftp_rename` | `sftp/rename` | `sourcePath`/`targetPath` | ✅（双侧，2678–2679） | ✅ 双侧 `latin1_encode_display` 后裸包 RENAME（2690–2691） | 源 = 列表回传显示路径、目标 = AI 新输入 | `mcp.rs:2675` |
| `sftp_chmod` | `sftp/chmod` | `path` | ✅（2717） | ✅ 裸包 SETSTAT（`raw_sftp_chmod` 2730 → `mcp.rs:3464`） | | `mcp.rs:2715` |
| `sftp_copy` / `sftp_move` | `sftp/copy` / `sftp/move` | `from`/`toDir` | ✅（`sftp_copy::parse_request` 内 `normalize`，`sftp_copy.rs:157,172`） | ✅ 裸包车道按 `PathForm::Display` 还原（`sftp_copy.rs:53–54`）：覆盖预检裸包 LSTAT + 同目录 move 裸包 RENAME | **执行层边界同工作台**：远端 `cp`/`mv` exec 层字面量发送（`mcp.rs:2768–2774` 注释登记） | `mcp.rs:2751` → `sftp_copy.rs:363 execute` |
| `sftp_disk_usage` | `sftp/diskUsage` | `path` | ✅（M25，1631） | ⚠️ `df -kP '<path>'`（拼命令 1633，exec_plain 1636）——与工作台同口径的 shell 车道 | M25 只补归一，不迁移通道（与工作台一致地保持 ⚠️） | `mcp.rs:1628` |
| `sftp_upload` | `sftp/upload` 族（语义对齐） | `remotePath`（`localPath` 为本地参数不归一） | ✅（M25，2815） | ✅ 裸包直写（M19：`raw_sftp_write_bytes`，2863）；覆盖预检同字节口径；仅客户端建立失败回退 | 本地路径校验/传输根约束先于拨号 | `mcp.rs:1510` → `sftp_upload_tool:2810` → `upload_via_sftp:2840`（latin-1 分支 2858） |
| `sftp_download` | `sftp/download`（单文件语义） | `remotePath` | ✅（M25，2908） | ✅ 裸包 OPEN(READ)+READ（M19：`raw_sftp_read_file`，2989）；读侧任何失败回退高层重读 | `maxDownloadBytes+1` 探测封顶；**目录探测有意选型（M28-A）**：不单独裸包 STAT，依赖 OPEN 被拒回退（`mcp.rs:2979–2984`），与 auto 报错语义一致 | `mcp.rs:1511` → `sftp_download_tool:2902` → `download_via_sftp:2966`（latin-1 分支 2985） |
| `ssh_exec` / `ssh_exec_sudo` / `ssh_multi_exec` / `ssh_terminal_input` | `ssh/exec`、agent | `command` 文本 | — | ❌ 自由命令文本，同工作台 `ssh/exec` 口径 | confirm-gated（`mcp.rs:345–346`） | `mcp.rs:1609–1617` |

小计：**13 个 ✅ + 1 个 ⚠️（sftp_disk_usage）+ 1 个 N/A（sftp_pwd）+ 4 个 ❌（exec 族）**。

### 工作台 vs MCP 对齐一览

- ✅ **字节保真对齐**：list/read（读）、mkdir/remove/rename/chmod/write（写）、copy/move（预检+快路径）、upload/download（传输）——两车道、两编码口径一致（M17–M19、M24–M25 收口）。
- ⚠️ **共同受限**：`sftp_disk_usage`（两车道同走 `df -kP` shell 拼装，M25 仅补归一）。
- **口径差异（有意，登记于实现注释）**：工作台 copy/move 路径为 wire 形式（`PathForm::WireEscaped`），MCP 面为显示形式（`PathForm::Display`）——`sftp_copy.rs:39–54` 统一抽象，字节还原结果一致；工作台写族用 `.dbx-part` 暂存+原子提交，MCP 面直写（既有语义选型）。
- **MCP 无对应物**：`sftp/rename-unique`、`sftp/touch`、`sftp/symlink-*`、`sftp/archive`/`extract`、`sftp/upload-local`、`watch/*`、sudo 族——均为工作台/前端专属入口，MCP 面不暴露。

---

## 5. 疑点（只登记，不修代码）

复核中发现以下「实现与登记/直觉不完全一致」之处，供后续批次决策：

- **D-1（口径张力）`sftp/download/start|next` 的字面 `%XX` 歧义**：PROTOCOL M15-B 段称「输入中的字面
  `%XX` 序列保持字面量，不再转义」（指写操作的末段显示编码），但下载侧以
  `has_wire_escapes`（`sftp_name.rs:122`）判分支（`ssh.rs:6018/6483`）——手输含形如 `%E9` 的**字面**
  文件名会被判为转义并 `unescape_wire` 还原成单字节路径，命中不了真实文件。wire 来源（列表回传，
  字面 `%` 已转义为 `%25`）不受影响；歧义本质是 `%` 编码空间的固有冲突，现有选择（下载侧优先按
  转义解释）与 PROTOCOL 文字不完全一致，建议后续在 PROTOCOL 补一句边界说明。
  **已裁决——契约内正确（M27-A 批，2026-09-26）**：逐调用点核查确认下载车道的路径契约是「列表回传的
  wire 形式」排他——工作台全部三个前端下载入口（单文件 `frontend/src/App.vue:8451`、外部编辑
  `:8215`、目录树 `:8571`，以及 sudo 下载 `:8450`）一律传 `pathFromUri(entry.uri)`（`App.vue:10869`，
  列表 uri 去前缀）；latin-1 列表 uri 由 `escape_wire` 产出（`ssh.rs:4396–4401`），字面 `%` 已自转义为
  `%25`，回传后 `unescape_wire` 往返无损。M15-B 的「字面 `%XX` 保持字面量」限定于**写操作末段显示
  编码**（`latin1_encode_display`，`sftp_name.rs:186`），与下载车道的 wire 整条还原是不同分工（PROTOCOL
  M16 段本就分列两条），并非真矛盾；「手输字面 `%XX` 文件名」在该入口没有自由输入链路，用户可见的
  字面 `%XX` 名经列表回传时已是 `%25XX`。裁决为文档澄清而非行为缺陷：PROTOCOL 已在 RPC 表
  `sftp/download` 行与 `sftp/list` 节补 wire 形式契约声明（M27-A）。**登记边界（不闭环）**：单文件
  `has_wire_escapes` 判分支（`ssh.rs:6018/6483`）不区分编码（`sftp/list` 节 M14-B 起 wire 字面即列表
  回传约定），auto/latin-1 回退列表（`ssh.rs:4305/4310`、高层 uri `ssh.rs:4367`）的字面 `%XX` 名在
  wire 里未经 `%25` 自转义——此时单文件下载会被误还原（见 D-7 登记）。
- **D-2（重复实现）两份 `shell_quote`**：`exec.rs:1217` 与 `sudo_fs.rs:27` 文本等价的单引号转义各有一份
  （历史分层产物）。当前行为一致，仅登记为维护负担；若未来改转义规则需双点同步。
  **已收编（M27-B）**：核查另发现第三处 `sftp_ext.rs:703`（私有，注释自称与 exec 版逐字节兼容）；
  三处合并为 `exec.rs` 单一规范实现——`sudo_fs.rs` 改为 `pub(crate) use crate::exec::shell_quote;`
  再导出（`sudo_download` 导入路径不变）、`sftp_ext.rs` 改为 `use crate::exec::shell_quote;`。
  纯重构零行为变更，三处原有单测全保留，cargo 984/984、clippy 0、fmt 0、smoke 83/0/0。
- **D-3（边界登记缺口）home 探测的 lossy 风险**：`sftp/home`（`ssh.rs:3505`）与 `sftp_pwd`（`mcp.rs:2473`）
  走高层 `canonicalize(".")`，返回值经高层客户端按 UTF-8 解码——家目录名本身非 UTF-8 时返回串含
  U+FFFD（字节已丢），以其为基准拼接的后续路径无法命中。M17 段对 shell cwd 回读登记过同类边界
  （PROTOCOL 429 行），home 探测未明确登记，建议补记。
  **已闭环（M28-A）**：PROTOCOL RPC 表 `sftp/home` 行已补编码边界登记（家目录名非 UTF-8 时返回串含
  U+FFFD、原始字节不可恢复，与 M17 段 shell cwd 回读同类不可恢复边界），登记缺口收口；行为本身维持现状（读侧探测，lossy 提示即可）。
- **D-4（文档措辞）PROTOCOL 431 行「字面量发送」表述**：`sftp/diskUsage` 被列入「仍按字面量发送的残留点」，
  但实现里路径先经 `normalize_remote_path`（`ssh.rs:4691`）——「字面量」指**字节层面**不经编码还原
  （字符级归一仍发生）。措辞易误读为连归一都没有，建议后续修订为「归一后字面量发送」。
  **已闭环（M28-A）**：M26-A 重写该登记段后现状表述为「路径参数已 normalize + shell_quote；shell 参数
  字节保真不可达」，措辞已准确、不再产生连归一都没有的误读，PROTOCOL 无需再改；矩阵第 3 节
  「latin-1 下维持字面量发送」表述与 ❌ 口径一致（指字节层面无编码还原），同样无需调整。
- **D-5（一致性确认，非缺陷）**：`sftp/upload/start` 自身无 latin-1 分支容易误读为缺口——它只写本地
  spool 文件（`ssh.rs:5359`），不发任何远端请求；字节保真由 `finish_upload`（`ssh.rs:5618`）执行，
  与 M16 登记一致。
  **已闭环（M28-A）**：确认为有意选型，矩阵 `sftp/upload/start` 行备注已补「有意选型：只写本地 spool，
  字节保真在 finish 执行（`ssh.rs:5618`）」，缺口认知收口。
- **D-6（行为差异确认）MCP `sftp_download` 目录探测**：latin-1 裸包分支不单独 STAT 目录，依赖 OPEN 被
  服务器拒绝后回退高层给出「is a directory」错误（`mcp.rs:2979–2984` 注释登记）——与 auto 分支的
  metadata 判目录路径不同但最终报错语义一致，属有意选型。
  **已闭环（M28-A）**：确认为有意选型，矩阵 MCP `sftp_download` 行备注已补「目录探测依赖 OPEN 被拒回退
  （`mcp.rs:2979–2984`），与 auto 报错语义一致，有意选型」，行为差异认知收口。
- **D-7（D-1 裁决分离出的真实边界）auto/回退列表产出的字面 `%XX` 名在单文件下载被误还原。已修（M28-B）**：
  单文件下载原 `has_wire_escapes` 判分支（原 `ssh.rs:6018` size 探测、原 `ssh.rs:6483` 分块读取）**不区分
  编码**——`auto` 模式与 latin-1 裸包失败回退高层的列表条目（`ssh.rs:4310`/`ssh.rs:4305`）uri 由高层
  `sftp_uri(&entry.path())` 产出（`ssh.rs:4367`），服务器字节合法 UTF-8 时文件名**原样透传**、字面 `%`
  不做 `%25` 自转义（`escape_wire` 只服务 latin-1 raw 列表，`ssh.rs:4396`）。此时真实文件名含形如
  `%E9` 字面序列的条目回传给 `sftp/download/start`，会被判为转义并 `unescape_wire` 还原成单字节路径
  ——与 latin-1 车道行为相反（同名文件在 latin-1 列表下 uri 为 `%25E9`，往返无损）。这是 D-1 裁决
  （latin-1 车道 wire 契约内正确）**之外**的真实往返缺口：auto 车道里「字面 `%XX` 名下载命中不了」。
  **修复（M28-B，按生效编码区分车道）**：`main.rs` `sftp/download/start` 分发臂 resolve 编码
  （连接覆盖 > 全局偏好，与 `sftp/download/tree/start` 同口径）传入 `start_download`，登记进
  `DownloadState.latin1`（新字段，参照 `TreeDownloadState.latin1` 先例）；size 探测与 `download_chunk`
  分块读取统一按 `has_wire_lane(remote_path, encoding)` 判车道（`sftp_name.rs` 纯函数）——latin-1
  维持现状（`has_wire_escapes` → raw 车道，D-1 契约不动），**auto 一律走高层客户端**（auto 车道
  本就以字面量语义与列表一致：列表回传什么名就按什么名打开）。树下载分支按 `tree.latin1` 判（M21）、
  sudo 下载走独立车道（sudo_download.rs），均不在本修复范围。单测回归：`has_wire_lane_branches_on_effective_encoding`
  （`sftp_name.rs`）。cargo 985/985（基线 984 + 1）、clippy 0、fmt 0、smoke 83/0/0。

---

## 6. 维护约定

1. **每批 latin-1 相关改动合并后，更新对应行的「字节保真」「备注」「来源」三列**；新增远端路径入口
   （工作台 RPC / MCP 工具）必须在合入同一批内加行。来源列给出分发点与实现点的 文件:行号（实现点
   优先给 latin-1 分支所在行）。
2. **归一口径变更**（`normalize_remote_path` 语义、调用位置）视同本矩阵全表复查：M24（工作台
   `raw_read_chunk`）与 M25（MCP 全臂）已两次证明归一缺口会分批曝露。
3. **回退策略**、**编码判定优先链**若调整，同步修订第 1 节口径段与 PROTOCOL 对应段。
4. 疑点条目处置后在条目尾部标注批次（参照 `AUDIT-PROTOCOL-IMPL.zh-CN.md` 登记簿格式：
   `**已修（Mxx 批）**` 或 `**确认不动（理由）**`），不再单独删除。
5. 本矩阵是登记文档，不含行为变更；若复核发现实现与 ✅/⚠️/❌ 标注不符，先在「疑点」节登记、
   再由实现批次修复，修完更新该行。
