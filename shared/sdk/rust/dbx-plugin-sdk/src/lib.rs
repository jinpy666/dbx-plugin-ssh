use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_BINARY_BYTES: usize = 64 * 1024 * 1024;
const FRAME_KIND_JSON: u8 = 0;
const FRAME_KIND_BINARY: u8 = 1;
const DEFAULT_WORK_QUEUE_CAPACITY: usize = 256;
pub const HOST_REQUEST_USER_INPUT_METHOD: &str = "host/requestUserInput";
/// The dot form is what the host actually advertises in `plugin/initialize`
/// (`host.features`); the slash form appears in docs. `supports()` is an
/// exact match, so callers gate on the form they expect.
pub const HOST_REQUEST_USER_INPUT_FEATURE: &str = "host.requestUserInput";
const DEFAULT_HOST_REQUEST_TIMEOUT: Duration = Duration::from_secs(330);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginTransport {
    JsonLines,
    Framed,
}

#[derive(Debug, Clone)]
pub struct PluginMetadata {
    pub id: String,
    pub version: String,
    pub capabilities: Vec<String>,
}

impl PluginMetadata {
    pub fn new(id: impl Into<String>, version: impl Into<String>) -> Self {
        Self { id: id.into(), version: version.into(), capabilities: Vec::new() }
    }

    pub fn with_capability(mut self, capability: impl Into<String>) -> Self {
        self.capabilities.push(capability.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: Option<u64>,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl PluginError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(-32601, format!("Method not found: {method}"))
    }
}

pub trait PluginHandler: Send + Sync + 'static {
    fn handle(
        &self,
        context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError>;

    fn handle_binary(&self, _channel: &str, _data: Vec<u8>, _emitter: &PluginEmitter) -> Result<(), PluginError> {
        Err(PluginError::new(-32601, "Binary input is not supported"))
    }
}

#[derive(Clone)]
pub struct PluginEmitter {
    output: Arc<Mutex<Box<dyn Write + Send>>>,
    transport: PluginTransport,
}

impl PluginEmitter {
    pub fn event(&self, method: &str, params: Value) -> Result<(), PluginError> {
        validate_protocol_name(method)?;
        self.write_json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
    }

    pub fn binary(&self, channel: &str, data: &[u8]) -> Result<(), PluginError> {
        if self.transport != PluginTransport::Framed {
            return Err(PluginError::new(-32000, "Binary messages require framed transport"));
        }
        validate_protocol_name(channel)?;
        if data.len() > MAX_BINARY_BYTES {
            return Err(PluginError::new(-32600, "Binary message is too large"));
        }
        let channel = channel.as_bytes();
        if channel.len() > u16::MAX as usize {
            return Err(PluginError::new(-32600, "Binary channel is too long"));
        }
        let payload_len = 2 + channel.len() + data.len();
        let mut output = self.output.lock().map_err(|_| PluginError::new(-32000, "Plugin output lock is poisoned"))?;
        output.write_all(&[FRAME_KIND_BINARY]).map_err(io_error)?;
        output.write_all(&(payload_len as u32).to_be_bytes()).map_err(io_error)?;
        output.write_all(&(channel.len() as u16).to_be_bytes()).map_err(io_error)?;
        output.write_all(channel).map_err(io_error)?;
        output.write_all(data).map_err(io_error)?;
        output.flush().map_err(io_error)
    }

