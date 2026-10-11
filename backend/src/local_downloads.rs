//! Local (client-machine) persistence and reveal for SFTP downloads.
//!
//! The plugin webview cannot save files itself: the host's `fileTransfer` API
//! is optional (absent on current hosts) and `<a download>` is silently
//! cancelled inside a Tauri/WKWebView without a download handler. The sidecar
//! therefore writes finished downloads to the user's Downloads folder so the
//! completion notice can show a real path. `local/reveal` opens the file
//! manager and `local/open` opens the downloaded file in the OS default app.
//!
//! Reveal is deliberately restricted to paths recorded by a completed local
//! download — never an arbitrary open-path primitive.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Forces the local-save capability on/off for deployments where the default
/// detection (see `can_save_local`) guesses wrong (e.g. a docker deployment
/// that mounts a Downloads folder).
pub const LOCAL_SAVE_ENV: &str = "DBX_SSH_LOCAL_SAVE";
/// Overrides the base directory downloads are saved into (also used by the
/// smoke tests to keep them out of the developer's real Downloads folder).
pub const DOWNLOAD_DIR_ENV: &str = "DBX_SSH_DOWNLOAD_DIR";
/// 单次本机落盘的体积上限（GIF 导出等内存编码产物理应远小于此）。
pub const LOCAL_SAVE_MAX_BYTES: usize = 64 * 1024 * 1024;

/// 通用本机落盘（`local/saveFile`）：供不经过 SFTP 传输链的本地产物
/// （录制 GIF 导出等）复用下载目录语义。文件名消毒 + 撞名让位 +
/// 记入传输历史（`local/reveal`、`local/open` 才能定位它）。
/// `target_dir` 为 None/空时落到下载目录；显式目录必须是绝对路径。
/// `conflict` 为 "overwrite" 时直接覆盖同名文件，默认撞名让位（" (n)"）。
pub fn save_local_file(
    data_dir: &Path,
    name: &str,
    data: &[u8],
    target_dir: Option<&str>,
    conflict: Option<&str>,
) -> Result<Value, String> {
    if data.is_empty() {
        return Err("Nothing to save".to_string());
    }
    if data.len() > LOCAL_SAVE_MAX_BYTES {
        return Err(format!(
            "Local save is limited to {LOCAL_SAVE_MAX_BYTES} bytes"
        ));
    }
    let safe_name = sanitize_file_name(name);
    let dir = target_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| downloads_base_dir(|key| std::env::var_os(key), data_dir));
    if !dir.is_absolute() {
        return Err("Download directory must be an absolute path".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "Failed to create download directory '{}': {error}",
            dir.display()
        )
    })?;
    let path = final_download_path(&dir, &safe_name, matches!(conflict, Some("overwrite")));
    std::fs::write(&path, data)
        .map_err(|error| format!("Failed to write '{}': {error}", path.display()))?;
    let final_name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| safe_name.clone());
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default();
    crate::transfer_history::record_transition(
        data_dir,
        &serde_json::json!({
            "taskId": format!("local-save-{}", uuid::Uuid::new_v4()),
            "direction": "download",
            "fileName": final_name,
            "size": data.len(),
            "transferred": data.len(),
            "status": "completed",
            "startedAt": now_ms,
            "finishedAt": now_ms,
            "localPath": path.to_string_lossy(),
        }),
    )?;
    Ok(serde_json::json!({
        "localPath": path.to_string_lossy(),
        "name": final_name,
    }))
}

fn env_value(lookup: &impl Fn(&str) -> Option<OsString>, key: &str) -> Option<OsString> {
    lookup(key).filter(|value| !value.to_string_lossy().trim().is_empty())
}

/// Whether saving downloads next to this process is meaningful: true when the
/// sidecar runs inside a desktop session on the user's machine. The default
/// detection treats macOS/Windows as desktop (sidecar always ships inside the
/// app there); on Linux it requires a display, so headless web/docker hosts
/// keep using the browser download fallback. `LOCAL_SAVE_ENV` overrides.
pub fn can_save_local(lookup: impl Fn(&str) -> Option<OsString>) -> bool {
    if let Some(flag) = env_value(&lookup, LOCAL_SAVE_ENV) {
        return matches!(
            flag.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        );
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        return true;
    }
    lookup("DISPLAY").is_some() || lookup("WAYLAND_DISPLAY").is_some()
}

