//! Local filesystem browsing for the in-app folder picker (`local/fs/browse`,
//! `local/fs/drives`). The sandboxed workbench iframe (opaque origin) has no
//! directory-picker API, so the desktop sidecar lists directories on the
//! user's machine — directories only, never file contents, and each listing
//! is capped. Same trust boundary as the other `local/*` methods: the caller
//! is our own plugin UI, and the paths stay on the user's machine.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

/// 系统对话框 single-flight：SDK worker 池 ≥2 线程时，第二次「导入」会并发
/// 再弹一个叠着的原生对话框（宿主 timeout_ms 只管放弃等待，管不住已弹出的
/// 窗口）。RAII 释放覆盖取消/报错/panic 全部路径。
static DIALOG_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct DialogFlightGuard;

impl DialogFlightGuard {
    fn acquire() -> Result<Self, String> {
        DIALOG_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| DialogFlightGuard)
            .map_err(|_| {
                "A native file dialog is already open — finish or cancel it first".to_string()
            })
    }
}

impl Drop for DialogFlightGuard {
    fn drop(&mut self) {
        DIALOG_IN_FLIGHT.store(false, Ordering::Release);
    }
}

/// AppleScript 双引号字符串字面量转义：`"` 与 `\` 在文件名中均合法，不转义
/// 会让 osascript 编译失败乃至注入 AppleScript 语句（osascript 是代码执行
/// 原语）。仅被平台对话框引用，其余平台死代码——与 FilePickFilter 同一
/// 处理：结构性 suppress，不加 cfg。
#[allow(dead_code)]
fn applescript_quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    for ch in text.chars() {
        if ch == '"' || ch == '\\' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted
}

/// PowerShell 单引号字符串字面量（含成对引号）：内部单引号双写 `''`。
#[allow(dead_code)]
fn powershell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Cap per listing so a huge directory cannot stall the picker.
const MAX_ENTRIES: usize = 500;

/// Windows drive letters for the picker's "This PC" page (A/B are floppy-era
/// and probing them can hang on legacy hardware). Empty on other platforms —
/// the picker then starts at the default directory instead.
pub fn list_local_drives() -> Vec<String> {
    let mut out = Vec::new();
    if cfg!(windows) {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                out.push(drive);
            }
        }
    }
    out
}

/// Lists the subdirectories of `path` (default download dir when absent or
/// empty), name-sorted case-insensitively. Returns `{ path, parent, entries }`
/// with directories only; symlinks to directories are followed, entries that
/// cannot be stat'ed are skipped. Errors when the target is not an existing,
/// readable absolute directory.
pub fn browse_local_dir(path: Option<&str>, data_dir: &Path) -> Result<Value, String> {
    let dir = path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            crate::local_downloads::downloads_base_dir(|key| std::env::var_os(key), data_dir)
        });
    if !dir.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    let metadata = std::fs::metadata(&dir)
        .map_err(|error| format!("Cannot open '{}': {error}", dir.display()))?;
    if !metadata.is_dir() {
        return Err(format!("'{}' is not a directory", dir.display()));
    }
    let read = std::fs::read_dir(&dir)
        .map_err(|error| format!("Cannot read '{}': {error}", dir.display()))?;
    let mut entries: Vec<(String, String)> = Vec::new();
    for entry in read.flatten() {
        // metadata() follows symlinks so linked folders stay navigable.
        let is_dir = entry.metadata().map(|meta| meta.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        entries.push((name, entry.path().to_string_lossy().into_owned()));
    }
    // 先排序再截断：截断在排序前会按 readdir 顺序（ext4 为 hash 序，不确定）
    // 任取 500 条，字母序靠后的目录在用户眼里"消失"。
    entries.sort_by_key(|entry| entry.0.to_lowercase());
    entries.truncate(MAX_ENTRIES);
    Ok(json!({
        "path": dir.to_string_lossy(),
        "parent": dir.parent().map(|parent| parent.to_string_lossy()),
        "entries": entries
            .iter()
            .map(|(name, path)| json!({ "name": name, "path": path, "is_dir": true }))
            .collect::<Vec<_>>(),
    }))
}

