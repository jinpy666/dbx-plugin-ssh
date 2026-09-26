#!/usr/bin/env python3
"""WT-4 command-session (WezTerm `spawn` parity) smoke against a local SSH container.

Covers the `spawnCommand` parameter of `ssh/session/open`
(docs/PROTOCOL.zh-CN.md「同 transport 命令会话」):
  1. spawn session lifecycle: a base session is opened, then a command
     session reuses the authenticated transport with `spawnCommand`; the
     command's output must appear on the new session's terminal stream and
     both sessions close cleanly;
  2. shared-reference concurrent close: with base + spawn (reuse) both live,
     closing the base session must NOT tear down the spawn session (each
     holds its own transport lease); closing the spawn session then releases
     the final reference and both rows disappear from `ssh/sessions/list`.

Usage:
    python3 scripts/smoke_spawn_session_test.py                 # default container
    python3 scripts/smoke_spawn_session_test.py --host H --port P ...
    DBX_PLUGIN_SIDECAR=/path/to/binary python3 scripts/smoke_spawn_session_test.py
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
SPAWN_MARKER = "==WT4-SPAWN-MARKER=="
SPAWN_COMMAND = f"printf '\\n {SPAWN_MARKER} \\n'; sleep 5"
HOLD_COMMAND = "sleep 60"


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


def open_session(client: SidecarClient, connection_id: str, workbench_id: str,
                 reuse: dict | None = None, spawn_command: str | None = None) -> dict:
    params = {"connectionId": connection_id, "workbenchId": workbench_id, "cols": 120, "rows": 30}
    if reuse:
        params.update(reuse)
    if spawn_command is not None:
        params["spawnCommand"] = spawn_command
    return client.request("ssh/session/open", params, timeout=60, on_event=auto_accept_challenge)


def sessions_for(client: SidecarClient, connection_id: str) -> list[dict]:
    listing = client.request("ssh/sessions/list")
    rows = listing.get("sessions", listing if isinstance(listing, list) else [])
    return [r for r in rows if r.get("connectionId") == connection_id]


def drain_output(client: SidecarClient, seconds: float) -> bytes:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        client.timeout = 0.5
        try:
            client._pump(None)  # noqa: SLF001 — smoke drains raw binary frames
        except SidecarError:
            pass
        except Exception:  # noqa: BLE001 — treat any framed error as quiet channel
            break
    return b"".join(data for chan, data in client.binary_frames if chan.startswith(TERMINAL_OUT_PREFIX))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    args = parser.parse_args()

    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    connection_id = "smoke-spawn-session"
    try:
        step("plugin/initialize")
        print(json.dumps(client.initialize(), ensure_ascii=False)[:120])

        connection = {
            "id": connection_id,
            "name": "smoke-spawn-session",
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

        # ------------------------------------------------------------------
        # Case 1: spawn session open/close (command runs, output observable).
        # ------------------------------------------------------------------
        step("case 1: base shell session")
        base = open_session(client, connection_id, "smoke-spawn-base")
        base_id = base.get("sessionId", "smoke-spawn-base")
        print(f"    base session {base_id}")

        step("case 1: spawn command session on the shared transport")
        spawned = open_session(
            client, connection_id, "smoke-spawn-cmd",
            reuse={"reuseAuthenticatedTransport": True, "reuseAuthenticatedSessionId": base_id},
            spawn_command=SPAWN_COMMAND,
        )
        spawned_id = spawned["sessionId"]
        if spawned_id == base_id:
            fail("spawn session must own its own sessionId", client)
        print(f"    spawned session {spawned_id} (command: {SPAWN_COMMAND})")

        step("case 1: command output reaches the spawned terminal stream")
        output = drain_output(client, 4.0)
        if SPAWN_MARKER.encode() not in output:
            fail(f"marker {SPAWN_MARKER!r} not found in spawned terminal output "
                 f"({len(output)} bytes captured)", client)
        print(f"    marker observed in {len(output)} bytes of terminal output")

        step("case 1: close spawned session, then base session")
        client.request("ssh/session/close", {"sessionId": spawned_id})
        client.request("ssh/session/close", {"sessionId": base_id})
        remaining = sessions_for(client, connection_id)
        if remaining:
            fail(f"expected no sessions after case 1 close, found {remaining}", client)
        print("    both sessions closed cleanly")

        # ------------------------------------------------------------------
        # Case 2: shared-reference concurrent close semantics.
        # ------------------------------------------------------------------
        step("case 2: base session + long-running spawn session")
        base = open_session(client, connection_id, "smoke-spawn-base-2")
        base_id = base.get("sessionId", "smoke-spawn-base-2")
        spawned = open_session(
            client, connection_id, "smoke-spawn-cmd-2",
            reuse={"reuseAuthenticatedTransport": True, "reuseAuthenticatedSessionId": base_id},
            spawn_command=HOLD_COMMAND,
        )
        spawned_id = spawned["sessionId"]
        rows = {r["sessionId"]: r for r in sessions_for(client, connection_id)}
        if base_id not in rows or spawned_id not in rows:
            fail(f"expected both sessions in ssh/sessions/list, got {sorted(rows)}", client)
        if not all(rows[sid].get("connected") for sid in (base_id, spawned_id)):
            fail(f"both sessions must be connected, got {rows}", client)
        print(f"    base={base_id} spawned={spawned_id} both connected")

        step("case 2: close the base session — spawn must stay connected")
        client.request("ssh/session/close", {"sessionId": base_id})
        time.sleep(0.5)
        rows = {r["sessionId"]: r for r in sessions_for(client, connection_id)}
        if base_id in rows:
            fail("base session still listed after close", client)
        if spawned_id not in rows or not rows[spawned_id].get("connected"):
            fail("closing the base session must not tear down the spawn session "
                 "(each holds its own transport lease)", client)
        print("    spawn session survived the base close (lease semantics)")

        step("case 2: close the spawned session — last reference released")
        client.request("ssh/session/close", {"sessionId": spawned_id})
        remaining = sessions_for(client, connection_id)
        if remaining:
            fail(f"expected no sessions after final close, found {remaining}", client)
        print("    all sessions closed, shared transport fully released")

        print(f"\nPASS in {time.monotonic() - started:.1f}s")
    except Exception as error:  # noqa: BLE001 — smoke must report, not crash
        fail(f"{type(error).__name__}: {error}", client)
    finally:
        client.close()


if __name__ == "__main__":
    main()
