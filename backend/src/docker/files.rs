//! `docker/files/list` / `docker/files/read`（B4，只读）：列目录与读文件。
//!
//! 安全边界与 `stats.rs` 同一套红线（计划 §5.1–§5.4）：
//!
//! - 容器 id 先过 `validate_container_id`（`^[0-9a-f]{12,64}$`）。
//! - 路径必须是绝对路径、无 NUL/控制字符、≤4096 字节、按 `/` 分段后无
//!   `.`/`..`、不以 `//` 开头；校验后归一掉尾部 `/`（根除外）。
//! - 脚本体是常量：路径**只**作为 `sh -c '<固定脚本>' sh <path>` 的位置
//!   参数，或本机 `docker exec ... sh -c '<固定脚本>' sh <path>` 的 argv；
//!   脚本文本、`sh -c` 的脚本参数都不含用户输入（§5.2）。
//! - 只读：不写文件、不启动/停止/删除容器，也不因权限失败引入 sudo 提权面。
//!   只读连接放行（§5.4）。
//!
//! 容器侧能力：`sh` + `base64` + `wc` + `head -c` + `tr`。缺失时返回明确
//! 错误（不猜、不静默返回空目录）。不做 chroot 语义——看到的就是
//! `docker exec` 用户在该容器内能看到的 rootfs。
//!
//! 列表输出（NUL 分隔，名字再经 base64，避免 tab/换行/空格破坏解析）：
//! `DBXDOCKER_FILES_BEGIN\0` 后每条 `kind<TAB>size<TAB>base64(name)\0`，
//! 以 `DBXDOCKER_FILES_END\0` 结束；错误时只有
//! `DBXDOCKER_FILES_ERROR\0<message>\0`。脚本最多输出 501 条，Rust 侧
//! 截到 500 条并置 `truncated`。
//!
//! 读取输出：`DBXDOCKER_READ_SIZE\0<total>\0DBXDOCKER_READ_BEGIN\0<base64>
//! \0DBXDOCKER_READ_END\0`。`size` 是文件总字节数，`dataBase64` 是前
//! `min(size, maxBytes)` 字节；`truncated` 即 `size > maxBytes`。

use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::exec;

use super::local::{find_local_cli, run_local};
use super::scripts::PATH_PREFIX;
use super::{validate_container_id, EngineConfig};

/// 单次列表最多返回条数（计划 §2.1）。
pub const FILES_LIST_MAX_ENTRIES: usize = 500;
/// 路径字节上限（§5.3）。
pub const FILES_PATH_MAX_BYTES: usize = 4096;
/// `docker/files/read` 缺省读取上限 = 1 MiB。
pub const FILES_READ_DEFAULT_BYTES: u64 = 1024 * 1024;
/// `docker/files/read` 允许的最大读取上限 = 8 MiB。
pub const FILES_READ_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 列目录的等待上限（一次 `docker exec`）。
pub const FILES_LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// 读文件的等待上限（8 MiB base64 走 SSH 通道需要余量）。
pub const FILES_READ_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) const LIST_BEGIN: &str = "DBXDOCKER_FILES_BEGIN\0";
pub(super) const LIST_END: &str = "DBXDOCKER_FILES_END\0";
const LIST_ERROR: &str = "DBXDOCKER_FILES_ERROR\0";
pub(super) const READ_SIZE: &str = "DBXDOCKER_READ_SIZE\0";
pub(super) const READ_BEGIN: &str = "DBXDOCKER_READ_BEGIN\0";
pub(super) const READ_END: &str = "DBXDOCKER_READ_END\0";
const READ_ERROR: &str = "DBXDOCKER_READ_ERROR\0";

// —— 容器内固定脚本体（常量，不含任何用户输入）——————————————

pub(super) const LIST_INNER: &str = r#"dir=$1
hidden=$2
if [ ! -d "$dir" ]; then
  printf 'DBXDOCKER_FILES_ERROR\000not a directory\000'
  exit 0
fi
if ! command -v base64 >/dev/null 2>&1; then
  printf 'DBXDOCKER_FILES_ERROR\000base64 is not available in the container\000'
  exit 0
