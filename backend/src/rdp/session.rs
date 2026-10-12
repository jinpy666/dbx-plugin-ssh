//! 会话运行时：每活会话一条 entry（generation 守卫重连、Zeroizing 凭据、
//! 证书/剪贴板协作件），worker 沿 vendored 引擎线程泵帧/输入/指针事件，
//! 引擎配置在每代构建（凭据只在 with_password 边界物化一次）。
use super::cert::{CertPromptBroker, KnownCertStore, RdpCertificateVerifier};
use super::clipboard::{ClipboardStage, TextClipboardBackendFactory};
use super::error::{
    classify_connector_error_text, classify_session_error_text, connector_error_message,
    reconnect_delay, session_error_message, GenerationEnd, RdpErrorKind, ReconnectBudget,
};
use super::frame::RdpFrameState;
use super::input::send_wire_input;
use super::limits::{
    validate_clipboard_text, validate_desktop_size, MAX_DESKTOP_HEIGHT, MAX_DESKTOP_WIDTH,
};
use super::security::{resolve_security, CertPolicy};
use super::wire::{
    RdpStartRequest, RdpWireInput, MAX_DOMAIN_LEN, MAX_HOST_LEN, MAX_UNICODE_TEXT_CHARS,
    MAX_USERNAME_LEN,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use dbx_plugin_sdk::PluginEmitter;
use ironrdp::client::config::{
    ClipboardType, Config as IronRdpConfig, ConfigBuilder as IronRdpConfigBuilder,
    Destination as IronRdpDestination, TransportKind as IronRdpTransportKind,
};
use ironrdp::client::rdp::{
    RdpClient as IronRdpClient, RdpInputEvent as IronRdpInputEvent, RdpOutputEvent,
};
use ironrdp::cliprdr::backend::ClipboardMessage;
use ironrdp::cliprdr::pdu::{ClipboardFormat, ClipboardFormatId};
use ironrdp::input::Database as IronRdpInputDatabase;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::mpsc;
use zeroize::Zeroizing;

/// Bounded backpressure for input/clipboard/advertise commands.
pub(crate) const COMMAND_CHANNEL_CAPACITY: usize = 256;
/// 首帧前的连接进度预算：TCP 被 accept 但 TLS/CredSSP 停滞的目标会让引擎
/// 线程静默悬挂——没有失败事件、没有日志，工作台永远停在"连接中"（真机
/// wtr 实测复现：sidecar 到 3389 的 ESTABLISHED 连接挂在握手期数小时）。
/// 任一输出事件都会重置预算；证书确认窗（120s 用户等待）与已连接期豁免。
/// 超时按可重试传输失败收场，交给退避梯子，UI 得到明确的错误出口。
pub(crate) const CONNECT_PROGRESS_BUDGET: Duration = Duration::from_secs(30);
/// Automatic reconnects after a transport failure (NyaTerm default 5).
pub(crate) const DEFAULT_RECONNECT_ATTEMPTS: u32 = 5;
pub(crate) const MAX_RECONNECT_ATTEMPTS: u32 = 10;
/// Cumulative automatic-reconnect budget per session worker (D3,
/// rdp-security-review): an active generation resets the backoff ladder
/// step only — never this total — so a hostile server cannot keep the
/// client dialling forever by alternating one active frame with
/// transport-class failures. Manual `rdp/reconnect` spawns a fresh worker
/// (user-driven gate, NyaTerm's explicit-reconnect semantics).
pub(crate) const MAX_TOTAL_RECONNECTS: u32 = 50;

// —— runtime ——

pub(crate) enum RdpCommand {
    Input(RdpWireInput),
    /// The staged clipboard text was updated; advertise it to the remote.
    ClipboardAdvertise,
    Close,
}

// One retained 4K RGBA desktop is 31,850,496 bytes. Keeping one composite
// replay framebuffer per session (RdpFrameState) bounds resident memory to
// that order.

pub(crate) struct RdpSessionEntry {
    pub(crate) workbench_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) domain: String,
    /// Zeroizing-held credential; materialized once per generation at the
    /// vendored `with_password` boundary, dropped (zeroized) with the entry.
    pub(crate) password: Option<Zeroizing<String>>,
    /// Requested desktop size; read at every generation's config build, so a
    /// `rdp/resize` can retarget the *next* generation (resize = reconnect,
    /// see `RdpSessionRuntime::resize`).
    pub(crate) width: AtomicU16,
    pub(crate) height: AtomicU16,
    pub(crate) use_nla: bool,
    pub(crate) cert_policy: CertPolicy,
    pub(crate) clipboard_enabled: bool,
    pub(crate) reconnect_attempts: u32,
    pub(crate) created_at_secs: u64,
    /// Bumped before every (re)connect; superseded workers exit without
    /// emitting and every prompt decision across generations is rejected.
    pub(crate) generation: Arc<AtomicU64>,
    /// Serializes realtime mutation, sequence allocation and replay into one
    /// ordered stream while retaining at most one bounded complete desktop.
    pub(crate) frame_state: tokio::sync::Mutex<RdpFrameState>,
    pub(crate) close_requested: AtomicBool,
    /// 证书确认等待期标记（verifier 置位/清零）：首帧前连接进度预算据此豁免
    /// 120s 用户确认窗——等待期引擎线程阻塞在 verify，不会有输出事件流动。
    pub(crate) cert_wait: Arc<AtomicBool>,
    /// Sender of the *current* generation's command channel; `None` while
    /// dialling/reconnecting (input fails fast instead of queueing).
    pub(crate) command_sender: tokio::sync::Mutex<Option<mpsc::Sender<RdpCommand>>>,
    /// Local clipboard text staged for the remote (`rdp/set-clipboard`).
    pub(crate) clipboard_stage: Arc<ClipboardStage>,
    pub(crate) broker: Arc<CertPromptBroker>,
    pub(crate) known_certs: KnownCertStore,
}

