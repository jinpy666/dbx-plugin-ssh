//! Local (client-machine) terminal sessions.
//!
//! Spawns an interactive login shell in a pseudo terminal on the machine the
//! sidecar runs on and pumps it over the same binary frame protocol the SSH
//! terminal uses — `local/terminal/in/{sessionId}` carries the 8-byte BE
//! sequence + keystrokes, `local/terminal/out/{sessionId}` answers with the
//! 9-byte `TerminalFrame` prefix (stream + u64 sequence) backed by a shared
//! [`ReplayBuffer`]. Output streams merge inside the PTY, so every data frame
//! is `Stdout`; `State` frames only carry the terminal lifecycle.
//!
//! Deliberately out of scope here: everything SSH-specific (triggers,
//! auto-sudo, directory handshake, recording, SFTP). The runtime owns its own
//! session table — the SSH `SessionEntry` binds a russh handle and cannot
//! carry a local child process.
//!
//! Shell choice follows the platform terminals' hard-won lesson (Ghostty,
//! Warp, and the ttyd/Tabby breakage reports): on macOS a GUI process has no
//! usable `PATH`, so the shell MUST start as a login shell, resolved from
//! Directory Services' `UserShell` first. Injection only ever wraps the
//! user's own startup chain — a broken rc must never keep the shell from
//! reaching a prompt.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbx_plugin_sdk::PluginEmitter;
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{mpsc, RwLock};

use crate::model::TerminalStream;
use crate::ssh::ReplayBuffer;

/// Grace for a EOF'd/HUP'd child to exit on its own (zsh/bash flush command
/// history only on a clean exit) before the killer escalates to SIGKILL.
const LOCAL_CLOSE_GRACE: Duration = Duration::from_secs(5);
/// Second, shorter window after SIGKILL for the waiter thread to deliver the
/// status; the child is being reaped either way.
const LOCAL_KILL_GRACE: Duration = Duration::from_secs(2);

const INTEGRATION_ZSH: &str = include_str!("shell_integration/integration.zsh");
const INTEGRATION_BASH: &str = include_str!("shell_integration/integration.bash");
const INTEGRATION_FISH: &str = include_str!("shell_integration/integration.fish");
const INTEGRATION_PWSH: &str = include_str!("shell_integration/integration.ps1");
const WRAPPER_ZSHRC: &str = include_str!("shell_integration/wrapper.zshrc");
const WRAPPER_ZPROFILE: &str = include_str!("shell_integration/wrapper.zprofile");
const WRAPPER_ZLOGIN: &str = include_str!("shell_integration/wrapper.zlogin");
const WRAPPER_BASH: &str = include_str!("shell_integration/wrapper.bash");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalStartRequest {
    pub workbench_id: String,
    pub cols: u32,
    pub rows: u32,
    /// Explicit shell override (absolute path or PATH-resolvable name).
    pub shell: Option<String>,
    /// Opt-out of shell integration injection; defaults to on.
    pub shell_integration: Option<bool>,
    /// Working directory to start in (workbench restart inherits the last
    /// tracked cwd, VS Code new-terminal-in-workspace style). Must be an
    /// existing directory; invalid values fall back to the home directory.
    pub cwd: Option<String>,
}

enum LocalTerminalCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct LocalSession {
    workbench_id: String,
    shell: String,
    /// Unix seconds when the session was opened (for `local/session/list`).
    created_at_secs: u64,
    terminal_tx: mpsc::Sender<LocalTerminalCommand>,
    replay: Arc<AsyncMutex<ReplayBuffer>>,
}

pub struct LocalTerminalRuntime {
    sessions: Arc<RwLock<HashMap<String, Arc<LocalSession>>>>,
}

