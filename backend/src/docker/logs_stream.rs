//! 容器日志流 runner（B3）：`docker logs -f` 的读取、监督与降级发送。
//!
//! 纯函数半（聚合 / TTL / UTF-8 分条 / 固定脚本）在
//! [`super::logs_batch`]；本文件只做 I/O：
//!
//! - 数据源：本机 `Child`（argv 直呼，无 shell，`kill_on_drop`）或远端
//!   SSH exec 通道（`EOF + CLOSE` 回收远端 `exec` 过的 CLI）。
//! - 取消后先给 `STOP_GRACE` 自行退出，仍存活则 `kill()`（SIGKILL）并
//!   `wait()` 回收（附录 C.2）；TTL 独立于取消路径兜底。
//! - 回压：本地管道泵走有界队列，队列满即阻塞 read，OS 管道填满后 CLI
//!   写阻塞——整条链路不丢日志行（§5.7）。桥接报错立即停流，不重试。
//!
//! 安全红线与 `docker/scripts.rs` 相同：脚本体是常量，容器 id 只作位置
//! 参数（`$1`）或本机 argv，永不拼进脚本文本。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::Handle;
use russh::ChannelMsg;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};

use crate::model::{TerminalFrame, TerminalStream};
use crate::ssh::SshClient;

use super::logs_batch::{
    ttl_exceeded, ChunkBatcher, StreamLimits, Utf8ChunkEncoder, BATCH_INTERVAL,
    FALLBACK_CHUNK_BYTES, MAX_BATCH_BYTES,
};

/// 本地管道单次 read 大小与回压通道容量：队列满时泵阻塞，OS 管道随之
/// 填满，CLI 写阻塞——回压沿读循环一路传回，绝不丢日志行（§5.7）。
const READ_BUFFER_BYTES: usize = 8 * 1024;
const READ_CHANNEL_CAPACITY: usize = 16;

/// 输出接收面：生产实现是 `crate::PluginEmitter`，单测用记录型 sink。
/// 错误以字符串返回，调用方据文案区分「不支持二进制」与「桥接已断开」。
pub trait StreamSink: Send + Sync + 'static {
    fn binary(&self, channel: &str, data: &[u8]) -> Result<(), String>;
    fn event(&self, method: &str, params: Value) -> Result<(), String>;
}

// —— 数据源 ————————————————————————————————————————————

/// 一条流的数据源：本机子进程或远端 SSH exec 通道。
pub enum StreamSource {
    Local {
        program: PathBuf,
        args: Vec<String>,
        endpoint: Option<String>,
    },
    Ssh {
        handle: Arc<Handle<SshClient>>,
        script: String,
    },
}

/// supervisor 的收尾结果。
struct Outcome {
    reason: &'static str,
    exit_code: Option<i32>,
    error: Option<String>,
}

impl Outcome {
    fn ended(reason: &'static str, exit_code: Option<i32>) -> Self {
        Self {
            reason,
            exit_code,
            error: None,
        }
    }
}

/// 输出编码器：优先二进制帧；仅「framed transport」缺失时整条流转 JSON 分条。
struct FrameWriter {
    channel: String,
    stream_id: String,
    sink: Arc<dyn StreamSink>,
    sequence: u64,
    chunk_mode: bool,
    encoder: Utf8ChunkEncoder,
    stop_requested: Arc<AtomicBool>,
}

impl FrameWriter {
    fn emit(&mut self, stream: TerminalStream, data: &[u8]) -> Result<(), String> {
        if data.is_empty() || self.stop_requested.load(Ordering::Relaxed) {
            return Ok(());
        }
        if !self.chunk_mode {
            let frame = TerminalFrame {
                sequence: self.sequence,
                stream,
                data: data.to_vec(),
            };
            match self.sink.binary(&self.channel, &frame.encode()) {
                Ok(()) => {
                    self.sequence += 1;
                    return Ok(());
                }
                Err(message) if message.contains("require framed transport") => {
                    self.chunk_mode = true;
                }
                // 桥接已断开（webview 关闭）：立即停流，不重试。
                Err(message) => return Err(message),
            }
        }
        let texts = self.encoder.push(data);
        self.emit_chunks(&texts)
    }

