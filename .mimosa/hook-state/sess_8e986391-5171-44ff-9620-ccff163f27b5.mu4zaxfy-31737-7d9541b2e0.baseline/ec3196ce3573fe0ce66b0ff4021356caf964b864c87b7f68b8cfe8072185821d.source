//! Local SSH key discovery and known-hosts management, mirroring tiny-rdm.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use russh::keys::decode_secret_key;
use russh::keys::ssh_key::{Algorithm, HashAlg, PrivateKey as OpensshPrivateKey};
use serde::Serialize;
use serde_json::{json, Value};

use crate::host_key::HostKeyVerifier;

/// Candidate file names OpenSSH clients try in `~/.ssh` by default.
const CONVENTIONAL_KEY_NAMES: &[&str] = &[
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    "identity",
];

/// A private key found on this machine. Only metadata travels in this
/// structure; the key material itself never leaves the file it lives in.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredKey {
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub has_passphrase: bool,
}

/// Finds private keys under `$HOME/.ssh`: the conventional `id_*`/`identity`
/// names, any `*.pem`/`*.key` file, and every `IdentityFile` mentioned in
/// `~/.ssh/config`. Files that cannot be decoded as private keys are skipped
/// without failing the whole scan, like tiny-rdm's DiscoverKeys.
pub fn discover() -> Result<Vec<DiscoveredKey>, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| "Home directory could not be found".to_string())?;
    Ok(discover_in(&PathBuf::from(home).join(".ssh")))
}

/// `keys/discover/options`: data source for a host-rendered key dropdown
/// (manifest `options_action`). `value` and `label` are both the absolute key
/// path: the path alone is the shortest text that still tells two same-named
/// keys apart, and a label without algorithm/fingerprint cannot stretch the
/// control. Algorithm and fingerprint stay in `keys/discover`. Only metadata
/// travels here — never key material.
pub fn discover_options() -> Result<Value, String> {
    let options: Vec<Value> = discover()?
        .into_iter()
        .map(|key| json!({ "value": key.path.clone(), "label": key.path }))
        .collect();
    Ok(json!({ "options": options }))
}

/// Scans `ssh_dir` (normally `~/.ssh`) for private keys. An unreadable or
/// missing directory simply yields no results.
fn discover_in(ssh_dir: &Path) -> Vec<DiscoveredKey> {
    let mut candidates = BTreeSet::new();

    for name in CONVENTIONAL_KEY_NAMES {
        let path = ssh_dir.join(name);
        if path.is_file() {
            candidates.insert(path);
        }
    }

    if let Ok(entries) = std::fs::read_dir(ssh_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if name.ends_with(".pub") {
                continue;
            }
            let looks_like_key =
                name.starts_with("id_") || name.ends_with(".pem") || name.ends_with(".key");
            if looks_like_key {
                candidates.insert(path);
            }
        }
    }

    if let Ok(config) = std::fs::read_to_string(ssh_dir.join("config")) {
        for path in identity_files_from_config(&config, ssh_dir) {
            if path.is_file() {
                candidates.insert(path);
            }
        }
    }

    let mut keys: Vec<DiscoveredKey> = candidates
        .iter()
        .filter_map(|path| probe_key(path))
        .collect();
    keys.sort_by(|a, b| a.path.cmp(&b.path));
    keys
}

