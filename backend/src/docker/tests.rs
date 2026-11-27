use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::local::unavailable_payload;
use super::parse::legacy_state_from_status;
use super::rpc::{audit_action_failure, audit_action_intent};
use crate::audit_log;
use crate::model::TerminalStream;

use super::*;

/// `docker ps -a` output as the script emits it: tab-separated, one
/// running and one exited container.
const PS_FIXTURE: &str = "\
d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp, :::8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC
9f8e7d6c5b4a\tcache\tredis:7-alpine\texited\tExited (0) 2 hours ago\t\t2026-09-18 21:30:00 +0000 UTC
";

const LIST_FIXTURE_WITH_ROWS: &str = "\
DBXDOCKER_PROBE
docker-found
daemon-ok
DBXDOCKER_PS
d4a7c9f1e2b3\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC
9f8e7d6c5b4a\tcache\tredis:7-alpine\texited\tExited (0) 2 hours ago\t\t2026-09-18 21:30:00 +0000 UTC
";

const INSPECT_FIXTURE: &str = r#"[
    {
        "Id": "sha256:d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7",
        "Created": "2026-09-01T08:15:03.9Z",
        "Path": "nginx",
        "Name": "/web-nginx",
        "State": {
            "Status": "running",
            "Running": true,
            "StartedAt": "2026-09-20T06:00:00.1Z",
            "Health": { "Status": "healthy" }
        },
        "Config": { "Image": "nginx:1.27" },
        "HostConfig": { "RestartPolicy": { "Name": "unless-stopped" } }
    }
]"#;

#[test]
fn parses_container_rows_from_tab_output() {
    let rows = parse_ps_section(PS_FIXTURE);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id.len(), 64);
    assert_eq!(rows[0].name, "web-nginx");
    assert_eq!(rows[0].state, "running");
    assert_eq!(rows[0].ports, "0.0.0.0:8080->80/tcp, :::8080->80/tcp");
    assert_eq!(rows[0].created_at, "2026-09-01 08:15:04 +0000 UTC");
    // Empty ports column survives as an empty string (exited container).
    assert_eq!(rows[1].id, "9f8e7d6c5b4a");
    assert_eq!(rows[1].ports, "");
    assert_eq!(rows[1].state, "exited");
}

#[test]
fn malformed_ps_rows_are_skipped_line_by_line() {
    let text = "only-three-columns\there\tyeah\n\
                     \t\n\
                     9f8e7d6c5b4a\tcache\tredis:7\texited\tExited (0)\t\t2026-09-18 21:30:00 +0000 UTC\n";
    let rows = parse_ps_section(text);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "cache");
    assert!(parse_ps_section("").is_empty());
    assert!(parse_ps_section("no tabs at all\n").is_empty());
}

#[test]
fn list_payload_reports_available_and_containers() {
    let payload = list_payload(LIST_FIXTURE_WITH_ROWS);
    assert_eq!(payload["available"], true);
    assert_eq!(payload["needsSudo"], false);
    assert_eq!(payload["containers"].as_array().unwrap().len(), 2);
    assert_eq!(payload["containers"][0]["name"], "web-nginx");
    assert_eq!(payload["containers"][0]["id"], "d4a7c9f1e2b3");
}

/// 旧版（<1.13）回退臂（#168）：legacy 段 6 列（无 State），state 由
/// Status 文本推导；modern 段优先、legacy 段拼接其后。
#[test]
fn list_payload_parses_legacy_fallback_rows() {
    let legacy_row =
        "9f8e7d6c5b4a\tcache\tredis:7\tExited (0) 2 days ago\t\t2026-09-18 21:30:00 +0000 UTC";
    let output = format!(
        "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{PS_LEGACY_MARKER}\n{legacy_row}\n"
    );
    let payload = list_payload(&output);
    assert_eq!(payload["available"], true);
    let rows = payload["containers"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "cache");
    assert_eq!(rows[0]["state"], "exited");
    assert_eq!(rows[0]["status"], "Exited (0) 2 days ago");
    assert_eq!(rows[0]["createdAt"], "2026-09-18 21:30:00 +0000 UTC");
}

#[test]
fn legacy_state_derives_from_status_text() {
    assert_eq!(legacy_state_from_status("Up 3 hours"), "running");
    assert_eq!(legacy_state_from_status("Up 2 hours (Paused)"), "paused");
    assert_eq!(
        legacy_state_from_status("Up 5 minutes (unhealthy)"),
        "running"
    );
    assert_eq!(
        legacy_state_from_status("Exited (137) 9 minutes ago"),
        "exited"
    );
    assert_eq!(legacy_state_from_status("Created"), "created");
    assert_eq!(
        legacy_state_from_status("Restarting (1) 12 seconds ago"),
        "restarting"
    );
    assert_eq!(legacy_state_from_status("Dead"), "dead");
    assert_eq!(legacy_state_from_status("Something New"), "unknown");
}

#[test]
fn modern_rows_win_over_and_mix_with_legacy_section() {
    let modern = "d4a7c9f1e2b3\tweb-nginx\tnginx:1.27\trunning\tUp 3 hours\t0.0.0.0:8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC";
    let legacy = "9f8e7d6c5b4a\tcache\tredis:7\tExited (0)\t\t2026-09-18 21:30:00 +0000 UTC";
    let output = format!(
        "DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{modern}\n{PS_LEGACY_MARKER}\n{legacy}\n"
    );
    let rows = list_payload(&output)["containers"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["state"], "running");
    assert_eq!(rows[1]["state"], "exited");
}

