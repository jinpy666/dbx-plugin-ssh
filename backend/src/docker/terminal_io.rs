//! 容器终端的 I/O runner（B5）：本机 `portable-pty` 与远端 SSH PTY 通道。
//!
//! 与 [`super::terminal`] 的注册表/纯决策分离，保持两个文件都在 600 行预算内。
//! 两个 runner 共用 [`Runner::publish`]/[`Runner::finish`]：输出先进入 2 MiB
//! replay 环形缓冲，再发 `docker/terminal/out/{id}`；终态只发一次
//! `docker/terminal/end`。关闭/TTL 都会回收子进程（附录 C.2），SSH 通道显式
//! `close()`，本机 PTY 先 `kill()` 再让 wait 线程回收。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::client::Handle;
use russh::ChannelMsg;
use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::model::TerminalStream;
use crate::ssh::{ReplayBuffer, SshClient};

use super::logs_stream::StreamSink;
use super::terminal::{terminal_out_channel, TerminalCommand, TERMINAL_IDLE_TTL};

pub(super) struct Runner {
    terminal_id: String,
    sink: Arc<dyn StreamSink>,
    replay: Arc<Mutex<ReplayBuffer>>,
    ended: Arc<AtomicBool>,
    last_activity: Arc<Mutex<Instant>>,
}

impl Runner {
    pub(super) fn new(
        terminal_id: String,
        sink: Arc<dyn StreamSink>,
        replay: Arc<Mutex<ReplayBuffer>>,
        ended: Arc<AtomicBool>,
        last_activity: Arc<Mutex<Instant>>,
    ) -> Self {
        Self {
            terminal_id,
            sink,
            replay,
            ended,
            last_activity,
        }
    }

    fn publish(&self, stream: TerminalStream, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        *self
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Instant::now();
        let frame = self
            .replay
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .push(stream, data);
        self.sink
            .binary(&terminal_out_channel(&self.terminal_id), &frame.encode())
    }

    fn finish(&self, reason: &'static str, exit_code: Option<i32>) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut params = json!({ "terminalId": self.terminal_id.clone(), "reason": reason });
        if let Some(code) = exit_code {
            params["exitCode"] = json!(code);
        }
        let _ = self.sink.event("docker/terminal/end", params);
    }

    fn idle_deadline(&self) -> tokio::time::Instant {
        let last = *self
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        (last + TERMINAL_IDLE_TTL).into()
    }
}

type ReaderHandle = tokio::task::JoinHandle<()>;

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    output: mpsc::UnboundedSender<Vec<u8>>,
) -> ReaderHandle {
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if output.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}

pub(super) struct LocalJob {
    pub(super) runner: Runner,
    pub(super) program: PathBuf,
    pub(super) args: Vec<String>,
    pub(super) endpoint: Option<String>,
    pub(super) cols: u16,
    pub(super) rows: u16,
}

pub(super) fn spawn_local(
    job: LocalJob,
    commands: mpsc::Receiver<TerminalCommand>,
    cancel: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(run_local(job, commands, cancel))
}

