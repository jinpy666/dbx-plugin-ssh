//! Production misoperation guards for the MCP exec tools.
//!
//! Every `ssh_exec` / `ssh_exec_sudo` command is classified before it is
//! executed:
//!
//! - [`CommandRisk::ReadOnly`] — provably read-only (inspection verbs such as
//!   `ls`, `df`, `systemctl status`). The only class allowed through the
//!   read-only connection gate.
//! - [`CommandRisk::Destructive`] — matches a known catastrophic pattern
//!   (disk formatting, recursive deletes of system roots, shutdown, raw
//!   device writes, ...). Refused outright on read-only connections and
//!   requires `confirmDestructive: true` everywhere else.
//! - [`CommandRisk::Unknown`] — everything else. Allowed on normal
//!   connections, refused on read-only ones (whitelist, not blacklist:
//!   unrecognized means unproven).
//!
//! The classifier is deliberately conservative: quoted strings are not
//! parsed (a `;` inside quotes still splits segments, which can only
//! downgrade `ReadOnly` to `Unknown`, never upgrade), command substitution
//! and output redirection force `Unknown`, and privileged/wrapper prefixes
//! are unwrapped before the inner command is assessed.

/// Classification of one shell command under the safety gates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandRisk {
    /// Provably read-only; allowed on read-only connections.
    ReadOnly,
    /// Matches a catastrophic pattern; carries a human-readable reason.
    Destructive(&'static str),
    /// Not provably read-only and not a known pattern; refused on
    /// read-only connections, allowed (unconfirmed) elsewhere.
    Unknown,
}

/// Classifies a full command line (which may chain several commands).
pub fn assess_command(command: &str) -> CommandRisk {
    assess_command_depth(command, 0)
}

/// Depth cap for nested substitution scanning so pathological input cannot
/// recurse unboundedly (`$( $( $( …`.
const MAX_ASSESS_DEPTH: u8 = 4;

/// Escalates to Destructive when the inner command of a wrapper (`sudo …`,
/// `sh -c '…'`) classifies as destructive at the next recursion depth.
/// Escalation only: anything else keeps the caller's own verdict.
fn destructive_after_wrap(inner: &str, depth: u8) -> Option<&'static str> {
    let next = depth + 1;
    if next >= MAX_ASSESS_DEPTH {
        return None;
    }
    match assess_command_depth(inner, next) {
        CommandRisk::Destructive(reason) => Some(reason),
        _ => None,
    }
}

fn assess_command_depth(command: &str, depth: u8) -> CommandRisk {
    let neutralized = neutralize_fd_dups(command);
    // Reliability round 5 (adversarial sweep): a catastrophic payload
    // hidden inside `$(...)` / backticks must still trip the destructive
    // gate even though the surrounding command looks benign —
    // `echo $(rm -rf /)` used to classify as a plain `Unknown` and run
    // unconfirmed on writable connections. The sweep only ever escalates
    // Unknown → Destructive; it can never whitelist anything.
    if depth < MAX_ASSESS_DEPTH {
        if let Some(reason) = hidden_destructive_subcommand(&neutralized, depth) {
            return CommandRisk::Destructive(reason);
        }
    }
    let mut overall = CommandRisk::ReadOnly;
    for segment in split_segments(&neutralized) {
        match assess_segment(segment, depth) {
            CommandRisk::Destructive(reason) => return CommandRisk::Destructive(reason),
            CommandRisk::Unknown => overall = CommandRisk::Unknown,
            CommandRisk::ReadOnly => {}
        }
    }
    overall
}

/// Assesses the texts of every `$( ... )` / `` ` ... ` `` span: when any
/// span's content classifies as destructive, the whole command is
/// destructive.
fn hidden_destructive_subcommand(text: &str, depth: u8) -> Option<&'static str> {
    for sub in substitution_spans(text) {
        for segment in split_segments(&sub) {
            if let CommandRisk::Destructive(reason) = assess_command_depth(segment, depth + 1) {
                return Some(reason);
            }
        }
    }
    None
}

/// Collects the texts of `$( … )` spans (nesting-aware) and `` ` … ` ``
/// spans. Unterminated spans keep their remainder (fail closed: an
/// unterminated `` `rm -rf /`` still trips the sweep).
fn substitution_spans(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'$' if bytes.get(index + 1) == Some(&b'(') => {
                let mut parens = 1usize;
                let mut cursor = index + 2;
                while cursor < bytes.len() && parens > 0 {
                    match bytes[cursor] {
                        b'(' => parens += 1,
                        b')' => parens -= 1,
                        _ => {}
                    }
                    cursor += 1;
                }
                let end = if parens == 0 { cursor - 1 } else { cursor };
                spans.push(text[index + 2..end].to_string());
                index = cursor;
            }
            b'`' => {
                let start = index + 1;
                match text[start..].find('`') {
                    Some(offset) => {
                        spans.push(text[start..start + offset].to_string());
                        index = start + offset + 1;
                    }
                    None => {
                        spans.push(text[start..].to_string());
                        index = bytes.len();
                    }
                }
            }
            _ => index += 1,
        }
    }
    spans
}

/// True when any top-level command segment runs under `sudo` (after the same
/// env-prefix / wrapper unwrapping the classifier applies). Agent terminal
/// mode treats these as privilege escalation regardless of the inner verb,
/// so teaching-mode approval covers inline `sudo …`, not just `ssh_exec_sudo`.
pub fn runs_under_sudo(command: &str) -> bool {
    let neutralized = neutralize_fd_dups(command);
    split_segments(&neutralized)
        .iter()
        .any(|segment| effective_tokens(segment).first().map(String::as_str) == Some("sudo"))
}

/// Byte ceiling for one `ssh_terminal_input` payload after normalization.
pub const MAX_TERMINAL_INPUT_BYTES: usize = 8 * 1024;

/// Normalizes terminal input for injection (IMPL_PLAN §1.2): `\r\n` and
/// `\n` fold to `\r` (the Enter an interactive shell expects), NUL bytes
/// are stripped, and the result is capped at 8 KiB on a char boundary.
pub fn normalize_terminal_input(input: &str) -> String {
    let mut normalized = String::with_capacity(input.len().min(MAX_TERMINAL_INPUT_BYTES + 4));
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                // Fold CRLF to a single CR.
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                normalized.push('\r');
            }
            '\n' => normalized.push('\r'),
            '\0' => {}
            other => normalized.push(other),
        }
        if normalized.len() >= MAX_TERMINAL_INPUT_BYTES {
            break;
        }
    }
    if normalized.len() > MAX_TERMINAL_INPUT_BYTES {
        let mut end = MAX_TERMINAL_INPUT_BYTES;
        while !normalized.is_char_boundary(end) {
            end -= 1;
        }
        normalized.truncate(end);
    }
    normalized
}

