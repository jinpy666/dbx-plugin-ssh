//! Serial-port file upload engines: XMODEM / YMODEM / ZMODEM (NyaTerm parity).
//!
//! Pure state machines: the caller (the serial read loop in
//! [`crate::serial_session`]) feeds peer bytes in and drains [`Output`] items
//! (wire bytes to write to the port + progress events) back out. No engine
//! touches the port, the write channel, or the wall clock directly — public
//! entry points use `Instant::now()` while `*_at` variants take an injected
//! `Instant`, so every path is unit-testable without hardware.
//!
//! Wire semantics follow the NyaTerm reference (X/YMODEM per its
//! `serial/xymodem.rs`; ZMODEM per its vendored `zmodem2` sender, re-written
//! here by hand — the vendor crate is MIT/Apache-2.0 but stays out of the
//! dependency tree). Notable behaviors kept for interoperability with
//! `lrzsz`/`rz` receivers:
//!
//! * XMODEM 128-byte blocks, sequence from 1, CRC16 (`C`) or 8-bit checksum
//!   (`NAK`) per handshake, CPM-EOF (0x1A) tail padding, EOT + ACK close.
//! * YMODEM batch shape: block 0 header (`name\0size` zero-padded, CRC only),
//!   data blocks from sequence 1, EOT retry on NAK, then a final all-zero
//!   block 0 closes the batch. One file per upload session.
//! * ZMODEM sender: ZRQINIT(hex) → ZFILE(bin32 CRC + ZCRCW subpacket) →
//!   ZDATA(bin32, one ZCRCW subpacket per ZRPOS/ZACK) → ZEOF → ZFIN(hex) →
//!   `OO`. ZDLE escaping (CR/XON/XOFF/DEL/high-bit twins) matches the vendor
//!   sender so receivers that accept NyaTerm accept this engine.
//! * Upload data streams in from the frontend (`serial/upload/data`); reads
//!   that outrun the stream park the engine (`Pending`) instead of emitting a
//!   truncated frame, and idle-based timeouts pause while parked.

use std::time::{Duration, Instant};

// —— 协议常量（X/YMODEM 与 NyaTerm 对齐）——————————————————————————
const SOH: u8 = 0x01;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const CRC_REQUEST: u8 = b'C';
const CPM_EOF: u8 = 0x1a;
const BLOCK_SIZE: usize = 128;

// —— ZMODEM 帧类型/编码（值与 zmodem2 语义一致）—————————————————————
const ZDLE: u8 = 0x18;
const XON: u8 = 0x11;
const ZPAD: u8 = b'*';
const FRAME_ZRQINIT: u8 = 0;
const FRAME_ZRINIT: u8 = 1;
const FRAME_ZACK: u8 = 3;
const FRAME_ZFILE: u8 = 4;
const FRAME_ZSKIP: u8 = 5;
const FRAME_ZNAK: u8 = 6;
const FRAME_ZABORT: u8 = 7;
const FRAME_ZFIN: u8 = 8;
const FRAME_ZRPOS: u8 = 9;
const FRAME_ZDATA: u8 = 10;
const FRAME_ZEOF: u8 = 11;
const FRAME_ZFERR: u8 = 12;
const FRAME_ZCAN: u8 = 16;
const SUBPACKET_ZCRCW: u8 = 0x6b;
/// ZFILE 标志取 zmodem2 默认：ZF0=ZCBIN（二进制直传）。
const ZFILE_ZCBIN_FLAGS: [u8; 4] = [1, 0, 0, 0];
/// ZFILE payload：`name\0{size} {mtime:o} {mode:o} 0 0 0\0`（mtime 未知传 0）。
const ZFILE_DEFAULT_MODE: u32 = 0o100644;

/// 静默窗口：超窗即重发最后一帧（握手态直接判失败）。
const IDLE_RETRY: Duration = Duration::from_secs(10);
/// 重发上限，超过即放弃（与 NyaTerm MAX_RETRIES 一致）。
const MAX_RETRIES: u8 = 10;
/// 单个 ZDATA 子包上限：对端 ZRINIT 未声明缓冲时按 zmodem2 的 8 KiB 兜底。
const ZMODEM_MAX_SUBPACKET: usize = 8 * 1024;
/// 对端连续取消字节阈值（ZMODEM 计 ZDLE，X/Y 计 CAN）。
const XY_CANCEL_COUNT: usize = 2;
const Z_CANCEL_COUNT: usize = 5;

/// RPC 入口约束：前端 File API 分块 ≤64 KiB，单次上传总量 ≤256 MiB。
pub const UPLOAD_CHUNK_LIMIT: usize = 64 * 1024;
pub const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
/// 进度事件限流：事件走宿主桥 JSON，128B 块逐块上报过于密集。
pub const PROGRESS_DELTA_BYTES: u64 = 4096;
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// 上传协议；wire 拼写为 `zmodem`（不是历史笔误 `zodem`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadProtocol {
    Xmodem,
    Ymodem,
    Zmodem,
}

impl UploadProtocol {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "xmodem" => Ok(Self::Xmodem),
            "ymodem" => Ok(Self::Ymodem),
            "zmodem" => Ok(Self::Zmodem),
            other => Err(format!(
                "serial/upload/start: invalid protocol \"{other}\" (expected xmodem, ymodem or zmodem)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Xmodem => "xmodem",
            Self::Ymodem => "ymodem",
            Self::Zmodem => "zmodem",
        }
    }
}

/// 进度事件状态（`serial/upload/progress` 的 `state` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgressState {
    Running,
    FileComplete,
    Complete,
    Failed,
}

impl ProgressState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::FileComplete => "file_complete",
            Self::Complete => "complete",
            Self::Failed => "failed",
        }
    }
}

/// 进度事件负载；由 serial_session 拼成 JSON（不含文件内容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferProgress {
    pub protocol: UploadProtocol,
    pub file_name: String,
    pub file_index: u32,
    pub sent: u64,
    pub total: u64,
    pub state: ProgressState,
    pub reason: Option<String>,
}

/// 状态机输出：写往串口的字节，或要上报的进度事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    Write(Vec<u8>),
    Progress(TransferProgress),
}

/// 上传数据源：前端经 `serial/upload/data` 分块送入的字节缓冲。引擎按需
/// 读取（X/Y 顺序 128B，Z 按 ZRPOS 偏移），请求段未到齐且未收尾时返回
/// `Pending`，引擎暂停等待而不误判文件尾。
#[derive(Debug, Default)]
pub struct UploadSource {
    file_name: String,
    total: u64,
    data: Vec<u8>,
    complete: bool,
}

/// [`UploadSource::read_upto`] 的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutcome {
    Ready(Vec<u8>),
    Pending,
    Eof,
}

impl UploadSource {
    pub fn new(file_name: String, total: u64) -> Self {
        Self {
            file_name,
            total,
            data: Vec::new(),
            complete: false,
        }
    }

    pub fn file_name(&self) -> &str {
        &self.file_name
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    /// 已从 RPC 分块收到的字节数（进度回显用）。
    pub fn received(&self) -> u64 {
        self.data.len() as u64
    }

    /// 追加分块；超过 256 MiB 总量上限即拒绝。
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        let next = self.data.len() + bytes.len();
        if next as u64 > MAX_UPLOAD_BYTES {
            return Err(format!(
                "serial/upload/data: upload exceeds the {MAX_UPLOAD_BYTES} byte limit"
            ));
        }
        self.data.extend_from_slice(bytes);
        Ok(())
    }

    pub fn finish(&mut self) {
        self.complete = true;
    }

    /// 读取 `offset` 起至多 `max` 字节。只有当请求段完整可得（或源已收尾）
    /// 才返回 `Ready`，避免把在途分块当成文件尾。
    pub fn read_upto(&self, offset: u64, max: usize) -> Result<ReadOutcome, String> {
        let offset = offset as usize;
        if offset > self.data.len() {
            return Ok(if self.complete {
                ReadOutcome::Eof
            } else {
                ReadOutcome::Pending
            });
        }
        let available = self.data.len() - offset;
        if available == 0 {
            return Ok(if self.complete {
                ReadOutcome::Eof
            } else {
                ReadOutcome::Pending
            });
        }
        if available < max && !self.complete {
            return Ok(ReadOutcome::Pending);
        }
        let end = offset + max.min(available);
        Ok(ReadOutcome::Ready(self.data[offset..end].to_vec()))
    }
}

// —— X/YMODEM ——————————————————————————————————————————————————

/// X/YMODEM 传输状态（与 NyaTerm 的 TransferState 同形）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum XyState {
    WaitingHandshake,
    WaitingHeaderAck,
    WaitingDataStart,
    WaitingDataAck,
    WaitingEotAck,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckMode {
    Checksum,
    Crc,
}

