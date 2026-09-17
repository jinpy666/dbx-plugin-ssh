#!/usr/bin/env python3
"""Agent terminal mode (teaching mode) instance-level e2e suite.

Drives the real sidecar (the same way the DBX embedded bridge does:
mcp/call + lifecycle payloads) against a real SSH target (the local test
container by default, any vagrant/remote box via --host/--port/--user/
--password). A scripted "human" answers approval prompts through the
ssh/agent/resolve RPC and injects Ctrl-C through the PTY binary channel,
covering the full routing matrix, approval semantics, concurrency, shell
reuse, capture quality and lifecycle edges.

Usage:
    python3 scripts/e2e_agent_terminal.py                # default container
    python3 scripts/e2e_agent_terminal.py --host H --port P --user U --password W
    python3 scripts/e2e_agent_terminal.py --binary PATH  # sidecar under test
    python3 scripts/e2e_agent_terminal.py --skip-timeout-case  # fast run

Scenario list (one report entry each):
  Group 1 - routing matrix
    01 settings_set rejects an invalid agentTerminalMode value
    02 off + runInTerminal:true + low risk  -> runs, mode:"terminal"
    03 off + runInTerminal:true + sudo      -> denied ("Agent terminal mode is off")
    04 auto + low risk, no override         -> runs + ssh/agent/notice event
    05 auto + runInTerminal:false           -> hidden channel, no mode field
  Group 2 - approval semantics (strict)
    06 strict + low  -> prompt -> approve (no edit) -> runs
    07 strict + low  -> prompt -> approve WITH command edit -> edited runs
    08 strict + low  -> prompt -> deny -> "denied" error + finish{denied}
    09 duplicate resolve of one challengeId is rejected (one-shot)
    10 resolve decision "maybe" is rejected with an approve/deny hint
    11 approval timeout: no resolve for 120s -> "timed out" (longest case)
  Group 3 - destructive gate + approval
    12 catastrophic command without confirmDestructive -> gate error first
    13 catastrophic + confirmDestructive + approve -> runs, directory gone
    14 catastrophic + confirmDestructive + deny -> "denied", directory stays
  Group 4 - connection reuse & shell state
    15 export/cd persist across calls (same interactive shell)
    16 same-session concurrency is serialized, captures don't interleave
    17 second connection/session runs in parallel (< 7.5s for 2 x sleep 4)
  Group 5 - capture quality
    18 2 MiB stream stays bounded (< 1.5 MiB captured)
    19 ANSI escapes stripped from the captured output
    20 stderr is captured (PTY merged stream)
    21 slow trickle (300ms debounce does not cut the capture short)
    22 multi-line command executes line by line
  Group 6 - lifecycle & intervention
    23 timeout returns incomplete:true; Ctrl-C takeover recovers the shell
    24 manual Ctrl-C interrupts early, incomplete:false
    25 ssh/session/close while a command runs: the call must end bounded
    26 mode survives session close/reopen (connection-level memory)

Target requirements: any SSH target with a shell. Scenarios 13/14 need a
sudo-capable target; availability is probed through the hidden channel
(`echo <pw> | sudo -S true`) right after the session opens, and those two
scenarios print SKIP (not FAIL) when the probe fails. Scenario 11 waits out
the full 120s approval timeout unless --skip-timeout-case is given.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import (FRAME_JSON, SidecarClient, SidecarError,
                            lifecycle_params)

DEFAULT_BINARY = str(Path(__file__).resolve().parent.parent
                     / "backend" / "target" / "release" / "dbx-plugin-ssh")

# Captures must stay under the 1 MiB recorder window (+slack); scenario 18.
CAPTURE_BUDGET = 1536 * 1024
# Approval timeout inside the sidecar is a fixed 120s (no knob); scenario 11
# waits a bit past it before giving up on the error itself.
APPROVAL_TIMEOUT_WAIT = 140.0


class SkipSignal(Exception):
    """Raised by a scenario to skip itself for environmental reasons."""


class Suite:
    """report()/run_case() bookkeeping in the smoke-test reporting style."""

    def __init__(self):
        self.entries: list[tuple[str, str, str]] = []  # (name, status, detail)

    def report(self, name: str, ok: bool, detail: str = "",
               skipped: bool = False) -> None:
        status = "SKIP" if skipped else ("PASS" if ok else "FAIL")
        self.entries.append((name, status, detail))
        print(f"{'PASS' if ok and not skipped else status}  {name}"
              + (f"  -- {detail}" if detail else ""))

    def run_case(self, name: str, case) -> None:
        """One scenario, one try: a crash records FAIL and the suite moves on."""
        print(f"\n--- {name}")
        try:
            case()
        except SkipSignal as reason:
            self.report(name, False, str(reason), skipped=True)
        except SidecarError as error:
            self.report(name, False, str(error)[:300])
        except Exception as error:  # noqa: BLE001 - report and continue
            self.report(name, False, f"{type(error).__name__}: {error}"[:300])
        else:
            self.report(name, True)

    def summary(self) -> int:
        failed = [(n, d) for n, s, d in self.entries if s == "FAIL"]
        skipped = [(n, d) for n, s, d in self.entries if s == "SKIP"]
        passed = len(self.entries) - len(failed) - len(skipped)
        print("\n" + "=" * 64)
        for name, status, detail in self.entries:
            print(f"{status:4}  {name}" + (f"  -- {detail[:160]}" if detail else ""))
        print("=" * 64)
        print(f"{passed}/{len(self.entries) - len(skipped)} passed"
              f" ({len(skipped)} skipped)"
              + (f"; FAILED: {[n for n, _ in failed]}" if failed else ""))
        return 1 if failed else 0


def auto_accept_challenge(event: dict) -> dict | None:
    """Auto-accept host-key challenges while a request is in flight."""
    if event.get("method") != "connection/challenge":
        return None
    params = event.get("params", {}).get("params") or event.get("params", {})
    if "challengeId" not in params:
        return None
    print(f"    host-key challenge: {params.get('keyType')} "
          f"{str(params.get('fingerprint'))[:32]}...")
    return {
        "method": "ssh/host-key/resolve",
        "params": {
            "challengeId": params["challengeId"],
            "operationId": params.get("operationId"),
            "accept": True,
            "remember": True,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Agent terminal mode full-scenario e2e suite")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--user", default="sshuser")
    parser.add_argument("--password", default="DbxTest2026")
    parser.add_argument("--binary", default=DEFAULT_BINARY)
    parser.add_argument("--skip-timeout-case", action="store_true",
                        help="skip scenario 11 (120s approval-timeout wait)")
    args = parser.parse_args()

    suite = Suite()
    started = time.monotonic()
    client = SidecarClient.start(timeout=30, binary=args.binary)
    state: dict = {}

    # Every ssh/agent/* event (prompt/notice/finish) observed while requests
    # are in flight lands here as (method, params) for later assertions.
    agent_events: list[tuple[str, dict]] = []
    prompts: list[dict] = []

    def collect(event: dict) -> dict | None:
        method = event.get("method")
        if isinstance(method, str) and method.startswith("ssh/agent/"):
            agent_events.append((method, event.get("params", {})))
        return None

    def approve_handler(edit: str | None = None,
                        sink: list | None = None):
        def handler(event: dict) -> dict | None:
            collect(event)  # keep the ssh/agent/* record flowing
            if event.get("method") != "ssh/agent/prompt":
                return None
            params = event.get("params", {})
            prompts.append(params)
            if sink is not None:
                sink.append(params)
            print(f"    [approval] risk={params.get('risk')} "
                  f"command={str(params.get('command'))[:70]!r}"
                  + (f" -> edited to {edit[:70]!r}" if edit else ""))
            resolve = {"challengeId": params["challengeId"],
                       "decision": "approve"}
            if edit is not None:
                resolve["command"] = edit
            return {"method": "ssh/agent/resolve", "params": resolve}
        return handler

    def deny_handler(sink: list | None = None):
        def handler(event: dict) -> dict | None:
            collect(event)  # keep the ssh/agent/* record flowing
            if event.get("method") != "ssh/agent/prompt":
                return None
            params = event.get("params", {})
            prompts.append(params)
            if sink is not None:
                sink.append(params)
            print(f"    [approval] risk={params.get('risk')} "
                  f"command={str(params.get('command'))[:70]!r} -> DENY")
            return {"method": "ssh/agent/resolve",
                    "params": {"challengeId": params["challengeId"],
                               "decision": "deny"}}
        return handler

    try:
        client.initialize()
        connection = {
            "id": "e2e-agent-terminal",
            "name": "e2e-agent-terminal",
            "db_type": "ssh",
            "host": args.host,
            "port": args.port,
            "username": args.user,
            "password": args.password,
            "external_config": {"authentication": "password"},
        }
        connection2_id = connection["id"] + "-2"
        conn2 = dict(connection, id=connection2_id, name=connection2_id)

        print("\n==> connection/connect")
        client.request("connection/connect", lifecycle_params(connection),
                       on_event=auto_accept_challenge)
        print("==> ssh/session/open")
        session = client.request(
            "ssh/session/open",
            {"connectionId": connection["id"], "workbenchId": "e2e-agent-wb",
             "cols": 120, "rows": 30},
            timeout=60, on_event=auto_accept_challenge)
        sid = session.get("sessionId", "e2e-agent-wb")
        state["sid"] = sid
        print(f"    session {sid}")

        def req(method: str, params: dict | None = None,
                timeout: float = 60.0) -> dict:
            return client.request(method, params, timeout=timeout,
                                  on_event=auto_accept_challenge)

        def call_tool(command: str, tool: str = "ssh_exec", extra: dict | None = None,
                      conn_id: str | None = None, on_event=collect,
                      timeout: float = 90.0) -> dict:
            """Embedded-bridge path: mcp/call + lifecycle; tool errors raise."""
            tool_args = {"command": command}
            if extra:
                tool_args.update(extra)
            conn = dict(connection, id=conn_id or connection["id"],
                        name=conn_id or connection["id"])
            result = client.request(
                "mcp/call",
                {"tool": tool, "arguments": tool_args,
                 "lifecycle": lifecycle_params(conn)},
                timeout=timeout, on_event=on_event)
            if result.get("isError"):
                raise SidecarError(str(result))
            return json.loads(result["content"][0]["text"])

        def call_tool_raw(command: str, tool: str = "ssh_exec",
                          extra: dict | None = None, conn_id: str | None = None,
                          on_event=collect, timeout: float = 90.0):
            """Like call_tool but returns the SidecarError instead of raising."""
            try:
                return call_tool(command, tool, extra, conn_id, on_event, timeout)
            except SidecarError as error:
                return error

        def batch(entries: list[tuple[str, dict, str]],
                  timeout: float = 120.0) -> list:
            specs = [{"method": "mcp/call",
                      "params": {"tool": tool, "arguments": arguments,
                                 "lifecycle": lifecycle_params(
                                     dict(connection, id=conn, name=conn))},
                      "timeout": timeout}
                     for tool, arguments, conn in entries]
            return client.request_batch(specs, on_event=auto_accept_challenge)

        def batch_result(entry, label: str) -> dict:
            if "__error" in entry:
                raise AssertionError(f"{label} errored: {entry['__error']}")
            if entry.get("isError"):
                raise AssertionError(f"{label} failed: {str(entry)[:160]}")
            return json.loads(entry["content"][0]["text"])

        input_seq = [0]

        def send_ctrl_c(session_id: str | None = None) -> None:
            # PTY input binary frames carry a u64 BE sequence prefix.
            input_seq[0] += 1
            client.send_binary(f"ssh/terminal/in/{session_id or state['sid']}",
                               struct.pack(">Q", input_seq[0]) + b"\x03")

        def fire_and_forget(method: str, params: dict) -> None:
            # Write-only send used from Timer threads; the stray response is
            # absorbed by whichever pump loop is reading (only the main
            # thread ever pumps, auxiliary threads only write).
            message = {"jsonrpc": "2.0", "id": client.next_id,
                       "method": method, "params": params}
            client.next_id += 1
            client._send_raw(FRAME_JSON, json.dumps(message).encode())  # noqa: SLF001

        def set_mode(mode: str, session_id: str | None = None) -> dict:
            return req("ssh/settings/set",
                       {"sessionId": session_id or state["sid"],
                        "agentTerminalMode": mode})

        def get_mode(session_id: str | None = None):
            return req("ssh/settings/get",
                       {"sessionId": session_id or state["sid"]}
                       ).get("agentTerminalMode")

        def finish_statuses() -> list:
            return [p.get("status") for m, p in agent_events
                    if m == "ssh/agent/finish"]

        def agent_methods() -> list:
            return [m for m, _ in agent_events]

        def open_session(workbench: str, connection_id: str) -> str:
            session = req("ssh/session/open",
                          {"connectionId": connection_id, "workbenchId": workbench,
                           "cols": 120, "rows": 30})
            return session.get("sessionId", workbench)

        # -- sudo probe for scenarios 13/14 (hidden channel, mode still off) --
        print("\n==> sudo availability probe (hidden channel)")
        try:
            probe = call_tool(f"echo {args.password} | sudo -S true",
                              extra={"runInTerminal": False}, timeout=30)
            sudo_ok = probe.get("exitCode") == 0
        except SidecarError:
            sudo_ok = False
        print(f"    sudo usable: {sudo_ok}")

        # ===================== Group 1: routing matrix =====================

        def case_01_invalid_mode_value():
            error = ""
            try:
                req("ssh/settings/set",
                    {"sessionId": sid, "agentTerminalMode": "banana"})
            except SidecarError as raised:
                error = str(raised)
            else:
                raise AssertionError("invalid agentTerminalMode was accepted")
            if "agentTerminalMode" not in error:
                raise AssertionError(f"unexpected error: {error}")
            mode = get_mode()
            if mode != "off":
                raise AssertionError(f"mode after rejection = {mode!r}, want off")
            print(f"    rejected: {error[:90]}; settings_get still off")

        def case_02_off_forced_terminal_low():
            marker = f"forced-low-{int(time.time())}"
            result = call_tool(f"echo {marker}", extra={"runInTerminal": True})
            if result.get("mode") != "terminal":
                raise AssertionError(f"mode={result.get('mode')!r}, want terminal")
            if marker not in str(result.get("output", "")):
                raise AssertionError(f"output missing marker: "
                                     f"{str(result.get('output'))[:160]!r}")
            print(f"    off mode still runs low risk when forced: "
                  f"{str(result.get('output')).strip()[:50]!r}")

        def case_03_off_forced_terminal_sudo():
            # 现行语义（7440ad9 起，见 agent_terminal::decide 文档）：off 下
            # elevated 命令仅在显式 runInTerminal=true 时改为弹审批（Prompt），
            # 未显式选择仍是硬拒绝（Deny）。两支都验：
            # a) off + elevated、未显式选择 → 隐藏通道直跑（off 模式即静默
            # 通道，elevated 不改路由；远端 sudo 无 tty 会失败但仍是正常结果），
            # 响应不携带 mode 字段。
            result = call_tool("sudo whoami")
            if "mode" in result:
                raise AssertionError(f"hidden-channel run leaks mode field: {result}")
            print(f"    hidden channel ran sudo (no opt-in): "
                  f"{str(result.get('output')).strip()[:60]!r} exit={result.get('exitCode')}")
            # b) off + elevated + 显式 runInTerminal=true → 弹审批；拒绝后报
            # denied（而不是无声运行或超时）。
            agent_events.clear()
            error = call_tool_raw("sudo whoami", extra={"runInTerminal": True},
                                  on_event=deny_handler())
            if not isinstance(error, SidecarError):
                raise AssertionError("off + explicit opt-in + sudo unexpectedly ran")
            if "denied" not in str(error):
                raise AssertionError(f"unexpected explicit-deny error: {str(error)[:160]}")
            print(f"    denied after explicit opt-in prompt: {str(error)[:80]}")

        def case_04_auto_low_notice():
            set_mode("auto")
            marker = f"auto-notice-{int(time.time())}"
            agent_events.clear()
            result = call_tool(f"echo {marker}")
            output = str(result.get("output", ""))
            if result.get("mode") != "terminal":
                raise AssertionError(f"mode={result.get('mode')!r}, want terminal")
            if marker not in output:
                raise AssertionError(f"output missing marker: {output[:160]!r}")
            notices = [p for m, p in agent_events if m == "ssh/agent/notice"]
            if not notices:
                raise AssertionError("no ssh/agent/notice event observed")
            if notices[-1].get("risk") != "low":
                raise AssertionError(f"notice risk={notices[-1].get('risk')!r}")
            print(f"    notice event: tool={notices[-1].get('tool')} "
                  f"risk={notices[-1].get('risk')}")

        def case_05_auto_hidden_opt_out():
            marker = f"hidden-{int(time.time())}"
            result = call_tool(f"echo {marker}", extra={"runInTerminal": False})
            output = str(result.get("output", ""))
            if marker not in output:
                raise AssertionError(f"hidden output missing marker: {output[:160]!r}")
            if "mode" in result:
                raise AssertionError(f"hidden response leaks mode field: {result}")
            print(f"    hidden channel: {output.strip()[:50]!r}, no mode field")

        # ================= Group 2: approval semantics ======================

        def case_06_strict_approve_plain():
            set_mode("strict")
            marker = f"approved-{int(time.time())}"
            agent_events.clear()
            result = call_tool(f"echo {marker}", on_event=approve_handler())
            output = str(result.get("output", ""))
            if marker not in output:
                raise AssertionError(f"approved output missing marker: {output[:160]!r}")
            if "ssh/agent/prompt" not in agent_methods():
                raise AssertionError("no prompt event observed "
                                     f"(saw: {agent_methods()})")
            if finish_statuses()[-1] != "done":
                raise AssertionError(f"last finish={finish_statuses()[-1]!r}, want done")
            print(f"    approved and executed: {output.strip()[:50]!r}")

        def case_07_strict_approve_edited():
            ts = int(time.time())
            agent_events.clear()
            result = call_tool(f"echo ORIGINAL-{ts}",
                               on_event=approve_handler(edit=f"echo EDITED-{ts}"))
            output = str(result.get("output", ""))
            if f"EDITED-{ts}" not in output:
                raise AssertionError(f"edited command did not run: {output[:160]!r}")
            if f"ORIGINAL-{ts}" in output:
                raise AssertionError(f"original command leaked through: {output[:200]!r}")
            print(f"    edited command executed: {output.strip()[:60]!r}")

        def case_08_strict_deny():
            ts = int(time.time())
            agent_events.clear()
            error = call_tool_raw(f"echo denied-{ts}", on_event=deny_handler())
            if not isinstance(error, SidecarError):
                raise AssertionError("denied command unexpectedly succeeded")
            if "denied" not in str(error):
                raise AssertionError(f"unexpected deny error: {str(error)[:160]}")
            if finish_statuses()[-1] != "denied":
                raise AssertionError(
                    f"last finish={finish_statuses()[-1]!r}, want denied")
            print(f"    denied as expected: {str(error)[:90]}")

        def case_09_duplicate_resolve():
            seen: list = []
            marker = f"oneshot-{int(time.time())}"
            result = call_tool(f"echo {marker}",
                               on_event=approve_handler(sink=seen))
            if marker not in str(result.get("output", "")):
                raise AssertionError("approved command did not run")
            if not seen:
                raise AssertionError("no challenge captured to re-resolve")
            challenge_id = seen[-1]["challengeId"]
            try:
                req("ssh/agent/resolve",
                    {"challengeId": challenge_id, "decision": "approve"})
            except SidecarError as raised:
                if "not found or already resolved" not in str(raised):
                    raise AssertionError(f"unexpected error: {str(raised)[:160]}")
                print(f"    one-shot enforced: {str(raised)[:90]}")
            else:
                raise AssertionError("duplicate resolve was accepted")

        def case_10_invalid_decision():
            holder: dict = {}
            answered = [False]

            def maybe_then_deny(event: dict) -> dict | None:
                collect(event)  # keep the ssh/agent/* record flowing
                if event.get("method") == "ssh/agent/prompt":
                    params = event.get("params", {})
                    holder["challengeId"] = params["challengeId"]
                    print(f"    [approval] risk={params.get('risk')} "
                          f"command={str(params.get('command'))[:60]!r} -> maybe")
                    return {"method": "ssh/agent/resolve",
                            "params": {"challengeId": params["challengeId"],
                                       "decision": "maybe"}}
                # The follow-up resolve replies with a JSON-RPC error object;
                # it surfaces here like any other non-matching message.
                if not answered[0] and "error" in event:
                    answered[0] = True
                    holder["maybe_error"] = str(
                        event["error"].get("message", ""))
                    return {"method": "ssh/agent/resolve",
                            "params": {"challengeId": holder["challengeId"],
                                       "decision": "deny"}}
                return None

            ts = int(time.time())
            error = call_tool_raw(f"echo maybe-{ts}",
                                  on_event=maybe_then_deny, timeout=60)
            maybe_error = holder.get("maybe_error", "")
            if "approve" not in maybe_error or "deny" not in maybe_error:
                raise AssertionError(f"decision validation message wrong: "
                                     f"{maybe_error[:160]!r}")
            if not isinstance(error, SidecarError) or "denied" not in str(error):
                raise AssertionError(f"challenge not denied after 'maybe': "
                                     f"{str(error)[:160]}")
            print(f"    rejected decision: {maybe_error[:90]}")

        def case_11_approval_timeout():
            if args.skip_timeout_case:
                raise SkipSignal("--skip-timeout-case given")
            agent_events.clear()
            box: dict = {}

            def bg():
                box["error"] = call_tool_raw(f"echo timeout-{int(time.time())}",
                                             timeout=APPROVAL_TIMEOUT_WAIT)

            thread = threading.Thread(target=bg)
            thread.start()
            print("    waiting out the 120s approval timeout ", end="", flush=True)
            waited = 0.0
            while thread.is_alive() and waited < APPROVAL_TIMEOUT_WAIT + 10:
                thread.join(timeout=5)
                if thread.is_alive():
                    waited += 5
                    print(".", end="", flush=True)
            thread.join(timeout=15)
            print()
            error = box.get("error")
            if not isinstance(error, SidecarError):
                raise AssertionError(f"timeout approval unexpectedly succeeded: {error}")
            if "timed out" not in str(error):
                raise AssertionError(f"unexpected error: {str(error)[:160]}")
            if finish_statuses()[-1] != "denied":
                raise AssertionError(
                    f"last finish={finish_statuses()[-1]!r}, want denied on timeout")
            print(f"    approval timed out after {waited:.0f}s: {str(error)[:80]}")

        # ============== Group 3: destructive gate + approval ================

        scratch_seq = [0]

        def scratch_dir() -> str:
            scratch_seq[0] += 1
            return f"/tmp/agent-e2e-{int(time.time())}-{scratch_seq[0]}"

        def case_12_destructive_gate_first():
            set_mode("auto")
            error = call_tool_raw("rm -rf /etc",  # noqa: S108 - fake target
                                  extra={"runInTerminal": True})
            if not isinstance(error, SidecarError):
                raise AssertionError("catastrophic command ran without confirmation")
            if "confirmDestructive" not in str(error):
                raise AssertionError(f"unexpected error: {str(error)[:160]}")
            print(f"    gate fired before routing: {str(error)[:100]}")

        def case_13_destructive_confirm_approve():
            if not sudo_ok:
                raise SkipSignal("target has no usable sudo (13/14 skipped)")
            target = scratch_dir()
            made = call_tool(f"mkdir -p {target} && touch {target}/keep.txt",
                             extra={"runInTerminal": False})
            if made.get("exitCode") != 0:
                raise AssertionError(f"scratch dir setup failed: {made}")
            # /tmp/tmp alone hits the catastrophic classifier (recursive rm
            # near a system root); together with the scratch dir the command
            # is both gate-checked and observable on disk.
            command = f"rm -rf /tmp/tmp {target}"
            agent_events.clear()
            result = call_tool(command, extra={"confirmDestructive": True},
                               on_event=approve_handler())
            elevated = [p for p in prompts if p.get("risk") == "elevated"]
            if not elevated:
                raise AssertionError("no elevated approval prompt observed")
            exists = req("sftp/exists", {"sessionId": state["sid"], "path": target})
            if exists.get("exists") is not False:
                raise AssertionError(f"{target} still exists after approved rm")
            print(f"    approved destructive run removed {target}")

        def case_14_destructive_confirm_deny():
            if not sudo_ok:
                raise SkipSignal("target has no usable sudo (13/14 skipped)")
            target = scratch_dir()
            call_tool(f"mkdir -p {target} && touch {target}/keep.txt",
                      extra={"runInTerminal": False})
            command = f"rm -rf /tmp/tmp {target}"
            error = call_tool_raw(command, extra={"confirmDestructive": True},
                                  on_event=deny_handler())
            if not isinstance(error, SidecarError):
                raise AssertionError("denied destructive command ran anyway")
            if "denied" not in str(error):
                raise AssertionError(f"unexpected error: {str(error)[:160]}")
            exists = req("sftp/exists", {"sessionId": state["sid"], "path": target})
            if exists.get("exists") is not True:
                raise AssertionError(f"{target} vanished despite the deny")
            call_tool(f"rm -rf {target}", extra={"runInTerminal": False})
            print(f"    denied destructive run left {target} in place")

        # ============= Group 4: connection reuse & shell state ==============

        def case_15_shell_state_persistence():
            set_mode("auto")
            ts = int(time.time())
            call_tool(f"export AGENT_E2E_TOKEN={ts}")
            echo = call_tool("echo $AGENT_E2E_TOKEN")
            if str(ts) not in str(echo.get("output", "")):
                raise AssertionError("export lost between calls: "
                                     f"{str(echo.get('output'))[:160]!r}")
            call_tool("cd /tmp")
            pwd = call_tool("pwd")
            if "/tmp" not in str(pwd.get("output", "")):
                raise AssertionError("cwd lost between calls: "
                                     f"{str(pwd.get('output'))[:160]!r}")
            print(f"    token + cwd survived: {str(echo.get('output')).strip()[:30]!r}"
                  f" / {str(pwd.get('output')).strip()[:30]!r}")

        def case_16_same_session_serialized():
            ts = int(time.time())
            entries = [
                ("ssh_exec", {"command": f"sleep 6 && echo AONLY-{ts}"},
                 connection["id"]),
                ("ssh_exec", {"command": f"echo BONLY-{ts}"}, connection["id"]),
            ]
            began = time.monotonic()
            results = batch(entries, timeout=120)
            out_a = str(batch_result(results[0], "serial A").get("output", ""))
            out_b = str(batch_result(results[1], "serial B").get("output", ""))
            if f"AONLY-{ts}" not in out_a or f"BONLY-{ts}" in out_a:
                raise AssertionError(f"A capture polluted: {out_a[:200]!r}")
            if f"BONLY-{ts}" not in out_b or f"AONLY-{ts}" in out_b:
                raise AssertionError(f"B capture polluted: {out_b[:200]!r}")
            print(f"    serialized pair clean in {time.monotonic() - began:.1f}s")

        def case_17_cross_connection_parallel():
            # The second DBX connection must be registered before its
            # workbench PTY can open; both connections then route in parallel.
            client.request("connection/connect", lifecycle_params(conn2),
                           on_event=auto_accept_challenge)
            session2 = open_session("e2e-agent-wb-2", connection2_id)
            state["sid2"] = session2
            print(f"    second session {session2} on {connection2_id}")
            set_mode("auto", session_id=session2)
            ts = int(time.time())
            entries = [
                ("ssh_exec", {"command": f"sleep 4 && echo P1-{ts}"},
                 connection["id"]),
                ("ssh_exec", {"command": f"sleep 4 && echo P2-{ts}"},
                 connection2_id),
            ]
            began = time.monotonic()
            results = batch(entries, timeout=120)
            elapsed = time.monotonic() - began
            out1 = str(batch_result(results[0], "parallel P1").get("output", ""))
            out2 = str(batch_result(results[1], "parallel P2").get("output", ""))
            if f"P1-{ts}" not in out1:
                raise AssertionError(f"P1 output missing: {out1[:160]!r}")
            if f"P2-{ts}" not in out2:
                raise AssertionError(f"P2 output missing: {out2[:160]!r}")
            if elapsed >= 7.5:
                raise AssertionError(f"cross-connection pair took {elapsed:.1f}s "
                                     "(serialized would need >= 8s; budget 7.5s)")
            print(f"    parallel pair ok in {elapsed:.1f}s (< 7.5s)")

        # =================== Group 5: capture quality =======================

        def case_18_large_output_bounded():
            set_mode("auto")
            result = call_tool("head -c 2097152 /dev/zero | tr '\\0' x; echo",
                               timeout=120)
            output = str(result.get("output", ""))
            if result.get("incomplete") is not False:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}")
            if len(output) >= CAPTURE_BUDGET:
                raise AssertionError(f"capture not bounded: {len(output)} bytes")
            if not output.strip():
                raise AssertionError("empty output for a 2 MiB stream")
            print(f"    captured {len(output)} bytes of the 2 MiB stream")

        def case_19_ansi_stripped():
            result = call_tool("printf '\\033[31mREDE2E\\033[0m\\n'")
            output = str(result.get("output", ""))
            if "REDE2E" not in output:
                raise AssertionError(f"output missing REDE2E: {output[:160]!r}")
            if "\x1b" in output:
                raise AssertionError("captured output still contains ESC bytes")
            print(f"    colored text captured clean: {output.strip()[:40]!r}")

        def case_20_stderr_captured():
            result = call_tool("echo ONSTDERR >&2")
            output = str(result.get("output", ""))
            if "ONSTDERR" not in output:
                raise AssertionError(f"stderr lost: {output[:160]!r}")
            print(f"    stderr merged into capture: {output.strip()[:40]!r}")

        def case_21_slow_trickle():
            result = call_tool("(echo TRICKLE1; sleep 2; echo TRICKLE2; "
                               "sleep 2; echo TRICKLE3)", timeout=60)
            output = str(result.get("output", ""))
            missing = [t for t in ("TRICKLE1", "TRICKLE2", "TRICKLE3")
                       if t not in output]
            if missing:
                raise AssertionError(f"trickle lines lost ({missing}): "
                                     f"{output[:200]!r}")
            if result.get("incomplete") is not False:
                raise AssertionError("trickle capture reported incomplete")
            print("    all three trickle lines captured after the debounce")

        def case_22_multiline_line_by_line():
            result = call_tool("echo MULTI1\necho MULTI2")
            output = str(result.get("output", ""))
            if "MULTI1" not in output or "MULTI2" not in output:
                raise AssertionError(f"multi-line output incomplete: "
                                     f"{output[:160]!r}")
            print(f"    both lines executed: {output.strip()[:50]!r}")

        # ================ Group 6: lifecycle & intervention =================

        def case_23_timeout_takeover():
            set_mode("auto")
            result = call_tool("sleep 25", extra={"timeoutSecs": 5}, timeout=60)
            if result.get("incomplete") is not True:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, "
                                     "want True on timeout")
            if result.get("mode") != "terminal":
                raise AssertionError(f"mode={result.get('mode')!r}")
            send_ctrl_c()  # kill the still-running sleep, as the banner does
            time.sleep(1)
            recovered = call_tool("echo recovered")
            output = str(recovered.get("output", ""))
            if "recovered" not in output:
                raise AssertionError(f"shell not recovered: {output[:160]!r}")
            if recovered.get("incomplete") is not False:
                raise AssertionError("recovery call reported incomplete")
            print("    incomplete reported, leftover sleep cleared, shell recovered")

        def case_24_manual_interrupt():
            ts = int(time.time())
            timer = threading.Timer(2.0, send_ctrl_c)
            timer.start()
            began = time.monotonic()
            try:
                result = call_tool(f"sleep 20 && echo NOTDONE-{ts}", timeout=60)
            finally:
                timer.cancel()
            elapsed = time.monotonic() - began
            output = str(result.get("output", ""))
            if f"NOTDONE-{ts}" in output:
                raise AssertionError("interrupted command still completed")
            if result.get("incomplete") is not False:
                raise AssertionError(f"incomplete={result.get('incomplete')!r}, "
                                     "want False after Ctrl-C settle")
            if elapsed >= 15.0:
                raise AssertionError(f"interrupted call took {elapsed:.1f}s "
                                     "(budget 15s)")
            print(f"    Ctrl-C returned in {elapsed:.1f}s without NOTDONE")

        def case_25_close_while_running():
            # The routed call must end bounded when the session closes mid-run:
            # either a dedicated error mentioning closed/terminal (current
            # behaviour) or, historically, an incomplete:true capture.
            ts = int(time.time())
            timer = threading.Timer(
                1.0, fire_and_forget,
                args=("ssh/session/close", {"sessionId": state["sid"]}))
            timer.start()
            began = time.monotonic()
            try:
                try:
                    outcome = call_tool("sleep 15", extra={"timeoutSecs": 15},
                                        timeout=60)
                except SidecarError as error:
                    outcome = error
            finally:
                timer.cancel()
            elapsed = time.monotonic() - began
            if isinstance(outcome, SidecarError):
                text = str(outcome)
                if "closed" not in text and "terminal" not in text:
                    raise AssertionError(f"unexpected close-race error: "
                                         f"{text[:160]}")
                shape = f"error: {text[:80]}"
            else:
                if outcome.get("incomplete") is not True:
                    raise AssertionError(f"closed-session call returned "
                                         f"{json.dumps(outcome)[:160]}")
                shape = "ok incomplete:true (documented deviation)"
            if elapsed >= 20.0:
                raise AssertionError(f"close-race call took {elapsed:.1f}s "
                                     "(must end within timeoutSecs+5s)")
            print(f"    bounded end after {elapsed:.1f}s ({shape})")

        def case_26_mode_survives_reopen():
            state["sid"] = open_session("e2e-agent-wb-3", connection["id"])
            set_mode("auto")
            req("ssh/session/close", {"sessionId": state["sid"]})
            state["sid"] = open_session("e2e-agent-wb-4", connection["id"])
            mode = get_mode()
            if mode != "auto":
                raise AssertionError(f"mode after reopen = {mode!r}, want auto")
            set_mode("off")
            if get_mode() != "off":
                raise AssertionError("mode did not restore to off")
            print("    agentTerminalMode=auto survived session close/reopen")

        # ------------------------------ run --------------------------------

        print("\n=== group 1: routing matrix ===")
        suite.run_case("01 invalid agentTerminalMode rejected", case_01_invalid_mode_value)
        suite.run_case("02 off + forced terminal + low risk runs", case_02_off_forced_terminal_low)
        suite.run_case("03 off + forced terminal + sudo denied", case_03_off_forced_terminal_sudo)
        suite.run_case("04 auto + low risk runs with notice event", case_04_auto_low_notice)
        suite.run_case("05 auto + runInTerminal=false stays hidden", case_05_auto_hidden_opt_out)

        print("\n=== group 2: approval semantics ===")
        suite.run_case("06 strict + approve (no edit) runs", case_06_strict_approve_plain)
        suite.run_case("07 strict + approve with command edit", case_07_strict_approve_edited)
        suite.run_case("08 strict + deny rejects with finish event", case_08_strict_deny)
        suite.run_case("09 duplicate resolve rejected (one-shot)", case_09_duplicate_resolve)
        suite.run_case("10 invalid decision rejected with hint", case_10_invalid_decision)
        suite.run_case("11 approval timeout returns timed out", case_11_approval_timeout)

        print("\n=== group 3: destructive gate + approval ===")
        suite.run_case("12 catastrophic without confirm rejected first", case_12_destructive_gate_first)
        suite.run_case("13 catastrophic + confirm + approve removes dir", case_13_destructive_confirm_approve)
        suite.run_case("14 catastrophic + confirm + deny keeps dir", case_14_destructive_confirm_deny)

        print("\n=== group 4: connection reuse & shell state ===")
        suite.run_case("15 export/cd persist across calls", case_15_shell_state_persistence)
        suite.run_case("16 same-session concurrency serialized", case_16_same_session_serialized)
        suite.run_case("17 cross-connection parallelism", case_17_cross_connection_parallel)

        print("\n=== group 5: capture quality ===")
        suite.run_case("18 2 MiB output stays bounded", case_18_large_output_bounded)
        suite.run_case("19 ANSI escapes stripped", case_19_ansi_stripped)
        suite.run_case("20 stderr captured via merged PTY stream", case_20_stderr_captured)
        suite.run_case("21 slow trickle fully captured", case_21_slow_trickle)
        suite.run_case("22 multi-line command runs line by line", case_22_multiline_line_by_line)

        print("\n=== group 6: lifecycle & intervention ===")
        suite.run_case("23 timeout takeover recovers via Ctrl-C", case_23_timeout_takeover)
        suite.run_case("24 manual Ctrl-C interrupts early", case_24_manual_interrupt)
        suite.run_case("25 close while running ends bounded", case_25_close_while_running)
        suite.run_case("26 mode survives session close/reopen", case_26_mode_survives_reopen)

    finally:
        # Best-effort teardown: restore modes and close known sessions so the
        # next run starts honest; the sidecar dies with the client anyway.
        for key in ("sid", "sid2"):
            session_id = state.get(key)
            if not session_id:
                continue
            try:
                client.request("ssh/settings/set",
                               {"sessionId": session_id, "agentTerminalMode": "off"})
            except Exception:  # noqa: BLE001
                pass
            try:
                client.request("ssh/session/close", {"sessionId": session_id})
            except Exception:  # noqa: BLE001
                pass
        client.close()

    print(f"\ntotal elapsed: {time.monotonic() - started:.1f}s")
    sys.exit(suite.summary())


if __name__ == "__main__":
    main()