/// Opens the OS-native file picker (defaulting to `~/.ssh` where the platform
/// allows it) and returns the chosen absolute path; `None` when the user
/// cancels. Used by the connection form's "import private key" action — the
/// host-rendered form cannot pick files itself.
pub fn pick_file() -> Result<Option<String>, String> {
    let _flight = DialogFlightGuard::acquire()?;
    let ssh_dir = home_subdir(".ssh");
    trim_picked(pick_file_dialog(ssh_dir.as_deref(), None))
}

/// One "Import connections" source type. `kind` matches the
/// `connection_import` sniff vocabulary so the parsed file kind and the
/// user-chosen type share one vocabulary; `extensions`/`macos_types` drive the
/// file-picker filter per platform (custom extensions have no macOS UTI, so
/// they stay unfiltered there and rely on the explicit type step).
pub struct ImportSourceSpec {
    pub kind: &'static str,
    pub label: &'static str,
    pub extensions: &'static [&'static str],
    pub macos_types: &'static [&'static str],
    /// HOME-relative directory the file picker starts in (`.ssh` for the
    /// OpenSSH config); `None` starts at the home directory itself.
    pub default_subdir: Option<&'static str>,
}

/// Same sources (and order) as the workbench import wizard's step 1.
pub const IMPORT_SOURCES: &[ImportSourceSpec] = &[
    ImportSourceSpec {
        kind: "moba",
        label: "MobaXterm (.mxtsessions)",
        extensions: &["mxtsessions"],
        macos_types: &[],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "xshell",
        label: "Xshell (.xts)",
        extensions: &["xts"],
        macos_types: &[],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "windterm",
        label: "WindTerm (.sessions)",
        extensions: &["sessions"],
        macos_types: &[],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "securecrt",
        label: "SecureCRT (.xml)",
        extensions: &["xml"],
        macos_types: &["public.xml"],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "finalshell",
        label: "FinalShell (.zip)",
        extensions: &["zip"],
        macos_types: &["public.zip-archive"],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "electerm",
        label: "Electerm (.json)",
        extensions: &["json"],
        macos_types: &["public.json"],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "termius",
        label: "Termius (.json)",
        extensions: &["json"],
        macos_types: &["public.json"],
        default_subdir: None,
    },
    ImportSourceSpec {
        kind: "sshconfig",
        label: "OpenSSH config (~/.ssh)",
        extensions: &[],
        macos_types: &[],
        default_subdir: Some(".ssh"),
    },
];

/// Looks up a source spec by its `kind` (the `source` parameter the smoke
/// tests inject to skip the native dialog).
pub fn import_source_by_kind(kind: &str) -> Option<&'static ImportSourceSpec> {
    IMPORT_SOURCES.iter().find(|source| source.kind == kind)
}

/// Native "choose the source type" dialog for the connection form's
/// "Import connections" action. Returns the index into [`IMPORT_SOURCES`];
/// `None` when the user cancels.
pub fn pick_import_source() -> Result<Option<usize>, String> {
    let _flight = DialogFlightGuard::acquire()?;
    let labels: Vec<&str> = IMPORT_SOURCES.iter().map(|s| s.label).collect();
    pick_source_dialog(&labels).map(|picked| {
        picked.and_then(|label| labels.iter().position(|candidate| *candidate == label))
    })
}

fn home_subdir(subdir: &str) -> Option<PathBuf> {
    let base = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    let dir = PathBuf::from(base).join(subdir);
    dir.is_dir().then_some(dir)
}

fn trim_picked(picked: Result<Option<String>, String>) -> Result<Option<String>, String> {
    picked.map(|path| {
        // 只剥对话框输出的 \r\n（osascript/zenity 各带一个换行）；路径本身
        // 合法允许首尾空格，不能 trim。
        path.map(|path| path.trim_matches(['\r', '\n']).to_string())
            .filter(|path| !path.is_empty())
    })
}

/// File-picker filter for one import source. Each platform honors the field it
/// can: Windows/Linux filter on `extensions`, macOS on `macos_types` (custom
/// extensions have no UTI and stay unfiltered there, relying on the explicit
/// type step ahead of the dialog). Each field is only read behind its
/// platform cfg, so unused-on-this-platform is structural — suppressed here,
/// not per field.
#[allow(dead_code)]
pub struct FilePickFilter {
    pub name: &'static str,
    pub extensions: &'static [&'static str],
    pub macos_types: &'static [&'static str],
}

