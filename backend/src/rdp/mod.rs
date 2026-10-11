//! RDP 远程桌面子模块门面（P1 隔离：原 rdp_session.rs 按职责拆分，本模块
//! 对 main.rs 保持原有 API——RPC 方法名与请求/运行时类型再导出不变）。
//!
//! 模块划分与依赖方向（单向，禁止反向引用）：
//! - `wire`：RPC 线制类型 + 请求 Debug 脱敏（零依赖）
//! - `security`：安全策略解析（评审锁定面，仅依赖 wire 的身份上界）
//! - `limits`：尺寸/剪贴板纯校验（零依赖）
//! - `error`：错误分类 + 重连预算/退避（零依赖）
//! - `cert`：已知证书存储 + 120s 提示代理 + TLS 校验器（依赖 security）
//! - `clipboard`：text-only CLIPRDR 桥（依赖 limits 的 16 MiB 门限）
//! - `frame`：44 字节补丁帧编码 + 回放桌面（依赖 limits 的尺寸门限）
//! - `input`：键鼠映射（依赖 wire 的输入形状）
//! - `session`：会话运行时（汇聚以上全部，且是唯一持有vendored 引擎类型处）
//!
//! `tests` 经 `use super::*` 走本模块再导出，保持原有断言不变。
//!
//! 安全红线（评审锁定，docs/RDP_CREDSSP_REVIEW_CHECKLIST.zh-CN.md）随拆分
//! 原样保留在各子模块：NTLMv2-only（vendored sspi fail-closed）、凭据
//! Zeroizing 不落日志、证书策略 fail-closed（prompt/strict/accept-
//! temporarily，120s 窗）、剪贴板 text-only 16 MiB、认证失败统一文案。

pub mod cert;
pub mod clipboard;
pub mod error;
pub mod frame;
pub mod input;
pub mod limits;
pub mod security;
pub mod session;
pub mod wire;

// —— 对 main.rs 的再导出（对外形状与拆分前的 rdp_session 完全一致）——
pub(crate) use session::RdpSessionRuntime;
pub(crate) use wire::{RdpInputRequest, RdpResizeRequest, RdpStartRequest};
// —— tests.rs 经 `use super::*` 取用各子模块全部 pub(crate) 项（仅测试期
//    编译；编译器保证 glob 名字唯一性）——
#[cfg(test)]
pub(crate) use cert::*;
#[cfg(test)]
pub(crate) use clipboard::*;
#[cfg(test)]
pub(crate) use error::*;
#[cfg(test)]
pub(crate) use frame::*;
#[cfg(test)]
pub(crate) use input::*;
#[cfg(test)]
pub(crate) use limits::*;
#[cfg(test)]
pub(crate) use security::*;
#[cfg(test)]
pub(crate) use session::*;
#[cfg(test)]
pub(crate) use wire::*;

#[cfg(test)]
mod tests;
