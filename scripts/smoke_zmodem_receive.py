#!/usr/bin/env python3
"""End-to-end ZMODEM download (sz) smoke: real lrzsz `sz` in the test container
↔ real sidecar PTY pump ↔ the frontend's real receiver library (zmodem.js).

Architecture: this script drives the sidecar with sidecar_client.py (the only
place that knows the framing details) and pipes the terminal output stream into
scripts/zmodem_receive_bridge.mjs — a headless Node bridge running the actual
zmodem.js Sentry. The bridge's PTY-bound bytes flow back as terminal input, so
both protocol peers are the exact production pair; received files come back as
base64 and are verified against the remote's own md5sum.

Cases:
- single file (307200 B of urandom): name/size/content integrity
- multi-file batch with Chinese + spaces in names: both files, names intact
- cancel mid-transfer: abort sequence stops the remote sz, session stays usable

Environment:
    DBX_PLUGIN_SIDECAR=<sidecar binary>   (required)
    node on PATH + frontend/node_modules/zmodem.js   (required, else SKIP)

Usage:
    DBX_PLUGIN_SIDECAR=<sidecar> python3 scripts/smoke_zmodem_receive.py
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, lifecycle_params

BRIDGE = Path(__file__).parent / "zmodem_receive_bridge.mjs"

TYPE_TERM_OUT = 0x01
TYPE_EOF = 0x02
TYPE_ABORT = 0x03
TYPE_PTY_OUT = 0x81
TYPE_FILE = 0x82
TYPE_PROGRESS = 0x83
TYPE_SESSION_END = 0x84
TYPE_DETECT = 0x85
TYPE_PASSTHROUGH = 0x86


def step(name: str):
    print(f"\n==> {name}")


def fail(message: str, *clients) -> None:
    for client in clients:
        try:
            client.close()
        except Exception:
            pass
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


class Bridge:
    """Framed stdio peer for zmodem_receive_bridge.mjs."""

    def __init__(self) -> None:
        self.process = subprocess.Popen(
            ["node", str(BRIDGE)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self.frames: queue.Queue[tuple[int, bytes]] = queue.Queue()
        # Set by main(): forwards PTY-bound protocol bytes (ZRINIT responses,
        # ACKs, the cancel sequence) back into the terminal input channel.
        self.on_pty_out = None
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        fd = self.process.stdout.fileno()
        pending = bytearray()
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                self.frames.put((0, b""))
                return
            pending.extend(chunk)
            while len(pending) >= 5:
                frame_type = pending[0]
                (length,) = struct.unpack(">I", pending[1:5])
                if len(pending) < 5 + length:
                    break
                payload = bytes(pending[5:5 + length])
                del pending[:5 + length]
                self.frames.put((frame_type, payload))

    def send(self, frame_type: int, payload: bytes = b"") -> None:
        assert self.process.stdin
        self.process.stdin.write(struct.pack(">BI", frame_type, len(payload)))
        self.process.stdin.write(payload)
        self.process.stdin.flush()

    def close(self) -> None:
        try:
            self.send(TYPE_EOF)
            self.process.wait(timeout=40)
        except Exception:
            self.process.kill()

    def drain_until(self, pump, predicate, budget: float) -> dict:
        """Pump terminal bytes into the bridge while collecting its frames,
        until `predicate(state)` holds or `budget` elapses. The pump must run
        inside the wait loop: the sz protocol stalls if the terminal stream is
        not forwarded while we wait for protocol outcomes."""
        state: dict = {"files": [], "progress": [], "detects": [], "ended": None, "passthrough": bytearray()}
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            pump.pump(0.1)
            try:
                frame_type, payload = self.frames.get(timeout=0.15)
            except queue.Empty:
                if predicate(state):
                    break
                continue
            if frame_type == TYPE_FILE:
                event = json.loads(payload)
                event["content"] = base64.b64decode(event.pop("contentB64"))
                state["files"].append(event)
            elif frame_type == TYPE_PTY_OUT:
                if self.on_pty_out is not None:
                    self.on_pty_out(payload)
            elif frame_type == TYPE_PROGRESS:
                state["progress"].append(json.loads(payload))
            elif frame_type == TYPE_DETECT:
                state["detects"].append(json.loads(payload))
            elif frame_type == TYPE_SESSION_END:
                state["ended"] = json.loads(payload)
            elif frame_type == TYPE_PASSTHROUGH:
                state["passthrough"].extend(payload)
            if predicate(state):
                break
        return state


class TerminalPump:
    """Forwards ssh/terminal/out payloads (sequence order) into the bridge."""

    def __init__(self, client: SidecarClient, session_id: str, bridge: Bridge) -> None:
        self.client = client
        self.session_id = session_id
        self.bridge = bridge
        self.last_sequence = 0
        self.pending: dict[int, tuple[int, bytes]] = {}

    def pump(self, budget: float) -> None:
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            self.client.timeout = max(0.1, deadline - time.monotonic())
            try:
                self.client._pump(None)
            except Exception:
                break
        if os.environ.get("ZMODEM_PUMP_DEBUG"):
            for event in self.client.events:
                if event.get("method") in ("ssh/terminal/inputAck", "ssh/terminal/error", "ssh/zmodem"):
                    print(f"  EVT {event.get('method')} {str(event.get('params'))[:120]}", flush=True)
            self.client.events.clear()
        frames = []
        remaining = self.client.binary_frames
        self.client.binary_frames = []
        for channel, payload in remaining:
            if channel != f"ssh/terminal/out/{self.session_id}" or len(payload) < 9:
                continue
            stream, sequence, data = payload[0], int.from_bytes(payload[1:9], "big"), payload[9:]
            if sequence <= self.last_sequence or sequence in self.pending:
                continue
            self.pending[sequence] = (stream, data)
        while True:
            frame = self.pending.pop(self.last_sequence + 1, None)
            if frame is None:
                break
            self.last_sequence += 1
            stream, data = frame
            if stream != 2:  # State frames are sidecar status, not PTY bytes
                frames.append(data)
        for data in frames:
            if os.environ.get("ZMODEM_PUMP_DEBUG"):
                print(f"  FWD stream={stream} seq={self.last_sequence} len={len(data)} head={data[:20].hex()}", flush=True)
            self.bridge.send(TYPE_TERM_OUT, data)


def wait_for_marker(pump: TerminalPump, bridge: Bridge, marker: str, budget: float = 30.0) -> None:
    deadline = time.monotonic() + budget
    tail = b""
    while time.monotonic() < deadline:
        pump.pump(0.1)
        state = bridge.drain_until(pump, lambda s: marker.encode() in bytes(s["passthrough"]), 0.25)
        if marker.encode() in bytes(state["passthrough"]):
            return
        tail = bytes(state["passthrough"])[-120:]
    fail(f"marker {marker!r} not seen within {budget}s (tail: {tail!r})", bridge)


def wait_for_session_end(pump: TerminalPump, bridge: Bridge, budget: float = 30.0) -> dict:
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        pump.pump(0.1)
        state = bridge.drain_until(pump, lambda s: s["ended"] is not None, 0.25)
        if state["ended"]:
            return state["ended"]
    fail("zmodem session_end never arrived", bridge)


def send_line(pump: TerminalPump, client: SidecarClient, session_id: str, line: str, seq: dict) -> None:
    seq["n"] += 1
    client.send_binary(
        f"ssh/terminal/in/{session_id}",
        struct.pack(">Q", seq["n"]) + line.encode("utf-8") + b"\r",
    )


def run_remote(pump: TerminalPump, client: SidecarClient, session_id: str, command: str, seq: dict, bridge: Bridge, budget: float = 30.0) -> str:
    """Run a command on the PTY and return the output between the echoes."""
    send_line(pump, client, session_id, command, seq)
    deadline = time.monotonic() + budget
    text = ""
    while time.monotonic() < deadline:
        pump.pump(0.1)
        state = bridge.drain_until(pump, lambda s: len(s["passthrough"]) > 0, 0.25)
        text += bytes(state["passthrough"]).decode("utf-8", "replace")
        # The command echo precedes the output; the trailing prompt closes it.
        if command.split()[0] in text and text.rstrip(" \r\n").endswith(("$", "#")):
            break
    return text


def remote_md5(pump: TerminalPump, client: SidecarClient, session_id: str, path: str, seq: dict, bridge: Bridge) -> str:
    output = run_remote(pump, client, session_id, f"md5sum '{path}'", seq, bridge)
    match = re.search(r"([0-9a-f]{32})\s", output)
    if not match:
        fail(f"could not parse md5sum output for {path}: {output[-200:]!r}", bridge)
    return match.group(1)


def main() -> int:
    started = time.monotonic()
    if not shutil.which("node"):
        print("SKIP: node not on PATH")
        return 0
    if not BRIDGE.exists():
        print(f"SKIP: bridge missing: {BRIDGE}")
        return 0
    node_modules = Path(__file__).parent.parent / "frontend" / "node_modules" / "zmodem.js"
    if not node_modules.exists():
        print(f"SKIP: zmodem.js not installed at {node_modules} (pnpm --dir frontend install)")
        return 0

    client = SidecarClient.start(timeout=30)
    bridge = Bridge()
    try:
        step("plugin/initialize")
        client.initialize()

        connection = {
            "id": "smoke-zmodem-receive",
            "name": "smoke-zmodem-receive",
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
            {"connectionId": connection["id"], "workbenchId": "smoke-zmodem-receive", "cols": 120, "rows": 30},
            timeout=60,
            on_event=auto_accept_challenge,
        )
        session_id = session.get("sessionId", "smoke-zmodem-receive")
        seq = {"n": 0}

        def send_input(data: bytes) -> None:
            seq["n"] += 1
            client.send_binary(f"ssh/terminal/in/{session_id}", struct.pack(">Q", seq["n"]) + data)

        bridge.on_pty_out = send_input
        pump = TerminalPump(client, session_id, bridge)
        print(f"    session {session_id}")

        step("shell ready")
        send_line(pump, client, session_id, "echo SMOKESHELL_$((1+1))", seq)
        wait_for_marker(pump, bridge, "SMOKESHELL_2")

        # -- case 1: single binary file ------------------------------------
        step("sz single file: 307200 B urandom")
        send_line(pump, client, session_id, "head -c 307200 /dev/urandom > /tmp/zsmoke_a.bin; echo CREATED_A", seq)
        wait_for_marker(pump, bridge, "CREATED_A")
        remote_md5_a = remote_md5(pump, client, session_id, "/tmp/zsmoke_a.bin", seq, bridge)

        send_line(pump, client, session_id, "sz /tmp/zsmoke_a.bin", seq)
        state = bridge.drain_until(pump, lambda s: len(s["files"]) >= 1, 120.0)
        if not state["detects"]:
            fail("sentry never detected the sz session", client, bridge)
        if state["detects"][0]["role"] != "receive":
            fail(f"unexpected detection role: {state['detects']}", client, bridge)
        if not state["files"]:
            fail("no file received within 120s", client, bridge)
        file_event = state["files"][0]
        if file_event["name"] != "zsmoke_a.bin":
            fail(f"unexpected offer name: {file_event['name']!r}", client, bridge)
        if file_event["size"] != 307200:
            fail(f"unexpected received size: {file_event['size']}", client, bridge)
        local_md5 = hashlib.md5(file_event["content"]).hexdigest()
        if local_md5 != remote_md5_a:
            fail(f"content mismatch: local {local_md5} vs remote {remote_md5_a}", client, bridge)
        wait_for_session_end(pump, bridge)
        print(f"    PASS: 307200 B round-trip intact (md5 {local_md5[:12]}…)")

        # -- case 2: multi-file with Chinese + spaces ----------------------
        step("sz multi-file: Chinese + spaces in names")
        send_line(
            pump, client, session_id,
            "head -c 131072 /dev/urandom > '/tmp/zsmoke 报表 最终.csv'; head -c 65536 /dev/urandom > '/tmp/report final.pdf'; echo CREATED_B",
            seq,
        )
        wait_for_marker(pump, bridge, "CREATED_B")
        md5_csv = remote_md5(pump, client, session_id, "/tmp/zsmoke 报表 最终.csv", seq, bridge)
        md5_pdf = remote_md5(pump, client, session_id, "/tmp/report final.pdf", seq, bridge)

        send_line(pump, client, session_id, "sz '/tmp/zsmoke 报表 最终.csv' '/tmp/report final.pdf'", seq)
        state = bridge.drain_until(pump, lambda s: len(s["files"]) >= 2, 120.0)
        if len(state["files"]) < 2:
            fail(f"expected 2 files, got {len(state['files'])}", client, bridge)
        by_name = {event["name"]: event for event in state["files"]}
        for name, expected_size, expected_md5 in (
            ("zsmoke 报表 最终.csv", 131072, md5_csv),
            ("report final.pdf", 65536, md5_pdf),
        ):
            event = by_name.get(name)
            if not event:
                fail(f"missing file {name!r} in {[e['name'] for e in state['files']]}", client, bridge)
            if event["size"] != expected_size:
                fail(f"size mismatch for {name!r}: {event['size']} != {expected_size}", client, bridge)
            if hashlib.md5(event["content"]).hexdigest() != expected_md5:
                fail(f"content mismatch for {name!r}", client, bridge)
        wait_for_session_end(pump, bridge)
        print(f"    PASS: 2/2 files intact ({', '.join(by_name)})")

        # -- case 3: cancel mid-transfer -----------------------------------
        # lrzsz sz streams ZCRCG blocks without reading its stdin, so the
        # abort sequence (CAN×5+BS×5) is only noticed at the next read point —
        # after the current file finishes. The local side is dead the moment
        # abort() fires (bytes discarded, overlay reset); the remote trails
        # behind and exits at its next stdin read. 1 MiB keeps that trail
        # short. This mirrors the real frontend cancel semantics.
        step("sz cancel: abort stops the remote, PTY stays usable")
        send_line(pump, client, session_id, "head -c 1048576 /dev/urandom > /tmp/zsmoke_big.bin; echo CREATED_C", seq)
        wait_for_marker(pump, bridge, "CREATED_C")

        send_line(pump, client, session_id, "sz /tmp/zsmoke_big.bin", seq)
        cancelled = {"sent": False}

        def cancel_after_progress(state: dict) -> bool:
            if not cancelled["sent"] and any(p["fileBytes"] >= 262144 for p in state["progress"]):
                cancelled["sent"] = True
                bridge.send(TYPE_ABORT)
                print("    progress seen; abort sequence sent")
            return state["ended"] is not None and cancelled["sent"]

        state = bridge.drain_until(pump, cancel_after_progress, 120.0)
        if not cancelled["sent"]:
            fail("transfer never reached the cancel threshold", client, bridge)
        if not state["ended"]:
            fail("session did not end after abort", client, bridge)
        if not state["ended"]["aborted"]:
            fail(f"session end was not an abort: {state['ended']}", client, bridge)
        # The remote trails the local abort (it finishes the in-flight file
        # before reading stdin and seeing the CAN): poll until sz is gone,
        # then verify the PTY is still usable.
        remote_gone = {"ok": False}
        poll_deadline = time.monotonic() + 90
        poll_n = 0
        while time.monotonic() < poll_deadline and not remote_gone["ok"]:
            poll_n += 1
            check = run_remote(pump, client, session_id, f"pgrep -c sz > /dev/null && echo SZ_{poll_n} || echo NO_SZ", seq, bridge, budget=10.0)
            if "NO_SZ" in check:
                remote_gone["ok"] = True
        if not remote_gone["ok"]:
            fail("remote sz never exited after the abort sequence", client, bridge)
        check = run_remote(pump, client, session_id, "echo AFTER_CANCEL", seq, bridge)
        if "AFTER_CANCEL" not in check:
            fail(f"PTY not usable after cancel: {check[-200:]!r}", client, bridge)
        print("    PASS: abort sequence stopped sz; PTY remained usable")

        run_remote(pump, client, session_id, "rm -f /tmp/zsmoke_a.bin '/tmp/zsmoke 报表 最终.csv' '/tmp/report final.pdf' /tmp/zsmoke_big.bin", seq, bridge)
        client.request("ssh/session/close", {"sessionId": session_id}, timeout=15)
        client.request("connection/disconnect", lifecycle_params(connection), timeout=30)
        print(f"\nALL PASS ({time.monotonic() - started:.1f}s)")
        return 0
    finally:
        bridge.close()
        client.close()


if __name__ == "__main__":
    sys.exit(main())