/// Stable platform tag for the capabilities probe (`macos`/`windows`/`linux`/`other`).
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Base directory downloads land in: explicit `DOWNLOAD_DIR_ENV` override,
/// then the user's Downloads folder (created on demand), then the home
/// directory, then a folder under the plugin data dir so this never fails.
pub fn downloads_base_dir(lookup: impl Fn(&str) -> Option<OsString>, data_dir: &Path) -> PathBuf {
    if let Some(dir) = env_value(&lookup, DOWNLOAD_DIR_ENV) {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        return dir;
    }
    let home = if cfg!(windows) {
        env_value(&lookup, "USERPROFILE").map(PathBuf::from)
    } else {
        env_value(&lookup, "HOME").map(PathBuf::from)
    };
    if let Some(home) = home {
        let downloads = home.join("Downloads");
        if std::fs::create_dir_all(&downloads).is_ok() {
            return downloads;
        }
        return home;
    }
    let fallback = data_dir.join("downloads");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// Strips path separators and control characters from a remote-provided file
/// name; trailing dots/spaces are removed for Windows targets. Empty results
/// fall back to "download".
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Resolves the final local path for a finished download: `overwrite` writes
/// straight to the sanitized name (replacing an existing file); otherwise a
/// non-colliding " (n)" name is picked like browsers do.
pub fn final_download_path(base: &Path, file_name: &str, overwrite: bool) -> PathBuf {
    if overwrite {
        return base.join(sanitize_file_name(file_name));
    }
    pick_download_path(base, file_name)
}

/// Picks a non-colliding path in `base` for `file_name`, appending " (n)"
/// before the extension like browsers do. The final name is decided when the
/// download finishes so a failed transfer never reserves a name.
pub fn pick_download_path(base: &Path, file_name: &str) -> PathBuf {
    let name = sanitize_file_name(file_name);
    let candidate = base.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let stem_end = name.rfind('.').filter(|dot| *dot > 0).unwrap_or(name.len());
    let (stem, ext) = name.split_at(stem_end);
    for index in 1..=999 {
        let candidate = base.join(format!("{stem} ({index}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    base.join(format!("{stem}-{stamp}{ext}"))
}

/// Opens the platform file manager with `path` selected (or its parent folder
/// selected when the file was already moved away). Spawn failures surface as
/// errors; explorer's nonzero exit codes are famously meaningless and ignored.
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        if std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .status()
            .map_err(|error| format!("Failed to launch Finder: {error}"))?
            .success()
        {
            return Ok(());
        }
        let parent = path.parent().unwrap_or(path);
        return std::process::Command::new("open")
            .arg(parent)
            .status()
            .map_err(|error| format!("Failed to launch Finder: {error}"))
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("Finder exited with an error".to_string())
                }
            });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Explorer mis-parses a whole-argument-quoted "/select,<path>" (what
        // std::process::Command produces for arguments containing spaces, as
        // in ".../AccessClient_Win (4).msi") and silently falls back to its
        // default folder — the OS Documents directory (issue #18). Build the
        // raw argument so the quoting wraps only the path, the canonical
        // `explorer /select,"<path>"` form.
        std::process::Command::new("explorer")
            .raw_arg(explorer_select_arg(path))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to launch Explorer: {error}"))
    }
    #[cfg(not(windows))]
    {
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to launch file manager: {error}"))
    }
}

/// The `explorer /select` argument for `path`, with the quoting wrapped
/// around the path only. Pure so the quoting rule is testable off-Windows.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn explorer_select_arg(path: &Path) -> String {
    format!("/select,\"{}\"", path.as_os_str().to_string_lossy())
}

