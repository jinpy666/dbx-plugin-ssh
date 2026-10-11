#!/usr/bin/env python3
"""Validate the locally verifiable provenance of the vendored RDP chain.

This intentionally does not invent upstream archive checksums. It checks that
vendor registration remains complete and identifies entries that still require
an operator to record a source digest after obtaining the original artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR = REPO_ROOT / "backend" / "vendor"
README = VENDOR / "README.md"
CHAIN = (
    "ironrdp",
    "ironrdp-async",
    "ironrdp-client",
    "ironrdp-connector",
    "ironrdp-tls",
    "picky",
    "sspi",
)
LICENSE_NAMES = ("LICENSE", "LICENSE-APACHE", "LICENSE-MIT", "COPYING")


def tree_digest(crate_dir: Path) -> str:
    """Deterministic content hash of the vendored tree.

    Files are visited in sorted relative-path order and their bytes are
    CRLF-normalised before streaming into SHA-256, so the digest is stable
    across checkouts with different line-ending handling. Any unregistered
    edit to the tree changes the digest.
    """
    digest = hashlib.sha256()
    files = sorted(path for path in crate_dir.rglob("*") if path.is_file())
    for path in files:
        rel = path.relative_to(crate_dir).as_posix()
        data = path.read_bytes().replace(b"\r\n", b"\n")
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(len(data).to_bytes(8, "little"))
        digest.update(data)
    return digest.hexdigest()


def manifest_identity(crate: str) -> tuple[str, str]:
    manifest = VENDOR / crate / "Cargo.toml"
    text = manifest.read_text(encoding="utf-8")
    package = re.search(r"^\[package\]\s*$(.*?)^\[", text, re.M | re.S)
    if not package:
        raise ValueError(f"{crate}: missing [package] in Cargo.toml")
    name = re.search(r'^name\s*=\s*"([^"]+)"', package.group(1), re.M)
    version = re.search(r'^version\s*=\s*"([^"]+)"', package.group(1), re.M)
    if not name or not version:
        raise ValueError(f"{crate}: missing name/version in Cargo.toml")
    return name.group(1), version.group(1)


def registered_row(readme: str, crate: str, version: str) -> str | None:
    prefix = f"| `{crate}`"
    for line in readme.splitlines():
        if line.startswith(prefix) and f"| {version} |" in line:
            return line
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-recorded-hashes",
        action="store_true",
        help="fail when a source row lacks a recorded sha256 rather than reporting it for manual verification",
    )
    args = parser.parse_args()

    readme = README.read_text(encoding="utf-8")
    errors: list[str] = []
    pending_hashes: list[str] = []
    actual = {path.name for path in VENDOR.iterdir() if path.is_dir() and (path / "Cargo.toml").is_file()}
    if actual != set(CHAIN):
        errors.append(f"vendor crate set drifted: expected {', '.join(CHAIN)}; found {', '.join(sorted(actual))}")

    for crate in CHAIN:
        try:
            name, version = manifest_identity(crate)
        except (OSError, ValueError) as exc:
            errors.append(str(exc))
            continue
        if name != crate:
            errors.append(f"{crate}: manifest name is {name}")
        row = registered_row(readme, crate, version)
        if not row:
            errors.append(f"{crate} {version}: missing source registration row")
            continue
        if not re.search(r"(?<!tree-)sha256 `[0-9a-f]{64}`", row):
            pending_hashes.append(f"{crate} {version}")
        tree_match = re.search(r"tree-sha256 `([0-9a-f]{64})`", row)
        if not tree_match:
            pending_hashes.append(f"{crate} {version} (tree digest)")
        else:
            actual_digest = tree_digest(VENDOR / crate)
            if actual_digest != tree_match.group(1):
                errors.append(
                    f"{crate}: vendored tree drifted from the registered tree-sha256 "
                    f"(registered {tree_match.group(1)[:12]}…, actual {actual_digest[:12]}…) — "
                    "review the change, then re-register the digest in backend/vendor/README.md"
                )
        crate_dir = VENDOR / crate
        # ironrdp-client's upstream 0.1.0 package omits license files; the
        # registration documents the same-monorepo license inheritance. Other
        # crates must carry their own license file.
        if crate != "ironrdp-client" and not any((crate_dir / license_name).is_file() for license_name in LICENSE_NAMES):
            errors.append(f"{crate}: missing a license file ({', '.join(LICENSE_NAMES)})")

    if pending_hashes:
        message = "source hashes pending manual verification: " + ", ".join(pending_hashes)
        if args.require_recorded_hashes:
            errors.append(message)
        else:
            print(f"vendor integrity NOTICE: {message}")
    if errors:
        print("vendor integrity check FAILED:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("vendor integrity check PASS (identity/license/registration + tree digests verified)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
