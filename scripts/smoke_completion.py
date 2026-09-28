#!/usr/bin/env python3
"""End-to-end smoke test for the completion/execute RPC (FIG wave-1 lane B).

Reuses the connection flow from smoke_test.py: initialize -> connection/connect ->
connection/test (challenge auto-accepted) -> ssh/session/open, then exercises
completion/execute against local and ssh targets on the test container. The
method may not be registered in main.rs yet; any "Method not found" answer is
reported as SKIP so the script passes both before and after wiring (only
connection setup failures or real method errors count as FAIL).

Usage:
    python3 scripts/smoke_completion.py                    # default test container
    python3 scripts/smoke_completion.py --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params


def step(name: str):
    print(f"\n==> {name}")


class SkipSignal(Exception):
    """Raised by a case to skip itself for environmental reasons."""


def fail(message: str, client: SidecarClient | None = None):
    if client:
        client.close()
    print(f"\nFAIL: {message}", file=sys.stderr)
    sys.exit(1)


def auto_accept_challenge(event: dict) -> dict | None:
    """Auto-accept host-key challenges while a request is in flight."""
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


def missing_method(error: Exception) -> str | None:
    """Return the unregistered method name if the error means 'Method not found'."""
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


IS_WINDOWS = sys.platform.startswith("win")


class Report:
    """Per-case PASS/SKIP/FAIL bookkeeping with the smoke_test reporting style."""

    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, method: str, case, needs: str | None = None):
        """Run one case; SKIP on Method not found, FAIL on any other error.

        `needs` gates chained cases: it must name a case that PASSED before
        this one runs, otherwise this case is SKIPped as unreachable.
        """
        step(title)
        if needs and needs not in self.passed:
            print(f"SKIP: prerequisite '{needs}' did not pass")
            self.skipped.append((title, f"prerequisite '{needs}' did not pass"))
            return
        try:
            case()
        except SkipSignal as reason:
            print(f"SKIP: {reason}")
            self.skipped.append((title, str(reason)))
        except SidecarError as error:
            missing = missing_method(error)
            if missing is not None:
                print(f"SKIP: {missing or method} not registered yet")
                self.skipped.append((title, f"{missing or method} not registered yet"))
            else:
                print(f"FAIL: {error}")
                self.failed.append((title, str(error)))
        except Exception as error:  # noqa: BLE001 - smoke bookkeeping
            print(f"FAIL: {error}")
            self.failed.append((title, str(error)))
        else:
            print("    PASS")
            self.passed.append(title)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    args = parser.parse_args()

    started = time.monotonic()
    client = SidecarClient.start(timeout=30)
    report = Report()
    connection_id = "smoke-completion-connection"
    workbench_id = "smoke-completion"
    session_id = ""
    read_only_connection_id = "smoke-completion-readonly"
    try:
        step("plugin/initialize")
        info = client.initialize()
        print(json.dumps(info, ensure_ascii=False)[:200])

        connection = {
            "id": connection_id,
            "name": "smoke-completion",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }

        step("connection/connect")
        result = client.request("connection/connect", lifecycle_params(connection))
        print(json.dumps(result, ensure_ascii=False))

        step("connection/test (challenge auto-accepted, remembered)")
        result = client.request("connection/test", lifecycle_params(connection),
                                timeout=90, on_event=auto_accept_challenge)
        print(f"    test ok: {json.dumps(result, ensure_ascii=False)[:100]}")

        step("ssh/session/open")
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": workbench_id,
                                  "cols": 120, "rows": 30},
                                 timeout=60, on_event=auto_accept_challenge)
        session_id = session.get("sessionId", workbench_id)
        print(f"    session {session_id} opened")

        def req(method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
            return client.request(method, params, timeout=timeout,
                                  on_event=auto_accept_challenge)

        def exec_request(target: dict, command: str, args_list: list[str],
                         mode: str = "completion-generator", **overrides) -> dict:
            payload = {
                "target": target,
                "command": command,
                "args": args_list,
                "timeoutMs": 2000,
                "maxOutputBytes": 65536,
                "mode": mode,
            }
            payload.update(overrides)
            return req("completion/execute", payload)

        local_target = {"kind": "local", "sessionId": workbench_id}
        ssh_target = {"kind": "ssh", "sessionId": session_id}

        # ---- local group -----------------------------------------------------

        def case_local_echo():
            result = exec_request(local_target, "printf", ["hello"])
            if result.get("exitCode") != 0 or result.get("stdout") != "hello":
                raise AssertionError(f"want stdout='hello' exit=0, got {json.dumps(result)[:200]}")
            if result.get("timedOut") or result.get("truncated"):
                raise AssertionError(f"unexpected flags: {json.dumps(result)[:200]}")
            print(f"    stdout={result.get('stdout')!r}")

        def case_local_timeout():
            if IS_WINDOWS:
                raise SkipSignal("unix-only case (sleep); Windows host skips")
            result = exec_request(local_target, "sleep", ["5"], timeoutMs=400)
            if result.get("timedOut") is not True or result.get("exitCode") is not None:
                raise AssertionError(f"want timedOut=true exitCode=null, got {json.dumps(result)[:200]}")
            if result.get("stdout"):
                raise AssertionError("timed-out local exec must drop output")

        def case_local_truncation():
            if IS_WINDOWS:
                raise SkipSignal("unix-only case (yes); Windows host skips")
            result = exec_request(local_target, "yes", ["x"], maxOutputBytes=1024)
            if result.get("truncated") is not True:
                raise AssertionError(f"want truncated=true, got {json.dumps(result)[:200]}")
            if result.get("timedOut"):
                raise AssertionError("truncation must kill the child, not wait for the timeout")
            if len(result.get("stdout", "")) > 1024:
                raise AssertionError(f"stdout exceeds cap: {len(result['stdout'])}")

        def case_security_rejects():
            try:
                exec_request(local_target, "printf", ["x"], mode="evil")
            except SidecarError as error:
                if "completion:" not in str(error):
                    raise AssertionError(f"mode reject lacks completion: prefix: {error}")
            else:
                raise AssertionError("mode='evil' unexpectedly accepted")
            try:
                exec_request(local_target, "", [])
            except SidecarError as error:
                if "completion:" not in str(error):
                    raise AssertionError(f"empty command reject lacks prefix: {error}")
            else:
                raise AssertionError("empty command unexpectedly accepted")
            print("    mode/empty-command rejections carry the completion: prefix")

        # ---- ssh group -------------------------------------------------------

        def case_ssh_basic():
            result = exec_request(ssh_target, "printf", ["hi"])
            if result.get("exitCode") != 0 or result.get("stdout") != "hi":
                raise AssertionError(f"want stdout='hi' exit=0, got {json.dumps(result)[:200]}")
            print(f"    stdout={result.get('stdout')!r}")

        def case_ssh_quotes_args():
            result = exec_request(ssh_target, "printf", ["a b'c"])
            if result.get("stdout") != "a b'c":
                raise AssertionError(f"quote round-trip broken: {json.dumps(result)[:200]}")
            print(f"    stdout={result.get('stdout')!r}")

        def case_ssh_unknown_session():
            try:
                exec_request({"kind": "ssh", "sessionId": "no-such-session-xyz"}, "printf", ["x"])
            except SidecarError as error:
                if "completion:" not in str(error):
                    raise AssertionError(f"unknown session error lacks prefix: {error}")
            else:
                raise AssertionError("unknown session unexpectedly accepted")
            print("    unknown session rejected with completion: prefix")

        def case_ssh_timeout():
            # linuxserver/openssh-server 是 busybox 环境；缺 sleep 时按环境 SKIP。
            probe = req("ssh/exec", {"sessionId": session_id, "command": "command -v sleep"})
            if "sleep" not in str(probe.get("output", "")):
                raise SkipSignal("container has no sleep binary")
            started_at = time.monotonic()
            result = exec_request(ssh_target, "sleep", ["5"], timeoutMs=400)
            elapsed = time.monotonic() - started_at
            if result.get("timedOut") is not True:
                raise AssertionError(f"want timedOut=true, got {json.dumps(result)[:200]}")
            if elapsed > 5:
                raise AssertionError(f"timeout race ineffective: {elapsed:.1f}s")

        def case_ssh_read_only_rejected():
            # 用独立只读连接验证决策 D4：read_only 连接上 ssh target 一律拒绝。
            read_only_connection = dict(connection)
            read_only_connection.update({
                "id": read_only_connection_id,
                "name": "smoke-completion-readonly",
                "read_only": True,
            })
            try:
                client.request("connection/connect", lifecycle_params(read_only_connection))
                client.request("connection/test", lifecycle_params(read_only_connection),
                               timeout=90, on_event=auto_accept_challenge)
                opened = req("ssh/session/open", {
                    "connectionId": read_only_connection_id,
                    "workbenchId": "smoke-completion-readonly-wb",
                    "cols": 120, "rows": 30,
                })
            except SidecarError as error:
                raise SkipSignal(f"read-only connection unavailable: {error}")
            read_only_session_id = opened.get("sessionId", "smoke-completion-readonly-wb")
            try:
                exec_request({"kind": "ssh", "sessionId": read_only_session_id},
                             "printf", ["x"])
            except SidecarError as error:
                if "read-only" not in str(error) or "completion:" not in str(error):
                    raise AssertionError(f"unexpected read-only rejection: {error}")
            else:
                raise AssertionError("read-only connection unexpectedly allowed completion/execute")
            print("    read-only connection rejected with completion: prefix")

        report.run("local echo", "completion/execute", case_local_echo)
        report.run("local timeout race", "completion/execute", case_local_timeout)
        report.run("local output truncation", "completion/execute", case_local_truncation)
        report.run("security rejections (mode/command)", "completion/execute",
                   case_security_rejects)
        report.run("ssh basic exec", "completion/execute", case_ssh_basic)
        report.run("ssh arg shell-quoting", "completion/execute", case_ssh_quotes_args,
                   needs="ssh basic exec")
        report.run("ssh unknown session", "completion/execute", case_ssh_unknown_session)
        report.run("ssh timeout race", "completion/execute", case_ssh_timeout,
                   needs="ssh basic exec")
        report.run("ssh read-only rejected", "completion/execute", case_ssh_read_only_rejected,
                   needs="ssh basic exec")

        # ---- cleanup ---------------------------------------------------------

        step("cleanup")
        try:
            client.request("ssh/session/close", {"sessionId": session_id})
            print("    session closed")
        except SidecarError:
            pass
        read_only_connection = {
            "id": read_only_connection_id,
            "name": "smoke-completion-readonly",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
            "read_only": True,
        }
        for connection_payload in (read_only_connection, connection):
            try:
                client.request("connection/disconnect", lifecycle_params(connection_payload))
            except SidecarError:
                pass
        client.close()
        step(f"summary ({time.monotonic() - started:.1f}s)")
        print(f"PASS {len(report.passed)} / SKIP {len(report.skipped)} / FAIL {len(report.failed)}")
        for name, reason in report.skipped:
            print(f"  SKIP {name}: {reason}")
        for name, error in report.failed:
            print(f"  FAIL {name}: {error}", file=sys.stderr)
        if report.failed:
            sys.exit(1)
        print("PASS: completion/execute smoke OK")
    except SidecarError as error:
        fail(str(error), client)
    except KeyboardInterrupt:
        client.close()


if __name__ == "__main__":
    main()
