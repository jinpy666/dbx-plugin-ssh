//! Plugin-level UI preferences persisted in `<plugin_data_dir>/preferences.json`.
//! The workbench iframe is sandboxed (`sandbox="allow-scripts"`, opaque origin),
//! so `window.localStorage` throws and this sidecar file is the only durable
//! store for workbench preferences such as the download directory. The schema
//! is a fixed allowlist — arbitrary keys from the renderer are dropped.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Map, Value};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "preferences.json";
/// Bounded so a broken renderer cannot grow the file without limit.
const MAX_DOWNLOAD_DIR_LEN: usize = 512;

const MAX_TIMESTAMP_FORMAT_LEN: usize = 64;

/// 右键「在线搜索」引擎表原始文本（每行 name|url 模板）上限：12 行内短串足够，
/// 更大的输入按坏输入截断（前端解析器同样有行数/长度上限）。
const MAX_CTX_SEARCH_ENGINES_LEN: usize = 2048;

/// 背景图（P2-9）落盘位置：`<plugin_data_dir>/wallpaper`（无扩展名，格式由
/// 魔数判定），与 preferences.json 同层。
const WALLPAPER_FILE_NAME: &str = "wallpaper";
/// 背景图上限 8 MiB。
const WALLPAPER_MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn wallpaper_path(data_dir: &Path) -> PathBuf {
    data_dir.join(WALLPAPER_FILE_NAME)
}

/// png / jpeg / webp 魔数识别；其余一律拒绝（不信任扩展名）。
fn detect_image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpeg");
    }
    if bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        return Some("webp");
    }
    None
}

/// 读取落盘背景并打包成 data URL；文件缺失或魔数非法（手工替换/损坏）一律
/// 返回空对象，前端按无背景处理。
pub fn load_wallpaper(data_dir: &Path) -> Value {
    let bytes = match std::fs::read(wallpaper_path(data_dir)) {
        Ok(bytes) => bytes,
        Err(_) => return json!({}),
    };
    match detect_image_format(&bytes) {
        Some(format) => json!({
            "dataUrl": format!("data:image/{format};base64,{}", BASE64_STANDARD.encode(bytes)),
        }),
        None => json!({}),
    }
}