    fn respond(&self, id: u64, result: Result<Value, PluginError>) -> Result<(), PluginError> {
        match result {
            Ok(result) => self.write_json(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Err(error) => self.write_json(&serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": error })),
        }
    }

    fn write_json(&self, value: &Value) -> Result<(), PluginError> {
        let payload = serde_json::to_vec(value).map_err(|error| PluginError::new(-32603, error.to_string()))?;
        if payload.len() > MAX_JSON_BYTES {
            return Err(PluginError::new(-32600, "JSON message is too large"));
        }
        write_json_frame(&self.output, self.transport, &payload)
    }

    /// Test-only constructor so downstream crates can script events and
    /// assert what a handler emitted. Hidden from the documented API.
    #[doc(hidden)]
    pub fn for_tests(sink: Arc<Mutex<Box<dyn Write + Send>>>, transport: PluginTransport) -> Self {
        Self { output: sink, transport }
    }
}

fn write_json_frame(
    output: &Arc<Mutex<Box<dyn Write + Send>>>,
    transport: PluginTransport,
    payload: &[u8],
) -> Result<(), PluginError> {
    let mut output = output.lock().map_err(|_| PluginError::new(-32000, "Plugin output lock is poisoned"))?;
    match transport {
        PluginTransport::JsonLines => {
            output.write_all(payload).map_err(io_error)?;
            output.write_all(b"\n").map_err(io_error)?;
        }
        PluginTransport::Framed => {
            output.write_all(&[FRAME_KIND_JSON]).map_err(io_error)?;
            output.write_all(&(payload.len() as u32).to_be_bytes()).map_err(io_error)?;
            output.write_all(payload).map_err(io_error)?;
        }
    }
    output.flush().map_err(io_error)
}

/// A question the plugin asks the user through the host, e.g. a bastion's
/// keyboard-interactive MFA challenge or a host-key confirmation. Serializes
/// into the `host/requestUserInput` params of Host API 1.1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputPrompt {
    /// Text the user answers, already localized by the plugin.
    pub prompt: String,
    /// Optional heading shown above `prompt`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Show the typed characters (defaults to masked input).
    #[serde(default)]
    pub echo: bool,
    /// Preset answer the user may keep or replace.
    #[serde(rename = "default", skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// Fixed answers; leave empty for free-form input (at most 8).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<UserInputOption>,
    /// How long the user has to answer, in seconds (host clamps to 5..600).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

/// One fixed answer of a [`UserInputPrompt`].
#[derive(Debug, Clone, Serialize)]
pub struct UserInputOption {
    pub value: String,
    pub label: String,
}

impl UserInputPrompt {
    /// A masked free-form question (verification codes, passwords, tokens).
    pub fn secret(prompt: impl Into<String>) -> Self {
        Self { prompt: prompt.into(), title: None, echo: false, default_value: None, options: Vec::new(), timeout_secs: None }
    }

    /// A question whose answer is visible while typing (account names, paths).
    pub fn text(prompt: impl Into<String>) -> Self {
        Self { echo: true, ..Self::secret(prompt) }
    }

    /// A multiple-choice question; the host shows the options as buttons.
    pub fn choice(prompt: impl Into<String>, options: Vec<UserInputOption>) -> Self {
        Self { options, ..Self::text(prompt) }
    }

    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    pub fn with_default(mut self, value: impl Into<String>) -> Self {
        self.default_value = Some(value.into());
        self
    }

    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.timeout_secs = Some(seconds);
        self
    }
}

/// The user's answer to a [`UserInputPrompt`].
#[derive(Debug, Clone, Deserialize)]
pub struct UserInputAnswer {
    /// `submit`, `cancel`, or `timeout`.
    pub action: String,
    /// The typed value or chosen option value; only present on `submit`.
    #[serde(default)]
    pub value: Option<String>,
}

impl UserInputAnswer {
    /// The submitted value, or `None` when the user cancelled and the host gave
    /// up waiting. Callers must fail closed on `None`.
    pub fn submitted(&self) -> Option<&str> {
        if self.action == "submit" {
            self.value.as_deref()
        } else {
            None
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.action == "cancel"
    }

    pub fn is_timeout(&self) -> bool {
        self.action == "timeout"
    }
}

/// What the host told the plugin about itself at `plugin/initialize`.
#[derive(Debug, Default, Clone)]
struct HostDescription {
    api_version: Option<String>,
    features: Vec<String>,
}

/// Client for Host API methods the plugin calls back into DBX. Create it by
/// running a [`PluginServer`]; [`host_client`] returns the running instance.
///
/// Calls block the calling thread until the host answers, so call them from a
/// plugin worker (a `connection/connect` handler is already one) rather than
/// from the thread that runs the server loop. While a user prompt is open the
/// host pauses the deadline of the request that is waiting on it, so a human
/// typing an MFA code is never mistaken for a connect timeout.
#[derive(Clone)]
pub struct HostClient {
    output: Arc<Mutex<Box<dyn Write + Send>>>,
    transport: PluginTransport,
    // The nested channel type is the upstream shape; factoring it out would
    // deviate from the reference implementation for no behavioral gain.
    #[allow(clippy::type_complexity)]
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, PluginError>>>>>,
    next_request_id: Arc<AtomicU64>,
    host: Arc<Mutex<HostDescription>>,
}

impl HostClient {
    fn new(output: Arc<Mutex<Box<dyn Write + Send>>>, transport: PluginTransport) -> Self {
        Self {
            output,
            transport,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: Arc::new(AtomicU64::new(1)),
            host: Arc::new(Mutex::new(HostDescription::default())),
        }
    }

    /// Host API version DBX reported at `plugin/initialize`.
    pub fn host_api_version(&self) -> Option<String> {
        self.host.lock().ok().and_then(|host| host.api_version.clone())
    }

    /// Whether DBX advertised `method` for this session. Gate optional calls on
    /// this (or on [`HostClient::host_api_version`]) so a plugin still works
    /// against an older host that predates the capability.
    pub fn supports(&self, method: &str) -> bool {
        self.host.lock().map(|host| host.features.iter().any(|feature| feature == method)).unwrap_or(false)
    }

    /// Calls one Host API method and waits for the answer.
    pub fn request(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        self.request_with_timeout(method, params, DEFAULT_HOST_REQUEST_TIMEOUT)
    }

    pub fn request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, PluginError> {
        validate_protocol_name(method)?;
        let id = format!("plugin-{}", self.next_request_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| PluginError::new(-32000, "Host request lock is poisoned"))?
            .insert(id.clone(), sender);
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = self.write(&message) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(PluginError::new(-32001, format!("Host did not answer '{method}' in time")))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(PluginError::new(-32000, format!("Host dropped the answer to '{method}'")))
            }
        }
    }

