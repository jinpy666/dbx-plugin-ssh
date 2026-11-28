use super::auth::*;
use super::auth_key::*;
use super::ssh_client::*;
use super::transfer_paths::{commit_plan, preserved_target_permissions};
use super::upload_meta::{read_upload_meta, resumable_uploads_from, write_upload_meta};
use super::*;
use russh::{cipher, kex, mac};

fn auth_failure(remaining: &[MethodKind], partial_success: bool) -> AuthResult {
    let mut methods = russh::MethodSet::empty();
    for kind in remaining {
        methods.push(*kind);
    }
    AuthResult::Failure {
        remaining_methods: methods,
        partial_success,
    }
}

#[test]
fn method_offered_reads_only_the_server_advertised_set() {
    let offered = auth_failure(&[MethodKind::KeyboardInteractive], false);
    assert!(method_offered(&offered, MethodKind::KeyboardInteractive));
    // Tabby parity (authMethodSelection): a method the server did not
    // advertise must never be tried — blind retries trip MaxAuthTries.
    assert!(!method_offered(&offered, MethodKind::Password));
    assert!(!method_offered(&offered, MethodKind::PublicKey));
}

#[test]
fn method_offered_is_false_for_success_and_empty_advertisements() {
    assert!(!method_offered(&AuthResult::Success, MethodKind::Password));
    assert!(!method_offered(
        &auth_failure(&[], false),
        MethodKind::KeyboardInteractive
    ));
}

#[test]
fn auth_partial_success_only_fires_when_the_server_flags_it() {
    // koko / PAM 2FA shape: first factor accepted, second factor demanded.
    assert!(auth_partial_success(&auth_failure(
        &[MethodKind::KeyboardInteractive],
        true
    )));
    assert!(!auth_partial_success(&auth_failure(
        &[MethodKind::Password],
        false
    )));
    assert!(!auth_partial_success(&AuthResult::Success));
}

fn method_set(kinds: &[MethodKind]) -> MethodSet {
    MethodSet::from(kinds)
}

#[test]
fn reconcile_advertised_requires_both_advertisements_to_list_the_method() {
    // none 探测广告 password + KI；密码步之后服务器只放行 KI（koko
    // 第一因子已过的形状）：KI 双份广告集都在 → 可试；password 被逐步
    // 广告集收走 → 不可再试。
    let none = method_set(&[MethodKind::Password, MethodKind::KeyboardInteractive]);
    let step = auth_failure(&[MethodKind::KeyboardInteractive], true);
    assert!(reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::KeyboardInteractive
    ));
    assert!(!reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::Password
    ));
}

#[test]
fn reconcile_advertised_lets_the_none_probe_veto_later_methods() {
    // 严格服务器：none 探测只广告 publickey。即使后续逐步广告集放行
    // password/KI，也不得盲试 —— Tabby authMethodSelection 语义，防止
    // 把 MaxAuthTries 预算烧在服务器根本不开的方法上。
    let none = method_set(&[MethodKind::PublicKey]);
    let step = auth_failure(
        &[MethodKind::Password, MethodKind::KeyboardInteractive],
        false,
    );
    assert!(!reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::Password
    ));
    assert!(!reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::KeyboardInteractive
    ));
}

#[test]
fn reconcile_advertised_takes_the_stricter_side_on_conflicting_sets() {
    // 两份广告集互相冲突：none 只广告 password，逐步广告集只广告 KI。
    // 合并判定必须两边都放行才可试，因此两个方法都被否掉。
    let none = method_set(&[MethodKind::Password]);
    let step = auth_failure(&[MethodKind::KeyboardInteractive], true);
    assert!(!reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::Password
    ));
    assert!(!reconcile_advertised(
        Some(&none),
        &step,
        MethodKind::KeyboardInteractive
    ));
}

#[test]
fn reconcile_advertised_fails_open_without_a_none_advertisement() {
    // 异常形状（拿不到 none 广告集）→ 回退旧行为：只看逐步广告集。
    let step = auth_failure(&[MethodKind::Password], false);
    assert!(reconcile_advertised(None, &step, MethodKind::Password));
    assert!(!reconcile_advertised(
        None,
        &step,
        MethodKind::KeyboardInteractive
    ));
    assert!(!reconcile_advertised(
        None,
        &AuthResult::Success,
        MethodKind::Password
    ));
}

#[test]
fn advertised_methods_maps_empty_and_non_failure_shapes_to_none() {
    // russh 在传输层断开时也回 Failure{空集}：空集信息量为零，必须判为
    // "无广告集"，否则幽灵限制会把登录 fail-closed 卡死。
    assert!(advertised_methods(&auth_failure(&[], false)).is_none());
    assert!(advertised_methods(&AuthResult::Success).is_none());
    let rejection = auth_failure(&[MethodKind::Password], true);
    let none =
        advertised_methods(&rejection).expect("a non-empty rejection carries the advertisement");
    assert!(none.contains(&MethodKind::Password));
}

#[test]
fn advertisement_rejection_message_keeps_the_base_text_and_appends_the_set() {
    let base = "SSH server did not advertise password or keyboard-interactive authentication; refusing to send the password";
    assert_eq!(advertisement_rejection_message(None), base);
    let none = method_set(&[MethodKind::PublicKey]);
    let message = advertisement_rejection_message(Some(&none));
    assert!(
        message.starts_with(base),
        "the historical message must stay a prefix: {message}"
    );
    assert!(
        message.contains("publickey"),
        "the server's advertisement must be named: {message}"
    );
}

#[test]
fn agent_planner_stops_at_the_identity_budget() {
    // OpenSSH MaxAuthTries defaults to 6 *total* failures including the
    // leading none probe, so the 5th identity attempt is the last one.
    let full_rejection = auth_failure(&[MethodKind::PublicKey], false);
    assert_eq!(
        plan_agent_identity_attempt(AGENT_IDENTITY_MAX_ATTEMPTS - 1, Some(&full_rejection), None),
        AgentPlan::TryNext,
        "budget not yet exhausted: the next identity may still be tried"
    );
    match plan_agent_identity_attempt(AGENT_IDENTITY_MAX_ATTEMPTS, Some(&full_rejection), None) {
        AgentPlan::StopRejection(message) => assert!(
            message.contains(
                "server may have disconnected after too many auth attempts (MaxAuthTries)"
            ) && message.contains("consider specifying a private key"),
            "the budget message must name MaxAuthTries and the private-key workaround: {message}"
        ),
        other => panic!("the exhausted budget must stop the loop, got {other:?}"),
    }
}

#[test]
fn agent_planner_stops_on_partial_success_advertising_keyboard_interactive() {
    // koko shape: identity accepted, MFA still owed. Advertising
    // keyboard-interactive while flagging partial success means the
    // identity landed — more identities could only burn the budget.
    let partial = auth_failure(&[MethodKind::KeyboardInteractive], true);
    assert_eq!(
        plan_agent_identity_attempt(0, Some(&partial), None),
        AgentPlan::StopPartialSuccess
    );
    // Without the KI advertisement (or the partial flag) a rejection is
    // full: the advertised set does not change between per-identity
    // attempts, so the planner must not over-read it.
    let full = auth_failure(&[MethodKind::Password], true);
    assert_eq!(
        plan_agent_identity_attempt(0, Some(&full), None),
        AgentPlan::TryNext
    );
    assert_eq!(
        plan_agent_identity_attempt(0, Some(&partial), None),
        AgentPlan::StopPartialSuccess
    );
    assert_eq!(
        plan_agent_identity_attempt(
            0,
            Some(&auth_failure(&[MethodKind::PublicKey], false)),
            None
        ),
        AgentPlan::TryNext
    );
}

#[test]
fn agent_planner_stops_on_first_transport_error_and_surfaces_it() {
    // All identities share the same agent handle: after the first
    // transport error no remaining attempt can recover, and the surfaced
    // message must carry the original error text.
    let plan = plan_agent_identity_attempt(
        1,
        Some(&auth_failure(&[MethodKind::PublicKey], false)),
        Some("agent signature request failed: connection reset"),
    );
    match plan {
        AgentPlan::StopRejection(message) => assert_eq!(
            message, "agent signature request failed: connection reset",
            "the first error must be surfaced verbatim"
        ),
        other => panic!("a transport error must stop the loop, got {other:?}"),
    }
    // Even a budget-exhausted plan defers to the concrete error.
    assert_eq!(
        plan_agent_identity_attempt(AGENT_IDENTITY_MAX_ATTEMPTS, None, Some("any error")),
        AgentPlan::StopRejection("any error".to_string())
    );
}

#[test]
fn agent_planner_tries_next_while_budget_remains() {
    let rejection = auth_failure(&[MethodKind::PublicKey], false);
    assert_eq!(
        plan_agent_identity_attempt(0, None, None),
        AgentPlan::TryNext,
        "before the first attempt the planner has nothing to stop on"
    );
    assert_eq!(
        plan_agent_identity_attempt(0, Some(&rejection), None),
        AgentPlan::TryNext
    );
    assert_eq!(
        plan_agent_identity_attempt(AGENT_IDENTITY_MAX_ATTEMPTS - 1, Some(&rejection), None),
        AgentPlan::TryNext
    );
}

#[test]
fn normalized_spawn_command_treats_absent_and_blank_as_no_command() {
    assert_eq!(normalized_spawn_command(None).unwrap(), None);
    assert_eq!(normalized_spawn_command(Some("")).unwrap(), None);
    assert_eq!(normalized_spawn_command(Some("   ")).unwrap(), None);
    assert_eq!(normalized_spawn_command(Some(" \t\r\n ")).unwrap(), None);
}

#[test]
fn normalized_spawn_command_trims_and_keeps_inner_whitespace() {
    assert_eq!(
        normalized_spawn_command(Some("  htop  "))
            .unwrap()
            .as_deref(),
        Some("htop")
    );
    assert_eq!(
        normalized_spawn_command(Some("tail -f /var/log/syslog"))
            .unwrap()
            .as_deref(),
        Some("tail -f /var/log/syslog")
    );
}

#[test]
fn normalized_spawn_command_fails_closed_on_nul_and_oversize() {
    let nul_error = normalized_spawn_command(Some("echo a\0b")).unwrap_err();
    assert_eq!(nul_error, "spawnCommand must not contain NUL bytes");

    let oversized = "x".repeat(SPAWN_COMMAND_MAX_BYTES + 1);
    let error = normalized_spawn_command(Some(&oversized)).unwrap_err();
    assert_eq!(
        error,
        format!("spawnCommand exceeds the {SPAWN_COMMAND_MAX_BYTES} byte limit")
    );
    // At-cap commands are accepted; the cap counts UTF-8 bytes.
    let at_cap = "x".repeat(SPAWN_COMMAND_MAX_BYTES);
    assert!(normalized_spawn_command(Some(&at_cap)).unwrap().is_some());
    let at_cap_multibyte = "中".repeat(SPAWN_COMMAND_MAX_BYTES / 3);
    assert!(normalized_spawn_command(Some(&at_cap_multibyte))
        .unwrap()
        .is_some());
}

#[test]
fn spawn_exec_payload_single_quote_escapes_and_preserves_shell_semantics() {
    // Repo hard rule: remote commands are single-quote escaped. The
    // payload is one `sh -c '<escaped>'` argument for the outer shell;
    // the inner sh keeps pipes and redirects intact.
    assert_eq!(spawn_exec_payload("htop"), "sh -c 'htop'");
    assert_eq!(
        spawn_exec_payload("it's"),
        "sh -c 'it'\\''s'",
        "embedded single quotes use the '\\'' escape (exec::shell_quote)"
    );
    assert_eq!(
        spawn_exec_payload("echo a && cat /etc/passwd | wc -l > /tmp/x; rm -rf '$(pwd)'"),
        "sh -c 'echo a && cat /etc/passwd | wc -l > /tmp/x; rm -rf '\\''$(pwd)'\\'''"
    );
    // The metacharacters stay inside the quoted payload: nothing outside
    // the single quotes except the fixed `sh -c ` prefix.
    let payload = spawn_exec_payload("a; b | c & d");
    assert!(payload.starts_with("sh -c '") && payload.ends_with("'"));
}

#[test]
fn sudo_upload_staging_name_uses_dedicated_prefix() {
    let name = sudo_upload_staging_name("task-1");
    assert!(name.starts_with(".dbx-sudo-ul-") && name.ends_with(".part"));
    // 与下载车道前缀互不误伤（清理命令按前缀钉死命名空间）。
    assert!(!name.starts_with(".dbx-sudo-dl-"));
    assert_eq!(sudo_upload_staging_name("t"), ".dbx-sudo-ul-t.part");
}

#[test]
fn sudo_commit_body_quotes_paths_and_rolls_back() {
    let body = sudo_commit_body(
        "/home/u/.dbx-sudo-ul-t.part",
        "/root/a.bin",
        "/root/.dbx-upload-t.backup",
    );
    // 三个路径都单引号转义，让位→提交→清理/回滚次序固定。
    assert!(body.contains(
        "if [ -e '/root/a.bin' ]; then mv -f -- '/root/a.bin' '/root/.dbx-upload-t.backup'; fi"
    ));
    assert!(body.contains("if mv -f -- '/home/u/.dbx-sudo-ul-t.part' '/root/a.bin'; then rm -f -- '/root/.dbx-upload-t.backup'; exit 0; fi"));
    assert!(body.ends_with("if [ -e '/root/.dbx-upload-t.backup' ]; then mv -f -- '/root/.dbx-upload-t.backup' '/root/a.bin'; fi; exit 1"));
    // 嵌入单引号的路径经 POSIX '\'' 转义后整体仍是合法 shell。
    let quoted = sudo_commit_body("/home/u'/x", "/t'/y", "/b'/z");
    assert!(quoted.contains("'/home/u'\\''/x'"));
    assert!(quoted.contains("'/t'\\''/y'"));
}

#[test]
fn upload_progress_payload_marks_the_phase() {
    let staging = upload_progress_payload(
        "t1",
        "s1",
        Some("a.bin"),
        256,
        1024,
        UploadPhase::Staging,
        "running",
        CompressionMode::Gzip,
    );
    assert_eq!(staging["phase"], "staging");
    assert_eq!(staging["direction"], "upload");
    assert_eq!(staging["fileName"], "a.bin");
    assert_eq!(staging["transferred"], 256);
    assert_eq!(staging["size"], 1024);
    assert_eq!(staging["status"], "running");
    // M33：上传进度事件与下载同语义，恒带 compression 字段（含 none）。
    assert_eq!(staging["compression"], "gzip");

    let pushing = upload_progress_payload(
        "t1",
        "s1",
        None,
        512,
        1024,
        UploadPhase::Uploading,
        "running",
        CompressionMode::None,
    );
    assert_eq!(pushing["phase"], "uploading");
    assert_eq!(pushing["compression"], "none");
    // Non-start events carry no fileName; the workbench keeps its own.
    assert!(pushing.get("fileName").is_none());
}

#[test]
fn upload_cancel_error_tells_abort_reasons_apart() {
    assert_eq!(
        upload_cancel_error(Some("user")),
        "Upload cancelled by user"
    );
    assert_eq!(
        upload_cancel_error(Some(" ack-timeout ")),
        "Upload cancelled (ack-timeout)"
    );
    assert_eq!(upload_cancel_error(None), "Upload cancelled");
    assert_eq!(upload_cancel_error(Some("   ")), "Upload cancelled");
}

#[test]
fn numeric_or_absent_owner_values_ask_for_names() {
    assert!(owner_needs_name(&None));
    assert!(owner_needs_name(&Some("0".to_string())));
    assert!(owner_needs_name(&Some("1000".to_string())));
    // Already a name (SFTPv4+ attribute or a previous lookup): no work.
    assert!(!owner_needs_name(&Some("root".to_string())));
    // Defensive: an empty string would render as "-" either way.
    assert!(!owner_needs_name(&Some(String::new())));
}

#[test]
fn parse_ls_owner_map_reads_gnu_epoch_layout() {
    let output = "\
total 20
drwxr-xr-x  3 root root 4096 1720000000 .
drwxr-xr-x  1 root wheel 4096 1720000001 ..
-rw-r--r--  1 alice docker  123 1720000002 notes.txt
drwxr-xr-x  2 root root 4096 1720000003 sub dir with spaces
lrwxrwxrwx  1 root root   11 1720000004 link -> notes.txt
";
    let map = parse_ls_owner_map(output);
    assert_eq!(
        map.get("notes.txt"),
        Some(&("alice".to_string(), "docker".to_string()))
    );
    assert_eq!(
        map.get("sub dir with spaces"),
        Some(&("root".to_string(), "root".to_string()))
    );
    // Symlink arrow is stripped from the name key.
    assert_eq!(
        map.get("link"),
        Some(&("root".to_string(), "root".to_string()))
    );
    // "." / ".." come along but harmless: they never match SftpEntry names.
    assert_eq!(
        map.get("."),
        Some(&("root".to_string(), "root".to_string()))
    );
}

#[test]
fn parse_ls_owner_map_reads_classic_layout() {
    // BusyBox/BSD dates spread over three fields; owner/group stay in
    // fields 3/4 regardless.
    let output = "\
-rw-r--r--    1 root     root          4096 Jan 15 10:23 readme.md
-rw-r--r--    1 svc     deploy          123 Jan 15  2024 old.log
";
    let map = parse_ls_owner_map(output);
    assert_eq!(
        map.get("readme.md"),
        Some(&("root".to_string(), "root".to_string()))
    );
    assert_eq!(
        map.get("old.log"),
        Some(&("svc".to_string(), "deploy".to_string()))
    );
}

#[test]
fn parse_ls_owner_map_ignores_headers_and_noise() {
    assert!(parse_ls_owner_map("").is_empty());
    assert!(parse_ls_owner_map("total 20\n").is_empty());
    assert!(parse_ls_owner_map("ls: cannot open '/x': Permission denied\n").is_empty());
    // A row too short to carry owner/group is dropped, not misparsed.
    assert!(parse_ls_owner_map("-rw-r--r-- 1 x\n").is_empty());
}

#[test]
fn parse_ls_owner_map_keeps_first_row_for_duplicate_names() {
    let output = "\
-rw-r--r--  1 root root 1 1720000000 a.txt
-rw-r--r--  1 amy ops  2 1720000001 a.txt
";
    let map = parse_ls_owner_map(output);
    assert_eq!(
        map.get("a.txt"),
        Some(&("root".to_string(), "root".to_string()))
    );
}

#[test]
fn test_connection_budget_aligns_with_host_deadline() {
    assert_eq!(test_dial_budget_secs(30, true), 29);
    assert_eq!(test_dial_budget_secs(30, false), 9);
    assert_eq!(test_dial_budget_secs(1, true), 1);
}

#[test]
fn next_test_budget_extends_once_for_dialog_path() {
    // Without a host dialog in play the probe keeps the current readable
    // timeout error (1.0 hosts, workbench fallback, exhausted extension).
    assert_eq!(next_test_budget(9, false), None);
    assert_eq!(next_test_budget(29, false), None);
    // Dialog in flight: one extension by the challenge wait plus the
    // connect timeout.
    assert_eq!(
        next_test_budget(9, true),
        Some(HOST_KEY_CHALLENGE_WAIT.as_secs() + 9)
    );
    // A zero stored connect timeout must not shrink the window.
    assert_eq!(
        next_test_budget(0, true),
        Some(HOST_KEY_CHALLENGE_WAIT.as_secs())
    );
}

#[test]
fn classify_entry_kind_maps_wire_types() {
    // Directories stay directories; only `kind === "directory"` renders a
    // folder icon in the UI.
    assert_eq!(classify_entry_kind(FileType::Dir), "directory");
    assert_eq!(classify_entry_kind(FileType::File), "file");
    assert_eq!(classify_entry_kind(FileType::Symlink), "symlink");
    // Missing/unusable type bits (no PERMISSIONS flag, or permissions
    // without S_IFMT bits) must degrade to a file icon, never a folder.
    assert_eq!(classify_entry_kind(FileType::Other), "file");
}