/// 远端 heredoc 与本地直连两条采集路径都必须带 legacy 兜底臂（#168）：
/// 一个丢掉就会在老 CLI 上回到空列表无报错的静默失败。
#[test]
fn list_collectors_carry_the_legacy_fallback_arm() {
    let engine = crate::docker::EngineConfig::default();
    let body = list_body(&engine);
    assert!(body.contains(PS_FORMAT));
    assert!(body.contains(PS_LEGACY_MARKER));
    assert!(body.contains(PS_FORMAT_LEGACY));
}

#[test]
fn list_payload_marks_missing_docker_unavailable() {
    let output = "DBXDOCKER_PROBE\ndocker-missing\ndaemon-denied\nDBXDOCKER_PS\n";
    let payload = list_payload(output);
    assert_eq!(payload["available"], false);
    assert_eq!(payload["needsSudo"], false);
    assert_eq!(payload["containers"].as_array().unwrap().len(), 0);
    // Garbage or empty output (script failed entirely) degrades to the
    // unavailable state instead of erroring the whole call.
    let empty = list_payload("");
    assert_eq!(empty["available"], false);
}

#[test]
fn list_payload_marks_daemon_denied_as_needs_sudo() {
    let output = "DBXDOCKER_PROBE\ndocker-found\ndaemon-denied\nDBXDOCKER_PS\n";
    let payload = list_payload(output);
    assert_eq!(payload["available"], false);
    assert_eq!(payload["needsSudo"], true);
}

#[test]
fn container_id_gate_enforces_lowercase_hex_length() {
    assert!(validate_container_id("d4a7c9f1e2b3").is_ok()); // 12 hex
    assert!(validate_container_id(&"a".repeat(64)).is_ok()); // full sha
                                                             // Too short / too long.
    assert!(validate_container_id("d4a7c9f1e2b").is_err());
    assert!(validate_container_id(&"a".repeat(65)).is_err());
    // Uppercase, names, separators, shell metacharacters.
    assert!(validate_container_id("D4A7C9F1E2B3").is_err());
    assert!(validate_container_id("web-nginx").is_err());
    assert!(validate_container_id("d4a7c9f1e2b3; rm -rf /").is_err());
    assert!(validate_container_id("d4a7c9f1 e2b3").is_err());
    assert!(validate_container_id("").is_err());
}

#[test]
fn tail_clamps_into_the_documented_band() {
    assert_eq!(clamp_tail(0), TAIL_MIN);
    assert_eq!(clamp_tail(5), TAIL_MIN);
    assert_eq!(clamp_tail(200), 200);
    assert_eq!(clamp_tail(5000), TAIL_MAX);
    assert_eq!(clamp_tail(u64::MAX), TAIL_MAX);
}

#[test]
fn action_whitelist_and_command_rendering() {
    assert_eq!(parse_action("start").unwrap(), DockerAction::Start);
    assert_eq!(parse_action("rm").unwrap(), DockerAction::Remove);
    assert_eq!(parse_action("remove").unwrap(), DockerAction::Remove);
    let error = parse_action("exec").unwrap_err();
    assert!(
        error.contains("Unsupported docker action 'exec'"),
        "{error}"
    );
    assert!(error.contains("start, stop, restart, kill, rm"), "{error}");
    assert!(parse_action("").is_err());
    assert!(parse_action("RM -RF /").is_err());

    let engine = EngineConfig::default();
    assert_eq!(
        action_command(&engine, DockerAction::Start, "d4a7c9f1e2b3"),
        "docker start d4a7c9f1e2b3"
    );
    assert_eq!(
        action_command(&engine, DockerAction::Remove, "d4a7c9f1e2b3"),
        "docker rm d4a7c9f1e2b3"
    );
    // Podman engine: the approval/audit text follows the configured CLI
    // (still no endpoint prefix — that rides env vars only).
    let podman = EngineConfig {
        cli: "podman".into(),
        endpoint: Some("unix:///run/user/1000/podman.sock".into()),
    };
    assert_eq!(
        action_command(&podman, DockerAction::Remove, "d4a7c9f1e2b3"),
        "podman rm d4a7c9f1e2b3"
    );
    assert_eq!(
        exec_command(&podman, DockerAction::Remove, "d4a7c9f1e2b3"),
        "export DOCKER_HOST='unix:///run/user/1000/podman.sock' \
             CONTAINER_HOST='unix:///run/user/1000/podman.sock'; podman rm d4a7c9f1e2b3"
    );
    assert_eq!(
        exec_command(&engine, DockerAction::Stop, "d4a7c9f1e2b3"),
        "docker stop d4a7c9f1e2b3"
    );
}

/// The stock-engine renderings must stay byte-identical to the legacy
/// const scripts (upgrade-safe: old audit expectations keep matching).
const LEGACY_LIST_BODY: &str = concat!(
    "PATH=\"$PATH:/usr/local/bin:/opt/homebrew/bin:/snap/bin",
    ":/Applications/Docker.app/Contents/Resources/bin:$HOME/.docker/bin",
    ":$HOME/.orbstack/bin:$HOME/bin:$HOME/.local/bin\"\n",
    "echo DBXDOCKER_PROBE\n",
    "if command -v docker >/dev/null 2>&1; then echo docker-found; else echo docker-missing; fi\n",
    "if docker info >/dev/null 2>&1; then echo daemon-ok; else echo daemon-denied; fi\n",
    "echo DBXDOCKER_PS\n",
    "ps_out=$(docker ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}\\t{{.CreatedAt}}' 2>/dev/null)\n",
    "if [ -n \"$ps_out\" ]; then printf '%s\\n' \"$ps_out\"; else\n",
    "echo DBXDOCKER_PS_LEGACY\n",
    "docker ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}\\t{{.CreatedAt}}' 2>/dev/null\n",
    "fi\n",
);

