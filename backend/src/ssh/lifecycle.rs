use super::*;

impl SshRuntime {
    pub fn new(data_dir: PathBuf) -> Self {
        let transfer_dir = data_dir.join("transfers");
        let known_hosts_path = data_dir.join("known_hosts");
        let _ = std::fs::create_dir_all(&transfer_dir);
        sweep_stale_transfer_temps(&transfer_dir);
        Self {
            connections: RwLock::new(HashMap::new()),
            local_targets: RwLock::new(HashMap::new()),
            sessions: Arc::new(AsyncRwLock::new(HashMap::new())),
            uploads: Mutex::new(HashMap::new()),
            finishing_uploads: Mutex::new(HashMap::new()),
            download_preps: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            transfer_history: Mutex::new(VecDeque::new()),
            transfer_metrics: Mutex::new(crate::transfer_schedule::TransferMetrics::new()),
            session_seq: AtomicU64::new(0),
            sudo_keepalive: Arc::new(Mutex::new(HashMap::new())),
            metrics_cache: Mutex::new(HashMap::new()),
            exec_tasks: Mutex::new(HashMap::new()),
            forwards: Arc::new(forward::ForwardRegistry::default()),
            forward_transports: Arc::new(AsyncMutex::new(HashMap::new())),
            remote_tables: Arc::new(Mutex::new(HashMap::new())),
            agent_modes: Mutex::new(agent_terminal::load_modes(&data_dir)),
            agent_challenges: Mutex::new(HashMap::new()),
            auto_trust: false,
            compat_hinted: Mutex::new(HashSet::new()),
            compress_tool_probe: Mutex::new(HashMap::new()),
            prompts: PromptBroker::default(),
            data_dir,
            known_hosts_path,
            transfer_dir,
        }
    }

    /// Root directory holding plugin-owned state (known_hosts, transfers,
    /// mcp-settings.json).
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    /// Whether an SSH connection with this id is registered. `connection/protocol`
    /// uses it to answer `"ssh"` instead of an empty string: the host pushes
    /// `connection/connect` (which registers the connection here) before it creates
    /// the webview, so the first query already knows the protocol and the frontend
    /// stops burning its retry window on a question that never had an answer.
    pub fn has_connection(&self, connection_id: &str) -> bool {
        self.connections
            .read()
            .map(|connections| connections.contains_key(connection_id))
            .unwrap_or(false)
    }

    /// Free-text connection remark from the last lifecycle push (issue #329).
    /// Empty when the connection is unknown or the user left the field blank.
    pub fn connection_note(&self, connection_id: &str) -> String {
        self.connections
            .read()
            .ok()
            .and_then(|connections| {
                connections
                    .get(connection_id)
                    .map(|connection| connection.note.clone())
            })
            .unwrap_or_default()
    }

    pub fn store_connection(&self, connection: StoredConnection) -> Result<(), String> {
        let connection_id = connection.id.clone();
        self.connections
            .write()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .insert(connection_id.clone(), connection);
        // `connection/connect` can refresh a saved connection while a session
        // is already live. Reconcile the trigger engine immediately so turning
        // the form switch off cannot leave the old engine armed.
        let live_sessions: Vec<Arc<SessionEntry>> = self
            .sessions
            .try_read()
            .map_err(|_| "Session registry is busy".to_string())?
            .values()
            .filter(|entry| entry.connection_id == connection_id)
            .cloned()
            .collect();
        if !live_sessions.is_empty() {
            let current = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?
                .get(&connection_id)
                .cloned()
                .ok_or_else(|| "Connection disappeared after update".to_string())?;
            for entry in live_sessions {
                Self::sync_triggers(&entry, &current);
                Self::sync_auto_sudo(&entry, &current);
            }
        }
        // #202: a replayed `connection/connect` (web 刷新后宿主重新下发凭据、
        // 连接表单保存后 reopen 等) must land the runtime in the exact state a
        // fresh registration would have: auxiliary state that only
        // `close_session` / `disconnect_connection` would otherwise clean is
        // swept here, so a stale entry can never degrade or wedge the next
        // connect.
        self.sweep_reconnect_residue(&connection_id);
        Ok(())
    }