/// Resolves what `local/reveal` should actually open (issue #18): the
/// recorded file while it still exists, else its parent folder when that is
/// present (the file may have been moved or renamed by a " (n)" collision),
/// else the plugin's download directory — the same directory downloads land
/// in — so the button never falls through to an arbitrary OS default like
/// the Documents folder.
pub fn reveal_target(recorded: &Path, download_dir: &Path) -> PathBuf {
    if recorded.exists() {
        return recorded.to_path_buf();
    }
    if let Some(parent) = recorded.parent() {
        if parent.is_dir() {
            return parent.to_path_buf();
        }
    }
    download_dir.to_path_buf()
}

/// The downloads base every remote-edit round-trip leg must share: the
/// configured `downloadDir` preference when it resolves, else
/// [`downloads_base_dir`]. The frontend computes the external-edit download
/// target from this same preference (and `local/capabilities` reports it),
/// so the sidecar-side path gate (`validate_remote_edit_path`) has to
/// resolve the identical base — a custom download dir with the gate falling
/// back to the env/USERPROFILE default made every "open with"/upload
/// validation fail with "not inside the remote-edit directory" (#175).
/// Preference wins over the env override here (unlike `downloads_base_dir`)
/// because the frontend only ever reads the preference.
pub fn effective_downloads_base(
    lookup: impl Fn(&str) -> Option<OsString>,
    data_dir: &Path,
) -> PathBuf {
    let configured = crate::preferences::load_preferences(data_dir)
        .get("downloadDir")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute());
    if let Some(dir) = configured {
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    downloads_base_dir(lookup, data_dir)
}

/// The download directory the reveal fallback opens: the configured
/// `downloadDir` preference when it resolves, else the resolved default
/// (`downloads_base_dir`). Both are created on demand so the revealed
/// folder always exists.
pub fn reveal_download_dir(data_dir: &Path) -> PathBuf {
    let dir = effective_downloads_base(|key| std::env::var_os(key), data_dir);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Opens a downloaded file with the operating system's default application.
pub fn open_in_default_app(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("Downloaded file no longer exists".to_string());
    }
    if cfg!(target_os = "macos") {
        return std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open downloaded file: {error}"));
    }
    if cfg!(windows) {
        return std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to open downloaded file: {error}"));
    }
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open downloaded file: {error}"))
}

/// Validates `path` against the persisted transfer history before revealing:
/// only a completed download row that recorded this exact `localPath` may be
/// opened. Survives sidecar restarts because history rows persist on disk.
pub fn reveal_validated(history: &[Value], path: &Path) -> Result<(), String> {
    if is_recorded_download(history, path) {
        reveal_in_file_manager(path)
    } else {
        Err("Path was not saved by a completed download of this plugin".to_string())
    }
}

/// Same allowlist as reveal, but opens the file itself rather than its folder.
pub fn open_validated(history: &[Value], path: &Path) -> Result<(), String> {
    if is_recorded_download(history, path) {
        open_in_default_app(path)
    } else {
        Err("Path was not saved by a completed download of this plugin".to_string())
    }
}