#[test]
fn parse_engine_defaults_validates_and_normalizes() {
    // Absent/empty params = stock docker, no endpoint.
    assert_eq!(
        parse_engine(&json!({})).unwrap(),
        EngineConfig {
            cli: "docker".into(),
            endpoint: None
        }
    );
    assert_eq!(
        parse_engine(&json!({ "cli": "", "socket": "", "host": "" })).unwrap(),
        EngineConfig {
            cli: "docker".into(),
            endpoint: None
        }
    );
    // Podman by name; whitespace tolerated.
    assert_eq!(
        parse_engine(&json!({ "cli": " podman " })).unwrap().cli,
        "podman"
    );
    // Full path + socket URL pass through; bare socket path gains unix://.
    let engine = parse_engine(
        &json!({ "cli": "/usr/local/bin/podman", "socket": "/run/user/1000/podman.sock" }),
    )
    .unwrap();
    assert_eq!(engine.cli, "/usr/local/bin/podman");
    assert_eq!(
        engine.endpoint.as_deref(),
        Some("unix:///run/user/1000/podman.sock")
    );
    // Bare host:port gains tcp://; explicit schemes pass through.
    assert_eq!(
        parse_engine(&json!({ "host": "127.0.0.1:2375" }))
            .unwrap()
            .endpoint
            .as_deref(),
        Some("tcp://127.0.0.1:2375")
    );
    assert_eq!(
        parse_engine(&json!({ "host": "tcp://10.0.0.8:2376" }))
            .unwrap()
            .endpoint
            .as_deref(),
        Some("tcp://10.0.0.8:2376")
    );
    // Mutually exclusive endpoints are refused.
    let error = parse_engine(&json!({ "socket": "/x.sock", "host": "1.2.3.4:2375" })).unwrap_err();
    assert!(error.contains("mutually exclusive"), "{error}");
    // Charset gate: shell/cmd metacharacters never reach a script.
    assert!(parse_engine(&json!({ "cli": "podman; rm -rf /" })).is_err());
    assert!(parse_engine(&json!({ "cli": "docker --bad space" })).is_err());
    // Whitespace-only behaves like absent (default), per the empty rule.
    assert_eq!(parse_engine(&json!({ "cli": " " })).unwrap().cli, "docker");
    assert!(parse_engine(&json!({ "socket": "unix:///a b.sock" })).is_err());
    assert!(parse_engine(&json!({ "host": "no-port-here" })).is_err());
    assert!(parse_engine(&json!({ "cli": 42 })).is_err());
}

#[test]
fn engine_env_prefixes_cover_posix_and_cmd() {
    let plain = EngineConfig::default();
    assert_eq!(plain.env_prefix(), "");
    assert_eq!(plain.cmd_env_lines(), "");
    assert_eq!(plain.cmd_env_prefix(), "");
    let engine = EngineConfig {
        cli: "podman".into(),
        endpoint: Some("unix:///run/podman/podman.sock".into()),
    };
    assert_eq!(
        engine.env_prefix(),
        "export DOCKER_HOST='unix:///run/podman/podman.sock' CONTAINER_HOST='unix:///run/podman/podman.sock'; "
    );
    assert_eq!(
        engine.cmd_env_lines(),
        "set DOCKER_HOST=unix:///run/podman/podman.sock\r\nset CONTAINER_HOST=unix:///run/podman/podman.sock\r\n"
    );
    assert_eq!(
        engine.cmd_env_prefix(),
        "set DOCKER_HOST=unix:///run/podman/podman.sock&& set CONTAINER_HOST=unix:///run/podman/podman.sock&& "
    );
}

#[test]
fn list_scripts_follow_engine_and_stay_legacy_compatible() {
    // Default engine: byte-identical to the legacy const collectors.
    let default = EngineConfig::default();
    assert_eq!(
        list_script(&default),
        format!("sh -s <<'DBXDOCKER'\n{LEGACY_LIST_BODY}DBXDOCKER\n")
    );
    // Podman + endpoint: cli interpolated, endpoint exported in-body so
    // the Quick Sudo retry (which passes the body as argv) keeps it.
    let podman =
        parse_engine(&json!({ "cli": "podman", "socket": "/run/user/1000/podman.sock" })).unwrap();
    let script = list_script(&podman);
    assert!(script.starts_with("sh -s <<'DBXDOCKER'"), "{script}");
    assert!(script.contains("command -v podman"), "{script}");
    assert!(script.contains("podman info"), "{script}");
    assert!(script.contains("podman ps -a --no-trunc"), "{script}");
    assert!(
        script.contains("export DOCKER_HOST='unix:///run/user/1000/podman.sock'"),
        "{script}"
    );
    assert_eq!(
        list_body(&podman),
        script
            .trim_start_matches("sh -s <<'DBXDOCKER'\n")
            .trim_end_matches("DBXDOCKER\n")
    );
    // Windows fallback: same interpolation, cmd set lines for endpoint.
    let win = win_list_script(&podman);
    assert!(win.contains("where /q podman"), "{win}");
    assert!(win.contains("podman ps -a"), "{win}");
    assert!(
        win.contains("set DOCKER_HOST=unix:///run/user/1000/podman.sock"),
        "{win}"
    );
    assert!(!win.contains("sh -s"), "{win}");
    let win_default = win_list_script(&default);
    assert!(win_default.contains("where /q docker"), "{win_default}");
    assert!(!win_default.contains("set DOCKER_HOST"), "{win_default}");
}

