#!/usr/bin/env python3
"""B4 upload-pipeline move verifier (fidelity + command surface).

Pure-move batches are only reviewable if the moved code is provably unchanged.
This script compares the tree against a base commit at symbol granularity.

    python3 scripts/refactor/b4_verify_move.py fidelity [--base SHA]
    python3 scripts/refactor/b4_verify_move.py surface  [--base SHA]

`fidelity`
    For every symbol that B4 moved out of `backend/src/ssh.rs`, extract the item
    (doc comments, attributes and body) from `<base>:backend/src/ssh.rs` and from
    its new module, normalize only the visibility prefix (`pub(super) ` /
    `pub(crate) ` / `pub(in ...) `), and require a character-exact match.
    A mismatch that is *whitespace-only* (identical token stream, different line
    wrapping) is reported as REFLOW and accepted — rustfmt forces a re-wrap when
    a `pub(super) ` prefix pushes a signature past 100 columns. Anything else
    fails. Also reports extra/missing items per module file.

`surface`
    Command execution is the red line for this batch. Every string literal (in
    source order) plus every line mentioning `sudo_exec`, `Command::new` or
    `ssh2::` is extracted from the moved items on both sides and required to be
    identical (same count, same order, same text). Testing *all* literals is
    strictly stronger than "literals that contain commands" and cannot be gamed
    by a different filter. The remainder of `ssh.rs` (everything outside the
    moved items) must also keep the exact same literal/command-line sequence.
"""

import argparse
import difflib
import os
import re
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(REPO, "backend", "src")
SSH_RS = os.path.join(SRC, "ssh.rs")

# Files produced by B4 -> symbols each one must own (plan: B4 上传管线与传输登记).
FILES = {
    "upload.rs": [
        "start_upload", "decide_transfer_compression", "probe_remote_compress_tools",
        "open_resume_spool", "upload_session_id", "resumable_uploads", "append_upload",
    ],
    "upload_finish.rs": ["finish_upload"],
    "upload_compress.rs": [
        "commit_sudo_upload", "compress_upload_spool", "push_compressed_stream",
    ],
    "transfer_registry.rs": [
        "transfer_list", "transfer_status", "transfer_history_query", "clear_transfer_history",
        "build_transfer_history", "live_transfer_rows", "record_transfer", "record_transfer_start",
        "persist_transfer_record", "session_connection_id", "transfer_depth_limit",
        "active_transfer_count", "cleanup_session_transfers",
    ],
    "upload_meta.rs": [
        "read_upload_meta", "write_upload_meta", "remove_upload_meta",
        "sweep_stale_transfer_temps", "resumable_uploads_from", "copy_dir_recursive",
        # Not in the plan's symbol table: the retention constant only exists for
        # `sweep_stale_transfer_temps` and moves with it (documented deviation).
        "UPLOAD_SPOOL_RETENTION",
    ],
    "transfer_paths.rs": [
        "remote_transfer_paths", "preserved_target_permissions", "apply_preserved_permissions",
        "CommitPlan", "commit_plan", "commit_remote_file",
    ],
}

# Items with no `impl` wrapper (free functions / const); the rest live in
# `impl SshRuntime { .. }` and sit at 4-space indentation.
FREE_ITEM_FILES = {"upload_meta.rs", "transfer_paths.rs"}

CMD = re.compile(r"sudo_exec|Command::new|ssh2::")
VIS = re.compile(r"^(\s*)pub\((?:super|crate|in [^)]*)\)\s+")
DECL = re.compile(
    r"^(?P<ind>\s*)(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?"
    r"(?P<kind>fn|struct|enum|type|const|static)\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
)


def split_tokens(s):
    """Yield every char of `s` that is outside comments and string/char literals."""
    i, n = 0, len(s)
    while i < n:
        c = s[i]
        if c == "/" and i + 1 < n and s[i + 1] == "/":
            break
        if c == "/" and i + 1 < n and s[i + 1] == "*":
            j = s.find("*/", i + 2)
            if j < 0:
                break
            i = j + 2
            continue
        m = re.match(r'(b?r)(#*)"', s[i:])
        if m:
            term = '"' + m.group(2)
            j = s.find(term, i + len(m.group(0)))
            if j < 0:
                break
            i = j + len(term)
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if s[j] == "\\":
                    j += 2
                    continue
                if s[j] == '"':
                    break
                j += 1
            i = j + 1
            continue
        if c == "'":
            m = re.match(r"'(?:\\.|[^\\'])'", s[i:])
            if m:
                i += len(m.group(0))
                continue
        yield c
        i += 1


