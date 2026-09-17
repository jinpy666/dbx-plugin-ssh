//! Vault: static-at-rest encryption for Quick Sudo profile secrets
//! (`sudoPassword` / `totpSecret`). Each secret is sealed field-level with
//! AES-256-GCM under a random 32-byte data-encryption key (DEK), stored as
//! `base64(nonce‖ct)` with a fresh random 12-byte nonce per field. Every
//! envelope binds the additional authenticated data `"<field>|<profileId>"`,
//! so ciphertext cannot be transplanted between fields or profiles.
//!
//! The DEK lives in a `KeyProvider`. The default tier is a 0600 keyfile next
//! to the store (`vault.key`): the OS keychain re-raises an authorization
//! dialog whenever the accessing binary changes — which is every plugin
//! update on macOS — and once per sidecar process otherwise, so it is only
//! used when the operator explicitly opts in via
//! `DBX_SSH_VAULT_STORAGE=keychain` or for legacy envelopes recorded with the
//! keychain tier (those migrate to the keyfile tier on first successful
//! load). The chosen tier is recorded in the store envelope header so later
//! loads stay on the same provider. There is deliberately no master password
//! / KDF: unattended sudo auto-answer must survive restarts without an
//! unlock step, so this is an at-rest (anti-copy / backup-exfiltration)
//! guarantee, not an unlock-gated one.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroizing;

const DEK_LEN: usize = 32;
const NONCE_LEN: usize = 12;
/// Keychain coordinates for the DEK (v1 envelope layout). Only platforms
/// with a native `keyring` backend reference these.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const KEYCHAIN_SERVICE: &str = "io.dbx.ssh";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const KEYCHAIN_ACCOUNT: &str = "vault-dek-v1";
const KEYFILE_NAME: &str = "vault.key";

/// Encrypted secret fields, as named in the AAD binding. These match the
/// protocol field names (`sudoPassword`, `totpSecret`), not the storage
/// keys (`sudoPasswordEnc`, `totpSecretEnc`).
pub const FIELD_SUDO_PASSWORD: &str = "sudoPassword";
pub const FIELD_TOTP_SECRET: &str = "totpSecret";

/// Where the DEK lives. Serialized into the store envelope header
/// (`crypto.storage`) so reloads resolve the same provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStorage {
    Keychain,
    Keyfile,
}

impl KeyStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyStorage::Keychain => "keychain",
            KeyStorage::Keyfile => "keyfile",
        }
    }

    pub fn parse(value: &str) -> Option<KeyStorage> {
        match value {
            "keychain" => Some(KeyStorage::Keychain),
            "keyfile" => Some(KeyStorage::Keyfile),
            _ => None,
        }
    }
}

/// Supplies the DEK. Implementations persist the key themselves (keychain
/// entry or 0600 keyfile) and must hand back the same key across restarts —
/// a lost key degrades every stored secret to empty (the store structure
/// survives), never breaks the workbench.
pub trait KeyProvider {
    /// The storage tier this provider represents (recorded in the envelope).
    fn storage(&self) -> KeyStorage;
    /// Loads the DEK, generating and persisting a fresh one when absent.
    fn dek(&self) -> Result<Zeroizing<[u8; DEK_LEN]>, String>;
}

/// Memoized DEK resolution outcome: `Err(())` records "the keychain refused
/// (dialog denied / unavailable)" so later calls reuse the degraded answer
/// instead of re-prompting.
type CachedDek = Result<Zeroizing<[u8; DEK_LEN]>, ()>;

/// Process-wide memo of the keychain DEK resolution. The macOS keychain may
/// raise an authorization dialog per (binary, item) access, so caching the
/// outcome bounds the prompt to at most one per sidecar process (the
/// workbench and the stdio `--mcp` process each get their own). Only the
/// keychain is cached: the keyfile is a cheap per-path read and tests rely
/// on per-path isolation.
static KEYCHAIN_DEK: OnceLock<Mutex<Option<CachedDek>>> = OnceLock::new();

/// DEK hosted in the OS keychain. First use mints a random DEK and stores it.
/// Resolution is memoized per process (see [`KEYCHAIN_DEK`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct KeychainProvider;

impl KeyProvider for KeychainProvider {
    fn storage(&self) -> KeyStorage {
        KeyStorage::Keychain
    }

