//! FIG 补全引擎的 sidecar 侧 CompletionHost（wave-1 lane B）。
//!
//! 仅 `completion/execute`：generator 命令按 target 分派到本地短生命周期
//! 子进程（[`local`]）或既有 `SshRuntime::exec` 通道（[`ssh`]），统一超时
//! 竞速（决策 D3）、输出上限与 read-only 门（决策 D4）。线协议冻结于
//! `frontend/src/lib/completion/host/protocol.ts`，两侧字段逐字一致，由
//! [`protocol`] 的 round-trip 测试固化。

pub mod executor;
pub mod local;
pub mod protocol;
pub mod security;
pub mod ssh;
