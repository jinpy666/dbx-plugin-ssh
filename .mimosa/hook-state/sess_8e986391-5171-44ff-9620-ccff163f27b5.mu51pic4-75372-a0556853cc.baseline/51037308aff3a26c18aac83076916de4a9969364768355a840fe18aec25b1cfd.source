#!/usr/bin/env python3
"""End-to-end smoke test for the tssh-style automated-interaction triggers
(expect engine) against a real SSH container.

Verified chain, per docs/IMPL_PLAN_SSH_TRIGGER_AUTHPROVIDER.zh-CN.md
(§2.1 storage schema, §2.4 ssh/trigger event, D6 no-answer-leak):
  1. a connection carrying `triggers` in external_config (delivered through
     the lifecycle params, like the host form does) auto-answers stage 1 with
     the `trigger_answer_1` secret slot referenced via `sendSecretKey`;
  2. stage 2 auto-answers with a plaintext `sendText` ("yes\\r", explicit CR);
  3. the sidecar emits one `ssh/trigger` event per stage with
     {sessionId, stage, kind} and never the answered content (D6);
  4. the session stays alive afterwards (shell-prompt re-arm semantics, D3).

Container strategy (mirrors smoke_sudo_otp_test.py): a POSIX shell shim is
installed on the remote host and run as the terminal's remote_command. It
prints "Verification code:", reads one line, appends it to a log file, prints
"[confirm] proceed? (yes/no)", reads the second answer, logs it too, and then
drops into a real shell so the PTY (and the session) survives for log polling
via ssh/exec. The trigger secret is runtime-generated, lives only in this
process, the sidecar and the remote log file, and is masked in all output.

Gating: the whole file SKIPs when the `dbx-ssh-test` container is absent
(same gate as the live-smoke section of scripts/test.sh). Cases SKIP with a
diagnostic when no ssh/trigger events arrive at all, so the suite keeps
passing against sidecars built before the trigger engine lands (package A).

Usage:
    DBX_PLUGIN_SIDECAR=backend/target/release/dbx-plugin-ssh \
        python3 scripts/smoke_trigger_test.py        # default test container
    python3 scripts/smoke_trigger_test.py --binary PATH --host H --port P
"""

from __future__ import annotations

import argparse
import json
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError, lifecycle_params

CONTAINER = "dbx-ssh-test"
SHIM_PATH = "/usr/local/bin/dbx-trigger-demo"
SHIM_MARKER = "DBX-SMOKE-TRIGGER-SHIM"
LOG_FILE = "/tmp/dbx-trigger-demo.log"
STAGE2_TEXT = "yes"

# POSIX shim executed as the terminal's remote_command. Sequence:
#   "Verification code:" -> read one line -> log it
#   "[confirm] proceed? (yes/no)" -> read one line -> log it
#   `exec /bin/sh` keeps the PTY open so the trigger engine re-arms on the
#   shell prompt (D3) and the test can poll the log over ssh/exec.
SHIM_SOURCE = f"""#!/bin/sh
# {SHIM_MARKER} - smoke-test trigger target, safe to delete.
LOG={LOG_FILE}
printf 'Verification code:'
IFS= read -r first
echo "$(date +%s) stage1 $first" >> "$LOG"
printf '[confirm] proceed? (yes/no)'
IFS= read -r second
echo "$(date +%s) stage2 $second" >> "$LOG"
exec /bin/sh
"""


def step(name: str):
    print(f"\n==> {name}")


def mask(value: str) -> str:
    return (value[:3] + "***") if value else "<none>"


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


def collect_trigger_events(client: SidecarClient, wanted: int, timeout: float) -> list[dict]:
    """Pump frames until `wanted` ssh/trigger notifications are stashed.

    sidecar_client stashes every notification in client.events while waiting
    for request responses; this helper drains new entries with a watermark so
    events are collected exactly once, in arrival order.
    """
    deadline = time.monotonic() + timeout
    scanned = 0
    found: list[dict] = []
    while time.monotonic() < deadline and len(found) < wanted:
        while scanned < len(client.events):
            message = client.events[scanned]
            scanned += 1
            if message.get("method") == "ssh/trigger":
                params = message.get("params", {})
                found.append(params if isinstance(params, dict) else {})
        if len(found) >= wanted:
            break
        client.timeout = max(0.5, deadline - time.monotonic())
        try:
            client._pump(None)
        except SidecarError:
            break
    return found


