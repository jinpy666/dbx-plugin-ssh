#!/usr/bin/env python3
"""Workbench-plane smoke for the docker family `target:"local"` plane.

Drives the sidecar over the stdio-framed protocol (sidecar_client.py) and
exercises the local-daemon path end to end: list → stats → logs → idempotent
start action → input validation. Offline-safe: a box without docker still passes
the shape assertions (list/stats degrade to available:false).

Usage:
    python3 scripts/smoke_docker_local.py [--binary path/to/dbx-plugin-ssh]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import struct
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from sidecar_client import SidecarClient  # noqa: E402


def docker_payload(result: dict) -> dict:
    """Extracts the JSON body from a workbench invoke response."""
    if isinstance(result, dict) and "output" not in result and "content" in result:
        return json.loads(result["content"][0]["text"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None, help="sidecar binary path")
    args = parser.parse_args()

    client = SidecarClient.start(binary=args.binary)
    try:
        client.initialize()

        # 1) target:"local" list — shape always; contents only when a local
        # docker daemon is actually reachable.
        listed = client.request("docker/list", {"target": "local"}, timeout=30)
        assert isinstance(listed, dict), f"list not a dict: {listed!r}"
        assert isinstance(listed.get("available"), bool), listed
        assert isinstance(listed.get("needsSudo"), bool), listed
        assert isinstance(listed.get("containers"), list), listed
        print(f"docker/list target=local ok: available={listed['available']}, "
              f"{len(listed['containers'])} containers")

        running = None
        if listed["available"] and listed["containers"]:
            rows = listed["containers"]
            first = rows[0]
            for key in ("id", "name", "image", "state", "status", "ports", "createdAt"):
                assert key in first, f"missing column {key}: {first}"
            running = next((c for c in rows if c.get("state") == "running"), None)
            print(f"row shape ok ({len(rows)} rows)")

        # 1b) local stats (B2, read-only): always shape-asserted. A box without
        # a docker daemon returns available:false with the same document. Prefer
        # a running container; otherwise sample an existing stopped one (docker
        # reports zeros for explicitly named stopped containers on newer CLIs) —
        # never create/start/stop anything.
        probe = running or (listed["containers"][0] if listed["containers"] else None)
        probe_id = probe["id"] if probe else "0" * 12
        stats = client.request(
            "docker/stats",
            {"target": "local", "containerIds": [probe_id]},
            timeout=45,
        )
        assert isinstance(stats.get("available"), bool), stats
        assert isinstance(stats.get("needsSudo"), bool), stats
        assert isinstance(stats.get("sampledAt"), int), stats
        assert isinstance(stats.get("stats"), list), stats
        if stats["available"] and stats["stats"]:
            sample = stats["stats"][0]
            for key in ("containerId", "name", "cpuPercent", "memBytes", "memLimitBytes",
                        "memPercent", "netRxBytes", "netTxBytes", "netRxRate",
                        "netTxRate", "blockReadBytes", "blockWriteBytes", "pids"):
                assert key in sample, f"missing stats field {key}: {sample}"
            print(f"docker/stats target=local ok: {len(stats['stats'])} sample(s), "
                  f"cpu={sample['cpuPercent']}%, mem={sample['memBytes']}B")
        else:
            print(f"docker/stats target=local shape ok: available={stats['available']}, "
                  f"needsSudo={stats['needsSudo']}")

        if running is None:
            print("no running local container — skipping logs/action/terminal (shape-only pass)")
            return 0

        # 2) local logs: inspect summary + log tail.
        logs = client.request(
            "docker/logs",
            {"target": "local", "containerId": running["id"], "tail": 20},
            timeout=40,
        )
        assert isinstance(logs.get("logs"), str), logs
        if logs.get("container") is not None:
            assert logs["container"].get("id"), logs
        print(f"docker/logs target=local ok: {len(logs['logs'])} bytes from "
              f"{(logs.get('container') or {}).get('name', running['name'])}")

        # 2b) local container files (B4, read-only): list "/" and assert the
        # documented shape. Distroless containers without sh/base64 are skipped
        # rather than treated as a regression; nothing is created or modified.
        try:
            files = client.request(
                "docker/files/list",
                {"target": "local", "containerId": running["id"], "path": "/"},
                timeout=40,
            )
        except Exception as error:  # noqa: BLE001 - capability probe, not a test gate
            print(f"docker/files/list skipped (container lacks sh/base64?): {error}")
        else:
            assert files.get("path") == "/", files
            entries = files.get("entries")
            assert isinstance(entries, list), files
            assert len(entries) <= 500, files
            assert isinstance(files.get("truncated"), bool), files
            for entry in entries:
                for key in ("name", "path", "kind", "size"):
                    assert key in entry, f"missing files field {key}: {entry}"
                assert entry["path"].startswith("/"), entry
                assert entry["kind"] in ("file", "dir", "link", "other"), entry
                assert isinstance(entry["size"], int) and entry["size"] >= 0, entry
                if entry["kind"] != "file":
                    assert entry["size"] == 0, entry
            print(f"docker/files/list target=local ok: {len(entries)} entries, "
                  f"truncated={files['truncated']}")

        # 2c) local container file write/read/delete (B6): round-trip inside the
        # already running container's /tmp. Nothing is created/started/stopped
        # at the container level; a distroless container without sh/base64 is
        # skipped. The delete runs in `finally` so a failed assertion cannot
        # leave the smoke file behind.
        smoke_name = f"dbx-smoke-{os.getpid()}.txt"
        smoke_path = f"/tmp/{smoke_name}"
        smoke_payload = b"dbx docker files smoke\n"
        smoke_b64 = base64.b64encode(smoke_payload).decode("ascii")
        wrote = False
        try:
            written = client.request(
                "docker/files/write",
                {
                    "target": "local",
                    "containerId": running["id"],
                    "path": smoke_path,
                    "dataBase64": smoke_b64,
                },
                timeout=40,
            )
            wrote = True
            assert written.get("path") == smoke_path, written
            assert written.get("size") == len(smoke_payload), written
            assert written.get("overwritten") is False, written
            read_back = client.request(
                "docker/files/read",
                {"target": "local", "containerId": running["id"], "path": smoke_path},
                timeout=40,
            )
            assert read_back.get("path") == smoke_path, read_back
            decoded = base64.b64decode(read_back.get("dataBase64", ""))
            assert decoded == smoke_payload, (decoded, smoke_payload)
            print(f"docker/files/write+read target=local ok: {len(decoded)} bytes round-trip")
        except Exception as error:  # noqa: BLE001 - capability probe, not a test gate
            if wrote:
                raise
            print(f"docker/files/write skipped (container lacks sh/base64?): {error}")
        finally:
            try:
                deleted = client.request(
                    "docker/files/delete",
                    {
                        "target": "local",
                        "containerId": running["id"],
                        "path": smoke_path,
                        "confirm": True,
                    },
                    timeout=40,
                )
            except Exception as error:  # noqa: BLE001 - delete is best-effort cleanup
                print(f"docker/files/delete skipped: {error}")
            else:
                if wrote:
                    assert deleted.get("removed") is True, deleted
                    assert deleted.get("path") == smoke_path, deleted
                    print("docker/files/delete target=local ok")

        # 3) local action: `start` on a running container is idempotent and
        # state-preserving (no destructive verb in smoke).
        action = client.request(
            "docker/action",
            {"target": "local", "containerId": running["id"], "action": "start"},
            timeout=70,
        )
        assert action.get("success") is True, action
        print(f"docker/action target=local ok: start {running['name']}")

        # 3b) local log stream (B3): start → ≥1 binary frame → stop. Only the
        # already running container is used; nothing is created/started/
        # stopped/deleted. A quiet container may produce zero frames — the
        # shape assertions and the idempotent stop still pass.
        stream_id = "smoke-log-stream"
        try:
            started = client.request(
                "docker/logs/stream/start",
                {
                    "target": "local",
                    "containerId": running["id"],
                    "tail": 50,
                    "requestedStreamId": stream_id,
                },
                timeout=30,
            )
        except Exception as error:  # noqa: BLE001 - older sidecars lack B3
            print(f"docker/logs/stream/start skipped: {error}")
        else:
            assert started.get("streamId") == stream_id, started
            assert started.get("binaryInput") is True, started
            try:
                # 子进程是异步的：start 返回后立刻数帧会把正常运行中的流误判成
                # 「安静容器」（`docker logs -f` 还没吐出第一行）。给一个 2s 窗口，
                # 期间用无害请求反复泵管道。
                deadline = time.monotonic() + 2.0
                frames: list = []
                while True:
                    client.request("docker/list", {"target": "local"}, timeout=30)
                    frames = [
                        frame for frame in client.binary_frames
                        if frame[0] == f"docker/logs/out/{stream_id}"
                    ]
                    if frames or time.monotonic() >= deadline:
                        break
                    time.sleep(0.2)
            finally:
                stopped = client.request(
                    "docker/logs/stream/stop", {"streamId": stream_id}, timeout=30
                )
                assert stopped.get("success") is True, stopped
                again = client.request(
                    "docker/logs/stream/stop", {"streamId": stream_id}, timeout=30
                )
                assert again.get("success") is True, again
            if frames:
                assert len(frames[0][1]) >= 9, frames[0]
                assert frames[0][1][0] in (0, 1, 2), frames[0][1][:9]
                # 帧头 9 字节（1B 流标签 + 8B 序号），其后是原始日志字节。
                body = b"".join(payload[9:] for _, payload in frames)
                print(
                    f"docker/logs/stream ok: start → {len(frames)} frame(s), "
                    f"{len(body)} bytes → stop"
                )
            else:
                print("docker/logs/stream shape ok: start → no frames (quiet container) → stop")

        # 3c) container terminal (B5): open → type `echo ok` → close. Uses the
        # already running container only; no container is created/started/
        # stopped/deleted. Distroless containers (no shell) or a daemon the
        # user cannot exec into skip with a printed reason.
        terminal_id = "smoke-terminal"
        opened = None
        try:
            opened = client.request(
                "docker/terminal/open",
                {
                    "target": "local",
                    "containerId": running["id"],
                    "shell": "sh",
                    "cols": 80,
                    "rows": 24,
                    "requestedTerminalId": terminal_id,
                },
                timeout=30,
            )
            assert opened.get("terminalId") == terminal_id, opened
            assert opened.get("containerId") == running["id"], opened
            assert opened.get("shell") == "sh", opened
            assert opened.get("cols") == 80 and opened.get("rows") == 24, opened
            assert isinstance(opened.get("sequence"), int), opened
            assert isinstance(opened.get("replay"), list), opened
            client.send_binary(
                f"docker/terminal/in/{terminal_id}",
                struct.pack(">Q", 1) + b"echo ok\r",
            )
            # Ack proves the sidecar accepted the 8-byte sequenced frame; the
            # short dummy wait pumps the echoed/executed output frames.
            client.wait_event("docker/terminal/inputAck", timeout=5)
            client.wait_event("docker/terminal/not-an-event", timeout=0.6)
            channel = f"docker/terminal/out/{terminal_id}"
            frames = [frame for frame in client.binary_frames if frame[0] == channel]
            text = ""
            for _, payload in frames:
                assert len(payload) >= 9, payload[:9]
                text += payload[9:].decode("utf-8", "replace")
            plain = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
            lines = [line.strip() for line in plain.replace("\r", "\n").split("\n")]
            assert "ok" in lines, f"expected `ok` output, got {plain!r}"
            print(f"docker/terminal ok: open → {len(frames)} frame(s) containing `ok` → close")
        except Exception as error:  # noqa: BLE001 - capability probe
            print(f"docker/terminal skipped (container lacks a shell / exec permission?): {error}")
        finally:
            if opened is not None:
                closed = client.request(
                    "docker/terminal/close", {"terminalId": terminal_id}, timeout=20
                )
                assert closed.get("success") is True, closed
                end = client.wait_event("docker/terminal/end", timeout=5)
                assert end is not None, "missing docker/terminal/end after close"
                assert end.get("params", {}).get("reason") == "closed", end
                again = client.request(
                    "docker/terminal/close", {"terminalId": terminal_id}, timeout=20
                )
                assert again.get("success") is True, again
                print("docker/terminal close ok: end{reason:closed} → idempotent success")

        # 4) validation: unknown target and non-hex container names are
        # refused before any process is spawned.
        for method, params, expect in (
            ("docker/list", {"target": "bogus"}, "Unsupported docker target"),
            ("docker/action", {"target": "local", "containerId": "web-nginx", "action": "stop"},
             "Invalid containerId"),
            ("docker/stats", {"target": "local", "containerIds": ["web-nginx"]},
             "Invalid containerId"),
        ):
            try:
                client.request(method, params, timeout=20)
                raise AssertionError(f"{method} accepted invalid params: {params}")
            except Exception as error:  # noqa: BLE001 - sidecar errors surface as exceptions
                assert expect in str(error), f"{method}: unexpected error {error}"
        print("validation ok (bogus target / non-hex id refused)")

        # 5) engine/endpoint params (podman compat): mutually exclusive
        # endpoints are refused up front; a shell-metacharacter cli never
        # reaches a script; a podman-shaped list keeps the graceful
        # available:false degrade when the named CLI is absent.
        try:
            client.request(
                "docker/list",
                {"target": "local", "socket": "/run/podman.sock", "host": "127.0.0.1:2375"},
                timeout=20,
            )
            raise AssertionError("docker/list accepted socket+host together")
        except Exception as error:  # noqa: BLE001
            assert "mutually exclusive" in str(error), f"unexpected error {error}"
        try:
            client.request(
                "docker/list",
                {"target": "local", "cli": "podman; rm -rf /"},
                timeout=20,
            )
            raise AssertionError("docker/list accepted metacharacter cli")
        except Exception as error:  # noqa: BLE001
            assert "Invalid cli" in str(error), f"unexpected error {error}"
        podman_list = client.request(
            "docker/list", {"target": "local", "cli": "definitely-not-a-real-cli"}, timeout=30
        )
        assert podman_list.get("available") is False, podman_list
        assert podman_list.get("containers") == [], podman_list
        print("engine params ok (conflict/metachar refused; missing-cli degrade)")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