#[test]
fn link_target_kind_only_promotes_directory_and_file() {
    // issue #330：跟随链接后的类型进入 wire 词汇。
    assert_eq!(link_target_kind("directory"), "directory");
    assert_eq!(link_target_kind("file"), "file");
    // A server that reports the link itself (STAT not following) or any
    // unknown type must never masquerade as a navigable directory.
    assert_eq!(link_target_kind("symlink"), "other");
    assert_eq!(link_target_kind("other"), "other");
    assert_eq!(link_target_kind(""), "other");
}

#[test]
fn symlink_probe_paths_only_cover_symlink_entries() {
    let entry = |name: &str, kind: &'static str, uri: String| SftpEntry {
        name: name.to_string(),
        uri,
        kind,
        size: None,
        modified_at: None,
        permissions: None,
        content_type: None,
        owner: None,
        group: None,
        lossy: false,
        target_kind: None,
    };
    let entries = vec![
        entry("dir", "directory", sftp_uri("/home/u/dir")),
        entry("link-dir", "symlink", sftp_uri("/home/u/link-dir")),
        entry("file.txt", "file", sftp_uri("/home/u/file.txt")),
        entry("link-file", "symlink", sftp_uri("/home/u/link-file")),
        // Non-`sftp:` URI is skipped instead of aborting the listing.
        entry("broken", "symlink", "file:///tmp/broken".to_string()),
    ];
    let probes = symlink_probe_paths(&entries);
    assert_eq!(
        probes,
        vec![
            (1, "/home/u/link-dir".to_string()),
            (3, "/home/u/link-file".to_string()),
        ]
    );
}

#[test]
fn sftp_entry_serializes_target_kind_only_when_known() {
    let mut entry = SftpEntry {
        name: "link".to_string(),
        uri: sftp_uri("/home/u/link"),
        kind: "symlink",
        size: None,
        modified_at: None,
        permissions: None,
        content_type: None,
        owner: None,
        group: None,
        lossy: false,
        target_kind: None,
    };
    let absent = serde_json::to_value(&entry).expect("serialize");
    assert!(absent.get("targetKind").is_none(), "{absent}");
    entry.target_kind = Some("directory");
    let present = serde_json::to_value(&entry).expect("serialize");
    assert_eq!(
        present.get("targetKind").and_then(|v| v.as_str()),
        Some("directory")
    );
}

#[test]
fn test_timeout_message_names_budget_source_and_remedy() {
    let explicit = test_timeout_message("dbx-ssh-test", 22, 29, false, false);
    assert_eq!(
        explicit,
        "SSH connection to dbx-ssh-test:22 timed out after 29 seconds. Increase 'SSH timeout' under Advanced options and retry."
    );
    let fallback = test_timeout_message("dbx-ssh-test", 22, 9, true, false);
    assert!(
        fallback.contains("timed out after 9 seconds (host default)"),
        "{fallback}"
    );
    assert!(
        fallback.contains("Increase 'SSH timeout' under Advanced options"),
        "{fallback}"
    );
}

#[test]
fn test_timeout_message_names_pending_host_key_confirmation() {
    let base = test_timeout_message("h", 22, 9, true, false);
    assert!(base.contains("timed out after 9 seconds (host default)"));
    assert!(base.contains("Increase 'SSH timeout'"));

    let with_challenge = test_timeout_message("h", 22, 9, false, true);
    assert!(with_challenge.contains("host-key confirmation"));
    assert!(!with_challenge.contains("(host default)"));
}

#[test]
fn replay_buffer_is_sequence_addressable() {
    let mut replay = ReplayBuffer::default();
    replay.push(TerminalStream::Stdout, b"one".to_vec());
    replay.push(TerminalStream::Stderr, b"two".to_vec());
    let frames = replay.after(1);
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].sequence, 2);
}

#[test]
fn replay_buffer_honours_a_custom_byte_budget() {
    // 串口会话的 128 KiB 预算（设计稿 §3）：绕回后 first_sequence 前移，
    // after() 只回可得的尾部，complete 语义随 first_available 变化。
    let mut replay = ReplayBuffer::with_byte_limit(8);
    replay.push(TerminalStream::Stdout, b"12345".to_vec());
    replay.push(TerminalStream::Stdout, b"67890".to_vec());
    assert_eq!(replay.first_sequence(), 2, "frame 1 was evicted");
    assert_eq!(replay.tail_sequence(), 2);
    assert!(replay.after(0).iter().all(|frame| frame.sequence >= 2));
    // afterSequence+1 >= first_available → complete。
    assert!(
        replay.after(1).len() == 1,
        "replaying from 1 yields the surviving frame"
    );
    // 默认预算仍是共享的 2 MiB 上限。
    let replay = ReplayBuffer::default();
    let serialized = format!("{:?}", replay.byte_limit);
    assert_eq!(serialized, format!("{TERMINAL_REPLAY_LIMIT}"));
}

#[test]
fn terminal_input_enqueue_applies_backpressure_instead_of_dropping() {
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .try_send(TerminalCommand::Input(b"first".to_vec()))
        .expect("seed the bounded queue");

    let (done_sender, done_receiver) = std::sync::mpsc::channel();
    let blocked_sender = sender.clone();
    std::thread::spawn(move || {
        let result = enqueue_terminal_input(&blocked_sender, b"second".to_vec());
        done_sender.send(result).expect("report enqueue result");
    });

    assert!(done_receiver
        .recv_timeout(std::time::Duration::from_millis(25))
        .is_err());
    assert!(matches!(
        receiver.try_recv(),
        Ok(TerminalCommand::Input(data)) if data == b"first"
    ));
    assert_eq!(
        done_receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap(),
        Ok(())
    );
    assert!(matches!(
        receiver.try_recv(),
        Ok(TerminalCommand::Input(data)) if data == b"second"
    ));
}

#[test]
fn negotiated_algorithms_cover_legacy_without_weakening_secure_order() {
    // 存量连接可能还带着已下线的 ssh_algorithm_profile/policy 配置值；
    // 算法面已统一，任何旧值都不得改变协商集合。
    let connection = StoredConnection::from_lifecycle_params(&json!({
        "connection": {
            "id": "unified-algos",
            "host": "example.com",
            "port": 22,
            "username": "user",
            "password": "secret",
            "external_config": { "ssh_algorithm_profile": "legacy" }
        }
    }))
    .unwrap();
    let config = ssh_client_config(&connection);
    assert_eq!(config.preferred.mac.first(), Some(&mac::HMAC_SHA512_ETM));
    assert!(config.preferred.mac.contains(&mac::HMAC_SHA1));
    assert!(config.preferred.kex.contains(&kex::DH_G1_SHA1));
    assert!(config.preferred.cipher.contains(&cipher::AES_128_CBC));
    assert!(config.preferred.cipher.contains(&cipher::TRIPLE_DES_CBC));
    assert_eq!(config.gex.min_group_size(), 2048);
    assert_eq!(config.gex.preferred_group_size(), 3072);
    assert_eq!(config.gex.max_group_size(), 8192);
}

// —— 私钥来源解析：粘贴内容优先于路径（connection_secrets.private_key）———

fn key_connection(path: &str, content: &str) -> StoredConnection {
    StoredConnection::from_lifecycle_params(&json!({
        "connection": {
            "id": "key-resolve",
            "host": "example.com",
            "port": 22,
            "username": "user",
            "external_config": {
                "authentication": "private-key",
                "private_key_path": path
            },
            "connection_secrets": { "private_key": content }
        }
    }))
    .unwrap()
}

#[test]
fn private_key_text_normalizes_carriage_returns() {
    assert_eq!(
        normalize_private_key_text("a\r\nb\rc\nd"),
        "a\nb\nc\nd".to_string()
    );
    assert_eq!(normalize_private_key_text("plain\n"), "plain\n".to_string());
}

#[test]
fn private_key_text_normalizes_windows_bom_and_leading_whitespace() {
    let key = "\u{feff} \r\n-----BEGIN PRIVATE KEY-----\r\n\
            MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\r\n\
            -----END PRIVATE KEY-----\r\n";
    let normalized = normalize_private_key_text(key);

    assert!(normalized.starts_with("-----BEGIN PRIVATE KEY-----\n"));
    assert!(!normalized.contains('\r'));
    assert!(decode_secret_key(&normalized, None).is_ok());
}

// —— #21: 私钥解码错误分类与粘贴污损修复 ————————————————————————————
// 以下密钥全部为本仓库测试现场生成的废弃密钥或 ssh-key 上游公开测试
// fixture,绝不包含真实凭据。口令仅为测试值。

/// 废弃测试密钥(本机为编写测试生成,无对应主机)。
const OPENSSH_ED25519_PLAIN: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDkhRLM2wxmY826/LvkQeMRNf9pptlryFMSddhmTmhSrwAAAJiaGi/pmhov
6QAAAAtzc2gtZWQyNTUxOQAAACDkhRLM2wxmY826/LvkQeMRNf9pptlryFMSddhmTmhSrw
AAAEA41GJvRrU3mTnSyjUyLinDInc6VUNdHcvGr1te4YW7S+SFEszbDGZjzbr8u+RB4xE1
/2mm2WvIUxJ12GZOaFKvAAAADm1hdHJpeC1lZDI1NTE5AQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----";

/// 同上,口令为 "test-phrase"。
const OPENSSH_ED25519_ENCRYPTED: &str = "\
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABAd8e+k64
ZPDgMURR64zer1AAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIMcQDHXhSWOHA0pR
VYE3X8bEgjf0QVAcOzZ+6mZKzIa/AAAAoLKviiOSbTqOH2s7O+Y2AxZzne4kYYb0uZhpHH
eGHpS7VjhQLlN/B1cgyfNWqdROswIXdPbDL1uC5nzv8MAvH4lEobnNgZWVaxKoIAyTP3v+
c/3nQJQxJ1klouO/ojHcFFumbY4C+lRMGRhPIvtDj1alq5lvefD/3VmtK/jbeA8zuXcdv9
1QXkLgYJ5A3wpFPs7x/jgDn/v3e6jAwfZoZLU=
-----END OPENSSH PRIVATE KEY-----";

const ENCRYPTED_TEST_PASSPHRASE: &str = "test-phrase";

/// ssh-key 上游公开测试 fixture(user@example.com,无口令)。
const PPK3_ED25519_PLAIN: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Private-Lines: 1
AAAAILYGwiLRDBba4WxwpNRRc0cuxhfgXGVpINJuVsCPtZHt
Private-MAC: 94140d0344fad6aa1bf7b71e9c93db11ccac8a232f8a51e11c024869d608c82d";

/// 同一上游 fixture,口令为 "123"。
const PPK3_ED25519_ENCRYPTED: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: user@example.com
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XF
Sqti
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 34
Argon2-Parallelism: 1
Argon2-Salt: 63d1d43f7bf7700720496646a2f5ec17
Private-Lines: 1
DyWtExZ3dxFutnb12tIwXBC6kWdozrvP+r6faHKBGDb4+qEar9XBiC0BmGySMHUi
Private-MAC: 52fd00d4ef47ebc506e4e709486c0c6bc0606e24fe2c6cb1b3d168f4da238a66";

/// 废弃测试密钥(SEC1 传统 EC PEM,russh 不支持此封装)。
const EC_SEC1_PEM: &str = "\
-----BEGIN EC PRIVATE KEY-----
MIIBaAIBAQQgOtPbXkrREPIS68niEPbISV5VZmM4655BvEie7U9k/4CggfowgfcC
AQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////////
MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT57Pr
vVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEE
axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54W
K84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5ysL8
YyVRAgEBoUQDQgAERtRtbHHreGHq8c0a0GvFRsZ+3BfCcILOVeIpInh5O9ddBZQI
Q/TyBph+JFB6VjJb6neA04jwsdD13REn2e7/og==
-----END EC PRIVATE KEY-----";

/// 废弃测试密钥(PKCS#8 + PBES2/hmacWithSHA256,口令 "test-phrase";
/// russh 的 PKCS#5 解析不支持该 PRF)。
const PKCS8_PBES2_ENCRYPTED: &str = "\
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIICzzBJBgkqhkiG9w0BBQ0wPDAbBgkqhkiG9w0BBQwwDgQIOcKjFZoZ/fsCAggA
MB0GCWCGSAFlAwQBAgQQTfxxn8bDf+3cTfXy9sHVtgSCAoBF4F4/74FYKIDBbFxE
BXPvQRgnRTL6FWGD983/u9CueKi26cAty4N75cDEPwbq4xk/DMGhQTiSymv4SOK3
MBgZ/hb8jHWIp8SrZ2IvP14uM/EsVAvLgmnlu8JH/Q4BfYLbo4tvY88Wwx93GXdW
Ik6S30w+iDo/BTZ7by9mFITWD3DcIYpsrCgmn/MhQ/cRy7Eoe4wkMruMsY4aG4Tb
K1gDN/dLL/jrafcwDx1sjA71BmVf0bNKR9CBk1sZ5i5d4D0YSFRI4t8TG15cjb/l
NQwi9ykch3t6ojtQvHT645Z8kiTYjfPEyqgEWtSZd+69QAJ0Gl1XEqb+kH7eyMOL
oyMOfoX+Z3cEHCNY5/FZvFUTLmVX+OjzYY34LvzoSICeCr7HE+cnkRBEdpbLgyw9
LPlnpp7RWOXr8pidnr7vg7tN6sWnqM8JwPubDgl2gE1jUiqKHSWXHq6kEVEVA9Y4
uRBKE24j+FrPYGRjoKVXyPX0gjhqp66GDGaBCWs7LzdFO10IPxDKM6GJ8AxKLk9X
UVXqyvDfC9lh6YAHmTKmNYnKkEijdKkP7Uw57n8aWr1tw5xLyhABLZEGhPLcyazN
z7fnjJ+3LAEqD5dlZaczncsdFmZh1naKswCmSrwZOEbAeGbaZvdsHqspYwXGBTna
Q+KW8/vygV6WQZLnVu36rIkJq56Hzo3JFo3p2GOY/Pk1o82xFTm/fS3Pm3FWoapa
SiK9nBQ20ok8efOFN535UDWrmOMKcZTF/ZgpjKPCPFwaDFlpgtbWbUW+1ABMYv4g
GkWbTKmDiaAreK3qjVWf20UuzxzSFk/QS1dxTHoNv8NsvWAJp7AZv2WV6Bj+k9Is
sfwQ
-----END ENCRYPTED PRIVATE KEY-----";

/// 与 OPENSSH_ED25519_PLAIN 同钥的公钥单行形态(误粘场景)。
const ED25519_PUBLIC_ONELINER: &str = "\
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOSFEszbDGZjzbr8u+RB4xE1/2mm2WvIUxJ12GZOaFKv \
matrix-ed25519";

fn decode_error_of(text: &str, passphrase: Option<&str>) -> russh::keys::Error {
    decode_secret_key(text, passphrase).expect_err("sample must fail to decode")
}

fn assert_actionable(text: &str, error: &russh::keys::Error, provided: bool, guidance: &str) {
    let message = private_key_decode_failure(text, error, provided);
    assert!(
        message.starts_with("Failed to decode SSH private key: "),
        "{message}"
    );
    // 底层错误永远原样保留,不吞细节。
    assert!(
        message.contains(&format!("(decoder error: {error})")),
        "{message}"
    );
    assert!(message.contains(guidance), "{message}");
}

#[test]
fn paste_artifacts_are_normalized_and_then_decode() {
    let cases: Vec<(&str, String)> = vec![
        (
            "marker trailing space",
            OPENSSH_ED25519_PLAIN.replace(
                "-----BEGIN OPENSSH PRIVATE KEY-----",
                "-----BEGIN OPENSSH PRIVATE KEY----- ",
            ),
        ),
        (
            "marker inner double space",
            OPENSSH_ED25519_PLAIN.replace(
                "-----BEGIN OPENSSH PRIVATE KEY-----",
                "-----BEGIN  OPENSSH  PRIVATE  KEY-----",
            ),
        ),
        (
            "smart dashes",
            OPENSSH_ED25519_PLAIN
                .replace("-----BEGIN", "——–BEGIN")
                .replace("-----END", "——–END"),
        ),
        ("zero-width characters", {
            let mut text = OPENSSH_ED25519_PLAIN
                .replace("-----BEGIN OPENSSH", "-----\u{200b}BEGIN\u{200b} OPENSSH");
            text.insert(40, '\u{200b}');
            text
        }),
        (
            "web-page <br> tags",
            OPENSSH_ED25519_PLAIN
                .replace('\n', "<br>\n")
                .replacen("<br>", "<BR>", 1),
        ),
        ("re-wrapped body lines", {
            let mut lines: Vec<String> =
                OPENSSH_ED25519_PLAIN.lines().map(str::to_string).collect();
            lines[1].insert_str(24, "  ");
            lines[2].insert(24, '\t');
            lines.join("\n")
        }),
        (
            "crlf plus bom plus indent",
            format!(
                "\u{feff}   \r\n{}\r\n",
                OPENSSH_ED25519_PLAIN.replace('\n', "\r\n")
            ),
        ),
    ];
    for (label, polluted) in &cases {
        let normalized = normalize_private_key_text(polluted);
        let decoded = decode_secret_key(&normalized, None);
        assert!(decoded.is_ok(), "{label}: {normalized:?}");
    }
}

#[test]
fn paste_artifact_normalization_preserves_directive_lines() {
    // PKCS#5 传统加密 PEM 的 DEK-Info 指令行必须原样保留(含 IV 十六进制)。
    let text = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n\
            DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF \n\nabc= \n\
            -----END RSA PRIVATE KEY-----\n";
    let normalized = normalize_private_key_text(text);
    assert!(normalized.contains("DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n"));
    assert!(normalized.contains("Proc-Type: 4,ENCRYPTED\n"));
    assert!(normalized.contains("\nabc=\n"));
}

#[test]
fn decode_errors_are_classified_into_actionable_guidance() {
    // 加密 OpenSSH 密钥、未填口令。
    assert_actionable(
        OPENSSH_ED25519_ENCRYPTED,
        &decode_error_of(OPENSSH_ED25519_ENCRYPTED, None),
        false,
        "fill in the private key passphrase field",
    );
    // 加密 OpenSSH 密钥、口令错误。
    assert_actionable(
        OPENSSH_ED25519_ENCRYPTED,
        &decode_error_of(OPENSSH_ED25519_ENCRYPTED, Some("wrong-phrase")),
        true,
        "did not decrypt with the stored passphrase",
    );
    // 公钥单行形态被误当私钥。
    assert_actionable(
        ED25519_PUBLIC_ONELINER,
        &decode_error_of(ED25519_PUBLIC_ONELINER, None),
        false,
        "looks like a PUBLIC key or certificate",
    );
    assert_actionable(
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----",
        &decode_error_of(
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----",
            None,
        ),
        false,
        "looks like a PUBLIC key or certificate",
    );
    // 完全不是密钥文本。
    assert_actionable(
        "hello world, this is not a key",
        &decode_error_of("hello world, this is not a key", None),
        false,
        "no PEM private-key header",
    );
    // HTML 转义污染(无法自动修复,指引重新复制)。
    let html_escaped = "&lt;p&gt;-----BEGIN OPENSSH PRIVATE KEY-----&lt;/p&gt;";
    assert_actionable(
        html_escaped,
        &decode_error_of(html_escaped, None),
        false,
        "looks HTML-escaped",
    );
    // BEGIN 存在但标记无法修复(类型名内部断行)。
    let broken_marker =
        "-----BEGIN OPENSSH PRIVATE-KEY-----\nbody\n-----END OPENSSH PRIVATE-KEY-----";
    assert_actionable(
        broken_marker,
        &decode_error_of(broken_marker, None),
        false,
        "mangled by rich-text copy",
    );
    // SEC1 传统 EC PEM 自 russh 0.62 起已可直接解码，改归有效密钥用例。
    // PKCS#8 + 不支持的 PBKDF2 PRF。
    assert_actionable(
        PKCS8_PBES2_ENCRYPTED,
        &decode_error_of(PKCS8_PBES2_ENCRYPTED, Some(ENCRYPTED_TEST_PASSPHRASE)),
        true,
        "PBKDF2 variant",
    );
    // PuTTY PPK 加密、未填口令。
    assert_actionable(
        PPK3_ED25519_ENCRYPTED,
        &decode_error_of(PPK3_ED25519_ENCRYPTED, None),
        false,
        "this PuTTY PPK key is encrypted",
    );
    // PuTTY PPK 口令错误(MAC 校验失败)。
    assert_actionable(
        PPK3_ED25519_ENCRYPTED,
        &decode_error_of(PPK3_ED25519_ENCRYPTED, Some("wrong")),
        true,
        "the passphrase appears to be incorrect",
    );
    // PuTTY PPK 结构损坏。
    let corrupt_ppk = PPK3_ED25519_PLAIN.replace("Public-Lines: 2", "Public-Lines: 3");
    assert_actionable(
        &corrupt_ppk,
        &decode_error_of(&corrupt_ppk, None),
        false,
        "export it from PuTTYgen",
    );
    // base64 主体损坏(终端复制插空格、未走归一化的原始文本)。
    let mut lines: Vec<&str> = OPENSSH_ED25519_PLAIN.lines().collect();
    let mut second = lines[1].to_string();
    second.insert(20, ' ');
    lines[1] = &second;
    let spaced_body = lines.join("\n");
    assert_actionable(
        &spaced_body,
        &decode_error_of(&spaced_body, None),
        false,
        "not valid base64",
    );
    // 兜底:未知错误仍保留原文,只加一句说明。
    let junk_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    assert_actionable(
        junk_key,
        &decode_error_of(junk_key, None),
        false,
        "the key could not be decoded",
    );
}

