use super::*;

/// Default wait for an agent approval decision, clamped to the 10-300
/// seconds band (the same shape as the exec timeout clamps).
const AGENT_APPROVAL_DEFAULT_SECS: u64 = 120;
const AGENT_APPROVAL_MIN_SECS: u64 = 10;
const AGENT_APPROVAL_MAX_SECS: u64 = 300;
/// Fixed wait for the MCP confirm permission gate (IMPL_PLAN §1.3: 120s,
/// clamped 10–300 by design for any future configurability).
const MCP_CONFIRM_TIMEOUT_SECS: u64 = 120;

impl SshRuntime {
    /// Pure builder for the MCP confirm challenge payload (IMPL_PLAN §1.3):
    /// the shared `ssh/agent/prompt` event with `kind: "mcp-confirm"` and
    /// `source: "mcp"` (legacy terminal approvals never carry `source`, so
    /// the workbench can tell the two apart; older frontends fall back to
    /// their existing rendering). Unit-tested shape.
    pub(crate) fn mcp_confirm_challenge_payload(
        challenge_id: &str,
        tool: &str,
        command: &str,
        connection_id: Option<&str>,
        timeout_secs: u64,
    ) -> Value {
        let mut payload = json!({
            "challengeId": challenge_id,
            "kind": "mcp-confirm",
            "source": "mcp",
            "tool": tool,
            "command": command,
            "requestedAt": unix_now_secs(),
            "timeoutSecs": timeout_secs,
        });
        if let Some(id) = connection_id.filter(|id| !id.is_empty()) {
            payload["connectionId"] = json!(id);
        }
        payload
    }