impl FilePickFilter {
    fn from_source(source: &ImportSourceSpec) -> Self {
        Self {
            name: source.label,
            extensions: source.extensions,
            macos_types: source.macos_types,
        }
    }

    #[allow(dead_code)]
    fn has_extensions(&self) -> bool {
        !self.extensions.is_empty()
    }

    // 唯一调用点在 macOS 门控的 pick_file_dialog 里；其余平台为本方法死代码
    // （与 has_extensions 同一处理）。
    #[allow(dead_code)]
    fn has_macos_types(&self) -> bool {
        !self.macos_types.is_empty()
    }
}

/// Native "pick one from a list" dialog; returns the picked label, `None` on
/// cancel. Used by the import source selection before the file dialog.
#[cfg(windows)]
fn pick_source_dialog(labels: &[&str]) -> Result<Option<String>, String> {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;

    // WinForms 单选列表（复用 OpenFileDialog 同款 STA + EncodedCommand 管线）：
    // 第一项默认选中，OK 返回选中项文本，关闭窗口静默取消。
    let mut script = String::from(concat!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$f=New-Object System.Windows.Forms.Form;",
        "$f.Text='Import connections';$f.Width=380;$f.Height=400;",
        "$f.FormBorderStyle='FixedDialog';$f.MaximizeBox=$false;$f.MinimizeBox=$false;$f.TopMost=$true;$f.StartPosition='CenterScreen';",
        "$l=New-Object System.Windows.Forms.Label;",
        "$l.Text='Choose the source of the sessions to import:';$l.SetBounds(12,10,340,20);$f.Controls.Add($l);",
        "$radios=@();",
    ));
    for (index, label) in labels.iter().enumerate() {
        script.push_str(&format!(
            "$r{index}=New-Object System.Windows.Forms.RadioButton;$r{index}.Text={text};$r{index}.SetBounds(16,{y},340,24);$f.Controls.Add($r{index});$radios+=$r{index};",
            index = index,
            y = 40 + index * 30,
            text = powershell_quote(label),
        ));
    }
    script.push_str("$radios[0].Checked=$true;");
    script.push_str(concat!(
        "$ok=New-Object System.Windows.Forms.Button;$ok.Text='OK';$ok.DialogResult='OK';$ok.SetBounds(270,360,80,26);$f.Controls.Add($ok);$f.AcceptButton=$ok;",
        "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$sel=$radios | Where-Object {$_.Checked} | Select-Object -First 1;[Console]::Out.Write($sel.Text)}",
    ));
    let mut utf16le = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16le.extend_from_slice(&unit.to_le_bytes());
    }
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-EncodedCommand",
            &BASE64_STANDARD.encode(utf16le),
        ])
        .output()
        .map_err(|error| format!("Failed to launch the source picker: {error}"))?;
    let label = String::from_utf8_lossy(&output.stdout)
        .trim_matches(['\r', '\n'])
        .to_string();
    Ok(if label.is_empty() { None } else { Some(label) })
}

