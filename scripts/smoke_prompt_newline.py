#!/usr/bin/env python3
"""E2E smoke for the prompt hook / prompt-newline fix (t8y2/dbx#10750).

Connects the freshly built sidecar to the local SSH test container, opens an
interactive shell session and asserts that the session-open prompt hook makes
OSC 7 frames (`ESC]7;file://…BEL`) arrive before the prompts — including after
a command whose output has no trailing newline, which is exactly the stream
shape the frontend transformer keys on.

Usage:
    DBX_PLUGIN_SIDECAR=<sidecar binary> python3 scripts/smoke_prompt_newline.py
Requires the dbx-ssh-test container (see .zcode/skills/dbx-ssh-dev/SKILL.md).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, lifecycle_params

OSC7 = b"\x1b]7;"

host_key_state = {"accepted": False}


def auto_accept_challenge(event: dict) -> dict | None:
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params", {}).get("params") or event.get("params", {})
    if "challengeId" not in params:
        return None
    host_key_state["accepted"] = True
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def fail(message: str, client: SidecarClient):
    client.close()
    print(f"\nFAIL: {message}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    client.initialize()

    connection_id = "prompt-newline-smoke"
    workbench_id = "prompt-newline-smoke-wb"
    connection = {
        "id": connection_id,
        "name": "prompt-newline-smoke",
        "db_type": "ssh",
        "host": os.environ.get("SMOKE_HOST", "127.0.0.1"),
        "port": int(os.environ.get("SMOKE_PORT", "2222")),
        "username": os.environ.get("SMOKE_USER", "sshuser"),
        "password": os.environ.get("SMOKE_PASSWORD", "DbxTest2026"),
        "external_config": {"authentication": "password"},
    }
    client.request("connection/connect", lifecycle_params(connection))

    session = client.request(
        "ssh/session/open",
        {"connectionId": connection_id, "workbenchId": workbench_id, "cols": 120, "rows": 30},
        timeout=60,
        on_event=auto_accept_challenge,
    )
    session_id = session["sessionId"]
    print(f"session {session_id} opened")

    stream = b""

    def pump_until(predicate, budget: float, what: str) -> bool:
        nonlocal stream
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            for frame in list(client.binary_frames):
                channel, data = frame
                client.binary_frames.remove(frame)
                if channel == f"ssh/terminal/out/{session_id}":
                    stream += data
            if predicate(stream):
                return True
            client.timeout = max(0.5, deadline - time.monotonic())
            try:
                client._pump(None)
            except Exception:
                break
        return False

    # 1) session-open arming: OSC 7 frames arrive with the first prompts.
    if not pump_until(lambda s: s.count(OSC7) >= 1, 45, "first OSC 7 frame"):
        fail("no OSC 7 frame within 45s — prompt hook did not arm", client)
    print(f"OSC 7 frames after open: {stream.count(OSC7)}")

    # 2) the issue scenario: output without a trailing newline, then the next
    #    prompt — the hook must emit an OSC 7 frame AFTER the un-newlined
    #    output, which is what the frontend transformer inserts the CRLF on.
    marker = b"PROMPTNL_MARK"
    import struct

    def send_line(payload: bytes, seq: int) -> None:
        # terminal input rides the binary channel with a u64 BE sequence prefix
        client.send_binary(f"ssh/terminal/in/{session_id}", struct.pack(">Q", seq) + payload)

    send_seq = 0
    stream_before = len(stream)
    send_line(b"printf 'NO-NL-' && printf '" + marker + b"'\r", send_seq)
    send_seq += 1

    def marker_then_osc7(s: bytes) -> bool:
        tail = s[stream_before:]
        return marker in tail and tail.rfind(marker) < tail.rfind(OSC7)

    if not pump_until(marker_then_osc7, 30, "marker followed by OSC 7"):
        fail("output without trailing newline was not followed by an OSC 7 prompt frame", client)

    tail = stream[stream_before:]
    marker_pos = tail.rfind(marker)
    osc7_pos = tail.rfind(OSC7)
    between = tail[marker_pos + len(marker):osc7_pos]
    # Simulate the frontend rule on the captured tail: the transformer must
    # want a CRLF exactly when the bytes between marker output and the frame
    # do not end at a line start. Echo of the typed line means the output ends
    # with the marker text (no newline), so insertion is required.
    ends_at_line_start = between.endswith(b"\n") or between.endswith(b"\r")
    if ends_at_line_start:
        fail(f"unexpected newline between marker and prompt frame: {between!r}", client)
    print("marker output is followed by an OSC 7 prompt frame with no newline in between ✓")

    client.request("ssh/session/close", {"sessionId": session_id})
    client.close()
    print(f"\nPASS prompt-newline smoke in {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
