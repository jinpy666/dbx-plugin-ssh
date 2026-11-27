# SSH 模块拆分实施计划（`backend/src/ssh.rs`）

- 基线：`f5052f88a4d697f1996109750e7510cdd196a3af`（本次工具/计划任务分支 `codex/ssh/refactor-tooling`）
- 对象：`backend/src/ssh.rs`，`wc -l` = **18,457**
- 原则：**只做代码搬移与可见性调整，不改行为、协议、凭证路径**；`ssh.rs` 始终保留为模块根（Rust 2018+ 允许 `ssh.rs` 拥有 `ssh/` 子模块目录），因此所有 `crate::ssh::X` 路径保持不变，外部 20 个引用文件零改动。
- 工具边界：`scripts/refactor/move-file.mjs` 只支持 `frontend/src`。Rust 侧**不做文件移动**，只新增 `backend/src/ssh/*.rs` 子模块并由 `ssh.rs` 声明/再导出；`move-file.mjs` 对 `backend/src` 显式拒绝（exit 6），原因见该文件头注释。

> 行号均为基线文件坐标（`ssh.rs:NNNN`）。批次执行后行号会漂移，后续批次按符号名定位，不按旧行号。

## 1. 测量方法与清单

### 1.1 方法

1. 总量：`wc -l backend/src/ssh.rs`。
2. 分区：用固定行窗口逐行匹配 `^(pub(\([^)]*\))? )?(async )?fn`、`struct`、`enum`、顶层 `^impl`；`fn` 统计包含 `impl` 内方法；`struct/enum` 同时给出 `pub/总数`。完整脚本见附录 A.1，输出即下表（数值含空行/注释）。
3. 最大函数：按“下一个 `fn` 起始行 − 当前行”计算函数体跨行数，只保留 `pub` 函数，见 A.2。
4. 依赖：`grep -rn 'crate::ssh' backend/src --include='*.rs' --exclude='ssh.rs'`；出边用 `grep -nE '^use crate::' backend/src/ssh.rs`；方法调用用 `.method(` 反向扫描并剔除 `push/release/after` 等同名通用方法。

### 1.2 分区清单

| 区 | 范围 | 行 | pub fn | fn 总 | struct(pub/总) | enum(pub/总) | impl |
|---|---|---:|---:|---:|---:|---:|---:|
| A 前置/认证配置 | 1–331 | 331 | 3 | 11 | 0/0 | 0/1 | 1 |
| B 用户输入/Prompt | 332–721 | 390 | 5 | 16 | 0/2 | 0/0 | 3 |
| C 主机密钥/客户端 | 722–1280 | 559 | 0 | 22 | 0/3 | 0/3 | 4 |
| D 传输/共享状态 | 1281–2067 | 787 | 9 | 31 | 0/12 | 0/4 | 8 |
| E 会话建立 | 2068–3631 | 1,564 | 12 | 14 | 0/1 | 0/0 | 1 |
| F 端口转发 | 3632–4006 | 375 | 4 | 8 | 0/0 | 0/0 | 0 |
| G 终端会话 | 4007–4438 | 432 | 12 | 18 | 0/0 | 0/0 | 0 |
| H SFTP 会话管线 | 4439–4665 | 227 | 12 | 14 | 0/0 | 0/0 | 0 |
| I 执行/Agent 审批 | 4666–5449 | 784 | 10 | 16 | 0/0 | 0/0 | 0 |
| J SFTP 文件操作 | 5450–5910 | 461 | 10 | 13 | 0/0 | 0/0 | 0 |
| K 指标/录制 | 5911–6044 | 134 | 6 | 8 | 0/0 | 0/0 | 0 |
| L 设置/配置档案 | 6045–6562 | 518 | 13 | 16 | 0/0 | 0/0 | 0 |
| M 上传 | 6563–7849 | 1,287 | 5 | 11 | 0/0 | 0/0 | 0 |
| N 下载 | 7850–10999 | 3,150 | 6 | 29 | 0/0 | 0/0 | 0 |
| O 传输登记 | 11000–11494 | 495 | 4 | 13 | 0/0 | 0/0 | 0 |
| P 认证流程/私钥 | 11495–12412 | 918 | 1 | 30 | 0/1 | 0/0 | 0 |
| Q Agent 认证 | 12413–12602 | 190 | 0 | 2 | 0/0 | 0/2 | 0 |
| R 远端树辅助 | 12603–12979 | 377 | 1 | 10 | 0/0 | 0/0 | 0 |
| S 上传元数据 | 12980–13143 | 164 | 0 | 6 | 0/0 | 0/0 | 0 |
| T 传输路径/权限 | 13144–13359 | 216 | 1 | 5 | 0/1 | 0/0 | 0 |
| U SFTP 辅助 | 13360–13920 | 561 | 6 | 34 | 0/0 | 0/0 | 0 |
| V 测试 | 13921–18457 | 4,537 | 0 | 181 | 0/5 | 0/1 | 0 |
| **合计** |  | **18,457** |  |  |  |  |  |

测试占比：`V` 区 4,537 行，其中 `mod tests` 4,504 行（`13954–18457`）、`mod channel_error_tests` 28 行（`13921–13948`），`plugin_error` 3 行（`13950–13952`）夹在两段测试之间。生产代码 13,923 行（18,457 − 4,532 测试 − 2 个分隔空行）。

### 1.3 最大公开函数（允许清单依据）

```text
2273  880  open_session
6974  654  finish_upload
8565  294  start_download
9316  275  start_tree_download
10185 215  download_chunk
6563  196  start_upload
6112  190  settings_set
3663  183  forward_start
4875  158  exec_in_terminal
10554 147  cancel_transfer
4676  122  exec
11076 111  transfer_status
```

`open_session`（`ssh.rs:2273-3152`）与 `finish_upload`（`ssh.rs:6974-7627`）是单函数，按文件拆分无法降到 600 行以下；本计划只搬移，后续 B7 再做函数内拆分。

## 2. 依赖边界

### 2.1 入边：谁引用 `crate::ssh::*`

共 **20 个文件**（19 个代码文件 + `local_target.rs` 仅文档链接）：

| 文件 | 引用符号 |
|---|---|
| `main.rs:93` | `connection_id_param`, `filesystem_path`, `PromptDecision`, `SshRuntime` |
| `mcp.rs:38-41` | `classify_raw_kind`, `sftp_client_config`, `RawSftpClient`, `SshClient`, `SshRuntime`, `NO_TERMINAL_SESSION_MESSAGE` |
| `sftp_ext.rs:22-25` | `apply_preserved_permissions`, `format_permissions`, `lookup_owner_group_names`, `RawSftpClient`, `SshRuntime` |
| `task_provider.rs:58` | `sftp_client_config`, `SshClient`, `SshRuntime` |
| `forward.rs:30` | `RemoteForwardTable`, `SshClient` |
| `monitor.rs:25` | `SshClient`, `SshRuntime` |
| `sftp_copy.rs:24` | `RawSftpClient`, `SshRuntime` |
| `exec.rs:17`, `metrics.rs:24`, `metrics_gpu.rs:21` | `SshClient` |
| `sudo_download.rs:31`, `sudo_fs.rs:14`, `completion/executor.rs:12` | `SshRuntime` |
| `file_watch.rs:516` | `&crate::ssh::SshRuntime` 参数 |
| `local_terminal.rs:38`, `telnet_session.rs:62`, `serial_session.rs:356` | `ReplayBuffer` |
| `keys.rs:50` | `private_key_decode_failure`（限定路径调用） |
| `local_target.rs:12` | 仅 rustdoc 链接 `crate::ssh::SshRuntime` |

外部通过 `SshRuntime` 调用的方法（必须保持 `pub`/`pub(crate)`）：`open_session`, `close_session`, `close_workbench`, `exec`, `exec_in_terminal`, `append_upload`, `finish_upload`, `start_download` 系列, `download_chunk`, `complete_download`, `cancel_transfer`, `transfer_list/status/history`, `forward_*`, `sftp_*`, `settings_*`, `profiles_*`, `metrics*`, `recording_*`, `agent_*`, `ensure_sudo_allowed`, `ensure_writable`, `data_dir`, `has_connection`, `has_live_session`, `local_target`, `live_handle_for_connection`, `known_hosts_path`, `batch_terminal_input`, `attach_session`, `connect_headless` 等。

