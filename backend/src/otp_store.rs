//! OTP 库条目存储（P2-1）：`<plugin_data_dir>/otp-entries.json`（0600，损坏
//! 视为空——同 quick-commands.json / quick-sudo-profiles.json 的防腐政策）。
//!
//! 条目密钥经 vault 字段级 AEAD 加密落盘（复用 Quick Sudo 的
//! `totpSecret` 字段绑定，AAD = `totpSecret|<entryId>`，只调用 vault 不改它）。
//! `bindings` 段维护 `connection_id -> entry_id` 的连接绑定，供自动应答回落
//! 与工作台展示使用。列表视图永远脱敏（只回 `hasSecret`），明文密钥只经
//! [`get_decrypted_secret`] 短暂存在。
//!
//! 另含两件与"OTP 取码"同生命周期的小设施：
//! - 共享防重放缓存：`otp/generate` 与连接绑定条目的自动应答回落共用
//!   （同 time_step 已发出的 TOTP 码不重复返回，等下一周期）；HOTP 不缓存。
//! - `otp/import-qr` 的 QR 图片解码（`rqrr` + `image`，本任务唯一新增依赖；
//!   放在存储层而非算法库 `otp.rs`，后者保持零新增依赖）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::otp::{self, OtpAlgorithm, OtpUriParams};
use crate::vault::{self, Vault, FIELD_TOTP_SECRET};

const STORAGE_VERSION: u64 = 1;
const FILE_NAME: &str = "otp-entries.json";
const CRYPTO_SCHEME: &str = "aead-v1";
/// 条目数量上限（防滥用，与 quick-commands 的 20 条同一思路，放宽到库形态）。
pub const MAX_ENTRIES: usize = 100;
const MAX_ISSUER_LEN: usize = 120;
const MAX_USERNAME_LEN: usize = 120;
/// base32 解码后的密钥字节上限（对齐 triggers.rs 的 TOTP 密钥 abuse cap）。
const MAX_SECRET_BYTES: usize = 64;
/// import-qr 图片字节上限：二维码本身极小，8 MiB 足够任何手机截图。
const MAX_QR_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// QR 解码像素边长/内存上限：压缩输入虽有 8 MiB 帽，但解压炸弹（如
/// 60000×60000 的 PNG）仍会撑爆内存——8192² / 64 MiB 远超任何二维码截图。
const MAX_QR_PIXEL_EDGE: u32 = 8192;
const MAX_QR_ALLOC_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct OtpEntry {
    pub id: String,
    /// "totp" | "hotp"
    pub otp_type: String,
    pub issuer: String,
    pub username: String,
    /// vault 密文（`base64(nonce‖ct)`）；明文永不落盘。
    pub secret_encrypted: String,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period: u64,
    /// 仅 hotp：当前计数器（生成一次 +1 并持久化）。
    pub counter: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OtpStore {
    pub entries: Vec<OtpEntry>,
    /// `connection_id -> entry_id`。
    pub bindings: HashMap<String, String>,
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// 进程内插件数据目录（`SshRuntime::new` 注入）。自动应答的取码链
/// （`ssh.rs::sudo_auth_for`）是自由函数，拿不到 `self.data_dir`，从这里读。
static DATA_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

/// 注入插件数据目录（启动时一次；测试可重复注入不同 tempdir）。
pub fn init_data_dir(path: &Path) {
    let slot = DATA_DIR.get_or_init(|| RwLock::new(None));
    if let Ok(mut guard) = slot.write() {
        *guard = Some(path.to_path_buf());
    }
}

/// 已注入的插件数据目录；未注入（极端：取码先于构造）返回 None。
pub fn data_dir() -> Option<PathBuf> {
    DATA_DIR
        .get()
        .and_then(|slot| slot.read().ok().and_then(|guard| guard.clone()))
}

/// vault 构造：沿用 Quick Sudo 的 envelope `crypto.storage` 层级
/// （缺省 keyfile 0600；keychain 需显式 opt-in），同一把 DEK 覆盖所有库。
pub fn vault_for(data_dir: &Path) -> Vault {
    let storage = std::fs::read_to_string(store_path(data_dir))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("crypto")
                .and_then(|crypto| crypto.get("storage"))
                .and_then(Value::as_str)
                .and_then(vault::KeyStorage::parse)
        });
    let provider = vault::resolve_provider(storage, data_dir);
    Vault::new(provider.as_ref())
}

