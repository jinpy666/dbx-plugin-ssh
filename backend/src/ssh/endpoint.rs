use super::*;

/// Read-only connection display info resolved from the connections registry
/// for a session row. Empty host/user means the connection is no longer
/// registered (sidecar restarted after the workbench attached).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
}

impl ConnectionEndpoint {
    pub fn fallback() -> Self {
        Self {
            host: String::new(),
            port: 22,
            username: String::new(),
        }
    }
}
/// Execution transport for the scheduler task provider: either the live
/// session's shared authenticated handle (borrowed lifetime of the session)
/// or a dedicated headless dial (owned; disconnected on release).
pub(crate) enum TaskTransport {
    Session {
        handle: Arc<Handle<SshClient>>,
    },
    Dedicated {
        handle: Handle<SshClient>,
        jumps: Vec<Handle<SshClient>>,
    },
}

impl TaskTransport {
    pub(crate) fn handle(&self) -> &Handle<SshClient> {
        match self {
            Self::Session { handle } => handle,
            Self::Dedicated { handle, .. } => handle,
        }
    }

    /// Tears down a dedicated dial (jump chain included). Session-borrowed
    /// transports are left alone — the workbench owns their lifecycle.
    pub(crate) async fn release(self) {
        if let Self::Dedicated { handle, jumps } = self {
            let _ = handle
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX scheduled task finished",
                    "English",
                )
                .await;
            for jump in jumps {
                let _ = jump
                    .disconnect(
                        Disconnect::ByApplication,
                        "DBX scheduled task jump closed",
                        "English",
                    )
                    .await;
            }
        }
    }
}