#[test]
fn logs_and_sudo_bodies_follow_engine() {
    let podman = parse_engine(&json!({ "cli": "podman", "host": "127.0.0.1:2375" })).unwrap();
    let script = logs_script(&podman, "d4a7c9f1e2b3", 120).unwrap();
    assert!(script.starts_with("sh -s <<'DBXDOCKER'"), "{script}");
    assert!(script.contains("podman inspect d4a7c9f1e2b3"), "{script}");
    assert!(
        script.contains("podman logs --tail 120 d4a7c9f1e2b3"),
        "{script}"
    );
    assert!(
        script.contains("export DOCKER_HOST='tcp://127.0.0.1:2375'"),
        "{script}"
    );
    let clamped = logs_script(&podman, "d4a7c9f1e2b3", 99_999).unwrap();
    assert!(clamped.contains("podman logs --tail 2000"), "{clamped}");
    assert!(logs_script(&podman, "web-nginx", 100).is_err());
    // Sudo body: same content, no heredoc wrapper (stdin = password).
    let body = sudo_logs_body(&podman, "d4a7c9f1e2b3", 120).unwrap();
    assert!(body.starts_with("PATH="), "{body}");
    assert!(body.contains("podman inspect d4a7c9f1e2b3"), "{body}");
    assert!(
        body.contains("export DOCKER_HOST='tcp://127.0.0.1:2375'"),
        "{body}"
    );
    assert!(!body.contains("sh -s"), "{body}");
    assert!(sudo_logs_body(&podman, "web-nginx", 100).is_err());
}

#[test]
fn marker_sections_split_inspect_and_logs() {
    let output =
        format!("DBXDOCKER_INSPECT\n{INSPECT_FIXTURE}\nDBXDOCKER_LOGS\nline one\nline two\n");
    let payload = logs_payload(&output);
    assert_eq!(payload["logs"], "line one\nline two\n");
    let container = &payload["container"];
    assert_eq!(container["name"], "web-nginx");
    assert_eq!(container["image"], "nginx:1.27");
    assert_eq!(container["status"], "running");
    assert_eq!(container["running"], true);
    assert_eq!(container["startedAt"], "2026-09-20T06:00:00.1Z");
    assert_eq!(container["health"], "healthy");
    assert_eq!(container["restartPolicy"], "unless-stopped");
    assert!(container["id"]
        .as_str()
        .unwrap()
        .starts_with("sha256:d4a7c9f1"));
}

#[test]
fn logs_payload_tolerates_missing_or_broken_inspect() {
    // No inspect section at all (probe failed before inspect ran).
    let no_inspect = logs_payload("DBXDOCKER_LOGS\nhello\n");
    assert_eq!(no_inspect["logs"], "hello\n");
    assert_eq!(no_inspect["container"], Value::Null);
    // Inspect section present but not JSON (docker wrote an error there).
    let broken = logs_payload("DBXDOCKER_INSPECT\nError: No such object\nDBXDOCKER_LOGS\n");
    assert_eq!(broken["container"], Value::Null);
    assert!(parse_inspect_output("").is_none());
    assert!(parse_inspect_output("[]").is_none());
    // Inspect object without the exotic fields still yields a summary.
    let minimal = parse_inspect_output(r#"[{"Id":"sha256:ab","Name":"/x"}]"#).unwrap();
    assert_eq!(minimal.name, "x");
    assert_eq!(minimal.image, "");
    assert_eq!(minimal.health, None);
}

#[test]
fn daemon_permission_signature_gates_the_sudo_fallback() {
    // Real docker CLI wording on a socket-permission failure.
    assert!(is_daemon_permission_failure(
        1,
        "docker: Got permission denied while trying to connect to the Docker daemon socket"
    ));
    assert!(is_daemon_permission_failure(125, "permission denied"));
    // Case-insensitive match on the merged output.
    assert!(is_daemon_permission_failure(1, "PERMISSION DENIED"));
    // Success or any other failure shape must NOT trigger the fallback
    // (retrying a half-executed action with sudo could double-apply it).
    assert!(!is_daemon_permission_failure(0, "permission denied"));
    assert!(!is_daemon_permission_failure(
        1,
        "Error response from daemon: No such container: d4a7c9f1e2b3"
    ));
    assert!(!is_daemon_permission_failure(1, ""));
}

#[test]
fn sudo_fallback_error_points_at_configuration() {
    let error = sudo_fallback_error("sudo exited 1: boom".to_string());
    assert!(error.contains("Quick Sudo"), "{error}");
    assert!(error.contains("docker group"), "{error}");
}

#[test]
fn audit_rows_land_before_and_after_failures() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path();
    audit_action_intent(data_dir, "docker restart d4a7c9f1e2b3");
    audit_action_failure(
        data_dir,
        "docker restart d4a7c9f1e2b3",
        "docker restart failed (exit 1): oops",
        42,
    );
    let entries = audit_log::tail(data_dir, 10, None).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].tool, "docker/action");
    assert_eq!(entries[0].outcome, audit_log::EntryOutcome::Ok);
    assert_eq!(
        entries[0].command.as_deref(),
        Some("docker restart d4a7c9f1e2b3")
    );
    assert_eq!(entries[1].outcome, audit_log::EntryOutcome::Error);
    assert_eq!(
        entries[1].error.as_deref(),
        Some("docker restart failed (exit 1): oops")
    );
    assert_eq!(entries[1].duration_ms, 42);
}

