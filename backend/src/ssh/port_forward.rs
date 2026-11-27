use super::*;

impl SshRuntime {
    /// Per-connection remote-forward table, created on first use. The dial
    /// path hands the same Arc to the SSH client handler; remote forward
    /// start inserts the rows the handler later matches against.
    pub(super) fn remote_table_for(&self, connection_id: &str) -> Arc<RemoteForwardTable> {
        let mut tables = self
            .remote_tables
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        tables
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(HashMap::new())))
            .clone()
    }

    /// `ssh/forward/list`: live mappings, optionally scoped to one connection
    /// or session. Read-only — liveness counters update as relays come and go.
    pub fn forward_list(&self, params: &Value) -> Value {
        let connection_id = params.get("connectionId").and_then(Value::as_str);
        let session_id = params.get("sessionId").and_then(Value::as_str);
        let mut rows: Vec<Value> = self
            .forwards
            .rows()
            .iter()
            .filter(|entry| connection_id.is_none_or(|id| entry.connection_id == id))
            .filter(|entry| session_id.is_none_or(|id| entry.session_id == id))
            .map(|entry| entry.payload())
            .collect();
        rows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({ "forwards": rows })
    }

    /// `ssh/forward/start`: validate, register, then arm the direction —
    /// local binds the port before the mapping is reported active, remote
    /// asks the server to listen first (a refusal removes the mapping again).
    pub async fn forward_start(
        &self,
        params: &Value,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let session_id = params.get("sessionId").and_then(Value::as_str);
        let session = if let Some(id) = session_id {
            Some(self.session(id).await?)
        } else {
            None
        };
        let connection_id = if let Some(session) = &session {
            session.connection_id.clone()
        } else {
            params
                .get("connectionId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or("sessionId or connectionId is required")?
                .to_string()
        };
        let (kind, listen_host, listen_port, target_host, target_port) =
            forward::parse_spec(params)?;
        // Conflict pre-check ahead of bind/tcpip-forward, so a duplicate gets
        // a naming error instead of a raw "address already in use" (local) or
        // a server-side refusal (remote). Local endpoints collide on the one
        // client machine — every connection; remote endpoints collide per
        // server — same connection only.
        if listen_port != 0 {
            let conflicting = self.forwards.rows().into_iter().find(|row| {
                (kind == forward::ForwardKind::Remote
                    && row.kind == forward::ForwardKind::Remote
                    && row.connection_id == connection_id
                    || kind != forward::ForwardKind::Remote
                        && row.kind != forward::ForwardKind::Remote)
                    && forward::listen_endpoints_conflict(
                        &listen_host,
                        listen_port,
                        &row.listen_host,
                        row.listen_port,
                    )
            });
            if let Some(row) = conflicting {
                let endpoint = format!("{listen_host}:{listen_port}");
                let existing = forward::describe(
                    row.kind,
                    &row.listen_host,
                    row.listen_port,
                    &row.target_host,
                    row.target_port,
                );
                return Err(format!(
                    "Listen endpoint {endpoint} is already forwarded by mapping {} ({existing})",
                    row.id
                ));
            }
        }
        let mut created_transport = false;
        let mut transport_guard = if session.is_none() {
            Some(self.forward_transports.lock().await)
        } else {
            None
        };
        let transport = if let Some(guard) = transport_guard.as_mut() {
            // Disconnect removes the stored connection under this same lock.
            // Recheck even when a transport already exists so a concurrent
            // start cannot resurrect a mapping after disconnect.
            let connection = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?
                .get(&connection_id)
                .cloned()
                .ok_or("Connection is not active; reopen it from DBX")?;
            if let Some(existing) = guard.get(&connection_id) {
                Some(existing.clone())
            } else {
                let connection = resolve_password_command(&connection).await;
                let (handle, jumps) = self
                    .connect_authenticated(
                        &connection,
                        &Uuid::new_v4().to_string(),
                        Some(emitter.clone()),
                    )
                    .await?;
                let created = Arc::new(forward::ForwardTransport {
                    handle: Arc::new(handle),
                    jump_chain: jumps.into_iter().map(Arc::new).collect(),
                });
                guard.insert(connection_id.clone(), created.clone());
                created_transport = true;
                Some(created)
            }
        } else {
            None
        };
        let handle = session
            .as_ref()
            .map(|session| session.handle.clone())
            .or_else(|| transport.as_ref().map(|transport| transport.handle.clone()))
            .ok_or("No SSH transport available for forwarding")?;
        let entry = Arc::new(forward::ForwardEntry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.unwrap_or("").to_string(),
            connection_id: connection_id.clone(),
            kind,
            listen_host,
            listen_port,
            target_host,
            target_port,
            transport: transport.clone(),
            bound_port: AtomicU32::new(0),
            state: Mutex::new(forward::ForwardState::Starting),
            error: Mutex::new(None),
            connections_total: AtomicU64::new(0),
            connections_active: AtomicI64::new(0),
            bytes_up: AtomicU64::new(0),
            bytes_down: AtomicU64::new(0),
            listener_task: Mutex::new(None),
            relays: Mutex::new(Vec::new()),
            emitter: Some(emitter),
            stopping: AtomicBool::new(false),
        });
        self.forwards.insert(entry.clone());
        let started: Result<(), String> = match kind {
            forward::ForwardKind::Local | forward::ForwardKind::Dynamic => {
                forward::spawn_local_listener(entry.clone(), handle.clone()).await
            }
            forward::ForwardKind::Remote => {
                async {
                    let bound = handle
                        .tcpip_forward(&entry.listen_host, u32::from(entry.listen_port))
                        .await
                        .map_err(|error| {
                            format!(
                                "Server refused to listen on {}:{}: {error}",
                                entry.listen_host, entry.listen_port
                            )
                        })?;
                    let bound = u16::try_from(bound).unwrap_or(entry.listen_port.max(1));
                    entry.bound_port.store(u32::from(bound), Ordering::Relaxed);
                    let table = self.remote_table_for(&connection_id);
                    forward::register_remote_target(
                        &table,
                        &entry.listen_host,
                        bound,
                        &entry.target_host,
                        entry.target_port,
                        entry.clone(),
                    );
                    Ok(())
                }
                .await
            }
        };
        if let Err(error) = started {
            self.forwards.remove(&entry.id);
            if let (Some(mut guard), Some(transport)) = (transport_guard.take(), transport) {
                if !self
                    .forwards
                    .rows()
                    .iter()
                    .any(|row| row.connection_id == connection_id && row.transport.is_some())
                {
                    guard.remove(&connection_id);
                    drop(guard);
                    Self::close_forward_transport(&transport).await;
                }
            }
            return Err(error);
        }
        drop(transport_guard);
        if created_transport {
            if let Some(transport) = transport {
                self.monitor_forward_transport(connection_id, transport);
            }
        }
        forward::set_state(&entry, forward::ForwardState::Active, None);
        Ok(json!({ "forward": entry.payload() }))
    }

    /// A network loss does not send connection/disconnect from the host. Drop
    /// listeners and registry rows when the underlying SSH transport closes.
    fn monitor_forward_transport(
        &self,
        connection_id: String,
        transport: Arc<forward::ForwardTransport>,
    ) {
        let transports = self.forward_transports.clone();
        let forwards = self.forwards.clone();
        let remote_tables = self.remote_tables.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let mut guard = transports.lock().await;
                if !guard
                    .get(&connection_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &transport))
                {
                    break;
                }
                if !transport.handle.is_closed() {
                    continue;
                }
                guard.remove(&connection_id);
                drop(guard);
                for entry in forwards.rows().into_iter().filter(|entry| {
                    entry
                        .transport
                        .as_ref()
                        .is_some_and(|owner| Arc::ptr_eq(owner, &transport))
                }) {
                    forward::abort_tasks(&entry);
                    forwards.remove(&entry.id);
                    forward::set_state(
                        &entry,
                        forward::ForwardState::Stopped,
                        Some("SSH transport closed".to_string()),
                    );
                    if entry.kind == forward::ForwardKind::Remote {
                        if let Some(table) = remote_tables
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .get(&connection_id)
                        {
                            table
                                .lock()
                                .unwrap_or_else(|poison| poison.into_inner())
                                .retain(|_, target| target.entry.id != entry.id);
                        }
                    }
                }
                for jump in &transport.jump_chain {
                    let _ = jump
                        .disconnect(Disconnect::ByApplication, "SSH transport closed", "English")
                        .await;
                }
                break;
            }
        });
    }

    /// `ssh/forward/stop`: tear the mapping down and report the final row.
    pub async fn forward_stop(&self, id: &str) -> Result<Value, String> {
        let entry = self
            .forwards
            .get(id)
            .ok_or("Port mapping was not found or already stopped")?;
        self.teardown_forward(&entry).await;
        Ok(json!({ "success": true, "forward": entry.payload() }))
    }

    /// Tears one mapping down: background tasks aborted, remote listener
    /// cancelled on the session's SSH handle (best effort — a dead session
    /// cannot cancel anything and does not need to), table row removed, and
    /// the registry drops the entry so a stopped id cannot be restarted into.
    pub(super) async fn teardown_forward(&self, entry: &Arc<forward::ForwardEntry>) {
        forward::abort_tasks(entry);
        if entry.kind == forward::ForwardKind::Remote {
            let handle = if let Some(transport) = &entry.transport {
                Some(transport.handle.clone())
            } else {
                self.sessions
                    .read()
                    .await
                    .get(&entry.session_id)
                    .map(|session| session.handle.clone())
            };
            if let Some(handle) = handle {
                let port = entry.bound_port.load(Ordering::Relaxed);
                let port = if port == 0 {
                    u32::from(entry.listen_port)
                } else {
                    port
                };
                let _ = handle.cancel_tcpip_forward(&entry.listen_host, port).await;
            }
            if let Some(table) = self
                .remote_tables
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&entry.connection_id)
            {
                table
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .retain(|_, target| target.entry.id != entry.id);
            }
        }
        self.forwards.remove(&entry.id);
        forward::set_state(entry, forward::ForwardState::Stopped, None);
        if let Some(transport) = &entry.transport {
            let mut guard = self.forward_transports.lock().await;
            let has_other = self
                .forwards
                .rows()
                .iter()
                .any(|row| row.connection_id == entry.connection_id && row.transport.is_some());
            if !has_other
                && guard
                    .get(&entry.connection_id)
                    .is_some_and(|current| Arc::ptr_eq(current, transport))
            {
                guard.remove(&entry.connection_id);
                drop(guard);
                Self::close_forward_transport(transport).await;
            }
        }
    }

    pub(super) async fn close_forward_transport(transport: &forward::ForwardTransport) {
        let _ = transport
            .handle
            .disconnect(
                Disconnect::ByApplication,
                "DBX SSH forwarding stopped",
                "English",
            )
            .await;
        for jump in &transport.jump_chain {
            let _ = jump
                .disconnect(
                    Disconnect::ByApplication,
                    "DBX SSH forwarding stopped",
                    "English",
                )
                .await;
        }
    }

    /// Session teardown: every mapping of the session dies with it. Called
    /// from `close_session` while the session's SSH handle is still
    /// resolvable, so remote listeners are cancelled on the way out.
    pub async fn stop_session_forwards(&self, session_id: &str) {
        for entry in self
            .forwards
            .rows()
            .iter()
            .filter(|row| row.session_id == session_id)
        {
            self.teardown_forward(entry).await;
        }
    }
}