### 2.2 出边：`ssh.rs` 依赖谁

`ssh.rs:27-62` 共 **28** 个 `use crate::...`：

`agent_approvals`, `agent_terminal`, `audit_log`, `exec`, `forward`, `highlight_rules`, `host_key`, `local_downloads`, `metrics`, `metrics_history`, `model`, `otp`, `otp_store`, `quick_commands`, `session_recording`, `sftp_ext`, `sftp_name`, `sftp_raw`, `sftp_tree`, `ssh_algorithms`, `startup_commands`, `sudo_download`, `sudo_profiles`, `transfer_compress`, `transfer_history`, `transfer_multistream`, `transfer_throttle`, `triggers`。

其中 `exec.rs`、`forward.rs`、`metrics.rs`、`metrics_gpu.rs`、`monitor.rs`、`mcp.rs`、`sftp_copy.rs`、`sftp_ext.rs`、`sudo_download.rs`、`sudo_fs.rs`、`task_provider.rs` 又反向引用 `crate::ssh`，已存在模块级循环；本次拆分不改变模块图（所有新文件仍在 `crate::ssh` 下），循环结构不变。

### 2.3 拆分约束

1. **根再导出契约**：新子模块中的类型/函数必须在 `ssh.rs` 以原可见性再导出（`pub`/`pub(crate)`/`pub(crate)`），20 个外部文件不修改 import。
2. **`SshRuntime` 结构体留在 `ssh.rs` 根**（`ssh.rs:2002-2067`），字段保持私有。子模块中的 `impl SshRuntime` 可以直接访问祖先模块的私有字段；这样避免 60+ 字段可见性改动，也避免外部类型路径变化。
3. **移动的类型改 `pub(super)`，字段改 `pub(super)`**：`SessionEntry`、`UploadState`、`DownloadState`、`MultistreamState`、`TreeDownloadState`、`UploadPhase` 等（`ssh.rs:1425-1882`）移入 `ssh/state.rs` 后，根和兄弟子模块仍可访问；仅在 `ssh` 子树内可见，不扩大外部 API。
4. **方法可见性**：外部调用保持 `pub`/`pub(crate)`；兄弟模块互调用 `pub(super)`；同文件私有方法保持私有。方法名与签名不改。
5. **模块名不能与根 `use` 名冲突**：根已 `use russh::client...`、`use crate::exec`、`use crate::forward`、`use crate::metrics`，因此子模块命名为 `ssh_client.rs`、`exec_methods.rs`、`port_forward.rs`，不使用 `client.rs`/`exec.rs`/`forward.rs`。
6. **每个新文件以 `use super::*;` 开头**（测试文件沿用现有 `use super::*` 语义），再按需补显式 import；根再导出的符号对子模块可见。

## 3. 批次计划

通用验收（每批都执行）：

```bash
cargo fmt --manifest-path backend/Cargo.toml --check
cargo check --locked --manifest-path backend/Cargo.toml --all-targets
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path backend/Cargo.toml
python3 scripts/validate_repo.py
node scripts/mock_host_registry_check.mjs   # 分派表/ mock 注册表不得变化
wc -l backend/src/ssh.rs backend/src/ssh/*.rs
```

测试数不变量（每批前后对比）：

```bash
cargo test --locked --manifest-path backend/Cargo.toml -- --list | grep -c ': test$'
```

每批一个 commit（B6 拆 6a/6b 两个 commit）；高风险批次按 AGENTS.md 由人审。

### B1 测试搬移（最低风险，先做）

- 新建：`backend/src/ssh/tests.rs` ← `ssh.rs:13954-18457`（4,504 行）；`backend/src/ssh/channel_error_tests.rs` ← `ssh.rs:13921-13948`（28 行）。
- 搬移：`#[cfg(test)] mod tests { use super::*; ... }` 整块；`mod channel_error_tests`；`use super::is_channel_level_sftp_error` 语义不变（文件成为 `ssh` 子模块后 `super` 仍是 `ssh` 根）。
- 留在根：`plugin_error`（`ssh.rs:13950-13952`）及全部生产代码。
- 根变更：两段内联模块替换为 `#[cfg(test)] mod channel_error_tests;` 与 `#[cfg(test)] mod tests;`（+4 行）。
- 风险：**低**。不触碰 auth/exec/secret。
- 验证：`cargo test --locked`；测试数前后一致；`cargo fmt --check`。
- 行数：`ssh.rs` 18,457 → 约 13,929。

### B2 SFTP 会话/文件操作/监控/设置（中等风险）

- 新建（均 `<600`）：
  - `ssh/sftp_session.rs` ← `ssh.rs:4439-4665`（227）：`ensure_sudo_allowed`、`sftp`、`invalidate_sftp_cache`、`sftp_with_compat`、`compat_hint`、`sftp_home`、`connection_id_for_session`、`session_id_for_connection`、`stored_connection`、`store_local_target`、`drop_local_target`、`local_target`、`has_live_session`、`task_transport`。
  - `ssh/sftp_ops.rs` ← `ssh.rs:5450-5910`（461）：`sftp_list_path`、`sftp_read_path`、`sftp_create_directory`、`sftp_write_path`、`sftp_rename`、`sftp_delete`、`sftp_chmod`、`sftp_disk_usage`、`raw_sftp_client`/`raw_read_chunk*`。
  - `ssh/monitor.rs` ← `ssh.rs:5911-6044`（134）：`metrics`、`processes_list`、`kill_process`、`metrics_history`、`recording_start/stop`、`cached_metrics_snapshot/store`。
  - `ssh/settings.rs` ← `ssh.rs:6045-6562`（518）：`settings_get/set`、`profiles_*`、`quick_commands_*`、`highlight_rules_*`、`sync_auto_sudo`、`sync_triggers`、`refresh_bound_sessions`。
  - `ssh/sftp_helpers.rs` ← `ssh.rs:13360-13920`（561）：`RawSftpClient` 类型别名、`classify_entry_kind`、`classify_raw_kind`、`format_permissions`、`lookup_owner_group_names`、`sftp_client_config`、`sftp_error`、`is_channel_level_sftp_error`、`filesystem_path`、`connection_id_param`。
- 留在根：`SshRuntime`/`PendingChallenge`、前置 A 区、下载/上传等后续区段。
- 根再导出（按原可见性）：`SshRuntime` 不动；`pub use sftp_helpers::{classify_raw_kind, connection_id_param, filesystem_path};`、`pub(crate) use sftp_helpers::{RawSftpClient, format_permissions, lookup_owner_group_names, sftp_client_config};`；`ensure_sudo_allowed`/`sftp` 等保持 `pub`/`pub(crate)`。
- 风险：**中**。`settings.rs` 的 `profiles_save/reveal/delete` 经 `sudo_profiles` 读写/回显 sudo 密码与 TOTP（`backend/src/sudo_profiles.rs:31-38`）→ **触及 secret binding，需要人审**。
- 验证：通用验收 + `cargo test` 中 `settings/profiles` 用例；`mcp.rs` 对 `sftp_client_config`/`RawSftpClient` 的 import 不改。
- 行数：约 1,901；根约 12,028。

#### B2 执行记录（B2a / B2b 均已落地，B2b 待人审）

B2 拆成两批执行，`settings.rs` 单列为 **B2b**：

