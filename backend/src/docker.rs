//! Docker management panel backend (`docker/list` / `docker/logs` /
//! `docker/action`): POSIX collector scripts executed through `sh -s`
//! heredocs plus pure parsers, in the same style as [`crate::metrics`].
//! Zero new dependencies by design — the Docker CLI is driven over shell,
//! never the daemon API, and no docker client crate is pulled in.
//!
//! Safety model for actions: the verb comes from a fixed whitelist, the
//! container id must match `^[0-9a-f]{12,64}$`, read-only connections are
//! refused by the caller (`ensure_writable`), the intent is audited before
//! execution, and the sudo password never travels on the command line —
//! the fallback reuses the Quick Sudo pipeline (`exec_with_sudo`) which
//! pipes credentials over stdin.
//!
//! B1 拆分（纯搬移，无行为/协议变化）：`engine`（CLI 与 daemon 端点解析）·
//! `scripts`（远端采集/动作脚本文本、id 门、动作白名单）· `parse`
//! （marker/probe/ps/inspect/logs 纯解析）· `local`（本机 CLI 直连）·
//! `stats`（`docker stats` 只读指标：单位/百分比/速率差分纯函数 + 采集）·
//! `rpc`（从 `main.rs` 搬来的分派体）· `tests`。对外路径 `crate::docker::X`
//! 保持不变。

use std::time::Duration;

use serde_json::Value;

mod engine;
mod files;
#[cfg(test)]
mod files_tests;
mod local;
mod logs_batch;
mod logs_stream;
mod parse;
pub mod rpc;
mod scripts;
mod stats;
pub mod streams;
#[cfg(test)]
mod tests;

pub use engine::*;
pub use files::*;
pub use local::*;
pub use logs_batch::*;
pub use logs_stream::*;
pub use parse::*;
pub use scripts::*;
pub use stats::*;
pub use streams::*;
/// Wait cap for the container list collector (one `docker ps` round-trip).
pub const LIST_TIMEOUT: Duration = Duration::from_secs(15);
/// Wait cap for `docker logs --tail N`; tailing is bounded by `--tail`.
pub const LOGS_TIMEOUT: Duration = Duration::from_secs(30);
/// Wait cap for lifecycle actions; `stop`/`restart` default to a 10s
/// container shutdown timeout, so 60s covers the worst case with slack.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(60);

/// Bounds for the `--tail` line count of `docker/logs`.
pub const TAIL_MIN: u64 = 10;
pub const TAIL_MAX: u64 = 2000;
pub const TAIL_DEFAULT: u64 = 200;

/// Where the docker family resolves its daemon: the SSH connection the
/// call is addressed to, or the local daemon on the machine the sidecar
/// runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DockerTarget {
    Ssh,
    Local,
}

pub fn parse_target(params: &Value) -> Result<DockerTarget, String> {
    match params.get("target") {
        None | Some(Value::Null) => Ok(DockerTarget::Ssh),
        Some(Value::String(target)) => match target.as_str() {
            "ssh" => Ok(DockerTarget::Ssh),
            "local" => Ok(DockerTarget::Local),
            other => Err(format!(
                "Unsupported docker target '{other}'. Supported: ssh (default), local"
            )),
        },
        Some(other) => Err(format!(
            "Invalid docker target {other}: expected \"ssh\" or \"local\""
        )),
    }
}
