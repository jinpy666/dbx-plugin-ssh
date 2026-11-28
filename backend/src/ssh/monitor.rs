use super::*;

impl SshRuntime {
    /// Collects server metrics (CPU, memory, load, disks, network rates, top
    /// processes) with read-only commands; available even on read-only
    /// connections. With `cached: true`, serves the session's last snapshot
    /// (marked with `cachedAt`) when one exists — fresh collection only runs
    /// on a cache miss; every fresh result backfills the cache.
    pub async fn metrics(&self, session_id: &str, cached: bool) -> Result<Value, String> {
        if cached {
            if let Some(payload) = self.cached_metrics_snapshot(session_id) {
                return Ok(payload);
            }
        }
        let session = self.session(session_id).await?;
        let snapshot = exec::collect_metrics(&session.handle).await?;
        self.store_metrics_snapshot(session_id, &snapshot);
        // Trend-history ring: one row per fresh collection, keyed by
        // connection. Best-effort — a failed append never fails metrics.
        let sample = metrics_history::sample_from_snapshot(&session.connection_id, &snapshot);
        if let Err(error) = metrics_history::append_sample(&self.data_dir, &sample) {
            eprintln!("[ssh-trace] failed to append metrics history: {error}");
        }
        Ok(snapshot)
    }

    /// `ssh/processes/list`: full sortable process table (CPU-sorted,
    /// server-capped). Read-only commands only.
    pub async fn processes_list(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        metrics::collect_process_list(&session.handle).await
    }

    /// `ssh/processes/kill`: signals one remote process (pid/signal are
    /// validated in `metrics::kill_command`; pid 0/1 refused). Treated as a
    /// write op: refused on read-only connections like the SFTP write family.
    pub async fn kill_process(
        &self,
        session_id: &str,
        pid: u64,
        signal: u32,
    ) -> Result<Value, String> {
        self.ensure_writable(session_id).await?;
        let session = self.session(session_id).await?;
        metrics::kill_process(&session.handle, pid, signal).await?;
        Ok(json!({ "success": true, "pid": pid }))
    }

    /// `ssh/metrics/history`: persisted trend samples for the session's
    /// connection, oldest first. Pure local data — answers without a
    /// live connection.
    pub async fn metrics_history(&self, session_id: &str, limit: usize) -> Result<Value, String> {
        let connection_id = {
            let sessions = self.sessions.read().await;
            sessions
                .get(session_id)
                .map(|session| session.connection_id.clone())
                .ok_or("Session was not found")?
        };
        let samples = metrics_history::load_history(&self.data_dir, Some(&connection_id), limit);
        Ok(json!({ "connectionId": connection_id, "samples": samples }))
    }

    /// `ssh/recording/start`: attaches a cast recorder to the session's
    /// output stream. One recording per session at a time.
    pub async fn recording_start(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let host = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .map(|connection| connection.host.clone())
            .unwrap_or_default();
        let mut slot = session
            .session_recorder
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if slot.is_some() {
            return Err("This session is already being recorded".to_string());
        }
        let recording_id = Uuid::new_v4().to_string();
        let recorder = session_recording::SessionRecorder::start(
            &self.data_dir,
            &recording_id,
            &session.connection_id,
            &host,
            session_id,
            80,
            24,
        )?;
        *slot = Some(recorder);
        Ok(json!({ "recordingId": recording_id, "recording": true }))
    }

    /// `ssh/recording/stop`: finalizes the active recording (if any) and
    /// returns its summary.
    pub async fn recording_stop(&self, session_id: &str) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let recorder = session
            .session_recorder
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
            .ok_or("This session has no active recording")?;
        recorder.finish()
    }

    /// Returns the cached snapshot for a session with its `cachedAt` marker,
    /// or `None` when nothing was collected for it yet.
    pub(super) fn cached_metrics_snapshot(&self, session_id: &str) -> Option<Value> {
        let cache = self
            .metrics_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache
            .get(session_id)
            .map(|entry| cached_metrics_payload(&entry.value, entry.collected_at))
    }

    /// Backfills the snapshot cache after a fresh collection.
    pub(super) fn store_metrics_snapshot(&self, session_id: &str, snapshot: &Value) {
        let mut cache = self
            .metrics_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache.insert(
            session_id.to_string(),
            CachedMetrics {
                value: snapshot.clone(),
                collected_at: unix_now_secs(),
            },
        );
    }
}