- **B2a（已完成）**：`sftp_session` / `sftp_ops` / `monitor` / `sftp_helpers` 四块，`ssh.rs` 13,929 → **12,829**，四个新文件分别 234 / 465 / 135 / 289 行（均 <600）。测试名集合与 `#[test]` 计数（1,384）前后一致，clippy/check/全量测试/结构护栏全绿。
- **B2b（已完成，待人审）**：新建 `ssh/settings.rs` **527 行**，`ssh.rs` 11,787 → **11,264**（删 523 行函数体 + 1 行接缝空行，加 1 行 `mod settings;`）。搬移 16 个符号：`settings_get`、`settings_set`、`profiles_list/reveal/options/save/delete`、`quick_commands_list/save/delete`、`highlight_rules_list/save/delete`、`sync_auto_sudo`、`sync_triggers`、`refresh_bound_sessions`；基线实际区间 `ssh.rs:4184-4706`（文档注释起，至 `refresh_bound_sessions` 收尾 `}`）。纯搬移：函数体/签名/文档注释零改动，逐符号与基线规范化比较（仅归一 `pub(super) ` 前缀）逐字符相同。
  - 可见性调整（仅 3 处，均最小提升）：`sync_auto_sudo`、`sync_triggers` 私有 `fn` → `pub(super)`（`ssh.rs` 调用点 1126-1127、1461-1462）；`refresh_bound_sessions` 私有 `async fn` → `pub(super) async fn`（模块内 `settings_set`/`profiles_save`/`profiles_delete` 调用）。其余 13 个 `pub` 方法对外可见性完全保持，`main.rs`/`mcp.rs` 调用点零改动。
  - 验证：`check --all-targets` / `clippy --all-targets -D warnings` / 全量测试 1,384 通过（`--test-threads=1`）/ 测试名集合 diff 为空 / `mock_host_registry_check.mjs` PASS / 结构护栏 `--write` + `--check` 通过 / `fmt --check` 无新增失败（基线 7 处不变，`ssh.rs:2237` 因插入 `mod` 挪到 2238）。
  - 该文件读写 sudo 密码与 TOTP，按 AGENTS.md 属 **secret binding**，仍需人工评审后方可合并。

与本文原始估计的偏差（后续批次请以符号为准，行号只当锚点）：

1. **行号区间普遍偏 ±5~10 行**：多数区间起点落在文档注释上一行、终点落进下一个条目的文档。B2a 实际搬移：sftp_session `4429-4658`、sftp_ops `5445-5904`、monitor `5906-6036`。
2. **`sftp_helpers` 区间不连续**：`13343-13566` 与 `13858-13919` 才是 SFTP/权限/错误相关代码；中间 `13568-13857`（约 290 行）是终端/提示符工具（`directory_tracking_marker`、`decode_stream_text`、`prompt_tail_len`、`detect_remote_shell` 等），属 B3/终端批次，留在原地。这是 B2 实际落在 12,829 而非 12,546 的原因。
3. **可见性不能照抄计划**：`classify_raw_kind` 原为 `pub(crate)`，写成 `pub use` 会触发 E0364；B2a 改为 `pub(crate) use`，保持原可见性。同理，被父模块/测试模块调用的子模块内部项需提升为 `pub(super)`（`raw_read_chunk_cached`、`cached_metrics_snapshot`、`store_metrics_snapshot`、若干 helper）。
4. **符号名以代码为准**：计划写的 `cached_metrics_store` 实际是 `store_metrics_snapshot`。
5. 白名单随每批收紧：`ssh.rs` 由 18,457 → 13,929（B1）→ **12,829**（B2a），用 `scripts/refresh_structure_allowlist.mjs --write` 机械刷新，禁止手写行数。
6. **B2b 区段与符号清单对不上**：计划的 `ssh.rs:6045-6562`（518 行）不含 `quick_commands_*` / `highlight_rules_*` 两个条目，且估计的起止把相邻条目切成两段。实测 16 个符号是**一段连续代码**（`ssh.rs:4184-4706`，523 行），条目之间没有需要单独搬运的私有 helper，因此整段搬运、未做任何拼接。另：`mod settings;` 受 rustfmt `reorder_modules` 约束，必须排在 `mod sftp_helpers;` 之前（不是按加入顺序放在 `mod sftp_session;` 之后），否则 `cargo fmt --check` 新增失败。

### B3 传输原语与共享状态（中等偏高，耦合最大）

- 新建（均 `<600`）：
  - `ssh/prompt.rs` ← `ssh.rs:332-721`（390）：`PromptDecision`、`PromptBroker`、`PendingPrompt`、`HostPromptGateway`、`SdkHostPromptGateway`、`host_supports_user_input`。
  - `ssh/transport.rs` ← `ssh.rs:1281-1352`（72）：`ReplayBuffer`、`RemoteForwardTable`。
  - `ssh/leases.rs` ← `ssh.rs:1353-1424`（72）：`TransportLeaseCounter`、`SharedTransportLease`。
  - `ssh/state.rs` ← `ssh.rs:1425-1882`（458）：`SessionEntry`、`UploadState`、`DownloadState`、`MultistreamState`、`TreeDownloadState`、`UploadPhase`、`upload_cancel_error`、`SudoKeepalive`、`KeepaliveRegistration`、`CachedMetrics`、`unix_now_secs/ms`、`cached_metrics_payload`。
  - `ssh/endpoint.rs` ← `ssh.rs:1883-2001`（119）：`ConnectionEndpoint`、`TaskTransport`。
- 留在根：`SshRuntime`（`ssh.rs:2002-2067`）、`PendingChallenge`（`2068-2075`）、A 区前置。
- 可见性：`state.rs` 全部类型/字段 `pub(super)`；根用私有 `use state::*;` 供各子模块 `use super::*` 继承。`ReplayBuffer` 保持 `pub(crate)`（外部 3 文件）；`RemoteForwardTable` 保持 `pub`（`forward.rs`）；`PromptDecision` 保持 `pub`（`main.rs`）；`upload_cancel_error` 保持 `pub(crate)`（`sftp_ext.rs`）。内部符号根用私有 `use module::*;`，外部符号才用 `pub`/`pub(crate) use`。
- 风险：**中高**。`state.rs` 被所有后续 impl 访问，字段可见性改动面大；纯机械、编译器可验证。不触碰 auth/exec/secret。
- 验证：通用验收；重点 `cargo check` 全 target，确认无 `private field` 错误；`forward.rs`/`local_terminal.rs`/`telnet_session.rs`/`serial_session.rs` 不改 import。
- 行数：约 1,111；根约 10,917。

#### B3 执行记录（已完成）

实际落地：`ssh.rs` 12,829 → **11,787**，五个新文件 prompt 388 / transport 73 / leases 75 / state 461 / endpoint 65（均 <600）。测试名集合与 `#[test]` 计数（1,384）不变，`check --all-targets` / `clippy -D warnings` / 全量测试 / 结构护栏全绿；`forward.rs`、`local_terminal.rs`、`telnet_session.rs`、`serial_session.rs`、`mcp.rs`、`sftp_ext.rs`、`main.rs` **零改动**。

与计划的偏差（B4–B6 请沿用同样的处理方式）：

1. **预计数字偏低**：计划按 `endpoint` 区间 119 行估算，但该区间含 `session_info_payload` 与传输排序约 56 行，不属于目标符号；按符号搬移实际 63 行。最终 11,787 而非 10,917。
2. **可见性必须按编译器错误逐条放宽**，且只放宽到 `pub(super)`：
   - `ReplayBuffer` 字段 → `pub(super)`（根 `ssh.rs` 与 `ssh/tests.rs` 直接读字段，触发 E0616）
   - `TransportLeaseCounter` / `SharedTransportLease` 的结构体、字段与方法（含 `async fn release`）→ `pub(super)`（E0616/E0624）
   - `PromptBroker::request` / `request_keyboard_interactive_answer` → `pub(super)`（根调用，E0624；提前处理避免二次改）
   - `state.rs` 按计划全量 `pub(super)`，并额外纳入 `sudo_upload_staging_name`、`sudo_commit_body`、`SUDO_UPLOAD_*`、`upload_progress_payload`（根与测试有调用点）
3. **对外可见性一律保持原样**：`PromptDecision` `pub`、`ReplayBuffer` `pub(crate)`、`RemoteForwardTable` 为 `pub type`、`upload_cancel_error` `pub(crate)`、`HostPromptGateway`/`TaskTransport` `pub(crate)`、`ConnectionEndpoint` `pub`。
4. `transport.rs` 不需要私有 `use transport::*;`：两个符号都显式再导出，加 glob 反而被 clippy 判为未使用。
5. rustfmt 因 `pub(super)` 让 `MultistreamState::stream_handle` 超 100 列而换行、并调整了根 import 排序——`fmt --check` 仍只剩基线那 7 处。
6. （B4 补记，B5/B6 务必照做）**`use super::*` 不会把上层模块 glob 导入的私有名字再传一层**：把自由函数搬进子模块后，只要根用 `use module::*;` 引入，`ssh/tests.rs` 等更深一层模块仍会报 `cannot find function`。可行做法只有两种——在根/调用方写**显式** `use module::{a, b};`（显式绑定可跨 glob 传递），或让调用方直接 `use super::module::item;`。方法（`impl SshRuntime`）不受影响：`pub(super)` 对根及其所有后代都可见。


