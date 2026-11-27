use super::*;

impl SshRuntime {
    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.close_session_with_reason(session_id, None).await
    }

    pub(super) async fn close_session_with_reason(
        &self,
        session_id: &str,
        reason: Option<&'static str>,
    ) -> Result<(), String> {
        // Teardown runs while the session is still registered so remote
        // listener cancellation can ride the (still open) SSH handle.
        self.stop_session_forwards(session_id).await;
        // sudo 下载远端临时件的会话级清理（finally 语义）：趁 SSH handle 还
        // 活着 best-effort 删除；失败只落提示——本地 .part 由
        // cleanup_session_transfers 删除，远端残留只能等下次同路径暂存或
        // 管理员清理（mktemp 名字带前缀，不会顶替任何现有文件）。
        let staged_tmps: Vec<(String, String)> = match self.downloads.lock() {
            Ok(downloads) => downloads
                .iter()
                .filter(|(_, download)| download.session_id == session_id)
                .filter_map(|(_, download)| {
                    download
                        .sudo_tmp
                        .clone()
                        .map(|tmp| (download.session_id.clone(), tmp))
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        for (owner_session, tmp) in staged_tmps {
            if let Err(error) = sudo_download::discard_tmp(self, &owner_session, &tmp).await {
                eprintln!("[sudo-download] session-close temp cleanup failed ({tmp}): {error}");
            }
        }
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("SSH session was not found")?;
        // 限时投递：读循环可能正阻塞在死 transport 的 channel.data() 上且
        // 输入队列（容量 256）已被灌满——无超时的 send 会无限期挂起，而
        // disconnect_connection 是逐会话串行 await，一个僵尸会话就能拖死
        // 整个断开 RPC。超时放弃即可：读循环随后会因 transport 死亡自行
        // 退出（spontaneous 路径有完整的会话收尾）。
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session.terminal_tx.send(TerminalCommand::Close { reason }),
        )
        .await;
        session.transport_lease.release().await;
        // 清理失败不得吞掉关闭结果：会话此刻已移出注册表、transport 已释放，
        // 对外就是「已关闭」——上抛只会让调用方重试并吃到 not found。
        if let Err(error) = self.cleanup_session_transfers(session_id).await {
            eprintln!("close_session: transfer cleanup for {session_id} failed: {error}");
        }
        if let Ok(mut cache) = self.metrics_cache.lock() {
            cache.remove(session_id);
        }
        // X11 gate lifecycle: the armed gate is the sidecar-wide slot (see
        // x11::ACTIVE_GATE) serving the most recently armed session. With
        // the last session gone no admission can be legitimate, so release
        // the cookie and fail closed until a session arms again.
        if self.sessions.read().await.is_empty() {
            crate::x11::disarm_active();
        }
        let connection_id = session.connection_id.clone();
        let connection_has_sessions = self
            .sessions
            .read()
            .await
            .values()
            .any(|session| session.connection_id == connection_id);
        if !connection_has_sessions {
            self.stop_sudo_keepalive(&connection_id).await;
            // No session left on the connection: the per-connection
            // forwarded-tcpip table can never match again.
            self.remote_tables
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&connection_id);
        }
        Ok(())
    }

    /// Read-only inventory of the sessions this sidecar currently tracks
    /// (tiny-rdm's `ListSessions`): connection/workbench identity, liveness,
    /// sudo-keepalive state and creation time. No SSH traffic is involved.
    pub async fn list_sessions(&self) -> Value {
        let sessions = self.sessions.read().await;
        let keepalives: std::collections::HashSet<String> = match self.sudo_keepalive.lock() {
            Ok(guard) => guard.keys().cloned().collect(),
            Err(_) => std::collections::HashSet::new(),
        };
        // Read-only auth method name per connection id for the info panel;
        // a poisoned store just means the panel shows the default method.
        let connections = self.connections.read().ok();
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, entry)| {
                let connection = connections
                    .as_deref()
                    .and_then(|store| store.get(&entry.connection_id));
                let auth_method = connection
                    .map(|connection| connection.authentication.method_name())
                    .unwrap_or("password");
                let endpoint = connection
                    .map(|connection| ConnectionEndpoint {
                        host: connection.host.clone(),
                        port: connection.port,
                        username: connection.username.clone(),
                    })
                    .unwrap_or_else(ConnectionEndpoint::fallback);
                let workbench_id = entry
                    .workbench_id
                    .read()
                    .map(|workbench| workbench.clone())
                    .unwrap_or_default();
                session_info_payload(
                    session_id,
                    &entry.connection_id,
                    &workbench_id,
                    entry.read_only,
                    entry.connected.load(Ordering::Acquire),
                    keepalives.contains(&entry.connection_id),
                    connection.map(|c| c.terminal_keepalive_secs).unwrap_or(0),
                    entry.created_at_secs,
                    auth_method,
                    &endpoint,
                    entry
                        .session_recorder
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .is_some(),
                )
            })
            .collect();
        drop(connections);
        drop(sessions);
        // Oldest first, stable by id — mirrors tiny-rdm's deterministic order.
        list.sort_by(|a, b| {
            a["createdAt"]
                .as_u64()
                .cmp(&b["createdAt"].as_u64())
                .then_with(|| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()))
        });
        json!({ "sessions": list })
    }

    pub async fn resize_terminal(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        self.session(session_id)
            .await?
            .terminal_tx
            .send(TerminalCommand::Resize { cols, rows })
            .await
            .map_err(|_| "Terminal is closed".to_string())
    }

    pub fn write_terminal(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        // Do not hold the session-map read guard while applying backpressure:
        // closing a dead session needs the write lock to drop the receiver so
        // a blocked sender can observe closure and return.
        let terminal_tx = {
            let sessions = self.sessions.blocking_read();
            sessions
                .get(session_id)
                .map(|session| session.terminal_tx.clone())
                // Same string as session() below — the workbench's dead-session
                // detection matches on this contract (App.vue input queue).
                .ok_or("SSH session was not found or expired")?
        };
        enqueue_terminal_input(&terminal_tx, data)
    }

    /// Normalizes one batch command into PTY key input: newlines become
    /// carriage returns (each an Enter for the remote shell), with a trailing
    /// Enter when `append_newline`. Bounded so a single batch write cannot
    /// flood a session's input queue. Pure for tests.
    pub(super) fn batch_input_payload(command: &str, append_newline: bool) -> Vec<u8> {
        const MAX_BATCH_INPUT_BYTES: usize = 256 * 1024;
        let normalized = command.replace("\r\n", "\r").replace(['\n', '\r'], "\r");
        let mut payload = normalized.into_bytes();
        if payload.len() > MAX_BATCH_INPUT_BYTES {
            // Back off to a UTF-8 boundary: a raw byte cut would split a
            // multibyte character and send garbage to the remote shell.
            let mut end = MAX_BATCH_INPUT_BYTES;
            while end > 0 && (payload[end] & 0xC0) == 0x80 {
                end -= 1;
            }
            payload.truncate(end);
        }
        if append_newline {
            payload.push(b'\r');
        }
        payload
    }

    /// Deduplicates target ids while preserving call order. Pure for tests.
    pub(super) fn dedupe_session_ids(session_ids: &[String]) -> Vec<String> {
        let mut seen = std::collections::HashSet::with_capacity(session_ids.len());
        session_ids
            .iter()
            .filter(|id| !id.is_empty() && seen.insert(id.as_str()))
            .cloned()
            .collect()
    }

    /// One per-target outcome row of `ssh/terminal/batchInput`. Pure for tests.
    pub(super) fn batch_input_row(session_id: &str, error: Option<&str>) -> Value {
        match error {
            Some(error) => json!({ "sessionId": session_id, "success": false, "error": error }),
            None => json!({ "sessionId": session_id, "success": true }),
        }
    }

    /// Writes the same command into several open sessions' interactive shells
    /// (tiny-rdm batch send): per-target outcomes only, the command's output
    /// echoes in each session's own terminal. Unknown ids and full/closed
    /// input queues fail their target without failing the whole call.
    pub async fn batch_terminal_input(
        &self,
        session_ids: &[String],
        command: &str,
        append_newline: bool,
    ) -> Value {
        let payload = Self::batch_input_payload(command, append_newline);
        let targets = Self::dedupe_session_ids(session_ids);
        let sessions = self.sessions.read().await;
        let mut results = Vec::with_capacity(targets.len());
        let mut sent = 0u64;
        let mut failed = 0u64;
        for session_id in &targets {
            let outcome = match sessions.get(session_id.as_str()) {
                Some(session) => session
                    .terminal_tx
                    .try_send(TerminalCommand::Input(payload.clone()))
                    .map_err(|error| format!("SSH input queue is full or closed: {error}")),
                None => Err("SSH session was not found".to_string()),
            };
            match outcome {
                Ok(()) => {
                    sent += 1;
                    results.push(Self::batch_input_row(session_id, None));
                }
                Err(error) => {
                    failed += 1;
                    results.push(Self::batch_input_row(session_id, Some(&error)));
                }
            }
        }
        drop(sessions);
        json!({ "results": results, "sent": sent, "failed": failed })
    }

    pub async fn replay_terminal(
        &self,
        session_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let replay = session.replay.lock().await;
        let first_available_sequence = replay.first_sequence();
        let tail_sequence = replay.sequence;
        let frames = replay.after(after_sequence);
        drop(replay);
        for frame in &frames {
            emitter
                .binary(&format!("ssh/terminal/out/{session_id}"), &frame.encode())
                .map_err(plugin_error)?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": after_sequence.saturating_add(1) >= first_available_sequence
        }))
    }

    /// Picks the session to attach for a (re)opened workbench. Sessions are
    /// workbench-owned: never attach a different tab's live PTY, even when it
    /// uses the same saved connection.
    pub(super) fn pick_attach_target(
        sessions: &[(String, String, String, bool)],
        connection_id: &str,
        workbench_id: &str,
    ) -> Option<String> {
        sessions
            .iter()
            .find(|(_, session_connection, session_workbench, connected)| {
                *connected
                    && session_connection.as_str() == connection_id
                    && session_workbench.as_str() == workbench_id
            })
            .map(|(session_id, _, _, _)| session_id.clone())
    }

    pub async fn attach_session(
        &self,
        connection_id: &str,
        workbench_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session_id = {
            let sessions = self.sessions.write().await;
            let snapshot: Vec<(String, String, String, bool)> = sessions
                .iter()
                .map(|(id, entry)| {
                    (
                        id.clone(),
                        entry.connection_id.clone(),
                        entry
                            .workbench_id
                            .read()
                            .map(|workbench| workbench.clone())
                            .unwrap_or_default(),
                        entry.connected.load(Ordering::Acquire),
                    )
                })
                .collect();
            Self::pick_attach_target(&snapshot, connection_id, workbench_id)
                .ok_or("No live SSH session is attached to this workbench")?
        };
        let replay = self
            .replay_terminal(&session_id, after_sequence, emitter)
            .await?;
        Ok(json!({
            "sessionId": session_id,
            "connectionId": connection_id,
            "workbenchId": workbench_id,
            "connected": true,
            "sequence": replay.get("tailSequence").and_then(Value::as_u64).unwrap_or(0),
            "replay": replay,
            "chunkSize": TRANSFER_CHUNK_SIZE
        }))
    }

    pub async fn close_workbench(&self, workbench_id: &str) -> Result<(), String> {
        let session_ids = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| {
                session
                    .workbench_id
                    .read()
                    .map(|workbench| workbench.as_str() == workbench_id)
                    .unwrap_or(false)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self.close_session(&session_id).await;
        }
        Ok(())
    }

    pub(super) async fn session(&self, session_id: &str) -> Result<Arc<SessionEntry>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or("SSH session was not found or expired".to_string())
    }

    pub(crate) async fn ensure_writable(&self, session_id: &str) -> Result<(), String> {
        if self.session(session_id).await?.read_only {
            Err(
                "Write/terminal operation is disabled by the read-only connection setting"
                    .to_string(),
            )
        } else {
            Ok(())
        }
    }

    /// Resolves one live transport handle for a connection — the resident
    /// monitor collectors open their own channels on an existing session's
    /// transport instead of dialing a second connection. Same registry scan
    /// as `attach_session`: entries are matched by connection id and must
    /// still be connected; any of the connection's workbench sessions
    /// qualifies (the transport is shared, the monitor never touches a
    /// terminal's PTY).
    pub async fn live_handle_for_connection(
        &self,
        connection_id: &str,
    ) -> Option<Arc<Handle<SshClient>>> {
        let sessions = self.sessions.read().await;
        sessions
            .values()
            .find(|entry| {
                entry.connection_id == connection_id && entry.connected.load(Ordering::Acquire)
            })
            .map(|entry| Arc::clone(&entry.handle))
    }

    /// Completion-host read-only gate (FIG wave-1 lane B, decision D4):
    /// `completion/execute` must refuse SSH targets on read-only
    /// connections. Minimal read-only query only — no other behavior of
    /// this module changes.
    pub async fn completion_session_read_only(&self, session_id: &str) -> Result<bool, String> {
        Ok(self.session(session_id).await?.read_only)
    }
}
