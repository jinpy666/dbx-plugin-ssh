use super::*;

/// Classifies a READDIR entry into the wire `kind` vocabulary of `sftp/list`.
///
/// russh-sftp derives `FileType` solely from the POSIX type bits in the
/// server-supplied READDIR `permissions` field; a server that omits
/// PERMISSIONS (or sends permissions without type bits — seen on
/// virtual/disk-mount SFTP services) collapses every entry to
/// `FileType::Other`. Issue #36 family: such entries used to be reported as
/// `"other"`, which the UI rendered as a generic text-document icon instead
/// of a file icon.
///
/// Rules:
/// - `Dir` / `File` / `Symlink` pass the server declaration through;
/// - `Other` (missing/unusable type bits) degrades to `"file"`: nothing on
///   the wire distinguishes files from directories at that point, and
///   "unknown renders as a file" matches FileZilla's behaviour. Real
///   directories on conforming servers always carry the DIR type bit, so
///   they never reach this branch.
pub(super) fn classify_entry_kind(file_type: FileType) -> &'static str {
    match file_type {
        FileType::File => "file",
        FileType::Dir => "directory",
        FileType::Symlink => "symlink",
        FileType::Other => "file",
    }
}

/// 裸包客户端具体类型：每次操作独占一条 sftp 子系统通道，发一收一。
pub(crate) type RawSftpClient = sftp_raw::RawSftp<russh::ChannelStream<russh::client::Msg>>;

/// 裸包客户端路径的 kind 判定：按 v3 permissions 的 POSIX 类型位归类；
/// attrs 缺 permissions（非标准服务器）时退回 file（与高层路径的 Other
/// 语义一致），避免把普通文件误渲染成目录。pub(crate)：MCP 工具面
/// latin-1 裸包列表/删除判型复用（M17）。
pub(crate) fn classify_raw_kind(permissions: Option<u32>) -> &'static str {
    let Some(mode) = permissions else {
        return "file";
    };
    match mode & 0o170000 {
        0o040000 => "directory",
        0o120000 => "symlink",
        _ => "file",
    }
}

pub(super) fn content_type_for_path(path: &str) -> Option<String> {
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

pub(crate) fn format_permissions(value: u32) -> String {
    format!("{:04o}", value & 0o7777)
}

/// Budget for the one `ls -l` round trip that upgrades numeric owner ids to
/// names. Generous enough for slow links, still bounded so a wedged shell
/// cannot stall directory listings.
const OWNER_LOOKUP_TIMEOUT_SECS: u64 = 10;

/// Whether an owner/group value still benefits from the `ls -l` name lookup:
/// absent, or a numeric id string (SFTPv3 servers report `0`, `1000`, ...).
pub(super) fn owner_needs_name(value: &Option<String>) -> bool {
    match value {
        None => true,
        Some(value) => !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()),
    }
}

/// Overwrites numeric/absent owner/group values on `entries` with names read
/// from one read-only `ls -l` round trip. Best effort by design: no shell,
/// no `ls`, a timeout or unparsable output all leave the listing untouched
/// (numeric ids or absent fields, which the UI renders as "-").
pub(super) async fn enrich_owner_names(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
    entries: &mut [SftpEntry],
) {
    if entries.is_empty() || !entries.iter().any(|entry| owner_needs_name(&entry.owner)) {
        return;
    }
    let session = match runtime.session(session_id).await {
        Ok(session) => session,
        Err(_) => return,
    };
    // GNU renders epoch mtimes with `--time-style=+%s` (same trick sudo_fs
    // uses); BusyBox/BSD reject that option, so a plain `ls -l` retry covers
    // the classic layout. Owner/group sit in fields 3/4 on both.
    let gnu = format!("ls -l --time-style=+%s -- {}", exec::shell_quote(path));
    let output = match exec::exec_plain(
        &session.handle,
        &gnu,
        Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
        &[],
    )
    .await
    {
        Ok(outcome) => outcome.output,
        Err(_) => {
            let plain = format!("ls -l -- {}", exec::shell_quote(path));
            match exec::exec_plain(
                &session.handle,
                &plain,
                Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
                &[],
            )
            .await
            {
                Ok(outcome) => outcome.output,
                Err(_) => return,
            }
        }
    };
    let names = parse_ls_owner_map(&output);
    if names.is_empty() {
        return;
    }
    for entry in entries.iter_mut() {
        if let Some((owner, group)) = names.get(&entry.name) {
            if owner_needs_name(&entry.owner) {
                entry.owner = Some(owner.clone());
            }
            if owner_needs_name(&entry.group) {
                entry.group = Some(group.clone());
            }
        }
    }
}

/// 远程 `stat -c '%U %G' path` 查单个文件的 owner/group 名字。
/// SFTP 协议默认只返回 uid/gid 数字，russh-sftp 的 `Metadata.user/group`
/// 在服务器未开 `username@hostname` 扩展时为 None。此函数作为 stat 的
/// fallback，失败/超时返回 (None, None)，调用方用数字兜底。
pub(crate) async fn lookup_owner_group_names(
    runtime: &SshRuntime,
    session_id: &str,
    path: &str,
) -> (Option<String>, Option<String>) {
    let session = match runtime.session(session_id).await {
        Ok(s) => s,
        Err(_) => return (None, None),
    };
    let cmd = format!("stat -c '%U %G' -- {}", exec::shell_quote(path));
    let output = match exec::exec_plain(
        &session.handle,
        &cmd,
        Duration::from_secs(OWNER_LOOKUP_TIMEOUT_SECS),
        &[],
    )
    .await
    {
        Ok(outcome) => outcome.output,
        Err(_) => return (None, None),
    };
    let mut parts = output.split_whitespace();
    let owner = parts
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let group = parts
        .next()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    (owner, group)
}

