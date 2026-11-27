use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;

use crate::host_key::HostKeyVerifier;

use super::prompt::PromptBroker;
use super::transport::RemoteForwardTable;
use super::*;

/// Shared dial deadline. While a host-key challenge waits for the user, the
/// dial timeout budget is suspended so the SSH connect future is not killed
/// underneath the confirmation dialog.
#[derive(Default)]
pub(super) struct DialDeadline {
    deadline_ms: AtomicU64,
    challenge_pending: AtomicBool,
}

impl DialDeadline {
    pub(super) fn start(timeout: Duration) -> Arc<Self> {
        let state = Arc::new(Self::default());
        state.deadline_ms.store(
            Self::epoch_ms() + timeout.as_millis() as u64,
            Ordering::SeqCst,
        );
        state
    }

    fn epoch_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0)
    }

    fn enter_challenge(&self, extra: Duration) {
        self.challenge_pending.store(true, Ordering::SeqCst);
        self.deadline_ms.store(
            Self::epoch_ms() + extra.as_millis() as u64,
            Ordering::SeqCst,
        );
    }

    fn exit_challenge(&self, timeout: Duration) {
        self.challenge_pending.store(false, Ordering::SeqCst);
        self.deadline_ms.store(
            Self::epoch_ms() + timeout.as_millis() as u64,
            Ordering::SeqCst,
        );
    }

    pub(super) fn remaining(&self) -> Option<Duration> {
        let now = Self::epoch_ms();
        let deadline = self.deadline_ms.load(Ordering::SeqCst);
        deadline.checked_sub(now).map(Duration::from_millis)
    }
}