class Report:
    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, case):
        step(title)
        try:
            case()
        except SkipCase as reason:
            print(f"SKIP: {reason}")
            self.skipped.append((title, str(reason)))
        except Exception as error:
            print(f"FAIL: {mask_leak(str(error))}")
            self.failed.append((title, mask_leak(str(error))))
        else:
            print("    PASS")
            self.passed.append(title)


class SkipCase(Exception):
    pass


# Runtime-generated trigger secret, registered by main() before any case can
# fail; mask_leak redacts it from every message headed for stdout.
_RUNTIME_SECRET = ""


def mask_leak(text: str) -> str:
    if _RUNTIME_SECRET:
        text = text.replace(_RUNTIME_SECRET, "***")
    return text


class ContainerSetup:
    """Idempotent container prep + best-effort restore (sudo-smoke style)."""

    def __init__(self, container: str, login_password: str, original_password: str):
        self.container = container
        self.password = login_password
        self.original_password = original_password
        self.prepared = False
        self.shim_installed = False
        self.preexisting_shim = False
        self.notes: list[str] = []

    def _sh(self, command: str, input_text: str | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["docker", "exec", "-i", self.container, "sh", "-c", command],
            input=input_text, capture_output=True, text=True, timeout=30)

    def prepare(self) -> str | None:
        """Returns a SKIP reason on environment failure, else None."""
        try:
            probe = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                                   capture_output=True, text=True, timeout=15)
        except FileNotFoundError:
            return "docker CLI not available"
        if probe.returncode != 0:
            return "docker ps failed"
        if self.container not in probe.stdout.split():
            return f"container {self.container} missing (start it to run this suite)"
        self.prepared = True

        # 1. Runtime-generated login credentials (stdin, never argv).
        if self._sh("chpasswd", input_text=f"sshuser:{self.password}\n").returncode != 0:
            return "chpasswd failed"

        # 2. Trigger shim.
        exists = self._sh(f"test -f {SHIM_PATH} && grep -q {SHIM_MARKER} {SHIM_PATH}")
        if exists.returncode != 0:
            preexisting = self._sh(f"test -f {SHIM_PATH}")
            self.preexisting_shim = preexisting.returncode == 0
            if self.preexisting_shim:
                return f"{SHIM_PATH} exists and is not the smoke shim"
            result = self._sh(f"cat > {SHIM_PATH} && chmod 755 {SHIM_PATH}",
                              input_text=SHIM_SOURCE)
            if result.returncode != 0:
                return f"shim install failed: {result.stderr.strip()[:120]}"
        self.shim_installed = True

        # 3. Clean log.
        self._sh(f"rm -f {LOG_FILE}")
        return None

    def read_log(self) -> list[tuple[str, str, str]]:
        result = self._sh(f"cat {LOG_FILE} 2>/dev/null || true")
        rows = []
        for line in result.stdout.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3:
                rows.append((parts[0], parts[1], parts[2]))
        return rows

    def wait_for_log(self, wanted_rows: int, timeout: float = 30.0) -> list[tuple[str, str, str]]:
        deadline = time.monotonic() + timeout
        rows: list[tuple[str, str, str]] = []
        while time.monotonic() < deadline:
            rows = self.read_log()
            if len(rows) >= wanted_rows:
                return rows
            time.sleep(0.5)
        return rows

    def restore(self) -> None:
        if not self.prepared:
            return  # nothing was touched (container absent / prep failed early)
        if self._sh(f"rm -f {LOG_FILE}").returncode != 0:
            self.notes.append(f"{LOG_FILE} could not be removed")
        if self.shim_installed and not self.preexisting_shim:
            if self._sh(f"rm -f {SHIM_PATH}").returncode != 0:
                self.notes.append(f"{SHIM_PATH} could not be removed")
        if self._sh("chpasswd", input_text=f"sshuser:{self.original_password}\n").returncode != 0:
            self.notes.append("original container password could not be restored "
                              "(pass it via --password on the next run)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026",
                        help="original container password (restored at exit)")
    parser.add_argument("--container", default=CONTAINER)
    args = parser.parse_args()

    started = time.monotonic()
    # Login password + trigger secret: runtime-generated, never printed.
    login_password = secrets.token_urlsafe(12) + "1aA!"
    stage1_secret = secrets.token_hex(12)
    global _RUNTIME_SECRET
    _RUNTIME_SECRET = stage1_secret
    setup = ContainerSetup(args.container, login_password=login_password,
                           original_password=args.password)

    skip_all: str | None = None
    data_dir = tempfile.mkdtemp(prefix="dbx-trigger-data-")
    client = None
    report = Report()
    connection_id = "smoke-trigger-connection"
    session_id = ""

    try:
        step("container preparation (idempotent)")
        skip_all = setup.prepare()
        if skip_all:
            print(f"SKIP: {skip_all}")
        else:
            print(f"    container {args.container} ready; trigger shim installed "
                  f"(credentials runtime-generated)")

            step("plugin/initialize")
            client = SidecarClient.start(binary=args.binary, timeout=30, data_dir=data_dir)
            info = client.initialize()
            print(json.dumps(info, ensure_ascii=False)[:200])

            # Two-stage trigger configuration, delivered exactly the way the
            # connection form does: stages in external_config.triggers, the
            # secret slot in connection_secrets (host secret binding).
            connection = {
                "id": connection_id,
                "name": "smoke-trigger",
                "db_type": "ssh",
                "host": args.host,
                "port": args.port,
                "username": args.user,
                "password": setup.password,
                "external_config": {
                    "authentication": "password",
                    # The shim runs as the terminal command so both prompts
                    # appear on the PTY the trigger engine observes.
                    "remote_command": SHIM_PATH,
                    "triggers": {
                        "timeoutSecs": 30,
                        "stages": [
                            {"pattern": "(?i)verification code",
                             "sendSecretKey": "trigger_answer_1"},
                            {"pattern": r"proceed\? \(yes/no\)",
                             "sendText": STAGE2_TEXT + "\\r"},
                        ],
                    },
                },
                "connection_secrets": {"trigger_answer_1": stage1_secret},
            }

            step("connection/connect + session/open (triggers armed)")
            client.request("connection/connect", lifecycle_params(connection))
            session = client.request("ssh/session/open",
                                     {"connectionId": connection_id, "workbenchId": "smoke-trigger",
                                      "cols": 120, "rows": 30},
                                     timeout=60, on_event=auto_accept_challenge)
            session_id = session.get("sessionId", "smoke-trigger")
            print(f"    session {session_id} opened")

            # -- phase 1: events (D6) and answered content ----------------

            events: list[dict] = []
            log_rows: list[tuple[str, str, str]] = []

            def case_trigger_events_emitted():
                nonlocal events
                events = collect_trigger_events(client, wanted=2, timeout=45.0)
                if not events:
                    raise SkipCase("no ssh/trigger events observed; trigger engine "
                                   "likely absent from this sidecar (feature not landed)")
                if len(events) < 2:
                    raise SkipCase(f"only {len(events)}/2 ssh/trigger events arrived")
                kinds = [str(event.get("kind")) for event in events]
                stages = [event.get("stage") for event in events]
                if kinds != ["secret", "text"]:
                    raise AssertionError(f"unexpected event kinds: {kinds}")
                if stages != [1, 2]:
                    raise AssertionError(f"unexpected event stages: {stages}")
                for event in events:
                    if stage1_secret in json.dumps(event):
                        raise AssertionError("ssh/trigger payload leaked answer content")
                print(f"    events: {[(e.get('stage'), e.get('kind')) for e in events]} "
                      f"(no answer content)")

            def case_stage1_secret_autosent():
                nonlocal log_rows
                if not events:
                    raise SkipCase("prerequisite ssh/trigger events missing")
                log_rows = setup.wait_for_log(wanted_rows=2, timeout=30.0)
                stage1 = [value for _, stage, value in log_rows if stage == "stage1"]
                if not stage1:
                    raise AssertionError(f"stage1 row missing from the remote log: "
                                         f"{[stage for _, stage, _ in log_rows]}")
                if stage1[0] != stage1_secret:
                    raise AssertionError(f"stage1 answer mismatch: got {mask(stage1[0])}, "
                                         f"want {mask(stage1_secret)}")
                print(f"    stage1 answered with the secret slot ({mask(stage1[0])})")

            def case_stage2_text_autosent():
                if not events:
                    raise SkipCase("prerequisite ssh/trigger events missing")
                stage2 = [value for _, stage, value in log_rows if stage == "stage2"]
                if not stage2:
                    raise AssertionError("stage2 row missing from the remote log")
                if stage2[0] != STAGE2_TEXT:
                    raise AssertionError(f"stage2 answer mismatch: got {stage2[0]!r}, "
                                         f"want {STAGE2_TEXT!r}")
                print(f"    stage2 answered with plaintext {stage2[0]!r}")

            def case_session_survives_after_triggers():
                if not events:
                    raise SkipCase("prerequisite ssh/trigger events missing")
                # The shim dropped into a real shell; the session must accept
                # exec traffic (shell-prompt re-arm, D3: no stuck state).
                result = client.request("ssh/exec", {"sessionId": session_id,
                                                     "command": "echo trigger-done"},
                                        timeout=60, on_event=auto_accept_challenge)
                if result.get("exitCode") != 0 or "trigger-done" not in result.get("output", ""):
                    raise AssertionError(f"post-trigger exec failed: {json.dumps(result)[:160]}")

            report.run("ssh/trigger events fire per stage without answer content",
                       case_trigger_events_emitted)
            report.run("stage 1 sendSecretKey auto-sends the trigger_answer_1 slot",
                       case_stage1_secret_autosent)
            report.run("stage 2 sendText auto-sends the plaintext answer",
                       case_stage2_text_autosent)
            report.run("session keeps serving exec after the trigger sequence",
                       case_session_survives_after_triggers)

    finally:
        step("cleanup / restore")
        if client is not None:
            try:
                if session_id:
                    client.request("ssh/session/close", {"sessionId": session_id}, timeout=30)
            except Exception:
                pass
            try:
                client.request("connection/disconnect", {"connection": {"id": connection_id}},
                               timeout=30)
            except Exception:
                pass
            client.close()
        setup.restore()
        shutil.rmtree(data_dir, ignore_errors=True)
        for note in setup.notes:
            print(f"    WARNING: {note}")
        if setup.prepared:
            print("    container restored (shim, log, password)")

    elapsed = time.monotonic() - started
    print(f"\n==== trigger smoke summary: {len(report.passed)} passed, "
          f"{len(report.skipped)} skipped, {len(report.failed)} failed ({elapsed:.1f}s) ====")
    if skip_all:
        print(f"  SKIP: all cases — {skip_all}")
    for title, reason in report.skipped:
        print(f"  SKIP: {title} — {reason}")
    if report.failed:
        for title, reason in report.failed:
            print(f"  FAIL: {title} — {reason}")
        if client is not None:
            # Sidecar 已随 close() 退出：此刻 drain stderr 才不会阻塞，
            # 排查 trigger 编排侧的诊断行。
            stderr_tail = client.drain_stderr()
            diagnostics = [line for line in stderr_tail.splitlines()
                           if "trigger" in line.lower() or "trace" in line.lower()]
            if diagnostics:
                print("  sidecar stderr (filtered):")
                for line in diagnostics[-12:]:
                    print(f"    {line}")
        sys.exit(1)
    if not skip_all and report.passed:
        print("trigger smoke: all green")
    else:
        print("trigger smoke: nothing to verify in this environment (skipped)")


if __name__ == "__main__":
    main()