/// True when every character of the input is a control character: pure
/// control sequences (Enter, Ctrl+C, escape runs) carry no shell-visible
/// text, so they are the only input a read-only connection accepts
/// (IMPL_PLAN §1.2 ①).
pub fn is_control_only_input(input: &str) -> bool {
    input.chars().all(char::is_control)
}

/// Assesses terminal input by its worst `\r`-delimited line: each line is
/// classified like a shell command and the highest risk wins. Destructive
/// short-circuits; an empty (pure-control) input is read-only.
pub fn assess_terminal_input(input: &str) -> CommandRisk {
    let mut overall = CommandRisk::ReadOnly;
    for line in input.split('\r') {
        if line.trim().is_empty() {
            continue;
        }
        match assess_command(line) {
            CommandRisk::Destructive(reason) => return CommandRisk::Destructive(reason),
            CommandRisk::Unknown => overall = CommandRisk::Unknown,
            CommandRisk::ReadOnly => {}
        }
    }
    overall
}

/// Replaces fd duplications (`2>&1`, `1>&2`, ...) with a neutral token so
/// the `&` splitter does not shred them; they duplicate fds, not files.
fn neutralize_fd_dups(command: &str) -> String {
    command
        .replace("2>&1", " FDDUP ")
        .replace("1>&2", " FDDUP ")
        .replace("2>&2", " FDDUP ")
        .replace("1>&1", " FDDUP ")
        .replace(">&1", " FDDUP ")
        .replace(">&2", " FDDUP ")
}

