//! `docker/files_write.rs` 的单测（路径/上限/原子写/删除/只读/审计文本）。
//!
//! 容器脚本是 POSIX `sh`，因此 Unix 上直接在本机临时目录里执行脚本体：
//! 临时目录充当「容器 rootfs」，位置参数与生产路径完全同形。Windows 只跑
//! 纯函数断言（脚本执行测试带 `cfg(unix)`）。

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::json;

use super::files_write::{
    files_delete_args, files_delete_command, files_delete_payload, files_delete_script,
    files_write_args, files_write_command, files_write_payload, files_write_script,
    mutation_access, parse_confirm, parse_overwrite, parse_recursive, parse_write_data,
    validate_delete_path, validate_mutation_path, write_temp_path, DELETE_ERROR, DELETE_INNER,
    DELETE_OK, FILES_WRITE_MAX_BYTES, READ_ONLY_MUTATION_MESSAGE, WRITE_ERROR, WRITE_INNER,
};
use super::*;

const ID: &str = "d4a7c9f1e2b3";

fn value(encoded: &str) -> serde_json::Value {
    json!({ "dataBase64": encoded })
}

#[test]
fn rejects_traversal_relative_and_control_paths() {
    for bad in [
        "",
        "..",
        "../etc/passwd",
        "relative/path",
        "/tmp/../etc",
        "/tmp/./x",
        "//etc",
        "/tmp/a\nb",
        "/tmp/a\tb",
        "/tmp/a\0b",
    ] {
        assert!(validate_mutation_path(bad).is_err(), "{bad:?}");
    }
    let too_long = format!("/{}", "a".repeat(FILES_PATH_MAX_BYTES));
    assert!(validate_mutation_path(&too_long).is_err());
    for good in [
        "/tmp/note.txt",
        "/var/lib/a b.txt",
        "/etc/hosts",
        "/tmp/数据.txt",
    ] {
        assert!(validate_mutation_path(good).is_ok(), "{good:?}");
    }
}

