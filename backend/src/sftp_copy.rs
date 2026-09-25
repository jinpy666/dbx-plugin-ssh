//! Server-side copy/move (`sftp/copy`, `sftp/move`), mirroring tiny-rdm's
//! server-internal copy & paste: sources are copied/moved *into* `toDir`
//! under their own name via the session's shell (`cp -a --` / `mv -f --`).
//! Moves inside one directory first try an SFTP rename and fall back to the
//! shell. No sudo variant (tiny-rdm has none either).
//!
//! latin-1 字节保真（M17 增量①工作台、M18 MCP 工具面）：工作台 `from`/
//! `toDir` 是列表回传的 wire 形式（MCP 面为显示形式，见 [`PathForm`]）。
//! 覆盖预检（逐个裸包 LSTAT，目标按 [`PathForm`] 还原字节）与同目录 move
//! 的 RENAME 快路径（裸包 RENAME）走原始字节；底层 shell `cp`/`mv` 的
//! exec 命令串是 UTF-8 String，服务器原始字节经 shell 参数不可控——copy
//! 与跨目录 move 的执行层保持字面量发送（clean 名不受影响，转义/非 ASCII
//! 名由服务器侧报错），边界登记见 PROTOCOL。

use std::sync::Arc;

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::exec;
use crate::model::normalize_remote_path;
use crate::sftp_name::{self, NameEncoding};
use crate::ssh::{RawSftpClient, SshClient, SshRuntime};

/// Remote `cp`/`mv` commands run with this budget; recursive directory
/// copies can legitimately take a while.
const REMOTE_COPY_TIMEOUT_SECS: u64 = 300;

/// Whether an operation copies or moves its sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOp {
    Copy,
    Move,
}

/// latin-1 模式下源/目标路径的字节还原口径：工作台 RPC（`sftp/copy`）传
/// 列表回传的 wire 形式（%XX 转义，[`sftp_name::unescape_wire`] 还原）；
/// MCP 工具面（M18）传显示形式（latin-1 解码文本，
/// [`sftp_name::latin1_encode_display`] 还原——与 MCP 面 sftp_rename 等
/// 工具的名字口径一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathForm {
    WireEscaped,
    Display,
}

impl PathForm {
    /// 显示/wire 文本 → 服务器原始字节。
    pub fn decode(self, path: &str) -> Vec<u8> {
        match self {
            PathForm::WireEscaped => sftp_name::unescape_wire(path),
            PathForm::Display => sftp_name::latin1_encode_display(path),
        }
    }
}

impl CopyOp {
    fn label(self) -> &'static str {
        match self {
            CopyOp::Copy => "copy",
            CopyOp::Move => "move",
        }
    }
}

/// Parsed `sftp/copy` / `sftp/move` request:
/// `{ connectionId, from: string|string[], toDir: string, overwrite?: bool }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveRequest {
    pub from: Vec<String>,
    pub to_dir: String,
    pub overwrite: bool,
}