    /// Best-effort sweep of stale per-connection / per-session auxiliary
    /// state after `connection/connect` re-registered `connection_id`
    /// (issue #202). Best-effort on purpose: a contended session registry
    /// must never fail the lifecycle push, and every swept entry has a
    /// normal owner (`close_session` / `disconnect_connection`) that would
    /// clean it anyway on the ordinary path.
    fn sweep_reconnect_residue(&self, connection_id: &str) {
        let Ok(sessions) = self.sessions.try_read() else {
            return;
        };
        let live_session_ids: std::collections::HashSet<String> =
            sessions.keys().cloned().collect();
        let connection_has_live_session = sessions
            .values()
            .any(|entry| entry.connection_id == connection_id);
        drop(sessions);
        // Sudo keepalive pinned to a session that no longer exists: the
        // stale loop keeps validating against a dead transport, and the old
        // `contains_key` early-return would mute the next session's own
        // keepalive until the stale one died off on its own.
        if let Ok(mut keepalive) = self.sudo_keepalive.lock() {
            let stale = match keepalive.get(connection_id) {
                Some(entry) => !live_session_ids.contains(&entry.session_id),
                None => false,
            };
            if stale {
                if let Some(entry) = keepalive.remove(connection_id) {
                    entry.task.abort();
                }
            }
        }
        // Per-connection forwarded-tcpip table without a live session can
        // never match again (same rule as close_session's backstop).
        if !connection_has_live_session {
            if let Ok(mut tables) = self.remote_tables.lock() {
                tables.remove(connection_id);
            }
        }
        // Per-session caches whose session id is no longer registered —
        // refresh-orphaned entries whose removal raced the transport death.
        // Keyed globally by session id, so prune against the full live set.
        if let Ok(mut cache) = self.metrics_cache.lock() {
            cache.retain(|session_id, _| live_session_ids.contains(session_id));
        }
        if let Ok(mut hinted) = self.compat_hinted.lock() {
            hinted.retain(|session_id| live_session_ids.contains(session_id));
        }
        if let Ok(mut probe) = self.compress_tool_probe.lock() {
            probe.retain(|session_id, _| live_session_ids.contains(session_id));
        }
    }

    pub async fn disconnect_connection(&self, connection_id: &str) -> Result<(), String> {
        // 性能档案随连接销毁（ST8/P3）：EMA/codec 观测是连接级的，重连后的
        // 链路可能完全不同，旧档案只会污染下一次顾问预测。容量封顶之外的
        // 主动清理面（任务书 §9「历史可清理」）。
        if let Ok(mut metrics) = self.transfer_metrics.lock() {
            metrics.forget(connection_id);
        }
        // Serialize against an independent forward being authenticated and
        // registered for this connection.
        let mut forward_guard = self.forward_transports.lock().await;
        self.connections
            .write()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .remove(connection_id);
        let old_transport = forward_guard.remove(connection_id);
        drop(forward_guard);
        let independent: Vec<_> = self
            .forwards
            .rows()
            .into_iter()
            .filter(|row| {
                row.connection_id == connection_id
                    && row.transport.as_ref().is_some_and(|transport| {
                        old_transport
                            .as_ref()
                            .is_some_and(|old| Arc::ptr_eq(transport, old))
                    })
            })
            .collect();
        for entry in independent {
            self.teardown_forward(&entry).await;
        }
        if let Some(transport) = old_transport {
            Self::close_forward_transport(&transport).await;
        }
        let session_ids = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for session_id in session_ids {
            let _ = self
                .close_session_with_reason(&session_id, Some("connection-disconnect"))
                .await;
        }
        self.stop_sudo_keepalive(connection_id).await;
        Ok(())
    }
}