/// Pure membership check behind `reveal_validated`, unit testable without
/// launching anything.
pub fn is_recorded_download(history: &[Value], path: &Path) -> bool {
    let path_text = path.to_string_lossy();
    history.iter().any(|row| {
        row.get("direction").and_then(Value::as_str) == Some("download")
            && row.get("status").and_then(Value::as_str) == Some("completed")
            && row.get("localPath").and_then(Value::as_str) == Some(path_text.as_ref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup_from<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| OsString::from(*value))
        }
    }

    #[test]
    fn save_local_file_writes_records_history_and_yields_name() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let target = tempfile::tempdir().expect("target");
        let result = save_local_file(
            data_dir.path(),
            "session.gif",
            b"GIF89a",
            Some(target.path().to_str().unwrap()),
            None,
        )
        .expect("save");
        let local_path = result["localPath"].as_str().unwrap().to_string();
        assert_eq!(std::fs::read(&local_path).unwrap(), b"GIF89a");
        // 记入传输历史（local/reveal、local/open 的合法路径来源）。
        let history = crate::transfer_history::load_history(data_dir.path());
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["localPath"].as_str().unwrap(), local_path);
        assert_eq!(history[0]["status"].as_str().unwrap(), "completed");
        // 撞名让位：同名再保存得到 " (1)" 后缀而不是覆盖。
        let again = save_local_file(
            data_dir.path(),
            "session.gif",
            b"GIF89b",
            Some(target.path().to_str().unwrap()),
            None,
        )
        .expect("save again");
        assert!(again["localPath"]
            .as_str()
            .unwrap()
            .ends_with("session (1).gif"));
        assert_eq!(std::fs::read(&local_path).unwrap(), b"GIF89a");
        // 覆盖策略：同名直接替换，不让位。
        let replaced = save_local_file(
            data_dir.path(),
            "session.gif",
            b"GIF89c",
            Some(target.path().to_str().unwrap()),
            Some("overwrite"),
        )
        .expect("overwrite");
        assert!(replaced["localPath"]
            .as_str()
            .unwrap()
            .ends_with("session.gif"));
        assert_eq!(std::fs::read(&local_path).unwrap(), b"GIF89c");
    }

    #[test]
    fn save_local_file_rejects_relative_dir_and_empty_payload() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        assert!(
            save_local_file(data_dir.path(), "a.gif", b"x", Some("relative/dir"), None).is_err()
        );
        assert!(save_local_file(data_dir.path(), "a.gif", b"", None, None).is_err());
    }

    #[test]
    fn sanitize_strips_separators_and_traversal() {
        assert_eq!(sanitize_file_name("report.tar.gz"), "report.tar.gz");
        // Separators are gone, so ".."-heavy names can never traverse; the
        // residual dots are harmless (remote names never contain '/' anyway).
        assert_eq!(sanitize_file_name("../../etc/passwd"), "....etcpasswd");
        assert_eq!(sanitize_file_name("../.."), "download");
        assert_eq!(sanitize_file_name("a/b\\c"), "abc");
        assert_eq!(sanitize_file_name("name... "), "name");
        assert_eq!(sanitize_file_name("  "), "download");
        assert_eq!(sanitize_file_name(""), "download");
        assert_eq!(sanitize_file_name("we\nird"), "we ird");
    }

    #[test]
    fn pick_download_path_avoids_collisions() {
        let base = tempfile::tempdir().expect("tempdir");
        let first = pick_download_path(base.path(), "log.txt");
        assert_eq!(first.file_name().unwrap(), "log.txt");
        std::fs::write(&first, b"x").expect("write");
        let second = pick_download_path(base.path(), "log.txt");
        assert_eq!(second.file_name().unwrap(), "log (1).txt");
        // A dotfile ("stem" is the whole name) must not become ".hidden (1)."
        let dot = pick_download_path(base.path(), ".hidden");
        assert_eq!(dot.file_name().unwrap(), ".hidden");
    }

    #[test]
    fn downloads_base_dir_prefers_env_then_home() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let target = tempfile::tempdir().expect("tempdir");
        let dir = downloads_base_dir(
            lookup_from(&[(
                "DBX_SSH_DOWNLOAD_DIR",
                target.path().to_string_lossy().as_ref(),
            )]),
            data_dir.path(),
        );
        assert_eq!(dir, target.path());
        let home = tempfile::tempdir().expect("tempdir");
        let downloads = home.path().join("Downloads");
        std::fs::create_dir_all(&downloads).expect("mkdir");
        // Windows 下 home 走 USERPROFILE，其余平台走 HOME（与实现一致）。
        let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let dir = downloads_base_dir(
            lookup_from(&[(home_var, home.path().to_string_lossy().as_ref())]),
            data_dir.path(),
        );
        assert_eq!(dir, downloads);
    }

    #[test]
    fn can_save_local_env_overrides_platform_default() {
        // env explicit off wins everywhere
        assert!(!can_save_local(lookup_from(&[("DBX_SSH_LOCAL_SAVE", "0")])));
        assert!(can_save_local(lookup_from(&[(
            "DBX_SSH_LOCAL_SAVE",
            "true"
        )])));
        // no env: Linux requires a display; a blank value is "unset", so it
        // must behave exactly like the absent case regardless of platform.
        assert_eq!(
            can_save_local(lookup_from(&[("DBX_SSH_LOCAL_SAVE", "  ")])),
            can_save_local(lookup_from(&[]))
        );
    }

    #[test]
    fn reveal_requires_recorded_completed_download() {
        let history = vec![
            serde_json::json!({
                "taskId": "t1", "direction": "download", "status": "completed",
                "localPath": "/Downloads/a.txt"
            }),
            serde_json::json!({ "taskId": "t2", "direction": "upload", "status": "completed" }),
            serde_json::json!({ "taskId": "t3", "direction": "download", "status": "failed" }),
        ];
        assert!(is_recorded_download(
            &history,
            Path::new("/Downloads/a.txt")
        ));
        assert!(!is_recorded_download(
            &history,
            Path::new("/Downloads/b.txt")
        ));
        assert!(!is_recorded_download(&history, Path::new("/etc/passwd")));
        let rejected = reveal_validated(&history, Path::new("/etc/passwd"));
        assert!(rejected
            .unwrap_err()
            .contains("not saved by a completed download"));
    }

    #[test]
    fn open_requires_recorded_completed_download() {
        let history = vec![serde_json::json!({
            "direction": "download", "status": "completed", "localPath": "/Downloads/a.txt"
        })];
        assert!(is_recorded_download(
            &history,
            Path::new("/Downloads/a.txt")
        ));
        assert!(!is_recorded_download(&history, Path::new("/etc/passwd")));
    }

    /// Issue #18: reveal must never fall through to an arbitrary OS default
    /// (the Documents folder) when the recorded file is gone. The fallback
    /// chain is recorded file → its parent folder → the download directory.
    #[test]
    fn reveal_target_falls_back_to_parent_then_download_dir() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let downloads = tempfile::tempdir().expect("downloads");
        // Existing file: reveal it itself.
        let file = downloads.path().join("keep.txt");
        std::fs::write(&file, b"x").expect("write");
        assert_eq!(reveal_target(&file, data_dir.path()), file);
        // Missing file inside an existing folder: reveal the folder so the
        // user still lands next to where the download was saved.
        let missing = downloads.path().join("moved-away.txt");
        assert_eq!(reveal_target(&missing, data_dir.path()), downloads.path());
        // Missing file in a missing folder: land in the download directory.
        let gone = downloads.path().join("no-such-dir").join("gone.txt");
        assert_eq!(reveal_target(&gone, downloads.path()), downloads.path());
    }

    /// Issue #18: the reveal fallback directory honors the configured
    /// `downloadDir` preference (same directory downloads are saved into),
    /// and falls back to the resolved default when it is unset or relative.
    #[test]
    fn reveal_download_dir_prefers_configured_then_default() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let configured = tempfile::tempdir().expect("configured");
        crate::preferences::save_preferences(
            data_dir.path(),
            &serde_json::json!({ "downloadDir": configured.path().to_string_lossy() }),
        )
        .expect("save");
        assert_eq!(reveal_download_dir(data_dir.path()), configured.path());
        // No preference: the resolved default is used and exists afterwards.
        let bare = tempfile::tempdir().expect("bare");
        let dir = reveal_download_dir(bare.path());
        assert!(dir.is_dir());
        // A relative preference is not trusted; the default wins.
        crate::preferences::save_preferences(
            data_dir.path(),
            &serde_json::json!({ "downloadDir": "relative/dir" }),
        )
        .expect("save relative");
        let fallback = reveal_download_dir(data_dir.path());
        assert_ne!(fallback, PathBuf::from("relative/dir"));
        assert!(fallback.is_absolute());
    }

    /// Issue #18: Explorer's /select argument must quote the path only. A
    /// whole-argument-quoted "/select,C:\... (4).msi" is mis-parsed by
    /// Explorer, which then opens its default folder (Documents).
    #[test]
    fn explorer_select_argument_quotes_path_only() {
        let arg = explorer_select_arg(Path::new(r"C:\Users\15754\Downloads\a (4).msi"));
        assert_eq!(arg, r#"/select,"C:\Users\15754\Downloads\a (4).msi""#);
        // Space-free paths keep the same canonical shape.
        assert_eq!(
            explorer_select_arg(Path::new(r"C:\Downloads\a.msi")),
            r#"/select,"C:\Downloads\a.msi""#
        );
    }
}
