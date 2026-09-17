#!/usr/bin/env python3
"""End-to-end smoke test for the batch-send + global quick-commands capabilities
(ssh/terminal/batchInput, ssh/quickCommands/{list,save,delete}).

Reuses the connection flow from smoke_batch3_test.py: initialize ->
connection/connect -> connection/test (challenge auto-accepted) ->
ssh/session/open. Quick-command CRUD runs against the sidecar data dir and needs
no SSH traffic; batchInput writes into the live session's PTY and verifies the
echo via ssh/terminal/out binary frames. Cases marked SKIP on "Method not found"
so the script keeps passing against older sidecars.

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh-sftp \
        python3 scripts/smoke_batch_quick_test.py         # default test container
    python3 scripts/smoke_batch_quick_test.py --binary PATH --host H --port P --user U --password W
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

QUICK_COMMANDS_LIMIT = 20


def step(name: str):
    print(f"\n==> {name}")


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
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def missing_method(error: Exception) -> str | None:
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


class Report:
    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, method: str, case, needs: str | None = None):
        step(title)
        if needs and needs not in self.passed:
            print(f"SKIP: prerequisite '{needs}' did not pass")
            self.skipped.append((title, f"prerequisite '{needs}' did not pass"))
            return
        try:
            case()
        except SidecarError as error:
            missing = missing_method(error)
            if missing is not None:
                print(f"SKIP: {missing or method} not registered yet")
                self.skipped.append((title, f"{missing or method} not registered yet"))
            else:
                print(f"FAIL: {error}")
                self.failed.append((title, str(error)))
        except Exception as error:
            print(f"FAIL: {error}")
            self.failed.append((title, str(error)))
        else:
            print("    PASS")
            self.passed.append(title)


def terminal_echo(client: SidecarClient, session_id: str, marker: str, timeout: float = 12.0) -> bool:
    """Scans buffered ssh/terminal/out payloads for marker, pumping frames."""
    channel = f"ssh/terminal/out/{session_id}"
    deadline = time.monotonic() + timeout
    while True:
        for frame_channel, payload in client.binary_frames:
            if frame_channel != channel or len(payload) <= 9:
                continue
            # TerminalFrame: [stream:u8][sequence:u64 BE][data]
            if marker in payload[9:].decode(errors="replace"):
                return True
        if time.monotonic() >= deadline:
            return False
        client.timeout = 0.5
        try:
            client._pump(None)
        except SidecarError:
            return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    args = parser.parse_args()

    started = time.monotonic()
    # Isolated plugin data dir so the quick-commands store starts empty.
    data_dir = tempfile.mkdtemp(prefix="dbx-batch-quick-data-")
    client = SidecarClient.start(binary=args.binary, timeout=30, data_dir=data_dir)
    report = Report()
    connection_id = "smoke-batch-quick-connection"
    session_id = ""
    try:
        step("plugin/initialize")
        info = client.initialize()
        print(json.dumps(info, ensure_ascii=False)[:200])

        workbench_id = "smoke-batch-quick"
        connection = {
            "id": connection_id,
            "name": "smoke-batch-quick",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }

        step("connection/connect + test + session/open")
        client.request("connection/connect", lifecycle_params(connection))
        client.request("connection/test", lifecycle_params(connection), timeout=90,
                       on_event=auto_accept_challenge)
        session = client.request("ssh/session/open",
                                 {"connectionId": connection_id, "workbenchId": workbench_id,
                                  "cols": 120, "rows": 30},
                                 timeout=60, on_event=auto_accept_challenge)
        session_id = session.get("sessionId", workbench_id)
        print(f"    session {session_id} opened")

        def req(method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
            return client.request(method, params, timeout=timeout, on_event=auto_accept_challenge)

        # -- ssh/quickCommands CRUD (no SSH traffic involved) ------------------

        def case_quick_commands_empty():
            commands = req("ssh/quickCommands/list").get("commands") or []
            if commands:
                raise AssertionError(f"fresh store should be empty, got {json.dumps(commands)[:200]}")

        def case_quick_commands_save_creates():
            first = req("ssh/quickCommands/save",
                        {"name": "disk free", "command": "df -h"})
            created = first.get("quickCommand") or {}
            if first.get("created") is not True or created.get("id") == "" or created.get("command") != "df -h":
                raise AssertionError(f"create failed: {json.dumps(first)[:240]}")
            second = req("ssh/quickCommands/save",
                         {"name": "uptime", "command": "uptime"})
            commands = second.get("commands") or []
            if [c.get("name") for c in commands] != ["disk free", "uptime"]:
                raise AssertionError(f"list order wrong: {json.dumps(commands)[:240]}")

        def case_quick_commands_save_updates():
            listed = req("ssh/quickCommands/list").get("commands") or []
            target = next((c for c in listed if c.get("name") == "disk free"), None)
            if not target:
                raise AssertionError("disk free entry missing")
            updated = req("ssh/quickCommands/save",
                          {"id": target.get("id"), "name": "disk free /", "command": "df -h /"})
            entry = updated.get("quickCommand") or {}
            if updated.get("created") is not False or entry.get("name") != "disk free /":
                raise AssertionError(f"update failed: {json.dumps(updated)[:240]}")
            if len(updated.get("commands") or []) != 2:
                raise AssertionError("update should not add an entry")

        def case_quick_commands_save_validates():
            for params, expect in (({"command": "   "}, "command"),
                                   ({"name": "n" * 61, "command": "echo hi"}, "name"),
                                   ({"command": "a" * 501}, "command")):
                try:
                    req("ssh/quickCommands/save", params)
                except SidecarError as error:
                    if missing_method(error) is not None:
                        raise
                    if expect not in str(error):
                        raise AssertionError(f"error should mention {expect}: {error}")
                else:
                    raise AssertionError(f"save should reject {json.dumps(params)[:80]}")

        def case_quick_commands_cap():
            listed = req("ssh/quickCommands/list").get("commands") or []
            for index in range(len(listed), QUICK_COMMANDS_LIMIT):
                req("ssh/quickCommands/save",
                    {"name": f"filler-{index}", "command": f"echo {index}"})
            try:
                req("ssh/quickCommands/save", {"command": "echo overflow"})
            except SidecarError as error:
                if missing_method(error) is not None:
                    raise
                if "At most" not in str(error):
                    raise AssertionError(f"cap error unexpected: {error}")
            else:
                raise AssertionError("21st quick command should be rejected")
            # Updating an existing entry stays within the cap.
            listed = req("ssh/quickCommands/list").get("commands") or []
            if len(listed) != QUICK_COMMANDS_LIMIT:
                raise AssertionError(f"expected {QUICK_COMMANDS_LIMIT} entries, got {len(listed)}")

        def case_quick_commands_delete():
            listed = req("ssh/quickCommands/list").get("commands") or []
            filler = next((c for c in listed if str(c.get("name", "")).startswith("filler-")), None)
            if not filler:
                raise AssertionError("filler entry missing")
            removed = req("ssh/quickCommands/delete", {"id": filler.get("id")})
            if removed.get("removed") is not True:
                raise AssertionError(f"delete failed: {json.dumps(removed)[:200]}")
            again = req("ssh/quickCommands/delete", {"id": filler.get("id")})
            if again.get("removed") is not False:
                raise AssertionError("second delete should report removed=false")
            if any(c.get("id") == filler.get("id") for c in again.get("commands") or []):
                raise AssertionError("deleted entry still listed")

        report.run("ssh/quickCommands/list starts empty", "ssh/quickCommands/list",
                   case_quick_commands_empty)
        report.run("ssh/quickCommands/save creates entries", "ssh/quickCommands/save",
                   case_quick_commands_save_creates,
                   needs="ssh/quickCommands/list starts empty")
        report.run("ssh/quickCommands/save updates by id", "ssh/quickCommands/save",
                   case_quick_commands_save_updates,
                   needs="ssh/quickCommands/save creates entries")
        report.run("ssh/quickCommands/save validates input", "ssh/quickCommands/save",
                   case_quick_commands_save_validates,
                   needs="ssh/quickCommands/save creates entries")
        report.run("ssh/quickCommands save enforces the 20-entry cap", "ssh/quickCommands/save",
                   case_quick_commands_cap,
                   needs="ssh/quickCommands/save updates by id")
        report.run("ssh/quickCommands/delete removes by id", "ssh/quickCommands/delete",
                   case_quick_commands_delete,
                   needs="ssh/quickCommands save enforces the 20-entry cap")

        # -- ssh/sessions/list endpoint fields + ssh/terminal/batchInput -------

        def case_sessions_endpoint_fields():
            sessions = req("ssh/sessions/list").get("sessions") or []
            row = next((s for s in sessions if s.get("sessionId") == session_id), None)
            if not row:
                raise AssertionError("live session missing from inventory")
            if row.get("host") != args.host or row.get("username") != args.user:
                raise AssertionError(f"endpoint fields wrong: {json.dumps(row)[:240]}")
            if row.get("port") != args.port:
                raise AssertionError(f"port wrong: {row.get('port')!r}")

        def case_batch_input_mixed_targets():
            marker = f"BATCHQ_{int(time.time())}"
            result = req("ssh/terminal/batchInput",
                         {"sessionIds": [session_id, "ghost-session"],
                          "command": f"echo {marker}"})
            if result.get("sent") != 1 or result.get("failed") != 1:
                raise AssertionError(f"counts wrong: {json.dumps(result)[:240]}")
            results = result.get("results") or []
            ghost = next((r for r in results if r.get("sessionId") == "ghost-session"), None)
            if not ghost or ghost.get("success") is not False or "not found" not in str(ghost.get("error")):
                raise AssertionError(f"ghost target wrong: {json.dumps(ghost)[:200]}")
            live = next((r for r in results if r.get("sessionId") == session_id), None)
            if not live or live.get("success") is not True:
                raise AssertionError(f"live target wrong: {json.dumps(live)[:200]}")
            if not terminal_echo(client, session_id, marker):
                raise AssertionError(f"marker {marker} never echoed back in the terminal")

        def case_batch_input_unknown_only():
            result = req("ssh/terminal/batchInput",
                         {"sessionIds": ["ghost-a"], "command": "echo nope"})
            if result.get("sent") != 0 or result.get("failed") != 1:
                raise AssertionError(f"counts wrong: {json.dumps(result)[:200]}")

        def case_batch_input_requires_targets():
            try:
                req("ssh/terminal/batchInput", {"sessionIds": [], "command": "echo hi"})
            except SidecarError as error:
                if missing_method(error) is not None:
                    raise
                if "sessionIds" not in str(error):
                    raise AssertionError(f"error should mention sessionIds: {error}")
            else:
                raise AssertionError("empty sessionIds should be rejected")

        report.run("ssh/sessions/list carries endpoint display fields",
                   "ssh/sessions/list", case_sessions_endpoint_fields)
        report.run("ssh/terminal/batchInput sends to live and fails unknown targets",
                   "ssh/terminal/batchInput", case_batch_input_mixed_targets,
                   needs="ssh/sessions/list carries endpoint display fields")
        report.run("ssh/terminal/batchInput counts unknown-only targets as failures",
                   "ssh/terminal/batchInput", case_batch_input_unknown_only,
                   needs="ssh/terminal/batchInput sends to live and fails unknown targets")
        report.run("ssh/terminal/batchInput rejects empty target list",
                   "ssh/terminal/batchInput", case_batch_input_requires_targets)

    finally:
        try:
            client.request("connection/disconnect", {"connection": {"id": connection_id}}, timeout=30)
        except Exception:
            pass
        client.close()
        shutil.rmtree(data_dir, ignore_errors=True)

    elapsed = time.monotonic() - started
    print(f"\n==== batch-quick smoke summary: {len(report.passed)} passed, "
          f"{len(report.skipped)} skipped, {len(report.failed)} failed ({elapsed:.1f}s) ====")
    for title, reason in report.skipped:
        print(f"  SKIP: {title} — {reason}")
    for title, reason in report.failed:
        print(f"  FAIL: {title} — {reason}")
    if report.failed:
        sys.exit(1)
    print("batch-quick smoke: all green")


if __name__ == "__main__":
    main()