fi
printf 'DBXDOCKER_FILES_BEGIN\000'
n=0
if [ "$hidden" = "1" ]; then
  set -- "$dir"/* "$dir"/.[!.]* "$dir"/..?*
else
  set -- "$dir"/*
fi
for f in "$@"; do
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then
    continue
  fi
  n=$((n + 1))
  if [ "$n" -gt 501 ]; then
    break
  fi
  if [ -L "$f" ]; then
    kind=link
    size=0
  elif [ -d "$f" ]; then
    kind=dir
    size=0
  elif [ -f "$f" ]; then
    kind=file
    size=$(wc -c < "$f" 2>/dev/null | tr -d '[:space:]') || size=0
    case "$size" in
      ''|*[!0-9]*) size=0 ;;
    esac
  else
    kind=other
    size=0
  fi
  name=${f##*/}
  enc=$(printf '%s' "$name" | base64 2>/dev/null | tr -d '\n') || enc=
  printf '%s\t%s\t%s\000' "$kind" "$size" "$enc"
done
printf 'DBXDOCKER_FILES_END\000'
"#;

pub(super) const READ_INNER: &str = r#"file=$1
limit=$2
if [ ! -f "$file" ]; then
  printf 'DBXDOCKER_READ_ERROR\000not a regular file\000'
  exit 0
fi
if [ ! -r "$file" ]; then
  printf 'DBXDOCKER_READ_ERROR\000file is not readable\000'
  exit 0
fi
if ! command -v base64 >/dev/null 2>&1; then
  printf 'DBXDOCKER_READ_ERROR\000base64 is not available in the container\000'
  exit 0
fi
total=$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]') || total=
case "$total" in
  ''|*[!0-9]*)
    printf 'DBXDOCKER_READ_ERROR\000cannot stat file\000'
    exit 0
    ;;
esac
printf 'DBXDOCKER_READ_SIZE\000%s\000' "$total"
printf 'DBXDOCKER_READ_BEGIN\000'
head -c "$limit" "$file" 2>/dev/null | base64 2>/dev/null | tr -d '\n'
printf '\000DBXDOCKER_READ_END\000'
"#;

// —— 路径校验（纯函数，§5.3）——————————————————————————————

/// 校验容器内绝对路径。拒绝：空、超 4096 字节、相对路径、`//` 开头、
/// NUL/任意 ASCII 控制字符（含 `\n`/`\t`）、`.`/`..` 段。
pub fn validate_container_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Invalid path: expected a non-empty absolute container path".to_string());
    }
    if path.len() > FILES_PATH_MAX_BYTES {
        return Err(format!(
            "Invalid path: length {} exceeds {FILES_PATH_MAX_BYTES} bytes",
            path.len()
        ));
    }
    if !path.starts_with('/') {
        return Err(format!(
            "Invalid path '{path}': expected an absolute container path"
        ));
    }
    if path.starts_with("//") {
        return Err(format!("Invalid path '{path}': must not start with '//'"));
    }
    if path.as_bytes().contains(&0) {
        return Err("Invalid path: NUL byte is not allowed".to_string());
    }
    if path.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("Invalid path: control characters are not allowed".to_string());
    }
    for segment in path.split('/') {
        if segment == "." || segment == ".." {
            return Err(format!(
                "Invalid path '{path}': '.' and '..' segments are not allowed"
            ));
        }
    }
    Ok(())
}