#[test]
fn rejects_shell_metacharacters_in_write_and_delete_paths() {
    for bad in [
        "/tmp/a'b; rm -rf /",
        "/tmp/$(id)",
        "/tmp/`id`",
        "/tmp/a&b",
        "/tmp/a|b",
        "/tmp/a>b",
        "/tmp/a\nb",
        "/tmp/a\0b",
    ] {
        assert!(validate_mutation_path(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        validate_mutation_path("/tmp/ok-name_1.txt").unwrap(),
        "/tmp/ok-name_1.txt"
    );
    assert_eq!(
        validate_delete_path("/tmp/ok-name_1.txt", false).unwrap(),
        "/tmp/ok-name_1.txt"
    );
}

#[test]
fn delete_refuses_root_and_recursive_mount_points() {
    assert!(validate_delete_path("/", false).is_err());
    assert!(validate_delete_path("/", true).is_err());
    for mount in ["/proc", "/sys", "/dev"] {
        assert!(validate_delete_path(mount, true).is_err(), "{mount}");
        // 非递归时由容器脚本报「目录」错误；路径校验本身放行。
        assert!(validate_delete_path(mount, false).is_ok(), "{mount}");
    }
    // 计划 §5.3 只拒绝挂载点本体（整路径精确匹配）。
    assert!(validate_delete_path("/proc/1", true).is_ok());
    assert!(validate_delete_path("/tmp/file.txt", false).is_ok());
}

#[test]
fn enforces_write_size_limit_and_rejects_bad_base64() {
    let exact = STANDARD.encode(vec![b'a'; FILES_WRITE_MAX_BYTES]);
    let (canonical, bytes) = parse_write_data(&value(&exact)).unwrap();
    assert_eq!(bytes, FILES_WRITE_MAX_BYTES);
    assert_eq!(canonical, exact);

    let over = STANDARD.encode(vec![b'a'; FILES_WRITE_MAX_BYTES + 1]);
    let error = parse_write_data(&value(&over)).unwrap_err();
    assert!(error.contains("65536"), "{error}");

    assert!(parse_write_data(&value("%%%not-base64%%%")).is_err());
    assert!(parse_write_data(&json!({})).is_err());
    assert!(parse_write_data(&json!({ "dataBase64": 7 })).is_err());
}

#[test]
fn parses_strict_boolean_flags() {
    assert!(!parse_overwrite(&json!({})).unwrap());
    assert!(parse_overwrite(&json!({ "overwrite": true })).unwrap());
    assert!(parse_overwrite(&json!({ "overwrite": "yes" })).is_err());

    assert!(!parse_recursive(&json!({})).unwrap());
    assert!(parse_recursive(&json!({ "recursive": true })).unwrap());
    assert!(parse_recursive(&json!({ "recursive": 1 })).is_err());

    assert!(!parse_confirm(&json!({})).unwrap());
    assert!(parse_confirm(&json!({ "confirm": true })).unwrap());
    assert!(parse_confirm(&json!({ "confirm": "true" })).is_err());
}

#[test]
fn temp_name_is_unique_and_lives_beside_the_target() {
    let first = write_temp_path("/tmp/note.txt").unwrap();
    let second = write_temp_path("/tmp/note.txt").unwrap();
    assert_ne!(first, second);
    for name in [&first, &second] {
        assert!(name.starts_with("/tmp/.dbx-docker-write-"), "{name}");
        assert!(name.contains(&std::process::id().to_string()), "{name}");
        assert!(name.ends_with(".tmp"), "{name}");
        assert_eq!(name.matches('/').count(), 2, "{name}");
    }
    let root_child = write_temp_path("/note.txt").unwrap();
    assert!(
        root_child.starts_with("/.dbx-docker-write-"),
        "{root_child}"
    );
    assert!(write_temp_path("/").is_err());
}

#[test]
fn renders_positional_argv_and_rejects_bad_container_ids() {
    let engine = EngineConfig::default();
    let temp = "/tmp/.dbx-docker-write-test.tmp";
    let script = files_write_script(&engine, ID, "/tmp/note.txt", "aGk=", false, temp).unwrap();
    assert!(script.starts_with("sh -c '"), "{script}");
    assert!(script.contains("'/tmp/note.txt'"), "{script}");
    assert!(script.contains("'aGk='"), "{script}");
    assert!(script.contains(temp), "{script}");
    // 脚本文本（$1..$4 的取值）不含用户路径本身——路径只出现在 argv。
    assert!(!script.contains("note.txt;"), "{script}");

    let args = files_write_args(ID, "/tmp/note.txt", "aGk=", true, temp).unwrap();
    assert_eq!(args[0], "exec");
    assert_eq!(args[1], ID);
    assert_eq!(args[5], "sh");
    assert_eq!(args[6], "/tmp/note.txt");
    assert_eq!(args[7], "aGk=");
    assert_eq!(args[8], "1");
    assert_eq!(args[9], temp);

    let delete_args = files_delete_args(ID, "/tmp/note.txt", false).unwrap();
    assert_eq!(delete_args[6], "/tmp/note.txt");
    assert_eq!(delete_args[7], "0");

    for bad_id in ["abc", "D4A7C9F1E2B3", "d4a7c9f1e2b3; rm -rf /"] {
        assert!(files_write_script(&engine, bad_id, "/tmp/x", "aGk=", false, temp).is_err());
        assert!(files_delete_script(&engine, bad_id, "/tmp/x", false).is_err());
    }
}

#[test]
fn write_payload_parses_size_and_overwritten_flag() {
    let output = format!("noise\nDBXDOCKER_WRITE_RESULT\0{}\0{}\0{}", 5, 1, WRITE_OK);
    let payload = files_write_payload(&output, "/tmp/x").unwrap();
    assert_eq!(
        payload,
        json!({ "path": "/tmp/x", "size": 5, "overwritten": true })
    );

    let created = format!("DBXDOCKER_WRITE_RESULT\0{}\0{}\0{}", 0, 0, WRITE_OK);
    assert_eq!(
        files_write_payload(&created, "/tmp/x").unwrap()["overwritten"],
        false
    );
    let error = format!("{WRITE_ERROR}file already exists\0");
    assert!(files_write_payload(&error, "/tmp/x")
        .unwrap_err()
        .contains("already exists"));
    assert!(files_write_payload("no markers", "/tmp/x").is_err());
}

#[test]
fn delete_payload_requires_ok_marker() {
    assert_eq!(
        files_delete_payload(DELETE_OK, "/tmp/x").unwrap(),
        json!({ "path": "/tmp/x", "removed": true })
    );
    let error = format!("{DELETE_ERROR}no such file or directory\0");
    assert!(files_delete_payload(&error, "/tmp/x")
        .unwrap_err()
        .contains("no such"));
    assert!(files_delete_payload("", "/tmp/x").is_err());
}

#[test]
fn read_only_connection_refuses_write() {
    assert_eq!(
        mutation_access(true).unwrap_err(),
        READ_ONLY_MUTATION_MESSAGE
    );
    assert_eq!(
        READ_ONLY_MUTATION_MESSAGE,
        "Write/terminal operation is disabled by the read-only connection setting"
    );
    assert!(mutation_access(false).is_ok());
}

#[test]
fn read_only_connection_refuses_delete() {
    let error = mutation_access(true).unwrap_err();
    assert!(error.contains("read-only connection setting"), "{error}");
    assert!(mutation_access(false).is_ok());
}

#[test]
fn audit_command_text_contains_path_and_bytes_but_never_file_content() {
    let engine = EngineConfig::default();
    let data = STANDARD.encode(b"top-secret-payload");
    let command = files_write_command(&engine, ID, "/tmp/note.txt", 18);
    assert_eq!(
        command,
        "docker exec d4a7c9f1e2b3 ... write /tmp/note.txt 18 bytes"
    );
    assert!(!command.contains(&data), "{command}");
    assert!(!command.contains("top-secret"), "{command}");
    assert_eq!(
        files_delete_command(&engine, ID, "/tmp/note.txt"),
        "docker exec d4a7c9f1e2b3 ... delete /tmp/note.txt"
    );
}

// —— 容器脚本体在临时目录里真实执行（POSIX sh）————————————————

#[cfg(unix)]
fn run_inner(inner: &str, args: &[&str]) -> String {
    let output = std::process::Command::new("sh")
        .arg("-c")
        .arg(inner)
        .arg("sh")
        .args(args)
        .output()
        .expect("run sh");
    assert!(output.status.success(), "sh exited non-zero");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[cfg(unix)]
fn write_file(path: &Path, content: &[u8]) {
    std::fs::write(path, content).expect("write fixture");
}

#[cfg(unix)]
fn text(path: &Path) -> &str {
    path.to_str().expect("utf-8 temp path")
}

#[cfg(unix)]
#[test]
fn script_writes_atomically_without_leaving_the_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let temp = dir.path().join(".write.tmp");
    let encoded = STANDARD.encode(b"hello\n");
    let output = run_inner(WRITE_INNER, &[text(&target), &encoded, "0", text(&temp)]);
    let payload = files_write_payload(&output, text(&target)).unwrap();
    assert_eq!(payload["size"], 6);
    assert_eq!(payload["overwritten"], false);
    assert_eq!(std::fs::read(&target).unwrap(), b"hello\n");
    assert!(!temp.exists(), "temp file must be removed");
}

#[cfg(unix)]
#[test]
fn script_refuses_overwrite_false_and_keeps_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let temp = dir.path().join(".write.tmp");
    write_file(&target, b"old");
    let output = run_inner(
        WRITE_INNER,
        &[text(&target), &STANDARD.encode(b"new"), "0", text(&temp)],
    );
    assert!(output.contains("already exists"), "{output}");
    assert!(files_write_payload(&output, text(&target)).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"old");
    assert!(!temp.exists(), "temp file must be removed");
}

#[cfg(unix)]
#[test]
fn script_overwrites_when_requested_and_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let temp = dir.path().join(".write.tmp");
    write_file(&target, b"old");
    let output = run_inner(
        WRITE_INNER,
        &[text(&target), &STANDARD.encode(b"new!"), "1", text(&temp)],
    );
    let payload = files_write_payload(&output, text(&target)).unwrap();
    assert_eq!(payload["size"], 4);
    assert_eq!(payload["overwritten"], true);
    assert_eq!(std::fs::read(&target).unwrap(), b"new!");
    assert!(!temp.exists());
}

