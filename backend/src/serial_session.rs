//! Serial-port sessions (RS-232 consoles: routers, dev boards, embeddeds).
//!
//! Desktop-only by nature: the sidecar must sit on the machine that owns the
//! port. Mirrors [`crate::telnet_session`] — same 9-byte `TerminalFrame`
//! output channel (`serial/terminal/out/{id}`), same state-event shape
//! (`serial/session/state`), same session-table lifecycle. The blocking
//! `serialport` handle lives on a dedicated OS read thread; writes go through
//! a shared mutex (keystroke-sized, so the brief std lock on the async side
//! is acceptable for an MVP).
//!
//! `BackspaceMode` reuses the telnet mapping: `ctrl_h` rewrites DEL (0x7F)
//! into BS (0x08) for devices that expect a vt100-style erase.
//!
//! Line parameters are validated strictly (unknown values fail the start
//! with a readable error instead of silently degrading to 8N1), and port
//! enumeration labels are normalized so `path (description)` glue from some
//! backends never leaks into the device path the UI dials.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::RwLock;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use dbx_plugin_sdk::PluginEmitter;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::model::TerminalStream;
use crate::serial_xmodem::{
    self, Output, ProgressState, TransferProgress, UploadEngine, UploadProtocol,
};

const READ_BUFFER: usize = 4096;
/// The blocking read timeout also bounds how long a close can stall.
const READ_TIMEOUT: Duration = Duration::from_millis(10);
/// Serial replay budget (design doc §3): per-frame bounded ring kept for the
/// whole session lifetime, far smaller than the shared 2 MiB terminal limit —
/// serial output is console chatter, not full-screen repaints.
const SERIAL_REPLAY_BYTE_LIMIT: usize = 128 * 1024;

/// 写序列化常量（设计稿「写序列化与回压」节，草案参数实施定稿值）：
/// - 键入大包按 4 KiB 小块分帧入队，单块持锁写时间有上界（@9600 波特约
///   4 秒，键入与引擎 ACK 不再被 64 KiB 大块饿死 66 秒）；
/// - 队列按 256 KiB 字节预算有界，满时按来源拒绝而非无界堆积；
/// - 键入单包上限 16 KiB：覆盖 xterm 括号粘贴突发，更大的编程性写入整包
///   丢弃并向前端回报丢弃事件。
const SERIAL_WRITE_CHUNK_BYTES: usize = 4 * 1024;
const SERIAL_WRITE_QUEUE_BUDGET: usize = 256 * 1024;
const SERIAL_KEYSTROKE_MAX_BYTES: usize = 16 * 1024;

/// 写入来源：准入策略不同（键入可丢并回报；上传引擎输出全有或全无）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteSource {
    /// 键盘/粘贴（B1 二进制帧与 `serial/write` JSON 同源）。
    Keystroke,
    /// 上传引擎的协议块输出：保持块级原样（不切分），队列满时报错让上传
    /// 以可读错误终止，绝不阻塞调用线程。
    Bulk,
}

/// 准入拒绝原因（`message()` 面向前端/日志，绝不含写入内容）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WriteReject {
    /// 键入单包超过 [`SERIAL_KEYSTROKE_MAX_BYTES`]。
    Oversize,
    /// 队列字节预算（[`SERIAL_WRITE_QUEUE_BUDGET`]）容不下整包。
    QueueFull,
    /// 队列已随会话关闭。
    Closed,
}

impl WriteReject {
    fn message(self) -> String {
        match self {
            Self::Oversize => {
                "serial write queue: keystroke payload exceeds the per-write limit".to_string()
            }
            Self::QueueFull => "serial write queue is full".to_string(),
            Self::Closed => "serial session is closed".to_string(),
        }
    }
}

/// 有界写队列：预分块 FIFO + 字节计数 + Condvar 唤醒专用写线程。
/// 生产者只做无阻塞 try 入队——回压以「拒绝」的形式回到来源方（键入丢弃
/// 并回报、引擎输出报错终止）；消费者（写线程）`pop` 阻塞等待。准入是
/// 全有或全无：半个包入队会让线上字节流停在任意中断点，拒绝必须整体。
struct WriteQueue {
    inner: Mutex<WriteQueueInner>,
    available: Condvar,
}

struct WriteQueueInner {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

impl WriteQueue {
    fn new() -> Self {
        Self {
            inner: Mutex::new(WriteQueueInner {
                chunks: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            available: Condvar::new(),
        }
    }

    /// 准入（纯内存，无 IO，永不动端口锁）：键入按小块分帧，引擎输出整块
    /// 入队；预算不足/超限/已关闭时整体拒绝。
    fn push(&self, data: &[u8], source: WriteSource) -> Result<(), WriteReject> {
        if data.is_empty() {
            return Ok(());
        }
        if source == WriteSource::Keystroke && data.len() > SERIAL_KEYSTROKE_MAX_BYTES {
            return Err(WriteReject::Oversize);
        }
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if inner.closed {
            return Err(WriteReject::Closed);
        }
        if inner.bytes + data.len() > SERIAL_WRITE_QUEUE_BUDGET {
            return Err(WriteReject::QueueFull);
        }
        if source == WriteSource::Bulk {
            // 引擎输出保持块级原样（协议块语义），不受切分影响；尺寸上界
            // 由引擎设计保证（≤ 约 8 KiB 的 ZMODEM 块），远小于队列预算。
            inner.chunks.push_back(data.to_vec());
            inner.bytes += data.len();
        } else {
            // 键入大包按小块分帧：单块持锁写时间有上界。
            let mut offset = 0;
            while offset < data.len() {
                let end = (offset + SERIAL_WRITE_CHUNK_BYTES).min(data.len());
                inner.chunks.push_back(data[offset..end].to_vec());
                inner.bytes += end - offset;
                offset = end;
            }
        }
        drop(inner);
        self.available.notify_one();
        Ok(())
    }

    /// 写线程取块：阻塞直到有块或队列关闭排空（None = 退出）。
    fn pop(&self) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if let Some(chunk) = inner.chunks.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(chunk.len());
                return Some(chunk);
            }
            if inner.closed {
                return None;
            }
            inner = self
                .available
                .wait(inner)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// 取消路径：清空尚未写出的块，返回丢弃字节数（诊断用）。
    fn clear(&self) -> usize {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dropped = inner.bytes;
        inner.chunks.clear();
        inner.bytes = 0;
        dropped
    }

    /// 会话关闭：清空 + 置关闭 + 唤醒，写线程排空检查后随即退出。
    fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.chunks.clear();
        inner.bytes = 0;
        inner.closed = true;
        drop(inner);
        self.available.notify_all();
    }

