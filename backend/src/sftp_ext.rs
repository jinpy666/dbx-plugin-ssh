//! Extended SFTP operations (stat/touch/direct-write/archive), mirroring tiny-rdm.
#![allow(dead_code)] // entry points are wired in main.rs; see the snippet at the bottom

use std::collections::HashSet;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::model::normalize_remote_path;
use crate::ssh::{apply_preserved_permissions, lookup_owner_group_names, SshRuntime};

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
    // SFTP 协议默认只返回 uid/gid 数字，user/group 字段为 None。
    // 如果 russh-sftp 没拿到名字，远程跑 `stat -c '%U %G'` 查。
    let (owner_name, group_name) = match (metadata.user.clone(), metadata.group.clone()) {
        (Some(u), Some(g)) if !u.is_empty() && !g.is_empty() => (Some(u), Some(g)),
        _ => lookup_owner_group_names(runtime, session_id, &path).await,
    };
    let owner_display = owner_name
        .clone()
        .or_else(|| metadata.uid.map(|u| u.to_string()));
    let group_display = group_name
        .clone()
        .or_else(|| metadata.gid.map(|g| g.to_string()));
    Ok(json!({
        "path": path,
        "kind": kind,
        "size": metadata.size,
        "modifiedAt": metadata.mtime.map(u64::from),
        "mode": metadata.permissions.map(format_mode),
        "owner": owner_display,
        "group": group_display,
        "ownerName": owner_name,
        "ownerUid": metadata.uid,
        "groupName": group_name,
        "groupGid": metadata.gid,
    }))
}

