use super::*;

/// Host-key challenges wait up to this long for a decision; the value also
/// caps how far the dial deadline may be pushed out while a challenge runs.
pub(super) const HOST_KEY_CHALLENGE_WAIT: Duration = Duration::from_secs(300);

/// Response payload for `ssh/host-key/check`. Split from the probe path so
/// the state mapping is unit-testable without a server.
pub(super) fn host_key_check_response(
    verdict: &HostKeyVerdict,
    key_type: &str,
    fingerprint: &str,
) -> Value {
    let state = match verdict {
        HostKeyVerdict::Trusted => "trusted",
        HostKeyVerdict::Unknown => "unknown",
        HostKeyVerdict::Changed(_) => "changed",
    };
    json!({
        "state": state,
        "keyType": key_type,
        "fingerprint": fingerprint,
    })
}

pub(super) fn host_key_unreachable_response(error: String) -> Value {
    json!({ "state": "unreachable", "error": error })
}

/// Host-side RPC deadline fallback for `connection/test` when the stored
/// connection omits `connect_timeout_secs`: the host materializes 0/absent
/// via dbx-core `default_connect_timeout_secs()` = 10s
/// (crates/dbx-core/src/models/connection.rs:501) — NOT this plugin's
/// manifest default of 30s. Keep in sync with the host.
const HOST_FALLBACK_CONNECT_TIMEOUT_SECS: u64 = 10;

/// `connection/test` dial budget: the host kills the RPC at the effective
/// connect timeout, so the sidecar must answer one second earlier (the
/// margin covers stdio write→parse→dispatch latency), floored at 1s. An
/// explicit `connect_timeout_secs` is the deadline itself; an absent one
/// means the host falls back to its own 10s default.
pub(super) fn test_dial_budget_secs(connect_timeout_secs: u64, explicit: bool) -> u64 {
    let deadline = if explicit {
        connect_timeout_secs.max(1)
    } else {
        HOST_FALLBACK_CONNECT_TIMEOUT_SECS
    };
    deadline.saturating_sub(1).max(1)
}

/// Re-arm decision for the `connection/test` budget once it elapsed: a host
/// dialog keeps the probe parked past the mirrored dial budget, so when the
/// dialog path is serving the challenge the budget extends once by the
/// challenge wait plus the connect timeout. Every other timeout (1.0 hosts,
/// workbench fallback, already-extended window) returns `None` and keeps the
/// readable error. Callers fold the already-extended state into
/// `dialog_used` so the extension can only arm a single time.
pub(super) fn next_test_budget(connect_timeout_secs: u64, dialog_used: bool) -> Option<u64> {
    dialog_used.then(|| {
        HOST_KEY_CHALLENGE_WAIT
            .as_secs()
            .saturating_add(connect_timeout_secs)
    })
}

/// Actionable `connection/test` timeout: the cryptic host RPC-timeout
/// message gave no remedy; this names the effective budget (flagged as the
/// host default when the field was absent) plus the user-side fix. When a
/// host-key confirmation was raised during the probe, the challenge note is
/// appended in addition to the timeout-setting remedy — and only when the
/// dialog path did not serve the challenge, so the "update DBX" advice stays
/// truthful for 1.0 hosts.
pub(super) fn test_timeout_message(
    host: &str,
    port: u16,
    budget_secs: u64,
    host_default: bool,
    challenge_raised: bool,
) -> String {
    let source = if host_default { " (host default)" } else { "" };
    let mut message = format!(
        "SSH connection to {host}:{port} timed out after {budget_secs} seconds{source}. Increase 'SSH timeout' under Advanced options and retry."
    );
    if challenge_raised {
        message.push_str(
            " A host-key confirmation was raised but went unanswered; connect once from the SSH workbench to trust this host, or update DBX to 0.6.17+ so the confirmation can appear here.",
        );
    }
    message
}
