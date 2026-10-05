#!/usr/bin/env python3
"""End-to-end smoke test for the Scheduler Task Provider (io.dbx.ssh.tasks)
against a real SSH container.

Covers the frozen task/* RPC contract (ADR §6) over a live sidecar:
  1. task/validate — valid config, missing command, bad env key, unknown trigger
  2. task/execute success — stdout + stderr streamed as task/log events with
     monotonic seq and correct stream labels, exitCode 0
  3. nonzero exit — success=false, exitCode propagated
  4. timeout — plugin-side deadline stops the remote sleep and errors with
     the `timeout:` code prefix
  5. cancel — task/stop with the runId really terminates the running command
     (`cancelled:` error, not just an accepted signal)
  6. secret redaction — output containing the connection password arrives
     scrubbed in task/log
  7. resident start/status/stop — heartbeat state machine and real teardown
  8. restart limit — a crashing resident degrades instead of crash-looping
  9. missing connection — `connection_missing:` code prefix

Container strategy (mirrors smoke_test.py): connects to the dbx-ssh-test
container with password auth, then drives task/* directly. The connection
password doubles as the redaction probe secret and is masked in all output.

Gating: the whole file SKIPs when the binary is missing or the container is
unreachable, so the suite stays green everywhere (same convention as the
other smoke scripts).

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh \
        python3 scripts/smoke_task_provider.py
    python3 scripts/smoke_task_provider.py --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import FRAME_JSON, SidecarClient, SidecarError, lifecycle_params

TASK_PROVIDER_ID = "io.dbx.ssh.tasks"


def step(name: str):
    print(f"\n==> {name}")


def task_envelope(trigger_id: str, connection_id: str, config: dict, run_id: str, task_id: str = "smoke-task") -> dict:
    return {
        "task": {
            "providerId": TASK_PROVIDER_ID,
            "taskId": task_id,
            "runId": run_id,
            "triggerId": trigger_id,
            "connectionId": connection_id,
            "configVersion": 1,
            "config": config,
        },
        "run": {"runId": run_id, "attempt": 1},
    }


def drain_task_logs(client: SidecarClient, watermark: int) -> tuple[list[dict], int]:
    """Return new task/log events since `watermark` and the new watermark."""
    logs = []
    index = watermark
    while index < len(client.events):
        message = client.events[index]
        index += 1
        if message.get("method") == "task/log":
            params = message.get("params", {})
            logs.append(params if isinstance(params, dict) else {})
    return logs, index


def auto_accept_challenge(event: dict) -> dict | None:
    """Headless host-key answer for dedicated task dials (no workbench open).

    Same contract as smoke_test.py: TOFU accept + remember, so restart
    re-dials of the resident supervisor skip the challenge entirely.
    """
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params", {}).get("params") or event.get("params", {})
    if "challengeId" not in params:
        return None
    print(f"    host-key challenge: {params.get('keyType')} {str(params.get('fingerprint'))[:32]}...")
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def wait_for(predicate, budget: float, client: SidecarClient, watermark: int):
    """Poll `predicate(new_logs)` until it returns truthy or the budget ends.

    Events only enter `client.events` while a `_pump` runs, so each idle
    iteration actively pumps one frame (bounded by a short client timeout)
    instead of busy-checking a stash nothing is feeding.
    """
    deadline = time.monotonic() + budget
    while time.monotonic() < deadline:
        logs, watermark = drain_task_logs(client, watermark)
        result = predicate(logs)
        if result is not None:
            return result, watermark
        client.timeout = max(0.2, min(1.0, deadline - time.monotonic()))
        try:
            client._pump(None)
        except SidecarError:
            pass  # frame-read timeout: re-check the predicate, then retry
    return None, watermark


def expect(cond: bool, message: str):
    if not cond:
        raise AssertionError(message)
    print(f"    ok: {message}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    parser.add_argument("--skip-connectivity", action="store_true",
                        help="skip the container reachability probe")
    args = parser.parse_args()

    if not args.skip_connectivity:
        probe = socket.socket()
        probe.settimeout(2)
        try:
            probe.connect((args.host, args.port))
        except OSError as error:
            print(f"SKIP: SSH test endpoint {args.host}:{args.port} unreachable ({error}); "
                  "start the dbx-ssh-test container to run this smoke")
            return
        finally:
            probe.close()

    client = SidecarClient.start(timeout=30)
    try:
        step("plugin/initialize")
        client.initialize()

        connection_id = "smoke-task-connection"
        connection = {
            "id": connection_id,
            "name": "smoke-task",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }
        step("connection/connect (credential lifecycle: the only secret path)")
        client.request("connection/connect", lifecycle_params(connection))

        # ---------------------------------------------------------- validate
        step("task/validate: accepts a well-formed execute task")
        result = client.request("task/validate", {
            "task": {
                "providerId": TASK_PROVIDER_ID,
                "triggerId": "execute",
                "connectionId": connection_id,
                "configVersion": 1,
                "config": {"command": "echo hello", "timeout_seconds": 30},
            },
        })
        expect(result.get("valid") is True and not result.get("errors"), f"valid: {result}")

        step("task/validate: collects config errors")
        result = client.request("task/validate", {
            "task": {
                "providerId": TASK_PROVIDER_ID,
                "triggerId": "nope",
                "config": {"command": "", "environment": "bad key=1"},
            },
        })
        errors = " | ".join(result.get("errors", []))
        expect(result.get("valid") is False and "command is required" in errors
               and "unknown trigger" in errors and "bad key" in errors,
               f"errors collected: {errors[:160]}")

        # -------------------------------------------------- execute: success
        step("task/execute: success with streamed stdout/stderr")
        watermark = len(client.events)
        marker_out = f"SMOKE-OUT-{int(time.time())}"
        marker_err = f"SMOKE-ERR-{int(time.time())}"
        result = client.request("task/execute", task_envelope(
            "execute", connection_id,
            {"command": f"echo {marker_out}; echo {marker_err} 1>&2; exit 0"},
            run_id="smoke-run-ok",
        ), timeout=60, on_event=auto_accept_challenge)
        expect(result.get("success") is True and result.get("exitCode") == 0,
               f"success payload: {result}")
        logs, watermark = drain_task_logs(client, watermark)
        stdout_lines = [entry for entry in logs if entry.get("stream") == "stdout"]
        stderr_lines = [entry for entry in logs if entry.get("stream") == "stderr"]
        expect(any(marker_out in entry.get("message", "") for entry in stdout_lines),
               "stdout marker on the stdout stream")
        expect(any(marker_err in entry.get("message", "") for entry in stderr_lines),
               "stderr marker on the stderr stream")
        seqs = [entry.get("seq") for entry in logs if entry.get("seq") is not None]
        expect(seqs == sorted(seqs) and (not seqs or seqs[0] >= 1),
               f"seq monotonic from 1: {seqs}")
        levels = {entry.get("stream"): entry.get("level") for entry in logs}
        expect(levels.get("stderr") == "warn", "stderr defaults to warn level")

        # -------------------------------------------------- execute: nonzero
        step("task/execute: nonzero exit code propagates")
        result = client.request("task/execute", task_envelope(
            "execute", connection_id, {"command": "exit 7"}, run_id="smoke-run-exit7",
        ), timeout=60, on_event=auto_accept_challenge)
        expect(result.get("success") is False and result.get("exitCode") == 7,
               f"nonzero payload: {result}")

        # ----------------------------------------------------- execute: timeout
        step("task/execute: timeout really stops the remote command")
        started = time.monotonic()
        try:
            client.request("task/execute", task_envelope(
                "execute", connection_id,
                {"command": "sleep 30", "timeout_seconds": 2},
                run_id="smoke-run-timeout",
            ), timeout=60, on_event=auto_accept_challenge)
            raise AssertionError("timeout run must not return success")
        except SidecarError as error:
            elapsed = time.monotonic() - started
            expect(str(error).startswith("timeout:"), f"timeout error prefix: {error}")
            expect(elapsed < 20, f"timeout surfaced in {elapsed:.1f}s")

        # ----------------------------------------------------- execute: cancel
        step("task/stop: cancel terminates the running command")
        run_id = "smoke-run-cancel"
        # task/stop is idempotent ({} on unknown ids), so repeat until the
        # cancel lands mid-run and the executor surfaces the cancelled error.
        outcome: dict = {}

        def runner():
            try:
                outcome["result"] = client.request("task/execute", task_envelope(
                    "execute", connection_id,
                    {"command": "sleep 30"},
                    run_id=run_id, task_id="smoke-task-cancel",
                ), timeout=60, on_event=auto_accept_challenge)
            except SidecarError as error:
                outcome["error"] = str(error)

        thread = threading.Thread(target=runner, daemon=True)
        thread.start()
        # The runner thread owns the pipe pump (SidecarClient is not
        # thread-safe), so cancel requests are written raw: their responses
        # land in the runner's pump as unrelated messages and are stashed.
        def raw_send_stop():
            # Protocol request ids are non-negative in the sidecar SDK
            # (Option<u64>); a negative id is dropped before dispatch.
            message = {"jsonrpc": "2.0", "id": 424242, "method": "task/stop",
                       "params": {"runId": run_id, "reason": "smoke"}}
            client._send_raw(FRAME_JSON, json.dumps(message).encode())

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and thread.is_alive():
            raw_send_stop()
            time.sleep(0.2)
        thread.join(timeout=30)
        expect("error" in outcome and outcome["error"].startswith("cancelled:"),
               f"cancelled error prefix: {outcome.get('error')}")
        expect(outcome.get("result") is None, "no success payload after cancel")

        # -------------------------------------------------- secret redaction
        step("task/execute: connection password is redacted from task/log")
        watermark = len(client.events)
        secret_probe = f"SECRETPROBE{args.password}SECRETPROBE"
        result = client.request("task/execute", task_envelope(
            "execute", connection_id,
            {"command": f"echo {args.password}"},
            run_id="smoke-run-redact",
        ), timeout=60, on_event=auto_accept_challenge)
        expect(result.get("success") is True, "redaction run completed")
        logs, watermark = drain_task_logs(client, watermark)
        leaked = [entry for entry in logs if args.password in entry.get("message", "")]
        expect(not leaked, f"no log line carries the password ({len(logs)} lines checked)")
        masked = [entry for entry in logs if "[redacted]" in entry.get("message", "")]
        expect(bool(masked), f"password replaced by [redacted]: {masked[:1]}")

        # -------------------------------------------------- resident lifecycle
        step("task/start + task/status: resident lifecycle with heartbeat")
        result = client.request("task/start", task_envelope(
            "resident", connection_id,
            {"command": "while true; do echo resident-tick; sleep 0.2; done",
             "max_restarts": 2, "restart_backoff_seconds": 1},
            run_id="smoke-run-resident", task_id="smoke-task-resident",
        ), timeout=30, on_event=auto_accept_challenge)
        session_id = result.get("sessionId")
        expect(bool(session_id) and result.get("state") == "starting",
               f"start payload: {result}")

        def saw_tick(new_logs):
            return any("resident-tick" in entry.get("message", "") for entry in new_logs) or None

        found, _watermark = wait_for(saw_tick, 15, client, len(client.events))
        expect(bool(found), "resident output streams via task/log")

        status = client.request("task/status", {"sessionId": session_id})
        expect(status.get("state") == "running",
               f"status running: {status}")
        expect(status.get("restartCount") == 0, f"restartCount starts at 0: {status}")

        step("task/stop: resident teardown lands on stopped")
        client.request("task/stop", {"sessionId": session_id, "reason": "smoke"})
        deadline = time.monotonic() + 15
        state = None
        while time.monotonic() < deadline:
            status = client.request("task/status", {"sessionId": session_id})
            state = status.get("state")
            if state == "stopped":
                break
            time.sleep(0.2)
        expect(state == "stopped", f"resident stopped: {status}")
        # Idempotent stop + reconcile semantics: unknown sessions report stopped.
        status = client.request("task/status", {"sessionId": "resident-unknown"})
        expect(status.get("state") == "stopped", f"unknown session reports stopped: {status}")

        # -------------------------------------------------- restart limit
        step("task/start: crashing resident degrades within the restart budget")
        result = client.request("task/start", task_envelope(
            "resident", connection_id,
            {"command": "echo about-to-crash; exit 3",
             "max_restarts": 2, "restart_backoff_seconds": 1},
            run_id="smoke-run-crash", task_id="smoke-task-crash",
        ), timeout=30, on_event=auto_accept_challenge)
        session_id = result.get("sessionId")
        expect(bool(session_id), f"crash session started: {result}")
        deadline = time.monotonic() + 30
        status = {}
        while time.monotonic() < deadline:
            status = client.request("task/status", {"sessionId": session_id})
            if status.get("state") in ("degraded", "stopped"):
                break
            time.sleep(0.3)
        expect(status.get("state") == "degraded",
               f"degraded after budget: {status}")
        expect(status.get("restartCount") == 2,
               f"restartCount equals max_restarts: {status}")

        # -------------------------------------------------- missing connection
        step("task/execute: missing connection errors with connection_missing")
        try:
            client.request("task/execute", task_envelope(
                "execute", "no-such-connection",
                {"command": "echo hi"}, run_id="smoke-run-missing",
            ), timeout=30, on_event=auto_accept_challenge)
            raise AssertionError("missing connection must fail")
        except SidecarError as error:
            expect(str(error).startswith("connection_missing:"),
                   f"connection_missing prefix: {error}")

        print("\nall green")
    finally:
        client.close()


if __name__ == "__main__":
    main()