/// Splits a command line into pipeline/chain segments. Naive on purpose:
/// quote contents are not parsed, and a split inside quotes can only make
/// the assessment more conservative.
fn split_segments(command: &str) -> Vec<&str> {
    command
        .split([';', '|', '\n', '&'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Verbs that are read-only in every argument shape.
const READ_ONLY_VERBS: &[&str] = &[
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "egrep",
    "fgrep",
    "rg",
    "df",
    "du",
    "ps",
    "free",
    "uptime",
    "whoami",
    "id",
    "uname",
    "hostname",
    "w",
    "who",
    "last",
    "lastlog",
    "stat",
    "wc",
    "file",
    "cksum",
    "md5sum",
    "sha1sum",
    "sha256sum",
    "sha512sum",
    "echo",
    "printf",
    "date",
    "printenv",
    "which",
    "whereis",
    "type",
    "lsof",
    "ss",
    "netstat",
    "ping",
    "ping6",
    "traceroute",
    "tracepath",
    "nslookup",
    "dig",
    "host",
    "vmstat",
    "iostat",
    "sar",
    "mpstat",
    "dmesg",
    "lsblk",
    "lsmod",
    "lspci",
    "lsusb",
    "lsns",
    "lscpu",
    "nproc",
    "getent",
    "groups",
    "true",
    "false",
    "test",
    "[",
    "sleep",
    "history",
    "arch",
    "cut",
    "sort",
    "uniq",
    "tr",
    "column",
    "nl",
    "tac",
    "rev",
    "seq",
    "dirname",
    "basename",
    "readlink",
    "realpath",
    "pwd",
];

/// Verbs whose read-only-ness depends on the first subcommand.
const SUBCOMMAND_VERBS: &[(&str, &[&str])] = &[
    (
        "systemctl",
        &[
            "status",
            "list-units",
            "list-unit-files",
            "list-timers",
            "list-sockets",
            "list-dependencies",
            "list-jobs",
            "is-active",
            "is-enabled",
            "is-failed",
            "show",
            "cat",
            "help",
            "get-default",
        ],
    ),
    (
        "docker",
        &[
            "ps", "images", "stats", "version", "info", "logs", "inspect", "top", "port", "events",
            "search",
        ],
    ),
    // `git` has its own shape-sensitive rules: see `git_segment_risk`.
    (
        "kubectl",
        &[
            "get",
            "describe",
            "top",
            "logs",
            "version",
            "explain",
            "api-resources",
            "api-versions",
        ],
    ),
    (
        "ip",
        &[
            "addr", "a", "address", "l", "link", "route", "r", "rule", "neigh", "n",
        ],
    ),
];

/// git inspection subcommands; `branch`/`tag`/`remote`/`reflog` are further
/// narrowed to their listing shapes by [`git_segment_risk`].
const GIT_READ_SUBCOMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "blame",
    "describe",
    "rev-parse",
    "remote",
    "tag",
    "reflog",
];

/// Second-level `ip` object commands that mutate network state even though
/// the object itself (`route`, `link`, `addr`, …) inspects by default.
const MUTATING_OBJECT_COMMANDS: &[&str] = &[
    "add", "del", "delete", "flush", "set", "change", "replace", "append",
];

/// Narrowing rules for git subcommands that are read-only only in their
/// listing shapes.
fn git_segment_risk(args: &[String], sensitive: bool) -> CommandRisk {
    let Some(position) = args.iter().position(|arg| !arg.starts_with('-')) else {
        return CommandRisk::Unknown;
    };
    let sub = args[position].as_str();
    if !GIT_READ_SUBCOMMANDS.contains(&sub) {
        return CommandRisk::Unknown;
    }
    let rest = &args[position + 1..];
    let read_only = match sub {
        // `git branch [-a]` / `git tag [-l 'v*']` list; `git branch work`,
        // `git branch -D x`, `git tag v1`, `git tag -d v1` mutate.
        "branch" | "tag" => {
            rest.iter().any(|arg| arg == "-l" || arg == "--list")
                || rest.iter().all(|arg| arg.starts_with('-'))
        }
        // `git remote [-v]` lists; add/rename/remove/set-url/prune mutate.
        "remote" => !rest
            .first()
            .map(|arg| {
                matches!(
                    arg.as_str(),
                    "add"
                        | "rename"
                        | "remove"
                        | "rm"
                        | "set-url"
                        | "set-head"
                        | "prune"
                        | "update"
                )
            })
            .unwrap_or(false),
        // `git reflog [show]` reads; delete/expire rewrite history.
        "reflog" => rest.first().map(|arg| arg == "show").unwrap_or(true),
        _ => true,
    };
    if !read_only || sensitive {
        return CommandRisk::Unknown;
    }
    CommandRisk::ReadOnly
}

/// Command prefixes that merely wrap an inner command; unwrapped before the
/// real verb is assessed.
const WRAPPER_VERBS: &[&str] = &[
    "nohup", "timeout", "watch", "time", "nice", "ionice", "stdbuf", "env",
];

/// Wrapper flags that consume the following token as their value
/// (`nice -n 10`, `ionice -c 2`, `watch -n 1`).
const WRAPPER_VALUE_FLAGS: &[&str] = &["-n", "-c", "-p"];

/// Verbs that format or wipe raw disks / power the machine off.
const DESTRUCTIVE_VERBS: &[&str] = &[
    "mkfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.xfs",
    "mkfs.btrfs",
    "mkfs.vfat",
    "mkfs.fat",
    "mkswap",
    "fdisk",
    "sfdisk",
    "cfdisk",
    "gdisk",
    "sgdisk",
    "parted",
    "partprobe",
    "wipefs",
    "blkdiscard",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
];

/// SQL interpreters whose arguments may carry a DROP statement.
const SQL_VERBS: &[&str] = &["mysql", "mariadb", "psql", "sqlite3"];

/// System files whose overwrite or deletion is always catastrophic.
const CRITICAL_FILES: &[&str] = &[
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/fstab",
    "/boot/",
];

/// Directory components that hold credentials, key material, or cloud /
/// cluster identity. Any path reaching into them downgrades a whitelisted
/// inspection command to `Unknown`.
const SENSITIVE_COMPONENTS: &[&str] = &[".ssh", ".gnupg", ".aws", ".kube"];

/// File basenames that carry credentials or leak them via history.
const SENSITIVE_BASENAMES: &[&str] = &[
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".htpasswd",
    ".pgpass",
    ".my.cnf",
    "my.cnf",
    ".bash_history",
    ".zsh_history",
    ".sh_history",
    ".mysql_history",
    ".psql_history",
];

/// Extensions used by private keys / PKCS containers.
const SENSITIVE_EXTENSIONS: &[&str] = &[".pem", ".key", ".p12", ".pfx"];

/// System credential files (prefix match, so `shadow-` backups match too).
const SENSITIVE_SYSTEM_PREFIXES: &[&str] = &["/etc/shadow", "/etc/gshadow", "/etc/sudoers"];

/// Assesses one chain segment (no `;`/`&&`/`|` left inside).
fn assess_segment(segment: &str, depth: u8) -> CommandRisk {
    if segment.contains(":(){") {
        return CommandRisk::Destructive("fork bomb");
    }
    if segment.contains("$(") || segment.contains('`') {
        return CommandRisk::Unknown;
    }
    let tokens = effective_tokens(segment);
    let Some((verb, args)) = tokens.split_first() else {
        return CommandRisk::Unknown;
    };
    let verb = verb.as_str();

    if let Some(reason) = destructive_pattern(verb, args) {
        return CommandRisk::Destructive(reason);
    }
    if has_redirect(args) {
        // Redirection writes a file; only raw-device / critical targets are
        // destructive (checked inside destructive_pattern), everything else
        // is merely a write.
        return CommandRisk::Unknown;
    }
    if verb == "sudo" {
        // Privileged commands never count as whitelisted reads. Their
        // destructive shape still matters: unwrap the sudo prefix (flags
        // included) so `sudo rm -rf /` / `sudo -u root mkfs.ext4 …` trip
        // the catastrophic gate instead of slipping through as a plain
        // Unknown. Everything not destructive stays Unknown as before.
        if let Some(inner) = unwrap_sudo_prefix(&tokens) {
            let inner_text = inner.join(" ");
            let unwrapped = effective_tokens(&inner_text);
            if let Some((inner_verb, inner_args)) = unwrapped.split_first() {
                if let Some(reason) = destructive_pattern(inner_verb, inner_args) {
                    return CommandRisk::Destructive(reason);
                }
            }
            // `sudo sh -c 'rm -rf /'`: the inner command may itself be a
            // wrapper hiding the payload — recurse (destructive-only).
            if let Some(reason) = destructive_after_wrap(&inner_text, depth) {
                return CommandRisk::Destructive(reason);
            }
        }
        return CommandRisk::Unknown;
    }
    if matches!(verb, "sh" | "bash" | "dash" | "zsh" | "ksh") {
        // A `-c` script hides its payload in one string: assess the script
        // text so `sh -c 'rm -rf /'` trips the catastrophic gate. The
        // wrapper itself never whitelists anything — anything not
        // destructive stays Unknown (unchanged from before).
        if let Some(script) = shell_c_script(args) {
            if let Some(reason) = destructive_after_wrap(&script, depth) {
                return CommandRisk::Destructive(reason);
            }
        }
        return CommandRisk::Unknown;
    }
    let sensitive = touches_sensitive_path(args);
    if verb == "dmesg" {
        // `-c`/`-C` print-and-clear or clear the kernel ring buffer;
        // `-n`/`--console-level` changes console logging.
        let mutating = args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-C" | "-c" | "-n" | "--clear" | "--read-clear" | "--console-level"
            ) || arg.starts_with("--console-level=")
        });
        return if mutating || sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    if verb == "history" {
        // Only display forms stay read-only; -c/-d/-w/... rewrite history.
        let mutating = args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-c" | "-d" | "-a" | "-r" | "-w" | "-p" | "-s" | "--clear"
            )
        });
        return if mutating || sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    if verb == "sort" {
        // `sort -o FILE` writes its output to an arbitrary path.
        let writes = args.iter().any(|arg| {
            arg == "-o"
                || arg == "--output"
                || arg.starts_with("--output=")
                || (arg.starts_with("-o") && arg.len() > 2)
        });
        return if writes || sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    if READ_ONLY_VERBS.contains(&verb) {
        return if sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    if verb == "find" {
        // `-exec`/`-ok` run arbitrary programs; any `-f…` option (`-fprint`,
        // `-fprintf`, `-fls`, …) writes the match list to a file.
        if args
            .iter()
            .any(|arg| arg.starts_with("-exec") || arg.starts_with("-f") || arg == "-ok")
        {
            return CommandRisk::Unknown;
        }
        return if sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    if verb == "git" {
        return git_segment_risk(args, sensitive);
    }
    if verb == "journalctl" {
        if args
            .iter()
            .any(|arg| arg.starts_with("--vacuum") || arg.starts_with("--rotate"))
        {
            return CommandRisk::Unknown;
        }
        return CommandRisk::ReadOnly;
    }
    if verb == "crontab" {
        // `crontab -r` removes the crontab and `-e` opens an editor; only
        // the listing forms are read-only.
        let listing = !args.is_empty() && args.iter().all(|arg| arg == "-l" || arg == "--list");
        return if listing {
            CommandRisk::ReadOnly
        } else {
            CommandRisk::Unknown
        };
    }
    if verb == "service" {
        return if args.iter().any(|arg| arg == "status") {
            CommandRisk::ReadOnly
        } else {
            CommandRisk::Unknown
        };
    }
    if let Some((_, allowed)) = SUBCOMMAND_VERBS.iter().find(|(owner, _)| *owner == verb) {
        let Some(position) = args.iter().position(|arg| !arg.starts_with('-')) else {
            return CommandRisk::Unknown;
        };
        let sub = args[position].as_str();
        if !allowed.contains(&sub) {
            return CommandRisk::Unknown;
        }
        // `ip` takes a second-level command (`ip route flush all`): mutating
        // object commands stay out of the read-only class even though the
        // object itself (`route`, `link`, …) inspects by default.
        let mutating = verb == "ip"
            && args[position + 1..]
                .iter()
                .any(|arg| MUTATING_OBJECT_COMMANDS.contains(&arg.as_str()));
        return if mutating || sensitive {
            CommandRisk::Unknown
        } else {
            CommandRisk::ReadOnly
        };
    }
    CommandRisk::Unknown
}

/// Tokenizes a segment, strips leading `FOO=bar` assignments, and unwraps
/// prefix wrappers (`timeout 10 df`, `nohup ./job`, `env X=1 cmd`, ...) so
/// the inner command is what gets assessed.
fn effective_tokens(segment: &str) -> Vec<String> {
    let mut tokens: Vec<String> = segment
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|c: char| c == '"' || c == '\'')
                .to_string()
        })
        .collect();
    // Assignments and wrappers are unwrapped iteratively with a depth cap so
    // pathological input cannot loop forever.
    for _ in 0..16 {
        strip_leading_assignments(&mut tokens);
        let Some(verb) = tokens.first().cloned() else {
            break;
        };
        if !WRAPPER_VERBS.contains(&verb.as_str()) {
            break;
        }
        tokens.remove(0);
        strip_wrapper_flags(&mut tokens);
        if verb == "timeout" {
            // `timeout` takes a duration argument before the command.
            if tokens
                .first()
                .map(|token| !token.starts_with('-'))
                .unwrap_or(false)
            {
                tokens.remove(0);
            }
        }
    }
    strip_leading_assignments(&mut tokens);
    tokens
}