pub struct RdpSessionRuntime {
    pub(crate) sessions: Arc<tokio::sync::RwLock<HashMap<String, Arc<RdpSessionEntry>>>>,
    broker: Arc<CertPromptBroker>,
}

impl RdpSessionRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            broker: Arc::new(CertPromptBroker::new()),
        }
    }

    /// Registers the session row immediately and spawns the worker, which
    /// publishes `connecting` → `connected`/`error` state events, frame
    /// patches and clipboard events.
    pub async fn start(
        &self,
        request: RdpStartRequest,
        emitter: PluginEmitter,
        data_dir: &Path,
    ) -> Result<Value, String> {
        let host = request.host.trim().to_string();
        if host.is_empty() {
            return Err("rdp/start: host is required".to_string());
        }
        // Identity bounds (B6/F6, rdp-security-review): reject oversized
        // wire identities instead of passing unbounded strings through to
        // the vendored CredSSP/Destination layer.
        if host.len() > MAX_HOST_LEN {
            return Err(format!(
                "rdp/start: host exceeds the {MAX_HOST_LEN} character limit"
            ));
        }
        if request.username.trim().is_empty() {
            return Err("rdp/start: username is required".to_string());
        }
        if request.username.trim().len() > MAX_USERNAME_LEN {
            return Err(format!(
                "rdp/start: username exceeds the {MAX_USERNAME_LEN} character limit"
            ));
        }
        let domain = request.domain.unwrap_or_default();
        if domain.len() > MAX_DOMAIN_LEN {
            return Err(format!(
                "rdp/start: domain exceeds the {MAX_DOMAIN_LEN} character limit"
            ));
        }
        let port = request.port.unwrap_or(3389);
        if port == 0 {
            return Err("rdp/start: port must be between 1 and 65535".to_string());
        }
        let width = request.width.unwrap_or(1280);
        let height = request.height.unwrap_or(800);
        validate_desktop_size(width, height)?;
        let security = {
            let prefs = crate::preferences::load_preferences(data_dir);
            resolve_security(
                request.use_nla,
                request.certificate_policy.as_deref(),
                &prefs,
            )?
        };
        let clipboard_enabled = request.clipboard.unwrap_or(true);
        let reconnect_attempts = request
            .reconnect_attempts
            .unwrap_or(DEFAULT_RECONNECT_ATTEMPTS)
            .min(MAX_RECONNECT_ATTEMPTS);
        let password = request
            .password
            .filter(|password| !password.is_empty())
            .map(Zeroizing::new);
        let session_id = uuid::Uuid::new_v4().to_string();
        let entry = Arc::new(RdpSessionEntry {
            workbench_id: request.workbench_id.clone(),
            host: host.clone(),
            port,
            username: request.username,
            domain,
            password,
            width: AtomicU16::new(width),
            height: AtomicU16::new(height),
            use_nla: security.use_nla,
            cert_policy: security.certificate_policy,
            clipboard_enabled,
            reconnect_attempts,
            created_at_secs: unix_now_secs(),
            generation: Arc::new(AtomicU64::new(0)),
            frame_state: tokio::sync::Mutex::new(RdpFrameState::default()),
            close_requested: AtomicBool::new(false),
            // 证书确认等待标记（CONNECT_PROGRESS_BUDGET 的豁免信号）：verifier
            // 在等用户点确认的 120s 里置位，离开等待（任何路径）即清零。
            cert_wait: Arc::new(AtomicBool::new(false)),
            command_sender: tokio::sync::Mutex::new(None),
            clipboard_stage: Arc::new(ClipboardStage::default()),
            broker: self.broker.clone(),
            known_certs: KnownCertStore::new(data_dir),
        });
        // —— 幂等查重（reconnect 双 start 竞态修复）——重连梯子/宿主 replay
        // 可能在同一秒内并发触发两次 rdp/start（同 workbenchId）：旧实现会创建
        // 两个活会话，Windows 单会话策略踢掉前一个 → 前端持有的旧 sessionId
        // 收到断开事件 → 重连梯子再触发 rdp/start，工作台卡死在"连接中"。
        // 这里把查重与 insert 收进同一写锁，并发双 start 只有一个能建立会话，
        // 另一个命中复用。终态会话（closed / 耗尽退避梯子的 error）已被 worker
        // 从表中移除，"仍在表中"即未进入终态的活会话，可安全复用。
        {
            let mut sessions = self.sessions.write().await;
            if let Some((existing_id, existing)) = sessions
                .iter()
                .find(|(_, candidate)| candidate.workbench_id == request.workbench_id)
                .map(|(session_id, entry)| (session_id.clone(), entry.clone()))
            {
                crate::log_rdp_debug(format!(
                    "rdp/start idempotent hit workbench={} -> reuse {existing_id}",
                    request.workbench_id
                ));
                return Ok(json!({
                    "sessionId": existing_id,
                    "host": existing.host.clone(),
                    "port": existing.port,
                    "useNla": existing.use_nla,
                    "certificatePolicy": existing.cert_policy.as_str(),
                    "clipboard": existing.clipboard_enabled,
                    "reconnectAttempts": existing.reconnect_attempts,
                }));
            }
            sessions.insert(session_id.clone(), entry.clone());
        }
        spawn_worker(session_id.clone(), entry, emitter, self.sessions.clone());
        Ok(json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "useNla": security.use_nla,
            "certificatePolicy": security.certificate_policy.as_str(),
            "clipboard": clipboard_enabled,
            "reconnectAttempts": reconnect_attempts,
        }))
    }
    async fn session(&self, session_id: &str) -> Result<Arc<RdpSessionEntry>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "RDP session was not found".to_string())
    }

    async fn command_sender(&self, session_id: &str) -> Result<mpsc::Sender<RdpCommand>, String> {
        let entry = self.session(session_id).await?;
        let sender = entry.command_sender.lock().await.clone();
        sender.ok_or_else(|| "RDP session is not connected".to_string())
    }

    /// Keyboard/pointer forwarding (`rdp/input`, alias `rdp/write`).
    pub async fn input(&self, session_id: &str, input: RdpWireInput) -> Result<(), String> {
        // Unicode text bound (E5a, rdp-security-review): each character
        // expands into a press+release operation pair, so unbounded text
        // would materialize an unbounded operation list. Rejected whole.
        if let RdpWireInput::Unicode { text } = &input {
            let characters = text.chars().count();
            if characters > MAX_UNICODE_TEXT_CHARS {
                return Err(format!(
                    "rdp/input: unicode text exceeds the {MAX_UNICODE_TEXT_CHARS} character limit"
                ));
            }
        }
        self.session(session_id).await?;
        let sender = self.command_sender(session_id).await?;
        sender
            .send(RdpCommand::Input(input))
            .await
            .map_err(|_| "RDP session is closed".to_string())
    }

    /// Desktop resize (`rdp/resize`). Implementation is "resize = reconnect
    /// with the new size": the entry keeps the requested desktop size per
    /// generation, so retargeting it and restarting the worker re-dials with
    /// the new dimensions (the vendored chain's in-session display-control
    /// PDU path was verified to send a well-formed MS-RDPEDISP monitor
    /// layout, but a real Windows target did not apply it — see the RDP
    /// report; a live resize stays future work on the vendored stack).
    /// Credentials are retained in the entry (Zeroizing), so the re-dial
    /// reuses them without any frontend involvement.
    pub async fn resize(
        &self,
        session_id: &str,
        width: u16,
        height: u16,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        validate_desktop_size(width, height)?;
        let entry = self.session(session_id).await?;
        if entry.close_requested.load(Ordering::Acquire) {
            return Err("RDP session is closed".to_string());
        }
        let previous = (
            entry.width.load(Ordering::Acquire),
            entry.height.load(Ordering::Acquire),
        );
        if previous != (width, height) {
            crate::log_rdp_debug(format!(
                "rdp/resize id={session_id}: {previous:?} -> ({width}, {height}) via reconnect"
            ));
            entry.width.store(width, Ordering::Release);
            entry.height.store(height, Ordering::Release);
        }
        // Same teardown as the manual reconnect: the next generation dials
        // with the stored size; superseded workers exit without emitting.
        entry.close_requested.store(false, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        entry.frame_state.lock().await.clear();
        self.broker.cancel_session(session_id);
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(RdpCommand::Close).await;
        }
        spawn_worker(
            session_id.to_string(),
            entry,
            emitter,
            self.sessions.clone(),
        );
        Ok(json!({ "sessionId": session_id, "success": true, "reconnected": true }))
    }

    /// Local clipboard → remote (`rdp/set-clipboard`): stage the text and
    /// advertise it as CF_UNICODETEXT.
    pub async fn set_clipboard(&self, session_id: &str, text: String) -> Result<(), String> {
        let entry = self.session(session_id).await?;
        if !entry.clipboard_enabled {
            return Err(
                "rdp/set-clipboard: clipboard redirection is disabled for this session".to_string(),
            );
        }
        validate_clipboard_text(&text)?;
        entry.clipboard_stage.set_text(text);
        let sender = self.command_sender(session_id).await?;
        sender
            .send(RdpCommand::ClipboardAdvertise)
            .await
            .map_err(|_| "RDP session is closed".to_string())
    }

    /// Manual reconnect: kill the current generation and restart the pump.
    pub async fn reconnect(
        &self,
        session_id: &str,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let entry = self.session(session_id).await?;
        entry.close_requested.store(false, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        entry.frame_state.lock().await.clear();
        self.broker.cancel_session(session_id);
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(RdpCommand::Close).await;
        }
        spawn_worker(
            session_id.to_string(),
            entry,
            emitter,
            self.sessions.clone(),
        );
        Ok(json!({ "sessionId": session_id, "success": true }))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let entry = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("RDP session was not found")?;
        entry.close_requested.store(true, Ordering::Release);
        entry.generation.fetch_add(1, Ordering::AcqRel);
        entry.frame_state.lock().await.clear();
        // Any pending certificate prompt of this session must reject now,
        // and the staged clipboard text is dropped with the entry.
        self.broker.cancel_session(session_id);
        entry.clipboard_stage.clear();
        if let Some(sender) = entry.command_sender.lock().await.take() {
            let _ = sender.send(RdpCommand::Close).await;
        }
        Ok(())
    }

    /// Closing a workbench tears down its RDP sessions (same contract as the
    /// local shells, Telnet and VNC).
    pub async fn close_workbench(&self, workbench_id: &str) {
        let session_ids: Vec<String> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, entry)| entry.workbench_id == workbench_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in session_ids {
            let _ = self.close(&session_id).await;
        }
    }

    /// Read-only inventory of live RDP sessions (no credentials, no state —
    /// state changes only surface as `rdp/session/state` events).
    pub async fn list(&self) -> Value {
        let sessions = self.sessions.read().await;
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, entry)| {
                json!({
                    "sessionId": session_id,
                    "workbenchId": entry.workbench_id,
                    "host": entry.host,
                    "port": entry.port,
                    "username": entry.username,
                    "hasPassword": entry.password.is_some(),
                    "useNla": entry.use_nla,
                    "certificatePolicy": entry.cert_policy.as_str(),
                    "clipboard": entry.clipboard_enabled,
                    "createdAt": entry.created_at_secs,
                })
            })
            .collect();
        list.sort_by(|a, b| {
            a["createdAt"]
                .as_u64()
                .cmp(&b["createdAt"].as_u64())
                .then_with(|| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()))
        });
        json!({ "sessions": list })
    }

    /// Re-emits one composite full desktop after a webview remount. Incremental
    /// RDP patches cannot restore a renderer independently, so this never
    /// replays partial patches as if they were a complete scene.
    pub async fn replay(&self, session_id: &str, emitter: &PluginEmitter) -> Result<Value, String> {
        let entry = self.session(session_id).await?;
        let mut frame_state = entry.frame_state.lock().await;
        let Ok(frame) = frame_state.replay() else {
            return Ok(json!({ "frameCount": 0, "complete": false }));
        };
        // Keep the state lock through publication. Realtime patch mutation and
        // replay now share one ordering boundary, so sequence N cannot be
        // allocated then overtaken by replay sequence N+1.
        publish_frame(session_id, &frame, emitter);
        Ok(json!({ "frameCount": 1, "complete": true }))
    }

    /// Certificate-prompt resolution (`rdp/certificate/resolve`).
    pub fn resolve_certificate(
        &self,
        challenge_id: &str,
        accept: bool,
        remember: bool,
    ) -> Result<(), String> {
        self.broker.resolve(challenge_id, accept, remember)
    }

    /// True when the challenge id belongs to an RDP certificate prompt (the
    /// shared `connection/challenge/resolve` dispatcher uses this to route).
    pub fn has_certificate_challenge(&self, challenge_id: &str) -> bool {
        self.broker
            .pending
            .lock()
            .map(|pending| pending.contains_key(challenge_id))
            .unwrap_or(false)
    }
}

