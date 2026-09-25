#!/usr/bin/env python3
"""Assert the vendored RDP fork chain stays in lockstep (Route B contract).

docs/RDP_VENDOR_FORK_PLAN.zh-CN.md section 6: the umbrella `ironrdp` and the
five patched crates (ironrdp-client / -connector / -tls, picky, sspi) move as
one set — never a single-crate bump. This script fails CI on drift between:

  1. backend/Cargo.toml [patch.crates-io] entries pointing into backend/vendor/
  2. the crates actually present under backend/vendor/
  3. the resolved [[package]] entries in backend/Cargo.lock (path-patched
     entries carry no `source`; a registry `source` means the patch stopped
     applying and the crates.io copy silently won)

Stdlib only; no third-party TOML parser required.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
VENDOR = BACKEND / "vendor"
BACKEND_TOML = BACKEND / "Cargo.toml"
CARGO_LOCK = BACKEND / "Cargo.lock"

# The lockstep set: umbrella first. Every entry must be patched and vendored;
# the umbrella 0.17 generation is bound to client 0.1.0 / connector 0.10.0.
RDP_LOCKSTEP_CHAIN = (
    "ironrdp",
    "ironrdp-client",
    "ironrdp-connector",
    "ironrdp-tls",
    "picky",
    "sspi",
)


class Drift(Exception):
    """Any lockstep violation; message is the CI-visible explanation."""


def parse_patch_section(text: str) -> dict[str, str]:
    """Extract [patch.crates-io] `name = { path = "..." }` entries."""
    section = re.search(
        r"^\[patch\.crates-io\]\s*$(.*?)^\[", text, re.M | re.S
    )
    if not section:
        raise Drift("backend/Cargo.toml has no [patch.crates-io] section")
    entries: dict[str, str] = {}
    for name, path in re.findall(
        r'^([\w-]+)\s*=\s*\{\s*path\s*=\s*"([^"]+)"', section.group(1), re.M
    ):
        entries[name] = path
    return entries


def parse_crate_manifest(manifest: Path) -> tuple[str, str]:
    """Return (name, version) from a normalized vendored Cargo.toml."""
    text = manifest.read_text(encoding="utf-8")
    pkg = re.search(r"^\[package\]\s*$(.*?)^\[", text, re.M | re.S)
    if not pkg:
        raise Drift(f"{manifest}: missing [package] section")
    name = re.search(r'^name\s*=\s*"([^"]+)"', pkg.group(1), re.M)
    version = re.search(r'^version\s*=\s*"([^"]+)"', pkg.group(1), re.M)
    if not name or not version:
        raise Drift(f"{manifest}: missing package name/version")
    return name.group(1), version.group(1)


def parse_lock_packages() -> dict[str, tuple[str, str | None]]:
    """Return {name: (version, source)} for every [[package]] in Cargo.lock."""
    text = CARGO_LOCK.read_text(encoding="utf-8")
    packages: dict[str, tuple[str, str | None]] = {}
    for block in re.split(r"^\[\[package\]\]\s*$", text, flags=re.M)[1:]:
        block = block.split("^[", 1)[0]
        name = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
        version = re.search(r'^version\s*=\s*"([^"]+)"', block, re.M)
        source = re.search(r'^source\s*=\s*"([^"]+)"', block, re.M)
        if name and version:
            packages[name.group(1)] = (
                version.group(1),
                source.group(1) if source else None,
            )
    return packages


def main() -> int:
    errors: list[str] = []
    try:
        patches = parse_patch_section(BACKEND_TOML.read_text(encoding="utf-8"))

        vendor_dirs = {
            d.name
            for d in VENDOR.iterdir()
            if d.is_dir() and (d / "Cargo.toml").is_file()
        }

        vendor_patches: dict[str, Path] = {}
        for name, path in patches.items():
            resolved = (BACKEND / path).resolve()
            if resolved.parent == VENDOR.resolve():
                vendor_patches[name] = resolved

        # 1. patch entries pointing into vendor/ must match vendor/ exactly.
        extra_dirs = sorted(vendor_dirs - set(vendor_patches))
        missing_dirs = sorted(set(vendor_patches) - vendor_dirs)
        if extra_dirs:
            errors.append(
                "vendored but not patched (add to [patch.crates-io]): "
                + ", ".join(extra_dirs)
            )
        if missing_dirs:
            errors.append(
                "patched but missing under backend/vendor/: "
                + ", ".join(missing_dirs)
            )

        # 2. the whole RDP chain must be patched (umbrella included).
        unpatched = [c for c in RDP_LOCKSTEP_CHAIN if c not in patches]
        if unpatched:
            errors.append(
                "lockstep chain members missing from [patch.crates-io]: "
                + ", ".join(unpatched)
            )

        # 3. lockfile: each chain member resolves from the vendored copy at
        # the exact version its manifest declares.
        lock = parse_lock_packages()
        for crate in RDP_LOCKSTEP_CHAIN:
            if crate not in lock:
                errors.append(f"{crate}: not present in Cargo.lock")
                continue
            version, source = lock[crate]
            if source is not None:
                errors.append(
                    f"{crate} {version}: resolved from registry ({source}); "
                    "the vendored patch is not being applied"
                )
            manifest = VENDOR / crate / "Cargo.toml"
            if not manifest.is_file():
                continue  # already reported above as a missing dir
            _, manifest_version = parse_crate_manifest(manifest)
            if manifest_version != version:
                errors.append(
                    f"{crate}: vendor manifest says {manifest_version} but "
                    f"Cargo.lock says {version} — regenerate the lockfile"
                )
    except Drift as exc:
        errors.append(str(exc))

    if errors:
        print("vendor lockstep check FAILED:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    versions = ", ".join(
        f"{c} {lock[c][0]}" for c in RDP_LOCKSTEP_CHAIN if c in lock
    )
    print(f"vendor lockstep check PASS ({versions})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
