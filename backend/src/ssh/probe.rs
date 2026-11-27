use super::*;

impl SshRuntime {
    pub async fn test_connection(
        &self,
        connection: &StoredConnection,
        operation_id: &str,
        emitter: PluginEmitter,
    ) -> Result<(), String> {
        self.prompts.clear_challenge_raised();
        // 宿主对 connection/test 有 RPC 截止（有效连接超时），截止一到直接
        // 杀掉请求、用户只看到费解的宿主超时文案——sidecar 必须在截止前
        // 作答，因此拨号预算按宿主截止对齐并留 1s 余量。
        let budget_secs = test_dial_budget_secs(
            connection.connect_timeout_secs,
            connection.connect_timeout_explicit,
        );
        let probe = self.connect_authenticated(connection, operation_id, Some(emitter));
        tokio::pin!(probe);
        let mut budget_secs = budget_secs;
        let mut extended = false;
        let connected = loop {
            match tokio::time::timeout(Duration::from_secs(budget_secs), probe.as_mut()).await {
                Ok(result) => break result,
                Err(_elapsed) => {
                    // 弹窗路径会把探针停在等待用户作答上:镜像拨号预算到期时
                    // 若弹窗已接管本次挑战,以"挑战等待 + 连接超时"重臂一次;
                    // 其余超时(1.0 宿主、工作台降级、扩展窗耗尽)保持现行可
                    // 读超时文案,行为不变。
                    let dialog_used = !extended && self.prompts.host_dialog_was_used();
                    match next_test_budget(connection.connect_timeout_secs, dialog_used) {
                        Some(next_budget) => {
                            budget_secs = next_budget;
                            extended = true;
                        }
                        None => {
                            // 挑战指引只在挑战已发出且未走弹窗路径时附加:
                            // "update DBX" 对 1.0 宿主是真的,对 1.1 弹窗路径
                            // 会误导。
                            let challenge_clause = self.prompts.challenge_was_raised()
                                && !self.prompts.host_dialog_was_used();
                            return Err(test_timeout_message(
                                &connection.runtime_host,
                                connection.runtime_port,
                                budget_secs,
                                !connection.connect_timeout_explicit,
                                challenge_clause,
                            ));
                        }
                    }
                }
            }
        };
        let (handle, jumps) = connected?;
        handle
            .disconnect(
                Disconnect::ByApplication,
                "DBX SSH connection test complete",
                "English",
            )
            .await
            .map_err(|error| format!("SSH test disconnect failed: {error}"))?;
        for jump in jumps {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH jump connection closed",
                    "English",
                )
                .await;
        }
        Ok(())
    }

    /// Preflight host-key check for a saved connection (tiny-rdm's
    /// CheckHostKey): dials only to key exchange, compares the presented
    /// server key against the known_hosts stores, and aborts the handshake
    /// before any authentication or challenge. Jump chains are not
    /// tunneled through (that would require full jump authentication), so
    /// jump-only targets report `unreachable`. TCP failures and timeouts
    /// are returned as `{state: "unreachable", error}` inside `Ok` so the
    /// frontend can render them; only internal errors (unknown connection,
    /// poisoned registry) are `Err`.
    pub async fn check_host_key(&self, connection_id: &str) -> Result<Value, String> {
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| {
                format!("Connection {connection_id} is not active; reopen it from DBX")
            })?;
        let config = Arc::new(ssh_client_config(&connection));
        let probe = HostKeyProbe {
            verifier: Arc::new(HostKeyVerifier::new(self.known_hosts_path.clone())),
            host: connection.host.clone(),
            port: connection.port,
            seen: Arc::new(Mutex::new(None)),
        };
        let seen = probe.seen.clone();
        let timeout = Duration::from_secs(connection.connect_timeout_secs.max(1));
        // #324：代理路径与正式拨号同源——代理握手失败直接按 unreachable
        // 上报（等价 TCP 拨不通的语义），流建立后再做密钥交换预检。
        // 两个分支的具体 future 类型不同，统一放进 async 块在 await 点
        // 收敛成同一 Output。
        let connect = async {
            match &connection.proxy {
                Some(proxy) => {
                    let stream = match proxy
                        .connect(&connection.runtime_host, connection.runtime_port, timeout)
                        .await
                    {
                        Ok(stream) => stream,
                        Err(error) => return Err(error),
                    };
                    client::connect_stream(config, stream, probe)
                        .await
                        .map_err(|error| error.to_string())
                }
                None => {
                    client::connect(
                        config,
                        (connection.runtime_host.as_str(), connection.runtime_port),
                        probe,
                    )
                    .await
                    .map_err(|error| error.to_string())
                }
            }
        };
        let failure = match tokio::time::timeout(timeout, connect).await {
            // The probe always rejects the key, so a handle here would be
            // unexpected; disconnect defensively anyway.
            Ok(Ok(handle)) => {
                let _ = handle
                    .disconnect(
                        Disconnect::ByApplication,
                        "DBX host-key check complete",
                        "English",
                    )
                    .await;
                None
            }
            // Key exchange ran and the probe aborted it: the stashed verdict
            // decides the response regardless of the resulting russh error.
            Ok(Err(error)) => {
                let probed = seen.lock().map(|slot| slot.is_some()).unwrap_or(false);
                (!probed).then(|| {
                    format!(
                        "SSH connection to {}:{} failed: {error}",
                        connection.runtime_host, connection.runtime_port
                    )
                })
            }
            Err(_elapsed) => Some(format!(
                "SSH connection to {}:{} timed out after {} seconds",
                connection.runtime_host,
                connection.runtime_port,
                timeout.as_secs()
            )),
        };
        let outcome = seen.lock().ok().and_then(|mut slot| slot.take());
        Ok(match (outcome, failure) {
            (Some((verdict, key_type, fingerprint)), _) => {
                host_key_check_response(&verdict, &key_type, &fingerprint)
            }
            (None, Some(error)) => host_key_unreachable_response(error),
            (None, None) => host_key_unreachable_response(
                "SSH handshake completed without presenting a host key".to_string(),
            ),
        })
    }

    /// Dials the ProxyJump chain (if any) and returns the authenticated
    /// target handle plus the jump-host handles that must stay alive for the
    /// target tunnel to keep working. Ported from tiny-rdm's dialThroughJump.
    pub(crate) async fn connect_authenticated(
        &self,
        connection: &StoredConnection,
        operation_id: &str,
        emitter: Option<PluginEmitter>,
    ) -> Result<(Handle<SshClient>, Vec<Handle<SshClient>>), String> {
        let mut jump_handles = Vec::new();
        // #324：代理挂在初始拨号上——无论是直接到目标还是先到第一跳跳板，
        // 出站的第一个 TCP 都要经代理摸出去；后续跳板链走已建立的隧道，
        // 不再涉及代理。
        let mut dial = match &connection.proxy {
            Some(proxy) => DialTarget::Proxied(
                proxy
                    .connect(
                        &connection.runtime_host,
                        connection.runtime_port,
                        Duration::from_secs(connection.connect_timeout_secs.max(1)),
                    )
                    .await?,
            ),
            None => DialTarget::Tcp((connection.runtime_host.clone(), connection.runtime_port)),
        };

        for (position, jump) in connection.jump_hosts.iter().enumerate() {
            let jump_connection = jump.to_connection(
                &format!("jump-{}-{}", position + 1, connection.id),
                connection.connect_timeout_secs,
                connection.keepalive_interval_secs,
            );
            let handle = self
                .dial_and_authenticate(&jump_connection, dial, operation_id, emitter.clone())
                .await
                .map_err(|error| {
                    format!(
                        "Jump host #{} ({}:{}) failed: {error}",
                        position + 1,
                        jump.host,
                        jump.port
                    )
                })?;
            // The next hop dials through a direct-tcpip channel on this jump.
            let next = if position + 1 < connection.jump_hosts.len() {
                let target = &connection.jump_hosts[position + 1];
                (target.host.clone(), target.port)
            } else {
                (connection.host.clone(), connection.port)
            };
            dial = DialTarget::through_jump(&handle, &next.0, next.1).await?;
            jump_handles.push(handle);
        }

        let target = self
            .dial_and_authenticate(connection, dial, operation_id, emitter)
            .await?;
        Ok((target, jump_handles))
    }
}
