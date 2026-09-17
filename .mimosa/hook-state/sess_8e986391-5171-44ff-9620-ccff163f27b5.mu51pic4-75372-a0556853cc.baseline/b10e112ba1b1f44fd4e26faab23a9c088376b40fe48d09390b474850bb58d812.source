//! Per-connection sudo command allowlist, sudoers-inspired.
//!
//! A connection can carry `sudo_whitelist` in its external config: one
//! pattern per line (or `;`-separated for the single-line form input), each
//! pattern a whitespace-separated token list compared against the command
//! the caller wants to run with sudo. Matching rules, deliberately stricter
//! than real sudoers:
//!
//! - A leading literal `sudo` token on the command is stripped first; `sudo`
//!   *flags* (`-u postgres`, `-n`, …) are not modeled — such commands can
//!   never match an entry and are refused.
//! - Tokens match exactly; a `*` token matches exactly one argument.
//! - A trailing `*` matches one-or-more remaining arguments
//!   (`systemctl restart *`), so "any args" must be spelled out — the
//!   sudoers default of "no args listed = any args allowed" is inverted
//!   here: an entry without wildcards allows only that exact command.
//! - Empty config = gate off (the connection behaves as before).
//!
//! Enforcement points: the MCP exec tools (`ssh_exec_sudo`, plus inline
//! `sudo …` inside `ssh_exec`/`ssh_run_bg`) and the workbench `ssh/exec`
//! handler with `sudo: true`. Structured `sudo_fs` operations (workbench
//! sudo file panel) are user-driven UI actions and stay outside this gate.

/// Parses the raw config value into tokenized entries. Blank lines and
/// `#` comments are skipped.
pub fn parse_entries(raw: &str) -> Vec<Vec<String>> {
    raw.split(['\n', ';'])
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.split_whitespace().map(str::to_string).collect())
        .collect()
}

/// Tokenizes a connection's stored raw entry lines (one pattern per line,
/// as parsed from the external config string).
pub fn entries_from_lines(lines: &[String]) -> Vec<Vec<String>> {
    parse_entries(&lines.join("\n"))
}

/// Renders entries back into a readable form for refusal messages, so an
/// LLM caller can self-correct (`sudo -l` style).
pub fn render_entries(entries: &[Vec<String>]) -> String {
    entries
        .iter()
        .map(|entry| entry.join(" "))
        .collect::<Vec<_>>()
        .join("; ")
}

/// True when the command may run under sudo on a connection with these
/// entries. A leading `FOO=bar` assignment chain and one literal `sudo`
/// token are stripped before matching.
pub fn is_allowed(entries: &[Vec<String>], command: &str) -> bool {
    let tokens = command_tokens(command);
    !tokens.is_empty() && entries.iter().any(|entry| entry_matches(entry, &tokens))
}

/// Command tokens for matching: leading `K=V` assignments dropped, one
/// leading `sudo` verb dropped, sudo *flags* kept (they make the command
/// unmatchable on purpose — run-as is not modeled).
fn command_tokens(command: &str) -> Vec<String> {
    let mut tokens: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    while tokens
        .first()
        .map(|token| {
            token.find('=').is_some_and(|eq| {
                eq > 0
                    && token[..eq]
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
        })
        .unwrap_or(false)
    {
        tokens.remove(0);
    }
    if tokens.first().map(String::as_str) == Some("sudo") {
        tokens.remove(0);
    }
    tokens
}

fn entry_matches(entry: &[String], tokens: &[String]) -> bool {
    match entry.split_last() {
        // Trailing `*` requires at least one extra argument: `systemctl
        // restart *` must not bless a bare `systemctl restart`.
        Some((last, head)) if last == "*" => {
            head.len() < tokens.len()
                && head
                    .iter()
                    .zip(tokens)
                    .all(|(expected, actual)| token_matches(expected, actual))
        }
        _ => {
            entry.len() == tokens.len()
                && entry
                    .iter()
                    .zip(tokens)
                    .all(|(expected, actual)| token_matches(expected, actual))
        }
    }
}

fn token_matches(expected: &str, actual: &str) -> bool {
    expected == "*" || expected == actual
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRIES: &str = "# service management\nsystemctl restart nginx\ndocker restart *\njournalctl --vacuum-size=100M";

    fn entries() -> Vec<Vec<String>> {
        parse_entries(ENTRIES)
    }

    #[test]
    fn parse_skips_comments_blanks_and_splits_semcolons() {
        let parsed = entries();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0], ["systemctl", "restart", "nginx"]);
        assert_eq!(parse_entries("a b; c d"), [["a", "b"], ["c", "d"]]);
        assert!(parse_entries("  \n# only a comment\n").is_empty());
    }

    #[test]
    fn exact_and_wildcard_matching() {
        let entries = entries();
        assert!(is_allowed(&entries, "systemctl restart nginx"));
        assert!(is_allowed(&entries, "sudo systemctl restart nginx"));
        assert!(is_allowed(&entries, "docker restart api"));
        assert!(is_allowed(&entries, "docker restart a b c"));
        assert!(!is_allowed(&entries, "systemctl restart mysql"));
        // No wildcard = exact shape only (inverted sudoers default).
        assert!(!is_allowed(&entries, "systemctl restart nginx --now"));
        assert!(!is_allowed(&entries, "systemctl restart"));
        assert!(!is_allowed(&entries, "systemctl status nginx"));
        // Trailing `*` needs at least one argument.
        assert!(!is_allowed(&entries, "docker restart"));
    }

    #[test]
    fn assignments_and_sudo_prefix_are_stripped_flags_are_not() {
        let entries = entries();
        assert!(is_allowed(&entries, "FOO=1 sudo systemctl restart nginx"));
        // sudo flags (run-as etc.) are not modeled: never matchable.
        assert!(!is_allowed(
            &entries,
            "sudo -u root systemctl restart nginx"
        ));
        assert!(!is_allowed(&entries, "sudo -n docker restart api"));
    }

    #[test]
    fn empty_command_and_empty_entries_refuse() {
        assert!(!is_allowed(&entries(), ""));
        assert!(!is_allowed(&entries(), "sudo"));
        assert!(!is_allowed(&Vec::new(), "systemctl restart nginx"));
    }

    #[test]
    fn render_is_round_trippable() {
        let rendered = render_entries(&entries());
        assert_eq!(
            rendered,
            "systemctl restart nginx; docker restart *; journalctl --vacuum-size=100M"
        );
        assert_eq!(parse_entries(&rendered).len(), 3);
    }
}
