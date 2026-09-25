//! Sudo-backed filesystem operations, mirroring tiny-rdm's Sudo SFTP surface.
//!
//! Every function shells out through [`SshRuntime::exec`] with `sudo = true`,
//! so Quick Sudo orchestration (password injection, PTY/MFA) and the
//! read-only connection guard apply uniformly without any duplication here.
//! Remote paths are always POSIX single-quoted (embedded quotes become
//! `'\''`), matching tiny-rdm's `shQuoted` helper.

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::model::{normalize_remote_path, sftp_uri, SftpEntry};
use crate::ssh::SshRuntime;

/// Per-command timeouts, sized per operation family (exec clamps to 5..300).
const TIMEOUT_QUICK_SECS: u64 = 30;
const TIMEOUT_LIST_SECS: u64 = 60;
const TIMEOUT_READ_SECS: u64 = 60;
const TIMEOUT_WRITE_SECS: u64 = 120;
/// Raw payload embedded per remote command in [`write_file`]; base64 expands
/// it by ~4/3, keeping the exec request well below channel packet limits.
const WRITE_CHUNK_BYTES: usize = 96 * 1024;

/// Wraps a path in single quotes for safe shell interpolation, replacing any
/// embedded quote with the POSIX `'\''` escape (tiny-rdm's shQuoted).
pub(crate) fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// Runs one command with Quick Sudo and returns its output, failing on a
/// non-zero exit code (mirrors tiny-rdm's execSudoResultMap handling).
pub(crate) async fn sudo_exec(
    runtime: &SshRuntime,
    session_id: &str,
    command: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let response = runtime
        .exec(session_id, None, command, true, Some(timeout_secs))
        .await?;
    let output = response
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let exit_code = response
        .get("exitCode")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if exit_code != 0 {
        return Err(format!("sudo command exited {exit_code}: {output}"));
    }
    Ok(output)
}

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

/// GNU coreutils stat: type|inode|size|mtime|perm|user|uid|group|gid
const GNU_STAT_FORMAT: &str = "%F|%i|%s|%Y|%a|%U|%u|%G|%g";
/// BSD/macOS stat:  type|inode|size|mtime|perm|user|uid|group|gid
const BSD_STAT_FORMAT: &str = "%HT|%i|%z|%m|%Lp|%Su|%u|%Sg|%g";

/// Fields shared by both stat dialects, already normalized for JSON output.
struct StatInfo {
    kind: &'static str,
    size: u64,
    modified_at: u64,
    mode: String,
    owner: String,
    group: String,
    owner_uid: Option<u64>,
    group_gid: Option<u64>,
}

/// Maps a `stat` file-type description (GNU `%F` or BSD `%HT`) to the kind
/// vocabulary used by `sftp/list` entries. GNU prints "regular empty file"
/// for zero-length regular files, hence the prefix match.
fn classify_file_type(file_type: &str) -> &'static str {
    let lowered = file_type.trim().to_ascii_lowercase();
    if lowered == "directory" {
        "directory"
    } else if lowered.starts_with("regular") || lowered == "file" {
        "file"
    } else if lowered.contains("symbolic link") {
        "symlink"
    } else {
        "other"
    }
}

/// Formats numeric permission bits as a 3-4 digit octal string ("0755").
fn format_mode_bits(bits: u32) -> String {
    format!("{:04o}", bits & 0o7777)
}

/// Parses `stat -c '%F|%i|%s|%Y|%a|%U|%u|%G|%g'` output (GNU coreutils).
fn parse_gnu_stat_line(line: &str) -> Option<StatInfo> {
    let fields = line.trim().split('|').collect::<Vec<_>>();
    if fields.len() < 9 {
        return None;
    }
    let mode = u32::from_str_radix(fields[4].trim(), 8).ok()?;
    Some(StatInfo {
        kind: classify_file_type(fields[0]),
        size: fields[2].trim().parse().unwrap_or(0),
        modified_at: fields[3].trim().parse().unwrap_or(0),
        mode: format_mode_bits(mode),
        owner: fields[5].trim().to_string(),
        owner_uid: fields[6].trim().parse().ok(),
        group: fields[7].trim().to_string(),
        group_gid: fields[8].trim().parse().ok(),
    })
}

