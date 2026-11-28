use super::*;

/// Explicit users of one authenticated SSH transport: every registered
/// session owns one use, and a copied session reserves one before its first
/// await. That pending reservation closes the open/close race where the last
/// old session could otherwise tear down a jump chain while the new PTY was
/// still being created.
pub(super) struct TransportLeaseCounter(AtomicUsize);

/// `#[allow(deprecated)]`: the newest stable renamed `fetch_update` to
/// `try_update` (cosmetic; semantics unchanged). Calling the new name would
/// hard-break every older rustc (including the 1.88 floor), so keep the old
/// name until the toolchain floor moves past the renaming release.
#[allow(deprecated)]
impl TransportLeaseCounter {
    pub(super) fn new() -> Self {
        Self(AtomicUsize::new(1))
    }

    pub(super) fn retain(&self) {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .expect("SSH transport lease count overflow");
    }

    /// Returns true when the released use was the final one.
    pub(super) fn release(&self) -> bool {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_sub(1)
            })
            .expect("SSH transport lease released more than once")
            == 1
    }

    #[cfg(test)]
    pub(super) fn count(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
}

pub(super) struct SharedTransportLease {
    pub(super) uses: TransportLeaseCounter,
    pub(super) jump_chain: Vec<Arc<Handle<SshClient>>>,
}

impl SharedTransportLease {
    pub(super) fn new(jump_chain: Vec<Arc<Handle<SshClient>>>) -> Self {
        Self {
            uses: TransportLeaseCounter::new(),
            jump_chain,
        }
    }

    pub(super) fn retain(&self) {
        self.uses.retain();
    }

    pub(super) async fn release(&self) {
        if !self.uses.release() {
            return;
        }
        for jump in &self.jump_chain {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH session closed",
                    "English",
                )
                .await;
        }
    }
}
