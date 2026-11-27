//! 日志流纯函数半（B3）：聚合、TTL 判定、UTF-8 降级分条与固定脚本。
//!
//! 全部与 I/O 无关：时间由调用方注入 `Instant`，脚本只接受已校验参数。
//! runner / 子进程监督在 [`super::logs_stream`]，注册表在 [`super::streams`]。

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::exec;
use crate::model::TerminalStream;

use super::scripts::PATH_PREFIX;
use super::{clamp_tail, validate_container_id, EngineConfig};

/// 聚合上限：任一到达即 flush（附录 C.1）。
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
/// 聚合时间上限；日志稀疏时保证首行在 100 ms 内可见。
pub const BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// 流 TTL：先到者结束（§5.6）。
pub const STREAM_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const STREAM_MAX_DURATION: Duration = Duration::from_secs(30 * 60);
/// 取消后等待子进程自行退出的宽限；超过则 SIGKILL。
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// JSON 降级单条上限（16 KiB/条，UTF-8 边界安全）。
pub const FALLBACK_CHUNK_BYTES: usize = 16 * 1024;

/// TTL 阈值；`Default` 即产品值，单测用小上限注入。
#[derive(Debug, Clone, Copy)]
pub struct StreamLimits {
    pub max_bytes: u64,
    pub max_duration: Duration,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            max_bytes: STREAM_MAX_BYTES,
            max_duration: STREAM_MAX_DURATION,
        }
    }
}

/// TTL 纯判定：字节数或时长任一到达即结束（先到者）。
pub fn ttl_exceeded(elapsed: Duration, bytes: u64, limits: StreamLimits) -> bool {
    bytes >= limits.max_bytes || elapsed >= limits.max_duration
}

// —— 聚合（纯函数） ————————————————————————————————————

/// 一批同流数据：一帧一份（`TerminalStream` 保留 stdout/stderr 分流）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogBatch {
    pub stream: TerminalStream,
    pub data: Vec<u8>,
}

/// 连续同流 fragment 的聚合器。时间由调用方注入，flush 时机可确定性单测。
#[derive(Debug)]
pub struct ChunkBatcher {
    max_bytes: usize,
    interval: Duration,
    stream: Option<TerminalStream>,
    pending: Vec<u8>,
    started: Option<Instant>,
}

impl ChunkBatcher {
    pub fn new(max_bytes: usize, interval: Duration) -> Self {
        Self {
            max_bytes: max_bytes.max(1),
            interval,
            stream: None,
            pending: Vec::new(),
            started: None,
        }
    }

    /// 单测/诊断入口：当前是否无待发批次。
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// 单测/诊断入口：当前待发字节数。
    #[allow(dead_code)]
    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    /// 追加一段 fragment，返回本次应发送的批次（0–2 个）：流切换先 flush
    /// 旧流，再在达到字节上限时 flush 新流。**fragment 本身绝不切分**。
    pub fn push(&mut self, stream: TerminalStream, data: &[u8], now: Instant) -> Vec<LogBatch> {
        if data.is_empty() {
            return Vec::new();
        }
        let mut ready = Vec::new();
        if self.stream.is_some() && self.stream != Some(stream) {
            if let Some(batch) = self.flush() {
                ready.push(batch);
            }
        }
        if self.pending.is_empty() {
            self.started = Some(now);
        }
        self.stream = Some(stream);
        self.pending.extend_from_slice(data);
        if self.pending.len() >= self.max_bytes {
            if let Some(batch) = self.flush() {
                ready.push(batch);
            }
        }
        ready
    }

    /// 时间驱动的 flush：距本批首个 fragment 达到 interval 即发送。
    pub fn poll(&mut self, now: Instant) -> Option<LogBatch> {
        let started = self.started?;
        if now.saturating_duration_since(started) >= self.interval {
            return self.flush();
        }
        None
    }