    fn queued_bytes(&self) -> usize {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).bytes
    }
}

/// Erase-byte mapping shared with the telnet session (`BackspaceMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackspaceMode {
    Del,
    CtrlH,
}

impl BackspaceMode {
    fn parse(value: Option<&String>) -> Self {
        match value.map(String::as_str) {
            Some("ctrl_h") => Self::CtrlH,
            _ => Self::Del,
        }
    }

    fn rewrite(&self, data: &[u8]) -> Vec<u8> {
        match self {
            Self::Del => data.to_vec(),
            Self::CtrlH => data
                .iter()
                .map(|byte| if *byte == 0x7F { 0x08 } else { *byte })
                .collect(),
        }
    }
}

/// Line parameters resolved from a start request. Validation is strict:
/// unknown strings are rejected before any open attempt, because silently
/// falling back to 8N1 masks misconfiguration (a device wired for 7E1 opened
/// as 8N1 just garbles output with no hint of the wrong parameter).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LineParams {
    pub(crate) data_bits: serialport::DataBits,
    pub(crate) parity: serialport::Parity,
    pub(crate) stop_bits: serialport::StopBits,
    pub(crate) flow_control: serialport::FlowControl,
}

fn parse_data_bits(value: Option<&String>) -> Result<serialport::DataBits, String> {
    match value.map(String::as_str) {
        None => Ok(serialport::DataBits::Eight),
        Some("5") => Ok(serialport::DataBits::Five),
        Some("6") => Ok(serialport::DataBits::Six),
        Some("7") => Ok(serialport::DataBits::Seven),
        Some("8") => Ok(serialport::DataBits::Eight),
        Some(other) => Err(format!(
            "serial/start: invalid dataBits \"{other}\" (expected 5, 6, 7 or 8)"
        )),
    }
}

fn parse_parity(value: Option<&String>) -> Result<serialport::Parity, String> {
    match value.map(String::as_str) {
        None | Some("none") => Ok(serialport::Parity::None),
        Some("even") => Ok(serialport::Parity::Even),
        Some("odd") => Ok(serialport::Parity::Odd),
        Some(other) => Err(format!(
            "serial/start: invalid parity \"{other}\" (expected none, even or odd)"
        )),
    }
}

fn parse_stop_bits(value: Option<&String>) -> Result<serialport::StopBits, String> {
    match value.map(String::as_str) {
        None | Some("1") => Ok(serialport::StopBits::One),
        Some("2") => Ok(serialport::StopBits::Two),
        Some(other) => Err(format!(
            "serial/start: invalid stopBits \"{other}\" (expected 1 or 2)"
        )),
    }
}

fn parse_flow_control(value: Option<&String>) -> Result<serialport::FlowControl, String> {
    match value.map(String::as_str) {
        None | Some("none") => Ok(serialport::FlowControl::None),
        Some("rts_cts") => Ok(serialport::FlowControl::Hardware),
        Some("xon_xoff") => Ok(serialport::FlowControl::Software),
        Some(other) => Err(format!(
            "serial/start: invalid flowControl \"{other}\" (expected none, rts_cts or xon_xoff)"
        )),
    }
}

pub(crate) fn resolve_line_params(request: &SerialStartRequest) -> Result<LineParams, String> {
    Ok(LineParams {
        data_bits: parse_data_bits(request.data_bits.as_ref())?,
        parity: parse_parity(request.parity.as_ref())?,
        stop_bits: parse_stop_bits(request.stop_bits.as_ref())?,
        flow_control: parse_flow_control(request.flow_control.as_ref())?,
    })
}

