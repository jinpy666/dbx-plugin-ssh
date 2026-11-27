use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use super::{
    clamp_tail, is_daemon_permission_failure, list_payload, logs_payload, validate_container_id,
    DockerAction, EngineConfig, ACTION_TIMEOUT, LIST_TIMEOUT, LOGS_TIMEOUT, PS_FORMAT,
    PS_FORMAT_LEGACY, PS_LEGACY_MARKER,
};

/// Well-known docker CLI install dirs beyond PATH, per platform. macOS GUI
/// processes (DBX → sidecar) and non-interactive remote shells inherit a
/// skeletal PATH, so Homebrew, Docker Desktop, OrbStack and rootless
/// installs are invisible to a bare lookup — the local plane probes these
/// explicitly, exactly like [`LIST_SCRIPT`]'s PATH line does remotely.
pub fn cli_search_dirs(home: &Path, is_windows: bool) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = if is_windows {
        vec!["C:\\Program Files\\Docker\\Docker\\resources\\bin".into()]
    } else {
        vec!["/usr/local/bin".into(), "/opt/homebrew/bin".into()]
    };
    dirs.push(home.join(".docker").join("bin"));
    dirs.push(home.join(".orbstack").join("bin"));
    dirs.push(home.join("bin"));
    dirs.push(home.join(".local").join("bin"));
    if is_windows {
        dirs.push("C:\\ProgramData\\DockerDesktop\\version-bin".into());
    } else {
        dirs.push("/snap/bin".into());
        dirs.push("/Applications/Docker.app/Contents/Resources/bin".into());
    }
    dirs
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolves the local container CLI: an explicit `cli` that looks like a
/// path (`/usr/local/bin/podman`, `C:\...\docker.exe`) is probed directly;
/// a bare name resolves through PATH first, then [`cli_search_dirs`].
/// Returns the executable path so every local invocation is direct process
/// exec — no shell, nothing to quote, works on Windows too (where the
/// heredoc collector style has no `sh` to run under).
pub fn find_local_cli(cli: &str) -> Option<std::path::PathBuf> {
    let has_dir_part = cli.contains('/') || cli.contains('\\');
    let exe = if cfg!(windows) && !cli.to_ascii_lowercase().ends_with(".exe") {
        format!("{cli}.exe")
    } else {
        cli.to_string()
    };
    if has_dir_part {
        let path = std::path::PathBuf::from(&exe);
        return is_executable_file(&path).then_some(path);
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(&exe);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    for dir in cli_search_dirs(&home, cfg!(windows)) {
        let candidate = dir.join(&exe);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// One local `docker` invocation: direct exec (argv, no shell). Output is
/// `wait_with_output`'s stdout followed by stderr — NOT interleaved in
/// order-of-arrival (docker writes diagnostics to stderr and data to stdout,
/// so appending keeps `logs` 2>&1 semantics at the cost of ordering); bounded
/// by `timeout`. Exit code -1 covers signal deaths like the remote parse path.
/// A configured endpoint rides the engine's own env var (`DOCKER_HOST` /
/// `CONTAINER_HOST`) on the spawned process — never argv, never a shell.
pub(super) async fn run_local(
    cli: &Path,
    args: &[&str],
    timeout: Duration,
    endpoint: Option<&str>,
) -> Result<(i32, String), String> {
    use std::process::Stdio;
    use tokio::process::Command;
    let mut command = Command::new(cli);
    command.args(args).stdin(Stdio::null());
    if let Some(endpoint) = endpoint {
        command
            .env("DOCKER_HOST", endpoint)
            .env("CONTAINER_HOST", endpoint);
    }
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("spawn {:?} failed: {error}", cli))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("{cli:?} timed out after {}s", timeout.as_secs()))?
        .map_err(|error| format!("container CLI failed: {error}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.code().unwrap_or(-1), text))
}

/// The unavailable payload shape, shared with the remote probe semantics:
/// `needsSudo` marks CLI-found-but-daemon-denied (the docker-group hint),
/// plain unavailable covers both "CLI missing" and "daemon not running"
/// with the generic empty state.
pub(super) fn unavailable_payload(needs_sudo: bool) -> Value {
    json!({ "available": false, "needsSudo": needs_sudo, "containers": [] })
}

/// `docker/list` for `target: "local"`. Same payload contract as the
/// remote path — `available` / `needsSudo` / `containers` — assembled into
/// the same marker text so [`list_payload`] stays the single parser.
pub async fn collect_list_local(engine: &EngineConfig) -> Result<Value, String> {
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Ok(unavailable_payload(false));
    };
    let (info_code, info_output) = run_local(
        &cli,
        &["info", "--format", "{{.ServerVersion}}"],
        LIST_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if info_code != 0 {
        return Ok(unavailable_payload(is_daemon_permission_failure(
            info_code,
            &info_output,
        )));
    }
    let (_, ps_output) = run_local(
        &cli,
        &["ps", "-a", "--no-trunc", "--format", PS_FORMAT],
        LIST_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    // 与远端 heredoc 同一兜底：老 CLI（<1.13）的 .State 模板报错时输出为
    // 空，改跑 legacy 占位符集并打标记（issue #168）。
    let section = if ps_output.trim().is_empty() {
        let (_, legacy_output) = run_local(
            &cli,
            &["ps", "-a", "--no-trunc", "--format", PS_FORMAT_LEGACY],
            LIST_TIMEOUT,
            engine.endpoint.as_deref(),
        )
        .await?;
        format!("{PS_LEGACY_MARKER}\n{legacy_output}")
    } else {
        ps_output
    };
    Ok(list_payload(&format!(
        "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{section}"
    )))
}

/// `docker/logs` for `target: "local"`: inspect first, then the tail, both
/// assembled into the marker text so [`logs_payload`] parses unchanged.
/// A failed inspect (container gone) degrades to `container: null` exactly
/// like the remote script's `2>/dev/null` section.
pub async fn collect_logs_local(
    engine: &EngineConfig,
    container_id: &str,
    tail: u64,
) -> Result<Value, String> {
    validate_container_id(container_id)?;
    let tail = clamp_tail(tail);
    let cli = find_local_cli(&engine.cli)
        .ok_or_else(|| format!("{} CLI not found on this machine", engine.cli))?;
    let (inspect_code, inspect_output) = run_local(
        &cli,
        &["inspect", container_id],
        LOGS_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if inspect_code != 0 && !inspect_output.trim_start().starts_with('[') {
        // Missing container: keep going into logs, which surface the same
        // "No such container" error — the remote script does the same.
        if is_daemon_permission_failure(inspect_code, &inspect_output) {
            return Err(format!(
                "{} inspect failed: {inspect_output}. Local container access \
                 needs daemon permission: start Docker Desktop/OrbStack/Podman \
                 Desktop, or add your user to the docker group.",
                engine.cli
            ));
        }
    }
    let tail_text = tail.to_string();
    let (_, logs_output) = run_local(
        &cli,
        &["logs", "--tail", &tail_text, container_id],
        LOGS_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    Ok(logs_payload(&format!(
        "DBXDOCKER_INSPECT\n{inspect_output}\nDBXDOCKER_LOGS\n{logs_output}"
    )))
}

/// `docker/action` for `target: "local"`. Same whitelist, id gate and
/// success contract as the remote plane; the sudo fallback does not exist
/// locally (no Quick Sudo plumbing for the machine itself), so a daemon
/// permission failure returns the actionable guidance instead.
pub async fn perform_action_local(
    engine: &EngineConfig,
    container_id: &str,
    action: DockerAction,
) -> Result<Value, String> {
    validate_container_id(container_id)?;
    let cli = find_local_cli(&engine.cli)
        .ok_or_else(|| format!("{} CLI not found on this machine", engine.cli))?;
    let (exit_code, output) = run_local(
        &cli,
        &[action.as_str(), container_id],
        ACTION_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if exit_code == 0 {
        return Ok(json!({ "success": true, "output": output }));
    }
    if is_daemon_permission_failure(exit_code, &output) {
        return Err(format!(
            "{} {}: {output}. Local container actions need daemon permission: \
             start Docker Desktop/OrbStack/Podman Desktop, or add your user to \
             the docker group.",
            engine.cli,
            action.as_str()
        ));
    }
    Err(format!(
        "{} {} failed (exit {}): {}",
        engine.cli,
        action.as_str(),
        exit_code,
        output
    ))
}