/// 加载存储；文件缺失或损坏一律空库（坏文件不能拖垮工作台）。
pub fn load_store(data_dir: &Path) -> OtpStore {
    let text = std::fs::read_to_string(store_path(data_dir)).unwrap_or_default();
    let Some(value) = serde_json::from_str::<Value>(&text).ok() else {
        return OtpStore::default();
    };
    let entries = value
        .get("entries")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(entry_from_json).collect())
        .unwrap_or_default();
    let bindings = value
        .get("bindings")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(connection_id, entry_id)| {
                    entry_id
                        .as_str()
                        .map(|entry_id| (connection_id.clone(), entry_id.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    OtpStore { entries, bindings }
}

/// 原子落盘（tmp + rename），Unix 上 tmp 从创建起即 0600。
pub fn save_store(data_dir: &Path, store: &OtpStore) -> Result<(), String> {
    let path = store_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = json!({
        "version": STORAGE_VERSION,
        "crypto": { "scheme": CRYPTO_SCHEME },
        "entries": store.entries.iter().map(entry_json).collect::<Vec<_>>(),
        "bindings": store.bindings,
    });
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode otp entries: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    // 先建后写：`fs::write` 会先以平台默认权限（0644）落明文密文文件、
    // 再 chmod 0600，存在明文窗口；OpenOptions.mode 让首个字节前就是 0600。
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, text)
            .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &path)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn entry_from_json(value: &Value) -> Option<OtpEntry> {
    let object = value.as_object()?;
    let string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let otp_type = match string("otpType").as_str() {
        "hotp" => "hotp".to_string(),
        _ => "totp".to_string(),
    };
    let is_hotp = otp_type == "hotp";
    let counter = object.get("counter").and_then(Value::as_u64);
    Some(OtpEntry {
        id: string("id"),
        otp_type,
        issuer: string("issuer"),
        username: string("username"),
        secret_encrypted: string("secretEnc"),
        algorithm: OtpAlgorithm::parse(&string("algorithm")),
        digits: object
            .get("digits")
            .and_then(Value::as_u64)
            .and_then(|digits| u8::try_from(digits).ok())
            .filter(|digits| (6..=8).contains(digits))
            .unwrap_or(6),
        period: object
            .get("period")
            .and_then(Value::as_u64)
            .filter(|period| (1..=3600).contains(period))
            .unwrap_or(30),
        counter: if is_hotp { counter } else { None },
    })
}

fn entry_json(entry: &OtpEntry) -> Value {
    json!({
        "id": entry.id,
        "otpType": entry.otp_type,
        "issuer": entry.issuer,
        "username": entry.username,
        "secretEnc": entry.secret_encrypted,
        "algorithm": entry.algorithm.as_str(),
        "digits": entry.digits,
        "period": entry.period,
        "counter": entry.counter,
    })
}

/// 脱敏视图：secret 永不出库，只回 `hasSecret`。
pub fn entry_view(entry: &OtpEntry) -> Value {
    json!({
        "id": entry.id,
        "otpType": entry.otp_type,
        "issuer": entry.issuer,
        "username": entry.username,
        "hasSecret": !entry.secret_encrypted.is_empty(),
        "algorithm": entry.algorithm.as_str(),
        "digits": entry.digits,
        "period": entry.period,
        "counter": entry.counter,
    })
}

pub fn list_views(store: &OtpStore) -> Vec<Value> {
    store.entries.iter().map(entry_view).collect()
}

pub fn binding_views(store: &OtpStore) -> Value {
    Value::Object(
        store
            .bindings
            .iter()
            .map(|(connection_id, entry_id)| {
                (connection_id.clone(), Value::from(entry_id.as_str()))
            })
            .collect(),
    )
}

fn text_input(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
}

/// 数值参数读取：JSON number 与数字字符串都接受（前端两种形态都会发）。
fn number_input(params: &Value, key: &str) -> Result<Option<u64>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{key} must be a non-negative integer")),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Value::String(text)) => text
            .trim()
            .parse::<u64>()
            .map(Some)
            .map_err(|_| format!("{key} must be an integer, got '{text}'")),
        Some(_) => Err(format!("{key} must be an integer")),
    }
}