/// Parses BSD stat output — `stat -f '%HT|%i|%z|%m|%Lp|%Su|%u|%Sg|%g'`.
/// BSD %Lp is decimal st_mode including file-type bits; mask to 0o7777.
fn parse_bsd_stat_line(line: &str) -> Option<StatInfo> {
    let fields = line.trim().split('|').collect::<Vec<_>>();
    if fields.len() < 9 {
        return None;
    }
    let mode = fields[4].trim().parse::<u32>().ok()?;
    Some(StatInfo {
        kind: classify_file_type(fields[0]),
        size: fields[2].trim().parse().unwrap_or(0),
        modified_at: fields[3].trim().parse().unwrap_or(0),
        mode: format_mode_bits(mode),
        owner: fields[5].trim().to_string(),
        owner_uid: fields[6].trim().parse().ok(),
        group: fields[7].trim().to_string(),
        group_gid: fields[8].trim().parse().ok(),
    })
}

/// Returns file metadata via sudo `stat`, trying GNU `stat -c` first and
/// falling back to `stat -f` on BSD-flavoured systems (tiny-rdm StatSudo).
pub async fn stat(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<Value, String> {
    let path = normalize_remote_path(path)?;
    let gnu = format!("stat -c '{}' -- {}", GNU_STAT_FORMAT, shell_quote(&path));
    let parsed = match sudo_exec(runtime, session_id, &gnu, TIMEOUT_QUICK_SECS).await {
        Ok(output) => parse_gnu_stat_line(&output),
        Err(gnu_error) => {
            let bsd = format!("stat -f '{}' -- {}", BSD_STAT_FORMAT, shell_quote(&path));
            match sudo_exec(runtime, session_id, &bsd, TIMEOUT_QUICK_SECS).await {
                Ok(output) => Some(parse_bsd_stat_line(&output).ok_or(gnu_error)?),
                Err(_) => return Err(gnu_error),
            }
        }
    };
    let info = parsed.ok_or_else(|| format!("Could not parse stat output for {path}"))?;
    Ok(json!({
        "path": path,
        "kind": info.kind,
        "size": info.size,
        "modifiedAt": info.modified_at,
        "mode": info.mode,
        "owner": info.owner,
        "group": info.group,
        // GNU/BSD stat 总是会输出 %u / %g，所以数字字段必然有值。
        // owner / group 这里就是用户名/组名字符串，name 和 display 相同。
        "ownerName": info.owner,
        "ownerUid": info.owner_uid,
        "groupName": info.group,
        "groupGid": info.group_gid,
    }))
}

// ---------------------------------------------------------------------------
// exists / touch
// ---------------------------------------------------------------------------

/// Checks path existence with `test -e` (tiny-rdm Exists, sudo-elevated).
/// The `echo` fallback keeps the shell exit code at zero so a missing path is
/// distinguishable from a command failure.
pub async fn exists(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<bool, String> {
    let path = normalize_remote_path(path)?;
    let command = format!("test -e {} && echo 1 || echo 0", shell_quote(&path));
    let output = sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS).await?;
    Ok(output.trim() == "1")
}

/// Creates an empty file or refreshes its mtime (tiny-rdm Touch).
pub async fn touch(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    let command = format!("touch -- {}", shell_quote(&path));
    sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

/// One parsed `ls -l` row before it is joined with the directory path.
struct LsEntry {
    name: String,
    kind: &'static str,
    size: u64,
    modified_at: Option<u64>,
    permissions: Option<String>,
    owner: Option<String>,
    group: Option<String>,
}

/// Maps a symbolic mode column to the `sftp/list` kind vocabulary.
fn kind_from_mode_string(mode: &str) -> &'static str {
    match mode.as_bytes().first() {
        Some(b'd') => "directory",
        Some(b'l') => "symlink",
        Some(b'-') => "file",
        _ => "other",
    }
}

/// Converts a symbolic mode column ("drwxr-xr-t") into numeric permission
/// bits including setuid/setgid/sticky (0755, 4755, 5755, ...).
fn mode_string_to_octal(mode: &str) -> Option<u32> {
    let bytes = mode.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let mut bits = 0u32;
    for (shift, triad) in [
        (6_usize, &bytes[1..4]),
        (3, &bytes[4..7]),
        (0, &bytes[7..10]),
    ] {
        let mut value = 0u32;
        if triad[0] != b'-' {
            value |= 0o4;
        }
        if triad[1] != b'-' {
            value |= 0o2;
        }
        if matches!(triad[2], b'x' | b's' | b't') {
            value |= 0o1;
        }
        bits |= value << shift;
    }
    match bytes[3] {
        b's' | b'S' => bits |= 0o4000,
        _ => {}
    }
    match bytes[6] {
        b's' | b'S' => bits |= 0o2000,
        _ => {}
    }
    match bytes[9] {
        b't' | b'T' => bits |= 0o1000,
        _ => {}
    }
    Some(bits & 0o7777)
}

/// Undoes the quoting `ls` applies to unusual names when its stdout is a
/// terminal (possible here when `sudo_use_pty` is enabled): the shell-escape
/// style renders `weird name's` as `'weird name'\''s'`.
fn unquote_ls_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("'\\''", "'");
    }
    trimmed.to_string()
}

