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
    if cfg!(windows) {
        let selected = format!("/select,{}", path.as_os_str().to_string_lossy());
        return std::process::Command::new("explorer")
            .arg(selected)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to launch Explorer: {error}"));
    }
    let parent = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to launch file manager: {error}"))
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
}