/// 创建或更新一个条目。`secret` 非空 → 校验 base32 后重新加密；为空 → 保留
/// 旧密文（编辑 issuer/用户名不动密钥的常见路径）。新建必须带非空 secret。
/// hotp 必须带 `counter`；totp 忽略该参数。返回 (条目, 是否新建)。
pub fn save_entry(
    store: &mut OtpStore,
    params: &Value,
    vault: &Vault,
) -> Result<(OtpEntry, bool), String> {
    let otp_type_input = text_input(params, "otpType").unwrap_or_default();
    let otp_type: &str = match otp_type_input.as_str() {
        "" | "totp" => "totp",
        "hotp" => "hotp",
        other => return Err(format!("otpType must be totp or hotp, got '{other}'")),
    };
    let issuer = text_input(params, "issuer").unwrap_or_default();
    let username = text_input(params, "username").unwrap_or_default();
    if issuer.chars().count() > MAX_ISSUER_LEN {
        return Err(format!("issuer is limited to {MAX_ISSUER_LEN} characters"));
    }
    if username.chars().count() > MAX_USERNAME_LEN {
        return Err(format!(
            "username is limited to {MAX_USERNAME_LEN} characters"
        ));
    }
    let algorithm = text_input(params, "algorithm")
        .map(|value| OtpAlgorithm::parse(&value))
        .unwrap_or(OtpAlgorithm::Sha1);
    let digits = match number_input(params, "digits")? {
        None => None,
        Some(value) => Some(
            u8::try_from(value)
                .ok()
                .filter(|digits| (6..=8).contains(digits))
                .ok_or_else(|| format!("digits must be 6-8, got '{value}'"))?,
        ),
    };
    let period = match number_input(params, "period")? {
        None => None,
        Some(value) => {
            if !(1..=3600).contains(&value) {
                return Err(format!("period must be 1-3600, got '{value}'"));
            }
            Some(value)
        }
    };
    let counter_input = number_input(params, "counter")?;
    let secret_input = text_input(params, "secret").unwrap_or_default();

    let existing_id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let existing = existing_id.and_then(|id| store.entries.iter().position(|entry| entry.id == id));
    // 新建 hotp 必须带起始 counter；更新时缺省沿用旧值（见下方 or 兜底）。
    if otp_type == "hotp" && counter_input.is_none() && existing.is_none() {
        return Err("hotp entries require a counter".to_string());
    }

    // 条目 id 先定下来：vault 的 AAD 绑定 `totpSecret|<entryId>`，新建的
    // 密文必须按最终 id 封装。
    let id = match existing {
        Some(index) => store.entries[index].id.clone(),
        None => uuid::Uuid::new_v4().to_string(),
    };
    let secret_encrypted = if secret_input.is_empty() {
        match existing {
            // 编辑 issuer/用户名等不动密钥：保留旧密文。
            Some(index) => store.entries[index].secret_encrypted.clone(),
            None => return Err("Missing secret".to_string()),
        }
    } else {
        let key = otp::decode_base32(&secret_input)?;
        if key.len() > MAX_SECRET_BYTES {
            return Err(format!(
                "secret exceeds {MAX_SECRET_BYTES} bytes after base32 decoding"
            ));
        }
        vault.seal(FIELD_TOTP_SECRET, &id, &normalize_secret(&secret_input))
    };

    let entry = OtpEntry {
        id,
        otp_type: otp_type.to_string(),
        issuer,
        username,
        secret_encrypted,
        algorithm,
        digits: digits.unwrap_or(6),
        period: period.unwrap_or(30),
        counter: if otp_type == "hotp" {
            counter_input.or(match existing {
                Some(index) => store.entries[index].counter,
                None => None,
            })
        } else {
            None
        },
    };
    match existing {
        Some(index) => store.entries[index] = entry.clone(),
        None => {
            if store.entries.len() >= MAX_ENTRIES {
                return Err(format!("At most {MAX_ENTRIES} OTP entries are supported"));
            }
            store.entries.push(entry.clone());
        }
    }
    let created = existing.is_none();
    Ok((entry, created))
}

/// 规范化密钥文本（大写、去空格/连字符、无填充），加密前统一形态。
fn normalize_secret(text: &str) -> String {
    data_encoding::BASE32_NOPAD.encode(otp::decode_base32(text).unwrap_or_default().as_slice())
}

/// 删除条目；指向它的绑定一并清除。未知 id 返回 false。
pub fn delete_entry(store: &mut OtpStore, id: &str) -> bool {
    let before = store.entries.len();
    store.entries.retain(|entry| entry.id != id);
    let removed = store.entries.len() != before;
    store.bindings.retain(|_, entry_id| entry_id != id);
    removed
}

