use super::*;

/// Outcome of trying every identity the SSH Agent offers for one connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AgentAuthOutcome {
    Accepted,
    /// The server accepted an identity but still demands keyboard-interactive
    /// (MFA), so the caller must continue the handshake instead of reporting
    /// "no identity was accepted".
    NeedsKeyboardInteractive,
    /// No identity was accepted; the payload is the rejection reason planned
    /// by [`plan_agent_identity_attempt`] (first transport error verbatim, or
    /// the MaxAuthTries budget message).
    Rejected(String),
}

/// Plans the next agent-identity attempt against the MaxAuthTries budget.
/// Budget derivation: OpenSSH MaxAuthTries defaults to 6 *total* failures
/// including the leading none probe (ssh.rs:2456), so identity attempts
/// get 5.
pub(super) const AGENT_IDENTITY_MAX_ATTEMPTS: usize = 5;

/// Decision of [`plan_agent_identity_attempt`] for the next agent identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AgentPlan {
    /// Try the next identity in the queue.
    TryNext,
    /// Stop and reject with this message.
    StopRejection(String),
    /// Stop because an identity was accepted and the server still demands
    /// keyboard-interactive (MFA) — the caller must continue the handshake.
    StopPartialSuccess,
}

/// Pure planner for the agent-identity loop: decides what to do after one
/// identity attempt without touching the session or the agent. Drives the
/// runtime loop in `authenticate_agent`; the tests below fix the contract
/// (attempt budget, first transport error stops, partial success + KI
/// advertisement stops).
///
/// - A transport-level `last_error` is terminal for *every* identity: all of
///   them share the same agent handle, so the first failure leaves no
///   recoverable path and burning further identities just wastes the
///   MaxAuthTries budget.
/// - A partial success advertises keyboard-interactive is the koko/PAM 2FA
///   shape: the identity was accepted and only the second factor is owed, so
///   trying more identities can never improve the outcome.
/// - A full rejection just moves to the next identity while budget remains.
///   During per-identity attempts the server's advertised method set does not
///   change, so a publickey rejection never implies "publickey withdrawn".
/// - `AuthResult::Success` never reaches the planner (the caller returns).
pub(super) fn plan_agent_identity_attempt(
    attempts_so_far: usize,
    last_result: Option<&AuthResult>,
    last_error: Option<&str>,
) -> AgentPlan {
    // The first transport error is final: every remaining identity would
    // re-dial the same dead agent handle.
    if let Some(error) = last_error {
        return AgentPlan::StopRejection(error.to_string());
    }
    if let Some(result) = last_result {
        if auth_partial_success(result) && method_offered(result, MethodKind::KeyboardInteractive) {
            return AgentPlan::StopPartialSuccess;
        }
    }
    if attempts_so_far >= AGENT_IDENTITY_MAX_ATTEMPTS {
        // MaxAuthTries is a *total* budget (the leading none probe already
        // spent one): once the identity budget is exhausted the server has
        // usually already dropped the connection, and further attempts would
        // only surface as confusing transport errors.
        return AgentPlan::StopRejection(
            "server may have disconnected after too many auth attempts (MaxAuthTries); \
             consider specifying a private key"
                .to_string(),
        );
    }
    AgentPlan::TryNext
}

pub(super) async fn authenticate_agent(
    session: &mut Handle<SshClient>,
    connection: &StoredConnection,
) -> Result<AgentAuthOutcome, String> {
    #[cfg(unix)]
    let mut agent = if connection.agent_socket.is_empty() {
        AgentClient::connect_env()
            .await
            .map_err(|error| format!("SSH Agent is unavailable: {error}"))?
    } else {
        AgentClient::connect_uds(&connection.agent_socket)
            .await
            .map_err(|error| {
                format!(
                    "SSH Agent at '{}' is unavailable: {error}",
                    connection.agent_socket
                )
            })?
    };

    #[cfg(windows)]
    let mut agent = {
        let stream = pageant::PageantStream::new()
            .await
            .map_err(|error| format!("Windows Pageant is unavailable: {error}"))?;
        AgentClient::connect(stream)
    };

    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("Failed to list SSH Agent identities: {error}"))?;
    if identities.is_empty() {
        return Err("SSH Agent has no identities".to_string());
    }
    let hash = session
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let outcome = tokio::time::timeout(
        Duration::from_secs(connection.connect_timeout_secs),
        async {
            // Planner-driven identity loop: every round consults
            // [`plan_agent_identity_attempt`] before spending another
            // MaxAuthTries slot, so a transport error or a partial success
            // advertising keyboard-interactive stops the queue immediately
            // instead of burning the remaining budget.
            let mut attempts: usize = 0;
            let mut last_result: Option<AuthResult> = None;
            let mut last_error: Option<String> = None;
            let mut identities = identities.into_iter();
            loop {
                match plan_agent_identity_attempt(
                    attempts,
                    last_result.as_ref(),
                    last_error.as_deref(),
                ) {
                    AgentPlan::TryNext => {}
                    AgentPlan::StopPartialSuccess => {
                        return AgentAuthOutcome::NeedsKeyboardInteractive;
                    }
                    AgentPlan::StopRejection(reason) => {
                        return AgentAuthOutcome::Rejected(reason);
                    }
                }
                let Some(identity) = identities.next() else {
                    // The identity queue drained while the planner still said
                    // TryNext (fewer identities than the budget): keep the
                    // historical generic rejection text for this shape.
                    return AgentAuthOutcome::Rejected(
                        "No SSH Agent identity was accepted".to_string(),
                    );
                };
                attempts += 1;
                let result = match &identity {
                    AgentIdentity::PublicKey { key, .. } => {
                        session
                            .authenticate_publickey_with(
                                &connection.username,
                                key.clone(),
                                hash,
                                &mut agent,
                            )
                            .await
                    }
                    AgentIdentity::Certificate { certificate, .. } => {
                        session
                            .authenticate_certificate_with(
                                &connection.username,
                                certificate.clone(),
                                hash,
                                &mut agent,
                            )
                            .await
                    }
                };
                match result {
                    Ok(result) if result.success() => return AgentAuthOutcome::Accepted,
                    Ok(result) => last_result = Some(result),
                    // Every identity shares one agent handle: the first
                    // transport error is terminal, and the planner surfaces
                    // its text verbatim on the next round.
                    Err(error) => last_error = Some(error.to_string()),
                }
            }
        },
    )
    .await
    .map_err(|_| "SSH Agent authentication timed out".to_string())?;
    Ok(outcome)
}