/// X/YMODEM 引擎。`acked` 为对端已确认的负载字节数（进度依据）。
#[derive(Debug)]
pub(crate) struct XyEngine {
    protocol: UploadProtocol,
    state: XyState,
    source: UploadSource,
    /// 下一读取偏移（= 已送上线路的负载字节数）。
    offset: u64,
    /// 对端确认的负载字节数。
    acked: u64,
    sequence: u8,
    check_mode: CheckMode,
    /// 等待确认期间可重发的最后一包（数据块或 EOT）。
    last_packet: Vec<u8>,
    /// 最后一包的真实负载字节数（不含填充；ACK 到达时累入 acked）。
    last_payload_len: u64,
    /// YMODEM：EOT 已确认，接下来握手要的是收尾全零头块。
    files_done: bool,
    retries: u8,
    remote_cancel_count: usize,
    last_activity: Instant,
    /// 握手/启动信号已被消费但数据分块未到齐：暂停时钟等 `append_data`。
    handshake_pending: bool,
    sent_reported: bool,
}

impl XyEngine {
    fn new(protocol: UploadProtocol, source: UploadSource, now: Instant) -> Self {
        Self {
            protocol,
            state: XyState::WaitingHandshake,
            source,
            offset: 0,
            acked: 0,
            sequence: 1,
            check_mode: CheckMode::Crc,
            last_packet: Vec::new(),
            last_payload_len: 0,
            files_done: false,
            retries: 0,
            remote_cancel_count: 0,
            last_activity: now,
            handshake_pending: false,
            sent_reported: false,
        }
    }

    fn is_done(&self) -> bool {
        self.state == XyState::Done
    }

    fn progress(&self, state: ProgressState, reason: Option<String>) -> TransferProgress {
        TransferProgress {
            protocol: self.protocol,
            file_name: self.source.file_name().to_string(),
            file_index: 0,
            sent: self.acked.min(self.source.total()),
            total: self.source.total(),
            state,
            reason,
        }
    }

    fn fail(&mut self, reason: &str) -> Vec<Output> {
        self.state = XyState::Done;
        self.handshake_pending = false;
        vec![
            Output::Write(vec![CAN; 8]),
            Output::Progress(self.progress(ProgressState::Failed, Some(reason.to_string()))),
        ]
    }

    fn feed_at(&mut self, bytes: &[u8], now: Instant) -> Vec<Output> {
        if self.is_done() {
            return Vec::new();
        }
        if !bytes.is_empty() {
            self.last_activity = now;
        }
        let mut actions = Vec::new();
        for &byte in bytes {
            if self.is_done() {
                break;
            }
            let before = actions.len();
            if byte == CAN {
                self.remote_cancel_count = self.remote_cancel_count.saturating_add(1);
                if self.remote_cancel_count >= XY_CANCEL_COUNT {
                    actions.extend(self.fail("Receiver cancelled the transfer"));
                }
                continue;
            }
            self.remote_cancel_count = 0;
            match self.protocol {
                UploadProtocol::Xmodem => self.handle_xmodem_byte(byte, now, &mut actions),
                UploadProtocol::Ymodem => self.handle_ymodem_byte(byte, now, &mut actions),
                UploadProtocol::Zmodem => {}
            }
            // 一轮交互只发一包：重复 ACK 不得推进两个块（NyaTerm 语义）。
            if actions[before..]
                .iter()
                .any(|action| matches!(action, Output::Write(_)))
            {
                break;
            }
        }
        actions
    }

    fn tick_at(&mut self, now: Instant) -> Vec<Output> {
        if self.is_done() || self.handshake_pending {
            return Vec::new();
        }
        if now.duration_since(self.last_activity) < IDLE_RETRY {
            return Vec::new();
        }
        match self.state {
            XyState::WaitingHandshake | XyState::WaitingDataStart => {
                self.fail("Timed out waiting for the receiver handshake")
            }
            XyState::WaitingHeaderAck | XyState::WaitingDataAck | XyState::WaitingEotAck => {
                self.retry_last(now)
            }
            XyState::Done => Vec::new(),
        }
    }

    fn retry_last(&mut self, now: Instant) -> Vec<Output> {
        if self.last_packet.is_empty() {
            return self.fail("Receiver did not acknowledge the transfer");
        }
        self.retries += 1;
        if self.retries > MAX_RETRIES {
            return self.fail("Receiver did not acknowledge the transfer");
        }
        self.last_activity = now;
        vec![Output::Write(self.last_packet.clone())]
    }