/// Baud is driver-defined, so any in-range rate passes (including custom
/// ones); only nonsense outside the same bounds the MVP clamped to is
/// rejected — now with an error instead of a silent clamp.
pub(crate) fn checked_baud_rate(baud_rate: u32) -> Result<u32, String> {
    if (50..=4_000_000).contains(&baud_rate) {
        Ok(baud_rate)
    } else {
        Err(format!(
            "serial/start: baudRate {baud_rate} out of range (50..=4000000)"
        ))
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct SerialStartRequest {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: Option<String>,
    pub parity: Option<String>,
    pub stop_bits: Option<String>,
    /// New in the line-parameter validation pass; absent on legacy clients,
    /// which keeps the driver default (`none`).
    pub flow_control: Option<String>,
    pub backspace_mode: Option<String>,
    pub workbench_id: String,
}

impl Default for SerialStartRequest {
    fn default() -> Self {
        Self {
            port_name: String::new(),
            baud_rate: 115_200,
            data_bits: None,
            parity: None,
            stop_bits: None,
            flow_control: None,
            backspace_mode: None,
            workbench_id: String::new(),
        }
    }
}

pub(crate) struct SerialSession {
    /// 协议往返保留（state 事件与未来多工作台路由使用；当前仅存不计）。
    #[allow(dead_code)]
    workbench_id: String,
    port_name: String,
    baud_rate: u32,
    created_at_secs: u64,
    write: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    cmd_tx: mpsc::UnboundedSender<SerialCommand>,
    backspace: BackspaceMode,
    /// 进行中的文件上传（每会话至多一个；上传期间的键入由前端拦下）。
    upload: Mutex<Option<SerialUploadJob>>,
    /// 输出回放环形缓冲（设计稿 §3）：读线程在会话生命周期内逐帧保存，
    /// `serial/replay` 据此重发。std 互斥锁（读线程与 JSON 侧都是同步上下文，
    /// 临界区只做入队/拷贝，无 IO）。
    replay: Arc<std::sync::Mutex<crate::ssh::ReplayBuffer>>,
    /// 有界写队列（设计稿「写序列化与回压」）：专用写线程独占端口写方向，
    /// 异步侧只入队不碰锁。
    write_queue: Arc<WriteQueue>,
}

impl SerialSession {
    /// 上传互斥开关（B1）：上传 job 存在即为活动期，二进制写帧被 sidecar
    /// 直接拒绝，作为单一前端闸门的后盾；引擎取消/完成清掉 job 后自动释放。
    pub(crate) fn upload_active(&self) -> bool {
        self.upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some()
    }
}

/// 一次串口文件上传的运行时状态：引擎 + 进度限流。
pub(crate) struct SerialUploadJob {
    engine: UploadEngine,
    gate: ProgressGate,
}

/// 进度事件限流：Running 态按字节增量/时间窗口折叠，状态变化强制上报。
struct ProgressGate {
    last_emit: Option<(Instant, u64)>,
}

impl ProgressGate {
    fn allows(&mut self, progress: &TransferProgress) -> bool {
        if progress.state != ProgressState::Running {
            self.last_emit = Some((Instant::now(), progress.sent));
            return true;
        }
        let now = Instant::now();
        match self.last_emit {
            Some((at, sent))
                if progress.sent.saturating_sub(sent) < serial_xmodem::PROGRESS_DELTA_BYTES
                    && now.duration_since(at) < serial_xmodem::PROGRESS_INTERVAL =>
            {
                false
            }
            _ => {
                self.last_emit = Some((now, progress.sent));
                true
            }
        }
    }
}

pub(crate) enum SerialCommand {
    Close,
}

pub struct SerialSessionRuntime {
    sessions: Arc<RwLock<HashMap<String, Arc<SerialSession>>>>,
}

impl Default for SerialSessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A candidate port after label normalization: the device path to open plus
/// an optional human-readable description for pickers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NormalizedPortLabel {
    pub(crate) path: String,
    pub(crate) description: Option<String>,
}

/// Splits a glued `path (description)` label. Some serialport backends fold
/// the OS description into the port name, which breaks both connect (the
/// glue is not a device path) and display. The split is conservative: only
/// labels ending in ")" with a " (" separator are split, and nested
/// parentheses stay with the description (`COM3 (USB Serial Port (COM3))`).
/// Anything else passes through untouched.
pub(crate) fn split_glued_description(raw: &str) -> (String, Option<String>) {
    let raw = raw.trim();
    if raw.ends_with(')') {
        if let Some(sep) = raw.find(" (") {
            let path = raw[..sep].trim();
            let description = raw[sep + 2..raw.len() - 1].trim();
            if !path.is_empty() {
                let description = (!description.is_empty()).then(|| description.to_string());
                return (path.to_string(), description);
            }
        }
    }
    (raw.to_string(), None)
}

/// Normalizes one enumeration entry; the structured description from the
/// typed port info wins over anything glued into the raw label.
pub(crate) fn normalize_port_label(raw: &str, known: Option<&str>) -> NormalizedPortLabel {
    let (path, glued) = split_glued_description(raw);
    let description = known
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .or(glued);
    NormalizedPortLabel { path, description }
}

/// Human label for a USB port: product name, then manufacturer, then a
/// VID:PID tag so pickers never show a bare path for known adapters.
pub(crate) fn usb_port_description(info: &serialport::UsbPortInfo) -> String {
    let named = info
        .product
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .or_else(|| {
            info.manufacturer
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
        });
    named
        .map(str::to_string)
        .unwrap_or_else(|| format!("USB {:04x}:{:04x}", info.vid, info.pid))
}

impl SerialSessionRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Lists candidate ports, sorted by device path. `ports` stays a flat
    /// string array of device paths only (descriptions glued into the name
    /// are split off); `portDetails` carries the path/description pairs for
    /// pickers that want to show them. Empty on hosts without serial
    /// support — the UI renders its own "no ports" hint from this.
    pub fn list_ports(&self) -> Value {
        let mut labels: Vec<NormalizedPortLabel> = serialport::available_ports()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| {
                let known = match &entry.port_type {
                    serialport::SerialPortType::UsbPort(info) => Some(usb_port_description(info)),
                    serialport::SerialPortType::PciPort => Some("PCI".to_string()),
                    serialport::SerialPortType::BluetoothPort => Some("Bluetooth".to_string()),
                    serialport::SerialPortType::Unknown => None,
                };
                normalize_port_label(&entry.port_name, known.as_deref())
            })
            .collect();
        labels.sort_by(|a, b| a.path.cmp(&b.path));
        let ports = labels.iter().map(|l| l.path.clone()).collect::<Vec<_>>();
        let port_details = labels
            .iter()
            .map(|l| json!({ "path": l.path, "description": l.description }))
            .collect::<Vec<_>>();
        json!({ "ports": ports, "portDetails": port_details })
    }

    /// Opens the port (blocking call moved off the async workers) and spawns
    /// the read thread + output pump.
    pub async fn start(
        &self,
        request: SerialStartRequest,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let port_name = request.port_name.trim().to_string();
        if port_name.is_empty() {
            return Err("serial/start: portName is required".to_string());
        }
        let baud_rate = checked_baud_rate(request.baud_rate)?;
        let backspace = BackspaceMode::parse(request.backspace_mode.as_ref());
        let line = resolve_line_params(&request)?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        // The port open is a blocking syscall; keep it off the async workers.
        let open_name = port_name.clone();
        let port = tokio::task::spawn_blocking(move || {
            serialport::new(&open_name, baud_rate)
                .data_bits(line.data_bits)
                .parity(line.parity)
                .stop_bits(line.stop_bits)
                .flow_control(line.flow_control)
                .timeout(READ_TIMEOUT)
                .open()
                .map_err(|error| format!("serial/start: {error}"))
        })
        .await
        .map_err(|error| format!("serial/start: join error: {error}"))??;

        let port = Arc::new(Mutex::new(port));
        let session = Arc::new(SerialSession {
            workbench_id: request.workbench_id.clone(),
            port_name: port_name.clone(),
            baud_rate,
            created_at_secs: unix_now_secs(),
            write: Arc::clone(&port),
            cmd_tx,
            backspace,
            upload: Mutex::new(None),
            replay: Arc::new(std::sync::Mutex::new(
                crate::ssh::ReplayBuffer::with_byte_limit(SERIAL_REPLAY_BYTE_LIMIT),
            )),
            write_queue: Arc::new(WriteQueue::new()),
        });
        self.sessions
            .write()
            .expect("serial session registry poisoned")
            .insert(session_id.clone(), Arc::clone(&session));

        spawn_reader(
            session_id.clone(),
            Arc::clone(&session),
            Arc::clone(&port),
            cmd_rx,
            emitter.clone(),
        );
        spawn_writer(session_id.clone(), Arc::clone(&session), emitter);
        Ok(json!({
            "sessionId": session_id,
            "port": port_name,
            "baudRate": baud_rate,
        }))
    }

    pub(crate) async fn session(&self, session_id: &str) -> Result<Arc<SerialSession>, String> {
        self.sessions
            .read()
            .expect("serial session registry poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Serial session was not found".to_string())
    }

    /// 键入路径（B1 二进制帧与 `serial/write` JSON 共用）：退格改写后有界
    /// 入队；准入丢弃（超限/队满）按契约发 `serial/input/dropped` 事件回报
    /// 前端（丢弃不是传输失败，返回 Ok）；队列已随会话关闭才报错。
    pub fn write_input(
        &self,
        session: &SerialSession,
        session_id: &str,
        data: &[u8],
        emitter: &PluginEmitter,
    ) -> Result<(), String> {
        let payload = session.backspace.rewrite(data);
        match session.write_queue.push(&payload, WriteSource::Keystroke) {
            Ok(()) => Ok(()),
            Err(reject @ (WriteReject::Oversize | WriteReject::QueueFull)) => {
                let _ = emitter.event(
                    "serial/input/dropped",
                    json!({
                        "sessionId": session_id,
                        "bytes": payload.len(),
                        "reason": if reject == WriteReject::Oversize { "oversize" } else { "queue_full" },
                    }),
                );
                Ok(())
            }
            Err(WriteReject::Closed) => Err("Serial session is closed".to_string()),
        }
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.session(session_id).await?;
        let _ = session.cmd_tx.send(SerialCommand::Close);
        // 关闭写队列（清空 + 唤醒）：写线程丢弃在途之后的块并退出，端口
        // 随最后一个 Arc 释放而关闭。
        session.write_queue.shutdown();
        self.sessions
            .write()
            .expect("serial session registry poisoned")
            .remove(session_id);
        Ok(())
    }

    pub async fn list(&self) -> Value {
        let sessions = self
            .sessions
            .read()
            .expect("serial session registry poisoned");
        let rows: Vec<Value> = sessions
            .iter()
            .map(|(id, session)| {
                json!({
                    "sessionId": id,
                    "port": session.port_name,
                    "baudRate": session.baud_rate,
                    "createdAt": session.created_at_secs,
                })
            })
            .collect();
        json!({ "sessions": rows })
    }

    /// 序号制输出回放（设计稿 §3，与 telnet/local 的 after_sequence 先例
    /// 完全同构）：在 `serial/terminal/out/{id}` 上重发其后帧，返回摘要。
    /// `complete: false` 表示环形缓冲已绕回、回放不完整。会话已关闭时走
    /// `session()` 的 "Serial session was not found" 错误。
    pub async fn replay(
        &self,
        session_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let replay = session
            .replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let first_available_sequence = replay.first_sequence();
        let tail_sequence = replay.tail_sequence();
        let frames = replay.after(after_sequence);
        drop(replay);
        for frame in &frames {
            emitter
                .binary(
                    &format!("serial/terminal/out/{session_id}"),
                    &frame.encode(),
                )
                .map_err(|error| error.message)?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": after_sequence.saturating_add(1) >= first_available_sequence,
        }))
    }

    // —— 串口文件上传（X/Y/ZMODEM）——————————————————————————————

    /// 注册一次上传并让引擎发出初始输出（ZMODEM 的 ZRQINIT；X/Y 静默等
    /// 握手）。并发第二次 upload 直接拒绝（协议无法仲裁两个发送端）。
    pub async fn upload_start(
        &self,
        session_id: &str,
        protocol: UploadProtocol,
        file_name: String,
        total_size: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        if file_name.is_empty() {
            return Err("serial/upload/start: fileName is required".to_string());
        }
        if file_name.len() > 256 {
            return Err("serial/upload/start: fileName is too long".to_string());
        }
        if total_size > serial_xmodem::MAX_UPLOAD_BYTES {
            return Err(format!(
                "serial/upload/start: totalSize {total_size} exceeds the {} byte limit",
                serial_xmodem::MAX_UPLOAD_BYTES
            ));
        }
        // YMODEM 头块约束：name\0size 必须放进 128 字节块（对齐 NyaTerm）。
        if protocol == UploadProtocol::Ymodem {
            let meta_len = file_name.len() + 1 + total_size.to_string().len();
            if meta_len > 128 {
                return Err(format!(
                    "serial/upload/start: YMODEM file name is too long ({meta_len} bytes of header metadata)"
                ));
            }
        }
        let session = self.session(session_id).await?;
        let mut guard = session
            .upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_some() {
            return Err("Serial upload is already in progress".to_string());
        }
        let (engine, initial) =
            UploadEngine::new(protocol, file_name.clone(), total_size, Instant::now());
        let mut job = SerialUploadJob {
            engine,
            gate: ProgressGate { last_emit: None },
        };
        let mut outputs = initial;
        // 初始进度（sent=0）不计入限流窗口，前端立即可显示总大小。
        outputs.push(Output::Progress(TransferProgress {
            protocol,
            file_name,
            file_index: 0,
            sent: 0,
            total: total_size,
            state: ProgressState::Running,
            reason: None,
        }));
        let result = apply_upload_outputs(&session, &mut job, outputs, session_id, emitter);
        *guard = Some(job);
        // 端口写出错时保留 Failed 任务意义有限：直接清掉，让用户可立即重试。
        if result.is_err() {
            *guard = None;
        }
        result?;
        Ok(json!({
            "sessionId": session_id,
            "protocol": protocol.as_str(),
            "totalSize": total_size,
        }))
    }

    /// 前端分块到货；可能解锁引擎挂起的读请求（输出立即写往串口）。
    pub async fn upload_data(
        &self,
        session_id: &str,
        data: Vec<u8>,
        final_chunk: bool,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let mut guard = session
            .upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(job) = guard.as_mut() else {
            return Err("No serial upload is in progress".to_string());
        };
        let outputs = job.engine.append_data(&data, final_chunk)?;
        let received = job.engine.source().received();
        let done = job.engine.is_done();
        apply_upload_outputs(&session, job, outputs, session_id, emitter)?;
        if done {
            *guard = None;
        }
        Ok(json!({ "received": received, "final": final_chunk }))
    }

    /// 用户取消：发取消序列、落 Failed 事件并清掉任务（幂等）。
    pub async fn upload_cancel(
        &self,
        session_id: &str,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let mut guard = session
            .upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(job) = guard.as_mut() else {
            return Ok(json!({ "success": true }));
        };
        let outputs = job.engine.cancel();
        // 可取消（设计稿）：清空尚未写出的队列块后再入队取消序列——取消
        // 字节绝不能排在被取消的数据块之后。在途块（阻塞在 write_all 的
        // 系统调用里）无法中断，属既定边界。
        session.write_queue.clear();
        let result = apply_upload_outputs(&session, job, outputs, session_id, emitter);
        *guard = None;
        result?;
        Ok(json!({ "success": true }))
    }

    /// 读线程喂入对端字节（终端照常上屏，引擎并行消费）。
    pub(crate) fn pump_upload_feed(
        session: &SerialSession,
        session_id: &str,
        bytes: &[u8],
        emitter: &PluginEmitter,
    ) {
        let mut guard = session
            .upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(job) = guard.as_mut() else {
            return;
        };
        let outputs = job.engine.feed(bytes);
        let done = job.engine.is_done();
        if let Err(error) = apply_upload_outputs(session, job, outputs, session_id, emitter) {
            // 端口写失败：终止上传（读线程自身也会因 IO 错误退出发 error 态）。
            let _ = emitter.event(
                "serial/session/state",
                json!({ "sessionId": session_id, "state": "error", "error": error }),
            );
            *guard = None;
            return;
        }
        if done {
            *guard = None;
        }
    }

    /// 读线程空闲滴答：驱动引擎的静默重发/失败判定。
    pub(crate) fn pump_upload_tick(
        session: &SerialSession,
        session_id: &str,
        emitter: &PluginEmitter,
    ) {
        let mut guard = session
            .upload
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(job) = guard.as_mut() else {
            return;
        };
        let outputs = job.engine.tick();
        let done = job.engine.is_done();
        if let Err(error) = apply_upload_outputs(session, job, outputs, session_id, emitter) {
            let _ = emitter.event(
                "serial/session/state",
                json!({ "sessionId": session_id, "state": "error", "error": error }),
            );
            *guard = None;
            return;
        }
        if done {
            *guard = None;
        }
    }
}

