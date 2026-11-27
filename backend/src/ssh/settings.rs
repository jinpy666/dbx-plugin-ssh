use super::*;

impl SshRuntime {
    /// Reads the live Quick Sudo / 2FA settings for a session's connection.
    /// `ssh/settings/get`: workbench settings view. Secret presence is
    /// reported as boolean flags only; passing `revealSecrets: true` adds
    /// the raw `sudoPassword` / `totpSecret` configured on the connection
    /// so the settings dialog can prefill what the user stored (values
    /// never leave the user's own workbench; the MCP surface has no
    /// reveal parameter and keeps flag-only responses).
    pub async fn settings_get(&self, session_id: &str, params: &Value) -> Result<Value, String> {
        let reveal = params
            .get("revealSecrets")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let session = self.session(session_id).await?;
        let connection = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&session.connection_id)
            .cloned();
        let auth = session
            .orchestration
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let store = sudo_profiles::load_store(&self.data_dir);
        let profile = connection
            .as_ref()
            .and_then(|connection| effective_sudo_profile(connection, &store));
        let mut view = json!({
            "quickSudo": connection.as_ref().map(|c| c.sudo_enabled()).unwrap_or(true),
            "sudoSource": connection
                .as_ref()
                .map(|c| c.sudo_source.name())
                .unwrap_or("custom"),
            "sudoUsePty": sudo_profiles::effective_use_pty(
                connection.as_ref().map(|c| c.sudo_use_pty).unwrap_or(false),
                profile.as_ref(),
            ),
            "sudoPasswordSet": !auth.password.is_empty(),
            "totpConfigured": auth.totp_configured(),
            "authFlowMode": auth.flow_mode.map(flow_mode_name).unwrap_or("password_then_otp"),
            "passwordPromptHint": auth.password_prompt_hint,
            "totpPromptHint": auth.totp_prompt_hint,
            "quickSudoProfileId": profile.as_ref().map(|p| p.id.clone()).unwrap_or_default(),
            "quickSudoProfileName": profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            "agentTerminalMode": self.agent_terminal_mode(&session.connection_id).name(),
            // Remembered approvals (IMPL_PLAN §2.2): raw pattern lines the
            // user saved from the approval dialog; editable/wildcard-able in
            // the settings panel, matched with the sudoers-style token rules.
            "rememberedCommands": agent_approvals::list_lines(
                &agent_approvals::load_store(&self.data_dir),
                &session.connection_id,
            ),
        });
        if reveal {
            if let Some(connection) = &connection {
                view["sudoPassword"] = Value::String(connection.sudo_password.clone());
                view["totpSecret"] = Value::String(connection.totp_secret.clone());
            }
        }
        Ok(view)
    }

    /// Updates Quick Sudo / 2FA settings at runtime: applies to the stored
    /// connection and every live session of that connection immediately
    /// (terminal auto-answer and exec re-read the shared orchestration).
    /// Values are sidecar-local; reopening the connection from DBX restores
    /// the host-provided configuration. `quickSudoProfileId` switches the
    /// credential source between this connection's own values ("") and a
    /// globally bound Quick Sudo profile; the binding is persisted in the
    /// plugin data directory, so it survives sidecar restarts. While a
    /// profile is bound it owns the credential source wholesale — per-field
    /// updates still land on the stored connection but live sessions follow
    /// the profile.
    pub async fn settings_set(&self, session_id: &str, updates: &Value) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let connection_id = session.connection_id.clone();
        let binding_update = updates
            .get("quickSudoProfileId")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(profile_id) = binding_update.clone() {
            // Validate and persist before touching anything else, so an
            // unknown profile leaves the request without side effects.
            let mut store = sudo_profiles::load_store(&self.data_dir);
            sudo_profiles::set_binding(
                &mut store,
                &connection_id,
                (!profile_id.is_empty()).then_some(profile_id.as_str()),
            )?;
            sudo_profiles::save_store(&self.data_dir, &store)?;
        }
        // AI terminal mode: validated strictly before anything else mutates,
        // so an unknown value leaves the request without side effects. The
        // set persists too — a failed write reports instead of silently
        // dropping the toggle on the next restart.
        if let Some(raw) = updates.get("agentTerminalMode") {
            let text = raw
                .as_str()
                .ok_or("agentTerminalMode must be a string (off|auto|strict)")?;
            let mode = AgentTerminalMode::parse_exact(text)?;
            self.set_agent_terminal_mode(&connection_id, mode)?;
        }
        // Remembered approvals: full-replacement list from the settings
        // panel. Validated (caps / destructive-line rejection with line
        // numbers) before anything else mutates, so a bad line leaves the
        // request without side effects.
        if let Some(raw) = updates.get("rememberedCommands") {
            let values = raw
                .as_array()
                .ok_or("rememberedCommands must be an array of strings")?;
            let lines: Vec<String> = values
                .iter()
                .map(|value| value.as_str().unwrap_or_default().trim().to_string())
                .collect();
            let mut store = agent_approvals::load_store(&self.data_dir);
            agent_approvals::set_lines(&mut store, &connection_id, &lines)?;
            agent_approvals::save_store(&self.data_dir, &store)?;
        }
        let login_password = {
            let connections = self
                .connections
                .read()
                .map_err(|_| "Connection registry is poisoned".to_string())?;
            connections
                .get(&connection_id)
                .map(|connection| connection.password.clone())
        };

        let optional_string = |key: &str| {
            updates
                .get(key)
                .and_then(Value::as_str)
                .map(|value| value.trim().to_string())
        };
        // Prompt hints are sanitized (control characters/ANSI stripped,
        // length capped) before they touch the stored connection or any
        // live session; malformed input degrades instead of poisoning the
        // prompt classifier. Flow modes and TOTP secrets keep the
        // connect-time parse fallbacks (AuthFlowMode::parse / parse_totp_secrets).
        let hint_string = |key: &str| {
            updates
                .get(key)
                .and_then(Value::as_str)
                .map(exec::sanitize_prompt_hint)
        };

        // Persist flags and secrets on the stored connection.
        {
            let mut connections = self
                .connections
                .write()
                .map_err(|_| "Connection registry is poisoned".to_string())?;
            if let Some(connection) = connections.get_mut(&connection_id) {
                if let Some(value) = updates.get("quickSudo").and_then(Value::as_bool) {
                    // Session toggle: off wins outright; re-enabling an off
                    // connection returns to this connection's own values.
                    connection.sudo_source = match (value, connection.sudo_source) {
                        (false, _) => SudoSource::Off,
                        (true, SudoSource::Off) => SudoSource::Custom,
                        (true, source) => source,
                    };
                }
                // A binding change doubles as a source change: picking a
                // profile switches the connection to "global"; clearing it
                // falls back to this connection's own values ("custom"),
                // while an explicit "off" stays off.
                if let Some(profile_id) = binding_update.clone() {
                    if profile_id.is_empty() {
                        if connection.sudo_source == SudoSource::Global {
                            connection.sudo_source = SudoSource::Custom;
                        }
                    } else {
                        connection.sudo_source = SudoSource::Global;
                    }
                }
                if let Some(value) = updates.get("sudoUsePty").and_then(Value::as_bool) {
                    connection.sudo_use_pty = value;
                }
                if let Some(value) = optional_string("sudoPassword") {
                    connection.sudo_password = value;
                }
                if let Some(value) = optional_string("totpSecret") {
                    connection.totp_secret = value;
                }
                if let Some(value) = hint_string("passwordPromptHint") {
                    connection.password_prompt_hint = value;
                }
                if let Some(value) = hint_string("totpPromptHint") {
                    connection.totp_prompt_hint = value;
                }
                if let Some(value) = optional_string("authFlowMode") {
                    connection.auth_flow_mode = value;
                }
            }
        }

        // Apply to every live session of the connection, field by field so
        // in-flight OTP usage bookkeeping survives unrelated updates.
        let session_entries: Vec<Arc<SessionEntry>> = self
            .sessions
            .read()
            .await
            .values()
            .filter(|entry| entry.connection_id == connection_id)
            .cloned()
            .collect();
        for entry in &session_entries {
            let mut auth = entry
                .orchestration
                .write()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(value) = optional_string("sudoPassword") {
                auth.password = if value.is_empty() {
                    login_password.clone().unwrap_or_default()
                } else {
                    value
                };
            }
            if let Some(value) = optional_string("totpSecret") {
                auth.totp_secrets = exec::parse_totp_secrets(&value);
            }
            if let Some(value) = hint_string("passwordPromptHint") {
                auth.password_prompt_hint = value;
            }
            if let Some(value) = hint_string("totpPromptHint") {
                auth.totp_prompt_hint = value;
            }
            if let Some(value) = optional_string("authFlowMode") {
                auth.flow_mode = (!value.is_empty()).then(|| AuthFlowMode::parse(&value));
            }
        }
        // Credential/flag changes can arm or disarm the in-terminal watcher:
        // a password configured after connecting must start answering.
        if let Some(connection) = self
            .connections
            .read()
            .map_err(|_| "Connection registry is poisoned".to_string())?
            .get(&connection_id)
            .cloned()
        {
            for entry in &session_entries {
                Self::sync_auto_sudo(entry, &connection);
                Self::sync_triggers(entry, &connection);
            }
        }
        // A binding change owns the live sessions' credential source: rebuild
        // their orchestration from the now-effective source (the per-field
        // updates above still landed on the stored connection for later).
        // Clearing the binding rebuilds too, so sessions immediately fall
        // back to the connection's own values.
        if updates
            .get("quickSudoProfileId")
            .and_then(Value::as_str)
            .is_some()
        {
            self.refresh_bound_sessions(std::slice::from_ref(&connection_id))
                .await;
        }
        self.settings_get(session_id, updates).await
    }

    /// `sudo/profiles/list`: every global Quick Sudo profile as a
    /// secret-free view.
    pub fn profiles_list(&self) -> Value {
        let store = sudo_profiles::load_store(&self.data_dir);
        json!({ "profiles": sudo_profiles::list_views(&store) })
    }

    /// `sudo/profiles/reveal`: workbench-only view of one profile including
    /// its raw secrets, so the profile editor can prefill what the user
    /// stored. Deliberately not exposed as an MCP tool — agent contexts
    /// keep seeing flags only.
    pub fn profiles_reveal(&self, id: &str) -> Result<Value, String> {
        let store = sudo_profiles::load_store(&self.data_dir);
        sudo_profiles::reveal_profile(&store, id)
    }

    /// `ssh/quickCommands/list`: global quick commands shared by every
    /// connection and workbench.
    pub fn quick_commands_list(&self) -> Value {
        let store = quick_commands::load_store(&self.data_dir);
        json!({ "commands": quick_commands::list_views(&store) })
    }

    /// `ssh/quickCommands/save`: creates or updates one global quick command.
    /// Returns the saved entry, whether it was newly created, and the full
    /// list so the workbench can adopt the authoritative order in one call.
    pub fn quick_commands_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = quick_commands::load_store(&self.data_dir);
        let (entry, created) = quick_commands::save_entry(&mut store, params)?;
        quick_commands::save_store(&self.data_dir, &store)?;
        Ok(json!({
            "quickCommand": quick_commands::entry_view(&entry),
            "created": created,
            "commands": quick_commands::list_views(&store),
        }))
    }

    /// `ssh/quickCommands/delete`: removes one global quick command; unknown
    /// ids report `removed: false` instead of erroring. The store file is
    /// only rewritten when something was actually removed.
    pub fn quick_commands_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = quick_commands::load_store(&self.data_dir);
        let removed = quick_commands::delete_entry(&mut store, id);
        if removed {
            quick_commands::save_store(&self.data_dir, &store)?;
        }
        Ok(json!({
            "removed": removed,
            "commands": quick_commands::list_views(&store),
        }))
    }

    /// `ssh/highlightRules/list`: terminal keyword highlight rules shared by
    /// every workbench, `createdAt` ascending. A fresh data dir is seeded
    /// with the first-run default rules (see `highlight_rules::load_or_seed_store`).
    pub fn highlight_rules_list(&self) -> Value {
        let store = highlight_rules::load_or_seed_store(&self.data_dir);
        json!({ "rules": highlight_rules::list_views(&store) })
    }

    /// `ssh/highlightRules/save`: creates or updates one keyword rule.
    /// Returns the saved rule, whether it was newly created, and the full
    /// list so the workbench adopts the authoritative order in one call.
    /// Seeds the first-run defaults when the store file does not exist yet,
    /// so a first-save on a fresh install keeps them.
    pub fn highlight_rules_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = highlight_rules::load_or_seed_store(&self.data_dir);
        let (entry, created) = highlight_rules::save_entry(&mut store, params)?;
        highlight_rules::save_store(&self.data_dir, &store)?;
        Ok(json!({
            "rule": highlight_rules::entry_view(&entry),
            "created": created,
            "rules": highlight_rules::list_views(&store),
        }))
    }

    /// `ssh/highlightRules/delete`: removes one keyword rule; unknown ids
    /// report `removed: false` without rewriting the file.
    pub fn highlight_rules_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = highlight_rules::load_store(&self.data_dir);
        let removed = highlight_rules::delete_entry(&mut store, id);
        if removed {
            highlight_rules::save_store(&self.data_dir, &store)?;
        }
        Ok(json!({
            "removed": removed,
            "rules": highlight_rules::list_views(&store),
        }))
    }

    /// `sudo/profiles/options`: secret-free select options for the host
    /// connection form (`sudo_profile` field declares this as its
    /// `options_action`). Value is the profile id (what `sudo_profile_ref`
    /// stores); the label is the human-readable name. Hosts without
    /// `options_action` support never call this and keep the text fallback.
    pub fn profiles_options(&self) -> Value {
        let store = sudo_profiles::load_store(&self.data_dir);
        json!({
            "options": sudo_profiles::list_views(&store)
                .into_iter()
                .map(|view| {
                    json!({
                        "value": view["id"],
                        "label": view["name"],
                    })
                })
                .collect::<Vec<_>>(),
        })
    }

    /// `sudo/profiles/save`: create or update a global profile, then hot
    /// reload every live session bound to it.
    pub async fn profiles_save(&self, params: &Value) -> Result<Value, String> {
        let mut store = sudo_profiles::load_store(&self.data_dir);
        let (profile, created) = sudo_profiles::save_profile(&mut store, params)?;
        sudo_profiles::save_store(&self.data_dir, &store)?;
        let bound: Vec<String> = store
            .bindings
            .iter()
            .filter(|(_, bound_id)| bound_id.as_str() == profile.id.as_str())
            .map(|(connection_id, _)| connection_id.clone())
            .collect();
        self.refresh_bound_sessions(&bound).await;
        Ok(json!({
            "profile": sudo_profiles::profile_view(&profile),
            "created": created,
        }))
    }

    /// `sudo/profiles/delete`: remove a global profile (bindings cascade)
    /// and drop the override from every live session that used it.
    pub async fn profiles_delete(&self, id: &str) -> Result<Value, String> {
        let mut store = sudo_profiles::load_store(&self.data_dir);
        let bound: Vec<String> = store
            .bindings
            .iter()
            .filter(|(_, bound_id)| bound_id.as_str() == id)
            .map(|(connection_id, _)| connection_id.clone())
            .collect();
        let removed = sudo_profiles::delete_profile(&mut store, id);
        if removed {
            sudo_profiles::save_store(&self.data_dir, &store)?;
            self.refresh_bound_sessions(&bound).await;
        }
        Ok(json!({ "success": true, "removed": removed }))
    }

    /// Re-arms or disarms a session's in-terminal Quick Sudo watcher from the
    /// connection's current state: Quick Sudo on, connection writable, and
    /// the resolved auth actually holding a credential (password or TOTP).
    /// Runs at session open and after every runtime settings/profile update,
    /// so a password configured after connecting still starts answering
    /// prompts without a reconnect. Re-arming starts from fresh prompt state,
    /// which matches the user having just changed the configuration.
    pub(super) fn sync_auto_sudo(entry: &SessionEntry, connection: &StoredConnection) {
        let useful = entry
            .orchestration
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .useful();
        let attach = connection.sudo_enabled() && !connection.read_only && useful;
        let mut watcher = entry
            .auto_sudo
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if attach && watcher.is_none() {
            let mut auto = exec::TerminalAutoSudo::new(entry.orchestration.clone());
            // A connection whose `remote_command` runs sudo replaces the shell,
            // so no typed line ever reaches the watcher: seed the context from
            // the configuration or the bare `Password:` prompt goes unanswered.
            auto.seed_sudo_context(exec::remote_command_invokes_sudo(
                &connection.remote_command,
            ));
            *watcher = Some(auto);
        } else if !attach && watcher.is_some() {
            // Disarm transitions are logged so "why didn't the terminal
            // auto-answer" is diagnosable from the sidecar log alone.
            eprintln!(
                "[ssh] terminal auto-sudo disarmed: sudoSource={}, readOnly={}, credentials configured={}",
                connection.sudo_source.name(),
                connection.read_only,
                useful,
            );
            *watcher = None;
        }
    }

    /// Attaches or detaches a session's expect-style trigger engine from the
    /// connection's `triggers` configuration (contract §3.1: mirrors
    /// `sync_auto_sudo`). Runs at session open and after every runtime
    /// settings/profile update, so a configuration that lands on the
    /// connection later still arms without a reconnect.
    pub(super) fn sync_triggers(entry: &SessionEntry, connection: &StoredConnection) {
        let mut engine = entry
            .triggers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match (
            (connection.triggers_enabled)
                .then_some(connection.triggers.as_ref())
                .flatten(),
            engine.is_some(),
        ) {
            (Some(config), false) => {
                *engine = Some(triggers::TriggerEngine::new(
                    config.clone(),
                    triggers::CommandPlaceholders::new(
                        &connection.host,
                        &connection.username,
                        connection.port,
                        connection.name.as_deref().unwrap_or(&connection.id),
                    ),
                ));
            }
            (None, true) => {
                *engine = None;
            }
            _ => {}
        }
    }

    /// Rebuilds the Quick Sudo auth of every live session of the given
    /// connections from the current registry state plus each connection's
    /// bound profile. Field-by-field assignment keeps each auth's OTP usage
    /// bookkeeping intact.
    pub(super) async fn refresh_bound_sessions(&self, connection_ids: &[String]) {
        if connection_ids.is_empty() {
            return;
        }
        let store = sudo_profiles::load_store(&self.data_dir);
        let sessions = self.sessions.read().await;
        for entry in sessions.values() {
            if !connection_ids.iter().any(|id| id == &entry.connection_id) {
                continue;
            }
            let connection = self
                .connections
                .read()
                .ok()
                .and_then(|registry| registry.get(&entry.connection_id).cloned());
            let Some(connection) = connection else {
                continue;
            };
            let profile = effective_sudo_profile(&connection, &store);
            let auth = resolved_sudo_auth(&connection, profile.as_ref());
            {
                let mut orchestration = entry
                    .orchestration
                    .write()
                    .unwrap_or_else(|poison| poison.into_inner());
                orchestration.password = auth.password;
                orchestration.totp_secrets = auth.totp_secrets;
                orchestration.password_prompt_hint = auth.password_prompt_hint;
                orchestration.totp_prompt_hint = auth.totp_prompt_hint;
                orchestration.flow_mode = auth.flow_mode;
            }
            // A binding switch can arm or disarm the terminal watcher too.
            Self::sync_auto_sudo(entry, &connection);
            Self::sync_triggers(entry, &connection);
        }
    }
}
