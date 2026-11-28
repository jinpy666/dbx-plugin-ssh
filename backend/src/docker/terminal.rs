//! 容器终端（B5）：`docker exec -it` 的 PTY 会话、二进制帧与注册表。
//!
//! 协议形状（docs/PROTOCOL.zh-CN.md「容器终端」节）：
//!
//! - 方法：`docker/terminal/open|close|resize|replay`；
//! - 输入：`docker/terminal/in/{terminalId}`（8 字节大端序号 + 原始键）；
//! - 输出：`docker/terminal/out/{terminalId}`（9 字节 `TerminalFrame`）；
//! - 事件：`docker/terminal/inputAck`、`docker/terminal/error`、
//!   `docker/terminal/end {reason: exited|closed|error, exitCode?}`。
//!
//! 安全红线（计划 §5.2 / §5.5）：
//!
//! - 容器 id 先过 `validate_container_id`，再作为**位置参数**进入固定脚本；
//!   本机面 argv 直呼 CLI，无 shell。
//! - 只读连接在 RPC 层由 `ensure_writable` 拒绝（本模块只保留同族文案的
//!   纯函数入口供单测）。
//! - `needsSudo` 时**绝不**把密码注入 PTY：无预热 sudo 时间戳直接拒绝，
//!   有预热时只用 `sudo -n`（非交互），失败也不再退化为密码提示。
//!
//! 资源边界（计划 §5.6 / 附录 C.2 / C.3）：
//!
//! - 并发上限 8/sidecar（**独立配额**，与日志流各 8 条；两者都是 8 条
//!   PTY/流通道，合计上限 16，避免一个被另一个挤占后终端打不开）。
//! - 空闲 TTL 30 分钟（无输入/输出即回收）。
//! - replay 2 MiB 环形，复用 SSH 终端的 [`ReplayBuffer`]。
//! - 关闭墓碑 30 秒，阻止「close 后晚到的 open」复活同一 terminalId。
//! - close 幂等；未知 id 返回 success。先发 `end` 再拆会话。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::Handle;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::exec::shell_quote;
use crate::ssh::{ReplayBuffer, SshClient};

use super::EngineConfig;

/// 并发容器终端上限（独立配额；见模块注释）。
pub const MAX_ACTIVE_TERMINALS: usize = 8;
/// 终端空闲回收：30 分钟无输入/输出。
pub const TERMINAL_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
/// 关闭墓碑：覆盖 close 响应与迟到 open 的交错窗口。
pub const CLOSED_TERMINAL_TTL: Duration = Duration::from_secs(30);
/// close 等待 runner 自行收尾的宽限，超时 abort。
pub const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// 终端尺寸钳制范围与缺省值（2..500 / 2..300，缺省 80x24）。
pub const TERMINAL_MIN_COLS: u32 = 2;
pub const TERMINAL_MAX_COLS: u32 = 500;
pub const TERMINAL_MIN_ROWS: u32 = 2;
pub const TERMINAL_MAX_ROWS: u32 = 300;
pub const TERMINAL_DEFAULT_COLS: u32 = 80;
pub const TERMINAL_DEFAULT_ROWS: u32 = 24;
/// 只读拒绝文案（与 `ensure_writable` 同族；B5 把后者中性化）。
pub const READ_ONLY_TERMINAL_MESSAGE: &str =
    "Write/terminal operation is disabled by the read-only connection setting";
/// `needsSudo` 且无预热时间戳时的拒绝文案。
pub const NEEDS_SUDO_TERMINAL_MESSAGE: &str =
    "Container terminal does not inject sudo passwords. Add the user to the docker group, or run a sudo command on this connection first to warm the timestamp";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalShell {
    Auto,
    Bash,
    Zsh,
    Fish,
    Ash,
    Sh,
}