#[test]
fn valid_keys_still_decode_after_normalization() {
    assert!(decode_secret_key(&normalize_private_key_text(OPENSSH_ED25519_PLAIN), None).is_ok());
    assert!(decode_secret_key(
        &normalize_private_key_text(OPENSSH_ED25519_ENCRYPTED),
        Some(ENCRYPTED_TEST_PASSPHRASE)
    )
    .is_ok());
    assert!(decode_secret_key(&normalize_private_key_text(PPK3_ED25519_PLAIN), None).is_ok());
    assert!(decode_secret_key(
        &normalize_private_key_text(PPK3_ED25519_ENCRYPTED),
        Some("123")
    )
    .is_ok());
    // russh 0.62 起支持 SEC1 传统 EC PEM，不再作为解码失败场景。
    assert!(decode_secret_key(&normalize_private_key_text(EC_SEC1_PEM), None).is_ok());
    assert!(!looks_like_public_key(OPENSSH_ED25519_PLAIN));
    assert!(looks_like_public_key(ED25519_PUBLIC_ONELINER));
}

#[tokio::test]
async fn pasted_key_content_wins_over_key_path() {
    // 路径指向不存在的文件也能取到内容：content 非空时不碰文件系统。
    let connection = key_connection(
        "/definitely/missing/id_test",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----\n",
    );
    let text = resolve_private_key_text(&connection).await.unwrap();
    assert!(text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
    assert!(text.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
}

#[tokio::test]
async fn key_path_fallback_reads_and_normalizes_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("crlf_key");
    std::fs::write(
        &path,
        "-----BEGIN OPENSSH PRIVATE KEY-----\r\nbody\r\n-----END OPENSSH PRIVATE KEY-----\r\n",
    )
    .unwrap();
    let connection = key_connection(&path.display().to_string(), "");
    let text = resolve_private_key_text(&connection).await.unwrap();
    assert!(text.contains("\nbody\n"));
    assert!(!text.contains('\r'));
}

#[tokio::test]
async fn missing_key_without_content_reports_the_path() {
    let connection = key_connection("/definitely/missing/id_test", "");
    let error = resolve_private_key_text(&connection).await.unwrap_err();
    assert!(error.contains("Failed to read SSH private key"), "{error}");
}

// —— F1: 断点续传（spool meta / resume 校验 / resumable 扫描）———

fn temp_transfer_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dbx-ssh-resume-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn spool_fixture(dir: &Path, task_id: &str, remote_path: &str, size: u64, received: u64) {
    std::fs::write(
        dir.join(format!("upload-{task_id}.part")),
        vec![b'x'; received as usize],
    )
    .unwrap();
    write_upload_meta(
        &dir.join(format!("upload-{task_id}.json")),
        &json!({ "remotePath": remote_path, "size": size }),
    )
    .unwrap();
}

#[test]
fn upload_meta_roundtrips_and_rejects_corruption() {
    let dir = temp_transfer_dir();
    let path = dir.join("upload-t1.json");
    write_upload_meta(&path, &json!({ "remotePath": "/srv/a.bin", "size": 9 })).unwrap();
    let meta = read_upload_meta(&path).unwrap();
    assert_eq!(meta["remotePath"], "/srv/a.bin");
    assert_eq!(meta["size"], 9);
    std::fs::write(&path, "{broken").unwrap();
    assert!(read_upload_meta(&path).is_none());
    assert!(read_upload_meta(&dir.join("missing.json")).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// T2d 字段类型错乱矩阵：断电/并发写坏/被外部工具改写的 meta 不得让
/// resume 接受错误语义。真实语义（实现决定断言）：
/// - `read_upload_meta` 只保证"能解析成 JSON 就返回"——数组/字符串
///   类型的 size 都能读出值，防线在读取方的 `as_str`/`as_u64`；
/// - `open_resume_spool` 对类型错乱字段一律拒绝（None/不匹配 → Err），
///   resume 永远不会把字符串 size 当成 0 或静默通过；
/// - 截断 JSON 连解析都不过，直接 None。
#[test]
fn upload_meta_field_corruption_is_rejected_not_misread() {
    use serde_json::Value;
    let dir = temp_transfer_dir();
    let meta_with = |text: &str, name: &str| {
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        read_upload_meta(&path)
    };

    // size 是字符串："9" ≠ 9（u64），resume 必须拒绝而不是宽容转换。
    let stringy = meta_with(
        r#"{"remotePath":"/srv/a.bin","size":"9"}"#,
        "upload-t-str.json",
    )
    .unwrap();
    assert_eq!(stringy.get("size").and_then(Value::as_u64), None);
    let runtime = SshRuntime::new(dir.clone());
    std::fs::write(dir.join("upload-t-str.part"), b"xxxx").unwrap();
    assert!(runtime.open_resume_spool("t-str", "/srv/a.bin", 9).is_err());

    // offset 字段错乱（负数/字符串）：当前实现把 offset 放在二进制
    // 分块头部（BE u64），meta 里出现该字段属于垃圾数据，读取方忽略
    // 它即可——断言 meta 仍能解析且不会被任何字段误升级为合法 resume。
    let negative = meta_with(
        r#"{"remotePath":"/srv/a.bin","size":9,"offset":-4}"#,
        "upload-t-neg.json",
    )
    .unwrap();
    assert_eq!(negative.get("offset").and_then(Value::as_u64), None);
    // size 为负数同理：JSON 负数不满足 as_u64。
    let neg_size = meta_with(
        r#"{"remotePath":"/srv/a.bin","size":-9}"#,
        "upload-t-negsize.json",
    )
    .unwrap();
    assert_eq!(neg_size.get("size").and_then(Value::as_u64), None);

    // meta 是 JSON 数组而非对象：解析成功但 as_str/as_u64 全部落空，
    // resumable 扫描与 resume 校验都必须跳过/拒绝。
    let array = meta_with(r#"["/srv/a.bin",9]"#, "upload-t-arr.json").unwrap();
    assert!(array.is_array());
    assert_eq!(array.get("remotePath"), None);
    std::fs::write(dir.join("upload-t-arr.part"), b"xxxx").unwrap();
    assert!(runtime.open_resume_spool("t-arr", "/srv/a.bin", 9).is_err());

    // 截断 JSON（写一半断电）：连解析都不过，read_upload_meta 返回
    // None，resumable 扫描直接跳过。
    assert!(meta_with(r#"{"remotePath":"/srv/a.bin","size"#, "upload-t-trunc.json").is_none());
    // resumable 扫描同样只收健康 meta：上述四种坏件全部不出现在清单。
    std::fs::write(dir.join("upload-t-negsize.part"), b"xxxx").unwrap();
    std::fs::write(dir.join("upload-t-trunc.part"), b"xxxx").unwrap();
    let tasks = resumable_uploads_from(&dir, &[]);
    assert!(
        tasks.is_empty(),
        "corrupted metas must not resurface: {tasks:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn resume_spool_validation_matches_meta() {
    let dir = temp_transfer_dir();
    // SshRuntime's transfer spool lives under <data_dir>/transfers.
    let transfer_dir = dir.join("transfers");
    std::fs::create_dir_all(&transfer_dir).unwrap();
    let runtime = SshRuntime::new(dir.clone());
    spool_fixture(&transfer_dir, "t1", "/srv/a.bin", 100, 40);
    // Matching request resumes at the spooled length.
    let (path, offset) = runtime.open_resume_spool("t1", "/srv/a.bin", 100).unwrap();
    assert_eq!(offset, 40);
    assert!(path.ends_with("upload-t1.part"));
    // Mismatched size / remote path / missing meta are refused.
    assert!(runtime.open_resume_spool("t1", "/srv/a.bin", 99).is_err());
    assert!(runtime
        .open_resume_spool("t1", "/srv/other.bin", 100)
        .is_err());
    assert!(runtime
        .open_resume_spool("gone", "/srv/a.bin", 100)
        .is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn resumable_scan_lists_only_live_pending_uploads() {
    let dir = temp_transfer_dir();
    let transfer_dir = dir.join("transfers");
    std::fs::create_dir_all(&transfer_dir).unwrap();
    spool_fixture(&transfer_dir, "t-resume", "/srv/a.bin", 100, 40);
    spool_fixture(&transfer_dir, "t-live", "/srv/b.bin", 100, 10);
    // Empty spool, oversized spool, and meta-less files are skipped.
    spool_fixture(&transfer_dir, "t-empty", "/srv/c.bin", 100, 0);
    spool_fixture(&transfer_dir, "t-over", "/srv/d.bin", 10, 40);
    std::fs::write(transfer_dir.join("upload-t-nometa.part"), b"data").unwrap();
    std::fs::write(transfer_dir.join("upload-t-nospool.json"), "{}").unwrap();
    let tasks = resumable_uploads_from(&transfer_dir, &["t-live".to_string()]);
    assert_eq!(tasks.len(), 1, "only t-resume qualifies: {tasks:?}");
    assert_eq!(tasks[0]["taskId"], "t-resume");
    assert_eq!(tasks[0]["remotePath"], "/srv/a.bin");
    assert_eq!(tasks[0]["fileName"], "a.bin");
    assert_eq!(tasks[0]["size"], 100);
    assert_eq!(tasks[0]["resumableBytes"], 40);
    // A missing transfer dir yields an empty list, not an error.
    assert!(resumable_uploads_from(Path::new("/nonexistent-dbx-ssh"), &[]).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// 启动清扫（评审 H-2/L-2）：下载侧临时件整目录清空、上传孤儿 meta 与
// 可再生的 .gz 清除、健康续传态（.part+.json）原样保留。
#[test]
fn sweep_stale_transfer_temps_keeps_resumable_spools_only() {
    let dir = temp_transfer_dir();
    let transfer_dir = dir.join("transfers");
    let downloads = transfer_dir.join("downloads");
    std::fs::create_dir_all(&downloads).unwrap();
    // 下载侧：不可续传，全部清。
    std::fs::write(downloads.join("download-x.part"), b"p").unwrap();
    std::fs::write(downloads.join("download-x.part.gz"), b"g").unwrap();
    std::fs::write(downloads.join("download-x.plain"), b"l").unwrap();
    std::fs::write(downloads.join("tree-x.tgz"), b"t").unwrap();
    std::fs::create_dir_all(downloads.join("stale-sub")).unwrap();
    // 上传侧：健康续传态保留；孤儿 meta 与无主 .gz 清除；超龄 spool
    // 连同 meta 回收（7 天 TTL，评审 H-2 后续）。
    std::fs::write(transfer_dir.join("upload-keep.part"), b"data").unwrap();
    std::fs::write(transfer_dir.join("upload-keep.json"), "{}").unwrap();
    std::fs::write(transfer_dir.join("upload-keep.part.gz"), b"gz").unwrap();
    std::fs::write(transfer_dir.join("upload-orphan.json"), "{}").unwrap();
    std::fs::write(transfer_dir.join("upload-orphan.part.gz"), b"gz").unwrap();
    std::fs::write(transfer_dir.join("upload-aged.part"), b"data").unwrap();
    std::fs::write(transfer_dir.join("upload-aged.json"), "{}").unwrap();
    let aged = std::fs::OpenOptions::new()
        .append(true)
        .open(transfer_dir.join("upload-aged.part"))
        .unwrap();
    aged.set_modified(
        std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 60 * 60),
    )
    .unwrap();
    drop(aged);
    sweep_stale_transfer_temps(&transfer_dir);
    assert!(
        std::fs::read_dir(&downloads).unwrap().next().is_none(),
        "download temps must be swept"
    );
    assert!(transfer_dir.join("upload-keep.part").exists());
    assert!(transfer_dir.join("upload-keep.json").exists());
    assert!(!transfer_dir.join("upload-keep.part.gz").exists());
    assert!(!transfer_dir.join("upload-orphan.json").exists());
    assert!(!transfer_dir.join("upload-orphan.part.gz").exists());
    assert!(!transfer_dir.join("upload-aged.part").exists());
    assert!(!transfer_dir.join("upload-aged.json").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 连接表单的 sudo_source 三选一决定生效的全局配置：off 从不提升；
/// custom 只沿用工作台绑定（0.4.x 兼容）；global 先按表单引用解析，
/// 再回落绑定；引用无法解析时退化为无配置而不是失败连接。
#[test]
fn effective_sudo_profile_follows_declared_source() {
    let parse = |external_config: Value| {
        StoredConnection::from_lifecycle_params(&serde_json::json!({
            "connection": {
                "id": "conn-src",
                "host": "example.com",
                "port": 22,
                "username": "user",
                "password": "login",
                "external_config": external_config
            }
        }))
        .unwrap()
    };
    let mut store = sudo_profiles::SudoProfileStore::default();
    let (profile, _) = sudo_profiles::save_profile(
        &mut store,
        &serde_json::json!({ "name": "ops", "sudoPassword": "p" }),
    )
    .unwrap();
    store
        .bindings
        .insert("conn-src".to_string(), profile.id.clone());

    let off = parse(serde_json::json!({ "sudo_source": "off" }));
    assert!(effective_sudo_profile(&off, &store).is_none());

    let custom = parse(serde_json::json!({ "sudo_source": "custom" }));
    assert_eq!(
        effective_sudo_profile(&custom, &store).unwrap().id,
        profile.id
    );

    let global_ref = parse(serde_json::json!({ "sudo_source": "global", "sudo_profile": "ops" }));
    assert_eq!(
        effective_sudo_profile(&global_ref, &store).unwrap().id,
        profile.id
    );
    let global_empty = parse(serde_json::json!({ "sudo_source": "global" }));
    assert_eq!(
        effective_sudo_profile(&global_empty, &store).unwrap().id,
        profile.id
    );

    // 引用未知配置时回落绑定；绑定也移除后退化为无配置。
    let ghost = parse(serde_json::json!({ "sudo_source": "global", "sudo_profile": "ghost" }));
    assert_eq!(
        effective_sudo_profile(&ghost, &store).unwrap().id,
        profile.id
    );
    store.bindings.remove("conn-src");
    assert!(effective_sudo_profile(&ghost, &store).is_none());
}

/// Stress test: 5 MiB of continuous terminal output through the 2 MiB
/// ring buffer. The buffer must stay pinned at the cap, keep sequence
/// addressing contiguous (so replay `complete` stays exact), and hand
/// back only the newest 2 MiB.
#[test]
fn replay_buffer_stress_keeps_five_megabytes_within_the_cap() {
    const CHUNK: usize = 64 * 1024;
    const TOTAL: usize = 5 * 1024 * 1024;
    let mut replay = ReplayBuffer::default();
    let pushes = TOTAL / CHUNK;
    for index in 0..pushes {
        let mut chunk = vec![b'x'; CHUNK];
        chunk[0] = b'a' + (index % 26) as u8;
        replay.push(TerminalStream::Stdout, chunk);
        assert!(
            replay.bytes <= TERMINAL_REPLAY_LIMIT,
            "buffer exceeded the cap at push {index}"
        );
    }
    // The buffer holds exactly the newest 2 MiB, not the full 5 MiB.
    assert_eq!(replay.bytes, TERMINAL_REPLAY_LIMIT);
    let first = replay.first_sequence();
    assert_eq!(first as usize, pushes - TERMINAL_REPLAY_LIMIT / CHUNK + 1);

    let frames = replay.after(0);
    let bytes: usize = frames.iter().map(|frame| frame.data.len()).sum();
    assert_eq!(bytes, TERMINAL_REPLAY_LIMIT);
    assert_eq!(frames.first().unwrap().sequence, first);
    // Sequence addressing stays contiguous after the eviction ramp.
    for pair in frames.windows(2) {
        assert_eq!(pair[1].sequence, pair[0].sequence + 1);
    }
    assert_eq!(frames.last().unwrap().sequence, replay.sequence);
    // after(first-1) returns the whole retained tail; older queries stay
    // empty, which is what drives replay `complete == false`.
    assert_eq!(replay.after(first - 1).len(), frames.len());
    assert!(replay.after(replay.sequence).is_empty());
}

#[test]
fn transfer_paths_stay_next_to_target() {
    let (temporary, backup) = remote_transfer_paths("/home/user/file.txt", "task").unwrap();
    assert_eq!(temporary, "/home/user/.dbx-upload-task.part");
    assert_eq!(backup, "/home/user/.dbx-upload-task.backup");
}

/// T2c（Guacamole 路径矩阵）：无论目标形态如何，`.dbx-upload-<id>.part`
/// 与 `.backup` 都必须与最终目标**同目录**——原子 rename 只在同目录内
/// 可靠（跨目录 rename 会退化为 copy+unlink，或直接失败）。逐项断言
/// `.part` 路径的父目录与目标父目录一致，且不含残留尾斜杠（双斜杠
/// 会让远端 shell/SFTP 语义产生差异）。
#[test]
fn transfer_paths_anchor_in_target_directory_for_edge_targets() {
    let anchored = |target: &str, task: &str| {
        let (temporary, backup) = remote_transfer_paths(target, task).unwrap();
        assert!(backup.ends_with(&format!(".dbx-upload-{task}.backup")));
        assert!(!temporary.contains("//"), "{temporary}");
        assert!(!backup.contains("//"), "{backup}");
        temporary
    };
    // 根 `/`：rsplit_once('/') 的 parent 是空串，实现回落为 "/"，再经
    // trim_end_matches('/') 收敛为空串，最终拼成根下的隐藏临时文件。
    let root = anchored("/", "root");
    assert_eq!(root, "/.dbx-upload-root.part", "root target stays in /");
    // 目标带尾斜杠：rsplit_once 丢弃末尾空段，parent 落在 /data/dir
    // 本身——与目标真实父目录一致，原子 rename 前提成立，且不产生
    // 双斜杠（`.contains("//")` 断言兜底）。
    assert_eq!(
        anchored("/data/dir/", "trail"),
        "/data/dir/.dbx-upload-trail.part",
        "trailing slash keeps the temp in the same parent"
    );
    // `..` 段：函数入口做段级收敛（与 model::normalize_remote_path 同
    // 语义），临时件落进**解析后**的目标目录，与最终 rename 目标同目录，
    // 原子 rename 前提对遍历形态的目标同样成立。
    let dots = remote_transfer_paths("/data/a/../f.bin", "dots").unwrap();
    assert_eq!(dots.0, "/data/.dbx-upload-dots.part");
    // 多级/根级 `..`：收敛到根就停在根，绝不逃逸；相对父目录被弹空
    // （无锚定目录，落点会依赖远端 CWD）则与裸名一样显式报错。
    let dots_root = remote_transfer_paths("/data/a/../../f.bin", "dots-root").unwrap();
    assert_eq!(dots_root.0, "/.dbx-upload-dots-root.part");
    assert!(remote_transfer_paths("a/../../f.bin", "dots-collapse").is_err());
    // 目标文件名含空格/引号：文件名只影响 target 自身，不影响临时件
    // 目录选择；临时件名由 task_id（UUID）构成，天然免于引号/空格注入。
    assert_eq!(
        anchored("/data/my file\"it's\".bin", "quoted"),
        "/data/.dbx-upload-quoted.part"
    );
    assert_eq!(
        anchored("/data/quote'.bin", "single"),
        "/data/.dbx-upload-single.part"
    );
}

/// 缺父目录形态的拒绝路径：没有 `/` 的裸名没有父目录，无法落临时件，
/// 必须显式报错而不是拼出相对路径（相对路径会依赖远端 CWD，不可控）。
#[test]
fn transfer_paths_reject_parentless_targets() {
    assert!(remote_transfer_paths("bare-name.bin", "t").is_err());
}

/// `sudo/profiles/options` backs the connection form's dynamic dropdown:
/// value = profile id (what `sudo_profile` stores), label = display name,
/// sorted like the listings, and never any secret field.
#[test]
fn profile_options_expose_id_name_pairs_without_secrets() {
    let dir = std::env::temp_dir().join(format!("dbx-profile-options-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let runtime = SshRuntime::new(dir.clone());
    let mut store = sudo_profiles::SudoProfileStore::default();
    let (_, _) = sudo_profiles::save_profile(
        &mut store,
        &json!({ "name": "zeta", "sudoPassword": "secret-z" }),
    )
    .unwrap();
    let (alpha, _) = sudo_profiles::save_profile(
        &mut store,
        &json!({ "name": "alpha", "sudoPassword": "secret-a" }),
    )
    .unwrap();
    // Keyfile injection: the production save_store would probe the real
    // macOS keychain from a test; the envelope then resolves reads to the
    // same keyfile, so the runtime path below stays keychain-free too.
    sudo_profiles::save_store_with(
        &dir,
        &store,
        &crate::vault::KeyfileProvider::new(crate::vault::keyfile_path(&dir)),
    )
    .unwrap();

    let payload = runtime.profiles_options();
    let options = payload["options"].as_array().unwrap();
    assert_eq!(options.len(), 2);
    assert_eq!(options[0]["label"], json!("alpha"));
    assert_eq!(options[0]["value"], json!(alpha.id));
    assert_eq!(options[1]["label"], json!("zeta"));
    let rendered = serde_json::to_string(&payload).unwrap();
    assert!(!rendered.contains("secret-z") && !rendered.contains("secret-a"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cached_metrics_payload_marks_age_without_mutating_the_snapshot() {
    let snapshot = json!({ "loadAverage": 0.4, "network": [] });
    let payload = cached_metrics_payload(&snapshot, 1_700_000_123);
    assert_eq!(payload["loadAverage"], json!(0.4));
    assert_eq!(payload["cachedAt"], json!(1_700_000_123));
    // The stored snapshot stays clean of the marker.
    assert!(snapshot.get("cachedAt").is_none());
}

#[test]
fn metrics_snapshot_cache_serves_and_cleans_per_session() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let snapshot = json!({ "loadAverage": 1.25 });

    assert!(runtime.cached_metrics_snapshot("sess-1").is_none());

    runtime.store_metrics_snapshot("sess-1", &snapshot);
    runtime.store_metrics_snapshot("sess-2", &json!({ "loadAverage": 2.5 }));

    let served = runtime.cached_metrics_snapshot("sess-1").expect("cached");
    assert_eq!(served["loadAverage"], json!(1.25));
    assert!(served["cachedAt"].is_u64(), "cachedAt must be unix seconds");
    // Sessions are independent: the second session serves its own data.
    let other = runtime.cached_metrics_snapshot("sess-2").expect("cached");
    assert_eq!(other["loadAverage"], json!(2.5));

    // Session close semantics drop only that session's entry.
    if let Ok(mut cache) = runtime.metrics_cache.lock() {
        cache.remove("sess-1");
    }
    assert!(runtime.cached_metrics_snapshot("sess-1").is_none());
    assert!(runtime.cached_metrics_snapshot("sess-2").is_some());
}

#[test]
fn session_info_payload_carries_identity_and_liveness() {
    let endpoint = ConnectionEndpoint {
        host: "prod-01".to_string(),
        port: 2222,
        username: "ops".to_string(),
    };
    let row = session_info_payload(
        "sess-1",
        "conn-1",
        "wb-1",
        true,
        true,
        true,
        90,
        1_700_000_123,
        "private-key",
        &endpoint,
        false,
    );
    assert_eq!(row["recording"], false);
    assert_eq!(row["sessionId"], json!("sess-1"));
    assert_eq!(row["connectionId"], json!("conn-1"));
    assert_eq!(row["workbenchId"], json!("wb-1"));
    assert_eq!(row["readOnly"], json!(true));
    assert_eq!(row["connected"], json!(true));
    assert_eq!(row["sudoKeepalive"], json!(true));
    assert_eq!(row["terminalKeepaliveSecs"], json!(90));
    assert_eq!(row["createdAt"], json!(1_700_000_123));
    assert_eq!(row["authMethod"], json!("private-key"));
    assert_eq!(row["host"], json!("prod-01"));
    assert_eq!(row["port"], json!(2222));
    assert_eq!(row["username"], json!("ops"));
    // No secrets leak through the inventory payload.
    let serialized = row.to_string();
    assert!(!serialized.contains("password"));
    assert!(!serialized.contains("passphrase"));
    assert!(!serialized.contains("privateKeyMaterial"));
}

#[test]
fn batch_input_payload_normalizes_newlines_and_bounds_size() {
    assert_eq!(
        SshRuntime::batch_input_payload("df -h", true),
        b"df -h\r".to_vec()
    );
    assert_eq!(
        SshRuntime::batch_input_payload("df -h", false),
        b"df -h".to_vec()
    );
    // Every newline flavour becomes one Enter.
    assert_eq!(
        SshRuntime::batch_input_payload("a\nb\r\nc\rd", true),
        b"a\rb\rc\rd\r".to_vec()
    );
    // Oversized commands are truncated, never rejected: a batch send is
    // keyboard-level input, the shell copes with long lines. The cut
    // backs off to a UTF-8 boundary instead of splitting a multibyte
    // character into invalid bytes.
    let huge = "x".repeat(300 * 1024);
    let payload = SshRuntime::batch_input_payload(&huge, true);
    assert_eq!(payload.len(), 256 * 1024 + 1);
    assert_eq!(*payload.last().unwrap(), b'\r');
    let mut wide = String::new();
    // '中' is 3 bytes; the cut lands on the 2nd byte of the final char.
    while wide.len() <= 256 * 1024 {
        wide.push('中');
    }
    let payload = SshRuntime::batch_input_payload(&wide, false);
    assert_eq!(payload.len(), 256 * 1024 - 1);
    assert!(std::str::from_utf8(&payload).is_ok());
}

#[test]
fn batch_input_helpers_dedupe_and_shape_rows() {
    let targets = SshRuntime::dedupe_session_ids(&[
        "b".to_string(),
        "a".to_string(),
        "b".to_string(),
        String::new(),
        "a".to_string(),
    ]);
    assert_eq!(targets, vec!["b".to_string(), "a".to_string()]);

    let ok = SshRuntime::batch_input_row("s1", None);
    assert_eq!(ok["sessionId"], json!("s1"));
    assert_eq!(ok["success"], json!(true));
    assert!(ok.get("error").is_none());
    let bad = SshRuntime::batch_input_row("s2", Some("SSH session was not found"));
    assert_eq!(bad["success"], json!(false));
    assert_eq!(bad["error"], json!("SSH session was not found"));
}

#[tokio::test]
async fn batch_terminal_input_reports_unknown_sessions_as_target_failures() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let response = runtime
        .batch_terminal_input(
            &["ghost-1".to_string(), "ghost-2".to_string()],
            "echo hi",
            true,
        )
        .await;
    assert_eq!(response["sent"], json!(0));
    assert_eq!(response["failed"], json!(2));
    let results = response["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["sessionId"], json!("ghost-1"));
    assert_eq!(results[0]["error"], json!("SSH session was not found"));
    assert_eq!(results[1]["sessionId"], json!("ghost-2"));
}

#[test]
fn sessions_list_reports_an_empty_inventory_without_sessions() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let payload = tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(runtime.list_sessions());
    assert_eq!(payload["sessions"].as_array().expect("array").len(), 0);
}

#[test]
fn directory_tracking_scripts_are_session_local() {
    let bash = directory_tracking_script("session-1", RemoteShell::Bash);
    let zsh = directory_tracking_script("session-1", RemoteShell::Zsh);
    assert!(bash.contains("PROMPT_COMMAND"));
    assert!(bash.contains("dbx-directory-ready-session-1"));
    assert!(zsh.contains("precmd_functions"));
    // Unknown shell: the script is deferred until the first toggle probes
    // the remote shell; before that it must degrade to a no-op script.
    assert_eq!(
        directory_tracking_script("session-1", RemoteShell::Unknown),
        directory_tracking_script("session-1", RemoteShell::Other)
    );
    // #10750: arming is unconditional for the session lifetime — there is
    // no teardown variant anymore, so a bash script never restores
    // PROMPT_COMMAND and a zsh script never unsets the hook function.
    assert!(!bash.contains("${__DBX_OLD_PROMPT_COMMAND-}"));
    assert!(!zsh.contains("unfunction"));
    // Both installs are guarded and idempotent: a second arm is a no-op
    // remotely instead of stacking a second emit function.
    assert!(bash.contains("[ -z \"${__DBX_CWD_ACTIVE+x}\" ]"));
    assert!(zsh.contains("[ -z \"${__DBX_CWD_ACTIVE+x}\" ]"));
    // zsh needs one extra Enter to trigger the first precmd run inside the
    // handshake window; bash's PROMPT_COMMAND fires on the next prompt.
    assert!(zsh.ends_with("\r \r"));
    assert!(bash.ends_with("\r"));
}

#[test]
fn pending_prompt_hook_flushes_only_at_a_prompt_tail() {
    assert!(!ends_with_prompt_tail(b""));
    assert!(!ends_with_prompt_tail(b"Welcome\r\n"));
    assert!(!ends_with_prompt_tail(b"Welcome\n"));
    assert!(ends_with_prompt_tail(b"Welcome\r\nnroot@host:~$ "));
    assert!(ends_with_prompt_tail(b"nroot@host:~$ "));
    // Nothing is pending: a prompt tail alone must not install anything.
    assert!(!should_flush_pending_hook(None, b"nroot@host:~$ ", true));
    // Still in rc files / MOTD: the buffer has no prompt tail yet.
    assert!(!should_flush_pending_hook(
        Some(RemoteShell::Bash),
        b"",
        true
    ));
    assert!(!should_flush_pending_hook(
        Some(RemoteShell::Bash),
        b"Welcome\r\n",
        true
    ));
    // A mid-line tail that has not been quiet yet is a packet boundary in
    // the banner, not a prompt: #287 is exactly that echo bug.
    assert!(!should_flush_pending_hook(
        Some(RemoteShell::Zsh),
        b"Welcome\r\nnroot@host:~$ ",
        false
    ));
    assert!(should_flush_pending_hook(
        Some(RemoteShell::Zsh),
        b"Welcome\r\nnroot@host:~$ ",
        true
    ));
    // A banner line split by SSH framing leaves a long unterminated tail;
    // even after a quiet tick it is not a prompt.
    let mut split_banner = b"Last login: Tue Nov 10\r\n".to_vec();
    split_banner.extend(std::iter::repeat_n(b'x', PROMPT_TAIL_LIMIT + 1));
    assert!(!should_flush_pending_hook(
        Some(RemoteShell::Bash),
        &split_banner,
        true
    ));
    assert_eq!(prompt_tail_len(&split_banner), PROMPT_TAIL_LIMIT + 1);
    assert_eq!(prompt_tail_len(b"Welcome\r\n"), 0);
    assert_eq!(prompt_tail_len(b"user@host:~$ "), "user@host:~$ ".len());
}

#[test]
fn pending_prompt_hook_is_written_exactly_once_across_ready_then_type() {
    let mut pending = Some(RemoteShell::Bash);
    let mut script_writes = 0;
    // First prompt arrives and the buffer goes quiet: the ticker path
    // flushes the deferred hook (settled tail required since #287's
    // packet-framing hardening).
    if should_flush_pending_hook(pending, b"Welcome!\r\nnroot@host:~$ ", true) {
        let _ = pending.take();
        script_writes += 1;
    }
    // The user then types before another prompt: the input path only
    // installs while the slot is still occupied, so no second write.
    if pending.take().is_some() {
        script_writes += 1;
    }
    assert_eq!(script_writes, 1);
}

#[test]
fn startup_prompt_is_removed_without_touching_the_banner() {
    assert_eq!(
        strip_trailing_prompt(b"Welcome!\r\nroot@host:~# ".to_vec()),
        b"Welcome!\r\n".to_vec()
    );
    assert_eq!(
        strip_trailing_prompt(b"root@host:~# ".to_vec()),
        Vec::<u8>::new()
    );
    assert_eq!(
        strip_trailing_prompt(b"banner\n".to_vec()),
        b"banner\n".to_vec()
    );
    assert_eq!(strip_trailing_prompt(Vec::new()), Vec::<u8>::new());
}

#[test]
fn disconnect_reason_distinguishes_remote_exit_from_transport_loss() {
    let network = session_disconnected_event("s1", "c1", None);
    assert_eq!(network["state"], "disconnected");
    assert!(network.get("reason").is_none());
    assert_eq!(
        terminal_disconnect_state(None),
        b"ssh-transport-disconnected"
    );

    let deleted = session_disconnected_event("s1", "c1", Some("connection-disconnect"));
    assert_eq!(deleted["reason"], "connection-disconnect");
    assert_eq!(
        remote_channel_closed_reason(Some("connection-disconnect")),
        Some("connection-disconnect")
    );

    let exited = session_disconnected_event("s1", "c1", remote_channel_closed_reason(None));
    assert_eq!(exited["reason"], "remote-exit");
    assert_eq!(
        terminal_disconnect_state(remote_channel_closed_reason(None)),
        b"ssh-session-exited"
    );
}

#[test]
fn disconnect_reason_distinguishes_remote_kill_from_clean_exit() {
    // 被强杀（管理员 pkill / sshd 主动关会话）必须与「干净退出」分道：
    // SSH 协议在 shell 被信号终止时先发 exit-signal，russh 映射为
    // ChannelMsg::ExitSignal；干净退出是 exit-status。读循环据此分别
    // 记录 remote-killed / remote-exit，前端才能保留 tab 提示而不是
    // 静默关闭工作台。
    assert_eq!(
        remote_channel_exit_reason(Some(ChannelMsg::ExitSignal {
            signal_name: russh::Sig::KILL,
            core_dumped: false,
            error_message: String::new(),
            lang_tag: String::new(),
        })),
        Some("remote-killed")
    );
    assert_eq!(
        remote_channel_exit_reason(Some(ChannelMsg::ExitStatus { exit_status: 0 })),
        Some("remote-exit")
    );
    // 裸 Eof/Close（无 exit-status/exit-signal 先行）仍按干净退出对待，
    // 维持 #285 既有行为。
    assert_eq!(
        remote_channel_exit_reason(Some(ChannelMsg::Eof)),
        Some("remote-exit")
    );
    assert_eq!(remote_channel_exit_reason(None), None);

    assert_eq!(
        terminal_disconnect_state(Some("remote-killed")),
        b"ssh-session-killed"
    );
    let killed = session_disconnected_event("s1", "c1", Some("remote-killed"));
    assert_eq!(killed["reason"], "remote-killed");
}

#[test]
fn prompt_hook_installs_osc7_report_before_every_prompt() {
    // The whole point of #10750: the frontend keys the prompt-newline fix
    // off OSC 7 frames, so both shell flavors must emit exactly that
    // sequence (host + pwd, BEL-terminated) from their per-prompt hook.
    for script in [
        directory_tracking_script("s", RemoteShell::Bash),
        directory_tracking_script("s", RemoteShell::Zsh),
    ] {
        assert!(script.contains("printf '\\033]7;file://%s%s\\007'"));
    }
}

#[test]
fn interactive_shell_sessions_gate_shell_syntax_lines() {
    // Plain shell session: prompt hook and startup commands both apply.
    assert!(interactive_shell_session(None, ""));
    // A spawn-exec command session or a connection-level remote_command
    // replaces the shell — typing the hook line there would feed the
    // command's stdin instead of a shell.
    assert!(!interactive_shell_session(Some("tail -f log"), ""));
    assert!(!interactive_shell_session(None, "exec zsh"));
    // Gating mirrors the startup-commands injector so both lines share the
    // command FIFO with a consistent notion of "interactive".
    assert_eq!(
        interactive_shell_session(None, "anything"),
        startup_commands::executes_for("anything")
    );
}

#[test]
fn stream_text_decode_carries_incomplete_utf8_across_frames() {
    let mut carry: Vec<u8> = Vec::new();
    // '中' (3 字节) 被劈成 1+2 两帧：第一帧尾部残留，第二帧拼出完整字符。
    let first = decode_stream_text(&mut carry, "密码: ".as_bytes());
    assert_eq!(first, "密码: ");
    assert!(carry.is_empty());
    let bytes = "中".as_bytes();
    let part1 = decode_stream_text(&mut carry, &bytes[..1]);
    assert_eq!(part1, "");
    assert_eq!(carry, &bytes[..1]);
    let part2 = decode_stream_text(&mut carry, &bytes[1..]);
    assert_eq!(part2, "中");
    assert!(carry.is_empty());
    // 大帧（>8 字节，现实 SSH 数据帧形态）尾部残缺字符同样跨帧拼装：
    // 旧实现对 >8 的 carry 整体 lossy 清仓，会把这里劈成双 U+FFFD。
    let mut carry: Vec<u8> = Vec::new();
    let filler = "a".repeat(16);
    let mut frame = filler.clone().into_bytes();
    let han = "中".as_bytes();
    frame.extend_from_slice(&han[..1]);
    let part1 = decode_stream_text(&mut carry, &frame);
    assert_eq!(part1, filler);
    assert_eq!(carry, &han[..1]);
    let part2 = decode_stream_text(&mut carry, &han[1..]);
    assert_eq!(part2, "中");
    assert!(carry.is_empty());
    // 非法字节流不能永久滞留：按最大非法子序列立即 lossy 冲刷。
    let mut carry: Vec<u8> = Vec::new();
    let flushed = decode_stream_text(
        &mut carry,
        &[0xFF, 0xFE, 0xFD, 0xFC, 0xFB, 0xFA, 0xF9, 0xF8, 0x41],
    );
    assert!(flushed.contains('\u{FFFD}'));
    assert!(flushed.ends_with('A'));
    assert!(carry.is_empty());
    // 非法字节大帧同样不滞留：逐子序列冲刷后 carry 为空。
    let mut carry: Vec<u8> = Vec::new();
    let flushed = decode_stream_text(&mut carry, &[0xFF; 16]);
    assert_eq!(flushed, "\u{FFFD}".repeat(16));
    assert!(carry.is_empty());
}

#[test]
fn requested_session_ids_are_validated_before_registry_use() {
    // 合法：非空、白名单字符（[A-Za-z0-9._-]）、不超过 128 字节。
    assert!(valid_requested_session_id("session-1"));
    assert!(valid_requested_session_id(&"a".repeat(128)));
    // 非法：空串、白名单外字符、超长。白名单外的代表行既防路径分隔符，
    // 也防 id 进 directory_tracking_script 的单引号 shell 字面量后被闭合
    // 注入（`'`、`` ` ``、`$`）。
    assert!(!valid_requested_session_id(""));
    assert!(!valid_requested_session_id("a/b"));
    assert!(!valid_requested_session_id("it's"));
    assert!(!valid_requested_session_id("a$(reboot)b"));
    assert!(!valid_requested_session_id(&"a".repeat(129)));
}

#[test]
fn primary_session_pick_is_deterministic_not_iteration_order() {
    // HashMap iteration order is randomized per process; whichever entry
    // "comes first" must not decide where terminal-routed commands run.
    let older_first = select_primary_session(vec![
        ("1111".to_string(), 0, true),
        ("2222".to_string(), 1, true),
    ]);
    let newer_first = select_primary_session(vec![
        ("2222".to_string(), 1, true),
        ("1111".to_string(), 0, true),
    ]);
    assert_eq!(older_first.as_deref(), Some("1111"));
    assert_eq!(newer_first.as_deref(), Some("1111"));
}

#[test]
fn primary_session_pick_skips_disconnected_and_tiebreaks_by_id() {
    assert_eq!(
        select_primary_session(vec![
            ("3333".to_string(), 0, false),
            ("2222".to_string(), 1, true),
        ])
        .as_deref(),
        Some("2222")
    );
    assert_eq!(select_primary_session(Vec::new()), None);
}

#[test]
fn directory_handshake_filters_split_marker() {
    let marker = directory_tracking_marker("session-1");
    let mut filter = DirectoryHandshakeFilter::default();
    filter.begin(marker.clone());
    assert_eq!(filter.filter(b"echoed script"), None);
    let split = marker.len() / 2;
    assert_eq!(filter.filter(&marker[..split]), None);
    let mut final_frame = marker[split..].to_vec();
    final_frame.extend_from_slice(b"prompt$ ");
    assert_eq!(filter.filter(&final_frame), Some(b"prompt$ ".to_vec()));
}

#[test]
fn host_key_verdicts_map_check_results() {
    assert_eq!(
        host_key_verdict(Ok(HostKeyState::Trusted)),
        HostKeyVerdict::Trusted
    );
    assert_eq!(
        host_key_verdict(Ok(HostKeyState::Unknown)),
        HostKeyVerdict::Unknown
    );
    let changed = host_key_verdict(Err(std::io::Error::other(
        "Host key for h:22 changed (recorded at known_hosts, line 3)",
    )));
    assert!(matches!(&changed, HostKeyVerdict::Changed(message) if message.contains("line 3")));
}

#[test]
fn host_key_check_responses_carry_state_and_key_identity() {
    let trusted = host_key_check_response(&HostKeyVerdict::Trusted, "ssh-ed25519", "SHA256:abcdef");
    assert_eq!(trusted["state"], "trusted");
    assert_eq!(trusted["keyType"], "ssh-ed25519");
    assert_eq!(trusted["fingerprint"], "SHA256:abcdef");

    assert_eq!(
        host_key_check_response(&HostKeyVerdict::Unknown, "rsa", "f")["state"],
        "unknown"
    );
    // A changed key keeps the identity of the presented key so the UI
    // can show the new fingerprint next to the mismatch reason.
    let changed = host_key_check_response(
        &HostKeyVerdict::Changed("key mismatch".to_string()),
        "rsa",
        "f",
    );
    assert_eq!(changed["state"], "changed");
    assert!(
        changed.get("error").is_none(),
        "reason travels in the notice event, not the check response"
    );

    let unreachable = host_key_unreachable_response("SSH connection to h:22 timed out".to_string());
    assert_eq!(unreachable["state"], "unreachable");
    assert_eq!(unreachable["error"], "SSH connection to h:22 timed out");
}

#[test]
fn agent_terminal_mode_store_round_trips_per_connection() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    // Unknown connections read the default off.
    assert_eq!(
        runtime.agent_terminal_mode("conn-1"),
        AgentTerminalMode::Off
    );
    runtime
        .set_agent_terminal_mode("conn-1", AgentTerminalMode::parse("auto"))
        .expect("mode");
    runtime
        .set_agent_terminal_mode("conn-2", AgentTerminalMode::Strict)
        .expect("mode");
    assert_eq!(
        runtime.agent_terminal_mode("conn-1"),
        AgentTerminalMode::Auto
    );
    assert_eq!(
        runtime.agent_terminal_mode("conn-2"),
        AgentTerminalMode::Strict
    );
    assert_eq!(
        runtime.agent_terminal_mode("conn-3"),
        AgentTerminalMode::Off
    );
}

#[tokio::test]
async fn agent_mode_get_reports_mode_and_live_session_presence() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());

    // Unknown connection: degrades to off with no live session — the
    // bridge caller treats this as "stay on the silent path" instead of
    // erroring.
    let probe = runtime.agent_mode_get("conn-ghost").await.expect("probe");
    assert_eq!(probe["agentTerminalMode"], "off");
    assert_eq!(probe["hasTerminalSession"], false);

    // A mode set through the settings surface is reflected verbatim.
    runtime
        .set_agent_terminal_mode("conn-1", AgentTerminalMode::Strict)
        .expect("mode");
    let probe = runtime.agent_mode_get("conn-1").await.expect("probe");
    assert_eq!(probe["agentTerminalMode"], "strict");
    // No session was opened in this test, so presence stays false even
    // though the mode is on.
    assert_eq!(probe["hasTerminalSession"], false);
}

#[test]
fn agent_challenges_resolve_once_and_report_unknown() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());

    // Unknown / already resolved challenges are refused.
    assert!(runtime
        .resolve_agent_challenge("ghost", "approve", None, false)
        .is_err());

    // Approve delivers the (possibly edited) command once, then the
    // challenge is gone. The registry guard is dropped before each
    // resolve so the std Mutex never re-enters on the same thread.
    let (sender, receiver) = oneshot::channel();
    runtime.agent_challenges.lock().expect("challenges").insert(
        "c-1".to_string(),
        PendingChallenge {
            sender,
            connection_id: "conn-1".to_string(),
            tool: "ssh_exec".to_string(),
            command: "echo edited".to_string(),
            raised_at_ms: 0,
        },
    );
    runtime
        .resolve_agent_challenge("c-1", "approve", Some("echo edited"), false)
        .expect("resolve");
    let decision = tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(receiver)
        .expect("decision");
    assert_eq!(
        decision,
        AgentDecision::Approve {
            command: Some("echo edited".to_string())
        }
    );
    assert!(runtime
        .resolve_agent_challenge("c-1", "approve", None, false)
        .is_err());

    // Deny decisions and unknown decision names are handled too.
    let (sender, receiver) = oneshot::channel();
    runtime.agent_challenges.lock().expect("challenges").insert(
        "c-2".to_string(),
        PendingChallenge {
            sender,
            connection_id: "conn-1".to_string(),
            tool: "ssh_exec".to_string(),
            command: "echo hi".to_string(),
            raised_at_ms: 0,
        },
    );
    runtime
        .resolve_agent_challenge("c-2", "deny", None, false)
        .expect("resolve");
    let decision = tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(receiver)
        .expect("decision");
    assert_eq!(decision, AgentDecision::Deny);
    assert!(runtime
        .resolve_agent_challenge("c-2", "maybe", None, false)
        .is_err());
}

/// Reliability round 5 (churn): 500 raise→resolve cycles must leave the
/// challenge registry empty (no leak), every consumed id must stay
/// unknown afterwards (one-shot semantics survive churn), and each
/// decision must reach its waiter exactly once.
#[test]
fn agent_challenges_survive_high_volume_resolve_churn() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    const CYCLES: usize = 500;

    for index in 0..CYCLES {
        let id = format!("churn-{index}");
        let (sender, mut receiver) = oneshot::channel();
        runtime.agent_challenges.lock().expect("challenges").insert(
            id.clone(),
            PendingChallenge {
                sender,
                connection_id: "conn-1".to_string(),
                tool: "ssh_exec".to_string(),
                command: format!("echo {index}"),
                raised_at_ms: 0,
            },
        );
        // The registry never grows beyond the live challenge: raising
        // one inserts one row, resolving consumes it.
        {
            let challenges = runtime.agent_challenges.lock().expect("challenges");
            assert_eq!(
                challenges.len(),
                1,
                "challenge registry leaked at cycle {index}"
            );
        }
        let decision = if index % 3 == 0 {
            runtime
                .resolve_agent_challenge(&id, "deny", None, false)
                .expect("deny");
            AgentDecision::Deny
        } else {
            let edited = format!("echo edited-{index}");
            runtime
                .resolve_agent_challenge(&id, "approve", Some(&edited), false)
                .expect("approve");
            AgentDecision::Approve {
                command: Some(edited),
            }
        };
        // One-shot: the consumed id is unknown, and a wrong decision
        // name is still refused.
        assert!(
            runtime
                .resolve_agent_challenge(&id, "approve", None, false)
                .is_err(),
            "consumed challenge came back at cycle {index}"
        );
        assert_eq!(
            receiver.try_recv().ok(),
            Some(decision),
            "decision must reach its waiter exactly once (cycle {index})"
        );
    }
    assert!(
        runtime
            .agent_challenges
            .lock()
            .expect("challenges")
            .is_empty(),
        "challenge registry must be empty after churn"
    );

    // The MCP confirm payload bakes its own timeout at issue time: two
    // challenges raised with different budgets each carry theirs (the
    // "不追溯" contract — later changes never rewrite live payloads).
    let short = SshRuntime::mcp_confirm_challenge_payload("s", "ssh_exec", "x", None, 10);
    let long = SshRuntime::mcp_confirm_challenge_payload("l", "ssh_exec", "x", None, 600);
    assert_eq!(short["timeoutSecs"], 10);
    assert_eq!(long["timeoutSecs"], 600);
}

#[test]
fn mcp_confirm_challenge_payload_shape() {
    let payload = SshRuntime::mcp_confirm_challenge_payload(
        "ch-1",
        "ssh_exec",
        "echo hi",
        Some("conn-9"),
        120,
    );
    assert_eq!(payload["challengeId"], "ch-1");
    assert_eq!(payload["kind"], "mcp-confirm");
    assert_eq!(payload["source"], "mcp");
    assert_eq!(payload["tool"], "ssh_exec");
    assert_eq!(payload["command"], "echo hi");
    assert_eq!(payload["connectionId"], "conn-9");
    assert_eq!(payload["timeoutSecs"], 120);
    assert!(payload["requestedAt"].is_u64());

    // Without a connection reference the field is absent (optional —
    // not null) so legacy frontends keep their fallback rendering.
    let bare =
        SshRuntime::mcp_confirm_challenge_payload("ch-2", "sftp_remove", "path=/tmp/x", None, 120);
    assert!(bare.get("connectionId").is_none());
    assert_eq!(bare["kind"], "mcp-confirm");
    assert_eq!(bare["source"], "mcp");
    // An empty reference is treated as absent too.
    let blank = SshRuntime::mcp_confirm_challenge_payload("ch-3", "ssh_exec", "ls", Some(""), 120);
    assert!(blank.get("connectionId").is_none());
}

#[test]
fn agent_remember_persists_approved_and_skips_destructive() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());

    // approve + remember persists the approved command on the
    // connection's remembered list (IMPL_PLAN §2.1).
    let (sender, _receiver) = oneshot::channel();
    runtime.agent_challenges.lock().expect("challenges").insert(
        "r-1".to_string(),
        PendingChallenge {
            sender,
            connection_id: "conn-1".to_string(),
            tool: "ssh_exec".to_string(),
            command: "systemctl restart nginx".to_string(),
            raised_at_ms: 0,
        },
    );
    runtime
        .resolve_agent_challenge("r-1", "approve", Some("systemctl restart nginx"), true)
        .expect("resolve");
    assert_eq!(
        agent_approvals::list_lines(&agent_approvals::load_store(data_dir.path()), "conn-1"),
        ["systemctl restart nginx"]
    );

    // A destructive text is approved (the decision still delivers) but
    // never remembered — the D2 double lock, second half.
    let (sender, receiver) = oneshot::channel();
    runtime.agent_challenges.lock().expect("challenges").insert(
        "r-2".to_string(),
        PendingChallenge {
            sender,
            connection_id: "conn-1".to_string(),
            tool: "ssh_exec".to_string(),
            command: "rm -rf /".to_string(),
            raised_at_ms: 0,
        },
    );
    runtime
        .resolve_agent_challenge("r-2", "approve", Some("rm -rf /"), true)
        .expect("resolve");
    let decision = tokio::runtime::Runtime::new()
        .expect("tokio runtime")
        .block_on(receiver)
        .expect("decision");
    assert_eq!(
        decision,
        AgentDecision::Approve {
            command: Some("rm -rf /".to_string())
        }
    );
    assert_eq!(
        agent_approvals::list_lines(&agent_approvals::load_store(data_dir.path()), "conn-1"),
        ["systemctl restart nginx"],
        "destructive command must not join the remembered list"
    );
}

#[test]
fn agent_exec_lock_admits_one_holder_then_queues() {
    // Structural test for the per-session agent-execution lock: one
    // holder excludes a second contender and release lets it through.
    // The await-based acquisition itself (`agent_exec_guard`, held across
    // approval + run) is exercised by the container smoke's concurrent
    // pair, which needs a live PTY. `blocking_lock` is fine here — the
    // test runs outside any tokio runtime.
    let lock = Arc::new(AsyncMutex::new(()));
    let held = lock.clone();
    let guard = held.blocking_lock();
    assert!(
        lock.try_lock().is_err(),
        "a second agent command must queue behind the running one"
    );
    drop(guard);
    assert!(
        lock.try_lock().is_ok(),
        "release must admit the next agent command"
    );
}

#[test]
fn attach_target_requires_exact_workbench() {
    let sessions: Vec<(String, String, String, bool)> = vec![
        ("s-old".into(), "conn-1".into(), "wb-old".into(), true),
        ("s-new".into(), "conn-1".into(), "wb-new".into(), true),
        ("s-other".into(), "conn-2".into(), "wb-other".into(), true),
    ];
    // Exact double match wins when the workbench id is stable.
    assert_eq!(
        SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-old").as_deref(),
        Some("s-old")
    );
    // A second workbench on the same saved connection gets its own exact
    // session rather than stealing the first tab's PTY.
    assert_eq!(
        SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-new").as_deref(),
        Some("s-new")
    );
    assert_eq!(
        SshRuntime::pick_attach_target(&sessions, "conn-1", "wb-missing"),
        None
    );
    // Dead sessions never attach; other connections' sessions stay put.
    let dead: Vec<(String, String, String, bool)> =
        vec![("s-dead".into(), "conn-1".into(), "wb-old".into(), false)];
    assert_eq!(
        SshRuntime::pick_attach_target(&dead, "conn-1", "wb-new"),
        None
    );
    assert_eq!(
        SshRuntime::pick_attach_target(&sessions, "conn-3", "wb-new"),
        None
    );
}

// ===== issue #202：web 刷新后「从零 connect」路径的契约锁定 =====
//
// 背景：刷新后宿主（web 模式）不一定立即重推 connection/connect，恢复的
// 工作台会先打到 sidecar 的空连接注册表。前端按**确定的错误字符串**分类
// （isConnectionInactiveError / isSessionGoneError），这些字符串就是协议
// 的一部分——hang、静默或措辞漂移都会把工作台卡死在重试梯子上，因此逐
// 字锁定。重推 connect（store_connection）必须幂等并清扫旧注册的残留。

fn structured_error_emitter() -> PluginEmitter {
    let output: Arc<Mutex<Box<dyn std::io::Write + Send>>> =
        Arc::new(Mutex::new(Box::new(Vec::<u8>::new())));
    PluginEmitter::for_tests(output, dbx_plugin_sdk::PluginTransport::JsonLines)
}

#[tokio::test]
async fn session_ops_fail_structured_when_connection_registry_is_empty() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = Arc::new(SshRuntime::new(data_dir.path().to_path_buf()));
    assert!(!runtime.has_connection("conn-1"));

    let request: SessionOpenRequest =
        serde_json::from_value(json!({ "connectionId": "conn-1", "workbenchId": "wb-1" }))
            .expect("parse open request");
    let error = runtime
        .open_session(&request, "op-1", structured_error_emitter())
        .await
        .expect_err("open without a registered connection must fail");
    assert_eq!(error, "Connection is not active; reopen it from DBX");

    let error = runtime
        .attach_session("conn-1", "wb-1", 0, &structured_error_emitter())
        .await
        .expect_err("attach without a live session must fail");
    assert_eq!(error, "No live SSH session is attached to this workbench");

    let error = runtime
        .close_session("s-missing")
        .await
        .expect_err("close of an unknown session must fail");
    assert_eq!(error, "SSH session was not found");
}

#[test]
fn write_terminal_unknown_session_fails_structured() {
    // write_terminal 在宿主 dispatch 线程上同步执行（blocking_read），
    // 这里同样在 runtime 之外调用以锁死同一语义。
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let error = runtime
        .write_terminal("s-missing", b"ls\r".to_vec())
        .expect_err("write to an unknown session must fail");
    assert_eq!(error, "SSH session was not found or expired");
}

#[test]
fn sudo_keepalive_registration_plan_replaces_stale_entries() {
    assert_eq!(
        SshRuntime::keepalive_registration_plan(Some("s-live"), "s-live"),
        KeepaliveRegistration::ReuseExisting
    );
    assert_eq!(
        SshRuntime::keepalive_registration_plan(Some("s-dead"), "s-live"),
        KeepaliveRegistration::ReplaceStale
    );
    assert_eq!(
        SshRuntime::keepalive_registration_plan(None, "s-live"),
        KeepaliveRegistration::InsertFresh
    );
}

#[tokio::test]
async fn store_connection_is_idempotent_and_sweeps_stale_residue() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let lifecycle = |name: &str| {
        json!({
            "connection": {
                "id": "conn-1",
                "name": name,
                "host": "127.0.0.1",
                "port": 22,
                "username": "user",
                "authentication": "password",
                "password": "test-only-not-a-real-secret",
            }
        })
    };

    runtime
        .store_connection(
            crate::model::StoredConnection::from_lifecycle_params(&lifecycle("first"))
                .expect("parse connection"),
        )
        .expect("first connect registers");
    assert!(runtime.has_connection("conn-1"));

    // 残留：绑定到已死会话的 sudo 保活、孤儿会话缓存、无会话的连接级
    // remote-forward 表——普通路径由 close/disconnect 清理，重推 connect
    // 时由 sweep 兜底。
    runtime
        .sudo_keepalive
        .lock()
        .expect("keepalive registry")
        .insert(
            "conn-1".to_string(),
            SudoKeepalive {
                session_id: "dead-s".to_string(),
                task: tokio::spawn(async {}),
            },
        );
    runtime.metrics_cache.lock().expect("metrics cache").insert(
        "dead-s".to_string(),
        CachedMetrics {
            value: json!({}),
            collected_at: 0,
        },
    );
    runtime
        .compat_hinted
        .lock()
        .expect("compat hints")
        .insert("dead-s".to_string());
    runtime
        .compress_tool_probe
        .lock()
        .expect("probe cache")
        .insert("dead-s".to_string(), false);
    runtime.remote_tables.lock().expect("remote tables").insert(
        "conn-1".to_string(),
        Arc::new(RemoteForwardTable::default()),
    );

    // 同 connectionId 重复 connect：幂等替换（刷新后宿主重推凭据的路径）。
    runtime
        .store_connection(
            crate::model::StoredConnection::from_lifecycle_params(&lifecycle("second"))
                .expect("parse connection"),
        )
        .expect("replayed connect is idempotent");
    assert!(runtime.has_connection("conn-1"), "registry must stay live");

    assert!(
        !runtime
            .sudo_keepalive
            .lock()
            .expect("keepalive registry")
            .contains_key("conn-1"),
        "keepalive bound to a dead session must be swept"
    );
    assert!(
        !runtime
            .metrics_cache
            .lock()
            .expect("metrics cache")
            .contains_key("dead-s"),
        "orphan metrics snapshot must be swept"
    );
    assert!(
        !runtime
            .compat_hinted
            .lock()
            .expect("compat hints")
            .contains("dead-s"),
        "orphan compat hint must be swept"
    );
    assert!(
        !runtime
            .compress_tool_probe
            .lock()
            .expect("probe cache")
            .contains_key("dead-s"),
        "orphan probe result must be swept"
    );
    assert!(
        !runtime
            .remote_tables
            .lock()
            .expect("remote tables")
            .contains_key("conn-1"),
        "connection-scoped remote-forward table without a live session must be swept"
    );
}

// ===== issue #108：堡垒机 MFA（keyboard-interactive）行为锁定 =====
//
// 登录期 keyboard-interactive 由 `authenticate_keyboard_interactive` 驱动：
// 最多 KEYBOARD_INTERACTIVE_MAX_ROUNDS 轮，每轮逐 prompt 分类应答（密码 /
// OTP / 组合，见 exec.rs `keyboard_interactive_answers` 的既有测试）；分类
// 不出的 prompt 用 challenge 上下文兜底，仍为空的答案弹结构化一次性输入
// 对话框（`request_keyboard_interactive_answer`），绝不是在 PTY 里瞎敲。
// 以下三个纯助手是该链路的用户可见面——逐字锁定（堡垒机排障依赖这些文案
// 的稳定性，且 sanitize 保证服务器可控文本进不了 UI 注入面）。

#[test]
fn keyboard_interactive_round_budget_is_bounded() {
    // 防御性锁定：服务器循环重问时必须有确定性失败，而不是无限轮询；
    // 静默改动这个预算会改变堡垒机（koko MFA 多轮）的登录语义。
    assert_eq!(KEYBOARD_INTERACTIVE_MAX_ROUNDS, 4);
}

#[test]
fn keyboard_interactive_guidance_explains_unanswered_and_rejected() {
    // 没有回答：指引配置 TOTP 种子 / OTP 提示词（Quick Sudo 2FA 设置）。
    let unanswered = keyboard_interactive_guidance(&["\"[OTP Code]: \"".to_string()], false);
    assert!(unanswered.contains("the server asked for"), "{unanswered}");
    assert!(unanswered.contains("nothing was answered"), "{unanswered}");
    assert!(unanswered.contains("TOTP secret"), "{unanswered}");

    // 回答被拒：不再引导去配置（已配置但服务器拒收），只报拒绝事实。
    let rejected = keyboard_interactive_guidance(&["\"Password: \"".to_string()], true);
    assert!(
        rejected.contains("rejected the submitted answer"),
        "{rejected}"
    );
    assert!(!rejected.contains("TOTP secret"), "{rejected}");

    // 空提问列表：不追加任何子句（连接错误保持精简）。
    assert_eq!(keyboard_interactive_guidance(&[], false), "");
}

#[test]
fn keyboard_interactive_manual_challenge_dedupes_and_sanitizes() {
    // 服务器可控文本：ANSI 转义剥离（着色 prompt 还原成纯文本，转义序列
    // 进不了对话框）、重复部分去重（koko 的 instructions 与 prompt 常语义
    // 重复）、空输入为空串。
    let challenge = keyboard_interactive_manual_challenge(
        "Please Enter MFA Code.",
        "\u{1b}[1m[OTP Code]: \u{1b}[0m",
    );
    assert!(challenge.contains("Please Enter MFA Code."), "{challenge}");
    // normalize 会对每段 trim，行尾空格被剥掉是既有归一化语义。
    assert!(challenge.contains("[OTP Code]:"), "{challenge}");
    assert!(!challenge.contains('\u{1b}'), "{challenge}");

    let deduped = keyboard_interactive_manual_challenge("Same line.", "Same line.");
    assert_eq!(deduped, "Same line.");
    assert_eq!(keyboard_interactive_manual_challenge("  ", "\t"), "");
}

#[test]
fn challenge_display_text_dedupes_seen_wording() {
    let mut seen: Vec<String> = Vec::new();
    let first = challenge_display_text("Please Enter MFA Code.", &seen);
    assert_eq!(first.as_deref(), Some("Please Enter MFA Code."));
    seen.push(first.expect("first display"));
    // 同一段文案第二次出现（instructions 与 prompt 重复）不再上屏。
    assert_eq!(
        challenge_display_text("Please Enter MFA Code.", &seen),
        None
    );
    // 空文案与纯控制字符文案都不产生展示片段。
    assert_eq!(challenge_display_text("", &[]), None);
    assert_eq!(challenge_display_text("\u{1b}\u{7}", &[]), None);
}

#[tokio::test]
async fn agent_exec_guard_reports_unknown_sessions() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    let error = runtime
        .agent_exec_guard("no-such-session")
        .await
        .expect_err("unknown session must be refused");
    assert!(
        error.contains("not found") || error.contains("expired"),
        "unexpected error: {error}"
    );
}

/// `sftp/transfer/history`: live registry rows win over the persisted
/// rows of the same task (fresh progress, inherited start context),
/// stale persisted `running` rows from a dead sidecar surface as
/// failed, and the result is newest-first with limit/session filtering.
#[test]
fn transfer_history_merges_live_rows_over_persisted_ones() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let root = data_dir.path();
    transfer_history::record_transition(
        root,
        &json!({
            "taskId": "t-done", "sessionId": "s1", "connectionId": "c1",
            "direction": "download", "fileName": "done.bin", "size": 4,
            "transferred": 4, "status": "completed",
            "startedAt": 1_000, "finishedAt": 2_000,
        }),
    )
    .unwrap();
    transfer_history::record_transition(
        root,
        &json!({
            "taskId": "t-live", "sessionId": "s1", "connectionId": "c1",
            "direction": "download", "fileName": "live.bin", "size": 9,
            "transferred": 0, "status": "running",
            "startedAt": 3_000, "finishedAt": null,
        }),
    )
    .unwrap();
    transfer_history::record_transition(
        root,
        &json!({
            "taskId": "t-stale", "sessionId": "s1", "connectionId": "c1",
            "direction": "upload", "fileName": "stale.bin", "size": 2,
            "transferred": 0, "status": "running",
            "startedAt": 500, "finishedAt": null,
        }),
    )
    .unwrap();
    let runtime = SshRuntime::new(root.to_path_buf());
    runtime.downloads.lock().unwrap().insert(
        "t-live".to_string(),
        DownloadState {
            session_id: "s1".to_string(),
            remote_path: "/live.bin".to_string(),
            file_name: "live.bin".to_string(),
            size: 9,
            next_offset: 5,
            sink: None,
            tree: None,
            sudo_tmp: None,
            latin1: false,
            throttle: Throttle::new(0),
            progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
            compression: CompressionMode::None,
            ready: false,
            serving_plain: false,
            staged_plain: None,
            gz_staging: None,
            remote_temp: None,
            final_dir: None,
            overwrite: false,
            read_handle: Arc::new(AsyncMutex::new(None)),
            raw_client: Arc::new(AsyncMutex::new(None)),
            expand_lzpack: false,
            prefetch: Arc::new(AsyncMutex::new(None)),
            multistream: None,
        },
    );
    let no_connection = |_: &str| String::new();
    let tasks = runtime
        .build_transfer_history(Some("s1"), 50, &no_connection)
        .unwrap();
    let tasks = tasks.get("tasks").and_then(Value::as_array).unwrap();
    assert_eq!(tasks.len(), 3);
    // Newest first: the live task (startedAt 3000) leads.
    assert_eq!(tasks[0]["taskId"], "t-live");
    assert_eq!(tasks[0]["transferred"], 5, "live progress wins");
    assert_eq!(tasks[0]["status"], "running");
    assert_eq!(tasks[0]["startedAt"], 3_000, "start context is inherited");
    assert_eq!(tasks[1]["taskId"], "t-done");
    assert_eq!(tasks[1]["status"], "completed");
    // The stale row has no live counterpart: dead-sidecar downgrade (D7).
    assert_eq!(tasks[2]["taskId"], "t-stale");
    assert_eq!(tasks[2]["status"], "failed");
    assert!(
        tasks[2]["error"]
            .as_str()
            .unwrap()
            .contains("sidecar restart"),
        "unexpected error: {}",
        tasks[2]["error"]
    );
    // Limit caps the merged list after sorting.
    let limited = runtime
        .build_transfer_history(Some("s1"), 1, &no_connection)
        .unwrap();
    assert_eq!(limited["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(limited["tasks"][0]["taskId"], "t-live");
    // Unknown sessions yield an empty list.
    let other = runtime
        .build_transfer_history(Some("s2"), 50, &no_connection)
        .unwrap();
    assert!(other["tasks"].as_array().unwrap().is_empty());
}

/// Issue #18: the history order must be a total order — newest first by
/// `startedAt`, ties broken by `taskId`, live rows without a start
/// record on top — so repeated polls cannot reshuffle equal/missing
/// keys into different positions.
#[test]
fn transfer_history_order_is_total_and_stable() {
    let rows = vec![
        json!({ "taskId": "b", "startedAt": 2_000 }),
        json!({ "taskId": "a", "startedAt": 2_000 }),
        json!({ "taskId": "z" }),
        json!({ "taskId": "c", "startedAt": 3_000 }),
        json!({ "taskId": "y" }),
        json!({ "taskId": "a-old", "startedAt": 1 }),
    ];
    let mut sorted = rows.clone();
    sorted.sort_by(compare_history_rows);
    let ids: Vec<&str> = sorted
        .iter()
        .map(|task| task["taskId"].as_str().unwrap())
        .collect();
    // Missing timestamps lead (live rows), taskId tiebreak; then newest
    // started first, again tie-broken by taskId.
    assert_eq!(ids, vec!["y", "z", "c", "a", "b", "a-old"]);
    // Any permutation of the same rows yields the identical order —
    // the property the previous `startedAt`-only sort lacked.
    for start in 0..rows.len() {
        let mut rotated = rows.clone();
        rotated.rotate_left(start);
        rotated.sort_by(compare_history_rows);
        let rotated_ids: Vec<&str> = rotated
            .iter()
            .map(|task| task["taskId"].as_str().unwrap())
            .collect();
        assert_eq!(rotated_ids, ids);
    }
}

/// Issue #18: two live downloads whose start records never reached the
/// disk (lost cross-process write) used to render in HashMap iteration
/// order — a different order on every sidecar restart. The taskId
/// tiebreak makes the merged history deterministic.
#[test]
fn transfer_history_live_rows_without_start_context_sort_by_task_id() {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let runtime = SshRuntime::new(data_dir.path().to_path_buf());
    for task_id in ["t-zulu", "t-alpha", "t-mike"] {
        runtime.downloads.lock().unwrap().insert(
            task_id.to_string(),
            DownloadState {
                session_id: "s1".to_string(),
                remote_path: format!("/{task_id}.bin"),
                file_name: format!("{task_id}.bin"),
                size: 8,
                next_offset: 0,
                sink: None,
                tree: None,
                sudo_tmp: None,
                latin1: false,
                throttle: Throttle::new(0),
                progress_throttle: crate::progress_throttle::ProgressThrottle::default(),
                // sudo 车道不参与压缩通道（M33）：远端临时件机制独立。
                compression: CompressionMode::None,
                ready: false,
                serving_plain: false,
                staged_plain: None,
                gz_staging: None,
                remote_temp: None,
                final_dir: None,
                overwrite: false,
                read_handle: Arc::new(AsyncMutex::new(None)),
                raw_client: Arc::new(AsyncMutex::new(None)),
                expand_lzpack: false,
                prefetch: Arc::new(AsyncMutex::new(None)),
                multistream: None,
            },
        );
    }
    let no_connection = |_: &str| String::new();
    let tasks = runtime
        .build_transfer_history(Some("s1"), 50, &no_connection)
        .unwrap();
    let ids: Vec<String> = tasks["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["taskId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["t-alpha", "t-mike", "t-zulu"]);
}

/// Auto 按序回退的纯逻辑契约：固定顺序、阶段门控、全失败汇总。真实
/// 凭据流（密码/私钥/KI/agent）复用既有 helper，端到端由既有认证测试
/// 覆盖；这里只锁定编排器自身的决策面。
mod auto_auth {
    use super::*;

    #[test]
    fn auto_order_contract_lists_methods_in_fallback_order() {
        // 对标 Tabby 的认证依序回退：密码 → 私钥 → 交互式 KI → agent。
        assert_eq!(
            AUTO_AUTH_ORDER,
            ["password", "private-key", "keyboard-interactive", "agent"]
        );
    }

    #[test]
    fn auto_stage_skip_gates_password_on_config_and_advertised_methods() {
        // 无密码配置：跳过，无论服务器是否广告 password 方法。
        assert_eq!(
            auto_stage_skip("password", false, true, true).as_deref(),
            Some("no password configured for this connection")
        );
        // 有密码但服务器未广告 password 方法：不发送密码，跳过。
        assert_eq!(
            auto_stage_skip("password", true, false, true).as_deref(),
            Some("server does not advertise password authentication")
        );
        // 有密码且已广告：尝试。
        assert_eq!(auto_stage_skip("password", true, true, true), None);
    }

    #[test]
    fn auto_stage_skip_gates_private_key_on_configured_material() {
        assert_eq!(
            auto_stage_skip("private-key", true, true, false).as_deref(),
            Some("no private key configured for this connection")
        );
        // 路径或粘贴内容任一存在即算已配置。
        assert_eq!(auto_stage_skip("private-key", false, false, true), None);
    }

    #[test]
    fn auto_stage_skip_never_gates_interactive_or_agent_stages() {
        // KI 与 agent 没有本地前置凭据：提问可交互作答，agent 套接字
        // 来自环境（挑战流中立——Auto 不改变 host key / 2FA 交互行为）。
        for method in ["keyboard-interactive", "agent"] {
            assert_eq!(
                auto_stage_skip(method, false, false, false),
                None,
                "{method} must never be skipped by local prerequisites"
            );
        }
    }

    #[test]
    fn auto_auth_failure_message_aggregates_attempts_in_order() {
        let attempts = vec![
            auto_auth_skip(
                "password",
                "no password configured for this connection".to_string(),
            ),
            auto_auth_attempt("private-key", "rejected by the server".to_string()),
            auto_auth_attempt(
                "keyboard-interactive",
                "SSH keyboard-interactive authentication was rejected".to_string(),
            ),
            auto_auth_attempt("agent", "no SSH Agent identity was accepted".to_string()),
        ];
        // 汇总保持固定顺序，逐方式带原因；skipped 有显式标记。
        assert_eq!(
            auto_auth_failure_message(&attempts),
            "SSH authentication failed in Auto mode, tried in order — \
                 password (skipped: no password configured for this connection); \
                 private-key (rejected by the server); \
                 keyboard-interactive (SSH keyboard-interactive authentication was rejected); \
                 agent (no SSH Agent identity was accepted)"
        );
    }

    #[test]
    fn auto_auth_failure_message_without_attempts_names_the_chain() {
        assert_eq!(
            auto_auth_failure_message(&[]),
            "SSH authentication failed in Auto mode: no method could be attempted"
        );
    }

    #[test]
    fn merge_auto_auth_attempt_keeps_one_entry_per_method_in_try_order() {
        // 双重 KI 场景（private-key partial-success 续答失败 + agent 续答
        // 失败 + 专属 KI 阶段 skip）：同 method 必须合并 detail 而不是重复
        // push，否则"每方法一条、按首试顺序"的不变量（authenticate_auto
        // 末尾的 debug_assert_eq）在 debug 构建必假，聚合消息也会把同一
        // 方法列两遍。
        let mut attempts = Vec::new();
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("password", "rejected by the server".to_string()),
        );
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("keyboard-interactive", "KI round one rejected".to_string()),
        );
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_skip(
                "keyboard-interactive",
                "already answered as the MFA follow-up".to_string(),
            ),
        );
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("keyboard-interactive", "KI round two rejected".to_string()),
        );
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("agent", "no SSH Agent identity was accepted".to_string()),
        );

        let methods: Vec<_> = attempts.iter().map(|attempt| attempt.method).collect();
        assert_eq!(methods, ["password", "keyboard-interactive", "agent"]);
        let ki = &attempts[1];
        assert!(
            !ki.skipped,
            "an actual attempt clears the earlier skip mark"
        );
        assert_eq!(
            ki.detail,
            "KI round one rejected; already answered as the MFA follow-up; KI round two rejected"
        );
        // authenticate_auto 末尾的顺序断言在此场景下必须还原成立。
        assert_eq!(
            attempts
                .iter()
                .map(|attempt| attempt.method)
                .collect::<Vec<_>>(),
            AUTO_AUTH_ORDER
                .iter()
                .filter(|method| attempts.iter().any(|attempt| attempt.method == **method))
                .copied()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn merge_auto_auth_attempt_appends_new_methods_in_arrival_order() {
        let mut attempts = Vec::new();
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("keyboard-interactive", "rejected".to_string()),
        );
        merge_auto_auth_attempt(
            &mut attempts,
            auto_auth_attempt("agent", "no identity".to_string()),
        );
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[1].method, "agent");
        assert!(!attempts[1].skipped);
    }

    #[test]
    fn auto_auth_attempt_helpers_mark_skip_state() {
        let skipped = auto_auth_skip("password", "reason".to_string());
        assert!(skipped.skipped);
        assert_eq!(skipped.method, "password");
        let attempted = auto_auth_attempt("agent", "detail".to_string());
        assert!(!attempted.skipped);
        assert_eq!(attempted.method, "agent");
    }
}