### B4 上传管线与传输登记（高风险）

- 新建：
  - `ssh/upload.rs` ← `ssh.rs:6563-6973`（411）：`start_upload`、`decide_transfer_compression`、`probe_remote_compress_tools`、`open_resume_spool`、`upload_session_id`、`resumable_uploads`、`append_upload`。
  - `ssh/upload_finish.rs` ← `ssh.rs:6974-7627`（654，**允许清单**）：`finish_upload` 单函数。
  - `ssh/upload_compress.rs` ← `ssh.rs:7628-7849`（222）：`commit_sudo_upload`、`compress_upload_spool`、`push_compressed_stream`。
  - `ssh/transfer_registry.rs` ← `ssh.rs:11000-11494`（495）：`transfer_list/status/history_query`、`record_transfer*`、`cleanup_session_transfers`、`active_transfer_count`、`transfer_depth_limit`。
  - `ssh/upload_meta.rs` ← `ssh.rs:12980-13143`（164）：`read/write/remove_upload_meta`、`sweep_stale_transfer_temps`、`resumable_uploads_from`、`copy_dir_recursive`。
  - `ssh/transfer_paths.rs` ← `ssh.rs:13144-13359`（216）：`remote_transfer_paths`、`preserved_target_permissions`、`apply_preserved_permissions`、`CommitPlan`、`commit_plan`、`commit_remote_file`。
- 留在根：`SshRuntime`/`PendingChallenge`/A 区。
- 再导出：`pub(crate) use transfer_paths::apply_preserved_permissions;`（`sftp_ext.rs`/`mcp.rs` 使用）；其余内部符号 `pub(super)`。
- 风险：**高**。`commit_sudo_upload` 调 `crate::sudo_fs::sudo_exec`（`ssh.rs:7645-7658`），`finish_upload` 含 sudo 提交/压缩路径；**触及 command execution，需要人审**。
- 验证：通用验收 + 上传/断点续传/压缩相关 `cargo test`；`git diff` 确认无 `sudo_exec`/命令字符串变化。
- 行数：约 2,162；根约 8,755。

#### B4 执行记录（已完成，待人审）

基线 `24468407`（`ssh.rs` 11,264 行）。按符号搬移 37 个条目（36 个计划符号 + 1 个随 `sweep_stale_transfer_temps` 一并搬走的常量），六个新文件均以 `use super::*;` + 独立 `impl SshRuntime` 块承载（同 B2a/B3 写法）：

| 新文件 | 基线实际区间（1-based，含文档注释/属性） | 搬移条目 | 文件行数 |
|---|---|---|---|
| `ssh/upload.rs` | `4185-4587`（403） | `start_upload`、`decide_transfer_compression`、`probe_remote_compress_tools`、`open_resume_spool`、`upload_session_id`、`resumable_uploads`、`append_upload` | 408 |
| `ssh/upload_finish.rs` | `4589-5243`（655） | `finish_upload`（单函数，未拆） | 661 |
| `ssh/upload_compress.rs` | `5245-5469`（225） | `commit_sudo_upload`、`compress_upload_spool`、`push_compressed_stream` | 229 |
| `ssh/transfer_registry.rs` | `8623-9115`（493） | `transfer_list/status/history_query`、`clear_transfer_history`、`build_transfer_history`、`live_transfer_rows`、`record_transfer*`、`persist_transfer_record`、`session_connection_id`、`transfer_depth_limit`、`active_transfer_count`、`cleanup_session_transfers` | 498 |
| `ssh/upload_meta.rs` | `10601-10765`（165） | `read/write/remove_upload_meta`、`sweep_stale_transfer_temps`、`resumable_uploads_from`、`copy_dir_recursive`（+ `UPLOAD_SPOOL_RETENTION`） | 167 |
| `ssh/transfer_paths.rs` | `10767-10964`（198） | `remote_transfer_paths`、`preserved_target_permissions`、`apply_preserved_permissions`、`CommitPlan`、`commit_plan`、`commit_remote_file` | 203 |

- 行数：`ssh.rs` 11,264 → **9,128**（删 2,145 行 = 2,139 行条目 + 5 行条目间空行 + 1 行 impl 尾部空行，加 9 行 `mod`/`use`/再导出）；六个新文件 2,166 行。`upload_finish.rs` 661 行、`ssh/tests.rs` 4,472 行由 `scripts/refresh_structure_allowlist.mjs --write` 自动登记（未手写数字）。
- 可见性调整（25 处，全部为最小提升，`pub` 一律不降级）：
  - `upload.rs`：`decide_transfer_compression`、`open_resume_spool` → `pub(super)`。
  - `upload_compress.rs`：`commit_sudo_upload`、`compress_upload_spool`、`push_compressed_stream` → `pub(super)`（调用点在 `ssh::upload_finish`，兄弟模块）。
  - `transfer_registry.rs`：`build_transfer_history`、`record_transfer`、`record_transfer_start`、`session_connection_id`、`transfer_depth_limit`、`active_transfer_count`、`cleanup_session_transfers` → `pub(super)`；`live_transfer_rows`、`persist_transfer_record` 仅模块内调用，保持私有。
  - `upload_meta.rs`：六个函数全部 → `pub(super)`；`UPLOAD_SPOOL_RETENTION` 保持私有。
  - `transfer_paths.rs`：`remote_transfer_paths`、`preserved_target_permissions`、`commit_plan`、`commit_remote_file` → `pub(super)`；`CommitPlan` 与其两个字段 `backup_rename`/`permissions` → `pub(super)`（`ssh/tests.rs` 直接读字段）；`apply_preserved_permissions` 保持 `pub(crate)`。
  - 保持原样：`start_upload`/`finish_upload`/`upload_session_id`/`resumable_uploads`/`append_upload`/`transfer_list`/`transfer_status`/`transfer_history_query`/`clear_transfer_history` 均 `pub`；`probe_remote_compress_tools` 只被同文件的 `decide_transfer_compression` 调用，保持私有。
- 再导出与 `use`（编译器驱动的必要管道，`main.rs`/`mcp.rs`/`sftp_ext.rs` 调用点零改动）：
  - 根新增 `pub(crate) use transfer_paths::apply_preserved_permissions;`（`sftp_ext.rs` 从 `crate::ssh` 导入）；`mcp.rs` 实际无该符号调用点（计划里写的一并适用不成立）。
  - 根新增 `use transfer_paths::remote_transfer_paths;`、`use upload_meta::{copy_dir_recursive, remove_upload_meta, sweep_stale_transfer_temps};`（根自身有调用点）。子模块间的自由函数不能经 `use super::*` 传递（glob 导入不再被上层 glob 再导出），故由调用方显式导入：`ssh/upload.rs`（3 个 meta 助手）、`ssh/upload_finish.rs`（`commit_remote_file`/`remote_transfer_paths`/`remove_upload_meta`）、`ssh/transfer_registry.rs`（`remove_upload_meta`）、`ssh/sftp_ops.rs`（`commit_remote_file`/`remote_transfer_paths`，+1 行）、`ssh/tests.rs`（+2 行）。
  - `mod` 与 `use` 按 rustfmt 字母序插入；每个子模块仍以 `use super::*;` 取根作用域（需要兄弟模块自由函数时，在其上方再加 1-3 行显式 `use super::<mod>::{..};`）。