impl TerminalShell {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        let value = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("auto");
        match value {
            "auto" => Ok(Self::Auto),
            "bash" => Ok(Self::Bash),
            "zsh" => Ok(Self::Zsh),
            "fish" => Ok(Self::Fish),
            "ash" => Ok(Self::Ash),
            "sh" => Ok(Self::Sh),
            other => Err(format!(
                "Unsupported container shell '{other}'. Supported: auto, bash, zsh, fish, ash, sh"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
            Self::Ash => "ash",
            Self::Sh => "sh",
        }
    }
}

/// 缺省尺寸与钳制（2..500 / 2..300）。前端拖拽窗口可能送出 0 或超大值。
pub fn clamp_terminal_size(cols: Option<u64>, rows: Option<u64>) -> (u16, u16) {
    let clamp = |value: Option<u64>, default: u32, min: u32, max: u32| -> u16 {
        value
            .unwrap_or(u64::from(default))
            .clamp(u64::from(min), u64::from(max)) as u16
    };
    (
        clamp(
            cols,
            TERMINAL_DEFAULT_COLS,
            TERMINAL_MIN_COLS,
            TERMINAL_MAX_COLS,
        ),
        clamp(
            rows,
            TERMINAL_DEFAULT_ROWS,
            TERMINAL_MIN_ROWS,
            TERMINAL_MAX_ROWS,
        ),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SudoPlan {
    Plain,
    NonInteractive,
    Reject,
}

/// 纯授权决策：只读优先拒绝；`needsSudo` 无预热直接拒绝，有预热才允许
/// `sudo -n`。供 RPC 与单测共用（密码永不进入 PTY）。
pub fn sudo_plan(needs_sudo: bool, has_warm_sudo: bool) -> SudoPlan {
    match (needs_sudo, has_warm_sudo) {
        (false, _) => SudoPlan::Plain,
        (true, true) => SudoPlan::NonInteractive,
        (true, false) => SudoPlan::Reject,
    }
}

/// 组合只读 + sudo 判定（单测锁定两条拒绝路径）。
pub fn terminal_access(
    read_only: bool,
    needs_sudo: bool,
    has_warm_sudo: bool,
) -> Result<SudoPlan, String> {
    if read_only {
        return Err(READ_ONLY_TERMINAL_MESSAGE.to_string());
    }
    let plan = sudo_plan(needs_sudo, has_warm_sudo);
    if plan == SudoPlan::Reject {
        return Err(NEEDS_SUDO_TERMINAL_MESSAGE.to_string());
    }
    Ok(plan)
}

/// 审计/展示文本：`<cli> exec -it <id> <shell>`，不含任何键入字节。
pub fn terminal_audit_command(
    engine: &EngineConfig,
    container_id: &str,
    shell: TerminalShell,
) -> String {
    format!(
        "{} exec -it {} {}",
        engine.cli,
        container_id,
        shell.as_str()
    )
}

const AUTO_SHELL_SCRIPT: &str =
    "for s in bash zsh fish ash sh; do if command -v \"$s\" >/dev/null 2>&1; then exec \"$s\"; fi; done; exec sh";

/// 远端固定脚本 + 位置参数（cli/id/shell 全部只作 `$1..$3`）。`use_sudo`
/// 只产生 `sudo -n`（非交互）前缀——密码永不出现。
pub fn terminal_ssh_command(
    engine: &EngineConfig,
    container_id: &str,
    shell: TerminalShell,
    use_sudo: bool,
) -> String {
    let prefix = if use_sudo { "exec sudo -n " } else { "exec " };
    let invoke = if shell == TerminalShell::Auto {
        format!(
            "{prefix}\"$1\" exec -it \"$2\" sh -lc {}",
            shell_quote(AUTO_SHELL_SCRIPT)
        )
    } else {
        format!("{prefix}\"$1\" exec -it \"$2\" \"$3\"")
    };
    let script = format!("{}{}", engine.env_prefix(), invoke);
    format!(
        "sh -c {} sh {} {} {}",
        shell_quote(&script),
        shell_quote(&engine.cli),
        shell_quote(container_id),
        shell_quote(shell.as_str())
    )
}

/// 本机 argv（无 shell）。显式 shell 直接作为 `docker exec` 的命令；
/// auto 在容器内用固定脚本按 bash→sh 探测。
pub fn terminal_local_args(container_id: &str, shell: TerminalShell) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "-it".to_string(),
        container_id.to_string(),
    ];
    match shell {
        TerminalShell::Auto => {
            args.push("sh".to_string());
            args.push("-lc".to_string());
            args.push(AUTO_SHELL_SCRIPT.to_string());
        }
        other => args.push(other.as_str().to_string()),
    }
    args
}

pub enum TerminalSource {
    Local {
        program: PathBuf,
        args: Vec<String>,
        endpoint: Option<String>,
    },
    Ssh {
        handle: Arc<Handle<SshClient>>,
        command: String,
    },
}

pub struct TerminalOpenRequest {
    pub connection_id: String,
    pub container_id: String,
    pub shell: TerminalShell,
    pub cols: u16,
    pub rows: u16,
    pub requested_terminal_id: Option<String>,
    pub after_sequence: u64,
    pub source: TerminalSource,
}

pub(super) enum TerminalCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

pub(crate) struct TerminalEntry {
    pub(super) id: String,
    pub(super) connection_id: String,
    pub(super) owner: String,
    pub(super) cancel: watch::Sender<bool>,
    pub(super) ended: Arc<AtomicBool>,
    pub(super) join: Mutex<Option<JoinHandle<()>>>,
    pub(super) input: mpsc::Sender<TerminalCommand>,
    pub(super) replay: Arc<Mutex<ReplayBuffer>>,
    pub(super) last_activity: Arc<Mutex<Instant>>,
}

#[derive(Default)]
struct RegistryState {
    terminals: HashMap<String, Arc<TerminalEntry>>,
    by_connection: HashMap<String, Vec<String>>,
}

pub(super) fn valid_terminal_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn prune_finished(state: &mut RegistryState) {
    let finished: Vec<String> = state
        .terminals
        .iter()
        .filter(|(_, entry)| {
            entry
                .join
                .lock()
                .map(|join| join.as_ref().is_some_and(|task| task.is_finished()))
                .unwrap_or(false)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in finished {
        if let Some(entry) = state.terminals.remove(&id) {
            if let Some(ids) = state.by_connection.get_mut(&entry.connection_id) {
                ids.retain(|value| value != &id);
                if ids.is_empty() {
                    state.by_connection.remove(&entry.connection_id);
                }
            }
        }
    }
}

#[path = "terminal_registry.rs"]
mod registry;
pub use registry::*;
