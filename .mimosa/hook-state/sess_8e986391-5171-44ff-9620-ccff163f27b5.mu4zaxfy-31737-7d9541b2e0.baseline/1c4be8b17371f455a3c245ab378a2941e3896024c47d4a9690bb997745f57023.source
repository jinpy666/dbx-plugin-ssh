#!/usr/bin/env python3
"""Validate standalone SSH plugin identity and package-relative paths."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def main() -> int:
    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 1:
        fail("manifest_version must be 1")
    if manifest.get("id") != "io.dbx.ssh":
        fail(f"manifest id is {manifest.get('id')!r}, expected io.dbx.ssh")
    version = manifest.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        fail(f"invalid manifest version: {version!r}")
    for field in ("source", "homepage"):
        value = manifest.get(field, "")
        if not isinstance(value, str) or not value.startswith(("http://", "https://")):
            fail(f"{field} must be an HTTP(S) URL")

    entrypoint = manifest.get("entrypoints", {}).get("backend", {})
    if entrypoint.get("executable") != "bin/dbx-plugin-ssh":
        fail("backend executable must be bin/dbx-plugin-ssh")
    if manifest.get("entrypoints", {}).get("ui", {}).get("entry") != "ui/index.html":
        fail("UI entry must be ui/index.html")

    toml = (ROOT / "dbx-plugin.toml").read_text(encoding="utf-8")
    if 'directory = "backend"' not in toml or 'binary = "dbx-plugin-ssh"' not in toml:
        fail("dbx-plugin.toml backend identity/path is stale")

    cargo = (ROOT / "backend/Cargo.toml").read_text(encoding="utf-8")
    if not re.search(r'(?m)^name\s*=\s*"dbx-plugin-ssh"\s*$', cargo):
        fail("backend Cargo package name does not match manifest")
    if not re.search(rf'(?m)^version\s*=\s*"{re.escape(version)}"\s*$', cargo):
        fail("backend Cargo version does not match manifest")
    main_rs = (ROOT / "backend/src/main.rs").read_text(encoding="utf-8")
    if 'PluginMetadata::new("io.dbx.ssh", env!("CARGO_PKG_VERSION"))' not in main_rs:
        fail("backend initialization identity is missing or stale")

    required = [
        "assets/plugin.svg", "frontend/package.json", "backend/Cargo.toml",
        "scripts/test.sh", "scripts/connection-forms/verify.mjs",
        "shared/frontend/binaryEvent.ts", "shared/frontend/editorTheme.ts",
        "shared/frontend/themeSync.ts", "shared/sdk/rust/dbx-plugin-sdk/src/lib.rs",
    ]
    for relative in required:
        if not (ROOT / relative).exists():
            fail(f"missing required path: {relative}")

    print(f"PASS repository identity: {manifest['id']} {version}; standalone paths and vendored SDK present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
