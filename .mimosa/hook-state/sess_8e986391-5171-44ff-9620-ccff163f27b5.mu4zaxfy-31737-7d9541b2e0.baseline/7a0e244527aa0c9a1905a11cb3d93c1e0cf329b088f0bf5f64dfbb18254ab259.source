//! Extended SFTP operations (stat/touch/direct-write/archive), mirroring tiny-rdm.
#![allow(dead_code)] // entry points are wired in main.rs; see the snippet at the bottom

use std::collections::HashSet;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::model::normalize_remote_path;
use crate::ssh::SshRuntime;

/// Largest payload [`write_file`] accepts in one call; bigger files must go
/// through the streaming upload slot (`sftp/upload/start`).
pub const MAX_DIRECT_WRITE_SIZE: usize = 4 * 1024 * 1024;

/// Remote `tar` commands (archive, listing, extract) run with this budget.
const REMOTE_TAR_TIMEOUT_SECS: u64 = 120;

/// `sftp/stat` — metadata for one remote path. Uses lstat semantics so
/// symlinks are reported as `symlink`, matching the `sftp/list` entries.
pub async fn stat(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<Value, String> {
    let sftp = runtime.sftp(session_id).await?;
    let path = normalize_remote_path(path)?;
    let metadata = sftp
        .lock()
        .await
        .symlink_metadata(path.clone())
        .await
        .map_err(|error| format!("SFTP stat failed: {error}"))?;
    let kind = match metadata.file_type() {
        FileType::File => "file",
        FileType::Dir => "directory",
        FileType::Symlink => "symlink",
        FileType::Other => "other",
    };
    Ok(json!({
        "path": path,
        "kind": kind,
        "size": metadata.size,
        "modifiedAt": metadata.mtime.map(u64::from),
        "mode": metadata.permissions.map(format_mode),
        "owner": metadata
            .user
            .clone()
            .or_else(|| metadata.uid.map(|uid| uid.to_string())),
        "group": metadata
            .group
            .clone()
            .or_else(|| metadata.gid.map(|gid| gid.to_string())),
    }))
}

/// `sftp/exists` — `true` when the path is statable (dangling symlinks count).
pub async fn exists(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<bool, String> {
    let sftp = runtime.sftp(session_id).await?;
    let path = normalize_remote_path(path)?;
    let exists = sftp.lock().await.symlink_metadata(path).await.is_ok();
    Ok(exists)
}

/// `sftp/touch` — creates an empty file when missing, otherwise refreshes
/// mtime/atime. Servers that reject SETSTAT times make the refresh a no-op,
/// mirroring tiny-rdm's create-only `Touch`.
pub async fn touch(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
    let sftp = runtime.sftp(session_id).await?;
    let path = normalize_remote_path(path)?;
    let session = sftp.lock().await;
    if session.symlink_metadata(path.clone()).await.is_ok() {
        let now = current_unix_secs();
        let times = FileAttributes {
            atime: Some(now),
            mtime: Some(now),
            ..FileAttributes::default()
        };
        // Unsupported (or unpermitted) utime is not an error for touch.
        let _ = session.set_metadata(path, times).await;
        return Ok(());
    }
    let file = session
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::WRITE)
        .await
        .map_err(sftp_error)?;
    drop(file);
    Ok(())
}

/// `sftp/write` — direct write for small files: base64 payload in, temporary
/// `.dbx-part-<uuid>` file out, atomic rename onto the target.
pub async fn write_file(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    data_base64: &str,
) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
    let data = decode_direct_write_payload(data_base64)?;
    let sftp = runtime.sftp(session_id).await?;
    let path = normalize_remote_path(path)?;
    let task_id = Uuid::new_v4().to_string();
    let (temporary, backup) = direct_write_paths(&path, &task_id);
    {
        let session = sftp.lock().await;
        let mut file = session
            .create(temporary.clone())
            .await
            .map_err(sftp_error)?;
        if let Err(error) = file.write_all(&data).await {
            drop(file);
            let _ = session.remove_file(temporary.clone()).await;
            return Err(format!("SFTP write failed: {error}"));
        }
        if let Err(error) = file.flush().await {
            drop(file);
            let _ = session.remove_file(temporary.clone()).await;
            return Err(format!("SFTP write flush failed: {error}"));
        }
    }
    commit_temporary_file(&sftp, &temporary, &path, &backup).await
}