pub(crate) fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

// —— worker (generation-guarded pump) ——

fn spawn_worker(
    session_id: String,
    entry: Arc<RdpSessionEntry>,
    emitter: PluginEmitter,
    sessions: Arc<tokio::sync::RwLock<HashMap<String, Arc<RdpSessionEntry>>>>,
) {
    tokio::spawn(async move {
        let emit_state = |state: &str, error: Option<(&str, &str)>, attempt: Option<(u32, u32)>| {
            let mut payload = json!({
                "sessionId": session_id,
                "workbenchId": entry.workbench_id,
                "state": state,
            });
            if let Some((kind, message)) = error {
                payload["errorKind"] = Value::String(kind.to_string());
                payload["error"] = Value::String(message.to_string());
            }
            if let Some((attempt, max)) = attempt {
                payload["attempt"] = Value::from(attempt);
                payload["maxAttempts"] = Value::from(max);
            }
            emitter.event("rdp/session/state", payload)
        };
        // D3 (rdp-security-review): ladder step + cumulative total budget.
        // An active generation resets the step only, so a hostile server
        // cannot keep the client dialling forever.
        let mut budget = ReconnectBudget::new();
        loop {
            if entry.close_requested.load(Ordering::Acquire) {
                return;
            }
            let generation = entry.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let _ = emit_state("connecting", None, None);
            match run_generation(&session_id, &entry, generation, &emitter).await {
                GenerationEnd::Closed | GenerationEnd::Superseded => {
                    // Only the current generation may publish the terminal
                    // state (close() owns the closed state; a superseded
                    // generation's successor owns the session now).
                    if entry.generation.load(Ordering::Acquire) == generation
                        && !entry.close_requested.load(Ordering::Acquire)
                    {
                        let _ = emit_state("closed", None, None);
                        entry.frame_state.lock().await.clear();
                        sessions.write().await.remove(&session_id);
                    }
                    return;
                }
                GenerationEnd::Failed {
                    error,
                    error_kind,
                    retryable,
                    was_active,
                } => {
                    let _ = emit_state("error", Some((error_kind.as_str(), error.as_str())), None);
                    // An error invalidates the retained scene. Release the
                    // bounded buffer before retry backoff so a dead/retrying
                    // session never holds a stale 4K desktop in memory.
                    entry.frame_state.lock().await.clear();
                    if was_active {
                        // The session had been fully active in this
                        // generation: a fresh backoff ladder (NyaTerm resets
                        // the attempt counter on the first active frame).
                        // The cumulative budget is NOT reset (D3).
                        budget.on_active_generation();
                    }
                    if !budget.allows(entry.reconnect_attempts, retryable)
                        || entry.close_requested.load(Ordering::Acquire)
                        || entry.generation.load(Ordering::Acquire) != generation
                    {
                        let _ = emit_state("closed", None, None);
                        entry.frame_state.lock().await.clear();
                        sessions.write().await.remove(&session_id);
                        return;
                    }
                    budget.charge();
                    let _ = emit_state(
                        "reconnecting",
                        Some((error_kind.as_str(), error.as_str())),
                        Some((budget.attempt, entry.reconnect_attempts)),
                    );
                    tokio::time::sleep(reconnect_delay(budget.attempt)).await;
                }
            }
        }
    });
}