    pub fn flush(&mut self) -> Option<LogBatch> {
        if self.pending.is_empty() {
            return None;
        }
        let stream = self.stream.take()?;
        self.started = None;
        Some(LogBatch {
            stream,
            data: std::mem::take(&mut self.pending),
        })
    }
}

/// 降级路径的 UTF-8 分条器：把字节流切成 ≤ `max_bytes` 的合法字符串，
/// 多字节字符跨条时保留残字节（`from_utf8_lossy` 只在流结束时兜底）。
#[derive(Debug)]
pub struct Utf8ChunkEncoder {
    max_bytes: usize,
    pending: Vec<u8>,
}

impl Utf8ChunkEncoder {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(4),
            pending: Vec::new(),
        }
    }

    pub fn push(&mut self, data: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(data);
        self.drain(false)
    }

    /// 流结束：把残字节按 lossy 输出（不丢内容，只可能把断字符替换为 U+FFFD）。
    pub fn finish(&mut self) -> Option<String> {
        let texts = self.drain(true);
        if texts.is_empty() {
            None
        } else {
            Some(texts.concat())
        }
    }

    fn drain(&mut self, final_flush: bool) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            if self.pending.is_empty() {
                break;
            }
            let limit = self.pending.len().min(self.max_bytes);
            match std::str::from_utf8(&self.pending[..limit]) {
                Ok(text) => {
                    out.push(text.to_string());
                    self.pending.drain(..limit);
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    match error.error_len() {
                        // 非法序列：以 lossy 覆盖到非法段末尾，绝不卡住。
                        Some(len) => {
                            let end = (valid + len).min(limit);
                            out.push(String::from_utf8_lossy(&self.pending[..end]).into_owned());
                            self.pending.drain(..end);
                        }
                        // 合法前缀 + 跨条截断的多字节字符：先发前缀，残字节留待下批。
                        None if valid > 0 => {
                            out.push(
                                // SAFETY-free: valid_up_to 保证前缀合法。
                                String::from_utf8_lossy(&self.pending[..valid]).into_owned(),
                            );
                            self.pending.drain(..valid);
                        }
                        None if final_flush => {
                            out.push(String::from_utf8_lossy(&self.pending).into_owned());
                            self.pending.clear();
                        }
                        None => break,
                    }
                }
            }
        }
        out
    }
}

// —— 脚本文本（固定体 + 位置参数） ———————————————————————

/// 固定脚本体：`exec <cli> logs --follow --tail N [--timestamps] -- "$1"`。
/// 脚本文本只含常量与已钳制的 tail/布尔开关，容器 id 只在 `"$1"`。
pub fn logs_stream_body(engine: &EngineConfig, tail: u64, timestamps: bool) -> String {
    let mut body = String::from(PATH_PREFIX);
    body.push_str(&engine.env_prefix());
    body.push_str("exec ");
    body.push_str(&engine.cli);
    body.push_str(&format!(" logs --follow --tail {}", clamp_tail(tail)));
    if timestamps {
        body.push_str(" --timestamps");
    }
    body.push_str(" -- \"$1\"\n");
    body
}

/// 远端命令：`sh -c '<固定体>' sh '<id>'`。id 已过门，仍按纵深再 quote 一次。
pub fn logs_stream_script(
    engine: &EngineConfig,
    container_id: &str,
    tail: u64,
    timestamps: bool,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    let body = logs_stream_body(engine, tail, timestamps);
    Ok(format!(
        "sh -c {} sh {}",
        exec::shell_quote(&body),
        exec::shell_quote(container_id)
    ))
}

/// 本机 argv（无 shell）：容器 id 作为独立参数，永不经字符串拼接。
pub fn logs_stream_args(container_id: &str, tail: u64, timestamps: bool) -> Vec<String> {
    let mut args = vec![
        "logs".to_string(),
        "--follow".to_string(),
        "--tail".to_string(),
        clamp_tail(tail).to_string(),
    ];
    if timestamps {
        args.push("--timestamps".to_string());
    }
    args.push("--".to_string());
    args.push(container_id.to_string());
    args
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
