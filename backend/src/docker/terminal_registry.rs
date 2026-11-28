//! 容器终端注册表（B5）：并发上限、连接索引、墓碑、close/resize/replay 与
//! 输入入口。纯协议与命令构造在 [`super::terminal`]；I/O runner 在
//! [`super::terminal_io`]。本文件由 `terminal.rs` 以 `#[path]` 子模块引入。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use dbx_plugin_sdk::PluginEmitter;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use crate::ssh::ReplayBuffer;

use super::super::logs_stream::StreamSink;
use super::{
    prune_finished, valid_terminal_id, RegistryState, TerminalCommand, TerminalEntry,
    TerminalOpenRequest, TerminalSource, CLOSED_TERMINAL_TTL, CLOSE_GRACE, MAX_ACTIVE_TERMINALS,
};

/// 单个终端的输入队列。键入帧很小，256 足够吸收一阵爆发；满即报错。
const INPUT_QUEUE: usize = 256;

pub struct TerminalRegistry {
    state: Mutex<RegistryState>,
    closed_owners: Mutex<HashMap<String, Instant>>,
    closed_ttl: Duration,
    max_active: usize,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new(MAX_ACTIVE_TERMINALS)
    }
}

impl TerminalRegistry {
    pub fn new(max_active: usize) -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            closed_owners: Mutex::new(HashMap::new()),
            closed_ttl: CLOSED_TERMINAL_TTL,
            max_active,
        }
    }

    /// 进程级单例。main.rs 只保留字面量分派臂，不新增运行时字段。
    pub fn global() -> &'static Self {
        static REGISTRY: OnceLock<TerminalRegistry> = OnceLock::new();
        REGISTRY.get_or_init(TerminalRegistry::default)
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    #[allow(dead_code)]
    pub fn active_count(&self) -> usize {
        self.lock_state().terminals.len()
    }

    #[allow(dead_code)]
    pub fn connection_terminal_count(&self, connection_id: &str) -> usize {
        self.lock_state()
            .by_connection
            .get(connection_id)
            .map(Vec::len)
            .unwrap_or(0)
    }

    pub(crate) fn register(&self, entry: Arc<TerminalEntry>) -> Result<(), String> {
        let mut state = self.lock_state();
        prune_finished(&mut state);
        let now = Instant::now();
        let mut closed = self
            .closed_owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        closed.retain(|_, at| now.duration_since(*at) < self.closed_ttl);
        if closed.contains_key(&entry.owner) {
            return Err(format!(
                "Container terminal '{}' was closed; open it again with a new terminal id",
                entry.owner
            ));
        }
        if state.terminals.contains_key(&entry.id) {
            return Err(format!(
                "Container terminal '{}' is already active",
                entry.id
            ));
        }
        if state.terminals.len() >= self.max_active {
            return Err(format!(
                "Too many active container terminals ({max}); close one before opening another",
                max = self.max_active
            ));
        }
        state
            .by_connection
            .entry(entry.connection_id.clone())
            .or_default()
            .push(entry.id.clone());
        state.terminals.insert(entry.id.clone(), entry);
        Ok(())
    }

    /// `docker/terminal/open`：生成/校验 id、判定墓碑与上限、注册后 spawn runner。
    pub async fn open(
        &self,
        request: TerminalOpenRequest,
        sink: Arc<dyn StreamSink>,
    ) -> Result<Value, String> {
        let terminal_id = match request.requested_terminal_id.as_deref() {
            Some(id) => {
                if !valid_terminal_id(id) {
                    return Err(format!(
                        "Invalid requestedTerminalId '{id}': expected 1-128 characters of [A-Za-z0-9._-]"
                    ));
                }
                id.to_string()
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE);
        let (cancel, cancel_rx) = watch::channel(false);
        let replay = Arc::new(Mutex::new(ReplayBuffer::default()));
        let entry = Arc::new(TerminalEntry {
            id: terminal_id.clone(),
            connection_id: request.connection_id.clone(),
            owner: terminal_id.clone(),
            cancel,
            ended: Arc::new(AtomicBool::new(false)),
            join: Mutex::new(None),
            input: input_tx,
            replay: Arc::clone(&replay),
            last_activity: Arc::new(Mutex::new(Instant::now())),
        });
        self.register(Arc::clone(&entry))?;

        let runner = crate::docker::terminal_io::Runner::new(
            terminal_id.clone(),
            sink,
            Arc::clone(&entry.replay),
            Arc::clone(&entry.ended),
            Arc::clone(&entry.last_activity),
        );
        let task = match request.source {
            TerminalSource::Local {
                program,
                args,
                endpoint,
            } => crate::docker::terminal_io::spawn_local(
                crate::docker::terminal_io::LocalJob {
                    runner,
                    program,
                    args,
                    endpoint,
                    cols: request.cols,
                    rows: request.rows,
                },
                input_rx,
                cancel_rx,
            ),
            TerminalSource::Ssh { handle, command } => crate::docker::terminal_io::spawn_remote(
                crate::docker::terminal_io::RemoteJob {
                    runner,
                    handle,
                    command,
                    cols: request.cols,
                    rows: request.rows,
                },
                input_rx,
                cancel_rx,
            ),
        };
        *entry
            .join
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(task);

        let (sequence, replay_frames) = {
            let buffer = replay.lock().unwrap_or_else(|poison| poison.into_inner());
            (
                buffer.tail_sequence(),
                buffer
                    .after(request.after_sequence)
                    .into_iter()
                    .map(|frame| {
                        json!({
                            "sequence": frame.sequence,
                            "dataBase64": BASE64.encode(frame.data),
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        };
        Ok(json!({
            "terminalId": terminal_id,
            "containerId": request.container_id,
            "shell": request.shell.as_str(),
            "cols": request.cols,
            "rows": request.rows,
            "sequence": sequence,
            "replay": replay_frames,
        }))
    }

    /// 二进制输入：8 字节序号由调用方（main.rs）解码，这里只保留原始键。
    pub fn write_input(&self, terminal_id: &str, payload: Vec<u8>) -> Result<(), String> {
        let entry = {
            let state = self.lock_state();
            Arc::clone(state.terminals.get(terminal_id).ok_or_else(|| {
                format!("Container terminal '{terminal_id}' was not found or has ended")
            })?)
        };
        *entry
            .last_activity
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Instant::now();
        entry
            .input
            .try_send(TerminalCommand::Input(payload))
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    format!("Container terminal '{terminal_id}' input queue is full")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    format!("Container terminal '{terminal_id}' has ended")
                }
            })
    }

    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let entry = {
            let state = self.lock_state();
            Arc::clone(state.terminals.get(terminal_id).ok_or_else(|| {
                format!("Container terminal '{terminal_id}' was not found or has ended")
            })?)
        };
        entry
            .input
            .send(TerminalCommand::Resize { cols, rows })
            .await
            .map_err(|_| format!("Container terminal '{terminal_id}' has ended"))
    }

    pub fn replay(
        &self,
        terminal_id: &str,
        after_sequence: u64,
        sink: &dyn StreamSink,
    ) -> Result<Value, String> {
        let entry = {
            let state = self.lock_state();
            Arc::clone(state.terminals.get(terminal_id).ok_or_else(|| {
                format!("Container terminal '{terminal_id}' was not found or has ended")
            })?)
        };
        let buffer = entry
            .replay
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let first_available_sequence = buffer.first_sequence();
        let tail_sequence = buffer.tail_sequence();
        let frames = buffer.after(after_sequence);
        drop(buffer);
        let channel = terminal_out_channel(terminal_id);
        for frame in &frames {
            sink.binary(&channel, &frame.encode())?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": replay_complete(after_sequence, first_available_sequence),
        }))
    }

    /// 幂等关闭：先让 runner 发 `end {reason:"closed"}` 再 await 回收；
    /// 未知 id 同样返回 success（不发事件）。
    pub async fn close(&self, terminal_id: &str, sink: &dyn StreamSink) -> Result<Value, String> {
        let entry = {
            let mut state = self.lock_state();
            let entry = state.terminals.remove(terminal_id);
            if let Some(entry) = entry.as_ref() {
                if let Some(ids) = state.by_connection.get_mut(&entry.connection_id) {
                    ids.retain(|value| value != terminal_id);
                    if ids.is_empty() {
                        state.by_connection.remove(&entry.connection_id);
                    }
                }
            }
            entry
        };
        let Some(entry) = entry else {
            return Ok(json!({ "success": true }));
        };
        self.closed_owners
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(entry.owner.clone(), Instant::now());
        let _ = entry.cancel.send(true);
        let _ = entry.input.send(TerminalCommand::Close).await;
        let join = entry
            .join
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(mut join) = join {
            if tokio::time::timeout(CLOSE_GRACE, &mut join).await.is_err() {
                join.abort();
            }
        }
        if !entry.ended.swap(true, Ordering::SeqCst) {
            let _ = sink.event(
                "docker/terminal/end",
                json!({ "terminalId": terminal_id, "reason": "closed" }),
            );
        }
        Ok(json!({ "success": true }))
    }

    /// 连接断开时回收该连接下的所有终端（挂在日志流的同一清理点）。
    pub async fn stop_connection(&self, connection_id: &str) {
        let ids: Vec<String> = {
            let state = self.lock_state();
            state
                .by_connection
                .get(connection_id)
                .cloned()
                .unwrap_or_default()
        };
        for id in ids {
            let _ = self.close(&id, &DiscardSink).await;
        }
    }
}

