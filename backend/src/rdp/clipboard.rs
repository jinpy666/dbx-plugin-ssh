//! text-only CLIPRDR 桥（rdp-security-review §3-E/C1/C2 红线）：只放行
//! CF_UNICODETEXT，16 MiB 整包拒绝，file-contents/lock 一律报错；
//! 入站文本按 JSON 预算分片为 rdp/clipboard 事件。
use super::limits::{clipboard_chunks, validate_clipboard_payload_len, validate_clipboard_text};
use dbx_plugin_sdk::PluginEmitter;
use ironrdp::cliprdr::backend::{
    ClipboardMessage, ClipboardMessageProxy, CliprdrBackend, CliprdrBackendFactory,
};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp::core::impl_as_any;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex as StdMutex};

/// Per-event JSON budget for `rdp/clipboard` chunk events (C2,
/// rdp-security-review): the SDK transport silently drops JSON events over
/// 8 MiB (`MAX_JSON_BYTES`), so oversized text is split into chunks whose
/// JSON-escaped size stays under this bound.
pub(crate) const CLIPBOARD_CHUNK_JSON_BUDGET: usize = 7 * 1024 * 1024;

// —— clipboard (text-only bridge) ——

/// Local-side clipboard text staged by `rdp/set-clipboard`. The CLIPRDR
/// backend answers the server's format-data requests from here; the OS
/// clipboard itself stays with the workbench frontend (the sidecar is
/// headless — same split as VNC). Never logged, never audited.
#[derive(Default)]
pub(crate) struct ClipboardStage {
    text: StdMutex<Option<String>>,
}

impl ClipboardStage {
    pub(crate) fn set_text(&self, text: String) {
        if let Ok(mut slot) = self.text.lock() {
            *slot = Some(text);
        }
    }

    pub(crate) fn text(&self) -> Option<String> {
        self.text.lock().ok().and_then(|slot| slot.clone())
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut slot) = self.text.lock() {
            *slot = None;
        }
    }
}

/// Text-only CLIPRDR backend: only CF_UNICODETEXT is ever advertised,
/// requested or accepted. Every file-contents/lock path answers with an
/// error so a hostile server cannot pull anything but the staged text, and
/// even that is bounded at 16 MiB per package.
struct TextClipboardBackend {
    session_id: String,
    stage: Arc<ClipboardStage>,
    proxy: Arc<StdMutex<Box<dyn ClipboardMessageProxy>>>,
    emitter: PluginEmitter,
}

impl std::fmt::Debug for TextClipboardBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identifier only: the emitter has no Debug surface and the staged
        // clipboard text must never appear in a Debug render.
        f.debug_struct("TextClipboardBackend")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl_as_any!(TextClipboardBackend);

impl TextClipboardBackend {
    fn send(&self, message: ClipboardMessage) {
        if let Ok(proxy) = self.proxy.lock() {
            proxy.send_clipboard_message(message);
        }
    }

    /// Advertises the staged text when present (outbound copy initiation).
    fn advertise_staged_text(&mut self) {
        if self.stage.text().is_some() {
            self.send(ClipboardMessage::SendInitiateCopy(vec![
                ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT),
            ]));
        }
    }
}

impl CliprdrBackend for TextClipboardBackend {
    fn temporary_directory(&self) -> &str {
        // Never used: file transfers answer with errors, but the trait
        // requires a path.
        ".dbx-ssh-rdp-cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        self.advertise_staged_text();
    }

    fn on_request_format_list(&mut self) {
        self.advertise_staged_text();
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        _capabilities: ClipboardGeneralCapabilityFlags,
    ) {
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        // Remote copy → pull only the text format.
        if available_formats
            .iter()
            .any(|format| format.id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.send(ClipboardMessage::SendInitiatePaste(
                ClipboardFormatId::CF_UNICODETEXT,
            ));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        // Backend-enforced text-only: every other format is an error reply,
        // never an empty/implicit success.
        let response = match request.format {
            ClipboardFormatId::CF_UNICODETEXT => match self.stage.text() {
                Some(text) if validate_clipboard_text(&text).is_ok() => {
                    OwnedFormatDataResponse::new_unicode_string(&text)
                }
                _ => OwnedFormatDataResponse::new_error(),
            },
            _ => OwnedFormatDataResponse::new_error(),
        };
        self.send(ClipboardMessage::SendFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        // C1 entry gate (rdp-security-review): length-check the raw payload
        // BEFORE the UTF-16 → String materialization. 缓解：vendored 层整包
        // 物化不可避免（ironrdp-cliprdr 0.7.0 无流式 API），见
        // rdp-security-review C1 —— 本插件层只能在进入后端回调后尽早拒绝。
        if let Err(error) = validate_clipboard_payload_len(response.data().len()) {
            // Whole-package rejection; the oversized payload is never kept
            // or logged.
            eprintln!("[ssh-sftp-plugin] rdp clipboard inbound rejected: {error}");
            return;
        }
        let Ok(text) = response.to_unicode_string() else {
            return;
        };
        if let Err(error) = validate_clipboard_text(&text) {
            // Whole-package rejection; the oversized payload is never kept
            // or logged.
            eprintln!("[ssh-sftp-plugin] rdp clipboard inbound rejected: {error}");
            return;
        }
        // Forward to the workbench (the frontend bridges to the OS
        // clipboard); the text only ever rides the local IPC event. Oversized
        // text is split into budget-sized chunks (C2): a single >8 MiB JSON
        // event is silently dropped by the SDK transport.
        let chunks = clipboard_chunks(&text);
        let total = chunks.len();
        for (index, chunk) in chunks.iter().enumerate() {
            let mut payload = json!({ "sessionId": self.session_id, "text": chunk });
            if total > 1 {
                payload["chunkIndex"] = Value::from(index);
                payload["chunkTotal"] = Value::from(total);
            }
            if let Err(error) = self.emitter.event("rdp/clipboard", payload) {
                // Never silent (C2): a dropped clipboard event is at least
                // logged. No clipboard text in the log line.
                eprintln!(
                    "[ssh-sftp-plugin] rdp clipboard event dropped: {}",
                    error.message
                );
            }
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        self.send(ClipboardMessage::SendFileContentsResponse(
            FileContentsResponse::new_error(request.stream_id),
        ));
    }

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// Factory handed to the vendored client: the client invokes it once per
/// run with its own `ClipboardMessageProxy` (which forwards messages into
/// the client's input queue) and we bind that proxy to the backend.
pub(crate) struct TextClipboardBackendFactory {
    pub(crate) session_id: String,
    pub(crate) stage: Arc<ClipboardStage>,
    pub(crate) emitter: PluginEmitter,
    pub(crate) proxy: Arc<StdMutex<Box<dyn ClipboardMessageProxy>>>,
}

impl CliprdrBackendFactory for TextClipboardBackendFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        Box::new(TextClipboardBackend {
            session_id: self.session_id.clone(),
            stage: self.stage.clone(),
            proxy: self.proxy.clone(),
            emitter: self.emitter.clone(),
        })
    }
}