/// One dial → negotiate → pump cycle. Runs the IronRDP client on a dedicated
/// OS thread (current-thread runtime, NyaTerm's engine-thread shape) and
/// pumps its output events into binary frames / state events.
async fn run_generation(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    emitter: &PluginEmitter,
) -> GenerationEnd {
    if entry.generation.load(Ordering::Acquire) != generation {
        return GenerationEnd::Superseded;
    }
    let config = match build_ironrdp_config(session_id, entry, generation, emitter) {
        Ok(config) => config,
        Err(error) => {
            return GenerationEnd::Failed {
                error,
                error_kind: RdpErrorKind::Session,
                retryable: false,
                was_active: false,
            };
        }
    };
    let (output_sender, mut output_receiver) = mpsc::channel::<RdpOutputEvent>(2);
    let client = IronRdpClient::new(config, output_sender);
    let input_sender = client.input_sender();
    // 引擎中止通道：watch sender 与本代 run_generation 同生命周期。函数以任何
    // 原因返回（关闭/终态失败/换代/连接预算放弃）即 drop——引擎侧 changed()
    // 返回 Err，select 触发，client.run() future 被丢弃，其 TCP/TLS transport
    // 随之关闭。否则阻塞在握手等待里的引擎线程会永远抱着 ESTABLISHED socket
    //（连接预算放弃/连接中关闭/换代重连都会各泄漏一条，真机 wtr 实测复现）。
    let (_engine_abort_tx, mut engine_abort_rx) = tokio::sync::watch::channel(false);
    let mut join_handle = Some(std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(runtime) = runtime {
            runtime.block_on(async move {
                tokio::select! {
                    _ = client.run() => {}
                    // sender drop（或显式 send）即中止本代引擎。栈内连接/握手
                    // 全部是 tokio 异步等待点，select 能可靠打断并回收 socket。
                    _ = engine_abort_rx.changed() => {}
                }
            });
        }
    }));

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<RdpCommand>(COMMAND_CHANNEL_CAPACITY);
    *entry.command_sender.lock().await = Some(cmd_tx);

    let mut input_database = IronRdpInputDatabase::new();
    let mut was_active = false;
    let end = loop {
        if entry.generation.load(Ordering::Acquire) != generation {
            break GenerationEnd::Superseded;
        }
        // 预算只在首帧前生效；证书确认等待期（引擎阻塞在 verify 回调，无输出
        // 事件流动）豁免——豁免信号由 verifier 置位/清零，见 cert_wait。
        let budget_enabled = !was_active && !entry.cert_wait.load(Ordering::Acquire);
        tokio::select! {
            event = output_receiver.recv() => match event {
                Some(event) => {
                    if let Some(end) = handle_output_event(
                        session_id, entry, generation, event, emitter, &mut was_active,
                    )
                    .await
                    {
                        break end;
                    }
                }
                None => {
                    // The engine thread dropped its sender: it stopped.
                    if let Some(handle) = join_handle.take() {
                        let _ = handle.join();
                    }
                    break GenerationEnd::Failed {
                        error: "RDP engine stopped".to_string(),
                        error_kind: RdpErrorKind::Session,
                        retryable: true,
                        was_active,
                    };
                }
            },
            command = cmd_rx.recv() => match command {
                Some(RdpCommand::Input(input)) => {
                    if let Err(error) = send_wire_input(&input_sender, &mut input_database, input)
                    {
                        break GenerationEnd::Failed {
                            error,
                            error_kind: RdpErrorKind::Session,
                            retryable: false,
                            was_active,
                        };
                    }
                }
                // 注意：RdpCommand::Resize 已随 rdp/resize 的“重连生效”方案
                // 移除（见 RdpSessionRuntime::resize 文档）——会话内 display
                // control PDU 真机不生效，运行中改尺寸走 generation 重拨。
                Some(RdpCommand::ClipboardAdvertise) => {
                    let sent = input_sender.send(IronRdpInputEvent::Clipboard(
                        ClipboardMessage::SendInitiateCopy(vec![ClipboardFormat::new(
                            ClipboardFormatId::CF_UNICODETEXT,
                        )]),
                    ));
                    if sent.is_err() {
                        break GenerationEnd::Failed {
                            error: "RDP input channel is closed".to_string(),
                            error_kind: RdpErrorKind::Session,
                            retryable: false,
                            was_active,
                        };
                    }
                }
                Some(RdpCommand::Close) | None => break GenerationEnd::Closed,
            },
            // 首帧前连接进度预算（CONNECT_PROGRESS_BUDGET）：预算随每个循环
            // 重建（任一事件/命令即重置）。到期竞态兜底：证书窗恰在此刻开启
            // 则本轮豁免，回循环重算（guard 是进入 select 时的旧值）。
            _ = tokio::time::sleep(CONNECT_PROGRESS_BUDGET), if budget_enabled => {
                if entry.cert_wait.load(Ordering::Acquire) {
                    continue;
                }
                break GenerationEnd::Failed {
                    error: format!(
                        "RDP connection made no progress for {CONNECT_PROGRESS_BUDGET:?} before the first frame"
                    ),
                    error_kind: RdpErrorKind::Transport,
                    retryable: true,
                    was_active,
                };
            }
        }
    };
    // Clear only when this generation still owns the channel: a superseded
    // worker must not drop the successor's sender.
    if entry.generation.load(Ordering::Acquire) == generation {
        *entry.command_sender.lock().await = None;
    }
    // Tell the engine to finish; the abort channel's sender drops when this
    // function returns, which aborts a still-running engine (see the channel
    // comment) — a handshake-stalled engine would otherwise park forever.
    // Only join when it has already finished; never block the pump on it.
    let _ = input_sender.send(IronRdpInputEvent::Close);
    if let Some(handle) = join_handle.take() {
        if handle.is_finished() {
            let _ = handle.join();
        }
    }
    end
}