/// 绑定连接 → 条目；条目必须存在（同一连接重复绑定即改绑）。
pub fn bind(store: &mut OtpStore, connection_id: &str, entry_id: &str) -> Result<(), String> {
    if connection_id.is_empty() {
        return Err("Missing connectionId".to_string());
    }
    if !store.entries.iter().any(|entry| entry.id == entry_id) {
        return Err(format!("OTP entry '{entry_id}' not found"));
    }
    store
        .bindings
        .insert(connection_id.to_string(), entry_id.to_string());
    Ok(())
}

/// 解绑；本来就没绑返回 false。
pub fn unbind(store: &mut OtpStore, connection_id: &str) -> bool {
    store.bindings.remove(connection_id).is_some()
}

/// 解出条目密钥（vault.open → base32 解码）。密文为空（DEK 丢失降级、
/// 保存即空）或解码失败返回 None——自动应答回落静默跳过，绝不打断连接。
pub fn get_decrypted_secret(vault: &Vault, entry: &OtpEntry) -> Option<Vec<u8>> {
    let plaintext = vault.open(FIELD_TOTP_SECRET, &entry.id, &entry.secret_encrypted);
    if plaintext.is_empty() {
        return None;
    }
    otp::decode_base32(&plaintext)
        .ok()
        .filter(|key| !key.is_empty())
}

/// 绑定解析结果：生成当前窗口码所需的全部材料。
#[derive(Debug, Clone, PartialEq)]
pub struct BoundTotp {
    pub entry_id: String,
    pub key: Vec<u8>,
    pub algorithm: OtpAlgorithm,
    pub digits: u8,
    pub period: u64,
}

/// 按连接取绑定的 TOTP 条目密钥（显式 data_dir 变体，测试友好）。
/// 未绑定 / 绑定的是 hotp / 密钥不可用 → None。
pub fn bound_totp_in(data_dir: &Path, connection_id: &str) -> Option<BoundTotp> {
    let store = load_store(data_dir);
    let entry_id = store.bindings.get(connection_id)?;
    let entry = store
        .entries
        .iter()
        .find(|entry| &entry.id == entry_id)
        .filter(|entry| entry.otp_type == "totp")?;
    let vault = vault_for(data_dir);
    let key = get_decrypted_secret(&vault, entry)?;
    Some(BoundTotp {
        entry_id: entry.id.clone(),
        key,
        algorithm: entry.algorithm,
        digits: entry.digits,
        period: entry.period,
    })
}

/// 自动应答回落入口：进程级 data_dir 上的 [`bound_totp_in`]。
/// 无 data_dir 参数变体（历史签名）；自动应答现走 take_connection_totp_key。
#[allow(dead_code)]
pub fn bound_totp(connection_id: &str) -> Option<BoundTotp> {
    bound_totp_in(&data_dir()?, connection_id)
}

/// 共享防重放缓存：`entry_id -> (code, time_step, period)`。`otp/generate`
/// 与自动应答回落共用——同一窗口的码只发一次。
/// 共享防重放缓存：entry_id -> (最近发出的码, time_step, period)。
type WindowCache = HashMap<String, (String, u64, u64)>;
static WINDOW_CODES: OnceLock<Mutex<WindowCache>> = OnceLock::new();

fn window_codes() -> &'static Mutex<HashMap<String, (String, u64, u64)>> {
    WINDOW_CODES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前窗口的码已被发出（`otp/generate` 或自动应答任一路径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowUsed {
    pub remaining_secs: u64,
}

/// 一次窗口取码成功的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowCode {
    pub code: String,
    pub remaining_secs: u64,
}

/// 取 `entry` 当前窗口的 TOTP 码并记入共享防重放缓存：同 `entry_id` 同
/// time_step 已取过的码返回 [`WindowUsed`]（调用方等待 `remaining_secs` 到
/// 下一周期）。HOTP 不走这里（没有时间窗口可言）。
pub fn take_window_code(
    entry_id: &str,
    key: &[u8],
    algorithm: OtpAlgorithm,
    digits: u8,
    period: u64,
    now_secs: u64,
) -> Result<WindowCode, WindowUsed> {
    let period = period.max(1);
    let step = now_secs / period;
    let (code, remaining) = otp::totp_at(algorithm, key, period, now_secs, digits);
    let mut cache = window_codes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // 清掉已过期的窗口记录，缓存不随条目数量无界增长。
    cache.retain(|_, (_, cached_step, cached_period)| {
        *cached_step * *cached_period + *cached_period > now_secs
    });
    if let Some((cached_code, cached_step, _)) = cache.get(entry_id) {
        if *cached_step == step && *cached_code == code {
            return Err(WindowUsed {
                remaining_secs: remaining,
            });
        }
    }
    cache.insert(entry_id.to_string(), (code.clone(), step, period));
    Ok(WindowCode {
        code,
        remaining_secs: remaining,
    })
}

