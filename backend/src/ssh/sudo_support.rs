use super::*;

/// 绑定的 OTP 库条目（经共享防重放缓存，同窗口码不重复发出）→ 既有
/// Quick Sudo 全局/自定义链（完全不动，见 `login_sudo_auth`/`apply_profile`）。
fn sudo_auth_for(connection: &StoredConnection) -> SudoAuth {
    let mut auth = SudoAuth::new(
        &connection.sudo_password,
        &connection.password,
        &connection.totp_secret,
        Hints {
            password: exec::sanitize_prompt_hint(&connection.password_prompt_hint),
            totp: exec::sanitize_prompt_hint(&connection.totp_prompt_hint),
            flow_mode: (!connection.auth_flow_mode.is_empty())
                .then(|| AuthFlowMode::parse(&connection.auth_flow_mode)),
        },
    );
    auth.otp_ledger_scope =
        exec::otp_ledger_scope_for(&connection.username, &connection.host, connection.port);
    if auth.totp_secrets.is_empty() && auth.flow_mode != Some(AuthFlowMode::Off) {
        // 本窗口码已被 otp/generate（或一次应答）发出时 take 返回 None：
        // 等下一周期，期间保持现状链（不追加、不报错）。
        if let Some(bound) = otp_store::data_dir()
            .and_then(|dir| otp_store::take_connection_totp_key(&dir, &connection.id))
        {
            auth.totp_secrets.push(otp_bound_as_totp_secret(bound));
        }
    }
    auth
}

/// 把绑定条目的解析结果映射为 exec 编排的 TOTP 密钥（算法/位数/周期原样）。
fn otp_bound_as_totp_secret(bound: otp_store::BoundTotp) -> exec::TotpSecret {
    exec::TotpSecret::Key {
        key: bound.key,
        digits: u32::from(bound.digits),
        period: bound.period,
        algorithm: match bound.algorithm {
            otp::OtpAlgorithm::Sha1 => exec::TotpAlgorithm::Sha1,
            otp::OtpAlgorithm::Sha256 => exec::TotpAlgorithm::Sha256,
            otp::OtpAlgorithm::Sha512 => exec::TotpAlgorithm::Sha512,
        },
    }
}

/// Builds the client negotiation config for one connection. The connection
/// form carries no algorithm selector: every connection offers the full
/// supported set (see `ssh_algorithms::preferred`). DH GEX group bounds
/// mirror ssh(1)'s 2048/3072/8192 because russh's 3072-bit default minimum
/// rejects appliances whose largest moduli are 2048 bits, and russh aborts
/// the handshake when the returned prime falls outside these bounds.
pub(super) fn ssh_client_config(connection: &StoredConnection) -> client::Config {
    client::Config {
        nodelay: true,
        keepalive_interval: (connection.keepalive_interval_secs > 0)
            .then(|| Duration::from_secs(connection.keepalive_interval_secs)),
        keepalive_max: 3,
        preferred: ssh_algorithms::preferred(),
        gex: client::GexParams::new(2048, 3072, 8192).expect("static GEX bounds are valid"),
        ..Default::default()
    }
}

/// Translates the opaque handshake errors legacy appliances produce into a
/// hint that names the likely device gap, without pretending the cause is
/// certain (russh reports several KEX framing failures as `KexInit` too).
pub(super) fn dial_error_message(error: russh::Error) -> String {
    let base = format!("SSH connection failed: {error}");
    match error {
        russh::Error::KexInit => format!(
            "{base}. The server aborted key exchange; on legacy appliances this \
             usually means its DH moduli are smaller than the requested group \
             size (2048-bit minimum) or it only offers algorithms this client \
             does not implement"
        ),
        _ => base,
    }
}

/// Resolved Quick Sudo source for one connection: the connection's own
/// credential pipeline, overridden wholesale by the globally bound profile
/// when one is bound ("select a global config or use this connection's own").
pub(crate) fn resolved_sudo_auth(
    connection: &StoredConnection,
    profile: Option<&sudo_profiles::SudoProfile>,
) -> SudoAuth {
    let mut auth = sudo_auth_for(connection);
    if let Some(profile) = profile {
        sudo_profiles::apply_profile(&mut auth, profile, &connection.password);
    }
    auth
}

