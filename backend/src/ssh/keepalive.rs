use super::state::KeepaliveRegistration;
use super::*;

impl SshRuntime {
    /// Starts a per-connection `sudo -nv` refresh loop after a successful
    /// sudo execution. The loop runs every [`exec::SUDO_KEEPALIVE_INTERVAL`]
    /// (4 minutes), stops itself after
    /// [`exec::SUDO_KEEPALIVE_MAX_FAILURES`] consecutive validation failures,
    /// and is aborted deterministically on disconnect / session cleanup via
    /// [`Self::stop_sudo_keepalive`]. Per connection single-instance: a
    /// repeat registration while one is live is a no-op.
    /// Registration decision for `register_sudo_keepalive` (pure for tests):
    /// an entry bound to the same live session is reused as-is; an entry bound
    /// to another (typically dead) session is replaced — the old early-return
    /// on any existing entry would silently drop the new session's keepalive
    /// after a reconnect (#202).
    pub(super) fn keepalive_registration_plan(
        existing_session: Option<&str>,
        incoming_session: &str,
    ) -> KeepaliveRegistration {
        match existing_session {
            Some(existing) if existing == incoming_session => KeepaliveRegistration::ReuseExisting,
            Some(_) => KeepaliveRegistration::ReplaceStale,
            None => KeepaliveRegistration::InsertFresh,
        }
    }

    /// 只读访问器：该连接是否已有存活的 sudo 时间戳预热循环。容器终端
    /// （B5）用它决定能否以 `sudo -n` 前缀打开 PTY——绝不注入 sudo 密码。
    pub fn has_warm_sudo(&self, connection_id: &str) -> bool {
        self.sudo_keepalive
            .lock()
            .map(|keepalive| keepalive.contains_key(connection_id))
            .unwrap_or(false)
    }

    pub(super) fn register_sudo_keepalive(
        &self,
        connection_id: &str,
        session_id: &str,
        handle: Arc<Handle<SshClient>>,
    ) {
        let mut keepalive = match self.sudo_keepalive.lock() {
            Ok(keepalive) => keepalive,
            Err(_) => return,
        };
        let existing_session = keepalive
            .get(connection_id)
            .map(|entry| entry.session_id.as_str());
        if matches!(
            Self::keepalive_registration_plan(existing_session, session_id),
            KeepaliveRegistration::ReuseExisting
        ) {
            return;
        }
        // Drop the stale entry and stop its loop before arming the new one.
        if let Some(existing) = keepalive.remove(connection_id) {
            existing.task.abort();
        }
        let interval = exec::SUDO_KEEPALIVE_INTERVAL;
        let registry = self.sudo_keepalive.clone();
        let id = connection_id.to_string();
        let task_handle = handle.clone();
        let task = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut failures = 0_u32;
            loop {
                ticker.tick().await;
                let succeeded = exec::validate_sudo_timestamp(&task_handle).await.is_ok();
                match exec::keepalive_failure_step(failures, succeeded) {
                    Some(next) => {
                        if next != 0 {
                            eprintln!(
                                "[ssh] sudo keepalive for {id}: timestamp validation failed ({next}/{})",
                                exec::SUDO_KEEPALIVE_MAX_FAILURES
                            );
                        }
                        failures = next;
                    }
                    None => {
                        eprintln!(
                            "[ssh] sudo keepalive for {id}: {} consecutive validation failures, stopping (sudo timestamp expired)",
                            exec::SUDO_KEEPALIVE_MAX_FAILURES
                        );
                        if let Ok(mut keepalive) = registry.lock() {
                            keepalive.remove(&id);
                        }
                        break;
                    }
                }
            }
        });
        keepalive.insert(
            connection_id.to_string(),
            SudoKeepalive {
                session_id: session_id.to_string(),
                task,
            },
        );
    }

    pub(super) async fn stop_sudo_keepalive(&self, connection_id: &str) {
        let entry = self
            .sudo_keepalive
            .lock()
            .ok()
            .and_then(|mut keepalive| keepalive.remove(connection_id));
        if let Some(entry) = entry {
            entry.task.abort();
        }
    }
}
