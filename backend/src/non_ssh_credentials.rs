//! 非 SSH 连接（telnet/vnc/rdp）的已存凭据暂存。
//!
//! 宿主把连接表单的密码字段（manifest `binding: "password"`）落在 lifecycle
//! `connection.password`，随 `connection/connect` 投递给 sidecar；但这三个协
//! 议的会话由前端 `telnet/start` / `vnc/start` / `rdp/start` 驱动，请求只带
//! `connectionId` 与连接参数、不带凭据（webview context 是无密钥白名单形状，
//! 前端永远拿不到）。这里按 connectionId 暂存 username + password，start 时
//! 请求未携带凭据才合并——用户在连接表单存了密码，就是"自动登录/免密认证"
//! 的意图；没存则维持旧行为（回落各自的连接弹窗）。
//!
//! 内存模型与 SSH 的 `store_connection` 完全一致：仅进程内存活、
//! `connection/disconnect` 即清、容量封顶、Debug 永不回显密码。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

/// 封顶防泄漏：正常使用远达不到；超出时挤掉最旧的一条（插入序）。
const MAX_ENTRIES: usize = 256;

struct Entry {
    username: String,
    password: Zeroizing<String>,
    _inserted_at: std::time::Instant,
}

#[derive(Clone, Default)]
pub struct NonSshCredentials {
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

impl NonSshCredentials {
    pub fn new() -> Self {
        Self::default()
    }

    /// `connection/connect`（非 SSH 分支）：暂存该连接的表单凭据；空密码视
    /// 为"清除已存"，删掉旧条目。用户名与密码都原样保留（首尾空格合法）。
    pub fn store(&self, connection_id: &str, username: &str, password: &str) {
        if connection_id.is_empty() {
            return;
        }
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if password.is_empty() {
            entries.remove(connection_id);
            return;
        }
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(connection_id) {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry._inserted_at)
                .map(|(id, _)| id.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            connection_id.to_string(),
            Entry {
                username: username.to_string(),
                password: Zeroizing::new(password.to_string()),
                _inserted_at: std::time::Instant::now(),
            },
        );
    }

    /// `connection/disconnect`：连接关闭即清凭据，不留进程内存活副本。
    pub fn drop_connection(&self, connection_id: &str) {
        if connection_id.is_empty() {
            return;
        }
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(connection_id);
    }

    /// start 合并时取凭据（owned 拷贝，锁内即释放）。
    pub fn get(&self, connection_id: &str) -> Option<(String, String)> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        entries
            .get(connection_id)
            .map(|entry| (entry.username.clone(), entry.password.as_str().to_string()))
    }
}

impl std::fmt::Debug for NonSshCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        formatter
            .debug_struct("NonSshCredentials")
            .field("connection_ids", &entries.keys().collect::<Vec<_>>())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_round_trips_username_and_password() {
        let registry = NonSshCredentials::new();
        registry.store("conn-1", "ops", "s3cret");
        assert_eq!(
            registry.get("conn-1"),
            Some(("ops".to_string(), "s3cret".to_string()))
        );
        assert_eq!(registry.get("other"), None);
    }

    #[test]
    fn empty_password_clears_previous_entry() {
        let registry = NonSshCredentials::new();
        registry.store("conn-1", "ops", "s3cret");
        registry.store("conn-1", "ops", "");
        assert_eq!(
            registry.get("conn-1"),
            None,
            "cleared password must not linger"
        );
    }

    #[test]
    fn drop_connection_removes_entry() {
        let registry = NonSshCredentials::new();
        registry.store("conn-1", "", "s3cret");
        registry.drop_connection("conn-1");
        assert_eq!(registry.get("conn-1"), None);
        registry.drop_connection("missing");
    }

    #[test]
    fn blank_connection_id_is_ignored() {
        let registry = NonSshCredentials::new();
        registry.store("", "ops", "s3cret");
        assert_eq!(registry.get(""), None);
    }

    #[test]
    fn registry_is_capped_and_never_debug_prints_password() {
        let registry = NonSshCredentials::new();
        for index in 0..(MAX_ENTRIES + 8) {
            registry.store(&format!("conn-{index}"), "", "s3cret");
        }
        let entries = registry
            .entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        assert!(
            entries.len() <= MAX_ENTRIES,
            "cap exceeded: {}",
            entries.len()
        );
        drop(entries);
        let rendered = format!("{registry:?}");
        assert!(
            !rendered.contains("s3cret"),
            "debug leaked a password: {rendered}"
        );
    }
}