/// `sftp/exists` — `true` when the path is statable (dangling symlinks count).
pub async fn exists(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<bool, String> {
    let sftp = runtime.sftp(session_id).await?;
    let path = normalize_remote_path(path)?;
    let exists = sftp.lock().await.symlink_metadata(path).await.is_ok();
    Ok(exists)
}

/// Upper bound for `name(1)..name(999)` collision probing in
/// [`rename_unique`]; also bounds how long the SFTP mutex is held.
pub const UNIQUE_NAME_PROBE_LIMIT: u32 = 999;

/// Longest accepted file name (chars) for the unique-name probe.
const MAX_UNIQUE_NAME_CHARS: usize = 255;

/// `sftp/rename-unique` — suggests a non-conflicting file name inside `dir`
/// for an upload about to land there. `name` itself wins when free, otherwise
/// `name(1)` .. `name(999)` are probed (the `(n)` is inserted before the last
/// extension: `report.pdf` -> `report(1).pdf`). Returns `{name, conflict}`.
pub async fn rename_unique(
    runtime: &SshRuntime,
    session_id: &str,
    dir: &str,
    name: &str,
) -> Result<Value, String> {
    let sftp = runtime.sftp(session_id).await?;
    let dir = normalize_remote_path(dir)?;
    let clean = clean_unique_name(name)?;
    let session = sftp.lock().await;
    let probe = |candidate: &str| {
        let full = join_remote_name(&dir, candidate);
        session.symlink_metadata(full)
    };
    for (index, candidate) in unique_name_candidates(&clean).into_iter().enumerate() {
        if probe(&candidate).await.is_err() {
            return Ok(json!({ "name": candidate, "conflict": index > 0 }));
        }
    }
    Err(format!(
        "No unique name derived from '{clean}' within {UNIQUE_NAME_PROBE_LIMIT} attempts"
    ))
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
    let data = decode_direct_write_payload(data_base64)?;
    // write_bytes runs the write gate (ensure_writable) — no second check here.
    write_bytes(runtime, session_id, path, &data).await
}

/// In-memory variant of [`write_file`] shared with the watcher round-trip
/// (`watch/upload`): the bytes are already sidecar-resident, so no base64
/// detour and no 4 MiB direct-write cap applies here — the caller owns the
/// size policy. Stages through `.dbx-part-<uuid>` and renames atomically,
/// preserving the target's permission bits (issue #37).
pub async fn write_bytes(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    data: &[u8],
) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
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
        if let Err(error) = file.write_all(data).await {
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
// Symlinks
// ---------------------------------------------------------------------------

/// `sftp/symlink-create` — creates `link_path` pointing at `target`.
/// `target` keeps its original form (absolute or relative): relative targets
/// are the normal way to build relocatable links, so normalizing it would
/// silently change what the link resolves to.
pub async fn symlink_create(
    runtime: &SshRuntime,
    session_id: &str,
    target: &str,
    link_path: &str,
) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
    let target = clean_link_target(target)?;
    let link_path = normalize_remote_path(link_path)?;
    let sftp = runtime.sftp(session_id).await?;
    // Spike result (russh-sftp 3.0.0, src/client/rawsession.rs:709 +
    // protocol/symlink.rs): the wire order is (linkpath, targetpath), which is
    // the *draft* order — but OpenSSH's server reads (target, linkpath) and
    // pkg/sftp ships the swap for exactly this reason (packet.go, "the order
    // ... was inadvertently reversed"). Calling with swapped arguments makes
    // the link land on `link_path` pointing at `target` on OpenSSH and every
    // OpenSSH-compatible sftp-server.
    sftp.lock()
        .await
        .symlink(target.clone(), link_path.clone())
        .await
        .map_err(|error| format!("SFTP symlink-create failed: {error}"))?;
    Ok(())
}

/// `sftp/symlink-read` — resolves `link_path` to its target string.
pub async fn symlink_read(
    runtime: &SshRuntime,
    session_id: &str,
    link_path: &str,
) -> Result<Value, String> {
    let link_path = normalize_remote_path(link_path)?;
    let sftp = runtime.sftp(session_id).await?;
    let target = sftp
        .lock()
        .await
        .read_link(link_path.clone())
        .await
        .map_err(|error| format!("SFTP symlink-read failed: {error}"))?;
    Ok(json!({ "linkPath": link_path, "target": target }))
}

/// `sftp/symlink-update` — repoints an existing symlink. SFTP v3 has no
/// re-link primitive, so the update is read-compare, then remove + recreate;
/// when the requested target already matches the call is a no-op.
pub async fn symlink_update(
    runtime: &SshRuntime,
    session_id: &str,
    link_path: &str,
    target: &str,
) -> Result<(), String> {
    runtime.ensure_writable(session_id).await?;
    let target = clean_link_target(target)?;
    let link_path = normalize_remote_path(link_path)?;
    let sftp = runtime.sftp(session_id).await?;
    let session = sftp.lock().await;
    if session
        .read_link(link_path.clone())
        .await
        .map(|current| current == target)
        .unwrap_or(false)
    {
        return Ok(());
    }
    session
        .remove_file(link_path.clone())
        .await
        .map_err(|error| format!("SFTP symlink-update could not remove the old link: {error}"))?;
    // Same swapped-argument order as symlink_create (OpenSSH wire order).
    session
        .symlink(target, link_path)
        .await
        .map_err(|error| format!("SFTP symlink-update failed: {error}"))
}

/// Validates a symlink target: symlink targets travel verbatim inside the
/// SFTP SYMLINK packet (no shell involved), so only NUL and emptiness are
/// rejected; leading/trailing blanks are kept meaningful on purpose.
fn clean_link_target(target: &str) -> Result<String, String> {
    if target.is_empty() || target.contains('\0') {
        return Err("Symlink target is empty or invalid".to_string());
    }
    Ok(target.to_string())
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
/// moved aside first and restored if the rename fails. The target's
/// permission bits ride along onto the staged file, so an overwritten script
/// keeps its executable bit (issue #37).
async fn commit_temporary_file(
    sftp: &Arc<AsyncMutex<SftpSession>>,
    temporary: &str,
    target: &str,
    backup: &str,
) -> Result<(), String> {
    let target_attributes = sftp.lock().await.metadata(target.to_string()).await.ok();
    apply_preserved_permissions(sftp, temporary, target_attributes.as_ref()).await?;
    let target_exists = target_attributes.is_some();
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

/// Validates and bounds a caller-provided file name for the unique-name
/// probe: no path separators, no `.`/`..`, capped length.
fn clean_unique_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("File name is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("File name must not contain path separators".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("File name must not be a relative path component".to_string());
    }
    Ok(trimmed.chars().take(MAX_UNIQUE_NAME_CHARS).collect())
}

/// The n-th collision candidate: `(n)` inserted before the last extension
/// (`report.pdf` -> `report(1).pdf`); names without a usable extension get a
/// suffix instead (`report` -> `report(1)`, `.bashrc` -> `.bashrc(1)`).
fn unique_name_candidate(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(index) if index > 0 => format!("{}({n}){}", &name[..index], &name[index..]),
        _ => format!("{name}({n})"),
    }
}

/// Full probe order for a name: the plain name first, then the bounded
/// `name(1)..name(999)` collision candidates.
fn unique_name_candidates(name: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(UNIQUE_NAME_PROBE_LIMIT as usize + 1);
    candidates.push(name.to_string());
    for n in 1..=UNIQUE_NAME_PROBE_LIMIT {
        candidates.push(unique_name_candidate(name, n));
    }
    candidates
}

/// Pure decision core of [`rename_unique`]: the first candidate the `exists`
/// probe reports as free, paired with whether a `(n)` rename was needed.
fn next_unique_name<F>(name: &str, mut exists: F) -> Option<(String, bool)>
where
    F: FnMut(&str) -> bool,
{
    for (index, candidate) in unique_name_candidates(name).into_iter().enumerate() {
        if !exists(&candidate) {
            return Some((candidate, index > 0));
        }
    }
    None
}

/// Joins a normalized directory with a bare file name (`/` root included).
fn join_remote_name(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
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

// —— 外部编辑器回传上传（watch/upload 后端；remote-edit 目录防逃逸）——
pub const MAX_UPLOAD_LOCAL_SIZE: u64 = 256 * 1024 * 1024;

/// Copy buffer for the streaming local→SFTP push.
const UPLOAD_LOCAL_CHUNK: usize = 128 * 1024;

// `sftp/upload-local {sessionId, localPath, remotePath} -> {path, size}` —
/// Path-origin gate for the external-editor round-trip: only files this
/// plugin downloaded into `<downloads>/remote-edit/` may cross the bridge.
/// `pub(crate)` because `file_watch` reuses it for `watch/start` and
/// `watch/upload` — the watchId is a bearer token, the real boundary is the
/// path origin.
pub(crate) fn validate_remote_edit_path(
    local_path: &Path,
    data_dir: &Path,
    lookup: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    let downloads = crate::local_downloads::downloads_base_dir(lookup, data_dir);
    validate_remote_edit_root(local_path, &downloads)
}

/// The prefix check with a pinned downloads base — the seam `file_watch`
/// tests use so validation does not depend on the runner's real Downloads
/// directory. Production callers go through [`validate_remote_edit_path`].
pub(crate) fn validate_remote_edit_root(
    local_path: &Path,
    downloads: &Path,
) -> Result<PathBuf, String> {
    if !local_path.is_absolute() {
        return Err("localPath must be an absolute path".to_string());
    }
    let canonical = local_path.canonicalize().map_err(|error| {
        format!(
            "Local file '{}' does not exist: {error}",
            local_path.display()
        )
    })?;
    let root = downloads.join("remote-edit");
    let root = root
        .canonicalize()
        .map_err(|_| "Local file is not inside the remote-edit directory".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("Only files inside the remote-edit directory can be uploaded".to_string());
    }
    Ok(canonical)
}

pub async fn upload_watched_file(
    runtime: &SshRuntime,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<Value, String> {
    runtime.ensure_writable(session_id).await?;
    let local =
        validate_remote_edit_path(Path::new(local_path.trim()), &runtime.data_dir(), |key| {
            std::env::var_os(key)
        })?;
    let size = tokio::fs::metadata(&local)
        .await
        .map_err(|error| format!("Local file '{}' is unreadable: {error}", local.display()))?
        .len();
    if size > MAX_UPLOAD_LOCAL_SIZE {
        return Err(format!(
            "Remote-edit uploads are limited to {MAX_UPLOAD_LOCAL_SIZE} bytes"
        ));
    }
    let remote_path = normalize_remote_path(remote_path)?;
    let sftp = runtime.sftp(session_id).await?;
    let task_id = Uuid::new_v4().to_string();
    let (temporary, backup) = direct_write_paths(&remote_path, &task_id);
    {
        let session = sftp.lock().await;
        let mut file = session
            .create(temporary.clone())
            .await
            .map_err(sftp_error)?;
        let mut reader = match tokio::fs::File::open(&local).await {
            Ok(reader) => reader,
            Err(error) => {
                let _ = session.remove_file(temporary.clone()).await;
                return Err(format!(
                    "Local file '{}' is unreadable: {error}",
                    local.display()
                ));
            }
        };
        let mut buffer = vec![0u8; UPLOAD_LOCAL_CHUNK];
        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    drop(file);
                    let _ = session.remove_file(temporary.clone()).await;
                    return Err(format!(
                        "Local file '{}' read failed: {error}",
                        local.display()
                    ));
                }
            };
            if let Err(error) = file.write_all(&buffer[..read]).await {
                drop(file);
                let _ = session.remove_file(temporary.clone()).await;
                return Err(format!("SFTP write failed: {error}"));
            }
        }
        if let Err(error) = file.flush().await {
            drop(file);
            let _ = session.remove_file(temporary.clone()).await;
            return Err(format!("SFTP write flush failed: {error}"));
        }
    }
    commit_temporary_file(&sftp, &temporary, &remote_path, &backup).await?;
    Ok(json!({ "path": remote_path, "size": size }))
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

    /// M15 watch/upload 并发回传隔离证明：`write_bytes`（`watch/upload` 的
    /// 提交路径）在每次调用里生成一个新的 `Uuid::new_v4()` 作为 task_id，
    /// 因此并发回传——无论是同一个远端文件还是不同文件——各自的
    /// `.dbx-part-<uuid>` 临时文件与 backup 都互不重名，最后一步的原子
    /// rename 各自落到各自目标上，互不干扰。
    #[test]
    fn concurrent_write_bytes_calls_never_share_a_staging_file() {
        // Simulate N concurrent round-trips exactly as write_bytes names
        // them: one fresh uuid per in-flight call.
        let mut task_ids: Vec<String> = Vec::new();
        for _ in 0..64 {
            task_ids.push(uuid::Uuid::new_v4().to_string());
        }
        assert_eq!(
            task_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            64,
            "uuid task ids are unique per call"
        );
        // Same target: every concurrent commit stages under its own name.
        let mut staging: std::collections::BTreeSet<String> = Default::default();
        for task_id in &task_ids {
            let (temporary, backup) = direct_write_paths("/srv/notes.md", task_id);
            assert!(staging.insert(temporary));
            assert!(staging.insert(backup));
        }
        // Different targets: parents differ, so names can never cross either.
        let (temp_a, backup_a) = direct_write_paths("/srv/a.md", &task_ids[0]);
        let (temp_b, backup_b) = direct_write_paths("/etc/b.conf", &task_ids[1]);
        assert_ne!(temp_a, temp_b);
        assert_ne!(backup_a, backup_b);
        // Every staging name lives next to its own target, never elsewhere.
        assert!(temp_a.starts_with("/srv/") && backup_a.starts_with("/srv/"));
        assert!(temp_b.starts_with("/etc/") && backup_b.starts_with("/etc/"));
    }

    #[test]
    fn exec_failures_report_status_and_output() {
        assert!(check_exec_success(&json!({ "exitCode": 0 }), "extract").is_ok());
        let error =
            check_exec_success(&json!({ "exitCode": 2, "output": "tar: eof\n" }), "archive")
                .unwrap_err();
        assert!(error.starts_with("archive exited with status 2: tar: eof"));
    }

    #[test]
    fn clean_unique_name_rejects_paths_and_bounds_length() {
        assert_eq!(clean_unique_name("  report.pdf ").unwrap(), "report.pdf");
        assert!(clean_unique_name("").is_err());
        assert!(clean_unique_name("a/b.pdf").is_err());
        assert!(clean_unique_name("a\\b.pdf").is_err());
        assert!(clean_unique_name(".").is_err());
        assert!(clean_unique_name("..").is_err());
        let long = "x".repeat(300);
        assert_eq!(clean_unique_name(&long).unwrap().chars().count(), 255);
    }

    #[test]
    fn unique_name_candidate_inserts_before_the_last_extension() {
        assert_eq!(unique_name_candidate("report.pdf", 1), "report(1).pdf");
        assert_eq!(
            unique_name_candidate("archive.tar.gz", 12),
            "archive.tar(12).gz"
        );
        assert_eq!(unique_name_candidate("report", 3), "report(3)");
        // Hidden files keep their leading dot untouched.
        assert_eq!(unique_name_candidate(".bashrc", 2), ".bashrc(2)");
    }

    #[test]
    fn next_unique_name_picks_the_first_free_candidate() {
        let free = |_: &str| false;
        assert_eq!(
            next_unique_name("report.pdf", free),
            Some(("report.pdf".to_string(), false))
        );
        let taken = |candidate: &str| candidate == "report.pdf" || candidate == "report(1).pdf";
        assert_eq!(
            next_unique_name("report.pdf", taken),
            Some(("report(2).pdf".to_string(), true))
        );
        // Exhausting the probe budget yields None (handler turns it into an error).
        let everything = |_: &str| true;
        assert_eq!(next_unique_name("report.pdf", everything), None);
    }

    #[test]
    fn unique_name_candidates_start_with_the_plain_name() {
        let candidates = unique_name_candidates("a.txt");
        assert_eq!(candidates.first().unwrap(), "a.txt");
        assert_eq!(candidates.get(1).unwrap(), "a(1).txt");
        assert_eq!(candidates.len(), (UNIQUE_NAME_PROBE_LIMIT + 1) as usize);
        assert_eq!(candidates.last().unwrap(), "a(999).txt");
    }

    #[test]
    fn join_remote_name_handles_the_root() {
        assert_eq!(join_remote_name("/", "a.txt"), "/a.txt");
        assert_eq!(join_remote_name("/tmp/up", "a.txt"), "/tmp/up/a.txt");
    }

    #[test]
    fn clean_link_target_keeps_relative_paths_and_rejects_junk() {
        // Relative targets are valid symlink semantics and must survive
        // verbatim (no normalization, no shell quoting involved).
        assert_eq!(
            clean_link_target("../shared/data").unwrap(),
            "../shared/data"
        );
        assert_eq!(clean_link_target("/abs/target").unwrap(), "/abs/target");
        // A target that is only blanks is still a valid (if odd) name; only
        // emptiness and NUL are protocol-level junk.
        assert!(clean_link_target("").is_err());
        assert!(clean_link_target("a\0b").is_err());
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