#[cfg(unix)]
#[test]
fn script_leaves_no_residue_when_the_temp_name_is_taken() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let temp = dir.path().join(".write.tmp");
    write_file(&temp, b"someone-else");
    let output = run_inner(
        WRITE_INNER,
        &[text(&target), &STANDARD.encode(b"new"), "0", text(&temp)],
    );
    assert!(output.contains("temporary file already exists"), "{output}");
    assert!(!target.exists());
    assert_eq!(std::fs::read(&temp).unwrap(), b"someone-else");
}

#[cfg(unix)]
#[test]
fn script_cleans_up_when_decoding_fails() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.txt");
    let temp = dir.path().join(".write.tmp");
    let output = run_inner(WRITE_INNER, &[text(&target), "%%%bad%%%", "0", text(&temp)]);
    assert!(output.contains("cannot decode data"), "{output}");
    assert!(!target.exists());
    assert!(!temp.exists(), "failed write must not leave a temp file");
}

#[cfg(unix)]
#[test]
fn script_cleans_up_when_the_final_rename_fails() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let locked = dir.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    // 以 root 运行时 0555 仍可写，跳过该场景（不伪造结论）。
    let probe = locked.join(".probe");
    if std::fs::write(&probe, b"x").is_ok() {
        let _ = std::fs::remove_file(&probe);
        return;
    }
    let target = locked.join("note.txt");
    let temp = dir.path().join(".write.tmp");
    let output = run_inner(
        WRITE_INNER,
        &[text(&target), &STANDARD.encode(b"new"), "0", text(&temp)],
    );
    let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755));
    assert!(output.contains("cannot replace target file"), "{output}");
    assert!(!target.exists());
    assert!(!temp.exists(), "failed rename must not leave a temp file");
}

#[cfg(unix)]
#[test]
fn script_deletes_regular_files_only_without_recursive() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("note.txt");
    write_file(&file, b"x");
    let output = run_inner(DELETE_INNER, &[text(&file), "0"]);
    assert_eq!(
        files_delete_payload(&output, text(&file)).unwrap()["removed"],
        true
    );
    assert!(!file.exists());

    let missing = dir.path().join("missing.txt");
    let output = run_inner(DELETE_INNER, &[text(&missing), "0"]);
    assert!(output.contains("no such file"), "{output}");
}

#[cfg(unix)]
#[test]
fn script_refuses_directories_without_recursive_and_removes_them_with_it() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("tree");
    std::fs::create_dir(&folder).unwrap();
    write_file(&folder.join("inside.txt"), b"x");

    let output = run_inner(DELETE_INNER, &[text(&folder), "0"]);
    assert!(output.contains("is a directory"), "{output}");
    assert!(folder.exists());

    let output = run_inner(DELETE_INNER, &[text(&folder), "1"]);
    assert_eq!(
        files_delete_payload(&output, text(&folder)).unwrap()["removed"],
        true
    );
    assert!(!folder.exists());
}