/// Probes one file for a decodable private key, returning metadata only.
/// `None` means "not a private key we support" and the caller skips it.
fn probe_key(path: &Path) -> Option<DiscoveredKey> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim_start();
    if !trimmed.starts_with("-----BEGIN") && !trimmed.starts_with("PuTTY-User-Key-File-") {
        return None;
    }
    if trimmed.contains(" PUBLIC KEY-----") {
        return None;
    }

    match decode_secret_key(&text, None) {
        Ok(key) => Some(DiscoveredKey {
            path: path.display().to_string(),
            algorithm: algorithm_name(key.algorithm()),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            has_passphrase: false,
        }),
        Err(error) => {
            // Encrypted OpenSSH keys report KeyIsEncrypted; legacy PKCS#1 and
            // PKCS#8 envelopes carry an ENCRYPTED marker instead.
            let encrypted =
                matches!(error, russh::keys::Error::KeyIsEncrypted) || text.contains("ENCRYPTED");
            if !encrypted {
                return None;
            }
            // The OpenSSH format stores the public half in the clear, so the
            // algorithm and fingerprint survive even without the passphrase.
            if let Ok(key) = OpensshPrivateKey::from_openssh(&text) {
                return Some(DiscoveredKey {
                    path: path.display().to_string(),
                    algorithm: algorithm_name(key.algorithm()),
                    fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                    has_passphrase: true,
                });
            }
            Some(DiscoveredKey {
                path: path.display().to_string(),
                algorithm: String::new(),
                fingerprint: String::new(),
                has_passphrase: true,
            })
        }
    }
}

/// Maps an SSH algorithm identifier to the lowercase name reported by the
/// discovery API, e.g. "ssh-ed25519", "rsa", "ecdsa".
fn algorithm_name(algorithm: Algorithm) -> String {
    let name = algorithm.as_str();
    if name == "ssh-rsa" || name.starts_with("rsa-sha2-") {
        "rsa"
    } else if name.starts_with("ecdsa-") {
        "ecdsa"
    } else {
        name
    }
    .to_string()
}

/// Extracts every `IdentityFile` directive from an ssh_config file, resolved
/// against `ssh_dir` (relative paths are relative to `~/.ssh`, like ssh).
fn identity_files_from_config(config: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    config
        .lines()
        .filter_map(parse_identity_file_directive)
        .map(|value| resolve_identity_path(&value, ssh_dir))
        .collect()
}

fn parse_identity_file_directive(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (keyword, value) = if let Some((keyword, value)) = line.split_once('=') {
        (keyword.trim().to_string(), value.trim().to_string())
    } else {
        let mut parts = line.split_whitespace();
        let keyword = parts.next()?.to_string();
        (keyword, parts.collect::<Vec<_>>().join(" "))
    };
    if !keyword.eq_ignore_ascii_case("IdentityFile") {
        return None;
    }
    let value = value.trim_matches('"').trim_matches('\'');
    (!value.is_empty()).then(|| value.to_string())
}

fn resolve_identity_path(value: &str, ssh_dir: &Path) -> PathBuf {
    if let Some(remainder) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return ssh_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
            .join(remainder);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        ssh_dir.join(path)
    }
}