- 保真：`python3 scripts/refactor/b4_verify_move.py fidelity` → 36/37 条目在仅归一 `pub(super) `/`pub(crate) ` 前缀后逐字符相同；唯一差异是 `remote_transfer_paths` 的签名被 rustfmt 换行（`pub(super) ` 使单行 104 列，另加参数尾逗号），token 流完全一致，属可见性调整的必然排版结果。
- 命令面：`python3 scripts/refactor/b4_verify_move.py surface` → 37 个条目的**全部**字符串字面量（顺序、内容）与 `sudo_exec`/`Command::new`/`ssh2::` 行逐条相同（`commit_sudo_upload` 的 2 条 `crate::sudo_fs::sudo_exec` 均在搬移条目内），根剩余部分 1,133 个字面量与基线一致，零差异。
- 自检脚本与原始输出留在仓库：`scripts/refactor/b4_verify_move.py`（`fidelity` / `surface` 两个子命令，`--base` 可换基线）；输出 `scripts/refactor/b4-verification/{fidelity,command-surface,cargo-fmt-check,validation}.txt`。
- 验证：`cargo check --all-targets` 干净；`cargo clippy --all-targets -- -D warnings` 通过；全量测试 `--test-threads=1` 1,384 通过（测试名集合 diff 为空、`#[test]` 计数 1,384 不变）；`node scripts/mock_host_registry_check.mjs` PASS；`node scripts/refresh_structure_allowlist.mjs --check` PASS；`cargo fmt --check` 仍只剩基线 7 处（`proxy.rs` ×6、`ssh.rs` 原 2,238 现 2,247）。
- 与 B4 计划估计的偏差：
  1. 行号锚点整体偏移（符号位置才是准绳）：`upload` 计划 6,563-6,973 → 实际 4,185-4,587；`transfer_registry` 11,000-11,494 → 8,623-9,115；`upload_meta` 12,980-13,143 → 10,601-10,765；`transfer_paths` 13,144-13,359 → 10,767-10,964。
  2. 根实际 9,128 而非约 8,755；`upload_finish.rs` 661 而非 654（函数体 655 + `use super::*;`/空行/`impl` 两行 + 2 行兄弟模块导入）。
  3. `UPLOAD_SPOOL_RETENTION` 不在计划的符号表内，但只服务 `sweep_stale_transfer_temps`、且被其文档注释引用，随函数一并搬移（否则根出现死常量），已在 `upload_meta.rs` 登记。
  4. `remote_transfer_paths` 签名被 rustfmt 折成多行（见上）。
  5. `ssh/tests.rs` 与 `ssh/sftp_ops.rs` 各增 1-2 行导入（glob 不跨层传递自由函数），计划未列出。
  6. 计划称 `apply_preserved_permissions` 被 `sftp_ext.rs`/`mcp.rs` 使用；实际只有 `sftp_ext.rs`。

### B5 下载管线（高风险）

- 新建：
  - `ssh/download_sudo.rs` ← `ssh.rs:7850-8036`（187）：`build_download_sink`、`start_sudo_download`、`start_sudo_download_staged`。
  - `ssh/download_lzpack.rs` ← `ssh.rs:8037-8564`（528）：`start_lzpack_download`、`prep_lzpack_download`。
  - `ssh/download_start.rs` ← `ssh.rs:8565-8858`（294）：`start_download`。
  - `ssh/download_prep.rs` ← `ssh.rs:8859-9315`（457）：`run_download_prep`、`prep_download_staging`、`pull_remote_gzip`、`cleanup_compressed_download`、`download_staged_chunk`。
  - `ssh/tree_download.rs` ← `ssh.rs:9316-9876`（561）：`start_tree_download`、`run_tree_prep`、`prep_tree_staging`、`store_tree_state`。
  - `ssh/tree_chunk.rs` ← `ssh.rs:9877-10184`（308）：`download_tree_chunk`。
  - `ssh/download_chunk.rs` ← `ssh.rs:10185-10553`（369）：`download_chunk`、`clone_for_download_prefetch`、`read_plain/window/highlevel_chunk`、`cleanup_download_assets`。
  - `ssh/download_complete.rs` ← `ssh.rs:10554-10999`（446）：`cancel_transfer`、`complete_download`、`complete_single_file_download`、`complete_tree_download`、`finalize_*`。
  - `ssh/tree_fs.rs` ← `ssh.rs:12603-12979`（377）：`publish_terminal`、`delete_directory_tree`、`scan_remote_tree*`、`raw_delete_path`、`raw_delete_tree`、`open_tree_sink`、`discard/finalize_tree_current`。
- 留在根：状态/传输/前置。
- 风险：**高**。`start_sudo_download`、lzpack 的远端 `tar`/`gzip` 执行、本地 staging 路径与符号链接处理；**触及 command execution 与路径安全，需要人审**。
- 验证：通用验收 + 下载/树下载/lzpack/sudo 下载用例；额外检查 `raw_delete_tree` 等 `pub(crate)` 再导出；对 `download_*` 的路径拼接做一次 `grep` 复核。
- 行数：约 3,527；根约 5,228。

#### B5 执行记录（已完成，待人审）

- 基线：`18882dc9`，`backend/src/ssh.rs` 9,128 行。实际按符号定位，9 个文件共搬出 3,527 行（含条目间空行），根降至 **5,611** 行。
- 实测（基线坐标 → 新文件）：
  - `ssh/download_sudo.rs` ← `ssh.rs:4194-4374`（181）：`build_download_sink`、`start_sudo_download`、`start_sudo_download_staged`；186 行。
  - `ssh/download_lzpack.rs` ← `ssh.rs:4376-4908`（533）：`start_lzpack_download`、`prep_lzpack_download`；538 行。
  - `ssh/download_start.rs` ← `ssh.rs:4910-5198`（289）：`start_download`；294 行。
  - `ssh/download_prep.rs` ← `ssh.rs:5200-5652`（453）：`run_download_prep`、`prep_download_staging`、`pull_remote_gzip`、`cleanup_compressed_download`、`download_staged_chunk`；458 行。
  - `ssh/tree_download.rs` ← `ssh.rs:5654-6214`（561）：`start_tree_download`、`run_tree_prep`、`prep_tree_staging`、`store_tree_state`；570 行。
  - `ssh/tree_chunk.rs` ← `ssh.rs:6216-6529`（314）：`download_tree_chunk`；320 行。
  - `ssh/download_chunk.rs` ← `ssh.rs:6531-6898`（368）：`download_chunk`、`clone_for_download_prefetch`、`read_plain_download_chunk`、`read_window_chunk`、`read_highlevel_chunk`、`cleanup_download_assets`；373 行。
  - `ssh/download_complete.rs` ← `ssh.rs:6900-7344`（445）：`cancel_transfer`、`complete_download`、`complete_single_file_download`、`complete_tree_download`、`finalize_download_sink`、`finalize_staged_plain`、`finalize_tree_staging`；450 行。
  - `ssh/tree_fs.rs` ← `ssh.rs:8455-8828`（374）：`publish_terminal`、`delete_directory_tree`、`scan_remote_tree`、`scan_remote_tree_walk`、`scan_tree_with_raw`、`raw_delete_path`、`raw_delete_tree`、`open_tree_sink`、`discard_tree_current`、`finalize_tree_current`；380 行。
- 可见性调整（只加不降）：
  - 方法 `pub(super)`（10）：`build_download_sink`、`start_lzpack_download`、`run_download_prep`、`pull_remote_gzip`、`cleanup_compressed_download`、`download_staged_chunk`、`store_tree_state`、`download_tree_chunk`、`cleanup_download_assets`、`finalize_download_sink`。
  - 自由函数 `pub(super)`（8）：`publish_terminal`、`delete_directory_tree`、`scan_remote_tree`、`scan_tree_with_raw`、`raw_delete_path`、`open_tree_sink`、`discard_tree_current`、`finalize_tree_current`。
  - 原样保留：`pub` 6 个（`start_sudo_download`、`start_download`、`start_tree_download`、`download_chunk`、`cancel_transfer`、`complete_download`）；`raw_delete_tree` 仍 `pub(crate)`；其余 14 个私有条目仅同文件调用，未改可见性。
  - 新增 `use`：8 个方法文件加 `use super::state::{…}`（`DownloadSink`/`DownloadState`/`TreeDownloadState`/`DownloadPrep`/`PrepOutcome`/`MultistreamState`/`UploadPhase`，实测按文件最小集）；`tree_download.rs`/`tree_chunk.rs` 各加 `use super::tree_fs::{…}`；根加 `use tree_fs::{delete_directory_tree, publish_terminal, raw_delete_path};`（供根自身与 `sftp_ops.rs` 的 `use super::*` 使用）。