/// 引擎输出统一处理：写串口（不带退格改写）+ 进度事件（限流）。
/// 端口/队列写错误只报第一个，剩余写输出丢弃（协议随后会终止）。
fn apply_upload_outputs(
    session: &SerialSession,
    job: &mut SerialUploadJob,
    outputs: Vec<Output>,
    session_id: &str,
    emitter: &PluginEmitter,
) -> Result<(), String> {
    let mut write_error = None;
    for output in outputs {
        match output {
            Output::Write(bytes) => {
                // 引擎输出走 Bulk 源入队：块级原样（不切分），队列满/关闭时
                // 报错终止上传（与原直写失败同语义），绝不阻塞调用线程。
                if write_error.is_none() {
                    if let Err(reject) = session.write_queue.push(&bytes, WriteSource::Bulk) {
                        write_error = Some(reject.message());
                    }
                }
            }
            Output::Progress(progress) => {
                if job.gate.allows(&progress) {
                    emit_upload_progress(emitter, session_id, progress);
                }
            }
        }
    }
    match write_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// 进度事件负载（camelCase，不含文件内容）。
fn emit_upload_progress(emitter: &PluginEmitter, session_id: &str, progress: TransferProgress) {
    let mut payload = json!({
        "sessionId": session_id,
        "protocol": progress.protocol.as_str(),
        "fileName": progress.file_name,
        "fileIndex": progress.file_index,
        "sent": progress.sent,
        "total": progress.total,
        "state": progress.state.as_str(),
    });
    if let Some(reason) = progress.reason {
        payload["reason"] = Value::String(reason);
    }
    let _ = emitter.event("serial/upload/progress", payload);
}

/// Dedicated blocking read thread: forwards port bytes to the pump channel
/// and honours `Close` by simply exiting (dropping its port clone closes the
/// handle on the writer side too — the OS closes the last reference).
///
/// While a file upload is active the same read chunk drives the upload
/// engine (peer responses feed the protocol AND still render on the
/// terminal, NyaTerm semantics); idle cycles tick the engine's retry
/// deadlines.
fn spawn_reader(
    session_id: String,
    session: Arc<SerialSession>,
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    mut cmd_rx: mpsc::UnboundedReceiver<SerialCommand>,
    emitter: PluginEmitter,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; READ_BUFFER];
        loop {
            if matches!(cmd_rx.try_recv(), Ok(SerialCommand::Close)) {
                let _ = emitter.event(
                    "serial/session/state",
                    json!({ "sessionId": session_id, "state": "closed" }),
                );
                return;
            }
            let read = {
                let mut port = port.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                port.read(&mut buffer)
            };
            match read {
                Ok(0) => {
                    std::thread::sleep(READ_TIMEOUT);
                    SerialSessionRuntime::pump_upload_tick(&session, &session_id, &emitter);
                }
                Ok(n) => {
                    // 序号由回放缓冲统一分配（replay 与在线帧共用同一序列）。
                    let frame = session
                        .replay
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(TerminalStream::Stdout, buffer[..n].to_vec());
                    let _ = emitter.binary(
                        &format!("serial/terminal/out/{session_id}"),
                        &frame.encode(),
                    );
                    SerialSessionRuntime::pump_upload_feed(
                        &session,
                        &session_id,
                        &buffer[..n],
                        &emitter,
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                    SerialSessionRuntime::pump_upload_tick(&session, &session_id, &emitter);
                }
                Err(error) => {
                    let _ = emitter.event(
                        "serial/session/state",
                        json!({ "sessionId": session_id, "state": "error", "error": error.to_string() }),
                    );
                    return;
                }
            }
        }
    });
}

