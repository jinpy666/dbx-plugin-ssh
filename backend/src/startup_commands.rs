//! Connection-scoped startup commands (Tabby "Login scripts" parity, M7 P0-4).
//!
//! The workbench edits, per connection id, an ordered list of commands that the
//! sidecar types into the interactive PTY right after the shell comes up
//! (`ssh.rs` spawns the injector once `request_shell` succeeded). This is a
//! shell-level keyboard sequence — deliberately NOT a `RemoteCommand`: an exec
//! replaces the shell instead of typing into it, so sessions with a non-empty
//! `remote_command` skip startup commands entirely (see [`executes_for`]).
//!
//! Storage reuses the allowlisted `preferences.json` infra under one key,
//! `startup_commands`: `{ <connectionId>: { enabled, commands: [...] } }`.
//! Command contents can carry secrets, so they never reach logs, audit or
//! events — the `ssh/startup` event only reports the count and completion.
//!
//! Everything here is pure (or driven through an injected sender) so the
//! parsing, limits and injection sequence are unit-testable without SSH.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Map, Value};

/// Per-command pause before typing (default). Gives the shell time to show a
/// prompt after the session opens.
pub const DEFAULT_DELAY_MS: u64 = 300;
/// Per-command pause ceiling: a stuck delay must not stall the session for
/// minutes (Tabby's login-script delay has the same "short wait" semantics).
pub const MAX_DELAY_MS: u64 = 30_000;
/// Commands per connection.
pub const MAX_COMMANDS: usize = 20;
/// Single-command size ceiling (bytes, UTF-8 boundary safe). Startup commands
/// are typed keystrokes, not scripts.
pub const MAX_COMMAND_BYTES: usize = 4 * 1024;
/// Connections tracked in the shared preference map, so one file cannot grow
/// without bound.
pub const MAX_CONNECTIONS: usize = 512;

/// One typed command: the text plus the pause before it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupCommand {
    pub command: String,
    pub delay_ms: u64,
}

/// Whether startup commands apply to a session: only real shell sessions.
/// A non-empty `remote_command` execs instead of spawning a shell, so there is
/// no prompt to type into — a semantic conflict, never a fallback.
pub fn executes_for(remote_command: &str) -> bool {
    remote_command.is_empty()
}

/// Strips the trailing CR/LF run (the injector appends its own Enter) and caps
/// the command at [`MAX_COMMAND_BYTES`] on a UTF-8 char boundary.
fn clean_command(raw: &str) -> Option<String> {
    let trimmed = raw.trim_end_matches(['\r', '\n']);
    // 纯空白（含全空格）没有可执行内容：直接丢弃而不是原样注入。
    if trimmed.trim().is_empty() {
        return None;
    }
    let owned = if trimmed.len() <= MAX_COMMAND_BYTES {
        trimmed.to_string()
    } else {
        let mut end = MAX_COMMAND_BYTES;
        while !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        trimmed[..end].to_string()
    };
    Some(owned)
}

/// Clamps the per-command pause: missing/non-numeric falls back to the
/// default, values above the ceiling truncate to the ceiling (never rejected —
/// a hand-edited or stale file must not break the session).
fn clamp_delay(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .unwrap_or(DEFAULT_DELAY_MS)
            .min(MAX_DELAY_MS),
        Some(Value::String(text)) => text
            .trim()
            .parse::<u64>()
            .unwrap_or(DEFAULT_DELAY_MS)
            .min(MAX_DELAY_MS),
        _ => DEFAULT_DELAY_MS,
    }
}

/// Runtime parse of one command entry. Disabled (`enabled: false`), empty or
/// malformed entries are dropped rather than failing the whole plan.
fn parse_entry(value: &Value) -> Option<StartupCommand> {
    let object = value.as_object()?;
    if object.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let raw = object.get("command")?.as_str()?;
    let command = clean_command(raw)?;
    Some(StartupCommand {
        command,
        delay_ms: clamp_delay(object.get("delayMs")),
    })
}

/// Persisted shape of one entry: normalized for the workbench round-trip.
/// Unlike [`parse_entry`] this keeps `enabled: false` rows so the editor can
/// show them.
pub(crate) fn sanitize_entry(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let raw = object.get("command").and_then(Value::as_str)?;
    let command = clean_command(raw)?;
    Some(json!({
        "command": command,
        "delayMs": clamp_delay(object.get("delayMs")),
        "enabled": object.get("enabled").and_then(Value::as_bool).unwrap_or(true),
    }))
}