- 保真：`/tmp/movecheck/verify_move.py` 逐符号比对，39 个条目中 21 个 `same`、16 个 `visibility`、2 个 `differs`；仅 `store_tree_state`、`open_tree_sink` 因 `pub(super) ` 使签名超 100 列被 rustfmt 折行，token 流一致。
- 命令面：`/tmp/movecheck/compare_literals.py --base 18882dc9` → 字面量多重集 **完全一致**（23,683 → 23,683，distinct 8,874）；REMOVED/ADDED 均为空。
- 验证：`cargo clippy --all-targets -- -D warnings` 通过；全量测试 `-- --test-threads=1` **1,396 passed**，测试名集合 diff 为空；`node scripts/mock_host_registry_check.mjs` PASS；`node scripts/refresh_structure_allowlist.mjs --check` PASS（`ssh.rs` 条目 9,128 → 5,611，新增文件均 <600 不入清单）；`cargo fmt --manifest-path backend/Cargo.toml --check` 仍只剩基线 7 处（`proxy.rs` ×6、`ssh.rs` 原 2,247 现 2,257）。
- 与 B5 计划估计的偏差：
  1. 行号锚点整体偏移（计划锚点是 18,457 行版本）：`download_sudo` 7,850-8,036 → 实际 4,194-4,374；`tree_fs` 12,603-12,979 → 8,455-8,828；其余同上表。
  2. 根实际 5,611 而非约 5,228；9 个文件均低于 600 行预算，无需新增允许清单条目。
  3. `tree_fs.rs` 的符号表追加 `scan_tree_with_raw`（`scan_remote_tree` 的扫描变体，与 `scan_remote_tree_walk` 同段），计划只写了 `scan_remote_tree*`。
  4. 再次确认 B4 的 glob 提示：`state.rs` 的 `DownloadSink`/`DownloadState`/`TreeDownloadState`/`DownloadPrep`/`PrepOutcome` 等经根 `use state::*;` 引入，子模块 `use super::*` 取不到，必须显式 `use super::state::{…}`。
  5. `store_tree_state`、`open_tree_sink` 签名被 rustfmt 折行（见上）；`tree_chunk.rs` 单元素 import 的花括号被 rustfmt 去掉。
  6. 本批未改动 `main.rs`/`mcp.rs`/`sftp_ext.rs`/`transfer_compress.rs`/`sftp_ops.rs` 任何调用点；`sftp_ops.rs` 继续通过根绑定看到 `delete_directory_tree`/`raw_delete_path`。


### B6 认证/主机密钥/执行/审批收尾（最高风险，最后做）

分两个 commit：

**6a 会话与转发（`SshRuntime` impl 拆分）**
- `ssh/lifecycle.rs` ← `ssh.rs:2077-2272`（196）：`new`、`data_dir`、`has_connection`、`store_connection`、`sweep_reconnect_residue`、`disconnect_connection`。
- `ssh/open_session.rs` ← `ssh.rs:2273-3152`（880，**允许清单**）：`open_session` 单函数。
- `ssh/probe.rs` ← `ssh.rs:3153-3383`（231）：`test_connection`、`check_host_key`、`connect_authenticated`。
- `ssh/auth_dial.rs` ← `ssh.rs:3384-3631`（248）：`dial_and_authenticate`、`known_hosts_path`、`with_auto_trust_keys`、`connect_headless`。
- `ssh/port_forward.rs` ← `ssh.rs:3632-4006`（375）：`remote_table_for`、`forward_list/start/stop`、`monitor_forward_transport`、`teardown_forward`、`stop_session_forwards`。
- `ssh/terminal.rs` ← `ssh.rs:4007-4438`（432）：`close_session*`、`list_sessions`、`resize_terminal`、`write_terminal`、`batch_terminal_input`、`replay_terminal`、`attach_session`、`close_workbench`、`session`、`ensure_writable`、`live_handle_for_connection`、`completion_session_read_only`。

**6b 主机密钥/认证/执行/审批**
- `ssh/ssh_client.rs` ← `ssh.rs:722-1280`（559）：`DialDeadline`、`SshClient`、`client::Handler` impl、`HostKeyVerdict`、`host_key_verdict`、`HostKeyProbe`、`DirectoryHandshakeFilter`。再导出 `pub use ssh_client::SshClient;`（7 个外部文件）。
- `ssh/exec_methods.rs` ← `ssh.rs:4666-5032`（367）：`agent_mode_get`、`exec`、`cancel_exec`、`exec_response`、`agent_terminal_mode`、`set_agent_terminal_mode`、`agent_exec_guard`、`exec_in_terminal`。
- `ssh/approval.rs` ← `ssh.rs:5033-5356`（324）：`mcp_confirm_challenge_payload`、`request_mcp_confirm`、`request_agent_approval`、`resolve_agent_challenge`、`audit_approval`。
- `ssh/keepalive.rs` ← `ssh.rs:5357-5449`（93）：`keepalive_registration_plan`、`register_sudo_keepalive`、`stop_sudo_keepalive`。
- `ssh/auth.rs` ← `ssh.rs:11495-12067`（573）：`flow_mode_name`、`method_offered`、`advertised_methods`、`reconcile_advertised`、`authenticate_auto`、`authenticate_password_or_interactive`、`try_password`、`authenticate_keyboard_interactive`、`AutoAuthAttempt*`。
- `ssh/private_key.rs` ← `ssh.rs:12068-12412`（345）：`authenticate_private_key_result`、`resolve_private_key_text`、`normalize_private_key_text`、`private_key_decode_failure`、PEM/公钥判定辅助。
- `ssh/agent_auth.rs` ← `ssh.rs:12413-12602`（190）：`AgentAuthOutcome`、`AgentPlan`、`plan_agent_identity_attempt`、`authenticate_agent`。
- 留在根：A 区前置、`SshRuntime`、`PendingChallenge`、`plugin_error`，以及 `pub use` 再导出。
- 可见性：`SshClient` 用 `pub use ssh_client::SshClient;`；`private_key_decode_failure` 用 `pub(crate) use private_key::private_key_decode_failure;`（`keys.rs:50`）；`auth`/`exec`/`approval` 内部方法跨文件调用用 `pub(super)`；`SshRuntime` 字段仍私有。
- 风险：**高**。`open_session`/`dial_and_authenticate`/主机密钥校验/私钥解析/Agent 认证/`exec`/MCP 审批/审计；**全部触及 authentication、command execution、secret binding，必须人审**（AGENTS.md）。
- 验证：通用验收 + 全量 `cargo test`（认证/主机密钥/审批/执行用例为重点）；人工 diff 认证错误串、审批超时、审计字段；不引入真实凭证。
- 行数：约 4,813；根约 415（40 个子模块各约 1 行 `mod` + 1 行再导出，合计约 80 行，最终约 495，仍 <600）。

#### B6b 执行记录（已完成，待人审）

基线 `b2bec10a`（`ssh.rs` 5,611 行）。按符号原样搬移 6b 清单；6a 尚未执行，`lifecycle`/`open_session`/`probe`/`auth_dial`/`port_forward`/`terminal` 全部符号仍在根，本批未触碰。新文件均以 `use super::*;` 引入根作用域，`SshRuntime` 方法在各自文件内用独立 `impl SshRuntime` 块承载（同 B2a/B3/B4 写法）：