/// 登录期 2FA 的端到端回归（issue #17 / #30）：密码/公钥先被接受后服务器
/// 用 keyboard-interactive 问 MFA（koko 形状）。mock 服务端按 `Shape`
/// 参数化，覆盖"密码方法 + partial success"、"KI 里先密码再 MFA"、
/// "只问 MFA"、"一个合并提问"四种提问形态。
mod koko_login {
    use super::*;
    use dbx_plugin_sdk::PluginTransport;
    use russh::keys::ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey};
    use russh::server::{Auth, ChannelOpenHandle, Msg, Response, Server as _, Session};
    use russh::{Channel, ChannelId, MethodKind, MethodSet, Pty};
    use std::net::SocketAddr;

    const LOGIN_PASSWORD: &str = "jump-pw";
    const SUDO_PASSWORD: &str = "asset-pw";
    const MFA_CODE: &str = "654321";
    // 逐字取自 koko pkg/auth/mfa_option.go（mfaOptionInstruction /
    // mfaOptionQuestion，MFA 类型 otp）。
    const MFA_INSTRUCTION: &str = "Please Enter MFA Code.";
    const MFA_QUESTION: &str = "[OTP Code]: ";

    /// mock 堡垒机的认证形态。
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Shape {
        /// 开放 password 方法：密码通过后 partial success → KI 问 MFA（koko 默认）。
        PasswordThenMfa,
        /// 开放 password 方法：密码全拒（无 partial success）→ KI 仍问
        /// MFA（PAM 栈不置 partial_success 位的形状）。
        PasswordRejectedThenMfa,
        /// 只开放 keyboard-interactive：KI 第一轮问密码，第二轮问 MFA（PAM 风格）。
        KiPasswordThenMfa,
        /// 只开放 keyboard-interactive：只问 MFA（反问顺序主机）。
        KiMfaOnly,
        /// 只开放 keyboard-interactive：一个提问同时要密码与验证码。
        KiCombined,
    }

    impl Shape {
        fn allows_password_method(self) -> bool {
            matches!(
                self,
                Shape::PasswordThenMfa | Shape::PasswordRejectedThenMfa
            )
        }
    }

    /// 测试专用 Ed25519 密钥：由固定种子展开，不依赖 RNG 版本，也绝不
    /// 涉及真实私钥（仅供本机 mock 服务器与客户端握手）。
    fn test_key(seed: u8) -> russh::keys::PrivateKey {
        russh::keys::PrivateKey::from(Ed25519Keypair::from_seed(
            &[seed; Ed25519PrivateKey::BYTE_SIZE],
        ))
    }

    #[derive(Clone)]
    struct MockKoko {
        shape: Shape,
        instruction: &'static str,
        prompt: &'static str,
        answers: Arc<Mutex<Vec<String>>>,
        exec_seen: Arc<Mutex<Vec<String>>>,
    }

    impl MockKoko {
        fn new(shape: Shape, instruction: &'static str, prompt: &'static str) -> Self {
            Self {
                shape,
                instruction,
                prompt,
                answers: Arc::new(Mutex::new(Vec::new())),
                exec_seen: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    struct MockKokoSession {
        shape: Shape,
        instruction: &'static str,
        prompt: &'static str,
        answers: Arc<Mutex<Vec<String>>>,
        exec_seen: Arc<Mutex<Vec<String>>>,
        ki_round: usize,
    }

    impl russh::server::Handler for MockKokoSession {
        type Error = russh::Error;

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.exec_seen
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(data).into_owned());
            session.channel_success(channel)?;
            session.data(channel, b"/bin/bash".to_vec())?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }

        #[allow(clippy::too_many_arguments)]
        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            _col_width: u32,
            _row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::reject())
        }

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> Result<Auth, Self::Error> {
            if password != LOGIN_PASSWORD {
                return Ok(Auth::reject());
            }
            if self.shape == Shape::PasswordRejectedThenMfa {
                // 全拒形状：第一因子从未通过（无 partial success），但
                // 服务器仍把 keyboard-interactive 列为可继续的方法。
                return Ok(Auth::reject());
            }
            // koko: 第一因子通过 → PartialSuccessError，下一步
            // keyboard-interactive 问 MFA。
            let mut methods = MethodSet::empty();
            methods.push(MethodKind::KeyboardInteractive);
            Ok(Auth::Reject {
                proceed_with_methods: Some(methods),
                partial_success: true,
            })
        }

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _public_key: &russh::keys::PublicKey,
        ) -> Result<Auth, Self::Error> {
            // koko 的私钥 + MFA：公钥被接受后仍要二次认证。
            let mut methods = MethodSet::empty();
            methods.push(MethodKind::KeyboardInteractive);
            Ok(Auth::Reject {
                proceed_with_methods: Some(methods),
                partial_success: true,
            })
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            response: Option<Response<'a>>,
        ) -> Result<Auth, Self::Error> {
            let Some(mut response) = response else {
                // 开局提问：PAM 形状先问密码；合并形状一个提问问两样。
                let (instruction, prompt) = match self.shape {
                    Shape::KiPasswordThenMfa => ("Please enter your password.", "Password: "),
                    Shape::KiCombined => ("Password and MFA required", "Password: OTP Code: "),
                    _ => (self.instruction, self.prompt),
                };
                return Ok(Auth::Partial {
                    name: "jumper".into(),
                    instructions: instruction.into(),
                    prompts: vec![(prompt.into(), self.shape == Shape::KiPasswordThenMfa)].into(),
                });
            };
            let answer = response
                .next()
                .map(|bytes| String::from_utf8_lossy(bytes.as_ref()).into_owned())
                .unwrap_or_default();
            self.answers.lock().unwrap().push(answer.clone());
            self.ki_round += 1;
            match self.shape {
                // 第一轮是密码：答对后继续问 MFA。
                Shape::KiPasswordThenMfa if self.ki_round == 1 => {
                    if answer != LOGIN_PASSWORD {
                        return Ok(Auth::reject());
                    }
                    Ok(Auth::Partial {
                        name: "jumper".into(),
                        instructions: self.instruction.into(),
                        prompts: vec![(self.prompt.into(), true)].into(),
                    })
                }
                // 合并提问：一条应答里必须同时有密码与验证码。
                Shape::KiCombined => Ok(if answer == format!("{LOGIN_PASSWORD}{MFA_CODE}") {
                    Auth::Accept
                } else {
                    Auth::reject()
                }),
                _ => Ok(if answer == MFA_CODE {
                    Auth::Accept
                } else {
                    Auth::reject()
                }),
            }
        }

        async fn auth_succeeded(&mut self, _session: &mut Session) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    impl russh::server::Server for MockKoko {
        type Handler = MockKokoSession;

        fn new_client(&mut self, _peer: Option<SocketAddr>) -> Self::Handler {
            MockKokoSession {
                shape: self.shape,
                instruction: self.instruction,
                prompt: self.prompt,
                answers: self.answers.clone(),
                exec_seen: self.exec_seen.clone(),
                ki_round: 0,
            }
        }
    }

    async fn spawn_mock_koko(
        shape: Shape,
        instruction: &'static str,
        prompt: &'static str,
    ) -> (
        u16,
        Arc<Mutex<Vec<String>>>,
        Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock koko");
        let port = listener.local_addr().expect("mock koko address").port();
        let mut methods = MethodSet::empty();
        if shape.allows_password_method() {
            methods.push(MethodKind::Password);
        }
        methods.push(MethodKind::KeyboardInteractive);
        let config = Arc::new(russh::server::Config {
            methods,
            keys: vec![test_key(1)],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::from_millis(10)),
            ..Default::default()
        });
        let mut server = MockKoko::new(shape, instruction, prompt);
        let answers = server.answers.clone();
        let exec_seen = server.exec_seen.clone();
        let task = tokio::spawn(async move {
            let _ = server.run_on_socket(config, &listener).await;
        });
        (port, answers, exec_seen, task)
    }

    fn koko_connection(port: u16, secrets: Value, external: Value) -> StoredConnection {
        StoredConnection::from_lifecycle_params(&json!({
            "connection": {
                "id": "koko-login",
                "name": "koko",
                "db_type": "ssh",
                "host": "127.0.0.1",
                "port": port,
                "username": "jumper",
                "password": LOGIN_PASSWORD,
                "connection_secrets": secrets,
                "external_config": external,
            }
        }))
        .expect("parse koko connection")
    }

    fn test_runtime() -> Arc<SshRuntime> {
        // open_session 以 `self: &Arc<Self>` 接收者注册自发断开清理所需
        // 的运行时克隆，测试统一从 Arc 出发。
        let data_dir = std::env::temp_dir().join(format!("dbx-koko-e2e-{}", Uuid::new_v4()));
        Arc::new(SshRuntime::new(data_dir).with_auto_trust_keys())
    }

    fn test_emitter() -> PluginEmitter {
        let output: Arc<Mutex<Box<dyn std::io::Write + Send>>> =
            Arc::new(Mutex::new(Box::new(Vec::<u8>::new())));
        PluginEmitter::for_tests(output, PluginTransport::JsonLines)
    }

    struct ManualOtpGateway {
        answer: UserInputAnswer,
        prompts_seen: Mutex<Vec<Value>>,
    }

    impl ManualOtpGateway {
        fn submitting(code: &str) -> Self {
            Self {
                answer: UserInputAnswer {
                    action: "submit".into(),
                    value: Some(code.into()),
                },
                prompts_seen: Mutex::new(Vec::new()),
            }
        }

        fn cancelling() -> Self {
            Self {
                answer: UserInputAnswer {
                    action: "cancel".into(),
                    value: None,
                },
                prompts_seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl HostPromptGateway for ManualOtpGateway {
        fn supports_request_user_input(&self) -> bool {
            true
        }

        fn request_user_input(
            &self,
            prompt: &UserInputPrompt,
        ) -> Result<UserInputAnswer, PluginError> {
            self.prompts_seen
                .lock()
                .unwrap()
                .push(serde_json::to_value(prompt).unwrap());
            Ok(self.answer.clone())
        }
    }

    #[tokio::test]
    async fn unknown_chinese_mfa_prompt_requests_current_code_from_user() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, "请输入6位数字。", "[MFA认证]：").await;
        let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        let connection = koko_connection(
            port,
            json!({}),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
            }),
        );

        let result = runtime.connect_headless(&connection).await;
        server.abort();

        result.expect("unanswered MFA challenge must open a one-time secret prompt");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        let prompts = gateway.prompts_seen.lock().unwrap();
        assert_eq!(prompts.len(), 1, "exactly one OTP dialog is expected");
        assert_eq!(prompts[0]["echo"], false, "the OTP input must be masked");
        assert!(prompts[0]["title"]
            .as_str()
            .unwrap()
            .starts_with("动态令牌验证"));
        assert!(prompts[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("本次输入仅用于此次登录，不会保存"));
        assert!(prompts[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("请输入6位数字。"));
        assert!(prompts[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("[MFA认证]："));
    }

    #[tokio::test]
    async fn configured_totp_keeps_login_automatic_without_user_prompt() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
        let gateway = Arc::new(ManualOtpGateway::submitting("should-not-be-used"));
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
            }),
        );

        let result = runtime.connect_headless(&connection).await;
        server.abort();

        result.expect("configured TOTP must keep the existing automatic login path");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
        assert!(
            gateway.prompts_seen.lock().unwrap().is_empty(),
            "automatic TOTP must not open a redundant dialog"
        );
    }

    #[tokio::test]
    async fn cancelling_manual_mfa_prompt_fails_closed() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, "请输入6位数字。", "[MFA认证]：").await;
        let gateway = Arc::new(ManualOtpGateway::cancelling());
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        let connection = koko_connection(
            port,
            json!({}),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
            }),
        );

        let result = runtime.connect_headless(&connection).await;
        server.abort();

        assert_eq!(
            result.err().as_deref(),
            Some("SSH keyboard-interactive authentication was cancelled")
        );
        assert!(
            answers.lock().unwrap().is_empty(),
            "cancelled prompts must not send an empty or guessed answer"
        );
        assert_eq!(gateway.prompts_seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn second_terminal_session_reuses_authenticated_transport() {
        let (port, answers, _exec, server) = spawn_mock_koko(
            Shape::PasswordThenMfa,
            "Please enter 6 digits.",
            "[MFA auth]:",
        )
        .await;
        let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        let connection = koko_connection(
            port,
            json!({}),
            json!({
                "authentication": "password",
                "auth_flow_mode": "off",
            }),
        );
        runtime.store_connection(connection).unwrap();

        let first = runtime
            .open_session(
                &SessionOpenRequest {
                    connection_id: "koko-login".into(),
                    workbench_id: "workbench-1".into(),
                    reuse_authenticated_transport: false,
                    reuse_authenticated_session_id: None,
                    requested_session_id: None,
                    spawn_command: None,
                    cols: 80,
                    rows: 24,
                },
                "open-1",
                test_emitter(),
            )
            .await
            .expect("first terminal session");
        let second = runtime
            .open_session(
                &SessionOpenRequest {
                    connection_id: "koko-login".into(),
                    workbench_id: "workbench-2".into(),
                    reuse_authenticated_transport: true,
                    reuse_authenticated_session_id: first["sessionId"].as_str().map(str::to_string),
                    requested_session_id: None,
                    spawn_command: None,
                    cols: 80,
                    rows: 24,
                },
                "open-2",
                test_emitter(),
            )
            .await
            .expect("second terminal session");

        assert_eq!(
            gateway.prompts_seen.lock().unwrap().len(),
            1,
            "a second PTY on the same live connection must not ask for MFA again"
        );
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [MFA_CODE.to_string()],
            "the bastion must authenticate only the first SSH transport"
        );

        for opened in [first, second] {
            let session_id = opened["sessionId"].as_str().unwrap();
            runtime.close_session(session_id).await.unwrap();
        }
        server.abort();
    }

    #[tokio::test]
    async fn spawn_command_session_runs_on_shared_transport_with_escaped_exec() {
        // WT-4 contract: a spawnCommand open on the reused transport must
        // NOT re-authenticate (bastion MFA is answered exactly once) and
        // must exec the single-quote-wrapped `sh -c '...'` payload.
        let (port, answers, exec_seen, server) = spawn_mock_koko(
            Shape::PasswordThenMfa,
            "Please enter 6 digits.",
            "[MFA auth]:",
        )
        .await;
        let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        let connection = koko_connection(
            port,
            json!({}),
            json!({
                "authentication": "password",
                "auth_flow_mode": "off",
            }),
        );
        runtime.store_connection(connection).unwrap();

        let base = runtime
            .open_session(
                &SessionOpenRequest {
                    connection_id: "koko-login".into(),
                    workbench_id: "workbench-1".into(),
                    reuse_authenticated_transport: false,
                    reuse_authenticated_session_id: None,
                    requested_session_id: None,
                    spawn_command: None,
                    cols: 80,
                    rows: 24,
                },
                "open-base",
                test_emitter(),
            )
            .await
            .expect("base shell session");
        let spawned = runtime
            .open_session(
                &SessionOpenRequest {
                    connection_id: "koko-login".into(),
                    workbench_id: "workbench-2".into(),
                    reuse_authenticated_transport: true,
                    reuse_authenticated_session_id: base["sessionId"].as_str().map(str::to_string),
                    requested_session_id: None,
                    spawn_command: Some("htop --tree".into()),
                    cols: 80,
                    rows: 24,
                },
                "open-spawn",
                test_emitter(),
            )
            .await
            .expect("spawn command session on the shared transport");

        assert_ne!(
            spawned["sessionId"].as_str().unwrap(),
            base["sessionId"].as_str().unwrap(),
            "the command session owns its own sessionId"
        );
        assert_eq!(
            gateway.prompts_seen.lock().unwrap().len(),
            1,
            "a command session on the shared transport must not ask for MFA again"
        );
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [MFA_CODE.to_string()],
            "the bastion must authenticate only the first SSH transport"
        );
        // russh 0.62 channel requests are fire-and-forget: `exec` only
        // queues the message, so the mock server may not have handled it
        // by the time `open_session` returns. Poll briefly instead of
        // asserting immediately.
        let exec_payload = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let seen = exec_seen.lock().unwrap().clone();
                // #10750: the base shell session now arms the prompt hook,
                // which probes `$SHELL` once via exec; the spawn session
                // execs the wrapped command. The two are independent tasks
                // on the shared transport, so neither arrival order nor
                // which lands first is deterministic — wait for both.
                let has_command = seen.iter().any(|command| command == "sh -c 'htop --tree'");
                let has_probe = seen
                    .iter()
                    .any(|command| command == "printf '%s' \"$SHELL\"");
                if has_command && has_probe {
                    break seen;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the mock server must receive the exec requests");
        assert_eq!(
            exec_payload.len(),
            2,
            "exactly one shell probe (interactive session arming) and one command exec"
        );
        assert!(
            exec_payload.contains(&"sh -c 'htop --tree'".to_string()),
            "the command is wrapped as one single-quoted sh -c argument"
        );
        assert!(
            exec_payload.contains(&"printf '%s' \"$SHELL\"".to_string()),
            "the interactive base session arms its prompt hook with one $SHELL probe"
        );

        for opened in [base, spawned] {
            let session_id = opened["sessionId"].as_str().unwrap();
            // The mock exec handler closes the channel right after the
            // reply, so the spawned session's read loop may already have
            // reaped it ("SSH session was not found") — that self-cleanup
            // on command exit is the expected command-session behavior.
            let _ = runtime.close_session(session_id).await;
        }
        server.abort();
    }

    #[test]
    fn pending_copy_reservation_keeps_transport_alive_before_session_registration() {
        let uses = TransportLeaseCounter::new();
        uses.retain(); // pending copied-session open

        assert_eq!(uses.count(), 2);
        assert!(
            !uses.release(),
            "closing the source must not release a transport reserved by a pending copy"
        );
        assert_eq!(uses.count(), 1);
        assert!(
            uses.release(),
            "the final copied session owns the last transport lease"
        );
    }

    #[tokio::test]
    async fn copied_session_without_a_live_transport_does_not_reprompt_for_mfa() {
        let gateway = Arc::new(ManualOtpGateway::submitting(MFA_CODE));
        let mut runtime = test_runtime();
        Arc::get_mut(&mut runtime).unwrap().prompts = PromptBroker::with_gateway(gateway.clone());
        runtime
            .store_connection(koko_connection(
                1,
                json!({}),
                json!({
                    "authentication": "password",
                    "auth_flow_mode": "off",
                }),
            ))
            .unwrap();

        let error = runtime
            .open_session(
                &SessionOpenRequest {
                    connection_id: "koko-login".into(),
                    workbench_id: "copied-workbench".into(),
                    reuse_authenticated_transport: true,
                    reuse_authenticated_session_id: Some("missing-session".into()),
                    requested_session_id: None,
                    spawn_command: None,
                    cols: 80,
                    rows: 24,
                },
                "copy-without-source",
                test_emitter(),
            )
            .await
            .expect_err("copying without a live source must fail before authentication");

        assert!(error.contains("use New session to reconnect"));
        assert!(gateway.prompts_seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mfa_code_is_answered_after_partial_success_password() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("koko MFA login must succeed");
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [MFA_CODE.to_string()],
            "the MFA question must be answered with the TOTP code"
        );
    }

    /// 提问文案认不出、但挑战指令行是 koko 的 "Please Enter MFA Code."：
    /// 用户照屏幕抄进 OTP 提示词的就是这句话（issue #17 的 martin-bian）。
    #[tokio::test]
    async fn mfa_is_answered_from_challenge_instructions() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, "Code: ").await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
                "totp_prompt_hint": "Please Enter MFA Code.",
            }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("instructions-only MFA prompt must be answered");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
    }

    /// 完全自定义的提问文案靠用户提示词命中（无内置模式可依赖）。
    #[tokio::test]
    async fn mfa_is_answered_from_user_hint() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, "", "Enter verification token: ").await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
                "totp_prompt_hint": "verification token",
            }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("hint-matched MFA prompt must be answered");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
    }

    /// 只开 keyboard-interactive、直接问 MFA（反问顺序主机）+ 先密码再 OTP：
    /// 保护仍然生效——不回码，且失败信息点名服务器提问与配置入口。
    #[tokio::test]
    async fn bare_mfa_prompt_stays_unanswered_before_the_password() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::KiMfaOnly, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        let error = result.err().expect("bare MFA prompt must not be answered");
        assert!(
            error.contains(MFA_QUESTION.trim()),
            "error must name the server prompt: {error}"
        );
        assert!(
            !answers
                .lock()
                .unwrap()
                .iter()
                .any(|answer| answer == MFA_CODE),
            "the OTP code must not be submitted before the password step"
        );
    }

    /// 同一形态改配「密码 + OTP 合并」：反问顺序主机应能登录（表单选型指引）。
    #[tokio::test]
    async fn bare_mfa_prompt_is_answered_in_combined_mode() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::KiMfaOnly, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({ "authentication": "password", "auth_flow_mode": "password_plus_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("combined mode answers a bare MFA prompt");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
    }

    /// PAM 风格主机在 KI 里问密码：登录提问必须收到**登录口令**，而不是
    /// 单独的 sudo 口令（凭据混用只会认证失败，还把特权口令送给主机）。
    #[tokio::test]
    async fn login_password_prompt_gets_the_login_password() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::KiPasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE, "sudo_password": SUDO_PASSWORD }),
            json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("PAM-style KI login must succeed");
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [LOGIN_PASSWORD.to_string(), MFA_CODE.to_string()],
            "the KI password question must get the login password, never the sudo password"
        );
    }

    /// 合并提问（一条应答同时要密码与验证码）：+合并模式拼接后通过。
    #[tokio::test]
    async fn combined_prompt_gets_password_and_code() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::KiCombined, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({ "authentication": "password", "auth_flow_mode": "password_plus_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("combined prompt must be answered with password + code");
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [format!("{LOGIN_PASSWORD}{MFA_CODE}")]
        );
    }

    /// 同一条合并提问在「先密码，再 OTP」下也要拼接：只回密码对真正的
    /// 合并提问必然失败（模式差异只影响"OTP 能不能单独先答"，不影响
    /// 合并提问的应答内容）。
    #[tokio::test]
    async fn combined_prompt_gets_password_and_code_in_password_then_otp() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::KiCombined, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({ "authentication": "password", "auth_flow_mode": "password_then_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("merged prompt must be answered in the default mode too");
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [format!("{LOGIN_PASSWORD}{MFA_CODE}")]
        );
    }

    /// global（表单隐藏 2FA 四件套、契约写明凭据由全局配置接管）：登录期
    /// MFA 也必须能读到该配置的 TOTP 与流程模式。
    #[tokio::test]
    async fn global_profile_supplies_login_mfa_credentials() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let mut store = sudo_profiles::SudoProfileStore::default();
        let (profile, _) = sudo_profiles::save_profile(
            &mut store,
            &json!({
                "name": "ops",
                "sudoPassword": SUDO_PASSWORD,
                "totpSecret": MFA_CODE,
                "authFlowMode": "password_then_otp",
            }),
        )
        .expect("save global profile");
        sudo_profiles::save_store(&runtime.data_dir(), &store).expect("persist profile store");
        let connection = koko_connection(
            port,
            json!({}),
            json!({
                "authentication": "password",
                "sudo_source": "global",
                "sudo_profile": profile.name,
            }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect("global-profile connection must answer login MFA");
        assert_eq!(answers.lock().unwrap().as_slice(), [MFA_CODE.to_string()]);
    }

    /// 密码被全拒（无 partial success）且服务器仍广告 keyboard-interactive：
    /// KI 以 `first_factor_accepted=true`（无条件 seed，ssh.rs 密码编排回退
    /// 分支）起步——PAM 形状的服务器根本不置 partial_success 位，若改成
    /// 严格判定（按 partial_success seed），OTP 提问将无人应答、会话晾死。
    /// 对抗评审 #7 的固化测试：改 seed 语义前必须先让本用例失败。
    #[tokio::test]
    async fn password_full_rejection_still_seeds_first_factor_for_ki() {
        let (port, answers, _exec, server) = spawn_mock_koko(
            Shape::PasswordRejectedThenMfa,
            MFA_INSTRUCTION,
            MFA_QUESTION,
        )
        .await;
        let runtime = test_runtime();
        // 提交错误密码：mock 全拒（Auth::reject()，不置 partial_success），
        // 但 keyboard-interactive 仍在服务器的可继续方法集里。
        let mut connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE }),
            json!({
                "authentication": "password",
                "auth_flow_mode": "password_then_otp",
            }),
        );
        connection.password = "definitely-wrong".to_string();

        let result = runtime.connect_headless(&connection).await;
        server.abort();
        result.expect(
            "a full password rejection must still seed the KI first factor so the MFA question is answered",
        );
        assert_eq!(
            answers.lock().unwrap().as_slice(),
            [MFA_CODE.to_string()],
            "the OTP question must be answered even though the password step fully failed"
        );
    }

    /// 私钥被接受、服务器还要 MFA：以前直接报 "private-key authentication
    /// was rejected"，现在继续答 keyboard-interactive 验证码（issue #30 的
    /// 私钥反馈）。
    ///
    /// 说明：russh 服务端（0.60/0.63 同）在处理 Auth::Reject 时会把
    /// `partial_success` 无条件清零后回包，mock 服务器因此无法向客户端
    /// 复现"公钥已通过、还差 MFA"这一步——该路径的端到端覆盖交给
    /// `scripts/smoke_login_mfa_test.py`（paramiko 会如实置位）。
    #[tokio::test]
    async fn publickey_partial_success_is_reported_by_russh_server_as_reject() {
        let (port, answers, _exec, server) =
            spawn_mock_koko(Shape::PasswordThenMfa, MFA_INSTRUCTION, MFA_QUESTION).await;
        let runtime = test_runtime();
        let key_text = test_key(2)
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .expect("encode client key");
        let connection = koko_connection(
            port,
            json!({ "totp_secret": MFA_CODE, "private_key": key_text.to_string() }),
            json!({ "authentication": "private-key", "auth_flow_mode": "password_then_otp" }),
        );
        let result = runtime.connect_headless(&connection).await;
        server.abort();
        assert_eq!(
            result.err().as_deref(),
            Some("SSH private-key authentication was rejected"),
            "russh 服务端清零 partial success，客户端据此拒绝继续"
        );
        assert!(answers.lock().unwrap().is_empty());
    }

    #[test]
    fn preserved_permissions_keep_mode_bits_and_drop_everything_else() {
        // Issue #37: the mode's permission bits (including setuid/setgid/
        // sticky) must ride onto the staged file; the file-type bits of
        // st_mode and the uid/gid/size/timestamps must not.
        let target = russh_sftp::protocol::FileAttributes {
            size: Some(12),
            uid: Some(1000),
            gid: Some(1000),
            permissions: Some(0o100755),
            atime: Some(1),
            mtime: Some(2),
            ..Default::default()
        };
        let preserved = preserved_target_permissions(&target).expect("permissions present");
        assert_eq!(preserved.permissions, Some(0o755));
        // Only permission bits travel: the staged file already has its own
        // identity, and SETSTAT on uid/gid needs elevated privileges.
        assert_eq!(preserved.size, None);
        assert_eq!(preserved.uid, None);
        assert_eq!(preserved.user, None);
        assert_eq!(preserved.gid, None);
        assert_eq!(preserved.group, None);
        assert_eq!(preserved.atime, None);
        assert_eq!(preserved.mtime, None);
        let sticky = russh_sftp::protocol::FileAttributes {
            permissions: Some(0o101755),
            ..Default::default()
        };
        let preserved = preserved_target_permissions(&sticky).expect("permissions present");
        assert_eq!(preserved.permissions, Some(0o1755));
    }

    #[test]
    fn preserved_permissions_skip_targets_without_mode_information() {
        // Servers may omit permission attributes entirely; without a mode
        // to preserve there is nothing to SETSTAT.
        let target = russh_sftp::protocol::FileAttributes {
            size: Some(3),
            ..Default::default()
        };
        assert!(preserved_target_permissions(&target).is_none());
    }

    #[test]
    fn commit_plan_skips_setstat_only_when_the_server_declares_no_mode() {
        // Issue #284: the overwrite commit must not spend a SETSTAT when
        // there is no mode to carry over, and must always book the backup
        // rename exactly when the target exists.
        let with_mode = russh_sftp::protocol::FileAttributes {
            permissions: Some(0o100644),
            ..Default::default()
        };
        let plan = commit_plan(Some(&with_mode));
        assert!(plan.backup_rename);
        assert_eq!(
            plan.permissions
                .and_then(|attributes| attributes.permissions),
            Some(0o644)
        );

        let without_mode = russh_sftp::protocol::FileAttributes {
            size: Some(3),
            ..Default::default()
        };
        let plan = commit_plan(Some(&without_mode));
        assert!(
            plan.backup_rename,
            "existing target still needs the backup rename"
        );
        assert!(
            plan.permissions.is_none(),
            "no mode information, no SETSTAT round trip"
        );

        let plan = commit_plan(None);
        assert!(
            !plan.backup_rename,
            "fresh upload commits with a single rename"
        );
        assert!(plan.permissions.is_none());
    }
}