// —— Local-machine plane ————————————————————————————————————

/// The local direct-exec collector and the remote heredoc must share the
/// exact `--format` template or `parse_ps_section` sees drifted columns.
#[test]
fn local_ps_format_is_the_remote_script_template() {
    // 钉死 heredoc 包裹与 body 的组合、以及两个收集器的 --format 模板，
    // 任一路径漂移即测试失败。
    assert!(PS_FORMAT.starts_with("{{.ID}}\\t{{.Names}}"));
    // The PATH hardening covers the well-known GUI-install locations.
    for fragment in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/Applications/Docker.app/Contents/Resources/bin",
        "$HOME/.docker/bin",
        "$HOME/.orbstack/bin",
    ] {
        assert!(PATH_PREFIX.contains(fragment), "{PATH_PREFIX}");
        assert!(list_body(&EngineConfig::default()).contains(fragment));
    }
}

#[test]
fn parse_target_defaults_to_ssh_and_rejects_unknown() {
    assert_eq!(parse_target(&json!({})), Ok(DockerTarget::Ssh));
    assert_eq!(
        parse_target(&json!({ "target": null })),
        Ok(DockerTarget::Ssh)
    );
    assert_eq!(
        parse_target(&json!({ "target": "ssh" })),
        Ok(DockerTarget::Ssh)
    );
    assert_eq!(
        parse_target(&json!({ "target": "local" })),
        Ok(DockerTarget::Local)
    );
    let error = parse_target(&json!({ "target": "remote" })).unwrap_err();
    assert!(
        error.contains("Unsupported docker target 'remote'"),
        "{error}"
    );
    assert!(error.contains("ssh (default), local"), "{error}");
    assert!(parse_target(&json!({ "target": 42 })).is_err());
}

#[test]
fn cli_search_dirs_cover_home_and_platform_installs() {
    let home = Path::new("/Users/dev");
    let unix_dirs = cli_search_dirs(home, false);
    assert!(unix_dirs.contains(&std::path::PathBuf::from("/usr/local/bin")));
    assert!(unix_dirs.contains(&std::path::PathBuf::from("/opt/homebrew/bin")));
    assert!(unix_dirs.contains(&home.join(".docker/bin")));
    assert!(unix_dirs.contains(&home.join(".orbstack/bin")));
    assert!(unix_dirs.contains(&std::path::PathBuf::from(
        "/Applications/Docker.app/Contents/Resources/bin"
    )));
    let windows_dirs = cli_search_dirs(Path::new(r"C:\Users\dev"), true);
    assert!(windows_dirs.iter().any(|dir| {
        dir.as_os_str()
            .to_string_lossy()
            .contains("Docker\\Docker\\resources\\bin")
    }));
    // Home-derived dirs must not leak between platforms.
    assert!(!windows_dirs.iter().any(|dir| dir.starts_with("/usr/local")));
}

#[test]
fn find_local_cli_resolves_explicit_paths() {
    // Path-form cli: a real executable file resolves verbatim (no
    // .exe suffixing, no PATH search); a missing path yields None.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let exe_path = dir.path().join("podman");
        std::fs::write(&exe_path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let found = find_local_cli(exe_path.to_str().unwrap()).unwrap();
        assert_eq!(found, exe_path);
    }
    assert!(find_local_cli("/definitely/not/a/real/container-cli").is_none());
}

#[test]
fn windows_fallback_triggers_only_without_probe_marker() {
    // POSIX hosts always emit the marker — even on docker-missing.
    assert!(!needs_windows_fallback(LIST_FIXTURE_WITH_ROWS));
    assert!(!needs_windows_fallback(
        "DBXDOCKER_PROBE\ndocker-missing\ndaemon-denied\nDBXDOCKER_PS\n"
    ));
    // cmd garbling the heredoc: no markers at all.
    assert!(needs_windows_fallback(""));
    assert!(needs_windows_fallback(
        "'sh' is not recognized as an internal or external command\r\n"
    ));
}

#[test]
fn windows_collector_output_parses_crlf_like_posix() {
    // cmd emits CRLF; the parsers must trim \r field by field.
    let crlf_output = "DBXDOCKER_PROBE\r\ndocker-found\r\ndaemon-ok\r\nDBXDOCKER_PS\r\nd4a7c9f1e2b3\tweb-nginx\tnginx:1.27\trunning\tUp 3 days\t0.0.0.0:8080->80/tcp\t2026-09-01 08:15:04 +0000 UTC\r\n";
    let payload = list_payload(crlf_output);
    assert_eq!(payload["available"], true);
    assert_eq!(payload["needsSudo"], false);
    let rows = payload["containers"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "web-nginx");
    // Trailing \r must not leak into the last column.
    let created = rows[0]["createdAt"].as_str().unwrap();
    assert!(created.ends_with("UTC"));
    assert!(!created.ends_with('\r'), "{created:?}");
    assert_eq!(created, "2026-09-01 08:15:04 +0000 UTC");
}