/// `sftp/archive` — packs multiple remote paths into `archive_path` with a
/// remote `tar -czf`. The archive is built at `<archive_path>.tmp` and renamed
/// into place only after tar succeeds. Returns `{path, size}`.
pub async fn archive(
    runtime: &SshRuntime,
    session_id: &str,
    source_paths: &[String],
    archive_path: &str,
) -> Result<Value, String> {
    runtime.ensure_writable(session_id).await?;
    let sources = clean_source_paths(source_paths)?;
    let target = normalize_remote_path(archive_path)?;
    let parent = common_parent_dir(&sources);
    let relatives = sources
        .iter()
        .map(|source| relative_to_parent(source, &parent))
        .collect::<Vec<_>>();
    let temporary = format!("{target}.tmp");
    let command = build_archive_command(&temporary, &parent, &relatives);
    let outcome = runtime
        .exec(
            session_id,
            None,
            &command,
            false,
            Some(REMOTE_TAR_TIMEOUT_SECS),
        )
        .await?;
    let sftp = runtime.sftp(session_id).await?;
    if let Err(error) = check_exec_success(&outcome, "archive") {
        let _ = sftp.lock().await.remove_file(temporary).await;
        return Err(error);
    }
    // tar -czf would have replaced an existing archive; mirror that by
    // dropping a stale target before the rename (plain SFTP rename does not
    // overwrite).
    let session = sftp.lock().await;
    if session.metadata(target.clone()).await.is_ok() {
        session.remove_file(target.clone()).await.map_err(|error| {
            format!("SFTP archive target already exists and could not be replaced: {error}")
        })?;
    }
    if let Err(error) = session.rename(temporary.clone(), target.clone()).await {
        let _ = session.remove_file(temporary).await;
        return Err(sftp_error(error));
    }
    let size = session
        .metadata(target.clone())
        .await
        .ok()
        .and_then(|metadata| metadata.size)
        .unwrap_or(0);
    Ok(json!({ "path": target, "size": size }))
}

/// `sftp/extract` — unpacks a remote `.tar.gz`/`.tgz`/`.tar` archive into
/// `destination_path` after `mkdir -p`. With `overwrite` disabled the member
/// listing is compared against the destination first and any name collision
/// aborts before anything is written. `.zip` is unsupported.
pub async fn extract(
    runtime: &SshRuntime,
    session_id: &str,
    archive_path: &str,
    destination_path: &str,
    overwrite: bool,
) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
    let archive = normalize_remote_path(archive_path)?;
    let destination = normalize_remote_path(destination_path)?;
    let compressed = tar_z_flag(&archive)?;
    // Listing first validates the archive and yields its top-level entries.
    let listing = runtime
        .exec(
            session_id,
            None,
            &build_tar_list_command(&archive, compressed),
            false,
            Some(REMOTE_TAR_TIMEOUT_SECS),
        )
        .await?;
    check_exec_success(&listing, "archive listing")?;
    let members = listing
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let top_entries = unique_top_level_entries(members);
    if top_entries.is_empty() {
        return Err("Archive is empty or could not be listed".to_string());
    }
    if !overwrite {
        let sftp = runtime.sftp(session_id).await?;
        let session = sftp.lock().await;
        for entry in &top_entries {
            let candidate = format!("{}/{}", destination.trim_end_matches('/'), entry);
            if session.symlink_metadata(candidate).await.is_ok() {
                return Err(format!(
                    "Destination already contains '{entry}'; pass overwrite to replace it"
                ));
            }
        }
    }
    let outcome = runtime
        .exec(
            session_id,
            None,
            &build_extract_command(&archive, &destination, compressed),
            false,
            Some(REMOTE_TAR_TIMEOUT_SECS),
        )
        .await?;
    check_exec_success(&outcome, "extract")
}