async fn run_local(
    job: LocalJob,
    mut commands: mpsc::Receiver<TerminalCommand>,
    mut cancel: watch::Receiver<bool>,
) {
    let LocalJob {
        runner,
        program,
        args,
        endpoint,
        cols,
        rows,
    } = job;
    let reason;
    let mut exit_code = None;
    let pty = native_pty_system();
    let pair = match pty.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            runner.finish("error", None);
            let _ = runner.sink.event(
                "docker/terminal/error",
                json!({ "terminalId": runner.terminal_id.clone(), "error": format!("Failed to open a pseudo terminal: {error}") }),
            );
            return;
        }
    };
    let (reader, writer) = match (pair.master.try_clone_reader(), pair.master.take_writer()) {
        (Ok(reader), Ok(writer)) => (reader, writer),
        _ => {
            runner.finish("error", None);
            return;
        }
    };
    let mut command = CommandBuilder::new(&program);
    command.args(&args);
    command.env("TERM", "xterm-256color");
    if let Some(endpoint) = endpoint.as_deref() {
        command.env("DOCKER_HOST", endpoint);
        command.env("CONTAINER_HOST", endpoint);
    }
    let child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            runner.finish("error", None);
            let _ = runner.sink.event(
                "docker/terminal/error",
                json!({ "terminalId": runner.terminal_id.clone(), "error": format!("Failed to start {}: {error}", program.display()) }),
            );
            return;
        }
    };
    let mut killer: Box<dyn ChildKiller + Send + Sync> = child.clone_killer();
    drop(pair.slave);
    let master: Box<dyn MasterPty + Send> = pair.master;
    let writer = Arc::new(Mutex::new(writer));

    let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let _reader_task = spawn_reader(reader, output_tx);

    let (exit_tx, mut exit_rx) = mpsc::unbounded_channel::<Option<u32>>();
    tokio::task::spawn_blocking(move || {
        let mut child = child;
        let status = child.wait();
        let _ = exit_tx.send(status.ok().map(|status| status.exit_code()));
    });

    loop {
        let deadline = runner.idle_deadline();
        tokio::select! {
            _ = cancel.changed() => {
                reason = "closed";
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                reason = "closed";
                break;
            }
            command = commands.recv() => match command {
                Some(TerminalCommand::Input(data)) => {
                    let mut writer = writer.lock().unwrap_or_else(|poison| poison.into_inner());
                    if writer.write_all(&data).is_err() {
                        reason = "error";
                        break;
                    }
                }
                Some(TerminalCommand::Resize { cols, rows }) => {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                Some(TerminalCommand::Close) => {
                    reason = "closed";
                    break;
                }
                None => {
                    reason = "closed";
                    break;
                }
            },
            chunk = output_rx.recv() => match chunk {
                Some(data) => {
                    if runner.publish(TerminalStream::Stdout, data).is_err() {
                        reason = "error";
                        break;
                    }
                }
                None => {
                    if let Ok(code) = exit_rx.try_recv() {
                        exit_code = code.map(|code| code as i32);
                    }
                    reason = "exited";
                    break;
                }
            },
            code = exit_rx.recv() => {
                exit_code = code.flatten().map(|code| code as i32);
                reason = "exited";
                break;
            }
        }
    }

    if reason != "exited" {
        let _ = killer.kill();
    }
    runner.finish(reason, exit_code);
}

pub(super) struct RemoteJob {
    pub(super) runner: Runner,
    pub(super) handle: Arc<Handle<SshClient>>,
    pub(super) command: String,
    pub(super) cols: u16,
    pub(super) rows: u16,
}

pub(super) fn spawn_remote(
    job: RemoteJob,
    commands: mpsc::Receiver<TerminalCommand>,
    cancel: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(run_remote(job, commands, cancel))
}

async fn run_remote(
    job: RemoteJob,
    mut commands: mpsc::Receiver<TerminalCommand>,
    mut cancel: watch::Receiver<bool>,
) {
    let RemoteJob {
        runner,
        handle,
        command,
        cols,
        rows,
    } = job;
    let reason;
    let mut exit_code = None;
    let mut channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => {
            runner.finish("error", None);
            let _ = runner.sink.event(
                "docker/terminal/error",
                json!({ "terminalId": runner.terminal_id.clone(), "error": format!("Failed to open container terminal channel: {error}") }),
            );
            return;
        }
    };
    if let Err(error) = channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(cols),
            u32::from(rows),
            0,
            0,
            &[],
        )
        .await
    {
        runner.finish("error", None);
        let _ = runner.sink.event(
            "docker/terminal/error",
            json!({ "terminalId": runner.terminal_id.clone(), "error": format!("Failed to request SSH PTY: {error}") }),
        );
        return;
    }
    if let Err(error) = channel.exec(true, command.as_bytes()).await {
        runner.finish("error", None);
        let _ = runner.sink.event(
            "docker/terminal/error",
            json!({ "terminalId": runner.terminal_id.clone(), "error": format!("Failed to start container terminal: {error}") }),
        );
        return;
    }

    loop {
        let deadline = runner.idle_deadline();
        tokio::select! {
            _ = cancel.changed() => {
                reason = "closed";
                let _ = channel.close().await;
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                reason = "closed";
                let _ = channel.close().await;
                break;
            }
            command = commands.recv() => match command {
                Some(TerminalCommand::Input(data)) => {
                    if channel.data(&data[..]).await.is_err() {
                        reason = "error";
                        break;
                    }
                }
                Some(TerminalCommand::Resize { cols, rows }) => {
                    let _ = channel.window_change(u32::from(cols), u32::from(rows), 0, 0).await;
                }
                Some(TerminalCommand::Close) => {
                    reason = "closed";
                    let _ = channel.close().await;
                    break;
                }
                None => {
                    reason = "closed";
                    break;
                }
            },
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) => {
                        if runner.publish(TerminalStream::Stdout, data.to_vec()).is_err() {
                            reason = "error";
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if runner.publish(TerminalStream::Stderr, data.to_vec()).is_err() {
                            reason = "error";
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                    }
                    Some(ChannelMsg::ExitSignal { .. }) => {
                        reason = "exited";
                        break;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        reason = "exited";
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    let _ = channel.close().await;
    runner.finish(reason, exit_code);
}