/// Converts one `ls -la` line into an entry, accepting both the GNU
/// `--time-style=+%s` layout (epoch in field 5, name from field 6) and the
/// classic BusyBox layout (date spread over fields 5-7, name from field 8,
/// mtime unavailable). Returns `None` for headers, `.`, `..`, and unparsable
/// rows such as device files whose size column contains a comma.
fn parse_ls_line(line: &str) -> Option<LsEntry> {
    let line = line.trim_end_matches('\r').trim();
    if line.is_empty() || line.starts_with("total") || line.starts_with("ls:") {
        return None;
    }
    let fields = line.split_whitespace().collect::<Vec<_>>();
    if fields.len() < 7 || fields[0].len() < 10 {
        return None;
    }
    let mode = fields[0];
    let size = fields[4].parse::<u64>().ok()?;
    let (modified_at, name_start) = match fields[5].parse::<u64>() {
        Ok(epoch) => (Some(epoch), 6_usize),
        Err(_) => (None, 8_usize),
    };
    if fields.len() < name_start + 1 {
        return None;
    }
    let mut name = fields[name_start..].join(" ");
    // `ls -l` renders symlinks as "name -> target"; keep only the link name.
    if let Some((head, _)) = name.clone().split_once(" -> ") {
        name = head.to_string();
    }
    let name = unquote_ls_name(&name);
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    // Owner/group sit in fields 3/4 on both layouts and `ls -la` always
    // prints them, so sudo listings get names without an extra round trip.
    let (owner, group) = if fields.len() >= 4 {
        (Some(fields[2].to_string()), Some(fields[3].to_string()))
    } else {
        (None, None)
    };
    Some(LsEntry {
        name,
        kind: kind_from_mode_string(mode),
        size,
        modified_at,
        permissions: mode_string_to_octal(mode).map(format_mode_bits),
        owner,
        group,
    })
}

/// Mirrors the private `content_type_for_path` in `ssh.rs` so sudo listings
/// keep the exact same entry shape as `sftp/list` (it cannot be imported).
fn content_type_for_path(path: &str) -> Option<String> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "txt" | "log" | "md" | "rs" | "ts" | "js" | "json" | "yaml" | "yml" | "toml" | "conf" => {
            "text/plain"
        }
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return None,
    };
    Some(content_type.to_string())
}