    /// Asks the user a question through the DBX UI. Fails when the host has no
    /// user interface attached (headless/MCP runs), so the plugin can fall back
    /// to its own behaviour instead of waiting for an answer that cannot come.
    pub fn request_user_input(&self, prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError> {
        let params = serde_json::to_value(prompt).map_err(|error| PluginError::new(-32603, error.to_string()))?;
        let answer = self.request(HOST_REQUEST_USER_INPUT_METHOD, params)?;
        serde_json::from_value(answer)
            .map_err(|error| PluginError::new(-32002, format!("Host returned an invalid input answer: {error}")))
    }

    fn write(&self, value: &Value) -> Result<(), PluginError> {
        let payload = serde_json::to_vec(value).map_err(|error| PluginError::new(-32603, error.to_string()))?;
        if payload.len() > MAX_JSON_BYTES {
            return Err(PluginError::new(-32600, "JSON message is too large"));
        }
        write_json_frame(&self.output, self.transport, &payload)
    }

    /// Remembers what the host advertised at `plugin/initialize`.
    fn note_host_description(&self, params: &Value) {
        let host = params.get("host");
        let api_version = host.and_then(|host| host.get("hostApiVersion")).and_then(Value::as_str).map(str::to_string);
        let features = host
            .and_then(|host| host.get("features"))
            .and_then(Value::as_array)
            .map(|features| features.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        if let Ok(mut description) = self.host.lock() {
            *description = HostDescription { api_version, features };
        }
    }

    /// Routes an answer from the host to the waiting caller. Returns `false`
    /// when the message is not a response to a plugin-initiated request, so the
    /// server loop can keep handling host -> plugin requests.
    fn deliver_response(&self, value: &Value) -> bool {
        if value.get("method").is_some() {
            return false;
        }
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return false;
        };
        let Some(sender) = self.pending.lock().ok().and_then(|mut pending| pending.remove(id)) else {
            return false;
        };
        let result = match value.get("error") {
            Some(error) => {
                let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603) as i32;
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| error.to_string());
                Err(PluginError::new(code, message))
            }
            None => match value.get("result") {
                Some(result) => Ok(result.clone()),
                None => Err(PluginError::new(-32603, "Host answer has neither result nor error")),
            },
        };
        let _ = sender.send(result);
        true
    }
}

static HOST_CLIENT: Mutex<Option<HostClient>> = Mutex::new(None);

/// The host client of the running plugin server, if any.
pub fn host_client() -> Option<HostClient> {
    HOST_CLIENT.lock().ok().and_then(|client| client.clone())
}

/// Installs the process-wide host client. [`PluginServer::serve`] calls this;
/// tests may replace it.
pub fn install_host_client(client: HostClient) {
    if let Ok(mut current) = HOST_CLIENT.lock() {
        *current = Some(client);
    }
}

