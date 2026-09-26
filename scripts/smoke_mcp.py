#!/usr/bin/env python3
"""MCP stdio smoke test for the plugin's --mcp server mode.

Spawns the sidecar with --mcp and verifies, against the real process:
  1. initialize handshake (protocol version + server info),
  2. tools/list contents and schemas,
  3. argument validation ordering on a connection-bound tool,
  4. a real tools/call round-trip (ssh_list_known_hosts),
  5. global Quick Sudo profile management round-trip (save/list/delete),
     including the quickSudoProfile argument on ssh_exec_sudo,
  6. local-side validation of the transfer tools (sftp_upload /
     sftp_download) failing before any connection attempt,
  7. production misoperation guards: destructive commands require
     confirmDestructive (gate fires before credential validation), and a
     second server started with DBX_SSH_MCP_READ_ONLY=1 enforces the
     read-only gates process-wide (write tools refused, ssh_exec limited
     to whitelisted inspection commands, confirmation cannot override),
  8. the stdio app-bridge path failing with an actionable error when the
     DBX app has not published its bridge port (empty app-data dir, no-op
     launch command — no UI, no SSH server involved),
 9. connection discovery + addressing usability: every connection-bound
    tool advertises connectionName and the selector anyOf, and
    ssh_list_connections answers (degraded source when no app runs),
 10. intent recognition: alert triage classifies cpu / memory / disk
     intents with whitelist-safe suggestions,
 11. LLM input tolerance: numeric values sent as strings (port,
     timeoutSecs) parse instead of silently falling back to defaults,
     malformed ports fail fast with a range error, string booleans
     (confirmDestructive: "true") pass the destructive gate, unknown tool
     names get a did-you-mean suggestion, and ssh_multi_exec rejects
     non-array targets with guidance,
 12. app-bridge degradation matrix against a stub DBX app (an in-process
     HTTP server publishing mcp-bridge-port): ssh_list_connections merges
     the bridge list, ssh_exec/sftp_stat forwards through
     /call-plugin-tool and returns the app's envelope, and — against a
     dead port — every representative connection-bound tool fails closed
     fast with the full self-heal trio while the list degrades to the
     session registry with a note,
 13. an agentic workflow loop: initialize → tools/list →
     ssh_list_connections (degraded) → a connectionName call failing with
     guidance → the guidance fixing the next call (inline endpoint) → a
     second guidance (password required) → local verification tools
     (known_hosts, alert triage) succeeding. Each error must literally
     enable the next step,
 14. protocol robustness (reliability round 5): hostile stdio transport
     input — invalid JSON, invalid UTF-8 bytes, notifications, malformed
     envelopes (bad jsonrpc / missing method / object·null·bool ids), an
     8 MiB single line, pipelined requests answered 1:1 by id, and blank /
     CRLF lines — none of which may crash or wedge the server; every case
     ends with a legal request proving the session is still healthy,
 15. the single-line ceiling (round 6): with DBX_SSH_MCP_STDIO_MAX_LINE
     lowered, an over-limit line answers one -32700 naming the limit and
     the env var, and the session keeps serving the next request; plus the
     round-6 missing-required enumeration (both gaps named in one error).

With --host (plus --username/--password, or the DBX_SSH_SMOKE_PASSWORD
environment variable) a live section additionally runs a real round-trip
against an SSH server: ssh_test_connection, a browse-before-exec SFTP
probe (sftp_pwd / sftp_list_dir lazily establish the connection — the
local_ubuntu coverage regression), ssh_exec, the full SFTP file family
(write→read→stat→exists→mkdir→copy→rename→chmod→move→disk_usage→remove),
an ssh_run_bg → ssh_task_status round-trip, ssh_metrics, and an
sftp_upload → sftp_download loop compared byte-for-byte. Round 7 adds the
live enum/assertion tail that the offline schema-check probes cannot
reach past the connection gate: sftp_chmod's mode semantics (invalid
values list the legal octal forms and leave the file untouched), the
ssh_multi_exec mode enum (invalid AND wrong-case values fail fast with
the full legal list before any dial), ssh_exec_sudo's authFlowMode
(uppercase variants normalize, unrecognized values fall back to the
default flow as the schema description documents), and a live pipelining
check (two requests of different ids sent back-to-back — sftp_pwd +
ssh_metrics — must come back 1:1 with payloads matching their own ids).
The container
from docs (linuxserver/openssh-server on 127.0.0.1:2222, user `sshuser`)
is the intended target; credentials never live in this file.

Usage:
    python3 scripts/smoke_mcp.py [--binary backend/target/release/dbx-plugin-ssh]
                                 [--host 127.0.0.1 --port 2222
                                  --username sshuser --password ...]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

EXPECTED_TOOLS = [
    "ssh_exec",
    "ssh_exec_sudo",
    "ssh_multi_exec",
    "ssh_terminal_input",
    "ssh_run_bg",
    "ssh_task_status",
    "ssh_metrics",
    "ssh_close",
    "ssh_test_connection",
    "ssh_list_known_hosts",
    "ssh_list_connections",
    "ssh_remove_known_host",
    "ssh_quick_sudo_profiles_list",
    "ssh_quick_sudo_profiles_save",
    "ssh_quick_sudo_profiles_delete",
    "sftp_list_dir",
    "sftp_stat",
    "sftp_exists",
    "sftp_pwd",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_mkdir",
    "sftp_remove",
    "sftp_rename",
    "sftp_chmod",
    "sftp_copy",
    "sftp_move",
    "sftp_disk_usage",
    "sftp_upload",
    "sftp_download",
    "ssh_alert_triage",
]

# Tools that target a connection: the selector anyOf (connectionId |
# connectionName | host+port+username) must be advertised on every one of
# them, or strict MCP hosts drop the arguments or refuse the call before
# the sidecar can resolve the saved connection.
CONNECTION_BOUND_TOOLS = [
    "ssh_exec",
    "ssh_exec_sudo",
    "ssh_run_bg",
    "ssh_task_status",
    "ssh_metrics",
    "ssh_test_connection",
    "sftp_list_dir",
    "sftp_stat",
    "sftp_exists",
    "sftp_pwd",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_mkdir",
    "sftp_remove",
    "sftp_rename",
    "sftp_chmod",
    "sftp_copy",
    "sftp_move",
    "sftp_disk_usage",
    "sftp_upload",
    "sftp_download",
]


def send(proc: subprocess.Popen, payload: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write((json.dumps(payload) + "\n").encode())
    proc.stdin.flush()


def recv(proc: subprocess.Popen, want_id: int) -> dict:
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if not line:
            raise AssertionError("sidecar closed the stream before replying")
        message = json.loads(line)
        if message.get("id") == want_id:
            return message


def call_tool(proc: subprocess.Popen, next_id: list, name: str, arguments: dict) -> dict:
    next_id[0] += 1
    send(proc, {
        "jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    })
    message = recv(proc, next_id[0])
    if "error" in message:
        raise AssertionError(f"{name} errored: {message['error'].get('message')}")
    result = message["result"]
    if result.get("isError", False):
        raise AssertionError(f"{name} failed: {result}")
    return json.loads(result["content"][0]["text"])


def call_tool_error(proc: subprocess.Popen, next_id: list, name: str, arguments: dict) -> str:
    next_id[0] += 1
    send(proc, {
        "jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    })
    return recv(proc, next_id[0])["error"]["message"]


def sftp_file_family(proc: subprocess.Popen, next_id: list, connection: dict) -> None:
    """Full SFTP file family under /tmp: write → read → stat → exists →
    mkdir → copy → rename → chmod → move → disk_usage → remove (file + dir).
    Every call goes through the same lazy-establish pool path."""
    base = f"/tmp/smoke-mcp-family-{uuid.uuid4().hex[:8]}"
    file_a, file_b = f"{base}/probe.txt", f"{base}/probe-renamed.txt"
    payload = f"smoke-family-{uuid.uuid4().hex}"
    # write_file requires an existing parent (no implicit mkdir), so the
    # directory comes first — also the mkdir arm's live coverage.
    call_tool(proc, next_id, "sftp_mkdir", {**connection, "path": base})
    written = call_tool(proc, next_id, "sftp_write_file", {
        **connection, "path": file_a, "content": payload,
    })
    assert written["bytes"] == len(payload.encode()), written
    read_back = call_tool(proc, next_id, "sftp_read_file", {
        **connection, "path": file_a,
    })
    assert read_back["content"] == payload, read_back

    stat = call_tool(proc, next_id, "sftp_stat", {**connection, "path": file_a})
    assert stat["size"] == len(payload.encode()), stat
    assert call_tool(proc, next_id, "sftp_exists", {
        **connection, "path": file_a,
    })["exists"] is True
    assert call_tool(proc, next_id, "sftp_exists", {
        **connection, "path": f"{base}/no-such-probe",
    })["exists"] is False

    call_tool(proc, next_id, "sftp_mkdir", {**connection, "path": f"{base}/sub"})
    # copy/move take from (string or array) plus toDir; the target name is
    # derived from the source.
    call_tool(proc, next_id, "sftp_copy", {
        **connection, "from": file_a, "toDir": f"{base}/sub",
    })
    copy_target = call_tool(proc, next_id, "sftp_exists", {
        **connection, "path": f"{base}/sub/probe.txt",
    })
    assert copy_target["exists"] is True, copy_target
    call_tool(proc, next_id, "sftp_rename", {
        **connection, "sourcePath": file_a, "targetPath": file_b,
    })
    call_tool(proc, next_id, "sftp_chmod", {
        **connection, "path": file_b, "mode": 0o600,
    })
    mode = call_tool(proc, next_id, "sftp_stat", {**connection, "path": file_b})
    assert mode["permissions"] == "0600", mode
    # The octal-digit number form (600, all digits 0-7) must land on the
    # same permission bits as the raw-bit form above (LLM variant).
    call_tool(proc, next_id, "sftp_chmod", {
        **connection, "path": file_b, "mode": 600,
    })
    mode = call_tool(proc, next_id, "sftp_stat", {**connection, "path": file_b})
    assert mode["permissions"] == "0600", mode
    call_tool(proc, next_id, "sftp_move", {
        **connection, "from": f"{base}/sub/probe.txt", "toDir": base,
    })
    usage = call_tool(proc, next_id, "sftp_disk_usage", {**connection, "path": "/tmp"})
    assert usage["totalBytes"] > 0 and usage["availableBytes"] >= 0, usage

    call_tool(proc, next_id, "sftp_remove", {**connection, "path": file_b})
    call_tool(proc, next_id, "sftp_remove", {**connection, "path": f"{base}/probe.txt"})
    call_tool(proc, next_id, "sftp_remove", {
        **connection, "path": base, "recursive": True,
    })
    assert call_tool(proc, next_id, "sftp_exists", {**connection, "path": base})["exists"] is False
    print("sftp file family round-trip ok")


def live_round_trip(proc: subprocess.Popen, args, id_base: int) -> None:
    """Real-server section: test, browse-first, exec, the full SFTP
    file family, a background task round-trip, metrics, and an
    upload/download loop compared byte-for-byte (mirrors what an MCP client
    such as ZCode does end to end)."""
    next_id = [id_base]
    connection = {
        "host": args.host, "port": args.port,
        "username": args.username, "password": args.password,
    }

    # Standalone MCP mode TOFU-trusts unknown host keys, so a first-time
    # connection succeeds without a prior manual confirmation.
    pong_test = call_tool(proc, next_id, "ssh_test_connection", dict(connection))
    assert pong_test["ok"] is True, pong_test
    assert pong_test["latencyMs"] >= 0, pong_test
    print("ssh_test_connection ok")

    # Browse before exec: the SFTP tools must dial lazily on first use
    # (local_ubuntu coverage regression - the browse family used to demand
    # a pre-established pool entry).
    home = call_tool(proc, next_id, "sftp_pwd", dict(connection))["home"]
    assert home.startswith("/"), home
    listing = call_tool(proc, next_id, "sftp_list_dir", {
        **connection, "path": home,
    })
    assert isinstance(listing["entries"], list), listing
    print("sftp browse-first ok")

    pong = call_tool(proc, next_id, "ssh_exec", {
        **connection, "command": "echo smoke-$((40+2))",
    })
    assert pong["output"].strip() == "smoke-42", pong
    assert pong["exitCode"] == 0, pong

    # ssh_multi_exec is saved-connection-only (targets resolve through the
    # lifecycle registry; an inline endpoint has no registry identity). In
    # standalone stdio mode that means a guidance error before any dial,
    # plus the destructive gate must fire first on the command text.
    unresolved = call_tool_error(proc, next_id, "ssh_multi_exec", {
        **connection,
        "targets": [connection["host"]],
        "command": "echo unreachable",
    })
    assert "No saved connection matched" in unresolved, unresolved
    refused_multi = call_tool_error(proc, next_id, "ssh_multi_exec", {
        **connection, "targets": [connection["host"]],
        "command": "mkfs.ext4 /dev/sda1",
    })
    assert "confirmDestructive" in refused_multi, refused_multi
    print("ssh_multi_exec saved-ref guidance + destructive gate ok")

    # ssh_terminal_input is visible-terminal-only: stdio mode has no
    # workbench PTY, so the call must fail with the guidance error instead
    # of silently running on a hidden channel (IMPL_PLAN_NETCATTY A2-T6).
    guidance = call_tool_error(proc, next_id, "ssh_terminal_input", {
        **connection, "input": "echo no-session\r",
    })
    assert "terminal" in guidance.lower(), guidance
    print("ssh_terminal_input no-session guidance ok")

    # Command locating: a quick job stays under ssh_exec, a slow one is
    # staged with ssh_run_bg and polled with ssh_task_status.
    task = call_tool(proc, next_id, "ssh_run_bg", {
        **connection, "command": "echo bg-probe-start && sleep 2 && echo bg-probe-done",
    })
    assert task["logPath"].startswith("/tmp/.dbx-ssh-tasks/"), task
    assert task["pollWith"] == "ssh_task_status", task
    status = {}
    for _ in range(20):
        status = call_tool(proc, next_id, "ssh_task_status", {
            **connection, "logPath": task["logPath"], "tailBytes": 200,
        })
        if status.get("done"):
            break
        time.sleep(0.5)
    assert status.get("done") is True, status
    assert status["exitCode"] == 0, status
    assert "bg-probe-done" in status["output"], status
    print("ssh_run_bg + ssh_task_status round-trip ok")

    # The destructive gate holds on the live path too: a catastrophic
    # command is refused on a healthy connection without the flag.
    refused_live = call_tool_error(proc, next_id, "ssh_exec", {
        **connection, "command": "rm -rf /etc",
    })
    assert "confirmDestructive" in refused_live, refused_live
    print("live destructive-command gate ok")

    metrics = call_tool(proc, next_id, "ssh_metrics", dict(connection))
    assert metrics["hostname"] and metrics["cpu"]["cores"] > 0, metrics

    sftp_file_family(proc, next_id, connection)

    # Transfer loop: upload a random payload, read it back via download,
    # compare SHA-256 digests on both sides.
    payload = uuid.uuid4().hex.encode() * 257  # ~8 KiB deterministic blob
    digest = hashlib.sha256(payload).hexdigest()
    remote_path = f"/tmp/smoke-mcp-{uuid.uuid4().hex}.bin"
    local_dir = tempfile.mkdtemp(prefix="smoke-mcp-")
    local_path = f"{local_dir}/roundtrip.bin"
    try:
        uploaded = call_tool(proc, next_id, "sftp_upload", {
            **connection, "localPath": _spool(payload), "remotePath": remote_path,
        })
        assert uploaded["bytes"] == len(payload), uploaded
        remote_digest = call_tool(proc, next_id, "ssh_exec", {
            **connection, "command": f"sha256sum {remote_path}",
        })["output"].split()[0]
        assert remote_digest == digest, f"remote sha mismatch: {remote_digest}"

        call_tool(proc, next_id, "sftp_download", {
            **connection, "remotePath": remote_path, "localPath": local_path,
        })
        with open(local_path, "rb") as handle:
            assert hashlib.sha256(handle.read()).hexdigest() == digest, "local sha mismatch"

        # The downloaded file exists: a second download without overwrite
        # must be refused (proving the local-target guard on a live call).
        refused = call_tool_error(proc, next_id, "sftp_download", {
            **connection, "remotePath": remote_path, "localPath": local_path,
        })
        assert "Local path already exists" in refused, refused
    finally:
        try:
            call_tool(proc, next_id, "sftp_remove", {
                **connection, "path": remote_path,
            })
        except AssertionError as cleanup_error:
            print(f"cleanup warning: {cleanup_error}")

    # Round 7 tail: connection-gated enum error quality + live pipelining
    # (both need a real server; the offline probes stop at the gate).
    live_enum_section(proc, next_id, connection)
    live_pipelining_section(proc, next_id, connection)
    call_tool(proc, next_id, "ssh_close", dict(connection))
    print("live round-trip ok (test/browse/exec/background/family/metrics/transfer)")


def live_enum_section(proc: subprocess.Popen, next_id: list, connection: dict) -> None:
    """Round 7 (§3.3 registration): enum parameter error quality asserted on
    a live server — the offline schema-check probes cannot reach past the
    connection gate. Three representative tools:
    - sftp_chmod mode semantics: invalid values list the legal octal forms
      and leave the target's permission bits untouched;
    - ssh_multi_exec mode enum: invalid AND wrong-case values fail with the
      full legal list (schema enum is lowercase — implementation matches)
      before any dial, so the refusal is side-effect free;
    - ssh_exec_sudo authFlowMode: uppercase variants normalize and run;
      unrecognized values fall back to the default flow instead of
      erroring — deliberate §3.3 degradation, documented in the schema
      description since round 7."""
    probe = f"/tmp/smoke-mcp-enum-{uuid.uuid4().hex[:8]}.txt"
    call_tool(proc, next_id, "sftp_write_file", {
        **connection, "path": probe, "content": "enum-probe",
    })
    baseline = call_tool(proc, next_id, "sftp_stat", {
        **connection, "path": probe,
    })["permissions"]
    try:
        # (mode value, error fragments that must appear)
        chmod_rejects = [
            ("999", ["mode must be an octal value up to 7777", "644"]),
            ("-384", ["mode must be an octal value up to 7777"]),
            ("rw-r--r--", ["mode must be an octal value up to 7777"]),
        ]
        for mode_value, expected in chmod_rejects:
            message = call_tool_error(proc, next_id, "sftp_chmod", {
                **connection, "path": probe, "mode": mode_value,
            })
            for fragment in expected:
                assert fragment in message, f"chmod mode={mode_value!r}: {message}"
        still = call_tool(proc, next_id, "sftp_stat", {
            **connection, "path": probe,
        })["permissions"]
        assert still == baseline, f"invalid chmod mutated bits: {baseline} → {still}"
        # Legal 0o-prefixed variant must still land (positive control).
        call_tool(proc, next_id, "sftp_chmod", {
            **connection, "path": probe, "mode": "0o640",
        })
        assert call_tool(proc, next_id, "sftp_stat", {
            **connection, "path": probe,
        })["permissions"] == "0640"
        print("sftp_chmod mode semantics ok (invalid rejected, no side effect)")
    finally:
        call_tool(proc, next_id, "sftp_remove", {**connection, "path": probe})

    # The multi_exec mode check runs before target resolution/dialing, so
    # an unsaved reference never leaks into these refusals.
    for mode_value in ("wrong", "PARALLEL", "Sequential"):
        message = call_tool_error(proc, next_id, "ssh_multi_exec", {
            **connection, "targets": ["no-such-conn"],
            "command": "echo probe", "mode": mode_value,
        })
        assert 'mode must be "parallel" or "sequential"' in message, message
        assert mode_value in message, message
    print("ssh_multi_exec mode enum ok (invalid + wrong-case list legal values)")

    # authFlowMode: uppercase normalization and silent default fallback are
    # the implemented behavior (deliberate §3.3 degradation, now documented
    # in the schema description). The test container's NOPASSWD sudo lets
    # every flow succeed, so success itself asserts "no enum error".
    for mode_value, label in (
        ("PASSWORD_ONLY", "uppercase"),
        ("password_only", "canonical"),
        ("garbage-flow", "fallback"),
    ):
        result = call_tool(proc, next_id, "ssh_exec_sudo", {
            **connection, "command": "whoami", "authFlowMode": mode_value,
        })
        assert result["exitCode"] == 0, f"authFlowMode {label}: {result}"
        assert result["output"].strip() == "root", f"authFlowMode {label}: {result}"
    print("ssh_exec_sudo authFlowMode ok (uppercase normalizes, garbage falls back)")


def live_pipelining_section(proc: subprocess.Popen, next_id: list, connection: dict) -> None:
    """Round 7: live pipelining — the offline round-5 robustness section
    proves request/response 1:1 on a synthetic stream; here two REAL tools
    of different ids are written back-to-back without waiting (sftp_pwd +
    ssh_metrics, both cheap on an established connection) and the responses
    must arrive as a 1:1 id match with each payload belonging to its own
    request (the concurrent face under a live SSH connection)."""
    pwd_id, metrics_id = next_id[0] + 1, next_id[0] + 2
    next_id[0] = metrics_id
    send(proc, {
        "jsonrpc": "2.0", "id": pwd_id, "method": "tools/call",
        "params": {"name": "sftp_pwd", "arguments": dict(connection)},
    })
    send(proc, {
        "jsonrpc": "2.0", "id": metrics_id, "method": "tools/call",
        "params": {"name": "ssh_metrics", "arguments": dict(connection)},
    })
    assert proc.stdout is not None
    first = json.loads(proc.stdout.readline())
    second = json.loads(proc.stdout.readline())
    assert {first.get("id"), second.get("id")} == {pwd_id, metrics_id}, (
        f"pipeline id mismatch: {first.get('id')}, {second.get('id')}"
    )
    by_id = {first["id"]: first, second["id"]: second}
    for message in (first, second):
        assert "error" not in message, message
        assert not message["result"].get("isError", False), message
    assert "home" in json.loads(by_id[pwd_id]["result"]["content"][0]["text"])
    metrics = json.loads(by_id[metrics_id]["result"]["content"][0]["text"])
    assert metrics.get("hostname") and metrics["cpu"]["cores"] > 0, metrics
    print("live pipelining ok (2 in-flight requests, 1:1 id ↔ payload match)")


def _spool(data: bytes) -> str:
    handle = tempfile.NamedTemporaryFile(prefix="smoke-mcp-src-", delete=False)
    handle.write(data)
    handle.close()
    return handle.name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="backend/target/release/dbx-plugin-ssh")
    parser.add_argument("--host", help="enable the live section against this SSH server")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--username", default="sshuser")
    parser.add_argument(
        "--password",
        default=os.environ.get("DBX_SSH_SMOKE_PASSWORD", ""),
        help="live-section password (or set DBX_SSH_SMOKE_PASSWORD)",
    )
    args = parser.parse_args()
    if args.host and not args.password:
        parser.error("--host requires --password or DBX_SSH_SMOKE_PASSWORD")

    proc = subprocess.Popen(
        [args.binary, "--mcp"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )
    try:
        send(proc, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "smoke", "version": "0"},
            },
        })
        init = recv(proc, 1)["result"]
        assert init["protocolVersion"] == "2024-11-05", init
        print(f"initialize ok: {init['serverInfo']['name']} {init['serverInfo']['version']}")

        send(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        tools = recv(proc, 2)["result"]["tools"]
        names = [tool["name"] for tool in tools]
        missing = [name for name in EXPECTED_TOOLS if name not in names]
        assert not missing, f"missing tools: {missing}"
        assert all(tool["inputSchema"].get("type") == "object" for tool in tools), "bad schemas"

        # MCP tool annotations: every tool carries the four advisory hints
        # plus a title; the confirm-gated exec family must advertise
        # destructive=true and the read-only family readOnly=true.
        HINTS = ("readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")
        by_name = {tool["name"]: tool for tool in tools}
        for name, tool in by_name.items():
            annotations = tool.get("annotations")
            assert isinstance(annotations, dict), f"{name} lacks annotations"
            for hint in HINTS:
                assert isinstance(annotations.get(hint), bool), f"{name} lacks boolean {hint}"
            assert isinstance(annotations.get("title"), str) and annotations["title"], \
                f"{name} lacks title"
        for destructive_tool in ("ssh_exec", "ssh_exec_sudo", "ssh_multi_exec", "sftp_remove",
                                 "ssh_run_bg", "sftp_write_file", "ssh_remove_known_host"):
            assert by_name[destructive_tool]["annotations"]["destructiveHint"] is True, \
                f"{destructive_tool} must advertise destructiveHint"
        for read_only_tool in ("ssh_list_connections", "ssh_list_known_hosts", "ssh_metrics",
                               "ssh_alert_triage", "sftp_list_dir", "sftp_stat", "sftp_exists",
                               "sftp_pwd", "sftp_read_file", "sftp_disk_usage"):
            annotations = by_name[read_only_tool]["annotations"]
            assert annotations["readOnlyHint"] is True and annotations["destructiveHint"] is False, \
                f"{read_only_tool} must advertise readOnlyHint"
        assert by_name["ssh_alert_triage"]["annotations"]["openWorldHint"] is False, \
            "ssh_alert_triage runs fully offline"
        print("annotations ok: all tools carry hints + title")
        print(f"tools/list ok: {len(names)} tools")

        # A connection-bound tool without credentials must be rejected before
        # any network I/O — and jump-host validation must not be masked by it.
        send(proc, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "host": "203.0.113.1", "username": "u", "command": "true",
            }},
        })
        error = recv(proc, 3)["error"]["message"]
        assert "password" in error, f"unexpected error: {error}"
        print("parameter validation ok")

        # ssh_metrics sections projection: an unknown section name must be
        # rejected BEFORE any dialing (no credentials in the call at all).
        send(proc, {
            "jsonrpc": "2.0", "id": 31, "method": "tools/call",
            "params": {"name": "ssh_metrics", "arguments": {
                "host": "203.0.113.1", "username": "u", "sections": ["memry"],
            }},
        })
        error = recv(proc, 31)["error"]["message"]
        assert "Unknown section: 'memry'" in error and "topMemory" in error, f"unexpected error: {error}"
        send(proc, {
            "jsonrpc": "2.0", "id": 32, "method": "tools/call",
            "params": {"name": "ssh_metrics", "arguments": {
                "host": "203.0.113.1", "username": "u", "sections": [],
            }},
        })
        error = recv(proc, 32)["error"]["message"]
        assert "at least one section" in error, f"unexpected error: {error}"
        print("metrics sections pre-dial validation ok")

        # A connection-free tool round-trips through the real sidecar path.
        send(proc, {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "ssh_list_known_hosts", "arguments": {}},
        })
        result = recv(proc, 4)["result"]
        assert not result.get("isError", False), f"tool failed: {result}"
        parsed = json.loads(result["content"][0]["text"])
        assert isinstance(parsed["knownHosts"], list)
        print("tools/call round-trip ok")

        # Alert triage (IMPL_PLAN_SSH_APPROVAL_AUDIT_ALERT §2.4): offline,
        # connection-free — normalize + classify + whitelisted-only playbook.
        send(proc, {
            "jsonrpc": "2.0", "id": 95, "method": "tools/call",
            "params": {"name": "ssh_alert_triage", "arguments": {
                "payload": json.dumps({
                    "alertId": "smoke-1", "title": "CPU 使用率过高",
                    "severity": "critical", "source": "prometheus",
                    "message": "node-1 cpu_usage above 0.9",
                }),
            }},
        })
        result = recv(proc, 95)["result"]
        assert not result.get("isError", False), f"triage failed: {result}"
        triage = json.loads(result["content"][0]["text"])
        assert triage["normalized"]["alertId"] == "smoke-1", triage
        assert triage["category"] == "cpu", triage
        assert triage["suggestions"], triage
        assert all("sudo" not in item["command"] for item in triage["suggestions"]), triage
        assert all(item["purposeKey"] for item in triage["suggestions"]), triage

        # Intent recognition across categories: the intent surface must
        # classify cpu / memory / disk plus network / oom / service /
        # generic and bilingual mixed phrasing (bilingual keyword scoring),
        # each suggestion staying whitelist-safe.
        for intent_title, expected_category in (
            ("memory usage above 90 percent / 内存占用过高", "memory"),
            ("磁盘剩余空间不足", "disk"),
            ("network eth0 packet loss 10%, 网卡丢包", "network"),
            ("Out of memory: oom-kill killed process 4321", "oom"),
            ("systemd unit nginx.service restart failed", "service"),
            ("backup job completed without errors at 03:00", "generic"),
            ("CPU loadavg 飙升, 处理器过热", "cpu"),
        ):
            send(proc, {
                "jsonrpc": "2.0", "id": 96, "method": "tools/call",
                "params": {"name": "ssh_alert_triage", "arguments": {
                    "payload": json.dumps({
                        "alertId": f"smoke-{expected_category}",
                        "title": intent_title,
                        "severity": "warning", "source": "prometheus",
                        "message": intent_title,
                    }),
                }},
            })
            result = recv(proc, 96)["result"]
            assert not result.get("isError", False), f"triage failed: {result}"
            intent = json.loads(result["content"][0]["text"])
            assert intent["category"] == expected_category, intent
            assert intent["suggestions"], intent
        print("ssh_alert_triage intent recognition ok (cpu/memory/disk/network/oom/service/generic)")
        print("ssh_alert_triage offline round-trip ok")

        # Global Quick Sudo profiles: save/list/delete round-trip with a
        # runtime-assembled test secret; responses must never echo it.
        secret = f"smoke-{uuid.uuid4().hex}"
        profile_name = f"smoke-{uuid.uuid4().hex[:8]}"
        send(proc, {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "ssh_quick_sudo_profiles_save", "arguments": {
                "name": profile_name,
                "sudoPassword": secret,
                "totpSecret": "JBSWY3DPEHPK3PXP",
                "authFlowMode": "password_plus_otp",
                "sudoUsePty": True,
            }},
        })
        saved = recv(proc, 5)["result"]
        assert not saved.get("isError", False), f"save failed: {saved}"
        saved_profile = json.loads(saved["content"][0]["text"])
        profile_id = saved_profile["profile"]["id"]
        assert saved_profile["created"] is True, saved_profile
        assert saved_profile["profile"]["sudoPasswordSet"] is True, saved_profile
        assert secret not in saved["content"][0]["text"], "save echoed the secret"

        send(proc, {
            "jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": {"name": "ssh_quick_sudo_profiles_list", "arguments": {}},
        })
        listed = recv(proc, 6)["result"]
        listed_text = listed["content"][0]["text"]
        assert secret not in listed_text, "list echoed the secret"
        listed_profiles = json.loads(listed_text)["profiles"]
        assert any(profile.get("sudoPasswordSet") is True for profile in listed_profiles), listed_text

        # ssh_exec_sudo schema exposes quickSudoProfile; an unknown reference
        # must fail fast with a clear error (before any connection attempt).
        schema_properties = next(
            tool["inputSchema"]["properties"] for tool in tools if tool["name"] == "ssh_exec_sudo"
        )
        assert "quickSudoProfile" in schema_properties, "ssh_exec_sudo lacks quickSudoProfile"
        send(proc, {
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "ssh_exec_sudo", "arguments": {
                "host": "203.0.113.1", "username": "u", "command": "true",
                "quickSudoProfile": "no-such-profile",
            }},
        })
        missing_profile = recv(proc, 7)["error"]["message"]
        assert "not found" in missing_profile, f"unexpected error: {missing_profile}"

        send(proc, {
            "jsonrpc": "2.0", "id": 8, "method": "tools/call",
            "params": {"name": "ssh_quick_sudo_profiles_delete", "arguments": {"id": profile_id}},
        })
        removed = recv(proc, 8)["result"]
        assert json.loads(removed["content"][0]["text"])["removed"] is True, removed
        print("quick sudo profiles round-trip ok")

        # Agent terminal routing is embedded-bridge only: stdio mode must
        # refuse runInTerminal before any connection I/O (ids skip into the
        # 20s to stay clear of the transfer section below).
        exec_schema = next(
            tool["inputSchema"]["properties"] for tool in tools if tool["name"] == "ssh_exec"
        )
        assert "runInTerminal" in exec_schema, "ssh_exec lacks runInTerminal"
        # Strict MCP hosts drop undeclared arguments, so connectionId must be
        # part of the advertised schema or runInTerminal is unreachable there.
        assert "connectionId" in exec_schema, "ssh_exec lacks connectionId"

        # Connection addressing usability: EVERY connection-bound tool must
        # advertise connectionName plus the selector anyOf (id | name |
        # endpoint), or strict hosts refuse the call before the sidecar can
        # resolve the saved connection (the ssh_test_connection gap found
        # during the local_ubuntu MCP coverage pass).
        for tool_name in CONNECTION_BOUND_TOOLS:
            tool_input = next(tool["inputSchema"] for tool in tools if tool["name"] == tool_name)
            assert "connectionName" in tool_input.get("properties", {}), (
                f"{tool_name} lacks connectionName"
            )
            assert any(
                "connectionName" in variant.get("required", [])
                for variant in tool_input.get("anyOf") or []
            ), f"{tool_name} inputSchema lacks the selector anyOf"
        print(f"connection selector schema ok ({len(CONNECTION_BOUND_TOOLS)} tools)")

        # Connection search: ssh_list_connections answers even without the
        # DBX app (degraded source + note instead of a hard failure).
        send(proc, {
            "jsonrpc": "2.0", "id": 21, "method": "tools/call",
            "params": {"name": "ssh_list_connections", "arguments": {}},
        })
        listed_result = recv(proc, 21)["result"]
        assert not listed_result.get("isError", False), f"list failed: {listed_result}"
        listed_connections = json.loads(listed_result["content"][0]["text"])
        assert isinstance(listed_connections["connections"], list), listed_connections
        assert listed_connections.get("source"), listed_connections
        print(f"ssh_list_connections ok (source={listed_connections['source']})")

        # A saved-connection reference the session cannot resolve (no app,
        # no registry) must fail with the full self-heal path, not a bare
        # "missing host" — the caller needs the recovery order spelled out.
        send(proc, {
            "jsonrpc": "2.0", "id": 22, "method": "tools/call",
            "params": {"name": "ssh_test_connection", "arguments": {
                "connectionName": "no-such-connection",
            }},
        })
        unresolved = recv(proc, 22)["error"]["message"]
        assert "ssh_list_connections" in unresolved and "password" in unresolved, unresolved
        print("saved-ref guidance error ok")

        send(proc, {
            "jsonrpc": "2.0", "id": 20, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "command": "true", "runInTerminal": True,
            }},
        })
        bridge_error = recv(proc, 20)["error"]["message"]
        assert "runInTerminal needs a saved DBX connection" in bridge_error, \
            f"unexpected error: {bridge_error}"
        print("runInTerminal stdio refusal ok")

        # Transfer tools validate their local side before dialing, so a bad
        # local path must fail fast (no SSH server involved) with a clear
        # error naming the offending parameter.
        send(proc, {
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": {"name": "sftp_upload", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "localPath": "/no/such/smoke-file.bin", "remotePath": "/tmp/x",
            }},
        })
        upload_error = recv(proc, 9)["error"]["message"]
        assert "Cannot read local file" in upload_error, f"unexpected error: {upload_error}"
        # A local target whose parent is an existing *file* cannot have its
        # parent directories created — a deterministic, dial-free failure.
        parent_as_file = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
        parent_as_file.close()
        send(proc, {
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": {"name": "sftp_download", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "remotePath": "/tmp/x",
                "localPath": parent_as_file.name + "/smoke.bin",
            }},
        })
        download_error = recv(proc, 10)["error"]["message"]
        assert "Cannot create local directory" in download_error, (
            f"unexpected error: {download_error}"
        )
        print("transfer tool local validation ok")

        # Production misoperation guards: destructive commands demand an
        # explicit confirmDestructive flag; the refusal fires before
        # credential validation, and the flag lets the call proceed.
        send(proc, {
            "jsonrpc": "2.0", "id": 11, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "command": "mkfs.ext4 /dev/sda1",
            }},
        })
        refused = recv(proc, 11)["error"]["message"]
        assert "confirmDestructive" in refused and "password" not in refused, refused
        send(proc, {
            "jsonrpc": "2.0", "id": 12, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "command": "mkfs.ext4 /dev/sda1",
                "confirmDestructive": True,
            }},
        })
        gated_through = recv(proc, 12)["error"]["message"]
        assert "password" in gated_through, gated_through
        print("destructive-command gate ok")

        # LLM input tolerance (2026-09-13 MCP coverage audit): numeric and
        # boolean values sent as strings must parse through the full
        # validation chain, malformed ports must fail fast with a range
        # error (never silently dial the default 22), unknown tool names
        # suggest the registered spelling, and multi_exec demands an array.
        tolerance_cases = [
            # (id, tool, arguments, expected substrings)
            (40, "ssh_exec", {"port": "2222"}, ["password"]),
            (41, "ssh_exec", {"timeoutSecs": "30"}, ["password"]),
            (42, "ssh_exec", {"port": 0}, ["port must be between 1 and 65535"]),
            (43, "ssh_exec", {"port": "abc"}, ["port must be an integer"]),
            (44, "sftp-listdir", {}, ["Unknown tool", "Did you mean 'sftp_list_dir'"]),
            (45, "ssh_multi_exec", {"targets": "conn-1"}, ["targets must be an array"]),
        ]
        for case_id, tool_name, extra, expected in tolerance_cases:
            arguments = {
                "host": "203.0.113.1", "username": "u", "command": "true", **extra,
            }
            send(proc, {
                "jsonrpc": "2.0", "id": case_id, "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments},
            })
            message = recv(proc, case_id)["error"]["message"]
            for fragment in expected:
                assert fragment in message, f"{tool_name} {extra}: {message}"
        # confirmDestructive as a string passes the destructive gate.
        send(proc, {
            "jsonrpc": "2.0", "id": 46, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "host": "203.0.113.1", "username": "u",
                "command": "mkfs.ext4 /dev/sda1", "confirmDestructive": "true",
            }},
        })
        string_flag = recv(proc, 46)["error"]["message"]
        assert "password" in string_flag, string_flag
        print("llm input tolerance ok (string numbers/booleans, port range, unknown tool)")

        # Missing-required enumeration (round 6): EVERY absent required
        # parameter is named in ONE "Missing required parameters: …" error so
        # an LLM fixes all gaps in a single turn; a single-gap call names
        # only the missing one.
        enumeration_cases = [
            # (id, tool, arguments, params the error must name)
            (52, "ssh_multi_exec", {}, ["targets", "command"]),
            (53, "sftp_upload", {}, ["localPath", "remotePath"]),
            (54, "sftp_download", {}, ["remotePath", "localPath"]),
            (55, "ssh_multi_exec", {"targets": ["conn-1"]}, ["command"]),
            (56, "ssh_multi_exec", {"command": "uptime"}, ["targets"]),
        ]
        for case_id, tool_name, extra, expected_params in enumeration_cases:
            send(proc, {
                "jsonrpc": "2.0", "id": case_id, "method": "tools/call",
                "params": {"name": tool_name, "arguments": extra},
            })
            message = recv(proc, case_id)["error"]["message"]
            assert "Missing required parameters" in message, (
                f"{tool_name} {extra}: {message}"
            )
            for param in expected_params:
                assert param in message, f"{tool_name} {extra}: {message}"
        print("missing-required enumeration ok (both gaps named in one error)")

        if args.host:
            live_round_trip(proc, args, id_base=100)
        else:
            print("live section skipped (no --host)")
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    read_only_server_section(args)
    bridge_unreachable_section(args)
    stub_app_bridge_section(args)
    dead_bridge_section(args)
    agentic_workflow_section(args)
    permission_env_section(args)
    protocol_robustness_section(args)
    stdio_line_limit_section(args)
    print("MCP smoke: all green")


def _spawn_mcp(args: argparse.Namespace, extra_env: dict) -> subprocess.Popen:
    env = dict(os.environ, **extra_env)
    return subprocess.Popen(
        [args.binary, "--mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
    )


def _handshake(proc: subprocess.Popen) -> None:
    send(proc, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {}},
    })
    recv(proc, 1)


def _write_port_file(app_data: str, port: int) -> None:
    with open(os.path.join(app_data, "mcp-bridge-port"), "w") as handle:
        handle.write(str(port))


def stub_app_bridge_section(args: argparse.Namespace) -> None:
    """App-bridge happy path against a STUB DBX app: an in-process HTTP
    server publishes mcp-bridge-port and answers the two bridge routes.
    Proves the L1 forward contract end to end without a real app:
    - ssh_list_connections merges the bridge list (source dbx-app-bridge);
    - ssh_exec addressed by connectionName resolves through the bridge
      list and forwards to /call-plugin-tool under the resolved id, and
      the app's MCP envelope passes through verbatim;
    - sftp_stat addressed by connectionId forwards the same way."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    forwarded_calls: list = []

    class StubApp(BaseHTTPRequestHandler):
        def _reply(self, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/list-plugin-connections":
                self._reply({"connections": [{
                    "id": "conn-stub-1", "name": "prod-web-01",
                    "host": "web.example.test", "port": 22,
                    "username": "deploy", "authentication": "password",
                    "readOnly": False,
                }]})
            elif self.path == "/call-plugin-tool":
                forwarded_calls.append(body)
                self._reply({"content": [{"type": "text", "text": json.dumps({
                    "output": "via-stub-bridge", "exitCode": 0,
                })}], "isError": False})
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *log_args) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), StubApp)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        app_data = tempfile.mkdtemp(prefix="smoke-mcp-stubapp-")
        _write_port_file(app_data, server.server_address[1])
        proc = _spawn_mcp(args, {
            "DBX_APP_DATA_DIR": app_data, "DBX_APP_LAUNCH_CMD": ":",
        })
        next_id = [600]
        try:
            _handshake(proc)

            listed = call_tool(proc, next_id, "ssh_list_connections", {})
            assert listed["source"] == "dbx-app-bridge", listed
            assert any(
                row.get("id") == "conn-stub-1" for row in listed["connections"]
            ), listed

            # connectionName → resolved through the bridge list → forwarded.
            output = call_tool(proc, next_id, "ssh_exec", {
                "connectionName": "prod-web-01", "command": "uptime",
            })
            assert output.get("output") == "via-stub-bridge", output
            exec_forwards = [call for call in forwarded_calls if call["tool"] == "ssh_exec"]
            assert exec_forwards, "ssh_exec never reached the bridge"
            forward = exec_forwards[-1]
            assert forward["plugin_id"] == "io.dbx.ssh", forward
            assert forward["connection_id"] == "conn-stub-1", forward
            assert forward["arguments"]["command"] == "uptime", forward

            # connectionId forwards as-is (unregistered locally).
            output = call_tool(proc, next_id, "sftp_stat", {
                "connectionId": "conn-stub-1", "path": "/tmp",
            })
            assert output.get("output") == "via-stub-bridge", output
            assert any(call["tool"] == "sftp_stat" for call in forwarded_calls)
        finally:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=10)
    finally:
        server.shutdown()
        server.server_close()
    print("stub app bridge forward ok (list merge + exec/sftp forward + envelope pass-through)")


