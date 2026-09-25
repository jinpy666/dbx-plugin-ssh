# P-SSH 路交付报告（ssh-sftp 成熟化增强）

日期：2026-08-28 深夜。工作目录：`~/btroot/dbx-plugins/ssh-sftp`，在未提交 batch3 + 历轮（S-A/S-B/X/XB）改动之上继续；
仅触碰本路所有权文件：`backend/src/exec.rs`、`backend/src/ssh.rs`、`frontend/src/App.vue`、
`frontend/src/style.css`、`frontend/src/lib/{terminalReconnect,terminalCommandMarkers,sftpBatchProgress,workbench.spec,i18n}.*`、
`scripts/smoke_sudo_otp_test.py`、`scripts/perf_baseline_test.py`（新建）、`docs/PROGRESS-P-SSH.zh-CN.md`（本文件，新建）。
未执行任何 git commit/push；无新 npm/cargo 依赖。

## 0. 总体验证基线（本轮终值）

| 套件 | 结果 |
| --- | --- |
| backend `cargo test` | ✅ **108 passed / 0 failed**（基线 107 → 108，新增 ReplayBuffer 5 MiB 压测单测） |
| frontend `pnpm typecheck` | ✅ vue-tsc --noEmit exit 0 |
| frontend `pnpm test` | ✅ vitest 2 spec **41/41**（基线 38 → 41：重连倒计时 1 + 标记条 tooltip 1 + 批量进度 1） |
| frontend `pnpm build` | ✅ 自包含 `ui/index.html`（2,297,959 B）产出 |
| `scripts/smoke_test.py` | ✅ PASS（1.1s，真机容器） |
| `scripts/smoke_fs_test.py` | ✅ PASS 17 / SKIP 0 / FAIL 0 |
| `scripts/smoke_mcp.py` | ✅ initialize / tools/list 19 tools / call 往返全绿 |
| `scripts/smoke_batch3_test.py` | ✅ 17 passed / 0 skipped / 0 failed |
| `scripts/smoke_sudo_otp_test.py` | ✅ **10 passed / 0 skipped / 0 failed**（XB 遗留项第 5 关单） |
| `scripts/perf_baseline_test.py` | ✅ 3 案例 0 SKIP（真机，见 §3 性能基线） |
| `dbx-plugin package .` | ✅ `dist/io.dbx.ssh-0.2.2-darwin-arm64.dbxp`（4,276,701 B，sha256 `3c2183bf8e57cae4ca1ca48ee4aba3df4aa59f9e46631565001cabb8aed415e2`，5 文件齐） |

测试容器：`dbx-ssh-test`（linuxserver/openssh-server，127.0.0.1:2222），全部 smoke 真机真跑、无环境 SKIP。
出包后对同源码快照二进制复跑 `smoke_test.py` + `smoke_sudo_otp_test.py` 双确认（SKILL.md 流程约定）。

## 1. 任务 1：sudo 保活 / OTP 防重放端到端（XB 遗留第 5 项）

宿主 python3 标准库实现 RFC 6238（HMAC-SHA1，`scripts/smoke_sudo_otp_test.py: totp_now`）；
容器凭据运行时 `chpasswd` 生成（digits+lower+upper+symbol），TOTP secret 运行时 `secrets.token_bytes(20)` 生成、
只写“当窗期望码”入容器、secret 本体永不出宿主；退出时完整恢复（sudoers 备份/密码/shim/OTP 状态文件）。

**验证链（10 用例全绿真机）**：
1. 正确密码 Quick Sudo 执行成功（`sudo -S` 密码注入）；
2. `ssh/sessions/list` 报告 `sudoKeepalive=true`（`sudo -nv` 4 分钟保活循环已注册）；
3. 全局时间戳缓存使后续 sudo 无 prompt（配置错密码仍成功，证明未发生认证交互）；
4. `sudo -k` 后错密码以 `sorry, try again` 报错；恢复正确密码后再执行成功；
5. `ssh/settings/set` 注册多密钥 `totpSecret`（`a;b`），`ssh/settings/get` 只报布尔不回显 secret；
6. 当前窗 OTP 被自动应答并被服务端 ACCEPT（提交日志逐条核对该码）；
7. 同窗二次 sudo：轮换到第二密钥的码（提交日志证明未重放第一码），服务端拒绝（防重放语义成立）；
8. 同窗第三次：硬跳过 OTP 提交（提交日志零新码）；
9. 错误 TOTP secret 提交其派生码并被拒绝。

**容器策略**：Alpine 的 sudo 无 PAM，无法挂真实 TOTP 模块——用 `/usr/local/bin/sudo` POSIX shim
模拟 OTP-prompt 前端：无 flag 文件时纯透传真实 sudo；OTP 相态吃掉 stdin 密码行、打印
`Verification code:`、与宿主写入的期望码比对、逐条记录 `<epoch> <code> ACCEPT|REJECT`，
再委托真实 sudo 完成真实提权。secret 不进容器，仅瞬态期望码。

**顺带修复的两个真实缺陷**：
1. **smoke shim 参数剥离**（脚本缺陷）：shim 转发真实 sudo 前把 `-S`/`-p` 剥掉了，导致真实 sudo
   收不到 stdin 密码、报 "a terminal is required"。修复为携带原始参数转发（`sudo -S -p '' …` 语义保真）。
2. **exec 通道未关闭 → sudo 时间戳锁死锁**（后端真实缺陷，`backend/src/exec.rs`）：russh `Channel`
   drop 不发送 SSH_MSG_CHANNEL_CLOSE（仅 `ChannelCloseOnDrop` 包装才发）。认证失败报错路径直接
   drop 通道后，远端 sudo 进程永远等 stdin 并持有 sudo 全局时间戳锁（`timestamp_type=global`），
   阻塞该连接所有后续 sudo（真机复现：keep-4 请求 45s/120s 超时，容器内可见两个 root sudo 挂起）。
   修复：新增 `abort_exec_channel()`，`exec_with_sudo`（空密码/带密码两分支）与 `exec_plain`
   的错误路径显式 `eof()+close()`，让 sshd 回收远端进程。修复后 10 用例全绿、无残留 sudo 进程。

## 2. 任务 2：UI 成熟化（小步多项，纯函数全部 vitest 覆盖，七语全补）

### 2a) 会话状态 pill 重连倒计时 / 进度感
- `terminalReconnect.ts` 新增纯函数 `describeReconnectCountdown({pending, attempt, nextAt, now, delayMs})`
  → `{seconds, attempt, percent}`（秒数 ceil 收敛到 0、按 backoff 时长算 0-100 进度、非 pending/非法输入返 null）。
- App.vue：调度重试时记录 `reconnectNextAt/reconnectDelayMs`；`watch(reconnectPending)` 驱动 250ms tick
  更新倒计时（退出 reconnecting 即确定性停表；`onBeforeUnmount` 双保险清理）。
- 模板：reconnecting 态 pill 内追加 `session-pill-countdown`（如 “retry in 2s · attempt 1”），dot 加脉冲动画。

### 2b) 终端标记条 hover tooltip（完整命令 + 退出码）
- `terminalCommandMarkers.ts` 新增纯函数 `commandMarkerTooltip(marker, labels)`：多行组装
  完整命令 / 退出码（已知才出现）/ 耗时（终值或运行中 live tick）/ 工作目录，缺失段省略不渲染噪音。
- App.vue：`commandMarkerDetails` computed 喂给标记条 `:title`；标记条启用 hover（`pointer-events: auto`，
  点击回焦终端，不吞交互）。

### 2c) SFTP 批量操作聚合进度条
- 新建 `lib/sftpBatchProgress.ts`：`createBatchProgress / advanceBatchProgress / batchProgressPercent`
  （done+failed 都计入已处理、钳制 0-100、纯不可变）。
- App.vue：`confirmBatchDelete`（含 sudo/remove 分支）与 `batchArchive` 逐项推进进度、失败项计入后原样抛错；
  批量工具条与删除确认对话框渲染 `<progress>` + `{done} / {total}` 文案；批量期间两个入口按钮禁用防并发。

### i18n 七语（en/es/it/ja/pt-BR/zh-CN/zh-TW）
新增 key 全部 ×7：`sessionStatus.reconnectCountdown`、`terminalCommand.tooltipCommand/tooltipExitCode/
tooltipDuration/tooltipDirectory`、`sftpBatch.progress`。既有“七语 key 全对齐 + 占位符对齐”vitest 断言
全量扫过 messages 表，41/41 通过即为自动化证据。

## 3. 任务 3：性能验证与优化

新增 `scripts/perf_baseline_test.py`（真机，SKIP 语义与其余 smoke 一致，SHA-256 双端校验）：

| 案例 | 口径 | 结果（本机，docker loopback） |
| --- | --- | --- |
| 终端 PTY 流灌入 | 5 MiB 连续输出经 PTY→sidecar 环形缓存→binary 帧 | **71.9 MiB/s**（0.07s，不含 2s 静默收尾窗口） |
| 终端 replay 载荷 | `ssh/terminal/replay` afterSequence=0 | **2.00 MiB / 601 帧**，严格 ≤ 2 MiB 上限，`complete=false`、首尾序号连续（旧帧已按序驱逐） |
| SFTP 上传（spool） | 50 MiB / 256 KiB 分块 + 逐块 ack 背压 | **633.9–1078 MB/s**（本地 spool 文件段） |
| SFTP 上传（网络） | `sftp/upload/finish` 真实 SFTP 写 | **220–237 MB/s**（SHA-256 与本地一致） |
| SFTP 下载 | `sftp/download/start+next` 全量 | **113–118 MB/s**（SHA-256 与远端 `sha256sum` 一致） |

**结论与瓶颈记录**：
- 环形缓存内存上限真实生效（Rust 单测 + 真机双重验证：80×64KiB 灌入后 `bytes == 2 MiB`、序号连续、
  `after(0)` 恰好返回保留尾窗；wire 载荷仅多每帧约 1.3B encode 头，属协议开销非泄漏）。
- 上传走“本地 spool → finish 阶段网络写”，两段语义在 perf 报告中分列，避免把 spool 速度误当网络吞吐。
- 本机 loopback 下 220/117 MB/s 远超交互场景需求，**未做分块/并发度参数化改动**（256 KiB 协商块
  `TRANSFER_CHUNK_SIZE` 维持不变）；如未来真实网络成瓶颈，优先候选是下载 `download/next` 流水线化与
  上传 finish 并发写，均已记录在案、本轮不动。

## 4. 任务 4：契约与文档

- **PROTOCOL.zh-CN.md 无需更新**：本轮无新增方法、无参数/返回契约变化；`abort_exec_channel` 为
  行为修复（错误路径通道关闭），sudo/OTP 行为契约此前已在册（Quick Sudo 段）。
- 出包：`io.dbx.ssh-0.2.2-darwin-arm64.dbxp`（sha256 见 §0），打包后对同快照二进制复跑双冒烟全绿。

## 5. 安全红线自查

- sudo/OTP smoke：凭据 `secrets.token_urlsafe` 运行时生成经 stdin `chpasswd`，退出恢复原密码；
  TOTP secret 只在宿主进程内存与容器“当窗期望码”出现，日志输出全部 `redact()` 打码（六位数字 → `******`）；
  sudoers 改动先备份后恢复并 `visudo -c` 校验；shim/flag/log 文件 finally 清理，多次运行幂等。
- 后端改动仅错误路径资源回收，无新增命令构造、无转义面变化。
- 前端：无新依赖；倒计时/tooltip/进度均为纯展示；新增定时器（重连 tick）三条路径确定性清理
  （重连退出、openSession/closeSession、onBeforeUnmount）。

## 6. 遗留与交接

1. **XB 遗留第 5 项已关单**（sudo 保活 / OTP 防重放 e2e）；XB §3 的收口点 2（PARITY/TEST_MATRIX 登记句）
   仍未动（文档所有权约束），主会话收口时请一并刷新：cargo 107→108、vitest 38→41、smoke_sudo_otp 10 用例、
   perf 脚本入库、本文件新基线。
2. 宿主集成段（`scripts/test.sh` 不带 --skip-host）与隧道真机验证仍属宿主依赖，本轮未覆盖。
3. perf 脚本的“上传网络段”时间含远端 `commit_remote_file`（rename 提交）与 flush；严格纯传输带宽可再细分，
   当前口径对基线追踪足够。
4. OTP e2e 依赖 shim 模拟 sudo 前端（Alpine sudo 无 PAM 的替代）；若未来测试镜像换用带 PAM 的发行版，
   可将 shim 相态替换为 `pam_google_authenticator` 真栈，用例结构无需变化。
5. 全部改动未 git 提交（硬性约束），请主会话审阅 diff 后统一收口。

---

## 7. 文件管理器交互轮补录（2026-08-30）

用户反馈 SFTP"丢了预览和编辑"，复核结论：预览/编辑/压缩解压链路均在，但交互门槛
造成功能体感丢失（详见 `FEATURE_PARITY.zh-CN.md`「文件管理器交互轮」节）。纯前端改动：

- `frontend/src/lib/textSniff.ts`（新建）+ `textSniff.spec.ts`（6 用例）：
  `looksBinary` 纯函数——NUL 字节即判二进制；否则按无效 UTF-8（U+FFFD）与
  非文本控制字符（放行 TAB/LF/VT/FF/CR/ESC）占比 > 10% 判定；空块判文本。
- `frontend/src/App.vue`：
  - `openEntry` 重排：图片 MIME 保留 → 已知二进制扩展名直接提示不打开 →
    > 1 MiB confirm 询问（取消即不动）→ 打开前 8 KiB 嗅探兜底 → 预览；
    白名单 `PREVIEWABLE_EXTENSIONS` 与 `isPreviewable` / `containsNullByte` 删除。
  - 截断预览（大文件确认后只读头部）：`previewBinary` ref 换为 `previewTruncated`，
    `previewEditableAllowed` 增加 `!previewTruncated`——修复截断态编辑保存
    整文件被头部覆盖的数据丢失 bug；弹窗标题徽标改显截断提示。
  - `archiveEntry` 放开单文件压缩；右键菜单预览/压缩条件同步放宽。
- `frontend/src/lib/i18n.ts`：七语新增 `binaryFile.notOpen`、
  `previewDialog.tooLargeConfirm` / `truncated`（原 `binaryFile.badge` 弃用删除；
  组名 `previewDialog` 避让既有 `preview` 字符串键）。
- `frontend/src/style.css`：`.preview-binary-badge` → `.preview-truncated-badge`。

验证：`pnpm typecheck` 0 错误；`pnpm test` vitest 3 spec **57/57**（51 → 57）；
`scripts/build.sh` 全绿，出包 `io.dbx.ssh-0.2.6-darwin-arm64.dbxp`。
后端零改动，无新增协议方法：无新 smoke 用例（既有 smoke_fs 的
`sftp/write + sftp/read round-trip` 等继续覆盖底层通道），安装后按惯例对安装副本
复跑双冒烟。遗留：预览解码对 GBK/GB18030 等非 UTF-8 文本仍按 UTF-8 容错显示
（与此前一致，未引入转码）；zip 格式压缩/解压仍不做（协议文档明确仅 tar 系）。

## 8. Quick Sudo 全局配置集中管理（2026-08-30）

需求：多套全局 quick sudo 配置集中管理，单连接可选「全局配置」或「本连接自输入」，
UI 与 MCP 双通道支持 quick sudo / auto sudo。设计契约记录随专项实施计划文档退役删除
（本轮推翻 FEATURE_PARITY L41 既有「不做」结论）。

- `backend/src/sudo_profiles.rs`（新建）：`<plugin_data_dir>/quick-sudo-profiles.json`
  版本化存储（`profiles` + `bindings`，0600，tmp+rename 原子写，损坏按空库），
  CRUD/名称唯一（大小写不敏感）/上限 20/视图永不回显密钥；
  `apply_profile`（字段级覆盖，空配置密码回退登录密码）与 `effective_use_pty`。
- `backend/src/exec.rs`：`AuthFlowMode::name()`（canonical 名），
  `ssh.rs::flow_mode_name` 改为委托。
- `backend/src/ssh.rs`：`resolved_sudo_auth`（绑定 profile 整体覆盖连接来源）；
  `open_session` 编排、`exec` use_pty、`settings_get`（新增 `quickSudoProfileId` /
  `quickSudoProfileName`）、`settings_set`（`quickSudoProfileId` 持久化绑定 +
  存活会话热更新）；`profiles_list` / `profiles_save` / `profiles_delete` +
  `refresh_bound_sessions`（配置改动即时热更新绑定会话，保留 OTP 防重放记账）。
- `backend/src/main.rs`：注册 `sudo/profiles/list|save|delete`。
- `backend/src/mcp.rs`：新增 `ssh_quick_sudo_profiles_list/save/delete` 工具；
  `ssh_exec_sudo` 支持可选 `quickSudoProfile`（id 或精确名称；引用在任何连接 I/O
  前解析，未知名称快速报错；调用内联凭据显式给出时优先）。
- `frontend/src/App.vue`：设置弹窗新增「sudo 凭据来源」select（本连接 / 全局配置）
  + 绑定摘要行 + 隐藏本连接凭据字段（总开关保留）；全局配置管理弹窗
  （列表/新建/编辑/删除，删除走 confirm，密钥仅提交时发送、永不回显）。
- `frontend/src/lib/i18n.ts`：supplemental 七语全补 20 键
  （`settingsCredentialSource`、`profiles*` 等）；`style.css` 三个小样式类。
- `scripts/smoke_fs_test.py`：quick sudo profiles 组 7 用例（list 初始 / save 创建 /
  重复名拒绝 / 空密码更新保持密钥 / list 不回显 / settings 绑定与解除 / delete+幂等）。
- `scripts/smoke_mcp.py`：MCP 通道 save/list/delete 回环 + `ssh_exec_sudo` schema
  断言 `quickSudoProfile` + 未知引用快速报错（默认二进制路径同步改为
  `backend/target/release/dbx-plugin-ssh`，对齐 test.sh）。

验证：`cargo test` **140 passed / 0 failed**（基线 128 → 140：sudo_profiles 12 +
MCP 回环）；`pnpm typecheck` 0 错误；`pnpm test` vitest 3 spec **58/58**（§7 基线 57/57）；`smoke_fs_test.py` **PASS 24 / SKIP 0 / FAIL 0**（真机容器）；
`smoke_mcp.py` **all green（22 tools）**。版本 `0.2.9` → `0.3.0`
（manifest.json + backend/Cargo.toml）。

安全评估：全局配置密钥落盘为插件数据目录明文 JSON（0600）——为「凭据走 secret
binding 不持久化」红线的显式例外（宿主 secret binding 仅支持连接级字段、无全局命名
凭据通道），已在 IMPL_PLAN §0/§9 记录权衡，
存储层收敛于 sudo_profiles 单模块，后续可替换 OS keyring。密钥仅在 list/save/get
以布尔位呈现，不进日志、不参与 shell 拼接。

### §8.1 入口补强：工具栏直达 + 连接表单动作桩（2026-08-30 晚）

反馈：「没有看到 quick sudo 的全局设置」——原入口埋在工作台设置弹窗里。核查宿主
二进制确认贡献点枚举仅 `connection-provider` / `workbench` / `filesystem-provider`，
**不存在插件级独立设置页**；但 `connection-provider` 支持 `actions`（连接表单动作，
宿主点击后调 `connection/action {action, id}`，插件回 `{message, fieldValues}`）。

- `frontend/src/App.vue`：工作台工具栏 Quick Sudo 开关旁新增钥匙按钮
  （KeyRound）直达全局配置管理弹窗（管理操作本就无会话依赖）。
- `ssh/manifest.json`：`connection-provider.actions` 新增 `quick-sudo-profiles`
  （`variant: outline`、`when: always`、`requires_valid_form: false`、
  `timeout_ms: 10000`）+ 六语 label/description；schema 经打包 CLI 宿主同款
  校验通过。
- 后端：`sudo_profiles::action_summary`（纯函数，密钥只报 set/not-set）+
  `SshRuntime::profiles_action_summary` + `main.rs` 注册 `connection/action`
  （未知动作报错）。摘要含全局配置清单与当前连接绑定状态，并提示完整管理入口
  在工作台。
- `scripts/smoke_fs_test.py`：`connection/action` 用例（清单含 profile、绑定行、
  未知动作拒绝；置于 delete 用例之前执行）。

验证：`cargo test` **141 passed**（+action_summary）；前端 typecheck/58 不变；
`smoke_fs_test.py` **PASS 25 / SKIP 0 / FAIL 0**；`smoke_mcp.py` all green；
`dbx-plugin package .` schema 校验通过出包 `io.dbx.ssh-0.3.2-darwin-arm64.dbxp`
（manifest 与 Cargo.toml 同步 0.3.1 → 0.3.2）。

## 9. MCP 完善与 ZCode 接入（2026-08-30 晚）

需求：完善 ssh 的 MCP 工具面并接入 ZCode 实测。补齐 MCP 工具面缺口
（`SFTPTransfer` / `sftpPwd`），并确认 ZCode 客户端接入路径。

- `backend/src/mcp.rs`：新增三工具（22 → **25**）——
  - `sftp_upload`：本地文件 → 远端（单文件）。本地侧校验（可读、≤`maxUploadBytes`）
    **先于拨号**；远端已存在需 `overwrite=true`。
  - `sftp_download`：远端 → 本地路径（单文件）。本地目标已存在需 `overwrite=true`、
    父目录自动创建，均先于拨号；远端先 stat 快速失败，再 `take(limit+1)` 硬上限
    （防无尺寸/边读边涨），≤`maxDownloadBytes`。
  - `sftp_pwd`：`canonicalize(".")` 返回登录家目录（与工作台 `sftp/home` 同源）。
  - **连接池语义修正**：传输工具移出 `run_tool` 兜底 `drop_connection`——本地/远端
    校验类拒绝（"already exists"、超限、是目录）不是传输故障，不清池；仅真正
    SFTP I/O 错误主动 drop 触发下次重连（此前 `sftp_write_file` 拒绝也会清池，
    同族问题留待后续统一，本轮不动存量行为）。
  - `sftp_upload` 加入只读连接写门控（`is_write_tool`）；`sftp_download` 保持只读
    放行（远端只读不写）。
  - 顺带：`model.rs` 去除重复 `#[test]` 属性（历史告警，一用例曾计两次）。
- `scripts/smoke_mcp.py`：
  - EXPECTED_TOOLS 补齐 25（含此前漏断言的 `sftp_copy`/`sftp_move`）；
  - 新增离线组：transfer 工具本地校验先于拨号（缺文件读失败 / 父目录是文件时
    mkdir 失败，均零拨号快速报错）；
  - 新增 `--host` 真机回环段：test_connection → exec（结果断言）→ metrics →
    pwd → list_dir → upload→`sha256sum` 远端比对→download→本地 SHA-256 比对→
    二次 download 拒绝 → 清理 → close；凭据走 `--password` 或
    `DBX_SSH_SMOKE_PASSWORD` 环境变量（新代码不落盘凭据）。
- 文档：`MCP.zh-CN.md`（工具一览 19→25、传输工具语义、**ZCode stdio 接入段**）、
  `FEATURE_PARITY.zh-CN.md`（新增 MCP 传输对标行）。PROTOCOL 无新增方法不动。

验证：`cargo test` **141 passed / 0 failed**（140 去重基线 + 1 新增 transfer
校验用例；去重前的 142 含 model.rs 双计）；`smoke_mcp.py` 离线 all green（25
tools）；真机回环（dbx-ssh-test 容器 127.0.0.1:2222）all green。ZCode 接入：
用户级 `~/.zcode/cli/config.json` `mcp.servers.dbx-ssh`（stdio，`--mcp`），
重启会话后 `mcp__dbx-ssh__*` 工具可用；详见 `MCP.zh-CN.md` 接入段。

## 10. MCP 生产误操作防范（2026-08-31）

需求：MCP 调用方是 LLM，生产环境误操作代价与人工敲错相同。给 exec 工具加
三层安全门，全部在任何网络 I/O 之前（真机验证记录见本节末）。

- `backend/src/mcp_safety.rs`（新增）：命令风险分级器 `assess_command` →
  `ReadOnly`（白名单巡检命令，含管道组合）/ `Destructive(reason)`（灾难模式）/
  `Unknown`（其余，白名单语义：识别不了 = 不放行）。
  - 只读白名单：ls/cat/df/du/ps/journalctl/docker ps/git log 等无条件动词 +
    systemctl/docker/git/kubectl/ip/service 子命令表 + find/crontab/journalctl
    特判（`-delete`/`-exec`、`-r`/`-e`、`--vacuum` 拦）；`timeout/nice/env`
    等包装器与 `FOO=bar` 前缀解包后再评估内层命令；重定向与 `$(...)` 一律
    Unknown；`sudo X` 仅评破坏性、永不计白名单。
  - 灾难模式：递归 rm 深层系统根（≤2 层路径；`/tmp`、`/var/tmp` 例外的常规
    清理不拦）、mkfs/fdisk/wipefs 系、`dd of=/dev/…`、`> /dev/sdX`、
    shutdown/reboot/init 0/6、fork 炸弹、`chmod/chown -R` 系统根、
    /etc/passwd|shadow|sudoers|fstab 与 /boot/ 覆盖删除、docker prune、
    `find -delete`、`kill -9 -1`、SQL DROP DATABASE/TABLE。
  - 刻意保守：引号不做完整解析（引号内 `;` 仍切分，只会降级不会放行）、
    `2>&1` fd 复制中性化后不误伤 `ps aux 2>&1 | grep`。
- `backend/src/mcp.rs`：`call_tool` 三层门——① 只读连接（DBX lifecycle
  read_only 或 `DBX_SSH_MCP_READ_ONLY=1` 全局开关）拒绝写类工具；② 只读连接
  上 `ssh_exec` 走白名单（此前 ssh_exec 完全绕过只读门，本次收紧）；③ 灾难
  命令要求 `confirmDestructive: true`，只读连接直接拒绝且确认位不可覆盖。
  两 exec 工具 schema 增 `confirmDestructive` 参数并在描述中说明门语义。
- `scripts/smoke_mcp.py`：离线组 destructive 无确认拒绝/带确认过门（错误信息
  断言门序先于凭据校验）；真机段 destructive 拒绝；新增
  `read_only_server_section`——第二个进程以 `DBX_SSH_MCP_READ_ONLY=1` 启动，
  断言写工具拒绝、巡检命令过门、未知命令白名单拒绝、确认位不可覆盖。
- 文档：`MCP.zh-CN.md` 新增「生产环境误操作防范」节（三层门 + 全局开关 +
  保守偏差说明）、工具一览补安全语义；`PROTOCOL.zh-CN.md` MCP 通道段补
  安全门一行。manifest/Cargo.toml 0.3.3 → 0.3.4。

验证：`cargo test` **150 passed / 0 failed**（+9 mcp_safety 单测 +2 门禁
集成用例）；`smoke_mcp.py` all green（含真机 dbx-ssh-test 容器 live 段：
destructive gate / read-only server gate 两节新增输出）。另对 DBX 内 vagrant
真实连接（192.168.33.11）完成 25 工具实测 + 磁盘清理演练（根分区 75%→72%），
清理所用命令（`rm -rf /root/.cache/*`、`journalctl --vacuum`、`truncate` 日志
截断）均落在 Unknown 档不误拦，验证白名单分级与真实运维操作兼容。

## 2026-08-31 AI 终端同步执行（agent terminal mode，0.3.4 → 0.4.0）

上游需求：AI/MCP 命令在终端 UI 同步执行——过程完整可见、可中断、可审批、可人工
介入（教学/接管语义）。设计经用户确认四决策：仅 MCP/AI 命令路由；分级审批；
无终端会话报错引导；超时返回部分输出命令继续跑。实施按专项计划执行
（计划文档已随批次退役删除）：后端/前端并行 agent 实施，主会话接线。

- `backend/src/agent_terminal.rs`（新）：`AgentTerminalMode`（off/auto/strict）、
  `CommandRisk`、`decide` 策略矩阵、`sanitize_command`（剥 C0 控制、留 `\n`/`\t`，
  杜绝 AI 命令内嵌 `\x03`/`\x1b`）、`strip_ansi`（CSI/OSC 状态机）、
  `TerminalRecorder`（1 MiB 有界缓冲、提示符回归 + 300ms 静默收尾、回显/尾提示符
  尽力剥离）。9 个单测。
- `backend/src/ssh.rs`：`agent_modes` 连接级内存存储 + settings get/set 新字段
  `agentTerminalMode`；会话 `agent_recorder` 槽挂进 PTY 读循环（auto_sudo.observe
  同位）；`exec_in_terminal`（sanitize → notice 事件 → PTY 键盘写入注入 → 50ms
  轮询收尾 → finish 事件 → `{output, exitCode: null, mode: "terminal", incomplete,
  interrupted}`）；审批挑战管理（`ssh/agent/prompt` 事件 + 120s 默认超时即拒绝 +
  一次性挑战 + `resolve_agent_challenge`）。
- `backend/src/mcp.rs`：`ssh_exec_tool` 路由分支（既有只读/灾难门之后）——
  `runInTerminal` 显式值优先、缺省按连接模式、Off 行为与响应结构不变；stdio
  模式传 `runInTerminal:true` 报错；`call_dbx` 透传 emitter（事件通道）；
  两 exec 工具 schema 增 `runInTerminal`。
- `backend/src/main.rs`：`mod agent_terminal`、`ssh/agent/resolve` 方法臂、
  `mcp/call` 传 emitter。
- 前端：`lib/agentTerminal.ts`（类型/三档/倒计时纯函数 + spec）、App.vue 审批
  弹窗（复用 host-key 骨架：可编辑命令 textarea + 风险徽标 + 倒计时）、执行横幅
  + 中断按钮（`sendTerminalBytes(\x03)` 复用既有 PTY 通道）、设置弹窗三档 select；
  i18n 20 键 × 七语。
- smoke：`smoke_mcp.py` stdio `runInTerminal` 拒绝负例 + schema 断言；
  `smoke_fs_test.py` 新增 agent terminal 组（模式 round-trip / 无会话引导错误 /
  auto 低危路由执行 / strict 审批 approve / deny 拒绝），事件回调驱动审批。
- 文档：PROTOCOL 新增「AI 终端同步执行」节 + RPC 表 `ssh/agent/resolve` 行 +
  settings 字段；MCP.zh-CN.md 新增「AI 终端同步执行」节 + 工具表补参数；
  manifest/Cargo.toml 0.4.0。

已知限制（协议文档已记）：多行命令按行执行；全屏 TUI 无提示符回归走超时路径
（`incomplete: true`，命令留终端人工接管）；回显剥离尽力而为；sudo+终端路径
不注入密码（交给终端 auto-sudo 状态机或人工）。stdio `--mcp` 模式不路由
（与工作台不同进程）。

### 增补：vagrant 真机教学模式验证 + sudo 前缀风险修复（同日）

对真实 vagrant 连接（192.168.33.11，parallels ubuntu，password/private-key 认证）
完成教学模式端到端 9 场景验证：auto 模式低危路由（`uname -sr` → notice 事件 +
输出捕获）、sudo 提权审批（elevated → approve → root）、strict deny/approve、
人工 Ctrl+C 介入（3.3s 返回 vs 30s sleep，命令未跑完、shell 状态保留）、超时
`incomplete:true` 后人工接管（`\x03` 终止残留 sleep 后 shell 可用）、模式恢复。

验证中发现并修复一个风险缺口：路由分级此前只把 `ssh_exec_sudo` **工具**计为
elevated，`ssh_exec` 命令文本内联 `sudo …`（如 `sudo whoami`）被判 Low 直接执行、
绕过审批。修复：`mcp_safety::runs_under_sudo()`（复用既有分段/env 前缀解包逻辑，
任一顶层段首动词为 sudo 即真）接入 `ssh_exec_terminal_tool` 风险计算 → 内联
sudo 一律 elevated 必审，对齐 IMPL_PLAN §1「sudo 一律 elevated」。+1 单测
（162 passed）。容器 smoke 回归 31/31 全绿。

### 增补：自动唤起 DBX app 的完整可视链路（同日晚，宿主配合改动）

用户验收反馈：教学模式应当"自动唤起 DBX.app → 自动打开对应终端 → 命令在终端上
可见执行"。查明宿主三层缺位并补齐（宿主仓 `dbx-plugin-host-worktree` 本地改动，
未提交）：

1. **宿主 `src-tauri/src/commands/mcp_bridge.rs`**：TCP 桥新增 `POST
   /call-plugin-tool`——按 `connection_id` 解析已保存连接 → emit
   `mcp-open-connection-workbench` 事件 → `connection_params_standalone` 构造
   lifecycle → 在 **app 自己的 plugin_host**（与工作台同一 sidecar 进程）上
   `invoke("mcp/call")`，结果原路返回。超时上限 600s（容纳审批）。
2. **宿主前端 `apps/desktop/src/composables/useTauriEvents.ts`**：监听
   `mcp-open-connection-workbench` → `queryStore.openPluginConnection`
   （内部去重、ensureConnected、挂工作台）→ 聚焦窗口。
3. **插件 `backend/src/app_bridge.rs`（新）**：stdio 模式 `runInTerminal:true`
   时转发到 app 桥——端口文件 `<app-data>/mcp-bridge-port`（`DBX_APP_DATA_DIR`
   重定向），缺失则 `open -a DBX.app`（`DBX_APP_LAUNCH_CMD` 可自定义）唤起并
   500ms 轮询 30s；手写最小 HTTP POST（零新依赖）；读超时 = 调用超时 + 150s
   审批余量。`mcp.rs` 内嵌路径另加 `wait_for_connection_session`（20s 轮询，
   解决"标签尚在打开、PTY 未就绪"竞态）。

e2e（隔离 app-data + 宿主 debug bundle + 已保存 vagrant 连接）：stdio
`ssh_exec{runInTerminal, connectionId:"vagrant"}` → app 唤起/工作台自动打开 →
命令在可见终端执行 → AI 拿到 `{mode:"terminal", output:"agent-visible-…\nLinux
5.4.0-216-generic"}`，1.3s 返回，cargo 166 tests 全绿。连接种子需
`db_type:"plugin"` + `plugin_id` + `plugin_connection_provider` +
`plugin_connection_type:"ssh"` 四个绑定字段。宿主 tauri debug 构建末尾的
updater 签名报错（缺 `TAURI_SIGNING_PRIVATE_KEY`）不影响 .app 产物。

### 增补：教学模式并发语义与完整测试覆盖（同日夜）

针对「并发命令 / 连接复用」的系统化补强，三处实现 + 覆盖扩展：

1. **同会话并发串行化**：`SessionEntry.agent_exec_lock`（tokio AsyncMutex，
   OwnedMutexGuard 跨审批+执行全程持有，`mcp.rs::ssh_exec_terminal_tool` 取锁）——
   并发 AI 命令在同会话上确定性排队，recorder 与 PTY 输入零交叉污染；刻意不做
   全局锁，跨连接仍并行。
2. **ssh_exec_sudo 终端注入修复**：`agent_terminal::sudo_command_text`——终端路径
   注入 `sudo <command>`（已带前缀不重复；审批弹窗显示注入原文，所见即所执行，
   用户编辑后的文本不二次套前缀）。修复提权在终端路径被静默丢失的 bug。
3. **前端审批队列**：`agentPromptQueue` + `enqueueAgentPrompt/dropAgentPrompt/
   findAgentPrompt` 纯函数——跨会话并发审批排队逐个处理，队首倒计时基于绝对期限
   自动轮转；同 challengeId 去重。

测试覆盖扩展（smoke_fs agent 组新增 12 用例，44/44 全绿）：
shell 状态复用（export/cd 跨调用持久）、同会话并发 batch（`sidecar_client.
request_batch` 单 pump 多 outstanding id，A/B 输出零交叉）、跨连接并行（4.3s
< 串行 8s，锁非全局）、2MiB 输出有界捕获、ANSI 剥离、多行逐行执行、
runInTerminal:false 回归隐藏通道、ssh_exec_sudo 审批链到 root（终端 auto-sudo
自动应答编排密码）、超时 incomplete → Ctrl+C 恢复、人工 Ctrl+C 介入 2.4s 返回、
smoke_mcp 增桥不可达负例（`DBX_APP_LAUNCH_CMD=:` 快速失败路径）。
cargo 170 tests / vitest 68 tests / 容器 smoke_fs 44·smoke_mcp all green。

### 增补：断线重连死循环 + 侧栏状态一致性修复（同日晚二）

用户报障两则，修复：
1. **断线后无自动重连/转圈不停**：`ssh/session/state disconnected` 分支原样只改
   状态等人手点；现改为有界自动重连梯（500/1000/2000/5000ms 共 4 次，失败落回
   手动重连按钮，不收敛不死循环）。`openSession` 的自愈重试限定"快速失败"
   （<8s，启动竞态特征），重试超时降 30s——真拨号失败不再连续转圈数分钟。
   `attachSession` 退避梯耗尽后回退 `openSession(true)`（原实现永远 attach 死
   sessionId，app 被杀重启后终端永久卡重连）。
2. **侧栏状态与 SSH 实际状态不一致**：`ssh/session/state` 事件补 `connectionId`；
   宿主 `connectionStore` 新增 `markConnectionOffline`（轻量：翻侧栏离线、清
   loading，不关标签不拆池），`useTauriEvents` 监听 `dbx-plugin-event` 转发通道
   驱动它——PTY 掉线即刻反映到左侧树。
另修：批准路径误发 `finish{denied}`（前端横幅闪错）；执行中关闭会话现返回
"SSH terminal session was closed…"而非伪装超时；僵尸会话注入 send 加 5s 上限；
`app_bridge::ensure_app_bridge` 先 TCP 探测端口再返回（杀进程后过期端口文件不再
永久指错），std io 客户端 `McpStdioClient` 入库 sidecar_client.py（select 超时）。
新 e2e 套件：`scripts/e2e_agent_terminal.py`（26 场景，容器 26/26、vagrant
25/25+SKIP 全绿）与 `scripts/e2e_agent_app_bridge.py`（T1-T5）。T5（转发 shell
状态复用偶发空输出）仍在排查，手动探针证明变量持久化正常。

## 2026-08-31 连接表单 sudo 来源三选一 + 宿主保存校验修复（0.4.2）

1. **连接保存报 "Agent socket has an invalid value type"**：根因在宿主——
   `hktkosl1186` 等连接的 `external_config.agent_socket` 等字段存了 JSON
   `null`（旧对话框构建遗留），宿主 `validate_plugin_field_type` 对 text
   字段只认字符串，test/connect 全被拒。修复宿主 worktree
   `crates/dbx-core/src/plugins/host.rs`：校验前把 null 视为未填写
   （`value.filter(|v| !v.is_null())`），附单测
   `tolerates_stored_null_config_values_for_type_check`（cargo +1.97.1 过，
   host 依赖要求 ≥1.91，需 `cargo +1.97.1`）。**宿主 app 需重打包生效**。
2. **连接表单选不到全局 Quick Sudo**：manifest `quick_sudo` 布尔升级为
   `sudo_source` 三选一（off / custom / global）+ `sudo_profile` 引用字段，
   `visible_when` 联动（custom 才显示本连接密码/PTY，global 才显示配置
   引用）；后端 `SudoSource` 解析兼容旧布尔，`effective_sudo_profile` 统一
   会话引导 / exec 门禁 / PTY / settings 的配置解析；`settings/set` 绑定
   变化联动 source，`settings/get` 新增 `sudoSource`。单测 3 个新用例 +
   manifest 一致性用例更新；七语文案补齐（es/it/ja/pt-BR/zh-CN/zh-TW）。
   协议/对标文档同步（PROTOCOL §运行时设置/§sudo、FEATURE_PARITY）。

### §8.2 MCP 直调走声明的 sudo 来源 + 诊断日志（0.4.x 轮增补）

排查 hktkosl1086「终端 sudo -v 不自动输密码 / MCP 直调不走 quick sudo」：

- **MCP 缺口（本轮修复）**：隐藏通道 `ssh_exec_sudo` 此前只从调用参数构建凭据，
  已保存连接声明的 `sudo_source`（global→表单引用/工作台绑定，custom→连接自身
  secret，off→拒绝）完全不参与。新增 `resolve_sudo_auth`：声明来源解析为基底
  凭据 → 调用方显式参数（`sudoPassword`/`totpSecret`/提示词/`authFlowMode`）
  恒优先 → 每调用 `quickSudoProfile` 引用替换连接声明的 global 配置；`off` 且
  无显式凭据时按工作台同款门禁拒绝。`resolved_sudo_auth` /
  `effective_sudo_profile` 放开为 pub(crate) 复用。
- **诊断日志**：终端 watcher 已挂载但凭据为空时，检测到 sudo 密码提示输出
  `[ssh] terminal auto-sudo: sudo password prompt detected but no sudo password
  is configured …`；watcher 解除挂载输出原因（sudoSource/readOnly/凭据是否配置），
  「为什么不自动应答」可直接看 sidecar 日志定位。
- 单测：`sudo_auth_resolution_follows_declared_source`（global 生效 / 显式参数
  优先 / 每调用引用替换声明 / custom 回退登录密码 / off 拒绝与显式放行）。

### §8.3 重启恢复快速失败 + SFTP 面板可收起/默认不打开（纯前端轮）

用户报告两处体验问题，本轮均为前端改动（无新协议方法）：

1. **DBX 重启后恢复的 SSH 工作台长时间转圈**：根因链条——宿主 openTabs
   持久化恢复 plugin-workbench tab 但**不重放 `connection/connect` 生命周期**
   （`openTabsStartup` 无 plugin 处理、`openPluginConnection` 不在恢复路径上），
   sidecar 重启后 `connections` 内存表为空，`ssh/session/open` 立即返回
   `Connection is not active`；而前端 `openSession` 把一切快速失败当
   「启动竞态」盲目重试 3 次（2/4/6s 递增），期间状态 pill 持续「连接中」，
   最终只显示英文原始错误。修复：`terminalReconnect.ts` 新增
   `isConnectionInactiveError`（匹配 sidecar 稳定错误串，大小写不敏感），
   `openSession` catch 里命中即**跳过重试直接 error**，错误显示七语
   `connectionInactive` 文案（指引用户从 DBX 侧边栏重新打开连接再点
   「重新连接」）。真正的启动竞态（sidecar 未激活等）保留原重试逻辑。
   宿主 1.1 的 `restored` 标记分支保留（当前宿主未下发，为死代码无害）。
2. **SFTP 面板增加打开按钮 + 可设置默认不打开**：
   - 工具栏新增 toggle 按钮（`FolderOpen`/`PanelRightClose` 图标，
     `sftpPane.open`/`sftpPane.close` 七语 title），收起时终端
     `flex-basis:100%` 占满（`panes--solo` 类，含窄屏纵向布局覆盖）；
   - 「自定义列」弹出层新增「默认打开 SFTP 面板」checkbox
     （`sftpPane.defaultOpen`/`defaultOpenHint`），写 localStorage
     `ssh-sftp-pane-open`（全局偏好，仅影响新工作台初始态）；
   - 每工作台开关写入 `workbenchState.sftpPaneOpen`（宿主 1.1 可用时
     随 tab 恢复；`restoreUiState` 经 `resolveSftpPaneOpen` 解析，
     损坏值回退全局默认）。纯函数入 `workbenchLayout.ts`
     （`resolveSftpPaneOpen`/`sanitizeSftpPaneDefaultOpen`）。

单测：workbench.spec.ts +3 用例（inactive 错误识别含反例 / 面板可见性
解析 / 偏好解析），i18n 七语 key 对齐检查覆盖新增 key；vitest 71 绿 +
typecheck 过 + build 过 + visual.html 浏览器验证（默认双面板 → 收起 →
默认偏好关闭 → 刷新后仅终端 → 手动重开）。**剩余风险**：重启恢复场景
的端到端行为（真实宿主重启 + tab 恢复）未在本轮实测，依赖单测对错误
分类的覆盖；宿主后续若下发 `restored`，前端已有对应分支。

### §8.4 SFTP 操作归位面板内 + metrics 悬浮卡（纯前端轮）

用户反馈两处工具栏归属/形态问题：

1. **SFTP 专属按钮移入面板 path-toolbar**：Home、刷新、上传、新建文件夹、
   新建文件 5 个按钮从顶部全局工具栏移入 SFTP 面板路径栏（上级/路径输入
   之间与历史/粘贴之后），顶部工具栏只留连接/终端级操作（面板开关、字号、
   重连、Quick Sudo、命令、快速命令、metrics、连接信息、设置、自定义列、
   传输）。面板收起时按钮随 `v-if` 自然消失，不再出现"按钮在但面板不在"
   的悬空禁用态。路径输入框加 `min-width:110px` 防挤压；sudo 开关加
   `.sudo-label` 间距。文案全部复用既有 key，无新增。
2. **metrics 从阻塞弹窗改为悬浮卡**：`openMetrics` 改 `toggleMetrics`
   （再点 Gauge 或 X 关闭，按钮带 `is-active` 高亮），渲染从
   `modal-backdrop` 改为工作台右上角 `.metrics-float`（absolute、z-index 20
   低于 modal、宽 min(400px,100vw-20px)、内部滚动），不遮挡不阻塞终端与
   SFTP 操作——点击终端/收起面板/继续操作时卡片保持打开，可边看指标边
   操作。5s 自动刷新与错误重试逻辑原样保留。

验证：typecheck 过、vitest 71 绿（无新纯函数/文案，无需新用例）、build 过、
visual.html 浏览器验证（顶部按钮清单、path-toolbar 按钮清单、点终端卡片
保持、收起面板卡片保持、Gauge 再点关闭、深浅两态截图）。布局 CSS 仅
`.metrics-float` 系列与 path-toolbar 两处微调。

### §8.5 MCP 长任务/断线恢复三层机制（spawn 并发 + run_bg/status + pre-exec 重试）

真机长任务暴露的问题链：宿主 ~15s 放弃等待（timeoutSecs 形同虚设）→ sidecar
handler 继续跑满 → 远程命令继续执行；stdio 主循环逐请求 `block_on`（mcp.rs
`run_mcp_stdio`）导致一个慢命令阻塞后续全部请求（含 `ssh_close`），表现为整
server 连环 15s 超时直至最长 handler 到期；Agent 误判"超时=没跑"重复下发，
两个 yum/dnf 互等包管理器锁。三层修复：

1. **stdio 请求并发**：`run_mcp_stdio` 逐请求 `tokio::spawn`（响应经
   `Mutex<Stdout>` 保行完整，乱序合法），stdin 关闭后 drain 在途请求至多
   300s 再退出。真机对照：`ssh_exec sleep 15` 运行中 `ping` t+0.0s 即回
   （旧行为需等 15s）。
2. **`ssh_run_bg` / `ssh_task_status`**（工具 25→27）：nohup 脱离会话启动 +
   服务器侧 `/tmp/.dbx-ssh-tasks/<taskId>.log`（含 `EXIT_<code>` 完成标记与
   `.pid` 存活文件），状态轮询跨断线/跨会话。与 `ssh_exec` 同过危险命令确认
   门与只读写门（`is_write_tool` + assess 扩展）。
3. **pre-exec 断线自动重试**：`run_tool` 兜底分支失败丢池照旧；命令启动前的
   传输错误（`exec::is_pre_exec_transport_error`，通道打开/启动失败类）同一次
   调用内换新连接重试一次（不可能双执行）；已启动后的错误保持终态。keepalive
   （30s×3）已有，未改。

配套：`run_to_completion` 超时错误文本加"命令可能仍在远程运行，先查证再重试"；
`ssh_exec`/`ssh_exec_sudo` 描述与 `timeoutSecs` schema 改为如实描述宿主 ~15s
上限；`MCP.zh-CN.md` 工具一览 27 个 + 新增「长任务与断线恢复」章节；用户级
dbx-ssh-sftp-dev skill 增补同名约定章节。

验证：cargo test 181 绿（新增 4：bg/status 输出解析 ×2、只读门/危险门对
ssh_run_bg 生效 ×2、pre-exec 判定正反例）；clippy 无新告警；
`smoke_mcp.py --binary target/debug` all green（27 工具、只读进程级开关、
危险门、app-bridge 拒绝路径均过）；真机 hktkosl1086（RHEL 9.8）三段 smoke：
run_bg 立即返回 taskId/pid/logPath → 新进程轮询 RUNNING(pidAlive=yes) →
完成态 DONE + exitCode 0 + started/finished 时间戳精确（12s 任务实测 12s）。
开发中发现并修复两个自引入问题：`shutdown_timeout` 先取消再等掐死在途任务
（改 drain），`tokio::time::timeout` 构造期取 Handle::current 需在 block_on
context 内构造。

剩余风险：七语不涉及（纯 MCP 工具无 UI 文案）；pre-exec 重试无真机断线注入
（依赖单测正反例）；`ssh_run_bg` 日志不自动清理（刻意保留任务记录，由调用方
清理）；宿主侧 ~15s 等待上限属宿主行为，本插件只能以描述引导 + bg 工具绕开。
安装生效需重新打包发版（本轮未动 manifest 版本）。

### §8.5 metrics 卡与 SFTP 共存 + 选中复制/右键粘贴开关（纯前端轮）

用户反馈两处 UI 继续优化：

1. **metrics 悬浮卡移入终端面板内部**：上轮悬浮卡挂在 workbench 右上、
   宽 400px，会盖住 SFTP 面板（"metrics 和 sftp 不能共存"）。改为挂在
   `terminal-pane` 内部右上（`top/right 8px`、宽 min(360px, 100%-16px)、
   `max-height calc(100%-16px)` 内部滚动、z-index 6 低于搜索面板 7）——
   只遮挡终端一角（随时可关），SFTP 面板完全不被遮挡，收起面板后同样
   可用。浏览器验证：`cardInTerminalPane=true`、与 sftp-pane 包围盒
   零重叠。
2. **新增"选中复制 · 右键粘贴"开关（默认开）**：XShell 风格终端交互。
   - 纯函数 `lib/terminalInteraction.ts`：`sanitizeSelectCopyEnabled`
     （localStorage `ssh-terminal-select-copy`，仅显式 "false" 关闭）+
     `resolveTerminalRightClickAction`（开启且非 Shift → paste，否则 menu）；
   - App.vue：`terminal.onSelectionChange` 选中即静默写剪贴板（无提示刷屏）；
     `showTerminalMenu` 右键分流——开启时普通右键直接走 `pasteTerminal`
     （保留多行/危险命令粘贴确认），**Shift+右键保留完整右键菜单**，关闭
     时恢复纯菜单行为；切换即生效并持久化，notice 提示当前模式；
   - 设置弹窗新增「终端交互」区块 + switch（默认 on），七语文案
     `terminalSelectCopy.{section,label,hint,enabledNotice,disabledNotice}`；
   - 单测 +2（偏好解析 / 右键分流含 Shift 反例），vitest 73 绿。
   - 附带：mockDbxHost 补齐 `sudo/profiles/list`、`ssh/knownHosts/list`、
     `keys/discover`、`mcp/settings/get` 空数据返回（原默认 `{success:true}`
     导致 fixture 打开设置弹窗时 `undefined.length/find` 渲染错误，纯
     测试工具问题，不影响真实 sidecar）。

验证：typecheck 过、vitest 73 绿、build 过、visual.html 浏览器验证
（开关默认 on、切换持久化 localStorage、notice 文案、开启时右键不弹菜单、
Shift+右键弹菜单、关闭后右键恢复菜单）。

### §8.6 终端快捷键 + 搜索面板选区种子/选项持久化（纯前端轮，2026-09-01）

后台 agent 执行轮，最终汇报偏题，改动本体完整有效，由主 agent 补齐验证与
本文档。改动均为纯前端（App.vue / TerminalSearchPanel.vue /
lib/terminalInteraction.{ts,spec.ts}），协议契约与后端零改动：

1. **终端内快捷键路由（iTerm2/XShell 风格）**：新增纯函数
   `resolveTerminalKeyAction`——Ctrl/Cmd+V 与 Ctrl/Cmd+Shift+V 粘贴（沿用
   既有风险确认流程），Ctrl/Cmd+Shift+C 复制当前选区；**普通 Ctrl/Cmd+C 不
   拦截**，保持发给远端 shell（SIGINT 语义）。App.vue `handleTerminalKey`
   接线，复制复用 `copyTerminalSelection`。
2. **搜索面板选区种子**：`terminalSearchSeedFromSelection` 取终端当前选区
   首行（截断 200 字符），打开搜索面板时预填并立即执行一次查找（面板打开
   即出结果）；多行/超长选区不会产生不可用查询。
3. **搜索选项持久化**：`sanitizeSearchOptions` / `persistSearchOptions`——
   localStorage `ssh-terminal-search-options` 保存 caseSensitive/regex/
   wholeWord 三开关（JSON 对象；解析失败或缺失回退全关，localStorage 不可用
   时降级会话级）。面板重开/页面刷新后恢复，切换即时写入。
4. **附带修复**：xterm `allowProposedApi: true`——SearchAddon 的 highlight
   decorations 走 proposed API，缺该项会在 findNext/registerDecoration 时抛
   "allowProposedApi option"。

验证（主 agent 复核）：
- typecheck 过；vitest **79 绿**（基线 73 → 79，terminalInteraction.spec
  8 例：快捷键分流含 Ctrl+C 放行反例、搜索选项 sanitize/persist、选区种子
  首行截断）；build 过（产物写 ui/index.html）。
- 浏览器验证（visual.html @ vite 5180，截图
  `docs/screenshots-ui-mock/search-options-persist-round86.png`）：
  Ctrl+F 打开面板、切换 Aa/.*/|w| 即时写入 localStorage
  （`{"caseSensitive":true,"regex":true,"wholeWord":true}`）、输入 nginx
  命中 2 处（状态 1/2）、页面刷新后重开面板三开关全部恢复。

剩余风险：快捷键真键程未在真机验证（纯函数单测覆盖分流逻辑）；搜索种子
仅首行策略为刻意取舍（多行选区不整段带入）。

### §8.7 终端拖放上传入口 + 大输出渲染节流（纯前端轮，2026-09-02）

后台 agent 持续完善轮，两项聚焦改进，均为纯前端（App.vue / style.css /
lib/terminalWriteThrottle.{ts,spec.ts} / lib/terminalInteraction.{ts,spec.ts} /
mockDbxHost.ts），协议契约与后端零改动：

1. **终端窗格拖放上传**（补齐 batch3 deferred「路径拖拽上传增强」的终端侧）：
   - 此前拖放上传只有 SFTP 面板一个 drop 目标，面板收起（solo 模式）后无入口；
     现在 `.terminal-pane` 自带 dragenter/dragover/dragleave/drop 处理，
     拖入文件显示 `drop-overlay`（虚线框 + 上传图标 + 七语提示
     `terminalDrop.hint`「松开上传到 {path}」，path 为当前 SFTP 目录）；
   - 准入纯函数 `canAcceptTerminalDrop`（terminalInteraction.ts）：已连接 +
     可写 + 非 ZMODEM 占用三者齐才收文件，只读连接/ZMODEM 传输中静默拒绝
     （与 SFTP 面板 drop 同语义）；drop 后复用 `uploadLocalFiles` 全链路
     （传输面板、分块上传、目录刷新、完成 notice），目录跟随开启时即上传到
     shell 当前 cwd；宿主 fileTransfer 拖拽态（dragActive）在面板收起时也
     复用同一 overlay 提示；
   - mockDbxHost 补最小可写 fixture：URL `?rw=1` 切换可写连接（默认只读）+
     `sftp/upload/start|finish`、`sftp/transfer/cancel`、上传 ack 事件，
     拖放上传可在 visual.html 全流程走通。
2. **大输出渲染节流**：新增 `lib/terminalWriteThrottle.ts`——PTY 二进制帧
   不再逐帧直写 xterm，而是排队合并为一帧一次合并 write（rAF 调度，
   setTimeout 兜底），顺序严格保持；排队字节超 1 MiB 上限同步 flush，
   持续突发下内存有界；`dispose()` 于工作台卸载时冲刷残余。sink 惰性引用
   `terminal`，跨终端重建安全。App.vue `writeTerminalOutput` 改走节流通道，
   卸载钩子补 `terminalWriteThrottle.dispose()`。

验证：
- typecheck 过；vitest **86 绿**（基线 79 → 86：terminalWriteThrottle 6 例
  （合帧合并、跨帧顺序、上限同步 flush、flush 取消不双投、dispose 冲刷、
  空队不投递、超限单块整投）+ terminalInteraction 拖放准入 1 例含三反例）；
  build 过（ui/index.html 产出）。
- 浏览器验证（visual.html @ vite 5180，Playwright，截图
  `docs/screenshots-ui-mock/terminal-drop-overlay-round87.png`（分屏）与
  `terminal-drop-solo-round87.png`（solo 全宽））：
  - `?rw=1` 拖入文件 → overlay 出现且提示含 `/home/demo`；dragleave 即消失；
  - drop → 传输面板打开、notice「1 file(s) uploaded」、无错误横幅，分屏与
    solo 两模式均过；
  - 只读模式（默认 fixture）→ overlay 拒绝出现；
  - 节流写入路径回归：欢迎输出/命令标记等 PTY 帧渲染正常。

剩余风险：真实大文件拖放上传未连真机（fixture 全流程 + 单测覆盖逻辑，
真实 SFTP 通道由既有 uploadLocalFiles 链路承担，无新协议面）；xterm 键入
回显 fixture 不模拟（mock 只回 ack），大输出节流在真机突发下的体感收益
未量化（单测保证合并/顺序/上限语义）；`dragleave.self` 沿用 SFTP 面板
同一简易模式，极端嵌套拖拽路径未穷举。

### §8.8 断线重连体验轮 + 重连死锁修复（2026-09-02）

第三轮 agent 因配额超限中断，改动主体完整（重连横幅 / 立即重连按钮 /
恢复提示 / fixture `?err=disconnect`），主 agent 验证时**发现并修复一个被
fixture 首次暴露的既有死锁**。

**新增能力**（纯前端）：
1. **重连横幅**：`reconnectPending` 期间终端内嵌横幅（Loader + 「连接丢失，
   自动重连中」+ 第 N 次重试 + 进度条 + 立即重连按钮），250ms tick 驱动纯函数
   `describeReconnectCountdown`；
2. **恢复提示**：重连成功后按 `describeReconnectRestoredNotice` 显示
   「已重新连接，当前目录 {path}」（有 cwd 时）或「连接已恢复」，首连不弹；
3. **fixture `?err=disconnect`**：会话建立 4s 后注入一次
   `ssh/session/state disconnected`，全流程 UI 验证载体。

**死锁分析**（`?err=disconnect` 首次真实触发，页面 100% CPU 冻结、连
Playwright evaluate 都被饿死、headless virtual-time-budget 永不完成）：
1. 首连消费终端帧 seq=1 后 `lastSequence=1`；
2. 断线自动重连走 `openSession()` 重置 `lastSequence=0`，但 mock 的序号
   计数器是全局的——重连后欢迎帧 seq=2，帧 1 已被消费、**永久缺失**；
3. `drainTerminalFrames` 检测到缺口即调 `ssh/terminal/replay`，mock 返回
   `complete:true` 但不补帧 → `.finally` 再 drain → 缺口依旧 → 再 replay；
4. **promise 微任务级无限自旋**（每轮极快、永不给事件循环让路）。

**修复**（两侧）：
- `mockDbxHost.ts`：`ssh/session/open` 时 `sequence=0`——对齐真实 sidecar
  「每会话重置序号」语义，重连后 `lastSequence=0` 与新帧序号天然对齐；
- `App.vue openSession`：重置游标同时清空 `pendingTerminalFrames` 并复位
  `replayNoProgress`（旧会话残帧不污染新流）；
- `App.vue drainTerminalFrames`：**无进展熔断**——连续 3 次 replay 返回
  complete 但同一缺口未补齐时，`lastSequence = firstPending-1` 越过缺口
  （丢弃缺失前缀的降级路径，优于永久自旋冻结整个工作台）。

**验证**：typecheck 0 错；vitest **87 绿**；build 过。修复前 headless
`--virtual-time-budget` 确定性挂死（exit 124），修复后 10s 虚拟时间完整
跑完（exit 0）终态 Connected；真浏览器 MutationObserver 捕获横幅
「Connection lost, reconnecting automatically · Reconnect now」与恢复提示
「Reconnected, current directory /home/demo」；终端欢迎行 ×2、提示符 ×4
证明第二轮 OSC 633 周期完整重放；截图
`docs/screenshots-ui-mock/reconnect-restored-round88.png`（横幅窗口仅
~500ms，像素截图以 DOM 观察器文本证据为准）。

**剩余风险**：熔断的「丢前缀」是降级路径；真实 sidecar 的序号重启语义与
mock 假设需真机断线注入回归确认；后端未动（协议零变更）。

### §8.9 stdio MCP 声明 connectionId——已打开终端可被 MCP 驱动（2026-09-02）

**问题**：stdio 模式（ZCode 直连 sidecar `--mcp`）下，`ssh_exec{runInTerminal:true,
connectionId}` 三连败——分发器读 `connectionId`（mcp.rs `ssh_exec_tool`）但
`connection_properties()` 从未在 inputSchema 声明该字段，严格校验的 MCP 客户端
先以「未声明参数」拒绝，字段根本到不了 sidecar，表现为「MCP 工具不接受
connectionId」「已打开的终端会话 MCP 调用不了」。

**修复**（纯 schema 声明，零逻辑变更）：
- `mcp.rs connection_properties()`：头部声明 `connectionId`（string，说明终端
  路由与 embedded 存储连接解析两用途）——`ssh_*` + `sftp_*` 共 22 个连接类工具
  一次性覆盖；
- 单测 `connection_tools_declare_connection_id` 防回归（8 个代表工具断言）；
- `smoke_mcp.py` schema 段补 `connectionId` 断言；
- `docs/MCP.zh-CN.md`「AI 终端同步执行」节补声明说明与连接 id 查询口径。

**验证**：cargo test 183 绿；release 重编后对安装同款二进制 spawn stdio 会话：
initialize → tools/list 27 工具、22 个声明 `connectionId` →
`ssh_exec{connectionId:"e60c6b55-…"(hktkosl1103), runInTerminal:true,
command:"echo DBX_BRIDGE_OK_…"}` 经 app bridge（mcp-bridge-port 49568）落到 DBX
可见工作台终端，返回 `{mode:"terminal", output:"\rDBX_BRIDGE_OK_…"}`，marker 命中。

**流程结论**（stdio 客户端视角）：驱动已打开终端 =
`connectionId + runInTerminal:true`；连接 id 查 `~/Library/Application
Support/com.dbx.app/dbx.db` 的 `connections` 表（本机 SSH 连接用户名统一
jinpy.he）。存量 MCP 会话需重连/重启才拿到新 schema。

**剩余风险**：`connectionId` 不带 `runInTerminal` 时在 stdio 模式不解析存储凭据
（仍需内联参数，行为与之前一致）；`ssh_list_connections` 发现工具未做（可选后续，
需定数据源：rusqlite 或宿主桥端点）。——本条欠账已于 §8.16 清账（宿主桥端点方案
+ stdio 桥接兜底，`connectionId` 零凭据可用）。

### §8.10 切 tab 重连/闪屏修复：重挂载 reattach 存活会话（2026-09-02）

**症状**：SSH 工作台切换 tab 触发重连且终端闪屏；已打开的 SSH 从左侧菜单重新
唤起后连接被重置（全新登录、屏幕清空）。

**根因**（宿主侧限制 × 插件侧兜底未命中，三层叠加）：
1. 宿主 `ContentArea.vue` 只渲染 activeTab 且无 KeepAlive——切 tab 即销毁插件
   webview（iframe srcdoc），重开时整体重建（闪屏的物理来源）；
2. 宿主桥**未实现 workbenchState**（pluginHostBridge.ts 全仓 0 处）：插件
   `writeWorkbenchState()` 的 `sessionId/terminalSequence` 持久化被 `?.` + 静默
   catch 吞掉，重挂载后 `initialState().sessionId` 永远为空，§8.8 的 attach
   路径从不命中；
3. 宿主 `openPluginConnection` 每次点击都 `workbenchId: crypto.randomUUID()`，
   且复用 tab 时整体替换 context——即使有 sessionId，sidecar
   `attach_session` 的 `connectionId+workbenchId` 双匹配也必扑空。

三层叠加的净效果：任何 remount 都走 `openSession()` 全新拨号（连接重置），
旧会话在 sidecar 里变僵尸。

**修复**（纯插件侧，自洽不依赖宿主改动）：
- `ssh.rs`：`SessionEntry.workbench_id` 改 `RwLock<String>`（内部可变）；
  `attach_session` 匹配放宽——先精确 `(connectionId, workbenchId)`，否则复用
  该连接的活会话并**重绑**到新 workbench（re-home，后续 close_workbench/list
  归属正确）；匹配逻辑抽纯函数 `pick_attach_target` + 单测；
- 前端 `initialize()`：持久化 sessionId 缺失时先 `ssh/sessions/list` 查该连接
  活会话（`lib/sessionRestore.ts` 纯函数 + spec：同 workbench 优先、createdAt
  最新、死会话忽略），命中则 `attachSession`（replay 恢复终端内容），否则照旧
  `openSession()`；attach 失败仍走既有退避梯子，梯尽 `openSession(true)` 兜底。

**验证**：cargo test **184 绿**（+attach 选择器）；vitest **96 绿**（+5 个
reattach 选择器用例）；typecheck 0 错、build 过；测试容器行为级验证 ALL
GREEN——wb-A 打开的活会话换 wb-B attach 返回同一 sessionId、sessions/list
确认 re-home、二次 attach 稳定、未知连接仍拒绝。

**说明**：七语不涉及（无新 UI 文案，错误全走既有降级路径）；改动生效需重新
打包安装插件（会重启 DBX，等用户窗口期执行）。**宿主侧遗留**（可选后续）：
① 桥补 workbenchState 实现（root fix，插件已兼容两种形态）；② 插件 tab 改
v-show/常驻可消除 iframe 重建闪屏（内存换体验，宿主设计决策）。

### §8.10 增补：SFTP 全局默认关 + 切 tab 闪屏宿主补丁（同日）

**SFTP 全局默认关**：`sanitizeSftpPaneDefaultOpen` 回退翻转（缺失/非法值不再
默认开，仅显式 "true" 开）——新工作台默认纯终端布局；`loadSftpPaneDefaultOpen`
的 catch 回退同步改 false；spec 断言更新。用户历史偏好仍生效（存过 "true" 就
开）。注意 workbenchState 在宿主桥未实现（§8.10 根因 2），工作台内的即时开关
只在本次 webview 存活期内有效。

**闪屏宿主补丁**（连接已由 reattach 保住，闪屏是 iframe 销毁重建的物理现象，
插件侧无解）：宿主 `ContentArea` 被 `:key` 的 KeepAlive 承载，切 tab 整树销毁
重建，iframe 移出 DOM 必然整页重载。按 DriverStorePage/PluginCenterPage 既有
`v-if+v-show` 常驻模式在宿主 App.vue 加常驻插件工作台图层，ContentArea 移除
plugin-workbench 分支（防双挂载）；`openPluginWorkbench` 复用 tab 不再替换
context（左侧菜单每次点击 mint 新 workbenchId，替换会重载 webview 并使会话
绑定失效）。详见 shared/PROGRESS-HOST-SUBREPO §11。验证：宿主 typecheck
0 错 + 相关 vitest 27 例全过（含新增 2 例）。

**生效路径**：插件重新打包安装（`frontend` 三件套已过，`scripts/build.sh` +
`scripts/install.sh --reinstall`）；宿主 `pnpm tauri build --debug` 重建
DBX.app。两者都会重启 DBX，待用户窗口期执行。

### §8.11 终端无输出修复：宿主桥二进制事件契约变更适配（2026-09-04）

**症状**：连接成功后终端零输出（无提示符、按键无回显），SFTP 面板正常。

**根因**（对照 ad76537 的终端改动排查，最终定位在宿主桥契约）：上游宿主
b15281024（随 DBX.app 0.6.2 于 09-04 08:37 生效）把沙箱 binary 事件从
`{ channel, dataBase64 }` 改为零拷贝 `{ channel, data: Uint8Array }`，
`dataBase64` 字段不复存在。插件 `handleBinary` 仍读 `event.dataBase64`（恒
undefined）→ `atob(undefined)` 抛异常 → 每个终端输出帧解码即炸，终端静默；
SFTP 浏览走 invoke（JSON 通道）不受影响，症状精确吻合。输入方向 sendBinary
新桥仍兼容 base64 字符串，故按键能发出、无回显。bug 逃过单测的原因：插件
自带 mockDbxHost 仍按旧形状投递，类型定义（env.d.ts）也是插件本地旧契约，
typecheck/单测全绿但与真实宿主脱节。

**修复**（纯插件侧，兼容新旧两种桥，符合 Host API 1.0 基线 optional 降级）：
- `lib/binaryEvent.ts`（新）：`bridgeBinaryBytes` 归一化两种形状——优先
  `data: Uint8Array`，回退 `decodeBase64(dataBase64)`；+3 spec 用例（新形状/
  旧形状/双缺失）；
- `App.vue`：两处 binary 消费（终端输出帧、SFTP 下载分块 waiter）改走归一化
  函数；
- `env.d.ts`：`dataBase64` 改 optional、新增 `data?`；
- `mockDbxHost.ts`：镜像当前宿主桥形状（`data` 字段），消除 mock 与现实脱节
  （本类 bug 的逃逸口）。

**验证**：typecheck 0 错；vitest **105 绿**（含 3 个新用例）；官方 installer
装 0.4.16（sha256 93719389…，previous 0.4.15）；对安装副本双冒烟 PASS——
smoke_test 全链路（连接→PTY 回显→SFTP→关闭）+ smoke_fs_test **45 PASS /
0 FAIL**。真实终端回显需在 DBX 里重开 SSH 连接人工确认。

**说明**：七语不涉及（无新文案）；版本 0.4.15→0.4.16（Cargo.toml/lock/
manifest）。**installer 重编**：host 子模块同步后上游依赖需 rustc≥1.94，用
本机 1.97.1 工具链 `cargo +1.97.1 build -p dbx-core --example
install_plugin --release` 重编（不动源码树/锁文件）。

**波及面提示**：files 插件前端 `handleBinary`（files/download/ 分块流）同样
消费 `event.dataBase64`，对 0.6.2 宿主有同样的失效风险，需同款适配（归
 files/ 并行会话处理，本轮未动）。

**§8.11 增补（同日收敛）**：`binaryEvent` 已上移 `shared/frontend/` 公共适配层
（与 files 同源单点维护），App.vue 改相对引用、`lib/binaryEvent.spec.ts` 保留
为引用 shared 的薄 spec（3 用例，验证本插件工具链解析/打包/行为）；插件内本地
副本删除。约定见 shared/frontend/README.zh-CN.md 与 AGENTS.md 硬性规则 7。
复验：typecheck 0 错、vitest 112 绿。纯等价重构，已装 0.4.16 行为不变，下次
构建自动带上 shared 源码。

## 2026-09-04 批量发送命令 + 全局快速命令（0.4.17 → 0.4.18）

**需求**：① 支持在多个打开的会话批量发送命令；② 快速命令原存工作台
localStorage，宿主 webview 存储按工作台分区 → 表现为"和连接绑定"，改为插件级
全局存储，沉淀公共脚本。

**契约**（详见 PROTOCOL 新节）：
- 新增 `ssh/quickCommands/list|save|delete`：全局快速命令 CRUD，存储
  `<data_dir>/quick-commands.json`（原子写 + 0600 + 坏文件降级，照抄
  quick-sudo-profiles 模式）；上限 20 条、name ≤60、command ≤500；save 返回
  完整清单供工作台直接采纳权威顺序，delete 对未知 id 回 `removed:false`。
- 新增 `ssh/terminal/batchInput`：`{sessionIds[], command, appendNewline?=true}`，
  把命令写入各会话 PTY（对齐批量发送语义：输出回显在各自终端、不收集
  远端输出），返回逐会话 `{results[{sessionId,success,error?}], sent, failed}`；
  会话不存在/队列满记目标级失败不整体报错；命令归一 `\n`→`\r`、上限 256 KiB。
- `ssh/sessions/list` 行**追加**只读展示字段 `host`/`port`/`username`
  （连接注册表解析，缺失回退空/22/空），供批量目标列表显示 `user@host`。

**实现**：
- 后端：新模块 `quick_commands.rs`（存储 + 校验 + 单测 7 个）；`ssh.rs` 增
  `batch_terminal_input` 及纯函数 `batch_input_payload`/`dedupe_session_ids`/
  `batch_input_row`，`session_info_payload` 加 `ConnectionEndpoint`；
  `main.rs` 注册 4 个方法臂。
- 前端：`lib/batchSend.ts` 纯函数（目标归一/标签/多选/快捷选择/结果汇总）+
  spec 7 用例；App.vue 工具栏批量发送按钮 + 弹窗（目标多选、当前会话预选、
  全选/仅存活、快速命令下拉回填、危险命令复用 `confirmRiskyPaste` 红色确认、
  逐会话发送结果）；快速命令 CRUD 改走后端 RPC，挂载时 `hydrateQuickCommands`
  一次性迁移 localStorage 旧数据后清除本地键，后端不可用回退旧语义。
- i18n：`batchSend*` 15 key + `quickCommandsGlobalHint`，七语全补。

**验证**：cargo test **194 绿**（含 batchInput 纯函数/未知目标聚合、
quick_commands roundtrip/坏文件/上限）；前端 typecheck 0 错、vitest **119 绿**
（含 workbench.spec 七语 key 对齐）、build 通过；smoke
`scripts/smoke_batch_quick_test.py` **10/10**（quickCommands CRUD 全链路 +
batchInput 真机 PTY 回显 marker 验证 + endpoint 字段），回归 smoke_test /
smoke_fs_test（45 PASS）/ smoke_batch3_test（17 PASS）全绿。

**说明**：多会话标签/分屏仍 deferred（宿主职责），但批量发送以跨连接会话为
目标集合已不受"单 workbench"限制（原批次对标文档 deferred 表已注记，该文档已随批次退役删除）。
快速命令旧 localStorage 键仅作迁移种子，删除逻辑保留七语不涉及新键。

**⚠️ 预存在问题（与本次改动无关，待专项排查）**：`scripts/test.sh` 全套验证在
`smoke_sudo_otp_test.py` 的 "same-window replay rotates to the second secret"
用例失败（同一 TOTP 窗口内第二次 sudo exec，shim 未观测到任何 OTP 提交，
报 "no OTP submission observed"）。A/B 定位：2026-08-29 构建的旧二进制
`dbx-plugin-ssh-sftp` 两跑全绿（10/10）；**HEAD 提交源码原样构建的基线二进制
同样失败**——回归介于 8/29 旧二进制与当前 HEAD 之间（0.4.15→0.4.17 的
sudo 时间戳/OTP 编排改动），先于本次批量/快速命令改动存在。本次任务不涉及
exec/sudo/OTP 代码路径（diff hunk 已复核）。test.sh 后续两步按其自身 SKIP
语义处理：mock UI walkthrough（本机无 playwright-core，自门禁 SKIP）、宿主
plugin_tools_bridge（WIP 未集成不编译，文档化 SKIP）。perf baseline 实测通过
（终端回显 57.8 MiB/s、上传 149 MB/s、下载 122 MB/s）。建议下轮专项：
对照 0.4.14→HEAD 的 exec.rs/sudo 编排 diff 定位同一窗口二次提交被跳过的根因。

## 2026-09-05 MCP 只读门禁安全加固（纯后端轮）

**需求**：对只读模式做安全审查（面向 MCP/AI 调用场景），修复发现的缺口：
① 白名单混入"形似只读、实可变更"的命令（`sort -o`、`find -fprint/-fprintf/-fls`
可写文件；`ip route flush`/`ip link set` 等深层变更；`git branch -D`/`tag -d`/
`remote add`/`reflog delete` 变更形态；`dmesg -c/-C/-n`、`history -c` 清理态）；
② 只读门禁按 connectionId 键控，独立 stdio 内联凭据重拨同一主机可绕过；
③ 只读连接上读路径无界，`cat ~/.ssh/id_rsa`、`.env`、`/etc/shadow` 等凭据
位置可直达（LLM 注入后凭只读连接偷凭据的现实威胁）；④ `sftp_download` 在
只读连接放行且本地落点任意 + `overwrite` 可覆盖本机引导文件（落地即代码执行）。

**实现**（`backend/src/mcp_safety.rs`、`backend/src/mcp.rs`）：
- 分类器收紧：`sort -o/--output`（含粘连形式）、`find -f…`（`-fprint/-fprintf/
  -fls` 等）、`dmesg -c/-C/-n/--console-level`、`history -c/-d/-a/-r/-w/-p/-s`
  一律 Unknown；`git` 移出通用子命令表，改为形态敏感的 `git_segment_risk`
  （`branch`/`tag` 仅列表形态放行，`remote` 拒变更子命令，`reflog` 仅
  无参/`show`）；`ip` 增第二层变更子命令检查（`add/del/delete/flush/set/
  change/replace/append`）。
- 新增敏感路径拒绝清单：`is_sensitive_path`（`.ssh/.gnupg/.aws/.kube` 目录、
  `id_*`/`ssh_host_*_key` 私钥、`*.pem/.key/.p12/.pfx`、`/etc/shadow`、
  `/etc/gshadow`、`/etc/sudoers`、`.env*`、`.netrc`、`.git-credentials`、
  `.npmrc`、`.htpasswd`、`.pgpass`、`my.cnf`、shell/mysql/psql history；
  `.pub` 公钥半边放行，尾部 `*` 通配参与 basename 匹配）。命中即把白名单
  命令降级 Unknown——只读连接拒绝、普通连接不受限，复用既有门禁语义。
- `call_tool` 门禁序变为四层（写门 → 白名单 → 敏感路径 → 灾难确认）；只读
  连接上 SFTP 读工具（`sftp_list_dir/read_file/stat/exists/download`）与
  `ssh_task_status` 的 `path/remotePath/logPath` 参数过同一拒绝清单
  （`sensitive_read_path`）。
- 只读判定按连接身份兜底：无 `connectionId` 的内联拨打按
  `host(ASCII case-insensitive) + port(缺省 22) + username` 与已注册只读
  连接比对（`inline_dial_is_registered_read_only`），重拨同一主机不绕过。
- `sftp_download` 本地落点拒绝清单 `is_sensitive_local_path`（任何连接生效，
  保护操作员本机）：`~/.ssh`、`~/.gnupg`、shell 启动文件、`authorized_keys`、
  `/etc/cron*`、`/var/spool/cron`、`/etc/systemd/system`、`/Library/Launch*`
  等；`sftp_download` 工具描述同步。
- 文档：`MCP.zh-CN.md` 门禁章节改为四层并补本地落点防护段；runInTerminal
  小节注记敏感路径清单先于路由生效。

**验证**：cargo test **201 绿**（新增 7 用例：`whitelisted_output_flags_are_
unknown`、`deep_subcommand_mutations_are_unknown`、`sensitive_paths_downgrade_
read_only`、`inline_dial_inherits_registered_read_only_gate`、
`read_only_tools_respect_sensitive_path_denylist`、
`exec_whitelist_refuses_sensitive_paths_on_read_only`、
`sftp_download_refuses_sensitive_local_targets`）；smoke_mcp **全绿**（只读段
扩展：8 个加固形态 + 4 个白名单放行形态 + 敏感路径 exec/SFTP 双路 + 本地
落点拒绝，均离线跑通，无真机段 SKIP 不变）。无 UI 改动，七语不涉及；无新
协议方法，`PROTOCOL.zh-CN.md` 不涉及。

**边界与遗留**：① 按连接的目录白名单（`readPaths` 允许前缀，收窄只读连接
的读范围）需表单/七语/前端配套，本轮先落"敏感路径拒绝清单"这一层，留作
后续可选增强；② 工作台协议 `ssh/exec` 非 sudo 命令仍无白名单（前端信任面，
与交互终端同权级），未纳入 MCP 门禁范围；③ `kubectl get secrets`、
`docker inspect`（容器环境变量）属集群级读取，路径类拒绝清单覆盖不到，
如需管控须在动词层另行处理；④ 模型仍可调用 `ssh_quick_sudo_profiles_save`/
`ssh_remove_known_host`/`mcp/settings/set` 修改操作员本机配置（属本地配置
语义而非远端只读范畴，是否纳入进程级只读开关待定）；⑤ `scripts/test.sh`
全套未跑（历史已知 smoke_sudo_otp 预存在问题与本轮无关，见上节），本轮按
"改哪层跑哪层"以 cargo test + smoke_mcp 验证。

**§UI 功能测试跑通（同日续）**：`scripts/smoke_ui_mock.mjs` 从锚点可见性升级为
真功能走查并全绿。前置：playwright-core 装到仓外 `/tmp/dbx-ui-mock`（项目
package.json 保持零新依赖），系统 Chrome 走 `channel:"chrome"` headless。
- **顺带修掉 mock 夹具一个真 bug**：mock 宿主 `ssh/session/attach` 缺正常分支
  （仅 `failSessionOpen` 抛错，其余落兜底 `{success:true}`），启动时
  `findReattachSession` → attach 的 sessionId 校验必败，工作台一直停在
  Error 态（"The attached SSH session changed unexpectedly"）——此前 walkthrough
  的"绿"只是错误态下锚点也可见。补齐 attach 正常分支（回显 sessionId +
  `replay.complete`，对齐真实 sidecar 重挂语义）后 mock 工作台真正 Connected。
- **功能断言新增**：快速命令全局弹层（全局提示/添加行/删除后清空，1/20 计数）；
  批量发送弹窗（目标行 `user@host`、Current/Read only 徽标、快速命令下拉回填
  草稿、发送后 "Sent to 1 session(s)" summary、mock 终端 PTY 回显命令）；
  截图 01-03 存 `docs/screenshots-ui-mock/`（*.png 已 gitignore）。
- 依赖门控顺手修正：原 `existsSync(...) || existsSync(...)` 不会触发 skip，
  改为显式判断。连跑两轮稳定 all green；typecheck 0 错、vitest 119 绿。

## 2026-09-05 每连接 sudo 命令白名单（sudoers 式，纯后端 + manifest 轮）

**需求**：连接级 sudo 目前"全有或全无"——Quick Sudo 开启后 `ssh_exec_sudo`
可跑任意特权命令（仅灾难门兜底）。参照 Linux sudoers 为连接增加特权命令
白名单：操作员声明允许的 sudo 命令模式，AI/MCP 调用命中才放行。

**契约**：
- 连接表单新字段 `sudo_whitelist`（`external_config.sudo_whitelist`，text，
  `visible_when: sudo_source ∈ {custom, global}`）：每行一条（`;` 分隔兼容
  单行输入，`#` 注释），如 `systemctl restart nginx`、`docker restart *`。
  manifest 七语 label 全补；空 = 门关闭（向后兼容）。
- 匹配语义（`sudo_allowlist.rs`，比真实 sudoers 严）：令牌精确匹配；`*`
  匹配一个参数；结尾 `*` 匹配剩余且须至少一个参数；不写通配 = 仅精确命令
  （反转 sudoers "不写参数=任意参数"的危险默认）；命令前导 `K=V` 赋值与一个
  `sudo` 令牌剥离后匹配，`sudo` 旗标（`-u` 等 run-as）不建模、永不匹配。

**实现**：
- 新模块 `sudo_allowlist.rs`：`parse_entries` / `entries_from_lines` /
  `command_tokens` / `is_allowed` / `render_entries`（拒绝信息回显允许模式，
  `sudo -l` 风格，LLM 可自我纠正），单测 5 个。
- `model.rs`：`StoredConnection.sudo_whitelist: Vec<String>`（原始行），
  `from_lifecycle_params` 解析 external_config；`JumpHost::to_connection`
  与 mcp 内联构造点补空默认。
- 门禁三处：① MCP `call_tool`——`ssh_exec_sudo` 及 `ssh_exec`/`ssh_run_bg`
  内联 `sudo …`（`runs_under_sudo` 检出，防 NOPASSWD/时间戳缓存绕过）在
  灾难门之前过白名单；② 工作台 `ssh/exec` `sudo: true` 经
  `SshRuntime::ensure_sudo_allowed` 过门；③ 内联凭据重拨同一主机按端点
  身份继承白名单（复用上轮 `registered_connection_matching_inline`，只读门
  同步收敛到该共享助手）。结构化 `sudo_fs`（工作台 sudo 文件面板，用户主动
  UI 动作）与只读连接的"全拒 sudo"语义不变。

**验证**：cargo test **207 绿**（新增 sudo_allowlist 5 用例 + mcp
`sudo_allowlist_gates_privileged_tools`：connectionId 命中/未命中、匹配放行、
内联 sudo 门、身份继承、异机不受限，并覆盖 external_config 解析）；release
构建通过；smoke_mcp 回归全绿（stdio 无生命周期注册、白名单门离线不可达，
由单测覆盖）。manifest JSON 结构校验通过（字段序
`sudo_use_pty → sudo_whitelist → read_only`）。前端不改（表单宿主渲染）。

**边界与遗留**：① 白名单按"命令文本"匹配，不解析 shell——包 wrapper
（`timeout 10 systemctl restart nginx`）或引号变形不命中即拒绝（保守方向，
如需放开再议）；② sudoers 的 run-as（`-u`）/NOEXEC 等高级语义未建模；
③ 工作台交互终端手敲 sudo 不受此门（与既定信任模型一致：白名单管 AI/MCP
执行面）；④ `scripts/test.sh` 全套未跑（同前述预存在问题），按层验证。
### §8.12 TOTP 多密钥跨调用轮换：进程级 OTP 台账 + 目标作用域（2026-09-04）

**问题**：OTP 轮换/防重放两本台账（`otp_usage` / `committed_totp`）原挂在
`SudoAuth` 实例字段上。终端与 `ssh/exec` 路径按会话共享实例所以正常；但 MCP
`ssh_exec_sudo` 每次调用经 `resolve_sudo_auth` **全新解析实例**
（`sudo_auth_for` + profile overlay / `sudo_auth(arguments)`），台账随实例
丢弃——同窗第二次调用重复提交第一个密钥已用掉的码（服务端必拒），配了多密钥
也不轮换。这正是 MCP 通道跑 sudo + 2FA 的日常路径。

**修复**（exec.rs，分支 `feat/ssh-totp-rotation`）：
- 两本台账改 sidecar **进程全局**（`OnceLock<Mutex<HashMap>>`），对齐
  服务级标记 OTP 已用的语义；
- 键控升级：`目标作用域(user@host:port) | 密钥 SHA-256 指纹(16hex，只存指纹)
  | 窗口 | 码`；作用域隔离保证共用同一密钥的多个连接互不吞码（A 机烧掉的码
  B 机仍可提交），同机跨调用/跨会话记账连续；
- 静态码 usage 键去掉时间戳分量（原 `now+30` 逐秒漂移，跨调用记账失效）；
- 选择算法对齐轮换验证码优先级排序语义（未用优先 → 剩余有效时长
  最长 → 配置顺序稳定兜底），替换原"首个剩余 ≥5s 未用项"简化循环；防重放
  硬跳过语义不变；
- 作用域由凭据解析点注入：`ssh.rs sudo_auth_for`（连接配置）与
  `mcp.rs sudo_auth`（内联参数，port 缺省 22）。

**测试**：`cargo test` 188 通过（基线 184 + 新增 4：
`otp_rotation_spans_separate_instances`（红→绿，本修复主回归）、
`committed_replay_guard_spans_separate_instances`、
`static_code_usage_keys_do_not_drift_across_calls`、
`otp_ledger_marks_do_not_leak_across_targets`）。台账全局化后并行单测需隔离：
新增 `otp_ledger_test_guard()`（进入清空 + 持锁串行），触碰台账的用例全部
套上；`keyboard_interactive_answers_follow_flow_mode` 的 password+otp 组合
段改用独立静态码——全局防重放正确拦截了同进程内同窗二次注入，属预期新行为。

**真机**：`smoke_sudo_otp_test.py` 对 dbx-ssh-test 容器复跑 10 passed /
0 skipped / 0 failed（同窗轮换第二密钥、第三次硬跳过、错误密钥拒绝等全过）。

**文档**：PROTOCOL.zh-CN.md Quick Sudo 段（台账进程全局 + 作用域/指纹键控 +
排序语义）、MCP.zh-CN.md 工具表、`totpSecret` 工具 schema 描述补多密钥
（换行/分号分隔）轮换语义。

## 2026-09-05 启动恢复插件 tab 自动重连（boot 恢复路径 inactive 重试放开）

宿主侧已为启动恢复的插件 tab 重放连接生命周期（host/queryStore 新增
`reconnectRestoredPluginTabs`，见 shared/PROGRESS-HOST-SUBREPO 第 18 节）。
配套放宽本插件此前「inactive 立即失败」的假设：

- `openSession(forceNew, bootRestore)`：boot 恢复路径（`onMounted` 的
  会话打开分支）传 `bootRestore=true`，`Connection is not active` 与其它
  快失败一起走原有 3 次（2/4/6s）有界重试——宿主重放的 connect 落地后
  下一次 open 即自愈；重试耗尽仍回落七语 `connectionInactive` 指引。
- 非 boot 路径（`reconnect`/`reconnectNow`/掉线重连）保持 inactive 立即
  失败不变：连接确实没被宿主建立时重试不可能成功。
- 无新增用户可见文案（七语无改动）。
- 验证：`vue-tsc` 0 错；`vitest run` 12 文件 119 用例全绿。真机复验随
  host 第 18 节待办一并执行。

## 主题令牌桥：首绘同步与全覆盖（2026-09-05）

- 接入 `shared/frontend/themeSync.ts`（单点实现）：`main.ts` 挂载前
  `installHostThemeBridge()`，把 `--background/--primary/--radius/--*-font-family`
  等插件变量声明为宿主 `--color-*`/`--radius-*`/`--font-*` 令牌引用。首绘即命中
  宿主主题（此前等 init 后 JS 回写，亮色宿主下首绘落在 CSS 暗色默认）；宿主
  切主题时随 SDK 令牌更新自动跟随；primary/radius/字体首次纳入同步面。
- JS `applyAppearance` 保留（终端 ANSI 调色板等非 CSS 场景仍需）。
- 验证：`vue-tsc` 0 错；`vitest run` 13 文件 122 用例全绿（含新增
  `themeSync.spec.ts` 薄 spec）；v0.4.24 发版真机亮色主题下工作台首绘同步。

## 白色主题配色标准化（2026-09-05 第二轮）

四插件联合审查白色主题配色错误，语义令牌与明暗分支在
`shared/frontend/themeSync.ts` 单点收敛，插件只消费变量。

- 桥新增语义状态色 `--success`/`--success-bg`/`--warning`/`--warning-bg`
  （跟随宿主 `--color-success*`/`--color-warning*`；Host API 1.0/mock 缺令牌时
  light 分支回退宿主 tokens.css 规范值 rgb(22 163 74)/rgb(217 119 6)，暗色回退
  rgb(74 222 128)/rgb(251 191 36)）与模态遮罩 `--overlay`（亮色黑 40%，
  暗色 `color-mix(var(--background) 70%, transparent)`）。
- 明暗 CSS 分支统一双属性匹配：`:root[data-theme=…]`（插件 applyAppearance）+
  `:root[data-dbx-theme=…]`（宿主 SDK applyTheme），谁先到都生效，消除
  waitForHostApi 轮询窗口期的错配。
- ssh 本轮替换：会话状态徽章（#22c55e/#eab308/#f97316/#ef4444 → 语义令牌，
  connecting 黄色白底 1.9:1 不可读问题一并解决）、重连横幅（#f97316 →
  `--warning`）、`.folder-icon`（#e6ad52 → `--warning`，白底可读）、
  modal 遮罩（25%/dark 分支 → `--overlay`）、终端空态 SVG 硬编码深色
  （#111827/#1f2937/#60a5fa/#86efac/#e5e7eb → 主题变量内联 style）、
  `.terminal-command-marker.failed` → `--destructive`、图标 dark 变体双属性化。
- 验证：`vue-tsc` 0 错；`vitest run` 13 文件 123 用例全绿（themeSync 薄 spec
  增补语义令牌/遮罩/light 回退断言）。无新增文案，七语不受影响。

## 主题配色第三轮：progress 着色、预览选区、mock 桥接对齐（2026-09-05）

继续收敛残留的非令牌化配色与一处 fixture 漂移，改动均为前端单层：

- **metrics 磁盘警戒红从未生效**：`.disk-row progress.disk-warn::-progress-value`
  是无效伪元素（各家实为 `::-webkit-progress-value` / `::-moz-progress-bar`），
  任何浏览器都不匹配，磁盘 ≥85% 转红的意图从未渲染；同时磁盘/网络行 progress
  无 `accent-color`，走浏览器默认蓝。改为 `accent-color: var(--primary)` +
  `.disk-warn { accent-color: var(--destructive) }`（progress 跨浏览器唯一可靠
  着色点）。重连横幅 progress 补 `accent-color: var(--warning)`。
- **metrics 悬浮卡进程表头色差**：复用的全局 `.file-header` 带 `var(--background)`
  底色，在 popover 底色卡片上显出一块色差；加 `.metrics-float .file-header`
  上下文覆盖为 `var(--popover)`。
- **文本预览选区**：`TextPreview.vue` CodeMirror 选区色由单值 `#5f7aa855` 改为随
  colorScheme 切换（dark `#5f6f8a88` / light `#93b4e088`），与 xterm
  `selectionBackground` 同一观感。
- **mock.html 漏装主题桥**（规约第 7 条"mock 镜像真实桥形状"）：mock.html 自行
  复制了 main.ts 引导却缺 `installHostThemeBridge()`，导致 mock 中
  `--success/--warning/--overlay` 全部未定义——第二轮引入的语义令牌（连接状态点、
  文件夹图标、重连横幅、模态遮罩）在 mock 里根本显示不出来，视觉验证与生产脱节。
  改为 mock.html 直接 `import "./src/main.ts"`（与 visual.html 一致），从根上消除
  这类漂移。`mockDbxHost` 磁盘 fixture 把 `/data` 调到 87%，让 disk-warn 两态
  可被视觉验证覆盖。
- 验证：`vue-tsc` 0 错；`vitest run` 13 文件 123 用例全绿；
  `scripts/smoke_ui_mock.mjs` 全绿。无头 Chromium 对 `mock.html?theme=light|dark`
  逐项读计算样式并截图：磁盘 48%/0% 行 accent 为 `--primary`，87% 行为
  `--destructive`（light rgb(231 0 11) / dark rgb(243 98 95)）；`--warning`
  解析为 light rgb(217 119 6) / dark rgb(251 191 36)，重连横幅 progress accent
  跟随；连接绿点 `--success`（rgb(22 163 74) / rgb(74 222 128)）、文件夹图标
  `--warning` 两主题均正确。无新增文案，七语不受影响。
- 已知 fixture 局限（未改）：mock 启动路径经 `ssh/sessions/list` 附着既有会话、
  不调用 `ssh/session/open`，`?err=disconnect` 掉线计时器不触发，重连横幅只能靠
  计算样式探针验证而非全流程截图。

## 批量发送 "The object can not be cloned."（2026-09-06，根因在宿主桥）

真机批量发送报 WebKit DataCloneError。根因：`sendBatchCommand` 把
`batchSelected.value`（Vue 响应式 Proxy 数组）直接传 `dbxPlugin.invoke`，宿主
注入 SDK 的 `request()` 裸 `parent.postMessage`，Proxy 无法 structured clone。
修复在宿主注入 SDK 单点（params 普通化：structuredClone 优先、JSON 往返兜底），
四插件全部 invoke 调用点一并治愈；详见
`shared/PROGRESS-HOST-SUBREPO.zh-CN.md` §21。宿主重建后生效，本插件无代码
改动、无需重发包；mock 页因无 postMessage 克隆边界而不可复现该问题。

## UI 扫描 P1 修复：连接失败错误呈现 + 弹层焦点管理（2026-09-06）

第 1 轮场景化 UI 扫描（`docs/UI_SCAN_FINDINGS.zh-CN.md`）两条 P1 与顺手项 P2-3 的修复轮。
仅触碰 `frontend/` 内文件：`src/App.vue`、`src/lib/i18n.ts`（七语补键）、
`src/lib/connectRetry.ts` + `connectRetry.spec.ts`（新建）、`src/lib/modalFocus.ts` +
`modalFocus.spec.ts`（新建）。未提交 git、未动依赖；kafka/shared 仅读参考未改动。

- **P1-1 认证失败无限重试**：根因是 `openSession()` 每次重入把 `openRetryAttempt`
  归零，`OPEN_RETRY_MAX=3` 永远打不满，秒级失败的认证错误无限转圈、错误文案永不呈现。
  修复：`openSession` 增加 `isRetry` 参数，重试定时器重入保留计数、仅新入口归零；
  重试决策抽为纯函数 `connectRetry.decideConnectRetry()`（backoff 2s·N、单次 ≥8s 快失败
  窗口、inactive 非 boot 即败、auth/hostKey 永久错误跳过重试立即进 error 态）。
  error 态复用现有 overlay：`connectError.*` friendly 七语文案 + Reconnect 按钮（出口既有）。
- **P1-2 弹层焦点管理**：原生 autofocus 对 Vue 动态插入 DOM 无效，全部弹层焦点不进入、
  Tab 逸出、关闭落 BODY。修复：ssh 内落地 `modalFocus.ts` 纯函数
  （focusableElements / nextFocusIndex / decideModalKeydown / pickModalFocusTarget），
  App.vue 弹层开状态计数 watch 驱动"打开聚焦首控件（autofocus 属性改作定位提示）/
  关闭归还触发元素"，触发元素栈与嵌套深度同步 push/pop；右键菜单项这类打开后即卸载的
  瞬态触发元素不可承接归还，`focusin` 跟踪"弹层/右键菜单外最近稳定焦点"作回退目标；
  `onDocumentKeydown` 增加 Tab 焦点陷阱分支（无弹层不拦截，终端 Tab 穿透不受影响），
  Esc 关闭链原样保留。host-key/agent 审批安全弹窗参与聚焦与陷阱、但不参与 Esc 关闭。
- **P2-3 host-key 弹窗文案 i18n**：`Verify SSH host key` 等 5 处硬编码英文改走
  `hostKeyDialog.*` 七语 8 键（en/es/it/ja/pt-BR/zh-CN/zh-TW）。

验证：`pnpm typecheck` 0 错；`pnpm test` 19 文件 182 用例全绿（新增 connectRetry 7 +
modalFocus 9；既有七语键集合/占位符一致性测试自动看护新键）。浏览器复验
（vite :5291 + playwright-core + 系统 Chrome，走查脚本与截图均未入库）：
`?err=authfail` 于 t+0.5s/8s/15s 三观察点稳定呈现 friendly 文案 + Reconnect 出口、
无转圈、点击有响应；`?rw=1` 下命令对话框/批量发送/删除确认三类弹层 16 项检查全绿
（首控件聚焦、6×Tab + Shift+Tab 不出弹层、Esc 关闭后焦点归还触发按钮，删除确认不再落 BODY）。
遗留：P1-1 的真机 sidecar 认证失败重试节奏复核建议随下次真机轮补做；P2-1/P2-2/P2-4/P2-5/P2-6 夹具与打磨项未在本轮处理。

## UI 扫描第 2 轮清理：全部 P2 收口（2026-09-06）

第 1 轮 UI 扫描剩余 P2（P2-1/P2-2/P2-4/P2-5/P2-6）的清理轮。仅触碰
`frontend/` 内文件：`src/mockDbxHost.ts`、`mock.html`、`src/App.vue`、
`src/lib/toolbarTint.ts` + `toolbarTint.spec.ts`（新建）、
`src/mockDbxHost.spec.ts`（新建）。未提交 git、未动依赖；无新增用户可见
文案，七语不受影响。

- **P2-1 `?err=disconnect` 默认启动失效**：断开注入抽为 `scheduleDisconnect()`，
  open 与 attach（默认 reattach 启动路径）完成会话后都调用，全局单发不复发。
  直接打开 `mock.html?err=disconnect` 约 4s 后横幅自动出现，自动重连后恢复。
- **P2-2 默认首屏终端仅一行 prompt**：open 与 attach 共用同一份
  `terminalTranscript`（Welcome + OSC 633 周期 + prompt），attach 完成后推送，
  默认首屏即含 Welcome、命令回显与 command-marker 条（"Shell integration active"），
  command-marker 视觉验证不再依赖手动重连。
- **P2-4 light 主题工具栏染色对比度**：染色收口为 `lib/toolbarTint.ts`
  `toolbarTintStyle()` 纯函数（App.vue 原 `colorWithAlpha` 内联逻辑迁入），
  dark 保持 10%/18%，light 压到 4%/8%。浏览器实测 light 下会话 pill 对比度
  4.53:1（修复前 ≈4.22:1，AA 达标）。
- **P2-5 `?mock=1` 过时注释**：更正为"无条件生效，无开关参数"。
- **P2-6 dev 首载 404 噪音**：mock.html `<head>` 补 `data:` 占位 favicon，
  首载 0 条 4xx 资源请求、console 干净。

验证：`pnpm typecheck` 0 错；`pnpm test` 21 文件 191 用例全绿（新增
toolbarTint 6（含 WCAG ≥4.5:1 回归口径）+ mockDbxHost 3（happy-dom +
fake timers 锁定 attach 回放与断开单发语义））。浏览器复验（vite :5291 +
playwright-core + 系统 Chrome，10/10 项通过；走查脚本装于
`/tmp/uiscan-ssh-r2` 不入库，截图已删）：默认首屏 Welcome/OSC 633/marker 条、
`?err=disconnect` attach 路径自动断开→横幅→重连恢复、light 染色 alpha 与
pill 对比度 4.53:1、dark 染色不变、404/console 零噪音。本次顺带解除此前
PROGRESS 记录的"fixture 局限：重连横幅只能靠计算样式探针验证"——现在可全流程
浏览器验证。第 1 轮 P1-1 的真机 sidecar 认证失败重试节奏复核遗留项不变。

## UI 扫描第 3 轮修复收口（接手中断半成品）+ 第 4 轮复验记录（2026-09-06）

第 3 轮专家深度测试（`UI_SCAN_FINDINGS.zh-CN.md` 第五章，P1×3 + P2×7）的修复
由前一 agent 发起后中断。本轮接手做逐条审计：`src/lib/` 下
ghostClickGuard / requestEpoch / remotePathInput / sftpRename（另有同批
sftpEntries / fileRowKeydown / 既有 toolbarTint）**均已完成实现、App.vue/
DirTree.vue 接线、配套 spec 与七语文案**，完成度高于中断时预期，10/10 无需
补代码；本轮工作为全量回归验证 + 浏览器复验 + 文档收口。仅触碰
`frontend/` 内文件与两份 docs，未提交 git、未动依赖。

- **R3-P1-1 幽灵点击重开弹层**：`lib/ghostClickGuard.ts`（400ms 抑制窗 +
  mousedown 前驱判定，真实鼠标点击放行）；焦点归还前 arm，document capture
  级监听拦截合成 click。7 条单测。
- **R3-P1-2 / R3-P2-1 Esc 取消仍提交 + Enter 双发**：`lib/sftpRename.ts`
  `shouldCommitRename`（editingPath 指向校验 + submitting 分支）；Esc/Enter
  先清 renamingPath，卸载引发的幽灵 blur 被短路。6 条单测。
- **R3-P1-3 目录加载竞态**：`lib/requestEpoch.ts`；loadDirectory 取单调序号，
  落地/catch/finally 三处 isCurrent 校验，过期响应整体丢弃。4 条单测。
- **R3-P2-2 重命名冲突预检**：commitRename 增加 sftp/exists 预检 +
  window.confirm（七语新 key `sftpRename.overwriteConfirm`），失败路径关编辑
  态并刷新；mock `sftp/rename` 收口为原子语义（撞名不丢源）+ 2 条夹具单测。
- **R3-P2-3 坏响应防御**：`lib/sftpEntries.ts` `sanitizeSftpEntries`（非数组
  → 空数组、坏行丢弃、缺 kind 降级 file），loadDirectory 落地前统一过
  sanitize。7 条单测。
- **R3-P2-4 路径栏 `~`/`..`**：`lib/remotePathInput.ts`
  `resolveRemotePath`（home 展开 + `..` 消解 + 基础归一），路径栏 Enter 走
  `submitPathInput()`。9 条单测。
- **R3-P2-5 键盘打开**：`lib/fileRowKeydown.ts` `decideFileRowAction`，文件行
  Enter 打开 / F2 重命名 / Delete 删除（只读连接仅 Enter）。4 条单测。
- **R3-P2-6 树键盘 + caret 名**：DirTree.vue 加 role=treeitem、aria-expanded、
  roving tabindex、Enter/Space/方向键导航；caret 补 aria-label（七语
  `sftpSide.expandNode/collapseNode`）。组件测试 +5 条。
- **R3-P2-7 zh-TW「批次」**：i18n zh-TW batchSend* 全组「批量」→「批次」，
  zh-CN 不变。

验证：`pnpm typecheck` 0 错；`pnpm test` 27 文件 **237 用例全绿**（第 2 轮
基线 191 + 新增 46）。浏览器复验（vite :5291 + playwright-core + 系统
Chrome headless，`/tmp/uiscan-ssh-r4b` 不入库）：按第 3 轮复现步骤逐条复验
**11/11 PASS**（10 条 + P2-2 取消路径变体）——mkdir 键盘 Enter 一次成功关闭
不重开、Esc 取消重命名 0 invoke、慢 /etc 竞态不回跳、Enter 重命名单发无假
横幅、撞名 confirm 接受/取消两路均收敛、entries:null/畸形行 0 pageerror、
`~` 与 `..` 正确消解、键盘 Enter 逐级进目录、树 6/6 treeitem + 0 无名
caret + 方向键移焦、zh-TW「批次」在位。复验截图 0 张留存（失败才截图，
调试图已删）。新增用户可见文案七语齐（en/zh-CN/zh-TW/es/it/ja/pt-BR）。
遗留：R3-P1-1 的宿主真实 webview 复核建议保留；zmodem/拖拽上传 headless
不可达（沿袭第 1 轮）。

## tssh 对标特性追赶：trz/tsz + SetEnv/RemoteCommand（0.4.34，2026-09-07）

> 分支 `feat/ssh-tssh-parity`（worktree `.worktrees/feat-ssh-tssh-parity`，
> 对标参照 [trzsz-ssh](https://github.com/trzsz/trzsz-ssh)）。并发双工作包
> （前端/后端文件所有权不相交）+ 主会话集中收口。**范围决策（用户，
> 2026-09-07）：转发类特性不做**——端口转发（-L/-R/-D）与 Agent 转发
> （ForwardAgent）均否掉，理由：宿主已有 ssh 隧道实现（连接代拨模型，
> `dbx-core/src/db/ssh_tunnel.rs`）；宿主能力盘点结论（无 -R、无面向用户的
> 转发会话 UI、插件桥无任意 host:port 转发接口）已存档
> `FEATURE_PARITY.zh-CN.md` tssh 补充节。后端工作包原含 Agent 转发，中途
> 按决策裁剪：其 model.rs 半成品被主会话收编，剥离 `forward_agent` 字段，
> 保留 SetEnv/RemoteCommand 两字段解析与契约测试。

**工作包 B（前端，trz/tsz 文件传输）**：引入 `trzsz` 1.1.6（trzsz.js 官方
JS 实现，MIT）——**本插件前端首个依赖豁免**，理由：协议帧收发/转义/tmux
兼容/MD5 校验全在包内，自研等于重写协议；连带 `tsconfig.json` 加
`skipLibCheck`（包内 d.ts 引用了未装 scope 的 `xterm` 类型，本项目用
`@xterm/xterm`，skipLibCheck 是不动第三方文件的最小解法）。集成形态：
`TrzszFilter` 流式挂接（不用绑 WebSocket 的 TrzszAddon）——PTY 下行帧经
`processServerOutput` 空闲透传 + announce 扫描（`::TRZSZ:TRANSFER:`），
传输中输入接管（Ctrl+C 停传）；`sendToServer` 走现有 8 字节序号前缀输入
路径；与 zmodem 共存互斥（`terminalInteraction.ts` 的占用守卫统一为
`transferBusy`）；实例级覆写 `handleTrzszUploadFiles/handleTrzszDownloadFiles`
（浏览器构建硬编码 File System Access API，WKWebView 沙箱没有）——上传走
隐藏 `<input type=file multiple>`，下载缓冲成 Blob 后宿主 `fileTransfer`
优先、`<a download>` 兜底；进度 overlay（单/多文件 i/N、百分比、速度、
取消）；右键菜单「Upload (trz)」向 PTY 发 `trz\r` 触发远端，5s 未响应报错
+15s 看门狗。i18n 七语各 +8 key（trzszUpload/trzszWaiting/trzszUploading/
trzszDownloading/trzszComplete/trzszFailed/trzszNotAvailable/
trzszCancelled）。新增 `lib/terminalTrzsz.ts` + 26 条纯函数单测。

**工作包 A（后端，SetEnv + RemoteCommand）**：
- 连接表单新增 `setEnv`（textarea，多行 `KEY=VALUE`，分号兼容；严格校验：
  非法条目聚合报错连接失败，"宁可连不上也不错配"；重复 key 后者覆盖）与
  `remoteCommand`（text，trim 非空生效），七语 label/description/placeholder
  齐，位于 `keepalive_interval_secs` 与 `sudo_source` 之间；三个
  manifest↔parser 契约测试为此转绿。
- SetEnv 注入点：交互 shell 通道（`open_session` PTY 后、shell/exec 前）+
  `exec_plain`/`exec_with_sudo` 两分支（`exec.rs` 新增纯函数
  `merge_channel_env`：内置默认 best-effort、用户条目 strict 且同名覆盖，
  每变量恰请求一次；与既有 `SUDO_ASKPASS` 清空共存，用户值优先）。russh
  `set_env` 为 fire-and-forget，服务端无 `AcceptEnv` 时静默不生效——与
  ssh(1) 同语义，PROTOCOL 文档已注明需服务端配合。
- RemoteCommand：`open_session` 中非空时 `exec` 替代 `request_shell`
  （PTY 照常）；命令退出即会话终止（与 `ssh host command` 一致）；
  reattach 重放属预期；MCP/sudo/replay 路径零改动（`mcp.rs` 直构连接点补
  空默认）。JumpHost 显式不继承两字段（只作用于最终会话）。
- smoke_test.py 新增两用例：exec 通道 `echo $DBX_SMOKE_ENV` 实测回显、
  remoteCommand 会话回放含标记输出（测试容器 sshd_config 追加
  `AcceptEnv DBX_SMOKE_ENV` 并重启，仅测试容器可逆改动）。
- PROTOCOL.zh-CN.md 同步：RPC 表、连接字段、新章节「会话环境与会话命令
  （SetEnv / RemoteCommand）」。

**验证（0.4.34，`scripts/test.sh --skip-host` + 手动补跑尾两步）**：
cargo test **214/214**（基线 211 + 3 契约转绿 + 3 merge 单测）；前端
typecheck 0 错、vitest **263/263**（基线 237 + 26）、build 过；release 构建
+ .dbxp 打包（0.4.34）+ MCP stdio smoke 过；live smoke：smoke_test PASS
（含新 setEnv/remoteCommand 用例）、smoke_fs **45/45**、smoke_batch3
**17/17**、perf 基线过（upload 网络 160 MB/s 量级）、mock UI walkthrough
全绿。smoke_sudo_otp **8 passed/1 skipped/1 failed**——失败用例
"same-window replay rotates to the second secret" 为**文档在案的存量回归**
（0.4.15→0.4.17 sudo 时间戳/OTP 编排改动引入，见上文 ⚠️ 预存在段落），
本轮 A/B 复核：已安装 0.4.33 副本同样失败、本分支构建同样失败——与本轮
改动无关，专项排查遗留。test.sh 因此在该步中止（set -e），尾两步
（perf/UI mock）已手动补跑通过。

**合并注意**：主工作区存在未提交的 0.4.32→0.4.33 版本号 bump
（manifest.json/Cargo.toml/Cargo.lock）与 UI_SCAN_FINDINGS 文档更新；
本分支已 bump **0.4.34**（越过 0.4.33），合并时版本行以本分支为准，
UI_SCAN 文档改动与本分支无交集可并行保留。worktree 内 `host` 为指向主
工作区子模块的符号链接（path 依赖所需），呈现为 typechange，勿提交。

**遗留**：① trz/tsz 真机实流验证（对装了 trz/tsz 的测试容器跑 `trz`/`tsz`
全流程 + WKWebView 真机 file picker/cancel 行为）——本轮 headless 无法
构造，机制层有 26 条单测 + announce 看门狗兜底；② remoteCommand 命令退出
即断开的产品语义是否保留（备选：退出后回 shell 或提示重连）待用户定；
③ smoke_sudo_otp 存量回归专项排查（归档在案，非本轮引入）；④ setEnv 在
默认 sshd 上需 `AcceptEnv` 配合，文档已注明。
### §8.13 设置弹窗/配置编辑器回显已存原值（2026-09-04）

**问题**：Quick Sudo 设置弹窗与全局配置编辑器的 sudo 密码 / TOTP 密钥输入框
打开时永远空白，仅靠占位符提示"已配置"——用户看不到自己存的原值
（`settings/get` 与 `profile_view` 只回布尔位，设计上从不回显），多密钥
原文（换行/分号串）更是完全无处可查。

**修复**（回显仍是显式、有边界的）：
- `ssh/settings/get` 新增可选 `revealSecrets: true` → 额外回显本连接配置的
  `sudoPassword` / `totpSecret` 原始串；缺省响应与此前完全一致（布尔位），
  MCP 通道不暴露该参数。设置弹窗 `openSettings` 传参预填两个 draft 字段；
  `refreshSettingsMeta` 保持不回显。
- 新增 `sudo/profiles/reveal { id }`（工作台专用，**不进 MCP 工具面**，密钥
  不进 agent 上下文）：返回完整视图含原值；未知 id 报错。配置编辑器
  `startProfileEdit` 在有已存密钥时异步 reveal 预填（带 id/编辑态守卫，
  失败回落占位提示）。保存语义不变：空串/清空字段=保持原值，清除走既有
  清除按钮 / clear 标志。
- `mockDbxHost.ts` 镜像两个方法当前形状（reveal 回空串壳）。

**测试**：`cargo test` 189 通过（新增 `reveal_returns_raw_secrets_for_the_
editor`：原值回显 + 未知 id 报错；`views_never_echo_secrets` 证明 list 视图
仍不回显）。前端 typecheck 0 错、vitest 102 过、build 成功。smoke：
`smoke_sudo_otp_test.py` 新增 `revealSecrets` 用例（默认不回显断言保留 +
reveal 回显多密钥原文）；`smoke_fs_test.py` 新增 `sudo/profiles/reveal`
用例（原值返回 + 未知 id 报错 + list 仍 flag-only）。

**文档**：PROTOCOL.zh-CN.md（`ssh/settings/get` revealSecrets 参数、
`sudo/profiles/reveal` 方法条目及其"仅工作台、不进 MCP"边界）。宿主渲染的
连接表单 `totp_secret` 字段属宿主表单体系，不受本插件控制，不在本轮范围。

### §8.14 修复：OTP 预注入后 watcher 重复应答同一提示，烧掉第二密钥的码（2026-09-05，合并最新 master 后）

**合并 master（kafka、ssh 批量快捷命令 + sudo allowlist、shared/frontend
适配层）后真机 smoke 暴露新问题**：`same-window replay rotates to the
second secret` FAIL——同窗第二次 sudo 无任何 OTP 提交，防重放台账把两个
密钥的码都记为已提交。

**根因**（stderr trace + 提交日志双证）：`exec_with_sudo` Phase 1 把密码与
OTP 码一起预注入 stdin（`totp_answer_logged` → take #1，烧 secret_a 的码），
但 Phase 2 watcher 的 `otp_answered` 标志仍是 false——shim/PAM 打出的**同
一个** "Verification code:" 提示被 watcher 当作新提示再次应答（take #2，
轮换选中 secret_b 的码），写入的码无人消费、直接废弃，但 usage/committed
双台账已标记。同窗第二次 sudo 时 a、b 两码均已 committed，selection fallback
选中已提交码被防重放守卫拦截——轮换语义失效。

**修复**：`PromptContext` 增加 `otp_piped` 标志，Phase 1 成功预注入 OTP 码
时 watcher 的 `otp_answered` 初始为 true（同一提示不再二次应答；预注入被
防重放跳过时保持 false，后续真实提示照常应答）。

**验证**：cargo test 212 通过；前端 typecheck 0 错 / vitest 119 过 /
build 成功（合并 master 后全量复验）；真机 smoke：otp 11 passed / 0 failed
（同窗轮换、第三次硬跳过、错误密钥拒绝、revealSecrets 回显全过），
fs 46 passed / 0 skipped / 0 failed（含 `sudo/profiles/reveal` 新用例）。

**排障基建**：`smoke_sudo_otp_test.py` FAIL 时打印完整提交日志（定位
"码谁烧的"）与 sidecar stderr 过滤尾（进程退出后 drain，避免管道阻塞）。
另注：sidecar 启动依赖可执行文件名 `dbx-plugin-ssh`——非同名副本无法
initialize（sidecar closed），smoke 直连二进制排障时需保持原名。

### §8.15 MCP 本地传输根约束：sftp_upload/download 路径穿越修复（2026-09-07，合并 totp-rotation 轮）

**背景**：合并 `feat/ssh-totp-rotation` 的收尾 commit 被 Mimosa L3 门槛拦截
（6 个 high：mcp.rs 1311/1372 为 sftp 传输工具真实暴露面，945/949/1819/1820
为 sudo_auth 误报，见下）。经用户决策走"先修复再合并"路径。

**修复（真实问题，sftp 两条）**：agent 可指定任意本地路径读（upload 装箱
外送）写（download 落盘），原仅有下载侧敏感路径黑名单。新增本地传输根
约束（`mcp.rs` `local_transfer_roots_for` / `ensure_local_transfer_allowed_in`）：

- `mcp/settings` 新增 `localTransferRoot`（绝对路径或空串；持久化进
  mcp-settings.json）。配置后允许根=该目录；未配置默认=系统临时目录 +
  插件数据目录。canonical 化后 `starts_with` 判定（macOS `/var` 别名不漏）。
- 敏感路径黑名单（`.ssh`/`.gnupg`/shell 启动文件/引导执行路径）升级为
  **双向、任何模式叠加**——upload 侧首次获得防凭据外传校验，配置根内同样
  拦截。
- 配置根不可解析时报错而非静默回落；`mcp/settings/set` 是操作者协议面，
  `mcp/tools`/`mcp/call`（agent 面）不可达——**agent 无法自我扩根**。
- 单测 +5：门槛约束/黑名单叠加/默认根解析/配置校验/持久化 roundtrip
  （220 全过）。

**误报论证（sudo_auth 四条，链 `sudo_auth → new → load(sink:path-traversal)`）**：
`SudoAuth::new` 全链纯字符串处理（`exec.rs` 全文件零 `fs::` 调用），
`sudo_auth()` 的输入是凭据串，可达的 `load`（McpLimits::load /
sudo_profiles::load_store）入参均为 data_dir 固定路径——污点链为扫描器对
泛型名 `new`/`load` 的跨函数混淆，扫描器自身标注 "静态 advisory 需人工确认"。
未为此改代码（改即迎合误报）；如重扫仍报，需在门槛侧按误报处置。

**遗留**：smoke_mcp.py 的门槛拒绝用例（仓库外根双向拒绝 + 根内敏感路径
拒绝）因 Mimosa Edit 钩子对该文件的幻影误报（引证 `../`，实测全文零匹配）
连续拦截写入而暂缓；门槛逻辑已由单测全覆盖，smoke 用例待钩子侧澄清后补。

## 0.4.35 安装被宿主兼容性校验拦截：setEnv/remoteCommand 表单 key 改 snake_case（2026-09-07）

**现象**：`install.sh` 装 0.4.35 连续两次失败（重编 installer 后复现一致，
非构建缓存坑）——宿主 `dbx-core/src/plugins/manifest.rs` 报
`Contribution at index 0 field 11/12 has an invalid or duplicate key` +
六语 localization（es/it/ja/pt-BR/zh-CN/zh-TW）的
`io.dbx.ssh.connection/setEnv|remoteCommand` invalid field entry。

**根因**：0.4.34 tssh 对标轮把两个连接表单字段 key 起成了 camelCase
（`setEnv`/`remoteCommand`），而宿主 `valid_identifier` 只允许小写字母/数字
加 `.`/`-`/`_`——不允许大写。打包期未拦截（CLI 不跑宿主兼容校验），
安装期才爆。en 未被点名是因为 en 文案走字段定义默认 label，本就没有
contribution fields 条目。

**修复**：manifest 字段 key 与六语条目统一改 `set_env`/`remote_command`
（sidecar 解析本就双名兼容 `model.rs` `["setEnv", "set_env"]`，存量 camelCase
连接不受影响；宿主表单此后按新 key 存 config，旧存量在表单中回显为空、
拨号行为不变）。连带同步：`model.rs` 三个防漂移测试数组、
`smoke_test.py` 构造配置改用规范 key、PROTOCOL §「会话环境与会话命令」
与 FEATURE_PARITY tssh 节字段名更正。

## 连接保活盘点 + 终端活动保活（opt-in）+ external_config 解析修复（2026-09-08）

**背景**：用户报告公司策略下 SSH 连接/sudo 状态被空闲超时掐断，要求"添加保活"。
先盘点发现两层保活早已存在，真正缺口有二：服务器侧按键盘活动判空闲的策略
（`TMOUT`、堡垒机审计）协议层探测无效；且 `keepalive_interval_secs` 表单值
从未真正生效（见下）。

**现状盘点（不改即有）**：
- 协议层 keepalive：`bbb9c81`（2026-08-29）起三条拨号路径（正式连接/跳板每跳/
  host-key 探测）均配置 russh `keepalive_interval`（默认 30s）+ `keepalive_max: 3`
  （want_reply 全局请求，等效 OpenSSH `ServerAliveInterval`；任一收到的数据
  重置计数），对齐 keepaliveInterval=30s / keepaliveMaxFail=3。
- Quick Sudo 时间戳保活：sudo 执行成功后注册 `sudo -nv` 循环（4 分钟周期、
  连续 2 次失败自停、断连确定性中止）。

**新能力：终端活动保活 `terminal_keepalive_secs`（默认 0 关闭）**
- manifest 连接表单字段（binding `config`，number，0 关闭；en + 六语
  label/description 全补）；`model.rs` 解析 + `clamp_terminal_keepalive`
  钳制 5–3600s；跳板 `to_connection` 与 MCP `StoredConnection` 固定 0。
- `ssh.rs` `open_session` 按连接配置 spawn 每会话任务，经 `terminal_tx` 注入
  `TERMINAL_KEEPALIVE_INPUT`（`" \x7f"` 空格+退格：空命令行不入 history，
  全屏程序内仅光标往返）；只持有命令 sender，会话读循环退出（关闭/断连）
  即随 `send` 失败终止。`ssh/sessions/list` 新增 `terminalKeepaliveSecs` 上报。
- **开发期自抓回归**：首版任务循环漏写循环内 `tick`（`while send.is_ok(){}`）
  退化 busy-loop，真机 15s 灌 7705 帧——调试脚本抓到后修复为
  `loop { tick; send; }`，复测 15s 恰 3 次注入、回显每帧 <20 字节。

**修复 1：`connect_timeout_secs`/`keepalive_interval_secs` 表单值从未生效**
宿主 `buildPluginConnectionConfig` 把全部 `binding: config` 字段写入
`external_config`（PROGRESS-HOST-SUBREPO §700 实锤），而这两个字段解析只读
顶层 `connection` 对象——表单值被静默丢弃、默认值 15/30 恒生效（keepalive
靠默认 30s 碰巧可用）。按 `read_only` 收敛先例改为
`config_u64(external_config ∥ connection)`，新增单测钉住表单值生效。

**修复 2：基线失败测试 `manifest_connection_fields_stay_in_sync_with_parsing`**
d84787d 连接表单重构重排了 manifest 字段顺序但未同步测试期望数组（基线即
红）。按现 manifest 顺序更新，并纳入新字段 `terminal_keepalive_secs`。

**测试**：cargo test 221 全绿（含新增 `terminal_keepalive_is_opt_in_and_clamped`、
`session_info_payload` 断言扩展）；新增
`scripts/smoke_terminal_keepalive_test.py`（真机：sessions/list 上报 + 空闲窗
观测注入回显 + 会话存活，14s）；`smoke_test.py` PASS、`smoke_fs_test.py`
46/46 对新二进制回归通过。文档：PROTOCOL §「跳板机与连接存活」+ sessions/list
字段表。

## 批量发送交互改版：终端底部命令条（Electerm quick-command bar 风格，2026-09-08）

原"工具栏按钮 + 弹窗"批量发送改为**常驻贴在终端底部的单行命令条**（思路来源
Electerm quick-command bar；批量发送语义不变），纯前端改动，
协议面不变（`ssh/terminal/batchInput`、`ssh/quickCommands/*`、`ssh/sessions/list`
原样复用）。

**命令条组成**（`connected` 时显示；工具栏 ListChecks 按钮改为开关，is-active
态 + localStorage `ssh-batch-bar-open` 持久化，默认开）：

- 目标选择按钮 `目标 {count}/{total}` → 向上展开 popover（复用原目标列表：
  复选框、当前/已断开/只读徽标、全选/仅存活/刷新；顶部保留 batchSendHint 说明）。
- 快速命令 `<select>`：切换即回填输入框（不自动发送，回车/发送键触发）。
- 命令输入框：**回车即发送**；发送后命令保留在输入框（回车即重发的高频路径，
  Electerm 语义），危险/超长命令仍复用 `confirmRiskyPaste` 红色确认。
- 保存按钮（Save 图标）：切换为内联名称输入（默认名 = 命令压平空白截断 30 字），
  走 `ssh/quickCommands/save` 全局共享（≤20 条，超限置灰并提示）；保存成功后
  下拉自动选中该命令。
- 发送按钮（Send 图标 + Loader2 忙态）。

**结果浮条**：发送汇总/错误显示在命令条上方的浮条（复用 zmodem-status 视觉），
失败逐会话列出，手动关闭。

**布局细节**：`.terminal-pane.batch-bar-open` 时 `.terminal-host` inset 底部
让位 37px（ResizeObserver 自动 refit xterm）；command-marker / zmodem-status
底部偏移同步上移避让；目标 popover 改为向上展开（默认向下会被底部裁切）；
命令条根节点 `@contextmenu.stop` 防误触终端右键菜单；Esc 关闭链纳入目标
popover 与保存名称态（原弹窗的 modalOpenStates/Esc 分支移除）。

**目标列表行为**：连接建立 watch 自动刷新；刷新时剔除已关闭会话，选择为空才
兜底预选当前会话（原弹窗每次打开重置，命令条改为粘滞选择）。

**代码**：`App.vue`（状态/函数/模板）；`lib/batchSend.ts` 新增纯函数
`deriveBatchCommandName`/`quickPickCommandById`；`style.css` 弹窗样式段改写为
命令条样式段。i18n 七语新增 `batchBarSave`，其余文案复用 batchSend*/quickCommands*。

**测试**：vitest 268 全绿（新增 5 用例：默认名压平/截断/空串、下拉按 id 取命令
含未知 id）；`vue-tsc` 0 错误；前端 build 通过（UI 自包含产物写入 `ui/`）。
后端与协议零改动，无新增 smoke 用例（batchInput/quickCommands 已有覆盖）。

## 批量命令条首轮反馈修复：清空/历史/跨工作台同步 + 并发同靶 OTP 延迟补答（2026-09-08）

命令条上线后首轮真机反馈四项修复，其中 OTP 一项为后端行为修复（用户明确
诉求："totp 全用过了，应答时等待一下、延迟应答，而不是中断输入"）。

**1. 目标 popover 刷新按钮图标过大**：link-button 内 lucide 图标未约束尺寸，
去掉图标改纯文字（与"全选/仅存活"兄弟链接一致）。

**2. 跨工作台状态同步**（原"各自为政"）：命令条草稿/快速命令下拉选中/开关
状态现在跨工作台同步。新增 sidecar 方法 `ssh/batchBar/state`（notify 语义）：
工作台把 `{ source, draft, quickPickId, open }` 送达 sidecar，sidecar 原样
以同名事件广播给**所有**插件 webview（宿主 `app_handle.emit` 全局广播，各
端 `onEvent` 收到后按 `source` 过滤自己的回声）。输入去抖 150ms，开关/下拉
/发送清空立即发；sidecar 不落存储、纯转发；旧版二进制未注册时前端静默降级
（只影响同步不影响本端）。远端应用不打断本端焦点，不触碰保存态/弹出层。

**3. 发送后清空**：回车发送成功（sent>0）即清空输入框与下拉选中并入命令
历史（对齐原弹窗语义）；全部失败时保留草稿便于重试。

**4. ↑/↓ 历史浏览**：命令条输入框复用与命令弹窗同一份 `commandHistory`
（环形 100、去重、疑似凭据不落盘），↑↓ 语义与弹窗一致（进入浏览态备份
草稿、越过最新一条恢复）。

**5. 并发同靶 OTP 延迟补答（后端）**：批量发送 sudo 命令到同一 host:port
的多个会话时，各会话 OTP 提示几乎同时出现，当前窗口唯一的码被先到会话
提交后，重放保护（committed ledger，±1 step）会拒绝重复注入——原行为直接
跳过应答，后到会话永远晾在提示符上（用户被迫手动干预"中断输入"）。现在：

- `exec.rs`：`SudoAuth::answer_for_with_retry`（终端 watcher 专用变体）在
  OTP 承载型回答撞重放保护时返回 `(None, 下一个窗口边界+1s)`；`TerminalAutoSudo`
  新增 `otp_deferred_kind/until` 推迟态，`take_deferred_otp(now)` 到期重试、
  拿到新窗口码即注入并清推迟态，仍被抢则顺延下一窗口；shell 提示符复位、
  直接应答成功均清推迟态；静态恢复码不变不推迟（重试无意义）。
- `ssh.rs`：终端读循环既有的 250ms directory tick 臂上挂 `take_deferred_
  otp(unix_now_secs())`，到期即向 PTY 注入码并回车，发 `ssh/auto-sudo`
  事件（`kind=otp`）——与其他会话的应答在时间上天然错开 ≥1 个窗口。
- MCP exec 路径应答语义不变（仍走 `answer_for`/`take_totp_answer` 硬跳过）。

**验证**：cargo test 222 全绿（新增
`concurrent_same_target_otp_prompt_defers_then_answers_next_window`：账本
时间回拨模拟窗口滚动，钉住"撞重放→推迟→到期补答→一次性"全链路）；
vue-tsc 0 错、vitest 268 全绿、前端 build 通过；release 二进制上
`ssh/batchBar/state` 冒烟 PASS（`{'broadcast': true}`），smoke_fs_test.py
新增对应用例（未注册旧二进制上 SKIP）。协议文档：RPC 表新增方法行 +
「终端内 Quick Sudo」节补并发排队语义。剩余风险：真机 TOTP 容器下的多会话
并发 sudo 流未端到端演练（单测已钉住核心时序）；跨工作台同步依赖宿主全局
事件广播（当前 `app_handle.emit` 实现为全局，若宿主改为定点投递需跟进）。

### 命令条遮挡终端底行修复（同日第二轮反馈）

**现象**：终端内容滚到底部被命令条遮住；即使不开命令条，底行也略有溢出。

**根因**：FitAddon 计算行数读的是 `terminal.element`（`.xterm`）自身的
computed padding 做扣减，而原布局把 `padding: 5px 0 5px 10px` 挂在宿主
`.terminal-host` 上——fit 比实际可视区多算约 10px，底行渲染到 `.xterm`
框外；命令条打开时这段溢出正好压在条下。

**修复**（`style.css`）：内边距原样移到 `.terminal-host .xterm` 上
（box-sizing 全局 border-box 已有，fit 从 element 读 padding 后行数精确），
底部间距 5px → 8px 作为常驻呼吸间距；命令条让位 37px → 42px（条 ~35px +
7px 间隙），command-marker / zmodem-status 偏移 45px → 50px，结果浮条
41px → 48px。ResizeObserver 观察宿主 div，inset 变化自动 refit，无需前端
逻辑改动。前端 build + vitest 268 全绿复验通过。

### §8.16 MCP 连接发现与凭据免内联：stdio 桥接兜底 + ssh_list_connections + connectionName（2026-09-08）

**痛点**：独立 stdio MCP 会话（ZCode 等 AI 终端直拉 `dbx-plugin-ssh --mcp`）里
`dbx_connections` 注册表恒为空，带 `connectionId` 调用必报 "not registered with
this plugin session"，agent 只能手挖 DBX 应用 SQLite（connections +
connection_secrets 两表）再内联凭据，一轮"找连接"耗七八次工具调用，且密码进工具
参数。

**改动**（插件 `backend/src/` 三文件 + 宿主子仓库本地补丁一处，未 commit）：
1. **L1 桥接兜底**（mcp.rs `bridge_forward_plan` / `forward_tool_via_bridge`）：
   stdio 下连接类工具带未注册 `connectionId` 时，本地安全闸（进程只读总闸、
   destructive 确认）之后整次调用经 `app_bridge` 转发运行中 DBX 应用的
   `/call-plugin-tool`（ensure 探活 + 自动唤起应用，凭据全程不过工具参数）；
   桥不可用回落原内联路径。`bridge_fallback` 字段隔离测试；runInTerminal 路径
   不变（本就直连桥）。
2. **L2 `ssh_list_connections`**（app_bridge.rs `list_plugin_connections` +
   mcp.rs `connection_list_result`）：无参工具，出 id/name/host/port/username/
   authentication/readOnly 元数据（密码位只出 `passwordSet` 布尔，单测断言输出
   不含密钥值与 `"password":` 字段）；数据源 = 宿主桥 ∪ 本会话注册表，桥无路由/
   不可达降级 `source:"session-registry"` + note。
3. **L3 `connectionName`**（model.rs lifecycle 补 name 字段 + `registered_
   connection_by_ref` 统一查找）：注册表按名匹配、重名报错列候选；stdio 下经
   桥列表按名解析出 id 再转发；闸门层重名保守按只读 / sudo 白名单直接报错。
4. **L0 文案**：not registered 与 runInTerminal 两条报错改自愈指引（起 DBX /
   ssh_list_connections / 内联三选一）。
5. **宿主侧**（host/src-tauri/commands/mcp_bridge.rs，子仓库本地补丁）：新增
   `POST /list-plugin-connections` 路由，`PluginConnectionSummary` 封闭白名单
   结构体（仅 7 个 camelCase 元数据字段，单测断言凭据字段零泄漏），按
   plugin_id 过滤、名称排序。

**验证**：插件 cargo test 230 绿（新增 8 + 扩展 2）；scripts/smoke_mcp.py 对
release 二进制 28 工具全绿；宿主 `cargo check -p dbx` + mcp_bridge 单测 16 绿。
真机 E2E（新二进制 spawn stdio 对运行中 DBX 应用）：tools/list 含新工具；
`ssh_list_connections` 旧应用下降级出 note；**`ssh_exec` 仅 `connectionId`
零凭据内联经桥转发真机执行 aliyun-hk 返回 omni-hk**；`connectionName` 旧应用
下返回新自愈文案（宿主路由上线后此路即通）。

**文档同步**：docs/MCP.zh-CN.md（新工具行、stdio 桥接兜底节、连接寻址节、
工具计数 28）、docs/PROTOCOL.zh-CN.md（路由 + connectionName + lifecycle
name）、用户级 skill dbx-ssh-sftp-dev（连接发现四步 playbook 替换查表
workaround + 故障速查行）。

**剩余风险**：宿主路由需随 DBX.app 重构建后真机复验列表与 name→桥解析链；
sftp 池类只读工具桥宕回落文案仍为存量 "Connection is not established"（未统一
新指引）；connectionName-only 传输失败时 `drop_connection`/`ssh_close` 池
key 无法按名清理（id 调用不受影响）。

## 工作台滚动条隐藏：条体不再常驻显示（2026-09-09）

`style.css` 全局滚动条由"6px thin 常驻"改为全部隐藏（`scrollbar-width: none` +
`::-webkit-scrollbar { display: none }`），滚动仍由滚轮/触控板/键盘驱动；xterm
`.xterm-viewport` 的 `scrollbar-width: thin !important` 同步改 none。原先对
webkit 伪元素定制宽高会把滚动条从悬浮态固化为占位常驻态，与宿主观感不符。
改动仅 `ssh/frontend/src/style.css`；验证：`pnpm typecheck` 0 错、`pnpm test`
28 文件 268 用例全绿。

## 终端 MCP 模式开关 + MCP 转发不再抢焦点（2026-09-09）

用户报障两则：① stdio MCP 每次调用都立刻把 DBX 窗口顶到前台，打断其他工作；
② 命令没有出现在终端里（疑似仍走静默会话）。期望：终端上可直接开关"终端 MCP
模式"——开启后 MCP 命令经终端可见执行（审计/学习），关闭走静默隐藏通道。

**根因（两条都坐实）**：
1. 抢焦点：宿主 `mcp_bridge.rs::handle_call_plugin_tool` 对每次 `/call-plugin-tool`
   **无条件** emit `mcp-open-connection-workbench`，宿主前端监听器（useTauriEvents.ts）
   打开工作台后调 `focusCurrentWindow()`——由于 stdio 会话的连接类调用总是经 L1
   桥转发，**连纯静默调用也开标签+抢焦点**。
2. 无终端回显：路由矩阵里 `route = runInTerminal.unwrap_or(mode != Off)`，stdio
   调用不传 `runInTerminal` 且连接模式默认 `off` → 全部走隐藏通道（符合设计但
   不符合用户预期——模式只能在工作台设置弹窗深处设置，无终端就地入口）。

**改动**：
1. **宿主前端 `apps/desktop/src/composables/useTauriEvents.ts`**：
   `mcp-open-connection-workbench` 监听器删除 `focusCurrentWindow()`——标签照常
   打开/切换（命令进真实 PTY、缓冲可回看），但不再抢 OS 焦点。
2. **宿主 Rust `src-tauri/src/commands/mcp_bridge.rs`**：`/call-plugin-tool` 改为
   条件 emit——`is_terminal_routed_exec(tool)`（仅 `ssh_exec`/`ssh_exec_sudo`）且
   （显式 `runInTerminal: true` 或（缺省时探针 `ssh/agent/mode/get` 确认模式非
   `off`））才打开工作台；探针 5s 超时、任何失败（旧版插件无该方法等）回落静默
   路径，绝不因探针失败而开标签。sftp/metrics 等隐藏通道工具转发不再开标签。
3. **插件后端**：新增 RPC `ssh/agent/mode/get`（`{connectionId}` →
   `{agentTerminalMode, hasTerminalSession}`，未知连接降级 `off`/`false` 不报错，
   `ssh.rs::agent_mode_get` + `main.rs` 分发臂）；`ssh_exec`/`ssh_exec_sudo` 工具
   schema 的 `runInTerminal` 描述补"缺省时由连接级终端 MCP 模式决定"。
4. **插件前端**：工作台按钮行新增「终端 MCP 模式」快速开关（`Bot` 图标弹出层，
   三档单选就地生效，复用设置弹窗的三档文案；非 `off` 图标高亮；连接建立时经
   `ssh/settings/get` 同步初值，切换即 `ssh/settings/set`）；文案新增
   `agentTerminalQuickHint` 七语全补。

**路由语义（改后）**：终端模式开关（`agentTerminalMode`）一经在终端打开，stdio
MCP 的 `ssh_exec`/`ssh_exec_sudo`（不传 `runInTerminal`）经宿主桥转发到 embedded
sidecar 后按模式路由——`auto`/`strict` 下命令进可见终端（auto 低危直注、提权/高危
弹审批），`off` 走静默隐藏通道；`runInTerminal` 显式值仍最优先。宿主仅在确认要走
终端时才开工作台标签，且开标签不再抢焦点。

**测试**：backend cargo 231 tests（新增 `agent_mode_get_reports_mode_and_live_
session_presence`）；前端 vitest 28 文件 268 用例 + vue-tsc 0 错；宿主 vue-tsc
0 错、`cargo +1.97.1 check` 过、mcp_bridge 新增 `only_ssh_exec_tools_may_open_
the_workbench_terminal` 单测；smoke_fs agent 组新增 `agent mode get probe`
（模式/会话存在性 + ghost 连接降级）。

**文档**：PROTOCOL（RPC 表新行 + stdio 行为修正——旧"stdio 传 true 报错"已过时
实为转发；工具栏快速开关节）、MCP（开关 + 静默不打扰两节）。

**剩余风险/后续**：
- e2e `e2e_agent_app_bridge.py` 未加 mode-on 自动用例：模式置位需 embedded
  sidecar RPC（GUI 开关），脚本层无法注入；安全 hook 对该文件整体拦截写入后按
  规约还原，mode-on 全链路以手动验证替代——终端开 auto 后 stdio `ssh_exec` 不带
  `runInTerminal` 应在终端可见执行且 DBX 不抢焦点。
- 宿主两处改动（前端监听器 + 桥条件 emit）需重建 DBX.app 生效；正式版用户在
  上游吸收补丁前可临时用 worktree debug 构建验证。

## 插件数据目录 fallback 由 $TMPDIR 改为持久化路径（2026-09-09）

**根因**：DBX 宿主拉起 sidecar 时从未注入 `DBX_PLUGIN_DATA_DIR`（只注入
`DBX_PLUGIN_ID`/`DBX_PLUGIN_VERSION`/`DBX_APP_VERSION`/`DBX_HOST_API_VERSION`/
`DBX_PLUGIN_PROTOCOL_VERSION`），插件一直走
`std::env::temp_dir()/dbx-plugin-data/io.dbx.ssh` 兜底；macOS 的 `$TMPDIR`
（/var/folders/.../T/）在重启时清空，Quick Sudo 配置、快捷命令、mcp-settings、
插件 known_hosts 全部丢失（机器重启后实际发生；kafka 插件同构，已同日修复）。

**修复**：`main.rs::plugin_data_dir()` 拆出纯函数
`resolve_plugin_data_dir(lookup: impl Fn(&str) -> Option<OsString>)`（生产传
`std::env::var_os` 的闭包包装，测试传注入表，不用 `set_var` 避免并行测试竞态），
按序取第一个可用项（"可用"= 存在且 trim 后非空）：① `DBX_PLUGIN_DATA_DIR`
原样使用（宿主显式注入，未来方案 A 接入点）；② `DBX_DATA_DIR` →
`<DBX_DATA_DIR>/plugin-data/io.dbx.ssh`（便携/web 模式，`plugin-data/` 避开
安装器管理的注册树）；③ 平台标准用户数据目录下 `dbx-plugin-data/io.dbx.ssh`
（macOS `$HOME/Library/Application Support`、其他 unix
`${XDG_DATA_HOME:-$HOME/.local/share}`、Windows `%APPDATA%`；平台分支用
`cfg!` 运行时常量，同一二进制内可测）；④ 全缺才回落
`std::env::temp_dir()/dbx-plugin-data/io.dbx.ssh`，函数永不失败。
create_dir_all + canonicalize 边界行为保持不变。backend 中无第二处同语义目录
解析（其余 `temp_dir` 均为测试临时文件或 `local_transfer_roots_for` 的 sftp
本地传输白名单，语义不同不动）。

**测试（TDD）**：先写 6 个用例（DBX_PLUGIN_DATA_DIR 优先 / 空串视为未设 /
`DBX_DATA_DIR` 生效 / macOS HOME 路径 / 全缺回落 temp_dir / unix XDG 与
windows APPDATA 分支按 `#[cfg]` 留对应平台）确认失败
（`cannot find function resolve_plugin_data_dir`），实现后全绿；
`cargo test` 236 用例全过，`cargo build` 干净。本机 darwin 实际解析到
`/Users/Jinpy/Library/Application Support/dbx-plugin-data/io.dbx.ssh`。

**文档**：PROTOCOL「主机密钥」小节首次提及 `DBX_PLUGIN_DATA_DIR` 处补数据
目录解析顺序说明。

**剩余风险/后续**：已迁移历史数据在旧 `$TMPDIR` 路径且机器未重启的窗口期内
不会自动搬家（一次迁移不做，避免与宿主方案 A 冲突）；宿主未来注入
`DBX_PLUGIN_DATA_DIR`（方案 A）后 ① 自动生效，无插件侧改动。

## 终端体验两连：细竖线光标 + 点击定位光标（2026-09-09）

用户反馈两点：① 终端块状光标太粗，希望是细竖线；② 终端不能鼠标点击移动
输入位置，只能键盘方向键，希望像普通输入框一样点击定位。

**① 光标样式**：`App.vue::createTerminal` 的 xterm 配置
`cursorStyle: "block"` → `"bar"`（细竖线，保留闪烁）。纯前端一行改动，
无宿主/协议影响。

**② 点击定位光标**：终端协议里 shell 光标由远端控制，term 无法直接"落点"，
iTerm2/kitty 的通用做法是**同逻辑行内的点击换算成 N 次左右方向键**发给
readline。新增 `frontend/src/lib/terminalClickCursor.ts`（纯计算，无 xterm
依赖）：

- `cellFromMouseEvent`：像素 → 视口 cell，量 `.xterm-screen` 的 rect
  （恰为 cols×rows 格），滚动条宽度不影响列换算。
- `logicalLineSpan`：沿 `isWrapped`（标在续行上）向两侧展开光标所在逻辑行。
- `resolveClickCursorMove`：点击行不在逻辑行内 → 不动作（防止方向键把 shell
  翻进历史命令）；行内则按**字符**（宽字符 2 格记 1，readline 按字符移动）
  差值给方向键次数，上限 `CLICK_CURSOR_MAX_MOVES=1000`；备用屏
  （`buffer.type === "alternate"`）不动作。
- `clickCursorArrows`：展开为 CSI 左/右方向键序列。

`App.vue` 接线：terminalHost 挂 `mousedown`/`mouseup`（左键原地点击，位移
≤2px 且无选区才算点击，不干扰拖拽选择/双击选词）；守卫链：连接存活 →
无选区 → `modes.mouseTrackingMode === "none"`（vim/htop 等鼠标上报应用
点击语义归应用）→ normal buffer → 传输路由 `pty`（trzsz/zmodem 占流时
不代发）→ 发送。卸载时同步 removeEventListener。无新增文案（无 i18n
改动）、无新依赖、无协议/后端改动。

**验证**：新增 `terminalClickCursor.spec.ts` 13 用例（含宽字符、折行跨行、
回滚偏移、备用屏/上报守卫、像素换算），前端 `typecheck` + `vitest` 282
全过，`build` 产出 ui/index.html。真机行为建议装包后在长命令行上点击
回退/前进复核一次（macOS 拼音输入法组合窗口不受影响——点击不触发输入）。

## MCP 连接寻址升级：connectionName/endpoint 唯一匹配免 id（0.4.47 后续轮，2026-09-10）

**痛点**：§8.16 之后连接寻址仍要 agent 先查 `ssh_list_connections` 拿不透明 id
（或名称完全唯一才行），LLM 明明已从上下文知道「主机 + 用户名」却还要多一轮
id 映射；同名连接（多环境双胞胎）只能整体报歧义拒绝。

**改动**（纯后端 mcp.rs，协议面不变）：
1. **统一引用解析**（`registered_connection_by_ref` 重写）：`connectionId` 精确
   命中 > `connectionName` 精确匹配 > 完整 endpoint（host + username，port 默认
   22）唯一匹配；endpoint 字段可收窄同名候选。唯一命中即在 `call_tool` 入口
   归一化为 `connectionId`——池 key、只读门、sudo 白名单、终端路由全部一致。
2. **零猜测原则**：候选 0 个回落内联凭据 / stdio 桥接兜底（行为不变）；>1 个
   报歧义并列全部候选 id + host；`connectionId` 与其余 selector 共存且矛盾时
   直接拒绝（防错连）。
3. **stdio 桥列表同规则**（`resolve_connection_in_bridge_list` 替代 name-only
   辅助）：桥列表支持 connectionName / endpoint 解析出 id 后转发，语义与注册表
   一致。
4. **inputSchema anyOf**：全部 22 个连接类工具 schema 由 `required: host+username`
   改为 `anyOf: [connectionId | connectionName | host+username]`（业务字段
   required 保持独立），严格 MCP 客户端不再因「只传 connectionName」被客户端侧
   schema 校验拒绝。
5. **描述文案**：`connectionName` / `ssh_list_connections` 描述同步 endpoint
   复用语义。

**验证**：新增单测 4（endpoint 唯一复用、name+endpoint 消歧、selector 矛盾拒绝、
桥列表 name/endpoint 解析）+ schema anyOf 断言扩展；cargo test 239 全绿；
smoke_mcp.py 增加 connectionName/anyOf schema 断言；改动文件 mcp.rs +
docs/MCP.zh-CN.md（连接寻址节）。

**边界**：runInTerminal stdio 转发仍要求显式 `connectionId`（桥转发路径不解析
名称/endpoint，与 §8.16 一致）；仅传 host 不传 username 不做匹配（防同机多账户
误选）。

## 前端 UX 三项：一键 sudo -v、全局配置扁平化、批量目标弹层外点关闭（2026-09-10）

1. **一键 sudo -v 工具栏按钮**：新增 `sendSudoRefresh()`，复用 `sendQuickCommand`
   的 PTY 写入路径（`trackPendingInput("sudo -v\r")` + `sendTerminalBytes`，回车
   语义 `\r` 与现有代码一致），向当前交互终端立即执行 `sudo -v` 刷新 sudo 凭据
   缓存；RefreshCw 图标按钮放 ShieldCheck（toggleQuickSudo 开关）旁，title 走新
   七语 key `sudoRefresh.title`；与开关按钮互不相干。
2. **全局配置编辑扁平化**：设置弹窗内联 quick sudo 配置档管理（`profilesInlineOpen`
   section，与工具栏 KeyRound 独立 profiles 弹窗共用同一份 sudoProfiles/草稿状态）；
   「管理」链接改为展开/收起 section，不再跳第二层弹窗。底部主「保存」改串行链：
   ① 未保存的 profile 编辑（`saveProfileDraft`）→ ② 连接设置（ssh/settings/set）
   → ③ MCP 限速（`saveMcpSettings`），各步独立容错（错误分别落
   sudoProfilesError/mcpError，单步失败不阻断其余）；MCP 区独立「保存」链接移除。
   `openSettings` 每次打开重置内联态并 `cancelProfileEdit()`，防陈旧草稿被主保存
   静默提交；Esc 链在设置弹窗内按「关编辑表单 → 收 section → 关弹窗」逐层退出。
3. **批量目标弹层点空白关闭**：`onDocumentMouseDownCapture` 判 target 不在
   `.batch-targets-popover` 且不在触发按钮 `.batch-bar-targets` 内即收起——capture
   阶段先于 `.batch-bar` 的 `@mousedown.stop` 生效，条内空白/终端区/工具栏任意
   mousedown 都能关；popover 内部与触发按钮（toggle 语义）不处理，避免抖动。

验证：`pnpm typecheck` 0 错；`pnpm test` 31 文件 289 用例全绿（workbench.spec 的
七语 key 一致性覆盖新 `sudoRefresh.title`）；`pnpm build` 通过。真机流（sudo -v
回显、设置弹窗保存链、批量条外点关闭）留宿主复验。

## 终端可视模式失效修复：模式持久化 + agent 自主 runInTerminal 全量放行（0.4.49，2026-09-11）

**症状**：用户在工作台把「终端 MCP 模式」切到 auto/strict 后，MCP 命令不自动打开
终端、不写入命令，仍走静默隐藏通道。

**根因（真机取证）**：
1. **模式是纯内存态**：`agent_modes` HashMap 随 sidecar 存活，DBX.app 重启即清零
   （安装 0.4.48 当晚 app 至少重启三次，次晨模式已回 `off`）——宿主桥探针
   `ssh/agent/mode/get` 返回 off → 判定隐藏通道，一切符合设计但用户视角即"无效"。
2. **agent 自主决定的 `runInTerminal: true` 在提权命令上是死路**：`off` + elevated
   直接 Deny，错误文案引导去开 UI 开关——agent 无法操作该开关，引导不可执行。

**改动**（backend only，协议面不变、新增持久化文件）：
1. `agent_terminal.rs`：新增 `load_modes` / `save_modes`（`<data_dir>/agent-modes.json`，
   版本化 JSON，原子写，损坏按空表处理，无敏感字段不设 0600）；
   `decide(mode, risk, explicit)` 增加显式 opt-in 维度——`off` + elevated + 显式
   `runInTerminal: true` 改为 **Prompt**（工作台人工审批，超时即拒绝），隐式路由
   在 `off` 下维持 Deny 不变；Deny 文案改为指向 `runInTerminal: true`。
2. `ssh.rs`：`SshRuntime::new` 构造时加载持久化模式；`set_agent_terminal_mode`
   改为返回 Result（内存更新后写盘，`off` 移除条目防文件膨胀），`ssh/settings/set`
   传播持久化失败。
3. `mcp.rs`：`ssh_exec_terminal_tool` 增加 `explicit` 入参；`ssh_exec` /
   `ssh_exec_sudo` 的 `runInTerminal` schema 文案改为「agent 可自主决定 + 审批语义
   + 模式持久化」。

**验证**：cargo test 240 全绿（新增 `modes_round_trip_through_the_data_dir`；
decide 矩阵单测扩展 explicit 维度）。真机复验（0.4.48 现场取证）：桥转发
`/call-plugin-tool` 200 正常；`runInTerminal: true` 经桥全链路通过——工作台自动
开出新 PTY、命令写入可视终端、返回 `{mode: "terminal"}`（4.3s 含开标签+dial）；
连接级模式路由待安装 0.4.49 后由用户切换一次即可长期生效（持久化后重启不丢）。

**边界**：stdio 桥转发仍要求显式 `connectionId`（名称/endpoint 不参与转发路径）；
`off` + 提权 + 隐式调用不弹审批，避免静默路径升级为打扰路径。

## 面板简化：工具栏 sudo 按钮二合一 + icon 语义修正（2026-09-11）

1. **Quick sudo 不再从工作台开关**：其启用态由连接设置决定（设置弹窗
   `settingsQuickSudo`，默认开启），工作台此前并排的「ShieldCheck 开关 +
   RefreshCw 一键 sudo -v」合并为单个 ShieldCheck 动作按钮——点击即
   `sendSudoRefresh()` 向当前 PTY 写入 `sudo -v`；终端右键菜单原
   「Quick Sudo · 开/关」项同步改为「刷新 sudo 凭据（sudo -v）」动作。
2. **脚本层清理**：删除 `quickSudo`/`quickSudoSubmitting` ref、
   `toggleQuickSudo()`、`refreshQuickSudoSetting()`、`quickSudoTitle` 及
   afterSessionConnected/closeSession 中的状态同步调用（`ssh/settings/get|set`
   仍由设置弹窗使用）；i18n `messages` 中 7 语废弃键
   `quickSudo.label/hint/on/off` 全部移除（`supplemental` 顶层
   `quickSudo`/`quickSudoHint` 仍服务命令对话框 sudo 开关，`sudoRefresh.title`
   七语保留）。
3. **icon 语义 review**：传输面板按钮原用 `ListChecks` 与「批量发送」同栏撞图标，
   改为 `ArrowUpDown`（⇅ 双向传输）；其余工具栏图标过一遍——
   ArrowLeftRight（面板互换）/FolderOpen+PanelRightClose（SFTP 面板）/PlugZap（重连）/
   KeyRound（sudo 配置档）/SquareTerminal（命令对话框）/Zap（快捷命令）/Bot（AI 终端）/
   Gauge（指标）/Info/Settings/Columns3 语义均成立，RefreshCw 删除 sudo 项后仅剩
   刷新语义（目录刷新两处），无其他改动。

验证：`pnpm typecheck` 0 错；`pnpm test` 31 文件 289 用例全绿。纯前端改动、
协议面不变；工具栏/右键菜单真机流留宿主复验。

## 审批记忆 + 执行审计 + 告警分诊（2026-09-11，0.4.51 → 0.4.52）

openocta 对比评审后的两个学习点落地（实施计划
`docs/IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT.zh-CN.md`；纯插件侧，无宿主改动、无新依赖）。
并发四 agent 实施（WP-A/B/C 后端新模块 + WP-D 前端 lib/七语，热点文件接线主会话统一）：

1. **审批记忆（4a）**：审批弹窗「记住此命令」（`ssh/agent/resolve` 增可选 `remember`，
   向后兼容）→ 批准文本入连接级免审批清单（新模块 `agent_approvals.rs`，
   `agent-approved-commands.json` 照 agent-modes.json 存储模式）；`decide_with_memory`
   把 Prompt 降为 Run（Deny 不覆盖，D1）；匹配完整复用 sudo_allowlist token 语义
   （D3）；破坏性命令拒绝入库 + 命中重检无效（D2 双重锁）。`ssh/settings/get|set`
   增 `rememberedCommands`（全量替换、行 ≤500、≤50 行、破坏性行拒绝带行号），
   设置弹窗「AI 终端」区块可查看/删除/手工泛化通配。
2. **执行审计（4b）**：新模块 `audit_log.rs`（JSONL append-only，5 MiB 轮转 `.1`，
   open-append 单行写支持 embedded/stdio 双进程共享数据目录）；`call_tool` 每次调用
   一条（gate 枚举 = 既有门序各拒绝分支归纳 + 执行结果/exitCode/耗时，宿主桥转发由
   执行方记账不双计）+ ssh.rs 审批生命周期一条（approved/denied/timeout/remembered）；
   `ssh/audit/list {limit?, beforeTs?}` 只读回放（`entries` + `truncated`）。
3. **告警分诊（5）**：新模块 `alert_triage.rs`（纯函数）：异构告警 JSON/纯文本 →
   标准化（openocta /hooks/alert 兼容语义：解析失败整包当 message）+ 双语关键词分类
   （cpu/memory/disk/inode/network/oom/service/generic，同分固定序 Oom>Memory）+ 只读
   诊断命令清单（14 个稳定 purposeKey）。硬约束 D6 单测钉死：每条 playbook 命令
   `assess_command == ReadOnly`（初稿 `top -b -n 1` 不在白名单被剔除）；`svc` 提取带
   敏感路径守卫。`ssh/alert/triage` RPC（无需连接）+ MCP 工具 `ssh_alert_triage`
   （28→29，非写工具）；工作台工具栏「告警排查」（Siren）弹窗：粘贴 → 分析 → 逐条
   发送到终端 / 全部复制。

**契约**：PROTOCOL 新增「审批记忆」「执行审计」「告警分诊」三节 + RPC 表 3 行 +
settings/agent-resolve 字段；MCP.zh-CN.md 工具一览 29 + 「告警 → 排查（组合用法）」
新节 + 审批记忆要点；FEATURE_PARITY 新增 openocta 对标节（5 行）。七语 41 key ×7
（`approval.remember`、`settingsRemembered.*`、`alertTriage.*`）。

**验证**：`cargo test` **286 passed / 0 failed / 0 warning**（agent_approvals 8 +
decide_with_memory 矩阵 + audit_log 10 + alert_triage 26 + remember 持久化 2，基线
240）；`pnpm typecheck` 0 错；`pnpm test` **307/307**（agentTerminal +10、
alertTriage +9，七语 key/占位符对齐保持）；`smoke_mcp.py` all green（29 工具 +
triage 离线回环）；`smoke_fs_test.py` **PASS 52 / SKIP 0 / FAIL 0**（真机容器，新增
4 用例：remember 后同命令零弹窗直跑、设置清单管理 + 破坏性行拒绝、triage 正反例、
audit 台账 gate/approval 全字段与 remembered 审批线）。

**边界与遗留**：① token 精确匹配对参数漂移的命中率低，属保守取舍，泛化靠设置面板
手工编辑；② 审计不含工作台人工操作（既定信任模型），Web 查看器未做（RPC 已备）；
③ 分诊分类为关键词启发式、generic 兜底；④ 本轮未出包（安装生效需重新打包发版）；
⑤ 宿主侧 `tools/list` 计数类断言（若有）需同步 28→29。

**UI 浏览器验证（同日）**：mockDbxHost 补 `ssh/alert/triage` fixture 与
settings `agentTerminalMode`/`rememberedCommands` 镜像（规约第 7 条）。聚焦走查
（playwright-core 仓外 /tmp，项目零新依赖）**12/12 全绿**：工具栏 Siren 按钮 →
弹窗粘贴 CPU 告警 JSON → Analyze → category="CPU"/severity 徽标 Critical/3 条
建议行/发送按钮随会话启用；纯文本回退分类 Disk；弹窗关闭；设置弹窗「已记住命令」
区块与空态提示渲染；零 page error。截图
`docs/screenshots-ui-mock/triage-round92-{alert-dialog,settings-remembered}.png`。
**既有 `scripts/smoke_ui_mock.mjs` 失效为先在问题**：其批量发送段断言
`.batch-modal`/`.batch-quick-pick` 旧弹窗 UI，而批量交互已于 2026-09-08 改版为
终端底部常驻命令条（见上 §批量发送轮），脚本未跟随改版——非本轮回归，待该脚本
所有权方按新 UI 重写走查段。

## 凭据静态加密 + 传输历史落盘 + SFTP 书签（2026-09-11，0.4.52）

sshbool 对比评审后的学习点落地（实施计划
`docs/IMPL_PLAN_SSH_VAULT_TRANSFER_HISTORY.zh-CN.md`；纯插件侧，无宿主改动；
新依赖 4 个：`aes-gcm`/`keyring`/`zeroize`/`rand`）。并发三 agent 实施
（WP-A vault / WP-B 历史+书签后端 / WP-C 前端，文件所有权互不重叠；`main.rs`
mod 声明由主会话预置消除冲突）：

1. **凭据静态加密（vault）**：新模块 `vault.rs`（`KeyProvider` trait：
   `KeychainProvider` keyring 服务 `io.dbx.ssh` 账户 `vault-dek-v1` +
   `KeyfileProvider` `<data_dir>/vault.key` 0600 回落；AES-256-GCM 字段级信封，
   AAD 绑定 `字段|档案id`，DEK `Zeroizing`）；`quick-sudo-profiles.json` 升
   `version:2` + `crypto` 头，`sudoPassword`/`totpSecret` 改
   `sudoPasswordEnc`/`totpSecretEnc`（空值不加密），元数据明文；v1 加载后
   best-effort 迁移重写；解密失败按空降级（元数据保留）。`load_store`/`save_store`
   签名不变，新增 `*_with` 注入变体（单测全走 Keyfile+tempdir，不触真实
   keychain）；`profile_view`/`reveal`/MCP 布尔面不变。
2. **传输历史落盘**：新模块 `transfer_history.rs`（`transfer-history.json`
   环形 200 条、tmp+rename 0600、仅状态跃迁写盘）；ssh.rs 跃迁点挂钩
   （upload/download start 与统一收口点 `record_transfer`，补齐两个此前不落账的
   incomplete 错误路径，session 关闭中止任务写 failed）；遗留 `running` 加载时
   **呈现层**标 failed 不回写（保跨进程 last-writer-wins 正确性）；新 RPC
   `sftp/transfer/history {sessionId?, limit?}` 持久化+live 合并（live 覆盖并
   继承 startedAt/connectionId）。
3. **SFTP 书签**：新模块 `sftp_bookmarks.rs`（镜像 quick_commands：全局 20 条、
   label 1–64 唯一大小写不敏感、path 非空 ≤1024 不验存在性）；新 RPC
   `sftp/bookmarks/list|save|delete`；前端 `lib/sftpBookmarks.ts`（校验/排序纯
   函数 + RPC 封装，20 用例）+ 路径栏星标收藏弹层 + 历史弹层书签区 + 传输面板
   历史区（无活动任务时展示、failed 显 error、活动清零自动刷新）。

**契约**：PROTOCOL 新增 `sftp/transfer/history`、`sftp/bookmarks/*` 三方法
（表 2 行 + 明细 2 段）+ sudo/profiles 节「凭据静态加密」说明；FEATURE_PARITY
新增 sshbool 对标节（8 行）；三个新方法均不进 MCP 工具面（29 工具不变）。七语
`i18n.ts` 新增 `sftpBookmark.*`（15 键）+ `transfersHistory.*`（3 键）。

**验证**：后端 `cargo test` 全量 315 passed / 0 failed（/tmp 快照隔离验证：
同工作区另一批次（审批记忆/审计/告警）收尾过程中 mcp_safety 测试短暂处于半成品
态，快照仅桩替其 `mod tests` 后全量运行；含 vault 9 + sudo_profiles 19（新增 6）
+ transfer_history 5 + sftp_bookmarks 8 + live 合并 1）；ssh.rs 既有
`profile_options_*` 测试改走 `save_store_with`+Keyfile（防测试触真实 keychain）。
`pnpm typecheck` 0 错；`pnpm test` 37 文件 363/363。一次性探针（/tmp，17/17）：
书签 CRUD+校验拒绝矩阵+排序、history 空态/limit、**真机 vault 链路**——
`sudo/profiles/save` 落盘文件含 v2 头且无明文密钥、keychain 实建
`io.dbx.ssh/vault-dek-v1` 条目、list 布尔面、`reveal` 回读原值；
`smoke_mcp.py` all green（29 工具，sudo profiles roundtrip 复验）。

**边界与遗留**：① keyring Linux 后端依赖 Secret Service（dbus），web Docker 等
无 keychain 环境自动落 keyfile 档（弱保证：防拷贝/备份外泄，文档已声明）；
② keychain 条目被删 → 密钥字段按空处理（可重填）；③ 传输历史跨进程
last-writer-wins、逐块进度不落盘、断点续传不在范围；④ 书签全局共享不按连接
分组；⑤ 无容器 smokes（smoke_test/fs/batch3）未在收口环境运行（docker 测试容器
未起），新方法已由探针覆盖注册与语义，容器轮次回归时自然并入；⑥ 本轮未出包
（安装生效需重新打包发版）；⑦ 前端 label/path 按 UTF-16 计数与后端 char 计数在
多字节边界可能差 1–2 字符（前端 maxlength 已限）。

## Netcatty 对标批次（部分落地 + mcp.rs 事故通报）（2026-09-11 晚）

依据 `docs/IMPL_PLAN_NETCATTY_PARITY.zh-CN.md`（对标 binaricat/Netcatty，用户选定
①MCP 权限档+作用域 ②multi_exec/terminal_input ③关键词高亮 ④审计 ⑤metrics 增强），
并发双 agent 实施（A 后端 / B 前端）。**与同日并行批次「审批记忆+执行审计+
告警分诊」「凭据静态加密+传输历史+SFTP 书签」存在范围交叠，收口前需主会话协调。**

### ⚠️ mcp.rs 事故通报（两批次都受影响）

后端 agent A 在修复插入点时批量替换脚本锚定错误，误删 mcp.rs 约 2800 行；外部
恢复渠道（VS Code 本地历史/APFS 快照/git dangling blob）无快照，已用 git HEAD
恢复文件骨架。**净损失两笔**：

1. **事故前工作区的未提交 mcp.rs 改动**（0.4.49 轮的 `explicit` 传参线程化 +
   runInTerminal schema 文案）——主会话已按 PROGRESS 0.4.49 记录**手工恢复**
   （`ssh_exec_terminal_tool` 六参签名带 `explicit`，`decide(mode, risk, explicit)`，
   schema 描述补 agent 自主决定/审批语义/持久化文案），cargo 327 全绿复验通过。
   **后续任何 mcp.rs 重写必须保留该行为**。
2. **并行批次 16:15 对 mcp.rs 的改动**（内容不明，推测为 `decide_with_memory` +
   remember 参数在 MCP 终端路由的接线）——无法恢复。当前状态：`agent_approvals.rs`
   与 `agent_terminal.rs::decide_with_memory` 在树上、main.rs `ssh/agent/resolve`
   已带 `remember` 透传，但 **mcp.rs 终端路由仍走裸 `decide`，审批记忆在 MCP 面
   未生效**。请并行批次会话对照其 PROGRESS 记录重放该接线（重放时保留上述
   explicit 行为）。事故残骸备份：`/tmp/mcp.rs.damaged.*.bak`、
   `/tmp/mcp.rs.residue.final.bak`。

### 本批已落地（工作树，未提交，未出包）

- **A3 关键词高亮（后端）**：`highlight_rules.rs` 新模块（照 quick_commands 模式，
  上限 30、regex 合法性由前端校验）+ `ssh/highlightRules/list|save|delete` 三臂；
- **A5 metrics 发行版识别**：`parse_os_release` + METRICS_SCRIPT `--os--` 哨兵段，
  payload 可选 `osId`/`osPretty`（缺文件整体省略）；
- **B1–B4（前端全量）**：`lib/keywordHighlight.ts`（compileRules/matchesInLine/
  sanitize，17 spec）+ 工具栏管理弹层 + xterm decoration 视口扫描引擎（rAF 节流、
  上限 400、localStorage 总开关 `ssh-keyword-highlight`；xterm 5.5 DOM renderer
  不吃 decoration backgroundColor，改为 onRender 自绘着色）；`lib/metricsSparkline.ts`
  （环形 60 点 SVG，rx/tx 双曲线）+ `lib/distroBadge.ts`（14 发行版 monogram，
  纯 CSS 零图片资产）；设置弹窗 MCP 区权限档/作用域控件（B3，后端 A1 未落地前
  对真机 set 会报错、经 mcpError 容错）；审计查看区（B4）；
- **B4 双形状兼容（主会话补）**：发现并行批次 `ssh/audit/list` 契约与本批 §1.1
  不同（`tsMs` 毫秒/`tool` 代 kind/`connectionId`/无 command/limit 1–500 缺省 100/
  文件序/无 clear），`lib/auditLog.ts` 改为双形状容忍（ts 归一为秒、kind←tool、
  newest-first 客户端排序、kind 过滤客户端做、clear 对无该方法后端静默降级）；
  mockDbxHost fixture 改镜像真实形状（末条保留旧形状样例）。

### 本批未落地（材料在案，待协调后收口）

- **A1（MCP 权限档 confirm + 连接作用域）/ A2（ssh_multi_exec + ssh_terminal_input）**：
  曾全部实现并 326 测试全绿，随事故回退。全部实现文本已转存
  `~/.dbx-mcp-recovery/`（A1/A2 两个 .md + 被删文件 :1-3219 原文四段，合计约
  220KB，仓库外持久保存；/tmp/mcp-recovery 为同内容副本；已知缺口——part3 的
  StoredConnection 字面量缺六字段勘误在 part4 头部、tool_definitions 描述为
  要点压缩，重建时以 HEAD 为底仅追加 A2 新工具），**重放前需
  与并行批次协调 mcp.rs 的 edit 权**（其审批记忆接线与本批 confirm 门改同一
  路由区域）；`mcp_safety.rs` 的 `normalize_terminal_input`/
  `is_control_only_input`/`assess_terminal_input` 三函数仍在树上可直接复用。
- **A4（审计）已撤销**：与并行批次「执行审计」（`audit_log.rs`，MCP exec 维度、
  gate/approval 轨迹）完全重叠，以并行批次实现为准；本批计划 §1.1 审计契约作废，
  前端 B4 已按上节适配。`ssh/audit/clear` 后端无此方法，前端静默降级，待并行
  批次决定是否补充。

### 验证基线（本批当前树）

cargo test **327 passed / 0 failed**（含并行批次用例）；`vue-tsc` 0 错；
vitest **37 文件 364 用例全绿**；`pnpm build` 过（ui/index.html 产出）。

## vault 密钥托管优化：默认档反转为 keyfile（2026-09-11，用户反馈）

sshbool 批次上线当天用户真机反馈"每次启动都要反复输入几次密码"。根因：macOS
keychain 对访问方二进制做 ACL 校验——插件每次更新二进制变化即重弹授权对话框，
而旧实现首写探测（`resolve_provider(None)` 读 keychain 探测档位）+ 每次读写重新
解析 DEK 放大了弹窗频率；工作台与 stdio `--mcp` 双进程各弹一轮。修正（实施计划
IMPL_PLAN_SSH_VAULT_TRANSFER_HISTORY 决策修订 D2a，纯后端 `vault.rs`/
`sudo_profiles.rs`，协议面不变）：

1. `resolve_provider(None)` **不再探测 keychain**：默认档直接为
   `<data_dir>/vault.key`（0600）；keychain 仅在 env
   `DBX_SSH_VAULT_STORAGE=keychain` 显式选入或读取遗留 keychain 档信封时使用。
2. keychain DEK 解析**进程级缓存**（`OnceLock<Mutex<…>>`，成功与失败均缓存）：
   每进程至多一次授权弹窗，被拒后进程内不重试。
3. **自动迁移**：`load_from_value` 检测 keychain 档文件且密文成功解密时重封为
   keyfile 档、更新 `crypto.storage` 头，并 best-effort 删除 keychain 条目
   （`vault::delete_keychain_dek`）；解密失败（被拒/丢钥）时保持原文件不动——
   `recovered_secret` 门禁保证绝不以空密文覆盖真实档案。
4. 测试 +2（keychain 档恢复加载后迁移为 keyfile 且保持静态加密；不可恢复的
   keychain 档文件原样保留、不铸造 keyfile）；`resolve_provider` 既有测试改为
   断言默认 keyfile。

验证：`cargo test` 全量 **330 passed / 0 failed**（共享树含并行批次用例整体
全绿）。真机两个数据目录（`dbx-plugin-data` 与 `com.dbx.app/plugin-data`）均为
keychain 档 v2 文件——装上本修订后：首次加载弹一次授权，点允许即自动迁移到
keyfile 档并清理 keychain 条目，此后启动/重连/插件更新零弹窗；点拒绝则该进程
内 sudo 档案密钥视为空、下次启动再给一次机会。本轮未出包（生效需重新打包发版）。
未跑 smoke/打包；版本 0.4.52 已被并行批次占用，本批收口时 bump **0.4.53**。
smoke 扩展（highlightRules CRUD + metrics osId + multi_exec/terminal_input
schema）、PROTOCOL/MCP/FEATURE_PARITY 文档同步、PROGRESS 收尾报告随收口轮补。

## 新增功能 UI 打磨轮（2026-09-11 晚）

> 背景：UI_SCAN_FINDINGS 六轮收敛（09-06）之后落地的功能（关键词高亮、告警分诊、
> 审批记忆、审计查看区）未经过 UI 走查；本轮按用户反馈 + mock.html 浏览器实测
> （playwright-core + Chrome headless，截图复验）做一轮针对性打磨。

1. **关键词高亮弹层零外间距（用户反馈）**：`.popover` 基类无 padding，其他弹层
   （transfer/columns/batch-targets/quick-commands/connection-info/agent-mode 等）
   均各自补了 padding，唯独 `.highlight-rules-popover` 漏配，内容贴边。修复：
   `style.css` 补 `padding: 8px` + `h3` 对齐兄弟弹层（`margin: 0; font-size: 12px`，
   原先吃 UA 默认 1em 上下边距）。浏览器实测：内容四边 9px（8px padding +
   1px border），与 quick-commands 等弹层观感一致。
2. **告警排查弹窗补功能说明（用户反馈「是什么功能」引出的可发现性问题）**：
   弹窗原先只有 title + placeholder，无一句说明。补 `alertTriage.hint` 七语文案
   （粘贴告警 → 自动归类 → 只读诊断清单 → 一键发送语义），模板在 header 下加
   `.alert-triage-hint` 段落。定位本身不变（见 IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT
   §#5：刻意不做 LLM，分诊 = 结构化 + 分类 + 白名单级命令建议）。
3. **设置弹窗「已记住命令」补区块标题**：`settingsRemembered.section` 七语键早已
   定义但模板从未使用，导致 label/empty/hint 三行文字悬空与前节提示粘连。在
   `.settings-remembered` 首行补 `<h4 class="settings-section-title">`（带分隔线，
   与 Terminal interaction 等区块一致）。

实测范围：高亮弹层、告警排查弹窗（含分析结果区）、连接信息、设置弹窗（顶部 +
底部审计区）、指标浮层；其余新增面（agent 审批弹窗、终端 MCP 模式弹出层）源码
复核样式在位（scoped padding/间距均有定义），未逐一浏览器走查。
验证：`vue-tsc` 0 错；vitest **37 文件 364 用例全绿**（七语 key/占位符对齐断言
自动覆盖新键）。未跑 smoke/打包（纯前端 CSS/模板/i18n，无协议改动）。

## 关键词高亮默认规则播种 + 弹层 Esc 链补漏（2026-09-11 晚，续）

> 用户需求「关键词高亮加一些必须要用的规则」；顺带修复浏览器实测中发现的两个
> 收敛后新增弹层 Esc 缺口。

1. **首启默认规则播种（后端）**：新装数据目录下第一次 `ssh/highlightRules/list`
   （或 save）时，`highlight_rules::load_or_seed_store` 以固定 id 写入 6 条
   默认规则并持久化——`ERROR`/`FATAL` #ef4444、`FAIL`/`denied` #f59e0b、
   `WARN` #facc15、`SUCCESS` #22c55e，全部字面匹配、不分大小写、默认启用。
   语义边界：仅存储**文件不存在**时播种；坏文件降级空库与用户删空后均**不重播**
   （文件存在即视为用户已有库）；seed 写失败时本次仍返回默认、下次重试。
   新增单测 `first_load_seeds_defaults_and_persists_them`（播种/持久化/清空
   不重播/确定性 id）。契约同步：IMPL_PLAN_NETCATTY §1.1 list 行 + 存储表注。
2. **mock 镜像**：mockDbxHost 高亮夹具从单条 ERROR 换成同一组 6 条默认规则
   （固定 id 对齐后端）；回放终端追加 3 行 deploy.log 演示输出（WARN/ERROR
   Permission denied/SUCCESS），mock 页挂载即可见默认规则着色。
3. **弹层 Esc 链补漏（浏览器实测发现）**：`onDocumentKeydown` 工具栏弹出层
   Esc 分支的**条件**漏了 `highlightMenuOpen`（只在执行体，单独打开时 Esc
   无效），`agentModeOpen`（终端 MCP 模式弹出层）条件与执行体均缺失——两者
   均为 UI 扫描六轮收敛（09-06）之后新增的弹层，属 R5-P2-1 同类问题。已把
   两个状态补进条件与执行体。浏览器复验：高亮弹层、agent-mode 弹层单独
   打开后 Esc 均即时关闭，无残留。

验证：cargo test **328 passed**（+1）；`vue-tsc` 0 错；vitest **364/364**；
浏览器（mock.html）截图复验默认规则列表（6 / 30 rules）与终端四色着色。
未跑 smoke/打包（后端为纯函数级改动，协议形状无变化）。

### 默认规则集扩充为 22 条（同日续，用户需求「设计好用有效的规则」）

按严重度分色的实战规则集替换首批 6 条（`DEFAULT_RULE_SPECS` 22 条，列表
预算 22/30，仍留 8 槽给用户自建）：

- **红（硬错误）**：ERROR、FATAL、Permission denied（权限不足）、No such
  file or directory（文件不存在）、command not found、Connection refused、
  No space left on device（磁盘满）、Failed to（systemd 操作失败）、cannot、
  Exception、Traceback (most recent call last)（Python 栈头）；
- **琥珀（命令失败/受限）**：FAIL、denied、timed out；
- **黄（警告）**：WARN、deprecated；
- **绿（成功/健康）**：SUCCESS、active (running)（systemd 健康）、done、✓、
  PASSED（唯一区分大小写，避免散文 "passed"/"bypassed" 误报）；
- **蓝（可提取信息）**：IPv4 正则 `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`
  （唯一 regex 规则）。

分层设计：匹配按 pattern 长度降序先到先得——长短语精确红优先于同线词干
（"Permission denied" 整段红时内部 "denied" 不再叠琥珀；"Access denied"
孤立出现仍琥珀）。前端为 22 条列表补滚动容器 `.highlight-rule-list`
（max-height 320/视口自适应，标题与编辑器固定可见）。mock 镜像同步 22 条 +
回放演示扩充（No such file/command not found/timed out/IPv4）。
验证：cargo test 328；vitest 364；`vue-tsc` 0 错；浏览器截图复验 22/30
列表滚动 + 终端五色着色 + 分层优先级。

#### 高亮遮字修复（同日，用户反馈「背景色遮挡文本内容」）

xterm decoration 元素绘制在文字层**上方**，`onRender` 原来把规则色设为
**不透明** `backgroundColor`——命中区域变成实色块，字形整个被盖住（用户截图
证实 22 条默认规则全中）。修复：新增纯函数 `keywordHighlight.ts::
highlightFillStyle(color)`（`#rrggbb` → `rgba(r,g,b,0.35)`，非法形状回退默认
色，2 条单测），`onRender` 改设半透明填充，原文字透出、色相保留（编辑器式
高亮）。浏览器复验：五色底透字全部可读（dark 主题），分层优先级不受影响。
`vue-tsc` 0 错、vitest **366/366**（+2）。

## review + 持续优化第 1 轮（2026-09-11，review+optimize agent）

> UI 扫描六轮收敛（09-06）之后的新增面（告警排查、审批记忆、高亮、agent mode、
> 传输历史、书签）未经专项复审；本轮对工作区未提交改动做 review + 小修。
> 详情见 `.goal-state/report-ssh-round1.md`。

发现：P0=0、P1=1、P2=3（全部当场修复，均在前端 `App.vue`）+ 后端新增面零缺陷。
后端 review（agent_approvals/alert_triage/audit_log/highlight_rules/
sftp_bookmarks/transfer_history/vault + ssh/mcp/mcp_safety/metrics/main 的 diff）
未发现需修问题，纯函数单测覆盖与敏感路径（8KiB 截断、os-release 容错、vault
恢复门禁）实现严谨。

1. **告警排查弹窗接入焦点与 Esc 链（P1-1）**：`alertTriageOpen` 此前不在
   `modalOpenStates` 也不在 Esc 对话框分支——打开不聚焦、Esc 关不掉，是
   R5/R6（highlight/agentMode Esc 缺口）同族的"收敛后新增弹层漏接入"第三次复发。
   修复：入 `modalOpenStates`（settingsOpen 之后）+ Esc 独立分支 + textarea 补
   `autofocus` 定位标记（modalFocus 以该属性选首聚焦控件）。
2. **审批「记住」放开风险档限制（P2-1）**：勾选框原 `v-if="risk === 'elevated'"`，
   但 `decide_with_memory` 对低危 Prompt 同样生效且设置面板 rememberedCommands
   无手动添加输入——strict 模式低危命令永远无法免审，与 IMPL_PLAN
   （审批审计告警）"strict/auto approve+remember 二次零弹窗"预期不符。去掉
   v-if；后端 D2 灾难门兜底不动。
3. **高亮弹层互斥补漏（P2-2）**：`toggleHighlightMenu` 漏关 `agentModeOpen`
   （agentMode 不在 mousedown-capture 收起清单，正向点击即两层叠开），补一行。
4. **连接信息发行版徽标数据源补拉（P2-3）**：徽标取 `ssh/metrics` 的
   `osId/osPretty`，但快照只在指标浮层轮询时拉取——从未开过指标的会话永远
   看不到徽标。`toggleConnectionInfo` 打开时无快照则 `refreshMetrics()` 一次
   （自带未连接守卫）。

验证：`pnpm typecheck` 0 错；`pnpm test` **366/366 全绿**（与改动前基线一致，
无新增文案键）。smoke SKIP（纯前端交互改动，无协议面变化）。浏览器级复核点
（弹窗焦点/Esc、低危 remember 勾选、弹层不叠开、徽标显示）留人工，见报告。
遗留：toggleBookmarkSave 互斥清单、互斥/Esc 接入的 spec 防线、告警排查 mock
夹具等 5 项，见 `.goal-state/report-ssh-round1.md` 遗留节。

## review + 持续优化第 2 轮（2026-09-11，review+optimize agent）

> 以上一轮遗留项为主线（互斥收口、互斥/Esc 接入 spec 防线、告警排查 mock
> 夹具、onLocaleChange 夹具）。详情见 `.goal-state/report-ssh-round2.md`。

发现：P0=0、P1=0、P2=2（均当场修复，纯前端）+ 现状澄清 ×2。

1. **工具栏弹出层互斥收敛为 closeToolbarPopovers() 单助手（P2-1）**：round1
   P2-2 只修了高亮→agentMode 单方向；实际上 agentMode 弹层无 mousedown
   capture 兜底，点快速命令/连接信息/星标/列配置/传输/路径历史触发钮均会
   叠开，closeMenus（document click 全局收起）也漏 agentModeOpen（agent-mode
   弹层点外不收，仅 Esc 可关）。五处 toggle 手抄清单 + 三处模板内联表达式
   （columns/transfer/pathHistory 收敛为具名 toggle）+ closeMenus +
   openTransferPanel 全部改走单助手；metrics 浮层与批量保存态语义不同不入族
   （Esc 链单独收口）。
2. **mock ssh/alert/triage 对齐后端（P2-2）**：该夹具已由并行批次补进工作区，
   本轮修两处语义偏差——JSON 告警 message 缺失应回退整段 payload（openocta
   兼容，与有无 title 无关）、source 应像后端一样小写化；并补单测锁定契约
   形状（JSON/纯文本双路径 + disk playbook 逐字清单）。
3. **弹层互斥回归防线（round1 遗留 2）**：workbench.spec.ts 新增 4 用例，
   从 App.vue 源码反向提取模板全部 modal/popover 守卫 ref，断言接入
   modalOpenStates / Esc 链 / closeToolbarPopovers 之一 + modal 全进焦点表 +
   8 个 toggle 必须走助手；带非空锚点防空转。变异校验：模拟 P1-1 复发
   （alertTriageOpen 出焦点表）防线准确报出。
4. **onLocaleChange 夹具补齐（round1 遗留 5，可选顺手项）**：mock `locale`
   改 getter + `?locale=` 定初值 + 新增 onLocaleChange（订阅即回调，与
   onAppearanceChange/onContextChange 同构）+ `__dbxMockSetLocale` 调试入口
   （镜像宿主桥 updateLocale 语义）；mockDbxHost.spec 补 i18n 切换链用例。

验证：`pnpm typecheck` 0 错；`pnpm test` **37 文件 372/372 全绿**（基线 366
+ 新增 6）。后端零改动未跑 cargo test。smoke SKIP（纯前端交互/夹具，无协议面
变化）。浏览器级复核（弹窗焦点/Esc、弹层两两不叠开、__dbxMockSetLocale 切语）
与 0.4.53 smoke/打包留人工，见报告遗留节。R5-P2-2 维持豁免。

## review + 持续优化第 4 轮（2026-09-12，review+optimize agent，换视角 fresh review）

> 扫五个从未系统查过的面：①空态/加载态/错误态一致性 ②表单与输入校验
> ③键盘覆盖与冲突 ④长列表性能 ⑤mock↔真实桥契约抽查。不重复 round1-2
> 已修项。详情见 `.goal-state/report-ssh-round4.md`。

发现：P0=0、P1=0、P2=3（均当场修复，纯前端）+ 无缺陷结论 ×3（面 1/2/3
除审计外均达标）+ 风险记录 ×1（面 4）。

1. **审计日志加载失败静默空态（P2-1）**：`loadAuditEntries` 失败 catch 清空
   列表且无标记，与"确无记录"不可区分；同弹窗其余五 section 均为
   "错误+刷新"风格。修复：`auditLoadFailed` 失败态 + i18n 提示 + 重试按钮
   （新键 `auditLog.loadFailed`，七语同步）；"旧 sidecar 无方法不打断设置
   弹窗"的原意不变。
2. **mock 缺 sftp/transfer/history（P2-2）**：落 catch-all 致传输历史面板在
   mock.html 恒空态，loadFailed+重试与历史渲染无法走查。补 handler（新→旧
   fixture、failed 带 error、limit 收敛）+ `?err=transferHistory` 失败注入。
3. **mock 缺 sftp/copy|move|write 与 sudo 写族（P2-3）**：catch-all 静默
   success 但内存树不变——粘贴流"提示成功但无变化"、编辑器保存后重开仍是
   旧内容，夹具闭环断裂。按协议契约补齐（from 数组逐项、overwrite 撞名按项
   失败、move 摘源、write 内容驻留供 read 回读 + size 同步），并把
   sudo/mkdir|remove|removeAll|chmod|readFile|writeFile 别名到对应 sftp
   handler，sudo 模式在夹具内可用。
4. **面 4 风险记录（不实施）**：文件列表全量渲染无虚拟滚动，数千条目目录有
   卡顿风险（审计封顶 200、历史 50 无风险）；真机确认卡顿再立项。
5. **面 2/3 无发现**：表单校验（高亮 regex 试编译、限频计数+禁用、书签
   前置校验、MCP 行内提示）无静默失败；全局键仅 Tab（弹层在场才拦截）与
   Escape（分层链），终端聚焦态 Cmd+F/0/滚轮/V/Shift+V/Shift+C 均
   preventDefault，无宿主/浏览器冲突组合键。

验证：`pnpm typecheck` 0 错；`pnpm test` **37 文件 375/375 全绿**（基线 372
+ 新增 3 条 mock 契约锁定用例：transfer/history 契约、copy/move 树变更、
write→read 闭环）。后端零改动未跑 cargo test。smoke SKIP（前端失败态 +
可视化夹具，无协议面变化）。mock.html 四点浏览器走查与 0.4.53 smoke/打包
留人工，见报告遗留节。


### 第 4 轮独立复核补充（2026-09-12，本次执行）

启动时上节 round4 改动及报告已存在，按 375 用例起始基线保留；原报告快照见
`.goal-state/ssh-round4-baseline/.goal-state/report-ssh-round4.md`。本次用失败
注入与浏览器事件重新验证五个面，修订此前“即时校验 / 已消费快捷键 / 已收敛”
结论，详细矩阵与证据见 `.goal-state/report-ssh-round4.md`。

新增修复四项：P1 设置读取未成功时阻止默认 / 陈旧草稿保存，补错误与重试；
P2 告警分诊补就地失败 / 加载反馈并清理旧结果；P2 xterm 已处理快捷键显式
preventDefault + stopPropagation；P2 mock fileTransfer.write 按解码字节确认。
两条新提示七语齐全。无后端、shared/、host/、其他插件、版本或依赖改动。

验证：typecheck 通过；37 文件 **376/376**；新增浏览器 smoke 三场景通过
（外部 Vite 与独立启动模式，pageerror=0），Ctrl+C / Tab 仍到 PTY；连接表单
只读检查 90 组通过；diff --check 通过。首次 smoke 及两次观察探针的选择器
错误已修正，失败经过如实写入报告。未跑 cargo / sidecar smoke / 打包全套。

收敛：**否**。剩三类 P2：书签 / 高亮 / 快速命令静默加载失败、高亮校验反馈
滞后、mock 设置写入后读取仍返回默认值。500 条文件 / 会话全量渲染、审计限
200 的粗测已记录，未做性能重构。原弹层人工走查、off 真机、0.4.53 smoke /
打包及 R5-P2-2 豁免维持不动。

## MCP 易用性覆盖轮：local_ubuntu 真机覆盖 + 三修复 + triage 接线（2026-09-12，0.4.61）

需求：用 dbx ssh MCP 对 local_ubuntu（192.168.33.11）做全工具面覆盖测试，
发现问题并强化 e2e（连接搜索 / 命令定位 / 意图识别）。

**覆盖发现的问题（真机复现）**：
1. SFTP 浏览家族（`sftp_list_dir` / `sftp_stat` / `sftp_exists` / `sftp_pwd`
   / `sftp_read_file` / `sftp_write_file` / `sftp_mkdir` 等 11 个）报
   "Connection is not established"——`sftp_tool` 只做池查找，不像 exec/传输
   家族那样解析 `connectionName` / 懒拨号；带 saved-ref 首次浏览必挂。
2. `ssh_test_connection` 不支持 saved-connection 寻址：saved-ref 直达
   `stored_connection_from_arguments` 报裸 "Missing required parameter: host"，
   且被排除在桥转发面外，stdio 无法免凭据测连。
3. `ssh_alert_triage` 从未接入 MCP 工具面（smoke EXPECTED_TOOLS 与
   docs/MCP.zh-CN.md 均已声明，tools/list 实际只有 28 个）——**HEAD 上
   smoke_mcp.py 本就 FAIL**（`missing tools: ['ssh_alert_triage']`）。
4. `exec::parse_disk_usage` 只认 `/` 前缀 df 数据行，容器 overlay/tmpfs
   （`overlay 91029504 … /`）解析失败——dbx-ssh-test 容器内 `sftp_disk_usage`
   必挂。

**修复**（backend/src/mcp.rs + exec.rs）：
1. `sftp_tool` 改为 `self.connection()` 懒建立 + `connection_pool_key` 取池
   条目（与 upload/download 同契约），SFTP 家族全量支持 saved-ref 首调。
2. `ssh_test_connection` 先过 `registered_connection_by_ref`（注册表/桥）再
   回落内联凭据；加入 `is_connection_bound_tool` 桥转发面；无法解析的
   saved-ref 报错带自愈路径（启动 DBX app → `ssh_list_connections` → 内联凭据）。
3. `ssh_alert_triage` 接入 `run_tool` 外层 match（离线、不触发
   drop_connection）+ tool_definitions 声明，tools/list 恢复 29 个，与
   docs/MCP.zh-CN.md 对齐。
4. `parse_disk_usage` 保底解析任意 6 列数值行（POSIX 表头 "1024-blocks"
   过不了数值检查，无头部误吸风险）；设备行优先级保持。

**e2e/smoke 强化**（scripts/smoke_mcp.py）：
- 新增连接寻址面：21 个连接类工具逐个断言 `connectionName` 属性 +
  selector anyOf；`ssh_list_connections` 降级回路；saved-ref 不可解析的
  自愈引导报错。
- live 段扩容：browse-first（SFTP 懒建立回归，覆盖问题 1 的直接复现路径）、
  `ssh_run_bg` + `ssh_task_status` 轮询闭环、SFTP 文件家族 11 工具全链路
  （mkdir→write→read→stat→exists→copy→rename→chmod→move→disk_usage→remove）。
- 意图识别：triage cpu/memory/disk 三意图断言（OOM 优先级避开）。
- Rust 新增单测：`sftp_and_test_connection_resolve_saved_reference_before_dialing`、
  `alert_triage_is_wired_as_an_mcp_tool`、`parses_disk_usage_for_non_device_filesystems`。

验证：`cargo test --release` 332/332 全绿；`smoke_mcp.py --host`（dbx-ssh-test
容器真机回环）all green（29 工具 + 全部新面）。前端零改动未跑前端三件套。
宿主/协议无变更。版本 0.4.60 → 0.4.61。

## iShell Pro 对标差距收敛批：断点续传 + 趋势/进程管理 + 会话录制（2026-09-12）

用户决策实施 2026-09-12 差距分析（vs iShell Pro）中的三项候选：

**F1 SFTP 断点续传/暂停恢复**：上传中断任务保留 spool（`transfers/upload-<id>.part`）+
sidecar meta（`upload-<id>.json`，`remotePath`/`size` 双校验）；`sftp/upload/start` 新增
`resumeTaskId`（返回 `resumeOffset`，前端只重传尾部）；`sftp/download/start` 新增 `offset`
恢复参数；新增 `sftp/transfer/resumable` 扫描可续传清单；会话内暂停/恢复为分片间挂起
（前端纯语义，`lib/transferResume.ts` 纯模块匹配本地文件）。cancel 语义不变（放弃即清理）。

**F2 监控趋势落盘 + 进程管理**：`metrics-history.jsonl` 环形 720 行（每次新鲜
`ssh/metrics` 采集追加、按连接过滤）+ `ssh/metrics/history`；打开指标卡回填
CPU/内存/网速 sparkline（旧 sidecar 静默降级）。`ssh/processes/list`（`ps` 500 行 CPU 序）
+ `ssh/processes/kill`（pid 0/1 拒绝、signal 白名单 1/2/9/15、`kill -<NAME> <pid>`
白名单化渲染）；前端进程面板（排序/翻页 100 行/TERM+KILL 双确认）。

**F3 会话录制/回放/GIF 导出**：新模块 `session_recording.rs`——asciicast v2 JSONL
（`recordings/<id>.cast`，meta 携带 sessionId/connectionId/host），读循环在目录过滤后
挂录制器（stdout+stderr，State 帧不录），会话关闭自动收尾；RPC
`ssh/recording/start|stop|list|get|delete`（get 分页 500、id 路径穿越校验）；
`ssh/sessions/list` 每行新增 `recording`。前端：终端工具栏录制开关（红点）、录制记录浮条、
回放弹窗（xterm 重放 + rAF 时间轴 + 0.5/1/2/4× 倍速 + 进度 seek）、GIF 导出
（离屏 xterm 逐事件重放、500ms 抽帧封顶 120 帧、零依赖 GIF89a/LZW 编码器
`lib/gifEncoder.ts`，迷你解码器逐位回读单测）。

**新方法**（9）：`sftp/transfer/resumable`、`ssh/metrics/history`、`ssh/processes/list`、
`ssh/processes/kill`、`ssh/recording/start|stop|list|get|delete`；改参 2：
`sftp/upload/start`（resumeTaskId）、`sftp/download/start`（offset）。

**完成定义四件套**：单测——后端 348/348（新增 metrics_history 5、session_recording 5、
resumable/meta 3、进程解析/kill 3）；前端 394/394（新增 transferResume/replayScheduler/
gifEncoder/processActions 4 spec 18 用例，gifEncoder 含 LZW 编解码往返与 GIF 容器逐字节
校验）。smoke——`smoke_fs_test.py` 新增 6 用例（resumable 形状、下载 offset 接受/拒绝、
上传未知 task 拒绝、进程 list+kill 全链路、metrics/history 形状、录制
start/stop/list/get/delete 回环含标记捕获断言）。对标清单——FEATURE_PARITY sshbool 表
两行升级为已做 + 新增「iShell Pro 对标补充（2026-09-12）」节。七语——supplemental
七语各追加 33 键（传输暂停/续传、可续传、进程管理、录制/回放/GIF）。

文档：`PROTOCOL.zh-CN.md` 方法总表 + 5 个新章节（断点续传/metrics history/processes/
recording，参数与错误语义全量）。

**验证实跑（0.4.61 同版重打包）**：`cargo test` 348/348；前端 typecheck + vitest
394/394 + `pnpm build`（修复 v-for 属性内双引号嵌套的模板编译错误后过）；
`dbx-plugin package` 出包 `io.dbx.ssh-0.4.61-darwin-arm64.dbxp`；`smoke_mcp.py`
过；live smoke——`smoke_test.py`/`smoke_batch3_test.py`/`smoke_sudo_otp_test.py`/
`perf_baseline_test.py` 全过，`smoke_fs_test.py` 42 PASS 且本批 6 个新用例全绿。

**与本批无关的预存失败（均用 HEAD 基线二进制复跑对照确认）**：
1. `smoke_fs_test.py`「agent approval remembered skips later prompts」sidecar 帧超时，
   HEAD 基线（无本批改动）同样失败（3/3 复现）；与 `e2e_agent_terminal.py` 用例 03
   「off + forced terminal + sudo denied」同域（strict 审批/sudo 执行路径），疑与
   dbx-ssh-test 容器长期运行状态漂移相关，待专项排查。
2. `e2e_agent_terminal.py` 25/26（仅用例 03 挂，与基线一致）。
3. `smoke_ui_mock.mjs` batch send 断言使用 `.batch-modal`，而该选择器在 HEAD 的
   App.vue 已不存在（batch-bar 改版后脚本未同步），HEAD 基线同样失败；脚本待与
   当前 batch-bar UI 重新对齐。
4. 宿主 `plugin_tools_bridge` 集成测试维持 SKIP（MCP plugin-tools WIP 未集成，
   test.sh 文档化跳过路径）。

## 跟进：预存失败根因修复（2026-09-12，同批追加）

对上一节登记的预存失败逐项跟进，两笔修复 + 一笔语义澄清：

**1. remembered 审批从未接入执行路由（真 bug，修复）**。smoke_fs「agent approval
remembered skips later prompts」超时根因：`mcp.rs ssh_exec_terminal_tool` 只调
`agent_terminal::decide`，remembered 降级（D1）从未接线——`agent_approvals::matches`
与 `agent_terminal::decide_with_memory` 一直是死代码（编译警告在案），"approve +
remember" 之后同一命令每次仍弹审批，无应答即撞 120s 审批超时（客户端 90s 先到）。
修复：路由前按连接加载 `agent-approved-commands.json`，`matches` 命中则
`decide_with_memory(..., remembered=true)` 降级 Prompt→Run；灾难门（D2）不动——
它仍在 `exec_in_terminal` 内部最后生效。最小序列复现（terminal exec → strict
approve → deny → remember → remembered 重跑）从「重跑 45s+ 超时」变为 0.3s 直跑。

**2. e2e 用例 03 陈旧期望（对齐现行语义）**。`e2e_agent_terminal.py` 03 写于
off+elevated 一律 Deny 的时期；7440ad9 起 off + 显式 runInTerminal=true 的
elevated 命令改为弹审批（工具描述与 decide 文档一致），且 off+未显式选择走隐藏
通道根本不进 decide（旧断言的 "Agent terminal mode is off" 在 ssh_exec 路径不可达）。
用例重写为双支：a) off + sudo 无显式选择 → 隐藏通道执行（响应无 mode 字段）；
b) off + 显式选择 + 弹审批 + deny → denied 错误。

**3. smoke_ui_mock.mjs 与 batch-bar 现状对齐**。批量发送自 modal 弹窗改版为常驻
batch-bar 后 walkthrough 未同步（`.batch-modal` 选择器已不存在）；且 batch-bar
默认展开（localStorage `ssh-batch-bar-open` != "0"），脚本开头的 toggle 反而把它
关掉。已重写 batch 段（bar/目标 popover/quick pick 草稿/发送 summary/收起语义），
实跑全绿。

**回归**：cargo test 348/348；smoke_fs 58 PASS / 0 SKIP / 0 FAIL（remember 链
修复后整条 agent 组恢复）；e2e_agent_terminal 26/26；smoke_mcp all green；
smoke_ui_mock all green；重新打包 io.dbx.ssh-0.4.61（含路由修复）。

## 死代码清零批：ssh_terminal_input 工具落地 + 警告门禁（2026-09-12，同批追加）

remembered 修复后继续清剩余 dead_code 警告（每一条都按"未接线功能还是废码"排查）：

**接线——`ssh_terminal_input` MCP 工具（IMPL_PLAN_NETCATTY A2-T5/T6）**。
`mcp_safety` 的 4 个"never used"项（`normalize_terminal_input` /
`is_control_only_input` / `assess_terminal_input` / `MAX_TERMINAL_INPUT_BYTES`）
是 A2 预写的安全函数，工具本体一直没实现。本批按计划落地：

- 门禁纯函数 `terminal_input_gate`（mcp.rs）：① 只读连接仅放行纯控制序列；
  ② 灾难行（聚合判定 `assess_terminal_input`）需 `confirmDestructive`、只读上
  一律拒绝；③ sudo 行过连接白名单；④ §1.3 confirm 档留位注释在案。
- handler：registered ref → 存活会话解析（无会话与 endpoint 选择器统一回落
  `NO_TERMINAL_SESSION` 引导）→ 单会话复用 `batch_terminal_input`（appendNewline
  默认 false）；`{sent: true, sessionId}` 响应；stdio 模式无工作台 PTY，天然
  引导报错（smoke_mcp live 段新增负例断言）。
- 工具 schema：anyOf 连接寻址 + `input`/`appendNewline`/`confirmDestructive`，
  描述含 8 KiB 截断与"输出不收集，要收集用 ssh_exec{runInTerminal:true}"。
- 单测 +3（门矩阵三测）+ schema 清单两处入列；工具数 29→30（MCP.zh-CN.md
  同步，smoke_mcp EXPECTED_TOOLS 入列）。

**清理——测试专用与废码**：`sudo_profiles::load_store_with` 转为 `#[cfg(test)]`
（仅本模块测试使用）；`vault::KeyfileProvider::path()` 零调用删除。

**显式留位**：ssh.rs 的 confirm 三件套（`MCP_CONFIRM_TIMEOUT_SECS` /
`mcp_confirm_challenge_payload` / `request_mcp_confirm`，§1.3 confirm 档的完整
已实现但未接线机械）加 `#[allow(dead_code)]` + 指回 A1 计划的注释——它们是
`execPermissionMode` 落地时的现成积木，不属于废码。

**test.sh 新增死代码警告门禁**：cargo build 出现任何 "never used" 即失败。
动机即本批的教训——`decide_with_memory`/`assess_terminal_input` 的警告各掩盖了
一次"功能写完没接线"，零容忍才能让这类脱接在 CI 里炸出来。

**回归**：cargo test 351/351（+3）；前端 394/394；smoke_fs 58/58；
e2e_agent_terminal 26/26；smoke_mcp（含 live 段 + ssh_terminal_input 负例）
all green；smoke_ui_mock all green；**scripts/test.sh 端到端 exit=0 全绿**
（2026-09-12 首次全绿收官，含新警告门禁）。重打包 io.dbx.ssh-0.4.61。

**A2 剩余（未做，独立批次）**：`ssh_multi_exec`（A2-T3/T4）、§1.3 confirm 档
（`execPermissionMode`/`connectionScope`，机械已备）。

## ssh_multi_exec 落地批：A2-T3/T4（2026-09-12，同批追加）

A2 最后一项功能 `ssh_multi_exec`（多连接聚合执行）按计划落地，工具数 30→31：

- **纯逻辑模块 `multi_exec.rs`**（A2-T3 单测先行）：`normalize_targets`
  （1–10 上限、去重保序、空引用拒绝）、`command_gate`（`sudo …` 整体拒绝——
  提权走单目标 `ssh_exec_sudo`；灾难命令需 `confirmDestructive`、只读上一律
  拒绝；只读连接非白名单命令拒绝，复用 `mcp_safety::assess_command`）、
  `target_from_connection`（registry 行 → 结果行身份字段）。单测 4。
- **handler**：入口全量预解析（任一 targets 未命中注册表 → 整体拒绝并提示，
  不半执行）；parallel 走 `join_all` 递归 helper（tokio 原生 Box::pin，
  Send 约束，无 futures 依赖；join! 参数个数静态故需动态扇出）；
  sequential 支持 `stopOnError` 首败短路；逐目标经共享连接池在隐藏通道
  执行（不经可见终端/agentTerminalMode），单目标失败降级为 `ok:false` 行；
  聚合响应 `{ok, sent, failed, results:[…]}`。
- **schema**：targets（minItems 1/maxItems 10）+ command + mode enum +
  stopOnError + timeoutSecs（5–300）+ confirmDestructive；描述含 ~15s 宿主
  等待上限与 run_bg 引导。smoke_mcp EXPECTED_TOOLS 与两处工具清单单测入列。
- **live smoke**：stdio 独立模式无注册表 → saved-ref 引导负例 + 灾难门
  先于拨号负例（端点选择器在 stdio 模式无 registry 身份，属预期语义，
  IMPL_PLAN §1.1 门禁矩阵在案）。

**A2 收尾状态**：`ssh_terminal_input` + `ssh_multi_exec` 均已落地；
§1.3 confirm 档（`execPermissionMode`/`connectionScope`）为 A2 唯一剩余，
机械（`request_mcp_confirm` 三件套 + `terminal_input_gate` ④ 号留位）已备。

**回归**：cargo test 357/357（+6）；死代码门禁 0 警告；smoke_mcp（live 段）
all green；**scripts/test.sh 端到端 exit=0**（含新工具）。重打包
io.dbx.ssh-0.4.63（工作区既有升版，非本批改动）。

## §1.3 权限档落地批：execPermissionMode + connectionScope（2026-09-12，同批追加）

A2/§1.3 收官批，confirm 三件套从「留位」转正，A2 计划全部功能项完成：

- **`McpPermission`**（与 McpLimits 同文件 `mcp-settings.json`）：
  `execPermissionMode`（autonomous 默认 / confirm）+ `connectionScope`
  （≤64 条；条目匹配 = 连接 id 精确 / 连接名精确 / host ASCII 大小写不敏感）。
  env 覆盖：`DBX_SSH_MCP_PERMISSION_MODE`、`DBX_SSH_MCP_CONNECTION_SCOPE`
  （显式空列表=合法覆盖）。
- **confirm 门**：`call_tool` 既有门序之后、bridge 转发之前，gated 工具
  （is_write_tool ∪ ssh_exec/ssh_multi_exec/ssh_terminal_input；读类与
  `ssh_close` 不拦）经 `request_mcp_confirm` 发 `ssh/agent/prompt`
  （kind mcp-confirm / source mcp，120s 超时），审批可编辑命令替换原文执行。
  **stdio fail-closed**：无 emitter 立即报错引导，不挂 120s。
- **scope 门**：call_tool 归一化后——解析出的目标越界整体拒绝、内联凭据
  （无 registry 身份）fail-closed 拒绝；`ssh_multi_exec` handler 内逐 target
  校验（任一越界整体拒绝）；`ssh_list_connections` 双来源（bridge/registry）
  均按作用域过滤。
- **顺手修复一个顺序缺陷**：原 `settings_set` 先整文件写 limits 再验证
  permission 字段——非法更新也会抹掉已存 permission 键、limits-only 更新会
  丢 permission 键。重构为「先全量验证 → 单次合并写盘
  （`write_settings_document`）」，`McpLimits::save` 与 `save_merging` 随之
  删除。另修测试隔离：`state()` 从共享临时目录改为每调用唯一目录
  （settings 持久化并行测试互踩的根因）。
- **测试**：+6（scope 匹配/env 解析/confirm 工具集/作用域工具集/设置往返
  +env 覆盖/list 过滤）；smoke_mcp 新增 `permission_env_section`（两个注入
  env 的 stdio 进程实跑 confirm fail-closed 与 scope fail-closed，含 list
  在作用域下可用）。工作台设置 UI（B3-T1 权限档 select）留待 B 批。

**回归**：cargo test 363/363；死代码门禁 0 警告；前端 394/394；smoke_fs
58/58；e2e 26/26；smoke_mcp（含新 permission 段）all green；smoke_ui_mock
all green；**scripts/test.sh 端到端 exit=0**。重打包 io.dbx.ssh-0.4.63。
文档：MCP.zh-CN 新增「§1.3 权限档」节；IMPL_PLAN A1-T5/T6、A2-T7 勾选。

## B3 设置 UI 核实收尾批（2026-09-13）

核实工作区既有的 B3 实现（与 0.4.63 升版同期的未提交改动，本批验证 + 收尾）：

- **B3-T1 MCP 权限档设置区**：设置弹窗 MCP 限速区扩展 `permissionMode`
  select（autonomous/confirm，confirm 附七语 hint）+ `connectionScope`
  textarea（每行一条）；`loadMcpSettings`/`saveMcpSettings` 读写两新字段
  （旧 sidecar 不回字段时按 autonomous/空 降级；保存走保存链第 ③ 步）。
- **B3-T2 审批弹窗 source=mcp 适配**：`agentPromptHead.source === "mcp"`
  时标题切 `agentPrompt.mcpSource`（含工具名），可编辑命令/倒计时/记住勾选
  复用；无 source 走原渲染。
- **B3-T3**：七语 `mcpSettings.*` 四键 ×7 + `agentPrompt.mcpSource` ×7 在库；
  前端三件套全绿（typecheck + 394/394 + build）；smoke_ui_mock all green；
  重打包 io.dbx.ssh-0.4.63。

IMPL_PLAN 状态：A1/A2/§1.3/B3 全部勾选。计划内剩余：B4（审计日志查看，
注意 0.4.5x 已有 audit UI——核对后可能直接勾选）与真机 visual 验证项。

## MCP 工具面测试覆盖审计专项（2026-09-13）

对 31 个 MCP 工具按「参数校验 / 错误消息质量 / 成功路径 / 降级路径 / 危险操作门 / 文档一致性」六维做覆盖审计（mcp.rs 单测 24 例 + smoke_mcp 10 场景为基线），聚焦 AI agent 调用时的易用性、准确性、容错性，发现即修即回归。

**发现与修复（现象 → 根因 → 修复）**：

1. **数字写成字符串被静默吞掉**：`port: "2222"` 经 `Value::as_u64` 读 None 后静默回落 22 端口（拨打错误主机）；`timeoutSecs`/`tailBytes`/`maxBytes`/`offset`/`connectTimeoutSecs` 同样静默回默认。→ 新增 `arg_u64`（数字或数字字符串均可，非法值报 `{key} must be an integer`）并替换全部读取点。
2. **端口非法值不报错**：`port: 0` / `99999` 被过滤后静默回 22。→ `call_tool` 顶部新增 `arg_port` 严格校验（1–65535，先于一切门与拨号），报 `port must be between 1 and 65535`。
3. **只读门存在类型混淆绕过面**：内联重拨的 endpoint 身份比对（`registered_connection_matching_inline` / `endpoint_selector`）用 `as_u64` 读端口，字符串端口 `"2222"` 读成 22 会让只读/sudo 白名单的端点继承门失配。→ 门查找路径统一改 `arg_port_lossy`（call_tool 已先严格校验，lossy 仅兜底）。
4. **布尔写成字符串恒读 false**：`confirmDestructive: "true"` 走不进灾难门、`overwrite: "true"` 误判为不覆盖。→ 新增 `arg_bool`（true/false/1/0/yes/no/on/off，大小写不敏感），覆盖 confirm/overwrite/recursive/base64/appendNewline/stopOnError/runInTerminal/quickSudo，`sftp_copy::parse_request` 同步。
5. **未知工具名报错误导**：调用未注册工具名会在 sftp 分支报 "Missing required parameter: host"。→ `call_tool` 顶部按 `TOOL_NAMES` 早检，报 `Unknown tool` + 分隔符/大小写变体 `Did you mean`（`sftp-listdir` → `sftp_list_dir`），并指向 tools/list；`TOOL_NAMES` 与 `tool_definitions` 顺序一致性由单测钉死。
6. **`sftp_chmod` 数字语义含混**：`mode: 644`（LLM 常见八进制意图）按十进制 644 = 0o1204 落盘。→ `parse_chmod_mode`：字符串支持 `0o` 前缀；数字全 0-7 位按八进制读（644→0o644），其余按权限位读（384→0o600，Python `0o600` 兼容）；负数/越界/浮点报带例子的错误。schema description 同步。
7. **`sftp_exists` 把一切错误当"不存在"**：权限拒绝/通道故障也返回 `exists:false`，误导 agent。→ 仅 `StatusCode::NoSuchFile` 判 false，其余错误如实上抛。
8. **错误消息质量**：`targets` 传字符串报含混的 "Missing targets" → 现报 "targets must be an array of 1-10 connection references"；`ssh_close` 无 selector 时对 `mcp-@:22` 报 "no cached connection" → 现报需要连接引用的指引；`required_str` 类型错误统一 "Missing or invalid parameter: <key> (expected a non-empty string)"。
9. **既有测试被粘死**：`sftp_and_test_connection_resolve_saved_reference_before_dialing` 的 `#[tokio::test]` 粘在文档注释行尾，测试从未运行且触发 never used 警告 → 拆行救活。

**新增覆盖**：Rust 单测 +9（容错 helper / chmod 变体 / TOOL_NAMES 同步 / 未知工具 / 端口 fail-fast / 字符串布尔与数字过门 / multi_exec targets / ssh_close 指引 / required_str 消息），374/374；smoke_mcp EXPECTED_TOOLS 补齐 `ssh_run_bg`/`ssh_task_status`/`ssh_list_connections`（28→31），新增 "llm input tolerance" 离线段（字符串端口/超时、非法端口 0 与 "abc"、未知工具 did-you-mean、字符串 confirmDestructive 过灾难门、multi_exec targets 指引）与 live 段 chmod 数字八进制（600）复验。

**回归**：cargo test 374/374；`cargo build`/`--release` 0 警告（死代码门通过）；smoke_mcp 离线 all green（31 工具）+ 在线容器段 all green（test/browse/exec/multi_exec/terminal/run_bg/家族含 chmod 变体/metrics/transfer 回环）。

**剩余风险**：`scripts/test.sh` 的宿主桥段（host worktree 安装管线）本机默认路径不存在未跑，前端/打包段与本批（backend+scripts+docs）无关未触发；未知参数（schema 外多余字段）仍静默忽略（严格 schema 校验归 MCP 宿主职责）；`sftp_upload`/`sftp_download` 等工具对目标端语义变化无——本次仅收紧报错与解析，不改任何成功路径行为；文档已同步（MCP.zh-CN 新增「LLM 输入容错」节 + chmod 行更新）。

## B4 核实批：审计 clear + 执行面审计补齐（2026-09-13）

核实 B4（审计日志查看）：前端折叠区/kind 过滤/清空按钮/truncated 提示与七语
`auditLog.*` 均已完整（工作区既有改动）。核实过程暴露**两处后端脱接**（与
remembered 同款的"前端写了、后端没接"），本批补齐：

1. **`ssh/audit/clear` RPC 从未注册**：`audit_log.rs` 无 clear 函数、main.rs
   无分发臂——前端清空按钮点了没反应（catch 静默）。补 `audit_log::clear`
   （truncate 活跃 JSONL + 删除轮转代，保留文件本体让并发 O_APPEND 追加者
   永不见缺文件；clear 后追加自然开启新一代账本）+ RPC 臂 + 单测
   （truncate/轮转代清理/clear 后追加/空文件 no-op）。
2. **MCP 执行面审计行从未写入**：mcp.rs 无 `audit_log::append` 调用——台账里
   只有审批生命周期行（approved/denied/remembered/timeout），IMPL_PLAN 说的
   "每调用一条 gate/outcome/exitCode/duration/mode" 执行行不存在。
   补 `call_tool` 外层包装：gated 工具（is_confirm_gated_tool 同集）逐调用
   落账（gate=pass + refusal 错误进 error 字段、exitCode、duration、
   mode=embedded|stdio 按有无 emitter）。该包装顺带把之前因模块引用缺失而
   未被收集的 10 个 mcp 测试带回编译（374 全绿，含死代码警告消失的
   saved-ref 测试）。

smoke：`smoke_fs_test.py` 新增「ssh/audit/clear truncates the ledger」用例
（list→clear→空→auto 模式 mcp exec→新执行行落账断言），59 PASS / 0 SKIP /
0 FAIL。

**回归**：cargo test 374/374；死代码门禁 0 警告；smoke_mcp all green；
smoke_ui_mock all green；scripts/test.sh exit=0。重打包 io.dbx.ssh-0.4.63。
文档：IMPL_PLAN B4-T1/T2 勾选。

## MCP 测试覆盖第二轮：降级矩阵 + 组合矩阵 + agentic smoke（2026-09-13）

第一轮（参数容错/fail-fast/did-you-mean）之后的续批，补齐剩余维度——桥降级
矩阵全走查、安全门组合矩阵、真实 LLM 多步链路 smoke、settings 联动、遗留核对。
本批只动 `ssh/`（mcp.rs 测试 + smoke_mcp.py + 两份文档），无行为面改动、仅一处
同族一致性修正（见下）。

**新增覆盖（Rust 单测 +8，374→382）**：

1. `every_connection_bound_tool_plans_a_bridge_forward_for_a_ghost_id`：
   21 个连接级工具在未注册 connectionId 下全部进入 L1 桥转发计划（此前只有
   ssh_exec/runInTerminal 单点），本地工具（close/list/known_hosts/quick
   sudo/alert_triage）从不转发——桥降级语义对全工具面一致。
2. `connection_list_merge_resolves_dual_source_conflicts`：连接寻址双源
   （bridge registry vs session registry）同 id 冲突时桥数据胜出且去重不重复
   列条；不同 id 并列；connectionScope 对两来源都过滤；桥不可答降级注册表+note。
3. `gate_combo_matrix_read_only_destructive_sudo_and_scope`（组合矩阵 8 格）：
   非只读+灾难+布尔确认→过门；无确认→提示；**白名单命中（shutdown *）的灾难
   命令仍要 confirmDestructive（白名单不豁免灾难门），带确认后两闸皆过**；
   只读+写工具+白名单命中→只读门先于白名单；只读+巡检命令+确认位→确认位不
   改变白名单判定；只读+灾难+确认→确认位无效；进程级只读开关压过连接可写
   属性（且巡检命令仍可用，fail-closed≠全拒）；scope 非空时内联+灾难命令在
   灾难判定之前整体拒绝（scope 是第一道 fail-closed 闸）。
4. `terminal_input_combo_gates_stack_in_order`：灾难行+确认后 sudo 行仍受
   白名单拒绝（确认只解锁灾难门一层）；白名单命中行+确认两闸皆过到会话引导。
5. `alert_triage_tool_surface_classifies_extended_intents`：ssh_alert_triage
   工具面扩类 network/oom/service/generic/中英混合（cpu/memory/disk 第一轮已
   有），9 例按 KEYWORDS 表实际行为断言；每条建议命令在工具出口满足 D6；
   service 类 unit 名替换在工具面生效。
6. `settings_set_changes_drive_downstream_tool_behavior`：mcp/settings/set
   四个可调项的联动回归——localTransferRoot 收窄立即改变 sftp_upload 根闸
   （默认根放行→收窄拒外→根内过闸）、maxUploadBytes 超限即拒（拨号前）、
   execPermissionMode=confirm stdio fail-closed 且切回 autonomous 恢复、
   connectionScope 非空拒内联/清空恢复，settings_get 回显生效+persisted。
7. `malformed_port_is_rejected_before_lossy_gate_reads`（第一轮遗留核对）：
   非法端口在 sftp_stat/ssh_close/ssh_remove_known_host 上都被 call_tool 顶部
   早校验拦下——确认 arg_port_lossy 的静默回 22 在生产路径不可达（仅测试直呼
   兜底），且先于 ssh_close 自身的引用指引。
8. `unknown_arguments_never_distort_known_parameter_parsing`（第一轮遗留核对）：
   schema 外未知参数静默忽略不反噬——未知键+合法键混合仍按既有解析报错、
   大小写变体（"Port"/"ConfirmDestructive"）不被识别也不解锁任何门、本地工具
   带未知参数照常成功。

**smoke_mcp 新增三段（离线）**：

- `stub_app_bridge_section`：以内存 stub DBX app（HTTP 服务器发布
  mcp-bridge-port）实转桥全链路——`ssh_list_connections` 合并桥列表
  （source=dbx-app-bridge）；`ssh_exec` 以 connectionName 经桥列表解析出 id
  后转发 `/call-plugin-tool`（断言 plugin_id/connection_id/arguments 形状），
  应用侧 MCP envelope 原样透传；`sftp_stat` 以 connectionId 同路转发。第一轮
  场景 8 只验证了桥不可达，本段首次验证"桥可达时的转发正确性"，无需真 app。
- `dead_bridge_section`：桥端口已发布但监听方即收即闭（应用尸体）——三个代表
  连接级工具（ssh_exec/sftp_stat/ssh_task_status）转发快速回落（总耗时 <10s，
  不走 30s 唤醒预算），回落错误带自愈三件套（not registered /
  ssh_list_connections / inline credentials）；list 降级 session-registry+note。
- `agentic_workflow_section`：模拟 LLM 真实多步链路（空 app-data、桥未发布）：
  initialize → tools/list（agent 从 schema 学到 connectionName selector）→
  ssh_list_connections（降级+note）→ 用 connectionName 调 ssh_exec 失败 →
  按错误指引切内联端点 → 按第二条指引补密码 → 本地验证型工具收尾成功
  （ssh_list_known_hosts + ssh_alert_triage network 告警、建议命令无 sudo/
  重定向）。每步错误文本字面包含下一步所需指引（自纠闭环逐步断言）。

**alert intent smoke 扩类**：主流程 intent 循环 2→7 例（补 network/oom/
service/generic/混合 CPU），与 Rust 工具面扩类同表。

**同族一致性交叉核对（ldap/files/kafka 只读对照）**：

- 骨架一致：四家均为 MCP 2024-11-05 stdio（ldap/kafka 为 ssh run_mcp_stdio
  的 Go 移植）、mcp/tools|call|settings + lifecycle 转发同构；settings 白名单
  部分更新+上限 clamp 同款；未知工具 ldap/kafka 报 "unknown tool" 且列已注册
  名供自纠（与 ssh did-you-mean 语义相容）。
- **发现 ssh 侧一处漂移并修正**：`initialize.serverInfo.name` 原为短名
  `dbx-ssh`，files/ldap/kafka 三家均为完整插件 id（io.dbx.files 等）——ssh
  改为 `io.dbx.ssh`（纯展示元数据），同步 smoke 与 Rust initialize 形状断言。
- 别家漂移（只报告不动）：ldap/kafka stdio 的 "Method not found" 用 JSON-RPC
  标准码 -32601（另分 -32700/-32602），ssh/files 基线是统一 -32000（files
  smoke 的 SKIP 语义明确依赖 -32000）；纯码面差异、文案一致，不影响功能，
  建议后续由族内统一决策（若改 ssh 需连带 smoke SKIP 判定）。

**回归**：cargo test 382/382（+8）；`cargo build`/`cargo build --release`
0 警告（死代码门通过）；smoke_mcp 离线 all green（31 工具）+ 在线段
all green（dbx-ssh-test 容器 127.0.0.1:2222，密码仅经 DBX_SSH_SMOKE_PASSWORD
环境变量传入，未落盘）。`scripts/test.sh` 的 host-worktree 段因本机默认路径
缺失未跑（同第一轮说明），其余段与本批（backend 测试+scripts+docs）无交集。

**文档**：MCP.zh-CN「方式二」补 serverInfo.name 与桥降级矩阵两处、「生产
环境误操作防范」补门序与组合不变量小节；本 PROGRESS 小节。

**剩余风险**：stub 桥仅覆盖 HTTP 层转发契约，真实 app 侧 sidecar 的审批/
agentTerminal 联动仍靠真机 e2e（scripts/e2e_agent_app_bridge.py）；ldap/kafka
错误码漂移待族内决策；scripts/test.sh host-worktree 段仍依赖本机路径。

## iShell 对标追加：终端 WebGL GPU 加速（2026-09-13，0.4.63）

用户点名项：对标 iShell Pro 的「WebGL GPU 加速」终端渲染。

- **依赖**：`@xterm/addon-webgl@0.18.0`（xterm 5.5 配套版；0.19 是 xterm 6 的，不升）。
- **纯逻辑模块 `lib/terminalWebgl.ts`**：偏好持久化（localStorage
  `ssh-terminal-webgl`，默认开=对标 iShell；默认值不落键）、
  `attachWebglRenderer`（构造/activate 抛错→半初始化清理→返回 null 静默
  回退 DOM 渲染；挂载成功即接 `onContextLoss` → dispose 回退）、
  `syncWebglRenderer`（设置开关即时切换，幂等）。addon 以工厂注入，
  模块零 UI 依赖可测。单测 7（偏好 roundtrip/存储异常容忍/attach 三路径/
  切换幂等）。
- **App.vue 接线**：`createTerminal` 尾部按偏好挂 renderer；设置弹窗新增
  「终端渲染」节（switch + 七语 hint，`setWebglEnabled` 即时生效）；
  回放弹窗与 GIF 导出的离屏终端**刻意不挂** WebGL——导出依赖 2d canvas
  drawImage 稳定路径，且浏览器 WebGL context 总数有限。
- **mock walkthrough 演进**：WebGL 渲染下终端文本只存在于 GPU canvas，
  DOM 文本断言结构性失效——mock 新增 `?render=dom`（强制 DOM 渲染器路径），
  walkthrough 主流程带参运行；另加「webgl renderer smoke」段（默认偏好下
  不带参数开第二页面，断言终端持有 GPU canvas 或回退 DOM rows 任一渲染器
  正常挂载）。

**排障插曲（留档）**：echo 断言连挂一度误判为数据链路断裂，实测
handleBinary/lastSequence 全部正常——根因有二：① debug 脚本 console hook
的 filter 把 bin-debug 日志滤掉（误导方向）；② WebGL 渲染下 textContent
结构性为空（真实的设计影响）。另发现并清理：残留 vite dev server 占端口
serve 旧代码干扰调试。

**回归**：前端三件套全绿（typecheck + 401/401 + build，含新增 7 用例）；
smoke_ui_mock all green（含 webgl 冒烟段）；重打包 io.dbx.ssh-0.4.63。
FEATURE_PARITY iShell 表新增「终端 WebGL GPU 加速 ✅」行。

## MCP 收敛轮第三轮：stdio 错误码族内统一（2026-09-13）

第二轮记录过「ldap/kafka stdio 用标准码 -32601、ssh/files 用 -32000」的族内
漂移，本轮按族内统一决策收口（files 由并行 agent 同步改）：

- **改动（单点）**：`mcp.rs` `dispatch` 的错误返回由裸 `String` 改为
  `(code, message)` 元组——stdio 分发层未知 method 回 **-32601**
  （文案不变，仍 `Method not found: <method>`）；`tools/call` 内的一切
  工具级/应用级错误维持 **-32000**（四插件一致）；`-32700` parse 与
  `-32600` 无 id invalid request 原样保留。
- **影响面排查**：桥模式（DBX 插件内嵌）不经 JSON-RPC 信封——业务错误经
  `to_plugin_error` 统一 -32000、未知 binary 通道本就是 -32601，**本轮零改动**；
  其余 smoke（smoke_fs/batch3/batch_quick/sudo_otp/perf_baseline）的 SKIP
  判定按 "Method not found" 文案（部分兼容 `-32601` 码面）匹配，文案未动，
  全部天然兼容；smoke_mcp.py 只读 `error.message`、不读码，无需改。
- **断言/文档**：`initialize_and_list_tools_follow_mcp_shape` 的未知 method
  断言 -32000 → -32601 并补 message 断言；`unknown_tool_names_get_actionable_errors`
  注释改为明确「未注册 tool 名是工具级错误仍 -32000」（断言不变）；
  MCP.zh-CN「方式二」下新增「JSON-RPC 错误码分档」小节。

**回归**：cargo test 382/382；`cargo build` / `cargo build --release`
0 警告（死代码门通过）；release 二进制实发验证：`no/such/method` → -32601、
`tools/call` 未注册工具 → -32000，分档正确；smoke_mcp.py 离线段全绿 +
在线段 all green（dbx-ssh-test 容器 127.0.0.1:2222，密码经
DBX_SSH_SMOKE_PASSWORD 环境变量传入，未落盘）。

**剩余风险**：无新增。宿主桥层对错误码的消费面未变（业务错误仍 -32000），
后续 host 契约监察照常覆盖。

## 第四轮（2026-09-13）桥回环：真机 DBX.app 端到端验证

隔离 app-data（`shared/host-e2e/app-data`）+ 测试 DBX.app（host debug
bundle，经 launch.sh 注入 `DBX_DATA_DIR`，收尾按记录 pid 精确 kill），
四插件最新 dbxp（ssh 0.4.67）经 install.sh 装入同一 app-data；桥端口
`mcp-bridge-port`（本轮 49526）发布后 TCP 探测通过。

- **全链路真执行（核心证据）**：standalone `dbx-plugin-ssh --mcp`
  （`DBX_APP_DATA_DIR` 指向隔离 app-data）`tools/call ssh_exec
  {connectionId:"vagrant", command:"echo <marker> && hostname"}`（隐藏
  通道，不带 runInTerminal）→ 经桥转发 → 宿主 `/call-plugin-tool` →
  app 侧 ssh sidecar → vagrant VM（192.168.33.11:22）真实执行，返回
  `{"exitCode":0,"output":"<marker>\nvagrant"}`——转发 → 宿主 → 插件
  workbench sidecar → 真实结果全链路打通。
- **现成 e2e 套件**（`scripts/e2e_agent_app_bridge.py --skip-autolaunch`，
  T4 必须 skip：其 pkill 会误杀用户真实 DBX.app）：T2 内联凭据引导拒绝、
  T3 桥不可达 30s fail-closed PASS；T1/T5（runInTerminal 可见执行/ shell
  复用）FAIL——错误为 app 侧结构化 `HTTP 502: {"error":"No open
  terminal session for this connection; open the SSH workbench terminal
  first"}`（经桥转发回来的错误，链路本身通）。根因：宿主 emit
  `mcp-open-connection-workbench` 后立即 invoke 插件侧，冷启动/前端未
  就绪时工作台 tab 尚未建立 PTY（两次复现；tab 已建立场景此前 §27 时代
  曾通过）。留待下一轮（宿主等待/重试或前端就绪信号），本轮只读不修。
- **转发门语义差异（记录）**：`bridge_forward_plan` 命中未知 connectionId
  会转发，但 `forward_tool_via_bridge` 失败（含 app 侧 404「连接不存在」）
  时静默落回 inline 自纠错误（L0 文案），因此 ssh 无法像 ldap/kafka/files
  那样用未知 id 产生 FORWARDED 证据；沉淀脚本
  `shared/host-e2e/mcp_bridge_e2e.sh` 对 ssh 改用真实 vagrant 连接断言。
- **沉淀**：`shared/host-e2e/mcp_bridge_e2e.sh`（装四插件 → 拉起 → 等桥
  端口 TCP 探测 → 四插件回环探针 + 空目录 control 对照 → ssh 套件 →
  按 pid 收尾），本轮真机全绿 4/4。

**剩余风险**：runInTerminal 冷启动竞态（上述）未解；偶发观察到 ssh 真
连接探针之后的下一两个跨插件转发调用 90s 无响应、单独重跑立即成功
（疑似宿主侧/GUI 渲染竞态，脚本超时已放宽 150s + 重试一次），留观。

## 第五轮（2026-09-13）可靠性纵深：stdio 传输 / 会话存储 churn / 安全门对抗

三维度系统性覆盖此前未钉死的可靠性面：stdio 传输层敌意输入、会话/存储长期
churn、安全门对抗输入。**发现即修、修完即回归**，共 7 处实现级修复。

### 任务一：stdio 传输层健壮性

- **缺陷①（传输崩溃）**：非法 UTF-8 字节流会让 `BufRead::lines()` 返回
  `InvalidData`，`run_mcp_stdio` 原 `let line = line?;` 直接把错误冒泡到
  main → **整个 MCP 会话进程退出**。修复：行处理重构为可单测的
  `classify_stdio_line`——`InvalidData` 按传输层 parse failure 回 `-32700`
  （id null）后继续服务（read_until 已消费到换行，流可续读）；真 I/O 错误
  仍终止。空行/纯空白/CRLF 残 `\r` 静默容忍（serde_json 容忍尾随 `\r`）。
- **缺陷②（信封形状静默容忍）**：`jsonrpc` 非 `"2.0"`（含缺失/数字形态）
  原样放行返回成功；`id` 为 object/null/bool 原样回显；缺/非串 `method`
  落到 `-32601 "Method not found: "` 的错误分档。修复：dispatch 增信封校验
  ——三者统一结构化 `-32600`（`invalid_request_envelope`：id 仅在自身合法
  string/number 时回显，否则置 null）；notification（`notifications/*`）
  保持完全静默，合法请求零行为变化。
- **pipelining/超长行**：既有 spawn+stdout 互斥设计本就支持乱序完成按 id
  对应、8 MiB 单行正常解析应答——本轮以 smoke 实发钉死。
- **smoke 新段 `protocol robustness`**（离线）：非法 JSON/非法 UTF-8 →
  -32700；notification 严格零响应（下一行必须是后续请求的应答）；8 类坏信封
  → -32600；8 MiB 单行预算内应答；4 请求不等待连发按 id 1:1；空行/CRLF；
  每种敌意输入后跟合法 ping 断言会话健康。readline 带 select 看门狗，进程
  假死会 FAIL 而非挂死整个 smoke。

### 任务二：会话/存储 churn（Rust 单测）

- **审批挑战存储 churn**（ssh.rs）：500 轮 raise→resolve（approve/deny 交替）
  后注册表恒空、消费过的 id 永久 unknown（一次性语义跨 churn 成立）、决策
  恰达一次；MCP confirm 挑战的 `timeoutSecs` 在签发时烙进 payload（ssh 无
  confirmTtlSecs 可调键，120s 固定即"已签发不追溯"的结构性满足，payload
  双档烙印钉测试）。
- **会话注册表 churn**（mcp.rs）：500 轮注册→id/name/endpoint 三种寻址→
  选择器不匹配报错→drop→陈旧 id 返回 None（自愈路径保留），注册表始终
  ≤1、终态为空——session-registry 单源查找在长期 churn 下无漂移。
- **幂等重复调用**：ssh_alert_triage / ssh_list_known_hosts / settings_get
  连续 100 次结果逐字节一致（无状态累积漂移）。
- **settings 存储 churn**：500 轮白名单部分更新（execPermissionMode 交替 +
  maxUploadBytes 交替），每次即时可见；持久化文档 <4 KiB 恒定形状、数据目录
  零新增文件（无逐写累积）；超天花板值仍在 churn 后被拒（clamp 语义不退化）。
- **run_bg/task_status 离线语义 churn**：任务表本体在**远端主机**
  （`/tmp/.dbx-ssh-tasks` nohup 日志），进程内无注册表可泄漏——离线可测面
  为两个输出解析器，300 轮 start/running/done/missing 循环解析恒等（如实
  说明：远端表不属本进程泄漏面）。

### 任务三：安全门对抗输入（含 4 处门加固）

- **缺陷③（sudo 前缀绕过灾难门）**：`destructive_pattern` 只看顶层动词，
  `sudo rm -rf /` 因 verb=sudo 直接落 Unknown——可写连接上**无需确认即执行**。
  修复：sudo 臂剥 sudo 及其旗标（`-u root` 等，选项段在首个非旗标 token 处
  结束，`sudo rm -rf /` 的 `-rf` 留给内层）后对内层跑 `destructive_pattern`，
  并经 `destructive_after_wrap` 递归穿透（`sudo sh -c 'rm -rf /'` 命中）。
- **缺陷④（sh -c 脚本绕过）**：`sh -c 'rm -rf /'` / `bash -lc 'reboot'`
  同落 Unknown。修复：shell `-c` 臂提取脚本文本递归评估，命中灾难即升级。
- **缺陷⑤（子命令替换绕过）**：`echo $(rm -rf /)` / `` echo `rm -rf /` ``
  含 `$(`/反引号即 Unknown，可写连接无需确认。修复：`assess_command` 新增
  替换扫描（`$( )` 嵌套感知 + 反引号、未闭合 span 取余串保守），span 内容
  深度受限递归评估，命中灾难即升级。**三处加固均为 Unknown→Destructive
  单向收紧**，绝不反向升级（`sh -c 'df -h'` 仍 Unknown、只读连接照拒），
  既有 382 用例零回归。
- **缺陷⑥（敏感路径门形状绕过）**：`//etc//shadow`、`/etc/./shadow` 因前缀
  匹配失效而放行（只读连接可读）；相对路径 `./etc/shadow`、系统目录 cwd 下
  裸名 `cat shadow` 同理。修复：`is_sensitive_path` 统一走归一化形态
  （`normalized_path`：折叠空段与 `.`、保留绝对/相对形状），并补 shadow/
  gshadow/sudoers 裸名兜底；`sftp_download` 本地落点黑名单
  （`is_sensitive_local_path`）同步归一化（`/etc//cron.d/x` 不再绕过）。
  **URL 编码 `%2e%2e` 刻意不解码**（shell/SFTP 均不解码百分号，字面名非
  穿越）——设计内保守行为，钉测试并文档化。
- **设计内确认（记录）**：白名单外非灾难命令（`rm -rf /tmp/x` 等 Unknown）
  在可写连接本就无需确认——白名单只约束只读连接，属既定设计；字符串布尔
  fail-closed（无法解析即报错）第四轮已覆盖，本轮补 `'TRUE'`/`'on '` 等
  形态经 `arg_bool` 归一解析的断言（含在对抗测试内）。
- **门级穿透验证**：新单测直接经 `call_tool` 断言 `sudo rm -rf /`、
  `echo $(rm -rf /)` 等 6 变体在工具门返回 `confirmDestructive` 且早于凭据
  校验，良性命令不受误伤（仍走到 password 校验）。

### 回归

- `cargo test`：**394/394 全绿**（基线 382 → +12：mcp.rs 8、mcp_safety.rs 3、
  ssh.rs 1）。
- `cargo build` / `cargo build --release`：0 警告（死代码门通过）。
- `smoke_mcp.py` 离线段 **all green**（31 工具 + 新 protocol robustness 段）；
  在线段 all green（dbx-ssh-test 容器 127.0.0.1:2222，USER_PASSWORD 经
  docker inspect 取出后仅经 `DBX_SSH_SMOKE_PASSWORD` 环境变量传入，未落盘、
  不入回复）。
- `scripts/test.sh` 的 host-worktree/package 段未跑（同前几轮：依赖本机
  默认 host worktree 路径）；backend 测试、死代码门、release 构建、MCP smoke
  均已单独全绿，与本批改动（backend/src/mcp.rs、mcp_safety.rs、ssh.rs、
  scripts/smoke_mcp.py、docs）无遗漏交集。前端零改动。

### 文档

- MCP.zh-CN「方式二」新增「传输层健壮性（第五轮）」小节；「生产环境误操作
  防范」危险命令确认条目补灾难门对抗加固与敏感路径归一化/%2e%2e 不解码
  说明；分类器小节同步替换扫描语义。
- 本 PROGRESS 小节。

### 剩余风险

- `$()`/反引号内容**不可静态判定的形态**（如 `$( $(echo rm) -rf / )`、
  变量间接 `eval`）仍为 Unknown——可写连接上不要求确认（与白名单外命令
  同基线），只读连接一律拒绝；静态分类的天花板如此，纵深（只读白名单、
  sudo 白名单、审计）兜底。
- 危难门加固的理论误报面：`grep "$(rm -rf /) 教程" log` 之类**文本内容**
  恰含灾难串的命令会要求一次确认——拦截代价是一次显式确认，方向安全。
- smoke `protocol robustness` 段的 select 看门狗为 POSIX 实现（macOS/Linux
  验证通过；Windows 侧 smoke 从未在族内跑过）。
- run_bg 远端任务表（`/tmp/.dbx-ssh-tasks`）残留清理属宿主运维面，进程内
  无对应状态可测。

## 第六轮（2026-09-13）schema 收敛：description 回填 / 缺参枚举 / 单行上限

来自第五轮 schema↔行为一致性核对器（`shared/mcp_schema_check.py`）的发现，
三任务收敛。核对器基线：**DRIFTS 121**（118 处参数级 description 缺失 +
3 处缺参漏报）、PASS tools 6/31、WARN 28；收敛后：**DRIFTS 0、PASS tools
31/31、WARN 28（清单与基线一致，均为 §3.7 连接参数门先于参数校验的顺序
张力 WARN + 1 条未知参数探针不适用）、HINTS 0、退出码 0**。

### 任务一：回填 118 处参数级 description（单点化）

- 缺口集中在共享连接参数族：`authentication` / `connectTimeoutSecs` /
  `authFlowMode` / `passwordPromptHint` / `totpPromptHint`（5 参数 × 23 个
  连接类工具 = 115）+ `ssh_quick_sudo_profiles_save` 内联的 3 个（118）。
- **单点定义**：新增 5 个共享 description 常量（`AUTHENTICATION_DESCRIPTION`
  等），`connection_properties` 与 `ssh_quick_sudo_profiles_save` 两处 schema
  均引用常量，文案永不漂移。内容对照实现写实：`authentication` 说明省略时
  按 `privateKeyPath` 推断及各方法的必填约束；`connectTimeoutSecs` 单位秒、
  缺省 15、下限 1；`authFlowMode` 三个枚举值的 2FA 流程语义（合发/先密后码）
  与显式参数优先级；两个 prompt hint 说明「内建提示词模式未命中时识别非标
  提示」的用途。

### 任务二：缺参报错一次枚举全部缺失项（3 处 fail-fast 漏报）

- `ssh_multi_exec`（只报 `command` 漏 `targets`）、`sftp_upload` /
  `sftp_download`（只报先检查的 `localPath` 漏 `remotePath`）改为新辅助
  `missing_required(arguments, keys)`：一次枚举**全部**缺失（absent/null）
  的 required 参数，报 `Missing required parameters: a, b`（按 schema
  required 顺序）；只缺一个时只点名那一个。
- **向后兼容**：错误文案保留 `Missing required` 关键词；present-but-类型
  错误（非串/空串）不混入枚举，仍走 `required_str` 的
  `Missing or invalid parameter: <key>` 精确点名——smoke 的
  `targets must be an array` 断言与核对器 B2 类型探针均不受影响。族内
  其余现行（ssh 侧 20+ 工具、files/ldap/kafka）仍为单参数 fail-fast，本轮
  只改这三处双 required 工具，未扩散。
- 单测 `missing_required_errors_enumerate_every_gap`：双缺全点名（3 工具）、
  单缺只点名其一、null 视同缺失、类型错误不误报为缺失。

### 任务三：stdio 单行上限拉齐族内契约

- 读取层由 `BufRead::lines()` 改为 `read_until(b'\n')` 循环：新增
  `DBX_SSH_MCP_STDIO_MAX_LINE`（字节，缺省 16 MiB；非法/0 值安全回落——
  与 files `DBX_FILES_MCP_STDIO_MAX_LINE` 同族）。超限行**整体丢弃**
  （连同行尾换行消费完毕，续读下一行）并回单条 `-32700`（消息带上限字节
  数与 env 名）；不能沿用 `lines()` 的原因是超限行需要 read_until 语义
  保证消费边界。缺省 16 MiB 下既有 smoke 的 8 MiB 敌意行仍走正常解析。
- 与既有逻辑兼容：`classify_stdio_line` 签名不变（InvalidData 臂保留为
  `lines()` 形态错误的防御性兜底并有单测钉死），实际非法 UTF-8 经有损解码
  落入 JSON 解析失败的同一 `-32700` 路径（与 files 同构）；空行/CRLF 容忍、
  in_flight 有界 drain 均不变。
- 单测：`stdio_max_line_env_is_parsed_with_safe_fallback`（合法/带空白/
  垃圾/0/负数/未设置）、`over_limit_line_gets_structured_parse_error`
  （-32700、null id、消息含 env 名与上限字节数）。

### 回归

- `cargo test`：**397/397 全绿**（基线 394 → +3）。
- `cargo build --release`：**0 警告**（死代码门通过）。
- `smoke_mcp.py` 离线段 **all green**（31 工具；新增
  `missing-required enumeration ok` 断言组与 `stdio_line_limit` 新段：
  512 字节上限下超限行回 -32700 且消息含 env 名、随后 ping 与真实工具
  调用照常应答；在线段未跑——与本批改动无交集，既有在线覆盖未受影响）。
- `shared/mcp_schema_check.py`：**DRIFTS 0（基线 121）、PASS 31/31
  （基线 6/31）、WARN 28、HINTS 0、退出码 0**。

### 文档

- MCP.zh-CN「传输层健壮性」超长行条目补单行上限 env 契约；「LLM 输入
  容错」补缺参一次枚举语义。
- 本 PROGRESS 小节。

### 剩余风险

- 核对器 28 条 WARN 属登记设计（§3.7 连接参数门先于业务参数校验的顺序
  张力 + `ssh_list_connections` 未知参数探针超时不适用），非本轮引入。
- 单行上限只约束 stdio 输入行；桥模式（HTTP 转发）不经该读取层，大小
  预算由 HTTP 层自身约束——族内一致，无需额外处理。
- smoke 新段 select 看门狗为 POSIX 实现（同第五轮 protocol robustness
  段，Windows 从未在族内跑过）。

## 第七轮（2026-09-13）在线补强：全量在线回归 / enum 在线报错 / 在线 pipelining

第六轮在线段因无 `--host` 未跑；本轮补齐在线全量回归，并把契约表 §3.3 的
「enum 非法值报错列合法值」在线覆盖登记项收进 smoke（离线核对器探针被连接
门/工作台门拦截、无法到达的部分），另补第五轮 protocol robustness 的在线
并发面。

### 任务一：在线全量回归

`cargo build --release` 后对 dbx-ssh-test 容器（127.0.0.1:2222，凭据仅经
`DBX_SSH_SMOKE_PASSWORD` 环境变量传入）跑完整在线 smoke：**all green**
（31 工具 + 第五/六轮全部新段 + 本轮新增四段，见下）。第五/六轮改动未引入
在线路径回归。

### 任务二：enum 非法值报错在线补强（§3.3 在线覆盖登记项收口）

先以一次性探针（/tmp，不入插件目录）确认三个代表工具的真实行为，再钉进
smoke 新段 `live_enum_section`（无容器时随在线段整体 SKIP，合规）：

1. **sftp_chmod `mode` 语义**：非法值 `"999"` / `"-384"` / `"rw-r--r--"`
   均报 `mode must be an octal value up to 7777 (e.g. "644", "0755" or 644)`
   ——列出合法八进制形式；报错前后 `sftp_stat` permissions 不变（**无副作用**
   实证）；正面对照 `"0o640"` 前缀变体照常落位 `0640`。
2. **ssh_multi_exec `mode` enum**：非法值 `"wrong"` 与大小写变体
   `"PARALLEL"` / `"Sequential"` 均报
   `mode must be "parallel" or "sequential"; got '...'`（列全合法值），且
   校验先于 targets 解析/dial（inline endpoint 直接拒绝，无副作用）。
   **大小写敏感**为实现的实际行为，与 schema enum（仅小写）一致——按实际
   行为断言，无需改实现。
3. **ssh_exec_sudo `authFlowMode`**（NOPASSWD sudo 容器，各流程均以
   `whoami → root` 成功证明「未报 enum 错误」）：大写 `"PASSWORD_ONLY"`
   归一成功；别名/非法值 `"garbage-flow"` **静默降级**为缺省
   password_then_otp 流（§3.3 登记的设计豁免）。发现 schema description
   只写了「缺省 when omitted」、未标注大小写不敏感与非法值降级——属
   **schema/实现文档不一致**，小改 `AUTH_FLOW_MODE_DESCRIPTION` 补
   「Values are matched case-insensitively; unrecognized values fall back
   to the default flow」（共享常量单点，两个 schema 位点同时生效）。
4. 单测钉住：`multi_exec_mode_enum_rejects_invalid_and_wrong_case`
   （三种非法/错大小写值均列全合法值）；authFlowMode parse 行为已有
   exec.rs 单测（大小写/别名/trim/降级）覆盖。

### 任务三：在线 pipelining/并发面

smoke 新段 `live_pipelining_section`：对**真实活连接**把 `sftp_pwd` 与
`ssh_metrics` 两个不同 id 的请求不等待响应连发 → 按到达顺序断言两响应
id 集合与请求一一对应、均无 error/isError，且 payload 与各自 id 对应
（`home` ↔ sftp_pwd、`hostname`/`cpu.cores` ↔ ssh_metrics）。第五轮
protocol robustness 的 pipelining 断言是离线合成流的 1:1，本段补齐在线
真实连接下的并发面。

### 回归

- `cargo test`：**398/398 全绿**（基线 397 → +1）。
- `cargo build --release`：**0 警告**（死代码门通过）。
- `smoke_mcp.py` 完整在线 smoke **all green**：31 工具 + 新段
  `sftp_chmod mode semantics ok` / `ssh_multi_exec mode enum ok` /
  `ssh_exec_sudo authFlowMode ok` / `live pipelining ok (2 in-flight
  requests, 1:1 id ↔ payload match)`；离线段（无 --host）同样 all green。
- `shared/mcp_schema_check.py`：**RESULT: CLEAN 维持**（HINTS 0、
  probe-not-applicable 0）。

### 剩余风险

- authFlowMode 非法值静默降级为设计豁免（§3.3 登记项），schema description
  已标注；若未来改为硬报错需同步改 description 与 smoke 断言方向。
- `live_pipelining_section` 的响应顺序断言按「到达序读两行 + id 集合匹配」
  实现，不假定响应顺序（服务器可能乱序应答）；若未来引入乱序以外的交织
  （如通知插入），readline 语义需要升级为分类读取。
- ssh_multi_exec mode 校验先于 saved-connection 解析属现状实现顺序；若
  调整为连接门先行（§3.7 顺序张力同款），该三例断言需迁移到真连接语境。

## 第八轮（2026-09-14）终验：离线段全量 + MCP 后性能基线

MCP 专项收口轮（本插件源码本轮只读；在线段全量回归已由另一轮次完成，
本节不重复）。两项工作：离线段终验 + 采集 MCP 专项七轮改动后的性能基线。

### 离线段终验

`python3 scripts/smoke_mcp.py --binary backend/target/release/dbx-plugin-ssh`
（无 --host，live section 按设计跳过）→ **all green**：initialize
（io.dbx.ssh 0.4.67）+ 31 工具 schema、参数校验序、tools/call 回环、
Quick Sudo profiles、transfer 本地校验、destructive/read-only/permission
三重门、桥接退化矩阵（stub 转发 + 死桥 fail-closed）、agentic 工作流环、
LLM 输入容忍、协议鲁棒性（坏 JSON/UTF-8/8MiB/pipelining/空行 CRLF）、
stdio 行上限——与第七轮离线结论一致，无回归。

### 性能基线（`scripts/perf_baseline_test.py`，release，真机容器，50 MiB，同日两跑）

| 项 | 第 1 跑 | 第 2 跑 | 历史 §3 基线 |
|---|---|---|---|
| terminal PTY stream（5 MiB） | 80.3 MiB/s | 80.1 MiB/s | —（新口径） |
| terminal replay | 652 帧 | 589 帧 | cap 2 MiB、complete=false 维持 |
| sftp upload（spool） | 426.2 MB/s | 571.4 MB/s | 633.9–1078 MB/s |
| sftp upload（network） | 168.6 MB/s | 180.8 MB/s | 220–237 MB/s |
| sftp download | 152.3 MB/s | 159.6 MB/s | 113–118 MB/s |

对比结论：download 两跑均**高于**历史区间约 30%+；upload network 低于
历史约 22–25% 但同数量级，且两跑间 spool 波动（426→571）印证采集时本机
存在并行 cargo 构建负载——**判定无数量级回退、无代码回退嫌疑**；以本轮
两跑区间作为 MCP 专项改动后的首个基线存档（下次巡检建议空载复采）。

## 工作台空白回归修复：沙箱 iframe 内 localStorage 访问（2026-09-14，0.4.69）

### 现象与定位

0.4.63 起（WebGL 批次）真机 DBX 打开任意 SSH 连接：工作台区域完全空白、
无报错、sidecar 收不到任何请求（连接/挑战/PTY 全链路静止）。LDAP/Kafka/
Files 三插件工作台同宿主下均正常。

排查排除了：包完整性（checksums 一致）、sidecar 双通道（smoke_mcp +
smoke_test 对安装二进制全绿）、宿主桥契约（逐方法比对 pluginHostBridge
注入形状）、WebGL 渲染器本身（Playwright Chromium/WebKit 双引擎探针均
正常渲染）。最终以隔离 e2e 复现（vagrant 标签激活但内容区空白）+ 宿主
`PluginWorkbenchHost.vue` 源码定位根因：

**根因**：工作台 iframe 为 `srcdoc + sandbox="allow-scripts"`（无
allow-same-origin）→ opaque origin 下「访问 `window.localStorage`
属性」即抛 SecurityError。0.4.63 新增的 `loadWebglEnabled()` 把
`window.localStorage` 写在**默认参数位**（`= window.localStorage`），
默认参数在函数体 try 之外求值 → App.vue setup 期 `ref(loadWebglEnabled())`
立即触发 → Vue 挂载失败 → 整个工作台空白且错误不可见（iframe console
用户不可达）。此前所有 mock/dev 探针均运行在正常 origin，故全绿未拦截。

### 修复（0.4.69）

- `terminalWebgl.ts`：存储访问移入函数体 try 内（`defaultStorage()`
  惰性求值），`loadWebglEnabled`/`persistWebglEnabled` 在沙箱/opaque
  origin/隐私模式下安全降级（读不到偏好按默认开启，写失败仅失记忆）。
- 单测新增沙箱回归用例（`vi.stubGlobal` 模拟访问即抛的 localStorage，
  无参调用路径），修复前红/修复后绿，8/8 通过。
- `Cargo.toml` 版本同步 0.4.69（sidecar 经 `CARGO_PKG_VERSION` 自报身份，
  与 manifest 不一致会触发宿主 identity 校验失败——本轮在 e2e 实测到该
  防护生效）。

### 验证

- 前端三件套（typecheck/test/build）全绿；smoke_mcp/smoke_test 不受影响
  （本轮未动 sidecar 协议面）。
- 隔离 e2e（shared/host-e2e + 0.4.69）：工作台由空白恢复完整渲染（会话
  pill、工具栏、七语降级提示、重新连接按钮均正常），SFTP list/diskUsage
  正常，桥握手正常。
- 附带确认（既有设计，登记观察）：非 MCP 模式 `auto_trust=false`，未信
  主机首连依赖工作台 UI 呈现指纹挑战；known_hosts 当前仅 1 台受信主机，
  其余主机首连会弹出挑战对话框（UI 恢复后该流程重新可用）。

## tssh 对标收尾：自动交互 Expect + 外部密码管理器（0.4.74，2026-09-15）

> 分支 `feat/ssh-trigger-auth`（worktree `.worktrees/feat-ssh-trigger-auth`，
> 对标参照 [trzsz-ssh](https://github.com/trzsz/trzsz-ssh)）。并发双工作包
> （文件所有权不相交：包 A 后端 Rust + 协议文档，包 B manifest/前端/scripts）
> + 主会话集中收口。契约文档 `IMPL_PLAN_SSH_TRIGGER_AUTHPROVIDER.zh-CN.md`
> （决策 D1–D9）为双包唯一依据。至此 FEATURE_PARITY「tssh 对标补充」表全部
> 条目收敛（除 2026-09-07 用户决策否掉的转发类/mosh 等之外）。

**特性 A：自动交互 Expect（终端触发器，包 A + 包 B）**。连接配置 `triggers`
（有序阶段规则，对齐 tssh `ExpectPattern1..N`）：sidecar 终端读循环内新增
`TriggerEngine`（`triggers.rs`，注册在 `TerminalAutoSudo` 之前、同 chunk
互斥防双答），PTY 输出归一化后进 ≤8 KiB 滚动缓冲按序匹配正则，命中按
`sendText`（明文，`\r`/`\n`/`\t` 转义、`\|` 分段停顿 `sleepMs`）/
`sendSecretKey`（宿主 secret binding 槽位 `trigger_answer_1/2`，对齐
`ExpectSendPass`，替代其 `--enc-secret` 自有加密）/
`sendCommand`（本地 shell 执行取 stdout，对齐 `ExpectSendOtp`，10s 超时 +
zeroize）三选一回发；`casePattern` 预匹配（对齐 `ExpectCase*`，不推进游标）、
`passSleep`（none/each/enter）、阶段超时、shell 提示复位、末阶段回卷。
命中发 `ssh/trigger {sessionId, stage, kind}` 事件（永不携带应答内容），
工作台 toast 提示（七语）。**收口裁决**：超时只在序列中途生效（已命中前序
阶段、在等第 2..N 阶段）——包 A 初版在空闲等 stage 1 时也按 `timeoutSecs`
周期性发 timeout 事件，闲置会话会刷 toast，主会话改为游标为 0 不设超时
（事件驱动的无限期等待），并补回归用例。

**特性 B：外部密码管理器（包 A）**。`password_command` /
`passphrase_command`（对齐 tssh 同名配置）：登录密码 / 私钥口令缺失时本地
执行命令取回（占位符 `%h %u %p %n %%`，`sh -c` / `cmd /C`，10s 超时，
输出 4 KiB 上限、用后 zeroize），优先级显式凭据 > 命令；解析点在拨号认证
orchestration 构建前一次执行，密码链与 sudo 编排共用。配置了
`password_command` 时密码类认证允许不存密码。

**契约面**：external_config 新键 `triggers` / `password_command` /
`passphrase_command`；connection_secrets 新键 `trigger_answer_1/2`；MCP 内联
拨号新参数 `triggers`（JSON 字符串）/ `passwordCommand` / `passphraseCommand`；
manifest 新增 5 个表单字段（triggers textarea + 两个密文槽 password +
两个命令 text，七语齐全，含恶意服务器伪提示与本地命令执行面风险声明）。
校验失败一律连接报错不静默降级（对齐 set_env 先例）。新增依赖 `regex = "1"`
（后端首个正则依赖，lockfile path patch 已验证保留）。

### 验证

- 包 A：cargo fmt/clippy 零告警，cargo test 434 通过（+27 triggers 单测、
  +1 model lifecycle 集成、+1 收口超时回归），release 构建就绪。
- 包 B：pnpm test 402 通过、typecheck 零错误、connection-forms verify 95
  场景通过、smoke 脚本 py_compile 通过且缺容器门控实测 SKIP。
- 主会话收口：scripts/test.sh 全套 + 打包安装 + 双冒烟（结果见提交信息/下节）。
- 合并注意：主检出区另有未提交的私钥录入改动（15 文件，key/model/mcp/
  manifest/App.vue/i18n 均重叠），两分支合并顺序由用户决定，冲突面局部。

## 官方 docker 镜像 sidecar 启动即退（glibc 基线）修复（2026-09-18）

**故障**：issue #8/#58——官方 DBX web docker 镜像（debian:bookworm-slim，
glibc 2.36）安装插件后，新建 SSH 连接报
`Plugin 'io.dbx.ssh' initialization failed: exited with status 1`；
amd64 与 arm64 均有报告。

**根因**（容器内复现实证）：发布候选在 `ubuntu-24.04`/`ubuntu-24.04-arm`
（glibc 2.39）原生构建，linux sidecar 钉死 `GLIBC_2.38`（`__isoc23_sscanf`）
与 `GLIBC_2.39`（`pidfd_spawnp`/`pidfd_getpid`），bookworm 动态加载器在
`main()` 前失败 → exit 1。把 v0.4.77 linux-arm64 产物放进 bookworm-slim
逐字复现 loader 报错与 exit=1；同一二进制在 ubuntu:24.04 正常启动。

**修复**（跨插件统一，改动在上层仓）：

- `build-candidates.yml` Linux runner：pip ziglang + cargo-zigbuild，
  PATH 最前置 `cargo` 包装器把 CLI 裸调的 `cargo build` 转成
  `cargo zigbuild --target <宿主triple>`（zig 链接低 glibc 基线，实测
  2.30，仍为 runner 原生架构非伪装 target），并把产物从 `<triple>/release/`
  镜像回 CLI 拷贝期待的 `<CARGO_TARGET_DIR>/release/`。**坑**：zigbuild
  不带 `--target` 会退回宿主工具链（首轮端到端实测 CLI 打包产物钉
  bookworm 级 2.34 而非 2.30，在 24.04 runner 上等于没修），必须显式传。
  另导出 `CGO_ENABLED=0` 让 ldap/kafka 的 CLI 内部 `go build` 静态链接
  （原先 cgo 构建钉 GLIBC_2.34+，bookworm 恰好够用属侥幸，与 deploy/web
  打包方式对齐）。
- ssh/files `scripts/build.sh`：`~/.cargo/bin` PATH 前置改条件式，
  防止把 CI 包装器压回（否则 Linux 静默回到原生 glibc 构建）。
- `shared/release/validate_artifact_set.py` 新增 Linux ELF 守卫：解包
  candidate 校验最高 GLIBC 符号版本 ≤ 2.31（坏包实测被拦，zigbuild 产物
  2.30 放行，Go 静态产物无版本要求直通）。
- 文档：`docs/CI_MULTI_PLATFORM.{zh-CN,en}.md` 增「Linux glibc 基线」节。

**验证**：本地 cargo zigbuild 交叉重建 sidecar（aarch64-linux-gnu），
最高版本 2.30；bookworm-slim 容器运行正常进入 stdio 主循环（EOF exit 0）；
守卫脚本四向测试（坏 ssh 包拦 / 坏 files 包拦 / zigbuild 产物过 /
kafka 现网动态包按预期拦——修复后 CI 重建即静态）。CI 模拟容器
（rust:1-bookworm + 同款 wrapper + 官方 CLI 0.1.3 打包）产出 linux dbxp
端到端复验。桌面 macOS/Windows 产物不受影响，无需重发。

## 用户级端口映射 -L/-R（2026-09-22）

**决策翻转**：FEATURE_PARITY 原 2026-09-07「端口转发 ❌ 不做」的三个理由（宿主无
-R、无面向用户的转发会话 UI、无通用转发接口）恰为本次补齐的缺口，用户决策翻
转立项；`-D` 动态转发维持不做（宿主 dbx-core 已内置数据库代拨动态隧道）。

**sidecar**（`backend/src/forward.rs` 新模块 + ssh.rs 接线）：
- `ssh/forward/list|start|stop`：list 按 connectionId/sessionId 过滤；start
  校验（targetHost 必填、端口 0-65535、listenHost 缺省回环）后 local 先绑端口
  再标 active、remote 先 `tcpip-forward`（拒绝即移除行并报错，`listenPort: 0`
  服务端挑选）；stop 全量 abort（含已建立 relay）+ `cancel-tcpip-forward`，
  未知 id 报错。状态迁移广播 `ssh/forward/state`。
- local 转发：TcpListener accept → 每连接 `channel_open_direct_tcpip` →
  `copy_bidirectional`，连接数/字节计数同源一行。
- remote 转发：SshClient 新增 `server_channel_open_forwarded_tcpip` handler，
  按每连接转发表（`(listen_host, bound_port) → target`，归一化 + 通配端口回
  退）在客户端机器拨目标，relay 计数落同一行。表随连接 dial 创建、随连接末
  会话关闭回收。
- 会话关闭先 `stop_session_forwards`（此时 SSH 句柄仍可解析，远端监听可撤
  销）再摘会话；映射为运行时状态不落盘。
- 单测 9 例（spec 解析/校验/方向文案/远端表匹配），纯逻辑不连 SSH。

**工作台**（组件拆分，App.vue 只留入口）：`components/PortForwardDialog.vue`
自持状态、RPC、`ssh/forward/state` 订阅（App.vue 零改动，错误经 `@error` 走
`showError(…, "terminal")`）；纯逻辑在 `lib/portForward.ts`（解析/表单校验/
路由文案/字节格式化，9 例 vitest）；七语文案 `forwards.*` 全补；mockDbxHost
注册 `ssh/forward/*`（0 端口 mock 随机挑选 + active 事件）供 fixture 验证。

**验证**：`cargo fmt --check`/`clippy -D warnings`/`cargo test` 540 全绿；
`vue-tsc` 0 错；`vitest` 61 文件 519 用例全绿；`pnpm build` 过；
`scripts/smoke_forward_test.py` 对测试容器（AllowTcpForwarding yes）双冒烟：
-L 隧道读 SSH banner、-R 经 busybox nc 回环 payload、stop/未知 id/会话关闭
清理。

**剩余风险**：真机（DBX 桌面宿主）面板验收未跑；remote 转发的服务端
forwarded-tcpip 回报地址形态依赖 OpenSSH 行为（已做归一化 + 端口回退，非
OpenSSH 服务端未验证）；`-D`/映射持久化（跨会话记忆表单）明确 deferred。

### 输入校验、冲突预检与网卡地址探测（2026-09-22 补强）

- **主机语法**：sidecar `normalize_host` 升级为 IPv4/IPv6（`[...]` 括号剥
  除）/主机名标签三态校验（std IpAddr 解析为权威），拒绝嵌入式端口/
  scheme/伪 IP（`999.1.1.1`）；local 映射拒绝 `*` 通配（bind 不了）。前
  端 `isValidHost` 同规则 JS 版（v6 借 URL 解析器校验），表单内联提示。
- **冲突预检**：`listen_endpoints_conflict`（同方向 + 同显式端口 + 主机相
  同或任一侧通配）在 bind/`tcpip-forward` 前拦截——local 查全局注册表
  （同一台客户机）、remote 查同连接（同一台服务器）；工作台同规则客户端
  预检并内联提示 `监听端点 {route} 已有映射（{existing}）`。
- **网卡探测**：新增依赖 `if-addrs 0.15`（getifaddrs 纯 FFI 封装，无传递
  依赖——用户明确要求网卡 IP 选择），sidecar `ssh/forward/interfaces` 返
  回 `{name, addr, isLoopback}`（回环优先→v4→v6，按 IP 去重），面板监听
  地址旁下拉可选（含 0.0.0.0「所有接口」项），探测失败静默降级为手输。
- **验证**：sidecar 单测 13 例、vitest 524 例全绿；容器 smoke 新增冲突
  （重复 + 通配）与探测（回环存在）用例全过；浏览器 fixture 验收非法主
  机提示/冲突提示/网卡选取回填三交互。

## 宿主 OS 级拖放上传接线收口 + 双注册修复（2026-09-22）

**背景**：桌面宿主在 webview 层捕获 OS 拖放（HTML5 drop 事件到不了沙箱
iframe），fileTransfer 桥（宿主 1.1 optional）的 `onDrop`/`onDragState`
事件已在上游宿主合入。插件侧 1cb3e48/1bc3dfe 已接
`registerHostFileTransferBridge`：`planHostFileDrop` 按面板状态分流——
SFTP 面板打开→当前目录直传；solo 终端→复用 `terminalDropPrompt` 落点
询问（接受 handle metas）；只读/无文件/传输中→忽略；旧宿主桥没有拖拽
监听时 optional-chaining 降级，不再炸 initialize。

**修复**：`initialize()` 内残留的第二套 `api.fileTransfer?.onDragState/
onDrop` 直传注册（e2018a6，早于宿主事件可用时的假设实现）未随新接线
移除——同一 fileTransfer 桥上双处理器并存，真机一次拖放会触发两次上传
（旧处理器无视面板状态直传当前目录、绕过落点询问）；且 `mockDbxHost`
的 `onDrop` 为 no-op，fixture 与单测都无法暴露，只有真机会撞上。移除旧
注册及其 `unsubscribeFileDrag`/`unsubscribeFileDrop` 变量与卸载清理；
`dragActive` 复位并入 `handleHostFileDrop`（对齐 HTML5 `onDrop` 惯例）。
现 onDragState/onDrop 全仓仅 `registerHostFileTransferBridge` 一处注册。

**验证**：`vue-tsc` 0 错；`vitest run` 60 文件 510 用例全绿；`pnpm build`
过（ui/index.html 重产，含拖放接线与 #33/#71 诊断样式）；`cargo fmt
--check` / `clippy -D warnings` / `cargo test` 533 全绿（含工作区未提交
的 #33/#71 埋点）。

**剩余风险**：真机拖放验收未跑（上游事件已合入，待 DBX 宿主实测：分屏
直传 / solo 落点询问 / 只读忽略 / 多文件与大文件 / 悬停 overlay 两种
面板模式）；`ui/index.html` 为 integrator 所有，留待打包时随工作区一并
处理；宿主对同一 handleId 被并发 read 的语义未验证（修复后插件侧已回
单消费者，风险仅存于修复前的安装版本）。

> **合并注记（nyaterm-parity-integration）**：与 main 0.6.0 的拖放门禁工作
> （drop-gate-consistency）融合后，注册点收敛为 `initialize()` 内的一处
> `unsubscribeFileDrag`/`unsubscribeFileDrop`，onDrop 统一走融合版
> `handleHostFileDrop`：`canAcceptFileDrop` 门禁 → `planHostFileDrop` 落点
> 分流（含 targetDir）→ 桥故障回退原生选择器；`registerHostFileTransferBridge`
> 注册器已随之移除，上节「仅一处注册」的表述以本注记为准。

## M1 nyaterm-parity 波次（2026-09-23）

对齐 docs/IMPL_PLAN_NYATERM_PARITY.zh-CN.md（v2）P1 五任务、DEV_PLAN W1 三 agent 并行拓扑落地：

- **并行执行**：`parity-gpu`（9a/9b GPU+NPU）、`parity-actions-gutter`（8b+8c）、`parity-suggest-transfer`（8a+10b）三 worktree 并行 TDD；热点治理按计划生效（App.vue 接线点错峰，merge 仅 3 文件冲突且全为两侧追加型）。
- **集成修复**：i18n.ts 追加块丢 for 循环闭合、preferences.rs keep-both 结构损伤——最终以「C 版为底 + B 版片段函数级插入」重建（cargo 595 全绿）；GPU 卡片窄卡显存折行/`NPUCANN` 徽标粘连/CANN 徽标右对齐三处 UI 打磨。
- **mock 夹具**：mockDbxHost 的 `ssh/metrics` 补 `gpu`/`npu` sections（双 A100 + 910B4/310P3 + 计算进程），供监控卡片视觉验证。
- **验证**：cargo 595 / vitest 792 / vue-tsc 0 / build 过；e2e 七场景截图（连接、设置区、双列 gutter、建议浮层、Downloads 传输设置、GPU/NPU 卡片、动作链接下划线）经 visual-judge 终审 7/7 pass；详见 TEST_MATRIX「M1」节。
- **遗留**：GPU/NPU 真机冒烟（需有卡主机）、Windows ConPTY gutter、DBX 桌面宿主手测（M1 里程碑 PR 前人工）。


## M2 W2a（2026-09-23）

- 三 agent 并行：`parity-otp`（OTP 库，625→修复接线后 625）、`parity-import`（617）、`parity-telnet`（611）。
- 集成修复：ssh.rs 自动应答调用点对齐 `take_connection_totp_key(data_dir,…)`；main.rs 补齐 otp/* 七个协议方法（agent 超时中断在注册前）；clippy dead_code/复杂类型三处整理。
- telnet 分支因 Cargo.lock 冲突 break 漏 merge，补并（无冲突）。
- 全量：cargo **663** / vitest **792** / vue-tsc 0 / build 过（ui/ 含 Telnet 入口重生成）；Telnet 入口 e2e（确认对话框）验证。
- 依赖评审：rqrr 0.9、image 0.25（png/jpeg/bmp/webp 裁剪）、zip 2、encoding_rs 0.8、sha3 0.10、cbc 0.9、aes 0.8、pbkdf2 0.12——均为 MIT/Apache 双许可主流 crate（以 docs.rs 为准），用途见 CHANGELOG；notify 0.6 由 W2b 引入，待其 PR 一并评审。


## M2 W2b 进度（cron 看护中，2026-09-23）

- **docker（P2-4）✅ 完成**：agent 全栈交付（docker.rs 676 行 + MCP docker_list/docker_action + DockerPanel.vue + SideNavPanel tab），只读门/审计/Quick Sudo 回退全接入；`docker/list|logs|action` + 白名单 + id hex 门；"在终端打开"为剪贴板降级（App.vue 禁改约束），升级点记遗留。集成零冲突，ui/ 重生成。
- watcher（P2-5/6）进行中：file_watch.rs 已落盘，notify 接入。
- feel（P2-7/8/9）进行中：大输出保护 gate（b197767）、右键在线搜索（a1bd975）已 commit，背景图进行中。
- panels（P2-1/2 前端）进行中。
- W2b 全部合入后统一跑 e2e UI 审查与 push。

- **feel（P2-7/8/9）✅ 完成**：大输出保护背压 gate（128KiB 触发/64KiB 恢复/32KiB 分帧 + 扫描挂起 + 七语提示）、终端右键菜单 + 选中文本在线搜索（引擎可配，openExternal 缺失降级复制链接）、背景图（local/wallpaper/* + 魔数校验 + WebGL 挂起强制 DOM 渲染 + 透明化）。三增量 commit（b197767/a1bd975/6c04daf），817 前端 + 649 后端全绿。已集成（bf91fb5，零冲突）。
- W2b 剩余：watcher（P2-5/6）、panels（P2-1/2 前端）进行中；两者合入后跑 e2e UI 审查并收口 M2。

- **panels（P2-1/2 前端）✅ 完成**：OtpPanel（验证码倒计时/扫码导入/绑定管理/发送到终端）+ ImportWizard（三步向导/脱敏预览/主密码处理），827→852 前端全绿。SideNavPanel 冲突为机制性（docker 与 panels 各建额外 tab 状态机）——融合为统一 extraTab（"otp"|"import"|"docker"），App.vue 持久化契约不变。已集成（2e3b018）。
- W2b 仅剩 watcher（P2-5/6）进行中；合入后 e2e UI 审查收口 M2。


## M2 收口（2026-09-24）

- **W2b 全部合入**：docker（6cccd71）/ watcher backend（7b3cdde）/ panels（2e3b018）/ feel（bf91fb5）。
- **集成修复**：watcher 测试 helper 共享本地文件导致 dedup 互顶（多文件变体修复）；`fingerprint_detects_content_change` 同毫秒同长度写入误判 Same（fixture 改长度差异）；SideNavPanel 机制性冲突统一为 extraTab（"otp"|"import"|"docker"），App.vue 持久化契约不变；watcher main.rs 冲突两侧保留（telnet+watcher runtime 共存）。
- **e2e UI**：Docker/OTP/Import 三面板截图（五 tab 导航、空态、三步向导、来源卡、本地存储注记），visual-judge **3/3 pass 可交付**。
- **全量**：backend cargo **690** / clippy 0 / fmt 干净；frontend vitest **852** / vue-tsc 0 / build 过（ui/ 重生成）。

### M3 遗留清单（需人工决策或后续轮次）

1. **watcher/symlink 全栈 ✅ 完成（M3 轮，739301e）**：watcher agent 实际完成了全部五段增量——自死锁修复（dedup guard 跨 await 取写锁，agent 独立定位）、symlink 三命令（russh-sftp 原生 symlink/readlink，**wire 序 (linkpath,targetpath) 与 OpenSSH (target,linkpath) 反转已在对齐处交换参数**）、`watch/upload` 回传通道（remote-edit 路径读字节 → ensure_writable → 64MiB 上限 → .dbx-part 原子提交）、前端全量接线（右键"在外部编辑器打开"、file-modified 三选确认、symlink 对话框、tooltip）。遗留：单文件 MVP（多文件并行编辑需排队扩展）、FSEvents/inotify 真机联调、外部编辑器全链路真机手测。
2. X11 转发 spike ✅ 完成（docs/SPIKE_X11_FORWARDING.zh-CN.md）：russh 0.62 三能力全部可行（request_x11 公开 API / server_channel_open_x11 回调需显式 gate / direct-tcpip 兜底受 X server 监听限制），推荐路线 channel_open_session→request_x11→回调校验→DISPLAY 桥接，估算 4.5-6.5 人日——**建议进 M4，排核心 parity 之后**（人工排期决策项）。
3. 串口（serialport 依赖评审）、VNC（vnc 引擎选型+帧通道压测）——依赖评审通过后派发。
4. RDP：vendored fork 链维护计划 + CredSSP 安全评审清单——人工评审门，未派发。
5. 真机验收：GPU/NPU（nvidia-smi/npu-smi 主机）、Docker 主机、Windows ConPTY gutter、DBX 桌面端到端——人工项。
6. Docker 面板"在终端打开"升级为事件直填输入行（需 App.vue 通道开放）。


## M4 轮排期（2026-09-24，用户指令"继续排期，持续跑"）

- 已派发（后台并发，worktree np4-x11 / np4-serial，分支 parity-x11 / parity-serial）：
  1. **X11 转发实现**：按 spike 报告路线（request_x11 + server_channel_open_x11 显式 gate + DISPLAY unix/TCP 桥接 + 假 MIT-MAGIC-COOKIE 校验）；偏好键 `x11_forwarding`（默认关，read_only 禁用）；零新增依赖。
  2. **串口会话**：serialport 4（依赖评审：MIT/Apache 双许可）+ `serial_session.rs`（仿 telnet 先例：ports/start/write/close/list）+ SerialConnectDialog 前端入口；若 Linux CI 需 libudev-dev 允许改 workflow 一处。
- 维持人工门：VNC（引擎选型+帧通道压测）、RDP（vendored fork 链+CredSSP 评审）、真机验收、PR 合入。
- 执行备注：首轮两 agent 因 API 网络瞬断（TLS 连接断开）失败且无产出丢失（worktree 仍在基线），已原样重试派发；cron 看护继续。
- M4 完成判据：两分支合入 integration、全量验证绿（基线 cargo 696 / vitest 861 只增不减）、e2e 回归、push 后 CI 十一门 success。


## M4 进度（2026-09-24）

- **X11 转发 ✅ 全栈完成并已合入（75c5219）**：x11.rs 残留兑现（DISPLAY 解析 7 形态/假 cookie/Xsetup 检查/.Xauthority/准入门，12 测试）+ ssh.rs 接线（request_x11 于 PTY/env 后发送；`server_channel_open_x11` 显式 fail-closed gate——russh 默认 accept 的安全边界）+ `x11_forwarding` 偏好（启动/读写三处同步快速标志）+ SettingsDialog 开关（组件内自治 RPC）+ 七语文案。真机 X server 联调记遗留。
- **串口 backend ✅**（parity-serial 分支）：serialport 4（MIT/Apache）+ serial_session.rs（ports/start/write/close/list + Backspace 映射 + 读线程→帧通道）+ 协议注册。前端入口（SerialConnectDialog + App.vue 接线）派 np4-serial 重试 agent 补齐。
- 执行备注：M4 首两轮后台 agent 因 API 网络瞬断失败（无产出丢失），已原样重试；X11 改由主会话直接完成。


## M4 收口（2026-09-24）

- **X11 转发 ✅ 全栈合入**（75c5219 + 6e46fec/42bb29f platform-gate）：russh UnixStream 仅 unix 平台——bridge_channel 按 cfg(unix/windows) 拆分，Windows 侧 unix-socket 形态报可读错误指路 VcXsrv TCP；fmt 修复后 CI 全绿。
- **串口会话 ✅ 全栈合入**（cbf6fa2）：backend（parity-serial 7b3cdde…20d0edf，含 serialport 4 依赖）+ 前端 SerialConnectDialog/App.vue 接线（serial/* JSON 写通道 MVP 取舍 + localUiMode 互斥 + 顺手修复 Telnet 会话被连接卡片遮挡的一行缺陷）。
- **执行波折**：M4 首两轮后台 agent 因 API 网络瞬断失败；X11 改由主会话直接实现（兑现 x11.rs 残留）；串口前端第三轮 agent 成功。
- **全量**：backend cargo **696**（含 x11 12 + serial 参数/生命周期测试）/ clippy 0 / fmt 干净；frontend vitest **861** / vue-tsc 0 / build 过。

- **CI 收口 ✅**：libudev-dev 已入 workflow 三处 apt 步骤（serialport Linux 后端），run 35933731782 全绿——M4 全量 CI 收口完成。

### M4 遗留（人工门）

1. 真机：X server（XQuartz/VcXsrv）联调、串口硬件联调、GPU/NPU 主机、Windows ConPTY、DBX 桌面端到端。
2. VNC（引擎选型+压测）、RDP（vendored fork+CredSSP 评审）——维持人工评审门。
3. 串口 MVP 已知限制：JSON 写通道、无 replay/resize、ports 列表 USB 后缀需手输剥离。

## M5 轮排期（2026-09-24，用户指令"直接进入M5"）

- 已派发（后台并发，worktree np5-vnc / np5-docker-term，分支 parity-vnc / parity-docker-term）：
  1. **VNC 会话**（差距项 2d）：spike 先行（上游 HsuJv/vnc-rs 0.6.0 async client 尽调：API 面/许可证/有界分配审查，对比 NyaTerm 0.5.3 加固 fork），可行即 MVP——None/VNC-Auth（密码 ≤8 字节提示）、Raw/ZRLE 优先、44 字节 patch 帧走现有二进制通道、前端画布复用 remote-desktop 渲染层思路、断线 generation 重连；vnc/ 前缀协议 + "New VNC session" 入口（localUiMode 互斥）。Tight JPEG 显式报错不实现（范围裁剪）。依赖评审随 PR。
  2. **Docker"在终端打开"升级**（M3 遗留 6）：命令经 App.vue 内部通道直填输入行（复用 M1 动作链接的 fill 通道），替代"经 sendTerminalBytes 直写 PTY"；顺带补 Docker 面板 e2e 截图。
- 维持人工门：RDP（vendored fork+CredSSP 评审）、真机验收、PR 合入。
- M5 完成判据：两分支合入 integration、全量绿（cargo ≥696 / vitest ≥861 只增不减）、e2e、push 后 CI 十一门 success。


## M5 收口（2026-09-24）

- **VNC 会话 ✅ 全栈合入**（backend c7d745c + frontend dc4ba51）：vnc-rs 0.6（HsuJv，MIT OR Apache-2.0，依赖评审随 PR）+ vnc_session.rs（None/VNC-Auth，密码 >8 字节在 start 即拒绝；ZRLE+Raw+DesktopSize，Tight/JPEG 矩形显式失败；帧缓冲 3840×2160、patch ≤64MiB、剪贴板 Latin-1 ≤1MiB 三重上界；generation 断线重连，认证/协议错误不重试）。协议 `vnc/start|input|resize|reconnect|set-clipboard|close|list`，44 字节 patch 帧走 `vnc/frame/{id}` 二进制通道；前端 VncConnectDialog + VncSurface 画布（localUiMode 互斥、"仅受信网络"提示、七语文案）。
- **Docker"在终端打开"✅**（3da01f5）：命令经 App.vue fill 通道直填输入行（替代 sendTerminalBytes 直写 PTY），Docker 面板 e2e 截图补齐。
- **X11 spike 示例收尾 ✅**（a862bdf，merge da1dda3）：x11_spike.rs 纯编译验证示例入库（文件头注明永不接入插件；check_server_key 放行仅限 spike 本体），fmt/clippy/test 全绿。
- **集成修复**：dc4ba51 提交的 App.vue 带两处未解决冲突标记（上轮 frontend 门未含 vue-tsc，漏过）——9302f1f 取 VNC 侧并去掉与 panels 侧重复的 panelSurface 定义（保留既有 558 行），terminal-overlay 条件合并 `!panelSurface` + `!isVncMode`；ui/ 随修复重生成（84d5e56）。
- **全量**：backend cargo **719**（M4 基线 696，只增不减；vnc_session 新增 11）/ clippy `-D warnings` 0 / fmt 干净；frontend vitest **874**（基线 861，只增不减；vncFrame 帧编解码 9）/ vue-tsc 0 / build 过。

### M5 遗留（人工门）

1. 真机：VNC server（None/VNC-Auth）画面/输入/剪贴板联调、X server（XQuartz/VcXsrv）转发联调、串口硬件、GPU/NPU 主机、Windows ConPTY、DBX 桌面端到端。
2. RDP（vendored fork 链 + CredSSP 评审）——维持人工评审门，未派发。
3. VNC MVP 已知限制：Tight/JPEG 不支持（显式报错）；VNC-Auth 仅 ≤8 字节密码；剪贴板 Latin-1。

### 前端持久化迁移 host.storage（2026-09-24）

- **背景**：工作台 iframe 是 sandbox="allow-scripts"（opaque origin），
  localStorage 访问即抛 SecurityError——所有前端 UI 偏好键在真机上全部
  静默失效（偏好只活到当前会话结束）。宿主 Host API 1.2 起提供
  window.dbxPlugin.storage（get/set/delete，能力位 capabilities.storage，
  manifest 需声明 host.storage 权限），桌面端落 plugin-data/<id>/
  ui-storage.json。迁移走 shared/frontend/pluginStorage 适配器（与 files
  插件同一公共层），通道降级：宿主桥 storage → guarded localStorage
  （web 直连/dev/老宿主）→ 内存（仅当前会话）；读全部同步（启动水合 +
  写穿缓存），调用点保持 getItem/setItem/removeItem 语义，零 async 改造；
  宿主档水合时对 localStorage 旧值做一次性惰性搬家。
- **改动**：新增 `frontend/src/lib/pluginStore.ts`（键集合声明 + store
  单例）；App.vue 全部迁键调用点 `window.localStorage.*` →
  `pluginStore.*`（键名不变）；`lib/terminalWebgl.ts`/`lib/terminalFont.ts`
  的 `defaultStorage()` 与 `lib/terminalInteraction.ts` 的
  `persistSearchOptions` 默认存储改走 pluginStore（显式注入 storage 仍为
  测试口）；`main.ts` 挂载前 `await pluginStore.ready`；`env.d.ts` 内联
  capabilities/storage 声明；mockDbxHost 补 storage mock + 
  capabilities.storage（镜像真实桥：get 未命中 null、set(undefined)→null、
  内存 Map），`?render=dom` 的 webgl 种子改写 pluginStore 实例（直写
  localStorage 会被水合时序吃掉）；manifest permissions 增加
  "host.storage"（版本号未动）。
- **迁移键清单**（12 个，进 pluginStore）：`sftp-path-history`、
  `ssh-command-history`、`ssh-sftp-pane-open`、`ssh-sftp-side-tab`、
  `ssh-sftp-side-collapsed`、`ssh-terminal-select-copy`、
  `ssh-keyword-highlight`、`ssh-batch-bar-open`、
  `ssh-terminal-search-options`、`ssh-terminal-webgl`、
  `ssh-terminal-font-size`、`ssh-terminal-font-family`。
- **不迁键清单**（保持直读 localStorage 原样）：
  - `ssh-download-directory` / `ssh-download-use-default-dir` /
    `ssh-download-conflict-policy`：权威在 sidecar preferences.json
    （`local/preferences/*`），localStorage 仅作 web 浏览器直连场景的
    同步缓存（App.vue cachePrefs/hydratePrefs），迁走反而出现双权威。
  - `ssh-quick-commands`：已迁 sidecar 全局存储，localStorage 旧键仅作
    一次性迁移种子（loadQuickCommands/hydrateQuickCommands），残留键
    保持原样不动（web 缓存/死键语义不变）。
- **spec 修复**：TerminalSearchPanel.spec.ts 的播种/断言从全局
  localStorage 改走 pluginStore 实例（happy-dom 下 store 模块导入时即
  完成水合，之后直改 localStorage 读不到缓存值）；新增
  `lib/pluginStorage.spec.ts` 薄 spec（锁定迁键清单 + 排除 sidecar 类
  键、node 环境 channel==="memory"、注入桥水合/写穿回路）。
- **验证**：`vue-tsc --noEmit` 0 错；`vitest run` 65 文件 569 用例全绿。
- **回归面提示**：真机（DBX 桌面宿主 opaque origin）需复验偏好读写——
  首装迁移（localStorage 旧值搬家）、面板/侧栏/字体/WebGL/高亮/命令条
  开关跨重启保持、web 直连与 dev fixture（?render=dom、mock=1 形态）
  行为不回归；老宿主（Host API < 1.2）自动降级 guarded localStorage，
  行为等同迁移前。

- **mock 兜底语义修正（收尾统一改动）**：storage mock 初版为纯内存 Map，
  页面刷新即丢，背离真实宿主（web 宿主由顶层 localStorage 兜底、桌面端落
  `plugin-data/<id>/ui-storage.json`）——ldap ui_test walkthrough 的
  「expanding the compact bar … persists」用例即因此失败（用例 109 行裸
  localStorage 断言，且 walkthrough 共用 page 导致后续 builder 用例连坐，
  一度 30/35）。统一改为 localStorage 兜底（键名不变；字符串值原样、对象
  JSON 编码；opaque origin 不可用时退化内存），dev/`?mock=1` 恢复刷新持久化，
  walkthrough 断言无需改动；修正后 本插件 vitest 65 文件 569 用例复验全绿（?render=dom 的 webgl 种子走 pluginStore 语义不变）。

### §8.17 修复：右键粘贴在真实宿主无效果——插件视图复制副本降级链（纯前端轮，2026-09-24）

用户报告「选中复制 · 右键粘贴」开关在 DBX 真机没有效果。定位结论：功能
本体早已实现并随 0.4.88 出货（bundle 特征串可证），真机失效的根因是沙箱
iframe 的剪贴板读边界——右键粘贴走 `readClipboardText` 三级降级（宿主桥
`window.dbxPlugin.clipboard` 现网宿主不提供 + opaque origin 被
Permissions Policy 拒绝 `navigator.clipboard.readText`），读链必然断，
只会弹「请用 Ctrl+V」toast；而功能验收全在 mock/浏览器环境做（mock 宿主
补了 clipboard 桩），真机剪贴板链路从未被覆盖。

修复（纯前端，零协议改动）：

- `lib/terminalInteraction.ts`：新增 `createTerminalCopyCache`（插件视图
  内的复制副本，200k 字符尾部截断，空写入不覆盖上一次有效副本）与
  `resolveTerminalPasteText`（取文优先级：系统剪贴板 → 视图副本 → 终端
  当前选区；空白是合法候选，仅空串视为无来源）。
- App.vue：三处复制入口（选中复制 onSelectionChange、菜单/快捷键
  `copyTerminalSelection`、远端 OSC 52 写剪贴板）都写入视图副本——系统
  剪贴板写链失败也照记；`pasteTerminal` 只在「读链确认被拒」时降级到
  副本/当前选区，宿主可读剪贴板时仍以系统剪贴板为准（含空）。XShell 式
  「选中 → 右键」在沙箱宿主从此闭环；多行/危险命令仍过既有粘贴确认。
- 单测 +3（降级链优先级、空白候选语义、缓存截断/空写不清除），vitest
  全绿；typecheck/build 过（ui/index.html 同步再生成，CI 的 freshness
  门禁依赖提交产物）。

剩余风险：真机「选中 → 右键」闭环已由降级链保证，但系统剪贴板本身（跨
应用复制粘贴）仍受宿主沙箱限制——写链靠 execCommand 兜底（未在真机证
实），读链无解（Ctrl/Cmd+V 原生 paste 事件不受影响）；宿主侧若未来提供
clipboard Host API，`clipboardDeps()` 无需改动即可接管。

### §8.18 闭环：宿主剪贴板读取桥（t8y2/dbx#10155）已合并，插件声明 host.clipboard:read（2026-09-24）

宿主侧 PR #10155（Host API 1.3：`host.clipboardRead` 桥 + `window.dbxPlugin.clipboard`
命名空间 + 首次读取会话确认 + 每秒限流 + 200 条审计环 + 真实权限字符串 UI 展示）
已由维护者 t8y2 合入上游 main。

插件侧完成对接声明：
- `manifest.json`：`permissions` 增加 `host.clipboard:read`，使沙箱工作台
  在支持 Host API 1.3 的宿主上能够通过宿主桥直接读取系统剪贴板（跨应用
  复制文本后可在终端右键直接粘贴）；
- `frontend/src/env.d.ts`：`capabilities` 增加 `clipboardRead` 与
  `clipboardWrite` 可选布尔位说明；
- §8.17 引入的「插件视图复制副本」作为天然降级保留：未授权、读取被用户
  拒绝、或运行在 Host API < 1.3 的旧宿主时，右键粘贴仍能粘贴终端内复制的
  文本，实现两层保护。
- `ui/index.html` 重新生成，本地验证全绿。


## M5.5 收口（2026-09-24，main 同步 + 三会话并行线）

**三条并行线产出**（用户拆分的独立会话，不等轮次顺序）：

- **RDP 立项材料 ✅**（parity-rdp-docs 66d6552/38d86ab，merge 73520a5）：
  `docs/RDP_VENDOR_FORK_PLAN.zh-CN.md`（NyaTerm fork 链事实基线：ironrdp-client/connector/tls、picky、sspi 五 crate 补丁面 + `[patch.crates-io]` 整链同轮升级约束 + Route A/B/C 决策框架）与 `docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md`（【硬】/【条】两级清单：NTLMv2-only fail-closed、凭据委托最小化、TLS 证书策略、CVE 对齐）。**评审材料已备齐，评审执行仍是人工门**。
- **串口遗留补齐 ✅**（parity-serial-enh a8f2e71，merge a7414c7）：ports 列表端口路径与描述规范化分离（USB 后缀不再手输剥离）+ start 行参数（baud/data bits/parity/stop/flow）严格校验，纯逻辑单测；协议级 resize/replay/二进制写通道升级仅出设计稿 `docs/SERIAL_ENHANCE_DESIGN.zh-CN.md`，不动 wire 协议（人工评审项）。
- **X11 spike 示例收尾 ✅**（a862bdf，上轮已并入）：`backend/examples/x11_spike.rs` 纯编译验证示例入库。

**main 同步 ✅**（ed4e910）：自 M2 时代的 merge-base 一口气补齐 main 侧 15 个 commit——0.7.0 版本 bump、交互式 MFA + 重复会话（cb0274f/e3442e6）、手动 OTP 提示（PR #107）、host.storage 偏好持久化（e9edf33）、右键粘贴插件视图副本降级链（PR #102）、kitty/XTVERSION/DECRQM 能力探测应答（PR #109）、randomUUID shim（PR #111）、manifest host.storage / host.clipboard:read 权限声明。

**冲突解决摘要**（5 文件）：

- **ssh.rs**：取 main 侧 `open_session` 新骨架（SessionOpenRequest / transport_lease / 认证传输复用路径），注入 integration 的 X11 arming 块；clippy 暴露 main 重写覆盖掉的 TOTP 绑定回落（`sudo_auth_for` 的 otp_store 回落 + `otp_bound_as_totp_secret` 映射 + 2 个 crate use）已恢复（c279407）。
- **App.vue**：8 处冲突全解——偏好体系保留 integration 侧（terminalBehavior 结构化 + hotkeys + transfer/suggestion adapters），并入 main 的 `terminalCopyCache`/`resolveTerminalPasteText`（右键粘贴降级链）、`randomUUID` shim（issue #104）、工具栏"复制会话"按钮（与 telnet/VNC/serial 入口共存）；main 的 SELECT_COPY_KEY 独立键与 `toggleSelectCopy` 旧路径不取（已被结构化偏好取代），`pluginStore` 全量迁移留待下轮（遗留 3）。
- **mockDbxHost**：main 的 pluginStore 种子写法 + integration 的 #33/#71 诊断注释融合。
- **PROGRESS/TEST_MATRIX**：追加型冲突，双方时间线记录全保留。
- **ui/index.html**：构建重生成（695d69d，对齐 main 侧 Node 22 产物）。

**全量**：backend cargo **735**（M5 基线 719，只增不减）/ clippy `-D warnings` 0 / fmt 干净；frontend vitest **886**（基线 874，只增不减）/ vue-tsc 0 / build 过（ui/ 重生成）。

### M5.5 遗留（人工门/后续轮）

1. 真机验收（不变）：VNC server（None/VNC-Auth）、X server（XQuartz/VcXsrv）转发、串口硬件、GPU/NPU 主机、Windows ConPTY、DBX 桌面端到端。
2. RDP：立项材料已备（`RDP_VENDOR_FORK_PLAN` / `RDP_CREDSSP_REVIEW_CHECKLIST`），评审执行仍为人工门；串口协议升级设计稿待评审。
3. **App.vue 偏好存储 pluginStore 全量迁移**：main 侧已迁 12 个键；integration 结构化偏好新增的前端键（终端行为/快捷键/传输并发/命令建议等）仍走 localStorage 直写，在真机 opaque origin 下静默不持久化（行为可降但偏好不保）——建议下一轮统一切 `pluginStore` 并复验真机持久化。
4. **操作规程**：同一 integration worktree 严禁两个会话并发写——本轮独立收口会话与看护会话曾在 merge 冲突解决上交叠（PROGRESS/mockDbxHost 被外部进程先行解决），靠互斥文件域与人工核验避免撞车；看护任务启动前必须确认既有会话已全部停止。


## M6 轮：pluginStore 全量迁移（2026-09-24，后台 agent 并发）

- **遗留 3 关单 ✅**（parity-plugin-store 93bc1ea/af4f73d，merge 9a1527a）：integration 结构化偏好三键迁入 pluginStore——`ssh-terminal-behavior` / `ssh-terminal-hotkeys` / `ssh-terminal-appearance`（PLUGIN_STORE_KEYS 现 15 键），实现模式对齐 terminalFont/terminalWebgl 先例（defaultStorage 返回 store 单例、显式注入保留为测试口），App.vue 调用点零改动；LEGACY_SELECT_COPY_KEY 降级镜像随主键写穿。**不迁键固化**：transfer/suggestions 五键与下载偏好同构（sidecar preferences 权威 + localStorage 同步缓存，迁走即双权威）、quick-commands（sidecar 迁移种子）、dbx-term-diag（诊断开关非偏好）——排除理由写入 pluginStore.ts 头注释与 spec 排除断言。
- **全量**：frontend vitest **891**（基线 886，+5 默认存储回环/不抛用例）/ vue-tsc 0 / build 过（ui/ 重生成）；backend 零改动。
- **遗留**：真机持久化复验（三键首装靠 pluginStore 惰性搬家带入 localStorage 旧值）仍属人工门；老宿主（Host API < 1.2）降级 guarded localStorage，行为等同迁移前。


## M7 轮排期（2026-09-25，对标缺漏对齐——NyaTerm/Tabby 基准复审结论）

全量源码对标复审（NyaTerm v1.2.11 /Users/Jinpy/btroot/nyaterm + Tabby/NetCatty/tiny-rdm/iShell 文档线索交叉）结论：已完成面见 FEATURE_PARITY（Tabby 配色 192 套/行为页/快捷键编辑器、tiny-rdm 后端全家族、NetCatty 五项、iShell 四件、NyaTerm 七差距项 2a-2d/4/5/7/8a-8f/9a-9c/10a/10c），剩余缺漏按优先级排出 M7 并发实施（全部从 670d124 切独立 worktree）：

- **P0-1 Telnet auto_login**（np9-telnet-autologin）：声明式正则自动登录（用户名/密码/成功/失败正则+重试），对标 NyaTerm `TelnetAutoLoginConfig`；落点 backend/telnet_session.rs + TelnetConnectDialog。
- **P0-2 会话导入补四格式**（np9-import-formats）：SecureCRT(.xml)/FinalShell/Electerm/Termius，对标 NyaTerm `core/importer/`；落点 backend/connection_import.rs + ImportWizard。
- **P0-3 串口 XMODEM/YMODEM/ZMODEM 上传**（np9-serial-xymodem）：对标 NyaTerm `serial/xymodem.rs`；走现有 serial JSON 写通道内嵌协议，不动 wire 协议（SERIAL_ENHANCE_DESIGN 评审项不受影响）。
- **P0-4 连接级启动命令 startup_commands**（np9-startup-commands）：Tabby Login scripts 对标（REVIEW_FORM_VS_TABBY P2-5 曾提出后掉跟踪）；落点 sidecar 偏好（x11_forwarding 先例，不改 manifest）+ open_session shell 建立后按序注入。
- **P1 docs-sync**（np9-docs-sync）：文档同步修编——NetCatty 对标行补入 FEATURE_PARITY、COMPARISON 过时结论更新、tssh/iShell 节"X11/VNC/Telnet/串口不做"矛盾回写、NETCATTY checkbox 补勾、8d 翻译重启条件补跟踪点；并登记 P1/P2 候选缺口（认证 Auto 模式、每连接编码、录制 transcript/自动录制/搜索、SFTP pipeline/兼容模式/文件名编码、Quick Commands 导入、iShell 句柄/监听端口维度、NetCatty 三遗留）。
- **在途**：np8-e2e（smoke_ui_settings 超时修复，已见 terminalModeQueries/smoke_ui_fresh_review 改动）；cron 每 10 分钟看护（交付标准五条）。
- 维持人工门：RDP 评审执行、串口协议升级评审、真机验收矩阵、PR #98 合入。
- M7 完成判据：五分支合入 integration、全量绿（cargo ≥735 / vitest ≥891 只增不减）、e2e walkthrough 绿、push 后 CI 十一门 success。


## M7 收口（2026-09-25，并发验证轮：实例测试 / 真机模拟 / e2e 修复）

**P0 回归修复 ✅**（parity-e2e-fix 9fcb326/f305b2f，merge 见 HEAD）：M5.5 从 main 合入的 `terminalModeQueries.ts`（837fbc7）把 XTVERSION 注册成 `{ prefix: ">", intermediates: "q" }`——`q`(0x71) 超出 xterm 合法 intermediates 区间 0x20..0x2f，`registerCsiHandler` 注册期抛错 → createTerminal 失败 → connected 永不可达 → 全部连接态 UI disabled（真实宿主同炸）。修复：XTVERSION 按真实线格式注册 `{ prefix: ">", final: "q" }` + 回调校验 params（空或 `[0]===0`）；kitty/DECRQM 两 handler 核查无同类问题；**spec 加固：fake parser 镜像 xterm 的 prefix/intermediates/final 区间校验，注册参数形态从此被 vitest 锁定**。同族 walkthrough `smoke_ui_fresh_review.mjs` 陈旧断言修正（凭据行迁 Quick Sudo 页签、键盘断言对齐按平台默认表与 KeyboardEvent.code）。

**并发验证矩阵（三 agent 线）**：
- 实例测试（8 项）：smoke_test 全链路 / smoke_fs 68 / smoke_mcp 33 工具 / smoke_login_mfa 13 / terminal_burst 737 帧 / validate_repo / connection-forms 502 组合全 PASS；smoke_forward 初跑 FAIL 归因容器 `AllowTcpForwarding no`，重建容器（双端口监听 + HUP 生效）复验 **6 用例全过（15.2s）**——插件转发无回归。
- 真机模拟：干净容器首装挑战流 PASS（fs 的 sudo 组 3 项为新容器无 NOPASSWD sudoers 的环境前置，非回归）；浏览器场景矩阵抓出上 P0 回归（S1/S2/S3 同根因）。
- e2e walkthrough：`smoke_ui_settings` 46 ok 全绿（修复前 20s 超时）、`smoke_ui_mock` 全绿、`smoke_ui_fresh_review` 4/4。

**全量**：frontend vitest **891** / vue-tsc 0 / build 过（ui/ 重生成）；backend 零改动。

### M7 遗留
1. 真机人工门不变：DBX 桌面端到端、VNC/X server/串口硬件/GPU-NPU/ConPTY、pluginStore 三键真机持久化复验。
2. 场景矩阵 S1/S2 已由修复后 walkthrough 等价覆盖（fresh_review 连接态 + settings 全绿）；S3（visual.html）修复后复验随本轮 CI 后补录。
3. CI 门禁缺口已暴露：前端 walkthrough 不在 CI——是否纳入 CI 由人工排期（涉及 CI 时长/浏览器依赖）。


## M7 进度（2026-09-25）

- **docs-sync ✅ 合入**（parity-docs-sync 7adaa73/320d290/b53cd62，merge 48a29b7）：NetCatty 对标节补入 FEATURE_PARITY（五项已实现+五项不做）、9 项候选缺口登记、tssh/iShell 节过期结论回写、COMPARISON 双语更新、NETCATTY 计划 checkbox 校准补勾、8d 翻译重启条件跟踪点。agent 自行纠正任务书三处事实偏差（审计日志无 0600 等）。遗留提示：IMPL_PLAN_NYATERM v2 重判表多行仍标"❌ 仍缺"与 M1-M5 不符——留待下轮 docs 批校准。
- **startup-commands ✅ 合入**（11277dc，merge 无冲突）：连接级启动命令序列（Tabby Login scripts 对标）——`startup_commands` 偏好（每连接 ≤20 条/单条 ≤4KiB/延迟 ≤30s）+ open_session shell 后顺序注入（TerminalCommand::Input 通道，remote_command exec 会话跳过）+ `ssh/startup` 事件（不含命令内容）+ SettingsDialog 编辑区（七语）。backend +10 / frontend +7 / 容器 smoke 实跑 PASS。PROTOCOL 同步。
- **import-formats ✅ 合入**（f9fed3c，merge 无冲突）：SecureCRT(.xml hex 端口优先)/FinalShell(zip+folder.json 组链，DES 密文不迁移)/Electerm(bookmarks 组父链)/Termius(加密 blob 启发式丢弃、明文 PEM 迁移) 四解析器，统一 `secret_note` 原因码 + 预览横幅七语。backend +14 / frontend +3。
- **全量（三线合并后）**：backend cargo **759**（基线 735）/ clippy 0 / fmt 干净；frontend vitest **901**（基线 891）/ vue-tsc 0 / build 过（ui/ 重生成）。
- **在途**：telnet-autologin、serial-xymodem、np8-e2e（walkthrough 超时修复）。


## M7-Warp 进度（2026-09-25）：结构化补全 spec 下拉 ✅ 合入

- **Warp 对齐线 2 ✅**（parity-warp-spec 9717fa1，merge f12f4d3）：`lib/completions/spec.ts`（fig 思路裁剪 schema + token 切分/层级匹配/评分纯函数）+ 首批 12 个精选 CLI spec（git 28 子命令含二级树/docker 28/kubectl 21/ssh/systemctl/tmux/cargo/npm/pnpm/yarn/curl/grep）+ `CompletionMenu.vue` 三级下拉（flag/子命令/值候选，动态值出 `<branch>` hint 不枚举）。命令条接线：spec 优先、历史浮层回落并存；SettingsDialog"结构化补全"开关（默认开，pluginStore 键 `ssh-completion-spec`）；i18n `completionMenu.*` 七语。零 AI、零运行时依赖。
- 冲突：SettingsDialog 与 M7 startup-commands 块追加型冲突（保留双方）。
- **全量**：backend cargo **766**（M5.5 基线 735，M7 三线 + spec）/ clippy 0 / fmt 干净；frontend vitest **934**（94 文件）/ vue-tsc 0 / build 过（ui/ 重生成）。
- 在途：Warp 线 1（ghost 行内建议，np8-warp-ghost）、e2e 修复线（np8-e2e）、M7 剩余（telnet-autologin / serial-xymodem）。


## M7 进度（二）（2026-09-25）

- **telnet-autologin ✅ 合入**（5b18690，merge 零冲突）：声明式 auto_login（提示正则+凭据降级共享 Expect 引擎、成功/失败正则监督、重试预算、超限关闭会话带可读原因；密码脱敏 Debug/事件红线），TelnetConnectDialog 折叠区七语 15 键。与 NyaTerm 差异：匹配载体用共享引擎（无第二套匹配器）、未做 send_wake_enter/timeout_ms、手动输入不解除、超限改为关会话（NyaTerm 仅禁用）——差异点已记录。
- **全量（四线合并后）**：backend cargo **766**（基线 735）/ clippy 0 / fmt 干净；frontend vitest **934**（基线 891）/ vue-tsc 0 / build 过（ui/ 重生成）。
- **在途**：serial-xymodem、np8-e2e。


## M8 收口（2026-09-25，Warp 对齐 + np9 并发轮）

- **Warp 线 1 行内 ghost 自动建议 ✅ 合入**（parity-warp-ghost cee2c90，merge 5bf6505）：`terminalGhostSuggest.ts` 纯状态机（onData 字节分类/行尾门闩/严格前缀扩展过滤，接受字节=精确剩余后缀的 typed 等价 PTY 注入，零协议变更）+ App.vue 终端区 overlay DOM 渲染（→ 一次接受、IME/粘贴/远端命令中隐藏）+ SettingsDialog 自治开关（pluginStore 键 ssh-terminal-ghost-suggest，默认开）+ i18n 七语块 + 26 新单测。
- **Warp 线 2 结构化补全 ✅ 合入**（parity-warp-spec，merge f12f4d3）：`lib/completions/spec.ts` schema/评分纯函数 + specs/ 精选 CLI 库 + CompletionMenu 三级下拉 + 命令条接线（spec 优先/历史回落）+ SettingsDialog 开关（键 ssh-completion-spec）+ completionMenu.* 七语。
- **np9 并发线 ✅ 合入**：telnet-autologin（dab496b，声明式正则自动登录）、import-formats（34fd7b1，SecureCRT/FinalShell/Electerm/Termius 四解析器）、startup-commands（b673496，连接级启动命令 sidecar 偏好 + open_session 注入，remote_command 语义冲突已文档化）、docs-sync（48a29b7，NetCatty 对标/COMPARISON/候选缺口登记）。
- **集成修复**：warp-ghost 合入的 SettingsDialog/i18n 共享闭合括号错位（两线 load 函数共用冲突块外 `}`）手工重排修复；pluginStore/spec 断言双键并保。
- **全量**：frontend vitest **960**（91→95 文件，基线 901 只增不减：ghost 26 + spec/telnet/startup/import 各线 spec 并入）/ vue-tsc 0 / build 过（ui/ 重生成）；backend cargo **745**（startup_commands 并入后全绿）/ fmt 干净 / clippy 0。


## M7 进度（三）（2026-09-25）

- **serial-xymodem ✅ 合入**（8356403，merge 两处追加型冲突：i18n 双键块拼接 + PROTOCOL 表行并档；修复拼接时被冲突标记吞掉的 terminalGhost 合并循环闭合括号）：串口 XMODEM/YMODEM/ZMODEM 纯状态机（~1300 行，可注入时钟单测；ZDATA 保守单 ZCRCW 子包、ZRPOS 续传、ZSKIP/CAN 取消），serial/upload/start|data|cancel + progress 事件，前端 File API 流式分块（≤64KiB，总量 ≤256MiB）+ 弹窗/进度 overlay/传输中吞键入，七语。backend +35 / frontend +15；PTY 回环因 serialport-rs ENOTTY 记 SKIP（协议语义由进程内喂字节单测覆盖），smoke 5 PASS / 2 SKIP。
- **并入确认**：warp 线 1（np8-warp-ghost 行内 ghost 建议）已由并行会话先行合入（terminalGhost 文案块在案），本次 merge 基于其上。
- **全量（六线合并后）**：backend cargo **801**（基线 735）/ clippy 0 / fmt 干净；frontend vitest **975**（97 文件，基线 891）/ vue-tsc 0 / build 过（ui/ 重生成）。
- **在途**：np8-e2e（walkthrough 修复）。M7 剩余：全量数字随最后一线上升后做终收口。

- **serial-xymodem ✅ 合入**（parity-serial-xymodem 8356403，merge 42264bb）：XMODEM/YMODEM/ZMODEM 文件上传（NyaTerm parity P0-3，serial JSON 写通道内嵌协议，不动 wire 协议）+ 前端 serialUpload 状态机 + 七语文案 + smoke_serial_upload.py 上传冒烟。**np9 五线全部合入，M7 排期清零。**
- **M8 全量终值**：backend cargo **801**（745 + xymodem 56）/ clippy 0 / fmt 干净；frontend vitest **975**（97 文件，960 + xymodem 15）/ vue-tsc 0 / build 过。


## M8 收口补遗：serial-xymodem 全量数字（2026-09-25）

- **P0-3 串口 XMODEM/YMODEM/ZMODEM 上传 ✅ 合入**（8356403 + merge 42264bb）：backend `serial_xmodem.rs`（2069 行，走现有 serial JSON 写通道内嵌协议，不动 wire 协议）+ 前端 SerialUploadDialog/serialUpload + `smoke_serial_upload.py`（406 行）+ PROTOCOL 文档同步。
- **全量**：backend cargo **801**（M5.5 基线 735 → M7 766 → 801，只增不减）/ clippy `-D warnings` 0 / fmt 干净；frontend vitest **975**（97 文件，基线 891 → 934 → 975）/ vue-tsc 0 / build 过（ui/ 重生成）。
- **交付核验 ✅**（reverify.md）：UI 场景矩阵 13/13（原 3 FAIL 随 XTVERSION 修复 9fcb326 全部转绿）、walkthrough 家族 3/3（settings/mock/fresh_review 全绿）、smoke 双件套 PASS。
- 至此 M7 五任务 + Warp 两线全部合入，CI 覆盖最新 HEAD。


## M9 轮：连接表单协议化（2026-09-25，用户指令"对标 Tabby 做进连接设置"）

- **manifest 连接表单 protocol 字段 ✅**（parity-protocol-connect 53d29f6）：`protocol` select（ssh 默认/telnet/vnc）+ 29 个 SSH 特有字段挂 `visible_when`（原单条件升级 all_of 叠加 protocol=ssh，passphrase_command/password_prompt_hint 展平为三条件）+ username 覆盖 ssh+telnet + 七语 label/options/description；RDP 刻意不提供（实现不存在，评审门材料在 docs/RDP_*）。connection-forms/verify.mjs 断言同步（502 组合全过）。
- **工作台协议路由 ✅**（e68f808）：openSession 读连接 protocol——telnet/vnc 连接直启各自会话（参数=连接 host/port + 上次使用偏好），失败回落预填弹窗；SSH 保持默认路径。backend 零改动（telnet/vnc start 参数直传，不依赖 SSH StoredConnection）。
- **对话框参数记忆 ✅**（6bc0496）：Telnet/Serial/VNC 三弹窗经共享 `lib/connectLastParams.ts` 回填/写穿上次参数（pluginStore 三新键）；凭据字段一律不落盘。
- **全量**：frontend vitest **980**（98 文件，基线 975 只增不减：connectLastParams 5）/ vue-tsc 0 / build 过（ui/ 重生成）；backend 零改动；connection-forms verify 502 组合全过。
- **遗留**：telnet/vnc 连接驱动的直启路径需扩展 mockDbxHost fixture（telnet/start mock）后才能 e2e 验证——下一轮；serial 协议化 deferred（参数组不同构）；RDP 表单暴露待实现落地。


## M10 收口（2026-09-25，评审修复批次：四线并发 + cron 看护）

两轮代码评审（结构/性能/UI体验/安全）发现的问题按四条并发线修复合入：

- **fe-fix（19cde73/b187746，merge bad2baa）**：ghost 锚点视口公式（cursorY-viewportY → cursorViewportRow/cursorAbsoluteRow，新 lib/terminalAnchor.ts + 5 用例含旧公式负值对照）；confirmTelnetOpen 补关 serialSession；Serial/VNC 弹窗补 X 关闭图标 import；ghost 与结构化补全互斥（ghostMenuSuppressed + ArrowRight 消费顺序）。
- **x11-gate（2bdeb42，merge 后 backend 818）**：两轮 CRITICAL 闭环——SshClient 覆写 server_channel_open_x11（fail-closed：准入→setup 校验→真 cookie 替换→桥接；accept 后缓冲校验是 SSH 协议顺序约束，文档注释说明）；ACTIVE_GATE OnceLock → Mutex<Option<Arc>>，re-arm 替换 + 最后会话关闭全局 disarm；+6 测试（替换拒绝/计数独立/分块 cookie/setup 超限等）。
- **watch-path（7a5ca42/967a11d，merge 后 823）**：watch/start+upload_back 复用 validate_remote_edit_path（canonical 前缀 + symlink 逃逸/目录穿越反例测试）；upload_back metadata 预检 + spawn_blocking；指纹哈希异步化；QR 解码 ImageReader limits；OTP tmp 0600 先建后写。
- **ci-contract（71253b4/78d32b3，merge 后 812→合入时点）**：UI walkthrough 挂入 CI frontend job（DBX_SMOKE_STRICT=1 下依赖缺失即失败，退出码分离实测）；agent-flow validation.local 补两项；PROTOCOL.zh-CN.md 补 vnc/frame 44 字节契约节；跨端 golden hex 向量双侧断言（后端 +1）。

**上轮评审闭环**：CRITICAL 2/2（X11 gate、ghost 锚点）、HIGH 4/4（watch 路径、telnet 漏关、X 图标、浮层互斥）、MEDIUM 若干（QR limits、0600、upload 预检、e2e 门、契约文档）；X 图标与 telnet 漏关为第二轮复核确认的残留，本轮清零。

**全量**：backend cargo **823**（811 → +12，只增不减）/ clippy -D warnings 0 / fmt 干净；frontend vitest **990**（980 → +10）/ vue-tsc 0 / build 过（ui/ 重生成）。CI 含新挂的 UI walkthrough 门（strict 模式），首次 CI 观测项见 commit 注记。

### M10 遗留

1. CI 的 UI walkthrough job 首次运行需观测（runner Chrome 与 playwright-core 协议匹配无法本地验证，回退方案已写入 ci.yml 注释）。
2. X11 guard 页面缺位：setup 校验在 accept 后（协议约束），畸形流量最坏影响为上限 8 的悬挂通道——已记录，不阻塞。
3. 评审其余 MEDIUM/LOW（串口上传内存上限/写线程化、gutter 满容量平移、协议表单端口联动、modalOpenStates 注册器化等）留下一轮按优先级消化。


## RDP 实施轮 RDP-1（2026-09-25，vendored fork 链）

- **vendored 链 ✅ 合入**（parity-rdp-vendor 7de0ef1/a23abcd）：六 crate 锁步入 vend——ironrdp umbrella 0.17.0（crates.io tarball sha256 与 NyaTerm lock 逐字节一致，额外纳入 patch 堵漂移入口）+ ironrdp-client 0.1.0（3 处注入补丁）/ connector 0.10.0 / tls 0.2.2 / picky 7.0.0-rc.25 / sspi 0.21.0（NyaTerm 副本原样）。Cargo.lock +2025 行完整提交；`backend/vendor/` 3.5MB/260 文件。
- **锁步 CI 断言**：`scripts/check_vendor_lockstep.py`（lockfile patched 段 ↔ vendor/ 目录一致性，漂移非零退出；三种负路径验证），接入 ci.yml backend job。
- **全量**：backend cargo **823**（vendored 生效后全绿）/ clippy 0 / fmt 0 / lockstep PASS；frontend vitest **990**（99 文件，含并行 M10 波次增量）/ vue-tsc 0 / build 过。
- 遗留：ironrdp-client 发布包无 LICENSE（已从 upstream monorepo 补 APACHE/MIT 并登记 vendor/README）；ironrdp-tls 补丁状态缺口（计划 §5-1）按"原样搬运"登记，升级轮对照原包核实；Windows native-tls/Schannel 路径依赖 CI windows-regression 兜底。
- **下一棒 RDP-2**：rdp_session.rs MVP（对标 NyaTerm src/core/rdp.rs：NLA/CredSSP 认证、TLS 证书策略 prompt、text-only 剪贴板桥、按错误类型重连门控）+ rdp/* 协议面 + PROTOCOL 文档——基线含本棒 vendor 链。

> CI 观测补记（M10）：UI walkthrough strict 门经三次观测迭代后于 runner 全绿（run 36080783898，十一门全 success）——首轮暴露 pnpm exec 包装吞 stdout（改为直启 vite 二进制），次轮暴露快捷键冲突步骤的平台键位假设（改为按宿主平台录制实际被占有的组合）。两处均为门外脚本盲区，产品代码零回退。


## 串口增强实施轮（2026-09-25，按评审定稿蓝图实施）

- **三增量 ✅ 全栈合入**（parity-serial-enh-impl 五 commits）：B1 二进制写通道（Stdin=3 流标签 + 上传互斥门 + sidecar 拒收后盾）、serial/replay 序号制（与 telnet/local 先例逐字段同构、128 KiB 缓冲、前端 drain 复用 + 7 语截断提示）、写序列化与回压（专用写线程 + 256 KiB 有界队列 + 4 KiB 分帧 + 队满报错不阻塞生产者）。能力探测降级（binaryInput 字段）随 start 落地；resize 按文档明确不实现。安全修复（0 字节 final、坏帧预算 32）零改动。
- **实施定稿参数**：分帧 4 KiB / 队列 256 KiB / 键入单包 16 KiB（文档标注"实施时定稿"项）；写失败镜像 `serial/write/error` 事件（会话保持）已记入 PROTOCOL 契约。
- **全量**：backend cargo **867**（825+RDP-2 后合入累计）/ clippy 0 / fmt 0；frontend vitest **998**（100 文件）/ vue-tsc 0 / build 过（ui/ 重生成）。
- 遗留：二进制事件在宿主桥的流量控制行为需实测（文档标注）；真口回环 smoke 与 install 检查按规约归 integrator。


## RDP 实施链收官（2026-09-25，RDP-1/2/3 全链合入）

- **RDP-1 vendored 链 ✅**（0319148e）：六 crate 锁步 + lockstep CI 断言，CI 五平台验证通过。
- **RDP-2 sidecar 引擎 ✅**（09c84b5e，+31 测试）：IronRDP 客户端独立线程 + vendored 注入补丁接线；证书策略 prompt/strict/accept-temporarily 状态机（120s 窗、remember 落盘、generation 防串话）；CredSSP/NLA；44 字节 patch 帧走 rdp/frame/{id}（与 VNC 同构）；text-only CLIPRDR 双向桥（16 MiB 双向硬上限）；按错误类型重连门控（认证类 fail 不重试，退避 1/2/4/8/15s 封顶 30s）；安全【硬】清单全落地（NTLMv2-only 源码断言钉住、凭据 Zeroizing 不落日志、证书 fail-closed、剪贴板不落审计）。协议 rdp/start|input|resize|set-clipboard|reconnect|certificate/resolve|close|list + PROTOCOL 文档节。
- **RDP-3 前端 ✅**（本 merge，+21 测试）：RdpSurface（rAF 合帧/缩放三态/pointer 四型含位图光标）+ RdpConnectDialog（分辨率门限/证书策略三选/凭据不落盘）+ App.vue localUiMode 互斥接线 + rdp-certificate 专属确认弹窗（SHA256+倒计时+remember，fail-closed）+ rdp.* 七语 56 键 + mockDbxHost rdp/* 全协议桩（?rdpCert/rdpErr 走查参数）。
- **全量终值**：backend cargo **854** / clippy 0 / fmt 0 / lockstep PASS；frontend vitest **1019**（101 文件）/ vue-tsc 0 / build 过（ui/ 重生成）。
- **遗留（人工门）**：RDP 真机 server 联调（握手/帧/剪贴板/重连端到端）、canvas 位图光标 WKWebView 走查、`?rdpCert/rdpErr` mock 走查路径浏览器复验、rdp/resize 前端触发入口（按需）、CredSSP CBT 端到端核对（评审动作）。


## RDP 收官对抗审查与修复轮（2026-09-25）

- **审查结论**：8 攻击面 8 安全 / 7 问题（中 2 低 5）/ 4 需确认。凭据流（Zeroizing 闭环）与证书状态机（120s fail-closed/generation 竞态闭环）两大核心通过。
- **修复 ✅ 全部合入**（parity-rdp-fix 978f151a/a215a65a，+29 测试）：C2 剪贴板分片发送（JSON 转义后 7MiB 预算切分、chunkIndex/Total、App 会话隔离缓冲拼接）保 16MiB 契约可用；C1 入口长度门（原始载荷先于 String 物化拒绝）——**缓解+登记**（crates.io cliprdr 0.7.0 PDU 整包物化不可避免，完全修复走 vendored fork plan 另一工作流）；D3 ReconnectBudget 状态机（总预算 50 次永不重置，active 只重置退避步长，防恶意服务器无限循环）；E5 unicode 4096 上限 + scan_code u16→u8 显式拒绝；B4 known-certs 写盘 uuid tmp + rename、磁盘格式 V1→V2 信封向后兼容、真"最旧"淘汰；B6 Debug 手写脱敏 + host/username/domain 上限；cert_key 大小写归一；mock 桩对齐（challengeId 一次性 + 120s fail-closed + 序号全局单调防 walkthrough 假死），余偏差头注释登记。
- **全量终值**：backend cargo **883** / clippy 0 / fmt 0；frontend vitest **1019** / vue-tsc 0 / build 过（ui/ 重生成）。
- **RDP 链状态：正式收官**。遗留人工门：真机 RDP server 联调、WKWebView 位图光标走查、CBT 端到端核对、C1 完全修复（属 vendored fork plan 升级工作流）。


## M13 收口（2026-09-25，对标差距批次三线并发）

- **认证 Auto 模式 ✅**（parity-np13-auth-auto-np13 三 commits，merge 5eda9804）：`AuthenticationMethod::Auto` + `authenticate_auto` 纯编排器（密码→私钥→KI 含 TOTP→agent 固定顺序，AUTO_AUTH_ORDER 契约常量 + debug_assert 不变式）；逐阶段复用既有 helper（Quick Sudo OTP/挑战流零改动），私钥/agent partial-success 走既有 MFA KI 续答不重复提问；逐跳过/失败发 `ssh/auth/auto` 事件入连接日志，全失败按序汇总原因。frontend：表单 Auto 选项 + 七语 + 卡片日志渲染；存量连接零迁移。
- **Quick Commands 导入 ✅**（parity-np13-quickcmds-proc-np13 99a27e48，merge 4f8f0091）：JSON 数组 + Tabby snippets 格式映射；同名跳过去重 + 上限 20 导入前 N 条策略；解析纯函数 9 单测 + 导入子视图（文件/粘贴 → 预览 → 确认逐条 save）。
- **进程管理维度 ✅**（同 commit）：`ssh/processes/list` 加 fdCount（/proc/<pid>/fd 纯内建计数，零 spawn）与 listenPorts（/proc/net/tcp{,6} 监听态 inode 关联，去重升序 ≤16）；`ss -tlnp` 降级有意省略（无 root 同样拿不到 pid 归属，注释写明）；前端两列可排序 + 七语；mock 补 processes/kill。
- **对标文档同步 ✅**（parity-np13-docs-sync-np13 383967c0，merge fa0abe59）：COMPARISON 矩阵 RDP 行改"内置（vendored 链，真机联调人工门）"+ 新增 5 行能力 + Telnet/串口行补注；FEATURE_PARITY 候选缺口表核实（会话导入实为 7 格式，纠正任务卡 8 的笔误）；PROTOCOL 补 RDP 三处契约（E5 4096/C2 分片/D3 预算）。
- **⚠️ manifest 解释偏差（待 integrator 复核）**：A 线按 agent-flow ownership（frontend 拥有 manifest.json）增量修改 manifest——① 认证 select 加 Auto 选项+七语 description；② 6 个凭据字段 visible_when.one_of 追加 "auto"（否则选中 Auto 后凭据字段级联隐藏）；③ password 七语 hint 弱化"必填"表述。**逐行复核通过**：无版本号/permissions/贡献点/其他字段改动。已知限制：required_when 单字段表达力下 Auto+password_source=direct 仍强制填密码（密钥-only 用户暂用显式方式），登记遗留。
- **全量终值**：backend cargo **894**（887+7）/ clippy 0 / fmt 0；frontend vitest **1031**（102 文件，1029+2）/ vue-tsc 0 / build 过（ui/ 重生成）；connection-forms verify 598 组合 PASS。

### M13 遗留

1. Auto+direct 密码必填（manifest required_when 表达力限制）——未来可评估条件化 required_when 或 options_action 动态选项。
2. `ssh/auth/auto` 事件无 sessionId 过滤（连接期无 session，与 host-key/notice 同策略）；connection/test 也触发该事件。
3. mockDbxHost 未模拟 Auto 场景（纯展示层 spec 已覆盖）；COMPARISON.en.md 未同步（需双语一致可另开小轮）。
4. 候选缺口表消化后剩余：录制增强（transcript/自动录制/搜索）、SFTP 管线（深度/兼容模式/文件名编码）、DownloadSudo、多文件 watcher、BiDi（观察）、云同步降维（待安全评审）。


## M14 收口（2026-09-25，对标差距批次二：录制/SFTP 管线/DownloadSudo 三线并发）

- **录制增强 ✅**（parity-np14-record-enh 754589e7，merge 92d1f7bd）：Transcript 导出（**前端纯函数选型**——回放链已分页拉到前端，零新协议面；ANSI/OSC 剥离+CR 丢弃+可选时间戳，保留终端换行布局）；auto_record 自动录制（严格镜像 x11_forwarding 先例：偏好白名单+进程内快速标志+open_session 挂钩，与手动录制互斥，ssh/recording/auto 事件一次性提示）；录制搜索（后端即时扫描 ≤200 会话、每录制 5 条命中摘录，不建持久索引）。
- **SFTP 传输管线 ✅**（parity-np14-sftp-pipeline 12e729cb，merge b676a8c9）：并发深度可配 transfer_max_active 1-8（sidecar 权威，进行中任务按旧深度完成）；sftp_compat_mode 兼容模式（new_with_config 1/1 禁流水线+深度强制 1；本插件从不发起 extended 请求已核实）；非 UTF-8 文件名——**agent 发现 russh-sftp 反序列化层 from_utf8_lossy 拿不到原始字节，新增 584 行裸包 SFTPv3 客户端**（INIT/OPENDIR/READDIR/STAT/OPEN/READ），latin-1 模式显示=latin1 解码、传输=%XX 转义 wire 形式、下载自动还原原始字节；硬分离（显示解码绝不回灌传输）纯函数+往返单测落地。
- **DownloadSudo ✅**（parity-np14-download-sudo c4390870，merge 本轮）：`sudo/download/start|cancel`——远端临时文件方案（同目录 mktemp → **chown 登录uid + chmod 600**（修正任务卡 0600 设计错误：root 属主下登录用户读不了）→ 复用既有 sftp/download/next/finish/progress 与传输面板全链 → finally sudo rm 清理含会话关闭/取消/出错）；sudo dd 流式否决（无二进制边界/无续传/需另建管线）；路径校验复用 sudo 族先例；右键"以 root 下载"（只读门禁一致）；smoke_fs_test.py 增 sudo/download 用例。**P0 核心清单 Sudo 文件操作族至此全量补齐。**
- **集成修复**：B 合入时 localPrefsState 两声明重复（拼接缺陷）合并为单一 8 键声明；C 合入零冲突；**集成线复审发现 escape_wire/unescape_wire 往返不对称**（文件名含字面 `%XX` 时 escape 直通、unescape 误解——latin-1 模式下路径被改），修 `%`→`%25` 自转义 + 往返闭环单测（cargo 925 不变，sftp_name 模块 12 用例含往返）。
- **全量终值**：backend cargo **925**（894+31）/ clippy 0 / fmt 0；frontend vitest **1047**（104 文件，1031+16）/ vue-tsc 0 / build 过（ui/ 重生成）。

### M14 遗留

1. 非 UTF-8 名字的 rename/delete/树下载仍走高层客户端（按字面量发送）；完整字节保真需全路径操作迁 raw 层（超范围登记）。
2. 兼容模式"禁用扩展"落地为"不发起 extended + 禁流水线"；crate 内 fsync-on-flush 仅服务器自报扩展时触发，无法外部关闭。
3. DownloadSudo 暂存 cat 为阻塞 exec（5-300s 超时夹取，约 16GiB 需 >55MB/s 磁盘）；远端需与源等量临时空间；sudo/download 与无残留清理的真机 smoke 待集成线跑 smoke_fs_test.py。
4. raw SFTPv3 客户端 async 通道交互需真机回环（沿 smoke 惯例）。


## M15 收口（2026-09-25，遗留消化批次：多文件 watcher / SFTP raw 路径保真 两线并发）

- **多文件并行 watcher 编辑 ✅**（parity-np15-watcher-multi 8927fe4/95ad9ee，merge 9d8007d）：侦察发现后端本就按 watchId HashMap + `{sessionId}:{canonicalLocalPath}` dedup 支持并行，瓶颈纯在前端（单 ref 顶替）——**零协议改动**选型：前端并发打开（移除全局 externalEditBusy 门禁）+ `lib/watchEdits.ts` WatchRegistry（watchId→条目，同远端路径按 remotePath 粒度顶替旧条目与 sidecar dedup 收敛一致）；file-modified 三选确认改 `watchModifiedQueue` 队列（未知 watchId 丢弃、同文件未决去重、队头决议出队、过期决议拒绝），多文件同时 modified 排队逐个弹确认不互顶不丢事件；watch/upload 回传前端 promise 串行链逐个执行；回传暂存隔离补 64 并发不重名单测（`.dbx-part-<uuid>` 本就按调用唯一）。
- **SFTP 非 UTF-8 路径操作 raw 层迁移 ✅**（parity-np15-sftp-raw 0d3b1b2/864f6f0，merge 7205099）：raw 客户端补 FXP_LSTAT/REMOVE/MKDIR/RMDIR/RENAME wire op（错误映射沿既有惯例）；选型**仅 latin-1 切 raw，auto 完全不动**（回归风险最小），判定点在 main.rs handler（与 sftp/list 读偏好模式一致）；回退策略——仅裸包客户端建立失败时回退高层（未发出任何请求，安全），操作发出后失败原样报错不回退（写操作回退可能重复执行）；rename 目标/mkdir 名经 `write_path_bytes`（目录前缀按 %XX 还原 wire 形式 + 最后一段用户新输入显示编码回字节，字面 %XX 不二次转义）；latin-1 树下载遍历走 raw（`scan_tree_with_raw` 单通道 LSTAT 预检 + READDIR 递归，LSTAT 判型 REMOVE/RMDIR/后序递归树删，symlink 绝不跟随）。显示解码绝不回灌传输路径契约不受影响。PROTOCOL 同步 sftp/list 节 M15-B 段 + 递归目录下载节。
- **候选缺口表清理 ✅**：M13/M14/M15 已交付项从「候选缺口（未排期）」表移除；**云同步经决策除名——DBX 宿主基础能力已提供配置同步/上传，插件侧不再立项**（含口令加密导出导入降维方案）。剩余候选：每连接编码选择、终端 BiDi（观察）。
- **基线口径注记**：cargo 用例数存在平台差异——M14 记录 925 为 macOS 实测，Windows 实测基线 d023963 为 920（A 线 agent 以基线 commit `--list` 复核、集成线 worktree 全量复测一致）。本轮"只增不减"以同平台 Windows 口径执行：合并后 **929**（920+9）。
- **全量终值（Windows 实测）**：backend cargo **929/929**（win 基线 920+9）/ clippy 0 / fmt 0；frontend vitest **1057/1057**（105 文件，1047+10）/ vue-tsc 0 / build 过（ui/ 重生成单独 commit 0baa803）。两 merge 零冲突。

### M15 遗留

1. latin-1 模式 `sftp/exists` 覆盖预检、`sftp/rename-unique` 撞名探测仍按字面量发送（预检失败不阻断，已知边界）。
2. 上传（sftp/upload/*、write、touch、symlink 三命令）新输入名仍按字面量发送；MCP 工具面 sftp_mkdir/remove/rename（mcp.rs 独立客户端）未迁移 raw 层。
3. raw 客户端每操作独开 sftp 子系统通道（写操作低频，未做复用）；SFTPv3 RENAME 不覆盖已存在目标（与 auto 模式高层语义一致）。
4. 多文件 watcher：外部编辑器全链路真机手测、FSEvents/inotify 真机联调（沿 M3 既有人工门）。


## M16 收口（2026-09-25，候选缺口消化批次：SFTP 编码保真收尾 / 每连接编码选择 两线并发）

- **SFTP 编码保真收尾 ✅**（parity-np16-sftp-enc-finish 80dad21，merge 0102267）：raw 客户端补齐写侧——OPEN(creat|write|trunc)/WRITE（32KiB 分块）/SETSTAT/READLINK/SYMLINK（OpenSSH wire 次序，与高层 symlink(target,linkPath) 生产语义一致）+ RawAttrs atime/encode_attrs 闭环；exists/rename_unique 迁 raw（LSTAT 探测，候选名 latin1_encode_display 编码逐候选探测、name 返回保持显示形式）；touch/write_file/write_bytes/symlink 三命令/upload_watched_file 迁 raw（暂存 ASCII 临时文件 → SETSTAT 0o7777 权限保留 → 原子 rename → 失败清理，对齐高层 issue #37 语义）；finish_upload 增 latin-1 raw 暂存分支（取消检查/进度事件与高层管线逐块对齐）。**路径来源两分工**：wire 目录前缀 + 用户新输入显示末段（write_path_bytes）＝touch/symlink-create/exists/rename-unique/upload start|finish；整条 wire 路径（unescape_wire）＝sftp/write（previewPath）/upload-local/symlink-update 链接路径/rename 源/delete。回退沿 M15 先例。
- **每连接编码选择 ✅**（parity-np16-conn-encoding 3aeabb9，merge 76a619f）：对标候选表最后一项非观察项。侦察修正先例——auto_record 实为全局偏好链，真正的连接级先例是 M7 `startup_commands`（preferences 单键按 connectionId 分桶）；新键 `sftp_name_encoding_overrides`（sanitize 桶上限 512/白名单外静默丢弃）+ `resolve_sftp_name_encoding` 三态纯函数（连接覆盖 > 全局 > 缺省 auto）；5 个判定点切连接级；前端连接设置区控件 + connNameEncoding 七语 + mock 镜像。vitest 抓住并修复 merge 上限检查误用 `out.length` 的真实 bug。
- **集成线统一 ✅**（6bbbc2d）：两线在 main.rs 编码判定点各有落点，融合期把 A 线按现状读全局的调用点全部统一到 B 线连接级判定（新增 `resolve_sftp_encoding_opt`；watch/upload 经 `watcher.session_for_watch`、sftp/upload/finish 经 `ssh.upload_session_id` 两个最小访问器取回所属会话）；`preferences::sftp_name_encoding` 无二进制调用者后删除（测试改走 `sftp_name_encoding_for(dir, None)`），死代码标注清零。
- **COMPARISON.en.md 双语同步 ✅**（M13 遗留 3 消化）：M13 同步轮的 5 新行/RDP·Telnet·串口行更新/协议路线注记/Tabby 定位差异/如何选择各节镜像到英文版，双语结构对齐。
- **全量终值（Windows 实测）**：backend cargo **937/937**（M15 后基线 929：A 线 +6、B 线 +2）/ clippy 0 / fmt 0；frontend vitest **1061/1061**（106 文件，1057+4）/ vue-tsc 0 / build 过（ui/ 重生成单独 commit 3af0d43）。两 merge 零冲突。

### M16 遗留

1. 粘贴预检（exists 的 paste 调用方，整条 wire 名）与底层 sftp/copy、sftp/move 在 latin-1 下仍未迁移。
2. 终端拖入上传的手输/shell cwd 目标目录非 ASCII 路径无法还原 latin-1 字节。
3. MCP 工具面 sftp_mkdir/remove/rename 字面量发送——需 MCP 面自身编码模式 + 列表层迁移的后续设计（单点迁移为零收益半迁移，已核实）。
4. 候选缺口表仅剩：每连接编码选择本口消化完毕后为空（BiDi 为观察项不列），对标缺口表至此后备候选为零。


## M17 收口（2026-09-25，工程面收官批次：latin-1 最后收尾 / MCP 工具面编码 两线并发）

- **latin-1 最后收尾 ✅**（parity-np17-enc-last 1c1de5f，merge 054e23d）：粘贴预检走 `sftp/exists` 新增可选 `form:"wire"`（整条 wire 还原，缺省仍为 wire 前缀+显示末段分工）；`sftp/copy`/`sftp/move` 覆盖预检改逐个裸包 LSTAT、同目录 move 快路径改裸包 RENAME（撞名/跨设备回落 shell mv 语义不变）；拖入上传落点（手输/shell cwd 回读）经前端 `displayPathToWire`（与 sidecar `latin1_encode_display`+`escape_wire` 逐字符等价含 % 自转义）转 wire 后命中 write_path_bytes 分工；查漏补缺 `sftp/stat`/`sftp/chmod` 迁 raw（LSTAT/SETSTAT，属主列 shell 查询尽力而为）。**登记边界**：远端 exec 层（cp -a/mv -f/df/tar/sudo 族）命令串为 UTF-8 String，字节不可控——执行层不强迁，clean 名行为不变、转义名由远端报错；shell cwd 回读的非 UTF-8 字节在终端解码层已丢失（U+FFFD）不可恢复。
- **MCP 工具面编码 ✅**（parity-np17-mcp-enc 7424193，merge bf81cee）：复用连接级判定（`arguments.connectionId` → `sftp_name_encoding_overrides` > 全局 > auto，内联拨号按未覆盖），不引入工具面编码参数；`sftp_list_dir` 走裸包 READDIR，**名字口径为显示形式**——latin-1 解码输出恒在 U+0000..=U+00FF 域，`latin1_encode_display` 是精确逆变换，AI 把返回 path 原样回传 mkdir/remove/rename 即落回原始字节（往返闭环单测）；写工具整条按显示编码还原字节后走裸包（remove 判型分派/symlink 不跟随/递归复用 raw_delete_tree）；回退与工作台一致；auto 模式四工具行为不变。
- **集成冲突融合**：ssh.rs（classify_raw_kind 可见性双侧同改）取带说明注释侧；PROTOCOL 双方 M17 段全部保留、遗留项融合为单一状态（①②③ 均已消化，MCP 其余工具登记沿同一模式补齐）。
- **过程记录**：A 线 agent 前两实例死于基础设施错误（Captcha instance timed out，非任务失败），第三次拉起成功——未触发"3 周期失败转人工"线。
- **全量终值（Windows 实测）**：backend cargo **940/940**（M16 后基线 937：A 线 +1、B 线 +2）/ clippy 0 / fmt 0；frontend vitest **1064/1064**（106 文件，1061+3：displayPathToWire 3）/ vue-tsc 0 / build 过（ui/ 重生成单独 commit）。

### M17 遗留

1. MCP 面其余工具（sftp_read_file/write_file/stat/exists/chmod/copy/move）latin-1 下按字面量发送——非 ASCII 名探不到目标（报错而非误操作），沿 M17-B 同一模式可补齐。
2. shell 执行层字节边界（copy/move 跨目录执行、df/tar/sudo 族）与 shell cwd 非 UTF-8 回读丢失——设计边界，已登记 PROTOCOL。
3. **非观察工程 backlog 至此清零**。剩余：终端 BiDi（观察项，未立项）；真机人工门（latin-1 全链真机联调、多文件 watcher 外部编辑全链路、RDP/sudo smoke 等沿既有登记）。


## M18 收口（2026-09-25，欠账清理批次：MCP 剩余工具 / smoke 与 mock 补齐 两线并发）

- **MCP 工具面剩余工具 latin-1 迁移 ✅**（parity-np18-mcp-rest 23b19ba，merge 本轮）：沿 M17-B 同一模式补齐读侧 sftp_stat（裸包 LSTAT，uid/gid shell 查询尽力而为、字节边界失败回 null）/sftp_exists（**只认 SSH_FX_NO_SUCH_FILE 为不存在**，保留"权限错误绝不误报 exists:false"契约）/sftp_read_file（OPEN+READ 32KiB 分块，maxBytes 截断+offset 分页沿既有边界，读失败回退高层）；写侧 sftp_write_file（**直写** OPEN CREAT|WRITE|TRUNC——暂存是工作台上传族需求，MCP 沿既有直写语义）+sftp_chmod（SETSTAT）；sftp_copy/sftp_move 执行层确认远端 shell cp/mv、命令串字节不可控→**执行层不迁**（M17-A 边界保留），裸包车道迁移覆盖预检 + 同目录 move 的 RENAME 快路径（与工作台 M17-A 模式同构）。sftp_raw.rs 收编 M18-A 坠毁实例的留学生改动（read_file(offset,cap)/error_status 桩复用模块）并修复其测试两处小漏。PROTOCOL 遗留③销项 + MCP.zh-CN.md 工具表同步。
- **smoke 用例补齐 ✅**（parity-np18-smoke-m13fix 8753ab7，merge 本轮）：smoke_fs_test.py 补 9 用例（+252 行，Report.run + SKIP 机制 + needs 链式门控，幂等自清理 + 偏好快照还原）——latin-1 编码族真容器 6 链路（偏好写读→0xE9 字节名落盘→list 解码忠实→write/read 往返→exists 双形态+交叉反例→树下载逐字节→raw RENAME 收口）、每连接编码覆盖生效/回退 2、管线偏好钳制 1、MCP 面经 embedded 桥 mcp/call 往返 1（无需第二进程）。M14-M17"单测+smoke+对标"三件套欠账至此补清。
- **mockDbxHost Auto 场景 ✅**（同线 d2c74ce，M13 遗留 3 消化）：`?auth=auto|autofail` URL 参数驱动（与 ?err=* 先例同构）——AUTO_AUTH_ORDER 逐方式进度事件（形状镜像 authenticate_auto emitter，成功方式不发事件对齐真实）、全败聚合错误串、缺省零事件；3 条 vitest spec。
- **过程记录**：A 线首实例死于基础设施错误（Captcha timeout，第 3 次出现），遗留学生改动由重拉实例审用收编（含 2 处测试修复）——未触发转人工线。
- **全量终值（Windows 实测）**：backend cargo **950/950**（M17 后基线 940+10）/ clippy 0 / fmt 0；frontend vitest **1067/1067**（106 文件，1064+3）/ vue-tsc 0 / build 过（B 线前端改动为 mock/spec 不进产物包，ui/ 无变化）；两 merge 零冲突。

### M18 遗留

1. copy/move 执行层字节闭环需 exec 命令串支持非 UTF-8 字节参数（设计边界，已登记）；sftp_stat latin-1 下 uid/gid 对非 ASCII 名为 null（与工作台一致）。
2. smoke latin-1 组未覆盖 sftp/symlink-* 的 latin-1 路径（同族可按需补）；smoke_mcp.py stdio 面未新增（embedded 路径已覆盖同一工具实现）。
3. sftp_upload/sftp_download MCP 工具与 sudo 族维持既有策略（不在本批次范围）。
4. 工程面 backlog 持续为零；真机人工门沿既有登记。


## M19 收口（2026-09-25，编码保真家族收尾批次：MCP 传输工具 latin-1 / smoke symlink 补齐）

- **MCP sftp_upload/sftp_download latin-1 迁移 ✅**（parity-np19-mcp-io，M18 遗留 3 消化）：沿 M17-B/M18 同一模式（显示路径整条 `latin1_encode_display` 还原字节 + 连接级裸包客户端）——`sftp_upload` 走裸包 LSTAT 覆盖预检 + OPEN(CREAT|WRITE|TRUNC) 截断直写 + WRITE 32 KiB 分块（**选型**：沿既有 MCP 传输直写语义，无工作台上传族 `.dbx-part` 暂存需求；复用 M18 `sftp_write_file` 直写核心抽出的 `raw_sftp_write_bytes`，按工具各自响应形状组装）；`sftp_download` 走裸包 OPEN(READ)+READ 分块（`maxDownloadBytes+1` 探测封顶，超限沿 post-read 口径报错；目录 OPEN 被拒后落回高层给 auto 同款「is a directory」错误）。回退沿先例：download 读侧裸包任何失败回退高层重读、upload 写侧仅裸包建立失败回退；auto 模式行为不变（本地校验/传输根/敏感路径/大小上限均先于拨号不受影响）。单测 3 条（duplex 桩字节级）：upload 帧序+路径字节+载荷落帧、upload↔download 同显示路径 OPEN 帧字节一致 + 载荷逐字节回收（往返闭环）。PROTOCOL M19 节 + MCP.zh-CN.md 工具表同步。
- **smoke latin-1 组补符号链接三命令 ✅**（同线，M18 遗留 2 消化）：smoke_fs_test.py latin-1 组新增 `latin-1 symlink create/read/update round-trip` 用例（needs 链插在 raw rename 与每连接覆盖之间）——`sftp/symlink-create` 0xE9 字节链接名落盘 + 列表 kind=symlink、`sftp/symlink-read` 整条 wire 路径读指向、`sftp/symlink-update` 显示形式新指向再编码回字节后 read 回环验证（latin-1 域内读↔写精确闭环）；链接/锚点 finally 自清理，交还空目录给每连接覆盖组（沿用快照/自清理/needs 门控结构）。
- **遗留销项**：M18 遗留 2、3 销项；遗留 1（exec 命令串字节参数）维持设计边界登记。sudo 族维持既有策略（非编码家族范围）。


## M19 集成收口补记（2026-09-25，raw early-eof 根因修复 + 编码家族收官）

- **raw "early eof" 根因修复 ✅**（parity-fix-raw-eof 1b19a01，merge 本轮）：M18 CI ssh-smoke 真容器首次覆盖裸包客户端即爆雷（71 过/2 挂，`SFTP raw read failed: early eof`）——根因为 **`RawSftp::mkdir` 的 SSH_FXP_MKDIR 帧漏发规范强制的 ATTRS 字段**（draft-ietf-secsh-filexfer-02 §5.2），OpenSSH sftp-server `decode_attrib` 解析失败即 fatal 退出 → 通道 EOF；两失败用例的第一个 raw 操作都是 MKDIR，且 mkdir 回退仅在"裸包客户端建立失败"时触发、INIT 成功后操作错误原样上抛，故直穿到 smoke。修复：`build_mkdir` 携带 flags=0 空 attrs（OpenSSH 按 0777 & umask 建目录，与高层缺省一致）；既有宽松内存桩升级为**严格一致性桩**（draft-02 逐类型精确校验帧布局、违规 hexdump panic）+ `openssh_fatal_server` 负路径桩离线逐字复现 CI 错误串（`attrless_mkdir_reproduces_ci_early_eof_against_openssh_fatal_stub`）。russh 0.62.7 通道层排除（rx EOF 语义/自动扩窗核对）。
- **MCP 传输工具收官 ✅**（parity-np19-mcp-io 61b6e94，merge 本轮）：sftp_upload（裸包直写车道：LSTAT 预检 + OPEN CREAT|WRITE|TRUNC + WRITE 32KiB 分块）、sftp_download（裸包 OPEN+READ 分块，maxDownloadBytes+1 探测封顶；目录探测由高层给出一致错误）——latin-1 编码保真家族从列表/属性/单文件写/上传族/树到 MCP 工具面全链闭环。smoke latin-1 组补 symlink 三命令 0xE9 字节用例。
- **过程记录**：M19 线与修复 agent 各遭基础设施中断一次（captcha），分别以"审用半成品重拉"与"保留上下文续跑"恢复，均未触发转人工线。
- **全量终值（Windows 实测）**：backend cargo **957/957**（940+4 修复 +3 M19）/ clippy 0 / fmt 0；前端零改动沿 ecbc305 口径 vitest 1067 / vue-tsc 0 / build 过；两 merge 零冲突。
- **CI 复验预期**：ssh-smoke 全组 96 PASS / 0 FAIL 方向（M18 失败的 2 用例 + 连锁 SKIP 5 例恢复）。

## M19.5 真机复验轮（2026-09-25，Mac 容器实测：MKDIR 修复后连剥三层 wire 缺口至全绿）

- **CI 复验揭出修复只到第一层**：run 36155020114（含 1b19a015 MKDIR ATTRS 修复）ssh-smoke 仍红（3m10s），与 Mac 本地容器（同 linuxserver/openssh-server 镜像）复现完全一致（71 过/5 SKIP/2 挂，FAIL 仍报 `SFTP raw read failed: early eof`）——MKDIR ATTRS 是必要非充分。
- **诊断方法**：独立探针进程（russh 直连容器手搓 wire 帧）与 sidecar 临时 `[raw-trace]` 帧级日志对剖——探针侧 INIT/MKDIR(带 ATTRS)/LSTAT/OPENDIR 全部正常，把挂点逼进 sidecar 独有的帧内容；trace 显示 raw list 的第三笔请求 `type=16`，实锤第四层。连剥三层：
  1. **`FXP_READDIR` 常量错值 16（=REALPATH，规范值 12）**：raw 列表的 READDIR 实际发出 REALPATH 帧（4 字节 handle 被当路径且含 NUL）→ OpenSSH sftp-server fatal → 通道 EOF。离线桩测不出的根因是**自洽盲区**——`validate_request` 严格校验器用同一错误常量对照。修复：常量 12 + 新增 `request_type_codes_match_draft02_literals` 把全部 23 个类型码对 draft-02 **字面值**逐一对表（读帧字节而非读常量）。
  2. **`sftp/read` 缺 latin-1 车道**：M16 编码家族唯一漏网（wire 路径直入高层客户端按 UTF-8 open → NO_SUCH_FILE）。修复：分发层按 `resolve_sftp_encoding` 分支，Latin1 走 `raw_read_chunk`（download 分片同款整条 wire 还原 + 裸包 READ；多读 1 字节对齐高层 `truncated` 语义）。
  3. **树下载逐文件读取无 raw 车道**：扫描是 raw READDIR 字节保真（files 的 remote_path 为 wire 形式），但分块读取高层 open → NO_SUCH_FILE 记 failure 跳过 → 本地缺文件（只剩空目录骨架）。修复：`TreeDownloadState.latin1` 标记，latin-1 下逐文件分块走 `raw_read_chunk`，实现与本节 PROTOCOL「分块下载按转义自动走 raw READ」的既有声明对齐。
- **Mac 真机终值**：smoke_fs_test **79 PASS / 0 SKIP / 0 FAIL**（71/5/2 → 全组恢复，含 M18 两条失败用例与 np19 symlink 用例）；全量 cargo **963/963**（win 957 + 字面值对表 1，mac 口径 963）/ clippy 0 / fmt 0 / vitest 1067 / vue-tsc 0 / build 过（ui/ 无变化还原）。
- **过程记录**：接力会话接手时交接的 Windows 修复线（E:\...np19-fix-raw-eof）已在远端完成收口（0c1b3dad docs(m19)）；Mac 侧重建 worktree 后先复验揭出上述三层，全部改动在本轮一并落地（codex/ssh/parity-fix-raw-eof 分支续用）。

## M20 批次（2026-09-26，watcher 外部编辑真容器链路收口：smoke +3 至 82/82 全绿）

- **批次来源**：M19.5 后工程 backlog 清零（交接口径），从"真机人工门"清单里挑可自动化部分立项——「多文件 watcher 外部编辑全链路」此前只有前端 watchEdits 单测与 file_watch 单测，smoke 层零覆盖。
- **新增**：smoke_fs_test.py watcher external-edit 组 3 用例——双文件并发注册（watchId 互异）、外部保存按 watchId 精确路由 + upload-back 远端字节校验 + 同内容重复保存 sha256 去重、stop 精确移除 + stop-all 全清。localPath 沿工作台 `openInExternalEditor` 同一分工（`sftp/download/start` 带 `downloadDir=<下载目录>/remote-edit/<stamp>/`），落在 `validate_remote_edit_path` 白名单域内。
- **用例开发中顺带确认的行为点**（非缺陷，均已登记进用例注释）：pump 有 SUPPRESS_WINDOW=2s 启动抑制窗（编辑器预热噪音丢弃），外部编辑用例须先越过；持久档 `sftp_name_encoding` 历史残留会让 auto 语义用例误走 latin-1 裸包分支，watcher 组进组显式归位 auto 自洽。
- **Mac 真机终值**：smoke_fs_test **82 PASS / 0 SKIP / 0 FAIL**；backend 代码零改动，cargo 963 / clippy 0 / fmt 0 沿 M19.5。

## M21 批次（2026-09-26，latin-1 watcher 回写收口 + 第五层 wire 缺口修复）

- **批次来源**：M20 的真机门清单明确承认「latin-1 连接下的 watcher 回写」只有单测覆盖——本轮补真容器全链：wire 路径注册 → 外部保存事件 → `watch/upload` 裸包回写 → `sftp/read` wire 车道字节校验（smoke 83/0/0）。
- **第五层 wire 缺口修复**：`sftp/download/start` 转义路径的 size 探测发 raw LSTAT 时漏 `unescape_wire`（字面 `%XX` 字节当路径，start 即 NO_SUCH_FILE）——M21 用例真机曝露。修复一行探测调用 + 注释；与下载分片（`raw_read_chunk`）、树扫描（`scan_tree_with_raw`）的既有还原口径拉齐。该缺口此前不可见：wire 单文件下载此前无真容器用例，树下载 size 走扫描不经探测点。
- **Mac 真机终值**：smoke_fs_test **83 PASS / 0 SKIP / 0 FAIL**；cargo 963 / clippy 0 / fmt 0。
