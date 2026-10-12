//! 证书链路（rdp-security-review B4/§3-C）：已知证书存储（落盘
//! rdp-known-certs.json）、指纹线制格式、120s fail-closed 提示代理与
//! vendored TLS 校验器适配。
use super::security::CertPolicy;
use super::session::unix_now_secs;
use data_encoding::HEXLOWER;
use dbx_plugin_sdk::PluginEmitter;
use ironrdp::client::config::{ServerCertificateVerifier, ServerCertificateVerifyFuture};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::oneshot;

/// Certificate-prompt window (checklist §3-C: 120s, reject on timeout).
pub(crate) const CERTIFICATE_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
/// Known-certificate store bound (B4); eviction drops the genuinely oldest
/// entries by insertion time.
pub(crate) const KNOWN_CERTS_MAX_ENTRIES: usize = 1024;

/// Known-certificate check outcome for one host:port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownCertStatus {
    Match,
    Changed,
    Unknown,
}

impl KnownCertStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::Changed => "changed",
            Self::Unknown => "unknown",
        }
    }
}

/// Certificate policy decision without a prompt (NyaTerm
/// `certificate_policy_allows_without_prompt`).
pub(crate) fn certificate_allows_without_prompt(
    policy: CertPolicy,
    status: KnownCertStatus,
) -> Result<bool, String> {
    match policy {
        CertPolicy::Strict => match status {
            KnownCertStatus::Match => Ok(true),
            KnownCertStatus::Unknown => Err("unknown certificate".to_string()),
            KnownCertStatus::Changed => Err("certificate fingerprint changed".to_string()),
        },
        CertPolicy::AcceptTemporarily => Ok(true),
        CertPolicy::Prompt => Ok(status == KnownCertStatus::Match),
    }
}

/// SHA-256 fingerprint in the NyaTerm wire form (`SHA256:<hex>`).
pub(crate) fn certificate_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    format!("SHA256:{}", HEXLOWER.encode(&digest))
}

pub(crate) fn cert_key(host: &str, port: u16) -> String {
    // Hostnames are case-insensitive: normalize so `RDP.local` and
    // `rdp.local` share one entry (rdp-security-review B4 次要 — otherwise
    // a case flip silently re-prompts, fail-closed but lossy).
    format!("{}:{port}", host.to_ascii_lowercase())
}