/// Convenience wrapper for [`HostClient::request_user_input`] on the running
/// server. Fails when the plugin server is not running.
pub fn request_user_input(prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError> {
    let Some(client) = host_client() else {
        return Err(PluginError::new(-32000, "Host API is unavailable: the plugin server is not running"));
    };
    client.request_user_input(prompt)
}

pub struct PluginServer<H> {
    metadata: PluginMetadata,
    handler: Arc<H>,
    transport: PluginTransport,
    worker_threads: usize,
    work_queue_capacity: usize,
}

impl<H: PluginHandler> PluginServer<H> {
    pub fn new(metadata: PluginMetadata, handler: H) -> Self {
        Self {
            metadata,
            handler: Arc::new(handler),
            transport: PluginTransport::JsonLines,
            worker_threads: default_worker_threads(),
            work_queue_capacity: DEFAULT_WORK_QUEUE_CAPACITY,
        }
    }

    pub fn transport(mut self, transport: PluginTransport) -> Self {
        self.transport = transport;
        self
    }

    pub fn worker_threads(mut self, worker_threads: usize) -> Self {
        self.worker_threads = worker_threads.max(1);
        self
    }

    pub fn work_queue_capacity(mut self, work_queue_capacity: usize) -> Self {
        self.work_queue_capacity = work_queue_capacity.max(1);
        self
    }

    pub fn serve(self) -> io::Result<()> {
        let output: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(io::stdout())));
        let emitter = PluginEmitter { output: output.clone(), transport: self.transport };
        // Publish before serving so even the first request can call back.
        install_host_client(HostClient::new(output, self.transport));
        let workers = WorkerPool::new(self.worker_threads, self.work_queue_capacity)?;
        let binary = ChannelExecutor::new(workers.clone());
        match self.transport {
            PluginTransport::JsonLines => self.serve_json_lines(BufReader::new(io::stdin()), emitter, &workers),
            PluginTransport::Framed => self.serve_framed(io::stdin(), emitter, &workers, &binary),
        }
    }

    fn serve_json_lines<R: BufRead>(
        &self,
        mut input: R,
        emitter: PluginEmitter,
        workers: &WorkerPool,
    ) -> io::Result<()> {
        loop {
            let Some(line) = read_limited_line(&mut input, MAX_JSON_BYTES)? else {
                return Ok(());
            };
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if let Err(error) = self.dispatch_json(&line, emitter.clone(), workers) {
                eprintln!("[dbx-plugin-sdk] {error}");
            }
        }
    }

    fn serve_framed<R: Read>(
        &self,
        mut input: R,
        emitter: PluginEmitter,
        workers: &WorkerPool,
        binary: &ChannelExecutor,
    ) -> io::Result<()> {
        loop {
            let mut header = [0u8; 5];
            match input.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => return Err(error),
            }
            let kind = header[0];
            let length = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
            let maximum = if kind == FRAME_KIND_JSON { MAX_JSON_BYTES } else { MAX_BINARY_BYTES + 1024 };
            if length > maximum {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "plugin frame is too large"));
            }
            let mut payload = vec![0; length];
            input.read_exact(&mut payload)?;
            match kind {
                FRAME_KIND_JSON => {
                    if let Err(error) = self.dispatch_json(&payload, emitter.clone(), workers) {
                        eprintln!("[dbx-plugin-sdk] {error}");
                    }
                }
                FRAME_KIND_BINARY => {
                    if let Err(error) = self.dispatch_binary(payload, emitter.clone(), binary) {
                        eprintln!("[dbx-plugin-sdk] {error}");
                    }
                }
                _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unknown plugin frame kind")),
            }
        }
    }

    fn dispatch_json(&self, payload: &[u8], emitter: PluginEmitter, workers: &WorkerPool) -> Result<(), String> {
        let value: Value = serde_json::from_slice(payload).map_err(|error| error.to_string())?;
        // Answers to plugin-initiated Host API calls carry string ids; host ->
        // plugin requests keep numeric ids. Route answers first: ProtocolRequest
        // has no "method" field for them and would fail to parse.
        if let Some(host) = host_client() {
            if host.deliver_response(&value) {
                return Ok(());
            }
        }
        let request: ProtocolRequest = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if request.jsonrpc.as_deref() != Some("2.0") {
            return Err("request does not declare jsonrpc 2.0".to_string());
        }
        validate_protocol_name(&request.method).map_err(|error| error.message)?;
        if request.method == "plugin/initialize" {
            let id = request.id.ok_or("plugin/initialize must be a request")?;
            if let Some(host) = host_client() {
                host.note_host_description(&request.params);
            }
            let supported = request
                .params
                .get("host")
                .and_then(|host| host.get("protocolVersions"))
                .and_then(Value::as_array)
                .is_some_and(|versions| {
                    versions.iter().any(|version| version.as_u64() == Some(PROTOCOL_VERSION as u64))
                });
            let result = if supported {
                Ok(serde_json::json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": self.metadata.capabilities,
                    "plugin": { "id": self.metadata.id, "version": self.metadata.version }
                }))
            } else {
                Err(PluginError::new(-32001, "DBX and plugin do not share a protocol version"))
            };
            return emitter.respond(id, result).map_err(|error| error.message);
        }

        let handler = self.handler.clone();
        workers.submit(move || {
            let context = RequestContext { request_id: request.id, driver: request.driver };
            // A panicking handler must still produce an error response: without
            // this the host would only ever see a silent timeout, while the
            // repeated unanswered requests degraded user-visible errors
            // (dbx-plugin-ssh#286).
            let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handler.handle(context, &request.method, request.params, &emitter)
            })) {
                Ok(result) => result,
                Err(panic) => Err(PluginError::new(
                    -32000,
                    format!("plugin handler panicked: {}", panic_message(panic.as_ref())),
                )),
            };
            if let Some(id) = request.id {
                if let Err(error) = emitter.respond(id, result) {
                    eprintln!("[dbx-plugin-sdk] failed to write response: {}", error.message);
                }
            }
        })
    }

    fn dispatch_binary(&self, payload: Vec<u8>, emitter: PluginEmitter, binary: &ChannelExecutor) -> Result<(), String> {
        if payload.len() < 2 {
            return Err("invalid binary frame".to_string());
        }
        let channel_len = u16::from_be_bytes([payload[0], payload[1]]) as usize;
        if channel_len == 0 || payload.len() < 2 + channel_len {
            return Err("invalid binary channel".to_string());
        }
        let channel = std::str::from_utf8(&payload[2..2 + channel_len])
            .map_err(|_| "binary channel is not UTF-8".to_string())?
            .to_string();
        validate_protocol_name(&channel).map_err(|error| error.message)?;
        let data = payload[2 + channel_len..].to_vec();
        let handler = self.handler.clone();
        let job_channel = channel.clone();
        binary.submit(&channel, Box::new(move || {
            if let Err(error) = handler.handle_binary(&job_channel, data, &emitter) {
                eprintln!("[dbx-plugin-sdk] binary handler failed: {}", error.message);
            }
        }))
    }
}

