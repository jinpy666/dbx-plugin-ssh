use std::io;
use std::path::PathBuf;

use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};
use russh::keys::ssh_key::PublicKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyState {
    Trusted,
    Unknown,
}

/// One entry of the plugin's known_hosts store, in OpenSSH wire layout.
/// `marker` carries the OpenSSH marker of `@cert-authority` / `@revoked`
/// lines (the token before the host field); plain entries have `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHostEntry {
    pub host_field: String,
    pub key_type: String,
    pub fingerprint: String,
    pub comment: String,
    pub marker: Option<String>,
}

pub struct HostKeyVerifier {
    known_hosts_path: PathBuf,
}

/// OpenSSH marker tokens that precede the host field on a known_hosts line.
const KNOWN_HOSTS_MARKERS: [&str; 2] = ["@cert-authority", "@revoked"];

/// Lines longer than this are treated as corrupt and skipped: a real
/// known_hosts line (marker + host + key + comment) stays far below, while a
/// megabyte-sized junk line must not be parsed, listed, or rewritten.
const MAX_KNOWN_HOSTS_LINE_LEN: usize = 8192;

fn is_known_hosts_marker(token: &str) -> bool {
    KNOWN_HOSTS_MARKERS.contains(&token)
}

/// Splits one known_hosts line into `(marker, host_field)`; `marker` is
/// `Some` only for genuine `@cert-authority` / `@revoked` lines. Returns
/// `None` for blank/comment lines, corrupt marker fragments, and overlong
/// junk lines.
fn split_known_hosts_line(line: &str) -> Option<(Option<String>, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.len() > MAX_KNOWN_HOSTS_LINE_LEN {
        return None;
    }
    let mut parts = line.split_whitespace();
    let first_token = parts.next()?;
    let (marker, host_field) = if is_known_hosts_marker(first_token) {
        let host_field = parts.next()?;
        (Some(first_token.to_string()), host_field)
    } else {
        (None, first_token)
    };
    if host_field.starts_with('@') || host_field == "|" {
        // Stray marker/hashed fragments without a host field are unusable.
        return None;
    }
    Some((marker, host_field.to_string()))
}

impl HostKeyVerifier {
    pub fn new(known_hosts_path: PathBuf) -> Self {
        Self { known_hosts_path }
    }

    /// Lists the entries of the plugin's own known_hosts store (the system
    /// ~/.ssh/known_hosts stays read-only).
    pub fn list_known_hosts(&self) -> Result<Vec<KnownHostEntry>, String> {
        let content = match std::fs::read_to_string(&self.known_hosts_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!(
                    "Failed to read {}: {error}",
                    self.known_hosts_path.display()
                ))
            }
        };
        let mut entries = Vec::new();
        for line in content.lines() {
            let Some((marker, host_field)) = split_known_hosts_line(line) else {
                continue;
            };
            let mut parts = line.split_whitespace();
            // Skip the marker (if any) and the host field; the remainder is
            // key type, key data, and the optional comment.
            let skip = usize::from(marker.is_some()) + 1;
            for _ in 0..skip {
                parts.next();
            }
            let (Some(key_type), Some(key_data)) = (parts.next(), parts.next()) else {
                continue;
            };
            let comment = parts.collect::<Vec<_>>().join(" ");
            let fingerprint = PublicKey::from_openssh(&format!("{key_type} {key_data}"))
                .ok()
                .map(|key| {
                    key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                        .to_string()
                })
                .unwrap_or_default();
            entries.push(KnownHostEntry {
                host_field,
                key_type: key_type.to_string(),
                fingerprint,
                comment,
                marker,
            });
        }
        Ok(entries)
    }

    /// Removes entries matching `host:port` (or bare `host` for port 22)
    /// from the plugin's known_hosts store. Returns how many lines were
    /// removed; a changed key record disappears with the same match.
    pub fn remove_known_host(&self, host: &str, port: u16) -> Result<usize, String> {
        let content = match std::fs::read_to_string(&self.known_hosts_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
            Err(error) => {
                return Err(format!(
                    "Failed to read {}: {error}",
                    self.known_hosts_path.display()
                ))
            }
        };
        let patterns = if port == 22 {
            [host.to_string(), format!("[{host}]:22")]
        } else {
            [format!("[{host}]:{port}"), String::new()]
        };
        let mut kept = Vec::new();
        let mut removed = 0_usize;
        for line in content.lines() {
            // Overlong/corrupt lines are never matched: they stay in the file
            // untouched instead of being removed by an accidental pattern hit.
            if line.len() > MAX_KNOWN_HOSTS_LINE_LEN {
                kept.push(line);
                continue;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                kept.push(line);
                continue;
            }
            let mut tokens = trimmed.split_whitespace();
            let first = tokens.next().unwrap_or_default();
            // Only genuine OpenSSH markers move the host into the second
            // token; any other leading token is treated as the host itself.
            let host_token = if is_known_hosts_marker(first) {
                tokens.next().unwrap_or_default()
            } else {
                first
            };
            if patterns
                .iter()
                .any(|pattern| !pattern.is_empty() && host_token == pattern)
            {
                removed += 1;
                continue;
            }
            kept.push(line);
        }
        if removed == 0 {
            return Ok(0);
        }
        let mut output = kept.join("\n");
        if !output.is_empty() {
            output.push('\n');
        }
        std::fs::write(&self.known_hosts_path, output).map_err(|error| {
            format!(
                "Failed to write {}: {error}",
                self.known_hosts_path.display()
            )
        })?;
        Ok(removed)
    }

    pub fn check(&self, host: &str, port: u16, key: &PublicKey) -> Result<HostKeyState, io::Error> {
        let system = system_known_hosts_path()
            .map(|path| check_known_hosts_file(host, port, key, &path))
            .transpose()?
            .unwrap_or(HostKeyState::Unknown);
        // Always evaluate both stores. A changed key in either store must win
        // over a matching entry in the other store.
        let plugin = check_known_hosts_file(host, port, key, &self.known_hosts_path)?;
        Ok(
            if system == HostKeyState::Trusted || plugin == HostKeyState::Trusted {
                HostKeyState::Trusted
            } else {
                HostKeyState::Unknown
            },
        )
    }

    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), io::Error> {
        if let Some(parent) = self.known_hosts_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        learn_known_hosts_path(host, port, key, &self.known_hosts_path).map_err(|error| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "Failed to persist host key for {host}:{port} to {}: {error}",
                    self.known_hosts_path.display()
                ),
            )
        })
    }
}