/// Per-source outcome of a copy/move batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemOutcome {
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Batch outcome: `{ success, results: [{ from, to, ok, error? }] }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveOutcome {
    pub success: bool,
    pub results: Vec<ItemOutcome>,
}

impl CopyMoveOutcome {
    /// Contract shape consumed by the SFTP panel: `error` is present only
    /// on failed items.
    pub fn into_json(self) -> Value {
        json!({
            "success": self.success,
            "results": self.results.iter().map(ItemOutcome::to_json).collect::<Vec<_>>(),
        })
    }
}

impl ItemOutcome {
    fn to_json(&self) -> Value {
        let mut item = json!({ "from": self.from, "to": self.to, "ok": self.ok });
        if let Some(error) = &self.error {
            item["error"] = json!(error);
        }
        item
    }

    fn ok(from: &str, to: &str) -> Self {
        Self {
            from: from.to_string(),
            to: to.to_string(),
            ok: true,
            error: None,
        }
    }

    fn failed(from: &str, to: &str, error: String) -> Self {
        Self {
            from: from.to_string(),
            to: to.to_string(),
            ok: false,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Request parsing (pure)
// ---------------------------------------------------------------------------

/// Parses the copy/move parameters shared by the plugin RPC and the MCP tool.
pub fn parse_request(params: &Value) -> Result<CopyMoveRequest, String> {
    let from_value = params.get("from").ok_or("Missing from")?;
    let raw_sources = match from_value {
        Value::String(single) => vec![single.clone()],
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "from must be a string or an array of strings".to_string())
            })
            .collect::<Result<Vec<String>, String>>()?,
        _ => return Err("from must be a string or an array of strings".to_string()),
    };
    let mut from = Vec::with_capacity(raw_sources.len());
    for source in raw_sources {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = normalize_remote_path(trimmed)?;
        if normalized == "/" {
            return Err("Refusing to copy or move the filesystem root".to_string());
        }
        from.push(normalized);
    }
    if from.is_empty() {
        return Err("At least one source path is required".to_string());
    }
    let to_dir = params
        .get("toDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing toDir")?;
    let to_dir = normalize_remote_path(to_dir)?;
    // Boolean tolerance lives with the MCP argument helpers: a string
    // "true" must not silently read as overwrite=false.
    let overwrite = crate::mcp::arg_bool(params, "overwrite")?.unwrap_or(false);
    Ok(CopyMoveRequest {
        from,
        to_dir,
        overwrite,
    })
}

/// Target path for a source copied into `to_dir`: the source's own name
/// underneath the destination directory.
pub fn target_path(to_dir: &str, from: &str) -> String {
    let name = from
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    if name.is_empty() {
        return format!("{}/copy", to_dir.trim_end_matches('/'));
    }
    format!("{}/{}", to_dir.trim_end_matches('/'), name)
}

/// True when a move can take the SFTP-rename fast path: source and
/// destination directory are the same.
pub fn same_directory(from: &str, to_dir: &str) -> bool {
    let parent = from
        .trim_end_matches('/')
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let parent = if parent.is_empty() { "/" } else { parent };
    let dir = to_dir.trim_end_matches('/');
    let dir = if dir.is_empty() { "/" } else { dir };
    parent == dir
}

// ---------------------------------------------------------------------------
// Command builders (pure)
// ---------------------------------------------------------------------------

/// `cp -a -- <src> <toDir/name>` — archive mode keeps permissions, timestamps
/// and copies directories recursively.
pub fn build_copy_command(source: &str, target: &str) -> String {
    format!(
        "cp -a -- {} {}",
        exec::shell_quote(source),
        exec::shell_quote(target)
    )
}

/// `mv -f -- <src> <toDir/name>`.
pub fn build_move_command(source: &str, target: &str) -> String {
    format!(
        "mv -f -- {} {}",
        exec::shell_quote(source),
        exec::shell_quote(target)
    )
}

/// One-shot existence probe for every target: echoes the index of each path
/// that already exists; the trailing `true` keeps the overall exit status 0.
pub fn build_exists_probe_command(targets: &[String]) -> String {
    let mut command = String::new();
    for (index, target) in targets.iter().enumerate() {
        if index > 0 {
            command.push_str("; ");
        }
        command.push_str(&format!(
            "test -e {} && echo {}",
            exec::shell_quote(target),
            index
        ));
    }
    command.push_str("; true");
    command
}

/// Reduces probe output to a per-index "already exists" table.
pub fn existing_targets(output: &str, count: usize) -> Vec<bool> {
    let mut existing = vec![false; count];
    for line in output.lines() {
        if let Ok(index) = line.trim().parse::<usize>() {
            if index < count {
                existing[index] = true;
            }
        }
    }
    existing
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// How remote commands are issued for one copy/move batch.
enum CopyExecutor<'a> {
    /// Plugin RPC path: routed through [`SshRuntime::exec`] so session
    /// lookup, timeouts and exec bookkeeping stay in one place.
    Session(&'a SshRuntime, &'a str),
    /// MCP pooled connection: direct handle plus an optional SFTP channel.
    Headless(&'a Handle<SshClient>, Option<Arc<AsyncMutex<SftpSession>>>),
}

impl CopyExecutor<'_> {
    async fn exec(&self, command: &str) -> Result<exec::ExecOutcome, String> {
        match self {
            CopyExecutor::Session(runtime, session_id) => {
                let value = runtime
                    .exec(
                        session_id,
                        None,
                        command,
                        false,
                        Some(REMOTE_COPY_TIMEOUT_SECS),
                    )
                    .await?;
                Ok(exec::ExecOutcome {
                    output: value
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    exit_code: value.get("exitCode").and_then(Value::as_i64).unwrap_or(-1) as i32,
                })
            }
            CopyExecutor::Headless(handle, _) => {
                // Internal copy plumbing: env-free so output parsing stays
                // independent of the connection's setEnv overrides.
                exec::exec_plain(
                    handle,
                    command,
                    std::time::Duration::from_secs(REMOTE_COPY_TIMEOUT_SECS),
                    &[],
                )
                .await
            }
        }
    }

    async fn sftp(&self) -> Option<Arc<AsyncMutex<SftpSession>>> {
        match self {
            CopyExecutor::Session(runtime, session_id) => runtime.sftp(session_id).await.ok(),
            CopyExecutor::Headless(_, sftp) => sftp.clone(),
        }
    }
}

/// latin-1 裸包车道（M17-A 工作台 / M18 MCP 工具面）：客户端 + 路径还原
/// 口径。工作台按会话新开一条 sftp 子系统通道（wire 形式还原）；MCP 工具面
/// 由调用方传入连接级裸包客户端（显示形式还原）。None = auto 语义或裸包
/// 客户端建立失败（回退字面量路径，M15 先例）。
type RawLane = Option<(RawSftpClient, PathForm)>;

/// `sftp/copy` / `sftp/move` entry for the plugin RPC. The session is
/// resolved by the caller (connection id or session id).
pub async fn run(
    runtime: &SshRuntime,
    session_id: &str,
    op: CopyOp,
    params: &Value,
    encoding: NameEncoding,
) -> Result<Value, String> {
    runtime.ensure_writable(session_id).await?;
    let request = parse_request(params)?;
    // latin-1（M17-A）：按会话新开一条裸包通道（wire 形式还原）；建立失败
    // 回退既有字面量路径（raw = None，M15 先例）。
    let raw: RawLane = match encoding {
        NameEncoding::Latin1 => runtime
            .raw_sftp_client(session_id)
            .await
            .ok()
            .map(|client| (client, PathForm::WireEscaped)),
        NameEncoding::Auto => None,
    };
    let outcome = execute_with(
        CopyExecutor::Session(runtime, session_id),
        op,
        &request,
        raw,
    )
    .await;
    Ok(outcome.into_json())
}

/// `sftp_copy` / `sftp_move` MCP tool entry over a pooled headless
/// connection. `sftp` enables the SFTP-rename fast path for moves. `raw`
/// 传 latin-1 连接的裸包客户端（M18：Some = latin-1，覆盖预检/同目录
/// RENAME 快路径字节保真，路径按显示形式还原）；None = auto 语义执行。
pub async fn execute(
    handle: &Handle<SshClient>,
    sftp: Option<Arc<AsyncMutex<SftpSession>>>,
    raw: Option<RawSftpClient>,
    op: CopyOp,
    request: &CopyMoveRequest,
) -> CopyMoveOutcome {
    execute_with(
        CopyExecutor::Headless(handle, sftp),
        op,
        request,
        raw.map(|client| (client, PathForm::Display)),
    )
    .await
}

async fn execute_with(
    executor: CopyExecutor<'_>,
    op: CopyOp,
    request: &CopyMoveRequest,
    mut raw: RawLane,
) -> CopyMoveOutcome {
    let targets: Vec<String> = request
        .from
        .iter()
        .map(|source| target_path(&request.to_dir, source))
        .collect();

    // latin-1：from/toDir 按调用方面（工作台 wire 形式 / MCP 显示形式）整条
    // 还原字节。裸包客户端可用时，覆盖预检（逐个裸包 LSTAT）与同目录 move
    // 的 RENAME 快路径都走字节保真；None（auto 或建立失败）回退既有字面量
    // 路径（M15 先例）。
    //
    // 设计边界（登记，PROTOCOL 同步）：底层执行仍是远端服务器侧 `cp -a` /
    // `mv -f` shell 命令——SSH exec 的命令串是 UTF-8 String，含转义（%XX）
    // /非 ASCII 的路径只能按字面量拼接，服务器原始字节经 shell 参数不可控，
    // 故 copy 与跨目录 move 的执行层不做字节保真迁移：clean 名（无转义）
    // 行为不变，非 ASCII 名由服务器侧报错（`cp: cannot stat` 类），预检/
    // 改名快路径已迁移的部分保证覆盖判定与同目录移动正确。

    // With overwrite disabled, block every item whose target already exists
    // before running anything. latin-1 + 裸包车道：逐个裸包 LSTAT（按
    // PathForm 口径还原目标字节）；其余走一轮 shell 探测（整批一个往返）。
    let mut blocked = vec![false; targets.len()];
    if !request.overwrite {
        let mut probed = false;
        if let Some((client, form)) = raw.as_mut() {
            for (index, target) in targets.iter().enumerate() {
                if client.lstat(&form.decode(target)).await.is_ok() {
                    blocked[index] = true;
                }
            }
            probed = true;
        }
        if !probed {
            match executor.exec(&build_exists_probe_command(&targets)).await {
                Ok(outcome) if outcome.exit_code == 0 => {
                    blocked = existing_targets(&outcome.output, targets.len());
                }
                Ok(outcome) => {
                    eprintln!(
                        "[ssh] sftp {} existence probe failed (exit {}): {}; continuing with per-item attempts",
                        op.label(),
                        outcome.exit_code,
                        outcome.output.trim()
                    );
                }
                Err(error) => {
                    eprintln!(
                        "[ssh] sftp {} existence probe failed: {error}; continuing with per-item attempts",
                        op.label()
                    );
                }
            }
        }
    }

    // Only moves use the SFTP-rename fast path; the channels are opened
    // lazily and their absence simply disables the optimization.
    let sftp = match op {
        CopyOp::Move => executor.sftp().await,
        CopyOp::Copy => None,
    };

    let mut results = Vec::with_capacity(request.from.len());
    for (index, source) in request.from.iter().enumerate() {
        let target = &targets[index];
        if blocked[index] {
            results.push(ItemOutcome::failed(
                source,
                target,
                format!("target already exists: {target} (pass overwrite to replace)"),
            ));
            continue;
        }

        // Fast path: same-directory moves are a plain rename. latin-1 优先
        // 走裸包 RENAME（按 PathForm 口径还原字节，字节保真；SFTPv3 不覆盖
        // 已存在目标，撞名/跨设备失败与高层快路径同样回落 shell mv）。
        if op == CopyOp::Move && same_directory(source, &request.to_dir) {
            let attempted = match raw.as_mut() {
                Some((client, form)) => Some(
                    client
                        .rename(&form.decode(source), &form.decode(target))
                        .await,
                ),
                None => match &sftp {
                    Some(sftp) => Some(
                        sftp.lock()
                            .await
                            .rename(source.clone(), target.clone())
                            .await
                            .map_err(|error| error.to_string()),
                    ),
                    None => None,
                },
            };
            match attempted {
                Some(Ok(())) => {
                    results.push(ItemOutcome::ok(source, target));
                    continue;
                }
                Some(Err(error)) => {
                    eprintln!(
                        "[ssh] sftp rename fast path failed for {source} -> {target}: {error}; falling back to shell mv"
                    );
                }
                None => {}
            }
        }

        let command = match op {
            CopyOp::Copy => build_copy_command(source, target),
            CopyOp::Move => build_move_command(source, target),
        };
        match executor.exec(&command).await {
            Ok(outcome) if outcome.exit_code == 0 => {
                results.push(ItemOutcome::ok(source, target));
            }
            Ok(outcome) => {
                let detail = outcome.output.trim();
                results.push(ItemOutcome::failed(
                    source,
                    target,
                    format!(
                        "{} failed (exit {}): {detail}",
                        op.label(),
                        outcome.exit_code
                    ),
                ));
            }
            Err(error) => {
                results.push(ItemOutcome::failed(
                    source,
                    target,
                    format!("{} failed: {error}", op.label()),
                ));
            }
        }
    }

    CopyMoveOutcome {
        success: results.iter().all(|item| item.ok),
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_request_accepts_single_string_and_array() {
        let single = parse_request(&json!({
            "connectionId": "c1",
            "from": "/var/log/app.log",
            "toDir": "/tmp",
        }))
        .unwrap();
        assert_eq!(
            single,
            CopyMoveRequest {
                from: vec!["/var/log/app.log".to_string()],
                to_dir: "/tmp".to_string(),
                overwrite: false,
            }
        );

        let batch = parse_request(&json!({
            "connectionId": "c1",
            "from": ["/a/b.txt", " /c/d.txt ", "", "/x/../e"],
            "toDir": "/dst/",
            "overwrite": true,
        }))
        .unwrap();
        assert_eq!(batch.from, vec!["/a/b.txt", "/c/d.txt", "/e"]);
        assert_eq!(batch.to_dir, "/dst");
        assert!(batch.overwrite);
    }

    #[test]
    fn parse_request_rejects_invalid_params() {
        let error = parse_request(&json!({ "from": "/a" })).unwrap_err();
        assert_eq!(error, "Missing toDir");

        let error = parse_request(&json!({ "toDir": "/tmp" })).unwrap_err();
        assert_eq!(error, "Missing from");

        let error = parse_request(&json!({ "from": ["/a", 3], "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("array of strings"), "{error}");

        let error = parse_request(&json!({ "from": [], "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("At least one source"), "{error}");

        let error = parse_request(&json!({ "from": "  ", "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("At least one source"), "{error}");

        let error = parse_request(&json!({ "from": "/", "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("filesystem root"), "{error}");
    }

    #[test]
    fn copy_and_move_commands_quote_every_argument() {
        assert_eq!(
            build_copy_command("/var/my app.log", "/tmp/x"),
            "cp -a -- '/var/my app.log' '/tmp/x'"
        );
        assert_eq!(
            build_move_command("/var/it's", "/tmp"),
            r"mv -f -- '/var/it'\''s' '/tmp'"
        );
    }

    #[test]
    fn target_paths_keep_the_source_name() {
        assert_eq!(target_path("/tmp", "/var/log/app.log"), "/tmp/app.log");
        assert_eq!(target_path("/tmp/", "/var/log"), "/tmp/log");
        assert_eq!(target_path("/tmp", "/opt"), "/tmp/opt");
    }

    #[test]
    fn same_directory_detects_rename_candidates() {
        assert!(same_directory("/tmp/a.txt", "/tmp"));
        assert!(same_directory("/a", "/"));
        assert!(!same_directory("/var/log/app.log", "/tmp"));
        assert!(!same_directory("/tmp/sub/a.txt", "/tmp"));
    }

    #[test]
    fn probe_command_lists_every_target_with_true_tail() {
        let command = build_exists_probe_command(&["/tmp/one".to_string(), "/tmp/two".to_string()]);
        assert_eq!(
            command,
            "test -e '/tmp/one' && echo 0; test -e '/tmp/two' && echo 1; true"
        );
    }

    #[test]
    fn existing_targets_reduce_probe_output() {
        assert_eq!(
            existing_targets("1\nnoise\n0\n", 3),
            vec![true, true, false]
        );
        assert_eq!(existing_targets("", 2), vec![false, false]);
        // Out-of-range indices are ignored.
        assert_eq!(existing_targets("5", 2), vec![false, false]);
    }

    #[test]
    fn wire_targets_unescape_to_server_bytes() {
        // latin-1（M17 增量①）raw 预检/同名 move 快路径的目标字节：from 与
        // toDir 都是列表回传的 wire 形式，target_path 拼接后整条还原。
        let target = target_path("/tmp/caf%E9", "/src/%FFitem.txt");
        assert_eq!(
            sftp_name::unescape_wire(&target),
            b"/tmp/caf\xe9/\xffitem.txt".to_vec()
        );
        // clean 名（无转义）按字面量透传，行为与 auto 一致。
        let target = target_path("/tmp", "/var/log/app.log");
        assert_eq!(sftp_name::unescape_wire(&target), b"/tmp/app.log".to_vec());
        // '%' 自转义闭环：真实名字里的字面 %XX 往返不吞。
        let target = target_path("/tmp", "/src/a%2541b");
        assert_eq!(sftp_name::unescape_wire(&target), b"/tmp/a%41b".to_vec());
    }

    #[test]
    fn display_paths_encode_to_server_bytes() {
        // M18 MCP 工具面（PathForm::Display）：from/toDir 是 latin-1 连接上
        // 列表回传的显示形式，target_path 拼接后整条 latin1_encode_display
        // 还原字节——与 MCP 面 sftp_rename 的名字口径一致。
        let target = target_path("/tmp/caf\u{e9}", "/src/\u{ff}item.txt");
        assert_eq!(
            PathForm::Display.decode(&target),
            b"/tmp/caf\xe9/\xffitem.txt".to_vec()
        );
        // ASCII 路径按字面量透传，行为与 auto 一致。
        let target = target_path("/tmp", "/var/log/app.log");
        assert_eq!(PathForm::Display.decode(&target), b"/tmp/app.log".to_vec());
        // 显示形式不引入 %XX 转义语义：字面 %XX 是真实名字的一部分。
        let target = target_path("/tmp", "/src/a%41b");
        assert_eq!(PathForm::Display.decode(&target), b"/tmp/a%41b".to_vec());
    }

    #[test]
    fn outcome_json_matches_the_frontend_contract() {
        let outcome = CopyMoveOutcome {
            success: false,
            results: vec![
                ItemOutcome::ok("/a/one.txt", "/dst/one.txt"),
                ItemOutcome::failed(
                    "/a/two.txt",
                    "/dst/two.txt",
                    "copy failed (exit 1): cp: cannot stat".to_string(),
                ),
            ],
        };
        let value = outcome.into_json();
        assert_eq!(value["success"], false);
        let results = value["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["from"], "/a/one.txt");
        assert_eq!(results[0]["to"], "/dst/one.txt");
        assert_eq!(results[0]["ok"], true);
        assert!(results[0].get("error").is_none(), "ok items carry no error");
        assert_eq!(results[1]["ok"], false);
        assert_eq!(results[1]["error"], "copy failed (exit 1): cp: cannot stat");

        let all_ok = CopyMoveOutcome {
            success: true,
            results: vec![ItemOutcome::ok("/a", "/b")],
        };
        assert_eq!(all_ok.into_json()["success"], true);
    }
}