/// Handles one engine output event; `Some(end)` aborts the pump.
async fn handle_output_event(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    event: RdpOutputEvent,
    emitter: &PluginEmitter,
    was_active: &mut bool,
) -> Option<GenerationEnd> {
    if entry.generation.load(Ordering::Acquire) != generation {
        return Some(GenerationEnd::Superseded);
    }
    match event {
        RdpOutputEvent::ImagePatch {
            buffer,
            desktop_width,
            desktop_height,
            x,
            y,
            width,
            height,
        } => {
            if !*was_active {
                *was_active = true;
                let _ = emitter.event(
                    "rdp/session/state",
                    json!({
                        "sessionId": session_id,
                        "workbenchId": entry.workbench_id,
                        "state": "connected",
                    }),
                );
            }
            // The desktop is engine-supplied: bound it like every other
            // wire-derived value (fail the session on violation).
            if desktop_width > MAX_DESKTOP_WIDTH || desktop_height > MAX_DESKTOP_HEIGHT {
                return Some(GenerationEnd::Failed {
                    error: format!(
                        "RDP desktop {desktop_width}x{desktop_height} is outside the supported range (max {MAX_DESKTOP_WIDTH}x{MAX_DESKTOP_HEIGHT})"
                    ),
                    error_kind: RdpErrorKind::Session,
                    retryable: false,
                    was_active: false,
                });
            }
            let mut frame_state = entry.frame_state.lock().await;
            match frame_state.apply_and_encode(
                &buffer,
                desktop_width,
                desktop_height,
                x,
                y,
                width,
                height,
            ) {
                Ok(frame) => {
                    // Keep the shared frame-state lock through emission. This
                    // makes mutation, sequence allocation, replay construction
                    // and output publication one total order.
                    publish_frame(session_id, &frame, emitter);
                }
                Err(error) => {
                    return Some(GenerationEnd::Failed {
                        error,
                        error_kind: RdpErrorKind::Session,
                        retryable: false,
                        was_active: false,
                    });
                }
            }
            None
        }
        RdpOutputEvent::ConnectionFailure(error) => {
            let error_text = format!("{error:?}");
            let (kind, retryable) = classify_connector_error_text(&error_text);
            let message = connector_error_message(kind, &error_text);
            // 诊断通道（stderr 走 sidecar-exit 宿主日志，不进事件流）：vendored
            // 连接器的原始错误文本。认证类错误对用户只暴露统一文案（§红线），
            // 但运维排障需要区分 CredSSP 拒绝码（如 CBT/EPA vs 凭据错误）。
            // 连接器错误不含凭据（凭据只进 Zeroizing），可安全记录。
            eprintln!("[ssh-sftp-plugin] rdp connection raw error: {error_text}");
            eprintln!(
                "[ssh-sftp-plugin] rdp connection failed ({}): {}",
                kind.as_str(),
                message
            );
            Some(GenerationEnd::Failed {
                error: message,
                error_kind: kind,
                retryable,
                was_active: false,
            })
        }
        RdpOutputEvent::Terminated(result) => match result {
            Ok(reason) => Some(GenerationEnd::Failed {
                error: format!("RDP session disconnected: {reason:?}"),
                error_kind: RdpErrorKind::Session,
                // Graceful server-side disconnect: no auto-reconnect
                // (NyaTerm parity — the user decides via rdp/reconnect).
                retryable: false,
                was_active: *was_active,
            }),
            Err(error) => {
                let (kind, retryable) = classify_session_error_text(&format!("{error:?}"));
                let message = session_error_message(kind, &format!("{error:?}"));
                eprintln!(
                    "[ssh-sftp-plugin] rdp session failed ({}): {}",
                    kind.as_str(),
                    message
                );
                Some(GenerationEnd::Failed {
                    error: message,
                    error_kind: kind,
                    retryable,
                    was_active: *was_active,
                })
            }
        },
        RdpOutputEvent::PointerDefault => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "default", "sessionId": session_id }),
            );
            None
        }
        RdpOutputEvent::PointerHidden => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "hidden", "sessionId": session_id }),
            );
            None
        }
        RdpOutputEvent::PointerPosition { x, y } => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({ "type": "position", "sessionId": session_id, "x": x, "y": y }),
            );
            None
        }
        RdpOutputEvent::PointerBitmap(pointer) => {
            let _ = emitter.event(
                "rdp/pointer",
                json!({
                    "type": "bitmap",
                    "sessionId": session_id,
                    "width": pointer.width,
                    "height": pointer.height,
                    "hotspotX": pointer.hotspot_x,
                    "hotspotY": pointer.hotspot_y,
                    "rgbaBase64": BASE64_STANDARD.encode(&pointer.bitmap_data),
                }),
            );
            None
        }
    }
}