pub struct SshClient {
    pub(super) verifier: Arc<HostKeyVerifier>,
    pub(super) prompts: PromptBroker,
    /// Event emitter; `None` in MCP stdio mode where stdout belongs to the
    /// JSON-RPC protocol and unknown host keys are trusted on first use.
    pub(super) emitter: Option<PluginEmitter>,
    pub(super) auto_trust: bool,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) connection_id: String,
    pub(super) operation_id: String,
    pub(super) dial_deadline: Arc<DialDeadline>,
    pub(super) connect_timeout: Duration,
    /// Remote (-R) port mappings of this connection: `(listen_host,
    /// bound_port) -> local dial target`. Populated by `ssh/forward/start`
    /// and consulted by the forwarded-tcpip handler below; per-connection so
    /// two servers can forward the same port independently.
    pub(super) remote_forwards: Arc<RemoteForwardTable>,
}

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match self
            .verifier
            .check(&self.host, self.port, server_public_key)
        {
            Ok(HostKeyState::Trusted) => {
                eprintln!(
                    "[ssh-trace] host-key trusted {}:{}, fingerprint ok",
                    self.host, self.port
                );
                Ok(true)
            }
            Ok(HostKeyState::Unknown) => {
                eprintln!(
                    "[ssh-trace] host-key unknown {}:{} (auto_trust={})",
                    self.host, self.port, self.auto_trust
                );
                if self.auto_trust {
                    // Trust-on-first-use for MCP mode: keys land in the same
                    // known_hosts store and changes are still rejected.
                    if let Err(error) =
                        self.verifier
                            .learn(&self.host, self.port, server_public_key)
                    {
                        eprintln!("[ssh-sftp-plugin] failed to record host key: {error}");
                    }
                    return Ok(true);
                }
                let Some(emitter) = self.emitter.as_ref() else {
                    eprintln!("[ssh-trace] host-key unknown and no emitter -> reject");
                    return Ok(false);
                };
                // The user may take arbitrarily long to confirm the
                // fingerprint; that wait must not consume the dial timeout.
                self.dial_deadline
                    .enter_challenge(HOST_KEY_CHALLENGE_WAIT + self.connect_timeout);
                eprintln!("[ssh-trace] host-key challenge raised, waiting for user decision");
                let decision = self
                    .prompts
                    .request(
                        &self.host,
                        self.port,
                        server_public_key.algorithm().to_string(),
                        server_public_key.fingerprint(HashAlg::Sha256).to_string(),
                        &self.connection_id,
                        &self.operation_id,
                        emitter,
                    )
                    .await;
                self.dial_deadline.exit_challenge(self.connect_timeout);
                eprintln!(
                    "[ssh-trace] host-key challenge resolved: present={} accept={:?} remember={:?}",
                    decision.is_some(),
                    decision.as_ref().map(|d| d.accept),
                    decision.as_ref().map(|d| d.remember)
                );
                let Some(decision) = decision else {
                    return Ok(false);
                };
                if !decision.accept {
                    return Ok(false);
                }
                if decision.remember {
                    if let Err(error) =
                        self.verifier
                            .learn(&self.host, self.port, server_public_key)
                    {
                        let _ = emitter.event(
                            "ssh/host-key/notice",
                            json!({ "kind": "learn-failed", "message": error.to_string() }),
                        );
                    }
                }
                Ok(true)
            }
            Err(error) => {
                eprintln!(
                    "[ssh-trace] host-key CHANGED for {}:{}: {error}",
                    self.host, self.port
                );
                if let Some(emitter) = self.emitter.as_ref() {
                    let _ = emitter.event(
                        "ssh/host-key/notice",
                        json!({ "kind": "changed", "message": error.to_string() }),
                    );
                }
                Err(russh::Error::from(error))
            }
        }
    }

    /// Incoming `forwarded-tcpip` channel: the server accepted a connection
    /// on a port this side registered with `tcpip-forward` (remote -R
    /// mapping). The local dial target is looked up in this connection's
    /// remote-forward table; the relay runs detached so the handler returns
    /// immediately and the SSH reader is never blocked by user traffic.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = originator_address;
        let _ = originator_port;
        let _ = session;
        let target =
            forward::lookup_remote_target(&self.remote_forwards, connected_address, connected_port);
        let Some(target) = target else {
            eprintln!(
                "[ssh-forward] forwarded-tcpip {connected_address}:{connected_port} has no registered mapping; rejecting"
            );
            reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        // Dial from the client machine; on failure the channel is dropped,
        // which the server surfaces as a closed connection to its client.
        match TcpStream::connect((target.host.as_str(), target.port)).await {
            Ok(tcp) => {
                // 计数与句柄登记走 forward 侧统一入口：relay 进 entry.relays，
                // stop/会话关闭才能中止它（此前 detach 的 relay 会躲过 abort，
                // 挂死连接一直存活到通道自然终结）。
                forward::spawn_remote_relay(target.entry, channel, tcp);
            }
            Err(error) => {
                eprintln!(
                    "[ssh-forward] local dial {}:{} failed: {error}",
                    target.host, target.port
                );
            }
        }
        Ok(())
    }

    /// Incoming `x11` channel: the server accepted the `x11-req` sent when
    /// the shell opened and a remote X client connected. russh's default
    /// handler accepts unconditionally, so this override is the fail-closed
    /// boundary (docs/SPIKE_X11_FORWARDING.zh-CN.md §3.4): the armed-session
    /// gate must admit the channel and the X setup block must carry the
    /// issued fake cookie before a single byte is relayed to the local
    /// display. SSH delivers channel data only after the open is confirmed,
    /// so the channel is accepted first and then held (nothing relayed)
    /// until the setup block validates; a mismatch closes it immediately.
    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = (originator_address, originator_port, session);
        // Admission first: no armed gate (X11 off or the last session
        // closed) or the armed gate's bridge cap exhausted -> reject, never
        // accept.
        let Some((cookie, permit)) = crate::x11::try_admit_active() else {
            eprintln!("[x11] channel refused: no armed gate or the bridge cap is exhausted");
            reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        // The relay runs detached so the SSH reader is never blocked by X
        // traffic; the admission permit travels with the task and frees its
        // cap slot whenever the task ends.
        tokio::spawn(async move {
            // Keeping the admission permit alive for the bridge's lifetime
            // holds the cap slot; its Drop frees the slot whenever this
            // task ends (bridge finished, setup rejected, or channel gone).
            let _bridge_permit = permit;
            let mut channel = channel;
            let mut buffer = crate::x11::SetupBuffer::default();
            let verdict = loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data }) => match buffer.push(&data, &cookie) {
                        crate::x11::SetupInspection::Incomplete => continue,
                        verdict => break verdict,
                    },
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                        break crate::x11::SetupInspection::Reject(
                            "x11 channel closed before the X setup block arrived",
                        );
                    }
                    Some(_) => continue,
                }
            };
            match verdict {
                crate::x11::SetupInspection::Accept { cookie_offset } => {
                    let mut setup = buffer.into_bytes();
                    let target = crate::x11::current_display_target();
                    crate::x11::substitute_cookie(
                        &mut setup,
                        cookie_offset,
                        crate::x11::load_real_cookie(&target).as_deref(),
                    );
                    if let Err(error) = crate::x11::bridge_channel(channel, &target, setup).await {
                        eprintln!("[x11] {error}");
                    }
                }
                crate::x11::SetupInspection::Reject(reason) => {
                    eprintln!("[x11] x11 channel rejected: {reason}");
                    let _ = channel.close().await;
                }
                crate::x11::SetupInspection::Incomplete => {
                    unreachable!("the setup loop only breaks on a final verdict")
                }
            }
        });
        Ok(())
    }
}