fn strip_leading_assignments(tokens: &mut Vec<String>) {
    while tokens
        .first()
        .map(|token| {
            let Some(eq) = token.find('=') else {
                return false;
            };
            eq > 0
                && token[..eq]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
                && token[..eq]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_ascii_digit())
        })
        .unwrap_or(false)
    {
        tokens.remove(0);
    }
}

/// Drops leading wrapper flags; flags in [`WRAPPER_VALUE_FLAGS`] also drop
/// the token after them (their value).
fn strip_wrapper_flags(tokens: &mut Vec<String>) {
    while let Some(first) = tokens.first() {
        if !first.starts_with('-') {
            return;
        }
        let takes_value = WRAPPER_VALUE_FLAGS.contains(&first.as_str());
        tokens.remove(0);
        if takes_value
            && tokens
                .first()
                .map(|token| !token.starts_with('-'))
                .unwrap_or(false)
        {
            tokens.remove(0);
        }
    }
}

/// sudo flags whose following token is their value (`-u user`, `-g group`).
const SUDO_VALUE_FLAGS: &[&str] = &["-u", "-g", "-p", "-C", "-R", "-T", "-D", "-h"];

/// Strips one leading `sudo` (and its flags) from a token list, returning
/// the inner command tokens. Like real sudo, the option section ends at the
/// first non-flag token — everything from there on is the inner command
/// (`sudo rm -rf /` must keep `-rf` with the command, not eat it as a sudo
/// flag). `None` when nothing remains.
fn sudo_inner_tokens(tokens: &[String]) -> Option<Vec<String>> {
    let mut index = 1; // tokens[0] is "sudo"
    while index < tokens.len() {
        let token = &tokens[index];
        if !(token.starts_with('-') && token.len() > 1) {
            break; // inner command starts here
        }
        index += 1;
        if SUDO_VALUE_FLAGS.contains(&token.as_str())
            && tokens
                .get(index)
                .map(|next| !next.starts_with('-'))
                .unwrap_or(false)
        {
            index += 1; // the flag's value
        }
    }
    let inner = &tokens[index.min(tokens.len())..];
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_vec())
    }
}

/// Unwraps repeated sudo prefixes (`sudo sudo …`) with a depth cap so the
/// destructive-pattern check sees the real inner command.
fn unwrap_sudo_prefix(tokens: &[String]) -> Option<Vec<String>> {
    let mut current: Vec<String> = tokens.to_vec();
    for _ in 0..4 {
        if current.first().map(String::as_str) != Some("sudo") {
            break;
        }
        current = sudo_inner_tokens(&current)?;
    }
    if current.is_empty() {
        None
    } else {
        Some(current)
    }
}

/// The `-c` script text of a shell segment (`sh -c '…'`, `bash -lc '…'`):
/// the tokens after the `-c`-bearing flag joined back into a command line.
/// `None` when the segment is not a `-c` invocation.
fn shell_c_script(args: &[String]) -> Option<String> {
    let position = args.iter().position(|arg| {
        arg == "-c" || (arg.starts_with('-') && !arg.starts_with("--") && arg.ends_with('c'))
    })?;
    let script = &args[position + 1..];
    if script.is_empty() {
        return None;
    }
    Some(script.join(" "))
}