def item_span(lines, name):
    """(start, end) 0-based inclusive span of one item, doc comments included."""
    pat = re.compile(r"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+|unsafe\s+)?"
                     r"(?:fn|struct|enum|type|const|static)\s+" + re.escape(name) + r"\b")
    hits = [i for i, line in enumerate(lines) if pat.match(line)]
    if len(hits) != 1:
        raise SystemExit("%s: expected exactly one definition, found %d" % (name, len(hits)))
    sig = hits[0]
    start = sig
    while start > 0 and re.match(r"^\s*(///|//!|#\[)", lines[start - 1]):
        start -= 1
    depth = 0
    started = False
    end = sig
    for k in range(sig, len(lines)):
        for c in split_tokens(lines[k]):
            if c == "{":
                depth += 1
                started = True
            elif c == "}":
                depth -= 1
        if not started:
            # Braced item has no body (`const X: T = f();`) or is a unit struct.
            if lines[k].rstrip().endswith(";"):
                end = k
                break
            continue
        if depth == 0:
            end = k
            break
    return start, end


def item_text(lines, name):
    start, end = item_span(lines, name)
    return "\n".join(lines[start:end + 1])


def split_item(text):
    """(signature, body) — signature ends on the line that opens the body brace."""
    lines = text.split("\n")
    depth = 0
    for k, line in enumerate(lines):
        for c in split_tokens(line):
            if c == "{":
                depth += 1
        if depth:
            return "\n".join(lines[:k + 1]), "\n".join(lines[k + 1:])
    return text, ""


def normalize_visibility(text):
    return "\n".join(VIS.sub(r"\1", line) for line in text.split("\n"))


def tokens(text):
    return " ".join(normalize_visibility(text).split())


def signature_tokens(text):
    """Whitespace- and comma-insensitive signature form.

    rustfmt re-wraps a signature that no longer fits on one line and emits a
    trailing comma after the last parameter; both are pure formatting.
    """
    return "".join(normalize_visibility(text).replace(",", "").split())


def literals(text):
    """[(line_no, literal)] for every string literal, in source order."""
    lines = text.split("\n")
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        m = re.match(r'(b?r)(#*)"', text[i:])
        if m:
            term = '"' + m.group(2)
            j = text.find(term, i + len(m.group(0)))
            j = n if j < 0 else j
            ln = text.count("\n", 0, i) + 1
            out.append((ln, text[i:j + len(term)]))
            i = j + len(term)
            continue
        if c == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append((text.count("\n", 0, i) + 1, text[i:j + 1]))
            i = j + 1
            continue
        i += 1
    return out


def command_lines(text):
    return [(k + 1, line.strip())
            for k, line in enumerate(text.split("\n")) if CMD.search(line)]


def in_ranges(line_no, ranges):
    return any(start <= line_no <= end for start, end in ranges)


