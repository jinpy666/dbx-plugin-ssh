//! 容器日志流注册表（B3）：并发上限、按连接索引、关闭墓碑与幂等 stop。
//!
//! 设计对应计划 §5.6 / §5.7 / 附录 C.3：
//!
//! - **并发上限** 8/sidecar，双检（锁外快检 + 锁内复检）超限返回可读错误，
//!   不排队——与 `monitor.rs` 的 `MONITOR_TASK_LIMIT` 同形。
//! - **按 connectionId 索引**：`by_connection` 让连接断开时的批量回收只需
//!   一次查找（`stop_connection` 已就绪，接线到 `disconnect_connection` 属
//!   B5 的统一清理点，本批不触碰 `ssh.rs`）。
//! - **关闭墓碑**：stop 写入 `closed_owners[owner] = Instant`，注册路径先查
//!   墓碑，命中即拒绝「关闭后晚到的 start」，防止流被复活；过期墓碑在注册
//!   路径惰性 `retain`，不额外起定时任务。
//! - **锁顺序固定**：注册先拿注册表锁、再拿墓碑锁（`start`）；stop 先在注册
//!   表锁内摘除，释放后再写墓碑，同一顺序，无反向持锁路径。
//! - **stop 真的收尾**：置 stop 标志（阻断后续数据帧）→ 发 cancel → `await`
//!   任务 JoinHandle（有界超时），确保 `close_channel` 与子进程 `wait()` 已
//!   完成才返回；未知 id 返回成功（幂等）。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbx_plugin_sdk::PluginEmitter;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::logs_batch::{now_ms, StreamLimits, STOP_GRACE};
use super::logs_stream::{run_stream, StreamSink, StreamSource};

/// 并发日志流上限（§5.6，参照 `MONITOR_TASK_LIMIT` 的双检模式）。
pub const MAX_ACTIVE_STREAMS: usize = 8;
/// 关闭墓碑存活时间：覆盖「stop 响应与迟到的 start 请求交错」的窗口即可。
pub const CLOSED_OWNER_TTL: Duration = Duration::from_secs(30);

/// 生产 emit 面：SDK 的 `PluginEmitter`（JSON 事件 + 二进制帧）。
impl StreamSink for PluginEmitter {
    fn binary(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        PluginEmitter::binary(self, channel, data).map_err(|error| error.message)
    }

    fn event(&self, method: &str, params: Value) -> Result<(), String> {
        PluginEmitter::event(self, method, params).map_err(|error| error.message)
    }
}

/// 启动一条日志流所需的全部已校验输入（rpc 层构造）。
pub struct StreamRequest {
    pub connection_id: String,
    pub container_id: String,
    /// 调用方预生成的 id（前端先订阅再发起 RPC）；非法 id 直接拒绝。
    pub requested_stream_id: Option<String>,
    pub tail: u64,
    pub timestamps: bool,
    pub source: StreamSource,
}

struct StreamEntry {
    id: String,
    connection_id: String,
    /// 墓碑键：优先取调用方 id，否则取服务端 id（无人会复用，等价无效键）。
    owner: String,
    cancel: watch::Sender<bool>,
    stop_requested: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

/// 注册表状态（单锁保护两张表，临界区内无 await）。
#[derive(Default)]
struct RegistryState {
    streams: HashMap<String, Arc<StreamEntry>>,
    /// connectionId → streamId 集合（连接断开时一次查找批量回收）。
    by_connection: HashMap<String, HashSet<String>>,
}

/// 回收任务已结束的条目（任务自然退出后不会自己回注册表）。
///
/// 只在上限边界调用：未到上限时保持「自然结束后条目留到 stop」的既有语义，
/// 让墓碑仍能拦住迟到的同 id start。`join` 尚未写入的条目视为未结束。
fn prune_finished(state: &mut RegistryState) {
    let finished: Vec<String> = state
        .streams
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
        if let Some(entry) = state.streams.remove(&id) {
            if let Some(ids) = state.by_connection.get_mut(&entry.connection_id) {
                ids.remove(&id);
                if ids.is_empty() {
                    state.by_connection.remove(&entry.connection_id);
                }
            }
        }
    }
}

/// 日志流注册表：进程内状态，随 sidecar 生命周期结束，不持久化。
pub struct StreamRegistry {
    state: Mutex<RegistryState>,
    closed_owners: Mutex<HashMap<String, Instant>>,
    limits: StreamLimits,
    closed_ttl: Duration,
    stop_grace: Duration,
}

impl Default for StreamRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamRegistry {
    pub fn new() -> Self {
        Self::with_limits(StreamLimits::default())
    }

    /// 单测可注入小上限；产品路径恒用 [`StreamLimits::default`]。
    pub fn with_limits(limits: StreamLimits) -> Self {
        Self::with_limits_and_grace(limits, STOP_GRACE)
    }