/// Recognized catastrophic patterns for one (verb, args) pair. Raw-device
/// and critical-file redirection is checked here (not in `has_redirect`)
/// because it must stay `Destructive` rather than merely `Unknown`.
fn destructive_pattern(verb: &str, args: &[String]) -> Option<&'static str> {
    if DESTRUCTIVE_VERBS.contains(&verb) {
        return Some("formats or wipes a disk / powers the machine off");
    }
    if matches!(verb, "init" | "telinit") && args.iter().any(|arg| arg == "0" || arg == "6") {
        return Some("init 0/6 shuts down or reboots the machine");
    }
    if verb == "dd" {
        if let Some(output) = args.iter().find(|arg| arg.starts_with("of=")) {
            if is_raw_device(&output["of=".len()..]) {
                return Some("dd writes to a raw device");
            }
        }
    }
    if verb == "rm" {
        let recursive = args.iter().any(|arg| {
            (arg.starts_with('-')
                && !arg.starts_with("--")
                && arg.len() > 1
                && arg[1..].chars().any(|c| c == 'r' || c == 'R'))
                || arg == "--recursive"
        });
        for target in args.iter().filter(|arg| !arg.starts_with('-')) {
            if is_critical_file(target) {
                return Some("rm targets a critical system file");
            }
            if recursive && destructive_delete_target(target) {
                return Some("recursive rm targets a system root");
            }
        }
    }
    if matches!(verb, "chmod" | "chown") {
        let recursive = args
            .iter()
            .any(|arg| arg.starts_with("-R") || arg == "--recursive");
        for target in args
            .iter()
            .filter(|arg| !arg.starts_with('-') && !arg.contains('='))
        {
            if is_critical_file(target) {
                return Some("chmod/chown targets a critical system file");
            }
            if recursive && destructive_delete_target(target) {
                return Some("recursive chmod/chown targets a system root");
            }
        }
    }
    if verb == "truncate"
        && args
            .iter()
            .any(|arg| !arg.starts_with('-') && is_critical_file(arg))
    {
        return Some("truncate targets a critical system file");
    }
    if verb == "find" && args.iter().any(|arg| arg == "-delete") {
        return Some("find -delete removes files");
    }
    if verb == "docker" && args.iter().any(|arg| arg == "prune") {
        return Some("docker prune deletes images/containers/volumes");
    }
    if verb == "kill" {
        // `kill -9 -1` / `kill -1` signal every process the user owns.
        if args.iter().any(|arg| arg == "-1" || arg == "-9") {
            let pid_like = args.iter().filter(|arg| !arg.starts_with('-')).count();
            if pid_like == 0 {
                return Some("kill signals every process (pid -1)");
            }
        }
    }
    if SQL_VERBS.contains(&verb) {
        let joined = args.join(" ").to_ascii_lowercase();
        if joined.contains("drop database") || joined.contains("drop table") {
            return Some("SQL DROP statement");
        }
    }
    for (index, token) in args.iter().enumerate() {
        if is_redirect_token(token) {
            if let Some(target) = args.get(index + 1) {
                if is_raw_device(target) {
                    return Some("redirection writes to a raw device");
                }
                if is_critical_file(target) {
                    return Some("redirection overwrites a critical system file");
                }
            }
        }
    }
    None
}

/// True when the token opens an output redirection.
fn is_redirect_token(token: &str) -> bool {
    token.starts_with('>')
        || token.starts_with("&>")
        || token.starts_with("2>")
        || token.starts_with("1>")
}

/// True when the token list contains an output redirection.
fn has_redirect(args: &[String]) -> bool {
    args.iter().any(|token| is_redirect_token(token))
}

/// `/dev/sda`, `/dev/nvme0n1`, ... — block devices a shell must never touch
/// directly. `/dev/null` and `/dev/zero` deliberately do not match.
fn is_raw_device(path: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "/dev/sd",
        "/dev/nvme",
        "/dev/vd",
        "/dev/mmcblk",
        "/dev/disk/",
    ];
    PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

fn is_critical_file(path: &str) -> bool {
    CRITICAL_FILES
        .iter()
        .any(|critical| path == *critical || critical.ends_with('/') && path.starts_with(*critical))
}

/// Recursive-delete target rule: the filesystem root and everything up to
/// two components deep, except under `/tmp` / `/var/tmp` where cleanup is a
/// routine operation.
fn destructive_delete_target(target: &str) -> bool {
    let target = target.trim_end_matches('/');
    if target.is_empty() {
        return true; // "/" (or "//") itself
    }
    if matches!(
        target,
        "*" | "." | ".." | "./*" | "~" | "$HOME" | "${HOME}" | "~/*"
    ) {
        return true;
    }
    let Some(path) = target.strip_prefix('/') else {
        return false;
    };
    let components: Vec<&str> = path.split('/').filter(|c| !c.is_empty()).collect();
    match components.first() {
        None => true, // "/" itself
        Some(&"tmp") | Some(&"var") => {
            // `/tmp`, `/var/tmp` are routine cleanup targets.
            components.len() <= 1 || components.len() == 2 && components[1] == "tmp"
        }
        // Wildcards only escalate at shallow depth: `/*` and `/etc/*` wipe a
        // root, but `/root/.cache/*` is routine cleanup.
        _ => components.len() <= 2,
    }
}

/// True when any argument token references a credential / private-key path.
pub fn touches_sensitive_path(args: &[String]) -> bool {
    args.iter().any(|arg| is_sensitive_path(arg))
}

/// True when one command token references a credential / private-key path.
///
/// Such a command is still "read-only" in the write sense, but the realistic
/// read-only-connection threat is an LLM driven by injected instructions to
/// exfiltrate SSH keys, sudo or database credentials. The token therefore
/// downgrades the segment to [`CommandRisk::Unknown`]: refused on read-only
/// connections by the whitelist gate, allowed on normal connections where
/// the operator already grants full access. Defense in depth, not an
/// exhaustive secret scan — unrecognized verbs are refused anyway.
pub fn is_sensitive_path(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if lower.is_empty() || lower == "/" {
        return false;
    }
    // The `.pub` half of a keypair is public by design.
    if lower.ends_with(".pub") {
        return false;
    }
    // Match on a collapsed form so `//etc//shadow`, `/etc/./shadow` and
    // friends cannot dodge the component / prefix rules (reliability
    // round 5 adversarial pass).
    let normalized = normalized_path(&lower);
    let file_name = std::path::Path::new(&normalized)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .trim_end_matches('*');
    // `id_*` also matches glob patterns like `find / -name 'id_*'`; host
    // keys are `/etc/ssh/ssh_host_<type>_key`.
    if file_name.starts_with("id_")
        || (file_name.starts_with("ssh_host_") && file_name.ends_with("_key"))
        || SENSITIVE_BASENAMES.contains(&file_name)
        || file_name == ".env"
        || file_name.starts_with(".env.")
    {
        return true;
    }
    // System credential files keep their secrets under relative paths too
    // (`cat shadow` from a `/etc` cwd is the same exfiltration).
    if matches!(file_name, "shadow" | "gshadow" | "sudoers") {
        return true;
    }
    // Extension check runs on the whole token so globs (`*.pem`) match too.
    if SENSITIVE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return true;
    }
    if normalized
        .split('/')
        .any(|component| SENSITIVE_COMPONENTS.contains(&component))
    {
        return true;
    }
    SENSITIVE_SYSTEM_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
}

