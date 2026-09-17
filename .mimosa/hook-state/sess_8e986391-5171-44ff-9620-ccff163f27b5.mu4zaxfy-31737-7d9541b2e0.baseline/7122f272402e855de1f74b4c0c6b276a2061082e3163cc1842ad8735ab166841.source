#!/usr/bin/env python3
"""Terminal activity keepalive smoke against a local SSH container.

Covers the opt-in `terminal_keepalive_secs` connection config:
  1. ssh/sessions/list reports `terminalKeepaliveSecs` for the session;
  2. during an idle window (> 2 keepalive intervals, no user input) the PTY
     receives the injected space+backspace pair — visible as its echo bytes
     on the terminal output channel;
  3. the session is still connected afterwards.

Usage:
    python3 scripts/smoke_terminal_keepalive_test.py                 # default container
    python3 scripts/smoke_terminal_keepalive_test.py --host H --port P ...
    DBX_PLUGIN_SIDECAR=/path/to/binary python3 scripts/smoke_terminal_keepalive_test.py
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

TERMINAL_OUT_PREFIX = "ssh/terminal/out/"


def step(name: str):
    print(f"\n==> {name}")


def fail(message: str, client: SidecarClient | None = None):
    if client:
        client.close()
    print(f"\nFAIL: {message}", file=sys.stderr)
    sys.exit(1)


def auto_accept_challenge(event: dict) -> dict | None:
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params", {}).get("params") or event.get("params", {})
    if "challengeId" not in params:
        return None
    print(f"    host-key challenge: {params.get('keyType')} {str(params.get('fingerprint'))[:32]}...")
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params.get("challengeId"),
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    parser.add_argument("--interval", type=int, default=5,
                        help="terminal_keepalive_secs for the smoke connection (5 = clamp floor)")
    args = parser.parse_args()

    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    try:
        step("plugin/initialize")
        print(json.dumps(client.initialize(), ensure_ascii=False)[:120])

        connection_id = "smoke-terminal-keepalive"
        workbench_id = "smoke-keepalive-workbench"
        connection = {
            "id": connection_id,
            "name": "smoke-terminal-keepalive",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {
                "authentication": "password",
                "terminal_keepalive_secs": args.interval,
            },
        }

        step("connection/connect (terminal_keepalive_secs=%d)" % args.interval)
        print(json.dumps(client.request("connection/connect", lifecycle_params(connection)),
                         ensure_ascii=False))

        step("ssh/session/open")
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": workbench_id,
                                  "cols": 120, "rows": 30},
                                 timeout=60, on_event=auto_accept_challenge)
        session_id = session.get("sessionId", workbench_id)
        print(f"    session {session_id}")

        step("ssh/sessions/list reports terminalKeepaliveSecs")
        listing = client.request("ssh/sessions/list")
        rows = listing.get("sessions", listing if isinstance(listing, list) else [])
        row = next((r for r in rows if r.get("sessionId") == session_id), None)
        if row is None:
            fail(f"session {session_id} missing from ssh/sessions/list", client)
        reported = row.get("terminalKeepaliveSecs")
        if reported != args.interval:
            fail(f"terminalKeepaliveSecs={reported!r}, expected {args.interval}", client)
        print(f"    terminalKeepaliveSecs={reported}")

        step("settle: wait for prompt output to go quiet")
        baseline = sum(1 for c, _ in client.binary_frames if c.startswith(TERMINAL_OUT_PREFIX))
        quiet_since = time.monotonic()
        while time.monotonic() - quiet_since < 1.5:
            client.timeout = 1.0
            try:
                client._pump(None)  # drain binary frames without a request
            except SidecarError:
                break
            now = sum(1 for c, _ in client.binary_frames if c.startswith(TERMINAL_OUT_PREFIX))
            if now > baseline:
                baseline = now
                quiet_since = time.monotonic()

        step(f"idle window: {args.interval * 2 + 3}s without user input")
        idle_start_frame = baseline
        deadline = time.monotonic() + args.interval * 2 + 3
        while time.monotonic() < deadline:
            client.timeout = 1.0
            try:
                client._pump(None)
            except SidecarError:
                # Quiet second between keepalive probes — keep waiting.
                pass
            time.sleep(0.2)

        idle_payload = b"".join(
            data for c, data in client.binary_frames[idle_start_frame:]
            if c.startswith(TERMINAL_OUT_PREFIX)
        )
        # The PTY echoes the injected pair: space echoes as-is, DEL (0x7f)
        # echoes as "\b \b" (ECHOE) or as 0x7f on raw-echo servers. Nothing
        # else writes during the idle window.
        echoed = b"\x08" in idle_payload or b"\x7f" in idle_payload
        if not echoed:
            fail(f"no keepalive injection observed in idle window "
                 f"(captured {len(idle_payload)} bytes: {idle_payload[:80]!r})", client)
        print(f"    keepalive echo observed: {idle_payload[:40]!r}")

        step("session still connected after idle window")
        row = next((r for r in client.request("ssh/sessions/list").get("sessions", [])
                    if r.get("sessionId") == session_id), None)
        if not row or not row.get("connected"):
            fail("session no longer connected after keepalive window", client)
        print("    connected=true")

        client.request("ssh/session/close", {"sessionId": session_id})
        print(f"\nPASS in {time.monotonic() - started:.1f}s")
    except Exception as error:  # noqa: BLE001 — smoke must report, not crash
        fail(f"{type(error).__name__}: {error}", client)
    finally:
        client.close()


if __name__ == "__main__":
    main()