| 新文件 | 基线实际区间（1-based，含文档注释/属性） | 搬移条目 | 文件行数 |
|---|---|---|---|
| `ssh/ssh_client.rs` | `376-423`、`429-668`、`670-679`、`681-687`、`770-805`、`879-932`（395） | `DialDeadline`（+impl）、`SshClient`（+`client::Handler` impl）、`HostKeyVerdict`、`host_key_verdict`、`HostKeyProbe`（+`client::Handler` impl）、`DirectoryHandshakeFilter`（+impl） | 412 |
| `ssh/exec_methods.rs` | `3419-3785`（367） | `agent_mode_get`、`exec`、`cancel_exec`、`exec_response`、`agent_terminal_mode`、`set_agent_terminal_mode`、`agent_exec_guard`、`exec_in_terminal` | 371 |
| `ssh/approval.rs` | `3787-4102`（316） | `mcp_confirm_challenge_payload`、`request_mcp_confirm`、`request_agent_approval`、`resolve_agent_challenge`、`audit_approval` | 320 |
| `ssh/keepalive.rs` | `4104-4202`（99） | `keepalive_registration_plan`、`register_sudo_keepalive`、`stop_sudo_keepalive` | 104 |
| `ssh/auth.rs` | `4205-4776`（572） | `flow_mode_name`、`method_offered`、`advertised_methods`、`reconcile_advertised`、`advertisement_rejection_message`、`auth_partial_success`、`AUTO_AUTH_ORDER`、`auto_stage_skip`、`AutoAuthAttempt`、`auto_auth_attempt`、`auto_auth_skip`、`merge_auto_auth_attempt`、`auto_auth_failure_message`、`authenticate_auto`、`authenticate_password_or_interactive`、`try_password`、`KEYBOARD_INTERACTIVE_MAX_ROUNDS`、`challenge_display_text`、`keyboard_interactive_guidance`、`keyboard_interactive_manual_challenge`、`authenticate_keyboard_interactive` | 578 |
| `ssh/auth_key.rs` | `4778–5119`（342） | `authenticate_private_key_result`、`resolve_private_key_text`、`normalize_private_key_text`、`strip_invisible_paste_artifacts`、`is_pem_base64_char`、`looks_like_marker_line`、`normalize_pem_marker_line`、`looks_like_public_key`、`has_html_escaped_entities`、`private_key_decode_failure`、`expand_private_key_path` | 346 |

- 行数：`ssh.rs` 5,611 → **3,524**（搬出条目 2,091 行，扣除 4 行条目间空行与 impl 尾部空行，新增 13 行 `mod`/`use`/再导出）；六个新文件合计 2,131 行。`ssh/tests.rs` 4,472 → 4,475 与 `ssh.rs 3,524` 由 `scripts/refresh_structure_allowlist.mjs --write` 自动登记（未手写数字）。
- 可见性调整（最小提升，`pub` 一律不降级；逐符号核对见保真自检）：
  - `ssh_client.rs`：`DialDeadline`、`HostKeyVerdict`、`HostKeyProbe`（含 4 个字段）、`DirectoryHandshakeFilter`、`host_key_verdict`、`DialDeadline::{start,remaining}`、`DirectoryHandshakeFilter::{begin,filter,flush_if_timed_out,take_failed}` → `pub(super)`（根 `open_session`/`dial_and_authenticate`/`check_host_key`/`ssh/tests.rs` 仍调用）；`SshClient` 12 个字段 → `pub(super)`（唯一构造点在根 `dial_and_authenticate`）。`SshClient` 本体保持 `pub`，字段对外仍不可见。
  - `exec_methods.rs`：`set_agent_terminal_mode` → `pub(super)`（`ssh/settings.rs` 与 `ssh/tests.rs`）。
  - `keepalive.rs`：`keepalive_registration_plan`、`register_sudo_keepalive`、`stop_sudo_keepalive` → `pub(super)`（tests、`ssh::exec_methods` 兄弟模块、根 `disconnect_connection`/`open_session`）。
  - `auth.rs`：除仅文件内使用的 `flow_mode_name` 外全部 `pub(super)`（根拨号流程、`ssh/settings.rs`、tests）；`AutoAuthAttempt` 及 3 个字段 `pub(super)`；`AUTO_AUTH_ORDER`、`KEYBOARD_INTERACTIVE_MAX_ROUNDS` `pub(super)`。
  - `auth_key.rs`：`authenticate_private_key_result`、`resolve_private_key_text`、`normalize_private_key_text`、`looks_like_public_key` → `pub(super)`；`private_key_decode_failure` 保持 `pub(crate)`。
- 再导出/显式导入：根 `pub use ssh_client::SshClient;`（7 个外部文件零改动）；根 `pub(crate) use auth_key::private_key_decode_failure;`（保持 `keys.rs:50` 的 `crate::ssh::private_key_decode_failure` 路径）；根显式 `use auth::{advertised_methods, auth_partial_success, authenticate_auto, authenticate_keyboard_interactive, authenticate_password_or_interactive, flow_mode_name, method_offered};`、`use auth_key::authenticate_private_key_result;`、`use ssh_client::{DialDeadline, DirectoryHandshakeFilter, HostKeyProbe, HostKeyVerdict};`。`ssh/tests.rs` 增加 `use super::auth::*;`、`use super::auth_key::*;`、`use super::ssh_client::*;`（B4 结论：glob 导入不跨层透传，测试直接从定义模块导入）。
- 保真自检（`/tmp/movecheck/verify_move.py` + 同一规则的 struct/enum/const 对比）：`ssh_client` 6 个函数全部 `same`/`visibility`；`exec_methods` 7 `same` + `set_agent_terminal_mode` `visibility`；`approval` 5 全部 `same`；`keepalive` 3 全部 `visibility`；`auth` 16 `visibility` + `merge_auto_auth_attempt` 纯 rustfmt 折行；`auth_key` 4 `visibility` + `resolve_private_key_text` 纯 rustfmt 折行；类型/常量全部 `visibility`，`AUTO_AUTH_ORDER` 另加纯 rustfmt 折行。三处折行均为加可见性前缀后签名/常量超 100 列所致，语句、字面量与语义不变。
- 命令面自检：`/tmp/movecheck/compare_literals.py --base b2bec10a` → `identical literal multiset`（23,683 个，distinct 8,874；无 REMOVED/ADDED，命令、错误串、PEM 规范化文本、审批载荷字段全部一致）。
- 验证：`cargo fmt --check` 仅基线 7 处（`proxy.rs` ×6 + `ssh.rs` ×1，无新增）；`cargo clippy --all-targets -- -D warnings` 通过；`cargo test -- --test-threads=1` 1,396 passed；`cargo test -- --list` 测试名集合 diff 为空；`node scripts/mock_host_registry_check.mjs` PASS；`refresh_structure_allowlist.mjs --write/--check` 通过。
- 偏差：
  1. 6a 未执行，`ssh.rs` 仍保留 `lifecycle`/`open_session`/`probe`/`auth_dial`/`port_forward`/`terminal` 全部符号；本批只搬 6b，未触碰 6a 符号。
  2. Agent 认证（`AgentAuthOutcome`、`AgentPlan`、`AGENT_IDENTITY_MAX_ATTEMPTS`、`plan_agent_identity_attempt`、`authenticate_agent`）不在本批任务符号清单内，保留在根；`auth.rs` 经根作用域调用，未搬移。
  3. 未创建 `ssh/private_key.rs` / `ssh/agent_auth.rs`：私钥符号并入 `auth_key.rs`（346 行，仍 <600），agent 符号留根（见上一条）。
  4. `host_key_check_response`、`host_key_unreachable_response`、`HOST_KEY_CHALLENGE_WAIT`、`DIRECTORY_HANDSHAKE_LIMIT/TIMEOUT`、`find_bytes` 等不在 6b 清单内，保留根，由子模块经 `use super::*` 使用。
  5. 根 `ssh.rs` 为 3,524 行，未低于 600，故允许清单条目保留，未做计划中可选的 `ssh/prelude.rs` 抽取。

### 批次顺序理由

B1 纯测试 → B2 自包含 SFTP 面（验证拆分流程；含 sudo profile secret binding，人审）→ B3 中央状态/传输（耦合最大但无凭证/执行）→ B4 上传（sudo exec）→ B5 下载（sudo/tar exec、路径安全）→ B6 认证/主机密钥/执行/审批（最高风险，最后集中人审）。前 5 批不改变外部协议与 `main.rs` 分派；B6 也不改变，只搬移。

## 4. 600 行预算允许清单

定义：`backend/src/**/*.rs` 物理行数 `wc -l ≤ 600`；超限文件必须进入允许清单，逐条写原因与消除批次。预算按文件计（生产与测试同规则）。

建议文件：`scripts/refactor/line-budget.allowlist`（本任务只定义语义，不新增 gate 脚本）：

```text
# path<TAB>max_lines<TAB>remove_after<TAB>reason
```

各批次后的允许清单（`ssh.rs` 逐步缩小，B6 后移出）：

