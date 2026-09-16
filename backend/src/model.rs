use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const TERMINAL_REPLAY_LIMIT: usize = 2 * 1024 * 1024;
pub const TRANSFER_CHUNK_SIZE: usize = 256 * 1024;
pub const MAX_TRANSFER_SIZE: u64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthenticationMethod {
    Password,
    PrivateKey,
    PrivateKeyPassword,
    Agent,
    None,
}

impl AuthenticationMethod {
    fn from_connection(connection: &serde_json::Map<String, Value>) -> Result<Self, String> {
        let value = connection
            .get("external_config")
            .and_then(Value::as_object)
            .and_then(|config| config.get("authentication"))
            .and_then(Value::as_str)
            .unwrap_or("password");
        match value {
            "password" | "private-key" | "private-key-password" | "agent" | "none" => {
                Ok(Self::from_method_name(value))
            }
            _ => Err(format!("Unsupported SSH authentication method '{value}'")),
        }
    }

    fn from_method_name(value: &str) -> Self {
        match value {
            "private-key" => Self::PrivateKey,
            "private-key-password" => Self::PrivateKeyPassword,
            "agent" => Self::Agent,
            "none" => Self::None,
            _ => Self::Password,
        }
    }

    /// Canonical method name (the `external_config.authentication` spelling)
    /// for display in read-only payloads such as `ssh/sessions/list`.
    /// Deliberately excludes any credential material — names only.
    pub fn method_name(&self) -> &'static str {
        match self {
            Self::PrivateKey => "private-key",
            Self::PrivateKeyPassword => "private-key-password",
            Self::Agent => "agent",
            Self::None => "none",
            Self::Password => "password",
        }
    }
}

/// Where sudo credentials come from (connection form `sudo_source`): the
/// connection's own values ("custom"), a global Quick Sudo profile
/// ("global", resolved from `sudo_profile_ref` or the workbench binding),
/// or disabled ("off"). Legacy 0.4.x connections without the field map from
/// the old `quick_sudo` boolean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SudoSource {
    Off,
    Custom,
    Global,
}

impl SudoSource {
    /// `sudo_source` wins whenever it is present and recognized; absent,
    /// empty, or unknown values fall back to the legacy `quick_sudo` flag so
    /// existing connections keep their behavior.
    pub fn parse(value: Option<&str>, legacy_quick_sudo: bool) -> Self {
        match value.map(str::trim) {
            Some("off") => Self::Off,
            Some("global") => Self::Global,
            Some("custom") => Self::Custom,
            _ => {
                if legacy_quick_sudo {
                    Self::Custom
                } else {
                    Self::Off
                }
            }
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Custom => "custom",
            Self::Global => "global",
        }
    }
}

#[derive(Debug, Clone)]
pub struct StoredConnection {
    pub id: String,
    /// Display name from the lifecycle payload (`connection.name`); `None`
    /// for payloads without one (older hosts, inline MCP dials). Powers the
    /// `connectionName` lookup on the MCP surface and the metadata-only
    /// `ssh_list_connections` view. Never a credential.
    pub name: Option<String>,
    pub host: String,
    pub port: u16,
    pub runtime_host: String,
    pub runtime_port: u16,
    pub username: String,
    pub password: String,
    pub authentication: AuthenticationMethod,
    pub private_key_path: String,
    pub private_key_passphrase: String,
    /// Inline private key contents (`connection_secrets.private_key`), the
    /// pasted-key alternative to `private_key_path`. Non-empty content wins
    /// over the path (see `ssh.rs` key resolution); like every secret here it
    /// only travels inside the connect pipeline and is never echoed back.
    pub private_key: String,
    #[cfg_attr(windows, allow(dead_code))]
    pub agent_socket: String,
    pub connect_timeout_secs: u64,
    pub keepalive_interval_secs: u64,
    /// Interactive-terminal activity keepalive: interval in seconds for
    /// injecting space+backspace into the PTY so server-side idle policies
    /// (TMOUT, bastion keystroke audits) never fire. 0 = off; the parser
    /// clamps enabled values into 5..=3600.
    pub terminal_keepalive_secs: u64,
    pub read_only: bool,
    /// Quick Sudo orchestration: sudo password override, TOTP secret, and
    /// prompt hints. Secrets come from `connection_secrets`, tuning from
    /// `external_config`. `sudo_source` selects the credential source and
    /// `sudo_profile_ref` names the global profile when the source is global.
    pub sudo_password: String,
    pub totp_secret: String,
    pub sudo_source: SudoSource,
    pub sudo_profile_ref: String,
    pub sudo_use_pty: bool,
    /// sudoers-style per-connection sudo command allowlist
    /// (`external_config.sudo_whitelist`); empty = gate off.
    pub sudo_whitelist: Vec<String>,
    pub password_prompt_hint: String,
    pub totp_prompt_hint: String,
    pub auth_flow_mode: String,
    /// Client-specified remote environment — the `SetEnv` half of ssh's
    /// SetEnv/SendEnv pair (values come from this connection's config, never
    /// from the local process environment). Parsed and validated eagerly so
    /// malformed entries fail the connection instead of misconfiguring
    /// remote commands; applied per channel before shell/exec.
    pub set_env: Vec<(String, String)>,
    /// `ssh RemoteCommand`: exec this command instead of a shell on the
    /// interactive terminal session (PTY stays on). Empty = normal shell.
    pub remote_command: String,
    /// Independent connection-form switch for expect-style terminal triggers.
    /// It defaults to false, including for existing connections that still
    /// contain text in `external_config.triggers`.
    pub triggers_enabled: bool,
    /// Expect-style terminal triggers (tssh parity, contract §2.1): parsed and
    /// validated eagerly only when `triggers_enabled` is true. `None` = disabled.
    /// Secret answers are resolved from `connection_secrets` at parse time.
    pub triggers: Option<crate::triggers::TriggersConfig>,
    /// Local command fetching the login password when none is stored
    /// (`external_config.password_command`; tssh PasswordCommand parity).
    /// Runs only when `password` is empty — explicit credentials win.
    pub password_command: String,
    /// Local command fetching the private-key passphrase when none is stored
    /// (`external_config.passphrase_command`; tssh PassphraseCommand parity).
    pub passphrase_command: String,
    /// ProxyJump chain: each entry is dialed before the target, the final hop
    /// reaching `host:port` directly (the runtime tunnel endpoint is skipped).
    pub jump_hosts: Vec<JumpHost>,
}

/// One hop of a `external_config.jump_hosts` chain. Credentials live inline
/// because the DBX connection model only provides a single secrets store for
/// the target host.
#[derive(Debug, Clone, Default)]
pub struct JumpHost {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub authentication: String,
    pub private_key_path: String,
    pub private_key_passphrase: String,
    pub agent_socket: String,
    pub totp_secret: String,
    pub password_prompt_hint: String,
    pub totp_prompt_hint: String,
    pub auth_flow_mode: String,
}

impl JumpHost {
    /// Parses one jump entry from a JSON object (also used by the MCP
    /// `jumpHosts` parameter). Field names are snake_case, matching the
    /// `external_config.jump_hosts` form field.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let Some(config) = value.as_object() else {
            return Err("Jump host must be a JSON object".to_string());
        };
        Self::from_config(config)
    }

    fn from_config(value: &serde_json::Map<String, Value>) -> Result<Self, String> {
        let host = validate_host_field(string_field(value, "host")?)?;
        let port = match value.get("port") {
            None => 22,
            Some(port) => port
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or("Jump host port must be between 1 and 65535")?,
        };
        let authentication = value
            .get("authentication")
            .and_then(Value::as_str)
            .unwrap_or("password")
            .to_string();
        if !matches!(
            authentication.as_str(),
            "password" | "private-key" | "private-key-password" | "agent"
        ) {
            return Err(format!(
                "Unsupported jump host authentication method '{authentication}'"
            ));
        }
        Ok(Self {
            host,
            port,
            username: string_field(value, "username")?,
            // Credentials must survive verbatim: trimming would silently
            // change the password/passphrase the server sees.
            password: credential_string(value, "password"),
            authentication,
            private_key_path: optional_string(Some(value), "private_key_path"),
            private_key_passphrase: credential_string(value, "private_key_passphrase"),
            agent_socket: optional_string(Some(value), "agent_socket"),
            totp_secret: optional_string(Some(value), "totp_secret"),
            password_prompt_hint: optional_string(Some(value), "password_prompt_hint"),
            totp_prompt_hint: optional_string(Some(value), "totp_prompt_hint"),
            auth_flow_mode: optional_string(Some(value), "auth_flow_mode"),
        })
    }

    pub fn validate(&self, position: usize) -> Result<(), String> {
        match self.authentication.as_str() {
            "password" if self.password.is_empty() => Err(format!(
                "Jump host #{} ({}) requires a password",
                position + 1,
                self.host
            )),
            "private-key" | "private-key-password" if self.private_key_path.is_empty() => {
                Err(format!(
                    "Jump host #{} ({}) requires a private key path",
                    position + 1,
                    self.host
                ))
            }
            _ => Ok(()),
        }
    }

    /// Synthesizes a StoredConnection so the shared connect/auth pipeline
    /// (including keyboard-interactive 2FA) applies to jump hops as well.
    pub fn to_connection(
        &self,
        id: &str,
        timeout_secs: u64,
        keepalive_secs: u64,
    ) -> StoredConnection {
        StoredConnection {
            id: id.to_string(),
            // Jump hops are referenced by position in the chain, never by
            // name on the MCP surface.
            name: None,
            host: self.host.clone(),
            port: self.port,
            runtime_host: self.host.clone(),
            runtime_port: self.port,
            username: self.username.clone(),
            password: self.password.clone(),
            authentication: AuthenticationMethod::from_method_name(&self.authentication),
            private_key_path: self.private_key_path.clone(),
            private_key: String::new(),
            private_key_passphrase: self.private_key_passphrase.clone(),
            agent_socket: self.agent_socket.clone(),
            connect_timeout_secs: timeout_secs.max(1),
            keepalive_interval_secs: keepalive_secs,
            // Jump hops carry no interactive terminal, so no activity
            // keepalive either.
            terminal_keepalive_secs: 0,
            read_only: false,
            sudo_password: String::new(),
            totp_secret: self.totp_secret.clone(),
            sudo_source: SudoSource::Custom,
            sudo_profile_ref: String::new(),
            sudo_use_pty: false,
            sudo_whitelist: Vec::new(),
            password_prompt_hint: self.password_prompt_hint.clone(),
            totp_prompt_hint: self.totp_prompt_hint.clone(),
            auth_flow_mode: self.auth_flow_mode.clone(),
            // Jump hops never inject SetEnv or exec a RemoteCommand: those
            // features target the final session only (deliberate
            // simplification, see StoredConnection docs).
            set_env: Vec::new(),
            remote_command: String::new(),
            // Jump hops never run interactive trigger stages.
            triggers_enabled: false,
            // Jump hops fetch no credentials locally: their inline credential
            // fields are the whole story.
            triggers: None,
            password_command: String::new(),
            passphrase_command: String::new(),
            jump_hosts: Vec::new(),
        }
    }
}

impl StoredConnection {
    /// Quick Sudo is active unless the source is explicitly off; read-only
    /// connections gate it separately (see `ssh.rs`).
    pub fn sudo_enabled(&self) -> bool {
        self.sudo_source != SudoSource::Off
    }