/// Parses `ls -la` output into `sftp/list`-shaped entries, sorted exactly
/// like `sftp_list_path`: directories first, then case-insensitive names.
fn parse_ls_output(directory: &str, ls_output: &str) -> Vec<SftpEntry> {
    let base = directory.trim_end_matches('/');
    let mut entries: Vec<SftpEntry> = ls_output
        .lines()
        .filter_map(parse_ls_line)
        .map(|entry| {
            let path = format!("{}/{}", base, entry.name);
            SftpEntry {
                // sudo 提权的 ls 输出已是文本层；没有原始字节可比对。
                lossy: false,
                name: entry.name,
                uri: sftp_uri(&path),
                kind: entry.kind,
                size: Some(entry.size),
                modified_at: entry.modified_at,
                permissions: entry.permissions,
                content_type: content_type_for_path(&path),
                owner: entry.owner,
                group: entry.group,
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries
}

/// Lists a directory via sudo `ls -la` (tiny-rdm ListDirSudo). GNU coreutils
/// render epoch mtimes with `--time-style=+%s`; BusyBox rejects that option,
/// so a plain `ls -la` retry covers classic-date output (mtime omitted).
pub async fn list_dir(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<Value, String> {
    let path = normalize_remote_path(path)?;
    let gnu = format!("ls -la --time-style=+%s -- {}", shell_quote(&path));
    let output = match sudo_exec(runtime, session_id, &gnu, TIMEOUT_LIST_SECS).await {
        Ok(output) => output,
        Err(gnu_error) => {
            let fallback = format!("ls -la -- {}", shell_quote(&path));
            sudo_exec(runtime, session_id, &fallback, TIMEOUT_LIST_SECS)
                .await
                .map_err(|_| gnu_error)?
        }
    };
    let entries = parse_ls_output(&path, &output);
    Ok(json!({ "entries": entries }))
}

// ---------------------------------------------------------------------------
// read_file / write_file
// ---------------------------------------------------------------------------

/// Reads a byte range via sudo `tail -c`/`head -c` and returns it base64
/// encoded (tiny-rdm ReadFileSudo). One extra byte is requested so a short
/// read is detectable without a second round trip; the surplus is trimmed
/// locally and reported through `truncated`.
pub async fn read_file(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    offset: u64,
    length: u64,
) -> Result<Value, String> {
    let path = normalize_remote_path(path)?;
    // tail counts from byte 1, so +1 converts a zero-based offset.
    let head = match (offset, length) {
        (0, 0) => format!("cat -- {} | ", shell_quote(&path)),
        (0, _) => format!(
            "head -c {} -- {} | ",
            length.saturating_add(1),
            shell_quote(&path)
        ),
        (_, 0) => format!(
            "tail -c +{} -- {} | ",
            offset.saturating_add(1),
            shell_quote(&path)
        ),
        (_, _) => format!(
            "tail -c +{} -- {} | head -c {} | ",
            offset.saturating_add(1),
            shell_quote(&path),
            length.saturating_add(1)
        ),
    };
    let command = format!("{head}base64");
    let output = sudo_exec(runtime, session_id, &command, TIMEOUT_READ_SECS).await?;
    let decoded = BASE64_STANDARD
        .decode(
            output
                .bytes()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect::<Vec<u8>>(),
        )
        .map_err(|error| format!("Remote returned invalid base64 data: {error}"))?;
    let truncated = length > 0 && decoded.len() > length as usize;
    let mut data = decoded;
    if truncated {
        data.truncate(length as usize);
    }
    Ok(json!({
        "dataBase64": BASE64_STANDARD.encode(data),
        "truncated": truncated,
    }))
}

/// Writes a file via sudo, embedding the payload as base64 text (tiny-rdm
/// WriteFileSudo). `SshRuntime::exec` exposes no data-stdin channel (its
/// stdin carries the sudo password), so the payload is chunked to
/// [`WRITE_CHUNK_BYTES`] and appended with shell redirection: the first chunk
/// truncates/creates via `>`, later chunks append via `>>`.
pub async fn write_file(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    data_base64: &str,
) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    let data = BASE64_STANDARD
        .decode(
            data_base64
                .bytes()
                .filter(|byte| !byte.is_ascii_whitespace())
                .collect::<Vec<u8>>(),
        )
        .map_err(|error| format!("Invalid base64 file data: {error}"))?;
    if data.is_empty() {
        // `chunks` yields nothing for empty input; create the empty file once.
        let command = format!(": > {}", shell_quote(&path));
        sudo_exec(runtime, session_id, &command, TIMEOUT_WRITE_SECS).await?;
        return Ok(());
    }
    for (index, chunk) in data.chunks(WRITE_CHUNK_BYTES).enumerate() {
        let redirect = if index == 0 { ">" } else { ">>" };
        let command = format!(
            "printf %s '{}' | base64 -d {} {}",
            BASE64_STANDARD.encode(chunk),
            redirect,
            shell_quote(&path)
        );
        sudo_exec(runtime, session_id, &command, TIMEOUT_WRITE_SECS).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// mkdir / remove / remove_all / chmod / rename
// ---------------------------------------------------------------------------

/// Creates a directory (and parents) via sudo `mkdir -p` (tiny-rdm MkdirSudo).
pub async fn mkdir(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    let command = format!("mkdir -p -- {}", shell_quote(&path));
    sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

/// Removes a single file via sudo `rm -f` (tiny-rdm RemoveSudo).
pub async fn remove(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    let command = format!("rm -f -- {}", shell_quote(&path));
    sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

/// Recursively removes a directory tree via sudo `rm -rf` (tiny-rdm
/// RemoveAllSudo). `rm` never follows symlinks: a symlink operand is removed
/// as a link, and symlinks inside a tree are unlinked, not descended into.
pub async fn remove_all(runtime: &SshRuntime, session_id: &str, path: &str) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    if path == "/" {
        return Err("Refusing to recursively delete the filesystem root".to_string());
    }
    let command = format!("rm -rf -- {}", shell_quote(&path));
    sudo_exec(runtime, session_id, &command, TIMEOUT_WRITE_SECS)
        .await
        .map(|_| ())
}

/// Validates that a mode is a 3-4 digit octal string ("755", "4755").
fn validate_octal_mode(mode: &str) -> Result<(), String> {
    let valid =
        (3..=4).contains(&mode.len()) && mode.bytes().all(|byte| (b'0'..=b'7').contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(format!("Mode must be 3 or 4 octal digits, got '{mode}'"))
    }
}

/// Changes permission bits via sudo `chmod` (tiny-rdm ChmodSudo).
pub async fn chmod(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    mode: &str,
) -> Result<(), String> {
    let path = normalize_remote_path(path)?;
    validate_octal_mode(mode)?;
    let command = format!("chmod {} -- {}", mode, shell_quote(&path));
    sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

/// Renames a path via sudo `mv` (tiny-rdm RenameSudo).
pub async fn rename(
    runtime: &SshRuntime,
    session_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let source = normalize_remote_path(old_path)?;
    let target = normalize_remote_path(new_path)?;
    let command = format!("mv -- {} {}", shell_quote(&source), shell_quote(&target));
    sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// main.rs registration (reference only — nothing in this file is wired up
// until these arms are added; the module also needs `mod sudo_fs;` next to
// the other `mod` declarations at the top of backend/src/main.rs).
//
// "sudo/stat" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::stat(&self.ssh, session_id, &path))
// }
// "sudo/exists" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     let exists = self
//         .runtime
//         .block_on(sudo_fs::exists(&self.ssh, session_id, &path))?;
//     Ok(json!({ "exists": exists }))
// }
// "sudo/touch" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::touch(&self.ssh, session_id, &path))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/listDir" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::list_dir(&self.ssh, session_id, &path))
// }
// "sudo/readFile" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
//     let length = params.get("length").and_then(Value::as_u64).unwrap_or(0);
//     self.runtime.block_on(sudo_fs::read_file(
//         &self.ssh,
//         session_id,
//         &path,
//         offset,
//         length,
//     ))
// }
// "sudo/writeFile" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     let data_base64 = required_string(&params, "dataBase64")?;
//     self.runtime.block_on(sudo_fs::write_file(
//         &self.ssh,
//         session_id,
//         &path,
//         data_base64,
//     ))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/mkdir" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::mkdir(&self.ssh, session_id, &path))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/remove" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::remove(&self.ssh, session_id, &path))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/removeAll" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     self.runtime
//         .block_on(sudo_fs::remove_all(&self.ssh, session_id, &path))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/chmod" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let path = required_string(&params, "path")?;
//     let mode = required_string(&params, "mode")?;
//     self.runtime
//         .block_on(sudo_fs::chmod(&self.ssh, session_id, &path, mode))?;
//     Ok(json!({ "success": true }))
// }
// "sudo/rename" => {
//     let session_id = required_string(&params, "sessionId")?;
//     let source = required_string(&params, "sourcePath")?;
//     let target = required_string(&params, "targetPath")?;
//     self.runtime
//         .block_on(sudo_fs::rename(&self.ssh, session_id, &source, &target))?;
//     Ok(json!({ "success": true }))
// }
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quotes_embedded_single_quotes() {
        assert_eq!(shell_quote("/var/log"), "'/var/log'");
        assert_eq!(shell_quote("/it's/a'file"), "'/it'\\''s/a'\\''file'");
        // Metacharacters stay inert inside the quotes.
        assert_eq!(shell_quote("$(rm -rf /); `id`"), "'$(rm -rf /); `id`'");
        assert_eq!(shell_quote("a'\nb"), "'a'\\''\nb'");
    }

    #[test]
    fn parses_gnu_stat_lines() {
        // GNU stat -c '%F|%i|%s|%Y|%a|%U|%u|%G|%g' — 9 字段
        let info =
            parse_gnu_stat_line("regular file|12345|1024|1720000000|644|root|0|root|0").unwrap();
        assert_eq!(info.kind, "file");
        assert_eq!(info.size, 1024);
        assert_eq!(info.modified_at, 1720000000);
        assert_eq!(info.mode, "0644");
        assert_eq!(info.owner, "root");
        assert_eq!(info.group, "root");
        assert_eq!(info.owner_uid, Some(0));
        assert_eq!(info.group_gid, Some(0));

        // 普通用户 alice (uid=1000, gid=1000) 的 SUID 可执行文件
        let empty =
            parse_gnu_stat_line("regular empty file|99|0|1720000002|4755|alice|1000|wheel|1000")
                .unwrap();
        assert_eq!(empty.kind, "file");
        assert_eq!(empty.mode, "4755");
        assert_eq!(empty.owner_uid, Some(1000));
        assert_eq!(empty.group_gid, Some(1000));

        let dir = parse_gnu_stat_line("directory|2|4096|1720000001|755|root|0|root|0").unwrap();
        assert_eq!(dir.kind, "directory");
        assert_eq!(dir.mode, "0755");

        let link = parse_gnu_stat_line("symbolic link|98|11|1720000003|777|root|0|root|0").unwrap();
        assert_eq!(link.kind, "symlink");

        let device =
            parse_gnu_stat_line("character special file|97|0|1720000004|666|root|0|root|0")
                .unwrap();
        assert_eq!(device.kind, "other");

        assert!(parse_gnu_stat_line("garbage").is_none());
        // 字段数不够（少 2 个 uid/gid）
        assert!(parse_gnu_stat_line("regular file|1|2|3|644|root|root").is_none());
        // mode 非法
        assert!(parse_gnu_stat_line("regular file|1|2|3|999|root|0|root|0").is_none());
    }

    #[test]
    fn parses_bsd_stat_lines() {
        // BSD stat -f '%HT|%i|%z|%m|%Lp|%Su|%u|%Sg|%g' — 9 字段
        let dir = parse_bsd_stat_line("Directory|2|4096|1720000000|16877|root|0|wheel|0").unwrap();
        assert_eq!(dir.kind, "directory");
        assert_eq!(dir.mode, "0755"); // 16877 & 0o7777 = 0o755
        assert_eq!(dir.size, 4096);
        assert_eq!(dir.owner, "root");
        assert_eq!(dir.owner_uid, Some(0));
        assert_eq!(dir.group_gid, Some(0));

        let file =
            parse_bsd_stat_line("File|99|1024|1720000001|33188|alice|1000|staff|500").unwrap();
        assert_eq!(file.kind, "file");
        assert_eq!(file.mode, "0644"); // 33188 & 0o7777 = 0o644
        assert_eq!(file.group, "staff");
        assert_eq!(file.owner_uid, Some(1000));
        assert_eq!(file.group_gid, Some(500));

        let link =
            parse_bsd_stat_line("Symbolic Link|98|11|1720000002|41471|root|0|wheel|0").unwrap();
        assert_eq!(link.kind, "symlink");
        assert_eq!(link.mode, "0777"); // 41471 & 0o7777 = 0o7777
    }

    #[test]
    fn parses_gnu_ls_output_with_epoch_times() {
        let output = "\
total 20
drwxr-xr-x  3 root root 4096 1720000000 .
drwxr-xr-x  1 root root 4096 1720000001 ..
-rw-r--r--  1 root root  123 1720000002 notes.txt
drwxr-xr-x  2 root root 4096 1720000003 sub dir with spaces
lrwxrwxrwx  1 root root   11 1720000004 link -> notes.txt
";
        let entries = parse_ls_output("/var/data", output);
        // Directories first, then case-insensitive names.
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub dir with spaces", "link", "notes.txt"]);

        let directory = &entries[0];
        assert_eq!(directory.kind, "directory");
        assert_eq!(directory.uri, "sftp:/var/data/sub dir with spaces");
        assert_eq!(directory.size, Some(4096));
        assert_eq!(directory.modified_at, Some(1720000003));
        assert_eq!(directory.permissions.as_deref(), Some("0755"));
        assert!(directory.content_type.is_none());
        assert_eq!(directory.owner.as_deref(), Some("root"));
        assert_eq!(directory.group.as_deref(), Some("root"));

        let link = &entries[1];
        assert_eq!(link.kind, "symlink");
        assert_eq!(link.uri, "sftp:/var/data/link");
        assert_eq!(link.size, Some(11));
        assert_eq!(link.permissions.as_deref(), Some("0777"));
        assert_eq!(link.owner.as_deref(), Some("root"));

        let file = &entries[2];
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, Some(123));
        assert_eq!(file.permissions.as_deref(), Some("0644"));
        assert_eq!(file.content_type.as_deref(), Some("text/plain"));
        assert_eq!(file.owner.as_deref(), Some("root"));
        assert_eq!(file.group.as_deref(), Some("root"));
    }

    #[test]
    fn parses_busybox_ls_output_with_classic_dates() {
        // BusyBox dates span three fields ("Jan 15 10:23" or "Jan 15  2024"),
        // so the mtime is unavailable while names still parse.
        let output = "\
drwxr-xr-x    3 root     root          4096 Jan 15 10:23 .
drwxr-xr-x    1 root     root          4096 Jan 15 10:23 ..
-rw-r--r--    1 root     root           123 Jan 15  2024 old.log
lrwxrwxrwx    1 root     root            11 Jan 15 10:23 lnk
";
        let entries = parse_ls_output("/mnt", output);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["lnk", "old.log"]);

        let log = &entries[1];
        assert_eq!(log.kind, "file");
        assert_eq!(log.size, Some(123));
        assert!(log.modified_at.is_none());
        assert_eq!(log.permissions.as_deref(), Some("0644"));
        assert_eq!(log.uri, "sftp:/mnt/old.log");
        assert_eq!(log.owner.as_deref(), Some("root"));
        assert_eq!(log.group.as_deref(), Some("root"));

        let link = &entries[0];
        assert_eq!(link.kind, "symlink");
        assert!(link.modified_at.is_none());
    }

    #[test]
    fn converts_symbolic_modes_with_special_bits() {
        assert_eq!(mode_string_to_octal("drwxr-xr-x"), Some(0o755));
        assert_eq!(mode_string_to_octal("-rw-r--r--"), Some(0o644));
        assert_eq!(mode_string_to_octal("lrwxrwxrwx"), Some(0o777));
        // setuid + exec, setgid without exec, sticky + exec.
        assert_eq!(mode_string_to_octal("-rwsr-xr-x"), Some(0o4755));
        assert_eq!(mode_string_to_octal("-rwxr-Sr-x"), Some(0o2745));
        assert_eq!(mode_string_to_octal("drwxr-xr-t"), Some(0o1755));
        assert_eq!(mode_string_to_octal("drwsr-xr-t"), Some(0o5755));
        // ACL/selinux markers append an 11th character; first 10 still count.
        assert_eq!(mode_string_to_octal("drwxr-xr-x+"), Some(0o755));
        assert_eq!(mode_string_to_octal("short"), None);
    }

    #[test]
    fn validates_octal_modes() {
        assert!(validate_octal_mode("755").is_ok());
        assert!(validate_octal_mode("0644").is_ok());
        assert!(validate_octal_mode("4755").is_ok());
        assert!(validate_octal_mode("1777").is_ok());
        assert!(validate_octal_mode("9").is_err());
        assert!(validate_octal_mode("999").is_err());
        assert!(validate_octal_mode("07777").is_err());
        assert!(validate_octal_mode("12").is_err());
        assert!(validate_octal_mode("").is_err());
        assert!(validate_octal_mode("rwx").is_err());
        assert!(validate_octal_mode("75 5").is_err());
    }
}