// ---------------------------------------------------------------------------
// Helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

/// Single-quote shell escaping for embedding a path in a remote command;
/// byte-for-byte compatible with `exec::shell_quote`.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Octal permission string in `0755` style (type bits masked away).
fn format_mode(value: u32) -> String {
    format!("{:04o}", value & 0o7777)
}

fn current_unix_secs() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as u32)
        .unwrap_or(0)
}

fn sftp_error(error: impl std::fmt::Display) -> String {
    format!("SFTP operation failed: {error}")
}

/// Decodes a base64 payload and enforces the direct-write size cap.
fn decode_direct_write_payload(data_base64: &str) -> Result<Vec<u8>, String> {
    let data = BASE64_STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid base64 file data: {error}"))?;
    ensure_direct_write_size(data.len())?;
    Ok(data)
}

fn ensure_direct_write_size(size: usize) -> Result<(), String> {
    if size > MAX_DIRECT_WRITE_SIZE {
        Err(format!(
            "Direct SFTP writes are limited to {MAX_DIRECT_WRITE_SIZE} bytes; use the streaming upload slot (sftp/upload/start) instead"
        ))
    } else {
        Ok(())
    }
}

/// Temporary and backup names placed next to the write target, mirroring the
/// `.dbx-upload-<task>.part` pattern of the streaming upload path.
fn direct_write_paths(target: &str, task_id: &str) -> (String, String) {
    let (parent, _) = target.rsplit_once('/').unwrap_or(("/", ""));
    let parent = if parent.is_empty() { "/" } else { parent };
    let base = format!("{}/.dbx-part-{task_id}", parent.trim_end_matches('/'));
    (base.clone(), format!("{base}.backup"))
}

/// Renames a finished temporary file onto its target; an existing target is
/// moved aside first and restored if the rename fails.
async fn commit_temporary_file(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: &str,
    backup: &str,
) -> Result<(), String> {
    let target_exists = sftp.lock().await.metadata(target.to_string()).await.is_ok();
    if target_exists {
        sftp.lock()
            .await
            .rename(target.to_string(), backup.to_string())
            .await
            .map_err(sftp_error)?;
    }
    if let Err(error) = sftp
        .lock()
        .await
        .rename(temporary.to_string(), target.to_string())
        .await
    {
        if target_exists {
            let _ = sftp
                .lock()
                .await
                .rename(backup.to_string(), target.to_string())
                .await;
        }
        let _ = sftp.lock().await.remove_file(temporary.to_string()).await;
        return Err(sftp_error(error));
    }
    if target_exists {
        let _ = sftp.lock().await.remove_file(backup.to_string()).await;
    }
    Ok(())
}

/// Trims, drops blanks and normalizes every source path; errors when nothing
/// usable remains.
fn clean_source_paths(source_paths: &[String]) -> Result<Vec<String>, String> {
    let mut cleaned = Vec::new();
    for source in source_paths {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            continue;
        }
        cleaned.push(normalize_remote_path(trimmed)?);
    }
    if cleaned.is_empty() {
        return Err("At least one source path is required".to_string());
    }
    Ok(cleaned)
}

/// Longest common ancestor directory of the given absolute paths, ported from
/// tiny-rdm's `commonParentDir` with one fix: the last component of a sole
/// path is dropped, so archiving a single file still yields a usable `-C`
/// directory instead of the file itself.
fn common_parent_dir(paths: &[String]) -> String {
    let ancestors = paths
        .iter()
        .map(|path| {
            let mut components: Vec<&str> = path.trim_end_matches('/').split('/').collect();
            components.pop();
            components
        })
        .collect::<Vec<_>>();
    let mut common = ancestors.first().cloned().unwrap_or_default();
    for ancestor in &ancestors[1..] {
        let limit = common.len().min(ancestor.len());
        let mut shared = 0;
        while shared < limit && common[shared] == ancestor[shared] {
            shared += 1;
        }
        common.truncate(shared);
    }
    if common.len() <= 1 {
        return "/".to_string();
    }
    format!("/{}", common[1..].join("/"))
}