/// Status of `fingerprint` against the remembered store for host:port.
pub(crate) fn known_cert_status(
    store: &HashMap<String, String>,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> KnownCertStatus {
    match store.get(&cert_key(host, port)) {
        Some(stored) if stored == fingerprint => KnownCertStatus::Match,
        Some(_) => KnownCertStatus::Changed,
        None => KnownCertStatus::Unknown,
    }
}

/// Disk-backed known-certificate store (`rdp-known-certs.json`), shaped like
/// the SSH known-hosts precedent, bounded at 1024 entries, atomic tmp+rename
/// writes with a per-call unique tmp name (B4, rdp-security-review: a fixed
/// tmp name let concurrent remember() calls clobber each other's
/// intermediate file). Fingerprint persistence only — never certificate
/// contents, never credentials.
#[derive(Clone)]
pub(crate) struct KnownCertStore {
    pub(crate) path: PathBuf,
}

/// One disk entry: fingerprint plus insertion timestamp, so eviction can
/// drop the genuinely oldest keys (B4: the previous implementation took the
/// lexicographically smallest key, which could evict a hot host at random).
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct KnownCertEntry {
    pub(crate) fingerprint: String,
    pub(crate) inserted_at: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct KnownCertFile {
    entries: HashMap<String, KnownCertEntry>,
}

/// Backward-compatible disk shape: the pre-B4 flat map
/// `{"host:port": "SHA256:hex"}` and the current `{"entries": …}` envelope.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum KnownCertFileShape {
    V2(KnownCertFile),
    /// Legacy flat shape; entries are treated as inserted at 0, i.e. evicted
    /// first (safe direction).
    V1(HashMap<String, String>),
}

/// Drop the oldest entries (by `inserted_at`, ties broken by key for
/// determinism) until the store fits the cap. Pure — unit-tested.
pub(crate) fn prune_oldest_entries(store: &mut HashMap<String, KnownCertEntry>, cap: usize) {
    while store.len() > cap {
        let oldest = store
            .iter()
            .min_by(|(key_a, entry_a), (key_b, entry_b)| {
                entry_a
                    .inserted_at
                    .cmp(&entry_b.inserted_at)
                    .then_with(|| key_a.cmp(key_b))
            })
            .map(|(key, _)| key.clone());
        match oldest {
            Some(key) => {
                store.remove(&key);
            }
            None => break,
        }
    }
}

impl KnownCertStore {
    pub(crate) fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("rdp-known-certs.json"),
        }
    }

    pub(crate) fn load_entries(&self) -> HashMap<String, KnownCertEntry> {
        let text = std::fs::read_to_string(&self.path).unwrap_or_default();
        match serde_json::from_str::<KnownCertFileShape>(&text) {
            Ok(KnownCertFileShape::V2(file)) => file.entries,
            // Corrupt file → empty store (fail-closed: the next connect
            // re-prompts). Same for the legacy flat shape with per-entry
            // inserted_at = 0.
            Ok(KnownCertFileShape::V1(flat)) => flat
                .into_iter()
                .map(|(key, fingerprint)| {
                    (
                        key,
                        KnownCertEntry {
                            fingerprint,
                            inserted_at: 0,
                        },
                    )
                })
                .collect(),
            Err(_) => HashMap::new(),
        }
    }

    pub(crate) fn check(&self, host: &str, port: u16, fingerprint: &str) -> KnownCertStatus {
        let store: HashMap<String, String> = self
            .load_entries()
            .into_iter()
            .map(|(key, entry)| (key, entry.fingerprint))
            .collect();
        known_cert_status(&store, host, port, fingerprint)
    }

    pub(crate) fn remember(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        self.remember_at(host, port, fingerprint, unix_now_secs())
    }

    pub(crate) fn remember_at(
        &self,
        host: &str,
        port: u16,
        fingerprint: &str,
        inserted_at: u64,
    ) -> Result<(), String> {
        let mut store = self.load_entries();
        store.insert(
            cert_key(host, port),
            KnownCertEntry {
                fingerprint: fingerprint.to_string(),
                inserted_at,
            },
        );
        prune_oldest_entries(&mut store, KNOWN_CERTS_MAX_ENTRIES);
        let text = serde_json::to_string(&KnownCertFile { entries: store })
            .map_err(|error| format!("failed to encode known certificates: {error}"))?;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Unique tmp name per call (B4): concurrent remember() calls must
        // not share one intermediate file. Residual window: two concurrent
        // remembers can still race the final rename (last writer wins
        // wholesale); the worst case is a forgotten entry → re-prompt,
        // fail-closed.
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "known-certificate store path is invalid".to_string())?;
        let tmp = self
            .path
            .with_file_name(format!("{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, text)
            .map_err(|error| format!("failed to write known certificates: {error}"))?;
        std::fs::rename(&tmp, &self.path)
            .map_err(|error| format!("failed to persist known certificates: {error}"))
    }
}

// —— certificate prompt broker (120s window, generation-guarded) ——

#[derive(Debug, Clone, Copy)]
pub(crate) struct CertDecision {
    pub(crate) accept: bool,
    pub(crate) remember: bool,
}

pub(crate) struct PendingCertPrompt {
    session_id: String,
    responder: oneshot::Sender<CertDecision>,
}

/// Workbench-event broker for the certificate confirmation, mirroring the
/// SSH host-key PromptBroker shape: one `connection/challenge` event with
/// `kind: "rdp-certificate"`, resolved by `rdp/certificate/resolve`. The
/// caller enforces the 120s window; timeout resolves to rejection
/// (fail-closed).
#[derive(Default)]
pub(crate) struct CertPromptBroker {
    pub(crate) pending: StdMutex<HashMap<String, PendingCertPrompt>>,
}