    fn emit_chunks(&mut self, texts: &[String]) -> Result<(), String> {
        for text in texts {
            if text.is_empty() {
                continue;
            }
            self.sink.event(
                "docker/logs/chunk",
                json!({
                    "streamId": self.stream_id,
                    "sequence": self.sequence,
                    "text": text,
                }),
            )?;
            self.sequence += 1;
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        if self.chunk_mode && !self.stop_requested.load(Ordering::Relaxed) {
            if let Some(text) = self.encoder.finish() {
                self.emit_chunks(&[text])?;
            }
        }
        Ok(())
    }
}

/// 流任务入口：读 → 聚合 → 发帧/事件，最后保证 end 恰好一次。
pub async fn run_stream(
    stream_id: String,
    source: StreamSource,
    mut cancel: watch::Receiver<bool>,
    stop_requested: Arc<AtomicBool>,
    sink: Arc<dyn StreamSink>,
    limits: StreamLimits,
    stop_grace: Duration,
) {
    let started = Instant::now();
    let mut writer = FrameWriter {
        channel: format!("docker/logs/out/{stream_id}"),
        stream_id: stream_id.clone(),
        sink: sink.clone(),
        sequence: 0,
        chunk_mode: false,
        encoder: Utf8ChunkEncoder::new(FALLBACK_CHUNK_BYTES),
        stop_requested: stop_requested.clone(),
    };
    let mut batcher = ChunkBatcher::new(MAX_BATCH_BYTES, BATCH_INTERVAL);

    let outcome = match source {
        StreamSource::Local {
            program,
            args,
            endpoint,
        } => {
            let job = LocalJob {
                program,
                args,
                endpoint,
                limits,
                stop_grace,
            };
            run_local(&job, &mut cancel, &mut writer, &mut batcher, started).await
        }
        StreamSource::Ssh { handle, script } => {
            run_ssh(
                &handle,
                &script,
                &mut cancel,
                &mut writer,
                &mut batcher,
                started,
                limits,
            )
            .await
        }
    };
    let Outcome {
        reason,
        exit_code,
        error,
    } = outcome;
    if let Some(batch) = batcher.flush() {
        let _ = writer.emit(batch.stream, &batch.data);
    }
    let _ = writer.finish();
    if let Some(message) = error {
        let _ = sink.event(
            "docker/logs/error",
            json!({ "streamId": stream_id, "error": message }),
        );
    }
    let mut params = json!({ "streamId": stream_id, "reason": reason });
    if let Some(code) = exit_code {
        params["exitCode"] = json!(code);
    }
    let _ = sink.event("docker/logs/end", params);
}

struct LocalJob {
    program: PathBuf,
    args: Vec<String>,
    endpoint: Option<String>,
    limits: StreamLimits,
    stop_grace: Duration,
}

async fn run_local(
    job: &LocalJob,
    cancel: &mut watch::Receiver<bool>,
    writer: &mut FrameWriter,
    batcher: &mut ChunkBatcher,
    started: Instant,
) -> Outcome {
    let mut command = Command::new(&job.program);
    command
        .args(&job.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(endpoint) = &job.endpoint {
        command.env("DOCKER_HOST", endpoint);
        command.env("CONTAINER_HOST", endpoint);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Outcome {
                reason: "error",
                exit_code: None,
                error: Some(format!("Failed to start {:?}: {error}", job.program)),
            }
        }
    };
    let (sender, mut receiver) = mpsc::channel::<(TerminalStream, Vec<u8>)>(READ_CHANNEL_CAPACITY);
    pump(child.stdout.take(), TerminalStream::Stdout, sender.clone());
    pump(child.stderr.take(), TerminalStream::Stderr, sender.clone());
    drop(sender);

    let mut ticker = tokio::time::interval(BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut bytes = 0u64;
    let outcome = loop {
        if *cancel.borrow() {
            break Outcome::ended("stopped", None);
        }
        if ttl_exceeded(started.elapsed(), bytes, job.limits) {
            break Outcome::ended("ttl", None);
        }
        tokio::select! {
            biased;
            _ = wait_cancel(cancel) => break Outcome::ended("stopped", None),
            _ = ticker.tick() => {
                if let Some(batch) = batcher.poll(Instant::now()) {
                    if let Err(message) = writer.emit(batch.stream, &batch.data) {
                        break Outcome { reason: "error", exit_code: None, error: Some(message) };
                    }
                    bytes += batch.data.len() as u64;
                }
            }
            item = receiver.recv() => match item {
                Some((stream, data)) => {
                    for batch in batcher.push(stream, &data, Instant::now()) {
                        if let Err(message) = writer.emit(batch.stream, &batch.data) {
                            return finish_local(&mut child, outcome_error(message), job.stop_grace).await;
                        }
                        bytes += batch.data.len() as u64;
                    }
                }
                None => {
                    let code = wait_child(&mut child).await;
                    break Outcome::ended("exited", code);
                }
            }
        }
    };
    finish_local(&mut child, outcome, job.stop_grace).await
}

fn outcome_error(message: String) -> Outcome {
    Outcome {
        reason: "error",
        exit_code: None,
        error: Some(message),
    }
}

/// flush 残余 → 宽限后 SIGKILL；返回原 outcome。
async fn finish_local(child: &mut Child, outcome: Outcome, grace: Duration) -> Outcome {
    stop_child(child, grace).await;
    outcome
}

/// 取消后先给 `grace` 自行退出；仍存活则 SIGKILL 并 `wait()` 回收。
pub async fn stop_child(child: &mut Child, grace: Duration) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    if tokio::time::timeout(grace, child.wait()).await.is_ok() {
        return;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn wait_child(child: &mut Child) -> Option<i32> {
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => None,
    }
}

fn pump<R>(pipe: Option<R>, stream: TerminalStream, sender: mpsc::Sender<(TerminalStream, Vec<u8>)>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(pipe) = pipe else {
        return;
    };
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = pipe;
        let mut buffer = vec![0u8; READ_BUFFER_BYTES];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => {
                    // 队列满时在这里阻塞：回压传到 OS 管道，不丢行。
                    if sender
                        .send((stream, buffer[..read].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

async fn run_ssh(
    handle: &Handle<SshClient>,
    script: &str,
    cancel: &mut watch::Receiver<bool>,
    writer: &mut FrameWriter,
    batcher: &mut ChunkBatcher,
    started: Instant,
    limits: StreamLimits,
) -> Outcome {
    let mut channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => return outcome_error(format!("Failed to open logs channel: {error}")),
    };
    if let Err(error) = channel.exec(true, script.as_bytes()).await {
        let _ = channel.eof().await;
        let _ = channel.close().await;
        return outcome_error(format!("Failed to start docker logs follow: {error}"));
    }
    let mut ticker = tokio::time::interval(BATCH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut bytes = 0u64;
    let mut exit_code = None;
    let outcome = loop {
        if *cancel.borrow() {
            break Outcome::ended("stopped", None);
        }
        if ttl_exceeded(started.elapsed(), bytes, limits) {
            break Outcome::ended("ttl", None);
        }
        tokio::select! {
            biased;
            _ = wait_cancel(cancel) => break Outcome::ended("stopped", None),
            _ = ticker.tick() => {
                if let Some(batch) = batcher.poll(Instant::now()) {
                    if let Err(message) = writer.emit(batch.stream, &batch.data) {
                        break outcome_error(message);
                    }
                    bytes += batch.data.len() as u64;
                }
            }
            message = channel.wait() => match message {
                None => break Outcome::ended("exited", exit_code),
                Some(ChannelMsg::Data { ref data }) => {
                    if let Err(message) =
                        feed_ssh(batcher, TerminalStream::Stdout, data, writer, &mut bytes).await
                    {
                        break outcome_error(message);
                    }
                }
                Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                    if let Err(message) =
                        feed_ssh(batcher, TerminalStream::Stderr, data, writer, &mut bytes).await
                    {
                        break outcome_error(message);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status as i32);
                }
                Some(ChannelMsg::Eof) => {
                    // openSSH sends exit-status → eof → close; keeping the
                    // loop alive through eof preserves the exit code.
                }
                Some(ChannelMsg::Close) => {
                    break Outcome::ended("exited", exit_code);
                }
                Some(_) => {}
            }
        }
    };
    let _ = channel.eof().await;
    let _ = channel.close().await;
    outcome
}

async fn feed_ssh(
    batcher: &mut ChunkBatcher,
    stream: TerminalStream,
    data: &[u8],
    writer: &mut FrameWriter,
    bytes: &mut u64,
) -> Result<(), String> {
    for batch in batcher.push(stream, data, Instant::now()) {
        writer.emit(batch.stream, &batch.data)?;
        *bytes += batch.data.len() as u64;
    }
    Ok(())
}

/// 取消信号：true 或发送端已丢弃（注册表拆条目）都视为取消。
async fn wait_cancel(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}