/// Sanitizes the whole `startup_commands` preference value: an object keyed by
/// connection id, each entry `{ enabled: bool (default false), commands: [...] }`.
/// Malformed connections/entries are dropped, never rejected, so a hand-edited
/// file cannot wedge the workbench preferences panel.
pub(crate) fn sanitize_store(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut out = Map::new();
    for (connection_id, entry) in object {
        if out.len() >= MAX_CONNECTIONS {
            break;
        }
        let Some(entry) = entry.as_object() else {
            continue;
        };
        let commands = entry
            .get("commands")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(sanitize_entry)
                    .take(MAX_COMMANDS)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.insert(
            connection_id.clone(),
            json!({
                "enabled": entry.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                "commands": commands,
            }),
        );
    }
    Some(Value::Object(out))
}

/// The active plan for one connection from a sanitized store value: nothing
/// unless the connection's master switch is on; disabled entries filtered;
/// order preserved.
pub(crate) fn active_commands(store: Option<&Value>, connection_id: &str) -> Vec<StartupCommand> {
    let Some(store) = store.and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(entry) = store.get(connection_id) else {
        return Vec::new();
    };
    if entry.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Vec::new();
    }
    entry
        .get("commands")
        .and_then(Value::as_array)
        // Re-state the cap on the read path: the write path sanitizes, but a
        // hand-crafted preferences.json must not inject an unbounded sequence.
        .map(|items| {
            items
                .iter()
                .filter_map(parse_entry)
                .take(MAX_COMMANDS)
                .collect()
        })
        .unwrap_or_default()
}

/// Reads the plan straight from `preferences.json` on disk. Missing or
/// corrupted file degrades to an empty plan (same policy as the preferences
/// loader) — a broken store must never block opening a session.
pub(crate) fn load_plan(data_dir: &Path, connection_id: &str) -> Vec<StartupCommand> {
    let text =
        std::fs::read_to_string(crate::preferences::store_path(data_dir)).unwrap_or_default();
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    active_commands(
        value
            .get("prefs")
            .and_then(|prefs| prefs.get("startup_commands")),
        connection_id,
    )
}

/// The bytes typed into the PTY for one command: the text plus Enter.
pub(crate) fn input_payload(command: &str) -> Vec<u8> {
    let mut payload = command.as_bytes().to_vec();
    payload.push(b'\r');
    payload
}