/// Verdict of a key-exchange-only host-key probe against the known_hosts
/// stores.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum HostKeyVerdict {
    Trusted,
    Unknown,
    /// A recorded key differs from the presented one; carries the
    /// verifier's explanation (possible man-in-the-middle).
    Changed(String),
}

pub(super) fn host_key_verdict(check: Result<HostKeyState, std::io::Error>) -> HostKeyVerdict {
    match check {
        Ok(HostKeyState::Trusted) => HostKeyVerdict::Trusted,
        Ok(HostKeyState::Unknown) => HostKeyVerdict::Unknown,
        Err(error) => HostKeyVerdict::Changed(error.to_string()),
    }
}

/// Key-exchange-only probe handler (tiny-rdm's CheckHostKey equivalent):
/// the server key is fingerprinted and compared against the known_hosts
/// stores, then the handshake is aborted with `Ok(false)` so no
/// authentication, challenge, or session ever happens. Deliberately not
/// `SshClient`, whose check_server_key would raise a host-key challenge.
pub(super) struct HostKeyProbe {
    pub(super) verifier: Arc<HostKeyVerifier>,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) seen: Arc<Mutex<Option<(HostKeyVerdict, String, String)>>>,
}

impl client::Handler for HostKeyProbe {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let verdict = host_key_verdict(self.verifier.check(
            &self.host,
            self.port,
            server_public_key,
        ));
        if let Ok(mut slot) = self.seen.lock() {
            *slot = Some((
                verdict,
                server_public_key.algorithm().to_string(),
                server_public_key.fingerprint(HashAlg::Sha256).to_string(),
            ));
        }
        // Abort before authentication; russh surfaces this as
        // Error::UnknownKey and tears the transport down on drop.
        Ok(false)
    }
}

#[derive(Default)]
pub(super) struct DirectoryHandshakeFilter {
    marker: Option<Vec<u8>>,
    buffered: Vec<u8>,
    started_at: Option<Instant>,
    failed: bool,
}

impl DirectoryHandshakeFilter {
    pub(super) fn begin(&mut self, marker: Vec<u8>) {
        self.marker = Some(marker);
        self.buffered.clear();
        self.started_at = Some(Instant::now());
        self.failed = false;
    }

    pub(super) fn filter(&mut self, data: &[u8]) -> Option<Vec<u8>> {
        let Some(marker) = self.marker.as_ref() else {
            return Some(data.to_vec());
        };
        self.buffered.extend_from_slice(data);
        if self.buffered.len() > DIRECTORY_HANDSHAKE_LIMIT {
            return self.fail_open();
        }
        let index = find_bytes(&self.buffered, marker)?;
        let result = self.buffered[index + marker.len()..].to_vec();
        self.marker = None;
        self.buffered.clear();
        self.started_at = None;
        (!result.is_empty()).then_some(result)
    }

    pub(super) fn flush_if_timed_out(&mut self) -> Option<Vec<u8>> {
        if self
            .started_at
            .is_some_and(|started| started.elapsed() >= DIRECTORY_HANDSHAKE_TIMEOUT)
        {
            return self.fail_open();
        }
        None
    }

    pub(super) fn take_failed(&mut self) -> bool {
        std::mem::take(&mut self.failed)
    }

    fn fail_open(&mut self) -> Option<Vec<u8>> {
        self.marker = None;
        self.started_at = None;
        self.failed = true;
        let buffered = std::mem::take(&mut self.buffered);
        (!buffered.is_empty()).then_some(buffered)
    }
}