mod host_key_prompt {
    use super::*;
    use dbx_plugin_sdk::{PluginTransport, UserInputAnswer, UserInputPrompt};
    use std::sync::atomic::Ordering;

    struct SharedSink(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for SharedSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn events(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<serde_json::Value> {
        String::from_utf8(sink.lock().unwrap().clone())
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn emitter_for_test() -> (PluginEmitter, Arc<Mutex<Vec<u8>>>) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        (
            dbx_plugin_sdk::PluginEmitter::for_tests(
                Arc::new(Mutex::new(Box::new(SharedSink(sink.clone())))),
                PluginTransport::JsonLines,
            ),
            sink,
        )
    }

    struct ScriptedGateway {
        supports: bool,
        answer: Mutex<Result<UserInputAnswer, PluginError>>,
        prompts_seen: Mutex<Vec<serde_json::Value>>,
    }

    impl ScriptedGateway {
        fn supports() -> Self {
            Self {
                supports: true,
                answer: Mutex::new(Ok(UserInputAnswer {
                    action: "submit".into(),
                    value: Some("remember".into()),
                })),
                prompts_seen: Mutex::new(Vec::new()),
            }
        }
        fn without_feature() -> Self {
            Self {
                supports: false,
                answer: Mutex::new(Ok(UserInputAnswer {
                    action: "submit".into(),
                    value: None,
                })),
                prompts_seen: Mutex::new(Vec::new()),
            }
        }
        fn answering(answer: Result<UserInputAnswer, PluginError>) -> Self {
            Self {
                supports: true,
                answer: Mutex::new(answer),
                prompts_seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl HostPromptGateway for ScriptedGateway {
        fn supports_request_user_input(&self) -> bool {
            self.supports
        }
        fn request_user_input(
            &self,
            prompt: &UserInputPrompt,
        ) -> Result<UserInputAnswer, PluginError> {
            self.prompts_seen
                .lock()
                .unwrap()
                .push(serde_json::to_value(prompt).unwrap());
            self.answer.lock().unwrap().clone()
        }
    }

    const HOST: &str = "server.example.com";
    const FINGERPRINT: &str = "SHA256:abcdefgh";

    async fn challenge_via(
        broker: &PromptBroker,
        emitter: &PluginEmitter,
    ) -> Option<PromptDecision> {
        broker
            .request(
                HOST,
                22,
                "ssh-ed25519".into(),
                FINGERPRINT.into(),
                "conn-1",
                "op-1",
                emitter,
            )
            .await
    }

    #[tokio::test]
    async fn host_dialog_submit_remember_maps_to_accept_and_remember() {
        let gateway = Arc::new(ScriptedGateway::supports());
        let broker = PromptBroker::with_gateway(gateway.clone());
        let (emitter, sink) = emitter_for_test();

        let decision = challenge_via(&broker, &emitter).await;

        assert_eq!(
            decision,
            Some(PromptDecision {
                accept: true,
                remember: true
            })
        );
        assert!(events(&sink)
            .iter()
            .all(|event| event["method"] != "connection/challenge"));
        let prompt = gateway.prompts_seen.lock().unwrap()[0].clone();
        assert_eq!(prompt["options"][0]["value"], "accept");
        assert_eq!(prompt["options"][1]["value"], "remember");
        assert!(prompt["prompt"].as_str().unwrap().contains(FINGERPRINT));
        assert!(broker.challenge_was_raised());
        // The dialog took the challenge: connection/test may extend its
        // budget for exactly this probe.
        assert!(broker.host_dialog_was_used());
    }

    #[tokio::test]
    async fn host_dialog_accept_maps_to_accept_without_remember() {
        let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
            action: "submit".into(),
            value: Some("accept".into()),
        })));
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, _sink) = emitter_for_test();
        assert_eq!(
            challenge_via(&broker, &emitter).await,
            Some(PromptDecision {
                accept: true,
                remember: false
            })
        );
    }