/// Sequential injector (Tabby login-script semantics): waits `delay_ms` before
/// each command (the first wait also covers shell spin-up), then hands the
/// payload to `send`. `send` returning `false` — the session's input channel is
/// gone — stops the sequence and reports incomplete. `true` = every command
/// was delivered.
pub(crate) async fn inject_sequence<S, Fut>(commands: &[StartupCommand], mut send: S) -> bool
where
    S: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for command in commands {
        tokio::time::sleep(Duration::from_millis(command.delay_ms)).await;
        if !send(input_payload(&command.command)).await {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executes_only_for_plain_shell_sessions() {
        // 空串（含恰好空串）= 交互 shell，startup_commands 生效。
        assert!(executes_for(""));
        // 非空 remote_command 走 exec 替代 shell：语义冲突，永不注入。
        assert!(!executes_for("tail -f /var/log/syslog"));
        assert!(!executes_for(" "));
    }

    #[test]
    fn parse_entry_defaults_and_clamps_delay() {
        // 缺省 delayMs → 300。
        assert_eq!(
            parse_entry(&json!({ "command": "cd /var/log" })),
            Some(StartupCommand {
                command: "cd /var/log".into(),
                delay_ms: 300
            })
        );
        // 超上限截断到 30s；字符串数字同样接受并钳制。
        assert_eq!(
            parse_entry(&json!({ "command": "x", "delayMs": 99_999 })),
            Some(StartupCommand {
                command: "x".into(),
                delay_ms: 30_000
            })
        );
        assert_eq!(
            parse_entry(&json!({ "command": "x", "delayMs": "5000" })),
            Some(StartupCommand {
                command: "x".into(),
                delay_ms: 5_000
            })
        );
        // 非法 delay 回默认；0 合法（不设等待）。
        assert_eq!(
            parse_entry(&json!({ "command": "x", "delayMs": "abc" })),
            Some(StartupCommand {
                command: "x".into(),
                delay_ms: 300
            })
        );
        assert_eq!(
            parse_entry(&json!({ "command": "x", "delayMs": 0 })),
            Some(StartupCommand {
                command: "x".into(),
                delay_ms: 0
            })
        );
        // 命令结尾的 CR/LF 剥掉（注入器自带回车），全空命令丢弃。
        assert_eq!(
            parse_entry(&json!({ "command": "echo hi\r\n" })),
            Some(StartupCommand {
                command: "echo hi".into(),
                delay_ms: 300
            })
        );
        assert_eq!(parse_entry(&json!({ "command": "\r\n" })), None);
        // 显式禁用丢弃。
        assert_eq!(
            parse_entry(&json!({ "command": "x", "enabled": false })),
            None
        );
        // 形状非法丢弃（命令缺失/非对象）。
        assert_eq!(parse_entry(&json!({ "delayMs": 10 })), None);
        assert_eq!(parse_entry(&json!("echo hi")), None);
    }

    #[test]
    fn sanitize_entry_truncates_command_on_utf8_boundary() {
        // 4KiB 内原样保留；enabled 缺省 true。
        let kept = "x".repeat(MAX_COMMAND_BYTES);
        let sanitized = sanitize_entry(&json!({ "command": kept })).expect("kept");
        assert_eq!(
            sanitized["command"].as_str().unwrap().len(),
            MAX_COMMAND_BYTES
        );
        assert_eq!(sanitized["enabled"], true);
        assert_eq!(sanitized["delayMs"], 300);
        // 超长按字节截断；多字节字符不在边界上劈开。
        let multibyte = "界".repeat(MAX_COMMAND_BYTES); // 3 bytes each
        let sanitized = sanitize_entry(&json!({ "command": multibyte })).expect("truncated");
        let stored = sanitized["command"].as_str().unwrap();
        assert!(stored.len() <= MAX_COMMAND_BYTES);
        assert!(
            stored.len().is_multiple_of(3),
            "must land on a char boundary"
        );
        // 延迟钳制与 enabled 保留进落盘形状（编辑器要能回显禁用行）。
        let sanitized =
            sanitize_entry(&json!({ "command": "top", "delayMs": 1_000_000, "enabled": false }))
                .expect("disabled row kept");
        assert_eq!(sanitized["delayMs"], 30_000);
        assert_eq!(sanitized["enabled"], false);
        // 空命令不落盘。
        assert_eq!(sanitize_entry(&json!({ "command": "  " })), None);
        assert_eq!(sanitize_entry(&json!({ "no": "command" })), None);
    }

    #[test]
    fn sanitize_store_shapes_and_caps() {
        // 非对象整体拒绝（save_preferences 报错给前端）。
        assert_eq!(sanitize_store(&json!(["x"])), None);
        assert_eq!(sanitize_store(&json!("nope")), None);
        let store = sanitize_store(&json!({
            "conn-a": {
                "enabled": true,
                "commands": [
                    { "command": "echo one" },
                    { "command": "echo two", "delayMs": 5, "enabled": false },
                    "junk",
                    { "command": "" },
                ],
            },
            "conn-b": "junk-entry",
        }))
        .expect("store");
        // conn-a：非法行丢弃、禁用行保留、enabled 透传。
        assert_eq!(store["conn-a"]["enabled"], true);
        let rows = store["conn-a"]["commands"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["command"], "echo one");
        assert_eq!(rows[1]["enabled"], false);
        // conn-b：形状非法的连接条目整条丢弃。
        assert!(store.get("conn-b").is_none());
        // enabled 缺省 false（开关默认关）。
        let store = sanitize_store(&json!({ "conn": { "commands": [] } })).expect("store");
        assert_eq!(store["conn"]["enabled"], false);
        // 每连接命令数上限。
        let many: Vec<Value> = (0..MAX_COMMANDS + 10)
            .map(|index| json!({ "command": format!("echo {index}") }))
            .collect();
        let store = sanitize_store(&json!({ "conn": { "enabled": true, "commands": many } }))
            .expect("store");
        assert_eq!(
            store["conn"]["commands"].as_array().unwrap().len(),
            MAX_COMMANDS
        );
    }

    #[test]
    fn active_commands_filter_by_master_switch_and_rows() {
        let store = json!({
            "on": { "enabled": true, "commands": [
                { "command": "first", "delayMs": 10 },
                { "command": "skipped", "enabled": false },
                { "command": "second" },
            ] },
            "off": { "enabled": false, "commands": [{ "command": "never" }] },
        });
        // 顺序保持、禁用行剔除。
        assert_eq!(
            active_commands(Some(&store), "on"),
            vec![
                StartupCommand {
                    command: "first".into(),
                    delay_ms: 10
                },
                StartupCommand {
                    command: "second".into(),
                    delay_ms: 300
                },
            ]
        );
        // 主开关关闭 → 空计划。
        assert!(active_commands(Some(&store), "off").is_empty());
        // 未知连接 / 缺 store → 空。
        assert!(active_commands(Some(&store), "other").is_empty());
        assert!(active_commands(None, "on").is_empty());
        assert!(active_commands(Some(&json!({})), "on").is_empty());
    }

    #[test]
    fn active_commands_caps_read_path_at_max_commands() {
        // C1 回归：直读盘路径必须重申每连接 20 行上限——直接构造
        // preferences.json 不得注入任意行数（写路径本就 sanitize）。
        let many: Vec<Value> = (0..MAX_COMMANDS + 10)
            .map(|index| json!({ "command": format!("echo {index}") }))
            .collect();
        let store = json!({ "conn": { "enabled": true, "commands": many } });
        let plan = active_commands(Some(&store), "conn");
        assert_eq!(plan.len(), MAX_COMMANDS);
        // 截断保序：保留前 20 条，而不是后 20 条。
        assert_eq!(plan[0].command, "echo 0");
        assert_eq!(
            plan[MAX_COMMANDS - 1].command,
            format!("echo {}", MAX_COMMANDS - 1)
        );
    }

    #[test]
    fn load_plan_reads_preferences_file_and_degrades_cleanly() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 无文件 → 空。
        assert!(load_plan(data_dir.path(), "conn").is_empty());
        // 正常落盘 → 读回（嵌套在 prefs 键下，与 preferences.json 布局一致）。
        std::fs::write(
            crate::preferences::store_path(data_dir.path()),
            json!({
                "version": 1,
                "prefs": { "startup_commands": {
                    "conn": { "enabled": true, "commands": [{ "command": "echo hi", "delayMs": 25 }] },
                } },
            })
            .to_string(),
        )
        .expect("write prefs");
        assert_eq!(
            load_plan(data_dir.path(), "conn"),
            vec![StartupCommand {
                command: "echo hi".into(),
                delay_ms: 25
            }]
        );
        // 损坏文件 → 空而不是报错。
        std::fs::write(crate::preferences::store_path(data_dir.path()), "{junk")
            .expect("write junk");
        assert!(load_plan(data_dir.path(), "conn").is_empty());
    }

    #[tokio::test]
    async fn inject_sequence_types_commands_in_order_with_enter() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let plan = vec![
            StartupCommand {
                command: "echo one".into(),
                delay_ms: 1,
            },
            StartupCommand {
                command: "echo two".into(),
                delay_ms: 1,
            },
        ];
        let worker = tokio::spawn(async move {
            inject_sequence(&plan, |payload| {
                let tx = tx.clone();
                async move { tx.send(payload).await.is_ok() }
            })
            .await
        });
        // 每条命令自带 \r 结尾，顺序与计划一致。
        assert_eq!(rx.recv().await.as_deref(), Some(&b"echo one\r"[..]));
        assert_eq!(rx.recv().await.as_deref(), Some(&b"echo two\r"[..]));
        assert!(worker.await.expect("injector"));
        // 通道关闭（会话关闭）→ 注入器停止并报未完成。
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        drop(rx);
        let plan = vec![StartupCommand {
            command: "echo x".into(),
            delay_ms: 1,
        }];
        assert!(
            !inject_sequence(&plan, |payload| {
                let tx = tx.clone();
                async move { tx.send(payload).await.is_ok() }
            })
            .await
        );
    }

    #[tokio::test]
    async fn inject_sequence_respects_the_delay_between_commands() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        // 两条各 40ms：总耗时 ≥ 80ms（首条前也等待，给 shell 起提示符留时间）。
        let plan = vec![
            StartupCommand {
                command: "a".into(),
                delay_ms: 40,
            },
            StartupCommand {
                command: "b".into(),
                delay_ms: 40,
            },
        ];
        let started = std::time::Instant::now();
        let worker = tokio::spawn(async move {
            inject_sequence(&plan, |payload| {
                let tx = tx.clone();
                async move { tx.send(payload).await.is_ok() }
            })
            .await
        });
        while rx.recv().await.is_some() {}
        assert!(worker.await.expect("injector"));
        assert!(
            started.elapsed() >= Duration::from_millis(80),
            "delays must hold"
        );
    }

    #[test]
    fn input_payload_appends_enter() {
        assert_eq!(input_payload("cd /tmp"), b"cd /tmp\r".to_vec());
        assert_eq!(input_payload(""), b"\r".to_vec());
    }
}