/// Path of `path` relative to its ancestor `parent` (result of
/// [`common_parent_dir`); `"."` as a defensive fallback, like tiny-rdm.
fn relative_to_parent(path: &str, parent: &str) -> String {
    let prefix = if parent == "/" { "" } else { parent };
    let relative = path.strip_prefix(&format!("{prefix}/")).unwrap_or(path);
    if relative.is_empty() {
        ".".to_string()
    } else {
        relative.to_string()
    }
}

/// `tar -czf <tmp> -C <parent> <rel...>` with every argument shell-quoted.
fn build_archive_command(temporary: &str, parent: &str, relatives: &[String]) -> String {
    let members = relatives
        .iter()
        .map(|relative| shell_quote(relative))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "tar -czf {} -C {} {}",
        shell_quote(temporary),
        shell_quote(parent),
        members
    )
}

/// `tar -t[z]f <archive>` — member listing used by the overwrite pre-check.
fn build_tar_list_command(archive: &str, compressed: bool) -> String {
    let z_flag = if compressed { "z" } else { "" };
    format!("tar -t{z_flag}f {}", shell_quote(archive))
}

/// `mkdir -p <dest> && tar -x[z]f <archive> -C <dest>`.
fn build_extract_command(archive: &str, destination: &str, compressed: bool) -> String {
    let z_flag = if compressed { "z" } else { "" };
    format!(
        "mkdir -p {} && tar -x{z_flag}f {} -C {}",
        shell_quote(destination),
        shell_quote(archive),
        shell_quote(destination)
    )
}

/// Whether the archive name calls for the gzip `z` flag; `.zip` and anything
/// else are rejected, matching tiny-rdm's tar-only support.
fn tar_z_flag(archive: &str) -> Result<bool, String> {
    let name = archive.to_ascii_lowercase();
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Ok(true)
    } else if name.ends_with(".tar") {
        Ok(false)
    } else if name.ends_with(".zip") {
        Err(
            "unsupported archive type: .zip archives are not supported, re-pack as .tar.gz"
                .to_string(),
        )
    } else {
        Err(format!(
            "unsupported archive type '{archive}': only .tar.gz, .tgz and .tar are supported"
        ))
    }
}

/// Distinct top-level entry names from a `tar -t` listing. `./dir/file`,
/// `dir/` and `name` all reduce to their first component; `..` members and
/// blank lines are ignored.
fn unique_top_level_entries(listing: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for line in listing.lines() {
        let trimmed = line.trim().trim_start_matches("./");
        let name = trimmed.split('/').next().unwrap_or_default();
        if name.is_empty() || name == ".." {
            continue;
        }
        if seen.insert(name.to_string()) {
            entries.push(name.to_string());
        }
    }
    entries
}