    fn dek(&self) -> Result<Zeroizing<[u8; DEK_LEN]>, String> {
        let cache = KEYCHAIN_DEK.get_or_init(|| Mutex::new(None));
        let mut guard = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cached) = guard.as_ref() {
            return cached
                .clone()
                .map_err(|()| "Keychain vault DEK unavailable (cached failure)".to_string());
        }
        let resolved = resolve_keychain_dek();
        *guard = Some(resolved.clone().map_err(|_| ()));
        resolved
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn resolve_keychain_dek() -> Result<Zeroizing<[u8; DEK_LEN]>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("Failed to open keychain entry: {error}"))?;
    match entry.get_password() {
        Ok(value) => {
            decode_dek(&value).ok_or_else(|| "Keychain vault DEK is malformed".to_string())
        }
        // First use: mint a random DEK and hand it to the keychain.
        Err(keyring::Error::NoEntry) => {
            let dek = random_dek();
            entry
                .set_password(&encode_dek(&dek[..]))
                .map_err(|error| format!("Failed to store vault DEK in keychain: {error}"))?;
            Ok(dek)
        }
        Err(error) => Err(format!("Failed to read vault DEK from keychain: {error}")),
    }
}

/// No native keychain crate on this platform (the Linux secret-service
/// backend pulls libdbus, absent in store build containers and on headless
/// servers): an explicit keychain opt-in degrades to empty-secret mode per
/// the "secrets may be lost, the store must not break" policy.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn resolve_keychain_dek() -> Result<Zeroizing<[u8; DEK_LEN]>, String> {
    Err(
        "OS keychain tier is unavailable on this platform; the keyfile tier is used instead"
            .to_string(),
    )
}

/// Best-effort removal of the keychain DEK entry after a successful
/// keychain → keyfile migration. Only called when the keychain was readable
/// this process, so the ACL grants cleanup; a denied delete is not fatal —
/// the orphaned entry is harmless.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn delete_keychain_dek() {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => {
            if let Err(error) = entry.delete_credential() {
                eprintln!("[ssh] failed to delete migrated keychain vault DEK: {error}");
            }
        }
        Err(error) => eprintln!("[ssh] failed to open keychain entry for cleanup: {error}"),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn delete_keychain_dek() {}

/// DEK stored in `<data_dir>/vault.key` (0600): the fallback tier for hosts
/// without a usable keychain. Anti-copy / backup-exfiltration grade only.
#[derive(Debug, Clone)]
pub struct KeyfileProvider {
    path: PathBuf,
}

impl KeyfileProvider {
    pub fn new(path: PathBuf) -> KeyfileProvider {
        KeyfileProvider { path }
    }

    fn write_key(
        &self,
        dek: &Zeroizing<[u8; DEK_LEN]>,
    ) -> Result<Zeroizing<[u8; DEK_LEN]>, String> {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("key.tmp");
        std::fs::write(&tmp, encode_dek(&dek[..]))
            .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.path)
            .map_err(|error| format!("Failed to write {}: {error}", self.path.display()))?;
        Ok(dek.clone())
    }
}

impl KeyProvider for KeyfileProvider {
    fn storage(&self) -> KeyStorage {
        KeyStorage::Keyfile
    }

    fn dek(&self) -> Result<Zeroizing<[u8; DEK_LEN]>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => match decode_dek(text.trim()) {
                Some(dek) => Ok(dek),
                // A malformed keyfile means the old DEK is unrecoverable;
                // mint a fresh one so newly saved secrets keep working.
                None => self.write_key(&random_dek()),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.write_key(&random_dek())
            }
            Err(error) => Err(format!("Failed to read {}: {error}", self.path.display())),
        }
    }
}

/// Resolves the DEK provider. A named tier (from the envelope header) is
/// used exclusively. Without one (first write) the 0600 keyfile is the
/// default tier; the keychain requires an explicit opt-in via
/// `DBX_SSH_VAULT_STORAGE=keychain` (it would otherwise re-prompt for
/// authorization on every sidecar binary change). Provider failures later in
/// the pipeline degrade to empty secrets instead of failing the caller.
pub fn resolve_provider(storage: Option<KeyStorage>, data_dir: &Path) -> Box<dyn KeyProvider> {
    match storage {
        Some(KeyStorage::Keychain) => Box::new(KeychainProvider),
        Some(KeyStorage::Keyfile) => Box::new(KeyfileProvider::new(keyfile_path(data_dir))),
        None => match env_storage_override() {
            Some(KeyStorage::Keychain) => Box::new(KeychainProvider),
            _ => Box::new(KeyfileProvider::new(keyfile_path(data_dir))),
        },
    }
}