/// 连接绑定的 TOTP 条目 + 共享防重放缓存取码，一步到位（自动应答回落用）。
/// 返回 `Some` 时本窗口的码已预留；`None` = 未绑定 / hotp / 密钥不可用 /
/// 本窗口已发出（保持现状链，等待下一周期）。
pub fn take_connection_totp_key(data_dir: &Path, connection_id: &str) -> Option<BoundTotp> {
    let bound = bound_totp_in(data_dir, connection_id)?;
    let now = unix_now_secs();
    take_window_code(
        &bound.entry_id,
        &bound.key,
        bound.algorithm,
        bound.digits,
        bound.period,
        now,
    )
    .ok()?;
    Some(bound)
}

/// `otp/import-qr`：解码图片中的 `otpauth://` 二维码供表单预填（不入库）。
/// 解码链：base64 → `image` 解码 → luma8 → `rqrr` PreparedImage →
/// detect_grids → decode，取第一条能解出 otpauth URI 的结果。
pub fn decode_otpauth_qr(image_base64: &str) -> Result<OtpUriParams, String> {
    let payload = image_base64.trim();
    // 容忍 data URL 前缀（截图工具常带）。
    let payload = payload
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .map(|(_, encoded)| encoded)
        .unwrap_or(payload);
    let raw = BASE64_STANDARD
        .decode(payload)
        .map_err(|error| format!("imageBase64 is not valid base64: {error}"))?;
    if raw.len() > MAX_QR_IMAGE_BYTES {
        return Err(format!(
            "image exceeds {MAX_QR_IMAGE_BYTES} bytes; crop the QR code and retry"
        ));
    }
    let image = decode_with_limits(&raw)?.to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare(image);
    for grid in prepared.detect_grids() {
        let Ok((_, text)) = grid.decode() else {
            continue;
        };
        let text = text.trim();
        if text.starts_with("otpauth://") {
            return otp::parse_otpauth_uri(text);
        }
    }
    Err("no otpauth:// QR code found in the image".to_string())
}

/// `image` 解码 with 硬上限（[`MAX_QR_PIXEL_EDGE`] / [`MAX_QR_ALLOC_BYTES`]）：
/// `load_from_memory` 不设限，解压炸弹会直接吃满内存；`ImageReader::limits`
/// 在解码前按声明尺寸与分配预算拒绝（`decode` 先 reserve 再 set_limits）。
fn decode_with_limits(raw: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(raw));
    // `Limits` 是 non_exhaustive，只能在 default 之上逐字段覆盖。
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_QR_PIXEL_EDGE);
    limits.max_image_height = Some(MAX_QR_PIXEL_EDGE);
    limits.max_alloc = Some(MAX_QR_ALLOC_BYTES);
    reader.limits(limits);
    reader
        .with_guessed_format()
        .map_err(|error| format!("image format could not be guessed: {error}"))?
        .decode()
        .map_err(|error| format!("image could not be decoded: {error}"))
}