impl CertPromptBroker {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) async fn request(
        &self,
        emitter: &PluginEmitter,
        session_id: &str,
        host: &str,
        port: u16,
        fingerprint: &str,
        known_host_status: KnownCertStatus,
    ) -> Option<CertDecision> {
        let challenge_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().ok()?;
            pending.insert(
                challenge_id.clone(),
                PendingCertPrompt {
                    session_id: session_id.to_string(),
                    responder: sender,
                },
            );
        }
        let emitted = emitter.event(
            "connection/challenge",
            json!({
                "challengeId": challenge_id,
                "kind": "rdp-certificate",
                "sessionId": session_id,
                "host": host,
                "port": port,
                "fingerprint": fingerprint,
                "knownHostStatus": known_host_status.as_str(),
            }),
        );
        if emitted.is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&challenge_id);
            }
            return None;
        }
        let decision = tokio::time::timeout(CERTIFICATE_PROMPT_TIMEOUT, receiver)
            .await
            .ok()
            .and_then(|answer| answer.ok());
        // Remove whatever is left (timeout/dropped answer) so a late resolve
        // cannot succeed after the window closed.
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&challenge_id);
        }
        decision
    }

    pub(crate) fn resolve(
        &self,
        challenge_id: &str,
        accept: bool,
        remember: bool,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "certificate prompt registry is poisoned".to_string())?
            .remove(challenge_id)
            .ok_or_else(|| {
                "RDP certificate challenge was not found or already resolved".to_string()
            })?;
        let _ = pending.responder.send(CertDecision { accept, remember });
        Ok(())
    }

    /// Close/reconnect teardown: answer every pending prompt of the session
    /// with a rejection so the verifier cannot park on a dead session.
    pub(crate) fn cancel_session(&self, session_id: &str) {
        let responders: Vec<oneshot::Sender<CertDecision>> = match self.pending.lock() {
            Ok(mut pending) => {
                let stale: Vec<String> = pending
                    .iter()
                    .filter(|(_, prompt)| prompt.session_id == session_id)
                    .map(|(id, _)| id.clone())
                    .collect();
                stale
                    .iter()
                    .filter_map(|id| pending.remove(id))
                    .map(|prompt| prompt.responder)
                    .collect()
            }
            Err(_) => return,
        };
        for responder in responders {
            let _ = responder.send(CertDecision {
                accept: false,
                remember: false,
            });
        }
    }
}

/// The `ServerCertificateVerifier` injected into the vendored client.
/// Fail-closed by construction: remembered match (any policy), explicit
/// accept-temporarily, or a resolved prompt — everything else errors.
pub(crate) struct RdpCertificateVerifier {
    pub(crate) emitter: PluginEmitter,
    pub(crate) broker: Arc<CertPromptBroker>,
    pub(crate) known_certs: KnownCertStore,
    pub(crate) session_id: String,
    pub(crate) policy: CertPolicy,
    /// Session-wide generation counter; the verifier rejects when the
    /// generation moved (close/reconnect) before or after the prompt.
    pub(crate) generation: Arc<AtomicU64>,
    pub(crate) own_generation: u64,
    /// 证书确认等待期标记：进入 broker.request（120s 用户确认窗）前置位、
    /// 离开清零。会话 pump 的首帧前连接进度预算据此豁免该静默等待。
    pub(crate) cert_wait: Arc<AtomicBool>,
}

impl std::fmt::Debug for RdpCertificateVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Identifiers only — never the emitter's writer or any credential.
        f.debug_struct("RdpCertificateVerifier")
            .field("session_id", &self.session_id)
            .field("generation", &self.own_generation)
            .field("cert_wait", &self.cert_wait.load(Ordering::Acquire))
            .finish()
    }
}

impl RdpCertificateVerifier {
    fn stale(&self) -> bool {
        self.generation.load(Ordering::Acquire) != self.own_generation
    }

    async fn verify(&self, host: &str, port: u16, der: &[u8]) -> Result<(), String> {
        if self.stale() {
            return Err("certificate rejected: stale RDP connection generation".to_string());
        }
        let fingerprint = certificate_fingerprint(der);
        let status = self.known_certs.check(host, port, &fingerprint);
        match certificate_allows_without_prompt(self.policy, status)? {
            true => Ok(()),
            false => {
                // 等待窗标记：pump 的连接进度预算据此豁免 120s 用户确认。
                self.cert_wait.store(true, Ordering::Release);
                let answered = self
                    .broker
                    .request(
                        &self.emitter,
                        &self.session_id,
                        host,
                        port,
                        &fingerprint,
                        status,
                    )
                    .await;
                self.cert_wait.store(false, Ordering::Release);
                let decision = answered.ok_or_else(|| "certificate rejected".to_string())?;
                // A close/reconnect must not let a prompt decision carry
                // across generations.
                if self.stale() {
                    return Err("certificate rejected: stale RDP connection generation".to_string());
                }
                if !decision.accept {
                    return Err("certificate rejected".to_string());
                }
                if decision.remember {
                    self.known_certs.remember(host, port, &fingerprint)?;
                }
                Ok(())
            }
        }
    }
}

impl ServerCertificateVerifier for RdpCertificateVerifier {
    fn verify_server_certificate<'a>(
        &'a self,
        host: &'a str,
        port: u16,
        der: Vec<u8>,
    ) -> ServerCertificateVerifyFuture<'a> {
        Box::pin(async move { self.verify(host, port, &der).await })
    }
}