#[cfg(not(windows))]
fn pick_source_dialog(labels: &[&str]) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        // AppleScript choose from list：取消输出空串/`false`，选中输出该项文本。
        let list = labels
            .iter()
            .map(|label| format!("\"{}\"", applescript_quote(label)))
            .collect::<Vec<_>>()
            .join(",");
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "choose from list {{{list}}} with title \"Import connections\" with prompt \"Choose the source of the sessions to import:\""
            ))
            .output()
            .map_err(|error| format!("Failed to launch the source picker: {error}"))?;
        if !output.status.success() {
            return Ok(None);
        }
        let label = String::from_utf8_lossy(&output.stdout)
            .trim_matches(['\r', '\n'])
            .to_string();
        Ok((!label.is_empty() && label != "false").then_some(label))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // zenity 列表显示 label；kdialog radiolist 用 kind 作 tag、label 作标题，
        // 两者输出都映射回 label 交给统一解析。
        for program in ["zenity", "kdialog"] {
            let mut command = std::process::Command::new(program);
            if program == "zenity" {
                command
                    .arg("--list")
                    .arg("--title=Import connections")
                    .arg("--text=Choose the source of the sessions to import:")
                    .arg("--column=Source");
                for label in labels {
                    command.arg(label);
                }
            } else {
                command
                    .arg("--radiolist")
                    .arg("Choose the source of the sessions to import:")
                    .arg("--title=Import connections");
                for (index, label) in labels.iter().enumerate() {
                    command
                        .arg(if index == 0 {
                            label.to_string()
                        } else {
                            format!("{index}")
                        })
                        .arg(label)
                        .arg(if index == 0 { "on" } else { "off" });
                }
            }
            match command.output() {
                Ok(output) => {
                    if !output.status.success() {
                        return Ok(None);
                    }
                    let text = String::from_utf8_lossy(&output.stdout)
                        .trim_matches(['\r', '\n'])
                        .to_string();
                    if text.is_empty() {
                        return Ok(None);
                    }
                    // zenity 原样返回 label；kdialog 返回 tag（label 或序号）。
                    if labels.contains(&text.as_str()) {
                        return Ok(Some(text));
                    }
                    if let Ok(index) = text.parse::<usize>() {
                        if let Some(label) = labels.get(index) {
                            return Ok(Some(label.to_string()));
                        }
                    }
                    return Ok(None);
                }
                Err(_) => continue,
            }
        }
        Err("No source picker available (install zenity or kdialog)".to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = labels;
        Err("Source picker is not available on this platform".to_string())
    }
}

/// Parameterized native file picker shared by the private-key import (no
/// filter, `~/.ssh` default) and the per-source import connections picker.
#[cfg(windows)]
fn pick_file_dialog(
    default_dir: Option<&Path>,
    filter: Option<&FilePickFilter>,
) -> Result<Option<String>, String> {
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;

    // OpenFileDialog 需要 STA；默认目录不存在时退回用户目录；
    // -EncodedCommand 传 base64(UTF-16LE) 规避引号转义，输出 UTF-8。
    let mut script = String::from(concat!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$d=New-Object System.Windows.Forms.OpenFileDialog;",
    ));
    match default_dir {
        Some(dir) => script.push_str(&format!(
            "$d.InitialDirectory={};",
            powershell_quote(&dir.to_string_lossy())
        )),
        None => script.push_str("$d.InitialDirectory=$env:USERPROFILE;"),
    }
    match filter {
        Some(filter) if filter.has_extensions() => {
            let (name, extensions) = (filter.name, filter.extensions);
            let patterns = extensions
                .iter()
                .map(|extension| format!("*.{extension}"))
                .collect::<Vec<_>>()
                .join(";");
            // Filter 整体是 PowerShell 单引号字符串：name/patterns 里的
            // `'` 需双写转义，否则脚本编译失败乃至注入。
            script.push_str(&format!(
                "$d.Filter={};",
                powershell_quote(&format!(
                    "{name} ({patterns})|{patterns}|All files (*.*)|*.*"
                )),
            ));
        }
        _ => script.push_str("$d.Filter='All files (*.*)|*.*';"),
    }
    script.push_str(
        "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.FileName)}",
    );
    let mut utf16le = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16le.extend_from_slice(&unit.to_le_bytes());
    }
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-EncodedCommand",
            &BASE64_STANDARD.encode(utf16le),
        ])
        .output()
        .map_err(|error| format!("Failed to launch the file picker: {error}"))?;
    let path = String::from_utf8_lossy(&output.stdout)
        .trim_matches(['\r', '\n'])
        .to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