    #[tokio::test]
    async fn host_dialog_cancel_and_timeout_reject_fail_closed() {
        for action in ["cancel", "timeout"] {
            let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
                action: action.into(),
                value: None,
            })));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();
            assert_eq!(
                challenge_via(&broker, &emitter).await,
                Some(PromptDecision {
                    accept: false,
                    remember: false
                })
            );
            assert!(events(&sink)
                .iter()
                .all(|event| event["method"] != "connection/challenge"));
        }
    }

    #[tokio::test]
    async fn host_without_feature_falls_back_to_workbench_event() {
        let gateway = Arc::new(ScriptedGateway::without_feature());
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, sink) = emitter_for_test();

        let pending = tokio::spawn({
            let broker = broker.clone();
            let emitter = emitter.clone();
            async move {
                broker
                    .request(
                        HOST,
                        22,
                        "ssh-ed25519".into(),
                        FINGERPRINT.into(),
                        "conn-1",
                        "op-1",
                        &emitter,
                    )
                    .await
            }
        });
        // 降级路径必须发出既有事件载荷(workbench 依赖 challengeId/kind 字段)。
        let mut challenge_id = None;
        for _ in 0..200 {
            if let Some(event) = events(&sink)
                .into_iter()
                .find(|event| event["method"] == "connection/challenge")
            {
                challenge_id = Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                assert_eq!(event["params"]["kind"], "host-key");
                assert_eq!(event["params"]["fingerprint"], FINGERPRINT);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let challenge_id = challenge_id.expect("legacy challenge event must be emitted");
        broker
            .resolve(
                &challenge_id,
                "op-1",
                PromptDecision {
                    accept: true,
                    remember: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            pending.await.unwrap(),
            Some(PromptDecision {
                accept: true,
                remember: true
            })
        );
    }

    #[tokio::test]
    async fn no_ui_error_falls_back_to_workbench_event() {
        let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
            -32001,
            "no user interface is attached",
        ))));
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, sink) = emitter_for_test();
        let pending = tokio::spawn({
            let broker = broker.clone();
            let emitter = emitter.clone();
            async move {
                broker
                    .request(
                        HOST,
                        22,
                        "ssh-ed25519".into(),
                        FINGERPRINT.into(),
                        "conn-1",
                        "op-1",
                        &emitter,
                    )
                    .await
            }
        });
        let mut challenge_id = None;
        for _ in 0..200 {
            if let Some(event) = events(&sink)
                .into_iter()
                .find(|event| event["method"] == "connection/challenge")
            {
                challenge_id = Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        broker
            .resolve(
                &challenge_id.expect("fallback event"),
                "op-1",
                PromptDecision {
                    accept: false,
                    remember: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            pending.await.unwrap(),
            Some(PromptDecision {
                accept: false,
                remember: false
            })
        );
        // A degradable failure fell back to the workbench event: the
        // dialog must not keep the extended test budget armed.
        assert!(!broker.host_dialog_was_used());
    }

    #[tokio::test]
    async fn host_dialog_marks_used_and_degraded_fallback_does_not() {
        // 粘性标志的语义:弹窗真正接管挑战时置位(connection/test 据此重臂
        // 预算);可降级错误回落 legacy 前必须清零,1.0 宿主保持短预算。
        let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
            -32601,
            "method not found",
        ))));
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, sink) = emitter_for_test();
        let pending = tokio::spawn({
            let broker = broker.clone();
            let emitter = emitter.clone();
            async move {
                broker
                    .request(
                        HOST,
                        22,
                        "ssh-ed25519".into(),
                        FINGERPRINT.into(),
                        "conn-1",
                        "op-1",
                        &emitter,
                    )
                    .await
            }
        });
        let mut challenge_id = None;
        for _ in 0..200 {
            if let Some(event) = events(&sink)
                .into_iter()
                .find(|event| event["method"] == "connection/challenge")
            {
                challenge_id = Some(event["params"]["challengeId"].as_str().unwrap().to_string());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // Once the legacy event is out, the dialog flag must already be
        // cleared again.
        assert!(!broker.host_dialog_was_used());
        broker
            .resolve(
                &challenge_id.expect("fallback event"),
                "op-1",
                PromptDecision {
                    accept: true,
                    remember: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            pending.await.unwrap(),
            Some(PromptDecision {
                accept: true,
                remember: false
            })
        );
        assert!(!broker.host_dialog_was_used());
    }

    #[tokio::test]
    async fn host_silence_fails_closed_without_fallback() {
        // SDK 本地超时的错误以 -32001 + "did not answer" 表达;此时再降级会
        // 把总等待拖到 630s,必须直接拒绝。
        let gateway = Arc::new(ScriptedGateway::answering(Err(PluginError::new(
            -32001,
            "Host did not answer 'host/requestUserInput' in time",
        ))));
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, sink) = emitter_for_test();
        assert_eq!(challenge_via(&broker, &emitter).await, None);
        assert!(events(&sink)
            .iter()
            .all(|event| event["method"] != "connection/challenge"));
    }

    #[tokio::test]
    async fn host_dialog_submit_without_known_value_rejects_fail_closed() {
        // Only an explicit accept/remember value grants trust: a missing
        // or unknown value (host sent action=submit with nothing usable)
        // must be a rejection, never a guess.
        for value in [None, Some("maybe".to_string())] {
            let gateway = Arc::new(ScriptedGateway::answering(Ok(UserInputAnswer {
                action: "submit".into(),
                value,
            })));
            let broker = PromptBroker::with_gateway(gateway);
            let (emitter, sink) = emitter_for_test();
            assert_eq!(
                challenge_via(&broker, &emitter).await,
                Some(PromptDecision {
                    accept: false,
                    remember: false
                })
            );
            assert!(events(&sink)
                .iter()
                .all(|event| event["method"] != "connection/challenge"));
        }
    }

    #[tokio::test]
    async fn challenge_raised_flag_clears_between_probes() {
        let gateway = Arc::new(ScriptedGateway::supports());
        let broker = PromptBroker::with_gateway(gateway);
        let (emitter, _sink) = emitter_for_test();
        broker.challenge_raised.store(true, Ordering::Relaxed);
        broker.clear_challenge_raised();
        let _ = challenge_via(&broker, &emitter).await;
        assert!(broker.challenge_was_raised());
        assert!(broker.host_dialog_was_used());
        broker.clear_challenge_raised();
        // One clear entry resets both sticky challenge marks so the next
        // probe starts from a clean slate.
        assert!(!broker.challenge_was_raised());
        assert!(!broker.host_dialog_was_used());
    }

    #[test]
    fn challenge_flag_clears_between_probes() {
        let gateway = Arc::new(ScriptedGateway::without_feature());
        let broker = PromptBroker::with_gateway(gateway);
        broker
            .challenge_raised
            .store(true, std::sync::atomic::Ordering::Relaxed);
        broker.clear_challenge_raised();
        assert!(!broker.challenge_was_raised());
    }

    #[test]
    fn local_target_registry_follows_the_connection_lifecycle() {
        let dir = std::env::temp_dir().join(format!("dbx-ssh-local-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let runtime = SshRuntime::new(dir);
        // Unknown ids (SSH connections included) read as "not local" so
        // the task provider keeps its SSH path untouched.
        let runtime_ref = &runtime;
        let runtime_handle = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime_handle
            .block_on(runtime_ref.local_target("conn-local-1"))
            .is_none());

        runtime
            .store_local_target(crate::local_target::LocalTarget {
                id: "conn-local-1".to_string(),
                name: Some("ops".to_string()),
                shell: "/bin/bash".to_string(),
                cwd: String::new(),
                env: Vec::new(),
            })
            .unwrap();
        let target = runtime_handle
            .block_on(runtime_ref.local_target("conn-local-1"))
            .expect("stored target");
        assert_eq!(target.shell, "/bin/bash");
        // Re-connect replaces the registration in place.
        runtime
            .store_local_target(crate::local_target::LocalTarget {
                id: "conn-local-1".to_string(),
                name: None,
                shell: String::new(),
                cwd: String::new(),
                env: Vec::new(),
            })
            .unwrap();
        let replaced = runtime_handle
            .block_on(runtime_ref.local_target("conn-local-1"))
            .unwrap();
        assert_eq!(replaced.shell, String::new());
        // Disconnect clears it; an SSH disconnect id is a harmless no-op.
        runtime.drop_local_target("conn-local-1");
        runtime.drop_local_target("some-ssh-connection");
        assert!(runtime_handle
            .block_on(runtime_ref.local_target("conn-local-1"))
            .is_none());
    }
}

#[test]
fn sftp_client_config_compat_serializes_pipelines_and_widens_timeout() {
    // compat（M14-B）：请求/响应不做流水线并发（读写各 1 路）。
    let config = sftp_client_config(true);
    assert_eq!(config.max_concurrent_reads, 1);
    assert_eq!(config.max_concurrent_writes, 1);
    // #206：russh-sftp 默认 10s 单请求超时在慢链路/跳板下误杀大文件上传。
    assert_eq!(config.request_timeout_secs, 60);
}

#[test]
fn sftp_client_config_non_compat_deepens_write_pipeline() {
    // 非 compat：读侧保持 crate 默认并发（下载另有 multistream 调参）；
    // 写侧加深到 64 路在途（#237），每请求超时放宽（#206）。
    let config = sftp_client_config(false);
    assert_eq!(
        config.max_concurrent_reads,
        SftpConfig::default().max_concurrent_reads
    );
    assert_eq!(config.max_concurrent_writes, SFTP_WRITE_PIPELINE_DEPTH);
    assert_eq!(config.request_timeout_secs, 60);
    // 在途窗口 = 深度 × 写包大小（russh-sftp 默认写包 32KiB）：2MiB。
    assert_eq!(
        config.max_concurrent_writes * SftpConfig::default().max_write_packet_len as usize,
        2 * 1024 * 1024
    );
}