#[test]
fn win_list_script_is_a_marker_compatible_cmd_collector() {
    // The fallback must produce output the POSIX parser accepts: same
    // markers, same order, docker-native \t escapes, cmd nul redirects.
    let script = win_list_script(&EngineConfig::default());
    assert!(script.starts_with("echo DBXDOCKER_PROBE"));
    assert!(script.contains("where /q docker"));
    assert!(script.contains("2>nul"));
    assert!(script.contains(PS_FORMAT));
    assert!(!script.contains("sh -s"), "{script}");
}

#[test]
fn sudo_logs_body_validates_and_travels_as_argv() {
    let engine = EngineConfig::default();
    let body = sudo_logs_body(&engine, "d4a7c9f1e2b3", 120).unwrap();
    assert!(body.starts_with("PATH="), "{body}");
    assert!(body.contains("echo DBXDOCKER_INSPECT"), "{body}");
    assert!(body.contains("docker inspect d4a7c9f1e2b3"), "{body}");
    assert!(
        body.contains("docker logs --tail 120 d4a7c9f1e2b3"),
        "{body}"
    );
    // The body must NOT carry the heredoc wrapper: exec_with_sudo wraps
    // it in `sudo -S -p '' sh -c '<escaped>'` where stdin = password.
    assert!(!body.contains("sh -s"), "{body}");
    assert!(!body.contains("DBXDOCKER\n"));
    // Id gate runs before any rendering.
    assert!(sudo_logs_body(&engine, "web-nginx", 100).is_err());
}

#[test]
fn local_marker_assembly_feeds_the_shared_parsers() {
    // collect_list_local assembles probe + ps markers around the direct
    // exec output; the assembled text must parse like remote output.
    let assembled = format!("DBXDOCKER_PROBE\ndocker-found\ndaemon-ok\nDBXDOCKER_PS\n{PS_FIXTURE}");
    let payload = list_payload(&assembled);
    assert_eq!(payload["available"], true);
    assert_eq!(payload["containers"].as_array().unwrap().len(), 2);
    // collect_logs_local assembles inspect + logs markers; container
    // summary extraction is unchanged from the remote path.
    let logs_assembled =
        format!("DBXDOCKER_INSPECT\n{INSPECT_FIXTURE}\nDBXDOCKER_LOGS\nlocal line\n");
    let logs = logs_payload(&logs_assembled);
    assert_eq!(logs["container"]["name"], "web-nginx");
    assert_eq!(logs["logs"], "local line\n");
    // Unavailable payload keeps the documented shape for both verdicts.
    assert_eq!(unavailable_payload(false)["available"], false);
    assert_eq!(unavailable_payload(true)["needsSudo"], true);
    assert_eq!(
        unavailable_payload(false)["containers"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

// —— B3 日志流：聚合 / UTF-8 / TTL / 子进程回收 / 注册表 ————————————

#[cfg(unix)]
fn logs_source(script: &str) -> StreamSource {
    StreamSource::Local {
        program: std::path::PathBuf::from("/bin/sh"),
        args: vec!["-c".to_string(), script.to_string()],
        endpoint: None,
    }
}

#[cfg(unix)]
fn stream_request(owner: &str, script: &str) -> StreamRequest {
    StreamRequest {
        connection_id: "conn-1".to_string(),
        container_id: "d4a7c9f1e2b3".to_string(),
        requested_stream_id: Some(owner.to_string()),
        tail: 200,
        timestamps: false,
        source: logs_source(script),
    }
}

#[derive(Default)]
struct RecordingSink {
    frames: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    events: std::sync::Mutex<Vec<(String, Value)>>,
}

impl StreamSink for RecordingSink {
    fn binary(&self, channel: &str, data: &[u8]) -> Result<(), String> {
        self.frames
            .lock()
            .unwrap()
            .push((channel.to_string(), data.to_vec()));
        Ok(())
    }

    fn event(&self, method: &str, params: Value) -> Result<(), String> {
        self.events
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        Ok(())
    }
}

impl RecordingSink {
    fn frame_count(&self) -> usize {
        self.frames.lock().unwrap().len()
    }

    fn events_named(&self, method: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(name, _)| name == method)
            .map(|(_, params)| params.clone())
            .collect()
    }
}

/// 二进制通道不可用的降级 sink：first binary call fails the way the SDK
/// does on non-framed transports, then chunk events are recorded.
#[derive(Default)]
struct ChunkOnlySink {
    chunks: std::sync::Mutex<Vec<String>>,
    events: std::sync::Mutex<Vec<(String, Value)>>,
}

impl StreamSink for ChunkOnlySink {
    fn binary(&self, _channel: &str, _data: &[u8]) -> Result<(), String> {
        Err("Binary messages require framed transport".to_string())
    }

    fn event(&self, method: &str, params: Value) -> Result<(), String> {
        if method == "docker/logs/chunk" {
            if let Some(text) = params.get("text").and_then(Value::as_str) {
                self.chunks.lock().unwrap().push(text.to_string());
            }
        }
        self.events
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        Ok(())
    }
}

#[test]
fn logs_batcher_preserves_multibyte_utf8_crlf_and_long_single_fragments() {
    let mut batcher = ChunkBatcher::new(MAX_BATCH_BYTES, BATCH_INTERVAL);
    let t0 = Instant::now();
    // 多字节字符跨两次 read（"你" = E4 BD A0）与 \r\n 原样保留。
    assert!(batcher
        .push(TerminalStream::Stdout, &[0xE4, 0xBD], t0)
        .is_empty());
    assert!(batcher
        .push(TerminalStream::Stdout, &[0xA0, b'\r', b'\n'], t0)
        .is_empty());
    let batch = batcher.flush().expect("pending batch");
    assert_eq!(batch.stream, TerminalStream::Stdout);
    assert_eq!(std::str::from_utf8(&batch.data).unwrap(), "你\r\n");

    // 超长单行：单个 fragment 绝不切分（帧可以超过 64 KiB）。
    let long = vec![b'x'; MAX_BATCH_BYTES + 6 * 1024];
    let ready = batcher.push(TerminalStream::Stdout, &long, t0);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].data.len(), long.len());

    // 流切换先 flush 旧流，帧内不混 stdout/stderr。
    assert!(batcher.push(TerminalStream::Stdout, b"out", t0).is_empty());
    let ready = batcher.push(TerminalStream::Stderr, b"err", t0);
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].stream, TerminalStream::Stdout);
    assert_eq!(ready[0].data, b"out");
    let tail = batcher.flush().expect("stderr batch");
    assert_eq!(tail.stream, TerminalStream::Stderr);
    assert_eq!(tail.data, b"err");
}