fn publish_frame(session_id: &str, frame: &[u8], emitter: &PluginEmitter) {
    if let Err(error) = emitter.binary(&format!("rdp/frame/{session_id}"), frame) {
        // Frame loss is visual-only; the engine's own I/O errors tear the
        // session down, so a failing emit only needs a log line.
        eprintln!(
            "[ssh-sftp-plugin] rdp frame publish failed: {}",
            error.message
        );
    }
}

// —— engine config builder ——

fn build_ironrdp_config(
    session_id: &str,
    entry: &Arc<RdpSessionEntry>,
    generation: u64,
    emitter: &PluginEmitter,
) -> Result<IronRdpConfig, String> {
    let verifier = Arc::new(RdpCertificateVerifier {
        emitter: emitter.clone(),
        broker: entry.broker.clone(),
        known_certs: entry.known_certs.clone(),
        session_id: session_id.to_string(),
        policy: entry.cert_policy,
        generation: entry.generation.clone(),
        own_generation: generation,
        cert_wait: entry.cert_wait.clone(),
    });
    let mut builder = IronRdpConfigBuilder::new()
        .with_destination(IronRdpDestination::from_parts(
            entry.host.clone(),
            entry.port,
        ))
        .with_transport(IronRdpTransportKind::Direct)
        .with_username(entry.username.clone())
        .with_domain(entry.domain.clone())
        // Credential boundary: the Zeroizing-held password is materialized
        // once here per generation (vendored storage is RDP-1 scope); our
        // side never keeps a plaintext copy.
        .with_password(
            entry
                .password
                .as_ref()
                .map(|p| p.as_str())
                .unwrap_or_default(),
        )
        .with_desktop_width(entry.width.load(Ordering::Acquire))
        .with_desktop_height(entry.height.load(Ordering::Acquire))
        .with_desktop_scale_factor(100)
        .with_color_depth(32)
        .with_credssp(entry.use_nla)
        // TLS is always on: CredSSP rides on TLS and the legacy "standard
        // RDP security" path is never advertised (checklist §3-C).
        .with_tls(true)
        .with_autologon(true)
        // NyaTerm: IronRDP 0.17 decodes compressed FastPath bitmaps
        // inconsistently after reactivation — do not advertise bulk
        // compression.
        .with_compression(false)
        .with_server_pointer(true)
        .with_client_build(client_build())
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_client_name(client_name())
        .with_platform(current_platform())
        .with_server_certificate_verifier(verifier);

    if entry.clipboard_enabled {
        builder = builder
            .with_clipboard(ClipboardType::Enable)
            .with_cliprdr_factory({
                let session_id = session_id.to_string();
                let stage = entry.clipboard_stage.clone();
                let emitter = emitter.clone();
                move |proxy| {
                    Box::new(TextClipboardBackendFactory {
                        session_id: session_id.clone(),
                        stage: stage.clone(),
                        emitter: emitter.clone(),
                        proxy: Arc::new(StdMutex::new(proxy)),
                    })
                }
            });
    } else {
        entry.clipboard_stage.clear();
        builder = builder.with_clipboard(ClipboardType::Disable);
    }

    builder
        .build()
        .map_err(|error| format!("Unable to build RDP config: {error}"))
}

pub(crate) fn client_build() -> u32 {
    env!("CARGO_PKG_VERSION")
        .split('.')
        .take(3)
        .fold(0_u32, |acc, part| {
            acc.saturating_mul(100)
                .saturating_add(part.parse::<u32>().unwrap_or(0))
        })
}

pub(crate) fn client_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "DBX-SSH".to_string())
}

fn current_platform() -> MajorPlatformType {
    #[cfg(target_os = "windows")]
    {
        MajorPlatformType::WINDOWS
    }
    #[cfg(target_os = "macos")]
    {
        MajorPlatformType::MACINTOSH
    }
    #[cfg(target_os = "ios")]
    {
        MajorPlatformType::IOS
    }
    #[cfg(target_os = "android")]
    {
        MajorPlatformType::ANDROID
    }
    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        MajorPlatformType::UNIX
    }
}
