use super::*;

/// Monotonic terminal output journal shared by the SSH and local-terminal
/// session loops: assigns each chunk a sequence, keeps a bounded tail for
/// `replay`, and survives transport gaps. The byte budget defaults to the
/// shared 2 MiB terminal limit; serial sessions build a smaller buffer via
/// [`ReplayBuffer::with_byte_limit`] (128 KiB, design doc §3).
pub(crate) struct ReplayBuffer {
    pub(super) frames: VecDeque<TerminalFrame>,
    pub(super) bytes: usize,
    pub(super) sequence: u64,
    pub(super) byte_limit: usize,
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::with_byte_limit(TERMINAL_REPLAY_LIMIT)
    }
}

impl ReplayBuffer {
    pub(crate) fn with_byte_limit(byte_limit: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            byte_limit,
        }
    }

    pub(crate) fn push(&mut self, stream: TerminalStream, data: Vec<u8>) -> TerminalFrame {
        self.sequence += 1;
        let frame = TerminalFrame {
            sequence: self.sequence,
            stream,
            data,
        };
        self.bytes += frame.data.len();
        self.frames.push_back(frame.clone());
        while self.bytes > self.byte_limit {
            let Some(removed) = self.frames.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.data.len());
        }
        frame
    }

    pub(crate) fn after(&self, sequence: u64) -> Vec<TerminalFrame> {
        self.frames
            .iter()
            .filter(|frame| frame.sequence > sequence)
            .cloned()
            .collect()
    }

    pub(crate) fn first_sequence(&self) -> u64 {
        self.frames
            .front()
            .map(|frame| frame.sequence)
            .unwrap_or(self.sequence.saturating_add(1))
    }

    /// Highest assigned sequence (0 until the first push).
    pub(crate) fn tail_sequence(&self) -> u64 {
        self.sequence
    }
}

/// Remote (-R) port mapping table for one connection, keyed by
/// `(listen_host, bound_port)` and consulted by the SSH client handler when
/// the server hands over a `forwarded-tcpip` channel.
pub type RemoteForwardTable = Mutex<HashMap<(String, u32), forward::RelayTarget>>;
