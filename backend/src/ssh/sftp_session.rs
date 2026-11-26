use super::*;

impl SshRuntime {
    /// Connection-level sudoers-style allowlist for privileged commands
    /// (`sudo_whitelist` in the connection's external config). Empty config
    /// = gate off; otherwise the command (minus a leading `sudo` token) must
    /// match one entry. Mirrors the MCP gate on the workbench exec path;
    /// structured `sudo_fs` operations are user-driven and stay exempt.
    ///
    /// Returns the command that may actually execute: with the gate on, this
    /// is the allowlist's token-quoted rebuild (`allowed_rebuilt_command`) —
    /// assignments stripped, metacharacters quarantined — so a passed match
    /// can never regain shell semantics under the root `sh -c`.
    pub async fn ensure_sudo_allowed(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<String, String> {
        let session = self.session(session_id).await?;
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .cloned()
            .ok_or("Connection is not active; reopen it from DBX".to_string())?;
        if connection.sudo_whitelist.is_empty() {
            return Ok(command.to_string());
        }
        let entries = crate::sudo_allowlist::entries_from_lines(&connection.sudo_whitelist);
        if let Some(rebuilt) = crate::sudo_allowlist::allowed_rebuilt_command(&entries, command) {
            return Ok(rebuilt);
        }
        Err(format!(
            "sudo command is not allowed by this connection's whitelist. \
             Allowed patterns: {}",
            crate::sudo_allowlist::render_entries(&entries)
        ))
    }

    pub(crate) async fn sftp(
        &self,
        session_id: &str,
    ) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        self.sftp_with_compat(session_id)
            .await
            .map_err(|error| self.compat_hint(session_id, error))
    }

    /// 通道级 SFTP 错误后使缓存失效：缓存槽若原样保留死通道，该会话所有
    /// SFTP 操作会永久报错、只能重开会话。对已不存在的会话是空操作。
    pub(crate) async fn invalidate_sftp_cache(&self, session_id: &str) {
        let Ok(session) = self.session(session_id).await else {
            return;
        };
        session.sftp.lock().await.take();
    }