/// Binary frames on one channel form an ordered stream (terminal keystrokes,
/// upload chunks), so their handler runs must preserve wire order: a terminal
/// that applies "l" and "s" out of order scrambles what the remote shell sees.
/// The executor keeps one lane per channel; the lane's head job runs on the
/// shared worker pool and the next job starts only after the previous returns,
/// while different lanes stay fully concurrent. JSON requests are independent
/// and bypass lanes entirely.
#[derive(Clone)]
struct ChannelExecutor {
    lanes: Arc<Mutex<HashMap<String, ChannelLane>>>,
    pool: WorkerPool,
}

#[derive(Default)]
struct ChannelLane {
    running: bool,
    pending: VecDeque<PluginJob>,
}

impl ChannelExecutor {
    fn new(pool: WorkerPool) -> Self {
        Self { lanes: Arc::new(Mutex::new(HashMap::new())), pool }
    }

    fn submit(&self, channel: &str, job: PluginJob) -> Result<(), String> {
        let head = {
            let mut lanes = self
                .lanes
                .lock()
                .map_err(|_| "plugin channel lanes are poisoned".to_string())?;
            let lane = lanes.entry(channel.to_string()).or_default();
            if lane.running {
                lane.pending.push_back(job);
                None
            } else {
                lane.running = true;
                Some(job)
            }
        };
        match head {
            Some(job) => self.start(channel.to_string(), job),
            None => Ok(()),
        }
    }

    fn start(&self, channel: String, job: PluginJob) -> Result<(), String> {
        let executor = self.clone();
        let finish_channel = channel.clone();
        let chained: PluginJob = Box::new(move || {
            // A panicking job must never skip finish(): the lane would stay
            // `running` forever and every later binary frame (terminal
            // keystrokes, upload chunks) would queue behind a job that already
            // died (dbx-plugin-ssh#286).
            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)) {
                eprintln!(
                    "[dbx-plugin-sdk] channel '{}' job panicked: {}; lane continues",
                    finish_channel,
                    panic_message(panic.as_ref())
                );
            }
            executor.finish(finish_channel);
        });
        if let Err(error) = self.pool.submit(chained) {
            // The pool is gone; free the lane so a restart is not blocked by a
            // head job that will never run. Pending jobs die with the process.
            self.release(&channel);
            return Err(error);
        }
        Ok(())
    }

    fn finish(&self, channel: String) {
        let next = {
            let mut lanes = match self.lanes.lock() {
                Ok(lanes) => lanes,
                Err(_) => return,
            };
            let Some(lane) = lanes.get_mut(&channel) else { return };
            match lane.pending.pop_front() {
                Some(job) => job,
                None => {
                    lane.running = false;
                    lanes.remove(&channel);
                    return;
                }
            }
        };
        let _ = self.start(channel, next);
    }

    fn release(&self, channel: &str) {
        if let Ok(mut lanes) = self.lanes.lock() {
            if let Some(lane) = lanes.get_mut(channel) {
                lane.running = false;
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct ProtocolRequest {
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    driver: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}

type PluginJob = Box<dyn FnOnce() + Send + 'static>;

#[derive(Clone)]
struct WorkerPool {
    sender: mpsc::SyncSender<PluginJob>,
}

impl WorkerPool {
    fn new(worker_threads: usize, queue_capacity: usize) -> io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<PluginJob>(queue_capacity);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..worker_threads {
            let receiver = receiver.clone();
            thread::Builder::new().name(format!("dbx-plugin-worker-{index}")).spawn(move || loop {
                let job = match receiver.lock() {
                    Ok(receiver) => receiver.recv(),
                    Err(_) => return,
                };
                match job {
                    Ok(job) => {
                        // Last-resort isolation: one panicking job must not
                        // take its worker thread down with it, or the pool
                        // shrinks a thread per panic until submits fail with
                        // "plugin worker pool is unavailable"
                        // (dbx-plugin-ssh#286).
                        if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)) {
                            eprintln!(
                                "[dbx-plugin-sdk] plugin job panicked: {}; worker continues",
                                panic_message(panic.as_ref())
                            );
                        }
                    }
                    Err(_) => return,
                }
            })?;
        }
        Ok(Self { sender })
    }

    fn submit(&self, job: impl FnOnce() + Send + 'static) -> Result<(), String> {
        self.sender.send(Box::new(job)).map_err(|_| "plugin worker pool is unavailable".to_string())
    }
}

fn default_worker_threads() -> usize {
    thread::available_parallelism().map(usize::from).unwrap_or(4).clamp(2, 16)
}

fn read_limited_line<R: BufRead>(reader: &mut R, maximum: usize) -> io::Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if output.is_empty() { Ok(None) } else { Ok(Some(output)) };
        }
        let take = available.iter().position(|byte| *byte == b'\n').map(|index| index + 1).unwrap_or(available.len());
        if output.len().saturating_add(take) > maximum {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plugin JSON line is too large"));
        }
        output.extend_from_slice(&available[..take]);
        reader.consume(take);
        if output.last() == Some(&b'\n') {
            return Ok(Some(output));
        }
    }
}

fn validate_protocol_name(value: &str) -> Result<(), PluginError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_whitespace) {
        return Err(PluginError::new(-32600, "Protocol name is invalid"));
    }
    Ok(())
}

fn io_error(error: io::Error) -> PluginError {
    PluginError::new(-32000, error.to_string())
}