def base_source(base_sha):
    try:
        return subprocess.run(["git", "-C", REPO, "show", "%s:backend/src/ssh.rs" % base_sha],
                              check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError as error:
        raise SystemExit("cannot read %s:backend/src/ssh.rs: %s"
                         % (base_sha, error.stderr.strip()))


def check_fidelity(base_sha):
    base = base_source(base_sha)
    base_lines = base.split("\n")
    failures = 0
    reflows = []
    for fname, symbols in FILES.items():
        path = os.path.join(SRC, "ssh", fname)
        new_lines = open(path).read().split("\n")
        declared = [m.group("name") for m in (DECL.match(line) for line in new_lines)
                    if m and len(m.group("ind")) == (0 if fname in FREE_ITEM_FILES else 4)]
        want = set(symbols)
        got = set(declared)
        extra, missing = sorted(got - want), sorted(want - got)
        if extra or missing:
            failures += 1
        print("== %-20s items=%2d expected=%2d extra=%s missing=%s"
              % (fname, len(got), len(want), extra, missing))
        for symbol in symbols:
            expected = item_text(base_lines, symbol)
            actual = item_text(new_lines, symbol)
            expected_sig, expected_body = split_item(expected)
            actual_sig, actual_body = split_item(actual)
            body_ok = normalize_visibility(expected_body) == normalize_visibility(actual_body)
            if (normalize_visibility(expected_sig) == normalize_visibility(actual_sig)
                    and body_ok):
                print("   OK     %-32s %4d lines" % (symbol, expected.count("\n") + 1))
            elif body_ok and signature_tokens(expected_sig) == signature_tokens(actual_sig):
                reflows.append(symbol)
                print("   REFLOW %-32s %4d -> %d lines (same tokens, rustfmt re-wrap "
                      "+ trailing comma)" % (symbol, expected.count("\n") + 1,
                                             actual.count("\n") + 1))
            else:
                failures += 1
                print("   FAIL   %s" % symbol)
                for line in difflib.unified_diff(normalize_visibility(expected).split("\n"),
                                                 normalize_visibility(actual).split("\n"),
                                                 "base", "new", lineterm="", n=2):
                    print("      " + line)
    total = sum(len(s) for s in FILES.values())
    print("\nfidelity: %d/%d items character-identical after visibility normalization"
          % (total - len(reflows), total))
    if reflows:
        print("fidelity: whitespace-only reflows (accepted): %s" % ", ".join(reflows))
    print("RESULT:", "FAIL" if failures else "PASS")
    return failures


def check_surface(base_sha):
    base = base_source(base_sha)
    base_lines = base.split("\n")
    new_ssh = open(SSH_RS).read()
    base_lits = literals(base)
    base_cmds = command_lines(base)
    print("baseline ssh.rs: %d string literals, %d sudo_exec/Command::new/ssh2:: lines"
          % (len(base_lits), len(base_cmds)))
    failures = 0
    moved = []
    for fname, symbols in FILES.items():
        path = os.path.join(SRC, "ssh", fname)
        new_text = open(path).read()
        new_lits = literals(new_text)
        new_cmds = command_lines(new_text)
        for symbol in symbols:
            span = item_span(base_lines, symbol)
            moved.append(span)
            new_span = item_span(new_text.split("\n"), symbol)
            lhs = [lit for (ln, lit) in base_lits if span[0] + 1 <= ln <= span[1] + 1]
            rhs = [lit for (ln, lit) in new_lits if new_span[0] + 1 <= ln <= new_span[1] + 1]
            lhs_cmd = [line for (ln, line) in base_cmds if span[0] + 1 <= ln <= span[1] + 1]
            rhs_cmd = [line for (ln, line) in new_cmds
                       if new_span[0] + 1 <= ln <= new_span[1] + 1]
            ok = lhs == rhs and lhs_cmd == rhs_cmd
            if not ok:
                failures += 1
                for a, b in zip(lhs, rhs):
                    if a != b:
                        print("   literal differs:\n     base %r\n     new  %r" % (a, b))
                for a, b in zip(lhs_cmd, rhs_cmd):
                    if a != b:
                        print("   cmd line differs:\n     base %r\n     new  %r" % (a, b))
            print("%-4s %-32s literals %3d==%-3d cmdlines %d==%d"
                  % ("OK" if ok else "FAIL", symbol, len(lhs), len(rhs), len(lhs_cmd), len(rhs_cmd)))
    rest_lits = [lit for (ln, lit) in base_lits if not in_ranges(ln, moved)]
    rest_cmds = [line for (ln, line) in base_cmds if not in_ranges(ln, moved)]
    new_rest_lits = [lit for (_, lit) in literals(new_ssh)]
    new_rest_cmds = [line for (_, line) in command_lines(new_ssh)]
    ok = rest_lits == new_rest_lits and rest_cmds == new_rest_cmds
    if not ok:
        failures += 1
    print("%-4s %-32s literals %4d==%-4d cmdlines %d==%d"
          % ("OK" if ok else "FAIL", "remaining ssh.rs", len(rest_lits), len(new_rest_lits),
             len(rest_cmds), len(new_rest_cmds)))
    print("RESULT:", "FAIL" if failures else "PASS")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("check", choices=["fidelity", "surface"])
    parser.add_argument("--base", default=os.environ.get("B4_BASE_SHA", "24468407"),
                        help="base commit (default: 24468407, the B4 base)")
    args = parser.parse_args()
    failures = check_fidelity(args.base) if args.check == "fidelity" else check_surface(args.base)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
