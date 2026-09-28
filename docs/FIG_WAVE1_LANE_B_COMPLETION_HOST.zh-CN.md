# Lane B 细则：Rust CompletionHost（completion-host）

> 分支 `codex/ssh/fig-wave1-completion-host`，基线 `codex/ssh/fig-wave1-base`。
> 先读：`FIG_WAVE1_CONTRACT.zh-CN.md`（§5 RPC 契约）、`FIG_ROADMAP.zh-CN.md`、`FIG_VERIFICATION.zh-CN.md`。
> 前端线协议 `frontend/src/lib/completion/host/protocol.ts` 是冻结镜像，两边字段必须逐字一致。

## 1. 目标 / 非目标

目标：新增 sidecar 方法 `completion/execute`，把 generator 命令执行到正确的
target（local 短进程 / SSH 复用既有 exec），带超时、输出上限、安全校验。

非目标：`completion/listDirectory`、`completion/environment`、WSL、修改
`SshRuntime::exec` / `exec.rs` 的既有语义、前端任何文件。

## 2. 既有锚点（fig-base 已核实）

- 路由分发：`backend/src/main.rs` `handle_request` 的 `match path`，`"ssh/exec"` 臂 ≈L420（`required_string` 取参 + `self.runtime.block_on(self.ssh.exec(...))`），`"ssh/exec/cancel"` 臂 ≈L440（`self.ssh.cancel_exec(exec_id)`，同步）。
- `SshRuntime::exec(session_id, exec_id: Option<&str>, command, sudo, timeout_secs)`：内部 `clamp(5,300)`；`sudo && read_only` 拒绝。
- shell 转义：仓库硬性约定走既有 `exec::shell_quote`（见 `docs/PROTOCOL.zh-CN.md` WT-4 节描述；实现于 `backend/src/exec.rs`，使用前先 grep 确认确切路径与签名）。
- `Cargo.toml`：`tokio = { features = ["full"] }`、`uuid = { features=["v4"] }` 已就位——**不新增任何依赖，Cargo.lock 不动**。

## 3. 新增文件

### `backend/src/completion/mod.rs`

模块声明与 re-export（`protocol`、`security`、`executor`、`local`、`ssh`）。

### `backend/src/completion/protocol.rs`

与 `host/protocol.ts` 逐字段对应的 DTO（camelCase）：

```rust
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CompletionTarget { Local { session_id: String }, Ssh { session_id: String } }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionExecuteRequest {
    pub target: CompletionTarget,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
    pub mode: String,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompletionExecuteResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}
```

round-trip 测试：对本地/SSH target、缺省字段的 JSON 反序列化快照。

### `backend/src/completion/security.rs`

```rust
pub const MIN_TIMEOUT_MS: u64 = 200;
pub const MAX_TIMEOUT_MS: u64 = 3000;
pub const DEFAULT_TIMEOUT_MS: u64 = 1200;
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_ARGS: usize = 32;

/// 校验+收紧：mode 必须是 "completion-generator"；command 非空且不含 NUL；
/// args 数 ≤32 且不含 NUL；timeout_ms 缺省/越界 → clamp；max_output_bytes 越界 → clamp。
pub fn validate_and_clamp(req: &mut CompletionExecuteRequest) -> Result<(), String>
/// 远端命令行拼装：command + 空格 + args 逐个 shell_quote（拒绝注入面）。
pub fn build_remote_command_line(command: &str, args: &[String]) -> String
```

错误串统一 `completion:` 前缀（如 `completion: mode not allowed`）。

### `backend/src/completion/local.rs`

短生命周期子进程执行（**绝不碰** `local_terminal.rs` 的交互 PTY）：

- `tokio::process::Command::new(&command).args(&args)`，stdout/stderr piped，`cwd` 可选，`kill_on_drop(true)`。
- 输出读取带 `max_output_bytes` 上限：超限即 `truncated=true` 并停止读取、杀进程。
- `tokio::time::timeout(clamped)` 竞速；超时 kill + `timed_out=true`、`exit_code=None`。
- 平台注意：argv 直 exec 不经 shell，Windows 无需引号处理；大输出/超时用例 `#[cfg(unix)]` 用 `yes`/`sleep`，Windows 跳过并在测试注释说明。