/// Best-effort extraction of the printable message from a panic payload for
/// the panic-isolation layers: `panic!` with a literal yields `&str`,
/// dynamically built messages yield `String`, any other payload type has no
/// printable form.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{
        install_host_client, read_limited_line, ChannelExecutor, HostClient, PluginEmitter, PluginError, PluginHandler,
        PluginMetadata, PluginServer, PluginTransport, RequestContext, UserInputOption, UserInputPrompt, WorkerPool,
        HOST_REQUEST_USER_INPUT_FEATURE, HOST_REQUEST_USER_INPUT_METHOD,
    };
    use serde_json::Value;

    struct NoopHandler;

    impl PluginHandler for NoopHandler {
        fn handle(
            &self,
            _context: RequestContext,
            method: &str,
            _params: Value,
            _emitter: &PluginEmitter,
        ) -> Result<Value, PluginError> {
            Err(PluginError::method_not_found(method))
        }
    }

    #[test]
    fn worker_pool_executes_queued_jobs() {
        let pool = WorkerPool::new(2, 4).unwrap();
        let (sender, receiver) = mpsc::channel();
        for value in 0..4 {
            let sender = sender.clone();
            pool.submit(move || sender.send(value).unwrap()).unwrap();
        }
        drop(sender);

        let mut values = (0..4).map(|_| receiver.recv_timeout(Duration::from_secs(1)).unwrap()).collect::<Vec<_>>();
        values.sort_unstable();
        assert_eq!(values, vec![0, 1, 2, 3]);
    }

    #[test]
    fn worker_pool_survives_panicking_jobs() {
        // One worker, so the value job runs on the very thread the panic
        // would have killed before the isolation in WorkerPool::new
        // (dbx-plugin-ssh#286).
        let pool = WorkerPool::new(1, 4).unwrap();
        let (sender, receiver) = mpsc::channel();
        pool.submit(|| panic!("job exploded")).unwrap();
        pool.submit(move || sender.send("still alive").unwrap()).unwrap();
        assert_eq!(receiver.recv_timeout(Duration::from_secs(2)).unwrap(), "still alive");
    }

    struct PanicHandler;

    impl PluginHandler for PanicHandler {
        fn handle(
            &self,
            _context: RequestContext,
            method: &str,
            _params: Value,
            _emitter: &PluginEmitter,
        ) -> Result<Value, PluginError> {
            panic!("handler exploded on {method}");
        }
    }

    #[test]
    fn dispatch_json_answers_panicking_handler_with_error() {
        // Without the catch_unwind in dispatch_json the host only sees a
        // silent timeout for a panicking handler (dbx-plugin-ssh#286).
        let output = RecordingOutput::default();
        let sink: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(Box::new(output.clone())));
        let emitter = PluginEmitter::for_tests(sink, PluginTransport::JsonLines);
        let server = PluginServer::new(PluginMetadata::new("sample", "1.0.0"), PanicHandler);
        let workers = WorkerPool::new(1, 4).unwrap();

        server
            .dispatch_json(
                br#"{"jsonrpc":"2.0","id":7,"method":"sample/panic","params":{}}"#,
                emitter,
                &workers,
            )
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(response) = output.lines().first() {
                assert_eq!(response["id"].as_u64(), Some(7));
                let message = response["error"]["message"].as_str().unwrap_or_default();
                assert!(message.contains("panicked"), "unexpected error response: {response}");
                return;
            }
            assert!(Instant::now() < deadline, "no response for a panicking handler");
            thread::sleep(Duration::from_millis(10));
        }
    }

    struct PanicOnFirstBinary {
        seen: Arc<Mutex<Vec<u64>>>,
    }

    impl PluginHandler for PanicOnFirstBinary {
        fn handle(
            &self,
            _context: RequestContext,
            method: &str,
            _params: Value,
            _emitter: &PluginEmitter,
        ) -> Result<Value, PluginError> {
            Err(PluginError::method_not_found(method))
        }

        fn handle_binary(&self, _channel: &str, data: Vec<u8>, _emitter: &PluginEmitter) -> Result<(), PluginError> {
            let sequence = u64::from_be_bytes(data[..8].try_into().unwrap());
            if sequence == 0 {
                panic!("binary job exploded");
            }
            self.seen.lock().unwrap().push(sequence);
            Ok(())
        }
    }

    #[test]
    fn channel_lane_drains_after_panicking_job() {
        // A panicking head job must still release its lane, or every later
        // binary frame on that channel queues forever (terminal keystrokes
        // included) (dbx-plugin-ssh#286).
        let handler = PanicOnFirstBinary { seen: Arc::new(Mutex::new(Vec::new())) };
        let seen = handler.seen.clone();
        let server = PluginServer::new(PluginMetadata::new("sample", "1.0.0"), handler);
        let emitter = test_emitter();
        let binary = ChannelExecutor::new(WorkerPool::new(2, 8).unwrap());

        for sequence in 0..2u64 {
            server
                .dispatch_binary(binary_frame_payload("ssh/terminal/in/s1", sequence), emitter.clone(), &binary)
                .unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while seen.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "lane never drained after the panicking job");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*seen.lock().unwrap(), vec![1]);
    }

    /// Records the order in which binary frames were applied to the handler.
    /// Sequence N sleeps `delays_ms[N]` before recording, with later sequences
    /// sleeping less: on a concurrent pool the later frames finish first,
    /// which is the terminal-input reordering seen as scrambled keystrokes.
    struct ReorderingProbe {
        order: Arc<Mutex<Vec<u64>>>,
        delays_ms: [u64; 4],
    }

    impl PluginHandler for ReorderingProbe {
        fn handle(
            &self,
            _context: RequestContext,
            method: &str,
            _params: Value,
            _emitter: &PluginEmitter,
        ) -> Result<Value, PluginError> {
            Err(PluginError::method_not_found(method))
        }

        fn handle_binary(&self, _channel: &str, data: Vec<u8>, _emitter: &PluginEmitter) -> Result<(), PluginError> {
            let sequence = u64::from_be_bytes(data[..8].try_into().unwrap());
            thread::sleep(Duration::from_millis(self.delays_ms[sequence as usize]));
            self.order.lock().unwrap().push(sequence);
            Ok(())
        }
    }

    fn binary_frame_payload(channel: &str, sequence: u64) -> Vec<u8> {
        let channel = channel.as_bytes();
        let mut payload = Vec::with_capacity(2 + channel.len() + 8);
        payload.extend_from_slice(&(channel.len() as u16).to_be_bytes());
        payload.extend_from_slice(channel);
        payload.extend_from_slice(&sequence.to_be_bytes());
        payload
    }

    fn test_emitter() -> PluginEmitter {
        PluginEmitter {
            output: Arc::new(Mutex::new(Box::new(Cursor::new(Vec::new())) as Box<dyn Write + Send>)),
            transport: PluginTransport::Framed,
        }
    }

    #[test]
    fn binary_frames_on_one_channel_apply_in_submission_order() {
        let handler = ReorderingProbe { order: Arc::new(Mutex::new(Vec::new())), delays_ms: [120, 90, 60, 30] };
        let order = handler.order.clone();
        let server = PluginServer::new(PluginMetadata::new("sample", "1.0.0"), handler);
        let emitter = test_emitter();
        let binary = ChannelExecutor::new(WorkerPool::new(4, 16).unwrap());

        for sequence in 0..4u64 {
            server
                .dispatch_binary(binary_frame_payload("ssh/terminal/in/s1", sequence), emitter.clone(), &binary)
                .unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while order.lock().unwrap().len() < 4 {
            assert!(Instant::now() < deadline, "frames never completed");
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*order.lock().unwrap(), vec![0, 1, 2, 3]);
    }

    fn wait_for_length(order: &Mutex<Vec<&'static str>>, length: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while order.lock().unwrap().len() < length {
            assert!(Instant::now() < deadline, "jobs never completed");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn channel_executor_keeps_lanes_independent_and_fifo() {
        let executor = ChannelExecutor::new(WorkerPool::new(2, 8).unwrap());
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let gate = Arc::new(Mutex::new(false));

        // Lane "a": the head job blocks on the gate, the follow-up is queued
        // behind it. Lane "b" must complete even while "a" is stuck.
        let blocked_order = order.clone();
        let blocked_gate = gate.clone();
        executor
            .submit("a", Box::new(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !*blocked_gate.lock().unwrap() {
                    assert!(Instant::now() < deadline, "gate never opened");
                    thread::sleep(Duration::from_millis(5));
                }
                blocked_order.lock().unwrap().push("a-head");
            }))
            .unwrap();
        executor
            .submit("a", {
                let order = order.clone();
                Box::new(move || order.lock().unwrap().push("a-queued"))
            })
            .unwrap();
        executor
            .submit("b", {
                let order = order.clone();
                Box::new(move || order.lock().unwrap().push("b-head"))
            })
            .unwrap();

        wait_for_length(&order, 1);
        assert_eq!(*order.lock().unwrap(), vec!["b-head"]);

        *gate.lock().unwrap() = true;
        wait_for_length(&order, 3);
        assert_eq!(*order.lock().unwrap(), vec!["b-head", "a-head", "a-queued"]);
    }

    #[test]
    fn server_configuration_clamps_zero_worker_values() {
        let server = PluginServer::new(PluginMetadata::new("sample", "1.0.0"), NoopHandler)
            .worker_threads(0)
            .work_queue_capacity(0);

        assert_eq!(server.worker_threads, 1);
        assert_eq!(server.work_queue_capacity, 1);
    }

    #[test]
    fn limited_line_reader_rejects_oversized_messages() {
        let mut reader = Cursor::new(b"12345\n".to_vec());
        assert!(read_limited_line(&mut reader, 4).unwrap_err().to_string().contains("too large"));
    }

    /// Output sink that records every frame the plugin writes.
    #[derive(Clone, Default)]
    struct RecordingOutput(Arc<Mutex<Vec<u8>>>);

    impl RecordingOutput {
        fn lines(&self) -> Vec<Value> {
            let bytes = self.0.lock().unwrap().clone();
            String::from_utf8(bytes)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    impl std::io::Write for RecordingOutput {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn recording_client() -> (HostClient, RecordingOutput) {
        let output = RecordingOutput::default();
        let sink: Arc<Mutex<Box<dyn std::io::Write + Send>>> = Arc::new(Mutex::new(Box::new(output.clone())));
        let client = HostClient::new(sink, PluginTransport::JsonLines);
        install_host_client(client.clone());
        (client, output)
    }

    #[test]
    fn host_client_gates_on_advertised_features() {
        let (client, _output) = recording_client();
        assert!(!client.supports(HOST_REQUEST_USER_INPUT_FEATURE));
        assert_eq!(client.host_api_version(), None);

        // The real host advertises the dot form (dbx-plugin-runtime manifest.rs).
        client.note_host_description(&serde_json::json!({
            "host": { "hostApiVersion": "1.1.0", "features": [HOST_REQUEST_USER_INPUT_FEATURE] }
        }));
        assert_eq!(client.host_api_version().as_deref(), Some("1.1.0"));
        assert!(client.supports(HOST_REQUEST_USER_INPUT_FEATURE));
        // supports() is an exact match; callers must pass the advertised form.
        assert!(!client.supports(HOST_REQUEST_USER_INPUT_METHOD));
    }

    #[test]
    fn user_input_prompt_serializes_host_api_params() {
        let prompt = UserInputPrompt::choice(
            "Trust this host?",
            vec![
                UserInputOption { value: "accept".into(), label: "Trust once".into() },
                UserInputOption { value: "remember".into(), label: "Trust and remember".into() },
            ],
        )
        .with_title("SSH host key — h:22")
        .with_timeout_secs(300);
        let value = serde_json::to_value(&prompt).unwrap();
        assert_eq!(value["prompt"], "Trust this host?");
        assert_eq!(value["title"], "SSH host key — h:22");
        assert_eq!(value["echo"], true);
        assert_eq!(value["options"][1]["value"], "remember");
        assert_eq!(value["timeoutSecs"], 300);
        assert_eq!(value["options"].as_array().unwrap().len(), 2);

        let secret = serde_json::to_value(UserInputPrompt::secret("code")).unwrap();
        assert_eq!(secret["echo"], false);
        assert!(secret.get("title").is_none());
        assert!(secret.get("options").is_none());
        assert!(secret.get("timeoutSecs").is_none());
    }

    #[test]
    fn host_client_routes_string_id_answers() {
        let (client, output) = recording_client();
        client.note_host_description(&serde_json::json!({
            "host": { "hostApiVersion": "1.1.0", "features": [HOST_REQUEST_USER_INPUT_FEATURE] }
        }));

        let caller = {
            let client = client.clone();
            thread::spawn(move || client.request_user_input(&UserInputPrompt::secret("code")))
        };
        let request = loop {
            if let Some(request) =
                output.lines().into_iter().find(|line| line["method"] == HOST_REQUEST_USER_INPUT_METHOD)
            {
                break request;
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert!(request["id"].as_str().unwrap().starts_with("plugin-"));
        assert_eq!(request["params"]["prompt"], "code");

        client.deliver_response(&serde_json::json!({
            "jsonrpc": "2.0", "id": request["id"], "result": { "action": "submit", "value": "000000" }
        }));
        let answer = caller.join().unwrap().unwrap();
        assert_eq!(answer.submitted(), Some("000000"));
    }

    #[test]
    fn host_client_surfaces_host_errors_and_local_timeouts() {
        let (client, output) = recording_client();
        let caller = {
            let client = client.clone();
            thread::spawn(move || client.request_user_input(&UserInputPrompt::secret("code")))
        };
        let request = loop {
            if let Some(request) =
                output.lines().into_iter().find(|line| line["method"] == HOST_REQUEST_USER_INPUT_METHOD)
            {
                break request;
            }
            thread::sleep(Duration::from_millis(5));
        };
        client.deliver_response(&serde_json::json!({
            "jsonrpc": "2.0", "id": request["id"], "error": { "code": -32001, "message": "no user interface" }
        }));
        let error = caller.join().unwrap().unwrap_err();
        assert_eq!(error.code, -32001);

        // No answer at all: the local wait must expire (older hosts drop the frame).
        let started = Instant::now();
        let error = client
            .request_with_timeout(
                HOST_REQUEST_USER_INPUT_METHOD,
                serde_json::json!({"prompt": "x"}),
                Duration::from_millis(50),
            )
            .unwrap_err();
        assert_eq!(error.code, -32001);
        assert!(error.message.contains("did not answer"));
        assert!(started.elapsed() >= Duration::from_millis(40));
    }

    #[test]
    fn deliver_response_ignores_numeric_id_requests() {
        let (client, _output) = recording_client();
        // Host -> plugin requests keep numeric ids and must fall through to the
        // request handler, never be swallowed as answers.
        assert!(!client.deliver_response(&serde_json::json!({
            "jsonrpc": "2.0", "id": 7, "method": "connection/test", "params": {}
        })));
    }
}
