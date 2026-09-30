//! Dynamic connection menu for saved SSH tunnels. The workbench's host.storage
//! lives beside the sidecar in `ui-storage.json`; this module only reads it.
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::forward;

const MAX_PROFILES: usize = 64;
// The host caps a submenu at 40 children. Reserve room for management and
// batch commands; the remaining presets are still available in the workbench.
const MENU_PROFILES: usize = 36;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelProfile {
    pub id: String,
    pub connection_id: String,
    pub kind: String,
    pub listen_host: String,
    pub listen_port: String,
    pub target_host: String,
    pub target_port: String,
}

impl TunnelProfile {
    pub fn spec(&self) -> Result<Value, String> {
        let listen_port = self
            .listen_port
            .parse::<u16>()
            .map_err(|_| "Invalid saved listen port")?;
        let mut spec = json!({
            "kind": self.kind,
            "listenHost": self.listen_host,
            "listenPort": listen_port,
        });
        if self.kind != "dynamic" {
            let target_port = self
                .target_port
                .parse::<u16>()
                .map_err(|_| "Invalid saved target port")?;
            spec["targetHost"] = json!(self.target_host);
            spec["targetPort"] = json!(target_port);
        }
        forward::parse_spec(&spec)?;
        Ok(spec)
    }

    pub fn route(&self) -> String {
        if self.kind == "dynamic" {
            format!("SOCKS5 {}:{}", self.listen_host, self.listen_port)
        } else {
            let arrow = if self.kind == "remote" { "←" } else { "→" };
            format!(
                "{}:{} {arrow} {}:{}",
                self.listen_host, self.listen_port, self.target_host, self.target_port
            )
        }
    }

    pub fn matches(&self, row: &Value) -> bool {
        let Ok(spec) = self.spec() else { return false };
        let Ok((_, listen_host, _, target_host, _)) = forward::parse_spec(&spec) else {
            return false;
        };
        row["kind"] == self.kind
            && row["listenHost"] == listen_host
            && row["listenPort"].as_u64() == self.listen_port.parse::<u64>().ok()
            && (self.kind == "dynamic"
                || (row["targetHost"] == target_host
                    && row["targetPort"].as_u64() == self.target_port.parse::<u64>().ok()))
            && row["state"] != "stopped"
            && row["state"] != "error"
    }
}

pub(crate) fn load_profiles(data_dir: &Path, connection_id: &str) -> Vec<TunnelProfile> {
    let Ok(bytes) = std::fs::read(data_dir.join("ui-storage.json")) else {
        return Vec::new();
    };
    if bytes.len() > 1024 * 1024 {
        return Vec::new();
    }
    let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    let Some(raw) = root.get("ssh-tunnel-profiles").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Ok(profiles) = serde_json::from_str::<Vec<Value>>(raw) else {
        return Vec::new();
    };
    profiles
        .into_iter()
        .take(MAX_PROFILES)
        .filter_map(|value| serde_json::from_value::<TunnelProfile>(value).ok())
        .filter(|profile| {
            profile.connection_id == connection_id
                && profile.id.len() <= 128
                && !profile.id.is_empty()
                && profile
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && profile.spec().is_ok()
        })
        .collect()
}

pub(crate) fn active_row<'a>(profile: &TunnelProfile, rows: &'a [Value]) -> Option<&'a Value> {
    rows.iter().find(|row| profile.matches(row))
}

