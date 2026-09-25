//! Sudo-backed binary download (tiny-rdm DownloadSudo 对标): large root-owned
//! files streamed through the regular SFTP download pipeline.
//!
//! ## 方案取舍（M14-C）
//!
//! - **远端临时文件（本实现）**：sudo 把源文件拷进同目录 mktemp 临时件，再把
//!   临时件登记进既有下载注册表，`sftp/download/next` / `finish` / 进度事件 /
//!   传输面板全部原样复用。代价：远端需要与源文件等量的临时空间；拷贝走一次
//!   exec，受 5–300s 超时夹取限制（约 16 GiB @ >55 MB/s 磁盘）。
//! - **sudo dd 流式（未选）**：逐块 exec `sudo dd` 再 base64 解码。exec 输出
//!   通道没有二进制边界、无 seek/resume、每块都要过密码编排，且需要为下载族
//!   另建一整套分块/进度/取消管线——与“复用下载面板与传输队列”的需求相悖。
//!
//! ## 安全与清理
//!
//! - 临时件 `mktemp` 建在**源文件同目录**（同文件系统：空间语义与源一致，避开
//!   /tmp 常见 tmpfs——大文件会吃内存），文件名前缀 [`TMP_PREFIX`]。
//! - mktemp 之后立刻 `chown <登录用户 uid>` + `chmod 600`：SFTP 会话以登录用户
//!   打开临时件，root 属主 + 0600 反而读不了；chown 后 0600 仍然只有该用户可读，
//!   不会出现「root 临时件全局可读」的窗口。
//! - 源目录必须对登录用户可穿越（否则 SFTP 读不到临时件）——`/root` 这类 0700
//!   目录会在 start 阶段被 SFTP 探测明确报错。
//! - finally 语义：完成 / 失败 / 取消 / 会话关闭四条路径都 best-effort
//!   `rm -f` 临时件；清理失败只落 stderr 与结果 `warning` 字段，不吞掉原结果。
//! - 路径校验复用 sudo 族先例（`normalize_remote_path` + `shell_quote`），
//!   额外以 [`is_staged_tmp_path`] 钉死清理命令只能命中本模块创建的临时件。

use serde_json::Value;

use crate::model::normalize_remote_path;
use crate::ssh::SshRuntime;
use crate::sudo_fs::{shell_quote, sudo_exec};

/// Remote staging file name prefix; cleanup refuses any path whose final
/// component does not start with it.
pub(crate) const TMP_PREFIX: &str = ".dbx-sudo-dl-";

/// Per-command timeouts (exec clamps to 5..300); the copy itself is one
/// blocking `cat` and takes the largest slice available.
const TIMEOUT_QUICK_SECS: u64 = 30;
const TIMEOUT_COPY_SECS: u64 = 300;

/// One staged download source, ready to be registered as a download task.
pub(crate) struct StagedSource {
    /// Remote temp file the SFTP pipeline will actually read.
    pub tmp_path: String,
    /// Source size from sudo stat; the temp file is verified against it.
    pub size: u64,
    /// Original file name (download keeps the source name, not the temp name).
    pub file_name: String,
}

/// Directory part of an absolute POSIX path (`None` for the filesystem root).
/// A first-level path ("/shadow") stages into "/" itself.
fn parent_dir(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((parent, _)) => Some(if parent.is_empty() { "/" } else { parent }),
        None => None,
    }
}

/// File name component of a normalized POSIX path.
fn download_file_name(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("download")
        .to_string()
}

/// `mktemp` template rooted in the source directory: same filesystem, prefix
/// marked as ours, eight X's (GNU/BSD/BusyBox all accept >= 3).
fn build_mktemp_command(directory: &str) -> String {
    format!(
        "mktemp -- {}/{}XXXXXXXX",
        shell_quote(directory),
        TMP_PREFIX
    )
}

/// Validates `mktemp` output against the requested directory: exactly one
/// line, absolute, inside `directory`, and carrying our prefix.
fn parse_mktemp_output(output: &str, directory: &str) -> Result<String, String> {
    let path = output.trim();
    if path.is_empty() || path.contains('\n') || !path.starts_with('/') {
        return Err(format!("Unexpected mktemp output: {output:?}"));
    }
    let expected = format!("{}/{}", directory.trim_end_matches('/'), TMP_PREFIX);
    if !path.starts_with(&expected) || path.len() <= expected.len() {
        return Err(format!(
            "mktemp returned a path outside the staging scope: {path}"
        ));
    }
    Ok(path.to_string())
}

/// Cleanup guard: only paths whose final component starts with [`TMP_PREFIX`]
/// (and has a non-empty remainder) may ever be passed to `rm -f`.
fn is_staged_tmp_path(path: &str) -> bool {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some((_, name)) => {
            name.len() > TMP_PREFIX.len() && name.starts_with(TMP_PREFIX) && !name.contains('/')
        }
        None => false,
    }
}