/// Creation-time tier override for operators who prefer the OS keychain and
/// accept its per-update authorization dialog. Unset (or any non-`keychain`
/// value) keeps the keyfile default.
fn env_storage_override() -> Option<KeyStorage> {
    std::env::var("DBX_SSH_VAULT_STORAGE")
        .ok()
        .and_then(|value| KeyStorage::parse(value.trim()))
}

pub fn keyfile_path(data_dir: &Path) -> PathBuf {
    data_dir.join(KEYFILE_NAME)
}

/// Field-level AEAD facade over one resolved DEK. Every operation degrades
/// to "" on failure (missing DEK, tampered ciphertext, key loss) per the
/// "secrets may be lost, the store must not break" policy, so callers never
/// branch on encryption errors.
pub struct Vault {
    dek: Option<Zeroizing<[u8; DEK_LEN]>>,
    storage: KeyStorage,
}

impl Vault {
    /// Resolves the DEK once; a provider failure is logged and the vault
    /// degrades to empty-secret mode.
    pub fn new(provider: &dyn KeyProvider) -> Vault {
        match provider.dek() {
            Ok(dek) => Vault {
                dek: Some(dek),
                storage: provider.storage(),
            },
            Err(error) => {
                eprintln!("[ssh] vault DEK unavailable, stored secrets degrade to empty: {error}");
                Vault {
                    dek: None,
                    storage: provider.storage(),
                }
            }
        }
    }

    /// Storage tier to record in the envelope header (`crypto.storage`).
    pub fn storage(&self) -> KeyStorage {
        self.storage
    }

    /// Seals `plaintext` into `base64(nonce‖ct)` bound to
    /// `"<field>|<profileId>"`. Empty plaintext stays an empty string
    /// (unencrypted), and failures degrade to "".
    pub fn seal(&self, field: &str, profile_id: &str, plaintext: &str) -> String {
        let Some(dek) = self.dek.as_ref() else {
            return String::new();
        };
        if plaintext.is_empty() {
            return String::new();
        }
        seal(dek, field, profile_id, plaintext).unwrap_or_else(|error| {
            eprintln!("[ssh] failed to seal vault field {field}: {error}");
            String::new()
        })
    }

    /// Opens an envelope produced by `seal`; any failure (wrong key, tampered
    /// ciphertext, cross-field/cross-profile transplant) degrades to "".
    pub fn open(&self, field: &str, profile_id: &str, envelope: &str) -> String {
        let Some(dek) = self.dek.as_ref() else {
            return String::new();
        };
        if envelope.is_empty() {
            return String::new();
        }
        open(dek, field, profile_id, envelope).unwrap_or_default()
    }
}

/// AAD binding: ciphertext is pinned to its field and profile.
fn aad(field: &str, profile_id: &str) -> String {
    format!("{field}|{profile_id}")
}

fn seal(
    dek: &[u8; DEK_LEN],
    field: &str,
    profile_id: &str,
    plaintext: &str,
) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|error| format!("Failed to initialize vault cipher: {error}"))?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad(field, profile_id).as_bytes(),
            },
        )
        .map_err(|error| format!("Failed to seal vault field: {error}"))?;
    let mut envelope = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ciphertext);
    Ok(BASE64_STANDARD.encode(envelope))
}

fn open(
    dek: &[u8; DEK_LEN],
    field: &str,
    profile_id: &str,
    envelope: &str,
) -> Result<String, String> {
    let raw = BASE64_STANDARD
        .decode(envelope)
        .map_err(|error| format!("Failed to decode vault envelope: {error}"))?;
    if raw.len() <= NONCE_LEN {
        return Err("Vault envelope is too short".to_string());
    }
    let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(dek)
        .map_err(|error| format!("Failed to initialize vault cipher: {error}"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: ciphertext,
                aad: aad(field, profile_id).as_bytes(),
            },
        )
        .map_err(|_| "Vault envelope failed authentication".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "Vault plaintext is not valid UTF-8".to_string())
}

fn random_dek() -> Zeroizing<[u8; DEK_LEN]> {
    let mut dek = Zeroizing::new([0u8; DEK_LEN]);
    OsRng.fill_bytes(dek.as_mut());
    dek
}

fn encode_dek(dek: &[u8]) -> String {
    BASE64_STANDARD.encode(dek)
}

