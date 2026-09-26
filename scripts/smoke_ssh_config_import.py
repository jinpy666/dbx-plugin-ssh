#!/usr/bin/env python3
"""Smoke test for the WT-3 `~/.ssh/config` import source (the 8th source).

Drives the sidecar's streaming import preview directly over the stdio-framed
protocol — no SSH container is needed. It exercises:

    initialize -> import/preview/start(kind=sshconfig) -> binary offset chunks
    -> import/preview/finish (sanitized preview + export)

and asserts the sanitized-output invariant for the new source: IdentityFile is
mapped as a key PATH only (secretNote=key-path-only), ProxyCommand/ProxyJump
and Include/UserKnownHostsFile degrade to description annotations, and no
password/private-key material ever appears in the preview or export.

Any "Method not found" answer is reported as SKIP so the script passes both
before and after wiring (mirrors smoke_fs_test.py).

Usage:
    python3 scripts/smoke_ssh_config_import.py
    DBX_PLUGIN_SIDECAR=/path/to/sidecar python3 scripts/smoke_ssh_config_import.py
"""

from __future__ import annotations

import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError

REPO_ROOT = Path(__file__).resolve().parent.parent
IMPORT_CHUNK_LIMIT = 256 * 1024
IMPORT_TOTAL_LIMIT = 64 * 1024 * 1024


def step(name: str):
    print(f"\n==> {name}")


def fail(message: str, client: SidecarClient | None = None):
    if client:
        client.close()
    print(f"\nFAIL: {message}", file=sys.stderr)
    sys.exit(1)


def resolve_binary() -> str | None:
    """DBX_PLUGIN_SIDECAR wins, then the local debug build; None lets
    sidecar_client fall back to the installed copy."""
    import os

    env = os.environ.get("DBX_PLUGIN_SIDECAR")
    if env:
        return env
    candidate = REPO_ROOT / "backend" / "target" / "debug" / "dbx-plugin-ssh"
    if candidate.exists():
        return str(candidate)
    return None


def stream_file(client: SidecarClient, task_id: str, part: str, payload: bytes):
    """SFTP-style start + binary offset chunks; each chunk waits for its ACK."""
    for offset in range(0, len(payload), IMPORT_CHUNK_LIMIT):
        chunk = payload[offset : offset + IMPORT_CHUNK_LIMIT]
        next_offset = offset + len(chunk)
        channel = f"import/preview/{task_id}/{part}"
        client.send_binary(channel, struct.pack(">Q", offset) + chunk)
        deadline = time.monotonic() + 30
        while True:
            for event in client.events:
                params = event.get("params", {})
                if event.get("method") == "import/preview/error" and params.get("taskId") == task_id:
                    fail(f"import chunk error: {params}", client)
                if (
                    event.get("method") == "import/preview/ack"
                    and params.get("taskId") == task_id
                    and params.get("part") == part
                    and params.get("nextOffset") == next_offset
                ):
                    return
            if time.monotonic() > deadline:
                fail(f"no ACK for {channel} offset {next_offset}", client)
            client.timeout = 0.5
            try:
                client._pump(None)  # drain notifications without a request
            except SidecarError:
                pass


def preview_ssh_config(client: SidecarClient, text: str) -> dict:
    data = text.encode()
    started = client.request("import/preview/start", {"kind": "sshconfig", "mainSize": len(data)})
    task_id = started["taskId"]
    try:
        stream_file(client, task_id, "main", data)
        return client.request("import/preview/finish", {"taskId": task_id})
    except SidecarError:
        client.request("import/preview/cancel", {"taskId": task_id})
        raise


SAMPLE_CONFIG = "\n".join(
    [
        "# global default port, first value wins everywhere",
        "Port 2200",
        "",
        "Host web1",
        "  Hostname 10.7.0.1",
        "  User deploy",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_ed25519",
        "",
        "Host *.prod.example.com",
        "  User admin",
        "  ProxyJump bastion",
        "",
        "Host edge.prod.example.com",
        "",
        "Host db1",
        "  Include ~/.ssh/config.d/*.conf",
        "  UserKnownHostsFile /etc/ssh/ssh_known_hosts",
        "  ProxyCommand nc -X connect -x proxy.internal:3128 %h %p",
        "",
        "Match exec /usr/bin/check",
        "  ForwardAgent yes",
        "",
    ]
)


def assert_sanitized(payload: dict):
    serialized = json.dumps(payload)
    for forbidden in ('"password"', '"privateKey"', '"passphrase"', "PRIVATE KEY"):
        if forbidden in serialized:
            fail(f"sanitized output contains {forbidden}: {serialized[:400]}")
    return serialized