/// Parses `ls -l` output into `name -> (owner, group)`. Owner/group sit in
/// fields 3/4 of every layout; the name start depends on whether the date
/// collapsed into one epoch field (GNU `--time-style=+%s`, name from field 6)
/// or spread over three classic fields (name from field 8). Returns an empty
/// map for headers (`total`, `ls:` diagnostics) and unparsable rows.
pub(super) fn parse_ls_owner_map(output: &str) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let line = line.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with("total") || line.starts_with("ls:") {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 7 || fields[0].len() < 10 {
            continue;
        }
        let name_start = if fields[5].parse::<u64>().is_ok() {
            6
        } else {
            8
        };
        if fields.len() <= name_start {
            continue;
        }
        let mut name = fields[name_start..].join(" ");
        // `ls -l` renders symlinks as "name -> target"; keep only the name.
        if let Some((head, _)) = name.split_once(" -> ") {
            name = head.to_string();
        }
        let name = unquote_ls_output_name(&name);
        if name.is_empty() {
            continue;
        }
        map.entry(name)
            .or_insert_with(|| (fields[2].to_string(), fields[3].to_string()));
    }
    map
}

/// Undoes the quoting `ls` applies to unusual names when its stdout is a
/// terminal (possible when `sudo_use_pty` is enabled): shell-escape style
/// renders `weird name's` as `'weird name'\''s'`.
fn unquote_ls_output_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("'\\''", "'");
    }
    trimmed.to_string()
}

pub fn filesystem_path(params: &Value) -> Result<String, String> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing filesystem URI".to_string())?;
    path_from_sftp_uri(uri)
}

pub fn connection_id_param(params: &Value) -> Result<&str, String> {
    params
        .get("connectionId")
        .and_then(Value::as_str)
        .ok_or("Missing connectionId".to_string())
}

/// SFTP 客户端每请求超时（秒）。russh-sftp 3.0.1 的 `request_timeout_secs`
/// 默认 10 秒且按单个请求计：慢链路/经跳板时单个写请求确认超 10 秒即整体
/// 失败，大文件上传被误杀（#206），统一放宽到 60 秒。
const SFTP_REQUEST_TIMEOUT_SECS: u64 = 60;

/// SFTP 写流水线在途深度（非 compat，#237）。crate 默认 16 × 32KiB = 512KiB
/// 在途窗口，高 RTT 链路吞吐被窗口/RTT 封顶（100ms ≈ 5 MiB/s）；加深到
/// 64 × 32KiB = 2MiB（与 latin-1 裸包车道 `RAW_WRITE_PIPELINE_DEPTH` 对齐，
/// OpenSSH 自家 sftp 客户端的在途请求数同为 64 量级）。写包大小保持 32KiB
/// 不动（v3 兼容口径），ACK 仍由 `File::flush` 全量收齐并上抛错误，语义不变。
pub(super) const SFTP_WRITE_PIPELINE_DEPTH: usize = 64;

/// SFTP 客户端配置（纯函数，供单测）。`compat` 为老旧服务器兼容模式
/// （M14-B）：请求/响应不做流水线并发（读写各 1 路）；非 compat 读侧沿用
/// crate 默认并发（下载另有 multistream/预读窗口调参），写侧加深在途窗口
/// （#237）。两种模式都放宽每请求超时（见 [`SFTP_REQUEST_TIMEOUT_SECS`]）。
pub(crate) fn sftp_client_config(compat: bool) -> SftpConfig {
    SftpConfig {
        max_concurrent_reads: if compat {
            1
        } else {
            SftpConfig::default().max_concurrent_reads
        },
        max_concurrent_writes: if compat { 1 } else { SFTP_WRITE_PIPELINE_DEPTH },
        request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
        ..SftpConfig::default()
    }
}

pub(super) fn sftp_error(error: impl std::fmt::Display) -> String {
    format!("SFTP operation failed: {error}")
}

/// 通道级（非文件级）SFTP 错误的保守判定。错误串已过 `Display`（变体信息
/// 丢失）：russh-sftp 的 `Status` 变体是服务器正常应答的文件级状态（通道
/// 健康），`I/O: …`/`Timeout`/`Unexpected …` 等形态通常意味着底层通道已死。
/// 宁可误判——误失效的代价只是下次调用多做一次握手重建；漏判的代价是该
/// 会话 SFTP 永久报错。
pub(super) fn is_channel_level_sftp_error(error: &str) -> bool {
    let lowered = error.to_ascii_lowercase();
    lowered.contains("i/o: ")
        || lowered.contains("timeout")
        || lowered.contains("unexpected packet")
        || lowered.contains("unexpected behavior")
        || lowered.contains("channel closed")
        || lowered.contains("channel open failed")
}