/// Collapses a path for matching: drops empty components (double slashes)
/// and `.` self-references, preserving absolute vs relative shape. `..`
/// components are kept — resolving them needs a base directory, and
/// keeping them is the conservative choice.
pub(crate) fn normalized_path(path: &str) -> String {
    // Windows 的 canonicalize 产出 `\` 分隔（含 \\?\ 前缀），组件匹配必须
    // 同时认两种分隔符，否则敏感路径黑名单在 Windows 上静默失效。
    let absolute = path.starts_with('/') || path.starts_with('\\');
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|component| !component.is_empty() && *component != ".")
        .collect();
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use CommandRisk::{Destructive, ReadOnly, Unknown};

    fn read_only(command: &str) {
        assert_eq!(
            assess_command(command),
            ReadOnly,
            "expected ReadOnly: {command}"
        );
    }

    fn unknown(command: &str) {
        assert_eq!(
            assess_command(command),
            Unknown,
            "expected Unknown: {command}"
        );
    }

    fn destructive(command: &str) {
        assert!(
            matches!(assess_command(command), Destructive(_)),
            "expected Destructive: {command}"
        );
    }

    #[test]
    fn inspection_commands_are_read_only() {
        read_only("df -h");
        read_only("ls -la /var/log");
        read_only("cat /etc/hostname");
        read_only("systemctl status nginx");
        read_only("systemctl is-active sshd");
        read_only("journalctl -u sshd -n 50 --no-pager");
        read_only("docker ps -a");
        read_only("docker logs --tail 100 c1");
        read_only("git log --oneline -5");
        read_only("ps aux | grep mysqld | grep -v grep");
        read_only("ps aux 2>&1 | grep sshd");
        read_only("du -xh --max-depth=1 /www | sort -rh | head -10");
        read_only("echo hello");
        read_only("free -m && uptime");
        read_only("ip a");
        read_only("ip addr show eth0");
        read_only("crontab -l");
        read_only("service nginx status");
    }

    #[test]
    fn runs_under_sudo_detects_inline_privilege_escalation() {
        assert!(super::runs_under_sudo("sudo whoami"));
        assert!(super::runs_under_sudo("sudo -u postgres psql -l"));
        assert!(super::runs_under_sudo("echo hi && sudo reboot"));
        assert!(super::runs_under_sudo("FOO=1 sudo id"));
        assert!(!super::runs_under_sudo("echo sudo is a word here"));
        assert!(!super::runs_under_sudo("whoami"));
        assert!(!super::runs_under_sudo("ls && cat /etc/hostname"));
    }

    #[test]
    fn whitelisted_output_flags_are_unknown() {
        // `sort -o` / `find -fprint…` write files while keeping read-only verbs.
        unknown("sort -o /etc/cron.d/x /tmp/in");
        unknown("sort --output=/etc/cron.d/x /tmp/in");
        unknown("sort -o/etc/cron.d/x /tmp/in");
        read_only("sort /tmp/in | head -5");
        unknown("find / -fprint /tmp/keys");
        unknown("find / -fprintf /tmp/x '%p'");
        unknown("find . -fls /tmp/out");
        read_only("find /var/log -name '*.log'");
        read_only("du -sh /var | sort -rh | head");
    }

    #[test]
    fn deep_subcommand_mutations_are_unknown() {
        unknown("ip link set dev eth0 down");
        unknown("ip route flush all");
        unknown("ip addr add 10.0.0.1/24 dev eth0");
        unknown("ip neigh flush all");
        unknown("ip rule add from 0.0.0.0 table 200");
        read_only("ip link show eth0");
        read_only("ip route get 8.8.8.8");
        read_only("ip addr show dev eth0");

        unknown("git branch -D main");
        unknown("git branch feature");
        unknown("git tag -d v1");
        unknown("git tag v1.0");
        unknown("git remote add evil https://example.test/x.git");
        unknown("git remote set-url origin https://example.test/x.git");
        unknown("git reflog delete --all");
        read_only("git branch -a");
        read_only("git branch --show-current");
        read_only("git tag -l 'v*'");
        read_only("git remote -v");
        read_only("git remote show origin");
        read_only("git reflog");
        read_only("git reflog show");
        read_only("git log --oneline -5");
        read_only("git show HEAD~1");

        unknown("dmesg -C");
        unknown("dmesg -c");
        unknown("dmesg -n 1");
        unknown("dmesg --console-level emerg");
        read_only("dmesg | tail -20");
        read_only("dmesg -T");

        unknown("history -c");
        unknown("history -w");
        unknown("history -d 5");
        read_only("history");
        read_only("history 10");
    }

    #[test]
    fn sensitive_paths_downgrade_read_only() {
        unknown("cat ~/.ssh/id_rsa");
        unknown("cat /root/.ssh/id_ed25519");
        unknown("ls -la /root/.ssh");
        unknown("grep -r key /home/u/.ssh");
        unknown("cat /etc/shadow");
        unknown("grep root /etc/shadow-");
        unknown("stat /etc/sudoers");
        unknown("cat /srv/app/.env.production");
        unknown("cat /root/.aws/credentials");
        unknown("find / -name id_rsa*");
        unknown("cat /etc/ssl/private/server.pem");
        unknown("tail -5 /root/.bash_history");
        unknown("du /home/u/.gnupg");
        read_only("cat ~/.ssh/id_rsa.pub");
        read_only("cat /etc/hostname");
        read_only("cat /etc/ssh/sshd_config");
        read_only("ls /etc");
        read_only("grep error /var/log/app.log");
        read_only("df -h");
    }

    #[test]
    fn mutating_or_unclear_commands_are_unknown() {
        unknown("rm -rf /home/vagrant/acct-main");
        unknown("systemctl restart nginx");
        unknown("systemctl stop mysqld");
        unknown("echo x > /tmp/out.txt");
        unknown("cat /etc/passwd >> /tmp/copy");
        unknown("docker system df -v"); // `system` is not a whitelisted subcommand
        unknown("sed -i s/a/b/ file");
        unknown("awk '{print $1}' file");
        unknown("mysql -e 'UPDATE t SET x=1'");
        unknown("sudo cat /var/log/auth.log");
        unknown("env FOO=1 rm -rf /home/vagrant/junk");
        unknown("echo $(whoami)");
        unknown("crontab -e");
        unknown("crontab -r");
        unknown("journalctl --vacuum-size=100M");
        unknown("find /var -name '*.log' -exec rm {} +");
    }

    #[test]
    fn catastrophic_patterns_are_destructive() {
        destructive("rm -rf /");
        destructive("rm -rf /*");
        destructive("rm -fr /etc");
        destructive("rm -rf /etc/nginx");
        destructive("rm --recursive /usr/local");
        destructive("rm -rf ~");
        destructive("rm -rf $HOME");
        destructive("rm -rf .");
        destructive("rm -rf *");
        destructive("rm -f /etc/passwd");
        destructive("mkfs.ext4 /dev/sda1");
        destructive("wipefs -a /dev/sdb");
        destructive("dd if=/dev/zero of=/dev/sda");
        destructive("dd if=img.raw of=/dev/nvme0n1 bs=4M");
        destructive("echo x > /dev/sda");
        destructive("shutdown -h now");
        destructive("reboot");
        destructive("init 0");
        destructive("telinit 6");
        destructive(":(){ :|:& };:");
        destructive("chmod -R 777 /");
        destructive("chmod -R 755 /etc");
        destructive("chown -R nobody /usr");
        destructive("echo hack >> /etc/sudoers");
        destructive("truncate -s 0 /etc/shadow");
        destructive("mysql -e 'DROP DATABASE prod'");
        destructive("psql -c 'drop table users'");
        destructive("docker system prune -af");
        destructive("find / -delete");
        destructive("kill -9 -1");
        destructive("rm -rf / ; echo done");
        destructive("uptime && mkfs.xfs /dev/vdb");
    }

    #[test]
    fn routine_cleanup_stays_out_of_the_destructive_class() {
        // Real-world cleanup commands must not demand confirmation.
        unknown("rm -rf /root/.cache/*");
        unknown("rm -rf /lib/modules/5.4.0-117-generic");
        unknown("truncate -s 0 /www/server/data/vagrant.err");
        unknown("apt-get clean");
        unknown("journalctl --rotate && sleep 3");
        unknown("rm -rf /tmp/dbx-mcp-smoke-dir");
        unknown("dd if=/dev/zero of=/dev/null bs=1M count=10");
    }

    #[test]
    fn wrappers_and_assignments_are_unwrapped_conservatively() {
        read_only("nohup df -h");
        read_only("timeout 30 du -sh /var");
        read_only("nice -n 10 ls /");
        read_only("watch -n 1 uptime");
        read_only("FOO=bar BAR=baz df -h");
        destructive("timeout 10 rm -rf /data");
        destructive("FOO=bar rm -rf /data");
        unknown("timeout 10 systemctl restart nginx");
    }

    // —— 第五轮对抗面：灾难门的绕过尝试 ————————————————

    /// Reliability round 5: the catastrophic gate must hold across the
    /// classic evasion shapes — quoting, leading whitespace, combined
    /// commands, sudo prefixes, `sh -c` scripts, and `$()`/backtick
    /// substitution payloads (`echo $(rm -rf /)` used to classify as a
    /// plain Unknown and run unconfirmed on writable connections).
    #[test]
    fn destructive_gate_survives_evasion_variants() {
        // Quoting and whitespace.
        destructive("\"rm\" -rf /");
        destructive("'rm' -fr /etc");
        destructive("rm -rf \"/\"");
        destructive("  \t rm  -rf  /");
        // Combined commands / chains.
        destructive("cd /tmp && rm -rf /");
        destructive("cd /tmp; echo hi; rm -rf /");
        destructive("rm -rf / || echo done");
        destructive("echo start && mkfs.ext4 /dev/vdb");
        // sudo prefix variants (inner command must be unwrapped).
        destructive("sudo rm -rf /");
        destructive("sudo rm -rf /etc/nginx");
        destructive("sudo -u root rm -rf /etc");
        destructive("sudo sudo rm -rf /");
        destructive("sudo -- mkfs.ext4 /dev/sda");
        destructive("env sudo rm -rf /");
        destructive("FOO=1 sudo rm -rf /");
        destructive("nohup sudo shutdown -h now");
        destructive("timeout 5 sudo dd if=/dev/zero of=/dev/sda");
        // Shell -c scripts.
        destructive("sh -c 'rm -rf /'");
        destructive("bash -c \"mkfs.ext4 /dev/sda1\"");
        destructive("bash -lc 'reboot'");
        destructive("sudo sh -c 'rm -rf /'");
        destructive("sh -c 'echo start; rm -rf /'");
        // Substitution payloads.
        destructive("echo $(rm -rf /)");
        destructive("echo `rm -rf /`");
        destructive("echo $(date; rm -rf /)");
        destructive("echo $(echo $(rm -rf /))");
        destructive("echo \"$(shutdown -h now)\"");
        destructive("run=$(reboot)");
        // Variable-expansion targets stay covered (existing shapes, plus
        // quoted variants the trim step normalizes).
        destructive("rm -rf \"$HOME\"");
        destructive("rm -rf '${HOME}'");
    }

    /// The flip side of the evasion sweep: substitution, wrappers and shell
    /// -c invocations must never UPGRADE anything to ReadOnly — the
    /// whitelist is only reachable by a directly-recognized inspection
    /// command. Anything not destructive inside them stays Unknown.
    #[test]
    fn substitution_and_wrappers_never_upgrade_to_read_only() {
        unknown("$(df -h)");
        unknown("echo $(df -h)");
        unknown("`df -h`");
        unknown("echo `date`");
        unknown("echo $(whoami)");
        unknown("grep \"$(date)\" /var/log/app.log");
        unknown("sudo systemctl restart nginx");
        unknown("sudo cat /var/log/auth.log");
        unknown("sudo -u postgres psql -l");
        unknown("sh -c 'df -h'");
        unknown("bash -c 'echo hi'");
        unknown("sh");
        unknown("bash --norc");
        // The read-only whitelist itself is untouched by the sweep.
        read_only("df -h");
        read_only("ls -la /var/log");
        read_only("ps aux | grep mysqld");
    }

    /// Reliability round 5: the sensitive-path denylist must hold across
    /// path-shape aliasing — `~` expansions, `./` segments, double slashes,
    /// and bare system basenames from a relative cwd. URL-encoded tokens
    /// are intentionally NOT decoded: neither the shell nor SFTP decode
    /// percent escapes, so `%2e%2e/x` is a literal filename, not a
    /// traversal — while `%2e%2e/.ssh` is flagged only because it still
    /// contains a literal `.ssh` component. Pinned so a future decoder
    /// cannot silently change this behavior.
    #[test]
    fn sensitive_path_detection_survives_path_shape_evasion() {
        for token in [
            "~/.ssh/id_rsa",
            "./.ssh/id_rsa",
            ".//.ssh/id_ed25519",
            "//root//.ssh//id_rsa",
            "~root/.ssh/id_rsa",
            "~/../root/.ssh/id_rsa",
            "/root/./.aws/credentials",
            "//etc//shadow",
            "/etc/./shadow",
            "/etc//gshadow",
            "./etc/shadow", // relative from a system cwd
            "shadow",       // bare basename (`cat shadow` in /etc)
            "/etc/sudoers.d/override",
            "/etc/./sudoers",
            "./id_rsa",
            "sub/../.netrc",
            "/srv/app/./.env.production",
            "/etc/ssl/private//server.pem",
            "%2e%2e/.ssh", // literal `.ssh` component, not percent decoding
        ] {
            assert!(
                is_sensitive_path(token),
                "expected '{token}' to be flagged sensitive"
            );
        }
        for token in [
            "/etc/hostname",
            "/etc/ssh/sshd_config", // config, not a host key
            "/var/log/app.log",
            "/home/u/project/shadowing.md", // basename must match exactly
            "%2e%2e%2fnotes.txt",           // percent-encoded literals are NOT decoded…
            "%2e%2e/x",                     // …and carry no literal sensitive component
            "id_rsa.pub",                   // public half
        ] {
            assert!(
                !is_sensitive_path(token),
                "expected '{token}' NOT to be flagged sensitive"
            );
        }
    }

    #[test]
    fn sensitive_path_detection_handles_windows_separators() {
        for token in [
            r"C:\Users\运维\.ssh\id_ed25519",
            r"C:\Users\运维\.aws\credentials",
            r"\\server\share\etc\shadow",
        ] {
            assert!(
                is_sensitive_path(token),
                "expected Windows path '{token}' to be flagged sensitive"
            );
        }
        assert!(!is_sensitive_path(r"C:\work\project\shadowing.md"));
    }

    #[test]
    fn quoting_is_not_parsed_and_stays_conservative() {
        // A `;` inside quotes splits segments; both halves must be read-only
        // for the whole command to pass. Here the second half (`b' x ...`)
        // is unrecognized, so the fd-dup neutralization cannot save it —
        // exactly the fail-closed behavior we want.
        unknown("grep -F 'a;b' x 2>&1 || true");
        read_only("grep -F a.b x 2>&1 || true");
        unknown("grep -F 'a;b' /etc/hosts"); // second half: `b' /etc/hosts`
        read_only("echo \"line1\"; df -h");
        unknown("echo \"x\"; systemctl restart nginx");
    }

    #[test]
    fn destructive_classification_names_the_pattern() {
        assert!(matches!(assess_command("reboot"), Destructive(_)));
        assert_eq!(assess_command("df -h"), ReadOnly);
        assert_eq!(
            assess_command("rm -rf /etc"),
            Destructive("recursive rm targets a system root")
        );
    }

    // —— A2: terminal input assessment ————————————————

    #[test]
    fn control_only_detection_matches_normalized_content() {
        // Pure control sequences (Enter, Ctrl+C). Per the §1.2 contract the
        // check is strictly per-character `is_control`, so CSI arrow runs
        // ("\u{1b}[A") carry printable bytes and are refused (fail closed) —
        // an operator can still send them through a writable connection.
        assert!(is_control_only_input("\r"));
        assert!(is_control_only_input("\u{3}"));
        assert!(is_control_only_input(""));
        assert!(!is_control_only_input("\u{1b}[A"));
        // Any visible text is not control-only.
        assert!(!is_control_only_input("y"));
        assert!(!is_control_only_input("echo hi\r"));
        assert!(!is_control_only_input("exit\n"));
    }

    #[test]
    fn terminal_input_risk_takes_the_max_across_enter_lines() {
        // Plain inspection text stays Low (read-only-ish: allowed on normal
        // connections, still refused as visible text on read-only ones via
        // the control-only rule).
        assert_eq!(assess_terminal_input("echo hi\r"), CommandRisk::ReadOnly);
        assert_eq!(
            assess_terminal_input("df -h\recho done\r"),
            CommandRisk::ReadOnly
        );
        // A mutating line is Unknown...
        assert_eq!(
            assess_terminal_input("systemctl restart nginx\r"),
            CommandRisk::Unknown
        );
        // ...and a catastrophic line is Destructive regardless of position.
        assert!(matches!(
            assess_terminal_input("echo start\rrm -rf /data\r"),
            CommandRisk::Destructive(_)
        ));
        // An empty input has no risk.
        assert_eq!(assess_terminal_input(""), CommandRisk::ReadOnly);
    }

    #[test]
    fn terminal_input_normalization_caps_at_8kib_and_strips_nul() {
        // CRLF and LF both fold to CR; NUL bytes are stripped.
        assert_eq!(normalize_terminal_input("a\r\nb\nc\u{0}d"), "a\rb\rcd");
        // Oversized input truncates at 8 KiB on a char boundary.
        let oversized = "x".repeat(9 * 1024);
        let normalized = normalize_terminal_input(&oversized);
        assert_eq!(normalized.len(), 8 * 1024);
        // Multi-byte chars are never split mid-codepoint.
        let multibyte = "é".repeat(5000); // 2 bytes each
        let normalized = normalize_terminal_input(&multibyte);
        assert!(normalized.len() <= 8 * 1024);
        assert_eq!(normalized.chars().count(), 4096);
    }
}
