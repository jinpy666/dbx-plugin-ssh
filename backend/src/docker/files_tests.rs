//! `docker/files.rs` 的纯函数单测（路径校验/脚本渲染/列表与读取解析）。
//! 作为独立 `_tests.rs` 文件登记在结构预算的测试档（≤1200 行）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::json;

use crate::exec;

use super::files::{LIST_BEGIN, LIST_END, LIST_INNER, READ_BEGIN, READ_END, READ_INNER, READ_SIZE};
use super::*;

const ID: &str = "d4a7c9f1e2b3";

fn listing(records: &[(&str, u64, &str)]) -> String {
    let mut text = String::from("noise\n");
    text.push_str(LIST_BEGIN);
    for (kind, size, name) in records {
        text.push_str(kind);
        text.push('\t');
        text.push_str(&size.to_string());
        text.push('\t');
        text.push_str(&STANDARD.encode(name));
        text.push('\0');
    }
    text.push_str(LIST_END);
    text.push_str("stderr noise");
    text
}

#[test]
fn accepts_normal_absolute_paths() {
    for path in ["/", "/etc", "/var/lib/docker", "/tmp/a b", "/tmp/a'b"] {
        assert!(validate_container_path(path).is_ok(), "{path:?}");
    }
    assert_eq!(normalize_container_path("/etc/").unwrap(), "/etc");
    assert_eq!(normalize_container_path("/").unwrap(), "/");
    assert!(normalize_container_path("///").is_err());
}

#[test]
fn rejects_injection_and_malformed_paths() {
    for bad in [
        "",
        "relative/path",
        "a'b; rm -rf /",
        "$(id)",
        "`id`",
        "a\nb",
        "a\tb",
        "a\0b",
        "/tmp/a\nb",
        "/tmp/a\tb",
        "/tmp/a\0b",
        "//etc",
        "/tmp/../etc",
        "/./etc",
        "/tmp/../../etc/passwd",
    ] {
        assert!(validate_container_path(bad).is_err(), "{bad:?}");
    }
    let too_long = format!("/{}", "a".repeat(FILES_PATH_MAX_BYTES));
    assert!(validate_container_path(&too_long).is_err());
    let exact = format!("/{}", "a".repeat(FILES_PATH_MAX_BYTES - 1));
    assert!(validate_container_path(&exact).is_ok());
}