/// 保存背景图：校验 ≤8 MiB 且为 png/jpeg/webp 魔数后原子落盘（tmp + rename），
/// 返回与 get 相同的 data URL 载荷。
pub fn save_wallpaper(data_dir: &Path, params: &Value) -> Result<Value, String> {
    let data_base64 = params
        .get("imageBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| "imageBase64 must be a base64 string".to_string())?;
    // 粗判：base64 每 3 字节占 4 字符，超限先拒，避免无谓解码大 payload。
    if data_base64.len() > WALLPAPER_MAX_BYTES / 3 * 4 + 4 {
        return Err(format!(
            "imageBase64 exceeds the wallpaper limit of {} MiB",
            WALLPAPER_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(data_base64.trim())
        .map_err(|error| format!("imageBase64 is not valid base64: {error}"))?;
    if bytes.is_empty() || bytes.len() > WALLPAPER_MAX_BYTES {
        return Err(format!(
            "imageBase64 exceeds the wallpaper limit of {} MiB",
            WALLPAPER_MAX_BYTES / 1024 / 1024
        ));
    }
    detect_image_format(&bytes)
        .ok_or_else(|| "imageBase64 must be a png, jpeg or webp image".to_string())?;
    let path = wallpaper_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("wallpaper.tmp");
    std::fs::write(&tmp, &bytes)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(load_wallpaper(data_dir))
}

/// 清除背景图：文件不存在视为成功（幂等）。
pub fn clear_wallpaper(data_dir: &Path) -> Value {
    let _ = std::fs::remove_file(wallpaper_path(data_dir));
    json!({})
}

pub fn store_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(FILE_NAME)
}

fn sanitize_download_dir(value: &Value) -> Option<String> {
    let dir = value.as_str()?.trim();
    Some(dir.chars().take(MAX_DOWNLOAD_DIR_LEN).collect())
}

/// 本地终端 shell 偏好：程序路径或可解析名，空串=跟随自动探测。
fn sanitize_local_shell(value: &Value) -> Option<String> {
    let shell = value.as_str()?.trim();
    Some(shell.chars().take(200).collect())
}

/// 冲突策略白名单：自动重命名（默认）/ 询问我 / 覆盖已有文件。
fn sanitize_conflict_policy(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "rename" => Some("rename"),
        "ask" => Some("ask"),
        "overwrite" => Some("overwrite"),
        _ => None,
    }
}

/// RDP 证书策略白名单（评审定案，RDP_CREDSSP_REVIEW_CHECKLIST §3-C）：
/// prompt（默认，120s 确认窗）/ strict / accept-temporarily。不存在
/// 「静默接受任意证书」的选项——白名单之外一律拒绝写入。
fn sanitize_rdp_certificate_policy(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "prompt" => Some("prompt"),
        "strict" => Some("strict"),
        "accept-temporarily" => Some("accept-temporarily"),
        _ => None,
    }
}

/// 会话级传输并发深度（M14-B）：1..=8，缺省 3（与历史硬编码一致）。
pub const TRANSFER_MAX_ACTIVE_MIN: u64 = 1;
pub const TRANSFER_MAX_ACTIVE_MAX: u64 = 8;
pub const TRANSFER_MAX_ACTIVE_DEFAULT: u64 = 3;

/// 传输并发深度：超界钳制、非法回落默认；键不存在返回 None（上层用默认）。
pub fn sanitize_transfer_max_active(value: &Value) -> u64 {
    sanitize_u64_clamped(
        value,
        TRANSFER_MAX_ACTIVE_MIN,
        TRANSFER_MAX_ACTIVE_MAX,
        TRANSFER_MAX_ACTIVE_DEFAULT,
    )
}

/// 读取并发深度（缺省回默认值）。sidecar 每次任务启动时现读现用——
/// 改动即时生效，进行中的任务按原深度自然完成。
pub fn transfer_max_active(data_dir: &Path) -> u64 {
    let prefs = load_preferences(data_dir);
    prefs
        .get("transfer_max_active")
        .map(sanitize_transfer_max_active)
        .unwrap_or(TRANSFER_MAX_ACTIVE_DEFAULT)
}

/// 老旧服务器兼容模式（M14-B）：缺省关。开启后 SFTP 会话不做流水线并发、
/// 传输深度强制 1，并避开非标准扩展请求。
pub fn sftp_compat_mode(data_dir: &Path) -> bool {
    load_preferences(data_dir)
        .get("sftp_compat_mode")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 连接级文件名编码覆盖（M16）：`{ <connectionId>: "auto"|"latin-1" }`。
/// 桶上限与 `startup_commands` 的连接数上限同向，防手改文件无限膨胀。
pub const SFTP_NAME_ENCODING_OVERRIDES_MAX_CONNECTIONS: usize = 512;

/// 覆盖桶清洗：键为 connectionId、值走编码白名单；非法桶/非法值静默丢弃
/// （手改文件不得卡死工作台，与 `startup_commands::sanitize_store` 同向），
/// 桶数超限截断。
pub fn sanitize_sftp_encoding_overrides(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut out = Map::new();
    for (connection_id, entry) in object {
        if out.len() >= SFTP_NAME_ENCODING_OVERRIDES_MAX_CONNECTIONS {
            break;
        }
        if connection_id.trim().is_empty() {
            continue;
        }
        if let Some(encoding) = entry
            .as_str()
            .and_then(crate::sftp_name::NameEncoding::parse)
        {
            out.insert(
                connection_id.clone(),
                Value::String(encoding.as_str().to_string()),
            );
        }
    }
    Some(Value::Object(out))
}

/// 优先级解析（M16 纯函数）：连接覆盖 > 全局偏好 > 缺省 auto。
/// 白名单回退语义：覆盖值/全局值非法（含非白名单串）一律视为「未设置」，
/// 由下一级兜底，绝不因手改文件报错。
pub fn resolve_sftp_name_encoding(
    override_value: Option<&str>,
    global_value: Option<&str>,
) -> crate::sftp_name::NameEncoding {
    let parse = |raw: Option<&str>| raw.and_then(crate::sftp_name::NameEncoding::parse);
    parse(override_value)
        .or_else(|| parse(global_value))
        .unwrap_or(crate::sftp_name::NameEncoding::Auto)
}

/// 连接级编码判定：`connection_id` 命中覆盖桶（且值合法）时覆盖全局偏好，
/// 否则跟随全局，再缺省 auto。单次读盘，判定点每次调用现读现用。
pub fn sftp_name_encoding_for(
    data_dir: &Path,
    connection_id: Option<&str>,
) -> crate::sftp_name::NameEncoding {
    let prefs = load_preferences(data_dir);
    let override_value = connection_id.and_then(|id| {
        prefs
            .get("sftp_name_encoding_overrides")
            .and_then(|store| store.get(id))
            .and_then(Value::as_str)
    });
    resolve_sftp_name_encoding(
        override_value,
        prefs.get("sftp_name_encoding").and_then(Value::as_str),
    )
}

/// 数值偏好钳制：非负整数夹进 [min, max]，超界取边界、非法取 fallback。
fn sanitize_u64_clamped(value: &Value, min: u64, max: u64, fallback: u64) -> u64 {
    let raw = match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    };
    match raw {
        Some(value) => value.clamp(min, max),
        None => fallback,
    }
}

/// 动作链接三类匹配器开关（ipv4/host_port/archive）。逐字段收紧、缺省 true；
/// 整键缺失或形状非法由调用方跳过（前端按缺省处理）。
fn sanitize_action_links_matchers(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let flag = |key: &str| object.get(key).and_then(Value::as_bool).unwrap_or(true);
    Some(json!({
        "ipv4": flag("ipv4"),
        "host_port": flag("host_port"),
        "archive": flag("archive"),
    }))
}

/// 终端时间戳格式：白名单字符（字母数字与 []:-./, 空格）+ 64 字符截断；
/// 清洗后为空回退默认 "[HH:mm:ss]"，与前端 sanitizeGutterSettings 同向。
fn sanitize_timestamp_format(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    let cleaned: String = raw
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '[' | ']' | ':' | '-' | '.' | '/' | ',' | ' ')
        })
        .take(MAX_TIMESTAMP_FORMAT_LEN)
        .collect();
    let trimmed = cleaned.trim();
    Some(if trimmed.is_empty() {
        "[HH:mm:ss]".to_string()
    } else {
        cleaned
    })
}

/// 在线搜索引擎表原始文本：仅裁首尾空白并截断到上限；行级校验在前端解析器。
fn sanitize_ctx_search_engines(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    Some(text.chars().take(MAX_CTX_SEARCH_ENGINES_LEN).collect())
}

/// Reads the raw preferences map; a missing or corrupted file yields an empty
/// map so a bad file can never break the workbench (same policy as
/// quick-commands).
fn load_map(data_dir: &Path) -> Map<String, Value> {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("prefs")?.as_object().cloned())
        .unwrap_or_default()
}