/// Lists the plugin's known_hosts store as `{entries: [...]}` with fields
/// `{host, port, keyType, fingerprint, marker}`. `marker` is the OpenSSH
/// marker (`@cert-authority` / `@revoked`) or `null` for plain entries. The
/// store keeps no timestamps, so there is no `learnedAt` to report. The
/// system `~/.ssh/known_hosts` stays read-only and is not included, matching
/// HostKeyVerifier::list_known_hosts.
pub fn list_known_hosts(data_dir: &Path) -> Result<Value, String> {
    let verifier = HostKeyVerifier::new(data_dir.join("known_hosts"));
    let mut entries: Vec<Value> = verifier
        .list_known_hosts()?
        .into_iter()
        .map(|entry| {
            let (host, port) = split_host_field(&entry.host_field);
            json!({
                "host": host,
                "port": port,
                "keyType": entry.key_type,
                "fingerprint": entry.fingerprint,
                "marker": entry.marker,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        let host = a["host"].as_str().cmp(&b["host"].as_str());
        host.then(a["port"].as_u64().cmp(&b["port"].as_u64()))
            .then(a["keyType"].as_str().cmp(&b["keyType"].as_str()))
    });
    Ok(json!({ "entries": entries }))
}

/// Removes entries matching `host:port` from the plugin's known_hosts store
/// and returns how many lines were removed.
pub fn remove_known_host(data_dir: &Path, host: &str, port: u16) -> Result<usize, String> {
    let verifier = HostKeyVerifier::new(data_dir.join("known_hosts"));
    verifier.remove_known_host(host, port)
}

/// Splits a known_hosts host field into `(host, port)`. `[host]:2222` carries
/// an explicit port; a bare `host` means the default port 22.
fn split_host_field(host_field: &str) -> (String, u16) {
    if let Some(rest) = host_field.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once("]:") {
            if let Ok(port) = port.parse::<u16>() {
                return (host.to_string(), port);
            }
        }
    }
    (host_field.to_string(), 22)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the tests that redirect HOME so they cannot race each
    /// other or the read-only HOME accesses elsewhere in the crate.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Restores the home environment variable on drop, even on panic.
    struct HomeEnvGuard {
        previous: Option<std::ffi::OsString>,
    }

    impl HomeEnvGuard {
        fn set(home: &Path) -> Self {
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            let previous = std::env::var_os(var);
            std::env::set_var(var, home);
            Self { previous }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            match self.previous.take() {
                Some(value) => std::env::set_var(var, value),
                None => std::env::remove_var(var),
            }
        }
    }

    /// Generates an ed25519 key with ssh-keygen, returning false when the
    /// tool is unavailable so callers can fall back to reduced assertions.
    fn generate_key(path: &Path, passphrase: &str) -> bool {
        std::process::Command::new("ssh-keygen")
            .arg("-t")
            .arg("ed25519")
            .arg("-N")
            .arg(passphrase)
            .arg("-C")
            .arg("keys-rs-test")
            .arg("-f")
            .arg(path)
            .arg("-q")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn discover_reports_generated_keys() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();

        if !generate_key(&ssh_dir.join("id_ed25519"), "") {
            // No ssh-keygen on this machine: verify the tolerant paths only.
            assert!(discover_in(&ssh_dir).is_empty());
            std::fs::write(ssh_dir.join("junk.pem"), "not a key at all\n").unwrap();
            std::fs::write(
                ssh_dir.join("id_junk"),
                "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
            )
            .unwrap();
            assert!(discover_in(&ssh_dir).is_empty());
            return;
        }

        assert!(generate_key(&ssh_dir.join("encrypted.pem"), "secret123"));
        assert!(generate_key(&ssh_dir.join("relative_key"), ""));
        assert!(generate_key(&ssh_dir.join("dotslash_key"), ""));
        let absolute = home.path().join("outside_key.pem");
        assert!(generate_key(&absolute, ""));
        std::fs::write(ssh_dir.join("junk.pem"), "not a key at all\n").unwrap();
        std::fs::write(
            ssh_dir.join("id_junk"),
            "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        std::fs::write(
            ssh_dir.join("config"),
            format!(
                "Host example\n  HostName example.test\n  IdentityFile relative_key\n\
                 identityfile = {}\n  IdentityFile \"dotslash_key\"\n\
                 # IdentityFile commented_out\n  User someone\n",
                absolute.display()
            ),
        )
        .unwrap();

        let _guard_env = HomeEnvGuard::set(home.path());
        let keys = discover().unwrap();

        let paths: Vec<&str> = keys.iter().map(|key| key.path.as_str()).collect();
        let expected = [
            ssh_dir.join("id_ed25519"),
            ssh_dir.join("encrypted.pem"),
            ssh_dir.join("relative_key"),
            ssh_dir.join("dotslash_key"),
            absolute.clone(),
        ];
        for path in &expected {
            assert!(
                paths.contains(&path.display().to_string().as_str()),
                "discovery missed {}",
                path.display()
            );
        }
        assert!(!paths.iter().any(|path| path.ends_with("junk.pem")));
        assert!(!paths.iter().any(|path| path.ends_with("id_junk")));
        assert_eq!(paths.len(), expected.len());

        let plain = keys
            .iter()
            .find(|key| key.path.ends_with("id_ed25519"))
            .unwrap();
        assert_eq!(plain.algorithm, "ssh-ed25519");
        assert!(plain.fingerprint.starts_with("SHA256:"));
        assert!(!plain.has_passphrase);

        let encrypted = keys
            .iter()
            .find(|key| key.path.ends_with("encrypted.pem"))
            .unwrap();
        assert!(encrypted.has_passphrase);
        // The OpenSSH format keeps the public half readable, so metadata is
        // still recoverable for passphrase-protected keys.
        assert_eq!(encrypted.algorithm, "ssh-ed25519");
        assert!(encrypted.fingerprint.starts_with("SHA256:"));

        // The private key material must never leave the files.
        let serialized = serde_json::to_string(&keys).unwrap();
        assert!(!serialized.contains("PRIVATE KEY"));
        let secret_body = std::fs::read_to_string(ssh_dir.join("id_ed25519"))
            .unwrap()
            .lines()
            .nth(1)
            .unwrap()
            .to_string();
        assert!(!serialized.contains(&secret_body));
    }

    #[test]
    fn discover_tolerates_missing_home_ssh() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let _guard_env = HomeEnvGuard::set(home.path());
        assert!(discover().unwrap().is_empty());

        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::write(ssh_dir.join("config"), "IdentityFile nothing_here\n").unwrap();
        assert!(discover().unwrap().is_empty());
    }

    /// `discover_options` renders one dropdown entry per discovered key whose
    /// label is the key path itself (no metadata, so the text stays short);
    /// key material never travels in the options.
    #[test]
    fn discover_options_shape_only_metadata() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();

        if !generate_key(&ssh_dir.join("id_ed25519"), "") {
            // No ssh-keygen on this machine: verify the tolerant empty shape.
            let _guard_env = HomeEnvGuard::set(home.path());
            let options = discover_options().unwrap();
            assert_eq!(options["options"].as_array().unwrap().len(), 0);
            return;
        }
        assert!(generate_key(&ssh_dir.join("locked.pem"), "phrase"));

        let _guard_env = HomeEnvGuard::set(home.path());
        let options = discover_options().unwrap()["options"]
            .as_array()
            .unwrap()
            .clone();
        let plain = options
            .iter()
            .find(|option| option["value"].as_str().unwrap().ends_with("id_ed25519"))
            .expect("plain key listed");
        assert_eq!(
            plain["label"], plain["value"],
            "the option label is the key path itself"
        );
        assert!(!plain["label"].as_str().unwrap().contains("SHA256:"));
        let encrypted = options
            .iter()
            .find(|option| option["value"].as_str().unwrap().ends_with("locked.pem"))
            .expect("encrypted key listed");
        assert_eq!(encrypted["label"], encrypted["value"]);

        let serialized = serde_json::to_string(&options).unwrap();
        assert!(!serialized.contains("PRIVATE KEY"));
    }

    #[cfg(unix)]
    #[test]
    fn discover_skips_unreadable_files() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        if !generate_key(&ssh_dir.join("id_ed25519"), "") {
            assert!(discover_in(&ssh_dir).is_empty());
            return;
        }
        let unreadable = ssh_dir.join("locked.pem");
        std::fs::write(&unreadable, "-----BEGIN OPENSSH PRIVATE KEY-----\nzz\n").unwrap();
        std::fs::set_permissions(
            &unreadable,
            std::os::unix::fs::PermissionsExt::from_mode(0o000),
        )
        .unwrap();

        let _guard_env = HomeEnvGuard::set(home.path());
        let keys = discover().unwrap();
        assert_eq!(keys.len(), 1);
        assert!(keys[0].path.ends_with("id_ed25519"));
    }

    #[cfg(unix)]
    #[test]
    fn identity_file_directives_resolve_paths() {
        let ssh_dir = Path::new("/home/tester/.ssh");
        let config = "\
# global config
IdentityFile relative_key
identityfile = /absolute/from/equals.pem
IdentityFile \"quoted key\"
IdentityFile ~/dotslash_key
HostName example.test
IdentityFile
";
        let paths = identity_files_from_config(config, ssh_dir);
        assert_eq!(
            paths,
            vec![
                ssh_dir.join("relative_key"),
                PathBuf::from("/absolute/from/equals.pem"),
                ssh_dir.join("quoted key"),
                PathBuf::from("/home/tester/dotslash_key"),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn identity_file_directives_resolve_windows_and_unicode_paths() {
        let home = PathBuf::from(r"C:\Users\测试");
        let ssh_dir = home.join(".ssh");
        let config = "\
IdentityFile C:\\Keys\\生产\\id_ed25519\r\n\
IdentityFile \\\\server\\share\\运维.key\r\n\
IdentityFile ~\\.ssh\\id_fallback\r\n";
        let paths = identity_files_from_config(config, &ssh_dir);

        assert_eq!(
            paths,
            vec![
                PathBuf::from(r"C:\Keys\生产\id_ed25519"),
                PathBuf::from(r"\\server\share\运维.key"),
                home.join(".ssh").join("id_fallback"),
            ]
        );
    }

    #[test]
    fn known_hosts_list_and_remove_roundtrip() {
        let directory = tempfile::tempdir().unwrap();
        let data_dir = directory.path();

        // Missing store behaves like an empty one.
        assert_eq!(remove_known_host(data_dir, "example.test", 22).unwrap(), 0);
        let empty = list_known_hosts(data_dir).unwrap();
        assert_eq!(empty["entries"].as_array().unwrap().len(), 0);

        let key_line = if generate_key(&directory.path().join("probe_key"), "") {
            std::fs::read_to_string(directory.path().join("probe_key.pub"))
                .unwrap()
                .trim()
                .to_string()
        } else {
            // Bogus base64 still lists; the fingerprint just stays empty.
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz test"
                .to_string()
        };
        std::fs::write(
            data_dir.join("known_hosts"),
            format!(
                "# comment\nexample.test {key_line}\n[example.test]:2222 {key_line}\nother.test {key_line}\n"
            ),
        )
        .unwrap();

        let listed = list_known_hosts(data_dir).unwrap();
        let entries = listed["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["host"], "example.test");
        assert_eq!(entries[0]["port"], 22);
        assert_eq!(entries[1]["host"], "example.test");
        assert_eq!(entries[1]["port"], 2222);
        assert_eq!(entries[2]["host"], "other.test");
        assert_eq!(entries[0]["keyType"], "ssh-ed25519");
        for entry in entries {
            let fingerprint = entry["fingerprint"].as_str().unwrap();
            assert!(fingerprint.is_empty() || fingerprint.starts_with("SHA256:"));
            // Plain entries always carry a null marker so the wire shape is
            // stable for the frontend.
            assert!(entry["marker"].is_null());
        }

        assert_eq!(remove_known_host(data_dir, "example.test", 22).unwrap(), 1);
        assert_eq!(
            remove_known_host(data_dir, "example.test", 2222).unwrap(),
            1
        );
        let remaining = list_known_hosts(data_dir).unwrap();
        let entries = remaining["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["host"], "other.test");
        assert_eq!(remove_known_host(data_dir, "example.test", 22).unwrap(), 0);
    }

    #[test]
    fn host_field_splitting() {
        assert_eq!(
            split_host_field("example.test"),
            ("example.test".to_string(), 22)
        );
        assert_eq!(
            split_host_field("[example.test]:2222"),
            ("example.test".to_string(), 2222)
        );
        assert_eq!(
            split_host_field("[broken]:notaport"),
            ("[broken]:notaport".to_string(), 22)
        );
    }
}

// Registration for backend/src/main.rs (add `mod keys;` next to the other
// module declarations, then these arms inside `Plugin::handle_request`):
//
// ```text
// "keys/discover" => {
//     let keys = crate::keys::discover()?;
//     Ok(json!({ "keys": keys }))
// }
// "ssh/knownHosts/list" => {
//     Ok(crate::keys::list_known_hosts(&plugin_data_dir())?)
// }
// "ssh/knownHosts/remove" => {
//     let host = required_string(&params, "host")?;
//     let port = params
//         .get("port")
//         .and_then(Value::as_u64)
//         .and_then(|value| u16::try_from(value).ok())
//         .filter(|value| *value > 0)
//         .unwrap_or(22);
//     let removed = crate::keys::remove_known_host(&plugin_data_dir(), host, port)?;
//     Ok(json!({ "success": true, "removed": removed }))
// }
// ```