#[test]
fn renders_hostile_absolute_path_only_as_quoted_argv() {
    let engine = EngineConfig::default();
    for path in [
        "/tmp/a'b; rm -rf /",
        "/tmp/$(id)",
        "/tmp/`id`",
        "/tmp/--help",
        "/tmp/a b",
    ] {
        let normalized = normalize_container_path(path).unwrap();
        for (script, tail) in [
            (
                files_list_script(&engine, ID, path, false).unwrap(),
                format!(" sh {} 0", exec::shell_quote(&normalized)),
            ),
            (
                files_read_script(&engine, ID, path, 1024).unwrap(),
                format!(" sh {} 1024", exec::shell_quote(&normalized)),
            ),
        ] {
            assert!(script.ends_with(&tail), "{script}");
            let body = &script[..script.len() - tail.len()];
            assert!(
                !body.contains(&normalized),
                "path leaked into script body: {script}"
            );
        }
    }
    // 单引号路径在 argv 中必须被 shell_quote 正确转义。
    let script = files_list_script(&engine, ID, "/tmp/a'b", false).unwrap();
    assert!(script.contains(r#"'/tmp/a'\''b'"#), "{script}");
}

#[test]
fn files_args_keep_path_as_one_argv() {
    let args = files_list_args(ID, "/tmp/a'b; rm -rf /", true).unwrap();
    assert_eq!(args.len(), 8);
    assert_eq!(args[0], "exec");
    assert_eq!(args[1], ID);
    assert_eq!(args[2], "sh");
    assert_eq!(args[3], "-c");
    assert_eq!(args[4], LIST_INNER);
    assert_eq!(args[5], "sh");
    assert_eq!(args[6], "/tmp/a'b; rm -rf ");
    assert_eq!(args[7], "1");
    let read = files_read_args(ID, "/tmp/$(id)", 2048).unwrap();
    assert_eq!(read[6], "/tmp/$(id)");
    assert_eq!(read[7], "2048");
}

#[test]
fn parses_listing_with_kinds_sizes_and_paths() {
    let output = listing(&[
        ("file", 12, "a.txt"),
        ("dir", 0, "logs"),
        ("link", 0, "current"),
        ("other", 7, "fifo"),
    ]);
    let payload = files_list_payload(&output, "/var/app").unwrap();
    assert_eq!(payload["path"], "/var/app");
    assert_eq!(payload["truncated"], false);
    let entries = payload["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["name"], "a.txt");
    assert_eq!(entries[0]["path"], "/var/app/a.txt");
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[0]["size"], 12);
    assert_eq!(entries[1]["path"], "/var/app/logs");
    assert_eq!(entries[1]["size"], 0);
    assert_eq!(entries[2]["kind"], "link");
    assert_eq!(entries[3]["kind"], "other");
    assert_eq!(entries[3]["size"], 0, "only regular files carry size");
}

#[test]
fn listing_root_joins_with_single_slash() {
    let payload = files_list_payload(&listing(&[("dir", 0, "etc")]), "/").unwrap();
    assert_eq!(payload["entries"][0]["path"], "/etc");
}

#[test]
fn listing_skips_empty_and_malformed_names() {
    let mut output = String::from(LIST_BEGIN);
    output.push_str("file\t3\t\0");
    output.push_str("file\t3\t%%%not-base64%%%\0");
    output.push_str("file\t3\t");
    output.push_str(&STANDARD.encode("ok"));
    output.push('\0');
    output.push_str(LIST_END);
    let payload = files_list_payload(&output, "/tmp").unwrap();
    let entries = payload["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "ok");
}

#[test]
fn listing_caps_at_500_and_marks_truncated() {
    let records: Vec<(String, u64, String)> = (0..501)
        .map(|index| (String::from("file"), index as u64, format!("f{index}")))
        .collect();
    let borrowed: Vec<(&str, u64, &str)> = records
        .iter()
        .map(|(kind, size, name)| (kind.as_str(), *size, name.as_str()))
        .collect();
    let payload = files_list_payload(&listing(&borrowed), "/tmp").unwrap();
    assert_eq!(payload["entries"].as_array().unwrap().len(), 500);
    assert_eq!(payload["truncated"], true);
}

#[test]
fn listing_reports_container_errors() {
    let error = files_list_payload("DBXDOCKER_FILES_ERROR\0not a directory\0", "/tmp").unwrap_err();
    assert!(error.contains("not a directory"), "{error}");
    let missing = files_list_payload("docker: command not found", "/tmp").unwrap_err();
    assert!(missing.contains("docker/files/list failed"), "{missing}");
}

#[test]
fn reads_base64_and_reports_truncation() {
    let output = format!(
        "{READ_SIZE}5\0{READ_BEGIN}{}\0{READ_END}",
        STANDARD.encode(b"hello")
    );
    let payload = files_read_payload(&output, "/tmp/a.txt", 1024).unwrap();
    assert_eq!(payload["dataBase64"], STANDARD.encode(b"hello"));
    assert_eq!(payload["size"], 5);
    assert_eq!(payload["truncated"], false);

    let output = format!(
        "{READ_SIZE}10\0{READ_BEGIN}{}\0{READ_END}",
        STANDARD.encode(b"hell")
    );
    let payload = files_read_payload(&output, "/tmp/a.txt", 4).unwrap();
    assert_eq!(payload["size"], 10);
    assert_eq!(payload["truncated"], true);
    assert_eq!(payload["dataBase64"], STANDARD.encode(b"hell"));
}

#[test]
fn read_rejects_mismatched_length_and_errors() {
    let output = format!(
        "{READ_SIZE}10\0{READ_BEGIN}{}\0{READ_END}",
        STANDARD.encode(b"short")
    );
    assert!(files_read_payload(&output, "/tmp/a", 4).is_err());
    let error =
        files_read_payload("DBXDOCKER_READ_ERROR\0not a regular file\0", "/tmp", 1).unwrap_err();
    assert!(error.contains("not a regular file"), "{error}");
}

#[test]
fn parses_max_bytes_bounds() {
    let value = json!({});
    assert_eq!(parse_max_bytes(&value).unwrap(), FILES_READ_DEFAULT_BYTES);
    assert_eq!(parse_max_bytes(&json!({ "maxBytes": 1 })).unwrap(), 1);
    assert_eq!(
        parse_max_bytes(&json!({ "maxBytes": FILES_READ_MAX_BYTES })).unwrap(),
        FILES_READ_MAX_BYTES
    );
    assert!(parse_max_bytes(&json!({ "maxBytes": 0 })).is_err());
    assert!(parse_max_bytes(&json!({ "maxBytes": FILES_READ_MAX_BYTES + 1 })).is_err());
    assert!(parse_max_bytes(&json!({ "maxBytes": "1MiB" })).is_err());
}

#[test]
fn parses_show_hidden_default() {
    assert!(!parse_show_hidden(&json!({})));
    assert!(parse_show_hidden(&json!({ "showHidden": true })));
    assert!(!parse_show_hidden(&json!({ "showHidden": "yes" })));
}

/// 固定脚本体在本机 POSIX sh 上跑一遍（临时目录，无容器、无用户输入）：
/// 证明 NUL 记录、base64 名字、隐藏项过滤、文件大小与读取截断在真实
/// shell + parser 之间闭环。Windows 无 sh，跳过。
#[cfg(unix)]
#[test]
fn fixed_scripts_round_trip_through_posix_sh() {
    use std::process::Command;

    let dir = std::env::temp_dir().join(format!("dbx-b4-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("a.txt"), b"hello").unwrap();
    std::fs::write(dir.join(".hidden"), b"x").unwrap();
    let dir_text = dir.to_string_lossy().to_string();

    let list = Command::new("sh")
        .arg("-c")
        .arg(LIST_INNER)
        .arg("sh")
        .arg(&dir_text)
        .arg("0")
        .output()
        .unwrap();
    assert!(list.status.success());
    let listing = files_list_payload(&String::from_utf8_lossy(&list.stdout), &dir_text).unwrap();
    let entries = listing["entries"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["name"] == "a.txt"));
    assert!(entries.iter().any(|entry| entry["name"] == "sub"));
    assert!(!entries.iter().any(|entry| entry["name"] == ".hidden"));
    let file = entries
        .iter()
        .find(|entry| entry["name"] == "a.txt")
        .unwrap();
    assert_eq!(file["kind"], "file");
    assert_eq!(file["size"], 5);

    let hidden = Command::new("sh")
        .arg("-c")
        .arg(LIST_INNER)
        .arg("sh")
        .arg(&dir_text)
        .arg("1")
        .output()
        .unwrap();
    let hidden = files_list_payload(&String::from_utf8_lossy(&hidden.stdout), &dir_text).unwrap();
    assert!(hidden["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == ".hidden"));

    let path = dir.join("a.txt");
    let read = Command::new("sh")
        .arg("-c")
        .arg(READ_INNER)
        .arg("sh")
        .arg(path.to_string_lossy().as_ref())
        .arg("4")
        .output()
        .unwrap();
    assert!(read.status.success());
    let content = files_read_payload(&String::from_utf8_lossy(&read.stdout), "/a.txt", 4).unwrap();
    assert_eq!(content["size"], 5);
    assert_eq!(content["truncated"], true);
    assert_eq!(content["dataBase64"], STANDARD.encode(b"hell"));

    let _ = std::fs::remove_dir_all(&dir);
}