#[cfg(test)]
pub fn reset_replay_cache() {
    window_codes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::KeyfileProvider;

    const SECRET_PLAIN: &str = "GEZDGNBVGY3TQOJQ";

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-otp-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn keyfile_vault(dir: &Path) -> Vault {
        Vault::new(&KeyfileProvider::new(vault::keyfile_path(dir)))
    }

    fn save(store: &mut OtpStore, params: Value, vault: &Vault) -> OtpEntry {
        save_entry(store, &params, vault).unwrap().0
    }

    fn totp_params(extra: Value) -> Value {
        let mut params = json!({
            "otpType": "totp",
            "issuer": "ACME",
            "username": "alice",
            "secret": SECRET_PLAIN,
        });
        if let (Some(base), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        params
    }

    // —— 存储 / 0600 / 损坏视为空 ————————————————————

    #[test]
    fn store_roundtrip_preserves_entries_and_bindings() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(&mut store, totp_params(json!({})), &vault);
        bind(&mut store, "conn-1", &entry.id).unwrap();
        save_store(&dir, &store).unwrap();

        let loaded = load_store(&dir);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].otp_type, "totp");
        assert_eq!(loaded.entries[0].algorithm, OtpAlgorithm::Sha1);
        assert_eq!(loaded.entries[0].digits, 6);
        assert_eq!(loaded.entries[0].period, 30);
        assert_eq!(
            loaded.bindings.get("conn-1").map(String::as_str),
            Some(entry.id.as_str())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_file_is_0600_and_secret_never_plaintext_on_disk() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        save(&mut store, totp_params(json!({})), &vault);
        save_store(&dir, &store).unwrap();
        let text = std::fs::read_to_string(store_path(&dir)).unwrap();
        assert!(
            !text.contains(SECRET_PLAIN),
            "plaintext secret must not touch disk"
        );
        assert!(text.contains("secretEnc"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(store_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_file_falls_back_to_empty_store() {
        let dir = temp_dir();
        std::fs::write(store_path(&dir), "{not json").unwrap();
        assert!(load_store(&dir).entries.is_empty());
        assert!(load_store(&dir).bindings.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // —— save（加密 / 空保留旧值 / 校验）/ list 脱敏 ————————————

    #[test]
    fn save_encrypts_new_secret_and_keeps_old_on_empty_update() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(&mut store, totp_params(json!({})), &vault);
        assert!(!entry.secret_encrypted.is_empty());

        // 空 secret 更新：保留旧密文。
        let (updated, created) = save_entry(
            &mut store,
            &json!({ "id": entry.id, "username": "bob", "secret": "" }),
            &vault,
        )
        .unwrap();
        assert!(!created);
        assert_eq!(updated.username, "bob");
        assert_eq!(updated.secret_encrypted, entry.secret_encrypted);
        // 明文能解回原密钥。
        assert_eq!(
            get_decrypted_secret(&vault, &updated).unwrap(),
            otp::decode_base32(SECRET_PLAIN).unwrap()
        );

        // 新 secret 覆盖旧值（解密结果 = 新输入密钥的字节，且密文已更换）。
        let (rotated, _) = save_entry(
            &mut store,
            &json!({ "id": entry.id, "secret": "MFRGGZDFMZTWQ2LK" }),
            &vault,
        )
        .unwrap();
        assert_ne!(rotated.secret_encrypted, entry.secret_encrypted);
        assert_eq!(
            get_decrypted_secret(&vault, &rotated).unwrap(),
            otp::decode_base32("MFRGGZDFMZTWQ2LK").unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_rejects_bad_input_shapes() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        // 新建缺 secret。
        assert!(save_entry(&mut store, &json!({ "issuer": "x" }), &vault).is_err());
        // 非法 base32。
        assert!(save_entry(&mut store, &json!({ "secret": "!!" }), &vault).is_err());
        // otpType / digits / period / counter 校验。
        assert!(save_entry(
            &mut store,
            &json!({ "secret": SECRET_PLAIN, "otpType": "yub" }),
            &vault
        )
        .is_err());
        assert!(save_entry(
            &mut store,
            &json!({ "secret": SECRET_PLAIN, "digits": 5 }),
            &vault
        )
        .is_err());
        assert!(save_entry(
            &mut store,
            &json!({ "secret": SECRET_PLAIN, "period": 0 }),
            &vault
        )
        .is_err());
        assert!(save_entry(
            &mut store,
            &json!({ "secret": SECRET_PLAIN, "otpType": "hotp" }),
            &vault
        )
        .expect_err("hotp requires counter")
        .contains("counter"));
        // issuer 超长。
        assert!(save_entry(
            &mut store,
            &json!({ "secret": SECRET_PLAIN, "issuer": "i".repeat(MAX_ISSUER_LEN + 1) }),
            &vault
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn views_redact_secret_but_report_has_secret() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(&mut store, totp_params(json!({})), &vault);
        let views = list_views(&store);
        assert_eq!(views.len(), 1);
        let view = &views[0];
        assert_eq!(view["hasSecret"], true);
        assert!(view.get("secret").is_none());
        assert!(view.get("secretEnc").is_none());
        assert_eq!(view["issuer"], "ACME");
        let serialized = serde_json::to_string(&views).unwrap();
        assert!(!serialized.contains(SECRET_PLAIN));
        assert_eq!(binding_views(&store), json!({}));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = entry;
    }

    #[test]
    fn hotp_entry_roundtrips_counter() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(
            &mut store,
            totp_params(
                json!({ "otpType": "hotp", "counter": 5, "algorithm": "SHA512", "digits": 8, "period": 60 }),
            ),
            &vault,
        );
        assert_eq!(entry.otp_type, "hotp");
        assert_eq!(entry.counter, Some(5));
        assert_eq!(entry.algorithm, OtpAlgorithm::Sha512);
        assert_eq!(entry.digits, 8);
        save_store(&dir, &store).unwrap();
        let loaded = load_store(&dir);
        assert_eq!(loaded.entries[0].counter, Some(5));
        // totp 条目带 counter 输入也会被丢弃。
        let totp = save(&mut store, totp_params(json!({ "counter": 9 })), &vault);
        assert_eq!(totp.counter, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entry_cap_blocks_new_entries_only() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        for index in 0..MAX_ENTRIES {
            save(
                &mut store,
                totp_params(json!({ "issuer": format!("p{index}") })),
                &vault,
            );
        }
        assert!(save_entry(
            &mut store,
            &totp_params(json!({ "issuer": "overflow" })),
            &vault
        )
        .is_err());
        let id = store.entries[0].id.clone();
        assert!(save_entry(
            &mut store,
            &json!({ "id": id, "issuer": "edit-ok" }),
            &vault
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // —— bind / unbind / delete ————————————————————

    #[test]
    fn bind_unbind_and_delete_cascade() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(&mut store, totp_params(json!({})), &vault);
        assert!(bind(&mut store, "conn-1", "missing").is_err());
        bind(&mut store, "conn-1", &entry.id).unwrap();
        assert_eq!(
            binding_views(&store).get("conn-1").and_then(Value::as_str),
            Some(entry.id.as_str())
        );
        // 改绑。
        let second = save(&mut store, totp_params(json!({ "issuer": "B" })), &vault);
        bind(&mut store, "conn-1", &second.id).unwrap();
        assert_eq!(store.bindings["conn-1"], second.id);
        // 解绑。
        assert!(unbind(&mut store, "conn-1"));
        assert!(!unbind(&mut store, "conn-1"));
        // 删除条目级联清绑定。
        bind(&mut store, "conn-2", &entry.id).unwrap();
        assert!(delete_entry(&mut store, &entry.id));
        assert!(!delete_entry(&mut store, &entry.id));
        assert!(!store.bindings.values().any(|id| id == &entry.id));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // —— 绑定解析 + 共享防重放缓存 ————————————————————

    #[test]
    fn bound_totp_resolves_binding_and_skips_hotp_or_missing() {
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let totp = save(&mut store, totp_params(json!({})), &vault);
        let hotp = save(
            &mut store,
            totp_params(json!({ "otpType": "hotp", "counter": 1 })),
            &vault,
        );

        bind(&mut store, "conn-a", &totp.id).unwrap();
        save_store(&dir, &store).unwrap();
        let bound = bound_totp_in(&dir, "conn-a").unwrap();
        assert_eq!(bound.entry_id, totp.id);
        assert_eq!(bound.key, otp::decode_base32(SECRET_PLAIN).unwrap());

        // hotp 绑定不参与 TOTP 自动应答。
        bind(&mut store, "conn-b", &hotp.id).unwrap();
        save_store(&dir, &store).unwrap();
        assert!(bound_totp_in(&dir, "conn-b").is_none());
        assert!(bound_totp_in(&dir, "conn-ghost").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn take_window_code_blocks_replay_within_step_and_rotates_next_step() {
        reset_replay_cache();
        let key = b"12345678901234567890";
        let first = take_window_code("e1", key, OtpAlgorithm::Sha1, 6, 30, 100).unwrap();
        assert_eq!(first.code.len(), 6);
        assert_eq!(first.remaining_secs, 30 - 100 % 30);
        // 同窗口第二次取码被拒，并给出等待秒数。
        let used = take_window_code("e1", key, OtpAlgorithm::Sha1, 6, 30, 100).unwrap_err();
        assert_eq!(used.remaining_secs, first.remaining_secs);
        // 同窗口稍后仍拒。
        assert!(take_window_code("e1", key, OtpAlgorithm::Sha1, 6, 30, 110).is_err());
        // 下一窗口放行，且码刷新（remaining = period - now % period = 20）。
        let second = take_window_code("e1", key, OtpAlgorithm::Sha1, 6, 30, 130).unwrap();
        assert_eq!(second.remaining_secs, 20);
        // 不同条目互不影响。
        assert!(take_window_code("e2", key, OtpAlgorithm::Sha1, 6, 30, 100).is_ok());
    }

    #[test]
    fn take_connection_totp_key_marks_window_via_shared_cache() {
        reset_replay_cache();
        let dir = temp_dir();
        let vault = keyfile_vault(&dir);
        let mut store = OtpStore::default();
        let entry = save(&mut store, totp_params(json!({})), &vault);
        bind(&mut store, "conn-x", &entry.id).unwrap();
        save_store(&dir, &store).unwrap();

        let bound = take_connection_totp_key(&dir, "conn-x").expect("first take succeeds");
        assert_eq!(bound.entry_id, entry.id);
        // 自动应答取过之后，同窗口 otp/generate 路径必须被挡下。
        assert!(take_window_code(
            &entry.id,
            &bound.key,
            bound.algorithm,
            bound.digits,
            bound.period,
            unix_now_secs()
        )
        .is_err());
        // 未绑定连接拿不到。
        assert!(take_connection_totp_key(&dir, "conn-y").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn global_data_dir_roundtrip() {
        // 注入/读取（初始化函数幂等，测试里允许反复覆盖）。
        let dir = temp_dir();
        init_data_dir(&dir);
        assert_eq!(data_dir().as_deref(), Some(dir.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // —— QR 导入 ————————————————————

    /// 离线生成的测试向量（Python segno，version 6、EC-M、scale 4、border 2，
    /// 197x197 PNG）。内容：
    /// `otpauth://totp/ACME:alice%40acme.com?secret=GEZDGNBVGY3TQOJQ&issuer=ACME&digits=8&period=60`
    const QR_PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0AQAAAAAVtjufAAABp0lEQVR42tVYy41CQQyLtgH336U7yNrOA2klLiv5wgjBYw75OI4TmP14OF9zPzPQ5yxBgIQv+DOfz3/vZ7F6yQV0lvrii6b9gUMmnI/ffFG2L4PKwfA8F+34GQeOXU7K9mP1yut6t/E3Xf6cMn9SVj4cFWNT5yr+g3SCuDlMQthq/GZNcJEfEZXt/pJpNdaIN1QOpItd5afbVg/mj1wogyo+soiX5blCd/FR9G5eIxQv6OqPC0rH71IcRlvtL0Z41r5gF9wu/m5YY2Pz/r5d/BWz3USDDFAZ/zdIoiiffKr8ZwTz2jbRT7W+FgaPZxGHR9ByfU86M4AZhbOTpr4xEzgZnHxW9RNROHMyuTAjuGg/6hMBskDYX1efD5MNczbcmbb+BB2r3F4+Zf2x2ddukhyq/Jzw0sPrPcFQxkcAwQ97EoHu/hBWesCcQLT1+ZBJF5/EbZk/z0Y7NyDZ7t/QEq/Nzd089f2T4A0a4uhU3p+R7fCxXub/8/siDPKAvJlctn8qxBvwW7efAXbT3frT7i8v0FGKjAJMWd/mejaLtMWiz//v/X/gF/rESY0Iu1K8AAAAAElFTkSuQmCC";

    #[test]
    fn decode_otpauth_qr_parses_generated_code() {
        let params = decode_otpauth_qr(QR_PNG_BASE64).unwrap();
        assert_eq!(params.otp_type, "totp");
        assert_eq!(params.issuer, "ACME");
        assert_eq!(params.secret_base32, "GEZDGNBVGY3TQOJQ");
        assert_eq!(params.digits, 8);
        assert_eq!(params.period, 60);
        assert_eq!(params.counter, None);
    }

    #[test]
    fn decode_otpauth_qr_accepts_data_url_prefix() {
        let data_url = format!("data:image/png;base64,{QR_PNG_BASE64}");
        let params = decode_otpauth_qr(&data_url).unwrap();
        assert_eq!(params.issuer, "ACME");
    }

    #[test]
    fn decode_otpauth_qr_rejects_garbage_and_non_qr_images() {
        assert!(decode_otpauth_qr("not base64!!").is_err());
        assert!(decode_otpauth_qr("").is_err());
        // 合法 PNG 字节但没有二维码（1x1 透明像素）。
        let tiny_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        assert!(decode_otpauth_qr(tiny_png).is_err());
    }

    /// 解压炸弹防线：压缩后极小的 PNG 也可以声明 8193px 宽，超过
    /// [`MAX_QR_PIXEL_EDGE`] 时必须在解码前被 limits 拒绝。
    #[test]
    fn decode_otpauth_qr_rejects_oversized_images() {
        let oversized = image::DynamicImage::new_luma8(MAX_QR_PIXEL_EDGE + 1, 1);
        let mut buf = std::io::Cursor::new(Vec::new());
        oversized
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("encode oversized png");
        let encoded = BASE64_STANDARD.encode(buf.get_ref());
        let error = decode_otpauth_qr(&encoded).unwrap_err();
        assert!(
            error.starts_with("image could not be decoded"),
            "oversized image must be refused by the decode limits, got: {error}"
        );
    }
}