    pub fn from_lifecycle_params(params: &Value) -> Result<Self, String> {
        let connection = params
            .get("connection")
            .and_then(Value::as_object)
            .ok_or("Missing connection payload")?;
        let id = string_field(connection, "id")?;
        // Display name is optional (older payloads omit it); trimmed so the
        // MCP connectionName lookup matches what the workbench shows.
        let name = connection
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let host = validate_host_field(string_field(connection, "host")?)?;
        let port = connection
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or("SSH port must be between 1 and 65535")?;
        let runtime = params.get("runtime").and_then(Value::as_object);
        let runtime_host = optional_string(runtime, "host");
        let runtime_port = runtime
            .and_then(|value| value.get("port"))
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(port);
        let username = string_field(connection, "username")?;
        let mut password = connection
            .get("password")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let authentication = AuthenticationMethod::from_connection(connection)?;
        let external_config = connection.get("external_config").and_then(Value::as_object);
        let connection_secrets = connection
            .get("connection_secrets")
            .and_then(Value::as_object);
        let private_key_path = optional_string(external_config, "private_key_path");
        // 私钥内容与口令同为凭据：原样读取（PEM/PPK 是多行文本，禁止 trim）。
        let private_key = connection_secrets
            .map(|secrets| credential_string(secrets, "private_key"))
            .unwrap_or_default();
        let private_key_passphrase = connection_secrets
            .map(|secrets| credential_string(secrets, "private_key_passphrase"))
            .unwrap_or_default();
        let agent_socket = optional_string(external_config, "agent_socket");
        let _advanced_options = external_config
            .and_then(|config| config.get("advanced_options"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // sudo_password 是凭据：原样读取（首尾空格合法），空白语义由
        // SudoAuth::new 的「空白即回退登录密码」兜底，不在解析层改写。
        let sudo_password = connection_secrets
            .map(|secrets| credential_string(secrets, "sudo_password"))
            .unwrap_or_default();
        let totp_secret = optional_string(connection_secrets, "totp_secret");
        let password_prompt_hint = optional_string(external_config, "password_prompt_hint");
        let totp_prompt_hint = optional_string(external_config, "totp_prompt_hint");
        let auth_flow_mode = optional_string(external_config, "auth_flow_mode");
        // 会话特性两件套（camelCase 为主；snake_case 别名兼容手改配置/历史
        // 草稿）。setEnv 严格校验，非法条目让连接直接失败（宁可连不上也
        // 不错配）；remoteCommand trim 后非空才生效。
        let set_env = parse_set_env(config_text(external_config, &["setEnv", "set_env"]))?;
        let remote_command = config_text(external_config, &["remoteCommand", "remote_command"])
            .unwrap_or_default()
            .trim()
            .to_string();
        // The form has an independent opt-in switch. Missing/invalid values
        // are off by default so old non-empty trigger text cannot silently
        // start sending replies after an upgrade.
        let triggers_enabled = external_config
            .and_then(|config| config.get("triggers_enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // Expect 式终端触发器（camelCase/snake_case 均为 manifest 原生 key，
        // triggers 本身无别名）。仅在明确启用时解析；关闭时保留文本但
        // 不因旧文本非法而阻止连接。启用时非法配置仍直接失败（D7）。
        let triggers = triggers_enabled
            .then(|| {
                crate::triggers::parse_triggers(
                    external_config.and_then(|config| config.get("triggers")),
                    &|key| {
                        connection_secrets
                            .and_then(|secrets| secrets.get(key))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    },
                )
            })
            .transpose()?
            .flatten();
        // 外部密码管理器（tssh PasswordCommand/PassphraseCommand 对标）：
        // trim 后非空才生效；既有显式凭据优先（D9）。
        let password_command =
            config_text(external_config, &["password_command", "passwordCommand"])
                .unwrap_or_default()
                .trim()
                .to_string();
        let passphrase_command = config_text(
            external_config,
            &["passphrase_command", "passphraseCommand"],
        )
        .unwrap_or_default()
        .trim()
        .to_string();
        // Legacy 0.4.x flag: only consulted when `sudo_source` is absent, so
        // a re-saved connection (stale `quick_sudo` left behind) follows the
        // explicit source chosen on the form.
        let legacy_quick_sudo = external_config
            .and_then(|config| config.get("quick_sudo"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let sudo_source = SudoSource::parse(
            external_config
                .and_then(|config| config.get("sudo_source"))
                .and_then(Value::as_str),
            legacy_quick_sudo,
        );
        let sudo_profile_ref = optional_string(external_config, "sudo_profile");
        let sudo_use_pty = external_config
            .and_then(|config| config.get("sudo_use_pty"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sudo_whitelist = optional_string(external_config, "sudo_whitelist")
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_string)
            .collect();
        let jump_hosts = parse_jump_hosts(external_config)?;
        let runtime_host = if runtime_host.is_empty() {
            host.clone()
        } else {
            runtime_host
        };
        // 表单的「密码来源」（password_source）是显式选择，解析层照它执行：
        //   * "direct"  —— 表单里必须填密码（宿主 required_when 已先拦一道，
        //                  这里兜底 MCP/手改配置/导入等非对话框路径）；
        //   * "command" —— 由本地命令取回；此时存量密码必须让位，否则
        //                  「显式密码优先」会让命令永不执行，用户选定的
        //                  来源被静默忽略；
        //   * 缺省      —— 老配置（0.4.x 只有 password/password_command）与
        //                  MCP 内联参数保持历史语义：两者二选一即可。
        // 报错一律点名表单字段，非对话框路径也能直接改对。
        let password_source = config_text(external_config, &["password_source"])
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(source) = password_source {
            match (
                source,
                matches!(
                    authentication,
                    AuthenticationMethod::Password | AuthenticationMethod::PrivateKeyPassword
                ),
            ) {
                ("direct", true) if password.is_empty() => {
                    return Err(
                        "Password source \"Enter in this form\" requires the \"Password\" field \
                         (or choose \"Local command\" as \"Password source\" and provide \
                         \"Password command\")"
                            .to_string(),
                    );
                }
                ("command", true) if password_command.is_empty() => {
                    return Err(
                        "Password source \"Local command\" requires the \"Password command\" field \
                         (or choose \"Enter in this form\" as \"Password source\" and fill \
                         \"Password\")"
                            .to_string(),
                    );
                }
                ("command", true) => password.clear(),
                ("direct", _) | ("command", _) => {}
                (other, _) => return Err(format!("Unsupported password source '{other}'")),
            }
        } else if matches!(
            authentication,
            AuthenticationMethod::Password | AuthenticationMethod::PrivateKeyPassword
        ) && password.is_empty()
            && password_command.is_empty()
        {
            return Err(
                "Password authentication requires a password or a password_command: fill the \
                 \"Password\" field, or set \"Password source\" to \"Local command\" and provide \
                 \"Password command\""
                    .to_string(),
            );
        }
        if matches!(
            authentication,
            AuthenticationMethod::PrivateKey | AuthenticationMethod::PrivateKeyPassword
        ) && private_key_path.is_empty()
            && private_key.is_empty()
        {
            return Err(
                "Private-key authentication requires a private key path or key content: fill \
                 \"Private key path\", or paste the key into \"Private key content\""
                    .to_string(),
            );
        }
        Ok(Self {
            id,
            name,
            host,
            port,
            runtime_host,
            runtime_port,
            username,
            password,
            authentication,
            private_key_path,
            private_key,
            private_key_passphrase,
            agent_socket,
            connect_timeout_secs: config_u64(external_config, connection, "connect_timeout_secs")
                .unwrap_or(30)
                .max(1),
            keepalive_interval_secs: config_u64(
                external_config,
                connection,
                "keepalive_interval_secs",
            )
            .unwrap_or(30),
            terminal_keepalive_secs: clamp_terminal_keepalive(
                config_u64(external_config, connection, "terminal_keepalive_secs").unwrap_or(0),
            ),
            // 只读门禁收敛：连接表单 read_only（插件特定配置项）∥ 宿主标准
            // read_only（ConnectionConfig 通用设置）。
            read_only: external_config
                .and_then(|config| config.get("read_only"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || connection
                    .get("read_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            triggers_enabled,
            sudo_password,
            totp_secret,
            sudo_source,
            sudo_profile_ref,
            sudo_use_pty,
            sudo_whitelist,
            password_prompt_hint,
            totp_prompt_hint,
            auth_flow_mode,
            set_env,
            remote_command,
            triggers,
            password_command,
            passphrase_command,
            jump_hosts,
        })
    }
}

/// First present string among `keys` in the config object.
fn config_text<'a>(
    config: Option<&'a serde_json::Map<String, Value>>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| config.and_then(|config| config.get(*key)))
        .and_then(Value::as_str)
}

/// Terminal activity keepalive: 0 disables, anything else is bounded so a
/// typo can neither hammer the PTY (5s floor) nor idle for days (1h ceiling).
fn clamp_terminal_keepalive(raw: u64) -> u64 {
    if raw == 0 {
        0
    } else {
        raw.clamp(5, 3600)
    }
}

/// Numeric `binding: config` field: the connection form writes these into
/// `external_config`; the top-level connection object stays as fallback for
/// hand-edited configs and older payloads (same convergence as `read_only`,
/// which the timeout/keepalive fields previously lacked — the form values
/// never reached the parser and the defaults always won).
fn config_u64(
    external_config: Option<&serde_json::Map<String, Value>>,
    connection: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<u64> {
    external_config
        .and_then(|config| config.get(key))
        .or_else(|| connection.get(key))
        .and_then(Value::as_u64)
}

/// Parses the `setEnv` connection field: one `KEY=VALUE` entry per line,
/// semicolons tolerated as separators (mirrors the `totp_secret` input
/// convention), blank entries ignored, entries trimmed. Strict by design —
/// "prefer failing the connection to silently misconfiguring remote
/// commands": every invalid entry is reported with its content in one
/// aggregated error. Duplicate keys follow `ssh SetEnv` semantics: the last
/// entry wins. This is the client-specified half of ssh's SetEnv/SendEnv —
/// no local environment is ever transmitted.
pub fn parse_set_env(raw: Option<&str>) -> Result<Vec<(String, String)>, String> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut vars: Vec<(String, String)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for entry in raw.split(['\n', ';']) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((key, value)) = entry.split_once('=') else {
            errors.push(format!("'{entry}' (missing '=' separator)"));
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() {
            errors.push(format!("'{entry}' (empty key)"));
            continue;
        }
        if key.chars().any(char::is_whitespace) {
            errors.push(format!("'{entry}' (key must not contain whitespace)"));
            continue;
        }
        if key.contains('\0') {
            errors.push(format!("'{entry}' (NUL byte in key)"));
            continue;
        }
        if value.contains('\0') {
            errors.push(format!("'{entry}' (NUL byte in value)"));
            continue;
        }
        match vars.iter_mut().find(|(existing, _)| existing == key) {
            Some(slot) => slot.1 = value.to_string(),
            None => vars.push((key.to_string(), value.to_string())),
        }
    }
    if errors.is_empty() {
        Ok(vars)
    } else {
        Err(format!("Invalid setEnv entries: {}", errors.join("; ")))
    }
}

fn parse_jump_hosts(
    external_config: Option<&serde_json::Map<String, Value>>,
) -> Result<Vec<JumpHost>, String> {
    let Some(list) = external_config
        .and_then(|config| config.get("jump_hosts"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };
    if list.len() > 3 {
        return Err("At most 3 jump hosts are supported".to_string());
    }
    let mut hosts: Vec<JumpHost> = Vec::with_capacity(list.len());
    for (position, value) in list.iter().enumerate() {
        let Some(config) = value.as_object() else {
            return Err(format!("Jump host #{} must be an object", position + 1));
        };
        let host = JumpHost::from_config(config)?;
        host.validate(position)?;
        // A repeated hop can only be a misconfiguration: the same
        // host:port dialled twice never advances the chain.
        if hosts
            .iter()
            .any(|existing| existing.host == host.host && existing.port == host.port)
        {
            return Err(format!(
                "Jump host #{} ({}) repeats an earlier hop",
                position + 1,
                host.host
            ));
        }
        hosts.push(host);
    }
    Ok(hosts)
}

/// Host fields must be a dialable hostname/IP: no internal whitespace and no
/// URI scheme syntax (`ssh://…`) that would silently become a bogus TCP
/// target instead of failing fast at parse time.
fn validate_host_field(host: String) -> Result<String, String> {
    if host.chars().any(char::is_whitespace) {
        return Err(format!(
            "Invalid SSH host '{host}': must not contain whitespace"
        ));
    }
    if host.contains("://") {
        return Err(format!(
            "Invalid SSH host '{host}': use a bare hostname, not a URI"
        ));
    }
    Ok(host)
}

/// Reads a credential field verbatim (no trimming): passwords and
/// passphrases may legitimately start or end with spaces.
fn credential_string(object: &serde_json::Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_string(object: Option<&serde_json::Map<String, Value>>, key: &str) -> String {
    object
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing SSH {key}"))
}

#[derive(Debug, Clone)]
pub struct TerminalFrame {
    pub sequence: u64,
    pub stream: TerminalStream,
    pub data: Vec<u8>,
}

impl TerminalFrame {
    pub fn encode(&self) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(9 + self.data.len());
        encoded.push(self.stream as u8);
        encoded.extend_from_slice(&self.sequence.to_be_bytes());
        encoded.extend_from_slice(&self.data);
        encoded
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TerminalStream {
    Stdout = 0,
    Stderr = 1,
    State = 2,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub uri: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenRequest {
    pub connection_id: String,
    #[serde(default)]
    pub workbench_id: String,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
}

fn default_cols() -> u32 {
    120
}

fn default_rows() -> u32 {
    32
}

pub fn sftp_uri(path: &str) -> String {
    format!(
        "sftp:{}",
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    )
}

pub fn path_from_sftp_uri(uri: &str) -> Result<String, String> {
    let path = uri
        .strip_prefix("sftp:")
        .ok_or("SFTP URI must use the sftp: scheme")?;
    normalize_remote_path(path)
}

pub fn normalize_remote_path(path: &str) -> Result<String, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("SFTP path is empty or invalid".to_string());
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            value => components.push(value),
        }
    }
    Ok(format!("/{}", components.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remote_paths_without_escaping_root() {
        assert_eq!(
            normalize_remote_path("/home/user/../file").unwrap(),
            "/home/file"
        );
        assert_eq!(normalize_remote_path("../../etc").unwrap(), "/etc");
    }

    #[test]
    fn terminal_frame_carries_stream_and_sequence() {
        let encoded = TerminalFrame {
            sequence: 42,
            stream: TerminalStream::Stderr,
            data: b"x".to_vec(),
        }
        .encode();
        assert_eq!(encoded[0], 1);
        assert_eq!(u64::from_be_bytes(encoded[1..9].try_into().unwrap()), 42);
        assert_eq!(&encoded[9..], b"x");
    }

    #[test]
    fn legacy_password_connections_remain_compatible() {
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "legacy",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret"
            }
        }))
        .unwrap();

        assert_eq!(connection.authentication, AuthenticationMethod::Password);
        assert_eq!(connection.password, "secret");
    }

    #[test]
    fn read_only_flags_from_host_and_form_force_read_only() {
        // 插件特定配置项：连接表单 read_only（external_config）→ 只读门禁。
        let form_read_only = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "form-ro",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret",
                "external_config": { "read_only": true }
            }
        }))
        .unwrap();
        assert!(
            form_read_only.read_only,
            "form read_only must force the gate"
        );

        // 宿主标准 read_only（ConnectionConfig.read_only，通用连接设置）同样生效。
        let host_read_only = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "ro",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret",
                "read_only": true
            }
        }))
        .unwrap();
        assert!(
            host_read_only.read_only,
            "host read_only must force the gate"
        );

        let writable = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "rw",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret"
            }
        }))
        .unwrap();
        assert!(
            !writable.read_only,
            "writable connections must stay writable"
        );
    }

    #[test]
    fn manifest_connection_fields_stay_in_sync_with_parsing() {
        // 契约：manifest.json 的 connection-provider 字段与 from_lifecycle_params
        // 的解析覆盖互为镜像——manifest 加字段而解析不消费（或反向）都会漂移，
        // 这里直读 manifest 逐项对账。
        let manifest: Value = serde_json::from_str(include_str!("../../manifest.json")).unwrap();
        let provider = manifest["contributions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["type"] == "connection-provider")
            .expect("connection-provider contribution");
        let fields = provider["fields"].as_array().unwrap();

        let keys: Vec<&str> = fields
            .iter()
            .filter_map(|field| field["key"].as_str())
            .collect();
        let expected = [
            "display_name",
            "host",
            "port",
            "username",
            "authentication",
            "password_source",
            "password",
            "password_command",
            "private_key_path",
            "private_key_passphrase",
            "private_key",
            "agent_socket",
            "advanced_options",
            "sudo_source",
            "sudo_profile",
            "sudo_password",
            "sudo_use_pty",
            "sudo_whitelist",
            "auth_flow_mode",
            "totp_secret",
            "totp_prompt_hint",
            "password_prompt_hint",
            "connect_timeout_secs",
            "keepalive_interval_secs",
            "terminal_keepalive_secs",
            "set_env",
            "triggers_enabled",
            "triggers",
            "trigger_answer_1",
            "trigger_answer_2",
            "passphrase_command",
            "remote_command",
            "read_only",
        ];
        assert_eq!(keys, expected, "manifest field list drifted from parsing");

        // secret binding 只允许落在凭据字段；config binding 不得承载凭据语义。
        // private_key 承载表单粘贴的私钥内容（外部工具写入的存量 secret 也
        // 从这里生效），必须被 provider 声明，否则宿主校验拒绝整个连接。
        // trigger_answer_1/2 是触发器密文槽位（sendSecretKey 引用）。
        let secret_keys = [
            "password",
            "private_key_passphrase",
            "private_key",
            "sudo_password",
            "totp_secret",
            "trigger_answer_1",
            "trigger_answer_2",
        ];
        for field in fields {
            let key = field["key"].as_str().unwrap();
            match field["binding"].as_str() {
                Some("secret") => assert!(
                    secret_keys.contains(&key),
                    "unexpected secret binding: {key}"
                ),
                Some("config") => assert!(
                    !key.contains("password")
                        || key == "password_prompt_hint"
                        || key == "password_command"
                        // A selector ("direct"/"command"), never credential
                        // material: both halves stay secret/config bound.
                        || key == "password_source",
                    "config binding must not carry credential material: {key}"
                ),
                _ => {}
            }
        }

        // 登录密码走显式「密码来源」二选一（password_source）：
        //   direct  → password 必填；command → password_command 必填。
        // 两个分支合起来必须覆盖 password_source 的全部取值，否则某个选项
        // 会变成「两边都不需要」或「两边都要」，前者保存后被解析层拒绝、后者
        // 死锁（宿主契约只能表达单字段 required_when，做不到「除非另一字段有
        // 值」，所以来源必须由用户显式选）。私钥那组仍是「路径∨内容」，
        // manifest 表达不了 OR，保持两边都非必填（见
        // credential_requirements_stay_parse_time_only）。
        let one_of = |key: &str, constraint: &str| -> Vec<String> {
            fields.iter().find(|field| field["key"] == key).unwrap()[constraint]
                .as_object()
                .map(|gate| {
                    gate["one_of"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|value| value.as_str().unwrap().to_string())
                        .collect()
                })
                .unwrap_or_default()
        };
        let password_source = fields
            .iter()
            .find(|field| field["key"] == "password_source")
            .expect("password_source field");
        let source_options: Vec<String> = password_source["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|option| option["value"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(password_source["default"], "direct");
        assert_eq!(source_options, ["direct", "command"]);
        let gate_field = |key: &str, constraint: &str| -> Option<String> {
            fields.iter().find(|field| field["key"] == key).unwrap()[constraint]["field"]
                .as_str()
                .map(str::to_string)
        };
        assert_eq!(
            gate_field("password", "required_when").as_deref(),
            Some("password_source")
        );
        assert_eq!(one_of("password", "required_when"), ["direct"]);
        assert_eq!(
            gate_field("password_command", "required_when").as_deref(),
            Some("password_source")
        );
        assert_eq!(one_of("password_command", "required_when"), ["command"]);
        let mut covered = one_of("password", "required_when");
        covered.extend(one_of("password_command", "required_when"));
        covered.sort();
        let mut expected = source_options.clone();
        expected.sort();
        assert_eq!(
            covered, expected,
            "password_source branches must cover every option exactly once"
        );
        // private_key_path 是「路径或私钥内容」二选一：无 required_when，
        // 凭据齐全性由解析层校验（见 private_key_accepts_path_or_content）。
        assert!(
            fields
                .iter()
                .find(|field| field["key"] == "private_key_path")
                .unwrap()["required_when"]
                .is_null(),
            "private_key_path must not force the path when key content may be pasted instead"
        );

        // sudo 覆盖簇跟随表单选定的凭据来源（sudo_source）：自定义模式下才
        // 出现本连接密码/PTY；global 模式出现全局配置引用；2FA 编排字段
        // （totp_secret/auth_flow_mode/hints）服务登录期 keyboard-interactive，
        // global 模式下整体由全局配置接管故隐藏，off/custom 模式仍常显。
        let visible_when = |key: &str| -> Option<(String, Vec<String>)> {
            fields
                .iter()
                .find(|field| field["key"] == key)
                .unwrap()
                .get("visible_when")
                .map(|gate| {
                    (
                        gate["field"].as_str().unwrap().to_string(),
                        gate["one_of"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|value| value.as_str().unwrap().to_string())
                            .collect(),
                    )
                })
        };
        assert_eq!(
            visible_when("sudo_password"),
            Some(("sudo_source".to_string(), vec!["custom".to_string()])),
            "sudo_password must stay gated on sudo_source=custom"
        );
        assert_eq!(
            visible_when("sudo_use_pty"),
            Some(("sudo_source".to_string(), vec!["custom".to_string()])),
            "sudo_use_pty must stay gated on sudo_source=custom"
        );
        assert_eq!(
            visible_when("sudo_profile"),
            Some(("sudo_source".to_string(), vec!["global".to_string()])),
            "sudo_profile must show only for sudo_source=global"
        );
        for key in ["auth_flow_mode", "password_prompt_hint"] {
            assert_eq!(
                visible_when(key),
                Some(("sudo_source".to_string(), vec!["custom".to_string(), "off".to_string()])),
                "{key} must hide under sudo_source=global (the bound profile owns the whole credential source) and stay visible otherwise"
            );
        }
        for key in ["totp_secret", "totp_prompt_hint"] {
            assert_eq!(
                visible_when(key),
                Some((
                    "auth_flow_mode".to_string(),
                    vec![
                        "password_then_otp".to_string(),
                        "password_plus_otp".to_string()
                    ]
                ))
            );
        }

        // 2FA 关闭选项（0.4.77）：表单默认 off（新连接不自动回 OTP）；
        // 存量连接带显式 auth_flow_mode 值不受新默认影响，缺省字段在
        // 解析层仍落到 PasswordThenOtp（见 from_lifecycle_params）。
        let auth_flow = fields
            .iter()
            .find(|field| field["key"] == "auth_flow_mode")
            .unwrap();
        assert_eq!(
            auth_flow["default"], "off",
            "new connections default to 2FA off"
        );
        let flow_options: Vec<&str> = auth_flow["options"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|option| option["value"].as_str())
            .collect();
        assert_eq!(
            flow_options,
            [
                "off",
                "password_then_otp",
                "password_plus_otp",
                "password_only"
            ],
            "off must be the first (default) 2FA flow option"
        );
    }

    #[test]
    fn auth_method_names_round_trip_for_display() {
        for name in [
            "password",
            "private-key",
            "private-key-password",
            "agent",
            "none",
        ] {
            // Name round-trip is a pure enum mapping; credential validation is
            // exercised separately by the connection parsing tests.
            let method = AuthenticationMethod::from_method_name(name);
            assert_eq!(method.method_name(), name);
        }
    }

    #[test]
    fn sudo_password_is_a_credential_and_keeps_edge_whitespace() {
        // 第 3 轮对抗审查遗留项：跳板/私钥口令已原样读取，sudo_password 同样
        // 不在解析层 trim（首尾空格是合法密码字符）；纯空白语义由
        // SudoAuth::new 的「空白即回退」兜底，不受影响。
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "sudo-ws",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "login",
                "connection_secrets": { "sudo_password": " padded " }
            }
        }))
        .unwrap();
        assert_eq!(connection.sudo_password, " padded ");

        let blank = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "sudo-blank",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "login",
                "connection_secrets": { "sudo_password": "   " }
            }
        }))
        .unwrap();
        assert_eq!(blank.sudo_password, "   ");
    }

    #[test]
    fn sudo_source_maps_three_modes_with_legacy_fallback() {
        let parse = |external_config: serde_json::Value| {
            StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "sudo-source",
                    "host": "example.com",
                    "port": 22,
                    "username": "user",
                    "password": "login",
                    "external_config": external_config
                }
            }))
            .unwrap()
        };

        // 表单三选一：off / custom / global（global 附带全局配置引用，trim 后生效）。
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "off" })).sudo_source,
            SudoSource::Off
        );
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "custom" })).sudo_source,
            SudoSource::Custom
        );
        let global = parse(serde_json::json!({
            "sudo_source": "global",
            "sudo_profile": " ops "
        }));
        assert_eq!(global.sudo_source, SudoSource::Global);
        assert_eq!(global.sudo_profile_ref, "ops");
        assert!(global.sudo_enabled());
        assert!(!parse(serde_json::json!({ "sudo_source": "off" })).sudo_enabled());

        // 旧连接无 sudo_source：由 quick_sudo 布尔映射，保持原行为。
        assert_eq!(
            parse(serde_json::json!({ "quick_sudo": true })).sudo_source,
            SudoSource::Custom
        );
        assert_eq!(
            parse(serde_json::json!({ "quick_sudo": false })).sudo_source,
            SudoSource::Off
        );
        assert_eq!(parse(serde_json::json!({})).sudo_source, SudoSource::Custom);

        // 显式 sudo_source 优先于遗留 quick_sudo（新表单保存后旧键残留）。
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "off", "quick_sudo": true })).sudo_source,
            SudoSource::Off
        );
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "custom", "quick_sudo": false })).sudo_source,
            SudoSource::Custom
        );

        // 空值/未知值回落 legacy。
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "", "quick_sudo": false })).sudo_source,
            SudoSource::Off
        );
        assert_eq!(
            parse(serde_json::json!({ "sudo_source": "bogus", "quick_sudo": true })).sudo_source,
            SudoSource::Custom
        );
    }

    #[test]
    fn parses_private_key_password_credentials_from_separate_stores() {
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "key-password",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "fallback",
                "external_config": {
                    "authentication": "private-key-password",
                    "private_key_path": "C:/keys/id_ed25519"
                },
                "connection_secrets": {
                    "private_key_passphrase": "key-secret"
                }
            }
        }))
        .unwrap();

        assert_eq!(
            connection.authentication,
            AuthenticationMethod::PrivateKeyPassword
        );
        assert_eq!(connection.private_key_path, "C:/keys/id_ed25519");
        assert_eq!(connection.private_key_passphrase, "key-secret");
    }

    #[test]
    fn uses_the_host_runtime_endpoint_without_changing_host_key_identity() {
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "tunneled",
                "host": "target.internal",
                "port": 22,
                "username": "user",
                "password": "secret"
            },
            "runtime": {
                "host": "127.0.0.1",
                "port": 39122
            }
        }))
        .unwrap();

        assert_eq!(connection.host, "target.internal");
        assert_eq!(connection.port, 22);
        assert_eq!(connection.runtime_host, "127.0.0.1");
        assert_eq!(connection.runtime_port, 39122);
    }

    #[test]
    fn lifecycle_parser_preserves_utf8_connection_text_and_windows_paths() {
        let payload = serde_json::json!({
            "connection": {
                "id": "windows-unicode",
                "name": "生产机-北京",
                "host": "2001:db8::42",
                "port": 2222,
                "username": "运维",
                "password": "密码🔐",
                "external_config": {
                    "authentication": "private-key",
                    "private_key_path": "C:\\Users\\测试\\.ssh\\id_ed25519",
                    "setEnv": "LANG=zh_CN.UTF-8\nDBX_LABEL=应用服务器",
                    "remoteCommand": "printf '已连接\\n'"
                },
                "connection_secrets": {
                    "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\r\n测试\r\n-----END OPENSSH PRIVATE KEY-----\r\n"
                }
            },
            "runtime": { "host": "127.0.0.1", "port": 39222 }
        });
        // Exercise the same UTF-8 JSON boundary used by the host bridge, not
        // only the in-memory `serde_json::Value` representation.
        let encoded = serde_json::to_vec(&payload).unwrap();
        let decoded: Value = serde_json::from_slice(&encoded).unwrap();
        let connection = StoredConnection::from_lifecycle_params(&decoded).unwrap();

        // The logical endpoint is used for host-key identity; the runtime
        // endpoint is the actual dial target supplied by the host tunnel.
        assert_eq!(connection.name.as_deref(), Some("生产机-北京"));
        assert_eq!(connection.host, "2001:db8::42");
        assert_eq!(connection.port, 2222);
        assert_eq!(connection.runtime_host, "127.0.0.1");
        assert_eq!(connection.runtime_port, 39222);
        assert_eq!(connection.username, "运维");
        assert_eq!(connection.password, "密码🔐");
        assert_eq!(
            connection.private_key_path,
            "C:\\Users\\测试\\.ssh\\id_ed25519"
        );
        assert_eq!(
            connection.private_key,
            "-----BEGIN OPENSSH PRIVATE KEY-----\r\n测试\r\n-----END OPENSSH PRIVATE KEY-----\r\n"
        );
        assert_eq!(
            connection.set_env,
            vec![
                ("LANG".to_string(), "zh_CN.UTF-8".to_string()),
                ("DBX_LABEL".to_string(), "应用服务器".to_string()),
            ]
        );
        assert_eq!(connection.remote_command, "printf '已连接\\n'");
    }

    #[test]
    fn lifecycle_parser_accepts_network_address_forms_and_rejects_ambiguous_hosts() {
        for host in [
            "127.0.0.1",
            "ssh.example.test",
            "2001:db8::1",
            "[2001:db8::1]",
        ] {
            let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "address",
                    "host": host,
                    "port": 22,
                    "username": "user",
                    "password": "secret"
                }
            }))
            .unwrap();
            assert_eq!(connection.host, host);
        }

        for host in ["my server", "ssh://server.example.test:22", "server\nname"] {
            let result = StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "address",
                    "host": host,
                    "port": 22,
                    "username": "user",
                    "password": "secret"
                }
            }));
            assert!(result.is_err(), "ambiguous host must fail fast: {host:?}");
        }

        for port in [0_u64, 65_536] {
            let result = StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "port",
                    "host": "server.example.test",
                    "port": port,
                    "username": "user",
                    "password": "secret"
                }
            }));
            assert!(result.is_err(), "invalid port must fail fast: {port}");
        }
    }

    #[test]
    fn sftp_uri_roundtrip_keeps_utf8_paths_and_confines_parent_segments() {
        let path = "/home/运维/../应用/日志.txt";
        assert_eq!(
            path_from_sftp_uri(&sftp_uri(path)).unwrap(),
            "/home/应用/日志.txt"
        );
        assert_eq!(
            path_from_sftp_uri("sftp:relative/目录/./文件.txt").unwrap(),
            "/relative/目录/文件.txt"
        );
    }

    #[test]
    fn parses_jump_host_chains() {
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "jumped",
                "host": "target.internal",
                "port": 22,
                "username": "user",
                "password": "secret",
                "external_config": {
                    "jump_hosts": [
                        { "host": "bastion.example.com", "port": 2202, "username": "ops", "password": "jump-pw" },
                        { "host": "inner.example.com", "authentication": "private-key", "username": "relay", "private_key_path": "~/.ssh/id_ed25519" }
                    ]
                }
            }
        }))
        .unwrap();

        assert_eq!(connection.jump_hosts.len(), 2);
        assert_eq!(connection.jump_hosts[0].port, 2202);
        assert_eq!(connection.jump_hosts[0].password, "jump-pw");
        assert_eq!(connection.jump_hosts[1].authentication, "private-key");
        let synthesized = connection.jump_hosts[1].to_connection("jump-2", 20, 30);
        assert_eq!(synthesized.host, "inner.example.com");
        assert_eq!(synthesized.runtime_port, 22);
        assert_eq!(synthesized.authentication, AuthenticationMethod::PrivateKey);
    }

    #[test]
    fn rejects_invalid_jump_host_chains() {
        let with_missing_password = serde_json::json!({
            "connection": {
                "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                "external_config": { "jump_hosts": [ { "host": "bastion", "port": 22, "username": "ops" } ] }
            }
        });
        assert!(StoredConnection::from_lifecycle_params(&with_missing_password).is_err());

        let too_many = serde_json::json!({
            "connection": {
                "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                "external_config": {
                    "jump_hosts": [
                        { "host": "a", "port": 22, "username": "u", "password": "p" },
                        { "host": "b", "port": 22, "username": "u", "password": "p" },
                        { "host": "c", "port": 22, "username": "u", "password": "p" },
                        { "host": "d", "port": 22, "username": "u", "password": "p" }
                    ]
                }
            }
        });
        assert!(StoredConnection::from_lifecycle_params(&too_many).is_err());
    }

    #[test]
    fn rejects_adversarial_jump_host_fields() {
        let build = |jump: Value| {
            StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": {
                    "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                    "external_config": { "jump_hosts": [jump] }
                }
            }))
        };
        // Port boundaries.
        for port in [0_u64, 65536, 70000] {
            assert!(
                build(serde_json::json!({ "host": "bastion", "port": port, "username": "u", "password": "p" }))
                    .is_err(),
                "port {port} must be rejected"
            );
        }
        // Empty/whitespace username.
        assert!(build(serde_json::json!({ "host": "bastion", "username": "  " })).is_err());
        // Host with internal whitespace or URI syntax must fail fast instead
        // of becoming a bogus TCP target.
        assert!(build(
            serde_json::json!({ "host": "my bastion", "username": "u", "password": "p" })
        )
        .is_err());
        assert!(build(
            serde_json::json!({ "host": "ssh://bastion:22", "username": "u", "password": "p" })
        )
        .is_err());
        // The target host field is held to the same rules.
        let bad_target = serde_json::json!({
            "connection": {
                "id": "x", "host": "tar get", "port": 22, "username": "u", "password": "p"
            }
        });
        assert!(StoredConnection::from_lifecycle_params(&bad_target).is_err());
    }

    #[test]
    fn rejects_repeated_jump_hops() {
        let repeated = serde_json::json!({
            "connection": {
                "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                "external_config": {
                    "jump_hosts": [
                        { "host": "bastion", "port": 2202, "username": "u", "password": "p" },
                        { "host": "bastion", "port": 2202, "username": "u", "password": "p" }
                    ]
                }
            }
        });
        let error = StoredConnection::from_lifecycle_params(&repeated).unwrap_err();
        assert!(error.contains("repeats an earlier hop"), "{error}");
        // Same host on a different port is still a valid chain.
        let distinct = serde_json::json!({
            "connection": {
                "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                "external_config": {
                    "jump_hosts": [
                        { "host": "bastion", "port": 2202, "username": "u", "password": "p" },
                        { "host": "bastion", "port": 2203, "username": "u", "password": "p" }
                    ]
                }
            }
        });
        assert!(StoredConnection::from_lifecycle_params(&distinct).is_ok());
    }

    #[test]
    fn jump_credentials_survive_special_characters_verbatim() {
        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "x", "host": "t", "port": 22, "username": "u", "password": "p",
                "external_config": {
                    "jump_hosts": [
                        { "host": "bastion", "username": "u",
                          "password": "  p@$$w0rd 'with' \"quotes\" $backslash\\ ",
                          "authentication": "private-key",
                          "private_key_path": "~/.ssh/id_ed25519",
                          "private_key_passphrase": "  phrase with spaces  " }
                    ]
                }
            }
        }))
        .unwrap();
        assert_eq!(
            connection.jump_hosts[0].password,
            "  p@$$w0rd 'with' \"quotes\" $backslash\\ "
        );
        assert_eq!(
            connection.jump_hosts[0].private_key_passphrase,
            "  phrase with spaces  "
        );
    }
}

