//! `docker/files/write` / `docker/files/delete`（B6，破坏性）。
//!
//! 与 B4 的只读面同一套边界（计划 §5.2–§5.4），额外加三道破坏性门槛：
//!
//! - **路径只走位置参数**：脚本体是常量，`path`/`dataBase64`/临时名只作为
//!   `sh -c '<固定脚本>' sh "$1" "$2" …` 的位置参数，并经 [`exec::shell_quote`]
//!   包裹；id 先过 `validate_container_id`。
//! - **更严的路径字符集**：写/删在 [`normalize_container_path`] 之上再拒绝
//!   shell 元字符（`' " $ ; & | < > \` 等），破坏性方法不接受带元字符的路径。
//! - **删除禁区**：`recursive` 删除拒绝 `/`、`/proc`、`/sys`、`/dev`（容器内
//!   挂载点）；任何删除都拒绝根 `/`。非递归只删普通文件/链接，目录报错。
//! - **写上限与原子写**：`dataBase64` 解码后 ≤64 KiB（超限报错、不截断）；
//!   写入同目录唯一临时名（pid+时间+序号）后 `mv` 覆盖，失败路径由 `trap`
//!   清理临时文件；`overwrite` 缺省 false，目标已存在时报可读错误。
//!
//! 只读连接在 RPC 层用 [`mutation_access`] 拒绝（文案与 `ensure_writable`
//! 同族）；`target:"local"` 无连接语义，但 `delete` 仍要求 `confirm: true`。
//! 审计（§5.8）由 `rpc.rs` 在**执行前**写意图行，命令文本只含路径与字节数，
//! 绝不含文件内容。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::exec;

use super::files::{marker_message, missing_cli_error, normalize_container_path, output_snippet};
use super::local::{find_local_cli, run_local};
use super::scripts::PATH_PREFIX;
use super::{validate_container_id, EngineConfig};

/// 单次写入的 base64 解码后上限 = 64 KiB（计划 §5.6）。
pub const FILES_WRITE_MAX_BYTES: usize = 64 * 1024;
/// 写/删的等待上限（一次 `docker exec`）。
pub const FILES_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
pub const FILES_DELETE_TIMEOUT: Duration = Duration::from_secs(30);

pub const WRITE_ERROR: &str = "DBXDOCKER_WRITE_ERROR\0";
pub const WRITE_RESULT: &str = "DBXDOCKER_WRITE_RESULT\0";
pub const WRITE_OK: &str = "DBXDOCKER_WRITE_OK\0";
pub const DELETE_ERROR: &str = "DBXDOCKER_DELETE_ERROR\0";
pub const DELETE_OK: &str = "DBXDOCKER_DELETE_OK\0";

/// 只读连接的拒绝文案：与 `ssh::ensure_writable` 完全一致（B5 中性文案）。
pub const READ_ONLY_MUTATION_MESSAGE: &str =
    "Write/terminal operation is disabled by the read-only connection setting";

/// 删除禁区：容器内的挂载点。`recursive` 删除时按整路径精确拒绝。
pub const DELETE_FORBIDDEN_RECURSIVE: [&str; 4] = ["/", "/proc", "/sys", "/dev"];

/// 破坏性路径额外拒绝的字符（位置参数已 quote，这里是纵深防御）。
const FORBIDDEN_PATH_CHARS: &[char] = &[
    '\'', '"', '`', '$', ';', '&', '|', '<', '>', '\\', '!', '(', ')', '{', '}', '*', '?', '[',
    ']', '#', '~', '^', '%',
];

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

// —— 容器内固定脚本体（常量，不含任何用户输入）——————————————

/// `$1`=target `$2`=base64 `$3`=0|1 overwrite `$4`=temp path。
pub(super) const WRITE_INNER: &str = r#"target=$1
b64=$2
overwrite=$3
tmp=$4
if [ -z "$target" ] || [ "$target" = "/" ]; then
  printf 'DBXDOCKER_WRITE_ERROR\000invalid target path\000'
  exit 0
fi
if [ -d "$target" ]; then
  printf 'DBXDOCKER_WRITE_ERROR\000target is a directory\000'
  exit 0
fi
if [ -e "$target" ] && [ "$overwrite" != "1" ]; then
  printf 'DBXDOCKER_WRITE_ERROR\000file already exists (set overwrite to replace it)\000'
  exit 0