#[test]
fn logs_batcher_flushes_on_byte_or_time_threshold() {
    let mut batcher = ChunkBatcher::new(8, Duration::from_millis(100));
    let t0 = Instant::now();
    assert!(batcher.push(TerminalStream::Stdout, b"abc", t0).is_empty());
    assert!(batcher.poll(t0 + Duration::from_millis(99)).is_none());
    let timed = batcher
        .poll(t0 + Duration::from_millis(100))
        .expect("time flush");
    assert_eq!(timed.data, b"abc");

    let t1 = t0 + Duration::from_millis(200);
    let ready = batcher.push(TerminalStream::Stdout, b"01234567", t1);
    assert_eq!(ready.len(), 1, "byte cap flushes immediately");
    assert_eq!(ready[0].data, b"01234567");
    assert!(batcher.flush().is_none());
}

#[test]
fn logs_utf8_encoder_keeps_split_characters_until_the_next_push() {
    let mut encoder = Utf8ChunkEncoder::new(4);
    assert!(encoder.push(&[0xE4, 0xBD]).is_empty());
    assert_eq!(encoder.push(&[0xA0]), vec!["你".to_string()]);

    // 非法字节按 lossy 覆盖，不阻塞后续输出。
    let lossy = encoder.push(b"a\xFFb");
    assert_eq!(lossy.concat(), "a\u{FFFD}b");

    // 流结束时残留的半个字符按 lossy 收尾（不丢内容）。
    let mut tail = Utf8ChunkEncoder::new(64);
    assert!(tail.push(&[0xE4, 0xBD]).is_empty());
    assert_eq!(tail.finish().unwrap(), "\u{FFFD}");
}

#[test]
fn logs_ttl_limits_are_byte_or_time_whichever_comes_first() {
    let defaults = StreamLimits::default();
    assert!(!ttl_exceeded(Duration::from_secs(60), 1024, defaults));
    assert!(ttl_exceeded(Duration::from_secs(30 * 60), 0, defaults));
    assert!(ttl_exceeded(
        Duration::from_secs(1),
        STREAM_MAX_BYTES,
        defaults
    ));
    let small = StreamLimits {
        max_bytes: 4,
        max_duration: Duration::from_millis(10),
    };
    assert!(!ttl_exceeded(Duration::from_millis(5), 3, small));
    assert!(ttl_exceeded(Duration::from_millis(5), 4, small));
    assert!(ttl_exceeded(Duration::from_millis(10), 0, small));
}

#[test]
fn logs_stream_script_keeps_the_id_out_of_the_body_and_quotes_it_as_argv() {
    let engine = EngineConfig::default();
    let id = "d4a7c9f1e2b3a1c0d4e5f6a7b8c9d0e1";
    let body = logs_stream_body(&engine, 200, true);
    assert!(!body.contains(id));
    assert!(body.contains("-- \"$1\""));
    assert!(body.contains("--timestamps"));
    let script = logs_stream_script(&engine, id, 5000, false).unwrap();
    // tail 被钳到 2000；id 只作为 shell_quote 后的位置参数出现。
    assert!(script.contains("--tail 2000"));
    assert!(script.contains(&format!("'{}'", id)));
    assert!(logs_stream_script(&engine, "web-nginx", 200, false).is_err());
    // 本机 argv 同样是独立参数，无 shell 拼接。
    let args = logs_stream_args(id, 10, true);
    assert_eq!(args.last().unwrap(), id);
    assert!(args.contains(&"--timestamps".to_string()));
}