#[cfg(target_os = "macos")]
fn pick_file_dialog(
    default_dir: Option<&Path>,
    filter: Option<&FilePickFilter>,
) -> Result<Option<String>, String> {
    // 默认定位 `default_dir`（缺省用户主目录）；用户取消时非零退出。
    // `of type` 只接受 UTI：自定义扩展名（.mxtsessions 等）没有 UTI，
    // 对应来源不过滤，靠前置的类型选择步骤引导。
    let mut command = std::process::Command::new("osascript");
    command.arg("-e").arg(format!(
        "set defaultDir to {}",
        match default_dir {
            // `"` 与 `\` 在路径中合法：不转义会让 osascript 编译失败乃至
            // 注入 AppleScript 语句（osascript 是代码执行原语）。
            Some(dir) => format!(
                "POSIX file \"{}\"",
                applescript_quote(&dir.to_string_lossy())
            ),
            None => "path to home folder".to_string(),
        }
    ));
    command.arg("-e").arg(format!(
        "POSIX path of (choose file default location defaultDir{})",
        match filter {
            Some(filter) if filter.has_macos_types() => {
                let macos_types = filter.macos_types;
                format!(
                    " of type {{{}}}",
                    macos_types
                        .iter()
                        .map(|uti| format!("\"{uti}\""))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            _ => String::new(),
        }
    ));
    let output = command
        .output()
        .map_err(|error| format!("Failed to launch the file picker: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout)
        .trim_matches(['\r', '\n'])
        .to_string();
    Ok(if path.is_empty() { None } else { Some(path) })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_file_dialog(
    default_dir: Option<&Path>,
    filter: Option<&FilePickFilter>,
) -> Result<Option<String>, String> {
    let fallback = std::env::var_os("HOME").map(PathBuf::from);
    let default = default_dir.or(fallback.as_deref());
    let zenity_default = default
        .map(|dir| format!("{}/", dir.to_string_lossy()))
        .unwrap_or_default();
    let mut command = std::process::Command::new("zenity");
    command.arg("--file-selection");
    if !zenity_default.is_empty() {
        command.arg(format!("--filename={zenity_default}"));
    }
    if let Some(filter) = filter {
        if filter.has_extensions() {
            let (name, extensions) = (filter.name, filter.extensions);
            let patterns = extensions
                .iter()
                .map(|extension| format!("*.{extension}"))
                .collect::<Vec<_>>()
                .join(" ");
            command.arg(format!("--file-filter={name} | {patterns}"));
        }
    }
    if let Ok(output) = command.output() {
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout)
            .trim_matches(['\r', '\n'])
            .to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
    }
    // zenity 不在时回落 kdialog（Qt 过滤器语法：pattern 空格分隔、`|` 后标题）。
    let kdialog_dir = default
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());
    let mut command = std::process::Command::new("kdialog");
    command.arg("--getopenfilename").arg(&kdialog_dir);
    if let Some(filter) = filter {
        // Qt 过滤器语法：单条目内多 pattern 空格分隔——与 zenity 同一扩展名
        // 集合，不再只取第一个（同功能跨平台过滤范围一致）。
        if !filter.extensions.is_empty() {
            let patterns = filter
                .extensions
                .iter()
                .map(|extension| format!("*.{extension}"))
                .collect::<Vec<_>>()
                .join(" ");
            command.arg(format!("{patterns}|{}", filter.name));
        }
    }
    match command.output() {
        Ok(output) => {
            if !output.status.success() {
                return Ok(None);
            }
            let path = String::from_utf8_lossy(&output.stdout)
                .trim_matches(['\r', '\n'])
                .to_string();
            Ok(if path.is_empty() { None } else { Some(path) })
        }
        Err(_) => Err("No file picker available (install zenity or kdialog)".to_string()),
    }
}

/// Opens the per-source filtered file picker after the user picked an import
/// source; `None` when the user cancels.
pub fn pick_import_file(source: &ImportSourceSpec) -> Result<Option<String>, String> {
    let _flight = DialogFlightGuard::acquire()?;
    let default_dir = source.default_subdir.and_then(home_subdir);
    trim_picked(pick_file_dialog(
        default_dir.as_deref(),
        Some(&FilePickFilter::from_source(source)),
    ))
}

/// Pre-download conflict probe for the "ask me" policy: reports whether
/// `<dir>/<sanitized name>` already exists, plus the exact candidate path so
/// the prompt can show it verbatim.
pub fn target_exists(dir: &str, name: &str) -> Result<Value, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("Directory is required".to_string());
    }
    let dir_path = PathBuf::from(dir);
    if !dir_path.is_absolute() {
        return Err("Directory must be an absolute path".to_string());
    }
    let candidate = dir_path.join(crate::local_downloads::sanitize_file_name(name));
    Ok(json!({
        "exists": candidate.exists(),
        "path": candidate.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_lists_dirs_sorted_and_skips_files() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("beta")).unwrap();
        std::fs::create_dir_all(root.path().join("Alpha")).unwrap();
        std::fs::write(root.path().join("file.txt"), "x").unwrap();
        let result =
            browse_local_dir(Some(root.path().to_str().unwrap()), data_dir.path()).expect("browse");
        let names: Vec<&str> = result["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["Alpha", "beta"]);
        assert_eq!(
            result["parent"].as_str().unwrap(),
            root.path().parent().unwrap().to_string_lossy()
        );
    }

    #[test]
    fn browse_rejects_relative_missing_and_file_paths() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        assert!(browse_local_dir(Some("relative/dir"), data_dir.path()).is_err());
        assert!(browse_local_dir(Some("/no/such/path/at/all"), data_dir.path()).is_err());
        let file = data_dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(browse_local_dir(Some(file.to_str().unwrap()), data_dir.path()).is_err());
    }

    #[test]
    fn browse_default_falls_back_to_download_dir() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let result = browse_local_dir(None, data_dir.path()).expect("browse default");
        assert!(result["path"].as_str().unwrap().len() > 1);
    }

    #[test]
    fn target_exists_reports_collision_candidate() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("report.pdf"), "x").unwrap();
        let hit = target_exists(dir.path().to_str().unwrap(), "report.pdf").expect("probe");
        assert_eq!(hit["exists"].as_bool(), Some(true));
        let miss = target_exists(dir.path().to_str().unwrap(), "other.pdf").expect("probe");
        assert_eq!(miss["exists"].as_bool(), Some(false));
        assert!(target_exists("relative", "a.txt").is_err());
        assert!(target_exists("", "a.txt").is_err());
    }

    #[test]
    fn browse_truncates_after_sorting_not_before() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let root = tempfile::tempdir().expect("root");
        // >MAX_ENTRIES 个子目录：截断必须发生在排序后，返回的应是字母序前
        // 500 个确定子集（而不是 readdir 序的任意 500 个再排序）。
        for index in 0..(MAX_ENTRIES + 50) {
            std::fs::create_dir_all(root.path().join(format!("dir-{index:04}"))).unwrap();
        }
        let result =
            browse_local_dir(Some(root.path().to_str().unwrap()), data_dir.path()).expect("browse");
        let names = result["entries"].as_array().unwrap();
        assert_eq!(names.len(), MAX_ENTRIES);
        assert_eq!(names[0]["name"].as_str().unwrap(), "dir-0000");
        assert_eq!(
            names[MAX_ENTRIES - 1]["name"].as_str().unwrap(),
            &format!("dir-{:04}", MAX_ENTRIES - 1)
        );
    }

    #[test]
    fn drives_empty_off_windows() {
        if cfg!(windows) {
            assert!(list_local_drives().iter().any(|drive| drive == "C:\\"));
        } else {
            assert!(list_local_drives().is_empty());
        }
    }

    #[test]
    fn quoting_helpers_escape_script_metacharacters() {
        // AppleScript 双引号串内的 `"`/`\` 转义——文件名两者皆合法。
        assert_eq!(applescript_quote("a\"b\\c"), "a\\\"b\\\\c");
        assert_eq!(applescript_quote("plain"), "plain");
        // PowerShell 单引号串内的 `'` 双写。
        assert_eq!(powershell_quote("it's"), "'it''s'");
        assert_eq!(powershell_quote("*.mxtsessions"), "'*.mxtsessions'");
        // 首尾空格是合法路径/标签成分：quote 不增删。
        assert_eq!(applescript_quote(" /tmp/a "), " /tmp/a ");
        assert_eq!(powershell_quote(" a "), "' a '");
    }

    #[test]
    fn trim_picked_strips_only_dialog_newlines() {
        let picked = Ok(Some(" /tmp/dir with trailing space \r\n".to_string()));
        assert_eq!(
            trim_picked(picked).unwrap(),
            Some(" /tmp/dir with trailing space ".to_string())
        );
        assert_eq!(trim_picked(Ok(Some("\r\n".to_string()))).unwrap(), None);
        assert_eq!(trim_picked(Ok(None)).unwrap(), None);
    }
}