fi
if [ -e "$tmp" ]; then
  printf 'DBXDOCKER_WRITE_ERROR\000temporary file already exists\000'
  exit 0
fi
if ! command -v base64 >/dev/null 2>&1; then
  printf 'DBXDOCKER_WRITE_ERROR\000base64 is not available in the container\000'
  exit 0
fi
cleanup() { rm -f "$tmp" 2>/dev/null; }
trap cleanup EXIT HUP INT TERM
if ! printf '%s' "$b64" | base64 -d > "$tmp" 2>/dev/null; then
  printf 'DBXDOCKER_WRITE_ERROR\000cannot decode data\000'
  exit 0
fi
existed=0
if [ -e "$target" ]; then
  existed=1
fi
if ! mv -f "$tmp" "$target" 2>/dev/null; then
  printf 'DBXDOCKER_WRITE_ERROR\000cannot replace target file\000'
  exit 0
fi
trap - EXIT HUP INT TERM
size=$(wc -c < "$target" 2>/dev/null | tr -d '[:space:]') || size=
case "$size" in
  ''|*[!0-9]*) size=0 ;;
esac
printf 'DBXDOCKER_WRITE_RESULT\000%s\000%s\000' "$size" "$existed"
printf 'DBXDOCKER_WRITE_OK\000'
"#;

/// `$1`=target `$2`=0|1 recursive。
pub(super) const DELETE_INNER: &str = r#"target=$1
recursive=$2
if [ -z "$target" ] || [ "$target" = "/" ]; then
  printf 'DBXDOCKER_DELETE_ERROR\000invalid target path\000'
  exit 0
fi
if [ "$recursive" = "1" ]; then
  case "$target" in
    /proc|/sys|/dev)
      printf 'DBXDOCKER_DELETE_ERROR\000refusing to recursively delete a container mount point\000'
      exit 0
      ;;
  esac
fi
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  printf 'DBXDOCKER_DELETE_ERROR\000no such file or directory\000'
  exit 0
fi
if [ -L "$target" ]; then
  if ! rm -f "$target" 2>/dev/null; then
    printf 'DBXDOCKER_DELETE_ERROR\000cannot remove path\000'
    exit 0
  fi
elif [ -d "$target" ]; then
  if [ "$recursive" != "1" ]; then
    printf 'DBXDOCKER_DELETE_ERROR\000target is a directory (set recursive to remove it)\000'
    exit 0
  fi
  if ! rm -rf "$target" 2>/dev/null; then
    printf 'DBXDOCKER_DELETE_ERROR\000cannot remove directory\000'
    exit 0
  fi
else
  if ! rm -f "$target" 2>/dev/null; then
    printf 'DBXDOCKER_DELETE_ERROR\000cannot remove file\000'
    exit 0
  fi
fi
printf 'DBXDOCKER_DELETE_OK\000'
"#;

// —— 参数与路径校验（纯函数）——————————————————————————————

/// 破坏性方法的路径校验：先走 B4 的 [`normalize_container_path`]，再拒绝
/// shell 元字符。`..`/相对路径/控制字符/NUL/超长由前者负责。
pub fn validate_mutation_path(path: &str) -> Result<String, String> {
    let path = normalize_container_path(path)?;
    if path.chars().any(|ch| FORBIDDEN_PATH_CHARS.contains(&ch)) {
        return Err(format!(
            "Invalid path '{path}': shell metacharacters are not allowed in a write/delete path"
        ));
    }
    Ok(path)
}

/// `overwrite?`：缺省 false；显式值必须是布尔（破坏性方法不猜）。
pub fn parse_overwrite(params: &Value) -> Result<bool, String> {
    match params.get("overwrite") {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Invalid overwrite: expected a boolean".to_string()),
    }
}

/// `recursive?`：缺省 false；显式值必须是布尔。
pub fn parse_recursive(params: &Value) -> Result<bool, String> {
    match params.get("recursive") {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Invalid recursive: expected a boolean".to_string()),
    }
}

/// `confirm?`（仅本机删除要求 true）。
pub fn parse_confirm(params: &Value) -> Result<bool, String> {
    match params.get("confirm") {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| "Invalid confirm: expected a boolean".to_string()),
    }
}