/// Turns an exec outcome (`{success, output, exitCode}`) into an error when
/// the remote command failed.
fn check_exec_success(outcome: &Value, operation: &str) -> Result<(), String> {
    let exit_code = outcome
        .get("exitCode")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if exit_code == 0 {
        Ok(())
    } else {
        let output = outcome
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        Err(format!(
            "{operation} exited with status {exit_code}: {output}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(shell_quote("/var/log/app log"), "'/var/log/app log'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("a'b'c"), r"'a'\''b'\''c'");
        assert_eq!(shell_quote("'; rm -rf /"), r"''\''; rm -rf /'");
    }

    #[test]
    fn format_mode_masks_type_bits() {
        assert_eq!(format_mode(0o100644), "0644");
        assert_eq!(format_mode(0o040755), "0755");
        assert_eq!(format_mode(0o120777), "0777");
    }

    #[test]
    fn common_parent_dir_handles_single_and_nested_paths() {
        // Single file: the file name is dropped, unlike tiny-rdm.
        assert_eq!(
            common_parent_dir(&["/var/log/app.log".to_string()]),
            "/var/log"
        );
        // Siblings share their directory.
        assert_eq!(
            common_parent_dir(&["/a/b.txt".to_string(), "/a/c.txt".to_string()]),
            "/a"
        );
        // Nested sources keep the deeper shared directory.
        assert_eq!(
            common_parent_dir(&["/a/b/c.txt".to_string(), "/a/b/d/e.txt".to_string()]),
            "/a/b"
        );
        // Disjoint paths fall back to the root.
        assert_eq!(
            common_parent_dir(&["/x/1".to_string(), "/y/2".to_string()]),
            "/"
        );
        // A source that is itself an ancestor archives relative to its parent.
        assert_eq!(
            common_parent_dir(&["/tmp".to_string(), "/tmp/a.txt".to_string()]),
            "/"
        );
    }

    #[test]
    fn relative_to_parent_strips_the_common_directory() {
        assert_eq!(
            relative_to_parent("/var/log/app.log", "/var/log"),
            "app.log"
        );
        assert_eq!(relative_to_parent("/a/b/c", "/a"), "b/c");
        assert_eq!(relative_to_parent("/etc", "/"), "etc");
    }

    #[test]
    fn archive_command_quotes_every_argument() {
        let command = build_archive_command(
            "/tmp/arc.tar.gz.tmp",
            "/var/log",
            &["my app.log".to_string(), "it's".to_string()],
        );
        assert_eq!(
            command,
            "tar -czf '/tmp/arc.tar.gz.tmp' -C '/var/log' 'my app.log' 'it'\\''s'"
        );
    }

    #[test]
    fn tar_z_flag_dispatches_by_extension() {
        assert!(tar_z_flag("/tmp/a.tar.gz").unwrap());
        assert!(tar_z_flag("/tmp/a.TGZ").unwrap());
        assert!(!tar_z_flag("/tmp/a.tar").unwrap());
        let zip = tar_z_flag("/tmp/a.zip").unwrap_err();
        assert!(zip.contains("unsupported"), "{zip}");
        assert!(tar_z_flag("/tmp/a.rar").is_err());
    }

    #[test]
    fn tar_commands_carry_the_z_flag_and_destination() {
        assert_eq!(
            build_tar_list_command("/tmp/a.tgz", true),
            "tar -tzf '/tmp/a.tgz'"
        );
        assert_eq!(
            build_extract_command("/tmp/a.tar", "/opt/app", false),
            "mkdir -p '/opt/app' && tar -xf '/tmp/a.tar' -C '/opt/app'"
        );
        assert_eq!(
            build_extract_command("/tmp/a.tgz", "/opt/app", true),
            "mkdir -p '/opt/app' && tar -xzf '/tmp/a.tgz' -C '/opt/app'"
        );
    }

    #[test]
    fn top_level_entries_reduce_tar_listings() {
        assert_eq!(
            unique_top_level_entries("./dir1/\n./dir1/a.txt\ndir2/b/c\nroot.txt\n"),
            vec![
                "dir1".to_string(),
                "dir2".to_string(),
                "root.txt".to_string()
            ]
        );
        // Path traversal members and noise never produce entries.
        assert!(unique_top_level_entries("../evil\n..\n\n").is_empty());
    }

    #[test]
    fn direct_write_size_limit_rejects_oversized_payloads() {
        assert_eq!(ensure_direct_write_size(0).unwrap(), ());
        assert_eq!(ensure_direct_write_size(MAX_DIRECT_WRITE_SIZE).unwrap(), ());
        let error = ensure_direct_write_size(MAX_DIRECT_WRITE_SIZE + 1).unwrap_err();
        assert!(error.contains("streaming upload"), "{error}");
    }

    #[test]
    fn decode_direct_write_payload_handles_base64_edges() {
        assert_eq!(decode_direct_write_payload("").unwrap(), Vec::<u8>::new());
        assert_eq!(
            decode_direct_write_payload("aGVsbG8=").unwrap(),
            b"hello".to_vec()
        );
        // Exactly 4 MiB of decoded zeros stays within the cap (boundary).
        let boundary = format!("{}AA==", "A".repeat(4 * (MAX_DIRECT_WRITE_SIZE - 1) / 3));
        assert!(decode_direct_write_payload(&boundary).is_ok());
        assert!(decode_direct_write_payload("not*base64").is_err());
    }

    #[test]
    fn direct_write_paths_live_next_to_the_target() {
        let (temporary, backup) = direct_write_paths("/home/user/file.txt", "abc");
        assert_eq!(temporary, "/home/user/.dbx-part-abc");
        assert_eq!(backup, "/home/user/.dbx-part-abc.backup");
        let (root_temp, _) = direct_write_paths("/file.txt", "abc");
        assert_eq!(root_temp, "/.dbx-part-abc");
    }

    #[test]
    fn exec_failures_report_status_and_output() {
        assert!(check_exec_success(&json!({ "exitCode": 0 }), "extract").is_ok());
        let error =
            check_exec_success(&json!({ "exitCode": 2, "output": "tar: eof\n" }), "archive")
                .unwrap_err();
        assert!(error.starts_with("archive exited with status 2: tar: eof"));
    }
}

// ---------------------------------------------------------------------------
// main.rs registration
// ---------------------------------------------------------------------------
// `mod sftp_ext;` is declared next to the other module declarations. The
// match arms below drop into `Plugin::handle_request` (parameters follow the
// existing camelCase convention):
//
//     "sftp/stat" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let path = required_string(&params, "path")?;
//         self.runtime
//             .block_on(sftp_ext::stat(&self.ssh, session_id, path))
//     }
//     "sftp/exists" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let path = required_string(&params, "path")?;
//         let exists = self
//             .runtime
//             .block_on(sftp_ext::exists(&self.ssh, session_id, path))?;
//         Ok(json!({ "exists": exists }))
//     }
//     "sftp/touch" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let path = required_string(&params, "path")?;
//         self.runtime
//             .block_on(sftp_ext::touch(&self.ssh, session_id, path))?;
//         Ok(json!({ "success": true }))
//     }
//     "sftp/write" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let remote_path = required_string(&params, "remotePath")?;
//         let data_base64 = required_string(&params, "dataBase64")?;
//         self.runtime.block_on(sftp_ext::write_file(
//             &self.ssh,
//             session_id,
//             remote_path,
//             data_base64,
//         ))?;
//         Ok(json!({ "success": true }))
//     }
//     "sftp/archive" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let source_paths = params
//             .get("sourcePaths")
//             .and_then(Value::as_array)
//             .ok_or("Missing sourcePaths")?
//             .iter()
//             .map(|value| {
//                 value
//                     .as_str()
//                     .map(str::to_string)
//                     .ok_or_else(|| "sourcePaths must be strings".to_string())
//             })
//             .collect::<Result<Vec<String>, String>>()?;
//         let archive_path = required_string(&params, "archivePath")?;
//         self.runtime.block_on(sftp_ext::archive(
//             &self.ssh,
//             session_id,
//             &source_paths,
//             archive_path,
//         ))
//     }
//     "sftp/extract" => {
//         let session_id = required_string(&params, "sessionId")?;
//         let archive_path = required_string(&params, "archivePath")?;
//         let destination_path = required_string(&params, "destinationPath")?;
//         let overwrite = params
//             .get("overwrite")
//             .and_then(Value::as_bool)
//             .unwrap_or(false);
//         self.runtime.block_on(sftp_ext::extract(
//             &self.ssh,
//             session_id,
//             archive_path,
//             destination_path,
//             overwrite,
//         ))?;
//         Ok(json!({ "success": true }))
//     }