/// 校验并归一：只去掉尾部 `/`（根 `/` 保持），不做其他改写。
pub fn normalize_container_path(path: &str) -> Result<String, String> {
    validate_container_path(path)?;
    let trimmed = path.trim_end_matches('/');
    Ok(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

/// `showHidden?`（缺省 false；非布尔值按 false 处理）。
pub fn parse_show_hidden(params: &Value) -> bool {
    params
        .get("showHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `maxBytes?`：缺省 1 MiB，显式值必须落在 1..=8 MiB（不静默钳位）。
pub fn parse_max_bytes(params: &Value) -> Result<u64, String> {
    let max_bytes = match params.get("maxBytes") {
        None | Some(Value::Null) => FILES_READ_DEFAULT_BYTES,
        Some(value) => value.as_u64().ok_or_else(|| {
            format!("Invalid maxBytes: expected an integer between 1 and {FILES_READ_MAX_BYTES}")
        })?,
    };
    if max_bytes == 0 || max_bytes > FILES_READ_MAX_BYTES {
        return Err(format!(
            "Invalid maxBytes {max_bytes}: expected 1-{FILES_READ_MAX_BYTES}"
        ));
    }
    Ok(max_bytes)
}

// —— 固定脚本渲染（路径只作位置参数，§5.2）————————————————

/// 外层 POSIX 体：PATH/端点前缀 + `docker exec <id> sh -c <inner> sh "$1" "$2"`。
/// `inner` 是常量脚本文本，`id` 已过 id 门并再 quote 一次（纵深）。
fn outer_body(engine: &EngineConfig, container_id: &str, inner: &str) -> String {
    format!(
        "{PATH_PREFIX}{export}{cli} exec {id} sh -c {inner} sh \"$1\" \"$2\" 2>&1\n",
        export = engine.env_prefix(),
        cli = engine.cli,
        id = exec::shell_quote(container_id),
        inner = exec::shell_quote(inner),
    )
}

/// 远端列目录命令：`sh -c '<常量外层体>' sh <quoted path> <0|1>`。
pub fn files_list_script(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    show_hidden: bool,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    let path = normalize_container_path(path)?;
    Ok(format!(
        "sh -c {} sh {} {}",
        exec::shell_quote(&outer_body(engine, container_id, LIST_INNER)),
        exec::shell_quote(&path),
        if show_hidden { "1" } else { "0" },
    ))
}

/// 远端读文件命令：`sh -c '<常量外层体>' sh <quoted path> <maxBytes>`。
pub fn files_read_script(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    max_bytes: u64,
) -> Result<String, String> {
    validate_container_id(container_id)?;
    if max_bytes == 0 || max_bytes > FILES_READ_MAX_BYTES {
        return Err(format!(
            "Invalid maxBytes {max_bytes}: expected 1-{FILES_READ_MAX_BYTES}"
        ));
    }
    let path = normalize_container_path(path)?;
    Ok(format!(
        "sh -c {} sh {} {}",
        exec::shell_quote(&outer_body(engine, container_id, READ_INNER)),
        exec::shell_quote(&path),
        max_bytes,
    ))
}

/// 本机 argv 形态（无 shell）：`docker exec <id> sh -c <inner> sh <path> <arg>`。
pub fn files_list_args(
    container_id: &str,
    path: &str,
    show_hidden: bool,
) -> Result<Vec<String>, String> {
    validate_container_id(container_id)?;
    let path = normalize_container_path(path)?;
    Ok(vec![
        "exec".to_string(),
        container_id.to_string(),
        "sh".to_string(),
        "-c".to_string(),
        LIST_INNER.to_string(),
        "sh".to_string(),
        path,
        if show_hidden { "1" } else { "0" }.to_string(),
    ])
}

/// 本机 argv 形态的读文件版本。
pub fn files_read_args(
    container_id: &str,
    path: &str,
    max_bytes: u64,
) -> Result<Vec<String>, String> {
    validate_container_id(container_id)?;
    if max_bytes == 0 || max_bytes > FILES_READ_MAX_BYTES {
        return Err(format!(
            "Invalid maxBytes {max_bytes}: expected 1-{FILES_READ_MAX_BYTES}"
        ));
    }
    let path = normalize_container_path(path)?;
    Ok(vec![
        "exec".to_string(),
        container_id.to_string(),
        "sh".to_string(),
        "-c".to_string(),
        READ_INNER.to_string(),
        "sh".to_string(),
        path,
        max_bytes.to_string(),
    ])
}

// —— 输出解析（纯函数）——————————————————————————————

fn marker_body<'a>(output: &'a str, begin: &str, end: &str) -> Option<&'a str> {
    let start = output.find(begin)? + begin.len();
    let length = output[start..].find(end)?;
    Some(&output[start..start + length])
}

pub(super) fn marker_message(output: &str, marker: &str) -> Option<String> {
    let start = output.find(marker)? + marker.len();
    let rest = &output[start..];
    let end = rest.find('\0').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// 错误摘要：只取前 512 字符，NUL 换成空格，避免把整段 Docker 输出塞进错误。
pub fn output_snippet(output: &str) -> String {
    output.replace('\0', " ").trim().chars().take(512).collect()
}

/// 目录项绝对路径拼接（`dir` 已归一）。
pub fn join_container_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// 解析列目录输出。错误标记优先；缺失 begin/end 视为命令级失败。
pub fn files_list_payload(output: &str, path: &str) -> Result<Value, String> {
    if let Some(message) = marker_message(output, LIST_ERROR) {
        return Err(format!("docker/files/list: {message}"));
    }
    let body = marker_body(output, LIST_BEGIN, LIST_END)
        .ok_or_else(|| format!("docker/files/list failed: {}", output_snippet(output)))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for record in body.split('\0') {
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let kind = parts.next().unwrap_or_default();
        let size = parts.next().unwrap_or("0");
        let encoded = parts.next().unwrap_or_default();
        let Some(name) = decode_name(encoded) else {
            continue;
        };
        if entries.len() >= FILES_LIST_MAX_ENTRIES {
            truncated = true;
            break;
        }
        let kind = match kind {
            "file" | "dir" | "link" | "other" => kind,
            _ => "other",
        };
        let size = if kind == "file" {
            size.parse::<u64>().unwrap_or(0)
        } else {
            0
        };
        entries.push(json!({
            "name": name,
            "path": join_container_path(path, &name),
            "kind": kind,
            "size": size,
        }));
    }
    Ok(json!({ "path": path, "entries": entries, "truncated": truncated }))
}

fn decode_name(encoded: &str) -> Option<String> {
    let bytes = STANDARD.decode(encoded).ok()?;
    let name = String::from_utf8(bytes).ok()?;
    // 容器内文件名不能含 `/`；空名同样视为畸形记录（脚本不会产生）。
    (!name.is_empty() && !name.contains('/')).then_some(name)
}

/// 解析读文件输出。`size` 是文件总字节数，数据是前 `min(size, maxBytes)`。
pub fn files_read_payload(output: &str, path: &str, max_bytes: u64) -> Result<Value, String> {
    if let Some(message) = marker_message(output, READ_ERROR) {
        return Err(format!("docker/files/read: {message}"));
    }
    let size_text = marker_message(output, READ_SIZE)
        .ok_or_else(|| format!("docker/files/read failed: {}", output_snippet(output)))?;
    let total: u64 = size_text
        .trim()
        .parse()
        .map_err(|_| format!("docker/files/read: invalid size '{size_text}'"))?;
    let body = marker_body(output, READ_BEGIN, READ_END)
        .ok_or_else(|| format!("docker/files/read failed: {}", output_snippet(output)))?;
    let data = STANDARD
        .decode(body.trim_matches(|c: char| c == '\0' || c.is_whitespace()))
        .map_err(|error| format!("docker/files/read: invalid base64 from container: {error}"))?;
    let expected = total.min(max_bytes) as usize;
    if data.len() != expected {
        return Err(format!(
            "docker/files/read: expected {expected} bytes from container, got {}",
            data.len()
        ));
    }
    Ok(json!({
        "path": path,
        "dataBase64": STANDARD.encode(&data),
        "size": total,
        "truncated": total > max_bytes,
    }))
}

// —— 本机采集（argv 直呼，无 shell）——————————————————————

pub(super) fn missing_cli_error(engine: &EngineConfig) -> String {
    format!(
        "container CLI '{}' was not found on this machine",
        engine.cli
    )
}

/// 本机列目录。
pub async fn collect_files_list_local(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    show_hidden: bool,
) -> Result<Value, String> {
    let args = files_list_args(container_id, path, show_hidden)?;
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Err(missing_cli_error(engine));
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, output) =
        run_local(&cli, &refs, FILES_LIST_TIMEOUT, engine.endpoint.as_deref()).await?;
    if code != 0 {
        return Err(format!(
            "docker/files/list failed (exit {code}): {}",
            output_snippet(&output)
        ));
    }
    files_list_payload(&output, path)
}

/// 本机读文件。
pub async fn collect_files_read_local(
    engine: &EngineConfig,
    container_id: &str,
    path: &str,
    max_bytes: u64,
) -> Result<Value, String> {
    let args = files_read_args(container_id, path, max_bytes)?;
    let Some(cli) = find_local_cli(&engine.cli) else {
        return Err(missing_cli_error(engine));
    };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, output) =
        run_local(&cli, &refs, FILES_READ_TIMEOUT, engine.endpoint.as_deref()).await?;
    if code != 0 {
        return Err(format!(
            "docker/files/read failed (exit {code}): {}",
            output_snippet(&output)
        ));
    }
    files_read_payload(&output, path, max_bytes)
}