/// Public view: only allowlisted keys, normalized.
pub fn load_preferences(data_dir: &Path) -> Value {
    let map = load_map(data_dir);
    let mut prefs = Map::new();
    if let Some(dir) = map.get("downloadDir").and_then(sanitize_download_dir) {
        prefs.insert("downloadDir".to_string(), Value::String(dir));
    }
    if let Some(use_default) = map.get("downloadUseDefaultDir").and_then(Value::as_bool) {
        prefs.insert(
            "downloadUseDefaultDir".to_string(),
            Value::Bool(use_default),
        );
    }
    if let Some(policy) = map
        .get("downloadConflictPolicy")
        .and_then(sanitize_conflict_policy)
    {
        prefs.insert(
            "downloadConflictPolicy".to_string(),
            Value::String(policy.to_string()),
        );
    }
    if let Some(shell) = map.get("localShell").and_then(sanitize_local_shell) {
        prefs.insert("localShell".to_string(), Value::String(shell));
    }
    if let Some(integration) = map.get("localShellIntegration").and_then(Value::as_bool) {
        prefs.insert(
            "localShellIntegration".to_string(),
            Value::Bool(integration),
        );
    }
    // 上传并发（1..=10，默认 3）与重复目标策略（P1-5）。
    if map.contains_key("transfer_concurrency") {
        let concurrency = sanitize_u64_clamped(&map["transfer_concurrency"], 1, 10, 3);
        prefs.insert("transfer_concurrency".to_string(), Value::from(concurrency));
    }
    if let Some(policy) = map
        .get("transfer_duplicate_policy")
        .and_then(sanitize_conflict_policy)
    {
        prefs.insert(
            "transfer_duplicate_policy".to_string(),
            Value::String(policy.to_string()),
        );
    }
    // 会话级传输并发深度（M14-B）与老旧服务器兼容模式、文件名编码偏好。
    if map.contains_key("transfer_max_active") {
        prefs.insert(
            "transfer_max_active".to_string(),
            Value::from(sanitize_transfer_max_active(&map["transfer_max_active"])),
        );
    }
    if let Some(enabled) = map.get("sftp_compat_mode").and_then(Value::as_bool) {
        prefs.insert("sftp_compat_mode".to_string(), Value::Bool(enabled));
    }
    if let Some(encoding) = map
        .get("sftp_name_encoding")
        .and_then(Value::as_str)
        .and_then(crate::sftp_name::NameEncoding::parse)
    {
        prefs.insert(
            "sftp_name_encoding".to_string(),
            Value::String(encoding.as_str().to_string()),
        );
    }
    // 连接级文件名编码覆盖（M16）：按 connectionId 分桶，形状清洗在
    // sanitize_sftp_encoding_overrides（单测覆盖）；键不存在时不出现。
    if let Some(store) = map
        .get("sftp_name_encoding_overrides")
        .and_then(sanitize_sftp_encoding_overrides)
    {
        prefs.insert("sftp_name_encoding_overrides".to_string(), store);
    }
    // 命令输入建议（P1-1）：开关（默认开）与查询长度上下限。
    if let Some(enabled) = map
        .get("history_suggestions_enabled")
        .and_then(Value::as_bool)
    {
        prefs.insert(
            "history_suggestions_enabled".to_string(),
            Value::Bool(enabled),
        );
    }
    if map.contains_key("history_suggestion_min_chars") {
        let min_chars = sanitize_u64_clamped(&map["history_suggestion_min_chars"], 1, 16, 2);
        prefs.insert(
            "history_suggestion_min_chars".to_string(),
            Value::from(min_chars),
        );
    }
    if map.contains_key("history_suggestion_max_chars") {
        let max_chars = sanitize_u64_clamped(&map["history_suggestion_max_chars"], 8, 512, 64);
        prefs.insert(
            "history_suggestion_max_chars".to_string(),
            Value::from(max_chars),
        );
    }
    if let Some(enabled) = map.get("action_links_enabled").and_then(Value::as_bool) {
        prefs.insert("action_links_enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(matchers) = map
        .get("action_links_matchers")
        .and_then(sanitize_action_links_matchers)
    {
        prefs.insert("action_links_matchers".to_string(), matchers);
    }
    if let Some(line_numbers) = map
        .get("terminal_show_line_numbers")
        .and_then(Value::as_bool)
    {
        prefs.insert(
            "terminal_show_line_numbers".to_string(),
            Value::Bool(line_numbers),
        );
    }
    if let Some(timestamps) = map.get("terminal_show_timestamps").and_then(Value::as_bool) {
        prefs.insert(
            "terminal_show_timestamps".to_string(),
            Value::Bool(timestamps),
        );
    }
    if let Some(format) = map
        .get("terminal_timestamp_format")
        .and_then(sanitize_timestamp_format)
    {
        prefs.insert(
            "terminal_timestamp_format".to_string(),
            Value::String(format),
        );
    }
    if let Some(engines) = map
        .get("ctx_search_engines")
        .and_then(sanitize_ctx_search_engines)
    {
        prefs.insert("ctx_search_engines".to_string(), Value::String(engines));
    }
    // 背景图开关与透明度（百分比 10..=90，缺省 45；前端展示时 /100）。
    if let Some(enabled) = map.get("wallpaper_enabled").and_then(Value::as_bool) {
        prefs.insert("wallpaper_enabled".to_string(), Value::Bool(enabled));
    }
    if map.contains_key("wallpaper_opacity") {
        let opacity = sanitize_u64_clamped(&map["wallpaper_opacity"], 10, 90, 45);
        prefs.insert("wallpaper_opacity".to_string(), Value::from(opacity));
    }
    // 连接级启动命令（P0-4，Tabby Login scripts 对标）：按 connectionId 分桶，
    // 形状清洗在 startup_commands 模块（单测覆盖）。
    if let Some(store) = map
        .get("startup_commands")
        .and_then(crate::startup_commands::sanitize_store)
    {
        prefs.insert("startup_commands".to_string(), store);
    }
    // RDP 安全设置（RDP-2）：use_nla 缺省 true、证书策略缺省 prompt；
    // 键不存在时不出现（前端按缺省处理）。
    if let Some(enabled) = map.get("rdp_experimental_enabled").and_then(Value::as_bool) {
        prefs.insert("rdp_experimental_enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(use_nla) = map.get("rdp_use_nla").and_then(Value::as_bool) {
        prefs.insert("rdp_use_nla".to_string(), Value::Bool(use_nla));
    }
    if let Some(policy) = map
        .get("rdp_certificate_policy")
        .and_then(sanitize_rdp_certificate_policy)
    {
        prefs.insert(
            "rdp_certificate_policy".to_string(),
            Value::String(policy.to_string()),
        );
    }

    Value::Object(prefs)
}

/// RDP is intentionally opt-in until the real-server validation matrix is complete.
/// Missing, malformed, or false values fail closed.
pub fn rdp_experimental_enabled(data_dir: &Path) -> bool {
    load_preferences(data_dir)
        .get("rdp_experimental_enabled")
        .and_then(Value::as_bool)
        == Some(true)
}

/// Merges the allowlisted keys present in `params` into the store and persists
/// atomically (tmp + rename). Returns the stored preferences.
pub fn save_preferences(data_dir: &Path, params: &Value) -> Result<Value, String> {
    let mut map = load_map(data_dir);
    if let Some(value) = params.get("downloadDir") {
        let dir = sanitize_download_dir(value)
            .ok_or_else(|| "downloadDir must be a string".to_string())?;
        map.insert("downloadDir".to_string(), Value::String(dir));
    }
    if let Some(value) = params.get("downloadUseDefaultDir") {
        let use_default = value
            .as_bool()
            .ok_or_else(|| "downloadUseDefaultDir must be a boolean".to_string())?;
        map.insert(
            "downloadUseDefaultDir".to_string(),
            Value::Bool(use_default),
        );
    }
    if let Some(value) = params.get("downloadConflictPolicy") {
        let policy = sanitize_conflict_policy(value)
            .ok_or_else(|| "downloadConflictPolicy must be rename, ask or overwrite".to_string())?;
        map.insert(
            "downloadConflictPolicy".to_string(),
            Value::String(policy.to_string()),
        );
    }
    if let Some(value) = params.get("localShell") {
        let shell =
            sanitize_local_shell(value).ok_or_else(|| "localShell must be a string".to_string())?;
        map.insert("localShell".to_string(), Value::String(shell));
    }
    if let Some(value) = params.get("localShellIntegration") {
        let integration = value
            .as_bool()
            .ok_or_else(|| "localShellIntegration must be a boolean".to_string())?;
        map.insert(
            "localShellIntegration".to_string(),
            Value::Bool(integration),
        );
    }
    // 上传并发/重复策略与命令建议键：数值一律钳制到合法区间（非法回落默认），
    // 不报错，保证旧前端/手改文件不会把偏好写入卡死。
    if params.get("transfer_concurrency").is_some() {
        map.insert(
            "transfer_concurrency".to_string(),
            Value::from(sanitize_u64_clamped(
                &params["transfer_concurrency"],
                1,
                10,
                3,
            )),
        );
    }
    if let Some(value) = params.get("x11_forwarding") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "x11_forwarding must be a boolean".to_string())?;
        map.insert("x11_forwarding".to_string(), Value::Bool(enabled));
    }
    // 会话自动录制（M14）：默认关；只读连接不禁用（录制是被动输出捕获，
    // 不向远端发送任何内容）。
    if let Some(value) = params.get("auto_record") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "auto_record must be a boolean".to_string())?;
        map.insert("auto_record".to_string(), Value::Bool(enabled));
    }
    if let Some(value) = params.get("transfer_duplicate_policy") {
        let policy = sanitize_conflict_policy(value).ok_or_else(|| {
            "transfer_duplicate_policy must be rename, ask or overwrite".to_string()
        })?;
        map.insert(
            "transfer_duplicate_policy".to_string(),
            Value::String(policy.to_string()),
        );
    }
    // M14-B 三键：并发深度钳制到 1..=8；兼容模式布尔；编码走白名单。
    if params.get("transfer_max_active").is_some() {
        map.insert(
            "transfer_max_active".to_string(),
            Value::from(sanitize_transfer_max_active(&params["transfer_max_active"])),
        );
    }
    if let Some(value) = params.get("sftp_compat_mode") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "sftp_compat_mode must be a boolean".to_string())?;
        map.insert("sftp_compat_mode".to_string(), Value::Bool(enabled));
    }
    if let Some(value) = params.get("sftp_name_encoding") {
        let encoding = crate::sftp_name::NameEncoding::parse(
            value
                .as_str()
                .ok_or_else(|| "sftp_name_encoding must be auto or latin-1".to_string())?,
        )
        .ok_or_else(|| "sftp_name_encoding must be auto or latin-1".to_string())?;
        map.insert(
            "sftp_name_encoding".to_string(),
            Value::String(encoding.as_str().to_string()),
        );
    }
    // 连接级文件名编码覆盖（M16）：整表替换（对象按 connectionId 分桶，
    // 前端读改写合并自己的桶）；整体非对象报错，桶内非法值清洗丢弃。
    if let Some(value) = params.get("sftp_name_encoding_overrides") {
        let store = sanitize_sftp_encoding_overrides(value).ok_or_else(|| {
            "sftp_name_encoding_overrides must be an object keyed by connectionId".to_string()
        })?;
        map.insert("sftp_name_encoding_overrides".to_string(), store);
    }
    if let Some(value) = params.get("history_suggestions_enabled") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "history_suggestions_enabled must be a boolean".to_string())?;
        map.insert(
            "history_suggestions_enabled".to_string(),
            Value::Bool(enabled),
        );
    }
    if params.get("history_suggestion_min_chars").is_some() {
        map.insert(
            "history_suggestion_min_chars".to_string(),
            Value::from(sanitize_u64_clamped(
                &params["history_suggestion_min_chars"],
                1,
                16,
                2,
            )),
        );
    }
    if params.get("history_suggestion_max_chars").is_some() {
        map.insert(
            "history_suggestion_max_chars".to_string(),
            Value::from(sanitize_u64_clamped(
                &params["history_suggestion_max_chars"],
                8,
                512,
                64,
            )),
        );
    }
    if let Some(value) = params.get("action_links_enabled") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "action_links_enabled must be a boolean".to_string())?;
        map.insert("action_links_enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(value) = params.get("action_links_matchers") {
        let matchers = sanitize_action_links_matchers(value)
            .ok_or_else(|| "action_links_matchers must be an object".to_string())?;
        map.insert("action_links_matchers".to_string(), matchers);
    }
    if let Some(value) = params.get("terminal_show_line_numbers") {
        let line_numbers = value
            .as_bool()
            .ok_or_else(|| "terminal_show_line_numbers must be a boolean".to_string())?;
        map.insert(
            "terminal_show_line_numbers".to_string(),
            Value::Bool(line_numbers),
        );
    }
    if let Some(value) = params.get("terminal_show_timestamps") {
        let timestamps = value
            .as_bool()
            .ok_or_else(|| "terminal_show_timestamps must be a boolean".to_string())?;
        map.insert(
            "terminal_show_timestamps".to_string(),
            Value::Bool(timestamps),
        );
    }
    if let Some(value) = params.get("terminal_timestamp_format") {
        let format = sanitize_timestamp_format(value)
            .ok_or_else(|| "terminal_timestamp_format must be a string".to_string())?;
        map.insert(
            "terminal_timestamp_format".to_string(),
            Value::String(format),
        );
    }
    if let Some(value) = params.get("ctx_search_engines") {
        let engines = sanitize_ctx_search_engines(value)
            .ok_or_else(|| "ctx_search_engines must be a string".to_string())?;
        map.insert("ctx_search_engines".to_string(), Value::String(engines));
    }
    if let Some(value) = params.get("wallpaper_enabled") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "wallpaper_enabled must be a boolean".to_string())?;
        map.insert("wallpaper_enabled".to_string(), Value::Bool(enabled));
    }
    if params.get("wallpaper_opacity").is_some() {
        map.insert(
            "wallpaper_opacity".to_string(),
            Value::from(sanitize_u64_clamped(
                &params["wallpaper_opacity"],
                10,
                90,
                45,
            )),
        );
    }
    // 连接级启动命令（P0-4）：整表替换（对象按 connectionId 分桶，前端
    // 读改写合并自己的桶），形状清洗在 startup_commands 模块（单测覆盖）。
    if let Some(value) = params.get("startup_commands") {
        let store = crate::startup_commands::sanitize_store(value).ok_or_else(|| {
            "startup_commands must be an object keyed by connectionId".to_string()
        })?;
        map.insert("startup_commands".to_string(), store);
    }
    // RDP 安全设置（RDP-2）：布尔直存；证书策略走白名单（白名单外报错，
    // 不落盘污染），缺省语义由 rdp_session::resolve_security 兜底
    // （use_nla=true、certificate_policy=prompt）。
    // RDP 仍处实验阶段：仅显式 true 才显示/允许入口，普通用户默认不可用。
    if let Some(value) = params.get("rdp_experimental_enabled") {
        let enabled = value
            .as_bool()
            .ok_or_else(|| "rdp_experimental_enabled must be a boolean".to_string())?;
        map.insert("rdp_experimental_enabled".to_string(), Value::Bool(enabled));
    }
    if let Some(value) = params.get("rdp_use_nla") {
        let use_nla = value
            .as_bool()
            .ok_or_else(|| "rdp_use_nla must be a boolean".to_string())?;
        map.insert("rdp_use_nla".to_string(), Value::Bool(use_nla));
    }
    if let Some(value) = params.get("rdp_certificate_policy") {
        let policy = sanitize_rdp_certificate_policy(value).ok_or_else(|| {
            "rdp_certificate_policy must be prompt, strict or accept-temporarily".to_string()
        })?;
        map.insert(
            "rdp_certificate_policy".to_string(),
            Value::String(policy.to_string()),
        );
    }

    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(&json!({
        "version": STORAGE_VERSION,
        "prefs": Value::Object(map),
    }))
    .map_err(|error| format!("Failed to encode preferences: {error}"))?;
    write_preferences_atomically(&path, &text)?;
    Ok(load_preferences(data_dir))
}