/// 专用写线程（设计稿「写序列化与回压」）：每会话一条，独占端口写方向；
/// 键入与上传引擎输出只入队不碰锁，队列按 256 KiB 字节预算有界。单块持锁
/// 时间被分帧上限约束（4 KiB @9600 波特约 4 秒），键入与引擎 ACK 不再被
/// 64 KiB 大块持锁 66 秒饿死。
///
/// 写失败镜像为 `serial/write/error` 事件（二进制/JSON 调用方在入队时早已
/// 拿到应答，错误无法回传）：清空队列（后续块大概率同样失败）后继续服务
/// 后续写入；端口消失时读线程会以 error 状态收场。在途块（阻塞在 write_all
/// 系统调用里）无法中断——取消/关闭保证的是其后队列内容不再写出。
fn spawn_writer(session_id: String, session: Arc<SerialSession>, emitter: PluginEmitter) {
    std::thread::spawn(move || {
        while let Some(chunk) = session.write_queue.pop() {
            let result = {
                let mut port = session
                    .write
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                port.write_all(&chunk).and_then(|_| port.flush())
            };
            if let Err(error) = result {
                let _ = emitter.event(
                    "serial/write/error",
                    json!({
                        "sessionId": session_id,
                        "error": format!("serial write failed: {error}"),
                    }),
                );
                session.write_queue.clear();
            }
        }
    });
}
/// Base64 解码复用 telnet 的实现（同一负载形状）。
pub fn decode_write_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    crate::telnet_session::decode_write_payload(data_base64)
}