pub fn terminal_out_channel(terminal_id: &str) -> String {
    format!("docker/terminal/out/{terminal_id}")
}

/// `docker/terminal/in/{id}` 的入口（main.rs 只保留一个前缀分支）。
/// 8 字节序号复用 `decode_sequenced_input`；写失败同时发 `error` 并返回
/// 错误，避免前端「打不进字但看起来还活着」。
pub fn handle_input(channel: &str, data: &[u8], emitter: &PluginEmitter) -> Result<(), String> {
    let Some(terminal_id) = channel.strip_prefix("docker/terminal/in/") else {
        return Err(format!("Not a container terminal input channel: {channel}"));
    };
    let (sequence, payload) = crate::decode_sequenced_input(data)?;
    match TerminalRegistry::global().write_input(terminal_id, payload) {
        Ok(()) => {
            let _ = emitter.event(
                "docker/terminal/inputAck",
                json!({ "terminalId": terminal_id, "sequence": sequence }),
            );
            Ok(())
        }
        Err(error) => {
            let _ = emitter.event(
                "docker/terminal/error",
                json!({ "terminalId": terminal_id, "error": error.clone() }),
            );
            Err(error)
        }
    }
}

/// replay 完整性：客户端请求的下一条（`after+1`）仍在环形缓冲内才算完整。
pub fn replay_complete(after_sequence: u64, first_available_sequence: u64) -> bool {
    after_sequence.saturating_add(1) >= first_available_sequence
}

/// 连接清理路径没有 emitter：事件直接丢弃（终端已随连接失效）。
struct DiscardSink;

impl StreamSink for DiscardSink {
    fn binary(&self, _channel: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }

    fn event(&self, _method: &str, _params: Value) -> Result<(), String> {
        Ok(())
    }
}