def dead_bridge_section(args: argparse.Namespace) -> None:
    """Bridge port published but the app is a lying corpse (a listener that
    accepts and immediately closes): every forward attempt must fail FAST
    (no 30s wake budget hang) and fall through to the fail-closed self-heal
    error, while ssh_list_connections degrades to the session registry."""
    dead = socket.socket()
    dead.bind(("127.0.0.1", 0))
    dead.listen(8)

    def accept_and_close() -> None:
        while True:
            try:
                connection, _ = dead.accept()
            except OSError:
                return
            connection.close()

    threading.Thread(target=accept_and_close, daemon=True).start()
    app_data = tempfile.mkdtemp(prefix="smoke-mcp-deadapp-")
    _write_port_file(app_data, dead.getsockname()[1])
    proc = _spawn_mcp(args, {"DBX_APP_DATA_DIR": app_data, "DBX_APP_LAUNCH_CMD": ":"})
    next_id = [700]
    try:
        _handshake(proc)
        started = time.monotonic()
        for tool, tool_args in (
            ("ssh_exec", {"connectionId": "ghost-1", "command": "echo hi"}),
            ("sftp_stat", {"connectionId": "ghost-1", "path": "/tmp"}),
            ("ssh_task_status", {
                "connectionId": "ghost-1", "logPath": "/tmp/.dbx-ssh-tasks/x.log",
            }),
        ):
            error = call_tool_error(proc, next_id, tool, tool_args)
            for fragment in (
                "not registered with this plugin session",
                "ssh_list_connections",
                "inline credentials",
            ):
                assert fragment in error, f"{tool}: {error}"
        elapsed = time.monotonic() - started
        assert elapsed < 10, f"dead-bridge fallthrough took {elapsed:.1f}s (wake budget leaked)"

        listed = call_tool(proc, next_id, "ssh_list_connections", {})
        assert listed["source"] == "session-registry", listed
        assert listed.get("note"), listed
    finally:
        dead.close()
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    print("dead app bridge fail-closed ok (fast fallthrough + self-heal + degraded list)")