/// Contract tests binding `../manifest.json` to `from_lifecycle_params`: the
/// fields the host renders must be exactly the fields the parser consumes,
/// with matching required chains, visibility pairing, and defaults.
#[cfg(test)]
mod manifest_contract_tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn manifest() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../manifest.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read manifest at {}: {error}", path.display()));
        serde_json::from_str(&raw).expect("manifest.json must be valid JSON")
    }

    fn connection_fields() -> Vec<Value> {
        manifest()["contributions"]
            .as_array()
            .expect("contributions array")
            .iter()
            .find(|entry| entry["type"] == "connection-provider")
            .expect("connection-provider contribution")["fields"]
            .as_array()
            .expect("fields array")
            .clone()
    }

    fn field(key: &str) -> Value {
        connection_fields()
            .into_iter()
            .find(|entry| entry["key"].as_str() == Some(key))
            .unwrap_or_else(|| panic!("manifest field '{key}' missing"))
    }

    fn condition_one_of(entry: &Value, condition: &str) -> Option<Vec<String>> {
        entry[condition]["one_of"].as_array().map(|values| {
            values
                .iter()
                .map(|value| value.as_str().unwrap_or_default().to_string())
                .collect()
        })
    }

    fn condition_field<'a>(entry: &'a Value, condition: &str) -> Option<&'a str> {
        entry[condition]["field"].as_str()
    }

    /// Credential requirements must be *satisfiable on the form*:
    /// the login password is strict per `password_source` (direct → Password
    /// required, command → Password command required), which the user can
    /// always satisfy by typing it or switching the source; key material stays
    /// either-or (path ∨ pasted content) and therefore must never become
    /// form-required.
    /// Anything else either dead-locks the dialog footer or lets a save through
    /// that the parser then rejects.
    #[test]
    fn credential_requirements_are_form_satisfiable() {
        // No credential field may be *statically* required: a static flag
        // ignores the other branch (password_command / pasted key content) and
        // dead-locks the footer. Requirements have to hang off the explicit
        // source selector, which always has an alternative option.
        let selectors: Vec<&str> = ["authentication", "password_source"].to_vec();
        for entry in connection_fields() {
            let key = entry["key"].as_str().unwrap().to_string();
            let binding = entry["binding"].as_str().unwrap_or("");
            if !matches!(binding, "password" | "secret" | "config") {
                continue;
            }
            assert!(
                !entry["required"].as_bool().unwrap_or(false),
                "credential field '{key}' must not be statically required"
            );
            if let Some(source) = condition_field(&entry, "required_when") {
                assert!(
                    selectors.contains(&source),
                    "credential field '{key}' must be required via a user-chosen selector, not '{source}'"
                );
                let options = field(source)["options"]
                    .as_array()
                    .map(|options| options.len())
                    .unwrap_or(0);
                let required_for = condition_one_of(&entry, "required_when").unwrap_or_default();
                assert!(
                    options > required_for.len(),
                    "credential field '{key}' must have an escape branch in '{source}'"
                );
            }
        }

        // private_key_path / private_key stay either-or: never form-required.
        for key in ["private_key_path", "private_key", "private_key_passphrase"] {
            assert_eq!(
                condition_field(&field(key), "required_when"),
                None,
                "{key} must stay optional (path or pasted content is enough)"
            );
        }

        // The parse-time rules are real: with neither half of an OR the parser
        // rejects, and the message names the two form fields that fix it.
        let missing_password = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "no-pw",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "password" }
            }
        }))
        .unwrap_err();
        assert!(missing_password.contains("Password"), "{missing_password}");
        assert!(
            missing_password.contains("Password command"),
            "{missing_password}"
        );
        let missing_key = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "no-key",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "private-key" }
            }
        }))
        .unwrap_err();
        assert!(missing_key.contains("Private key path"), "{missing_key}");
        assert!(missing_key.contains("Private key content"), "{missing_key}");
    }

    // -----------------------------------------------------------------------
    // Host dialog semantics, mirrored from the host checkout so this repository
    // can regression-test the form contract without importing it:
    //   * `pluginFieldConditions.ts` — visibility cascades through the
    //     referenced sibling; `required_when` never implies required.
    //   * `ConnectionDialog.connectionConfigForSubmit` — "save" is blocked by
    //     the first field that is visible, required and empty (surfaced as
    //     `connection.pluginRequiredField` = "请填写{field}").
    //   * `frontendPlugin.buildPluginConnectionConfig` — where each bound value
    //     lands (connection/external_config/connection_secrets).
    // -----------------------------------------------------------------------

    /// Dialog value of a field: the stored/typed value, else the manifest default.
    fn form_value(values: &BTreeMap<String, Value>, entry: &Value) -> Option<Value> {
        let key = entry["key"].as_str().unwrap_or_default();
        match values.get(key) {
            Some(value) => Some(value.clone()),
            None => entry
                .get("default")
                .filter(|value| !value.is_null())
                .cloned(),
        }
    }

    fn form_condition_matches(
        condition: &Value,
        values: &BTreeMap<String, Value>,
        fields: &[Value],
    ) -> bool {
        let Some(key) = condition["field"].as_str() else {
            return false;
        };
        let Some(target) = fields
            .iter()
            .find(|entry| entry["key"].as_str() == Some(key))
        else {
            return false;
        };
        let Some(value) = form_value(values, target) else {
            return false;
        };
        let text = match value {
            Value::Null => return false,
            Value::String(text) => text,
            other => other.to_string(),
        };
        if text.trim().is_empty() {
            return false;
        }
        condition["one_of"].as_array().is_some_and(|one_of| {
            one_of
                .iter()
                .any(|option| option.as_str() == Some(text.as_str()))
        })
    }

    fn form_field_visible(
        entry: &Value,
        values: &BTreeMap<String, Value>,
        fields: &[Value],
    ) -> bool {
        let mut seen = vec![entry["key"].as_str().unwrap_or_default().to_string()];
        let mut current = entry;
        loop {
            let Some(condition) = current.get("visible_when").filter(|value| !value.is_null())
            else {
                return true;
            };
            if !form_condition_matches(condition, values, fields) {
                return false;
            }
            let Some(target_key) = condition["field"].as_str() else {
                return true;
            };
            if seen.iter().any(|key| key == target_key) {
                return true;
            }
            seen.push(target_key.to_string());
            let Some(target) = fields
                .iter()
                .find(|candidate| candidate["key"].as_str() == Some(target_key))
            else {
                return true;
            };
            current = target;
        }
    }

    fn form_field_required(
        entry: &Value,
        values: &BTreeMap<String, Value>,
        fields: &[Value],
    ) -> bool {
        if entry["required"].as_bool().unwrap_or(false) {
            return true;
        }
        match entry.get("required_when").filter(|value| !value.is_null()) {
            None => false,
            Some(condition) => form_condition_matches(condition, values, fields),
        }
    }

    fn form_value_present(value: Option<&Value>) -> bool {
        match value {
            None | Some(Value::Null) => false,
            Some(Value::String(text)) => !text.trim().is_empty(),
            Some(_) => true,
        }
    }

    /// The field the dialog would block "save" on, if any.
    fn form_blocking_field(fields: &[Value], values: &BTreeMap<String, Value>) -> Option<String> {
        fields
            .iter()
            .find(|entry| {
                form_field_visible(entry, values, fields)
                    && form_field_required(entry, values, fields)
                    && !form_value_present(form_value(values, entry).as_ref())
            })
            .map(|entry| entry["key"].as_str().unwrap_or_default().to_string())
    }

    /// The lifecycle `connection` object a save would persist, built the way the
    /// host builds it (config → `external_config`, secret → `connection_secrets`
    /// with empty values removed, identity/password bindings hoisted).
    fn connection_payload(fields: &[Value], values: &BTreeMap<String, Value>) -> Value {
        let mut external = serde_json::Map::new();
        let mut secrets = serde_json::Map::new();
        let mut name = String::from("SSH server");
        let mut host = String::new();
        let mut port: u64 = 0;
        let mut username = String::new();
        let mut password = String::new();
        let text = |value: Option<Value>| -> String {
            match value {
                Some(Value::String(text)) => text,
                Some(other) => other.to_string(),
                None => String::new(),
            }
        };
        for entry in fields {
            let key = entry["key"].as_str().unwrap_or_default().to_string();
            let value = form_value(values, entry);
            match entry["binding"].as_str().unwrap_or_default() {
                "config" => match value {
                    None | Some(Value::Null) => {
                        external.remove(&key);
                    }
                    Some(value) => {
                        external.insert(key.clone(), value);
                    }
                },
                "secret" => match value {
                    None | Some(Value::Null) => {
                        secrets.remove(&key);
                    }
                    Some(Value::String(value)) if value.is_empty() => {
                        secrets.remove(&key);
                    }
                    Some(value) => {
                        secrets.insert(key.clone(), Value::String(text(Some(value))));
                    }
                },
                "name" => name = text(value),
                "host" => host = text(value),
                "port" => {
                    port = value
                        .as_ref()
                        .and_then(Value::as_u64)
                        .map(|port| port.min(u64::from(u16::MAX)))
                        .unwrap_or(0);
                }
                "username" => username = text(value),
                "password" => password = text(value),
                _ => {}
            }
        }
        serde_json::json!({
            "id": "form-matrix",
            "name": name,
            "host": host,
            "port": port,
            "username": username,
            "password": password,
            "external_config": external,
            "connection_secrets": secrets,
        })
    }

    /// 表单“保存”判定 ⇔ 解析层接受度。宿主动画框只拦「可见 ∧ 必填 ∧ 为空」，
    /// 真正的凭据规则在解析层，两者必须同向：
    ///   * 表单拦下、解析层却接受 → 用户被卡死（无法保存一个插件支持的配置）；
    ///   * 表单放行、解析层拒绝 → 只允许出现在 OR 语义（密码∨密码命令、
    ///     私钥路径∨私钥内容）无法在契约里表达处，且报错必须点名表单字段。
    #[test]
    fn form_save_state_matches_parser_acceptance() {
        let fields = connection_fields();
        let defaults: BTreeMap<String, Value> = fields
            .iter()
            .filter_map(|entry| {
                entry
                    .get("default")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        (
                            entry["key"].as_str().unwrap_or_default().to_string(),
                            value.clone(),
                        )
                    })
            })
            .collect();

        let mut cases = 0usize;
        let mut blocked_without_rejection = 0usize;
        let mut blocked_samples: Vec<String> = Vec::new();
        let mut unexplained_rejections: Vec<String> = Vec::new();
        for advanced_options in [false, true] {
            for authentication in [
                "password",
                "private-key",
                "private-key-password",
                "agent",
                "none",
            ] {
                for sudo_source in ["custom", "global", "off"] {
                    for auth_flow_mode in [
                        "off",
                        "password_then_otp",
                        "password_plus_otp",
                        "password_only",
                    ] {
                        for read_only in [false, true] {
                            for triggers_enabled in [false, true] {
                                for password in ["", "secret"] {
                                    for password_command in ["", "echo pw"] {
                                        for password_source in ["direct", "command"] {
                                            for private_key_path in ["", "~/.ssh/id_ed25519"] {
                                                for private_key in [
                                                    "",
                                                    "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n",
                                                ] {
                                                    for private_key_passphrase in ["", "phrase"] {
                                                        let mut values = defaults.clone();
                                                        for (key, value) in [
                                                            (
                                                                "advanced_options",
                                                                json!(advanced_options),
                                                            ),
                                                            (
                                                                "authentication",
                                                                json!(authentication),
                                                            ),
                                                            ("sudo_source", json!(sudo_source)),
                                                            (
                                                                "auth_flow_mode",
                                                                json!(auth_flow_mode),
                                                            ),
                                                            ("read_only", json!(read_only)),
                                                            (
                                                                "triggers_enabled",
                                                                json!(triggers_enabled),
                                                            ),
                                                            ("password", json!(password)),
                                                            (
                                                                "password_command",
                                                                json!(password_command),
                                                            ),
                                                            (
                                                                "password_source",
                                                                json!(password_source),
                                                            ),
                                                            (
                                                                "private_key_path",
                                                                json!(private_key_path),
                                                            ),
                                                            ("private_key", json!(private_key)),
                                                            (
                                                                "private_key_passphrase",
                                                                json!(private_key_passphrase),
                                                            ),
                                                        ] {
                                                            values.insert(key.to_string(), value);
                                                        }
                                                        cases += 1;
                                                        let blocked =
                                                            form_blocking_field(&fields, &values);
                                                        let payload =
                                                            connection_payload(&fields, &values);
                                                        let parsed =
                                                            StoredConnection::from_lifecycle_params(
                                                                &json!({ "connection": payload }),
                                                            );
                                                        match (&blocked, &parsed) {
                                                            (Some(key), Ok(_)) => {
                                                                blocked_without_rejection += 1;
                                                                if blocked_samples.len() < 4 {
                                                                    blocked_samples.push(format!(
                                                                    "{key}: authentication={authentication} \
                                                                     password={password:?} \
                                                                     password_command={password_command:?} \
                                                                     private_key_path={private_key_path:?} \
                                                                     private_key={} \
                                                                     private_key_passphrase={private_key_passphrase:?}",
                                                                    if private_key.is_empty() {
                                                                        "\"\""
                                                                    } else {
                                                                        "<key>"
                                                                    }
                                                                ));
                                                                }
                                                            }
                                                            (None, Err(error)) => {
                                                                let lower = error.to_lowercase();
                                                                // The message has to name the form
                                                                // fields that satisfy the rule, so a
                                                                // rejection is never a dead end.
                                                                let actionable = (lower
                                                                    .contains("\"password\"")
                                                                    && lower.contains(
                                                                        "\"password command\"",
                                                                    ))
                                                                    || (lower.contains(
                                                                        "\"private key path\"",
                                                                    ) && lower.contains(
                                                                        "\"private key content\"",
                                                                    ))
                                                                    || lower.contains("ssh port");
                                                                if !actionable
                                                                    && unexplained_rejections.len()
                                                                        < 4
                                                                {
                                                                    unexplained_rejections
                                                                        .push(error.clone());
                                                                }
                                                            }
                                                            _ => {}
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        assert_eq!(
            blocked_without_rejection, 0,
            "the dialog blocks {blocked_without_rejection} configuration(s) the parser accepts \
             (dead-locked footer, no way to save). Samples: {blocked_samples:#?}"
        );
        assert!(
            unexplained_rejections.is_empty(),
            "parser rejects without naming the form field that fixes it: {unexplained_rejections:?}"
        );
        assert!(
            cases >= 15_000,
            "form/parser matrix shrank unexpectedly ({cases} cases)"
        );
    }

    /// 端口在表单里只受 `type: number` 约束，宿主 Rust 层与解析层各自校验
    /// 1..65535；契约无 min/max 属性，所以范围提示必须留在描述里（前端契约
    /// 脚本 `scripts/connection-forms/verify.mjs` 断言七语都写了）。
    #[test]
    fn password_source_is_honored_by_the_parser() {
        let connection = |external: Value, password: Option<&str>| {
            let mut payload = json!({
                "id": "pw-source",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": external,
            });
            if let Some(password) = password {
                payload["password"] = json!(password);
            }
            StoredConnection::from_lifecycle_params(&json!({ "connection": payload }))
        };

        // 老配置（0.4.x 只有 password/password_command）与 MCP 内联参数没有
        // 来源字段：保持历史语义，两者二选一，显式密码优先、命令保留。
        let legacy = connection(
            json!({ "authentication": "password", "password_command": "echo pw" }),
            Some("stored"),
        )
        .unwrap();
        assert_eq!(legacy.password, "stored");
        assert_eq!(legacy.password_command, "echo pw");
        let legacy_command = connection(
            json!({ "authentication": "password", "password_command": "echo pw" }),
            None,
        )
        .unwrap();
        assert!(legacy_command.password.is_empty());
        assert_eq!(legacy_command.password_command, "echo pw");

        // direct：密码必填，缺失时点名两个表单字段（并给出改来源的出口）。
        let direct = connection(
            json!({ "authentication": "password", "password_source": "direct" }),
            Some("typed"),
        )
        .unwrap();
        assert_eq!(direct.password, "typed");
        let direct_missing = connection(
            json!({
                "authentication": "password",
                "password_source": "direct",
                "password_command": "echo pw"
            }),
            None,
        )
        .unwrap_err();
        assert!(
            direct_missing.contains("Password source"),
            "{direct_missing}"
        );
        assert!(direct_missing.contains("\"Password\""), "{direct_missing}");

        // command：命令必填，且存量密码让位——否则「显式密码优先」会让用户
        // 显式选择的本地命令永不执行。
        let command = connection(
            json!({
                "authentication": "password",
                "password_source": "command",
                "password_command": "echo pw"
            }),
            Some("stale"),
        )
        .unwrap();
        assert!(
            command.password.is_empty(),
            "command source must drop the stored password so the command runs"
        );
        assert_eq!(command.password_command, "echo pw");
        let command_missing = connection(
            json!({ "authentication": "password", "password_source": "command" }),
            Some("stale"),
        )
        .unwrap_err();
        assert!(
            command_missing.contains("Password command"),
            "{command_missing}"
        );

        // 非密码类认证不受来源约束（字段隐藏，值可能是残留）。
        let agent = connection(
            json!({ "authentication": "agent", "password_source": "command" }),
            None,
        )
        .unwrap();
        assert!(agent.password.is_empty());

        // 未知来源：明确报错，不静默回退成 direct。
        let unknown = connection(
            json!({ "authentication": "password", "password_source": "keychain" }),
            Some("typed"),
        )
        .unwrap_err();
        assert!(
            unknown.contains("Unsupported password source 'keychain'"),
            "{unknown}"
        );
    }

    #[test]
    fn port_zero_is_rejected_by_parser_with_a_self_explanatory_message() {
        let error = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "port-zero",
                "host": "example.com",
                "port": 0,
                "username": "user",
                "password": "pw",
                "external_config": { "authentication": "password" }
            }
        }))
        .unwrap_err();
        assert!(error.contains("port"), "{error}");
        let description = field("port")["description"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(description.contains("65535"), "{description}");
    }

    /// 发布前的表单组合矩阵：认证方式、sudo 来源、只读开关、2FA 模式等
    /// 下拉/开关的每一种交叉，在解析层要么成功且语义正确，要么干净报错
    /// ——绝不 panic、绝不静默错位。表单切换认证方式会在不可见字段里留下
    /// 残留凭据，这类组合必须被容忍（多余凭据被忽略而非报错），否则用户改
    /// 一个下拉框就再也连不上。
    #[test]
    fn form_option_combinations_parse_without_conflicts() {
        let connection_with = |authentication: &str,
                               password: Option<&str>,
                               mut external_config: Value,
                               secrets: Value|
         -> Result<StoredConnection, String> {
            external_config["authentication"] = Value::String(authentication.to_string());
            let mut connection = serde_json::json!({
                "id": "combo-matrix",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": external_config
            });
            if let Some(password) = password {
                connection["password"] = Value::String(password.to_string());
            }
            if !secrets.is_null() {
                connection["connection_secrets"] = secrets;
            }
            StoredConnection::from_lifecycle_params(
                &serde_json::json!({ "connection": connection }),
            )
        };

        // ① 每个认证方式的最小必需凭据组合都必须通过（含表单里显式提供
        //    的 none / agent 这两个"零凭据"选项）。
        let minimal: &[(&str, Option<&str>, Value, Value, AuthenticationMethod)] = &[
            (
                "password",
                Some("pw"),
                serde_json::json!({}),
                serde_json::json!({}),
                AuthenticationMethod::Password,
            ),
            (
                "private-key",
                None,
                serde_json::json!({ "private_key_path": "~/.ssh/id_ed25519" }),
                serde_json::json!({}),
                AuthenticationMethod::PrivateKey,
            ),
            (
                "private-key-password",
                Some("pw"),
                serde_json::json!({ "private_key_path": "/keys/id_ed25519" }),
                serde_json::json!({ "private_key_passphrase": "pp" }),
                AuthenticationMethod::PrivateKeyPassword,
            ),
            (
                "agent",
                None,
                serde_json::json!({}),
                serde_json::json!({}),
                AuthenticationMethod::Agent,
            ),
            (
                "none",
                None,
                serde_json::json!({}),
                serde_json::json!({}),
                AuthenticationMethod::None,
            ),
        ];
        for (authentication, password, external, secrets, expected) in minimal {
            let parsed =
                connection_with(authentication, *password, external.clone(), secrets.clone())
                    .unwrap_or_else(|error| {
                        panic!("{authentication} minimal combo rejected: {error}")
                    });
            assert_eq!(
                parsed.authentication, *expected,
                "minimal combo for '{authentication}' misparses"
            );
        }

        // ② 残留凭据容忍：表单里所有凭据字段都有值时（用户来回切换过
        //    认证方式），每种认证方式都必须照常解析且方法正确。
        let everything_external = serde_json::json!({ "private_key_path": "/keys/k" });
        let everything_secrets = serde_json::json!({ "private_key_passphrase": "pp", "totp_secret": "JBSWY3DPEHPK3PXP" });
        for (authentication, _, _, _, expected) in minimal {
            let parsed = connection_with(
                authentication,
                Some("pw"),
                everything_external.clone(),
                everything_secrets.clone(),
            )
            .unwrap_or_else(|error| {
                panic!("{authentication} leftover-credential combo rejected: {error}")
            });
            assert_eq!(
                parsed.authentication, *expected,
                "leftover-credential combo for '{authentication}' misparses"
            );
        }

        // ③ 必需凭据缺失 → 干净报错并指出缺什么。
        let missing_password = connection_with(
            "password",
            None,
            serde_json::json!({}),
            serde_json::json!({}),
        )
        .unwrap_err();
        assert!(
            missing_password.contains("requires a password"),
            "{missing_password}"
        );
        let missing_key = connection_with(
            "private-key",
            None,
            serde_json::json!({}),
            serde_json::json!({}),
        )
        .unwrap_err();
        assert!(
            missing_key.contains("requires a private key path"),
            "{missing_key}"
        );
        let half_of_private_key_password = connection_with(
            "private-key-password",
            None,
            serde_json::json!({ "private_key_path": "/keys/k" }),
            serde_json::json!({}),
        )
        .unwrap_err();
        assert!(
            half_of_private_key_password.contains("requires a password"),
            "{half_of_private_key_password}"
        );
        let other_half = connection_with(
            "private-key-password",
            Some("pw"),
            serde_json::json!({}),
            serde_json::json!({}),
        )
        .unwrap_err();
        assert!(
            other_half.contains("requires a private key path"),
            "{other_half}"
        );

        // ④ 无法识别的认证值 → 明确报错（而非静默回落 password，那会把
        //    拼错的组合变成一次注定失败的密码登录）。
        let typo = connection_with(
            "publickey",
            Some("pw"),
            serde_json::json!({}),
            serde_json::json!({}),
        )
        .unwrap_err();
        assert!(
            typo.contains("Unsupported SSH authentication method 'publickey'"),
            "{typo}"
        );

        // ⑤ read_only × sudo_source 全矩阵：六个组合都必须可解析，
        //    sudo_enabled 只反映凭据来源——只读是正交的运行时门禁
        //    （ssh.rs 的 exec/sudo 通道负责拦截），解析层不得混淆二者。
        for read_only in [false, true] {
            for source in ["custom", "global", "off"] {
                let parsed = connection_with(
                    "password",
                    Some("pw"),
                    serde_json::json!({ "sudo_source": source, "read_only": read_only }),
                    serde_json::json!({}),
                )
                .unwrap_or_else(|error| {
                    panic!("read_only={read_only} sudo_source={source} rejected: {error}")
                });
                assert_eq!(parsed.read_only, read_only, "sudo_source={source}");
                assert_eq!(
                    parsed.sudo_enabled(),
                    source != "off",
                    "read_only={read_only} sudo_source={source}"
                );
            }
        }

        // ⑥ auth_flow_mode 交叉：sudo_source=global 时连接自身的 2FA 模式
        //    仍可解析（表单隐藏它，但登录期 keyboard-interactive 还要用）；
        //    password_only 携带 totp_secret 也合法——运行时静默忽略 OTP，
        //    不算配置冲突。
        for flow in [
            "password_only",
            "password_plus_otp",
            "password_then_otp",
            "ssh-agent-garbage",
        ] {
            for source in ["custom", "global", "off"] {
                let parsed = connection_with(
                    "password",
                    Some("pw"),
                    serde_json::json!({
                        "sudo_source": source,
                        "auth_flow_mode": flow,
                        "totp_prompt_hint": "duo passcode"
                    }),
                    serde_json::json!({ "totp_secret": "JBSWY3DPEHPK3PXP" }),
                )
                .unwrap_or_else(|error| {
                    panic!("auth_flow_mode={flow} sudo_source={source} rejected: {error}")
                });
                assert_eq!(parsed.auth_flow_mode, flow, "sudo_source={source}");
            }
        }

        // ⑦ 端口边界：0 与 65536 报错，1 与 65535 合法。
        for (port, ok) in [(0u64, false), (1, true), (65535, true), (65536, false)] {
            let connection = serde_json::json!({
                "id": "port-edge",
                "host": "example.com",
                "port": port,
                "username": "user",
                "password": "pw",
                "external_config": { "authentication": "password" }
            });
            let result = StoredConnection::from_lifecycle_params(
                &serde_json::json!({ "connection": connection }),
            );
            assert_eq!(
                result.is_ok(),
                ok,
                "port {port} should {}",
                if ok { "parse" } else { "be rejected" }
            );
        }

        // ⑧ connect_timeout_secs=0 钳到下限 1，而非让握手等待 0 秒后立即
        //    超时（表单允许输入 0，解析层负责收敛）。
        let zero_timeout = connection_with(
            "password",
            Some("pw"),
            serde_json::json!({ "connect_timeout_secs": 0 }),
            serde_json::json!({}),
        )
        .unwrap();
        assert_eq!(zero_timeout.connect_timeout_secs, 1);

        // ⑧b 表单未填时跟随 manifest 默认（30s）：慢速 Windows/macOS 主机的
        //    握手+认证预算不再按旧默认 15s 一连接就打满。
        let default_timeout = connection_with(
            "password",
            Some("pw"),
            serde_json::json!({}),
            serde_json::json!({}),
        )
        .unwrap();
        assert_eq!(default_timeout.connect_timeout_secs, 30);

        // ⑨ 跳板机不接受 none：链上每一跳都必须认证，"No authentication"
        //    只对最终会话合法。
        let none_hop = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "hop-none",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "pw",
                "external_config": {
                    "authentication": "password",
                    "jump_hosts": [
                        { "host": "bastion", "port": 22, "username": "ops", "authentication": "none" }
                    ]
                }
            }
        }))
        .unwrap_err();
        assert!(
            none_hop.contains("Unsupported jump host authentication method 'none'"),
            "{none_hop}"
        );
    }

    /// 触发器（Expect）与外部密码管理器配置的解析面：external_config 的
    /// triggers（对象/字符串两形态）、密文槽位解析、非法配置整连接失败
    /// （D7）、password_command 让密码类认证允许留空（显式密码优先）。
    #[test]
    fn triggers_and_credential_commands_parse_strictly() {
        let lifecycle = |external_config: Value, secrets: Value| {
            let mut connection = serde_json::json!({
                "id": "triggers",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "pw",
                "external_config": external_config,
            });
            if !secrets.is_null() {
                connection["connection_secrets"] = secrets;
            }
            StoredConnection::from_lifecycle_params(&serde_json::json!({
                "connection": connection
            }))
        };

        // ① 对象形态（宿主 lifecycle / MCP 桥转发）：密文槽位解析成功。
        let parsed = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers_enabled": true,
                "triggers": {
                    "timeoutSecs": 45,
                    "sleepMs": 200,
                    "passSleep": "enter",
                    "stages": [
                        { "pattern": "code:", "sendSecretKey": "trigger_answer_1" },
                        { "pattern": "proceed", "sendText": "yes\\r",
                          "casePattern": "\\(y/n\\)", "caseSendText": "y" }
                    ]
                },
                "password_command": "op read vault",
                "passphrase_command": "security find-password -w"
            }),
            serde_json::json!({ "trigger_answer_1": "one" }),
        )
        .unwrap();
        let triggers = parsed.triggers.expect("triggers must parse");
        assert_eq!(triggers.timeout_secs, 45);
        assert_eq!(triggers.sleep_ms, 200);
        assert_eq!(triggers.stages.len(), 2);
        assert_eq!(triggers.stages[0].answer.kind(), "secret");
        assert!(triggers.stages[1].case.is_some());
        assert_eq!(parsed.password_command, "op read vault");
        assert_eq!(parsed.passphrase_command, "security find-password -w");

        // ② 字符串形态（连接表单 textarea）同样解析。
        let parsed = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers_enabled": true,
                "triggers": r#"{"stages":[{"pattern":"code","sendText":"1\r"}]}"#
            }),
            Value::Null,
        )
        .unwrap();
        assert_eq!(parsed.triggers.expect("string form parses").stages.len(), 1);

        // ③ 独立开关默认关闭：旧的非空文本也必须不解析、不启用。
        let disabled_with_bad_text = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers": "{not json"
            }),
            Value::Null,
        )
        .unwrap();
        assert!(!disabled_with_bad_text.triggers_enabled);
        assert!(disabled_with_bad_text.triggers.is_none());

        // ④ 空配置仍表示关闭（即使显式打开开关也没有 engine）。
        for raw in [
            Value::Null,
            Value::from(""),
            serde_json::json!({ "stages": [] }),
        ] {
            let mut external = serde_json::json!({
                "authentication": "password"
            });
            if !raw.is_null() {
                external["triggers"] = raw;
            }
            let parsed = lifecycle(external, Value::Null).unwrap();
            assert!(parsed.triggers.is_none(), "expected disabled");
        }

        // ⑤ 非法 JSON / 未知密文槽位 → 连接失败并给出可定位的错误（D7）。
        let error = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers_enabled": true,
                "triggers": "{not json"
            }),
            Value::Null,
        )
        .unwrap_err();
        assert!(error.contains("triggers"), "{error}");
        let error = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers_enabled": true,
                "triggers": { "stages": [{ "pattern": "p", "sendSecretKey": "nope" }] }
            }),
            Value::Null,
        )
        .unwrap_err();
        assert!(error.contains("unknown secret slot"), "{error}");
        // 引用的槽位未填充同样失败（静默发空行比失败更难排查）。
        let error = lifecycle(
            serde_json::json!({
                "authentication": "password",
                "triggers_enabled": true,
                "triggers": { "stages": [{ "pattern": "p", "sendSecretKey": "trigger_answer_1" }] }
            }),
            Value::Null,
        )
        .unwrap_err();
        assert!(error.contains("is empty"), "{error}");

        // ⑥ password_command 允许密码类认证留空密码（命令在连接期取回）。
        // 顶层 connection 无 password 字段、仅配置命令时解析成功。
        let parsed = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "triggers",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": {
                    "authentication": "password",
                    "password_command": "op read vault"
                }
            }
        }))
        .unwrap();
        assert!(parsed.password.is_empty());
        assert_eq!(parsed.password_command, "op read vault");
        // 两者都没有才拒绝。
        let error = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "triggers",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "password" }
            }
        }))
        .unwrap_err();
        assert!(error.contains("password_command"), "{error}");
    }

    /// Every manifest field must land in the store the model reads it from:
    /// `secret` bindings come from `connection_secrets`, `config` bindings
    /// from `external_config` and are consumed by the parser.
    #[test]
    fn bindings_match_parse_surfaces() {
        // private_key 现在被解析面消费（表单粘贴的私钥内容 / 外部工具写入的
        // 存量 secret），从 connection_secrets 读取。
        // trigger_answer_1/2 是触发器密文槽位，经 triggers 解析面消费（sendSecretKey 解析）。
        let secret_keys = [
            "private_key",
            "private_key_passphrase",
            "sudo_password",
            "totp_secret",
            "trigger_answer_1",
            "trigger_answer_2",
        ];
        let config_keys = [
            "authentication",
            "private_key_path",
            "agent_socket",
            "advanced_options",
            "connect_timeout_secs",
            "keepalive_interval_secs",
            "terminal_keepalive_secs",
            "set_env",
            "triggers_enabled",
            "triggers",
            "password_command",
            "password_source",
            "passphrase_command",
            "remote_command",
            "sudo_source",
            "sudo_profile",
            "sudo_use_pty",
            "sudo_whitelist",
            "read_only",
            "auth_flow_mode",
            "password_prompt_hint",
            "totp_prompt_hint",
        ];
        let mut seen_secret: Vec<String> = Vec::new();
        let mut seen_config: Vec<String> = Vec::new();
        for entry in connection_fields() {
            match entry["binding"].as_str().unwrap_or("") {
                "secret" => seen_secret.push(entry["key"].as_str().unwrap().to_string()),
                "config" => seen_config.push(entry["key"].as_str().unwrap().to_string()),
                "name" | "host" | "port" | "username" | "password" => {
                    let key = entry["key"].as_str().unwrap();
                    assert!(
                        matches!(
                            key,
                            "display_name" | "host" | "port" | "username" | "password"
                        ),
                        "unexpected binding for field '{key}'"
                    );
                }
                other => panic!("unexpected binding '{other}' in manifest"),
            }
        }
        seen_secret.sort_unstable();
        seen_config.sort_unstable();
        let mut expected_secret: Vec<String> =
            secret_keys.iter().map(|value| value.to_string()).collect();
        expected_secret.sort_unstable();
        let mut expected_config: Vec<String> =
            config_keys.iter().map(|value| value.to_string()).collect();
        expected_config.sort_unstable();
        assert_eq!(
            seen_secret, expected_secret,
            "secret bindings must match connection_secrets keys"
        );
        assert_eq!(
            seen_config, expected_config,
            "config bindings must match external_config keys consumed by the parser"
        );
    }

    /// Visible-when pairing: pure Quick Sudo knobs follow the form's sudo
    /// source selection; the 2FA quartet hides under `global` (the bound
    /// profile owns the whole credential source, login-time
    /// keyboard-interactive included) and stays visible for custom/off where
    /// the connection's own values still serve login-time 2FA.
    #[test]
    fn quick_sudo_visibility_pairing() {
        for key in ["sudo_password", "sudo_use_pty"] {
            let entry = field(key);
            assert_eq!(
                condition_field(&entry, "visible_when"),
                Some("sudo_source"),
                "{key} must be gated on sudo_source"
            );
            assert_eq!(
                condition_one_of(&entry, "visible_when"),
                Some(vec!["custom".to_string()]),
                "{key} must be visible only while sudo_source is custom"
            );
        }
        let profile = field("sudo_profile");
        assert_eq!(
            condition_field(&profile, "visible_when"),
            Some("sudo_source"),
            "sudo_profile must be gated on sudo_source"
        );
        assert_eq!(
            condition_one_of(&profile, "visible_when"),
            Some(vec!["global".to_string()]),
            "sudo_profile must be visible only while sudo_source is global"
        );
        for key in ["auth_flow_mode", "password_prompt_hint"] {
            assert_eq!(
                condition_field(&field(key), "visible_when"),
                Some("sudo_source"),
                "{key} must be gated on sudo_source"
            );
            assert_eq!(
                condition_one_of(&field(key), "visible_when"),
                Some(vec!["custom".to_string(), "off".to_string()]),
                "{key} must hide under global (profile owns the source) and stay visible for custom/off"
            );
        }
        for key in ["totp_secret", "totp_prompt_hint"] {
            assert_eq!(
                condition_field(&field(key), "visible_when"),
                Some("auth_flow_mode")
            );
            assert_eq!(
                condition_one_of(&field(key), "visible_when"),
                Some(vec![
                    "password_then_otp".to_string(),
                    "password_plus_otp".to_string()
                ])
            );
        }
    }

    /// Manifest defaults must equal the parser's fallback defaults; feeding
    /// them through `from_lifecycle_params` reproduces the same connection.
    #[test]
    fn defaults_match_parser_fallbacks() {
        let expected_defaults: &[(&str, Value)] = &[
            ("display_name", Value::from("SSH server")),
            ("host", Value::from("127.0.0.1")),
            ("port", Value::from(22)),
            ("username", Value::from("root")),
            ("authentication", Value::from("password")),
            ("connect_timeout_secs", Value::from(30)),
            ("keepalive_interval_secs", Value::from(30)),
            ("terminal_keepalive_secs", Value::from(0)),
            ("triggers_enabled", Value::from(false)),
            ("sudo_source", Value::from("custom")),
            ("sudo_use_pty", Value::from(false)),
            ("set_env", Value::from("")),
            ("triggers", Value::from("")),
            ("password_command", Value::from("")),
            ("passphrase_command", Value::from("")),
            ("remote_command", Value::from("")),
            // auth_flow_mode 有意不在此列：表单默认 off（新连接不自动回
            // OTP），解析回退保持 PasswordThenOtp（存量连接不受新默认影
            // 响），两者允许分歧——见 auth_flow_mode 表单默认断言。
            ("read_only", Value::from(false)),
        ];
        for (key, expected) in expected_defaults {
            assert_eq!(
                field(key)["default"],
                *expected,
                "manifest default mismatch for '{key}'"
            );
        }

        let connection = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "defaults",
                "host": "127.0.0.1",
                "port": 22,
                "username": "root",
                "password": "secret",
                "external_config": {
                    "authentication": "password",
                    "connect_timeout_secs": 15,
                    "keepalive_interval_secs": 30,
                    "terminal_keepalive_secs": 0,
                    "sudo_source": "custom",
                    "sudo_use_pty": false,
                    "auth_flow_mode": "password_then_otp",
                    "read_only": false
                }
            }
        }))
        .unwrap();
        assert_eq!(connection.authentication, AuthenticationMethod::Password);
        assert_eq!(connection.connect_timeout_secs, 15);
        assert_eq!(connection.keepalive_interval_secs, 30);
        assert_eq!(connection.terminal_keepalive_secs, 0);
        assert!(connection.sudo_enabled());
        assert!(!connection.sudo_use_pty);
        assert_eq!(connection.auth_flow_mode, "password_then_otp");
        assert!(!connection.read_only);
    }

    /// The terminal activity keepalive is opt-in: absent config means off,
    /// an enabled value is clamped into 5..=3600 regardless of what the
    /// connection form passes through.
    #[test]
    fn terminal_keepalive_is_opt_in_and_clamped() {
        assert_eq!(clamp_terminal_keepalive(0), 0);
        assert_eq!(clamp_terminal_keepalive(1), 5);
        assert_eq!(clamp_terminal_keepalive(4), 5);
        assert_eq!(clamp_terminal_keepalive(30), 30);
        assert_eq!(clamp_terminal_keepalive(3600), 3600);
        assert_eq!(clamp_terminal_keepalive(100_000), 3600);

        let enabled = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "keepalive-on",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret",
                "external_config": {
                    "terminal_keepalive_secs": 90,
                    "keepalive_interval_secs": 60,
                    "connect_timeout_secs": 20
                }
            }
        }))
        .unwrap();
        assert_eq!(enabled.terminal_keepalive_secs, 90);
        // Form-driven timeout/keepalive must win over the defaults too (the
        // parser reads external_config with a top-level fallback).
        assert_eq!(enabled.keepalive_interval_secs, 60);
        assert_eq!(enabled.connect_timeout_secs, 20);

        let off = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "keepalive-off",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "secret",
                "external_config": { "terminal_keepalive_secs": 0 }
            }
        }))
        .unwrap();
        assert_eq!(off.terminal_keepalive_secs, 0);
    }

    /// 私钥凭据是「路径或内容」二选一：只贴内容、只给路径都能解析，两者
    /// 全缺才在连接时报错；口令（passphrase）对未加密密钥保持可选。
    #[test]
    fn private_key_accepts_path_or_content() {
        let entry = field("private_key_path");
        assert!(
            entry["required_when"].is_null(),
            "private_key_path must stay optional: pasted key content is a valid alternative"
        );
        assert!(field("private_key_passphrase")["required_when"].is_null());

        let content_only = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "content-only",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "private-key" },
                "connection_secrets": { "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\n..." }
            }
        }))
        .unwrap();
        assert!(content_only.private_key_path.is_empty());
        assert!(content_only.private_key.starts_with("-----BEGIN"));

        // 多行凭据必须原样保留：PEM/PPK 内容不允许被 trim 破坏。
        let multiline = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "multiline-key",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "private-key" },
                "connection_secrets": { "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n" }
            }
        }))
        .unwrap();
        assert!(multiline
            .private_key
            .ends_with("-----END OPENSSH PRIVATE KEY-----\n"));

        let neither = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "no-key",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": { "authentication": "private-key" },
                "connection_secrets": {}
            }
        }))
        .unwrap_err();
        assert!(
            neither.contains("requires a private key path or key content"),
            "{neither}"
        );
    }

    /// The passphrase stays optional for unencrypted keys (private-key-password
    /// mode must not be rejected for a missing passphrase).
    #[test]
    fn private_key_password_fallback_does_not_require_passphrase() {
        let without_passphrase = StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "plain-key",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "external_config": {
                    "authentication": "private-key-password",
                    "private_key_path": "/keys/id_ed25519"
                },
                "connection_secrets": {}
            }
        }))
        .unwrap_err();
        assert!(
            !without_passphrase.contains("private key path"),
            "unencrypted private-key-password keys must not be rejected for a missing passphrase"
        );
    }
}