/// 解码并校验 `dataBase64`：解码后 ≤64 KiB，超限报错不截断；返回规范化
/// base64（重编码后只含 base64 字母表）与解码字节数。
pub fn parse_write_data(params: &Value) -> Result<(String, usize), String> {
    let encoded = params
        .get("dataBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid dataBase64: expected a base64 string".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid dataBase64: expected standard base64".to_string())?;
    if bytes.len() > FILES_WRITE_MAX_BYTES {
        return Err(format!(
            "Invalid dataBase64: decoded size {} exceeds {FILES_WRITE_MAX_BYTES} bytes (64 KiB)",
            bytes.len()
        ));
    }
    Ok((STANDARD.encode(&bytes), bytes.len()))
}

/// 删除路径校验：任何删除拒绝根 `/`；`recursive` 时再精确拒绝容器挂载点。
pub fn validate_delete_path(path: &str, recursive: bool) -> Result<String, String> {
    let path = validate_mutation_path(path)?;
    if path == "/" {
        return Err("Refusing to delete the container root '/'".to_string());
    }
    if recursive && DELETE_FORBIDDEN_RECURSIVE.contains(&path.as_str()) {
        return Err(format!(
            "Refusing to recursively delete the container mount point '{path}'"
        ));
    }
    Ok(path)
}

/// 生成与目标同目录的唯一临时文件名：`.dbx-docker-write-<pid>-<nanos>-<seq>.tmp`。
pub fn write_temp_path(path: &str) -> Result<String, String> {
    let path = validate_mutation_path(path)?;
    if path == "/" {
        return Err("Refusing to write to the container root '/'".to_string());
    }
    let dir = match path.rfind('/') {
        Some(0) | None => "/",
        Some(index) => &path[..index],
    };
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let prefix = if dir == "/" { "" } else { dir };
    Ok(format!(
        "{prefix}/.dbx-docker-write-{pid}-{nanos}-{seq}.tmp"
    ))
}

/// 只读连接门：判定与文案收敛到一处，供 write/delete 共用（§5.4）。
pub fn mutation_access(read_only: bool) -> Result<(), String> {
    if read_only {
        Err(READ_ONLY_MUTATION_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

// —— 固定脚本渲染（路径/数据只作位置参数，§5.2）——————————————

fn outer_body(engine: &EngineConfig, container_id: &str, inner: &str, args: &str) -> String {
    format!(
        "{PATH_PREFIX}{export}{cli} exec {id} sh -c {inner} sh {args} 2>&1\n",
        export = engine.env_prefix(),
        cli = engine.cli,
        id = exec::shell_quote(container_id),
        inner = exec::shell_quote(inner),
    )
}

/// 远端写文件：`sh -c '<常量外层体>' sh <path> <base64> <0|1> <temp>`。
pub fn files_write_script(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    data_base64: &str,
    overwrite: bool,
    temp_path: &str,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    let path = validate_mutation_path(path)?;
    let temp_path = validate_mutation_path(temp_path)?;
    Ok(format!(
        "sh -c {} sh {} {} {} {}",
        exec::shell_quote(&outer_body(
            engine,
            container_id,
            WRITE_INNER,
            "\"$1\" \"$2\" \"$3\" \"$4\""
        )),
        exec::shell_quote(&path),
        exec::shell_quote(data_base64),
        if overwrite { "1" } else { "0" },
        exec::shell_quote(&temp_path),
    ))
}

/// 远端删文件/目录：`sh -c '<常量外层体>' sh <path> <0|1>`。
pub fn files_delete_script(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    recursive: bool,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    let path = validate_delete_path(path, recursive)?;
    Ok(format!(
        "sh -c {} sh {} {}",
        exec::shell_quote(&outer_body(
            engine,
            container_id,
            DELETE_INNER,
            "\"$1\" \"$2\""
        )),
        exec::shell_quote(&path),
        if recursive { "1" } else { "0" },
    ))
}

/// 本机 argv 形态（无 shell）。
pub fn files_write_args(
    container_id: &str,
    path: &str,
    data_base64: &str,
    overwrite: bool,
    temp_path: &str,
) -> Result<Vec<String>, String> {
    validate_container_id(container_id)?;
    let path = validate_mutation_path(path)?;
    let temp_path = validate_mutation_path(temp_path)?;
    Ok(vec![
        "exec".to_string(),
        container_id.to_string(),
        "sh".to_string(),
        "-c".to_string(),
        WRITE_INNER.to_string(),
        "sh".to_string(),
        path,
        data_base64.to_string(),
        if overwrite { "1" } else { "0" }.to_string(),
        temp_path,
    ])
}

/// 本机 argv 形态的删除版本。
pub fn files_delete_args(
    container_id: &str,
    path: &str,
    recursive: bool,
) -> Result<Vec<String>, String> {
    validate_container_id(container_id)?;
    let path = validate_delete_path(path, recursive)?;
    Ok(vec![
        "exec".to_string(),
        container_id.to_string(),
        "sh".to_string(),
        "-c".to_string(),
        DELETE_INNER.to_string(),
        "sh".to_string(),
        path,
        if recursive { "1" } else { "0" }.to_string(),
    ])
}

// —— 审计命令文本（不含文件内容，§5.8）——————————————————————

/// `<cli> exec <id> ... write <path> <bytes> bytes`。
pub fn files_write_command(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    bytes: usize,
) -> String {
    format!(
        "{} exec {} ... write {} {} bytes",
        engine.cli, container_id, path, bytes
    )
}

/// `<cli> exec <id> ... delete <path>`。
pub fn files_delete_command(engine: &EngineConfig, container_id: &str, path: &str) -> String {
    format!("{} exec {} ... delete {}", engine.cli, container_id, path)
}

// —— 输出解析（纯函数）——————————————————————————————

/// 解析写文件输出：`WRITE_RESULT\0<size>\0<existed>\0` + `WRITE_OK`。
pub fn files_write_payload(output: &str, path: &str) -> Result<Value, String> {
    if let Some(message) = marker_message(output, WRITE_ERROR) {
        return Err(format!("docker/files/write: {message}"));
    }
    let start = output
        .find(WRITE_RESULT)
        .map(|index| index + WRITE_RESULT.len())
        .ok_or_else(|| format!("docker/files/write failed: {}", output_snippet(output)))?;
    let mut parts = output[start..].split('\0');
    let size = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| format!("docker/files/write failed: {}", output_snippet(output)))?;
    let overwritten = parts.next() == Some("1");
    if !output.contains(WRITE_OK) {
        return Err(format!(
            "docker/files/write failed: {}",
            output_snippet(output)
        ));
    }
    Ok(json!({
        "path": path,
        "size": size,
        "overwritten": overwritten,
    }))
}

/// 解析删除输出：只有 `DELETE_OK` 表示成功。
pub fn files_delete_payload(output: &str, path: &str) -> Result<Value, String> {
    if let Some(message) = marker_message(output, DELETE_ERROR) {
        return Err(format!("docker/files/delete: {message}"));
    }
    if !output.contains(DELETE_OK) {
        return Err(format!(
            "docker/files/delete failed: {}",
            output_snippet(output)
        ));
    }
    Ok(json!({ "path": path, "removed": true }))
}

// —— 本机执行 ——————————————————————————————————————————

pub async fn collect_files_write_local(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    data_base64: &str,
    overwrite: bool,
    temp_path: &str,
) -> Result<Value, String> {
    let path = validate_mutation_path(path)?;
    let args = files_write_args(container_id, &path, data_base64, overwrite, temp_path)?;
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Err(missing_cli_error(engine));
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, output) =
        run_local(&cli, &refs, FILES_WRITE_TIMEOUT, engine.endpoint.as_deref()).await?;
    if code != 0 {
        return Err(format!(
            "docker/files/write failed (exit {code}): {}",
            output_snippet(&output)
        ));
    }
    files_write_payload(&output, &path)
}

pub async fn collect_files_delete_local(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    recursive: bool,
) -> Result<Value, String> {
    let path = validate_delete_path(path, recursive)?;
    let args = files_delete_args(container_id, &path, recursive)?;
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Err(missing_cli_error(engine));
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, output) = run_local(
        &cli,
        &refs,
        FILES_DELETE_TIMEOUT,
        engine.endpoint.as_deref(),
    )
    .await?;
    if code != 0 {
        return Err(format!(
            "docker/files/delete failed (exit {code}): {}",
            output_snippet(&output)
        ));
    }
    files_delete_payload(&output, &path)
}
