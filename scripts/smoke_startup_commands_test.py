#!/usr/bin/env python3
"""Startup commands smoke against a local SSH container (M7 P0-4).

Covers the connection-scoped `startup_commands` preference (Tabby "Login
scripts" parity):
  1. `local/preferences/set` accepts the `startup_commands` store (allowlisted
     preferences key) and `local/preferences/get` reads it back sanitized;
  2. after `ssh/session/open` the sidecar types the configured commands into
     the PTY in order — visible as their echo on the terminal output channel;
  3. the `ssh/startup` event reports the count and completion, and never the
     command contents.

Runs against a throwaway sidecar data dir so leftover preferences from other
smoke runs cannot leak in.

Usage:
    python3 scripts/smoke_startup_commands_test.py                 # default container
    python3 scripts/smoke_startup_commands_test.py --host H --port P ...
    DBX_PLUGIN_SIDECAR=/path/to/binary python3 scripts/smoke_startup_commands_test.py
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

TERMINAL_OUT_PREFIX = "ssh/terminal/out/"
MARKER_ONE = "DBX_STARTUP_ONE"
MARKER_TWO = "DBX_STARTUP_TWO"


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
    args = parser.parse_args()

    started = time.monotonic()
    # Throwaway data dir: the preferences store must start clean for this run.
    data_dir = tempfile.mkdtemp(prefix="dbx-ssh-smoke-startup-")
    client = SidecarClient.start(timeout=30, data_dir=data_dir)
    try:
        step("plugin/initialize")
        print(json.dumps(client.initialize(), ensure_ascii=False)[:120])

        connection_id = "smoke-startup-commands"
        workbench_id = "smoke-startup-workbench"

        step("local/preferences/set startup_commands")
        client.request("local/preferences/set", {
            "startup_commands": {
                connection_id: {
                    "enabled": True,
                    "commands": [
                        {"command": f"echo {MARKER_ONE}", "delayMs": 200},
                        {"command": f"echo {MARKER_TWO}", "delayMs": 200},
                    ],
                },
            },
        })
        prefs = client.request("local/preferences/get")
        store = (prefs.get("startup_commands") or {}).get(connection_id) or {}
        rows = store.get("commands") or []
        if not store.get("enabled") or len(rows) != 2:
            fail(f"startup_commands preference not persisted: {json.dumps(prefs)[:200]}", client)
        print(f"    stored rows={len(rows)} enabled={store.get('enabled')}")

        connection = {
            "id": connection_id,
            "name": "smoke-startup-commands",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }

        step("connection/connect")
        print(json.dumps(client.request("connection/connect", lifecycle_params(connection)),
                         ensure_ascii=False))

        step("ssh/session/open")
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": workbench_id,
                                  "cols": 120, "rows": 30},
                                 timeout=60, on_event=auto_accept_challenge)
        session_id = session.get("sessionId", workbench_id)
        print(f"    session {session_id}")

        step("wait for startup commands to be typed (echo markers)")
        baseline = sum(1 for c, _ in client.binary_frames if c.startswith(TERMINAL_OUT_PREFIX))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            client.timeout = 1.0
            try:
                client._pump(None)  # drain binary frames without a request
            except SidecarError:
                pass
            payload = b"".join(
                data for c, data in client.binary_frames[baseline:]
                if c.startswith(TERMINAL_OUT_PREFIX)
            )
            if MARKER_ONE.encode() in payload and MARKER_TWO.encode() in payload:
                print(f"    both command echoes observed ({len(payload)} bytes scanned)")
                break
            time.sleep(0.2)
        else:
            fail("startup command echoes not observed within 15s", client)

        step("ssh/startup event reports count + completion, no command contents")
        startup_events = [event for event in client.events
                          if event.get("method") == "ssh/startup"]
        if not startup_events:
            fail("no ssh/startup event captured", client)
        params = startup_events[-1].get("params", {})
        if params.get("count") != 2 or params.get("completed") is not True:
            fail(f"ssh/startup event payload unexpected: {json.dumps(params)}", client)
        serialized = json.dumps(startup_events[-1])
        if MARKER_ONE in serialized or MARKER_TWO in serialized:
            fail("ssh/startup event leaked command contents", client)
        print(f"    event: {json.dumps(params, ensure_ascii=False)}")

        step("remote-command sessions skip startup commands (documented semantics)")
        # Sanity: no further ssh/startup events arrive after the first burst —
        # the injector is one-shot per session. (Exec-session skip is covered by
        # backend unit tests; it needs a dedicated exec session to observe.)
        print("    skip: covered by backend unit tests (startup_commands::executes_for)")

        client.request("ssh/session/close", {"sessionId": session_id})
        print(f"\nPASS in {time.monotonic() - started:.1f}s")
    except Exception as error:  # noqa: BLE001 — smoke must report, not crash
        fail(f"{type(error).__name__}: {error}", client)
    finally:
        client.close()


if __name__ == "__main__":
    main()