fn decode_dek(value: &str) -> Option<Zeroizing<[u8; DEK_LEN]>> {
    let raw = BASE64_STANDARD.decode(value.trim()).ok()?;
    let bytes: [u8; DEK_LEN] = raw.try_into().ok()?;
    Some(Zeroizing::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn seal_open_roundtrips_with_keyfile_provider() {
        let dir = temp_dir();
        let vault = Vault::new(&KeyfileProvider::new(keyfile_path(&dir)));
        let envelope = vault.seal(FIELD_SUDO_PASSWORD, "p1", "s3cret");
        assert!(!envelope.is_empty());
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p1", &envelope), "s3cret");
        // Every seal uses a fresh nonce, so envelopes differ across calls.
        let again = vault.seal(FIELD_SUDO_PASSWORD, "p1", "s3cret");
        assert_ne!(envelope, again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aad_blocks_cross_field_and_cross_profile_transplant() {
        let dir = temp_dir();
        let vault = Vault::new(&KeyfileProvider::new(keyfile_path(&dir)));
        let envelope = vault.seal(FIELD_SUDO_PASSWORD, "p1", "s3cret");
        // The same ciphertext under another field or profile must not open.
        assert_eq!(vault.open(FIELD_TOTP_SECRET, "p1", &envelope), "");
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p2", &envelope), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_envelope_degrades_to_empty() {
        let dir = temp_dir();
        let vault = Vault::new(&KeyfileProvider::new(keyfile_path(&dir)));
        let envelope = vault.seal(FIELD_SUDO_PASSWORD, "p1", "s3cret");
        // Corrupt one payload byte (flip the last base64 char).
        let mut tampered = envelope.clone();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p1", &tampered), "");
        // Garbage input degrades the same way instead of panicking.
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p1", "not base64!"), "");
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p1", "AAAA"), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_loss_degrades_to_empty_without_panicking() {
        let dir = temp_dir();
        let vault = Vault::new(&KeyfileProvider::new(keyfile_path(&dir)));
        let envelope = vault.seal(FIELD_SUDO_PASSWORD, "p1", "s3cret");
        // A vault resolved against a different DEK simulates a lost key.
        let lost = Vault::new(&KeyfileProvider::new(dir.join("other.key")));
        assert_eq!(lost.open(FIELD_SUDO_PASSWORD, "p1", &envelope), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keyfile_provider_persists_the_same_dek_with_0600() {
        let dir = temp_dir();
        let provider = KeyfileProvider::new(keyfile_path(&dir));
        let first = provider.dek().unwrap();
        let second = provider.dek().unwrap();
        assert_eq!(*first, *second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(keyfile_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_keyfile_self_heals_with_a_fresh_dek() {
        let dir = temp_dir();
        let path = keyfile_path(&dir);
        std::fs::write(&path, "definitely not a key").unwrap();
        let provider = KeyfileProvider::new(path.clone());
        let dek = provider.dek().unwrap();
        // The healed key round-trips on the next load.
        assert_eq!(*provider.dek().unwrap(), *dek);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_plaintext_stays_empty_without_envelope() {
        let dir = temp_dir();
        let vault = Vault::new(&KeyfileProvider::new(keyfile_path(&dir)));
        assert_eq!(vault.seal(FIELD_SUDO_PASSWORD, "p1", ""), "");
        assert_eq!(vault.open(FIELD_SUDO_PASSWORD, "p1", ""), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_storage_names_round_trip() {
        assert_eq!(KeyStorage::parse("keychain"), Some(KeyStorage::Keychain));
        assert_eq!(KeyStorage::parse("keyfile"), Some(KeyStorage::Keyfile));
        assert_eq!(KeyStorage::parse("other"), None);
        assert_eq!(KeyStorage::Keychain.as_str(), "keychain");
        assert_eq!(KeyStorage::Keyfile.as_str(), "keyfile");
    }

    #[test]
    fn resolve_provider_defaults_to_keyfile_without_a_header() {
        let dir = temp_dir();
        // No envelope header and no override: the keyfile tier must be the
        // default so a fresh install never touches the OS keychain (which
        // would raise an authorization dialog).
        let provider = resolve_provider(None, &dir);
        assert_eq!(provider.storage(), KeyStorage::Keyfile);
        let explicit = resolve_provider(Some(KeyStorage::Keyfile), &dir);
        assert_eq!(explicit.storage(), KeyStorage::Keyfile);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
