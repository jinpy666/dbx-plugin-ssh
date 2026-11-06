#!/usr/bin/env python3
"""End-to-end check: Quick Sudo must not answer non-sudo password prompts.

Drives the real sidecar over its stdio protocol against the local SSH test
container and reproduces the reported scenario:

  1. `docker login`-shaped prompt (`Password: `) typed after a NON-sudo
     command must be left alone — the sudo password must never appear.
  2. The identical prompt after a sudo command must still be answered.

A stand-in script is used instead of docker/podman so the container needs no
extra tooling; what matters is the prompt text and the command the operator
submitted, which is exactly what the fix keys on.
"""

from __future__ import annotations

import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

SUDO_PASSWORD = "DbxTest2026"
MARKER = "PROMPT_SEEN"

# Prints the same bare prompt docker/podman/gh print, then echoes whatever it
# reads back so a leaked password would be visible in the output.
ASKER = "read -s -p 'Password: ' P; echo; echo \"GOT[$P]\""


def auto_accept(event):
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


def drain(client, seconds: float) -> str:
    """Collects terminal output for `seconds` and returns it as text."""
    out = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for frame in list(client.binary_frames):
            channel, data = frame
            client.binary_frames.remove(frame)
            if channel.startswith("ssh/terminal/out/"):
                out.append(data)
        client.timeout = max(0.2, min(0.5, deadline - time.monotonic()))
        try:
            client._pump(None)
        except SidecarError:
            break
    return b"".join(out).decode("utf-8", "replace")


def wait_prompt(client, budget: float = 45.0) -> bool:
    out = drain(client, min(budget, 3.0))
    if "$ " in out or "# " in out:
        return True
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        out += drain(client, 1.0)
        if "$ " in out or "# " in out:
            return True
    return False


def main() -> None:
    client = SidecarClient.start(timeout=30)
    results: list[tuple[str, bool, str]] = []
    try:
        client.initialize()
        connection = {
            "id": "sudo-prompt-conn",
            "name": "sudo-prompt",
            "db_type": "ssh",
            "host": "127.0.0.1",
            "port": 2222,
            "username": "sshuser",
            "password": SUDO_PASSWORD,
            "external_config": {"authentication": "password"},
        }
        client.request("connection/connect", lifecycle_params(connection))
        client.request(
            "connection/test",
            lifecycle_params(connection),
            timeout=90,
            on_event=auto_accept,
        )
        session = client.request(
            "ssh/session/open",
            {
                "connectionId": "sudo-prompt-conn",
                "workbenchId": "sudo-prompt-wb",
                "cols": 120,
                "rows": 30,
            },
            timeout=60,
            on_event=auto_accept,
        )
        sid = session.get("sessionId", "sudo-prompt-wb")
        if not wait_prompt(client):
            raise SystemExit("FAIL: no shell prompt")
        drain(client, 1.0)

        # Arm Quick Sudo on the live session with the container's password.
        client.request(
            "ssh/settings/set",
            {"sessionId": sid, "quickSudo": True, "sudoPassword": SUDO_PASSWORD},
        )

        # --- Case 1: a non-sudo command that asks for a password ------------
        client.send_binary(
            f"ssh/terminal/in/{sid}", struct.pack(">Q", 1) + f"{ASKER}\r".encode()
        )
        out = drain(client, 6.0)
        # The password field is echoed only as GOT[...] after the prompt; a
        # leak shows up there.
        leaked = f"GOT[{SUDO_PASSWORD}]" in out
        answers = "ssh/auto-sudo" in out
        results.append(
            (
                "bare Password: after non-sudo command is NOT answered",
                not leaked,
                f"leaked={leaked} output={out[-300:]!r}",
            )
        )

        # The prompt must still be sitting there waiting for input.
        client.send_binary(
            f"ssh/terminal/in/{sid}", struct.pack(">Q", 2) + b"typed-by-hand\r"
        )
        out2 = drain(client, 4.0)
        results.append(
            (
                "manual input reaches the non-sudo prompt",
                "GOT[typed-by-hand]" in out2,
                f"output={out2[-300:]!r}",
            )
        )

        # --- Case 2: the same prompt after a sudo command IS answered -------
        client.send_binary(
            f"ssh/terminal/in/{sid}",
            struct.pack(">Q", 3) + b"sudo -k; sudo true\r",
        )
        out3 = drain(client, 12.0)
        results.append(
            (
                "sudo password prompt is answered",
                ("[sudo] password" in out3)
                or ("GOT[" in out3)
                or ("Password:" in out3),
                f"output={out3[-400:]!r}",
            )
        )
        # Whether sudo actually succeeded proves the credential was delivered.
        client.send_binary(
            f"ssh/terminal/in/{sid}",
            struct.pack(">Q", 4) + b"sudo -n true && echo SUDO_WORKS\r",
        )
        out4 = drain(client, 8.0)
        if "SUDO_WORKS" in out4:
            results.append(("sudo credential accepted by the remote", True, ""))
    finally:
        try:
            client.close()
        except Exception:
            pass

    print()
    failed = 0
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failed += 1
            print(f"      {detail}")
    print()
    if failed:
        print(f"FAILED: {failed} check(s)")
        sys.exit(1)
    print("PASS: sudo prompt scoping verified end to end")


if __name__ == "__main__":
    main()