def agentic_workflow_section(args: argparse.Namespace) -> None:
    """A realistic LLM multi-step loop against a sidecar with no DBX app:
    discover tools → list connections (degraded) → address a call → read
    the error → self-correct exactly as the guidance prescribes → finish
    with local verification tools. Every failure must literally enable the
    next step (self-correction closure)."""
    app_data = tempfile.mkdtemp(prefix="smoke-mcp-agent-")
    proc = _spawn_mcp(args, {
        "DBX_APP_DATA_DIR": app_data, "DBX_APP_LAUNCH_CMD": ":",
    })
    next_id = [800]
    try:
        # Step 1: initialize — the agent learns the server identity.
        send(proc, {
            "jsonrpc": "2.0", "id": next_id[0], "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "agent-loop", "version": "0"}},
        })
        init = recv(proc, next_id[0])["result"]
        assert init["serverInfo"]["name"] == "io.dbx.ssh", init

        # Step 2: tools/list — the agent learns tool names and the selector
        # schema (connectionName is advertised, so the next step's choice of
        # selector comes from the schema itself).
        next_id[0] += 1
        send(proc, {"jsonrpc": "2.0", "id": next_id[0], "method": "tools/list"})
        tools = recv(proc, next_id[0])["result"]["tools"]
        names = {tool["name"] for tool in tools}
        assert {"ssh_exec", "ssh_list_connections", "ssh_alert_triage",
                "ssh_list_known_hosts"} <= names, names
        exec_schema = next(t["inputSchema"] for t in tools if t["name"] == "ssh_exec")
        assert "connectionName" in exec_schema["properties"], exec_schema

        # Step 3: discovery — no saved connections; the note tells the agent
        # what to do next (start the app or go inline).
        discovery = call_tool(proc, next_id, "ssh_list_connections", {})
        assert discovery["source"] == "session-registry", discovery
        assert discovery["connections"] == [], discovery
        assert "DBX app" in discovery["note"], discovery

        # Step 4: address by the (learned) connectionName selector — fails,
        # and the error must name both recovery routes the next steps use.
        step4 = call_tool_error(proc, next_id, "ssh_exec", {
            "connectionName": "prod-web-01", "command": "uptime",
        })
        assert "ssh_list_connections" in step4, step4
        assert "inline credentials" in step4, step4

        # Step 5: follow the guidance — switch to an inline endpoint. The
        # missing credential is now the ONLY blocker, and the error names it.
        step5 = call_tool_error(proc, next_id, "ssh_exec", {
            "host": "web.example.test", "username": "deploy", "command": "uptime",
        })
        assert "password" in step5.lower(), step5

        # Step 6: local verification tools close the loop with successes —
        # known_hosts round-trips, and the triage playbook returns
        # whitelist-safe commands the agent could execute via ssh_exec next.
        known = call_tool(proc, next_id, "ssh_list_known_hosts", {})
        assert isinstance(known["knownHosts"], list), known
        triage = call_tool(proc, next_id, "ssh_alert_triage", {
            "payload": json.dumps({
                "alertId": "agent-1", "severity": "critical",
                "message": "network eth0 packet loss 10%, 网卡丢包",
            }),
        })
        assert triage["category"] == "network", triage
        assert triage["suggestions"], triage
        assert all(
            "sudo" not in item["command"] and ">" not in item["command"]
            for item in triage["suggestions"]
        ), triage
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    print("agentic workflow loop ok (discover → address → self-correct ×2 → local verify)")