impl LocalTerminalRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        request: LocalTerminalStartRequest,
        emitter: PluginEmitter,
    ) -> Result<Value, String> {
        let cols = request.cols.clamp(2, u16::MAX as u32) as u16;
        let rows = request.rows.clamp(2, u16::MAX as u32) as u16;
        let requested = request
            .shell
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let ds_shell = directory_services_shell();
        let shell_env = std::env::var_os("SHELL").map(|value| value.to_string_lossy().into_owned());
        let spec = pick_shell(
            requested,
            shell_env.as_deref(),
            ds_shell.as_deref(),
            current_platform(),
        );
        let integration = prepare_integration(spec.kind, request.shell_integration.unwrap_or(true));
        // cwd：显式参数须为现存目录，非法值静默回落家目录（前端传的是上次
        // 会话跟踪到的 cwd，目录可能已被删除）。
        let cwd = request
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(home_dir);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Failed to open a pseudo terminal: {error}"))?;

        let mut command = CommandBuilder::new(&spec.program);
        // Integration args replace the base login args wholesale (the bash
        // wrapper reproduces the login chain itself — bash cannot combine
        // `-l` with `--rcfile`).
        command.args(&integration.args);
        command.env("TERM", "xterm-256color");
        // 24-bit color for programs that probe COLORTERM (VS Code sets the
        // same), plus a detectable marker akin to TERM_PROGRAM=vscode.
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "dbx");
        for (key, value) in &integration.env {
            command.env(key, value);
        }
        if let Some(home) = cwd {
            command.cwd(home);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Failed to start {}: {error}", spec.program))?;
        // The sidecar's copy of the slave must die immediately: with it
        // alive the master never sees EOF once the shell exits.
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Failed to read the pseudo terminal: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Failed to write the pseudo terminal: {error}"))?;
        let killer = child.clone_killer();

        let session_id = uuid::Uuid::new_v4().to_string();
        let replay = Arc::new(AsyncMutex::new(ReplayBuffer::default()));
        let (cmd_tx, cmd_rx) = mpsc::channel(256);
        self.sessions.write().await.insert(
            session_id.clone(),
            Arc::new(LocalSession {
                workbench_id: request.workbench_id.clone(),
                shell: spec.program.clone(),
                created_at_secs: unix_now_secs(),
                terminal_tx: cmd_tx,
                replay: replay.clone(),
            }),
        );
        spawn_pump(
            session_id.clone(),
            request.workbench_id,
            pair.master,
            reader,
            writer,
            killer,
            child,
            cmd_rx,
            replay,
            emitter,
            self.sessions.clone(),
        );
        Ok(json!({
            "sessionId": session_id,
            "shell": spec.program,
            "shellIntegration": integration.injected,
        }))
    }

    async fn session(&self, session_id: &str) -> Result<Arc<LocalSession>, String> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Local session was not found".to_string())
    }

    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        self.session(session_id)
            .await?
            .terminal_tx
            .send(LocalTerminalCommand::Resize { cols, rows })
            .await
            .map_err(|_| "Local terminal is closed".to_string())
    }

    pub async fn replay(
        &self,
        session_id: &str,
        after_sequence: u64,
        emitter: &PluginEmitter,
    ) -> Result<Value, String> {
        let session = self.session(session_id).await?;
        let replay = session.replay.lock().await;
        let first_available_sequence = replay.first_sequence();
        let tail_sequence = replay.tail_sequence();
        let frames = replay.after(after_sequence);
        drop(replay);
        for frame in &frames {
            emitter
                .binary(&format!("local/terminal/out/{session_id}"), &frame.encode())
                .map_err(|error| error.message)?;
        }
        Ok(json!({
            "frameCount": frames.len(),
            "firstAvailableSequence": first_available_sequence,
            "tailSequence": tail_sequence,
            "complete": after_sequence.saturating_add(1) >= first_available_sequence
        }))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .write()
            .await
            .remove(session_id)
            .ok_or("Local session was not found")?;
        let _ = session.terminal_tx.send(LocalTerminalCommand::Close).await;
        Ok(())
    }

    /// Closing a workbench tears down its local shells; a webview reload does
    /// NOT pass through here, so a reload finds the shell again via
    /// `local/session/list` + replay.
    pub async fn close_workbench(&self, workbench_id: &str) {
        let session_ids: Vec<String> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.workbench_id == workbench_id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        for session_id in session_ids {
            let _ = self.close(&session_id).await;
        }
    }

    /// Read-only inventory of live local shells (a session only exists while
    /// its child runs), used by the workbench to reattach after a reload.
    pub async fn list(&self) -> Value {
        let sessions = self.sessions.read().await;
        let mut list: Vec<Value> = sessions
            .iter()
            .map(|(session_id, session)| {
                json!({
                    "sessionId": session_id,
                    "workbenchId": session.workbench_id,
                    "shell": session.shell,
                    "createdAt": session.created_at_secs,
                })
            })
            .collect();
        list.sort_by(|a, b| {
            a["createdAt"]
                .as_u64()
                .cmp(&b["createdAt"].as_u64())
                .then_with(|| a["sessionId"].as_str().cmp(&b["sessionId"].as_str()))
        });
        json!({ "sessions": list })
    }

    /// Keyboard input from the SDK's blocking binary-handler thread; the
    /// bounded channel applies backpressure instead of dropping keystrokes.
    pub fn write_input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        // Do not hold the session-map read guard while applying backpressure:
        // closing a dead session needs the write lock to drop the receiver.
        let terminal_tx = {
            let sessions = self.sessions.blocking_read();
            sessions
                .get(session_id)
                .map(|session| session.terminal_tx.clone())
                // Same string contract as the SSH mirror — the workbench's
                // dead-session detection matches on the error event.
                .ok_or("Local session was not found or expired")?
        };
        terminal_tx
            .blocking_send(LocalTerminalCommand::Input(data))
            .map_err(|error| format!("Local terminal input queue is closed: {error}"))
    }
}

async fn publish_local_terminal(
    session_id: &str,
    stream: TerminalStream,
    data: Vec<u8>,
    replay: &Arc<AsyncMutex<ReplayBuffer>>,
    emitter: &PluginEmitter,
) {
    let frame = replay.lock().await.push(stream, data);
    if let Err(error) = emitter.binary(&format!("local/terminal/out/{session_id}"), &frame.encode())
    {
        eprintln!(
            "[ssh-sftp-plugin] local terminal output failed: {}",
            error.message
        );
    }
}

