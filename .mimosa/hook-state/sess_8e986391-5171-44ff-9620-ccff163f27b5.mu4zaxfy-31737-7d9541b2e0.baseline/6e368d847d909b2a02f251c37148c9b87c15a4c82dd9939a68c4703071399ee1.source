#!/usr/bin/env python3
"""Validate a directory of unsigned .dbxp candidate packages across targets.

Mirrors the checks the official plugin release pipeline applies before
uploading release assets (see t8y2/dbx plugin-release-reusable.yml):
metadata integrity, unsigned review candidate, manifest identity
consistency across targets, and target uniqueness. Pure stdlib, no
network, no signing.

Usage:
  check_candidates.py [DIR] [--expect t1,t2,...]
  check_candidates.py dist --expect linux-x64,linux-arm64,darwin-arm64,darwin-x64,windows-x64
"""

import argparse
import hashlib
import json
import pathlib
import re
import sys
import zipfile
from urllib.parse import urlparse

TARGET_RE = re.compile(r"^[a-z0-9-]{1,64}$")
SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
IDENTITY_FIELDS = ("id", "name", "description", "publisher", "version")


def package_name_from_url(url: str) -> str:
    return pathlib.PurePosixPath(urlparse(url).path).name


def read_manifest(package: pathlib.Path) -> dict:
    with zipfile.ZipFile(package) as archive:
        return json.loads(archive.read("manifest.json"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory", nargs="?", default="dist",
                        help="directory holding .dbxp and .artifact.json files (default: dist)")
    parser.add_argument("--expect", default="",
                        help="comma-separated target list that must all be present")
    parser.add_argument("--write-release-candidates", default="",
                        help="write the merged release-candidates.json to this path after all checks pass")
    args = parser.parse_args()

    root = pathlib.Path(args.directory)
    errors: list[str] = []

    packages: dict[str, pathlib.Path] = {}
    for path in sorted(root.rglob("*.dbxp")):
        if path.name in packages:
            errors.append(f"duplicate package filename {path.name}")
        packages[path.name] = path

    metadata_paths = sorted(root.rglob("*.artifact.json"))
    if not metadata_paths:
        errors.append(f"no .artifact.json files found under {root}")
    if not packages:
        errors.append(f"no .dbxp files found under {root}")
    if errors:
        for message in errors:
            print(f"FAIL {message}", file=sys.stderr)
        return 1

    identities: dict[str, list[str]] = {}
    seen_targets: dict[str, str] = {}
    artifacts: list[dict] = []

    for metadata_path in metadata_paths:
        try:
            metadata = json.loads(metadata_path.read_text())
        except (json.JSONDecodeError, OSError) as error:
            errors.append(f"unreadable metadata {metadata_path}: {error}")
            continue

        target = metadata.get("target") or ""
        if not TARGET_RE.fullmatch(target):
            errors.append(f"{metadata_path}: invalid artifact target {target!r}")
            continue
        if metadata.get("signingKeyId") is not None:
            errors.append(f"{metadata_path}: candidate must not declare signingKeyId")

        sha256 = metadata.get("sha256") or ""
        size = metadata.get("size")
        if not SHA256_RE.fullmatch(sha256):
            errors.append(f"{metadata_path}: invalid sha256 {sha256!r}")
        if not isinstance(size, int) or size < 0:
            errors.append(f"{metadata_path}: invalid size {size!r}")

        package_name = package_name_from_url(metadata.get("url") or "")
        package = packages.get(package_name)
        if package is None:
            errors.append(f"{metadata_path}: references missing package {package_name!r}")
            continue
        if target in seen_targets:
            errors.append(f"duplicate artifact target {target} ({seen_targets[target]}, {package_name})")
        seen_targets[target] = package_name

        if SHA256_RE.fullmatch(sha256) and isinstance(size, int):
            data = package.read_bytes()
            if len(data) != size:
                errors.append(f"{package_name}: metadata size {size} != actual {len(data)}")
            actual_sha = hashlib.sha256(data).hexdigest()
            if actual_sha != sha256.lower():
                errors.append(f"{package_name}: metadata sha256 mismatch (actual {actual_sha})")

        try:
            manifest = read_manifest(package)
        except (KeyError, zipfile.BadZipFile, json.JSONDecodeError) as error:
            errors.append(f"{package_name}: unreadable manifest.json: {error}")
            continue

        identity = {field: manifest.get(field) for field in IDENTITY_FIELDS}
        identity["permissions"] = sorted(manifest.get("permissions") or [])
        if not identity["id"] or not identity["name"] or not identity["publisher"] or not identity["version"]:
            errors.append(f"{package_name}: incomplete manifest identity {identity}")
        identity_key = json.dumps(identity, sort_keys=True, ensure_ascii=False)
        identities.setdefault(identity_key, []).append(target)

        artifacts.append({"target": target, "url": package_name,
                          "sha256": sha256.lower() if SHA256_RE.fullmatch(sha256) else sha256,
                          "size": size})

    if len(identities) > 1:
        variants = "; ".join(f"{targets}: {key}" for key, targets in sorted(identities.items()))
        errors.append(f"manifest identity differs across targets — {variants}")

    expected = [name for name in (item.strip() for item in args.expect.split(",")) if name]
    missing = [name for name in expected if name not in seen_targets]
    if missing:
        errors.append(f"missing expected targets: {', '.join(missing)} (found {sorted(seen_targets)})")

    print(f"Candidate packages in {root}:")
    for artifact in sorted(artifacts, key=lambda item: item["target"]):
        print(f"  {artifact['target']:<14} {artifact['url']}  sha256={artifact['sha256'][:16]}…  {artifact['size']} bytes")
    if expected:
        print(f"Expected targets present: {not missing}")
    print(f"Manifest identity: {'consistent' if len(identities) == 1 else 'INCONSISTENT'} across {sum(len(t) for t in identities.values())} target(s)")

    if errors:
        for message in errors:
            print(f"FAIL {message}", file=sys.stderr)
        return 1

    if args.write_release_candidates:
        # Same schema the official plugin release pipeline uploads alongside
        # the packages: shared manifest identity plus per-target metadata
        # sorted by target.
        identity_key = next(iter(identities))
        payload = {
            "plugin": json.loads(identity_key),
            "artifacts": sorted(artifacts, key=lambda item: item["target"]),
        }
        output = pathlib.Path(args.write_release_candidates)
        output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        print(f"Wrote {output}")
    print("OK all candidate checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