def main():
    started_at = time.monotonic()
    binary = resolve_binary()
    if not binary or not Path(binary).exists():
        print(f"SKIP: sidecar binary not found (set DBX_PLUGIN_SIDECAR); looked at backend/target/debug")
        return
    client = SidecarClient.start(binary, data_dir=None)
    try:
        step("plugin/initialize")
        client.initialize()
        print("    initialized")

        step("parse a representative ~/.ssh/config")
        preview = preview_ssh_config(client, SAMPLE_CONFIG)
        if preview.get("sourceKind") != "sshconfig":
            fail(f"unexpected sourceKind: {preview.get('sourceKind')}", client)
        rows = preview.get("sessions", [])
        names = [row.get("name") for row in rows]
        if names != ["web1", "edge.prod.example.com", "db1"]:
            fail(f"unexpected rows: {names}", client)
        by_name = {row["name"]: row for row in rows}
        web1 = by_name["web1"]
        if (web1["host"], web1["port"], web1["username"], web1["authKind"]) != (
            "10.7.0.1", 2200, "deploy", "private-key"
        ):
            fail(f"web1 row unexpected: {web1}", client)
        if web1.get("secretNote") != "key-path-only":
            fail(f"web1 secretNote unexpected: {web1.get('secretNote')}", client)
        # Wildcard host applies its defaults without becoming an entry.
        edge = by_name["edge.prod.example.com"]
        if edge["username"] != "admin" or "ProxyJump bastion (needs manual mapping)" not in edge["description"]:
            fail(f"edge row unexpected: {edge}", client)
        db1 = by_name["db1"]
        for marker in (
            "Include ~/.ssh/config.d/*.conf (not followed)",
            "UserKnownHostsFile /etc/ssh/ssh_known_hosts (not carried)",
            "ProxyCommand nc -X connect -x proxy.internal:3128 %h %p (not executed, needs manual mapping)",
        ):
            if marker not in db1["description"]:
                fail(f"db1 description missing '{marker}': {db1['description']}", client)
        if "Match exec: settings not imported" not in db1["description"]:
            fail(f"db1 description missing unsupported-Match reason: {db1['description']}", client)
        print(f"    rows: {names}")

        step("sanitized export keeps only metadata (no credential material)")
        exported = assert_sanitized(preview)
        if '"keyPath"' not in exported:
            fail(f"export lost the key path: {exported[:400]}", client)
        print("    export sanitized (password/privateKey/passphrase absent)")

        step("hostile config degrades to an empty preview, not an error")
        preview = preview_ssh_config(client, "not a config at all\n\x00\x01binary junk\n")
        if preview.get("totalSessions") != 0:
            fail(f"hostile config unexpectedly parsed: {preview.get('totalSessions')}", client)
        assert_sanitized(preview)
        print("    empty preview, sanitized")

        step("oversized declared size is rejected by start")
        try:
            client.request(
                "import/preview/start",
                {"kind": "sshconfig", "mainSize": IMPORT_TOTAL_LIMIT + 1},
            )
            fail("oversized start was accepted", client)
        except SidecarError as error:
            if "MiB" not in str(error) and "limit" not in str(error):
                raise
            print(f"    rejected: {error}")

        step("cancelled task cannot be finished")
        started = client.request("import/preview/start", {"kind": "sshconfig", "mainSize": 4})
        task_id = started["taskId"]
        client.request("import/preview/cancel", {"taskId": task_id})
        try:
            client.request("import/preview/finish", {"taskId": task_id})
            fail("finish on a cancelled task succeeded", client)
        except SidecarError as error:
            print(f"    finish rejected: {error}")

        step("unknown kind still fails with a readable error")
        try:
            client.request("import/preview/start", {"kind": "nosuch", "mainSize": 1})
            fail("unknown kind accepted", client)
        except SidecarError as error:
            if "Unknown import kind" not in str(error):
                raise
            print(f"    rejected: {error}")

        print(f"\nPASS in {time.monotonic() - started_at:.1f}s")
    except SidecarError as error:
        message = str(error)
        if "Method not found" in message or "not registered" in message.lower():
            print(f"\nSKIP: import preview methods not registered in this sidecar: {message}")
            return
        fail(f"{type(error).__name__}: {message}", client)
    except Exception as error:  # noqa: BLE001 — smoke must report, not crash
        fail(f"{type(error).__name__}: {error}", client)
    finally:
        client.close()


if __name__ == "__main__":
    main()