/// Owns the PTY master for one session and multiplexes PTY output, workbench
/// commands and the child's exit status. Terminal condition is the child's
/// exit (or the bounded grace after a kill/EOF); the teardown publishes the
/// State frame, notifies the workbench and drops the session.
#[allow(clippy::too_many_arguments)]
fn spawn_pump(
    session_id: String,
    workbench_id: String,
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
    child: Box<dyn Child + Send + Sync>,
    mut cmd_rx: mpsc::Receiver<LocalTerminalCommand>,
    replay: Arc<AsyncMutex<ReplayBuffer>>,
    emitter: PluginEmitter,
    sessions: Arc<RwLock<HashMap<String, Arc<LocalSession>>>>,
) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    if out_tx.send(buffer[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    let (exit_tx, mut exit_rx) = mpsc::unbounded_channel::<Option<u32>>();
    std::thread::spawn(move || {
        let mut child = child;
        let status = child.wait();
        let _ = exit_tx.send(status.ok().map(|status| status.exit_code()));
    });

    let writer = Arc::new(Mutex::new(writer));
    tokio::spawn(async move {
        let mut master = Some(master);
        let mut closing = false;
        let mut exit_code: Option<Option<u32>> = None;
        loop {
            if closing {
                // Graceful-first teardown: with the master dropped the slave
                // sees EOF and the shell exits cleanly — zsh/bash flush their
                // command history only on a clean exit, an immediate SIGKILL
                // would silently drop it. Only a child that outlives the
                // grace window (hung job, `no hup` shell) gets the killer.
                match tokio::time::timeout(LOCAL_CLOSE_GRACE, exit_rx.recv()).await {
                    Ok(code) => {
                        exit_code = code;
                    }
                    Err(_) => {
                        let _ = killer.kill();
                        if let Ok(code) =
                            tokio::time::timeout(LOCAL_KILL_GRACE, exit_rx.recv()).await
                        {
                            exit_code = code;
                        }
                    }
                }
                break;
            }
            tokio::select! {
                chunk = out_rx.recv() => match chunk {
                    Some(data) => {
                        publish_local_terminal(&session_id, TerminalStream::Stdout, data, &replay, &emitter).await;
                    }
                    None => closing = true,
                },
                command = cmd_rx.recv() => match command {
                    Some(LocalTerminalCommand::Input(data)) => {
                        let handle = writer.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            let mut writer =
                                handle.lock().unwrap_or_else(|poison| poison.into_inner());
                            writer.write_all(&data).and_then(|_| writer.flush())
                        })
                        .await
                        .unwrap_or_else(|_| {
                            Err(std::io::Error::other("local terminal write task panicked"))
                        });
                        if result.is_err() {
                            closing = true;
                        }
                    }
                    Some(LocalTerminalCommand::Resize { cols, rows }) => {
                        if let Some(master) = master.as_ref() {
                            let _ = master.resize(PtySize {
                                rows: rows.clamp(1, u16::MAX as u32) as u16,
                                cols: cols.clamp(1, u16::MAX as u32) as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                    }
                    Some(LocalTerminalCommand::Close) | None => {
                        // Drop the master BEFORE the grace window: the slave
                        // side sees EOF and interactive shells exit (and flush
                        // history) on their own; killer only after the grace.
                        drop(master.take());
                        closing = true;
                    }
                },
                code = exit_rx.recv() => {
                    exit_code = code;
                    break;
                }
            }
        }
        // The master may already be taken by a graceful Close; dropping the
        // remaining value here unblocks the reader thread even when a
        // background child still holds the slave.
        drop(master);
        publish_local_terminal(
            &session_id,
            TerminalStream::State,
            b"local-terminal-exited".to_vec(),
            &replay,
            &emitter,
        )
        .await;
        let _ = emitter.event(
            "local/session/state",
            json!({
                "sessionId": session_id,
                "workbenchId": workbench_id,
                "state": "exited",
                "exitCode": exit_code.flatten(),
            }),
        );
        sessions.write().await.remove(&session_id);
    });
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOS,
    Linux,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    PowerShell,
    Cmd,
    Other,
}

struct ShellSpec {
    program: String,
    kind: ShellKind,
}

fn current_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOS
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// Basename without directory separators and a trailing `.exe`.
fn shell_basename(program: &str) -> String {
    let name = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_string()
}

fn shell_kind_from_program(program: &str) -> ShellKind {
    match shell_basename(program).as_str() {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        "pwsh" | "powershell" => ShellKind::PowerShell,
        "cmd" => ShellKind::Cmd,
        _ => ShellKind::Other,
    }
}

/// Shells that would terminate immediately (service accounts); treated as
/// "unset" so detection falls through to the platform default.
fn is_login_unusable(program: &str) -> bool {
    matches!(shell_basename(program).as_str(), "nologin" | "false")
}

fn base_args(kind: ShellKind, platform: Platform) -> Vec<String> {
    if platform == Platform::Windows || kind == ShellKind::Cmd {
        Vec::new()
    } else {
        // macOS GUI apps ship with a skeletal PATH; Linux daemons too. Every
        // Unix shell therefore starts as a login shell to pick up
        // /etc/profile & friends (Ghostty's macOS login-shell rule).
        vec!["-l".to_string()]
    }
}

/// Resolve which program to launch. `requested` wins; on Unix the user's
/// login shell (macOS Directory Services first, `$SHELL` second) and on
/// Windows PowerShell — Warp's default-shell matrix.
fn pick_shell(
    requested: Option<&str>,
    shell_env: Option<&str>,
    ds_shell: Option<&str>,
    platform: Platform,
) -> ShellSpec {
    let (program, kind) = if let Some(value) = requested {
        (value.to_string(), shell_kind_from_program(value))
    } else {
        match platform {
            Platform::Windows => ("powershell.exe".to_string(), ShellKind::PowerShell),
            _ => {
                let detected = [ds_shell, shell_env]
                    .into_iter()
                    .flatten()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .find(|value| !is_login_unusable(value));
                match detected {
                    Some(value) => (value.to_string(), shell_kind_from_program(value)),
                    None => match platform {
                        Platform::MacOS => ("/bin/zsh".to_string(), ShellKind::Zsh),
                        _ => ("/bin/bash".to_string(), ShellKind::Bash),
                    },
                }
            }
        }
    };
    ShellSpec { program, kind }
}

/// One row of `local/shells/list`: a launchable shell with display metadata.
#[derive(Debug, Clone)]
pub struct ShellEntry {
    /// Program path/name to spawn (also the stored preference value).
    pub program: String,
    /// Basename for display ("zsh", "PowerShell", …).
    pub name: String,
    /// The platform default this runtime would pick with no explicit choice.
    pub is_default: bool,
    /// The user's login shell (dscl / $SHELL / USERPROFILE-adjacent).
    pub is_user_shell: bool,
    /// Whether shell integration injection applies to this shell kind
    /// (ksh/csh/cmd-style shells open bare, the toggle is inert for them).
    pub injectable: bool,
}

/// Pure core of shell discovery: merge candidate program paths in priority
/// order (user login shell first, then /etc/shells, then platform defaults),
/// deduplicating case-insensitively on the basename. `exists` is injected so
/// tests can simulate the filesystem.
fn merge_shell_candidates(
    user_shell: Option<&str>,
    etc_shells: &[String],
    fallbacks: &[&str],
    exists: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    let mut push = |program: &str| {
        let program = program.trim();
        if program.is_empty() || !exists(program) {
            return;
        }
        let key = shell_basename(program);
        if seen.insert(key) {
            ordered.push(program.to_string());
        }
    };
    if let Some(value) = user_shell.map(str::trim).filter(|v| !v.is_empty()) {
        push(value);
    }
    for line in etc_shells {
        let candidate = line.trim();
        if candidate.is_empty() || candidate.starts_with('#') {
            continue;
        }
        push(candidate);
    }
    for candidate in fallbacks {
        push(candidate);
    }
    ordered
}

/// `/etc/shells` content (Unix). Empty on Windows or when unreadable.
fn etc_shells() -> Vec<String> {
    if cfg!(windows) {
        return Vec::new();
    }
    std::fs::read_to_string("/etc/shells")
        .map(|text| text.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Windows candidate lookup over PATH-style directories (pure in `dirs`).
fn find_in_dirs(program: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

/// Windows shell candidates, best first: PowerShell 7 if installed, the
/// always-present Windows PowerShell, cmd, and WSL for Unix tooling.
fn windows_shell_candidates() -> Vec<String> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    let mut dirs = dirs;
    if let Some(windir) = std::env::var_os("SystemRoot").map(PathBuf::from) {
        let system32 = windir.join("System32");
        dirs.push(system32.clone());
        dirs.push(system32.join("WindowsPowerShell").join("v1.0"));
    }
    ["pwsh.exe", "powershell.exe", "cmd.exe", "wsl.exe"]
        .iter()
        .filter_map(|name| find_in_dirs(name, &dirs))
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Discover launchable shells for `local/shells/list`: the user's login shell
/// first, then `/etc/shells` (Unix), then platform defaults — each row marked
/// with the default/user-shell roles the picker UI renders.
pub fn discover_shells(platform: Platform) -> Vec<ShellEntry> {
    let ds_shell = directory_services_shell();
    let shell_env = std::env::var_os("SHELL").map(|value| value.to_string_lossy().into_owned());
    let user_shell = ds_shell.as_deref().or(shell_env.as_deref());
    let fallbacks: Vec<String> = match platform {
        Platform::Windows => windows_shell_candidates(),
        _ => {
            let default = match platform {
                Platform::MacOS => "/bin/zsh",
                _ => "/bin/bash",
            };
            vec![default.to_string()]
        }
    };
    let exists = |program: &str| Path::new(program).is_file();
    let ordered = merge_shell_candidates(
        user_shell,
        &etc_shells(),
        &fallbacks.iter().map(String::as_str).collect::<Vec<_>>(),
        &exists,
    );
    let default_program = pick_shell(None, None, None, platform).program;
    ordered
        .into_iter()
        .map(|program| {
            let name = shell_basename(&program);
            let kind = shell_kind_from_program(&program);
            ShellEntry {
                name: shell_display_name(&name),
                is_default: name == shell_basename(&default_program),
                is_user_shell: user_shell
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| shell_basename(value) == name)
                    .unwrap_or(false),
                injectable: injection_plan(kind, Path::new("/dev/null"), None).is_some(),
                program,
            }
        })
        .collect()
}

/// Friendlier picker label: basename without the .exe already applied.
fn shell_display_name(basename: &str) -> String {
    match basename {
        "powershell" => "Windows PowerShell".to_string(),
        "pwsh" => "PowerShell".to_string(),
        "wsl" => "WSL".to_string(),
        other => {
            let mut name = other.to_string();
            if let Some(first) = name.get_mut(..1) {
                first.make_ascii_uppercase();
            }
            name
        }
    }
}

impl LocalTerminalRuntime {
    /// PR-A4 generic launch-options contract (host dock "+"): returns picker
    /// entries — auto-detect plus one entry per discovered shell — each carrying
    /// the context fragment the host merges into its host-authored panel
    /// context. Business meaning stays on the plugin side; the host renders
    /// labels and never interprets the contexts.
    pub fn launch_options(&self) -> Value {
        let shells = self.shells();
        let mut entries = Vec::new();
        entries.push(json!({
            "label": "Auto-detect shell",
            "description": "Follow the platform default login shell",
            "context": { "plugin": { "mode": "local-terminal" } },
        }));
        if let Some(list) = shells.get("shells").and_then(|value| value.as_array()) {
            for shell in list {
                let program = shell
                    .get("program")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let name = shell
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or(program);
                if program.is_empty() {
                    continue;
                }
                entries.push(json!({
                    "label": name,
                    "description": program,
                    "context": { "plugin": { "mode": "local-terminal", "shell": program } },
                }));
            }
        }
        json!({ "entries": entries })
    }

    /// Read-only shell inventory for the workbench's shell picker.
    pub fn shells(&self) -> Value {
        let platform = current_platform();
        json!({
            "platform": match platform {
                Platform::MacOS => "macos",
                Platform::Linux => "linux",
                Platform::Windows => "windows",
            },
            "shells": discover_shells(platform)
                .iter()
                .map(|entry| json!({
                    "program": entry.program,
                    "name": entry.name,
                    "isDefault": entry.is_default,
                    "isUserShell": entry.is_user_shell,
                    "injectable": entry.injectable,
                }))
                .collect::<Vec<_>>(),
        })
    }
}

/// macOS only: the user's real login shell from Directory Services, which is
/// authoritative when `$SHELL` is missing inside a GUI-launched process.
fn directory_services_shell() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let user = std::env::var_os("USER")?;
    let output = std::process::Command::new("dscl")
        .args([
            ".",
            "-read",
            &format!("/Users/{}", user.to_string_lossy()),
            "UserShell",
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("UserShell:").map(str::trim_start))
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

fn integration_dir() -> PathBuf {
    std::env::temp_dir().join("dbx-plugin-ssh-shell-integration")
}

fn render_template(template: &str, integration_dir: &str) -> String {
    template.replace("{{INTEGRATION_DIR}}", integration_dir)
}

fn escape_posix_single_quoted(text: &str) -> String {
    text.replace('\'', "'\\''")
}

fn escape_powershell_single_quoted(text: &str) -> String {
    text.replace('\'', "''")
}

/// Materialize the integration + wrapper scripts for this process. Content is
/// static and secret-free, so a predictable temp location is fine; on any IO
/// failure injection is silently skipped (the terminal still opens raw).
fn write_integration_files(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let dir_text = dir.to_string_lossy().into_owned();
    // zsh resolves `$ZDOTDIR/.zshrc` etc. — the wrapper files MUST carry the
    // dotted names; the bash wrapper is free-form (`--rcfile wrapper.bash`).
    let files: [(&str, String); 8] = [
        ("integration.zsh", INTEGRATION_ZSH.to_string()),
        ("integration.bash", INTEGRATION_BASH.to_string()),
        ("integration.fish", INTEGRATION_FISH.to_string()),
        ("integration.ps1", INTEGRATION_PWSH.to_string()),
        (".zshrc", render_template(WRAPPER_ZSHRC, &dir_text)),
        (".zprofile", render_template(WRAPPER_ZPROFILE, &dir_text)),
        (".zlogin", render_template(WRAPPER_ZLOGIN, &dir_text)),
        ("wrapper.bash", render_template(WRAPPER_BASH, &dir_text)),
    ];
    for (name, content) in files {
        std::fs::write(dir.join(name), content)?;
    }
    Ok(())
}

/// Launch args + env additions for injection, or `None` when the shell has no
/// integration (cmd, unknown) or injection is off. Args REPLACE the base
/// login args: bash cannot combine `-l` with `--rcfile`, so the bash wrapper
/// reproduces the login chain itself (see wrapper.bash).
/// Launch args plus `(name, value)` env additions for injection.
type InjectionPlan = (Vec<String>, Vec<(String, String)>);

fn injection_plan(
    kind: ShellKind,
    dir: &Path,
    user_zdotdir: Option<&str>,
) -> Option<InjectionPlan> {
    let dir_text = dir.to_string_lossy().into_owned();
    match kind {
        ShellKind::Zsh => {
            let mut env = vec![("ZDOTDIR".to_string(), dir_text)];
            if let Some(value) = user_zdotdir
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                env.push(("DBX_USER_ZDOTDIR".to_string(), value.to_string()));
            }
            Some((vec!["-l".to_string()], env))
        }
        ShellKind::Bash => Some((
            vec![
                "--rcfile".to_string(),
                dir.join("wrapper.bash").to_string_lossy().into_owned(),
            ],
            Vec::new(),
        )),
        ShellKind::Fish => {
            let script = dir.join("integration.fish");
            Some((
                vec![
                    "-l".to_string(),
                    "-C".to_string(),
                    format!(
                        "source '{}'",
                        escape_posix_single_quoted(&script.to_string_lossy())
                    ),
                ],
                Vec::new(),
            ))
        }
        ShellKind::PowerShell => {
            let script = dir.join("integration.ps1");
            Some((
                vec![
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    format!(
                        "& '{}'",
                        escape_powershell_single_quoted(&script.to_string_lossy())
                    ),
                ],
                Vec::new(),
            ))
        }
        ShellKind::Cmd | ShellKind::Other => None,
    }
}

struct PreparedIntegration {
    args: Vec<String>,
    env: Vec<(String, String)>,
    /// Whether integration actually attached (drives the start() response).
    injected: bool,
}

fn prepare_integration(kind: ShellKind, enabled: bool) -> PreparedIntegration {
    let none = PreparedIntegration {
        args: base_args(kind, current_platform()),
        env: Vec::new(),
        injected: false,
    };
    if !enabled {
        return none;
    }
    let dir = integration_dir();
    if write_integration_files(&dir).is_err() {
        eprintln!(
            "[ssh-sftp-plugin] shell integration files unavailable at {}; continuing without injection",
            dir.display()
        );
        return none;
    }
    let user_zdotdir =
        std::env::var_os("ZDOTDIR").map(|value| value.to_string_lossy().into_owned());
    match injection_plan(kind, &dir, user_zdotdir.as_deref()) {
        Some((args, env)) => PreparedIntegration {
            args,
            env,
            injected: true,
        },
        None => none,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TerminalFrame;

    #[test]
    fn macos_prefers_directory_services_shell_over_env() {
        let spec = pick_shell(
            None,
            Some("/bin/bash"),
            Some("/opt/homebrew/bin/fish"),
            Platform::MacOS,
        );
        assert_eq!(spec.program, "/opt/homebrew/bin/fish");
        assert_eq!(spec.kind, ShellKind::Fish);
    }

    #[test]
    fn shell_env_is_used_when_directory_services_has_nothing() {
        let spec = pick_shell(None, Some("/usr/bin/fish"), None, Platform::Linux);
        assert_eq!(spec.program, "/usr/bin/fish");
        assert_eq!(spec.kind, ShellKind::Fish);
    }

    #[test]
    fn login_reject_shells_fall_through_to_next_candidate() {
        let spec = pick_shell(
            None,
            Some("/bin/bash"),
            Some("/usr/sbin/nologin"),
            Platform::Linux,
        );
        assert_eq!(spec.program, "/bin/bash");
    }

    #[test]
    fn platform_defaults_when_nothing_detected() {
        let macos = pick_shell(None, None, None, Platform::MacOS);
        assert_eq!(macos.program, "/bin/zsh");
        assert_eq!(macos.kind, ShellKind::Zsh);
        let linux = pick_shell(None, None, None, Platform::Linux);
        assert_eq!(linux.program, "/bin/bash");
        assert_eq!(linux.kind, ShellKind::Bash);
    }

    #[test]
    fn windows_defaults_to_powershell_with_no_login_args() {
        let spec = pick_shell(None, None, None, Platform::Windows);
        assert_eq!(spec.program, "powershell.exe");
        assert_eq!(spec.kind, ShellKind::PowerShell);
        assert!(base_args(ShellKind::PowerShell, Platform::Windows).is_empty());
    }

    #[test]
    fn unix_shells_start_as_login_shells() {
        assert_eq!(base_args(ShellKind::Zsh, Platform::MacOS), vec!["-l"]);
        assert_eq!(base_args(ShellKind::Bash, Platform::Linux), vec!["-l"]);
    }

    #[test]
    fn requested_shell_overrides_detection_and_keeps_login_args() {
        let spec = pick_shell(Some("/bin/bash"), Some("/bin/zsh"), None, Platform::MacOS);
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.kind, ShellKind::Bash);
    }

    #[test]
    fn shell_kind_handles_windows_paths_exe_and_case() {
        assert_eq!(
            shell_kind_from_program(r"C:\Program Files\PowerShell\7\pwsh.EXE"),
            ShellKind::PowerShell
        );
        assert_eq!(
            shell_kind_from_program("/opt/homebrew/bin/Zsh"),
            ShellKind::Zsh
        );
        assert_eq!(shell_kind_from_program("/bin/bash"), ShellKind::Bash);
        assert_eq!(shell_kind_from_program("cmd.exe"), ShellKind::Cmd);
        assert_eq!(shell_kind_from_program("/usr/bin/ksh"), ShellKind::Other);
    }

    #[test]
    fn zsh_injection_wraps_zdotdir_and_keeps_login() {
        let dir = Path::new("/tmp/si");
        let plan = injection_plan(ShellKind::Zsh, dir, Some("/Users/u/zdot")).expect("zsh plan");
        assert_eq!(plan.0, vec!["-l"]);
        assert!(plan
            .1
            .contains(&("ZDOTDIR".to_string(), "/tmp/si".to_string())));
        assert!(plan
            .1
            .contains(&("DBX_USER_ZDOTDIR".to_string(), "/Users/u/zdot".to_string())));
        // Without a pre-existing ZDOTDIR the wrapper falls back to HOME.
        let plain = injection_plan(ShellKind::Zsh, dir, None).expect("zsh plan");
        assert_eq!(plain.1.len(), 1);
    }

    #[test]
    fn bash_injection_swaps_login_for_rcfile_wrapper() {
        let dir = Path::new("/tmp/si");
        let plan = injection_plan(ShellKind::Bash, dir, None).expect("bash plan");
        // 期望值经 PathBuf 拼接生成，分隔符断言在 Windows（\）上同样成立。
        assert_eq!(
            plan.0,
            vec![
                "--rcfile",
                dir.join("wrapper.bash").to_string_lossy().as_ref()
            ]
        );
        assert!(plan.1.is_empty());
    }

    #[test]
    fn fish_and_powershell_quote_script_paths() {
        let dir = Path::new("/tmp/my si");
        let fish = injection_plan(ShellKind::Fish, dir, None).expect("fish plan");
        assert_eq!(fish.0[0], "-l");
        assert_eq!(fish.0[1], "-C");
        assert_eq!(
            fish.0[2],
            format!(
                "source '{}'",
                escape_posix_single_quoted(dir.join("integration.fish").to_string_lossy().as_ref())
            )
        );

        let pwsh = injection_plan(ShellKind::PowerShell, dir, None).expect("pwsh plan");
        assert_eq!(pwsh.0[0], "-NoExit");
        assert_eq!(pwsh.0[1], "-Command");
        assert_eq!(
            pwsh.0[2],
            format!(
                "& '{}'",
                escape_powershell_single_quoted(
                    dir.join("integration.ps1").to_string_lossy().as_ref()
                )
            )
        );
    }

    #[test]
    fn cmd_and_unknown_shells_get_no_injection() {
        assert!(injection_plan(ShellKind::Cmd, Path::new("/tmp/si"), None).is_none());
        assert!(injection_plan(ShellKind::Other, Path::new("/tmp/si"), None).is_none());
    }

    #[test]
    fn prepare_integration_disabled_falls_back_to_base_args_without_io() {
        let prepared = prepare_integration(ShellKind::Bash, false);
        // Windows 无登录参数概念（见 base_args），Unix 一律 -l 登录 shell。
        if cfg!(windows) {
            assert!(prepared.args.is_empty());
        } else {
            assert_eq!(prepared.args, vec!["-l"]);
        }
        assert!(prepared.env.is_empty());
        assert!(!prepared.injected);
    }

    #[test]
    fn integration_scripts_emit_lifecycle_marks() {
        for script in [
            INTEGRATION_ZSH,
            INTEGRATION_BASH,
            INTEGRATION_FISH,
            INTEGRATION_PWSH,
        ] {
            assert!(script.contains("133;A"), "missing prompt mark");
            assert!(script.contains("133;D;"), "missing exit-code mark");
            assert!(script.contains("633;P;Cwd="), "missing cwd report");
        }
        // 633;E command line is emitted by the POSIX scripts; PowerShell
        // reports cwd over OSC 9;9 because OSC 7 is POSIX-path shaped.
        assert!(INTEGRATION_ZSH.contains("633;E;"));
        assert!(INTEGRATION_BASH.contains("633;E;"));
        assert!(INTEGRATION_PWSH.contains("9;9;"));
    }

    #[test]
    fn wrappers_chain_user_startup_files_fail_safe() {
        // Only the rc-entry wrappers reference the integration directory;
        // the zprofile/zlogin chains just forward the user's own files.
        for wrapper in [WRAPPER_ZSHRC, WRAPPER_BASH] {
            assert!(wrapper.contains("{{INTEGRATION_DIR}}"));
        }
        // Guarded user-rc chaining: DBX_USER_ZDOTDIR, HOME fallback, -f tests.
        for zsh_wrapper in [WRAPPER_ZSHRC, WRAPPER_ZPROFILE, WRAPPER_ZLOGIN] {
            assert!(zsh_wrapper.contains("DBX_USER_ZDOTDIR"));
            assert!(zsh_wrapper.contains("$HOME"));
        }
        assert!(WRAPPER_BASH.contains("/etc/profile"));
        assert!(WRAPPER_BASH.contains("$HOME/.bash_profile"));
    }

    #[test]
    fn render_template_substitutes_the_integration_dir() {
        let rendered = render_template("source '{{INTEGRATION_DIR}}/integration.zsh'", "/opt/x");
        assert_eq!(rendered, "source '/opt/x/integration.zsh'");
    }

    #[test]
    fn shell_discovery_merges_user_shell_etc_shells_and_defaults() {
        // /etc/shells 注释与空行跳过；用户 shell 置顶；basename 大小写不敏感去重；
        // 不存在的候选被 exists 谓词过滤。
        let exists = |program: &str| {
            matches!(
                program,
                "/opt/homebrew/bin/fish" | "/bin/zsh" | "/bin/bash" | "/usr/bin/fish"
            )
        };
        let merged = merge_shell_candidates(
            Some("/opt/homebrew/bin/fish"),
            &[
                "# comment".to_string(),
                "".to_string(),
                "/bin/zsh".to_string(),
                "/opt/homebrew/bin/FISH".to_string(),
                "/usr/bin/fish".to_string(),
                "/bin/bash".to_string(),
            ],
            &["/bin/zsh", "/bin/bash"],
            &exists,
        );
        // "/opt/homebrew/bin/FISH" 与 "/usr/bin/fish" 都是 basename fish，
        // 大小写不敏感去重后只保留先到的用户 shell。
        assert_eq!(
            merged,
            vec!["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash"]
        );
    }

    #[test]
    fn shell_discovery_survives_missing_user_shell_and_empty_etc_shells() {
        let merged = merge_shell_candidates(None, &[], &["/bin/bash"], &|p| p == "/bin/bash");
        assert_eq!(merged, vec!["/bin/bash"]);
    }

    #[test]
    fn discovery_marks_injectable_kinds() {
        let platform = if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        };
        let shells = discover_shells(platform);
        assert!(!shells.is_empty());
        for entry in &shells {
            let kind = shell_kind_from_program(&entry.program);
            let expected = !matches!(kind, ShellKind::Cmd | ShellKind::Other);
            assert_eq!(entry.injectable, expected, "entry {}", entry.program);
        }
    }

    #[test]
    fn display_names_read_naturally() {
        assert_eq!(shell_display_name("zsh"), "Zsh");
        assert_eq!(shell_display_name("powershell"), "Windows PowerShell");
        assert_eq!(shell_display_name("pwsh"), "PowerShell");
        assert_eq!(shell_display_name("wsl"), "WSL");
    }

    #[test]
    fn quoting_survives_embedded_single_quotes() {
        assert_eq!(
            escape_posix_single_quoted("/tmp/o'brien/si"),
            "/tmp/o'\\''brien/si"
        );
        assert_eq!(
            escape_powershell_single_quoted("C:\\o'brien"),
            "C:\\o''brien"
        );
    }

    #[test]
    fn write_integration_files_materializes_every_script() {
        let dir = std::env::temp_dir().join(format!("dbx-si-test-{}", uuid::Uuid::new_v4()));
        write_integration_files(&dir).expect("write files");
        for name in [
            "integration.zsh",
            "integration.bash",
            "integration.fish",
            "integration.ps1",
            ".zshrc",
            ".zprofile",
            ".zlogin",
            "wrapper.bash",
        ] {
            assert!(dir.join(name).is_file(), "missing {name}");
        }
        let rendered = std::fs::read_to_string(dir.join(".zshrc")).expect("read wrapper");
        assert!(rendered.contains(dir.to_string_lossy().as_ref()));
        assert!(!rendered.contains("{{INTEGRATION_DIR}}"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn terminal_frame_encode_roundtrip() {
        let frame = TerminalFrame {
            sequence: 42,
            stream: TerminalStream::Stdout,
            data: b"hello".to_vec(),
        };
        let encoded = frame.encode();
        assert_eq!(encoded[0], 0);
        assert_eq!(&encoded[1..9], &42u64.to_be_bytes());
        assert_eq!(&encoded[9..], b"hello");

        let state = TerminalFrame {
            sequence: 7,
            stream: TerminalStream::State,
            data: b"local-terminal-exited".to_vec(),
        };
        assert_eq!(state.encode()[0], 2);
    }
}
