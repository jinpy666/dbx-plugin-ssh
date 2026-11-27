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
import json
import sys

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
            print("no reachable local daemon — skipping logs/action (shape-only pass)")
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
                # Any benign request drains pending framed output.
                client.request("docker/list", {"target": "local"}, timeout=30)
                frames = [
                    frame for frame in client.binary_frames
                    if frame[0] == f"docker/logs/out/{stream_id}"
                ]
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
                print(f"docker/logs/stream ok: start → {len(frames)} frame(s) → stop")
            else:
                print("docker/logs/stream shape ok: start → no frames (quiet container) → stop")

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