    fn handle_xmodem_byte(&mut self, byte: u8, now: Instant, actions: &mut Vec<Output>) {
        match self.state {
            XyState::WaitingHandshake => {
                let mode = match byte {
                    NAK => CheckMode::Checksum,
                    CRC_REQUEST => CheckMode::Crc,
                    _ => return,
                };
                self.check_mode = mode;
                self.sequence = 1;
                if let Err(reason) = self.send_next_data(now, actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingDataAck if byte == ACK => {
                self.confirm_payload(now, actions);
                self.sequence = self.sequence.wrapping_add(1);
                self.retries = 0;
                if let Err(reason) = self.send_next_data(now, actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingDataAck if byte == NAK => actions.extend(self.retry_last(now)),
            XyState::WaitingEotAck if byte == ACK => {
                self.state = XyState::Done;
                actions.push(Output::Progress(
                    self.progress(ProgressState::Complete, None),
                ));
            }
            XyState::WaitingEotAck if byte == NAK => actions.extend(self.retry_last(now)),
            _ => {}
        }
    }

    fn handle_ymodem_byte(&mut self, byte: u8, now: Instant, actions: &mut Vec<Output>) {
        match self.state {
            XyState::WaitingHandshake if byte == CRC_REQUEST => {
                if let Err(reason) = self.send_header_block(now, actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingHeaderAck if byte == ACK => {
                self.retries = 0;
                if self.files_done {
                    // 收尾空头块确认：整批结束。
                    self.state = XyState::Done;
                    actions.push(Output::Progress(
                        self.progress(ProgressState::Complete, None),
                    ));
                } else {
                    // 头块确认后等待接收方再发 'C' 才开始数据块。
                    self.state = XyState::WaitingDataStart;
                }
            }
            XyState::WaitingHeaderAck if byte == NAK => actions.extend(self.retry_last(now)),
            XyState::WaitingDataStart if byte == CRC_REQUEST => {
                self.sequence = 1;
                if let Err(reason) = self.send_next_data(now, actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingDataAck if byte == ACK => {
                self.confirm_payload(now, actions);
                self.sequence = self.sequence.wrapping_add(1);
                self.retries = 0;
                if let Err(reason) = self.send_next_data(now, actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingDataAck if byte == NAK => actions.extend(self.retry_last(now)),
            XyState::WaitingEotAck if byte == NAK => actions.extend(self.retry_last(now)),
            XyState::WaitingEotAck if byte == ACK => {
                // EOT 确认：本文件完成；接收方随后再发 'C' 索要收尾空头块。
                self.retries = 0;
                self.files_done = true;
                actions.push(Output::Progress(
                    self.progress(ProgressState::FileComplete, None),
                ));
                self.last_packet = Vec::new();
                self.last_payload_len = 0;
                self.state = XyState::WaitingHandshake;
            }
            _ => {}
        }
    }

    /// 数据块 ACK 到达：累计确认字节数并上报进度。
    fn confirm_payload(&mut self, now: Instant, actions: &mut Vec<Output>) {
        self.acked = (self.acked + self.last_payload_len).min(self.source.total());
        self.last_activity = now;
        actions.push(Output::Progress(
            self.progress(ProgressState::Running, None),
        ));
    }

    /// YMODEM 头块：`name\0size` 零填充到 128B，块号 0，固定 CRC 校验；
    /// 收尾阶段发全零块。
    fn send_header_block(&mut self, now: Instant, actions: &mut Vec<Output>) -> Result<(), String> {
        let mut data = [0u8; BLOCK_SIZE];
        if !self.files_done {
            let name = self.source.file_name().as_bytes();
            let size = self.source.total().to_string();
            if name.len() + 1 + size.len() > BLOCK_SIZE {
                return Err(format!(
                    "YMODEM file name is too long: {}",
                    self.source.file_name()
                ));
            }
            data[..name.len()].copy_from_slice(name);
            let size_start = name.len() + 1;
            data[size_start..size_start + size.len()].copy_from_slice(size.as_bytes());
        }
        let packet = build_xy_packet(0, &data, CheckMode::Crc);
        self.queue_packet(packet, 0, XyState::WaitingHeaderAck, now, actions);
        Ok(())
    }

    fn send_next_data(&mut self, now: Instant, actions: &mut Vec<Output>) -> Result<(), String> {
        match self.source.read_upto(self.offset, BLOCK_SIZE)? {
            ReadOutcome::Pending => {
                // 分块仍在途：保持当前状态，时钟不推进，等 append_data 唤醒。
                self.handshake_pending = true;
                return Ok(());
            }
            ReadOutcome::Eof => {
                self.handshake_pending = false;
                self.queue_packet(vec![EOT], 0, XyState::WaitingEotAck, now, actions);
                return Ok(());
            }
            ReadOutcome::Ready(chunk) => {
                self.handshake_pending = false;
                let mut data = [CPM_EOF; BLOCK_SIZE];
                data[..chunk.len()].copy_from_slice(&chunk);
                let packet = build_xy_packet(self.sequence, &data, self.check_mode);
                self.offset = (self.offset + chunk.len() as u64).min(self.source.total());
                self.queue_packet(
                    packet,
                    chunk.len() as u64,
                    XyState::WaitingDataAck,
                    now,
                    actions,
                );
            }
        }
        Ok(())
    }

    fn queue_packet(
        &mut self,
        packet: Vec<u8>,
        payload_len: u64,
        state: XyState,
        now: Instant,
        actions: &mut Vec<Output>,
    ) {
        self.last_packet = packet.clone();
        self.last_payload_len = payload_len;
        self.state = state;
        self.retries = 0;
        self.last_activity = now;
        actions.push(Output::Write(packet));
        if !self.sent_reported {
            self.sent_reported = true;
            actions.push(Output::Progress(
                self.progress(ProgressState::Running, None),
            ));
        }
    }

    fn append_data_at(&mut self, now: Instant) -> Vec<Output> {
        if !self.handshake_pending || self.is_done() {
            return Vec::new();
        }
        let mut actions = Vec::new();
        match self.state {
            XyState::WaitingHandshake if self.files_done => {
                // 收尾头块不依赖数据，正常情况下不该挂起；防御性重发。
                if let Err(reason) = self.send_header_block(now, &mut actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            XyState::WaitingHandshake | XyState::WaitingDataStart => {
                if let Err(reason) = self.send_next_data(now, &mut actions) {
                    actions.extend(self.fail(&reason));
                }
            }
            _ => {
                self.handshake_pending = false;
            }
        }
        actions
    }

    fn cancel_at(&mut self) -> Vec<Output> {
        if self.is_done() {
            return Vec::new();
        }
        self.state = XyState::Done;
        self.source.finish();
        vec![
            Output::Write(vec![CAN; 8]),
            Output::Progress(
                self.progress(ProgressState::Failed, Some("cancelled by user".to_string())),
            ),
        ]
    }
}

/// X/YMODEM 分包：SOH + 块号 + 块号取反 + 128B 数据 + checksum/CRC16。
fn build_xy_packet(sequence: u8, data: &[u8; BLOCK_SIZE], mode: CheckMode) -> Vec<u8> {
    let mut packet = Vec::with_capacity(BLOCK_SIZE + 5);
    packet.extend_from_slice(&[SOH, sequence, !sequence]);
    packet.extend_from_slice(data);
    match mode {
        CheckMode::Checksum => {
            packet.push(data.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte)))
        }
        CheckMode::Crc => packet.extend_from_slice(&crc16_xmodem(data).to_be_bytes()),
    }
    packet
}

// —— ZMODEM 编解码原语 ——————————————————————————————————————————

/// 帧编码字节（`ZDLE` 前导之后的那个字符）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZEncoding {
    Zbin,
    Zhex,
    Zbin32,
}

impl ZEncoding {
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            b'A' => Some(Self::Zbin),
            b'B' => Some(Self::Zhex),
            b'C' => Some(Self::Zbin32),
            _ => None,
        }
    }

    /// 头部负载（帧类型 + 4 标志）之后的校验字节数。
    fn crc_len(self) -> usize {
        match self {
            Self::Zbin32 => 4,
            _ => 2,
        }
    }
}

/// 对端帧头。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ZHeader {
    frame: u8,
    flags: [u8; 4],
}

impl ZHeader {
    fn count(&self) -> u32 {
        u32::from_le_bytes(self.flags)
    }
}

/// 帧头逐字节扫描器的状态。
#[derive(Debug)]
enum HeaderScan {
    /// 扫描 ZPAD…ZDLE 前导（`**\x18` 或 `*\x18`）。
    SeekingZpad { pads: usize },
    /// 已见 ZPAD+ZDLE，等编码字节。
    WantEncoding,
    /// 读帧负载：帧类型 + 4 标志 + CRC（逐字节反转义）。
    WantData {
        encoding: ZEncoding,
        payload: Vec<u8>,
        crc: Vec<u8>,
        escape_pending: bool,
    },
    /// hex 帧已完整报出，吃掉一个收尾字节（`\r`）。
    HexCr,
}

impl Default for HeaderScan {
    fn default() -> Self {
        Self::SeekingZpad { pads: 0 }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ScanEvent {
    Header(ZHeader),
    /// 编码非法或 CRC 校验失败：丢弃当前帧重新扫描。
    Corrupt,
}

/// 对端帧头逐字节扫描器。跨 feed 的部分帧在扫描器里缓存。
#[derive(Debug, Default)]
struct HeaderScanner {
    scan: HeaderScan,
    /// hex 字节对的高半位。
    hex_hi: Option<u8>,
}

impl HeaderScanner {
    fn feed_byte(&mut self, byte: u8) -> Option<ScanEvent> {
        // 先在局部把状态迁移算完，避免在 &mut self.scan 借用中再借 self。
        let mut corrupt = false;
        let mut event = None;
        match &mut self.scan {
            HeaderScan::SeekingZpad { pads } => match byte {
                ZPAD => *pads += 1,
                ZDLE if *pads > 0 => {
                    *pads = 0;
                    self.scan = HeaderScan::WantEncoding;
                }
                _ => *pads = 0,
            },
            HeaderScan::WantEncoding => match ZEncoding::from_byte(byte) {
                Some(encoding) => {
                    self.scan = HeaderScan::WantData {
                        encoding,
                        payload: Vec::with_capacity(5),
                        crc: Vec::new(),
                        escape_pending: false,
                    };
                }
                None => {
                    self.scan = HeaderScan::default();
                    corrupt = true;
                }
            },
            HeaderScan::WantData {
                encoding,
                payload,
                crc,
                escape_pending,
            } => {
                let unescaped = if *escape_pending {
                    *escape_pending = false;
                    Some(unescape_zdle(byte))
                } else if byte == ZDLE {
                    *escape_pending = true;
                    None
                } else {
                    Some(byte)
                };
                if let Some(value) = unescaped {
                    if encoding == &ZEncoding::Zhex {
                        let Some(hi) = self.hex_hi.take() else {
                            self.hex_hi = Some(value);
                            return None;
                        };
                        let (Some(h), Some(l)) = (decode_hex(hi), decode_hex(value)) else {
                            self.scan = HeaderScan::default();
                            return Some(ScanEvent::Corrupt);
                        };
                        push_header_byte(payload, crc, (h << 4) | l);
                    } else {
                        push_header_byte(payload, crc, value);
                    }
                    let expected_crc = encoding.crc_len();
                    if crc.len() == expected_crc {
                        let (next, result) = complete_header(*encoding, payload, crc);
                        self.scan = next;
                        event = result;
                    }
                }
            }
            HeaderScan::HexCr => self.scan = HeaderScan::default(),
        }
        if corrupt {
            return Some(ScanEvent::Corrupt);
        }
        event
    }
}

/// 向 hex/binary 帧负载缓冲压入一个解码字节（前 5 字节是负载，其后是 CRC）。
fn push_header_byte(payload: &mut Vec<u8>, crc: &mut Vec<u8>, value: u8) {
    if payload.len() + crc.len() < 5 {
        payload.push(value);
    } else {
        crc.push(value);
    }
}

/// 负载齐了以后校验 CRC 并产出帧头；同时给出扫描器的下一个状态。
fn complete_header(
    encoding: ZEncoding,
    payload: &[u8],
    crc: &[u8],
) -> (HeaderScan, Option<ScanEvent>) {
    let next = if encoding == ZEncoding::Zhex {
        HeaderScan::HexCr
    } else {
        HeaderScan::default()
    };
    if payload.len() != 5 || crc.len() != encoding.crc_len() {
        return (HeaderScan::default(), Some(ScanEvent::Corrupt));
    }
    let ok = match encoding {
        ZEncoding::Zbin32 => {
            crc32_iso_hdlc(payload) == u32::from_le_bytes([crc[0], crc[1], crc[2], crc[3]])
        }
        _ => crc16_xmodem(payload) == u16::from_be_bytes([crc[0], crc[1]]),
    };
    if !ok {
        return (HeaderScan::default(), Some(ScanEvent::Corrupt));
    }
    (
        next,
        Some(ScanEvent::Header(ZHeader {
            frame: payload[0],
            flags: [payload[1], payload[2], payload[3], payload[4]],
        })),
    )
}

fn decode_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// ZDLE 反转义（ZDLE 之后那个字节）：'l'→DEL、'm'→0xFF，其余按
/// "bit6 置位则异或 0x40" 规则还原。
fn unescape_zdle(byte: u8) -> u8 {
    match byte {
        b'l' => 0x7f,
        b'm' => 0xff,
        b if (b & 0x60) == 0x40 => b ^ 0x40,
        b => b,
    }
}

/// ZDLE 转义单字节（与 zmodem2 的 ZDLE_TABLE 行为一致）：CR/XON/XOFF 相邻
/// 流控字节与其高位孪生按 ^0x40 转义，DEL/0xFF 用 'l'/'m'，其余原样。
fn escaped_zdle(byte: u8) -> Option<u8> {
    match byte {
        0x0d | 0x10 | 0x11 | 0x13 | 0x18 => Some(byte ^ 0x40),
        0x8d => Some(0xcd),
        0x90 => Some(0xd0),
        0x91 => Some(0xd1),
        0x93 => Some(0xd3),
        0x7f => Some(b'l'),
        0xff => Some(b'm'),
        _ => None,
    }
}

fn push_escaped(out: &mut Vec<u8>, bytes: &[u8]) {
    for &byte in bytes {
        if let Some(escaped) = escaped_zdle(byte) {
            out.push(ZDLE);
            out.push(escaped);
        } else {
            out.push(byte);
        }
    }
}

fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &byte in data {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// CRC-32/ISO-HDLC（zlib 兼容）。
fn crc32_iso_hdlc(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// 十六进制帧头（ZRQINIT/ZFIN/ZNAK 用）：`**\x18B` + hex(帧+标志+CRC16) +
/// `\r\n`（ZFIN/ZACK 之外再补 XON，见 zmodem2 write_header_end_hex）。
fn hex_header(frame: u8, flags: [u8; 4]) -> Vec<u8> {
    let mut payload = [0u8; 5];
    payload[0] = frame;
    payload[1..].copy_from_slice(&flags);
    let crc = crc16_xmodem(&payload).to_be_bytes();
    let mut out = vec![ZPAD, ZPAD, ZDLE, b'B'];
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in payload.into_iter().chain(crc) {
        out.push(HEX[usize::from(byte >> 4)]);
        out.push(HEX[usize::from(byte & 0x0f)]);
    }
    out.push(b'\r');
    out.push(b'\n');
    if frame != FRAME_ZACK && frame != FRAME_ZFIN {
        out.push(XON);
    }
    out
}

/// 二进制 CRC32 帧头：`*\x18C` + 转义(帧+标志+CRC32 LE)。
fn bin32_header(frame: u8, flags: [u8; 4]) -> Vec<u8> {
    let mut payload = [0u8; 5];
    payload[0] = frame;
    payload[1..].copy_from_slice(&flags);
    let crc = crc32_iso_hdlc(&payload).to_le_bytes();
    let mut out = vec![ZPAD, ZDLE, b'C'];
    push_escaped(&mut out, &payload);
    push_escaped(&mut out, &crc);
    out
}

/// ZCRCW 数据子包：转义(数据) + ZDLE + 0x6b + 转义(CRC32(数据+类型) LE)。
fn zcrcw_subpacket(data: &[u8]) -> Vec<u8> {
    let mut crc_input = Vec::with_capacity(data.len() + 1);
    crc_input.extend_from_slice(data);
    crc_input.push(SUBPACKET_ZCRCW);
    let crc = crc32_iso_hdlc(&crc_input).to_le_bytes();
    let mut out = Vec::with_capacity(data.len() * 2 + 12);
    push_escaped(&mut out, data);
    out.push(ZDLE);
    out.push(SUBPACKET_ZCRCW);
    push_escaped(&mut out, &crc);
    out
}

/// ZMODEM 取消序列（NyaTerm cancel_sequence）：ZDLE×5 + 退格×5。
fn zmodem_cancel_sequence() -> Vec<u8> {
    let mut seq = vec![ZDLE; Z_CANCEL_COUNT];
    seq.extend([0x08; Z_CANCEL_COUNT]);
    seq
}

// —— ZMODEM 发送端 ——————————————————————————————————————————————

/// ZMODEM 发送端状态（对应 zmodem2 SendState 的单文件子集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZState {
    WaitReceiverInit,
    WaitFilePos,
    /// ZDATA+数据已发，等 ZRPOS/ZACK。
    WaitFileAck,
    /// ZEOF 已发，等 ZRINIT。
    WaitFileDone,
    /// ZFIN 已发，等 ZFIN/ZRINIT。
    WaitFinish,
    Done,
}

/// ZMODEM 上传引擎（单文件）。子包策略取保守模式：每帧一个 ZCRCW 子包
/// （强制对端落盘确认），子包大小按对端 ZRINIT 声明的接收缓冲截断。
#[derive(Debug)]
pub(crate) struct ZEngine {
    state: ZState,
    source: UploadSource,
    /// 对端确认的偏移（进度与续传依据）。
    acked: u64,
    chunk: usize,
    scanner: HeaderScanner,
    cancel_count: usize,
    retries: u8,
    /// 可重发的最后一帧（ZRQINIT/ZFILE/ZDATA+数据/ZEOF/ZFIN）。
    last_frame: Vec<u8>,
    last_activity: Instant,
    /// 数据分块未到齐：时钟暂停，等 `append_data` 唤醒。
    waiting_data: bool,
    /// ZRPOS/ZACK 之后待履行的读请求。
    pending_read: bool,
    sent_reported: bool,
}

impl ZEngine {
    fn new(source: UploadSource, now: Instant) -> (Self, Vec<Output>) {
        let zrqinit = hex_header(FRAME_ZRQINIT, [0; 4]);
        let engine = Self {
            state: ZState::WaitReceiverInit,
            source,
            acked: 0,
            chunk: ZMODEM_MAX_SUBPACKET,
            scanner: HeaderScanner::default(),
            cancel_count: 0,
            retries: 0,
            last_frame: zrqinit.clone(),
            last_activity: now,
            waiting_data: false,
            pending_read: false,
            sent_reported: false,
        };
        (engine, vec![Output::Write(zrqinit)])
    }

    fn is_done(&self) -> bool {
        self.state == ZState::Done
    }

    fn progress(&self, state: ProgressState, reason: Option<String>) -> TransferProgress {
        TransferProgress {
            protocol: UploadProtocol::Zmodem,
            file_name: self.source.file_name().to_string(),
            file_index: 0,
            sent: self.acked.min(self.source.total()),
            total: self.source.total(),
            state,
            reason,
        }
    }

    fn fail(&mut self, reason: &str) -> Vec<Output> {
        self.state = ZState::Done;
        self.waiting_data = false;
        self.pending_read = false;
        vec![
            Output::Write(zmodem_cancel_sequence()),
            Output::Progress(self.progress(ProgressState::Failed, Some(reason.to_string()))),
        ]
    }

    fn feed_at(&mut self, bytes: &[u8], now: Instant) -> Vec<Output> {
        if self.is_done() {
            return Vec::new();
        }
        if !bytes.is_empty() {
            self.last_activity = now;
        }
        let mut actions = Vec::new();
        for &byte in bytes {
            if self.is_done() {
                break;
            }
            // 连续 ZDLE 是取消副信道；字节本身仍要喂给扫描器（合法帧头
            // 也以 ZDLE 起始），与 NyaTerm 的处理一致。
            if byte == ZDLE {
                self.cancel_count = self.cancel_count.saturating_add(1);
                if self.cancel_count >= Z_CANCEL_COUNT {
                    self.state = ZState::Done;
                    self.waiting_data = false;
                    self.pending_read = false;
                    actions.push(Output::Progress(self.progress(
                        ProgressState::Failed,
                        Some("Remote cancelled the transfer".to_string()),
                    )));
                    break;
                }
            } else {
                self.cancel_count = 0;
            }
            match self.scanner.feed_byte(byte) {
                Some(ScanEvent::Header(header)) => actions.extend(self.handle_header(header, now)),
                Some(ScanEvent::Corrupt) => {
                    // 坏帧：ZNAK 重扫（与 zmodem2 CRC 错误降级一致）。
                    self.last_activity = now;
                    actions.push(Output::Write(hex_header(FRAME_ZNAK, [0; 4])));
                }
                None => {}
            }
        }
        actions
    }

    fn tick_at(&mut self, now: Instant) -> Vec<Output> {
        if self.is_done() || self.waiting_data {
            return Vec::new();
        }
        if now.duration_since(self.last_activity) < IDLE_RETRY {
            return Vec::new();
        }
        if self.last_frame.is_empty() {
            return self.fail("Receiver did not respond");
        }
        self.retries += 1;
        if self.retries > MAX_RETRIES {
            return self.fail("Receiver did not respond");
        }
        self.last_activity = now;
        vec![Output::Write(self.last_frame.clone())]
    }

    fn handle_header(&mut self, header: ZHeader, now: Instant) -> Vec<Output> {
        match header.frame {
            FRAME_ZRINIT => self.on_zrinit(header, now),
            FRAME_ZRPOS | FRAME_ZACK => self.on_position(header.count(), now),
            FRAME_ZSKIP => self.fail("Remote refused the file"),
            FRAME_ZFIN => self.on_zfin(),
            FRAME_ZCAN | FRAME_ZFERR | FRAME_ZABORT => self.fail("Remote aborted the transfer"),
            _ => {
                // 未知帧：WaitReceiverInit 下重发 ZRQINIT（zmodem2 语义）。
                if self.state == ZState::WaitReceiverInit {
                    self.retries = 0;
                    let frame = hex_header(FRAME_ZRQINIT, [0; 4]);
                    self.last_activity = now;
                    self.last_frame = frame.clone();
                    return vec![Output::Write(frame)];
                }
                Vec::new()
            }
        }
    }

    fn on_zrinit(&mut self, header: ZHeader, now: Instant) -> Vec<Output> {
        // ZR0/ZR1 = 接收缓冲 LE16；0 视为未声明 → 8 KiB；下限 64 上限 8 KiB。
        let declared = u16::from_le_bytes([header.flags[0], header.flags[1]]);
        self.chunk = if declared == 0 {
            ZMODEM_MAX_SUBPACKET
        } else {
            (declared as usize).clamp(64, ZMODEM_MAX_SUBPACKET)
        };
        match self.state {
            ZState::WaitReceiverInit => {
                self.retries = 0;
                let frame = self.build_zfile();
                self.last_frame = frame.clone();
                self.last_activity = now;
                self.state = ZState::WaitFilePos;
                vec![Output::Write(frame)]
            }
            ZState::WaitFileDone => {
                self.retries = 0;
                let mut actions = vec![Output::Progress(
                    self.progress(ProgressState::FileComplete, None),
                )];
                let zfin = hex_header(FRAME_ZFIN, [0; 4]);
                self.last_frame = zfin.clone();
                self.last_activity = now;
                self.state = ZState::WaitFinish;
                actions.push(Output::Write(zfin));
                actions
            }
            ZState::WaitFinish => self.on_zfin(),
            _ => Vec::new(),
        }
    }

    /// ZRPOS/ZACK：携带的对端确认偏移决定续传点。
    fn on_position(&mut self, count: u32, now: Instant) -> Vec<Output> {
        match self.state {
            ZState::WaitFilePos | ZState::WaitFileAck => {
                self.acked = u64::from(count).min(self.source.total());
                let mut actions = vec![Output::Progress(
                    self.progress(ProgressState::Running, None),
                )];
                if self.acked >= self.source.total() {
                    let frame = bin32_header(FRAME_ZEOF, (self.acked as u32).to_le_bytes());
                    self.last_frame = frame.clone();
                    self.retries = 0;
                    self.last_activity = now;
                    self.state = ZState::WaitFileDone;
                    actions.push(Output::Write(frame));
                    return actions;
                }
                self.retries = 0;
                self.pending_read = true;
                actions.extend(self.fulfill_read(now));
                actions
            }
            _ => Vec::new(),
        }
    }

    fn on_zfin(&mut self) -> Vec<Output> {
        if self.state == ZState::WaitFinish {
            self.state = ZState::Done;
            vec![
                Output::Write(b"OO".to_vec()),
                Output::Progress(self.progress(ProgressState::Complete, None)),
            ]
        } else {
            Vec::new()
        }
    }

    /// ZFILE 帧头 + ZCRCW 元数据子包：`name\0{size} {mtime:o} {mode:o} 0 0 0\0`。
    fn build_zfile(&self) -> Vec<u8> {
        let mut meta = Vec::new();
        meta.extend_from_slice(self.source.file_name().as_bytes());
        meta.push(0);
        meta.extend_from_slice(
            format!(
                "{} {:o} {:o} 0 0 0\0",
                self.source.total(),
                0u32,
                ZFILE_DEFAULT_MODE
            )
            .as_bytes(),
        );
        let mut frame = bin32_header(FRAME_ZFILE, ZFILE_ZCBIN_FLAGS);
        frame.extend_from_slice(&zcrcw_subpacket(&meta));
        frame
    }

    /// 挂起读请求到达后的续传：组 ZDATA + 单个 ZCRCW 数据子包。
    fn fulfill_read(&mut self, now: Instant) -> Vec<Output> {
        if !self.pending_read || self.is_done() {
            return Vec::new();
        }
        let want = ((self.source.total() - self.acked) as usize).min(self.chunk);
        match self.source.read_upto(self.acked, want) {
            Ok(ReadOutcome::Ready(chunk)) => {
                self.waiting_data = false;
                self.pending_read = false;
                let mut frame = bin32_header(FRAME_ZDATA, (self.acked as u32).to_le_bytes());
                frame.extend_from_slice(&zcrcw_subpacket(&chunk));
                self.last_frame = frame.clone();
                self.last_activity = now;
                self.state = ZState::WaitFileAck;
                let mut actions = Vec::new();
                if !self.sent_reported {
                    self.sent_reported = true;
                    actions.push(Output::Progress(
                        self.progress(ProgressState::Running, None),
                    ));
                }
                actions.push(Output::Write(frame));
                actions
            }
            Ok(ReadOutcome::Pending) => {
                // 分块在途：暂停时钟等待 append_data 唤醒。
                self.waiting_data = true;
                Vec::new()
            }
            Ok(ReadOutcome::Eof) => {
                // 对端确认越过已收尾的文件尾：按当前位置收束为 ZEOF。
                let frame = bin32_header(FRAME_ZEOF, (self.acked as u32).to_le_bytes());
                self.waiting_data = false;
                self.pending_read = false;
                self.last_frame = frame.clone();
                self.last_activity = now;
                self.state = ZState::WaitFileDone;
                vec![Output::Write(frame)]
            }
            Err(reason) => self.fail(&reason),
        }
    }

    fn append_data_at(&mut self, now: Instant) -> Vec<Output> {
        if self.waiting_data {
            self.waiting_data = false;
            self.last_activity = now;
            return self.fulfill_read(now);
        }
        Vec::new()
    }

    fn cancel_at(&mut self) -> Vec<Output> {
        if self.is_done() {
            return Vec::new();
        }
        self.state = ZState::Done;
        self.waiting_data = false;
        self.pending_read = false;
        vec![
            Output::Write(zmodem_cancel_sequence()),
            Output::Progress(
                self.progress(ProgressState::Failed, Some("cancelled by user".to_string())),
            ),
        ]
    }
}

// —— 统一引擎门面 ————————————————————————————————————————————————

/// serial_session 只与它交互；三协议共用同一组入口。
#[derive(Debug)]
pub enum UploadEngine {
    Xy(Box<XyEngine>),
    Z(Box<ZEngine>),
}

impl UploadEngine {
    /// 创建引擎并返回初始输出（ZMODEM 立即发 ZRQINIT；X/Y 静默等握手）。
    pub fn new(
        protocol: UploadProtocol,
        file_name: String,
        total: u64,
        now: Instant,
    ) -> (Self, Vec<Output>) {
        let source = UploadSource::new(file_name, total);
        match protocol {
            UploadProtocol::Zmodem => {
                let (engine, outputs) = ZEngine::new(source, now);
                (Self::Z(Box::new(engine)), outputs)
            }
            _ => (
                Self::Xy(Box::new(XyEngine::new(protocol, source, now))),
                Vec::new(),
            ),
        }
    }

    /// 对端字节流（终端照常上屏，引擎按状态选择性消费）。
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Output> {
        let now = Instant::now();
        match self {
            Self::Xy(engine) => engine.feed_at(bytes, now),
            Self::Z(engine) => engine.feed_at(bytes, now),
        }
    }

    /// 空闲滴答：驱动静默重发/失败判定。
    pub fn tick(&mut self) -> Vec<Output> {
        let now = Instant::now();
        match self {
            Self::Xy(engine) => engine.tick_at(now),
            Self::Z(engine) => engine.tick_at(now),
        }
    }

    /// 前端分块到达；可能解锁挂起的数据读请求。
    pub fn append_data(&mut self, bytes: &[u8], final_chunk: bool) -> Result<Vec<Output>, String> {
        let now = Instant::now();
        {
            let source = match self {
                Self::Xy(engine) => &mut engine.source,
                Self::Z(engine) => &mut engine.source,
            };
            source.append(bytes)?;
            if final_chunk {
                source.finish();
            }
        }
        match self {
            Self::Xy(engine) => Ok(engine.append_data_at(now)),
            Self::Z(engine) => Ok(engine.append_data_at(now)),
        }
    }

    /// 用户取消：发取消序列并落 Failed 事件（已结束则幂等）。
    pub fn cancel(&mut self) -> Vec<Output> {
        match self {
            Self::Xy(engine) => engine.cancel_at(),
            Self::Z(engine) => engine.cancel_at(),
        }
    }

    pub fn is_done(&self) -> bool {
        match self {
            Self::Xy(engine) => engine.is_done(),
            Self::Z(engine) => engine.is_done(),
        }
    }

    pub fn source(&self) -> &UploadSource {
        match self {
            Self::Xy(engine) => &engine.source,
            Self::Z(engine) => &engine.source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 校验算法金标 ————————————————————————————————————————

    #[test]
    fn crc_vectors_match_known_values() {
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
        assert_eq!(crc32_iso_hdlc(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc16_xmodem(b""), 0);
    }

    // —— 测试工具 ——————————————————————————————————————————————

    /// hex 帧（带 `\r\n` 收尾），模拟 lrzsz 接收器发来的 ZRINIT 等。
    fn peer_hex_header(frame: u8, flags: [u8; 4]) -> Vec<u8> {
        hex_header(frame, flags)
    }

    /// bin32 帧，模拟 ZRPOS/ZACK/ZSKIP。
    fn peer_bin32_header(frame: u8, count: u32) -> Vec<u8> {
        bin32_header(frame, count.to_le_bytes())
    }

    fn feed(engine: &mut UploadEngine, bytes: &[u8]) -> Vec<Output> {
        engine.feed(bytes)
    }

    fn writes(outputs: &[Output]) -> Vec<&Vec<u8>> {
        outputs
            .iter()
            .filter_map(|output| match output {
                Output::Write(data) => Some(data),
                Output::Progress(_) => None,
            })
            .collect()
    }

    fn last_progress(outputs: &[Output]) -> &TransferProgress {
        outputs
            .iter()
            .rev()
            .find_map(|output| match output {
                Output::Progress(progress) => Some(progress),
                Output::Write(_) => None,
            })
            .expect("progress output expected")
    }

    fn has_state(outputs: &[Output], state: ProgressState) -> bool {
        outputs
            .iter()
            .any(|output| matches!(output, Output::Progress(p) if p.state == state))
    }

    fn contains_pair(frame: &[u8], first: u8, second: u8) -> bool {
        frame.windows(2).any(|w| w == [first, second])
    }

    /// 建好引擎并灌满数据（final 分块），模拟文件已完整送入 sidecar。
    fn engine_with_data(protocol: UploadProtocol, data: &[u8]) -> UploadEngine {
        let (mut engine, initial) = UploadEngine::new(
            protocol,
            "firmware.bin".to_string(),
            data.len() as u64,
            Instant::now(),
        );
        match protocol {
            UploadProtocol::Zmodem => assert_eq!(
                writes(&initial)[0][..4],
                [ZPAD, ZPAD, ZDLE, b'B'],
                "ZMODEM starts with a hex ZRQINIT"
            ),
            _ => assert!(initial.is_empty(), "X/Y engines start silent"),
        }
        let outputs = engine.append_data(data, true).unwrap();
        assert!(
            outputs.is_empty(),
            "no unlock outputs expected: {outputs:?}"
        );
        engine
    }

    // —— 上传数据源 ————————————————————————————————————————————

    #[test]
    fn upload_source_enforces_total_cap() {
        let mut source = UploadSource::new("f".to_string(), 10);
        source.append(&[0u8; 16]).unwrap();
        let error = source
            .append(&[0u8; MAX_UPLOAD_BYTES as usize])
            .unwrap_err();
        assert!(error.contains("limit"), "{error}");
    }

    #[test]
    fn upload_source_read_gates_inflight_tail() {
        let mut source = UploadSource::new("f".to_string(), 10);
        source.append(&[0u8; 4]).unwrap();
        assert_eq!(source.read_upto(0, 10).unwrap(), ReadOutcome::Pending);
        source.finish();
        match source.read_upto(0, 10).unwrap() {
            ReadOutcome::Ready(bytes) => assert_eq!(bytes.len(), 4),
            other => panic!("expected ready, got {other:?}"),
        }
        assert_eq!(source.read_upto(4, 10).unwrap(), ReadOutcome::Eof);
    }

    // —— XMODEM ————————————————————————————————————————————————

    #[test]
    fn xmodem_crc_handshake_sends_block_one_and_pads_tail() {
        let mut engine = engine_with_data(UploadProtocol::Xmodem, b"hello");
        let outputs = feed(&mut engine, &[CRC_REQUEST]);
        let packet = writes(&outputs)[0].clone();
        assert_eq!(&packet[..3], &[SOH, 1, !1u8]);
        assert_eq!(
            packet.len(),
            BLOCK_SIZE + 5,
            "128B payload + SOH/seq/!seq + CRC16"
        );
        assert_eq!(
            &packet[3 + BLOCK_SIZE..],
            &crc16_xmodem(&packet[3..3 + BLOCK_SIZE]).to_be_bytes()
        );
        assert_eq!(&packet[3..8], b"hello");
        assert!(packet[8..3 + BLOCK_SIZE].iter().all(|&b| b == CPM_EOF));
        assert!(!engine.is_done());
    }

    #[test]
    fn xmodem_nak_handshake_uses_checksum_trailer() {
        let mut engine = engine_with_data(UploadProtocol::Xmodem, b"hi");
        let outputs = feed(&mut engine, &[NAK]);
        let packet = writes(&outputs)[0].clone();
        assert_eq!(packet.len(), BLOCK_SIZE + 4, "checksum trailer is 1 byte");
        let sum = packet[3..3 + BLOCK_SIZE]
            .iter()
            .fold(0u8, |acc, b| acc.wrapping_add(*b));
        assert_eq!(packet[3 + BLOCK_SIZE], sum);
    }

    #[test]
    fn xmodem_nak_retransmits_same_block_then_ack_advances() {
        let data = [0x5au8; BLOCK_SIZE * 2 + 10];
        let mut engine = engine_with_data(UploadProtocol::Xmodem, &data);
        let first = writes(&feed(&mut engine, &[CRC_REQUEST]))[0].clone();

        let retry = feed(&mut engine, &[NAK]);
        assert_eq!(writes(&retry)[0], &first, "NAK resends the same block");

        let second = feed(&mut engine, &[ACK]);
        let packet = writes(&second)[0].clone();
        assert_eq!(packet[1], 2, "ACK advances to the next block");

        let retry2 = feed(&mut engine, &[NAK]);
        assert_eq!(writes(&retry2)[0], &packet);
    }

    #[test]
    fn xmodem_repeated_ack_confirms_only_one_block() {
        let data = [0x33u8; BLOCK_SIZE * 3];
        let mut engine = engine_with_data(UploadProtocol::Xmodem, &data);
        let _ = feed(&mut engine, &[CRC_REQUEST]);
        let outputs = feed(&mut engine, &[ACK, ACK]);
        let queued = writes(&outputs);
        assert_eq!(queued.len(), 1, "duplicate ACK must not queue two blocks");
        assert_eq!(queued[0][1], 2);
        // 进度按确认字节数报（块 1 的 128 字节），而非发送偏移。
        assert_eq!(last_progress(&outputs).sent, BLOCK_SIZE as u64);
    }

    #[test]
    fn xmodem_eof_and_final_ack_completes() {
        let mut engine = engine_with_data(UploadProtocol::Xmodem, b"data");
        let _ = feed(&mut engine, &[CRC_REQUEST]);
        // 唯一数据块 ACK 后即 EOT；先被 NAK（lrzsz 风格）再 ACK 收尾。
        let eot = feed(&mut engine, &[ACK]);
        assert_eq!(writes(&eot)[0], &[EOT]);
        let retry = feed(&mut engine, &[NAK]);
        assert_eq!(writes(&retry)[0], &[EOT]);
        let done = feed(&mut engine, &[ACK]);
        assert!(has_state(&done, ProgressState::Complete));
        assert_eq!(last_progress(&done).sent, 4);
        assert!(engine.is_done());
        // 完成后的输入被忽略且不再输出。
        assert!(feed(&mut engine, &[ACK]).is_empty());
    }

    #[test]
    fn xmodem_empty_file_sends_eot_directly() {
        let mut engine = engine_with_data(UploadProtocol::Xmodem, b"");
        let outputs = feed(&mut engine, &[CRC_REQUEST]);
        assert_eq!(writes(&outputs)[0], &[EOT]);
    }

    #[test]
    fn xmodem_remote_cancel_fails_transfer() {
        let mut engine = engine_with_data(UploadProtocol::Xmodem, b"data");
        let outputs = feed(&mut engine, &[CAN, CAN]);
        assert!(has_state(&outputs, ProgressState::Failed));
        assert_eq!(writes(&outputs)[0], &vec![CAN; 8]);
        assert!(engine.is_done());
    }

    #[test]
    fn xmodem_streaming_data_gates_first_block() {
        let (mut engine, initial) = UploadEngine::new(
            UploadProtocol::Xmodem,
            "fw.bin".to_string(),
            300,
            Instant::now(),
        );
        assert!(initial.is_empty());
        // 数据未到齐时握手信号被消费但不发包。
        assert!(feed(&mut engine, &[CRC_REQUEST]).is_empty());
        let _ = engine.append_data(&[0u8; 64], false).unwrap();
        assert!(
            feed(&mut engine, &[CRC_REQUEST]).is_empty(),
            "partial chunk must not be treated as tail"
        );
        // 补齐一块后从 append_data 直接解锁发包。
        let unlocked = engine.append_data(&[0u8; 64], false).unwrap();
        assert_eq!(writes(&unlocked).len(), 1);
        assert_eq!(writes(&unlocked)[0][1], 1);
    }

    #[test]
    fn xmodem_idle_timeout_retries_then_fails() {
        let start = Instant::now();
        let (mut engine, _) = UploadEngine::new(
            UploadProtocol::Xmodem,
            "fw.bin".to_string(),
            3,
            start - Duration::from_secs(3600),
        );
        let _ = engine.append_data(b"abc", true).unwrap();
        // 先握手发出块 1，再回到过去制造静默窗口。
        let _ = feed(&mut engine, &[CRC_REQUEST]);
        let UploadEngine::Xy(inner) = &mut engine else {
            unreachable!()
        };
        let mut expected_data = [CPM_EOF; BLOCK_SIZE];
        expected_data[..3].copy_from_slice(b"abc");
        inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
        let retry = inner.tick_at(start);
        assert_eq!(
            writes(&retry)[0],
            &build_xy_packet(1, &expected_data, CheckMode::Crc)
        );
        assert!(!inner.is_done());
        // 已重发 1 次；再重发 MAX_RETRIES-1 次后下一次 tick 判失败。
        for _ in 0..MAX_RETRIES - 1 {
            inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
            let _ = inner.tick_at(start);
        }
        inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
        let failed = inner.tick_at(start);
        assert!(has_state(&failed, ProgressState::Failed));
        assert!(inner.is_done());
    }

    #[test]
    fn xmodem_handshake_idle_fails_when_no_receiver() {
        let start = Instant::now();
        let (mut engine, _) = UploadEngine::new(
            UploadProtocol::Xmodem,
            "fw.bin".to_string(),
            0,
            start - Duration::from_secs(3600),
        );
        let UploadEngine::Xy(inner) = &mut engine else {
            unreachable!()
        };
        let failed = inner.tick_at(start);
        assert!(has_state(&failed, ProgressState::Failed));
        assert!(inner.is_done());
    }

    // —— YMODEM ————————————————————————————————————————————————

    #[test]
    fn ymodem_header_block_carries_name_and_size_zero_padded() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        let outputs = feed(&mut engine, &[CRC_REQUEST]);
        let header = writes(&outputs)[0].clone();
        assert_eq!(header[0], SOH);
        assert_eq!(header[1], 0, "header block uses sequence 0");
        assert_eq!(&header[3..15], b"firmware.bin");
        assert_eq!(header[15], 0, "name is NUL-terminated");
        assert_eq!(&header[16..17], b"3");
        assert!(header[17..3 + BLOCK_SIZE].iter().all(|&b| b == 0));
        assert_eq!(
            &header[3 + BLOCK_SIZE..],
            &crc16_xmodem(&header[3..3 + BLOCK_SIZE]).to_be_bytes()
        );
    }

    #[test]
    fn ymodem_full_batch_flow_with_final_empty_header() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        let _ = feed(&mut engine, &[CRC_REQUEST]);
        // 头块 ACK 后等待 'C' 才发数据块。
        assert!(feed(&mut engine, &[ACK]).is_empty());
        let data = writes(&feed(&mut engine, &[CRC_REQUEST]))[0].clone();
        assert_eq!(data[1], 1);
        assert_eq!(&data[3..6], b"abc");
        assert!(data[6..3 + BLOCK_SIZE].iter().all(|&b| b == CPM_EOF));

        // 数据 ACK → EOT；NAK 重发，ACK 后文件完成。
        let eot = writes(&feed(&mut engine, &[ACK]))[0].clone();
        assert_eq!(eot, &[EOT]);
        assert_eq!(writes(&feed(&mut engine, &[NAK]))[0], &[EOT]);
        let after_eot = feed(&mut engine, &[ACK]);
        assert!(has_state(&after_eot, ProgressState::FileComplete));
        // 收尾空头块也要等 'C'。
        assert!(feed(&mut engine, &[ACK]).is_empty());
        let closing = writes(&feed(&mut engine, &[CRC_REQUEST]))[0].clone();
        assert_eq!(closing[1], 0);
        assert!(closing[3..3 + BLOCK_SIZE].iter().all(|&b| b == 0));
        let done = feed(&mut engine, &[ACK]);
        assert!(has_state(&done, ProgressState::Complete));
        assert_eq!(last_progress(&done).sent, 3);
        assert!(engine.is_done());
    }

    #[test]
    fn ymodem_nak_on_header_retransmits() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        let header = writes(&feed(&mut engine, &[CRC_REQUEST]))[0].clone();
        let retry = feed(&mut engine, &[NAK]);
        assert_eq!(writes(&retry)[0], &header);
    }

    #[test]
    fn ymodem_handshake_only_accepts_c() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        assert!(feed(&mut engine, &[NAK]).is_empty());
        assert!(feed(&mut engine, &[ACK]).is_empty());
        assert!(!writes(&feed(&mut engine, &[CRC_REQUEST])).is_empty());
    }

    #[test]
    fn ymodem_remote_cancel_fails() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        let outputs = feed(&mut engine, &[CAN, CAN]);
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());
    }

    #[test]
    fn ymodem_user_cancel_sends_can_and_marks_failed() {
        let mut engine = engine_with_data(UploadProtocol::Ymodem, b"abc");
        let outputs = engine.cancel();
        assert_eq!(writes(&outputs)[0], &vec![CAN; 8]);
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());
        assert!(engine.cancel().is_empty(), "cancel is idempotent once done");
    }

    // —— ZMODEM ————————————————————————————————————————————————

    #[test]
    fn zmodem_happy_path_from_zrinit_to_oo() {
        // 数据刻意包含 0x18/0x7f/0xff 等需转义字节。
        let data: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
        let mut engine = engine_with_data(UploadProtocol::Zmodem, &data);

        // ZRINIT（缓冲未声明 → 8 KiB 子包）→ ZFILE。
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0, 0, 0, 0x23]));
        let zfile = writes(&outputs)[0].clone();
        assert_eq!(&zfile[..3], &[ZPAD, ZDLE, b'C'], "ZFILE is bin32");
        assert_eq!(zfile[3], FRAME_ZFILE);
        assert!(contains_pair(&zfile, ZDLE, SUBPACKET_ZCRCW));

        // ZRPOS(0) → ZDATA + 数据子包（≤8KiB，这里整文件一段）。
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 0));
        let zdata = writes(&outputs)[0].clone();
        assert_eq!(zdata[3], FRAME_ZDATA);
        assert_eq!(&zdata[4..8], &0u32.to_le_bytes());
        assert!(contains_pair(&zdata, ZDLE, SUBPACKET_ZCRCW));

        // ZACK(2048) → 从 2048 续传。
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZACK, 2048));
        let zdata2 = writes(&outputs)[0].clone();
        assert_eq!(&zdata2[4..8], &2048u32.to_le_bytes());

        // ZACK(2500 ≥ size) → ZEOF（文件完成确认在下一个 ZRINIT 上报）。
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZACK, 2500));
        let zeof = writes(&outputs)[0].clone();
        assert_eq!(zeof[3], FRAME_ZEOF);
        assert_eq!(&zeof[4..8], &2500u32.to_le_bytes());

        // ZRINIT 确认 EOF → FileComplete 事件 + ZFIN(hex)。
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        assert!(has_state(&outputs, ProgressState::FileComplete));
        let zfin = writes(&outputs)[0].clone();
        assert_eq!(&zfin[..4], &[ZPAD, ZPAD, ZDLE, b'B']);
        assert!(!zfin.ends_with(&[XON]), "ZFIN hex header has no XON tail");

        // 对端 ZFIN → "OO" + Complete。
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZFIN, [0; 4]));
        assert_eq!(writes(&outputs)[0], b"OO");
        assert!(has_state(&outputs, ProgressState::Complete));
        assert!(engine.is_done());
        assert!(feed(&mut engine, &peer_hex_header(FRAME_ZFIN, [0; 4])).is_empty());
        let _ = zdata2;
    }

    #[test]
    fn zmodem_zfile_metadata_carries_name_size_and_mode() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        let zfile = writes(&outputs)[0].clone();
        let text = String::from_utf8_lossy(&zfile);
        assert!(
            text.contains("firmware.bin\0"),
            "name in ZFILE payload: {text:?}"
        );
        assert!(
            text.contains("3 0 100644 0 0 0\0"),
            "size/mtime/mode fields: {text:?}"
        );
    }

    #[test]
    fn zmodem_zrinit_buffer_size_caps_subpacket() {
        let data = [0x11u8; 4096];
        let mut engine = engine_with_data(UploadProtocol::Zmodem, &data);
        // 声明 0x0040 = 64 字节接收缓冲。
        let _ = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0x40, 0, 0, 0]));
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 0));
        let zdata = writes(&outputs)[0].clone();
        assert_eq!(zdata_payload_len(&zdata), 64);
    }

    /// 从 ZDATA 帧取数据子包负载长度（转义对按 1 字节计）。
    fn zdata_payload_len(frame: &[u8]) -> usize {
        let mut len = 0;
        let mut i = 3; // 跳过 ZPAD ZDLE 'C'
        let mut in_payload = false;
        while i < frame.len() {
            if in_payload {
                if frame[i] == ZDLE {
                    if frame.get(i + 1) == Some(&SUBPACKET_ZCRCW) {
                        break;
                    }
                    i += 2;
                } else {
                    i += 1;
                }
                len += 1;
                continue;
            }
            // bin32 头负载 5 字节 + CRC32 4 字节（含可能的转义对）。
            if frame[i] == ZDLE {
                i += 2;
            } else {
                i += 1;
            }
            len += 1;
            if len == 9 {
                in_payload = true;
                len = 0;
            }
        }
        len
    }

    #[test]
    fn zmodem_zskip_and_zcan_fail_transfer() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let _ = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZSKIP, 0));
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());

        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZCAN, [0; 4]));
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());
    }

    #[test]
    fn zmodem_remote_cancel_via_five_can_bytes() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let outputs = feed(&mut engine, &[ZDLE; 5]);
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());
        assert!(
            writes(&outputs).is_empty(),
            "remote cancel does not echo a cancel sequence"
        );
    }

    #[test]
    fn zmodem_corrupt_header_sends_znak_and_recovers() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let garbage = vec![ZPAD, ZDLE, b'Z'];
        let outputs = feed(&mut engine, &garbage);
        let znak = writes(&outputs)[0].clone();
        assert_eq!(&znak[..4], &[ZPAD, ZPAD, ZDLE, b'B']);
        assert_eq!(znak[4], b'0', "hex ZNAK frame byte starts with '0'");
        assert_eq!(znak[5], b'6', "hex ZNAK frame byte ends with '6'");
        // 之后正常 ZRINIT 仍然被接受。
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        assert_eq!(writes(&outputs)[0][3], FRAME_ZFILE);
    }

    #[test]
    fn zmodem_crc_mismatch_is_reported_as_znak() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let mut frame = peer_bin32_header(FRAME_ZACK, 0);
        let last = frame.len() - 1;
        frame[last] ^= 0xff;
        let outputs = feed(&mut engine, &frame);
        assert!(
            has_state(&outputs, ProgressState::Failed) || !writes(&outputs).is_empty(),
            "corrupt frame must produce output"
        );
        assert!(
            writes(&outputs)
                .iter()
                .any(|f| f[..4] == [ZPAD, ZPAD, ZDLE, b'B'] && f[4] == b'0' && f[5] == b'6'),
            "expected a hex ZNAK"
        );
        // 帧流仍然可以恢复。
        let outputs = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        assert_eq!(writes(&outputs)[0][3], FRAME_ZFILE);
    }

    #[test]
    fn zmodem_streaming_source_gates_zdata_until_chunks_arrive() {
        let (mut engine, initial) = UploadEngine::new(
            UploadProtocol::Zmodem,
            "fw.bin".to_string(),
            1000,
            Instant::now(),
        );
        assert_eq!(writes(&initial)[0][..4], [ZPAD, ZPAD, ZDLE, b'B']);
        let _ = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 0));
        assert!(
            writes(&outputs).is_empty(),
            "no data frame without source bytes"
        );
        // 半截分块且未收尾：继续等待。
        let _ = engine.append_data(&[0u8; 500], false).unwrap();
        assert!(feed(&mut engine, &[]).is_empty());
        // final 分块补齐 → ZDATA 立即从 append_data 解锁出现。
        let unlocked = engine.append_data(&[0u8; 500], true).unwrap();
        assert_eq!(writes(&unlocked).len(), 1);
        assert_eq!(writes(&unlocked)[0][3], FRAME_ZDATA);
    }

    #[test]
    fn zmodem_resume_from_zrpos_offset_retransmits_from_there() {
        let data: Vec<u8> = (0..600u32).map(|i| i as u8).collect();
        let mut engine = engine_with_data(UploadProtocol::Zmodem, &data);
        let _ = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        let _ = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 0));
        // 对端落盘到 512 后掉线重连，ZRPOS(512) 要求续传。
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 512));
        let zdata = writes(&outputs)[0].clone();
        assert_eq!(&zdata[4..8], &512u32.to_le_bytes());
        assert_eq!(zdata_payload_len(&zdata), 88);
    }

    #[test]
    fn zmodem_user_cancel_sends_cancel_sequence() {
        let mut engine = engine_with_data(UploadProtocol::Zmodem, b"abc");
        let outputs = engine.cancel();
        assert_eq!(writes(&outputs)[0], &zmodem_cancel_sequence());
        assert_eq!(
            zmodem_cancel_sequence(),
            vec![ZDLE, ZDLE, ZDLE, ZDLE, ZDLE, 0x08, 0x08, 0x08, 0x08, 0x08]
        );
        assert!(has_state(&outputs, ProgressState::Failed));
        assert!(engine.is_done());
        assert!(engine.cancel().is_empty());
    }

    #[test]
    fn zmodem_idle_timeout_resends_zrqinit_then_fails() {
        let start = Instant::now();
        let (engine, initial) =
            UploadEngine::new(UploadProtocol::Zmodem, "fw.bin".to_string(), 0, start);
        assert!(!initial.is_empty());
        let mut inner = match engine {
            UploadEngine::Z(inner) => inner,
            UploadEngine::Xy(_) => unreachable!(),
        };
        inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
        let retry = inner.tick_at(start);
        assert_eq!(writes(&retry)[0], &hex_header(FRAME_ZRQINIT, [0; 4]));
        // 已重发 1 次；再重发 MAX_RETRIES-1 次后下一次 tick 判失败。
        for _ in 0..MAX_RETRIES - 1 {
            inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
            let _ = inner.tick_at(start);
        }
        inner.last_activity = start - IDLE_RETRY - Duration::from_millis(1);
        let failed = inner.tick_at(start);
        assert!(has_state(&failed, ProgressState::Failed));
        assert!(inner.is_done());
    }

    #[test]
    fn zmodem_progress_tracks_acked_bytes() {
        let data = [0x42u8; 300];
        let mut engine = engine_with_data(UploadProtocol::Zmodem, &data);
        let _ = feed(&mut engine, &peer_hex_header(FRAME_ZRINIT, [0; 4]));
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZRPOS, 0));
        assert_eq!(last_progress(&outputs).sent, 0, "nothing acked yet");
        let outputs = feed(&mut engine, &peer_bin32_header(FRAME_ZACK, 128));
        assert_eq!(last_progress(&outputs).sent, 128);
    }

    // —— 协议拼写与工具 ————————————————————————————————————————

    #[test]
    fn upload_protocol_parse_rejects_typo_and_junk() {
        assert_eq!(
            UploadProtocol::parse("xmodem").unwrap(),
            UploadProtocol::Xmodem
        );
        assert_eq!(
            UploadProtocol::parse("ymodem").unwrap(),
            UploadProtocol::Ymodem
        );
        assert_eq!(
            UploadProtocol::parse("zmodem").unwrap(),
            UploadProtocol::Zmodem
        );
        for junk in ["zodem", "XMODEM", "modem", ""] {
            assert!(
                UploadProtocol::parse(junk).is_err(),
                "{junk:?} must be rejected"
            );
        }
    }

    #[test]
    fn zdle_escape_roundtrip_covers_special_bytes() {
        let raw: Vec<u8> = (0..=255u8).collect();
        let mut escaped = Vec::new();
        push_escaped(&mut escaped, &raw);
        let mut restored = Vec::new();
        let mut i = 0;
        while i < escaped.len() {
            if escaped[i] == ZDLE {
                restored.push(unescape_zdle(escaped[i + 1]));
                i += 2;
            } else {
                restored.push(escaped[i]);
                i += 1;
            }
        }
        assert_eq!(restored, raw);
    }

    #[test]
    fn header_scanner_roundtrips_own_frames() {
        // 三种编码的帧都能被扫描器解回（逐字节喂入，含 hex 收尾 \r\n/XON）。
        let cases = [
            (
                hex_header(FRAME_ZRINIT, [0x40, 0, 0, 0x23]),
                FRAME_ZRINIT,
                0x2300_0040u32,
            ),
            (peer_bin32_header(FRAME_ZRPOS, 1234), FRAME_ZRPOS, 1234),
            (
                peer_bin32_header(FRAME_ZACK, 0xdead_beef),
                FRAME_ZACK,
                0xdead_beef,
            ),
            (hex_header(FRAME_ZFIN, [0; 4]), FRAME_ZFIN, 0),
        ];
        for (frame, expected_frame, expected_count) in cases {
            let mut scanner = HeaderScanner::default();
            let mut last = None;
            for &byte in &frame {
                if let Some(event) = scanner.feed_byte(byte) {
                    last = Some(event);
                }
            }
            match last {
                Some(ScanEvent::Header(header)) => {
                    assert_eq!(header.frame, expected_frame);
                    assert_eq!(header.count(), expected_count);
                }
                other => panic!("expected header, got {other:?}"),
            }
        }
    }

    #[test]
    fn header_scanner_decodes_known_zack_count() {
        let mut scanner = HeaderScanner::default();
        let mut header = None;
        for &byte in &peer_bin32_header(FRAME_ZACK, 0x0102_0304) {
            if let Some(event) = scanner.feed_byte(byte) {
                header = Some(event);
            }
        }
        match header {
            Some(ScanEvent::Header(parsed)) => {
                assert_eq!(parsed.frame, FRAME_ZACK);
                assert_eq!(parsed.count(), 0x0102_0304);
            }
            other => panic!("expected header, got {other:?}"),
        }
    }
}
