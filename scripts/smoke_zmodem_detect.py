#!/usr/bin/env python3
"""Smoke test for the #90 ZMODEM trigger detection on the SSH PTY output path.

The test container has no lrzsz (and the plugin deliberately does not answer
ZMODEM), so the remote shell EMITS the exact wire sequences instead:

- sz's ZRQINIT as lrzsz `zshhdr` sends it: `**\\x18B` + hex type "00" + 12 hex
  chars + CRLF(0x0D 0x8A) + XON(0x11)  -> must be suppressed (no sentinel
  bytes in any ssh/terminal/out frame) and produce exactly one `ssh/zmodem`
  event; a retry inside the window must not produce a second event.
- rz's ZRINIT (`**\\x18B01...`)                        -> must pass through
  byte-identical (the frontend zmodem.js sentry needs it for rz uploads) and
  must NOT trigger the event.
- plain text containing `**`                            -> passes untouched.

Usage:
    DBX_PLUGIN_SIDECAR=<debug sidecar> python3 scripts/smoke_zmodem_detect.py
"""

from __future__ import annotations

import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, lifecycle_params


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
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def drain(client: SidecarClient, session_id: str, budget: float) -> tuple[list[bytes], int]:
    """Collect stdout frames and ssh/zmodem event count for `budget` seconds."""
    deadline = time.monotonic() + budget
    chunks: list[bytes] = []
    seen_events = 0
    while time.monotonic() < deadline:
        client.timeout = max(0.2, deadline - time.monotonic())
        try:
            client._pump(None)
        except Exception:
            break
    remaining = []
    for channel, payload in client.binary_frames:
        if channel != f"ssh/terminal/out/{session_id}" or len(payload) < 9:
            remaining.append((channel, payload))
            continue
        if payload[0] == 0:  # TerminalStream::Stdout
            chunks.append(payload[9:])
    client.binary_frames = remaining
    for event in client.events:
        if event.get("method") == "ssh/zmodem" and event.get("params", {}).get("sessionId") == session_id:
            seen_events += 1
    client.events[:] = [e for e in client.events if e.get("method") != "ssh/zmodem"]
    return chunks, seen_events


def send(client: SidecarClient, session_id: str, line: str, seq: dict) -> None:
    seq["n"] += 1
    client.send_binary(f"ssh/terminal/in/{session_id}", struct.pack(">Q", seq["n"]) + line.encode() + b"\r")


def main() -> int:
    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    try:
        step("plugin/initialize")
        client.initialize()

        connection = {
            "id": "smoke-zmodem-connection",
            "name": "smoke-zmodem",
            "db_type": "ssh",
            "host": "127.0.0.1",
            "port": 2222,
            "username": "sshuser",
            "password": "DbxTest2026",
            "external_config": {"authentication": "password"},
        }
        step("connection/connect")
        client.request("connection/connect", lifecycle_params(connection), on_event=auto_accept_challenge)

        step("ssh/session/open")
        session = client.request(
            "ssh/session/open",
            {"connectionId": connection["id"], "workbenchId": "smoke-zmodem", "cols": 120, "rows": 30},
            timeout=60,
            on_event=auto_accept_challenge,
        )
        session_id = session.get("sessionId", "smoke-zmodem")
        print(f"    session {session_id}")

        seq = {"n": 0}
        deadline = time.monotonic() + 30
        prompt_seen = False
        while time.monotonic() < deadline and not prompt_seen:
            chunks, _ = drain(client, session_id, 0.5)
            prompt_seen = b"$ " in b"".join(chunks) or b"# " in b"".join(chunks)
        if not prompt_seen:
            fail("shell prompt did not appear within 30s", client)

        # sz's ZRQINIT, byte-exact as lrzsz zshhdr() puts it on the wire.
        zrqinit_octal = r"printf '\052\052\030B0000000000000000\015\212\021'"
        step("sz ZRQINIT: suppressed + one ssh/zmodem event")
        send(client, session_id, f"{zrqinit_octal}; echo AFTER_ZRQINIT", seq)
        chunks, events = drain(client, session_id, 4.0)
        merged = b"".join(chunks)
        if events != 1:
            fail(f"expected exactly 1 ssh/zmodem event, got {events}", client)
        if b"\x2a\x2a\x18\x42" in merged:
            fail("ZRQINIT sentinel leaked into terminal output frames", client)
        if b"AFTER_ZRQINIT" not in merged:
            fail("plain text after the ZRQINIT frame did not reach the terminal", client)
        print("    PASS: event=1, sentinel suppressed, surrounding text intact")

        step("retry inside suppression window: no second event")
        send(client, session_id, zrqinit_octal, seq)
        chunks, events = drain(client, session_id, 3.0)
        merged = b"".join(chunks)
        if events != 0:
            fail(f"retry inside window produced {events} extra ssh/zmodem event(s)", client)
        if b"\x2a\x2a\x18\x42" in merged:
            fail("retried ZRQINIT sentinel leaked into terminal output frames", client)
        print("    PASS: no second event, retry suppressed")

        # rz's ZRINIT (hex type "01"): must pass through byte-identical so the
        # frontend zmodem.js sentry can still confirm the upload flow.
        zrinit_octal = r"printf '\052\052\030B0100000023be50\015\212\021'"
        step("rz ZRINIT: passes through untouched, no event")
        send(client, session_id, f"echo MARK_BEFORE_RZ; {zrinit_octal}; echo MARK_AFTER_RZ", seq)
        chunks, events = drain(client, session_id, 4.0)
        merged = b"".join(chunks)
        if events != 0:
            fail(f"ZRINIT wrongly produced {events} ssh/zmodem event(s)", client)
        if b"\x2a\x2a\x18\x42\x30\x31" not in merged:
            fail("ZRINIT header did not reach terminal output frames (upload flow would break)", client)
        if b"MARK_AFTER_RZ" not in merged:
            fail("text after ZRINIT did not reach the terminal", client)
        print("    PASS: ZRINIT intact, no event")

        step("plain text with '**' passes untouched")
        send(client, session_id, "echo 'power ** 2 and *stars*'", seq)
        chunks, events = drain(client, session_id, 3.0)
        merged = b"".join(chunks)
        if events != 0:
            fail(f"plain text wrongly produced {events} ssh/zmodem event(s)", client)
        if b"power ** 2 and *stars*" not in merged:
            fail("plain text containing '**' was mangled", client)
        print("    PASS: plain text intact")

        client.request("ssh/session/close", {"sessionId": session_id}, timeout=15)
        client.request("connection/disconnect", lifecycle_params(connection), timeout=30)
        print(f"\nALL PASS ({time.monotonic() - started:.1f}s)")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