pub(crate) fn menu(profiles: &[TunnelProfile], rows: &[Value], locale: &str) -> Value {
    let labels = match locale {
        "zh-CN" => [
            "端口映射",
            "管理端口映射",
            "启用已保存端口映射",
            "停止所有端口映射",
            "启动",
            "停止",
        ],
        "zh-TW" => [
            "連接埠映射",
            "管理連接埠映射",
            "啟用已儲存連接埠映射",
            "停止所有連接埠映射",
            "啟動",
            "停止",
        ],
        "es" => [
            "Redirecciones de puertos",
            "Gestionar redirecciones de puertos",
            "Iniciar redirecciones guardadas",
            "Detener todas las redirecciones",
            "Iniciar",
            "Detener",
        ],
        "it" => [
            "Inoltri porta",
            "Gestisci inoltri porta",
            "Avvia inoltri salvati",
            "Ferma tutti gli inoltri",
            "Avvia",
            "Ferma",
        ],
        "ja" => [
            "ポート転送",
            "ポート転送を管理",
            "保存済みポート転送をすべて開始",
            "すべてのポート転送を停止",
            "開始",
            "停止",
        ],
        "pt" | "pt-BR" => [
            "Encaminhamentos de porta",
            "Gerenciar encaminhamentos",
            "Iniciar encaminhamentos salvos",
            "Parar todos os encaminhamentos",
            "Iniciar",
            "Parar",
        ],
        _ => [
            "Port forwards",
            "Manage port forwards",
            "Start saved port forwards",
            "Stop all port forwards",
            "Start",
            "Stop",
        ],
    };
    let mut children = vec![json!({
        "label": labels[1],
        "action": { "type": "open-workbench", "workbench": "io.dbx.ssh.tunnels", "presentation": "dialog" }
    })];
    if !profiles.is_empty() {
        let has_inactive = profiles
            .iter()
            .any(|profile| active_row(profile, rows).is_none());
        if has_inactive {
            children.push(json!({"label": labels[2], "action": {"type": "invoke", "id": "start-all", "reopenConnectionOnMissing": true}}));
        }
    }
    if !rows.is_empty() {
        children.push(json!({"label": labels[3], "action": {"type": "invoke", "id": "stop-all"}}));
    }
    for profile in profiles.iter().take(MENU_PROFILES) {
        let running = active_row(profile, rows).is_some();
        let route: String = profile.route().chars().take(100).collect();
        children.push(json!({
            "label": format!("{} {}", if running { labels[5] } else { labels[4] }, route),
            "checked": running,
            "action": {"type": "invoke", "id": format!("toggle/{}", profile.id), "reopenConnectionOnMissing": true},
        }));
    }
    json!({"items": [{"label": labels[0], "children": children}]})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_existing_host_storage_and_ignores_other_connections() {
        let dir = std::env::temp_dir().join(format!("dbx-tunnel-menu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let profiles = json!([
            {"id":"one", "connectionId":"conn", "kind":"dynamic", "listenHost":"127.0.0.1", "listenPort":"1080", "targetHost":"", "targetPort":""},
            {"id":"two", "connectionId":"other", "kind":"local", "listenHost":"127.0.0.1", "listenPort":"8080", "targetHost":"example.test", "targetPort":"80"},
            {"id":"bad", "connectionId":"conn", "kind":"dynamic", "listenHost":"127.0.0.1", "listenPort":"bad", "targetHost":"", "targetPort":""}
        ]);
        std::fs::write(
            dir.join("ui-storage.json"),
            json!({"ssh-tunnel-profiles": profiles.to_string()}).to_string(),
        )
        .unwrap();
        let loaded = load_profiles(&dir, "conn");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "one");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn menu_tracks_saved_and_active_tunnels() {
        let none = menu(&[], &[], "zh-CN");
        assert_eq!(none["items"][0]["children"].as_array().unwrap().len(), 1);
        assert_eq!(none["items"][0]["children"][0]["label"], "管理端口映射");
        assert_eq!(
            none["items"][0]["children"][0]["action"]["presentation"],
            "dialog"
        );
        let profile = TunnelProfile {
            id: "profile-1".into(),
            connection_id: "conn".into(),
            kind: "dynamic".into(),
            listen_host: "127.0.0.1".into(),
            listen_port: "1080".into(),
            target_host: String::new(),
            target_port: String::new(),
        };
        let empty = menu(std::slice::from_ref(&profile), &[], "en");
        assert_eq!(
            empty["items"][0]["children"][1]["label"],
            "Start saved port forwards"
        );
        assert_eq!(
            empty["items"][0]["children"][2]["label"],
            "Start SOCKS5 127.0.0.1:1080"
        );
        let running = menu(
            &[profile],
            &[
                json!({"id":"forward-1","kind":"dynamic","listenHost":"127.0.0.1","listenPort":1080,"state":"active"}),
            ],
            "en",
        );
        assert_eq!(
            running["items"][0]["children"][1]["label"],
            "Stop all port forwards"
        );
        assert_eq!(
            running["items"][0]["children"][2]["label"],
            "Stop SOCKS5 127.0.0.1:1080"
        );
        assert_eq!(running["items"][0]["children"][2]["checked"], true);
    }
}