#[cfg(unix)]
#[tokio::test]
async fn stop_child_sigkills_a_sigterm_ignoring_child_after_grace() {
    let mut child = tokio::process::Command::new("/bin/sh")
        .args(["-c", "trap '' TERM; sleep 5"])
        .spawn()
        .expect("spawn stubborn child");
    let started = Instant::now();
    stop_child(&mut child, Duration::from_millis(80)).await;
    assert!(
        started.elapsed() >= Duration::from_millis(70),
        "grace must elapse before SIGKILL"
    );
    assert!(
        matches!(child.try_wait(), Ok(Some(_))),
        "child must be reaped by stop_child"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_registry_stop_is_idempotent_and_unknown_ids_succeed() {
    let registry =
        StreamRegistry::with_limits_and_grace(StreamLimits::default(), Duration::from_millis(50));
    let sink = std::sync::Arc::new(RecordingSink::default());
    let started = registry
        .start(stream_request("stop-idem", "printf 'a\\n'; sleep 30"), sink)
        .await
        .expect("start");
    let id = started["streamId"].as_str().unwrap().to_string();
    assert_eq!(id, "stop-idem");
    assert_eq!(registry.active_count(), 1);

    assert_eq!(registry.stop(&id).await.unwrap()["success"], true);
    assert_eq!(registry.stop(&id).await.unwrap()["success"], true);
    assert_eq!(
        registry.stop("never-started").await.unwrap()["success"],
        true
    );
    assert_eq!(registry.active_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_registry_ttl_ends_the_stream_and_flushes_the_tail() {
    let registry = StreamRegistry::with_limits_and_grace(
        StreamLimits {
            max_bytes: 3,
            max_duration: Duration::from_secs(60),
        },
        Duration::from_millis(50),
    );
    let sink = std::sync::Arc::new(RecordingSink::default());
    registry
        .start(
            stream_request("ttl-small", "printf 'abcdef\\n'; sleep 30"),
            sink.clone(),
        )
        .await
        .expect("start");
    for _ in 0..80 {
        if !sink.events_named("docker/logs/end").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let ends = sink.events_named("docker/logs/end");
    assert_eq!(ends.len(), 1, "end must fire exactly once: {ends:?}");
    assert_eq!(ends[0]["reason"], "ttl");
    assert!(sink.frame_count() >= 1, "tail batch must flush before end");
    assert_eq!(registry.active_count(), 1, "entry stays until stop");
    registry.stop("ttl-small").await.unwrap();
    assert_eq!(registry.active_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_registry_survives_close_start_races_with_no_late_frames() {
    let registry = std::sync::Arc::new(StreamRegistry::with_limits_and_grace(
        StreamLimits::default(),
        Duration::from_millis(30),
    ));
    let sink = std::sync::Arc::new(RecordingSink::default());
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let registry = registry.clone();
        let sink = sink.clone();
        tasks.push(tokio::spawn(async move {
            for _ in 0..4 {
                let request = stream_request("race", "printf 'line\\n'; sleep 30");
                match registry.start(request, sink.clone()).await {
                    Ok(value) => {
                        let id = value["streamId"].as_str().unwrap().to_string();
                        let _ = registry.stop(&id).await;
                    }
                    Err(error) => {
                        assert!(
                            error.contains("closed") || error.contains("already active"),
                            "unexpected start error: {error}"
                        );
                    }
                }
            }
        }));
    }
    for task in tasks {
        task.await.expect("race task");
    }
    for _ in 0..4 {
        let _ = registry.stop("race").await;
    }
    assert_eq!(registry.active_count(), 0);
    let before = sink.frame_count();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(
        sink.frame_count(),
        before,
        "a stopped stream must not emit late frames"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_registry_rejects_a_late_start_after_close_until_the_tombstone_expires() {
    let registry =
        StreamRegistry::with_limits_and_grace(StreamLimits::default(), Duration::from_millis(30));
    let sink = std::sync::Arc::new(RecordingSink::default());
    registry
        .start(
            stream_request("late", "printf 'x\\n'; sleep 30"),
            sink.clone(),
        )
        .await
        .expect("first start");
    registry.stop("late").await.unwrap();
    let error = registry
        .start(stream_request("late", "printf 'y\\n'; sleep 30"), sink)
        .await
        .expect_err("late start must be refused by the tombstone");
    assert!(error.contains("closed"), "unexpected error: {error}");
    assert_eq!(registry.active_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_registry_caps_concurrency_at_eight_with_a_readable_error() {
    let registry =
        StreamRegistry::with_limits_and_grace(StreamLimits::default(), Duration::from_millis(30));
    let sink = std::sync::Arc::new(RecordingSink::default());
    let mut ids = Vec::new();
    for index in 0..MAX_ACTIVE_STREAMS {
        let value = registry
            .start(
                stream_request(&format!("cap-{index}"), "printf 'x\\n'; sleep 30"),
                sink.clone(),
            )
            .await
            .expect("start below the cap");
        ids.push(value["streamId"].as_str().unwrap().to_string());
    }
    let error = registry
        .start(
            stream_request("cap-overflow", "printf 'x\\n'; sleep 30"),
            sink,
        )
        .await
        .expect_err("ninth stream must be refused");
    assert!(error.contains("limit reached"), "unexpected error: {error}");
    assert_eq!(registry.active_count(), MAX_ACTIVE_STREAMS);
    for id in ids {
        registry.stop(&id).await.unwrap();
    }
    assert_eq!(registry.active_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn logs_stream_falls_back_to_chunk_events_when_binary_is_unsupported() {
    let sink = std::sync::Arc::new(ChunkOnlySink::default());
    let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
    run_stream(
        "fallback".to_string(),
        logs_source("printf '\\344\\275\\240ok\\n'"),
        cancel_rx,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        sink.clone(),
        StreamLimits::default(),
        Duration::from_millis(50),
    )
    .await;
    let text = sink.chunks.lock().unwrap().concat();
    assert_eq!(text, "你ok\n");
    let ends = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == "docker/logs/end")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].1["reason"], "exited");
}