    /// 单测用：同时缩短子进程回收宽限，避免测试等待产品值的 2s。
    #[allow(dead_code)]
    pub fn with_limits_and_grace(limits: StreamLimits, stop_grace: Duration) -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            closed_owners: Mutex::new(HashMap::new()),
            limits,
            closed_ttl: CLOSED_OWNER_TTL,
            stop_grace,
        }
    }

    /// 当前活跃流数量（单测与状态展示）。
    #[allow(dead_code)]
    pub fn active_count(&self) -> usize {
        self.lock_state().streams.len()
    }

    /// 某连接下的活跃流数（连接清理面的就绪索引）。
    #[allow(dead_code)]
    pub fn connection_stream_count(&self, connection_id: &str) -> usize {
        self.lock_state()
            .by_connection
            .get(connection_id)
            .map(HashSet::len)
            .unwrap_or(0)
    }

    /// `docker/logs/stream/start`：校验墓碑 → 查活跃 → 抢上限 → 注册 → spawn。
    pub async fn start(
        &self,
        request: StreamRequest,
        sink: Arc<dyn StreamSink>,
    ) -> Result<Value, String> {
        let stream_id = match request.requested_stream_id.as_deref() {
            Some(id) => {
                if !valid_stream_id(id) {
                    return Err(format!(
                        "Invalid requestedStreamId '{id}': expected 1-128 characters of [A-Za-z0-9._-]"
                    ));
                }
                id.to_string()
            }
            None => uuid::Uuid::new_v4().to_string(),
        };
        let owner = stream_id.clone();

        // 锁顺序：注册表 → 墓碑。两把锁的临界区都是纯内存操作，无 await。
        let mut state = self.lock_state();
        {
            let now = Instant::now();
            let mut closed = self
                .closed_owners
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            closed.retain(|_, at| now.duration_since(*at) < self.closed_ttl);
            if closed.contains_key(&owner) {
                return Err(format!(
                    "docker log stream '{owner}' was closed; start it again with a new stream id"
                ));
            }
        }
        if state.streams.contains_key(&stream_id) {
            return Err(format!("docker log stream '{stream_id}' is already active"));
        }
        if state.streams.len() >= MAX_ACTIVE_STREAMS {
            // 自然结束（exited/ttl/error）的任务只发 `end` 就退出，不会自己回到
            // 注册表；抽屉一直开着时前端通常也不会补一次 stop。只在上限边界惰性
            // 回收已结束的条目，避免 8 次「容器重启 → 流结束」把上限永久耗尽；
            // 未到上限时语义不变（条目留到 stop，便于墓碑防迟到 start）。
            prune_finished(&mut state);
        }
        if state.streams.len() >= MAX_ACTIVE_STREAMS {
            return Err(format!(
                "docker log stream limit reached ({MAX_ACTIVE_STREAMS}); stop a stream first"
            ));
        }

        let (cancel, cancel_rx) = watch::channel(false);
        let stop_requested = Arc::new(AtomicBool::new(false));
        let entry = Arc::new(StreamEntry {
            id: stream_id.clone(),
            connection_id: request.connection_id.clone(),
            owner,
            cancel,
            stop_requested: stop_requested.clone(),
            join: Mutex::new(None),
        });
        let task_id = stream_id.clone();
        let task = tokio::spawn(run_stream(
            task_id,
            request.source,
            cancel_rx,
            stop_requested,
            sink,
            self.limits,
            self.stop_grace,
        ));
        *entry
            .join
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(task);
        state.streams.insert(stream_id.clone(), entry);
        state
            .by_connection
            .entry(request.connection_id)
            .or_default()
            .insert(stream_id.clone());
        drop(state);

        Ok(json!({
            "streamId": stream_id,
            "containerId": request.container_id,
            "tail": request.tail,
            "timestamps": request.timestamps,
            "binaryInput": true,
            "startedAt": now_ms(),
        }))
    }

    /// `docker/logs/stream/stop`：幂等；未知 id 也返回成功。
    pub async fn stop(&self, stream_id: &str) -> Result<Value, String> {
        let entry = {
            let mut state = self.lock_state();
            let entry = state.streams.remove(stream_id);
            if let Some(entry) = &entry {
                if let Some(ids) = state.by_connection.get_mut(&entry.connection_id) {
                    ids.remove(&entry.id);
                    if ids.is_empty() {
                        state.by_connection.remove(&entry.connection_id);
                    }
                }
                // 墓碑与摘除在同一临界区内完成（保持「注册表 → 墓碑」锁序），
                // 否则 stop 释放注册表锁后、写墓碑前到达的 start 会绕过墓碑。
                let mut closed = self
                    .closed_owners
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                closed.insert(entry.owner.clone(), Instant::now());
            }
            entry
        };
        let Some(entry) = entry else {
            return Ok(json!({ "success": true }));
        };
        // 先阻断数据帧，再发取消；即使任务因关闭通道卡住，stop 返回后也不会
        // 再看到新的 `docker/logs/out` 帧。
        entry.stop_requested.store(true, Ordering::Relaxed);
        let _ = entry.cancel.send(true);
        let join = entry
            .join
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(join) = join {
            let settle = self.stop_grace + Duration::from_secs(3);
            let _ = tokio::time::timeout(settle, join).await;
        }
        Ok(json!({ "success": true }))
    }

    /// 连接级批量回收（§5.6 的统一清理点）：返回停止的流数量。
    pub async fn stop_connection(&self, connection_id: &str) -> usize {
        let ids: Vec<String> = {
            let state = self.lock_state();
            state
                .by_connection
                .get(connection_id)
                .map(|ids| ids.iter().cloned().collect())
                .unwrap_or_default()
        };
        for id in &ids {
            let _ = self.stop(id).await;
        }
        ids.len()
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// 调用方 id 的安全字符集：注册表键、事件通道后缀；拒绝 shell/路径元字符。
fn valid_stream_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