/// Writes preferences through a sibling temporary file then renames it into
/// place. On Unix the temporary file is created as 0600 before its first byte
/// is written, so startup-command text never exists with inherited umask
/// permissions.
fn write_preferences_atomically(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write as _;

    let tmp = path.with_extension("json.tmp");
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
    };
    #[cfg(not(unix))]
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp);
    let mut file = file.map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    file.write_all(text.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync {}: {error}", tmp.display()))?;
    drop(file);
    std::fs::rename(&tmp, path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wallpaper_roundtrip_validates_magic_and_size() {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;

        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空存储：get 返回空对象。
        assert_eq!(load_wallpaper(data_dir.path()), json!({}));
        // png 魔数（1x1 透明 png 文件头即可，不做像素解码）。
        let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
        let saved = save_wallpaper(data_dir.path(), &json!({ "imageBase64": B64.encode(&png) }))
            .expect("save png");
        let data_url = saved["dataUrl"].as_str().unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));
        assert_eq!(load_wallpaper(data_dir.path()), saved);
        // jpeg / webp 魔数同样接受。
        save_wallpaper(
            data_dir.path(),
            &json!({ "imageBase64": B64.encode([0xFF, 0xD8, 0xFF, 0xE0]) }),
        )
        .expect("save jpeg");
        assert!(load_wallpaper(data_dir.path())["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        let webp: Vec<u8> = [b"RIFF".as_slice(), &[1, 2, 3, 4], b"WEBP"].concat();
        save_wallpaper(data_dir.path(), &json!({ "imageBase64": B64.encode(webp) }))
            .expect("save webp");
        assert!(load_wallpaper(data_dir.path())["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/webp;base64,"));
        // 非法魔数拒绝且不落盘污染（仍是上一张 webp）。
        let error = save_wallpaper(
            data_dir.path(),
            &json!({ "imageBase64": B64.encode(b"GIF89a....") }),
        )
        .expect_err("must reject non-image");
        assert!(error.contains("png, jpeg or webp"));
        // 非法 base64 拒绝；缺参/非字符串拒绝。
        assert!(save_wallpaper(data_dir.path(), &json!({ "imageBase64": "!!!" })).is_err());
        assert!(save_wallpaper(data_dir.path(), &json!({})).is_err());
        // 大小上限：>8MiB 的二进制拒绝（粗判在 base64 长度上先触发）。
        let oversized = vec![0u8; WALLPAPER_MAX_BYTES + 1];
        let error = save_wallpaper(
            data_dir.path(),
            &json!({ "imageBase64": B64.encode(&oversized) }),
        )
        .expect_err("must reject oversize");
        assert!(error.contains("limit"));
        // clear 幂等：清除后 get 回空对象，再次 clear 仍成功。
        assert_eq!(clear_wallpaper(data_dir.path()), json!({}));
        assert_eq!(load_wallpaper(data_dir.path()), json!({}));
        assert_eq!(clear_wallpaper(data_dir.path()), json!({}));
    }

    #[test]
    fn wallpaper_prefs_roundtrip_with_clamp() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：两键都不出现（前端按缺省处理）。
        let prefs = load_preferences(data_dir.path());
        assert!(prefs.get("wallpaper_enabled").is_none());
        assert!(prefs.get("wallpaper_opacity").is_none());
        save_preferences(
            data_dir.path(),
            &json!({ "wallpaper_enabled": true, "wallpaper_opacity": 999 }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["wallpaper_enabled"], true);
        assert_eq!(prefs["wallpaper_opacity"], 90);
        assert!(save_preferences(data_dir.path(), &json!({ "wallpaper_enabled": "yes" })).is_err());
    }

    #[test]
    fn local_terminal_prefs_roundtrip_with_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：两键都不出现（前端按缺省处理）。
        let prefs = load_preferences(dir.path());
        assert!(prefs.get("localShell").is_none());
        assert!(prefs.get("localShellIntegration").is_none());
        // 写入 + 读回；空串 shell 归一为空串（=自动探测）。
        save_preferences(
            dir.path(),
            &serde_json::json!({ "localShell": "  /opt/homebrew/bin/fish  ", "localShellIntegration": false }),
        )
        .expect("save");
        let prefs = load_preferences(dir.path());
        assert_eq!(prefs["localShell"], "/opt/homebrew/bin/fish");
        assert_eq!(prefs["localShellIntegration"], false);
        // 非法类型报错且不落盘污染。
        let error = save_preferences(dir.path(), &serde_json::json!({ "localShell": 42 }))
            .expect_err("must reject");
        assert!(error.contains("localShell"));
    }

    #[test]
    fn roundtrip_merges_and_normalizes() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let stored = save_preferences(
            data_dir.path(),
            &json!({ "downloadDir": "  /tmp/dl  ", "downloadUseDefaultDir": true, "evil": "dropped" }),
        )
        .expect("save");
        assert_eq!(stored["downloadDir"].as_str().unwrap(), "/tmp/dl");
        assert_eq!(stored["downloadUseDefaultDir"].as_bool(), Some(true));
        assert!(stored.get("evil").is_none());
        // 部分更新只改出现的键。
        let again = save_preferences(data_dir.path(), &json!({ "downloadUseDefaultDir": false }))
            .expect("save again");
        assert_eq!(again["downloadDir"].as_str().unwrap(), "/tmp/dl");
        assert_eq!(again["downloadUseDefaultDir"].as_bool(), Some(false));
    }

    #[test]
    fn missing_or_corrupted_file_yields_empty() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(load_preferences(data_dir.path()), json!({}));
        std::fs::write(store_path(data_dir.path()), "{not json").expect("write junk");
        assert_eq!(load_preferences(data_dir.path()), json!({}));
    }

    #[test]
    fn rejects_wrong_types() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        assert!(save_preferences(data_dir.path(), &json!({ "downloadDir": 7 })).is_err());
        assert!(
            save_preferences(data_dir.path(), &json!({ "downloadUseDefaultDir": "yes" })).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn preference_temp_file_is_created_with_0600_before_rename() {
        use std::os::unix::fs::PermissionsExt;

        let data_dir = tempfile::tempdir().expect("tempdir");
        let path = store_path(data_dir.path());
        write_preferences_atomically(&path, "{\"prefs\":{}}").expect("atomic preference write");
        assert_eq!(
            std::fs::metadata(path)
                .expect("preference metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600,
        );
    }

    #[test]
    fn startup_commands_pref_roundtrip_with_shape_cleaning() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：键不出现（前端按无配置处理）。
        assert!(load_preferences(data_dir.path())
            .get("startup_commands")
            .is_none());
        // 非对象整体报错且不落盘污染。
        let error = save_preferences(data_dir.path(), &json!({ "startup_commands": [] }))
            .expect_err("must reject non-object store");
        assert!(error.contains("startup_commands"));
        // 写入（部分行非法/禁用/超限）+ 读回：清洗语义在 startup_commands 模块
        // 单测覆盖，这里验证偏好链路（键名、嵌套布局、部分合并）。
        save_preferences(
            data_dir.path(),
            &json!({ "startup_commands": {
                "conn-1": { "enabled": true, "commands": [
                    { "command": "echo one" },
                    { "command": "echo two", "delayMs": 5, "enabled": false },
                ] },
            } }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        let store = prefs.get("startup_commands").expect("store kept");
        assert_eq!(store["conn-1"]["enabled"], true);
        assert_eq!(store["conn-1"]["commands"].as_array().unwrap().len(), 2);
        // 部分更新：只带别的键时 startup_commands 原样保留。
        save_preferences(data_dir.path(), &json!({ "downloadDir": "/tmp/x" })).expect("partial");
        let prefs = load_preferences(data_dir.path());
        assert!(prefs.get("startup_commands").is_some());
        assert_eq!(prefs["downloadDir"], "/tmp/x");
    }

    #[test]
    fn rdp_experimental_gate_defaults_closed_and_only_accepts_true() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        assert!(!rdp_experimental_enabled(data_dir.path()));
        save_preferences(
            data_dir.path(),
            &json!({ "rdp_experimental_enabled": true }),
        )
        .expect("enable experimental RDP");
        assert!(rdp_experimental_enabled(data_dir.path()));
        save_preferences(
            data_dir.path(),
            &json!({ "rdp_experimental_enabled": false }),
        )
        .expect("disable experimental RDP");
        assert!(!rdp_experimental_enabled(data_dir.path()));
    }

    #[test]
    fn rdp_security_prefs_whitelist_and_roundtrip() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：两键都不出现（前端按缺省 use_nla=true/prompt 处理）。
        let prefs = load_preferences(data_dir.path());
        assert!(prefs.get("rdp_experimental_enabled").is_none());
        assert!(prefs.get("rdp_use_nla").is_none());
        assert!(prefs.get("rdp_certificate_policy").is_none());
        // 写入 + 读回。
        save_preferences(
            data_dir.path(),
            &json!({ "rdp_experimental_enabled": true, "rdp_use_nla": false, "rdp_certificate_policy": "strict" }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["rdp_experimental_enabled"], true);
        assert_eq!(prefs["rdp_use_nla"], false);
        assert_eq!(prefs["rdp_certificate_policy"], "strict");
        // 白名单外证书策略报错且不落盘污染（fail-closed：无「静默接受」项）。
        let error = save_preferences(
            data_dir.path(),
            &json!({ "rdp_certificate_policy": "accept-always" }),
        )
        .expect_err("must reject unknown policy");
        assert!(
            error.contains("prompt, strict or accept-temporarily"),
            "{error}"
        );
        // 非 bool 拒绝。
        assert!(save_preferences(
            data_dir.path(),
            &json!({ "rdp_experimental_enabled": "yes" })
        )
        .is_err());
        assert!(save_preferences(data_dir.path(), &json!({ "rdp_use_nla": "yes" })).is_err());
        // 部分更新只改出现的键。
        save_preferences(data_dir.path(), &json!({ "rdp_use_nla": true })).expect("partial");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["rdp_use_nla"], true);
        assert_eq!(prefs["rdp_certificate_policy"], "strict");
    }

    #[test]
    fn sftp_pipeline_prefs_clamp_and_roundtrip() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：三键都不出现（前端按缺省处理），读取器回默认值。
        assert!(load_preferences(data_dir.path())
            .get("transfer_max_active")
            .is_none());
        assert!(load_preferences(data_dir.path())
            .get("sftp_compat_mode")
            .is_none());
        assert!(load_preferences(data_dir.path())
            .get("sftp_name_encoding")
            .is_none());
        assert_eq!(
            transfer_max_active(data_dir.path()),
            TRANSFER_MAX_ACTIVE_DEFAULT
        );
        assert!(!sftp_compat_mode(data_dir.path()));
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), None),
            crate::sftp_name::NameEncoding::Auto
        );
        // 写入 + 读回：深度超界钳制、非法编码拒绝（不落盘污染）。
        save_preferences(
            data_dir.path(),
            &json!({
                "transfer_max_active": 99,
                "sftp_compat_mode": true,
                "sftp_name_encoding": "latin-1",
            }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["transfer_max_active"], 8);
        assert_eq!(prefs["sftp_compat_mode"], true);
        assert_eq!(prefs["sftp_name_encoding"], "latin-1");
        assert_eq!(
            transfer_max_active(data_dir.path()),
            TRANSFER_MAX_ACTIVE_MAX
        );
        assert!(sftp_compat_mode(data_dir.path()));
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), None),
            crate::sftp_name::NameEncoding::Latin1
        );
        // 非法形状报错。
        assert!(save_preferences(data_dir.path(), &json!({ "sftp_compat_mode": "yes" })).is_err());
        assert!(
            save_preferences(data_dir.path(), &json!({ "sftp_name_encoding": "gbk" })).is_err()
        );
        assert!(save_preferences(data_dir.path(), &json!({ "sftp_name_encoding": 7 })).is_err());
        // 部分更新只改出现的键。
        save_preferences(
            data_dir.path(),
            &json!({ "sftp_compat_mode": false, "sftp_name_encoding": "auto" }),
        )
        .expect("partial");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["transfer_max_active"], 8);
        assert_eq!(prefs["sftp_compat_mode"], false);
        assert_eq!(prefs["sftp_name_encoding"], "auto");
    }

    #[test]
    fn sftp_encoding_override_resolves_priority_three_states() {
        // 三态：连接覆盖 > 全局 > 缺省 auto（resolve 纯函数直测）。
        assert_eq!(
            resolve_sftp_name_encoding(Some("latin-1"), Some("auto")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            resolve_sftp_name_encoding(None, Some("latin-1")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            resolve_sftp_name_encoding(None, None),
            crate::sftp_name::NameEncoding::Auto
        );
        // 白名单回退：覆盖值非法（gbk）时回退全局；全局也非法回缺省。
        assert_eq!(
            resolve_sftp_name_encoding(Some("gbk"), Some("latin-1")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            resolve_sftp_name_encoding(Some("gbk"), None),
            crate::sftp_name::NameEncoding::Auto
        );
        // 大小写/空白容错与全局读取器一致（parse 语义共用）。
        assert_eq!(
            resolve_sftp_name_encoding(Some(" LATIN-1 "), None),
            crate::sftp_name::NameEncoding::Latin1
        );
    }

    #[test]
    fn sftp_encoding_override_pref_roundtrip_and_priority() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：覆盖键不出现；无连接上下文与带连接上下文都回全局缺省 auto。
        assert!(load_preferences(data_dir.path())
            .get("sftp_name_encoding_overrides")
            .is_none());
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), None),
            crate::sftp_name::NameEncoding::Auto
        );
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-1")),
            crate::sftp_name::NameEncoding::Auto
        );
        // 全局 latin-1：未覆盖连接跟随全局。
        save_preferences(data_dir.path(), &json!({ "sftp_name_encoding": "latin-1" }))
            .expect("save global");
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-1")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), None),
            crate::sftp_name::NameEncoding::Latin1
        );
        // 连接覆盖优先于全局；未覆盖连接仍跟随全局。
        save_preferences(
            data_dir.path(),
            &json!({ "sftp_name_encoding_overrides": {
                "conn-1": "auto",
                "conn-2": "latin-1",
                "conn-3": "gbk",
                "conn-4": 7,
                "": "auto",
            } }),
        )
        .expect("save overrides");
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-1")),
            crate::sftp_name::NameEncoding::Auto
        );
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-2")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-9")),
            crate::sftp_name::NameEncoding::Latin1
        );
        // 非法桶（gbk / 非字符串 / 空 connectionId）清洗丢弃，不报错。
        let prefs = load_preferences(data_dir.path());
        let store = prefs
            .get("sftp_name_encoding_overrides")
            .and_then(Value::as_object)
            .expect("store kept");
        assert_eq!(store.len(), 2);
        assert!(store.contains_key("conn-1") && store.contains_key("conn-2"));
        // 整体非对象报错且不落盘污染。
        let error = save_preferences(
            data_dir.path(),
            &json!({ "sftp_name_encoding_overrides": [] }),
        )
        .expect_err("must reject non-object store");
        assert!(error.contains("sftp_name_encoding_overrides"));
        // 部分更新：只带别的键时覆盖表原样保留。
        save_preferences(data_dir.path(), &json!({ "sftp_compat_mode": true })).expect("partial");
        assert!(load_preferences(data_dir.path())
            .get("sftp_name_encoding_overrides")
            .is_some());
        // 「跟随全局」= 删除本连接桶：整表替换后回退全局。
        save_preferences(
            data_dir.path(),
            &json!({ "sftp_name_encoding_overrides": { "conn-2": "latin-1" } }),
        )
        .expect("remove conn-1 bucket");
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-1")),
            crate::sftp_name::NameEncoding::Latin1
        );
        assert_eq!(
            sftp_name_encoding_for(data_dir.path(), Some("conn-2")),
            crate::sftp_name::NameEncoding::Latin1
        );
    }

    #[test]
    fn transfer_and_suggestion_prefs_clamp_and_roundtrip() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        save_preferences(
            data_dir.path(),
            &json!({
                "transfer_concurrency": 99,
                "transfer_duplicate_policy": "ask",
                "history_suggestions_enabled": false,
                "history_suggestion_min_chars": 0,
                "history_suggestion_max_chars": 999,
            }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["transfer_concurrency"], 10);
        assert_eq!(prefs["transfer_duplicate_policy"], "ask");
        assert_eq!(prefs["history_suggestions_enabled"], false);
        assert_eq!(prefs["history_suggestion_min_chars"], 1);
        assert_eq!(prefs["history_suggestion_max_chars"], 512);
        // 非法策略名报错；缺省键不出现（前端按默认处理）。
        let error = save_preferences(
            data_dir.path(),
            &json!({ "transfer_duplicate_policy": "clobber" }),
        )
        .expect_err("must reject");
        assert!(error.contains("transfer_duplicate_policy"));
        let fresh = tempfile::tempdir().expect("tempdir");
        assert_eq!(load_preferences(fresh.path()), json!({}));
    }

    #[test]
    fn terminal_feature_prefs_roundtrip_with_defaults() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        // 空偏好：五键都不出现（前端按缺省 = 功能全关处理）。
        let prefs = load_preferences(data_dir.path());
        assert!(prefs.get("action_links_enabled").is_none());
        assert!(prefs.get("action_links_matchers").is_none());
        assert!(prefs.get("terminal_show_line_numbers").is_none());
        assert!(prefs.get("terminal_show_timestamps").is_none());
        assert!(prefs.get("terminal_timestamp_format").is_none());
        // 写入 + 读回：matchers 部分字段缺省为 true；格式串原样保留。
        save_preferences(
            data_dir.path(),
            &serde_json::json!({
                "action_links_enabled": true,
                "action_links_matchers": { "ipv4": false },
                "terminal_show_line_numbers": true,
                "terminal_show_timestamps": true,
                "terminal_timestamp_format": "[HH:mm]",
            }),
        )
        .expect("save");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["action_links_enabled"], true);
        assert_eq!(prefs["action_links_matchers"]["ipv4"], false);
        assert_eq!(prefs["action_links_matchers"]["host_port"], true);
        assert_eq!(prefs["action_links_matchers"]["archive"], true);
        assert_eq!(prefs["terminal_show_line_numbers"], true);
        assert_eq!(prefs["terminal_show_timestamps"], true);
        assert_eq!(prefs["terminal_timestamp_format"], "[HH:mm]");
        // 非法形状报错且不落盘污染；matchers 非对象拒绝。
        assert!(save_preferences(
            data_dir.path(),
            &serde_json::json!({ "action_links_enabled": 1 })
        )
        .is_err());
        assert!(save_preferences(
            data_dir.path(),
            &serde_json::json!({ "action_links_matchers": "all" })
        )
        .is_err());
        assert!(save_preferences(
            data_dir.path(),
            &serde_json::json!({ "terminal_show_timestamps": "yes" })
        )
        .is_err());
        // 在线搜索引擎表：trim + 超长截断；非字符串拒绝。
        assert!(save_preferences(
            data_dir.path(),
            &serde_json::json!({ "ctx_search_engines": 7 })
        )
        .is_err());
        save_preferences(
            data_dir.path(),
            &serde_json::json!({ "ctx_search_engines": "  Google|https://www.google.com/search?q=%s  " }),
        )
        .expect("save engines");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(
            prefs["ctx_search_engines"],
            "Google|https://www.google.com/search?q=%s"
        );
        let long = "x".repeat(MAX_CTX_SEARCH_ENGINES_LEN + 10);
        save_preferences(
            data_dir.path(),
            &serde_json::json!({ "ctx_search_engines": long }),
        )
        .expect("save long engines");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(
            prefs["ctx_search_engines"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_CTX_SEARCH_ENGINES_LEN
        );
        // 格式串清洗：危险字符剔除、超长截断、清洗后为空回退默认。
        save_preferences(
            data_dir.path(),
            &serde_json::json!({ "terminal_timestamp_format": "  <>  " }),
        )
        .expect("save fallback");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(prefs["terminal_timestamp_format"], "[HH:mm:ss]");
        let long = "Y".repeat(100);
        save_preferences(
            data_dir.path(),
            &serde_json::json!({ "terminal_timestamp_format": long }),
        )
        .expect("save long");
        let prefs = load_preferences(data_dir.path());
        assert_eq!(
            prefs["terminal_timestamp_format"].as_str().unwrap().len(),
            64
        );
    }
}