/// 解码一条 `serial/terminal/in/{id}` 入站写帧：与输出帧同构的
/// `TerminalFrame` 形状（首字节流标签 + 大端 `u64` 序号 + 数据）。
///
/// B1 契约（docs/SERIAL_ENHANCE_DESIGN.zh-CN.md §2）：本通道只接受
/// `Stdin = 3` 标签，其余标签（含未知值）一律返回参数错误；长度不足帧头的
/// 数据同样报参数错误，绝不 panic。
pub(crate) fn decode_input_frame(data: &[u8]) -> Result<(u64, Vec<u8>), String> {
    if data.len() < 9 {
        return Err("serial/terminal/in: frame is shorter than the 9-byte TerminalFrame header".to_string());
    }
    let tag = data[0];
    if tag != TerminalStream::Stdin as u8 {
        return Err(format!(
            "serial/terminal/in: stream tag {tag} is rejected (only {} / Stdin is accepted)",
            TerminalStream::Stdin as u8
        ));
    }
    let sequence = u64::from_be_bytes(
        data[1..9]
            .try_into()
            .map_err(|_| "serial/terminal/in: invalid sequence".to_string())?,
    );
    Ok((sequence, data[9..].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 端口标签规范化 ——————————————————————————————————————

    #[test]
    fn port_label_split_covers_platform_shapes() {
        // (原始标签, 期望路径, 期望描述)：Linux ttyUSB/ttyACM、macOS cu.、Windows COM。
        let cases: &[(&str, &str, Option<&str>)] = &[
            (
                "/dev/ttyUSB0 (FTDI FT232R USB UART)",
                "/dev/ttyUSB0",
                Some("FTDI FT232R USB UART"),
            ),
            (
                "/dev/ttyACM0 (Arduino (www.arduino.cc))",
                "/dev/ttyACM0",
                Some("Arduino (www.arduino.cc)"),
            ),
            (
                "/dev/cu.usbserial-1420 (Silicon Labs CP210x USB to UART Bridge)",
                "/dev/cu.usbserial-1420",
                Some("Silicon Labs CP210x USB to UART Bridge"),
            ),
            ("/dev/cu.usbmodem14101", "/dev/cu.usbmodem14101", None),
            (
                "COM3 (USB Serial Port (COM3))",
                "COM3",
                Some("USB Serial Port (COM3)"),
            ),
            ("COM3", "COM3", None),
            ("/dev/ttyS0", "/dev/ttyS0", None),
            ("/dev/ttyUSB0 ()", "/dev/ttyUSB0", None),
            // 未闭合括号与空路径不拆分，原样保留。
            ("/dev/ttyUSB0 (FTDI", "/dev/ttyUSB0 (FTDI", None),
            ("(junk)", "(junk)", None),
        ];
        for (raw, path, description) in cases {
            let (got_path, got_description) = split_glued_description(raw);
            assert_eq!(&got_path, path, "path for {raw:?}");
            assert_eq!(
                got_description.as_deref(),
                *description,
                "description for {raw:?}"
            );
        }
    }

    #[test]
    fn port_label_prefers_structured_description_over_glue() {
        let structured = normalize_port_label("/dev/cu.usbserial-1420 (glued)", Some("CP210x"));
        assert_eq!(structured.path, "/dev/cu.usbserial-1420");
        assert_eq!(structured.description.as_deref(), Some("CP210x"));
        // 结构化描述为空时退回粘合后缀。
        let fallback = normalize_port_label("/dev/ttyUSB0 (FTDI FT232R)", Some("  "));
        assert_eq!(fallback.path, "/dev/ttyUSB0");
        assert_eq!(fallback.description.as_deref(), Some("FTDI FT232R"));
        let plain = normalize_port_label("/dev/ttyS0", None);
        assert_eq!(plain.path, "/dev/ttyS0");
        assert!(plain.description.is_none());
    }

    #[test]
    fn usb_description_prefers_product_then_manufacturer_then_vid_pid() {
        let base = serialport::UsbPortInfo {
            vid: 0x0403,
            pid: 0x6001,
            serial_number: None,
            manufacturer: None,
            product: None,
        };
        assert_eq!(usb_port_description(&base), "USB 0403:6001");
        let with_manufacturer = serialport::UsbPortInfo {
            manufacturer: Some("FTDI".to_string()),
            ..base.clone()
        };
        assert_eq!(usb_port_description(&with_manufacturer), "FTDI");
        let with_product = serialport::UsbPortInfo {
            product: Some("FT232R USB UART".to_string()),
            ..with_manufacturer
        };
        assert_eq!(usb_port_description(&with_product), "FT232R USB UART");
        // 空白字符串视为缺失。
        let blank_product = serialport::UsbPortInfo {
            product: Some("   ".to_string()),
            manufacturer: None,
            ..base
        };
        assert_eq!(usb_port_description(&blank_product), "USB 0403:6001");
    }

    // —— 串口参数校验 ——————————————————————————————————————

    #[test]
    fn data_bits_accepts_the_full_range_and_rejects_junk() {
        let cases = [
            ("5", serialport::DataBits::Five),
            ("6", serialport::DataBits::Six),
            ("7", serialport::DataBits::Seven),
            ("8", serialport::DataBits::Eight),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse_data_bits(Some(&raw.to_string())).unwrap(), expected);
        }
        assert_eq!(parse_data_bits(None).unwrap(), serialport::DataBits::Eight);
        for junk in ["9", "eight", "", "8 "] {
            assert!(
                parse_data_bits(Some(&junk.to_string())).is_err(),
                "{junk:?} must be rejected"
            );
        }
    }

    #[test]
    fn parity_accepts_the_wire_vocabulary_and_rejects_junk() {
        let cases = [
            ("none", serialport::Parity::None),
            ("even", serialport::Parity::Even),
            ("odd", serialport::Parity::Odd),
        ];
        for (raw, expected) in cases {
            assert_eq!(parse_parity(Some(&raw.to_string())).unwrap(), expected);
        }
        assert_eq!(parse_parity(None).unwrap(), serialport::Parity::None);
        for junk in ["mark", "space", "EVEN", ""] {
            assert!(
                parse_parity(Some(&junk.to_string())).is_err(),
                "{junk:?} must be rejected"
            );
        }
    }

    #[test]
    fn stop_bits_accepts_one_or_two_and_rejects_junk() {
        assert_eq!(
            parse_stop_bits(Some(&"1".to_string())).unwrap(),
            serialport::StopBits::One
        );
        assert_eq!(
            parse_stop_bits(Some(&"2".to_string())).unwrap(),
            serialport::StopBits::Two
        );
        assert_eq!(parse_stop_bits(None).unwrap(), serialport::StopBits::One);
        for junk in ["1.5", "0", ""] {
            assert!(
                parse_stop_bits(Some(&junk.to_string())).is_err(),
                "{junk:?} must be rejected"
            );
        }
    }

    #[test]
    fn flow_control_accepts_the_wire_vocabulary_and_rejects_junk() {
        let cases = [
            ("none", serialport::FlowControl::None),
            ("rts_cts", serialport::FlowControl::Hardware),
            ("xon_xoff", serialport::FlowControl::Software),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                parse_flow_control(Some(&raw.to_string())).unwrap(),
                expected
            );
        }
        assert_eq!(
            parse_flow_control(None).unwrap(),
            serialport::FlowControl::None
        );
        for junk in ["hardware", "rtscts", "software", ""] {
            assert!(
                parse_flow_control(Some(&junk.to_string())).is_err(),
                "{junk:?} must be rejected"
            );
        }
    }

    #[test]
    fn resolve_reports_the_offending_parameter() {
        let request = SerialStartRequest {
            data_bits: Some("8".to_string()),
            parity: Some("mark".to_string()),
            stop_bits: Some("1".to_string()),
            ..SerialStartRequest::default()
        };
        let error = resolve_line_params(&request).unwrap_err();
        assert!(error.starts_with("serial/start:"), "got {error}");
        assert!(error.contains("invalid parity"), "got {error}");
        assert!(
            !error.contains("dataBits"),
            "only the offender is named: {error}"
        );
    }

    #[test]
    fn default_request_resolves_to_8n1_without_flow_control() {
        let line = resolve_line_params(&SerialStartRequest::default()).unwrap();
        assert_eq!(line.data_bits, serialport::DataBits::Eight);
        assert_eq!(line.parity, serialport::Parity::None);
        assert_eq!(line.stop_bits, serialport::StopBits::One);
        assert_eq!(line.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn baud_rate_bounds_match_the_documented_range() {
        for good in [50u32, 9_600, 115_200, 230_400, 3_000_000, 4_000_000] {
            assert_eq!(checked_baud_rate(good).unwrap(), good);
        }
        for bad in [0, 49, 4_000_001, u32::MAX] {
            let error = checked_baud_rate(bad).unwrap_err();
            assert!(
                error.starts_with("serial/start:") && error.contains("baudRate"),
                "{bad} error names the field: {error}"
            );
        }
    }

    // —— B1 二进制写通道（serial/terminal/in）—————————————————

    fn stdin_frame(sequence: u64, data: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(9 + data.len());
        frame.push(TerminalStream::Stdin as u8);
        frame.extend_from_slice(&sequence.to_be_bytes());
        frame.extend_from_slice(data);
        frame
    }

    #[test]
    fn input_frame_roundtrips_stream_tag_sequence_and_payload() {
        // 编解码对称性：Stdin 标签 + 大端序号 + 原始键序字节。
        let (sequence, payload) = decode_input_frame(&stdin_frame(42, b"ls\r")).unwrap();
        assert_eq!(sequence, 42);
        assert_eq!(payload, b"ls\r");
        // 空负载（纯确认帧）同样合法。
        let (sequence, payload) = decode_input_frame(&stdin_frame(0, b"")).unwrap();
        assert_eq!(sequence, 0);
        assert!(payload.is_empty());
        // 大序号不截断。
        let (sequence, _) = decode_input_frame(&stdin_frame(u64::MAX, b"x")).unwrap();
        assert_eq!(sequence, u64::MAX);
    }

    #[test]
    fn input_frame_rejects_non_stdin_tags_as_parameter_errors() {
        // 已知标签但方向不对（Stdout/Stderr/State）→ 参数错误，绝不当作键入。
        for tag in [0u8, 1, 2] {
            let mut frame = stdin_frame(1, b"x");
            frame[0] = tag;
            let error = decode_input_frame(&frame).unwrap_err();
            assert!(error.contains("serial/terminal/in"), "tag {tag}: {error}");
            assert!(error.contains("rejected"), "tag {tag}: {error}");
        }
        // 未知标签同样参数错误（不静默、不断连——错误由宿主桥按参数错误回）。
        let mut frame = stdin_frame(1, b"x");
        frame[0] = 99;
        assert!(decode_input_frame(&frame).is_err());
    }

    #[test]
    fn input_frame_rejects_truncated_headers_without_panicking() {
        for len in 0..9usize {
            let frame = stdin_frame(1, b"payload");
            assert!(
                decode_input_frame(&frame[..len]).is_err(),
                "length {len} must be rejected"
            );
        }
        // 恰好 9 字节（帧头无负载）合法。
        assert_eq!(
            decode_input_frame(&stdin_frame(3, b"")).unwrap(),
            (3, Vec::<u8>::new())
        );
    }

    // —— serial/replay 序号制回放（设计稿 §3）———————————————————

    #[test]
    fn replay_buffer_semantics_match_the_serial_summary_contract() {
        // 读线程经 ReplayBuffer 分配序号后，replay 摘要的字段语义：
        // after_sequence → 重发帧 + first/tail/complete，与 telnet/local 同构。
        let mut replay = crate::ssh::ReplayBuffer::with_byte_limit(SERIAL_REPLAY_BYTE_LIMIT);
        let f1 = replay.push(TerminalStream::Stdout, b"a".to_vec());
        let f2 = replay.push(TerminalStream::Stdout, b"b".to_vec());
        assert_eq!((f1.sequence, f2.sequence), (1, 2));
        assert_eq!(replay.first_sequence(), 1);
        assert_eq!(replay.tail_sequence(), 2);
        // 完整回放：afterSequence=0 → 两帧 + complete。
        let frames = replay.after(0);
        assert_eq!(frames.len(), 2);
        assert!(1 >= replay.first_sequence(), "complete = after+1 >= first");
        // 增量回放：afterSequence=1 → 仅第 2 帧。
        assert_eq!(replay.after(1).len(), 1);
        // 空缓冲（会话刚开、尚无输出）：first = tail+1，complete 按同式成立。
        let empty = crate::ssh::ReplayBuffer::with_byte_limit(SERIAL_REPLAY_BYTE_LIMIT);
        assert_eq!(empty.first_sequence(), 1);
        assert_eq!(empty.tail_sequence(), 0);
        assert!(0 + 1 >= empty.first_sequence());
    }

    #[test]
    fn replay_buffer_wraps_at_the_serial_byte_budget_and_reports_incomplete() {
        // 128 KiB 预算绕回：预算装不下的旧帧被逐出后 first_sequence 前移，
        // 从被逐出序号之后的请求得到不完整回放（complete: false 的判定来源）。
        let mut replay = crate::ssh::ReplayBuffer::with_byte_limit(4);
        replay.push(TerminalStream::Stdout, vec![b'x'; 3]);
        replay.push(TerminalStream::Stdout, vec![b'y'; 3]);
        replay.push(TerminalStream::Stdout, vec![b'z'; 3]);
        // 预算 4 字节只容得下最后一帧（前两帧先后被逐出）。
        assert_eq!(replay.first_sequence(), 3, "frames 1-2 evicted by the budget");
        // 请求 afterSequence=0（第 1 帧之后）：第 1、2 帧已不在缓冲 → 不完整。
        assert!(
            !(0 + 1 >= replay.first_sequence()),
            "afterSequence 0 below first_available must be incomplete"
        );
        assert_eq!(replay.after(0).len(), 1);
        // 从可得帧之后回放 → 完整。
        assert!(2 + 1 >= replay.first_sequence());
        // 串口实际预算常量为 128 KiB。
        assert_eq!(SERIAL_REPLAY_BYTE_LIMIT, 128 * 1024);
    }

    // —— 写序列化与回压（设计稿「写序列化与回压」节）———————————————

    #[test]
    fn write_queue_chunks_keystrokes_and_keeps_fifo_byte_order() {
        // 键入大包按 4 KiB 小块分帧入队；FIFO 出队拼回字节流逐字节一致。
        // （pop 在未关闭的队列上会阻塞，按预期块数出队。）
        let queue = WriteQueue::new();
        let payload: Vec<u8> = (0..(SERIAL_WRITE_CHUNK_BYTES * 2 + 3)).map(|i| i as u8).collect();
        queue.push(&payload, WriteSource::Keystroke).unwrap();
        assert_eq!(queue.queued_bytes(), payload.len());
        let expected_chunks = payload.len().div_ceil(SERIAL_WRITE_CHUNK_BYTES);
        let mut reassembled = Vec::new();
        for _ in 0..expected_chunks {
            let chunk = queue.pop().expect("queued chunk must be present");
            assert!(chunk.len() <= SERIAL_WRITE_CHUNK_BYTES, "chunk is bounded");
            reassembled.extend_from_slice(&chunk);
        }
        assert_eq!(reassembled, payload);
        assert_eq!(queue.queued_bytes(), 0);
    }

    #[test]
    fn write_queue_keeps_upload_blocks_undivided() {
        // 引擎输出（Bulk）保持块级原样，不受切分影响（哪怕超过分帧上限）。
        let queue = WriteQueue::new();
        let block = vec![0xAA; SERIAL_WRITE_CHUNK_BYTES + 512];
        queue.push(&block, WriteSource::Bulk).unwrap();
        let first = queue.pop().unwrap();
        assert_eq!(first.len(), block.len(), "bulk stays one chunk");
        // 排空检查前置关闭，pop 的 None 退出语义由 shutdown 用例覆盖。
        assert_eq!(queue.queued_bytes(), 0);
    }

    #[test]
    fn write_queue_rejects_whole_packets_and_reports_the_reason() {
        // 键入超单包上限 → Oversize；Bulk 无单包上限但受预算约束（超预算的
        // 引擎块 → QueueFull）。两种拒绝都全有或全无（队列原样未动）。
        let queue = WriteQueue::new();
        let oversize = vec![0u8; SERIAL_KEYSTROKE_MAX_BYTES + 1];
        assert_eq!(
            queue.push(&oversize, WriteSource::Keystroke),
            Err(WriteReject::Oversize)
        );
        assert_eq!(queue.queued_bytes(), 0, "all-or-nothing admission");

        let beyond_budget = vec![0u8; SERIAL_WRITE_QUEUE_BUDGET + 1];
        assert_eq!(
            queue.push(&beyond_budget, WriteSource::Bulk),
            Err(WriteReject::QueueFull)
        );
        assert_eq!(queue.queued_bytes(), 0, "all-or-nothing admission");

        let filler = vec![0u8; SERIAL_WRITE_QUEUE_BUDGET - 8];
        queue.push(&filler, WriteSource::Bulk).unwrap();
        let budget = WriteQueue::new();
        budget.push(&filler, WriteSource::Bulk).unwrap();
        assert_eq!(
            budget.push(b"late keystroke", WriteSource::Keystroke),
            Err(WriteReject::QueueFull)
        );
        assert_eq!(budget.queued_bytes(), filler.len(), "queue untouched");
        assert!(!WriteReject::QueueFull.message().contains("keystroke"));
    }

    #[test]
    fn write_queue_clear_and_shutdown_bound_the_cancel_and_close_paths() {
        // 取消：clear 丢掉未写出的块并返回字节数，队列随后可继续入队
        // （取消序列本身在清空后入队）。关闭：shutdown 后 push 报 Closed，
        // pop 排空即 None（写线程退出条件）。
        let queue = WriteQueue::new();
        queue.push(b"stale upload block", WriteSource::Bulk).unwrap();
        assert_eq!(queue.clear(), "stale upload block".len());
        assert_eq!(queue.queued_bytes(), 0);
        queue.push(b"cancel sequence", WriteSource::Bulk).unwrap();

        let closed = WriteQueue::new();
        closed.push(b"pending", WriteSource::Keystroke).unwrap();
        closed.shutdown();
        assert_eq!(closed.push(b"late", WriteSource::Keystroke), Err(WriteReject::Closed));
        assert_eq!(closed.pop(), None);
    }

    #[test]
    fn write_queue_pop_blocks_until_a_producer_pushes() {
        // 消费者阻塞等待 + Condvar 唤醒：写线程在无块时休眠，生产者入队即醒。
        let queue = Arc::new(WriteQueue::new());
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let consumer_queue = Arc::clone(&queue);
        std::thread::spawn(move || {
            done_tx.send(consumer_queue.pop()).expect("report pop");
        });
        // 生产者尚未入队：短暂窗口内不得拿到块（未唤醒即返回就是 bug）。
        assert!(done_rx.recv_timeout(Duration::from_millis(40)).is_err());
        queue.push(b"wake", WriteSource::Keystroke).unwrap();
        let chunk = done_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("pop wakes on push")
            .expect("closed queues yield None, open ones yield the chunk");
        assert_eq!(chunk, b"wake".to_vec());
    }
}
