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

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::RwLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dbx_plugin_sdk::PluginEmitter;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::model::{TerminalFrame, TerminalStream};
use crate::serial_xmodem::{
    self, Output, ProgressState, TransferProgress, UploadEngine, UploadProtocol,
};

const READ_BUFFER: usize = 4096;
/// The blocking read timeout also bounds how long a close can stall.
const READ_TIMEOUT: Duration = Duration::from_millis(10);

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

fn encode_frame(sequence: u64, stream: TerminalStream, data: &[u8]) -> Vec<u8> {
    TerminalFrame {
        sequence,
        stream,
        data: data.to_vec(),
    }
    .encode()
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
            emitter,
        );
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

    /// Writes keystroke bytes through the erase mapping. Keystroke-sized
    /// writes on the async side are acceptable for an MVP; the mutex is held
    /// only for the driver call.
    pub fn write_input(&self, session: &SerialSession, data: &[u8]) -> Result<(), String> {
        let payload = session.backspace.rewrite(data);
        self.write_raw(session, &payload)
    }

    /// Writes raw bytes (protocol frames) without the erase mapping — upload
    /// engines must not have their NAK/ACK bytes rewritten.
    fn write_raw(&self, session: &SerialSession, data: &[u8]) -> Result<(), String> {
        let mut port = session
            .write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        port.write_all(data)
            .and_then(|_| port.flush())
            .map_err(|error| format!("serial write failed: {error}"))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.session(session_id).await?;
        let _ = session.cmd_tx.send(SerialCommand::Close);
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
/// 端口写错误只报第一个，剩余写输出丢弃（协议随后会终止）。
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
                if write_error.is_none() {
                    let mut port = session
                        .write
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Err(error) = port.write_all(&bytes).and_then(|_| port.flush()) {
                        write_error = Some(format!("serial write failed: {error}"));
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
        let mut sequence: u64 = 0;
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
                    sequence += 1;
                    let _ = emitter.binary(
                        &format!("serial/terminal/out/{session_id}"),
                        &encode_frame(sequence, TerminalStream::Stdout, &buffer[..n]),
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
/// Base64 解码复用 telnet 的实现（同一负载形状）。
pub fn decode_write_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    crate::telnet_session::decode_write_payload(data_base64)
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
}