### `backend/src/completion/ssh.rs`

- **read-only 门（决策 D4）**：SSH target 在只读连接上一律拒绝。实现优先复用
  `SshRuntime` 已有的公开会话信息读取（grep `read_only` 的现有用法找最小入口）；
  若确无可复用的公开入口，允许在 `backend/src/ssh.rs` **追加一个最小只读查询
  fn**（如 `pub async fn completion_session_read_only(&self, session_id) -> Result<bool, String>`），
  仅此一处、不改任何既有函数——这是对本 lane 文件归属的唯一预批例外，必须写进报告。
- `exec_id = Some(concat!("completion-", Uuid::new_v4()))`。
- 命令行：`build_remote_command_line`（逐参数 shell_quote）。
- 竞速超时（决策 D3）：`timeout(clamped)` 包住 `self.ssh.exec(session_id, exec_id, &line, false, None)`；
  超时后调 `self.ssh.cancel_exec(exec_id)` 回收，返回 `timed_out=true` 空输出。
  **不修改 exec 的内部 clamp**。
- `exec` 返回 `Value`：按 `ssh/exec` 现有返回字段（stdout/stderr/exitCode，以
  main.rs/ssh.rs 实际为准）映射到 `CompletionExecuteResult`；字段名不一致时做
  显式映射并注释。

### `backend/src/completion/executor.rs`

按 `target.kind` 分派到 local/ssh 的统一入口（供 main.rs 调用），签名自定，
错误统一 `Result<CompletionExecuteResult, String>`（sidecar 字符串 Err 惯例）。

### `backend/src/main.rs`（仅此一处改动）

- `mod completion;`
- 新增 `"completion/execute" =>` 臂：`serde_json::from_value` 反序列化 → `security::validate_and_clamp` → `completion::executor::dispatch`（SSH 分支需要 `&self.ssh`）→ 序列化返回。照抄 `ssh/exec` 臂的取参/block_on 风格；该臂无审计调用则不加，有则同款。

## 4. 协议文档

`docs/PROTOCOL.zh-CN.md` 追加 `## completion/execute（补全 generator 执行）` 小节，
文体对齐 WT-4 节（ prose + 加粗要点）：参数表（camelCase）、返回字段、语义
（target-side 执行、sudo 恒 false、read-only 拒绝、超时竞速+取消、输出上限）、
错误前缀 `completion:`。

## 5. smoke 脚本 `scripts/smoke_completion.py`

对齐 `smoke_fs_test.py` 约定（`Method not found` → SKIP；CaseResult 记账；
前置用例依赖）。用例：

1. local echo：`command="printf", args=["hello"]` → stdout `hello`。
2. local 超时：`sleep 5` + `timeoutMs=400` → `timedOut=true`（unix；win SKIP）。
3. local 截断：`yes x` + `maxOutputBytes=1024` → `truncated=true`（unix）。
4. 安全拒绝：`mode="evil"` → 报错；`command=""` → 报错。
5. ssh 基础：容器会话 `printf hi` → stdout `hi`（复用 smoke_test 的容器启动方式）。
6. ssh quote：args 带空格/单引号（`["a b'c"]`）→ stdout 原样回显。
7. ssh 未知 session → 报错。
8. ssh 超时：远端 `sleep 5` + 400ms → `timedOut=true`（若容器无 sleep 则 SKIP）。
9. read-only 拒绝：若 smoke 现有框架能建只读连接则验，否则记 SKIP+TODO。

## 6. Cargo 测试

protocol round-trip（含 target tag 两种）；security 全规则；`build_remote_command_line`
（空格/单引号/unicode/空 args）；local 成功/超时/截断（平台守卫）；ssh 层仅测
纯函数（拼装+门控逻辑），真链路由 smoke 覆盖。

## 7. 验收

```bash
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --locked --manifest-path backend/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path backend/Cargo.toml
# docker 容器可用时：
python3 scripts/smoke_completion.py
```

零新依赖；`Cargo.lock`、`frontend/`、既有 ssh/exec 行为零改动；PR 需人工 review
（命令执行面变更）后由 integrator 合入。