/// Copy + lock-down command: root writes the source through the temp file,
/// which by then is owned by the login user and mode 0600.
fn build_copy_command(source: &str, tmp: &str) -> String {
    format!("cat -- {} > {}", shell_quote(source), shell_quote(tmp))
}

/// `chown <uid>` + `chmod 600` so the SFTP session (login user) can read the
/// staging file while it stays inaccessible to everyone else.
fn build_ownership_command(uid: u32, tmp: &str) -> String {
    format!(
        "chown {uid} -- {} && chmod 600 -- {}",
        shell_quote(tmp),
        shell_quote(tmp)
    )
}

/// Parses `id -u` output (plain exec, no sudo).
fn parse_id_uid(output: &str) -> Option<u32> {
    output.trim().parse().ok()
}

/// Stages `path` into a same-directory sudo temp file and returns the
/// metadata the download registry needs. Any failure after `mktemp` cleans
/// the temp file up before the error propagates.
pub(crate) async fn stage_source(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
) -> Result<StagedSource, String> {
    let source = normalize_remote_path(path)?;
    // sudo 族先例：sudo stat 拿 size/kind，顺带把“路径不存在/不可读”挡在
    // mktemp 之前。只允许普通文件下载。
    let stat = crate::sudo_fs::stat(runtime, session_id, &source).await?;
    if stat.get("kind").and_then(Value::as_str) != Some("file") {
        return Err(format!(
            "Sudo download needs a regular file, '{}' is {}",
            source,
            stat.get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    let size = stat.get("size").and_then(Value::as_u64).unwrap_or(0);
    let Some(directory) = parent_dir(&source) else {
        return Err("Refusing to download the filesystem root".to_string());
    };

    // 登录用户 uid（plain exec）：临时件要 chown 给 SFTP 会话的属主。
    let uid_output = runtime
        .exec(session_id, None, "id -u", false, Some(TIMEOUT_QUICK_SECS))
        .await?;
    let uid = parse_id_uid(
        uid_output
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .ok_or("Could not determine the login user id")?;

    let mktemp_output = sudo_exec(
        runtime,
        session_id,
        &build_mktemp_command(directory),
        TIMEOUT_QUICK_SECS,
    )
    .await?;
    let tmp = parse_mktemp_output(&mktemp_output, directory)?;

    // mktemp 之后任何一步失败都先删临时件再报错（finally 语义的上半段）。
    let outcome = stage_into(runtime, session_id, &source, &tmp, uid, size).await;
    if outcome.is_err() {
        if let Err(cleanup_error) = discard_tmp(runtime, session_id, &tmp).await {
            eprintln!("[sudo-download] staging temp cleanup failed ({tmp}): {cleanup_error}");
        }
    }
    outcome.map(|_| StagedSource {
        tmp_path: tmp.clone(),
        size,
        file_name: download_file_name(&source),
    })
}

/// Post-mktemp steps of [`stage_source`]: lock down ownership, copy, verify.
async fn stage_into(
    runtime: &SshRuntime,
    session_id: &str,
    source: &str,
    tmp: &str,
    uid: u32,
    expected_size: u64,
) -> Result<(), String> {
    sudo_exec(
        runtime,
        session_id,
        &build_ownership_command(uid, tmp),
        TIMEOUT_QUICK_SECS,
    )
    .await?;
    sudo_exec(
        runtime,
        session_id,
        &build_copy_command(source, tmp),
        TIMEOUT_COPY_SECS,
    )
    .await?;
    // 拷贝完整性：临时件必须与源等大（ENOSPC/中断都会在这里暴露）。
    let stat = crate::sudo_fs::stat(runtime, session_id, tmp).await?;
    let actual = stat.get("size").and_then(Value::as_u64).unwrap_or(0);
    if actual != expected_size {
        return Err(format!(
            "Staging copy is incomplete: {actual} of {expected_size} bytes"
        ));
    }
    Ok(())
}

/// Best-effort `rm -f` of one staging temp file; refused for anything that
/// does not look like our own staging file name.
pub(crate) async fn discard_tmp(
    runtime: &SshRuntime,
    session_id: &str,
    tmp_path: &str,
) -> Result<(), String> {
    if !is_staged_tmp_path(tmp_path) {
        return Err(format!(
            "Refusing to clean up a path outside the sudo download staging namespace: {tmp_path}"
        ));
    }
    let command = format!("rm -f -- {}", shell_quote(tmp_path));
    crate::sudo_fs::sudo_exec(runtime, session_id, &command, TIMEOUT_QUICK_SECS)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_parent_dir_and_file_name() {
        assert_eq!(parent_dir("/etc/shadow"), Some("/etc"));
        // 一级路径的父目录就是根目录本身。
        assert_eq!(parent_dir("/shadow"), Some("/"));
        // 根目录与相对路径拒绝交由上层 normalize_remote_path 兜底。
        assert_eq!(parent_dir("/"), None);
        assert_eq!(download_file_name("/etc/shadow"), "shadow");
        assert_eq!(
            download_file_name("/var/log/weird name.log"),
            "weird name.log"
        );
        assert_eq!(download_file_name("/"), "download");
    }

    #[test]
    fn builds_mktemp_command_with_quoted_directory() {
        assert_eq!(
            build_mktemp_command("/var/log"),
            "mktemp -- '/var/log'/.dbx-sudo-dl-XXXXXXXX"
        );
        // 带引号目录的 shell 转义沿用 sudo 族 shQuoted 先例。
        assert_eq!(
            build_mktemp_command("/it's/dir"),
            "mktemp -- '/it'\\''s/dir'/.dbx-sudo-dl-XXXXXXXX"
        );
    }

    #[test]
    fn parses_and_scopes_mktemp_output() {
        assert_eq!(
            parse_mktemp_output("/var/log/.dbx-sudo-dl-Ab12Cd34\n", "/var/log").unwrap(),
            "/var/log/.dbx-sudo-dl-Ab12Cd34"
        );
        // 错误目录 / 缺前缀 / 空名 / 多行 / 相对路径都拒绝。
        assert!(parse_mktemp_output("/tmp/.dbx-sudo-dl-Ab12Cd34", "/var/log").is_err());
        assert!(parse_mktemp_output("/var/log/.dbx-sudo-dl-", "/var/log").is_err());
        assert!(parse_mktemp_output("/var/log/other-Ab12Cd34", "/var/log").is_err());
        assert!(parse_mktemp_output("", "/var/log").is_err());
        assert!(parse_mktemp_output("/var/log/.dbx-sudo-dl-A\n/etc/passwd", "/var/log").is_err());
        assert!(parse_mktemp_output("relative/.dbx-sudo-dl-Ab12Cd34", "relative").is_err());
        // 尾斜杠目录也能对上（trim_end 归一）。
        assert_eq!(
            parse_mktemp_output("/var/log/.dbx-sudo-dl-Zz9Zz9Zz", "/var/log/").unwrap(),
            "/var/log/.dbx-sudo-dl-Zz9Zz9Zz"
        );
    }

    #[test]
    fn cleanup_guard_only_accepts_staging_namespace() {
        assert!(is_staged_tmp_path("/var/log/.dbx-sudo-dl-Ab12Cd34"));
        assert!(is_staged_tmp_path("/var/log/.dbx-sudo-dl-Ab12Cd34/"));
        assert!(!is_staged_tmp_path("/var/log/.dbx-sudo-dl-")); // 空后缀
        assert!(!is_staged_tmp_path("/etc/shadow"));
        assert!(!is_staged_tmp_path("/var/log/other"));
        assert!(!is_staged_tmp_path("/var/log/dbx-sudo-dl-Ab12Cd34")); // 缺点号
        assert!(!is_staged_tmp_path(".dbx-sudo-dl-Ab12Cd34")); // 无目录成分
    }

    #[test]
    fn builds_copy_and_ownership_commands() {
        assert_eq!(
            build_copy_command("/etc/shadow", "/etc/.dbx-sudo-dl-Ab12Cd34"),
            "cat -- '/etc/shadow' > '/etc/.dbx-sudo-dl-Ab12Cd34'"
        );
        // 重定向目标也要过引号（防临时件名注入；名字虽由 mktemp 生成，防御成对）。
        assert!(build_copy_command("/a b", "/etc/.dbx-sudo-dl-x").contains("'/etc/.dbx-sudo-dl-x'"));
        assert_eq!(
            build_ownership_command(1000, "/etc/.dbx-sudo-dl-Ab12Cd34"),
            "chown 1000 -- '/etc/.dbx-sudo-dl-Ab12Cd34' && chmod 600 -- '/etc/.dbx-sudo-dl-Ab12Cd34'"
        );
        assert_eq!(
            build_ownership_command(0, "/t"),
            "chown 0 -- '/t' && chmod 600 -- '/t'"
        );
    }

    #[test]
    fn parses_id_uid_output() {
        assert_eq!(parse_id_uid("1000\n"), Some(1000));
        assert_eq!(parse_id_uid(" 0 "), Some(0));
        assert_eq!(parse_id_uid("root"), None);
        assert_eq!(parse_id_uid(""), None);
        assert_eq!(parse_id_uid("1000 1000"), None);
    }
}