def permission_env_section(args: argparse.Namespace) -> None:
    """§1.3 permission档 via process env (the stdio operator lever; the
    mcp/settings RPC surface belongs to the embedded bridge). Both gates
    must fail closed BEFORE any dialing:
    - DBX_SSH_MCP_PERMISSION_MODE=confirm: exec tools need a human
      approval, but a stdio session has no approval channel — immediate
      refusal, never the 120s hang;
    - DBX_SSH_MCP_CONNECTION_SCOPE: inline-credential calls are refused
      outright (fail closed; endpoints have no registry identity)."""
    def spawn(extra_env):
        env = dict(os.environ, **extra_env)
        return subprocess.Popen(
            [args.binary, "--mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
        )

    def expect_error(proc, next_id, name, arguments):
        next_id[0] += 1
        send(proc, {
            "jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        return recv(proc, next_id[0])["error"]["message"]

    connection = {"host": "203.0.113.1", "username": "u"}

    # Scope gate first (fail-closed before everything else for inline calls).
    proc = spawn({"DBX_SSH_MCP_CONNECTION_SCOPE": "prod-db, backup-host"})
    next_id = [70]
    try:
        scope = expect_error(proc, next_id, "ssh_exec",
                             {**connection, "command": "echo scoped"})
        assert "connectionScope" in scope, scope
        # The scope gate only covers connection-class tools:
        # ssh_list_connections stays answerable under a pinned scope (it is
        # itself scope-filtered, but never refused).
        next_id[0] += 1
        send(proc, {"jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
                    "params": {"name": "ssh_list_connections", "arguments": {}}})
        listing = recv(proc, next_id[0])["result"]
        assert listing.get("isError") is not True, listing
        assert json.loads(listing["content"][0]["text"])["connections"] == [], listing
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)

    # Confirm gate: a stdio session has no approval channel, so a gated tool
    # is refused immediately (never the 120s hang).
    proc = spawn({"DBX_SSH_MCP_PERMISSION_MODE": "confirm"})
    next_id = [80]
    try:
        confirm = expect_error(proc, next_id, "ssh_exec",
                               {**connection, "command": "echo gated"})
        assert "execPermissionMode=confirm" in confirm, confirm
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    print("permission env gates ok (confirm fail-closed + scope fail-closed)")


def _readline_timeout(proc: subprocess.Popen, timeout: float = 20.0) -> bytes:
    """readline with a watchdog: a hung or crashed sidecar fails the smoke
    instead of blocking the whole run. POSIX watches the pipe fd with
    select; on Windows select() only accepts sockets, so the read runs in
    a daemon thread and the deadline is enforced on the queue wait."""
    fd = proc.stdout.fileno()
    deadline = time.monotonic() + timeout

    if os.name != "nt":
        import select

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"sidecar produced no line within {timeout}s (hung?)")
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                continue
            line = proc.stdout.readline()
            if not line:
                raise AssertionError("sidecar closed the stream (crashed?)")
            return line

    import queue

    lines: "queue.Queue[bytes]" = queue.Queue()

    def _reader() -> None:
        try:
            lines.put(proc.stdout.readline())
        except (OSError, ValueError):
            lines.put(b"")

    threading.Thread(target=_reader, daemon=True).start()
    remaining = deadline - time.monotonic()
    try:
        line = lines.get(timeout=max(remaining, 0.0))
    except queue.Empty:
        raise AssertionError(f"sidecar produced no line within {timeout}s (hung?)") from None
    if not line:
        raise AssertionError("sidecar closed the stream (crashed?)")
    return line


def _recv_id(proc: subprocess.Popen, want_id, timeout: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"no response with id {want_id} within {timeout}s")
        message = json.loads(_readline_timeout(proc, remaining))
        if message.get("id") == want_id:
            return message


def protocol_robustness_section(args: argparse.Namespace) -> None:
    """Hostile stdio transport inputs (reliability round 5): the sidecar
    must neither crash nor wedge on adversarial bytes. Every case below
    ends with a legal request proving the server is still healthy:
     1. invalid JSON → -32700, session survives;
     2. invalid UTF-8 byte stream → -32700 (this used to kill the whole
        sidecar with an InvalidData I/O error);
     3. a notification (no id) → strictly NO response — the very next line
        on the wire is the answer to the request sent after it;
     4. malformed envelopes (jsonrpc ≠ 2.0 / non-string method / object,
        null, bool ids) → structured -32600;
     5. one 8 MiB line → answered gracefully within budget (no panic, no
        hang) whatever the tool-level verdict is;
     6. pipelining: requests written back-to-back → responses map 1:1 by id;
     7. blank / whitespace / CRLF lines are tolerated (no death loop)."""
    app_data = tempfile.mkdtemp(prefix="smoke-mcp-robust-")
    proc = _spawn_mcp(args, {"DBX_APP_DATA_DIR": app_data, "DBX_APP_LAUNCH_CMD": ":"})
    next_id = [1200]

    def raw(payload: bytes) -> None:
        assert proc.stdin is not None
        proc.stdin.write(payload)
        proc.stdin.flush()

    def expect_error(code: int, timeout: float = 20.0) -> dict:
        message = json.loads(_readline_timeout(proc, timeout))
        error = message.get("error") or {}
        assert error.get("code") == code, f"expected {code}, got {message}"
        return message

    def ping_health() -> None:
        next_id[0] += 1
        send(proc, {"jsonrpc": "2.0", "id": next_id[0], "method": "ping"})
        response = _recv_id(proc, next_id[0])
        assert response.get("result") == {}, response

    try:
        _handshake(proc)

        # 1. invalid JSON.
        raw(b'{"jsonrpc": "2.0", "id": 1, "method": "ping",,}\n')
        expect_error(-32700)
        ping_health()

        # 2. invalid UTF-8 byte stream.
        raw(b'\xff\xfe{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
        expect_error(-32700)
        ping_health()

        # 3. notification: strictly no response.
        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        next_id[0] += 1
        ping_id = next_id[0]
        send(proc, {"jsonrpc": "2.0", "id": ping_id, "method": "ping"})
        message = json.loads(_readline_timeout(proc))
        assert message.get("id") == ping_id and "error" not in message, (
            f"expected exactly the ping reply next, got {message}"
        )

        # 4. malformed envelopes → structured -32600 (never a crash).
        for payload in (
            {"jsonrpc": "1.0", "id": 11, "method": "ping"},
            {"id": 12, "method": "ping"},
            {"jsonrpc": "2.0", "id": 13, "method": 42},
            {"jsonrpc": "2.0", "id": 14, "method": ""},
            {"jsonrpc": "2.0", "id": {"n": 1}, "method": "ping"},
            {"jsonrpc": "2.0", "id": True, "method": "ping"},
            {"jsonrpc": "2.0", "id": None, "method": "ping"},
            {"jsonrpc": "2.0", "id": 15},
        ):
            send(proc, payload)
            message = expect_error(-32600)
            assert message.get("id") is None or isinstance(
                message.get("id"), (str, int)
            ), message
        ping_health()

        # 5. a single 8 MiB line: parsed and answered within budget.
        giant = "x" * (8 * 1024 * 1024)
        next_id[0] += 1
        send(proc, {
            "jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
            "params": {"name": "ssh_alert_triage", "arguments": {"payload": giant}},
        })
        started = time.monotonic()
        # 预算 120s：8 MiB 行的解析回包在慢 CI runner（darwin-x64 实测）可能
        # 超过原 60s 预算——该用例验证的是"不 panic 不 hang"而非耗时上限，
        # 预算放宽只影响最慢平台的通过率，不影响功能覆盖。
        message = _recv_id(proc, next_id[0], timeout=120)
        elapsed = time.monotonic() - started
        assert elapsed < 120, f"8 MiB line took {elapsed:.1f}s"
        assert "error" not in message or message["error"].get("code") in (-32000,), message

        # 6. pipelining: 4 requests without waiting; responses map 1:1 by id.
        pipeline = [
            {"jsonrpc": "2.0", "id": 2001, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2002, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 2003, "method": "tools/call",
             "params": {"name": "ssh_list_known_hosts", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 2004, "method": "tools/call",
             "params": {"name": "ssh_alert_triage", "arguments": {"payload": json.dumps({
                 "alertId": "pipe-1", "title": "CPU 负载过高",
             })}}},
        ]
        for request in pipeline:
            raw((json.dumps(request) + "\n").encode())
        seen = set()
        for _ in pipeline:
            message = json.loads(_readline_timeout(proc, timeout=30))
            assert "error" not in message, f"pipelined request failed: {message}"
            assert message.get("id") not in seen, f"duplicate id: {message}"
            seen.add(message.get("id"))
        assert seen == {2001, 2002, 2003, 2004}, seen
        ping_health()

        # 7. blank / whitespace / CRLF-only lines are swallowed silently;
        #    a CRLF-terminated request answers normally.
        raw(b"\n")
        raw(b"   \t\r\n")
        raw(b"\r\n")
        raw(b'{"jsonrpc": "2.0", "id": 3001, "method": "ping"}\r\n')
        message = json.loads(_readline_timeout(proc))
        assert message.get("id") == 3001, message
        ping_health()
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    print(
        "protocol robustness ok (bad json/utf8, silent notifications, "
        "envelope -32600s, 8 MiB line, pipelining 1:1, blank/CRLF lines)"
    )


def stdio_line_limit_section(args: argparse.Namespace) -> None:
    """Single-line ceiling (round 6 family contract with files/ldap/kafka):
    a sidecar started with a low DBX_SSH_MCP_STDIO_MAX_LINE answers one
    -32700 for an over-limit line (naming the limit and the env var) and the
    session keeps serving — the over-limit bytes were consumed through their
    newline, so the very next request parses normally."""
    app_data = tempfile.mkdtemp(prefix="smoke-mcp-linlim-")
    env = dict(
        os.environ,
        DBX_APP_DATA_DIR=app_data,
        DBX_SSH_MCP_STDIO_MAX_LINE="512",
    )
    proc = _spawn_mcp(args, env)
    next_id = [900]
    try:
        _handshake(proc)

        # A legal JSON request padded past the 512-byte ceiling: refused
        # BEFORE parsing, still a structured -32700.
        send(proc, {
            "jsonrpc": "2.0", "id": 901, "method": "ping",
            "params": {"pad": "x" * 2048},
        })
        message = json.loads(_readline_timeout(proc))
        error = message.get("error") or {}
        assert error.get("code") == -32700, message
        assert "512-byte limit" in error.get("message", ""), message
        assert "DBX_SSH_MCP_STDIO_MAX_LINE" in error.get("message", ""), message

        # The over-limit line was consumed whole: the next request is
        # answered normally (no stale half-line, no wedge).
        ping_id = 902
        send(proc, {"jsonrpc": "2.0", "id": ping_id, "method": "ping"})
        response = _recv_id(proc, ping_id)
        assert response.get("result") == {}, response

        # And a real tool call still round-trips on the limited sidecar.
        listed = call_tool(proc, next_id, "ssh_list_known_hosts", {})
        assert isinstance(listed["knownHosts"], list), listed
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)
    print("stdio line limit ok (over-limit -32700 + session healthy)")


def read_only_server_section(args: argparse.Namespace) -> None:
    """Second sidecar started with DBX_SSH_MCP_READ_ONLY=1: the whole
    process must pass the read-only gates (operator kill switch for
    production access)."""
    env = dict(os.environ, DBX_SSH_MCP_READ_ONLY="1")
    proc = subprocess.Popen(
        [args.binary, "--mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
    )
    next_id = [50]

    def expect_error(command: str, name: str = "ssh_exec", arguments: dict | None = None):
        arguments = {"host": "203.0.113.1", "username": "u", "command": command, **(arguments or {})}
        next_id[0] += 1
        send(proc, {
            "jsonrpc": "2.0", "id": next_id[0], "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        })
        return recv(proc, next_id[0])["error"]["message"]

    try:
        # Write-class tools are rejected outright.
        write_refusal = expect_error("uptime", name="ssh_exec_sudo")
        assert "read-only" in write_refusal, write_refusal

        # ssh_exec keeps inspection commands: the gate passes and the call
        # proceeds to fail on the missing password (no gate complaint).
        inspection = expect_error("df -h")
        assert "password" in inspection, inspection

        # Unrecognized mutating commands are refused by the whitelist before
        # any dialing, destructive patterns are refused outright, and
        # confirmDestructive cannot override a read-only server.
        whitelist = expect_error("systemctl restart nginx")
        assert "not recognized" in whitelist, whitelist
        destructive = expect_error("rm -rf /etc")
        assert "Refused on read-only" in destructive, destructive
        override = expect_error("rm -rf /etc", arguments={"confirmDestructive": True})
        assert "Refused on read-only" in override, override

        # Whitelist-hardening: shape-readonly-but-mutating forms stay Unknown.
        for hardened in (
            "ip link set dev eth0 down",
            "ip route flush all",
            "git branch -D main",
            "git tag -d v1",
            "sort -o /etc/cron.d/x /tmp/in",
            "find / -fprint /tmp/keys",
            "dmesg -C",
            "history -c",
        ):
            message = expect_error(hardened)
            assert "not recognized" in message, f"{hardened}: {message}"
        # Listing shapes of the same verbs still pass the gate.
        for allowed in ("git branch -a", "git tag -l 'v*'", "git remote -v", "dmesg -T"):
            message = expect_error(allowed)
            assert "not recognized" not in message, f"{allowed}: {message}"

        # Sensitive-path denylist: credential paths are refused on read-only
        # connections, both through exec verbs and SFTP read tools.
        message = expect_error("cat /root/.ssh/id_rsa")
        assert "not recognized" in message, message
        message = expect_error("", name="sftp_read_file", arguments={"path": "/root/.ssh/id_rsa"})
        assert "sensitive" in message, message
        message = expect_error("", name="sftp_list_dir", arguments={"path": "/root/.ssh"})
        assert "sensitive" in message, message
        message = expect_error("", name="ssh_task_status", arguments={"logPath": "/root/.bash_history"})
        assert "sensitive" in message, message
        # Ordinary paths still pass the gate (they proceed to credential checks).
        message = expect_error("", name="sftp_read_file", arguments={"path": "/var/log/app.log"})
        assert "sensitive" not in message, message

        # Local-write hygiene: sftp_download refuses bootstrap/cron/systemd
        # targets on the operator machine regardless of the gate.
        message = expect_error(
            "df -h",
            name="sftp_download",
            arguments={"remotePath": "/tmp/p.sh", "localPath": "/home/u/.bashrc"},
        )
        assert "Refusing to write the local sensitive path" in message, message
        message = expect_error(
            "df -h",
            name="sftp_download",
            arguments={"remotePath": "/tmp/p.sh", "localPath": "/etc/cron.d/payload"},
        )
        assert "Refusing to write the local sensitive path" in message, message
        print("read-only server gate ok (DBX_SSH_MCP_READ_ONLY=1)")
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)


def bridge_unreachable_section(args: argparse.Namespace) -> None:
    """Third sidecar pointed at an empty app-data dir: stdio
    `ssh_exec{runInTerminal:true}` must go down the app-bridge ensure path
    (launch attempt is the no-op `:` command, so no UI pops up) and come back
    with the actionable "DBX app bridge" error — no SSH server, no network
    beyond the local port-file poll. The ensure poll runs the full app-start
    budget (30s) before the error, which is exactly the behavior under test.
    """
    app_data = tempfile.mkdtemp(prefix="smoke-mcp-appdata-")
    env = dict(os.environ, DBX_APP_DATA_DIR=app_data, DBX_APP_LAUNCH_CMD=":")
    proc = subprocess.Popen(
        [args.binary, "--mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
    )
    try:
        send(proc, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}},
        })
        recv(proc, 1)
        send(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "ssh_exec", "arguments": {
                "connectionId": "no-such-connection", "command": "true",
                "runInTerminal": True,
            }},
        })
        error = recv(proc, 2)["error"]["message"]
        assert "DBX app bridge" in error, f"unexpected error: {error}"
        print("app-bridge unreachable error ok (DBX app bridge …)")
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=10)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