fn check_known_hosts_file(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &std::path::Path,
) -> Result<HostKeyState, io::Error> {
    match path.try_exists() {
        Ok(false) => return Ok(HostKeyState::Unknown),
        Ok(true) => {}
        Err(error) => return Err(error),
    }
    // russh treats every File::open failure as an empty known_hosts file. Probe
    // readability first so permission and I/O failures cannot silently disable
    // host-key verification.
    std::fs::File::open(path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Failed to read known_hosts file {}: {error}",
                path.display()
            ),
        )
    })?;
    match check_known_hosts_path(host, port, key, path) {
        Ok(true) => Ok(HostKeyState::Trusted),
        Err(russh::keys::Error::KeyChanged { line }) => Err(host_key_changed_error(
            host,
            port,
            line,
            &path.display().to_string(),
        )),
        Ok(false) => Ok(HostKeyState::Unknown),
        Err(error) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Failed to parse known_hosts file {}: {error}",
                path.display()
            ),
        )),
    }
}

fn system_known_hosts_path() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

fn host_key_changed_error(host: &str, port: u16, line: usize, store: &str) -> io::Error {
    io::Error::other(format!(
        "Host key for {host}:{port} changed (recorded at {store}, line {line}). This may indicate a man-in-the-middle attack."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_key_message_names_the_identity() {
        let message = host_key_changed_error("example.test", 2222, 4, "known_hosts").to_string();
        assert!(message.contains("example.test:2222"));
        assert!(message.contains("line 4"));
    }

    #[test]
    fn lists_and_removes_known_host_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        // ed25519 public key in openssh layout; host fields cover port forms.
        let key_line =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz test-key";
        std::fs::write(
            &path,
            format!(
                "# comment\nexample.test {key_line}\n[example.test]:2222 {key_line}\nother.test {key_line}\n"
            ),
        )
        .unwrap();

        let verifier = HostKeyVerifier::new(path.clone());
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].host_field, "example.test");
        assert_eq!(entries[0].comment, "test-key");
        assert!(entries[0].fingerprint.starts_with("SHA256:") || entries[0].fingerprint.is_empty());

        // Removing port 22 drops both canonical forms of that port only.
        let removed = verifier.remove_known_host("example.test", 22).unwrap();
        assert_eq!(removed, 1);
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host_field, "[example.test]:2222");

        let removed = verifier.remove_known_host("example.test", 2222).unwrap();
        assert_eq!(removed, 1);
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(
            entries,
            vec![KnownHostEntry {
                host_field: "other.test".to_string(),
                key_type: "ssh-ed25519".to_string(),
                fingerprint: entries[0].fingerprint.clone(),
                comment: "test-key".to_string(),
                marker: None,
            }]
        );

        // Removing a missing host is not an error.
        assert_eq!(verifier.remove_known_host("missing.test", 22).unwrap(), 0);
    }

    #[test]
    fn lists_and_removes_marker_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        let key_line =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz ca-key";
        std::fs::write(
            &path,
            format!(
                "@cert-authority *.prod.example {key_line}\n@revoked evil.test {key_line}\nplain.test {key_line}\n"
            ),
        )
        .unwrap();

        let verifier = HostKeyVerifier::new(path.clone());
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].marker.as_deref(), Some("@cert-authority"));
        assert_eq!(entries[0].host_field, "*.prod.example");
        assert_eq!(entries[1].marker.as_deref(), Some("@revoked"));
        assert_eq!(entries[1].host_field, "evil.test");
        assert_eq!(entries[2].marker, None);
        assert_eq!(entries[2].host_field, "plain.test");
        assert!(entries.iter().all(|entry| entry.key_type == "ssh-ed25519"));

        // Removal matches the host token of marked lines, not the marker.
        let removed = verifier.remove_known_host("evil.test", 22).unwrap();
        assert_eq!(removed, 1);
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.host_field != "evil.test"));

        // Wildcard CA entries are only removed by their literal host field.
        let removed = verifier.remove_known_host("*.prod.example", 22).unwrap();
        assert_eq!(removed, 1);
        let entries = verifier.list_known_hosts().unwrap();
        assert_eq!(
            entries,
            vec![KnownHostEntry {
                host_field: "plain.test".to_string(),
                key_type: "ssh-ed25519".to_string(),
                fingerprint: entries[0].fingerprint.clone(),
                comment: "ca-key".to_string(),
                marker: None,
            }]
        );
    }

    #[test]
    fn listing_missing_store_is_empty() {
        let directory = tempfile::tempdir().unwrap();
        let verifier = HostKeyVerifier::new(directory.path().join("known_hosts"));
        assert!(verifier.list_known_hosts().unwrap().is_empty());
    }

    #[test]
    fn listing_survives_adversarial_known_hosts_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        let key_line =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz ok";
        // Hashed hostname entry (OpenSSH privacy form), CRLF endings, blank
        // lines, comments, a line with an unparseable key, a bare marker, a
        // stray marker fragment, a keyless host line, and one megabyte-scale
        // junk line — the listing must tolerate all of them without
        // panicking and without listing the junk.
        let junk_line = format!("junk.test {}", "A".repeat(1024 * 1024));
        let content = format!(
            "|1|c2FsdA==|aGFzaA== {key_line}\r\n\
             # leading comment\n\
             \n   \n\
             plain.test {key_line} trailing comment here\n\
             garbage.test ssh-ed25519 not-a-valid-key ssh-ed25519 also-broken\n\
             @cert-authority\n\
             @revoked @broken\n\
             broken.test\n\
             {junk_line}\r\n"
        );
        std::fs::write(&path, &content).unwrap();

        let verifier = HostKeyVerifier::new(path.clone());
        let entries = verifier.list_known_hosts().unwrap();
        let hosts: Vec<&str> = entries
            .iter()
            .map(|entry| entry.host_field.as_str())
            .collect();
        // Hashed entries stay visible; the line with an unparseable key is
        // still listed (with an empty fingerprint) so the store stays
        // inspectable, while junk/malformed lines are skipped entirely.
        assert_eq!(
            hosts,
            vec!["|1|c2FsdA==|aGFzaA==", "plain.test", "garbage.test"]
        );
        assert_eq!(entries[1].comment, "ok trailing comment here");
        assert!(entries[2].fingerprint.is_empty());

        // Removal must not delete the hashed entry, comments, unparseable or
        // junk lines while removing the plain entry.
        let removed = verifier.remove_known_host("plain.test", 22).unwrap();
        assert_eq!(removed, 1);
        let remaining = std::fs::read_to_string(&path).unwrap();
        assert!(remaining.contains("|1|c2FsdA==|aGFzaA=="));
        assert!(remaining.contains("# leading comment"));
        assert!(remaining.contains("@cert-authority"));
        assert!(remaining.contains(&junk_line));
        assert!(remaining.contains("garbage.test"));
        assert!(!remaining.contains("plain.test"));
    }

    #[test]
    fn removal_ignores_nonstandard_marker_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        let key_line =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz x";
        std::fs::write(
            &path,
            format!("@unknownmarker plain.test {key_line}\nplain.test {key_line}\n"),
        )
        .unwrap();

        let verifier = HostKeyVerifier::new(path.clone());
        // Only OpenSSH markers put the host in the second token; a fake
        // marker line is matched on its literal first token, so removing
        // "plain.test" must drop exactly one line.
        let removed = verifier.remove_known_host("plain.test", 22).unwrap();
        assert_eq!(removed, 1);
        let remaining = std::fs::read_to_string(&path).unwrap();
        assert!(remaining.contains("@unknownmarker"));
        // The fake-marker line stays in the file but is not listable (its
        // host field looks like a stray marker fragment).
        assert!(verifier.list_known_hosts().unwrap().is_empty());
    }
}