| 批次后 | 允许清单条目 |
|---|---|
| B0（基线） | `backend/src/ssh.rs 18457` |
| B1 | `ssh.rs ≈13929`；`ssh/tests.rs 4504` |
| B2 | `ssh.rs ≈12028`；`ssh/tests.rs 4504` |
| B3 | `ssh.rs ≈10917`；`ssh/tests.rs 4504` |
| B4 | `ssh.rs ≈8755`；`ssh/tests.rs 4504`；`ssh/upload_finish.rs 654` |
| B5 | `ssh.rs ≈5228`；`ssh/tests.rs 4504`；`ssh/upload_finish.rs 654` |
| B6 | `ssh/tests.rs 4504`；`ssh/open_session.rs 880`；`ssh/upload_finish.rs 654` |

B6 后建议内容（生产例外必须写消除计划）：

```text
backend/src/ssh/tests.rs        4504  B7  测试整文件搬移；可按区段再拆
backend/src/ssh/open_session.rs 880   B7  单函数 open_session（2273-3152）
backend/src/ssh/upload_finish.rs 654  B7  单函数 finish_upload（6974-7627）
```

B1–B5 期间 `ssh.rs` 仍在清单内，但 `max_lines` 必须随批次递减（防止新增代码把根重新撑大）；B6 删除该条。若 B6 的 40 个 `mod`/`pub use` 使根超过 600，追加一步：把 A 区 helper（`ssh.rs:66-331`，266 行）抽到 `ssh/prelude.rs`，根保留 import/mod/再导出，降到约 230 行。

## 5. 非目标

1. 不改任何协议方法名、参数/返回字段、错误语义；不改 `backend/src/main.rs` 的 `handle_request` 分派表。
2. 不重构 `open_session`（880 行）与 `finish_upload`（654 行）的函数体；只搬移。函数内拆分单列 B7。
3. 不把 `ssh.rs` 重命名为 `ssh/mod.rs`，不改模块根路径；只新增 `ssh/*.rs` 子模块。
4. 不新增/升级依赖，不改 `backend/Cargo.toml`、`Cargo.lock`、`manifest.json`、`dbx-plugin.toml`、版本号、`ui/`、`dist/`。
5. 不改测试语义与数量；B1 仅搬移测试文件。
6. 不引入 feature flag、运行时开关或双实现。
7. 不处理前端（`frontend/**`）；`move-file.mjs` 仅作为前端重构工具。
8. 不自动安装、不重启 DBX、不合并 PR（AGENTS.md：integrator 负责 `Cargo.lock`、版本、生成物与最终校验）。
9. 本任务不实现 600 行 CI gate；只定义允许清单语义与各批次目标。

## 6. 回滚

- 每批一个独立 commit（B6 为 6a/6b 两个），只含代码搬移、`mod`/`pub use`、可见性调整。
- 回滚单批：`git revert <batch-sha>`；所有外部 import 未变，回滚后直接恢复原单文件结构，无数据/协议迁移。
- 若 B3 的字段可见性引发大面积编译错误，先 revert B3，不影响 B1/B2 已落地的测试与 SFTP 拆分。
- 若 B6 认证批次 review 未通过，保持 B1–B5 成果，B6 可整体推迟；`ssh.rs` 仍在允许清单内（约 5,228 行）。
- 所有批次均不写入运行时状态、不迁移配置、不改 known_hosts/凭证存储格式。

## 7. 后续（B7，不在本计划范围）

1. `open_session`（2273-3152）按“认证/主机密钥 → 通道打开 → 会话登记 → 启动命令/触发器”拆内部函数，目标 <600 行/文件。
2. `finish_upload`（6974-7627）拆“校验/落盘/压缩/sudo 提交”阶段。
3. `tests.rs` 按 A–Q 区段拆多个测试文件，去掉测试允许清单条目。
4. 落地 `scripts/refactor/line-budget.mjs`（读取 allowlist + `wc -l`，CI 校验递减）。

## 附录 A：数字重derive命令

### A.1 分区/条目统计

保存为 `/tmp/count-ssh-areas.awk`，执行 `awk -f /tmp/count-ssh-areas.awk backend/src/ssh.rs`（输出即 1.2 表）：

```awk
BEGIN {
  n = split("A:1:331 B:332:721 C:722:1280 D:1281:2067 E:2068:3631 F:3632:4006 G:4007:4438 H:4439:4665 I:4666:5449 J:5450:5910 K:5911:6044 L:6045:6562 M:6563:7849 N:7850:10999 O:11000:11494 P:11495:12412 Q:12413:12602 R:12603:12979 S:12980:13143 T:13144:13359 U:13360:13920 V:13921:18457", spec, " ")
  for (i = 1; i <= n; i++) { split(spec[i], p, ":"); name[i]=p[1]; from[i]=p[2]+0; to[i]=p[3]+0 }
  printf "%-3s %6s %6s %6s %6s %6s %8s %8s %6s\n", "area", "from", "to", "lines", "pubfn", "fntotal", "struct", "enum", "impl"
}
{
  for (i = 1; i <= n; i++) if (NR >= from[i] && NR <= to[i]) {
    lines[i]++
    if ($0 ~ /^[ \t]*pub(\([^)]*\))?[ \t]+(async[ \t]+)?fn /) pubfn[i]++
    if ($0 ~ /^[ \t]*(pub(\([^)]*\))?[ \t]+)?(async[ \t]+)?fn /) fn[i]++
    if ($0 ~ /^[ \t]*struct /) { st[i]++; if ($0 ~ /^[ \t]*pub(\([^)]*\))?[ \t]+struct /) pst[i]++ }
    if ($0 ~ /^[ \t]*enum /) { en[i]++; if ($0 ~ /^[ \t]*pub(\([^)]*\))?[ \t]+enum /) pen[i]++ }
    if ($0 ~ /^impl /) impl[i]++
  }
}
END {
  for (i = 1; i <= n; i++)
    printf "%-3s %6d %6d %6d %6d %6d %3d/%-3d %3d/%-3d %6d\n", name[i], from[i], to[i], lines[i], pubfn[i], fn[i], pst[i], st[i], pen[i], en[i], impl[i]
  printf "total lines: %d\n", NR
}
```

### A.2 最大公开函数

```bash
awk '
/^[ \t]*(pub(\([^)]*\))?[ \t]+)?(async[ \t]+)?fn / {
  if (prevline && ispub) printf "%d\t%d\t%s\n", prevline, NR - prevline, prevname
  ispub = ($0 ~ /^[ \t]*pub(\([^)]*\))?[ \t]+(async[ \t]+)?fn /)
  prevline = NR; prevname = $0; sub(/[ \t]*\{.*/, "", prevname); sub(/^[ \t]*/, "", prevname)
}
END { if (prevline && ispub) printf "%d\t%d\t%s\n", prevline, NR + 1 - prevline, prevname }
' backend/src/ssh.rs | sort -k2,2nr | head -12
```

### A.3 依赖

```bash
# 入边：20 个文件
grep -rl 'crate::ssh' backend/src --include='*.rs' | grep -v '^backend/src/ssh.rs$' | wc -l
grep -rn 'crate::ssh' backend/src --include='*.rs' --exclude='ssh.rs'

# 出边：28 个 crate 模块
grep -nE '^use crate::' backend/src/ssh.rs

# 外部方法调用（过滤同名通用方法后人工确认）
grep -rhoE '\.(open_session|close_session|exec|exec_in_terminal|finish_upload|start_download|download_chunk|ensure_writable|ensure_sudo_allowed|profiles_[a-z_]+|settings_[a-z_]+)\([^)]*' backend/src --include='*.rs' | sort | uniq -c | sort -rn
```

### A.4 批次行数核算

各批次按 1.2 表的区段求和（B1 只取测试 4,504 + 28；B2–B6 取对应区段，`SshRuntime` 66 行与 `PendingChallenge` 8 行始终留根）：

```text
B1 4,532 | B2 1,901 | B3 1,111 | B4 2,162 | B5 3,527 | B6 4,813
合计 18,046；根 = 18,457 - 18,046 = 411（A 331 + SshRuntime 66 + PendingChallenge 8 + `impl SshRuntime {` 开口 1 + plugin_error 3 + 分隔空行 2）
```