/// Credentials for the *login* keyboard-interactive exchange. The flow mode,
/// TOTP secrets and prompt hints follow the same effective source as Quick
/// Sudo, with one distinction that mirrors the connection form:
///
/// * `global` — the form hides the 2FA four-piece set because the profile owns
///   those credentials, so the profile replaces the connection's values
///   wholesale (a fresh global connection still carries the `off` default).
/// * `custom` — the form shows the fields, so an explicitly configured
///   connection value wins and the bound profile (0.4.x legacy binding) only
///   fills what the connection leaves empty.
///
/// The password half is always the login password: a login prompt answered
/// with a separate sudo password can only fail authentication, and it would
/// hand a privileged credential to the host for nothing.
pub(crate) fn login_sudo_auth(
    connection: &StoredConnection,
    profile: Option<&sudo_profiles::SudoProfile>,
) -> SudoAuth {
    let mut auth = sudo_auth_for(connection);
    if let Some(profile) = profile {
        if connection.sudo_source == SudoSource::Global {
            sudo_profiles::apply_profile(&mut auth, profile, &connection.password);
        } else {
            if auth.totp_secrets.is_empty() {
                auth.totp_secrets = exec::parse_totp_secrets(&profile.totp_secret);
            }
            if auth.password_prompt_hint.is_empty() {
                auth.password_prompt_hint =
                    exec::sanitize_prompt_hint(&profile.password_prompt_hint);
            }
            if auth.totp_prompt_hint.is_empty() {
                auth.totp_prompt_hint = exec::sanitize_prompt_hint(&profile.totp_prompt_hint);
            }
            if auth.flow_mode.is_none() && !profile.auth_flow_mode.trim().is_empty() {
                auth.flow_mode = Some(AuthFlowMode::parse(&profile.auth_flow_mode));
            }
        }
    }
    auth.password = connection.password.clone();
    auth
}

/// Placeholder context for a connection's local credential commands
/// (`%h` host, `%u` username, `%p` port, `%n` connection name or id).
fn credential_placeholders(connection: &StoredConnection) -> triggers::CommandPlaceholders {
    triggers::CommandPlaceholders::new(
        &connection.host,
        &connection.username,
        connection.port,
        connection.name.as_deref().unwrap_or(&connection.id),
    )
}

/// D9: resolves `password_command` when the connection stores no explicit
/// login password (explicit credentials always win). The command runs once
/// per dial; the log records only execution success/failure — never the
/// command or its output. Failure falls back to the empty password so the
/// auth chain can proceed (and fail) normally.
pub(super) async fn resolve_password_command(connection: &StoredConnection) -> StoredConnection {
    if !connection.password.is_empty() || connection.password_command.is_empty() {
        return connection.clone();
    }
    match triggers::run_credential_command(
        &connection.password_command,
        &credential_placeholders(connection),
    )
    .await
    {
        Ok(answer) => {
            eprintln!(
                "[ssh] password command executed for connection {}",
                connection.id
            );
            let mut resolved = connection.clone();
            resolved.password = answer.to_string();
            resolved
        }
        Err(error) => {
            eprintln!(
                "[ssh] password command failed for connection {}: {error}",
                connection.id
            );
            connection.clone()
        }
    }
}

/// D9: runs `passphrase_command` for an encrypted private key that could not
/// be decoded without a passphrase; `None` on failure (logged, output never).
pub(super) async fn resolve_passphrase_command(connection: &StoredConnection) -> Option<String> {
    match triggers::run_credential_command(
        &connection.passphrase_command,
        &credential_placeholders(connection),
    )
    .await
    {
        Ok(answer) => {
            eprintln!(
                "[ssh] passphrase command executed for connection {}",
                connection.id
            );
            Some(answer.to_string())
        }
        Err(error) => {
            eprintln!(
                "[ssh] passphrase command failed for connection {}: {error}",
                connection.id
            );
            None
        }
    }
}

/// The Quick Sudo profile in effect under the connection's declared source
/// (form field `sudo_source`): "global" resolves the form profile reference
/// first (id or exact name) and falls back to the persisted workbench
/// binding; "custom" keeps only the binding overlay (legacy parity with
/// 0.4.x, where a workbench binding owned the source); "off" never promotes
/// a profile. Unresolvable references degrade to no profile instead of
/// failing the connection.
pub(crate) fn effective_sudo_profile(
    connection: &StoredConnection,
    store: &sudo_profiles::SudoProfileStore,
) -> Option<sudo_profiles::SudoProfile> {
    match connection.sudo_source {
        SudoSource::Off => None,
        SudoSource::Custom => sudo_profiles::bound_profile(store, &connection.id).cloned(),
        SudoSource::Global => sudo_profiles::find_by_ref(store, connection.sudo_profile_ref.trim())
            .or_else(|| sudo_profiles::bound_profile(store, &connection.id))
            .cloned(),
    }
}

/// How the next SSH hop is reached: a fresh TCP connection, a
/// direct-tcpip channel tunneled through an established jump-host handle,
/// or a pre-connected stream punched through an outbound proxy (#324).
pub(super) enum DialTarget {
    Tcp((String, u16)),
    JumpStream(russh::ChannelStream<russh::client::Msg>),
    Proxied(Box<dyn crate::proxy::ProxyStream>),
}

impl DialTarget {
    pub(super) async fn through_jump(
        jump: &Handle<SshClient>,
        host: &str,
        port: u16,
    ) -> Result<Self, String> {
        let channel = jump
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await
            .map_err(|error| format!("Failed to open tunnel to {host}:{port}: {error}"))?;
        Ok(Self::JumpStream(channel.into_stream()))
    }
}