    /// MCP confirm permission gate (IMPL_PLAN §1.3): raises a
    /// `ssh/agent/prompt` approval challenge (kind `mcp-confirm`,
    /// source `mcp`) on the workbench and waits for `ssh/agent/resolve`.
    /// Returns the (possibly user-edited) command on approval; denial or
    /// the 120s timeout returns `Err`. One-shot challenge semantics are
    /// shared with the terminal approval path (`resolve_agent_challenge`).
    /// There is deliberately no session binding and no terminal follow-up
    /// events — an MCP confirm never types into a terminal.
    pub(crate) async fn request_mcp_confirm(
        &self,
        tool: &str,
        command: &str,
        connection_id: Option<&str>,
        emitter: &PluginEmitter,
    ) -> Result<String, String> {
        let wait = Duration::from_secs(MCP_CONFIRM_TIMEOUT_SECS);
        let challenge_id = Uuid::new_v4().to_string();
        let connection_id = connection_id.unwrap_or_default().to_string();
        let raised_at_ms = unix_now_ms();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut challenges) = self.agent_challenges.lock() {
            challenges.insert(
                challenge_id.clone(),
                PendingChallenge {
                    sender,
                    connection_id: connection_id.clone(),
                    tool: tool.to_string(),
                    command: command.to_string(),
                    raised_at_ms,
                },
            );
        }
        let raised = emitter.event(
            "ssh/agent/prompt",
            Self::mcp_confirm_challenge_payload(
                &challenge_id,
                tool,
                command,
                Some(&connection_id),
                wait.as_secs(),
            ),
        );
        if let Err(error) = raised {
            // Nobody can approve without the prompt; fail fast instead of
            // letting the challenge run into its timeout.
            if let Ok(mut challenges) = self.agent_challenges.lock() {
                challenges.remove(&challenge_id);
            }
            return Err(format!(
                "Failed to raise the approval prompt: {}",
                error.message
            ));
        }
        let decision = match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(decision)) => Some(decision),
            // Timeout or dropped sender both mean "no user decision"; the
            // challenge is expired so a late resolve reports not found.
            Ok(Err(_)) | Err(_) => {
                if let Ok(mut challenges) = self.agent_challenges.lock() {
                    challenges.remove(&challenge_id);
                }
                None
            }
        };
        match decision {
            Some(AgentDecision::Approve { command: edited }) => {
                let edited = edited.filter(|text| !text.trim().is_empty());
                Ok(edited.unwrap_or_else(|| command.to_string()))
            }
            Some(AgentDecision::Deny) => {
                Err("Command not run: user denied the execution".to_string())
            }
            None => Err("Command not run: approval timed out waiting for the user".to_string()),
        }
    }

    /// Raises an approval challenge for a terminal-routed agent command:
    /// emits `ssh/agent/prompt`, then waits for `ssh/agent/resolve`.
    /// Returns the (possibly user-edited) command on approval; denial or
    /// timeout returns `Err` and emits `ssh/agent/finish{status:"denied"}`.
    pub(crate) async fn request_agent_approval(
        &self,
        session_id: &str,
        tool: &str,
        command: &str,
        risk: CommandRisk,
        timeout_secs: Option<u64>,
        emitter: &PluginEmitter,
    ) -> Result<String, String> {
        let wait = Duration::from_secs(
            timeout_secs
                .unwrap_or(AGENT_APPROVAL_DEFAULT_SECS)
                .clamp(AGENT_APPROVAL_MIN_SECS, AGENT_APPROVAL_MAX_SECS),
        );
        let challenge_id = Uuid::new_v4().to_string();
        let session = self.session(session_id).await?;
        let connection_id = session.connection_id.clone();
        let raised_at_ms = unix_now_ms();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut challenges) = self.agent_challenges.lock() {
            challenges.insert(
                challenge_id.clone(),
                PendingChallenge {
                    sender,
                    connection_id,
                    tool: tool.to_string(),
                    command: command.to_string(),
                    raised_at_ms,
                },
            );
        }
        let raised = emitter.event(
            "ssh/agent/prompt",
            json!({
                "challengeId": challenge_id,
                "sessionId": session_id,
                "tool": tool,
                "command": command,
                "risk": risk.name(),
                "requestedAt": unix_now_secs(),
                "timeoutSecs": wait.as_secs(),
            }),
        );
        if let Err(error) = raised {
            // Nobody can approve without the prompt; fail fast instead of
            // letting the challenge run into its timeout.
            if let Ok(mut challenges) = self.agent_challenges.lock() {
                challenges.remove(&challenge_id);
            }
            return Err(format!(
                "Failed to raise the approval prompt: {}",
                error.message
            ));
        }
        let decision = match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(decision)) => Some(decision),
            // Timeout or dropped sender both mean "no user decision".
            Ok(Err(_)) | Err(_) => {
                // Expire the challenge so a late resolve reports not found.
                if let Some(pending) = self
                    .agent_challenges
                    .lock()
                    .ok()
                    .and_then(|mut challenges| challenges.remove(&challenge_id))
                {
                    self.audit_approval(
                        &pending.tool,
                        &pending.connection_id,
                        Some(&pending.command),
                        audit_log::ApprovalTrail::Timeout,
                        audit_log::EntryOutcome::Error,
                        unix_now_ms().saturating_sub(pending.raised_at_ms),
                    );
                }
                None
            }
        };
        // Approved: the follow-up notice/finish pair comes from
        // exec_in_terminal — emitting "denied" here would flash the workbench
        // banner state for a command that is about to run.
        if let Some(AgentDecision::Approve { command: edited }) = decision {
            let edited = edited.filter(|text| !text.trim().is_empty());
            return Ok(edited.unwrap_or_else(|| command.to_string()));
        }
        let _ = emitter.event(
            "ssh/agent/finish",
            json!({ "sessionId": session_id, "status": "denied" }),
        );
        match decision {
            Some(AgentDecision::Deny) => {
                Err("Command not run: user denied the terminal execution".to_string())
            }
            None => Err("Command not run: approval timed out waiting for the user".to_string()),
            Some(AgentDecision::Approve { .. }) => unreachable!("handled above"),
        }
    }

    /// Resolves a pending agent approval challenge (`ssh/agent/resolve`).
    /// One-shot: the challenge is removed from the registry before the
    /// decision is delivered, so a repeat resolve reports not found.
    /// `decision` is "approve" or "deny"; `command` carries the edited
    /// command text from the approval dialog (approve only); `remember`
    /// (approve only) persists the approved command on the connection's
    /// remembered-approval list so later identical matches skip the prompt.
    pub fn resolve_agent_challenge(
        &self,
        challenge_id: &str,
        decision: &str,
        command: Option<&str>,
        remember: bool,
    ) -> Result<(), String> {
        let approved = match decision {
            "approve" => true,
            "deny" => false,
            other => {
                return Err(format!(
                    "agent decision must be \"approve\" or \"deny\"; got '{other}'"
                ))
            }
        };
        let pending = self
            .agent_challenges
            .lock()
            .map_err(|_| "Agent challenge registry is poisoned".to_string())?
            .remove(challenge_id)
            .ok_or("Agent challenge was not found or already resolved")?;
        let decision = if approved {
            AgentDecision::Approve {
                command: command.map(str::to_string),
            }
        } else {
            AgentDecision::Deny
        };
        let mut remembered = false;
        if approved && remember {
            // The remembered text is what the dialog showed the user — the
            // edited command when one was sent, otherwise the original.
            let text = command
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .unwrap_or(&pending.command);
            // A destructive command is never rememberable (IMPL_PLAN D2):
            // the flag is silently dropped and the approval stays one-shot.
            let mut store = agent_approvals::load_store(&self.data_dir);
            match agent_approvals::remember(&mut store, &pending.connection_id, text) {
                Ok(newly_added) if newly_added => {
                    match agent_approvals::save_store(&self.data_dir, &store) {
                        Ok(()) => remembered = true,
                        Err(error) => {
                            eprintln!("[ssh] failed to persist remembered approval: {error}")
                        }
                    }
                }
                Ok(_) => remembered = true,
                Err(error) => eprintln!("[ssh] approval not remembered: {error}"),
            }
        }
        self.audit_approval(
            &pending.tool,
            &pending.connection_id,
            Some(&pending.command),
            match (approved, remembered) {
                (true, true) => audit_log::ApprovalTrail::Remembered,
                (true, false) => audit_log::ApprovalTrail::Approved,
                (false, _) => audit_log::ApprovalTrail::Denied,
            },
            if approved {
                audit_log::EntryOutcome::Ok
            } else {
                audit_log::EntryOutcome::Error
            },
            unix_now_ms().saturating_sub(pending.raised_at_ms),
        );
        pending
            .sender
            .send(decision)
            .map_err(|_| "Agent challenge is no longer waiting".to_string())
    }

    /// Appends one approval-lifecycle line to the execution audit ledger.
    /// Execution itself is audited by the MCP layer; these lines carry the
    /// human-decision trail (`approval` field) for terminal-routed commands.
    fn audit_approval(
        &self,
        tool: &str,
        connection_id: &str,
        command: Option<&str>,
        approval: audit_log::ApprovalTrail,
        outcome: audit_log::EntryOutcome,
        duration_ms: u64,
    ) {
        let entry = audit_log::AuditEntry {
            ts_ms: unix_now_ms(),
            tool: tool.to_string(),
            connection_id: connection_id.to_string(),
            gate: audit_log::GateOutcome::Pass,
            approval,
            outcome,
            exit_code: None,
            duration_ms,
            mode: audit_log::ExecMode::Terminal,
            command: command.map(str::to_string),
            output: None,
            error: None,
        };
        if let Err(error) = audit_log::append(&self.data_dir, &entry) {
            eprintln!("[ssh] audit append failed: {error}");
        }
    }
}
