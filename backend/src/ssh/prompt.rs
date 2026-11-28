use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptDecision {
    pub accept: bool,
    pub remember: bool,
}

/// Whether the attached DBX host advertised the Host API 1.1 user-input
/// dialog. The host sends the dot form; the slash form appears in docs, so
/// accept both when gating.
fn host_supports_user_input() -> bool {
    host_client()
        .map(|client| {
            client.supports(HOST_REQUEST_USER_INPUT_FEATURE)
                || client.supports(HOST_REQUEST_USER_INPUT_METHOD)
        })
        .unwrap_or(false)
}

/// Seam between the broker and Host API 1.1; tests script it instead of a
/// live host process.
pub(crate) trait HostPromptGateway: Send + Sync {
    fn supports_request_user_input(&self) -> bool;
    fn request_user_input(&self, prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError>;
}

struct SdkHostPromptGateway;

impl HostPromptGateway for SdkHostPromptGateway {
    fn supports_request_user_input(&self) -> bool {
        host_supports_user_input()
    }

    fn request_user_input(&self, prompt: &UserInputPrompt) -> Result<UserInputAnswer, PluginError> {
        match host_client() {
            Some(client) => client.request_user_input(prompt),
            None => Err(PluginError::new(
                -32000,
                "Host API is unavailable: the plugin server is not running",
            )),
        }
    }
}

#[derive(Clone)]
pub struct PromptBroker {
    pending: Arc<AsyncMutex<HashMap<String, PendingPrompt>>>,
    gateway: Arc<dyn HostPromptGateway>,
    /// Set whenever a confirmation was raised, whichever channel served it;
    /// `connection/test` reads it to make its timeout guidance truthful.
    pub(super) challenge_raised: Arc<AtomicBool>,
    /// Sticky mark that the Host API 1.1 dialog took (or is still taking)
    /// this challenge: `connection/test` extends its mirrored dial budget
    /// once while a dialog may still be open. Degradable failures clear it
    /// again before the workbench fallback, so hosts without a working
    /// dialog keep the short 1.0-style budget.
    pub(super) host_dialog_used: Arc<AtomicBool>,
}

impl Default for PromptBroker {
    fn default() -> Self {
        Self {
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            gateway: Arc::new(SdkHostPromptGateway),
            challenge_raised: Arc::new(AtomicBool::new(false)),
            host_dialog_used: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct PendingPrompt {
    operation_id: String,
    sender: oneshot::Sender<PromptDecision>,
}

impl PromptBroker {
    /// Test-only seam injection; production brokers use `Default`.
    #[cfg(test)]
    pub(crate) fn with_gateway(gateway: Arc<dyn HostPromptGateway>) -> Self {
        Self {
            gateway,
            ..Self::default()
        }
    }

    /// One clear entry for both sticky challenge marks so every new probe
    /// starts from a clean slate.
    pub(crate) fn clear_challenge_raised(&self) {
        self.challenge_raised.store(false, Ordering::Relaxed);
        self.host_dialog_used.store(false, Ordering::Relaxed);
    }

    pub(crate) fn challenge_was_raised(&self) -> bool {
        self.challenge_raised.load(Ordering::Relaxed)
    }

    pub(crate) fn host_dialog_was_used(&self) -> bool {
        self.host_dialog_used.load(Ordering::Relaxed)
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn request(
        &self,
        host: &str,
        port: u16,
        key_type: String,
        fingerprint: String,
        connection_id: &str,
        operation_id: &str,
        emitter: &PluginEmitter,
    ) -> Option<PromptDecision> {
        if self.gateway.supports_request_user_input() {
            match self
                .request_via_host(host, port, &key_type, &fingerprint)
                .await
            {
                Ok(decision) => return decision,
                // Host predates the dialog (-32601), rejects the parameters
                // (-32602, e.g. an over-limit field) or no dialog surface is
                // mounted (-32001 without the SDK's own timeout wording): the
                // workbench event may still reach a UI.
                Err(error) if Self::host_prompt_unavailable(&error) => {}
                // Anything else — including the SDK's own -32001 "did not
                // answer" timeout — must fail closed instead of stacking
                // another 300s wait on top.
                Err(_) => return None,
            }
        }
        self.request_via_workbench(
            host,
            port,
            key_type,
            fingerprint,
            connection_id,
            operation_id,
            emitter,
        )
        .await
    }

    /// The gateway call blocks until the user answers, so it runs on the
    /// blocking pool: the dispatch worker stays free and the enclosing
    /// `connection/test` budget can observe the wait and re-arm while the
    /// dialog is open (the host pauses its own RPC deadline meanwhile).
    async fn request_via_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<Option<PromptDecision>, PluginError> {
        self.challenge_raised.store(true, Ordering::Relaxed);
        // The host caps the title at 200 and the prompt at 2000 chars; a
        // near-limit FQDN shrinks here instead of coming back as -32602
        // (which would only fall back to the workbench event anyway).
        let title: String = format!("SSH host key — {host}:{port}")
            .chars()
            .take(200)
            .collect();
        let prompt_text: String = format!(
            "The authenticity of host {host}:{port} can't be established.\n\
             Key type: {key_type}\n\
             SHA-256 fingerprint: {fingerprint}\n\
             Trust this host and continue connecting?"
        )
        .chars()
        .take(2000)
        .collect();
        let prompt = UserInputPrompt::choice(
            prompt_text,
            vec![
                UserInputOption {
                    value: "accept".to_string(),
                    label: "Trust once".to_string(),
                },
                UserInputOption {
                    value: "remember".to_string(),
                    label: "Trust and remember".to_string(),
                },
            ],
        )
        .with_title(title)
        .with_timeout_secs(HOST_KEY_CHALLENGE_WAIT.as_secs());
        // Mark before parking on the answer: `connection/test` re-arms its
        // budget on this flag while the dialog is still open. A degradable
        // failure clears it again below, so the workbench fallback keeps the
        // short 1.0-style budget.
        self.host_dialog_used.store(true, Ordering::Relaxed);
        let gateway = Arc::clone(&self.gateway);
        let answer =
            match tokio::task::spawn_blocking(move || gateway.request_user_input(&prompt)).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(error)) => {
                    if Self::host_prompt_unavailable(&error) {
                        self.host_dialog_used.store(false, Ordering::Relaxed);
                    }
                    return Err(error);
                }
                // The blocking task died without an answer; fail closed like any
                // other non-degradable gateway failure.
                Err(error) => {
                    return Err(PluginError::new(
                        -32000,
                        format!("host dialog task failed: {error}"),
                    ));
                }
            };
        Ok(Some(
            match (answer.action.as_str(), answer.value.as_deref()) {
                // Only an explicit accept/remember value grants trust; a missing
                // or unknown value (and any non-submit action) is a rejection:
                // never guess.
                ("submit", Some("accept")) => PromptDecision {
                    accept: true,
                    remember: false,
                },
                ("submit", Some("remember")) => PromptDecision {
                    accept: true,
                    remember: true,
                },
                _ => PromptDecision {
                    accept: false,
                    remember: false,
                },
            },
        ))
    }

    /// Errors that mean "no usable dialog surface" rather than "no answer":
    /// the workbench event may still reach a human. -32601 unknown method
    /// (host predates Host API 1.1), -32602 invalid params, and -32001 when
    /// it is not the SDK's own "did not answer" timeout.
    fn host_prompt_unavailable(error: &PluginError) -> bool {
        error.code == -32601
            || error.code == -32602
            || (error.code == -32001 && !error.message.contains("did not answer"))
    }

    /// Asks the user for one keyboard-interactive answer without persisting
    /// it. Automatic password/TOTP orchestration gets the first chance; this
    /// path is only used for an answer that stayed empty (hardware token,
    /// SMS code, custom MFA wording, and similar one-time challenges).
    pub(super) async fn request_keyboard_interactive_answer(
        &self,
        host: &str,
        port: u16,
        username: &str,
        challenge: String,
    ) -> Result<Option<String>, String> {
        if !self.gateway.supports_request_user_input() {
            return Ok(None);
        }

        let title: String = format!("动态令牌验证 — {username}@{host}:{port}")
            .chars()
            .take(200)
            .collect();
        let challenge = if challenge.trim().is_empty() {
            "SSH 服务器要求补充身份验证信息。".to_string()
        } else {
            challenge
        };
        let prompt_text: String = format!(
            "请输入服务器要求的当前动态令牌。本次输入仅用于此次登录，不会保存。\n\n服务器提示：\n{challenge}"
        )
        .chars()
        .take(2000)
        .collect();
        let prompt = UserInputPrompt::secret(prompt_text)
            .with_title(title)
            .with_timeout_secs(HOST_KEY_CHALLENGE_WAIT.as_secs());

        // `connection/test` mirrors the host's short RPC deadline. Mark the
        // dialog before waiting so the outer probe can extend its budget just
        // as it already does for host-key confirmation.
        let dialog_was_already_used = self.host_dialog_used.swap(true, Ordering::Relaxed);
        let gateway = Arc::clone(&self.gateway);
        let answer =
            match tokio::task::spawn_blocking(move || gateway.request_user_input(&prompt)).await {
                Ok(Ok(answer)) => answer,
                Ok(Err(error)) if Self::host_prompt_unavailable(&error) => {
                    if !dialog_was_already_used {
                        self.host_dialog_used.store(false, Ordering::Relaxed);
                    }
                    return Ok(None);
                }
                Ok(Err(error)) => {
                    return Err(format!(
                        "SSH keyboard-interactive prompt failed: {}",
                        error.message
                    ));
                }
                Err(error) => {
                    return Err(format!(
                        "SSH keyboard-interactive prompt task failed: {error}"
                    ));
                }
            };

        match answer.action.as_str() {
            "submit" => match answer.value.filter(|value| !value.is_empty()) {
                Some(value) => Ok(Some(value)),
                None => Err("SSH keyboard-interactive answer was empty".to_string()),
            },
            "cancel" => Err("SSH keyboard-interactive authentication was cancelled".to_string()),
            "timeout" => {
                Err("SSH keyboard-interactive authentication prompt timed out".to_string())
            }
            _ => Err("SSH keyboard-interactive authentication received no answer".to_string()),
        }
    }

    // 参数就是 host-key 挑战事件的载荷字段，一一对应而非可归组的耦合。
    #[allow(clippy::too_many_arguments)]
    async fn request_via_workbench(
        &self,
        host: &str,
        port: u16,
        key_type: String,
        fingerprint: String,
        connection_id: &str,
        operation_id: &str,
        emitter: &PluginEmitter,
    ) -> Option<PromptDecision> {
        self.challenge_raised.store(true, Ordering::Relaxed);
        let challenge_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            challenge_id.clone(),
            PendingPrompt {
                operation_id: operation_id.to_string(),
                sender,
            },
        );
        if emitter
            .event(
                "connection/challenge",
                json!({
                    "challengeId": challenge_id,
                    "operationId": operation_id,
                    "connectionId": connection_id,
                    "kind": "host-key",
                    "host": host,
                    "port": port,
                    "keyType": key_type,
                    "fingerprint": fingerprint
                }),
            )
            .is_err()
        {
            self.pending.lock().await.remove(&challenge_id);
            return None;
        }
        let result = match tokio::time::timeout(Duration::from_secs(300), receiver).await {
            Ok(answer) => answer.ok(),
            // 超时同样要清 pending，否则无人应答的挑战把条目永久留在 map
            // 里（只能等 sidecar 重启回收）。
            Err(_) => {
                self.pending.lock().await.remove(&challenge_id);
                return None;
            }
        };
        self.pending.lock().await.remove(&challenge_id);
        result
    }

    pub async fn resolve(
        &self,
        challenge_id: &str,
        operation_id: &str,
        decision: PromptDecision,
    ) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .await
            .remove(challenge_id)
            .ok_or("Host-key challenge was not found or already resolved")?;
        if pending.operation_id != operation_id {
            return Err("Host-key challenge operation does not match".to_string());
        }
        pending
            .sender
            .send(decision)
            .map_err(|_| "Host-key challenge is no longer waiting".to_string())
    }
}