    /// SFTP 会话建立。老旧服务器兼容模式（M14-B，偏好 `sftp_compat_mode`）
    /// 生效时：请求/响应不做流水线并发（读写各 1 路），并避免依赖服务器端
    /// 扩展协商的路径。偏好改动对尚未建立的 SFTP 会话即时生效；已缓存的
    /// 会话复用旧配置（重连后按新值建立）。
    async fn sftp_with_compat(
        &self,
        session_id: &str,
    ) -> Result<Arc<AsyncMutex<SftpSession>>, String> {
        let session = self.session(session_id).await?;
        let mut current = session.sftp.lock().await;
        if let Some(sftp) = current.as_ref() {
            return Ok(sftp.clone());
        }
        let channel = session
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Failed to open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("Failed to start SFTP: {error}"))?;
        let compat = crate::preferences::sftp_compat_mode(&self.data_dir);
        let sftp = Arc::new(AsyncMutex::new(
            SftpSession::new_with_config(channel.into_stream(), sftp_client_config(compat))
                .await
                .map_err(sftp_error)?,
        ));
        *current = Some(sftp.clone());
        Ok(sftp.clone())
    }

    /// 探测/建立失败的一次性兼容建议（M14-B）：每个会话只提示一次，避免
    /// 重复打扰；连接老旧 OpenSSH/嵌入式 sftp-server 的用户可按提示到
    /// 设置 → 传输里打开兼容模式。
    fn compat_hint(&self, session_id: &str, error: String) -> String {
        let fresh = self
            .compat_hinted
            .lock()
            .map(|mut hinted| hinted.insert(session_id.to_string()))
            .unwrap_or(false);
        if fresh {
            format!(
                "{error} (hint: if this server is legacy, enable legacy server compatibility in Settings → Transfer)"
            )
        } else {
            error
        }
    }

    pub async fn sftp_home(&self, session_id: &str) -> Result<String, String> {
        let sftp = self.sftp(session_id).await?;
        let home = sftp
            .lock()
            .await
            .canonicalize(".")
            .await
            .map_err(sftp_error)?;
        Ok(home)
    }

    /// sessionId → connectionId（M16 连接级 SFTP 文件名编码判定用）：只查
    /// 会话注册表，未知/已摘除的会话返回 None，由调用方按「未覆盖（跟随
    /// 全局）」兜底——编码判定绝不因会话状态未知而失败。
    pub async fn connection_id_for_session(&self, session_id: &str) -> Option<String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(|entry| entry.connection_id.clone())
    }

    pub async fn session_id_for_connection(&self, connection_id: &str) -> Result<String, String> {
        // The caller holds only the connection id, so with several workbenches
        // on one connection this must pick deterministically: the oldest live
        // session (the connection's primary workbench). HashMap iteration
        // order is randomized per process — picking "whatever comes first"
        // sent terminal-routed execs and the workbench's ^C to different
        // PTYs on every other launch.
        let sessions = self.sessions.read().await;
        let candidates = sessions
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(id, session)| {
                (
                    id.clone(),
                    session.created_seq,
                    session.connected.load(Ordering::Acquire),
                )
            });
        select_primary_session(candidates)
            .ok_or_else(|| "No active SSH session exists for this connection".to_string())
    }

    /// Stored (hydrated) connection by id — the task provider's credential
    /// source. Secrets stay inside the plugin: the caller uses them for the
    /// dial and for log redaction, never for echo-back or task config.
    pub(crate) async fn stored_connection(
        &self,
        connection_id: &str,
    ) -> Result<StoredConnection, String> {
        self.connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| format!("Connection {connection_id} is not active; reopen it from DBX"))
    }

    /// Registers a hydrated `io.dbx.ssh.local` target (`connection/connect`
    /// lifecycle). Re-connecting over an existing entry replaces it, exactly
    /// like [`Self::store_connection`].
    pub(crate) fn store_local_target(
        &self,
        target: crate::local_target::LocalTarget,
    ) -> Result<(), String> {
        let id = target.id.clone();
        self.local_targets
            .write()
            .map_err(|_| "Local target registry is poisoned".to_string())?
            .insert(id, target);
        Ok(())
    }

    /// Drops a local target registration (`connection/disconnect`). Unknown
    /// ids are a no-op so SSH disconnects stay untouched.
    pub(crate) fn drop_local_target(&self, connection_id: &str) {
        if let Ok(mut targets) = self.local_targets.write() {
            targets.remove(connection_id);
        }
    }

    /// Hydrated local shell target by id — `None` means the connection is
    /// not a local target (SSH provider, or never connected in this process).
    pub(crate) async fn local_target(
        &self,
        connection_id: &str,
    ) -> Option<crate::local_target::LocalTarget> {
        self.local_targets.read().ok()?.get(connection_id).cloned()
    }

    /// True when at least one authenticated live session exists for the
    /// connection — the task provider's "session reuse covers the missing
    /// stored connection" check.
    pub(crate) async fn has_live_session(&self, connection_id: &str) -> bool {
        self.sessions.read().await.values().any(|session| {
            session.connection_id == connection_id && session.connected.load(Ordering::Acquire)
        })
    }

    /// `task_transport`: execution transport for the scheduler task provider
    /// (`src/task_provider.rs`). Prefers the live session's authenticated
    /// handle (zero extra auth); falls back to a dedicated headless dial
    /// through the full jump chain so a scheduled task runs even when no
    /// workbench tab is open. Callers must `release()` the transport when
    /// done so dedicated dials disconnect instead of leaking.
    pub(crate) async fn task_transport(
        &self,
        connection_id: &str,
        operation_id: &str,
        emitter: Option<PluginEmitter>,
    ) -> Result<TaskTransport, String> {
        if let Ok(session_id) = self.session_id_for_connection(connection_id).await {
            if let Ok(session) = self.session(&session_id).await {
                return Ok(TaskTransport::Session {
                    handle: session.handle.clone(),
                });
            }
        }
        let connection = self.stored_connection(connection_id).await?;
        let (handle, jumps) = self
            .connect_authenticated(&connection, operation_id, emitter)
            .await?;
        Ok(TaskTransport::Dedicated { handle, jumps })
    }
}
